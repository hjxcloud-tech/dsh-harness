/**
 * obsidian 类型版本补丁（module augmentation）。
 *
 * 背景：package.json 声明 `obsidian: ^1.7.2`，实际解析到 1.13.1。1.13.1 的
 * obsidian.d.ts 把 createEl/createDiv/createSpan/createSvg/createFragment 声明为
 * **全局函数**（declare global）而非模块导出；而 Obsidian 运行时同时以模块导出提供
 * 它们（本插件自 v1.0 起一直 `import { createEl } from 'obsidian'` 并正常运行）。
 * 这里补一个模块级导出声明，使 `import { createEl } from 'obsidian'` 通过类型检查；
 * 纯类型声明，不影响运行行为。
 *
 * 若日后将 devDependency 固定到导出 createEl 的版本（如 1.7.x），本文件可删除。
 */
declare module 'obsidian' {
  export function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    o?: DomElementInfo | string,
    callback?: (el: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K]
}

// 使本文件成为模块：`declare module 'obsidian'` 才会被当作对现有模块的增强（augmentation），
// 而非新建一个只含 createEl 的环境模块（后者会让其余 obsidian 导出全部消失）。
export {}

