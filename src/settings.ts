import { App, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian'
import { defaultCandidates, locateDshRepoDir } from './detector'
import { seamLineFor } from './compat-diff'
import { DEFAULT_DSH_REPO_URL } from './installer'
import { writeBridgeFiles } from './bridge'
import { InstallProgressModal } from './install-progress-modal'
import { AedSymptomsModal } from './aed-modal'
import { MobileAccessHelpModal, MobileAccessIntroModal, MobileAccessResetModal } from './mobile-access-modal'
import { applyLocale, t, type LanguageSetting } from './i18n'
import { installModeFor, type BridgeInputMode, normalizeBridgeInputMode, type BridgeToObsidianMode } from './bridge-mode'
import { isReservedProfile, normalizeProfile, nonWebProfileInCommand, VALID_PROFILE_RE } from './profile'
import { DEFAULT_SERVICE_HOST, endpointFromSettings, endpointLabel, httpsSwitchNeedsPair, isLoopbackHost, normalizeServiceHost, tlsErrorKind, type ServiceScheme } from './service-endpoint'
import { DEFAULT_UPDATE_CHANNEL, normalizeUpdateChannel, type UpdateChannel } from './updater'
import { markDestructive, refreshSettingTab, showSliderValueBubble } from './ui-compat'
import type DshHarnessPlugin from './main'

export { isReservedProfile, normalizeProfile, VALID_PROFILE_RE }
export { DEFAULT_UPDATE_CHANNEL, normalizeUpdateChannel }
export type { UpdateChannel }

export interface DshPluginSettings {
  port: number
  /**
   * v2.9.0：DSH 监听的本机地址（IPv4/IPv6 字面量或 localhost）。
   * 与 port/scheme/tls 一起经 `endpointFromSettings` 收敛成唯一事实源 `ServiceEndpoint`：
   * 探活、netstat 端口占用识别、Node 侧 HTTP(S) 请求、iframe 首载、postMessage targetOrigin 全按它工作。
   */
  serviceHost: string
  /** v2.9.0：连接协议；https 需 tlsCertPath + tlsKeyPath 成对（DSH ≥ 0.2.1-rc.2 原生 TLS）。 */
  serviceScheme: ServiceScheme
  /** v2.9.0：TLS 证书 PEM **文件路径**（https 时作插件 Node 侧校验锚点，也可填签发它的 CA）。 */
  tlsCertPath: string
  /** v2.9.0：TLS 私钥 PEM **文件路径**（仅用于给插件生成的默认命令追加 `--tls-key`）。 */
  tlsKeyPath: string
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
  /**
   * 桥接填充的写入方式（v2.8.0 / setDraft 设计 P1+P2）：`auto`＝优先官方 `setDraft`
   * （Lexical 模型层写入，**不需要输入框焦点** ⇒ 框选后隐式行立即出现、且不抢用户键盘焦点）；
   * `dom`＝只用 v2.5.3 的 DOM 定向替换（写入必须临时持有焦点）。
   * auto 会把桥接以**裸包名（package 模式）**安装——这是装载器认得 `client.js` 的唯一形态；
   * 链接建不出来或官方接口不可达时，宿主与页面脚本都静默退回 DOM 路径，两种模式行为一致。
   */
  bridgeInputMode: BridgeInputMode
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
}

export const DEFAULT_SETTINGS: DshPluginSettings = {
  port: 3080,
  serviceHost: DEFAULT_SERVICE_HOST,
  serviceScheme: 'http',
  tlsCertPath: '',
  tlsKeyPath: '',
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
  bridgeInputMode: 'auto',
  bottomPadPx: 20,
  shortcutPassthrough: true,
  updateChannel: DEFAULT_UPDATE_CHANNEL,
  autoCheckUpdates: true,
  autoCheckIntervalHours: 24,
  lastAutoUpdateAtMs: 0,
}

/** 自动检查节流允许的最小间隔（小时）：防止填 0 变成每次启动都联网。 */
export const MIN_AUTO_CHECK_HOURS = 1

/** v2.9.1：手机访问配置会整体覆盖的四项端点设置。 */
export type EndpointSettings = Pick<DshPluginSettings, 'serviceHost' | 'serviceScheme' | 'tlsCertPath' | 'tlsKeyPath'>

/**
 * 「恢复默认」的四项回退（纯函数，§11）：回环地址 + http + 清空两个 TLS 路径。
 * **只回退设置**——证书文件、桌面 rootCA.pem、系统与手机里已安装的证书信任都不动；
 * 落盘、重建 ServiceManager 与刷新设置页由 `main.resetMobileAccessSettings()` 负责。
 */
export function resetEndpointSettings(): EndpointSettings {
  return { serviceHost: DEFAULT_SERVICE_HOST, serviceScheme: 'http', tlsCertPath: '', tlsKeyPath: '' }
}

/** 当前四项是否已经是默认值（决定「恢复默认」按钮是弹确认框还是直接 Notice）。 */
export function isDefaultEndpointSettings(s: EndpointSettings): boolean {
  return (
    s.serviceHost === DEFAULT_SERVICE_HOST &&
    s.serviceScheme === 'http' &&
    s.tlsCertPath.trim() === '' &&
    s.tlsKeyPath.trim() === ''
  )
}

export function startupCommandHint(): string {
  // 第二句（v2.9.0）：说清「默认命令自动附加端点参数、自定义命令原样使用」——两者都是用户可见行为
  return `${t('settings.command.hint')} ${t('settings.command.hint.endpoint')}`
}

/** 「测试连接」结果（与 `main.testServiceConnection` 同形；只诊断，不改任何设置）。 */
export interface ServiceConnectionResult {
  ok: boolean
  kind: 'ok' | 'refused' | 'timeout' | 'tls' | 'http' | 'other'
  /** kind='ok'/'http' 时是 HTTP 状态码；kind='tls' 时是原始错误文本（含 code）；其余是原始错误文本。 */
  detail: string
}

/**
 * 「测试连接」结果 → 可读文案（设置页 Notice 用）。
 *
 * TLS 失败按 `tlsErrorKind` 细分成「未受信任 / SAN 不含该地址 / 已过期」三条不同提示，
 * 并附上原始 code（如 `DEPTH_ZERO_SELF_SIGNED_CERT`）——README 故障排查表就是按 code 对照写的。
 */
function connectionTestMessage(result: ServiceConnectionResult, addr: string): string {
  switch (result.kind) {
    case 'ok':
      return t('settings.conn.ok', { addr, status: result.detail })
    case 'http':
      return t('settings.conn.http', { addr, status: result.detail })
    case 'refused':
      return t('settings.conn.refused', { addr })
    case 'timeout':
      return t('settings.conn.timeout', { addr })
    case 'other':
      return t('settings.conn.other', { addr, err: result.detail })
    case 'tls': {
      const code = /code=([A-Z0-9_]+)/.exec(result.detail)?.[1] ?? 'TLS'
      const tlsKind = tlsErrorKind({ message: result.detail })
      if (tlsKind === 'untrusted') return t('settings.conn.tlsUntrusted', { addr, code })
      if (tlsKind === 'altname') return t('settings.conn.tlsAltname', { addr, code })
      if (tlsKind === 'expired') return t('settings.conn.tlsExpired', { addr, code })
      return t('settings.conn.tlsOther', { addr, code, err: result.detail })
    }
  }
}

export class DshSettingTab extends PluginSettingTab {
  /** 文本/滑杆控件防抖定时器（避免逐键/逐格触发保存与服务重建）。 */
  private saveTimer: number | null = null
  /** profile 新建文本框的草稿（点「新建并切换」才生效——逐字符切档会反复重启服务）。 */
  private profileDraft: string = ''
  /** 「诊断 → 连接地址」行：端点相关控件变更后就地刷新它的展示串（不整页重画，避免打断输入）。 */
  private connRowSetting: Setting | null = null

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

  /** 就地刷新「连接地址」行（端点四项任一变更后调用；只改 desc，不重画整页）。 */
  private refreshEndpointRow(): void {
    this.connRowSetting?.setDesc(endpointLabel(endpointFromSettings(this.plugin.settings)))
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
    // v2.8.4：适配判定**只在这里静默呈现**（连同下面「当前适配状态」一行），插件不再弹任何提示框。
    void Promise.all([this.plugin.getDshStatus(), this.plugin.getCompatSnapshot()]).then(([s, c]) => {
      let text: string
      if (!s.installed) {
        text = t('settings.status.notInstalled')
      } else if (s.online) {
        text = s.version !== t('up.unknown') ? t('settings.status.installedVer', { v: s.version }) : t('settings.status.installed')
      } else {
        text = t('settings.status.stopped')
      }
      const tone = !c
        ? t('compat.tone.unknown')
        : c.issue === null
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
            refreshSettingTab(this)
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

    const aedRow = new Setting(containerEl)
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
    // 「适用症状说明」放在行名右侧（用户定案），前置一个 info 图标，字号与行名一致。
    // 图标名两套都试：lucide 在 Obsidian 新版本里把 help-circle 改名成 circle-help，
    // 只写一个会在另一版本上画不出图——判据用 childElementCount，画不出来就换名重试。
    const symptomsLink = aedRow.nameEl.createEl('a', {
      cls: 'dsh-aed-symptoms-link',
      text: t('settings.aed.symptomsLink'),
      href: '#',
    })
    const symptomsIcon = symptomsLink.createSpan({ cls: 'dsh-aed-symptoms-icon' })
    setIcon(symptomsIcon, 'help-circle')
    if (symptomsIcon.childElementCount === 0) setIcon(symptomsIcon, 'circle-help')
    symptomsLink.insertBefore(symptomsIcon, symptomsLink.firstChild)
    symptomsLink.addEventListener('click', (e) => {
      e.preventDefault()
      new AedSymptomsModal(this.app).open()
    })

    // 卸载并重装 DSH（保留聊天记录）：红色破坏性按钮，弹强确认
    new Setting(containerEl)
      .setName(t('settings.cleanup.title'))
      .setDesc(t('settings.cleanup.desc'))
      .setClass('dsh-bridge-status-row')
      .addButton((b) =>
        markDestructive(b)
          .setButtonText(t('settings.cleanup.btn'))
          .onClick(() => {
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
          const r = writeBridgeFiles(
            undefined,
            this.plugin.manifest.version,
            this.plugin.settings.profile,
            installModeFor(normalizeBridgeInputMode(this.plugin.settings.bridgeInputMode)),
          )
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

    // v2.8.3：删掉「填充写入方式」下拉开关（用户指示）。
    // 理由：它不是用户能判断的选项——`auto` 本身就已「官方 setDraft 可用则用、不可用静默退回 DOM」，
    // 而 `dom` 只是排障用的内部态；把它摆进设置页等于要求用户替我们承担版本兼容判断。
    // 内部字段 settings.bridgeInputMode 仍保留（默认 auto，决定补丁条目形态 package/path），
    // 需要排障时由代码或 data.json 设置，不再对用户暴露。

    // ---- 高级设置 ----
    // 分区顺序（v2.6.0 重排）：服务运行（最高频调参）→ DSH Profile（决定服务形态，紧随其后）
    // → 更新与安装源（策略 + 镜像源）→ 适配自检（状态类，与下方「诊断」相邻）。
    new Setting(containerEl).setName(t('settings.section.advanced')).setHeading()

    new Setting(containerEl).setName(t('settings.section.service')).setHeading()
    // v2.9.0：分组导语——把「地址/端口/协议=一个端点」讲清，避免用户逐项猜关系
    containerEl.createDiv({ cls: 'setting-item-description', text: t('settings.section.service.desc') })

    // ---- 手机访问配置（v2.9.1，§2/§11；用户要求放在「服务运行」内）----
    // 行名右侧同样挂「使用说明」链接（复制 AED 的 link + setIcon 双名回退写法），
    // 主动点才弹帮助说明；行内两个按钮：生成并填入（预检弹窗 → main.generateMobileAccessConfig）、
    // 恢复默认端点（已是默认值直接 Notice，否则确认弹窗 → main.resetMobileAccessSettings）。
    const mobileRow = new Setting(containerEl)
      .setName(t('settings.mobile.title'))
      .setDesc(t('settings.mobile.desc'))
      .setClass('dsh-bridge-status-row')
      .addButton((b) =>
        b.setButtonText(t('settings.mobile.btn')).onClick(() => {
          new MobileAccessIntroModal(this.app, this.plugin).open()
        }),
      )
      .addButton((b) =>
        b.setButtonText(t('settings.mobile.resetBtn')).onClick(() => {
          if (isDefaultEndpointSettings(this.plugin.settings)) {
            new Notice(t('reset.alreadyDefault'), 6000)
            return
          }
          new MobileAccessResetModal(this.app, {
            certPath: this.plugin.settings.tlsCertPath,
            keyPath: this.plugin.settings.tlsKeyPath,
            onConfirm: async () => {
              await this.plugin.resetMobileAccessSettings()
              new Notice(t('reset.done'), 8000)
            },
          }).open()
        }),
      )
    const mobileHelpLink = mobileRow.nameEl.createEl('a', {
      cls: 'dsh-aed-symptoms-link',
      text: t('settings.mobile.helpLink'),
      href: '#',
    })
    const mobileHelpIcon = mobileHelpLink.createSpan({ cls: 'dsh-aed-symptoms-icon' })
    setIcon(mobileHelpIcon, 'help-circle')
    if (mobileHelpIcon.childElementCount === 0) setIcon(mobileHelpIcon, 'circle-help')
    mobileHelpLink.insertBefore(mobileHelpIcon, mobileHelpLink.firstChild)
    mobileHelpLink.addEventListener('click', (e) => {
      e.preventDefault()
      new MobileAccessHelpModal(this.app).open()
    })

    // v2.9.0 端点顺序：先选「连哪个地址」，再端口、协议，TLS 两项紧随协议；启动命令/运行开关属高级项，统一后置。
    // 连接地址 / 协议 / TLS 与端口一起决定 endpoint（探活、HTTP 请求、iframe、postMessage 全按它工作）。
    new Setting(containerEl)
      .setName(t('settings.host.title'))
      .setDesc(t('settings.host.desc'))
      .addText((tEl) => {
        const applyHost = (raw: string): void => {
          const check = normalizeServiceHost(raw)
          if (!check.ok) {
            new Notice(t('settings.host.invalid'), 10000)
            tEl.setValue(this.plugin.settings.serviceHost)
            return
          }
          this.plugin.settings.serviceHost = check.host
          this.scheduleSave(() => {
            void this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
            paintServiceWarnings()
            this.refreshEndpointRow()
          })
        }
        tEl.setValue(this.plugin.settings.serviceHost).onChange((v) => {
          // 逐字符输入必然经过非法中间态（"192." / "fe80:"）：输入过程中不打扰，
          // 合法值即时落盘（防抖），非法值等失焦 / 回车时统一校验回填。
          if (!normalizeServiceHost(v).ok) return
          applyHost(v)
        })
        tEl.inputEl.addEventListener('blur', () => {
          if (!normalizeServiceHost(tEl.getValue()).ok) applyHost(tEl.getValue())
        })
        tEl.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !normalizeServiceHost(tEl.getValue()).ok) applyHost(tEl.getValue())
        })
      })

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
              this.refreshEndpointRow()
            })
          }
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.scheme.title'))
      .setDesc(t('settings.scheme.desc'))
      .addDropdown((d) =>
        d
          .addOption('http', t('settings.scheme.http'))
          .addOption('https', t('settings.scheme.https'))
          .setValue(this.plugin.settings.serviceScheme)
          .onChange(async (v) => {
            const next: ServiceScheme = v === 'https' ? 'https' : 'http'
            // 插件自己生成默认命令时才会追加 --tls-*：这时缺证书/私钥切 https 必然连不上，直接拒绝并回滚
            if (
              httpsSwitchNeedsPair({
                scheme: next,
                startupCommand: this.plugin.settings.startupCommand,
                tlsCertPath: this.plugin.settings.tlsCertPath,
                tlsKeyPath: this.plugin.settings.tlsKeyPath,
              })
            ) {
              new Notice(t('settings.tls.needPair'), 12000)
              d.setValue(this.plugin.settings.serviceScheme)
              return
            }
            this.plugin.settings.serviceScheme = next
            await this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
            paintServiceWarnings()
            this.refreshEndpointRow()
          }),
      )

    new Setting(containerEl)
      .setName(t('settings.tlsCert.title'))
      .setDesc(t('settings.tlsCert.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.tlsCertPath).onChange((v) => {
          this.plugin.settings.tlsCertPath = v.trim()
          this.scheduleSave(() => {
            void this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
            paintServiceWarnings()
            this.refreshEndpointRow()
          })
        }),
      )

    new Setting(containerEl)
      .setName(t('settings.tlsKey.title'))
      .setDesc(t('settings.tlsKey.desc'))
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.tlsKeyPath).onChange((v) => {
          this.plugin.settings.tlsKeyPath = v.trim()
          this.scheduleSave(() => {
            void this.plugin.saveSettings()
            this.plugin.reconfigureService?.()
            paintServiceWarnings()
            this.refreshEndpointRow()
          })
        }),
      )

    // 条件提示行（局域网暴露 / 自签名信任根 / 缺证书对）：随设置变化重画，不整页刷新（避免打断输入）
    const serviceWarnEl = containerEl.createDiv({ cls: 'setting-item-description' })
    const paintServiceWarnings = (): void => {
      serviceWarnEl.empty()
      const s = this.plugin.settings
      const warnings: string[] = []
      if (!isLoopbackHost(s.serviceHost)) warnings.push(t('settings.host.lanWarn'))
      if (s.serviceScheme === 'https') {
        warnings.push(t('settings.tls.trustHint'))
        if (s.tlsCertPath.trim() === '' || s.tlsKeyPath.trim() === '') warnings.push(t('settings.tls.missingWarn'))
      }
      for (const text of warnings) serviceWarnEl.createDiv({ text })
    }
    paintServiceWarnings()

    // 运行行为（与启动命令/目录分开：这里是常用开关，下面是高级覆盖）
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

    // 高级覆盖：留空由插件生成命令（自动附加端点/TLS 参数），填写则原样使用
    new Setting(containerEl)
      .setName(t('settings.command.title'))
      .setDesc(startupCommandHint())
      .addText((tEl) =>
        tEl.setValue(this.plugin.settings.startupCommand).onChange((v) => {
          const cmd = v.trim()
          // v2.8.7：自定义启动命令是**原样使用**的（main.buildService 只在为空时才生成默认命令），
          // 所以必须挡在这里：填成 `dsh --profile acp`（或 headless/sdk）后插件确实能 spawn 成功，
          // 但那一档不服务 Web GUI、永不监听端口 ⇒ 现象只是"DSH 起不来"，用户看不出是自己填的档名。
          const bad = nonWebProfileInCommand(cmd)
          if (bad !== null) {
            new Notice(t('settings.command.nonWeb', { p: bad, port: String(this.plugin.settings.port) }), 14000)
            tEl.setValue(this.plugin.settings.startupCommand)
            return
          }
          this.plugin.settings.startupCommand = cmd
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
      .addSlider((s) => {
        // 气泡走 ui-compat：1.13 起原成员是空实现（值恒显在滑杆旁），旧版仍需要它
        showSliderValueBubble(s.setLimits(1, 168, 1).setValue(this.plugin.settings.autoCheckIntervalHours))
        return s.onChange(async (v) => {
          this.plugin.settings.autoCheckIntervalHours = Math.max(MIN_AUTO_CHECK_HOURS, Math.round(v))
          await this.plugin.saveSettings()
        })
      })

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
    // v2.8.4：删掉「启动时检查适配」开关——判定不再驱动弹窗，这个开关就没有作用对象了。
    // 结论只写在本页两行文字里（顶部状态横幅 + 下面的「当前适配状态」），细节走「DSH版本适配说明」链接。
    new Setting(containerEl).setName(t('settings.section.compat')).setHeading()

    const compatLine = new Setting(containerEl)
      .setName(t('settings.compat.state.title'))
      .setDesc(t('settings.compat.state.reading'))
    // 判定文案键直接用 compatIssue() 的返回值（同一套字符串，不另立映射表）
    const paintCompatState = (): void => {
      compatLine.setDesc(t('settings.compat.state.reading'))
      void this.plugin.getCompatSnapshot().then((s) => {
        if (s === null) {
          compatLine.setDesc(t('compat.verdict.unknown'))
          return
        }
        const base = t(`compat.verdict.${s.issue ?? 'ok'}`, { v: s.version })
        // v2.8.8：高于实测上界时追加只读触点自检结论（同一缓存，开机预热后通常秒回；仍只是文字，不弹窗）
        const seam = seamLineFor(s.seamScan)
        compatLine.setDesc(seam === '' ? base : `${base} · ${seam}`)
      })
    }
    compatLine.addButton((b) =>
      b.setButtonText(t('settings.compat.recheck')).onClick(() => {
        paintCompatState()
      }),
    )
    paintCompatState()

    // ---- 诊断（启动耗时打点）----
    new Setting(containerEl).setName(t('settings.diag.title')).setHeading()

    // 「连接地址」+「测试连接」（v2.9.0）：把插件**实际会连的**端点摊开给用户看，
    // 并提供一次只读连通性诊断（TCP 探活 + GET /；不改任何设置、不重启服务）。
    // 典型用途：用户已在终端自行拉起 DSH，但插件「识别不了」——一眼看出插件连的是不是那个地址/协议。
    this.connRowSetting = new Setting(containerEl)
      .setName(t('settings.conn.title'))
      .setDesc(endpointLabel(endpointFromSettings(this.plugin.settings)))
      .addButton((b) =>
        b.setButtonText(t('settings.conn.test')).onClick(async () => {
          b.setDisabled(true)
          b.setButtonText(t('settings.conn.testing'))
          const addr = endpointLabel(endpointFromSettings(this.plugin.settings))
          const result = await this.plugin.testServiceConnection()
          new Notice(connectionTestMessage(result, addr), 14000)
          b.setDisabled(false)
          b.setButtonText(t('settings.conn.test'))
        }),
      )


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
