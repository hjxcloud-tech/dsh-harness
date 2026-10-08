/**
 * DSH profile 名的校验与归一（v2.6.0 多 profile 支持）。
 * 独立成模块：不依赖 obsidian/i18n，供 settings.ts、main.ts 与单测共用同一事实源。
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (fs/path) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** profile 名白名单：小写字母开头，仅限 a-z 0-9 _ -，总长 ≤64。目录名直接参与路径拼接，杜绝分隔符/点段/空名/大写。 */
export const VALID_PROFILE_RE = /^[a-z][a-z0-9_-]{0,63}$/

/**
 * DSH 内置模板档名（事实源＝@deepseek-ai/dsh-app-boot 的 `PROFILE_TEMPLATES` 键，实测 0.1.5-rc.2：
 * acp / web / headless / sdk / sdk-minimal）。这些名字由 dsh 解析成固定应用形态，
 * **不能**作为 `--from-default-profile` 的自定义目标（DSH 直接抛未捕获异常），也不该被插件代建。
 * `web` 不在列内：它是本插件的默认档，由 `dsh web` 直启、不走代建。
 */
export const RESERVED_PROFILES: readonly string[] = ['acp', 'headless', 'sdk', 'sdk-minimal']

/** 是否 DSH 内置模板档名（大小写不敏感）。内置名不可代建，须在落盘与建目录之前拦下。 */
export function isReservedProfile(value: string): boolean {
  const p = (value ?? '').trim().toLowerCase()
  return RESERVED_PROFILES.includes(p)
}

/**
 * 启动命令里是否指向了 DSH 内置的**非 Web 形态**（`acp` / `headless` / `sdk` / `sdk-minimal`）。
 *
 * 为什么必须查：`startupCommand` 是设置页可自由编辑的字符串，且插件对用户自定义值**原样使用**
 * （main.ts 只在为空时才生成默认命令）。写成 `dsh --profile acp --port {port}` 之后，插件确实能
 * spawn 成功，但那一档讲的是 Agent Client Protocol（stdio）/只做 SDK 宿主，
 * **永远不监听端口** ⇒ 探活一直失败、面板起不来，错误视图只会说"端口没起来"，
 * 用户完全看不出是自己填的档名不对（真机反馈：「acp 用 spawn 就报错，DSH 都无法运行」）。
 *
 * 命中形态：`--profile acp`、`--profile=acp`、以及子命令位 `dsh acp`；
 * 不误伤：`dsh web …`、路径里含同名片段（`/tmp/acp/x`）、前缀更长的名字（`acpx`）。
 * @returns 命中的内置档名，未命中返回 null
 */
export function nonWebProfileInCommand(cmd: string): string | null {
  const c = (cmd ?? '').toLowerCase()
  for (const p of RESERVED_PROFILES) {
    if (new RegExp(`--profile[= ]${p}(?![a-z0-9_-])`).test(c)) return p
    if (new RegExp(`\\bdsh\\s+${p}(?![a-z0-9_-])`).test(c)) return p
  }
  return null
}

/**
 * 设置值归一：非白名单值与 DSH 内置模板档名一律退回默认 web。
 * **不做大小写转换**——白名单只收小写，把 `Bad` 悄悄改成 `bad` 等于给用户换了个 profile（静默切档）。
 * 输入层（settings 文本框 / main.applyProfileChange）已负责 toLowerCase，此处只做「合不合法」。
 */
export function normalizeProfile(value: unknown): string {
  if (typeof value !== 'string') return 'web'
  const v = value.trim()
  return VALID_PROFILE_RE.test(v) && !isReservedProfile(v) ? v : 'web'
}

/**
 * 列举本机已有的 profile 目录名（设置页下拉与沙盒脚本共用）。
 * 判据＝`<home>/profiles/<name>/package.json` 存在（DSH 的 profile 清单）。三道过滤：
 * ①白名单（滤掉点目录等）；②`node_modules`（DSH 会在 profiles/ 下建依赖目录，不是 profile）；
 * ③内置模板名（`acp`/`headless`/`sdk`/`sdk-minimal` 不能当面板 profile，列出来只会误导用户去点）。
 * `web` 恒排最前（默认档）。读目录失败返回空数组——调用方退回「只有当前值」的最小列表，不影响面板启动。
 */
export function listProfiles(home: string, readdir: (dir: string) => string[] = listDir): string[] {
  try {
    const names = readdir(join(home, 'profiles')).filter(
      (name) => VALID_PROFILE_RE.test(name) && name !== 'node_modules' && !isReservedProfile(name),
    )
    return names.sort((a, b) => (a === 'web' ? -1 : b === 'web' ? 1 : a.localeCompare(b)))
  } catch {
    return []
  }
}

/** `listProfiles` 的默认目录读取器（独立成函数便于单测注入；目录不存在时抛错由上层吞掉）。 */
function listDir(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json')))
    .map((e) => e.name)
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
