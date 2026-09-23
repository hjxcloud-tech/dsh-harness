/**
 * DSH 本体身份判定（v2.6.0）。
 *
 * 为什么需要这一层：插件此前用「目录里有 pnpm-workspace.yaml / package.json 有 dsh 脚本 / package.json 的 version」
 * 这类**形状证据**认 DSH，于是任何第三方 dsh 相关包（实测存在 `@x1a0f3n9/dsh-web-app`、
 * `@x1a0f3n9/dsh-client-connection` 等社区 scope，版本号自成一套，如 0.1.5-rc.3——官方核心包 0.1.5 系只发过
 * rc.1 与 rc.2）都可能被当成本体：版本读错 → 适配判定错 → 弹「不适配」窗误导用户，更新/降级建议也跟着错。
 *
 * 判据一律改为**包名身份**（官方 scope + 已知核心/根包名），形状证据只作源码检出的兜底。
 * 实测事实源（2026-09-22，本机）：
 * - 全局 CLI：`<npm root -g>/@deepseek-ai/dsh/package.json` → `name=@deepseek-ai/dsh`、`version=0.1.5-rc.2`（与 `dsh --version` 一致）；
 * - 源码仓库：`D:\deepseek-harness\package.json` → `name=@deepseek-ai/dsh-root`、`version=0.1.1-rc.2`、`scripts.dsh=node --import tsx/esm apps/cli/src/bin.ts`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 官方核心包（全局 CLI 形态的本体）。 */
export const OFFICIAL_DSH_PACKAGE = '@deepseek-ai/dsh'
/** 官方源码仓库根包名（仓库形态的本体，现行）。 */
export const OFFICIAL_DSH_ROOT_PACKAGE = '@deepseek-ai/dsh-root'
/**
 * 官方仓库根包名的**历史写法**（旧克隆用不带 scope 的 `deepseek-harness`）。
 * 收进白名单是兼容性决定：不收，则早期克隆的用户升级插件后突然「检测不到 DSH 仓库」，
 * 会被一键安装引导去重新克隆现有工作目录。第三方包名（`@x1a0f3n9/dsh-*`、裸 `dsh`）仍然一律拒绝。
 */
export const LEGACY_DSH_ROOT_PACKAGE = 'deepseek-harness'
/** 可作为「DSH 本体」的包名白名单（版本读取与仓库判定都只认这几个）。 */
export const OFFICIAL_DSH_NAMES: readonly string[] = [
  OFFICIAL_DSH_PACKAGE,
  OFFICIAL_DSH_ROOT_PACKAGE,
  LEGACY_DSH_ROOT_PACKAGE,
]

/** 是否官方 DSH 本体包名。第三方 scope（如 `@x1a0f3n9/dsh-web-app`）与官方子包（`@deepseek-ai/dsh-web-app`）都不算。 */
export function isOfficialDshPackageName(name: unknown): boolean {
  if (typeof name !== 'string') return false
  return OFFICIAL_DSH_NAMES.includes(name.trim())
}

/**
 * 名字「像 dsh」但不是官方本体——用于日志与提示（例如告诉用户检测到的是第三方包），不参与任何判定。
 * 覆盖 `@scope/dsh*` 与裸 `dsh*` 两类写法。
 */
export function isThirdPartyDshName(name: unknown): boolean {
  if (typeof name !== 'string') return false
  const n = name.trim()
  if (n === '' || isOfficialDshPackageName(n)) return false
  const bare = n.startsWith('@') ? (n.split('/')[1] ?? '') : n
  return bare.toLowerCase().startsWith('dsh') || n.toLowerCase().includes('deepseek-harness')
}

/** 一个已核验身份的 DSH 包（name 必属官方白名单）。 */
export interface DshPackageIdentity {
  name: string
  version: string
}

/**
 * 版本读数的来源，决定它可不可信：
 * - `official-manifest`：全局官方包的 package.json（最可信，与 PATH 上的 `dsh` 是谁无关）；
 * - `cli`：`dsh --version` 的输出——PATH 上的 `dsh` 可能由第三方包提供，**未核验**；
 * - `repo`：已通过身份核验的源码仓库；
 * - `none`：什么都没读到。
 * 只有 verified 的来源才参与适配判定；未核验的版本仅用于展示，避免拿第三方包的版本号去判 DSH 适配。
 */
export type DshVersionSource = 'official-manifest' | 'cli' | 'repo' | 'none'

/**
 * 读目录内 package.json 并**核验包名**：官方本体返回 {name, version}（version 可能为空串），
 * 其它任何包（含第三方 dsh-*、官方子包、普通项目）一律返回 null。
 */
export function readDshPackageIdentity(dir: string): DshPackageIdentity | null {
  const pkgPath = join(dir, 'package.json')
  if (!dir || !existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
    if (!isOfficialDshPackageName(pkg.name)) return null
    return {
      name: String(pkg.name).trim(),
      version: typeof pkg.version === 'string' ? pkg.version.trim() : '',
    }
  } catch {
    return null
  }
}

/** 读目录内 package.json 的原始包名（不做判定；供日志说明"检测到的是谁"）。 */
export function readPackageName(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof pkg.name === 'string' ? pkg.name : ''
  } catch {
    return ''
  }
}

/**
 * 是否为官方源码检出（无 package.json 或身份不全时的兜底）：
 * 目录名 `deepseek-harness` + `pnpm-workspace.yaml` + `apps/cli/src/bin.ts` 三条同时成立。
 * 只用「有 pnpm-workspace.yaml」判定会把任何 pnpm monorepo（含第三方 dsh fork）误认成本体。
 */
export function isOfficialDshCheckout(dir: string): boolean {
  if (!dir) return false
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return (
    base === 'deepseek-harness' &&
    existsSync(join(dir, 'pnpm-workspace.yaml')) &&
    existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))
  )
}

/**
 * 全局安装的官方包 manifest 路径候选（不额外起子进程，避免拖慢启动路径）。
 * Windows 走 `%APPDATA%\npm\node_modules`（npm 全局默认前缀），POSIX 走常见 prefix 与用户目录。
 */
export function globalDshManifestCandidates(homeDir: string = homedir()): string[] {
  const roots: string[] = []
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? ''
    if (appdata !== '') roots.push(join(appdata, 'npm', 'node_modules'))
    roots.push(join(homeDir, 'AppData', 'Roaming', 'npm', 'node_modules'))
  } else {
    roots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', join(homeDir, '.npm-global', 'lib', 'node_modules'))
  }
  const prefix = (process.env.NPM_CONFIG_PREFIX ?? '').trim()
  if (prefix !== '') roots.push(join(prefix, 'lib', 'node_modules'), join(prefix, 'node_modules'))
  return [...new Set(roots)].map((root) => join(root, '@deepseek-ai', 'dsh', 'package.json'))
}

/**
 * 读全局官方包的版本（身份已核验，不受 PATH 上 `dsh` 是谁提供的影响）。
 * 未安装/读不到返回空串——调用方据此决定是否退回 `dsh --version`（并标记为未核验）。
 */
export function readGlobalDshVersion(homeDir: string = homedir()): string {
  for (const manifest of globalDshManifestCandidates(homeDir)) {
    if (!existsSync(manifest)) continue
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
      if (!isOfficialDshPackageName(pkg.name)) continue
      if (typeof pkg.version === 'string' && pkg.version.trim() !== '') return pkg.version.trim()
    } catch {
      // 坏 manifest：换下一个候选
    }
  }
  return ''
}
