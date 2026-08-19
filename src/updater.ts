/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { execFile, type ExecException } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './i18n'

/** 更新检查结果。 */
export interface UpdateCheckResult {
  state: 'up-to-date' | 'behind' | 'error'
  message: string
  pullCommand: string
}

/** 执行更新结果。 */
export interface PullResult {
  ok: boolean
  message: string
}

/** git 命令执行器（测试可注入）。 */
export type ExecFileFn = typeof execFile

/** 更新选项：只读镜像（官方 GitHub 被墙/不可达时的兜底源）。 */
export interface UpdateOptions {
  /** 只读镜像地址（如 gh-proxy.com 前缀）；提供时官方源失败会自动用镜像重试。 */
  mirrorUrl?: string
}

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(exec: ExecFileFn, args: string[], timeoutMs = 30000): Promise<RunResult> {
  return new Promise((resolve) => {
    exec('git', args, { timeout: timeoutMs, windowsHide: true }, (err: ExecException | null, stdout: string, stderr: string) => {
      if (err) {
        resolve({ ok: false, out: '', err: String(stderr ?? '').trim() })
      } else {
        resolve({ ok: true, out: String(stdout).trim(), err: '' })
      }
    })
  })
}

/**
 * 读取 DSH 仓库本地版本号：
 * - 优先读根 package.json 的 version 字段（正式版本号，如 0.1.0-rc.7）；
 * - 读不到时回退 git HEAD 前 7 位短哈希；
 * - 都不可用时返回 t('up.unknown')。
 */
export async function getLocalDshVersion(repoDir: string, exec: ExecFileFn = execFile): Promise<string> {
  try {
    const pkgPath = join(repoDir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.trim() !== '') {
        return pkg.version.trim()
      }
    }
  } catch {
    // package.json 缺失或解析失败时回退到 git 哈希
  }
  const r = await run(exec, ['-C', repoDir, 'rev-parse', 'HEAD'])
  return r.ok && r.out ? r.out.slice(0, 7) : t('up.unknown')
}

/**
 * 检查 DSH 更新：直接查询 GitHub 远端（git ls-remote origin HEAD），
 * 与本地 HEAD 比较。只读检测，不修改仓库。官方源不可达时自动改用只读镜像。
 */
export async function checkDshUpdates(
  repoDir: string,
  exec: ExecFileFn = execFile,
  opts: UpdateOptions = {},
): Promise<UpdateCheckResult> {
  const pullCommand = `cd "${repoDir}" && git pull`
  if (!repoDir || !existsSync(join(repoDir, '.git'))) {
    return {
      state: 'error',
      message: t('up.noRepo'),
      pullCommand,
    }
  }

  // 本地版本（完整 SHA，比较前统一截 7 位，避免 --short 变长导致误判）
  const local = await run(exec, ['-C', repoDir, 'rev-parse', 'HEAD'])
  if (!local.ok || !local.out) {
    return { state: 'error', message: t('up.noLocal'), pullCommand }
  }
  const localShort = local.out.slice(0, 7)

  // GitHub 上的最新版本（远端 HEAD，直接查远端，不依赖本地 fetch 缓存）；失败时尝试只读镜像
  let remote = await run(exec, ['-C', repoDir, 'ls-remote', 'origin', 'HEAD'], 45000)
  let mirrorTried = false
  if ((!remote.ok || !remote.out) && opts.mirrorUrl) {
    mirrorTried = true
    remote = await run(exec, ['-C', repoDir, 'ls-remote', opts.mirrorUrl, 'HEAD'], 45000)
  }
  if (!remote.ok || !remote.out) {
    const err = remote.err || t('err.unknown')
    return {
      state: 'error',
      message: t('up.githubFail', { err }) + (mirrorTried ? t('up.mirrorFail', { err }) : ''),
      pullCommand,
    }
  }
  const remoteShort = remote.out.split(/\s+/)[0]?.slice(0, 7) ?? ''

  if (localShort === remoteShort) {
    return { state: 'up-to-date', message: t('up.latest', { v: localShort }), pullCommand }
  }
  return {
    state: 'behind',
    message: t('up.behind', { local: localShort, remote: remoteShort }),
    pullCommand,
  }
}

/**
 * 执行 DSH 仓库更新：git pull --ff-only（快进式，不产生本地合并；
 * 本地有未提交改动时会失败并提示，避免覆盖用户改动）。官方源失败时自动改用只读镜像。
 */
export async function pullDshUpdates(
  repoDir: string,
  exec: ExecFileFn = execFile,
  opts: UpdateOptions = {},
): Promise<PullResult> {
  let pull = await run(exec, ['-C', repoDir, 'pull', '--ff-only', '--quiet'])
  let mirrorTried = false
  if (!pull.ok && opts.mirrorUrl) {
    mirrorTried = true
    pull = await run(exec, ['-C', repoDir, 'pull', '--ff-only', '--quiet', opts.mirrorUrl])
  }
  if (pull.ok) {
    return {
      ok: true,
      message: t('up.done', { dir: repoDir }),
    }
  }
  return {
    ok: false,
    message: t('up.fail', { err: pull.err || t('err.unknown') }) + (mirrorTried ? t('up.mirrorFail', { err: pull.err || t('err.unknown') }) : ''),
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
