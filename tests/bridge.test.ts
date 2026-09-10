import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BRIDGE_ENTRY_ID,
  BRIDGE_FILENAME,
  BRIDGE_PACKAGE_NAME,
  bridgeEditInjectSource,
  bridgeModulePath,
  bridgePackageDir,
  bridgePackageManifest,
  bridgePluginSource,
  bridgeScriptSource,
  embedFrameUrl,
  hotkeyToPassthroughKey,
  isBridgeInstalled,
  isObsidianReadablePath,
  kbdMatch,
  mergeFillText,
  parseBridgeLine,
  PROFILE_MANIFEST_VERSION,
  removeDshFixDisable,
  resolveVaultPath,
  upsertBridgeEntry,
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
  it('v2.3.1/v2.4.0 双形态填入：textarea 不抢焦点；contentEditable focus+insertText 且**校验+降级**（ACK 后插件归还焦点）', () => {
    const s = bridgeScriptSource()
    // textarea/input：原生 setter，绝不 focus（框选后键盘操作留在 Obsidian）
    expect(s).toMatch(/function fieldSet[^}]*d\.set\.call\(el,val\)/)
    expect(s).not.toMatch(/function fieldSet[^}]*focus/)
    // contentEditable（0.1.3+；0.1.5 是 Lexical 受控编辑器）：v2.4.0 改为「先清空再写入」——
    // 清空后插入=整体写入，杜绝"插到旧光标处追加"（真机重选叠加根因）；换行走原生 insertParagraph。
    expect(s).toContain('function editFill(el,merged,line,cur,cb)')
    // 正文必须从 merged 推导（不能用 cur——cur 含旧隐式行，会叠加）
    expect(s).toContain("var rest=(merged===line)?'':((merged.indexOf(line)===0)?merged.slice(line.length)")
    // 先清空：native selectAll+delete（Lexical 认原生编辑命令），DOM range 兜底
    expect(s).toContain('function clearAll(done)')
    expect(s).toContain("exec('selectAll')")
    expect(s).toContain("exec('delete')")
    // 再写入：空内容上插入；有正文时 行→insertParagraph→正文
    expect(s).toContain('function write(done)')
    expect(s).toContain("fireInput('insertParagraph')")
    expect(s).toContain("exec('insertText',merged)")
    expect(s).toContain('try{el.focus()}')
    // 无闪蓝：操作期间把本元素选中态设为透明，结束即还原
    expect(s).toContain('function noFlash(on)')
    expect(s).toContain('.dsh-nf-sel::selection{background:transparent')
    expect(s).toContain('function finish(ok){noFlash(false);cb(ok)}')
    // 空目标（取消框选清除隐式行）判据必须是"内容为空"（曾导致取消框选清不掉）
    expect(s).toContain("function isEmpty(){return normWs(txt())===''}")
    expect(s).toContain("want===''?t===''")
    expect(s).toContain('function applied()')
    expect(s).toContain("evType('beforeinput'") // 降级路径：输入事件（Lexical 只认输入事件）
    // mergeFill 全局剔除旧隐式行（不依赖换行分块——Lexical textContent 拼接无换行）
    expect(s).toContain('function stripBridge(s)')
    expect(s).toContain('replace(/\\[\\s*BRIDGES is delivering packages for you……[^\\]]*\\]/g')
    // 读内容用 innerText（保留块间换行）
    expect(s).toContain("(el.innerText||el.textContent||'')")
    // ack 带 ok（+sep）：插件据此走重试/直发兜底
    expect(s).toContain("postMessage({type:'dsh-fill-ack',ok:!!ok,sep:sep}")
    // pick 双查询：textarea 优先，contentEditable 兜底
    expect(s).toContain('textarea[data-phase]')
    expect(s).toContain('[contenteditable="true"]')
  })
  it('v2.3.2/v2.4.0 嵌入认证适配器（页面侧）：fetch/WebSocket/XHR/EventSource 四路都补凭证；无 token 惰性', () => {
    const s = bridgeScriptSource()
    expect(s).toContain('__DSH_EMBED_TOKEN__')
    expect(s).toContain("h.authorization='Bearer '+ET")
    expect(s).toContain("'token='+encodeURIComponent(ET)")
    // 仅 ET 非空才包装（<0.1.2 页面零影响）
    expect(s).toMatch(/if\(ET\)\{function apiHdr\(n\)\{/)
    // fetch input 归一化必须含 .href（DSH 前端传 URL 对象——白屏事故回归）
    expect(s).toContain('String(i.href||i.url||i)')
    // v2.4.0：0.1.5 的文件上传进度与侧栏文档预览走 XHR，旧代码只补 fetch 会漏挂 → 401
    expect(s).toContain('window.XMLHttpRequest&&window.XMLHttpRequest.prototype')
    expect(s).toContain("this.setRequestHeader('authorization','Bearer '+ET)")
    // EventSource（HMR 等）无法带 header → 与 WebSocket 一样补 query token
    expect(s).toContain('window.EventSource')
    expect(s).toContain('EES.prototype=OE.prototype')
  })
  it('v2.3.2/v2.4.0 页面补丁真机回归：stub 执行——fetch（URL 对象/字符串/Headers）与 XHR 都补 Bearer；非 /api 不注入', () => {
    const captured: { url: unknown; init?: Record<string, unknown> }[] = []
    const xhrHeaders: string[] = []
    const XhrStub = function (this: Record<string, unknown>): void {
      // 构造器留空：只验证原型被打补丁后的行为
    } as unknown as { prototype: Record<string, unknown> }
    XhrStub.prototype = {
      open: (_method: string, _url: string) => undefined,
      send: () => undefined,
      setRequestHeader: (key: string, value: string) => {
        xhrHeaders.push(`${key}=${value}`)
      },
    }
    const windowStub: Record<string, unknown> = {
      __DSH_OBSIDIAN_BRIDGE__: undefined,
      __DSH_EMBED_TOKEN__: 'TOK123',
      parent: null,
      location: { href: 'http://127.0.0.1:3199/' },
      addEventListener: () => undefined,
      fetch: (input: unknown, init?: Record<string, unknown>) => {
        captured.push({ url: input, init })
        return Promise.resolve({})
      },
      XMLHttpRequest: XhrStub,
    }
    const documentStub = {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
      body: { addEventListener: () => undefined },
    }
    new Function('window', 'document', 'Event', bridgeScriptSource())(windowStub, documentStub, class {})
    const patched = windowStub.fetch as (i: unknown, n?: Record<string, unknown>) => Promise<unknown>
    // ① URL 对象（DSH 前端真实形态）
    void patched(new URL('http://127.0.0.1:3199/api/session/list'), { headers: { 'content-type': 'application/json' } })
    const h1 = captured[0].init?.headers as Record<string, string>
    expect(h1.authorization).toBe('Bearer TOK123')
    expect(h1['content-type']).toBe('application/json') // 原 header 未丢失
    // ② 字符串 input
    void patched('/api/host.describe', {})
    expect((captured[1].init?.headers as Record<string, string>).authorization).toBe('Bearer TOK123')
    // ③ 非 /api：原样透传（不改 headers）
    void patched('/assets/logo.png', { headers: { accept: '*/*' } })
    expect((captured[2].init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
    // ④ Headers 实例形态（forEach 复制路径）
    const hd = { forEach: (fn: (v: string, k: string) => void) => fn('application/json', 'content-type') }
    void patched('http://127.0.0.1:3199/api/x', { headers: hd })
    const h4 = captured[3].init?.headers as Record<string, string>
    expect(h4['content-type']).toBe('application/json')
    expect(h4.authorization).toBe('Bearer TOK123')
    // ⑤ XHR（0.1.5 文件上传进度 / 侧栏文档预览）：/api 请求在 send 前补 Authorization
    const XhrCtor = windowStub.XMLHttpRequest as new () => { open: (m: string, u: string) => void; send: () => void }
    const apiXhr = new XhrCtor()
    apiXhr.open('POST', 'http://127.0.0.1:3199/api/file/upload')
    apiXhr.send()
    expect(xhrHeaders).toEqual(['authorization=Bearer TOK123'])
    // ⑥ 非 /api 的 XHR：不注入
    const staticXhr = new XhrCtor()
    staticXhr.open('GET', '/assets/logo.png')
    staticXhr.send()
    expect(xhrHeaders).toHaveLength(1)
  })
  it('v2.3.2 嵌入认证适配器（服务端）：包裹 requestRejection/authorizeIndex，条件化且可探测失效；.mjs 语法有效', async () => {
    const p = bridgePluginSource()
    expect(p).toContain('embedPatchAuth')
    expect(p).toContain('requestRejection')
    expect(p).toContain('authorizeIndex')
    // 关键安全不变量的文字证据：只覆盖 401 判定（fence 403 原样）、index 必须 ob=1+token（浏览器 303 路径不动）
    expect(p).toContain('if (verdict !== 401) return verdict')
    expect(p).toContain("sp.get(EMBED_MARKER_QUERY) === '1'")
    // 防重复打补丁 + 探测失败自动失效
    expect(p).toContain('__dshEmbedPatched')
    expect(p).toContain("typeof conn.authenticatedUrl !== 'function'")
    const { transformSync } = await import('esbuild')
    expect(() => transformSync(p, { loader: 'js' })).not.toThrow()
  })
  it('v2.3.2 embedFrameUrl：有启动链接加 ob=1；无 query 的链接用 ?ob=1；无链接回普通地址', () => {
    expect(embedFrameUrl('', 3080)).toBe('http://127.0.0.1:3080/')
    expect(embedFrameUrl('http://127.0.0.1:3080/?token=abc', 3080)).toBe('http://127.0.0.1:3080/?token=abc&ob=1')
    expect(embedFrameUrl('http://127.0.0.1:3080/', 3080)).toBe('http://127.0.0.1:3080/?ob=1')
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
  it('首次写入：创建独立包（package.json + index.mjs）并追加补丁条目，changed=true', () => {
    const home = tempHome()
    try {
      const r = writeBridgeFiles(home, '9.9.9')
      expect(r.changed).toBe(true)
      expect(r.error).toBeUndefined()
      const dir = webProfileDir(home)
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain(BRIDGE_ENTRY_ID)
      expect(patch).toContain('file:///')
      expect(patch).toContain(bridgeModulePath(dir).replaceAll('\\', '/'))
      expect(readFileSync(bridgeModulePath(dir), 'utf8')).toContain('dsh-obsidian-bridge')
      // 包清单 name/version 非空（DSH 插件清单扩展的硬要求）
      const manifest = JSON.parse(readFileSync(join(bridgePackageDir(dir), 'package.json'), 'utf8')) as { name?: string; version?: string }
      expect(manifest.name).toBe(BRIDGE_PACKAGE_NAME)
      expect(manifest.version).toBe('9.9.9')
      // 旧布局文件不再产生
      expect(existsSync(join(dir, BRIDGE_FILENAME))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('旧布局迁移：根目录 .mjs + 旧补丁条目 → 独立包，旧文件备份后删除、条目指向新模块', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const legacy = join(dir, BRIDGE_FILENAME)
      writeFileSync(legacy, '// 用户手改过的旧桥接\nexport const name = "old"', 'utf8')
      const legacyUrl = `file:///${legacy.replaceAll('\\', '/')}`
      writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: ${legacyUrl}\n`, 'utf8')
      const r = writeBridgeFiles(home)
      expect(r.error).toBeUndefined()
      expect(r.changed).toBe(true) // 条目迁移需要重启生效
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).not.toContain(legacyUrl)
      expect(patch).toContain(bridgeModulePath(dir).replaceAll('\\', '/'))
      expect(existsSync(legacy)).toBe(false) // 旧文件已清理
      expect(readFileSync(`${legacy}.bak-local`, 'utf8')).toContain('用户手改过的旧桥接')
      // 再次调用幂等（条目已指向新模块）
      expect(writeBridgeFiles(home).changed).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('upsertBridgeEntry：同 id 且 name 已是目标 → 不改；name 不同 → 仅替换该行', () => {
    const url = 'file:///C:/x/index.mjs'
    const entry = `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: ${url}\n`
    const same = upsertBridgeEntry(entry, entry, url)
    expect(same.changed).toBe(false)
    const other = `- insert:\n    - id: ${BRIDGE_ENTRY_ID}\n      name: file:///C:/old/legacy.mjs\n- disabled: true\n  id: other\n`
    const fixed = upsertBridgeEntry(other, entry, url)
    expect(fixed.changed).toBe(true)
    expect(fixed.content).toContain(url)
    expect(fixed.content).not.toContain('legacy.mjs')
    expect(fixed.content).toContain('id: other') // 其它条目不受影响
  })
  it('身份解析回归（复刻 dsh-plugin-package-inventory-deepseek 规则）：旧布局必须抛错，新布局在无 version 的 profile 下仍可解析', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      // 复刻上游两条规则（见 dsh-plugin-package-inventory-deepseek/lib/index.js）：
      // ① nearestManifest：从模块路径向上找最近的 package.json
      // ② identityFromManifest：非匿名时 name/version 必须非空，否则 throw
      const nearestManifest = (modulePath: string): string | undefined => {
        let current = dirname(modulePath)
        for (;;) {
          const candidate = join(current, 'package.json')
          if (existsSync(candidate)) return candidate
          const next = dirname(current)
          if (next === current) return undefined
          current = next
        }
      }
      const identityFromManifest = (manifestPath: string, allowAnonymous: boolean): { name: string; version: string } | undefined => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (allowAnonymous && manifest.name === undefined) return undefined
        if (
          typeof manifest.name !== 'string' || manifest.name.length === 0 ||
          typeof manifest.version !== 'string' || manifest.version.length === 0
        ) {
          throw new Error(`${manifestPath} must declare non-empty name and version`)
        }
        return { name: manifest.name, version: manifest.version }
      }
      // dsh initProfile 的模板：有 name、没有 version；离线模块属于 profile（allowAnonymous=true）
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')

      // 旧布局：.mjs 直接躺在 profile 根目录 → nearestManifest 命中 profile 清单 → 抛错（REQUEST_EXTENSION 根因）
      const legacyPath = join(dir, BRIDGE_FILENAME)
      writeFileSync(legacyPath, '// legacy bridge', 'utf8')
      const legacyManifest = nearestManifest(legacyPath)
      expect(legacyManifest).toBe(join(dir, 'package.json'))
      expect(() => identityFromManifest(legacyManifest as string, true)).toThrow(/non-empty name and version/)

      // 新布局：独立包目录 → nearestManifest 命中桥接自己的清单 → 解析成功，不依赖 profile 的 version
      writeBridgeFiles(home, '9.9.9')
      const packagedManifest = nearestManifest(bridgeModulePath(dir))
      expect(packagedManifest).toBe(join(bridgePackageDir(dir), 'package.json'))
      const identity = identityFromManifest(packagedManifest as string, true)
      expect(identity).toEqual({ name: BRIDGE_PACKAGE_NAME, version: '9.9.9' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('bridgePackageManifest：空版本回退为非空兜底值', () => {
    const parsed = JSON.parse(bridgePackageManifest('   ')) as { name?: string; version?: string }
    expect(parsed.name).toBe(BRIDGE_PACKAGE_NAME)
    expect((parsed.version ?? '').length).toBeGreaterThan(0)
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
  it('清单缺 version：安装桥接时自动补上，且其余字段与键序原样保留', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
      writeFileSync(
        manifestPath,
        JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + '\n',
        'utf8',
      )
      writeBridgeFiles(home)
      const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      expect(after.version).toBe(PROFILE_MANIFEST_VERSION)
      // 键序：version 紧随 name；其余字段值不变
      expect(Object.keys(after)).toEqual(['name', 'version', 'private', 'dependencies', 'dsh'])
      expect((after.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual(bundles)
      expect(after.private).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('清单已有 version：保持原值，不被改写', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-profile-web', version: '9.9.9', private: true }) + '\n', 'utf8')
      writeBridgeFiles(home)
      expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version).toBe('9.9.9')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('合规清单的幂等：重复安装不产生新的写入', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-profile-web', private: true }) + '\n', 'utf8')
      writeBridgeFiles(home)
      const first = readFileSync(manifestPath, 'utf8')
      writeBridgeFiles(home)
      expect(readFileSync(manifestPath, 'utf8')).toBe(first)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('清单不存在：不凭空创建', () => {
    const home = tempHome()
    try {
      const manifestPath = join(webProfileDir(home), 'package.json')
      writeBridgeFiles(home)
      expect(existsSync(manifestPath)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('清单损坏：不抛错，桥接仍正常安装', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'package.json')
      writeFileSync(manifestPath, '{ 这不是 JSON\n', 'utf8')
      const r = writeBridgeFiles(home)
      expect(r.error).toBeUndefined()
      expect(r.changed).toBe(true)
      expect(existsSync(bridgeModulePath(dir))).toBe(true)
      // 损坏的清单保持原样，不被覆盖
      expect(readFileSync(manifestPath, 'utf8')).toBe('{ 这不是 JSON\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('内容哈希保险：旧插件写回的旧版文件会被当前源码覆盖恢复', () => {
    const home = tempHome()
    try {
      const dir = webProfileDir(home)
      mkdirSync(dir, { recursive: true })
      const file = bridgeModulePath(dir)
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
      const file = bridgeModulePath(dir)
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
  const implicitLine = '[ BRIDGES is delivering packages for you…… · 29 words · L30:273-L30:431 · D:\\vault\\a.md · ]'

  it('含 pre-step 注入所需标记与防重复逻辑', () => {
    const s = bridgeEditInjectSource()
    expect(s).toContain('dsh-obsidian-bridge')
    // source.form 必须落在 dsh 冻结清单内，否则 0.1.5 的会话格式迁移会拒收整个会话
    expect(s).toContain("form: 'notice'")
    expect(s).toContain('summary')
    expect(s).toContain('fs read')
    expect(s).toContain('fs edit')
    expect(s).toContain('是否同意')
    expect(s).toContain('BRIDGE_LINE_RE')
  })
  it('注入的消息自带 id 与 role（缺任一都会让会话读不出来）', async () => {
    const s = bridgeEditInjectSource()
    expect(s).toContain('bridgeMessageId')
    expect(s).toContain("role: 'user'")
    // 真正执行生成的内联代码，取出注入结果（而非仅字符串断言）
    const vm = await import('node:vm')
    const sandbox: Record<string, unknown> = { crypto: globalThis.crypto }
    vm.createContext(sandbox)
    vm.runInContext(s, sandbox, { timeout: 5000 })
    const inject = sandbox.bridgeEditMaybeInject as (i: { messages: unknown[] }) => Record<string, unknown> | null
    expect(typeof inject).toBe('function')
    const msg = inject({ messages: [{ role: 'user', content: [{ type: 'text', text: '请处理 ' + implicitLine }] }] })
    expect(msg).not.toBeNull()
    // dsh 的 assertMessageEventShape：id 必须是非空字符串
    expect(typeof msg?.id).toBe('string')
    expect(String(msg?.id).length).toBeGreaterThan(0)
    // 落盘后成为 user/message，role 必须是 'user'
    expect(msg?.role).toBe('user')
    // 原有字段不受影响
    expect(msg?.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-obsidian-bridge', form: 'notice' })
    expect(Array.isArray(msg?.content)).toBe(true)
  })
  it('无 crypto 时 id 仍有兜底（不退化为空串）', async () => {
    const vm = await import('node:vm')
    const sandbox: Record<string, unknown> = {}
    vm.createContext(sandbox)
    vm.runInContext(bridgeEditInjectSource(), sandbox, { timeout: 5000 })
    const inject = sandbox.bridgeEditMaybeInject as (i: { messages: unknown[] }) => Record<string, unknown> | null
    const msg = inject({ messages: [{ role: 'user', content: [{ type: 'text', text: implicitLine }] }] })
    expect(typeof msg?.id).toBe('string')
    expect(String(msg?.id).length).toBeGreaterThan(0)
  })
  it('未命中隐式行时不注入', async () => {
    const vm = await import('node:vm')
    const sandbox: Record<string, unknown> = { crypto: globalThis.crypto }
    vm.createContext(sandbox)
    vm.runInContext(bridgeEditInjectSource(), sandbox, { timeout: 5000 })
    const inject = sandbox.bridgeEditMaybeInject as (i: { messages: unknown[] }) => unknown
    expect(inject({ messages: [{ role: 'user', content: [{ type: 'text', text: '普通提问，无隐式行' }] }] })).toBeNull()
  })
  it('生成的 source.form 落在 dsh 允许清单内', async () => {
    const s = bridgeEditInjectSource()
    const m = /form: '([^']+)'/.exec(s)
    expect(m).not.toBeNull()
    expect(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])
      .toContain(m?.[1])
    // notice 形态必须带 summary
    if (m?.[1] === 'notice') expect(s).toContain('summary')
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

describe('removeDshFixDisable（自愈：清除 dsh-fix 对桥接的禁用块）', () => {
  const own = '# dsh-obsidian-bridge — installed by the dsh-harness Obsidian plugin\n- insert:\n    - id: dsh-obsidian-bridge\n      name: file:///x.mjs\n'
  const dshFixBlock = '# dsh-fix: disabled entry "dsh-obsidian-bridge" at 2026-08-28T16:44:26.416Z\n- id: "dsh-obsidian-bridge"\n  disabled: true\n'
  it('移除 dsh-fix 禁用块，保留插件自身 insert 条目与其他条目', () => {
    const input = own + '\n' + dshFixBlock + '- id: auto-continue\n  disabled: true\n'
    const out = removeDshFixDisable(input)
    expect(out).not.toContain('dsh-fix: disabled entry')
    expect(out).toContain('- insert:\n    - id: dsh-obsidian-bridge')
    expect(out).toContain('- id: auto-continue') // 其他禁用条目保留
  })
  it('无 dsh-fix 禁用块时原样返回', () => {
    expect(removeDshFixDisable(own)).toBe(own)
    expect(removeDshFixDisable('')).toBe('')
  })
})
