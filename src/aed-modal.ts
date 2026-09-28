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

/**
 * AED「适用症状说明」弹窗（v2.8.6）：设置页 AED 行正文只留功能一句话（用户定案：dsh-fix 后的
 * 括号说明删掉，依赖解释移到本弹窗首行小字），症状清单由用户主动点行名右侧的链接才出现。
 * 清单分两组：**✓ 可以抢救 / ✗ 不适用**，两组同字号，只用符号与颜色区分（不做字号差异，
 * 用户明确要求「字号都调整为一样的」）；附属说明走 .dsh-modal-detail 小字。
 * 与「DSH版本适配说明」同构：只在主动点开时出现，不新增任何自动弹的路径。
 */
export class AedSymptomsModal extends Modal {
  constructor(app: App) {
    super(app)
  }

  /** 一条症状：✓／✗ 单独成 span（着色），正文另起 span 保持正常文字色。 */
  private addSymptom(list: HTMLElement, text: string, can: boolean): void {
    const li = list.createEl('li')
    li.createSpan({ cls: can ? 'dsh-symptom-yes' : 'dsh-symptom-no', text: can ? '✓' : '✗' })
    li.createSpan({ cls: 'dsh-symptom-text', text })
  }

  private addList(contentEl: HTMLElement, titleKey: string, itemsKey: string, can: boolean): void {
    contentEl.createEl('p', { text: t(titleKey), cls: 'dsh-symptoms-title' })
    const list = contentEl.createEl('ul', { cls: 'dsh-modal-bullets' })
    for (const line of t(itemsKey).split('\n')) {
      if (line === '') continue
      this.addSymptom(list, line, can)
    }
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-aed-modal')
    contentEl.createEl('h3', { text: t('aed.symptoms.title') })
    contentEl.createEl('p', { text: t('aed.symptoms.depNote'), cls: 'dsh-modal-detail' })
    this.addList(contentEl, 'aed.symptoms.canTitle', 'aed.symptoms.can', true)
    this.addList(contentEl, 'aed.symptoms.cannotTitle', 'aed.symptoms.cannot', false)
    contentEl.createEl('p', { text: t('aed.symptoms.exitNote'), cls: 'dsh-modal-detail' })
    new Setting(contentEl).addButton((b) =>
      b.setButtonText(t('compat.explain.close')).setCta().onClick(() => this.close()),
    )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
