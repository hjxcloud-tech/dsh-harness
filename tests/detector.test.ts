import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectDshConfig,
  isDshRepo,
  locateDshRepoDir,
} from '../src/detector'

function makeFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detector-'))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n')
  writeFileSync(
    join(dir, 'package.json'),
    // 真实克隆的根包名（实测 D:\deepseek-harness → @deepseek-ai/dsh-root）
    JSON.stringify({ name: '@deepseek-ai/dsh-root', scripts: { dsh: 'node --import tsx/esm apps/cli/src/bin.ts' } }),
  )
  return dir
}

/** 造一个只有形状、没有官方身份的目录（v2.6.0 起不应再被当成本体）。 */
function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detector-'))
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(dir, rel), body, 'utf8')
  }
  return dir
}

describe('isDshRepo（v2.6.0：按官方包名身份判定，不再靠形状猜测）', () => {
  it('官方本体包名（@deepseek-ai/dsh-root 源码根 / @deepseek-ai/dsh 全局包）→ 是', () => {
    const repo = makeFakeRepo()
    expect(isDshRepo(repo)).toBe(true)
    const cli = makeDir({ 'package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }) })
    expect(isDshRepo(cli)).toBe(true)
    rmSync(repo, { recursive: true, force: true })
    rmSync(cli, { recursive: true, force: true })
  })

  it('仅有 pnpm-workspace.yaml 的任意 monorepo → 不是（旧判据的误报源）', () => {
    const dir = makeDir({ 'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n' })
    expect(isDshRepo(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('第三方 scope 的 dsh 包 → 不是（实测存在 @x1a0f3n9/dsh-web-app，版本号自成一套）', () => {
    const dir = makeDir({
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
      'package.json': JSON.stringify({ name: '@x1a0f3n9/dsh-web-app', version: '0.1.5-rc.3', scripts: { dsh: 'x' } }),
    })
    expect(isDshRepo(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('官方**子包**（dsh-web-app 等）也不是本体：版本与更新只认核心包', () => {
    const dir = makeDir({ 'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '0.1.5-rc.3' }) })
    expect(isDshRepo(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('无 package.json 的官方源码检出（目录名 + workspace + apps/cli/src/bin.ts）→ 兜底认', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-detector-'))
    const dir = join(base, 'deepseek-harness')
    mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n', 'utf8')
    writeFileSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'), '', 'utf8')
    expect(isDshRepo(dir)).toBe(true)
    // 缺任一条形状证据就不认（避免把同名空目录当本体）
    rmSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))
    expect(isDshRepo(dir)).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  it('普通目录不是 DSH 仓库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-detector-plain-'))
    expect(isDshRepo(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('locateDshRepoDir', () => {
  it('返回第一个命中的仓库目录', () => {
    const repo = makeFakeRepo()
    const plain = mkdtempSync(join(tmpdir(), 'dsh-detector-plain2-'))
    expect(locateDshRepoDir([plain, repo, 'C:\\no-such-dir'])).toBe(repo)
    rmSync(repo, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  })

  it('无命中返回 null', () => {
    expect(locateDshRepoDir(['C:\\no-such-dir', ''])).toBeNull()
  })
})

describe('detectDshConfig', () => {
  it('PATH 中有 dsh 时直接使用 dsh 命令', async () => {
    const r = await detectDshConfig({ cwd: '' }, { hasBin: (n) => n === 'dsh' })
    expect(r.found).toBe(true)
    expect(r.startupCommand).toBe('dsh web --port {port} --no-open')
  })

  it('检测到仓库且 pnpm 可用时使用 pnpm 命令', async () => {
    const repo = makeFakeRepo()
    const r = await detectDshConfig(
      { cwd: '' },
      { homeDir: tmpdir(), candidates: [repo], hasBin: (n) => n === 'pnpm' },
    )
    expect(r.found).toBe(true)
    expect(r.startupCwd).toBe(repo)
    expect(r.startupCommand).toBe('pnpm dsh web --port {port}')
    rmSync(repo, { recursive: true, force: true })
  })

  it('pnpm 不可用时回退 npm 命令', async () => {
    const repo = makeFakeRepo()
    const r = await detectDshConfig(
      { cwd: '' },
      { homeDir: tmpdir(), candidates: [repo], hasBin: () => false },
    )
    expect(r.found).toBe(true)
    expect(r.startupCommand).toBe('npm run dsh -- web --port {port}')
    rmSync(repo, { recursive: true, force: true })
  })

  it('均未命中时返回 found=false 与指引', async () => {
    const r = await detectDshConfig(
      { cwd: '' },
      { homeDir: tmpdir(), candidates: ['C:\\no-such-dir'], hasBin: () => false },
    )
    expect(r.found).toBe(false)
    expect(r.message).toContain('未检测到')
  })

  // v2.6.0 多 profile：非 web 用主程序形态（web 子命令拒收父级 --profile，dsh bin.js L98/L100）
  it('非 web profile：PATH 形态生成 dsh --profile <p> 主程序命令', async () => {
    const r = await detectDshConfig({ cwd: '' }, { hasBin: (n) => n === 'dsh', profile: 'test' })
    expect(r.found).toBe(true)
    expect(r.startupCommand).toBe('dsh --profile test --port {port} --no-open')
  })
  it('非 web profile：仓库形态尾段同步变形（pnpm / npm 两分支）', async () => {
    const repo = makeFakeRepo()
    const pnpm = await detectDshConfig(
      { cwd: '' },
      { homeDir: tmpdir(), candidates: [repo], hasBin: (n) => n === 'pnpm', profile: 'test' },
    )
    expect(pnpm.startupCommand).toBe('pnpm dsh --profile test --port {port}')
    const npm = await detectDshConfig(
      { cwd: '' },
      { homeDir: tmpdir(), candidates: [repo], hasBin: () => false, profile: 'test' },
    )
    expect(npm.startupCommand).toBe('npm run dsh -- --profile test --port {port}')
    rmSync(repo, { recursive: true, force: true })
  })
})
