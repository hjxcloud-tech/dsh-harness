/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 两条通道（v2.8.7）：
 *  - **事件**（`dsh-panel-diag.log`）：渲染链、白屏自愈、AED/适配判定、填充遥测等低频高价值行；
 *  - **心跳**（`dsh-panel-heart.log`）：注入脚本上报的 `ui-state` 周期采样。
 * 为什么必须分开：日志有 64KB 上限、超限即清空，而心跳每几秒一条（真机实测 35 分钟就写了 540 条），
 * 会把事件行整个挤掉——排查时正好"想查的那次故障已经不在日志里"。分道后事件通道可留数小时，
 * 需要时间线时再看心跳文件（同目录、同时间戳格式）。
 */
const EVENTS_FILE = 'dsh-panel-diag.log'
const HEART_FILE = 'dsh-panel-heart.log'
const MAX_BYTES = 64 * 1024

/** 诊断日志候选目录（按优先级）。 */
export function diagDirCandidates(
  vaultBase: string | undefined,
  configDir: string,
  pluginId: string,
  manifestDir: string | undefined,
): string[] {
  const out: string[] = []
  if (vaultBase !== undefined && vaultBase !== '') {
    const sep = vaultBase.includes('\\') ? '\\' : '/'
    out.push([vaultBase.replace(/[\\/]+$/, ''), configDir, 'plugins', pluginId].join(sep))
  }
  if (manifestDir !== undefined && manifestDir !== '') out.push(manifestDir)
  out.push(join(tmpdir(), 'dsh-harness-diag'))
  return out
}

/** 追加一行到指定通道：按候选目录依次尝试，成功即返回；全部失败则静默忽略。 */
function appendLine(dirs: string[], file: string, line: string): void {
  const text = `${new Date().toISOString()} ${line}\n`
  for (const dir of dirs) {
    try {
      const path = join(dir, file)
      if (existsSync(path) && statSync(path).size > MAX_BYTES) writeFileSync(path, '')
      appendFileSync(path, text, 'utf8')
      return
    } catch {
      // 试下一个候选目录
    }
  }
}

/** 事件通道：低频、高价值，是排查故障时首先看的那份。 */
export function diagLog(dirs: string[], line: string): void {
  appendLine(dirs, EVENTS_FILE, line)
}

/** 心跳通道：周期采样（面板界面状态等），量大但只在复盘时间线时用。 */
export function diagBeat(dirs: string[], line: string): void {
  appendLine(dirs, HEART_FILE, line)
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
