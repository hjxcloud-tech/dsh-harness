import { ItemView, Notice, WorkspaceLeaf } from 'obsidian'
import type DshHarnessPlugin from './main'
import { checkDeps, installDependency } from './installer'
import { detectStartupCommand, renderCommand } from './service-manager'
import { t } from './i18n'

export const DSH_VIEW_TYPE = 'dsh-harness-view'

/** 运行期探活间隔（毫秒）：面板打开时周期性探测 DSH 服务，崩溃后自动显示错误。 */
const MONITOR_INTERVAL_MS = 4000

/** 未配置启动命令时的默认模板（与 main.ts 兜底保持一致）。 */
const DEFAULT_STARTUP_TEMPLATE = 'pnpm dsh web --port {port}'

/** 复制文本到剪贴板：Clipboard API 优先，失败降级 execCommand。successNotice 为空时用默认「命令已复制」。 */
async function copyText(text: string, successNotice?: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      new Notice(successNotice ?? t('view.copy.copied'))
      return
    }
  } catch {
    // Clipboard API 失败时降级到 execCommand
  }
  try {
    const ta = document.createElement('textarea')
    ta.className = 'dsh-clipboard'
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    new Notice(ok ? successNotice ?? t('view.copy.copied') : t('view.copy.failed'))
  } catch {
    new Notice(t('view.copy.failed'))
  }
}

/** 把技术性错误消息转成用户能看懂的话（中/英消息均识别）。 */
function humanize(message: string): string {
  if (message.includes('未找到 DSH 仓库') || message.includes('DSH repo not found')) {
    return t('hz.notFound')
  }
  if (message.includes('无法连接 GitHub') || message.includes('Cannot reach GitHub')) {
    return t('hz.github')
  }
  if (message.includes('进程已退出') || message.includes('Process exited')) {
    return t('hz.exited')
  }
  if (message.includes('超时') || message.includes('Timed out')) {
    return t('hz.timeout')
  }
  if (message.includes('已关闭自动启动') || message.includes('auto-start is off')) {
    return t('hz.noAuto')
  }
  return message
}

export class DshView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: DshHarnessPlugin) {
    super(leaf)
  }

  /** 运行期探活定时器：DSH 服务崩溃后自动切到错误视图（显示原因 + 重连）。 */
  private monitorTimer: number | null = null
  /** 当前渲染的 iframe（供插件发送 postMessage / 校验消息来源）。 */
  private frame: HTMLIFrameElement | null = null

  /** 当前 iframe 元素（可能未渲染完成）。 */
  getFrame(): HTMLIFrameElement | null {
    return this.frame
  }

  getViewType(): string {
    return DSH_VIEW_TYPE
  }

  getDisplayText(): string {
    return 'DeepSeek Harness'
  }

  getIcon(): string {
    return 'dsh-logo'
  }

  async onOpen(): Promise<void> {
    this.addAction('refresh-cw', t('view.action.reconnect'), () => void this.refresh())
    this.addAction('external-link', t('view.action.openBrowser'), () => this.plugin.openDshInBrowser())
    await this.refresh()
  }

  onClose(): void {
    this.stopMonitor()
    // 视图关闭不回收进程：进程生命周期由插件 onunload 管理
  }

  /** 停止运行期探活定时器。 */
  private stopMonitor(): void {
    if (this.monitorTimer !== null) {
      window.clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
  }

  /**
   * 启动运行期探活：面板在线时周期性 TCP 探测，
   * 服务中途崩溃/断开则立即切到错误视图（显示原因与重连按钮）。
   */
  private startMonitor(): void {
    this.stopMonitor()
    this.monitorTimer = window.setInterval(() => {
      void this.plugin.service.probe().then((online) => {
        if (!online && this.monitorTimer !== null) {
          this.stopMonitor()
          this.renderError(t('view.monitor.disconnected', { msg: this.plugin.service.describeOffline() }))
        }
      })
    }, MONITOR_INTERVAL_MS)
  }

  async refresh(): Promise<void> {
    this.stopMonitor()
    this.frame = null
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
    box.createEl('p', { text: t('view.loading.title') })
    box.createEl('p', { cls: 'dsh-detail', text: t('view.loading.detail') })
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
    this.frame = frame
    // 运行期探活：服务中途崩溃时自动切到错误视图
    this.startMonitor()
  }

  /** 未安装 DSH 时的一键安装引导（含依赖检测与一键安装）。 */
  private renderInstallPrompt(): void {
    this.contentEl.empty()
    this.contentEl.addClass('dsh-view')
    const box = this.contentEl.createDiv({ cls: 'dsh-status' })
    box.createEl('h3', { text: t('view.install.title') })
    box.createEl('p', { text: t('view.install.desc') })

    const deps = checkDeps()
    const depBox = box.createDiv({ cls: 'dsh-dep' })
    const mark = (ok: boolean): string => (ok ? t('view.install.mark.ok') : t('view.install.mark.missing'))
    depBox.createEl('p', { text: `git：${mark(deps.git)}` })
    depBox.createEl('p', { text: `Node.js：${mark(deps.node)}` })
    depBox.createEl('p', { text: `pnpm：${mark(deps.pnpm)}` })

    const btn = box.createEl('button', { cls: 'dsh-cta', text: t('view.install.btn') })
    btn.addEventListener('click', () => void this.installAndRefresh(btn, setProgress))

    // 一键安装进度条（隐藏，点击后显示）
    const progress = box.createDiv({ cls: 'dsh-progress', attr: { style: 'display:none' } })
    const bar = progress.createDiv({ cls: 'dsh-progress-bar' })
    const progressText = progress.createDiv({ cls: 'dsh-progress-text' })
    const setProgress = (percent: number, step: string): void => {
      progress.show()
      bar.style.width = `${Math.max(0, Math.min(100, percent))}%`
      progressText.textContent = step
    }

    if (!deps.git || !deps.node || !deps.pnpm) {
      box.createEl('p', { cls: 'dsh-detail', text: t('view.install.depsHint') })
      const miss = box.createDiv({ cls: 'dsh-actions' })
      if (!deps.git) {
        const b = miss.createEl('button', { text: t('view.install.git') })
        b.addEventListener('click', () => void this.installDep('git', b))
      }
      if (!deps.node) {
        const b = miss.createEl('button', { text: t('view.install.node') })
        b.addEventListener('click', () => void this.installDep('node', b))
      }
      if (!deps.pnpm) {
        const b = miss.createEl('button', { text: t('view.install.pnpm') })
        b.addEventListener('click', () => void this.installDep('pnpm', b))
      }
    }
  }

  /** 一键安装缺失依赖并刷新依赖状态。 */
  private async installDep(dep: 'git' | 'node' | 'pnpm', btn: HTMLElement): Promise<void> {
    btn.setAttribute('disabled', '')
    const orig = btn.textContent ?? ''
    btn.textContent = t('view.install.installing')
    const r = await installDependency(dep)
    btn.removeAttribute('disabled')
    btn.textContent = orig
    if (r.ok) {
      new Notice(t('view.install.done'), 8000)
      this.renderInstallPrompt()
    } else {
      new Notice(r.message, 10000)
    }
  }

  /** 已安装但服务连不上时的错误视图（人话 + 原因 + 手动启动命令示例 + 重试/浏览器/设置按钮）。 */
  private renderError(message: string): void {
    this.contentEl.empty()
    this.contentEl.addClass('dsh-view')
    const box = this.contentEl.createDiv({ cls: 'dsh-status' })
    box.createEl('h3', { text: t('view.error.title') })
    box.createEl('p', { text: humanize(message) })
    if (message) {
      box.createEl('p', { cls: 'dsh-detail', text: t('view.error.reason', { msg: message }) })
    }

    // 手动启动命令示例（复制即用）：与插件实际启动命令保持一致
    const template = this.plugin.settings.startupCommand || detectStartupCommand() || DEFAULT_STARTUP_TEMPLATE
    const { command, args } = renderCommand(template, this.plugin.settings.port)
    const cmdText = [command, ...args].join(' ')
    if (cmdText.trim() !== '') {
      box.createEl('p', { cls: 'dsh-detail', text: t('view.error.manual') })
      const cmdRow = box.createDiv({ cls: 'dsh-cmd-row' })
      cmdRow.createEl('code', { cls: 'dsh-cmd', text: cmdText })
      const copyBtn = cmdRow.createEl('button', { cls: 'dsh-cta dsh-copy', text: t('view.error.copy') })
      copyBtn.addEventListener('click', () => void copyText(cmdText))
    }

    const row = box.createDiv({ cls: 'dsh-actions' })
    const retry = row.createEl('button', { text: t('view.error.retry') })
    retry.addEventListener('click', () => void this.refresh())
    const askAi = row.createEl('button', { text: t('view.error.askAi') })
    askAi.addEventListener('click', () => void this.askAiAboutError(message, cmdText))
    const settings = row.createEl('button', { text: t('view.error.settings') })
    settings.addEventListener('click', () => {
      const settingApi = (this.app as unknown as {
        setting: { open: () => void; openTabById: (id: string) => void }
      }).setting
      settingApi.open()
      settingApi.openTabById('dsh-harness')
    })
  }

  /** 把当前报错拼成诊断文本，复制到剪贴板并打开 DeepSeek 网页版（chat.deepseek.com）粘贴求解。 */
  private async askAiAboutError(message: string, cmdText: string): Promise<void> {
    const diag =
      t('diag.header') + '\n' +
      t('diag.error') + (message || humanize(message)) + '\n' +
      t('diag.hint') + humanize(message) + '\n' +
      t('diag.port') + String(this.plugin.settings.port) + '\n' +
      t('diag.cwd') + (this.plugin.settings.startupCwd || '—') + '\n' +
      t('diag.command') + (cmdText.trim() !== '' ? cmdText : '—')
    // 网页版不支持 URL 预填：复制诊断 + 打开站点手动粘贴（Ctrl+V）
    await copyText(diag, t('notice.askAiCopied'))
    this.plugin.openInBrowser('https://chat.deepseek.com/')
  }

  /** 一键安装：先询问安装路径（用户意向），确认后执行并刷新视图；setProgress 可选用于显示进度条。 */
  private installAndRefresh(btn: HTMLElement, setProgress?: (percent: number, step: string) => void): void {
    btn.setAttribute('disabled', '')
    btn.textContent = t('view.install.preparing')
    const report = (step: string, percent?: number): void => {
      btn.textContent = percent != null ? `${step} ${percent}%` : step
      if (setProgress && percent != null) {
        setProgress(percent, step)
      }
    }
    void this.plugin.installWithPathPrompt(report).then((ok) => {
      btn.removeAttribute('disabled')
      if (ok) {
        btn.textContent = t('view.install.starting')
        void this.refresh()
      } else {
        btn.textContent = t('view.install.btn')
      }
    })
  }
}
