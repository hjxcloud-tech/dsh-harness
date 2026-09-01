/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/path/child_process) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, execFileSync, type ExecException } from 'node:child_process'
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { t } from './i18n'
import { resolveExec } from './win-exec'

/**
 * 卸载并重装 DSH（v2.2.0）——保留聊天记录。
 *
 * 数据布局（~/.dsh）：
 * - 保留 + 备份：sessions/（聊天记录）、attachments/（附件）、skills/（用户技能）、
 *   .credentials.yaml（API 凭据）、settings.yaml（模型/Provider 配置）；
 * - 删除（崩溃源/可再生成）：profiles/（bundle 注册、cordis.patch.yml、node_modules、桥接）、
 *   plugins/、storages/、cache/、logs/、doctor/、llm-deepseek/，以及全局 CLI 包 @deepseek-ai/dsh。
 *
 * 策略：聊天记录「不删除 + 额外备份」双保险——删除过程任何意外都不丢数据；
 * 备份失败立即中止（不动原文件）。
 */

/** 保留（备份 + 不删除）的 ~/.dsh 顶层条目。 */
export const CLEANUP_KEEP_ITEMS = ['sessions', 'attachments', 'skills', '.credentials.yaml', 'settings.yaml'] as const

/** 删除（卸载）的 ~/.dsh 顶层目录白名单（崩溃源/可再生成）。 */
export const CLEANUP_WIPE_DIRS = ['profiles', 'plugins', 'storages', 'cache', 'logs', 'doctor', 'llm-deepseek'] as const

/** 备份清单文件名。 */
export const CLEANUP_MANIFEST = 'manifest.json'

export interface CleanupBackupManifest {
  timestamp: string
  dshHome: string
  items: Array<{ name: string; kind: 'dir' | 'file'; files: number; bytes: number }>
  totalFiles: number
  totalBytes: number
}

export interface BackupResult {
  backupDir: string
  totalFiles: number
  totalBytes: number
  items: CleanupBackupManifest['items']
}

export interface RestoreResult {
  restored: Array<{ name: string; kind: 'dir' | 'file' }>
}

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(exec: typeof execFile, command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  // Windows 下 npm 系命令是 .cmd shim，execFile 无法直接启动（ENOENT）→ 经 cmd.exe 包装
  const resolved = resolveExec(process.platform, command, args)
  return new Promise((resolvePromise) => {
    exec(resolved.command, resolved.args, { timeout: timeoutMs, windowsHide: true }, (err: ExecException | null, stdout: string, stderr: string) => {
      if (err) {
        resolvePromise({ ok: false, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() })
      } else {
        resolvePromise({ ok: true, out: String(stdout ?? '').trim(), err: '' })
      }
    })
  })
}

/** 检测某命令是否可用（which/where）。 */
function hasBin(name: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(probe, [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 默认备份目录：DSH home 旁 `~/.dsh-backup-<yyyyMMdd-HHmmss>/`（不进 vault、同盘）。 */
export function defaultCleanupBackupDir(home: string): string {
  const ts = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-` +
    `${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
  return join(dirname(home), `${basename(home)}-backup-${stamp}`)
}

/** 人类可读字节数（i18n 展示用）。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return `${String(n)} B`
}

/** 递归统计目录内文件数与字节数。 */
async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true })
    for (const entry of entries) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        await walk(p)
      } else {
        files += 1
        try {
          bytes += (await stat(p)).size
        } catch {
          // 文件瞬时不可读：忽略计数
        }
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

/**
 * 备份聊天记录与用户资产到 backupDir（sessions/attachments/skills/.credentials.yaml/settings.yaml）。
 * 已存在的条目才备份（新装 DSH 可能没有 sessions 等）；写 manifest.json（时间/来源/文件数/字节数）。
 * 任一步失败抛错 → 调用方中止（原文件不动）。
 */
export async function backupDshData(home: string, backupDir: string): Promise<BackupResult> {
  await mkdir(backupDir, { recursive: true })
  const items: CleanupBackupManifest['items'] = []
  let totalFiles = 0
  let totalBytes = 0
  for (const name of CLEANUP_KEEP_ITEMS) {
    const src = join(home, name)
    if (!existsSync(src)) continue
    const isDir = (await stat(src)).isDirectory()
    if (isDir) {
      await cp(src, join(backupDir, name), { recursive: true })
      const counted = await countFiles(src)
      items.push({ name, kind: 'dir', files: counted.files, bytes: counted.bytes })
      totalFiles += counted.files
      totalBytes += counted.bytes
    } else {
      await copyFile(src, join(backupDir, name))
      const size = (await stat(src)).size
      items.push({ name, kind: 'file', files: 1, bytes: size })
      totalFiles += 1
      totalBytes += size
    }
  }
  const manifest: CleanupBackupManifest = {
    timestamp: new Date().toISOString(),
    dshHome: home,
    items,
    totalFiles,
    totalBytes,
  }
  await writeFile(join(backupDir, CLEANUP_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { backupDir, totalFiles, totalBytes, items }
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
 * 从备份幂等补齐缺失的会话/附件/凭据/设置/技能（双保险收尾）。
 * 正常路径下这些目录未被删除（wipe 只删白名单），此处仅校验；新 DSH 已生成同名数据时保留现状。
 */
export async function restoreDshData(backupDir: string, home: string): Promise<RestoreResult> {
  const restored: RestoreResult['restored'] = []
  for (const name of CLEANUP_KEEP_ITEMS) {
    const src = join(backupDir, name)
    const dst = join(home, name)
    if (!existsSync(src) || existsSync(dst)) continue
    if ((await stat(src)).isDirectory()) {
      await cp(src, dst, { recursive: true })
      restored.push({ name, kind: 'dir' })
    } else {
      await copyFile(src, dst)
      restored.push({ name, kind: 'file' })
    }
  }
  return { restored }
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
