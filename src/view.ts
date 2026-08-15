import { ItemView, WorkspaceLeaf } from 'obsidian'
import type DshHarnessPlugin from './main'

export const DSH_VIEW_TYPE = 'dsh-harness-view'

/** 把技术性错误消息转成用户能看懂的话。 */
function humanize(message: string): string {
  if (message.includes('未找到 DSH 仓库')) {
    return '还没有检测到 DeepSeek Harness，先安装一次吧。'
  }
  if (message.includes('无法连接 GitHub')) {
    return '连不上 GitHub，请检查网络后再试。'
  }
  if (message.includes('进程已退出')) {
    return 'DeepSeek Harness 启动失败了，请重新安装或检查设置。'
  }
  if (message.includes('超时')) {
    return 'DeepSeek Harness 启动有点慢，等一会儿再试试。'
  }
  if (message.includes('已关闭自动启动')) {
    return '服务没有运行，且已关闭自动启动，请在设置里打开。'
  }
  return message
}

export class DshView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: DshHarnessPlugin) {
    super(leaf)
  }

  getViewType(): string {
    return DSH_VIEW_TYPE
  }

  getDisplayText(): string {
    return 'DeepSeek Harness'
  }

  getIcon(): string {
    return 'bot'
  }

  async onOpen(): Promise<void> {
    this.addAction('refresh-cw', '重新加载', () => void this.refresh())
    await this.refresh()
  }

  async onClose(): Promise<void> {
    // 视图关闭不回收进程：进程生命周期由插件 onunload 管理
  }

  async refresh(): Promise<void> {
    this.contentEl.empty()
    this.renderLoading()
    const state = await this.plugin.service.ensureOnline()
    if (state.kind === 'online') {
      this.renderFrame()
      return
    }
    if (!this.plugin.isDshInstalled()) {
      this.renderInstallPrompt()
      return
    }
    this.renderError(state.kind === 'failed' ? state.message : '')
  }

  private renderLoading(): void {
    this.contentEl.addClass('dsh-view')
    const box = this.contentEl.createDiv({ cls: 'dsh-status' })
    box.createDiv({ cls: 'dsh-spinner' })
    box.createEl('p', { text: '正在连接 DeepSeek Harness 服务…' })
  }

  private renderFrame(): void {
    this.contentEl.empty()
    this.contentEl.addClass('dsh-view')
    const zoom = this.plugin.settings.zoom
    const wrapper = this.contentEl.createDiv({ cls: 'dsh-zoom' })
    wrapper.style.width = `calc(100% / ${zoom})`
    wrapper.style.height = `calc(100% / ${zoom})`
    wrapper.style.transform = `scale(${zoom})`
    const frame = wrapper.createEl('iframe', { cls: 'dsh-frame' })
    frame.src = `http://127.0.0.1:${String(this.plugin.settings.port)}/`
    frame.setAttribute('allow', 'clipboard-read; clipboard-write')
  }

  /** 未安装 DSH 时的一键安装引导。 */
  private renderInstallPrompt(): void {
    this.contentEl.empty()
    this.contentEl.addClass('dsh-view')
    const box = this.contentEl.createDiv({ cls: 'dsh-status' })
    box.createEl('h3', { text: '还没安装 DeepSeek Harness' })
    box.createEl('p', { text: '点一下自动安装：会自动下载 DeepSeek Harness 并配好一切，全程不用碰命令行。' })
    const btn = box.createEl('button', { cls: 'dsh-cta', text: '一键安装 DSH 本体' })
    btn.addEventListener('click', () => void this.installAndRefresh(btn))
  }

  /** 已安装但服务连不上时的错误视图（人话 + 重试/设置按钮）。 */
  private renderError(message: string): void {
    this.contentEl.empty()
    this.contentEl.addClass('dsh-view')
    const box = this.contentEl.createDiv({ cls: 'dsh-status' })
    box.createEl('h3', { text: '暂时打不开 DeepSeek Harness' })
    box.createEl('p', { text: humanize(message) })
    if (message) {
      box.createEl('p', { cls: 'dsh-detail', text: `原因：${message}` })
    }
    const row = box.createDiv({ cls: 'dsh-actions' })
    const retry = row.createEl('button', { text: '重试' })
    retry.addEventListener('click', () => void this.refresh())
    const settings = row.createEl('button', { text: '打开设置' })
    settings.addEventListener('click', () => {
      const settingApi = (this.app as unknown as {
        setting: { open: () => void; openTabById: (id: string) => void }
      }).setting
      settingApi.open()
      settingApi.openTabById('dsh-harness')
    })
  }

  private async installAndRefresh(btn: HTMLElement): Promise<void> {
    btn.setAttribute('disabled', '')
    btn.textContent = '安装中…（需要几分钟）'
    const ok = await this.plugin.installAndConfigure()
    btn.removeAttribute('disabled')
    if (ok) {
      btn.textContent = '安装完成，正在启动…'
      await this.refresh()
    } else {
      btn.textContent = '一键安装 DSH 本体'
    }
  }
}
