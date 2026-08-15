import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDshUpdates, type ExecFileFn } from '../src/updater'

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
  '-C REPO fetch origin --quiet': { ok: true, out: '' },
  '-C REPO rev-parse --short HEAD': { ok: true, out: 'abc1234' },
  '-C REPO symbolic-ref refs/remotes/origin/HEAD --short': { ok: true, out: 'origin/main' },
  '-C REPO rev-parse --short origin/main': { ok: true, out: 'def5678' },
  '-C REPO rev-list --count HEAD..origin/main': { ok: true, out: '5' },
}

describe('checkDshUpdates', () => {
  it('目录无 .git 时返回 error', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-updater-plain-'))
    const r = await checkDshUpdates(plain, fakeExec(baseTable))
    expect(r.state).toBe('error')
    expect(r.message).toContain('未找到 DSH 仓库')
    rmSync(plain, { recursive: true, force: true })
  })

  it('git fetch 失败时返回 error 并含原因', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo-'))
    // 伪造 .git 目录使前置校验通过
    mkdirSync(join(repo, '.git'))
    const r = await checkDshUpdates(
      repo,
      fakeExec({ ...baseTable, '-C REPO fetch origin --quiet': { ok: false, err: 'Could not resolve host' } }),
    )
    expect(r.state).toBe('error')
    expect(r.message).toContain('git fetch')
    expect(r.message).toContain('Could not resolve host')
    rmSync(repo, { recursive: true, force: true })
  })

  it('远端领先时返回 behind 与更新命令', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo2-'))
    mkdirSync(join(repo, '.git'))
    const r = await checkDshUpdates(repo, fakeExec(baseTable))
    expect(r.state).toBe('behind')
    expect(r.message).toContain('领先 5 个提交')
    expect(r.pullCommand).toContain('git pull')
    rmSync(repo, { recursive: true, force: true })
  })

  it('无差异时返回 up-to-date', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo3-'))
    mkdirSync(join(repo, '.git'))
    const r = await checkDshUpdates(
      repo,
      fakeExec({ ...baseTable, '-C REPO rev-list --count HEAD..origin/main': { ok: true, out: '0' } }),
    )
    expect(r.state).toBe('up-to-date')
    expect(r.message).toContain('已是最新')
    rmSync(repo, { recursive: true, force: true })
  })

  it('无 origin/HEAD 时回退 origin/main', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo4-'))
    mkdirSync(join(repo, '.git'))
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        ...baseTable,
        '-C REPO symbolic-ref refs/remotes/origin/HEAD --short': { ok: false, err: 'no such ref' },
      }),
    )
    expect(r.state).toBe('behind')
    expect(r.message).toContain('领先 5 个提交')
    rmSync(repo, { recursive: true, force: true })
  })
})
