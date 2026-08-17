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
  it('不包含会破坏 HTML 注入的片段', () => {
    const s = bridgeScriptSource()
    expect(s).not.toContain('</script>')
    expect(s).not.toContain('${')
  })
  it('可解析（new Function 不抛错）——防单行压缩导致 ASI 语法错误', () => {
    // 回归：曾因 `})` 与 `try{` 同行无分号导致整段脚本解析失败、从不执行
    expect(() => new Function(bridgeScriptSource())).not.toThrow()
  })
  it('执行后置位桥接标记并注册 message 监听（最小 window/document stub）', () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const windowStub: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      parent: null,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn
      },
      HTMLTextAreaElement: { prototype: { value: '' } },
    }
    const documentStub = { querySelector: () => null }
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
