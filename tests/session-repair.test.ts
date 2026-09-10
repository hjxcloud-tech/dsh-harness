import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSessionRepairDriverSource,
  dshPackageDirCandidates,
  findSessionFiles,
  probeZstdNode,
  resolveSessionRepairRuntime,
} from '../src/session-repair'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-repair-test-'))
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
