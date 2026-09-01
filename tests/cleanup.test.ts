import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backupDshData,
  CLEANUP_KEEP_ITEMS,
  CLEANUP_MANIFEST,
  CLEANUP_WIPE_DIRS,
  defaultCleanupBackupDir,
  formatBytes,
  readCleanupManifest,
  restoreDshData,
  uninstallGlobalCli,
  wipeDshRuntime,
} from '../src/cleanup'
import { execKey } from '../src/win-exec'

type Result = { ok?: boolean; out?: string; err?: string }
type Table = Record<string, Result>

/** win32 下应经 cmd.exe 包装执行的 npm 系命令（防 execFile ENOENT 回归）。 */
const WRAPPED = new Set(['npm', 'npx', 'pnpm', 'dsh', 'dsh-fix', 'dsh-doctor'])

function fakeExec(table: Table) {
  return ((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
    const key = execKey(_cmd, args)
    const r = table[key] ?? { ok: true, out: '' }
    const first = key.split(' ')[0]
    if (
      process.platform === 'win32' &&
      WRAPPED.has(first) &&
      (_cmd !== 'cmd.exe' || args[0] !== '/d' || args[1] !== '/s' || args[2] !== '/c')
    ) {
      cb(new Error(`expected cmd.exe wrapper for ${first}`), '', '')
      return
    }
    cb(r.ok === false ? new Error(r.err ?? 'error') : null, r.out ?? '', r.err ?? '')
  }) as unknown as typeof import('node:child_process').execFile
}

describe('defaultCleanupBackupDir / formatBytes', () => {
  it('备份目录在 DSH home 旁（~/.dsh-backup-<时间戳>）', () => {
    const dir = defaultCleanupBackupDir('C:\\Users\\x\\.dsh')
    expect(dir).toMatch(/C:\\Users\\x\\.dsh-backup-\d{8}-\d{6}$/)
  })
  it('formatBytes 人类可读', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('backupDshData（备份聊天记录与用户资产 + manifest）', () => {
  const home = join(tmpdir(), `dsh-cleanup-backup-${Date.now()}`)
  const backupDir = join(tmpdir(), `dsh-cleanup-bak-${Date.now()}`)
  beforeAll(() => {
    mkdirSync(join(home, 'sessions', 'ws'), { recursive: true })
    mkdirSync(join(home, 'attachments'), { recursive: true })
    mkdirSync(join(home, 'skills', 'web-search'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'ws', 'a.jsonl'), '{"role":"user"}')
    writeFileSync(join(home, 'sessions', 'b.jsonl'), '{"role":"assistant"}')
    writeFileSync(join(home, 'attachments', 'img.png'), 'png')
    writeFileSync(join(home, 'skills', 'web-search', 'SKILL.md'), '# skill')
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\n')
    writeFileSync(join(home, 'settings.yaml'), 'locale: zh\n')
  })
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(backupDir, { recursive: true, force: true })
  })

  it('复制保留条目并写 manifest（文件数/字节数正确）', async () => {
    const r = await backupDshData(home, backupDir)
    expect(r.totalFiles).toBe(6)
    expect(existsSync(join(backupDir, 'sessions', 'ws', 'a.jsonl'))).toBe(true)
    expect(existsSync(join(backupDir, '.credentials.yaml'))).toBe(true)
    const manifest = readCleanupManifest(backupDir)
    expect(manifest?.totalFiles).toBe(6)
    expect(manifest?.items.map((i) => i.name).sort()).toEqual([...CLEANUP_KEEP_ITEMS].sort())
    expect(existsSync(join(backupDir, CLEANUP_MANIFEST))).toBe(true)
  })

  it('幂等：备份到已存在目录不抛错（覆盖/合并）', async () => {
    await expect(backupDshData(home, backupDir)).resolves.toBeTruthy()
  })
})

describe('wipeDshRuntime（白名单删除，保留聊天/资产）', () => {
  const home = join(tmpdir(), `dsh-cleanup-wipe-${Date.now()}`)
  beforeAll(() => {
    for (const name of CLEANUP_WIPE_DIRS) mkdirSync(join(home, name), { recursive: true })
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'keep.jsonl'), 'x')
    writeFileSync(join(home, '.credentials.yaml'), 'secret')
  })
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('删除全部白名单目录，保留 sessions/凭据', async () => {
    const removed = await wipeDshRuntime(home)
    expect(removed.sort()).toEqual([...CLEANUP_WIPE_DIRS].sort())
    for (const name of CLEANUP_WIPE_DIRS) expect(existsSync(join(home, name))).toBe(false)
    expect(existsSync(join(home, 'sessions', 'keep.jsonl'))).toBe(true)
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(true)
  })

  it('空/不存在 home 不抛错', async () => {
    await expect(wipeDshRuntime(join(tmpdir(), 'no-such-dsh-home-xyz'))).resolves.toEqual([])
  })
})

describe('restoreDshData（双保险收尾：缺失才补齐）', () => {
  const home = join(tmpdir(), `dsh-cleanup-restore-${Date.now()}`)
  const backupDir = join(tmpdir(), `dsh-cleanup-rbak-${Date.now()}`)
  beforeAll(async () => {
    mkdirSync(join(backupDir, 'sessions'), { recursive: true })
    writeFileSync(join(backupDir, 'sessions', 'a.jsonl'), 'x')
    writeFileSync(join(backupDir, '.credentials.yaml'), 'secret')
    // home 里 sessions 已存在（新 DSH 生成），凭据缺失
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'new.jsonl'), 'y')
    await restoreDshData(backupDir, home)
  })
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(backupDir, { recursive: true, force: true })
  })

  it('已存在的保留现状（sessions 不覆盖），缺失的补齐（凭据）', () => {
    expect(existsSync(join(home, 'sessions', 'a.jsonl'))).toBe(false) // 不合并备份旧文件
    expect(existsSync(join(home, 'sessions', 'new.jsonl'))).toBe(true) // 新 DSH 数据保留
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(true)
  })
})

describe('uninstallGlobalCli', () => {
  const key = 'uninstall -g @deepseek-ai/dsh --no-fund --no-audit'
  it('dsh 未安装 → 跳过', async () => {
    const r = await uninstallGlobalCli(fakeExec({}) as never, () => false)
    expect(r).toContain('跳过')
  })
  it('卸载成功 → 已卸载', async () => {
    const r = await uninstallGlobalCli(fakeExec({ [key]: { ok: true, out: '' } }) as never, () => true)
    expect(r).toContain('已卸载')
  })
  it('卸载失败 → 提示（非阻断）', async () => {
    const r = await uninstallGlobalCli(fakeExec({ [key]: { ok: false, err: 'EACCES' } }) as never, () => true)
    expect(r).toContain('EACCES')
  })
})
