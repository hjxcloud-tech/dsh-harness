/**
 * onload 冒烟加载：stub Obsidian API + DSH_HOME 隔离，模拟真实 Obsidian 加载 main.js 并执行 onload。
 * 用于在发布前捕获「onload 阶段崩溃」类回归（如 v1.0.7 addIcon 误用 this.addIcon 加载崩溃）。
 * 运行：node scripts/smoke-load.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Module from 'node:module'

// ---- 隔离 DSH_HOME（桥接文件写入临时目录，不碰真实 ~/.dsh）----
const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
process.env.DSH_HOME = home

// ---- Obsidian API stub ----
const noop = () => undefined
class FakePluginBase {
  constructor(app, manifest) {
    this.app = app
    this.manifest = manifest
    this._handlers = []
  }
  loadData() { return Promise.resolve(undefined) }
  saveData() { return Promise.resolve() }
  registerView() { return noop }
  registerDomEvent() { return noop }
  registerEvent() { return noop }
  addCommand() { return noop }
  addRibbonIcon() { return noop }
  addSettingTab() { return noop }
  addStatusBarItem() { return null }
}
class FakeModal {}
class FakeSetting {}
class FakeNotice {}
class FakePluginSettingTab {}
class FakeMarkdownView {}
class FakeEditor {}
class FakeApp {}

const obsidianStub = {
  Plugin: FakePluginBase,
  Modal: FakeModal,
  Setting: FakeSetting,
  Notice: FakeNotice,
  PluginSettingTab: FakePluginSettingTab,
  MarkdownView: FakeMarkdownView,
  Editor: FakeEditor,
  App: FakeApp,
  addIcon: noop,
  getLanguage: () => 'zh',
  getPlatform: () => ({ isDesktop: true, isMobile: false }),
  WorkspaceLeaf: class {},
  Menu: class {},
  ItemView: class {},
  Platform: { isDesktop: true, isMobile: false },
}

// 拦截 require('obsidian') / require('electron')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianStub
  if (request === 'electron') return { shell: { openExternal: async () => undefined } }
  return origLoad.call(this, request, parent, isMain)
}

// window/document 最小 stub（main.ts 只用到 window.setTimeout/clearTimeout/open、document.addEventListener 等）
globalThis.window = {
  setTimeout: () => 0, // 抑制 8s 的 --no-open 后台探测等定时器
  clearTimeout: noop,
  open: noop,
  addEventListener: noop,
  removeEventListener: noop,
}
globalThis.document = { addEventListener: noop, removeEventListener: noop, createEl: () => ({ empty: noop, addClass: noop, setText: noop, createEl: () => null, createDiv: () => null }), createDiv: () => null }
globalThis.requestAnimationFrame = noop

const app = new FakeApp()
app.workspace = {
  getLeavesOfType: () => [],
  getActiveViewOfType: () => null,
  getRightLeaf: () => null,
  revealLeaf: async () => undefined,
  on: () => noop,
}
app.vault = { adapter: { getBasePath: () => process.cwd() } }
app.commands = {}
app.hotkeyManager = {}

const manifest = {
  id: 'dsh-harness',
  name: 'DeepSeek Harness',
  version: '0.0.0-smoke',
  minAppVersion: '1.0.0',
  dir: process.cwd(),
}

const mod = await import('../main.js')
// ESM import CJS：mod.default = module.exports（{ __esModule, default: 插件类 }）；再取一层 default
const exportsObj = mod.default ?? mod
const PluginClass = exportsObj.default ?? exportsObj.main?.default
if (typeof PluginClass !== 'function') {
  console.error('SMOKE FAIL: main.js 未导出插件类（default）')
  process.exit(1)
}

const plugin = new PluginClass(app, manifest)
try {
  await plugin.onload()
} catch (err) {
  console.error('SMOKE FAIL: onload 抛错 ——', err)
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

// 关键状态断言：设置已加载、服务已构建、桥接文件已写入隔离目录
const ok =
  plugin.settings?.port === 3080 &&
  typeof plugin.service?.probe === 'function' &&
  plugin.getBridgeStatus()?.installed === true
plugin.onunload?.()
rmSync(home, { recursive: true, force: true })

if (!ok) {
  console.error('SMOKE FAIL: onload 后状态异常（settings/service/bridge）')
  process.exit(1)
}
console.log('SMOKE OK: onload + onunload 通过（DSH_HOME 隔离）')
