/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (process/fs/os/path/child_process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * 外部命令执行的环境（PATH）合并层 —— v2.8.11 从 installer 私有实现提取为共享模块。
 *
 * 为什么必须有这一层（macOS 侧的真实故障，GitHub issue #16）：
 * 从 Dock/访达启动的 macOS 应用由 launchd 拉起，`process.env.PATH` 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，**不含** `/opt/homebrew/bin`（Homebrew）与 nvm/volta 目录。
 * 于是 `spawn('npm', …)` / `execFileSync('which', ['dsh'])` 一律 ENOENT，
 * 而同一命令在 Terminal 里正常。重启 Obsidian 无法改变这一点（GUI 进程的 PATH 与登录 shell 无关，
 * 仅 `/etc/paths*` 经 path_helper 在登录 shell 生效）——旧文案把用户引向「重装/重启」死胡同。
 *
 * 为什么要**共享**而不是从 installer 导出：`installer.ts` 已 `import { profileStartupCommand, repoStartupTail }
 * from './service-manager'`；若 service 侧反向 import installer，会构成 `service-manager ⇄ installer` 循环。
 * 本模块只依赖 node 内置模块，任何一方引用都不成环。
 *
 * 语义（与旧 installer 实现的差异，见 mergePaths）：合并而非替换——父进程 PATH 在前、常见目录在后、去重去空段。
 * Windows 侧旧实现用注册表值**替换**当前 PATH（用于「winget 装完免重启」的依赖探测）；
 * 用于 spawn 时有回归风险：从终端启动的 Obsidian 会丢掉本地追加的 PATH 项。并集对两者都成立
 * （新装的工具在注册表里，查找扫全表），故统一为并集。
 *
 * 全部函数接受可注入选项（platform/env/homeDir/exists/readDir）：darwin 分支因此能在
 * Windows/Linux 上被单测锁定（本仓 CI 只有 ubuntu，单测是唯一可自动化的回归手段）。
 */
export interface ExecEnvOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  exists?: (path: string) => boolean
  readDir?: (path: string) => string[]
  /** Windows 注册表 PATH 读取（真实实现走 powershell；测试注入以避免真实子进程）。 */
  readWindowsRegistryPath?: () => string
  /**
   * 本次合并使用的**登录 shell PATH**（v2.8.11）。
   * 缺省＝模块级已捕获值（见 `captureLoginShellPathAsync`）；显式传 `''` 表示不使用。
   * 注：只要传了任何注入选项（单测/平台模拟），缺省即**不使用**已捕获值，避免测试被真实会话状态污染。
   */
  shellPath?: string
}

/** PATH 合并分隔符（Windows 用 `;`，POSIX 用 `:`）。 */
function pathSeparator(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

/**
 * POSIX 路径拼接：**故意不用 `path.join`** —— `path.join` 用宿主平台分隔符，
 * 于是在 Windows 上跑 darwin 分支（单测正是这么做的）会产出 `\Users\u\.nvm\...` 这种反斜杠路径。
 * 本模块的 POSIX 分支按定义只产出 POSIX 路径。
 */
function posixJoin(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
}

/**
 * 合并 PATH 段：父进程 PATH 在前（保留用户已有环境与既有优先级），其后追加候选目录，
 * 去空段与重复项。
 *
 * 去空段是必须的：`[:先加入的 extras]` 里的空段在 POSIX 下等价于**当前目录**，
 * 会意外让 cwd 内的同名可执行文件被优先命中。
 */
export function mergePaths(current: string, extras: readonly string[], separator: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [...current.split(separator), ...extras]) {
    const p = part.trim()
    if (p === '' || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out.join(separator)
}

/** 版本号三段比较（仅用于在 nvm 目录里挑最新的 node；非严格 semver，够用即可）。 */
export function compareNodeVersion(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * nvm 已安装的 node bin 目录（`<nvm>/versions/node/v22.11.0/bin`），按版本号**升序**返回。
 * 目录不存在/不可读时返回空数组（无 nvm 的机器是常态，不能因此报错）。
 */
export function nvmNodeBinDirs(
  nvmBase: string,
  readDir: (path: string) => string[] = readdirSync,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (nvmBase === '') return []
  let names: string[]
  try {
    names = readDir(posixJoin(nvmBase, 'versions', 'node'))
  } catch {
    return []
  }
  return names
    .filter((n) => /^v?\d+\.\d+\.\d+/.test(n))
    .sort(compareNodeVersion)
    .map((n) => posixJoin(nvmBase, 'versions', 'node', n, 'bin'))
    .filter((p) => exists(p))
}

/**
 * nvm 已安装版本的**全局 node_modules 根**（`<nvm>/versions/node/<v>/lib/node_modules`，新版本在前）。
 * 用途：`npm root -g` 之外的兜底（npm 起不来时仍能定位全局 DSH 包），也是 issue #16 里
 * 「nvm 装的全局 dsh 找不到」的一端。
 */
export function nvmGlobalModuleRoots(opts: ExecEnvOptions = {}): string[] {
  const env = opts.env ?? process.env
  const home = opts.homeDir ?? homedir()
  const readDir = opts.readDir ?? readdirSync
  const exists = opts.exists ?? existsSync
  const nvmEnvDir = (env.NVM_DIR ?? '').trim()
  const nvmBase = nvmEnvDir !== '' ? nvmEnvDir : posixJoin(home, '.nvm')
  return nvmNodeBinDirs(nvmBase, readDir, exists)
    .reverse()
    .map((bin) => bin.replace(/\/bin$/, '/lib/node_modules'))
}

/**
 * POSIX（macOS/Linux）需要补进 PATH 的常见工具目录（按优先级排列，仅返回真实存在的）。
 *
 * 排序理由：**版本管理器优先于包管理器**。装了 nvm/volta/fnm 的用户，其终端里的 node 由它们决定；
 * 若把 brew 目录排在前面，插件会用另一个 node/npm 起服务（与用户终端不一致，
 * 甚至落到另一个 DSH 全局 CLI 版本上——而版本显示优先读 `/opt/homebrew/lib/node_modules`，
 * 两边还会互相矛盾）。
 *
 * 覆盖范围说明：nvm 取「已安装的最新版本」（不读 `alias/default`：那里可能是 `lts/*` 之类的
 * 间接值，解析成本高于收益；任何 ≥22 的 node 都足以跑 DSH）。fnm/volta/pnpm/yarn/bun 取各自默认目录。
 */
export function posixPathExtras(opts: ExecEnvOptions = {}): string[] {
  const env = opts.env ?? process.env
  const home = opts.homeDir ?? homedir()
  const exists = opts.exists ?? existsSync
  const readDir = opts.readDir ?? readdirSync

  const dirs: string[] = []
  const nvmBin = (env.NVM_BIN ?? '').trim()
  if (nvmBin !== '') dirs.push(nvmBin)
  const nvmEnvDir = (env.NVM_DIR ?? '').trim()
  const nvmBase = nvmEnvDir !== '' ? nvmEnvDir : posixJoin(home, '.nvm')
  // 新版本在前：nvmNodeBinDirs 升序，故此处反转
  dirs.push(...nvmNodeBinDirs(nvmBase, readDir, exists).reverse())
  dirs.push(posixJoin(home, '.volta', 'bin'))
  dirs.push(posixJoin(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin')) // fnm（macOS）
  dirs.push(posixJoin(home, '.fnm', 'aliases', 'default', 'bin')) // fnm（Linux）
  dirs.push(posixJoin(home, '.asdf', 'shims'))
  dirs.push('/opt/homebrew/bin') // Apple Silicon brew
  dirs.push('/opt/homebrew/sbin')
  dirs.push('/usr/local/bin') // Intel brew / 常见安装
  dirs.push('/usr/local/sbin')
  dirs.push(posixJoin(home, 'Library', 'pnpm')) // pnpm setup（macOS）
  dirs.push(posixJoin(home, '.local', 'share', 'pnpm')) // pnpm setup（Linux）
  dirs.push(posixJoin(home, '.yarn', 'bin'))
  dirs.push(posixJoin(home, '.bun', 'bin'))
  dirs.push(posixJoin(home, '.local', 'bin'))
  dirs.push(posixJoin(home, 'bin'))
  return dirs.filter((d) => d !== '' && exists(d))
}

/** Windows：读注册表 Machine+User 的 PATH 并展开变量（winget 装完当前会话立即可见，无需重启）。失败返回空串。 */
function readWindowsRegistryPath(): string {
  try {
    const script =
      "[Environment]::ExpandEnvironmentVariables(([Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')))"
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    ).trim()
  } catch {
    // 注册表/PowerShell 不可用时视为无补充（保留当前 PATH）
    return ''
  }
}

/** 登录 shell 捕获到的 PATH（'' = 未捕获/不可用；仅由 `captureLoginShellPathAsync` 写入）。 */
let capturedShellPath = ''

/**
 * 本次计算要用的登录 shell PATH（见 ExecEnvOptions.shellPath 的缺省语义）。
 * 只在**未传任何注入选项**时才读取模块级捕获值——单测的平台模拟因此不会被真实会话状态污染。
 */
function effectiveShellPath(opts: ExecEnvOptions): string {
  if (opts.shellPath !== undefined) return opts.shellPath
  if (Object.keys(opts).length > 0) return ''
  return capturedShellPath
}

/** 计算合并后的 PATH（不走缓存；供 `refreshedPath` 与单测使用）。 */
export function computeRefreshedPath(opts: ExecEnvOptions = {}): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const current = env.PATH ?? env.Path ?? ''
  if (platform === 'win32') {
    const registry = (opts.readWindowsRegistryPath ?? readWindowsRegistryPath)()
    return mergePaths(current, registry === '' ? [] : registry.split(';'), pathSeparator(platform))
  }
  // 登录 shell PATH 排在最前：它才是用户终端里的真实取值（nvm alias/default、自定义 PATH），
  // 优先级必须高于 GUI 继承的最小 PATH 与静态 extras 猜测。
  const shellPath = effectiveShellPath(opts)
  const base = shellPath === '' ? current : mergePaths(shellPath, [current], pathSeparator(platform))
  return mergePaths(base, posixPathExtras(opts), pathSeparator(platform))
}

let cachedPath: string | undefined

/**
 * 丢弃合并 PATH 的缓存。
 * 必须调用的时机：①一键安装补齐依赖后（否则复检仍用安装前的陈旧 PATH 误报「依赖仍缺失」）；
 * ②spawn 报 ENOENT 时（用户可能在 Obsidian 启动之后才装好 node/pnpm——缓存不失效就只剩「重启 Obsidian」一条路）。
 */
export function invalidateRefreshedPath(): void {
  cachedPath = undefined
}

/**
 * 合并后的 PATH（带缓存）。
 * 仅当**未传任何注入选项**时读写缓存：单测用注入参数计算 darwin 分支时不得污染真实缓存。
 */
export function refreshedPath(opts: ExecEnvOptions = {}): string {
  const cacheable = Object.keys(opts).length === 0
  if (cacheable && cachedPath !== undefined) return cachedPath
  const path = computeRefreshedPath(opts)
  if (cacheable) cachedPath = path
  return path
}

/**
 * 供子进程使用的合并环境。
 * 同时写 `PATH` 与 `Path`：历史上有 libuv/Node 在「只给其中一个」时找不到可执行文件的报告
 * （libuv#4783 / node#58290 / node#55374）；本机实测 Node 24.14.1 两种写法均可，
 * 双写属兼容性保险，成本为零故保留。
 */
export function refreshedEnv(opts: ExecEnvOptions = {}): NodeJS.ProcessEnv {
  const env = opts.env ?? process.env
  const path = refreshedPath(opts)
  return { ...env, PATH: path, Path: path }
}

/**
 * 通过 PATH 探测命令是否可用（全仓唯一实现）。
 *
 * `which`/`where` 自身由父进程 PATH 解析（macOS 的 `/usr/bin/which`、Windows 的 System32 都在系统最小 PATH 内），
 * 被探测的**目标命令**则用合并后的 PATH——这正是 GUI 启动场景下旧实现看不到 brew/nvm 里工具的原因。
 */
export function hasBin(name: string, opts: ExecEnvOptions = {}): boolean {
  const platform = opts.platform ?? process.platform
  const probe = platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [name], { stdio: 'ignore', env: refreshedEnv(opts) })
    return true
  } catch {
    return false
  }
}

// ---- 登录 shell PATH 捕获（v2.8.11 第二步：nvm alias/default 与自定义 PATH 的完全解）----

/**
 * 为什么要抓登录 shell 的 PATH：静态 extras 只能"猜"常见目录，猜不到
 * ① nvm 的 `alias/default`（用户可能默认用 v20 而目录里最新是 v22）、② volta/fnm 的软链解析、
 * ③ 用户在自己 rc 里手工拼的 PATH。GUI 应用启动时唯一能拿到"用户终端真实 PATH"的办法，
 * 就是让$SHELL 以**登录+交互**方式跑一句 `printf %s "$PATH"`（VS Code 等 GUI 应用同样做法）。
 *
 * 风险与处置（都必须有，否则一个卡住的 rc 会拖死启动）：
 * - 交互式 rc 可能很慢或等待输入 ⇒ `execFile` 的 `timeout` 到点杀进程，失败按"无捕获"处理；
 * - rc 可能往 stdout 打横幅/提示 ⇒ 取**最后一行**并做 PATH 形状校验（`parseShellPath`）；
 * - stdin/stdout 都不写回用户终端 ⇒ 读 rc 的提示不会卡在无 tty 的等待上（超时兜底）。
 *
 * 边界：**仅 POSIX**。Windows GUI 进程的 PATH 来自注册表（已由 `readWindowsRegistryPath` 覆盖），
 * 不存在"与登录 shell 不一致"的问题，故 win32 直接返回空串、不起子进程。
 */
export type ShellRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ ok: boolean; out: string }>

/** 登录 shell 捕获的选项（在 ExecEnvOptions 之上）。 */
export interface LoginShellOptions extends ExecEnvOptions {
  /** 指定 shell（缺省 `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`，取首个存在的）。 */
  shell?: string
  /** 超时（缺省 {@link LOGIN_SHELL_TIMEOUT_MS}）。 */
  timeoutMs?: number
  /** 注入的 shell 执行器（测试用；缺省 `execFile`）。 */
  runShell?: ShellRunner
  /** 绕过「本会话只抓一次」的记忆，强制重抓（例如 ENOENT 重试后用户又装了新工具）。 */
  force?: boolean
}

/** 登录 shell 捕获超时：正常 0.2–1s（zsh+插件），慢机器/重插件留 5s 上限。 */
export const LOGIN_SHELL_TIMEOUT_MS = 5000

/**
 * 从 shell 输出里取 PATH：取**最后一行**（前面可能有横幅/提示），并做形状校验。
 * 校验不通过返回空串——宁可回落到静态 extras，也不能把半截输出当 PATH 用。
 */
export function parseShellPath(output: string): string {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const last = lines.length > 0 ? lines[lines.length - 1] ?? '' : ''
  if (last === '' || last.length > 8192) return ''
  // 控制字符（含 tab/ESC 着色）= 不是干净 PATH。逐个码点扫，避免 no-control-regex（审查规则禁字符类正则）
  for (const ch of last) {
    if ((ch.codePointAt(0) ?? 0) < 32) return ''
  }
  const segments = last.split(':').filter((s) => s !== '')
  // 至少两个绝对路径段才算 PATH（拦掉提示符行、单目录输出、报错文本）
  if (segments.filter((s) => s.startsWith('/')).length < 2) return ''
  return last
}

/** 选中用于捕获的 shell：显式指定 → `$SHELL` → zsh → bash → sh，取首个存在的。 */
export function resolveLoginShell(opts: LoginShellOptions = {}): string {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const candidates = [opts.shell, (env.SHELL ?? '').trim(), '/bin/zsh', '/bin/bash', '/bin/sh']
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && exists(candidate)) return candidate
  }
  return ''
}

/** 默认执行器：`execFile`（timeout 到点自动杀进程；`maxBuffer` 防 rc 刷爆内存）。 */
function defaultShellRunner(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          cwd: opts.cwd,
          env: opts.env,
          encoding: 'utf8',
          timeout: opts.timeoutMs,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        (err: Error | null, stdout: string) => {
          resolve({ ok: err === null, out: String(stdout ?? '') })
        },
      )
    } catch {
      resolve({ ok: false, out: '' })
    }
  })
}

/** 一次捕获（不做记忆）。 */
async function runLoginShellCapture(opts: LoginShellOptions): Promise<string> {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') return ''
  const shell = resolveLoginShell(opts)
  if (shell === '') return ''
  const run = opts.runShell ?? defaultShellRunner
  let result: { ok: boolean; out: string }
  try {
    result = await run(shell, ['-ilc', 'printf %s "$PATH"'], {
      cwd: opts.homeDir ?? homedir(),
      env: opts.env ?? process.env,
      timeoutMs: opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
    })
  } catch {
    // 执行器自身抛错（spawn ENOENT 等）：按"无捕获"处理，绝不冒泡到启动路径
    return ''
  }
  if (!result.ok) return ''
  return parseShellPath(result.out)
}

let shellPathPromise: Promise<string> | null = null

/**
 * 捕获登录 shell 的真实 PATH（本会话只跑一次，失败也记忆——避免每次探测都白等 5s）。
 * 结果同时写入模块级 `capturedShellPath`（`refreshedPath()` 会把它并到最前面）。
 * 只在**未传注入选项**时读写记忆；`force: true` 可强制重抓。
 */
export function captureLoginShellPathAsync(opts: LoginShellOptions = {}): Promise<string> {
  const cacheable = Object.keys(opts).length === 0 || opts.force === true
  if (cacheable && opts.force !== true && shellPathPromise !== null) return shellPathPromise
  const promise = runLoginShellCapture(opts)
  if (Object.keys(opts).filter((k) => k !== 'force').length === 0) {
    shellPathPromise = promise
    void promise.then((value) => {
      capturedShellPath = value
      invalidateRefreshedPath()
    })
  }
  return promise
}

/**
 * 清空捕获记忆（测试与"用户重装/换 shell"后强制重抓用）。
 * 注意不等同于 `invalidateRefreshedPath()`：后者只重算合并结果，不会重跑 shell。
 */
export function clearLoginShellPathCache(): void {
  shellPathPromise = null
  capturedShellPath = ''
  invalidateRefreshedPath()
}

/**
 * 启动前准备执行环境（服务拉起路径调用）：POSIX 上抓一次登录 shell PATH 并刷新合并缓存。
 * 有界（≤ {@link LOGIN_SHELL_TIMEOUT_MS}）且记忆化：第一次之后立即返回；Windows 上是空操作。
 * @returns 捕获到的 PATH（''=不可用/未捕获）
 */
export async function prepareExecEnvAsync(opts: LoginShellOptions = {}): Promise<string> {
  const captured = await captureLoginShellPathAsync(opts)
  if (captured !== '') invalidateRefreshedPath()
  return captured
}

/**
 * 后台预热（fire-and-forget，绝不抛错）：插件 onload 时调用，让随后的**同步**探测
 * （`detectStartupCommand` / `hasBin` / `isDshInstalled`）也能用上真实 PATH。
 * 绝不阻塞加载路径（`ensureNoOpenAdaptive` 同款纪律：慢探测一律异步）。
 */
export function prewarmLoginShellPath(): void {
  try {
    void captureLoginShellPathAsync().catch(() => '')
  } catch {
    // 预热失败不影响任何主流程
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
