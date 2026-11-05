/**
 * 插件 ↔ 本机 DSH 的适配判定（单一事实源：设置页状态横幅、「当前适配状态」行与「DSH版本适配说明」共用）。
 *
 * **v2.8.4：本模块只出判定，不再驱动任何弹窗。**历史上（v2.6.0–v2.8.3）它还会在开机 12 秒后
 * 弹一个模态框提醒"不适配/桥接未生效"，用户明确要求取消——判定结果静默呈现即可，
 * 真有问题的现象（桥接不注入、上传失败）本来就比一句提示更直观。
 *
 * 事实来源（逐条核实，勿凭印象改动）：
 * - **下界 `0.1.5-rc.1`**：0.1.5 系已实测适配（隔离认证矩阵 11/11 + 沙盒 UI 6/6 + 真机），
 *   且 0.1.5 起输入框换成 Lexical 受控编辑器、桥接的写入与注入策略都是按它校准的；
 * - **上界 `0.2.2-rc.1`**：0.2.x 各版均按「触点指纹同批重抓 + 沙盒套件实跑」登记（逐版证据见下方「登记依据」）；0.2.2 把 index
 *   静态兜底改成 Fetch API 资源后，`authorizeIndex` 收到的 `req.url` 由相对变绝对，桥接路径判定曾因此失效（v2.9.5 修复）；
 *   0.1.6-alpha.1 当时「全部插件触点逐项比对一致、沙盒 10/11（唯一失败项是沙盒会话标题期望值，与插件无关）」
 *   的结论仍成立，只是上界已随实测逐版上推；0.2.1 起 `/api` 与 WS 升级直调 `connection.admit()`，
 *   桥接已按同一凭据外包该门（见下方 0.2.1-rc.2 登记依据）；0.2.1-rc.4 与 rc.3 触点零漂移
 *   （见下方 rc.4 登记依据）——该版目前只在 npm `next` 标签上、尚未在官方 GitHub 仓库发布，
 *   故更新门禁不会主动推送它，仅作「已实测」事实登记；
 * - **`0.1.2`–`0.1.4` 已知不兼容**：浏览器会话认证叠加当时的上游会话缓存/列表缺陷
 *   （沿用 `updater.DSH_KNOWN_INCOMPATIBLE`，不另立一张表）；
 * - **`≤0.1.1` 旧版可用**：历史钉住区间——面板能开，但缺 0.1.2+ 的认证适配器与 0.1.5+ 的桥接写入前提。
 *
 * 本模块**只做判定、不出文案**：i18n 措辞留给调用方（settings 的横幅、main 的弹窗），
 * 沙盒脚本与单元测试因此可以断言同一张真值表。
 */
import { classifyDshTarget, compareVersions, parseCoreTriple } from './updater'
import type { SeamScanResult } from './compat-diff'

/** 已实测适配的 DSH 版本下界（含）。 */
export const DSH_ADAPTED_MIN = '0.1.5-rc.1'
/** 已实测适配的 DSH 版本上界（含）——高于它属「插件还没跟上」。 */
export const DSH_ADAPTED_MAX_TESTED = '0.2.2-rc.1'

/**
 * 已实测的具体版本（信息栏文案与判定共用；新增实测版本时在此登记）。
 *
 * **维护规矩（v2.7.0 起由用户明确指示：自己记得更新，不要等提醒）**
 * 每当在真机或沙盒里跑通某个新 DSH 版本，就把它登记到这里，并按需上推
 * `DSH_ADAPTED_MAX_TESTED`；反过来，发现某版本上有真破坏（如 0.1.7 的会话格式 v4
 * 需要 historical child facts）时，先修（见 `session-repair.ts` 的 deferred 分支）再登记。
 * 只登记**跑过**的版本：树级触点比对（`scripts/dsh-compat-diff.mjs`）只能作为辅助证据，
 * 不构成登记理由——例如 `0.1.5-rc.3` 与基线 24 触点全 same，但没实跑过，就不登记。
 * **v2.8.8 追加**：上界每次上推，必须同批重抓 `compat-diff.ts` 的触点指纹基线
 * （`node scripts/dsh-compat-diff.mjs <root> <root> --json` 对新上界全局安装树跑 A 侧），
 * 否则「本机 DSH 高于实测上界」的只读触点自检会拿旧指纹比对——单测与 verify-profile S3.8 会锁死这两处一致。
 *
 * 登记依据（逐条可复现）：
 *  · `0.1.5-rc.1` / `0.1.5-rc.2`：真机（本 Vault 面板）+ 沙盒全链；
 *  · `0.1.6-alpha.1`：隔离沙盒 `scripts/sandbox_ui_test.py` 10/11（唯一失败项与版本无关）；
 *  · `0.1.7-rc.1`：2026-09-23 沙盒三件——`verify-embed` 9 项全过、
 *    `verify-profile --bin <rc.1>` 30 PASS/0 FAIL、`verify-session-repair` 走 deferred 分支 PASS；
 *    另实测上传链无凭据 401 / Bearer 200、桥接页面级注入 `injected`。
 *  · `0.1.7-rc.2`：2026-09-24 沙盒五件——`dsh-compat-diff rc.1→rc.2` 27 触点 GONE=0
 *    （仅 `dsh.client` 与 `setDraft` 两处出现次数增加，符号都在；新增 6 个上游包）；
 *    `verify-embed --bin <rc.2>` 11 项全过；`verify-source-kind-admission --root <rc.2>` 5/5；
 *    `verify-session-repair <home> <rc.2>` 走 deferred 分支 PASS；
 *    `verify-profile --bin <rc.2>` 33/33；`verify-setdraft-e2e --bin <rc.2>` 17/17
 *    （客户端半 `__DSH_BRIDGE_SET_DRAFT__` 真的挂上、写入不抢焦点、取消框选走模型层清除）。
 *  · `0.2.0-rc.1`：2026-09-29 隔离安装（`npm i @deepseek-ai/dsh@0.2.0-rc.1 --prefix %TEMP%\dsh-020rc1`，
 *    全局 CLI 仍是 0.1.7-rc.2、正在跑的 web@3080 未受任何影响）后沙盒六件——
 *    `dsh-compat-diff rc.2→0.2.0-rc.1` 25 触点 **GONE=0 / moved=0 / new=0**（A 981 → B 990 文件，
 *    新增 5 个上游包：product-analytics、settings-session-log、schedule-bundle、
 *    host-product-telemetry-otel、otel；均不触插件接缝）；
 *    `verify-profile --bin <0.2.0-rc.1>` **34/34**（双 profile 共存、认证矩阵、页面级桥接探针、
 *    进程安全五例，S4.7 外证既有 web@3080 未被波及）；`verify-embed <bin> <home> auth`
 *    **11 项全过 failures=0**（ob=1+token→200 且注入 `__DSH_EMBED_TOKEN__`、裸 401、跨 profile token
 *    不通用、fence 403 优先）；`verify-source-kind-admission --root <0.2.0-rc.1>` **5/5**
 *    （会话格式仍是 v4，`plugin:dsh-obsidian-bridge` 被准入、通用 `plugin` 仍硬拒）；
 *    `verify-session-repair <home> <0.2.0-rc.1>` 走**同版本（v4）分支 PASS**
 *    （注入 kind/form/identity 漂移 → broken→fixed→ok 且有备份；223 会话一次性只读预检跑通）；
 *    `verify-setdraft-e2e --bin <0.2.0-rc.1>` **17/17**（回执 `note=setdraft / sd=true / had=false`
 *    ⇒ 官方模型层写入真的生效、不抢焦点、取消框选清干净）；`verify-package-mode` 10/10。
 *    注：`DSH_REPAIR_LIMITED_SINCE` 仍为 `0.1.7`——0.2.0 的会话格式未升版（仍 v4），跨版本
 *    会话依旧由 DSH 打开时自迁、本插件只报告。
 *  · `0.2.0-rc.2`：2026-09-30 隔离安装（官方源＋全新缓存 `npm i @deepseek-ai/dsh@0.2.0-rc.2 --prefix
 *    %TEMP%\dsh-020rc2`；npmmirror 当时缺 `dsh-acp-app@0.2.0-rc.2` 子包会 ETARGET——发布态以官方
 *    registry 的 packument time map 为准：rc.2 实际发布于 2026-09-29T09:56Z），沙盒六件——
 *    `dsh-compat-diff rc.1→rc.2` 27 触点 **GONE=0 / new=0 / moved=1**（`agent.inbox` 31 hits/6 files →
 *    35/8，符号俱在；人工核对：上游把 inbox 用法扩到 goal-round-driver/subagent/user-questions 等
 *    rc.1 已有包的**新文件**，288 包数不变、990→994 文件；行为兼容由下述 source-kind B/D 例与
 *    setDraft e2e 实证）；`verify-profile --bin <rc.2>` **34/34**（含 v2.8.8 新增的触点自检一致性锁 S3.8）；
 *    `verify-embed <bin> <home> auth` **11 项 failures=0**；`verify-source-kind-admission --root <rc.2>` **5/5**
 *    （会话格式仍 v4，`plugin:dsh-obsidian-bridge` 两处准入、通用 `plugin` 两处硬拒）；
 *    `verify-session-repair <真实 home> <rc.2>` 同版本 v4 分支 **PASS**（broken→fixed→ok＋备份；232 会话
 *    只读预检一次跑通，deferred 192 条仍为跨版本不代写）；`verify-setdraft-e2e --bin <rc.2>` **17/17**
 *    （`note=setdraft / sd=true / had=false`，官方模型层写入、不抢焦点、取消框选清干净）；`verify-package-mode` 10/10。
 *  · `0.2.1-rc.2`：2026-10-19 全局安装（官方源 `@deepseek-ai/dsh@0.2.1-rc.2`，全局树 306 包 / 1126 个
 *    js·mjs·cjs 文件）——该版把 `/api` 与 WS 升级改为**直接调 `connection.admit()`**（不再经 requestRejection），
 *    桥接补包 `admit()` 后嵌入认证恢复，沙盒工具链实测——
 *    `verify-embed <bin> <隔离 home> auth` **11 项全 PASS / failures=0**（修前「API Bearer 头 → 200」与
 *    「API query token → 200」均 FAIL(401)，修后转 PASS；ob=1 → 200、浏览器 303+Set-Cookie、未认证 401、
 *    fence 403 两种情形均未回退）；`dsh-compat-diff <安装根> <安装根>` **28 触点 GONE=0**（A=B 自比；
 *    新增 `connection.admit` 实测 **5 hits/1 file**，`requestRejection` 7 hits/5 files 仍在——旧版兼容路径保留；
 *    其余触点按上界同批重抓）；`verify-source-kind-admission --root <全局安装根>` **5/5**
 *    （会话格式仍 v4，`plugin:dsh-obsidian-bridge` 两处准入、通用 `plugin` 两处硬拒）；
 *    `verify-session-repair <真实 home> <0.2.1 全局包>` 同版本（v4）分支 **PASS**（broken→fixed→ok＋备份；
 *    264 会话只读预检一次跑通，deferred 192 条仍为跨版本不代写）；`verify-package-mode` **10/10**。
 *    最终树复验：`verify-profile --bin <0.2.1 全局 bin>` **34/34**（exit 0；S1 8/8、S2 10/10、S3 8/8、S4 8/8，
 *    S3.8 读到 26 项最终树、S4.7 外证既有 web@3080 未被波及）；`verify-setdraft-e2e --bin <同上>` **17/17**
 *    （exit 0；回执 ack ok=true / note=setdraft / sd=true / had=false，真 Chrome headless + CDP + iframe 面板）；
 *    运行期只读触点自检复核：真实全局树 → state=intact、scannedFiles=1126、expected=26、present=26、
 *    gone/moved/extra 全空（约 1.8s，与登记的 1126 文件基线一致）。
 *  · `0.2.1-rc.4`：2026-10-27 **隔离安装**（`npm i @deepseek-ai/dsh@0.2.1-rc.4 --prefix %TEMP%\dsh-021rc4-tree`，
 *    npmmirror 源；树 306 包 / 1128 个 js·mjs·cjs 文件）——该版当时只在 npm `next` 标签上（2026-10-26 发布），
 *    官方 GitHub 仓库尚无 tag/release，故**不参与自动推送**，仅登记「已实测」事实。沙盒六件——
 *    `dsh-compat-diff <rc.3 树> <rc.4 树>` **28 触点 GONE=0 / moved=0 / new=0**（26 same + 2 个实测零触点
 *    absent-both；相对 rc.2 基线唯一计数变化是 `setDraft` 37→40 hits / 8 files，符号与归属未变）；
 *    `verify-embed <bin> <隔离 home> auth` **11 项全 PASS / failures=0**（ob=1+token→200 且注入桥接、
 *    浏览器 303+Set-Cookie、ob≠1 不得直发、未认证 401、Bearer 与 query 双通道 200、fence 403 两种情形原样）；
 *    `verify-profile --bin <rc.4>` **34/34**（S1 8/8、S2 10/10、S3 8/8、S4 8/8，S4.7 外证既有 web@3080 未波及）；
 *    `verify-source-kind-admission --root <隔离安装根>` **5/5**（会话格式仍 v4，桥接 kind 两处准入、通用 `plugin` 两处硬拒）；
 *    `verify-session-repair <真实 home> <rc.4 包>` 同版本（v4）分支 **PASS**（broken→fixed→ok＋备份；
 *    294 会话只读预检一次跑通，102 条 v4 ok、192 条 deferred 仍为跨版本不代写）；
 *    `verify-setdraft-e2e --bin <rc.4>` **17/17**（回执 note=setdraft / sd=true / had=false，官方模型层写入、
 *    不抢焦点、取消框选清干净）；`verify-package-mode` **10/10**。
 *  · `0.2.2-rc.1`：2026-11-05 **全局安装真机（本 Vault 面板）** 升级后出现回归——面板 iframe 401
 *    「dsh web authentication required; reopen the URL printed by dsh web.」。根因：0.2.2 把静态兜底改走
 *    Fetch API（`dsh-host-frontend-static` 的 `serveStatic(request, …)` 把 Fetch `Request` 交给
 *    `connection.authorizeIndex`），`req.url` 从相对变**绝对**（`http://127.0.0.1:3080/?token=…&ob=1`），
 *    桥接旧判据「砍掉 ? 后比较 `/`」恒假 ⇒ ob=1 直发 index 通道失效 ⇒ 退回 303+`SameSite=Strict` cookie，
 *    跨站 iframe（`app://obsidian.md`）不发 cookie ⇒ 401。修复见 `bridge.ts` 的 `authorizeIndex` 包裹
 *    （WHATWG URL 取 pathname，相对/绝对同判，v2.9.5）。沙盒证据——
 *    `verify-embed <bin> <隔离 home> auth` **11 项全 PASS / failures=0**（ob=1+token→200 且注入
 *    `__DSH_EMBED_TOKEN__`、浏览器 303+Set-Cookie、ob≠1 不得直发、未认证 401、Bearer 与 query 双通道 200、
 *    fence 403 两种情形原样；修复前同一套件在 0.2.2 上「面板 ob=1」项应 FAIL 303）；
 *    `dsh-compat-diff <全局安装根> <同一根> --json` 自比 28 触点 **GONE=0 / moved=0**（A=B），相对 rc.4 基线
 *    的计数变化均已登记进 `compat-diff.ts`（authorizeIndex 10→12、pre-step 19→23、inbox 36→49、DSH_HOME 64→71、
 *    dsh.bundle.patch 3→7、PROFILE_TEMPLATES 13→15、dsh.client 97→102、data-phase 12/3→12/4、setDraft 40→44、
 *    dsh-client-modules 5/4→4/3；绝对 URL 本身不新增符号 ⇒ 触点法看不见这次语义漂移，行为由 verify-embed 兜住）；
 *    全局树 **1215 个 js·mjs·cjs 文件 / 330 包**（`COMPAT_BASELINE_FILES` 同批更新）；
 *    `verify-profile --bin <全局 bin>` **34/34 PASS**（S1 8/8、S2 10/10、S3 8/8、S4 8/8——S3.2 双 profile 面板
 *    ob=1+token→200 且注入桥接、S3.5 裸 401/跨 profile token 不通用均在隔离实例上真跑，S4.7 外证既有 web@3080 未波及）。
 *    注：会话源 kind／会话修复／setDraft／包模式四套本轮未在 0.2.2 上复跑，若后续该版出现这类异常先补跑再改判定。
 */
export const DSH_TESTED_VERSIONS: readonly string[] = [
  '0.1.5-rc.1',
  '0.1.5-rc.2',
  '0.1.6-alpha.1',
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.2',
  '0.2.1-rc.4',
  '0.2.2-rc.1',
]
/**
 * 适配等级。
 * - `tested`：命中 `DSH_TESTED_VERSIONS` 的**实测过的具体版本**（真机或沙盒实跑过）；
 * - `within-line`：落在实测区间内但未登记（同一条线，按上界处理，不吓唬用户）；
 * - `untested-newer`：比实测上界更新——插件可能尚未跟上；
 * - `legacy`：≤0.1.1，能开面板但桥接/认证等能力缺前提；
 * - `incompatible`：0.1.2–0.1.4 已知不兼容；
 * - `unknown`：哈希/master/空等不可解析形态（中性，不判定）。
 */
export type DshCompatLevel = 'tested' | 'within-line' | 'untested-newer' | 'legacy' | 'incompatible' | 'unknown'

/** 归一版本串：去空白与可选的 `v` 前缀（git tag 形态是 `dsh-v0.1.5-rc.1`）。 */
function normalizeVersion(version: string): string {
  return (version ?? '').trim().replace(/^v/i, '')
}

/** 版本 → 适配等级。 */
export function judgeDshCompat(version: string): DshCompatLevel {
  const v = normalizeVersion(version)
  if (v === '' || parseCoreTriple(v) === null) return 'unknown'
  if (classifyDshTarget(v) === 'known-incompatible') return 'incompatible'
  if (DSH_TESTED_VERSIONS.includes(v)) return 'tested'
  if (compareVersions(v, DSH_ADAPTED_MIN) < 0) return 'legacy'
  if (compareVersions(v, DSH_ADAPTED_MAX_TESTED) > 0) return 'untested-newer'
  return 'within-line'
}

/** 桥接健康度（两级：文件层装没装、页面层吃没吃到）。 */
export type BridgeHealth = 'live' | 'not-installed' | 'not-live' | 'unknown'

/**
 * 需要留意的**问题种类**（驱动状态横幅与设置页文案，v2.8.4 起不再驱动任何弹窗）。返回 `null` = 一切正常。
 * 优先级即顺序：已知不兼容 > 桥接根本没装 > 装了但页面没吃到（服务没重启/被旧代码覆盖）> 未验证新版 > 旧版。
 * 桥接问题排在前面的理由：它比「版本未验证」更确定地意味着功能已经坏了。
 */
export function compatIssue(level: DshCompatLevel, bridge: BridgeHealth): string | null {
  if (level === 'incompatible') return 'incompatible'
  if (bridge === 'not-installed') return 'bridge-not-installed'
  if (bridge === 'not-live') return 'bridge-not-live'
  if (level === 'untested-newer') return 'untested'
  if (level === 'legacy') return 'legacy'
  return null
}

/**
 * 0.1.7 起「会话格式修复」能力受限（v2.7.0 / A2）：静态 catalog 无法离线校验低于当前格式的会话
 * （V3→V4 迁移边需要 parent 的 historical child facts），故这类会话只能只报告不改写。
 * 不是不兼容，只是能力差异——单独判定，供设置页与「DSH版本适配说明」如实说明。
 * 按**核心三元组**比较：`0.1.7-rc.1` 属于 0.1.7 系，不能因为预发布排序而判成"更早"。
 */
export const DSH_REPAIR_LIMITED_SINCE = '0.1.7'

/** 该版本上会话修复是否对跨版本会话受限（读不出核心版本时返回 false，避免误报）。 */
export function repairCapabilityLimited(version: string | undefined | null): boolean {
  if (!version) return false
  const v = parseCoreTriple(version)
  if (!v) return false
  const [maj, min, pat] = v
  if (maj !== 0) return maj > 0
  if (min !== 1) return min > 1
  return pat >= 7
}

/** 一次适配体检的完整结果（设置页信息栏与启动弹窗共用）。 */
export interface CompatSnapshot {
  /** 本机 DSH 版本串（读不到时为 i18n 的「未知」文案）。 */
  version: string
  level: DshCompatLevel
  bridge: BridgeHealth
  /** 需要提醒的问题种类；null=正常。 */
  issue: string | null
  /**
   * 版本读数是否来自**已核验身份**的官方包（全局官方 manifest 或已核验仓库）。
   * false＝来源是 PATH 上的 `dsh` 之类不可信读数（可能由第三方 dsh 包提供）——此时 level 一律按 unknown 处理，
   * 只展示不判定，避免拿第三方包的版本号去判 DSH 适配。
   */
  verified?: boolean
  /** v2.7.0（A2）：该版本的「会话格式修复」是否对跨版本会话只报告不改写（0.1.7 起为真）。 */
  repairLimited?: boolean
  /**
   * v2.8.8：本机高于实测上界时的**只读触点自检**结果（未触发/无结果时为 null）。
   * 只喂设置页与说明弹窗的文字呈现；适配等级、优先级与弹窗逻辑一概不受它影响——
   * 「触点全在」不等于适配（登记仍须沙盒实跑），「触点消失」也只是提前预警。
   */
  seamScan: SeamScanResult | null
}

/**
 * v2.9.5：回退目标版本（纯函数，内嵌界面不可用页的一键回退与单测共用）。
 *
 * - 当前版本**高于实测上界**（DSH 比插件新，插件还没跟上）→ 实测上界：装回插件已验证的最新版本；
 * - 当前版本**落在已测区间内** → **严格低于当前**的最高已测版本：这是真正的「回退」，而不是重装同版本
 *   （面板不可用也可能是握手/缓存类问题，先退一档再确认要比重装同版本更有信息量）；
 * - 读不出版本（空串）或没有更低的已测版本 → 实测上界。
 * 目标只从 `DSH_TESTED_VERSIONS` / `DSH_ADAPTED_MAX_TESTED` 取，不写死任何版本字面量。
 */
export function fallbackTargetFor(current: string): string {
  const max = DSH_ADAPTED_MAX_TESTED
  const cur = normalizeVersion(current)
  if (cur !== '' && compareVersions(cur, max) > 0) return max
  let best: string | null = null
  for (const v of DSH_TESTED_VERSIONS) {
    if (compareVersions(v, max) > 0) continue
    if (cur !== '' && compareVersions(v, cur) >= 0) continue
    if (best === null || compareVersions(v, best) > 0) best = v
  }
  // 区间内但没有更低的已测版本：返回当前版本本身（＝无需回退，调用方据此只提示重载/重启，不得静默升级）
  if (best !== null) return best
  return cur !== '' ? cur : max
}

/** 信息栏/说明文案用的区间串：`0.1.5-rc.1 ~ 0.1.6-alpha.1`。 */
export function adaptedRangeLabel(): string {
  return `${DSH_ADAPTED_MIN} ~ ${DSH_ADAPTED_MAX_TESTED}`
}
