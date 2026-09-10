/**
 * 会话修复端到端验证（v2.4.0 的「带备份一键修复」）：
 *   ① 取真实会话文件（隔离 home）→ 注入漂移（非法 source.form / descriptor version=2）→ 双帧重编码
 *   ② check  → 期望 broken（由 DSH 自带 catalog 判定）
 *   ③ repair → 期望 fixed（含备份、先验后写）
 *   ④ check  → 期望 ok
 * 用法：node scripts/verify-session-repair.mjs <隔离 home> <DSH 安装包目录>
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import process from 'node:process'

const require = createRequire(import.meta.url)
const [, , homeArg, dshPkgDir] = process.argv
if (!homeArg || !dshPkgDir) {
  console.error('usage: node scripts/verify-session-repair.mjs <home> <dshPackageDir>')
  process.exit(2)
}

// ---- 帧切分（与驱动脚本同逻辑；Node one-shot API 只解首帧）----
const MAGIC = 0xfd2fb528
function splitFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error('bad magic')
    off += 4
    const descriptor = buf[off]
    off += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const didFlag = descriptor & 3
    if (singleSegment === 0) off += 1
    off += [0, 1, 2, 4][didFlag]
    if (fcsFlag === 0) {
      if (singleSegment === 1) off += 1
    } else {
      off += [2, 4, 8][fcsFlag - 1]
    }
    for (;;) {
      const bh = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
      const last = bh & 1
      const type = (bh >> 1) & 3
      const size = bh >>> 3
      off += 3
      off += type === 1 ? 1 : size
      if (last === 1) break
    }
    if (checksum === 1) off += 4
    frames.push(buf.subarray(start, off))
  }
  return frames
}
function decodeAll(path) {
  let text = ''
  for (const frame of splitFrames(readFileSync(path))) text += zstdDecompressSync(frame).toString('utf8')
  return text
}
function encodeTwoFrames(text) {
  const lines = text.split('\n')
  return Buffer.concat([
    zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8')),
    zstdCompressSync(Buffer.from(lines.slice(1).join('\n'), 'utf8')),
  ])
}

// ---- 备用真源：找一个带 user/message 的真实会话文件 ----
function findRealSession(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === 'session.jsonl.zstd') out.push(p)
    }
  }
  walk(join(root, 'sessions'))
  // 取最小的若干（快），且要求含 user/message 行
  out.sort((a, b) => statSync(a).size - statSync(b).size)
  for (const p of out.slice(0, 12)) {
    try {
      const text = decodeAll(p)
      if (text.includes('"user/message"') || text.includes('"data":{"source"')) return { path: p, text }
    } catch {
      // 跳过解不开的
    }
  }
  return null
}

const home = homeArg
const work = mkdtempSync(join(tmpdir(), 'dsh-repair-verify-'))
const fixtureRoot = join(work, 'home')
const sessDir = join(fixtureRoot, 'sessions', '--fixture--', 'session-fixture-0001')
mkdirSync(sessDir, { recursive: true })

const real = findRealSession(home)
if (real === null) {
  console.error('未找到可用的真实会话样本（需要含 user/message 的 session.jsonl.zstd）')
  process.exit(3)
}
console.log(`[setup] 真实样本: ${real.path} (${String(Math.round(statSync(real.path).size / 1024))}KB)`)
copyFileSync(real.path, join(sessDir, 'session.jsonl.zstd.orig'))

/** 把连续段打包成区间（0.1.2 的写法），是密集数组的忠实等价形态。 */
function packSeqs(arr) {
  const out = []
  let i = 0
  while (i < arr.length) {
    let j = i
    while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j += 1
    if (j > i) out.push([arr[i], arr[j]])
    else out.push(arr[i])
    i = j + 1
  }
  return out
}

// ---- 注入漂移：非法 source.form + descriptor version 2 + 忠实打包的 sourceEventSeqs ----
const lines = real.text.split('\n')
let injected = { form: 0, descriptor: 0, seqs: 0, identity: 0 }
for (let i = 0; i < lines.length; i++) {
  if (lines[i] === '') continue
  let obj
  try {
    obj = JSON.parse(lines[i])
  } catch {
    continue
  }
  const d = obj.data
  if (d !== null && typeof d === 'object') {
    const src = d.source
    if (src !== null && typeof src === 'object' && typeof src.plugin === 'string' && src.plugin !== '') {
      src.form = 'bridge-edit'
      delete src.summary
      injected.form += 1
    }
  }
  if (obj.type === 'subagent/descriptor' && d !== null && typeof d === 'object' && d.version !== 2) {
    d.version = 2
    injected.descriptor += 1
  }
  // ④ 消息身份漂移（2026-09-10 真机崩溃）：user/message 的 data 缺 id/role
  if (injected.identity < 2 && obj.type === 'user/message' && d !== null && typeof d === 'object') {
    delete d.id
    delete d.role
    injected.identity += 1
  }
  if (
    injected.seqs < 2 &&
    obj.type === 'assistant/message' &&
    Array.isArray(obj.sourceEventSeqs) &&
    obj.sourceEventSeqs.every((v) => Number.isInteger(v)) &&
    obj.sourceEventSeqs.some((v, k) => k > 0 && v === obj.sourceEventSeqs[k - 1] + 1)
  ) {
    obj.sourceEventSeqs = packSeqs(obj.sourceEventSeqs)
    injected.seqs += 1
  }
  lines[i] = JSON.stringify(obj)
}
const target = join(sessDir, 'session.jsonl.zstd')
writeFileSync(target, encodeTwoFrames(lines.join('\n')))
console.log(`[setup] 注入漂移 form=${String(injected.form)} descriptor=${String(injected.descriptor)} seqs=${String(injected.seqs)} identity=${String(injected.identity)}`)

// ---- 用插件真源跑 check / repair / check ----
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-repair-bundle-'))
const outFile = join(bundleDir, 'repair.cjs')
await build({ entryPoints: ['src/session-repair.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: outFile })
const mod = require(outFile)
const runtime = { nodePath: process.execPath, cwd: dshPkgDir, version: process.version }
const files = [target]
const backupDir = join(work, 'backup')

async function run(mode) {
  const r = await mod.runSessionRepairDriver(runtime, { mode, sessionsRoot: join(fixtureRoot, 'sessions'), backupDir, files })
  if (!r.ok) {
    console.error(`[${mode}] driver failed:`, r.error)
    process.exit(4)
  }
  const items = r.summary.items.map((it) => `${it.status}${it.reason ? ' — ' + String(it.reason).slice(0, 120) : ''}${it.fixes ? ' fixes=' + JSON.stringify(it.fixes) : ''}`)
  console.log(`[${mode}] total=${String(r.summary.total)} ok=${String(r.summary.ok)} broken=${String(r.summary.broken)} fixed=${String(r.summary.fixed)} errors=${String(r.summary.errors)} validating=${String(r.summary.validating)}`)
  for (const line of items) console.log('   ' + line)
  return r.summary
}

const before = await run('check')
const repaired = await run('repair')
const after = await run('check')

const backupFiles = existsSync(backupDir) ? readdirSync(backupDir) : []
console.log(`[backup] ${String(backupFiles.length)} 个备份文件${backupFiles.length > 0 ? ': ' + backupFiles.join(', ') : ''}`)

const pass =
  before.ok === 0 && before.broken >= 1 &&
  repaired.fixed >= 1 &&
  after.ok >= 1 && after.broken === 0 &&
  backupFiles.length >= 1
console.log(`\n==== SESSION REPAIR RESULT: ${pass ? 'PASS' : 'FAIL'} ====`)
rmSync(work, { recursive: true, force: true })
rmSync(bundleDir, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
