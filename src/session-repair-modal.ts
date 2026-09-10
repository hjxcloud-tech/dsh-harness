/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Obsidian APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { App, Modal, Notice, Setting } from 'obsidian'
import { basename, join } from 'node:path'
import { dshHomeDir } from './bridge'
import { backupTimestamp, defaultCleanupBackupDir } from './cleanup'
import { t } from './i18n'
import {
  findSessionFiles,
  resolveSessionRepairRuntime,
  runSessionRepairDriver,
  type SessionRepairRuntime,
  type SessionRepairSummary,
} from './session-repair'

/**
 * 会话格式修复弹窗（v2.4.0）：
 * 1. 打开即做只读预检（DSH 自带迁移链逐会话校验）；
 * 2. 「备份并修复」先复制原文件到备份目录，改完复验通过才落盘；
 * 3. 修复后自动复检，展示仍不可读的数量。
 * 不做任何自动改写——必须用户点击，且红字说明会改写文件。
 */
export class SessionRepairModal extends Modal {
  private readonly home: string
  private statusEl: HTMLElement | null = null
  private dangerEl: HTMLElement | null = null
  private busy = false
  private runtime: SessionRepairRuntime | null = null
  private runtimeError = ''
  private broken = 0
  private summary: SessionRepairSummary | null = null

  constructor(app: App, home: string = dshHomeDir()) {
    super(app)
    this.home = home
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    this.setTitle(t('repair.title'))
    contentEl.createEl('p', { text: t('repair.desc') })
    this.dangerEl = contentEl.createEl('p', { cls: 'dsh-modal-danger', text: t('repair.danger') })
    this.statusEl = contentEl.createEl('p', { cls: 'dsh-repair-status', text: t('repair.checking') })
    this.renderButtons()
    void this.check()
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private setStatus(text: string): void {
    if (this.statusEl !== null) this.statusEl.setText(text)
  }

  private renderButtons(): void {
    const wrap = this.contentEl.createDiv({ cls: 'dsh-repair-actions' })
    new Setting(wrap)
      .addButton((b) =>
        b
          .setButtonText(t('repair.btnRepair', { n: String(this.broken) }))
          .setWarning()
          .setDisabled(this.busy || this.broken === 0)
          .onClick(() => {
            void this.repair()
          }),
      )
      .addButton((b) =>
        b.setButtonText(t('repair.btnRecheck')).onClick(() => {
          if (this.busy) return
          this.broken = 0
          this.renderButtons()
          void this.check()
        }),
      )
      .addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
  }

  /** 清掉旧的按钮区后重画（按钮文案含不可读会话数）。 */
  private rerenderActions(): void {
    const actions = this.contentEl.querySelectorAll('.dsh-repair-actions')
    actions.forEach((el) => el.remove())
    this.renderButtons()
  }

  private async check(): Promise<void> {
    this.busy = true
    this.rerenderActions()
    this.setStatus(t('repair.checking'))
    try {
      const resolved = resolveSessionRepairRuntime()
      if (!resolved.ok) {
        this.runtimeError = resolved.error
        this.setStatus(resolved.error)
        this.busy = false
        this.rerenderActions()
        return
      }
      this.runtime = resolved.runtime
      const files = findSessionFiles(this.home)
      if (files.length === 0) {
        this.setStatus(t('repair.checkClean', { total: '0' }))
        this.busy = false
        this.rerenderActions()
        return
      }
      const result = await runSessionRepairDriver(this.runtime, {
        mode: 'check',
        sessionsRoot: join(this.home, 'sessions'),
        files,
      })
      if (!result.ok) {
        this.setStatus(result.error)
        this.busy = false
        this.rerenderActions()
        return
      }
      this.summary = result.summary
      this.broken = result.summary.broken
      const clean = result.summary.broken === 0
      this.setStatus(
        clean
          ? t('repair.checkClean', { total: String(result.summary.total) })
          : t('repair.checkDone', {
              total: String(result.summary.total),
              ok: String(result.summary.ok),
              broken: String(result.summary.broken),
            }),
      )
      this.renderRuntimeInfo()
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      this.busy = false
      this.rerenderActions()
    }
  }

  private renderRuntimeInfo(): void {
    if (this.runtime === null || this.statusEl === null) return
    const info = t('repair.runtime', {
      node: this.runtime.nodePath,
      version: this.runtime.version,
      dir: basename(this.runtime.cwd),
    })
    this.statusEl.createEl('br')
    this.statusEl.createSpan({ text: info })
  }

  private async repair(): Promise<void> {
    const resolved = this.runtime !== null ? { ok: true as const, runtime: this.runtime } : resolveSessionRepairRuntime()
    if (!resolved.ok) {
      new Notice(resolved.error, 10000)
      return
    }
    const files = findSessionFiles(this.home)
    if (files.length === 0) {
      new Notice(t('repair.noChange'), 6000)
      return
    }
    this.busy = true
    this.rerenderActions()
    const backupDir = join(defaultCleanupBackupDir(this.home), `sessions-repair-${backupTimestamp()}`)
    let done = 0
    this.setStatus(t('repair.running', { done: '0', total: String(files.length) }))
    try {
      const result = await runSessionRepairDriver(
        resolved.runtime,
        { mode: 'repair', sessionsRoot: join(this.home, 'sessions'), backupDir, files },
        () => {
          done += 1
          this.setStatus(t('repair.running', { done: String(done), total: String(files.length) }))
        },
      )
      if (!result.ok) {
        new Notice(result.error, 12000)
        this.setStatus(result.error)
        return
      }
      const s = result.summary
      this.setStatus(
        t('repair.done', {
          fixed: String(s.fixed),
          errors: String(s.errors),
          broken: String(s.broken),
        }),
      )
      this.statusEl?.createEl('br')
      this.statusEl?.createSpan({ text: t('repair.backupDir', { dir: backupDir }) })
      new Notice(
        t('repair.done', { fixed: String(s.fixed), errors: String(s.errors), broken: String(s.broken) }),
        s.errors > 0 ? 15000 : 8000,
      )
      // 修复后复检一次，把「仍不可读」刷新为实测值
      this.busy = false
      await this.check()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setStatus(msg)
      new Notice(msg, 12000)
    } finally {
      this.busy = false
      this.rerenderActions()
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Obsidian-API exemption for non-type-aware review scans */
