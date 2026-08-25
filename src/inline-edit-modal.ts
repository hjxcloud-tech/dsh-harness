/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Obsidian APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { App, Modal, Notice, Setting, type Editor } from 'obsidian'
import { renderDiffHtml, wordDiff } from './diff'
import { t } from './i18n'
import { runInlineEdit } from './inline-edit'

/**
 * Inline Edit Modal：
 * - 打开时展示「编辑中…」进度与指令；
 * - DSH 回复后渲染 原文 vs 回复 的词级 diff；
 * - 「应用」写回编辑器 /「放弃」关闭 / 失败显示原因与重试。
 */
export class InlineEditModal extends Modal {
  constructor(
    app: App,
    private readonly port: number,
    private readonly selectedText: string,
    private readonly prompt: string,
    private readonly sourceTag: string,
    private readonly getEditor: () => Editor | null,
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('dsh-inline-modal')
    this.setTitle(t('inline.title'))

    // 指令说明
    new Setting(contentEl).setName(t('inline.instructionLabel')).setDesc(this.prompt)

    // 状态区（进度 / 结果 / 错误）
    const statusEl = contentEl.createDiv({ cls: 'dsh-inline-status' })
    statusEl.setText(t('inline.running'))

    // diff 容器（初始隐藏）
    const diffWrap = contentEl.createDiv({ cls: 'dsh-inline-diff-wrap' })
    diffWrap.hidden = true
    const originalEl = diffWrap.createDiv({ cls: 'dsh-inline-diff-pane dsh-inline-original' })
    const editedEl = diffWrap.createDiv({ cls: 'dsh-inline-diff-pane dsh-inline-edited' })

    // 操作区
    const actions = contentEl.createDiv({ cls: 'dsh-inline-actions' })
    const applyBtn = actions.createEl('button', { text: t('inline.apply'), cls: 'mod-cta' })
    const cancelBtn = actions.createEl('button', { text: t('inline.cancel') })
    applyBtn.disabled = true

    // 执行编辑（异步）
    void (async () => {
      const result = await runInlineEdit(this.port, this.prompt, {})
      if (result.ok) {
        statusEl.setText(t('inline.done'))
        diffWrap.hidden = false
        originalEl.innerHTML = renderDiffHtml(
          wordDiff(this.selectedText, this.selectedText).map((x) => ({ ...x, type: 'same' as const })),
        )
        editedEl.innerHTML = renderDiffHtml(wordDiff(this.selectedText, result.text))
        applyBtn.disabled = false
        applyBtn.onclick = () => {
          const editor = this.getEditor()
          if (editor) {
            applyEdit(editor, result.text)
          }
          this.close()
        }
      } else {
        statusEl.setText(t('inline.failed', { err: result.error }))
        applyBtn.disabled = true
        applyBtn.setText(t('inline.retry'))
        applyBtn.onclick = () => this.retry()
      }
    })()

    cancelBtn.onclick = () => this.close()
  }

  private retry(): void {
    // 重试：清空内容重新打开（重新构造 Modal 更简单）
    this.contentEl.empty()
    this.onOpen()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** 应用编辑结果到编辑器（替换选中区域；无选区则插入光标处）。 */
function applyEdit(editor: Editor, editedText: string): void {
  const sel = editor.getSelection()
  if (sel !== '') {
    editor.replaceSelection(editedText)
  } else {
    editor.replaceRange(editedText, editor.getCursor())
  }
  new Notice(t('inline.applied'))
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Obsidian-API exemption for non-type-aware review scans */
