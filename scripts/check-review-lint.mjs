/**
 * 商店审核风格本地校验（发布前门禁）：
 * 1. 每个含 `eslint-disable` 的 src/*.ts 必须带配对 `eslint-enable`（商店审核会报
 *    "Requires 'eslint-enable' directive"，v1.5.0 曾因此 5 个 Error）；
 * 2. manifest.json 首字节不得为 UTF-8 BOM（EF BB BF），否则 Obsidian 加载 JSON.parse 失败；
 * 3. manifest.json description 不得含 "Obsidian" 一词（商店审核规则：目录上下文已隐含，v1.7.0 曾被拒）；
 * 4. manifest.json description 不得含营销/感谢措辞（商店建议纯功能描述，v1.6.3 含感谢语已清理）；
 * 5. src/*.ts 不得直接写**内联静态样式**（官方规则 obsidianmd/no-static-styles-assignment，
 *    v2.4.1 的 iframe 重绘轻推 `frame.style.height = 'calc(100% - 1px)'` 曾被商店 bot 报错）：
 *    改用 CSS 类切换或 setCssProps/setCssStyles；含插值的模板串（动态值）不在拦截范围。
 * 任一违规 exit 1。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

for (const name of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
  const code = readFileSync(join(root, 'src', name), 'utf8')
  // 按行序扫描块级 eslint-disable / eslint-enable 指令（仅块注释形式 `/* eslint-disable ... */`，
  // 避免把字符串/文档正文里的 "eslint-disable" 字样误当指令）：必须平衡且以 enable 收尾
  let depth = 0
  let lastDirective = ''
  for (const line of code.split('\n')) {
    if (/\*\s*eslint-disable(?!-next-line|-line\b)/.test(line)) {
      depth += 1
      lastDirective = 'disable'
    }
    if (/\*\s*eslint-enable/.test(line)) {
      depth = Math.max(0, depth - 1)
      lastDirective = 'enable'
    }
  }
  if (depth > 0) {
    errors.push(`src/${name}: ${depth} 处块级 eslint-disable 缺配对 eslint-enable（或 enable 之后又新增了 disable）`)
  } else if (/\*\s*eslint-disable/.test(code) && lastDirective !== 'enable') {
    errors.push(`src/${name}: 块级 eslint-disable 未以 eslint-enable 收尾`)
  }
  // 内联静态样式赋值（仅字面量；含插值的模板串视为动态值，放行）
  code.split('\n').forEach((line, i) => {
    if (/\.style\.[A-Za-z]+\s*=\s*(['"])(?:(?!\1).)*\1/.test(line)) {
      errors.push(
        `src/${name}:${String(i + 1)}: 直接写内联静态样式（官方规则 obsidianmd/no-static-styles-assignment），改用 CSS 类或 setCssProps/setCssStyles`,
      )
    }
  })
}

const manifestPath = join(root, 'manifest.json')
if (existsSync(manifestPath)) {
  const b = readFileSync(manifestPath)
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    errors.push('manifest.json 含 UTF-8 BOM（首字节 EF BB BF），需无 BOM 重写')
  }
  let manifest
  try {
    manifest = JSON.parse(b.toString('utf8'))
  } catch (e) {
    errors.push(`manifest.json 解析失败：${e instanceof Error ? e.message : String(e)}`)
    manifest = null
  }
  if (manifest !== null) {
    const desc = typeof manifest.description === 'string' ? manifest.description : ''
    if (/Obsidian/i.test(desc)) {
      errors.push('manifest.json description 含 "Obsidian"（商店审核禁止：目录上下文已隐含该词）')
    }
    if (/\b(thanks|thank you|internet-spirit|open-source community)\b/i.test(desc)) {
      errors.push('manifest.json description 含营销/感谢措辞（商店建议纯功能描述）')
    }
  }
}

if (errors.length > 0) {
  console.error('✗ review-style checks failed:')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log('✓ review-style checks passed (eslint-disable pairing + manifest BOM/description + no static style assignment)')
