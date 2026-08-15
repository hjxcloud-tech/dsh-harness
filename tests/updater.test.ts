import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDshUpdates, getLocalDshVersion, pullDshUpdates, type ExecFileFn } from '../src/updater'

type Result = { ok?: boolean; out?: string; err?: string }
type Table = Record<string, Result>

function fakeExec(table: Table): ExecFileFn {
  return ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
    const key = args.map((a) => (a.includes('dsh-updater-repo') ? 'REPO' : a)).join(' ')
    const r = table[key] ?? { ok: true, out: '' }
    cb(r.ok === false ? new Error(r.err ?? 'git error') : null, r.out ?? '', r.err ?? '')
  }) as unknown as ExecFileFn
}

const baseTable: Table = {
  '-C REPO rev-parse HEAD': { ok: true, out: 'abc1234' },
  '-C REPO ls-remote origin HEAD': { ok: true, out: 'def5678\tHEAD' },
}

describe('checkDshUpdates', () => {
  it('目录无 .git 时返回 error', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-updater-plain-'))
    const r = await checkDshUpdates(plain, fakeExec(baseTable))
    expect(r.state).toBe('error')
    expect(r.message).toContain('未找到 DSH 仓库')
    rmSync(plain, { recursive: true, force: true })
  })

  it('无法连接 GitHub 时返回 error 并含原因', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo-'))
    // 伪造 .git 目录使前置校验通过
    mkdirSync(join(repo, '.git'))
    const r = await checkDshUpdates(
      repo,
      fakeExec({ ...baseTable, '-C REPO ls-remote origin HEAD': { ok: false, err: 'Could not resolve host' } }),
    )
    expect(r.state).toBe('error')
    expect(r.message).toContain('无法连接 GitHub')
    expect(r.message).toContain('Could not resolve host')
    rmSync(repo, { recursive: true, force: true })
  })

  it('GitHub 有新版本时返回 behind', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo2-'))
    mkdirSync(join(repo, '.git'))
    const r = await checkDshUpdates(repo, fakeExec(baseTable))
    expect(r.state).toBe('behind')
    expect(r.message).toContain('GitHub 上有新版本')
    expect(r.message).toContain('abc1234')
    expect(r.message).toContain('def5678')
    expect(r.pullCommand).toContain('git pull')
    rmSync(repo, { recursive: true, force: true })
  })

  it('与 GitHub 一致时返回 up-to-date', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo3-'))
    mkdirSync(join(repo, '.git'))
    const r = await checkDshUpdates(
      repo,
      fakeExec({ ...baseTable, '-C REPO ls-remote origin HEAD': { ok: true, out: 'abc1234\tHEAD' } }),
    )
    expect(r.state).toBe('up-to-date')
    expect(r.message).toContain('已是最新')
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getLocalDshVersion', () => {
  it('返回 HEAD 短哈希', async () => {
    const v = await getLocalDshVersion('D:\\fake\\dsh', fakeExec({ '-C D:\\fake\\dsh rev-parse HEAD': { ok: true, out: 'abc1234' } }))
    expect(v).toBe('abc1234')
  })

  it('读取失败返回 未知', async () => {
    const v = await getLocalDshVersion('D:\\fake\\dsh', fakeExec({ '-C D:\\fake\\dsh rev-parse HEAD': { ok: false, err: 'not a repo' } }))
    expect(v).toBe('未知')
  })
})

describe('pullDshUpdates', () => {
  it('pull 成功返回 ok 与生效提示', async () => {
    const r = await pullDshUpdates(
      'D:\\fake\\dsh',
      fakeExec({ '-C D:\\fake\\dsh pull --ff-only --quiet': { ok: true, out: '' } }),
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('已更新')
  })

  it('pull 失败返回原因', async () => {
    const r = await pullDshUpdates(
      'D:\\fake\\dsh',
      fakeExec({ '-C D:\\fake\\dsh pull --ff-only --quiet': { ok: false, err: 'local changes' } }),
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('local changes')
  })
})

