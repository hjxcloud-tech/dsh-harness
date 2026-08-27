import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  applyNoOpenAdaptive,
  DshServiceManager,
  detectStartupCommand,
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
