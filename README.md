# DeepSeek Harness（Obsidian 插件）

> **Status: released** · **Desktop only** (macOS / Windows / Linux)
>
> [English](#en) · [中文](#zh)

原生 DSH Web UI 直接嵌进 Obsidian：侧边栏图标一键打开，可调缩放、外观随主题——两个开源软件的**无痕嫁接**，零改动 DSH 源码，随 DSH 版本演进持续可用。**一键配置**：自动安装/识别 DSH 并补齐依赖；**静默运行**：服务后台启动，无任何命令行窗口；支持**文字桥接**、中英双语、Windows/macOS，可一键重启服务、自动检查 DSH 更新。全部流量只在本机回环。

<a id="en"></a>

## English

**DeepSeek Harness** is an Obsidian desktop plugin that embeds the native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI directly into your vault — a **seamless graft of two open-source tools**: zero DSH source changes (connected through DSH's official extension seam), so it keeps working as DSH evolves. One click configures everything and runs the service silently in the background. Desktop only (Windows / macOS).

> Thanks to the **DeepSeek** and **Obsidian** open-source teams, and to **Claudian** — whose selection-send interaction inspired this plugin.

### Features

- One-click sidebar icon (DS) or command palette to open the DSH panel (iframe embed, full feature parity with the browser UI).
- **Send selected text to DSH (text bridge)**: select text in the editor, then use the command palette, the right-click menu, or the floating "Send to DSH" button. When the bridge is loaded the text is **filled into the DSH input box** (review, then send); otherwise it falls back to direct sending to the most recent DSH session. Works via DSH's local API / official user-extension seam (`~/.dsh/profiles/web` patch layer + index.html bridge injection) — zero DSH source changes, and the bridge installs/repairs itself (rewrite + restart from plugin settings).
- **"Ask AI how to fix" on error**: when the panel can't load, the error view now offers **Reconnect** · **Ask AI how to fix** · **Settings** — the ask-AI button automatically composes a diagnostic (error detail, human-readable hint, port, working directory, startup command), **copies it to the clipboard and opens the DeepSeek web chat** (chat.deepseek.com) so you can paste (Ctrl+V) and send it for a fix path.
- **Bilingual UI (Chinese / English)**: a **Language** setting (Basic Setup) with *Follow Obsidian* / 中文 / English. `Follow Obsidian` uses the Obsidian UI language — Chinese for zh\*, **English for any other system language** (ja/fr/de/…) or when unavailable.
- **One-click install with auto dependencies & live progress**: clones the official DSH repository, **auto-installs any missing tools (git / Node.js / pnpm — via winget or brew, no separate steps needed)**, installs dependencies and fills in the startup config. A **progress bar** shows the current stage — dependency installs, live download percentage (`Receiving objects: NN%`), and dependency-install elapsed time.
- **One-click detection**: locates an existing DSH install on your machine (PATH or common directories) and configures startup command and working directory for you.
- Auto-start: starts the DSH service automatically when the panel is opened and no service is running; the process is stopped when Obsidian exits (unless "detached" is enabled).
- **Silent background startup**: on Windows the DSH service starts with a hidden console (VBS `SW_HIDE`, the whole process chain — cmd → pnpm → node → DSH background jobs — inherits one hidden console, so **no cmd/console window ever appears**), in its own process group — closing any terminal or cmd window will not stop the service.
- **Runtime service monitoring**: while the panel is open the plugin probes the service periodically — if DSH crashes or disconnects, the panel switches to an error view showing the reason plus **Reconnect** / **Ask AI how to fix** / **Settings** buttons and a copy-ready manual startup command.
- Update check: queries the latest commit on GitHub (`git ls-remote`) and offers a fast-forward `git pull` when a new version is available.
- Page zoom (0.05x steps, 0.5x–2.0x), Obsidian-themed UI, light/dark theme support.
- Quick actions in plugin settings: **Reconnect service** and **Open DSH in browser**.

### Quick Start

1. Install "DeepSeek Harness" from Settings → Community plugins → Browse.
2. Open plugin settings → click **Install DSH** (one-click install of DeepSeek Harness itself; missing git/node/pnpm are auto-installed via winget — works even without Node.js, no restart needed) — or click **Detect & Fill** if you already have DSH installed.
3. Click the ribbon icon (DS) to open the panel. That's it — no manual configuration required.

### Requirements

- Obsidian desktop v1.7.2+ (mobile is not supported).
- One-click install auto-provisions missing tools per platform: Windows via `winget` (including pnpm without Node), macOS via `brew` (`git`/`node`/`pnpm`), others need `git` + `pnpm`/`npm` available.
- macOS note: Obsidian launched from the Dock inherits a minimal PATH; the plugin auto-merges common tool dirs (`/opt/homebrew/bin`, `/usr/local/bin`), so brew-installed tools are found without restart.

### Privacy

- All traffic stays on the loopback interface (127.0.0.1). The plugin does not send any data to external services; the only outbound network calls are the ones you trigger (cloning DSH, checking for updates via git).
- The plugin contains no DeepSeek Harness implementation — it embeds the locally running DSH Web GUI.

### Install from source

```bash
cd "06 coding/dsh-obsidian"
npm install
npm run build   # installs main.js / manifest.json / styles.css into .obsidian/plugins/dsh-harness/
```

Then enable "DeepSeek Harness" in Obsidian → Settings → Community plugins.

---

<a id="zh"></a>

## 功能

- 侧边栏图标（DS）+ 命令面板「打开 DeepSeek Harness」
- iframe 内嵌 DSH Web GUI（默认 http://127.0.0.1:3080/），功能与浏览器访问一致
- **文字桥接（选中文字发送到 DSH）**：框选编辑器文字后，通过命令面板「发送选中文字到 DSH」/ 编辑器右键菜单 / 选区旁浮动按钮把文字送进 DSH。经 DSH **官方用户扩展机制**（`~/.dsh/profiles/web` 补丁层 + index.html 注入桥，零 DSH 源码改动、免重建）把文字**填入 DSH 输入框**（可编辑后手动发送）；桥接未加载时自动降级为直接发送。端用户只需更新插件
- **界面语言（中英双语）**：基础设置「界面语言」可选 跟随 Obsidian / 中文 / English。跟随系统时按 Obsidian 界面语言判断——zh\* 显示中文，**其余任何语言（ja/fr/de…）或不可用时自动英文**
- **错误视图「问问 AI 怎么解决」**：面板加载失败的错误视图提供「重连服务」「问问 AI 怎么解决」「打开设置」三个按钮；点「问问 AI 怎么解决」自动把报错信息（错误详情 + 人话提示 + 端口 + 工作目录 + 启动命令）拼成诊断文本**复制到剪贴板并打开 DeepSeek 网页版**（chat.deepseek.com），粘贴（Ctrl+V）后发送求解决路径
- 服务探测：端口已有服务时直接使用；离线时按配置自动启动
- **运行期服务监控**：面板打开时周期探测，DSH 中途崩溃/断开自动切到错误视图——显示原因 + 重连/问问 AI/设置 按钮 + 手动启动命令（复制即用）
- 启动失败时显示原因与手动启动命令示例（复制即用）
- **全程静默（Windows）**：DSH 服务经隐藏控制台（VBS SW_HIDE）启动，整条进程链（cmd → pnpm → node → DSH 后台任务）共用一个隐藏控制台——启动与运行期间均不会出现任何 cmd/控制台窗口；独立进程组运行，关闭任何 cmd/终端窗口都不会中断服务
- **一键安装自动配依赖 + 实时进度**：git / Node.js / pnpm 缺失时**自动经 winget/brew 安装**（无需单独操作，无 Node 也能装 pnpm，装后自动刷新 PATH）；克隆阶段**实时显示下载百分比**（`Receiving objects: NN%`），依赖安装阶段显示已用时长，进度条贯穿全程
- 页面缩放设置（0.5×–2.0×，步进 0.05），界面样式对齐 Obsidian 主题
- 设置页快捷操作：「重连服务」「在浏览器打开 DSH」
- 桌面端限定（Windows / macOS / Linux）

## 致谢

感谢 [Claudian](https://github.com/YishenTu/claudian)（Obsidian 内的 AI 编码 agent 插件）——本插件的「框选发送」交互正源自其设计灵感。感谢 [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) 与 [Obsidian](https://obsidian.md) 开源团队——正是这种开放、共享的互联网精神，让 DeepSeek Harness 插件这样的小工具得以诞生。向所有开源贡献者致敬。

## 依赖与数据说明

- 插件本身不包含 DeepSeek Harness 的任何实现；界面与能力来自本机运行的 DSH Web GUI（`dsh web`）。
- 所有流量均在本机回环地址（127.0.0.1）内，插件不向外部发送任何数据。
- 插件可在 DSH 服务未运行时自动启动它；该进程默认随 Obsidian 退出而终止。

## 安装

### 方式一：零基础（推荐）

启用插件后，在插件设置中点「**一键安装 DSH 本体**」——自动克隆 DeepSeek Harness 官方仓库、安装依赖并填充启动配置。git / Node.js / pnpm 缺失时**自动安装**（Windows 经 winget、macOS 经 brew；**没装 Node 也能装 pnpm**；安装后自动刷新 PATH，无需重启 Obsidian），全程**进度条实时显示**下载百分比与阶段用时。

### 方式二：本机已有 DSH

启用插件后，在插件设置中点「**一键检测配置**」——自动识别本机 DSH 位置并填充启动命令与工作目录。

### 方式三：手动构建

1. 构建（需要 Node.js 18+）：
   ```bash
   cd "06 coding/dsh-obsidian"
   npm install
   npm run build
   ```
2. 构建脚本自动将 `main.js` / `manifest.json` / `styles.css` 安装到 `.obsidian/plugins/dsh-harness/`。
3. Obsidian → 设置 → 第三方插件 → 启用「DeepSeek Harness」。

## 使用

- 点击左侧边栏图标，或命令面板执行「打开 DeepSeek Harness」。
- 面板右上角刷新按钮：重新探测服务并重载界面。
- 面板位置可拖拽到任意停靠区。

## DSH 前置条件

插件需要本机可运行 `dsh web`（DeepSeek Harness 的服务端）。两种方式：

- `dsh` 已在 PATH 中：设置中「启动命令」留空，插件自动探测。
- 未加入 PATH（如本机）：在设置中填写启动命令与工作目录，例如：
  - 启动命令：`pnpm dsh web --port {port}`（`{port}` 会自动替换为端口号）
  - 工作目录：DeepSeek Harness 仓库路径（如 `D:\deepseek-harness`）

## 设置项

| 设置 | 默认值 | 说明 |
|------|--------|------|
| 界面语言 | 跟随 Obsidian | 插件界面语言：跟随 Obsidian（zh\* 中文，**其他系统语言自动英文**）/ 中文 / English |
| 服务端口 | 3080 | DSH Web GUI 监听端口 |
| 启动命令 | 空（自动探测 dsh；否则兜底 `pnpm dsh web --port {port}`） | 支持 `{port}` 占位 |
| 工作目录 | 空（Vault 根目录） | 启动 DSH 时的工作目录（DSH 工作区） |
| 离线时自动启动 | 开 | 打开面板时若端口无服务则自动运行启动命令 |
| 进程独立常驻 | 开 | 插件启动的 DSH 进程在 Obsidian 退出后继续运行（默认开启，下次打开即用） |
| 启动等待时间 | 300 秒 | 自动启动后等待服务就绪的最长时间（60–600 秒）；首次启动可能需要 1–2 分钟 |
| 页面缩放 | 0.6 | DSH 页面缩放比例（0.5–2.0，调整后立即生效） |
| 选中文字发送与桥接（分组） | — | 合并区：桥接状态（含「重新写入」）、框选后显示发送按钮、发送后自动打开面板、附带来源标签、重启 DSH 服务 |
| 框选后显示发送按钮 | 开 | 框选编辑器文字后自动显示「发送到 DSH」浮动按钮 |
| 发送后自动打开面板 | 开 | 发送选中文字后自动打开/切换 DSH 面板 |
| 附带来源标签 | 开 | 发送时自动加「[来源：Obsidian 笔记 <绝对路径>]」，让 DSH 直接定位文件 |
| 桥接状态 | 状态+按钮 | 桥接文件是否安装/已加载（已加载 ✓ 时选中文字填入输入框）；「重新写入」修复损坏的桥接文件 |
| 重启 DSH 服务 | 按钮 | 结束占用端口的进程并重启，用于加载桥接补丁（会中断当前 DSH 任务） |
| 快捷操作 | 按钮 | 「重连服务」「在浏览器打开 DSH」（设置页直达） |
| 一键检测配置 | 按钮 | 自动扫描本机 DSH（PATH 或常见目录）并填充启动命令与工作目录 |
| 一键安装 DSH 本体 | 按钮 | **自动安装缺失依赖（git/node/pnpm，winget/brew）→ 克隆官方仓库（实时下载百分比）→ 安装依赖（进度条全程显示）**，完成后自动配置 |
| 安装目录 | 空（用户目录/deepseek-harness） | 一键安装时的目标目录 |
| 安装地址 | 官方仓库 | 克隆地址；网络受限可换代理镜像 |
| 更新镜像地址 | 空（自动 gh-proxy 兜底） | DSH 更新的只读镜像；官方源被墙时自动走镜像 |
| 检查 DSH 更新 | 按钮 | 对 DSH 仓库 git fetch 比较版本；发现新版本时询问是否更新（快进式 pull，官方源失败自动走镜像） |

## 故障排查

- **面板提示无法连接/启动失败**：将错误视图中的命令复制到终端手动运行验证；常见原因：工作目录不正确、`pnpm` 不在 PATH、端口被其他程序占用。
- **「DSH 桥接未就绪，已改为直接发送」**：桥接未加载时发送会降级为直发（文字仍能送达）。修复：插件设置 →「选中文字发送与桥接」→「重启 DSH 服务」加载桥接补丁（**插件更新后需先彻底重启 Obsidian，再重启 DSH 服务**——旧插件代码会把桥接文件写回旧版）；「重新写入」可修复损坏的桥接文件。
- **启动命令格式**：启动命令按空白拆分，不支持含空格的未加引号命令路径；如 `dsh`/`pnpm` 不在 PATH，建议使用命令名 + 正确工作目录（交由 PATH 解析），或改用不含空格的路径。
- **端口被占用**：在设置中更换端口，并确保 DSH 以同一端口启动（如 `dsh web --port 3081`）。
- **手动启动 DSH**：`dsh web`（或 `pnpm dsh web`），保持终端运行即可；插件会直接复用该服务。

## 开发

```bash
npm run dev     # esbuild 监听模式
npm run build   # 生产构建并安装到插件目录
npm test        # 单元测试（ServiceManager）
```

## 说明

- 仅桌面端；移动端不支持。
- 插件本身不包含 DSH 任何功能实现，界面与能力来自 DSH Web GUI（随 DSH 版本演进）。
