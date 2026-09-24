/**
 * 插件 ↔ 本机 DSH 的适配判定（v2.6.0：设置页信息栏说明与启动时不适配弹窗共用同一事实源）。
 *
 * 事实来源（逐条核实，勿凭印象改动）：
 * - **下界 `0.1.5-rc.1`**：0.1.5 系已实测适配（隔离认证矩阵 11/11 + 沙盒 UI 6/6 + 真机），
 *   且 0.1.5 起输入框换成 Lexical 受控编辑器、桥接的写入与注入策略都是按它校准的；
 * - **上界 `0.1.6-alpha.1`**：0.1.5-rc.1 → 0.1.6-alpha.1 的全部插件触点逐项比对一致，
 *   沙盒实跑 10/11 PASS（唯一失败项是沙盒会话标题期望值，与插件无关）；
 * - **`0.1.2`–`0.1.4` 已知不兼容**：浏览器会话认证叠加当时的上游会话缓存/列表缺陷
 *   （沿用 `updater.DSH_KNOWN_INCOMPATIBLE`，不另立一张表）；
 * - **`≤0.1.1` 旧版可用**：历史钉住区间——面板能开，但缺 0.1.2+ 的认证适配器与 0.1.5+ 的桥接写入前提。
 *
 * 本模块**只做判定、不出文案**：i18n 措辞留给调用方（settings 的横幅、main 的弹窗），
 * 沙盒脚本与单元测试因此可以断言同一张真值表。
 */
import { classifyDshTarget, compareVersions, parseCoreTriple } from './updater'

/** 已实测适配的 DSH 版本下界（含）。 */
export const DSH_ADAPTED_MIN = '0.1.5-rc.1'
/** 已实测适配的 DSH 版本上界（含）——高于它属「插件还没跟上」。 */
export const DSH_ADAPTED_MAX_TESTED = '0.1.7-rc.1'

/**
 * 已实测的具体版本（信息栏文案与判定共用；新增实测版本时在此登记）。
 *
 * **维护规矩（v2.7.0 起由用户明确指示：自己记得更新，不要等提醒）**
 * 每当在真机或沙盒里跑通某个新 DSH 版本，就把它登记到这里，并按需上推
 * `DSH_ADAPTED_MAX_TESTED`；反过来，发现某版本上有真破坏（如 0.1.7 的会话格式 v4
 * 需要 historical child facts）时，先修（见 `session-repair.ts` 的 deferred 分支）再登记。
 * 只登记**跑过**的版本：树级触点比对（`scripts/dsh-compat-diff.mjs`）只能作为辅助证据，
 * 不构成登记理由——例如 `0.1.5-rc.3` 与基线 24 触点全 same，但没实跑过，就不登记。
 *
 * 登记依据（逐条可复现）：
 *  · `0.1.5-rc.1` / `0.1.5-rc.2`：真机（本 Vault 面板）+ 沙盒全链；
 *  · `0.1.6-alpha.1`：隔离沙盒 `scripts/sandbox_ui_test.py` 10/11（唯一失败项与版本无关）；
 *  · `0.1.7-rc.1`：2026-09-23 沙盒三件——`verify-embed` 9 项全过、
 *    `verify-profile --bin <rc.1>` 30 PASS/0 FAIL、`verify-session-repair` 走 deferred 分支 PASS；
 *    另实测上传链无凭据 401 / Bearer 200、桥接页面级注入 `injected`。
 */
export const DSH_TESTED_VERSIONS: readonly string[] = [
  '0.1.5-rc.1',
  '0.1.5-rc.2',
  '0.1.6-alpha.1',
  '0.1.7-rc.1',
]
/**
 * 适配等级。
 * - `tested`：命中 `DSH_TESTED_VERSIONS` 的**实测过的具体版本**（真机或沙盒实跑过）；
 * - `within-line`：落在实测区间内但未登记（同一条线，按上界处理，不吓唬用户）；
 * - `untested-newer`：比实测上界更新——插件可能尚未跟上；
 * - `legacy`：≤0.1.1，能开面板但桥接/认证等能力缺前提；
 * - `incompatible`：0.1.2–0.1.4 已知不兼容；
 * - `unknown`：哈希/master/空等不可解析形态（中性，不判定）。
 */
export type DshCompatLevel = 'tested' | 'within-line' | 'untested-newer' | 'legacy' | 'incompatible' | 'unknown'

/** 归一版本串：去空白与可选的 `v` 前缀（git tag 形态是 `dsh-v0.1.5-rc.1`）。 */
function normalizeVersion(version: string): string {
  return (version ?? '').trim().replace(/^v/i, '')
}

/** 版本 → 适配等级。 */
export function judgeDshCompat(version: string): DshCompatLevel {
  const v = normalizeVersion(version)
  if (v === '' || parseCoreTriple(v) === null) return 'unknown'
  if (classifyDshTarget(v) === 'known-incompatible') return 'incompatible'
  if (DSH_TESTED_VERSIONS.includes(v)) return 'tested'
  if (compareVersions(v, DSH_ADAPTED_MIN) < 0) return 'legacy'
  if (compareVersions(v, DSH_ADAPTED_MAX_TESTED) > 0) return 'untested-newer'
  return 'within-line'
}

/** 该等级是否需要打扰用户（弹窗）。`within-line`/`tested`/`unknown` 不打扰。 */
export function levelNeedsAlert(level: DshCompatLevel): boolean {
  return level === 'incompatible' || level === 'legacy' || level === 'untested-newer'
}

/** 桥接健康度（两级：文件层装没装、页面层吃没吃到）。 */
export type BridgeHealth = 'live' | 'not-installed' | 'not-live' | 'unknown'

/**
 * 需要提醒的问题种类。返回 `null` = 一切正常，不打扰。
 * 优先级即顺序：已知不兼容 > 桥接根本没装 > 装了但页面没吃到（服务没重启/被旧代码覆盖）> 未验证新版 > 旧版。
 * 桥接问题排在前面的理由：它比「版本未验证」更确定地意味着功能已经坏了。
 */
export function compatIssue(level: DshCompatLevel, bridge: BridgeHealth): string | null {
  if (level === 'incompatible') return 'incompatible'
  if (bridge === 'not-installed') return 'bridge-not-installed'
  if (bridge === 'not-live') return 'bridge-not-live'
  if (level === 'untested-newer') return 'untested'
  if (level === 'legacy') return 'legacy'
  return null
}

/** 冷却台账：{ 问题种类 → 最近一次提示时刻 }。同种问题按版本细分（版本变了＝新问题，应当再提醒一次）。 */
export interface CompatAlertRecord {
  /** 提示时的 DSH 版本串（版本变化即视为新问题，重开设定）。 */
  version: string
  /** 最近一次弹窗时刻（ms）。 */
  atMs: number
}

/** 台账类型：问题种类 → 记录。 */
export type CompatAlertLog = Record<string, CompatAlertRecord>

/** 启动提醒的默认冷却：24 小时（就是「今天不再提示」的语义）。 */
export const COMPAT_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * 该问题现在是否该弹：同一（问题种类 × 版本）在冷却期内只弹一次。
 * `force=true`（设置页「重新检查适配」手动触发）时无视冷却。
 */
export function shouldAlert(
  log: CompatAlertLog | undefined,
  issue: string | null,
  version: string,
  nowMs: number,
  cooldownMs: number = COMPAT_ALERT_COOLDOWN_MS,
  force: boolean = false,
): boolean {
  if (issue === null) return false
  if (force) return true
  const rec = log?.[issue]
  if (!rec || rec.version !== version) return true
  return nowMs - rec.atMs >= cooldownMs
}

/** 记一次弹窗（返回新台账，不可变更新，便于直接赋回 settings）。 */
export function markAlerted(
  log: CompatAlertLog | undefined,
  issue: string,
  version: string,
  nowMs: number,
): CompatAlertLog {
  const next: CompatAlertLog = { ...(log ?? {}) }
  next[issue] = { version, atMs: nowMs }
  return next
}

/**
 * 0.1.7 起「会话格式修复」能力受限（v2.7.0 / A2）：静态 catalog 无法离线校验低于当前格式的会话
 * （V3→V4 迁移边需要 parent 的 historical child facts），故这类会话只能只报告不改写。
 * 不是不兼容，只是能力差异——单独判定，供适配弹窗与设置页如实说明。
 * 按**核心三元组**比较：`0.1.7-rc.1` 属于 0.1.7 系，不能因为预发布排序而判成"更早"。
 */
export const DSH_REPAIR_LIMITED_SINCE = '0.1.7'

/** 该版本上会话修复是否对跨版本会话受限（读不出核心版本时返回 false，避免误报）。 */
export function repairCapabilityLimited(version: string | undefined | null): boolean {
  if (!version) return false
  const v = parseCoreTriple(version)
  if (!v) return false
  const [maj, min, pat] = v
  if (maj !== 0) return maj > 0
  if (min !== 1) return min > 1
  return pat >= 7
}

/** 一次适配体检的完整结果（设置页信息栏与启动弹窗共用）。 */
export interface CompatSnapshot {
  /** 本机 DSH 版本串（读不到时为 i18n 的「未知」文案）。 */
  version: string
  level: DshCompatLevel
  bridge: BridgeHealth
  /** 需要提醒的问题种类；null=正常。 */
  issue: string | null
  /**
   * 版本读数是否来自**已核验身份**的官方包（全局官方 manifest 或已核验仓库）。
   * false＝来源是 PATH 上的 `dsh` 之类不可信读数（可能由第三方 dsh 包提供）——此时 level 一律按 unknown 处理，
   * 只展示不判定，避免拿第三方包的版本号去判 DSH 适配。
   */
  verified?: boolean
  /** v2.7.0（A2）：该版本的「会话格式修复」是否对跨版本会话只报告不改写（0.1.7 起为真）。 */
  repairLimited?: boolean
}

/** 信息栏/说明文案用的区间串：`0.1.5-rc.1 ~ 0.1.6-alpha.1`。 */
export function adaptedRangeLabel(): string {
  return `${DSH_ADAPTED_MIN} ~ ${DSH_ADAPTED_MAX_TESTED}`
}
