import { describe, expect, it } from 'vitest'
import { applyLocale, getLocale, resolveLocale, t } from '../src/i18n'

describe('i18n', () => {
  it('默认中文；t() 返回 zh 文案', () => {
    applyLocale('zh')
    expect(getLocale()).toBe('zh')
    expect(t('settings.language.title')).toBe('界面语言')
  })

  it('applyLocale("en") 切换英文文案', () => {
    applyLocale('en')
    expect(getLocale()).toBe('en')
    expect(t('settings.language.title')).toBe('Language')
    expect(t('settings.section.send')).toBe('Send selection & bridge')
  })

  it('切换回中文后文案恢复', () => {
    applyLocale('zh')
    expect(t('settings.section.send')).toBe('选中文字发送与桥接')
  })

  it('{name} 占位符用 vars 替换', () => {
    applyLocale('zh')
    expect(t('install.found', { dir: 'D:\\dsh' })).toBe('检测到已安装的 DSH 仓库：D:\\dsh')
    expect(t('settings.status.installedVer', { v: 'abc1234' })).toBe('已安装（abc1234） · 服务运行中 ✓')
    applyLocale('en')
    expect(t('install.cloneFailed', { err: 'boom' })).toContain('boom')
  })

  it('resolveLocale：显式 zh/en 直接生效', () => {
    expect(resolveLocale('zh')).toBe('zh')
    expect(resolveLocale('en')).toBe('en')
  })

  it('resolveLocale("auto")：系统语言 zh* → 中文，非中英（ja/fr/de 等）与不可用 → English', () => {
    const store = new Map<string, string>()
    const getItem = (k: string): string | null => store.get(k) ?? null
    ;(globalThis as unknown as { window?: unknown }).window = { localStorage: { getItem } }
    try {
      store.set('language', 'zh')
      expect(resolveLocale('auto')).toBe('zh')
      store.set('language', 'zh-TW')
      expect(resolveLocale('auto')).toBe('zh')
      store.set('language', 'ja')
      expect(resolveLocale('auto')).toBe('en')
      store.set('language', 'fr-FR')
      expect(resolveLocale('auto')).toBe('en')
      store.set('language', 'de')
      expect(resolveLocale('auto')).toBe('en')
      store.set('language', 'en')
      expect(resolveLocale('auto')).toBe('en')
      store.delete('language')
      expect(resolveLocale('auto')).toBe('en') // 未设置语言也按英文
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window
    }
    // localStorage 完全不可用（无 window）时也回退英文
    expect(resolveLocale('auto')).toBe('en')
  })

  it('未收录的 key 原样返回（便于发现漏译）', () => {
    expect(t('missing.key.xyz')).toBe('missing.key.xyz')
  })
})
