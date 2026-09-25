import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  adaptedRangeLabel,
  compatIssue,
  DSH_ADAPTED_MAX_TESTED,
  DSH_ADAPTED_MIN,
  judgeDshCompat,
  repairCapabilityLimited,
  type BridgeHealth,
  type DshCompatLevel,
} from '../src/compat'

describe('judgeDshCompat（本机 DSH 版本 → 适配等级；区间端点为实测事实）', () => {
  it('实测端点判 tested（容忍前导 v 与空白：git tag 形态是 dsh-v0.1.5-rc.1）', () => {
    expect(judgeDshCompat('0.1.5-rc.1')).toBe('tested')
    expect(judgeDshCompat(DSH_ADAPTED_MAX_TESTED)).toBe('tested')
    expect(judgeDshCompat(' v0.1.5-rc.2 ')).toBe('tested')
  })
  it('落在实测区间内但非端点 → within-line（不打扰）', () => {
    // 注：官方与第三方 `@x1a0f3n9/dsh-*` **共用 0.1.5-rc.x 号段**（官方 0.1.5-rc.3 发布于 2026-09-22，
    // 第三方 rc.3/4/5 发布于 09-18～09-20）——同号不同包，所以判适配只能按包名认身份（见 dsh-identity.ts）。
    // 区间内的未登记版本（如官方 0.1.5 正式版、0.1.6-alpha.0）按 within-line 处理：不冒充实测，也不吓唬用户。
    expect(judgeDshCompat('0.1.5')).toBe('within-line')
    expect(judgeDshCompat('0.1.6-alpha.0')).toBe('within-line')
  })
  it('高于实测上界 → untested-newer；低于下界 → legacy', () => {
    // 上界 v2.8.4 起登记到 0.1.7-rc.2（沙盒四件 + setDraft 端到端全跑通）⇒ 比它新的才判未跟上；
    // 注意 `0.1.7`（无后缀正式版）按 SemVer 大于 `0.1.7-rc.2`，同样算更新版
    expect(judgeDshCompat('0.1.7-rc.3')).toBe('untested-newer')
    expect(judgeDshCompat('0.1.7')).toBe('untested-newer')
    expect(judgeDshCompat('0.2.0')).toBe('untested-newer')
    expect(judgeDshCompat('0.1.1')).toBe('legacy')
    expect(judgeDshCompat('0.0.9')).toBe('legacy')
  })
  it('官方已发布但我们没实跑的版本 → within-line（不打扰，也不冒充实测）', () => {
    expect(judgeDshCompat('0.1.5-rc.3')).toBe('within-line')
    expect(judgeDshCompat('0.1.6-alpha.2')).toBe('within-line')
    expect(judgeDshCompat('0.1.7-alpha.2')).toBe('within-line')
  })
  it('0.1.2–0.1.4（含预发布后缀）→ incompatible（沿用 updater 的坏区间表）', () => {
    for (const v of ['0.1.2', '0.1.3', '0.1.4', '0.1.4-rc.1', '0.1.2-alpha.9']) {
      expect(judgeDshCompat(v)).toBe('incompatible')
    }
  })
  it('哈希 / 空 / 垃圾串 → unknown（中性，不判定也不打扰）', () => {
    expect(judgeDshCompat('da590c7')).toBe('unknown')
    expect(judgeDshCompat('')).toBe('unknown')
    expect(judgeDshCompat('master')).toBe('unknown')
    expect(judgeDshCompat('未知')).toBe('unknown')
  })
  it('实测过的版本一律判 tested（登记规矩：只登记真跑过的，见 compat.ts 注释）', () => {
    expect(judgeDshCompat('0.1.7-rc.2')).toBe('tested')
    expect(judgeDshCompat('0.1.7-rc.1')).toBe('tested')
  })
  it('adaptedRangeLabel 就是两个端点（README/信息栏与判定共用同一事实源）', () => {
    expect(adaptedRangeLabel()).toBe(`${DSH_ADAPTED_MIN} ~ ${DSH_ADAPTED_MAX_TESTED}`)
  })
})

describe('compatIssue（版本 × 桥接两级状态 → 该提醒什么）', () => {
  const b = (h: BridgeHealth) => h
  it('一切正常返回 null（含服务未起时的 unknown）', () => {
    expect(compatIssue('tested', b('live'))).toBeNull()
    expect(compatIssue('within-line', b('unknown'))).toBeNull()
    expect(compatIssue('unknown', b('unknown'))).toBeNull()
    expect(compatIssue('unknown', b('live'))).toBeNull()
  })
  it('优先级：已知不兼容 > 桥接没装 > 桥接没生效 > 未验证新版 > 旧版', () => {
    expect(compatIssue('incompatible', b('not-installed'))).toBe('incompatible')
    expect(compatIssue('untested-newer', b('not-installed'))).toBe('bridge-not-installed')
    expect(compatIssue('untested-newer', b('not-live'))).toBe('bridge-not-live')
    expect(compatIssue('legacy', b('not-live'))).toBe('bridge-not-live')
    expect(compatIssue('untested-newer', b('live'))).toBe('untested')
    expect(compatIssue('legacy', b('live'))).toBe('legacy')
  })
})

// v2.8.4 用户定案：「本机 DSH 不适配」一类提示**一律不再弹窗**；开机也**不再有无条件的面板重刷**。
// 这两条都是"删掉的东西别悄悄长回来"的决定，故用源码级锁死（判定逻辑本身在上面几节已覆盖）。
describe('静默化定案（v2.8.4）：适配判定不驱动弹窗，启动不无条件重刷', () => {
  const readSrc = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  const main = readSrc('main.ts')
  const settings = readSrc('settings.ts')
  const compat = readSrc('compat.ts')
  const view = readSrc('view.ts')

  it('compat.ts 里没有任何"该不该弹"的台账（冷却/今日不再提示整套删除）', () => {
    for (const dead of ['shouldAlert', 'markAlerted', 'CompatAlertLog', 'COMPAT_ALERT_COOLDOWN_MS', 'levelNeedsAlert']) {
      expect(compat, `compat.ts 不应再导出 ${dead}`).not.toContain(dead)
    }
  })
  it('main.ts 不再组装适配弹窗，也不在启动流程里调用它', () => {
    for (const dead of ['openCompatNotice', 'checkCompatibility', 'compat.muteToday', 'compat.body.']) {
      expect(main, `main.ts 不应再出现 ${dead}`).not.toContain(dead)
    }
    // 启动后台动作只剩"按通道检查更新"这一项
    const startup = main.slice(main.indexOf('private scheduleStartupChecks'))
    expect(startup.slice(0, 600), '启动体检不应再挂适配弹窗').not.toContain('Compat')
  })
  it('设置页删掉「启动时检查适配」开关，判定只以文字呈现；旧 data.json 的两键被清走', () => {
    expect(settings).not.toContain('checkCompatOnStartup')
    expect(settings).not.toContain('compatAlerts')
    expect(main).toContain('checkCompatOnStartup') // loadSettings 里的逐出逻辑（键名以字符串形式出现在 delete 处）
    expect(main).toContain("'compatAlerts'")
  })
  it('view.ts 不再排程"打开面板 N 秒后无条件整视图重刷"', () => {
    expect(view).not.toContain('AUTO_REFRESH_DELAYS')
    expect(view).not.toContain('autoRefreshScheduled')
    // 但三个按需机制必须还在（删的是无条件重刷，不是白屏自愈）
    for (const alive of ['notifyUiState', 'reloadWhenSized', 'nudgeRepaint', 'scheduleReadyCheck']) {
      expect(view, `按需机制 ${alive} 应保留`).toContain(alive)
    }
    // refresh() 必须有互斥：日志实证过同一轮连刷两次（.399 / .411 相隔 12ms）
    expect(view).toContain('refreshing')
    expect(view).toContain('refreshQueued')
  })
})

describe('DshCompatLevel 与 BridgeHealth 的取值集合（文案键依赖它们，勿随意改名）', () => {
  it('枚举成员固定（新增等级要同步 i18n 的 compat.verdict.*）', () => {
    const levels: DshCompatLevel[] = ['tested', 'within-line', 'untested-newer', 'legacy', 'incompatible', 'unknown']
    expect(new Set(levels).size).toBe(6)
    const health: BridgeHealth[] = ['live', 'not-installed', 'not-live', 'unknown']
    expect(new Set(health).size).toBe(4)
  })
})

// v2.7.0（0.1.7 适配 A2）：会话修复能力的版本差异判定（不是兼容性判定，别混用）
describe('repairCapabilityLimited（A2）', () => {
  it('0.1.7 系（含 rc/alpha）判受限，0.1.6 及更早不判', () => {
    expect(repairCapabilityLimited('0.1.7-rc.1')).toBe(true)
    expect(repairCapabilityLimited('0.1.7-alpha.2')).toBe(true)
    expect(repairCapabilityLimited('0.1.7')).toBe(true)
    expect(repairCapabilityLimited('0.1.8')).toBe(true)
    expect(repairCapabilityLimited('0.1.6-alpha.1')).toBe(false)
    expect(repairCapabilityLimited('0.1.5-rc.3')).toBe(false)
  })
  it('读不到版本一律不判受限（与 unknown 同一保守口径，绝不误报）', () => {
    expect(repairCapabilityLimited('')).toBe(false)
    expect(repairCapabilityLimited(undefined)).toBe(false)
    expect(repairCapabilityLimited('未知')).toBe(false)
  })
})