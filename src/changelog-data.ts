/**
 * 插件更新日志数据（纯数据，无 obsidian 依赖，可在测试环境解析）。
 * 维护时在数组头部追加新版本条目；版本从新到旧排列。
 */

export interface ChangelogEntry {
  version: string
  /** [中文, English] 更新要点列表。 */
  items: [string, string][]
}

export const PLUGIN_CHANGELOG: ChangelogEntry[] = [
  {
    version: '2.2.0',
    items: [
      [
        'AED 增强：进入安全模式前自动检查插件健康，异常插件临时禁用（退出时自动恢复），坏插件不再让安全模式打不开；完成后校验启动，异常可一键修复',
        'AED enhanced: checks plugin health before entering safe mode; broken plugins are temporarily disabled (auto-restored on exit), so safe mode boots even with broken plugins; verifies boot afterwards and offers one-click fixes',
      ],
      [
        '新增「卸载并重装 DSH（保留聊天记录）」：红色按钮 + 强确认；自动备份聊天记录/凭据/设置/技能后卸载重装',
        'New "Uninstall & reinstall DSH (keep chat history)": red button + strong confirmation; backs up chat/credentials/settings/skills before uninstalling and reinstalling',
      ],
    ],
  },
  {
    version: '2.1.1',
    items: [
      [
        '一键配置 DSH 默认改用全局 CLI 稳定版启动（dsh web --port {port} --no-open）：不再默认运行仓库 master 上的预发布（alpha.3 新增浏览器会话认证，隐藏控制台下无法取得 token URL 会 401）；仅当全局 CLI 安装失败时才回退仓库形态',
        'One-click configure now defaults to the stable global CLI (dsh web --port {port} --no-open) instead of the repo master (a prerelease): alpha.3 added browser-session authentication whose printed token URL is unreachable under the hidden console, causing a 401; the repo form is only used as a fallback when the global CLI install fails',
      ],
    ],
  },
  {
    version: '2.1.0',
    items: [
      [
        'AED 增强：抢救/退出安全模式完成后自动校验 DSH 启动健康（页面启动引导注入 + 客户端模块 bootstrap face）；发现异常弹窗说明错误类型、判断与建议动作，可执行一次性修复（重建桥接补丁 + 清理残留禁用块 + 重启复验）；同类错误不循环弹窗，提示改用其他 harness（dsh-fix doctor/bisect 或重装）；安全模式不再误禁客户端模块（client-modules 纳入核心 bundle，修复 AED 后报「client.js did not export the bootstrap module face」的根因之一）',
        'AED enhancement: after recovery/exit-safe-mode completes, the plugin verifies DSH boot health (page boot injection + client-modules bootstrap face); on failure a modal shows the error type, assessment and a suggested action with a one-shot fix (rewrite bridge patch + remove stale disable blocks + restart & re-verify); no repeated modals for the same error — other harnesses are suggested instead (dsh-fix doctor/bisect or reinstall); safe mode no longer disables the client-modules bundle (moved into the core set, fixing a root cause of "client.js did not export the bootstrap module face" after AED)',
      ],
      [
        '设置页全部行控件（按钮/输入框/下拉框）强制上下居中；AED 说明更新为简介校验功能',
        'All Settings controls (buttons / inputs / dropdowns) are force-vertically-centered; the AED description now introduces the verification feature',
      ],
    ],
  },
  {
    version: '2.0.3',
    items: [
      ['桥接自愈：检测并清除 dsh-fix 安全模式残留的「禁用 dsh-obsidian-bridge」覆盖块（历史复发导致桥接静默失效、面板无法回填文字），补丁写入改原子化；恢复桥接后提示重载生效；设置页「安全模式启动」栏移除，「退出安全模式」并入「AED for DSH」栏；AED 抢救总是安装/升级 dsh-fix 到最新（幂等）', 'Bridge self-healing: detects and removes leftover dsh-fix safe-mode "disable dsh-obsidian-bridge" override blocks (a recurring silent failure), patch writes are now atomic; prompts to reload after restoring; the "Start in safe mode" row is removed and "Exit safe mode" moved into the "AED for DSH" row; AED always installs/upgrades dsh-fix to the latest (idempotent)'],
    ],
  },
  {
    version: '2.0.2',
    items: [
      ['P0 安全与稳定性修复回归：①端口操作安全——重启/更新/AED 前校验 DSH 身份（不再误杀同名端口前缀的无关进程）；②修复路径点击重定向标签跳过失效（退格字节 bug，含控制字符回归测试）；③pre-step 编辑指令带自终止句（避免会话累积重复执行）；④--no-open 探测改异步（不再冻结界面 8-20s），探测失败按「支持」处理（不再漏补导致弹浏览器）；⑤一键安装 PATH 缓存刷新（安装后不再误报依赖仍缺失）；⑥全局 CLI 更新失败自动恢复原服务；⑦设置页输入防抖（端口/命令/滑杆不再逐键重建服务）；⑧CI 增加 typecheck、check-review-lint 改真配对扫描；⑨更新失败提示细化——git 更新遇本地未提交改动时列出冲突文件并指引提交/stash', 'P0 safety & stability fixes restored: ① port-kill safety — DSH identity is verified before restart/update/AED (no longer kills unrelated prefix-matching port owners); ② fixed the label-skip regex backspace-byte bug (with control-character regression test); ③ pre-step edit instructions self-terminate (no repeated execution across turns); ④ --no-open probe is async (no more 8-20s UI freeze) and probe failure is treated as supported (no browser popup from a missing flag); ⑤ installer PATH cache refreshes after install (no more false "dependency still missing"); ⑥ failed global-CLI updates restore the previous service; ⑦ Settings inputs are debounced (no per-keystroke service rebuilds); ⑧ CI gains typecheck and a real eslint-disable pairing scan; ⑨ update-failure messaging lists conflicting files and guides commit/stash'],
    ],
  },
  {
    version: '2.0.1',
    items: [
      ['基于 1.9.9 稳定行为发布（回退 2.0.0 的全面改动，恢复稳定运行）：保留更新检查优化（alpha/beta 预发布识别、npm 通道「已是最新」说明与 GitHub 预览披露）、下拉垂直居中、重启栏位调整；移除 2.0.0 引入的不稳定改动', 'Released on the stable 1.9.9 behavior (2.0.0-wide changes rolled back for stability): keeps the update-check polish (alpha/beta treated as prereleases, npm-only "up to date" notice with GitHub prerelease disclosure), centered dropdown and reordered restart row; removes the unstable 2.0.0 changes'],
    ],
  },
  {
    version: '1.9.9',
    items: [
      ['更新检查优化：①版本判定修正——alpha/beta 识别为预发布（不再误当正式版提示）；②「已是最新」提示明确检测范围仅 npm 官方推送的全局 CLI 版本，若 GitHub 另有未发布到 npm 的预览（如 0.1.2-alpha.1）会一并告知，避免误以为漏检；③设置页「DSH 聊天框桥接到 Obsidian」下拉框垂直居中；④快捷操作区「重启 DSH 服务」移到「重连服务」下方', 'Update check improvements: ① version semantics fixed — alpha/beta are treated as prereleases (no longer mislabeled as stable); ② the "up to date" notice now states it only checks the npm-published global CLI version, and tells you when GitHub has a newer prerelease not yet published to npm (e.g. 0.1.2-alpha.1), so it never looks like a missed update; ③ the "DSH chat → Obsidian" dropdown is vertically centered in Settings; ④ "Restart DSH service" moved right below "Reconnect" in the Quick Actions section'],
    ],
  },
  {
    version: '1.9.8',
    items: [
      ['自动注入不覆盖聊天框已输入内容：隐式信息行改为在你的输入之上生成、换行后保留你已输入的文字（多次框选只保留最新隐式行；取消框选仅清除隐式行、保留你的输入）', 'Auto-inject no longer overwrites what you already typed in the chat: the implicit line is placed above your text and your input is kept after a line break (repeated selections keep only the latest line; deselecting clears only the implicit line, keeping your input)'],
    ],
  },
  {
    version: '1.9.7',
    items: [
      ['修复焦点抢占：注入隐式信息行后不再把焦点移入 DSH 聊天框——框选文字后按 Backspace 等键盘操作仍作用于 Obsidian 文档，不再误删聊天框内容', 'Fix focus stealing: filling the implicit line no longer moves focus into the DSH chat, so keyboard actions (e.g. Backspace) after selecting text still act on the Obsidian note instead of the chat box'],
      ['修复重启服务自动拉起浏览器：启动命令自动补齐 --no-open（当前 DSH 支持时），启动/重启不再弹出浏览器窗口', 'Fix browser auto-open on restart: --no-open is auto-added to the startup command (when supported by the current DSH), so starting/restarting no longer pops up the browser'],
    ],
  },
  {
    version: '1.9.6',
    items: [
      ['桥接提速与默认编辑：①编辑指令改为桥接插件 pre-step 钩子隐藏注入（不占用聊天框）：收到隐式信息行后，DSH 先读取原文，按你的要求只输出一段结果，并询问是否同意写入，同意后才用编辑工具修改文件；②填入结果以 ACK 确认（消除「已填入」假象，最长等待由 4s 降至 ~3s）；③面板已开且桥接就绪时跳过重复探测直接注入；④桥接重建失败 30s 冷却、去抖 300→150ms、打开面板副作用节流；⑤修复设置页「DSH 聊天框桥接到 Obsidian」下拉不显示默认值（旧布尔设置自动迁移：开→自动发送，关→取消）', 'Bridge speed-up & default editing: ① the edit instruction is now injected by a bridge pre-step hook (never shown in the chat UI): on receiving the implicit line, DSH reads the region, outputs only the result (one paragraph), asks whether you agree, and writes the file with the edit tool only after consent; ② fills are confirmed by ACK (removes the false "filled" notice; worst-case wait 4s→~3s); ③ hot path skips redundant probe/openView when the panel is ready; ④ reload cooldown (30s), debounce 300→150ms, openView side-effect throttling; ⑤ fixed the "DSH chat → Obsidian" dropdown showing no default value (legacy boolean setting auto-migrates: true→Auto-send, false→Off)'],
    ],
  },
  {
    version: '1.9.5',
    items: [
      ['桥接位置增强：框选文字改为自动注入隐式信息行（含精确行:列与字数，不含原文），DSH 可按「路径 + 行:列」读取文件定位并修改非整行选区；「DSH 聊天框桥接到 Obsidian」改为三选项（取消/自动发送/右键发送，默认自动发送）；删除「附带来源标签」设置项；面板未打开时不注册自动发送监听；取消框选自动清除聊天框中的隐式行', 'Bridge location enhancement: selecting text now auto-injects an implicit info line (exact line:col + word count, no original text) so DSH can read the file and locate/edit non-full-line selections; "DSH chat → Obsidian" is now a 3-option dropdown (Off/Auto-send/Right-click send, default Auto-send); removed the "Attach source tag" setting; auto-send listeners are not registered while the panel is closed; deselecting auto-clears the implicit line in the chat'],
    ],
  },
  {
    version: '1.9.4',
    items: [
      ['桥接设置完善：新增「DSH 聊天框桥接到 Obsidian」开关；桥接状态显示已加载且生效（含功能列表）；面板显示移回基础设置', 'Bridge settings improved: new "DSH chat → Obsidian" switch; bridge status shows loaded & working (with feature list); panel display moved back to Basic Setup'],
    ],
  },
  {
    version: '1.9.3',
    items: [
      ['修复错误链接', 'Fix incorrect links'],
    ],
  },
  {
    version: '1.9.2',
    items: [
      ['「检查插件更新」改为打开 Obsidian 官方商店页；设置页「一键配置 DSH」按钮垂直居中', '"Check plugin updates" now opens the official Obsidian store page; the "Configure DSH" button in Settings is vertically centered'],
    ],
  },
  {
    version: '1.9.1',
    items: [
      ['修复桥接 bug：解决发送文字到 DSH 聊天框失效、框选浮框残留、启动打点路径等问题', 'Fix bridge bugs: sending text to the DSH chat no longer fails; removed the leftover selection floating button; fixed the startup-log path issue'],
    ],
  },
  {
    version: '1.9.0',
    items: [
      ['快捷键透传：光标聚焦在 DSH 面板内时，Obsidian 全局快捷键仍可响应（自动读取你的快捷键设置）', 'Pass through shortcuts: Obsidian global shortcuts still work while focus is inside the DSH panel (auto-reads your hotkey settings)'],
      ['DSH 或插件更新后自动重写桥接，保持兼容', 'Bridge is rewritten automatically after DSH or plugin updates'],
      ['底部垫高设置：Obsidian 状态栏遮挡面板底部时，可调 0–30px 留白（默认 20）', 'Bottom padding setting: adjust 0–30px space when the Obsidian status bar covers the panel bottom (default 20)'],
      ['设置页调整：DSH 状态栏整合更新日志与检查更新；新增插件版本行', 'Settings reorganized: DSH status bar now hosts changelog + check updates; new plugin version row'],
    ],
  },
  {
    version: '1.8.7',
    items: [
      ['镜像源修复：Git for Windows 镜像按完整版本排序并回退可用目录', 'Mirror fix: Git for Windows mirror sorts by full version and falls back to available directories'],
    ],
  },
  {
    version: '1.8.6',
    items: [
      ['git-for-windows 镜像排序修复（windows.N 参与版本比较）', 'git-for-windows mirror sorting fix (windows.N now participates in version comparison)'],
    ],
  },
  {
    version: '1.8.5',
    items: [
      ['设置页「重连服务」按钮文案改为「刷新」', 'Reconnect button renamed to "Refresh" in Settings'],
    ],
  },
]
