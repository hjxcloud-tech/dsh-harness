import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aedRecovery,
  appendBundleDisableBlocks,
  BUNDLE_DISABLE_MARKER,
  bundleUserPlugins,
  exitSafeMode,
  installDshFix,
  isDshFixInstalled,
  NPM_MIRROR,
  removeBundleDisableBlocks,
  runAedSafe,
} from '../src/aed'
import { execKey } from '../src/win-exec'

type Result = { ok?: boolean; out?: string; err?: string }
type Table = Record<string, Result>

/** win32 下应经 cmd.exe 包装执行的 npm 系命令（防 execFile ENOENT 回归）。 */
const WRAPPED = new Set(['npm', 'npx', 'pnpm', 'dsh', 'dsh-fix', 'dsh-doctor'])

function fakeExec(table: Table) {
  return ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
    const key = execKey(_cmd, args)
    const r = table[key] ?? { ok: true, out: '' }
    const first = key.split(' ')[0]
    if (
      process.platform === 'win32' &&
      WRAPPED.has(first) &&
      (_cmd !== 'cmd.exe' || args[0] !== '/d' || args[1] !== '/s' || args[2] !== '/c')
    ) {
      cb(new Error(`expected cmd.exe wrapper for ${first}`), '', '')
      return
    }
    cb(r.ok === false ? new Error(r.err ?? 'error') : null, r.out ?? '', r.err ?? '')
  }) as unknown as typeof import('node:child_process').execFile
}

describe('isDshFixInstalled', () => {
  it('返回布尔（不抛错）', () => {
    expect(typeof isDshFixInstalled()).toBe('boolean')
  })
})

describe('installDshFix', () => {
  it('官方 registry 成功', async () => {
    const r = await installDshFix(
      fakeExec({ 'install -g dsh-fix@latest --no-fund --no-audit': { ok: true, out: '' } }) as never,
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('dsh-fix')
  })

  it('官方失败自动切镜像并成功', async () => {
    const r = await installDshFix(
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: false, err: 'network error' },
        [`install -g dsh-fix@latest --registry ${NPM_MIRROR} --no-fund --no-audit`]: { ok: true, out: '' },
      }) as never,
    )
    expect(r.ok).toBe(true)
  })

  it('官方与镜像均失败返回失败', async () => {
    const r = await installDshFix(
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: false, err: 'EACCES' },
        [`install -g dsh-fix@latest --registry ${NPM_MIRROR} --no-fund --no-audit`]: { ok: false, err: 'EACCES' },
      }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('EACCES')
  })
})

describe('runAedSafe', () => {
  const home = 'D:\\fake\\.dsh'
  it('执行 doctor + safe，返回成功', async () => {
    const r = await runAedSafe(
      home,
      fakeExec({
        'doctor --home D:\\fake\\.dsh': { ok: true, out: '[✓] patches ok\n[!] warning' },
        'safe --home D:\\fake\\.dsh': { ok: true, out: 'safe mode entered' },
      }) as never,
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('安全模式')
  })

  it('safe 失败返回失败', async () => {
    const r = await runAedSafe(
      home,
      fakeExec({
        'doctor --home D:\\fake\\.dsh': { ok: true, out: '' },
        'safe --home D:\\fake\\.dsh': { ok: false, err: 'patch parse error' },
      }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('patch parse error')
  })
})

describe('exitSafeMode', () => {
  const home = 'D:\\fake\\.dsh'
  it('执行 clear 恢复用户插件，返回成功', async () => {
    const r = await exitSafeMode(
      home,
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: true, out: '' },
        'clear --home D:\\fake\\.dsh': { ok: true, out: 'all cleared' },
      }) as never,
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('退出安全模式')
  })

  it('clear 失败返回失败', async () => {
    const r = await exitSafeMode(
      home,
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: true, out: '' },
        'clear --home D:\\fake\\.dsh': { ok: false, err: 'no backups' },
      }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('no backups')
  })
})

describe('aedRecovery', () => {
  it('完整流程：安装 dsh-fix 并进入安全模式，返回成功', async () => {
    // 测试环境 dsh-fix 未装 → 尝试全局安装（表里提供 npm 成功）→ doctor/safe 走非 npx
    const r = await aedRecovery(
      'D:\\fake\\.dsh',
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: true, out: '' },
        'doctor --home D:\\fake\\.dsh': { ok: true, out: 'ok' },
        'safe --home D:\\fake\\.dsh': { ok: true, out: 'ok' },
      }) as never,
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('安全模式')
  })

  it('safe 失败时流水线返回失败', async () => {
    const r = await aedRecovery(
      'D:\\fake\\.dsh',
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: true, out: '' },
        'doctor --home D:\\fake\\.dsh': { ok: true, out: '' },
        'safe --home D:\\fake\\.dsh': { ok: false, err: 'boot failed' },
      }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('boot failed')
  })

  it('全局安装失败自动降级 npx 仍可成功', async () => {
    const r = await aedRecovery(
      'D:\\fake\\.dsh',
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: false, err: 'EACCES' },
        [`install -g dsh-fix@latest --registry ${NPM_MIRROR} --no-fund --no-audit`]: { ok: false, err: 'EACCES' },
        '--yes dsh-fix doctor --home D:\\fake\\.dsh': { ok: true, out: 'ok' },
        '--yes dsh-fix safe --home D:\\fake\\.dsh': { ok: true, out: 'ok' },
      }) as never,
    )
    expect(r.ok).toBe(true)
  })
})

describe('bundle 层用户插件禁用/恢复（dsh-fix safe 只禁 patch 层的补充）', () => {
  const home = join(tmpdir(), `dsh-aed-bundle-${Date.now()}`)
  const web = join(home, 'profiles', 'web')
  const patchPath = join(web, 'cordis.patch.yml')

  beforeAll(() => {
    mkdirSync(web, { recursive: true })
    writeFileSync(
      join(web, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-doctor', 'dsh-at-file', 'dshmarket'],
          },
        },
      }),
    )
    writeFileSync(
      patchPath,
      '# test patch\n- insert:\n    - id: dsh-obsidian-bridge\n      name: file:///x.mjs\n',
    )
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('bundleUserPlugins 只返回非核心 bundle', () => {
    expect(bundleUserPlugins(home).sort()).toEqual(['dsh-at-file', 'dsh-doctor', 'dshmarket'])
  })

  it('appendBundleDisableBlocks 追加禁用块（幂等），removeBundleDisableBlocks 精确移除', () => {
    const plugins = bundleUserPlugins(home)
    appendBundleDisableBlocks(home, plugins)
    const patch = readFileSync(patchPath, 'utf8')
    expect(patch).toContain(BUNDLE_DISABLE_MARKER + '"dsh-doctor"')
    expect(patch).toContain('- id: "dshmarket"\n  disabled: true')
    expect(patch).not.toContain('- id: "@deepseek-ai/dsh-base"')
    // 幂等：重复追加不产生重复块
    appendBundleDisableBlocks(home, plugins)
    const markers = (readFileSync(patchPath, 'utf8').match(new RegExp(BUNDLE_DISABLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    expect(markers).toBe(3)
    // 移除后恢复原状（桥接条目保留）
    removeBundleDisableBlocks(home)
    const after = readFileSync(patchPath, 'utf8')
    expect(after).not.toContain(BUNDLE_DISABLE_MARKER)
    expect(after).toContain('dsh-obsidian-bridge')
  })

  it('runAedSafe 在 safe 成功后一并禁用 bundle 层用户插件', async () => {
    const r = await runAedSafe(
      home,
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: true, out: '' },
        [`doctor --home ${home}`]: { ok: true, out: 'ok' },
        [`safe --home ${home}`]: { ok: true, out: 'ok' },
      }) as never,
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('bundle 层用户插件已一并禁用')
    expect(readFileSync(patchPath, 'utf8')).toContain(BUNDLE_DISABLE_MARKER + '"dsh-doctor"')
  })

  it('exitSafeMode 在 clear 后移除 bundle 禁用块', async () => {
    const r = await exitSafeMode(
      home,
      fakeExec({
        'install -g dsh-fix@latest --no-fund --no-audit': { ok: true, out: '' },
        [`clear --home ${home}`]: { ok: true, out: 'ok' },
      }) as never,
    )
    expect(r.ok).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).not.toContain(BUNDLE_DISABLE_MARKER)
  })
})
