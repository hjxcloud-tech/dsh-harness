/**
 * 复现诊断：浏览器完成 token 交换（303+cookie）后，面板路径（ob=1）是否仍稳定 200。
 * 用法：node scripts/repro-blank.mjs
 */
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { connect } from 'node:net'
import process from 'node:process'

const HOME = process.env.TEMP + '\\dsh-embed-home-auth'
const bin = process.env.TEMP + '\\dsh-rc1-test\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const PORT = 3499
const child = spawn(process.execPath, [bin, 'web', '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let buf = ''
child.stdout.on('data', (d) => { buf += d })
child.stderr.on('data', (d) => { buf += d })

function tcp() {
  return new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port: PORT })
    s.once('connect', () => { s.destroy(); r(true) })
    s.once('error', () => r(false))
  })
}
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host: `127.0.0.1:${String(PORT)}`, ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode,
            len: body.length,
            hasEmbedVar: body.includes('__DSH_EMBED_TOKEN__="'),
            hasBoot: body.includes('__DSH_BOOT__'),
            setCookie: (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : '') || '',
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}
function postApi(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: {} })
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { host: `127.0.0.1:${String(PORT)}`, 'content-type': 'application/json', ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8').slice(0, 100) }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

for (let i = 0; i < 150; i++) { if (await tcp()) break; await new Promise((r) => setTimeout(r, 1000)) }
console.log('tcp up, waited ok; buf so far:\n' + buf)
let T = ''
for (let i = 0; i < 30; i++) {
  const m = /dsh web: http:\/\/\S+\?token=(\S+)/.exec(buf)
  if (m) { T = m[1]; break }
  await new Promise((r) => setTimeout(r, 1000))
}
if (!T) { console.log('NO LAUNCH URL, full buf:\n' + buf); child.kill(); process.exit(1) }
console.log('a) 面板首载 /?token&ob=1        :', JSON.stringify(await get(`/?token=${T}&ob=1`)))
console.log('b) 浏览器交换 /?token           :', JSON.stringify(await get(`/?token=${T}`)))
console.log('c) 面板再载 /?token&ob=1       :', JSON.stringify(await get(`/?token=${T}&ob=1`)))
console.log('d) 交换后 API Bearer           :', JSON.stringify(await postApi('/api/session/list', { authorization: 'Bearer ' + T })))
console.log('e) 交换后 API query            :', JSON.stringify(await postApi(`/api/session/list?token=${T}`)))
console.log('f) 裸 / （应仍 401）           :', JSON.stringify(await get('/')))
child.kill()
process.exit(0)
