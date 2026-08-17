import { join } from 'node:path'

/**
 * 构建来源标签：附带 Obsidian 笔记的绝对路径，帮助 DSH 直接定位文件、减少工作量。
 * 格式：[来源：Obsidian 笔记 <绝对路径>]
 */
export function buildSourceTag(filePath: string, vaultBasePath: string): string {
  if (filePath === '') {
    return ''
  }
  const full = vaultBasePath === '' ? filePath : join(vaultBasePath, filePath)
  return `[来源：Obsidian 笔记 ${full}]\n\n`
}
