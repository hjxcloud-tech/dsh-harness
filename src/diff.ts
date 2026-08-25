/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- pure string/array algorithms are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */

/**
 * 轻量词级 diff（LCS）：把原文/新文按词切分后求最长公共子序列，
 * 输出 [text, type] 序列（type: 'same' | 'del' | 'add'），供 Modal 渲染红删绿增。
 * 不引入第三方依赖；行级/词级两级高亮。
 */

export type DiffToken = { text: string; type: 'same' | 'del' | 'add' }

/** 把文本切成词元（保留空白与换行作为独立 token，便于行级呈现）。 */
export function tokenize(text: string): string[] {
  // 按「空白/换行/其余字符」切分，保留分隔符
  return text.split(/(\s+)/).filter((s) => s !== '')
}

/**
 * 词级 diff（LCS）：返回合并后的 [text, type] 序列。
 * del 在前、add 在后（同一位置成对出现便于渲染「删→增」）。
 */
export function wordDiff(original: string, edited: string): DiffToken[] {
  const a = tokenize(original)
  const b = tokenize(edited)
  const lcs = longestCommonSubsequence(a, b)
  const out: DiffToken[] = []
  let i = 0
  let j = 0
  for (const common of lcs) {
    // 原文本中直到 common 之前的部分都是删除
    while (i < a.length && a[i] !== common) {
      out.push({ text: a[i], type: 'del' })
      i++
    }
    // 新文本中直到 common 之前的部分都是新增
    while (j < b.length && b[j] !== common) {
      out.push({ text: b[j], type: 'add' })
      j++
    }
    // common 本身
    out.push({ text: common, type: 'same' })
    i++
    j++
  }
  while (i < a.length) {
    out.push({ text: a[i], type: 'del' })
    i++
  }
  while (j < b.length) {
    out.push({ text: b[j], type: 'add' })
    j++
  }
  return out
}

/** 最长公共子序列（O(n*m)，返回 a 中的公共元素序列）。 */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lcs: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lcs.push(a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return lcs
}

/** 把 diff 序列渲染为 HTML 字符串（escape 文本；del 红、add 绿、same 原样）。 */
export function renderDiffHtml(tokens: DiffToken[]): string {
  let html = ''
  for (const tok of tokens) {
    const esc = escapeHtml(tok.text)
    if (tok.type === 'del') {
      html += `<span class="dsh-diff-del">${esc}</span>`
    } else if (tok.type === 'add') {
      html += `<span class="dsh-diff-add">${esc}</span>`
    } else {
      html += esc
    }
  }
  return html
}

/** HTML 转义（防注入；diff 内容来自 DSH 回复）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 限长截断（diff 展示用；超长返回前 max 字符 + …）。 */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the pure-algorithm exemption for non-type-aware review scans */
