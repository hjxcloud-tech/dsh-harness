# DeepSeek Harness（Obsidian 插件）

在 Obsidian 中打开 DeepSeek Harness 的 Web GUI：左侧边栏图标一键打开面板；DSH 服务未运行时自动启动，失败时给出指引。

## 功能

- 侧边栏图标（DS）+ 命令面板「打开 DeepSeek Harness」
- iframe 内嵌 DSH Web GUI（默认 http://127.0.0.1:3080/），功能与浏览器访问一致
- 服务探测：端口已有服务时直接使用；离线时按配置自动启动
- 启动失败时显示原因与手动启动命令示例（复制即用）
- 页面缩放设置（0.5×–2.0×），界面样式对齐 Obsidian 主题
- 桌面端限定（Windows / macOS / Linux）

## 依赖与数据说明

- 插件本身不包含 DeepSeek Harness 的任何实现；界面与能力来自本机运行的 DSH Web GUI（`dsh web`）。
- 所有流量均在本机回环地址（127.0.0.1）内，插件不向外部发送任何数据。
- 插件可在 DSH 服务未运行时自动启动它；该进程默认随 Obsidian 退出而终止。

## 安装

### 方式一：零基础（推荐）

启用插件后，在插件设置中点「**一键安装 DSH 本体**」——自动克隆 DeepSeek Harness 官方仓库、安装依赖并填充启动配置（需本机有 git 与 pnpm）。

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

- 点击左侧边栏的小鲸鱼图标，或命令面板执行「打开 DeepSeek Harness」。
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
| 进程独立常驻 | 关 | 开启后插件启动的 DSH 进程在 Obsidian 退出后继续运行 |
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
