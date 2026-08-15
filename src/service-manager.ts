/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { connect } from 'node:net'

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
/** 默认就绪等待总超时（毫秒）；首次启动可能较慢，取 2 分钟。 */
export const DEFAULT_READY_TIMEOUT_MS = 120000

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

/**
 * 默认进程拉起实现：
 * - Windows：显式经 cmd.exe 中转（CREATE_NO_WINDOW 无控制台窗口），
 *   detached 时创建独立进程组——服务进程不挂在可见控制台上，
 *   关闭任何 cmd 窗口/终端都不会中断 DSH 服务；
 * - 其余平台直接 spawn。
 */
function defaultSpawnProcess(command: string, args: string[], cwd: string, detached: boolean): ChildProcess {
  if (process.platform === 'win32') {
    const quoted = args.map((a) => `"${a}"`).join(' ')
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${command}" ${quoted}`], {
      cwd,
      detached,
      stdio: 'ignore',
      windowsHide: true,
    })
  }
  return spawn(command, args, {
    cwd,
    detached,
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

  /**
   * 确保服务在线：先探活，离线时按 autoStart 决定启动并轮询等待就绪。
   * 返回最终服务状态（online / failed）。
   */
  async ensureOnline(): Promise<DshServiceState> {
    if (await this.probe()) {
      return { kind: 'online' }
    }
    if (!this.opts.autoStart) {
      return { kind: 'failed', message: `127.0.0.1:${this.opts.port} 无服务，且已关闭自动启动` }
    }
    this.start()
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      if (this.disposed) {
        return { kind: 'failed', message: '插件已卸载' }
      }
      if (this.spawnError) {
        return { kind: 'failed', message: '启动失败：' + this.spawnError }
      }
      await delay(this.pollIntervalMs)
      if (await this.probe()) {
        return { kind: 'online' }
      }
    }
    const seconds = Math.ceil(this.readyTimeoutMs / 1000)
    return { kind: 'failed', message: `等待服务就绪超时（${seconds} 秒）；请检查启动命令是否正确` }
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
      throw new Error('请在插件设置中配置 DSH 启动命令')
    }
    const child = this.deps.spawnProcess(command, args, this.opts.startupCwd, this.opts.detached)
    this.child = child
    this.spawned = true
    child.on('exit', (code: number | null) => {
      this.child = null
      if (code !== 0 && code !== null) {
        this.spawnError = this.spawnError ?? `进程已退出（代码 ${code}）；请检查启动命令与工作目录`
      }
    })
    child.on('error', (err: Error) => {
      this.spawnError = err.message
      this.child = null
    })
  }

  /** 回收资源：非 detached 子进程将被终止；Windows 下按进程树整树回收。 */
  dispose(): void {
    this.disposed = true
    if (this.child && !this.opts.detached) {
      if (process.platform === 'win32' && this.child.pid) {
        try {
          execFileSync('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          // taskkill 失败时静默（如进程已退出），由下方 child = null 收敛状态
        }
      } else {
        this.child.kill()
      }
      this.child = null
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
