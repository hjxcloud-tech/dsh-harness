import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  applyNoOpenAdaptive,
  DSH_CMD_RE,
  DshServiceManager,
  detectStartupCommand,
  filterDshProcesses,
  launchLogFile,
  parseLaunchUrl,
  renderCommand,
  type DshSpawnDeps,
} from '../src/service-manager'

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
    // 关键：killPortOwner 必须 mock——真实实现会 netstat/powershell/taskkill，
    // 在测试里执行既不稳定（worker 崩溃）又会误杀真实运行的 DSH
    killPortOwner: vi.fn(),
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

  it('start 前经注入依赖清理端口残留进程（killPortOwner mock 被调用）', () => {
    const d = deps({ probe: vi.fn(async () => false) })
    const m = new DshServiceManager(baseOpts, d)
    m.start()
    expect(d.killPortOwner).toHaveBeenCalledWith(3080)
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

describe('DSH 进程识别（v2.4.0：升级前结束所有 DSH 进程）', () => {
  it('filterDshProcesses：命中 CLI/仓库/桥接路径，排除自身、重复 pid 与无关 node', () => {
    const rows = [
      { pid: 100, command: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3080 --no-open' },
      { pid: 101, command: 'node D:\\deepseek-harness\\apps\\cli\\src\\bin.ts web' },
      { pid: 102, command: 'node C:\\Users\\me\\.dsh\\profiles\\web\\dsh-obsidian-bridge\\index.mjs' },
      { pid: 103, command: 'node C:\\other\\vite.js dev' },
      { pid: 104, command: 'C:\\Program Files\\nodejs\\node.exe C:\\app\\server.js' },
      { pid: 100, command: 'duplicate pid' },
      { pid: 999, command: 'node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web' },
      { pid: 0, command: '@deepseek-ai\\dsh broken pid' },
    ]
    const found = filterDshProcesses(rows, 999)
    expect(found.map((p) => p.pid)).toEqual([100, 101, 102])
    expect(DSH_CMD_RE.test('node C:\\app\\server.js')).toBe(false)
    expect(DSH_CMD_RE.test('node C:\\other\\vite.js dev')).toBe(false)
  })
})
