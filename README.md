# DeepSeek Harness for Obsidian

<p align="center">
  <img src="https://img.shields.io/github/stars/hjxcloud-tech/dsh-harness" alt="GitHub stars">
  <a href="https://community.obsidian.md/plugins/dsh-harness">
    <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&query=%24%5B%22dsh-harness%22%5D.downloads&label=downloads&logo=obsidian&color=7C3AED" alt="Obsidian downloads">
  </a>
  <img src="https://img.shields.io/github/v/release/hjxcloud-tech/dsh-harness" alt="GitHub release">
  <img src="https://img.shields.io/github/license/hjxcloud-tech/dsh-harness" alt="License">
</p>

> **Status: released** · **Desktop only**（Windows / macOS）· [English](#en) · [中文](#zh)

把 DSH 原生 Web UI 无痕嵌入 Obsidian：一键配置、静默运行、笔记与 DSH 双向桥接，随 DSH 版本演进持续可用。

*Embed the native DSH Web UI into your vault — one-click setup, silent operation, a two-way bridge between your notes and DSH, and it keeps working as DSH evolves.*

---

<a id="en"></a>

## English

An Obsidian desktop plugin that embeds the native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web UI directly into your vault — a seamless graft of two open-source tools: no DSH source is touched (connected through DSH's official extension seam), so it keeps working as DSH evolves. The plugin talks to DSH only over localhost; DSH itself makes outbound requests (e.g. AI model APIs) when you use it.

**Features & Usage**

- **One-click setup** — installs or detects DSH, auto-installs missing tools (git / Node.js / pnpm) with a live progress bar; no command line needed.
- **Silent operation** — the DSH service starts quietly in the background: no console windows, no terminal to keep open; crashes are detected and reconnected in one click.
- **Native Web UI** — the real DSH interface (iframe embed) with adjustable zoom (0.5×–2.0×) and theme-following styling.
- **Two-way text bridge** — select text in a note and it fills the DSH chat input directly, with the file path attached; conversely, DSH artifacts/paths inside your vault open in Obsidian with one click.
- **Shortcut passthrough** — Obsidian global shortcuts (e.g. `Ctrl+;` for properties) still work while focus is inside the DSH panel; it auto-reads your hotkey settings.
- **Self-healing bridge** — the bridge is rewritten automatically after DSH or plugin updates, so it stays compatible.
- **Bottom padding** — add 0–30px space under the panel (default 20) when the Obsidian status bar covers the panel bottom.
- **Bilingual UI** — Chinese / English, follows your system language.
- **Self-maintaining** — auto-checks GitHub for DSH updates (with a read-only mirror fallback), applies on confirmation; restart the service anytime from settings.
- **Error, explained** — failures show plain-language reasons plus one-click reconnect / "Ask AI how to fix".
- **AED rescue** — when DSH won't start, one click downloads and runs dsh-fix to enter safe mode and recover, with a mirror fallback for downloads.
- **Privacy, your call** — data flows where you configure them (see [Privacy & Data Use](#privacy--data-use)).

**Performance**

- Capability probing results (e.g. `--no-open` support) are cached and reused, so repeated starts skip the slow probe and the panel opens faster.
- A startup timing log (plugin load → service probe → service start → panel ready) is shown in Settings → Diagnostics, so slow or failed starts can be located quickly.
- These optimizations apply to the plugin layer only; DSH itself starts at its own pace.

**Requirements**

- Obsidian **desktop** v1.7.2+ (Windows / macOS)
- DSH itself: the plugin can install it for you (git / Node.js / pnpm are auto-installed if missing; mirror fallback when the official source is blocked)
- A model API key for DSH (default: DeepSeek API; any OpenAI/Anthropic-compatible endpoint — including a local model — can be configured)

**Install**: Obsidian → Settings → Community plugins → Browse → search **"DeepSeek Harness"** → Install. [Build from source](#install-from-source) is also supported.

**Credits**: Thanks to the [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) and [Obsidian](https://obsidian.md) open-source teams — the open, shared spirit of the internet is what makes tools like this possible. And thank you to [Claudian](https://github.com/YishenTu/claudian) (an AI coding-agent plugin for Obsidian), whose design inspired this plugin's select-and-send interaction.

---

<a id="zh"></a>

## 中文

### 这是什么

一个把 **DeepSeek Harness（DSH）原生 Web UI 无痕嫁接到 Obsidian** 的桌面插件。不改 DSH 一行源码（走官方扩展机制），DSH 升级即可用。插件与 DSH 之间仅走本机回环；DSH 使用时会自行发起外网请求（如调用 AI 模型 API）。

### 功能与用法

**省心接入**
- **一键配置**：自动安装或识别 DSH，缺失的 git / Node.js / pnpm 自动装好，进度条实时可见；小白零命令行上手
- **静默运行**：DSH 服务后台静默启动——无控制台窗口、不用挂终端；服务崩溃自动检测，一键重连/重启
- **自动维护**：自动检查 GitHub 上的 DSH 更新，确认后一键更新（官方源被墙时自动走只读镜像，可在设置中自定义镜像地址）

**原生体验**
- **原生 DSH Web UI**：iframe 直接嵌入，与浏览器访问完全一致；页面可缩放（0.5×–2.0×），外观跟随 Obsidian 主题
- **双向文字桥接**：①笔记里框选文字 → 填入 DSH 聊天框（先确认再发送），自动附上文件路径；②DSH 产物/路径若在 Vault 内 → 点击即在 Obsidian 打开，无缝回跳笔记
- **快捷键透传**：光标聚焦在 DSH 面板内时，Obsidian 全局快捷键（如 Ctrl+; 打开属性）仍可响应，自动读取你的快捷键设置
- **桥接自动维护**：DSH 或插件更新后自动重写桥接，保持兼容
- **底部垫高**：Obsidian 状态栏遮挡面板底部时，可调 0–30px 留白（默认 20）
- **中英双语界面**：跟随系统语言，非中文系统自动英文
- **AED 抢救**：DSH 无法启动时，一键下载并运行 dsh-fix 进入安全模式抢救，下载走镜像兜底

**隐私可控**
- 数据流向由你掌控：默认 DeepSeek 官方 API；可配置任意 OpenAI/Anthropic 兼容端点（含本地模型）；Vault 索引、会话记录与 API key 凭证均存于本机

**平台支持**：Windows / macOS（仅桌面端）

### 环境要求

- Obsidian **桌面版 v1.7.2+**（Windows / macOS）
- DSH 本体：插件可一键安装（git / Node.js / pnpm 缺失自动补齐，官方源被墙时走镜像）
- DSH 模型 API key：默认 DeepSeek 官方 API；可配置任意 OpenAI/Anthropic 兼容端点（含本地模型）

### 性能

- **启动更省时**：DSH 能力探测结果（如 `--no-open` 支持）缓存复用，避免每次启动重复耗时探测，面板打开更快
- **启动耗时可观测**：设置 →「诊断」区显示各阶段耗时（插件加载 → 服务探测 → 服务启动 → 面板就绪），启动慢/失败时可快速定位
- 以上优化仅作用于插件层；DSH 本体按自身节奏启动

### 致谢

感谢 [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) 与 [Obsidian](https://obsidian.md) 开源团队——开放、共享的互联网精神，让这样的工具得以诞生。向所有开源贡献者致敬；感谢 [Claudian](https://github.com/YishenTu/claudian)（Obsidian 内的 AI 编码 agent 插件）——本插件的「框选发送」交互正源自其设计灵感。

---

## Key settings

| Setting | Default | Description |
|---------|---------|-------------|
| Interface language | Follow Obsidian | Chinese / English; any other system language falls back to English |
| Service port | 3080 | Port the DSH Web GUI listens on |
| Startup command / working directory | empty | Customize how `dsh web` starts (supports the `{port}` placeholder) |
| Auto-start when offline | on | Start the service if the port has none when the panel opens |
| Detached persistent process | on | Keep DSH running after Obsidian exits |
| One-click install DSH | button | Auto-install dependencies → clone (live percentage) → install dependencies (progress bar) → auto-configure |
| Auto-check updates | on | Auto-detect new DSH versions when opening the panel / starting the service (prompts only when an update is found; view GitHub changes or update now) |
| Check for updates | button | Manual check; falls back to a read-only mirror if the official source fails |
| Plugin info | row | Shows the installed plugin version; in-app changelog modal + "check plugin updates" (opens the official Obsidian store page) + GitHub repo URL (feedback & issues welcome) |
| Bottom padding | 20px | Empty space below the panel (0–30px) when the Obsidian status bar covers the panel bottom |
| Shortcut passthrough | on | Obsidian global shortcuts still work while focus is inside the DSH panel (auto-reads your hotkey settings) |
| Changelog | link | Open the DSH GitHub Releases page (for DSH itself) to read per-version changes; the plugin's own changelog opens in an in-app modal |
| AED for DSH | button | Download and run dsh-fix and start DSH in safe mode; then instruct DSH to self-repair |
| Start in safe mode | button | Start DSH in safe mode only (disables all user plugins); a second button exits safe mode and restores them |
| Update mirror URL | empty | Custom update mirror; empty auto-falls back to gh-proxy |
| Install URL | official repo | Clone URL; switch to a proxy mirror on restricted networks |
| Diagnostics | log | Startup timing log (last 5 runs): plugin load → service probe → service start → panel ready |

### Privacy & Data Use

- **Plugin layer**: the plugin contains no DSH implementation; it talks to DSH only over localhost (127.0.0.1). The only outbound requests the plugin itself makes are the ones you trigger (cloning DSH, checking updates). No telemetry.
- **DSH layer**: DSH is an AI agent framework — when you run a task it makes outbound requests as needed (e.g. AI model APIs, tool/web access); what is sent depends on the task you run.
- **Data flow is yours to configure**: DSH sends model requests to the provider you configure (default: DeepSeek API; `baseURL` supports OpenAI-completions/Responses, Anthropic-messages and other protocols — including a local model such as Ollama/vLLM, in which case data never leaves your machine). Vault index, session history and API keys stay on your machine (local credentials store).
- **No telemetry, no third-party relay**: the plugin runs no telemetry beacons; there is no cloud relay between Obsidian, the plugin and DSH.

### Troubleshooting

| Symptom / error | Cause | Fix |
|-----------------|-------|-----|
| Panel won't open | Wrong working directory, `pnpm` not on PATH, port taken | The error view shows the reason + a copy-paste manual startup command |
| `spawn dsh ENOENT` / "dsh not found" | Windows `.cmd` shim not resolvable by Node | Plugin already wraps npm-style commands via `cmd.exe`; reload the plugin (fully restart Obsidian) |
| `EADDRINUSE` / port 3080 taken | A stale DSH process holds the port | Settings → Quick actions → Restart service |
| "Bridge not ready, sent directly instead" | Bridge script not yet injected into the panel | Settings → Quick actions → Restart service (after updating the plugin, fully restart Obsidian before restarting the DSH service) |
| `koffi.node EBUSY` during CLI update | The running DSH locks its native module | The plugin stops the service before updating the CLI; otherwise stop DSH manually and retry |
| `Could not resolve host` / update fails | github.com blocked or flaky | Use the update mirror URL, or check the network |
| npm global install hangs at the end | Known npm behavior on this package | Verify by reading the installed package's `package.json` version, not the console |

### Architecture

```
src/
├── main.ts                  # Plugin entry: commands, menus, bridge wiring, profiler
├── service-manager.ts       # DSH service probe / spawn / restart (kill port owner)
├── bridge.ts                # DSH official extension seam: patch file + injected bridge script
├── dsh-api.ts               # Local RPC client (session.list/prompt/history) over 127.0.0.1
├── startup-profiler.ts      # Startup timing log (phases → data.json)
├── installer.ts             # One-click install: deps (winget/npm/mirror) + clone + build + CLI
├── updater.ts               # Update check (official + mirror), stable-version gate
├── aed.ts                   # dsh-fix safe-mode recovery
├── view.ts                  # Embedded panel (iframe) with error view
├── settings.ts              # Settings tab (language / bridge / diagnostics)
├── changelog.ts             # In-app plugin changelog modal (+ changelog-data.ts)
├── i18n.ts                  # Chinese / English dictionary
└── win-exec.ts              # Windows .cmd wrapper for npm-style commands
```

### Development

```bash
npm run dev        # esbuild watch mode
npm run build      # production build + install
npm test           # unit tests
npm run typecheck  # tsc --noEmit
npm run release:check   # full release gate (tests + lint + typecheck + review-style checks)
```

---

### 安装

**方式一：商店安装（推荐）**
Obsidian → 设置 → 第三方插件 → 浏览 → 搜索 **「DeepSeek Harness」** → 安装。无需 GitHub 链接。

**方式二：本机已有 DSH**
启用插件后，在设置中点「一键检测配置」即可自动识别并填充。

**方式三：从源码构建** <a id="install-from-source"></a>

```bash
cd "07 coding project/dsh-obsidian"
npm install
npm run build   # 自动安装到 .obsidian/plugins/dsh-harness/
```

### 快速上手

1. 启用插件，侧边栏出现鲸鱼图标
2. 第一次用：设置 →「一键安装 DSH 本体」（或已装过 DSH 则点「一键检测配置」）
3. 点侧边栏图标打开面板，即开即用

### 主要设置

| 设置 | 默认 | 说明 |
|------|------|------|
| 界面语言 | 跟随 Obsidian | 中文 / English，其他系统语言自动英文 |
| 服务端口 | 3080 | DSH Web GUI 监听端口 |
| 启动命令 / 工作目录 | 空 | 自定义 `dsh web` 启动方式（支持 `{port}` 占位） |
| 离线时自动启动 | 开 | 打开面板时若无服务自动拉起 |
| 进程独立常驻 | 开 | 关闭 Obsidian 后 DSH 继续运行 |
| 一键安装 DSH 本体 | 按钮 | 自动装依赖 → 克隆（实时百分比）→ 装依赖（进度条）→ 自动配置 |
| 自动检查更新 | 开 | 打开面板/启动服务时自动检测 DSH 新版本（有新版才弹窗，可查看 GitHub 更新内容或立即更新） |
| 检查 DSH 更新 | 按钮 | 手动检查；官方源失败自动走只读镜像 |
| 插件信息 | 行 | 显示插件已安装版本；内置更新日志弹窗 + 「检查插件更新」（打开 Obsidian 官方商店页）+ GitHub 主页网址原文链接（使用反馈欢迎留言） |
| 底部垫高 | 20px | 面板底部留白（0–30px）：Obsidian 状态栏遮挡面板底部时使用 |
| 快捷键透传 | 开 | 光标聚焦在 DSH 面板内时 Obsidian 全局快捷键仍可响应（自动读取你的快捷键设置） |
| 更新日志 | 链接 | 打开 DSH（本体）GitHub Releases 页，查看各版本更新内容；插件自身的更新日志为内置弹窗 |
| AED for DSH | 按钮 | 下载并运行dsh-fix，并以安全模式启动DSH；请在DSH进入安全模式后命令DSH进行自我修复 |
| 安全模式启动 | 按钮 | 仅以安全模式启动 DSH（禁用全部用户插件）；旁边按钮可退出安全模式并恢复插件 |
| 更新镜像地址 | 空 | 自定义更新镜像；留空自动用 gh-proxy 兜底 |
| 安装地址 | 官方仓库 | 克隆地址，网络受限可换代理镜像 |
| 诊断 | 日志 | 启动耗时记录（最近 5 次）：插件加载 → 服务探测 → 服务启动 → 面板就绪 |

### 隐私与数据使用

- **插件层**：插件不包含 DSH 的任何实现，界面与能力来自本机运行的 DSH Web GUI（`dsh web`）；插件与 DSH 之间仅通过本机回环（127.0.0.1）通信；插件自身发起的外网请求只有你主动触发的（克隆 DSH、检查更新）。无遥测。
- **DSH 层**：DSH 是 AI agent 框架，你使用它执行任务时，它会按需发起外网请求（如调用 AI 模型 API、访问工具/网页等），这些请求的内容由你所执行的任务决定。
- **数据流向由你掌控**：DSH 将模型请求发往你配置的 provider（默认 DeepSeek 官方 API；`baseURL` 支持 OpenAI-completions/Responses、Anthropic-messages 等协议——可指向本地模型如 Ollama/vLLM，此时数据不出本机）。Vault 索引、会话记录与 API key 凭证均存于本机（本地凭证库）。
- **无遥测、无第三方中转**：插件不运行遥测信标；Obsidian、插件与 DSH 之间没有云中转。

### 故障排查

| 症状 / 报错原文 | 原因 | 修复 |
|-----------------|------|------|
| 面板打不开 | 工作目录不对、`pnpm` 不在 PATH、端口被占用 | 错误视图会给出原因与手动启动命令（复制即用） |
| `spawn dsh ENOENT` / 「找不到 dsh」 | Windows 下 npm 系 `.cmd` shim 无法被 Node 直接执行 | 插件已内置 `cmd.exe` 包装；重载插件（彻底重启 Obsidian） |
| `EADDRINUSE` / 端口 3080 被占用 | 残留 DSH 进程占着端口 | 设置 →「快捷操作」→「重启服务」 |
| 「桥接未就绪，改为直接发送」 | 桥接脚本尚未注入面板 | 设置 →「快捷操作」→「重启服务」（插件更新后请先彻底重启 Obsidian 再重启 DSH 服务） |
| 更新 CLI 时 `koffi.node EBUSY` | 运行中的 DSH 锁住了原生模块 | 插件更新前会先停服务；否则手动停 DSH 后重试 |
| `Could not resolve host` / 更新失败 | github.com 被墙或不稳定 | 检查网络；或换用「更新镜像地址」 |
| npm 全局安装收尾挂起 | 该包的已知 npm 行为 | 以安装后 `package.json` 的版本为准验证，而非控制台输出 |

### 架构

```
src/
├── main.ts                  # 插件入口：命令/菜单/桥接接线/打点
├── service-manager.ts       # DSH 服务探活/启动/重启（清理端口占用）
├── bridge.ts                # DSH 官方扩展缝：补丁文件 + 注入桥接脚本
├── dsh-api.ts               # 本机 RPC 客户端（session.list/prompt/history，走 127.0.0.1）
├── startup-profiler.ts      # 启动耗时打点（各阶段 → data.json）
├── installer.ts             # 一键安装：依赖（winget/npm/镜像）+ 克隆 + 构建 + CLI
├── updater.ts               # 更新检查（官方+镜像），仅正式版门禁
├── aed.ts                   # dsh-fix 安全模式抢救
├── view.ts                  # 内嵌面板（iframe）+ 错误视图
├── settings.ts              # 设置页（语言/桥接/诊断）
├── changelog.ts             # 插件更新日志弹窗（+ changelog-data.ts 数据）
├── i18n.ts                  # 中英双语词典
└── win-exec.ts              # Windows npm 系命令的 cmd.exe 包装
```

### 开发

```bash
npm run dev        # esbuild 监听模式
npm run build      # 生产构建并安装
npm test           # 单元测试
npm run typecheck  # 类型检查（tsc --noEmit）
npm run release:check  # 发布前全量门禁（测试+lint+类型检查+审核风格校验）
```
