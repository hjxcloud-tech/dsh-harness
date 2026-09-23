/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (process/fs/path/child_process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from './i18n'
import { isOfficialDshCheckout, readDshPackageIdentity } from './dsh-identity'

/** 检测选项（测试可注入）。 */
export interface DetectOptions {
  homeDir?: string
  /** 完全接管候选目录列表（缺省用 defaultCandidates）。 */
  candidates?: string[]
  hasBin?: (name: string) => boolean
  /** v2.6.0：目标 profile（缺省 web）。非 web 时生成 `dsh --profile <p> …` 主程序形态命令。 */
  profile?: string
}

/** 一键检测结果。 */
export interface DetectResult {
  found: boolean
  startupCommand: string
  startupCwd: string
  message: string
}

function defaultHasBin(name: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 判断目录是否为 DeepSeek Harness **本体**（v2.6.0 收紧）：
 * ① package.json 的包名属官方白名单（`@deepseek-ai/dsh` 或仓库根 `@deepseek-ai/dsh-root`）；
 * ② 否则只在「官方源码检出」形状成立时兜底（目录名 deepseek-harness + pnpm-workspace.yaml + apps/cli/src/bin.ts）。
 *
 * 旧判据（有 pnpm-workspace.yaml 就算 / package.json 里有 dsh 脚本就算）会把任何 pnpm monorepo
 * 与第三方 dsh 相关包（如 `@x1a0f3n9/dsh-*`，版本号自成一套）误认成本体，导致版本与适配判定全错。
 */
export function isDshRepo(dir: string): boolean {
  if (readDshPackageIdentity(dir) !== null) {
    return true
  }
  return isOfficialDshCheckout(dir)
}

/** 在候选目录中定位 DSH 仓库：返回第一个命中的存在目录，无则 null。 */
export function locateDshRepoDir(candidates: string[]): string | null {
  for (const dir of candidates) {
    if (dir && existsSync(dir) && isDshRepo(dir)) {
      return dir
    }
  }
  return null
}

/** 默认候选目录：当前配置的工作目录、用户主目录、常见盘符/系统路径（按平台）。 */
export function defaultCandidates(cwd: string, homeDir = homedir()): string[] {
  const winPaths = process.platform === 'win32' ? ['D:\\deepseek-harness', 'C:\\deepseek-harness'] : []
  const posixPaths = process.platform === 'darwin' ? ['/opt/deepseek-harness', '/usr/local/deepseek-harness'] : []
  return [...new Set([cwd, join(homeDir, 'deepseek-harness'), ...posixPaths, ...winPaths].filter(Boolean))]
}

/**
 * 一键检测并生成启动配置：
 * 1. PATH 中有 dsh → 直接使用 `dsh web --port {port}`；
 * 2. 否则在候选目录中定位 DSH 仓库 → pnpm 可用用 pnpm，否则 npm；
 * 3. 均未命中 → found=false 并给出指引。
 */
export function detectDshConfig(
  current: { cwd: string },
  opts: DetectOptions = {},
): DetectResult {
  const homeDir = opts.homeDir ?? homedir()
  const hasBin = opts.hasBin ?? defaultHasBin
  const profile = opts.profile ?? 'web'

  if (hasBin('dsh')) {
    // --no-open：DSH 全局 CLI 默认启动时自动打开系统浏览器（openBrowser 默认 true），面板嵌入场景不需要；
    // v2.6.0：非 web profile 必须用 `dsh --profile <p> …` 主程序形态（web 子命令拒收父级 --profile）
    const startupCommand = `dsh${profile === 'web' ? ' web' : ` --profile ${profile}`} --port {port} --no-open`
    return {
      found: true,
      startupCommand,
      startupCwd: current.cwd,
      message: t('detect.path', { port: '{port}' }),
    }
  }

  const repoDir = locateDshRepoDir(opts.candidates ?? defaultCandidates(current.cwd, homeDir))
  if (!repoDir) {
    return {
      found: false,
      startupCommand: '',
      startupCwd: '',
      message: t('detect.notFound'),
    }
  }

  // 仓库形态：`pnpm dsh …` / `npm run dsh -- …` 的「dsh」由各包管理器前缀承载，此处只拼 dsh 之后的尾段
  const bin = profile === 'web' ? 'web' : `--profile ${profile}`
  const command = hasBin('pnpm') ? `pnpm dsh ${bin} --port {port}` : `npm run dsh -- ${bin} --port {port}`
  return {
    found: true,
    startupCommand: command,
    startupCwd: repoDir,
    message: t('detect.found', { dir: repoDir, cmd: command }),
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
