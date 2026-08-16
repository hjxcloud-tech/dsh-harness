# DeepSeek Harness（Obsidian 插件）

> **Status: released** · **Desktop only** (macOS / Windows / Linux)
>
> [English](#en) · [中文](#zh)

在 Obsidian 中打开 DeepSeek Harness 的 Web GUI：左侧边栏图标一键打开面板；DSH 服务未运行时自动启动（无任何命令行窗口），失败时给出指引。

<a id="en"></a>

## English

**DeepSeek Harness** is an Obsidian desktop plugin that embeds the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI directly into your vault.

> Thanks to the **DeepSeek** and **Obsidian** open-source teams for their internet-spirit contributions that make tools like this possible.

### Features

- One-click sidebar icon (DS) or command palette to open the DSH panel (iframe embed, full feature parity with the browser UI).
- **One-click install**: clones the official DSH repository, installs dependencies and fills in the startup config automatically.
- **One-click detection**: locates an existing DSH install on your machine (PATH or common directories) and configures startup command and working directory for you.
- Auto-start: starts the DSH service automatically when the panel is opened and no service is running; the process is stopped when Obsidian exits (unless "detached" is enabled).
- **Silent background startup**: on Windows the DSH service starts with a hidden console (VBS `SW_HIDE`, the whole process chain — cmd → pnpm → node → DSH background jobs — inherits one hidden console, so **no cmd/console window ever appears**), in its own process group — closing any terminal or cmd window will not stop the service.
- Update check: queries the latest commit on GitHub (`git ls-remote`) and offers a fast-forward `git pull` when a new version is available.
- Page zoom (0.05x steps, 0.5x–2.0x), Obsidian-themed UI, light/dark theme support.

### Quick Start

1. Install "DeepSeek Harness" from Settings → Community plugins → Browse.
2. Open plugin settings → click **Install DSH** (one-click install of DeepSeek Harness itself; missing git/node/pnpm are auto-installed via winget — works even without Node.js, no restart needed) — or click **Detect & Fill** if you already have DSH installed.
3. Click the ribbon icon (DS) to open the panel. That's it — no manual configuration required.

### Requirements

- Obsidian desktop v1.7.2+ (mobile is not supported).
- For one-click install: Windows 10/11 with `winget`, or any OS with `git` + `pnpm`/`npm` available (Windows will auto-install missing tools via winget, including pnpm without Node).

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
- 服务探测：端口已有服务时直接使用；离线时按配置自动启动
- 启动失败时显示原因与手动启动命令示例（复制即用）
- **全程静默（Windows）**：DSH 服务经隐藏控制台（VBS SW_HIDE）启动，整条进程链（cmd → pnpm → node → DSH 后台任务）共用一个隐藏控制台——启动与运行期间均不会出现任何 cmd/控制台窗口；独立进程组运行，关闭任何 cmd/终端窗口都不会中断服务
- 一键安装缺失依赖（git / Node.js / pnpm 均可经 winget 自动安装，无 Node 也能装；安装后自动刷新 PATH，无需重启）
- 页面缩放设置（0.5×–2.0×，步进 0.05），界面样式对齐 Obsidian 主题
- 桌面端限定（Windows / macOS / Linux）

## 致谢

感谢 [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) 与 [Obsidian](https://obsidian.md) 开源团队——正是这种开放、共享的互联网精神，让 DeepSeek Harness 插件这样的小工具得以诞生。向所有开源贡献者致敬。

## 依赖与数据说明

- 插件本身不包含 DeepSeek Harness 的任何实现；界面与能力来自本机运行的 DSH Web GUI（`dsh web`）。
- 所有流量均在本机回环地址（127.0.0.1）内，插件不向外部发送任何数据。
- 插件可在 DSH 服务未运行时自动启动它；该进程默认随 Obsidian 退出而终止。

## 安装

### 方式一：零基础（推荐）

启用插件后，在插件设置中点「**一键安装 DSH 本体**」——自动克隆 DeepSeek Harness 官方仓库、安装依赖并填充启动配置。git / Node.js / pnpm 缺失时会提示一键安装（Windows 下均经 winget，**没装 Node 也能装 pnpm**；安装后自动刷新 PATH，无需重启 Obsidian）。

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
| 服务端口 | 3080 | DSH Web GUI 监听端口 |
| 启动命令 | 空（自动探测 dsh；否则兜底 `pnpm dsh web --port {port}`） | 支持 `{port}` 占位 |
| 工作目录 | 空（Vault 根目录） | 启动 DSH 时的工作目录（DSH 工作区） |
| 离线时自动启动 | 开 | 打开面板时若端口无服务则自动运行启动命令 |
| 进程独立常驻 | 开 | 插件启动的 DSH 进程在 Obsidian 退出后继续运行（默认开启，下次打开即用） |
| 启动等待时间 | 300 秒 | 自动启动后等待服务就绪的最长时间（60–600 秒）；首次启动可能需要 1–2 分钟 |
| 页面缩放 | 0.6 | DSH 页面缩放比例（0.5–2.0，调整后立即生效） |
| 一键检测配置 | 按钮 | 自动扫描本机 DSH（PATH 或常见目录）并填充启动命令与工作目录 |
| 一键安装 DSH 本体 | 按钮 | 克隆官方仓库并安装依赖，完成后自动配置（需 git 与 pnpm） |
| 安装目录 | 空（用户目录/deepseek-harness） | 一键安装时的目标目录 |
| 安装地址 | 官方仓库 | 克隆地址；网络受限可换代理镜像 |
| 检查 DSH 更新 | 按钮 | 对 DSH 仓库 git fetch 比较版本；发现新版本时询问是否更新（快进式 pull） |

## 故障排查

- **面板提示无法连接/启动失败**：将错误视图中的命令复制到终端手动运行验证；常见原因：工作目录不正确、`pnpm` 不在 PATH、端口被其他程序占用。
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
