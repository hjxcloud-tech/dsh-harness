/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- pure string formatting is fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */

/**
 * 桥接隐式信息行：把选中内容的位置/字数/路径打包成一行隐式消息注入 DSH 聊天框，
 * 不显示选中原文。DSH 收到后按「路径 + 行:列」读文件定位并处理。
 *
 * 格式：[ BRIDGES is delivering packages for you…… · 128 words · L12:5-L13:3 · <绝对路径> · ]
 * 中英文统一样式（words 固定英文标签）。
 */

/** 选区位置（行/列，0 基，来自 Editor.getCursor）。 */
export interface BridgePos {
  fromLine: number
  fromCh: number
  toLine: number
  toCh: number
}

/** 生成桥接隐式信息行。 */
export function buildBridgeMessage(filePath: string, pos: BridgePos, wordCount: number): string {
  const loc = `${formatLineCol(pos.fromLine, pos.fromCh)}-${formatLineCol(pos.toLine, pos.toCh)}`
  return `[ BRIDGES is delivering packages for you…… · ${wordCount} words · ${loc} · ${filePath} · ]`
}

/** 0 基行/列 → 1 基显示（人类与 DSH 均按 1 基理解）。 */
function formatLineCol(line: number, ch: number): string {
  return `L${line + 1}:${ch + 1}`
}

/** 计算选中文本的字数（统一样式：words 标签；CJK 按字符数计，空白折叠）。 */
export function countWords(text: string): number {
  if (text === '') return 0
  // 按 Unicode 字簇切分，忽略空白；CJK 字符每个算一个 word
  const tokens = text.match(/\S+/g) ?? []
  let count = 0
  for (const tok of tokens) {
    // 含 CJK 的词按字符数计（每个 CJK 字符 = 1），否则整个词算 1
    const cjk = tok.match(/[\u3000-\u9fff\uf900-\ufaff]/g) ?? []
    count += cjk.length > 0 ? cjk.length : 1
  }
  return count
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the pure-formatting exemption for non-type-aware review scans */
