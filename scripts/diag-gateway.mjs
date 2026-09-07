/**
 * 诊断：rc.1 上经认证通道调用 session/list / host.describe，打印完整错误体。
 * 对比两组：带桥接的 auth home vs 不带桥接的 fresh home（判别是否我们插件打挂网关）。
 * 用法：node scripts/diag-gateway.mjs
 */
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { connect } from 'node:net'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import process from 'node:process'

const bin = process.env.TEMP + '\\dsh-rc1-test\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

function rpc(port, cookie, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'd1', method: path.split('/').slice(2).join('/'), payload: bodyObj ?? {} })
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${String(port)}`, 'content-type': 'application/json', cookie } },
      (res) => {
        const c = []
        res.on('data', (d) => c.push(d))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function runCase(label, home, port) {
  mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, [bin, 'web', '--port', String(port), '--no-open'], {
    env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let buf = ''
  child.stdout.on('data', (d) => { buf += d })
  child.stderr.on('data', (d) => { buf += d })
  try {
    for (let i = 0; i < 150; i++) {
      const up = await new Promise((r) => { const s = connect({ host: '127.0.0.1', port }, () => { s.destroy(); r(true) }); s.once('error', () => r(false)) })
      if (up) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    let token = ''
    for (let i = 0; i < 30 && token === ''; i++) {
      const m = /dsh web: http:\/\/\S+\?token=(\S+)/.exec(buf)
      if (m) token = m[1]
      else await new Promise((r) => setTimeout(r, 1000))
    }
    if (token === '') { console.log(label, 'NO TOKEN'); return }
    // cookie 交换（浏览器同款路径）
    const cookie = await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: `/?token=${token}`, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } }, (res) => {
        res.resume()
        res.on('end', () => { const sc = res.headers['set-cookie']; resolve(Array.isArray(sc) ? sc[0].split(';')[0] : '') })
      })
      req.end()
    })
    const a = await rpc(port, cookie, '/api/host/describe')
    console.log(label, 'host.describe:', a.status, a.text.slice(0, 300))
    const b = await rpc(port, cookie, '/api/session/list')
    console.log(label, 'session/list :', b.status, b.text.slice(0, 500))
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 800))
  }
}

const AUTH_HOME = process.env.TEMP + '\\dsh-embed-home-auth'   // 带桥接插件
const NOBRIDGE = process.env.TEMP + '\\dsh-nobridge-home'      // 对照：rc.1 原生
rmSync(NOBRIDGE, { recursive: true, force: true })
mkdirSync(NOBRIDGE, { recursive: true })
await runCase('[no-bridge rc.1]', NOBRIDGE, 3599)
await runCase('[with-bridge rc.1]', AUTH_HOME, 3699)
process.exit(0)
