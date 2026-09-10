/**
 * 2.6 根因 A/B 实证（v2.4.0）：
 *   packaged —— 新布局（独立包 package.json + index.mjs）
 *   legacy   —— 旧布局（.mjs 直接躺在 profile 根目录）
 * 两种模式都把 profile 清单的 version 删掉（模拟 dsh initProfile 的全新 profile），
 * 再启动 0.1.5-rc.1 并调用 pluginInventory/list —— 该接口内部即 collectActivePluginPackages
 * → resolver.resolve(entry) → nearestManifest + identityFromManifest，与请求扩展报错同一条代码路径。
 * 预期：packaged → ok:true 且列出 dsh-obsidian-bridge；legacy → ok:false（必须声明 name/version）。
 * 用法：node scripts/verify-inventory.mjs <bin.js> <home> <packaged|legacy>
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const [, , binPath, homeArg, mode] = process.argv
if (!binPath || !homeArg || !['packaged', 'legacy'].includes(mode)) {
  console.error('usage: node scripts/verify-inventory.mjs <bin.js> <home> <packaged|legacy>')
  process.exit(2)
}
const HOME = homeArg
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(PROFILE, { recursive: true })

// ---- 按布局写桥接（home 必须是 dsh 已初始化过、可启动的 profile 目录）----
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-inv-verify-'))
const outFile = join(bundleDir, 'bridge.cjs')
await build({ entryPoints: ['src/bridge.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: outFile })
const bridge = require(outFile)
if (mode === 'packaged') {
  const r = bridge.writeBridgeFiles(HOME, '2.4.0')
  if (r.error) {
    console.error('packaged install failed:', r.error)
    process.exit(3)
  }
} else {
  // 旧布局：根目录 .mjs + 指向它的补丁条目（先清掉新布局残留）
  rmSync(join(PROFILE, 'dsh-obsidian-bridge'), { recursive: true, force: true })
  const legacyPath = join(PROFILE, 'dsh-obsidian-bridge.mjs')
  writeFileSync(legacyPath, bridge.bridgePluginSource(), 'utf8')
  const url = `file:///${legacyPath.replaceAll('\\', '/')}`
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), `- insert:\n    - id: dsh-obsidian-bridge\n      name: ${url}\n`, 'utf8')
}

// ---- 关键：写入后删掉 profile 清单的 version，模拟 dsh initProfile 的全新 profile ----
// （legacy 模式靠 ensureProfileManifestVersion 兜底；packaged 模式应完全不依赖它）
const manifestPath = join(PROFILE, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
delete manifest.version
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`[setup] mode=${mode} profile.version=${String(manifest.version ?? '(none)')} bundles=${String((manifest.dsh?.profile?.bundles ?? []).length)}`)

// ---- 启动服务 ----
const PORT = mode === 'packaged' ? 3799 : 3899
const child = spawn(process.execPath, [binPath, 'web', '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let buf = ''
child.stdout.on('data', (d) => { buf += d })
child.stderr.on('data', (d) => { buf += d })
let token = ''
for (let i = 0; i < 150; i++) {
  const up = await new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); r(true) })
    s.once('error', () => r(false))
  })
  const m = /dsh web: http:\/\/\S+\?token=(\S+)/.exec(buf)
  if (m) token = m[1]
  if (up && token !== '') break
  await new Promise((r) => setTimeout(r, 1000))
}
if (token === '') {
  console.log('[boot] NO TOKEN; server output:\n' + buf.slice(0, 1200))
  child.kill()
  process.exit(1)
}
console.log('[boot] server up')

function rpc(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'inv1', method: path, payload })
    const req = request(
      { host: '127.0.0.1', port: PORT, path: `/api/${path}`, method: 'POST', headers: { host: `127.0.0.1:${String(PORT)}`, 'content-type': 'application/json', authorization: `Bearer ${token}` } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

for (const payload of [{ args: {} }, {}]) {
  const r = await rpc('pluginInventory/list', payload)
  console.log(`[pluginInventory/list] payload=${JSON.stringify(payload)} status=${String(r.status)}`)
  console.log('  ' + r.text.slice(0, 700))
}
console.log('---- bridge logs ----')
for (const line of buf.split(/\r?\n/).filter((l) => l.includes('dsh-obsidian-bridge'))) console.log('  ' + line)
child.kill()
rmSync(bundleDir, { recursive: true, force: true })
process.exit(0)
