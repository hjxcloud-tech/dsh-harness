/**
 * 只读触点自检（v2.8.8；用户机制定案：版本适配情况不得依赖人工发起检查）。
 *
 * 干什么：本机 DSH 高于实测上界时（`judgeDshCompat = 'untested-newer'` 且来源为已核验的全局官方包），
 * 插件开机后台自动对安装树跑一次触点扫描——把 `scripts/dsh-compat-diff.mjs` 的 27 项触点逐项数一遍
 * 符号命中，与登记基线（`COMPAT_BASELINE_VERSION` 时抓的指纹）比对，结论**只追加**到设置页
 * 「当前适配状态」行与「DSH版本适配说明」弹窗文字。全程只读、静默：
 * - 不弹任何窗（v2.8.4 定案不破例，[[用户偏好]]第 22 条）；
 * - 不改适配等级、不驱动横幅色调（等级仍只由版本区间判定产出）；
 * - **不构成适配登记**——登记规矩不变（`compat.ts`：只登记沙盒真跑过的版本，触点扫描只是辅助证据，
 *   正如 0.1.5-rc.3「24 触点全 same 但没实跑就不登记」）。符号法也看不见语义收紧
 *   （如 v4 源 kind 硬拒），所以行为兼容性仍以沙盒为准。
 *
 * 基线怎么来：`node scripts/dsh-compat-diff.mjs <root> <root> --json`（基线树＝上界那版的全局安装根）。
 * 上界每次上推，基线指纹必须同批重抓并改 `COMPAT_BASELINE_VERSION`——tests/compat-diff.test.ts
 * 与 verify-profile S3.8 会锁「基线版本＝实测上界」，漏改直接红。
 * 触点表本身与 `scripts/dsh-compat-diff.mjs` 的 SEAMS 同序逐项锁定（防两张表漂移）。
 */
import { existsSync, promises as fsp, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { globalDshManifestCandidates, readDshPackageIdentity } from './dsh-identity'
import { t } from './i18n'

/** 指纹表所描述的版本——必须等于已登记实测上界（上界上推时同批重抓本表）。 */
export const COMPAT_BASELINE_VERSION = '0.2.0-rc.2'
/** 基线树 js/mjs/cjs 文件总数（2026-09-30 隔离安装 rc.2 树实测扫描值）——「扫错树」护栏的依据。 */
export const COMPAT_BASELINE_FILES = 994

const SCANNED = ['.js', '.mjs', '.cjs']
const MAX_FILE = 6 * 1024 * 1024
const MAX_FILES = 8000
/** 扫描文件数低于基线四成即判「树不对」，不下任何结论（宁缺勿错，避免误报破坏）。 */
const MIN_SCAN_RATIO = 0.4

/** 一行触点＝开发比对工具的 SEAMS 条目＋基线指纹（hits/files 为该版本全局安装树的实测值）。 */
export interface SeamRow {
  id: string
  re: RegExp
  why: string
  hits: number
  files: number
}

/**
 * 触点指纹表（勿凭印象增删；id＋正则与 scripts/dsh-compat-diff.mjs 逐项锁定）。
 * `hits: 0` 的两行（embed token 注入变量、dsh-fix 工具名）是**实测事实**：这两个符号本就由
 * 插件/独立 npm 包注入，不在官方安装树里——基线零的触点只做「新出现」观察，永不算缺失。
 */
export const SEAM_BASELINE: readonly SeamRow[] = [
  { id: 'webServer.tapIndex', re: /tapIndex/g, why: '桥接往 index.html 注入页面脚本的唯一入口', hits: 6, files: 2 },
  { id: 'connection.requestRejection', re: /requestRejection/g, why: '嵌入认证适配器包裹的拒绝函数', hits: 8, files: 4 },
  { id: 'connection.authorizeIndex', re: /authorizeIndex/g, why: 'index 页鉴权（ob=1 直发放行）', hits: 9, files: 3 },
  { id: 'connection.authenticatedUrl', re: /authenticatedUrl/g, why: '带 token 的启动 URL 生成', hits: 9, files: 3 },
  { id: 'launchToken 每进程随机', re: /launchToken/g, why: '外部实例 token 不可附加 ⇒ 只能自起实例', hits: 4, files: 1 },
  { id: 'agent/pre-step 钩子', re: /["']agent\/pre-step["']/g, why: '隐式行的隐藏编辑指令注入', hits: 24, files: 23 },
  { id: 'agent.inbox 一次性投递', re: /agent\.inbox/g, why: 'pre-step 之外的会话内直投', hits: 35, files: 8 },
  { id: '引导 marker __DSH_BOOT__', re: /__DSH_BOOT__/g, why: 'AED 启动健康校验判据', hits: 12, files: 6 },
  { id: 'client.js face createClientModuleSystem', re: /createClientModuleSystem/g, why: 'boot face 校验（bundle-face 错误分类）', hits: 5, files: 2 },
  { id: 'dsh-client-modules 包', re: /dsh-client-modules/g, why: '客户端模块发现与预加载', hits: 8, files: 5 },
  { id: 'embed token 变量 __DSH_EMBED_TOKEN__', re: /__DSH_EMBED_TOKEN__/g, why: '页面脚本读启动 token 的入口', hits: 0, files: 0 },
  { id: '官方上传钩子 __DSH_FILE_UPLOAD__', re: /__DSH_FILE_UPLOAD__/g, why: '上传兜底载体（pre-Cordis 钩子）', hits: 2, files: 2 },
  { id: '上传 Worker 具名 dsh-file-upload', re: /dsh-file-upload/g, why: '面板内上传补丁的命中依据', hits: 2, files: 2 },
  { id: '上传路由 uploadFileBinary', re: /uploadFileBinary/g, why: '凭据注入的目标端点', hits: 3, files: 3 },
  { id: 'home 路径 DSH_HOME 约定', re: /dsh-home-paths|DSH_HOME/g, why: 'profile/桥接文件落位', hits: 61, files: 12 },
  { id: '会话格式目录 session-format-catalog', re: /session-format-catalog/g, why: '会话修复用的迁移链', hits: 7, files: 5 },
  { id: '会话格式 v4 源 kind 硬拒（producer-owned）', re: /producer-owned source kind/g, why: 'v4 起通用 kind:"plugin" 源包裹层被硬拒；行为是否兼容仍以 verify-source-kind-admission 为准', hits: 2, files: 2 },
  { id: 'bundle 声明 dsh.bundle.patch', re: /dsh\.bundle\.patch/g, why: 'AED 健康探测与禁用块语义', hits: 3, files: 2 },
  { id: 'profile 模板 PROFILE_TEMPLATES', re: /PROFILE_TEMPLATES/g, why: '内置档名保留名单的事实源', hits: 13, files: 4 },
  { id: '代建参数 --from-default-profile', re: /from-default-profile/g, why: '只建不 boot 的代建路径', hits: 5, files: 2 },
  { id: '代建参数 --dump-default-config', re: /dump-default-config/g, why: '同上（必须走 dump 分支才不 boot）', hits: 4, files: 2 },
  { id: 'CLI 选项 --no-open', re: /no-open/g, why: '避免启动弹浏览器', hits: 6, files: 4 },
  { id: '启动行 `dsh web:` 格式', re: /dsh web: /g, why: '插件从子进程 stdout 捕获 token', hits: 2, files: 1 },
  { id: '客户端插件声明 dsh.client', re: /dsh\.client|"client"/g, why: '未来双面插件化的入口', hits: 79, files: 34 },
  { id: '外部修复工具 dsh-fix', re: /dsh-fix/g, why: 'AED 安全模式抢救链（工具独立于安装树，基线零属实测事实）', hits: 0, files: 0 },
  { id: '输入框 Lexical data-phase', re: /data-phase/g, why: '受控编辑器写入定位', hits: 13, files: 4 },
  { id: '官方写入口 setDraft', re: /setDraft/g, why: '替代 DOM 写入的正解（未采用）', hits: 33, files: 7 },
]

/** 单个触点在一棵树里的命中统计。 */
export interface SeamHits {
  hits: number
  files: number
}

export type SeamScanState = 'intact' | 'moved' | 'gone' | 'skipped' | 'failed'

export interface SeamScanResult {
  state: SeamScanState
  /** 被扫描的本机版本串（标签用）。 */
  version: string
  /** 指纹表所描述的版本。 */
  baselineVersion: string
  /** 实际扫描的 js/mjs/cjs 文件数。 */
  scannedFiles: number
  /** 期望存在的触点总数（基线 hits>0 的行）。 */
  expected: number
  /** 仍在的期望触点数（expected − gone）。 */
  present: number
  /** 符号彻底消失的触点（破坏性信号）。 */
  gone: string[]
  /** 符号仍在但出现次数/文件数变了的触点（需人工看 diff）。 */
  moved: string[]
  /** 基线为零却出现的触点（新符号观察，不算破坏也不算登记理由）。 */
  extra: string[]
  /** skipped/failed 的原因码：'no-root' | 'tree-shape' | 错误原文。 */
  reason?: string
}

/**
 * 是否该跑触点自检：只在「来源已核验（全局官方包 manifest）＋本机判为高于实测上界」时。
 * 仓库形态（源码布局不含发布物 bundle）与未核验来源（PATH 上的第三方同名 dsh）一律不跑。
 * 签名用字符串而非 compat 的联合类型，避免 compat ↔ compat-diff 互相牵引用。
 */
export function seamScanApplicable(input: { verified: boolean; source: string; level: string }): boolean {
  return input.verified && input.source === 'official-manifest' && input.level === 'untested-newer'
}

/**
 * 从全局官方包 manifest 候选定位「安装根」（含 `@deepseek-ai` 的 node_modules 层）；
 * 目录名匹配还必须通过包名身份核验（`readDshPackageIdentity`），第三方同名号段一律不认。
 */
export function findOfficialInstallRoot(): string | null {
  for (const manifest of globalDshManifestCandidates()) {
    if (!existsSync(manifest)) continue
    const pkgDir = dirname(manifest)
    if (readDshPackageIdentity(pkgDir) === null) continue
    // <root>/@deepseek-ai/dsh/package.json → <root>
    const root = dirname(dirname(pkgDir))
    if (existsSync(join(root, '@deepseek-ai', 'dsh'))) return root
  }
  return null
}

/** 递归收文件（跳过嵌套 node_modules 与点目录、>6MB 的产物），超上限即截断返回 false。 */
async function collectFiles(dir: string, out: string[]): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return true // 目录读不动＝跳过该根，不算截断
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return false
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      if (!(await collectFiles(p, out))) return false
    } else if (SCANNED.some((ext) => p.endsWith(ext))) {
      try {
        const st = await fsp.stat(p)
        if (st.size <= MAX_FILE) out.push(p)
      } catch {
        // 单文件 stat 失败：跳过
      }
    }
  }
  return true
}

/**
 * 扫描一棵安装树，逐项统计触点命中（命中数与出现文件数）。
 * 根目录语义与 dsh-compat-diff.mjs 一致：`<root>/@deepseek-ai` 与嵌套 `<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai`。
 * 每个 await 都让出事件循环，扫描不阻塞 Obsidian UI。
 */
export async function scanSeamTree(root: string): Promise<{ counts: Map<string, SeamHits>; files: number; truncated: boolean }> {
  const files: string[] = []
  let truncated = false
  for (const p of [join(root, '@deepseek-ai'), join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')]) {
    if (!existsSync(p)) continue
    if (!(await collectFiles(p, files))) {
      truncated = true
      break
    }
  }
  const compiled = SEAM_BASELINE.map((row) => ({ id: row.id, re: new RegExp(row.re.source, 'g') }))
  const counts = new Map<string, SeamHits>()
  for (let i = 0; i < files.length; i++) {
    if (i > 0 && i % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0)) // 每 100 个文件让出一次主线程
    let text: string
    try {
      text = await fsp.readFile(files[i], 'utf8')
    } catch {
      continue // 与开发工具同口径：读不动的文件跳过
    }
    for (const c of compiled) {
      const n = (text.match(c.re) ?? []).length
      if (n > 0) {
        const cur = counts.get(c.id) ?? { hits: 0, files: 0 }
        cur.hits += n
        cur.files += 1
        counts.set(c.id, cur)
      }
    }
  }
  return { counts, files: files.length, truncated }
}

/** 分类器（纯函数，表驱动可测）：gone＝基线有而现在没有；moved＝符号在但计数变了；extra＝基线零却出现。 */
export function classifySeams(counts: Map<string, SeamHits>): { gone: string[]; moved: string[]; extra: string[]; expected: number; present: number } {
  const gone: string[] = []
  const moved: string[] = []
  const extra: string[] = []
  let expected = 0
  for (const row of SEAM_BASELINE) {
    const c = counts.get(row.id) ?? { hits: 0, files: 0 }
    if (row.hits === 0) {
      if (c.hits > 0) extra.push(row.id)
      continue
    }
    expected += 1
    if (c.hits === 0) gone.push(row.id)
    else if (c.hits !== row.hits || c.files !== row.files) moved.push(row.id)
  }
  return { gone, moved, extra, expected, present: expected - gone.length }
}

/** 跑一次只读自检（永不抛错；树不对宁可不判）。opts 仅供测试注入安装根与护栏阈值。 */
export async function runSeamScan(
  version: string,
  opts: { root?: string; minFiles?: number } = {},
): Promise<SeamScanResult> {
  const mk = (state: SeamScanState, patch: Partial<SeamScanResult> = {}): SeamScanResult => ({
    state,
    version,
    baselineVersion: COMPAT_BASELINE_VERSION,
    scannedFiles: 0,
    expected: 0,
    present: 0,
    gone: [],
    moved: [],
    extra: [],
    ...patch,
  })
  try {
    const root = opts.root ?? findOfficialInstallRoot()
    if (root === null) return mk('skipped', { reason: 'no-root' })
    const { counts, files, truncated } = await scanSeamTree(root)
    const minFiles = opts.minFiles ?? Math.floor(COMPAT_BASELINE_FILES * MIN_SCAN_RATIO)
    if (truncated || files < minFiles) return mk('skipped', { reason: 'tree-shape', scannedFiles: files })
    const v = classifySeams(counts)
    const state: SeamScanState = v.gone.length > 0 ? 'gone' : v.moved.length > 0 ? 'moved' : 'intact'
    return mk(state, { scannedFiles: files, expected: v.expected, present: v.present, gone: v.gone, moved: v.moved, extra: v.extra })
  } catch (err) {
    return mk('failed', { reason: err instanceof Error ? err.message : String(err) })
  }
}

/** 原因码 → 人话（未知码按原文呈现，不吞错）。 */
function seamReasonText(r: SeamScanResult): string {
  if (r.reason === 'no-root') return t('compat.seams.reason.noRoot')
  if (r.reason === 'tree-shape') return t('compat.seams.reason.treeShape', { f: String(r.scannedFiles) })
  return r.reason ?? ''
}

/**
 * 一行结论（设置页「当前适配状态」尾部追加用；null/未触发 → 空串）。
 * 触点 id 最多列 3 个，其余「…」——这行只求一眼可判，明细在「DSH版本适配说明」弹窗同句呈现。
 */
export function seamLineFor(r: SeamScanResult | null | undefined): string {
  if (!r) return ''
  const ids = (list: string[]): string => list.slice(0, 3).join('、') + (list.length > 3 ? '…' : '')
  switch (r.state) {
    case 'gone':
      return t('compat.seams.gone', { k: String(r.gone.length), ids: ids(r.gone) })
    case 'moved': {
      const changed = [...r.moved, ...r.extra]
      return t('compat.seams.moved', { k: String(changed.length), ids: ids(changed) })
    }
    case 'intact': {
      const line = t('compat.seams.intact', { n: String(r.expected), b: r.baselineVersion })
      return r.extra.length > 0 ? `${line}（${t('compat.seams.extra', { k: String(r.extra.length) })}）` : line
    }
    case 'skipped':
      return t('compat.seams.skipped', { why: seamReasonText(r) })
    default:
      return t('compat.seams.failed', { why: seamReasonText(r) })
  }
}
