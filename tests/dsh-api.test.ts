import { describe, expect, it } from 'vitest'
import {
  newRpcId,
  pickRecentSession,
  resolveTargetSession,
  sendTextToSession,
  type DshResult,
  type DshTransport,
} from '../src/dsh-api'

/** 假 HTTP 传输：返回预置响应，记录请求参数。 */
function fakeTransport(responses: { status?: number; text?: string }[]): {
  transport: DshTransport
  calls: { path: string; body: string }[]
} {
  const calls: { path: string; body: string }[] = []
  const transport: DshTransport = {
    post: async (_port, path, body) => {
      calls.push({ path, body })
      const r = responses.shift() ?? { status: 200, text: '{}' }
      return { status: r.status ?? 200, text: r.text ?? '' }
    },
  }
  return { transport, calls }
}

function serverResponse(ok: boolean, valueOrError: unknown): string {
  return JSON.stringify(
    ok
      ? { type: 'server-response', rpcId: 'r', result: { ok: true, value: valueOrError } }
      : { type: 'server-response', rpcId: 'r', result: { ok: false, error: valueOrError } },
  )
}

describe('newRpcId', () => {
  it('返回非空字符串且两次调用不同', () => {
    const a = newRpcId()
    const b = newRpcId()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })
})

describe('pickRecentSession', () => {
  it('跳过 blank 会话，返回最近的可用会话', () => {
    const items = [
      { sessionId: 'blank-session', updatedAt: 100, running: false, blank: true },
      { sessionId: 'recent', updatedAt: 50, running: false, blank: false },
      { sessionId: 'older', updatedAt: 10, running: false, blank: false },
    ]
    expect(pickRecentSession(items)).toBe('recent')
  })
  it('全部 blank 或空列表时返回 null', () => {
    expect(pickRecentSession([{ sessionId: 'a', updatedAt: 1, running: false, blank: true }])).toBeNull()
    expect(pickRecentSession([])).toBeNull()
  })
})

describe('resolveTargetSession', () => {
  it('有可用会话时直接用最近会话，不新建', async () => {
    const { transport, calls } = fakeTransport([
      { text: serverResponse(true, { items: [{ sessionId: 's1', updatedAt: 1, running: false, blank: false }] }) },
    ])
    const r = await resolveTargetSession(3080, transport)
    expect(r).toEqual({ ok: true, value: 's1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/session.list')
  })
  it('无可用会话时调用 session.create 新建', async () => {
    const { transport, calls } = fakeTransport([
      { text: serverResponse(true, { items: [] }) },
      { text: serverResponse(true, { sessionId: 'new-session' }) },
    ])
    const r = await resolveTargetSession(3080, transport)
    expect(r).toEqual({ ok: true, value: 'new-session' })
    expect(calls.map((c) => c.path)).toEqual(['/api/session.list', '/api/session.create'])
  })
  it('list 失败时透传错误', async () => {
    const { transport } = fakeTransport([
      { text: serverResponse(false, { code: 'internal', message: 'boom' }) },
    ])
    const r = await resolveTargetSession(3080, transport)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('boom')
      expect(r.code).toBe('internal')
    }
  })
  it('连接被拒（ECONNREFUSED）时返回可读错误', async () => {
    const transport: DshTransport = {
      post: async () => {
        const e = new Error('connect ECONNREFUSED 127.0.0.1:3080') as Error & { code: string }
        e.code = 'ECONNREFUSED'
        throw e
      },
    }
    const r: DshResult<string> = await resolveTargetSession(3080, transport)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('DSH 服务未运行')
    }
  })
})

describe('sendTextToSession', () => {
  it('按协议构造 session.prompt 请求（mode=queue，原文直发）', async () => {
    const { transport, calls } = fakeTransport([
      { text: serverResponse(true, { accepted: true }) },
    ])
    const r = await sendTextToSession(3080, 's1', '选中的文字', transport)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/session.prompt')
    const body = JSON.parse(calls[0].body) as {
      type: string
      method: string
      payload: { sessionId: string; mode: string; content: { type: string; text: string }[] }
    }
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('session.prompt')
    expect(body.payload).toEqual({
      sessionId: 's1',
      mode: 'queue',
      content: [{ type: 'text', text: '选中的文字' }],
    })
  })
  it('业务失败（如 session-not-found）返回错误信息', async () => {
    const { transport } = fakeTransport([
      { text: serverResponse(false, { code: 'session-not-found', message: '会话不存在' }) },
    ])
    const r = await sendTextToSession(3080, 'missing', 'x', transport)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('session-not-found')
      expect(r.error).toBe('会话不存在')
    }
  })
  it('非 200 状态码映射为 HTTP 错误', async () => {
    const { transport } = fakeTransport([{ status: 415, text: 'content type must be application/json' }])
    const r = await sendTextToSession(3080, 's1', 'x', transport)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('415')
    }
  })
  it('无法解析的响应返回可读错误', async () => {
    const { transport } = fakeTransport([{ text: 'not json' }])
    const r = await sendTextToSession(3080, 's1', 'x', transport)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('无法解析')
    }
  })
})
