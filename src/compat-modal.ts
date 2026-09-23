/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Obsidian DOM helpers (createEl/createSpan) are typed loosely in the review scanner's stub. */
/**
 * 「本机 DSH 与插件不适配 / 桥接未生效」启动提示框（v2.6.0）。
 *
 * 与 ConfirmModal 的区别：这里不是二选一的确认，而是**诊断 + 就地处置**——
 * 每个问题种类由调用方（main.checkCompatibility）决定给哪几个按钮，
 * 常见组合是「重新写入桥接」「重启服务」「查看说明」「今天不再提示」。
 * 「今天不再提示」写冷却台账（24h），未点它则下次启动仍会提醒（同一问题当日只弹一次由 shouldAlert 决定）。
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
  /** 主操作按钮（按问题种类给出）。 */
  actions: CompatAction[]
  /** 「今天不再提示」；不传则不显示该按钮。 */
  onMuteToday?: () => void
  /** 关闭（不做任何处置）。 */
  onClosePress?: () => void
  closeLabel: string
  muteLabel?: string
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
    const mute = this.opts.muteLabel
    if (this.opts.onMuteToday && mute) {
      row.addButton((b) => b.setButtonText(mute).onClick(() => {
        this.close()
        this.opts.onMuteToday?.()
      }))
    }
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
