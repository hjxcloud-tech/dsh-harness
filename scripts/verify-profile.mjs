/**
 * v2.6.0 多 profile 沙盒自动化验收（一次性验证脚本，非发布物）。
 *
 * 覆盖四层，全程使用隔离 DSH_HOME 与高位空闲端口，**绝不触碰**用户正在跑的 web@3080：
 *   S1 纯函数层：profile 名白名单、启动命令生成、端口三态决策表、祖链环保护、受管注册表读写；
 *   S2 代建层：真跑 dsh CLI 的 ensureProfile（created/exists/内置名拒绝）+ writeBridgeFiles 按 profile 落盘与哈希保险；
 *   S3 共存层：两个自定义 profile 实例同时在线——各自 served HTML 命中自己 profile 的桥接包（互不串味）、
 *      面板认证矩阵（ob=1+token 200 / 裸 401 / 跨 profile token 不通用）、v2.6.0 上传补丁随 profile 启动一并生效；
 *   S4 进程安全层：外部 DSH（非受管）占用端口 → acquirePort 判 'external' 且**进程存活**；受管树根 → 判 'killed' 且端口释放；
 *      无关进程占用 → 不动；pid 复用（注册表指向非 DSH 命令行）→ 不杀。
 *   S3.7/S3.8（v2.6.0 追加）：页面级桥接探针 probeBridgeInjected 对真 DSH 的三态判定，
 *      以及适配判定表（区间/等级/优先级/24h 冷却）——启动弹窗的判据层，能自动化的部分不留给人肉。
 *
 * 用法：node scripts/verify-profile.mjs [--bin <dsh 的 lib/bin.js>] [--keep]
 *   缺省 --bin 取全局安装的 @deepseek-ai/dsh/lib/bin.js；--keep 保留隔离 home 便于事后翻看。
 *   亦可用 `npm run verify:profile`。
 *
 * 当前状态（2026-09-22 首轮真跑）：29/30，S2.4 为**真缺陷**红——ensureProfile 取「首个非空行」当提示，
 *   而 DSH 对内置模板名抛未捕获异常时 stderr 首行是栈定位（file:///…profile-boot-*.js:149），
 *   人话句被吞。修法：跳过 `file://`/`at ` 开头的行；另建议设置层把内置模板名一并拦掉。
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { request } from 'node:http'
import { connect } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const REPO = join(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const binIdx = argv.indexOf('--bin')
const DSH_BIN =
  binIdx >= 0
    ? argv[binIdx + 1]
    : join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(DSH_BIN)) {
  console.error(`找不到 DSH 入口：${DSH_BIN}\n用 --bin <lib/bin.js 路径> 指定`)
  process.exit(2)
}

// ---- 0. 用当前真源把插件模块打给沙盒用（与 verify-embed 同一惯例）----
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-profile-verify-bundles-'))
async function bundle(entry, outName) {
  const outFile = join(bundleDir, outName)
  await build({ entryPoints: [join(REPO, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: outFile })
  return require(outFile)
}
const bridge = await bundle('src/bridge.ts', 'bridge.cjs')
const sm = await bundle('src/service-manager.ts', 'service-manager.cjs')
const profileMod = await bundle('src/profile.ts', 'profile.cjs')
const compat = await bundle('src/compat.ts', 'compat.cjs')

// ---- 1. 断言骨架 ----
let failures = 0
const results = []
function pass(name, detail) {
  results.push(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
  console.log(results[results.length - 1])
}
function fail(name, err) {
  failures += 1
  results.push(`FAIL  ${name} — ${err instanceof Error ? err.message : String(err)}`)
  console.log(results[results.length - 1])
}
async function check(name, fn) {
  try {
    pass(name, await fn())
  } catch (err) {
    fail(name, err)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
  return 'ok'
}

// ---- 2. 隔离 home 与端口 ----
const HOME = mkdtempSync(join(tmpdir(), 'dsh-profile-sandbox-'))
mkdirSync(join(HOME, 'profiles'), { recursive: true })
process.env.DSH_HOME = HOME
// 开工前记下本机既有 web@3080 实例（若由别处拉起）：沙盒全程不碰它，收尾核验存活——共存底线的外证。
const PRE_EXISTING_3080 = sm.portOwnerPids(3080)
const started = []
/** 异步探活（TCP 连接成功即视为占用）；端口挑选与释放确认都用它。 */
async function portBusy(port) {
  const up = await new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const t = setTimeout(() => {
      s.destroy()
      resolve(false)
    }, 700)
    s.once('connect', () => {
      clearTimeout(t)
      s.destroy()
      resolve(true)
    })
    s.once('error', () => {
      clearTimeout(t)
      resolve(false)
    })
  })
  return up
}
async function pickPort(base) {
  for (let i = 0; i < 60; i += 1) {
    const p = base + i
    if (!(await portBusy(p))) return p
  }
  throw new Error(`${String(base)} 起连续 60 个端口都被占用`)
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}
function probe(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${String(port)}`, ...headers }, timeout: 8000 },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('timeout', () => req.destroy(new Error('probe timeout')))
    req.on('error', reject)
    req.end()
  })
}
/** 以「插件真实拉起路径」启动一个服务：Windows 下经 resolveExec（cmd.exe /d /s /c dsh …），可模拟受管树根。 */
function bootInstance({ profileName, port, useCmdWrapper }) {
  const args = ['--profile', profileName, '--port', String(port), '--no-open']
  const resolved = useCmdWrapper
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'dsh', ...args] }
    : { command: process.execPath, args: [DSH_BIN, ...args] }
  const child = spawn(resolved.command, resolved.args, {
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: REPO,
  })
  let buf = ''
  child.stdout?.on('data', (b) => {
    buf += b.toString()
  })
  child.stderr?.on('data', (b) => {
    buf += b.toString()
  })
  child.on('exit', (code) => {
    buf += `\n[exit ${String(code)}]`
  })
  started.push(child)
  return { child, output: () => buf }
}
async function waitLaunchUrl(ctx, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const url = sm.parseLaunchUrl(ctx.output())
    if (url !== '') return url
    if (Date.now() > deadline) throw new Error('等待启动 URL 超时：' + ctx.output().slice(0, 500))
    await new Promise((r) => setTimeout(r, 500))
  }
}
function tokenOf(url) {
  return new URL(url).searchParams.get('token') ?? ''
}

// 开工前记录本机既有 web@3080 实例（若用户在跑）：整轮跑完必须它仍在——多 profile 共存底线的外证
console.log(`[sandbox] home=${HOME}`)
console.log(`[sandbox] bin=${DSH_BIN}`)
console.log(`[sandbox] 既有 3080 占用者=${PRE_EXISTING_3080.length > 0 ? PRE_EXISTING_3080.join('/') : '（无）'}`)

try {
  // ================= S1 纯函数层 =================
  console.log('\n--- S1 纯函数（profile 归一 / 命令生成 / 端口裁决 / 受管注册表）---')

  await check('S1.1 normalizeProfile 白名单：合法名保留，非法名退回 web', () => {
    const ok = ['test', 'a-b_c1', 'sbx2', 'z9']
    const bad = ['Web', '1abc', '../x', 'a b', '', 'x'.repeat(65), null, undefined, 42]
    for (const v of ok) assert(profileMod.normalizeProfile(v) === v, `合法名被拒：${String(v)}`)
    for (const v of bad) assert(profileMod.normalizeProfile(v) === 'web', `非法名未拦：${String(v)}`)
    return `${String(ok.length)} 合法 / ${String(bad.length)} 非法`
  })

  await check('S1.2 profileStartupCommand：web 逐字沿用旧命令，非 web 走主程序 --profile 形态', () => {
    const web = sm.profileStartupCommand('web')
    const custom = sm.profileStartupCommand('sbx1')
    assert(web === 'dsh web --port {port} --no-open', `web 命令变化（历史行为必须逐字一致）：${web}`)
    assert(custom.includes('--profile sbx1'), `非 web 命令缺 --profile：${custom}`)
    assert(custom.includes('{port}'), `非 web 命令缺 {port} 模板：${custom}`)
    assert(!/^dsh web/.test(custom), `非 web 误用 web 子命令（该子命令拒收 --profile）：${custom}`)
    return `web="${web}" / custom="${custom}"`
  })

  await check('S1.3 repoStartupTail：源码形态尾段随 profile 变形', () => {
    const web = sm.repoStartupTail('web')
    const custom = sm.repoStartupTail('sbx1')
    assert(web.includes('web'), web)
    assert(custom.includes('--profile') && custom.includes('sbx1'), custom)
    return `web="${web}" / custom="${custom}"`
  })

  await check('S1.4 renderCommand：{port} 全量替换后首段为命令', () => {
    const r = sm.renderCommand(sm.profileStartupCommand('sbx1'), 3457)
    assert(r.command === 'dsh', `command=${r.command}`)
    assert(r.args.includes('3457'), r.args.join(' '))
    assert(!r.args.some((a) => a.includes('{port}')), '仍有未替换占位')
    return r.args.join(' ')
  })

  await check('S1.5 portOwnerVerdict 决策表三态 + pid 复用', () => {
    const dshCmd = `"${process.execPath}" "${DSH_BIN}" --profile sbx1 --port 3457 --no-open`
    const launchRoot = `wscript.exe //nologo //b ${join(tmpdir(), 'dsh-launch-9-1.vbs')}`
    const foreign = `"${process.execPath}" -e "require('http')" `
    assert(sm.portOwnerVerdict(dshCmd, true) === 'kill', '受管 DSH 应判 kill')
    assert(sm.portOwnerVerdict(launchRoot, true) === 'kill', '受管 dsh-launch 树根应判 kill')
    assert(sm.portOwnerVerdict(dshCmd, false) === 'external', '外部 DSH 必须判 external（绝不杀）')
    assert(sm.portOwnerVerdict(foreign, false) === 'ignore', '无关进程应判 ignore')
    assert(sm.portOwnerVerdict(foreign, true) === 'ignore', '注册表命中但命令行对不上（pid 复用）应判 ignore')
    return 'kill/external/ignore 五例全中'
  })

  await check('S1.6 ancestorChain：正常上溯 + 环保护 + 起点不在表', () => {
    const rows = [
      { pid: 1, ppid: 0, cmd: 'root' },
      { pid: 2, ppid: 1, cmd: 'a' },
      { pid: 3, ppid: 2, cmd: 'b' },
      { pid: 10, ppid: 11, cmd: 'x' },
      { pid: 11, ppid: 10, cmd: 'y' },
    ]
    assert(sm.ancestorChain(rows, 3).map((r) => r.pid).join('>') === '3>2>1', '正常链不符')
    const cyc = sm.ancestorChain(rows, 10)
    assert(cyc.length === 2 && cyc.map((r) => r.pid).join('>') === '10>11', `环未收敛：${String(cyc.length)}`)
    assert(sm.ancestorChain(rows, 999).length === 0, '起点不在表中应返回空')
    return '链/环/缺失 三态通过'
  })

  await check('S1.7 受管注册表：写入→按端口读取→注销→死 pid 自动清理', () => {
    const file = join(HOME, 'managed-test.json')
    sm.registerManagedProc({ pid: process.pid, port: 3401, profile: 'sbx1' }, file)
    sm.registerManagedProc({ pid: 999999, port: 3402, profile: 'sbx2' }, file)
    const rows = sm.readManagedProcs(file)
    assert(rows.length === 2, `应两条：${String(rows.length)}`)
    assert(sm.managedPidsForPort(3401, file).join() === String(process.pid), '按端口读取不符')
    assert(sm.managedPidsForPort(3402, file).length === 0, '死 pid 应被 managedPidsForPort 顺带清理')
    assert(sm.readManagedProcs(file).length === 1, '死 pid 未落盘清理')
    sm.unregisterManagedProc(process.pid, file)
    assert(sm.readManagedProcs(file).length === 0, '注销失败')
    assert(sm.managedRegistryFile('C:\\t').endsWith('dsh-obsidian-managed.json'), '注册表文件名不符')
    return '登记/清理/注销通过（坏 JSON 与缺文件按空表处理）'
  })

  await check('S1.8 DSH_CMD_RE：只认官方身份（v2.6.1 收紧），第三方 dsh 包与无关进程不命中', () => {
    // 官方身份四类锚点：官方包路径 / 官方仓库布局 / 插件生成的命令形态 / 桥接模块路径。
    assert(sm.DSH_CMD_RE.test(`"${process.execPath}" "${DSH_BIN}" --profile sbx1 --port 3457 --no-open`), 'profile 形态真机命令行未命中')
    assert(sm.DSH_CMD_RE.test(`"${process.execPath}" "C:\\x\\@deepseek-ai\\dsh\\lib\\bin.js" web --port 3080`), '全局 CLI 形态未命中')
    assert(sm.DSH_CMD_RE.test('"C:\\Windows\\System32\\cmd.exe" /d /s /c dsh --profile test --port 3081 --no-open'), 'cmd 包装层 profile 形态未命中')
    assert(sm.DSH_CMD_RE.test('pnpm dsh web --port 3080'), 'pnpm 包装层未命中')
    assert(sm.DSH_CMD_RE.test('node D:\\deepseek-harness\\apps\\cli\\src\\bin.ts web --port 3080'), '官方仓库源码形态未命中')
    // 第三方 scope（实测存在 @x1a0f3n9/dsh-* 社区包）一律不得命中——旧正则的 `dsh\lib\bin.js` 与 `dsh.cmd|dsh.js`
    // 两条宽松分支会把它算进「升级前全机杀」的目标，v2.6.1 删除。
    assert(!sm.DSH_CMD_RE.test('node C:\\y\\@x1a0f3n9\\dsh-web-app\\lib\\index.js web'), '第三方 scope 误命中')
    assert(!sm.DSH_CMD_RE.test('node D:\\forks\\dsh\\lib\\bin.js --profile x'), '第三方 fork 的 dsh\\lib\\bin.js 误命中')
    assert(!sm.DSH_CMD_RE.test('C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd --profile x'), '第三方 dsh.cmd shim 误命中')
    assert(!sm.DSH_CMD_RE.test(`D:\\node.exe C:\\app\\server.js --port 3457`), '无关 node 进程误命中')
    assert(!sm.DSH_CMD_RE.test(`wscript.exe //b C:\\Temp\\other.vbs`), '无关 wscript 误命中')
    const filtered = sm.filterDshProcesses(
      [
        { pid: 5, command: `"${process.execPath}" "${DSH_BIN}" --profile sbx1 --port 3457` },
        { pid: 6, command: 'node other.js' },
        { pid: 7, command: 'node C:\\y\\@x1a0f3n9\\dsh-workspace\\lib\\index.js web' },
        { pid: process.pid, command: `"${process.execPath}" "${DSH_BIN}" --profile me` },
      ],
      process.pid,
    )
    assert(filtered.length === 1 && filtered[0].pid === 5, JSON.stringify(filtered))
    return '官方 5 形态命中 / 第三方与无关 4 形态不命中 / 进程过滤排自身'
  })

  // ================= S2 代建与装桥接 =================
  console.log('\n--- S2 ensureProfile 代建（真跑 dsh CLI）+ 桥接按 profile 落盘 ---')

  await check('S2.1 ensureProfile("web") → exists（内置模板不代建）', async () => {
    const r = await sm.ensureProfile(HOME, 'web')
    return assert(r.kind === 'exists', JSON.stringify(r))
  })

  await check('S2.2 ensureProfile("sbx1") → created，且只建不 boot（无服务残留）', async () => {
    const profilesDir = join(HOME, 'profiles')
    const before = existsSync(profilesDir) ? readdirSync(profilesDir) : []
    const r = await sm.ensureProfile(HOME, 'sbx1')
    assert(r.kind === 'created', JSON.stringify(r))
    const dir = join(profilesDir, 'sbx1')
    assert(existsSync(join(dir, 'package.json')), 'profile 清单缺失')
    assert(!before.includes('sbx1'), 'sbx1 不该预先存在')
    // 只建不 boot：代建后不应有任何进程在监听（--dump-default-config 打印即退）
    const booting = readdirSync(dir).join(',')
    assert(!booting.includes('storages'), `代建疑似连带 boot：${booting}`)
    return `新建 sbx1（${booting}）`
  })

  await check('S2.3 ensureProfile 幂等：二次调用 → exists', async () => {
    const r = await sm.ensureProfile(HOME, 'sbx1')
    return assert(r.kind === 'exists', JSON.stringify(r))
  })
  await check('S2.4 内置模板名（headless）被插件层拦下：failed + 可读提示，且不建目录、不外呼 CLI', async () => {
    // PROFILE_TEMPLATES 的键才是保留名（acp/web/headless/sdk/sdk-minimal）；rescue 只是 dsh 帮助里的示例自定义名。
    const t0 = Date.now()
    const r = await sm.ensureProfile(HOME, 'headless')
    assert(r.kind === 'failed', `内置模板名应 failed，实际 ${JSON.stringify(r)}`)
    assert(Date.now() - t0 < 3000, `疑似仍去外呼 CLI（耗时 ${String(Date.now() - t0)}ms）`)
    assert(!existsSync(join(HOME, 'profiles', 'headless', 'package.json')), '保留名目录被建出')
    // 提示必须是人话：不能是 Node 未捕获异常的栈定位（v2.6.1 前正是 `file:///…profile-boot-*.js:149`）
    assert(/内置|built-in/i.test(r.error), `提示不可读：${r.error.slice(0, 120)}`)
    assert(!/^file:\/\//i.test(r.error), `提示是栈定位行：${r.error.slice(0, 120)}`)
    return r.error.slice(0, 90)
  })

  await check('S2.4b pickErrorLine：DSH 未捕获异常版式取到第 5 行人话句（真机取证版式）', () => {
    const real = [
      'file:///C:/Users/me/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:149',
      '\tif (Object.hasOwn(PROFILE_TEMPLATES, name)) throw new Error(`${NAME}: profile …`);',
      '\t                                                  ^',
      '',
      'Error: dsh: profile "headless" is shipped and cannot be a custom profile target; omit --from-default-profile to use it',
      '    at initializeProfileFromDefault (file:///C:/Users/me/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:149:80)',
      '',
      'Node.js v24.14.1',
    ].join('\n')
    const line = sm.pickErrorLine(real)
    assert(/is shipped and cannot be a custom profile target/.test(line), `取错行：${line}`)
    assert(!/^file:\/\//.test(line) && !/^at\s/.test(line), `仍是栈帧：${line}`)
    assert(sm.pickErrorLine('') === '', '空输入应返回空串')
    return line.slice(0, 80)
  })

  await check('S2.5 非法名的防线定位：DSH CLI 不设防（实测会建目录），拦截与归一都在插件层', async () => {
    const r = await sm.ensureProfile(HOME, 'Bad')
    // 事实取证：CLI 侧接受大写名并成功建档 —— 所以白名单是唯一防线，必须由设置层断死
    assert(r.kind === 'created' || r.kind === 'exists', `本轮取证需 CLI 确实放行：${JSON.stringify(r)}`)
    assert(profileMod.VALID_PROFILE_RE.test('Bad') === false, '白名单竟放行 Bad')
    // 归一层：大小写不转换（白名单只收小写）；内置名与点段打回 web
    assert(profileMod.normalizeProfile('Bad') === 'web', `Bad 归一异常：${profileMod.normalizeProfile('Bad')}`)
    assert(profileMod.normalizeProfile('WEB') === 'web', 'WEB 应归一到默认档')
    assert(profileMod.normalizeProfile('headless') === 'web', '内置名未打回 web')
    assert(profileMod.normalizeProfile('../x') === 'web', '点段名未打回 web')
    assert(profileMod.isReservedProfile('acp') === true, 'acp 未列内置保留名')
    assert(profileMod.isReservedProfile('rescue') === false, 'rescue 被误列保留名')
    return 'CLI 放行「Bad」已取证；插件层归一 bad／内置名打回 web／保留名判定正确'
  })

  await check('S2.6 writeBridgeFiles(profile=sbx1)：桥接包落在 sbx1 目录，补丁条目指向自身', () => {
    const res = bridge.writeBridgeFiles(HOME, '2.6.0', 'sbx1')
    assert(!res.error, `写入失败：${String(res.error)}`)
    const dir = bridge.dshProfileDir('sbx1', HOME)
    const mod = bridge.bridgeModulePath(dir)
    assert(existsSync(mod), `桥接模块缺失：${mod}`)
    assert(existsSync(join(bridge.bridgePackageDir(dir), 'package.json')), '桥接包清单缺失')
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert(patch.includes('dsh-obsidian-bridge/index.mjs'), '补丁条目未指向打包模块')
    assert(/profiles[\\/]sbx1[\\/]/.test(patch), `条目路径不在 sbx1：${patch.split('\n').slice(-3).join(' | ')}`)
    assert(!/profiles[\\/]web[\\/]/.test(patch), '条目误指 web profile')
    const src = readFileSync(mod, 'utf8')
    assert(src.includes('dsh-file-upload'), 'v2.6.0 上传补丁（方案 B）未进入 profile 桥接包')
    assert(src.includes('__DSH_FILE_UPLOAD__'), 'v2.6.0 官方钩子（方案 A 兜底）未进入 profile 桥接包')
    return `mod=${mod.replace(HOME, '<home>')}；条目只指本 profile，含上传双路径`
  })

  await check('S2.7 writeBridgeFiles 哈希保险：内容一致不重写（旧 bundle 覆盖防护），手改则按真源复原', () => {
    const dir = bridge.dshProfileDir('sbx1', HOME)
    const mod = bridge.bridgeModulePath(dir)
    // changed 只跟踪补丁条目；桥接包是否重写看 pluginRewritten（源码注释即此语义）
    const first = bridge.writeBridgeFiles(HOME, '2.6.0', 'sbx1')
    assert(first.changed === false && first.pluginRewritten === false, `一致状态竟有写入：${JSON.stringify(first)}`)
    // 手改一处 → 与真源不一致 → 重写复原，并留 .bak-local
    writeFileSync(mod, readFileSync(mod, 'utf8') + '\n// local edit\n', 'utf8')
    const second = bridge.writeBridgeFiles(HOME, '2.6.0', 'sbx1')
    assert(second.pluginRewritten === true, '手改后未识别为需重写')
    assert(existsSync(`${mod}.bak-local`), '未保留 .bak-local 备份')
    assert(!readFileSync(mod, 'utf8').includes('// local edit'), '真源未覆盖手改内容')
    return '一致→零写入；手改→复原 + 备份'
  })

  await check('S2.8 isBridgeInstalled 按 profile 判定（sbx1 真 / 未装 profile 假）', () => {
    assert(bridge.isBridgeInstalled(HOME, 'sbx1') === true, 'sbx1 应判已安装')
    assert(bridge.isBridgeInstalled(HOME, 'sbx2') === false, '未装 profile 误判为已安装')
    return 'ok'
  })

  await check('S2.9 桥接包语法有效（node --check）', async () => {
    const mod = bridge.bridgeModulePath(bridge.dshProfileDir('sbx1', HOME))
    await new Promise((resolve, reject) => {
      execFile(process.execPath, ['--check', mod], (err, _o, e2) =>
        err ? reject(new Error(String(e2 || err).slice(0, 300))) : resolve(),
      )
    })
    return 'index.mjs 语法通过'
  })

  // ================= S3 双 profile 实例共存 =================
  console.log('\n--- S3 双 profile 实例共存（真跑两个 dsh 服务，含 token 隔离与补丁归属）---')

  const P1 = await pickPort(3401)
  const P2 = await pickPort(3402)
  await sm.ensureProfile(HOME, 'sbx2')
  bridge.writeBridgeFiles(HOME, '2.6.0', 'sbx2')
  // 给 sbx2 的桥接包**注入脚本**打唯一标记（改的是会被写进 index.html 的页面脚本片段）：
  // 若两个实例各读各的 profile 补丁层，标记只应出现在 sbx2 的页面上。
  const mod2 = bridge.bridgeModulePath(bridge.dshProfileDir('sbx2', HOME))
  const src2 = readFileSync(mod2, 'utf8')
  assert(src2.includes('dsh-bridge-ready'), '桥接包页面脚本片段变化，标记注入点需更新')
  writeFileSync(mod2, src2.split('dsh-bridge-ready').join('dsh-bridge-sbx2'), 'utf8')

  console.log(`[boot] sbx1@${String(P1)}（外部实例形态：直跑 node，不登记受管） …`)
  const ctx1 = bootInstance({ profileName: 'sbx1', port: P1, useCmdWrapper: false })
  console.log(`[boot] sbx2@${String(P2)}（受管实例形态：cmd.exe /d /s /c dsh …） …`)
  const ctx2 = bootInstance({ profileName: 'sbx2', port: P2, useCmdWrapper: true })

  let url1 = ''
  let url2 = ''
  await check('S3.1 两实例均就绪并各自打印认证 URL', async () => {
    ;[url1, url2] = await Promise.all([waitLaunchUrl(ctx1), waitLaunchUrl(ctx2)])
    assert(/token=/.test(url1) && /token=/.test(url2), `url 异常：${url1} / ${url2}`)
    assert(url1.includes(`:${String(P1)}`) && url2.includes(`:${String(P2)}`), '端口与 URL 不符')
    return `sbx1=${String(P1)} / sbx2=${String(P2)}`
  })
  const t1 = tokenOf(url1)
  const t2 = tokenOf(url2)

  await check('S3.2 面板路径：GET /?token&ob=1 → 200 且注入桥接脚本（自定义 profile 也吃到补丁层）', async () => {
    const a = await probe(P1, `/?token=${encodeURIComponent(t1)}&ob=1`)
    const b = await probe(P2, `/?token=${encodeURIComponent(t2)}&ob=1`)
    assert(a.status === 200 && b.status === 200, `status ${String(a.status)}/${String(b.status)}`)
    assert(a.text.includes('__DSH_OBSIDIAN_BRIDGE__') && b.text.includes('__DSH_OBSIDIAN_BRIDGE__'), '桥接未注入')
    assert(a.text.includes('__DSH_EMBED_TOKEN__="'), '嵌入 token 未注入')
    return '两实例 200 + 桥接已注入'
  })

  await check('S3.3 v2.6.0 上传补丁随 profile 启动生效（Worker 补 token + 官方钩子）', async () => {
    const a = await probe(P1, `/?token=${encodeURIComponent(t1)}&ob=1`)
    assert(a.text.includes('dsh-file-upload'), '缺方案 B 的 Worker 补丁')
    assert(a.text.includes('__DSH_FILE_UPLOAD__'), '缺方案 A 官方钩子')
    assert(a.text.includes('window.top!==window.self') || a.text.includes('window.top !== window.self'), '缺顶层页闸门')
    return '上传三要素齐备'
  })

  await check('S3.4 补丁归属隔离：sbx2 独有标记只出现在 sbx2 页面（各 profile 读自己的桥接包）', async () => {
    const a = await probe(P1, `/?token=${encodeURIComponent(t1)}&ob=1`)
    const b = await probe(P2, `/?token=${encodeURIComponent(t2)}&ob=1`)
    assert(b.text.includes('dsh-bridge-sbx2'), 'sbx2 页面未含本 profile 标记 → 补丁可能串读或被别处覆盖')
    assert(!a.text.includes('dsh-bridge-sbx2'), 'sbx1 页面出现 sbx2 标记 → profile 隔离失败')
    assert(a.text.includes('dsh-bridge-ready'), 'sbx1 标记被串改 → 补丁层互相污染')
    return 'mark∈sbx2 ∧ mark∉sbx1 ∧ sbx1 原样'
  })

  await check('S3.5 认证围栏：裸 GET / → 401；跨 profile token 不通用', async () => {
    const bare = await probe(P1, '/')
    assert(bare.status === 401, `裸路径应 401，实际 ${String(bare.status)}`)
    const cross1 = await probe(P1, `/?token=${encodeURIComponent(t2)}&ob=1`)
    const cross2 = await probe(P2, `/?token=${encodeURIComponent(t1)}&ob=1`)
    assert(cross1.status !== 200, `sbx2 的 token 在 sbx1 上通过了（${String(cross1.status)}）`)
    assert(cross2.status !== 200, `sbx1 的 token 在 sbx2 上通过了（${String(cross2.status)}）`)
    return `bare=401 cross=${String(cross1.status)}/${String(cross2.status)}`
  })

  await check('S3.6 双服务互不干扰：两端口同时 200（共存不抢占）', async () => {
    const a = await probe(P1, `/?token=${encodeURIComponent(t1)}&ob=1`)
    const b = await probe(P2, `/?token=${encodeURIComponent(t2)}&ob=1`)
    assert(a.status === 200 && b.status === 200, `${String(a.status)}/${String(b.status)}`)
    assert(alive(ctx1.child.pid ?? -1) || alive(ownerPidOf(P1)), 'sbx1 已退出')
    return '两实例同时在线'
  })

  await check('S3.7 probeBridgeInjected 对真 DSH 生效（启动适配自检的页面级判据，不只看磁盘文件）', async () => {
    const live = await sm.probeBridgeInjected(P1, t1)
    assert(live === 'injected', `sbx1 应为 injected，实际 ${live}`)
    const wrongToken = await sm.probeBridgeInjected(P1, 'definitely-not-a-token')
    assert(wrongToken === 'unauthorized', `错 token 应判 unauthorized，实际 ${wrongToken}`)
    // 端口无人监听（沙盒里挑一个确定空闲的端口）
    const dead = await pickPort(3601)
    const gone = await sm.probeBridgeInjected(dead, 'x')
    assert(gone === 'unreachable', `无服务应判 unreachable，实际 ${gone}`)
    return 'injected / unauthorized / unreachable 三态全中'
  })

  await check('S3.8 适配判定表与插件源码一致（区间、优先级、24h 冷却）', () => {
    assert(compat.DSH_ADAPTED_MIN === '0.1.5-rc.1' && compat.DSH_ADAPTED_MAX_TESTED === '0.1.6-alpha.1', '实测区间被改动')
    assert(compat.judgeDshCompat('0.1.5-rc.2') === 'tested', '实测版应判 tested')
    assert(compat.judgeDshCompat('0.1.3') === 'incompatible', '0.1.2–0.1.4 应判 incompatible')
    assert(compat.judgeDshCompat('0.1.1') === 'legacy', '0.1.1 应判 legacy')
    assert(compat.judgeDshCompat('0.9.9') === 'untested-newer', '高于上界应判 untested-newer')
    assert(compat.judgeDshCompat('') === 'unknown' && compat.judgeDshCompat('master') === 'unknown', '不可解析形态应中性处理')
    // 优先级：桥接故障排在「未验证新版」之前（它更确定地意味着功能已经坏了）
    assert(compat.compatIssue('untested-newer', 'not-installed') === 'bridge-not-installed', '桥接未装优先级不对')
    assert(compat.compatIssue('legacy', 'not-live') === 'bridge-not-live', '桥接未生效优先级不对')
    assert(compat.compatIssue('tested', 'live') === null, '一切正常却报出问题')
    // 冷却：同问题同版本当日一次；版本变了立刻再提醒
    const t0 = 1_700_000_000_000
    let log = {}
    assert(compat.shouldAlert(log, 'untested', '0.9.9', t0) === true, '首次应弹')
    log = compat.markAlerted(log, 'untested', '0.9.9', t0)
    assert(compat.shouldAlert(log, 'untested', '0.9.9', t0 + 60_000) === false, '冷却期内重复弹')
    assert(compat.shouldAlert(log, 'untested', '0.9.9', t0 + compat.COMPAT_ALERT_COOLDOWN_MS) === true, '冷却结束仍不弹')
    assert(compat.shouldAlert(log, 'incompatible', '0.1.3', t0 + 60_000) === true, '不同问题被误抑制')
    return '区间/等级/优先级/冷却 全中'
  })

  // ================= S4 端口与进程安全 =================
  console.log('\n--- S4 端口裁决（外部 DSH 绝不杀 / 受管可杀 / 无关不动）---')

  function ownerPidOf(port) {
    const pids = sm.portOwnerPids(port)
    return pids.length > 0 ? pids[0] : -1
  }

  await check('S4.1 外部 DSH 占用（sbx1，未登记受管）→ 判 external 且进程存活', async () => {
    const ownerBefore = ownerPidOf(P1)
    assert(ownerBefore > 0, '未取到 sbx1 端口占用者')
    const verdict = await sm.acquirePort(P1, [])
    assert(verdict === 'external', `应判 external，实际 ${verdict}`)
    await new Promise((r) => setTimeout(r, 800))
    assert(alive(ownerBefore), `外部实例被杀了（底线失守）：pid ${String(ownerBefore)}`)
    const still = await probe(P1, `/?token=${encodeURIComponent(t1)}&ob=1`)
    assert(still.status === 200, `外部实例受损：status ${String(still.status)}`)
    return `external ∧ pid ${String(ownerBefore)} 存活 ∧ 页面 200`
  })

  await check('S4.2 受管实例（sbx2，登记 cmd.exe 树根）→ 判 killed、整树退出、端口释放、条目收敛', async () => {
    const regFile = join(HOME, 'managed-live.json')
    const rootPid = ctx2.child.pid
    assert(rootPid != null, '未取得 sbx2 树根 pid')
    const ownerBefore = ownerPidOf(P2)
    assert(ownerBefore > 0, '未取到 sbx2 端口占用者')
    sm.registerManagedProc({ pid: rootPid, port: P2, profile: 'sbx2' }, regFile)
    const managed = sm.readManagedProcs(regFile).map((r) => r.pid)
    const verdict = await sm.acquirePort(P2, managed)
    assert(verdict === 'killed', `应判 killed，实际 ${verdict}`)
    const deadline = Date.now() + 20000
    for (;;) {
      if (!(await portBusy(P2))) break
      if (Date.now() > deadline) throw new Error('端口未在 20s 内释放')
      await new Promise((r) => setTimeout(r, 500))
    }
    assert(ownerPidOf(P2) === -1, '端口仍有占用者')
    assert(!alive(ownerBefore), `端口占用者 ${String(ownerBefore)} 未被终止`)
    // 包装层（cmd.exe）随子进程退出而退：等它收敛，证明受管树整链回收、无孤儿常驻
    const rootDeadline = Date.now() + 10000
    while (alive(rootPid) && Date.now() < rootDeadline) await new Promise((r) => setTimeout(r, 300))
    assert(!alive(rootPid), `包装层 pid ${String(rootPid)} 残留为孤儿`)
    // 再走一次作用域重启内核：进程已没了 → 条目应被自动注销且返回 0（幂等，不重复下发 kill）
    const again = await sm.killManagedForPort(P2, regFile)
    assert(again === 0, `已死条目竟再次下发 kill：${String(again)}`)
    assert(sm.readManagedProcs(regFile).length === 0, '受管条目未收敛')
    return 'killed ∧ 端口释放 ∧ 无孤儿 ∧ 条目注销'
  })

  await check('S4.3 杀受管后外部实例仍健康（作用域重启的共存底线）', async () => {
    const r = await probe(P1, `/?token=${encodeURIComponent(t1)}&ob=1`)
    assert(r.status === 200, `status ${String(r.status)}`)
    assert(alive(ownerPidOf(P1)), 'sbx1 进程意外退出')
    return 'sbx1 依旧 200'
  })

  await check('S4.4 无关进程占用端口 → 不判 external 也不杀（ignore）', async () => {
    const P4 = await pickPort(3451)
    const decoy = spawn(
      process.execPath,
      ['-e', `require('http').createServer((q,r)=>r.end('x')).listen(${String(P4)},'127.0.0.1')`],
      { stdio: 'ignore', windowsHide: true },
    )
    started.push(decoy)
    const deadline = Date.now() + 15000
    for (;;) {
      if (await portBusy(P4)) break
      if (Date.now() > deadline) throw new Error('诱饵进程未监听成功')
      await new Promise((r) => setTimeout(r, 300))
    }
    const owner = ownerPidOf(P4)
    const verdict = await sm.acquirePort(P4, [])
    assert(verdict === 'free', `无关进程应被忽略（返回 free 交给上层照常 spawn），实际 ${verdict}`)
    assert(alive(owner), '无关进程被误杀')
    return `owner=${String(owner)} 存活 ∧ verdict=free`
  })

  await check('S4.5 pid 复用防御：注册表指向非 DSH 命令行 → killManagedForPort 返回 0', async () => {
    const regFile = join(HOME, 'managed-reuse.json')
    sm.registerManagedProc({ pid: process.pid, port: P1, profile: 'sbx1' }, regFile)
    const killed = await sm.killManagedForPort(P1, regFile)
    assert(killed === 0, `当前进程被当成可杀目标（killed=${String(killed)}）`)
    assert(alive(process.pid), '自杀了')
    const still = await probe(P1, `/?token=${encodeURIComponent(t1)}&ob=1`)
    assert(still.status === 200, '端口服务受损')
    return 'killed=0（存活但命令行不匹配 → 跳过）'
  })

  await check('S4.6 空闲端口 → acquirePort 判 free', async () => {
    const P5 = await pickPort(3471)
    const v = await sm.acquirePort(P5, [])
    return assert(v === 'free', `实际 ${v}`)
  })

  await check('S4.7 沙盒全程未波及既有 web@3080 实例（共存底线的外证）', async () => {
    if (PRE_EXISTING_3080.length === 0) return '本机 3080 无实例，跳过'
    for (const pid of PRE_EXISTING_3080) {
      assert(alive(pid), `既有 3080 实例 pid ${String(pid)} 被波及`)
    }
    const r = await probe(3080, '/')
    assert(r.status === 401 || r.status === 200 || r.status === 303, `3080 响应异常：${String(r.status)}`)
    return `pid ${PRE_EXISTING_3080.join('/')} 存活 ∧ HTTP ${String(r.status)}`
  })
} catch (err) {
  failures += 1
  console.error('[fatal] ' + (err instanceof Error ? err.stack ?? err.message : String(err)))
} finally {
  for (const c of started) {
    try {
      if (c.pid != null && process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        c.kill?.()
      }
    } catch {
      // 忽略
    }
  }
  await new Promise((r) => setTimeout(r, 1200))
  if (KEEP) console.log(`[keep] 隔离 home 保留：${HOME}`)
  else {
    // 刚被 taskkill 的进程可能还压着文件句柄（Windows 删除受限），重试三轮仍失败就把路径报给用户手动清。
    const doomed = [HOME, bundleDir]
    for (const dir of doomed) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true })
          break
        } catch (err) {
          await new Promise((r) => setTimeout(r, 1500))
          if (attempt === 2) console.log(`[cleanup] 需手动删除：${dir}（${err instanceof Error ? err.message : String(err)}）`)
        }
      }
    }
  }
}

console.log('\n===== 汇总 =====')
console.log(results.join('\n'))
const total = results.length
console.log(`\n${String(total - failures)}/${String(total)} PASS${failures > 0 ? `，${String(failures)} FAIL` : ''}`)
process.exit(failures > 0 ? 1 : 0)
