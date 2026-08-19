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

/** 从 git 输出中提取首个 tag 版本号（形如 refs/tags/dsh-v0.1.0-rc.7 → 0.1.0-rc.7）。 */
function extractTagVersion(line: string): string | null {
  // 行格式：<sha>\trefs/tags/<tag>（排除 ^{} 等 peeled 行）
  const m = /refs\/tags\/[^^]*?([0-9]+\.[0-9]+\.[0-9]+[\w.-]*)$/.exec(line)
  return m ? m[1] : null
}

/** 解析版本号为可比较数字（核心 x.y.z + rc 序号），无法解析返回 null。 */
function parseVersion(v: string): { core: number[]; rc: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/.exec(v.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], rc: m[4] !== undefined ? Number(m[4]) : Infinity }
}

/** 语义化版本比较：核心数字逐段比，同核心时 rc 越大越新（正式版 rc=Infinity 最新）。返回 a>b?1 : a<b?-1 : 0。 */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1
  }
  if (pa.rc !== pb.rc) return pa.rc > pb.rc ? 1 : -1
  return 0
}

/** 从 tags 输出中找最大版本号（提取不到返回 null）。 */
function maxTagVersion(output: string): string | null {
  let best: string | null = null
  for (const line of output.split('\n')) {
    const v = extractTagVersion(line)
    if (v && (best === null || compareVersions(v, best) > 0)) best = v
  }
  return best
}

/**
 * 检查 DSH 更新：优先按「正式版本号（tag/package.json）」比较——
 * 本地 package.json version vs 远端最新 tag 版本；任一方无正式版本时回退提交哈希比较。
 * 只读检测，不修改仓库。官方源不可达时自动改用只读镜像。
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

  // 本地版本：优先 package.json 正式版本号，读不到回退提交哈希
  let localVersion: string | null = null
  let localHash = ''
  try {
    const pkgPath = join(repoDir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.trim() !== '') localVersion = pkg.version.trim()
    }
  } catch {
    // 读不到就回退哈希
  }
  const local = await run(exec, ['-C', repoDir, 'rev-parse', 'HEAD'])
  if (local.ok && local.out) {
    localHash = local.out.trim()
  } else if (!localVersion) {
    return { state: 'error', message: t('up.noLocal'), pullCommand }
  }

  // 远端 tags（正式版本来源）；失败时尝试只读镜像
  let tags = await run(exec, ['-C', repoDir, 'ls-remote', '--tags', 'origin'], 45000)
  let mirrorTried = false
  if ((!tags.ok || !tags.out) && opts.mirrorUrl) {
    mirrorTried = true
    tags = await run(exec, ['-C', repoDir, 'ls-remote', '--tags', opts.mirrorUrl], 45000)
  }
  if (!tags.ok) {
    const err = tags.err || t('err.unknown')
    return {
      state: 'error',
      message: t('up.githubFail', { err }) + (mirrorTried ? t('up.mirrorFail', { err }) : ''),
      pullCommand,
    }
  }
  const remoteVersion = maxTagVersion(tags.out)

  // 双方都有正式版本号 → 按版本比较；否则回退哈希比较
  if (localVersion && remoteVersion) {
    if (compareVersions(localVersion, remoteVersion) >= 0) {
      return { state: 'up-to-date', message: t('up.latest', { v: localVersion }), pullCommand }
    }
    return {
      state: 'behind',
      message: t('up.behindVer', { local: localVersion, remote: remoteVersion }),
      pullCommand,
    }
  }

  // 回退：远端 HEAD 哈希 vs 本地 HEAD 哈希
  let remote = await run(exec, ['-C', repoDir, 'ls-remote', 'origin', 'HEAD'], 45000)
  if ((!remote.ok || !remote.out) && opts.mirrorUrl) {
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
  if (localHash.slice(0, 7) === remoteShort) {
    return { state: 'up-to-date', message: t('up.latest', { v: localHash.slice(0, 7) }), pullCommand }
  }
  return {
    state: 'behind',
    message: t('up.behind', { local: localHash.slice(0, 7), remote: remoteShort }),
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
