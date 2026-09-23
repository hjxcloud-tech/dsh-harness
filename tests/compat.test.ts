import { describe, expect, it } from 'vitest'
import {
  adaptedRangeLabel,
  COMPAT_ALERT_COOLDOWN_MS,
  compatIssue,
  DSH_ADAPTED_MAX_TESTED,
  DSH_ADAPTED_MIN,
  judgeDshCompat,
  markAlerted,
  shouldAlert,
  type BridgeHealth,
  type DshCompatLevel,
} from '../src/compat'

const DAY = COMPAT_ALERT_COOLDOWN_MS

describe('judgeDshCompat（本机 DSH 版本 → 适配等级；区间端点为实测事实）', () => {
  it('实测端点判 tested（容忍前导 v 与空白：git tag 形态是 dsh-v0.1.5-rc.1）', () => {
    expect(judgeDshCompat('0.1.5-rc.1')).toBe('tested')
    expect(judgeDshCompat(DSH_ADAPTED_MAX_TESTED)).toBe('tested')
    expect(judgeDshCompat(' v0.1.5-rc.2 ')).toBe('tested')
  })
  it('落在实测区间内但非端点 → within-line（不打扰）', () => {
    // 注：官方 0.1.5 系只发过 rc.1 与 rc.2（0.1.5-rc.3 属第三方 scope 的包，官方核心包没有），
    // 故区间内的非端点版本目前只是「未来正式版」这类假设值；判定逻辑仍须正确。
    expect(judgeDshCompat('0.1.5')).toBe('within-line')
    expect(judgeDshCompat('0.1.6-alpha.0')).toBe('within-line')
  })
  it('高于实测上界 → untested-newer；低于下界 → legacy', () => {
    expect(judgeDshCompat('0.1.6-alpha.2')).toBe('untested-newer')
    expect(judgeDshCompat('0.2.0')).toBe('untested-newer')
    expect(judgeDshCompat('0.1.1')).toBe('legacy')
    expect(judgeDshCompat('0.0.9')).toBe('legacy')
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
  it('levelNeedsAlert：只有需要用户行动的分类才打扰', async () => {
    const { levelNeedsAlert } = await import('../src/compat')
    expect(levelNeedsAlert('tested')).toBe(false)
    expect(levelNeedsAlert('within-line')).toBe(false)
    expect(levelNeedsAlert('unknown')).toBe(false)
    expect(levelNeedsAlert('incompatible')).toBe(true)
    expect(levelNeedsAlert('untested-newer')).toBe(true)
    expect(levelNeedsAlert('legacy')).toBe(true)
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

describe('shouldAlert / markAlerted（同种问题当日只弹一次的冷却台账）', () => {
  const t0 = 1_700_000_000_000
  it('无问题永不弹；force 可无视冷却', () => {
    expect(shouldAlert({}, null, '0.1.9', t0)).toBe(false)
    expect(shouldAlert({}, 'incompatible', '0.1.3', t0, DAY, true)).toBe(true)
  })
  it('首次必弹；冷却期内同问题同版本不重复弹', () => {
    let log = {}
    expect(shouldAlert(log, 'bridge-not-live', '0.1.5-rc.2', t0)).toBe(true)
    log = markAlerted(log, 'bridge-not-live', '0.1.5-rc.2', t0)
    expect(shouldAlert(log, 'bridge-not-live', '0.1.5-rc.2', t0 + 1000)).toBe(false)
    expect(shouldAlert(log, 'bridge-not-live', '0.1.5-rc.2', t0 + DAY)).toBe(true)
  })
  it('版本变了＝新问题，立刻再提醒一次（DSH 升/降级后不能继续静默）', () => {
    let log = markAlerted({}, 'untested', '0.1.6-alpha.1', t0)
    expect(shouldAlert(log, 'untested', '0.2.0', t0 + 1000)).toBe(true)
  })
  it('不同问题种类各自独立计时；台账不可变更新不污染入参', () => {
    const base = markAlerted({}, 'incompatible', '0.1.3', t0)
    const withBridge = markAlerted(base, 'bridge-not-installed', '0.1.3', t0 + 10)
    expect(Object.keys(base)).toEqual(['incompatible'])
    expect(Object.keys(withBridge)).toEqual(['incompatible', 'bridge-not-installed'])
    expect(shouldAlert(withBridge, 'incompatible', '0.1.3', t0 + 20)).toBe(false)
  })
  it('脏台账（undefined / 缺键）按「没提醒过」处理', () => {
    expect(shouldAlert(undefined, 'legacy', '0.1.1', t0)).toBe(true)
    expect(shouldAlert({}, 'legacy', '0.1.1', t0)).toBe(true)
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
