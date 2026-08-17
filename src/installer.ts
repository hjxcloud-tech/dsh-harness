/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync, type ExecException } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { isDshRepo } from './detector'

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
  /** 安装进度回调（克隆中/装依赖中/完成）。 */
  onStep?: (step: string) => void
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
  return new Promise((resolve) => {
    exec(command, args, { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) }, (err: ExecException | null, stdout: string, stderr: string) => {
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
  return new Promise((resolve) => setTimeout(resolve, ms))
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
 * - macOS：brew（git / node / pnpm；node 公式满足 DSH ^22.19||>=24 的 >=24 分支）；
 * - 其余平台返回手动指引。
 */
export async function installDependency(
  dep: keyof DepStatus,
  opts: { exec?: typeof execFile } = {},
): Promise<{ ok: boolean; message: string }> {
  const exec = opts.exec ?? execFile
  // 仅真实 exec 时启用 PATH 刷新（测试注入的 exec 保持原样）
  const env = opts.exec ? undefined : refreshedEnv()

  if (process.platform === 'win32') {
    if (dep === 'git') {
      const r = await run(exec, 'winget', ['install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], 600_000, env)
      return r.ok
        ? { ok: true, message: 'git 已安装。无需重启，可继续下一步' }
        : { ok: false, message: `git 安装失败：${r.err || '未知错误'}。可手动到 git-scm.com 下载安装` }
    }
    if (dep === 'node') {
      const r = await run(exec, 'winget', ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], 600_000, env)
      return r.ok
        ? { ok: true, message: 'Node.js 已安装。无需重启，可继续下一步' }
        : { ok: false, message: `Node.js 安装失败：${r.err || '未知错误'}。可手动到 nodejs.org 下载安装` }
    }
    // pnpm：优先 winget（不依赖 node/npm，无 node 也能装）；winget 失败时退回 npm
    const w = await run(exec, 'winget', ['install', '--id', 'pnpm.pnpm', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], 600_000, env)
    if (w.ok) {
      return { ok: true, message: 'pnpm 已安装。无需重启，可继续下一步' }
    }
    const r = await run(exec, 'npm', ['install', '-g', 'pnpm'], 600_000, env)
    return r.ok
      ? { ok: true, message: 'pnpm 已安装。无需重启，可继续下一步' }
      : { ok: false, message: `pnpm 安装失败：${r.err || '未知错误'}。可手动执行 winget install pnpm.pnpm 或 npm install -g pnpm` }
  }

  // macOS：brew 一键安装（需本机已装 brew；未装时错误信息会提示）
  if (process.platform === 'darwin') {
    const formula = dep === 'git' ? 'git' : dep === 'node' ? 'node' : 'pnpm'
    const r = await run(exec, 'brew', ['install', formula], 600_000, env)
    return r.ok
      ? { ok: true, message: `${dep} 已安装（brew）。无需重启，可继续下一步` }
      : { ok: false, message: `${dep} 安装失败：${r.err.split('\n')[0] || '未知错误'}。可手动执行 brew install ${formula}（需先安装 Homebrew）` }
  }

  const hints: Record<keyof DepStatus, string> = {
    git: 'macOS: brew install git；Linux: sudo apt install git',
    node: '请到 nodejs.org 下载安装 Node.js',
    pnpm: '先安装 Node.js，再执行 npm install -g pnpm',
  }
  return { ok: false, message: `请手动安装依赖：${hints[dep]}` }
}

/**
 * 一键安装 DeepSeek Harness 本体：
 * 1. 目标目录已是 DSH 仓库 → 直接复用；
 * 2. 否则 git 浅克隆官方仓库到目标目录；
 * 3. pnpm 可用时安装依赖（失败不阻塞，提示手动安装）；
 * 4. 校验为 DSH 仓库后返回目录。
 */
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
    return { ok: false, message: '安装目录为空：请在设置中填写安装目录' }
  }

  // 已存在且是 DSH 仓库：直接复用
  if (existsSync(targetDir) && isDshRepo(targetDir)) {
    return { ok: true, message: `检测到已安装的 DSH 仓库：${targetDir}`, dir: targetDir }
  }
  // 已存在但不是 DSH 仓库：仅当为「空目录/仅含 .git 的残缺克隆」时才清理重装，否则拒绝覆盖
  if (existsSync(targetDir)) {
    if (isRescuableDir(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    } else {
      return {
        ok: false,
        message: `目录已存在但不是 DSH 仓库：${targetDir}。为避免覆盖数据，请更换安装目录或手动处理`,
      }
    }
  }

  // 克隆：官方直连优先，失败自动切 gh-proxy.com 镜像重试（本机实测官方源在部分网络下连不通）
  onStep('正在下载 DeepSeek Harness…')
  const mirrorUrl = `https://gh-proxy.com/${cloneUrl}`
  const cloneAttempts = [cloneUrl, mirrorUrl, mirrorUrl]
  let clone: RunResult | null = null
  let lastErr = ''
  for (let i = 0; i < cloneAttempts.length; i++) {
    if (i > 0) {
      onStep(`官方源下载失败，正在通过镜像重试（第 ${i} 次）…`)
      await delay(2000)
    }
    const r = await run(
      exec,
      'git',
      [
        'clone', '--depth', '1',
        '--config', 'http.postBuffer=524288000',
        '--config', 'http.lowSpeedLimit=1000',
        '--config', 'http.lowSpeedTime=30',
        cloneAttempts[i], targetDir,
      ],
      CLONE_TIMEOUT_MS,
      env,
    )
    if (r.ok && existsSync(targetDir) && isDshRepo(targetDir)) {
      clone = r
      break
    }
    lastErr = r.err.split('\n')[0] || `第 ${i + 1} 次尝试失败`
    // 清理残缺目录，避免下次被「目录已存在」拦截
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
  }
  if (!clone) {
    return {
      ok: false,
      message: `克隆失败：${lastErr}。已自动重试官方源与 gh-proxy.com 镜像；仍失败时可在设置中更换安装地址或稍后再试`,
    }
  }

  // 安装依赖（可选步骤，失败不阻塞；首次失败用淘宝 npmmirror 源重试一次）
  let depsNote = ''
  if (hasBin('pnpm')) {
    onStep('正在安装依赖（可能需要几分钟）…')
    let install = await run(exec, 'pnpm', ['-C', targetDir, 'install'], INSTALL_TIMEOUT_MS, env)
    if (!install.ok) {
      onStep('依赖源访问失败，改用国内镜像源重试…')
      install = await run(exec, 'pnpm', ['-C', targetDir, 'install', '--registry', 'https://registry.npmmirror.com'], INSTALL_TIMEOUT_MS, env)
    }
    if (!install.ok) {
      depsNote = `；依赖安装未完成（${install.err.split('\n')[0] || '失败'}），可稍后在 ${targetDir} 下执行 pnpm install`
    }
  } else {
    depsNote = '；未检测到 pnpm，请安装 pnpm 后在仓库目录执行 pnpm install'
  }

  onStep('安装完成')
  return {
    ok: true,
    message: `DSH 已安装：${targetDir}${depsNote}`,
    dir: targetDir,
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
