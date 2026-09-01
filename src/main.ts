/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (os/path) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { addIcon, App, Editor, getLanguage, MarkdownView, Modal, Notice, Plugin, Setting } from 'obsidian'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyNoOpenAdaptive, DshServiceManager, detectStartupCommand, killPortOwner, probeNoOpenSupportAsync } from './service-manager'
import { DEFAULT_SETTINGS, DshSettingTab, type DshPluginSettings } from './settings'
import { migrateBridgeMode } from './bridge-mode'
import { DshView, DSH_VIEW_TYPE } from './view'
import { defaultCandidates, detectDshConfig, locateDshRepoDir } from './detector'
import { checkCliUpdate, checkDshUpdates, checkPluginUpdate, compareVersions, getCliDshVersion, getLocalDshVersion, pullCliUpdate, pullDshUpdates, type UpdateCheckResult } from './updater'
import { AUTO_FIXABLE_KINDS, aedRecovery, exitSafeMode as exitSafeModeTool, removeBundleDisableBlocks, runAedSafe as runAedSafeTool, verifyDshBootAsync, type BootFailureKind } from './aed'
import { AedBootModal } from './aed-modal'
import { UpdatingModal } from './install-progress-modal'
import { DEFAULT_DSH_REPO_URL, installDsh, startupCommandForInstall } from './installer'
import { resolveTargetSession, sendTextToSession } from './dsh-api'
import { StartupProfiler } from './startup-profiler'
import { hotkeyToPassthroughKey, isBridgeInstalled, writeBridgeFiles } from './bridge'
import { PluginChangelogModal } from './changelog'
import { buildBridgeMessage, countWords } from './source-tag'
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
  /** bridgeReady 对应的 iframe（面板重建后旧缓存失效，避免向无桥接的 frame 静默丢消息）。 */
  private bridgeReadyFrame: HTMLIFrameElement | null = null
  /** 「DSH 聊天框桥接到 Obsidian」= auto 时，document 级选区监听是否已注册。 */
  private autoSendRegistered = false
  /** 自动注入去抖定时器。 */
  private autoSendTimer: number | null = null
  /** 最近一次选区是否已由自动注入填充（空选区时据此清除聊天框，只保留最新）。 */
  private lastAutoInjected = false
  /** dsh-fill-ack 等待器（fill 成功回传后 resolve；超时 resolve false）。 */
  private fillAckResolvers: Array<() => void> = []
  /** 桥接重建失败冷却截止（ms）：期间不再重复整页重建，避免每次发送都等 ~3s。 */
  private bridgeReloadCooldownUntil = 0
  /** openView 副作用节流（启动打点 / 更新检查不每次打开都跑）。 */
  private lastProfilerCommit = 0
  private lastUpdateCheck = 0
  /** 启动耗时打点器（onload → 探测 → 启动 → 就绪；写入插件数据目录）。 */
  private profiler: StartupProfiler | null = null
  /** AED 启动校验的一次性修复守卫：同一轮 AED 流程内只允许弹窗修复一次，避免循环弹窗。 */
  private aedBootFixUsed = false

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
      editorCallback: (editor) => void this.sendSelectionToDsh(editor),
    })

    // 编辑器右键菜单：发送选中文字（Claudian 式交互）
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        menu.addItem((item) =>
          item
            .setTitle(t('menu.sendSelection'))
            .setIcon('send')
            .onClick(() => void this.sendSelectionToDsh(editor)),
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
        this.bridgeReadyFrame = frame
        // 把 Vault 根路径下发给注入脚本（用于「Vault 内路径点击 → Obsidian 打开」重定向）
        this.postToFrame(frame, { type: 'dsh-open-cfg', vaultRoot: this.vaultRoot() })
        // 下发快捷键透传配置（光标在 iframe 内时仍可触发 Obsidian 全局快捷键）
        this.postToFrame(frame, { type: 'dsh-kbd-cfg', keys: this.passthroughKeys() })
        // 桥接就绪：若为自动发送模式，同步注册选区监听（面板已开才工作）
        this.syncAutoSendRegistration()
      }
      if (data.type === 'dsh-fill-ack') {
        // 注入脚本确认文字已填入输入框：唤醒等待者（消除「已填入」假象）
        const resolvers = this.fillAckResolvers
        this.fillAckResolvers = []
        for (const resolve of resolvers) resolve()
      }
      if (data.type === 'dsh-open-in-obsidian' && typeof data.path === 'string' && data.path !== '') {
        // 桥接非「取消」时才在库内打开
        if (this.settings.bridgeToObsidian !== 'off') {
          this.openInBrowser(`obsidian://open?path=${encodeURIComponent(data.path)}`)
        }
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
    // 自动发送模式：面板已开（iframe 存在）才注册选区监听（设计：面板未开不注册）
    this.syncAutoSendRegistration()
  }

  /** 写入桥接文件；变更时提示需重启 DSH 服务生效。 */
  private installBridge(): void {
    const result = writeBridgeFiles()
    if (result.error) {
      console.warn('[dsh-harness] 桥接安装失败:', result.error)
      return
    }
    // patch 新增（changed）或插件脚本重写/自愈（pluginRewritten）都要提示
    if (result.changed || result.pluginRewritten) {
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
    if (result.changed || result.pluginRewritten) {
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
   * DSH 版本自适应（后台、非阻塞）：`dsh web --help` 实测约 8 秒，放到定时器里异步执行。
   * 双向处理 `--no-open`：
   * - 当前 dsh 支持（rc.7+）且启动命令缺 flag → 自动补上（避免启动/重启服务时自动拉起浏览器）；
   * - 不支持且命令含 flag → 自动移除并保存（避免 unknown option 启动失败）。
   * 探测结果在 service-manager 内缓存，后续 `dshSupportsNoOpen()` 直接命中缓存、零开销。
   */
  private ensureNoOpenAdaptive(): void {
    window.setTimeout(() => {
      probeNoOpenSupportAsync((supported) => {
        const next = applyNoOpenAdaptive(this.settings.startupCommand || '', supported)
        if (next === null) return
        this.settings.startupCommand = next
        void this.saveSettings()
        new Notice(supported ? t('notice.noOpenAdded') : t('notice.noOpenRemoved'), 8000)
      })
    }, 500)
  }

  /** 设置变更后重建 ServiceManager，使新配置立即生效。 */
  reconfigureService(): void {
    this.service?.dispose()
    this.buildService()
  }

  onunload(): void {
    this.unregisterAutoSend()
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
    // 启动打点：面板就绪后提交完整记录（节流：10s 内不重复写盘）
    this.profiler?.mark('panel-ready')
    const now = Date.now()
    if (now - this.lastProfilerCommit > 10000) {
      this.lastProfilerCommit = now
      this.profiler?.commit(true)
    }
    // 主动下发快捷键透传配置（不依赖 bridge-ready 时序；若桥接尚未就绪，其 keydown 请求会再触发下发）
    const frame = this.currentFrame()
    if (frame) {
      this.postToFrame(frame, { type: 'dsh-kbd-cfg', keys: this.passthroughKeys() })
    }
    // 打开面板后同步自动发送监听注册（面板已开才符合注册条件）
    this.syncAutoSendRegistration()
    // 打开面板/启动服务时自动检测 DSH 更新（节流：60s 内不重复检测）
    if (now - this.lastUpdateCheck > 60000) {
      this.lastUpdateCheck = now
      void this.checkUpdatesOnOpen()
    }
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

  // ---- 框选文字发送到 DSH（Claudian 式交互：选中 → 发送 → 智能体自动处理；隐式桥接注入，不发送原文）----

  /**
   * 把选中文字送进 DSH：生成桥接隐式信息行（位置/字数/路径，不显示原文）注入聊天框；
   * 桥接未就绪时降级为直接发送隐式行。
   * @param editor - 当前编辑器（提供选区位置）
   */
  async sendSelectionToDsh(editor: Editor | null): Promise<void> {
    if (this.settings.bridgeToObsidian === 'off') {
      new Notice(t('notice.bridgeOff'), 6000)
      return
    }
    const raw = (editor ? editor.getSelection() : '').trim()
    if (raw === '') {
      new Notice(t('notice.selectFirst'))
      return
    }
    // 生成注入文本：隐式信息行 + 隐式 prompt（含精确位置/字数/路径；不注入原文）
    const message = this.bridgeSendText(editor)
    if (message === '') {
      new Notice(t('notice.sendNoFile'), 6000)
      return
    }
    // 热路径：桥接已就绪且 frame 未变 → 跳过 probe/openView 直接注入（零等待）
    const hotFrame = this.hotReadyFrame()
    if (hotFrame) {
      await this.fillDraftAndNotify(hotFrame, message)
      return
    }
    const online = await this.service.probe()
    if (!online) {
      new Notice(t('notice.startingPanel'), 6000)
      await this.openView()
      // 等待服务就绪（最多 8s；openView 已触发启动），就绪后继续握手；否则提示稍后重试
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        if (await this.service.probe()) break
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
      if (!(await this.service.probe())) {
        new Notice(t('notice.notRunning'), 6000)
        return
      }
    }
    await this.openView() // 确保面板存在（拿到 iframe 引用）
    const frame = this.currentFrame()
    if (frame && (await this.ensureBridgeReady(frame))) {
      await this.fillDraftAndNotify(frame, message)
      return
    }
    // 桥接未就绪：重建面板并轮询重试握手一次，仍失败才降级直发。
    if (isBridgeInstalled() && (await this.reloadPanelAndWaitForBridge())) {
      const frame2 = this.currentFrame()
      if (frame2) {
        await this.fillDraftAndNotify(frame2, message)
        return
      }
    }
    // 降级：直接发送隐式行
    const target = await resolveTargetSession(this.settings.port)
    if (!target.ok) {
      new Notice(t('notice.sendFailed', { err: target.error }), 8000)
      return
    }
    const sent = await sendTextToSession(this.settings.port, target.value, message)
    if (!sent.ok) {
      new Notice(t('notice.sendFailed', { err: sent.error }), 8000)
      return
    }
    new Notice(t('notice.bridgeFallback'), 8000)
    if (this.settings.openPanelOnSend) {
      await this.openView()
    }
  }

  /** 桥接已就绪且 frame 未变（热路径）时返回该 frame，否则 null。 */
  private hotReadyFrame(): HTMLIFrameElement | null {
    const frame = this.currentFrame()
    if (!frame || !this.bridgeReady || this.bridgeReadyFrame !== frame) return null
    return frame
  }

  /** 向面板注入隐式行并等待 ACK：确认填入成功才提示「已填入」，否则提示页面仍在加载。 */
  private async fillDraftAndNotify(frame: HTMLIFrameElement, text: string): Promise<void> {
    this.postToFrame(frame, { type: 'dsh-fill-draft', text })
    this.lastAutoInjected = true
    const acked = await this.waitFillAck(1500)
    new Notice(acked ? t('notice.filled') : t('notice.fillPending'), 6000)
  }

  /** 等待注入脚本回传 dsh-fill-ack（fill 成功后），超时返回 false。 */
  private waitFillAck(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer = 0
      const done = (): void => {
        window.clearTimeout(timer)
        resolve(true)
      }
      timer = window.setTimeout(() => {
        this.fillAckResolvers = this.fillAckResolvers.filter((r) => r !== done)
        resolve(false)
      }, timeoutMs)
      this.fillAckResolvers.push(done)
    })
  }

  /** 由编辑器选区生成注入文本（仅隐式信息行；编辑指令由桥接插件的 pre-step 钩子隐藏注入，不占用聊天框）。 */
  private bridgeSendText(editor: Editor | null): string {
    return this.bridgeMessageFor(editor)
  }

  /** 由编辑器选区生成桥接隐式信息行（路径 + 精确行:列 + 字数）；无选区/无活动文件时返回空。 */
  private bridgeMessageFor(editor: Editor | null): string {
    try {
      if (!editor || !editor.somethingSelected()) {
        return ''
      }
      const from = editor.getCursor('from')
      const to = editor.getCursor('to')
      const selected = editor.getSelection()
      const file = this.app.workspace.getActiveFile()
      if (!file) return ''
      const base = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? ''
      const full = base === '' ? file.path : join(base, file.path)
      return buildBridgeMessage(full, { fromLine: from.line, fromCh: from.ch, toLine: to.line, toCh: to.ch }, countWords(selected))
    } catch {
      // 位置获取失败：返回空（调用方据此兜底，不发送）
      return ''
    }
  }

  /**
   * 同步「自动发送」选区监听注册：仅当「DSH 聊天框桥接到 Obsidian」= auto 且
   * DSH 面板已打开（iframe 存在）时注册 document 级选区监听（设计：面板未开不注册）。
   * 在设置变更、面板打开、桥接就绪时调用。
   */
  syncAutoSendRegistration(): void {
    const want = this.settings.bridgeToObsidian === 'auto' && this.currentFrame() !== null
    if (want === this.autoSendRegistered) return
    if (want) {
      document.addEventListener('mouseup', this.onDocSelection)
      document.addEventListener('keyup', this.onDocSelection)
      document.addEventListener('selectionchange', this.onDocSelection)
      this.autoSendRegistered = true
    } else {
      this.unregisterAutoSend()
    }
  }

  /** 无条件移除选区监听（onunload / 模式切换时调用）。 */
  private unregisterAutoSend(): void {
    if (!this.autoSendRegistered) return
    document.removeEventListener('mouseup', this.onDocSelection)
    document.removeEventListener('keyup', this.onDocSelection)
    document.removeEventListener('selectionchange', this.onDocSelection)
    this.autoSendRegistered = false
    if (this.autoSendTimer !== null) {
      window.clearTimeout(this.autoSendTimer)
      this.autoSendTimer = null
    }
  }

  /** 选区事件（去抖 150ms）：有选区自动注入隐式行；新选区替换旧内容；空选区清除。 */
  private readonly onDocSelection = (): void => {
    if (this.autoSendTimer !== null) {
      window.clearTimeout(this.autoSendTimer)
    }
    this.autoSendTimer = window.setTimeout(() => {
      this.autoSendTimer = null
      this.autoSendNow()
    }, 150)
  }

  /** 自动发送实际注入（仅 Markdown 编辑器；桥接未就绪/面板已关时跳过）。 */
  private autoSendNow(): void {
    const frame = this.currentFrame()
    if (!frame || !this.bridgeReady || this.settings.bridgeToObsidian !== 'auto') {
      return
    }
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor
    if (!editor) return
    if (!editor.somethingSelected()) {
      // 空选区：仅当先前由自动注入填充过才清除（避免误清用户手输内容）
      if (this.lastAutoInjected) {
        this.postToFrame(frame, { type: 'dsh-fill-draft', text: '' })
        this.lastAutoInjected = false
      }
      return
    }
    const message = this.bridgeSendText(editor)
    if (message === '') return
    this.postToFrame(frame, { type: 'dsh-fill-draft', text: message })
    this.lastAutoInjected = true
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

  /** 等待桥接就绪：先 ping，收到 ready 或超时返回（ready 状态与 frame 身份绑定，面板重建后自动失效）。 */
  private async ensureBridgeReady(frame: HTMLIFrameElement, timeoutMs = 1500): Promise<boolean> {
    if (this.bridgeReady && this.bridgeReadyFrame === frame) {
      return true
    }
    this.bridgeReady = false
    this.bridgeReadyFrame = null
    this.postToFrame(frame, { type: 'dsh-bridge-ping' })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.bridgeReady) {
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    return this.bridgeReady && this.bridgeReadyFrame === frame
  }

  /** 桥接未就绪时重建面板 iframe（加载带桥接脚本的新页面）并轮询等待握手就绪。 */
  private async reloadPanelAndWaitForBridge(totalMs = 3000): Promise<boolean> {
    // 失败冷却：30s 内不重复整页重建（避免每次发送都等重建+轮询）
    if (Date.now() < this.bridgeReloadCooldownUntil) {
      return false
    }
    await this.refreshView()
    const deadline = Date.now() + totalMs
    while (Date.now() < deadline) {
      const frame = this.currentFrame()
      if (frame && (await this.ensureBridgeReady(frame, 600))) {
        return true
      }
      await new Promise((resolve) => window.setTimeout(resolve, 200))
    }
    // 重建+轮询仍失败：进入 30s 冷却，期间不再重复重建
    this.bridgeReloadCooldownUntil = Date.now() + 30000
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

  /**
   * AED 动作（safe/clear/恢复）成功并重启服务后的统一收尾：
   * 校验 DSH 启动健康（页面注入 marker），失败时弹窗告知「错误类型 / 判断 / 建议动作」，
   * 询问用户是否执行一次性修复；修复后若仍为同类错误，不循环弹窗，提示改用其他 harness。
   * 校验与修复有耗时（页面抓取约数秒），以 Notice 提示用户。
   */
  private async aedFinishWithVerify(
    home: string,
    result: { ok: boolean; message: string },
  ): Promise<{ ok: boolean; message: string }> {
    if (!result.ok) return result
    new Notice(`${t('aed.bootVerify')} ${t('aed.takesTime')}`, 8000)
    const check = await verifyDshBootAsync(this.settings.port)
    if (check.ok) {
      return { ok: true, message: `${result.message} ${t('aed.bootVerifyOk')}` }
    }
    // 已尝试过一次修复：不再弹窗（避免同类错误循环），提示改用其他 harness
    if (this.aedBootFixUsed) {
      return { ok: false, message: `${result.message} ${t('aed.fix.fail')} ${t('aed.otherHarness')}` }
    }
    const kind: BootFailureKind = check.kind ?? 'other'
    new AedBootModal(this.app, {
      kind,
      detail: check.detail ?? '',
      autoFixable: AUTO_FIXABLE_KINDS.has(kind),
      onApply: async () => {
        this.aedBootFixUsed = true
        // 一次性修复：重建桥接补丁（自愈 dsh-fix 禁用块）+ 移除历史残留 bundle 禁用块，再重启并复验一次
        try {
          writeBridgeFiles(home)
        } catch {
          // 忽略：桥接写失败不阻断后续重启
        }
        try {
          removeBundleDisableBlocks(home)
        } catch {
          // 忽略
        }
        new Notice(t('notice.restarting'), 6000)
        this.killPortProcess()
        this.service?.dispose()
        this.buildService()
        const state = await this.service.ensureOnline()
        await this.refreshView()
        if (state.kind !== 'online') {
          new Notice(`${t('aed.fix.fail')} ${t('aed.otherHarness')}`, 12000)
          return
        }
        const again = await verifyDshBootAsync(this.settings.port)
        new Notice(again.ok ? t('aed.fix.done') : `${t('aed.fix.fail')} ${t('aed.otherHarness')}`, again.ok ? 8000 : 12000)
      },
    }).open()
    return result
  }

  /** 仅以安全模式启动（dsh-fix safe）；成功后重启 DSH 并校验启动健康。 */
  async runAedSafe(
    home: string,
  ): Promise<{ ok: boolean; message: string }> {
    this.aedBootFixUsed = false
    const result = await runAedSafeTool(home)
    if (result.ok) {
      new Notice(t('notice.restarting'), 6000)
      this.killPortProcess()
      this.service?.dispose()
      this.buildService()
      const state = await this.service.ensureOnline()
      await this.refreshView()
      if (state.kind !== 'online') {
        return { ok: false, message: result.message + ' ' + t('notice.restartFailed', { msg: state.message }) }
      }
      return this.aedFinishWithVerify(home, { ok: true, message: result.message + ' ' + t('notice.restarted') })
    }
    return result
  }

  /** 退出安全模式（dsh-fix clear 恢复用户插件），成功后重启 DSH 并校验启动健康。 */
  async runExitSafeMode(
    home: string,
  ): Promise<{ ok: boolean; message: string }> {
    this.aedBootFixUsed = false
    const result = await exitSafeModeTool(home)
    if (result.ok) {
      new Notice(t('notice.restarting'), 6000)
      this.killPortProcess()
      this.service?.dispose()
      this.buildService()
      const state = await this.service.ensureOnline()
      await this.refreshView()
      if (state.kind !== 'online') {
        return { ok: false, message: result.message + ' ' + t('notice.restartFailed', { msg: state.message }) }
      }
      return this.aedFinishWithVerify(home, { ok: true, message: result.message + ' ' + t('notice.restarted') })
    }
    return result
  }

  /** 执行 AED 抢救流水线（dsh-fix 安全模式），成功后重启 DSH 并校验启动健康。 */
  async runAedRecovery(
    home: string,
    onStep?: (step: string, percent?: number) => void,
  ): Promise<{ ok: boolean; message: string }> {
    this.aedBootFixUsed = false
    const result = await aedRecovery(home, undefined, onStep)
    if (result.ok) {
      // 安全模式成功后重启 DSH 服务
      new Notice(t('notice.restarting'), 6000)
      this.killPortProcess()
      this.service?.dispose()
      this.buildService()
      const state = await this.service.ensureOnline()
      await this.refreshView()
      if (state.kind !== 'online') {
        return { ok: false, message: result.message + ' ' + t('notice.restartFailed', { msg: state.message }) }
      }
      return this.aedFinishWithVerify(home, { ok: true, message: result.message + ' ' + t('notice.restarted') })
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

  /** 结束监听 DSH 端口的进程（复用 service-manager 的安全实现：精确端口匹配 + DSH 身份校验，避免误杀无关进程）。 */
  private killPortProcess(): void {
    killPortOwner(this.settings.port)
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
      // 默认用全局 CLI 稳定版（@latest=rc.2，无 alpha 浏览器认证门）；CLI 安装失败才回退仓库形态
      this.settings.startupCommand = startupCommandForInstall(r.cliOk === true)
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
        // 失败恢复：npm 更新失败时服务已被停，尽力拉回原版本服务，避免 DSH 离线
        const state = await this.service.ensureOnline()
        const recovered = state.kind === 'online'
        return {
          ok: false,
          message: recovered ? `${r.message}（已恢复原服务）` : `${r.message} ${t('notice.restartFailed', { msg: state.message })}`,
        }
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
      // 异常路径（如杀进程/重启抛错）同样尽力恢复旧服务
      void this.service.ensureOnline()
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
    // 迁移：≤1.9.4 的布尔 bridgeToObsidian → 三选项（true→auto / false→off），否则下拉无默认值
    const migrated = migrateBridgeMode(this.settings.bridgeToObsidian)
    if (migrated !== null) {
      this.settings.bridgeToObsidian = migrated
      await this.saveSettings()
    }
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
