import { describe, expect, it } from 'vitest'
import { applyLocale, getLocale, i18nPair, I18N_KEYS, resolveLocale, t } from '../src/i18n'

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
    expect(t('settings.section.send')).toBe('Bridge')
  })

  it('切换回中文后文案恢复', () => {
    applyLocale('zh')
    expect(t('settings.section.send')).toBe('桥接')
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

  it('resolveLocale("auto")：检测端传入 zh → 中文，非中英/缺省 → English', () => {
    expect(resolveLocale('auto', 'zh')).toBe('zh')
    expect(resolveLocale('auto', 'en')).toBe('en')
    expect(resolveLocale('auto')).toBe('en') // 未传检测结果（检测端不可用）按英文
  })

  it('未收录的 key 原样返回（便于发现漏译）', () => {
    expect(t('missing.key.xyz')).toBe('missing.key.xyz')
  })
})

describe('词典机检（双语齐全 + 占位符一致，v2.6.0 批量新增文案后的护栏）', () => {
  const varsOf = (s: string): string[] => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort()

  it('每个键都是 [中文, English] 两条非空文案', () => {
    const bad = I18N_KEYS.filter((k) => {
      const pair = i18nPair(k)
      return !pair || pair.length !== 2 || pair.some((s) => typeof s !== 'string' || s.trim() === '')
    })
    expect(bad, `缺译或空文案：${bad.join(', ')}`).toEqual([])
  })

  it('同一键中英两侧的 {placeholder} 集合一致（少一个花括号就是运行时漏参）', () => {
    const bad = I18N_KEYS.filter((k) => {
      const pair = i18nPair(k)
      return pair ? varsOf(pair[0]).join(',') !== varsOf(pair[1]).join(',') : false
    })
    expect(bad, `占位符不一致：${bad.join(', ')}`).toEqual([])
  })

  it('适配自检 / profile 选择 / 更新通道三处文案键齐备（缺一处设置页就显示裸键名）', () => {
    const required = [
      'settings.profile.pick', 'settings.profile.pickDesc', 'settings.profile.newName', 'settings.profile.create', 'settings.profile.reserved',
      'settings.updateChannel.title', 'settings.updateChannel.stable', 'settings.updateChannel.preview', 'settings.updateChannel.dev',
      'settings.autoCheck.title', 'settings.autoCheckInterval.title',
      'settings.compat.state.title', 'settings.compat.recheck', 'settings.compat.state.reading',
      'settings.pluginVersion.compatLink', 'compat.explain.title', 'compat.explain.close', 'compat.explain.bulletRange',
      'settings.section.service', 'settings.section.profile', 'settings.section.update', 'settings.section.compat',
      'compat.verdict.ok', 'compat.verdict.unknown', 'compat.verdict.incompatible', 'compat.verdict.legacy', 'compat.verdict.untested',
      'compat.verdict.bridge-not-installed', 'compat.verdict.bridge-not-live',
      'compat.detail', 'compat.repairLimited',
      'modal.profileSwitchTitle', 'modal.profileSwitchConfirm',
    ]
    const missing = required.filter((k) => i18nPair(k) === undefined)
    expect(missing, `缺键：${missing.join(', ')}`).toEqual([])
  })

  it('v2.8.4 取消弹窗后，弹窗专用键不得复活（复活就意味着有人又把适配提示做成了模态框）', () => {
    for (const dead of [
      'compat.title.incompatible', 'compat.title.bridgeNotLive', 'compat.body.untested',
      'compat.danger.bridgeNotLive', 'compat.act.restartService', 'compat.act.rewriteBridge',
      'compat.muteToday', 'compat.muted', 'compat.ok',
      'settings.compat.title', 'settings.compat.desc',
    ]) {
      expect(i18nPair(dead), `弹窗专用键 ${dead} 应已删除`).toBeUndefined()
    }
  })

  it('compat.tone.* 的判定符号一律**后置**（与同栏「服务运行中 ✓」同构，用户定案）', () => {
    applyLocale('zh')
    const tones = ['ok', 'incompatible', 'legacy', 'untested', 'bridge-not-installed', 'bridge-not-live', 'unknown']
    for (const name of tones) {
      const pair = i18nPair(`compat.tone.${name}`)
      expect(pair, `缺键 compat.tone.${name}`).toBeTruthy()
      if (!pair) continue
      for (const text of pair) {
        const s = text.trim()
        expect(s.match(/^[✓✗⚠?]/), `${name} 符号不应前置：${s}`).toBeNull()
        expect(s.match(/[✓✗⚠?]$/), `${name} 结尾应有判定符号：${s}`).toBeTruthy()
      }
    }
    // 横幅拼接后的观感：`已安装（x） · 服务运行中 ✓ · 已适配 ✓`
    expect(t('settings.status.installedVer', { v: '0.1.5-rc.2' })).toContain('服务运行中 ✓')
    expect(t('compat.tone.ok')).toBe('已适配 ✓')
  })

  it('高级设置四个子分区键齐备（重排后的分区标题，缺一个就少一行分组名）', () => {
    for (const key of ['settings.section.advanced', 'settings.section.service', 'settings.section.profile', 'settings.section.update', 'settings.section.compat']) {
      expect(i18nPair(key), `缺键 ${key}`).toBeTruthy()
    }
  })
})
