import { describe, expect, it } from 'vitest'
import { escapeHtml, renderDiffHtml, tokenize, truncate, wordDiff, type DiffToken } from '../src/diff'

describe('diff tokenize', () => {
  it('按空白切分并保留分隔符', () => {
    expect(tokenize('ab cd')).toEqual(['ab', ' ', 'cd'])
    expect(tokenize('a\nb')).toEqual(['a', '\n', 'b'])
  })
  it('空串返回空数组', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('wordDiff (词级 LCS)', () => {
  it('无变化时全部 same', () => {
    const d = wordDiff('hello world', 'hello world')
    expect(d.every((x) => x.type === 'same')).toBe(true)
    expect(d.map((x) => x.text).join('')).toBe('hello world')
  })
  it('替换一词：del 在前 add 在后成对出现', () => {
    const d = wordDiff('foo bar baz', 'foo qux baz')
    const types = d.filter((x) => x.type !== 'same').map((x) => x.type)
    expect(types).toEqual(['del', 'add'])
    expect(d.find((x) => x.type === 'del')?.text).toBe('bar')
    expect(d.find((x) => x.type === 'add')?.text).toBe('qux')
  })
  it('新增/删除文本段', () => {
    const added = wordDiff('a b', 'a b c')
    expect(added.filter((x) => x.type === 'add').map((x) => x.text).join('')).toBe(' c')
    const removed = wordDiff('a b c', 'a b')
    expect(removed.filter((x) => x.type === 'del').map((x) => x.text).join('')).toBe(' c')
  })
  it('完全不同的文本', () => {
    const d = wordDiff('one', 'two')
    expect(d.filter((x) => x.type === 'del').length).toBeGreaterThan(0)
    expect(d.filter((x) => x.type === 'add').length).toBeGreaterThan(0)
  })
  it('长文本性能：1000 词级 diff 不抛错且快速', () => {
    const a = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ')
    const b = Array.from({ length: 1000 }, (_, i) => (i === 500 ? `CHANGED${i}` : `word${i}`)).join(' ')
    const start = Date.now()
    const d = wordDiff(a, b)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(d.filter((x) => x.type === 'del').length).toBe(1)
  })
})

describe('renderDiffHtml / escapeHtml / truncate', () => {
  it('escapeHtml 转义 HTML 特殊字符', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })
  it('renderDiffHtml 输出 del/add/same 三个 span 类', () => {
    const tokens: DiffToken[] = [
      { text: 'a', type: 'same' },
      { text: 'b', type: 'del' },
      { text: 'c', type: 'add' },
    ]
    const html = renderDiffHtml(tokens)
    expect(html).toContain('class="dsh-diff-del"')
    expect(html).toContain('class="dsh-diff-add"')
    expect(html).toContain('a')
  })
  it('renderDiffHtml 转义内容防注入', () => {
    const html = renderDiffHtml([{ text: '<script>', type: 'add' }])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
  it('truncate 超长截断并加省略号', () => {
    expect(truncate('123456789', 5)).toBe('12345…')
    expect(truncate('123', 5)).toBe('123')
  })
})
