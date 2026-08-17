/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/os/process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from './i18n'

/**
 * DSH 前端桥接（zero 源码改动）：利用 DSH 官方的用户扩展缝——
 * ① profile 补丁层（~/.dsh/profiles/web/cordis.patch.yml）插入一个本地后端 cordis 插件；
 * ② 该插件注册 webServer.tapIndex，向服务的 index.html 注入一段桥接脚本；
 * ③ 注入脚本监听 postMessage，把选中文字填入当前会话输入框（React 受控 textarea，原生 setter + input 事件）。
 * 不修改 DSH 源码、不重建 web；DSH 服务重启后生效。
 */

/** 桥接插件的 cordis entry id（补丁文件里用它判重）。 */
export const BRIDGE_ENTRY_ID = 'dsh-obsidian-bridge'

/** 桥接插件文件名（写入 web profile 目录）。 */
export const BRIDGE_FILENAME = 'dsh-obsidian-bridge.mjs'

/** DSH 主目录：$DSH_HOME 优先，缺省 ~/.dsh（与 @deepseek-ai/dsh-home-paths 一致）。 */
export function dshHomeDir(): string {
  const env = (process.env.DSH_HOME ?? '').trim()
  return env !== '' ? env : join(homedir(), '.dsh')
}

/** web profile 目录（补丁文件与桥接插件所在）。 */
export function webProfileDir(home: string = dshHomeDir()): string {
  return join(home, 'profiles', 'web')
}

/** 注入到 DSH 页面里的桥接脚本（单行、无 </script>、无模板占位）。 */
export function bridgeScriptSource(): string {
  return "(function(){if(window.__DSH_OBSIDIAN_BRIDGE__)return;window.__DSH_OBSIDIAN_BRIDGE__=true;" +
    "function pick(){var el=document.querySelector('textarea[data-phase]')||document.querySelector('textarea');" +
    "return el&&!el.readOnly&&!el.disabled?el:null}" +
    "function fill(text){var n=0;function go(){var el=pick();" +
    "if(el){var d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');" +
    "d.set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));el.focus();return}" +
    "if(++n<20)setTimeout(go,200)}go()}" +
    "window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d)return;" +
    "if(d.type==='dsh-fill-draft'&&typeof d.text==='string'){fill(d.text);return}" +
    "if(d.type==='dsh-bridge-ping'){try{window.parent.postMessage({type:'dsh-bridge-ready'},'*')}catch(_){}}});" +
    "try{window.parent.postMessage({type:'dsh-bridge-ready'},'*')}catch(_){}" +
    "})()"
}

/** 桥接插件本体（cordis 插件：注册 index.html 注入）。 */
export function bridgePluginSource(): string {
  // 脚本内嵌进单引号字符串，必须转义反斜杠与单引号
  const escaped = bridgeScriptSource().replaceAll('\\', '\\\\').replaceAll("'", "\\'")
  return [
    "// DeepSeek Harness Obsidian bridge — user patch-layer plugin (installed by the dsh-harness Obsidian plugin).",
    "// Registers an index.html transform that injects a postMessage bridge into the served Web GUI,",
    "// so the Obsidian plugin can fill the composer draft with selected text. Zero DSH source changes.",
    "export const name = 'dsh-obsidian-bridge'",
    '',
    `const BRIDGE = '${escaped}'`,
    '',
    'export function apply(ctx) {',
    "  ctx.inject(['webServer'], (httpCtx) => {",
    '    httpCtx.effect(',
    "      () => httpCtx.webServer.tapIndex((html) => html.replace('<head>', '<head><script>' + BRIDGE + '</script>')),",
    "      'dsh-obsidian-bridge: index bridge',",
    '    )',
    '  })',
    '}',
    '',
  ].join('\n')
}

/** 安装结果。 */
export interface BridgeInstallResult {
  /** 是否发生了文件变更（新增插件/补丁条目）。 */
  changed: boolean
  /** 桥接插件文件绝对路径（安装失败时为空串）。 */
  pluginPath: string
  /** 安装失败原因（成功时缺省）。 */
  error?: string
}

/**
 * 写入桥接插件文件并合并补丁条目（幂等）。
 * 补丁文件为「顶层块式序列」的 patch 条目（`[]` 只是空数组的模板写法）：
 *   - insert:
 *       - id: dsh-obsidian-bridge
 *         name: file:///...
 * 返回 changed=true 表示需要重启 DSH 服务才能加载桥接。
 */
export function writeBridgeFiles(home: string = dshHomeDir()): BridgeInstallResult {
  try {
    const dir = webProfileDir(home)
    mkdirSync(dir, { recursive: true })
    const pluginPath = join(dir, BRIDGE_FILENAME)
    writeFileSync(pluginPath, bridgePluginSource(), 'utf8')

    const patchPath = join(dir, 'cordis.patch.yml')
    const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    if (existing.includes(BRIDGE_ENTRY_ID)) {
      return { changed: false, pluginPath }
    }
    const fileUrl = 'file:///' + pluginPath.replaceAll('\\', '/')
    const entry = `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: ${fileUrl}\n`

    // 去掉注释后的有效内容
    const body = existing
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
      .trim()

    if (existing === '') {
      // 补丁文件不存在：新建（含说明注释）
      const newContent = `# ${BRIDGE_ENTRY_ID} — installed by the dsh-harness Obsidian plugin\n${entry}`
      writeFileSync(patchPath, newContent, 'utf8')
      return { changed: true, pluginPath }
    }
    if (body === '[]') {
      // 模板默认的空数组：去掉空括号，替换为块式条目
      const header = existing.trimEnd().replace(/\s*\[\s*\]\s*$/, '')
      const newContent = (header === '' || header.endsWith('\n') ? header : header + '\n') + entry
      writeFileSync(patchPath, newContent, 'utf8')
      return { changed: true, pluginPath }
    }
    if (/^-\s/.test(body)) {
      // 已有块式条目：末尾追加
      writeFileSync(patchPath, existing.trimEnd() + '\n' + entry, 'utf8')
      return { changed: true, pluginPath }
    }
    return {
      changed: false,
      pluginPath,
      error: t('bridge.patchMergeError'),
    }
  } catch (err) {
    return {
      changed: false,
      pluginPath: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 桥接文件是否已安装（插件文件 + 补丁条目都在）。 */
export function isBridgeInstalled(home: string = dshHomeDir()): boolean {
  try {
    const dir = webProfileDir(home)
    if (!existsSync(join(dir, BRIDGE_FILENAME))) return false
    const patchPath = join(dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) return false
    return readFileSync(patchPath, 'utf8').includes(BRIDGE_ENTRY_ID)
  } catch {
    return false
  }
}
