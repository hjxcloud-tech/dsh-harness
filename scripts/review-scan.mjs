/**
 * 商店源码审查本地复现器（对应 Obsidian 插件审查报告里那份「Warnings / Other」清单）。
 *
 * 干什么：用 eslint.review.config.mjs + tsconfig.review.json（外部模块不做类型解析，
 * 与审查沙箱同视角）跑一遍 src/，把结果按「规则 + 位置」汇总打印，并区分
 * **已被文件级 disable 头压住**（suppressed，审查侧同样不报）与**仍在报**（unsuppressed）。
 * 有 unsuppressed 即 exit 1（可当发布门禁：npm run lint:review）。
 *
 * 为什么不是普通 lint：本地 `npm run lint` 类型齐全，看不到 `node:fs`/`obsidian`
 * 被判 error type 造成的成批 no-unsafe-*；只有这个模拟器能自证「商店那边干净了」。
 */
import { ESLint } from 'eslint'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: 'eslint.review.config.mjs',
  errorOnUnmatchedPattern: false,
})

const results = await eslint.lintFiles(['src/**/*.ts'])

/**
 * 已知并定案保留的非阻断项（商店审查里它们是 medium 建议，历版结论仍是 Satisfactory）。
 * 命中这里才允许留白，其余一律 exit 1——新增告警不会被这条清单吃掉。
 */
const ACCEPTED = new Set([
  // 声明式设置 API（Obsidian 1.13+ 设置搜索）：一旦实现且返回非空数组，1.13 会整体绕过现有
  // 命令式 display()，设置页 40+ 行自定义控件须重画——2026-10-08 用户定案「暂不做，保留这条建议」。
  'obsidianmd/settings-tab/prefer-setting-definitions@src/settings.ts',
])

const rows = []
const acceptedRows = []
let suppressedCount = 0
for (const r of results) {
  const file = r.filePath.slice(root.length + 1).replace(/\\/g, '/')
  suppressedCount += r.suppressedMessages.length
  for (const m of r.messages) {
    const row = {
      key: `${m.ruleId}@${file}`,
      rule: m.ruleId ?? '(fatal)',
      where: `${file}:${String(m.line)}${m.endLine && m.endLine !== m.line ? `-${String(m.endLine)}` : ''}`,
      text: m.message,
    }
    ;(ACCEPTED.has(row.key) ? acceptedRows : rows).push(row)
  }
}

const byRule = new Map()
for (const row of rows) {
  if (!byRule.has(row.rule)) byRule.set(row.rule, [])
  byRule.get(row.rule).push(row)
}

console.log(`审查模拟：src/**/*.ts，文件级 disable 头已压住 ${String(suppressedCount)} 条（与商店侧同样不呈现）`)
if (acceptedRows.length > 0) {
  console.log(`已定案保留的非阻断项 ${String(acceptedRows.length)} 条：`)
  for (const item of acceptedRows) console.log(`  · ${item.where}  ${item.rule}`)
}
if (rows.length === 0) {
  console.log('✓ 除上述定案项外无剩余告警')
} else {
  console.log(`✗ 新增告警 ${String(rows.length)} 条，按规则分组：`)
  for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${String(list.length).padStart(3)}  ${rule}`)
    for (const item of list) console.log(`      ${item.where}  ${item.text.slice(0, 110)}`)
  }
}

process.exit(rows.length > 0 ? 1 : 0)
