/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/path/child_process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, type Dirent, type Stats } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { hasBin as hasBinInEnv, refreshedEnv } from './exec-env'
import { t } from './i18n'
import { resolveExec } from './win-exec'

/**
 * DSH 数据备份 / 卸载重装（v2.2.0 起；v2.9.8 改为「全量单一备份」）。
 *
 * 数据布局（~/.dsh）：
 * - 备份 + 保留：sessions/（聊天记录）、attachments/（附件）、skills/（注册技能）、
 *   profiles/（插件注册与运行物：cordis.patch.yml、package.json、node_modules、桥接、.plugin-manager）、
 *   plugins/（旧布局插件目录）、storages/（插件设置与工作区状态）、
 *   .credentials.yaml（API 凭据）、settings.yaml（模型/Provider 配置）、.env（环境变量）；
 * - 删除（崩溃源/可再生成）：profiles/、plugins/、storages/、cache/、logs/、doctor/、llm-deepseek/，
 *   以及全局 CLI 包 @deepseek-ai/dsh（重启后由重装流程写回）。
 *
 * 两条硬约束（2026-11-16 真机事故：更新后插件全丢、聊天记录看似消失）：
 * 1. **只保留最新一份备份**：每次备份成功后轮换掉同目录下的旧备份（只删本插件写的、命名匹配的目录）；
 * 2. **符号链接不能靠 fs.cp**：Windows junction 在 fs.cp 下会 EPERM（实测），故自己走树、
 *    把链接记进 manifest.json 的 links，恢复时按原 target 重建（失败只记录，不中断）。
 */

/** 备份（并在卸载重装时保留）的 ~/.dsh 顶层条目。 */
export const CLEANUP_KEEP_ITEMS = [
  'sessions', // 聊天记录
  'attachments', // 附件
  'skills', // 注册技能
  'profiles', // 插件注册与运行物（含 node_modules、桥接、.plugin-manager）
  'plugins', // 旧布局插件目录（存在才备份）
  'storages', // 插件设置与工作区状态
  '.credentials.yaml', // API 凭据
  'settings.yaml', // 模型/Provider 设置
  '.env', // 环境变量（代理、作者名等）
] as const

/** 删除（卸载）的 ~/.dsh 顶层目录白名单（崩溃源/可再生成）。 */
export const CLEANUP_WIPE_DIRS = ['profiles', 'plugins', 'storages', 'cache', 'logs', 'doctor', 'llm-deepseek'] as const

/** 恢复策略：备份侧覆盖目标（还原插件注册与运行物；新 DSH 生成的骨架不保留）。 */
const RESTORE_OVERWRITE_ITEMS: readonly string[] = ['skills', 'profiles', 'plugins', 'storages']

/** 备份清单文件名。 */
export const CLEANUP_MANIFEST = 'manifest.json'

/** 备份里跳过的符号链接（junction 等）：记录原 target，恢复时重建。 */
export interface CleanupBackupLink {
  /** 相对备份根目录的路径（以 / 分隔）。 */
  rel: string
  /** 记录时的目标路径（绝对路径；恢复时按原样重建）。 */
  target: string
  type: 'dir' | 'file'
}

export interface CleanupBackupManifest {
  /** 本插件写的备份标记；旧版备份没有 tool/kind（仍按 dshHome 识别为自家备份）。 */
  tool?: 'dsh-harness'
  kind?: 'full' | 'pre-upgrade'
  timestamp: string
  dshHome: string
  items: Array<{ name: string; kind: 'dir' | 'file'; files: number; bytes: number }>
  totalFiles: number
  totalBytes: number
  links?: CleanupBackupLink[]
}

export interface BackupResult {
  backupDir: string
  totalFiles: number
  totalBytes: number
  items: CleanupBackupManifest['items']
  /** 本次备份后轮换掉的旧备份目录（绝对路径）。 */
  pruned: string[]
  /** 记录在 manifest 里的符号链接数。 */
  links: number
}

export interface RestoreResult {
  restored: Array<{ name: string; kind: 'dir' | 'file'; files: number; overwritten: boolean }>
  linksRestored: number
  linksFailed: string[]
}

interface RunResult {
  ok: boolean
  out: string
  err: string
}

/** 复制树的结果（文件数/字节数/符号链接清单）。 */
interface CopyOutcome {
  files: number
  bytes: number
  links: CleanupBackupLink[]
}

function run(exec: typeof execFile, command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  // Windows 下 npm 系命令是 .cmd shim，execFile 无法直接启动（ENOENT）→ 经 cmd.exe 包装
  const resolved = resolveExec(process.platform, command, args)
  return new Promise((resolvePromise) => {
    // v2.8.11：合并 PATH（`npm uninstall -g` 在 macOS GUI 下找不到 npm 与其内部的 node）
    exec(resolved.command, resolved.args, { timeout: timeoutMs, windowsHide: true, env: refreshedEnv() }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        resolvePromise({ ok: false, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() })
      } else {
        resolvePromise({ ok: true, out: String(stdout ?? '').trim(), err: '' })
      }
    })
  })
}

/** 检测某命令是否可用（which/where）。v2.8.11：改走合并 PATH。 */
function hasBin(name: string): boolean {
  return hasBinInEnv(name)
}

/** 默认备份目录：DSH home 旁 `~/.dsh-backup-<yyyyMMdd-HHmmss>/`（不进 vault、同盘）。 */
export function defaultCleanupBackupDir(home: string): string {
  return join(dirname(home), `${basename(home)}-backup-${backupTimestamp()}`)
}

/** 人类可读字节数（i18n 展示用）。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return `${String(n)} B`
}

/** 备份时间戳 `yyyyMMdd-HHmmss`（目录名用，可读且可排序）。 */
export function backupTimestamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * 统计会话日志文件数（`<home>/sessions/**\/session.jsonl.zstd`）。
 * 用于升级后预检：把「磁盘上的会话数」与「新版能列出的会话数」对照，
 * 暴露会话格式漂移导致整段历史不可读的情况（见 2026-09-10 诊断报告）。
 */
export function countSessionLogs(home: string): number {
  const root = join(home, 'sessions')
  let count = 0
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
      else if (entry.name === 'session.jsonl.zstd' || /^session\.jsonl(\.zstd)?$/.test(entry.name)) count += 1
    }
  }
  walk(root)
  return count
}

/** 链接目标按「链接所在目录」解析成绝对路径（绝对 target 原样返回）。 */
function absoluteLinkTarget(linkPath: string, target: string): string {
  return resolve(dirname(linkPath), target)
}

/** 判断链接指向目录还是文件（目标不可达时按文件处理，至少能重建出来）。 */
async function linkTargetType(linkPath: string, target: string): Promise<'dir' | 'file'> {
  try {
    const st = await stat(absoluteLinkTarget(linkPath, target))
    return st.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'file'
  }
}

/**
 * 逐文件复制目录树，返回文件数/字节数，并把**符号链接（含 Windows junction）单独收集**。
 * 为什么不用 `fs.cp`：Windows 上重建 junction 需要 `symlink(..., 'junction')`，`fs.cp` 走普通
 * symlink 会 EPERM（本机实测），整份备份因此失败——而备份失败会中止升级。
 * @param overwrite false 时只补缺失文件（合并恢复用）
 */
async function copyTreeSafe(src: string, dst: string, overwrite: boolean): Promise<CopyOutcome> {
  const out: CopyOutcome = { files: 0, bytes: 0, links: [] }
  const walk = async (s: string, d: string, rel: string): Promise<void> => {
    await mkdir(d, { recursive: true })
    let entries: Dirent[]
    try {
      entries = await readdir(s, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const sp = join(s, entry.name)
      const dp = join(d, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      let st: Stats
      try {
        st = await lstat(sp)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        const target = await readlink(sp).catch(() => '')
        if (target !== '') {
          out.links.push({ rel: childRel, target: absoluteLinkTarget(sp, target), type: await linkTargetType(sp, target) })
        }
        continue
      }
      if (st.isDirectory()) {
        await walk(sp, dp, childRel)
        continue
      }
      if (!overwrite && existsSync(dp)) continue
      await copyFile(sp, dp)
      out.files += 1
      out.bytes += st.size
    }
  }
  await walk(src, dst, '')
  return out
}

/** 重建备份里记录的符号链接（已存在的不覆盖）。 */
async function restoreLinks(home: string, links: readonly CleanupBackupLink[]): Promise<{ ok: number; failed: string[] }> {
  let ok = 0
  const failed: string[] = []
  for (const link of links) {
    const dest = join(home, ...link.rel.split('/'))
    try {
      if (existsSync(dest)) {
        ok += 1
        continue
      }
      await mkdir(dirname(dest), { recursive: true })
      // Windows 目录链接必须用 'junction'（普通 symlink 需要管理员/开发者模式）
      const type = link.type === 'dir' && process.platform === 'win32' ? 'junction' : link.type
      await symlink(link.target, dest, type)
      ok += 1
    } catch {
      failed.push(link.rel)
    }
  }
  return { ok, failed }
}

/**
 * 判定某目录是否是本插件的备份（轮换只删自家产物）：
 * - 有 manifest.json 且含 `dshHome`（本插件写的；旧版也有这个字段）；
 * - 或旧版「升级前备份」形态：目录下只有 `sessions/` 或 `sessions-<yyyyMMdd-HHmmss>/`。
 */
async function isOwnBackup(dir: string): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  if (entries.some((e) => e.isFile() && e.name === CLEANUP_MANIFEST)) {
    const manifest = readCleanupManifest(dir)
    if (manifest !== null && typeof manifest.dshHome === 'string' && manifest.dshHome !== '') return true
  }
  return (
    entries.length > 0 &&
    entries.every((e) => e.isDirectory() && (e.name === 'sessions' || /^sessions-\d{8}-\d{6}$/.test(e.name)))
  )
}

/** 备份目录名后缀：`<home 名>-backup-<yyyyMMdd-HHmmss>`。 */
const BACKUP_SUFFIX_RE = /^\d{8}-\d{6}$/

/**
 * 轮换：删掉 DSH home 同级的旧备份目录，**只保留本次这一份**（用户定案：只最新备份覆盖旧备份）。
 * 安全边界：只认 `<home 名>-backup-<时间戳>` 命名的同父目录，且必须是本插件写的备份
 * （见 {@link isOwnBackup}）；删除失败不阻断（返回已删列表）。
 */
export async function pruneOldBackups(home: string, keepDir: string): Promise<string[]> {
  const parent = dirname(resolve(home))
  const prefix = `${basename(resolve(home))}-backup-`
  const keep = resolve(keepDir)
  let names: string[]
  try {
    names = await readdir(parent)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    if (!BACKUP_SUFFIX_RE.test(name.slice(prefix.length))) continue
    const full = resolve(join(parent, name))
    if (full === keep) continue
    if (!(await isOwnBackup(full))) continue
    try {
      await rm(full, { recursive: true, force: true })
      removed.push(full)
    } catch {
      // 单个旧备份删不掉（被占用/无权限）不影响本次备份
    }
  }
  return removed
}

/**
 * 全量备份聊天记录 + 插件 + 注册技能 + 凭据/设置到 backupDir，写完 manifest.json 后轮换旧备份。
 * 已存在的条目才备份（新装 DSH 可能没有 profiles 等）；任一步失败抛错 → 调用方中止（原文件不动）。
 * @param opts.kind 备份来源（'full'＝卸载重装前；'pre-upgrade'＝升级前），写入 manifest 供识别
 * @param opts.prune 是否轮换旧备份（默认 true）
 */
export async function backupDshData(
  home: string,
  backupDir: string,
  opts: { kind?: 'full' | 'pre-upgrade'; prune?: boolean } = {},
): Promise<BackupResult> {
  await mkdir(backupDir, { recursive: true })
  const items: CleanupBackupManifest['items'] = []
  const links: CleanupBackupLink[] = []
  let totalFiles = 0
  let totalBytes = 0
  for (const name of CLEANUP_KEEP_ITEMS) {
    const src = join(home, name)
    if (!existsSync(src)) continue
    const st = await lstat(src)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      const copied = await copyTreeSafe(src, join(backupDir, name), true)
      items.push({ name, kind: 'dir', files: copied.files, bytes: copied.bytes })
      totalFiles += copied.files
      totalBytes += copied.bytes
      for (const link of copied.links) links.push({ ...link, rel: `${name}/${link.rel}` })
    } else {
      await copyFile(src, join(backupDir, name))
      items.push({ name, kind: 'file', files: 1, bytes: st.size })
      totalFiles += 1
      totalBytes += st.size
    }
  }
  const manifest: CleanupBackupManifest = {
    tool: 'dsh-harness',
    kind: opts.kind ?? 'full',
    timestamp: new Date().toISOString(),
    dshHome: home,
    items,
    totalFiles,
    totalBytes,
    links,
  }
  await writeFile(join(backupDir, CLEANUP_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  const pruned = opts.prune === false ? [] : await pruneOldBackups(home, backupDir)
  return { backupDir, totalFiles, totalBytes, items, pruned, links: links.length }
}

/**
 * 升级前的全量备份（v2.9.8 取代「只备份 sessions」）：聊天记录 + 插件 + 技能 + 配置一起保底，
 * 结束后只保留最新一份。home 不存在或一个条目都没有时返回 null（新装用户无需备份）。
 */
export async function backupBeforeUpgrade(
  home: string,
  opts: { backupRoot?: string } = {},
): Promise<BackupResult | null> {
  if (!existsSync(home)) return null
  if (!CLEANUP_KEEP_ITEMS.some((name) => existsSync(join(home, name)))) return null
  return backupDshData(home, opts.backupRoot ?? defaultCleanupBackupDir(home), { kind: 'pre-upgrade' })
}

/**
 * 卸载 DSH 运行物与插件注册：删除白名单目录（profiles/plugins/storages/cache/logs/doctor/llm-deepseek）。
 * 路径守卫：目标必须解析在 home 之下且名称在白名单，防误删。返回实际删除的目录名。
 */
export async function wipeDshRuntime(home: string): Promise<string[]> {
  const removed: string[] = []
  const homeResolved = resolve(home)
  for (const name of CLEANUP_WIPE_DIRS) {
    const target = resolve(join(homeResolved, name))
    if (!target.startsWith(homeResolved + sep)) continue
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true })
      removed.push(name)
    }
  }
  return removed
}

/**
 * 卸载全局 CLI dsh（npm uninstall -g @deepseek-ai/dsh）。
 * dsh 未安装则跳过；卸载失败非阻断（重装会重新装 @latest）。返回提示文案。
 */
export async function uninstallGlobalCli(
  exec: typeof execFile = execFile,
  hasBinFn: (name: string) => boolean = hasBin,
): Promise<string> {
  if (!hasBinFn('dsh')) return t('cleanup.cliSkipped')
  const r = await run(exec, 'npm', ['uninstall', '-g', '@deepseek-ai/dsh', '--no-fund', '--no-audit'], 120000)
  return r.ok ? t('cleanup.cliDone') : t('cleanup.cliFail', { err: r.err || t('err.unknown') })
}

/**
 * 从备份恢复（v2.9.8 起覆盖插件链路）：
 * - `skills/profiles/plugins/storages`：备份侧覆盖（插件注册、依赖、桥接、设置都回到备份时的样子）；
 * - `sessions/attachments`：**合并**（只补缺失文件，新 DSH 已生成的会话绝不覆盖）；
 * - 顶层文件（凭据/设置/.env）：只在缺失时补，不覆盖用户刚重新配置的值；
 * - manifest.links 里的符号链接按原 target 重建，失败只记录（返回 linksFailed）。
 */
export async function restoreDshData(backupDir: string, home: string): Promise<RestoreResult> {
  const manifest = readCleanupManifest(backupDir)
  const restored: RestoreResult['restored'] = []
  for (const name of CLEANUP_KEEP_ITEMS) {
    const src = join(backupDir, name)
    if (!existsSync(src)) continue
    const dst = join(home, name)
    const srcSt = await lstat(src)
    if (srcSt.isSymbolicLink()) continue
    if (srcSt.isDirectory()) {
      const overwritten = RESTORE_OVERWRITE_ITEMS.includes(name)
      const copied = await copyTreeSafe(src, dst, overwritten)
      if (copied.files > 0) restored.push({ name, kind: 'dir', files: copied.files, overwritten })
    } else if (!existsSync(dst)) {
      await copyFile(src, dst)
      restored.push({ name, kind: 'file', files: 1, overwritten: false })
    }
  }
  const links = await restoreLinks(home, manifest?.links ?? [])
  return { restored, linksRestored: links.ok, linksFailed: links.failed }
}

/** 读取备份清单（用于校验/展示）；失败返回 null。 */
export function readCleanupManifest(backupDir: string): CleanupBackupManifest | null {
  try {
    return JSON.parse(readFileSync(join(backupDir, CLEANUP_MANIFEST), 'utf8')) as CleanupBackupManifest
  } catch {
    return null
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
