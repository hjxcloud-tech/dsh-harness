import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { defaultCandidates, locateDshRepoDir } from './detector'
import { DEFAULT_DSH_REPO_URL } from './installer'
import { writeBridgeFiles } from './bridge'
import { InstallProgressModal } from './install-progress-modal'
import { applyLocale, t, type LanguageSetting } from './i18n'
import { type BridgeToObsidianMode } from './bridge-mode'
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
  /** 发送选中文字后自动打开 DSH 面板。 */
  openPanelOnSend: boolean
  /** 开启「DSH 聊天框 → Obsidian」桥接模式（三选项：取消 / 自动发送 / 右键发送）。 */
  bridgeToObsidian: BridgeToObsidianMode
  /** 面板底部垫高（px）：Obsidian 状态栏可能遮挡面板底部内容，垫高避免遮挡。 */
  bottomPadPx: number
  /** 光标在 iframe 内时是否透传 Obsidian 全局快捷键（遍历 Obsidian 当前快捷键设置）。 */
  shortcutPassthrough: boolean
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
  openPanelOnSend: true,
  bridgeToObsidian: 'auto',
  bottomPadPx: 20,
  shortcutPassthrough: true,
}

export function startupCommandHint(): string {
  return t('settings.command.hint')
}

export class DshSettingTab extends PluginSettingTab {
  /** 文本/滑杆控件防抖定时器（避免逐键/逐格触发保存与服务重建）。 */
  private saveTimer: number | null = null

  constructor(app: App, private readonly plugin: DshHarnessPlugin) {
    super(app, plugin)
  }

  /** 防抖执行保存+副作用（默认 500ms）；连续输入只触发最后一次。 */
  private scheduleSave(effect: () => void, ms = 500): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      effect()
    }, ms)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    // 设置页容器类名：styles.css 据此对全部行控件强制上下居中（按钮/输入框/下拉框）
    containerEl.addClass('dsh-settings-tab')

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
      .setClass('dsh-bridge-status-row')
      .addButton((b) =>
        b.setButtonText(t('settings.status.check')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('settings.status.checking'))
          await this.plugin.checkUpdates()
          b.setDisabled(false)
          b.setButtonText(t('settings.status.check'))
        }),
      )
    // 统一构建 descEl：状态文本 + 「更新日志」超链接（append，避免被覆盖）
    statusSetting.descEl.empty()
    const renderStatus = (label: string): void => {
      statusSetting.descEl.createSpan({ text: label })
      statusSetting.descEl.createSpan({ text: ' · ' })
      const link = statusSetting.descEl.createEl('a', {
        cls: 'dsh-changelog-link',
        text: t('settings.status.changelog'),
        href: '#',
      })
      link.addEventListener('click', (e) => {
        e.preventDefault()
        this.plugin.openInBrowser(this.plugin.getDshReleasesUrl())
      })
    }
    renderStatus(t('settings.status.reading'))
    void this.plugin.getDshStatus().then((s) => {
      let text: string
      if (!s.installed) {
        text = t('settings.status.notInstalled')
      } else if (s.online) {
        text = s.version !== t('up.unknown') ? t('settings.status.installedVer', { v: s.version }) : t('settings.status.installed')
      } else {
        text = t('settings.status.stopped')
      }
      statusSetting.descEl.empty()
      renderStatus(text)
    })

    // ---- 插件信息（DSH 状态下一栏）----
    const pluginVersionSetting = new Setting(containerEl)
      .setName(t('settings.pluginVersion.title'))
      .setDesc(t('settings.status.reading'))
      .setClass('dsh-bridge-status-row')
      .addButton((b) =>
        b.setButtonText(t('settings.pluginVersion.check')).onClick(() => {
          void this.plugin.checkPluginUpdates()
        }),
      )
    pluginVersionSetting.descEl.empty()
    const renderPluginVersion = (): void => {
      // 第一行：版本 + 更新日志
      pluginVersionSetting.descEl.createSpan({ text: t('settings.pluginVersion.installed', { v: this.plugin.manifest.version }) })
      pluginVersionSetting.descEl.createSpan({ text: ' · ' })
      const link = pluginVersionSetting.descEl.createEl('a', {
        cls: 'dsh-changelog-link',
        text: t('settings.pluginVersion.changelog'),
        href: '#',
      })
      link.addEventListener('click', (e) => {
        e.preventDefault()
        this.plugin.showPluginChangelog()
      })
      // 第二行：GitHub 主页网址原文超链接 + 使用反馈欢迎留言
      pluginVersionSetting.descEl.createEl('br')
      const repoLink = pluginVersionSetting.descEl.createEl('a', {
        cls: 'dsh-changelog-link',
        text: this.plugin.getPluginRepoUrl(),
        href: '#',
      })
      repoLink.addEventListener('click', (e) => {
        e.preventDefault()
        this.plugin.openInBrowser(this.plugin.getPluginRepoUrl())
      })
      pluginVersionSetting.descEl.createSpan({ text: ` ${t('settings.pluginVersion.repoHint')}` })
    }
    renderPluginVersion()

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
      .setClass('dsh-config-row')
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
        tEl.setValue(this.plugin.settings.installDir).onChange((v) => {
          this.plugin.settings.installDir = v.trim()
          this.scheduleSave(() => void this.plugin.saveSettings())
        }),
      )

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
          .onChange((v) => {
            this.plugin.settings.zoom = v
            // 拖动节流：松开停顿后才保存 + 重载面板（避免逐格整页重载 iframe）
            this.scheduleSave(() => {
              void this.plugin.saveSettings()
              void this.plugin.refreshView?.()
            })
          }),
      )

    new Setting(containerEl)
      .setName(t('settings.bottomPad.title'))
      .setDesc(t('settings.bottomPad.desc', { px: this.plugin.settings.bottomPadPx }))
      .addSlider((s) =>
        s
          .setLimits(0, 30, 1)
          .setValue(this.plugin.settings.bottomPadPx)
          .onChange((v) => {
            this.plugin.settings.bottomPadPx = v
            this.scheduleSave(() => {
              void this.plugin.saveSettings()
              void this.plugin.refreshView?.()
            })
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
      .setClass('dsh-bridge-status-row')
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

    // 卸载并重装 DSH（保留聊天记录）：红色破坏性按钮，弹强确认
    new Setting(containerEl)
      .setName(t('settings.cleanup.title'))
      .setDesc(t('settings.cleanup.desc'))
      .setClass('dsh-bridge-status-row')
      .addButton((b) =>
        b.setButtonText(t('settings.cleanup.btn')).setWarning().onClick(() => {
          this.plugin.openCleanReinstallModal()
        }),
      )

    // ---- 桥接（状态 + 发送开关）----
    new Setting(containerEl).setName(t('settings.section.send')).setHeading()

    const bridgeStatus = new Setting(containerEl)
      .setName(t('settings.bridge.status.title'))
      .setDesc(t('settings.status.reading'))
      .setClass('dsh-bridge-status-row')
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
      // 多行状态描述（\n 换行 + 编号功能列表）
      bridgeStatus.descEl.addClass('dsh-bridge-status')
      bridgeStatus.descEl.textContent = s.installed
        ? s.ready
          ? t('settings.bridge.status.installedReady')
          : t('settings.bridge.status.installedNotReady')
        : t('settings.bridge.status.notInstalled')
    }
    refreshBridgeStatus()
    // 主动探测一次桥接是否已加载
    void this.plugin.probeBridgeReady().then(() => refreshBridgeStatus())

    // 快捷键透传（光标在 iframe 内时仍可触发 Obsidian 全局快捷键；遍历 Obsidian 当前快捷键设置）
    new Setting(containerEl)
      .setName(t('settings.passthrough.title'))
      .setDesc(t('settings.passthrough.desc'))
      .setClass('dsh-bridge-status-row')
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.shortcutPassthrough).onChange(async (v) => {
          this.plugin.settings.shortcutPassthrough = v
          await this.plugin.saveSettings()
          void this.plugin.refreshView?.()
        }),
      )

    // 桥接：Obsidian → DSH 聊天框（框选文字右键发送）
    new Setting(containerEl)
      .setName(t('settings.send.openPanel.title'))
      .setDesc(t('settings.send.openPanel.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.openPanelOnSend).onChange(async (v) => {
          this.plugin.settings.openPanelOnSend = v
          await this.plugin.saveSettings()
        }),
      )

    // 桥接：DSH 聊天框 → Obsidian（三选项：取消 / 自动发送 / 右键发送；删除原「附带来源标签」开关——来源信息由隐式行统一承载）
    new Setting(containerEl)
      .setName(t('settings.bridge.toObsidian.title'))
      .setDesc(t('settings.bridge.toObsidian.desc'))
      .setClass('dsh-bridge-mode-row')
      .addDropdown((dd) =>
        dd
          .addOption('off', t('settings.bridge.toObsidian.off'))
          .addOption('auto', t('settings.bridge.toObsidian.auto'))
          .addOption('rightClick', t('settings.bridge.toObsidian.rightClick'))
          .setValue(this.plugin.settings.bridgeToObsidian)
          .onChange(async (v) => {
            this.plugin.settings.bridgeToObsidian = v as BridgeToObsidianMode
            await this.plugin.saveSettings()
            // 模式变更后同步选区监听注册（仅 auto 且面板已开才注册）
            this.plugin.syncAutoSendRegistration()
          }),
      )

    // ---- 高级设置：服务运行 ----
    new Setting(containerEl).setName(t('settings.section.advanced')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.port.title'))
      .setDesc(t('settings.port.desc'))
      .addText((tEl) =>
        tEl.setValue(String(this.plugin.settings.port)).onChange((v) => {
          const n = Number(v)
          if (Number.isInteger(n) && n > 0 && n <= 65535) {
            this.plugin.settings.port = n
            // 防抖：避免逐键重建服务（reconfigureService 会 dispose 运行中的 DSH）
            this.scheduleSave(() => {
              void this.plugin.saveSettings()
              this.plugin.reconfigureService?.()
            })
          }
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.command.title'))
      .setDesc(startupCommandHint())
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.startupCommand).onChange((v) => {
          this.plugin.settings.startupCommand = v.trim()
          this.scheduleSave(() => {
            void this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
          })
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.cwd.title'))
      .setDesc(t('settings.cwd.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.startupCwd).onChange((v) => {
          this.plugin.settings.startupCwd = v.trim()
          this.scheduleSave(() => {
            void this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
          })
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
          .onChange((v) => {
            this.plugin.settings.readyTimeoutSec = v
            this.scheduleSave(() => {
              void this.plugin.saveSettings()
              this.plugin.reconfigureService?.()
            })
          }),
      )

    new Setting(containerEl)
      .setName(t('settings.installUrl.title'))
      .setDesc(t('settings.installUrl.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.installUrl).onChange((v) => {
          this.plugin.settings.installUrl = v.trim() || DEFAULT_DSH_REPO_URL
          this.scheduleSave(() => void this.plugin.saveSettings())
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.updateMirror.title'))
      .setDesc(t('settings.updateMirror.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.updateMirrorUrl).onChange((v) => {
          this.plugin.settings.updateMirrorUrl = v.trim()
          this.scheduleSave(() => void this.plugin.saveSettings())
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
