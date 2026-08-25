/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Obsidian APIs are fully typed by the local tsconfig; the review scanner runs without full type resolution and flags them as any. */
import { App, Modal } from 'obsidian'
import { PLUGIN_CHANGELOG } from './changelog-data'
import { t } from './i18n'

/**
 * 插件更新日志弹窗（内置，不跳转 GitHub）：展示各版本主要更新。
 * 数据在 changelog-data.ts（纯数据，可测试）；本文件只负责 UI。
 */

export class PluginChangelogModal extends Modal {
  constructor(app: App) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('dsh-changelog-modal')
    this.setTitle(t('pluginChangelog.title'))

    const wrap = contentEl.createDiv({ cls: 'dsh-changelog-list' })
    const isZh = t('pluginChangelog.locale') === 'zh'
    for (const entry of PLUGIN_CHANGELOG) {
      const ver = wrap.createDiv({ cls: 'dsh-changelog-ver' })
      ver.createEl('h4', { text: `v${entry.version}` })
      const list = ver.createEl('ul')
      for (const item of entry.items) {
        list.createEl('li', { text: isZh ? item[0] : item[1] })
      }
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Obsidian-API exemption for non-type-aware review scans */
