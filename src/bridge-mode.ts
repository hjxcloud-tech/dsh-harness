/**
 * 桥接模式类型与迁移（纯函数，无 obsidian 依赖，可在测试环境解析）。
 * 「DSH 聊天框桥接到 Obsidian」三选项：off 取消 / auto 自动发送 / rightClick 右键发送。
 */

export type BridgeToObsidianMode = 'off' | 'auto' | 'rightClick'

/**
 * 旧版（≤1.9.4）data.json 里 bridgeToObsidian 是布尔值；升级后布尔会覆盖新默认
 * 'auto'，导致设置页下拉 setValue(boolean) 匹配不到任何选项而不显示默认值。
 * true → 'auto'（旧开关开，默认自动发送）；false → 'off'。
 * 已是合法三选项或未知值时返回 null（由调用方保持原值，不写盘）。
 */
export function migrateBridgeMode(v: unknown): BridgeToObsidianMode | null {
  if (v === true) return 'auto'
  if (v === false) return 'off'
  return null
}

/**
 * 填充写入方式（v2.8.0 / setDraft 设计 P1+P2）。
 *
 * - `auto`（默认）＝**优先官方模型层写入**：桥接以「裸包名条目 + node_modules 链接」（package 模式）
 *   安装，从而带得动客户端半 `client.js`；客户端半从官方输入插槽拿到 `inputActions.setDraft(text)`，
 *   由页面脚本在「框内没有用户文字」时调用它写入隐式行。`setDraft` 走 Lexical 模型层更新，
 *   **不需要输入框获得焦点**，因此框选后隐式行立即出现、且不会把用户正在敲的键吸进聊天框。
 *   官方接口不可达（链接建不出来、DSH 版本不含该插槽、客户端半未激活）时，宿主与页面脚本
 *   都**静默退回**原有的 DOM 定向替换路径，行为与 `dom` 模式逐字一致。
 * - `dom`＝强制只用 DOM 路径（v2.5.3 的定向替换：写入必须临时持有输入框焦点）。
 *   给用户一个「关掉实验特性」的开关，也用于排查 package 模式与 DSH 版本的兼容问题。
 */
export type BridgeInputMode = 'auto' | 'dom'

/** 把任意输入归一为合法 BridgeInputMode（未知/缺省 → auto）。 */
export function normalizeBridgeInputMode(v: unknown): BridgeInputMode {
  return v === 'dom' ? 'dom' : 'auto'
}

/**
 * 由输入方式推出桥接**补丁条目形态**（v2.7.0 / A3 起 `writeBridgeFiles` 支持两种）。
 * 只有 package 模式才能让装载器把 `client.js` 编进 /plugins combo（装载器显式排除路径形态条目），
 * 而客户端半正是 `setDraft` 的唯一来源——两件事是同一个开关的两面，故在此统一推导，
 * 避免调用方各自拼装。
 */
export function installModeFor(input: BridgeInputMode): 'package' | 'path' {
  return input === 'auto' ? 'package' : 'path'
}
