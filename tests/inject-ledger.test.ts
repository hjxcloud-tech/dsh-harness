import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INJECT_LIMITS,
  clearStorm,
  decideInject,
  emptyLedger,
  injectKey,
  injectSig,
  ledgerExists,
  ledgerPathFor,
  loadLedger,
  pruneLedger,
  readStorm,
  saveLedger,
  type InjectLedgerData,
} from '../src/inject-ledger'

/**
 * 台账 + 判定规则（治「多次框选 → DSH 崩溃」）。
 * 关键回归：**上下文被压缩、messages 窗口里已无那条注入消息时，仍不得再注入**
 * （旧实现只扫窗口 → 每 step 再注入一条 → 会话膨胀 → DSH 崩溃）。
 */

const PATH_A = 'D:\\Software\\Obsidian\\note.md'
const LOC_A = 'L10:1-L12:4'
const INSTR = '把这段改写一下'
const NOW = 1_700_000_000_000

function input(over: Partial<Parameters<typeof decideInject>[0]> = {}): Parameters<typeof decideInject>[0] {
  return {
    hasTarget: true,
    key: injectKey(PATH_A, LOC_A, INSTR),
    sig: injectSig(PATH_A, LOC_A),
    sessionKey: 'sess-1',
    now: NOW,
    windowHasInject: false,
    pendingSigs: [],
    surfaceSigs: [],
    data: emptyLedger(),
    ...over,
  }
}

describe('inject-ledger：key / sig', () => {
  it('key 稳定且随选区或指令变化', () => {
    const k = injectKey(PATH_A, LOC_A, INSTR)
    expect(k).toHaveLength(16)
    expect(injectKey(PATH_A, LOC_A, INSTR)).toBe(k)
    expect(injectKey(PATH_A, LOC_A, '别的指令')).not.toBe(k)
    expect(injectKey(PATH_A, 'L20:1-L21:1', INSTR)).not.toBe(k)
    // 指令首尾空白不影响 key（trim 后哈希）
    expect(injectKey(PATH_A, LOC_A, `  ${INSTR}  `)).toBe(k)
  })
  it('sig 与注入消息 summary 同格式（供 inbox/surface 比对）', () => {
    expect(injectSig(PATH_A, LOC_A)).toBe(`[BRIDGES 编辑指令] ${PATH_A} · ${LOC_A}`)
  })
})

describe('decideInject 真值表', () => {
  it('无 BRIDGES 行 → skip/none', () => {
    const r = decideInject(input({ hasTarget: false }))
    expect(r).toMatchObject({ action: 'skip', reason: 'none' })
  })
  it('messages 窗口已有注入 → skip/window', () => {
    expect(decideInject(input({ windowHasInject: true }))).toMatchObject({ action: 'skip', reason: 'window' })
  })
  it('inbox pending 已有等价载荷 → skip/pending', () => {
    expect(decideInject(input({ pendingSigs: [injectSig(PATH_A, LOC_A)] }))).toMatchObject({ action: 'skip', reason: 'pending' })
  })
  it('session surface 已有等价载荷 → skip/surface', () => {
    expect(decideInject(input({ surfaceSigs: [injectSig(PATH_A, LOC_A)] }))).toMatchObject({ action: 'skip', reason: 'surface' })
  })
  it('台账 TTL 内已注入过同 key → skip/ledger（一次性语义）', () => {
    const first = decideInject(input())
    expect(first.action).toBe('inject')
    expect(decideInject(input({ data: first.data }))).toMatchObject({ action: 'skip', reason: 'ledger' })
  })
  it('TTL 过期后同 key 重新放行', () => {
    const first = decideInject(input())
    const later = decideInject(input({ data: first.data, now: NOW + INJECT_LIMITS.ttlMs + 1 }))
    expect(later.action).toBe('inject')
  })
  it('单会话达上限 → skip/caps 并写入 storm 标记', () => {
    let data: InjectLedgerData = emptyLedger()
    for (let i = 0; i < INJECT_LIMITS.maxSessionInjections; i++) {
      const r = decideInject(input({ key: `k${String(i)}`, sig: `sig${String(i)}`, now: NOW + i, data }))
      expect(r.action).toBe('inject')
      data = r.data
    }
    const over = decideInject(input({ key: 'k-over', sig: 'sig-over', now: NOW + 999, data }))
    expect(over).toMatchObject({ action: 'skip', reason: 'caps' })
    expect(over.data.storm?.session).toBe('sess-1')
  })
})

describe('回归：上下文压缩后不得重复注入（旧实现崩溃根因）', () => {
  it('连续 20 个 step、窗口始终为空（模拟被 prune）→ 只注入 1 次', () => {
    let data: InjectLedgerData = emptyLedger()
    let injected = 0
    const reasons: string[] = []
    for (let step = 0; step < 20; step++) {
      const r = decideInject(input({ data, now: NOW + step * 2500, windowHasInject: false }))
      if (r.action === 'inject') injected += 1
      reasons.push(r.reason)
      data = r.data
    }
    expect(injected).toBe(1)
    expect(reasons[0]).toBe('none')
    expect(reasons.slice(1).every((x) => x === 'ledger')).toBe(true)
    expect(data.sessions['sess-1']).toBe(1)
  })
  it('会话内不同选区各自注入一次（不误伤正常使用）', () => {
    let data: InjectLedgerData = emptyLedger()
    for (let i = 0; i < 5; i++) {
      const r = decideInject(
        input({ key: `key-${String(i)}`, sig: `sig-${String(i)}`, now: NOW + i, data }),
      )
      expect(r.action).toBe('inject')
      data = r.data
    }
    expect(data.sessions['sess-1']).toBe(5)
  })
})

describe('pruneLedger / 台账 IO / storm', () => {
  it('超期条目被清理，条目数受上限约束', () => {
    const stale = { ...emptyLedger(), items: [{ key: 'old', at: NOW - INJECT_LIMITS.ttlMs - 1, count: 1, session: 's', sig: 'x' }] }
    expect(pruneLedger(stale, NOW).items).toHaveLength(0)
    const many = {
      ...emptyLedger(),
      items: Array.from({ length: INJECT_LIMITS.maxItems + 20 }, (_, i) => ({ key: `k${String(i)}`, at: NOW - i, count: 1, session: 's', sig: `s${String(i)}` })),
    }
    expect(pruneLedger(many, NOW).items).toHaveLength(INJECT_LIMITS.maxItems)
  })

  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-inject-ledger-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('save/load 往返；缺失文件 → 空台账', () => {
    expect(loadLedger(dir)).toEqual(emptyLedger())
    const r = decideInject(input())
    expect(saveLedger(dir, r.data)).toBe(true)
    expect(ledgerExists(dir)).toBe(true)
    const back = loadLedger(dir)
    expect(back.items).toHaveLength(1)
    expect(back.sessions['sess-1']).toBe(1)
    expect(ledgerPathFor(dir).endsWith('inject-ledger.json')).toBe(true)
  })
  it('损坏文件 → 空台账（不抛错）', () => {
    writeFileSync(join(dir, 'inject-ledger.json'), '{ not json', 'utf8')
    expect(loadLedger(dir)).toEqual(emptyLedger())
  })
  it('storm 读取/清除（仅窗口内提示一次）', () => {
    let data: InjectLedgerData = emptyLedger()
    for (let i = 0; i <= INJECT_LIMITS.maxSessionInjections; i++) {
      data = decideInject(input({ key: `c${String(i)}`, sig: `cs${String(i)}`, now: NOW + i, data })).data
    }
    saveLedger(dir, data)
    const storm = readStorm(dir, 30 * 60 * 1000, NOW + 100)
    expect(storm?.session).toBe('sess-1')
    // 超出提示窗口 → 不提示
    expect(readStorm(dir, 1000, NOW + 100_000)).toBeNull()
    clearStorm(dir)
    expect(JSON.parse(readFileSync(ledgerPathFor(dir), 'utf8')).storm).toBeUndefined()
  })
})
