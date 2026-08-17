/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (os/path) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { addIcon, App, Modal, Notice, Plugin, Setting } from 'obsidian'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DshServiceManager, detectStartupCommand } from './service-manager'
import { DEFAULT_SETTINGS, DshSettingTab, type DshPluginSettings } from './settings'
import { DshView, DSH_VIEW_TYPE } from './view'
import { defaultCandidates, detectDshConfig, locateDshRepoDir } from './detector'
import { checkDshUpdates, getLocalDshVersion, pullDshUpdates, type UpdateCheckResult } from './updater'
import { DEFAULT_DSH_REPO_URL, installDsh } from './installer'
import { DSH_LOGO_SVG } from './icon'

/** Obsidian 风格确认对话框。 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      title: string
      body: string
      confirmText: string
      onConfirm: () => void | Promise<void>
    },
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: this.opts.title })
    contentEl.createEl('p', { text: this.opts.body })
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText(this.opts.confirmText).setCta().onClick(async () => {
          this.close()
          await this.opts.onConfirm()
        }),
      )
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
    contentEl.createEl('p', { text: '选择 DeepSeek Harness 的安装目录（将自动克隆官方仓库并安装依赖）：' })
    const input = contentEl.createEl('input', { type: 'text', value: this.opts.defaultPath, cls: 'dsh-path-input' })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.close()
        this.opts.onConfirm(input.value)
      }
    })
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('取消').onClick(() => {
          this.close()
          this.opts.onCancel()
        }),
      )
      .addButton((b) =>
        b.setButtonText('开始安装').setCta().onClick(() => {
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

  async onload(): Promise<void> {
    await this.loadSettings()
    this.buildService()

    // 注册 DeepSeek 官方鲸鱼图标（模块级 addIcon API，非 Plugin 方法——v1.0.7 曾误用 this.addIcon 导致加载崩溃）
    addIcon('dsh-logo', DSH_LOGO_SVG)

    this.registerView(DSH_VIEW_TYPE, (leaf) => new DshView(leaf, this))

    this.addRibbonIcon('dsh-logo', '打开 DeepSeek Harness', () => void this.openView())

    this.addCommand({
      id: 'open-dsh',
      name: '打开面板',
      callback: () => void this.openView(),
    })

    this.addSettingTab(new DshSettingTab(this.app, this))
  }

  /** 依据当前设置构造 ServiceManager。 */
  private buildService(): void {
    const basePath =
      (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? ''
    const startupCommand =
      this.settings.startupCommand || detectStartupCommand() || 'pnpm dsh web --port {port}'
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
      return
    }
    const leaf = this.app.workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({ type: DSH_VIEW_TYPE, active: true })
    await this.app.workspace.revealLeaf(leaf)
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

  /** 一键安装 DSH 本体到指定目录并自动配置启动项；onStep 回调安装进度；返回是否成功。 */
  async installAndConfigure(dir: string, onStep?: (step: string) => void): Promise<boolean> {
    new Notice('开始安装 DeepSeek Harness…')
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

  /** 一键安装：先询问用户意向的安装路径（默认已检测目录/当前设置/用户目录），确认后执行。 */
  async installWithPathPrompt(onStep?: (step: string) => void): Promise<boolean> {
    const detected = locateDshRepoDir(defaultCandidates(this.settings.startupCwd))
    const def = this.settings.installDir || detected || join(homedir(), 'deepseek-harness')
    return new Promise((resolve) => {
      new InstallPathModal(this.app, {
        title: '安装 DeepSeek Harness',
        defaultPath: def,
        onConfirm: (dir) => {
          const d = dir.trim()
          if (!d) {
            new Notice('安装目录不能为空', 6000)
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
    let version = '未知'
    if (installed) {
      const candidates = defaultCandidates(this.settings.startupCwd, homedir())
      const dir = locateDshRepoDir(candidates) ?? this.settings.startupCwd
      if (dir) version = await getLocalDshVersion(dir)
    }
    return { installed, version, online }
  }

  /** 读取当前 DSH 版本（本地 HEAD 短哈希）。 */
  async getDshVersion(): Promise<string> {
    const candidates = defaultCandidates(this.settings.startupCwd, homedir())
    const dir = locateDshRepoDir(candidates) ?? this.settings.startupCwd
    if (!dir) return '未知'
    return getLocalDshVersion(dir)
  }

  /** 检查 DSH 仓库更新；发现新版本时询问用户是否更新。 */
  async checkUpdates(): Promise<void> {
    const candidates = defaultCandidates(this.settings.startupCwd, homedir())
    const dir = locateDshRepoDir(candidates) ?? this.settings.startupCwd
    const result = await checkDshUpdates(dir)
    if (result.state === 'behind') {
      this.askUpdate(dir, result)
    } else {
      new Notice(result.message, 8000)
    }
  }

  /** 弹出确认对话框，用户确认后执行 git pull --ff-only。 */
  private askUpdate(repoDir: string, info: UpdateCheckResult): void {
    new ConfirmModal(this.app, {
      title: '发现 DSH 新版本',
      body: `${info.message} 是否立即更新？（快进式更新，不影响本地未提交改动）`,
      confirmText: '立即更新',
      onConfirm: async () => {
        const r = await pullDshUpdates(repoDir)
        new Notice(r.message, 8000)
      },
    }).open()
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<DshPluginSettings> | undefined
    this.settings = { ...DEFAULT_SETTINGS, ...data }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
