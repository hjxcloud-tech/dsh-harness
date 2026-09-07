import { App, Modal, Setting } from 'obsidian'
import { t } from './i18n'
import type { BootFailureKind } from './aed'

/**
 * AED 启动异常弹窗（v2.1.0）：AED safe/clear 完成并重启后，启动校验失败时弹出。
 * 展示「错误类型 / 判断 / 建议动作」三行（Obsidian 标准行：左文案、右控件），
 * 询问用户是否执行一次性修复：
 * - 自动可修类（client-modules / bundle-face / patch-parse）→「执行修复（仅一次）」；
 * - 认证类 auth（DSH ≥0.1.2，v2.3.0）→ 已捕获 token 时提供「在浏览器打开 DSH」（并明示桥接/服务辅助功能失效），否则仅说明；
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
      /** 认证类：启动输出中捕获到的带 token 认证 URL（空 = 未捕获，如 <0.1.2 或日志不可用）。 */
      browserUrl?: string
      /** 认证类：在系统浏览器中打开（携带 browserUrl）。 */
      onOpenBrowser?: () => void
    },
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-aed-modal')
    contentEl.createEl('h3', { text: t('aed.verifyModalTitle') })
    const isAuth = this.opts.kind === 'auth'
    const hasBrowser = isAuth && (this.opts.browserUrl ?? '') !== ''
    new Setting(contentEl).setName(t('aed.modal.type')).setDesc(t(`aed.kind.${this.opts.kind}`))
    new Setting(contentEl).setName(t('aed.modal.reason')).setDesc(t(`aed.reason.${this.opts.kind}`))
    const fixText = isAuth
      ? hasBrowser
        ? t('aed.fix.auth.browser')
        : t('aed.fix.auth.none')
      : this.opts.autoFixable
        ? t('aed.fix.patch')
        : t('aed.fix.none')
    new Setting(contentEl).setName(t('aed.modal.fix')).setDesc(fixText)
    if (isAuth) {
      contentEl.createEl('p', { text: t('aed.fix.auth.lost'), cls: 'dsh-modal-danger' })
    }
    if (this.opts.detail) {
      contentEl.createEl('p', { text: t('aed.modal.detail', { detail: this.opts.detail }), cls: 'dsh-aed-detail' })
    }
    const s = new Setting(contentEl)
    s.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
    if (isAuth && hasBrowser) {
      s.addButton((b) =>
        b.setButtonText(t('aed.modal.openBrowser')).setCta().onClick(() => {
          this.close()
          this.opts.onOpenBrowser?.()
        }),
      )
    } else if (this.opts.autoFixable) {
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
