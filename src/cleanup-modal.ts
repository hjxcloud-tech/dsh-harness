import { App, Modal, Setting, type ButtonComponent } from 'obsidian'
import { t } from './i18n'

/**
 * 卸载并重装 DSH 的危险确认弹窗（v2.2.0）：
 * 红字风险说明 + 「建议先试非破坏性修复」提示 + 备份目录输入 + 可选删仓库源码 +
 * 复选框强确认（勾选前红色 CTA 禁用）。
 */
export class CleanReinstallModal extends Modal {
  private confirmed = false
  private backupDir: string
  private deleteRepo = false
  private confirmBtn: ButtonComponent | null = null

  constructor(
    app: App,
    private readonly opts: {
      defaultBackupDir: string
      /** 仓库源码目录；为空则不显示「删除仓库」选项。 */
      repoDir: string
      onConfirm: (backupDir: string, deleteRepo: boolean) => void
    },
  ) {
    super(app)
    this.backupDir = opts.defaultBackupDir
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-cleanup-modal')
    contentEl.createEl('h3', { text: t('cleanup.modal.title') })
    contentEl.createEl('p', { text: t('cleanup.modal.warn'), cls: 'dsh-cleanup-warn' })
    contentEl.createEl('p', { text: t('cleanup.modal.keep') })
    contentEl.createEl('p', { text: t('cleanup.modal.suggest') })

    new Setting(contentEl)
      .setName(t('cleanup.modal.backupDir'))
      .addText((txt) =>
        txt.setValue(this.backupDir).onChange((v) => {
          this.backupDir = v.trim() || this.opts.defaultBackupDir
        }),
      )

    if (this.opts.repoDir) {
      new Setting(contentEl)
        .setName(t('cleanup.modal.deleteRepo', { dir: this.opts.repoDir }))
        .addToggle((tg) =>
          tg.setValue(false).onChange((v) => {
            this.deleteRepo = v
          }),
        )
    }

    new Setting(contentEl)
      .setName(t('cleanup.modal.confirmCheck'))
      .addToggle((tg) =>
        tg.setValue(false).onChange((v) => {
          this.confirmed = v
          this.confirmBtn?.setDisabled(!v)
        }),
      )

    const s = new Setting(contentEl)
    s.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
    s.addButton((b) => {
      this.confirmBtn = b
        .setButtonText(t('cleanup.modal.confirm'))
        .setWarning()
        .setDisabled(true)
        .onClick(() => {
          this.close()
          this.opts.onConfirm(this.backupDir, this.deleteRepo)
        })
      return this.confirmBtn
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
