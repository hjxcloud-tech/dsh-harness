import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { join } from 'node:path'
import { diagBeat, diagDirCandidates, diagLog } from '../src/diag'
import { tempDir } from './temp-track'

/**
 * 宿主侧桥接行为锁（v2.8.7）。
 * 这几处依赖 Obsidian 运行时与真实 iframe（选区事件、焦点、ACK 通道），Node 里跑不起来，
 * 因此沿用 tests/compat.test.ts 的做法：对源码做结构级断言，把"必须成立的形状"钉住。
 */
const mainSrc = (): string => readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8')

describe('取消框选补偿（v2.8.7·主修）', () => {
  it('焦点在面板内时不再整个丢弃事件：能力位为真当场处理，否则记脏等焦点交回', () => {
    const s = mainSrc()
    const at = s.indexOf('private readonly onDocSelection')
    const to = s.indexOf('private readonly onDocFocusIn')
    expect(at).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(at)
    const body = s.slice(at, to)
    expect(body).toContain('if (this.bridgeSetDraftCapable) this.scheduleAutoSend()')
    expect(body).toContain('else this.selectionDirtyWhileInFrame = true')
    // 旧形状（无补偿的一句 return）不得在**这个函数里**复活——那正是「取消框选后隐式行残留并被发送」的根因
    expect(body).not.toContain('=== frame) return')
    const focus = s.slice(s.indexOf('private readonly onDocFocusIn'), s.indexOf('private scheduleAutoSend()', s.indexOf('private readonly onDocFocusIn')))
    expect(focus).toContain('if (!this.selectionDirtyWhileInFrame) return')
    expect(s).toContain("document.addEventListener('focusin', this.onDocFocusIn)")
    expect(s).toContain("document.removeEventListener('focusin', this.onDocFocusIn)")
  })

  it('去抖只有一条链路：选区事件与焦点交回共用 scheduleAutoSend', () => {
    const s = mainSrc()
    expect(s).toContain('private scheduleAutoSend(): void {')
    const hits = s.match(/autoSendTimer = window\.setTimeout/g) ?? []
    expect(hits).toHaveLength(1)
  })

  it('模式关闭 / 卸载时脏标记复位（不该在下次开启时突然补一发）', () => {
    const s = mainSrc()
    const at = s.indexOf('private unregisterAutoSend()')
    expect(at).toBeGreaterThan(-1)
    expect(s.slice(at, at + 900)).toContain('this.selectionDirtyWhileInFrame = false')
  })
})

describe('去重键记「最后生效的文本」（v2.8.7·次生缺口）', () => {
  it('ACK 报失败即清空 lastDraft 缓存，之后框选同一段仍会下发', () => {
    const s = mainSrc()
    const at = s.indexOf('const fillOk = (data as')
    expect(at).toBeGreaterThan(-1)
    const seg = s.slice(at, at + 600)
    expect(seg).toContain('const fillOk = (data as { ok?: unknown }).ok === true')
    expect(seg).toContain('this.logFill(note, had, fillOk)')
    expect(seg).toContain('if (!fillOk) {')
    expect(seg).toContain('this.lastDraftFrame = null')
    expect(seg).toContain("this.lastDraftText = ''")
  })
})

describe('诊断日志两条通道（v2.8.7）', () => {
  it('事件与心跳分别落两个文件；心跳不得再进事件通道', () => {
    const dir = tempDir('dsh-diag-')
    try {
      diagLog([dir], 'renderFrame token=…')
      diagBeat([dir], 'ui-state len=18306 api=200')
      const events = join(dir, 'dsh-panel-diag.log')
      const heart = join(dir, 'dsh-panel-heart.log')
      expect(existsSync(events)).toBe(true)
      expect(existsSync(heart)).toBe(true)
      expect(readFileSync(events, 'utf8')).toContain('renderFrame')
      expect(readFileSync(events, 'utf8')).not.toContain('ui-state')
      expect(readFileSync(heart, 'utf8')).toContain('ui-state len=18306')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('每条通道各自 64KB 轮转，超限清空后仍可继续写', () => {
    const dir = tempDir('dsh-diag-rot-')
    try {
      writeFileSync(join(dir, 'dsh-panel-diag.log'), 'x'.repeat(70 * 1024), 'utf8')
      diagLog([dir], 'after-rotate')
      const file = join(dir, 'dsh-panel-diag.log')
      expect(statSync(file).size).toBeLessThan(200)
      expect(readFileSync(file, 'utf8')).toContain('after-rotate')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('候选目录顺序：vault 适配器路径 → manifest.dir → 系统临时目录（保证一定写得出来）', () => {
    const cands = diagDirCandidates('D:\\vault', '.obsidian', 'dsh-harness', undefined)
    expect(cands[0]).toContain(join('.obsidian', 'plugins', 'dsh-harness'))
    expect(cands[cands.length - 1]).toContain('dsh-harness-diag')
  })
})

/**
 * v2.9.5（用户第 3 项要求）：内嵌界面不可用时给「回退到适配版本 DSH」的选项。
 * 这里锁两个不能漂的点：①目标版本只能取 compat 的适配上界（否则一侧上推、另一侧忘改就会装错版本）；
 * ②当前版本不低于上界时**不降级/不重装**，只提示重载/重启（避免把 panel 的手气问题变成一次无意义重装）。
 */
describe('内嵌界面不可用页的回退选项（v2.9.5）', () => {
  it('view 侧：不可用卡片给出回退按钮，并接到 main.fallbackToAdaptedDsh', () => {
    const view = readFileSync(join(process.cwd(), 'src', 'view.ts'), 'utf8')
    const at = view.indexOf('private async renderBlockedHint')
    expect(at).toBeGreaterThan(-1)
    const end = view.indexOf('启动运行期探活', at)
    expect(end).toBeGreaterThan(at)
    const body = view.slice(at, end)
    // 目标版本必须走 compat 的纯函数（高于上界→上界；区间内→严格更低的最高已测版本），不得在本函数写死
    expect(body).toContain('const target = fallbackTargetFor(current)')
    expect(body).toContain("t('view.blocked.fallback', { v: target })")
    expect(body).toContain('void this.plugin.fallbackToAdaptedDsh()')
    // 当前版本来自运行时读数，区间来自 compat 单一事实源
    expect(body).toContain('await this.plugin.getDshVersionInfo()')
    expect(body).toContain('adaptedRangeLabel()')
    expect(body).not.toMatch(/target\s*=\s*'\d+\.\d+\.\d+/)
  })

  it('main 侧：目标取适配上界；当前版本已不高于上界时只提示、不调安装', () => {
    const main = mainSrc()
    const at = main.indexOf('async fallbackToAdaptedDsh(')
    expect(at).toBeGreaterThan(-1)
    const end = main.indexOf('private killPortProcess', at)
    expect(end).toBeGreaterThan(at)
    const body = main.slice(at, end)
    expect(body).toContain('const target = fallbackTargetFor(current)')
    // 目标恰等于当前版本时不得重装/升级（否则「回退」会静默变成一次安装），只提示重载/重启
    expect(body).toContain('compareVersions(current, target) === 0')
    expect(body).toContain("t('view.blocked.fallbackSame'")
    expect(body).toContain('await this.updateGlobalCli(target)')
    // 用户主动发起的操作才确认：必须走 ConfirmModal（与更新确认同一形态），不得静默装
    expect(body).toContain('new ConfirmModal(this.app')
    expect(body).toContain('confirmText: t(\'view.blocked.fallbackConfirm\')')
  })
})
