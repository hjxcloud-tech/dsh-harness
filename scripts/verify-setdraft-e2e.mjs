/**
 * 桥接 setDraft 快路径的**真机端到端探针**（开发工具，不进发布物；v2.8.0 引入）
 *
 * 为什么需要它（"存在性≠可用性"的第三次教训）：
 *   verify-package-mode.mjs 只能证明**磁盘上产出了**装载器认得的包形态（静态形状），
 *   单测只能证明**页面脚本在被 mock 的环境里**会调 setDraft。两者都绿，仍可能整体无效：
 *   `setDraft` 究竟有没有真的挂到 `window` 上、写入有没有真的落进输入框 DOM、
 *   写入过程有没有真的不抢焦点——只有把真实 DSH 装起来、用真实浏览器打开才算数。
 *   本探针把这条链路的**每一环都在真机上钉死**，且全部用可观测事实（不靠字符串猜）：
 *     A. 页面的 `__DSH_BOOT__.entries` 里出现裸包名条目（装载器真的编入了客户端半）
 *     B. 客户端半真的把 `window.__DSH_BRIDGE_SET_DRAFT__` 挂成了函数
 *     C. 面板 → iframe 发真实隐式行 → 回执 `note=setdraft`（走的是**官方模型层**而不是 DOM 兜底）
 *     D. 输入框 DOM 里出现且**只出现一条**隐式行（无重复前置）
 *     E. 写入全程 `activeElement` / `hasFocus()` 不变（**不抢焦点**，P2 的价值）
 *     F. 能力上报 `dsh-bridge-cap{setDraft:true}` 真的发给父页（宿主据此撤焦点门控的唯一依据）
 *     G. 取消框选（空串清除）同样走模型层，且把标记清干净
 *
 * 踩过的四个坑（复现时别再走一遍）：
 *   ① `dsh web` 根路径**必须带 `?token=`**，否则 404；`/api/*` 要 `authorization: Bearer <token>`。
 *      不带 token 会拿到 404 页 ⇒ entries 空、setDraft 不存在——那是**环境没进去**，不是功能没生效。
 *   ② 写桥接后 DSH 要重新 link 包，首启+重启各可能 30~60s。超时给短了会把"慢"误判成"挂死"。
 *   ③ 桥接脚本的 `fill()`/capProbe 被 `window.top!==window.self` 闸门挡着——**只有 iframe 面板形态才注册**。
 *      把 DSH 当顶层页打开，D/E/F 必然 false。故本探针自建"面板页"用 iframe 嵌之。
 *   ④ `dsh-fill-draft` 的 payload 必须是**真实隐式行**（含 BRIDGES 标记）。发裸文本时
 *      `bridgeOk` 复核必然失败 → 退回 DOM 路径 → 而 setDraft 其实已写入 ⇒ 内容被重复前置。
 *      本探针直接调用 `buildBridgeMessage()` 生成 payload，与生产同源。
 *
 * 用法：
 *   npm run verify:setdraft
 *   node scripts/verify-setdraft-e2e.mjs [--json] [--keep] [--port 3251] [--timeout 240]
 *
 * 需要：本机已装 `dsh`（@deepseek-ai/dsh）、Chrome 或 Edge。
 *      可用 `DSH_E2E_CHROME` 指定浏览器可执行文件。
 * 全部通过 exit 0，任一失败 exit 1。`--keep` 保留临时 home（排查用）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const keep = args.includes('--keep')
const pickArg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const DSH_PORT = Number(pickArg('--port', '3251'))
const PANEL_PORT = DSH_PORT + 9
const CDP_PORT = DSH_PORT + 10
const BOOT_TIMEOUT_MS = Number(pickArg('--timeout', '240')) * 1000

const checks = []
const check = (id, desc, ok, detail) => checks.push({ id, desc, ok, detail })
const step = (msg) => { if (!asJson) console.log(`  · ${msg}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 src/bridge.ts 读规范常量（勿硬编码包名——那正是要防的漂移）。 */
function readConstants() {
  const src = readFileSync(join(REPO, 'src', 'bridge.ts'), 'utf8')
  const pick = (re, what) => {
    const m = src.match(re)
    if (!m) throw new Error(`src/bridge.ts 里找不到 ${what}`)
    return m[1]
  }
  return { pkgName: pick(/\bBRIDGE_PACKAGE_NAME\s*=\s*'([^']+)'/, 'BRIDGE_PACKAGE_NAME') }
}

/** 找浏览器：env 优先，其次常见路径。 */
function findChrome() {
  const env = (process.env.DSH_E2E_CHROME ?? '').trim()
  const cands = [
    env,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter((p) => p !== '')
  return cands.find((p) => existsSync(p)) ?? ''
}

/**
 * 定位本机 `dsh` 的 bin.js。先用 `npm root -g`，拿不到再走常见路径。
 * 注意本机 WorkBuddy 的 `npm` 会解析到托管 node，与用户命令行用的全局包不是同一份——
 * 故这里**优先用户级全局目录**（AppData/Roaming/npm），与用户实际运行的一致。
 */
function findDshBin() {
  const cands = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js') : '',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter((p) => p !== '')
  return cands.find((p) => existsSync(p)) ?? ''
}

const readLog = (p) => {
  try {
    const b = readFileSync(p)
    const s = b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8')
    return s.replace(/\x1b\[[0-9;]*m/g, '')
  } catch { return '' }
}

let home = ''
let dshProc = null
let panelServer = null
let chromeProc = null

async function main() {
  const C = readConstants()
  const chrome = findChrome()
  const dshBin = findDshBin()
  check('pre-1', '本机找到 dsh（@deepseek-ai/dsh/lib/bin.js）', dshBin !== '', dshBin || '未找到')
  check('pre-2', '本机找到 Chrome/Edge（可用 DSH_E2E_CHROME 指定）', chrome !== '', chrome || '未找到')
  if (dshBin === '' || chrome === '') return report()

  // ── 0. 打包源码：桥接（读写桥接文件 + 页面脚本源码）与 source-tag（隐式行生成，与生产同源）──
  const require = createRequire(join(REPO, 'package.json'))
  const esbuild = require('esbuild')
  const bundle = async (entry) => {
    const built = await esbuild.build({
      entryPoints: [join(REPO, 'src', entry)],
      bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
    })
    return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
  }
  const bridgeMod = await bundle('bridge.ts')
  const tagMod = await bundle('source-tag.ts')
  const { writeBridgeFiles, dshProfileDir } = bridgeMod
  const { buildBridgeMessage } = tagMod

  // payload 与生产同源：直接调 buildBridgeMessage，杜绝"格式漂移后探针还在测旧形态"
  const marker = buildBridgeMessage('D:\\deepseek-harness\\notes\\e2e.md', { fromLine: 0, fromCh: 0, toLine: 1, toCh: 2 }, 12)
  check('pre-3', '隐式行 payload 由 buildBridgeMessage 生成（与生产同源）', bridgeMod.BRIDGE_LINE_RE.test(marker), marker)
  if (!bridgeMod.BRIDGE_LINE_RE.test(marker)) return report()

  // ── 1. 隔离 home + 首启物化 profile ──
  home = mkdtempSync(join(tmpdir(), 'dsh-setdraft-e2e-'))
  step(`临时 DSH home：${home}`)

  const boot = (port, timeoutMs) => {
    const logPath = join(home, `boot-${port}.log`)
    const out = createWriteStream(logPath)
    const p = spawn(process.execPath, [dshBin, 'web', '--port', String(port), '--no-open'], {
      env: { ...process.env, DSH_HOME: home }, windowsHide: true,
    })
    p.stdout.pipe(out); p.stderr.pipe(out)
    let exited = null
    p.on('close', (c) => { exited = c })
    const done = (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (exited !== null) return { url: null, why: `服务进程退出（code ${exited}）` }
        const m = readLog(logPath).match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/)
        if (m) return { url: `http://127.0.0.1:${m[1]}/?token=${m[2]}` }
        await sleep(500)
      }
      return { url: null, why: `超过 ${timeoutMs / 1000}s 未出现 URL` }
    })()
    return { p, done, logPath }
  }

  step('首启 DSH 物化 profile（首次可能 30~60s）…')
  const b1 = boot(DSH_PORT + 1, BOOT_TIMEOUT_MS)
  const r1 = await b1.done
  try { b1.p.kill() } catch { /* 已被回收 */ }
  await sleep(3000)
  check('1', 'profile 可物化（首启给出带 token 的 URL）', r1.url !== null, r1.why ?? '')
  if (r1.url === null) return report()

  // ── 2. 写 package 模式桥接 + 重启 ──
  const wrote = writeBridgeFiles(home, '0.0.0-e2e', 'web', 'package')
  check('2', `桥接以 package 模式落地（installAs=${wrote.installAs}）`, wrote.installAs === 'package', wrote.error ?? '')

  step('重启 DSH 载入桥接（需重新 link 包，可能 30~60s）…')
  const b2 = boot(DSH_PORT, BOOT_TIMEOUT_MS)
  const r2 = await b2.done
  dshProc = b2.p
  check('3', '带桥接的实例启动并给出 URL', r2.url !== null, r2.why ?? '')
  if (r2.url === null) return report()
  const appUrl = r2.url
  const TOKEN = new URL(appUrl).searchParams.get('token')

  // 注意：`GET /?token=…` 返回的是跳转壳（几十字节），真实文档由浏览器跟随取得。
  // 故"注入是否生效"不在 Node 侧 fetch 里判（那会误判为失败），而是在 iframe 文档内判（见 check 4）。

  // ── 3. 面板页（模拟 Obsidian 面板：桥接脚本只在 iframe 形态注册）──
  const panelHtml = `<!doctype html><html><head><meta charset="utf-8"><title>dsh-panel-sim</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100vw;height:100vh}</style></head><body>
<script>
window.__E2E__ = { msgs: [] };
window.addEventListener('message', function (e) {
  var d = e.data; if (!d || typeof d !== 'object') return;
  window.__E2E__.msgs.push({ type: d.type, ok: d.ok === undefined ? null : !!d.ok,
    had: d.had === undefined ? null : !!d.had, note: d.note || '',
    sd: d.sd === undefined ? null : !!d.sd, setDraft: d.setDraft === undefined ? null : !!d.setDraft });
});
window.__e2eFill = function (text) {
  document.getElementById('f').contentWindow.postMessage({ type: 'dsh-fill-draft', text: text }, '*');
};
</script>
<iframe id="f" src="${appUrl}"></iframe>
</body></html>`

  panelServer = http.createServer((req, res) => {
    if (req.url.startsWith('/panel')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(panelHtml)
      return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((r) => panelServer.listen(PANEL_PORT, '127.0.0.1', r))
  const panelUrl = `http://127.0.0.1:${PANEL_PORT}/panel.html`
  step(`面板页（iframe 嵌 DSH）：${panelUrl}`)

  // ── 4. headless Chrome + CDP ──
  const profileDir = join(home, 'chrome-profile')
  chromeProc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${CDP_PORT}`, panelUrl,
  ], { windowsHide: true, stdio: 'ignore' })

  const target = await (async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
        const p = list.find((t) => t.type === 'page' && t.url.includes('panel.html'))
        if (p?.webSocketDebuggerUrl) return p
      } catch { /* 浏览器还没起来 */ }
      await sleep(400)
    }
    return null
  })()
  check('5', 'headless 浏览器打开了面板页', target !== null, target ? '' : '找不到 CDP page target')
  if (target === null) return report()

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let mid = 0
  const pending = new Map()
  const contexts = []
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data) } catch { return }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context)
  }
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const id = ++mid
    const to = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)) }, 40000)
    pending.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr, contextId) => {
    const r = await cmd('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}),
    })
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
    return r.result.value
  }
  await cmd('Runtime.enable'); await cmd('Page.enable')

  // 等桥接脚本握手（它只在 iframe 形态注册）
  const appOrigin = `http://127.0.0.1:${DSH_PORT}`
  let bridged = false
  for (let i = 0; i < 60 && !bridged; i++) {
    const types = await ev('JSON.stringify((window.__E2E__||{}).msgs?.map(m=>m.type)||[])')
    bridged = typeof types === 'string' && types.includes('dsh-bridge-client')
    if (!bridged) await sleep(1000)
  }
  check('6', 'iframe 内桥接脚本已注册并向父页报到（闸门 window.top!==window.self 放行）', bridged, '')

  const iframeCtx = contexts.filter((c) => (c.origin || '').startsWith(appOrigin)).pop()
  const inFrame = (expr) => (iframeCtx ? ev(expr, iframeCtx.id) : null)

  // 插槽是 session 作用域的：要等 SPA 恢复会话、装上 composer 才挂 inputActions
  let waited = 0
  let sdType = await inFrame('typeof window.__DSH_BRIDGE_SET_DRAFT__')
  while (sdType !== 'function' && waited < 180000) { await sleep(2000); waited += 2000; sdType = await inFrame('typeof window.__DSH_BRIDGE_SET_DRAFT__') }
  step(`等待会话/composer 挂载：${waited / 1000}s`)

  // ── 4：注入脚本真的进了文档（iframe 内判；上面那 68 字节跳转壳不作数）──
  const injected = await inFrame(`(function(){try{return [].slice.call(document.scripts).some(function(s){return (s.textContent||'').indexOf('dsh-fill-draft')>=0})}catch(e){return 'err:'+e.message}})()`)
  const scriptCount = await inFrame('document.scripts.length')
  check('4', '页面文档内含桥接注入脚本（页面侧消费方在位）', injected === true, `injected=${String(injected)} scripts=${String(scriptCount)}`)

  // ── A/B：装载器编入客户端半，且 setDraft 真的挂上了 ──
  const entriesRaw = await inFrame('JSON.stringify((globalThis.__DSH_BOOT__&&globalThis.__DSH_BOOT__.entries)||[])')
  let entries = []; try { entries = JSON.parse(entriesRaw) } catch { /* 保持空 */ }
  const bridgeEntry = entries.find((e) => String(e.id) === C.pkgName)
  check('A', `__DSH_BOOT__.entries 含裸包名条目 ${C.pkgName}`, Boolean(bridgeEntry), `entries=${entries.length} 条`)
  check('B', '客户端半把 window.__DSH_BRIDGE_SET_DRAFT__ 挂成函数', sdType === 'function', `typeof=${String(sdType)}`)

  const readState = `(()=>{ try {
    var el=document.querySelector('[contenteditable="true"]');
    var txt=(el&&el.innerText)||'';
    return JSON.stringify({ae:document.activeElement?document.activeElement.tagName:'null',
      af:document.hasFocus(), nBridge:(txt.match(/BRIDGES is delivering/g)||[]).length,
      focused: !!el && document.activeElement===el, text:txt});
  } catch(e) { return JSON.stringify({err:String(e)}) } })()`

  if (sdType === 'function') {
    // 基线清干净（也顺带覆盖"取消框选"的模型层清除）
    await inFrame(`try{window.__DSH_BRIDGE_SET_DRAFT__('')}catch(_){}`)
    await sleep(600)

    // ── C/D/E：面板发真实隐式行 → 回执走模型层 / DOM 恰一条 / 焦点不变 ──
    const before = await inFrame(readState)
    await ev(`window.__e2eFill(${JSON.stringify(marker)})`)
    await sleep(1800)
    const afterRaw = await inFrame(readState)
    const acksRaw = await ev('JSON.stringify((window.__E2E__||{}).msgs||[])')
    let msgs = []; try { msgs = JSON.parse(acksRaw) } catch { /* 保持空 */ }
    let after = {}; try { after = JSON.parse(afterRaw) } catch { /* 保持空 */ }
    let beforeObj = {}; try { beforeObj = JSON.parse(before) } catch { /* 保持空 */ }
    const fillAck = msgs.filter((m) => m.type === 'dsh-fill-ack').pop()

    step(`ack=${JSON.stringify(fillAck)} after=${afterRaw}`)
    check('C', '填充走官方模型层（回执 note=setdraft 且 sd=true，非 DOM 兜底）',
      Boolean(fillAck) && fillAck.ok === true && fillAck.note === 'setdraft' && fillAck.sd === true,
      JSON.stringify(fillAck ?? null))
    check('D', '输入框 DOM 里恰好出现一条隐式行（无重复前置）',
      after.nBridge === 1 && typeof after.text === 'string' && after.text.includes('BRIDGES is delivering'),
      `nBridge=${String(after.nBridge)}`)
    check('E1', '写入时输入框**没有**焦点（回执 had=false）', Boolean(fillAck) && fillAck.had === false, JSON.stringify(fillAck ?? null))
    check('E2', '写入前后 activeElement 与 hasFocus() 均未改变（不抢焦点）',
      beforeObj.ae === after.ae && beforeObj.af === after.af && after.focused === false,
      `before ae/af=${String(beforeObj.ae)}/${String(beforeObj.af)} after ae/af=${String(after.ae)}/${String(after.af)} focused=${String(after.focused)}`)

    // ── F：能力上报（宿主撤焦点门控的唯一依据）──
    const cap = msgs.find((m) => m.type === 'dsh-bridge-cap')
    check('F', '能力上报 dsh-bridge-cap{setDraft:true} 已送达父页', Boolean(cap) && cap.setDraft === true, JSON.stringify(cap ?? null))

    // ── G：取消框选（空串清除）同样走模型层且清干净 ──
    await ev(`window.__e2eFill('')`)
    await sleep(1500)
    const clearedRaw = await inFrame(readState)
    const clearedAcks = await ev('JSON.stringify(((window.__E2E__||{}).msgs||[]).filter(m=>m.type==="dsh-fill-ack"))')
    let cmsgs = []; try { cmsgs = JSON.parse(clearedAcks) } catch { /* 保持空 */ }
    let cleared = {}; try { cleared = JSON.parse(clearedRaw) } catch { /* 保持空 */ }
    const clearAck = cmsgs.pop()
    // 注意：Lexical 的空文档本身是一个空段落，innerText 读回 '\n' 而非 ''；
    // nBridge===0 才是"标记已清干净"的实证，该残留也不干扰后续填充。
    check('G', '取消框选：走模型层且隐式行被清干净',
      Boolean(clearAck) && clearAck.ok === true && clearAck.note === 'setdraft' &&
      cleared.nBridge === 0 && typeof cleared.text === 'string' && cleared.text.trim() === '',
      `ack=${JSON.stringify(clearAck ?? null)} text=${JSON.stringify(cleared.text ?? null)}`)
  } else {
    check('C', '填充走官方模型层（回执 note=setdraft 且 sd=true，非 DOM 兜底）', false, 'setDraft 未挂载，后续探针跳过')
  }

  try { ws.close() } catch { /* 已关闭 */ }
  return report()
}

function report() {
  const failed = checks.filter((c) => !c.ok).length
  if (asJson) {
    console.log(JSON.stringify({ home, checks, failed }, null, 2))
  } else {
    console.log('桥接 setDraft 快路径真机端到端探针')
    console.log(`  临时 DSH home   ${home}`)
    console.log('')
    for (const c of checks) {
      console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}`)
      if (!c.ok) console.log(`      -> ${c.detail}`)
    }
    console.log('')
    console.log(failed === 0 ? `结论：全部通过（${checks.length}/${checks.length}）` : `结论：${failed} 项失败`)
  }
  return failed
}

let failedCount = 1
try {
  failedCount = await main()
} catch (e) {
  check('fatal', '探针未抛异常完成', false, String((e && e.stack) || e))
  failedCount = scanFatal()
}
function scanFatal() {
  const f = checks.filter((c) => !c.ok).length
  if (f === 0) check('fatal', '探针未抛异常完成', false, '未知错误')
  if (!asJson) {
    console.log('桥接 setDraft 快路径真机端到端探针')
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}${c.ok ? '' : `\n      -> ${c.detail}`}`)
  } else {
    console.log(JSON.stringify({ home, checks, failed: checks.filter((c) => !c.ok).length }, null, 2))
  }
  return checks.filter((c) => !c.ok).length
}

// ── 收尾：本进程造出来的东西全部回收（--keep 时留下 home 供排查）──
try { chromeProc?.kill() } catch { /* 已退出 */ }
try { dshProc?.kill() } catch { /* 已退出 */ }
try { panelServer?.close() } catch { /* 已关闭 */ }
if (!keep && home !== '') {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 临时目录清不掉无害 */ }
} else if (keep) {
  console.log(`（--keep）临时 home 保留在 ${home}`)
}
process.exit(failedCount === 0 ? 0 : 1)
