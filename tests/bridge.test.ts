import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BRIDGE_ENTRY_ID,
  BRIDGE_FILENAME,
  BRIDGE_LINE_STRIP_RE,
  BRIDGE_PACKAGE_NAME,
  bridgeEditInjectSource,
  bridgeModulePath,
  bridgePackageDir,
  bridgePackageManifest,
  bridgeClientSource,
  bridgePluginSource,
  bridgeScriptSource,
  embedFrameUrl,
  hotkeyToPassthroughKey,
  isBridgeInstalled,
  isObsidianReadablePath,
  INTRUDED_SOURCE,
  kbdMatch,
  kbdLocalOnly,
  mergeFillText,
  parseBridgeLine,
  parseWikilinks,
  PROFILE_MANIFEST_VERSION,
  removeDshFixDisable,
  resolveVaultPath,
  SAME_ORIGIN_SOURCE,
  TARGETED_OK_SOURCE,
  upsertBridgeEntry,
  WIKILINK_SOURCE,
  webProfileDir,
  writeBridgeFiles,
} from '../src/bridge'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
}

describe('bridgeScriptSource', () => {
  it('包含消息类型与输入框选择器', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('dsh-fill-draft')
    expect(s).toContain('dsh-bridge-ping')
    expect(s).toContain('dsh-bridge-ready')
    expect(s).toContain('textarea[data-phase]')
  })
  it('fill 成功后回传 ACK（消除「已填入」假象）', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('dsh-fill-ack')
    // ACK 在 setter+input 事件之后发送（填入成功才回）——v2.5.2 起统一走 fillAck()，故按调用点断言顺序
    expect(s.indexOf("fillAck(true,false,hadFocus,'field')")).toBeGreaterThan(s.indexOf("dispatchEvent(new Event('input'"))
  })
  it('v2.5.2：幂等短路（目标与当前一致即不写）+ ACK 携带 had/note（插件据此不抢焦点、写遥测）', () => {
    const s = bridgeScriptSource()
    // v2.8.0：ACK 追加 `sd`（本次是否走了官方模型层写入）——插件据此跳过"归还焦点"（焦点从未被碰过）
    expect(s).toContain(
      "function fillAck(ok,sep,had,note,sd){try{window.parent.postMessage({type:'dsh-fill-ack',ok:!!ok,sep:!!sep,had:!!had,note:note||'',sd:!!sd},'*')}catch(_){}}",
    )
    expect(s).toContain("if(normWs(cur)===normWs(merged)){fillAck(true,(cur||'').indexOf('\\n')>=0,false,'same');return}")
    expect(s).toContain("var hadFocus=false;try{hadFocus=document.activeElement===el||el.contains(document.activeElement)}catch(_){}")
    expect(s).toContain("fillAck(ok,sep,hadFocus,'edit')")
  })
  it('textarea 未挂载时自适应重试（先密后疏：100ms×10 → 400ms×5，最长 ~3s）', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('setTimeout(go,100)')
    expect(s).toContain('setTimeout(go,400)')
    expect(s).not.toContain('setTimeout(go,200)')
  })
  it('v2.3.1/v2.4.0 双形态填入：textarea 不抢焦点；contentEditable focus+insertText 且**校验+降级**（ACK 后插件归还焦点）', () => {
    const s = bridgeScriptSource()
    // textarea/input：原生 setter，绝不 focus（框选后键盘操作留在 Obsidian）
    expect(s).toMatch(/function fieldSet[^}]*d\.set\.call\(el,val\)/)
    expect(s).not.toMatch(/function fieldSet[^}]*focus/)
    // contentEditable（0.1.3+；0.1.5 为 Lexical）：**v2.4.0 原版**（2026-09-11 按用户要求回退到此版）——
    // 分阶段「清空 → 写入」（有正文时 行 → insertParagraph → 正文 保证真换行），并带 noFlash 免闪蓝。
    // 唯一与 v2.4.0 的差别：**插件侧失败重试已移除**（它是重复插入的放大器）。
    expect(s).toContain('function editFill(el,merged,line,cur,cb)')
    expect(s).toContain("var rest=(merged===line)?'':((merged.indexOf(line)===0)?merged.slice(line.length)")
    expect(s).toContain('function clearAll(done)')
    expect(s).toContain('function write(done)')
    expect(s).toContain("fireInput('insertParagraph')") // 行与正文之间造真段落
    expect(s).toContain('function noFlash(on)')
    expect(s).toContain('.dsh-nf-sel::selection{background:transparent')
    expect(s).toContain('function stripBridge(s)')
    expect(s).toContain("(el.innerText||el.textContent||'')")
    // 只有追加模型（v2.4.3 中间版）不得残留
    expect(s).not.toContain('function editWrite(')
    expect(s).not.toContain('function editSet(')
    // ack 带 ok/sep（脚本自报结果）+ v2.5.2 的 had/note；插件侧不再据此重试
    expect(s).toContain("type:'dsh-fill-ack',ok:!!ok,sep:!!sep,had:!!had,note:note||''")
    // pick 双查询：textarea 优先，contentEditable 兜底
    expect(s).toContain('textarea[data-phase]')
    expect(s).toContain('[contenteditable="true"]')
    // v2.4.4：界面健康上报（父页据此判定"白屏"并自动整视图重渲染）
    expect(s).toContain("type:'dsh-ui-state'")
    expect(s).toContain('setInterval(uiTick,2500)')
  })
  it('v2.5.1 四点修复：焦点毫秒级归还 + 用户改动守卫 + 整串覆盖兜底仅在未被打断时执行 + 编辑键不外发', () => {
    const s = bridgeScriptSource()
    // ① 焦点：记录注入前的焦点元素，写入后立刻归还；结束时再还一次
    expect(s).toContain('var prevFocus=null;try{prevFocus=document.activeElement}')
    expect(s).toContain('function refocus(){')
    expect(s).toContain('function finish(ok){noFlash(false);refocus();cb(ok)}')
    // ② 守卫：**按内容比对**（不是事件计数）——事件计数会把编辑器自身的合成事件误判成用户输入，
    //    导致整次填充在写入前就被放弃（真机症状：重新框选/取消框选，隐式行不自动变更）
    expect(s).not.toContain('function watchEdits(el)')
    expect(s).not.toContain('__dshEditSeq')
    expect(s).toContain('function intruded(){var nt=normWs(txt());if(nt===\'\')return false;')
    expect(s).toContain("if(want.indexOf(nt)>=0)return false;if(base!==''&&base.indexOf(nt)>=0)return false;return true}")
    expect(s).toContain('var want=normWs(merged);var base=normWs(cur);')
    expect(s).toContain("if(intruded())return done('stale')")
    expect(s).toContain("if(r2==='stale')return finish(false)")
    // ③ textContent 整串覆盖（dom）仍不保留；兜底改为「未被打断时 selAll+insertText 整串替换」——
    //    这是唯一能覆盖"清空失败/插入被拒"的路径，且被内容守卫挡住旧快照场景
    expect(s).not.toContain('function dom(t)')
    expect(s).not.toContain('dom(merged)')
    expect(s).toContain('if(intruded())return finish(false);wf();selAll();put(function(){exec(\'delete\')});setTimeout(function(){')
    expect(s).toContain("if(intruded())return finish(false);wf();selAll();put(function(){exec('insertText',merged)});")
    // 清空失败不再直接放弃（旧版 return finish(false) 会让"隐式行不变"）
    expect(s).not.toContain('if(cleared===false)return finish(false)')
    // ①附：让出焦点后光标复原位置兜底（仅开头塌缩才挪到末尾）
    expect(s).toContain('function caretEnd(){')
    expect(s).toContain('if(!r.collapsed||r.startOffset!==0||!el.contains(r.startContainer))return;')
    expect(s).toContain("wf();caretEnd();put(function(){exec('insertText',rest)})")
    // ④ 编辑键不外发 + kbd 请求 5s 节流
    expect(s).toContain('function editKey(e)')
    expect(s).toContain("if(editKey(e)){logKbd('editKey local: '+e.key);return}")
    expect(s).toContain("if(t-(window.__dshKbdReqAt||0)<5000)return")
  })
  it('v2.5.3 定向替换：只改隐式行那一小段（不清空全文＝不再闪烁），失败才退回整串重写且**重读当前内容**', () => {
    const s = bridgeScriptSource()
    // 共享事实源：隐式行正则源串由 TS 侧 BRIDGE_LINE_STRIP_RE 生成（不再各处抄一遍）
    expect(s).toContain('var BRIDGE_SRC=' + JSON.stringify(BRIDGE_LINE_STRIP_RE.source) + ';')
    expect(s).toContain('function countBridge(t){')
    expect(s).toContain('function lineRange(root){')
    // 三条定向分支
    expect(s).toContain('function targetedOk(){return bridgeOk(txt(),line,restBefore)}')
    expect(s).toContain(TARGETED_OK_SOURCE)
    expect(s).toContain("if(line===''){if(!r)return done('none');wf();selRange(r);put(function(){exec('delete')});")
    expect(s).toContain('if(r){wf();selRange(r);put(function(){exec(\'insertText\',line)});')
    expect(s).toContain('wf();toStart();put(function(){exec(\'insertText\',line)});')
    // 收口：先定向，成功后**根本不进**清空路径；失败才 fullRewrite
    expect(s).toContain("targeted(function(tr){if(tr==='ok'||tr==='nosep')return finish(true);fullRewrite()})}")
    // 退回整串路径前必须重读当前内容（绝不回写本次开始时的陈旧快照）
    expect(s).toContain('function fullRewrite(){var cur2=txt();var merged2=mergeFill(cur2,line);')
    expect(s).toContain('if(normWs(cur2)===normWs(merged2))return finish(true);')
    expect(s).toContain('merged=merged2;cur=cur2;want=normWs(merged2);base=normWs(cur2);')
    // 旧版"每次都先清空全文"的收口不得残留
    expect(s).not.toContain('clearAll(function(){write(function(r){')
    // 结构性不抢焦点：页面在焦点进入输入框时回报父页（插件据此才写入）
    expect(s).toContain("window.parent.postMessage({type:'dsh-composer-focus'},'*')")
    expect(s).toContain("document.addEventListener('focusin',function(e){")
  })
  it('v2.5.3 bridgeOk 真值表：行外内容逐字不变才算成功（丢字/复制/漏插/被用户改动一律判失败）', () => {
    const make = new Function(
      'countBridge',
      'normWs',
      'stripBridge',
      `${TARGETED_OK_SOURCE}; return bridgeOk`,
    ) as (t: string, line: string, restBefore: string) => boolean
    const normWs = (s: unknown): string => String(s ?? '').replace(/\s+/g, '')
    const countBridge = (t: string): number => {
      const re = new RegExp(BRIDGE_LINE_STRIP_RE.source, 'g')
      let n = 0
      while (re.exec(String(t ?? ''))) n += 1
      return n
    }
    const stripBridge = (s: string): string => String(s ?? '').replace(BRIDGE_LINE_STRIP_RE, '')
    const ok = make(countBridge, normWs, stripBridge)
    const a = '[ BRIDGES is delivering packages for you…… · 12 words · L2:1-L2:9 · D:\\vault\\a.md · ]'
    const b = '[ BRIDGES is delivering packages for you…… · 7 words · L9:1-L10:3 · D:\\vault\\b.md · ]'
    // 换行成功：行被替换、用户文字原样
    expect(ok(`${b}\n用户文字`, b, normWs(stripBridge(`${a}\n用户文字`)))).toBe(true)
    // 换行时编辑器顺手吃掉了用户文字 → 失败（必须退回整串路径）
    expect(ok(b, b, '用户文字')).toBe(false)
    // 换行变成两条（复制）→ 失败
    expect(ok(`${b}\n${a}\n用户文字`, b, '用户文字')).toBe(false)
    // 写入期间用户又打了字 → 失败（不得覆盖用户内容）
    expect(ok(`${b}\n用户文字XYZ`, b, '用户文字')).toBe(false)
    // 首次注入：行确实插进来了
    expect(ok(`${a}\n用户文字`, a, '用户文字')).toBe(true)
    // 首次注入但行没进去 → 失败
    expect(ok('用户文字', a, '用户文字')).toBe(false)
    // 取消框选：只剩用户文字
    expect(ok('用户文字', '', `${a}\n用户文字`.replace(BRIDGE_LINE_STRIP_RE, '').replace(/\s+/g, ''))).toBe(true)
    // 取消框选却把用户文字一起弄没了 → 失败
    expect(ok('', '', '用户文字')).toBe(false)
    // 取消框选但行还在 → 失败
    expect(ok(`${a}\n用户文字`, '', '用户文字')).toBe(false)
  })
  it('v2.3.2/v2.4.0 嵌入认证适配器（页面侧）：fetch/WebSocket/XHR/EventSource 四路都补凭证；无 token 惰性', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('__DSH_EMBED_TOKEN__')
    expect(s).toContain("h.authorization='Bearer '+ET")
    expect(s).toContain("'token='+encodeURIComponent(ET)")
    // 仅 ET 非空才包装（<0.1.2 页面零影响）；判据源串必须**紧跟**在 if(ET){ 之后内联
    // （不锚定内部函数名：v2.8.2 起首函数是 bridgeOrigin 而不是 bridgeUrl）
    expect(s).toContain(`if(ET){${SAME_ORIGIN_SOURCE}`)
    // v2.8.1：命中判据是同源解析（见下面 SAME_ORIGIN_SOURCE 真值表），旧的字面量 '/api' 判据必须绝迹
    expect(s).toContain(SAME_ORIGIN_SOURCE)
    expect(s).not.toContain("if(s.indexOf('/api')>=0)")
    expect(s).not.toContain("String(this.__dshBridgeUrl||'').indexOf('/api')")
    expect(s).not.toContain("m.url.indexOf('/api')>=0")
    // fetch input 归一化必须含 .href（DSH 前端传 URL 对象——白屏事故回归）
    expect(s).toContain('String(i.href||i.url||i)')
    // v2.4.0：0.1.5 的文件上传进度与侧栏文档预览走 XHR，旧代码只补 fetch 会漏挂 → 401
    expect(s).toContain('window.XMLHttpRequest&&window.XMLHttpRequest.prototype')
    expect(s).toContain("this.setRequestHeader('authorization','Bearer '+ET)")
    // EventSource（HMR 等）无法带 header → 与 WebSocket 一样补 query token
    expect(s).toContain('window.EventSource')
    expect(s).toContain('EES.prototype=OE.prototype')
  })
  it('v2.3.2/v2.4.0/v2.8.1 页面补丁真机回归：stub 执行——fetch（URL 对象/字符串/Headers）与 XHR 都补 Bearer；同源才注入', () => {
    const captured: { url: unknown; init?: Record<string, unknown> }[] = []
    const xhrHeaders: string[] = []
    const XhrStub = function (this: Record<string, unknown>): void {
      // 构造器留空：只验证原型被打补丁后的行为
    } as unknown as { prototype: Record<string, unknown> }
    XhrStub.prototype = {
      open: (_method: string, _url: string) => undefined,
      send: () => undefined,
      setRequestHeader: (key: string, value: string) => {
        xhrHeaders.push(`${key}=${value}`)
      },
    }
    const locationStub = { origin: 'http://127.0.0.1:3199', href: 'http://127.0.0.1:3199/' }
    const windowStub: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      __DSH_EMBED_TOKEN__: 'TOK123',
      parent: null,
      location: locationStub,
      addEventListener: () => undefined,
      fetch: (input: unknown, init?: Record<string, unknown>) => {
        captured.push({ url: input, init })
        return Promise.resolve({})
      },
      XMLHttpRequest: XhrStub,
    }
    const documentStub = {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
      body: { addEventListener: () => undefined },
    }
    // location 必须显式传入：v2.8.1 的同源判据要读 location.origin/href（真实页面里是全局）
    new Function('window', 'document', 'Event', 'location', bridgeScriptSource())(
      windowStub, documentStub, class {}, locationStub,
    )
    const patched = windowStub.fetch as (i: unknown, n?: Record<string, unknown>) => Promise<unknown>
    // ① URL 对象（DSH 前端真实形态）
    void patched(new URL('http://127.0.0.1:3199/api/session/list'), { headers: { 'content-type': 'application/json' } })
    const h1 = captured[0].init?.headers as Record<string, string>
    expect(h1.authorization).toBe('Bearer TOK123')
    expect(h1['content-type']).toBe('application/json') // 原 header 未丢失
    // ② 字符串 input（带前导斜杠的旧形态）
    void patched('/api/host.describe', {})
    expect((captured[1].init?.headers as Record<string, string>).authorization).toBe('Bearer TOK123')
    // ③ **事故载荷**（v2.8.1 修复本体）：DSH 0.1.7 通用 RPC 通道传的是 `api/<endpoint>`，
    //    **没有前导斜杠**——旧的 s.indexOf('/api') 判据在这里返回 -1，整批 RPC 漏挂凭据 ⇒ 全 401、面板白屏
    void patched('api/settings/describe', { method: 'POST' })
    expect((captured[2].init?.headers as Record<string, string>).authorization).toBe('Bearer TOK123')
    // ④ 非 /api 但同源（/open-in-app/* 实测同样 401）：判据是同源，不做路径白名单
    void patched('open-in-app/apps', {})
    expect((captured[3].init?.headers as Record<string, string>).authorization).toBe('Bearer TOK123')
    // ⑤ 同源静态资源：一并注入（服务端不认也无副作用）——这是「不做路径白名单」的代价，明示以免被当成 bug
    void patched('/assets/logo.png', { headers: { accept: '*/*' } })
    const h5 = captured[4].init?.headers as Record<string, string>
    expect(h5.authorization).toBe('Bearer TOK123')
    expect(h5.accept).toBe('*/*')
    // ⑥ **安全不变量**：跨源一律不带凭据（绝对 URL 与协议相对形态都要挡住）
    void patched('https://evil.example/api/x', {})
    expect((captured[5].init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
    void patched('//evil.example/api/x', {})
    expect((captured[6].init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
    // ⑦ Headers 实例形态（forEach 复制路径）
    const hd = { forEach: (fn: (v: string, k: string) => void) => fn('application/json', 'content-type') }
    void patched('http://127.0.0.1:3199/api/x', { headers: hd })
    const h7 = captured[7].init?.headers as Record<string, string>
    expect(h7['content-type']).toBe('application/json')
    expect(h7.authorization).toBe('Bearer TOK123')
    // ⑧ XHR（0.1.5 文件上传进度 / 侧栏文档预览）：同源请求在 send 前补 Authorization
    const XhrCtor = windowStub.XMLHttpRequest as new () => { open: (m: string, u: string) => void; send: () => void }
    const apiXhr = new XhrCtor()
    apiXhr.open('POST', 'http://127.0.0.1:3199/api/file/upload')
    apiXhr.send()
    expect(xhrHeaders).toEqual(['authorization=Bearer TOK123'])
    // ⑨ XHR 无前导斜杠形态（同一事故的 XHR 分支）
    const relXhr = new XhrCtor()
    relXhr.open('POST', 'api/file/upload')
    relXhr.send()
    expect(xhrHeaders).toHaveLength(2)
    // ⑩ 跨源 XHR：不注入
    const evilXhr = new XhrCtor()
    evilXhr.open('GET', 'https://evil.example/api/x')
    evilXhr.send()
    expect(xhrHeaders).toHaveLength(2)
  })
  it('v2.8.1 bridgeSameOrigin/bridgePath 真值表（页面脚本内联同一份源串）：相对/绝对/跨源/ws/blob/空串', () => {
    const locationStub = { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/?token=T&ob=1' }
    const made = new Function('location', `${SAME_ORIGIN_SOURCE}; return { bridgeSameOrigin, bridgePath }`)(
      locationStub,
    ) as { bridgeSameOrigin: (s: unknown) => boolean; bridgePath: (s: unknown) => string }
    // 同源：相对无斜杠（事故形态）、前导斜杠、绝对 URL、URL 对象、带 query
    expect(made.bridgeSameOrigin('api/settings/describe')).toBe(true)
    expect(made.bridgeSameOrigin('open-in-app/apps')).toBe(true)
    expect(made.bridgeSameOrigin('/api/session/list')).toBe(true)
    expect(made.bridgeSameOrigin('/assets/logo.png')).toBe(true)
    expect(made.bridgeSameOrigin('http://127.0.0.1:3080/api/x')).toBe(true)
    expect(made.bridgeSameOrigin(new URL('http://127.0.0.1:3080/api/x'))).toBe(true)
    expect(made.bridgeSameOrigin('/api/x?token=abc')).toBe(true)
    // 跨源：绝对 URL、协议相对、不同端口、不同主机名写法、非 http 协议
    expect(made.bridgeSameOrigin('https://evil.example/api/x')).toBe(false)
    expect(made.bridgeSameOrigin('//evil.example/api/x')).toBe(false)
    expect(made.bridgeSameOrigin('http://127.0.0.1:3999/api/x')).toBe(false)
    expect(made.bridgeSameOrigin('http://localhost:3080/api/x')).toBe(false)
    // ws/wss **必须判同源**：WebSocket 分支用的就是这条判据（不是"调用方另行判定"——
    // v2.8.1 曾这么以为，于是 WS 分支判跨源、query token 不追、remote.mux 握手 401，真机回归）。
    // 原因：URL.origin 对 ws: 原样带 'ws://'，与页面 'http://' 永不相等 ⇒ 归一化后再比。
    expect(made.bridgeSameOrigin('ws://127.0.0.1:3080/api/remote.mux')).toBe(true)
    expect(made.bridgeSameOrigin(new URL('ws://127.0.0.1:3080/api/remote.mux'))).toBe(true)
    // wss 归一为 https：与 http 页面仍不同源（安全不变量不放宽）
    expect(made.bridgeSameOrigin('wss://127.0.0.1:3080/api/x')).toBe(false)
    expect(made.bridgeSameOrigin('ws://evil.example/api/x')).toBe(false)
    expect(made.bridgeSameOrigin('ws://127.0.0.1:3999/api/x')).toBe(false)
    // blob: 的 origin 委托给内层 URL ⇒ 归一化不误伤它
    expect(made.bridgeSameOrigin('blob:http://127.0.0.1:3080/abc')).toBe(true)
    expect(made.bridgeSameOrigin('data:text/plain,x')).toBe(false)
    // 空/畸形：不得误判为同源（空串会解析成文档自身）
    expect(made.bridgeSameOrigin('')).toBe(false)
    expect(made.bridgeSameOrigin(undefined)).toBe(false)
    expect(made.bridgeSameOrigin(null)).toBe(false)
    // bridgePath：解析后的 pathname（供上传 Worker 的精确路由判定用）；非同源返回空串
    expect(made.bridgePath('api/session/uploadFileBinary')).toBe('/api/session/uploadFileBinary')
    expect(made.bridgePath('/open-in-app/apps')).toBe('/open-in-app/apps')
    expect(made.bridgePath('https://evil.example/api/session/uploadFile')).toBe('')
  })
  it('v2.8.2 WebSocket 行为级：真构造一个 WebSocket，断言同源 ws 追加 query token、跨源不追加（v2.8.1 回归本体）', () => {
    // 为什么必须**行为级**：v2.8.1 给 WS 分支只留了字符串断言（`toContain('window.WebSocket')`），
    // 从未真的 `new` 过一个 WebSocket，于是「URL.origin 对 ws: 自带 'ws://' 前缀 ⇒ 与页面 origin 永不相等」
    // 这个坑一路全绿活到真机。字符串断言只能证明"代码在那儿"，证明不了"它算对了"。
    const wsUrls: string[] = []
    const WsStub = function (this: Record<string, unknown>, url: string): void {
      wsUrls.push(String(url))
    } as unknown as { CONNECTING: number; prototype: Record<string, unknown> }
    WsStub.prototype = {}
    WsStub.CONNECTING = 0
    const locationStub = { origin: 'http://127.0.0.1:3199', href: 'http://127.0.0.1:3199/?token=T&ob=1' }
    const windowStub: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      __DSH_EMBED_TOKEN__: 'TOK123',
      parent: null,
      location: locationStub,
      addEventListener: () => undefined,
      WebSocket: WsStub,
    }
    const documentStub = {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
      body: { addEventListener: () => undefined },
    }
    new Function('window', 'document', 'Event', 'location', bridgeScriptSource())(
      windowStub, documentStub, class {}, locationStub,
    )
    const Ws = windowStub.WebSocket as new (u: string) => unknown
    // ① **事故载荷**：会话主通道 ws://127.0.0.1:3199/...（origin 字面量是 'ws://…'）
    new Ws('ws://127.0.0.1:3199/api/remote.mux')
    expect(wsUrls[0]).toBe('ws://127.0.0.1:3199/api/remote.mux?token=TOK123')
    // ② 已带 query ⇒ 用 & 追加
    new Ws('ws://127.0.0.1:3199/api/x?a=1')
    expect(wsUrls[1]).toBe('ws://127.0.0.1:3199/api/x?a=1&token=TOK123')
    // ③ 安全不变量：跨源 ws 绝不带凭据
    new Ws('ws://evil.example/api/remote.mux')
    expect(wsUrls[2]).toBe('ws://evil.example/api/remote.mux')
    // ④ 异端口的本机服务同样不带（token 只属于本机 DSH 服务）
    new Ws('ws://127.0.0.1:3999/api/remote.mux')
    expect(wsUrls[3]).toBe('ws://127.0.0.1:3999/api/remote.mux')
  })
  it('v2.3.2 嵌入认证适配器（服务端）：包裹 requestRejection/authorizeIndex，条件化且可探测失效；.mjs 语法有效', async () => {
    const p = bridgePluginSource()
    expect(p).toContain('embedPatchAuth')
    expect(p).toContain('requestRejection')
    expect(p).toContain('authorizeIndex')
    // 关键安全不变量的文字证据：只覆盖 401 判定（fence 403 原样）、index 必须 ob=1+token（浏览器 303 路径不动）
    expect(p).toContain('if (verdict !== 401) return verdict')
    expect(p).toContain("sp.get(EMBED_MARKER_QUERY) === '1'")
    // 防重复打补丁 + 探测失败自动失效
    expect(p).toContain('__dshEmbedPatched')
    expect(p).toContain("typeof conn.authenticatedUrl !== 'function'")
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(p, { loader: 'js' })).not.toThrow()
  })
  it('v2.3.2 embedFrameUrl：有启动链接加 ob=1；无 query 的链接用 ?ob=1；无链接回普通地址', () => {
    expect(embedFrameUrl('', 3080)).toBe('http://127.0.0.1:3080/')
    expect(embedFrameUrl('http://127.0.0.1:3080/?token=abc', 3080)).toBe('http://127.0.0.1:3080/?token=abc&ob=1')
    expect(embedFrameUrl('http://127.0.0.1:3080/', 3080)).toBe('http://127.0.0.1:3080/?ob=1')
  })
  it('注入脚本不含控制字符（回归：labelPrefixed 的 \\b 曾编译成退格字节 0x08 导致标签跳过失效）', () => {
    const s = bridgeScriptSource()
    // eslint-disable-next-line no-control-regex
    expect(s).not.toMatch(/[\x00-\x08\x0b-\x1f]/)
    expect(s).toContain('delete)\\b/i')
    expect(s).not.toContain('delete)\x08')
  })
  it('包含路径点击重定向的消息与解析标记', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('dsh-open-in-obsidian')
    expect(s).toContain('dsh-open-cfg')
    expect(s).toContain('resolveTxt')
    expect(s).toContain('obsidian')
    // 产物 chip 用 title 属性取完整路径
    expect(s).toContain('pathOf')
    expect(s).toContain('getAttribute')
  })
  it('不包含会破坏 HTML 注入的片段', () => {
    const s = bridgeScriptSource()
    expect(s).not.toContain('</script>')
    expect(s).not.toContain('${')
  })
  it('可解析（new Function 不抛错）——防单行压缩导致 ASI 语法错误', () => {
    // 回归：曾因 `})` 与 `try{` 同行无分号导致整段脚本解析失败、从不执行
    expect(() => new Function(bridgeScriptSource())).not.toThrow()
  })
  it('esbuild 级语法校验（捕获 IIFE 包装下 new Function 盲区：`)` 与 `identifier` 粘连类 ASI 错）', async () => {
    // 回归：logKbd('...') 后直接接 document.addEventListener 无分号 → ")document" 被解析为调用
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(bridgeScriptSource(), { loader: 'js' })).not.toThrow()
  })
  it('执行后置位桥接标记并注册 message/click 监听（最小 window/document stub）', () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const windowStub: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      parent: null,
      location: { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/' },
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn
      },
      HTMLTextAreaElement: { prototype: { value: '' } },
    }
    const documentStub = {
      querySelector: () => null,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn
      },
      body: { addEventListener: () => undefined },
    }
    const EventStub = class {}
    new Function('window', 'document', 'Event', 'location', bridgeScriptSource())(
      windowStub,
      documentStub,
      EventStub,
      windowStub.location,
    )
    expect(windowStub.__DSH_OBSIDIAN_BRIDGE__).toBe(true)
    expect(typeof listeners.message).toBe('function')
    // 快捷键透传：keydown 监听必须注册（防 ASI 语法错误回归——曾导致整段脚本解析失败）
    expect(typeof listeners.keydown).toBe('function')
  })
})

describe('v2.6.0 面板内上传修复（B 主：Worker 消息补 token；A 兜底：__DSH_FILE_UPLOAD__ 钩子）', () => {
  /** 造一个 window stub（默认 iframe 形态：top!==self；带嵌入 token 与可捕获的 fetch）。 */
  function makeWin(over: Record<string, unknown> = {}): Record<string, unknown> {
    const win: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      __DSH_EMBED_TOKEN__: 'TOK123',
      parent: null,
      location: { origin: 'http://127.0.0.1:3199', href: 'http://127.0.0.1:3199/' },
      addEventListener: () => undefined,
      fetch: () => Promise.resolve({ status: 200, text: () => Promise.resolve('{}') }),
      top: { frameElement: null }, // ≠ self ⇒ iframe 场景
      ...over,
    }
    win.self = over.self !== undefined ? over.self : win
    return win
  }
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    body: { addEventListener: () => undefined },
    getElementById: () => null,
    createTreeWalker: undefined,
  }
  const runBridge = (win: Record<string, unknown>): void => {
    new Function('window', 'document', 'Event', 'location', bridgeScriptSource())(win, documentStub, class {}, win.location)
  }

  it('字符串断言：两段齐全、插在补丁 fetch 之后与 WebSocket 之前，且在 if(ET) 门内', () => {
    const s = bridgeScriptSource()
    expect(s).toContain("o.name==='dsh-file-upload'")
    expect(s).toContain('w.__dshUp=1')
    expect(s).toContain("bridgePath(m.url).indexOf('/api/session/uploadFile')===0")
    // v2.8.1：同一类事故的 Worker 分支——原来的 m.url.indexOf('/api') 既漏挂相对形态，又没做同源检查
    expect(s).toContain('bridgeSameOrigin(m.url)')
    expect(s).toContain('__DSH_FILE_UPLOAD__={fetch:window.fetch.bind(window)}')
    expect(s).toContain('window.top!==window.self')
    // 回归护栏：**不得再用 this.name 当闸门**——Chromium 里 `new Worker(u,{name}).name` 实测读回 null，
    // v2.6.0 的整段上传补丁正是因此从未执行（上传一直 401 而页面里看不到任何报错）。
    expect(s).not.toContain("this.name==='dsh-file-upload'")
    // A 兜底绑定的必须是已挂 Bearer 的补丁 fetch
    expect(s.indexOf('window.fetch=function')).toBeLessThan(s.indexOf('__DSH_FILE_UPLOAD__'))
    expect(s.indexOf('__DSH_FILE_UPLOAD__')).toBeLessThan(s.indexOf('var OW=window.WebSocket'))
    expect(s.indexOf('if(ET){')).toBeLessThan(s.indexOf('dsh-file-upload'))
  })

  it('B：经构造包装的上传 Worker——Bearer 头 + URL token 注入，body/transfer 原样透传', () => {
    type Msg = { url?: string; body?: unknown; headers?: Record<string, string> }
    const orig: Array<{ msg: Msg; transfer: unknown }> = []
    function WorkerStub(this: Record<string, unknown>, _u: unknown, _o?: unknown) {
      void _u
      void _o
    }
    WorkerStub.prototype = {
      postMessage(m: unknown, t: unknown) {
        orig.push({ msg: m as Msg, transfer: t })
      },
    }
    const win = makeWin({ Worker: WorkerStub })
    runBridge(win)
    const Ctor = win.Worker as unknown as new (u: string, o?: { name?: string }) => {
      postMessage: (m: unknown, t?: unknown) => void
      __dshUp?: number
      name?: unknown
    }
    // ① 具名实例：构造期打标记；注意 `.name` 在这里刻意保持读不到（等同 Chromium 真实行为）
    const up = new Ctor('blob:http://127.0.0.1:3199/x', { name: 'dsh-file-upload' })
    expect(up.__dshUp).toBe(1)
    expect(up.name).toBeUndefined()
    up.postMessage({ url: 'http://127.0.0.1:3199/api/session/uploadFileBinary?sessionId=s1', body: 'BLOB' })
    expect(String(orig[0]?.msg?.url)).toBe(
      'http://127.0.0.1:3199/api/session/uploadFileBinary?sessionId=s1&token=TOK123',
    )
    expect(orig[0]?.msg?.headers).toEqual({ authorization: 'Bearer TOK123' })
    expect(orig[0]?.msg?.body).toBe('BLOB')
    expect(orig[0]?.transfer).toBeUndefined()
    // ② 流分支：transfer 透传，原 headers 保留（DSH 传的是 content-type: application/octet-stream）
    const stream = { __stream: true }
    const up2 = new Ctor('blob:x', { name: 'dsh-file-upload' })
    up2.postMessage(
      { url: 'http://127.0.0.1:3199/api/session/uploadFileBinary', headers: { 'content-type': 'application/octet-stream' } },
      [stream],
    )
    expect(String(orig[1]?.msg?.url)).toContain('uploadFileBinary?token=TOK123')
    expect(orig[1]?.msg?.headers).toEqual({
      'content-type': 'application/octet-stream',
      authorization: 'Bearer TOK123',
    })
    expect(orig[1]?.transfer).toEqual([stream])
    // ③ **形态兜底**：即使构造时没带 options.name（DSH 哪天改写法），上传形态的消息照样补凭据
    const shapeless = new Ctor('blob:x')
    shapeless.postMessage({ url: 'http://127.0.0.1:3199/api/session/uploadFileBinary?sessionId=s2', headers: {} })
    expect(orig[2]?.msg?.headers).toEqual({ authorization: 'Bearer TOK123' })
    // ④ 调用方已自带凭据 → 不覆盖
    up.postMessage({ url: 'http://127.0.0.1:3199/api/session/uploadFileBinary?x=1', headers: { authorization: 'Bearer OTHER' } })
    expect(orig[3]?.msg?.headers).toEqual({ authorization: 'Bearer OTHER' })
    // ⑤ 其它 Worker 的普通 /api 消息与静态资源：一律不动（不误伤 HMR / 别的后台任务）
    const other = new Ctor('blob:x')
    other.postMessage({ url: 'http://127.0.0.1:3199/api/session/list' })
    expect(String(orig[4]?.msg?.url)).not.toContain('token=')
    expect(orig[4]?.msg?.headers).toBeUndefined()
    up.postMessage({ url: 'http://127.0.0.1:3199/assets/a.js' })
    expect(String(orig[5]?.msg?.url)).toBe('http://127.0.0.1:3199/assets/a.js')
    expect(orig[5]?.msg?.headers).toBeUndefined()
    // ⑥ v2.8.1 回归（同一事故的 Worker 分支）：**无前导斜杠**的相对上传 URL 照样补凭据
    const relUp = new Ctor('blob:x')
    relUp.postMessage({ url: 'api/session/uploadFileBinary?sessionId=s3', headers: {} })
    expect(String(orig[6]?.msg?.url)).toContain('uploadFileBinary?sessionId=s3&token=TOK123')
    expect(orig[6]?.msg?.headers).toEqual({ authorization: 'Bearer TOK123' })
    // ⑦ 跨源 URL 即使路径命中上传路由也绝不带凭据（同源闸门）：消息**原样透传**（headers 保持调用方原值）
    const evilUp = new Ctor('blob:x', { name: 'dsh-file-upload' })
    evilUp.postMessage({ url: 'https://evil.example/api/session/uploadFileBinary', headers: {} })
    expect(String(orig[7]?.msg?.url)).not.toContain('token=')
    expect(orig[7]?.msg?.headers).toEqual({})
    // ⑧ 原型与实例身份不被破坏（DSH 用 `typeof Worker==='function'` 与 `instanceof` 判定）
    expect(win.Worker).not.toBe(WorkerStub)
    expect(up instanceof (WorkerStub as unknown as new () => unknown)).toBe(true)
  })

  it('补丁脚本内不再假设「query token 能过上传路由」（v2.6.0 的错误前提，实测 401）', () => {
    const s = bridgeScriptSource()
    expect(s).toContain("h.authorization='Bearer '+ET")
    expect(s).toContain('if(h.authorization===undefined&&h.Authorization===undefined)')
  })

  it('A 兜底：iframe 无 Worker——设官方钩子，且载体确为补过 Bearer 的 fetch（绑定次序回归）', async () => {
    const calls: Array<{ input: unknown; init?: Record<string, unknown> }> = []
    const win = makeWin({
      Worker: undefined,
      fetch: (input: unknown, init?: Record<string, unknown>) => {
        calls.push({ input, init })
        return Promise.resolve({ status: 200, text: () => Promise.resolve('{}') })
      },
    })
    runBridge(win)
    const hook = win.__DSH_FILE_UPLOAD__ as { fetch: (i: unknown, n?: Record<string, unknown>) => Promise<unknown> }
    expect(typeof hook?.fetch).toBe('function')
    await hook.fetch('http://127.0.0.1:3199/api/session/uploadFileBinary?sessionId=s1', { method: 'POST' })
    const hdr = calls[0]?.init?.headers as Record<string, string>
    expect(hdr.authorization).toBe('Bearer TOK123')
  })

  it('顶层页（系统浏览器）零影响：不包 Worker 原型、不挂官方钩子', () => {
    let seen: unknown = null
    function WorkerStub(this: Record<string, unknown>) {
      void this
    }
    WorkerStub.prototype = {
      postMessage(m: unknown) {
        seen = m
      },
    }
    const win = makeWin({ top: undefined, Worker: WorkerStub })
    win.top = win // top===self：系统浏览器场景
    runBridge(win)
    expect(win.__DSH_FILE_UPLOAD__).toBeUndefined()
    const inst = Object.create(WorkerStub.prototype as object) as { name: string; postMessage: (m: unknown) => void }
    inst.name = 'dsh-file-upload'
    const msg = { url: 'http://127.0.0.1:3199/api/session/uploadFileBinary?sessionId=s1' }
    inst.postMessage(msg)
    // 对象同一性即证据：原型未被打补丁——补丁会浅拷贝改写 message，同一实例必为不同对象
    expect(seen).toBe(msg)
  })

  it('无 ET（<0.1.2 或非桥接拉起）：A/B 段整体惰性跳过', () => {
    const win = makeWin({ __DSH_EMBED_TOKEN__: '' })
    runBridge(win)
    expect(win.__DSH_FILE_UPLOAD__).toBeUndefined()
  })
})

describe('resolveVaultPath（路径点击的 Vault 内判定，与注入脚本同逻辑）', () => {
  const ROOT = 'D:\\Software\\Obsidian'
  it('相对路径按 Vault 根解析为规范绝对路径', () => {
    expect(resolveVaultPath('06 skill&agent/dsh-obsidian/README.md', ROOT)).toBe(
      'D:/Software/Obsidian/06 skill&agent/dsh-obsidian/README.md',
    )
  })
  it('Vault 内绝对路径（含反斜杠）判定在 Vault 内', () => {
    expect(resolveVaultPath('D:\\Software\\Obsidian\\协作记忆.md', ROOT)).toBe(
      'D:/Software/Obsidian/协作记忆.md',
    )
  })
  it('Vault 外绝对路径返回 null（取消打开）', () => {
    expect(resolveVaultPath('D:\\deepseek-harness\\packages\\x.ts', ROOT)).toBeNull()
    expect(resolveVaultPath('C:\\Windows\\System32\\x.dll', ROOT)).toBeNull()
  })
  it('处理 . 与 .. 段', () => {
    expect(resolveVaultPath('a/../b.md', ROOT)).toBe('D:/Software/Obsidian/b.md')
    expect(resolveVaultPath('06 skill&agent/./x.md', ROOT)).toBe('D:/Software/Obsidian/06 skill&agent/x.md')
  })
  it('根路径大小写不敏感（Windows）', () => {
    expect(resolveVaultPath('d:\\software\\obsidian\\a.md', 'D:\\Software\\Obsidian')).toBe(
      'd:/software/obsidian/a.md',
    )
  })
  it('空文本/超长文本返回 null', () => {
    expect(resolveVaultPath('', ROOT)).toBeNull()
    expect(resolveVaultPath('x'.repeat(301), ROOT)).toBeNull()
    expect(resolveVaultPath('', '')).toBeNull()
  })
})

describe('isObsidianReadablePath（Vault 内但不可读格式 → 不打开）', () => {
  it('文本/代码/媒体/PDF 可读', () => {
    expect(isObsidianReadablePath('a.md')).toBe(true)
    expect(isObsidianReadablePath('b/README.md')).toBe(true)
    expect(isObsidianReadablePath('c.ts')).toBe(true)
    expect(isObsidianReadablePath('d.json')).toBe(true)
    expect(isObsidianReadablePath('e.pdf')).toBe(true)
    expect(isObsidianReadablePath('f.png')).toBe(true)
    expect(isObsidianReadablePath('g.mp4')).toBe(true)
    expect(isObsidianReadablePath('D:/x/y.txt')).toBe(true)
  })
  it('二进制/办公/归档等不可读', () => {
    expect(isObsidianReadablePath('a.docx')).toBe(false)
    expect(isObsidianReadablePath('b.xlsx')).toBe(false)
    expect(isObsidianReadablePath('c.zip')).toBe(false)
    expect(isObsidianReadablePath('d.exe')).toBe(false)
    expect(isObsidianReadablePath('e.dll')).toBe(false)
    expect(isObsidianReadablePath('f.db')).toBe(false)
    expect(isObsidianReadablePath('g.wasm')).toBe(false)
    expect(isObsidianReadablePath('无扩展名')).toBe(false)
  })
})

describe('bridgePluginSource', () => {
  it('是合法 ESM：真实 node 导入成功且导出 name/apply', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, BRIDGE_FILENAME)
      writeFileSync(file, bridgePluginSource(), 'utf8')
      // 走真实 node 子进程（vitest 的模块加载器无法加载项目外文件）
      const script =
        `import(${JSON.stringify(pathToFileURL(file).href)}).then(m => {` +
        ` if (m.name !== 'dsh-obsidian-bridge' || typeof m.apply !== 'function') process.exit(2);` +
        ` console.log('OK') }).catch(e => { console.error(e); process.exit(1) })`
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 10000,
      })
      expect(out.trim()).toBe('OK')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('writeBridgeFiles', () => {
  it('首次写入：创建独立包（package.json + index.mjs）并追加补丁条目，changed=true', () => {
    const home = tempHome()
    try {
      const r = writeBridgeFiles(home, '9.9.9')
      expect(r.changed).toBe(true)
      expect(r.error).toBeUndefined()
      const dir = webProfileDir(home)
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain(BRIDGE_ENTRY_ID)
      expect(patch).toContain('file:///')
      expect(patch).toContain(bridgeModulePath(dir).replaceAll('\\', '/'))
      expect(readFileSync(bridgeModulePath(dir), 'utf8')).toContain('dsh-obsidian-bridge')
      // 包清单 name/version 非空（DSH 插件清单扩展的硬要求）
      const manifest = JSON.parse(readFileSync(join(bridgePackageDir(dir), 'package.json'), 'utf8')) as { name?: string; version?: string }
      expect(manifest.name).toBe(BRIDGE_PACKAGE_NAME)
      expect(manifest.version).toBe('9.9.9')
      // 旧布局文件不再产生
      expect(existsSync(join(dir, BRIDGE_FILENAME))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('旧布局迁移：根目录 .mjs + 旧补丁条目 → 独立包，旧文件备份后删除、条目指向新模块', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const legacy = join(dir, BRIDGE_FILENAME)
      writeFileSync(legacy, '// 用户手改过的旧桥接\nexport const name = "old"', 'utf8')
      const legacyUrl = `file:///${legacy.replaceAll('\\', '/')}`
      writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: ${legacyUrl}\n`, 'utf8')
      const r = writeBridgeFiles(home)
      expect(r.error).toBeUndefined()
      expect(r.changed).toBe(true) // 条目迁移需要重启生效
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).not.toContain(legacyUrl)
      expect(patch).toContain(bridgeModulePath(dir).replaceAll('\\', '/'))
      expect(existsSync(legacy)).toBe(false) // 旧文件已清理
      expect(readFileSync(`${legacy}.bak-local`, 'utf8')).toContain('用户手改过的旧桥接')
      // 再次调用幂等（条目已指向新模块）
      expect(writeBridgeFiles(home).changed).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('upsertBridgeEntry：同 id 且 name 已是目标 → 不改；name 不同 → 仅替换该行', () => {
    const url = 'file:///C:/x/index.mjs'
    const entry = `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: ${url}\n`
    const same = upsertBridgeEntry(entry, entry, url)
    expect(same.changed).toBe(false)
    const other = `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: file:///C:/old/legacy.mjs\n- disabled: true\n  id: other\n`
    const fixed = upsertBridgeEntry(other, entry, url)
    expect(fixed.changed).toBe(true)
    expect(fixed.content).toContain(url)
    expect(fixed.content).not.toContain('legacy.mjs')
    expect(fixed.content).toContain('id: other') // 其它条目不受影响
  })
  it('身份解析回归（复刻 dsh-plugin-package-inventory-deepseek 规则）：旧布局必须抛错，新布局在无 version 的 profile 下仍可解析', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      // 复刻上游两条规则（见 dsh-plugin-package-inventory-deepseek/lib/index.js）：
      // ① nearestManifest：从模块路径向上找最近的 package.json
      // ② identityFromManifest：非匿名时 name/version 必须非空，否则 throw
      const nearestManifest = (modulePath: string): string | undefined => {
        let current = dirname(modulePath)
        for (;;) {
          const candidate = join(current, 'package.json')
          if (existsSync(candidate)) return candidate
          const next = dirname(current)
          if (next === current) return undefined
          current = next
        }
      }
      const identityFromManifest = (manifestPath: string, allowAnonymous: boolean): { name: string; version: string } | undefined => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (allowAnonymous && manifest.name === undefined) return undefined
        if (
          typeof manifest.name !== 'string' || manifest.name.length === 0 ||
          typeof manifest.version !== 'string' || manifest.version.length === 0
        ) {
          throw new Error(`${manifestPath} must declare non-empty name and version`)
        }
        return { name: manifest.name, version: manifest.version }
      }
      // dsh initProfile 的模板：有 name、没有 version；离线模块属于 profile（allowAnonymous=true）
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')

      // 旧布局：.mjs 直接躺在 profile 根目录 → nearestManifest 命中 profile 清单 → 抛错（REQUEST_EXTENSION 根因）
      const legacyPath = join(dir, BRIDGE_FILENAME)
      writeFileSync(legacyPath, '// legacy bridge', 'utf8')
      const legacyManifest = nearestManifest(legacyPath)
      expect(legacyManifest).toBe(join(dir, 'package.json'))
      expect(() => identityFromManifest(legacyManifest as string, true)).toThrow(/non-empty name and version/)

      // 新布局：独立包目录 → nearestManifest 命中桥接自己的清单 → 解析成功，不依赖 profile 的 version
      writeBridgeFiles(home, '9.9.9')
      const packagedManifest = nearestManifest(bridgeModulePath(dir))
      expect(packagedManifest).toBe(join(bridgePackageDir(dir), 'package.json'))
      const identity = identityFromManifest(packagedManifest as string, true)
      expect(identity).toEqual({ name: BRIDGE_PACKAGE_NAME, version: '9.9.9' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('bridgePackageManifest：空版本回退为非空兜底值', () => {
    const parsed = JSON.parse(bridgePackageManifest('   ')) as { name?: string; version?: string }
    expect(parsed.name).toBe(BRIDGE_PACKAGE_NAME)
    expect((parsed.version ?? '').length).toBeGreaterThan(0)
  })
  it('幂等：再次写入 changed=false 且不重复追加条目', () => {
    const home = tempHome()
    try {
      writeBridgeFiles(home)
      const r2 = writeBridgeFiles(home)
      expect(r2.changed).toBe(false)
      const patch = readFileSync(join(webProfileDir(home), 'cordis.patch.yml'), 'utf8')
      // 仅一条 insert 条目（id 出现一次；文件名/注释中的同名字符串不算条目）
      expect((patch.match(/- id: dsh-obsidian-bridge/g) ?? []).length).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('清单缺 version：安装桥接时自动补上，且其余字段与键序原样保留', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
      writeFileSync(
        manifestPath,
        JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + '\n',
        'utf8',
      )
      writeBridgeFiles(home)
      const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      expect(after.version).toBe(PROFILE_MANIFEST_VERSION)
      // 键序：version 紧随 name；其余字段值不变
      expect(Object.keys(after)).toEqual(['name', 'version', 'private', 'dependencies', 'dsh'])
      expect((after.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual(bundles)
      expect(after.private).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('清单已有 version：保持原值，不被改写', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-profile-web', version: '9.9.9', private: true }) + '\n', 'utf8')
      writeBridgeFiles(home)
      expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version).toBe('9.9.9')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('合规清单的幂等：重复安装不产生新的写入', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-profile-web', private: true }) + '\n', 'utf8')
      writeBridgeFiles(home)
      const first = readFileSync(manifestPath, 'utf8')
      writeBridgeFiles(home)
      expect(readFileSync(manifestPath, 'utf8')).toBe(first)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('清单不存在：不凭空创建', () => {
    const home = tempHome()
    try {
      const manifestPath = join(webProfileDir(home), 'package.json')
      writeBridgeFiles(home)
      expect(existsSync(manifestPath)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('清单损坏：不抛错，桥接仍正常安装', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      writeFileSync(manifestPath, '{ 这不是 JSON\n', 'utf8')
      const r = writeBridgeFiles(home)
      expect(r.error).toBeUndefined()
      expect(r.changed).toBe(true)
      expect(existsSync(bridgeModulePath(dir))).toBe(true)
      // 损坏的清单保持原样，不被覆盖
      expect(readFileSync(manifestPath, 'utf8')).toBe('{ 这不是 JSON\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('内容哈希保险：旧插件写回的旧版文件会被当前源码覆盖恢复', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const file = bridgeModulePath(dir)
      // 先写入当前正确桥接
      writeBridgeFiles(home)
      const correct = readFileSync(file, 'utf8')
      expect(correct).toContain('pathOf')
      // 模拟内存旧插件用旧代码把文件覆盖回旧版（无 pathOf）
      writeFileSync(file, '// OLD_BRIDGE_NO_PATHOF\nexport const name = "old"', 'utf8')
      // 再次调用：因内容与当前源码不一致，应重写回正确版本
      const r = writeBridgeFiles(home)
      const restored = readFileSync(file, 'utf8')
      expect(restored).toContain('pathOf')
      expect(restored).not.toContain('OLD_BRIDGE_NO_PATHOF')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('内容哈希保险：文件已是最新时不再重复写入', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      writeBridgeFiles(home)
      const file = bridgeModulePath(dir)
      const first = readFileSync(file, 'utf8')
      writeBridgeFiles(home)
      const second = readFileSync(file, 'utf8')
      expect(second).toBe(first)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('合并已有块式条目补丁：末尾追加且保持合法', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'cordis.patch.yml'),
        '# 已有用户补丁\n- disabled: true\n  id: some-other\n',
        'utf8',
      )
      const r = writeBridgeFiles(home)
      expect(r.changed).toBe(true)
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain('- disabled: true')
      expect(patch).toContain(BRIDGE_ENTRY_ID)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('模板空数组（[]）时替换为块式条目', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'cordis.patch.yml'),
        '# Your patch layer for this dsh profile\n[]\n',
        'utf8',
      )
      const r = writeBridgeFiles(home)
      expect(r.changed).toBe(true)
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).not.toMatch(/\[\s*\]/)
      expect(patch).toContain('- insert:')
      expect(patch).toContain(BRIDGE_ENTRY_ID)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('isBridgeInstalled', () => {
  it('写入后为 true，空 home 为 false', () => {
    const home = tempHome()
    try {
      expect(isBridgeInstalled(home)).toBe(false)
      writeBridgeFiles(home)
      expect(isBridgeInstalled(home)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('kbdMatch（iframe 快捷键透传匹配，与桥接脚本同逻辑）', () => {
  it('Ctrl+O：命中仅 ctrl+o，不命中无 ctrl 或键不符', () => {
    expect(kbdMatch({ ctrlKey: true, key: 'o' }, 'ctrl+o')).toBe(true)
    expect(kbdMatch({ ctrlKey: true, key: 'O' }, 'ctrl+o')).toBe(true)
    expect(kbdMatch({ ctrlKey: false, key: 'o' }, 'ctrl+o')).toBe(false)
    expect(kbdMatch({ ctrlKey: true, key: 'p' }, 'ctrl+o')).toBe(false)
  })
  it('Ctrl+：符号键（comma）匹配', () => {
    expect(kbdMatch({ ctrlKey: true, key: ',' }, 'ctrl+,')).toBe(true)
    expect(kbdMatch({ ctrlKey: true, key: 'o' }, 'ctrl+,')).toBe(false)
  })
  it('meta（macOS Cmd）与 alt 组合', () => {
    expect(kbdMatch({ metaKey: true, key: 'o' }, 'meta+o')).toBe(true)
    expect(kbdMatch({ ctrlKey: true, metaKey: true, key: 'o' }, 'ctrl+o')).toBe(false)
    expect(kbdMatch({ altKey: true, key: 'x' }, 'alt+x')).toBe(true)
  })
  it('空 key 或空事件不匹配', () => {
    expect(kbdMatch({ ctrlKey: true, key: 'o' }, '')).toBe(false)
    expect(kbdMatch(null as never, 'ctrl+o')).toBe(false)
  })
})

describe('hotkeyToPassthroughKey（Obsidian hotkey → 透传键，Mod 归一）', () => {
  it('Mod 在 Windows/Linux 归一为 ctrl（properties 的 Mod+; → ctrl+;）', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'win32')).toBe('ctrl+;')
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: 'o' }, 'linux')).toBe('ctrl+o')
  })
  it('Mod 在 darwin 归一为 meta', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'darwin')).toBe('meta+;')
  })
  it('Ctrl/Shift/Alt 组合保留', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Ctrl', 'Shift'], key: 'p' }, 'win32')).toBe('ctrl+shift+p')
    expect(hotkeyToPassthroughKey({ modifiers: ['Alt'], key: 'ArrowLeft' }, 'win32')).toBe('alt+arrowleft')
  })
  it('无修饰单键返回 null（不干扰 DSH 输入）', () => {
    expect(hotkeyToPassthroughKey({ modifiers: [], key: 'e' }, 'win32')).toBeNull()
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'win32')).not.toBeNull()
  })
  it('空 key 返回 null', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Ctrl'], key: '' }, 'win32')).toBeNull()
    expect(hotkeyToPassthroughKey(undefined as never, 'win32')).toBeNull()
  })
  it('归一后的 ctrl+; 能被 kbdMatch 匹配（端到端链路）', () => {
    const key = hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'win32')
    expect(key).toBe('ctrl+;')
    expect(kbdMatch({ ctrlKey: true, key: ';' }, key as string)).toBe(true)
  })
})

describe('intruded（v2.5.1 hotfix：用户改动判定＝内容比对，与桥接脚本同源）', () => {
  /** 用页面脚本同源串构造判定函数（want=目标串归一文本，base=写入前归一文本，txt=当前内容）。 */
  function makeIntruded(want: string, base: string, now: string): boolean {
    const fn = new Function(
      'normWs',
      'txt',
      'want',
      'base',
      `${INTRUDED_SOURCE}; return intruded()`,
    ) as (n: (s: string) => string, t: () => string, w: string, b: string) => boolean
    const normWs = (s: string): string => String(s).replace(/\s+/g, '')
    return fn(normWs, () => now, want, base)
  }
  const lineA = '[ BRIDGES is delivering packages for you…… · 5 words · L1:1-L2:3 · D:\\vault\\a.md · ]'
  const lineB = '[ BRIDGES is delivering packages for you…… · 5 words · L9:1-L10:3 · D:\\vault\\b.md · ]'
  it('空输入框 / 本次目标串的分阶段中间态 / 写入前原内容 → 不算用户改动', () => {
    const want = `${lineB}\n用户文字`.replace(/\s+/g, '')
    const base = `${lineA}\n用户文字`.replace(/\s+/g, '')
    expect(makeIntruded(want, base, '')).toBe(false) // 清空阶段（空）
    expect(makeIntruded(want, base, lineB)).toBe(false) // 只写了行（目标串的前缀）
    expect(makeIntruded(want, base, `${lineB}\n`)).toBe(false) // 行 + 段落
    expect(makeIntruded(want, base, `${lineB}\n用户文字`)).toBe(false) // 写完（= 目标串）
    expect(makeIntruded(want, base, base)).toBe(false) // 清空失败：仍是写入前原内容
  })
  it('用户新输入的文字 → 判定为被改动（不得回写旧快照）', () => {
    const want = `${lineB}\n用户文字`.replace(/\s+/g, '')
    const base = `${lineA}\n用户文字`.replace(/\s+/g, '')
    expect(makeIntruded(want, base, `${lineB}\n用户文字新敲的字`)).toBe(true)
    expect(makeIntruded(want, base, '新敲的字')).toBe(true)
    expect(makeIntruded(want, base, `${lineA}\n用户文字新敲的字`)).toBe(true)
  })
  it('取消框选（目标串＝保留用户文字）也按同一口径判定', () => {
    const want = '用户文字'.replace(/\s+/g, '')
    const base = `${lineA}\n用户文字`.replace(/\s+/g, '')
    expect(makeIntruded(want, base, '')).toBe(false) // 清空中
    expect(makeIntruded(want, base, '\n')).toBe(false) // 只留了段落（归一后为空）
    expect(makeIntruded(want, base, '用户文字')).toBe(false) // 清干净（目标串）
    expect(makeIntruded(want, base, '用户文字又加了字')).toBe(true)
  })
  it('页面脚本内联同源（parity）：桥接脚本不含事件计数守卫，且含内容比对判定', () => {
    const s = bridgeScriptSource()
    expect(s).toContain(INTRUDED_SOURCE)
    expect(s).not.toContain('__dshEditSeq')
    expect(s).not.toContain("addEventListener('beforeinput',bump")
  })
})

describe('kbdLocalOnly（v2.5.1 编辑键不外发，与桥接脚本 editKey 同逻辑）', () => {  it('Backspace/Delete/Enter/Tab/Esc 留在 iframe（DSH 自己处理）', () => {
    for (const key of ['Backspace', 'Delete', 'Enter', 'Tab', 'Escape']) {
      expect(kbdLocalOnly({ key })).toBe(true)
      // 带 Ctrl 也必须留（Ctrl+Backspace 删词、Ctrl+Enter 等）
      expect(kbdLocalOnly({ ctrlKey: true, key })).toBe(true)
    }
  })
  it('光标/翻页键留在 iframe', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(kbdLocalOnly({ key })).toBe(true)
    }
  })
  it('撤销/重做/全选/复制/剪切/粘贴留在 iframe（用户报的 3 个症状的直接原因）', () => {
    for (const key of ['z', 'y', 'a', 'c', 'v', 'x', 'Z', 'Y', 'A', 'C', 'V', 'X']) {
      expect(kbdLocalOnly({ ctrlKey: true, key })).toBe(true)
      expect(kbdLocalOnly({ metaKey: true, key })).toBe(true)
    }
    expect(kbdLocalOnly({ ctrlKey: true, key: 'Insert' })).toBe(true)
  })
  it('Obsidian 全局快捷键仍走透传（Ctrl+O/P/, 等不被拦住）', () => {
    for (const key of ['o', 'p', ',', ';', 'k']) {
      expect(kbdLocalOnly({ ctrlKey: true, key })).toBe(false)
    }
    expect(kbdLocalOnly({ key: 'e' })).toBe(false)
    expect(kbdLocalOnly({ ctrlKey: true, altKey: true, key: 'ArrowLeft' })).toBe(true) // 编辑键优先
  })
  it('桥接脚本内嵌 editKey 与 TS 版判定集合一致（parity）', () => {
    const s = bridgeScriptSource()
    for (const k of ['backspace', 'delete', 'enter', 'tab', 'escape', 'insert']) {
      expect(s).toContain(`k==='${k}'`)
      expect(kbdLocalOnly({ ctrlKey: true, key: k })).toBe(true)
    }
    expect(s).toContain("if(k.indexOf('arrow')===0||k==='home'||k==='end'||k==='pageup'||k==='pagedown')return true")
    expect(s).toContain('if(!e.ctrlKey&&!e.metaKey)return false')
  })
})

describe('parseBridgeLine（BRIDGES 隐式行解析，与内联 pre-step 同逻辑）', () => {
  const line = '[ BRIDGES is delivering packages for you…… · 252 words · L2:1-L7:23 · D:\\Software\\Obsidian\\01 inbox\\20260701 2026Q2绩效考核.md · ]'
  it('跨行选区：路径/坐标/指令均正确提取', () => {
    const r = parseBridgeLine(`${line}\n在这段文字下做一句话总结`)
    expect(r).not.toBeNull()
    expect(r?.path).toBe('D:\\Software\\Obsidian\\01 inbox\\20260701 2026Q2绩效考核.md')
    expect(r?.fromLine).toBe(2)
    expect(r?.fromCh).toBe(1)
    expect(r?.toLine).toBe(7)
    expect(r?.toCh).toBe(23)
    expect(r?.instruction).toBe('在这段文字下做一句话总结')
  })
  it('单行选区', () => {
    const r = parseBridgeLine('[ BRIDGES is delivering packages for you…… · 3 words · L5:2-L5:10 · a.md · ]')
    expect(r?.fromLine).toBe(5)
    expect(r?.toLine).toBe(5)
  })
  it('无指令时 instruction 为空串', () => {
    const r = parseBridgeLine('[ BRIDGES is delivering packages for you…… · 0 words · L1:1-L1:1 · a.md · ]')
    expect(r?.instruction).toBe('')
  })
  it('非隐式行返回 null', () => {
    expect(parseBridgeLine('普通文本')).toBeNull()
    expect(parseBridgeLine('')).toBeNull()
  })
})

describe('bridgeEditInjectSource（pre-step 编辑指令注入）', () => {
  const implicitLine = '[ BRIDGES is delivering packages for you…… · 29 words · L30:273-L30:431 · D:\\vault\\a.md · ]'

  interface InjectFn {
    (i: { messages: unknown[]; pending?: unknown[]; nodes?: unknown[]; sessionKey?: string }): {
      action: string
      reason: string
      msg: Record<string, unknown> | null
    }
  }

  /**
   * 在 vm 中执行**真·内联**注入代码（不是字符串断言）：补齐 node 内置依赖，
   * 并把 `import.meta.url` 指向临时目录，让台账真的落盘（用于验证跨 step 去重）。
   */
  async function loadInject(dir: string, withLedger: boolean): Promise<InjectFn> {
    const sandbox = await loadInjectEx(dir, withLedger)
    return sandbox.bridgeEditMaybeInject as InjectFn
  }

  /** 同上，但返回整个 vm sandbox（可访问 bridgeWikilinkRule 等内部函数）。 */
  async function loadInjectEx(dir: string, withLedger: boolean): Promise<Record<string, unknown>> {
    const vm = await import('node:vm')
    const url = pathToFileURL(join(dir, 'index.mjs')).href
    const src = bridgeEditInjectSource().replace(/import\.meta\.url/g, JSON.stringify(url))
    const sandbox: Record<string, unknown> = withLedger
      ? {
          crypto: globalThis.crypto,
          createHash,
          existsSync,
          mkdirSync,
          readFileSync,
          writeFileSync,
          statSync,
          appendFileSync,
          join,
          dirname,
          fileURLToPath,
          console,
        }
      : {}
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox, { timeout: 5000 })
    return sandbox
  }

  it('含 pre-step 注入所需标记与防重复逻辑', () => {
    const s = bridgeEditInjectSource()
    expect(s).toContain('dsh-obsidian-bridge')
    // source.form 必须落在 dsh 冻结清单内，否则 0.1.5 的会话格式迁移会拒收整个会话
    expect(s).toContain("form: 'notice'")
    // v2.7.1：v4 起 source.kind 必须是生产者自己的名字——通用 'plugin' 会被
    // dsh-session-format-v3-to-v4 的 source() 硬拒（format v4 message requires a
    // producer-owned source kind），且读写两条路径都过这道闸。
    expect(s).toContain('BRIDGE_SOURCE_KIND')
    expect(s).toContain("'plugin:dsh-obsidian-bridge'")
    expect(s).not.toContain("kind: 'plugin',")
    expect(s).toContain('summary')
    expect(s).toContain('fs read')
    expect(s).toContain('fs edit')
    expect(s).toContain('是否同意')
    expect(s).toContain('BRIDGE_LINE_RE')
  })
  it('注入的消息自带 id 与 role（缺任一都会让会话读不出来）', async () => {
    const s = bridgeEditInjectSource()
    expect(s).toContain('bridgeMessageId')
    expect(s).toContain("role: 'user'")
    // 真正执行生成的内联代码，取出注入结果（而非仅字符串断言）
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-id-'))
    try {
      const inject = await loadInject(dir, true)
      const res = inject({ messages: [{ role: 'user', content: [{ type: 'text', text: '请处理 ' + implicitLine }] }] })
      expect(res.action).toBe('inject')
      const msg = res.msg
      expect(msg).not.toBeNull()
      // dsh 的 assertMessageEventShape：id 必须是非空字符串
      expect(typeof msg?.id).toBe('string')
      expect(String(msg?.id).length).toBeGreaterThan(0)
      // 落盘后成为 user/message，role 必须是 'user'
      expect(msg?.role).toBe('user')
      // 原有字段不受影响；v2.7.1 起 kind 换成生产者自己的名字（见上方用例）
      expect(msg?.source).toMatchObject({ kind: 'plugin:dsh-obsidian-bridge', form: 'notice' })
      expect(msg?.source).not.toHaveProperty('plugin')
      expect(Array.isArray(msg?.content)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('无 crypto 时 id 仍有兜底（不退化为空串）', async () => {
    const vm = await import('node:vm')
    const sandbox: Record<string, unknown> = {}
    vm.createContext(sandbox)
    vm.runInContext(
      bridgeEditInjectSource().replace(/import\.meta\.url/g, JSON.stringify('file:///nonexistent/index.mjs')),
      sandbox,
      { timeout: 5000 },
    )
    const inject = sandbox.bridgeEditMaybeInject as (i: { messages: unknown[] }) => { action: string; msg: { id?: unknown } | null }
    const res = inject({ messages: [{ role: 'user', content: [{ type: 'text', text: implicitLine }] }] })
    expect(typeof res.msg?.id).toBe('string')
    expect(String(res.msg?.id).length).toBeGreaterThan(0)
  })
  it('未命中隐式行时不注入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-none-'))
    try {
      const inject = await loadInject(dir, true)
      const res = inject({ messages: [{ role: 'user', content: [{ type: 'text', text: '普通提问，无隐式行' }] }] })
      expect(res.action).toBe('skip')
      expect(res.msg).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  // v2.7.1：窗口去重（windowHasInject）原本只按 source.plugin 认自己的消息。
  // v4 换了 kind，且迁移重写会删掉 plugin 字段（只保留非身份字段）⇒ 两种形态都得认，
  // 否则去重静默失效（本用例此前无覆盖，属改动带出的耦合点）。
  it('回归（v2.7.1）：窗口去重同时认新 kind 与迁移前的 plugin 字段', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-window-'))
    try {
      const inject = await loadInject(dir, true)
      const asked = { role: 'user', content: [{ type: 'text', text: implicitLine }] }
      // ① 本插件现在发的形态（也是 v4 迁移链给第三方插件的兜底形态）
      const newer = { role: 'user', source: { kind: 'plugin:dsh-obsidian-bridge', form: 'notice', summary: 'x' }, content: [] }
      expect(inject({ messages: [newer, asked] })).toMatchObject({ action: 'skip', reason: 'window' })
      // ② 迁移前落盘的形态（v3 及更早：带 plugin 字段）
      const legacy = { role: 'user', source: { kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'notice', summary: 'x' }, content: [] }
      expect(inject({ messages: [legacy, asked] })).toMatchObject({ action: 'skip', reason: 'window' })
      // ③ 别家插件的来源不该拦住本插件（防误判成"窗口里已有注入"）
      const other = { role: 'user', source: { kind: 'plugin:other', form: 'notice', summary: 'x' }, content: [] }
      expect(inject({ messages: [other, asked] }).action).toBe('inject')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  // ---- v2.4.4：治「多次框选 → DSH 崩溃」的三层去重 + 熔断（跑真·内联代码）----
  it('回归：窗口已空（模拟上下文被压缩）时，同选区第二次不再注入 → skip/ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-ledger-'))
    try {
      const inject = await loadInject(dir, true)
      const step = { messages: [{ role: 'user', content: [{ type: 'text', text: implicitLine }] }] }
      const first = inject(step)
      expect(first.action).toBe('inject')
      // 模拟 compaction/prune 把注入消息裁出窗口：messages 里不再有本插件注入
      const second = inject(step)
      expect(second).toMatchObject({ action: 'skip', reason: 'ledger' })
      const third = inject(step)
      expect(third).toMatchObject({ action: 'skip', reason: 'ledger' })
      // 台账确实落盘（跨进程/跨 step 持久）；决策日志也落盘（诊断用）
      expect(readdirSync(dir)).toContain('inject-ledger.json')
      expect(readdirSync(dir)).toContain('inject-log.jsonl')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('inbox pending / session surface 已有等价载荷 → skip/pending|surface（不重复投递）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-pending-'))
    try {
      const inject = await loadInject(dir, true)
      const messages = [{ role: 'user', content: [{ type: 'text', text: implicitLine }] }]
      const sig = '[BRIDGES 编辑指令] D:\\vault\\a.md · L30:273-L30:431'
      expect(inject({ messages, pending: [{ source: { summary: sig } }] })).toMatchObject({ action: 'skip', reason: 'pending' })
      expect(inject({ messages, nodes: [{ source: { summary: sig } }] })).toMatchObject({ action: 'skip', reason: 'surface' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('单会话注入达上限 → skip/caps 并写下 storm 标记（插件侧据此提示用户）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-caps-'))
    try {
      const inject = await loadInject(dir, true)
      let injected = 0
      for (let i = 0; i < 25; i++) {
        const line = `[ BRIDGES is delivering packages for you…… · 3 words · L${String(i + 1)}:1-L${String(i + 1)}:9 · D:\\vault\\a.md · ]`
        const res = inject({ messages: [{ role: 'user', content: [{ type: 'text', text: line }] }], sessionKey: 'cap-session' })
        if (res.action === 'inject') injected += 1
        else expect(res.reason).toBe('caps')
      }
      expect(injected).toBe(20)
      const ledger = JSON.parse(readFileSync(join(dir, 'inject-ledger.json'), 'utf8')) as { storm?: { session?: string } }
      expect(ledger.storm?.session).toBe('cap-session')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('桥接插件模板用 DSH 原生 inbox 一次性投递，并带台账/限流/node imports', () => {
    const p = bridgePluginSource()
    expect(p).toContain("agent.inbox.prepend('next-step'")
    expect(p).toContain('Array.isArray(agent.inbox.nextStep)')
    expect(p).toContain("import { createHash } from 'node:crypto'")
    expect(p).toContain("from 'node:url'")
    const s = bridgeEditInjectSource()
    expect(s).toContain('inject-ledger.json')
    expect(s).toContain('inject-log.jsonl')
    expect(s).toContain('maxSessionInjections')
    expect(s).toContain("reason: 'caps'")
    expect(s).toContain("reason: 'pending'")
    expect(s).toContain("reason: 'surface'")
    expect(s).toContain('bridgeSaveLedger')
  })
  it('生成的 source.form 落在 dsh 允许清单内', async () => {    const s = bridgeEditInjectSource()
    const m = /form: '([^']+)'/.exec(s)
    expect(m).not.toBeNull()
    expect(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])
      .toContain(m?.[1])
    // notice 形态必须带 summary
    if (m?.[1] === 'notice') expect(s).toContain('summary')
  })
  it('可解析（esbuild 级语法校验）', async () => {
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(bridgeEditInjectSource(), { loader: 'js' })).not.toThrow()
  })
  it('桥接插件源码含 pre-step 注册且语法有效', async () => {
    const s = bridgePluginSource()
    expect(s).toContain("ctx.on('agent/pre-step'")
    expect(s).toContain('bridgeEditMaybeInject')
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(s, { loader: 'js' })).not.toThrow()
  })
  // ---- v2.5.0：对话里的 [[wikilink]] 渲染 + 点击跳转 + 每会话一次的 Agent 约定 ----
  it('v2.5.0 编辑指令含「双链约定」；约定指令每会话只投递一次', async () => {
    const s = bridgeEditInjectSource()
    expect(s).toContain('[[笔记名]]')
    expect(s).toContain('function bridgeWikilinkRule')
    expect(bridgePluginSource()).toContain('bridgeWikilinkRule')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wiki-rule-'))
    try {
      const sandbox = await loadInjectEx(dir, true)
      const rule = sandbox.bridgeWikilinkRule as (key: string) => {
        id?: unknown
        source?: { form?: string }
        content?: unknown
      } | null
      const first = rule('sess-A')
      expect(first).not.toBeNull()
      expect(String(first?.id ?? '').length).toBeGreaterThan(0)
      // 与编辑指令同一形态（notice + summary，落在 dsh 冻结清单内）
      expect(first?.source?.form).toBe('notice')
      expect(Array.isArray(first?.content)).toBe(true)
      expect(rule('sess-A')).toBeNull() // 同会话不重复投递
      expect(rule('sess-B')).not.toBeNull() // 新会话再投一次
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('parseWikilinks：目标/别名/路径/锚点/边界', () => {
    expect(parseWikilinks('见 [[笔记]] 与 [[文件夹/笔记|别名]]')).toEqual([
      { target: '笔记', alias: '笔记' },
      { target: '文件夹/笔记', alias: '别名' },
    ])
    expect(parseWikilinks('[[笔记#标题|看这段]]')).toEqual([{ target: '笔记#标题', alias: '看这段' }])
    expect(parseWikilinks('[[   ]]')).toEqual([]) // 空目标忽略
    expect(parseWikilinks('[[a]] 普通 [b] 与 [](x)')).toEqual([{ target: 'a', alias: 'a' }])
    expect(parseWikilinks('没有双链')).toEqual([])
    // 多行/超长目标不误判
    expect(parseWikilinks('[[a\nb]]')).toEqual([])
    expect(parseWikilinks(`[[${'x'.repeat(201)}]]`)).toEqual([])
  })
  it('v2.5.0 页面脚本：注解 [[wikilink]]、跳过代码/输入框、点击回传父页；且路径点击不再无谓吞掉', () => {
    const s = bridgeScriptSource()
    // 注解器与样式（样式必须注入 iframe 内文档——插件 styles.css 不作用于 dsh web 页面）
    expect(s).toContain('function wlAnnotate')
    expect(s).toContain('function wlSkip')
    expect(s).toContain("t==='code'||t==='pre'")
    expect(s).toContain('isContentEditable')
    expect(s).toContain('MutationObserver')
    expect(s).toContain('dsh-wl-css')
    expect(s).toContain('data-wikilink')
    // 与 TS 侧共用同一正则源（parity）
    expect(s).toContain(WIKILINK_SOURCE)
    // 点击 → 回传父页（插件侧再用 Obsidian API 打开）
    expect(s).toContain("postMessage({type:'dsh-wikilink',target:t}")
    // 回归：旧的"先 preventDefault 再解析"会吞掉 [[路径|别名]] 的点击
    expect(s).not.toContain('e.preventDefault();e.stopPropagation();var r=resolveTxt(txt);')
    expect(s).toContain('if(r&&readable(r)){e.preventDefault();e.stopPropagation();')
  })
})

describe('mergeFillText（隐式行置顶 + 保留用户输入，与内联 mergeFill 同逻辑）', () => {
  const line = '[ BRIDGES is delivering packages for you…… · 128 words · L12:5-L13:3 · D:\\vault\\a.md · ]'
  it('空框 + 隐式行 → 隐式行', () => {
    expect(mergeFillText('', line)).toBe(line)
  })
  it('框已有用户输入 + 隐式行 → 隐式行置顶、用户输入保留（不覆盖）', () => {
    expect(mergeFillText('请帮我总结这段', line)).toBe(`${line}\n请帮我总结这段`)
  })
  it('已有旧隐式行 + 用户输入，注入新隐式行 → 新行替换旧行、用户输入保留（防堆叠）', () => {
    const newLine = '[ BRIDGES is delivering packages for you…… · 7 words · L2:1-L2:8 · D:\\vault\\b.md · ]'
    const existing = `${line}\n请帮我总结这段`
    expect(mergeFillText(existing, newLine)).toBe(`${newLine}\n请帮我总结这段`)
  })
  it('空串清除：仅移除隐式行，保留用户输入', () => {
    expect(mergeFillText(`${line}\n请帮我总结这段`, '')).toBe('请帮我总结这段')
  })
  it('空串清除且框内只有用户输入（无隐式行）→ 原样保留（不误删用户文字）', () => {
    expect(mergeFillText('用户手输内容', '')).toBe('用户手输内容')
  })
  it('用户多行输入保留，删除隐式行产生的连续空行压缩为单个', () => {
    const existing = `${line}\n\n\n第一行\n\n第二行`
    expect(mergeFillText(existing, '')).toBe('第一行\n\n第二行')
  })
  it('v2.5.2 幂等短路判据：目标与当前内容归一后一致 → 不写（长会话下父页高频重发同一草稿时不再反复重写聊天框）', () => {
    const norm = (s: string): string => s.replace(/\s+/g, '')
    const skip = (cur: string, incoming: string): boolean => norm(cur) === norm(mergeFillText(cur, incoming))
    // 同一份草稿重发（隐式行已在框内）→ 跳过，绝不"清空→重写"
    expect(skip(`${line}\n请帮我总结这段`, line)).toBe(true)
    expect(skip(line, line)).toBe(true)
    expect(skip('', '')).toBe(true)
    // 目标确有变化 → 必须写
    expect(skip('请帮我总结这段', line)).toBe(false) // 还没注入
    expect(skip(`${line}\n请帮我总结这段`, '')).toBe(false) // 取消框选：需要清掉隐式行
    expect(skip(`${line}\n请帮我总结这段`, '[ BRIDGES is delivering packages for you…… · 7 words · L2:1-L2:8 · D:\\vault\\b.md · ]')).toBe(false)
  })
})

describe('v2.8.0 setDraft 快路径（官方模型层写入 ⇒ 框选即出现、不抢焦点）', () => {
  const LINE = '[ BRIDGES is delivering packages for you…… · 12 words · L2:1-L2:9 · D:\\vault\\a.md · ]'
  type Sent = Record<string, unknown> & { type?: string; text?: string; note?: string; sd?: boolean; ok?: boolean }

  /**
   * textarea/input 的 `value` 访问器。**必须做成元素的原型**（`Object.create`），
   * 光挂到 `window.HTMLTextAreaElement.prototype` 不够——`el.value` 读的是元素自己的原型链，
   * 只挂 window 上会让页面脚本读到 `''`（本轮踩到：合并基线整个算错）。
   */
  const valueProto = {
    get value(): string {
      return String((this as { _v?: string })._v ?? '')
    },
    set value(v: string) {
      ;(this as { _v?: string })._v = v
    },
  }

  /** contentEditable 输入框（DSH 0.1.3+）：DOM 路径必须 focus 它，故记次数——快路径下必须为 0。 */
  function makeEditable(initial: string): Record<string, unknown> {
    const el: Record<string, unknown> = {
      tagName: 'DIV',
      isContentEditable: true,
      disabled: false,
      offsetParent: {},
      innerText: initial,
      focusCount: 0,
      contains: () => false,
      focus() {
        el.focusCount = (el.focusCount as number) + 1
      },
    }
    return el
  }

  /** legacy textarea：DOM 路径走 fieldSet（同步、不依赖 focus），便于干净地断言"确实没走快路径"。 */
  function makeTextarea(initial: string): Record<string, unknown> {
    const el = Object.create(valueProto) as Record<string, unknown>
    el.tagName = 'TEXTAREA'
    el.readOnly = false
    el.disabled = false
    el.dispatchEvent = () => true
    el._v = initial
    return el
  }

  /** 跑一次页面脚本并模拟宿主下发一次草稿；返回捕获到的回传消息与 window。 */
  function run(opts: {
    el: Record<string, unknown>
    activeElement?: unknown
    /** 提供则等价于"客户端半已激活、官方 setDraft 可用"。 */
    setDraft?: (text: string) => boolean
  }): { sent: Sent[]; win: Record<string, unknown>; listeners: Record<string, (e: unknown) => void> } {
    const sent: Sent[] = []
    const parentStub = { postMessage: (m: Sent) => void sent.push(m), focus: () => undefined }
    const listeners: Record<string, (e: unknown) => void> = {}
    const win: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      __DSH_EMBED_TOKEN__: '', // 非空会启用嵌入认证适配器分支，与本用例无关
      top: { frameElement: null }, // ≠ self ⇒ iframe 场景（能力上报才发）
      parent: parentStub,
      location: { origin: 'http://127.0.0.1:3199', href: 'http://127.0.0.1:3199/' },
      addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn),
      HTMLTextAreaElement: { prototype: valueProto },
      HTMLInputElement: { prototype: valueProto },
    }
    win.self = win
    if (opts.setDraft) win.__DSH_BRIDGE_SET_DRAFT__ = opts.setDraft
    const isField = opts.el.tagName === 'TEXTAREA' || opts.el.tagName === 'INPUT'
    const documentStub = {
      querySelector: () => (isField ? opts.el : null),
      querySelectorAll: () => (isField ? [] : [opts.el]),
      activeElement: opts.activeElement ?? {},
      addEventListener: () => undefined,
      body: { addEventListener: () => undefined },
      getElementById: () => null,
    }
    new Function('window', 'document', 'Event', 'location', bridgeScriptSource())(win, documentStub, class {}, win.location)
    listeners.message?.({ source: parentStub, data: { type: 'dsh-fill-draft', text: LINE } })
    return { sent, win, listeners }
  }

  const ackOf = (sent: Sent[]): Sent | undefined => sent.filter((m) => m.type === 'dsh-fill-ack').pop()

  it('三条件齐备：调用 setDraft(合并串)、**一次也不碰焦点**、ACK 带 sd=true 且 note=setdraft', async () => {
    const el = makeEditable('')
    const calls: string[] = []
    const { sent } = run({
      el,
      setDraft: (text) => {
        calls.push(text)
        el.innerText = text // 模拟 Lexical 模型层写入落到 DOM
        return true
      },
    })
    // 同步段：官方接口已被调用一次，且**没有** el.focus()（这正是"不抢键盘焦点"的实现）
    expect(calls).toEqual([LINE])
    expect(el.focusCount).toBe(0)
    await new Promise((r) => setTimeout(r, 250))
    const ack = ackOf(sent)
    expect(ack?.note).toBe('setdraft')
    expect(ack?.sd).toBe(true)
    expect(ack?.had).toBe(false)
    expect(ack?.ok).toBe(true)
    expect(el.focusCount).toBe(0) // 全流程都未抢焦点
  })

  it('模型层写入没落到 DOM → 重读当前内容后**退回 DOM 路径**（note=setdraft-dom），不留假成功', async () => {
    const el = makeEditable('')
    const { sent } = run({ el, setDraft: () => true }) // 返回 true 但 DOM 不变（官方改口径/异步未落地）
    await new Promise((r) => setTimeout(r, 1500))
    const ack = ackOf(sent)
    expect(ack?.note).toBe('setdraft-dom')
    expect(ack?.sd).toBe(false)
    expect(el.focusCount).toBeGreaterThan(0) // 退回 DOM 路径后才会 focus
  })

  it('框内已有用户文字 → 绝不走整体替换（setDraft 一个字都不调），保持原有定向路径', () => {
    const el = makeTextarea('用户文字')
    const calls: string[] = []
    const { sent } = run({ el, setDraft: (t) => (calls.push(t), true) })
    expect(calls).toEqual([])
    const ack = ackOf(sent)
    expect(ack?.note).toBe('field')
    expect(ack?.sd).toBe(false)
    expect(el._v).toBe(`${LINE}\n用户文字`) // 合并语义不变：隐式行置顶、用户文字保留
  })

  it('焦点已在聊天框内 → 不走快路径（DOM 定向替换只换隐式行那一小段，更安全）', () => {
    const el = makeTextarea('')
    const calls: string[] = []
    const { sent } = run({ el, activeElement: el, setDraft: (t) => (calls.push(t), true) })
    expect(calls).toEqual([])
    expect(ackOf(sent)?.note).toBe('field')
  })

  it('官方接口不存在（客户端半未激活 / dom 模式）→ 退回 DOM 路径，行为与旧版一致', () => {
    const el = makeTextarea('')
    const { sent } = run({ el })
    const ack = ackOf(sent)
    expect(ack?.note).toBe('field')
    expect(ack?.sd).toBe(false)
    expect(el._v).toBe(LINE)
  })

  it('能力上报 dsh-bridge-cap：仅当官方接口可用时向宿主申报（宿主据此撤掉焦点门控）', () => {
    const withApi = run({ el: makeTextarea(''), setDraft: () => true })
    expect(withApi.win.__dshCapSent).toBe(true)
    expect(withApi.sent.filter((m) => m.type === 'dsh-bridge-cap')).toEqual([
      expect.objectContaining({ setDraft: true }),
    ])
    const withoutApi = run({ el: makeTextarea('') })
    expect(withoutApi.win.__dshCapSent).toBeUndefined()
    expect(withoutApi.sent.filter((m) => m.type === 'dsh-bridge-cap')).toEqual([])
  })

  it('源码标记：快路径插在 DOM 路径之前，三道门与 ACK 复核齐全；客户端半暴露 setDraft 能力位', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('function trySetDraft(el,cur,line,merged,hadFocus){')
    // 三道门：焦点不在框内 / 框内无用户文字 / 官方接口存在
    expect(s).toContain('if(hadFocus)return false;')
    expect(s).toContain("if(stripBridge(cur)!=='')return false;")
    expect(s).toContain("var sd=window.__DSH_BRIDGE_SET_DRAFT__;if(typeof sd!=='function')return false;")
    // 快路径必须先于 DOM 两条路被尝试（否则"框选即出现"永远轮不到）
    const iTry = s.indexOf('if(trySetDraft(el,cur,text,merged,hadFocus))return;')
    expect(iTry).toBeGreaterThan(0)
    expect(iTry).toBeLessThan(s.indexOf("fieldSet(el,merged);fillAck(true,false,hadFocus,'field')"))
    expect(iTry).toBeLessThan(s.indexOf("fillAck(ok,sep,hadFocus,'edit')"))
    // 复核用共享判据 bridgeOk（与 DOM 路径同一事实源），且已上提到顶层（两个使用者）
    expect(s.indexOf('function bridgeOk(t,line,restBefore)')).toBeLessThan(s.indexOf('function editFill('))
    // 读文本的 txtOf 也必须上提（editFill 内的 txt() 只是它的闭包别名）——
    // 否则定时器里读文本会 ReferenceError，整条快路径静默失败（本轮实测踩到）
    expect(s.indexOf('function txtOf(node)')).toBeGreaterThan(0)
    expect(s.indexOf('function txtOf(node)')).toBeLessThan(s.indexOf('function editFill('))
    expect(s).toContain('function txt(){return txtOf(el)}')
    // 返回值契约：快路径的第三道门后还有 `if(!sd(merged))return false;`，
    // 故客户端半的包装**必须显式 return true**（仅抛异常时 false）。
    // 若哪天改成隐式 undefined，整条 P1 会静默退回 DOM 路径而上面所有断言仍绿——
    // 正是本仓库最怕的"测了存在性、没测可用性"（A3 教训）。
    expect(s).toContain('if(!sd(merged))return false;')
    // 客户端半：能力位与宿主回报字段
    const c = bridgeClientSource()
    expect(c).toContain('window.__DSH_BRIDGE_SET_DRAFT__')
    expect(c).toContain('actions.setDraft(String(text)); return true')
    expect(c).toContain('setDraft: ok')
  })
})

describe('bridgeScriptSource 合并填充标记', () => {
  it('注入脚本含 mergeFill 与 BRIDGE_LINE_RE，且不直接覆盖 value', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('mergeFill')
    expect(s).toContain('BRIDGE_LINE_RE')
    // 覆盖式写法（d.set.call(el,text)）不再出现——合并后赋值
    expect(s).not.toContain('d.set.call(el,text)')
  })
})

describe('removeDshFixDisable（自愈：清除 dsh-fix 对桥接的禁用块）', () => {
  const own = '# dsh-obsidian-bridge — installed by the dsh-harness Obsidian plugin\n- insert:\n    - id: dsh-obsidian-bridge\n      name: file:///x.mjs\n'
  const dshFixBlock = '# dsh-fix: disabled entry "dsh-obsidian-bridge" at 2026-08-28T16:44:26.416Z\n- id: "dsh-obsidian-bridge"\n  disabled: true\n'
  it('移除 dsh-fix 禁用块，保留插件自身 insert 条目与其他条目', () => {
    const input = own + '\n' + dshFixBlock + '- id: auto-continue\n  disabled: true\n'
    const out = removeDshFixDisable(input)
    expect(out).not.toContain('dsh-fix: disabled entry')
    expect(out).toContain('- insert:\n    - id: dsh-obsidian-bridge')
    expect(out).toContain('- id: auto-continue') // 其他禁用条目保留
  })
  it('无 dsh-fix 禁用块时原样返回', () => {
    expect(removeDshFixDisable(own)).toBe(own)
    expect(removeDshFixDisable('')).toBe('')
  })
})
