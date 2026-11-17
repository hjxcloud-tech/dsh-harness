import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backupBeforeUpgrade,
  backupDshData,
  backupTimestamp,
  CLEANUP_KEEP_ITEMS,
  CLEANUP_MANIFEST,
  CLEANUP_WIPE_DIRS,
  countSessionLogs,
  defaultCleanupBackupDir,
  formatBytes,
  pruneOldBackups,
  readCleanupManifest,
  restoreDshData,
  uninstallGlobalCli,
  wipeDshRuntime,
} from '../src/cleanup'
import { execKey } from '../src/win-exec'
import { tempDir } from './temp-track'

type Result = { ok?: boolean; out?: string; err?: string }
type Table = Record<string, Result>

/** win32 下应经 cmd.exe 包装执行的 npm 系命令（防 execFile ENOENT 回归）。 */
const WRAPPED = new Set(['npm', 'npx', 'pnpm', 'dsh', 'dsh-fix', 'dsh-doctor'])

/** 建 junction 在 Windows 上免提权；POSIX 用真实目录链接。 */
function makeDirLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

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

describe('backupDshData（全量备份：聊天记录 + 插件 + 技能 + 配置 + manifest）', () => {
  const root = tempDir('dsh-cleanup-backup-')
  const home = join(root, '.dsh')
  const backupDir = join(root, '.dsh-backup-test-full')
  beforeAll(() => {
    mkdirSync(join(home, 'sessions', 'ws'), { recursive: true })
    mkdirSync(join(home, 'attachments'), { recursive: true })
    mkdirSync(join(home, 'skills', 'web-search'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'ws', 'a.jsonl'), '{"role":"user"}')
    writeFileSync(join(home, 'sessions', 'b.jsonl'), '{"role":"assistant"}')
    writeFileSync(join(home, 'attachments', 'img.png'), 'png')
    writeFileSync(join(home, 'skills', 'web-search', 'SKILL.md'), '# skill')
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(home, 'storages', 'ssh_ops_settings.json'), '{}\n')
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\n')
    writeFileSync(join(home, 'settings.yaml'), 'locale: zh\n')
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('复制全部保留条目并写 manifest（含插件运行物 profiles/storages）', async () => {
    const r = await backupDshData(home, backupDir)
    expect(r.totalFiles).toBe(8)
    expect(existsSync(join(backupDir, 'sessions', 'ws', 'a.jsonl'))).toBe(true)
    expect(existsSync(join(backupDir, 'profiles', 'web', 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(backupDir, 'storages', 'ssh_ops_settings.json'))).toBe(true)
    expect(existsSync(join(backupDir, '.credentials.yaml'))).toBe(true)
    const manifest = readCleanupManifest(backupDir)
    expect(manifest?.tool).toBe('dsh-harness')
    expect(manifest?.kind).toBe('full')
    expect(manifest?.totalFiles).toBe(8)
    // 只备份存在的条目：profiles/plugins/storages 里只有前两者在夹具中存在
    const expected = ['sessions', 'attachments', 'skills', 'profiles', 'storages', '.credentials.yaml', 'settings.yaml']
    expect(manifest?.items.map((i) => i.name).sort()).toEqual(expected.sort())
    expect([...CLEANUP_KEEP_ITEMS].slice(0, 3)).toEqual(['sessions', 'attachments', 'skills'])
    expect(existsSync(join(backupDir, CLEANUP_MANIFEST))).toBe(true)
  })

  it('幂等：备份到已存在目录不抛错（覆盖/合并）', async () => {
    await expect(backupDshData(home, backupDir)).resolves.toBeTruthy()
  })

  it('符号链接（Windows junction）不阻断备份，且记入 manifest.links 并在恢复时重建', async () => {
    const root2 = tempDir('dsh-cleanup-link-')
    const homeA = join(root2, '.dsh')
    const devSource = join(root2, 'dsh-word-revision')
    mkdirSync(join(homeA, 'profiles', 'web'), { recursive: true })
    mkdirSync(devSource, { recursive: true })
    writeFileSync(join(devSource, 'main.js'), 'x')
    // fs.cp 在 Windows 上复制 junction 会 EPERM（本机实测）——备份必须自己处理链接
    makeDirLink(devSource, join(homeA, 'profiles', 'web', 'dsh-word-revision'))
    const bak = join(root2, '.dsh-backup-link')
    const r = await backupDshData(homeA, bak)
    expect(r.links).toBe(1)
    const manifest = readCleanupManifest(bak)
    expect(manifest?.links?.[0]?.rel).toBe('profiles/web/dsh-word-revision')
    expect(manifest?.links?.[0]?.type).toBe('dir')
    // 恢复：链接按原 target 重建（不是把目标内容复制过来）
    const homeB = join(root2, '.dsh-restored')
    const restored = await restoreDshData(bak, homeB)
    expect(restored.linksRestored).toBe(1)
    expect(lstatSync(join(homeB, 'profiles', 'web', 'dsh-word-revision')).isSymbolicLink()).toBe(true)
    rmSync(root2, { recursive: true, force: true })
  })
})

describe('备份轮换（只保留最新一份）', () => {
  it('备份成功后清理更早的自家备份；无关目录与本次备份保留', async () => {
    const root = tempDir('dsh-cleanup-rotate-')
    const home = join(root, '.dsh')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(join(home, 'sessions', 's.jsonl.zstd'), 'x')
    // ① 旧版"升级前备份"形态（只有 sessions-<时间戳> 子目录）
    const legacySessions = join(root, '.dsh-backup-20260101-010101')
    mkdirSync(join(legacySessions, 'sessions-20260101-010101'), { recursive: true })
    // ② 旧版全量备份形态（根目录有 manifest.json，含 dshHome）
    const legacyFull = join(root, '.dsh-backup-20260102-020202')
    mkdirSync(legacyFull, { recursive: true })
    writeFileSync(
      join(legacyFull, CLEANUP_MANIFEST),
      JSON.stringify({ timestamp: '2026-01-02T00:00:00.000Z', dshHome: home, items: [], totalFiles: 0, totalBytes: 0 }),
    )
    // ③ 形似但不是备份的目录（无 manifest、非 sessions 形态）→ 不得删
    const foreign = join(root, '.dsh-backup-20260103-030303')
    mkdirSync(join(foreign, 'someone-elses-data'), { recursive: true })
    // ④ 名字不含时间戳的目录 → 不匹配轮换规则
    const notBackup = join(root, '.dsh-backup-notadate')
    mkdirSync(notBackup, { recursive: true })
    const newest = join(root, '.dsh-backup-20260104-040404')
    const r = await backupDshData(home, newest)
    expect(r.pruned.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['.dsh-backup-20260101-010101', '.dsh-backup-20260102-020202'])
    expect(existsSync(legacySessions)).toBe(false)
    expect(existsSync(legacyFull)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(notBackup)).toBe(true)
    expect(existsSync(newest)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('pruneOldBackups：DSH home 不存在/父目录不可读时不抛错', async () => {
    await expect(pruneOldBackups(join(tmpdir(), 'no-such-home-xyz'), join(tmpdir(), 'keep'))).resolves.toEqual([])
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

describe('restoreDshData（分策略恢复）', () => {
  const root = tempDir('dsh-cleanup-restore-')
  const home = join(root, '.dsh')
  const backupDir = join(root, '.dsh-backup-rbak')
  beforeAll(() => {
    // 备份内容
    mkdirSync(join(backupDir, 'sessions'), { recursive: true })
    writeFileSync(join(backupDir, 'sessions', 'a.jsonl'), 'x')
    mkdirSync(join(backupDir, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(backupDir, 'profiles', 'web', 'cordis.patch.yml'), 'backup\n')
    mkdirSync(join(backupDir, 'skills', 'web-search'), { recursive: true })
    writeFileSync(join(backupDir, 'skills', 'web-search', 'SKILL.md'), '# skill')
    writeFileSync(join(backupDir, '.credentials.yaml'), 'secret')
    // 目标：sessions 已有新数据；profiles 是新 DSH 建的空骨架；凭据缺失
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'new.jsonl'), 'y')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sessions 合并（补缺失、不覆盖新会话）；profiles/skills 用备份覆盖；凭据缺失才补', async () => {
    const r = await restoreDshData(backupDir, home)
    // 合并：旧会话补回，新会话保留
    expect(existsSync(join(home, 'sessions', 'a.jsonl'))).toBe(true)
    expect(existsSync(join(home, 'sessions', 'new.jsonl'))).toBe(true)
    // 插件链路：备份侧覆盖
    expect(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toBe('backup\n')
    expect(existsSync(join(home, 'skills', 'web-search', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(true)
    expect(r.restored.map((i) => i.name)).toContain('profiles')
    expect(r.restored.find((i) => i.name === 'profiles')?.overwritten).toBe(true)
    expect(r.restored.find((i) => i.name === 'sessions')?.overwritten).toBe(false)
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

describe('升级前全量备份与计数（v2.9.8）', () => {
  it('countSessionLogs：递归统计 session.jsonl.zstd，忽略无关文件', () => {
    const home = tempDir('dsh-sess-count-')
    try {
      mkdirSync(join(home, 'sessions', 'a', 'b'), { recursive: true })
      writeFileSync(join(home, 'sessions', 'a', 'b', 'session.jsonl.zstd'), 'x')
      writeFileSync(join(home, 'sessions', 'a', 'other.txt'), 'x')
      expect(countSessionLogs(home)).toBe(1)
      expect(countSessionLogs(join(home, 'missing'))).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('backupBeforeUpgrade：无数据 → null；有则全量备份到 <root> 并统计（kind=pre-upgrade）', async () => {
    const root = tempDir('dsh-sess-backup-')
    try {
      expect(await backupBeforeUpgrade(join(root, 'no-home'))).toBeNull()
      const home = join(root, '.dsh')
      mkdirSync(join(home, 'sessions', 's1'), { recursive: true })
      mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
      writeFileSync(join(home, 'sessions', 's1', 'session.jsonl.zstd'), 'abcdef')
      writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
      const r = await backupBeforeUpgrade(home, { backupRoot: join(root, '.dsh-backup-up') })
      expect(r).not.toBeNull()
      if (r !== null) {
        expect(r.totalFiles).toBe(2)
        expect(r.totalBytes).toBe(9)
        expect(existsSync(join(r.backupDir, 'sessions', 's1', 'session.jsonl.zstd'))).toBe(true)
        expect(readCleanupManifest(r.backupDir)?.kind).toBe('pre-upgrade')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('backupTimestamp：yyyyMMdd-HHmmss', () => {
    expect(backupTimestamp(new Date(2026, 8, 10, 9, 8, 7))).toBe('20260910-090807')
  })
})
