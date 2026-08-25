/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node fs APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * StartupProfiler：记录插件启动各阶段耗时（onload → 服务探测 → 服务启动 → 面板就绪），
 * 写入 data.json（最近 N 次），设置页「诊断」区可查看；失败路径同样打点（含错误信息）。
 * 打点本身开销 <1ms（Date.now），不引入任何同步探测。
 */

/** 单次启动记录。 */
export interface StartupRecord {
  /** 记录完成时刻（epoch ms）。 */
  ts: number
  /** 各阶段耗时（ms），顺序即阶段顺序。 */
  phases: Record<string, number>
  /** 本次启动是否成功就绪。 */
  ok: boolean
  /** 失败时的错误信息（ok=false 时）。 */
  error?: string
}

/** 持久化文件：与插件 data.json 同目录的独立文件（不污染主设置）。 */
export const STARTUP_LOG_FILENAME = 'dsh-startup-log.json'

/** 保留最近 N 次记录。 */
export const MAX_RECORDS = 20

/** 读写文件注入点（测试可换临时目录）。 */
export interface StartupProfilerDeps {
  readFile(path: string): string | null
  writeFile(path: string, content: string): void
  now(): number
}

const defaultDeps: StartupProfilerDeps = {
  readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
  now: () => Date.now(),
}

/** 简单时钟：记录阶段起止。 */
export class StartupProfiler {
  private readonly marks: Array<{ name: string; ts: number }> = []
  private readonly dataDir: string
  private readonly deps: StartupProfilerDeps

  constructor(dataDir: string, deps: StartupProfilerDeps = defaultDeps) {
    this.dataDir = dataDir
    this.deps = deps
  }

  /** 标记一个阶段开始（或完成点）：记录 [name, ts]；同名前缀可多次（如 probe:start / probe:done）。 */
  mark(name: string): void {
    this.marks.push({ name, ts: this.deps.now() })
  }

  /** 提交一次完整记录：把 marks 转成相邻阶段耗时并持久化；清空 marks。 */
  commit(ok: boolean, error?: string): void {
    const phases: Record<string, number> = {}
    const sorted = [...this.marks].sort((a, b) => a.ts - b.ts)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      // 只取相邻未命名冲突的段：name 相同则视为同一阶段内的子标记，跳过
      if (cur.name === prev.name) continue
      const key = `${prev.name}->${cur.name}`
      phases[key] = cur.ts - prev.ts
    }
    // 最后一个标记到 commit 时刻
    if (sorted.length > 0) {
      const last = sorted[sorted.length - 1]
      phases[`${last.name}->commit`] = this.deps.now() - last.ts
    }
    this.append({ ts: this.deps.now(), phases, ok, ...(error !== undefined ? { error } : {}) })
    this.marks.length = 0
  }

  /** 追加记录到文件（截断到 MAX_RECORDS）。 */
  private append(record: StartupRecord): void {
    const path = join(this.dataDir, STARTUP_LOG_FILENAME)
    let records: StartupRecord[] = []
    const existing = this.deps.readFile(path)
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as { records?: StartupRecord[] }
        if (Array.isArray(parsed.records)) records = parsed.records
      } catch {
        // 损坏则丢弃旧记录
      }
    }
    records.push(record)
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS)
    this.deps.writeFile(path, JSON.stringify({ records }, null, 2))
  }

  /** 读取最近记录（供设置页诊断区显示）。 */
  readRecords(): StartupRecord[] {
    const path = join(this.dataDir, STARTUP_LOG_FILENAME)
    const existing = this.deps.readFile(path)
    if (!existing) return []
    try {
      const parsed = JSON.parse(existing) as { records?: StartupRecord[] }
      return Array.isArray(parsed.records) ? parsed.records : []
    } catch {
      return []
    }
  }
}

/** 解析插件 data.json 目录（Obsidian data 目录）：dirname 由调用方传入。 */
export function dataDirFor(pluginDataDir: string): string {
  return pluginDataDir
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the fs-API exemption for non-type-aware review scans */
