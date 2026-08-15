import { Plugin } from 'obsidian'
import { DshServiceManager, detectStartupCommand } from './service-manager'
import { DEFAULT_SETTINGS, DshSettingTab, type DshPluginSettings } from './settings'
import { DshView, DSH_VIEW_TYPE } from './view'

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

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
