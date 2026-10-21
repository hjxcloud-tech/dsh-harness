/**
 * 2.9.0 真机验证：自定义绑定地址（IPv4/IPv6）+ 原生 HTTPS（DSH 0.2.1-rc.2）
 *
 * 一次性验证脚本，非发布物。全程使用隔离 DSH_HOME 与高位端口，绝不触碰用户正在跑的 web@3080。
 * 覆盖：
 *   A. https + 127.0.0.1：生成的启动命令带 --tls-cert/--tls-key；探活/认证探测/桥接探针/iframe HTML/
 *      AED 启动校验（curl --cacert）全链路；无 ca 时严格拒绝且错误可分类。
 *   B. https + ::1：生成命令自动带 --host ::1；print 的 URL 是 https://[::1]:port；netstat 解析识别 [::1] 监听。
 * 用法：node scripts/verify-endpoint-tls.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const NODE = process.execPath
const DSH_BIN = join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(DSH_BIN)) {
  console.error(`找不到 DSH bin：${DSH_BIN}`)
  process.exit(2)
}

// window 桩：src 的定时器统一走 window.*（与 verify-profile 同一前提）
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval }
}

const stamp = `${Date.now()}-${String(process.pid)}`
const ROOT = join(tmpdir(), `dsh-verify-endpoint-${stamp}`)
const HOME = join(ROOT, 'home')
const CERTS = join(ROOT, 'certs')
const BUNDLES = join(ROOT, 'bundles')
const LOGS = join(ROOT, 'logs')
for (const d of [HOME, CERTS, BUNDLES, LOGS]) mkdirSync(d, { recursive: true })
process.env.DSH_HOME = HOME

const failures = []
let passes = 0
function pass(name, detail = '') {
  passes += 1
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, err) {
  failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
  console.log(`FAIL  ${name} — ${err instanceof Error ? err.message : String(err)}`)
}
async function check(name, fn) {
  try {
    pass(name, await fn())
  } catch (err) {
    fail(name, err)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---- bundle src 模块 ----
async function bundle(entry, outName) {
  const outFile = join(BUNDLES, outName)
  await build({ entryPoints: [join(REPO, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: outFile })
  return require(outFile)
}
const se = await bundle('src/service-endpoint.ts', 'service-endpoint.cjs')
const sm = await bundle('src/service-manager.ts', 'service-manager.cjs')
const aed = await bundle('src/aed.ts', 'aed.cjs')
const bridge = await bundle('src/bridge.ts', 'bridge.cjs')

// ---- 证书（自签，SAN 覆盖 127.0.0.1 / ::1 / localhost）----
const certFile = join(CERTS, 'cert.pem')
const keyFile = join(CERTS, 'key.pem')
function findOpenssl() {
  const candidates = [
    'openssl',
    'D:\\Software\\anaconda1\\Library\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  ]
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore', timeout: 10000 })
      return c
    } catch {
      /* next */
    }
  }
  throw new Error('未找到 openssl，无法生成自签证书')
}
const openssl = findOpenssl()
// Windows 上部分 openssl 发行版（如 conda）把默认 openssl.cnf 编到不存在的路径：
// 必须自带最小配置，否则 `req -x509` 直接失败（与单测同一做法）。
const opensslCnf = join(CERTS, 'openssl.cnf')
writeFileSync(
  opensslCnf,
  [
    '[ req ]',
    'distinguished_name = dn',
    'prompt = no',
    '',
    '[ dn ]',
    'CN = localhost',
    '',
    '[ v3_req ]',
    'subjectAltName = @alt_names',
    'extendedKeyUsage = serverAuth',
    '',
    '[ alt_names ]',
    'IP.1 = 127.0.0.1',
    'IP.2 = ::1',
    'DNS.1 = localhost',
    '',
  ].join('\n'),
  'utf8',
)
execFileSync(
  openssl,
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '36500',
    '-config', opensslCnf, '-extensions', 'v3_req',
  ],
  { stdio: 'ignore', timeout: 60000, env: { ...process.env, OPENSSL_CONF: opensslCnf } },
)
const certPem = readFileSync(certFile, 'utf8')
assert(certPem.includes('BEGIN CERTIFICATE'), '证书生成失败')

// ---- 端口与进程工具 ----
function tcpReachable(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = connect({ host, port })
    const timer = setTimeout(() => {
      s.destroy()
      resolve(false)
    }, timeoutMs)
    s.once('connect', () => {
      clearTimeout(timer)
      s.destroy()
      resolve(true)
    })
    s.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}
async function pickPort(host, base) {
  for (let i = 0; i < 80; i += 1) {
    const p = base + i
    if (!(await tcpReachable(host, p, 300))) return p
  }
  throw new Error(`${host} 上 ${base} 起连续 80 个端口都被占用`)
}
const children = []
function startInstance(label, commandLine, env) {
  const parts = sm.tokenizeCommand(commandLine)
  const child = spawn(parts[0], parts.slice(1), {
    cwd: join(REPO),
    env: { ...process.env, DSH_HOME: HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let out = ''
  const logPath = join(LOGS, `${label}.log`)
  child.stdout.on('data', (b) => {
    out += b.toString()
    writeFileSync(logPath, out)
  })
  child.stderr.on('data', (b) => {
    out += b.toString()
    writeFileSync(logPath, out)
  })
  children.push({ label, child, pid: child.pid })
  return { child, output: () => out, logPath }
}
async function waitLaunchUrl(ctx, label, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const url = sm.parseLaunchUrl(ctx.output())
    if (url !== '') return url
    if (Date.now() > deadline) throw new Error(`${label} 等待启动 URL 超时：${ctx.output().slice(0, 800)}`)
    await delay(500)
  }
}
function killInstances() {
  for (const { child } of children) {
    if (child.exitCode !== null) continue
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
      } else {
        child.kill('SIGKILL')
      }
    } catch {
      /* 已退出 */
    }
  }
}

const quote = (s) => (/\s/.test(s) ? `"${s}"` : s)
const baseCommand = `${quote(NODE)} ${quote(DSH_BIN)} web --port {port} --no-open`

console.log(`[verify] root=${ROOT}`)
console.log(`[verify] dsh=${DSH_BIN}`)
console.log(`[verify] openssl=${openssl}`)

try {
  // ================= 0. 首次启动建 profile（web 档由 dsh 自建） =================
  const bootPort = await pickPort('127.0.0.1', 38600)
  const bootCtx = startInstance('boot', baseCommand.replace('{port}', String(bootPort)))
  const bootUrl = await waitLaunchUrl(bootCtx, 'boot')
  assert(bootUrl.startsWith(`http://127.0.0.1:${String(bootPort)}/`), `首次启动 URL 异常：${bootUrl}`)
  assert(existsSync(join(HOME, 'profiles', 'web', 'package.json')), 'web profile 未生成')
  const bridgeInstall = bridge.writeBridgeFiles(HOME, '2.9.0', 'web', 'auto')
  assert(bridgeInstall.error === undefined || bridgeInstall.error === null, `桥接安装失败：${String(bridgeInstall.error)}`)
  killInstances()
  await delay(2500)
  console.log('[verify] profile + bridge 就绪')

  // ================= A. HTTPS @ 127.0.0.1 =================
  console.log('\n--- A. HTTPS + IPv4 127.0.0.1 ---')
  const portA = await pickPort('127.0.0.1', 38700)
  const epA = { scheme: 'https', host: '127.0.0.1', port: portA, caCertPath: certFile }

  const cmdA = se.applyEndpointFlags(baseCommand, epA, keyFile)
  await check('A1 生成命令带 --tls-cert/--tls-key 且不带 --host（默认地址）', () => {
    assert(cmdA.includes('--tls-cert'), `缺 --tls-cert：${cmdA}`)
    assert(cmdA.includes(certFile) && cmdA.includes(keyFile), `证书路径缺失：${cmdA}`)
    assert(!cmdA.includes('--host'), `默认地址不应追加 --host：${cmdA}`)
    return cmdA
  })

  // 自定义命令必须原样使用（main.ts 的判据；这里验证纯函数层面的边界）
  await check('A1b 空命令 / 自定义命令边界（applyEndpointFlags 只服务默认命令）', () => {
    assert(se.applyEndpointFlags('', epA, keyFile) === '', '空命令应返回空串')
    return 'ok'
  })

  const ctxA = startInstance('https-ipv4', cmdA.replace('{port}', String(portA)))
  const launchA = await waitLaunchUrl(ctxA, 'https-ipv4')
  await check('A2 启动输出打印 https 认证 URL', () => {
    assert(launchA.startsWith(`https://127.0.0.1:${String(portA)}/?token=`), `实际：${launchA}`)
    return launchA.slice(0, 60) + '…'
  })
  const tokenA = new URL(launchA).searchParams.get('token') ?? ''
  assert(tokenA !== '', '启动 URL 无 token')

  await check('A3 TCP 探活 true；面板认证探测 = auth（裸 GET 401）', async () => {
    assert((await sm.probePanelNeedsAuth(epA)) === 'auth', '应为 auth')
    return 'auth'
  })

  await check('A4 页面级桥接探针 = injected（桥接 HTTPS 下同样注入）', async () => {
    const r = await sm.probeBridgeInjected(epA, tokenA)
    assert(r === 'injected', `实际：${r}`)
    return r
  })

  await check('A5 携带 token+ob=1 取首页：200 且含 boot 与桥接标记', async () => {
    const res = await se.endpointRequest(epA, {
      path: `/?token=${encodeURIComponent(tokenA)}&ob=1`,
      method: 'GET',
      timeoutMs: 8000,
    })
    assert(res.status === 200, `状态码 ${String(res.status)}`)
    assert(res.text.includes('__DSH_BOOT__'), '缺 __DSH_BOOT__')
    assert(res.text.includes('__DSH_OBSIDIAN_BRIDGE__'), '缺桥接标记')
    return `${String(res.status)} / ${String(res.text.length)}B`
  })

  await check('A6 AED 启动校验 verifyDshBootAsync（curl --cacert）通过', async () => {
    const r = await aed.verifyDshBootAsync(epA, tokenA, undefined, 12000)
    assert(r.ok === true, JSON.stringify(r).slice(0, 400))
    return 'ok'
  })

  await check('A7 不填证书 PEM 时严格拒绝，错误可分类为 untrusted/tls', async () => {
    const noCa = { scheme: 'https', host: '127.0.0.1', port: portA }
    let err = null
    try {
      await se.endpointRequest(noCa, { path: '/', method: 'GET', timeoutMs: 5000 })
    } catch (e) {
      err = e
    }
    assert(err !== null, '未填写证书 PEM 时竟然成功（不应绕过校验）')
    assert(se.tlsErrorKind(err) === 'untrusted', `tlsErrorKind=${se.tlsErrorKind(err)} / ${err.message}`)
    assert(se.classifyConnectFailure(err).kind === 'tls', `classify=${se.classifyConnectFailure(err).kind}`)
    return String(err.code ?? '')
  })

  await check('A8 端口占用识别（netstat → parseNetstatListeners）命中该实例', () => {
    const raw = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    const rows = sm.parseNetstatListeners(raw)
    const hit = rows.find((r) => r.port === portA)
    assert(hit !== undefined, `netstat 未解析到端口 ${String(portA)}`)
    assert(sm.portOwnerPids(portA).length > 0, 'portOwnerPids 为空')
    return `pid=${String(hit.pid)}`
  })

  killInstances()
  await delay(2500)

  // ================= B. HTTPS @ ::1 =================
  console.log('\n--- B. HTTPS + IPv6 ::1 ---')
  const portB = await pickPort('::1', 38820)
  const epB = { scheme: 'https', host: '::1', port: portB, caCertPath: certFile }

  const cmdB = se.applyEndpointFlags(baseCommand, epB, keyFile)
  await check('B1 生成命令自动追加 --host ::1 + TLS 参数', () => {
    assert(/--host\s+::1/.test(cmdB), `缺 --host ::1：${cmdB}`)
    assert(cmdB.includes('--tls-cert'), `缺 --tls-cert：${cmdB}`)
    return cmdB
  })

  const ctxB = startInstance('https-ipv6', cmdB.replace('{port}', String(portB)))
  const launchB = await waitLaunchUrl(ctxB, 'https-ipv6')
  await check('B2 启动输出打印 https://[::1]:port 认证 URL', () => {
    assert(launchB.startsWith(`https://[::1]:${String(portB)}/?token=`), `实际：${launchB}`)
    return launchB.slice(0, 60) + '…'
  })
  const tokenB = new URL(launchB).searchParams.get('token') ?? ''
  await check('B3 endpointOrigin 与探活/桥接探针/首页在 IPv6 下全通', async () => {
    assert(se.endpointOrigin(epB) === `https://[::1]:${String(portB)}`, se.endpointOrigin(epB))
    assert((await sm.probePanelNeedsAuth(epB)) === 'auth', '应为 auth')
    assert((await sm.probeBridgeInjected(epB, tokenB)) === 'injected', '桥接探针应 injected')
    const res = await se.endpointRequest(epB, {
      path: `/?token=${encodeURIComponent(tokenB)}&ob=1`,
      method: 'GET',
      timeoutMs: 8000,
    })
    assert(res.status === 200 && res.text.includes('__DSH_BOOT__'), `首页异常：${String(res.status)}`)
    return 'ok'
  })

  await check('B4 netstat 能解析 [::1]:port 监听（端口占用识别不再漏 IPv6）', () => {
    const raw = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    const rows = sm.parseNetstatListeners(raw)
    const hit = rows.find((r) => r.port === portB)
    assert(hit !== undefined, `netstat 未解析到 IPv6 端口 ${String(portB)}`)
    assert(raw.includes(`[::1]:${String(portB)}`), 'netstat 原始输出无 [::1] 行')
    return `pid=${String(hit.pid)}`
  })

  // ================= C. 收尾 =================
  killInstances()
  await delay(3000)
  await check('C1 收尾：两个实例已退出、端口释放', async () => {
    assert(!(await tcpReachable('127.0.0.1', portA)), 'IPv4 端口仍在监听')
    assert(!(await tcpReachable('::1', portB)), 'IPv6 端口仍在监听')
    return 'ok'
  })
} catch (err) {
  fail('未捕获的验证异常', err)
} finally {
  killInstances()
  await delay(1500)
}

console.log(`\n[verify] PASS=${String(passes)} FAIL=${String(failures.length)}`)
if (failures.length > 0) {
  console.log(failures.join('\n'))
}
// 收尾清理：只在成功后删除隔离目录（失败保留日志便于排查）
if (failures.length === 0) {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
} else {
  console.log(`[verify] 隔离目录保留：${ROOT}`)
}
process.exit(failures.length === 0 ? 0 : 1)
