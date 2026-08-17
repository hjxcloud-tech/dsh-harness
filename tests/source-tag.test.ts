import { describe, expect, it } from 'vitest'
import { buildSourceTag } from '../src/source-tag'

describe('buildSourceTag', () => {
  it('拼接 vault 基路径与文件相对路径', () => {
    expect(buildSourceTag('04 project/xx.md', 'D:\\Software\\Obsidian')).toBe(
      '[来源：Obsidian 笔记 D:\\Software\\Obsidian\\04 project\\xx.md]\n\n',
    )
  })
  it('vault 基路径为空时退化为相对路径', () => {
    expect(buildSourceTag('01 inbox/a.md', '')).toBe('[来源：Obsidian 笔记 01 inbox/a.md]\n\n')
  })
  it('文件路径为空时返回空串（不附加标签）', () => {
    expect(buildSourceTag('', 'D:\\vault')).toBe('')
  })
})
