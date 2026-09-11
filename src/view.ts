/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Obsidian APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { ItemView, Notice, WorkspaceLeaf } from 'obsidian'
import type DshHarnessPlugin from './main'
import { checkDeps, installDependency } from './installer'
import { InstallProgressModal } from './install-progress-modal'
import { getLocale, t } from './i18n'

export const DSH_VIEW_TYPE = 'dsh-harness-view'

/** 运行期探活间隔（毫秒）：面板打开时周期性探测 DSH 服务，崩溃后自动显示错误。 */
const MONITOR_INTERVAL_MS = 4000

/**
 * 冷启动就绪等待的时间预算（v2.4.0）：0.1.5 装了大量插件时冷启动常超过 60s，
 * 按次数（旧 6s×5≈30s）会在服务真正就绪前放弃，表现为"重启后必白屏、需手动刷新"。
 */
const READY_BUDGET_MS = 120000

/**
 * 可嵌入等待预算（v2.4.0）：0.1.2+ 冷启动期间每 800ms 轮询启动 token，最多等这么久。
 * 期间只显示插件自己的 loading 界面（不渲染 iframe），避免用户看到 401 白屏或"新页面"。
 */
const EMBED_WAIT_MS = 60000

/** 复制文本到剪贴板：Clipboard API 优先，失败降级 Electron clipboard（本插件仅桌面端）。successNotice 为空时用默认「命令已复制」。 */
async function copyText(text: string, successNotice?: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      new Notice(successNotice ?? t('view.copy.copied'))
      return
    }
  } catch {
    // Clipboard API 不可用时走 Electron 剪贴板（execCommand 已弃用，不再使用）
  }
  try {
    const requireFn = (window as unknown as { require?: (module: string) => unknown }).require
    const electron = requireFn
      ? requireFn('electron') as { clipboard?: { writeText: (t: string) => void } }
      : undefined
    if (electron?.clipboard) {
      electron.clipboard.writeText(text)
      new Notice(successNotice ?? t('view.copy.copied'))
      return
    }
  } catch {
    // Electron 剪贴板也不可用时报失败
  }
  new Notice(t('view.copy.failed'))
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
  /** v2.3.1 冷启动守卫：就绪检查定时器与重试计数（每次 refresh 归零）。 */
  private readyTimers: number[] = []
  private autoReloads = 0
  /** 当前 iframe 使用的嵌入地址（v2.4.0）：用于检测 token 换新并立即重载。 */
  private frameUrl = ''
  /** 冷启动等待的时间预算截止（v2.4.0）：按时间而非次数判定，0.1.5 冷启动可能 >60s。 */
  private readyDeadline = 0
  /** v2.4.0 冷启动等待横幅（代替白屏；就绪/超时后移除）。 */
  private waitCard: HTMLElement | null = null
  /** v2.3.1 认证拦截引导卡（已持有 token 仍起不来 = 典型 0.1.2+ 面板不可用态时覆盖显示）。 */
  private blockedCard: HTMLElement | null = null

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
      if (document.visibilityState !== 'visible') return
      if (this.frame === null) {
        void this.refresh()
        return
      }
      // 由隐藏转可见：跨域 iframe 可能没重绘 → 轻推一次（不重载，避免打断已就绪的面板）
      this.nudgeRepaint(this.frame)
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

  /** 停止运行期探活定时器与冷启动就绪检查。 */
  private stopMonitor(): void {
    if (this.monitorTimer !== null) {
      window.clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    for (const id of this.readyTimers) window.clearTimeout(id)
    this.readyTimers = []
  }

  /**
   * v2.3.1 冷启动守卫：TCP 监听 ≠ 页面就绪（dsh 源码冷启动 20–60s），iframe 可能在服务
   * 半就绪时加载成空白。桥接握手（tapIndex 注入随 index 页一起到达）超时未就绪 → 自动重载。
   *
   * v2.4.0 加固（修「重启服务后必白屏、要手动刷新一次」）：
   * ① 认证链接（token）一变就立即用新链接重载并重置预算——冷启动时先加载的是裸地址（0.1.2+ 必 401 白屏），
   *    服务打印 token 后必须换到带 token 的嵌入地址；
   * ② 预算从"次数"（6s×5≈30s）改为**时间**（2 分钟）+ 退避：0.1.5 装了大量插件时冷启动常超过 30s，
   *    次数预算会提前放弃、只能手动刷新；
   * ③ 等待期盖一条顶部横幅（而不是让用户对着 401 白屏）；只有"已持有 token 仍起不来"（真正的认证拦截）
   *    或超时后才盖认证引导卡。
   */
  private scheduleReadyCheck(delayMs: number): void {
    const id = window.setTimeout(() => {
      this.readyTimers = this.readyTimers.filter((t) => t !== id)
      if (!this.frame) return
      if (this.plugin.getBridgeStatus().ready) {
        this.removeBlockedHint()
        this.removeWaitBanner()
        return
      }
      const freshUrl = this.plugin.dshEmbedFrameUrl()
      // token 换新（冷启动打印出来 / 服务重启换了 token）：立即切到带 token 的嵌入地址并重置预算
      if (freshUrl !== this.frameUrl) {
        this.frameUrl = freshUrl
        this.autoReloads = 0
        this.readyDeadline = Date.now() + READY_BUDGET_MS
        this.frame.src = `${freshUrl}#r${String(Date.now())}`
        this.scheduleReadyCheck(3000)
        return
      }
      // 超时仍起不来：盖认证引导卡（含「在浏览器打开」），停止重试
      if (Date.now() > this.readyDeadline) {
        this.removeWaitBanner()
        this.renderBlockedHint()
        return
      }
      // 仍在冷启动/半就绪：盖**全覆盖**等待层（挡住 0.1.2+ 裸地址的 401 文本，不再白屏），
      // 并定期重载重试（cache-bust），直到桥接就绪或超时
      this.renderWaitBanner()
      this.autoReloads += 1
      if (this.autoReloads % 3 === 0) {
        this.frame.src = `${freshUrl}#r${String(Date.now())}`
      }
      const backoff = Math.min(3000 + this.autoReloads * 1500, 12000)
      this.scheduleReadyCheck(backoff)
    }, delayMs)
    this.readyTimers.push(id)
  }

  /** 冷启动等待层（全覆盖，挡住 401/空白；就绪后移除）。 */
  private renderWaitBanner(): void {
    if (this.waitCard !== null || !this.contentEl.isConnected) return
    const card = this.contentEl.createDiv({ cls: 'dsh-wait-card' })
    card.createEl('h3', { text: t('view.wait.title') })
    card.createEl('p', { text: t('view.wait.desc') })
    const retry = card.createEl('button', { text: t('view.blocked.retry') })
    retry.addEventListener('click', () => {
      this.removeWaitBanner()
      void this.refresh()
    })
    this.waitCard = card
  }

  private removeWaitBanner(): void {
    if (this.waitCard === null) return
    this.waitCard.remove()
    this.waitCard = null
  }

  /**
   * 容器尺寸由 0 变为可用后重载一次 iframe（v2.4.0）。
   * 场景：视图刚打开/叶子尚未显示时文档已加载完成，但 0 尺寸下不会绘制 →
   * 表现为「DSH 加载完成后白屏，手动刷新一次才显示」。最多等 15s，仅在尺寸就绪的瞬间重载一次。
   */
  private reloadWhenSized(frame: HTMLIFrameElement): void {
    const deadline = Date.now() + 15000
    const tick = (): void => {
      if (this.frame !== frame) return
      if (this.contentEl.clientWidth >= 2 && this.contentEl.clientHeight >= 2) {
        this.frameUrl = this.plugin.dshEmbedFrameUrl()
        frame.src = `${this.frameUrl}#r${String(Date.now())}`
        this.autoReloads = 0
        this.readyDeadline = Date.now() + READY_BUDGET_MS
        this.scheduleReadyCheck(3000)
        return
      }
      if (Date.now() > deadline) return
      window.setTimeout(tick, 300)
    }
    window.setTimeout(tick, 300)
  }

  /**
   * 跨域 iframe 重绘轻推（v2.4.0）：Electron 里嵌 cross-origin iframe 偶发"已加载但不绘制"，
   * 做一次 1px 级尺寸变化即可强制合成器重排（比整页重载温和，不会丢已就绪的面板状态）。
   */
  private nudgeRepaint(frame: HTMLIFrameElement): void {
    try {
      const prev = frame.style.height
      frame.style.height = 'calc(100% - 1px)'
      window.setTimeout(() => {
        frame.style.height = prev
      }, 60)
    } catch {
      // 元素已销毁：忽略
    }
  }

  /** 移除认证拦截引导卡。 */
  private removeBlockedHint(): void {
    if (this.blockedCard === null) return
    this.blockedCard.remove()
    this.blockedCard = null
  }

  /**
   * v2.3.1：认证拦截引导卡——0.1.2+ 的 Strict cookie 令内嵌面板无法登录（插件端无解，已实测），
   * 与其让用户对着 401 文本发懵，盖一张引导卡：一键「在浏览器打开 DSH」（自动携带认证链接）。
   */
  private renderBlockedHint(): void {
    if (this.blockedCard !== null || !this.contentEl.isConnected) return
    const card = this.contentEl.createDiv({ cls: 'dsh-blocked-card' })
    card.createEl('h3', { text: t('view.blocked.title') })
    card.createEl('p', { text: t('view.blocked.desc') })
    const actions = card.createDiv({ cls: 'dsh-blocked-actions' })
    const browser = actions.createEl('button', { cls: 'mod-cta', text: t('view.blocked.openBrowser') })
    browser.addEventListener('click', () => this.plugin.openDshInBrowser())
    const retry = actions.createEl('button', { text: t('view.blocked.retry') })
    retry.addEventListener('click', () => {
      this.removeBlockedHint()
      void this.refresh()
    })
    this.blockedCard = card
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
    this.autoReloads = 0
    this.frame = null
    this.contentEl.empty()
    this.renderLoading()
    const state = await this.plugin.service.ensureOnline()
    if (state.kind === 'online') {
      // v2.4.0：在线 ≠ 面板可嵌入。0.1.2+ 需要启动认证链接（token）才能内嵌——
      // 拿不到就先**只保留插件自己的 loading 界面**（不渲染 iframe，避免白屏/401 文本），
      // 待 token 出现再渲染；旧版（不需要认证）直接渲染。
      if (await this.plugin.service.panelNeedsAuth()) {
        await this.waitEmbedReady()
      }
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

  /**
   * 等待可嵌入条件（v2.4.0）：0.1.2+ 必须等启动 token 打印出来（冷启动 20–60s）。
   * 期间界面停留在插件的 loading 态；超时后照常渲染（由冷启动守卫继续兜底）。
   */
  private async waitEmbedReady(): Promise<void> {
    const deadline = Date.now() + EMBED_WAIT_MS
    while (Date.now() < deadline) {
      if (!this.contentEl.isConnected) return
      if (this.plugin.dshEmbedFrameUrl().includes('token=')) return
      await new Promise((resolve) => window.setTimeout(resolve, 800))
    }
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
    // 引导卡/等待横幅随 contentEl 一起被清空：复位引用，允许下一轮需要时重新渲染
    this.blockedCard = null
    this.waitCard = null
    this.contentEl.addClass('dsh-view')
    const zoom = this.plugin.settings.zoom
    // 底部视觉垫高（px，设置项 0–30，默认 20）：避免 DSH 界面底部内容（统计行）被 Obsidian 状态栏遮挡。
    // 容器按 1/zoom 反算布局尺寸后 scale(zoom)，视觉高度 = 100% - pad，底部留出空隙。
    const bottomPadPx = this.plugin.settings.bottomPadPx
    const wrapper = this.contentEl.createDiv({ cls: 'dsh-zoom' })
    wrapper.style.width = `calc(100% / ${zoom})`
    wrapper.style.height = `calc(100% / ${zoom} - ${bottomPadPx / zoom}px)`
    wrapper.style.transform = `scale(${zoom})`
    const frame = wrapper.createEl('iframe', { cls: 'dsh-frame' })
    this.frameUrl = this.plugin.dshEmbedFrameUrl()
    frame.src = this.frameUrl
    frame.setAttribute('allow', 'clipboard-read; clipboard-write')
    this.frame = frame
    // v2.4.0 白屏修复（「首次打开、DSH 加载完成后白屏，手动刷新才好」）：
    // 视图刚开时容器常常还是 0 尺寸/未布局，此时文档虽加载完成也不会绘制；
    // 另在 Electron 里跨域 iframe 偶发不重绘。两者都用"尺寸就绪后重载一次 + 加载后轻推重绘"兜住。
    const zeroSized = this.contentEl.clientWidth < 2 || this.contentEl.clientHeight < 2
    let nudged = false
    frame.addEventListener('load', () => {
      if (nudged) return
      nudged = true
      window.setTimeout(() => {
        if (this.frame !== frame || this.plugin.getBridgeStatus().ready) return
        this.nudgeRepaint(frame)
      }, 400)
    })
    if (zeroSized) this.reloadWhenSized(frame)
    // 运行期探活：服务中途崩溃时自动切到错误视图
    this.startMonitor()
    // v2.3.1/v2.4.0：冷启动守卫——6s 后检查桥接握手；按时间预算持续等待（不再按次数提前放弃），
    // token 变化立即换链接，等待期用顶部横幅代替白屏
    this.autoReloads = 0
    this.readyDeadline = Date.now() + READY_BUDGET_MS
    this.scheduleReadyCheck(6000)
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
    // 安装进度经 InstallProgressModal 弹窗展示（步骤打勾 + 进度条），引导页不再内嵌进度条
    btn.addEventListener('click', () => void this.installAndRefresh(btn))

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

  /** 一键安装：先询问安装路径（用户意向），确认后执行并刷新视图；进度经 InstallProgressModal 弹窗展示。 */
  private installAndRefresh(btn: HTMLElement): void {
    btn.setAttribute('disabled', '')
    btn.textContent = t('view.install.preparing')
    const modal = new InstallProgressModal(this.app)
    modal.open()
    const report = (step: string, percent?: number): void => {
      modal.update(percent ?? 0, step)
    }
    void this.plugin.installWithPathPrompt(report).then((ok) => {
      btn.removeAttribute('disabled')
      if (ok) {
        modal.done()
        window.setTimeout(() => modal.close(), 1500)
        btn.textContent = t('view.install.starting')
        void this.refresh()
      } else {
        modal.fail()
        btn.textContent = t('view.install.btn')
      }
    })
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Obsidian-API exemption for non-type-aware review scans */
