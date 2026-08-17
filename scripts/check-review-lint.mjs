/**
 * 商店审核风格本地校验（发布前门禁）：
 * 1. 每个含 `eslint-disable` 的 src/*.ts 必须带配对 `eslint-enable`（商店审核会报
 *    "Requires 'eslint-enable' directive"，v1.5.0 曾因此 5 个 Error）；
 * 2. manifest.json 首字节不得为 UTF-8 BOM（EF BB BF），否则 Obsidian 加载 JSON.parse 失败。
 * 任一违规 exit 1。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

for (const name of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
  const code = readFileSync(join(root, 'src', name), 'utf8')
  if (code.includes('eslint-disable') && !code.includes('eslint-enable')) {
    errors.push(`src/${name}: 有 eslint-disable 头部但缺 eslint-enable 配对收尾`)
  }
}

const manifestPath = join(root, 'manifest.json')
if (existsSync(manifestPath)) {
  const b = readFileSync(manifestPath)
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    errors.push('manifest.json 含 UTF-8 BOM（首字节 EF BB BF），需无 BOM 重写')
  }
}

if (errors.length > 0) {
  console.error('✗ review-style checks failed:')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log('✓ review-style checks passed (eslint-disable pairing + manifest BOM)')
