import { beforeEach, describe, expect, it } from 'vitest'
import {
  endpointFor,
  listSessions,
  newRpcId,
  pickRecentSession,
  resetDshApiSession,
  resolveTargetSession,
  sendTextToSession,
  type DshResult,
  type DshTransport,
} from '../src/dsh-api'

/** 假 HTTP 传输：按队列返回预置响应，记录请求参数（v2.3.1：含 get 与 headers 记录）。 */
function fakeTransport(responses: { status?: number; text?: string; setCookie?: string }[]): {
  transport: DshTransport
  calls: { path: string; body: string; headers?: Record<string, string> }[]
  getCalls: { path: string }[]
} {
  const calls: { path: string; body: string; headers?: Record<string, string> }[] = []
  const getCalls: { path: string }[] = []
  const transport: DshTransport = {
    post: async (_port, path, body, headers) => {
      calls.push({ path, body, headers })
      const r = responses.shift() ?? { status: 200, text: '{}' }
      return { status: r.status ?? 200, text: r.text ?? '', setCookie: r.setCookie ?? '' }
    },
    get: async (_port, path) => {
      getCalls.push({ path })
      const r = responses.shift() ?? { status: 200, text: '' }
      return { status: r.status ?? 200, text: r.text ?? '', setCookie: r.setCookie ?? '' }
    },
  }
  return { transport, calls, getCalls }
}

/** 标准 server-response 成功体 */
function okResponse(value: unknown): { status: number; text: string } {
  return { text: serverResponse(true, value) }
}

beforeEach(() => {
  resetDshApiSession()
})

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
      get: async () => ({ status: 0, text: '' }),
    }
    const r: DshResult<string> = await resolveTargetSession(3080, transport)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('DSH 服务未运行')
    }
  })
})

describe('v2.3.1 端点形态自适应（点分 0.1.2- / 斜杠 0.1.3+）', () => {
  it('endpointFor：点分/斜杠两种形态', () => {
    expect(endpointFor('session.list', 'dot')).toBe('session.list')
    expect(endpointFor('session.list', 'slash')).toBe('session/list')
  })
  it('点分 404 → 自动切斜杠并缓存（body method 同步）', async () => {
    const { transport, calls } = fakeTransport([
      { status: 404, text: '' },
      okResponse({ items: [{ sessionId: 's1', updatedAt: 1, running: false, blank: false }] }),
    ])
    const r = await resolveTargetSession(3080, transport)
    expect(r).toEqual({ ok: true, value: 's1' })
    expect(calls.map((c) => c.path)).toEqual(['/api/session.list', '/api/session/list'])
    expect(JSON.parse(calls[1].body).method).toBe('session/list')
    // 已缓存斜杠形态：下一次直接走斜杠（无点分探测；空列表→create 也走斜杠）
    const t2 = fakeTransport([okResponse({ items: [] }), okResponse({ sessionId: 'n' })])
    const r2 = await resolveTargetSession(3080, t2.transport)
    expect(r2.ok).toBe(true)
    expect(t2.calls.map((c) => c.path)).toEqual(['/api/session/list', '/api/session/create'])
  })
  it('两种形态均 404 → 返回 HTTP 404 错误', async () => {
    const { transport } = fakeTransport([{ status: 404, text: '' }, { status: 404, text: '' }])
    const r = await resolveTargetSession(3080, transport)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('404')
  })
})

describe('v2.3.1 会话认证（0.1.2+ /api 也要 cookie；Node 直连不受 SameSite 限制）', () => {
  const AUTH_URL = 'http://127.0.0.1:3080/?token=abc123'
  it('401 + authUrl → token 交换 Set-Cookie → 带 cookie 重试成功', async () => {
    const { transport, calls, getCalls } = fakeTransport([
      { status: 401, text: '' }, // 首次 post：缺 cookie
      {
        status: 303,
        text: '',
        setCookie: 'dsh-auth-XYZ=v1.aaa.bbb; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict',
      }, // get token 交换
      okResponse({ items: [{ sessionId: 's9', updatedAt: 1, running: false, blank: false }] }), // 重试 post
    ])
    const r = await resolveTargetSession(3080, transport, AUTH_URL)
    expect(r).toEqual({ ok: true, value: 's9' })
    expect(getCalls.map((c) => c.path)).toEqual(['/?token=abc123'])
    expect(calls[1].headers?.cookie).toBe('dsh-auth-XYZ=v1.aaa.bbb')
  })
  it('cookie 会话缓存：后续请求直接带，不再交换', async () => {
    const t1 = fakeTransport([
      { status: 401, text: '' },
      { status: 303, text: '', setCookie: 'dsh-auth-A=v1.x.y; Path=/' },
      okResponse({ items: [] }),
      okResponse({ sessionId: 'n1' }),
    ])
    const r = await resolveTargetSession(3080, t1.transport, AUTH_URL)
    expect(r.ok).toBe(true)
    const t2 = fakeTransport([okResponse({ items: [{ sessionId: 's', updatedAt: 1, running: false, blank: false }] })])
    const r2 = await resolveTargetSession(3080, t2.transport, AUTH_URL)
    expect(r2.ok).toBe(true)
    expect(t2.getCalls).toHaveLength(0) // 不再交换
    expect(t2.calls[0].headers?.cookie).toBe('dsh-auth-A=v1.x.y')
  })
  it('401 且无 authUrl → 认证专属错误文案', async () => {
    const { transport } = fakeTransport([{ status: 401, text: '' }])
    const r = await resolveTargetSession(3080, transport, '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('会话认证')
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

describe('listSessions（v2.4.0：升级后预检）', () => {
  it('新形态 payload {args:{_request:{}}} 成功返回列表', async () => {
    const { transport, calls } = fakeTransport([okResponse({ items: [{ sessionId: 's1', blank: false }] })])
    const r = await listSessions(3080, '', transport)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.items).toHaveLength(1)
    expect((JSON.parse(calls[0].body) as { payload: unknown }).payload).toEqual({ args: { _request: {} } })
  })
  it('新形态失败时退回空对象 payload（旧版形态）', async () => {
    const { transport, calls } = fakeTransport([
      { status: 400, text: '' },
      okResponse({ items: [] }),
    ])
    const r = await listSessions(3080, '', transport)
    expect(r.ok).toBe(true)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect((JSON.parse(calls[1].body) as { payload: unknown }).payload).toEqual({})
  })
  it('两种形态都失败时返回错误（不抛错）', async () => {
    const { transport } = fakeTransport([
      { status: 400, text: '' },
      { status: 401, text: 'authentication required' },
    ])
    const r = await listSessions(3080, '', transport)
    expect(r.ok).toBe(false)
  })
})
