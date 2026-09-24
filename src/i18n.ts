/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- plain dictionary lookups are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
/**
 * 轻量 i18n：中/英双语词典 + 运行时语言切换。
 * - 语言设置：auto（跟随 Obsidian 界面语言）/ zh / en；
 * - t(key, vars?)：取当前语言文案，{name} 占位符用 vars 替换；
 * - 未收录的 key 原样返回（便于开发期发现漏译）。
 */

export type Locale = 'zh' | 'en'
export type LanguageSetting = 'auto' | 'zh' | 'en'

/** [中文, English] */
const dict: Record<string, [string, string]> = {
  // ---- 语言设置 ----
  'settings.language.title': ['界面语言', 'Language'],
  'settings.language.desc': ['插件界面语言；跟随 Obsidian（仅中文/英文，其他语言自动英文）', 'Plugin UI language; follows Obsidian (Chinese or English — any other language falls back to English)'],
  'settings.language.auto': ['跟随 Obsidian', 'Follow Obsidian'],
  'settings.language.zh': ['中文', '中文'],
  'settings.language.en': ['English', 'English'],

  // ---- 状态横幅 ----
  'settings.status.title': ['DSH 状态', 'DSH Status'],
  'settings.status.reading': ['读取中…', 'Reading…'],
  'settings.status.installedVer': ['已安装（{v}） · 服务运行中 ✓', 'Installed ({v}) · running ✓'],
  'settings.status.installed': ['已安装 · 服务运行中 ✓', 'Installed · running ✓'],
  'settings.status.stopped': ['已安装 · 服务未启动', 'Installed · not running'],
  'settings.status.notInstalled': ['未安装', 'Not installed'],
  'settings.status.check': ['检查更新', 'Check for updates'],
  'settings.status.checking': ['检查中…', 'Checking…'],
  'settings.status.changelog': ['更新日志', 'Changelog'],

  // ---- 插件信息（DSH 状态下一栏）----
  'settings.pluginVersion.title': ['插件信息', 'Plugin info'],
  'settings.pluginVersion.installed': ['已安装 v{v}', 'Installed v{v}'],
  'settings.pluginVersion.check': ['检查插件更新', 'Check plugin updates'],
  'settings.pluginVersion.checking': ['打开更新页…', 'Opening updates…'],
  'settings.pluginVersion.changelog': ['更新日志', 'Changelog'],
  'settings.pluginVersion.repoHint': ['使用反馈欢迎留言 💬', 'feedback & issues welcome 💬'],
  'pluginChangelog.title': ['插件更新日志', 'Plugin Changelog'],
  'pluginChangelog.locale': ['zh', 'en'],
  'pluginUpdate.latest': ['插件已是最新版本（v{v}）', 'Plugin is up to date (v{v})'],
  'pluginUpdate.checkFail': ['无法检查插件更新（网络不可达），请稍后重试', 'Cannot check for plugin updates (network unreachable); try again later'],
  'pluginUpdate.updateTitle': ['发现插件新版本', 'Plugin update available'],
  'pluginUpdate.updateBody': ['当前 v{local} → 最新 v{remote}。打开 Obsidian 官方商店页查看；应用内更新在 Obsidian 设置 → 第三方插件 → 检查更新。', 'Current v{local} → latest v{remote}. Open the official Obsidian store page to view; in-app updates are in Obsidian Settings → Community plugins → Check for updates.'],
  'pluginUpdate.goStore': ['打开商店页', 'Open store page'],
  'pluginUpdate.storeHint': ['已打开商店页；更新请在 Obsidian 设置 → 第三方插件 → 检查更新', 'Store page opened; to update, use Obsidian Settings → Community plugins → Check for updates'],

  // ---- 基础设置 ----
  'settings.section.basic': ['基础设置', 'Basic Setup'],
  'settings.install.title': ['一键配置 DSH', 'One-click configure DSH'],
  'settings.install.desc': ['没装过 DeepSeek Harness 就点这个：先确认安装目录，再自动下载、安装、配置。会自动补齐缺失工具（git / Node.js / pnpm）并全局安装 DSH 命令行工具 dsh；已有 DSH 但缺依赖/CLI 也会自动补齐，几分钟搞定', 'Never installed DeepSeek Harness? Click this: confirm the directory, then it downloads, installs and configures everything. It fills in missing tools (git / Node.js / pnpm) and installs the global DSH CLI; if DSH already exists but tools/CLI are missing, it fills them in automatically. A few minutes, no command line'],
  'settings.install.btn': ['一键配置DSH', 'Configure DSH'],
  'settings.install.preparing': ['准备中…', 'Preparing…'],
  'settings.detect.title': ['一键检测配置', 'Detect & apply config'],
  'settings.detect.desc': ['已经装过 DSH 的，自动找到位置并填好配置', 'Already have DSH? Auto-detect its location and fill in the config'],
  'settings.detect.btn': ['检测并填充', 'Detect & fill'],
  'settings.detect.progress': ['检测中…', 'Detecting…'],
  'settings.installDir.title': ['安装目录', 'Install directory'],
  'settings.installDir.desc': ['DSH 安装位置；本机已有 DSH 时自动填入检测到的路径', 'Where DSH is installed; auto-filled when a local DSH is detected'],
  // v2.3.0：移除「自动检查更新」——DSH ≥0.1.2 认证未适配前不自动打扰，更新检查仅手动触发

  // ---- 快捷操作 ----
  'settings.section.quick': ['快捷功能', 'Quick actions'],
  'settings.reconnect.title': ['重连服务', 'Reconnect service'],
  'settings.reconnect.desc': ['DSH 面板加载失败或卡住时，重新探测并刷新面板', 'When the DSH panel fails to load or hangs, re-probe and refresh the panel'],
  'settings.reconnect.btn': ['刷新', 'Refresh'],
  'settings.browser.title': ['在浏览器打开 DSH', 'Open DSH in browser'],
  'settings.browser.desc': ['用系统默认浏览器打开 DSH Web GUI（独立窗口，不受 Obsidian 面板限制）', 'Open the DSH Web GUI in your default browser (separate window, not constrained by the Obsidian panel)'],
  'settings.browser.btn': ['打开浏览器', 'Open browser'],
  'settings.aed.title': ['AED for DSH', 'AED for DSH'],
  'settings.aed.desc': ['以安全模式启动 DSH 抢救：先检查插件健康（异常插件临时禁用，退出时自动恢复），完成后校验启动，异常可弹窗一键修复', 'Rescue DSH in safe mode: checks plugin health (broken plugins temporarily disabled, auto-restored on exit), verifies boot afterwards, and offers one-click fixes'],
  'settings.aed.btn': ['AED 抢救', 'AED'],
  'settings.exitSafeMode.btn': ['退出安全模式', 'Exit safe mode'],

  // ---- 桥接（状态与发送开关）----
  'settings.section.send': ['桥接', 'Bridge'],
  'settings.send.openPanel.title': ['Obsidian 桥接到 DSH 聊天框', 'Bridge Obsidian → DSH chat'],
  'settings.send.openPanel.desc': ['开启后，框选笔记文字右键即可发送到 DSH 聊天框（命令面板同样可用）；发送后自动打开 DSH 面板查看处理', 'When enabled, select text in a note and right-click to send it to the DSH chat (command palette works too); the DSH panel opens automatically after sending'],
  'settings.bridge.toObsidian.title': ['DSH 聊天框桥接到 Obsidian', 'Bridge DSH chat → Obsidian'],
  'settings.bridge.toObsidian.desc': ['控制 DSH 与 Obsidian 之间的桥接：自动发送（框选文字自动以隐式信息行注入聊天框，含精确行:列与字数，不含原文）、右键发送（仅通过右键菜单/命令发送）、取消（关闭桥接）；非「取消」时 DSH 产物中的库内可读路径点击即可在 Obsidian 打开', 'Controls the bridge between DSH and Obsidian: Auto-send (selecting text injects an implicit info line with exact line:col and word count, without the original text), Right-click send (only via the context menu/command), or Off (disabled). When not Off, in-vault readable paths in DSH output open in Obsidian with one click'],
  'settings.bridge.toObsidian.off': ['取消', 'Off'],
  'settings.bridge.toObsidian.auto': ['自动发送', 'Auto-send'],
  'settings.bridge.toObsidian.rightClick': ['右键发送', 'Right-click send'],
  'settings.bridge.status.title': ['桥接状态', 'Bridge status'],
  'settings.bridge.status.installedReady': ['文件已安装；已加载且生效 ✓\n1. 框选文字自动注入隐式信息行（精确位置 + 字数，不含原文）到 DSH 聊天框\n2. DSH 中的库内可读路径可点击在 Obsidian 打开\n3. 光标在 DSH 面板内时，Obsidian 全局快捷键仍可响应（iframe 快捷键透传）', 'Installed; loaded and working ✓\n1. Selected text auto-injects an implicit info line (exact position + word count, no original text) into the DSH chat\n2. In-vault readable paths in DSH open in Obsidian with one click\n3. Obsidian global shortcuts still work while focus is inside the DSH panel (iframe shortcut passthrough)'],
  'settings.bridge.status.installedNotReady': ['文件已安装；未生效（重启 DSH 服务后生效）', 'Installed; not working yet (takes effect after restarting the DSH service)'],
  'settings.bridge.status.notInstalled': ['未安装', 'Not installed'],
  'settings.bridge.restart.title': ['重启 DSH 服务', 'Restart DSH service'],
  'settings.bridge.restart.desc': ['结束占用端口的进程（含常驻进程）并重新启动；用于加载桥接补丁。注意：会中断当前正在运行的任务', 'Kill the process on the port (including detached ones) and restart; used to load the bridge patch. Note: this interrupts running tasks'],
  'settings.bridge.restart.btn': ['重启服务', 'Restart'],
  'settings.bridge.restart.progress': ['重启中…', 'Restarting…'],
  'settings.bridge.rewrite.btn': ['重新写入', 'Rewrite'],
  'settings.repair.title': ['会话格式修复（旧会话打不开时用）', 'Session format repair (for unreadable old sessions)'],
  'settings.repair.desc': ['DSH 升级后旧会话可能因格式漂移不可读。点击打开预检：只读体检 → 备份并修复（用 DSH 自带迁移链复验后才写盘）。', 'After a DSH upgrade, older sessions may become unreadable due to format drift. Open the checker: read-only scan → back up and repair (writes only after DSH\'s own migration chain validates).'],
  'settings.bridge.rewrite.fail': ['桥接写入失败：{err}', 'Failed to write bridge files: {err}'],
  'settings.bridge.rewrite.updated': ['桥接文件已更新，重启 DSH 服务后生效', 'Bridge files updated; restart the DSH service to apply'],
  'settings.bridge.rewrite.ready': ['桥接文件已就绪', 'Bridge files ready'],

  // ---- 面板显示 ----
  'settings.section.panel': ['面板显示', 'Panel display'],
  'settings.zoom.title': ['页面缩放', 'Page zoom'],
  'settings.zoom.desc': ['DSH 页面缩放比例', 'DSH page zoom'],
  'settings.bottomPad.title': ['底部垫高', 'Bottom padding'],
  'settings.bottomPad.desc': ['面板底部留白（防状态栏遮挡）', 'Panel bottom padding (prevents status-bar overlap)'],
  'settings.passthrough.title': ['iframe 内快捷键透传', 'Pass through shortcuts in iframe'],
  'settings.passthrough.desc': ['开启后，光标聚焦在 DSH 面板内时 Obsidian 全局快捷键仍可响应（自动遍历 Obsidian 当前快捷键设置）；修改快捷键或本开关后，需重启 DSH 服务生效', 'When enabled, Obsidian global shortcuts still work while focus is inside the DSH panel (auto-reads your current Obsidian hotkey settings); restart the DSH service after changing hotkeys or this switch'],

  // ---- 高级设置 ----
  'settings.section.advanced': ['高级设置', 'Advanced'],
  // v2.6.0 高级设置重排：四个子分区（服务运行 → Profile → 更新与安装源 → 适配自检）
  'settings.section.service': ['服务运行', 'Service runtime'],
  'settings.section.profile': ['DSH Profile（多档共存）', 'DSH profile (multi-profile coexistence)'],
  'settings.section.update': ['更新与安装源', 'Updates & install sources'],
  'settings.section.compat': ['适配自检', 'Compatibility self-check'],
  'settings.profile.title': ['DSH Profile（配置档）', 'DSH profile'],
  'settings.profile.desc': [
    '面板服务与桥接所在的 DSH profile，默认 web。使用非 web profile（如 test）时：插件自动基于 web 创建该 profile、把桥接装入其中、启动命令改用 dsh --profile <名> 形态，可与桌面版等其他实例跨端口共存（会话存储本机共享）。',
    'The DSH profile the panel service and bridge belong to (default: web). For a non-web profile (e.g. test): the plugin creates it from the web template, installs the bridge into it, launches it as dsh --profile <name>, and coexists with other instances (e.g. the desktop app) on a separate port — session storage is shared machine-wide.',
  ],
  'settings.profile.invalid': ['profile 名不合法：{name}（须小写字母开头，仅限 a-z 0-9 _ -，≤64 字符）', 'Invalid profile name: {name} (must start with a lowercase letter; a-z 0-9 _ - only; ≤64 chars)'],
  'settings.profile.reserved': ['「{name}」是 DSH 内置配置档，不能作为面板的自定义 profile（它会启动另一种应用形态，且不可代建）——请换一个名字，如 test', '"{name}" is a built-in DSH profile: it boots a different app form and cannot be created — pick another name, e.g. test'],
  'settings.profile.warnPort': ['提示：非 web profile 建议改用独立端口（如 3081），避免与桌面版（常见为 3080）冲突', 'Note: a non-web profile should use its own port (e.g. 3081) to avoid colliding with other instances (commonly the desktop app on 3080)'],
  'settings.profile.warnCmdMismatch': ['提示：你的自定义启动命令不含 --profile，实际启动的仍是原 profile——留空该命令可让插件按所选 profile 自动生成', 'Note: your custom startup command has no --profile flag, so it still boots the original profile — clear the command to let the plugin generate one for the selected profile'],
  // ---- v2.6.0：profile 选择控件（下拉 + 新建）----
  'settings.profile.pick': ['当前 Profile', 'Current profile'],
  'settings.profile.pickDesc': ['列出本机已有的 DSH profile；切换会重建服务并改写默认启动命令，切换前会先询问', 'Lists the profiles that exist on this machine; switching rebuilds the service and rewrites the default startup command, and asks first'],
  'settings.profile.default': ['默认档', 'default'],
  'settings.profile.newName': ['新建 Profile', 'New profile'],
  'settings.profile.newNameDesc': ['输入新名字后点「新建并切换」：插件会基于 web 模板代建该 profile、把桥接装进去，并在独立端口拉起（与桌面版共存）', 'Type a name and press Create: the plugin clones it from the web template, installs the bridge into it and starts it on its own port (coexisting with the desktop app)'],
  'settings.profile.newNamePlaceholder': ['如 test（小写字母开头，仅限 a-z 0-9 _ -）', 'e.g. test (lowercase letter first; a-z 0-9 _ - only)'],
  'settings.profile.create': ['新建并切换', 'Create & switch'],
  // ---- v2.6.0：更新通道与自动检查（重开自动更新）----
  'settings.updateChannel.title': ['DSH 更新通道', 'DSH update channel'],
  'settings.updateChannel.desc': ['DSH 目前只发布预版本（无正式版），故默认跟随官方主推版本。通道越靠前越保守', 'DSH has no stable releases yet, so the plugin follows the officially pushed version by default. Earlier channels are more conservative'],
  'settings.updateChannel.stable': ['仅正式版（最保守，官方发版前等于不更新）', 'Stable only (most conservative; effectively no updates until an official stable release)'],
  'settings.updateChannel.preview': ['跟随主推版本（含 rc/beta，默认）', 'Follow the pushed version (rc/beta included; default)'],
  'settings.updateChannel.dev': ['含 alpha（最激进，可能遇到未适配问题）', 'Include alpha (most aggressive; may hit unadapted changes)'],
  'settings.autoCheck.title': ['启动后自动检查 DSH 更新', 'Check DSH updates after startup'],
  'settings.autoCheck.desc': ['只检查并弹确认框，绝不静默安装——更新会先结束本机全部 DSH 进程（含桌面版）', 'The plugin only checks and asks; it never installs silently — updating stops all local DSH processes (including the desktop app)'],
  'settings.autoCheckInterval.title': ['自动检查间隔', 'Auto-check interval'],
  'settings.autoCheckInterval.desc': ['距上次自动检查不足 {h} 小时则跳过（手动「检查更新」不受限制）', 'Skip the automatic check if the last one is within {h} hours (manual "Check for updates" is unaffected)'],
  // ---- v2.6.0：适配体检 ----
  'settings.compat.title': ['启动时检查适配', 'Check compatibility on startup'],
  'settings.compat.desc': ['启动后核对本机 DSH 版本是否在插件适配范围内、桥接是否真正生效；有问题弹窗提示并给出处置按钮（同种问题 24 小时内只弹一次）', 'After startup, verify the local DSH version is within the plugin’s supported range and that the bridge is actually live; problems are reported in a dialog with fix actions (each issue is shown at most once per 24h)'],
  'settings.compat.recheck': ['重新检查适配', 'Re-check now'],
  'settings.compat.state.title': ['当前适配状态', 'Current compatibility'],
  'settings.compat.state.reading': ['核对中…', 'Checking…'],
  // 判定文案：键名与 compat.compatIssue() 返回值一一对应
  'compat.verdict.ok': ['本机 {v} ✓ 已适配', 'Local {v} ✓ supported'],
  'compat.verdict.incompatible': ['本机 {v} ✗ 落在插件已知不兼容区间', 'Local {v} ✗ within a known-incompatible range'],
  'compat.verdict.legacy': ['本机 {v} ⚠ 旧版可用（缺少新版桥接前提）', 'Local {v} ⚠ legacy (missing the newer bridge prerequisites)'],
  'compat.verdict.untested': ['本机 {v} ⚠ 比插件实测适配版本更新，尚未验证', 'Local {v} ⚠ newer than the plugin’s verified range'],
  'compat.verdict.bridge-not-installed': ['本机 {v} · 桥接未安装（跨向功能不可用）', 'Local {v} · bridge not installed (cross-panel features unavailable)'],
  'compat.verdict.bridge-not-live': ['本机 {v} · 桥接未生效（DSH 服务需重启）', 'Local {v} · bridge not live (restart the DSH service)'],
  // 状态横幅用的极简语气标记（横幅已有版本号，这里只给判定结论）。
  // 符号一律**后置**，与同栏「服务运行中 ✓」的构词保持一致（v2.6.0 用户定案）。
  'compat.tone.ok': ['已适配 ✓', 'supported ✓'],
  'compat.tone.incompatible': ['已知不兼容 ✗', 'known-incompatible ✗'],
  'compat.tone.legacy': ['版本偏旧 ⚠', 'outdated ⚠'],
  'compat.tone.untested': ['新于实测范围 ⚠', 'newer than verified ⚠'],
  'compat.tone.bridge-not-installed': ['桥接未安装 ⚠', 'bridge missing ⚠'],
  'compat.tone.bridge-not-live': ['桥接未生效 ⚠', 'bridge not live ⚠'],
  'compat.tone.unknown': ['版本未判定 ?', 'version unresolved ?'],
  // 插件信息栏「DSH 版本适配说明」超链接与其弹窗
  'settings.pluginVersion.compatLink': ['DSH版本适配说明', 'DSH version compatibility'],
  'compat.explain.title': ['DSH 版本适配说明', 'DSH version compatibility'],
  'compat.explain.close': ['关闭', 'Close'],
  'compat.explain.bulletRange': ['插件按 DSH 版本**逐版实测**后才声明适配，当前实测区间：{range}（0.1.5 系为真机实测，0.1.6-alpha.1 为隔离沙盒实跑）。', 'Compatibility is declared only after the plugin is tested against a specific DSH version. Currently verified: {range} (the 0.1.5 line on a real machine; 0.1.6-alpha.1 in an isolated sandbox run).'],
  'compat.explain.bulletBad': ['0.1.2–0.1.4 已知不兼容（浏览器会话认证叠加上游会话缓存/列表缺陷），更新弹窗会在安装前红字劝退。', '0.1.2–0.1.4 are known incompatible (browser session auth combined with upstream session cache/list defects); the update dialog warns in red before installing them.'],
  'compat.explain.bulletLegacy': ['0.1.1 及更早为旧版可用：面板能开，但缺少 0.1.5+ 的桥接写入前提，框选注入与面板内上传不可用。', '0.1.1 and earlier still open the panel, but lack the 0.1.5+ prerequisites for bridge writing, so selection injection and in-panel uploads do not work.'],
  'compat.explain.bulletNewer': ['高于实测上界＝插件可能尚未跟上：DSH 迭代很快，每次发布都可能改动插件依赖的内部接缝。功能异常时先检查插件更新。', 'Above the verified upper bound means the plugin may not have caught up yet: DSH iterates fast and every release can move the internal seams the plugin relies on. Check for a plugin update first when something misbehaves.'],
  'compat.explain.bulletBridge': ['桥接判定看的是 DSH **实际返回的页面**里有没有注入脚本，不是磁盘上有没有文件——补丁层只在服务启动时加载，"文件是新的、页面跑旧脚本"必须重启服务才会好。', 'The bridge verdict inspects the page DSH actually serves for the injected script, not whether a file exists on disk — the patch layer is loaded only at service start, so "new file, old script in the page" needs a service restart.'],
  'compat.title.incompatible': ['本机 DSH 版本与插件不适配', 'Your DSH version is not compatible with this plugin'],
  'compat.title.legacy': ['本机 DSH 版本偏旧', 'Your DSH version is outdated'],
  'compat.title.untested': ['本机 DSH 版本新于插件适配范围', 'Your DSH is newer than what this plugin verified'],
  'compat.title.bridgeMissing': ['DSH 桥接未安装', 'DSH bridge is not installed'],
  'compat.title.bridgeNotLive': ['DSH 桥接未生效', 'The DSH bridge is not live'],
  'compat.title.generic': ['适配检查', 'Compatibility check'],
  'compat.body.incompatible': ['本机 DSH 为 {v}，落在插件已知不兼容的区间（已适配范围：{range}）。面板可能能开，但桥接、上传等跨面板能力不保证可用。', 'Local DSH is {v}, inside a range this plugin knows to be incompatible (supported: {range}). The panel may open, but bridge, uploads and other cross-panel features are not guaranteed.'],
  'compat.body.legacy': ['本机 DSH 为 {v}，早于插件的适配范围（{range}）。旧版能启动面板，但聊天框与认证机制差异会使桥接与面板内上传不可用。', 'Local DSH is {v}, older than the supported range ({range}). The panel still opens, but differences in the composer and auth make the bridge and in-panel uploads unavailable.'],
  'compat.body.untested': ['本机 DSH 为 {v}，比插件实测适配的上界（{range}）更新。DSH 迭代很快，插件需要时间跟上适配；若桥接、上传等功能异常，先检查插件更新。', 'Local DSH is {v}, newer than the plugin’s verified upper bound ({range}). DSH iterates fast and the plugin needs time to catch up; if the bridge, uploads or other features misbehave, check for a plugin update first.'],
  'compat.body.bridgeMissing': ['插件未能把桥接补丁安装到 profile「{profile}」。没有桥接，框选注入、路径回跳、面板内上传都不可用。', 'The plugin could not install its bridge patch into the “{profile}” profile. Without it, selection injection, path jump-back and in-panel uploads do not work.'],
  'compat.body.bridgeNotLive': ['桥接文件已在磁盘上，但 DSH 实际返回的页面里没有它——服务跑的还是旧脚本（未重启，或被旧版插件覆盖回写）。profile「{profile}」。', 'The bridge files are on disk but the page DSH actually serves does not contain them — the service is still running an older script (not restarted, or overwritten by an older plugin build). Profile “{profile}”.'],
  'compat.danger.incompatible': ['建议先把 DSH 更新到已适配版本；若你已在用该版本且功能正常，可忽略本提醒。', 'Updating DSH into the supported range is recommended; if this version already works for you, you may ignore this.'],
  'compat.danger.bridgeRestartNeeded': ['重新写入后必须**重启 DSH 服务**才会生效（补丁层只在服务启动时加载）。', 'After rewriting you must **restart the DSH service** — the patch layer is only loaded at service startup.'],
  'compat.danger.bridgeNotLive': ['此刻跨面板功能均不可用；彻底重启 Obsidian（避免旧插件回写）再重启服务才能恢复。', 'Cross-panel features are unavailable right now; fully restart Obsidian (so an older plugin build cannot overwrite the bridge) and then restart the service.'],
  'compat.detail': ['本机 DSH：{v}｜适配范围：{range}｜profile：{profile}｜端口：{port}', 'Local DSH: {v} | supported: {range} | profile: {profile} | port: {port}'],
  'compat.act.updateDsh': ['检查 DSH 更新', 'Check DSH updates'],
  'compat.act.checkPlugin': ['检查插件更新', 'Check plugin updates'],
  'compat.act.rewriteBridge': ['重新写入桥接', 'Rewrite bridge'],
  'compat.act.restartService': ['重启 DSH 服务', 'Restart DSH service'],
  'compat.act.docs': ['查看说明', 'Read the notes'],
  'compat.ok': ['适配正常：本机 DSH {v}，插件适配范围 {range}', 'Compatibility looks fine: local DSH {v}, plugin range {range}'],
  // v2.7.0（A2）：0.1.7 起「会话格式修复」对跨版本会话只报告不改写（能力差异，非不兼容）
  'compat.repairLimited': ['能力差异：本 DSH 版本上，格式低于当前版本的旧会话由 DSH 打开时按官方迁移链自行升级，插件的「会话格式修复」对这类会话只报告、不改写', 'Capability note: on this DSH version, sessions in an older format are migrated by DSH itself when opened; the plugin session-format repair only reports them and never rewrites them'],
  'compat.muted': ['今天不再提醒同类问题（可在插件设置里重新检查或关闭提醒）', 'Similar issues will not interrupt you today (re-check or disable in plugin settings)'],
  'compat.muteToday': ['今天不再提示', 'Don’t show again today'],
  'modal.profileSwitchTitle': ['切换 DSH Profile？', 'Switch the DSH profile?'],
  'modal.profileSwitchBody': ['当前「{from}」→ 目标「{to}」。插件会代建（如需）、把桥接装进该 profile、改写默认启动命令并重建服务；会话存储为本机共享，不会丢会话。', 'From “{from}” to “{to}”. The plugin will create it if needed, install the bridge into it, rewrite the default startup command and rebuild the service. Session storage is shared machine-wide, so nothing is lost.'],
  'modal.profileSwitchDanger': ['服务会重启，面板正在跑的任务会被中断；端口若与其他实例相冲，插件不会抢端口而是提示你改。', 'The service restarts and any running panel task is interrupted; if the port collides with another instance, the plugin will not take it over but tell you to change it.'],
  'modal.profileSwitchConfirm': ['切换并重启服务', 'Switch & restart'],
  'settings.port.title': ['服务端口', 'Service port'],
  'settings.port.desc': ['DSH Web GUI 监听端口，默认 3080', 'Port the DSH Web GUI listens on; default 3080'],
  'settings.command.title': ['启动命令', 'Startup command'],
  'settings.command.hint': ['示例：pnpm dsh web --port {port}（{port} 自动替换为端口；若 dsh 在 PATH 中可留空自动探测；用 pnpm 启动时请把工作目录设为 DSH 仓库路径）', 'Example: pnpm dsh web --port {port} ({port} is replaced automatically; leave empty to auto-detect when dsh is on PATH; set the working directory to the DSH repo when using pnpm)'],
  'settings.cwd.title': ['工作目录', 'Working directory'],
  'settings.cwd.desc': ['启动 DSH 时的工作目录（DSH 工作区）；留空为 Vault 根目录', 'Working directory used to start DSH (the DSH workspace); empty means the Vault root'],
  'settings.autoStart.title': ['离线时自动启动', 'Auto-start when offline'],
  'settings.autoStart.desc': ['打开面板时若端口无服务，自动运行启动命令', 'Automatically run the startup command when the port has no service'],
  'settings.detached.title': ['进程独立常驻', 'Detached persistent process'],
  'settings.detached.desc': ['开启后，插件启动的 DSH 进程在 Obsidian 退出后继续运行（默认开启）；关闭后随 Obsidian 退出而终止', 'When on (default), the DSH process started by the plugin keeps running after Obsidian exits; when off, it terminates with Obsidian'],
  'settings.readyTimeout.title': ['启动等待时间', 'Startup timeout'],
  'settings.readyTimeout.desc': ['自动启动后等待服务就绪的最长时间（当前 {s} 秒）；首次启动可能需要 1–2 分钟', 'Max time to wait for the service after auto-start (currently {s}s); first start may take 1–2 minutes'],
  'settings.installUrl.title': ['安装地址', 'Install URL'],
  'settings.installUrl.desc': ['克隆仓库地址；默认官方仓库，网络受限时可换代理镜像（如 https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git）', 'Repo URL to clone; defaults to the official repo. Behind a restricted network, switch to a proxy mirror (e.g. https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git)'],

  // ---- 面板视图 ----
  'view.action.reconnect': ['重连服务', 'Reconnect'],
  'view.action.openBrowser': ['在浏览器中打开 DSH', 'Open DSH in browser'],
  'view.monitor.disconnected': ['连接已断开：{msg}', 'Disconnected: {msg}'],
  'view.loading.title': ['正在启动 DeepSeek Harness…', 'Starting DeepSeek Harness…'],
  'view.loading.detail': ['首次启动可能需要一两分钟，请稍候', 'The first start may take a minute or two, please wait'],
  'view.copy.copied': ['命令已复制', 'Command copied'],
  'view.copy.failed': ['复制失败，请手动复制', 'Copy failed, please copy manually'],
  'view.install.title': ['还没安装 DeepSeek Harness', 'DeepSeek Harness is not installed yet'],
  'view.install.desc': ['点一下自动安装：会自动下载 DeepSeek Harness 并配好一切，全程不用碰命令行。', 'Click to install automatically: it downloads DeepSeek Harness and sets everything up — no command line needed.'],
  'view.install.mark.ok': ['✓ 已安装', '✓ Installed'],
  'view.install.mark.missing': ['✗ 未安装', '✗ Missing'],
  'view.install.depsHint': ['上面有缺失的工具，先点下面的按钮装上（需要授权时按提示允许）：', 'Some tools above are missing — install them with the buttons below (approve the prompts when asked):'],
  'view.install.git': ['一键安装 git', 'Install git'],
  'view.install.node': ['一键安装 Node.js', 'Install Node.js'],
  'view.install.pnpm': ['一键安装 pnpm', 'Install pnpm'],
  'view.install.btn': ['一键配置DSH', 'Configure DSH'],
  'view.install.installing': ['安装中…', 'Installing…'],
  'view.install.done': ['安装完成（已自动刷新环境变量，无需重启）', 'Installed (PATH refreshed automatically; no restart needed)'],
  'view.install.preparing': ['准备中…', 'Preparing…'],
  'view.install.starting': ['安装完成，正在启动…', 'Installed, starting…'],

  // ---- DSH 睡着了（等待重连界面）----
  'view.asleep.name': ['DSH for Obsidian', 'DSH for Obsidian'],
  'view.asleep.status': ['你的 DSH 睡着了，请尝试唤醒', 'Your DSH is asleep — try to wake it up'],
  'view.asleep.hint': ['小提示：DSH 生态尚未完善，有机会因为插件冲突或插件卸载残留等问题导致无法连接。', 'Tip: The DSH ecosystem is still maturing; connection can fail due to plugin conflicts or leftover files from uninstalled plugins.'],
  'view.asleep.wake': ['唤醒干活', 'Wake it up'],
  'view.asleep.aed': ['AED for DSH', 'AED for DSH'],
  'view.asleep.aedConfirm': ['插件将下载并执行dsh-fix，尝试以安全模式进行DSH。\n请用户进入DSH后指令DSH进行自行修复，并退出安全模式。', 'The plugin will download and run dsh-fix to try operating DSH in safe mode.\nAfter entering DSH, instruct DSH to repair itself, then exit safe mode.'],
  'view.asleep.aedConfirmBtn': ['确认执行', 'Confirm & run'],
  'view.asleep.aedCancel': ['取消', 'Cancel'],
  'view.asleep.askAi': ['问问 AI', 'Ask AI'],
  'view.asleep.more': ['更多设置', 'More settings'],
  // ---- v2.3.1 认证拦截引导卡（面板内嵌不可用时）----
  'view.blocked.title': ['内嵌界面暂不可用', 'Embedded panel unavailable'],
  'view.blocked.desc': ['DSH 新版启用了浏览器会话认证，当前插件的嵌入适配暂时未能生效（多为 DSH 更新后接口变动，等待插件更新适配）。笔记发送与桥接功能不受影响；点「在浏览器打开 DSH」可完整使用。', 'The newer DSH enables browser-session authentication and the plugin embed adapter is not currently active (typically after a DSH interface change; a plugin update restores it). Note sending and bridge features still work; use "Open DSH in browser" for the full interface.'],
  'view.blocked.openBrowser': ['在浏览器打开 DSH', 'Open DSH in browser'],
  'view.blocked.retry': ['重新加载', 'Reload'],
  'view.wait.title': ['DSH 服务启动中…', 'Starting the DSH service…'],
  'view.wait.desc': ['就绪后面板会自动显示，无需手动刷新。冷启动可能需要十几秒到一分钟（取决于已装插件数量）。', 'The panel appears automatically once ready — no manual refresh needed. A cold start can take tens of seconds depending on installed plugins.'],
  'notice.bridgeScriptStale': ['注入脚本为旧版本（未上报界面状态）：白屏自动恢复暂时无效，请到设置页点一次「重启 DSH 服务」', 'The injected script is outdated (no UI-state reporting), so blank-panel auto-recovery is inactive. Click "Restart DSH service" once in settings'],
  'notice.injectStormStopped': ['桥接注入已达单会话上限（{n} 次）并自动停止：本次会话此前可能因反复框选而过度注入。建议新建会话继续使用；若需再次注入同一选区，请修改选区或指令文本。', 'Bridge injection hit the per-session cap ({n}) and stopped automatically: this session was likely over-injected by repeated selections. Start a new session to continue; to inject the same selection again, change the selection or the instruction text.'],
  'notice.linkNotFound': ['未找到笔记：{target}（不存在，或不在当前库内）', 'Note not found: {target} (missing, or outside the current vault)'],

  // ---- AED for DSH（抢救工具）----
  'aed.checkFix': ['检查 dsh-fix…', 'Checking dsh-fix…'],
  'aed.installFix': ['正在安装 dsh-fix…', 'Installing dsh-fix…'],
  'aed.installFixMirror': ['官方源不可达，改用镜像安装…', 'Official registry unreachable; trying the mirror…'],
  'aed.installFixDone': ['dsh-fix 已就绪', 'dsh-fix ready'],
  'aed.installFixFail': ['dsh-fix 安装失败：{err}', 'dsh-fix install failed: {err}'],
  'aed.fallbackNpx': ['全局安装失败，改用 npx 临时运行…', 'Global install failed; using npx temporarily…'],
  'aed.doctor': ['dsh-fix doctor 诊断中…', 'Running dsh-fix doctor…'],
  'aed.doctorNoDetail': ['（诊断无明细）', '(no diagnostic detail)'],
  'aed.safeMode': ['进入安全模式（禁用用户插件）…', 'Entering safe mode (disabling user plugins)…'],
  'aed.safeFail': ['安全模式启动失败：{err}', 'Safe mode failed: {err}'],
  'aed.safeDone': ['已进入安全模式：{diag}', 'Safe mode entered: {diag}'],
  'aed.disableBundles': ['禁用 bundle 层用户插件…', 'Disabling bundle-layer user plugins…'],
  'aed.disableBundlesFail': ['禁用 bundle 层用户插件失败：{err}', 'Failed to disable bundle-layer user plugins: {err}'],
  'aed.safeBundles': ['；bundle 层用户插件已一并禁用：{list}', '; bundle-layer user plugins also disabled: {list}'],
  'aed.done': ['AED 抢救完成', 'AED recovery done'],
  'aed.running': ['AED 抢救进行中…', 'AED recovery in progress…'],
  'aed.exitSafeMode': ['退出安全模式（恢复用户插件）…', 'Exiting safe mode (restoring user plugins)…'],
  'aed.exitSafeFail': ['退出安全模式失败：{err}', 'Exiting safe mode failed: {err}'],
  'aed.exitBundleFail': ['恢复 bundle 层用户插件失败：{err}', 'Failed to restore bundle-layer user plugins: {err}'],
  'aed.exitSafeDone': ['已退出安全模式，全部用户插件已恢复（含 bundle 层）', 'Exited safe mode; all user plugins restored (including bundle layer)'],
  // ---- AED 启动校验与一次性修复（v2.1.0）----
  'aed.bootVerify': ['正在校验 DSH 启动…', 'Verifying DSH boot…'],
  'aed.takesTime': ['（抓取页面校验，可能需要数秒）', '(page fetch check; may take a few seconds)'],
  'aed.bootVerifyOk': ['启动校验通过 ✓（页面注入完整）', 'Boot check passed ✓ (page injection intact)'],
  'aed.verifyModalTitle': ['检测到 DSH 启动异常', 'DSH boot issue detected'],
  'aed.modal.type': ['错误类型', 'Error type'],
  'aed.modal.reason': ['判断', 'Assessment'],
  'aed.modal.fix': ['建议动作', 'Suggested action'],
  'aed.modal.apply': ['执行修复（仅一次）', 'Apply fix (once only)'],
  'aed.modal.understood': ['知道了', 'Got it'],
  'aed.modal.detail': ['错误详情：{detail}', 'Error detail: {detail}'],
  'aed.kind.client-modules': ['客户端模块加载失败（client-modules）', 'Client modules failed to load (client-modules)'],
  'aed.kind.bundle-face': ['启动引导模块异常（bootstrap module face）', 'Bootstrap module face error'],
  'aed.kind.patch-parse': ['补丁配置解析失败（cordis.patch.yml）', 'Patch config parse error (cordis.patch.yml)'],
  'aed.kind.plugin-missing': ['插件文件缺失', 'Plugin files missing'],
  'aed.kind.init-crash': ['服务初始化崩溃', 'Service initialization crash'],
  'aed.kind.unreachable': ['服务未响应', 'Service unreachable'],
  'aed.kind.other': ['其他异常', 'Other error'],
  'aed.reason.client-modules': ['页面缺少 DSH 启动引导注入（__DSH_BOOT__ / client.js）。常见原因：安全模式残留禁用了桥接插件，或客户端模块被禁用/未构建', 'The page is missing the DSH boot injection (__DSH_BOOT__ / client.js). Common causes: safe-mode leftovers disabled the bridge plugin, or the client module is disabled/unbuilt'],
  'aed.reason.bundle-face': ['client.js 未导出启动模块。常见原因：客户端模块被禁用，或仓库形态下未构建（需 pnpm run build）', 'client.js does not export the bootstrap module. Common causes: a disabled client module, or an unbuilt repo form (needs pnpm run build)'],
  'aed.reason.patch-parse': ['cordis.patch.yml 存在解析错误，补丁层（插件）可能整体未加载', 'cordis.patch.yml has a parse error; the patch layer (plugins) may not load at all'],
  'aed.reason.plugin-missing': ['有插件引用的文件缺失，DSH 可能拒绝启动', 'A plugin file referenced is missing; DSH may refuse to boot'],
  'aed.reason.init-crash': ['DSH 初始化阶段崩溃，可能与插件冲突或配置损坏有关', 'DSH crashed during initialization — likely a plugin conflict or corrupted config'],
  'aed.reason.unreachable': ['重启后 DSH 未在预期端口响应，请确认服务是否真的启动', 'DSH did not respond on the expected port after restart — confirm the service actually started'],
  'aed.reason.other': ['未能识别具体原因，请查看下方错误详情', 'Could not identify the cause; see the error detail below'],
  'aed.fix.patch': ['重建桥接补丁（自愈安全模式残留的禁用块）并移除历史残留的 bundle 禁用块，然后重启 DSH 服务复验。仅尝试一次。', 'Rewrite the bridge patch (healing safe-mode disable leftovers) and remove stale bundle disable blocks, then restart the DSH service to re-verify. Attempted once.'],
  'aed.fix.none': ['此错误无法自动修复。请尝试其他方式：dsh-fix doctor / bisect，或重装 DSH。', 'This error cannot be auto-fixed. Try other approaches: dsh-fix doctor / bisect, or reinstall DSH.'],
  'aed.fix.done': ['修复完成，启动校验通过 ✓', 'Fix applied; boot check passed ✓'],
  'aed.fix.fail': ['修复后仍为同类错误，不再自动重试。', 'Same error after the fix; no automatic retry.'],
  'aed.otherHarness': ['请尝试用其他 harness 修复：dsh-fix doctor / bisect，或重装 DSH。', 'Please repair with another harness: dsh-fix doctor / bisect, or reinstall DSH.'],
  // ---- AED 安全模式增强（v2.2.0）：临时摘除异常 bundle ----
  'aed.stripBundles': ['检查并临时摘除异常 bundle…', 'Checking & temporarily removing unhealthy bundles…'],
  'aed.stripNote': ['；已临时摘除异常 bundle：{list}（退出安全模式时自动恢复）', '; unhealthy bundles temporarily removed: {list} (auto-restored on exiting safe mode)'],
  'aed.stripFail': ['；bundle 健康检查失败：{err}', '; bundle health check failed: {err}'],
  'aed.stripRestored': ['；已恢复临时摘除的 bundle：{list}', '; restored temporarily removed bundles: {list}'],
  'aed.stripRestoreFail': ['；恢复 bundle 清单失败：{err}', '; failed to restore the bundle list: {err}'],
  // ---- 认证类（DSH ≥0.1.2 浏览器会话认证，v2.3.0 缓解）----
  'aed.kind.auth': ['浏览器会话认证（本插件未适配）', 'Browser-session authentication (not supported by this plugin)'],
  'aed.reason.auth': ['DSH 0.1.2 起 Web 界面启用一次性 token + 浏览器 cookie 认证；Obsidian 内嵌面板属跨站 iframe，cookie 被 SameSite=Strict 拦截，面板暂不可用（系统浏览器正常）。插件作者正在适配。', 'DSH 0.1.2+ gates the Web UI with a one-time token and a SameSite=Strict cookie; the embedded Obsidian panel is a cross-site iframe so the cookie is blocked and the panel is unavailable for now (a system browser works). The plugin author is working on support.'],
  'aed.modal.openBrowser': ['在浏览器打开 DSH', 'Open DSH in browser'],
  'aed.fix.auth.browser': ['点击「在浏览器打开 DSH」即可完整使用（自动携带本次启动的认证链接）；或降级回适配版本：npm i -g @deepseek-ai/dsh@0.1.1-rc.2', 'Use "Open DSH in browser" for the full experience (the launch authentication link is included automatically); or downgrade to the verified version: npm i -g @deepseek-ai/dsh@0.1.1-rc.2'],
  'aed.fix.auth.none': ['请用系统浏览器打开 dsh web 启动时打印的带 token 链接；或降级回适配版本：npm i -g @deepseek-ai/dsh@0.1.1-rc.2', 'Open the token URL printed by dsh web in a system browser; or downgrade to the verified version: npm i -g @deepseek-ai/dsh@0.1.1-rc.2'],
  'aed.fix.auth.lost': ['注意：在浏览器中使用 DSH 时，本插件的辅助功能（框选注入桥接、路径点击跳转、服务管理）不生效；回到 Obsidian 面板并改用适配版本后自动恢复。', 'Note: in a system browser the plugin helpers (selection bridge, path links, service management) do not apply; they resume once you return to the panel with a supported version.'],
  // ---- 卸载并重装 DSH（v2.2.0）：备份聊天记录 + 强确认 ----
  'settings.cleanup.title': ['卸载并重装 DSH（保留聊天记录）', 'Uninstall & reinstall DSH (keep chat history)'],
  'settings.cleanup.desc': ['彻底清理 DSH 相关文件与插件注册后重新下载安装；聊天记录、附件、凭据、设置与技能会备份保留。破坏性操作——请先尝试 AED 抢救或让 AI/第三方 Harness 修复', 'Fully uninstall DSH files & plugin registrations, then reinstall. Chat history, attachments, credentials, settings and skills are backed up and kept. Destructive — try AED or an AI / third-party harness first'],
  'settings.cleanup.btn': ['卸载并重装', 'Uninstall & reinstall'],
  'cleanup.modal.title': ['卸载并重装 DSH（破坏性操作）', 'Uninstall & reinstall DSH (destructive)'],
  'cleanup.modal.warn': ['将删除：DSH 的插件注册、插件运行文件（profiles / plugins / storages / cache / logs 等）与全局 CLI dsh。你的 DSH 插件和自定义配置会被清空。', 'Will be removed: DSH plugin registrations & runtime files (profiles / plugins / storages / cache / logs etc.) and the global CLI dsh. Your DSH plugins and custom configuration will be wiped.'],
  'cleanup.modal.keep': ['将备份并保留：聊天记录（sessions）、附件（attachments）、凭据（.credentials.yaml）、设置（settings.yaml）与技能（skills）——这些目录不会被删除。', 'Backed up & kept: chat history (sessions), attachments, credentials (.credentials.yaml), settings (settings.yaml) and skills — these directories are NOT deleted.'],
  'cleanup.modal.suggest': ['建议先尝试非破坏性修复：① AED 抢救 / 退出安全模式 ② dsh-fix doctor / bisect ③ 让 AI 或第三方 Harness 协助修复。以上都无法解决时，再执行本操作。', 'Try non-destructive repairs first: ① AED recovery / exit safe mode ② dsh-fix doctor / bisect ③ ask AI or a third-party harness. Only run this when all of those fail.'],
  'cleanup.modal.backupDir': ['备份目录', 'Backup directory'],
  'cleanup.modal.deleteRepo': ['同时删除 DSH 源码仓库目录（{dir}，需重新克隆，较耗时）', 'Also delete the DSH source repo ({dir}; requires re-cloning, slower)'],
  'cleanup.modal.confirmCheck': ['我已阅读并理解，确认执行', 'I have read and understood; proceed'],
  'cleanup.modal.confirm': ['开始卸载并重装', 'Start uninstall & reinstall'],
  'cleanup.step.backup': ['备份聊天记录与配置…', 'Backing up chat history & config…'],
  'cleanup.step.wipe': ['卸载 DSH 相关文件与插件注册…', 'Uninstalling DSH files & plugin registrations…'],
  'cleanup.step.cli': ['卸载全局 CLI dsh…', 'Uninstalling global CLI dsh…'],
  'cleanup.step.install': ['重新下载安装 DSH…', 'Re-downloading & installing DSH…'],
  'cleanup.step.verify': ['校验启动并确认聊天记录…', 'Verifying boot & chat history…'],
  'cleanup.cliSkipped': ['全局 CLI dsh 未安装，跳过卸载', 'Global CLI dsh not installed; skipped'],
  'cleanup.cliDone': ['全局 CLI dsh 已卸载', 'Global CLI dsh uninstalled'],
  'cleanup.cliFail': ['全局 CLI 卸载失败：{err}（重装会重新安装）', 'Global CLI uninstall failed: {err} (reinstall will install it again)'],
  'cleanup.repoDeleted': ['仓库源码目录已删除：{dir}', 'Source repo deleted: {dir}'],
  'cleanup.repoDeleteFail': ['仓库源码目录删除失败：{err}', 'Failed to delete the source repo: {err}'],
  'cleanup.done': ['卸载重装完成；聊天记录已保留（{files} 个文件 / {bytes}）。备份目录：{dir}', 'Reinstall complete; chat kept ({files} files / {bytes}). Backup: {dir}'],
  'cleanup.bootFail': ['启动校验未通过（{detail}），可再试 AED 或手动处理', 'Boot check failed ({detail}); try AED or handle manually'],
  'cleanup.fail': ['卸载重装失败：{err}。原数据未被删除（备份位于 {dir}）', 'Uninstall/reinstall failed: {err}. Original data was not deleted (backup at {dir})'],

  // ---- 报错诊断（发给 DeepSeek 会话）----
  'diag.header': ['DeepSeek Harness Obsidian 插件报错，请分析原因并给出具体解决步骤：', 'The DeepSeek Harness Obsidian plugin reported an error. Analyze the cause and give concrete fix steps:'],
  'diag.error': ['错误：', 'Error: '],
  'diag.hint': ['提示：', 'Hint: '],
  'diag.port': ['端口：', 'Port: '],
  'diag.cwd': ['工作目录：', 'Working directory: '],
  'diag.command': ['启动命令：', 'Startup command: '],
  'notice.askAiCopied': ['诊断信息已复制到剪贴板；已打开 DeepSeek 网页版，粘贴（Ctrl+V）后发送', 'Diagnostic copied to the clipboard; DeepSeek web chat opened — paste (Ctrl+V) and send'],

  // ---- 人话化错误提示 ----
  'hz.notFound': ['还没有检测到 DeepSeek Harness，先安装一次吧。', 'DeepSeek Harness was not detected — install it first.'],
  'hz.github': ['连不上 GitHub，请检查网络后再试。', 'Cannot reach GitHub — check your network and try again.'],
  'hz.exited': ['DeepSeek Harness 启动失败了，请重新安装或检查设置。', 'DeepSeek Harness failed to start — reinstall it or check the settings.'],
  'hz.timeout': ['DeepSeek Harness 启动有点慢，等一会儿再试试。', 'DeepSeek Harness is starting slowly — try again in a moment.'],
  'hz.noAuto': ['服务没有运行，且已关闭自动启动，请在设置里打开。', 'The service is not running and auto-start is off — enable it in Settings.'],

  // ---- 命令 / 菜单 / 浮动按钮 / 对话框 ----
  'cmd.ribbon': ['打开 DeepSeek Harness', 'Open DeepSeek Harness'],
  'cmd.openPanel': ['打开面板', 'Open panel'],
  'cmd.sendSelection': ['发送选中文字到 DSH', 'Send selection to DSH'],
  'menu.sendSelection': ['发送选中文字到 DSH', 'Send selection to DSH'],
  'modal.cancel': ['取消', 'Cancel'],
  'modal.installTitle': ['安装 DeepSeek Harness', 'Install DeepSeek Harness'],
  'modal.installDesc': ['选择 DeepSeek Harness 的安装目录。将自动完成：①缺失的 git / Node.js / pnpm 一键安装 ②克隆 DSH 官方仓库 ③安装依赖并构建（pnpm run build）④全局安装 DSH 命令行工具 dsh（npm i -g @deepseek-ai/dsh@latest）。已有 DSH 但缺依赖/CLI 也会自动补齐。全程无需命令行。', 'Choose where to install DeepSeek Harness. It will: ① install missing git / Node.js / pnpm ② clone the official DSH repo ③ install dependencies and build (pnpm run build) ④ install the global DSH CLI (npm i -g @deepseek-ai/dsh@latest). If DSH already exists but tools/CLI are missing, they are filled in automatically. No command line needed.'],
  'modal.installStart': ['开始安装', 'Start install'],
  'modal.installProgressTitle': ['一键配置 DSH', 'Configure DSH'],
  'modal.installProgressDesc': ['正在检测与安装依赖、克隆仓库、构建并配置全局 CLI…', 'Checking and installing dependencies, cloning the repo, building, and setting up the global CLI…'],
  'modal.updateTitle': ['发现 DSH 新版本', 'DSH update available'],
  'modal.updateBody': ['{msg} 是否立即更新？（快进式更新，不影响本地未提交改动）', '{msg} Update now? (Fast-forward; local uncommitted changes are untouched)'],
  'modal.updatePrereleaseTitle': ['发现 DSH 预览版（有风险）', 'DSH prerelease available (risky)'],
  'modal.updatePrereleaseBody': ['{msg}。是否仍要更新？（预览版不稳定，可能与现有插件冲突导致服务崩溃；建议等正式版）', '{msg}. Update anyway? (Prereleases are unstable and may crash the service; waiting for a stable release is recommended)'],
  'modal.updateConfirm': ['立即更新', 'Update now'],
  'modal.authDanger': ['⚠ 目标版本（0.1.2–0.1.4）与插件已知不兼容：内嵌面板的聊天记录无法显示、输入框不可用。请更新到 0.1.5 或更高版本（已实测适配），或保持当前 0.1.1 系。', '⚠ The target version (0.1.2–0.1.4) is known to be incompatible with this plugin: the embedded panel cannot show chat history and the composer is unusable. Please update to 0.1.5+ (verified) or stay on the 0.1.1 line.'],
  'modal.updateKillNote': ['⚠ 更新前会结束所有 DSH 进程（含当前面板与后台服务），随后自动重启并按新认证凭证重载面板。会话数据不受影响。', '⚠ All DSH processes (including the current panel and background service) will be terminated before updating, then the service restarts and the panel reloads with the new auth credential. Session data is unaffected.'],
  'modal.updateAdaptedNote': ['DSH 0.1.5 系已实测适配，可放心更新。', 'DSH 0.1.5 has been verified compatible — updating is safe.'],
  'modal.updateAnyway': ['仍然更新', 'Update anyway'],
  'modal.updateViewChanges': ['查看 GitHub 更新内容', 'View changes on GitHub'],

  // ---- 通知 ----
  'notice.bridgeInstalled': ['DSH 桥接已安装，重启 DSH 服务后生效（设置页「重启 DSH 服务」）', 'DSH bridge installed; restart the DSH service to apply (Settings → Restart DSH service)'],
  'notice.bridgeRewritten': ['DSH 更新完成，桥接已同步重写，重启 DSH 服务后生效（设置页「重启 DSH 服务」）', 'DSH updated; the bridge was rewritten to match. Restart the DSH service to apply (Settings → Restart DSH service)'],
  'notice.noOpenRemoved': ['检测到当前 DSH 不支持 --no-open，已从启动命令移除（新版 DSH 不再自动打开浏览器）', 'The current DSH does not support --no-open; removed it from the startup command (newer DSH no longer auto-opens the browser)'],
  'notice.noOpenAdded': ['已为启动命令添加 --no-open（DSH 启动/重启不再自动打开浏览器）', 'Added --no-open to the startup command (DSH will not auto-open the browser on start/restart)'],
  'notice.reconnected': ['已重连 DeepSeek Harness', 'Reconnected to DeepSeek Harness'],
  'notice.notRunning': ['DSH 服务未运行，请先打开面板或检查设置', 'DSH service is not running; open the panel or check the settings'],
  'notice.selectFirst': ['请先框选要发送的文字', 'Select some text first'],
  'notice.fillPending': ['已发送填入请求，DSH 页面仍在加载（文字稍后出现）；若长时间未出现请重启 DSH 服务', 'Fill requested; the DSH page is still loading (text should appear shortly). If it never appears, restart the DSH service'],
  'notice.bridgeOff': ['「DSH 聊天框桥接到 Obsidian」已设为取消，未发送；如需发送请改为自动发送或右键发送', 'Bridge is set to Off — nothing was sent; switch to Auto-send or Right-click send to use it'],
  'notice.sendNoFile': ['无法定位当前笔记文件，未发送', 'Cannot locate the active note; nothing was sent'],
  'notice.startingPanel': ['DSH 服务未运行，正在打开面板启动…', 'DSH service is not running; opening the panel to start it…'],
  'notice.filled': ['已填入 DSH 输入框，请确认后发送', 'Filled into the DSH input; review it and send'],
  'notice.sendFailed': ['发送失败：{err}', 'Send failed: {err}'],
  'notice.bridgeFallback': ['DSH 桥接未就绪，已改为直接发送（设置页可查看桥接状态）', 'DSH bridge not ready; sent directly instead (see the bridge status in Settings)'],
  'notice.restarting': ['正在重启 DSH 服务…', 'Restarting the DSH service…'],
  'notice.dshProcessesKilled': ['已结束 {n} 个 DSH 进程', 'Terminated {n} DSH process(es)'],
  'notice.sessionsBackedUp': ['升级前已备份 {n} 个会话文件（{size}）到 {dir}', 'Backed up {n} session files ({size}) to {dir} before upgrading'],
  'notice.sessionsBackupNone': ['未发现会话目录，跳过升级前备份', 'No sessions directory found; skipping pre-upgrade backup'],
  'notice.sessionsBackupFail': ['会话备份失败，已中止升级：{err}（可手动复制 ~/.dsh/sessions 后重试）', 'Session backup failed; upgrade aborted: {err} (copy ~/.dsh/sessions manually and retry)'],
  'notice.sessionPrecheckOk': ['升级后预检：{n} 个会话均可读取', 'Post-upgrade check: all {n} sessions are readable'],
  'notice.sessionPrecheckWarn': ['升级后预检：磁盘有 {files} 个会话，新版仅列出 {listed} 个——部分历史的会话格式与该版本不兼容（已备份，可修复后恢复显示）', 'Post-upgrade check: {files} sessions on disk but only {listed} listed — some history uses a session format incompatible with this version (backed up; repairable)'],
  'notice.sessionPrecheckFail': ['升级后预检失败：{err}（不影响使用；如历史缺失请查看备份）', 'Post-upgrade check failed: {err} (usage is unaffected; check the backup if history is missing)'],

  // ---- 会话格式漂移修复（v2.4.0）----
  'repair.noZstdNode': ['未找到具备 zstd 能力的 Node（需要 Node ≥ 22.15）：请安装/切换到 Node 22 以上后重试', 'No zstd-capable Node found (Node ≥ 22.15 required). Install or switch to Node 22+ and retry.'],
  'repair.noDshInstall': ['未找到 DSH 安装目录：无法用 DSH 自带的迁移链复验与修复', 'DSH installation not found: cannot validate/repair with DSH\'s own migration chain'],
  'repair.driverFail': ['修复驱动异常退出（code {code}）', 'Repair driver exited unexpectedly (code {code})'],
  'repair.title': ['会话格式修复', 'Session format repair'],
  'repair.checking': ['正在预检会话（只读）…', 'Checking sessions (read-only)…'],
  'repair.checkDone': ['预检完成：{total} 个会话，可读 {ok}，不可读 {broken}', 'Check complete: {total} sessions, {ok} readable, {broken} unreadable'],
  'repair.checkClean': ['全部 {total} 个会话均可读，无需修复', 'All {total} sessions are readable — nothing to repair'],
  'repair.desc': ['DSH 版本漂移会让旧会话在当前版本下不可读（如 sourceEventSeqs 形态变化、插件写入的非法 source.form、子会话 descriptor 版本）。修复会先备份原文件、改完用 DSH 自带迁移链复验，通过才落盘。', 'DSH version drift can make older sessions unreadable (e.g. sourceEventSeqs shape changes, invalid plugin-written source.form, subagent descriptor version). Repair backs up the original first, then validates with DSH\'s own migration chain before writing.'],
  // v2.7.0（A1）：0.1.7+ 的 v3 及更早会话由 DSH 自身迁移链处理，本插件只报告不改写
  'repair.deferred': ['其中 {n} 个会话格式低于 DSH 当前版本，将在 DSH 打开该会话时自行迁移，本插件不改写其内容', '{n} sessions use an older format than the current DSH; DSH migrates them when the session is opened, and this plugin leaves them untouched'],
  'repair.danger': ['⚠ 修复会改写会话文件（每文件先复制到备份目录）。修复不会让不可冷恢复的子会话变得可恢复，只是让日志可读。', '⚠ Repair rewrites session files (each one is copied to the backup directory first). It does not make non-resumable subagent sessions resumable — it only makes the log readable.'],
  'repair.btnRepair': ['备份并修复（{n} 个）', 'Back up and repair ({n})'],
  'repair.btnRecheck': ['重新预检', 'Re-check'],
  'repair.running': ['正在修复：{done}/{total}', 'Repairing: {done}/{total}'],
  'repair.done': ['修复完成：成功 {fixed}，失败 {errors}，仍不可读 {broken}', 'Repair complete: {fixed} fixed, {errors} failed, {broken} still unreadable'],
  'repair.backupDir': ['备份目录：{dir}', 'Backup directory: {dir}'],
  'repair.noChange': ['没有需要修复的会话', 'No sessions need repair'],
  'repair.runtime': ['运行时：{node}（{version}）· 校验器：DSH {dir}', 'Runtime: {node} ({version}) · validator: DSH {dir}'],
  'notice.restarted': ['DSH 服务已重启，桥接已加载', 'DSH service restarted; bridge loaded'],
  'notice.restartFailed': ['重启失败：{msg}', 'Restart failed: {msg}'],
  'notice.installing': ['开始安装 DeepSeek Harness…', 'Installing DeepSeek Harness…'],
  'notice.installDirEmpty': ['安装目录不能为空', 'The install directory cannot be empty'],

  // ---- 安装器 ----
  'install.dirEmpty': ['安装目录为空：请在设置中填写安装目录', 'The install directory is empty: fill it in Settings'],
  'install.found': ['检测到已安装的 DSH 仓库：{dir}', 'Found an existing DSH repo: {dir}'],
  'install.notDsh': ['目录已存在但不是 DSH 仓库：{dir}。为避免覆盖数据，请更换安装目录或手动处理', 'The directory exists but is not a DSH repo: {dir}. To avoid overwriting data, choose another directory or handle it manually'],
  'install.downloading': ['正在下载 DeepSeek Harness…', 'Downloading DeepSeek Harness…'],
  'install.mirrorRetry': ['官方源下载失败，正在通过镜像重试（第 {n} 次）…', 'Official source failed; retrying via mirror ({n})…'],
  'install.cloneFailed': ['克隆失败：{err}。已自动重试官方源与 gh-proxy.com 镜像；仍失败时可在设置中更换安装地址或稍后再试', 'Clone failed: {err}. The official source and gh-proxy.com mirror were retried automatically; if it still fails, change the install URL in Settings or try again later'],
  'install.depsInstalling': ['正在安装依赖（可能需要几分钟）…', 'Installing dependencies (may take a few minutes)…'],
  'install.depsMirror': ['依赖源访问失败，改用国内镜像源重试…', 'Dependency source unreachable; retrying with a mirror…'],
  'install.depsNoteFail': ['；依赖安装未完成（{err}），可稍后在 {dir} 下执行 pnpm install', '; dependencies not fully installed ({err}) — run pnpm install in {dir} later'],
  'install.depsNoteNoPnpm': ['；未检测到 pnpm，请安装 pnpm 后在仓库目录执行 pnpm install', '; pnpm not found — install pnpm and run pnpm install in the repo directory'],
  'install.done': ['安装完成', 'Done'],
  'install.buildStep': ['正在构建 DSH 仓库（pnpm run build，首次可能需要几分钟）…', 'Building the DSH repo (pnpm run build; the first run may take a few minutes)…'],
  'install.buildFail': ['DSH 仓库已下载并安装依赖，但构建失败：{err}。请稍后在 {dir} 下手动执行 pnpm run build，或重试安装', 'Repo downloaded and dependencies installed, but the build failed: {err}. Run pnpm run build in {dir} later, or retry the install'],
  'install.message': ['DSH 已安装：{dir}{note}', 'DSH installed: {dir}{note}'],
  'install.cliInstalling': ['正在安装 DSH 全局 CLI…', 'Installing the DSH global CLI…'],
  'install.cliUpgrading': ['检测到已知不兼容的 DSH {v}，正在升级到最新可用版本…', 'Known-incompatible DSH {v} detected; upgrading to the latest usable version…'],
  'install.cliDone': ['；全局 CLI dsh 已就绪（{v}，可用 dsh web 启动）', '; global CLI dsh is ready ({v}; start with "dsh web")'],
  'install.cliFail': ['；全局 CLI 安装失败：{err}（可稍后执行 npm i -g @deepseek-ai/dsh@{v}）', '; global CLI install failed: {err} (run npm i -g @deepseek-ai/dsh@{v} later)'],
  'install.autoDep': ['正在一键安装缺失依赖 {dep}…', 'Installing missing dependency {dep}…'],
  'install.depStillMissing': ['依赖 {dep} 安装后仍不可用，请手动安装后重试', '{dep} is still unavailable after installation — install it manually and retry'],
  'dep.git.installed': ['git 已安装。无需重启，可继续下一步', 'git is installed. No restart needed — continue'],
  'dep.git.fail': ['git 安装失败：{err}。可手动到 git-scm.com 下载安装', 'git install failed: {err}. Install it manually from git-scm.com'],
  'dep.node.installed': ['Node.js 已安装。无需重启，可继续下一步', 'Node.js is installed. No restart needed — continue'],
  'dep.node.fail': ['Node.js 安装失败：{err}。可手动到 nodejs.org 下载安装', 'Node.js install failed: {err}. Install it manually from nodejs.org'],
  'dep.pnpm.installed': ['pnpm 已安装。无需重启，可继续下一步', 'pnpm is installed. No restart needed — continue'],
  'dep.pnpm.fail': ['pnpm 安装失败：{err}。可手动执行 winget install pnpm.pnpm 或 npm install -g pnpm', 'pnpm install failed: {err}. Run winget install pnpm.pnpm or npm install -g pnpm manually'],
  'dep.brew.installed': ['{dep} 已安装（brew）。无需重启，可继续下一步', '{dep} installed (brew). No restart needed — continue'],
  'dep.brew.fail': ['{dep} 安装失败：{err}。可手动执行 brew install {formula}（需先安装 Homebrew）', '{dep} install failed: {err}. Run brew install {formula} manually (Homebrew required)'],
  'dep.manual': ['请手动安装依赖：{hint}', 'Install the dependency manually: {hint}'],
  'install.depMirror': ['winget 失败，改用 npmmirror 镜像下载安装…', 'winget failed; downloading via npmmirror mirror…'],
  'install.depMirrorFail': ['npmmirror 镜像下载/安装失败：{err}', 'npmmirror mirror download/install failed: {err}'],
  'dep.noWinget': ['系统缺少 winget（App Installer 未安装/损坏），已改用镜像下载', 'winget (App Installer) is missing/broken; falling back to the mirror'],
  'dep.git.installedMirror': ['git 已安装（npmmirror 镜像）。无需重启', 'git installed (npmmirror mirror). No restart needed'],
  'dep.node.installedMirror': ['Node.js 已安装（npmmirror 镜像）。无需重启', 'Node.js installed (npmmirror mirror). No restart needed'],
  'dep.hint.node': ['请到 nodejs.org 下载安装 Node.js', 'Download Node.js from nodejs.org'],
  'dep.hint.pnpm': ['先安装 Node.js，再执行 npm install -g pnpm', 'Install Node.js first, then run npm install -g pnpm'],

  // ---- 服务管理器 ----
  'svc.offlineNoAuto': ['127.0.0.1:{port} 无服务，且已关闭自动启动（设置里可打开）', 'No service on 127.0.0.1:{port} and auto-start is off (enable it in Settings)'],
  'svc.stopped': ['DSH 服务已停止（进程退出，或端口 {port} 无响应）', 'DSH service stopped (process exited or port {port} not responding)'],
  'svc.offline': ['127.0.0.1:{port} 无服务', 'No service on 127.0.0.1:{port}'],
  'svc.portOwnedByExternal': ['端口 {port} 被本插件之外的 DSH 实例占用（如桌面版），插件不会终止它——请为本面板改用其它端口，或先自行退出该实例', 'Port {port} is held by a DSH instance outside this plugin (e.g. the desktop app); the plugin will not kill it — point the panel to another port, or stop that instance yourself'],
  'notice.profileCreated': ['已创建 DSH profile「{profile}」（基于 web 模板）', 'Created DSH profile "{profile}" from the web template'],
  'notice.profileCreateFail': ['创建 profile「{profile}」失败：{err}', 'Failed to create profile "{profile}": {err}'],
  'notice.profileSwitched': ['桥接已装入 profile「{profile}」，重启 DSH 服务后生效（设置页 → 快捷操作 → 重启 DSH 服务）', 'Bridge installed into profile "{profile}" — restart the DSH service to load it (Settings → Quick actions → Restart DSH service)'],
  'notice.killAllForUpgrade': ['升级/重装将结束本机全部 DSH 实例（含桌面版等其他窗口），完成后需各自重开', 'Upgrading/reinstalling will stop ALL local DSH instances (including other apps such as the desktop version); restart them afterwards'],
  'restart.foreignTitle': ['端口占用者不是本插件拉起的实例', 'The port owner is not an instance launched by this plugin'],
  'restart.foreignBody': ['端口 {port} 上的 DSH 服务并非由本插件拉起（可能是桌面版实例，或升级插件前的旧常驻进程）。重启需要终止它——确认继续？', 'The DSH service on port {port} was not launched by this plugin (possibly the desktop app, or a pre-upgrade resident process). Restarting requires terminating it — continue?'],
  'restart.foreignConfirm': ['终止并重启', 'Terminate and restart'],
  'svc.ensureOffline': ['127.0.0.1:{port} 无服务，且已关闭自动启动', 'No service on 127.0.0.1:{port} and auto-start is off'],
  'svc.unloaded': ['插件已卸载', 'Plugin unloaded'],
  'svc.startFailed': ['启动失败：{err}', 'Start failed: {err}'],
  'svc.timeout': ['等待服务就绪超时（{sec} 秒）；请检查启动命令是否正确', 'Timed out waiting for the service ({sec}s); check the startup command'],
  'svc.noCommand': ['请在插件设置中配置 DSH 启动命令', 'Configure the DSH startup command in the plugin settings'],
  'svc.exited': ['进程已退出（代码 {code}）；请检查启动命令与工作目录', 'Process exited (code {code}); check the startup command and working directory'],

  // ---- 更新器 ----
  'up.noRepo': ['未找到 DSH 仓库（缺少 .git）：请先「一键检测配置」或「一键安装」填充工作目录', 'DSH repo not found (no .git): run "Detect & fill" or "Install" first to set the working directory'],
  'up.noLocal': ['无法读取本地版本', 'Cannot read the local version'],
  'up.githubFail': ['无法连接 GitHub（git ls-remote）：{err}；请确认网络与 git 可用', 'Cannot reach GitHub (git ls-remote): {err}; check that the network and git are available'],
  'up.latest': ['已是最新版本（{v}），无需更新', 'Already up to date ({v}) — no update needed'],
  'up.latestNpmOnly': ['你的版本已是最新（{v}）——仅按 npm 官方推送的全局 CLI 版本检测；GitHub 仓库另有 {github}（预览，尚未发布到 npm，不触发自动更新提示）', 'You are up to date ({v}) — checked against the npm-published global CLI version; GitHub also has {github} (prerelease, not yet published to npm, so no update prompt is shown)'],
  'up.stableOnly': ['暂无正式版可更新（当前 {v}）；插件仅在官方发布正式版后推送升级', 'No stable release available (current {v}); the plugin only offers updates after an official stable release'],
  'up.prereleaseBehind': ['检测到 DSH 预览版 {remote}（当前 {local}）。预览版可能与现有插件冲突导致服务崩溃', 'Detected DSH prerelease {remote} (current {local}). Prereleases may conflict with existing plugins and crash the service'],
  'up.repoOnlyHint': ['；仓库源码已更新，但运行中的服务由全局 CLI 启动，需另行升级全局 CLI 并重启服务后生效', '; repo source updated, but the running service is launched by the global CLI — upgrade the global CLI and restart the service to apply'],
  'up.behind': ['GitHub 上有新版本：本地 {local}，GitHub 最新 {remote}', 'New version on GitHub: local {local}, latest {remote}'],
  'up.behindVer': ['GitHub 上有新版本：本地 {local}，最新 {remote}', 'New version on GitHub: local {local}, latest {remote}'],
  'up.diverged': ['本地有 {count} 个未推送的提交，有可能是你自行开发的插件，请在 DSH 中告诉 AI 自行更新', 'There are {count} uncommitted-to-remote local commits, possibly plugins you developed yourself — ask the AI in DSH to update on its own'],
  'up.dirty': ['仓库有未提交改动（{files}），git 更新被阻塞——请在 DSH 中让 AI 先处理这些改动（提交或 stash）后再更新', 'The repo has uncommitted changes ({files}) that block the git update — ask the AI in DSH to commit or stash them first, then update'],
  'up.done': ['DSH 已更新（{dir}）。若 DSH 服务正在运行，请重启服务使新版本生效', 'DSH updated ({dir}). If the DSH service is running, restart it to apply the new version'],
  'up.fail': ['DSH 更新失败：{err}（本地可能有未提交改动或网络问题，请手动处理）', 'DSH update failed: {err} (there may be uncommitted changes or network issues; handle it manually)'],
  'up.mirrorFail': ['；镜像源也失败：{err}', '; the mirror also failed: {err}'],
  'up.cliDone': ['DSH 全局 CLI 已更新（npm i -g @deepseek-ai/dsh@latest）。请重启 DSH 服务使新版本生效', 'DSH global CLI updated (npm i -g @deepseek-ai/dsh@latest). Restart the DSH service to apply'],
  'up.cliFail': ['DSH 全局 CLI 更新失败：{err}（可稍后手动执行 npm i -g @deepseek-ai/dsh@latest）', 'DSH global CLI update failed: {err} (run npm i -g @deepseek-ai/dsh@latest later)'],
  'up.cliUpdatingTitle': ['更新 DSH', 'Updating DSH'],
  'up.cliUpdating': ['正在更新 DSH 全局 CLI（已停止服务以释放文件锁），可能需要几分钟…', 'Updating the DSH global CLI (service stopped to release file locks); may take a few minutes…'],
  'up.cliRestarting': ['DSH 全局 CLI 已更新，正在重启服务…', 'DSH global CLI updated; restarting the service…'],
  'notice.updating': ['正在更新 DSH…', 'Updating DSH…'],
  'settings.updateMirror.title': ['更新镜像地址', 'Update mirror URL'],
  'settings.updateMirror.desc': ['DSH 更新的只读镜像；留空自动用 gh-proxy 兜底（如 https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git）', 'Read-only mirror for DSH updates; empty auto-falls back to gh-proxy (e.g. https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git)'],
  'up.unknown': ['未知', 'Unknown'],
  'err.unknown': ['未知错误', 'unknown error'],
  'err.failed': ['失败', 'failed'],

  // ---- 一键检测 ----
  'detect.path': ['已检测到 dsh（PATH 中），启动命令已设为 dsh web --port {port}', 'dsh found on PATH; startup command set to dsh web --port {port}'],
  'detect.notFound': ['未检测到 DeepSeek Harness 仓库：请先从 github.com/deepseek-ai/deepseek-harness 获取源码，或在设置中手动填写启动命令与工作目录', 'No DeepSeek Harness repo detected: get the source from github.com/deepseek-ai/deepseek-harness, or fill in the startup command and working directory manually in Settings'],
  'detect.found': ['已检测到 DSH 仓库：{dir}；启动命令：{cmd}', 'DSH repo detected: {dir}; startup command: {cmd}'],

  // ---- DSH RPC API ----
  'api.timeout': ['请求 DSH 超时（{ms}ms）', 'DSH request timed out ({ms}ms)'],
  'api.notRunning': ['DSH 服务未运行（127.0.0.1:{port} 拒绝连接）', 'DSH service is not running (connection refused on 127.0.0.1:{port})'],
  'api.connectFail': ['无法连接 DSH：{err}', 'Cannot connect to DSH: {err}'],
  'api.httpStatus': ['DSH 返回 HTTP {code}', 'DSH returned HTTP {code}'],
  'api.badFormat': ['DSH 返回了意外的响应格式', 'DSH returned an unexpected response format'],
  'api.rejected': ['DSH 拒绝了请求', 'DSH rejected the request'],
  'api.unparsable': ['DSH 响应无法解析', 'Cannot parse the DSH response'],
  'api.authRequired': ['DSH 需要浏览器会话认证且插件未能自动取得认证链接（服务非本插件拉起时常见）；可在插件设置「重启 DSH 服务」后重试', 'DSH requires browser-session authentication but the plugin could not obtain the auth link (typical when the service was not started by the plugin); use Settings → Restart DSH service, then retry'],

  // ---- 诊断（启动耗时）----
  'settings.diag.title': ['诊断', 'Diagnostics'],
  'settings.diag.startup.title': ['启动耗时记录', 'Startup timing log'],
  'settings.diag.startup.desc': ['插件加载 → 服务探测 → 启动 → 面板就绪各阶段耗时（最近 5 次）', 'Per-phase timings: plugin load → service probe → startup → panel ready (last 5 runs)'],
  'settings.diag.refresh': ['刷新', 'Refresh'],
  'settings.diag.empty': ['暂无记录（打开面板后自动采集）', 'No records yet (collected when the panel opens)'],
  'bridge.patchMergeError': ['现有补丁文件为非空流式数组格式，无法自动合并；请手动在 {patch} 追加桥接条目', 'The existing patch file uses a non-empty flow-array format that cannot be merged automatically; add the bridge entry manually in {patch}'],
  // v2.7.0（A3）：裸包名模式下 node_modules 链接建不出来（同名实体/权限）→ 自动退回路径模式，客户端半不可用
  'bridge.packageLinkFailed': ['无法在 profile 下建立 node_modules 链接（同名条目已存在或权限受限），本次已退回路径模式安装：客户端半暂不可用，其余功能不受影响', 'Could not create the node_modules link inside the profile (an entry with that name already exists, or permissions blocked it); installed in path mode instead: the client half stays unavailable, everything else is unaffected'],
}

let current: Locale = 'zh'

/**
 * 词典键的只读视图与取对函数（供「双语齐全 + 占位符一致」机检用）。
 * 文案到这个量级，漏译和 `{x}` 不对齐只能靠测试兜住，不能靠人眼。
 */
export const I18N_KEYS: readonly string[] = Object.keys(dict)
export function i18nPair(key: string): readonly [string, string] | undefined {
  return dict[key]
}

/**
 * 解析语言设置：zh/en 直接生效；auto 用「检测端」传入的 detected（由插件经 Obsidian
 * getLanguage() 检测，见 main.ts detectSystemLanguage）——zh* → 中文，其余/缺省一律 English。
 * 插件仅提供中英双语，非中文系统自动落到英文。
 */
export function resolveLocale(setting: LanguageSetting, detected?: Locale): Locale {
  if (setting === 'zh') return 'zh'
  if (setting === 'en') return 'en'
  return detected ?? 'en'
}

/** 应用语言设置（切换当前语言）。auto 时使用检测端传入的语言。 */
export function applyLocale(setting: LanguageSetting, detected?: Locale): void {
  current = resolveLocale(setting, detected)
}

/** 当前语言。 */
export function getLocale(): Locale {
  return current
}

/** 取当前语言文案；{name} 占位符由 vars 替换；未收录 key 原样返回。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = dict[key]
  const text = entry ? (current === 'en' ? entry[1] : entry[0]) : key
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
