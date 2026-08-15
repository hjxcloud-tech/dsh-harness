import { execFile, execFileSync, type ExecException } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isDshRepo } from './detector'

/** 安装结果。 */
export interface InstallResult {
  ok: boolean
  message: string
  /** 安装/识别到的 DSH 仓库目录（成功时存在）。 */
  dir?: string
}

/** 安装选项（测试可注入）。 */
export interface InstallOptions {
  cloneUrl?: string
  exec?: typeof execFile
  hasBin?: (name: string) => boolean
}

/** 官方仓库地址（网络受限时可换成 gh-proxy 等镜像）。 */
export const DEFAULT_DSH_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

const CLONE_TIMEOUT_MS = 300_000
const INSTALL_TIMEOUT_MS = 600_000

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(
  exec: typeof execFile,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    exec(command, args, { timeout: timeoutMs, windowsHide: true }, (err: ExecException | null, stdout: string, stderr: string) => {
      if (err) {
        resolve({ ok: false, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() })
      } else {
        resolve({ ok: true, out: String(stdout ?? '').trim(), err: '' })
      }
    })
  })
}

function defaultHasBin(name: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 一键安装 DeepSeek Harness 本体：
 * 1. 目标目录已是 DSH 仓库 → 直接复用；
 * 2. 否则 git 浅克隆官方仓库到目标目录；
 * 3. pnpm 可用时安装依赖（失败不阻塞，提示手动安装）；
 * 4. 校验为 DSH 仓库后返回目录。
 */
export async function installDsh(
  targetDir: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const exec = opts.exec ?? execFile
  const hasBin = opts.hasBin ?? defaultHasBin
  const cloneUrl = opts.cloneUrl ?? DEFAULT_DSH_REPO_URL
  if (!targetDir) {
    return { ok: false, message: '安装目录为空：请在设置中填写安装目录' }
  }

  // 已存在且是 DSH 仓库：直接复用
  if (existsSync(targetDir) && isDshRepo(targetDir)) {
    return { ok: true, message: `检测到已安装的 DSH 仓库：${targetDir}`, dir: targetDir }
  }
  // 已存在但不是 DSH 仓库：拒绝覆盖
  if (existsSync(targetDir)) {
    return {
      ok: false,
      message: `目录已存在但不是 DSH 仓库：${targetDir}。为避免覆盖数据，请更换安装目录或手动处理`,
    }
  }

  // 克隆
  const clone = await run(exec, 'git', ['clone', '--depth', '1', cloneUrl, targetDir], CLONE_TIMEOUT_MS)
  if (!clone.ok) {
    return {
      ok: false,
      message: `克隆失败：${clone.err || '未知错误'}。网络受限时可把安装地址换成代理镜像（如 https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git）`,
    }
  }
  if (!existsSync(targetDir) || !isDshRepo(targetDir)) {
    return { ok: false, message: `克隆完成但目录校验失败：${targetDir}` }
  }

  // 安装依赖（可选步骤，失败不阻塞）
  let depsNote = ''
  if (hasBin('pnpm')) {
    const install = await run(exec, 'pnpm', ['-C', targetDir, 'install'], INSTALL_TIMEOUT_MS)
    if (!install.ok) {
      depsNote = `；依赖安装未完成（${install.err.split('\n')[0] || '失败'}），可稍后在 ${targetDir} 下执行 pnpm install`
    }
  } else {
    depsNote = '；未检测到 pnpm，请安装 pnpm 后在仓库目录执行 pnpm install'
  }

  return {
    ok: true,
    message: `DSH 已安装：${targetDir}${depsNote}`,
    dir: targetDir,
  }
}
