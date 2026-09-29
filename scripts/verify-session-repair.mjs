/**
 * 会话修复端到端验证（v2.8.6 起覆盖两条路 + 真实规模）：
 *   ① 取真实会话（**优先 v4 活文件**）→ 按版本注入漂移 → 双帧重编码
 *   ② 同版本路（当前 DSH 就是 v4）：check 期望 broken → repair 期望 fixed → check 期望 ok → **必须有备份**
 *   ③ 跨版本路（样本比当前 DSH 旧）：期望 deferred，零改写、零备份（由 DSH 打开时自行迁移）
 *   ④ 真实规模：把 home 里**全部**会话路径一次性交给只读 check —— 老写法在这里 spawn ENAMETOOLONG
 * 用法：node scripts/verify-session-repair.mjs <隔离 home> <DSH 安装包目录>
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import process from 'node:process'
import { tempDir } from './tmp-track.mjs'

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

/** 按当前 DSH 的活文件优先级（v4 > v3 > v0）取一个含 user/message 的真实样本。 */
function findRealSession(root, names) {
  for (const name of names) {
    const out = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name === name) out.push(p)
      }
    }
    try {
      walk(join(root, 'sessions'))
    } catch {
      continue
    }
    out.sort((a, b) => statSync(a).size - statSync(b).size)
    for (const p of out.slice(0, 12)) {
      try {
        const text = decodeAll(p)
        if (text.includes('"user/message"')) return { path: p, name, text }
      } catch {
        // 跳过解不开的
      }
    }
  }
  return null
}

const home = homeArg
const work = tempDir('dsh-repair-verify-')
const fixtureRoot = join(work, 'home')
const sessDir = join(fixtureRoot, 'sessions', '--fixture--', 'session-fixture-0001')
mkdirSync(sessDir, { recursive: true })

const real = findRealSession(home, ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd'])
if (real === null) {
  console.error('未找到可用的真实会话样本（需要含 user/message 的会话文件）')
  process.exit(3)
}
const fileName = real.name
const headerVersion = (() => {
  try {
    return Number(JSON.parse(real.text.split('\n')[0]).version) || 0
  } catch {
    return 0
  }
}
)()
console.log(`[setup] 真实样本: ${real.path} (${String(Math.round(statSync(real.path).size / 1024))}KB, header.version=${String(headerVersion)}, 文件名 ${fileName})`)
copyFileSync(real.path, join(sessDir, fileName + '.orig'))

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

// ---- 注入漂移 ----
const lines = real.text.split('\n')
const isV4 = headerVersion >= 4
let injected = { form: 0, descriptor: 0, seqs: 0, identity: 0, kind: 0 }
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
    if (src !== null && typeof src === 'object' && typeof src.plugin !== 'string' && src.kind !== 'plugin') {
      if (isV4) {
        // v4：注入退役的通用 plugin 包裹（v4 codec 硬拒），同时把非法 form 一起塞进去
        if (injected.kind < 3) {
          obj.data.source = { kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'bridge-edit' }
          injected.kind += 1
          injected.form += 1
        }
      } else if (typeof src.kind === 'string') {
        src.form = 'bridge-edit'
        delete src.summary
        injected.form += 1
      }
    } else if (!isV4 && src !== null && typeof src === 'object' && typeof src.plugin === 'string' && src.plugin !== '' && injected.form < 2) {
      src.form = 'bridge-edit'
      delete src.summary
      injected.form += 1
    }
  }
  if (obj.type === 'subagent/descriptor' && d !== null && typeof d === 'object' && d.version !== 2) {
    d.version = 2
    injected.descriptor += 1
  }
  // 消息身份漂移（2026-09-10 真机崩溃）：user/message 的 data 缺 id/role
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
const target = join(sessDir, fileName)
writeFileSync(target, encodeTwoFrames(lines.join('\n')))
console.log(`[setup] 注入漂移 kind=${String(injected.kind)} form=${String(injected.form)} descriptor=${String(injected.descriptor)} seqs=${String(injected.seqs)} identity=${String(injected.identity)}`)

// ---- 用插件真源跑 check / repair / check ----
const bundleDir = tempDir('dsh-repair-bundle-')
const outFile = join(bundleDir, 'repair.cjs')
await build({ entryPoints: ['src/session-repair.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: outFile })
const mod = require(outFile)
const runtime = { nodePath: process.execPath, cwd: dshPkgDir, version: process.version }
const files = [target]
const backupDir = join(work, 'backup')

async function run(mode, list = files, root = join(fixtureRoot, 'sessions')) {
  const r = await mod.runSessionRepairDriver(runtime, { mode, sessionsRoot: root, backupDir: mode === 'repair' ? backupDir : undefined, files: list })
  if (!r.ok) {
    console.error(`[${mode}] driver failed:`, r.error)
    return null
  }
  const items = r.summary.items.map((it) => `${it.status}${it.reason ? ' — ' + String(it.reason).slice(0, 120) : ''}${it.fixes ? ' fixes=' + JSON.stringify(it.fixes) : ''}`)
  console.log(`[${mode}] total=${String(r.summary.total)} ok=${String(r.summary.ok)} broken=${String(r.summary.broken)} fixed=${String(r.summary.fixed)} errors=${String(r.summary.errors)} deferred=${String(r.summary.deferred)} validating=${String(r.summary.validating)}`)
  for (const line of items.slice(0, 4)) console.log('   ' + line)
  return r.summary
}

const before = await run('check')
const repaired = await run('repair')
const after = await run('check')

// ---- 真实规模：只读 check 一次性提交 home 全部会话（老写法在此必挂）----
const allFiles = mod.findSessionFiles(home)
const srcChars = mod.buildSessionRepairDriverSource().length
const argChars = JSON.stringify({ mode: 'check', sessionsRoot: join(home, 'sessions'), files: allFiles }).length
console.log(`[scale] 会话数=${String(allFiles.length)} 脚本 ${String(srcChars)} + 入参 ${String(argChars)} = ${String(srcChars + argChars)} 字符（旧写法受 Windows 上限 32767 约束）`)
const scaled = await run('check', allFiles, join(home, 'sessions'))
const v4Count = allFiles.filter((f) => f.includes('.v4.')).length
console.log(`[scale] 枚举命中 v4=${String(v4Count)} / 总计=${String(allFiles.length)}；只读复跑 ${scaled ? '成功' : '失败'}`)

const backupFiles = existsSync(backupDir) ? readdirSync(backupDir) : []
console.log(`[backup] ${String(backupFiles.length)} 个备份文件${backupFiles.length > 0 ? ': ' + backupFiles.join(', ') : ''}`)

if (before === null || repaired === null || after === null || scaled === null) {
  console.log('\n==== SESSION REPAIR RESULT: FAIL（driver 未能跑通）====')
  rmSync(work, { recursive: true, force: true })
  rmSync(bundleDir, { recursive: true, force: true })
  process.exit(1)
}

// v2.7.0（A1）起跨版本会话＝deferred（只报告不改写）；v2.8.6 起同版本会话必须真修
const crossVersion = !isV4
const pass = crossVersion
  ? repaired.deferred >= 1 && repaired.fixed === 0 && backupFiles.length === 0 && scaled.total === allFiles.length
  : before.broken >= 1 &&
    repaired.fixed >= 1 &&
    after.ok >= 1 &&
    after.broken === 0 &&
    backupFiles.length >= 1 &&
    scaled.total === allFiles.length &&
    Number(repaired.items[0]?.fixes?.kind ?? 0) >= 1
console.log(`[判定] 走${crossVersion ? '跨版本（deferred，样本 v' + String(headerVersion) + '）' : '同版本（v4 修复）'}分支：deferred=${String(repaired.deferred)} fixed=${String(repaired.fixed)} 备份=${String(backupFiles.length)} 规模=${String(scaled.total)}/${String(allFiles.length)}`)
console.log(`\n==== SESSION REPAIR RESULT: ${pass ? 'PASS' : 'FAIL'} ====`)
rmSync(work, { recursive: true, force: true })
rmSync(bundleDir, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
