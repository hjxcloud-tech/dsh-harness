/**
 * Windows 命令执行兼容层。
 *
 * npm 全局安装的 CLI（npm/npx/pnpm/dsh/dsh-fix/dsh-doctor）在 Windows 上都是
 * `.cmd` shim，Node 的 child_process.execFile / execFileSync 无法直接启动 .cmd
 * （返回 ENOENT 且 stderr 为空），必须经 `cmd.exe /d /s /c` 包装后由 cmd 解释器执行。
 * 真二进制（git.exe / winget.exe / taskkill.exe 等）不受影响，保持直调。
 */

/** 需要 cmd.exe 包装的 npm 系命令（Windows 上均为 .cmd shim）。 */
const CMD_WRAP_SET = new Set(['npm', 'npx', 'pnpm', 'dsh', 'dsh-fix', 'dsh-doctor'])

/**
 * 解析实际应执行的命令与参数：
 * - win32 且命令属 .cmd 类 → 改为 `cmd.exe /d /s /c <command> <args...>`；
 * - 其余（真 exe / POSIX）→ 原样返回。
 */
export function resolveExec(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (platform === 'win32' && CMD_WRAP_SET.has(command)) {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
  }
  return { command, args }
}

/**
 * 测试辅助：把（可能被 cmd.exe 包装的）实际调用还原为「语义参数串」
 * （剥离包装层，等价于原命令的 args.join(' ')），供 fakeExec 按键匹配。
 */
export function execKey(command: string, args: string[]): string {
  if (command === 'cmd.exe' && args[0] === '/d' && args[1] === '/s' && args[2] === '/c') {
    return args.slice(4).join(' ')
  }
  return args.join(' ')
}
