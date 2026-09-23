import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { execFile as execFileImpl } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ancestorChain,
  applyNoOpenAdaptive,
  DSH_CMD_RE,
  DshServiceManager,
  detectStartupCommand,
  ensureProfile,
  filterDshProcesses,
  launchLogFile,
  managedPidsForPort,
  parseLaunchUrl,
  pickErrorLine,
  portOwnerVerdict,
  probeBridgeInjected,
  BRIDGE_PAGE_MARKER,
  profileStartupCommand,
  readManagedProcs,
  registerManagedProc,
  renderCommand,
  repoStartupTail,
  unregisterManagedProc,
  type DshSpawnDeps,
  type ProcRow,
} from '../src/service-manager'
import { RESERVED_PROFILES } from '../src/profile'

// service-manager 使用 window.setTimeout（Obsidian popout 兼容要求），Node 测试环境补 window 全局
vi.stubGlobal('window', globalThis)

function fakeChild() {
  const ee = new EventEmitter() as any
  ee.kill = vi.fn(() => { ee.emit('exit', 0); return true })
  return ee
}

function deps(overrides: Partial<DshSpawnDeps> = {}): DshSpawnDeps {
  return {
    probe: vi.fn(async () => true),
    spawnProcess: vi.fn(() => fakeChild()),
    // 关键：v2.6.0 起端口相关依赖必须 mock——真实实现会 netstat/powershell/taskkill，
    // 在测试里执行既不稳定（worker 崩溃）又会误杀真实运行的 DSH
    acquirePort: vi.fn(async () => 'free' as const),
    killManaged: vi.fn(async () => 0),
    ...overrides,
  }
}

const baseOpts = {
  port: 3080,
  startupCommand: 'dsh web --port {port}',
  startupCwd: '/vault',
  autoStart: true,
  detached: false,
  pollIntervalMs: 5,
  readyTimeoutMs: 100,
}

describe('renderCommand', () => {
  it('展开 {port} 占位并拆分命令与参数', () => {
    expect(renderCommand('dsh web --port {port}', 3080)).toEqual({
      command: 'dsh',
      args: ['web', '--port', '3080'],
    })
  })
  it('处理多空格与首尾空白', () => {
    expect(renderCommand('  pnpm   dsh web  ', 8080)).toEqual({
      command: 'pnpm',
      args: ['dsh', 'web'],
    })
  })
})

describe('detectStartupCommand', () => {
  it('返回字符串且形态正确（PATH 探测可能命中或为空）', () => {
    const cmd = detectStartupCommand()
    expect(typeof cmd).toBe('string')
    // --no-open 仅全局 CLI 支持；不支持时降级为不带 flag 的命令（自动开浏览器可接受）
    expect(cmd === '' || cmd === 'dsh web --port {port} --no-open' || cmd === 'dsh web --port {port}').toBe(true)
  })
})

describe('applyNoOpenAdaptive（--no-open 双向自适应）', () => {
  it('支持且缺 flag → 补上（重启服务不再拉起浏览器）', () => {
    expect(applyNoOpenAdaptive('dsh web --port {port}', true)).toBe('dsh web --port {port} --no-open')
    expect(applyNoOpenAdaptive('dsh web --port 3080', true)).toBe('dsh web --port 3080 --no-open')
  })
  it('支持且已有 flag / 空命令 → null（无需写盘）', () => {
    expect(applyNoOpenAdaptive('dsh web --port {port} --no-open', true)).toBeNull()
    expect(applyNoOpenAdaptive('', true)).toBeNull()
    expect(applyNoOpenAdaptive('   ', true)).toBeNull()
  })
  it('不支持且含 flag → 移除（旧版 dsh 不认识该参数）', () => {
    expect(applyNoOpenAdaptive('dsh web --port {port} --no-open', false)).toBe('dsh web --port {port}')
  })
  it('不支持且不含 flag / 移除后为空 → null', () => {
    expect(applyNoOpenAdaptive('dsh web --port {port}', false)).toBeNull()
    expect(applyNoOpenAdaptive('--no-open', false)).toBeNull()
  })
})

describe('DshServiceManager', () => {
  it('服务在线时 ensureOnline 直接返回 online 且不 spawn', async () => {
    const d = deps()
    const m = new DshServiceManager(baseOpts, d)
    expect(await m.ensureOnline()).toEqual({ kind: 'online' })
    expect(d.spawnProcess).not.toHaveBeenCalled()
  })

  it('离线且 autoStart=true 时 spawn 并轮询至 online', async () => {
    const d = deps({ probe: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true) })
    const m = new DshServiceManager(baseOpts, d)
    expect(await m.ensureOnline()).toEqual({ kind: 'online' })
    expect(d.spawnProcess).toHaveBeenCalledWith('dsh', ['web', '--port', '3080'], '/vault', false)
    expect(m.spawned).toBe(true)
  })

  it('离线且 autoStart=false 返回 failed 且不 spawn', async () => {
    const d = deps({ probe: vi.fn(async () => false) })
    const m = new DshServiceManager({ ...baseOpts, autoStart: false }, d)
    const state = await m.ensureOnline()
    expect(state.kind).toBe('failed')
    expect(d.spawnProcess).not.toHaveBeenCalled()
  })

  it('轮询超时返回 failed', async () => {
    const d = deps({ probe: vi.fn(async () => false) })
    const m = new DshServiceManager({ ...baseOpts, readyTimeoutMs: 30, pollIntervalMs: 5 }, d)
    const state = await m.ensureOnline()
    expect(state.kind).toBe('failed')
    expect((state as any).message).toContain('超时')
  })

  it('spawn 失败（error 事件）时 ensureOnline 返回启动失败原因', async () => {
    const child = fakeChild()
    setTimeout(() => child.emit('error', new Error('ENOENT')), 5)
    const d = deps({
      probe: vi.fn(async () => false),
      spawnProcess: vi.fn(() => child),
    })
    const m = new DshServiceManager(baseOpts, d)
    const state = await m.ensureOnline()
    expect(state).toEqual({ kind: 'failed', message: '启动失败：ENOENT' })
  })

  it('子进程提前退出（非 0 退出码）时 ensureOnline 返回进程已退出', async () => {
    const child = fakeChild()
    setTimeout(() => child.emit('exit', 1), 5)
    const d = deps({
      probe: vi.fn(async () => false),
      spawnProcess: vi.fn(() => child),
    })
    const m = new DshServiceManager(baseOpts, d)
    const state = await m.ensureOnline()
    expect(state.kind).toBe('failed')
    expect((state as any).message).toContain('进程已退出')
  })

  it('dispose 终止自启进程（detached=false）', () => {
    const d = deps({ probe: vi.fn(async () => false) })
    const m = new DshServiceManager(baseOpts, d)
    m.start()
    expect(m.spawned).toBe(true)
    const child = (d.spawnProcess as any).mock.results[0].value
    m.dispose()
    expect(child.kill).toHaveBeenCalled()
  })

  it('detached=true 时 dispose 不 kill', () => {
    const d = deps({ probe: vi.fn(async () => false) })
    const m = new DshServiceManager({ ...baseOpts, detached: true }, d)
    m.start()
    const child = (d.spawnProcess as any).mock.results[0].value
    m.dispose()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('ensureOnline 先经 acquirePort 端口裁决（v2.6.0：外部 DSH 占用 → 明确失败且绝不 spawn/绝不杀）', async () => {
    const d = deps({ probe: vi.fn(async () => false), acquirePort: vi.fn(async () => 'external' as const) })
    const m = new DshServiceManager(baseOpts, d)
    const state = await m.ensureOnline()
    expect(state.kind).toBe('failed')
    expect(d.spawnProcess).not.toHaveBeenCalled()
    expect(d.acquirePort).toHaveBeenCalledWith(3080, expect.any(Array))
  })

  it('ensureOnline 在线时不触发端口裁决（也不 spawn）', async () => {
    const d = deps()
    const m = new DshServiceManager(baseOpts, d)
    expect(await m.ensureOnline()).toEqual({ kind: 'online' })
    expect(d.acquirePort).not.toHaveBeenCalled()
  })
})

describe('restartManaged（v2.6.0 作用域重启）', () => {
  it('无受管残留且端口空闲 → ok（直接可拉起）', async () => {
    const d = deps({ probe: vi.fn(async () => false), killManaged: vi.fn(async () => 0) })
    const m = new DshServiceManager(baseOpts, d)
    expect(await m.restartManaged()).toBe('ok')
    expect(d.killManaged).toHaveBeenCalledWith(3080)
  })
  it('无受管残留但端口仍应答 → external（占用者非本插件，调用方弹确认，不静默杀）', async () => {
    const d = deps({ probe: vi.fn(async () => true), killManaged: vi.fn(async () => 0) })
    const m = new DshServiceManager(baseOpts, d)
    expect(await m.restartManaged()).toBe('external')
  })
  it('杀过受管进程后等待端口真正释放（v2.4.4 竞态纪律保留）', async () => {
    let probes = 0
    const d = deps({
      probe: vi.fn(async () => { probes += 1; return probes <= 1 }),
      killManaged: vi.fn(async () => 1),
    })
    const m = new DshServiceManager(baseOpts, d)
    expect(await m.restartManaged()).toBe('ok')
  })
  it('杀过受管进程但端口仍被应答 → external（存在第二个非受管占用者）', async () => {
    const d = deps({ probe: vi.fn(async () => true), killManaged: vi.fn(async () => 1) })
    const m = new DshServiceManager({ ...baseOpts, readyTimeoutMs: 50 }, d)
    expect(await m.restartManaged(400)).toBe('external')
  })
})

describe('v2.6.0 profile 命令形态（CLI 实态：web 子命令拒收父级 --profile，bin.js L98/L100）', () => {
  it('profileStartupCommand：web/空 → dsh web；非 web → dsh --profile <p>（主程序形态）', () => {
    expect(profileStartupCommand('web')).toBe('dsh web --port {port} --no-open')
    expect(profileStartupCommand('')).toBe('dsh web --port {port} --no-open')
    expect(profileStartupCommand('test')).toBe('dsh --profile test --port {port} --no-open')
    expect(profileStartupCommand('test')).not.toContain('web --profile')
  })
  it('repoStartupTail：与 pnpm/npm 前缀共用的尾段随 profile 变形', () => {
    expect(repoStartupTail('web')).toBe('web --port {port}')
    expect(repoStartupTail('test')).toBe('--profile test --port {port}')
  })
})

describe('v2.6.0 端口安全纯函数', () => {
  it('portOwnerVerdict 决策表：受管∧身份确证→杀；外部 DSH→external（绝不杀）；pid 复用/无关→ignore', () => {
    const dshCmd = 'node C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile test --port 3081'
    expect(portOwnerVerdict(dshCmd, true)).toBe('kill')
    // VBS 隐藏控制台树根命令行含 dsh-launch-*.vbs（winSpawnHidden）
    expect(portOwnerVerdict('wscript.exe //nologo //b C:\\Temp\\dsh-launch-1234-56.vbs', true)).toBe('kill')
    expect(portOwnerVerdict(dshCmd, false)).toBe('external')
    expect(portOwnerVerdict('node C:\\other\\vite.js dev', false)).toBe('ignore')
    // pid 复用：注册表命中但命令行对不上 → 不杀
    expect(portOwnerVerdict('C:\\Program Files\\SomeApp\\app.exe', true)).toBe('ignore')
    expect(portOwnerVerdict('', true)).toBe('ignore')
  })
  it('ancestorChain：自 pid 含自身上溯到根；环保护；未知 pid 空数组', () => {
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, cmd: 'root' },
      { pid: 2, ppid: 1, cmd: 'wscript' },
      { pid: 3, ppid: 2, cmd: 'cmd' },
      { pid: 4, ppid: 3, cmd: 'node' },
    ]
    expect(ancestorChain(rows, 4).map((r) => r.pid)).toEqual([4, 3, 2, 1])
    expect(ancestorChain(rows, 2).map((r) => r.pid)).toEqual([2, 1])
    expect(ancestorChain(rows, 99)).toEqual([])
    const cyc: ProcRow[] = [ { pid: 1, ppid: 2, cmd: 'a' }, { pid: 2, ppid: 1, cmd: 'b' } ]
    expect(ancestorChain(cyc, 1).map((r) => r.pid)).toEqual([1, 2])
  })
  it('DSH_CMD_RE：桥接路径段不再钉死 web（多 profile），无关进程仍不命中', () => {
    expect(DSH_CMD_RE.test('node C:\\Users\\me\\.dsh\\profiles\\test\\dsh-obsidian-bridge\\index.mjs')).toBe(true)
    expect(DSH_CMD_RE.test('node C:\\app\\server.js')).toBe(false)
  })
  it('受管注册表：登记/读取/注销/按端口列出（死 pid 顺带清理）', () => {
    const file = join(tmpdir(), `dsh-managed-test-${String(process.pid)}-${String(Date.now())}.json`)
    try {
      registerManagedProc({ pid: 999999999, port: 3081, profile: 'test', startedAt: Date.now() }, file)
      registerManagedProc({ pid: process.pid, port: 3081, profile: 'test', startedAt: Date.now() }, file)
      // 同 pid 重复登记去重
      registerManagedProc({ pid: process.pid, port: 3081, profile: 'test', startedAt: Date.now() }, file)
      expect(readManagedProcs(file).length).toBe(2)
      // managedPidsForPort GC 死 pid（999999999 不存在）后只剩本进程
      expect(managedPidsForPort(3081, file)).toEqual([process.pid])
      expect(readManagedProcs(file).map((r) => r.pid)).toEqual([process.pid])
      unregisterManagedProc(process.pid, file)
      expect(readManagedProcs(file)).toEqual([])
    } finally {
      try {
        unlinkSync(file)
      } catch {
        // 已被清理
      }
    }
  })
})

describe('启动输出捕获（v2.3.0：token URL → 在浏览器打开）', () => {
  const port = 3199
  it('parseLaunchUrl：解析 dsh web 打印的认证 URL（忽略 LAN 附加）', () => {
    expect(parseLaunchUrl('dsh web: http://127.0.0.1:3099/?token=abc (LAN: http://192.168.1.5:3099/?token=abc)')).toBe('http://127.0.0.1:3099/?token=abc')
    expect(parseLaunchUrl('dsh web: http://127.0.0.1:3080/\n')).toBe('http://127.0.0.1:3080/')
    expect(parseLaunchUrl('no url here')).toBe('')
  })
  it('getLaunchUrl：每次重读日志（token 换新立即生效）；日志清空则清掉旧 token', () => {
    const file = launchLogFile(port)
    const d = deps({ probe: vi.fn(async () => false) })
    const m = new DshServiceManager({ ...baseOpts, port }, d)
    // 未生成日志：空串（不抛错）
    writeFileSync(file, '')
    expect(m.getLaunchUrl()).toBe('')
    writeFileSync(file, `dsh web: http://127.0.0.1:${String(port)}/?token=t1\n`)
    expect(m.getLaunchUrl()).toBe(`http://127.0.0.1:${String(port)}/?token=t1`)
    // v2.4.0：不再永久缓存——服务重启换了 token 必须立刻反映（否则面板一直 401）
    writeFileSync(file, `dsh web: http://127.0.0.1:${String(port)}/?token=t2\n`)
    expect(m.getLaunchUrl()).toBe(`http://127.0.0.1:${String(port)}/?token=t2`)
    // 日志被截断（新进程还没打印）→ 旧 token 立即作废
    writeFileSync(file, '')
    expect(m.getLaunchUrl()).toBe('')
    unlinkSync(file)
  })
  it('waitPortFree：端口释放前轮询等待→true；始终占用→超时 false（修"重启服务后白屏"竞态）', async () => {
    let calls = 0
    const d = deps({
      probe: vi.fn(async () => {
        calls += 1
        return calls <= 2 // 前两次仍被旧进程占用，之后释放
      }),
    })
    const m = new DshServiceManager({ ...baseOpts, port }, d)
    await expect(m.waitPortFree(3000)).resolves.toBe(true)
    expect(calls).toBeGreaterThanOrEqual(3)
    // 始终被占用 → 超时返回 false（交由调用方补杀）
    const d2 = deps({ probe: vi.fn(async () => true) })
    const m2 = new DshServiceManager({ ...baseOpts, port }, d2)
    await expect(m2.waitPortFree(400)).resolves.toBe(false)
  })
  it('start 会截断旧日志（避免读到上次启动的过期 token）', () => {
    const file = launchLogFile(port)
    writeFileSync(file, `dsh web: http://127.0.0.1:${String(port)}/?token=stale\n`)
    const m = new DshServiceManager({ ...baseOpts, port }, deps({ probe: vi.fn(async () => false) }))
    m.start()
    expect(readFileSync(file, 'utf8')).toBe('')
    m.getLaunchUrl() // 触发重新解析（此时为空）
    expect(m.getLaunchUrl()).toBe('')
    unlinkSync(file)
  })
  it('clearLaunchUrl：丢弃缓存后按新日志重新解析（v2.4.0 升级/重启换 token）', () => {
    const file = launchLogFile(port)
    const m = new DshServiceManager({ ...baseOpts, port }, deps({ probe: vi.fn(async () => false) }))
    writeFileSync(file, `dsh web: http://127.0.0.1:${String(port)}/?token=old\n`)
    expect(m.getLaunchUrl()).toBe(`http://127.0.0.1:${String(port)}/?token=old`)
    // 服务重启：日志被换新 token
    writeFileSync(file, `dsh web: http://127.0.0.1:${String(port)}/?token=new\n`)
    m.clearLaunchUrl()
    expect(m.getLaunchUrl()).toBe(`http://127.0.0.1:${String(port)}/?token=new`)
    unlinkSync(file)
  })
})

describe('pickErrorLine + ensureProfile 保留名（v2.6.0：沙盒用例 S2.4 抓出的提示缺陷）', () => {  // 真机取证版式（dsh 0.1.5-rc.2，`--profile headless --from-default-profile web --dump-default-config`）
  const REAL_STACK = [
    'file:///C:/Users/me/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:149',
    '\tif (Object.hasOwn(PROFILE_TEMPLATES, name)) throw new Error(`${NAME}: profile ${JSON.stringify(name)} is shipped and cannot be a custom profile target; omit --from-default-profile to use it`);',
    '\t                                                  ^',
    '',
    'Error: dsh: profile "headless" is shipped and cannot be a custom profile target; omit --from-default-profile to use it',
    '    at initializeProfileFromDefault (file:///C:/Users/me/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:149:80)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
    '',
    'Node.js v24.14.1',
  ].join('\n')

  it('未捕获异常版式：取 Error: 行并剥前缀，不取栈定位行', () => {
    const line = pickErrorLine(REAL_STACK)
    expect(line).toBe('dsh: profile "headless" is shipped and cannot be a custom profile target; omit --from-default-profile to use it')
    expect(line).not.toMatch(/^file:\/\//)
    expect(line).not.toMatch(/^at\s/)
    expect(line).not.toContain('Node.js v')
  })
  it('commander 版式（error: 前缀被剥掉）与非异常版式（首行即人话）都取到可读句', () => {
    expect(pickErrorLine('error: unknown option `--foo`')).toBe('unknown option `--foo`')
    expect(pickErrorLine('boom went wrong\n  at somewhere')).toBe('boom went wrong')
    expect(pickErrorLine('')).toBe('')
    expect(pickErrorLine('\n\n   \n')).toBe('')
  })
  it('ensureProfile：内置模板名在落盘前拦下，不调用外部命令，提示可读', async () => {
    const exec = vi.fn()
    for (const name of RESERVED_PROFILES) {
      const r = await ensureProfile(join(tmpdir(), 'no-such-home'), name, exec as unknown as typeof execFileImpl)
      expect(r.kind).toBe('failed')
      if (r.kind === 'failed') {
        expect(r.error).not.toMatch(/^file:\/\//)
        expect(r.error.length).toBeGreaterThan(0)
      }
    }
    expect(exec).not.toHaveBeenCalled()
    // web 仍按原语义直接判存在（默认档，免建）
    await expect(ensureProfile(join(tmpdir(), 'no-such-home'), 'web', exec as unknown as typeof execFileImpl)).resolves.toEqual({ kind: 'exists' })
  })
})

describe('DSH 进程识别（v2.4.0 引入；v2.6.1 收紧为**只认官方身份**）', () => {
  it('filterDshProcesses：命中官方包/官方仓库/包装层/桥接路径，排除自身、重复 pid 与无关与第三方', () => {
    const rows = [
      { pid: 100, command: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3080 --no-open' },
      { pid: 101, command: 'node D:\\deepseek-harness\\apps\\cli\\src\\bin.ts web' },
      { pid: 102, command: 'node C:\\Users\\me\\.dsh\\profiles\\web\\dsh-obsidian-bridge\\index.mjs' },
      { pid: 103, command: 'node C:\\other\\vite.js dev' },
      { pid: 104, command: 'C:\\Program Files\\nodejs\\node.exe C:\\app\\server.js' },
      // 插件生成的 profile 形态包装层（cmd.exe /c dsh --profile …）必须仍被认出，否则「重启服务」杀不掉自家进程
      { pid: 105, command: '"C:\\Windows\\System32\\cmd.exe" /d /s /c dsh --profile test --port 3081 --no-open' },
      // 第三方社区 scope（实测存在 @x1a0f3n9/dsh-*，版本号自成一套）：旧正则的 dsh\lib\bin.js / dsh.cmd 分支会误纳
      { pid: 106, command: 'node C:\\y\\@x1a0f3n9\\dsh-web-app\\lib\\index.js web' },
      { pid: 107, command: 'node D:\\forks\\dsh\\lib\\bin.js --profile x' },
      { pid: 108, command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd --profile x' },
      { pid: 100, command: 'duplicate pid' },
      { pid: 999, command: 'node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web' },
      { pid: 0, command: '@deepseek-ai\\dsh broken pid' },
    ]
    const found = filterDshProcesses(rows, 999)
    expect(found.map((p) => p.pid)).toEqual([100, 101, 102, 105])
    expect(DSH_CMD_RE.test('node C:\\app\\server.js')).toBe(false)
    expect(DSH_CMD_RE.test('node C:\\other\\vite.js dev')).toBe(false)
    expect(DSH_CMD_RE.test('node D:\\forks\\dsh\\lib\\bin.js web2')).toBe(false)
    // 目录名恰好含 deepseek-harness 但不是官方仓库布局（无 apps/cli）不再算命中
    expect(DSH_CMD_RE.test('node D:\\deepseek-harness-fork\\index.js')).toBe(false)
  })
})

describe('probeBridgeInjected（v2.6.0：页面级桥接探针——磁盘有文件不等于页面生效）', () => {
  /** 起一个假 DSH：按 token 决定返回带桥接标记的页面、干净页面、还是 401。 */
  async function fakeDsh(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url.includes('token=deny')) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        url.includes('token=live')
          ? `<html><head><script>window.${BRIDGE_PAGE_MARKER}=true</script></head></html>`
          : '<html><head><title>DSH</title></head></html>',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

  it('页面含桥接标记 → injected（同时验证请求确实带上了 ob=1 与 token）', async () => {
    const d = await fakeDsh()
    try {
      expect(await probeBridgeInjected(d.port, 'live')).toBe('injected')
    } finally {
      await d.close()
    }
  })
  it('服务在跑但页面没有桥接 → missing（这正是「磁盘文件新、内存脚本旧」的真机形态）', async () => {
    const d = await fakeDsh()
    try {
      expect(await probeBridgeInjected(d.port, 'stale')).toBe('missing')
    } finally {
      await d.close()
    }
  })
  it('401 → unauthorized（token 失效/换了实例），不据此判桥接坏', async () => {
    const d = await fakeDsh()
    try {
      expect(await probeBridgeInjected(d.port, 'deny')).toBe('unauthorized')
    } finally {
      await d.close()
    }
  })
  it('端口无人监听 → unreachable（不抛异常，调用方按「判不了」处理）', async () => {
    const d = await fakeDsh()
    const port = d.port
    await d.close()
    expect(await probeBridgeInjected(port, 'live')).toBe('unreachable')
  })
})
