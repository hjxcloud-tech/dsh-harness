import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isOfficialDshCheckout,
  isOfficialDshPackageName,
  isThirdPartyDshName,
  LEGACY_DSH_ROOT_PACKAGE,
  OFFICIAL_DSH_NAMES,
  OFFICIAL_DSH_PACKAGE,
  OFFICIAL_DSH_ROOT_PACKAGE,
  globalDshManifestCandidates,
  readDshPackageIdentity,
  readPackageName,
} from '../src/dsh-identity'

const dirWith = (pkg: string | null): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-identity-'))
  if (pkg !== null) writeFileSync(join(dir, 'package.json'), pkg, 'utf8')
  return dir
}

describe('isOfficialDshPackageName（本体白名单：核心包 + 仓库根包 + 历史根包名）', () => {
  it('官方三个名字收', () => {
    expect(OFFICIAL_DSH_NAMES).toEqual([OFFICIAL_DSH_PACKAGE, OFFICIAL_DSH_ROOT_PACKAGE, LEGACY_DSH_ROOT_PACKAGE])
    for (const n of OFFICIAL_DSH_NAMES) expect(isOfficialDshPackageName(n)).toBe(true)
    expect(isOfficialDshPackageName(`  ${OFFICIAL_DSH_PACKAGE}  `)).toBe(true)
  })
  it('第三方 scope、官方子包、裸名、非字符串一律拒', () => {
    // 实测存在的第三方社区包（版本号自成一套，如 0.1.5-rc.3）
    for (const n of ['@x1a0f3n9/dsh-web-app', '@x1a0f3n9/dsh-client-connection', '@x1a0f3n9/dsh-workspace']) {
      expect(isOfficialDshPackageName(n)).toBe(false)
    }
    // 官方 scope 下的**子包**不是本体：版本与更新只认核心包
    expect(isOfficialDshPackageName('@deepseek-ai/dsh-web-app')).toBe(false)
    expect(isOfficialDshPackageName('dsh')).toBe(false)
    expect(isOfficialDshPackageName('deepseek-harness-fork')).toBe(false)
    expect(isOfficialDshPackageName(undefined)).toBe(false)
    expect(isOfficialDshPackageName(42)).toBe(false)
    expect(isOfficialDshPackageName('')).toBe(false)
  })
})

describe('isThirdPartyDshName（只用于日志/提示，不参与判定）', () => {
  it('识别第三方 dsh 名与 fork 目录名', () => {
    expect(isThirdPartyDshName('@x1a0f3n9/dsh-web-app')).toBe(true)
    expect(isThirdPartyDshName('dsh-web-app')).toBe(true)
    expect(isThirdPartyDshName('my-deepseek-harness')).toBe(true)
  })
  it('官方本体名返回 false；无关名返回 false', () => {
    for (const n of OFFICIAL_DSH_NAMES) expect(isThirdPartyDshName(n)).toBe(false)
    expect(isThirdPartyDshName('obsidian')).toBe(false)
    expect(isThirdPartyDshName(undefined)).toBe(false)
  })
})

describe('readDshPackageIdentity（身份不过关 → null，绝不返回版本）', () => {
  it('官方名 + 版本 → 返回身份', () => {
    const dir = dirWith(JSON.stringify({ name: OFFICIAL_DSH_ROOT_PACKAGE, version: '0.1.1-rc.2' }))
    expect(readDshPackageIdentity(dir)).toEqual({ name: OFFICIAL_DSH_ROOT_PACKAGE, version: '0.1.1-rc.2' })
    rmSync(dir, { recursive: true, force: true })
  })
  it('官方名但 version 缺失/空 → 身份成立、版本空串（调用方回退哈希）', () => {
    const dir = dirWith(JSON.stringify({ name: OFFICIAL_DSH_PACKAGE }))
    expect(readDshPackageIdentity(dir)).toEqual({ name: OFFICIAL_DSH_PACKAGE, version: '' })
    rmSync(dir, { recursive: true, force: true })
  })
  it('第三方包带版本 → null（这就是「检测到第三方 npm 包」被掐断的地方）', () => {
    const dir = dirWith(JSON.stringify({ name: '@x1a0f3n9/dsh-web-app', version: '0.1.5-rc.3' }))
    expect(readDshPackageIdentity(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
  it('无 package.json / 坏 JSON / 空目录路径 → null', () => {
    const none = dirWith(null)
    expect(readDshPackageIdentity(none)).toBeNull()
    rmSync(none, { recursive: true, force: true })
    const broken = dirWith('{not json')
    expect(readDshPackageIdentity(broken)).toBeNull()
    rmSync(broken, { recursive: true, force: true })
    expect(readDshPackageIdentity('')).toBeNull()
  })
  it('readPackageName 只报告名字、不做判定（供提示"检测到的是谁"）', () => {
    const dir = dirWith(JSON.stringify({ name: '@x1a0f3n9/dsh-workspace', version: '0.1.5-rc.3' }))
    expect(readPackageName(dir)).toBe('@x1a0f3n9/dsh-workspace')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('isOfficialDshCheckout（无 package.json 时的官方源码检出兜底）', () => {
  const makeCheckout = (opts: { named?: string; workspace?: boolean; bin?: boolean }): string => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-checkout-'))
    const dir = join(base, opts.named ?? 'deepseek-harness')
    mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true })
    if (opts.workspace !== false) writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n', 'utf8')
    if (opts.bin !== false) writeFileSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'), '', 'utf8')
    return base
  }

  it('目录名 + workspace + apps/cli/src/bin.ts 三条齐备才认', () => {
    const base = makeCheckout({})
    expect(isOfficialDshCheckout(join(base, 'deepseek-harness'))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })
  it('目录名不对（第三方 fork 放在别的目录）→ 不认', () => {
    const base = makeCheckout({ named: 'dsh-fork' })
    expect(isOfficialDshCheckout(join(base, 'dsh-fork'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })
  it('缺 workspace 或缺官方入口 → 不认（三条证据缺一不可）', () => {
    const noWorkspace = makeCheckout({ workspace: false })
    expect(isOfficialDshCheckout(join(noWorkspace, 'deepseek-harness'))).toBe(false)
    rmSync(noWorkspace, { recursive: true, force: true })
    const noBin = makeCheckout({ bin: false })
    expect(isOfficialDshCheckout(join(noBin, 'deepseek-harness'))).toBe(false)
    rmSync(noBin, { recursive: true, force: true })
  })
  it('空路径 / 尾分隔符都能处理', () => {
    expect(isOfficialDshCheckout('')).toBe(false)
    const base = makeCheckout({})
    expect(isOfficialDshCheckout(join(base, 'deepseek-harness') + '\\')).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })
})

describe('全局官方包 manifest 定位（版本读数的可信来源）', () => {
  it('候选路径都锁定 @deepseek-ai/dsh/package.json（不含第三方 scope）', () => {
    const list = globalDshManifestCandidates('C:\\Users\\me')
    expect(list.length).toBeGreaterThan(0)
    for (const p of list) {
      expect(p).toContain(join('@deepseek-ai', 'dsh', 'package.json'))
      expect(p).not.toContain('x1a0f3n9')
    }
  })
})
