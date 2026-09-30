import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  classifySeams,
  COMPAT_BASELINE_FILES,
  COMPAT_BASELINE_VERSION,
  runSeamScan,
  scanSeamTree,
  seamLineFor,
  seamScanApplicable,
  SEAM_BASELINE,
  type SeamHits,
  type SeamScanResult,
} from '../src/compat-diff'
import { DSH_ADAPTED_MAX_TESTED, DSH_TESTED_VERSIONS } from '../src/compat'
import { applyLocale, t } from '../src/i18n'

applyLocale('zh')

/** 用基线表原样造一份"全同"计数（intact 的输入）。 */
function baselineCounts(): Map<string, SeamHits> {
  const m = new Map<string, SeamHits>()
  for (const row of SEAM_BASELINE) if (row.hits > 0) m.set(row.id, { hits: row.hits, files: row.files })
  return m
}

describe('seamScanApplicable（只在"高于上界 + 已核验全局官方安装"时触发）', () => {
  it('三条件全真才跑；少一条都不跑', () => {
    expect(seamScanApplicable({ verified: true, source: 'official-manifest', level: 'untested-newer' })).toBe(true)
    expect(seamScanApplicable({ verified: false, source: 'official-manifest', level: 'untested-newer' })).toBe(false)
    expect(seamScanApplicable({ verified: true, source: 'cli', level: 'untested-newer' })).toBe(false)
    expect(seamScanApplicable({ verified: true, source: 'repo', level: 'untested-newer' })).toBe(false)
    expect(seamScanApplicable({ verified: true, source: 'official-manifest', level: 'tested' })).toBe(false)
    expect(seamScanApplicable({ verified: true, source: 'official-manifest', level: 'within-line' })).toBe(false)
    expect(seamScanApplicable({ verified: true, source: 'official-manifest', level: 'unknown' })).toBe(false)
  })
})

describe('classifySeams（纯分类器，表驱动）', () => {
  it('计数与基线逐项一致 → 零 gone / 零 moved，expected=25 present=25', () => {
    const v = classifySeams(baselineCounts())
    expect(v.gone).toEqual([])
    expect(v.moved).toEqual([])
    expect(v.extra).toEqual([])
    expect(v.expected).toBe(25)
    expect(v.present).toBe(25)
  })
  it('基线有而现在为 0 → gone（破坏信号）；计数变了 → moved（需人工看 diff）', () => {
    const m = baselineCounts()
    m.delete('connection.requestRejection')
    m.set('webServer.tapIndex', { hits: 6, files: 3 })
    const v = classifySeams(m)
    expect(v.gone).toEqual(['connection.requestRejection'])
    expect(v.moved).toEqual(['webServer.tapIndex'])
    expect(v.expected).toBe(25)
    expect(v.present).toBe(24)
  })
  it('基线零的触点（注入类符号）出现 → 只算 extra 观察，永不算 gone', () => {
    const m = baselineCounts()
    m.set('embed token 变量 __DSH_EMBED_TOKEN__', { hits: 4, files: 2 })
    const v = classifySeams(m)
    expect(v.gone).toEqual([])
    expect(v.extra).toEqual(['embed token 变量 __DSH_EMBED_TOKEN__'])
    expect(v.expected).toBe(25) // 基线零不进 expected
  })
  it('空树 → expected 全部判 gone（护栏逻辑在 runSeamScan，不在分类器）', () => {
    const v = classifySeams(new Map())
    expect(v.gone.length).toBe(25)
    expect(v.present).toBe(0)
  })
})

describe('scanSeamTree + runSeamScan（假安装树，端到端）', () => {
  const root = join(tmpdir(), `dsh-seam-test-${process.pid}`)
  const dshDir = join(root, '@deepseek-ai', 'dsh', 'lib')

  beforeAll(() => {
    mkdirSync(dshDir, { recursive: true })
    // 两个文件凑出 webServer.tapIndex 基线指纹（6 hits / 2 files）；launchToken 4 hits / 1 file
    writeFileSync(join(dshDir, 'a.js'), 'tapIndex tapIndex tapIndex // 桥接注入入口\n')
    writeFileSync(join(dshDir, 'b.js'), 'tapIndex tapIndex tapIndex\nlaunchToken launchToken launchToken launchToken\n')
    // 不该被扫的：嵌套 node_modules、点目录、非 js/mjs/cjs
    mkdirSync(join(root, '@deepseek-ai', 'dsh', 'node_modules', 'evil'), { recursive: true })
    writeFileSync(join(root, '@deepseek-ai', 'dsh', 'node_modules', 'evil', 'x.js'), 'tapIndex tapIndex tapIndex tapIndex tapIndex tapIndex tapIndex\n')
    mkdirSync(join(root, '@deepseek-ai', 'dsh', '.cache'), { recursive: true })
    writeFileSync(join(root, '@deepseek-ai', 'dsh', '.cache', 'y.mjs'), 'tapIndex\n')
    writeFileSync(join(dshDir, 'notes.txt'), 'tapIndex tapIndex tapIndex\n')
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('只扫 @deepseek-ai 下的 js/mjs/cjs，跳过嵌套 node_modules 与点目录', async () => {
    const { counts, files } = await scanSeamTree(root)
    expect(files).toBe(2)
    expect(counts.get('webServer.tapIndex')).toEqual({ hits: 6, files: 2 })
    expect(counts.get('launchToken 每进程随机')).toEqual({ hits: 4, files: 1 })
  })

  it('runSeamScan 对残缺树判 gone 并列出消失触点', async () => {
    const r = await runSeamScan('0.9.9', { root, minFiles: 1 })
    expect(r.state).toBe('gone')
    expect(r.gone).toContain('connection.requestRejection')
    expect(r.present).toBe(2)
    expect(r.expected).toBe(25)
    expect(r.baselineVersion).toBe(COMPAT_BASELINE_VERSION)
  })

  it('文件数低于护栏 → skipped(tree-shape)，宁可不判也不误报', async () => {
    const r = await runSeamScan('0.9.9', { root }) // 默认护栏 floor(990*0.4)=396 > 2 个文件
    expect(r.state).toBe('skipped')
    expect(r.reason).toBe('tree-shape')
    expect(r.scannedFiles).toBe(2)
  })

  it('永不抛错：安装根不存在也不炸（skipped 而非异常）', async () => {
    const r = await runSeamScan('0.9.9', { root: join(root, 'no-such-dir'), minFiles: 1 })
    expect(['skipped', 'gone']).toContain(r.state)
  })
})

describe('基线自证（与登记事实同步，漏改直接红）', () => {
  it('指纹表版本必须等于实测上界，且上界在 DSH_TESTED_VERSIONS 里', () => {
    expect(COMPAT_BASELINE_VERSION).toBe(DSH_ADAPTED_MAX_TESTED)
    expect(DSH_TESTED_VERSIONS).toContain(COMPAT_BASELINE_VERSION)
  })
  it('基线文件数与触点表为正数常量（重抓时人工核对值本身）', () => {
    expect(COMPAT_BASELINE_FILES).toBeGreaterThan(0)
    expect(SEAM_BASELINE.length).toBe(27)
  })
  it('触点 id 唯一', () => {
    const ids = new Set(SEAM_BASELINE.map((r) => r.id))
    expect(ids.size).toBe(SEAM_BASELINE.length)
  })
})

describe('触点表与开发比对工具零漂移（两张表必须逐项一致）', () => {
  const script = readFileSync(new URL('../scripts/dsh-compat-diff.mjs', import.meta.url), 'utf8')
  const ids = [...script.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]!)
  const pats = [...script.matchAll(/re:\s*\/([\s\S]*?)\/g/g)].map((m) => m[1]!)
  it('id 与正则逐项同序一致（增删改触点要同步两边，否则这里红）', () => {
    expect(ids.length).toBe(SEAM_BASELINE.length)
    expect(pats.length).toBe(SEAM_BASELINE.length)
    SEAM_BASELINE.forEach((row, i) => {
      expect(ids[i], `第 ${i} 行 id`).toBe(row.id)
      // 正则源串里的 \/ 在 TS 字符串与正则字面量里同形，直接比
      expect(pats[i], `第 ${i} 行正则（${row.id}）`).toBe(row.re.source)
    })
  })
})

describe('seamLineFor（一行结论：只呈现、null 空串、id 截断）', () => {
  const mk = (patch: Partial<SeamScanResult>): SeamScanResult => ({
    state: 'intact',
    version: '0.9.9',
    baselineVersion: COMPAT_BASELINE_VERSION,
    scannedFiles: 990,
    expected: 25,
    present: 25,
    gone: [],
    moved: [],
    extra: [],
    ...patch,
  })
  it('null/undefined → 空串（低于上界时行尾什么都不加）', () => {
    expect(seamLineFor(null)).toBe('')
    expect(seamLineFor(undefined)).toBe('')
  })
  it('intact 带计数与基线版；有 extra 时追加"另有"括注', () => {
    expect(seamLineFor(mk({}))).toContain('25/25')
    expect(seamLineFor(mk({ extra: ['dsh-fix'] }))).toContain(t('compat.seams.extra', { k: '1' }))
  })
  it('gone/moved 列 id 至多 3 个，超出以…收尾', () => {
    const line = seamLineFor(mk({ state: 'gone', present: 21, gone: ['a', 'b', 'c', 'd', 'e'] }))
    expect(line).toContain('a、b、c…')
    expect(line).not.toContain('d')
  })
  it('skipped/failed 带人话原因', () => {
    expect(seamLineFor(mk({ state: 'skipped', reason: 'no-root' }))).toContain(t('compat.seams.reason.noRoot'))
    expect(seamLineFor(mk({ state: 'skipped', reason: 'tree-shape', scannedFiles: 3 }))).toContain('3')
    expect(seamLineFor(mk({ state: 'failed', reason: 'EACCES' }))).toContain('EACCES')
  })
})

describe('静默与只读锁（v2.8.4 定案不破例：自检绝不驱动弹窗）', () => {
  const diffSrc = readFileSync(new URL('../src/compat-diff.ts', import.meta.url), 'utf8')
  const mainSrc = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  it('compat-diff.ts 不引 obsidian、不引用任何模态/Notice 符号', () => {
    expect(diffSrc).not.toContain("'obsidian'")
    expect(diffSrc).not.toContain('Notice')
    expect(diffSrc).not.toContain('Modal')
  })
  it('main.ts 的自检方法只有缓存与 console.warn，没有 .open()', () => {
    const body = mainSrc.slice(mainSrc.indexOf('async seamScanFor'), mainSrc.indexOf('private async prewarmSeamScan'))
    expect(body).not.toContain('.open(')
    expect(body).not.toContain('Notice')
  })
})
