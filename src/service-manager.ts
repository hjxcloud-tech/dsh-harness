/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { t } from './i18n'
import { isReservedProfile } from './profile'
import { resolveExec } from './win-exec'

/** 服务配置选项（来自插件设置）。 */
export interface DshServiceOptions {
  port: number
  startupCommand: string
  startupCwd: string
  autoStart: boolean
  detached: boolean
  /** v2.6.0：本服务所属 DSH profile（受管注册表条目字段；缺省 web）。 */
  profile?: string
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
  /** 启动前端口裁决（v2.6.0）：只清理受管残留（%TEMP% 注册表登记的进程树），外部 DSH 占用返回 'external' 且绝不杀。真实实现会跑 netstat/powershell/taskkill，测试必须 mock，防误杀真实 DSH。 */
  acquirePort(this: void, port: number, managedPids: readonly number[]): Promise<PortAcquisition>
  /** 终止该端口的受管残留进程树（作用域重启用）。真实实现查注册表 + taskkill，测试必须 mock。 */
  killManaged(this: void, port: number): Promise<number>
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
export function detectStartupCommand(profile: string = 'web'): string {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, ['dsh'], { stdio: 'ignore' })
  } catch {
    return ''
  }
  return profileStartupCommand(profile)
}

/**
 * 指定 profile 的默认启动命令（全局 CLI 形态）。CLI 实态（@deepseek-ai/dsh/lib/bin.js）：
 * `--profile` 是主程序选项，`web` 子命令是「--profile web」的别名且**拒收**父级 --profile——
 * 非 web profile 必须用 `dsh --profile <p> …` 主程序形态，不能写 `dsh web --profile <p>`。
 */
export function profileStartupCommand(profile: string): string {
  const core = profile === '' || profile === 'web'
    ? 'dsh web --port {port}'
    : `dsh --profile ${profile} --port {port}`
  // --no-open：DSH 全局 CLI 默认启动时自动打开系统浏览器（openBrowser 默认 true），面板嵌入场景不需要
  return dshSupportsNoOpen() ? `${core} --no-open` : core
}

/**
 * 「dsh 本体」选择段（web → `web` 子命令别名；非 web → 主程序 `--profile <p>`），全局 CLI 与仓库 pnpm
 * 两种形态共用同一事实源，避免两处硬编码漂移（v2.6.0；单测锁定）。
 */
export function profileBinSegment(profile: string): string {
  return profile === '' || profile === 'web' ? 'web' : `--profile ${profile}`
}

/** 仓库源码形态的默认启动命令尾段（`web|—profile p --port {port}`，不含包管理器前缀；全局 CLI 缺失时的回退用）。 */
export function repoStartupTail(profile: string): string {
  return `${profileBinSegment(profile)} --port {port}`
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
 * 仅终止命令行命中 DSH 白名单特征（DSH_CMD_RE / dsh-launch-* 拉起树根）的进程，绝不误杀无关服务。
 * 找不到占用者、进程已退出或工具不可用时静默返回。
 * v2.6.0 起本函数只保留给「用户显式确认后清理本端口」的路径使用；
 * 服务自动拉起前的端口裁决走 acquirePort（受管判定，外部 DSH 实例绝不杀）。
 */
export function killPortOwner(port: number): void {
  for (const pid of portOwnerPids(port)) {
    if (!isDshProcess(String(pid))) continue
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' })
      }
    } catch {
      // 进程已退出，忽略
    }
  }
}

/** 监听 127.0.0.1:<port> 的进程 PID（netstat/lsof）；查询失败或无占用者返回空数组。 */
export function portOwnerPids(port: number): number[] {
  if (process.platform === 'win32') {
    try {
      const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
      const pids = new Set<number>()
      for (const line of netstat.split(/\r?\n/)) {
        const m = /TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
        if (m !== null && Number(m[1]) === port) pids.add(Number(m[2]))
      }
      return [...pids]
    } catch {
      return []
    }
  }
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
    return out
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function isDshProcess(pid: string): boolean {
  try {
    const ps = process.platform === 'win32'
      ? execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ], { encoding: 'utf8', timeout: 8000 })
      : execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8', timeout: 8000 })
    // v2.6.0：判据从「含 dsh 字样即杀」收紧为白名单正则（旧宽松匹配曾把无关进程/桌面实例卷入端口清理）；
    // dsh-launch-* 为本插件 VBS 隐藏控制台拉起链的进程树根特征（见 winSpawnHidden）。
    return DSH_CMD_RE.test(ps) || /dsh-launch-/.test(ps)
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
 * DSH 进程识别（v2.6.1：**只认官方身份**，不再靠形状猜测）。四个锚点：
 * ① 官方包路径 `@deepseek-ai/dsh…`（全局 CLI 的 node 进程，含其内嵌子包）；
 * ② 官方仓库入口路径 `deepseek-harness/apps/cli`（源码形态，绝对路径里带仓库目录名＋官方布局）；
 * ③ 插件生成的命令形态 `dsh web` / `dsh --profile`（cmd.exe / pnpm 包装层）；
 * ④ 本插件装进 profile 的桥接模块路径。
 *
 * 为什么删掉旧的三条宽松分支（`deepseek-harness[\\/]`、`dsh/lib/bin.js`、`dsh.cmd|dsh.js`）：
 * 实测存在第三方社区包 `@x1a0f3n9/dsh-web-app`、`@x1a0f3n9/dsh-client-connection` 等（版本号自成一套，
 * 如 0.1.5-rc.3，而官方 0.1.5 系只有 rc.1/rc.2）。旧分支下，任何放在 `<任意>\dsh\lib\bin.js` 的第三方
 * 包、或任何提供 `dsh.cmd` 的第三方包，都会被算进「升级前全机杀 DSH」的目标——那是不可原谅的越界。
 * 刻意保守：**宁可漏杀也不误杀无关进程**；漏掉的包装层仍由 `dsh-launch-*` 树根特征与端口占用者
 * （恒为 node 直跑官方 bin.js）两条路径覆盖，见 `portOwnerVerdict` / `killManagedForPort`。
 * 唯一残余歧义是第三方自行执行 `dsh web`（命令行文本相同，无从区分）——该情形只会让它被判为
 * `external`（端口裁决绝不杀）或在全机杀路径里被列出，后者有 `notice.killAllForUpgrade` 事先明示。
 */
export const DSH_CMD_RE = /(@deepseek-ai[\\/]dsh|deepseek-harness[\\/]apps[\\/]cli|\bdsh\s+(?:web|--profile)\b|profiles[\\/][^\\/]+[\\/]dsh-obsidian-bridge)/i

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
        return {
          pid: Number(rec.ProcessId ?? 0),
          command: typeof rec.CommandLine === 'string' ? rec.CommandLine : '',
        }
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
 * 返回实际下发的进程列表。
 * v2.4.4：**等待进程真正退出**——`taskkill` 返回 ≠ 进程已死；否则紧随其后的 `ensureOnline()`
 * 会把"正在死去的旧进程"判为 online、不拉起新服务（真机症状：重启服务后白屏 → 刷新报错 → 再重启才正常）。
 */
export async function killDshProcesses(): Promise<DshProcessInfo[]> {
  const targets = await listDshProcesses()
  const doKill = async (pid: number): Promise<void> => {
    if (process.platform === 'win32') {
      await runQuiet('taskkill', ['/pid', String(pid), '/T', '/F'], 10000)
    } else {
      await runQuiet('kill', ['-9', String(pid)], 8000)
    }
  }
  for (const target of targets) {
    await doKill(target.pid)
  }
  // 轮询确认退出（最多 ~8s）：仍在的补刀一次
  const deadline = Date.now() + 8000
  for (;;) {
    const left = await listDshProcesses()
    if (left.length === 0) break
    if (Date.now() > deadline) {
      for (const t of left) await doKill(t.pid)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
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
 * 面板认证探测结果（v2.4.4 三态）：'auth'=需要启动 token；'open'=可直接嵌入；'unknown'=探测失败/超时。
 * 为什么必须三态：旧版把"探测失败"也当成 'open'，于是服务正重启时（GET 暂时失败）直接渲染了
 * **不带 token 的裸地址** → 必 401 白屏（真机日志实锤：`renderFrame ob=false` 后紧跟手动刷新才好）。
 */
export type PanelAuthProbe = 'auth' | 'open' | 'unknown'

/**
 * 探测面板是否需要认证（v2.4.0）：GET / 若返回 401，说明是 0.1.2+ 的浏览器会话认证，
 * 插件必须在拿到启动 token 后才能内嵌（否则 iframe 里只会是一张 401 白屏）。
 * 走 Node http（不受渲染进程 CSP 限制）；异常/超时返回 'unknown'（调用方据此保守处理，不误判为无需认证）。
 */
export function probePanelNeedsAuth(port: number, timeoutMs = 4000): Promise<PanelAuthProbe> {
  return new Promise((resolve) => {
    try {
      const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs }, (res) => {
        const code = res.statusCode ?? 0
        res.resume()
        if (code === 401) resolve('auth')
        else if (code >= 200 && code < 400) resolve('open')
        else resolve('unknown')
      })
      req.on('timeout', () => {
        req.destroy()
        resolve('unknown')
      })
      req.on('error', () => resolve('unknown'))
      req.end()
    } catch {
      resolve('unknown')
    }
  })
}

// ---- v2.6.0 多 profile 与端口安全：受管进程注册表 / 端口三态决策 / 作用域终止 / profile 代建 ----

/** 页面级桥接探针结果（v2.6.0 启动适配检查用）。 */
export type BridgeProbeResult = 'injected' | 'missing' | 'unauthorized' | 'unreachable'

/** 桥接注入脚本在 served HTML 里的唯一标记（bridge.ts 的 `bridgeScriptSource` 一开篇就置位）。 */
export const BRIDGE_PAGE_MARKER = '__DSH_OBSIDIAN_BRIDGE__'

/**
 * 页面级探针：GET `/?token=…&ob=1`，看 DSH 实际吐出的 HTML 里有没有桥接脚本（走 Node http，不受 CSP 限制）。
 *
 * 为什么不能只看磁盘文件：DSH 的补丁层在**进程启动时**加载。磁盘上是新文件、内存里跑的是旧脚本
 * ——服务没重启，或未彻底重启的旧插件 bundle 把桥接回写覆盖——是本项目反复出现过的故障形态
 * （v1.3.0/v1.6.0/2.5.x 均为此踩过坑）。只有页面里的标记才算「真生效」。
 */
export async function probeBridgeInjected(port: number, token: string, timeoutMs = 6000): Promise<BridgeProbeResult> {
  const path = `/?token=${encodeURIComponent(token)}&ob=1`
  return new Promise((resolve) => {
    try {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
        const code = res.statusCode ?? 0
        if (code === 401 || code === 403) {
          res.resume()
          resolve('unauthorized')
          return
        }
        if (code < 200 || code >= 400) {
          res.resume()
          resolve('unreachable')
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8').includes(BRIDGE_PAGE_MARKER) ? 'injected' : 'missing')
        })
      })
      req.on('timeout', () => {
        req.destroy()
        resolve('unreachable')
      })
      req.on('error', () => resolve('unreachable'))
      req.end()
    } catch {
      resolve('unreachable')
    }
  })
}

/** 本插件拉起的服务进程树根（Windows＝wscript 隐藏控制台树根；POSIX＝detached 进程组组长）。 */
export interface ManagedProc {
  pid: number
  port: number
  profile: string
  startedAt: number
}

/**
 * 受管注册表文件（%TEMP% 域，与启动日志同生命周期）：系统重启即失效——pid 语义本就不该跨重启存活。
 * 仅存「本插件亲手拉起」的进程根；「重启服务」/端口清理据此把可杀范围收紧到受管集合。
 */
export function managedRegistryFile(base: string = tmpdir()): string {
  return join(base, 'dsh-obsidian-managed.json')
}

/** pid 是否存活（signal 0 探测；EPERM＝存在但无权限，按存活处理）。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

/** 读受管注册表（缺文件/坏 JSON＝空表；结构校验逐条过滤）。 */
export function readManagedProcs(file: string = managedRegistryFile()): ManagedProc[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is ManagedProc => {
      const rec = r as Partial<ManagedProc>
      return Number.isInteger(rec.pid) && (rec.pid as number) > 0 && Number.isInteger(rec.port)
    })
  } catch {
    return []
  }
}

function writeManagedProcs(rows: readonly ManagedProc[], file: string): void {
  try {
    writeFileSync(file, JSON.stringify(rows.slice(-30)), 'utf8')
  } catch {
    // 注册表写失败不影响服务；最坏情况重启/端口清理退化为确认路径
  }
}

/** 登记受管进程（按 pid 去重）。 */
export function registerManagedProc(entry: ManagedProc, file: string = managedRegistryFile()): void {
  const rows = readManagedProcs(file).filter((r) => r.pid !== entry.pid)
  rows.push(entry)
  writeManagedProcs(rows, file)
}

/** 注销受管进程（子进程 exit 回调调用）。 */
export function unregisterManagedProc(pid: number, file: string = managedRegistryFile()): void {
  const rows = readManagedProcs(file)
  const kept = rows.filter((r) => r.pid !== pid)
  if (kept.length !== rows.length) writeManagedProcs(kept, file)
}

/** 指定端口的受管 pid 列表（顺带清理死 pid 条目）。 */
export function managedPidsForPort(port: number, file: string = managedRegistryFile()): number[] {
  const rows = readManagedProcs(file)
  const alive = rows.filter((r) => isPidAlive(r.pid))
  if (alive.length !== rows.length) writeManagedProcs(alive, file)
  return alive.filter((r) => r.port === port).map((r) => r.pid)
}

/** 全进程表的一行（pid/父 pid/命令行）。 */
export interface ProcRow {
  pid: number
  ppid: number
  cmd: string
}

/** 一次全表查询取 pid/ppid/cmdline（win32 单条 Get-CimInstance；POSIX ps -eo）；失败返回 null。 */
async function readProcTable(): Promise<ProcRow[] | null> {
  if (process.platform === 'win32') {
    const r = await runQuiet('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
    ], 20000)
    const trimmed = r.out.trim()
    if (!r.ok || trimmed === '') return null
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => {
        const rec = row as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown }
        return {
          pid: Number(rec.ProcessId ?? 0),
          ppid: Number(rec.ParentProcessId ?? 0),
          cmd: typeof rec.CommandLine === 'string' ? rec.CommandLine : '',
        }
      })
      return rows.filter((row) => Number.isInteger(row.pid) && row.pid > 0)
    } catch {
      return null
    }
  }
  const r = await runQuiet('ps', ['-eo', 'pid=,ppid=,args='], 10000)
  if (!r.ok) return null
  const out: ProcRow[] = []
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m !== null) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? '' })
  }
  return out.length > 0 ? out : null
}

/** 纯函数：自 pid 起沿父链上溯（含自身；环保护、深度上限 32）；起点不在表中返回空数组。 */
export function ancestorChain(rows: readonly ProcRow[], pid: number): ProcRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const chain: ProcRow[] = []
  const seen = new Set<number>()
  let current = byPid.get(pid)
  for (let hops = 0; current !== undefined && hops < 32; hops += 1) {
    if (seen.has(current.pid)) break
    seen.add(current.pid)
    chain.push(current)
    if (current.ppid <= 0 || current.ppid === current.pid) break
    current = byPid.get(current.ppid)
  }
  return chain
}

/** 端口占用裁决三态（纯函数，v2.6.0 端口安全核心） */
export type PortOwnerVerdict = 'kill' | 'external' | 'ignore'

/**
 * 占用者处置判定：受管 ∧ 身份确证（DSH 白名单或 dsh-launch-* 树根）→ 杀；
 * 非受管但确证 DSH（如 desktop 版实例）→ external（绝不杀，交调用方引导改端口）；
 * 其余（无关进程 / 注册表命中但命令行对不上＝pid 复用）→ ignore。
 */
export function portOwnerVerdict(ownerCmd: string, isManaged: boolean): PortOwnerVerdict {
  const dsh = DSH_CMD_RE.test(ownerCmd) || /dsh-launch-/.test(ownerCmd)
  if (isManaged) return dsh ? 'kill' : 'ignore'
  return dsh ? 'external' : 'ignore'
}

/** 端口获取结果：free=空闲（或被杀后已让位）；killed=清理过受管残留；external=被外部 DSH 占用（未动它）。 */
export type PortAcquisition = 'free' | 'killed' | 'external'

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await runQuiet('taskkill', ['/pid', String(pid), '/T', '/F'], 10000)
    return
  }
  try {
    process.kill(-pid, 'SIGKILL') // spawn 时 detached=setsid：优先整组回收
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
}

/**
 * 拉起服务前的端口裁决（v2.6.0）：只清理**本插件拉起**的残留（占用者父链命中受管注册表），
 * 被外部 DSH 实例（desktop 版等）占用时返回 'external' 且**绝不杀**——多 profile 协同的底线。
 * 查询失败保守按 'free'（真正 EADDRINUSE 会体现为 spawn 退出，由 ensureOnline 轮询兜住）。
 */
export async function acquirePort(port: number, managedPids: readonly number[] = []): Promise<PortAcquisition> {
  const owners = portOwnerPids(port)
  if (owners.length === 0) return 'free'
  const table = await readProcTable()
  if (table === null) return 'free'
  const byPid = new Map(table.map((r) => [r.pid, r]))
  const managedSet = new Set(managedPids)
  let killed = 0
  let external = false
  for (const owner of owners) {
    const isManaged = ancestorChain(table, owner).some((r) => managedSet.has(r.pid))
    const verdict = portOwnerVerdict(byPid.get(owner)?.cmd ?? '', isManaged)
    if (verdict === 'kill') {
      await killProcessTree(owner)
      killed += 1
    } else if (verdict === 'external') {
      external = true
    }
  }
  if (external) return 'external'
  return killed > 0 ? 'killed' : 'free'
}

/**
 * 终止指定端口上**已登记受管**的进程树（作用域重启内核，v2.6.0）：
 * 杀前对每个 pid 双校验（存活 ∧ 命令行命中 DSH_CMD_RE 或 dsh-launch-* 树根特征），任一不过一律跳过——
 * 防 pid 复用；注册表仅存活于 %TEMP%，本函数永不触碰外部 DSH 实例。返回实际终止数。
 */
export async function killManagedForPort(port: number, file: string = managedRegistryFile()): Promise<number> {
  const entries = readManagedProcs(file).filter((r) => r.port === port)
  if (entries.length === 0) return 0
  const table = await readProcTable()
  let killed = 0
  for (const e of entries) {
    if (!isPidAlive(e.pid)) {
      unregisterManagedProc(e.pid, file)
      continue
    }
    const cmd = table?.find((r) => r.pid === e.pid)?.cmd ?? ''
    if (cmd === '' || !(DSH_CMD_RE.test(cmd) || /dsh-launch-/.test(cmd))) continue
    await killProcessTree(e.pid)
    unregisterManagedProc(e.pid, file)
    killed += 1
  }
  return killed
}

/**
 * 确保自定义 profile 存在（v2.6.0；DSH 不自动创建自定义 profile——boot 直接报
 * `profile "x" does not exist`，见 profile-boot：名称不得占用内置模板、目录已存在报错）。
 * 创建用 `dsh --profile <p> --from-default-profile web --dump-default-config`：
 * dump-config 分支组合后即退出（runDumpConfig → prepareProfile → initializeProfileFromDefault），
 * **不能**用裸启动形态——那会连服务一起 boot。
 * @returns kind：exists=已存在/内置；created=本次代建成功；failed=失败（附原因）
 */
export type ProfileEnsure = { kind: 'exists' } | { kind: 'created' } | { kind: 'failed'; error: string }

/**
 * 从外部命令输出里挑一条**给用户看**的错误行（v2.6.0 沙盒用例 S2.4 抓出）。
 *
 * 为什么不取「首个非空行」：dsh 抛未捕获异常时 stderr 的版式固定是栈定位在前——
 * 实测（0.1.5-rc.2，`--profile headless --from-default-profile web --dump-default-config`）：
 *   1| file:///…/lib/profile-boot-Dk-7KqJc.js:149
 *   2| \tif (Object.hasOwn(PROFILE_TEMPLATES, name)) throw new Error(...)
 *   3| \t                                                  ^
 *   5| Error: dsh: profile "headless" is shipped and cannot be a custom profile target; …
 *   6|     at initializeProfileFromDefault (file:///…) …
 *  13| Node.js v24.14.1
 * 取首行会把第 5 行的人话句整段吞掉（沙盒用例 S2.4 抓出）。故：优先 `Error:` 行（剥前缀），
 * 否则取首个非栈帧行（跳过 file:// 定位、代码摘录、脱字符、`at ` 帧、Node.js 版本行）。
 */
export function pickErrorLine(text: string): string {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const thrown = lines.find((l) => /^[A-Za-z]*Error:\s/i.test(l))
  if (thrown) return thrown.replace(/^[A-Za-z]*Error:\s*/i, '')
  const frame = /^(file:\/\/|\^+$|at\s|node\.js\s+v\d)/i
  const prose = lines.find((l) => !frame.test(l))
  return prose ?? lines[0] ?? ''
}

export async function ensureProfile(
  home: string,
  profile: string,
  exec: typeof execFile = execFile,
): Promise<ProfileEnsure> {
  const p = (profile ?? '').trim()
  if (p === '' || p === 'web') return { kind: 'exists' }
  const pkg = join(home, 'profiles', p, 'package.json')
  if (existsSync(pkg)) return { kind: 'exists' }
  // 内置模板名（acp/headless/sdk/sdk-minimal）不可作自定义 profile：DSH 会抛栈，这里提前拦下并给人话提示。
  if (isReservedProfile(p)) return { kind: 'failed', error: t('settings.profile.reserved', { name: p }) }
  const args = ['--profile', p, '--from-default-profile', 'web', '--dump-default-config']
  let resolved: { command: string; args: string[] }
  try {
    resolved = resolveExec(process.platform, 'dsh', args)
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
  return new Promise((resolve) => {
    exec(
      resolved.command,
      resolved.args,
      { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, DSH_HOME: home } },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve(existsSync(pkg)
            ? { kind: 'created' }
            : { kind: 'failed', error: 'profile was not created' })
          return
        }
        const msg =
          pickErrorLine(String(stderr ?? '')) || pickErrorLine(String(stdout ?? '')) || err.message
        // 并发/竞态兜底：已存在且清单在 → 视为存在
        resolve(/already exists/i.test(msg) && existsSync(pkg)
          ? { kind: 'exists' }
          : { kind: 'failed', error: msg })
      },
    )
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
      acquirePort: deps?.acquirePort ?? ((p, managed) => acquirePort(p, managed)),
      killManaged: deps?.killManaged ?? ((p) => killManagedForPort(p)),
    }
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  }

  /** 本服务所属 profile（注册表条目字段）。 */
  private profileName(): string {
    return this.opts.profile === undefined || this.opts.profile === '' ? 'web' : this.opts.profile
  }

  /** 当前受管 pid 集合：注册表（全端口）+ 本会话子进程根。 */
  private managedPids(): number[] {
    const set = new Set(readManagedProcs().map((r) => r.pid))
    const childPid = this.child?.pid
    if (childPid !== undefined) set.add(childPid)
    return [...set]
  }

  /** 探测一次服务是否在线。 */
  async probe(): Promise<boolean> {
    return this.deps.probe(this.opts.port)
  }

  /**
   * 等待端口真正释放（v2.4.4）：杀掉旧进程后立刻 `ensureOnline()` 会踩到"旧进程仍在应答"的竞态
   * （判为 online → 不拉起新服务 → 面板白屏；再重启一次才正常）。这里轮询到端口不再应答为止。
   * 返回 true 表示已释放；false 表示超时仍被占用（交由调用方决定是否继续）。
   */
  async waitPortFree(timeoutMs = 12000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!(await this.probe())) return true
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  /**
   * 面板是否需要认证（v2.4.4 三态）：'auth' 必须先拿到启动 token 才能内嵌；
   * 'open' 可直接嵌入；'unknown' 探测失败（调用方按"保守等待"处理）。
   */
  async panelNeedsAuth(): Promise<PanelAuthProbe> {
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
   * v2.6.0：拉起前经 acquirePort 裁决端口——只清受管残留；被外部 DSH（如 desktop 实例）
   * 占用时明确失败并提示改端口，**绝不**终止外部实例（多 profile 协同底线）。
   */
  async ensureOnline(): Promise<DshServiceState> {
    if (await this.probe()) {
      return { kind: 'online' }
    }
    if (!this.opts.autoStart) {
      return { kind: 'failed', message: t('svc.ensureOffline', { port: this.opts.port }) }
    }
    const acquisition = await this.deps.acquirePort(this.opts.port, this.managedPids())
    if (acquisition === 'external') {
      return { kind: 'failed', message: t('svc.portOwnedByExternal', { port: this.opts.port }) }
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
    // v2.6.0：端口残留清理已上移到 ensureOnline 的 acquirePort（受管判定，绝不误杀外部实例）；
    // 直接调 start() 的调用方（如测试）不经清理——spawn 失败会以退出码形式被轮询捕获。
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
    // v2.6.0：登记受管进程树根（Windows＝wscript；POSIX＝setsid 组长）——重启/端口清理只认这份名单
    const rootPid = child.pid
    if (rootPid !== undefined && rootPid > 0) {
      registerManagedProc({ pid: rootPid, port: this.opts.port, profile: this.profileName(), startedAt: Date.now() })
    }
    child.on('exit', (code: number | null) => {
      this.child = null
      if (rootPid !== undefined && rootPid > 0) unregisterManagedProc(rootPid)
      if (code !== 0 && code !== null) {
        this.spawnError = this.spawnError ?? t('svc.exited', { code })
      }
    })
    child.on('error', (err: Error) => {
      this.spawnError = err.message
      this.child = null
      if (rootPid !== undefined && rootPid > 0) unregisterManagedProc(rootPid)
    })
  }

  /**
   * v2.6.0 作用域重启（取代旧「全机杀所有 DSH 进程」的常规重启语义）：
   * 只终止受管（本插件登记拉起）的端口残留；杀完等端口真正释放（v2.4.4 竞态教训保留）。
   * @returns 'ok'＝端口已可为新进程让位（含本来就空闲）；'external'＝端口在线但占用者非受管
   * （外部 DSH 实例/升级前遗留的无注册表旧实例）——调用方据此走确认路径，不静默杀。
   */
  async restartManaged(waitFreeMs: number = 12000): Promise<'ok' | 'external'> {
    const killed = await this.deps.killManaged(this.opts.port)
    if (killed === 0) {
      // 无受管残留：端口没人应答直接放行；有应答说明占用者不是本插件拉起的 → 交给调用方确认
      return (await this.probe()) ? 'external' : 'ok'
    }
    const free = await this.waitPortFree(waitFreeMs)
    if (free) return 'ok'
    // 杀过受管进程但端口仍应答：多半还有第二个非受管占用者（如旧版插件时代残留/外部实例）
    return (await this.probe()) ? 'external' : 'ok'
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
