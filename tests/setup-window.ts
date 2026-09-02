/**
 * Node 测试环境没有 window；src 为符合 Obsidian 商店审核统一使用 window.* 定时器，
 * 这里仅打桩四个定时器成员（无需整套 jsdom）。
 */
// @ts-nocheck
if (typeof window === 'undefined') {
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval }
}
