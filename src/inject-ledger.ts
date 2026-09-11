/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 桥接注入台账（v2.4.4）——治「多次框选 → DSH 崩溃」。
 *
 * 背景（真机实测）：桥接插件的 `agent/pre-step` 钩子只要"最新消息含 BRIDGES 隐式行"就往
 * `decision.messages` 追加一条新的 `user/message`，去重仅靠"扫当前 messages 窗口"。
 * 而会话上下文会被压缩/裁剪（真机 `compaction/prune` 48 次）——一旦那条注入消息被裁出窗口，
 * 去重失效 → 下一步再注入一条 → 会话变大 → 更多压缩 → 更容易裁掉 → 再注入，**自增强循环**
 * （真机后果：单会话 11.8MB、user/message 564 条、面板 DOM 279 万字 → DSH 崩溃）。
 *
 * 本模块提供**不依赖会话窗口**的持久去重 + 限流 + 熔断：
 * - key = sha256(path|loc|instruction).slice(0,16)，TTL 10 分钟；超期或超过命中上限即重新放行；
 * - 单会话注入总数上限（熔断），超出后停止注入并留下 storm 标记（插件侧据此提示用户）；
 * - 台账落在桥接包目录旁（由桥接 `.mjs` 与插件两侧共用同一份判定规则，见 `decideInject`）。
 */

/** 台账条目：一次注入的记录（按 key 聚合计数）。 */
export interface InjectLedgerEntry {
  key: string
  /** 最近一次注入时间（ms）。 */
  at: number
  /** 累计命中次数（用于同 key 上限）。 */
  count: number
  /** 会话标识（弱标识，用于单会话上限与风暴归因）。 */
  session: string
  /** 载荷签名（`[BRIDGES 编辑指令] <path> · <loc>`），用于与 inbox/surface 比对。 */
  sig: string
}

/** 熔断记录（插件侧读它提示用户）。 */
export interface InjectStorm {
  at: number
  reason: string
  session: string
}

/** 台账文件内容。 */
export interface InjectLedgerData {
  version: 1
  items: InjectLedgerEntry[]
  /** 会话 → 注入次数。 */
  sessions: Record<string, number>
  storm?: InjectStorm
}

/** 限流上限（与桥接 `.mjs` 内联实现保持一致；改这里必须同步改模板）。 */
export const INJECT_LIMITS = {
  /** 同 key 去重窗口：10 分钟。 */
  ttlMs: 10 * 60 * 1000,
  /**
   * 同 key（同选区 + 同指令）在 TTL 窗口内的允许注入次数 = **1**（一次性语义）。
   * 之所以是 1：真机的注入风暴来自"每 step 重复注入"，而 DSH 的 inbox 一次性投递 + 本台账
   * 共同保证"同一选区只在首个 TTL 窗口注入一次"；想再次注入同一选区，改选区或改指令文本即可
   * （key 变化），或等 TTL 过期。
   */
  maxKeyHits: 1,
  /** 单会话注入总数上限（熔断阈值）。 */
  maxSessionInjections: 20,
  /** 台账条目上限（超出按时间淘汰）。 */
  maxItems: 200,
} as const

/** 跳过原因（诊断用）。 */
export type InjectSkipReason = 'none' | 'window' | 'pending' | 'surface' | 'ledger' | 'caps'

/** 判定输入（全部为可注入的纯数据，便于单测）。 */
export interface InjectDecisionInput {
  /** 是否解析到 BRIDGES 隐式行（否则无需判定）。 */
  hasTarget: boolean
  /** 本次选区对应的台账 key。 */
  key: string
  /** 载荷签名。 */
  sig: string
  /** 会话标识。 */
  sessionKey: string
  now: number
  /** 现有"扫 messages 窗口"是否已含本桥接注入（旧判据，保留为最便宜的一层）。 */
  windowHasInject: boolean
  /** `agent.inbox.nextStep` 里的签名集合（一次性投递中的等价项）。 */
  pendingSigs: string[]
  /** `agent.session.surface.nodes` 里的签名集合（DSH 原生去重口径）。 */
  surfaceSigs: string[]
  data: InjectLedgerData
}

/** 判定结果。 */
export interface InjectDecision {
  action: 'inject' | 'skip'
  reason: InjectSkipReason
  /** 更新后的台账（action==='inject' 时已记账）。 */
  data: InjectLedgerData
}

/** 空台账。 */
export function emptyLedger(): InjectLedgerData {
  return { version: 1, items: [], sessions: {} }
}

/** 清理过期条目（超过 TTL 的 key 记录），并裁剪到条目上限。 */
export function pruneLedger(data: InjectLedgerData, now: number): InjectLedgerData {
  const items = data.items.filter((it) => now - it.at <= INJECT_LIMITS.ttlMs)
  items.sort((a, b) => b.at - a.at)
  return { ...data, items: items.slice(0, INJECT_LIMITS.maxItems) }
}

/** 同 key 在 TTL 窗口内的命中次数。 */
export function keyHits(data: InjectLedgerData, key: string, now: number): number {
  return data.items.filter((it) => it.key === key && now - it.at <= INJECT_LIMITS.ttlMs).length
}

/**
 * 纯判定规则（桥接 `.mjs` 内联同逻辑；改这里必须同步改 `bridgeEditInjectSource()`）。
 * 顺序：窗口 → inbox pending → session surface → 本地台账 → 限流熔断。
 */
export function decideInject(input: InjectDecisionInput): InjectDecision {
  const { key, sig, sessionKey, now } = input
  const pruned = pruneLedger(input.data, now)
  if (!input.hasTarget) return { action: 'skip', reason: 'none', data: pruned }
  if (input.windowHasInject) return { action: 'skip', reason: 'window', data: pruned }
  if (input.pendingSigs.includes(sig)) return { action: 'skip', reason: 'pending', data: pruned }
  if (input.surfaceSigs.includes(sig)) return { action: 'skip', reason: 'surface', data: pruned }
  if (keyHits(pruned, key, now) >= INJECT_LIMITS.maxKeyHits) {
    return { action: 'skip', reason: 'ledger', data: pruned }
  }
  const sessionCount = pruned.sessions[sessionKey] ?? 0
  if (sessionCount >= INJECT_LIMITS.maxSessionInjections) {
    return {
      action: 'skip',
      reason: 'caps',
      data: { ...pruned, storm: { at: now, reason: `session cap ${String(INJECT_LIMITS.maxSessionInjections)}`, session: sessionKey } },
    }
  }
  const items = [...pruned.items, { key, at: now, count: keyHits(pruned, key, now) + 1, session: sessionKey, sig }]
  return {
    action: 'inject',
    reason: 'none',
    data: {
      ...pruned,
      items,
      sessions: { ...pruned.sessions, [sessionKey]: sessionCount + 1 },
    },
  }
}

/** 台账文件路径（桥接包目录旁）。 */
export function ledgerPathFor(bridgeDir: string): string {
  return join(bridgeDir, 'inject-ledger.json')
}

/** 读取台账（缺失/损坏 → 空台账）。 */
export function loadLedger(bridgeDir: string): InjectLedgerData {
  try {
    const raw = readFileSync(ledgerPathFor(bridgeDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return emptyLedger()
    const obj = parsed as Partial<InjectLedgerData>
    return {
      version: 1,
      items: Array.isArray(obj.items) ? (obj.items as InjectLedgerEntry[]) : [],
      sessions: obj.sessions !== null && typeof obj.sessions === 'object' ? (obj.sessions as Record<string, number>) : {},
      storm: obj.storm,
    }
  } catch {
    return emptyLedger()
  }
}

/** 写入台账（失败静默——不可写时调用方会降低上限）。 */
export function saveLedger(bridgeDir: string, data: InjectLedgerData): boolean {
  try {
    mkdirSync(bridgeDir, { recursive: true })
    writeFileSync(ledgerPathFor(bridgeDir), JSON.stringify(data), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读取熔断标记（插件侧在加载时检查并提示用户）。 */
export function readStorm(bridgeDir: string, withinMs = 30 * 60 * 1000, now = Date.now()): InjectStorm | null {
  const data = loadLedger(bridgeDir)
  if (data.storm === undefined) return null
  if (now - data.storm.at > withinMs) return null
  return data.storm
}

/** 清除熔断标记（提示过一次后）。 */
export function clearStorm(bridgeDir: string): void {
  const data = loadLedger(bridgeDir)
  if (data.storm === undefined) return
  const next: InjectLedgerData = { version: 1, items: data.items, sessions: data.sessions }
  saveLedger(bridgeDir, next)
}

/** 台账目录是否存在（诊断用）。 */
export function ledgerExists(bridgeDir: string): boolean {
  try {
    return existsSync(ledgerPathFor(bridgeDir))
  } catch {
    return false
  }
}

/** 计算注入 key（与桥接 `.mjs` 内联实现一致）。 */
export function injectKey(path: string, loc: string, instruction: string): string {
  return createHash('sha256').update(`${path}|${loc}|${instruction.trim()}`).digest('hex').slice(0, 16)
}

/** 计算载荷签名（与桥接 `.mjs` 内联实现一致）。 */
export function injectSig(path: string, loc: string): string {
  return `[BRIDGES 编辑指令] ${path} · ${loc}`
}

/** 台账所在目录（桥接包目录）——供插件侧定位。 */
export function ledgerDirForBridge(webProfile: string, packageDirname: string): string {
  return join(webProfile, packageDirname)
}

/** 目录名解析（保持与 dirname 语义一致，供测试与调用方复用）。 */
export function parentDir(file: string): string {
  return dirname(file)
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
