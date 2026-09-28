/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/path/child_process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { t } from './i18n'
import { resolveExec } from './win-exec'

/**
 * 会话格式漂移修复（v2.4.0）——把 DSH 版本漂移导致的不可读会话修回可读。
 *
 * 背景（2026-09-10 诊断）：`SESSION_FORMAT_VERSION` 恒为 0，格式却换过几轮；
 * 0.1.5 起引入冻结 codec + 显式迁移链（v0→v1→v2→v3），任何历史形状差异都会让整个会话被拒收。
 * 已枚举五类可定点修复的漂移：
 *   ① `sourceEventSeqs` 嵌套区间（0.1.2 写）→ 展平为密集整数数组（0.1.1 形态）
 *   ② 非法规 `source.form`（第三方插件写，如桥接早期的 `bridge-edit`）→ 规范 `notice` + `summary`
 *   ③ `subagent/descriptor.data.version` 旧值（2）→ 3（**只升已知旧值**，其它值不动，防把未来的 4 改回 3）
 *   ④ `user/message` 缺 `data.id` / `data.role` → 补齐
 *   ⑤（v4）`source.kind === 'plugin'` 退役形态 → 生产者自有 kind（对齐官方 `producerKind()` 映射表）
 *
 * 实现要点：
 * - **修复器在子进程里跑**：会话是 zstd 多帧文件，而 Obsidian 的 Electron Node 既可能没有
 *   `node:zlib` zstd（Node < 22.15），也可能只解首帧——所以必须找一个具备 zstd 的 node，
 *   并把重活交给驱动脚本（本文件 buildSessionRepairDriverSource()）。
 * - **入参走临时文件**（v2.8.6）：驱动脚本源码 13,187 字符，再把全部会话绝对路径塞进
 *   `node -e` 的命令行时，203 个会话 = 37,897 字符 > Windows CreateProcess 上限 32,767
 *   ⇒ 真机 `spawn ENAMETOOLONG`，会话一多整个功能直接跑不起来。现在参数清单落进一次性
 *   临时目录里的 `args.json`，命令行只剩脚本 + 一条短路径，会话数量不再受上限约束。
 * - **读**：自带 zstd 帧切分（Node 的 one-shot API 只解第一个帧，直接喂会静默丢行）。
 * - **写**：两个独立帧拼接（首帧必须恰好是一行 header，否则 DSH 启动即崩）。
 * - **先验后写**：改完先用 DSH 自带的 format catalog 复验，通过才落盘；否则原文件保持不动。
 * - **备份强制**：落盘前先把原文件复制进备份目录。
 * - **活文件优先 v4**（v2.8.6）：0.1.7 起 DSH 只读写 `session.v4.jsonl.zstd`，v3/v0 是冻结的
 *   迁移源——只挑 v3 会系统性打偏（同 v2.4.0「只挑 v0」的老坑）。
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
  /** 漂移分类计数（fixed 时）。identity = 补齐消息 id/role 的数量；kind = v4 退役的 `kind:'plugin'` 改写数。 */
  fixes?: { seqs: number; form: number; descriptor: number; identity: number; kind: number }
  /** 是否已用 DSH catalog 复验（无 DSH 安装时为 false）。 */
  validated?: boolean
  /**
   * v2.7.0（0.1.7 适配 A1）：跨版本会话——header 版本低于 DSH 当前格式版本，静态 catalog 无法校验
   * （V_{n-1}→V_n 迁移边需要子会话证据），故**只报告不改写**；升级由 DSH 打开该会话时自行完成。
   */
  deferred?: boolean
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
  /** v2.7.0：因跨版本迁移而**未被本插件改写**的会话数（0.1.7+ 上的 v3 及更早会话）。 */
  deferred: number
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

/** dsh 0.1.5 迁移后的 v3 原生表示；0.1.7 起降级为「上一次迁移的产物」，仍在盘上。 */
export const SESSION_FILE_V3 = 'session.v3.jsonl.zstd'
/** 迁移前的遗留文件；0.1.5 起不再写入，仅作为迁移源保留。 */
export const SESSION_FILE_V0 = 'session.jsonl.zstd'
/** dsh 0.1.7（会话格式 v4）实际读写的活文件（v2.8.6 起优先取它）。 */
export const SESSION_FILE_V4 = 'session.v4.jsonl.zstd'

/**
 * 递归找出会话日志文件，**每个会话目录只取一个**，优先级 v4 > v3 > v0：
 * 有 v4 就是 0.1.7+ 的活文件；否则取 v3（0.1.5/0.1.6 的活文件）；再退回 v0（尚未迁移的老会话）。
 *
 * 漏掉 v4 与漏掉 v3 是同一个坑的两代：dsh 每次升格式就换文件名并只读写新那份，旧份就此冻结。
 * v2.4.0 的教训是「只挑 `session.jsonl.zstd` 会系统性打偏」（真机证据：`session/page` 报
 * `past cursor 23957`，23957 正是 v3 的最大 seq，v0 的 seq 稀疏到 160 万）；
 * 0.1.7-rc.2 本机复测同一形状：`session.v4.jsonl.zstd` 共 19 个，其中 8 个目录**只有 v4**
 * ——按旧枚举它们完全不在视野内，另外 11 个会被挑到冻结的 v3。修冻结文件对"会话打不开"毫无帮助。
 */
export function findSessionFiles(home: string): string[] {
  const root = join(home, 'sessions')
  const byDir = new Map<string, { v4?: string; v3?: string; v0?: string }>()
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(p)
        continue
      }
      if (entry.name === SESSION_FILE_V4 || entry.name === SESSION_FILE_V3 || entry.name === SESSION_FILE_V0) {
        const rec = byDir.get(dir) ?? {}
        if (entry.name === SESSION_FILE_V4) rec.v4 = p
        else if (entry.name === SESSION_FILE_V3) rec.v3 = p
        else rec.v0 = p
        byDir.set(dir, rec)
      }
    }
  }
  walk(root)
  const out: string[] = []
  for (const rec of byDir.values()) {
    const picked = rec.v4 ?? rec.v3 ?? rec.v0
    if (picked !== undefined) out.push(picked)
  }
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

// 入参来自 argv[1] 指向的 JSON 文件，**不是命令行本身**：会话一多，命令行会超 Windows
// CreateProcess 的 32,767 字符上限（真机 203 个会话 = 37,897 字符 ⇒ spawn ENAMETOOLONG）。
const arg = JSON.parse(readFileSync(process.argv[1], 'utf8'))
const { mode, sessionsRoot, backupDir } = arg
const ALLOWED = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])
const MAGIC = 0xfd2fb528
// dsh-session 的 assertMessageEventShape：这几类事件的消息必须"已识别"（非空字符串 id）+ role 匹配。
// 角色表**按格式版本分档**（官方 MESSAGE_ROLE_BY_TYPE，dsh-session/lib/index.js:1143-1149，0.1.7-rc.2 逐字核对）：
//   v3 及更早：tool/result 的消息 role 是 'user'，没有 developer/message；
//   v4：tool/result 改成 'tool'，并新增 developer/message → 'developer'。
// 真机取证（本机 ~/.dsh）：v3 会话 tool/result role=user ×5421；v4 会话 role=tool ×62。
// 用一张表量两代会把 v4 会话整批误判为不可读（0.1.7-rc.2 实测 13 个假 broken）。
// user/message 的 data 本身就是消息；其余类别的消息在 data.message / 数组槽位下。
const MSG_ROLE_V3 = { 'system/message': 'system', 'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'user' }
const MSG_ROLE_V4 = { 'system/message': 'system', 'developer/message': 'developer', 'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'tool' }

function msgRoleTable(version) {
  return version >= 4 ? MSG_ROLE_V4 : MSG_ROLE_V3
}

/**
 * v4 的声明式消息槽位遍历，逐一对齐 dsh-session-format-v3-to-v4 的 mapEventMessages()：
 * user/message 的消息就是 data；developer/system/assistant/message 与 tool/result 在 data.message；
 * agent/inbox/spliced 在 data.inserted[]，session/title-llm-request 在 data.messages[]。
 * 官方 v4 校验 assertV4MessageSources 正是沿这条路径逐个 source 过闸——「连还躺在 inbox 里、
 * 没落成事件的注入也会被拦」，所以修复必须走同一组槽位，只看 data.source 会漏掉大半。
 */
const MSG_SLOT = { 'user/message': null, 'developer/message': 'message', 'system/message': 'message', 'assistant/message': 'message', 'tool/result': 'message' }
const MSG_ARRAY_SLOT = { 'agent/inbox/spliced': 'inserted', 'session/title-llm-request': 'messages' }

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function eachMessage(obj, fn) {
  const d = obj.data
  if (!isObj(d)) return 0
  const t = obj.type
  if (Object.prototype.hasOwnProperty.call(MSG_SLOT, t)) {
    const slot = MSG_SLOT[t]
    if (slot === null) return fn(d)
    const m = d[slot]
    return isObj(m) ? fn(m) : 0
  }
  const key = Object.prototype.hasOwnProperty.call(MSG_ARRAY_SLOT, t) ? MSG_ARRAY_SLOT[t] : undefined
  if (key === undefined) return 0
  const arr = d[key]
  if (!Array.isArray(arr)) return 0
  let n = 0
  for (const m of arr) { if (isObj(m)) n += fn(m) }
  return n
}

/**
 * ⑤ v4 起 kind:'plugin' 是退役形态，v4 codec 直接硬拒
 * （format v4 message requires a producer-owned source kind）。下面的映射表逐字复刻
 * @deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js L50-93（0.1.7-rc.2 实测），
 * 表外一律退化为 'plugin:<插件名>'——与官方 default 分支一致，也与本插件桥接自 v2.7.1
 * 起发送的形态同源（src/bridge.ts 的 BRIDGE_SOURCE_KIND = plugin:dsh-obsidian-bridge）。
 * 注意：本函数位于模板字符串内，注释里不得出现反引号（会提前终结字符串）。
 */
const RENAMED_PRODUCERS = { compact: 'compact-checkpoint', 'tools-code-mode': 'ptc-mode', 'tools-ptc': 'ptc-mode', 'dsh-compaction-basic': 'compact-basic', '@deepseek-ai/dsh-system-prompt': 'runtime-context' }
const SAME_NAME_PRODUCERS = new Set(['agent-instructions', 'session-reference', 'team-message', 'goal', 'skill-invocation', 'skill-catalog', 'coordinator', 'subagent-report', 'subagent-settled', 'webhook', 'agent-message', 'model-selection', 'plan-mode', 'time-context', 'tmux-context', 'user-approval', 'repeat-tool-reminder', 'tool-cordis', 'cordis-host-runner', 'tool-goal', 'tool-jobs', 'hooks-codex', 'hooks-claude-code', 'schedule', 'dsh-session-title-llm'])

function producerKind(plugin, role) {
  if (plugin === '@deepseek-ai/dsh-system-prompt' && role === 'system') return 'system-prompt'
  if (Object.prototype.hasOwnProperty.call(RENAMED_PRODUCERS, plugin)) return RENAMED_PRODUCERS[plugin]
  if (SAME_NAME_PRODUCERS.has(plugin)) return plugin
  return 'plugin:' + plugin
}

function fixPluginSourceKind(obj, version) {
  if (!(version >= 4)) return 0
  return eachMessage(obj, (m) => {
    const src = m.source
    if (!isObj(src)) return 0
    if (src.kind !== 'plugin') return 0
    if (typeof src.plugin !== 'string' || src.plugin === '') return 0
    const kind = producerKind(src.plugin, m.role)
    const keys = Object.keys(src)
    // 官方 rewritePluginSource：只剩 {kind, plugin} 时塌缩成 {kind}；否则保留非身份字段并删掉 plugin
    m.source = keys.length === 2
      ? { kind }
      : Object.fromEntries(keys.filter((k) => k !== 'plugin').map((k) => [k, k === 'kind' ? kind : src[k]]))
    return 1
  })
}


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

/** ② 非法 source.form → notice + summary。沿 v4 的全部消息槽位遍历（inbox 里未落成事件的注入同样过闸）。返回改动数。 */
function fixSourceForm(obj) {
  return eachMessage(obj, (m) => {
    const src = m.source
    if (!isObj(src)) return 0
    const form = src.form
    if (typeof form !== 'string' || ALLOWED.has(form)) return 0
    let text = ''
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c !== null && typeof c === 'object' && typeof c.text === 'string') { text = c.text; break }
      }
    }
    const next = { kind: src.kind, plugin: src.plugin, form: 'notice', summary: summarize(text) }
    m.source = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined))
    return 1
  })
}

/** ③ subagent/descriptor 的已知旧版本 2 → 3；其它值一律不动。返回改动数。 */
function fixDescriptorVersion(obj) {
  if (obj.type !== 'subagent/descriptor') return 0
  const d = obj.data
  if (d === null || typeof d !== 'object') return 0
  // 依据（0.1.7-rc.2 逐字核对）：上游 SUBAGENT_DESCRIPTOR_VERSION = 3
  // （dsh-subagent/lib/index.js:1309）；v1+ codec 按 3 验收
  // （dsh-session-format-v0-to-v1/lib/index.js:1584）；v3→v4 的子会话证据只认 {1,2,3}
  // （dsh-session-format-v3-to-v4/lib/index.js:904-908）。
  // 旧实现把「任何非 3」都写成 3——上游将来发到 4 时会被我们降级改坏 ⇒ 收窄为只升已知旧值 2。
  if (d.version !== 2) return 0
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

// v2.7.0（0.1.7 适配 A1）：0.1.7 起 currentVersion=4，而**静态 catalog 的 V3→V4 迁移边要求显式提供
// 该 parent 的 historical child facts**（不给就抛「V3 catalog migration requires explicit historical
// child facts…」）。上游自己也不是用静态目录硬迁——它先由持久化层算出 related.facts 再调
// createSessionFormatCatalogWithChildren(facts)（dsh-session-persistence-jsonl/lib/index.js:2703）。
// ⇒ 本插件**无法**在离线态安全校验/改写低于 currentVersion 的会话：若照旧调用，任何 v3 会话都会被判
// broken 且"修复"永远修不动（0.1.7-rc.1 实测：同脚本对 0.1.5-rc.2 PASS、对 rc.1 FAIL）。
// 处置：探测 catalog 的当前格式版本，凡 header.version 低于它一律**只报告不改写**（deferred），
// 并把真相说清楚——升级由 DSH 打开会话时按官方迁移链完成。本地补检（缺 id/role）仍照常执行。
// 注意：本段注释位于模板字符串内，不得出现反引号（会提前终结字符串）。
let catalog = null
let catalogVersion = 0
try {
  const mod = await import('@deepseek-ai/dsh-session-format-catalog')
  catalog = mod.sessionFormatCatalog || null
  catalogVersion = Number(catalog && catalog.currentVersion) || 0
} catch {
  catalog = null
  catalogVersion = 0
}

/** 读 header 里的格式版本（读不出按 0＝v0/未知，不触发 deferred）。 */
function headerVersion(text) {
  try {
    const h = JSON.parse(text.split('\\n')[0] || '{}')
    return Number(h === null || typeof h !== 'object' ? 0 : h.version) || 0
  } catch {
    return 0
  }
}

/**
 * 本地补检「lacks an identified message」。
 *
 * 为什么必须自己查：catalog 的迁移链（createRestore/decodeRow）**不跑**
 * dsh-session 的 assertMessageEventShape —— 后者在 dsh-session 的读取路径里，
 * 不在格式迁移链里。真机实测：一个确凿缺 id 的会话，纯 catalog 校验返回 ok。
 * 于是预检会报"全部正常"，弹窗里「备份并修复」按钮因 broken===0 被禁用，
 * 这个功能对该故障等于不存在。
 *
 * 只对 v3 及以后生效：v0 的 user/message 本就没有 id/role（迁移链会补
 * legacy-message:<sid>:<seq>），按同一把尺子量会把全部老会话误判为损坏。
 *
 * 只在"消息对象存在但缺身份"时报错 —— 缺 data 属另一类损坏，不在此判定，避免误伤。
 */
function localValidate(text, version) {
  if (!(version >= 3)) return { ok: true }
  const roleTable = msgRoleTable(version)
  const lines = text.split('\\n')
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue
    let obj
    try { obj = JSON.parse(lines[i]) } catch { continue }
    const want = roleTable[obj.type]
    if (want === undefined) continue
    const d = obj.data
    if (d === null || typeof d !== 'object') continue
    const m = obj.type === 'user/message' ? d : d.message
    if (m === null || typeof m !== 'object') continue
    if (typeof m.id !== 'string' || m.id === '')
      return { ok: false, reason: 'session event at seq ' + String(obj.seq) + ' lacks an identified message' }
    if (m.role !== want)
      return { ok: false, reason: 'session event at seq ' + String(obj.seq) + ' message must have role \\"' + want + '\\"' }
  }
  return { ok: true }
}

/** 校验：先本地补检，再用 DSH 自带迁移链复验（无 catalog 时降级为未校验，不阻断本地修复）。 */
function validate(text) {
  const version = headerVersion(text)
  const local = localValidate(text, version)
  if (!local.ok) return { ok: false, reason: local.reason, validated: true }
  if (catalog === null) return { ok: true, validated: false }
  // 低于 catalog 当前格式：静态目录无法校验（V_{n-1}→V_n 边需要子会话证据）⇒ 只报告，不改写。
  if (catalogVersion > 0 && version > 0 && version < catalogVersion) {
    return {
      ok: true,
      validated: false,
      deferred: true,
      reason: 'v' + version + ' 会话：DSH 当前格式为 v' + catalogVersion + '，跨版本迁移需子会话证据，' +
        '由 DSH 打开该会话时自行完成；本插件不做代写（避免无法校验的盲改）',
    }
  }
  const lines = text.split('\\n').filter((l) => l.length > 0)
  if (lines.length === 0) return { ok: false, reason: 'empty session', validated: true }
  let restore
  try {
    restore = catalog.createRestore(JSON.parse(lines[0]), { recovery: 'recoverable', validation: 'transformed' })
  } catch (err) {
    const msg = String(err && err.message ? err.message : err)
    // 兜底：即使探测不到 catalog.currentVersion，DSH 自己抛的「需要 historical child facts」也必须
    // 判为「跨版本、本插件不代做」，而不是 broken（否则按钮变成一个永远修不动的假象）。
    if (/historical child facts|child facts/i.test(msg)) {
      return {
        ok: true,
        validated: false,
        deferred: true,
        reason: '该会话格式低于 DSH 当前版本，跨版本迁移需子会话证据，将由 DSH 打开该会话时自行完成；本插件不做代写',
      }
    }
    return { ok: false, reason: msg, validated: true }
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
let deferred = 0
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
    if (before.deferred) { deferred += 1; emit({ path, status: 'ok', deferred: true, validated: false, reason: before.reason }); continue }
    if (before.ok) { ok += 1; emit({ path, status: 'ok', validated: before.validated }) }
    else { broken += 1; emit({ path, status: 'broken', reason: before.reason, validated: before.validated }) }
    continue
  }
  // repair：跨版本会话一律不改写（见上方 A1 注释：静态目录无法校验，先验后写的底线不能破）
  if (before.deferred) {
    deferred += 1
    emit({ path, status: 'ok', deferred: true, validated: false, reason: before.reason })
    continue
  }
  // repair：无论是否可读都尝试规范化（幂等），只在"改完可读"且"确有改动"时落盘
  let changed = { seqs: 0, form: 0, descriptor: 0, identity: 0, kind: 0 }
  const fileVersion = headerVersion(text)
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
      // ⑤ 仅 v4 生效。顺序要紧：先修 form（此时还会带上 kind/plugin），
      // 再把退役的 kind:'plugin' 升成生产者自有 kind 并删掉 plugin 字段。
      changed.kind += fixPluginSourceKind(obj, fileVersion)
      changed.descriptor += fixDescriptorVersion(obj)
      changed.identity += fixMessageIdentity(obj, sid)
    } catch (err) {
      parseError = String(err && err.message ? err.message : err)
    }
    outLines.push(JSON.stringify(obj))
  }
  const totalChanged = changed.seqs + changed.form + changed.descriptor + changed.identity + changed.kind
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
  // 写前守卫：跨版本（deferred）一律不落盘——它意味着"无法用官方迁移链校验"，先验后写的底线不能破
  if (after.deferred) {
    deferred += 1
    emit({ path, status: 'ok', deferred: true, validated: false, fixes: changed, reason: after.reason })
    continue
  }
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

emit({ summary: true, mode, total: files.length, ok, broken, fixed, errors, deferred, validating })
`
}

/**
 * 运行驱动脚本（异步，逐行回调结果）。
 *
 * **入参走一次性临时文件，不再塞进命令行**（v2.8.6）：老写法把会话的绝对路径清单直接
 * JSON.stringify 成 `node -e` 的 argv，本机 203 个会话时脚本 13,187 + 参数 24,710 =
 * **37,897 字符 > Windows CreateProcess 的 32,767 上限** ⇒ `spawn ENAMETOOLONG`，
 * 会话一多整个修复直接跑不起来（真机复现）。现在 argv 只有脚本源码 + 一个短路径，
 * 与文件数量彻底解耦；脚本本身仍用 `-e`（不落成 .mjs），因为 `-e` 的模块解析基准是 cwd，
 * 驱动里的 `@deepseek-ai/dsh-session-format-catalog` 裸包名要靠 cwd=DSH 安装包目录才解析得到。
 * 临时目录无论成功、失败还是子进程报错都必须删除。
 */
export function runSessionRepairDriver(
  runtime: SessionRepairRuntime,
  args: SessionRepairDriverArgs & { files: string[] },
  onItem?: (item: SessionRepairItem) => void,
): Promise<{ ok: true; summary: SessionRepairSummary } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let dir = ''
    const cleanup = (): void => {
      if (dir === '') return
      const target = dir
      dir = ''
      try {
        rmSync(target, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不影响修复结果（下一次运行另建目录）
      }
    }
    try {
      dir = mkdtempSync(join(tmpdir(), 'dsh-repair-args-'))
      const argsPath = join(dir, 'args.json')
      writeFileSync(argsPath, JSON.stringify(args), 'utf8')
      // stdio 三条都写死：spawn 的泛型由 options 推出管道非空，下面可直接读 child.stdout/stderr
      const child = spawn(runtime.nodePath, ['--input-type=module', '-e', buildSessionRepairDriverSource(), argsPath], {
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
            const parsed = JSON.parse(line) as (SessionRepairItem & { summary?: boolean }) | { summary: true; mode: string; total: number; ok: number; broken: number; fixed: number; errors: number; deferred: number; validating: boolean }
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
        cleanup()
        resolve({ ok: false, error: err.message })
      })
      child.on('close', (code) => {
        cleanup()
        if (summary === null) {
          resolve({ ok: false, error: stderr.trim() !== '' ? stderr.trim().slice(0, 400) : t('repair.driverFail', { code: String(code ?? -1) }) })
          return
        }
        resolve({ ok: true, summary: { ...summary, items } })
      })
    } catch (err) {
      // 建目录 / 写参数 / 起进程失败：临时目录不留，也不静默当成功
      cleanup()
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
