/**
 * 桥接 package 模式的落地探针（开发工具，不进发布物；v2.8.0 引入）
 *
 * 为什么需要它（A3 的教训）：
 *   客户端半 `client.js`（官方 `setDraft` 的唯一来源）只会在**裸包名条目**下被装载器编进
 *   /plugins combo —— `dsh-client-modules` 的 `exactPackageSpecifier()` 显式排除路径形态
 *   （`file:///…` 与含 `/` 的子路径）。v2.7.0 把 package 模式的管道全都写好了，
 *   却因为 `installAs` 从没有调用点把它设成 `'package'` 而**成了死代码**：
 *   磁盘上永远只有路径条目，客户端半一次都没被引用过，而单测只断言"函数存在"——
 *   全绿，但功能从未生效（典型的"测了存在性、没测可用性"）。
 *   本探针把"package 模式在真磁盘上确实产出了可被装载器认出的形状"钉死。
 *
 * 校验什么（全部基于真写盘 + 真读回，不靠字符串猜）：
 *   A. 补丁条目是**裸包名**（不是 file:///…），且旧的路径条目已被原地替换
 *   B. profile/node_modules/<包名> 链接存在，且 realpath 解析到桥接包目录本身
 *   C. 包清单含装载器必需字段：main / exports["."] / exports["./client"] / dsh.client.platform
 *      且**故意不含** inject（实测声明它会令 0.1.7-rc.1 启动出现 entries did not activate）
 *   D. 客户端半产物存在、形状正确（__ModuleLoader__.load + setDraft 包装 + 向父页回报）
 *   E. 宿主半模块可被 import，导出 name/apply，且 name 与包名一致（装载器按包名索引）
 *   F. 幂等：同参数再写一次 → changed=false、pluginRewritten=false
 *   G. 负向：链接位置被同名**普通目录**占住时，package 模式必须**退回路径模式**
 *      并把原因写进 error（宁可没有客户端半，也不能让桥接整个不加载）
 *   H. 回切：再以 path 模式写入 → 条目变回 file:///、client.js 被清掉
 *
 * 用法：
 *   npm run verify:package
 *   node scripts/verify-package-mode.mjs [--json] [--keep]
 *
 * `--keep` 保留临时 home（排查用）。全部通过 exit 0，任一失败 exit 1。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const keep = args.includes('--keep')

/** 从 src/bridge.ts 的源码里读规范常量（勿在探针里硬编码包名，那正是本次要防的漂移）。 */
function readConstants() {
  const src = readFileSync(join(REPO, 'src', 'bridge.ts'), 'utf8')
  const pick = (re, what) => {
    const m = src.match(re)
    if (!m) throw new Error(`src/bridge.ts 里找不到 ${what}`)
    return m[1]
  }
  return {
    pkgName: pick(/\bBRIDGE_PACKAGE_NAME\s*=\s*'([^']+)'/, 'BRIDGE_PACKAGE_NAME'),
    entryId: pick(/\bBRIDGE_ENTRY_ID\s*=\s*'([^']+)'/, 'BRIDGE_ENTRY_ID'),
    moduleFile: pick(/\bBRIDGE_MODULE_FILENAME\s*=\s*'([^']+)'/, 'BRIDGE_MODULE_FILENAME'),
    clientFile: pick(/\bBRIDGE_CLIENT_FILENAME\s*=\s*'([^']+)'/, 'BRIDGE_CLIENT_FILENAME'),
    pkgDirName: pick(/\bBRIDGE_PACKAGE_DIRNAME\s*=\s*'([^']+)'/, 'BRIDGE_PACKAGE_DIRNAME'),
  }
}

const checks = []
const check = (id, desc, ok, detail) => checks.push({ id, desc, ok, detail })

const normCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** 取出桥接条目那几行（`- id: <entryId>` 之后到下一个 `- ` 或 EOF）。 */
function bridgeEntryBlock(patch) {
  const lines = patch.split('\n')
  const idAt = lines.findIndex((l) => l.includes(`id: ${C.entryId}`))
  if (idAt < 0) return ''
  const out = [lines[idAt]]
  for (let i = idAt + 1; i < lines.length; i++) {
    if (/^\s*-\s/.test(lines[i]) || /^-\s/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

const C = readConstants()
let home = ''

async function main() {
  const built = await build({
    entryPoints: [join(REPO, 'src', 'bridge.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  const mod = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
  const { writeBridgeFiles, bridgePackageDir, bridgePackageLinkPath, dshProfileDir } = mod

  home = mkdtempSync(join(tmpdir(), 'dsh-pkg-verify-'))
  const profile = 'web'
  const profileDir = dshProfileDir(profile, home)
  const pkgDir = bridgePackageDir(profileDir)
  const clientPath = join(pkgDir, C.clientFile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const linkPath = bridgePackageLinkPath(profileDir)

  // ---------- 0. 先以 path 模式铺底（模拟"老用户从路径模式升上来"的真实起点） ----------
  const pre = writeBridgeFiles(home, '0.0.0-probe', profile, 'path')
  check('0', 'path 模式铺底：条目是 file:/// 路径且不落客户端半', pre.installAs === 'path' && !existsSync(clientPath), `installAs=${pre.installAs} client=${existsSync(clientPath)}`)

  // ---------- 1. package 模式 ----------
  const res = writeBridgeFiles(home, '0.0.0-probe', profile, 'package')
  const block = bridgeEntryBlock(readFileSync(patchPath, 'utf8'))

  check(
    'A',
    `条目是裸包名 name: ${C.pkgName}（装载器只认这种）`,
    new RegExp(`name:\\s*${C.pkgName}\\s*$`, 'm').test(block) && !block.includes('file:///'),
    `block=${JSON.stringify(block)} installAs=${res.installAs}`,
  )

  let linkOk = false
  let linkDetail = 'link missing'
  if (existsSync(linkPath)) {
    try {
      const st = lstatSync(linkPath)
      // Windows 的 junction 在 Node 里 lstat().isSymbolicLink() 为 true、isDirectory() 为 false，
      // 故两种形态都要认（旧版 npm 链接是目录 symlink，Windows 是 junction）
      const isLink = st.isSymbolicLink() || st.isDirectory()
      linkOk = isLink && normCase(realpathSync(linkPath)) === normCase(pkgDir)
      linkDetail = `isLink=${isLink} realpath=${realpathSync(linkPath)}`
    } catch (e) {
      linkDetail = String(e && e.message)
    }
  }
  check('B', `profile/node_modules/${C.pkgName} 链接指向桥接包目录`, linkOk, linkDetail)

  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const manifestOk =
    manifest.main === `./${C.moduleFile}` &&
    manifest.exports?.['.'] === `./${C.moduleFile}` &&
    manifest.exports?.['./client']?.default === `./${C.clientFile}` &&
    manifest.exports?.['./package.json'] === './package.json' &&
    manifest.dsh?.client?.platform === 'web'
  check('C1', '包清单含装载器必需字段（main / exports / dsh.client.platform）', manifestOk, JSON.stringify(manifest))
  // 负向：inject 是实测踩过的坑（声明它会令 0.1.7-rc.1 的 7 个 entries 不激活）
  check('C2', '包清单**不含** inject 声明（0.1.7-rc.1 实测：声明即启动异常）', !('inject' in (manifest.dsh?.client ?? {})), JSON.stringify(manifest.dsh ?? {}))

  const clientSrc = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : ''
  check(
    'D',
    '客户端半形状正确（__ModuleLoader__.load + setDraft 包装 + 父页回报）',
    clientSrc.includes('__ModuleLoader__.load(') &&
      clientSrc.includes('actions.setDraft') &&
      clientSrc.includes('__DSH_BRIDGE_SET_DRAFT__') &&
      clientSrc.includes('dsh-bridge-client') &&
      clientSrc.includes("inject = ['slots']"),
    `len=${clientSrc.length}`,
  )

  let hostMod = null
  let hostErr = ''
  try {
    hostMod = await import(pathToFileURL(join(pkgDir, C.moduleFile)).href + `?t=${Date.now()}`)
  } catch (e) {
    hostErr = String(e && e.message)
  }
  check(
    'E',
    `宿主半可 import 且 name 与包名一致（${C.pkgName}）`,
    hostMod !== null && hostMod.name === C.pkgName && typeof hostMod.apply === 'function',
    hostErr === '' ? `exports=${Object.keys(hostMod ?? {}).sort().join(',')}` : hostErr,
  )

  // ---------- 2. 幂等 ----------
  const again = writeBridgeFiles(home, '0.0.0-probe', profile, 'package')
  check('F', '幂等：同参数重写不产生变更', again.changed === false && again.pluginRewritten === false, JSON.stringify(again))

  // ---------- 3. 负向：链接位置被普通目录占住 → 必须退回路径模式 ----------
  rmSync(linkPath, { recursive: true, force: true })
  mkdirSync(linkPath, { recursive: true })
  writeFileSync(join(linkPath, 'someone-elses-package.txt'), 'not ours\n', 'utf8')
  const fallback = writeBridgeFiles(home, '0.0.0-probe', profile, 'package')
  const fbBlock = bridgeEntryBlock(readFileSync(patchPath, 'utf8'))
  check(
    'G',
    '链接位被同名普通目录占住 → 退回路径模式并给出原因（不静默半装）',
    fallback.installAs === 'path' && fallback.error !== undefined && fallback.error !== '' && fbBlock.includes('file:///'),
    `installAs=${fallback.installAs} error=${fallback.error ?? ''} block=${JSON.stringify(fbBlock)}`,
  )

  // ---------- 4. 回切 path：条目与产物都要干净 ----------
  rmSync(linkPath, { recursive: true, force: true })
  const back = writeBridgeFiles(home, '0.0.0-probe', profile, 'package')
  const backBlock = bridgeEntryBlock(readFileSync(patchPath, 'utf8'))
  const pathAgain = writeBridgeFiles(home, '0.0.0-probe', profile, 'path')
  check(
    'H',
    '回切 path：条目变回 file:///、客户端半被清掉（不给扫描留假入口）',
    back.installAs === 'package' &&
      backBlock.includes(C.pkgName) &&
      !backBlock.includes('file:///') &&
      pathAgain.installAs === 'path' &&
      !existsSync(clientPath) &&
      bridgeEntryBlock(readFileSync(patchPath, 'utf8')).includes('file:///'),
    `back=${back.installAs} path=${pathAgain.installAs} clientExists=${existsSync(clientPath)}`,
  )

  return report()
}

function report() {
  const failed = checks.filter((c) => !c.ok).length
  if (asJson) {
    console.log(JSON.stringify({ home, checks, failed }, null, 2))
  } else {
    console.log('桥接 package 模式落地探针')
    console.log(`  临时 DSH home   ${home}`)
    console.log('')
    for (const c of checks) {
      console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}`)
      if (!c.ok) console.log(`      -> ${c.detail}`)
    }
    console.log('')
    console.log(failed === 0 ? `结论：全部通过（${checks.length}/${checks.length}）` : `结论：${failed} 项失败`)
  }
  if (!keep) {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉无害 */
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

await main()
