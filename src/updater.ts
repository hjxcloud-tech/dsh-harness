import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(exec: ExecFileFn, args: string[], timeoutMs = 30000): Promise<RunResult> {
  return new Promise((resolve) => {
    exec('git', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, out: '', err: String(stderr ?? '').trim() })
      } else {
        resolve({ ok: true, out: String(stdout).trim(), err: '' })
      }
    })
  })
}

/** 读取 DSH 仓库本地版本（HEAD 前 7 位短哈希）；不可用时返回 '未知'。 */
export async function getLocalDshVersion(repoDir: string, exec: ExecFileFn = execFile): Promise<string> {
  const r = await run(exec, ['-C', repoDir, 'rev-parse', 'HEAD'])
  return r.ok && r.out ? r.out.slice(0, 7) : '未知'
}

/**
 * 检查 DSH 更新：直接查询 GitHub 远端（git ls-remote origin HEAD），
 * 与本地 HEAD 比较。只读检测，不修改仓库。
 */
export async function checkDshUpdates(repoDir: string, exec: ExecFileFn = execFile): Promise<UpdateCheckResult> {
  const pullCommand = `cd "${repoDir}" && git pull`
  if (!repoDir || !existsSync(join(repoDir, '.git'))) {
    return {
      state: 'error',
      message: '未找到 DSH 仓库（缺少 .git）：请先「一键检测配置」或「一键安装」填充工作目录',
      pullCommand,
    }
  }

  // 本地版本（完整 SHA，比较前统一截 7 位，避免 --short 变长导致误判）
  const local = await run(exec, ['-C', repoDir, 'rev-parse', 'HEAD'])
  if (!local.ok || !local.out) {
    return { state: 'error', message: '无法读取本地版本', pullCommand }
  }
  const localShort = local.out.slice(0, 7)

  // GitHub 上的最新版本（远端 HEAD，直接查远端，不依赖本地 fetch 缓存）
  const remote = await run(exec, ['-C', repoDir, 'ls-remote', 'origin', 'HEAD'], 45000)
  if (!remote.ok || !remote.out) {
    return {
      state: 'error',
      message: `无法连接 GitHub（git ls-remote）：${remote.err || '未知错误'}；请确认网络与 git 可用`,
      pullCommand,
    }
  }
  const remoteShort = remote.out.split(/\s+/)[0]?.slice(0, 7) ?? ''

  if (localShort === remoteShort) {
    return { state: 'up-to-date', message: `已是最新（${localShort}）`, pullCommand }
  }
  return {
    state: 'behind',
    message: `GitHub 上有新版本：本地 ${localShort}，GitHub 最新 ${remoteShort}`,
    pullCommand,
  }
}

/**
 * 执行 DSH 仓库更新：git pull --ff-only（快进式，不产生本地合并；
 * 本地有未提交改动时会失败并提示，避免覆盖用户改动）。
 */
export async function pullDshUpdates(repoDir: string, exec: ExecFileFn = execFile): Promise<PullResult> {
  const pull = await run(exec, ['-C', repoDir, 'pull', '--ff-only', '--quiet'])
  if (pull.ok) {
    return {
      ok: true,
      message: `DSH 已更新（${repoDir}）。若 DSH 服务正在运行，请重启服务使新版本生效`,
    }
  }
  return {
    ok: false,
    message: `DSH 更新失败：${pull.err || '未知错误'}（本地可能有未提交改动或网络问题，请手动处理）`,
  }
}
