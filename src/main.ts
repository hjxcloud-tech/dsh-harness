import { App, Modal, Notice, Plugin, Setting } from 'obsidian'
import { homedir } from 'node:os'
import { DshServiceManager, detectStartupCommand } from './service-manager'
import { DEFAULT_SETTINGS, DshSettingTab, type DshPluginSettings } from './settings'
import { DshView, DSH_VIEW_TYPE } from './view'
import { defaultCandidates, detectDshConfig, locateDshRepoDir } from './detector'
import { checkDshUpdates, pullDshUpdates, type UpdateCheckResult } from './updater'

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

export default class DshHarnessPlugin extends Plugin {
  settings: DshPluginSettings = DEFAULT_SETTINGS
  service!: DshServiceManager

  async onload(): Promise<void> {
    await this.loadSettings()
    this.buildService()

    this.registerView(DSH_VIEW_TYPE, (leaf) => new DshView(leaf, this))

    const ribbon = this.addRibbonIcon('bot', '打开 DeepSeek Harness', () => void this.openView())
    ribbon.addClass('dsh-ribbon')

    this.addCommand({
      id: 'open-dsh',
      name: '打开 DeepSeek Harness',
      callback: () => void this.openView(),
    })

    this.addSettingTab(new DshSettingTab(this.app, this))
    console.log('dsh-harness: loaded')
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
      this.app.workspace.revealLeaf(existing[0]!)
      return
    }
    const leaf = this.app.workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({ type: DSH_VIEW_TYPE, active: true })
    this.app.workspace.revealLeaf(leaf)
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
    const result = await detectDshConfig({ cwd: this.settings.startupCwd })
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
