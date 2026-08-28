/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/os/process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { createHash } from 'node:crypto'
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

/** 快捷键匹配（与桥接脚本内嵌 kbdMatch 同逻辑；parity 测试兜底）。key 形如 'ctrl+o' / 'ctrl+p' / 'ctrl+,'。 */
export function kbdMatch(e: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; key?: string }, key: string): boolean {
  if (!key || !e) return false
  const wantC = key.includes('ctrl')
  const wantM = key.includes('meta')
  const wantA = key.includes('alt')
  if (wantC !== !!e.ctrlKey || wantM !== !!e.metaKey || wantA !== !!e.altKey) return false
  const actual = (e.key ?? '').toLowerCase()
  if (key.includes('+')) {
    const ch = key.slice(key.lastIndexOf('+') + 1).toLowerCase()
    return actual === ch
  }
  return actual === key.toLowerCase()
}

/**
 * 把 Obsidian hotkey（modifiers + key）归一为透传用的组合键字符串。
 * 'Mod' → darwin 平台 'meta'，其余平台 'ctrl'（Obsidian 的 Mod 语义）；
 * 仅返回带修饰符的键（无修饰单键返回 null，避免干扰 DSH 输入）。
 */
export function hotkeyToPassthroughKey(
  hk: { modifiers?: string[]; key?: string },
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!hk || typeof hk.key !== 'string' || hk.key === '') return null
  const mods = (hk.modifiers ?? []).map((m) => m.toLowerCase())
  const normalized = mods.map((m) => (m === 'mod' ? (platform === 'darwin' ? 'meta' : 'ctrl') : m))
  const prefix = normalized.filter((m) => m === 'ctrl' || m === 'meta' || m === 'alt' || m === 'shift').join('+')
  if (prefix === '') return null
  return `${prefix}+${hk.key.toLowerCase()}`
}

/** DSH 主目录：$DSH_HOME 优先，缺省 ~/.dsh（与 @deepseek-ai/dsh-home-paths 一致）。 */
export function dshHomeDir(): string {
  const env = (process.env.DSH_HOME ?? '').trim()
  return env !== '' ? env : join(homedir(), '.dsh')
}

/** web profile 目录（补丁文件与桥接插件所在）。 */
export function webProfileDir(home: string = dshHomeDir()): string {
  return join(home, 'profiles', 'web')
}

/**
 * 解析「点击路径」是否在 Vault 内：
 * - 相对路径按 Vault 根解析；规范化（\ → /、去 ./..）后判定前缀（Windows 大小写不敏感）
 * - 在 Vault 内 → 返回规范化的绝对路径（供 obsidian://open 使用）
 * - 不在 Vault 内 → 返回 null（调用方据此取消打开）
 * 与注入脚本内嵌的 resolveTxt 保持同逻辑（有 parity 测试兜底）。
 */
export function resolveVaultPath(text: string, vaultRoot: string): string | null {
  const t = text.trim()
  if (!t || t.length > 300) return null
  const rootN = normalizePath(vaultRoot).replace(/\/+$/, '')
  if (!rootN) return null
  const abs = /^[A-Za-z]:/.test(t) || t.startsWith('/') ? normalizePath(t) : `${rootN}/${normalizePath(t)}`
  const a = collapseDots(abs)
  const rl = rootN.toLowerCase()
  const al = a.toLowerCase()
  if (al === rl || al.startsWith(rl + '/')) return a
  return null
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function collapseDots(p: string): string {
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? ''
  const body = p.slice(drive.length)
  const rooted = body.startsWith('/')
  const segs: string[] = []
  for (const s of body.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (segs.length > 0) segs.pop()
      continue
    }
    segs.push(s)
  }
  return drive + (rooted ? '/' : '') + segs.join('/')
}

/** Obsidian 原生可打开/可读的扩展名（文本/代码/媒体/PDF）；docx/xlsx/zip/exe 等二进制不在此列。 */
const OBSIDIAN_READABLE_RE =
  /\.(md|markdown|txt|canvas|pdf|png|jpe?g|gif|svg|webp|bmp|ico|mp3|wav|ogg|oga|m4a|flac|opus|aac|mp4|webm|mov|mkv|avi|m4v|ogv|3gp|ts|js|jsx|tsx|mjs|cjs|json|css|scss|less|html|htm|xml|yaml|yml|csv|log|mdx|py|sh|bat|ps1)$/i

/** 该路径是否 Obsidian 可读（与注入脚本内嵌 readable 同逻辑）。 */
export function isObsidianReadablePath(path: string): boolean {
  return OBSIDIAN_READABLE_RE.test(path)
}

/** 注入到 DSH 页面里的桥接脚本（单行、无 </script>、无模板占位）。 */
export function bridgeScriptSource(): string {
  return "(function(){if(window.__DSH_OBSIDIAN_BRIDGE__)return;window.__DSH_OBSIDIAN_BRIDGE__=true;" +
    // 隐式行正则（与 TS 版 BRIDGE_LINE_RE 同逻辑；页面脚本上下文，独立定义）
    "var BRIDGE_LINE_RE=/\\[\\s*BRIDGES is delivering packages for you……\\s*·\\s*(\\d+)\\s*words\\s*·\\s*L(\\d+):(\\d+)-L(\\d+):(\\d+)\\s*·\\s*([^\\]]+?)\\s*·\\s*\\]/;" +
    // 合并填充：新隐式行置顶，保留用户已输入内容（剔除旧隐式行防堆叠；空文本仅清隐式行）
    "function mergeFill(existing,incoming){if(!existing)existing='';" +
    "var lines=existing.split('\\n'),i,prev=false,rest='';" +
    "for(i=0;i<lines.length;i++){var l=lines[i];if(BRIDGE_LINE_RE.test(l))continue;" +
    "var e=l.trim()==='';if(e&&prev)continue;rest=rest===''?l:rest+'\\n'+l;prev=e}" +
    "rest=rest.replace(/^\\s+|\\s+$/g,'');" +
    "if(incoming==='')return rest;return rest===''?incoming:incoming+'\\n'+rest}" +
    "function pick(){var el=document.querySelector('textarea[data-phase]')||document.querySelector('textarea');" +
    "return el&&!el.readOnly&&!el.disabled?el:null}" +
    "function fill(text){var n=0;function go(){var el=pick();" +
    "if(el){var d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');" +
    // 不 focus：注入后焦点留在 Obsidian 编辑器，避免框选后的键盘操作（backspace 等）被导向 DSH 聊天框
    // 合并而非覆盖：保留用户已在聊天框输入的内容（隐式行置顶，换行后接用户输入）
    "var merged=mergeFill(el.value||'',text);" +
    "d.set.call(el,merged);el.dispatchEvent(new Event('input',{bubbles:true}));" +
    "try{window.parent.postMessage({type:'dsh-fill-ack'},'*')}catch(_){}return}" +
    // 自适应重试：textarea 尚未挂载（React 首屏加载中）时先密后疏，最长 ~3s
    "if(n<10){n++;setTimeout(go,100)}else if(n<15){n++;setTimeout(go,400)}}go()}" +
    "var vaultRoot=null;" +
    "function normP(p){return p.replace(/\\\\/g,'/').replace(/\\/+/g,'/')}" +
    "function coll(p){var m=/^[A-Za-z]:/.exec(p),drive=m?m[0]:'',body=p.slice(drive.length),rooted=body.charAt(0)==='/',segs=[],i,parts=body.split('/');" +
    "for(i=0;i<parts.length;i++){var s=parts[i];if(s===''||s==='.')continue;if(s==='..'){if(segs.length)segs.pop()}else{segs.push(s)}}" +
    "return drive+(rooted?'/':'')+segs.join('/')}" +
    "function resolveTxt(text){var t=text.trim();if(!t||t.length>300||!vaultRoot)return null;" +
    "var r=normP(vaultRoot).replace(/\\/+$/,'');var abs=/^[A-Za-z]:/.test(t)||t.charAt(0)==='/'?normP(t):r+'/'+normP(t);var a=coll(abs);" +
    "var rl=r.toLowerCase(),al=a.toLowerCase();if(al===rl||al.indexOf(rl+'/')===0)return a;return null}" +
    "function isClickable(el){return el.tagName==='BUTTON'||el.tagName==='A'}" +
    "function labelPrefixed(t){return /^(read|edit|write|think|grep|pwsh|tool|search|diff|web|bash|python|node|run|open|show|copy|cat|mkdir|rm|mv|add|delete)\\b/i.test(t)}" +
    "function readable(p){return /\\.(md|markdown|txt|canvas|pdf|png|jpe?g|gif|svg|webp|bmp|ico|mp3|wav|ogg|oga|m4a|flac|opus|aac|mp4|webm|mov|mkv|avi|m4v|ogv|3gp|ts|js|jsx|tsx|mjs|cjs|json|css|scss|less|html|htm|xml|yaml|yml|csv|log|mdx|py|sh|bat|ps1)$/i.test(p)}" +
    "function pathOf(el){var t=el.getAttribute?el.getAttribute('title'):null;if(t&&/[\\\\/]/.test(t))return t;return (el.textContent||'').trim()}" +
    "document.addEventListener('click',function(e){if(!vaultRoot)return;var el=e.target;" +
    "while(el&&el!==document.body){var txt=pathOf(el);" +
    "if(txt.length>2&&txt.length<300&&/[\\\\/]/.test(txt)&&isClickable(el)&&!labelPrefixed(txt)){" +
    "e.preventDefault();e.stopPropagation();var r=resolveTxt(txt);" +
    "if(r&&readable(r)){try{window.parent.postMessage({type:'dsh-open-in-obsidian',path:r},'*')}catch(_){}}" +
    "return}el=el.parentElement}},true);" +
    "window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d)return;" +
    "if(d.type==='dsh-fill-draft'&&typeof d.text==='string'){fill(d.text);return}" +
    "if(d.type==='dsh-bridge-ping'){try{window.parent.postMessage({type:'dsh-bridge-ready'},'*')}catch(_){};return}" +
    "if(d.type==='dsh-open-cfg'&&typeof d.vaultRoot==='string'){vaultRoot=d.vaultRoot;return}" +
    "if(d.type==='dsh-kbd-cfg'&&d.keys&&d.keys.length!==undefined){kbdKeys=d.keys;" +
    "logKbd('kbd-cfg received: '+kbdList());return}});" +
    // 快捷键透传：捕获配置的 Obsidian 全局快捷键（Ctrl+O/P/, 等），阻止 iframe 吞键并转发给插件
    "var kbdKeys=[];" +
    "function kbdMatch(e,k){if(!k||!e)return false;var wantC=k.indexOf('ctrl')>=0,wantM=k.indexOf('meta')>=0,wantA=k.indexOf('alt')>=0;" +
    "if(wantC!==e.ctrlKey||wantM!==e.metaKey||wantA!==e.altKey)return false;" +
    "var key=(e.key||'').toLowerCase();if(k.indexOf('+')>=0){var ch=k.slice(k.lastIndexOf('+')+1).toLowerCase();return key===ch}return key===k.toLowerCase()}" +
    "function requestKbd(){try{window.parent.postMessage({type:'dsh-kbd-request'},'*')}catch(_){}}" +
    "function logKbd(m){try{console.log('[dsh-bridge]',m)}catch(_){}}" +
    "function kbdList(){var s='';for(var i=0;i<kbdKeys.length;i++){s+=kbdKeys[i]+' '}return s}" +
    "logKbd('keydown listener installed, kbdKeys='+kbdKeys.length+': '+kbdList());" +
    "document.addEventListener('keydown',function(e){logKbd('keydown ctrl='+e.ctrlKey+' meta='+e.metaKey+' key='+e.key+' kbdKeys='+kbdKeys.length);" +
    "if(!kbdKeys.length){requestKbd();return}" +
    "for(var i=0;i<kbdKeys.length;i++){if(kbdMatch(e,kbdKeys[i])){e.preventDefault();e.stopPropagation();" +
    "logKbd('MATCH '+kbdKeys[i]+' -> post');" +
    "try{window.parent.postMessage({type:'dsh-kbd-shortcut',key:kbdKeys[i]},'*')}catch(_){}return}}},true);" +
    "try{window.parent.postMessage({type:'dsh-bridge-ready'},'*')}catch(_){}" +
    "})()"
}

/** 桥接插件本体（cordis 插件：注册 index.html 注入 + agent/pre-step 编辑指令注入）。 */
export function bridgePluginSource(): string {
  // 脚本内嵌进单引号字符串，必须转义反斜杠与单引号
  const escaped = bridgeScriptSource().replaceAll('\\', '\\\\').replaceAll("'", "\\'")
  return [
    "// DeepSeek Harness Obsidian bridge — user patch-layer plugin (installed by the dsh-harness Obsidian plugin).",
    "// Registers an index.html transform that injects a postMessage bridge into the served Web GUI,",
    "// so the Obsidian plugin can fill the composer draft with selected text. Zero DSH source changes.",
    "// Also registers an agent/pre-step hook: when the newest user message carries a BRIDGES implicit",
    "// line, it injects a deterministic edit instruction (model reads the region, presents the result,",
    "// asks for consent, then writes with fs edit). The instruction itself never appears in the chat UI.",
    "export const name = 'dsh-obsidian-bridge'",
    '',
    `const BRIDGE = '${escaped}'`,
    '',
    bridgeEditInjectSource(),
    '',
    'export function apply(ctx) {',
    "  ctx.inject(['webServer'], (httpCtx) => {",
    '    httpCtx.effect(',
    "      () => httpCtx.webServer.tapIndex((html) => html.replace('<head>', '<head><script>' + BRIDGE + '</script>')),",
    "      'dsh-obsidian-bridge: index bridge',",
    '    )',
    '  })',
    '  try {',
    "    ctx.on('agent/pre-step', async ({ messages }, next) => {",
    '      const decision = await next()',
    "      if (decision.kind === 'reject') return decision",
    '      const msg = bridgeEditMaybeInject({ messages })',
    '      if (!msg) return decision',
    "      return { kind: 'enter', messages: [...decision.messages, msg] }",
    '    })',
    '  } catch (err) {',
    "    try { console.warn('[dsh-obsidian-bridge] pre-step unavailable:', err && err.message) } catch (_) {}",
    '  }',
    '}',
    '',
  ].join('\n')
}

/** 解析 BRIDGES 隐式行（与内联 bridgeEditMaybeInject 同逻辑；parity 由测试兜底）。 */
export interface ParsedBridgeLine {
  path: string
  fromLine: number
  fromCh: number
  toLine: number
  toCh: number
  /** 隐式行之外的用户指令（无则空串）。 */
  instruction: string
}

/** 匹配隐式行：[ BRIDGES is delivering packages for you…… · N words · Lx:y-Lx:y · <path> · ] */
export const BRIDGE_LINE_RE =
  /\[\s*BRIDGES is delivering packages for you……\s*·\s*(\d+)\s*words\s*·\s*L(\d+):(\d+)-L(\d+):(\d+)\s*·\s*([^\]]+?)\s*·\s*\]/

export function parseBridgeLine(text: string): ParsedBridgeLine | null {
  const m = BRIDGE_LINE_RE.exec(text)
  if (!m) return null
  return {
    path: m[6].trim(),
    fromLine: Number(m[2]),
    fromCh: Number(m[3]),
    toLine: Number(m[4]),
    toCh: Number(m[5]),
    instruction: text.replace(BRIDGE_LINE_RE, '').trim(),
  }
}

/**
 * 合并填充：新隐式行置顶，保留用户已在聊天框输入的内容（与注入脚本内联 mergeFill 同逻辑；parity 由测试兜底）。
 * - 剔除 existing 中匹配 BRIDGE_LINE_RE 的行（旧隐式行，防堆叠），压缩删除产生的连续空行；
 * - incoming === ''（清除）：仅移除隐式行，返回剩余用户输入（无隐式行时返回原内容，不误删用户文字）；
 * - incoming 非空：`隐式行 + 换行 + 用户输入`。
 */
export function mergeFillText(existing: string, incoming: string): string {
  const lines = existing.split('\n')
  const kept: string[] = []
  let prevEmpty = false
  for (const line of lines) {
    if (BRIDGE_LINE_RE.test(line)) continue
    const empty = line.trim() === ''
    if (empty && prevEmpty) continue
    kept.push(line)
    prevEmpty = empty
  }
  const rest = kept.join('\n').trim()
  if (incoming === '') return rest
  return rest === '' ? incoming : `${incoming}\n${rest}`
}

/**
 * 内联进桥接插件 .mjs 的 pre-step 编辑指令逻辑（手写单行风格，注意转义）：
 * 命中 BRIDGES 隐式行 → 追加一条 source.kind='plugin' 的指令消息：
 * 模型先 read 该区域原文 → 按用户要求直接生成结果（只输出结果一段，
 * 不带定位/补充说明）→ 询问用户是否同意写入 → 同意后用 fs edit 写入。
 */
export function bridgeEditInjectSource(): string {
  return [
    "const BRIDGE_LINE_RE = /\\[\\s*BRIDGES is delivering packages for you……\\s*·\\s*(\\d+)\\s*words\\s*·\\s*L(\\d+):(\\d+)-L(\\d+):(\\d+)\\s*·\\s*([^\\]]+?)\\s*·\\s*\\]/",
    "function bridgeEditMaybeInject({ messages }) {",
    '  if (!messages || !messages.length) return null',
    '  const last = messages[messages.length - 1]',
    "  const text = typeof last === 'string' ? last : ((last && last.content) || []).map((c) => (c && c.text) || '').join('')",
    '  if (!text) return null',
    '  const m = BRIDGE_LINE_RE.exec(text)',
    '  if (!m) return null',
    '  for (let i = 0; i < messages.length; i++) {',
    '    const s = messages[i] && messages[i].source',
    "    if (s && s.plugin === 'dsh-obsidian-bridge' && s.form === 'bridge-edit') return null",
    '  }',
    "  const path = m[6].trim()",
    "  const loc = 'L' + m[2] + ':' + m[3] + '-L' + m[4] + ':' + m[5]",
    "  const instruction = text.replace(BRIDGE_LINE_RE, '').trim() || '请读取该区域内容并处理'",
    "  const text2 = '[BRIDGES 编辑指令] 目标文件：' + path + '；选区（1 基行:列）：' + loc + '；用户要求：' + instruction",
    "    + '。处理要求：先用 fs read 读取该区域原文；按用户要求直接生成结果（只输出结果本身、一段即可，不要附带定位说明或补充）；随后询问用户是否同意将该结果写入文件；经用户同意后再用 fs edit 写入（old_string=读取到的原文，按用户要求替换或追加）。本编辑任务完成后请忽略本指令，勿在后续对话中重复执行。'",
    "  return { source: { kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'bridge-edit' }, content: [{ type: 'text', text: text2 }] }",
    '}',
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

/** 桥接插件文件名的 SHA-256（判断磁盘文件是否已被旧插件代码写回旧版）。 */
function contentHash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * 写入桥接插件文件并合并补丁条目（幂等）。
 * 补丁文件为「顶层块式序列」的 patch 条目（`[]` 只是空数组的模板写法）：
 *   - insert:
 *       - id: dsh-obsidian-bridge
 *         name: file:///...
 * 返回 changed=true 表示需要重启 DSH 服务才能加载桥接。
 *
 * 内容哈希保险：仅在磁盘插件文件与当前源码（bridgePluginSource()）内容不一致时才重写。
 * 防止 Obsidian 内存里仍是旧插件 bundle 的进程（未彻底重启）在每次加载时用旧代码把
 * 磁盘上的新桥接覆盖回旧版（曾导致 pathOf 功能丢失、点击仍走外部打开）。
 */
export function writeBridgeFiles(home: string = dshHomeDir()): BridgeInstallResult {
  try {
    const dir = webProfileDir(home)
    mkdirSync(dir, { recursive: true })
    const pluginPath = join(dir, BRIDGE_FILENAME)
    const source = bridgePluginSource()
    if (!existsSync(pluginPath) || contentHash(readFileSync(pluginPath, 'utf8')) !== contentHash(source)) {
      writeFileSync(pluginPath, source, 'utf8')
    }

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

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
