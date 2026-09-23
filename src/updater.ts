/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './i18n'
import { isOfficialDshCheckout, readDshPackageIdentity, readPackageName } from './dsh-identity'
import { resolveExec } from './win-exec'

/** 更新检查结果。 */
export interface UpdateCheckResult {
  state: 'up-to-date' | 'behind' | 'error'
  message: string
  pullCommand: string
  /** 是否因「远端只有预发布（rc）且比本地新」而判定 behind——需弹风险确认框。 */
  prerelease?: boolean
  /** 目标版本号（语义化版本或 7 位哈希）——供「新版 DSH 与插件不适配」红字警告判定。 */
  remoteVersion?: string
}

/** 目标版本兼容性判定（v2.4.0 放开钉住后取代「一律劝退」策略）。 */
export type DshTargetClass = 'supported' | 'known-incompatible' | 'unknown'

/**
 * 插件适配策略（v2.4.0）：
 * - ≤0.1.1 系：旧版可用（历史钉住版本）；
 * - 0.1.2–0.1.4：已知不兼容（浏览器会话认证叠加当时的上游会话缓存/列表缺陷）→ 红字劝退；
 * - ≥0.1.5：已实测适配（隔离矩阵 11/11 + 沙盒 UI 6/6 + 真机）；
 * - 哈希/master 形态：无从判定 → 中性处理。
 */
export const DSH_MIN_SUPPORTED = '0.1.5-rc.1'
export const DSH_LEGACY_SUPPORTED_MAX: readonly [number, number, number] = [0, 1, 1]
export const DSH_KNOWN_INCOMPATIBLE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 1, 4],
]

/** 解析核心三元组；非 x.y.z 形态（含 7 位哈希）返回 null。 */
export function parseCoreTriple(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim().toLowerCase())
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 核心三元组比较：a>b 返回正数，a<b 返回负数。 */
function compareTriple(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** 目标版本分类（决定更新弹窗措辞与一键安装目标）。 */
export function classifyDshTarget(remoteVersion: string): DshTargetClass {
  const v = remoteVersion.trim()
  if (v === '') return 'unknown'
  const core = parseCoreTriple(v)
  if (core === null) return 'unknown'
  for (const bad of DSH_KNOWN_INCOMPATIBLE) {
    if (compareTriple(core, bad) === 0) return 'known-incompatible'
  }
  if (compareTriple(core, DSH_LEGACY_SUPPORTED_MAX) <= 0) return 'supported'
  const min = parseCoreTriple(DSH_MIN_SUPPORTED)
  if (min === null) return 'unknown'
  return compareTriple(core, min) >= 0 ? 'supported' : 'unknown'
}

/** 该版本是否落在已知不兼容区间（一键安装/升级的守卫用）。 */
export function isKnownIncompatibleDsh(version: string): boolean {
  return classifyDshTarget(version) === 'known-incompatible'
}

/**
 * 更新通道（v2.6.0 重开自动更新）。DSH 长期只发预发布 tag（正式版尚未发布），
 * 旧策略「仅正式版可更新」等于把更新功能关掉，故改为显式三档，默认 `preview`。
 * - `stable`：只认无后缀正式版（官方发正式版前的行为，等于不更新）；
 * - `preview`：正式版 + beta + rc（官方主推通道，npm 的 latest/next 都落在这一档）；
 * - `dev`：再加 alpha（最激进，含未主推的试验版）。
 */
export type UpdateChannel = 'stable' | 'preview' | 'dev'
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['stable', 'preview', 'dev']
/** 默认通道：跟随官方当前主推版本（含 rc）。 */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'preview'

/** 通道值归一（脏 data.json / 未知值退回默认通道）。 */
export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value)
    ? (value as UpdateChannel)
    : DEFAULT_UPDATE_CHANNEL
}

/** 该版本是否被通道接纳。无法解析的版本一律不收。 */
export function channelAllows(channel: UpdateChannel, version: string): boolean {
  const p = parseVersion(version)
  if (p === null) return false
  if (p.prerelease === null) return true
  if (channel === 'dev') return true
  if (channel === 'preview') return p.prerelease.kind === 'rc' || p.prerelease.kind === 'beta'
  return false
}

/** 从版本列表中按通道挑出「可接纳的最新版本」；一个都没有返回 null。 */
export function pickBestVersion(versions: readonly string[], channel: UpdateChannel): string | null {
  let best: string | null = null
  for (const v of versions) {
    if (!channelAllows(channel, v)) continue
    if (best === null || compareVersions(v, best) > 0) best = v
  }
  return best
}

/** 从 git ls-remote 的 tags 输出中收集全部可解析 tag 版本号。 */
function collectTagVersions(output: string): string[] {
  const found: string[] = []
  for (const line of output.split('\n')) {
    const v = extractTagVersion(line)
    if (v !== null && parseVersion(v) !== null) found.push(v)
  }
  return found
}

/**
 * 目标版本是否需要红字警告（等价于「已知不兼容」；保留旧名以兼容既有调用与测试）。
 */
export function needsBrowserAuthWarning(remoteVersion: string): boolean {
  return classifyDshTarget(remoteVersion) === 'known-incompatible'
}

/** 执行更新结果。 */
export interface PullResult {
  ok: boolean
  message: string
}

/** git 命令执行器（测试可注入）。 */
export type ExecFileFn = typeof execFile

/** 更新选项：只读镜像（官方 GitHub 被墙/不可达时的兜底源）与更新通道。 */
export interface UpdateOptions {
  /** 只读镜像地址（如 gh-proxy.com 前缀）；提供时官方源失败会自动用镜像重试。 */
  mirrorUrl?: string
  /**
   * 本机是否存在全局 CLI 形态的 DSH（`dsh` 在 PATH 上）。
   * 缺省自动检测（where/which dsh）；测试可注入以保持确定性。
   */
  globalDsh?: boolean
  /** 更新通道（v2.6.0）：stable=仅正式版 / preview=正式版+beta+rc（默认） / dev=再加 alpha。缺省按默认通道。 */
  channel?: UpdateChannel
}

/** 检测全局 CLI 形态的 DSH（`dsh` 在 PATH）：存在返回 true。 */
export function hasGlobalDsh(): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(probe, ['dsh'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(exec: ExecFileFn, args: string[], timeoutMs = 30000): Promise<RunResult> {
  return new Promise((resolve) => {
    exec('git', args, { timeout: timeoutMs, windowsHide: true }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        resolve({ ok: false, out: '', err: String(stderr ?? '').trim() })
      } else {
        resolve({ ok: true, out: String(stdout).trim(), err: '' })
      }
    })
  })
}

/**
 * 读取 DSH 仓库本地版本号（v2.6.1：先核验**包名身份**再取版本）：
 * - package.json 属官方本体（`@deepseek-ai/dsh` / `@deepseek-ai/dsh-root` / 历史名 `deepseek-harness`）→ 用其 version；
 * - package.json 存在但包名不是官方（实测存在 `@x1a0f3n9/dsh-web-app` 之类第三方包，版本号自成一套）
 *   → 一律 `未知`：**绝不把第三方包的版本当 DSH 版本**；
 * - 没有 package.json / 解析不出名字 → 无从核验，退回 HEAD 短哈希（旧行为；上游 `isDshRepo` 已把非官方目录挡掉）。
 */
export async function getLocalDshVersion(repoDir: string, exec: ExecFileFn = execFile): Promise<string> {
  const identity = readDshPackageIdentity(repoDir)
  if (identity !== null && identity.version !== '') return identity.version
  if (contradictsOfficialIdentity(repoDir)) return t('up.unknown')
  const r = await run(exec, ['-C', repoDir, 'rev-parse', 'HEAD'])
  return r.ok && r.out ? r.out.slice(0, 7) : t('up.unknown')
}

/** 目录里有 package.json 且带包名，但包名不属官方本体（也不像官方源码检出）→ 身份被**反证**。 */
function contradictsOfficialIdentity(dir: string): boolean {
  if (readDshPackageIdentity(dir) !== null) return false
  const name = readPackageName(dir)
  return name !== '' && !isOfficialDshCheckout(dir)
}

/** 从 git 输出中提取首个 tag 版本号（形如 refs/tags/dsh-v0.1.0-rc.7 → 0.1.0-rc.7）。 */
function extractTagVersion(line: string): string | null {
  // 行格式：<sha>\trefs/tags/<tag>（排除 ^{} 等 peeled 行）
  const m = /refs\/tags\/[^^]*?([0-9]+\.[0-9]+\.[0-9]+[\w.-]*)$/.exec(line)
  return m ? m[1] : null
}

/** 预发布类型（同核心号时的成熟度排序：alpha < beta < rc < 正式版）。 */
type PrereleaseKind = 'alpha' | 'beta' | 'rc'

/** 解析版本号：核心 x.y.z + 预发布（-alpha.N / -beta.N / -rc.N，可缺省）。无法解析返回 null。 */
function parseVersion(v: string): { core: number[]; prerelease: { kind: PrereleaseKind; num: number } | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?/.exec(v.trim())
  if (!m) return null
  const pre = m[4] !== undefined ? { kind: m[4] as PrereleaseKind, num: Number(m[5]) } : null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: pre }
}

/** 预发布/正式版排序权重（越大越新）。 */
const PRE_ORDER: Record<string, number> = { alpha: 0, beta: 1, rc: 2, stable: 3 }

/** 是否为正式版（无 -alpha/-beta/-rc 等预发布后缀）。 */
export function isStableVersion(v: string): boolean {
  const p = parseVersion(v)
  return p !== null && p.prerelease === null
}

/** 语义化版本比较：核心数字逐段比，同核心时预发布按 alpha<beta<rc<正式 排序（序号越大越新）。返回 a>b?1 : a<b?-1 : 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1
  }
  const ka = PRE_ORDER[pa.prerelease?.kind ?? 'stable']
  const kb = PRE_ORDER[pb.prerelease?.kind ?? 'stable']
  if (ka !== kb) return ka > kb ? 1 : -1
  if (pa.prerelease === null && pb.prerelease === null) return 0
  if (pa.prerelease === null) return 1
  if (pb.prerelease === null) return -1
  if (pa.prerelease.num !== pb.prerelease.num) return pa.prerelease.num > pb.prerelease.num ? 1 : -1
  return 0
}

/**
 * 从 git ls-remote 输出中挑出通道内最新版本（v2.6.0：取代旧的「仅正式版」两道筛选）。
 */
function bestTagVersion(output: string, channel: UpdateChannel): string | null {
  return pickBestVersion(collectTagVersions(output), channel)
}

/**
 * 检查 DSH 更新：本地 package.json 版本 vs 远端 tags 中**指定通道**的最新版本
 * （v2.6.0 通道化：stable 只认正式版、preview 认 rc/beta、dev 再加 alpha）；
 * 本地无可解析版本号时回退提交哈希比较。只读检测，不修改仓库。官方源不可达时自动改用只读镜像。
 */
export async function checkDshUpdates(
  repoDir: string,
  exec: ExecFileFn = execFile,
  opts: UpdateOptions = {},
): Promise<UpdateCheckResult> {
  const pullCommand = `cd "${repoDir}" && git pull`
  if (!repoDir || !existsSync(join(repoDir, '.git'))) {
    return {
      state: 'error',
      message: t('up.noRepo'),
      pullCommand,
    }
  }

  // v2.6.1：本地版本先过**包名身份**——第三方 dsh 相关包（如 `@x1a0f3n9/dsh-web-app`，版本号自成一套）
  // 不得当本体版本参与比较；没有 package.json 时无从核验，仍走哈希比较（上游 isDshRepo 已把非官方目录挡掉）。
  const identity = readDshPackageIdentity(repoDir)
  if (contradictsOfficialIdentity(repoDir)) {
    return { state: 'error', message: t('up.noRepo'), pullCommand }
  }
  const localVersion: string | null = identity !== null && identity.version !== '' ? identity.version : null
  let localHash = ''
  const local = await run(exec, ['-C', repoDir, 'rev-parse', 'HEAD'])
  if (local.ok && local.out) {
    localHash = local.out.trim()
  } else if (!localVersion) {
    return { state: 'error', message: t('up.noLocal'), pullCommand }
  }

  // 远端 tags（正式版本来源）；失败时尝试只读镜像
  let tags = await run(exec, ['-C', repoDir, 'ls-remote', '--tags', 'origin'], 45000)
  let mirrorTried = false
  if ((!tags.ok || !tags.out) && opts.mirrorUrl) {
    mirrorTried = true
    tags = await run(exec, ['-C', repoDir, 'ls-remote', '--tags', opts.mirrorUrl], 45000)
  }
  if (!tags.ok) {
    const err = tags.err || t('err.unknown')
    return {
      state: 'error',
      message: t('up.githubFail', { err }) + (mirrorTried ? t('up.mirrorFail', { err }) : ''),
      pullCommand,
    }
  }
  const channel = normalizeUpdateChannel(opts.channel)
  const remoteVersion = bestTagVersion(tags.out, channel)

  // 通道内没有任何可用 tag（如通道=stable 而官方只有预发布）→ 视为已是最新，并说明原因。
  if (remoteVersion === null) {
    return {
      state: 'up-to-date',
      message: t('up.stableOnly', { v: localVersion ?? localHash }),
      pullCommand,
    }
  }

  // 双方都有可解析版本号 → 按版本比较；否则回退哈希比较
  if (localVersion) {
    if (compareVersions(localVersion, remoteVersion) >= 0) {
      return { state: 'up-to-date', message: t('up.latest', { v: localVersion }), pullCommand }
    }
    return {
      state: 'behind',
      prerelease: !isStableVersion(remoteVersion),
      message: t(channel === 'stable' ? 'up.behindVer' : 'up.prereleaseBehind', { local: localVersion, remote: remoteVersion }),
      pullCommand,
      remoteVersion,
    }
  }

  // 回退：远端 HEAD 哈希 vs 本地 HEAD 哈希
  let remote = await run(exec, ['-C', repoDir, 'ls-remote', 'origin', 'HEAD'], 45000)
  if ((!remote.ok || !remote.out) && opts.mirrorUrl) {
    remote = await run(exec, ['-C', repoDir, 'ls-remote', opts.mirrorUrl, 'HEAD'], 45000)
  }
  if (!remote.ok || !remote.out) {
    const err = remote.err || t('err.unknown')
    return {
      state: 'error',
      message: t('up.githubFail', { err }) + (mirrorTried ? t('up.mirrorFail', { err }) : ''),
      pullCommand,
    }
  }
  const remoteShort = remote.out.split(/\s+/)[0]?.slice(0, 7) ?? ''
  if (localHash.slice(0, 7) === remoteShort) {
    return { state: 'up-to-date', message: t('up.latest', { v: localHash.slice(0, 7) }), pullCommand }
  }
  return {
    state: 'behind',
    message: t('up.behind', { local: localHash.slice(0, 7), remote: remoteShort }),
    pullCommand,
    remoteVersion: remoteShort,
  }
}

/**
 * 执行 DSH 仓库更新：git pull --ff-only（快进式，不产生本地合并；
 * 本地有未提交改动时会失败并提示，避免覆盖用户改动）。官方源失败时自动改用只读镜像。
 */
export async function pullDshUpdates(
  repoDir: string,
  exec: ExecFileFn = execFile,
  opts: UpdateOptions = {},
): Promise<PullResult> {
  let pull = await run(exec, ['-C', repoDir, 'pull', '--ff-only', '--quiet'])
  let mirrorTried = false
  if (!pull.ok && opts.mirrorUrl) {
    mirrorTried = true
    pull = await run(exec, ['-C', repoDir, 'pull', '--ff-only', '--quiet', opts.mirrorUrl])
  }
  if (pull.ok) {
    return {
      ok: true,
      message: t('up.done', { dir: repoDir }),
    }
  }
  // 失败原因细分：本地未提交改动会阻塞 ff-only 合并——给出可操作指引（列出改动文件），而非笼统报错
  const dirty = await localDirtyFiles(repoDir, exec)
  if (dirty.length > 0) {
    const list = dirty.slice(0, 5).join('、') + (dirty.length > 5 ? ` 等 ${dirty.length} 个文件` : '')
    return {
      ok: false,
      message: t('up.dirty', { files: list }) + (mirrorTried ? t('up.mirrorFail', { err: pull.err || t('err.unknown') }) : ''),
    }
  }
  // 分叉检测：ff-only 失败时，若本地有未推送提交，给出友好提示而非笼统报错
  const ahead = await countLocalAhead(repoDir, exec)
  const diverged = ahead > 0
  const err = pull.err || t('err.unknown')
  return {
    ok: false,
    message: (diverged ? t('up.diverged', { count: String(ahead) }) : t('up.fail', { err })) + (mirrorTried ? t('up.mirrorFail', { err }) : ''),
  }
}

/** 列出仓库内未提交改动（modified + untracked，最多 20 条）；非 git 仓库或出错返回空数组。 */
async function localDirtyFiles(repoDir: string, exec: ExecFileFn): Promise<string[]> {
  const r = await run(exec, ['-C', repoDir, 'status', '--short'], 15000)
  if (!r.ok || !r.out) return []
  return r.out
    .split('\n')
    .map((line) => line.trim().replace(/^[ MADRCU?!]{1,2}\s+/, ''))
    .filter(Boolean)
    .slice(0, 20)
}

/** 统计本地领先远端（未推送）的提交数；非 git 仓库或出错返回 0。 */
async function countLocalAhead(repoDir: string, exec: ExecFileFn): Promise<number> {
  // rev-list --count origin/<HEAD branch>..HEAD；未知分支名时跳过
  const branch = await run(exec, ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch.ok || !branch.out || branch.out === 'HEAD') return 0
  const upstream = await run(exec, ['-C', repoDir, 'rev-parse', '--abbrev-ref', `${branch.out}@{upstream}`])
  if (!upstream.ok || !upstream.out) return 0
  const count = await run(exec, ['-C', repoDir, 'rev-list', '--count', `${upstream.out}..HEAD`])
  if (!count.ok) return 0
  const n = Number(count.out.trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ---------------------------------------------------------------------------
// 全局 CLI 形态（`dsh web` 启动）的版本显示与更新：
// 仓库形态走 git 检测；CLI 形态本地版本取 `dsh --version`，远端取 npm dist-tags.latest，
// 更新动作 = `npm i -g @deepseek-ai/dsh@latest`（官方 registry 失败自动切 npmmirror）。
// ---------------------------------------------------------------------------

/** npm registry：npmmirror 优先（大陆网络下载稳定），官方兜底。 */
const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

/** DSH 官方仓库（GitHub 直连失败时走 gh-proxy 只读镜像），仅用于探测 tag。 */
const DSH_GITHUB_URLS = [
  'https://github.com/deepseek-ai/deepseek-harness.git',
  'https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git',
]

/**
 * 探测 GitHub 上比 local 更新的 tag（含未发布到 npm 的预发布版本）。
 * 仅用于「已是最新（npm 通道）」提示的补充说明，避免用户误以为漏检；
 * 任何失败（网络/无更新）静默返回 null，不影响主流程。
 */
async function probeGithubTagNewer(local: string, exec: ExecFileFn = execFile): Promise<string | null> {
  for (const url of DSH_GITHUB_URLS) {
    const r = await run(exec, ['ls-remote', '--tags', url], 30000)
    if (!r.ok || !r.out) continue
    let best: string | null = null
    for (const line of r.out.split('\n')) {
      const v = extractTagVersion(line)
      if (v && compareVersions(v, local) > 0 && (best === null || compareVersions(v, best) > 0)) best = v
    }
    if (best !== null) return best
  }
  return null
}

/** 通用命令执行器（Windows 下 npm 系命令经 cmd.exe 包装；与 git 专用 run() 区分）。 */
function runCmd(exec: ExecFileFn, command: string, args: string[], timeoutMs = 30000): Promise<RunResult> {
  return new Promise((resolve) => {
    const resolved = resolveExec(process.platform, command, args)
    exec(resolved.command, resolved.args, { timeout: timeoutMs, windowsHide: true }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        resolve({ ok: false, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() })
      } else {
        resolve({ ok: true, out: String(stdout ?? '').trim(), err: '' })
      }
    })
  })
}

/** 读取全局 CLI 的本地版本（`dsh --version`，约 350ms）；失败返回 ''。 */
export async function getCliDshVersion(exec: ExecFileFn = execFile): Promise<string> {
  const r = await runCmd(exec, 'dsh', ['--version'], 15000)
  return r.ok ? (r.out.split(/\r?\n/)[0] ?? '').trim() : ''
}

/** npm 上本包的全部 dist-tag（npmmirror 优先、官方兜底）；取不到返回空对象。 */
async function getNpmDistTags(exec: ExecFileFn): Promise<Record<string, string>> {
  for (const reg of NPM_REGISTRIES) {
    const r = await runCmd(exec, 'npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json', '--registry', reg], 30000)
    if (!r.ok || r.out === '') continue
    try {
      const parsed: unknown = JSON.parse(r.out)
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
        }
        if (Object.keys(out).length > 0) return out
      }
    } catch {
      // 非 JSON（老版 npm 或代理改写）→ 换下一个源
    }
  }
  return {}
}

/** 读取 npm 上 @deepseek-ai/dsh 的 latest 版本（dist-tags 取不到时的兜底）；失败返回 ''。 */
async function getNpmLatest(exec: ExecFileFn): Promise<string> {
  for (const reg of NPM_REGISTRIES) {
    const r = await runCmd(exec, 'npm', ['view', '@deepseek-ai/dsh', 'dist-tags.latest', '--registry', reg], 30000)
    if (r.ok && r.out !== '') {
      return (r.out.split(/\r?\n/)[0] ?? '').trim()
    }
  }
  return ''
}

/**
 * 按通道挑出 npm 上的目标版本（v2.6.0 重开自动更新）。
 * DSH 目前只发预发布（`latest` 本身就是 rc），旧实现只认 `dist-tags.latest` 且要求正式版，
 * 等于永远「暂无正式版可更新」——这里改为读全部 dist-tag，按通道取最新可接纳版本。
 */
export async function pickNpmTarget(exec: ExecFileFn, channel: UpdateChannel): Promise<string> {
  const tags = await getNpmDistTags(exec)
  const values = Object.values(tags)
  if (values.length > 0) {
    const best = pickBestVersion(values, channel)
    if (best !== null) return best
    // 通道比 npm 上所有 dist-tag 都保守（例如 stable 而官方只有 rc）→ 无目标
    return ''
  }
  // dist-tags 读不到：退回旧的 latest 单标签路径（stable 通道下 latest 是 rc 时仍视为无目标）
  const latest = await getNpmLatest(exec)
  if (latest === '') return ''
  return channelAllows(channel, latest) ? latest : ''
}

/**
 * 检查全局 CLI 更新：本地 `dsh --version` vs 指定通道的 npm 目标版本；更新动作 = `npm i -g @deepseek-ai/dsh@<版本>`。
 * 目标按**具体版本号**钉住（不用 `@latest`），避免确认框显示 A 却装上 B。
 */
export async function checkCliUpdate(exec: ExecFileFn = execFile, channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL): Promise<UpdateCheckResult> {
  const pullCommand = 'npm i -g @deepseek-ai/dsh@latest'
  const local = await getCliDshVersion(exec)
  if (!local) {
    return { state: 'error', message: t('up.noLocal'), pullCommand }
  }
  const remote = await pickNpmTarget(exec, channel)
  if (!remote) {
    // 区分「连不上源」与「通道内确实没有可更新的版本」：后者不该报错误
    const anyTag = Object.keys(await getNpmDistTags(exec)).length > 0 || (await getNpmLatest(exec)) !== ''
    if (anyTag) {
      return { state: 'up-to-date', message: t('up.stableOnly', { v: local }), pullCommand }
    }
    return { state: 'error', message: t('up.githubFail', { err: 'npm registry unreachable' }), pullCommand }
  }
  const pinned = `npm i -g @deepseek-ai/dsh@${remote}`
  if (compareVersions(local, remote) >= 0) {
    // 已是最新（按 npm 官方推送版本检测）：补充说明 GitHub 是否有未发布到 npm 的预览 tag，
    // 避免用户误以为「GitHub 更新了但插件没检测出来」
    const githubNewer = await probeGithubTagNewer(local, exec)
    const message =
      githubNewer === null ? t('up.latest', { v: local }) : t('up.latestNpmOnly', { v: local, github: githubNewer })
    return { state: 'up-to-date', message, pullCommand: pinned }
  }
  return {
    state: 'behind',
    prerelease: !isStableVersion(remote),
    message: t(isStableVersion(remote) ? 'up.behindVer' : 'up.prereleaseBehind', { local, remote }),
    pullCommand: pinned,
    remoteVersion: remote,
  }
}

/**
 * 执行全局 CLI 更新（v2.6.0）：`npm i -g @deepseek-ai/dsh@<版本>`（npmmirror 优先、官方兜底）。
 * @param spec 目标版本号（检查阶段已定版）；缺省退回 `latest` 标签。
 */
export async function pullCliUpdate(exec: ExecFileFn = execFile, spec: string = 'latest'): Promise<PullResult> {
  const target = `@deepseek-ai/dsh@${spec.trim() === '' ? 'latest' : spec.trim()}`
  for (const reg of NPM_REGISTRIES) {
    const r = await runCmd(exec, 'npm', ['install', '-g', target, '--no-fund', '--no-audit', '--registry', reg], 300000)
    if (r.ok) {
      return { ok: true, message: t('up.cliDone') }
    }
  }
  return { ok: false, message: t('up.cliFail', { err: `npm install ${target} failed` }) }
}

/** 可注入的 HTTP GET（测试用假传输）。 */
export type HttpGetFn = (url: string) => Promise<{ ok: boolean; text: string }>

const defaultHttpGet: HttpGetFn = (url) =>
  new Promise((resolve) => {
    execFile('curl.exe', ['-L', '-sS', '--max-time', '25', url], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, text: '' })
      } else {
        resolve({ ok: true, text: String(stdout) })
      }
    })
  })

/** 查询 GitHub release 的 tag 名：`releases/latest` 的 JSON 里取 tag_name。 */
function parseLatestTag(json: string): string | null {
  try {
    const obj = JSON.parse(json) as { tag_name?: unknown }
    return typeof obj.tag_name === 'string' && obj.tag_name !== '' ? obj.tag_name : null
  } catch {
    return null
  }
}

/**
 * 检查插件自身更新：查插件 GitHub 仓库最新 Release tag（官方 API → gh-proxy 镜像兜底），
 * 返回 [远端版本, 是否更新可用]；网络失败返回 null（调用方提示检查失败）。
 */
export async function checkPluginUpdate(
  get: HttpGetFn = defaultHttpGet,
  mirrorBase = 'https://gh-proxy.com/',
): Promise<{ remote: string | null; reachable: boolean }> {
  const urls = [
    `https://api.github.com/repos/hjxcloud-tech/dsh-harness/releases/latest`,
    `${mirrorBase}https://api.github.com/repos/hjxcloud-tech/dsh-harness/releases/latest`,
  ]
  for (const url of urls) {
    const r = await get(url)
    if (r.ok && r.text !== '') {
      const tag = parseLatestTag(r.text)
      if (tag !== null) {
        return { remote: tag.replace(/^v/, ''), reachable: true }
      }
    }
  }
  return { remote: null, reachable: false }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
