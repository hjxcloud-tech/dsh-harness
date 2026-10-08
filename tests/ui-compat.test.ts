import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ButtonComponent, SettingTab, SliderComponent } from 'obsidian'
import { markDestructive, refreshSettingTab, showSliderValueBubble } from '../src/ui-compat'

const readSrc = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
const srcDir = fileURLToPath(new URL('../src/', import.meta.url))

/** 1.13 与旧版两套按钮替身：只放被测分支会碰的成员，并记录调用顺序。 */
function fakeButton(hasDestructive: boolean): { btn: ButtonComponent; calls: string[] } {
  const calls: string[] = []
  const self: Record<string, unknown> = {
    setWarning: () => {
      calls.push('setWarning')
      return self
    },
  }
  if (hasDestructive) {
    self.setDestructive = () => {
      calls.push('setDestructive')
      return self
    }
    self.setCta = () => {
      calls.push('setCta')
      return self
    }
    delete self.setWarning
  }
  return { btn: self as unknown as ButtonComponent, calls }
}

describe('ui-compat（v2.8.9：商店审查 no-deprecated 的双路适配层）', () => {
  it('1.13 路径：setDestructive + setCta（与本版 setWarning 的等价实现一致），不碰废弃成员', () => {
    const { btn, calls } = fakeButton(true)
    const out = markDestructive(btn)
    expect(calls).toEqual(['setDestructive', 'setCta'])
    expect(out).toBe(btn)
  })

  it('旧版路径（无 setDestructive）：退回 setWarning 一次，且不加 CTA（老版本观感不变）', () => {
    const { btn, calls } = fakeButton(false)
    const out = markDestructive(btn)
    expect(calls).toEqual(['setWarning'])
    expect(out).toBe(btn)
  })

  it('refreshSettingTab：有 update() 用它（1.13 声明式刷新入口），不再重复调 display()', () => {
    const calls: string[] = []
    const tab = {
      update: () => calls.push('update'),
      display: () => calls.push('display'),
    } as unknown as SettingTab
    refreshSettingTab(tab)
    expect(calls).toEqual(['update'])
  })

  it('refreshSettingTab：旧版（无 update()）退回 display()，整页重画行为不变', () => {
    const calls: string[] = []
    const tab = { display: () => calls.push('display') } as unknown as SettingTab
    refreshSettingTab(tab)
    expect(calls).toEqual(['display'])
  })

  it('refreshSettingTab：tab 尚未创建（null / undefined）时什么都不做也不抛错', () => {
    expect(() => refreshSettingTab(null)).not.toThrow()
    expect(() => refreshSettingTab(undefined)).not.toThrow()
  })

  it('showSliderValueBubble：成员在就调一次并返回滑杆本身；成员缺失不抛错', () => {
    const calls: string[] = []
    const slider = {
      setDynamicTooltip: () => {
        calls.push('bubble')
        return slider
      },
    } as unknown as SliderComponent
    expect(showSliderValueBubble(slider)).toBe(slider)
    expect(calls).toEqual(['bubble'])
    expect(() => showSliderValueBubble({} as unknown as SliderComponent)).not.toThrow()
  })
})

describe('死符号不得复活（废弃 API 只允许集中在 ui-compat.ts）', () => {
  const others = readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts') && f !== 'ui-compat.ts' && !f.endsWith('.d.ts'))
    .sort()

  it.each([
    ['.setWarning(', /setWarning\s*\(/],
    ['.display() 调用', /\.display\s*\(\s*\)/],
    ['.setDynamicTooltip(', /setDynamicTooltip\s*\(/],
  ])('%s 在其余 src 文件里零命中（调用方一律走 ui-compat）', (_label, re) => {
    const hits = others.filter((f) => re.test(readSrc(f)))
    expect(hits).toEqual([])
  })

  it('ui-compat.ts 的两处废弃豁免必须是「行级 disable + 写明理由」，不得整文件放开', () => {
    const src = readSrc('ui-compat.ts')
    const directives = src.split('\n').filter((l) => l.includes('eslint-disable-next-line @typescript-eslint/no-deprecated'))
    expect(directives).toHaveLength(2)
    for (const line of directives) expect(line).toContain('--')
    expect(src).not.toMatch(/^\s*\/\*\s*eslint-disable\s/ims)
  })
})
