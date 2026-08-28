import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BRIDGE_ENTRY_ID,
  BRIDGE_FILENAME,
  bridgeEditInjectSource,
  bridgePluginSource,
  bridgeScriptSource,
  hotkeyToPassthroughKey,
  isBridgeInstalled,
  isObsidianReadablePath,
  kbdMatch,
  mergeFillText,
  parseBridgeLine,
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
  it('fill 成功后回传 ACK（消除「已填入」假象）', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('dsh-fill-ack')
    // ACK 在 setter+input 事件之后发送（填入成功才回）
    expect(s.indexOf('dsh-fill-ack')).toBeGreaterThan(s.indexOf("dispatchEvent(new Event('input'"))
  })
  it('textarea 未挂载时自适应重试（先密后疏：100ms×10 → 400ms×5，最长 ~3s）', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('setTimeout(go,100)')
    expect(s).toContain('setTimeout(go,400)')
    expect(s).not.toContain('setTimeout(go,200)')
  })
  it('填入后不抢焦点（回归：el.focus() 曾导致框选后的键盘操作被导向 DSH 聊天框）', () => {
    const s = bridgeScriptSource()
    expect(s).not.toContain('el.focus()')
  })
  it('注入脚本不含控制字符（回归：labelPrefixed 的 \\b 曾编译成退格字节 0x08 导致标签跳过失效）', () => {
    const s = bridgeScriptSource()
    // eslint-disable-next-line no-control-regex
    expect(s).not.toMatch(/[\x00-\x08\x0b-\x1f]/)
    expect(s).toContain('delete)\\b/i')
    expect(s).not.toContain('delete)\x08')
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
  it('esbuild 级语法校验（捕获 IIFE 包装下 new Function 盲区：`)` 与 `identifier` 粘连类 ASI 错）', async () => {
    // 回归：logKbd('...') 后直接接 document.addEventListener 无分号 → ")document" 被解析为调用
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(bridgeScriptSource(), { loader: 'js' })).not.toThrow()
  })
  it('执行后置位桥接标记并注册 message/click 监听（最小 window/document stub）', () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const windowStub: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      parent: null,
      location: { href: 'http://127.0.0.1:3080/' },
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn
      },
      HTMLTextAreaElement: { prototype: { value: '' } },
    }
    const documentStub = {
      querySelector: () => null,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn
      },
      body: { addEventListener: () => undefined },
    }
    const EventStub = class {}
    new Function('window', 'document', 'Event', bridgeScriptSource())(
      windowStub,
      documentStub,
      EventStub,
    )
    expect(windowStub.__DSH_OBSIDIAN_BRIDGE__).toBe(true)
    expect(typeof listeners.message).toBe('function')
    // 快捷键透传：keydown 监听必须注册（防 ASI 语法错误回归——曾导致整段脚本解析失败）
    expect(typeof listeners.keydown).toBe('function')
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

describe('kbdMatch（iframe 快捷键透传匹配，与桥接脚本同逻辑）', () => {
  it('Ctrl+O：命中仅 ctrl+o，不命中无 ctrl 或键不符', () => {
    expect(kbdMatch({ ctrlKey: true, key: 'o' }, 'ctrl+o')).toBe(true)
    expect(kbdMatch({ ctrlKey: true, key: 'O' }, 'ctrl+o')).toBe(true)
    expect(kbdMatch({ ctrlKey: false, key: 'o' }, 'ctrl+o')).toBe(false)
    expect(kbdMatch({ ctrlKey: true, key: 'p' }, 'ctrl+o')).toBe(false)
  })
  it('Ctrl+：符号键（comma）匹配', () => {
    expect(kbdMatch({ ctrlKey: true, key: ',' }, 'ctrl+,')).toBe(true)
    expect(kbdMatch({ ctrlKey: true, key: 'o' }, 'ctrl+,')).toBe(false)
  })
  it('meta（macOS Cmd）与 alt 组合', () => {
    expect(kbdMatch({ metaKey: true, key: 'o' }, 'meta+o')).toBe(true)
    expect(kbdMatch({ ctrlKey: true, metaKey: true, key: 'o' }, 'ctrl+o')).toBe(false)
    expect(kbdMatch({ altKey: true, key: 'x' }, 'alt+x')).toBe(true)
  })
  it('空 key 或空事件不匹配', () => {
    expect(kbdMatch({ ctrlKey: true, key: 'o' }, '')).toBe(false)
    expect(kbdMatch(null as never, 'ctrl+o')).toBe(false)
  })
})

describe('hotkeyToPassthroughKey（Obsidian hotkey → 透传键，Mod 归一）', () => {
  it('Mod 在 Windows/Linux 归一为 ctrl（properties 的 Mod+; → ctrl+;）', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'win32')).toBe('ctrl+;')
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: 'o' }, 'linux')).toBe('ctrl+o')
  })
  it('Mod 在 darwin 归一为 meta', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'darwin')).toBe('meta+;')
  })
  it('Ctrl/Shift/Alt 组合保留', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Ctrl', 'Shift'], key: 'p' }, 'win32')).toBe('ctrl+shift+p')
    expect(hotkeyToPassthroughKey({ modifiers: ['Alt'], key: 'ArrowLeft' }, 'win32')).toBe('alt+arrowleft')
  })
  it('无修饰单键返回 null（不干扰 DSH 输入）', () => {
    expect(hotkeyToPassthroughKey({ modifiers: [], key: 'e' }, 'win32')).toBeNull()
    expect(hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'win32')).not.toBeNull()
  })
  it('空 key 返回 null', () => {
    expect(hotkeyToPassthroughKey({ modifiers: ['Ctrl'], key: '' }, 'win32')).toBeNull()
    expect(hotkeyToPassthroughKey(undefined as never, 'win32')).toBeNull()
  })
  it('归一后的 ctrl+; 能被 kbdMatch 匹配（端到端链路）', () => {
    const key = hotkeyToPassthroughKey({ modifiers: ['Mod'], key: ';' }, 'win32')
    expect(key).toBe('ctrl+;')
    expect(kbdMatch({ ctrlKey: true, key: ';' }, key as string)).toBe(true)
  })
})

describe('parseBridgeLine（BRIDGES 隐式行解析，与内联 pre-step 同逻辑）', () => {
  const line = '[ BRIDGES is delivering packages for you…… · 252 words · L2:1-L7:23 · D:\\Software\\Obsidian\\01 inbox\\20260701 2026Q2绩效考核.md · ]'
  it('跨行选区：路径/坐标/指令均正确提取', () => {
    const r = parseBridgeLine(`${line}\n在这段文字下做一句话总结`)
    expect(r).not.toBeNull()
    expect(r?.path).toBe('D:\\Software\\Obsidian\\01 inbox\\20260701 2026Q2绩效考核.md')
    expect(r?.fromLine).toBe(2)
    expect(r?.fromCh).toBe(1)
    expect(r?.toLine).toBe(7)
    expect(r?.toCh).toBe(23)
    expect(r?.instruction).toBe('在这段文字下做一句话总结')
  })
  it('单行选区', () => {
    const r = parseBridgeLine('[ BRIDGES is delivering packages for you…… · 3 words · L5:2-L5:10 · a.md · ]')
    expect(r?.fromLine).toBe(5)
    expect(r?.toLine).toBe(5)
  })
  it('无指令时 instruction 为空串', () => {
    const r = parseBridgeLine('[ BRIDGES is delivering packages for you…… · 0 words · L1:1-L1:1 · a.md · ]')
    expect(r?.instruction).toBe('')
  })
  it('非隐式行返回 null', () => {
    expect(parseBridgeLine('普通文本')).toBeNull()
    expect(parseBridgeLine('')).toBeNull()
  })
})

describe('bridgeEditInjectSource（pre-step 编辑指令注入）', () => {
  it('含 pre-step 注入所需标记与防重复逻辑', () => {
    const s = bridgeEditInjectSource()
    expect(s).toContain('dsh-obsidian-bridge')
    expect(s).toContain("form: 'bridge-edit'")
    expect(s).toContain('fs read')
    expect(s).toContain('fs edit')
    expect(s).toContain('是否同意')
    expect(s).toContain('BRIDGE_LINE_RE')
  })
  it('可解析（esbuild 级语法校验）', async () => {
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(bridgeEditInjectSource(), { loader: 'js' })).not.toThrow()
  })
  it('桥接插件源码含 pre-step 注册且语法有效', async () => {
    const s = bridgePluginSource()
    expect(s).toContain("ctx.on('agent/pre-step'")
    expect(s).toContain('bridgeEditMaybeInject')
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(s, { loader: 'js' })).not.toThrow()
  })
})

describe('mergeFillText（隐式行置顶 + 保留用户输入，与内联 mergeFill 同逻辑）', () => {
  const line = '[ BRIDGES is delivering packages for you…… · 128 words · L12:5-L13:3 · D:\\vault\\a.md · ]'
  it('空框 + 隐式行 → 隐式行', () => {
    expect(mergeFillText('', line)).toBe(line)
  })
  it('框已有用户输入 + 隐式行 → 隐式行置顶、用户输入保留（不覆盖）', () => {
    expect(mergeFillText('请帮我总结这段', line)).toBe(`${line}\n请帮我总结这段`)
  })
  it('已有旧隐式行 + 用户输入，注入新隐式行 → 新行替换旧行、用户输入保留（防堆叠）', () => {
    const newLine = '[ BRIDGES is delivering packages for you…… · 7 words · L2:1-L2:8 · D:\\vault\\b.md · ]'
    const existing = `${line}\n请帮我总结这段`
    expect(mergeFillText(existing, newLine)).toBe(`${newLine}\n请帮我总结这段`)
  })
  it('空串清除：仅移除隐式行，保留用户输入', () => {
    expect(mergeFillText(`${line}\n请帮我总结这段`, '')).toBe('请帮我总结这段')
  })
  it('空串清除且框内只有用户输入（无隐式行）→ 原样保留（不误删用户文字）', () => {
    expect(mergeFillText('用户手输内容', '')).toBe('用户手输内容')
  })
  it('用户多行输入保留，删除隐式行产生的连续空行压缩为单个', () => {
    const existing = `${line}\n\n\n第一行\n\n第二行`
    expect(mergeFillText(existing, '')).toBe('第一行\n\n第二行')
  })
})

describe('bridgeScriptSource 合并填充标记', () => {
  it('注入脚本含 mergeFill 与 BRIDGE_LINE_RE，且不直接覆盖 value', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('mergeFill')
    expect(s).toContain('BRIDGE_LINE_RE')
    // 覆盖式写法（d.set.call(el,text)）不再出现——合并后赋值
    expect(s).not.toContain('d.set.call(el,text)')
  })
})
