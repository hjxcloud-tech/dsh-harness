import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  buildSessionRepairDriverSource,
  dshPackageDirCandidates,
  findSessionFiles,
  probeZstdNode,
  resolveSessionRepairRuntime,
  runSessionRepairDriver,
  SESSION_FILE_V0,
  SESSION_FILE_V3,
  type SessionRepairRuntime,
} from '../src/session-repair'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-repair-test-'))
}

/**
 * Node 的 zstdDecompressSync 只解**第一帧**（实测：两帧拼在一起只返回首帧内容），
 * 而驱动按"首帧恰好一行 header"写双帧，所以读回结果必须自己切帧。
 */
function decodeFrames(buf: Buffer): string {
  const MAGIC = 0xfd2fb528
  let text = ''
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4 || buf.readUInt32LE(off) !== MAGIC) throw new Error('bad zstd magic at ' + off)
    off += 4
    const descriptor = buf[off]
    off += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const didFlag = descriptor & 3
    if (singleSegment === 0) off += 1
    off += [0, 1, 2, 4][didFlag]
    if (fcsFlag === 0) {
      if (singleSegment === 1) off += 1
    } else {
      off += [2, 4, 8][fcsFlag - 1]
    }
    for (;;) {
      const bh = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
      const last = bh & 1
      const type = (bh >> 1) & 3
      const size = bh >>> 3
      off += 3
      off += type === 1 ? 1 : size
      if (off > buf.length) throw new Error('truncated block payload at ' + off)
      if (last === 1) break
    }
    if (checksum === 1) off += 4
    text += zstdDecompressSync(buf.subarray(start, off)).toString('utf8')
  }
  return text
}

/** 造一个 v3 会话文件（双帧，首帧仅 header）。 */
function writeV3(file: string, rows: unknown[]): void {
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  const lines = text.split('\n')
  const head = lines[0] + '\n'
  const rest = lines.slice(1).join('\n')
  writeFileSync(
    file,
    Buffer.concat([zstdCompressSync(Buffer.from(head, 'utf8')), zstdCompressSync(Buffer.from(rest, 'utf8'))]),
  )
}

/**
 * 驱动运行时：cwd 指到空目录，让 @deepseek-ai/dsh-session-format-catalog 解析失败
 * （catalog=null）。这样结果只由驱动自身的逻辑决定，不受本机 DSH 版本影响。
 */
function isolatedRuntime(): SessionRepairRuntime {
  return { nodePath: process.execPath, cwd: mkdtempSync(join(tmpdir(), 'dsh-repair-cwd-')), version: process.version }
}

describe('findSessionFiles（v2.4.0）', () => {
  it('递归只挑 session.jsonl.zstd', () => {
    const home = tempHome()
    try {
      const a = join(home, 'sessions', '--group--', 'session-1')
      const b = join(home, 'sessions', '--group--', 'session-2')
      mkdirSync(a, { recursive: true })
      mkdirSync(b, { recursive: true })
      writeFileSync(join(a, 'session.jsonl.zstd'), 'x')
      writeFileSync(join(a, 'session.jsonl.zstd.bak-1'), 'x')
      writeFileSync(join(b, 'session.jsonl.zstd'), 'y')
      writeFileSync(join(home, 'sessions', 'notes.txt'), 'z')
      const found = findSessionFiles(home).map((p) => p.replace(home, '<home>'))
      expect(found).toEqual([
        expect.stringContaining('session-1'),
        expect.stringContaining('session-2'),
      ])
      expect(found.every((p) => p.endsWith('session.jsonl.zstd'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('无 sessions 目录 → 空数组（不抛错）', () => {
    const home = tempHome()
    try {
      expect(findSessionFiles(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('驱动脚本（v2.4.0）', () => {
  const src = buildSessionRepairDriverSource()
  it('自带多帧切分与双帧写入（Node zstd 只解首帧，必须自己切帧）', () => {
    expect(src).toContain('function splitFrames')
    expect(src).toContain('function encodeTwoFrames')
    expect(src).toContain('zstdDecompressSync')
    expect(src).toContain('zstdCompressSync')
    // 首帧恰好一行 header：head = lines[0] + '\n'
    expect(src).toContain("const head = lines[0] + '\\n'")
  })
  it('三类漂移修复都在（seqs 展平 / 非法 form → notice / descriptor 版本 3）', () => {
    expect(src).toContain('function fixSourceEventSeqs')
    expect(src).toContain("form: 'notice'")
    expect(src).toContain('function fixDescriptorVersion')
    expect(src).toContain('d.version = 3')
    expect(src).toContain("'instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'")
  })
  it('第四类漂移：user/message 缺 data.id/data.role → 补齐，且范围只限 user/message', () => {
    expect(src).toContain('function fixMessageIdentity')
    // 范围守卫（真机实测）：只有 user/message 的 data 天然带 id+role
    // （assistant/message 是 turn/step/message/usage；tool-call-chunks 的 id 是 chunk id）
    // 越界改其它类型会让 v0→v1 迁移链拒绝整个会话（verify-session-repair 踩过）
    expect(src).toContain("if (obj.type !== 'user/message') return 0")
    expect(src).toContain("d.id = 'legacy-message:' + sid + ':' + String(obj.seq)")
    expect(src).toContain("d.role = 'user'")
    expect(src).toContain('changed.identity += fixMessageIdentity(obj, sid)')
  })
  it('用 DSH 自带迁移链先验后写（catalog 不存在时降级为未校验，不阻断）', () => {
    expect(src).toContain("@deepseek-ai/dsh-session-format-catalog")
    expect(src).toContain('createRestore')
    expect(src).toContain('decodeRow')
    expect(src).toContain("catalog = null")
    expect(src).toContain("validated: false")
  })
  it('修复前先备份（backupDir 下逐文件 .bak），且只在复验通过时落盘', () => {
    expect(src).toContain('copyFileSync(path, join(backupDir')
    expect(src).toContain('repair-tmp-')
    expect(src).toContain('still invalid after fixes')
  })
})

describe('运行时探测（v2.4.0）', () => {
  it('probeZstdNode：返回版本号或 null（不抛错）', () => {
    const v = probeZstdNode(process.execPath)
    expect(v === null || /^v\d+\./.test(v)).toBe(true)
  })
  it('dshPackageDirCandidates：返回数组（去重）', () => {
    const dirs = dshPackageDirCandidates()
    expect(Array.isArray(dirs)).toBe(true)
    expect(new Set(dirs).size).toBe(dirs.length)
  })
  it('resolveSessionRepairRuntime：成功带 node/cwd，失败带可读原因', () => {
    const r = resolveSessionRepairRuntime()
    if (r.ok) {
      expect(r.runtime.nodePath.length).toBeGreaterThan(0)
      expect(r.runtime.cwd.length).toBeGreaterThan(0)
      expect(r.runtime.version.length).toBeGreaterThan(0)
    } else {
      expect(r.error.length).toBeGreaterThan(0)
    }
  })
})

describe('findSessionFiles：v3 优先（真机校准）', () => {
  it('同目录同时有 v3 与 v0 → 只取 v3（v0 是冻结的迁移源，修它对"打不开"无效）', () => {
    const home = tempHome()
    try {
      const a = join(home, 'sessions', '--g--', 'session-1')
      const b = join(home, 'sessions', '--g--', 'session-2')
      mkdirSync(a, { recursive: true })
      mkdirSync(b, { recursive: true })
      writeFileSync(join(a, SESSION_FILE_V0), 'frozen')
      writeFileSync(join(a, SESSION_FILE_V3), 'live')
      writeFileSync(join(b, SESSION_FILE_V0), 'only-legacy')
      const found = findSessionFiles(home)
      expect(found).toHaveLength(2)
      // 有 v3 的目录只贡献 v3 那一条
      expect(found.filter((p) => p.endsWith(SESSION_FILE_V3)).map((p) => p.includes('session-1'))).toEqual([true])
      // 没有 v3 的目录仍退回 v0
      expect(found.some((p) => p.includes('session-2') && p.endsWith(SESSION_FILE_V0))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('备份文件（.bak-*）不算会话文件', () => {
    const home = tempHome()
    try {
      const a = join(home, 'sessions', '--g--', 'session-1')
      mkdirSync(a, { recursive: true })
      writeFileSync(join(a, SESSION_FILE_V0 + '.bak-20260910'), 'x')
      writeFileSync(join(a, SESSION_FILE_V3 + '.bak-20260910'), 'y')
      expect(findSessionFiles(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

interface Row {
  type?: string
  seq?: number
  data?: { id?: string; role?: string; content?: Array<{ type: string; text: string }> }
}

describe('驱动脚本：行为级（真跑子进程，不是字符串断言）', () => {
  const pluginSource = { kind: 'plugin', plugin: 'demo', form: 'notice', summary: 's' }

  it('缺 id/role 的 user/message：预检发现 → 修复 → 可读 → 幂等，且不破坏内容', async () => {
    const home = tempHome()
    try {
      const dir = join(home, 'sessions', '--g--', 'session-broken')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, SESSION_FILE_V3)
      writeV3(file, [
        { type: 'session', version: 3, id: 'session-broken', createdAt: 0, cwd: 'C:\\x' },
        // 桥接注入的形态：只有 source + content，没有 id / role
        { seq: 0, type: 'user/message', data: { source: pluginSource, content: [{ type: 'text', text: 'hi' }] } },
        // 正常事件：自带 id/role，不应被改写
        { seq: 1, type: 'user/message', data: { id: 'keep-me', role: 'user', source: pluginSource, content: [{ type: 'text', text: 'ok' }] } },
      ])
      const rt = isolatedRuntime()
      const root = join(home, 'sessions')

      // ① 预检必须判 broken —— catalog 的迁移链查不出这一类，全靠本地补检
      const c1 = await runSessionRepairDriver(rt, { mode: 'check', sessionsRoot: root, files: [file] })
      if (!c1.ok) throw new Error(c1.error)
      expect(c1.summary.broken).toBe(1)
      expect(c1.summary.items[0]?.reason ?? '').toContain('lacks an identified message')

      // ② 修复：identity 应为 2（id + role 各一处）
      const r1 = await runSessionRepairDriver(rt, { mode: 'repair', sessionsRoot: root, backupDir: join(home, 'backup'), files: [file] })
      if (!r1.ok) throw new Error(r1.error)
      expect(r1.summary.fixed).toBe(1)
      expect(r1.summary.items[0]?.fixes).toEqual({ seqs: 0, form: 0, descriptor: 0, identity: 2 })

      // ③ 修完可读，且事件一条不少、原有 id 不被覆盖
      const c2 = await runSessionRepairDriver(rt, { mode: 'check', sessionsRoot: root, files: [file] })
      if (!c2.ok) throw new Error(c2.error)
      expect(c2.summary.ok).toBe(1)

      const rows = decodeFrames(readFileSync(file))
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Row)
      expect(rows).toHaveLength(3)
      expect(rows[1]?.data?.id).toBe('legacy-message:session-broken:0')
      expect(rows[1]?.data?.role).toBe('user')
      expect(rows[1]?.data?.content?.[0]?.text).toBe('hi')
      expect(rows[2]?.data?.id).toBe('keep-me')

      // ④ 幂等：再修一次不应有任何改动
      const r2 = await runSessionRepairDriver(rt, { mode: 'repair', sessionsRoot: root, files: [file] })
      if (!r2.ok) throw new Error(r2.error)
      expect(r2.summary.fixed).toBe(0)
      expect(r2.summary.items[0]?.status).toBe('ok')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('v0 会话不因缺 id 被误判（v0 的 data 本就没有 id/role，靠迁移链补）', async () => {
    const home = tempHome()
    try {
      const dir = join(home, 'sessions', '--g--', 'session-legacy')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, SESSION_FILE_V3)
      writeV3(file, [
        { type: 'session', version: 2, id: 'session-legacy', createdAt: 0, cwd: 'C:\\x' },
        { seq: 0, type: 'user/message', data: { source: pluginSource, content: [{ type: 'text', text: 'hi' }] } },
      ])
      const rt = isolatedRuntime()
      const c = await runSessionRepairDriver(rt, { mode: 'check', sessionsRoot: join(home, 'sessions'), files: [file] })
      if (!c.ok) throw new Error(c.error)
      expect(c.summary.broken).toBe(0)
      expect(c.summary.ok).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
