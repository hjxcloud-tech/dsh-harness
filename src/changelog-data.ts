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
