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
