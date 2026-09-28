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
  SESSION_FILE_V4,
  type SessionRepairRuntime,
} from '../src/session-repair'

/** 本文件创建的临时目录都要回收（历史上 dsh-repair-cwd-* 泄漏了 50 个空目录）。 */
const tempDirs: string[] = []
function trackedTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
function cleanupTemps(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

function tempHome(): string {
  return trackedTemp('dsh-repair-test-')
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

/** 按 rows 首行的 header（含 version）写双帧文件：首帧恰好一行 header，其余进第二帧。 */
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
  return { nodePath: process.execPath, cwd: trackedTemp('dsh-repair-cwd-'), version: process.version }
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
      cleanupTemps()
    }
  })
  it('无 sessions 目录 → 空数组（不抛错）', () => {
    const home = tempHome()
    try {
      expect(findSessionFiles(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanupTemps()
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
  // v2.7.0（0.1.7 适配 A1）：0.1.7 起静态 catalog 的 V3→V4 迁移边需要「parent 的 historical child
  // facts」，插件拿不到 ⇒ 若照旧校验，任何 v3 会话都会被判 broken 且永远修不动（rc.1 实测）。
  // 处置＝探测版本 + 只报告不改写；这里锁住三件事：能力探测、deferred 分支、以及**写前守卫的顺序**
  it('0.1.7+ 跨版本会话只报告不改写（deferred），且守卫排在落盘判断之前', () => {
    expect(src).toContain('catalog.currentVersion')
    expect(src).toContain('version < catalogVersion')
    expect(src).toContain('deferred: true')
    expect(src).toContain('historical child facts')
    // 底线：after.deferred 必须在 !after.ok 之前判，否则"无法校验"会被当成校验通过而落盘
    expect(src.indexOf('after.deferred')).toBeGreaterThan(-1)
    expect(src.indexOf('after.deferred')).toBeLessThan(src.indexOf('still invalid after fixes'))
    // 修复模式对 deferred 会话直接 continue：不得产生备份
    const guard = src.slice(src.indexOf('if (after.deferred)'), src.indexOf('if (!after.ok)'))
    expect(guard).toContain('continue')
    expect(guard).not.toContain('copyFileSync')
    // 汇总里 deferred 单独计数（UI 据此提示"由 DSH 打开时迁移"）
    expect(src).toContain('errors, deferred, validating')
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
      cleanupTemps()
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
      cleanupTemps()
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
      expect(r1.summary.items[0]?.fixes).toEqual({ seqs: 0, form: 0, descriptor: 0, identity: 2, kind: 0 })

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
      cleanupTemps()
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
      cleanupTemps()
    }
  })
})

/**
 * v2.8.6：0.1.7（会话格式 v4）下的两条硬修复——
 * ① 活文件名换成 session.v4.jsonl.zstd 后必须认它（否则当前会话全部不在视野）；
 * ② 入参不再塞进命令行（本机 203 个会话 = 37,897 字符 > Windows CreateProcess 32,767
 *    ⇒ spawn ENAMETOOLONG，功能整体跑不起来）。
 */
describe('v4 活文件枚举（v2.8.6）', () => {
  it('优先级 v4 > v3 > v0：只有 v4 的目录也要命中', () => {
    const home = tempHome()
    try {
      const onlyV4 = join(home, 'sessions', '--g--', 'session-a')
      const v4v3 = join(home, 'sessions', '--g--', 'session-b')
      const onlyV3 = join(home, 'sessions', '--g--', 'session-c')
      mkdirSync(onlyV4, { recursive: true })
      mkdirSync(v4v3, { recursive: true })
      mkdirSync(onlyV3, { recursive: true })
      writeFileSync(join(onlyV4, SESSION_FILE_V4), 'live-v4')
      writeFileSync(join(v4v3, SESSION_FILE_V4), 'live-v4')
      writeFileSync(join(v4v3, SESSION_FILE_V3), 'frozen-v3')
      writeFileSync(join(v4v3, SESSION_FILE_V0), 'frozen-v0')
      writeFileSync(join(onlyV3, SESSION_FILE_V3), 'live-v3')
      writeFileSync(join(onlyV3, SESSION_FILE_V0), 'frozen-v0')
      const found = findSessionFiles(home)
      expect(found).toHaveLength(3)
      // 每个目录只贡献一条，且带 v4 的目录必须取 v4
      expect(found.filter((p) => p.endsWith(SESSION_FILE_V4))).toHaveLength(2)
      expect(found.some((p) => p.includes('session-b') && p.endsWith(SESSION_FILE_V3))).toBe(false)
      expect(found.some((p) => p.includes('session-b') && p.endsWith(SESSION_FILE_V0))).toBe(false)
      expect(found.some((p) => p.includes('session-c') && p.endsWith(SESSION_FILE_V3))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanupTemps()
    }
  })
})

describe('驱动入参与 v4 漂移修复（v2.8.6）', () => {
  const src = buildSessionRepairDriverSource()

  it('入参改从文件读，命令行不再携带会话清单', () => {
    expect(src).toContain("JSON.parse(readFileSync(process.argv[1], 'utf8'))")
    expect(src).not.toContain('JSON.parse(process.argv[1])')
  })

  it('消息槽位遍历覆盖 inbox 注入与 title 请求（官方 mapEventMessages 同款形状）', () => {
    expect(src).toContain('function eachMessage')
    expect(src).toContain("'agent/inbox/spliced': 'inserted'")
    expect(src).toContain("'session/title-llm-request': 'messages'")
    expect(src).toContain('function fixPluginSourceKind')
    // producerKind 的映射表逐字复刻官方 v3-to-v4，表外退化为 plugin:<名>
    expect(src).toContain("const SAME_NAME_PRODUCERS = new Set(['agent-instructions'")
    expect(src).toContain("return 'plugin:' + plugin")
  })

  it('descriptor 只升已知旧值 2，未来值一律不动（防降级改坏）', () => {
    expect(src).toContain('if (d.version !== 2) return 0')
    expect(src).not.toContain('if (d.version === 3) return 0')
  })

  // 官方 MESSAGE_ROLE_BY_TYPE 在 v4 改档（dsh-session/lib/index.js:1143-1149）：
  // v3 的 tool/result 消息 role='user'，v4 是 'tool'，并新增 developer/message='developer'。
  // 一张表量两代 ⇒ 0.1.7-rc.2 真机把 13 个正常 v4 会话误判成不可读。
  it('消息 role 表按格式版本分档（v3 tool=user / v4 tool=tool + developer）', () => {
    expect(src).toContain("const MSG_ROLE_V3 = { 'system/message': 'system', 'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'user' }")
    expect(src).toContain("const MSG_ROLE_V4 = { 'system/message': 'system', 'developer/message': 'developer', 'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'tool' }")
    expect(src).toContain('function msgRoleTable')
    expect(src).toContain('const roleTable = msgRoleTable(version)')
  })

  it('v4 里 role:"tool" 的 tool/result 是合法形态，不得误判为损坏', async () => {
    const home = tempHome()
    try {
      const dir = join(home, 'sessions', '--g--', 'session-v4-tool')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, SESSION_FILE_V4)
      writeV3(file, [
        { type: 'session', version: 4, id: 'session-v4-tool', createdAt: 0, cwd: 'C:\\x' },
        { seq: 0, type: 'user/message', data: { id: 'm0', role: 'user', source: { kind: 'user' }, content: [] } },
        { seq: 1, type: 'tool/result', data: { turn: 0, step: 0, message: { id: 't0', role: 'tool', source: { kind: 'tool' }, content: [], toolCallId: 'c1' } } },
        { seq: 2, type: 'developer/message', data: { turn: 0, step: 0, message: { id: 'd0', role: 'developer', source: { kind: 'tool' }, content: [] } } },
      ])
      const c = await runSessionRepairDriver(isolatedRuntime(), { mode: 'check', sessionsRoot: join(home, 'sessions'), files: [file] })
      if (!c.ok) throw new Error(c.error)
      expect(c.summary.broken).toBe(0)
      expect(c.summary.ok).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanupTemps()
    }
  })

  it('500 个长路径不再触发 spawn ENAMETOOLONG（老写法在此必挂）', async () => {
    const home = tempHome()
    try {
      const root = join(home, 'sessions')
      const files = Array.from(
        { length: 500 },
        (_, i) => join(root, '--workspace-' + 'x'.repeat(80) + '--', 'session-' + i, SESSION_FILE_V4),
      )
      const argvChars = JSON.stringify({ mode: 'check', sessionsRoot: root, files }).length + src.length
      expect(argvChars).toBeGreaterThan(32767) // 该规模在旧实现下必然超限
      const r = await runSessionRepairDriver(isolatedRuntime(), { mode: 'check', sessionsRoot: root, files })
      if (!r.ok) throw new Error('driver 仍走不通：' + r.error)
      expect(r.summary.total).toBe(500)
      expect(r.summary.errors).toBe(500) // 文件不存在 → 逐个 decode error，但驱动本身跑完了
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanupTemps()
    }
  })

  it('v4 里退役的 kind:"plugin" 改回生产者自有 kind（含 inbox 槽位），v3 不动', async () => {
    const home = tempHome()
    try {
      const dir = join(home, 'sessions', '--g--', 'session-v4')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, SESSION_FILE_V4)
      writeV3(file, [
        { type: 'session', version: 4, id: 'session-v4', createdAt: 0, cwd: 'C:\\x' },
        // ① 第三方插件写的退役形态 + 多余字段：kind 换成 plugin:<名>，plugin 字段删除，其余保留
        {
          seq: 0,
          type: 'user/message',
          data: {
            id: 'm0',
            role: 'user',
            source: { kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'notice' },
            content: [{ type: 'text', text: 'hi' }],
          },
        },
        // ② inbox 里尚未落成事件的注入同样过 v4 闸门；第一方插件名保持自有 kind
        {
          seq: 1,
          type: 'agent/inbox/spliced',
          data: {
            target: 'main',
            start: 0,
            inserted: [{ id: 'm1', role: 'user', source: { kind: 'plugin', plugin: 'hooks-claude-code' }, content: [] }],
          },
        },
        // ③ 未来的 descriptor 版本不能被降级
        { seq: 2, type: 'subagent/descriptor', data: { version: 4, provider: 'x', mode: 'one-shot' } },
      ])
      const rt = isolatedRuntime()
      const root = join(home, 'sessions')

      const r = await runSessionRepairDriver(rt, { mode: 'repair', sessionsRoot: root, backupDir: join(home, 'backup'), files: [file] })
      if (!r.ok) throw new Error(r.error)
      expect(r.summary.fixed).toBe(1)
      expect(r.summary.items[0]?.fixes).toEqual({ seqs: 0, form: 0, descriptor: 0, identity: 0, kind: 2 })

      const rows = decodeFrames(readFileSync(file))
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { data?: { source?: Record<string, unknown>; inserted?: Array<{ source?: Record<string, unknown> }>; version?: number } })
      expect(rows[1]?.data?.source).toEqual({ kind: 'plugin:dsh-obsidian-bridge', form: 'notice' })
      expect(rows[2]?.data?.inserted?.[0]?.source).toEqual({ kind: 'hooks-claude-code' })
      expect(rows[3]?.data?.version).toBe(4)

      // v3 会话里的 kind:"plugin" 是合法形态，不得改写
      const legacyDir = join(home, 'sessions', '--g--', 'session-v3')
      mkdirSync(legacyDir, { recursive: true })
      const legacy = join(legacyDir, SESSION_FILE_V3)
      writeV3(legacy, [
        { type: 'session', version: 3, id: 'session-v3', createdAt: 0, cwd: 'C:\\x' },
        { seq: 0, type: 'user/message', data: { id: 'm0', role: 'user', source: { kind: 'plugin', plugin: 'demo' }, content: [] } },
      ])
      const r2 = await runSessionRepairDriver(rt, { mode: 'repair', sessionsRoot: root, files: [legacy] })
      if (!r2.ok) throw new Error(r2.error)
      expect(r2.summary.fixed).toBe(0)
      const legacyRows = decodeFrames(readFileSync(legacy))
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { data?: { source?: Record<string, unknown> } })
      expect(legacyRows[1]?.data?.source).toEqual({ kind: 'plugin', plugin: 'demo' })
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanupTemps()
    }
  })
})
