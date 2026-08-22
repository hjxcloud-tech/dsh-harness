/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync, spawn, type ExecException } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDshRepo } from './detector'
import { t } from './i18n'
import { resolveExec } from './win-exec'

/** 安装结果。 */
export interface InstallResult {
  ok: boolean
  message: string
  /** 安装/识别到的 DSH 仓库目录（成功时存在）。 */
  dir?: string
}

/** 安装选项（测试可注入）。 */
export interface InstallOptions {
  cloneUrl?: string
  exec?: typeof execFile
  hasBin?: (name: string) => boolean
  /** 安装进度回调（克隆中/装依赖中/完成）；percent 为 0–100 进度（可选）。 */
  onStep?: (step: string, percent?: number) => void
}

/** 依赖状态。 */
export interface DepStatus {
  git: boolean
  node: boolean
  pnpm: boolean
}

/** 官方仓库地址（网络受限时可换成 gh-proxy 等镜像）。 */
export const DEFAULT_DSH_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

const CLONE_TIMEOUT_MS = 300_000
const INSTALL_TIMEOUT_MS = 600_000

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(
  exec: typeof execFile,
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  // Windows 下 npm 系命令（npm/pnpm/npx 等）是 .cmd shim，execFile 无法直接启动（ENOENT）→ 经 cmd.exe 包装
  const resolved = resolveExec(process.platform, command, args)
  return new Promise((resolve) => {
    exec(resolved.command, resolved.args, { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) }, (err: ExecException | null, stdout: string, stderr: string) => {
      if (err) {
        resolve({ ok: false, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() })
      } else {
        resolve({ ok: true, out: String(stdout ?? '').trim(), err: '' })
      }
    })
  })
}

let cachedPath: string | undefined

/**
 * 合并子命令可用的 PATH：
 * - Windows：读取注册表 Machine+User 的 PATH 并展开变量（winget 安装后当前会话立即可见，无需重启）；
 * - macOS/Linux：GUI 启动的 Obsidian 继承 launchd 最小 PATH，合并 brew/npm 常见工具目录
 *   （/opt/homebrew/bin、/usr/local/bin 等），否则 brew/nvm 装的 git/node/pnpm 找不到。
 */
function refreshedPath(): string {
  if (cachedPath !== undefined) return cachedPath
  if (process.platform === 'win32') {
    try {
      const script =
        "[Environment]::ExpandEnvironmentVariables(([Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')))"
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      ).trim()
      if (out) cachedPath = out
    } catch {
      // 注册表/PowerShell 不可用时回退当前 PATH
    }
  } else if (process.platform === 'darwin' || process.platform === 'linux') {
    const current = process.env.PATH ?? ''
    const home = process.env.HOME
    const extras = [
      '/opt/homebrew/bin', // Apple Silicon brew
      '/opt/homebrew/sbin',
      '/usr/local/bin', // Intel brew / 常见安装
      '/usr/local/sbin',
      ...(home ? [`${home}/.local/bin`, `${home}/bin`] : []), // pip/用户级工具
    ]
    const merged = [current, ...extras.filter((p) => existsSync(p))].join(':')
    if (merged) cachedPath = merged
  }
  return cachedPath ?? process.env.PATH ?? ''
}

/** 供子命令使用的刷新后环境（含合并 PATH）。 */
function refreshedEnv(): NodeJS.ProcessEnv {
  const path = refreshedPath()
  return { ...process.env, PATH: path, Path: path }
}

function defaultHasBin(name: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    // 用刷新后的 PATH 探测，刚装好的工具无需重启即可识别
    execFileSync(probe, [name], { stdio: 'ignore', env: refreshedEnv() })
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimer(resolve, ms))
}

/**
 * 定时器适配（Obsidian 弹窗兼容要求用 window.*，测试/Node 环境回退全局）：
 * 弹窗（popout）场景下裸 setTimeout 会绑定到错误窗口，统一走 window.*。
 */
const winTimers: Window | undefined = typeof window !== 'undefined' ? window : undefined
type TimerId = number | ReturnType<typeof setTimeout>
function setTimer(fn: () => void, ms: number): TimerId {
  return winTimers ? winTimers.setTimeout(fn, ms) : setTimeout(fn, ms)
}
function clearTimer(id: TimerId): void {
  if (winTimers) winTimers.clearTimeout(id as number)
  else clearTimeout(id as ReturnType<typeof setTimeout>)
}
function setIntervalTimer(fn: () => void, ms: number): TimerId {
  return winTimers ? winTimers.setInterval(fn, ms) : setInterval(fn, ms)
}
function clearIntervalTimer(id: TimerId): void {
  if (winTimers) winTimers.clearInterval(id as number)
  else clearInterval(id as ReturnType<typeof setInterval>)
}

/**
 * 真实执行：spawn `git clone --progress`，流式解析下载百分比（Receiving objects: NN%）。
 * 仅真实模式使用（测试注入 exec 走 run()，保持参数与旧行为一致）。
 */
function cloneWithProgress(
  targetDir: string,
  url: string,
  env: NodeJS.ProcessEnv | undefined,
  onProgress: (pct: number) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      [
        'clone', '--depth', '1', '--progress',
        '--config', 'http.postBuffer=524288000',
        '--config', 'http.lowSpeedLimit=1000',
        '--config', 'http.lowSpeedTime=30',
        url, targetDir,
      ],
      { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    let last = -1
    const timer = setTimer(() => child.kill(), CLONE_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = String(chunk)
      stderr += s
      const m = s.match(/Receiving objects:\s+(\d+)%/)
      if (m) {
        const pct = Number(m[1])
        if (pct !== last) {
          last = pct
          onProgress(pct)
        }
      }
    })
    child.on('error', (err: Error) => {
      clearTimer(timer)
      resolve({ ok: false, out: '', err: err.message })
    })
    child.on('close', (code: number | null) => {
      clearTimer(timer)
      resolve(code === 0 ? { ok: true, out: '', err: '' } : { ok: false, out: '', err: stderr.trim() })
    })
  })
}

/** 真实执行：等待期间周期性上报已用时长（用于 pnpm 这类无百分比的长任务）。 */
async function runWithTicker(
  promise: Promise<RunResult>,
  onStep: (step: string, percent?: number) => void,
  baseStep: string,
  percent: number,
  intervalMs = 5000,
): Promise<RunResult> {
  let elapsed = 0
  const id = setIntervalTimer(() => {
    elapsed += intervalMs
    onStep(`${baseStep}（${Math.round(elapsed / 1000)}s）`, percent)
  }, intervalMs)
  try {
    return await promise
  } finally {
    clearIntervalTimer(id)
  }
}

/**
 * 目录是否可安全清理后重装：
 * 空目录，或仅含 .git（上一次克隆中断留下的残缺克隆）。
 */
function isRescuableDir(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    return entries.length === 0 || (entries.length === 1 && entries[0] === '.git')
  } catch {
    return false
  }
}

/** 检测本机依赖：git / node / pnpm 是否可用。 */
export function checkDeps(opts: { hasBin?: (name: string) => boolean } = {}): DepStatus {
  const hasBin = opts.hasBin ?? defaultHasBin
  return { git: hasBin('git'), node: hasBin('node'), pnpm: hasBin('pnpm') }
}

/**
 * 一键安装缺失依赖：
 * - Windows：winget（git/node/pnpm.pnpm，pnpm 无 Node 也能装；失败退回 npm）；
 *   git/node 的 winget 失败时自动改走 npmmirror 官方镜像（下载安装包静默安装，覆盖 winget 被墙场景）；
 * - macOS：brew（git / node / pnpm；node 公式满足 DSH ^22.19||>=24 的 >=24 分支）；
 * - 其余平台返回手动指引。
 * onStep 可选：真实执行时用 runWithTicker 周期上报已用时，让客户看到安装进度。
 */

/** 比较 x.y.z 版本号：a>b 返回正数，a<b 负数，相等 0。 */
function compareVer(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 拉取 npmmirror 镜像目录列表，解析其中版本最新的匹配安装包文件名；失败返回 null。 */
function resolveMirrorAsset(dirUrl: string, pattern: RegExp): string | null {
  try {
    const out = execFileSync('curl.exe', ['-L', '-sS', dirUrl], { encoding: 'utf8', timeout: 30000 })
    let best: { name: string; ver: string } | null = null
    for (const m of out.matchAll(pattern)) {
      const name = m[0]
      const ver = m[1]?.trim() ?? ''
      if (ver !== '' && (best === null || compareVer(ver, best.ver) > 0)) best = { name, ver }
    }
    return best?.name ?? null
  } catch {
    return null
  }
}

/** curl 下载文件到临时目录；成功且非空返回 true。 */
function downloadViaCurl(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('curl.exe', ['-L', '-sS', '--retry', '2', '-o', dest, url], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => {
      resolve(code === 0 && existsSync(dest) && statSync(dest).size > 0)
    })
  })
}

/** winget 失败后：从 npmmirror 镜像下载 Git for Windows 并静默安装。 */
async function installGitFromMirror(onStep: (step: string, percent?: number) => void): Promise<{ ok: boolean; message: string }> {
  onStep(t('install.depMirror'), 26)
  const dirUrl = 'https://npmmirror.com/mirrors/git-for-windows/'
  const name = resolveMirrorAsset(dirUrl, /Git-(\d+\.\d+\.\d+)-64-bit\.exe/g)
  if (name === null) return { ok: false, message: t('install.depMirrorFail', { err: 'mirror listing' }) }
  const dest = join(tmpdir(), name)
  if (!(await downloadViaCurl(dirUrl + name, dest))) {
    return { ok: false, message: t('install.depMirrorFail', { err: 'download failed' }) }
  }
  try {
    execFileSync(dest, ['/VERYSILENT', '/NORESTART', '/SP-'], { timeout: 600000 })
    return { ok: true, message: t('dep.git.installedMirror') }
  } catch (err) {
    return { ok: false, message: t('install.depMirrorFail', { err: err instanceof Error ? err.message : String(err) }) }
  }
}

/** winget 失败后：从 npmmirror 镜像下载 Node.js LTS（当前 latest-v22.x 主线）并静默安装。 */
async function installNodeFromMirror(onStep: (step: string, percent?: number) => void): Promise<{ ok: boolean; message: string }> {
  onStep(t('install.depMirror'), 32)
  const dirUrl = 'https://npmmirror.com/mirrors/node/latest-v22.x/'
  const name = resolveMirrorAsset(dirUrl, /node-v(\d+\.\d+\.\d+)-x64\.msi/g)
  if (name === null) return { ok: false, message: t('install.depMirrorFail', { err: 'mirror listing' }) }
  const dest = join(tmpdir(), name)
  if (!(await downloadViaCurl(dirUrl + name, dest))) {
    return { ok: false, message: t('install.depMirrorFail', { err: 'download failed' }) }
  }
  try {
    execFileSync('msiexec.exe', ['/i', dest, '/qn', '/norestart'], { timeout: 600000 })
    return { ok: true, message: t('dep.node.installedMirror') }
  } catch (err) {
    return { ok: false, message: t('install.depMirrorFail', { err: err instanceof Error ? err.message : String(err) }) }
  }
}

export async function installDependency(
  dep: keyof DepStatus,
  opts: { exec?: typeof execFile; onStep?: (step: string, percent?: number) => void } = {},
): Promise<{ ok: boolean; message: string }> {
  const exec = opts.exec ?? execFile
  const onStep = opts.onStep ?? (() => undefined)
  // 仅真实 exec 时启用 PATH 刷新与用时进度（测试注入的 exec 保持原样）
  const env = opts.exec ? undefined : refreshedEnv()
  const ticked = (promise: Promise<RunResult>, pct: number): Promise<RunResult> =>
    opts.exec ? promise : runWithTicker(promise, onStep, t('install.autoDep', { dep }), pct)

  if (process.platform === 'win32') {
    if (dep === 'git') {
      const r = await ticked(run(exec, 'winget', ['install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], 600_000, env), 8)
      if (r.ok) return { ok: true, message: t('dep.git.installed') }
      // winget 失败 → npmmirror 镜像兜底（真实执行时下载安装包静默装）
      if (!opts.exec) {
        const m = await installGitFromMirror(onStep)
        if (m.ok) return m
        return { ok: false, message: t('dep.git.fail', { err: r.err || m.message || t('err.unknown') }) }
      }
      return { ok: false, message: t('dep.git.fail', { err: r.err || t('err.unknown') }) }
    }
    if (dep === 'node') {
      const r = await ticked(run(exec, 'winget', ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], 600_000, env), 16)
      if (r.ok) return { ok: true, message: t('dep.node.installed') }
      // winget 失败 → npmmirror 镜像兜底（真实执行时下载安装包静默装）
      if (!opts.exec) {
        const m = await installNodeFromMirror(onStep)
        if (m.ok) return m
        return { ok: false, message: t('dep.node.fail', { err: r.err || m.message || t('err.unknown') }) }
      }
      return { ok: false, message: t('dep.node.fail', { err: r.err || t('err.unknown') }) }
    }
    // pnpm：优先 winget（不依赖 node/npm，无 node 也能装）；winget 失败时退回 npm
    const w = await ticked(run(exec, 'winget', ['install', '--id', 'pnpm.pnpm', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], 600_000, env), 24)
    if (w.ok) {
      return { ok: true, message: t('dep.pnpm.installed') }
    }
    const r = await ticked(run(exec, 'npm', ['install', '-g', 'pnpm'], 600_000, env), 24)
    return r.ok
      ? { ok: true, message: t('dep.pnpm.installed') }
      : { ok: false, message: t('dep.pnpm.fail', { err: r.err || t('err.unknown') }) }
  }

  // macOS：brew 一键安装（需本机已装 brew；未装时错误信息会提示）
  if (process.platform === 'darwin') {
    const formula = dep === 'git' ? 'git' : dep === 'node' ? 'node' : 'pnpm'
    const r = await ticked(run(exec, 'brew', ['install', formula], 600_000, env), 24)
    return r.ok
      ? { ok: true, message: t('dep.brew.installed', { dep }) }
      : { ok: false, message: t('dep.brew.fail', { dep, err: r.err.split('\n')[0] || t('err.unknown'), formula }) }
  }

  const hints: Record<keyof DepStatus, string> = {
    git: 'macOS: brew install git；Linux: sudo apt install git',
    node: t('dep.hint.node'),
    pnpm: t('dep.hint.pnpm'),
  }
  return { ok: false, message: t('dep.manual', { hint: hints[dep] }) }
}

/**
 * 一键安装 DeepSeek Harness 本体：
 * 1. 目标目录已是 DSH 仓库 → 复用，并补齐缺失依赖（git/node/pnpm）与全局 CLI（dsh）；
 * 2. 否则 git 浅克隆官方仓库到目标目录（含缺失依赖 git/node/pnpm 的一键安装）；
 * 3. pnpm 可用时安装依赖（失败不阻塞，提示手动安装）；
 * 4. `pnpm run build` 构建仓库产物（DSH 官方要求，源码运行必需；失败返回失败并提示）；
 * 5. 全局安装 `@deepseek-ai/dsh` CLI（已有则跳过；失败不阻断，提示手动）；
 * 6. 校验为 DSH 仓库后返回目录。
 */

/** 补齐缺失依赖（git / node / pnpm）。真实执行时一键安装；返回错误消息（空串=成功）。 */
async function ensureDeps(
  exec: typeof execFile,
  hasBin: (n: string) => boolean,
  env: NodeJS.ProcessEnv | undefined,
  onStep: (step: string, percent?: number) => void,
  opts: { exec?: typeof execFile },
): Promise<string> {
  if (opts.exec) return '' // 测试注入 exec 时不触碰系统依赖
  const depPct: Record<string, number> = { git: 8, node: 16, pnpm: 24 }
  for (const dep of ['git', 'node', 'pnpm'] as const) {
    if (!hasBin(dep)) {
      onStep(t('install.autoDep', { dep }), depPct[dep])
      const r = await installDependency(dep, { onStep })
      if (!r.ok) return r.message
      if (!hasBin(dep)) return t('install.depStillMissing', { dep })
    }
  }
  return ''
}

/** 全局安装 DSH CLI（`npm i -g @deepseek-ai/dsh@latest`，官方源失败切 npmmirror）；已有 dsh 则跳过。返回提示（空串=无需安装）。 */
async function ensureCli(
  exec: typeof execFile,
  hasBin: (n: string) => boolean,
  env: NodeJS.ProcessEnv | undefined,
  onStep: (step: string, percent?: number) => void,
  opts: { exec?: typeof execFile },
): Promise<string> {
  if (hasBin('dsh')) return ''
  onStep(t('install.cliInstalling'), 92)
  const runCli = (extra: string[]): Promise<RunResult> =>
    run(exec, 'npm', ['install', '-g', '@deepseek-ai/dsh@latest', '--no-fund', '--no-audit', ...extra], INSTALL_TIMEOUT_MS, env)
  let cli = opts.exec
    ? await runCli([])
    : await runWithTicker(runCli([]), onStep, t('install.cliInstalling'), 94)
  if (!cli.ok) {
    cli = await runCli(['--registry', 'https://registry.npmmirror.com'])
  }
  return cli.ok ? t('install.cliDone') : t('install.cliFail', { err: cli.err.split('\n')[0] || t('err.failed') })
}

export async function installDsh(
  targetDir: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const exec = opts.exec ?? execFile
  const hasBin = opts.hasBin ?? defaultHasBin
  const cloneUrl = opts.cloneUrl ?? DEFAULT_DSH_REPO_URL
  const onStep = opts.onStep ?? (() => undefined)
  // 仅真实 exec 时启用 PATH 刷新（测试注入的 exec 保持原样）
  const env = opts.exec ? undefined : refreshedEnv()
  if (!targetDir) {
    return { ok: false, message: t('install.dirEmpty') }
  }

  // 已存在且是 DSH 仓库：复用；仍补齐缺失依赖与全局 CLI（用户已有 DSH 但缺工具时自动配齐）
  if (existsSync(targetDir) && isDshRepo(targetDir)) {
    const depErr = await ensureDeps(exec, hasBin, env, onStep, opts)
    if (depErr) {
      return { ok: false, message: depErr, dir: targetDir }
    }
    const cliNote = await ensureCli(exec, hasBin, env, onStep, opts)
    return { ok: true, message: t('install.found', { dir: targetDir }) + (cliNote ? ' ' + cliNote : ''), dir: targetDir }
  }
  // 已存在但不是 DSH 仓库：仅当为「空目录/仅含 .git 的残缺克隆」时才清理重装，否则拒绝覆盖
  if (existsSync(targetDir)) {
    if (isRescuableDir(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    } else {
      return {
        ok: false,
        message: t('install.notDsh', { dir: targetDir }),
      }
    }
  }

  // 真实执行时：一键补齐缺失依赖（git / node / pnpm），无需用户单独安装；长步骤带用时进度
  const depErr = await ensureDeps(exec, hasBin, env, onStep, opts)
  if (depErr) {
    return { ok: false, message: depErr }
  }

  // 克隆：官方直连优先，失败自动切 gh-proxy.com 镜像重试一次（本机实测官方源在部分网络下连不通）
  onStep(t('install.downloading'), 30)
  const mirrorUrl = `https://gh-proxy.com/${cloneUrl}`
  const cloneAttempts = [cloneUrl, mirrorUrl]
  const cloneArgs = (url: string): string[] => [
    'clone', '--depth', '1',
    '--config', 'http.postBuffer=524288000',
    '--config', 'http.lowSpeedLimit=1000',
    '--config', 'http.lowSpeedTime=30',
    url, targetDir,
  ]
  let clone: RunResult | null = null
  let lastErr = ''
  for (let i = 0; i < cloneAttempts.length; i++) {
    if (i > 0) {
      onStep(t('install.mirrorRetry', { n: i }), 28)
      await delay(2000)
    }
    // 真实执行：spawn 流式解析 git 下载百分比；测试注入 exec 走原 execFile 路径
    const r = opts.exec
      ? await run(exec, 'git', cloneArgs(cloneAttempts[i]), CLONE_TIMEOUT_MS, env)
      : await cloneWithProgress(targetDir, cloneAttempts[i], env, (pct) => {
          onStep(t('install.downloading'), Math.round(30 + pct * 0.3))
        })
    if (r.ok && existsSync(targetDir) && isDshRepo(targetDir)) {
      clone = r
      break
    }
    lastErr = r.err.split('\n')[0] || `${t('err.failed')}（第 ${i + 1} 次尝试）`
    // 清理残缺目录，避免下次被「目录已存在」拦截
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
  }
  if (!clone) {
    return {
      ok: false,
      message: t('install.cloneFailed', { err: lastErr }),
    }
  }

  // 安装依赖（可选步骤，失败不阻塞；首次失败用淘宝 npmmirror 源重试一次；真实执行带用时进度）
  let depsNote = ''
  if (hasBin('pnpm')) {
    onStep(t('install.depsInstalling'), 65)
    const runInstall = (extra: string[]): Promise<RunResult> =>
      run(exec, 'pnpm', ['-C', targetDir, 'install', ...extra], INSTALL_TIMEOUT_MS, env)
    let install = opts.exec
      ? await runInstall([])
      : await runWithTicker(runInstall([]), onStep, t('install.depsInstalling'), 70)
    if (!install.ok) {
      onStep(t('install.depsMirror'), 60)
      install = opts.exec
        ? await runInstall(['--registry', 'https://registry.npmmirror.com'])
        : await runWithTicker(
            runInstall(['--registry', 'https://registry.npmmirror.com']),
            onStep,
            t('install.depsInstalling'),
            70,
          )
    }
    if (!install.ok) {
      depsNote = t('install.depsNoteFail', { err: install.err.split('\n')[0] || t('err.failed'), dir: targetDir })
    }
  } else {
    depsNote = t('install.depsNoteNoPnpm')
  }

  // 构建（DSH 官方要求：从仓库源码运行前必须 pnpm run build，否则启动会因缺少构建产物失败）
  if (hasBin('pnpm')) {
    onStep(t('install.buildStep'), 75)
    const runBuild = (): Promise<RunResult> => run(exec, 'pnpm', ['-C', targetDir, 'run', 'build'], INSTALL_TIMEOUT_MS, env)
    const build = opts.exec
      ? await runBuild()
      : await runWithTicker(runBuild(), onStep, t('install.buildStep'), 85)
    if (!build.ok) {
      return {
        ok: false,
        message: t('install.buildFail', { err: build.err.split('\n')[0] || t('err.failed'), dir: targetDir }),
      }
    }
  }

  // 全局 CLI（配齐依赖的最后一块）：装完用户即可用 `dsh web --port {port}` 直接启动；
  // 失败不阻断安装（仓库形态仍可用），仅追加提示。
  depsNote += await ensureCli(exec, hasBin, env, onStep, opts)

  onStep(t('install.done'), 100)
  return {
    ok: true,
    message: t('install.message', { dir: targetDir, note: depsNote }),
    dir: targetDir,
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
