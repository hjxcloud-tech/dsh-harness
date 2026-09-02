/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (os/fs/path) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { t } from './i18n'
import { resolveExec } from './win-exec'

/**
 * AED for DSH —— 抢救工具。
 *
 * DSH 常因插件冲突 / 卸载残留 / 配置损坏而无法启动（cordis.patch.yml 补丁层条目损坏、
 * 插件包缺失、初始化崩溃）。本模块提供「AED 抢救」：
 *   - dsh-fix：独立 CLI（不依赖 DSH，纯 Node 标准库）——doctor 诊断 / safe 一键安全模式（禁用全部用户插件，可回滚）。
 * 镜像通道：npm 官方 → npmmirror 兜底。
 *
 * 注意：dsh-fix safe 只禁用 cordis.patch.yml（patch 层）条目；经 `dsh plugin --profile web add`
 * 安装的插件写在 package.json 的 dsh.profile.bundles（bundle 层），dsh-fix 管不到。
 * 本模块在 safe 之后额外用 patch 语法 `disabled: true` 覆盖 bundle 层同名条目（cordis 语义：patch
 * 层禁用块作用于之前所有同名条目，含 bundle 层），退出安全模式时一并移除。
 */

/**
 * DSH 核心 bundle：禁用会导致 DSH 无法启动，安全模式必须保留。
 * 含 @deepseek-ai/dsh-client-modules：Web GUI 的客户端模块（页面启动引导 __DSH_BOOT__ / client.js
 * 由此加载）；若被安全模式禁用，页面会报「client.js did not export the bootstrap module face」。
 */
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-client-modules'])

/** dsh-harness 追加到 patch 的 bundle 禁用块 marker（exitSafeMode 按此前缀精确移除）。 */
export const BUNDLE_DISABLE_MARKER = '# dsh-harness: disabled bundle entry '

/** npm 镜像（官方不可达时兜底）。 */
export const NPM_MIRROR = 'https://registry.npmmirror.com'

/** 结果类型（与 installer 保持一致）。 */
export interface AedResult {
  ok: boolean
  message: string
}

/** 进度回调（step 文案 + 可选 percent 0-100）。 */
export type AedStepFn = (step: string, percent?: number) => void

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(exec: typeof execFile, command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  // Windows 下 npm 系命令是 .cmd shim，execFile 无法直接启动（ENOENT）→ 经 cmd.exe 包装
  const resolved = resolveExec(process.platform, command, args)
  return new Promise((resolve) => {
    exec(resolved.command, resolved.args, { timeout: timeoutMs, windowsHide: true }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        resolve({ ok: false, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() })
      } else {
        resolve({ ok: true, out: String(stdout ?? '').trim(), err: '' })
      }
    })
  })
}

/** 检测某命令是否可用（which/where）。 */
function hasBin(name: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(probe, [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 检查 dsh-fix 是否已全局可用。 */
export function isDshFixInstalled(): boolean {
  return hasBin('dsh-fix')
}

function webProfileDir(home: string): string {
  return join(home, 'profiles', 'web')
}

/**
 * 读取 web profile 的 bundle 层用户插件（package.json dsh.profile.bundles 中非核心部分）。
 * 读取失败 / 无 bundles 时返回 []（不阻断流程）。
 */
export function bundleUserPlugins(home: string): string[] {
  try {
    const pkgPath = join(webProfileDir(home), 'package.json')
    if (!existsSync(pkgPath)) return []
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = pkg.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((b): b is string => typeof b === 'string' && !CORE_BUNDLES.has(b))
  } catch {
    return []
  }
}

/**
 * 追加 bundle 层用户插件的禁用块到 cordis.patch.yml（写前备份；幂等——已含 marker 的 id 跳过）。
 * 块格式与 dsh-fix 一致（marker + `- id:` + `disabled: true`），DSH patch 语义使其覆盖 bundle 层同名条目。
 * v2.2.0 增强：禁用 id 取该 bundle 自身 dsh.bundle.patch 里的真实 insert 行 id（bundleDisableIds），
 * 避免「行 id ≠ 包名导致 entry not found 跳过、插件照常加载」；探测失败时回退包名 id。
 */
export function appendBundleDisableBlocks(home: string, plugins: string[], extraAnchors: string[] = []): void {
  const dir = webProfileDir(home)
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath) || plugins.length === 0) return
  const existing = readFileSync(patchPath, 'utf8')
  // 每个插件映射到真实 insert 行 id（可能多个），回退包名
  const targets = plugins.flatMap((pkg) => bundleDisableIds(home, pkg, extraAnchors).map((id) => ({ pkg, id })))
  const missing = targets.filter(({ id }) => !existing.includes(BUNDLE_DISABLE_MARKER + JSON.stringify(id)))
  if (missing.length === 0) return
  copyFileSync(patchPath, join(dir, `cordis.patch.yml.bak-harness-${Date.now()}`))
  const stamp = new Date().toISOString()
  const blocks = missing
    .map(({ pkg, id }) => `${BUNDLE_DISABLE_MARKER}${JSON.stringify(id)} (${pkg}) at ${stamp}\n- id: ${JSON.stringify(id)}\n  disabled: true`)
    .join('\n')
  writeFileSync(patchPath, existing.trimEnd() + '\n\n' + blocks + '\n', 'utf8')
}

/** 移除 dsh-harness 追加的全部 bundle 禁用块（整体回滚 bundle 层禁用）。 */
export function removeBundleDisableBlocks(home: string): void {
  const patchPath = join(webProfileDir(home), 'cordis.patch.yml')
  if (!existsSync(patchPath)) return
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].startsWith(BUNDLE_DISABLE_MARKER)) {
      i += 3 // 跳过 marker 行 + `- id:` 行 + `disabled: true` 行
      continue
    }
    kept.push(lines[i])
    i++
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  writeFileSync(patchPath, out, 'utf8')
}

// ---- v2.2.0：安全模式对「安装损坏」类问题也生效 ----
// 根因：DSH loadProfile 在应用任何禁用前就 eager 解析每个 bundle（resolveBundleDir + 读
// dsh.bundle.patch），包缺失 / dsh.bundle 缺失 / patch 解析失败都会在组合阶段直接抛错，
// 安全模式的禁用块来不及生效。本模块在 safe 前把「不健康」的 bundle 从 package.json 的
// dsh.profile.bundles 清单临时摘除（备份 + sidecar 记录），退出安全模式时恢复。

/** 临时摘除记录的 sidecar 文件名（位于 profile 目录）。 */
export const STRIP_SIDE_CAR = '.dsh-harness-safe-strip.json'

export interface BundleHealthResult {
  ok: boolean
  reason?: 'missing' | 'no-bundle-manifest' | 'patch-parse'
}

export interface StripResult {
  stripped: string[]
  backupPath?: string
}

/** 已探测的 dsh 安装锚缓存（npm root -g 较慢，缓存避免逐 bundle 重复执行）。 */
let cachedInstallAnchor: string | null | undefined

/**
 * 派生 dsh 安装锚（全局 CLI 的 node_modules/@deepseek-ai/dsh/package.json）；
 * 仓库形态由调用方以 extraAnchors 传入。失败返回 null（探测退化为 profile 锚点）。
 */
function dshInstallAnchor(): string | null {
  if (cachedInstallAnchor !== undefined) return cachedInstallAnchor
  cachedInstallAnchor = null
  try {
    const resolved = resolveExec(process.platform, 'npm', ['root', '-g'])
    const out = execFileSync(resolved.command, resolved.args, { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim()
    const pkg = join(out, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(pkg)) cachedInstallAnchor = pkg
  } catch {
    // npm 不可用/超时：忽略
  }
  return cachedInstallAnchor
}

/** 从 profile 或 dsh 安装锚的 node_modules 链加载 js-yaml（插件零新增依赖）；失败返回 null。 */
function loadYaml(anchors: string[]): unknown {
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)('js-yaml')
    } catch {
      // 尝试下一锚点
    }
  }
  return null
}

/** 与 DSH 同款的 patch YAML schema（JSON_SCHEMA + !!js 表达式节点），用于解析 bundle 的 dsh.bundle.patch。 */
function entryListSchema(yaml: { JSON_SCHEMA: unknown; Type: new (tag: string, opts: object) => unknown }): unknown {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: (data: string) => ({ __jsExpr: data }),
  })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- js-yaml 动态类型
  return (yaml.JSON_SCHEMA as { extend: (t: unknown) => unknown }).extend(JsExpr)
}

/** 定位 bundle 包目录（镜像 DSH resolveBundleDir：安装锚 + profile 锚点）。 */
function resolveBundleDirFrom(home: string, pkg: string, extraAnchors: string[]): string | null {
  const anchors = [...extraAnchors]
  const instAnchor = dshInstallAnchor()
  if (instAnchor) anchors.push(instAnchor)
  const profilePkg = join(webProfileDir(home), 'package.json')
  if (existsSync(profilePkg)) anchors.push(profilePkg)
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve(`${pkg}/package.json`)
      return join(resolved, '..')
    } catch {
      // 下一锚点
    }
  }
  return null
}

/**
 * 探测 bundle 是否健康（镜像 loadProfile 的失败点）：
 * ① 包可解析（安装锚或 profile node_modules）② package.json 声明 dsh.bundle.patch
 * ③ patch 文件存在且能被 DSH 同款 YAML schema 解析为数组。
 * js-yaml 不可用时退化为轻量启发式（文件存在 + 非空 + 首非注释字符为数组形态）。
 */
export function probeBundleHealthy(home: string, pkg: string, extraAnchors: string[] = []): BundleHealthResult {
  const bundleDir = resolveBundleDirFrom(home, pkg, extraAnchors)
  if (bundleDir === null) return { ok: false, reason: 'missing' }
  let manifest: { dsh?: { bundle?: { patch?: unknown } } }
  try {
    manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
  } catch {
    return { ok: false, reason: 'no-bundle-manifest' }
  }
  const patchRel = manifest.dsh?.bundle?.patch
  if (typeof patchRel !== 'string') return { ok: false, reason: 'no-bundle-manifest' }
  const patchPath = join(bundleDir, patchRel)
  const anchors = [...extraAnchors]
  const instAnchor = dshInstallAnchor()
  if (instAnchor) anchors.push(instAnchor)
  const profilePkg = join(webProfileDir(home), 'package.json')
  if (existsSync(profilePkg)) anchors.push(profilePkg)
  const yaml = loadYaml(anchors) as { JSON_SCHEMA: unknown; Type: new (tag: string, opts: object) => unknown } | null
  if (yaml) {
    try {
      const parsed = (yaml as unknown as { load: (text: string, opts: object) => unknown }).load(
        readFileSync(patchPath, 'utf8'),
        { schema: entryListSchema(yaml) },
      )
      if (!Array.isArray(parsed)) return { ok: false, reason: 'patch-parse' }
    } catch {
      return { ok: false, reason: 'patch-parse' }
    }
  } else {
    try {
      const text = readFileSync(patchPath, 'utf8')
      const first = text.replace(/^\s*(#.*\n?)*/u, '').trimStart()[0] ?? ''
      if (text.trim() === '' || (first !== '[' && first !== '-')) return { ok: false, reason: 'patch-parse' }
    } catch {
      return { ok: false, reason: 'patch-parse' }
    }
  }
  return { ok: true }
}

/**
 * 读取 bundle 自身 dsh.bundle.patch 的 insert 行 id（禁用块真正命中的 id）。
 * 解析失败/无 id 时回退包名（保持旧行为）。
 */
export function bundleDisableIds(home: string, pkg: string, extraAnchors: string[] = []): string[] {
  const bundleDir = resolveBundleDirFrom(home, pkg, extraAnchors)
  if (bundleDir === null) return [pkg]
  try {
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
    const patchRel = manifest.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') return [pkg]
    const anchors = [...extraAnchors]
    const instAnchor = dshInstallAnchor()
    if (instAnchor) anchors.push(instAnchor)
    const profilePkg = join(webProfileDir(home), 'package.json')
    if (existsSync(profilePkg)) anchors.push(profilePkg)
    const yaml = loadYaml(anchors) as { JSON_SCHEMA: unknown; Type: new (tag: string, opts: object) => unknown } | null
    if (!yaml) return [pkg]
    const rows = (yaml as unknown as { load: (text: string, opts: object) => unknown }).load(
      readFileSync(join(bundleDir, patchRel), 'utf8'),
      { schema: entryListSchema(yaml) },
    )
    if (!Array.isArray(rows)) return [pkg]
    const ids = rows
      .filter((r): r is { id?: unknown } => typeof r === 'object' && r !== null && !Array.isArray(r))
      .map((r) => r.id)
      .filter((id): id is string => typeof id === 'string')
    return ids.length > 0 ? ids : [pkg]
  } catch {
    return [pkg]
  }
}

/**
 * 临时摘除「不健康」的 bundle（包缺失 / dsh.bundle 缺失 / patch 解析失败）：
 * 备份 package.json → 从 dsh.profile.bundles 移除 → 写 sidecar 记录。幂等（已摘除的不再处理）。
 * @returns 本次摘除的 bundle 列表（空 = 无异常）。
 */
export function stripUnhealthyBundles(home: string, extraAnchors: string[] = []): StripResult {
  const dir = webProfileDir(home)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { stripped: [] }
  const bundles = bundleUserPlugins(home)
  if (bundles.length === 0) return { stripped: [] }
  const unhealthy = bundles.filter((pkg) => !probeBundleHealthy(home, pkg, extraAnchors).ok)
  if (unhealthy.length === 0) return { stripped: [] }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
  const list = Array.isArray(pkg.dsh?.profile?.bundles) ? (pkg.dsh.profile.bundles as string[]) : []
  const kept = list.filter((b) => !unhealthy.includes(b))
  if (kept.length === list.length) return { stripped: [] }
  const backupPath = join(dir, `package.json.bak-harness-safe-${Date.now()}`)
  copyFileSync(pkgPath, backupPath)
  // 合并已有 sidecar（前一次摘除未恢复时保留完整记录，避免丢失）
  let prev: string[] = []
  const sidePath = join(dir, STRIP_SIDE_CAR)
  try {
    if (existsSync(sidePath)) {
      const s = JSON.parse(readFileSync(sidePath, 'utf8')) as { stripped?: unknown }
      if (Array.isArray(s.stripped)) prev = s.stripped.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    // 坏 sidecar 忽略（以本次为准）
  }
  const merged = [...new Set([...prev, ...unhealthy])]
  const next = { ...pkg, dsh: { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: kept } } }
  writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  writeFileSync(
    sidePath,
    JSON.stringify({ timestamp: new Date().toISOString(), stripped: merged, backup: backupPath }, null, 2) + '\n',
    'utf8',
  )
  return { stripped: unhealthy, backupPath }
}

/**
 * 恢复临时摘除的 bundle（读 sidecar → 去重追加回清单 → 删除 sidecar；保留 .bak 备份）。
 */
export function restoreStrippedBundles(home: string): { restored: string[] } | { error: string } {
  const dir = webProfileDir(home)
  const sidePath = join(dir, STRIP_SIDE_CAR)
  if (!existsSync(sidePath)) return { restored: [] }
  try {
    const s = JSON.parse(readFileSync(sidePath, 'utf8')) as { stripped?: unknown }
    const stripped = Array.isArray(s.stripped) ? s.stripped.filter((x): x is string => typeof x === 'string') : []
    if (stripped.length > 0) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
        const list = Array.isArray(pkg.dsh?.profile?.bundles) ? (pkg.dsh.profile.bundles as string[]) : []
        const merged = [...new Set([...list, ...stripped])]
        const next = { ...pkg, dsh: { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: merged } } }
        writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
      }
    }
    unlinkSync(sidePath)
    return { restored: stripped }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 安装/升级 dsh-fix 到最新（全局 npm 安装 `dsh-fix@latest`，幂等且自动升级；官方源失败自动切 npmmirror）。
 * 全局安装可能因权限失败 → 返回失败并提示可改用 `npx dsh-fix`。
 */
export async function installDshFix(
  exec: typeof execFile = execFile,
  onStep?: AedStepFn,
): Promise<AedResult> {
  const step = onStep ?? (() => undefined)
  step(t('aed.installFix'), 10)
  let r = await run(exec, 'npm', ['install', '-g', 'dsh-fix@latest', '--no-fund', '--no-audit'], 120000)
  if (!r.ok) {
    step(t('aed.installFixMirror'), 30)
    r = await run(exec, 'npm', ['install', '-g', 'dsh-fix@latest', '--registry', NPM_MIRROR, '--no-fund', '--no-audit'], 120000)
  }
  if (!r.ok) {
    return { ok: false, message: t('aed.installFixFail', { err: r.err || t('err.unknown') }) }
  }
  return { ok: true, message: t('aed.installFixDone') }
}

/**
 * 以安全模式启动：`dsh-fix doctor`（诊断）→ `dsh-fix safe`（禁用全部用户插件，可回滚）。
 * 若 dsh-fix 未安装，自动尝试全局安装；安装失败则降级 `npx dsh-fix` 临时运行。
 * @param home - $DSH_HOME；不传则 dsh-fix 默认 ~/.dsh。
 */
export async function runAedSafe(
  home: string,
  exec: typeof execFile = execFile,
  onStep?: AedStepFn,
): Promise<AedResult> {
  const step = onStep ?? (() => undefined)
  const homeArgs = home ? ['--home', home] : []

  // 工具准备：总是 `npm i -g dsh-fix@latest`（幂等安装 + 自动升级到最新，保证每次抢救用最新 dsh-fix）；
  // 安装失败降级 npx 临时运行
  let useNpx = false
  step(t('aed.checkFix'), 5)
  const inst = await installDshFix(exec, step)
  if (!inst.ok) {
    // 全局安装失败 → 降级 npx 临时运行
    useNpx = true
    step(t('aed.fallbackNpx'), 8)
  }

  // doctor 诊断（只读）
  step(t('aed.doctor'), 40)
  const doctor = useNpx
    ? await run(exec, 'npx', ['--yes', 'dsh-fix', 'doctor', ...homeArgs], 120000)
    : await run(exec, 'dsh-fix', ['doctor', ...homeArgs], 60000)

  // v2.2.0：safe 前先临时摘除「不健康」bundle（包缺失/dsh.bundle 缺失/patch 解析失败会在
  // loadProfile 阶段直接抛错，禁用块来不及生效——摘除清单让安全模式真正能启动）
  step(t('aed.stripBundles'), 55)
  let stripNote = ''
  try {
    const stripRes = stripUnhealthyBundles(home)
    if (stripRes.stripped.length > 0) {
      stripNote = t('aed.stripNote', { list: stripRes.stripped.join('、') })
    }
  } catch (err) {
    stripNote = t('aed.stripFail', { err: err instanceof Error ? err.message : String(err) })
  }

  // safe 安全模式（禁用全部用户插件）
  step(t('aed.safeMode'), 70)
  const safe = useNpx
    ? await run(exec, 'npx', ['--yes', 'dsh-fix', 'safe', ...homeArgs], 120000)
    : await run(exec, 'dsh-fix', ['safe', ...homeArgs], 60000)

  if (!safe.ok) {
    // safe 失败：还原刚摘除的清单，避免留下半状态
    let restoreNote = ''
    try {
      const restored = restoreStrippedBundles(home)
      if ('error' in restored) restoreNote = t('aed.stripRestoreFail', { err: restored.error })
    } catch (err) {
      restoreNote = t('aed.stripRestoreFail', { err: err instanceof Error ? err.message : String(err) })
    }
    return { ok: false, message: t('aed.safeFail', { err: safe.err || t('err.unknown') }) + restoreNote }
  }
  // dsh-fix safe 只禁 patch 层；bundle 层用户插件（经 dsh plugin --profile web add 安装，
  // 写在 package.json dsh.profile.bundles）需额外追加禁用块（patch 语义覆盖 bundle 同名条目；
  // 禁用 id 取 bundle 自身 patch 的真实 insert 行 id，避免命中不了）
  const bundles = bundleUserPlugins(home)
  if (bundles.length > 0) {
    step(t('aed.disableBundles'), 85)
    try {
      appendBundleDisableBlocks(home, bundles)
    } catch (err) {
      return { ok: false, message: t('aed.disableBundlesFail', { err: err instanceof Error ? err.message : String(err) }) }
    }
  }
  // 汇总诊断摘要 + 安全模式结果（含 bundle 层禁用说明）
  const doctorLine = doctor.ok && doctor.out ? doctor.out.split('\n').slice(0, 3).join(' ') : ''
  const bundleNote = bundles.length > 0 ? t('aed.safeBundles', { list: bundles.join('、') }) : ''
  return {
    ok: true,
    message: t('aed.safeDone', { diag: doctorLine || t('aed.doctorNoDetail') }) + bundleNote + stripNote,
  }
}

/**
 * 退出安全模式：`dsh-fix clear`（移除全部 dsh-fix 禁用块，整体回滚 safe/bisect）。
 * 用于恢复被安全模式禁用的全部用户插件。dsh-fix 未安装时尝试全局安装，失败降级 npx。
 */
export async function exitSafeMode(
  home: string,
  exec: typeof execFile = execFile,
  onStep?: AedStepFn,
): Promise<AedResult> {
  const step = onStep ?? (() => undefined)
  const homeArgs = home ? ['--home', home] : []

  let useNpx = false
  if (!isDshFixInstalled()) {
    step(t('aed.checkFix'), 10)
    const inst = await installDshFix(exec, step)
    if (!inst.ok) {
      useNpx = true
      step(t('aed.fallbackNpx'), 15)
    }
  }

  step(t('aed.exitSafeMode'), 60)
  const clear = useNpx
    ? await run(exec, 'npx', ['--yes', 'dsh-fix', 'clear', ...homeArgs], 120000)
    : await run(exec, 'dsh-fix', ['clear', ...homeArgs], 60000)
  if (!clear.ok) {
    return { ok: false, message: t('aed.exitSafeFail', { err: clear.err || t('err.unknown') }) }
  }
  // 移除 dsh-harness 追加的 bundle 禁用块（恢复 bundle 层用户插件）
  try {
    removeBundleDisableBlocks(home)
  } catch (err) {
    return { ok: false, message: t('aed.exitBundleFail', { err: err instanceof Error ? err.message : String(err) }) }
  }
  // v2.2.0：恢复 safe 前临时摘除的异常 bundle 清单（读 sidecar → 去重追加回）
  let restoreNote = ''
  try {
    const restored = restoreStrippedBundles(home)
    if ('restored' in restored && restored.restored.length > 0) {
      restoreNote = t('aed.stripRestored', { list: restored.restored.join('、') })
    } else if ('error' in restored) {
      restoreNote = t('aed.stripRestoreFail', { err: restored.error })
    }
  } catch (err) {
    restoreNote = t('aed.stripRestoreFail', { err: err instanceof Error ? err.message : String(err) })
  }
  return { ok: true, message: t('aed.exitSafeDone') + restoreNote }
}

/**
 * AED 启动校验（v2.1.0）：safe/clear 完成后抓取 DSH Web GUI 首页 HTML，检测启动引导注入是否完整。
 *
 * 背景：用户报告 AED（dsh-fix safe）后 DSH 页面报
 * 「client-modules did not export the bootstrap module face」——根因多为安全模式残留
 * （dsh-fix 禁用了桥接插件条目 / dsh-harness 残留 bundle 禁用块）导致页面缺少
 * __DSH_BOOT__ 与 client.js 预加载注入。本模块在 safe/clear 后校验页面，
 * 并按关键词把失败归因到可行动的错误类，供插件端弹窗提示 + 一次性修复（不循环）。
 */

/** 启动引导注入 marker：两者都出现才认为页面注入完整。 */
export const BOOT_MARKERS = ['__DSH_BOOT__', 'dsh-client-modules/client.js'] as const

export type BootFailureKind =
  | 'client-modules'
  | 'bundle-face'
  | 'patch-parse'
  | 'plugin-missing'
  | 'init-crash'
  | 'unreachable'
  | 'other'

export interface BootCheck {
  ok: boolean
  kind?: BootFailureKind
  detail?: string
}

/** 可在插件端自动修复的错误类（重建桥接补丁 + 清理残留禁用块后重启）。其余类仅提示改用其他 harness。 */
export const AUTO_FIXABLE_KINDS: ReadonlySet<BootFailureKind> = new Set([
  'client-modules',
  'bundle-face',
  'patch-parse',
])

/** 按关键词把启动失败归因到可行动的错误类（关键词来自 DSH / dsh-fix 的实际报错文案）。 */
export function classifyBootFailure(text: string, detail = ''): BootFailureKind {
  const hay = `${text}\n${detail}`
  if (/did not export the bootstrap module face/i.test(hay)) return 'bundle-face'
  if (/client-modules|bootstrap module|__DSH_BOOT__|preload|failed to fetch dynamically imported module/i.test(hay)) return 'client-modules'
  if (/cordis\.patch|patch parse|failed to parse patch|parse error/i.test(hay)) return 'patch-parse'
  if (/cannot find module|MODULE_NOT_FOUND|is NOT installed|unable to load plugin/i.test(hay)) return 'plugin-missing'
  if (/error during startup|initialization|init crash|failed to (start|initialize)|uncaught exception/i.test(hay)) return 'init-crash'
  return 'other'
}

/**
 * 校验 DSH Web GUI 启动健康：
 * ① curl 抓首页 HTML，检查启动引导 marker（__DSH_BOOT__ / client.js 预加载）是否齐全；
 * ② marker 齐全后，再抓 client.js 资产核对 bootstrap face 导出（createClientModuleSystem）——
 *    覆盖「页面正常但 client.js 未导出启动模块」的运行时错误类（bootstrap module face）。
 * - curl 失败（服务不可达）→ kind 'unreachable'；
 * - marker 缺失 → 按页面内容分类（classifyBootFailure）；
 * - marker 齐全但 client.js 异常 → kind 'bundle-face'；
 * - 全部通过 → ok: true。
 * @param port - DSH Web 端口（插件设置）；校验有耗时（两次抓取约 8s+6s），调用方应提示用户。
 */
export async function verifyDshBootAsync(
  port: number,
  exec: typeof execFile = execFile,
  timeoutMs = 8000,
): Promise<BootCheck> {
  const base = `http://127.0.0.1:${port}`
  const page = await run(exec, 'curl', ['-L', '-sS', '--max-time', String(Math.max(3, Math.floor(timeoutMs / 1000))), `${base}/`], timeoutMs + 3000)
  if (!page.ok) {
    return { ok: false, kind: 'unreachable', detail: page.err || page.out || '' }
  }
  const html = page.out
  const missing = BOOT_MARKERS.filter((m) => !html.includes(m))
  if (missing.length > 0) {
    // marker 缺失本身即「启动引导注入不完整」的症状；页面无更具体报错关键词时默认归为 client-modules
    const kind = classifyBootFailure(html, '')
    return { ok: false, kind: kind === 'other' ? 'client-modules' : kind, detail: `missing: ${missing.join(', ')}` }
  }
  // marker 齐全：进一步核对 client.js 资产是否导出 bootstrap face（覆盖运行时 face 错误类）
  const srcMatch = [...html.matchAll(/src="([^"]*client\.js[^"]*)"/g)].map((m) => m[1])
  const clientSrc = srcMatch.find((s) => s.includes('client-modules')) ?? srcMatch[0]
  if (!clientSrc) {
    return { ok: false, kind: 'client-modules', detail: 'HTML 含 __DSH_BOOT__ 但未找到 client.js 预加载' }
  }
  const assetUrl = clientSrc.startsWith('http') ? clientSrc : `${base}${clientSrc.startsWith('/') ? '' : '/'}${clientSrc}`
  const asset = await run(exec, 'curl', ['-L', '-sS', '--max-time', '6', assetUrl], 9000)
  if (!asset.ok) {
    return { ok: false, kind: 'bundle-face', detail: `client.js 获取失败：${asset.err || asset.out || ''}` }
  }
  if (!asset.out.includes('createClientModuleSystem')) {
    return { ok: false, kind: 'bundle-face', detail: 'client.js 缺少 bootstrap face 导出（createClientModuleSystem），疑似未构建/陈旧产物' }
  }
  return { ok: true }
}

/**
 * AED 抢救流水线（完整编排，供「AED for DSH」按钮调用）：
 * ① 检查/安装 dsh-fix（降级 npx）② doctor 诊断 ③ safe 安全模式 ④ 完成。
 * 返回结果；重启 DSH 服务由调用方（main.ts）在成功后执行。
 * 调用方应随后执行 verifyDshBootAsync 校验启动健康（safe/clear 完成后检查）。
 */
export async function aedRecovery(
  home: string,
  exec: typeof execFile = execFile,
  onStep?: AedStepFn,
): Promise<AedResult> {
  const step = onStep ?? (() => undefined)
  // dsh-fix 安全模式（doctor 诊断 + safe 禁用全部用户插件）
  const safeRes = await runAedSafe(home, exec, step)
  if (!safeRes.ok) {
    return safeRes
  }
  step(t('aed.done'), 100)
  return { ok: true, message: safeRes.message }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
