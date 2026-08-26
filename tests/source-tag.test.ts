import { describe, expect, it } from 'vitest'
import { buildBridgeMessage, countWords } from '../src/source-tag'

describe('buildBridgeMessage（隐式信息行）', () => {
  it('单行选区：L5:2-L5:10（0 基 → 1 基显示）', () => {
    expect(
      buildBridgeMessage(
        'D:\\Software\\Obsidian\\01 inbox\\xxx.md',
        { fromLine: 4, fromCh: 1, toLine: 4, toCh: 9 },
        128,
      ),
    ).toBe(
      '[ BRIDGES is delivering packages for you…… · 128 words · L5:2-L5:10 · D:\\Software\\Obsidian\\01 inbox\\xxx.md · ]',
    )
  })
  it('跨行选区：L12:5-L13:3', () => {
    expect(
      buildBridgeMessage('D:\\vault\\a.md', { fromLine: 11, fromCh: 4, toLine: 12, toCh: 2 }, 7),
    ).toBe('[ BRIDGES is delivering packages for you…… · 7 words · L12:5-L13:3 · D:\\vault\\a.md · ]')
  })
  it('首行首列边界：L1:1-L1:1', () => {
    expect(buildBridgeMessage('a.md', { fromLine: 0, fromCh: 0, toLine: 0, toCh: 0 }, 0)).toBe(
      '[ BRIDGES is delivering packages for you…… · 0 words · L1:1-L1:1 · a.md · ]',
    )
  })
  it('路径中的反斜杠原样保留（Windows 绝对路径）', () => {
    const message = buildBridgeMessage(
      'D:\\Software\\Obsidian\\06 skill&agent\\x.md',
      { fromLine: 0, fromCh: 0, toLine: 0, toCh: 5 },
      1,
    )
    expect(message).toContain('D:\\Software\\Obsidian\\06 skill&agent\\x.md')
    expect(message).toContain('· ]')
  })
})

describe('countWords（中英文统一 words 标签）', () => {
  it('空串 → 0', () => {
    expect(countWords('')).toBe(0)
  })
  it('英文按空格分词', () => {
    expect(countWords('hello world')).toBe(2)
    expect(countWords('  hello   world  ')).toBe(2)
  })
  it('CJK 按字符数计', () => {
    expect(countWords('你好世界')).toBe(4)
  })
  it('中英混合：CJK 字符数 + 英文词数', () => {
    expect(countWords('你好 world')).toBe(3)
  })
  it('含 CJK 的连续词按其中 CJK 字符数计', () => {
    expect(countWords('中文abc')).toBe(2)
  })
  it('标点不影响英文词计数', () => {
    expect(countWords('hello, world!')).toBe(2)
  })
})
