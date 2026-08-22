import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// 无 package.json（走哈希回退路径）的基础表：tags 需含正式版 tag（仅预发布不触发任何更新判定）
const baseTable: Table = {
  '-C REPO rev-parse HEAD': { ok: true, out: 'abc1234' },
  '-C REPO ls-remote --tags origin': { ok: true, out: 'sha0000000\trefs/tags/dsh-v0.1.0' },
  '-C REPO ls-remote origin HEAD': { ok: true, out: 'def5678\tHEAD' },
}

// 有 package.json 的仓库：构造 temp repo 写入 package.json
function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-repo-'))
  mkdirSync(join(repo, '.git'))
  return repo
}

function writeVersion(repo: string, version: string): void {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'dsh', version }), 'utf8')
}

const tagsTable = (versions: string[]): Table => ({
  '-C REPO ls-remote --tags origin': {
    ok: true,
    out: versions.map((v, i) => `sha${String(i).padStart(7, '0')}\trefs/tags/dsh-v${v}`).join('\n'),
  },
})

describe('checkDshUpdates（按正式版本 tag 比较）', () => {
  it('目录无 .git 时返回 error', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-updater-plain-'))
    const r = await checkDshUpdates(plain, fakeExec(baseTable))
    expect(r.state).toBe('error')
    expect(r.message).toContain('未找到 DSH 仓库')
    rmSync(plain, { recursive: true, force: true })
  })

  it('无 package.json 时回退哈希比较：GitHub 有新提交 → behind', async () => {
    const repo = tempRepo()
    const r = await checkDshUpdates(repo, fakeExec(baseTable))
    expect(r.state).toBe('behind')
    expect(r.message).toContain('abc1234')
    expect(r.message).toContain('def5678')
    expect(r.pullCommand).toContain('git pull')
    rmSync(repo, { recursive: true, force: true })
  })

  it('本地已是最高正式版 tag 版本（版本相同）→ up-to-date（不误报）', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.1.0')
    // 远端最新正式版 tag 也是 0.1.0（远端 HEAD 有更新提交但无新 tag）→ 不应提示更新
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'da590c7' },
        ...tagsTable(['0.1.0']),
      }),
    )
    expect(r.state).toBe('up-to-date')
    expect(r.message).toContain('已是最新')
    rmSync(repo, { recursive: true, force: true })
  })

  it('远端有更高正式版 tag → behind 且消息含版本号', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.1.0-rc.7')
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'da590c7' },
        ...tagsTable(['0.1.0-rc.8', '0.1.0']),
      }),
    )
    expect(r.state).toBe('behind')
    expect(r.message).toContain('0.1.0')
    expect(r.message).toContain('0.1.0-rc.7')
    rmSync(repo, { recursive: true, force: true })
  })

  it('核心版本多位数比较不受字符串序影响（0.10.0 > 0.9.9）', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.9.9')
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'da590c7' },
        ...tagsTable(['0.10.0']),
      }),
    )
    expect(r.state).toBe('behind')
    expect(r.message).toContain('0.10.0')
    rmSync(repo, { recursive: true, force: true })
  })

  it('远端仅有更新的预发布（rc）tag 时返回 behind + prerelease（提示风险）', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.1.0-rc.7')
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'da590c7' },
        ...tagsTable(['0.1.0-rc.8', '0.1.0-rc.9']),
      }),
    )
    expect(r.state).toBe('behind')
    expect(r.prerelease).toBe(true)
    expect(r.message).toContain('预览版')
    rmSync(repo, { recursive: true, force: true })
  })

  it('远端预发布不新于本地时不推送（本地已是较新 rc）', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.1.0-rc.9')
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'da590c7' },
        ...tagsTable(['0.1.0-rc.8']),
      }),
    )
    expect(r.state).toBe('up-to-date')
    expect(r.message).toContain('正式版')
    rmSync(repo, { recursive: true, force: true })
  })

  it('本地已是正式版时远端 rc 不推送', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.1.0')
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'da590c7' },
        ...tagsTable(['0.1.0-rc.9']),
      }),
    )
    expect(r.state).toBe('up-to-date')
    expect(r.message).toContain('正式版')
    rmSync(repo, { recursive: true, force: true })
  })

  it('官方 tags 失败时镜像 tags 返回 behind（镜像也只看正式版）', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.1.0-rc.6')
    const mirror = 'https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git'
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'abc1234' },
        '-C REPO ls-remote --tags origin': { ok: false, err: 'Could not resolve host' },
        [`-C REPO ls-remote --tags ${mirror}`]: { ok: true, out: 'sha0000000\trefs/tags/dsh-v0.1.0' },
      }),
      { mirrorUrl: mirror },
    )
    expect(r.state).toBe('behind')
    expect(r.message).toContain('0.1.0')
    rmSync(repo, { recursive: true, force: true })
  })

  it('官方与镜像 tags 均失败时返回 error 且提示镜像也失败', async () => {
    const repo = tempRepo()
    writeVersion(repo, '0.1.0-rc.7')
    const mirror = 'https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git'
    const r = await checkDshUpdates(
      repo,
      fakeExec({
        '-C REPO rev-parse HEAD': { ok: true, out: 'abc1234' },
        '-C REPO ls-remote --tags origin': { ok: false, err: 'blocked' },
        [`-C REPO ls-remote --tags ${mirror}`]: { ok: false, err: 'mirror down' },
      }),
      { mirrorUrl: mirror },
    )
    expect(r.state).toBe('error')
    expect(r.message).toContain('镜像源也失败')
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getLocalDshVersion', () => {
  it('优先读根 package.json 的 version（正式版本号）', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-ver-'))
    writeFileSync(join(repo, 'package.json'), '{"name":"@deepseek-ai/dsh-root","version":"0.1.0-rc.7"}', 'utf8')
    const v = await getLocalDshVersion(repo)
    expect(v).toBe('0.1.0-rc.7')
    rmSync(repo, { recursive: true, force: true })
  })

  it('package.json version 为空时回退 HEAD 短哈希', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-updater-ver2-'))
    writeFileSync(join(repo, 'package.json'), '{"version":""}', 'utf8')
    const v = await getLocalDshVersion(repo, fakeExec({ [`-C ${repo} rev-parse HEAD`]: { ok: true, out: 'abc1234' } }))
    expect(v).toBe('abc1234')
    rmSync(repo, { recursive: true, force: true })
  })

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

  it('官方 pull 失败时自动用镜像 pull 成功', async () => {
    const mirror = 'https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git'
    const r = await pullDshUpdates(
      'D:\\fake\\dsh',
      fakeExec({
        '-C D:\\fake\\dsh pull --ff-only --quiet': { ok: false, err: 'Could not resolve host' },
        [`-C D:\\fake\\dsh pull --ff-only --quiet ${mirror}`]: { ok: true, out: '' },
      }),
      { mirrorUrl: mirror },
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('已更新')
  })

  it('分叉时（本地有未推送提交）返回友好提示', async () => {
    const r = await pullDshUpdates(
      'D:\\fake\\dsh',
      fakeExec({
        '-C D:\\fake\\dsh pull --ff-only --quiet': { ok: false, err: 'Not possible to fast-forward' },
        '-C D:\\fake\\dsh rev-parse --abbrev-ref HEAD': { ok: true, out: 'master' },
        '-C D:\\fake\\dsh rev-parse --abbrev-ref master@{upstream}': { ok: true, out: 'origin/master' },
        '-C D:\\fake\\dsh rev-list --count origin/master..HEAD': { ok: true, out: '7' },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('7 个未推送')
  })
})

