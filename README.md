# DeepSeek Harness for Obsidian

> **Status: released** · **Desktop only**（Windows / macOS）· [English](#en) · [中文](#zh)

原生 DSH Web UI 直接嵌入 Obsidian：点一下侧边栏图标，完整界面即开——两个开源软件的**无痕嫁接**，零改动 DSH 源码，随 DSH 版本演进持续可用。服务后台**静默运行**、无控制台窗口；笔记与 DSH 之间**双向桥接**：框选文字直发聊天框，Vault 内路径一键回跳笔记。
一切皆插件。

DeepSeek Harness for Obsidian embeds the native DSH Web UI right into your vault — a seamless graft of two open-source tools. One click configures everything, and the service runs silently in the background with no console window. A two-way bridge links your notes and DSH: select text to send it straight to the chat, and one-click open any in-vault path back in Obsidian. Desktop only (Windows / macOS).
Everything is a plugin.

---

<a id="en"></a>

## English

DeepSeek Harness is an Obsidian desktop plugin that embeds the native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI directly into your vault — a seamless graft of two open-source tools: no DSH source is touched (connected through DSH's official extension seam), so it keeps working as DSH evolves. Everything runs on localhost; nothing leaves your machine.

**Highlights**
- **One-click setup** — installs or detects DSH, auto-installs missing tools (git / Node.js / pnpm) with a live progress bar.
- **Silent operation** — the DSH service starts quietly in the background: no console windows, no terminal to keep open.
- **Native Web UI** — the real DSH interface (iframe embed) with adjustable zoom and theme-following styling.
- **Two-way text bridge** — select text in a note and it fills the DSH chat input directly, with the file path attached; conversely, DSH artifacts/paths that live inside your vault open in Obsidian with one click.
- **Bilingual UI** — Chinese / English, follows your system language.
- **Self-maintaining** — auto-checks GitHub for DSH updates (with read-only mirror fallback), applies on confirmation; restart the service anytime from settings.
- **Error, explained** — failures show plain-language reasons plus one-click reconnect / "Ask AI how to fix".

**Install**: Obsidian → Settings → Community plugins → Browse → search **"DeepSeek Harness"** → Install. Requires Obsidian desktop v1.7.2+. [Build from source](#install-from-source) is also supported.

**Credits**: Thanks to the [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) and [Obsidian](https://obsidian.md) open-source teams — the open, shared spirit of the internet is what makes tools like this possible. And thank you to [Claudian](https://github.com/YishenTu/claudian) (an AI coding-agent plugin for Obsidian), whose design inspired this plugin's select-and-send interaction.

---

<a id="zh"></a>

## 中文

### 这是什么

一个把 **DeepSeek Harness（DSH）原生 Web UI 无痕嫁接到 Obsidian** 的桌面插件。不改 DSH 一行源码（走官方扩展机制），DSH 升级即可用；所有流量只在本机回环，数据不出电脑。

### 功能亮点

**省心接入**
- **一键配置**：自动安装或识别 DSH，缺失的 git / Node.js / pnpm 自动装好，进度条实时可见；小白零命令行上手
- **静默运行**：DSH 服务后台静默启动——无控制台窗口、不用挂终端；服务崩溃自动检测，一键重连/重启
- **自动维护**：自动检查 GitHub 上的 DSH 更新，确认后一键更新（官方源被墙时自动走只读镜像，可在设置中自定义镜像地址）

**原生体验**
- **原生 DSH Web UI**：iframe 直接嵌入，与浏览器访问完全一致；页面可缩放（0.5×–2.0×），外观跟随 Obsidian 主题
- **双向文字桥接**：①笔记里框选文字 → 填入 DSH 聊天框（先确认再发送），自动附上文件路径；②DSH 产物/路径若在 Vault 内 → 点击即在 Obsidian 打开，无缝回跳笔记
- **中英双语界面**：跟随系统语言，非中文系统自动英文

**平台支持**：Windows / macOS（仅桌面端）

### 安装

**方式一：商店安装（推荐）**
Obsidian → 设置 → 第三方插件 → 浏览 → 搜索 **「DeepSeek Harness」** → 安装。无需 GitHub 链接。

**方式二：本机已有 DSH**
启用插件后，在设置中点「一键检测配置」即可自动识别并填充。

**方式三：从源码构建** <a id="install-from-source"></a>

```bash
cd "06 coding/dsh-obsidian"
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
| 重启 DSH 服务 | 按钮 | 一键重启服务（加载桥接补丁） |
| 检查 DSH 更新 | 按钮 | 自动检查并确认后更新，官方源失败走镜像 |
| 更新镜像地址 | 空 | 自定义更新镜像；留空自动用 gh-proxy 兜底 |
| 安装地址 | 官方仓库 | 克隆地址，网络受限可换代理镜像 |

### 隐私与依赖

- 插件不包含 DSH 的任何实现，界面与能力来自本机运行的 DSH Web GUI（`dsh web`）
- 所有流量仅在本机回环（127.0.0.1）；对外网络请求只有你主动触发的（克隆 DSH、检查更新）

### 故障排查

- **面板打不开**：错误视图会给出原因与手动启动命令（复制即用）；常见原因：工作目录不对、`pnpm` 不在 PATH、端口被占用
- **「桥接未就绪，改为直接发送」**：设置 →「选中文字发送与桥接」→「重启 DSH 服务」（插件更新后请先彻底重启 Obsidian 再重启 DSH 服务）
- **更新失败**：检查网络；或换用「更新镜像地址」

### 致谢

感谢 [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) 与 [Obsidian](https://obsidian.md) 开源团队——开放、共享的互联网精神，让这样的工具得以诞生。向所有开源贡献者致敬；感谢 [Claudian](https://github.com/YishenTu/claudian)（Obsidian 内的 AI 编码 agent 插件）——本插件的「框选发送」交互正源自其设计灵感。

### 开发

```bash
npm run dev        # esbuild 监听模式
npm run build      # 生产构建并安装
npm test           # 单元测试
npm run release:check  # 发布前全量门禁（测试+lint+审核风格校验）
```
