import { App, PluginSettingTab, Setting } from 'obsidian'
import { DEFAULT_DSH_REPO_URL } from './installer'
import type DshHarnessPlugin from './main'

export interface DshPluginSettings {
  port: number
  startupCommand: string
  startupCwd: string
  autoStart: boolean
  detached: boolean
  zoom: number
  installDir: string
  installUrl: string
}

export const DEFAULT_SETTINGS: DshPluginSettings = {
  port: 3080,
  startupCommand: '',
  startupCwd: '',
  autoStart: true,
  detached: false,
  zoom: 0.6,
  installDir: '',
  installUrl: DEFAULT_DSH_REPO_URL,
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
    new Setting(containerEl).setName('DeepSeek Harness').setHeading()

    // ---- 顶部：一键安装 DSH 本体 ----
    new Setting(containerEl)
      .setName('一键安装 DSH 本体')
      .setDesc('克隆 DeepSeek Harness 官方仓库并安装依赖（需 git 与 pnpm，可能耗时数分钟），完成后自动填充启动配置')
      .addButton((b) =>
        b.setButtonText('安装 DSH').onClick(async () => {
          b.setDisabled(true)
          b.setButtonText('安装中…')
          await this.plugin.installAndConfigure()
          b.setDisabled(false)
          b.setButtonText('安装 DSH')
        }),
      )

    new Setting(containerEl)
      .setName('安装目录')
      .setDesc('DSH 安装位置；留空为 用户目录/deepseek-harness')
      .addText((t) =>
        t.setValue(this.plugin.settings.installDir).onChange(async (v) => {
          this.plugin.settings.installDir = v.trim()
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('安装地址')
      .setDesc('克隆仓库地址；默认官方仓库，网络受限时可换代理镜像（如 https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git）')
      .addText((t) =>
        t.setValue(this.plugin.settings.installUrl).onChange(async (v) => {
          this.plugin.settings.installUrl = v.trim() || DEFAULT_DSH_REPO_URL
          await this.plugin.saveSettings()
        }),
      )

    // ---- 顶部：DSH 版本与更新 ----
    const versionSetting = new Setting(containerEl)
      .setName('DSH 版本')
      .setDesc('读取中…')
      .addButton((b) =>
        b.setButtonText('检查更新').onClick(async () => {
          b.setDisabled(true)
          b.setButtonText('检查中…')
          await this.plugin.checkUpdates()
          b.setDisabled(false)
          b.setButtonText('检查更新')
        }),
      )
    void this.plugin.getDshVersion().then((v) => {
      versionSetting.descEl.textContent = `当前版本：${v}`
    })

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

    // ---- 服务与启动 ----
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

    // ---- 显示 ----
    new Setting(containerEl)
      .setName('页面缩放')
      .setDesc(`DSH 页面缩放比例（当前 ${this.plugin.settings.zoom.toFixed(1)}×），范围 0.5–2.0`)
      .addSlider((s) =>
        s
          .setLimits(0.5, 2.0, 0.1)
          .setValue(this.plugin.settings.zoom)
          .onChange(async (v) => {
            this.plugin.settings.zoom = v
            await this.plugin.saveSettings()
            void this.plugin.refreshView?.()
          }),
      )
  }
}
