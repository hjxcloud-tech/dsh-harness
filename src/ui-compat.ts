/**
 * Obsidian 1.13 UI API 的双路适配（v2.8.9）。
 *
 * 为什么要这一层：`ButtonComponent#setDestructive` 与 `SettingTab#update` 都是 **1.13.0 起才有**，
 * 而本插件 `minAppVersion` 是 1.7.2——直接写新 API 会被官方规则 `obsidianmd/no-unsupported-api`
 * 判为「requires Obsidian v1.13.0, but minAppVersion is 1.7.2」（真机上老版本 Obsidian 还会 TypeError）；
 * 只写旧 API 又被审查侧 `@typescript-eslint/no-deprecated` 逐条报废弃（2.8.8 审查清单里的 6 条）。
 * 折中＝**运行时特性检测**：新 API 在就用新的，旧版退回旧写法，两侧视觉与行为都对齐本版原有表现。
 *
 * 逐条取证（读本机 `D:\Software\OB\Obsidian\resources\obsidian.asar` = Obsidian 1.13.1 运行时）：
 * - `setWarning=function(){return this.setDestructive().setCta()}` → 1.13 的旧调用等价于
 *   「破坏性 + 主行动」，所以这里必须 `setDestructive()` 后再 `setCta()`，只调前者会丢掉 CTA 强调；
 *   1.7.2–1.12.x 的 `setWarning` 只加 `is-warning` 类，故那条路径不补 CTA（补了反而改变老版本观感）。
 * - `SettingTab#update=function(){settingItems=getSettingDefinitions();…;refreshCurrentPage(this)}`，
 *   而 `renderTab=function(){this.settingItems.length>0?声明式渲染:this.display()}`，
 *   `PluginSettingTab` 基类的 `getSettingDefinitions()` 返回**空数组** → 本插件仍是命令式设置页，
 *   调 `update()` 在 1.13 上最终落回 `display()`，与旧版整页重画逐字等价（日后转声明式也无需改调用方）。
 * - `setDynamicTooltip=function(){return this}` → 1.13 起是空实现（值恒显在滑杆旁），
 *   旧版靠它出拖动气泡，所以保留调用、只把废弃点集中到这里。
 * 结论：本文件是全仓唯一出现 `setWarning()` / `.display()` / `setDynamicTooltip()` 的地方，
 * 其余调用方一律走本模块的三个函数。
 *
 * 写法说明：新 API 一律先 `as unknown as` 成本模块自己声明的**可选成员**结构再调用——
 * 一是让 `no-unsupported-api` 与 `no-deprecated` 都落在「我们自己声明的类型」上（这两个规则按符号声明处判，
 * 交叉类型 `T & {...}` 会把符号解析回 obsidian.d.ts，实测报错），二是显式表达「不假设成员存在」。
 */
import type { ButtonComponent, SettingTab, SliderComponent } from 'obsidian'

/** 1.13 才有的两个按钮成员（特性检测视图，全部可选）。 */
type DestructiveCapable = { setDestructive?: () => unknown; setCta?: () => unknown }
/** 1.13 才有的声明式刷新入口 `SettingTab#update()`（同上）。 */
type DeclarativeRefreshCapable = { update?: () => unknown }
/** 1.13 起空实现的滑杆气泡开关（同上）。 */
type SliderBubbleCapable = { setDynamicTooltip?: () => unknown }

/**
 * 把按钮标成破坏性（红色）：1.13+ 走 `setDestructive()` + `setCta()`（＝本版 `setWarning()` 的等价实现），
 * 1.7.2–1.12.x 走 `setWarning()`。返回按钮本身以便继续链式调用（两侧成员都返回 this）。
 */
export function markDestructive<T extends ButtonComponent>(btn: T): T {
  const capable = btn as unknown as DestructiveCapable
  if (typeof capable.setDestructive === 'function') {
    capable.setDestructive()
    if (typeof capable.setCta === 'function') capable.setCta()
    return btn
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 上面已优先走 1.13 的 setDestructive；这里是 minAppVersion 覆盖的旧版唯一可用写法
  return btn.setWarning()
}

/**
 * 重画设置页：1.13+ 用 `update()`（声明式刷新入口；本插件未声明设置项，它会落回 display()，
 * 见文件头取证），旧版退回 `display()`。tab 还没建（null/undefined）时什么都不做。
 */
export function refreshSettingTab<T extends SettingTab>(tab: T | null | undefined): void {
  if (tab === null || tab === undefined) return
  const capable = tab as unknown as DeclarativeRefreshCapable
  if (typeof capable.update === 'function') {
    capable.update()
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 同上：旧版没有 update()，整页重画只能调 display()
  tab.display()
}

/**
 * 滑杆拖动时显示当前值气泡：1.13 起该成员是空实现（值恒显在滑杆旁，调用无副作用），
 * 1.7.2–1.12.x 仍靠它出气泡，故保留调用，废弃点集中在本行。返回滑杆本身以便继续链式调用。
 */
export function showSliderValueBubble<T extends SliderComponent>(slider: T): T {
  const capable = slider as unknown as SliderBubbleCapable
  capable.setDynamicTooltip?.()
  return slider
}
