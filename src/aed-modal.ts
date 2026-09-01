import { App, Modal, Setting } from 'obsidian'
import { t } from './i18n'
import type { BootFailureKind } from './aed'

/**
 * AED 启动异常弹窗（v2.1.0）：AED safe/clear 完成并重启后，启动校验失败时弹出。
 * 展示「错误类型 / 判断 / 建议动作」三行（Obsidian 标准行：左文案、右控件），
 * 询问用户是否执行一次性修复：
 * - 自动可修类（client-modules / bundle-face / patch-parse）→「执行修复（仅一次）」；
 * - 其余类 → 仅「知道了」+ 提示改用其他 harness。
 */
export class AedBootModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      kind: BootFailureKind
      detail: string
      autoFixable: boolean
      onApply: () => void | Promise<void>
    },
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-aed-modal')
    contentEl.createEl('h3', { text: t('aed.verifyModalTitle') })
    new Setting(contentEl).setName(t('aed.modal.type')).setDesc(t(`aed.kind.${this.opts.kind}`))
    new Setting(contentEl).setName(t('aed.modal.reason')).setDesc(t(`aed.reason.${this.opts.kind}`))
    new Setting(contentEl)
      .setName(t('aed.modal.fix'))
      .setDesc(this.opts.autoFixable ? t('aed.fix.patch') : t('aed.fix.none'))
    if (this.opts.detail) {
      contentEl.createEl('p', { text: t('aed.modal.detail', { detail: this.opts.detail }), cls: 'dsh-aed-detail' })
    }
    const s = new Setting(contentEl)
    s.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
    if (this.opts.autoFixable) {
      s.addButton((b) =>
        b.setButtonText(t('aed.modal.apply')).setCta().onClick(async () => {
          this.close()
          await this.opts.onApply()
        }),
      )
    } else {
      s.addButton((b) => b.setButtonText(t('aed.modal.understood')).setCta().onClick(() => this.close()))
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
