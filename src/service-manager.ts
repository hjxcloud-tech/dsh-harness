/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { t } from './i18n'
import { resolveExec } from './win-exec'

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

/** DSH 服务当前状态（ensureOnline 仅返回 online / failed；'starting' 变体从未被构造，故不保留）。 */
export type DshServiceState = { kind: 'online' } | { kind: 'failed'; message: string }

/** 默认探活超时（毫秒）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 3000
/** 默认就绪轮询间隔（毫秒）。 */
export const DEFAULT_POLL_INTERVAL_MS = 1000
/** 默认就绪等待总超时（毫秒）；首次启动（含依赖预热/tsx 冷启动）实测约 1–2 分钟，放宽到 5 分钟。 */
export const DEFAULT_READY_TIMEOUT_MS = 300000

/**
 * 启动输出日志（v2.3.0）：DSH ≥0.1.2 的 Web 服务启动时打印带一次性 token 的认证 URL
 * （`dsh web: http://127.0.0.1:<port>/?token=...`）。插件把服务进程输出重定向到该日志，
 * 事后解析出 URL 供「在浏览器打开 DSH」使用（iframe 面板受 SameSite=Strict cookie 限制无法自动认证，
 * 顶层浏览器导航则可以）。
 */
export function launchLogFile(port: number): string {
  return join(tmpdir(), `dsh-web-out-${String(port)}.log`)
}

/** 从启动输出解析 `dsh web: <url>` 认证链接（忽略尾部括号附加的 LAN 地址）；未找到返回 ''。 */
export function parseLaunchUrl(text: string): string {
  const m = /dsh web: (https?:\/\/[^\s"'<>)]+)/.exec(text)
  return m?.[1] ?? ''
}

/** 当前启动的重定向日志路径（start() 设置、spawn 默认实现读取；测试注入 spawn 时忽略）。 */
let pendingLaunchLog: string | null = null

/** 可注入的进程/网络依赖，便于测试隔离真实进程与网络。 */
export interface DshSpawnDeps {
  probe(this: void, port: number): Promise<boolean>
  spawnProcess(
    this: void,
    command: string,
    args: string[],
    cwd: string,
    detached: boolean,
  ): SpawnedProcess
  /** 启动前清理端口残留进程（真实实现会跑 netstat/powershell/taskkill，测试必须 mock，防误杀真实 DSH）。 */
  killPortOwner(this: void, port: number): void
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

/**
 * `--no-open` 双向自适应（纯函数）：
 * - supported=true 且命令缺该 flag → 返回补上后的命令（避免启动/重启时自动拉起浏览器）；
 * - supported=false 且命令含该 flag → 返回移除后的命令（旧版 dsh 不认识会启动失败）；
 * - 其余情况（已符合/空命令/移除后为空）→ 返回 null（表示无需写盘）。
 * 空命令返回 null：默认探测命令（detectStartupCommand）已自带 flag 逻辑，不污染用户设置。
 */
export function applyNoOpenAdaptive(cmd: string, supported: boolean): string | null {
  const trimmed = cmd.trim()
  if (trimmed === '') return null
  const hasFlag = /\s*--no-open\b/.test(trimmed)
  if (supported) {
    if (hasFlag) return null
    return `${trimmed} --no-open`
  }
  if (!hasFlag) return null
  const cleaned = trimmed.replace(/\s*--no-open\b/g, '').trim()
  return cleaned === '' ? null : cleaned
}

/**
 * 通过 PATH 探测 dsh 可执行文件：命中返回默认启动命令模板，否则返回空串。
 * `--no-open` 仅全局 CLI（dsh@0.1.0-rc.7 起）支持；仓库源码形态（pnpm dsh web）无此 flag 且无自动打开行为。
 * 注意：`dshSupportsNoOpen()` 走磁盘/版本缓存（见下），此处不触发 8 秒级的 `dsh web --help` 探测。
 */
export function detectStartupCommand(): string {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, ['dsh'], { stdio: 'ignore' })
  } catch {
    return ''
  }
  if (dshSupportsNoOpen()) {
    return 'dsh web --port {port} --no-open'
  }
  return 'dsh web --port {port}'
}

/** 已探测到的 dsh 版本（`dsh --version`，~350ms 快查；空串=未探测/失败）。 */
let cachedDshVersion = ''
/** `dsh web --help`（~8s）的探测结果；null=尚未探测。 */
let cachedNoOpenSupport: boolean | null = null

/**
 * 快速读取当前 PATH 中 dsh 的版本号（`dsh --version`，约 350ms；`dsh web --help` 约 8s，不可用于频繁探测）。
 * 失败返回空串。
 */
export function dshVersion(): string {
  if (cachedDshVersion !== '') return cachedDshVersion
  try {
    const resolved = resolveExec(process.platform, 'dsh', ['--version'])
    const out = execFileSync(resolved.command, resolved.args, { encoding: 'utf8', timeout: 5000 })
    cachedDshVersion = (out.trim().split(/\r?\n/)[0] ?? '').trim()
  } catch {
    cachedDshVersion = ''
  }
  return cachedDshVersion
}

/**
 * 当前 PATH 中的 dsh（全局 CLI）是否支持 `--no-open`。
 * 仓库源码形态（pnpm dsh web）无该 flag 且无自动打开行为，不适用本探测（调用方自行区分）。
 *
 * 性能约束：`dsh web --help` 实测约 8 秒（Node + CLI 冷启动），**禁止在同步加载/启动路径调用本函数**。
 * 探测应通过 `probeNoOpenSupportAsync()` 在后台执行，结果落缓存后本函数才可快速返回；
 * 未探测时返回 true（按当前已知支持的 rc.7 默认，避免改变用户既有命令）。
 */
export function dshSupportsNoOpen(): boolean {
  if (cachedNoOpenSupport !== null) return cachedNoOpenSupport
  return true
}

/**
 * 后台探测 `--no-open` 支持（`dsh web --help`，约 8 秒），完成后回调结果并缓存。
 * 全程异步（execFile 回调），不阻塞渲染线程；回调里顺带异步缓存 `dsh --version`。
 * 探测失败按「支持」处理（当前 DSH 全系支持 --no-open；按不支持处理会移除用户命令里的
 * --no-open 导致启动时弹浏览器——更常见的问题）。
 */
export function probeNoOpenSupportAsync(onDone?: (supported: boolean) => void): void {
  let resolved: { command: string; args: string[] }
  try {
    resolved = resolveExec(process.platform, 'dsh', ['web', '--help'])
  } catch {
    cachedNoOpenSupport = true
    onDone?.(true)
    return
  }
  execFile(
    resolved.command,
    resolved.args,
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
    (err, stdout) => {
      const supported = err === null ? String(stdout).includes('no-open') : true
      cachedNoOpenSupport = supported
      try {
        const v = resolveExec(process.platform, 'dsh', ['--version'])
        execFile(v.command, v.args, { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err2, out2) => {
          if (err2 === null) {
            cachedDshVersion = (String(out2).trim().split(/\r?\n/)[0] ?? '').trim()
          }
          onDone?.(supported)
        })
      } catch {
        onDone?.(supported)
      }
    },
  )
}

/**
 * 清理占用指定端口的 DSH 相关进程，避免残留/失效的旧实例（如 detached 常驻进程）
 * 占着端口导致新拉起失败（EADDRINUSE）后干等超时。
 * 仅终止命令行含 DSH 特征（dsh / deepseek-harness / bin.js）的进程，绝不误杀无关服务。
 * 找不到占用者、进程已退出或工具不可用时静默返回。
 */
export function killPortOwner(port: number): void {
  if (process.platform === 'win32') {
    killPortOwnerWin32(port)
    return
  }
  // POSIX：lsof 找端口占用 PID，逐 PID 校验命令行特征后 kill
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        const cmd = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' })
        if (/dsh|deepseek-harness|bin\.js/i.test(cmd)) {
          execFileSync('kill', ['-9', pid], { stdio: 'ignore' })
        }
      } catch {
        // 进程已退出等，忽略
      }
    }
  } catch {
    // lsof 不可用或无占用者，忽略
  }
}

function killPortOwnerWin32(port: number): void {
  try {
    const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    const pids = new Set<string>()
    for (const line of netstat.split(/\r?\n/)) {
      const m = /TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
      if (m !== null && Number(m[1]) === port) {
        pids.add(m[2])
      }
    }
    for (const pid of pids) {
      if (isDshProcess(pid)) {
        try {
          execFileSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' })
        } catch {
          // 进程已退出，忽略
        }
      }
    }
  } catch {
    // netstat 不可用，忽略
  }
}

function isDshProcess(pid: string): boolean {
  try {
    const ps = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ], { encoding: 'utf8', timeout: 8000 })
    return /dsh|deepseek-harness|bin\.js/i.test(ps)
  } catch {
    return false
  }
}

/** 一个 DSH 进程条目（升级前提示与结束结果展示用）。 */
export interface DshProcessInfo {
  pid: number
  command: string
}

/**
 * DSH 进程识别：命令行必须命中官方 CLI 入口、仓库形态 dsh web、或本插件桥接所在 profile。
 * 刻意保守（宁可漏杀也不误杀无关 node 进程）。
 */
export const DSH_CMD_RE = /(@deepseek-ai[\\/]dsh|deepseek-harness[\\/]|\bdsh[\\/]lib[\\/]bin\.js|\bdsh\.(?:cmd|js)\b|\bdsh\s+web\b|profiles[\\/]web[\\/]dsh-obsidian-bridge)/i

/** 纯函数：从 {pid, command} 列表筛出 DSH 进程（排除自身），便于单测。 */
export function filterDshProcesses(
  rows: ReadonlyArray<{ pid: number; command: string }>,
  selfPid: number,
): DshProcessInfo[] {
  const seen = new Set<number>()
  const out: DshProcessInfo[] = []
  for (const row of rows) {
    const pid = Number(row.pid)
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid || seen.has(pid)) continue
    if (!DSH_CMD_RE.test(String(row.command))) continue
    seen.add(pid)
    out.push({ pid, command: String(row.command) })
  }
  return out
}

/**
 * 异步执行外部命令（v2.4.0）：进程枚举/结束走异步，避免同步 PowerShell（最长 ~20s）阻塞 Obsidian 界面。
 * 失败或超时返回 ok=false，由调用方按"无进程/结束失败"处理。
 */
async function runQuiet(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? { ok: false, out: '' } : { ok: true, out: String(stdout ?? '') })
      })
    } catch {
      resolve({ ok: false, out: '' })
    }
  })
}

/**
 * 枚举机器上所有 DSH 进程（不含当前进程）。
 * Windows：一次 Get-CimInstance 取全部 node 进程命令行（比逐 pid 查询快）；POSIX：pgrep -af。
 */
export async function listDshProcesses(): Promise<DshProcessInfo[]> {
  if (process.platform === 'win32') {
    const r = await runQuiet('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ], 20000)
    const trimmed = r.out.trim()
    if (!r.ok || trimmed === '') return []
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => {
        const rec = row as { ProcessId?: unknown; CommandLine?: unknown }
        return { pid: Number(rec.ProcessId ?? 0), command: String(rec.CommandLine ?? '') }
      })
      return filterDshProcesses(rows, process.pid)
    } catch {
      return []
    }
  }
  const r = await runQuiet('pgrep', ['-af', 'dsh'], 8000)
  if (!r.ok) return []
  const rows = r.out
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const sp = line.indexOf(' ')
      return { pid: Number(sp >= 0 ? line.slice(0, sp) : line), command: sp >= 0 ? line.slice(sp + 1) : '' }
    })
  return filterDshProcesses(rows, process.pid)
}

/**
 * 结束机器上所有 DSH 进程（v2.4.0：升级/重装前调用，避免 Windows 文件锁导致 npm 就地升级半途夭折）。
 * 返回实际下发的进程列表（不保证都成功，进程可能已退出）。
 */
export async function killDshProcesses(): Promise<DshProcessInfo[]> {
  const targets = await listDshProcesses()
  for (const target of targets) {
    if (process.platform === 'win32') {
      await runQuiet('taskkill', ['/pid', String(target.pid), '/T', '/F'], 10000)
    } else {
      await runQuiet('kill', ['-9', String(target.pid)], 8000)
    }
  }
  return targets
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
function winSpawnHidden(command: string, args: string[], cwd: string, detached: boolean): SpawnedProcess {
  const cmdLine = [winQuoted(command), ...args.map(winQuoted)].join(' ')
  // 启动输出重定向到日志（token URL 捕获）：%TEMP% 由 cmd 展开，避免用户名含空格/非 ASCII 的引号问题
  const redirect = pendingLaunchLog !== null ? ` > "%TEMP%\\${basename(pendingLaunchLog)}" 2>&1` : ''
  const vbsPath = join(tmpdir(), `dsh-launch-${process.pid}-${Date.now()}.vbs`)
  // UTF-16LE 带 BOM：wscript 按 Unicode 解析，路径含非 ASCII（如中文用户名）也不乱码
  // On Error Resume Next：个别宿主下 Run 返回 Nothing 会抛「缺少对象」，容错后仍可启动
  const body =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    'On Error Resume Next\r\n' +
    `Set ex = sh.Run("cmd.exe /d /s /c ${(cmdLine + redirect).replaceAll('"', '""')}", 0, True)\r\n` +
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
function defaultSpawnProcess(command: string, args: string[], cwd: string, detached: boolean): SpawnedProcess {
  if (process.platform === 'win32') {
    return winSpawnHidden(command, args, cwd, detached)
  }
  // POSIX：有重定向日志需求时把 stdout/stderr 指到日志 fd（token URL 捕获），否则保持 ignore
  let stdio: 'ignore' | Array<'ignore' | number> = 'ignore'
  if (pendingLaunchLog !== null) {
    try {
      const fd = openSync(pendingLaunchLog, 'a')
      stdio = ['ignore', fd, fd]
    } catch {
      // 日志不可写时退回 ignore（不影响启动）
    }
  }
  return spawn(command, args, {
    cwd,
    detached: true,
    stdio,
    windowsHide: true,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 最小子进程句柄（pid/on/once/kill）。
 * 用结构类型而非 node:child_process 的 ChildProcess：审核环境无 node 类型声明时
 * ChildProcess 会被判为 any，`ChildProcess | null` 联合触发 no-redundant-type-constituents 告警。
 */
export interface SpawnedProcess {
  pid?: number
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  kill(): unknown
}

/**
 * 探测面板是否需要认证（v2.4.0）：GET / 若返回 401，说明是 0.1.2+ 的浏览器会话认证，
 * 插件必须在拿到启动 token 后才能内嵌（否则 iframe 里只会是一张 401 白屏）。
 * 走 Node http（不受渲染进程 CSP 限制）；任何异常/超时都按「不需要认证」返回，
 * 以免旧版 DSH 被误判而无限等待。
 */
export function probePanelNeedsAuth(port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs }, (res) => {
        const code = res.statusCode ?? 0
        res.resume()
        resolve(code === 401)
      })
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.on('error', () => resolve(false))
      req.end()
    } catch {
      resolve(false)
    }
  })
}

/** DSH 服务管理器：探活 / 拉起 / 就绪轮询 / 回收。 */
export class DshServiceManager {
  private readonly opts: DshServiceOptions
  private readonly deps: DshSpawnDeps
  private readonly pollIntervalMs: number
  private readonly readyTimeoutMs: number
  private child: SpawnedProcess | null = null
  /** 是否已发起过启动（普通可变字段）。 */
  spawned = false
  /** spawn 失败原因（由子进程 'error' 事件捕获）。 */
  private spawnError: string | null = null
  /** 是否已 dispose（防止卸载后重新拉起）。 */
  private disposed = false
  /** 缓存的启动认证 URL（DSH ≥0.1.2 打印的带 token 链接；'' = 未解析到）。 */
  private launchUrl = ''

  /** 当前端口对应的启动输出日志路径。 */
  private get launchLog(): string {
    return launchLogFile(this.opts.port)
  }

  /**
   * 解析服务启动输出中的认证 URL（`dsh web: http://127.0.0.1:<port>/?token=...`）。
   * DSH <0.1.2 不打印 token → 返回 ''（正常）；≥0.1.2 用它让「在浏览器打开」绕过 401。
   *
   * v2.4.0：**每次调用都重读日志**（不再永久缓存）。token 每进程重新生成，缓存旧 token 会让
   * 面板与直发请求命中 `dsh web authentication required`（服务被外部重启、崩溃重启、插件重装等
   * 不走 restartDshService 的路径都会换 token）。start() 会截断日志，所以**日志内容即当前进程真值**：
   * 解析为空 → 说明新进程还没打印 → 清掉旧值，避免继续使用上一进程的 token。
   * 日志只有几百字节且本方法调用频率低（渲染面板、发送时），重读成本可忽略。
   */
  getLaunchUrl(): string {
    try {
      this.launchUrl = parseLaunchUrl(readFileSync(this.launchLog, 'utf8'))
    } catch {
      // 日志文件不存在/瞬时不可读：沿用上次解析结果（可能为空），下次再试
    }
    return this.launchUrl
  }

  /**
   * 丢弃缓存的启动认证 URL（v2.4.0）：DSH 升级/重启后 token 会换新，
   * 继续用旧 token 会让面板与直发请求命中 `dsh web authentication required`。
   * 清缓存后 getLaunchUrl() 会从本次启动日志重新解析（start() 已截断日志）。
   */
  clearLaunchUrl(): void {
    this.launchUrl = ''
  }

  constructor(opts: DshServiceOptions, deps?: DshSpawnDeps) {
    this.opts = opts
    this.deps = {
      probe: deps?.probe ?? ((p) => defaultProbe(p, opts.probeTimeoutMs)),
      spawnProcess: deps?.spawnProcess ?? defaultSpawnProcess,
      killPortOwner: deps?.killPortOwner ?? killPortOwner,
    }
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  }

  /** 探测一次服务是否在线。 */
  async probe(): Promise<boolean> {
    return this.deps.probe(this.opts.port)
  }

  /**
   * 面板是否需要认证（v2.4.0）：GET / 返回 401 ⇒ 0.1.2+ 带浏览器会话认证，
   * 必须先拿到启动 token 才能内嵌。返回 false 表示可直接嵌入（旧版 / 已放行）。
   */
  async panelNeedsAuth(): Promise<boolean> {
    return probePanelNeedsAuth(this.opts.port)
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
    // 清除上次的失败标记：一次启动失败不应让后续重试在 ensureOnline 处永久短路
    this.spawnError = null
    // 端口被残留/失效进程占用（如 detached 常驻的旧实例）时先清理再拉起，
    // 避免新进程 EADDRINUSE 退出后干等 readyTimeout 超时
    // （经依赖注入调用：测试环境注入 mock，防止误杀真实 DSH 进程）
    this.deps.killPortOwner(this.opts.port)
    // 启动输出捕获：截断旧日志并登记重定向目标（spawn 默认实现读取；token URL 解析用）
    this.launchUrl = ''
    try {
      writeFileSync(this.launchLog, '')
      pendingLaunchLog = this.launchLog
    } catch {
      pendingLaunchLog = null
    }
    const child = this.deps.spawnProcess(command, args, this.opts.startupCwd, this.opts.detached)
    pendingLaunchLog = null
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
