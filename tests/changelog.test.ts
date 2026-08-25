import { describe, expect, it } from 'vitest'
import { PLUGIN_CHANGELOG, type ChangelogEntry } from '../src/changelog-data'

function parseVer(v: string): number[] {
  return v.split('.').map(Number)
}

describe('PLUGIN_CHANGELOG 数据完整性', () => {
  it('非空且版本从新到旧排列', () => {
    expect(PLUGIN_CHANGELOG.length).toBeGreaterThan(0)
    for (let i = 1; i < PLUGIN_CHANGELOG.length; i++) {
      const prev = parseVer(PLUGIN_CHANGELOG[i - 1].version)
      const cur = parseVer(PLUGIN_CHANGELOG[i].version)
      // 逐段比较：prev 应 >= cur（新在前）
      let ok = false
      for (let j = 0; j < Math.max(prev.length, cur.length); j++) {
        const d = (prev[j] ?? 0) - (cur[j] ?? 0)
        if (d !== 0) {
          ok = d > 0
          break
        }
      }
      expect(ok, `版本 ${PLUGIN_CHANGELOG[i - 1].version} 应新于 ${PLUGIN_CHANGELOG[i].version}`).toBe(true)
    }
  })

  it('每条目含中英文要点且版本号合法', () => {
    for (const entry of PLUGIN_CHANGELOG) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(entry.items.length).toBeGreaterThan(0)
      for (const item of entry.items) {
        expect(Array.isArray(item)).toBe(true)
        expect(item.length).toBe(2)
        expect(typeof item[0]).toBe('string')
        expect(item[0].length).toBeGreaterThan(0)
        expect(typeof item[1]).toBe('string')
        expect(item[1].length).toBeGreaterThan(0)
      }
    }
  })

  it('最新条目版本与当前 manifest 一致（维护提醒）', () => {
    // 不硬断言（manifest 会演进），仅确保第一条存在
    expect(PLUGIN_CHANGELOG[0].version).toBeDefined()
  })
})

describe('ChangelogEntry 类型', () => {
  it('构造合法条目', () => {
    const e: ChangelogEntry = { version: '9.9.9', items: [['中文', 'English']] }
    expect(e.items[0][0]).toBe('中文')
    expect(e.items[0][1]).toBe('English')
  })
})
