import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { defaultCandidates, locateDshRepoDir } from './detector'
import { DEFAULT_DSH_REPO_URL } from './installer'
import { writeBridgeFiles } from './bridge'
import { InstallProgressModal } from './install-progress-modal'
import { applyLocale, t, type LanguageSetting } from './i18n'
import { type BridgeToObsidianMode } from './bridge-mode'
import { isReservedProfile, normalizeProfile, VALID_PROFILE_RE } from './profile'
import { DEFAULT_UPDATE_CHANNEL, normalizeUpdateChannel, type UpdateChannel } from './updater'
import type { CompatAlertLog } from './compat'
import type DshHarnessPlugin from './main'

export { isReservedProfile, normalizeProfile, VALID_PROFILE_RE }
export { DEFAULT_UPDATE_CHANNEL, normalizeUpdateChannel }
export type { UpdateChannel }

export interface DshPluginSettings {
  port: number
  startupCommand: string
  startupCwd: string
  /**
   * v2.6.0：DSH profile 名（补丁层/桥接/启动命令的归属）。默认 web（与历史行为逐字一致）；
   * 非 web 时插件代建 profile（基于 web 模板）、把桥接装入该 profile，并以
   * `dsh --profile <p> --port {port} --no-open` 主程序形态拉起——支持与 desktop 版 web 实例跨端口共存。
   */
  profile: string
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
  /** 发送选中文字后自动打开 DSH 面板。 */
  openPanelOnSend: boolean
  /** 开启「DSH 聊天框 → Obsidian」桥接模式（三选项：取消 / 自动发送 / 右键发送）。 */
  bridgeToObsidian: BridgeToObsidianMode
  /** 面板底部垫高（px）：Obsidian 状态栏可能遮挡面板底部内容，垫高避免遮挡。 */
  bottomPadPx: number
  /** 光标在 iframe 内时是否透传 Obsidian 全局快捷键（遍历 Obsidian 当前快捷键设置）。 */
  shortcutPassthrough: boolean
  /**
   * 更新通道（v2.6.0 重开自动更新）：`stable`=只认正式版；`preview`=正式版+beta+rc（默认，跟随官方主推）；
   * `dev`=再加 alpha。DSH 长期只发预发布，旧策略「仅正式版」等于把更新关掉。
   */
  updateChannel: UpdateChannel
  /** 启动后自动检查 DSH 更新（发现新版本弹确认框；绝不静默安装——更新会先结束全部 DSH 进程）。 */
  autoCheckUpdates: boolean
  /** 自动检查的节流间隔（小时）：避免每次启动都联网检测。 */
  autoCheckIntervalHours: number
  /** 上次自动检查更新的时间戳（ms），内部状态。 */
  lastAutoUpdateAtMs: number
  /** 启动后检查本机 DSH 版本与桥接是否适配；不适配时弹窗（同种问题 24h 内只弹一次）。 */
  checkCompatOnStartup: boolean
  /**
   * 适配弹窗的冷却台账（问题种类 → {版本, 最近提示时刻}）。内部状态，不在设置页出现，
   * 但需要随 data.json 持久化——「今天不再提示」跨重启有效才对用户有意义。
   */
  compatAlerts: CompatAlertLog
}

export const DEFAULT_SETTINGS: DshPluginSettings = {
  port: 3080,
  startupCommand: '',
  startupCwd: '',
  profile: 'web',
  autoStart: true,
  detached: true,
  readyTimeoutSec: 300,
  zoom: 0.6,
  installDir: '',
  installUrl: DEFAULT_DSH_REPO_URL,
  updateMirrorUrl: '',
  language: 'auto',
  openPanelOnSend: true,
  bridgeToObsidian: 'auto',
  bottomPadPx: 20,
  shortcutPassthrough: true,
  updateChannel: DEFAULT_UPDATE_CHANNEL,
  autoCheckUpdates: true,
  autoCheckIntervalHours: 24,
  lastAutoUpdateAtMs: 0,
  checkCompatOnStartup: true,
  compatAlerts: {},
}

/** 自动检查节流允许的最小间隔（小时）：防止填 0 变成每次启动都联网。 */
export const MIN_AUTO_CHECK_HOURS = 1

export function startupCommandHint(): string {
  return t('settings.command.hint')
}

export class DshSettingTab extends PluginSettingTab {
  /** 文本/滑杆控件防抖定时器（避免逐键/逐格触发保存与服务重建）。 */
  private saveTimer: number | null = null
  /** profile 新建文本框的草稿（点「新建并切换」才生效——逐字符切档会反复重启服务）。 */
  private profileDraft: string = ''

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
    // 横幅 = DSH 状态 + 适配判定（v2.6.0 需求①：本机版本与插件是否适配，一眼可见，不必点开设置找）
    void Promise.all([this.plugin.getDshStatus(), this.plugin.getCompatSnapshot()]).then(([s, c]) => {
      let text: string
      if (!s.installed) {
        text = t('settings.status.notInstalled')
      } else if (s.online) {
        text = s.version !== t('up.unknown') ? t('settings.status.installedVer', { v: s.version }) : t('settings.status.installed')
      } else {
        text = t('settings.status.stopped')
      }
      const tone = c.issue === null
        ? t(c.level === 'unknown' ? 'compat.tone.unknown' : 'compat.tone.ok')
        : t(`compat.tone.${c.issue}`)
      statusSetting.descEl.empty()
      renderStatus(`${text} · ${tone}`)
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
      // 第一行：版本 + 更新日志 + DSH版本适配说明（两个链接并列）
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
      // v2.6.0：「DSH版本适配说明」超链接紧跟「更新日志」之后——适配区间与本机判定都在弹窗里说，
      // 不再占信息栏一整行（用户定案：信息栏只留链接，说明点开看）。
      pluginVersionSetting.descEl.createSpan({ text: ' · ' })
      const compatLink = pluginVersionSetting.descEl.createEl('a', {
        cls: 'dsh-changelog-link',
        text: t('settings.pluginVersion.compatLink'),
        href: '#',
      })
      compatLink.addEventListener('click', (e) => {
        e.preventDefault()
        void this.plugin.showCompatExplanation()
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

    // v2.3.0：移除「自动检查更新」开关——DSH ≥0.1.2 认证未适配前不再自动打扰，更新检查仅在设置页手动触发

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
      .setName(t('settings.repair.title'))
      .setDesc(t('settings.repair.desc'))
      .addButton((b) =>
        b.setButtonText(t('settings.repair.btn')).onClick(() => {
          this.plugin.openSessionRepair()
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
          const r = writeBridgeFiles(undefined, this.plugin.manifest.version, this.plugin.settings.profile)
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

    // ---- 高级设置 ----
    // 分区顺序（v2.6.0 重排）：服务运行（最高频调参）→ DSH Profile（决定服务形态，紧随其后）
    // → 更新与安装源（策略 + 镜像源）→ 适配自检（状态类，与下方「诊断」相邻）。
    new Setting(containerEl).setName(t('settings.section.advanced')).setHeading()

    new Setting(containerEl).setName(t('settings.section.service')).setHeading()

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

    // ---- 高级设置 · DSH Profile（多档共存）----
    // **下拉选已有 + 文本框建新名**，两条路都先弹确认框（切换会重建服务并改写启动命令，
    // 逐字符触发会反复重启，故不在 onChange 里直接落盘）。
    new Setting(containerEl).setName(t('settings.section.profile')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.profile.pick'))
      .setDesc(t('settings.profile.pickDesc'))
      .addDropdown((d) => {
        const current = this.plugin.settings.profile
        const names = this.plugin.listDshProfiles()
        if (!names.includes(current)) names.unshift(current)
        for (const name of names) d.addOption(name, name === 'web' ? `web（${t('settings.profile.default')}）` : name)
        d.setValue(current).onChange((v) => {
          void this.plugin.requestProfileChange(v)
        })
      })
    new Setting(containerEl)
      .setName(t('settings.profile.newName'))
      .setDesc(t('settings.profile.newNameDesc'))
      .addText((tEl) => {
        tEl.setPlaceholder(t('settings.profile.newNamePlaceholder'))
        tEl.onChange((v) => {
          this.profileDraft = v.trim().toLowerCase()
        })
      })
      .addButton((b) =>
        b.setButtonText(t('settings.profile.create')).onClick(() => {
          void this.plugin.requestProfileChange(this.profileDraft ?? '')
        }),
      )

    // ---- 高级设置 · 更新与安装源（策略在前，源/镜像在后）----
    new Setting(containerEl).setName(t('settings.section.update')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.updateChannel.title'))
      .setDesc(t('settings.updateChannel.desc'))
      .addDropdown((d) => {
        d.addOption('stable', t('settings.updateChannel.stable'))
        d.addOption('preview', t('settings.updateChannel.preview'))
        d.addOption('dev', t('settings.updateChannel.dev'))
        d.setValue(this.plugin.settings.updateChannel).onChange(async (v) => {
          this.plugin.settings.updateChannel = v === 'stable' || v === 'dev' ? v : 'preview'
          await this.plugin.saveSettings()
        })
      })

    new Setting(containerEl)
      .setName(t('settings.autoCheck.title'))
      .setDesc(t('settings.autoCheck.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.autoCheckUpdates).onChange(async (v) => {
          this.plugin.settings.autoCheckUpdates = v
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.autoCheckInterval.title'))
      .setDesc(t('settings.autoCheckInterval.desc', { h: String(this.plugin.settings.autoCheckIntervalHours) }))
      .addSlider((s) =>
        s
          .setLimits(1, 168, 1)
          .setValue(this.plugin.settings.autoCheckIntervalHours)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.autoCheckIntervalHours = Math.max(MIN_AUTO_CHECK_HOURS, Math.round(v))
            await this.plugin.saveSettings()
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

    new Setting(containerEl)
      .setName(t('settings.installUrl.title'))
      .setDesc(t('settings.installUrl.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.installUrl).onChange((v) => {
          this.plugin.settings.installUrl = v.trim() || DEFAULT_DSH_REPO_URL
          this.scheduleSave(() => void this.plugin.saveSettings())
        }),
      )

    // ---- 高级设置 · 适配自检（本机 DSH 版本 / 桥接是否真生效）----
    new Setting(containerEl).setName(t('settings.section.compat')).setHeading()

    new Setting(containerEl)
      .setName(t('settings.compat.title'))
      .setDesc(t('settings.compat.desc'))
      .addToggle((tEl) =>
        tEl.setValue(this.plugin.settings.checkCompatOnStartup).onChange(async (v) => {
          this.plugin.settings.checkCompatOnStartup = v
          await this.plugin.saveSettings()
        }),
      )
      .addButton((b) =>
        b.setButtonText(t('settings.compat.recheck')).onClick(() => {
          void this.plugin.recheckCompat()
        }),
      )

    const compatLine = new Setting(containerEl)
      .setName(t('settings.compat.state.title'))
      .setDesc(t('settings.compat.state.reading'))
    // 判定文案键直接用 compatIssue() 的返回值（同一套字符串，不另立映射表）
    void this.plugin.getCompatSnapshot().then((s) => {
      compatLine.setDesc(t(`compat.verdict.${s.issue ?? 'ok'}`, { v: s.version }))
    })

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
