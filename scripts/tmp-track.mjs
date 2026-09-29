import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * 验证脚本用的一次性目录（v2.8.7）。
 *
 * 与 `mkdtempSync(join(tmpdir(), prefix))` 同义，但**进程退出时自动回收**：
 * 这些脚本原先各自留下 `dsh-profile-sandbox-*`、`dsh-embed-verify-*`、`dsh-setdraft-e2e-*` 等目录
 * （真机 %TEMP% 里 300+ 个就是这么攒出来的），失败路径更容易整批留盘。
 * 传 `--keep`（argv 里带）时保留，便于事后翻查——与各脚本原有的 --keep 语义一致。
 */
const KEEP = process.argv.includes('--keep')
const created = []
let hooked = false

function cleanup() {
  if (KEEP) return
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已被脚本自己删过，或被占用：不影响验证结论
    }
  }
}

export function tempDir(prefix = 'dsh-verify-') {
  if (!hooked) {
    hooked = true
    // exit 覆盖正常结束与 process.exit；uncaughtException 里也要清，否则半路崩就留垃圾
    process.on('exit', cleanup)
    process.on('uncaughtException', (err) => {
      cleanup()
      console.error(err)
      process.exit(1)
    })
  }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** 脚本想在成功路径上立刻回收（不等 exit）时可以显式调用。 */
export { cleanup as cleanupTempDirs }
