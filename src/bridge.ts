/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/os/process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * 旧布局桥接文件名（直接躺在 profile 根目录；v2.4.0 起仅作迁移识别用）。
 * 为什么废弃：它被 dsh 的插件清单扩展当成「松散模块」，nearestManifest() 会向上命中
 * profile 自己的 package.json，从而把 profile 当成桥接的宿主包（见桥接包化注释）。
 */
export const BRIDGE_FILENAME = 'dsh-obsidian-bridge.mjs'

/** 桥接独立包目录（v2.4.0 起的新布局，位于 web profile 目录下）。 */
export const BRIDGE_PACKAGE_DIRNAME = 'dsh-obsidian-bridge'

/** 桥接包内模块文件名。 */
export const BRIDGE_MODULE_FILENAME = 'index.mjs'

/** 桥接包清单声明名（DSH 插件清单与会话审计都会读到它）。 */
export const BRIDGE_PACKAGE_NAME = 'dsh-obsidian-bridge'

/** 包清单版本兜底（main.ts 传真实插件版本；任何情况下都必须非空）。 */
export const BRIDGE_PACKAGE_FALLBACK_VERSION = '0.0.0'

/**
 * 给 profile 清单补的 `version` 值（仅用于满足 dsh 的松散模块校验，无语义）。
 * 见 ensureProfileManifestVersion()。
 */
export const PROFILE_MANIFEST_VERSION = '0.0.0'

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
 * 编辑键判定（v2.5.1）：这些键必须留在 iframe 内部（DSH 自己的撤销/重做/全选/复制/删除/换行/光标移动），
 * 不得被快捷键透传 preventDefault 后转发给 Obsidian。与桥接脚本内嵌 editKey 同逻辑（parity 测试兜底）。
 */
export function kbdLocalOnly(e: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; key?: string }): boolean {
  const k = (e.key ?? '').toLowerCase()
  if (k === 'backspace' || k === 'delete' || k === 'enter' || k === 'tab' || k === 'escape') return true
  if (k.startsWith('arrow') || k === 'home' || k === 'end' || k === 'pageup' || k === 'pagedown') return true
  if (!e.ctrlKey && !e.metaKey) return false
  return k === 'z' || k === 'y' || k === 'a' || k === 'c' || k === 'v' || k === 'x' || k === 'insert'
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

/**
 * profile 目录（补丁文件与桥接插件所在）。v2.6.0 多 profile：由插件设置选定；
 * 空串归一为 web（与 DSH `dsh web` 别名一致）。profile 名在设置层已过白名单校验（settings.VALID_PROFILE_RE）。
 */
export function dshProfileDir(profile: string, home: string = dshHomeDir()): string {
  return join(home, 'profiles', profile === '' ? 'web' : profile)
}

/** web profile 目录（历史形态，等价 dshProfileDir('web', home)）。 */
export function webProfileDir(home: string = dshHomeDir()): string {
  return dshProfileDir('web', home)
}

/** 桥接独立包目录（profile 目录下）。 */
export function bridgePackageDir(profileDir: string): string {
  return join(profileDir, BRIDGE_PACKAGE_DIRNAME)
}

/** 桥接模块文件路径（补丁条目 name 指向它）。 */
export function bridgeModulePath(profileDir: string): string {
  return join(bridgePackageDir(profileDir), BRIDGE_MODULE_FILENAME)
}

/**
 * 桥接包清单内容（name/version 均非空是硬要求：DSH 的插件清单扩展会读取它，
 * 任一为空都会让每次 DeepSeek 请求以 REQUEST_EXTENSION 失败）。
 */
export function bridgePackageManifest(version: string): string {
  const v = version.trim() === '' ? BRIDGE_PACKAGE_FALLBACK_VERSION : version.trim()
  return `${JSON.stringify({ name: BRIDGE_PACKAGE_NAME, version: v, private: true, type: 'module' }, null, 2)}\n`
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

/**
 * 面板 iframe 首载 URL（v2.3.2）：插件持有启动认证链接（0.1.2+ 从服务输出捕获）时，
 * 在其上追加 ob=1 嵌入标记（配合服务端适配器直发 200）；无链接（<0.1.2 或服务非插件拉起）
 * 回普通地址——<0.1.2 本就无需认证，行为不变。
 */
export function embedFrameUrl(launchUrl: string, port: number): string {
  const plain = `http://127.0.0.1:${String(port)}/`
  const u = launchUrl.trim()
  if (u === '') return plain
  return u + (u.includes('?') ? '&' : '?') + 'ob=1'
}

/** 注入到 DSH 页面里的桥接脚本（单行、无 </script>、无模板占位）。 */
export function bridgeScriptSource(): string {
  return "(function(){if(window.__DSH_OBSIDIAN_BRIDGE__)return;window.__DSH_OBSIDIAN_BRIDGE__=true;" +
    // v2.3.2 嵌入认证适配器（页面侧）：服务端注入 __DSH_EMBED_TOKEN__ 时给 /api 流量补 Bearer 头、
    // 给 WebSocket（无法带 header）补 query token；<0.1.2 无此变量 ⇒ 本段惰性跳过。
    // fetch 的 input 可为 string/URL/Request——DSH 前端传 URL 对象（.href 而非 .url），
    // 只读 .url 会静默漏挂、RPC 全 401 致白屏（真机事故回归）；headers 可为对象或 Headers 实例，先复制再覆盖。
    "var ET='';try{ET=window.__DSH_EMBED_TOKEN__||''}catch(_){}" +
    "if(ET){" +
    "function apiHdr(n){var h={};try{var s=n&&n.headers;if(s){if(typeof s.forEach==='function'){s.forEach(function(v,k){h[String(k)]=String(v)})}else{for(var k in s){h[k]=String(s[k])}}}}catch(_){}" +
    "h.authorization='Bearer '+ET;return h}" +
    "var NF=window.fetch&&window.fetch.bind(window);" +
    "if(NF){window.fetch=function(i,n){try{var s='';if(typeof i==='string')s=i;else if(i)s=String(i.href||i.url||i);" +
    "if(s.indexOf('/api')>=0){n=Object.assign({},n||{},{headers:apiHdr(n)})}}catch(_){}return NF(i,n)}}" +
    // v2.6.0 面板内附件上传修复（方案 B 为主、A 兜底；[[DSH插件问题]] 问题二）：
    // dsh-client-file-upload 对 Blob 体走独立 Web Worker（Worker 内新建 XHR，页面 fetch/XHR 补丁看不见，
    // 跨站 iframe 又拿不到 cookie）⇒ 无凭据 401。
    // B（主路径，保留百分比进度）：包 Worker.prototype.postMessage——仅对 name==='dsh-file-upload' 的
    //   上传 Worker（dsh-client-file-upload runtime.js L164 固定名）把 /api URL 追加 ?token=<ET>；
    //   服务端 requestRejection 覆写接受 query token（embedPatchAuth 分支），Worker 原生 XHR 直接过认证，
    //   xhr.upload.onprogress 不受影响。消息对象浅拷贝，body/transfer 列表原样透传。
    // A（兜底，无 Worker 的罕见环境）：接官方 pre-Cordis 钩子 __DSH_FILE_UPLOAD__
    //   （dsh-client-file-upload/README.md L45；runtime.js L90-92 customTransport(hook.fetch)），
    //   上传改走已挂 Bearer 的页内 fetch；代价＝该次上传无百分比进度。
    // window.top!==window.self 闸门是刻意的：只有 iframe 面板走新路径，系统浏览器行为完全不变。
    // 整段包 try/catch：任何环境异常都不得让桥接脚本中断（ASI 事故教训——段首显式分号）。
    ";try{var OWE=window.Worker;if(window.top!==window.self){" +
    "if(typeof OWE==='function'&&OWE.prototype&&typeof OWE.prototype.postMessage==='function'){" +
    "var OPX=OWE.prototype.postMessage;" +
    "OWE.prototype.postMessage=function(m,t){try{if(this&&this.name==='dsh-file-upload'&&m&&typeof m.url==='string'&&m.url.indexOf('/api')>=0){" +
    "m=Object.assign({},m,{url:m.url+(m.url.indexOf('?')>=0?'&':'?')+'token='+encodeURIComponent(ET)})}}catch(_){}" +
    "return t===undefined?OPX.call(this,m):OPX.call(this,m,t)}}" +
    "else{try{if(window.fetch){window.__DSH_FILE_UPLOAD__={fetch:window.fetch.bind(window)}}}catch(_){}}" +
    "}}catch(_){}" +
    "var OW=window.WebSocket;" +
    "if(OW){var EW=function(u,p){try{u=String(u)+(String(u).indexOf('?')>=0?'&':'?')+'token='+encodeURIComponent(ET)}catch(_){}" +
    "return p===undefined?new OW(u):new OW(u,p)};" +
    "EW.prototype=OW.prototype;EW.CONNECTING=OW.CONNECTING;EW.OPEN=OW.OPEN;EW.CLOSING=OW.CLOSING;EW.CLOSED=OW.CLOSED;window.WebSocket=EW}" +
    // v2.4.0：0.1.5 新功能里有 XHR（文件上传进度、侧栏文档预览）与 EventSource（HMR）——
    // 只补 fetch/WebSocket 会漏挂凭证 ⇒ 那些请求 401，前端按「会话失效」弹 authentication required。
    // XHR 走原型包装：open 记 URL、send 前补 Authorization（header 必须在 open 之后、send 之前设）。
    "var OXP=window.XMLHttpRequest&&window.XMLHttpRequest.prototype;" +
    "if(OXP&&OXP.open&&OXP.send){var xOpen=OXP.open,xSend=OXP.send;" +
    "OXP.open=function(m,u){try{this.__dshBridgeUrl=String(u)}catch(_){}return xOpen.apply(this,arguments)};" +
    "OXP.send=function(){try{if(String(this.__dshBridgeUrl||'').indexOf('/api')>=0)this.setRequestHeader('authorization','Bearer '+ET)}catch(_){}return xSend.apply(this,arguments)}}" +
    "var OE=window.EventSource;" +
    "if(OE){var EES=function(u,c){try{u=String(u)+(String(u).indexOf('?')>=0?'&':'?')+'token='+encodeURIComponent(ET)}catch(_){}" +
    "return c===undefined?new OE(u):new OE(u,c)};" +
    "EES.prototype=OE.prototype;EES.CONNECTING=OE.CONNECTING;EES.OPEN=OE.OPEN;EES.CLOSED=OE.CLOSED;window.EventSource=EES}" +
    "}" +
    // 隐式行正则（与 TS 版 BRIDGE_LINE_RE 同逻辑；页面脚本上下文，独立定义）
    "var BRIDGE_LINE_RE=/\\[\\s*BRIDGES is delivering packages for you……\\s*·\\s*(\\d+)\\s*words\\s*·\\s*L(\\d+):(\\d+)-L(\\d+):(\\d+)\\s*·\\s*([^\\]]+?)\\s*·\\s*\\]/;" +
    // 合并填充（**v2.4.0 原版，2026-09-11 按用户要求回退到此版**）：用全局正则剔除所有旧隐式行，
    // 而非按 \n 分行——Lexical 是分块编辑器，textContent 把多个块拼接时不带换行，
    // 按行剔除会把 "[旧隐式行][用户文字]" 误判成一行整条丢弃（取消框选时连用户文字一起清掉）。
    "function stripBridge(s){return String(s==null?'':s).replace(/\\[\\s*BRIDGES is delivering packages for you……[^\\]]*\\]/g,'')}" +
    "function mergeFill(existing,incoming){var rest=stripBridge(existing).replace(/\\n{3,}/g,'\\n\\n').replace(/^\\s+|\\s+$/g,'');" +
    "if(incoming==='')return rest;return rest===''?incoming:incoming+'\\n'+rest}" +
    "function pick(){var el=document.querySelector('textarea[data-phase]')||document.querySelector('textarea');" +
    "if(el){return el.readOnly||el.disabled?null:el}" +
    // 0.1.3+ 输入框改为 contentEditable（role=textbox）：textarea 不存在时取可见、未禁用的可编辑元素
    "var eds=document.querySelectorAll('[contenteditable=\"true\"]');" +
    "for(var i=0;i<eds.length;i++){var ce=eds[i];if(ce.isContentEditable&&!ce.disabled&&ce.offsetParent!==null)return ce}" +
    "return null}" +
    "function isField(el){var t=el.tagName;return t==='TEXTAREA'||t==='INPUT'}" +
    "function fieldSet(el,val){var p=el.tagName==='INPUT'?window.HTMLInputElement.prototype:window.HTMLTextAreaElement.prototype;" +
    "var d=Object.getOwnPropertyDescriptor(p,'value');d.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}))}" +
    // contentEditable（0.1.3+；0.1.5 输入框是 Lexical）：**v2.5.3 起以"定向替换隐式行"为主路径**——
    // ① 框里已有隐式行 → 只把该行原地换成新行（1 次 insertText，**不清空全文，因而不再出现"输入框瞬间为空"的闪烁**）；
    // ② 取消框选 → 只删该行（区间连带其后的段落分隔，不留空行）；
    // ③ 首次注入 → 光标移到最前插入新行，再补一个段落分隔，用户文字始终留在下面不动；
    // 硬判据 `targetedOk()`：隐式行条数正确 **且** 行外内容与填充前逐字一致（用户的文字全程不经我们手）。
    // 只有定向路径不可用（旧行跨文本节点、编辑器拒绝局部替换）才退回 v2.4.0 的"清空→重写"整串路径，
    // 且退回时**重新读取当前内容**再算目标串（绝不回写陈旧快照，见 lesson #13/#14）。
    // 注：**插件侧的失败重试已移除**（那是重复插入的放大器）；用户改动判定见 INTRUDED_SOURCE（内容比对，非事件计数）。
    "function evType(t,o){try{var I=window.InputEvent;return I?new I(t,o):new Event(t,{bubbles:true})}catch(_){return new Event(t,{bubbles:true})}}" +
    "function normWs(s){return String(s).replace(/\\s+/g,'')}" +
    // v2.5.3：隐式行的正则源串与 TS 侧 `BRIDGE_LINE_STRIP_RE` 共用同一事实源（parity 由测试兜底）
    "var BRIDGE_SRC=" + JSON.stringify(BRIDGE_LINE_STRIP_RE.source) + ";" +
    "var BRIDGE_RE=new RegExp(BRIDGE_SRC);" +
    "function countBridge(t){try{var re=new RegExp(BRIDGE_SRC,'g');var n=0;while(re.exec(String(t||''))){n++}return n}catch(_){return -1}}" +
    // v2.5.3：在输入框内定位"隐式行"的 DOM 区间（限单个文本节点内命中）。命中后若该行是本块尾部，
    // 把区间右端延到下一个文本节点开头——这样删除时能连带吃掉紧随的段落分隔，不留空行。
    "function lineRange(root){try{if(typeof NodeFilter==='undefined'||!document.createTreeWalker)return null;" +
    "var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null,false);var n;" +
    "while((n=w.nextNode())){var s=n.nodeValue||'';BRIDGE_RE.lastIndex=0;var m=BRIDGE_RE.exec(s);" +
    "if(m){var r=document.createRange();r.setStart(n,m.index);r.setEnd(n,m.index+m[0].length);" +
    "if(normWs(s.slice(m.index+m[0].length))===''){var w2=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null,false);var p;var seen=false;" +
    "while((p=w2.nextNode())){if(p===n){seen=true;continue}if(seen){try{r.setEnd(p,0)}catch(_){}break}}}" +
    "return r}}}catch(_){}return null}" +
    "function editFill(el,merged,line,cur,cb){var want=normWs(merged);var base=normWs(cur);" +
    "var rest=(merged===line)?'':((merged.indexOf(line)===0)?merged.slice(line.length).replace(/^\\n/,''):merged);" +
    // v2.5.1 ①：不再长时间抢占焦点——只在写入前后毫秒级持有，写完立刻还给注入前的焦点元素
    "var prevFocus=null;try{prevFocus=document.activeElement}catch(_){}" +
    // v2.5.3：写入必须 focus 输入框，但**焦点必须还回去**。iframe 内没有可还的目标（activeElement 是 body/null
    // = 用户原本在 Obsidian 侧）时，尽力请父页把窗口焦点收回——否则用户接着打字就落进 DSH 输入框。
    "function refocus(){try{if(prevFocus&&prevFocus!==el&&prevFocus!==document.body&&prevFocus.focus){prevFocus.focus();return}}catch(_){}" +
    "try{if(!prevFocus||prevFocus===document.body){window.parent.focus()}}catch(_){}}" +
    "function wf(){try{el.focus()}catch(_){}}" +
    "function noFlash(on){try{var id='dsh-nf-css',st=document.getElementById(id);" +
    "if(on){if(!st){st=document.createElement('style');st.id=id;" +
    "st.textContent='.dsh-nf-sel::selection{background:transparent;color:inherit}';document.head.appendChild(st)}" +
    "el.classList.add('dsh-nf-sel')}else{el.classList.remove('dsh-nf-sel')}}catch(_){}}" +
    "function txt(){try{return el.innerText||el.textContent||''}catch(_){return ''}}" +
    "function isEmpty(){return normWs(txt())===''}" +
    "function applied(){var t=normWs(txt());return want===''?t==='':t.indexOf(want)>=0}" +
    "function separated(){return txt().indexOf('\\n')>=0}" +
    "function selAll(){try{var s=window.getSelection();var r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r)}catch(_){}}" +
    // v2.5.1 ①附：分阶段写入之间会短暂让出焦点，Lexical 复原插入位可能落在开头 →
    // 仅在「光标塌缩在开头且位于本编辑器内」时把光标挪到末尾（原本正确的情况位置等价，无副作用）
    "function caretEnd(){try{var s=window.getSelection();if(!s||!s.rangeCount)return;var r=s.getRangeAt(0);" +
    "if(!r.collapsed||r.startOffset!==0||!el.contains(r.startContainer))return;" +
    "var rr=document.createRange();rr.selectNodeContents(el);rr.collapse(false);s.removeAllRanges();s.addRange(rr)}catch(_){}}" +
    "function exec(c,v){try{return document.execCommand(c,false,v===undefined?undefined:v)}catch(_){return false}}" +
    "function fireInput(type,data){try{el.dispatchEvent(evType('beforeinput',{inputType:type,data:data,bubbles:true,cancelable:true}));" +
    "el.dispatchEvent(evType('input',{inputType:type,data:data,bubbles:true}))}catch(_){}}" +
    // v2.5.1 ②（hotfix 版）：用户是否插进来改动过——**按内容比对，不用事件计数**。
    // 旧版数 keydown/beforeinput 事件，编辑器自身派发的合成事件（焦点/选区/写入回响）会被误判成
    // "用户输入" → 整体放弃 → 真机表现为「重新框选/取消框选，隐式行不自动变更」。
    // 判定：当前内容既不是本次目标串的一部分、也不是本次写入前的原内容 → 才是用户新输入的。
    INTRUDED_SOURCE +
    "function put(fn){try{fn()}catch(_){}refocus()}" +
    "function selRange(r){try{var s=window.getSelection();s.removeAllRanges();s.addRange(r)}catch(_){}}" +
    // 把光标放到输入框内容最开头（优先第一个非空文本节点），用于"在顶部插入新行"
    "function toStart(){try{var s=window.getSelection();" +
    "if(typeof NodeFilter!=='undefined'&&document.createTreeWalker){var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null,false);var n;" +
    "while((n=w.nextNode())){if((n.nodeValue||'')!==''){var r=document.createRange();r.setStart(n,0);r.collapse(true);s.removeAllRanges();s.addRange(r);return}}}" +
    "var r2=document.createRange();r2.selectNodeContents(el);r2.collapse(true);s.removeAllRanges();s.addRange(r2)}catch(_){}}" +
    // 本次填充"行以外的内容"基线：定向路径的硬判据——**除隐式行外一个字都不能变**
    "var restBefore=normWs(stripBridge(cur));" +
    // 定向写入成功判据（与测试共用同一源串，parity 由测试兜底）：
    // 隐式行条数正确 **且** 行外内容与基线逐字一致 + 目标行确实在框内。
    // 比旧版"整串清空重写"强得多：用户的文字全程不经我们手，被覆盖的可能性为零。
    TARGETED_OK_SOURCE +
    "function targetedOk(){return bridgeOk(txt(),line,restBefore)}" +
    "function targeted(done){var r=lineRange(el);" +
    // 取消框选：只删旧行（区间已连带其后的段落分隔），不碰用户文字
    "if(line===''){if(!r)return done('none');wf();selRange(r);put(function(){exec('delete')});" +
    "setTimeout(function(){done(targetedOk()?'ok':'bad')},90);return}" +
    // 重新框选：只把旧行原地换成新行（**一次 insertText，不清空、不出现空态**）
    "if(r){wf();selRange(r);put(function(){exec('insertText',line)});" +
    "setTimeout(function(){done(targetedOk()?'ok':'bad')},90);return}" +
    // 首次注入（框里没有旧行）：光标移到最前插入新行，再补一个段落分隔把用户文字留在下面
    "wf();toStart();put(function(){exec('insertText',line)});" +
    "setTimeout(function(){if(!targetedOk())return done('bad');if(restBefore==='')return done('ok');" +
    "wf();put(function(){exec('insertParagraph')});if(!separated()){put(function(){fireInput('insertParagraph')})}" +
    "setTimeout(function(){done(targetedOk()?(separated()?'ok':'nosep'):'bad')},90)},90)}" +
    "function finish(ok){noFlash(false);refocus();cb(ok)}" +
    "noFlash(true);" +
    "function clearAll(done){wf();exec('selectAll');setTimeout(function(){if(intruded())return done(false);put(function(){exec('delete')});" +
    "setTimeout(function(){if(isEmpty())return done(true);wf();selAll();setTimeout(function(){put(function(){exec('delete')});setTimeout(function(){done(isEmpty())},60)},60)},80)},80)}" +
    // 兜底路径（仅当定向路径不可用时才走）：分阶段 清空 → 行 → 段落 → 正文
    "function write(done){if(intruded())return done('stale');" +
    "if(rest===''){wf();put(function(){exec('insertText',merged)});setTimeout(function(){if(applied())return done('ok');if(intruded())return done('stale');" +
    "wf();put(function(){fireInput('insertText',merged)});setTimeout(function(){done(intruded()?'stale':(applied()?'ok':'bad'))},70)},80);return}" +
    "wf();put(function(){exec('insertText',line)});setTimeout(function(){if(intruded())return done('stale');" +
    "wf();put(function(){fireInput('insertParagraph')});if(!separated()){wf();put(function(){exec('insertParagraph')})}" +
    "setTimeout(function(){if(intruded())return done('stale');wf();caretEnd();put(function(){exec('insertText',rest)});setTimeout(function(){" +
    "if(applied()&&separated())return done('ok');if(applied())return done('nosep');if(intruded())return done('stale');" +
    "wf();put(function(){fireInput('insertText',merged)});setTimeout(function(){done(intruded()?'stale':(applied()?(separated()?'ok':'nosep'):'bad'))},70)},80)},70)},80)}" +
    // 定向失败（旧行跨文本节点、编辑器拒绝局部替换等）才退回整串重写；
    // **必须重新读取当前内容**再算目标串——旧版直接用本次开始的快照整串写回，正是"怪文字"的来源。
    "function fullRewrite(){var cur2=txt();var merged2=mergeFill(cur2,line);" +
    "if(normWs(cur2)===normWs(merged2))return finish(true);" +
    "merged=merged2;cur=cur2;want=normWs(merged2);base=normWs(cur2);" +
    "rest=(merged2===line)?'':((merged2.indexOf(line)===0)?merged2.slice(line.length).replace(/^\\n/,''):merged2);" +
    "clearAll(function(){write(function(r2){" +
    "if(r2==='ok'||r2==='nosep')return finish(true);if(r2==='stale')return finish(false);" +
    "if(intruded())return finish(false);wf();selAll();put(function(){exec('delete')});setTimeout(function(){" +
    "if(intruded())return finish(false);wf();selAll();put(function(){exec('insertText',merged)});" +
    "setTimeout(function(){finish(applied())},220)},60)})})}" +
    // 收口：先走定向路径（一次写入、无空态＝不再闪烁）；不成再退回整串重写
    "targeted(function(tr){if(tr==='ok'||tr==='nosep')return finish(true);fullRewrite()})}" +
    "function fillAck(ok,sep,had,note){try{window.parent.postMessage({type:'dsh-fill-ack',ok:!!ok,sep:!!sep,had:!!had,note:note||''},'*')}catch(_){}}" +
    "function fill(text){var n=0;function go(){var el=pick();" +
    "if(el){var cur=isField(el)?el.value||'':(el.innerText||el.textContent||'');var merged=mergeFill(cur,text);" +
    // v2.5.2 幂等短路：目标文本与当前内容一致时**一个字都不改**。长会话下父页的 selectionchange 会高频重发
    // 同一份草稿，旧版每次都执行"全选→删除→重写"——表现为聊天框持续闪烁（重写期间用户按键被夹在中间还会重复）。
    "if(normWs(cur)===normWs(merged)){fillAck(true,(cur||'').indexOf('\\n')>=0,false,'same');return}" +
    // 填充前焦点是否已在 DSH 输入框内：在的话，插件不得在 ACK 后把焦点抢回 Obsidian 编辑器
    "var hadFocus=false;try{hadFocus=document.activeElement===el||el.contains(document.activeElement)}catch(_){}" +
    "if(isField(el)){fieldSet(el,merged);fillAck(true,false,hadFocus,'field');return}" +
    "editFill(el,merged,text,cur,function(ok){var sep=false;" +
    "try{sep=(el.innerText||el.textContent||'').indexOf('\\n')>=0}catch(_){}" +
    "fillAck(ok,sep,hadFocus,'edit')});return}" +
    // 自适应重试：输入框尚未挂载（React 首屏加载中）时先密后疏，最长 ~3s
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
    // v2.5.0：**先解析成功再拦截**——旧版先 preventDefault 再判断，导致 [[路径|别名]] 这类
    // "含斜杠但解析不出可读文件"的文本被吞掉点击（点了没反应、也不冒泡）。
    "var r=resolveTxt(txt);" +
    "if(r&&readable(r)){e.preventDefault();e.stopPropagation();try{window.parent.postMessage({type:'dsh-open-in-obsidian',path:r},'*')}catch(_){}return}}" +
    "el=el.parentElement}},true);" +
    // v2.5.3：焦点进入输入框时回报父页（插件据此把"待写入的隐式行"补上）。
    // 这是"不抢焦点"的结构性做法：只在焦点**本来就在输入框里**时才写入，用户在笔记侧时一个字都不动。
    "document.addEventListener('focusin',function(e){try{var t=e.target;if(!t)return;" +
    "var isC=(t.tagName==='TEXTAREA')||(t.tagName==='INPUT')||!!t.isContentEditable;" +
    "if(!isC&&t.closest){isC=!!t.closest('[contenteditable=\"true\"]')}" +
    "if(isC){try{window.parent.postMessage({type:'dsh-composer-focus'},'*')}catch(_){}}}catch(_){}},true);" +
    // ---- v2.5.0：对话消息里的 [[wikilink]] 注解 + 点击跳转 ----
    // 渲染：把消息文本节点里的 [[目标]]/[[目标|别名]] 包成 <a class="dsh-wikilink" data-wikilink="目标">别名</a>，
    // 样式对齐 Obsidian 内链（样式注入到本页，插件 styles.css 不作用于 iframe 内文档）。
    // 只在"新增节点/文本变化"上增量注解（不全量扫描 body），避免大会话下反复遍历。
    "var WIKILINK_RE=/" + WIKILINK_SOURCE + "/g;" +
    "function wlStyle(){try{if(document.getElementById('dsh-wl-css'))return;var st=document.createElement('style');st.id='dsh-wl-css';" +
    "st.textContent='.dsh-wikilink{color:var(--link-color,var(--text-accent,#7b6cd9));text-decoration:underline;text-underline-offset:2px;cursor:pointer}'+'.dsh-wikilink:hover{opacity:.85}';" +
    "document.head.appendChild(st)}catch(_){}}" +
    "function wlSkip(el){for(var n=el;n&&n!==document.body;n=n.parentElement){var t=(n.tagName||'').toLowerCase();" +
    "if(t==='code'||t==='pre'||t==='script'||t==='style'||t==='textarea'||t==='input')return true;" +
    "if(n.isContentEditable)return true;if(n.classList&&n.classList.contains('dsh-wikilink'))return true}return false}" +
    "function wlReplace(node){try{var s=node.nodeValue;WIKILINK_RE.lastIndex=0;var frag=document.createDocumentFragment(),last=0,m;" +
    "while((m=WIKILINK_RE.exec(s))){if(m.index>last)frag.appendChild(document.createTextNode(s.slice(last,m.index)));" +
    "var a=document.createElement('a');a.className='dsh-wikilink';a.setAttribute('data-wikilink',m[1]);a.setAttribute('title',m[1]);" +
    "a.textContent=(m[2]&&m[2].trim())||m[1];frag.appendChild(a);last=m.index+m[0].length}" +
    "if(last===0)return;if(last<s.length)frag.appendChild(document.createTextNode(s.slice(last)));node.parentNode.replaceChild(frag,node)}catch(_){}}" +
    "function wlAnnotate(root){try{if(!root||wlSkip(root))return;var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);var batch=[],n;" +
    "while((n=walker.nextNode())){var s=n.nodeValue;if(!s||s.indexOf('[[')<0||s.length>2000)continue;if(wlSkip(n.parentNode))continue;" +
    "WIKILINK_RE.lastIndex=0;if(!WIKILINK_RE.test(s))continue;batch.push(n)}" +
    "for(var i=0;i<batch.length;i++)wlReplace(batch[i])}catch(_){}}" +
    "document.addEventListener('click',function(e){var el=e.target;" +
    "while(el&&el!==document.body){if(el.classList&&el.classList.contains('dsh-wikilink')){e.preventDefault();e.stopPropagation();" +
    "var t=el.getAttribute('data-wikilink')||'';if(t!==''){try{window.parent.postMessage({type:'dsh-wikilink',target:t},'*')}catch(_){}}return}el=el.parentElement}},true);" +
    "function wlStart(){try{wlStyle();wlAnnotate(document.body);var obs=new MutationObserver(function(recs){try{for(var i=0;i<recs.length;i++){var rc=recs[i];" +
    "if(rc.type==='characterData'){if(rc.target&&rc.target.parentNode)wlAnnotate(rc.target.parentNode);continue}" +
    "for(var j=0;j<rc.addedNodes.length;j++){var nd=rc.addedNodes[j];if(!nd)continue;" +
    "if(nd.nodeType===1)wlAnnotate(nd);else if(nd.nodeType===3&&nd.parentNode)wlAnnotate(nd.parentNode)}}}catch(_){}});" +
    "obs.observe(document.body,{childList:true,subtree:true,characterData:true})}catch(_){}}" +
    "if(document.body)wlStart();else document.addEventListener('DOMContentLoaded',wlStart);" +
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
    // v2.5.1 ④：请求配置加 5s 节流（旧版每次 keydown 都发，配置未到达时刷屏）
    "function requestKbd(){var t=Date.now();if(t-(window.__dshKbdReqAt||0)<5000)return;window.__dshKbdReqAt=t;" +
    "try{window.parent.postMessage({type:'dsh-kbd-request'},'*')}catch(_){}}" +
    "function logKbd(m){try{console.log('[dsh-bridge]',m)}catch(_){}}" +
    "function kbdList(){var s='';for(var i=0;i<kbdKeys.length;i++){s+=kbdKeys[i]+' '}return s}" +
    // v2.5.1 ④：编辑键一律留在 DSH 内部（旧版把 Ctrl+Z/A/C/V、Backspace 等也 preventDefault 转发给 Obsidian，
    // 导致 DSH 的撤销/选择/删除全部失效、字符跑到 Obsidian 笔记里）
    "function editKey(e){var k=(e.key||'').toLowerCase();" +
    "if(k==='backspace'||k==='delete'||k==='enter'||k==='tab'||k==='escape')return true;" +
    "if(k.indexOf('arrow')===0||k==='home'||k==='end'||k==='pageup'||k==='pagedown')return true;" +
    "if(!e.ctrlKey&&!e.metaKey)return false;" +
    "return k==='z'||k==='y'||k==='a'||k==='c'||k==='v'||k==='x'||k==='insert'}" +
    "logKbd('keydown listener installed, kbdKeys='+kbdKeys.length+': '+kbdList());" +
    "document.addEventListener('keydown',function(e){" +
    "if(editKey(e)){logKbd('editKey local: '+e.key);return}" +
    "logKbd('keydown ctrl='+e.ctrlKey+' meta='+e.metaKey+' key='+e.key+' kbdKeys='+kbdKeys.length);" +
    "if(!kbdKeys.length){requestKbd();return}" +
    "for(var i=0;i<kbdKeys.length;i++){if(kbdMatch(e,kbdKeys[i])){e.preventDefault();e.stopPropagation();" +
    "logKbd('MATCH '+kbdKeys[i]+' -> post');" +
    "try{window.parent.postMessage({type:'dsh-kbd-shortcut',key:kbdKeys[i]},'*')}catch(_){}return}}},true);" +
    "try{window.parent.postMessage({type:'dsh-bridge-ready'},'*')}catch(_){}" +
    // v2.4.4：界面健康上报——"白屏"时父页需要重刷。桥接脚本与 SPA 同文档，可直接量正文长度；
    // 同时真实打一次 /api（带凭证）汇报状态：白屏常是"SPA 起来后连接失败"，正文长度未必为空，
    // 故 API 状态是更可靠的判据（也用于诊断日志）。
    "try{var uiApi=null;var apiProbe=function(){try{if(!ET)return;" +
    "fetch('/api/session/list',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+ET}," +
    "body:JSON.stringify({type:'client-request',rpcId:'h'+Date.now(),method:'session/list',payload:{args:{_request:{}}}})})" +
    ".then(function(r){uiApi=r.status}).catch(function(){uiApi=-1})}catch(_){uiApi=-2}};" +
    "var uiTick=function(){try{var b=document.body;var t=b&&b.textContent?b.textContent:'';" +
    "window.parent.postMessage({type:'dsh-ui-state',len:t.length,api:uiApi},'*')}catch(_){}apiProbe()};" +
    "apiProbe();uiTick();setInterval(uiTick,2500)}catch(_){}" +
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
    "// v2.3.2 embedder-auth adapter (interim ③b): for DSH >=0.1.2 browser-session auth whose Strict cookie",
    "// is structurally unusable inside cross-site iframes. Adds an extra accepted credential WITHOUT touching",
    "// defaults: index GET /?token=<T>&ob=1 -> 200 (no ob -> original 303 cookie flow, real browsers intact);",
    "// /api 401 verdict overridden by matching Bearer header or query token (403 fence verdicts untouched).",
    "// Feature-detected: service/method absent (older DSH) or signature moved (newer refactor) -> inert fallback.",
    "// v2.4.4 inject-once: delivers the edit instruction through the DSH-native one-shot inbox",
    "// (agent.inbox.prepend('next-step', msg)) instead of appending a fresh persisted user/message on every",
    "// step, with a compaction-proof local ledger + session cap (see inject-ledger.json / inject-log.jsonl).",
    "import { createHash } from 'node:crypto'",
    "import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'",
    "import { dirname, join } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    "export const name = 'dsh-obsidian-bridge'",
    '',
    `const BRIDGE = '${escaped}'`,
    '',
    'const EMBED_TOKEN_QUERY = \'token\'',
    "const EMBED_MARKER_QUERY = 'ob'",
    'function embedHeader(req, name) {',
    '  try {',
    '    const h = req && req.headers',
    '    if (!h) return \'\'',
    "    if (typeof h.get === 'function') return h.get(name) || ''",
    "    return h[name] || h[name.toLowerCase()] || ''",
    '  } catch { return \'\' }',
    '}',
    'function embedParams(req) {',
    '  try {',
    "    const u = String((req && req.url) || '')",
    "    const qi = u.indexOf('?')",
    '    if (qi < 0) return new URLSearchParams()',
    '    return new URLSearchParams(u.slice(qi + 1))',
    '  } catch { return null }',
    '}',
    'function embedTokenOf(conn) {',
    '  try {',
    "    return new URL(conn.authenticatedUrl('http://127.0.0.1/')).searchParams.get(EMBED_TOKEN_QUERY) || ''",
    '  } catch { return \'\' }',
    '}',
    'function embedPatchAuth(conn, token) {',
    '  const proto = Object.getPrototypeOf(conn)',
    '  if (!proto || proto.__dshEmbedPatched) return',
    '  const origRejection = typeof conn.requestRejection === \'function\' ? proto.requestRejection : null',
    '  const origIndex = typeof conn.authorizeIndex === \'function\' ? proto.authorizeIndex : null',
    '  if (!origRejection && !origIndex) return',
    '  proto.__dshEmbedPatched = true',
    '  if (origRejection) {',
    '    proto.requestRejection = function (req) {',
    '      const verdict = origRejection.call(this, req)',
    '      if (verdict !== 401) return verdict',
    '      try {',
    "        if (embedHeader(req, 'authorization') === 'Bearer ' + token) return undefined",
    '        const sp = embedParams(req)',
    "        if (sp && sp.get(EMBED_TOKEN_QUERY) === token) return undefined",
    '      } catch {}',
    '      return verdict',
    '    }',
    '  }',
    '  if (origIndex) {',
    '    proto.authorizeIndex = function (req, res) {',
    '      try {',
    '        if (req && req.method === \'GET\') {',
    "          const u = String(req.url || '')",
    "          const pathOnly = u.slice(0, u.indexOf('?') < 0 ? u.length : u.indexOf('?'))",
    "          if (pathOnly === '/' || pathOnly === '') {",
    '            const sp = embedParams(req)',
    "            if (sp && sp.get(EMBED_MARKER_QUERY) === '1' && sp.get(EMBED_TOKEN_QUERY) === token) return true",
    '          }',
    '        }',
    '      } catch {}',
    '      return origIndex.call(this, req, res)',
    '    }',
    '  }',
    '}',
    'let embedDone = false',
    "let embedToken = ''",
    'let embedLogged = false',
    'function embedLog(msg) {',
    '  if (embedLogged) return',
    '  embedLogged = true',
    "  try { console.log('[dsh-obsidian-bridge] embed adapter:', msg) } catch (_) {}",
    '}',
    // 挂载期由 inject(['connection']) 调用：必须早于任何 index 请求（认证开启时 401/303 会先于
    // tapIndex 短路，包裹若放在 tapIndex 回调里永远装不上——鸡生蛋问题）
    'function embedActivate(conn) {',
    '  if (embedDone) return',
    '  embedDone = true',
    '  try {',
    "    if (!conn || typeof conn.authenticatedUrl !== 'function') { embedLog('no browser-auth API (pre-0.1.2) — idle'); return }",
    '    const token = embedTokenOf(conn)',
    "    if (!token) { embedLog('token parse empty'); return }",
    '    embedPatchAuth(conn, token)',
    "    embedLog('adapter active (token len ' + String(token.length) + ')')",
    '    embedToken = token',
    "  } catch (err) { embedLog('unexpected: ' + (err && err.message)) }",
    '}',
    '',
    bridgeEditInjectSource(),
    '',
    'export function apply(ctx) {',
    "  try { console.log('[dsh-obsidian-bridge] apply called') } catch (_) {}",
    "  ctx.inject(['connection'], (actx) => {",
    '    try { embedActivate(actx.connection) } catch (_) {}',
    '  })',
    "  ctx.inject(['webServer'], (httpCtx) => {",
    '    httpCtx.effect(',
    "      () => httpCtx.webServer.tapIndex((html) => {",
    "        const embedVar = embedToken ? '<script>window.__DSH_EMBED_TOKEN__=' + JSON.stringify(embedToken) + ';</script>' : ''",
    "        return html.replace('<head>', '<head>' + embedVar + '<script>' + BRIDGE + '</script>')",
    '      }),',
    "      'dsh-obsidian-bridge: index bridge',",
    '    )',
    '  })',
    '  try {',
    "    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {",
    '      const decision = await next()',
    "      if (decision.kind === 'reject') return decision",
    '      const pending = agent && agent.inbox && Array.isArray(agent.inbox.nextStep) ? agent.inbox.nextStep : []',
    '      const nodes = agent && agent.session && agent.session.surface && Array.isArray(agent.session.surface.nodes) ? agent.session.surface.nodes : []',
    "      const sessionKey = String((agent && agent.session && agent.session.id) || 'unknown')",
    '      const res = bridgeEditMaybeInject({ messages, pending, nodes, sessionKey })',
    '      const inboxReady = agent && agent.inbox && typeof agent.inbox.prepend === \'function\'',
    '      // v2.5.0：每会话一次投递「双链约定」（只走一次性 inbox；无 inbox API 时该约定仍包含在编辑指令里）',
    '      if (inboxReady) {',
    '        try { const rule = bridgeWikilinkRule(sessionKey); if (rule) agent.inbox.prepend(\'next-step\', rule) } catch (_) {}',
    '      }',
    '      if (!res || !res.msg) return decision',
    '      // v2.4.4：优先 DSH 原生一次性投递——inbox 项被消费即消失，不会像"每 step 追加一条 user/message"那样累积。',
    '      if (inboxReady) {',
    '        try { agent.inbox.prepend(\'next-step\', res.msg); return decision } catch (_) {}',
    '      }',
    "      return { kind: 'enter', messages: [...decision.messages, res.msg] }",
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

/**
 * 全局剔除隐式行（mergeFill 用，v2.4.0 原版）：匹配整条 [ BRIDGES …… ]，不依赖换行分块——
 * 与注入脚本内联 stripBridge 同逻辑（parity 由测试兜底）。路径不含 `]`，故 `[^\]]*` 足够。
 */
export const BRIDGE_LINE_STRIP_RE = /\[\s*BRIDGES is delivering packages for you……[^\]]*\]/g

/**
 * wikilink 正则**源串**（v2.5.0）：`[[目标]]` / `[[目标|别名]]`。
 * 页面脚本内联同一份源串（`new RegExp` 与本串共用），因此解析口径天然一致，parity 由测试兜底。
 * 排除 `[`、`]`、换行；目标/别名各限 200 字符，避免把长段落或代码误判为链接。
 */
export const WIKILINK_SOURCE = String.raw`\[\[([^\[\]\n|]{1,200})(?:\|([^\[\]\n]{1,200}))?\]\]`

/**
 * 「用户插进来改动过输入框」判定**源串**（v2.5.1 hotfix）：页面脚本内联同一份源串，parity 由测试兜底。
 * 依赖闭包变量 `want`（本次目标串的归一文本）、`base`（本次写入前的归一文本）与函数 `normWs`/`txt`。
 *
 * 为什么不用事件计数：编辑器（Lexical）在焦点/选区/写入回响时也会派发 keydown/beforeinput 之类事件，
 * 按事件计数会把它们误判成"用户输入"→ 整个填充在写入前放弃 → 真机症状「重新框选/取消框选，隐式行不自动变更」。
 * 改为内容比对后，只有出现"既非本次目标串的一部分、也不是写入前原内容"的文本才认定用户插了进来。
 */
export const INTRUDED_SOURCE =
  "function intruded(){var nt=normWs(txt());if(nt==='')return false;" +
  "if(want.indexOf(nt)>=0)return false;if(base!==''&&base.indexOf(nt)>=0)return false;return true}"

/**
 * 定向写入成功判据**源串**（v2.5.3）：页面脚本内联同一份源串，真值表测试兜底。
 * 依赖自由标识符 `countBridge`/`normWs`/`stripBridge`（页面侧是脚本内函数；测试侧以参数注入）。
 *
 * 判据之所以比旧版强：整串重写时用户的文字要经我们手一遍（写错就丢字），而定向替换只碰隐式行区间，
 * 因此可以要求「行外内容与填充前**逐字一致**」——一旦该不变量被破坏（编辑器做了别的事、
 * 用户此刻输入、行被复制成两条），判据为 false → 退回整串路径，不会静默留下错乱内容。
 */
export const TARGETED_OK_SOURCE =
  "function bridgeOk(t,line,restBefore){var c=countBridge(t);var restAfter=normWs(stripBridge(t));" +
  "if(line==='')return c===0&&restAfter===restBefore;" +
  "return c===1&&restAfter===restBefore&&normWs(t).indexOf(normWs(line))>=0}"

/** 解析出的 wikilink。 */
export interface ParsedWikilink {
  /** 链接目标（已 trim；`路径/笔记`、`笔记#标题` 均原样保留）。 */
  target: string
  /** 显示文本（无别名时等于 target）。 */
  alias: string
}

/** 提取文本里的全部 wikilink（页面脚本的 DOM 注解逻辑用的同一口径）。 */
export function parseWikilinks(text: string): ParsedWikilink[] {
  const re = new RegExp(WIKILINK_SOURCE, 'g')
  const out: ParsedWikilink[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const target = m[1].trim()
    if (target === '') continue
    out.push({ target, alias: (m[2] ?? '').trim() || target })
  }
  return out
}

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
 * 合并填充：新隐式行置顶，保留用户已在聊天框输入的内容（与注入脚本内联 mergeFill **同逻辑**；parity 由测试兜底）。
 * **v2.4.0 原版**（2026-09-11 按用户要求回退到此版）：用全局正则剔除所有旧隐式行，不按 \n 分行——
 * Lexical 分块编辑器的内容可能把"[旧隐式行][用户文字]"拼成无换行的一串，按行剔除会误删用户文字。
 * - incoming === ''（清除）：仅移除隐式行，返回剩余用户输入；
 * - incoming 非空：`隐式行 + 换行 + 用户输入`。
 */
export function mergeFillText(existing: string, incoming: string): string {
  const rest = String(existing ?? '')
    .replace(BRIDGE_LINE_STRIP_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
  if (incoming === '') return rest
  return rest === '' ? incoming : `${incoming}\n${rest}`
}

/**
 * 内联进桥接插件 .mjs 的 pre-step 编辑指令逻辑（手写单行风格，注意转义）：
 * 命中 BRIDGES 隐式行 → 追加一条 source.kind='plugin' 的指令消息：
 * 模型先 read 该区域原文 → 按用户要求直接生成结果（只输出结果一段，
 * 不带定位/补充说明）→ 询问用户是否同意写入 → 同意后用 fs edit 写入。
 *
 * source.form 必须落在 dsh 的冻结清单内（instructions/catalog/snapshot/notice/relay/recall）。
 * 曾用自定义值 'bridge-edit'，会让 0.1.5 的 v0→v1→v2→v3 迁移直接拒收整个会话
 * （`source form must be one of ...`），故改用 dsh 自带插件统一采用的
 * `notice` + `summary` 形态（参考 plan-mode / tool-jobs / repeat-tool-reminder）。
 *
 * 注入的消息**必须自带 `id`（非空字符串）与 `role: 'user'`**。
 * dsh 0.1.5 的会话校验（`assertMessageEventShape`）对这四类消息事件
 * （system/message、user/message、assistant/message、tool/result）要求
 * 「已识别的 message」：`id` 必须是非空字符串，`role` 必须与事件类型匹配。
 * 先前只返回 `{ source, content }`，落盘成 user/message 后缺 id/role →
 * 整个会话读不出来（`session event at seq N lacks an identified message`）。
 * 迁移链只会替**旧**事件补 id（`legacy-message:<sessionId>:<seq>`），
 * 运行期新注入的消息不走迁移，无人补 —— 故必须在这里自带。
 * 与 dsh 自带插件一致（`repeat-tool-reminder` 用 `id: randomUUID()` + `role: 'user'`）。
 */
export function bridgeEditInjectSource(): string {
  return [
    "const BRIDGE_LINE_RE = /\\[\\s*BRIDGES is delivering packages for you……\\s*·\\s*(\\d+)\\s*words\\s*·\\s*L(\\d+):(\\d+)-L(\\d+):(\\d+)\\s*·\\s*([^\\]]+?)\\s*·\\s*\\]/",
    'function bridgeMessageId() {',
    '  try {',
    '    const c = globalThis.crypto',
    "    if (c && typeof c.randomUUID === 'function') return c.randomUUID()",
    "    if (c && typeof c.getRandomValues === 'function') {",
    '      const b = c.getRandomValues(new Uint8Array(16))',
    '      b[6] = (b[6] & 15) | 64',
    '      b[8] = (b[8] & 63) | 128',
    "      let h = ''",
    '      for (let i = 0; i < 16; i++) h += (b[i] + 256).toString(16).slice(1)',
    "      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)",
    '    }',
    '  } catch (_) {}',
    "  return 'bridge-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)",
    '}',
    // ---- v2.4.4 注入台账（不依赖会话窗口；压缩裁剪也击不穿）+ 限流熔断 ----
    // 与 src/inject-ledger.ts 的 INJECT_LIMITS/decideInject 同规则（parity 由测试与模板标记兜底）。
    'const INJECT_LIMITS = { ttlMs: 600000, maxKeyHits: 1, maxSessionInjections: 20, maxItems: 200 }',
    "function bridgeLedgerPath(name) { try { return join(dirname(fileURLToPath(import.meta.url)), name) } catch (_) { return '' } }",
    "function bridgeLoadLedger() { try { const f = bridgeLedgerPath('inject-ledger.json'); if (!f || !existsSync(f)) return { version: 1, items: [], sessions: {}, ruleSessions: [] }; const p = JSON.parse(readFileSync(f, 'utf8')); return { version: 1, items: Array.isArray(p.items) ? p.items : [], sessions: p.sessions && typeof p.sessions === 'object' ? p.sessions : {}, ruleSessions: Array.isArray(p.ruleSessions) ? p.ruleSessions : [], storm: p.storm } } catch (_) { return { version: 1, items: [], sessions: {}, ruleSessions: [] } } }",
    "function bridgeSaveLedger(data) { try { const f = bridgeLedgerPath('inject-ledger.json'); if (!f) return false; mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(data), 'utf8'); return true } catch (_) { return false } }",
    "function bridgePrune(data, now) { try { const items = data.items.filter((it) => it && typeof it.at === 'number' && now - it.at <= INJECT_LIMITS.ttlMs); items.sort((a, b) => b.at - a.at); return { ...data, items: items.slice(0, INJECT_LIMITS.maxItems) } } catch (_) { return { version: 1, items: [], sessions: {} } } }",
    "function bridgeKeyHits(data, key, now) { try { return data.items.filter((it) => it.key === key && now - it.at <= INJECT_LIMITS.ttlMs).length } catch (_) { return 0 } }",
    "function bridgeInjectKey(path, loc, instruction) { try { return createHash('sha256').update(path + '|' + loc + '|' + String(instruction).trim()).digest('hex').slice(0, 16) } catch (_) { return 'k' + String(path.length) + '-' + loc } }",
    "function bridgeInjectSig(path, loc) { return '[BRIDGES 编辑指令] ' + path + ' · ' + loc }",
    "function bridgeLogDecision(res, sessionKey) { try { const f = bridgeLedgerPath('inject-log.jsonl'); if (!f) return; if (existsSync(f) && statSync(f).size > 262144) writeFileSync(f, ''); appendFileSync(f, JSON.stringify({ at: Date.now(), session: sessionKey, action: res ? res.action : 'skip', reason: res ? res.reason : 'none', key: res ? res.key : '', keyHits: res ? res.keyHits : 0, sessionCount: res ? res.sessionCount : 0 }) + '\\n', 'utf8') } catch (_) {} }",
    "function bridgeDecideInject({ messages, pending, nodes, sessionKey }) {",
    "  const base = { action: 'skip', reason: 'none', msg: null, key: '', sig: '', keyHits: 0, sessionCount: 0 }",
    '  if (!messages || !messages.length) return base',
    '  const last = messages[messages.length - 1]',
    "  const text = typeof last === 'string' ? last : ((last && last.content) || []).map((c) => (c && c.text) || '').join('')",
    '  if (!text) return base',
    '  const m = BRIDGE_LINE_RE.exec(text)',
    '  if (!m) return base',
    "  const path = m[6].trim()",
    "  const loc = 'L' + m[2] + ':' + m[3] + '-L' + m[4] + ':' + m[5]",
    "  const instruction = text.replace(BRIDGE_LINE_RE, '').trim() || '请读取该区域内容并处理'",
    '  const key = bridgeInjectKey(path, loc, instruction)',
    '  const sig = bridgeInjectSig(path, loc)',
    '  let windowHasInject = false',
    "  for (let i = 0; i < messages.length; i++) { const s = messages[i] && messages[i].source; if (s && s.plugin === 'dsh-obsidian-bridge') { windowHasInject = true; break } }",
    "  const sigOf = (x) => { try { const s2 = x && x.source; return s2 && typeof s2.summary === 'string' ? s2.summary : '' } catch (_) { return '' } }",
    "  const pendingSigs = (pending || []).map(sigOf).filter((x) => x !== '')",
    "  const surfaceSigs = (nodes || []).map(sigOf).filter((x) => x !== '')",
    '  const now = Date.now()',
    '  const data = bridgePrune(bridgeLoadLedger(), now)',
    '  const keyHits = bridgeKeyHits(data, key, now)',
    '  const sessionCount = data.sessions[sessionKey] || 0',
    '  const info = { key, sig, keyHits, sessionCount }',
    "  if (windowHasInject) return { ...base, ...info, reason: 'window' }",
    "  if (pendingSigs.indexOf(sig) >= 0) return { ...base, ...info, reason: 'pending' }",
    "  if (surfaceSigs.indexOf(sig) >= 0) return { ...base, ...info, reason: 'surface' }",
    "  if (keyHits >= INJECT_LIMITS.maxKeyHits) return { ...base, ...info, reason: 'ledger' }",
    "  if (sessionCount >= INJECT_LIMITS.maxSessionInjections) { bridgeSaveLedger({ ...data, storm: { at: now, reason: 'session cap', session: sessionKey } }); return { ...base, ...info, reason: 'caps' } }",
    "  const text2 = '[BRIDGES 编辑指令] 目标文件：' + path + '；选区（1 基行:列）：' + loc + '；用户要求：' + instruction",
    "    + '。处理后引用 vault 内其它笔记时，请使用 [[笔记名]] 或 [[路径/笔记名|别名]] 语法（不要用普通 Markdown 链接或绝对路径），这样 Obsidian 里才能点开。处理要求：先用 fs read 读取该区域原文；按用户要求直接生成结果（只输出结果本身、一段即可，不要附带定位说明或补充）；随后询问用户是否同意将该结果写入文件；经用户同意后再用 fs edit 写入（old_string=读取到的原文，按用户要求替换或追加）。本编辑任务完成后请忽略本指令，勿在后续对话中重复执行。'",
    "  const msg = { id: bridgeMessageId(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'notice', summary: sig }, content: [{ type: 'text', text: text2 }] }",
    '  bridgeSaveLedger({ ...data, items: [...data.items, { key, at: now, count: keyHits + 1, session: sessionKey, sig }], sessions: { ...data.sessions, [sessionKey]: sessionCount + 1 } })',
    "  return { action: 'inject', reason: 'none', msg, key, sig, keyHits: keyHits + 1, sessionCount: sessionCount + 1 }",
    '}',
    // 单一出口：判定 + 决策日志（hook 与直接调用者共用，保证 inject-log.jsonl 一定被写）
    'function bridgeEditMaybeInject(input) {',
    '  const res = bridgeDecideInject(input || {})',
    '  bridgeLogDecision(res, input && input.sessionKey)',
    '  return res',
    '}',
    // v2.5.0：每会话一次的「vault 双链约定」指令（DSH 原生 inbox 一次性投递；台账 ruleSessions 防重复）。
    // 与"编辑指令"不同：这条对所有回答生效，让模型在引用库内笔记时用 [[wikilink]] 而不是裸路径。
    'function bridgeWikilinkRule(sessionKey) {',
    '  try {',
    '    const data = bridgePrune(bridgeLoadLedger(), Date.now())',
    '    const done = Array.isArray(data.ruleSessions) ? data.ruleSessions : []',
    '    if (!sessionKey || done.indexOf(sessionKey) >= 0) return null',
    '    bridgeSaveLedger({ ...data, ruleSessions: [...done, sessionKey].slice(-50) })',
    "    const text = '引用本 vault 内笔记时，请使用 [[笔记名]] 或 [[路径/笔记名|别名]] 语法（不要用普通 Markdown 链接或绝对路径，链接目标不要带 .md 后缀）；这样 Obsidian 面板里才能直接点开。'",
    "    return { id: bridgeMessageId(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'notice', summary: '[BRIDGES 约定] vault 内笔记引用使用 [[wikilink]]' }, content: [{ type: 'text', text }] }",
    '  } catch (_) { return null }',
    '}',
  ].join('\n')
}

/** 安装结果。 */
export interface BridgeInstallResult {
  /** 是否发生了文件变更（新增插件/补丁条目）。 */
  changed: boolean
  /** 桥接插件文件绝对路径（安装失败时为空串）。 */
  pluginPath: string
  /** 桥接插件文件或补丁被重写（patch 条目已存在时 changed 可能为 false，但脚本更新/自愈后需重载面板生效）。 */
  pluginRewritten: boolean
  /** 安装失败原因（成功时缺省）。 */
  error?: string
}

/** 移除 dsh-fix 对 dsh-obsidian-bridge 的禁用覆盖块（`# dsh-fix: disabled entry "..."` + id + disabled:true）。
 * dsh-fix safe 会禁用用户插件，其 disabled 块在退出安全模式时可能残留，静默禁用桥接（历史复发）；
 * 该条目由本插件维护，检测到即清除。内容无变化时返回原串。 */
export function removeDshFixDisable(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let skip = false
  for (const line of lines) {
    if (/^#\s*dsh-fix:\s*disabled entry\s+"dsh-obsidian-bridge"/.test(line)) {
      skip = true
      continue
    }
    if (skip) {
      if (/^\s*-?\s*id:\s*"?dsh-obsidian-bridge"?\s*$/.test(line)) continue
      if (/^\s*disabled:\s*true\s*$/.test(line)) {
        skip = false
        continue
      }
    }
    out.push(line)
  }
  const result = out.join('\n')
  return result === content ? content : result
}

/** 桥接插件文件名的 SHA-256（判断磁盘文件是否已被旧插件代码写回旧版）。 */
function contentHash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** 原子写：先写临时文件再 rename，避免崩溃产生损坏文件（DSH 对不可解析的 patch 会拒绝启动）。 */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, filePath)
}

/**
 * 保证 profile 清单声明了非空 `version`（幂等；任何失败都吞掉，绝不阻断桥接安装）。
 *
 * 为什么需要：dsh 0.1.5 起 `@deepseek-ai/dsh-plugin-package-inventory-deepseek`（默认启用）
 * 会给每次 DeepSeek 官方请求附带 `dsh_plugin_packages` 字段——它遍历 Loader 树里的活跃条目，
 * 用 nearestManifest() 解析该条目「所属的包清单」，并要求 `name` 与 `version` 都非空。
 * 桥接是以「松散模块」形式直接躺在 profile 根目录的，nearestManifest() 命中的正是
 * dsh 自己写的 profile 清单；而 dsh 的 initProfile() 从不写 version ——
 * 于是 prepare() 抛错，整个请求以
 * `REQUEST_EXTENSION: DeepSeek request extension preparation failed` 终止。
 * （注意只影响 deepseek-official；换 provider 可绕过，故极易被误判成网络/额度问题。）
 * 补一个 version 即可解除，对 dsh 行为无其它影响。
 *
 * 为什么不会被抹掉：已知写这个清单的实现共四处（dsh 的 initProfile 只在文件缺失时写、
 * dsh 的 normalizeShippedProfile 用 {...manifest} 展开、本插件 aed 的两处用 {...pkg} 展开），
 * 全部保留未知字段。放在这里是为了让它随桥接安装自动自愈。
 */
function ensureProfileManifestVersion(dir: string): boolean {
  try {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return false
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return false
    const record = manifest as Record<string, unknown>
    if (typeof record.version === 'string' && record.version.trim().length > 0) return false
    // 按原键序重建，让 version 紧随 name（纯为可读性）
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      next[key] = value
      if (key === 'name') next.version = PROFILE_MANIFEST_VERSION
    }
    if (!('version' in next)) next.version = PROFILE_MANIFEST_VERSION
    atomicWrite(manifestPath, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/**
 * 把桥接补丁条目写进补丁文件（幂等）。
 * - 已存在同 id 条目：仅当 `name:` 指向的目标变化时替换（v2.4.0 迁移：根目录 .mjs → 独立包 index.mjs）；
 * - 不存在：按现有格式新建 / 去空数组模板 / 块式追加。
 * @returns content=新内容；changed=是否与原文不同（需落盘）。
 */
export function upsertBridgeEntry(existing: string, entry: string, fileUrl: string): { content: string; changed: boolean } {
  const idMarker = `- id: ${BRIDGE_ENTRY_ID}`
  const idIndex = existing.indexOf(idMarker)
  if (idIndex >= 0) {
    const afterId = existing.slice(idIndex + idMarker.length)
    const nameLine = /^([ \t]*name:[ \t]*)([^\n]*)$/m.exec(afterId)
    if (nameLine === null) return { content: existing, changed: false }
    if (nameLine[2].trim() === fileUrl) return { content: existing, changed: false }
    const start = idIndex + idMarker.length + (nameLine.index ?? 0) + nameLine[1].length
    const end = start + nameLine[2].length
    return { content: `${existing.slice(0, start)}${fileUrl}${existing.slice(end)}`, changed: true }
  }
  const body = existing
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .trim()
  if (existing === '') {
    return { content: `# ${BRIDGE_ENTRY_ID} — installed by the dsh-harness Obsidian plugin\n${entry}`, changed: true }
  }
  if (body === '[]') {
    const header = existing.trimEnd().replace(/\s*\[\s*\]\s*$/, '')
    return { content: `${header === '' || header.endsWith('\n') ? header : `${header}\n`}${entry}`, changed: true }
  }
  if (/^-\s/.test(body)) {
    return { content: `${existing.trimEnd()}\n${entry}`, changed: true }
  }
  return { content: existing, changed: false }
}

/**
 * 写入桥接插件（独立包：package.json + index.mjs）并合并补丁条目（幂等）。
 * 补丁文件为「顶层块式序列」的 patch 条目（`[]` 只是空数组的模板写法）：
 *   - insert:
 *       - id: dsh-obsidian-bridge
 *         name: file:///.../dsh-obsidian-bridge/index.mjs
 * 返回 changed=true 表示需要重启 DSH 服务才能加载桥接。
 *
 * 为什么独立成包（v2.4.0）：dsh 0.1.5+ 的 `dsh-plugin-package-inventory-deepseek`（默认启用）会为
 * 每次 DeepSeek 官方请求附带 `dsh_plugin_packages`，它用 `nearestManifest()` 从插件模块路径向上找
 * 「所属包清单」并要求 name/version 均非空。旧布局把 .mjs 直接放在 profile 根目录，命中的是 dsh 自己
 * 写的 profile 清单（initProfile 从不写 version）⇒ 抛错 ⇒ `REQUEST_EXTENSION: DeepSeek request
 * extension preparation failed`。放进独立包目录后命中桥接自己的清单，行为与普通插件一致。
 *
 * 内容哈希保险：仅在磁盘插件文件与当前源码（bridgePluginSource()）内容不一致时才重写。
 * 防止 Obsidian 内存里仍是旧插件 bundle 的进程（未彻底重启）在每次加载时用旧代码把
 * 磁盘上的新桥接覆盖回旧版（曾导致 pathOf 功能丢失、点击仍走外部打开）。
 */
export function writeBridgeFiles(
  home: string = dshHomeDir(),
  version: string = BRIDGE_PACKAGE_FALLBACK_VERSION,
  profile: string = 'web',
): BridgeInstallResult {
  try {
    const dir = dshProfileDir(profile, home)
    mkdirSync(dir, { recursive: true })
    // 兼容兜底（dsh 0.1.5+）：profile 清单缺 version 时补上——同目录下其它松散模块也受益。
    // 它在下次请求时即生效、无需重启，因此不计入 changed（避免多余的"请重启"提示）。
    ensureProfileManifestVersion(dir)

    // ① 独立包：package.json（name/version 必须非空）+ index.mjs
    const pkgDir = bridgePackageDir(dir)
    mkdirSync(pkgDir, { recursive: true })
    const pluginPath = bridgeModulePath(dir)
    const manifestPath = join(pkgDir, 'package.json')
    const manifest = bridgePackageManifest(version)
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifest) {
      atomicWrite(manifestPath, manifest)
    }
    const source = bridgePluginSource()
    let pluginRewritten = false
    if (!existsSync(pluginPath) || contentHash(readFileSync(pluginPath, 'utf8')) !== contentHash(source)) {
      // 覆盖前备份（v2.3.1）：用户本地手改的桥接文件不被静默吞掉（.bak-local 固定名，保留最近一份）
      if (existsSync(pluginPath)) {
        try {
          writeFileSync(`${pluginPath}.bak-local`, readFileSync(pluginPath, 'utf8'), 'utf8')
        } catch {
          // 备份失败不阻断重写
        }
      }
      atomicWrite(pluginPath, source)
      pluginRewritten = true
    }

    // ② 补丁条目：id 不变，name 指向新包路径（旧布局自动迁移）
    const patchPath = join(dir, 'cordis.patch.yml')
    let existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    // 自愈：清除 dsh-fix 对 dsh-obsidian-bridge 的禁用覆盖块（安全模式残留会静默禁用桥接）
    const healed = removeDshFixDisable(existing)
    if (healed !== existing) {
      atomicWrite(patchPath, healed)
      existing = healed
      pluginRewritten = true
    }
    const fileUrl = `file:///${pluginPath.replaceAll('\\', '/')}`
    const entry = `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: ${fileUrl}\n`
    const upserted = upsertBridgeEntry(existing, entry, fileUrl)
    if (upserted.changed) atomicWrite(patchPath, upserted.content)
    if (!upserted.content.includes(fileUrl)) {
      return {
        changed: false,
        pluginPath,
        pluginRewritten,
        // 路径按当前 profile 报（v2.6.0 多 profile：写死 web 会把用户支到另一个档去）
        error: t('bridge.patchMergeError', { patch: `~/.dsh/profiles/${profile === '' ? 'web' : profile}/cordis.patch.yml` }),
      }
    }

    // ③ 旧布局清理：条目已指向新模块后，备份并删除 profile 根目录下的旧 .mjs（失败也无害）
    const legacyPath = join(dir, BRIDGE_FILENAME)
    if (existsSync(legacyPath)) {
      try {
        if (!existsSync(`${legacyPath}.bak-local`)) {
          writeFileSync(`${legacyPath}.bak-local`, readFileSync(legacyPath, 'utf8'), 'utf8')
        }
        rmSync(legacyPath, { force: true })
      } catch {
        // 清理失败不阻断
      }
    }
    return { changed: upserted.changed, pluginPath, pluginRewritten }
  } catch (err) {
    return {
      changed: false,
      pluginPath: '',
      pluginRewritten: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 桥接是否已安装（独立包模块 + 补丁条目都在）。 */
export function isBridgeInstalled(home: string = dshHomeDir(), profile: string = 'web'): boolean {
  try {
    const dir = dshProfileDir(profile, home)
    if (!existsSync(bridgeModulePath(dir))) return false
    const patchPath = join(dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) return false
    return readFileSync(patchPath, 'utf8').includes(BRIDGE_ENTRY_ID)
  } catch {
    return false
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
