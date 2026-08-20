/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (os/fs/path) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync, type ExecException } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/** DSH 核心 bundle：禁用会导致 DSH 无法启动，安全模式必须保留。 */
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

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
    exec(resolved.command, resolved.args, { timeout: timeoutMs, windowsHide: true }, (err: ExecException | null, stdout: string, stderr: string) => {
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
 */
export function appendBundleDisableBlocks(home: string, plugins: string[]): void {
  const dir = webProfileDir(home)
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath) || plugins.length === 0) return
  const existing = readFileSync(patchPath, 'utf8')
  const missing = plugins.filter((id) => !existing.includes(BUNDLE_DISABLE_MARKER + JSON.stringify(id)))
  if (missing.length === 0) return
  copyFileSync(patchPath, join(dir, `cordis.patch.yml.bak-harness-${Date.now()}`))
  const stamp = new Date().toISOString()
  const blocks = missing
    .map((id) => `${BUNDLE_DISABLE_MARKER}${JSON.stringify(id)} at ${stamp}\n- id: ${JSON.stringify(id)}\n  disabled: true`)
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

/**
 * 安装 dsh-fix（全局 npm 安装；官方源失败自动切 npmmirror）。
 * 全局安装可能因权限失败 → 返回失败并提示可改用 `npx dsh-fix`。
 */
export async function installDshFix(
  exec: typeof execFile = execFile,
  onStep?: AedStepFn,
): Promise<AedResult> {
  const step = onStep ?? (() => undefined)
  step(t('aed.installFix'), 10)
  let r = await run(exec, 'npm', ['install', '-g', 'dsh-fix', '--no-fund', '--no-audit'], 120000)
  if (!r.ok) {
    step(t('aed.installFixMirror'), 30)
    r = await run(exec, 'npm', ['install', '-g', 'dsh-fix', '--registry', NPM_MIRROR, '--no-fund', '--no-audit'], 120000)
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

  // 工具准备：已装直接用；未装尝试全局安装，失败降级 npx
  let useNpx = false
  if (!isDshFixInstalled()) {
    step(t('aed.checkFix'), 5)
    const inst = await installDshFix(exec, step)
    if (!inst.ok) {
      // 全局安装失败 → 降级 npx 临时运行
      useNpx = true
      step(t('aed.fallbackNpx'), 8)
    }
  }

  // doctor 诊断（只读）
  step(t('aed.doctor'), 40)
  const doctor = useNpx
    ? await run(exec, 'npx', ['--yes', 'dsh-fix', 'doctor', ...homeArgs], 120000)
    : await run(exec, 'dsh-fix', ['doctor', ...homeArgs], 60000)

  // safe 安全模式（禁用全部用户插件）
  step(t('aed.safeMode'), 70)
  const safe = useNpx
    ? await run(exec, 'npx', ['--yes', 'dsh-fix', 'safe', ...homeArgs], 120000)
    : await run(exec, 'dsh-fix', ['safe', ...homeArgs], 60000)

  if (!safe.ok) {
    return { ok: false, message: t('aed.safeFail', { err: safe.err || t('err.unknown') }) }
  }
  // dsh-fix safe 只禁 patch 层；bundle 层用户插件（经 dsh plugin --profile web add 安装，
  // 写在 package.json dsh.profile.bundles）需额外追加禁用块（patch 语义覆盖 bundle 同名条目）
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
    message: t('aed.safeDone', { diag: doctorLine || t('aed.doctorNoDetail') }) + bundleNote,
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
  return { ok: true, message: t('aed.exitSafeDone') }
}

/**
 * AED 抢救流水线（完整编排，供「AED for DSH」按钮调用）：
 * ① 检查/安装 dsh-fix（降级 npx）② doctor 诊断 ③ safe 安全模式 ④ 完成。
 * 返回结果；重启 DSH 服务由调用方（main.ts）在成功后执行。
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
