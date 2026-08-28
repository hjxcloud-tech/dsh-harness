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
    version: '2.0.0',
    items: [
      ['对项目进行全量审计及修复：①端口操作安全（不再误杀同名端口前缀的其他进程，重启/更新/AED 前校验 DSH 身份）；②修复路径点击重定向标签跳过失效（退格字节 bug）；③pre-step 编辑指令带自终止句（避免会话累积重复执行）；④后台 --no-open 探测改异步（不再冻结界面 8-20s）；⑤更新失败自动恢复原服务、更新检查单飞防连点互锁、仓库更新后自动补依赖安装；⑥一键安装修复（安装后 PATH 缓存刷新、复用仓库补构建产物、镜像下载带超时）、curl 适配 macOS/Linux；⑦设置页输入防抖（端口/命令/滑杆不再逐键重建服务）+ 按钮异常自动恢复；⑧面板关闭竞态修复、桥接写入原子化与按行判重、隐式行正则单一来源；⑨版本判定修正（alpha/beta 识别为预发布）、「已是最新」提示说明仅按 npm 推送检测并披露 GitHub 未发布预览；⑩下拉与重启栏位居中/调序', 'Full project audit & fixes: ① port-kill safety (no longer kills unrelated processes on prefix-matching ports; DSH identity is verified before restart/update/AED); ② fixed the label-skip regex backspace-byte bug in path-click redirects; ③ pre-step edit instructions now self-terminate (no repeated execution across turns); ④ background --no-open probe is async (no more 8-20s UI freeze); ⑤ failed updates restore the previous service, update checks are single-flight, and repo pulls auto-install dependencies; ⑥ installer fixes (PATH cache refresh after install, build-artifact check on reuse, download timeouts) + curl works on macOS/Linux; ⑦ Settings inputs are debounced (no per-keystroke service rebuilds) and buttons recover on errors; ⑧ panel-close race fixed, bridge writes are atomic with line-based dedupe, single source for the implicit-line regex; ⑨ version semantics fixed (alpha/beta treated as prereleases), "up to date" notice states npm-only scope and discloses GitHub prereleases not yet published; ⑩ centered dropdown & reordered restart row'],
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
