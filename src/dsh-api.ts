/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (http) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { request } from 'node:http'
import { t } from './i18n'

/**
 * 直连 DSH 本地后端（127.0.0.1:{port}/api/）的极简 RPC 客户端。
 * 协议来源：DSH 仓库 packages/host/apiproxy（POST /api/<method>，body 为
 * {type:'client-request', rpcId, method, payload}，响应 {type:'server-response', rpcId, result}）。
 * 该接口无鉴权（仅要求 content-type: application/json；浏览器跨源会被 CORS 拦截，
 * 插件走 Node http 直连不受影响）。零 DSH 改动，端用户只需更新插件。
 */

/** 会话列表条目（session.list 的 items 元素，仅取用到的字段）。 */
export interface DshSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
}

/** RPC 调用结果：业务成功/失败统一收敛为可读字符串。 */
export type DshResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

/** 可注入的 HTTP 传输（测试注入假实现，避免真实网络）。 */
export interface DshTransport {
  post(port: number, path: string, body: string): Promise<{ status: number; text: string }>
}

const DEFAULT_TIMEOUT_MS = 8000

/** 生成 rpcId（window.crypto.randomUUID 优先，兼容旧运行环境降级）。 */
export function newRpcId(): string {
  try {
    const c = (window as unknown as { crypto?: { randomUUID?: () => string } }).crypto
    if (c?.randomUUID) {
      return c.randomUUID()
    }
  } catch {
    // 无 window / crypto 时降级到时间戳+随机串
  }
  return `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 默认 HTTP 传输：node:http 直连 127.0.0.1。 */
function httpPost(port: number, path: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(t('api.timeout', { ms: DEFAULT_TIMEOUT_MS })))
    })
    req.on('error', (err: Error) => reject(err instanceof Error ? err : new Error(String(err))))
    req.end(body)
  })
}

const defaultTransport: DshTransport = { post: httpPost }

/** 调用一个 DSH unary RPC 方法，返回业务结果或可读错误。 */
export async function dshRequest<T>(
  port: number,
  method: string,
  payload: unknown,
  transport: DshTransport = defaultTransport,
): Promise<DshResult<T>> {
  const body = JSON.stringify({ type: 'client-request', rpcId: newRpcId(), method, payload })
  let res: { status: number; text: string }
  try {
    res = await transport.post(port, `/api/${method}`, body)
  } catch (err) {
    const e = err as { code?: string; message?: string }
    if (e?.code === 'ECONNREFUSED') {
      return { ok: false, error: t('api.notRunning', { port }) }
    }
    return { ok: false, error: t('api.connectFail', { err: e?.message ?? String(err) }) }
  }
  if (res.status !== 200) {
    return { ok: false, error: t('api.httpStatus', { code: res.status }) }
  }
  try {
    const parsed = JSON.parse(res.text) as {
      type?: string
      result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
    }
    if (parsed.type !== 'server-response' || !parsed.result) {
      return { ok: false, error: t('api.badFormat') }
    }
    if (parsed.result.ok) {
      return { ok: true, value: parsed.result.value as T }
    }
    return {
      ok: false,
      error: parsed.result.error?.message ?? t('api.rejected'),
      code: parsed.result.error?.code,
    }
  } catch {
    return { ok: false, error: t('api.unparsable') }
  }
}

/** 从会话列表中挑选最近可用会话（跳过 blank——从未开过对话的会话，GUI 同样隐藏）。 */
export function pickRecentSession(items: DshSessionSummary[]): string | null {
  const usable = items.find((item) => !item.blank)
  return usable?.sessionId ?? null
}

/** 解析发送目标：优先最近会话；无可用会话时新建一个。 */
export async function resolveTargetSession(
  port: number,
  transport: DshTransport = defaultTransport,
): Promise<DshResult<string>> {
  const list = await dshRequest<{ items: DshSessionSummary[] }>(port, 'session.list', {}, transport)
  if (!list.ok) {
    return list
  }
  const existing = pickRecentSession(list.value.items)
  if (existing) {
    return { ok: true, value: existing }
  }
  const created = await dshRequest<{ sessionId: string }>(port, 'session.create', {}, transport)
  if (!created.ok) {
    return created
  }
  return { ok: true, value: created.value.sessionId }
}

/** 把文字作为用户消息发进指定会话（mode=queue：加入消息队列，智能体自动处理）。 */
export async function sendTextToSession(
  port: number,
  sessionId: string,
  text: string,
  transport: DshTransport = defaultTransport,
): Promise<DshResult<unknown>> {
  return dshRequest(
    port,
    'session.prompt',
    {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
    transport,
  )
}

/** 把文字作为编辑指令发进指定会话（mode=steer：独占接管当前 turn，等待回复）。 */
export async function sendEditToSession(
  port: number,
  sessionId: string,
  text: string,
  transport: DshTransport = defaultTransport,
): Promise<DshResult<unknown>> {
  return dshRequest(
    port,
    'session.prompt',
    {
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text }],
    },
    transport,
  )
}

/** 历史条目（session.history 的 events 元素，仅取用到的字段）。 */
export interface HistoryEntry {
  seq: number
  event: {
    type: string
    turn?: number
    step?: number
    message?: { role?: string; content?: Array<{ type?: string; text?: string }> }
  }
}

/** 读取会话历史窗口（tail 页：beforeSeq 缺省）；返回事件列表。 */
export async function readHistory(
  port: number,
  sessionId: string,
  opts: { beforeSeq?: number; maxMessages?: number; transport?: DshTransport } = {},
): Promise<DshResult<HistoryEntry[]>> {
  const r = await dshRequest<{ events: HistoryEntry[] }>(
    port,
    'session.history',
    { sessionId, ...(opts.beforeSeq !== undefined ? { beforeSeq: opts.beforeSeq } : {}), ...(opts.maxMessages !== undefined ? { maxMessages: opts.maxMessages } : {}) },
    opts.transport,
  )
  if (!r.ok) return r
  return { ok: true, value: r.value.events ?? [] }
}

/** 提取 assistant/message 事件的回复纯文本（拼接 content 中全部 text 块）。 */
export function extractAssistantText(entry: HistoryEntry): string {
  const blocks = entry.event.message?.content ?? []
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('')
}

/**
 * 等待一次编辑结果：在 baseSeq 之后轮询 session.history，直到出现
 * assistant/message（turn 与 prompt 后首个 assistant turn 对齐）且其后有 turn/end。
 * 超时返回失败；纯 HTTP 轮询，无 WebSocket 依赖。
 */
export async function waitForEditResult(
  port: number,
  sessionId: string,
  baseSeq: number,
  opts: { timeoutMs?: number; pollMs?: number; transport?: DshTransport } = {},
): Promise<{ ok: true; text: string; turn: number } | { ok: false; error: string }> {
  const timeoutMs = opts.timeoutMs ?? 120000
  const pollMs = opts.pollMs ?? 1500
  const transport = opts.transport
  const deadline = Date.now() + timeoutMs
  let lastSeq = baseSeq
  while (Date.now() < deadline) {
    const r = await readHistory(port, sessionId, { maxMessages: 40, transport })
    if (!r.ok) return { ok: false, error: r.error }
    // 只处理 seq 严格大于基线的条目（本次 prompt 之后新产生的事件）
    const fresh = r.value.filter((e) => e.seq > lastSeq)
    if (fresh.length > 0) {
      lastSeq = Math.max(...fresh.map((e) => e.seq), lastSeq)
      const assistant = fresh.find((e) => e.event.type === 'assistant/message')
      if (assistant) {
        const turn = assistant.event.turn ?? 0
        const text = extractAssistantText(assistant)
        if (text.trim() !== '') {
          // 等一个 turn/end 确认回合收尾（最多再轮询 5 次）
          for (let i = 0; i < 5; i++) {
            await sleep(pollMs)
            const r2 = await readHistory(port, sessionId, { maxMessages: 40, transport })
            if (!r2.ok) return { ok: false, error: r2.error }
            if (r2.value.some((e) => e.seq > lastSeq && e.event.type === 'turn/end' && (e.event.turn ?? 0) === turn)) {
              return { ok: true, text, turn }
            }
          }
          return { ok: true, text, turn }
        }
      }
    }
    await sleep(pollMs)
  }
  return { ok: false, error: t('inline.timeout') }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
