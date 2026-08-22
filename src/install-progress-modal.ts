/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Obsidian APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { App, Modal } from 'obsidian'
import { checkDeps } from './installer'
import { t } from './i18n'

/**
 * 「一键配置 DSH」安装进度弹窗。
 *
 * 展示 7 个步骤（git / Node.js / pnpm / 克隆仓库 / 安装依赖 / 构建 / 全局 CLI）：
 * - 打开时用 checkDeps() 预检依赖，已具备的步骤直接打勾 ✓；
 * - 安装过程中由 installDsh 的 onStep(step, percent) 驱动：按 percent 区间定位当前阶段，
 *   进行中的步骤显示 spinner，完成后打勾 ✓，失败打叉 ✗；
 * - 顶部进度条实时反映整体进度（0–100）。
 */
export class InstallProgressModal extends Modal {
  private readonly rows = new Map<string, { row: HTMLElement; mark: HTMLElement }>()
  private bar!: HTMLElement
  private pctText!: HTMLElement
  private lastPercent = -1
  private finished = false

  constructor(app: App) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('dsh-install-modal')

    contentEl.createEl('h3', { text: t('modal.installProgressTitle') })
    contentEl.createEl('p', { cls: 'dsh-detail', text: t('modal.installProgressDesc') })

    // 步骤清单（顺序与 installDsh 阶段一致）
    const order: Array<[string, string]> = [
      ['git', t('view.install.git')],
      ['node', t('view.install.node')],
      ['pnpm', t('view.install.pnpm')],
      ['clone', t('install.downloading')],
      ['deps', t('install.depsInstalling')],
      ['build', t('install.buildStep')],
      ['cli', t('install.cliInstalling')],
    ]
    const list = contentEl.createDiv({ cls: 'dsh-install-steps' })
    for (const [key, label] of order) {
      const row = list.createDiv({ cls: 'dsh-install-step' })
      const mark = row.createSpan({ cls: 'dsh-install-mark', text: '○' })
      row.createSpan({ cls: 'dsh-install-label', text: label })
      this.rows.set(key, { row, mark })
    }

    // 进度条
    const barBox = contentEl.createDiv({ cls: 'dsh-progress' })
    this.bar = barBox.createDiv({ cls: 'dsh-progress-bar' })
    this.pctText = barBox.createDiv({ cls: 'dsh-progress-text', text: '0%' })

    // 打开即预检依赖：已具备的步骤直接打勾 ✓
    const deps = checkDeps()
    this.markDone('git', deps.git)
    this.markDone('node', deps.node)
    this.markDone('pnpm', deps.pnpm)
  }

  onClose(): void {
    this.contentEl.empty()
  }

  /** 安装进度回调（installDsh onStep 的包装）：按 percent 定位阶段并更新。 */
  update(percent: number, stepText: string): void {
    if (this.finished) return
    const pct = Math.max(0, Math.min(100, Math.round(percent ?? 0)))
    if (pct !== this.lastPercent) {
      this.lastPercent = pct
      // 商店审核规则禁静态 style 赋值：进度条宽度用 setCssProps（Obsidian 官方 API）
      this.bar.setCssProps({ width: `${pct}%` })
      this.pctText.textContent = `${pct}%`
    }
    // 按 percent 区间映射阶段（与 installDsh 的 onStep 调用顺序一致）
    if (pct > 0 && pct < 30) {
      this.activateByDepName(stepText) // 依赖阶段：8/16/24 → git/node/pnpm（按文本里的依赖名）
    } else if (pct >= 30 && pct < 65) {
      this.activate('clone')
    } else if (pct >= 65 && pct < 75) {
      this.activate('deps')
    } else if (pct >= 75 && pct < 92) {
      this.activate('build')
    } else if (pct >= 92 && pct < 100) {
      this.activate('cli')
    } else if (pct >= 100) {
      this.done()
    }
  }

  /** 全部完成：剩余步骤打勾。 */
  done(): void {
    this.finished = true
    for (const key of this.rows.keys()) this.markDone(key, true)
    this.bar.setCssProps({ width: '100%' })
    this.pctText.textContent = '100%'
  }

  /** 失败：当前阶段打叉（其余保持现状，用户可重试）。 */
  fail(): void {
    this.finished = true
    for (const { mark } of this.rows.values()) {
      if (mark.textContent === '●' || mark.textContent === '○') {
        mark.textContent = '✗'
        mark.addClass('dsh-install-mark-fail')
      }
    }
  }

  private markDone(key: string, ok: boolean): void {
    const entry = this.rows.get(key)
    if (!entry) return
    entry.mark.textContent = ok ? '✓' : '○'
    entry.row.addClass(ok ? 'dsh-install-step-done' : '')
    if (ok) entry.mark.addClass('dsh-install-mark-ok')
  }

  private activate(key: string): void {
    for (const [k, { mark, row }] of this.rows) {
      if (k === key) {
        mark.textContent = '●'
        mark.addClass('dsh-install-mark-active')
        row.addClass('dsh-install-step-active')
      } else if (mark.textContent === '●') {
        // 前一个进行中的步骤在此阶段切换时视为完成
        mark.textContent = '✓'
        mark.removeClass('dsh-install-mark-active')
        mark.addClass('dsh-install-mark-ok')
        row.addClass('dsh-install-step-done')
        row.removeClass('dsh-install-step-active')
      }
    }
  }

  /** 依赖阶段：install.autoDep 的 step 文本含依赖名（git/node/pnpm）。 */
  private activateByDepName(stepText: string): void {
    const lower = stepText.toLowerCase()
    if (lower.includes('git')) this.activate('git')
    else if (lower.includes('node')) this.activate('node')
    else if (lower.includes('pnpm')) this.activate('pnpm')
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Obsidian-API exemption for non-type-aware review scans */
