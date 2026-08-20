import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BRIDGE_ENTRY_ID,
  BRIDGE_FILENAME,
  bridgePluginSource,
  bridgeScriptSource,
  isBridgeInstalled,
  isObsidianReadablePath,
  resolveVaultPath,
  webProfileDir,
  writeBridgeFiles,
} from '../src/bridge'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
}

describe('bridgeScriptSource', () => {
  it('包含消息类型与输入框选择器', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('dsh-fill-draft')
    expect(s).toContain('dsh-bridge-ping')
    expect(s).toContain('dsh-bridge-ready')
    expect(s).toContain('textarea[data-phase]')
  })
  it('包含路径点击重定向的消息与解析标记', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('dsh-open-in-obsidian')
    expect(s).toContain('dsh-open-cfg')
    expect(s).toContain('resolveTxt')
    expect(s).toContain('obsidian')
    // 产物 chip 用 title 属性取完整路径
    expect(s).toContain('pathOf')
    expect(s).toContain('getAttribute')
  })
  it('不包含会破坏 HTML 注入的片段', () => {
    const s = bridgeScriptSource()
    expect(s).not.toContain('</script>')
    expect(s).not.toContain('${')
  })
  it('可解析（new Function 不抛错）——防单行压缩导致 ASI 语法错误', () => {
    // 回归：曾因 `})` 与 `try{` 同行无分号导致整段脚本解析失败、从不执行
    expect(() => new Function(bridgeScriptSource())).not.toThrow()
  })
  it('执行后置位桥接标记并注册 message/click 监听（最小 window/document stub）', () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const windowStub: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      parent: null,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn
      },
      HTMLTextAreaElement: { prototype: { value: '' } },
    }
    const documentStub = { querySelector: () => null, addEventListener: () => undefined }
    const EventStub = class {}
    new Function('window', 'document', 'Event', bridgeScriptSource())(
      windowStub,
      documentStub,
      EventStub,
    )
    expect(windowStub.__DSH_OBSIDIAN_BRIDGE__).toBe(true)
    expect(typeof listeners.message).toBe('function')
  })
})

describe('resolveVaultPath（路径点击的 Vault 内判定，与注入脚本同逻辑）', () => {
  const ROOT = 'D:\\Software\\Obsidian'
  it('相对路径按 Vault 根解析为规范绝对路径', () => {
    expect(resolveVaultPath('06 skill&agent/dsh-obsidian/README.md', ROOT)).toBe(
      'D:/Software/Obsidian/06 skill&agent/dsh-obsidian/README.md',
    )
  })
  it('Vault 内绝对路径（含反斜杠）判定在 Vault 内', () => {
    expect(resolveVaultPath('D:\\Software\\Obsidian\\协作记忆.md', ROOT)).toBe(
      'D:/Software/Obsidian/协作记忆.md',
    )
  })
  it('Vault 外绝对路径返回 null（取消打开）', () => {
    expect(resolveVaultPath('D:\\deepseek-harness\\packages\\x.ts', ROOT)).toBeNull()
    expect(resolveVaultPath('C:\\Windows\\System32\\x.dll', ROOT)).toBeNull()
  })
  it('处理 . 与 .. 段', () => {
    expect(resolveVaultPath('a/../b.md', ROOT)).toBe('D:/Software/Obsidian/b.md')
    expect(resolveVaultPath('06 skill&agent/./x.md', ROOT)).toBe('D:/Software/Obsidian/06 skill&agent/x.md')
  })
  it('根路径大小写不敏感（Windows）', () => {
    expect(resolveVaultPath('d:\\software\\obsidian\\a.md', 'D:\\Software\\Obsidian')).toBe(
      'd:/software/obsidian/a.md',
    )
  })
  it('空文本/超长文本返回 null', () => {
    expect(resolveVaultPath('', ROOT)).toBeNull()
    expect(resolveVaultPath('x'.repeat(301), ROOT)).toBeNull()
    expect(resolveVaultPath('', '')).toBeNull()
  })
})

describe('isObsidianReadablePath（Vault 内但不可读格式 → 不打开）', () => {
  it('文本/代码/媒体/PDF 可读', () => {
    expect(isObsidianReadablePath('a.md')).toBe(true)
    expect(isObsidianReadablePath('b/README.md')).toBe(true)
    expect(isObsidianReadablePath('c.ts')).toBe(true)
    expect(isObsidianReadablePath('d.json')).toBe(true)
    expect(isObsidianReadablePath('e.pdf')).toBe(true)
    expect(isObsidianReadablePath('f.png')).toBe(true)
    expect(isObsidianReadablePath('g.mp4')).toBe(true)
    expect(isObsidianReadablePath('D:/x/y.txt')).toBe(true)
  })
  it('二进制/办公/归档等不可读', () => {
    expect(isObsidianReadablePath('a.docx')).toBe(false)
    expect(isObsidianReadablePath('b.xlsx')).toBe(false)
    expect(isObsidianReadablePath('c.zip')).toBe(false)
    expect(isObsidianReadablePath('d.exe')).toBe(false)
    expect(isObsidianReadablePath('e.dll')).toBe(false)
    expect(isObsidianReadablePath('f.db')).toBe(false)
    expect(isObsidianReadablePath('g.wasm')).toBe(false)
    expect(isObsidianReadablePath('无扩展名')).toBe(false)
  })
})

describe('bridgePluginSource', () => {
  it('是合法 ESM：真实 node 导入成功且导出 name/apply', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, BRIDGE_FILENAME)
      writeFileSync(file, bridgePluginSource(), 'utf8')
      // 走真实 node 子进程（vitest 的模块加载器无法加载项目外文件）
      const script =
        `import(${JSON.stringify(pathToFileURL(file).href)}).then(m => {` +
        ` if (m.name !== 'dsh-obsidian-bridge' || typeof m.apply !== 'function') process.exit(2);` +
        ` console.log('OK') }).catch(e => { console.error(e); process.exit(1) })`
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 10000,
      })
      expect(out.trim()).toBe('OK')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('writeBridgeFiles', () => {
  it('首次写入：创建插件文件并追加补丁条目，changed=true', () => {
    const home = tempHome()
    try {
      const r = writeBridgeFiles(home)
      expect(r.changed).toBe(true)
      expect(r.error).toBeUndefined()
      const patch = readFileSync(join(webProfileDir(home), 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain(BRIDGE_ENTRY_ID)
      expect(patch).toContain('file:///')
      expect(readFileSync(join(webProfileDir(home), BRIDGE_FILENAME), 'utf8')).toContain('dsh-obsidian-bridge')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('幂等：再次写入 changed=false 且不重复追加条目', () => {
    const home = tempHome()
    try {
      writeBridgeFiles(home)
      const r2 = writeBridgeFiles(home)
      expect(r2.changed).toBe(false)
      const patch = readFileSync(join(webProfileDir(home), 'cordis.patch.yml'), 'utf8')
      // 仅一条 insert 条目（id 出现一次；文件名/注释中的同名字符串不算条目）
      expect((patch.match(/- id: dsh-obsidian-bridge/g) ?? []).length).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('内容哈希保险：旧插件写回的旧版文件会被当前源码覆盖恢复', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, BRIDGE_FILENAME)
      // 先写入当前正确桥接
      writeBridgeFiles(home)
      const correct = readFileSync(file, 'utf8')
      expect(correct).toContain('pathOf')
      // 模拟内存旧插件用旧代码把文件覆盖回旧版（无 pathOf）
      writeFileSync(file, '// OLD_BRIDGE_NO_PATHOF\nexport const name = "old"', 'utf8')
      // 再次调用：因内容与当前源码不一致，应重写回正确版本
      const r = writeBridgeFiles(home)
      const restored = readFileSync(file, 'utf8')
      expect(restored).toContain('pathOf')
      expect(restored).not.toContain('OLD_BRIDGE_NO_PATHOF')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('内容哈希保险：文件已是最新时不再重复写入', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      writeBridgeFiles(home)
      const file = join(dir, BRIDGE_FILENAME)
      const first = readFileSync(file, 'utf8')
      writeBridgeFiles(home)
      const second = readFileSync(file, 'utf8')
      expect(second).toBe(first)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('合并已有块式条目补丁：末尾追加且保持合法', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'cordis.patch.yml'),
        '# 已有用户补丁\n- disabled: true\n  id: some-other\n',
        'utf8',
      )
      const r = writeBridgeFiles(home)
      expect(r.changed).toBe(true)
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain('- disabled: true')
      expect(patch).toContain(BRIDGE_ENTRY_ID)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('模板空数组（[]）时替换为块式条目', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'cordis.patch.yml'),
        '# Your patch layer for this dsh profile\n[]\n',
        'utf8',
      )
      const r = writeBridgeFiles(home)
      expect(r.changed).toBe(true)
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).not.toMatch(/\[\s*\]/)
      expect(patch).toContain('- insert:')
      expect(patch).toContain(BRIDGE_ENTRY_ID)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('isBridgeInstalled', () => {
  it('写入后为 true，空 home 为 false', () => {
    const home = tempHome()
    try {
      expect(isBridgeInstalled(home)).toBe(false)
      writeBridgeFiles(home)
      expect(isBridgeInstalled(home)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
