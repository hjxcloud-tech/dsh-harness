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

**Embed the native DSH Web UI into your vault — one-click setup, silent operation, a two-way bridge, and it keeps working as DSH evolves.**

**把 DSH 原生 Web UI 无痕嵌入 Obsidian：一键配置、静默运行、笔记与 DSH 双向桥接，随 DSH 演进持续可用。**

---

<a id="en"></a>

## English

An Obsidian **desktop** plugin that embeds the native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web UI into your vault. It touches no DSH source (it uses DSH's official extension seam), keeps working as DSH evolves, needs no command line, and reaches DSH over the local loopback by default.

### Features
- **One-click setup** — installs or detects DSH and auto-installs missing tools (git / Node.js / pnpm) with a live progress bar.
- **Silent operation** — the DSH service starts in the background with no console window; crashes are detected and reconnected in one click.
- **Native Web UI** — the real DSH interface in an iframe, with 0.5×–2.0× zoom and theme-following styling.
- **Two-way bridge** — selecting text in a note injects an implicit line (exact line:col + word count, no original text) into the DSH chat so DSH can read and edit the file itself; DSH artifacts inside your vault open in Obsidian with one click.
- **Shortcut passthrough & self-healing** — Obsidian global shortcuts still work inside the panel, and the bridge plus launch credential are refreshed automatically after DSH or plugin updates.
- **Multi-profile coexistence** — bind the panel to another DSH profile (e.g. `test`) next to the desktop app's `web`; the plugin builds it from the web template, launches it on its own port and restarts only what it launched.
- **Version-aware updates, official packages only** — one-click install/update takes DSH's official latest on the channel you pick (stable / pushed rc & beta / alpha), the compatibility note follows the verified range, and same-named third-party npm packages are never mistaken for DSH.
- **Safe upgrades & session repair** — every DSH process is stopped before an update (Windows file locks) with sessions backed up and re-checked; a read-only checker plus one-click "back up and repair" handles sessions that a format drift leaves unreadable.
- **Silent compatibility verdict** — version, live-bridge check and a read-only seam self-check above the verified upper bound are shown as plain text in the status row and settings, never as a dialog.
- **AED rescue** — when DSH won't start, one click runs dsh-fix (a standalone npm global CLI, kept up to date) to enter safe mode and rescue it, then verifies the launch and offers fixes; the symptoms it covers are listed in the "What it can fix" popup on its settings row, and unreadable sessions belong to **Session repair**.
- **Custom endpoint & native HTTPS** — point the plugin at the local address DSH is bound to (IPv4/IPv6, optionally https via `--tls-cert/--tls-key`); details in Key settings.
- **One-click phone access** (top of the Service runtime group) — generates a local HTTPS certificate, fills in the LAN host / protocol / certificate / key paths and drops `rootCA.pem` on the Desktop, with pre-flight risks, iOS/Android setup steps and a one-click reset of the endpoint settings. Keep the computer powered on and awake (no sleep) while the phone is using it.
- **Errors explained, faster starts** — failures show a plain-language reason with one-click reconnect / "Ask AI how to fix"; capability probes are cached and a startup timing log sits in Settings → Diagnostics.

### Requirements & install
- Obsidian **desktop** v1.7.2+ (Windows / macOS).
- DSH: the plugin can install it for you (git / Node.js / pnpm are auto-installed; mirror fallback when the official source is blocked). **Verified range: DSH 0.1.5-rc.1 ~ 0.2.1-rc.2**; 0.1.2–0.1.4 are known incompatible, and outside the range nothing is promised.
- A model API key for DSH (default: DeepSeek API; any OpenAI/Anthropic-compatible endpoint, including a local model).
- Install from the community store (Settings → Community plugins → Browse → search "DeepSeek Harness"), from an existing local DSH (Settings → "One-click detect & configure"), or from source (`npm install && npm run build` installs into `.obsidian/plugins/dsh-harness/`).

### Key settings
| Setting | Default | Description |
|---------|---------|-------------|
| Interface language | Follow Obsidian | Chinese / English; other system languages fall back to English |
| Service address | 127.0.0.1 | Endpoint host the panel connects to — must match `dsh web --host`: a local IPv4 or IPv6 literal (`127.0.0.1`, `192.168.1.5`, `::1`), no scheme/port/wildcard; a non-loopback address exposes DSH to your LAN (https and trusted networks only) |
| Service port | 3080 | Port the DSH Web GUI listens on (with the address above and protocol below it forms the endpoint) |
| Service protocol | http | `http` or `https`; `https` requires the two certificate paths below (DSH 0.2.1-rc.2's `--tls-cert` / `--tls-key`) |
| HTTPS certificate PEM | empty | Path to the certificate PEM (not its contents). Passed to DSH as `--tls-cert` and also used as the plugin's trust anchor, so it must be the server certificate **chain** containing the leaf (concatenate a private CA into the same file; a self-signed single certificate is its own anchor). A custom command that supplies `--tls-cert` may instead point this at the issuing CA |
| HTTPS private key PEM | empty | Path to the private key PEM (not its contents), paired with the certificate; passed as `--tls-key` |
| DSH profile | web | Pick an existing profile or type a new name (asks first); non-web profiles are built from the web template, get their own bridge and port; built-in names (acp / headless / sdk / sdk-minimal) are rejected |
| Auto-start / detached process | on / on | Start the service when the panel opens with none running; keep DSH running after Obsidian exits |
| Startup timeout | 300s | Max wait for the service after auto-start (60–600s); the first start may take 1–2 minutes |
| Startup command / working directory | empty | Empty = the plugin builds the command from the endpoint above (auto-appending `--host` / `--tls-cert` / `--tls-key`); a value is used verbatim with no flags added |
| One-click install DSH | button | Dependencies → clone (live percentage) → install (progress bar) → configure; the clone URL can switch to a proxy mirror |
| DSH updates | follow pushed | Auto-check at most once per 24h by default on the channel: stable only / follow pushed rc & beta / include alpha; manual check and a custom mirror URL live on the same row, and it never installs silently |
| Current compatibility | row | Detected version and verdict (supported ✓ / known-incompatible ✗ / older or newer than verified ⚠ / bridge missing / unverifiable) with "re-check now"; text only, no dialogs |
| Session repair | button | Read-only scan with DSH's own format chain; back up and repair the sessions the current format rejects (older-format sessions are left for DSH to migrate) |
| Plugin info | row | Plugin version, in-app changelog and DSH compatibility modals, "check plugin updates", GitHub repo; the DSH changelog link opens its Releases page |
| Bottom padding | 20px | Empty space below the panel (0–30px) when the Obsidian status bar covers it |
| Shortcut passthrough | on | Obsidian global shortcuts still work while focus is inside the DSH panel |
| Two-way bridge | on / auto-send | Note selection → DSH chat (implicit info line); DSH artifacts → Obsidian: cancel / auto-send / right-click send |
| AED for DSH | button | Downloads and runs dsh-fix to enter safe mode and rescue a DSH that won't start, then verifies the launch; the inline "What it can fix" link lists the symptoms |
| Mobile access setup | buttons + link | At the **top of the Service runtime** group: **Generate & fill** creates a self-signed HTTPS certificate (Desktop `rootCA.pem`) and fills host (LAN IPv4) / protocol / certificate / key; the "How it works" link lists scenes, requirements and limits (including keeping the computer awake); **Reset endpoint defaults** returns to 127.0.0.1 / http / empty paths and keeps the certificate files and any trust already installed |
| Connection address | row + button | Shows the endpoint the plugin actually connects to (`http(s)://host:port`) and runs a read-only TCP + `GET /` check: not running / timeout / untrusted, mismatched or expired certificate (the raw TLS code is included) |
| Diagnostics | log | Startup timing log (last 5 runs): plugin load → service probe → service start → panel ready |

### Privacy & data use
- **Plugin layer** — the plugin contains no DSH implementation and reaches DSH over local HTTP(S): the local loopback by default, or another local bind address you configure. The only outbound requests it makes are the ones you trigger (cloning DSH, checking updates). No telemetry, no third-party relay.
- **DSH layer** — DSH is an AI agent framework; when you run a task it makes outbound requests as needed (model APIs, tool/web access), and what is sent depends on the task.
- **Your data, your provider** — model requests go to the provider you configure (default DeepSeek API; OpenAI-completions/Responses, Anthropic-messages, or a local model such as Ollama/vLLM, where data never leaves your machine). Vault index, session history and API keys stay local.
- **LAN exposure** — a non-loopback service address exposes DSH to your network; use https and only trusted networks.

### Troubleshooting
| Symptom / error | Cause | Fix |
|-----------------|-------|-----|
| Panel won't open | Wrong working directory, `pnpm` missing, port taken, or the service address/protocol doesn't match the running instance | The error view shows the reason + a copy-paste startup command; make the service address match `dsh web --host` |
| `spawn dsh ENOENT` / "dsh not found" | Windows `.cmd` shim not resolvable by Node | The plugin wraps npm-style commands via `cmd.exe`; reload the plugin (fully restart Obsidian) |
| `EADDRINUSE` / port 3080 taken | A stale DSH process holds the port | Settings → Quick actions → Restart service |
| "Bridge not ready, sent directly instead" | Bridge script not yet injected into the panel | Restart service (after a plugin update, fully restart Obsidian first) |
| Chat history missing or a session won't open after a DSH upgrade | Session format drift between DSH versions | Settings → Quick actions → **Session repair** → "Back up and repair"; older-format sessions are left for DSH to migrate when opened |
| `dsh web authentication required` after upgrading or restarting DSH | The launch token is generated per process and the cached one is stale | Restart service; the panel reloads with the new credential |
| Self-signed certificate not trusted (`DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) | Certificate not in the OS trust store, and/or no cert PEM configured for the plugin | Import it into the system trust root (Windows "Trusted Root Certification Authorities"; macOS Keychain "Always Trust") **and** paste the same PEM into TLS certificate |
| `ERR_TLS_CERT_ALTNAME_INVALID` / certificate SAN lacks the address | The certificate was issued for another hostname | Re-issue it with the address you enter (`192.168.1.5`, a hostname, …) in the SAN, or use a loopback address |
| Phone still says the certificate is untrusted after installing it | iOS: the profile is installed but not enabled under Certificate Trust Settings. Android: the file went in as a VPN/other profile, or only into user credentials while the browser still checks the system store | iOS: Settings → General → About → Certificate Trust Settings → enable the root. Android: reinstall it as a "CA certificate" (not VPN) and check the phone's clock |
| Phone loses the connection after a while | The computer went to sleep or hibernated — the phone only reaches a running DSH | Disable sleep while the phone is in use: Settings → System → Power & battery → Screen and sleep → Never; on laptops also disable “sleep when closing the lid”, or keep it plugged in |
| "No LAN IPv4 address found" when generating | This machine has no Wi-Fi/Ethernet interface with a private IPv4 (hotspot-only, VPN-only, or all interfaces internal) | Connect to the LAN and retry; or keep the loopback setup and issue a certificate whose SAN contains the IP your phone can reach |
| `https` selected but the service still starts as `http` | Certificate or key empty, or the custom startup command lacks `--tls-cert/--tls-key` | Fill both TLS fields, or clear the custom command and let the plugin generate one (it appends the flags) |
| `unknown option '--host'` / `'--tls-cert'` when the service starts | The installed DSH predates 0.2.1-rc.2, which added these flags | Update DSH, or keep the default loopback/http here (a custom command with these flags only works after upgrading) |
| Custom `--host` but the plugin still probes 127.0.0.1 | The service address setting was not updated | Enter the same address under Service address |
| A DSH instance started in a terminal can't be used in the panel | The embed token is only captured from a process the plugin launched | The plugin can still detect it and open it in a browser; the embedded panel needs a plugin-launched service — Restart service takes the port over |
| `Could not resolve host` / update fails | github.com blocked or flaky | Set the update mirror URL, or check the network |
| npm global install hangs at the end | Known npm behavior on this package | Verify by reading the installed package's `package.json` version, not the console |

### Architecture & development
```
src/
├── main.ts · settings.ts · view.ts        # entry & commands; settings tab; iframe panel
├── service-endpoint.ts                    # service address / protocol / TLS endpoint
├── cert-gen.ts · mobile-access-modal.ts   # self-signed certificate generation; phone-access dialogs
├── service-manager.ts                     # probe / spawn / restart, port-owner cleanup
├── dsh-api.ts · bridge.ts                 # local RPC client; official extension seam + bridge package
├── aed.ts · installer.ts · updater.ts     # dsh-fix safe-mode rescue; one-click install; update check
├── session-repair*.ts · startup-profiler.ts · changelog.ts  # session repair / timing log / changelog
└── i18n.ts · win-exec.ts                  # zh/en dictionary; Windows .cmd wrapper
```

```bash
npm run dev            # esbuild watch mode
npm run build          # production build + install into .obsidian/plugins/dsh-harness
npm test               # unit tests
npm run typecheck      # tsc --noEmit
npm run release:check  # full gate: tests + lint + typecheck + review checks

# optional verification harnesses (need an isolated DSH install; usage in each script header)
node scripts/verify-embed.mjs <dsh-bin.js> <isolated-home> auth      # panel embedding auth matrix
node scripts/verify-session-repair.mjs <isolated-home> <dsh-pkg-dir> # session drift repair end-to-end
node scripts/verify-endpoint-tls.mjs                                 # iso home: https + IPv4/IPv6 endpoint end-to-end
python scripts/sandbox_ui_test.py                                   # real iframe checks (Playwright + Chrome)
```

### Credits
Thanks to the [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) and [Obsidian](https://obsidian.md) open-source teams — the open, shared spirit of the internet makes tools like this possible; and to [Claudian](https://github.com/YishenTu/claudian), whose select-and-send design inspired this plugin's bridge.

---

<a id="zh"></a>

## 中文

一个把 **DeepSeek Harness（DSH）原生 Web UI 无痕嵌入 Obsidian** 的桌面插件：不改 DSH 源码（走官方扩展缝），随 DSH 演进持续可用，无需命令行，默认经本机回环连接。

### 功能
- **一键配置**：自动安装或识别 DSH，缺失的 git / Node.js / pnpm 自动装好，进度条实时可见。
- **静默运行**：DSH 服务后台启动、无控制台窗口；崩溃自动检测，一键重连。
- **原生 Web UI**：iframe 直接嵌入真实 DSH 界面，0.5×–2.0× 缩放，外观跟随主题。
- **双向桥接**：笔记里框选文字 → 自动向 DSH 聊天框注入隐式信息行（精确行:列 + 字数，不含原文），由 DSH 自行读取文件处理；DSH 产物在 Vault 内点击即在 Obsidian 打开。
- **快捷键透传与自愈**：面板内仍响应 Obsidian 全局快捷键；DSH 或插件更新后自动重写桥接、按新凭证重载面板。
- **多 Profile 共存**：面板可绑定另一个 profile（如 test），与桌面版的 web 并存；插件基于 web 模板代建、独立端口拉起，「重启服务」只终止插件自己拉起的实例。
- **版本感知更新、只认官方包**：一键安装/更新取官方最新版，通道可选（仅正式版 / 跟随主推 rc & beta / 含 alpha），弹窗适配说明跟实测区间走，第三方同名 npm 包不会被当成本体。
- **升级更稳与会话修复**：更新前先结束所有 DSH 进程（避免 Windows 文件锁），并备份会话、升级后复检；只读检查器 + 一键「备份并修复」处理格式漂移导致打不开的会话。
- **适配判定静默呈现**：版本、桥接是否真正生效，以及高于上界时的只读触点自检，结论只写在状态横幅与设置页文字里，不弹窗。
- **AED 抢救**：DSH 起不来时，一键用 dsh-fix（独立 npm 全局命令，插件自动保持最新）进入安全模式抢救，完成后校验启动并给出修复建议；能抢救哪些症状见设置页该行「适用症状说明」，会话打不开请用「会话修复」。
- **自定义服务地址与原生 HTTPS**：可对齐 DSH 绑定的本机地址（IPv4/IPv6，经 `--tls-cert/--tls-key` 启用 https），详见「主要设置」。
- **一键手机访问**（位于「服务运行」分组最上方）：自动生成本机 HTTPS 自签证书并填好局域网地址 / 协议 / 证书 / 私钥路径，把 `rootCA.pem` 放到桌面，手机浏览器即可远程访问；生成前有风险提示，成功后按 iOS / 安卓步骤安装信任，可一键恢复默认端点。手机使用期间电脑需保持开机、不睡眠。
- **报错可读、启动更快**：失败时给出原因 + 一键重连 /「询问 AI 如何修复」；能力探测结果缓存，设置 →「诊断」有启动耗时记录。

### 环境要求与安装
- Obsidian **桌面版 v1.7.2+**（Windows / macOS）。
- DSH 本体：插件可一键安装（git / Node.js / pnpm 缺失自动补齐，官方源被墙走镜像）。**实测适配区间：DSH 0.1.5-rc.1 ~ 0.2.1-rc.2**；0.1.2–0.1.4 已知不兼容，超出区间不承诺。
- DSH 模型 API key：默认 DeepSeek 官方 API；可配置任意 OpenAI/Anthropic 兼容端点（含本地模型）。
- 安装：商店（设置 → 第三方插件 → 浏览 → 搜「DeepSeek Harness」）；本机已有 DSH 时启用插件后点「一键检测配置」；源码构建（`npm install && npm run build`，装到 `.obsidian/plugins/dsh-harness/`）。

### 主要设置
| 设置 | 默认 | 说明 |
|------|------|------|
| 界面语言 | 跟随 Obsidian | 中文 / English，其他系统语言回退英文 |
| 服务地址 | 127.0.0.1 | 面板连接的端点主机，须与 `dsh web --host` 一致：本机 IPv4 或 IPv6 字面量（`127.0.0.1`、`192.168.1.5`、`::1`），不带协议/端口/通配地址；非回环地址会把 DSH 暴露到局域网（须 https + 可信网络） |
| 服务端口 | 3080 | DSH Web GUI 监听端口（与地址、协议共同组成端点） |
| 服务协议 | http | `http` / `https`；https 需填下面两项证书路径（DSH 0.2.1-rc.2 的 `--tls-cert` / `--tls-key`） |
| HTTPS 证书 PEM | 空 | 证书 PEM 的**文件路径**（不是内容）。作为 `--tls-cert` 交给 DSH，同时作插件校验锚点，须是含 leaf 的服务器证书链：私有 CA 把 CA 拼进同一文件，自签单证书本身即锚点；自定义启动命令自带 `--tls-cert` 时可改填签发它的 CA。自签名/私有 CA 还须把证书导入系统信任根供内嵌面板加载 |
| HTTPS 私钥 PEM | 空 | 私钥 PEM 的**文件路径**（不是内容），与证书成对；作为 `--tls-key` 交给 DSH |
| DSH Profile（配置档） | web | 下拉选已有 profile 或输入新名（切换前确认）；非 web 档基于 web 模板代建、装桥接、独立端口拉起；内置档名（acp / headless / sdk / sdk-minimal）不可代建 |
| 离线自动启动 / 进程独立常驻 | 开 / 开 | 打开面板时端点无服务则拉起；关闭 Obsidian 后 DSH 继续运行 |
| 启动等待时间 | 300 秒 | 自动启动后等待服务就绪的上限（60–600 秒）；首次启动可能需要 1–2 分钟 |
| 启动命令 / 工作目录 | 空 | 留空＝由插件按上面的地址/端口/协议生成命令（自动附加 `--host` / `--tls-cert` / `--tls-key`）；填入则原样使用、插件不再追加参数 |
| 一键安装 DSH 本体 | 按钮 | 装依赖 → 克隆（实时百分比）→ 装依赖（进度条）→ 自动配置；克隆地址可换代理镜像 |
| DSH 更新 | 跟随主推 | 启动后自动检查（默认 24 小时至多一次）+ 通道：仅正式版 / 跟随主推（含 rc、beta）/ 含 alpha；同行可手动检查、自定义更新镜像，绝不静默安装 |
| 当前适配状态 | 行 | 显示版本与判定（已适配 ✓ / 已知不兼容 ✗ / 旧版或新版本 ⚠ / 桥接未生效 / 版本未能核验），同行可「重新检查」；只呈现文字，不弹窗 |
| 会话修复 | 按钮 | 用 DSH 自带格式链只读体检，对当前格式判定不可读的会话先备份再修复；格式更旧的会话留给 DSH 自行迁移 |
| 插件信息 | 行 | 插件版本、内置更新日志与 DSH 适配说明弹窗、「检查插件更新」、GitHub 主页；DSH 更新日志指向其 Releases 页 |
| 底部垫高 | 20px | 状态栏遮挡面板底部时留白（0–30px） |
| 快捷键透传 | 开 | 面板内仍响应 Obsidian 全局快捷键 |
| 双向桥接 | 开 / 自动发送 | 笔记框选 → DSH 聊天框（隐式信息行）；DSH 产物 → Obsidian：取消 / 自动发送 / 右键发送 |
| AED for DSH | 按钮 | 下载并运行 dsh-fix 进入安全模式抢救起不来的 DSH，完成后校验启动；行内「适用症状说明」链接列出可抢救的症状 |
| 手机访问配置 | 按钮 + 链接 | 位于「服务运行」分组最上方：「生成并填入」生成自签 HTTPS 证书（桌面 `rootCA.pem`）并填好服务地址（局域网 IPv4）/ 协议 / 证书 / 私钥；行内「使用说明」列出适用场景、前置要求与限制（含电脑需保持开机、不睡眠）；「恢复默认端点」退回 127.0.0.1 / http / 空路径，证书文件保留、已安装的信任不撤销 |
| 连接地址 | 行 + 按钮 | 显示插件**实际会连**的端点（`http(s)://host:port`），并做一次只读 TCP + `GET /` 检查：未启动 / 超时 / 证书未受信任、地址不匹配或已过期（附原始 TLS code） |
| 诊断 | 日志 | 启动耗时记录（最近 5 次）：插件加载 → 服务探测 → 服务启动 → 面板就绪 |

### 隐私与数据使用
- **插件层**：插件不含 DSH 实现，经本机 HTTP(S) 访问 DSH——默认走本机回环，可按设置改为本机其他绑定地址；插件自身外网请求只有你主动触发的（克隆 DSH、检查更新）。无遥测、无第三方中转。
- **DSH 层**：DSH 是 AI agent 框架，执行任务时按需发起外网请求（模型 API、工具/网页），内容取决于任务本身。
- **数据流向由你掌控**：模型请求发往你配置的 provider（默认 DeepSeek 官方 API；OpenAI-completions/Responses、Anthropic-messages，或本地模型如 Ollama/vLLM，此时数据不出本机）；Vault 索引、会话记录与 API key 均存本机。
- **局域网暴露**：绑定非回环地址会把 DSH 暴露到你的网络，须启用 https 且仅在可信网络使用。

### 故障排查
| 症状 / 报错原文 | 原因 | 修复 |
|-----------------|------|------|
| 面板打不开 | 工作目录不对、`pnpm` 不在 PATH、端口被占用，或服务地址/协议与运行实例不一致 | 错误视图给出原因与可复制的手动启动命令；同时核对服务地址与 `dsh web --host` 一致 |
| `spawn dsh ENOENT` /「找不到 dsh」 | Windows 下 npm 系 `.cmd` shim 无法被 Node 直接执行 | 插件已内置 `cmd.exe` 包装；重载插件（彻底重启 Obsidian） |
| `EADDRINUSE` / 端口 3080 被占用 | 残留 DSH 进程占着端口 | 设置 →「快捷操作」→「重启服务」 |
|「桥接未就绪，改为直接发送」 | 桥接脚本尚未注入面板 | 设置 →「快捷操作」→「重启服务」（插件更新后先彻底重启 Obsidian） |
| DSH 升级后聊天记录缺失 / 某个会话打不开 | DSH 各版本间会话格式漂移 | 设置 →「快捷操作」→「会话修复」→「备份并修复」；格式更旧的会话直接打开由 DSH 自行迁移 |
| 升级/重启后 `dsh web authentication required` | 启动 token 每进程重新生成，缓存的是旧凭证 |「重启服务」，面板会按新凭证重载 |
| 自签名证书未受信任（`DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`） | 证书未进系统信任根，或未在设置里填证书 PEM | 导入系统信任根（Windows「受信任的根证书颁发机构」；macOS 钥匙串「始终信任」），**并**把同一份 PEM 填进「TLS 证书 PEM」 |
| `ERR_TLS_CERT_ALTNAME_INVALID` / 证书 SAN 不含所填地址 | 证书是给别的主机名签发的 | 用你填写的地址（如 `192.168.1.5`、主机名）重签并把地址写入 SAN，或改用回环地址 |
| 手机装完 CA 后仍提示证书不受信任 | iOS：描述文件装了但没在「证书信任设置」里打开开关；安卓：证书装成了 VPN/其它类型，或只进了用户凭据而浏览器仍校验系统库 | iOS：设置 → 通用 → 关于本机 → 证书信任设置 → 打开该根证书；安卓：重装为「CA 证书」（不是 VPN），并确认手机时间正确 |
| 手机用一段时间后连不上 | 电脑进入了睡眠/休眠（手机只能访问运行中的 DSH） | 手机使用期间关闭睡眠：设置 → 系统 → 电源和电池 → 屏幕和睡眠 → 「从不」；笔记本同时关闭「合盖睡眠」或保持插电 |
| 生成时提示「未找到本机局域网 IPv4 地址」 | 本机没有带私有 IPv4 的 Wi-Fi / 有线网卡（仅热点、仅 VPN，或网卡都处于内部状态） | 连上局域网后重试；或保持回环配置，自行签一张 SAN 含手机可达 IP 的证书 |
| 选了 https，服务仍以 http 启动 | 证书或私钥为空，或自定义启动命令没带 `--tls-cert/--tls-key` | 补全两项 TLS 设置；或清空自定义命令改用插件生成的命令（会自动附加） |
| 启动时报 `unknown option '--host'` / `'--tls-cert'` | 本机 DSH 低于 0.2.1-rc.2，尚无这些参数 | 升级 DSH；升级前把服务地址/协议保持默认回环 + http（自行在命令里写这些 flag 也要先升级） |
| 自定义 `--host` 后插件识别不到 | 设置里的服务地址没同步改 | 在「服务地址」填同一个地址 |
| 用户自己在终端启动的 DSH 无法用于面板 | 嵌入 token 只能从插件拉起的进程日志捕获 | 插件能识别它并在浏览器打开；内嵌面板需由插件拉起服务——用「重启服务」接管端口 |
| `Could not resolve host` / 更新失败 | github.com 被墙或不稳定 | 填「更新镜像地址」，或检查网络 |
| npm 全局安装收尾挂起 | 该包的已知 npm 行为 | 以安装后 `package.json` 的版本为准验证，而非控制台输出 |

### 架构与开发
```
src/
├── main.ts · settings.ts · view.ts        # 入口与命令；设置页；iframe 面板
├── service-endpoint.ts                    # 服务地址 / 协议 / TLS 端点
├── cert-gen.ts · mobile-access-modal.ts   # 自签证书生成；手机访问配置弹窗
├── service-manager.ts                     # 探活 / 启动 / 重启，清理端口占用
├── dsh-api.ts · bridge.ts                 # 本机 RPC 客户端；官方扩展缝 + 桥接独立包
├── aed.ts · installer.ts · updater.ts     # dsh-fix 安全模式抢救；一键安装；更新检查
├── session-repair*.ts · startup-profiler.ts · changelog.ts  # 会话修复 / 启动打点 / 更新日志
└── i18n.ts · win-exec.ts                  # 中英词典；Windows .cmd 包装
```

```bash
npm run dev            # esbuild 监听模式
npm run build          # 生产构建并安装到 .obsidian/plugins/dsh-harness
npm test               # 单元测试
npm run typecheck      # 类型检查（tsc --noEmit）
npm run release:check  # 全量门禁：测试 + lint + 类型检查 + 审核风格校验

# 可选验证脚本（需隔离的 DSH 安装；用法见脚本头部注释）
node scripts/verify-embed.mjs <dsh-bin.js> <隔离 home> auth              # 面板嵌入认证矩阵
node scripts/verify-session-repair.mjs <隔离 home> <DSH 安装包目录>      # 会话漂移修复端到端
node scripts/verify-endpoint-tls.mjs                                    # 隔离 home：https + IPv4/IPv6 端点端到端
python scripts/sandbox_ui_test.py                                       # 真实 iframe UI 检查（Playwright + Chrome）
```

### 致谢
感谢 [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) 与 [Obsidian](https://obsidian.md) 开源团队——开放、共享的互联网精神让这样的工具得以诞生；感谢 [Claudian](https://github.com/YishenTu/claudian)，本插件「框选发送」的交互灵感源自其设计。
