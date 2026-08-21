/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Obsidian APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { createEl, ItemView, Notice, WorkspaceLeaf } from 'obsidian'
import type DshHarnessPlugin from './main'
import { checkDeps, installDependency } from './installer'
import { getLocale, t } from './i18n'

export const DSH_VIEW_TYPE = 'dsh-harness-view'

/** 运行期探活间隔（毫秒）：面板打开时周期性探测 DSH 服务，崩溃后自动显示错误。 */
const MONITOR_INTERVAL_MS = 4000

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
    const ta = createEl('textarea', { cls: 'dsh-clipboard' })
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
  /** 可见性监听回调：系统睡眠/失焦恢复后强制重渲染 iframe。 */
  private onVisibilityChange: (() => void) | null = null

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
    // 睡眠/失焦恢复：iframe 内嵌的 DSH GUI 自带 WebSocket 自动重连（ConnectionController 退避重连），
    // 普通切窗（visibility 短暂隐藏再恢复）时连接大概率仍存活，无需重建 iframe；
    // 仅在 iframe 已不存在（如 monitor 探测离线后已切到「睡着了」视图）时重建。
    // 睡眠唤醒后若 iframe 空白，可点标题栏「重连」按钮，或等 monitor 探活兜底。
    this.onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && this.frame === null) {
        void this.refresh()
      }
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    await this.refresh()
  }

  // 新版 obsidian.d.ts（1.13.1）中 View.onClose 为 Promise<void>，须保持返回类型兼容
  onClose(): Promise<void> {
    this.stopMonitor()
    if (this.onVisibilityChange !== null) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
      this.onVisibilityChange = null
    }
    // 视图关闭不回收进程：进程生命周期由插件 onunload 管理
    return Promise.resolve()
  }

  /** 停止运行期探活定时器。 */
  private stopMonitor(): void {
    if (this.monitorTimer !== null) {
      window.clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
  }

  /**
   * 启动运行期探活：面板在线时周期性 TCP 探测。
   * 服务中途崩溃/断开 → 切到「睡着了」视图；定时器保持运行，
   * 服务恢复在线后自动重渲染 iframe（无需手动点「唤醒干活」）。
   */
  private startMonitor(): void {
    this.stopMonitor()
    this.monitorTimer = window.setInterval(() => {
      void this.plugin.service.probe().then((online) => {
        if (online) {
          // 服务已恢复：若当前未显示 iframe（沉睡/空白/加载中），自动刷新回在线视图
          if (this.frame === null) void this.refresh()
          return
        }
        // 服务离线：仅当面板仍显示 iframe 时才切换（避免重复清空已沉睡视图）
        if (this.frame !== null) {
          this.renderAsleep(t('view.monitor.disconnected', { msg: this.plugin.service.describeOffline() }))
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
    this.renderAsleep(state.kind === 'failed' ? state.message : '')
    // 离线视图也保持探活：服务恢复在线后自动回到 iframe 视图
    this.startMonitor()
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

  /** DSH 睡着了（等待重连）界面：插件名 + 状态说明 + 小提示 + 四按钮（唤醒干活 / AED / 问问AI / 更多设置）。 */
  private renderAsleep(message: string): void {
    this.contentEl.empty()
    this.contentEl.addClass('dsh-view')
    // 注意：Obsidian 的 removeClass/addClass 返回 void，不能链式调用（曾因此抛 TypeError 导致本视图空白）
    this.contentEl.removeClass('dsh-lang-zh')
    this.contentEl.removeClass('dsh-lang-en')
    this.contentEl.addClass('dsh-lang-' + getLocale())
    this.frame = null
    const box = this.contentEl.createDiv({ cls: 'dsh-status' })
    // 内容主体：垂直居中在页面视线中间
    const main = box.createDiv({ cls: 'dsh-asleep-main' })
    // 状态指示点：accent 呼吸（服务离线，等待唤醒）
    main.createDiv({ cls: 'dsh-asleep-dot' })
    main.createEl('h2', { cls: 'dsh-asleep-name', text: t('view.asleep.name') })
    main.createEl('p', { cls: 'dsh-asleep-status', text: t('view.asleep.status') })

    // 主操作：唤醒干活（拉长占一行）
    const primary = main.createDiv({ cls: 'dsh-actions dsh-asleep-primary' })
    const wake = primary.createEl('button', { cls: 'dsh-cta', text: t('view.asleep.wake') })
    wake.addEventListener('click', () => void this.refresh())

    // 次要操作：AED / 问问AI / 更多设置
    const secondary = main.createDiv({ cls: 'dsh-actions dsh-asleep-secondary' })
    const aed = secondary.createEl('button', { text: t('view.asleep.aed') })
    aed.addEventListener('click', () => void this.runAed(buttonBox))
    const askAi = secondary.createEl('button', { text: t('view.asleep.askAi') })
    askAi.addEventListener('click', () => void this.askAiAboutError(message, ''))
    const more = secondary.createEl('button', { text: t('view.asleep.more') })
    more.addEventListener('click', () => {
      const settingApi = (this.app as unknown as {
        setting: { open: () => void; openTabById: (id: string) => void }
      }).setting
      settingApi.open()
      settingApi.openTabById('dsh-harness')
    })

    // AED 确认 + 进度区（初始隐藏）
    const buttonBox = main.createDiv({ cls: 'dsh-asleep-aedbox' })

    // 小提示（放最下，贴底）
    box.createEl('p', { cls: 'dsh-detail dsh-asleep-hint', text: t('view.asleep.hint') })
  }

  /** AED for DSH：确认后执行抢救流水线，显示进度。 */
  private runAed(container: HTMLElement): void {
    // 清空旧确认/进度，重建
    container.empty()
    const box = container.createDiv({ cls: 'dsh-asleep-aed' })
    // 文案按 \n 拆成多段显示（textContent 会把换行折叠成空格）
    for (const line of t('view.asleep.aedConfirm').split('\n')) {
      box.createEl('p', { cls: 'dsh-detail', text: line })
    }

    const actions = box.createDiv({ cls: 'dsh-actions' })
    const cancel = actions.createEl('button', { text: t('view.asleep.aedCancel') })
    // 取消需整体移除容器（含边框/背景），否则会残留一个空文本框
    cancel.addEventListener('click', () => box.remove())
    const confirm = actions.createEl('button', { cls: 'dsh-cta', text: t('view.asleep.aedConfirmBtn') })
    confirm.addEventListener('click', () => {
      // 进度条
      box.empty()
      const progress = box.createDiv({ cls: 'dsh-progress' })
      const bar = progress.createDiv({ cls: 'dsh-progress-bar' })
      const progressText = progress.createDiv({ cls: 'dsh-progress-text' })
      const setProgress = (step: string, percent?: number): void => {
        progress.show()
        bar.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`
        progressText.textContent = step
      }
      progress.hide()
      setProgress(t('aed.running'), 0)

      const home = this.plugin.aedHomeDir()
      void this.plugin.runAedRecovery(home, setProgress).then((result) => {
        progressText.textContent = result.message
        if (result.ok) {
          new Notice(result.message, 8000)
        } else {
          new Notice(result.message, 12000)
        }
      })
    })
  }
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

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Obsidian-API exemption for non-type-aware review scans */
