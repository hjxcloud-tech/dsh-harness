import { describe, expect, it } from 'vitest'
import { extractAssistantText, waitForEditResult, type DshResult, type DshTransport, type HistoryEntry } from '../src/dsh-api'
import { buildEditPrompt, defaultEditPromptTemplate, runInlineEdit } from '../src/inline-edit'

function serverResponse(ok: boolean, valueOrError: unknown): string {
  return JSON.stringify(
    ok
      ? { type: 'server-response', rpcId: 'r', result: { ok: true, value: valueOrError } }
      : { type: 'server-response', rpcId: 'r', result: { ok: false, error: valueOrError } },
  )
}

function histEntry(seq: number, type: string, extra: Record<string, unknown> = {}): HistoryEntry {
  return {
    seq,
    event: { type, ...extra } as HistoryEntry['event'],
  }
}

/** 可编排的假传输：按调用序号返回预置响应。 */
function scriptedTransport(responses: ((path: string) => { status: number; text: string })[]): {
  transport: DshTransport
} {
  let i = 0
  const transport: DshTransport = {
    post: async (_port, path, _body) => responses[Math.min(i++, responses.length - 1)](path),
  }
  return { transport }
}

describe('extractAssistantText', () => {
  it('拼接 content 中全部 text 块', () => {
    const e = histEntry(1, 'assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
    })
    expect(extractAssistantText(e)).toBe('hello world')
  })
  it('无 text 块返回空串', () => {
    expect(extractAssistantText(histEntry(1, 'assistant/message', { message: { content: [{ type: 'tool' }] } }))).toBe('')
  })
})

describe('buildEditPrompt', () => {
  it('模板 {text} 被选中原文替换', () => {
    const p = buildEditPrompt('编辑：{text}', 'abc', '')
    expect(p).toBe('编辑：abc')
  })
  it('来源标签存在时前置', () => {
    const p = buildEditPrompt('编辑：{text}', 'abc', '[来源：Obsidian 笔记 X.md]')
    expect(p).toContain('[来源：Obsidian 笔记 X.md]')
    expect(p.indexOf('[来源')).toBeLessThan(p.indexOf('编辑'))
  })
  it('默认模板含 {text} 占位', () => {
    expect(defaultEditPromptTemplate()).toContain('{text}')
  })
})

describe('waitForEditResult', () => {
  it('轮询到 assistant/message 与 turn/end 后返回文本', async () => {
    let n = 0
    const t = scriptedTransport([
      // 第一次轮询：返回基线后新事件（assistant/message，无 turn/end 在此页）
      () => ({
        status: 200,
        text: serverResponse(true, { events: [histEntry(11, 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'edited!' }] } })] }),
      }),
      // 后续轮询：返回 turn/end
      () => ({
        status: 200,
        text: serverResponse(true, { events: [histEntry(12, 'turn/end', { turn: 3 })] }),
      }),
    ])
    const r = await waitForEditResult(3080, 's1', 10, { pollMs: 5, timeoutMs: 2000, transport: t.transport })
    expect(r).toEqual({ ok: true, text: 'edited!', turn: 3 })
    void n
  })

  it('忽略 seq 不大于基线的旧事件', async () => {
    const t = scriptedTransport([
      () => ({ status: 200, text: serverResponse(true, { events: [histEntry(9, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'old' }] } })] }) }),
      () => ({ status: 200, text: serverResponse(true, { events: [] }) }),
    ])
    // 基线 10，第一次轮询只见旧事件 → 继续等，第二次空 → 直到超时
    const r = await waitForEditResult(3080, 's1', 10, { pollMs: 5, timeoutMs: 100, transport: t.transport })
    expect(r.ok).toBe(false)
  })

  it('超时返回失败', async () => {
    const t = scriptedTransport([
      () => ({ status: 200, text: serverResponse(true, { events: [] }) }),
    ])
    const r = await waitForEditResult(3080, 's1', 0, { pollMs: 5, timeoutMs: 80, transport: t.transport })
    expect(r.ok).toBe(false)
  })

  it('传输错误返回失败', async () => {
    const t = scriptedTransport([
      () => ({ status: 200, text: serverResponse(false, { code: 'internal', message: 'boom', details: {} }) }),
    ])
    const r = await waitForEditResult(3080, 's1', 0, { pollMs: 5, timeoutMs: 100, transport: t.transport })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('boom')
  })
})

describe('runInlineEdit（编排）', () => {
  it('全链路：会话解析 → 基线 → steer prompt → 等待回复', async () => {
    const calls: string[] = []
    const t: DshTransport = {
      post: async (_port, path, _body) => {
        calls.push(path)
        if (path === '/api/session.list') {
          return { status: 200, text: serverResponse(true, { items: [{ sessionId: 's1', updatedAt: 1, running: false, blank: false }] }) }
        }
        if (path === '/api/session.history') {
          // 第一次调用是基线（返回空），后续调用返回 assistant + turn/end
          const historyCalls = calls.filter((c) => c === '/api/session.history').length
          if (historyCalls === 1) {
            return { status: 200, text: serverResponse(true, { events: [] }) }
          }
          if (historyCalls === 2) {
            return { status: 200, text: serverResponse(true, { events: [histEntry(11, 'assistant/message', { turn: 5, message: { content: [{ type: 'text', text: 'ok' }] } })] }) }
          }
          return { status: 200, text: serverResponse(true, { events: [histEntry(12, 'turn/end', { turn: 5 })] }) }
        }
        if (path === '/api/session.prompt') {
          return { status: 200, text: serverResponse(true, { accepted: true }) }
        }
        return { status: 200, text: '{}' }
      },
    }
    const r = await runInlineEdit(3080, '编辑：x', { pollMs: 5, timeoutMs: 2000, transport: t as never })
    expect(r).toEqual({ ok: true, text: 'ok' })
    expect(calls).toContain('/api/session.prompt')
    expect(calls.filter((c) => c === '/api/session.history').length).toBeGreaterThanOrEqual(2)
  })

  it('无可用会话时返回失败', async () => {
    const t: DshTransport = {
      post: async (_port, path, _body) => {
        // session.list 返回空；session.create 返回错误（模拟创建失败）
        if (path === '/api/session.create') {
          return { status: 200, text: serverResponse(false, { code: 'internal', message: 'create failed', details: {} }) }
        }
        return { status: 200, text: serverResponse(true, { items: [] }) }
      },
    }
    const r = await runInlineEdit(3080, 'x', { transport: t as never })
    expect(r.ok).toBe(false)
  })
})
