import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDeps, installDependency, installDsh } from '../src/installer'

type Result = { ok?: boolean; out?: string; err?: string }
type Table = Record<string, Result>

function fakeExec(table: Table): typeof import('node:child_process').execFile {
  return ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
    const key = args.join(' ')
    const r = table[key] ?? { ok: true, out: '' }
    cb(r.ok === false ? new Error(r.err ?? 'cmd error') : null, r.out ?? '', r.err ?? '')
  }) as unknown as typeof import('node:child_process').execFile
}

function makeFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-installer-repo-'))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n')
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'deepseek-harness', scripts: { dsh: 'node --import tsx/esm apps/cli/src/bin.ts' } }),
  )
  return dir
}

// 与 installer.ts 的克隆参数一致（含 http 韧性配置与镜像兜底）
const CLONE_PREFIX =
  'clone --depth 1 --config http.postBuffer=524288000 --config http.lowSpeedLimit=1000 --config http.lowSpeedTime=30 '
const officialCloneKey = (target: string): string => CLONE_PREFIX + 'https://github.com/deepseek-ai/deepseek-harness.git ' + target
const mirrorCloneKey = (target: string): string =>
  CLONE_PREFIX + 'https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git ' + target

describe('installDsh', () => {
  it('目录已存在且是 DSH 仓库时直接复用', async () => {
    const repo = makeFakeRepo()
    const r = await installDsh(repo, { exec: fakeExec({}) })
    expect(r.ok).toBe(true)
    expect(r.dir).toBe(repo)
    expect(r.message).toContain('已安装')
    rmSync(repo, { recursive: true, force: true })
  })

  it('目录已存在但不是 DSH 仓库（含内容）时拒绝覆盖', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-installer-plain-'))
    writeFileSync(join(plain, 'keep.txt'), 'do not delete')
    const r = await installDsh(plain, { exec: fakeExec({}) })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('更换安装目录')
    rmSync(plain, { recursive: true, force: true })
  })

  it('空目录（上次克隆残留）会被清理后重试克隆', async () => {
    const target = join(tmpdir(), `dsh-installer-rescue-${Date.now()}`)
    mkdirSync(target) // 空目录 = 残缺克隆残留
    const exec = ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
      if (args.join(' ') === officialCloneKey(target)) {
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
      }
      cb(null, '', '')
    }) as unknown as typeof import('node:child_process').execFile

    const r = await installDsh(target, { exec, hasBin: () => false })
    expect(r.ok).toBe(true)
    expect(r.dir).toBe(target)
    rmSync(target, { recursive: true, force: true })
  })

  it('克隆失败（官方与镜像均失败）时返回原因与镜像提示', async () => {
    const target = join(tmpdir(), `dsh-installer-target-${Date.now()}`)
    const r = await installDsh(target, {
      exec: fakeExec({
        [officialCloneKey(target)]: { ok: false, err: 'Could not resolve host' },
        [mirrorCloneKey(target)]: { ok: false, err: 'mirror unreachable' },
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('克隆失败')
    expect(r.message).toContain('gh-proxy')
  })

  it('官方源失败时自动切镜像重试并成功', async () => {
    const target = join(tmpdir(), `dsh-installer-mirror-${Date.now()}`)
    const exec = ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
      const key = args.join(' ')
      if (key === officialCloneKey(target)) {
        cb(new Error('connection reset'), '', 'connection reset')
        return
      }
      if (key === mirrorCloneKey(target)) {
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
      }
      cb(null, '', '')
    }) as unknown as typeof import('node:child_process').execFile

    const r = await installDsh(target, { exec, hasBin: () => false })
    expect(r.ok).toBe(true)
    expect(r.dir).toBe(target)
    rmSync(target, { recursive: true, force: true })
  })

  it('克隆成功后 pnpm 可用时执行依赖安装', async () => {
    const target = join(tmpdir(), `dsh-installer-target2-${Date.now()}`)
    const cloneKey = officialCloneKey(target)
    // 克隆成功后需要目录校验通过：让 fakeExec 的 clone 回调里创建目标目录结构
    const exec = ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
      const key = args.join(' ')
      if (key === cloneKey) {
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
        writeFileSync(
          join(target, 'package.json'),
          JSON.stringify({ name: 'deepseek-harness', scripts: { dsh: 'x' } }),
        )
      }
      const r = (fakeExec({ [cloneKey]: { ok: true, out: '' }, [`-C ${target} install`]: { ok: true, out: '' } }) as unknown as {
        (cmd: string, a: string[], o: unknown, cb: (e: Error | null, o: string, s: string) => void): void
      })(_cmd, args, _opts, cb)
    }) as unknown as typeof import('node:child_process').execFile

    const r = await installDsh(target, { exec, hasBin: (n) => n === 'pnpm' })
    expect(r.ok).toBe(true)
    expect(r.dir).toBe(target)
    expect(r.message).not.toContain('依赖安装未完成')
    rmSync(target, { recursive: true, force: true })
  })

  it('pnpm 不可用时提示安装 pnpm', async () => {
    const target = join(tmpdir(), `dsh-installer-target3-${Date.now()}`)
    const cloneKey = officialCloneKey(target)
    const exec = ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
      if (args.join(' ') === cloneKey) {
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
      }
      cb(null, '', '')
    }) as unknown as typeof import('node:child_process').execFile

    const r = await installDsh(target, { exec, hasBin: () => false })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('未检测到 pnpm')
    rmSync(target, { recursive: true, force: true })
  })

  it('安装目录为空时返回错误', async () => {
    const r = await installDsh('', { exec: fakeExec({}) })
    expect(r.ok).toBe(false)
  })

  it('安装过程按步骤回调 onStep', async () => {
    const target = join(tmpdir(), `dsh-installer-step-${Date.now()}`)
    const cloneKey = officialCloneKey(target)
    const steps: string[] = []
    const exec = ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
      if (args.join(' ') === cloneKey) {
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
      }
      cb(null, '', '')
    }) as unknown as typeof import('node:child_process').execFile

    const r = await installDsh(target, {
      exec,
      hasBin: (n) => n === 'pnpm',
      onStep: (s) => steps.push(s),
    })
    expect(r.ok).toBe(true)
    expect(steps.length).toBeGreaterThanOrEqual(2)
    expect(steps[0]).toContain('下载')
    expect(steps[steps.length - 1]).toBe('安装完成')
    rmSync(target, { recursive: true, force: true })
  })
})

describe('checkDeps', () => {
  it('按注入探测结果返回依赖状态', () => {
    const d = checkDeps({ hasBin: (n) => n === 'git' || n === 'node' })
    expect(d).toEqual({ git: true, node: true, pnpm: false })
  })
})

describe('installDependency', () => {
  it('Windows 下 git 缺失时执行 winget 安装', async () => {
    if (process.platform !== 'win32') return
    const r = await installDependency('git', {
      exec: fakeExec({ 'install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent': { ok: true, out: '' } }),
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('git 已安装')
  })

  it('pnpm 缺失时优先执行 winget 安装（不依赖 node）', async () => {
    if (process.platform !== 'win32') return
    const r = await installDependency('pnpm', {
      exec: fakeExec({ 'install --id pnpm.pnpm -e --accept-source-agreements --accept-package-agreements --silent': { ok: true, out: '' } }),
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('pnpm 已安装')
  })

  it('pnpm winget 安装失败时退回 npm 全局安装', async () => {
    if (process.platform !== 'win32') return
    const r = await installDependency('pnpm', {
      exec: fakeExec({
        'install --id pnpm.pnpm -e --accept-source-agreements --accept-package-agreements --silent': { ok: false, err: 'source unavailable' },
        'install -g pnpm': { ok: true, out: '' },
      }),
    })
    expect(r.ok).toBe(true)
  })

  it('非 Windows 平台返回手动指引', async () => {
    if (process.platform === 'win32') return
    const r = await installDependency('git')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('手动安装')
  })
})
