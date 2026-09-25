/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Obsidian DOM helpers (createEl/createSpan) are typed loosely in the review scanner's stub. */
/**
 * 适配说明弹窗（v2.6.0 引入，v2.8.4 收窄为**只给用户主动查阅**）。
 *
 * v2.6.0–v2.8.3 期间它还承担"开机发现不适配时弹诊断框"的职责（带「重新写入桥接」「重启服务」
 * 「今天不再提示」等就地处置按钮）。v2.8.4 按用户指示取消全部自动弹窗后，本组件只剩一个调用点：
 * 设置页「DSH版本适配说明」链接——用户主动点开，看的是政策与本机判定，不需要处置按钮。
 * 就地处置一律留在设置页原有控件上（重新写入桥接、重连、重启服务、检查更新）。
 */
import { App, Modal, Setting } from 'obsidian'

/** 一个可选操作按钮（label 已本地化；onClick 内自行关闭或交由外层关闭）。 */
export interface CompatAction {
  label: string
  onClick: () => void | Promise<void>
  /** 是否作为主按钮（CTA 样式）。 */
  cta?: boolean
}

export interface CompatNoticeOptions {
  title: string
  /** 正文（发生了什么 / 本机判定结论）。 */
  body: string
  /** 要点列表（说明型弹窗用；渲染为 ul/li，逐条陈述适配政策与判据）。 */
  bullets?: string[]
  /** 红字补充（风险/后果）。 */
  danger?: string
  /** 灰色小字（版本号、路径等取证信息）。 */
  detail?: string
  /** 主操作按钮（无处置项时传空数组，只剩「关闭」）。 */
  actions: CompatAction[]
  /** 关闭（不做任何处置）。 */
  onClosePress?: () => void
  closeLabel: string
}

export class CompatNoticeModal extends Modal {
  constructor(
    app: App,
    private readonly opts: CompatNoticeOptions,
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: this.opts.title })
    contentEl.createEl('p', { text: this.opts.body })
    if (this.opts.bullets && this.opts.bullets.length > 0) {
      const ul = contentEl.createEl('ul', { cls: 'dsh-modal-bullets' })
      for (const item of this.opts.bullets) {
        ul.createEl('li', { text: item })
      }
    }
    if (this.opts.danger) {
      contentEl.createEl('p', { text: this.opts.danger, cls: 'dsh-modal-danger' })
    }
    if (this.opts.detail) {
      contentEl.createEl('p', { text: this.opts.detail, cls: 'dsh-modal-detail' })
    }
    const row = new Setting(contentEl)
    row.addButton((b) => b.setButtonText(this.opts.closeLabel).onClick(() => {
      this.close()
      this.opts.onClosePress?.()
    }))
    for (const action of this.opts.actions) {
      row.addButton((b) => {
        b.setButtonText(action.label).onClick(() => {
          this.close()
          void action.onClick()
        })
        if (action.cta) b.setCta()
        return b
      })
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Obsidian DOM helper exemption ends here */
