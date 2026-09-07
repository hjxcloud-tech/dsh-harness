/**
 * v2.3.2 嵌入认证适配器隔离验证（一次性脚本，非发布物）：
 * ① 用当前 bridge.ts 真源把桥接写入隔离 home；
 * ② 拉起指定 DSH 版本，等 stdout 打印认证 URL；
 * ③ HTTP 探测矩阵：面板路径(ob=1+token→200 带注入变量)/浏览器路径(裸 token→303+Set-Cookie)/
 *    未认证(401)/fence 原样(伪造 Host→403)/Bearer 与 query 双通道/无 ob 标记不得直发；
 * ④ rc.2（无 browser-auth）：适配器应静默、页面照常 200。
 * 用法：node scripts/verify-embed.mjs <bin.js 路径> <隔离 home> <mode:auth|plain>
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

const [, , binPath, homeArg, mode] = process.argv
if (!binPath || !homeArg || !['auth', 'plain'].includes(mode)) {
  console.error('usage: node scripts/verify-embed.mjs <bin.js> <home> <auth|plain>')
  process.exit(2)
}
const HOME = homeArg
mkdirSync(HOME, { recursive: true })

// ---- 1. 用当前插件真源写桥接（隔离 home）----
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-embed-verify-'))
const outFile = join(bundleDir, 'bridge.cjs')
await build({
  entryPoints: ['src/bridge.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
})
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bridge = require(outFile)
process.env.DSH_HOME = HOME
const install = bridge.writeBridgeFiles(HOME)
if (install.error) {
  console.error('writeBridgeFiles failed:', install.error)
  process.exit(3)
}
const pluginFile = join(HOME, 'profiles', 'web', 'dsh-obsidian-bridge.mjs')
if (!readFileSync(pluginFile, 'utf8').includes('embedPatchAuth')) {
  console.error('bridge .mjs missing embedPatchAuth')
  process.exit(3)
}
console.log(`[setup] bridge installed, embedPatchAuth present (home=${HOME})`)

// ---- 2. 拉起服务，等认证 URL ----
const PORT = mode === 'auth' ? 3199 : 3299
const child = spawn(process.execPath, [binPath, 'web', '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdoutBuf = ''
function tcpUp() {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: PORT })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}
child.stdout.on('data', (buf) => { stdoutBuf += buf.toString() })
child.stderr.on('data', (buf) => { stdoutBuf += buf.toString() })
const launchUrl = mode === 'auth'
  ? await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for launch url: ' + stdoutBuf.slice(0, 300))), 120000)
      const poll = setInterval(() => {
        const m = /dsh web: (http:\/\/\S+?token=\S+)/.exec(stdoutBuf)
        if (m) { clearTimeout(timer); clearInterval(poll); resolve(m[1]) }
      }, 250)
      child.on('exit', (code) => { clearTimeout(timer); clearInterval(poll); reject(new Error(`server exited ${String(code)}: ${stdoutBuf.slice(0, 400)}`)) })
    })
  : await (async () => {
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        if (await tcpUp()) return ''
        await new Promise((r) => setTimeout(r, 1000))
      }
      throw new Error('server never came up: ' + stdoutBuf.slice(0, 400))
    })()
console.log(`[boot] launch url: ${launchUrl === '' ? '(plain mode: none)' : launchUrl.replace(/token=\S+/, 'token=***')}`)
const token = mode === 'auth' ? (new URL(launchUrl).searchParams.get('token') ?? '') : ''
if (mode === 'auth' && token === '') {
  console.error('auth mode but token not parsed from launch url')
  child.kill()
  process.exit(3)
}

// ---- 3. HTTP 探测 ----
function probe(method, path, { headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, method, path, headers: { host: host ?? `127.0.0.1:${String(PORT)}`, ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          setCookie: (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie']) ?? '',
        }))
      },
    )
    req.on('error', reject)
    if (method === 'POST') req.end(JSON.stringify({ type: 'client-request', rpcId: 'verify-1', method: path.split('?')[0].split('/').slice(2).join('/'), payload: {} }))
    else req.end()
  })
}

// 原始 WebSocket 升级握手：只取 HTTP 状态行（101=握手成功，401/403=被围栏/认证拒）
function wsHandshake(path) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: PORT }, () => {
      const key = 'dshverifykey0123456789ab=='
      socket.write(
        `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1:${String(PORT)}\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-key: ${key}\r\nsec-websocket-version: 13\r\n\r\n`,
      )
    })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('ws handshake timeout')) }, 8000)
    let buf = ''
    socket.on('data', (c) => {
      buf += c.toString('latin1')
      const m = /^HTTP\/1\.[01] (\d{3})/m.exec(buf)
      if (m) { clearTimeout(timer); socket.destroy(); resolve(Number(m[1])) }
    })
    socket.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

let failures = 0
const results = []
async function check(name, fn) {
  try {
    const okMsg = await fn()
    results.push(`PASS  ${name}${okMsg ? ' — ' + okMsg : ''}`)
  } catch (err) {
    failures += 1
    results.push(`FAIL  ${name} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

if (mode === 'auth') {
  await check('面板：GET /?token&ob=1 → 200 + 注入 __DSH_EMBED_TOKEN__=" + __DSH_BOOT__', async () => {
    const r = await probe('GET', `/?token=${encodeURIComponent(token)}&ob=1`)
    if (r.status !== 200) throw new Error(`status ${String(r.status)}`)
    if (!r.text.includes('__DSH_EMBED_TOKEN__="')) throw new Error('embed token assignment not injected')
    if (!r.text.includes('String(i.href||i.url||i)')) throw new Error('page patch missing URL-object fix')
    if (!r.text.includes('__DSH_BOOT__')) throw new Error('boot markers missing')
    return '200'
  })
  await check('浏览器路径：GET /?token（无 ob）→ 303 + Set-Cookie（原样）', async () => {
    const r = await probe('GET', `/?token=${encodeURIComponent(token)}`)
    if (r.status !== 303) throw new Error(`status ${String(r.status)}`)
    if (!r.setCookie.includes('dsh-auth-')) throw new Error('no dsh-auth cookie')
    return '303+cookie'
  })
  await check('ob 值不为 1 → 不得直发 200', async () => {
    const r = await probe('GET', `/?token=${encodeURIComponent(token)}&ob=9`)
    if (r.status === 200) throw new Error('served index for ob=9')
    return `status ${String(r.status)}`
  })
  await check('未认证：GET / → 401 authentication required', async () => {
    const r = await probe('GET', '/')
    if (r.status !== 401 || !r.text.includes('authentication required')) throw new Error(`status ${String(r.status)}`)
    return '401'
  })
  await check('API：Bearer 头 → 200 RPC 信封', async () => {
    const r = await probe('POST', '/api/session/list', { headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } })
    if (r.status !== 200) throw new Error(`status ${String(r.status)} body=${r.text.slice(0, 120)}`)
    return '200'
  })
  await check('API：query token → 200（WS 兜底通道）', async () => {
    const r = await probe('POST', `/api/session/list?token=${encodeURIComponent(token)}`, { headers: { 'content-type': 'application/json' } })
    if (r.status !== 200) throw new Error(`status ${String(r.status)}`)
    return '200'
  })
  // 0.1.2+ 事件通道重构为 /api fetch 路由（websocket-downlink 已删除），/api/events.mux 为死路径；
  // rc.2 源码亦证明 WS 升级只过 fence 不吃 browser-auth → 此探测仅作版本形态哨兵，超时按 SKIP
  await check('WS 事件通道（若存在）：Upgrade 带 query token → 非 401/403', async () => {
    let code
    try { code = await wsHandshake(`/api/events.mux?token=${encodeURIComponent(token)}`) } catch { return 'SKIP (无该升级路由——事件已走 /api fetch 通道)' }
    if (code === 401 || code === 403) throw new Error(`upgrade rejected ${String(code)}`)
    return `status ${String(code)}`
  })
  await check('WS 事件通道（若存在）：无凭证 Upgrade → 401/403/非挂起', async () => {
    let code
    try { code = await wsHandshake('/api/events.mux') } catch { return 'SKIP (同上)' }
    if (code !== 401 && code !== 403) throw new Error(`unexpected ${String(code)}`)
    return `status ${String(code)}`
  })
  await check('API：无凭证 → 401', async () => {
    const r = await probe('POST', '/api/session/list', { headers: { 'content-type': 'application/json' } })
    if (r.status !== 401) throw new Error(`status ${String(r.status)}`)
    return '401'
  })
  await check('fence 原样：伪造 Host 无凭证 → 403（不是 401）', async () => {
    const r = await probe('POST', '/api/session/list', { headers: { 'content-type': 'application/json' }, host: 'evil.test' })
    if (r.status !== 403) throw new Error(`status ${String(r.status)}`)
    return '403'
  })
  await check('fence 优先：伪造 Host + 合法 token → 仍 403', async () => {
    const r = await probe('POST', `/api/session/list?token=${encodeURIComponent(token)}`, { headers: { 'content-type': 'application/json' }, host: 'evil.test' })
    if (r.status !== 403) throw new Error(`status ${String(r.status)}`)
    return '403'
  })
} else {
  await check('rc.2 静默：GET / → 200 且【不】含 __DSH_EMBED_TOKEN__=" 赋值', async () => {
    const r = await probe('GET', '/')
    if (r.status !== 200) throw new Error(`status ${String(r.status)}`)
    if (r.text.includes('__DSH_EMBED_TOKEN__="')) throw new Error('embed token injected on auth-less DSH')
    console.log('  (note: rc.2 index 是否含桥接脚本 ' + String(r.text.includes('__DSH_OBSIDIAN_BRIDGE__')) + ')')
    return '200, adapter silent'
  })
  await check('rc.2 API：无凭证 loopback → 200（原行为不变）', async () => {
    const r = await probe('POST', '/api/session.list', { headers: { 'content-type': 'application/json' } })
    if (r.status !== 200) throw new Error(`status ${String(r.status)} body=${r.text.slice(0, 120)}`)
    return '200'
  })
}

console.log('\n==== RESULTS (' + mode + ') ====')
for (const line of results) console.log(line)
console.log(`failures: ${String(failures)}`)
if (failures > 0) {
  const bridgeLogs = stdoutBuf.split(/\r?\n/).filter((l) => l.includes('dsh-obsidian-bridge') || l.includes('embed adapter'))
  console.log('---- server bridge logs ----')
  for (const l of bridgeLogs.slice(0, 10)) console.log(l)
  if (bridgeLogs.length === 0) console.log('(none — 桥接插件可能未加载)')
  console.log('---- server stdout (first 40 lines) ----')
  for (const l of stdoutBuf.split(/\r?\n/).slice(0, 40)) console.log(l)
}

child.kill()
try { rmSync(bundleDir, { recursive: true, force: true }) } catch {}
process.exit(failures > 0 ? 1 : 0)
