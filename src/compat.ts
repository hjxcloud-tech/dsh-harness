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
export const DSH_ADAPTED_MAX_TESTED = '0.1.6-alpha.1'

/**
 * 适配等级。
 * - `tested`：命中上表实测区间的**端点版本**（真机或沙盒实跑过）；
 * - `within-line`：落在实测区间内但非端点（同一条线，按上界处理，不吓唬用户）；
 * - `untested-newer`：比实测上界更新——插件可能尚未跟上（README 已明示的接缝风险）；
 * - `legacy`：≤0.1.1，能开面板但桥接/认证等能力缺前提；
 * - `incompatible`：0.1.2–0.1.4 已知不兼容；
 * - `unknown`：哈希/master/空等不可解析形态（中性，不判定）。
 */
export type DshCompatLevel = 'tested' | 'within-line' | 'untested-newer' | 'legacy' | 'incompatible' | 'unknown'

/** 已实测的具体版本（信息栏文案与判定共用；新增实测版本时在此登记）。 */
export const DSH_TESTED_VERSIONS: readonly string[] = [
  '0.1.5-rc.1',
  '0.1.5-rc.2',
  '0.1.6-alpha.1',
]

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
}

/** 信息栏/说明文案用的区间串：`0.1.5-rc.1 ~ 0.1.6-alpha.1`。 */
export function adaptedRangeLabel(): string {
  return `${DSH_ADAPTED_MIN} ~ ${DSH_ADAPTED_MAX_TESTED}`
}
