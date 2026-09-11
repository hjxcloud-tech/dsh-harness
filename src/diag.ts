/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 轻量诊断日志（v2.4.4）：把"面板何时渲染、注入脚本上报的界面正文长度与 /api 探测状态、
 * 自动恢复的每次决策"落成文件，用于定位「白屏必须手动刷新」这类只在真机出现的时序/绘制问题
 * （headless 沙盒无法复现）。**永不抛错**；超过 ~64KB 轮转清空。
 *
 * 路径多候选：Obsidian 的 `manifest.dir` 在部分版本为空，故按
 * ①vault 适配器 basePath + configDir/plugins/<id> ②manifest.dir ③系统临时目录 依次尝试，
 * 保证一定写得出来（否则"日志不存在"会让诊断彻底失效——首版就踩了这个坑）。
 */
const FILE_NAME = 'dsh-panel-diag.log'
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

/** 追加一行诊断：按候选目录依次尝试，成功即返回；全部失败则静默忽略。 */
export function diagLog(dirs: string[], line: string): void {
  const text = `${new Date().toISOString()} ${line}\n`
  for (const dir of dirs) {
    try {
      const file = join(dir, FILE_NAME)
      if (existsSync(file) && statSync(file).size > MAX_BYTES) writeFileSync(file, '')
      appendFileSync(file, text, 'utf8')
      return
    } catch {
      // 试下一个候选目录
    }
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
