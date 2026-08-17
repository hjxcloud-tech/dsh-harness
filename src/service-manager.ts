/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from './i18n'

/** 服务配置选项（来自插件设置）。 */
export interface DshServiceOptions {
  port: number
  startupCommand: string
  startupCwd: string
  autoStart: boolean
  detached: boolean
  probeTimeoutMs?: number
  pollIntervalMs?: number
  readyTimeoutMs?: number
}

/** DSH 服务当前状态。 */
export type DshServiceState = { kind: 'online' } | { kind: 'starting' } | { kind: 'failed'; message: string }

/** 默认探活超时（毫秒）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 3000
/** 默认就绪轮询间隔（毫秒）。 */
export const DEFAULT_POLL_INTERVAL_MS = 1000
/** 默认就绪等待总超时（毫秒）；首次启动（含依赖预热/tsx 冷启动）实测约 1–2 分钟，放宽到 5 分钟。 */
export const DEFAULT_READY_TIMEOUT_MS = 300000

/** 可注入的进程/网络依赖，便于测试隔离真实进程与网络。 */
export interface DshSpawnDeps {
  probe(this: void, port: number): Promise<boolean>
  spawnProcess(
    this: void,
    command: string,
    args: string[],
    cwd: string,
    detached: boolean,
  ): import('node:child_process').ChildProcess
}

/** 将模板中的全部 {port} 占位替换为端口号，trim 后按空白拆分：首段为命令，余段为参数。 */
export function renderCommand(template: string, port: number): { command: string; args: string[] } {
  const trimmed = template.replaceAll('{port}', String(port)).trim()
  if (trimmed === '') {
    return { command: '', args: [] }
  }
  const parts = trimmed.split(/\s+/)
  return { command: parts[0], args: parts.slice(1) }
}

/** 通过 PATH 探测 dsh 可执行文件：命中返回默认启动命令模板，否则返回空串。 */
export function detectStartupCommand(): string {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, ['dsh'], { stdio: 'ignore' })
    return 'dsh web --port {port}'
  } catch {
    return ''
  }
}

/**
 * TCP 端口探测：走 Node 网络栈，不受渲染器 CSP 对 fetch 的限制。
 * 连接成功即端口可达。
 */
function tcpProbe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = window.setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      window.clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      window.clearTimeout(timer)
      resolve(false)
    })
  })
}

/** 默认探活实现：TCP 直连端口，连接成功即视为在线（走 Node 网络栈，不受 CSP 限制）。 */
async function defaultProbe(port: number, timeoutMs?: number): Promise<boolean> {
  const t = timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  return tcpProbe(port, t)
}

/** 仅当包含空格时才加引号（cmd /c 对每段加引号会解析失败）。 */
function winQuoted(part: string): string {
  return /\s/.test(part) ? `"${part}"` : part
}

/**
 * Windows 隐藏控制台拉起：
 * 经 wscript + 临时 VBS（WScript.Shell.Run windowStyle=0 = SW_HIDE）启动 cmd.exe，
 * 让整条进程链（cmd → pnpm.cmd → node → DSH 后台任务）继承同一个「隐藏控制台」——
 * 与 CREATE_NO_WINDOW/windowsHide 不同，SW_HIDE 下控制台真实存在，只是窗口隐藏，
 * 因此所有后代控制台程序都继承它而不会各自新建可见窗口（实测验证）。
 * wscript 以 bWaitOnReturn=True 常驻到服务退出，退出码随 cmd 传递，便于诊断。
 */
function winSpawnHidden(command: string, args: string[], cwd: string, detached: boolean): ChildProcess {
  const cmdLine = [winQuoted(command), ...args.map(winQuoted)].join(' ')
  const vbsPath = join(tmpdir(), `dsh-launch-${process.pid}-${Date.now()}.vbs`)
  // UTF-16LE 带 BOM：wscript 按 Unicode 解析，路径含非 ASCII（如中文用户名）也不乱码
  // On Error Resume Next：个别宿主下 Run 返回 Nothing 会抛「缺少对象」，容错后仍可启动
  const body =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    'On Error Resume Next\r\n' +
    `Set ex = sh.Run("cmd.exe /d /s /c ${cmdLine.replaceAll('"', '""')}", 0, True)\r\n` +
    'If Err.Number = 0 And Not ex Is Nothing Then WScript.Quit ex.ExitCode\r\n'
  writeFileSync(vbsPath, '\uFEFF' + body, 'utf16le')
  const child = spawn('wscript.exe', ['//nologo', '//b', vbsPath], {
    cwd,
    detached,
    stdio: 'ignore',
    windowsHide: true,
  })
  const cleanup = (): void => {
    try {
      unlinkSync(vbsPath)
    } catch {
      // 临时文件已不存在时静默
    }
  }
  child.once('exit', cleanup)
  child.once('error', cleanup)
  return child
}

/**
 * 默认进程拉起实现：
 * - Windows：VBS 隐藏控制台 + cmd.exe 中转（整条进程链无任何可见窗口）；
 *   detached 时创建独立进程组——服务不挂在可见控制台上，
 *   关闭任何 cmd 窗口/终端都不会中断 DSH 服务；
 * - POSIX（macOS/Linux）：始终以 detached 创建独立进程组（setsid），
 *   使 dispose 能按组整组回收 pnpm → node 全链路（单点 kill 会残留孙进程）；
 *   detached 选项仅决定退出时是否回收。
 */
function defaultSpawnProcess(command: string, args: string[], cwd: string, detached: boolean): ChildProcess {
  if (process.platform === 'win32') {
    return winSpawnHidden(command, args, cwd, detached)
  }
  return spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** DSH 服务管理器：探活 / 拉起 / 就绪轮询 / 回收。 */
export class DshServiceManager {
  private readonly opts: DshServiceOptions
  private readonly deps: DshSpawnDeps
  private readonly pollIntervalMs: number
  private readonly readyTimeoutMs: number
  private child: ChildProcess | null = null
  /** 是否已发起过启动（普通可变字段）。 */
  spawned = false
  /** spawn 失败原因（由子进程 'error' 事件捕获）。 */
  private spawnError: string | null = null
  /** 是否已 dispose（防止卸载后重新拉起）。 */
  private disposed = false

  constructor(opts: DshServiceOptions, deps?: DshSpawnDeps) {
    this.opts = opts
    this.deps = {
      probe: deps?.probe ?? ((p) => defaultProbe(p, opts.probeTimeoutMs)),
      spawnProcess: deps?.spawnProcess ?? defaultSpawnProcess,
    }
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  }

  /** 探测一次服务是否在线。 */
  async probe(): Promise<boolean> {
    return this.deps.probe(this.opts.port)
  }

  /** 服务离线时的原因描述（优先进程退出/spawn 错误，其次自动启动开关，兜底通用描述）。 */
  describeOffline(): string {
    if (this.spawnError) {
      return this.spawnError
    }
    if (!this.opts.autoStart) {
      return t('svc.offlineNoAuto', { port: this.opts.port })
    }
    if (this.spawned) {
      return t('svc.stopped', { port: this.opts.port })
    }
    return t('svc.offline', { port: this.opts.port })
  }

  /**
   * 确保服务在线：先探活，离线时按 autoStart 决定启动并轮询等待就绪。
   * 返回最终服务状态（online / failed）。
   */
  async ensureOnline(): Promise<DshServiceState> {
    if (await this.probe()) {
      return { kind: 'online' }
    }
    if (!this.opts.autoStart) {
      return { kind: 'failed', message: t('svc.ensureOffline', { port: this.opts.port }) }
    }
    this.start()
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      if (this.disposed) {
        return { kind: 'failed', message: t('svc.unloaded') }
      }
      if (this.spawnError) {
        return { kind: 'failed', message: t('svc.startFailed', { err: this.spawnError }) }
      }
      await delay(this.pollIntervalMs)
      if (await this.probe()) {
        return { kind: 'online' }
      }
    }
    const seconds = Math.ceil(this.readyTimeoutMs / 1000)
    return { kind: 'failed', message: t('svc.timeout', { sec: seconds }) }
  }

  /** 拉起服务子进程；已 dispose 或已启动（child 存活）则忽略。命令为空时抛错。 */
  start(): void {
    if (this.disposed) {
      return
    }
    if (this.child) {
      return
    }
    const { command, args } = renderCommand(this.opts.startupCommand, this.opts.port)
    if (!command) {
      throw new Error(t('svc.noCommand'))
    }
    const child = this.deps.spawnProcess(command, args, this.opts.startupCwd, this.opts.detached)
    this.child = child
    this.spawned = true
    child.on('exit', (code: number | null) => {
      this.child = null
      if (code !== 0 && code !== null) {
        this.spawnError = this.spawnError ?? t('svc.exited', { code })
      }
    })
    child.on('error', (err: Error) => {
      this.spawnError = err.message
      this.child = null
    })
  }

  /** 回收资源：非 detached 子进程将被终止；Windows 按进程树、POSIX 按进程组整组回收。 */
  dispose(): void {
    this.disposed = true
    if (this.child && !this.opts.detached) {
      const pid = this.child.pid
      if (pid && process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          // taskkill 失败时静默（如进程已退出），由下方 child = null 收敛状态
        }
      } else if (pid) {
        // POSIX：负 pid 终止整个进程组（spawn 已 detached=setsid），
        // 避免 pnpm → node 链中孙进程残留
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          // 进程组已不存在（如进程已退出）时静默
        }
      } else {
        this.child.kill()
      }
      this.child = null
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
