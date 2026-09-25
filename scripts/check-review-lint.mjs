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
 * 6. package-lock.json 的 tarball 地址必须是**官方源** `registry.npmjs.org`，且锁的根 version
 *    与 package.json 一致（v2.8.5 起）——镜像地址在商店源码审查沙箱里装不上，会导致
 *    "dependency installation failed / 依赖解析类检查被跳过"，扫描结果不完整。
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

// ---- 6. package-lock.json 的"可安装性"（v2.8.5 起强制）----
// 本机 .npmrc 常把 registry 指到国内镜像，锁文件因此会被写成 `registry.npmmirror.com` 的 tarball 地址。
// GitHub Actions 能装（镜像公网可达），**Obsidian 商店的源码审查沙箱只走官方源**——装不上依赖时它会报
// "Source review dependency installation failed / Checks which require resolved dependencies were skipped"，
// 依赖解析类检查整段跳过、扫描结果不完整（2.8.4 发布后就是这么挂的，而该状态从 0.1.0 起一直在库里）。
// 修法是纯主机改写（镜像与 npm 逐字节同源，integrity 相同 ⇒ 零版本漂移），这里把规矩钉在门禁里。
const lockPath = join(root, 'package-lock.json')
if (existsSync(lockPath)) {
  const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (e) {
    errors.push(`package-lock.json 解析失败：${e instanceof Error ? e.message : String(e)}`)
    lock = null
  }
  if (lock !== null) {
    const OFFICIAL = 'registry.npmjs.org'
    const foreign = new Map()
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (!entry || typeof entry.resolved !== 'string') continue
      let host = ''
      try {
        host = new URL(entry.resolved).host
      } catch {
        host = '(无法解析)'
      }
      if (host !== OFFICIAL) foreign.set(host, (foreign.get(host) ?? 0) + 1)
    }
    if (foreign.size > 0) {
      const detail = [...foreign.entries()].map(([h, n]) => `${h}×${String(n)}`).join('、')
      errors.push(`package-lock.json 里有 ${detail} 条 tarball 地址不是官方源——审查沙箱装不上依赖会跳过依赖解析类检查（修法：把 resolved 主机改写为 ${OFFICIAL}，integrity 不变、零版本漂移）`)
    }
    const lockVersion = lock.packages?.['']?.version
    if (lockVersion !== pkgVersion) {
      errors.push(`package-lock.json 根 version（${String(lockVersion)}）与 package.json（${pkgVersion}）不一致——升版本时必须一起更新锁（${pkgName}）`)
    }
  }
} else {
  errors.push('缺少 package-lock.json：锁文件是"依赖解析类检查"能跑起来的前提，不能少')
}

if (errors.length > 0) {
  console.error('✗ review-style checks failed:')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log('✓ review-style checks passed (eslint-disable pairing + manifest BOM/description + no static style assignment + lockfile official-registry/version)')
