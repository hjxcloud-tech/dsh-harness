import { ItemView, WorkspaceLeaf } from 'obsidian'
import type DshHarnessPlugin from './main'
import { startupCommandHint } from './settings'

export const DSH_VIEW_TYPE = 'dsh-harness-view'

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
    } else {
      this.renderError(state.kind === 'failed' ? state.message : '')
    }
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

  private renderError(message: string): void {
    this.contentEl.empty()
    this.contentEl.addClass('dsh-view')
    const box = this.contentEl.createDiv({ cls: 'dsh-status' })
    box.createEl('h3', { text: '无法连接 DeepSeek Harness' })
    box.createEl('p', { text: message })
    box.createEl('p', { text: startupCommandHint() })
    const btn = box.createEl('button', { text: '重试' })
    btn.addEventListener('click', () => void this.refresh())
  }
}
