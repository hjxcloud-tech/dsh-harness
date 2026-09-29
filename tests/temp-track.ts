import { afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 测试用临时目录：与 `mkdtempSync(join(tmpdir(), prefix))` 同义，但**文件级自动回收**。
 *
 * 为什么需要（v2.8.7）：`%TEMP%` 里堆了 300+ 个 `dsh-*` 沙盒目录（`dsh-profiler-*` 125 个、
 * `dsh-workspace-changes-*` 20 个、`dsh-detector-*`、`dsh-installer-repo-*`…），因为各测试用例
 * 建完就走，`rmSync` 要么没有、要么只在个别用例的 finally 里——一次 `npm test` 就漏一批。
 * 用 helper 统一登记后，任何用例都不需要自己记得清理（个别用例内仍然可以主动 rmSync，
 * afterAll 用 force:true 幂等，重复删除无害）。
 */
const created: string[] = []

afterAll(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已被用例删掉，或被杀软/其他进程占住：不影响测试结论
    }
  }
})

export function tempDir(prefix = 'dsh-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
