import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 更新检查结果。 */
export interface UpdateCheckResult {
  state: 'up-to-date' | 'behind' | 'error'
  message: string
  pullCommand: string
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

/**
 * 检查 DSH 仓库更新：git fetch origin 后比较本地 HEAD 与远端跟踪分支。
 * 只读检测，不修改仓库；返回最新状态与手动更新命令。
 */
export async function checkDshUpdates(repoDir: string, exec: ExecFileFn = execFile): Promise<UpdateCheckResult> {
  const pullCommand = `cd "${repoDir}" && git pull`
  if (!repoDir || !existsSync(join(repoDir, '.git'))) {
    return {
      state: 'error',
      message: '未找到 DSH 仓库（缺少 .git）：请先「一键检测配置」填充工作目录',
      pullCommand,
    }
  }

  const fetch = await run(exec, ['-C', repoDir, 'fetch', 'origin', '--quiet'])
  if (!fetch.ok) {
    return {
      state: 'error',
      message: `检查更新失败（git fetch）：${fetch.err || '未知错误'}；请确认网络与 git 可用`,
      pullCommand,
    }
  }

  const local = await run(exec, ['-C', repoDir, 'rev-parse', '--short', 'HEAD'])
  if (!local.ok) {
    return { state: 'error', message: '无法读取本地版本', pullCommand }
  }

  // 确定远端跟踪分支：优先 origin/HEAD 符号引用，回退 origin/main、origin/master
  const sym = await run(exec, ['-C', repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'])
  let remoteRef = sym.ok ? sym.out : ''
  if (!remoteRef) {
    for (const cand of ['origin/main', 'origin/master']) {
      const r = await run(exec, ['-C', repoDir, 'rev-parse', '--short', cand])
      if (r.ok) {
        remoteRef = cand
        break
      }
    }
  }
  if (!remoteRef) {
    return {
      state: 'error',
      message: '无法确定远端分支（origin/main 或 origin/master 均不存在）',
      pullCommand,
    }
  }

  const remote = await run(exec, ['-C', repoDir, 'rev-parse', '--short', remoteRef])
  const count = await run(exec, ['-C', repoDir, 'rev-list', '--count', `HEAD..${remoteRef}`])
  const ahead = Number(count.out || '0')

  if (!remote.ok || ahead <= 0) {
    return { state: 'up-to-date', message: `已是最新（本地 ${local.out}）`, pullCommand }
  }
  return {
    state: 'behind',
    message: `发现新版本：本地 ${local.out}，远端 ${remote.out}（领先 ${ahead} 个提交）。更新：在终端执行 ${pullCommand}`,
    pullCommand,
  }
}
