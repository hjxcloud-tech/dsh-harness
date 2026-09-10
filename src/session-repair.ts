/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/path/child_process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { t } from './i18n'
import { resolveExec } from './win-exec'

/**
 * 会话格式漂移修复（v2.4.0）——把 DSH 版本漂移导致的不可读会话修回可读。
 *
 * 背景（2026-09-10 诊断）：`SESSION_FORMAT_VERSION` 恒为 0，格式却换过几轮；
 * 0.1.5 起引入冻结 codec + 显式迁移链（v0→v1→v2→v3），任何历史形状差异都会让整个会话被拒收。
 * 已枚举三类可定点修复的漂移：
 *   ① `sourceEventSeqs` 嵌套区间（0.1.2 写）→ 展平为密集整数数组（0.1.1 形态）
 *   ② 非法规 `source.form`（第三方插件写，如桥接早期的 `bridge-edit`）→ 规范 `notice` + `summary`
 *   ③ `subagent/descriptor.data.version` 旧值（2）→ 3
 *
 * 实现要点：
 * - **修复器在子进程里跑**：会话是 zstd 多帧文件，而 Obsidian 的 Electron Node 既可能没有
 *   `node:zlib` zstd（Node < 22.15），也可能只解首帧——所以必须找一个具备 zstd 的 node，
 *   并把重活交给驱动脚本（本文件 buildSessionRepairDriverSource()）。
 * - **读**：自带 zstd 帧切分（Node 的 one-shot API 只解第一个帧，直接喂会静默丢行）。
 * - **写**：两个独立帧拼接（首帧必须恰好是一行 header，否则 DSH 启动即崩）。
 * - **先验后写**：改完先用 DSH 自带的 format catalog 复验，通过才落盘；否则原文件保持不动。
 * - **备份强制**：落盘前先把原文件复制进备份目录。
 */

/** 驱动脚本入参。 */
export interface SessionRepairDriverArgs {
  mode: 'check' | 'repair'
  sessionsRoot: string
  backupDir?: string
}

/** 单个会话的处理结果。 */
export interface SessionRepairItem {
  path: string
  /** ok=可读；broken=校验失败；error=处理异常（未改动）。 */
  status: 'ok' | 'broken' | 'fixed' | 'error'
  /** 校验/异常原因（broken/error 时）。 */
  reason?: string
  /** 漂移分类计数（fixed 时）。 */
  fixes?: { seqs: number; form: number; descriptor: number }
  /** 是否已用 DSH catalog 复验（无 DSH 安装时为 false）。 */
  validated?: boolean
  bytesBefore?: number
  bytesAfter?: number
}

/** 汇总。 */
export interface SessionRepairSummary {
  mode: 'check' | 'repair'
  total: number
  ok: number
  broken: number
  fixed: number
  errors: number
  validating: boolean
  items: SessionRepairItem[]
}

/** 运行时：具备 zstd 的 node + DSH 安装包目录（驱动脚本的 cwd，用于解析 DSH 自身模块）。 */
export interface SessionRepairRuntime {
  nodePath: string
  cwd: string
  version: string
}

/** DSH 安装包目录候选（`<globalRoot>/node_modules/@deepseek-ai/dsh`）。 */
export function dshPackageDirCandidates(): string[] {
  const out: string[] = []
  try {
    const resolved = resolveExec(process.platform, 'npm', ['root', '-g'])
    const root = execFileSync(resolved.command, resolved.args, { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim()
    if (root !== '') out.push(join(root, '@deepseek-ai', 'dsh'))
  } catch {
    // npm 不可用：继续环境变量候选
  }
  const appdata = process.env.APPDATA
  if (appdata) out.push(join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  const prefix = process.env.NPM_CONFIG_PREFIX
  if (prefix) out.push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'))
  return [...new Set(out)]
}

/** node 可执行文件候选（需 Node ≥ 22.15 才有 node:zlib zstd）。 */
function nodeCandidates(): string[] {
  const out: string[] = []
  try {
    const resolved = resolveExec(process.platform, 'node', [])
    out.push(resolved.command === 'cmd.exe' ? 'node' : resolved.command)
  } catch {
    out.push('node')
  }
  const pf = process.env['ProgramFiles']
  if (pf) out.push(join(pf, 'nodejs', 'node.exe'))
  const pf86 = process.env['ProgramFiles(x86)']
  if (pf86) out.push(join(pf86, 'nodejs', 'node.exe'))
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) out.push(join(localAppData, 'Programs', 'nodejs', 'node.exe'))
  return [...new Set(out)]
}

/** 探测某个 node 是否具备 zstd 能力；返回版本号或 null。 */
export function probeZstdNode(nodePath: string): string | null {
  try {
    const out = execFileSync(nodePath, ['-e', "process.stdout.write(process.version+' '+typeof require('node:zlib').zstdDecompressSync)"], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }).trim()
    const [version, kind] = out.split(' ')
    return kind === 'function' ? version : null
  } catch {
    return null
  }
}

/** 找一个具备 zstd 的 node + 一个存在的 DSH 安装目录（cwd）。失败返回 null 并给出原因。 */
export function resolveSessionRepairRuntime(): { ok: true; runtime: SessionRepairRuntime } | { ok: false; error: string } {
  let nodePath = ''
  let version = ''
  for (const candidate of nodeCandidates()) {
    const v = probeZstdNode(candidate)
    if (v !== null) {
      nodePath = candidate
      version = v
      break
    }
  }
  if (nodePath === '') return { ok: false, error: t('repair.noZstdNode') }
  const pkgDir = dshPackageDirCandidates().find((dir) => existsSync(join(dir, 'package.json')))
  if (pkgDir === undefined) return { ok: false, error: t('repair.noDshInstall') }
  return { ok: true, runtime: { nodePath, cwd: pkgDir, version } }
}

/** 递归找出会话日志文件。 */
export function findSessionFiles(home: string): string[] {
  const root = join(home, 'sessions')
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === 'session.jsonl.zstd') out.push(p)
    }
  }
  walk(root)
  return out
}

/**
 * 会话修复驱动脚本（在具备 zstd 的 node 里以 `--input-type=module -e` 运行，cwd=DSH 安装包目录）。
 * 输出：每行一个 JSON（单个会话结果），最后一行 `{"summary":...}`。
 */
export function buildSessionRepairDriverSource(): string {
  return `import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const arg = JSON.parse(process.argv[1])
const { mode, sessionsRoot, backupDir } = arg
const ALLOWED = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])
const MAGIC = 0xfd2fb528

/** 切分 zstd 多帧（Node 的 one-shot API 只解第一帧）。 */
function splitFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4) throw new Error('truncated zstd magic at ' + off)
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error('bad zstd magic at ' + off)
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
      if (buf.length - off < 3) throw new Error('truncated block header at ' + off)
      const bh = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
      const last = bh & 1
      const type = (bh >> 1) & 3
      const size = bh >>> 3
      off += 3
      off += type === 1 ? 1 : size
      if (off > buf.length) throw new Error('truncated block payload at ' + off)
      if (last === 1) break
    }
    if (checksum === 1) off += 4
    frames.push(buf.subarray(start, off))
  }
  return frames
}

function decodeAll(path) {
  const buf = readFileSync(path)
  const frames = splitFrames(buf)
  let text = ''
  for (const frame of frames) text += zstdDecompressSync(frame).toString('utf8')
  return text
}

/** 多帧压缩：首帧恰好一行 header（DSH assertZstdHeaderFrame 要求），其余进第二帧。 */
function encodeTwoFrames(text) {
  const lines = text.split('\\n')
  const head = lines[0] + '\\n'
  const rest = lines.slice(1).join('\\n')
  return Buffer.concat([zstdCompressSync(Buffer.from(head, 'utf8')), zstdCompressSync(Buffer.from(rest, 'utf8'))])
}

function summarize(text) {
  let path = ''
  let loc = ''
  const mp = /目标文件：(.*?)；/.exec(text)
  if (mp) path = mp[1].trim()
  const ml = /选区（1 基行:列）：(.*?)；/.exec(text)
  if (ml) loc = ml[1].trim()
  return ['BRIDGES 编辑指令', path, loc].filter((s) => s !== '').join(' · ')
}

/** ① 嵌套区间 → 密集整数数组。返回改动数。 */
function fixSourceEventSeqs(obj) {
  const ses = obj.sourceEventSeqs
  if (!Array.isArray(ses)) return 0
  let nested = false
  for (const v of ses) {
    if (!Number.isInteger(v)) { nested = true; break }
  }
  if (!nested) return 0
  const out = []
  for (const v of ses) {
    if (Number.isInteger(v)) { out.push(v); continue }
    if (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x)) && v[1] >= v[0]) {
      for (let i = v[0]; i <= v[1]; i++) out.push(i)
      continue
    }
    throw new Error('unexpected sourceEventSeqs element: ' + JSON.stringify(v))
  }
  obj.sourceEventSeqs = out
  return 1
}

/** ② 非法 source.form → notice + summary。返回改动数。 */
function fixSourceForm(obj) {
  const d = obj.data
  if (d === null || typeof d !== 'object') return 0
  const src = d.source
  if (src === null || typeof src !== 'object') return 0
  const form = src.form
  if (typeof form !== 'string' || ALLOWED.has(form)) return 0
  let text = ''
  if (Array.isArray(d.content)) {
    for (const c of d.content) {
      if (c !== null && typeof c === 'object' && typeof c.text === 'string') { text = c.text; break }
    }
  }
  const next = { kind: src.kind, plugin: src.plugin, form: 'notice', summary: summarize(text) }
  d.source = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined))
  return 1
}

/** ③ subagent/descriptor.data.version → 3。返回改动数。 */
function fixDescriptorVersion(obj) {
  if (obj.type !== 'subagent/descriptor') return 0
  const d = obj.data
  if (d === null || typeof d !== 'object') return 0
  if (d.version === 3) return 0
  d.version = 3
  return 1
}

/**
 * ④ user/message 缺 data.id/data.role → 补齐（v2.4.0，2026-09-10 真机崩溃）。
 * 症状：「session event at seq N lacks an identified message」→ 整个会话读不出来。
 * 成因：插件 pre-step 注入的消息一度只返回 { source, content }；DSH 迁移链只替**旧**事件补 id
 * （legacy-message:&lt;sessionId&gt;:&lt;seq&gt;），运行期新注入的事件不走迁移，无人补。
 * 范围**只限 user/message**：真机会话实测只有该类型的 data 天然带 id+role
 * （assistant/message 是 turn/step/message/usage，tool-call-chunks 的 id 是 chunk id），
 * 越界改其它类型会让 v0→v1 迁移链拒绝整个会话。
 */
function fixMessageIdentity(obj, sid) {
  if (obj.type !== 'user/message') return 0
  const d = obj.data
  if (d === null || typeof d !== 'object') return 0
  let n = 0
  if (typeof d.id !== 'string' || d.id === '') {
    d.id = 'legacy-message:' + sid + ':' + String(obj.seq)
    n += 1
  }
  if (typeof d.role !== 'string' || d.role === '') {
    d.role = 'user'
    n += 1
  }
  return n
}

let catalog = null
try {
  catalog = (await import('@deepseek-ai/dsh-session-format-catalog')).sessionFormatCatalog
} catch {
  catalog = null
}

/** 用 DSH 自带的迁移链复验（无 catalog 时返回 validated:false，不阻断本地修复）。 */
function validate(text) {
  if (catalog === null) return { ok: true, validated: false }
  const lines = text.split('\\n').filter((l) => l.length > 0)
  if (lines.length === 0) return { ok: false, reason: 'empty session', validated: true }
  let restore
  try {
    restore = catalog.createRestore(JSON.parse(lines[0]), { recovery: 'recoverable', validation: 'transformed' })
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), validated: true }
  }
  try {
    for (let i = 1; i < lines.length; i++) restore.decodeRow(JSON.parse(lines[i]))
    restore.finish()
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), validated: true }
  }
  return { ok: true, validated: true }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n')
}

const files = arg.files
let ok = 0
let broken = 0
let fixed = 0
let errors = 0
let validating = catalog !== null

for (const path of files) {
  let text
  try {
    text = decodeAll(path)
  } catch (err) {
    errors += 1
    emit({ path, status: 'error', reason: 'decode: ' + String(err && err.message ? err.message : err) })
    continue
  }
  const before = validate(text)
  if (mode === 'check') {
    if (before.ok) { ok += 1; emit({ path, status: 'ok', validated: before.validated }) }
    else { broken += 1; emit({ path, status: 'broken', reason: before.reason, validated: before.validated }) }
    continue
  }
  // repair：无论是否可读都尝试规范化（幂等），只在"改完可读"且"确有改动"时落盘
  let changed = { seqs: 0, form: 0, descriptor: 0, identity: 0 }
  const outLines = []
  const lines = text.split('\\n')
  let sid = 'session'
  try {
    const h = JSON.parse(lines[0] || '{}')
    sid = String((h && (h.id ?? h.sessionId ?? h.session)) ?? 'session')
  } catch {
    sid = 'session'
  }
  let parseError = ''
  for (const line of lines) {
    if (line === '') { outLines.push(line); continue }
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      outLines.push(line)
      continue
    }
    try {
      changed.seqs += fixSourceEventSeqs(obj)
      changed.form += fixSourceForm(obj)
      changed.descriptor += fixDescriptorVersion(obj)
      changed.identity += fixMessageIdentity(obj, sid)
    } catch (err) {
      parseError = String(err && err.message ? err.message : err)
    }
    outLines.push(JSON.stringify(obj))
  }
  const totalChanged = changed.seqs + changed.form + changed.descriptor + changed.identity
  if (parseError !== '') {
    errors += 1
    emit({ path, status: 'error', reason: parseError, fixes: changed })
    continue
  }
  if (totalChanged === 0) {
    if (before.ok) { ok += 1; emit({ path, status: 'ok', validated: before.validated }) }
    else { broken += 1; emit({ path, status: 'broken', reason: before.reason, validated: before.validated }) }
    continue
  }
  const fixedText = outLines.join('\\n')
  const after = validate(fixedText)
  if (!after.ok) {
    broken += 1
    emit({ path, status: 'broken', reason: 'still invalid after fixes: ' + String(after.reason), fixes: changed, validated: after.validated })
    continue
  }
  try {
    const bytesBefore = statSync(path).size
    if (backupDir) {
      mkdirSync(backupDir, { recursive: true })
      const rel = path.slice(sessionsRoot.length).replace(/^[\\\\/]+/, '').replace(/[\\\\/]/g, '__')
      copyFileSync(path, join(backupDir, rel + '.bak'))
    }
    const blob = encodeTwoFrames(fixedText)
    const tmp = path + '.repair-tmp-' + process.pid
    writeFileSync(tmp, blob)
    renameSync(tmp, path)
    fixed += 1
    emit({ path, status: 'fixed', fixes: changed, validated: after.validated, bytesBefore, bytesAfter: blob.length })
  } catch (err) {
    errors += 1
    emit({ path, status: 'error', reason: 'write: ' + String(err && err.message ? err.message : err), fixes: changed })
  }
}

emit({ summary: true, mode, total: files.length, ok, broken, fixed, errors, validating })
`
}

/** 运行驱动脚本（异步，逐行回调结果）。 */
export function runSessionRepairDriver(
  runtime: SessionRepairRuntime,
  args: SessionRepairDriverArgs & { files: string[] },
  onItem?: (item: SessionRepairItem) => void,
): Promise<{ ok: true; summary: SessionRepairSummary } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(runtime.nodePath, ['--input-type=module', '-e', buildSessionRepairDriverSource(), JSON.stringify(args)], {
      cwd: runtime.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buffer = ''
    let stderr = ''
    let summary: SessionRepairSummary | null = null
    const items: SessionRepairItem[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
        if (line === '') continue
        try {
          const parsed = JSON.parse(line) as (SessionRepairItem & { summary?: boolean }) | { summary: true; mode: string; total: number; ok: number; broken: number; fixed: number; errors: number; validating: boolean }
          if ('summary' in parsed && parsed.summary === true) {
            summary = parsed as unknown as SessionRepairSummary
          } else {
            const item = parsed as SessionRepairItem
            items.push(item)
            onItem?.(item)
          }
        } catch {
          // 非 JSON 行（驱动脚本自身的日志）：忽略
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message })
    })
    child.on('close', (code) => {
      if (summary === null) {
        resolve({ ok: false, error: stderr.trim() !== '' ? stderr.trim().slice(0, 400) : t('repair.driverFail', { code: String(code ?? -1) }) })
        return
      }
      resolve({ ok: true, summary: { ...summary, items } })
    })
  })
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
