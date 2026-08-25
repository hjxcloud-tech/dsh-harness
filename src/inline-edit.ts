/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { extractAssistantText, readHistory, resolveTargetSession, sendEditToSession, waitForEditResult, type HistoryEntry } from './dsh-api'
import { t } from './i18n'

/**
 * Inline Edit：选中文本 → DSH 编辑 → 词级 diff 预览 → 确认应用。
 * 复用 DSH 官方 RPC（session.list/prompt/history），纯 HTTP，无 WebSocket 依赖。
 * 本文件不 import obsidian（保持可在测试环境解析）；编辑器应用逻辑在 inline-edit-modal.ts。
 */

/** 默认编辑指令模板；{text} 占位符被选中原文替换。 */
export function defaultEditPromptTemplate(): string {
  return t('inline.promptTemplate')
}

/** 渲染编辑指令：模板 + 选中原文 + 来源路径 tag（复用 source-tag 格式）。 */
export function buildEditPrompt(template: string, selectedText: string, sourceTag: string): string {
  const body = template.replaceAll('{text}', selectedText)
  return sourceTag !== '' ? `${sourceTag}\n${body}` : body
}

/** 记录历史基线 seq：读 tail 页取最大 seq；失败返回 0（仍可工作，只是会看到更早事件）。 */
export async function readBaseSeq(port: number, sessionId: string, transport?: unknown): Promise<number> {
  const r = await readHistory(port, sessionId, { maxMessages: 1, transport: transport as never })
  if (!r.ok) return 0
  const seqs = r.value.map((e) => e.seq)
  return seqs.length > 0 ? Math.max(...seqs) : 0
}

/**
 * 执行一次 Inline Edit：
 * 1. 解析目标会话（复用 resolveTargetSession）
 * 2. 记录历史基线
 * 3. 发送编辑指令（steer 模式）
 * 4. 轮询等待回复文本
 * 返回编辑结果文本或失败原因。
 */
export async function runInlineEdit(
  port: number,
  prompt: string,
  opts: { timeoutMs?: number; pollMs?: number; transport?: unknown } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const session = await resolveTargetSession(port, opts.transport as never)
  if (!session.ok) return { ok: false, error: session.error }
  const sessionId = session.value
  const baseSeq = await readBaseSeq(port, sessionId, opts.transport)
  const sent = await sendEditToSession(port, sessionId, prompt, opts.transport as never)
  if (!sent.ok) return { ok: false, error: sent.error }
  const result = await waitForEditResult(port, sessionId, baseSeq, {
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    transport: opts.transport as never,
  })
  if (!result.ok) return result
  return { ok: true, text: result.text }
}

/** 从历史中取最近一条 assistant 文本（用于降级提示：把编辑指令复制给用户手动粘贴）。 */
export function latestAssistantText(entries: HistoryEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].event.type === 'assistant/message') {
      const text = extractAssistantText(entries[i])
      if (text.trim() !== '') return text
    }
  }
  return ''
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
