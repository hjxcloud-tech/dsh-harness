import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    JSON.stringify({ name: 'deepseek-harness', scripts: { dsh: 'node --import tsx/esm apps/cli/src/bin.ts' } }),
  )
  return dir
}

describe('isDshRepo', () => {
  it('pnpm-workspace.yaml 存在即识别为 DSH 仓库', () => {
    const dir = makeFakeRepo()
    expect(isDshRepo(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
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
})
