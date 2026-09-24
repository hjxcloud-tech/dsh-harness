/**
 * 插件更新日志数据（纯数据，无 obsidian 依赖，可在测试环境解析）。
 * 维护时在数组头部追加新版本条目；版本从新到旧排列。**每条一句话说清改了什么即可，实现细节写 README/设计文档，不进日志。**
 */

export interface ChangelogEntry {
  version: string
  /** [中文, English] 更新要点列表。 */
  items: [string, string][]
}

export const PLUGIN_CHANGELOG: ChangelogEntry[] = [
  {
    version: '2.8.3',
    items: [
      [
        '**登记 DSH 0.1.7-rc.1 为实测适配版本**（适配上界随之上推），并写明登记规矩：只登记真跑过的版本，发现真破坏先修再登记',
        '**Registered DSH 0.1.7-rc.1 as tested-supported** (support ceiling raised accordingly), with the rule written down: only versions actually exercised get registered, and real breakage is fixed before registering',
      ],
      [
        '**移除设置页「填充写入方式」下拉**：官方接口可用即自动使用、不可用静默退回 DOM，用户不需要替我们做版本兼容判断',
        '**Removed the "draft write method" dropdown from settings**: the official interface is used when available and silently falls back to the DOM path otherwise, so no compatibility judgement is pushed onto you',
      ],
    ],
  },
  {
    version: '2.8.2',
    items: [
      [
        '**修复面板看不到聊天记录（连接一直在重试）**：2.8.1 重写凭据判据时漏了 WebSocket 这种地址形态，会话主通道因此拿不到凭据、握手被拒后无限重连——面板能打开，但历史与会话数据都出不来；现按「地址归一化后是否本机服务」判定，WebSocket 与 EventSource 一并覆盖',
        '**Fixed the panel showing no chat history (connection stuck retrying)**: the 2.8.1 rule rewrite missed the WebSocket address shape, so the session channel lost its credential, was refused at the handshake and retried forever — the panel opened but neither history nor session data appeared; the rule now normalises the address before judging "is this the local service" and covers WebSocket and EventSource alike',
      ],
    ],
  },
  {
    version: '2.8.1',
    items: [
      [
        '**修复面板内一批请求全部 401**：DSH 0.1.7 改换了请求地址的构造形式，桥接的凭据补挂判据漏掉了这类调用——设置页、账号凭据、模式选择、模型目录、Cordis 面板乃至发消息都拿不到凭据而 401；现按「是否发给本机 DSH 服务」判定，同类调用不会再漏挂',
        '**Fixed a whole class of in-panel requests returning 401**: DSH 0.1.7 changed how request URLs are built, and the bridge\'s credential-attaching rule missed that shape — the settings page, account credentials, mode picker, model catalogue, Cordis panel and even sending a message all went unauthenticated and answered 401; the rule now keys on "is this addressed to the local DSH service", so that class cannot be missed again',
      ],
      [
        '**顺带收紧凭据的发放范围**：只有发给本机 DSH 服务的请求才会带上凭据，发往外部地址的请求一律不带（此前按地址字面量判断，边界不严谨）',
        '**Credential scope tightened along the way**: only requests addressed to the local DSH service carry the credential; requests to external addresses never do (the previous literal-match rule had sloppy boundaries)',
      ],
    ],
  },
  {
    version: '2.8.0',
    items: [
      [
        '**框选文字不再需要先点进聊天框**：填充优先走 DSH 官方的模型层写入（`setDraft`），该写入不要求输入框获得焦点——在笔记里框选，隐式行立刻出现在聊天框，键盘焦点始终留在 Obsidian',
        '**Selecting text no longer needs a click into the chat box first**: fills now prefer DSH\'s official model-layer write (`setDraft`), which does not require the composer to hold focus — select text in the note and the implicit line shows up at once, with the keyboard focus staying in Obsidian',
      ],
      [
        '**该能力默认开启并自动就位**：写入方式为默认值时桥接以裸包名安装（官方装载器认得客户端半的唯一形态）；链接建不出来或官方接口不可达时自动退回原路径模式，行为与旧版一致，不会静默半装',
        '**Enabled by default and self-installing**: with the default write mode the bridge installs as a named package (the only shape whose client half the official loader picks up); if the link cannot be created or the official API is unreachable it falls back to the previous path mode with identical behaviour — never a silent half-install',
      ],
      [
        '**新增写入方式设置项与建置期探针**：设置页可在「官方接口优先 / 仅 DOM 定向替换」之间切换；新增 `npm run verify:package`，在真磁盘上核对包形态的 8 项落地条件（含链接位被占时退回路径的负向用例）',
        '**New write-mode setting and a build-time probe**: the settings page can switch between "official API first" and "DOM targeted replace only"; the new `npm run verify:package` checks the eight on-disk conditions of the package shape, including the negative case where an occupied link falls back to the path mode',
      ],
    ],
  },
  {
    version: '2.7.1',
    items: [
      [
        '**修复 DSH 0.1.7 下桥接注入被硬拒**：会话格式 v4 退役了通用 `kind:\'plugin\'` 源包裹层，改要求 source.kind 是生产者自己的名字；注入的隐式编辑指令改用 `plugin:dsh-obsidian-bridge`，报错 `format v4 message requires a producer-owned source kind` 不再出现',
        '**Fixed bridge injections being hard-rejected on DSH 0.1.7**: session format v4 retired the generic `kind:\'plugin\'` source wrapper and now requires source.kind to be the producer\'s own name; injected edit instructions use `plugin:dsh-obsidian-bridge`, so the `format v4 message requires a producer-owned source kind` error is gone',
      ],
      [
        '**顺带修复注入窗口去重**：v4 迁移会删掉旧消息的 `plugin` 字段，而原去重只认它；现同时认新 kind 与迁移前的旧形态，跨迁移边界不会重复注入',
        '**Fixed injection window dedup along the way**: the v4 migration drops the legacy `plugin` field that dedup relied on; it now recognises both the new kind and the pre-migration shape, so injections are not duplicated across the migration boundary',
      ],
      [
        '**新增建置期探针 `npm run verify:source-kind`**：把插件实际发出的 source 形态喂给本机已装 DSH 的会话准入函数，新形态被拒或旧形态没被拒都直接报错退出',
        '**New build-time probe `npm run verify:source-kind`**: feeds the source shapes the plugin actually emits into the installed DSH session admission, failing loudly if the new shape is rejected or the legacy one is not',
      ],
    ],
  },
  {
    version: '2.7.0',
    items: [
      [
        '**适配 DSH 0.1.7 的会话格式 v4**：跨版本旧会话改为「只报告不改写」，并说明由 DSH 打开时自行迁移（旧版上该按钮会永远修不动）',
        '**Adapted to DSH 0.1.7 session format v4**: older cross-version sessions are now report-only (never rewritten), with an explicit note that DSH migrates them on open — previously the repair could never converge',
      ],
      [
        '**适配自检新增能力差异提示**：0.1.7+ 会明确告知「会话修复能力受限」，不再只说"新于实测范围"',
        '**Compatibility check now reports capability differences**: on 0.1.7+ it states that session repair is limited, instead of only "newer than tested range"',
      ],
      [
        '**桥接支持裸包名安装（实验，默认关闭）**：补齐客户端半装载所需的包形态（exports/dsh.client + node_modules 链接），链接建不出来时自动退回原路径模式',
        '**Bridge can install as a named package (experimental, off by default)**: ships the packaging a DSH client half needs (exports/dsh.client plus a node_modules link), and falls back to the current path entry automatically',
      ],
    ],
  },
  {
    version: '2.6.1',
    items: [
      [
        '**修复面板内上传附件仍然失败**：上一版补丁的命中条件读 `worker.name`，而 Chromium 里它读回 `null`（具名只用于 DevTools 标签）⇒ 补丁从未执行。现改为在**构造期**捕获 Worker 名并注入 Bearer 凭据，另加「消息形态本身就是上传请求」作第二道条件；百分比进度保留',
        '**Fixed in-panel attachment uploads still failing**: the previous patch matched on `worker.name`, which Chromium reports as `null` (the name only labels the worker in DevTools), so the patch never ran. The name is now captured at construction time and a Bearer credential is injected, with a second "this message is an upload" condition as backup; percentage progress kept',
      ],
      [
        '**新增上传链路沙盒回归**：`npm run verify:upload`（起隔离实例，在真实浏览器里核对补丁在位、凭据已注入、其他 Worker 不被改动）',
        '**New sandbox regression for the upload path**: `npm run verify:upload` boots an isolated instance and checks in a real browser that the patch is in place, credentials get injected, and other workers are untouched',
      ],
    ],
  },
  {
    version: '2.6.0',
    items: [
      [
        '新增 **DSH Profile 设置项**：面板可绑定独立 profile（自动代建、桥接装入该档、改用 `dsh --profile` 形态、独立端口），与桌面版等实例共存；会话存储本机共享',
        'New **DSH profile setting**: the panel can bind its own profile (auto-created, bridge installed into it, launched as `dsh --profile` on its own port) and coexist with other instances; session storage is shared machine-wide',
      ],
      [
        '**修复面板内拖拽/按钮上传附件失败（401）**；系统浏览器行为不变',
        '**Fixed in-panel attachment uploads failing with 401**; system browser behaviour unchanged',
      ],
      [
        '**端口与进程安全**：「重启服务」只终止插件自己拉起的实例，外部 DSH 占用只提示不抢；老用户首次点重启会弹确认框',
        '**Port and process safety**: restarting only stops instances the plugin launched; a foreign DSH holding the port is reported, never killed; existing users get a confirmation dialog on the first restart',
      ],
      [
        '**只认官方 DSH 包**：本机版本只从官方包清单读取，第三方同名社区包（`@x1a0f3n9/dsh-*`，与官方共用 0.1.5-rc.x 号段）不再被当成本体；「升级前结束全部 DSH」的进程范围也按官方身份收窄',
        '**Only the official DSH package counts**: the local version comes from the official package manifest, so third-party same-named packages (`@x1a0f3n9/dsh-*`, which share the official 0.1.5-rc.x number space) are no longer mistaken for it; the pre-upgrade "stop all DSH" scope is narrowed to official identities too',
      ],
      [
        '**启动时适配自检**：核对本机 DSH 版本是否落在实测区间 `0.1.5-rc.1 ~ 0.1.6-alpha.1`、桥接是否真的在页面生效；异常弹窗并给处置按钮，同种问题 24 小时内只提醒一次',
        '**Startup compatibility check**: verifies the local DSH version against the verified range `0.1.5-rc.1 ~ 0.1.6-alpha.1` and whether the bridge is live in the served page; issues open a dialog with fix actions, at most once a day',
      ],
      [
        '**重开自动更新并新增更新通道**：仅正式版 / 跟随主推（默认，含 rc、beta）/ 含 alpha；启动后按通道检查（默认 24 小时一次），只弹确认框绝不静默安装',
        '**Auto-updates restored, with an update channel**: stable only / follow the pushed version (default; rc & beta) / include alpha; checked after startup (24h by default) and always asking before installing',
      ],
      [
        '**Profile 改为下拉选择 + 新建 + 切换确认**，并拦下 DSH 内置档名（`acp` / `headless` / `sdk` / `sdk-minimal`）',
        '**Profile is now picked from a dropdown** with create-and-switch confirmation; built-in DSH names (`acp` / `headless` / `sdk` / `sdk-minimal`) are rejected',
      ],
      [
        '**设置页重排**：高级区分四组（服务运行 / DSH Profile / 更新与安装源 / 适配自检）；「插件信息」新增「DSH版本适配说明」弹窗',
        '**Settings regrouped**: the advanced area splits into Service runtime / DSH profile / Updates & install sources / Compatibility, and the plugin info row links to a DSH compatibility explanation',
      ],
    ],
  },
  {
    version: '2.5.3',
    items: [
      [
        '注入隐式行改为**只改那一小段**（不再清空重写整个聊天框）：① 框里已有隐式行 → 只把该行原地替换成新行（1 次写入，**不再出现"输入框瞬间为空"的闪烁**）；② 取消框选 → 只删该行；③ 首次注入 → 光标移到最前插入新行再补一个段落分隔，你已输入的文字始终留在下面不动。硬判据是「隐式行条数正确 **且** 行以外的内容与注入前逐字一致」——你的文字全程不经插件之手，一旦这个不变量被破坏（写入期间你又输入了字、行被复制成两条、编辑器做了别的事）就整体退回旧路径，绝不静默留下错乱内容。另修**焦点被抢**（三项叠加）：①**焦点不在聊天框时一律不写**——写入本身要求输入框获得焦点，因此焦点在笔记侧时插件只记下待写入内容，等你点进聊天框（焦点进入输入框）那一刻再补上，从结构上不再抢焦点；②在"你正在笔记里打字"（距最近一次按键 300ms 内）时不触发自动填充；③页面侧在焦点本来就在 Obsidian 时主动把窗口焦点交还父页，写入窗口也从约 600ms 缩短到约 90ms',
        "The implicit line is now written **in place** instead of clearing and rewriting the whole chat box: (1) when the line is already there, only that line is replaced (a single write, so the composer no longer flashes empty); (2) cancelling a selection removes only that line; (3) on first injection the caret goes to the very top, the line is inserted and a paragraph break is added, so whatever you had typed stays below untouched. The hard acceptance check is \"exactly one implicit line **and** everything except that line byte-identical to before\" — your text never passes through the plugin, and if that invariant breaks (you typed during the write, the line got duplicated, the editor did something else) the whole thing falls back to the old path rather than silently leaving a mess. Also fixes **focus stealing** (three layers): (1) **nothing is written while the chat box is not focused** — writing inherently requires the composer to take focus, so while focus is in your note the plugin only remembers the line and inserts it the moment you click into the chat box, which removes focus stealing structurally; (2) no auto-fill while you are typing in a note (within 300 ms of your last keystroke); (3) the page hands window focus back to the host when focus was in Obsidian, and the write window shrank from roughly 600 ms to about 90 ms",
      ],
    ],
  },
  {
    version: '2.5.2',
    items: [
      [
        '修复长会话下「注入隐式行后，一在聊天框打字就持续闪烁；用快捷键输入偶发多次复制」：① **幂等短路**——填充前先比对目标文本与输入框当前内容，一致就一个字都不改（长会话下父页选区事件会高频重发同一份草稿，旧版每次都执行"全选→删除→重写"，闪烁与重复都来自这里）；② **焦点在面板内时不再自动注入**——焦点进入 iframe 会让父文档选区被清空并触发选区事件，旧版据此反复下发"清除/重填"草稿；③ **ACK 不再无条件抢焦点**——填充前焦点若已在 DSH 输入框内，插件不再把焦点夺回 Obsidian 编辑器（旧版会让打字落点错乱）；④ 相同草稿不重复下发，并新增**填充遥测**：每 3 秒把 `total/same/wrote/composerFocus` 汇总一行写入 `dsh-panel-diag.log`，便于定位这类只在长会话出现的时序问题',
        'Fixes "after injecting the implicit line, the chat box flickers continuously while typing, and shortcut input sometimes duplicates text" in long sessions: (1) **idempotent short-circuit** — the target text is compared with the composer content before filling, and nothing is written when they already match (in long sessions the host document re-sends the same draft at high frequency, and the old version ran a full "select all → delete → rewrite" every time, which is exactly where the flicker and duplication came from); (2) **no auto-injection while the panel has focus** — focusing the iframe clears the parent document selection and fires selection events, which the old version turned into repeated clear/refill drafts; (3) **the ACK no longer steals focus unconditionally** — if the DSH composer already had focus before the fill, the plugin no longer yanks focus back to the Obsidian editor (which used to misroute keystrokes); (4) identical drafts are no longer re-sent, and **fill telemetry** was added: every 3 seconds one line with `total/same/wrote/composerFocus` goes into `dsh-panel-diag.log` so timing problems that only appear in long sessions can be pinpointed',
      ],
    ],
  },
  {
    version: '2.5.1',
    items: [
      [
        '修复 v2.5.0 引入的回归「重新框选或取消框选，隐式行不自动变更」：v2.5.0 用**事件计数**判断"用户是否中途改了输入框"（数 `keydown`/`beforeinput`/`paste`/`drop`），但受控编辑器（Lexical）在获取焦点、选区变化、以及它自己处理写入回响时也会派发同类事件，被当成"用户输入" → 填充在写入前就整体放弃 → 输入框里的隐式行停在上一次的内容不再更新。现改为**按内容比对**判定：只有出现「既不属于本次目标文本、也不是本次写入前原内容」的文本才算用户插了进来（共享源串 `INTRUDED_SOURCE`，行为级测试覆盖分阶段中间态、清空失败、用户新输入、取消框选四类场景）；同时恢复"整串替换"收尾兜底——清空失败或插入被拒时再整串写一次（旧版此处直接放弃，也会表现为"不更新"），该兜底受内容比对守卫保护，不会像早期版本那样回写旧快照',
        'Fixes a v2.5.0 regression: "re-selecting or cancelling a selection no longer updates the implicit line". v2.5.0 detected "did the user edit the composer meanwhile?" by **counting events** (`keydown`/`beforeinput`/`paste`/`drop`), but a controlled editor (Lexical) also dispatches such events when it receives focus, when the selection changes and while it processes the echo of a programmatic write — those were misread as user input, so the fill aborted before writing and the implicit line stayed at its previous content. The check is now **content-based**: only text that is neither part of the intended target string nor the composer\'s content before this write counts as the user having typed (shared source string `INTRUDED_SOURCE`, with behavioural tests covering staged intermediate states, a failed clear, fresh user input and cancel-selection). The final whole-string replace fallback is restored as well — when the clear fails or the insert is rejected it writes the merged text once more (the old version simply gave up, which also showed up as "not updating"); that fallback is protected by the content check, so it can no longer write back a stale snapshot the way earlier versions did',
      ],
    ],
  },
  {
    version: '2.5.0',
    items: [
      [
        '对话里的 `[[wikilink]]` 现在可直接点击打开：消息渲染时把 `[[笔记名]]` / `[[路径/笔记名|别名]]` 注解成 Obsidian 内链样式（自动跳过代码块、行内代码与输入框），点击后在 Obsidian 中打开对应笔记；解析交给 Obsidian 自己完成（支持省略 `.md` 与 `#标题` 锚点），找不到时明确提示「未找到笔记」。顺带修复：消息里的路径点击旧逻辑是"先拦截再判断"，遇到 `[[路径|别名]]` 这类文本会把点击吞掉（现在解析成功才拦截）。另新增**每会话一次**的「双链约定」指令，引导模型引用库内笔记时使用 `[[wikilink]]` 而非裸路径',
        'Conversation `[[wikilinks]]` are now clickable: message rendering annotates `[[note]]` / `[[path/note|alias]]` with Obsidian internal-link styling (skipping code blocks, inline code and the composer), and clicking opens the note in Obsidian. Resolution is delegated to Obsidian itself (supports omitted `.md` and `#heading` anchors), and a missing target now reports "note not found". Also fixed: the path-click handler used to intercept before resolving, swallowing clicks on text like `[[path|alias]]` (it now only intercepts when resolution succeeds). A once-per-session "wikilink convention" instruction also nudges the model to reference vault notes with `[[wikilinks]]` instead of bare paths',
      ],
      [
        '修复「框选后按 Backspace / Ctrl+Z 等编辑键，隐式桥接出问题」（快捷键不生效、隐式行被复制多次、DSH 输入框出现怪文字）：① 桥接填充只在与 DSH 输入框的写入瞬间持有焦点，写完立即把焦点还给注入前的元素（旧版从注入到结束约 200–600ms 一直占着焦点，编辑键全打到 DSH 而非 Obsidian）；② 新增**代际守卫**——填充期间用户在输入框里按键、粘贴或输入（`keydown`/`beforeinput`/`paste`/`drop`，自身写入不计数），本次填充整体放弃，不再回写陈旧内容；③ 删除用 `textContent` 整串覆盖输入框的兜底（它会写入注入开始时的旧快照，正是「怪文字」来源），最后兜底仅在输入框确实为空且用户未动过时才执行；④ 编辑键（`Ctrl+Z/Y/A/C/X/V`、Backspace、Delete、Enter、Tab、Esc、方向键、Home/End/PageUp/PageDown）不再被快捷键透传 `preventDefault` 后转发给 Obsidian——它们留在 DSH 内部，DSH 自己的撤销/选择/删除恢复可用（`Ctrl+O/P/,` 等 Obsidian 全局快捷键仍照常透传），并对「请求快捷键配置」消息加 5 秒节流',
        'Fixed "editing keys (Backspace, Ctrl+Z, ...) misbehave after a box selection" (shortcuts not taking effect, the implicit bridge line duplicated several times, stray text appearing in the DSH composer): (1) the bridge now holds focus on the DSH composer only for the instant of each write and immediately hands focus back to the previously focused element — the old version held focus for the whole 200-600 ms fill, so every editing key landed in DSH instead of Obsidian; (2) a new **generation guard** aborts the whole fill if the user types, pastes or otherwise inputs into the composer meanwhile (`keydown`/`beforeinput`/`paste`/`drop`, with the bridge\'s own writes excluded), so stale content is never written back; (3) the `textContent` whole-string overwrite fallback was removed — it wrote the snapshot taken at fill start, the very source of the "stray text"; the last-resort write now runs only when the composer is verifiably empty and untouched; (4) editing keys (`Ctrl+Z/Y/A/C/X/V`, Backspace, Delete, Enter, Tab, Esc, arrows, Home/End/PageUp/PageDown) are no longer `preventDefault`-ed and forwarded to Obsidian by the shortcut passthrough — they stay inside DSH so its own undo/selection/deletion works again (Obsidian global hotkeys such as `Ctrl+O/P/,` still pass through), and the "request shortcut config" message is throttled to 5 s',
      ],
    ],
  },
  {
    version: '2.4.4',
    items: [
      [
        '修复「多次框选笔记注入 → DSH 崩溃」：桥接原先在**每一步** pre-step 都往会话追加一条注入消息，去重只扫当前消息窗口——上下文一旦压缩（真机实测 `compaction/prune` 48 次）把那条消息裁出窗口，就会每步再注入一条，形成自增强循环（真机后果：单会话 11.8MB、`user/message` 564 条、面板 DOM 279 万字 → DSH 崩溃）。现改为 DSH 原生**一次性投递**（`agent.inbox.prepend(\'next-step\')`，消费即消失，不再落成每步一条持久消息）+ **三层去重**（inbox 待投递签名比对 / `agent.session.surface` 比对 / 本地台账 `inject-ledger.json`：同一选区 10 分钟内只注入一次，**不依赖会话窗口**，压缩裁剪也击不穿）+ **单会话 20 次熔断**（超限停止注入、留 `storm` 标记并在插件加载时提示一次；`inject-log.jsonl` 记录每次判定便于自证）',
        'Fixed "DSH crashes after injecting many box selections": the bridge used to append a fresh injected message on **every** pre-step, de-duplicating only against the current message window — once context compaction (48 `compaction/prune` events on the real machine) dropped that message out of the window, it injected again on every step, a self-reinforcing loop (a single session grew to 11.8MB / 564 user messages / a 2.79M-character panel DOM → DSH crashed). It now uses DSH\'s native **one-shot delivery** (`agent.inbox.prepend(\'next-step\')`, consumed and gone, no per-step persisted message) plus **three-layer de-duplication** (pending inbox signature / `agent.session.surface` / a local ledger `inject-ledger.json` that injects a given selection only once per 10 minutes, **independent of the message window**, so compaction cannot defeat it) and a **20-per-session circuit breaker** (stops injecting, records a `storm` flag surfaced once at plugin load, and logs every decision to `inject-log.jsonl`)',
      ],
    ],
  },
  {
    version: '2.4.3',
    items: [
      [
        '桥接填充恢复为 2.4.0 的实现（全局剔除旧隐式行 + 先清空再写入 + 有正文时用原生段落造真换行 + 免闪蓝），并**移除插件侧的失败重试**（它会把重复放大成"多轮重复显示"）；白屏修复改为**自动化手动刷新**（首次打开 4s 内桥接未就绪则自动整视图重渲染一次，最多 2 次）。另修「设置里重启服务后 DSH 白屏、刷新报错、要再重启一次才正常」：根因是 `taskkill` 返回 ≠ 进程已退出，紧随其后的在线探测把"正在死去的旧进程"误判为已就绪、于是不拉起新服务；现在结束后会**轮询等待进程真正退出**并**等待端口真正释放**再启动',
        'Bridge filling is back to the 2.4.0 implementation (global removal of old implicit lines + clear-then-write + a native paragraph break when user text exists + no selection flash), with the **plugin-side retry removed** (it amplified duplication into repeated lines). The blank-panel fix now **automates the manual refresh** (one full view re-render if the bridge is not ready within 4s of first open, at most twice). Also fixed "restarting the service in settings leaves the panel blank, a refresh errors, and only a second restart works": `taskkill` returning does not mean the process has exited, so the readiness probe saw the dying process as healthy and never started a new one; shutdown now **polls until the processes really exit** and **waits for the port to be released** before starting',
      ],
    ],
  },
  {
    version: '2.4.2',
    items: [
      [
        '修复商店审核报错 obsidianmd/no-static-styles-assignment：iframe 重绘轻推改为切换 CSS 类（不再直接写内联样式），并把该规则加入本地发布门禁防复发',
        'Fixed the store review error obsidianmd/no-static-styles-assignment: the iframe repaint nudge now toggles a CSS class instead of writing inline styles, and the rule is now enforced by the local release gate',
      ],
    ],
  },
  {
    version: '2.4.1',
    items: [
      [
        '修复「首次打开面板、DSH 加载完成后白屏，需手动刷新一次才显示」：视图刚打开时容器常常还是 0 尺寸/未布局，文档虽加载完成也不会绘制；现改为容器尺寸就绪后自动重载一次，并在 iframe 加载完成、由隐藏转可见时做一次像素级重绘轻推（不打断已就绪的面板）',
        'Fixed the blank panel on first open (DSH finished loading but nothing painted until a manual refresh): the container is often still zero-sized when the view opens, so the loaded document never paints. The frame now reloads once the container has real size, and a pixel-level repaint nudge runs after load and when the view becomes visible again (without disturbing an already-ready panel)',
      ],
    ],
  },
  {
    version: '2.4.0',
    items: [
      [
        '适配 DSH 0.1.5 系并放开版本钉住：一键配置/卸载重装安装官方最新版（0.1.5 已实测适配），仅 0.1.2–0.1.4 保留红字劝退；已装 CLI 落在不兼容区间时自动升级',
        'DSH 0.1.5 support and unpinned installs: one-click configure and clean reinstall now install the official latest (0.1.5 verified); only 0.1.2–0.1.4 keep the red warning, and an installed CLI in that range is upgraded automatically',
      ],
      [
        '修复新版 DSH 每次请求报「DeepSeek request extension preparation failed」：桥接改为独立插件包（自带 package.json 与版本号），不再被当成 profile 的松散模块',
        'Fixed the per-request "DeepSeek request extension preparation failed" error on newer DSH: the bridge now ships as its own plugin package (own package.json/version) instead of a loose module owned by the profile manifest',
      ],
      [
        '修复升级新版后历史会话不可见：桥接编辑指令改用 DSH 规范消息形态（source.form=notice + summary），旧布局自动迁移并保留 .bak-local',
        'Fixed missing chat history after upgrading DSH: bridge edit instructions now use DSH\'s canonical message shape (source.form=notice + summary); the old bridge layout is migrated automatically with a .bak-local backup',
      ],
      [
        '更新流程加固：更新/重装前结束所有 DSH 进程（含其它实例，弹窗红字预告）；升级前自动备份会话目录（失败即中止）；升级后只读预检并在发现不可读会话时直接打开修复入口；升级后按新认证凭证自动重载面板（修复「dsh web authentication required」）',
        'Hardened upgrade flow: all DSH processes are terminated before updating/reinstalling (disclosed in the modal), sessions are backed up first (aborting on failure), a read-only post-upgrade check opens the repair entry point when unreadable sessions are found, and the panel reloads with the new auth credential (fixes "dsh web authentication required")',
      ],
      [
        '新增「会话格式修复」（设置页/升级后预检入口）：修复 DSH 版本漂移导致的旧会话不可读（sourceEventSeqs 形态、插件写入的非法 source.form、子会话 descriptor 版本、注入消息缺 id/role 导致「lacks an identified message」崩溃）；先备份原文件、改完用 DSH 自带迁移链复验、通过才落盘，全程只读预检 + 显式点击才改写',
        'New "Session format repair" (settings page / post-upgrade entry): fixes old sessions made unreadable by DSH version drift (sourceEventSeqs shape, invalid plugin-written source.form, subagent descriptor version, injected messages missing id/role that crash with "lacks an identified message"). Each file is backed up first, validated with DSH\'s own migration chain, and only then written — scanning is read-only and nothing is rewritten without an explicit click',
      ],
      [
        '修复 0.1.5 下两类残留问题：① 面板内文件上传进度与侧栏文档预览走 XMLHttpRequest，旧版只给 fetch/WebSocket 补凭证 → 这些请求 401 并触发「authentication required」；现补齐 XHR/EventSource，并让启动凭证每次重读、token 一变立即重载面板（重载预算 2→5 轮）② DSH 输入框已有文字时隐式行不出现——受控编辑器回滚了填充，而旧逻辑只看 execCommand 返回值、自动注入又不看回执；现改为「校验 + 多策略降级」填充，回执带结果，自动注入失败会重试一次并提示',
        'Fixed two residual issues on DSH 0.1.5: (1) in-panel file-upload progress and sidebar document preview use XMLHttpRequest while only fetch/WebSocket carried credentials, so those requests 401ed and surfaced "authentication required" — XHR/EventSource are now patched too, the launch credential is re-read on every use, and the panel reloads the moment the token changes (reload budget 2 → 5 rounds); (2) the implicit line stopped appearing when the DSH composer already had text — the controlled editor rolled the fill back while the old logic trusted execCommand\'s return value and auto-inject ignored the ack — filling is now verified with a multi-strategy fallback, the ack reports the result, and auto-inject retries once before warning',
      ],
    ],
  },
  {
    version: '2.3.3',
    items: [
      [
        '更新检查恢复适配警告：新版 DSH（0.1.2 起）因浏览器会话认证与插件不适配（内嵌面板聊天记录无法显示、输入框不可用），已上报 DSH 官方团队，待适配后插件将同步更新；「一键配置」与「卸载并重装」均固定安装已验证适配版（0.1.1-rc.2）',
        'Update check warns again that new DSH (0.1.2+) is incompatible due to browser-session authentication (the embedded panel cannot show chat history and the composer is unusable); the issue has been reported to the DSH team and the plugin will follow once supported. One-click configure and clean reinstall both install the verified compatible DSH (0.1.1-rc.2)',
      ],
      [
        '更新日志支持删除线标记（本弹窗中 v2.3.1 的"新版兼容"说明已按实测结果作废划除）',
        'Changelog entries can now be struck through (v2.3.1\'s "new DSH compatibility" note is voided here based on real-world testing)',
      ],
    ],
  },
  {
    version: '2.3.1',
    items: [
      [
        '~~DSH 0.1.2/0.1.3 兼容：框选发送改走 API 直发通道（端点形态自适应 + 自动会话认证），不再依赖面板内嵌；输入框支持 contentEditable；冷启动自动重载；面板被认证拦截时显示引导卡，可一键在浏览器打开（自动携带认证链接）~~（实测新版 DSH 仍与插件不适配：内嵌面板聊天记录与输入异常，该说明作废，详见 v2.3.3）',
        '~~DSH 0.1.2/0.1.3 compatibility: sending selections now uses the direct API channel (endpoint-style autodetection + automatic session auth) independent of the embedded panel; contentEditable composer support; cold-start auto-reload; when the panel is blocked by browser-session auth a guidance card offers one-click "Open DSH in browser" with the auth link~~ (voided: real-world testing shows new DSH versions remain incompatible with the plugin — embedded panel chat history and composer are broken; see v2.3.3)',
      ],
      [
        '本地手改的桥接文件在插件覆盖前自动备份（.bak-local）',
        'Locally modified bridge files are now backed up (.bak-local) before the plugin overwrites them',
      ],
    ],
  },
  {
    version: '2.3.0',
    items: [
      [
        'DSH 0.1.2 浏览器会话认证缓解：一键配置钉住适配版 0.1.1-rc.2；更新检查对未适配版本红字劝退（取消自动检查）；认证类启动失败弹窗如实说明，「在浏览器打开 DSH」自动携带认证链接（浏览器中完整可用，插件辅助功能不生效）',
        'Mitigations for DSH 0.1.2 browser-session auth: one-click configure pins the verified version 0.1.1-rc.2; update check shows a red incompatibility warning (auto-check removed); auth-class boot failures get an honest modal, and "Open DSH in browser" now carries the authentication link (full DSH in the browser; plugin helpers do not apply there)',
      ],
    ],
  },
  {
    version: '2.2.2',
    items: [
      [
        '商店审核告警清理第二轮：复制兜底改用 Electron 剪贴板（弃用 API）、定时器/类型合规重写（无功能变化）',
        'Second round of store-review cleanup: clipboard fallback switched to the Electron API (deprecated API removed); timers and types rewritten for compliance (no behavior change)',
      ],
    ],
  },
  {
    version: '2.2.1',
    items: [
      [
        '清理商店审核告警：定时器/类型/样式/设置页元素创建等 24 项合规性修复（无功能变化）',
        'Cleaned up store review warnings: 24 compliance fixes for timers, types, styles and settings elements (no behavior change)',
      ],
    ],
  },
  {
    version: '2.2.0',
    items: [
      [
        'AED 增强：进入安全模式前自动检查插件健康，异常插件临时禁用（退出时自动恢复），坏插件不再让安全模式打不开；完成后校验启动，异常可一键修复',
        'AED enhanced: checks plugin health before entering safe mode; broken plugins are temporarily disabled (auto-restored on exit), so safe mode boots even with broken plugins; verifies boot afterwards and offers one-click fixes',
      ],
      [
        '新增「卸载并重装 DSH（保留聊天记录）」：红色按钮 + 强确认；自动备份聊天记录/凭据/设置/技能后卸载重装',
        'New "Uninstall & reinstall DSH (keep chat history)": red button + strong confirmation; backs up chat/credentials/settings/skills before uninstalling and reinstalling',
      ],
    ],
  },
  {
    version: '2.1.1',
    items: [
      [
        '一键配置 DSH 默认改用全局 CLI 稳定版启动（dsh web --port {port} --no-open）：不再默认运行仓库 master 上的预发布（alpha.3 新增浏览器会话认证，隐藏控制台下无法取得 token URL 会 401）；仅当全局 CLI 安装失败时才回退仓库形态',
        'One-click configure now defaults to the stable global CLI (dsh web --port {port} --no-open) instead of the repo master (a prerelease): alpha.3 added browser-session authentication whose printed token URL is unreachable under the hidden console, causing a 401; the repo form is only used as a fallback when the global CLI install fails',
      ],
    ],
  },
  {
    version: '2.1.0',
    items: [
      [
        'AED 增强：抢救/退出安全模式完成后自动校验 DSH 启动健康（页面启动引导注入 + 客户端模块 bootstrap face）；发现异常弹窗说明错误类型、判断与建议动作，可执行一次性修复（重建桥接补丁 + 清理残留禁用块 + 重启复验）；同类错误不循环弹窗，提示改用其他 harness（dsh-fix doctor/bisect 或重装）；安全模式不再误禁客户端模块（client-modules 纳入核心 bundle，修复 AED 后报「client.js did not export the bootstrap module face」的根因之一）',
        'AED enhancement: after recovery/exit-safe-mode completes, the plugin verifies DSH boot health (page boot injection + client-modules bootstrap face); on failure a modal shows the error type, assessment and a suggested action with a one-shot fix (rewrite bridge patch + remove stale disable blocks + restart & re-verify); no repeated modals for the same error — other harnesses are suggested instead (dsh-fix doctor/bisect or reinstall); safe mode no longer disables the client-modules bundle (moved into the core set, fixing a root cause of "client.js did not export the bootstrap module face" after AED)',
      ],
      [
        '设置页全部行控件（按钮/输入框/下拉框）强制上下居中；AED 说明更新为简介校验功能',
        'All Settings controls (buttons / inputs / dropdowns) are force-vertically-centered; the AED description now introduces the verification feature',
      ],
    ],
  },
  {
    version: '2.0.3',
    items: [
      ['桥接自愈：检测并清除 dsh-fix 安全模式残留的「禁用 dsh-obsidian-bridge」覆盖块（历史复发导致桥接静默失效、面板无法回填文字），补丁写入改原子化；恢复桥接后提示重载生效；设置页「安全模式启动」栏移除，「退出安全模式」并入「AED for DSH」栏；AED 抢救总是安装/升级 dsh-fix 到最新（幂等）', 'Bridge self-healing: detects and removes leftover dsh-fix safe-mode "disable dsh-obsidian-bridge" override blocks (a recurring silent failure), patch writes are now atomic; prompts to reload after restoring; the "Start in safe mode" row is removed and "Exit safe mode" moved into the "AED for DSH" row; AED always installs/upgrades dsh-fix to the latest (idempotent)'],
    ],
  },
  {
    version: '2.0.2',
    items: [
      ['P0 安全与稳定性修复回归：①端口操作安全——重启/更新/AED 前校验 DSH 身份（不再误杀同名端口前缀的无关进程）；②修复路径点击重定向标签跳过失效（退格字节 bug，含控制字符回归测试）；③pre-step 编辑指令带自终止句（避免会话累积重复执行）；④--no-open 探测改异步（不再冻结界面 8-20s），探测失败按「支持」处理（不再漏补导致弹浏览器）；⑤一键安装 PATH 缓存刷新（安装后不再误报依赖仍缺失）；⑥全局 CLI 更新失败自动恢复原服务；⑦设置页输入防抖（端口/命令/滑杆不再逐键重建服务）；⑧CI 增加 typecheck、check-review-lint 改真配对扫描；⑨更新失败提示细化——git 更新遇本地未提交改动时列出冲突文件并指引提交/stash', 'P0 safety & stability fixes restored: ① port-kill safety — DSH identity is verified before restart/update/AED (no longer kills unrelated prefix-matching port owners); ② fixed the label-skip regex backspace-byte bug (with control-character regression test); ③ pre-step edit instructions self-terminate (no repeated execution across turns); ④ --no-open probe is async (no more 8-20s UI freeze) and probe failure is treated as supported (no browser popup from a missing flag); ⑤ installer PATH cache refreshes after install (no more false "dependency still missing"); ⑥ failed global-CLI updates restore the previous service; ⑦ Settings inputs are debounced (no per-keystroke service rebuilds); ⑧ CI gains typecheck and a real eslint-disable pairing scan; ⑨ update-failure messaging lists conflicting files and guides commit/stash'],
    ],
  },
  {
    version: '2.0.1',
    items: [
      ['基于 1.9.9 稳定行为发布（回退 2.0.0 的全面改动，恢复稳定运行）：保留更新检查优化（alpha/beta 预发布识别、npm 通道「已是最新」说明与 GitHub 预览披露）、下拉垂直居中、重启栏位调整；移除 2.0.0 引入的不稳定改动', 'Released on the stable 1.9.9 behavior (2.0.0-wide changes rolled back for stability): keeps the update-check polish (alpha/beta treated as prereleases, npm-only "up to date" notice with GitHub prerelease disclosure), centered dropdown and reordered restart row; removes the unstable 2.0.0 changes'],
    ],
  },
  {
    version: '1.9.9',
    items: [
      ['更新检查优化：①版本判定修正——alpha/beta 识别为预发布（不再误当正式版提示）；②「已是最新」提示明确检测范围仅 npm 官方推送的全局 CLI 版本，若 GitHub 另有未发布到 npm 的预览（如 0.1.2-alpha.1）会一并告知，避免误以为漏检；③设置页「DSH 聊天框桥接到 Obsidian」下拉框垂直居中；④快捷操作区「重启 DSH 服务」移到「重连服务」下方', 'Update check improvements: ① version semantics fixed — alpha/beta are treated as prereleases (no longer mislabeled as stable); ② the "up to date" notice now states it only checks the npm-published global CLI version, and tells you when GitHub has a newer prerelease not yet published to npm (e.g. 0.1.2-alpha.1), so it never looks like a missed update; ③ the "DSH chat → Obsidian" dropdown is vertically centered in Settings; ④ "Restart DSH service" moved right below "Reconnect" in the Quick Actions section'],
    ],
  },
  {
    version: '1.9.8',
    items: [
      ['自动注入不覆盖聊天框已输入内容：隐式信息行改为在你的输入之上生成、换行后保留你已输入的文字（多次框选只保留最新隐式行；取消框选仅清除隐式行、保留你的输入）', 'Auto-inject no longer overwrites what you already typed in the chat: the implicit line is placed above your text and your input is kept after a line break (repeated selections keep only the latest line; deselecting clears only the implicit line, keeping your input)'],
    ],
  },
  {
    version: '1.9.7',
    items: [
      ['修复焦点抢占：注入隐式信息行后不再把焦点移入 DSH 聊天框——框选文字后按 Backspace 等键盘操作仍作用于 Obsidian 文档，不再误删聊天框内容', 'Fix focus stealing: filling the implicit line no longer moves focus into the DSH chat, so keyboard actions (e.g. Backspace) after selecting text still act on the Obsidian note instead of the chat box'],
      ['修复重启服务自动拉起浏览器：启动命令自动补齐 --no-open（当前 DSH 支持时），启动/重启不再弹出浏览器窗口', 'Fix browser auto-open on restart: --no-open is auto-added to the startup command (when supported by the current DSH), so starting/restarting no longer pops up the browser'],
    ],
  },
  {
    version: '1.9.6',
    items: [
      ['桥接提速与默认编辑：①编辑指令改为桥接插件 pre-step 钩子隐藏注入（不占用聊天框）：收到隐式信息行后，DSH 先读取原文，按你的要求只输出一段结果，并询问是否同意写入，同意后才用编辑工具修改文件；②填入结果以 ACK 确认（消除「已填入」假象，最长等待由 4s 降至 ~3s）；③面板已开且桥接就绪时跳过重复探测直接注入；④桥接重建失败 30s 冷却、去抖 300→150ms、打开面板副作用节流；⑤修复设置页「DSH 聊天框桥接到 Obsidian」下拉不显示默认值（旧布尔设置自动迁移：开→自动发送，关→取消）', 'Bridge speed-up & default editing: ① the edit instruction is now injected by a bridge pre-step hook (never shown in the chat UI): on receiving the implicit line, DSH reads the region, outputs only the result (one paragraph), asks whether you agree, and writes the file with the edit tool only after consent; ② fills are confirmed by ACK (removes the false "filled" notice; worst-case wait 4s→~3s); ③ hot path skips redundant probe/openView when the panel is ready; ④ reload cooldown (30s), debounce 300→150ms, openView side-effect throttling; ⑤ fixed the "DSH chat → Obsidian" dropdown showing no default value (legacy boolean setting auto-migrates: true→Auto-send, false→Off)'],
    ],
  },
  {
    version: '1.9.5',
    items: [
      ['桥接位置增强：框选文字改为自动注入隐式信息行（含精确行:列与字数，不含原文），DSH 可按「路径 + 行:列」读取文件定位并修改非整行选区；「DSH 聊天框桥接到 Obsidian」改为三选项（取消/自动发送/右键发送，默认自动发送）；删除「附带来源标签」设置项；面板未打开时不注册自动发送监听；取消框选自动清除聊天框中的隐式行', 'Bridge location enhancement: selecting text now auto-injects an implicit info line (exact line:col + word count, no original text) so DSH can read the file and locate/edit non-full-line selections; "DSH chat → Obsidian" is now a 3-option dropdown (Off/Auto-send/Right-click send, default Auto-send); removed the "Attach source tag" setting; auto-send listeners are not registered while the panel is closed; deselecting auto-clears the implicit line in the chat'],
    ],
  },
  {
    version: '1.9.4',
    items: [
      ['桥接设置完善：新增「DSH 聊天框桥接到 Obsidian」开关；桥接状态显示已加载且生效（含功能列表）；面板显示移回基础设置', 'Bridge settings improved: new "DSH chat → Obsidian" switch; bridge status shows loaded & working (with feature list); panel display moved back to Basic Setup'],
    ],
  },
  {
    version: '1.9.3',
    items: [
      ['修复错误链接', 'Fix incorrect links'],
    ],
  },
  {
    version: '1.9.2',
    items: [
      ['「检查插件更新」改为打开 Obsidian 官方商店页；设置页「一键配置 DSH」按钮垂直居中', '"Check plugin updates" now opens the official Obsidian store page; the "Configure DSH" button in Settings is vertically centered'],
    ],
  },
  {
    version: '1.9.1',
    items: [
      ['修复桥接 bug：解决发送文字到 DSH 聊天框失效、框选浮框残留、启动打点路径等问题', 'Fix bridge bugs: sending text to the DSH chat no longer fails; removed the leftover selection floating button; fixed the startup-log path issue'],
    ],
  },
  {
    version: '1.9.0',
    items: [
      ['快捷键透传：光标聚焦在 DSH 面板内时，Obsidian 全局快捷键仍可响应（自动读取你的快捷键设置）', 'Pass through shortcuts: Obsidian global shortcuts still work while focus is inside the DSH panel (auto-reads your hotkey settings)'],
      ['DSH 或插件更新后自动重写桥接，保持兼容', 'Bridge is rewritten automatically after DSH or plugin updates'],
      ['底部垫高设置：Obsidian 状态栏遮挡面板底部时，可调 0–30px 留白（默认 20）', 'Bottom padding setting: adjust 0–30px space when the Obsidian status bar covers the panel bottom (default 20)'],
      ['设置页调整：DSH 状态栏整合更新日志与检查更新；新增插件版本行', 'Settings reorganized: DSH status bar now hosts changelog + check updates; new plugin version row'],
    ],
  },
  {
    version: '1.8.7',
    items: [
      ['镜像源修复：Git for Windows 镜像按完整版本排序并回退可用目录', 'Mirror fix: Git for Windows mirror sorts by full version and falls back to available directories'],
    ],
  },
  {
    version: '1.8.6',
    items: [
      ['git-for-windows 镜像排序修复（windows.N 参与版本比较）', 'git-for-windows mirror sorting fix (windows.N now participates in version comparison)'],
    ],
  },
  {
    version: '1.8.5',
    items: [
      ['设置页「重连服务」按钮文案改为「刷新」', 'Reconnect button renamed to "Refresh" in Settings'],
    ],
  },
]
