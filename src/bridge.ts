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
    // 合并填充（v2.4.0 重写）：用**全局正则**剔除所有旧隐式行，而非按 \n 分行——
    // Lexical 是分块编辑器，textContent 把多个块拼接时不带换行，按行剔除会把
    // "[旧隐式行][用户文字]"误判成一行整条丢弃（取消框选时连用户文字一起清掉）。
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
    // contentEditable（0.1.3+；0.1.5 输入框是 Lexical）：**必须走原生输入事件，且要等模型选区同步**。
    // Lexical 维护自己的模型：直接改 DOM 会被回滚；程序化改选区后浏览器异步派发 selectionchange，
    // Lexical 才会同步模型选区——所以"改选区→立刻 insertText"会插到旧光标处或被忽略（真机症状：
    // 重新框选不更新、取消框选不清除、输入框已有文字时插不进去）。
    // 因此按「分阶段 + 等待 + 校验」推进，每阶段失败才进入下一阶段：
    //   ① 全选 → 等待 → insertText（整串替换，含清除：目标为空即"清空"）
    //   ② 全选 → 等待 → delete → 等待 → 全选 → 等待 → insertText
    //   ③ 全选 → 等待 → beforeinput 输入事件
    //   ④ 直写 DOM + input（最后手段，可能被回滚）
    "function evType(t,o){try{var I=window.InputEvent;return I?new I(t,o):new Event(t,{bubbles:true})}catch(_){return new Event(t,{bubbles:true})}}" +
    "function normWs(s){return String(s).replace(/\\s+/g,'')}" +
    "function editFill(el,merged,line,cur,cb){var want=normWs(merged);" +
    "var rest=(merged===line)?'':((merged.indexOf(line)===0)?merged.slice(line.length).replace(/^\\n/,''):merged);" +
    "function noFlash(on){try{var id='dsh-nf-css',st=document.getElementById(id);" +
    "if(on){if(!st){st=document.createElement('style');st.id=id;" +
    "st.textContent='.dsh-nf-sel::selection{background:transparent;color:inherit}';document.head.appendChild(st)}" +
    "el.classList.add('dsh-nf-sel')}else{el.classList.remove('dsh-nf-sel')}}catch(_){}}" +
    "function txt(){try{return el.innerText||el.textContent||''}catch(_){return ''}}" +
    "function isEmpty(){return normWs(txt())===''}" +
    "function applied(){var t=normWs(txt());return want===''?t==='':t.indexOf(want)>=0}" +
    "function separated(){return txt().indexOf('\\n')>=0}" +
    "function selAll(){try{var s=window.getSelection();var r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r)}catch(_){}}" +
    "function exec(c,v){try{return document.execCommand(c,false,v===undefined?undefined:v)}catch(_){return false}}" +
    "function fireInput(type,data){try{el.dispatchEvent(evType('beforeinput',{inputType:type,data:data,bubbles:true,cancelable:true}));" +
    "el.dispatchEvent(evType('input',{inputType:type,data:data,bubbles:true}))}catch(_){}}" +
    "function dom(t){try{el.textContent=t;el.dispatchEvent(new Event('input',{bubbles:true}))}catch(_){}}" +
    "function finish(ok){noFlash(false);cb(ok)}" +
    "try{el.focus()}catch(_){}noFlash(true);" +
    // 第一步：清空。Lexical 认原生编辑命令（selectAll/delete 经 beforeinput 同步模型选区），DOM range 兜底。
    // **清空后再插入=整体写入**，杜绝"插到旧光标处追加"——这正是真机"重选叠加"的根因。
    "function clearAll(done){exec('selectAll');setTimeout(function(){exec('delete');setTimeout(function(){if(isEmpty())return done();" +
    "selAll();setTimeout(function(){exec('delete');setTimeout(done,60)},60)},80)},80)}" +
    // 第二步：在空内容上写入。rest 为空→只插隐式行；否则 行→原生段落→正文（保证真换行）。
    "function write(done){if(rest===''){exec('insertText',merged);setTimeout(function(){if(applied())return done('ok');" +
    "fireInput('insertText',merged);setTimeout(function(){if(applied())return done('ok');dom(merged);setTimeout(function(){done(applied()?'ok':'bad')},250)},70)},80);return}" +
    "exec('insertText',line);setTimeout(function(){fireInput('insertParagraph');if(!separated())exec('insertParagraph');" +
    "setTimeout(function(){exec('insertText',rest);setTimeout(function(){if(applied()&&separated())return done('ok');if(applied())return done('nosep');" +
    "fireInput('insertText',merged);setTimeout(function(){done(applied()?(separated()?'ok':'nosep'):'bad')},70)},80)},70)},80)}" +
    "clearAll(function(){write(function(r){if(r==='ok'||r==='nosep')return finish(true);" +
    // 清空/写入都失败：最后整体覆盖一次
    "selAll();setTimeout(function(){exec('insertText',merged);setTimeout(function(){finish(applied())},200)},80)})})}" +
    "function fill(text){var n=0;function go(){var el=pick();" +
    "if(el){var cur=isField(el)?el.value||'':(el.innerText||el.textContent||'');var merged=mergeFill(cur,text);" +
    // 不 focus（textarea 路径）：注入后焦点留在 Obsidian 编辑器；contentEditable 必须 focus，ACK 后插件会把焦点还给编辑器
    "if(isField(el)){fieldSet(el,merged);try{window.parent.postMessage({type:'dsh-fill-ack',ok:true},'*')}catch(_){}return}" +
    // ack 带真实校验结果：填充被编辑器回滚时插件据此走重试/直发兜底（避免"桥接就绪但隐式行没出现"的静默失败）
    "editFill(el,merged,text,cur,function(ok){var sep=false;" +
    "try{sep=(el.innerText||el.textContent||'').indexOf('\\n')>=0}catch(_){}" +
    "try{window.parent.postMessage({type:'dsh-fill-ack',ok:!!ok,sep:sep},'*')}catch(_){}});return}" +
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
    "// v2.3.2 embedder-auth adapter (interim ③b): for DSH >=0.1.2 browser-session auth whose Strict cookie",
    "// is structurally unusable inside cross-site iframes. Adds an extra accepted credential WITHOUT touching",
    "// defaults: index GET /?token=<T>&ob=1 -> 200 (no ob -> original 303 cookie flow, real browsers intact);",
    "// /api 401 verdict overridden by matching Bearer header or query token (403 fence verdicts untouched).",
    "// Feature-detected: service/method absent (older DSH) or signature moved (newer refactor) -> inert fallback.",
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

/**
 * 全局剔除隐式行（mergeFill 用）：匹配整条 [ BRIDGES …… ]，不依赖换行分块——
 * 与注入脚本内联 stripBridge 同逻辑（parity 由测试兜底）。路径不含 `]`，故 `[^\]]*` 足够。
 */
export const BRIDGE_LINE_STRIP_RE = /\[\s*BRIDGES is delivering packages for you……[^\]]*\]/g

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
 * v2.4.0：改用**全局正则**剔除所有旧隐式行，而非按 \n 分行——Lexical 分块编辑器的 textContent/innerText
 * 可能把"[旧隐式行][用户文字]"拼成无换行的一串，按行剔除会误删用户文字（取消框选清空全部的根因）。
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
    "function bridgeEditMaybeInject({ messages }) {",
    '  if (!messages || !messages.length) return null',
    '  const last = messages[messages.length - 1]',
    "  const text = typeof last === 'string' ? last : ((last && last.content) || []).map((c) => (c && c.text) || '').join('')",
    '  if (!text) return null',
    '  const m = BRIDGE_LINE_RE.exec(text)',
    '  if (!m) return null',
    '  for (let i = 0; i < messages.length; i++) {',
    '    const s = messages[i] && messages[i].source',
    "    if (s && s.plugin === 'dsh-obsidian-bridge') return null",
    '  }',
    "  const path = m[6].trim()",
    "  const loc = 'L' + m[2] + ':' + m[3] + '-L' + m[4] + ':' + m[5]",
    "  const instruction = text.replace(BRIDGE_LINE_RE, '').trim() || '请读取该区域内容并处理'",
    "  const text2 = '[BRIDGES 编辑指令] 目标文件：' + path + '；选区（1 基行:列）：' + loc + '；用户要求：' + instruction",
    "    + '。处理要求：先用 fs read 读取该区域原文；按用户要求直接生成结果（只输出结果本身、一段即可，不要附带定位说明或补充）；随后询问用户是否同意将该结果写入文件；经用户同意后再用 fs edit 写入（old_string=读取到的原文，按用户要求替换或追加）。本编辑任务完成后请忽略本指令，勿在后续对话中重复执行。'",
    "  const summary = '[BRIDGES 编辑指令] ' + path + ' · ' + loc",
    "  return { id: bridgeMessageId(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'notice', summary: summary }, content: [{ type: 'text', text: text2 }] }",
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
export function writeBridgeFiles(home: string = dshHomeDir(), version: string = BRIDGE_PACKAGE_FALLBACK_VERSION): BridgeInstallResult {
  try {
    const dir = webProfileDir(home)
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
      return { changed: false, pluginPath, pluginRewritten, error: t('bridge.patchMergeError') }
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
export function isBridgeInstalled(home: string = dshHomeDir()): boolean {
  try {
    const dir = webProfileDir(home)
    if (!existsSync(bridgeModulePath(dir))) return false
    const patchPath = join(dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) return false
    return readFileSync(patchPath, 'utf8').includes(BRIDGE_ENTRY_ID)
  } catch {
    return false
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
