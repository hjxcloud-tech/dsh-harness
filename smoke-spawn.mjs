import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
function winQuoted(p) { return /\s/.test(p) ? `"${p}"` : p }
const cmdLine = [winQuoted('pnpm'), ...['dsh','web','--port','3081'].map(winQuoted)].join(' ')
console.log('cmdLine:', cmdLine)
const child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], { cwd: 'D:\\deepseek-harness', detached: true, stdio: 'ignore', windowsHide: true })
console.log('pid:', child.pid)
child.on('error', (e) => console.log('SPAWN ERROR:', e.message))
child.on('exit', (c) => console.log('EXITED:', c))
const tcpProbe = (port) => new Promise((resolve) => { const s = connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })
;(async () => {
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await tcpProbe(3081)) { console.log('3081 ONLINE — auto-start works'); return }
  }
  console.log('3081 NEVER READY — FAILED')
  if (child.pid) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
})()
