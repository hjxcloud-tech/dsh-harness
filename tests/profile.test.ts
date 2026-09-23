import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isReservedProfile, listProfiles, normalizeProfile, RESERVED_PROFILES, VALID_PROFILE_RE } from '../src/profile'

describe('VALID_PROFILE_RE（v2.6.0：profile 名参与路径拼接，必须白名单）', () => {
  it('合法：小写字母开头 + a-z 0-9 _ -，长度 1–64', () => {
    expect(VALID_PROFILE_RE.test('web')).toBe(true)
    expect(VALID_PROFILE_RE.test('test')).toBe(true)
    expect(VALID_PROFILE_RE.test('a')).toBe(true)
    expect(VALID_PROFILE_RE.test('dsh-2_x')).toBe(true)
    expect(VALID_PROFILE_RE.test('p'.repeat(64))).toBe(true)
  })
  it('非法：大写/开头数字或符号/分隔符/点段/空/超长/含空白', () => {
    expect(VALID_PROFILE_RE.test('Web')).toBe(false)
    expect(VALID_PROFILE_RE.test('1test')).toBe(false)
    expect(VALID_PROFILE_RE.test('-test')).toBe(false)
    expect(VALID_PROFILE_RE.test('_test')).toBe(false)
    expect(VALID_PROFILE_RE.test('../evil')).toBe(false)
    expect(VALID_PROFILE_RE.test('a/b')).toBe(false)
    expect(VALID_PROFILE_RE.test('a\\b')).toBe(false)
    expect(VALID_PROFILE_RE.test('a b')).toBe(false)
    expect(VALID_PROFILE_RE.test('')).toBe(false)
    expect(VALID_PROFILE_RE.test('p'.repeat(65))).toBe(false)
  })
})

describe('normalizeProfile', () => {
  it('合法值原样；非法/非字符串/缺失 → 默认 web（旧 data.json 无该键的迁移兜底）', () => {
    expect(normalizeProfile('test')).toBe('test')
    expect(normalizeProfile('web')).toBe('web')
    expect(normalizeProfile('WEB')).toBe('web')
    expect(normalizeProfile('../x')).toBe('web')
    expect(normalizeProfile(undefined)).toBe('web')
    expect(normalizeProfile(42)).toBe('web')
    expect(normalizeProfile(null)).toBe('web')
  })
  it('大小写不转换（白名单只收小写）；仅首尾空白被裁掉', () => {
    expect(normalizeProfile('Test')).toBe('web')
    expect(normalizeProfile('  my-profile  ')).toBe('my-profile')
  })
})

describe('listProfiles（v2.6.0：设置页下拉的本机 profile 列表）', () => {
  it('只列有 package.json 的合法目录，web 排最前；DSH 建在 profiles/ 下的杂物与内置模板名被滤掉', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-listprofiles-'))
    try {
      const put = (name: string, withManifest: boolean): void => {
        mkdirSync(join(home, 'profiles', name), { recursive: true })
        if (withManifest) writeFileSync(join(home, 'profiles', name, 'package.json'), '{}', 'utf8')
      }
      put('web', true)
      put('test', true)
      put('dsh-2_x', true)
      put('acp', true) // 内置模板名：不能当面板 profile，不该出现在下拉里
      put('Bad', true)
      put('node_modules', true)
      put('.dsh-module-fallback', true)
      put('empty-dir', false)
      expect(listProfiles(home)).toEqual(['web', 'dsh-2_x', 'test'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('目录不存在 / 读失败 → 空数组（调用方退回「只有当前值」，不影响面板启动）', () => {
    expect(listProfiles(join(tmpdir(), 'definitely-not-a-dsh-home-' + Date.now()))).toEqual([])
    expect(listProfiles('/dev/null/nope')).toEqual([])
  })
})

describe('RESERVED_PROFILES / isReservedProfile（v2.6.0：DSH 内置模板档不可代建）', () => {
  it('内置模板名全部保留（事实源：@deepseek-ai/dsh-app-boot 的 PROFILE_TEMPLATES 键）', () => {
    expect([...RESERVED_PROFILES].sort()).toEqual(['acp', 'headless', 'sdk', 'sdk-minimal'])
    for (const name of ['acp', 'headless', 'sdk', 'sdk-minimal', 'HEADLESS', ' Acp ']) {
      expect(isReservedProfile(name)).toBe(true)
    }
  })
  it('web 是插件默认档（不保留）；rescue 只是 dsh 帮助里的示例自定义名（沙盒实测可建）', () => {
    expect(isReservedProfile('web')).toBe(false)
    expect(isReservedProfile('rescue')).toBe(false)
    expect(isReservedProfile('test')).toBe(false)
    expect(isReservedProfile('')).toBe(false)
  })
  it('内置名在归一层就被打回 web（脏 data.json 不会让面板去 boot 另一种应用形态）', () => {
    expect(normalizeProfile('headless')).toBe('web')
    expect(normalizeProfile('sdk-minimal')).toBe('web')
    expect(normalizeProfile('Acp')).toBe('web')
  })
})
