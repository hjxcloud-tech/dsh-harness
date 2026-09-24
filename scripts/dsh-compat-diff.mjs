/**
 * DSH 版本适配比对（开发工具，不进发布物；v2.6.1 引入）
 *
 * 用途：DSH 每次发新版，用它把「插件依赖的全部触点」在两个安装树之间做逐项比对，
 * 输出版本门禁要写进 src/compat.ts 的事实（哪些接缝变了、变成什么样、是否仍兼容）。
 *
 * 用法：
 *   node scripts/dsh-compat-diff.mjs <A树根> <B树根> [--json]
 * 树根 = 包含 `node_modules/@deepseek-ai/` 的安装根，例如：
 *   A（已适配基线） %APPDATA%\npm\node_modules\@deepseek-ai\dsh 的全局安装根：%APPDATA%\npm\node_modules
 *   B（新版本）     %TEMP%\dsh-017a2-test\node_modules
 *
 * 判读口径：
 *   same      = 命中文件与出现次数完全一致 → 该触点零风险
 *   moved     = 出现次数变了但符号仍在   → 实现改过，需人工看 diff
 *   gone      = B 树找不到该符号         → **破坏性**，插件对应功能要改
 *   new       = 仅 B 有                 → 上游新增能力（可考虑采用）
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SCANNED = ['.js', '.mjs', '.cjs']
const MAX_FILE = 6 * 1024 * 1024

/** 插件真实依赖的触点（从 src/*.ts 反查得来，勿凭印象增删）。 */
const SEAMS = [
  { id: 'webServer.tapIndex', re: /tapIndex/g, why: '桥接往 index.html 注入页面脚本的唯一入口' },
  { id: 'connection.requestRejection', re: /requestRejection/g, why: '嵌入认证适配器包裹的拒绝函数' },
  { id: 'connection.authorizeIndex', re: /authorizeIndex/g, why: 'index 页鉴权（ob=1 直发放行）' },
  { id: 'connection.authenticatedUrl', re: /authenticatedUrl/g, why: '带 token 的启动 URL 生成' },
  { id: 'launchToken 每进程随机', re: /launchToken/g, why: '外部实例 token 不可附加 ⇒ 只能自起实例' },
  { id: 'agent/pre-step 钩子', re: /["']agent\/pre-step["']/g, why: '隐式行的隐藏编辑指令注入' },
  { id: 'agent.inbox 一次性投递', re: /agent\.inbox/g, why: 'pre-step 之外的会话内直投' },
  { id: '引导 marker __DSH_BOOT__', re: /__DSH_BOOT__/g, why: 'AED 启动健康校验判据' },
  { id: 'client.js face createClientModuleSystem', re: /createClientModuleSystem/g, why: 'boot face 校验（bundle-face 错误分类）' },
  { id: 'dsh-client-modules 包', re: /dsh-client-modules/g, why: '客户端模块发现与预加载' },
  { id: 'embed token 变量 __DSH_EMBED_TOKEN__', re: /__DSH_EMBED_TOKEN__/g, why: '页面脚本读启动 token 的入口' },
  { id: '官方上传钩子 __DSH_FILE_UPLOAD__', re: /__DSH_FILE_UPLOAD__/g, why: '上传兜底载体（pre-Cordis 钩子）' },
  { id: '上传 Worker 具名 dsh-file-upload', re: /dsh-file-upload/g, why: '面板内上传补丁的命中依据' },
  { id: '上传路由 uploadFileBinary', re: /uploadFileBinary/g, why: '凭据注入的目标端点' },
  { id: 'home 路径 DSH_HOME 约定', re: /dsh-home-paths|DSH_HOME/g, why: 'profile/桥接文件落位' },
  { id: '会话格式目录 session-format-catalog', re: /session-format-catalog/g, why: '会话修复用的迁移链' },
  {
    id: '会话格式 v4 源 kind 硬拒（producer-owned）',
    re: /producer-owned source kind/g,
    why: 'v4 起通用 kind:"plugin" 源包裹层被硬拒，插件注入源必须用生产者自己的 kind；本触点只反映该语义是否被上游改动，**行为**是否仍兼容由 scripts/verify-source-kind-admission.mjs 校验（符号法看不见语义收紧）',
  },
  { id: 'bundle 声明 dsh.bundle.patch', re: /dsh\.bundle\.patch/g, why: 'AED 健康探测与禁用块语义' },
  { id: 'profile 模板 PROFILE_TEMPLATES', re: /PROFILE_TEMPLATES/g, why: '内置档名保留名单的事实源' },
  { id: '代建参数 --from-default-profile', re: /from-default-profile/g, why: '只建不 boot 的代建路径' },
  { id: '代建参数 --dump-default-config', re: /dump-default-config/g, why: '同上（必须走 dump 分支才不 boot）' },
  { id: 'CLI 选项 --no-open', re: /no-open/g, why: '避免启动弹浏览器' },
  { id: '启动行 `dsh web:` 格式', re: /dsh web: /g, why: '插件从子进程 stdout 捕获 token' },
  { id: '客户端插件声明 dsh.client', re: /dsh\.client|"client"/g, why: '未来双面插件化的入口' },
  { id: '外部修复工具 dsh-fix', re: /dsh-fix/g, why: 'AED 安全模式抢救链' },
  { id: '输入框 Lexical data-phase', re: /data-phase/g, why: '受控编辑器写入定位' },
  { id: '官方写入口 setDraft', re: /setDraft/g, why: '替代 DOM 写入的正解（未采用）' },
]

function rootsFor(root) {
  const out = []
  for (const p of [join(root, '@deepseek-ai'), join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')]) {
    if (existsSync(p)) out.push(p)
  }
  return out
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(p, files)
    } else if (SCANNED.includes(p.slice(p.lastIndexOf('.'))) && statSync(p).size <= MAX_FILE) {
      files.push(p)
    }
  }
  return files
}

function collect(root) {
  const map = new Map()
  for (const r of rootsFor(root)) {
    for (const file of walk(r)) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      map.set(relative(root, file), text)
    }
  }
  return map
}

function packages(root) {
  const set = new Set()
  for (const r of rootsFor(root)) {
    for (const e of readdirSync(r, { withFileTypes: true })) if (e.isDirectory()) set.add(e.name)
  }
  return set
}

const [,, argA, argB, ...flags] = process.argv
if (!argA || !argB) {
  console.error('usage: node scripts/dsh-compat-diff.mjs <rootA> <rootB> [--json]')
  process.exit(2)
}
const A = collect(argA)
const B = collect(argB)
const PA = packages(argA)
const PB = packages(argB)

const rows = SEAMS.map(({ id, re, why }) => {
  const count = (m) => {
    let hits = 0
    let files = 0
    for (const [name, text] of m) {
      const n = (text.match(new RegExp(re.source, 'g')) || []).length
      if (n > 0) { hits += n; files += 1 }
    }
    return { hits, files }
  }
  const a = count(A)
  const b = count(B)
  const status = a.hits === 0 && b.hits === 0 ? 'absent-both'
    : a.hits === 0 ? 'NEW'
    : b.hits === 0 ? 'GONE'
    : a.hits === b.hits && a.files === b.files ? 'same' : 'moved'
  return { id, why, a, b, status }
})

const pkgAdded = [...PB].filter((x) => !PA.has(x))
const pkgRemoved = [...PA].filter((x) => !PB.has(x))

function verOf(root, name) {
  const candidates = [join(root, '@deepseek-ai', name, 'package.json'), join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', name, 'package.json')]
  for (const c of candidates) if (existsSync(c)) { try { return JSON.parse(readFileSync(c, 'utf8')).version } catch { /* skip */ } }
  return null
}
const WATCH_PACKAGES = ['dsh', 'dsh-client-file-upload', 'dsh-client-connection', 'dsh-client-modules', 'dsh-app-boot', 'dsh-session-format-catalog', 'dsh-api-session-controller']
const versions = WATCH_PACKAGES.map((p) => ({ pkg: p, a: verOf(argA, p), b: verOf(argB, p) }))

const verdict = rows.filter((r) => r.status === 'GONE').length === 0 ? 'COMPATIBLE(检查 moved 项)' : 'BREAKING'
if (flags.includes('--json')) {
  console.log(JSON.stringify({ verdict, rows, packages: { added: pkgAdded, removed: pkgRemoved }, versions }, null, 1))
} else {
  console.log(`A=${argA}\nB=${argB}\n文件数 A=${A.size} B=${B.size}｜包数 A=${PA.size} B=${PB.size}\n`)
  for (const r of rows) {
    console.log(`${r.status.toUpperCase().padEnd(12)} A(${String(r.a.hits).padStart(4)}hit/${String(r.a.files).padStart(3)}file) B(${String(r.b.hits).padStart(4)}/${String(r.b.files).padStart(3)})  ${r.id}`)
  }
  console.log(`\n包：新增 ${pkgAdded.join(', ') || '无'}\n    移除 ${pkgRemoved.join(', ') || '无'}`)
  console.log('\n关键包版本：')
  for (const v of versions) console.log(`  ${v.pkg.padEnd(34)} ${v.a || '—'} → ${v.b || '—'}`)
  const gone = rows.filter((r) => r.status === 'GONE')
  const moved = rows.filter((r) => r.status === 'moved' || r.status === 'NEW')
  console.log(`\n结论：${verdict}｜GONE=${gone.length} moved/new=${moved.length} same=${rows.filter((r) => r.status === 'same').length}`)
  if (gone.length) console.log('破坏性触点：' + gone.map((r) => r.id).join(', '))
  if (moved.length) console.log('需人工看 diff：' + moved.map((r) => r.id).join(', '))
}
