import { describe, expect, it, vi } from 'vitest'
import {
  captureLoginShellPathAsync,
  clearLoginShellPathCache,
  compareNodeVersion,
  computeRefreshedPath,
  hasBin,
  invalidateRefreshedPath,
  LOGIN_SHELL_TIMEOUT_MS,
  mergePaths,
  nvmGlobalModuleRoots,
  nvmNodeBinDirs,
  parseShellPath,
  posixPathExtras,
  prepareExecEnvAsync,
  refreshedEnv,
  refreshedPath,
  resolveLoginShell,
} from '../src/exec-env'

/**
 * v2.8.11 共享 PATH 层的回归锁（GitHub issue #16）。
 *
 * 为什么要参数化 platform/env/homeDir/exists/readDir 而不是直接跑真机平台分支：
 * macOS 的故障（launchd 最小 PATH）无法在本仓 CI（ubuntu）或开发机（Windows）上复现，
 * 唯一可自动化的手段就是把 darwin 分支变成纯函数逐一断言。
 */
describe('mergePaths', () => {
  it('父 PATH 在前、追加在后，去重且去空段', () => {
    expect(mergePaths('/usr/bin::/bin', ['/bin', '  ', '/opt/homebrew/bin'], ':')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin',
    )
  })

  it('父 PATH 为空时不产出空段（空段在 POSIX 下等价于当前目录）', () => {
    expect(mergePaths('', ['/opt/homebrew/bin'], ':')).toBe('/opt/homebrew/bin')
  })

  it('Windows 用分号分隔', () => {
    expect(mergePaths('C:\\portable', ['C:\\nodejs', 'C:\\portable'], ';')).toBe('C:\\portable;C:\\nodejs')
  })
})

describe('compareNodeVersion / nvmNodeBinDirs', () => {
  it('版本比较按三段数值（非字典序）', () => {
    expect(compareNodeVersion('v18.20.4', 'v20.9.0')).toBe(-1)
    expect(compareNodeVersion('v22.11.0', 'v22.9.0')).toBe(1)
    expect(compareNodeVersion('22.11.0', 'v22.11.0')).toBe(0)
  })

  it('列出 <nvm>/versions/node 下的版本目录（升序），非版本目录被忽略', () => {
    const readDir = (p: string): string[] =>
      p.endsWith('node') ? ['v18.20.4', 'v22.11.0', 'v20.9.0', '.DS_Store'] : []
    const exists = (p: string): boolean => /v\d/.test(p)
    expect(nvmNodeBinDirs('/Users/u/.nvm', readDir, exists)).toEqual([
      '/Users/u/.nvm/versions/node/v18.20.4/bin',
      '/Users/u/.nvm/versions/node/v20.9.0/bin',
      '/Users/u/.nvm/versions/node/v22.11.0/bin',
    ])
  })

  it('无 nvm（目录不存在或不可读）时返回空数组，不抛错', () => {
    expect(nvmNodeBinDirs('', () => [], () => true)).toEqual([])
    expect(
      nvmNodeBinDirs('/nope', () => {
        throw new Error('ENOENT')
      }, () => false),
    ).toEqual([])
  })

  it('nvmGlobalModuleRoots：bin 目录换算为 lib/node_modules（新版本在前）', () => {
    expect(
      nvmGlobalModuleRoots({
        homeDir: '/Users/u',
        env: {},
        readDir: (p: string): string[] => (p === '/Users/u/.nvm/versions/node' ? ['v18.20.4', 'v22.11.0'] : []),
        exists: (p) => /v\d/.test(p),
      }),
    ).toEqual([
      '/Users/u/.nvm/versions/node/v22.11.0/lib/node_modules',
      '/Users/u/.nvm/versions/node/v18.20.4/lib/node_modules',
    ])
  })
})

describe('posixPathExtras（darwin/linux）', () => {
  const existsIn = (allowed: readonly string[]) => (p: string): boolean => allowed.includes(p)

  it('并入 brew 目录与 nvm 已装版本目录（只有真实存在的目录进列表）', () => {
    const dirs = posixPathExtras({
      platform: 'darwin',
      homeDir: '/Users/u',
      env: { HOME: '/Users/u' },
      readDir: () => ['v20.9.0', 'v22.11.0'],
      exists: existsIn([
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/Users/u/.nvm/versions/node/v20.9.0/bin',
        '/Users/u/.nvm/versions/node/v22.11.0/bin',
      ]),
    })
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/Users/u/.nvm/versions/node/v22.11.0/bin')
    expect(dirs).not.toContain('/opt/homebrew/sbin') // 不存在的目录不得入列
  })

  it('版本管理器优先于包管理器：nvm 目录排在 brew 之前（避免用另一个 node/npm 起服务）', () => {
    const dirs = posixPathExtras({
      platform: 'darwin',
      homeDir: '/Users/u',
      env: { HOME: '/Users/u' },
      readDir: () => ['v22.11.0'],
      exists: existsIn(['/opt/homebrew/bin', '/Users/u/.nvm/versions/node/v22.11.0/bin']),
    })
    expect(dirs.indexOf('/Users/u/.nvm/versions/node/v22.11.0/bin')).toBeLessThan(dirs.indexOf('/opt/homebrew/bin'))
  })

  it('NVM_BIN 优先，且 NVM_DIR 可覆盖默认 ~/.nvm', () => {
    const dirs = posixPathExtras({
      platform: 'darwin',
      homeDir: '/Users/u',
      env: { NVM_BIN: '/custom/bin', NVM_DIR: '/custom/nvm' },
      readDir: (p: string): string[] => (p === '/custom/nvm/versions/node' ? ['v22.11.0'] : []),
      exists: existsIn(['/custom/bin', '/custom/nvm/versions/node/v22.11.0/bin']),
    })
    expect(dirs.slice(0, 2)).toEqual(['/custom/bin', '/custom/nvm/versions/node/v22.11.0/bin'])
  })

  it('用户级工具目录（pnpm/yarn/bun/volta/asdf）按存在与否入列', () => {
    const dirs = posixPathExtras({
      platform: 'darwin',
      homeDir: '/Users/u',
      env: {},
      readDir: () => [],
      exists: existsIn([
        '/Users/u/Library/pnpm',
        '/Users/u/.volta/bin',
        '/Users/u/.asdf/shims',
        '/Users/u/.bun/bin',
      ]),
    })
    expect(dirs).toEqual([
      '/Users/u/.volta/bin',
      '/Users/u/.asdf/shims',
      '/Users/u/Library/pnpm',
      '/Users/u/.bun/bin',
    ])
  })
})

describe('computeRefreshedPath', () => {
  it('darwin：GUI 最小 PATH 场景（父 PATH 在前，brew 目录补在后，无空段）', () => {
    const path = computeRefreshedPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      homeDir: '/Users/u',
      readDir: () => [],
      exists: (p) => p === '/opt/homebrew/bin' || p === '/usr/local/bin',
    })
    expect(path.startsWith('/usr/bin:/bin:/usr/sbin:/sbin:')).toBe(true)
    expect(path).toContain('/opt/homebrew/bin')
    expect(path.split(':')).not.toContain('')
  })

  it('darwin：父 PATH 为空（env -i 形态）时只剩补入目录', () => {
    expect(
      computeRefreshedPath({
        platform: 'darwin',
        env: { PATH: '' },
        homeDir: '/u',
        readDir: () => [],
        exists: (p) => p === '/opt/homebrew/bin',
      }),
    ).toBe('/opt/homebrew/bin')
  })

  it('win32：注册表 PATH 追加而非替换（并集，父 PATH 不丢）', () => {
    expect(
      computeRefreshedPath({
        platform: 'win32',
        env: { PATH: 'C:\\portable-node' },
        readWindowsRegistryPath: () => 'C:\\Program Files\\nodejs;C:\\portable-node',
      }),
    ).toBe('C:\\portable-node;C:\\Program Files\\nodejs')
  })

  it('win32：注册表读取失败时保留父 PATH', () => {
    expect(
      computeRefreshedPath({
        platform: 'win32',
        env: { PATH: 'C:\\only' },
        readWindowsRegistryPath: () => '',
      }),
    ).toBe('C:\\only')
  })
})

describe('refreshedPath / refreshedEnv / hasBin', () => {
  it('注入选项不污染缓存：真实缓存仍按当前进程环境计算', () => {
    invalidateRefreshedPath()
    const injected = refreshedPath({
      platform: 'darwin',
      env: { PATH: '/injected-only' },
      homeDir: '/nobody',
      readDir: () => [],
      exists: () => false,
    })
    expect(injected).toBe('/injected-only')
    expect(refreshedPath()).not.toBe('/injected-only')
  })

  it('refreshedEnv 同时写 PATH 与 Path，且合并是并集（父 PATH 的每一项都在，首项顺序不变）', () => {
    invalidateRefreshedPath()
    const env = refreshedEnv()
    expect(env.PATH).toBe(env.Path)
    // 注意：合并会**去重**，父 PATH 自身可能含重复项（本机实测就有），
    // 因此不能断言「父 PATH 是合并结果的连续子串」，只能按段断言并集。
    const separator = process.platform === 'win32' ? ';' : ':'
    const parentParts = (process.env.PATH ?? '').split(separator).filter((p) => p !== '')
    if (parentParts.length > 0) {
      const merged = (env.PATH ?? '').split(separator)
      for (const part of new Set(parentParts)) {
        expect(merged).toContain(part)
      }
      expect(merged[0]).toBe(parentParts[0])
    }
    expect(env.NODE_ENV).toBe(process.env.NODE_ENV)
  })

  it('hasBin：当前进程 PATH 上的 node 必须命中（合并不得丢父 PATH）', () => {
    expect(hasBin('node')).toBe(true)
  })

  it('hasBin：不存在的命令返回 false', () => {
    expect(hasBin('dsh-definitely-not-installed-xyz')).toBe(false)
  })
})

/**
 * v2.8.11 第二步：登录 shell PATH 捕获。
 * 静态 extras 只能猜常见目录，猜不到 nvm 的 `alias/default`（可能默认 v20 而目录里最新是 v22）、
 * volta/fnm 的软链解析、以及用户 rc 里手工拼的 PATH —— 只能让 $SHELL 以登录+交互方式报一遍。
 * 这些用例把「解析/选中/超时/记忆/合并优先级」全部锁在 Windows 上也能跑。
 */
describe('parseShellPath / resolveLoginShell', () => {
  it('取最后一行（前面是横幅/提示），返回干净 PATH', () => {
    expect(parseShellPath('Motd banner line\n/opt/homebrew/bin:/usr/bin:/bin')).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('提示符行 / 报错文本 / 单目录 / 控制字符 / 超长 → 空串（回落静态 extras）', () => {
    expect(parseShellPath('user@host ~ %')).toBe('')
    expect(parseShellPath('zsh: command not found')).toBe('')
    expect(parseShellPath('/only-one-dir')).toBe('')
    expect(parseShellPath('/opt/homebrew/bin:\u001b[1m/usr/bin')).toBe('')
    expect(parseShellPath('')).toBe('')
    expect(parseShellPath(`/${'x'.repeat(9000)}`)).toBe('')
  })

  it('resolveLoginShell：显式指定 > $SHELL > /bin/zsh > /bin/bash > /bin/sh（取首个存在的）', () => {
    expect(
      resolveLoginShell({ shell: '/bin/fish', env: { SHELL: '/bin/zsh' }, exists: (p) => p === '/bin/fish' || p === '/bin/zsh' }),
    ).toBe('/bin/fish')
    expect(resolveLoginShell({ env: { SHELL: '/opt/custom/zsh' }, exists: (p) => p === '/opt/custom/zsh' })).toBe('/opt/custom/zsh')
    expect(resolveLoginShell({ env: {}, exists: (p) => p === '/bin/zsh' })).toBe('/bin/zsh')
    expect(resolveLoginShell({ env: {}, exists: () => false })).toBe('')
  })
})

describe('captureLoginShellPathAsync / prepareExecEnvAsync', () => {
  it('win32：不起子进程，直接返回空串（Windows 的 PATH 来自注册表，无此问题）', async () => {
    const runShell = vi.fn()
    expect(await captureLoginShellPathAsync({ platform: 'win32', shell: 'C:\\shell.exe', runShell, exists: () => true })).toBe('')
    expect(await prepareExecEnvAsync({ platform: 'win32', runShell })).toBe('')
    expect(runShell).not.toHaveBeenCalled()
  })

  it('darwin：以 -ilc 跑 `printf %s "$PATH"` 并取最后一行作为 PATH', async () => {
    const runShell = vi.fn(async () => ({
      ok: true,
      out: 'not a path\n/opt/homebrew/bin:/Users/u/.nvm/versions/node/v22.11.0/bin:/usr/bin',
    }))
    const captured = await captureLoginShellPathAsync({
      platform: 'darwin',
      shell: '/bin/zsh',
      exists: (p) => p === '/bin/zsh',
      runShell,
    })
    expect(captured).toBe('/opt/homebrew/bin:/Users/u/.nvm/versions/node/v22.11.0/bin:/usr/bin')
    expect(runShell).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-ilc', 'printf %s "$PATH"'],
      expect.objectContaining({ timeoutMs: LOGIN_SHELL_TIMEOUT_MS }),
    )
  })

  it('超时（ok=false）/ 垃圾输出 / 执行器抛错 → 空串且不抛错', async () => {
    const base = { platform: 'darwin' as const, shell: '/bin/zsh', exists: () => true }
    expect(await captureLoginShellPathAsync({ ...base, runShell: async () => ({ ok: false, out: '/a/bin:/b/bin' }) })).toBe('')
    expect(await captureLoginShellPathAsync({ ...base, runShell: async () => ({ ok: true, out: 'garbage' }) })).toBe('')
    expect(
      await captureLoginShellPathAsync({
        ...base,
        runShell: async () => {
          throw new Error('spawn ENOENT')
        },
      }),
    ).toBe('')
  })

  it('注入选项不写模块记忆（每次都用注入的执行器）', async () => {
    const runShell = vi.fn(async () => ({ ok: true, out: '/a/bin:/b/bin' }))
    const opts = { platform: 'darwin' as const, shell: '/bin/zsh', exists: () => true, runShell }
    expect(await captureLoginShellPathAsync(opts)).toBe('/a/bin:/b/bin')
    expect(await captureLoginShellPathAsync(opts)).toBe('/a/bin:/b/bin')
    expect(runShell).toHaveBeenCalledTimes(2)
  })

  it('真实路径（无注入）：本会话只跑一次，失败也记忆；clear 后可重来', async () => {
    clearLoginShellPathCache()
    // 当前平台（Windows）上是空操作：两次调用都必须安全且结果一致
    expect(await captureLoginShellPathAsync()).toBe('')
    expect(await captureLoginShellPathAsync()).toBe('')
    clearLoginShellPathCache()
  })
})

describe('登录 shell PATH 参与合并（优先级）', () => {
  it('捕获值在最前（用户终端的真实 node 优先），随后是父 PATH 与静态 extras，且无空段', () => {
    const path = computeRefreshedPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      homeDir: '/Users/u',
      readDir: () => [],
      exists: (p) => p === '/opt/homebrew/bin',
      shellPath: '/Users/u/.nvm/versions/node/v20.19.0/bin:/opt/homebrew/bin:/usr/bin:/bin',
    })
    const parts = path.split(':')
    expect(parts[0]).toBe('/Users/u/.nvm/versions/node/v20.19.0/bin')
    expect(parts).toContain('/bin')
    expect(parts).not.toContain('')
  })

  it('shellPath 显式为空 → 不使用捕获值（注入调用的确定性）', () => {
    expect(
      computeRefreshedPath({
        platform: 'darwin',
        env: { PATH: '/usr/bin' },
        shellPath: '',
        homeDir: '/u',
        readDir: () => [],
        exists: () => false,
      }),
    ).toBe('/usr/bin')
  })
})
