/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (os/path) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { addIcon, App, getLanguage, Modal, Notice, Plugin, Setting } from 'obsidian'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DshServiceManager, detectStartupCommand, probeNoOpenSupportAsync } from './service-manager'
import { DEFAULT_SETTINGS, DshSettingTab, type DshPluginSettings } from './settings'
import { DshView, DSH_VIEW_TYPE } from './view'
import { defaultCandidates, detectDshConfig, locateDshRepoDir } from './detector'
import { checkCliUpdate, checkDshUpdates, checkPluginUpdate, compareVersions, getCliDshVersion, getLocalDshVersion, pullCliUpdate, pullDshUpdates, type UpdateCheckResult } from './updater'
import { aedRecovery, exitSafeMode as exitSafeModeTool, runAedSafe as runAedSafeTool } from './aed'
import { UpdatingModal } from './install-progress-modal'
import { DEFAULT_DSH_REPO_URL, installDsh } from './installer'
import { resolveTargetSession, sendTextToSession } from './dsh-api'
import { StartupProfiler } from './startup-profiler'
import { hotkeyToPassthroughKey, isBridgeInstalled, writeBridgeFiles } from './bridge'
import { PluginChangelogModal } from './changelog'
import { buildSourceTag } from './source-tag'
import { DSH_LOGO_SVG } from './icon'
import { applyLocale, t, type Locale } from './i18n'

/** Obsidian 风格确认对话框。 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      title: string
      body: string
      confirmText: string
      onConfirm: () => void | Promise<void>
      /** 可选的「查看/打开链接」操作（如查看 GitHub 更新内容）。 */
      viewLink?: { text: string; url: string }
    },
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: this.opts.title })
    contentEl.createEl('p', { text: this.opts.body })
    const s = new Setting(contentEl)
    s.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
    if (this.opts.viewLink) {
      s.addButton((b) =>
        b.setButtonText(this.opts.viewLink!.text).onClick(() => void window.open(this.opts.viewLink!.url, '_blank')),
      )
    }
    s.addButton((b) => b.setButtonText(this.opts.confirmText).setCta().onClick(async () => {
      this.close()
      await this.opts.onConfirm()
    }))
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** 询问安装目录的对话框（一键安装前确认用户意向路径）。 */
class InstallPathModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      title: string
      defaultPath: string
      onConfirm: (dir: string) => void
      onCancel: () => void
    },
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: this.opts.title })
    contentEl.createEl('p', { text: t('modal.installDesc') })
    const input = contentEl.createEl('input', { type: 'text', value: this.opts.defaultPath, cls: 'dsh-path-input' })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.close()
        this.opts.onConfirm(input.value)
      }
    })
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText(t('modal.cancel')).onClick(() => {
          this.close()
          this.opts.onCancel()
        }),
      )
      .addButton((b) =>
        b.setButtonText(t('modal.installStart')).setCta().onClick(() => {
          this.close()
          this.opts.onConfirm(input.value)
        }),
      )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

export default class DshHarnessPlugin extends Plugin {
  settings: DshPluginSettings = DEFAULT_SETTINGS
  service!: DshServiceManager
  /** DSH 前端桥接是否已就绪（注入脚本回报 ready 后置真）。 */
  private bridgeReady = false
  /** 启动耗时打点器（onload → 探测 → 启动 → 就绪；写入插件数据目录）。 */
  private profiler: StartupProfiler | null = null

  async onload(): Promise<void> {
    this.profiler = new StartupProfiler(this.manifest.dir ?? '.')
    this.profiler.mark('onload')
    await this.loadSettings()
    applyLocale(this.settings.language, this.settings.language === 'auto' ? this.detectSystemLanguage() : undefined)
    this.buildService()
    this.profiler.mark('settings-ready')

    // 注册 DeepSeek 官方鲸鱼图标（模块级 addIcon API，非 Plugin 方法——v1.0.7 曾误用 this.addIcon 导致加载崩溃）
    addIcon('dsh-logo', DSH_LOGO_SVG)

    this.registerView(DSH_VIEW_TYPE, (leaf) => new DshView(leaf, this))

    this.addRibbonIcon('dsh-logo', t('cmd.ribbon'), () => void this.openView())

    this.addCommand({
      id: 'open-dsh',
      name: t('cmd.openPanel'),
      callback: () => void this.openView(),
    })

    this.addCommand({
      id: 'send-selection-to-dsh',
      name: t('cmd.sendSelection'),
      editorCallback: (editor) => void this.sendSelectionToDsh(editor.getSelection()),
    })

    // 编辑器右键菜单：发送选中文字（Claudian 式交互）
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        menu.addItem((item) =>
          item
            .setTitle(t('menu.sendSelection'))
            .setIcon('send')
            .onClick(() => void this.sendSelectionToDsh(editor.getSelection())),
        )
      }),
    )

    // 监听 DSH 面板 iframe 回传的桥接就绪消息（仅接受来自面板 iframe 的消息）
    this.registerDomEvent(window, 'message', (event: MessageEvent) => {
      const frame = this.currentFrame()
      if (!frame || event.source !== frame.contentWindow) {
        return
      }
      const data = (event.data ?? {}) as { type?: string; path?: string; key?: string }
      if (data.type === 'dsh-bridge-ready') {
        this.bridgeReady = true
        // 把 Vault 根路径下发给注入脚本（用于「Vault 内路径点击 → Obsidian 打开」重定向）
        this.postToFrame(frame, { type: 'dsh-open-cfg', vaultRoot: this.vaultRoot() })
        // 下发快捷键透传配置（光标在 iframe 内时仍可触发 Obsidian 全局快捷键）
        this.postToFrame(frame, { type: 'dsh-kbd-cfg', keys: this.passthroughKeys() })
      }
      if (data.type === 'dsh-open-in-obsidian' && typeof data.path === 'string' && data.path !== '') {
        this.openInBrowser(`obsidian://open?path=${encodeURIComponent(data.path)}`)
      }
      if (data.type === 'dsh-kbd-shortcut' && typeof data.key === 'string') {
        this.executePassthroughShortcut(data.key)
      }
      if (data.type === 'dsh-kbd-request') {
        // 桥接请求快捷键配置（可能因时序错过首次下发）：立即重发
        this.postToFrame(frame, { type: 'dsh-kbd-cfg', keys: this.passthroughKeys() })
      }
    })

    this.addSettingTab(new DshSettingTab(this.app, this))

    // 静默安装 DSH 前端桥接文件（幂等；变更时提示重启 DSH）
    void this.installBridge()
    // DSH 版本自适应（后台非阻塞：`dsh web --help` 约 8 秒，不阻塞插件加载）
    this.ensureNoOpenAdaptive()
  }

  /** 写入桥接文件；变更时提示需重启 DSH 服务生效。 */
  private installBridge(): void {
    const result = writeBridgeFiles()
    if (result.error) {
      console.warn('[dsh-harness] 桥接安装失败:', result.error)
      return
    }
    if (result.changed) {
      new Notice(t('notice.bridgeInstalled'), 10000)
    }
  }

  /**
   * DSH 或插件更新后自动重写桥接文件：确保磁盘桥接代码与插件当前源码一致
   * （DSH 新版本可能改变注入机制；writeBridgeFiles 内置内容哈希保险，内容一致时不重写、幂等）。
   * 若桥接已安装但内容有变，提示重启 DSH 服务生效。
   */
  private rewriteBridgeAfterUpdate(): void {
    if (!isBridgeInstalled()) return
    const result = writeBridgeFiles()
    if (result.error) {
      console.warn('[dsh-harness] 更新后桥接重写失败:', result.error)
      return
    }
    if (result.changed) {
      new Notice(t('notice.bridgeRewritten'), 10000)
    }
  }

  /** 依据当前设置构造 ServiceManager。 */
  private buildService(): void {
    const basePath =
      (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? ''
    const startupCommand =
      this.settings.startupCommand || detectStartupCommand() || 'pnpm dsh web --port {port}'
    // 注意：此处不做 `--no-open` 支持探测——`dsh web --help` 实测约 8 秒，绝不能在同步加载/启动路径执行。
    // DSH 更新后的命令自适应由 onload 的后台探测（probeNoOpenSupportAsync）处理，见 ensureNoOpenAdaptive。
    const startupCwd = this.settings.startupCwd || basePath

    this.service = new DshServiceManager({
      port: this.settings.port,
      startupCommand,
      startupCwd,
      autoStart: this.settings.autoStart,
      detached: this.settings.detached,
      readyTimeoutMs: this.settings.readyTimeoutSec * 1000,
    })
  }

  /**
   * DSH 版本自适应（后台、非阻塞）：`dsh web --help` 实测约 8 秒，放到定时器里异步执行；
   * 若当前 dsh 不支持 `--no-open` 而启动命令仍含该 flag，自动移除并保存（避免 unknown option 启动失败）。
   * 探测结果在 service-manager 内缓存，后续 `dshSupportsNoOpen()` 直接命中缓存、零开销。
   */
  private ensureNoOpenAdaptive(): void {
    window.setTimeout(() => {
      probeNoOpenSupportAsync((supported) => {
        if (supported) return
        const cmd = this.settings.startupCommand || ''
        if (cmd.includes('--no-open')) {
          const cleaned = cmd.replace(/\s*--no-open\b/g, '').trim()
          this.settings.startupCommand = cleaned
          void this.saveSettings()
          new Notice(t('notice.noOpenRemoved'), 8000)
        }
      })
    }, 500)
  }

  /** 设置变更后重建 ServiceManager，使新配置立即生效。 */
  reconfigureService(): void {
    this.service?.dispose()
    this.buildService()
  }

  onunload(): void {
    this.service?.dispose()
  }

  async openView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DSH_VIEW_TYPE)
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0])
    } else {
      const leaf = this.app.workspace.getRightLeaf(false)
      if (!leaf) return
      await leaf.setViewState({ type: DSH_VIEW_TYPE, active: true })
      await this.app.workspace.revealLeaf(leaf)
    }
    // 启动打点：面板就绪后提交一次完整记录（首次打开/每次 openView 都提交，便于观察热路径）
    this.profiler?.mark('panel-ready')
    this.profiler?.commit(true)
    // 主动下发快捷键透传配置（不依赖 bridge-ready 时序；若桥接尚未就绪，其 keydown 请求会再触发下发）
    const frame = this.currentFrame()
    if (frame) {
      this.postToFrame(frame, { type: 'dsh-kbd-cfg', keys: this.passthroughKeys() })
    }
    // 打开面板/启动服务时自动检测 DSH 更新（发现新版本才弹窗，附 GitHub 更新内容链接）
    void this.checkUpdatesOnOpen()
  }

  /** 刷新已打开的面板视图（用于设置变更后重载界面）。 */
  async refreshView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(DSH_VIEW_TYPE)) {
      const view = leaf.view
      if (view instanceof DshView) {
        await view.refresh()
      }
    }
  }

  /** 一键检测本机 DSH 并应用启动配置。 */
  async detectAndApplyConfig(): Promise<void> {
    const result = detectDshConfig({ cwd: this.settings.startupCwd })
    if (result.found) {
      this.settings.startupCommand = result.startupCommand
      this.settings.startupCwd = result.startupCwd
      await this.saveSettings()
      this.reconfigureService()
      new Notice(result.message)
    } else {
      new Notice(result.message, 8000)
    }
  }

  /** 用系统默认浏览器打开任意 URL（electron shell.openExternal，失败降级新标签页）。 */
  openInBrowser(url: string): void {
    try {
      // Obsidian 渲染进程提供 require('electron')；openExternal 交由系统默认浏览器
      const requireFn = (window as unknown as { require?: (module: string) => unknown }).require
      if (requireFn) {
        const electron = requireFn('electron') as { shell?: { openExternal: (u: string) => Promise<unknown> } }
        if (electron.shell) {
          void electron.shell.openExternal(url)
          return
        }
      }
    } catch {
      // electron 不可用时降级为新标签页
    }
    window.open(url, '_blank')
  }

  /** 在系统默认浏览器中打开 DSH Web GUI。 */
  openDshInBrowser(): void {
    this.openInBrowser(`http://127.0.0.1:${String(this.settings.port)}/`)
  }

  /** 重连 DSH 服务：刷新所有已打开面板（重新探活并渲染）。 */
  async reconnectDsh(): Promise<void> {
    await this.refreshView()
    const online = this.isDshInstalled() ? await this.service.probe() : false
    new Notice(online ? t('notice.reconnected') : t('notice.notRunning'), 6000)
  }

  // ---- 框选文字发送到 DSH（Claudian 式交互：选中 → 发送 → 智能体自动处理）----

  /** 当前笔记的来源标签（设置开启时附加）。 */
  private sourceTag(): string {
    try {
      const file = this.app.workspace.getActiveFile()
      if (!file) {
        return ''
      }
      const base =
        (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? ''
      return buildSourceTag(file.path, base)
    } catch {
      return ''
    }
  }

  /**
   * 把选中文字送进 DSH：桥接就绪时填入输入框（可编辑后手动发送，不自动发送）；
   * 桥接未就绪时降级为直接发送（现状行为）。可选附带来源路径标签。
   */
  /**
   * 把选中文字送进 DSH：桥接就绪时填入输入框（可编辑后手动发送，不自动发送）；
   * 桥接未就绪时降级为直接发送（现状行为）。可选附带来源路径标签。
   * @param opts.noSourceTag - 为 true 时跳过来源标签（如自动发送报错诊断，与当前笔记无关）
   */
  async sendSelectionToDsh(raw: string, opts?: { noSourceTag?: boolean }): Promise<void> {
    const text = raw.trim()
    if (text === '') {
      new Notice(t('notice.selectFirst'))
      return
    }
    const tagged = this.settings.addSourceTag && !opts?.noSourceTag ? this.sourceTag() + text : text
    const online = await this.service.probe()
    if (!online) {
      new Notice(t('notice.startingPanel'), 6000)
      await this.openView()
      return
    }
    await this.openView() // 确保面板存在（拿到 iframe 引用）
    const frame = this.currentFrame()
    if (frame && (await this.ensureBridgeReady(frame))) {
      this.postToFrame(frame, { type: 'dsh-fill-draft', text: tagged })
      new Notice(t('notice.filled'), 6000)
      return
    }
    // 桥接未就绪：面板 iframe 可能停留在旧页面（DSH 重启/桥接补丁生效前已加载），
    // 桥接脚本不在页面里导致 ping 无应答——重建面板并轮询重试握手一次，仍失败才降级直发。
    if (isBridgeInstalled() && (await this.reloadPanelAndWaitForBridge())) {
      const frame2 = this.currentFrame()
      if (frame2) {
        this.postToFrame(frame2, { type: 'dsh-fill-draft', text: tagged })
        new Notice(t('notice.filled'), 6000)
        return
      }
    }
    // 降级：直接发送
    const target = await resolveTargetSession(this.settings.port)
    if (!target.ok) {
      new Notice(t('notice.sendFailed', { err: target.error }), 8000)
      return
    }
    const sent = await sendTextToSession(this.settings.port, target.value, tagged)
    if (!sent.ok) {
      new Notice(t('notice.sendFailed', { err: sent.error }), 8000)
      return
    }
    new Notice(t('notice.bridgeFallback'), 8000)
    if (this.settings.openPanelOnSend) {
      await this.openView()
    }
  }

  /** 当前 DSH 面板的 iframe（若面板打开且已渲染）。 */
  private currentFrame(): HTMLIFrameElement | null {
    for (const leaf of this.app.workspace.getLeavesOfType(DSH_VIEW_TYPE)) {
      const view = leaf.view
      if (view instanceof DshView) {
        const frame = view.getFrame()
        if (frame) {
          return frame
        }
      }
    }
    return null
  }

  /** 向面板 iframe 发送消息（限定 targetOrigin 为本机 DSH 端口）。 */
  private postToFrame(frame: HTMLIFrameElement, payload: Record<string, unknown>): void {
    const win = frame.contentWindow
    if (!win) {
      return
    }
    try {
      win.postMessage(payload, `http://127.0.0.1:${String(this.settings.port)}`)
    } catch {
      // 跨源/状态异常时静默（降级路径会兜底）
    }
  }

  /** 等待桥接就绪：先 ping，收到 ready 或超时返回。 */
  private async ensureBridgeReady(frame: HTMLIFrameElement, timeoutMs = 1500): Promise<boolean> {
    if (this.bridgeReady) {
      return true
    }
    this.bridgeReady = false
    this.postToFrame(frame, { type: 'dsh-bridge-ping' })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.bridgeReady) {
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    return this.bridgeReady
  }

  /** 桥接未就绪时重建面板 iframe（加载带桥接脚本的新页面）并轮询等待握手就绪。 */
  private async reloadPanelAndWaitForBridge(totalMs = 6000): Promise<boolean> {
    await this.refreshView()
    const deadline = Date.now() + totalMs
    while (Date.now() < deadline) {
      const frame = this.currentFrame()
      if (frame && (await this.ensureBridgeReady(frame, 800))) {
        return true
      }
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    }
    return false
  }

  /** 桥接状态摘要（设置页展示用）。 */
  getBridgeStatus(): { installed: boolean; ready: boolean } {
    return {
      installed: isBridgeInstalled(),
      ready: this.bridgeReady,
    }
  }

  /** 主动探测桥接是否已加载（设置页展示用）：向面板发 ping 并短暂等待 ready。 */
  async probeBridgeReady(): Promise<boolean> {
    const frame = this.currentFrame()
    if (!frame) {
      return false
    }
    return this.ensureBridgeReady(frame, 800)
  }

  /** DSH 主目录（传给 AED 工具的 $DSH_HOME 定位）。 */
  aedHomeDir(): string {
    return (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  }

  /** 仅以安全模式启动（dsh-fix safe）；成功后重启 DSH。 */
  async runAedSafe(
    home: string,
  ): Promise<{ ok: boolean; message: string }> {
    const result = await runAedSafeTool(home)
    if (result.ok) {
      new Notice(t('notice.restarting'), 6000)
      this.killPortProcess()
      this.service?.dispose()
      this.buildService()
      const state = await this.service.ensureOnline()
      await this.refreshView()
      if (state.kind === 'online') {
        return { ok: true, message: result.message + ' ' + t('notice.restarted') }
      }
      return { ok: false, message: result.message + ' ' + t('notice.restartFailed', { msg: state.message }) }
    }
    return result
  }

  /** 退出安全模式（dsh-fix clear 恢复用户插件），成功后重启 DSH。 */
  async runExitSafeMode(
    home: string,
  ): Promise<{ ok: boolean; message: string }> {
    const result = await exitSafeModeTool(home)
    if (result.ok) {
      new Notice(t('notice.restarting'), 6000)
      this.killPortProcess()
      this.service?.dispose()
      this.buildService()
      const state = await this.service.ensureOnline()
      await this.refreshView()
      if (state.kind === 'online') {
        return { ok: true, message: result.message + ' ' + t('notice.restarted') }
      }
      return { ok: false, message: result.message + ' ' + t('notice.restartFailed', { msg: state.message }) }
    }
    return result
  }

  /** 执行 AED 抢救流水线（dsh-fix 安全模式），成功后重启 DSH。 */
  async runAedRecovery(
    home: string,
    onStep?: (step: string, percent?: number) => void,
  ): Promise<{ ok: boolean; message: string }> {
    const result = await aedRecovery(home, undefined, onStep)
    if (result.ok) {
      // 安全模式成功后重启 DSH 服务
      new Notice(t('notice.restarting'), 6000)
      this.killPortProcess()
      this.service?.dispose()
      this.buildService()
      const state = await this.service.ensureOnline()
      await this.refreshView()
      if (state.kind === 'online') {
        return { ok: true, message: result.message + ' ' + t('notice.restarted') }
      }
      return { ok: false, message: result.message + ' ' + t('notice.restartFailed', { msg: state.message }) }
    }
    return result
  }

  /** 重启 DSH 服务（结束占用端口的进程——含常驻进程——后重新启动），用于加载桥接补丁。 */
  async restartDshService(): Promise<void> {
    new Notice(t('notice.restarting'), 6000)
    this.killPortProcess()
    this.service?.dispose()
    this.buildService()
    const state = await this.service.ensureOnline()
    new Notice(
      state.kind === 'online' ? t('notice.restarted') : t('notice.restartFailed', { msg: state.message }),
      state.kind === 'online' ? 6000 : 10000,
    )
  }

  /** 结束监听 DSH 端口的进程（netstat/lsof 找 PID 后终止）。 */
  private killPortProcess(): void {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
        const pids = new Set<string>()
        for (const line of out.split(/\r?\n/)) {
          if (line.includes(`:${String(this.settings.port)}`) && line.toUpperCase().includes('LISTENING')) {
            const parts = line.trim().split(/\s+/)
            const pid = parts[parts.length - 1]
            if (pid && pid !== '0') {
              pids.add(pid)
            }
          }
        }
        for (const pid of pids) {
          try {
            execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' })
          } catch {
            // 进程已退出
          }
        }
      } else {
        const out = execFileSync('lsof', ['-ti', `:${String(this.settings.port)}`], { encoding: 'utf8' })
        for (const pid of out.split(/\s+/).filter(Boolean)) {
          try {
            process.kill(Number(pid), 'SIGTERM')
          } catch {
            // 进程已退出
          }
        }
      }
    } catch {
      // 无 netstat/lsof 或端口无进程：忽略
    }
  }

  /** 一键安装 DSH 本体到指定目录并自动配置启动项；onStep 回调安装进度（step + 可选 percent）；返回是否成功。 */
  async installAndConfigure(dir: string, onStep?: (step: string, percent?: number) => void): Promise<boolean> {
    new Notice(t('notice.installing'))
    const r = await installDsh(dir, {
      cloneUrl: this.settings.installUrl || DEFAULT_DSH_REPO_URL,
      onStep,
    })
    if (r.ok && r.dir) {
      this.settings.installDir = r.dir
      this.settings.startupCwd = r.dir
      this.settings.startupCommand = 'pnpm dsh web --port {port}'
      await this.saveSettings()
      this.reconfigureService()
      new Notice(r.message, 8000)
      return true
    }
    new Notice(r.message, 10000)
    return false
  }

  /** 一键安装：已检测到 DSH 仓库时跳过路径询问，直接复用并补齐依赖/CLI；否则询问用户意向的安装路径后执行。 */
  async installWithPathPrompt(onStep?: (step: string, percent?: number) => void): Promise<boolean> {
    const detected = locateDshRepoDir(defaultCandidates(this.settings.startupCwd))
    // 已有 DSH 仓库：无需询问路径，直接复用（installDsh 会补齐缺失依赖与全局 CLI）
    if (detected) {
      const ok = await this.installAndConfigure(detected, onStep)
      return ok
    }
    const def = this.settings.installDir || detected || join(homedir(), 'deepseek-harness')
    return new Promise((resolve) => {
      new InstallPathModal(this.app, {
        title: t('modal.installTitle'),
        defaultPath: def,
        onConfirm: (dir) => {
          const d = dir.trim()
          if (!d) {
            new Notice(t('notice.installDirEmpty'), 6000)
            resolve(false)
            return
          }
          this.settings.installDir = d
          void this.saveSettings().then(() => {
            void this.installAndConfigure(d, onStep).then(resolve)
          })
        },
        onCancel: () => resolve(false),
      }).open()
    })
  }

  /** DSH 是否已安装（PATH 有 dsh 或检测到仓库目录）。 */
  isDshInstalled(): boolean {
    if (detectStartupCommand()) {
      return true
    }
    const candidates = defaultCandidates(this.settings.startupCwd, homedir())
    return locateDshRepoDir(candidates) !== null
  }

  /** DSH 状态摘要（设置页横幅/面板提示用）。 */
  async getDshStatus(): Promise<{ installed: boolean; version: string; online: boolean }> {
    const installed = this.isDshInstalled()
    const online = installed ? await this.service.probe() : false
    const version = installed ? await this.getDshVersion() : t('up.unknown')
    return { installed, version, online }
  }

  /** 读取当前 DSH 版本：全局 CLI 形态显示 `dsh --version`（实际运行版本），仓库形态显示仓库版本。 */
  async getDshVersion(): Promise<string> {
    if (this.startupUsesGlobalCli()) {
      const v = await getCliDshVersion()
      return v !== '' ? v : t('up.unknown')
    }
    const candidates = defaultCandidates(this.settings.startupCwd, homedir())
    const dir = locateDshRepoDir(candidates) ?? this.settings.startupCwd
    if (!dir) return t('up.unknown')
    return getLocalDshVersion(dir)
  }

  /** 检查 DSH 更新（按启动形态：全局 CLI 走 npm，仓库走 git）；发现新版本时询问用户是否更新。 */
  async checkUpdates(): Promise<void> {
    const result = this.startupUsesGlobalCli() ? await checkCliUpdate() : await this.checkRepoUpdate()
    if (result && result.state === 'behind') {
      this.askUpdate(result)
    } else if (result) {
      new Notice(result.message, 8000)
    }
  }

  /** 打开面板/启动服务时自动检测更新：仅当设置开启且发现新版本才弹窗提示（保持静默，避免每次打开都打扰）。 */
  async checkUpdatesOnOpen(): Promise<void> {
    if (!this.settings.autoCheckUpdates) return
    if (!this.isDshInstalled()) return
    const result = this.startupUsesGlobalCli() ? await checkCliUpdate() : await this.checkRepoUpdate()
    if (result && result.state === 'behind') {
      this.askUpdate(result)
    }
  }

  /** 仓库形态的更新检查（无仓库目录时返回 null）。 */
  private async checkRepoUpdate(): Promise<UpdateCheckResult | null> {
    const dir = this.resolveRepoDir()
    if (!dir) return null
    return checkDshUpdates(dir, undefined, { mirrorUrl: this.updateMirrorUrl() })
  }

  /** 启动形态对应的检查目标目录（仓库形态用）。 */
  private resolveRepoDir(): string {
    const candidates = defaultCandidates(this.settings.startupCwd, homedir())
    return locateDshRepoDir(candidates) ?? this.settings.startupCwd
  }

  /** 弹出确认对话框；确认后按启动形态执行更新（全局 CLI → npm i -g；仓库 → git pull --ff-only）。 */
  private askUpdate(info: UpdateCheckResult): void {
    // 预览版（rc）更新：标题与正文带风险警告（可能与插件冲突导致服务崩溃），确认后仍可更新
    const isPrerelease = info.prerelease === true
    new ConfirmModal(this.app, {
      title: isPrerelease ? t('modal.updatePrereleaseTitle') : t('modal.updateTitle'),
      body: isPrerelease ? t('modal.updatePrereleaseBody', { msg: info.message }) : t('modal.updateBody', { msg: info.message }),
      confirmText: t('modal.updateConfirm'),
      viewLink: { text: t('modal.updateViewChanges'), url: this.getDshReleasesUrl() },
      onConfirm: async () => {
        new Notice(t('notice.updating'), 6000)
        const r = this.startupUsesGlobalCli()
          ? await this.updateGlobalCli()
          : await pullDshUpdates(this.resolveRepoDir(), undefined, { mirrorUrl: this.updateMirrorUrl() })
        // DSH 更新成功后：重写桥接文件（DSH 新版本可能改变注入机制，确保桥接代码与插件当前源码一致；内容哈希保险幂等）
        if (r.ok) {
          this.rewriteBridgeAfterUpdate()
        }
        // 仓库更新 ≠ 运行版本更新：启动命令走全局 CLI 时补一句提示，避免「更新了没生效」的误解
        const hint = r.ok && this.startupUsesGlobalCli() ? ' ' + t('up.repoOnlyHint') : ''
        new Notice(r.message + hint, r.ok ? 6000 : 10000)
      },
    }).open()
  }

  /**
   * 更新全局 CLI（带状态弹窗）：先停止 DSH 服务释放文件锁（koffi.node 被运行进程占用会导致 npm EBUSY），
   * 再 npm i -g @deepseek-ai/dsh@latest（npmmirror 优先），成功后重启服务。
   */
  private async updateGlobalCli(): Promise<{ ok: boolean; message: string }> {
    const modal = new UpdatingModal(this.app)
    modal.open()
    try {
      this.killPortProcess()
      this.service?.dispose()
      this.buildService()
      const r = await pullCliUpdate()
      if (!r.ok) {
        modal.fail(r.message)
        return r
      }
      modal.setStatus(t('up.cliRestarting'))
      const state = await this.service.ensureOnline()
      modal.close()
      if (state.kind === 'online') {
        return { ok: true, message: r.message }
      }
      return { ok: false, message: r.message + ' ' + t('notice.restartFailed', { msg: state.message }) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      modal.fail(msg)
      return { ok: false, message: msg }
    }
  }

  /** 启动命令是否走全局 CLI（而非仓库 pnpm/npm 源码）：决定「仓库更新 ≠ 运行版本更新」提示。 */
  private startupUsesGlobalCli(): boolean {
    const cmd = (this.settings.startupCommand || detectStartupCommand()).trim().toLowerCase()
    return cmd.startsWith('dsh')
  }

  /** DSH GitHub releases 页面地址（供「查看更新内容/更新日志」使用）。 */
  getDshReleasesUrl(): string {
    const base = this.settings.installUrl || DEFAULT_DSH_REPO_URL
    return base.replace(/\.git$/, '') + '/releases'
  }

  /** 插件自身 GitHub releases 页面地址（插件更新日志）。 */
  getPluginReleasesUrl(): string {
    return `https://github.com/hjxcloud-tech/dsh-harness/releases`
  }

  /** 插件 GitHub 主页地址（使用反馈欢迎留言）。 */
  getPluginRepoUrl(): string {
    return `https://github.com/hjxcloud-tech/dsh-harness`
  }

  /** 插件在 Obsidian 官方商店的页面地址（检查更新/查看最新版本用）。 */
  getPluginStoreUrl(): string {
    return `https://community.obsidian.md/plugins/dsh-harness`
  }

  /** 检查插件自身更新：查插件 GitHub Release 最新版本，与本地比较——已最新弹提示；有新版弹确认框，确认后打开 Obsidian 商店页（应用内更新入口在 Obsidian 设置 → 第三方插件）。 */
  async checkPluginUpdates(): Promise<void> {
    const { remote, reachable } = await checkPluginUpdate()
    if (!reachable || remote === null) {
      new Notice(t('pluginUpdate.checkFail'), 8000)
      return
    }
    const local = this.manifest.version ?? ''
    if (compareVersions(local, remote) >= 0) {
      new Notice(t('pluginUpdate.latest', { v: local }), 6000)
      return
    }
    // 有新版：弹确认框，确认后打开商店页并提示应用内更新
    new ConfirmModal(this.app, {
      title: t('pluginUpdate.updateTitle'),
      body: t('pluginUpdate.updateBody', { local, remote }),
      confirmText: t('pluginUpdate.goStore'),
      onConfirm: () => {
        this.openInBrowser(this.getPluginStoreUrl())
        new Notice(t('pluginUpdate.storeHint'), 8000)
      },
    }).open()
  }

  /** 展示插件更新日志（内置弹窗，不跳转 GitHub）。 */
  showPluginChangelog(): void {
    new PluginChangelogModal(this.app).open()
  }

  /**
   * 读取 Obsidian 快捷键配置（对应设置页「选项 → 快捷键」），合并三个数据源：
   * ① commands.listCommands() 的 command.hotkeys（自定义快捷键，commandId 可用）
   * ② hotkeyManager.getDefaultHotkeys()（内置默认快捷键表，如 Ctrl+; → properties 命令）
   * ③ hotkeyManager.getHotkeys()（回退）
   * 返回 [组合键, commandId] 列表，如 ['ctrl+;', 'properties:add']。同键自定义优先（后写覆盖）。
   */
  passthroughKeyMap(): Array<{ key: string; commandId: string }> {
    const map = new Map<string, string>()
    const push = (hk: { modifiers?: string[]; key?: string } | undefined, commandId: string): void => {
      // Obsidian 'Mod' = Cmd(macOS)/Ctrl(其他)；统一归一，无修饰单键不透传
      const key = hk ? hotkeyToPassthroughKey(hk) : null
      if (key !== null) map.set(key, commandId)
    }
    // ② 内置默认快捷键（先填，自定义后覆盖）
    try {
      const defs = ((this.app as unknown as { hotkeyManager?: { getDefaultHotkeys?: () => Record<string, { hotkeys?: Array<{ modifiers?: string[]; key?: string }> }> } }).hotkeyManager?.getDefaultHotkeys?.() ?? {}) as Record<string, { hotkeys?: Array<{ modifiers?: string[]; key?: string }> }>
      for (const [commandId, entry] of Object.entries(defs)) {
        for (const hk of entry?.hotkeys ?? []) push(hk, commandId)
      }
    } catch {
      // 忽略
    }
    // ① 自定义快捷键（覆盖默认）
    try {
      const cmds = ((this.app as unknown as { commands?: { listCommands?: () => Array<{ id?: string; hotkeys?: Array<{ modifiers?: string[]; key?: string }> }> } }).commands?.listCommands?.() ?? []) as Array<{ id?: string; hotkeys?: Array<{ modifiers?: string[]; key?: string }> }>
      for (const cmd of cmds) {
        if (!cmd || typeof cmd.id !== 'string' || !cmd.id || !Array.isArray(cmd.hotkeys)) continue
        for (const hk of cmd.hotkeys) push(hk, cmd.id)
      }
    } catch {
      // 忽略
    }
    // ③ 回退：hotkeyManager.getHotkeys()
    if (map.size === 0) {
      try {
        const hotkeys = ((this.app as unknown as { hotkeyManager?: { getHotkeys?: () => Array<{ modifiers?: string[]; key?: string }> } }).hotkeyManager?.getHotkeys?.() ?? []) as Array<{ modifiers?: string[]; key?: string }>
        for (const hk of hotkeys) push(hk, '')
      } catch {
        // 忽略
      }
    }
    return [...map.entries()].map(([key, commandId]) => ({ key, commandId }))
  }

  /** 快捷键透传配置：从快捷键配置生成全部组合键列表（'ctrl+o' / 'ctrl+;' 等）。 */
  passthroughKeys(): string[] {
    if (!this.settings.shortcutPassthrough) return []
    return this.passthroughKeyMap().map((e) => e.key)
  }

  /** 把 iframe 内捕获的快捷键映射为 Obsidian 命令并执行：按组合键反查 commandId（来自命令自身的 hotkeys）。 */
  executePassthroughShortcut(key: string): void {
    try {
      const wanted = key.toLowerCase()
      const map = this.passthroughKeyMap()
      // 临时诊断：DevTools 排查快捷键透传（观察收到的 key 与匹配结果）
      console.warn('[dsh-harness] passthrough key =', key, '| 总快捷键数 =', map.length, '| 含目标 =', map.some((e) => e.key === wanted))
      const hit = map.find((e) => e.key === wanted)
      if (hit && hit.commandId !== '') {
        // @ts-expect-error -- obsidian.d.ts 1.13.1 未导出 commands 属性；运行时存在（executeCommandById 常用）
        void (this.app.commands as { executeCommandById?: (id: string) => void }).executeCommandById?.(hit.commandId)
        return
      }
      if (hit) {
        console.warn('[dsh-harness] 命中快捷键但缺 commandId（hotkeyManager 回退路径）：', wanted)
        return
      }
      console.warn('[dsh-harness] no matching hotkey for', wanted)
    } catch (err) {
      console.warn('[dsh-harness] passthrough error:', err)
    }
  }

  /** 更新用的只读镜像：设置项优先；留空时若安装地址来自 github.com 则自动包成 gh-proxy 镜像。 */
  private updateMirrorUrl(): string | undefined {
    const configured = this.settings.updateMirrorUrl.trim()
    if (configured !== '') return configured
    const base = this.settings.installUrl || DEFAULT_DSH_REPO_URL
    if (base.includes('github.com/')) return `https://gh-proxy.com/${base}`
    return undefined
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<DshPluginSettings> | undefined
    this.settings = { ...DEFAULT_SETTINGS, ...data }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  /** 读取最近启动打点记录（设置页诊断区）。 */
  getStartupRecords(): import('./startup-profiler').StartupRecord[] {
    return this.profiler?.readRecords() ?? []
  }

  /** 检测 Obsidian 界面语言（getLanguage()，zh* → 中文，其余/不可用 → English）。 */
  detectSystemLanguage(): Locale {
    try {
      const lang = (getLanguage as (() => string) | undefined)?.() ?? ''
      if (lang && lang.toLowerCase().startsWith('zh')) return 'zh'
    } catch {
      // 旧版本无 getLanguage 时按英文处理
    }
    return 'en'
  }

  /** Vault 根路径（DSH 工作区通常即此；用于路径点击的 Vault 内判定）。 */
  private vaultRoot(): string {
    return (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? ''
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
