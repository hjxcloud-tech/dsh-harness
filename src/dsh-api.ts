/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (http) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { request } from 'node:http'
import { t } from './i18n'

/**
 * 直连 DSH 本地后端（127.0.0.1:{port}/api/）的极简 RPC 客户端。
 * 协议来源：DSH 仓库 packages/client/connection（POST /api/<endpoint>，body 为
 * {type:'client-request', rpcId, method, payload}，响应 {type:'server-response', rpcId, result}）。
 * 走 Node http 直连（不受浏览器 CSP/CORS 限制）。
 *
 * 版本自适应（v2.3.1）：
 * - 端点形态：≤0.1.2 用点分（session.list），0.1.3+ 网关改斜杠（session/list）——
 *   先按缓存形态调用，404 时自动切换另一形态并记住；
 * - 浏览器会话认证：0.1.2+ 的 /api 也要求 dsh web 启动 token 换发的 cookie——
 *   Node 请求不受 SameSite 约束，用捕获的 token URL 走一次 GET 拿 Set-Cookie，后续带 Cookie 头。
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

/** HTTP 响应（get 额外返回 set-cookie 首项，供会话交换）。 */
export interface TransportResponse {
  status: number
  text: string
  setCookie?: string
}

/** 可注入的 HTTP 传输（测试注入假实现，避免真实网络）。 */
export interface DshTransport {
  post(port: number, path: string, body: string, headers?: Record<string, string>): Promise<TransportResponse>
  get(port: number, path: string): Promise<TransportResponse>
}

const DEFAULT_TIMEOUT_MS = 8000

/** 端点形态缓存（null=未知，先点后斜）。 */
let apiStyle: 'dot' | 'slash' | null = null
/** 会话 cookie（token 交换所得；'' = 未认证/无需认证）。 */
let authCookie = ''
/** 会话交换进行中标记（防并发重复交换）。 */
let authInFlight: Promise<string> | null = null

/** 测试复位（模块级缓存不跨用例泄漏）。 */
export function resetDshApiSession(): void {
  apiStyle = null
  authCookie = ''
  authInFlight = null
}

/** 方法名（内部一律点分）→ 端点形态。 */
export function endpointFor(method: string, style: 'dot' | 'slash'): string {
  return style === 'dot' ? method : method.replace('.', '/')
}

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
function httpRequest(
  port: number,
  path: string,
  method: 'POST' | 'GET',
  body?: string,
  headers?: Record<string, string>,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: DEFAULT_TIMEOUT_MS,
        ...(method === 'POST'
          ? {
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body ?? ''),
                ...headers,
              },
            }
          : headers !== undefined
            ? { headers }
            : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => {
          const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie']
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            setCookie: raw ?? '',
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(t('api.timeout', { ms: DEFAULT_TIMEOUT_MS })))
    })
    req.on('error', (err: Error) => reject(err instanceof Error ? err : new Error(String(err))))
    if (method === 'POST') req.end(body)
    else req.end()
  })
}

function httpPost(
  port: number,
  path: string,
  body: string,
  headers?: Record<string, string>,
): Promise<TransportResponse> {
  return httpRequest(port, path, 'POST', body, headers)
}

function httpGet(port: number, path: string): Promise<TransportResponse> {
  return httpRequest(port, path, 'GET')
}

const defaultTransport: DshTransport = { post: httpPost, get: httpGet }

/** 从认证 URL（http://127.0.0.1:port/?token=...）取 path+query 做会话交换。 */
function authPathOf(authUrl: string): string {
  const m = /^https?:\/\/[^/]+(\/.*)$/.exec(authUrl.trim())
  return m?.[1] ?? ''
}

/**
 * token → cookie 会话交换（v2.3.1）：GET 带 token 的启动 URL，
 * 从 303 的 Set-Cookie 里取 `dsh-auth-*` 值；200（无认证版本）返回空。
 */
async function exchangeAuthCookie(port: number, authUrl: string, transport: DshTransport): Promise<string> {
  const path = authPathOf(authUrl)
  if (path === '') return ''
  if (authInFlight) return authInFlight
  authInFlight = (async () => {
    try {
      const res = await transport.get(port, path)
      const raw = res.setCookie ?? ''
      const pair = raw.split(';')[0]?.trim() ?? ''
      if (res.status >= 300 && res.status < 400 && pair.startsWith('dsh-auth-')) {
        authCookie = pair
      } else if (res.status === 200) {
        authCookie = ''
      }
      return authCookie
    } catch {
      return ''
    } finally {
      authInFlight = null
    }
  })()
  return authInFlight
}

/** 解析 RPC 响应体（server-response 信封）。 */
function parseRpcResult<T>(text: string): DshResult<T> {
  try {
    const parsed = JSON.parse(text) as {
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

/** 调用一个 DSH unary RPC 方法：端点形态自适应（点分/斜杠，404 切换并缓存）+ 0.1.2+ 会话 cookie。 */
export async function dshRequest<T>(
  port: number,
  method: string,
  payload: unknown,
  transport: DshTransport = defaultTransport,
  authUrl = '',
): Promise<DshResult<T>> {
  // 形态尝试顺序：已缓存优先；未知时先点分（≤0.1.2 主流）后斜杠（0.1.3+）
  const styles: Array<'dot' | 'slash'> =
    apiStyle === 'dot' ? ['dot', 'slash'] : apiStyle === 'slash' ? ['slash', 'dot'] : ['dot', 'slash']
  let cookie = authCookie
  let authTried = false
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i]
    const endpoint = endpointFor(method, style)
    const body = JSON.stringify({ type: 'client-request', rpcId: newRpcId(), method: endpoint, payload })
    let res: TransportResponse
    try {
      res = await transport.post(port, `/api/${endpoint}`, body, cookie !== '' ? { cookie } : undefined)
    } catch (err) {
      const e = err as { code?: string; message?: string }
      if (e?.code === 'ECONNREFUSED') {
        return { ok: false, error: t('api.notRunning', { port }) }
      }
      return { ok: false, error: t('api.connectFail', { err: e?.message ?? String(err) }) }
    }
    if (res.status === 401 && !authTried && authUrl !== '') {
      // 0.1.2+ 浏览器会话认证：Node 直连不受 SameSite 限制，token 交换 cookie 后重试当前形态
      authTried = true
      cookie = await exchangeAuthCookie(port, authUrl, transport)
      i-- // 同一形态直接重试（不算切换）
      continue
    }
    if (res.status === 404) {
      continue // 换另一形态
    }
    if (res.status !== 200) {
      return {
        ok: false,
        error: res.status === 401 ? t('api.authRequired') : t('api.httpStatus', { code: res.status }),
      }
    }
    apiStyle = style
    return parseRpcResult<T>(res.text)
  }
  return { ok: false, error: t('api.httpStatus', { code: 404 }) }
}

/** 从会话列表中挑选最近可用会话（跳过 blank——从未开过对话的会话，GUI 同样隐藏）。 */
export function pickRecentSession(items: DshSessionSummary[]): string | null {
  const usable = items.find((item) => !item.blank)
  return usable?.sessionId ?? null
}

/** 解析发送目标：优先最近会话；无可用会话时新建一个。authUrl=启动输出捕获的认证链接（0.1.2+ 需要）。 */
export async function resolveTargetSession(
  port: number,
  transport: DshTransport = defaultTransport,
  authUrl = '',
): Promise<DshResult<string>> {
  const list = await dshRequest<{ items: DshSessionSummary[] }>(port, 'session.list', {}, transport, authUrl)
  if (!list.ok) {
    return list
  }
  const existing = pickRecentSession(list.value.items)
  if (existing) {
    return { ok: true, value: existing }
  }
  const created = await dshRequest<{ sessionId: string }>(port, 'session.create', {}, transport, authUrl)
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
  authUrl = '',
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
    authUrl,
  )
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
