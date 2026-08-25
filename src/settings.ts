import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { defaultCandidates, locateDshRepoDir } from './detector'
import { DEFAULT_DSH_REPO_URL } from './installer'
import { writeBridgeFiles } from './bridge'
import { InstallProgressModal } from './install-progress-modal'
import { applyLocale, t, type LanguageSetting } from './i18n'
import type DshHarnessPlugin from './main'

export interface DshPluginSettings {
  port: number
  startupCommand: string
  startupCwd: string
  autoStart: boolean
  detached: boolean
  readyTimeoutSec: number
  zoom: number
  installDir: string
  installUrl: string
  /** DSH 更新的只读镜像地址；留空自动用 gh-proxy 兜底。 */
  updateMirrorUrl: string
  /** 插件界面语言：auto 跟随 Obsidian / zh / en。 */
  language: LanguageSetting
  /** 打开面板/启动服务时自动检测 DSH 更新（有新版才弹窗）。 */
  autoCheckUpdates: boolean
  /** 框选文字后自动显示「发送到 DSH」浮动按钮。 */
  selectionButton: boolean
  /** 发送选中文字后自动打开 DSH 面板。 */
  openPanelOnSend: boolean
  /** 注入/发送时附带来源标签（Obsidian 笔记绝对路径），帮助 DSH 定位文件。 */
  addSourceTag: boolean
  /** Inline Edit 编辑指令模板；{text} 会被选中原文替换。 */
  inlineEditPrompt: string
}

export const DEFAULT_SETTINGS: DshPluginSettings = {
  port: 3080,
  startupCommand: '',
  startupCwd: '',
  autoStart: true,
  detached: true,
  readyTimeoutSec: 300,
  zoom: 0.6,
  installDir: '',
  installUrl: DEFAULT_DSH_REPO_URL,
  updateMirrorUrl: '',
  language: 'auto',
  autoCheckUpdates: true,
  selectionButton: true,
  openPanelOnSend: true,
  addSourceTag: true,
  inlineEditPrompt: '',
}

export function startupCommandHint(): string {
  return t('settings.command.hint')
}

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DshHarnessPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // 已有 DSH 时自动填入检测到的安装目录（仅当设置为空）
    const detectedDir = locateDshRepoDir(defaultCandidates(this.plugin.settings.startupCwd))
    if (!this.plugin.settings.installDir && detectedDir) {
      this.plugin.settings.installDir = detectedDir
      void this.plugin.saveSettings()
    }

    // ---- 状态横幅 ----
    const statusSetting = new Setting(containerEl)
      .setName(t('settings.status.title'))
      .setDesc(t('settings.status.reading'))
    void this.plugin.getDshStatus().then((s) => {
      let text: string
      if (!s.installed) {
        text = t('settings.status.notInstalled')
      } else if (s.online) {
        text = s.version !== t('up.unknown') ? t('settings.status.installedVer', { v: s.version }) : t('settings.status.installed')
      } else {
        text = t('settings.status.stopped')
      }
      statusSetting.descEl.textContent = text
    })

    // ---- 基础设置：界面语言 / 服务安装与版本 ----
    new Setting(containerEl).setName(t('settings.section.basic')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.language.title'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((d) =>
        d
          .addOption('auto', t('settings.language.auto'))
          .addOption('zh', t('settings.language.zh'))
          .addOption('en', t('settings.language.en'))
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v as LanguageSetting
            await this.plugin.saveSettings()
            applyLocale(
              this.plugin.settings.language,
              this.plugin.settings.language === 'auto' ? this.plugin.detectSystemLanguage() : undefined,
            )
            this.display()
          }),
      )

    new Setting(containerEl)
      .setName(t('settings.install.title'))
      .setDesc(t('settings.install.desc'))
      .addButton((b) =>
        b.setButtonText(t('settings.install.btn')).onClick(async () => {
          b.setDisabled(true)
          // 安装进度弹窗：步骤打勾（依赖已具备预标 ✓）+ 实时进度条
          const modal = new InstallProgressModal(this.app)
          modal.open()
          const ok = await this.plugin.installWithPathPrompt((step, percent) => modal.update(percent ?? 0, step))
          if (ok) {
            modal.done()
            window.setTimeout(() => modal.close(), 1500)
          } else {
            modal.fail()
          }
          b.setDisabled(false)
          b.setButtonText(t('settings.install.btn'))
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.detect.title'))
      .setDesc(t('settings.detect.desc'))
            .addButton((b) =>
        b.setButtonText(t('settings.detect.btn')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('settings.detect.progress'))
          await this.plugin.detectAndApplyConfig()
          b.setDisabled(false)
          b.setButtonText(t('settings.detect.btn'))
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.installDir.title'))
      .setDesc(t('settings.installDir.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.installDir).onChange(async (v) => {
          this.plugin.settings.installDir = v.trim()
          await this.plugin.saveSettings()
        }),
      )

    const versionSetting = new Setting(containerEl)
      .setName(t('settings.version.title'))
      .setDesc(t('settings.status.reading'))
            .addButton((b) =>
        b.setButtonText(t('settings.version.check')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('settings.version.checking'))
          await this.plugin.checkUpdates()
          b.setDisabled(false)
          b.setButtonText(t('settings.version.check'))
        }),
      )
    // 统一构建 descEl：版本文本 + 「阅读更新日志」超链接（append，避免被覆盖）
    versionSetting.descEl.empty()
    const renderVersion = (label: string): void => {
      versionSetting.descEl.createEl('span', { text: label })
      const link = versionSetting.descEl.createEl('a', {
        cls: 'dsh-changelog-link',
        text: t('settings.version.changelog'),
        href: '#',
      })
      link.addEventListener('click', (e) => {
        e.preventDefault()
        this.plugin.openInBrowser(this.plugin.getDshReleasesUrl())
      })
    }
    renderVersion(t('settings.status.reading'))
    void this.plugin.getDshVersion().then((v) => {
      versionSetting.descEl.empty()
      renderVersion(t('settings.version.current', { v }))
    })

    new Setting(containerEl)
      .setName(t('settings.autoUpdate.title'))
      .setDesc(t('settings.autoUpdate.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.autoCheckUpdates).onChange(async (v) => {
          this.plugin.settings.autoCheckUpdates = v
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.zoom.title'))
      .setDesc(t('settings.zoom.desc', { z: this.plugin.settings.zoom.toFixed(2) }))
      .addSlider((s) =>
        s
          .setLimits(0.5, 2.0, 0.05)
          .setValue(this.plugin.settings.zoom)
          .onChange(async (v) => {
            this.plugin.settings.zoom = v
            await this.plugin.saveSettings()
            void this.plugin.refreshView?.()
          }),
      )

    // ---- 快捷操作 ----
    new Setting(containerEl).setName(t('settings.section.quick')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.reconnect.title'))
      .setDesc(t('settings.reconnect.desc'))
            .addButton((b) =>
        b.setButtonText(t('settings.reconnect.btn')).onClick(async () => {
          b.setDisabled(true)
          await this.plugin.reconnectDsh()
          b.setDisabled(false)
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.browser.title'))
      .setDesc(t('settings.browser.desc'))
            .addButton((b) =>
        b.setButtonText(t('settings.browser.btn')).onClick(() => {
          this.plugin.openDshInBrowser()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.aed.title'))
      .setDesc(t('settings.aed.desc'))
            .addButton((b) =>
        b.setButtonText(t('settings.aed.btn')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('aed.running'))
          const home = this.plugin.aedHomeDir()
          const result = await this.plugin.runAedRecovery(home)
          new Notice(result.message, result.ok ? 8000 : 12000)
          b.setDisabled(false)
          b.setButtonText(t('settings.aed.btn'))
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.safeMode.title'))
      .setDesc(t('settings.safeMode.desc'))
            .addButton((b) =>
        b.setButtonText(t('settings.safeMode.btn')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('aed.running'))
          const home = this.plugin.aedHomeDir()
          const result = await this.plugin.runAedSafe(home)
          new Notice(result.message, result.ok ? 8000 : 12000)
          b.setDisabled(false)
          b.setButtonText(t('settings.safeMode.btn'))
        }),
      )
      .addButton((b) =>
        b.setButtonText(t('settings.exitSafeMode.btn')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('aed.running'))
          const home = this.plugin.aedHomeDir()
          const result = await this.plugin.runExitSafeMode(home)
          new Notice(result.message, result.ok ? 8000 : 12000)
          b.setDisabled(false)
          b.setButtonText(t('settings.exitSafeMode.btn'))
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.bridge.restart.title'))
      .setDesc(t('settings.bridge.restart.desc'))
            .addButton((b) =>
        b.setButtonText(t('settings.bridge.restart.btn')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('settings.bridge.restart.progress'))
          await this.plugin.restartDshService()
          b.setDisabled(false)
          b.setButtonText(t('settings.bridge.restart.btn'))
          void this.plugin.probeBridgeReady().then(() => refreshBridgeStatus())
        }),
      )

    // ---- Inline Edit ----
    new Setting(containerEl).setName(t('settings.inline.title')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.inline.promptTitle'))
      .setDesc(t('settings.inline.promptDesc'))
      .addText((text) =>
        text
          .setPlaceholder(t('inline.promptTemplate'))
          .setValue(this.plugin.settings.inlineEditPrompt)
          .onChange(async (v) => {
            this.plugin.settings.inlineEditPrompt = v
            await this.plugin.saveSettings()
          }),
      )

    // ---- 桥接（状态 + 发送开关）----
    new Setting(containerEl).setName(t('settings.section.send')).setHeading()

    const bridgeStatus = new Setting(containerEl)
      .setName(t('settings.bridge.status.title'))
      .setDesc(t('settings.status.reading'))
            .addButton((b) =>
        b.setButtonText(t('settings.bridge.rewrite.btn')).onClick(() => {
          const r = writeBridgeFiles()
          if (r.error) {
            new Notice(t('settings.bridge.rewrite.fail', { err: r.error }), 8000)
            return
          }
          new Notice(r.changed ? t('settings.bridge.rewrite.updated') : t('settings.bridge.rewrite.ready'), 6000)
          refreshBridgeStatus()
        }),
      )
    const refreshBridgeStatus = (): void => {
      const s = this.plugin.getBridgeStatus()
      bridgeStatus.descEl.textContent = s.installed
        ? s.ready
          ? t('settings.bridge.status.installedReady')
          : t('settings.bridge.status.installedNotReady')
        : t('settings.bridge.status.notInstalled')
    }
    refreshBridgeStatus()
    // 主动探测一次桥接是否已加载
    void this.plugin.probeBridgeReady().then(() => refreshBridgeStatus())

    new Setting(containerEl)
      .setName(t('settings.send.selectionBtn.title'))
      .setDesc(t('settings.send.selectionBtn.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.selectionButton).onChange(async (v) => {
          this.plugin.settings.selectionButton = v
          await this.plugin.saveSettings()
          if (!v) {
            this.plugin.hideSelectionButton?.()
          }
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.send.openPanel.title'))
      .setDesc(t('settings.send.openPanel.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.openPanelOnSend).onChange(async (v) => {
          this.plugin.settings.openPanelOnSend = v
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.send.sourceTag.title'))
      .setDesc(t('settings.send.sourceTag.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.addSourceTag).onChange(async (v) => {
          this.plugin.settings.addSourceTag = v
          await this.plugin.saveSettings()
        }),
      )

    // ---- 高级设置：服务运行 ----
    new Setting(containerEl).setName(t('settings.section.advanced')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.port.title'))
      .setDesc(t('settings.port.desc'))
      .addText((tEl) =>
        tEl.setValue(String(this.plugin.settings.port)).onChange(async (v) => {
          const n = Number(v)
          if (Number.isInteger(n) && n > 0 && n <= 65535) {
            this.plugin.settings.port = n
            await this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
          }
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.command.title'))
      .setDesc(startupCommandHint())
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.startupCommand).onChange(async (v) => {
          this.plugin.settings.startupCommand = v.trim()
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.cwd.title'))
      .setDesc(t('settings.cwd.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.startupCwd).onChange(async (v) => {
          this.plugin.settings.startupCwd = v.trim()
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.autoStart.title'))
      .setDesc(t('settings.autoStart.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.autoStart).onChange(async (v) => {
          this.plugin.settings.autoStart = v
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.detached.title'))
      .setDesc(t('settings.detached.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.detached).onChange(async (v) => {
          this.plugin.settings.detached = v
          await this.plugin.saveSettings()
          this.plugin.reconfigureService?.()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.readyTimeout.title'))
      .setDesc(t('settings.readyTimeout.desc', { s: this.plugin.settings.readyTimeoutSec }))
      .addSlider((s) =>
        s
          .setLimits(60, 600, 30)
          .setValue(this.plugin.settings.readyTimeoutSec)
          .onChange(async (v) => {
            this.plugin.settings.readyTimeoutSec = v
            await this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
          }),
      )

    new Setting(containerEl)
      .setName(t('settings.installUrl.title'))
      .setDesc(t('settings.installUrl.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.installUrl).onChange(async (v) => {
          this.plugin.settings.installUrl = v.trim() || DEFAULT_DSH_REPO_URL
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.updateMirror.title'))
      .setDesc(t('settings.updateMirror.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.updateMirrorUrl).onChange(async (v) => {
          this.plugin.settings.updateMirrorUrl = v.trim()
          await this.plugin.saveSettings()
        }),
      )

    // ---- 诊断（启动耗时打点）----
    new Setting(containerEl).setName(t('settings.diag.title')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.diag.startup.title'))
      .setDesc(t('settings.diag.startup.desc'))
      .addButton((b) =>
        b.setButtonText(t('settings.diag.refresh')).onClick(() => {
          renderDiag()
        }),
      )

    const diagEl = containerEl.createDiv({ cls: 'dsh-diag-log' })
    const renderDiag = (): void => {
      const records = this.plugin.getStartupRecords()
      diagEl.empty()
      if (records.length === 0) {
        diagEl.setText(t('settings.diag.empty'))
        return
      }
      const lines: string[] = []
      for (const rec of records.slice(-5).reverse()) {
        const when = new Date(rec.ts).toLocaleTimeString()
        const phases = Object.entries(rec.phases)
          .map(([k, v]) => `${k}: ${v}ms`)
          .join(' · ')
        lines.push(`${when} ${rec.ok ? '✓' : '✗'} ${phases}${rec.error ? ' — ' + rec.error : ''}`)
      }
      diagEl.setText(lines.join('\n'))
    }
    renderDiag()
  }
}
