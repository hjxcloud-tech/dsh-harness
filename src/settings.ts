import { App, PluginSettingTab, Setting } from 'obsidian'
import type DshHarnessPlugin from './main'

export interface DshPluginSettings {
  port: number
  startupCommand: string
  startupCwd: string
  autoStart: boolean
  detached: boolean
  zoom: number
}

export const DEFAULT_SETTINGS: DshPluginSettings = {
  port: 3080,
  startupCommand: '',
  startupCwd: '',
  autoStart: true,
  detached: false,
  zoom: 1,
}

export function startupCommandHint(): string {
  return '示例：pnpm dsh web --port {port}（{port} 自动替换为端口；若 dsh 在 PATH 中可留空自动探测；用 pnpm 启动时请把工作目录设为 DSH 仓库路径）'
}

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DshHarnessPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl('h2', { text: 'DeepSeek Harness' })

    new Setting(containerEl)
      .setName('服务端口')
      .setDesc('DSH Web GUI 监听端口，默认 3080')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.port)).onChange(async (v) => {
          const n = Number(v)
          if (Number.isInteger(n) && n > 0 && n <= 65535) {
            this.plugin.settings.port = n
            await this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
          }
        }),
      )

    new Setting(containerEl)
      .setName('启动命令')
      .setDesc(startupCommandHint())
      .addText((t) =>
        t.setValue(this.plugin.settings.startupCommand).onChange(async (v) => {
          this.plugin.settings.startupCommand = v.trim()
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName('工作目录')
      .setDesc('启动 DSH 时的工作目录（DSH 工作区）；留空为 Vault 根目录')
      .addText((t) =>
        t.setValue(this.plugin.settings.startupCwd).onChange(async (v) => {
          this.plugin.settings.startupCwd = v.trim()
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName('离线时自动启动')
      .setDesc('打开面板时若端口无服务，自动运行启动命令')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoStart).onChange(async (v) => {
          this.plugin.settings.autoStart = v
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName('进程独立常驻')
      .setDesc('开启后，插件启动的 DSH 进程在 Obsidian 退出后继续运行（默认关闭：随 Obsidian 退出而终止）')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.detached).onChange(async (v) => {
          this.plugin.settings.detached = v
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName('一键检测配置')
      .setDesc('自动扫描本机 DeepSeek Harness（PATH 或常见目录）并填充启动命令与工作目录')
      .addButton((b) =>
        b.setButtonText('检测并填充').onClick(async () => {
          b.setDisabled(true)
          b.setButtonText('检测中…')
          await this.plugin.detectAndApplyConfig()
          b.setDisabled(false)
          b.setButtonText('检测并填充')
        }),
      )

    new Setting(containerEl)
      .setName('检查 DSH 更新')
      .setDesc('对 DSH 仓库执行 git fetch 并比较版本（仅检测，不自动更新）')
      .addButton((b) =>
        b.setButtonText('检查更新').onClick(async () => {
          b.setDisabled(true)
          b.setButtonText('检查中…')
          await this.plugin.checkUpdates()
          b.setDisabled(false)
          b.setButtonText('检查更新')
        }),
      )

    new Setting(containerEl)
      .setName('页面缩放')
      .setDesc(`DSH 页面缩放比例（当前 ${this.plugin.settings.zoom.toFixed(1)}×），范围 0.5–2.0`)
      .addSlider((s) =>
        s
          .setLimits(0.5, 2.0, 0.1)
          .setValue(this.plugin.settings.zoom)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.zoom = v
            await this.plugin.saveSettings()
            this.plugin.refreshView?.()
          }),
      )
  }
}
