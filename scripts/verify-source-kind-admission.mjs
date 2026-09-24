/**
 * 会话源 kind 准入探针（开发工具，不进发布物；v2.7.1 引入）
 *
 * 为什么需要它（v2.7.1 的教训）：
 *   DSH 0.1.7 的会话格式 v4 **没有删掉任何符号**，只是在既有函数里加了一条硬拒绝——
 *   通用 `kind:'plugin'` 源包裹层退役，改要求 source.kind 是「生产者自己的名字」。
 *   因此 scripts/dsh-compat-diff.mjs 那种**符号存在性**比对（same/moved/gone）看不见它：
 *   `source()` / `assertV4RowAdmission` 两个版本都在，变的只是**语义**。
 *   这类漂移只能靠**行为探针**抓：把插件实际发出的 source 形态喂给真实安装的准入函数看结果。
 *
 * 校验什么：
 *   A. 插件当前发出的 kind 被准入（user/message 路径）
 *   B. 同上（agent/inbox/spliced.data.inserted —— 未落地 inbox 注入路径）
 *   C. 旧的 `kind:'plugin'` 被硬拒，且错误文案是 `producer-owned source kind`
 *   D. 同上（inbox spliced 路径）
 *   E. 形态契约：发出的 kind 必须正好是 `plugin:<插件名>`，
 *      与 v4 迁移对第三方插件的兜底同形 ⇒ 历史消息与新消息归到同一个 kind
 *      （窗口去重跨迁移边界才成立）
 *
 * 用法：
 *   npm run verify:source-kind
 *   node scripts/verify-source-kind-admission.mjs [--json] [--require] [--root <安装根>]
 *
 * 找不到本机 DSH 时默认 **SKIP 并 exit 0**（没人装了它就没得验，不该误报失败）；
 * 加 `--require` 可把「找不到」也当失败（放进 CI 或发布门禁时用）。
 * 校验失败一律 exit 1。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const requireInstalled = args.includes('--require')
const rootArgIdx = args.indexOf('--root')
const rootOverride = rootArgIdx >= 0 ? args[rootArgIdx + 1] : undefined

const SCOPE = '@deepseek-ai'
const PKG_DIR = 'dsh-session-format-v3-to-v4'
const TARGET_PKG = `${SCOPE}/${PKG_DIR}`
const REJECTION_TEXT = 'producer-owned source kind'

//#region 事实来源：插件实际发出的 kind（从 src/bridge.ts 读，勿硬编码）

function readEmittedKind() {
  const src = readFileSync(join(REPO, 'src', 'bridge.ts'), 'utf8')
  const decl = src.match(/BRIDGE_SOURCE_KIND\s*=\s*'([^']+)'/)
  if (!decl) throw new Error('src/bridge.ts 里找不到 BRIDGE_SOURCE_KIND 声明')
  // 插件名取规范常量（BRIDGE_PACKAGE_NAME），不靠在文件里瞎猜第一个字符串
  const named = src.match(/\bBRIDGE_PACKAGE_NAME\s*=\s*'([^']+)'/) ?? src.match(/\bBRIDGE_ENTRY_ID\s*=\s*'([^']+)'/)
  if (!named) throw new Error('src/bridge.ts 里找不到 BRIDGE_PACKAGE_NAME / BRIDGE_ENTRY_ID')
  return { kind: decl[1], pluginName: named[1] }
}

//#endregion

//#region 定位本机已安装的 DSH（与 dsh-compat-diff.mjs 同一套发现约定）

function candidateRoots() {
  // 显式 --root 是**独占**的：指定了就只认它，否则没法拿它做「找不到就该失败」的负向测试
  if (rootOverride) return [rootOverride]
  const out = []
  if (process.env.DSH_INSTALL_ROOT) out.push(process.env.DSH_INSTALL_ROOT)
  const appData = process.env.APPDATA ?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming') : undefined)
  if (appData) out.push(join(appData, 'npm', 'node_modules'))
  if (process.env.npm_config_prefix) out.push(join(process.env.npm_config_prefix, 'node_modules'))
  return out
}

/** 在若干安装根里找 dsh-session-format-v3-to-v4 的入口文件，返回 { path, version, root }。 */
function findV4Package() {
  for (const root of candidateRoots()) {
    // 两个落位：npm 全局根平铺，以及 dsh 包自己的嵌套 node_modules（本机实测在此）
    for (const base of [join(root, SCOPE), join(root, SCOPE, 'dsh', 'node_modules', SCOPE)]) {
      const dir = join(base, PKG_DIR)
      const entry = join(dir, 'lib', 'index.js')
      if (!existsSync(entry)) continue
      let version = '?'
      try {
        version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '?'
      } catch {
        /* 版本读不到不影响校验 */
      }
      return { path: entry, version, root }
    }
  }
  return null
}

//#endregion

//#region 断言的载体：与 DSH 内部同一套消息槽位

const msg = (source) => ({ role: 'user', content: [{ type: 'text', text: 'injected instruction' }], source })
const userRow = (source) => ({ type: 'user/message', seq: 1, data: msg(source) })
const splicedRow = (source) => ({
  type: 'agent/inbox/spliced',
  seq: 2,
  data: { inserted: [msg(source)] },
})

/** 跑一次准入；返回 'admitted' | 'rejected-by-v4-source' | 'other-error'。 */
function attempt(assertFn, row, knownEventTypes) {
  try {
    assertFn(row, knownEventTypes)
    return { result: 'admitted' }
  } catch (e) {
    const message = String((e && e.message) || e)
    if (message.includes(REJECTION_TEXT)) return { result: 'rejected-by-v4-source', message }
    return { result: 'other-error', message }
  }
}

//#endregion

const checks = []
function check(id, desc, ok, detail) {
  checks.push({ id, desc, ok, detail })
}

async function main() {
  const { kind: emittedKind, pluginName } = readEmittedKind()
  const legacyShape = { kind: 'plugin', plugin: pluginName, form: 'notice', summary: 'obsidian-edit' }
  const emittedShape = { kind: emittedKind, form: 'notice', summary: 'obsidian-edit' }

  const found = findV4Package()
  const meta = {
    emittedKind,
    pluginName,
    packagePath: found ? found.path : null,
    packageVersion: found ? found.version : null,
    installRoot: found ? found.root : null,
  }

  if (!found) {
    if (requireInstalled) {
      check('install', '找到本机 DSH 会话格式 v4 包', false, '未找到——已指定 --require')
      return report(meta, 1)
    }
    return report(meta, 0, true)
  }

  const mod = await import(pathToFileURL(found.path).href)
  const assertFn = mod.assertV4RowAdmission
  if (typeof assertFn !== 'function') {
    check('export', 'DSH 导出 assertV4RowAdmission', false, '导出面：' + Object.keys(mod).sort().join(', '))
    return report(meta, 1)
  }
  const known = new Set(['user/message', 'agent/inbox/spliced'])

  // A / B：插件当前发出的形态必须过闸
  const a = attempt(assertFn, userRow(emittedShape), known)
  check('A', `新形态被准入（user/message）  kind=${emittedKind}`, a.result === 'admitted', a.message ?? a.result)

  const b = attempt(assertFn, splicedRow(emittedShape), known)
  check('B', '新形态被准入（agent/inbox/spliced.inserted）', b.result === 'admitted', b.message ?? b.result)

  // C / D：旧形态必须被拒（证明探针真的咬得住，不是因为函数没在跑）
  const c = attempt(assertFn, userRow(legacyShape), known)
  check('C', '旧形态 kind:"plugin" 被硬拒（user/message）', c.result === 'rejected-by-v4-source', c.message ?? c.result)

  const d = attempt(assertFn, splicedRow(legacyShape), known)
  check('D', '旧形态 kind:"plugin" 被硬拒（agent/inbox/spliced.inserted）', d.result === 'rejected-by-v4-source', d.message ?? d.result)

  // E：形态契约——必须是 `plugin:<插件名>`，与 v4 迁移的第三方兜底同形
  const shaped = emittedKind === `plugin:${pluginName}` && /^plugin:[^:]+$/.test(emittedKind)
  check('E', `形态契约 kind === "plugin:${pluginName}"（与 v4 迁移兜底同形）`, shaped, `实际 ${emittedKind}`)

  return report(meta, checks.every((x) => x.ok) ? 0 : 1)
}

function report(meta, exitCode, skipped = false) {
  if (asJson) {
    console.log(JSON.stringify({ skipped, exitCode, ...meta, checks }, null, 2))
    process.exit(exitCode)
  }

  console.log('会话源 kind 准入探针')
  console.log(`  插件发出的 kind   ${meta.emittedKind}`)
  console.log(`  DSH 包            ${meta.packageVersion}  ${meta.packagePath ?? ''}`)
  console.log('')

  if (skipped) {
    console.log('SKIP：本机没找到 ' + TARGET_PKG)
    console.log('      没装 DSH 就无从校验；要把它当失败请加 --require')
    process.exit(0)
  }

  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}`)
    if (!c.ok) console.log(`      -> ${c.detail}`)
  }
  const failed = checks.filter((c) => !c.ok).length
  console.log('')
  console.log(failed === 0 ? `结论：全部通过（${checks.length}/${checks.length}）` : `结论：${failed} 项失败`)
  process.exit(exitCode)
}

await main()
