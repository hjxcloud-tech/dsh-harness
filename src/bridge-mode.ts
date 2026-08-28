/**
 * 桥接模式类型与迁移（纯函数，无 obsidian 依赖，可在测试环境解析）。
 * 「DSH 聊天框桥接到 Obsidian」三选项：off 取消 / auto 自动发送 / rightClick 右键发送。
 */

export type BridgeToObsidianMode = 'off' | 'auto' | 'rightClick'

/**
 * 旧版（≤1.9.4）data.json 里 bridgeToObsidian 是布尔值；升级后布尔会覆盖新默认
 * 'auto'，导致设置页下拉 setValue(boolean) 匹配不到任何选项而不显示默认值。
 * true → 'auto'（旧开关开，默认自动发送）；false → 'off'。
 * 合法三选项或缺失（undefined，由 DEFAULT_SETTINGS 兜底）→ null（保持原值不写盘）；
 * 其他脏值（如 1 / 'TRUE'）→ 'off'（安全默认，避免下拉空白且所有 === 比较失效）。
 */
export function migrateBridgeMode(v: unknown): BridgeToObsidianMode | null {
  if (v === true) return 'auto'
  if (v === false) return 'off'
  if (v === 'off' || v === 'auto' || v === 'rightClick') return null
  if (v === undefined || v === null) return null
  return 'off'
}
