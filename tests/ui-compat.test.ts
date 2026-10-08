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
  const allFiles = readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort()
  const others = allFiles.filter((f) => f !== 'ui-compat.ts')

  it.each([
    ['.setWarning(', /setWarning\s*\(/],
    ['.display() 调用', /\.display\s*\(\s*\)/],
    ['.setDynamicTooltip(', /setDynamicTooltip\s*\(/],
  ])('%s 在其余 src 文件里零命中（调用方一律走 ui-compat）', (_label, re) => {
    const hits = others.filter((f) => re.test(readSrc(f)))
    expect(hits).toEqual([])
  })

  it('商店禁止禁用 no-deprecated：src 里（含 ui-compat.ts）不得出现关该规则的 eslint 指令', () => {
    // v2.8.9 Preview 挂在 Error「Disabling '@typescript-eslint/no-deprecated' is not allowed.」
    // ⇒ 废弃调用只能走本模块自声明的结构成员，不能用指令压掉规则。
    const directive = /(?:\/\/|\/\*)\s*eslint-(?:disable|enable)(?:-next-line|-line)?\b[^\n]*no-deprecated/
    const offenders = allFiles.filter((f) => directive.test(readSrc(f)))
    expect(offenders).toEqual([])
    // 反向自证：这条扫描真的在看文件（列表非空），且本模块确实在用「自声明结构成员」这条路
    expect(allFiles.length).toBeGreaterThan(10)
    const compat = readSrc('ui-compat.ts')
    for (const marker of ['DestructiveCapable', 'DeclarativeRefreshCapable', 'SliderBubbleCapable', 'LegacyWarningCapable', 'LegacyRepaintCapable']) {
      expect(compat).toContain(marker)
    }
    expect(compat).toContain('as unknown as LegacyWarningCapable')
    expect(compat).toContain('as unknown as LegacyRepaintCapable')
  })
})
