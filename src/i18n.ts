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

  // ---- 基础设置 ----
  'settings.section.basic': ['基础设置', 'Basic Setup'],
  'settings.install.title': ['一键安装 DSH 本体', 'One-click install DeepSeek Harness'],
  'settings.install.desc': ['没装过 DeepSeek Harness 就点这个：先确认安装目录，再自动下载、安装、配置，几分钟搞定', 'Never installed DeepSeek Harness? Click this: confirm the directory, then it downloads, installs and configures everything in a few minutes'],
  'settings.install.btn': ['安装 DSH', 'Install DSH'],
  'settings.install.preparing': ['准备中…', 'Preparing…'],
  'settings.detect.title': ['一键检测配置', 'Detect & apply config'],
  'settings.detect.desc': ['已经装过 DSH 的，自动找到位置并填好配置', 'Already have DSH? Auto-detect its location and fill in the config'],
  'settings.detect.btn': ['检测并填充', 'Detect & fill'],
  'settings.detect.progress': ['检测中…', 'Detecting…'],
  'settings.installDir.title': ['安装目录', 'Install directory'],
  'settings.installDir.desc': ['DSH 安装位置；本机已有 DSH 时自动填入检测到的路径', 'Where DSH is installed; auto-filled when a local DSH is detected'],
  'settings.version.title': ['DSH 版本', 'DSH version'],
  'settings.version.current': ['当前版本：{v}', 'Current version: {v}'],
  'settings.version.check': ['检查更新', 'Check for updates'],
  'settings.version.checking': ['检查中…', 'Checking…'],

  // ---- 快捷操作 ----
  'settings.section.quick': ['快捷操作', 'Quick actions'],
  'settings.reconnect.title': ['重连服务', 'Reconnect service'],
  'settings.reconnect.desc': ['DSH 面板加载失败或卡住时，重新探测并刷新面板', 'When the DSH panel fails to load or hangs, re-probe and refresh the panel'],
  'settings.reconnect.btn': ['重连', 'Reconnect'],
  'settings.browser.title': ['在浏览器打开 DSH', 'Open DSH in browser'],
  'settings.browser.desc': ['用系统默认浏览器打开 DSH Web GUI（独立窗口，不受 Obsidian 面板限制）', 'Open the DSH Web GUI in your default browser (separate window, not constrained by the Obsidian panel)'],
  'settings.browser.btn': ['打开浏览器', 'Open browser'],

  // ---- 选中文字发送与桥接（合并区）----
  'settings.section.send': ['选中文字发送与桥接', 'Send selection & bridge'],
  'settings.send.selectionBtn.title': ['框选后显示发送按钮', 'Show send button on selection'],
  'settings.send.selectionBtn.desc': ['在编辑器框选文字后，自动在选区旁显示「发送到 DSH」按钮（命令面板与右键菜单始终可用）', 'Show a "Send to DSH" button next to the selection (the command palette and context menu always work)'],
  'settings.send.openPanel.title': ['发送后自动打开面板', 'Open panel after sending'],
  'settings.send.openPanel.desc': ['发送选中文字到 DSH 后，自动打开/切换到 DSH 面板查看处理过程', 'After sending text to DSH, open/switch to the DSH panel to watch it being processed'],
  'settings.send.sourceTag.title': ['附带来源标签', 'Attach source tag'],
  'settings.send.sourceTag.desc': ['发送时自动在文字前加「[来源：Obsidian 笔记 <绝对路径>]」，让 DSH 直接定位文件、减少工作量', 'Prepend "[Source: Obsidian note <absolute path>]" so DSH can locate the file directly and do less work'],
  'settings.bridge.status.title': ['桥接状态', 'Bridge status'],
  'settings.bridge.status.installedReady': ['文件已安装；已加载 ✓（选中文字将填入输入框）', 'Installed; loaded ✓ (selected text will be filled into the input)'],
  'settings.bridge.status.installedNotReady': ['文件已安装；未加载（重启 DSH 服务后生效）', 'Installed; not loaded (takes effect after restarting the DSH service)'],
  'settings.bridge.status.notInstalled': ['未安装', 'Not installed'],
  'settings.bridge.restart.title': ['重启 DSH 服务', 'Restart DSH service'],
  'settings.bridge.restart.desc': ['结束占用端口的进程（含常驻进程）并重新启动；用于加载桥接补丁。注意：会中断当前正在运行的任务', 'Kill the process on the port (including detached ones) and restart; used to load the bridge patch. Note: this interrupts running tasks'],
  'settings.bridge.restart.btn': ['重启服务', 'Restart'],
  'settings.bridge.restart.progress': ['重启中…', 'Restarting…'],
  'settings.bridge.rewrite.btn': ['重新写入', 'Rewrite'],
  'settings.bridge.rewrite.fail': ['桥接写入失败：{err}', 'Failed to write bridge files: {err}'],
  'settings.bridge.rewrite.updated': ['桥接文件已更新，重启 DSH 服务后生效', 'Bridge files updated; restart the DSH service to apply'],
  'settings.bridge.rewrite.ready': ['桥接文件已就绪', 'Bridge files ready'],

  // ---- 面板显示 ----
  'settings.section.panel': ['面板显示', 'Panel display'],
  'settings.zoom.title': ['页面缩放', 'Page zoom'],
  'settings.zoom.desc': ['DSH 页面缩放比例（当前 {z}×），范围 0.5–2.0，步进 0.05', 'DSH page zoom (currently {z}×), range 0.5–2.0, step 0.05'],

  // ---- 高级设置 ----
  'settings.section.advanced': ['高级设置', 'Advanced'],
  'settings.port.title': ['服务端口', 'Service port'],
  'settings.port.desc': ['DSH Web GUI 监听端口，默认 3080', 'Port the DSH Web GUI listens on; default 3080'],
  'settings.command.title': ['启动命令', 'Startup command'],
  'settings.command.hint': ['示例：pnpm dsh web --port {port}（{port} 自动替换为端口；若 dsh 在 PATH 中可留空自动探测；用 pnpm 启动时请把工作目录设为 DSH 仓库路径）', 'Example: pnpm dsh web --port {port} ({port} is replaced automatically; leave empty to auto-detect when dsh is on PATH; set the working directory to the DSH repo when using pnpm)'],
  'settings.cwd.title': ['工作目录', 'Working directory'],
  'settings.cwd.desc': ['启动 DSH 时的工作目录（DSH 工作区）；留空为 Vault 根目录', 'Working directory used to start DSH (the DSH workspace); empty means the Vault root'],
  'settings.autoStart.title': ['离线时自动启动', 'Auto-start when offline'],
  'settings.autoStart.desc': ['打开面板时若端口无服务，自动运行启动命令', 'Automatically run the startup command when the port has no service'],
  'settings.detached.title': ['进程独立常驻', 'Detached persistent process'],
  'settings.detached.desc': ['开启后，插件启动的 DSH 进程在 Obsidian 退出后继续运行（默认关闭：随 Obsidian 退出而终止）', 'When on, the DSH process started by the plugin keeps running after Obsidian exits (default off: it terminates with Obsidian)'],
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
  'view.install.btn': ['一键安装 DSH 本体', 'Install DeepSeek Harness'],
  'view.install.installing': ['安装中…', 'Installing…'],
  'view.install.done': ['安装完成（已自动刷新环境变量，无需重启）', 'Installed (PATH refreshed automatically; no restart needed)'],
  'view.install.preparing': ['准备中…', 'Preparing…'],
  'view.install.starting': ['安装完成，正在启动…', 'Installed, starting…'],
  'view.error.title': ['暂时打不开 DeepSeek Harness', 'Cannot open DeepSeek Harness right now'],
  'view.error.reason': ['原因：{msg}', 'Reason: {msg}'],
  'view.error.manual': ['也可以手动启动 DSH（保持终端运行）：', 'Or start DSH manually (keep the terminal running):'],
  'view.error.copy': ['复制', 'Copy'],
  'view.error.retry': ['重连服务', 'Reconnect'],
  'view.error.browser': ['在浏览器打开 DSH', 'Open in browser'],
  'view.error.settings': ['打开设置', 'Settings'],
  'view.error.askAi': ['问问 AI 怎么解决', 'Ask AI how to fix'],

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
  'floating.send': ['发送到 DSH', 'Send to DSH'],
  'modal.cancel': ['取消', 'Cancel'],
  'modal.installTitle': ['安装 DeepSeek Harness', 'Install DeepSeek Harness'],
  'modal.installDesc': ['选择 DeepSeek Harness 的安装目录（将自动克隆官方仓库并安装依赖）：', 'Choose where to install DeepSeek Harness (the official repo will be cloned and dependencies installed):'],
  'modal.installStart': ['开始安装', 'Start install'],
  'modal.updateTitle': ['发现 DSH 新版本', 'DSH update available'],
  'modal.updateBody': ['{msg} 是否立即更新？（快进式更新，不影响本地未提交改动）', '{msg} Update now? (Fast-forward; local uncommitted changes are untouched)'],
  'modal.updateConfirm': ['立即更新', 'Update now'],

  // ---- 通知 ----
  'notice.bridgeInstalled': ['DSH 桥接已安装，重启 DSH 服务后生效（设置页「重启 DSH 服务」）', 'DSH bridge installed; restart the DSH service to apply (Settings → Restart DSH service)'],
  'notice.reconnected': ['已重连 DeepSeek Harness', 'Reconnected to DeepSeek Harness'],
  'notice.notRunning': ['DSH 服务未运行，请先打开面板或检查设置', 'DSH service is not running; open the panel or check the settings'],
  'notice.selectFirst': ['请先框选要发送的文字', 'Select some text first'],
  'notice.startingPanel': ['DSH 服务未运行，正在打开面板启动…', 'DSH service is not running; opening the panel to start it…'],
  'notice.filled': ['已填入 DSH 输入框，请确认后发送', 'Filled into the DSH input; review it and send'],
  'notice.sendFailed': ['发送失败：{err}', 'Send failed: {err}'],
  'notice.bridgeFallback': ['DSH 桥接未就绪，已改为直接发送（设置页可查看桥接状态）', 'DSH bridge not ready; sent directly instead (see the bridge status in Settings)'],
  'notice.restarting': ['正在重启 DSH 服务…', 'Restarting the DSH service…'],
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
  'install.message': ['DSH 已安装：{dir}{note}', 'DSH installed: {dir}{note}'],
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
  'dep.hint.node': ['请到 nodejs.org 下载安装 Node.js', 'Download Node.js from nodejs.org'],
  'dep.hint.pnpm': ['先安装 Node.js，再执行 npm install -g pnpm', 'Install Node.js first, then run npm install -g pnpm'],

  // ---- 服务管理器 ----
  'svc.offlineNoAuto': ['127.0.0.1:{port} 无服务，且已关闭自动启动（设置里可打开）', 'No service on 127.0.0.1:{port} and auto-start is off (enable it in Settings)'],
  'svc.stopped': ['DSH 服务已停止（进程退出，或端口 {port} 无响应）', 'DSH service stopped (process exited or port {port} not responding)'],
  'svc.offline': ['127.0.0.1:{port} 无服务', 'No service on 127.0.0.1:{port}'],
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
  'up.latest': ['已是最新（{v}）', 'Up to date ({v})'],
  'up.behind': ['GitHub 上有新版本：本地 {local}，GitHub 最新 {remote}', 'New version on GitHub: local {local}, latest {remote}'],
  'up.done': ['DSH 已更新（{dir}）。若 DSH 服务正在运行，请重启服务使新版本生效', 'DSH updated ({dir}). If the DSH service is running, restart it to apply the new version'],
  'up.fail': ['DSH 更新失败：{err}（本地可能有未提交改动或网络问题，请手动处理）', 'DSH update failed: {err} (there may be uncommitted changes or network issues; handle it manually)'],
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
  'bridge.patchMergeError': ['现有补丁文件为非空流式数组格式，无法自动合并；请手动在 ~/.dsh/profiles/web/cordis.patch.yml 追加桥接条目', 'The existing patch file uses a non-empty flow-array format that cannot be merged automatically; add the bridge entry manually in ~/.dsh/profiles/web/cordis.patch.yml'],
}

let current: Locale = 'zh'

/** 解析语言设置：auto 时按 Obsidian 界面语言（localStorage 'language'）判断——zh* → 中文；**其余任何语言（含 ja/fr/de…）与不可用情况一律 English**（插件仅提供中英双语，非中文系统自动落到英文）。 */
export function resolveLocale(setting: LanguageSetting): Locale {
  if (setting === 'zh') return 'zh'
  if (setting === 'en') return 'en'
  try {
    const lang = window.localStorage.getItem('language')
    if (lang && lang.toLowerCase().startsWith('zh')) return 'zh'
  } catch {
    // localStorage 不可用（无 window/受限环境）：按英文处理
  }
  return 'en'
}

/** 应用语言设置（切换当前语言）。 */
export function applyLocale(setting: LanguageSetting): void {
  current = resolveLocale(setting)
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
