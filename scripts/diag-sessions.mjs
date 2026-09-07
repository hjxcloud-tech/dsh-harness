/**
 * 诊断 2：对「正在运行的真实 DSH 服务」调用 session/list（正确 payload 形态 {args:{}}）。
 * token 来源：①插件捕获的启动日志 dsh-web-out-<port>.log ②临时自启服务场景下手动传参。
 * 只读诊断：不写任何数据。用法：node scripts/diag-sessions.mjs [port]
 */
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import process from 'node:process'

const PORT = Number(process.argv[2] ?? '3080')
const logPath = process.env.TEMP + `\\dsh-web-out-${String(PORT)}.log`
let token = ''
try {
  const log = readFileSync(logPath, 'utf8')
  const m = /dsh web: http:\/\/\S+\?token=(\S+)/.exec(log)
  if (m) token = m[1]
} catch { /* 无捕获日志 */ }
if (token === '') {
  console.log(`NO TOKEN in ${logPath} — 若服务非插件拉起，请从服务控制台复制 token 作为第三参数传入`)
  console.log('用法: node scripts/diag-sessions.mjs [port] [token]')
  if (!process.argv[3]) process.exit(2)
}
token = process.argv[3] ?? token

function rpc(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'd2', method: path.split('/').slice(2).join('/'), payload })
    const req = request(
      { host: '127.0.0.1', port: PORT, path: `${path}?token=${token}`, method: 'POST', headers: { host: `127.0.0.1:${String(PORT)}`, 'content-type': 'application/json' } },
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

const variants = [
  ['{args:{}} 空参', { args: {} }],
  ['裸 {}', {}],
]
for (const [label, payload] of variants) {
  try {
    const r = await rpc('/api/session/list', payload)
    console.log(`session/list ${label}: status=${String(r.status)}`)
    console.log('  ', r.text.slice(0, 600))
  } catch (e) {
    console.log(`session/list ${label}: ERROR ${String(e)}`)
  }
}
process.exit(0)
