import { App, Modal, Notice, Setting } from 'obsidian'
import { t } from './i18n'
import type { GeneratedCerts, TrustInstallResult } from './cert-gen'
import type DshHarnessPlugin from './main'

/**
 * v2.9.1「手机访问配置」三个弹窗 + 恢复默认确认弹窗（设置页快捷功能组 AED 之后一行）。
 *
 * 交互（见 `.temp/mobile-access-spec.md` §2/§11）：
 * - 行名右侧「使用说明」链接（用户主动点）→ {@link MobileAccessHelpModal}：场景 / 前置 / 会做什么 / 限制；
 * - 行内「生成并填入」→ {@link MobileAccessIntroModal}：风险红字 + 编号步骤，确认后才执行生成，
 *   成功接着弹 {@link MobileAccessDoneModal}（路径 + Windows 信任根 + iOS/安卓步骤 + 重启 CTA）；
 * - 行内「恢复默认」→ {@link MobileAccessResetModal}：确认后只回退四项设置，**不删证书文件、不撤销信任**。
 *
 * 风格全部复用既有 CSS 类（`dsh-aed-modal` / `dsh-modal-bullets` / `dsh-modal-danger` /
 * `dsh-modal-detail` / `dsh-symptoms-title`），本轮不新增样式。
 */

/** 把「\n 分点」的文案拆成条目（弹窗自己渲染成 li，文案里不带符号与 HTML）。 */
function bulletLines(key: string, vars?: Record<string, string | number>): string[] {
  return t(key, vars)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 多行段落（文件路径等）：逐行 <p>，避免 <p> 把 `\n` 折叠成空格。 */
function addParagraphs(contentEl: HTMLElement, key: string, vars: Record<string, string | number>, cls: string): void {
  for (const line of bulletLines(key, vars)) contentEl.createEl('p', { text: line, cls })
}

/** 小节标题 + 列表（ul 或 ol）；`itemCls` 用于前缀着色/加重（如风险段整条红字）。 */
function addList(
  contentEl: HTMLElement,
  titleKey: string,
  itemsKey: string,
  opts?: { ordered?: boolean; itemCls?: string },
): void {
  contentEl.createEl('p', { text: t(titleKey), cls: 'dsh-symptoms-title' })
  const list = contentEl.createEl(opts?.ordered === true ? 'ol' : 'ul', { cls: 'dsh-modal-bullets' })
  for (const line of bulletLines(itemsKey)) {
    list.createEl('li', opts?.itemCls !== undefined ? { text: line, cls: opts.itemCls } : { text: line })
  }
}

/** main 返回的错误码 / 原始 message → 本地化文案（spec §4：no-lan-address / desktop-missing 走 i18n）。 */
function mobileErrorText(error: string): string {
  if (error === 'busy') return t('mobile.err.busy')
  if (error.includes('no-lan-address')) return t('mobile.err.noLan')
  if (error.includes('desktop-missing')) return t('mobile.err.desktop')
  if (error.includes('custom-host')) return t('mobile.err.customHost')
  if (error.includes('custom-tls')) return t('mobile.err.customTls')
  return t('mobile.err.gen', { err: error })
}

/** 帮助弹窗：只在用户点行名右侧「使用说明」时出现，不新增任何自动弹出的路径。 */
export class MobileAccessHelpModal extends Modal {
  constructor(app: App) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-aed-modal')
    contentEl.createEl('h3', { text: t('mobile.help.title') })
    contentEl.createEl('p', { text: t('mobile.help.intro'), cls: 'dsh-modal-detail' })
    addList(contentEl, 'mobile.help.sceneTitle', 'mobile.help.scene')
    contentEl.createEl('p', { text: t('mobile.help.requires'), cls: 'dsh-modal-detail' })
    contentEl.createEl('p', { text: t('mobile.help.keepAwake'), cls: 'dsh-modal-detail' })
    addList(contentEl, 'mobile.help.does.title', 'mobile.help.does')
    addList(contentEl, 'mobile.help.tokenTitle', 'mobile.help.tokenFlow', { ordered: true })
    addList(contentEl, 'mobile.help.limits.title', 'mobile.help.limits')
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(t('compat.explain.close'))
        .setCta()
        .onClick(() => this.close()),
    )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/**
 * 预检弹窗：风险红字 + 将执行的编号步骤；确认按钮自己承担 loading 与结果分发
 * （成功 → 关本弹窗、弹 Done 弹窗；失败 → Notice，按钮复位可重试）。
 */
export class MobileAccessIntroModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: DshHarnessPlugin,
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-aed-modal')
    contentEl.createEl('h3', { text: t('mobile.intro.title') })
    contentEl.createEl('p', { text: t('mobile.intro.riskTitle'), cls: 'dsh-symptoms-title dsh-modal-danger' })
    // 风险清单整条红字（dsh-modal-danger 已是 error 色 + 加粗，句句都是后果，不做分级弱化）
    const risk = contentEl.createEl('ul', { cls: 'dsh-modal-bullets' })
    for (const line of bulletLines('mobile.intro.risk')) {
      risk.createEl('li', { text: line, cls: 'dsh-modal-danger' })
    }
    addList(contentEl, 'mobile.intro.stepsTitle', 'mobile.intro.steps', { ordered: true })
    contentEl.createEl('p', { text: t('mobile.intro.note'), cls: 'dsh-modal-detail' })
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t('mobile.intro.confirm'))
          .setCta()
          .onClick(async () => {
            b.setDisabled(true)
            b.setButtonText(t('settings.mobile.btnBusy'))
            const res = await this.plugin.generateMobileAccessConfig()
            if (!res.ok) {
              b.setDisabled(false)
              b.setButtonText(t('mobile.intro.confirm'))
              new Notice(mobileErrorText(res.error), 12000)
              return
            }
            this.close()
            new MobileAccessDoneModal(this.app, this.plugin, res.result, res.trust).open()
          }),
      )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/**
 * 成功弹窗：证书/私钥/rootCA 路径与覆盖的端点 → Windows 信任根 → iOS / 安卓两套安装步骤
 * → token 链接说明 → 底部「重启服务并生效」CTA /「稍后」。
 */
export class MobileAccessDoneModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: DshHarnessPlugin,
    private readonly result: GeneratedCerts,
    private readonly trust: TrustInstallResult,
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-aed-modal')
    contentEl.createEl('h3', { text: t('mobile.done.title') })
    addParagraphs(contentEl, 'mobile.done.files', {
      host: this.result.host,
      port: String(this.plugin.settings.port),
      cert: this.result.certPath,
      key: this.result.keyPath,
    }, 'dsh-modal-detail')
    contentEl.createEl('p', { text: t('mobile.done.rootCa', { root: this.result.rootCaPath }), cls: 'dsh-modal-detail' })
    // 电脑端信任：Windows 已自动装进当前用户 Root 就不必再操作；macOS/失败则给手动步骤（文案同时覆盖两个平台）。
    if (this.trust.ok) {
      contentEl.createEl('p', { text: t('mobile.done.windowsAuto') })
    } else {
      contentEl.createEl('p', { text: t('mobile.done.windows') })
      if (!this.trust.skipped) {
        contentEl.createEl('p', {
          text: t('mobile.done.trustFail', { err: this.trust.error ?? '' }),
          cls: 'dsh-modal-danger',
        })
      }
    }
    addList(contentEl, 'mobile.done.iosTitle', 'mobile.done.ios', { ordered: true })
    addList(contentEl, 'mobile.done.androidTitle', 'mobile.done.android', { ordered: true })
    contentEl.createEl('p', { text: t('mobile.done.nextToken'), cls: 'dsh-modal-detail' })
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText(t('mobile.done.later')).onClick(() => {
          this.close()
          new Notice(t('mobile.done.laterHint'), 10000)
        }),
      )
      .addButton((b) =>
        b
          .setButtonText(t('mobile.done.restart'))
          .setCta()
          .onClick(() => {
            b.setDisabled(true)
            this.close()
            void this.plugin.restartDshService()
          }),
      )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/**
 * 恢复默认确认弹窗（§11）：列出**当前实际**证书/私钥路径，写清「只回退设置、不删文件、不撤销信任」。
 * 当前已是默认值时设置页直接 Notice，不会打开本弹窗。
 */
export class MobileAccessResetModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      certPath: string
      keyPath: string
      onConfirm: () => void | Promise<void>
    },
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('dsh-aed-modal')
    contentEl.createEl('h3', { text: t('reset.title') })
    addParagraphs(contentEl, 'reset.body', {
      cert: this.opts.certPath !== '' ? this.opts.certPath : t('err.unknown'),
      key: this.opts.keyPath !== '' ? this.opts.keyPath : t('err.unknown'),
    }, 'dsh-modal-detail')
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t('reset.confirm'))
          .setCta()
          .onClick(async () => {
            b.setDisabled(true)
            this.close()
            await this.opts.onConfirm()
          }),
      )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
