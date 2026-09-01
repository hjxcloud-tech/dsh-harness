import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aedRecovery,
  appendBundleDisableBlocks,
  AUTO_FIXABLE_KINDS,
  BUNDLE_DISABLE_MARKER,
  bundleUserPlugins,
  classifyBootFailure,
  exitSafeMode,
  installDshFix,
  isDshFixInstalled,
  NPM_MIRROR,
  removeBundleDisableBlocks,
  runAedSafe,
  verifyDshBootAsync,
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
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-client-modules', 'dsh-doctor', 'dsh-at-file', 'dshmarket'],
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

  it('安全模式不误禁客户端模块（@deepseek-ai/dsh-client-modules 属核心 bundle）', () => {
    expect(bundleUserPlugins(home)).not.toContain('@deepseek-ai/dsh-client-modules')
    appendBundleDisableBlocks(home, bundleUserPlugins(home))
    expect(readFileSync(patchPath, 'utf8')).not.toContain('@deepseek-ai/dsh-client-modules')
    removeBundleDisableBlocks(home)
  })
})

describe('classifyBootFailure（启动失败关键词归因）', () => {
  it('bootstrap module face → bundle-face', () => {
    expect(classifyBootFailure('client.js did not export the bootstrap module face', '')).toBe('bundle-face')
  })
  it('client-modules / 缺预加载 → client-modules', () => {
    expect(classifyBootFailure('Error: Cannot load client modules: preload missing', '')).toBe('client-modules')
    expect(classifyBootFailure('failed to fetch dynamically imported module', '')).toBe('client-modules')
  })
  it('cordis.patch.yml 解析 → patch-parse', () => {
    expect(classifyBootFailure('failed to parse patches in cordis.patch.yml', '')).toBe('patch-parse')
  })
  it('模块缺失 → plugin-missing', () => {
    expect(classifyBootFailure("Error: Cannot find module 'dsh-x'", '')).toBe('plugin-missing')
    expect(classifyBootFailure('plugin "x" is NOT installed', '')).toBe('plugin-missing')
  })
  it('初始化崩溃 → init-crash', () => {
    expect(classifyBootFailure('Error during startup: initialization failed', '')).toBe('init-crash')
  })
  it('未知 → other', () => {
    expect(classifyBootFailure('weird error abc', '')).toBe('other')
  })
})

describe('verifyDshBootAsync（启动引导注入校验）', () => {
  const urlKey = '-L -sS --max-time 8 http://127.0.0.1:3080/'
  const assetKey = '-L -sS --max-time 6 http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-client-modules/client.js'
  const goodHtml =
    '<html><script src="/plugins/@deepseek-ai/dsh-client-modules/client.js"></script><script>window.__DSH_BOOT__</script></html>'
  const goodAsset = 'window.__ModuleLoader__.load({factory:()=>({createClientModuleSystem(){},apply(){}})})'
  it('marker 齐全 + client.js 含 bootstrap face → ok', async () => {
    const r = await verifyDshBootAsync(
      3080,
      fakeExec({ [urlKey]: { ok: true, out: goodHtml }, [assetKey]: { ok: true, out: goodAsset } }) as never,
    )
    expect(r.ok).toBe(true)
  })
  it('marker 齐全但 client.js 缺 face 导出 → bundle-face', async () => {
    const r = await verifyDshBootAsync(
      3080,
      fakeExec({
        [urlKey]: { ok: true, out: goodHtml },
        [assetKey]: { ok: true, out: 'window.__ModuleLoader__.load({factory:()=>({})})' },
      }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('bundle-face')
    expect(r.detail).toContain('createClientModuleSystem')
  })
  it('marker 齐全但 client.js 获取失败 → bundle-face', async () => {
    const r = await verifyDshBootAsync(
      3080,
      fakeExec({ [urlKey]: { ok: true, out: goodHtml }, [assetKey]: { ok: false, err: '404 Not Found' } }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('bundle-face')
    expect(r.detail).toContain('获取失败')
  })
  it('marker 齐全但 HTML 无 client.js 预加载 → client-modules', async () => {
    const r = await verifyDshBootAsync(
      3080,
      fakeExec({ [urlKey]: { ok: true, out: '<html><script>window.__DSH_BOOT__</script></html>' } }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('client-modules')
  })
  it('缺 marker → 失败并按页面内容分类', async () => {
    const r = await verifyDshBootAsync(
      3080,
      fakeExec({ [urlKey]: { ok: true, out: '<html><body>client-modules failed to load</body></html>' } }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('client-modules')
    expect(r.detail).toContain('missing:')
  })
  it('缺 marker 且页面无具体报错 → 默认 client-modules', async () => {
    const r = await verifyDshBootAsync(
      3080,
      fakeExec({ [urlKey]: { ok: true, out: '<html><head><title>DSH</title></head><body></body></html>' } }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('client-modules')
  })
  it('curl 失败（服务不可达）→ unreachable', async () => {
    const r = await verifyDshBootAsync(
      3080,
      fakeExec({ [urlKey]: { ok: false, err: 'Connection refused' } }) as never,
    )
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('unreachable')
  })
})

describe('AUTO_FIXABLE_KINDS（可自动修复类）', () => {
  it('覆盖 client-modules / bundle-face / patch-parse，排除其余', () => {
    expect(AUTO_FIXABLE_KINDS.has('client-modules')).toBe(true)
    expect(AUTO_FIXABLE_KINDS.has('bundle-face')).toBe(true)
    expect(AUTO_FIXABLE_KINDS.has('patch-parse')).toBe(true)
    expect(AUTO_FIXABLE_KINDS.has('plugin-missing')).toBe(false)
    expect(AUTO_FIXABLE_KINDS.has('init-crash')).toBe(false)
    expect(AUTO_FIXABLE_KINDS.has('unreachable')).toBe(false)
    expect(AUTO_FIXABLE_KINDS.has('other')).toBe(false)
  })
})
