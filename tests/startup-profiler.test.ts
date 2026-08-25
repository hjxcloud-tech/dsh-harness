import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RECORDS, StartupProfiler, STARTUP_LOG_FILENAME, type StartupRecord } from '../src/startup-profiler'

function freshDeps(): {
  dir: string
  deps: { readFile: (p: string) => string | null; writeFile: (p: string, c: string) => void; now: () => number }
  files: Map<string, string>
  clock: { t: number }
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profiler-'))
  const files = new Map<string, string>()
  const clock = { t: 1000 }
  const deps = {
    readFile: (p: string): string | null => files.get(p) ?? null,
    writeFile: (p: string, c: string): void => {
      files.set(p, c)
    },
    now: (): number => clock.t,
  }
  return { dir, deps, files, clock }
}

describe('StartupProfiler', () => {
  it('mark + commit 生成相邻阶段耗时并持久化', () => {
    const { dir, deps, clock } = freshDeps()
    const p = new StartupProfiler(dir, deps)
    p.mark('onload')
    clock.t += 100
    p.mark('probe')
    clock.t += 50
    p.mark('panel-ready')
    clock.t += 10
    p.commit(true)
    const rec = p.readRecords()
    expect(rec.length).toBe(1)
    expect(rec[0].ok).toBe(true)
    expect(rec[0].phases['onload->probe']).toBe(100)
    expect(rec[0].phases['probe->panel-ready']).toBe(50)
    expect(rec[0].phases['panel-ready->commit']).toBe(10)
  })

  it('失败记录带 error 信息', () => {
    const { dir, deps, clock } = freshDeps()
    const p = new StartupProfiler(dir, deps)
    p.mark('onload')
    clock.t += 30
    p.mark('probe')
    p.commit(false, 'connection refused')
    const rec = p.readRecords()[0]
    expect(rec.ok).toBe(false)
    expect(rec.error).toBe('connection refused')
  })

  it('多次记录追加且保留最近 MAX_RECORDS 条', () => {
    const { dir, deps } = freshDeps()
    const p = new StartupProfiler(dir, deps)
    for (let i = 0; i < MAX_RECORDS + 5; i++) {
      p.mark('onload')
      p.commit(true)
    }
    const recs = p.readRecords()
    expect(recs.length).toBe(MAX_RECORDS)
  })

  it('损坏的日志文件被忽略并重建', () => {
    const { dir, deps, files } = freshDeps()
    files.set(join(dir, STARTUP_LOG_FILENAME), 'not-json{{{')
    const p = new StartupProfiler(dir, deps)
    p.mark('onload')
    p.commit(true)
    expect(p.readRecords().length).toBe(1)
  })

  it('无记录时 readRecords 返回空数组', () => {
    const { dir, deps } = freshDeps()
    const p = new StartupProfiler(dir, deps)
    expect(p.readRecords()).toEqual([])
  })
})

describe('StartupRecord 类型完整性', () => {
  it('构造的 record 可 JSON 序列化（供设置页展示）', () => {
    const rec: StartupRecord = { ts: 1, phases: { 'a->b': 5 }, ok: true }
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec)
  })
})
