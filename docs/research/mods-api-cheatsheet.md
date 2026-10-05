# Mods API 速查：Dispatch Pilot 用到的事件与 `$` API

Claude Code **2.1.289** 生成的类型。行号缩写：

- `cc:N` = `NOTES/types/claude-code/index.d.ts` 第 N 行（`claude-code/testing` 也在这个文件里，14124–15196）
- `tools:N` = `NOTES/types/claude-code-tools/index.d.ts` 第 N 行

> **移入仓库时的说明（#2，2026-10-04）**：`NOTES` 是当时的会话 scratchpad，已清理。同一版本的类型在任意 mod 用 `--plugin-dir` 加载一次后会生成到 `<mod>/.claude-plugin/types/`，例如 `dispatch-pilot/.claude-plugin/types/claude-code/index.d.ts`，行号相同（2.1.289）；升级 Claude Code 后行号可能变化。`NOTES/mods-testing-seam.md` 现在是 `docs/research/mods-testing-seam.md`。下文保持原样。

`NOTES` = `<scratchpad>/notes`（已清理）。这份 d.ts 与 `docs/research/mods-api-routing-capabilities.md` 当时用的那份逐字节相同，但那篇报告里的 `d.ts:` 行号有时指向注释开头（例如它写 `TurnStepInput（d.ts:12769）`，类型本身在 `cc:12777`），以本文行号为准。标 **[测]** 的是本次 `claude plugin test` 实测过的行为（见 `docs/research/mods-testing-seam.md`）。

---

## 0. 注册规则与 hook 形状

| 项 | 摘录 | 位置 |
|---|---|---|
| `Register` | `(on: On, options: PluginOptions) => unknown`；模块导出 `register` | cc:8802 |
| `PluginOptions` | `Readonly<Record<string, string \| number \| boolean \| readonly string[]>>`：userConfig 的值，默认值已补；sensitive 存安全存储；`--plugin-dir` 下配置键是 `<name>` 或 `<name>@inline` | cc:7314–7326 |
| `On` | `on(pattern, hook)` / `on(pattern, matcher, hook)`；「a plugin's registrations nest in order, first outermost; a repeat throws」 | cc:6457–6471 |
| `Matcher` | `e` 的任意深度部分形状；叶子是 `===` 或 RegExp（按字符串测试）；数组 = 任一；对象 = 部分匹配 | cc:5605–5627、5645–5652 |
| 普通 hook | `async ($, e, next) => …`：观察 `const r = await next(e); return r`；改写 `return next({ ...e, … })`；直接回答（不调 `next`） | cc:4914（`Hook<E>`） |
| 流式 hook（`turn.step`） | `async function* ($, e, next) { return yield* next({ ...e, effort }) }`；普通函数返回 `next(e)` 是类型错误 | cc:11582–11619 |
| `next` 的成员 | `next.signal`（被放弃时 abort）、`next.origin`、`next.trace`、`next.budget`、`next.to(e, tier)`、`next.is(pattern, e)` | cc:6243–6310 |
| 时间预算 | 每个 hook 10 s，只算 hook 自己的代码；等 `next`/`$` 不算，**`$.clock` 的等待算** | cc:4916–4953 |

**加载器的静态规则（[测]，违反即整个模块不加载，`validate` 同样报）**

- `on` 的第一个参数必须是字符串字面量；hook 必须是**函数字面量或函数名**（不能是 `mark('A')` 这类工厂函数的返回值）。
- `$` 只能写成 `$.noun.event(...)`；不能赋值、解构、计算下标访问；可以作为参数传给**同一文件里声明的函数**，**不能传给从其他文件 import 的函数**。需要共用的 `$` 逻辑改成接收闭包（`{ fetch: (u, i) => $.http.fetch(u, i), sleep: (ms, s) => $.clock.sleep(ms, { signal: s }) }`）。
- `on` 可以作为参数传给（包括跨文件 import 的）函数，但不能赋值给别的变量。
- 同一事件**不带 matcher** 注册两次 = 报错，这是全模块（跨文件）的静态检查，与运行时分支无关；带 matcher 的可以任意多个，**相同 matcher 也可以**。
- `$.env.get/set` 的变量名、`$.state` ref 的 `plugin` 和 `key` 必须是字面量（ref 可以是 `as const` 常量或 `{ ...REF, id }`）。
- 只允许相对导入和 `'claude-code'`；禁止动态 `import()`、`require`。

### 多个处理函数挂同一事件（matcher 技巧，[测] dup-d）

```ts
// 第一个可以不带 matcher（最外层，最先看到事件）
on('turn.step', async function* ($, e, next) { /* 主 agent effort */ return yield* next(e) })
// 只看派出 agent / Workflow agent：字段缺失时 RegExp 不命中，所以主 agent 的 step 不会进来
on('turn.step', { agentId: /(?:)/ }, async function* ($, e, next) { return yield* next(e) })
// 想再挂一个「全部」：选一个每次都有的字段配 /(?:)/
on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) { return yield* next(e) })
on('tool.call', async ($, e, next) => next(e))                         // 观察全部工具调用
on('tool.call', { tool: 'Workflow' }, async ($, e, next) => next(e))   // 只看 Workflow
on('tool.call', { tool: /(?:)/ }, async ($, e, next) => next(e))       // 第二个「全部」
on('tool.call', { tool: 'mcp__dispatch-pilot__find_skill' }, async ($, e) => ({ result: … })) // 自注册工具
on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => next(e))   // prompt.submit 的第二个（jev-pilot 旁证，未自测）
```
实测顺序：注册顺序 = 嵌套顺序；同一个 step 依次经过 A（无 matcher）→ B（`agentId` 任意，仅子 agent）→ C（`turnId` 任意）→ D（`agentId: /^wf-/`）→ E（`turnId: 't'`）。内层（后注册的）对 `effort` 的改写会覆盖外层传下来的值，所以**同一字段只让一个 hook 负责写**。

---

## 1. 事件

### `turn.step` — 每次模型请求前（主 agent 和子 agent 都有）
- 说明：`next({ ...e, model })` 或 `effort` 发出另一个值；turn、index、messageCount 固定。不调 `next` 就不发请求。cc:4293–4301
- `TurnStepInput`：`turnId`、`index`（本轮第几步，从 0）、`model`（可改）、`effort?: 'low'|'medium'|'high'|'xhigh'|'max'|number`（可改；不支持 effort 的模型没有这个字段）、`messageCount`、`agentId?`（子 agent / Workflow agent 的 id，主 agent 没有）。cc:12777–12811
- 结果 `TurnStepResult`：`{ turnId, index, answer, toolUses, stopReason, usage }`。cc:12837–12865；`stopReason` 取值 cc:12946；`TurnUsage` cc:12954
- 要点：改写**不会保留到下一步**，每步都要重设（研究报告 [测]）；**绝不写 `model`**；`$.agent.spawn` 启动的子 agent 跳过本 mod 自己的 `turn.step`（cc:12806–12808）。
- 消息内容不在 `e` 上：主 agent `$.session.messages()`，子 agent `$.session.messages({ agentId: e.agentId })`（Workflow agent 读不到）。cc:12769–12776

### `turn.start` / `turn.complete`
- `turn.start`：只能观察，`{ text, turnId }`。cc:4288–4292、12721–12740
- `turn.complete`：轮结束，`e.reason`、`usage`、`durationMs`、`agentId`；返回 `{ text }`。cc:4302–4310

### `prompt.submit` — 用户发消息、轮开始前
- 说明：`next({ ...e, text })` 改写；`{ drop: reason }` 拦下；坏掉的插件不会阻塞 prompt；轮中途输入的 prompt 带该轮 `turnId`。cc:3975–3983
- `PromptSubmitInput`：`text`、`attachments?`、`context?`（模型可见、用户不可见，hook 往里追加：`next({ ...e, context: [...(e.context ?? []), mine] })`，单条超 100,000 字符/合计 200,000 只读开头+路径）、`turnId?`、`wait`、`origin`（不可改）。cc:8554–8597
- 结果：`{ text, context?, origin? }` 或 `{ drop }`；`next(e)` 在 prompt 进入会话（或排队）时 resolve，不等整轮结束；`next` 之后再往结果里放 context 不生效。cc:8599–8640
- `PromptOrigin.kind`：`composer`（终端回车）、`bridge`、`sdk`（`-p`/SDK）、`task-notification`、`scheduled-trigger`、`peer`、`peer-send-message`、`projects-relay`、`channel`、`coordinator`、`observer`、`observer-activity`、`auto-continuation`、`unclassified`、`slack-ping`、`plugin`。cc:8368–8483
- [测] 测试里不给 `origin` 时 `e.origin` 是 `undefined`；mod 写 `e.origin?.kind`。只对 `composer`/`sdk`（以及需要时 `bridge`）做决策。

### `prompt.attachment` — 引擎自己注入给模型的每条消息
- 说明：`next(e)` resolve 为 `{ text }`；`{ text: null }` 去掉；回答在进程内按附件缓存（resume 或 `$.ui.invalidate` 才重问）。cc:4053–4064
- 输入：`type`（如 `skill_listing`、`todo_reminder`、`nested_memory`、`deferred_tools_delta`、`file`…，matcher 用它）、`text`、`origin`（`engine`/`hook`/`plugin`）、`agentId?`。cc:13770–13810、7836–7838；`PromptAttachmentOrigin` cc:7848–7878；结果 cc:7880–7886
- 写法：`on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => e.agentId !== undefined ? next(e) : { text: null })` [测]

### `agent.spawn` — Agent 工具即将启动子 agent（Workflow 的 `agent()` 不经过这里）
- 说明：`next(e)` resolve 为 `{ model }`；可返回它、`next({ ...e, model })`、自己的 `{ model }`（别名照常解析）或 `{ deny }`。cc:3966–3974
- `AgentSpawnInput`：可改 `prompt, description, subagentType, model, background, cwd`；固定 `tool_use_id, name, fork, isTeammate, parentModel, permissionMode, parentAgentId, provider`。`model?` 是 Agent 工具的 `model` 参数（主 agent 指定的），undefined 表示继承；fork 忽略 model。cc:246–356
- 结果 `AgentSpawnResult`：`{ model, agentId?, teammateId? }` 或 `{ deny }`；`agentId` 由 core 给出，就是该子 agent 之后所有事件里的 `agentId`。cc:358–400
- Agent 工具输入（主 agent 写的原始参数，`tool.call` 里看到）：`description, prompt, subagent_type?, model?: 'sonnet'|'opus'|'haiku'|'fable', run_in_background?, name?, isolation?`。tools:6–25；结果 tools:747
- [测] 测试的 `$.agent.spawn` 在类型上需要完整输入（`tool_use_id, provider, parentModel, background, fork` 也要给，否则 tsc 报 TS2739；运行时少给也能跑）。

### `tool.call` — 每次工具调用（模型的或插件的）
- `ToolCallInput` = `{ tool, tool_use_id, ...工具参数 } & { agentId? }`；`tool`、`tool_use_id`、`agentId` 改写会被拒。cc:12086–12103、944–956（字段说明）
- 结果 `ToolCallResult`：`{ deny }` | `{ result, context?, ref?, text?, isReadOnly? }` | `{ isError: true, result, text?, … }`。`context` 是追加给模型的提醒（插件自己 `$.tool.call` 的没有）。cc:12128–12224
- Workflow 输入：`script?`、`name?`、`args?`、`scriptPath?`（优先于 script 和 name）、`resumeFromRunId?`；`description`、`title` 被忽略。tools:717–732；结果 `{ status: 'async_launched'|'remote_launched', taskId, runId?, scriptPath?, transcriptDir?, … }` tools:5175–5195
- Skill 输入：`{ skill, args? }`。tools:609–614
- [测] Workflow 改写：`next({ ...e, script: rewritten })`，工具收到的就是改写后的脚本；mod 返回 `{ deny }` 时 `$.tool.call` 原样 resolve `{ deny }`。settings hook 拦截时 `tool.call` 看到 `{ isError: true, text: 理由 }`。

### `classic.PreToolUse` — settings 里的 PreToolUse hooks（包在 `tool.call` 内部）
- 链：`[managed settings hooks, ...hooks modules, 其他 settings hooks 作为 core]`；`e` 就是 `ToolCallEnvelope`（`tool`、`tool_use_id`、参数）。cc:1170–1180
- 结果 `PreToolUseResult`：`{ allow: true }` | `{ ask }` | `{ deny }` | 都没有（走正常权限流程），外加 `updatedInput?`、`additionalContext?`。cc:7606–7662；`ClassicResultOf` cc:1306–1315
- 识别拦截：`on('classic.PreToolUse', async ($, e, next) => { const d = await next(e); if (d.deny !== undefined) 记 e.tool_use_id; return d })`。[测]

### `skill.prompt` — 引擎展开 skill 的 prompt（`/name`、Skill 工具、预加载）
- `{ skill, text }` → `{ text }`。cc:4150–4160、11330–11354。「加载 skill 时重判 effort」可以挂这里，或挂 `tool.call` 的 `{ tool: 'Skill' }`。

### `session.start` — 每个插件加载时一次（不是每次 `/clear`）
- `{ cwd, surface, isInteractive }` → `{ cwd }`；第一次被 await，所以这里 `$.tool.register` 的工具第一轮就可见；`$.tool.register`（和 `$.agent.register`）在 session 绑定前会 reject，所以放在 `session.start` 里。cc:4172–4183、11120–11147、2934–2949
- 热重载会再触发一次（CLAUDE.md）。

### `session.measure` — 每个主线程轮次后、或限额窗口变动整 1 点时
- 只观察；`next(e)` 回 `{ changed }`。cc:4252–4263
- `SessionMeasureInput`：`context: { tokens?, window, percent? }`、`rateLimits: { kind, percentUsed, resetsAt? }[]`（非订阅为空）、`cost?: { usd }`、`changed: ('context'|'rateLimits'|'cost')[]`。cc:10544–10586、10739–10754、13844、10407–10432（context）、10437–10442（cost）
- [测] 真实订阅会话：`rateLimits` 2 项，`cost.usd` 有值。

### `/compact`、`/clear` 相关
- `session.compact`：`{ trigger: 'manual'|'auto'|'plugin'|'precompute', agentId?, instructions?, messages }` → `{ messages, tokensBefore?, tokensAfter?, usage? }` 或 `{ skip }`。cc:4220–4231、10248–10313。[测] kit 拒绝空 `messages`。
- `/clear` **没有专门事件**：`session.end` 收到 `reason: 'clear'`（之后不触发 `session.start`），classic `SessionStart` 收到 `source: 'clear'`（`'startup'|'resume'|'clear'|'compact'|'fork'`）。cc:4264–4275、10498–10542、11096–11098
- `skill_listing` 在 compact/clear 之后作为新附件再次经过 `prompt.attachment`，hook 回答稳定即可（研究报告 4a）。

### `command.run` — 斜杠命令执行
- `on('command.run', { command: 'dp' }, async ($, e) => ({ text }))`；`e = { command, args, origin, presentation }`；结果 `{ text?, context?, exitCode?, ref? }`。cc:4079–4090、1695–1790

---

## 2. `$` API

| API | 签名 / 要点 | 位置 |
|---|---|---|
| `$.http.fetch` | `(url, init?: { method?, headers?, body?: string, auth?, socketPath? }) => Promise<{ status, ok, headers, text }>`；**没有超时、没有 signal**，超时自己 `Promise.race` + `$.clock.sleep`；也是一个事件 `http.fetch`（`e = { url, init? }`），测试里在这里替换 | cc:3364–3389、5019–5077、6821–6827 |
| `$.fs.read` | `(path) => Promise<string>`；`{ as: 'bytes' }` 得 `{ base64 }`；缺失或超 4 MiB reject；相对路径相对会话 cwd | cc:3121–3140、4774–4809、6727–6734 |
| `$.fs.exists` | `(path) => Promise<boolean>` | cc:3162–3166、6748–6753 |
| `$.fs.list` | `(path?) => Promise<{ name, kind: 'file'\|'dir'\|'other', size, mtimeMs, isLink }[]>` | cc:3148–3161、4740–4772 |
| `$.fs.stat` / `write` | `stat(path, { resolve? })`；`write(path, text)`（建目录） | cc:3141–3147、3167–3219 |
| `$.state.get` | `(ref) => Promise<{ value, version }>`；从未写过是 `undefined`@0；一次 dispatch 内读到同一时刻 | cc:3282–3298、11479–11489 |
| `$.state.set` | `(ref, value, { ifVersion }?) => Promise<{ isSet, version }>`；只能写自己的；value 不能是 `undefined`；渲染中禁止写 | cc:3299–3315、11516–11537 |
| `PluginState` 契约 | `declare module 'claude-code' { interface PluginState { '<plugin name>': { key: T; fam: StateFamily<T> } } }`，**文件顶层不能有 export**；`StateFamily<T>` 每个 `id` 一个值，ref 必须带 `id` | cc:7443–7455、11446–11459、11491–11502 |
| `$.store` | `get(key)`、`set(key, value)`（JSON，超 4 MiB reject）、`delete(key)`、`keys()`；跨会话、跨热重载，本机共享 | cc:3242–3273 |
| `$.tool.register` | `({ name, description, inputSchema? }) => Promise<{ tool }>`；模型按 `mcp__<plugin>__<name>` 调用，由 `tool.call` hook（matcher `{ tool: 'mcp__<plugin>__<name>' }`）回答；同名再注册即替换；session 绑定（`session.start`）前 reject | cc:2934–2949、12485–12504、6640–6643 |
| `$.tool.list` / `call` | `list()`：模型当前可用工具；`call({ tool, ...args })`：经过除自己外的所有 hook、权限检查、工具 | cc:2902–2921 |
| `$.command.register` | `({ name, description, argumentHint?, immediate?: true }) => Promise<{ command }>`；用 `command.run` hook 回答；`immediate` 让命令在轮进行中也立即执行 | cc:2975–2989、1801–1827 |
| `$.command.list` | `() => Promise<{ name, description, source: 'builtin'\|'plugin'\|'user'\|'mcp', plugin? }[]>`（没有路径和 frontmatter 标志） | cc:2955–2962、1647–1668、1792–1799 |
| `$.command.run` | `({ command, args? })`：像用户输入一样运行；在 turn 等待它的 hook 里会 reject | cc:2963–2974 |
| `$.ui.status` | `(text \| undefined) => void`；每个插件一行，`undefined` 清除；`-p` 下没有状态行，写进 debug log | cc:2364–2375、6672–6677 |
| `$.ui.log` | `(text, { to?: 'transcript' \| 'debug' }) => void`；`to: 'debug'` 只进 debug log（`claude --debug` / `--debug-file`），行首是插件名 | cc:2315–2330、13292–13310、6678–6685 |
| `$.ui.toast` / `invalidate` | `toast(text, { timeoutMs? })`；`invalidate(event)` 让缓存答案的事件重问 | cc:2347–2363、2264–2277 |
| `$.model.complete` | `({ model, prompt, system?, maxTokens? (默认 1024), effort?, timeoutMs? }, { signal }?) => Promise<{ isAnswered: true, text, usage } \| { isAnswered: false, reason: 'api-error'\|'empty-reply'\|'aborted', … }>`；走用户自己的订阅/key；模型别名按 `--model` 解析并受 allowlist 约束 | cc:2489–2516、5914–6066 |
| `$.model.classify` / `fork` | `classify(text, labels, { model? })`；`fork({ prompt })` 复用主线程缓存 | cc:2517–2554 |
| `$.clock` | `now()`、`sleep(ms, { signal }?)`（等待**计入** hook 预算）、`after(ms, fn)`、`every(ms, fn)` → `{ cancel }`；热重载取消挂起的等待 | cc:3316–3363、12051–12065 |
| `$.session.messages` | `()` → 主对话 `{ role, text, toolUses, toolResults? }[]`（最新 4096 条）；`({ agentId })` → 子 agent 的，读不到时 `{ deny }`（Workflow agent 读不到）；`({ as: 'api' })` → Messages API 形式 | cc:2637–2669、10588–10704、12506–12560（`ToolUseSummary`） |
| `$.session.model` | `() => Promise<string>`：主 agent 当前模型（`/model` 显示的） | cc:2682–2685 |
| `$.session.usage` | `({ breakdown?, columns? }?)`：`{ startedAt, context, rateLimits, cost }` | cc:2723–2744 |
| `$.session.id` / `cwd` / `turns` | 会话 id、cwd、用户已发 prompt 数 | cc:2670–2694 |
| `$.agent.list` | 子 agent 和 teammate（不含 Workflow agent） | cc:3077–3085 |
| `$.env.get` | `(literalName) => Promise<string \| undefined>` | cc:3486–3508 |
| `$.plugin` | `{ name, root }`：插件名和目录（绝对路径） | cc:2233–2245 |

---

## 3. 测试 kit（`claude-code/testing`）

| 项 | 摘录 | 位置 |
|---|---|---|
| `test` | `test(name, body)` 或 `test(name, options, body)`；默认 5000 ms 超时；失败时附带「the engine reported」 | cc:15126–15137 |
| `TestBody` | `($: Engine, on: On) => unknown`；`on` 注册的 hook 在所有插件之下，再下面的底层 hook 抛错并说出事件名；插件在第一次调用 `$` 时加载 | cc:15139–15146 |
| `TestOptions` | `{ plugins?: Plugin[], timeoutMs?, options?: PluginOptions }`；`options` = 被测 mod 的 userConfig（未给的用 manifest 默认值，内联插件拿不到） | cc:15148–15169 |
| 内联插件 `Plugin` | `{ name, tier?, register }`；`register` 自包含，不闭包测试文件的任何东西 | cc:15064–15075 |
| `tier` | 文件顶部调用一次，改被测 mod 的 tier | cc:15182–15188 |
| `Engine` | 测试的 `$`：每个引擎事件一个方法（`$.prompt.submit`、`$.turn.step`、`$.tool.call`、`$.agent.spawn`、`$.prompt.attachment`、`$.session.*`、`$.command.run`…），外加 `$.classic.<Event>`、`$.ui.mount`；[测] 没有 `state` | cc:14252–14285 |
| `ClassicEvent` | `classic.PreToolUse` 不能直接触发，它随 `$.tool.call` 发生：在所有插件的 `tool.call` 之下、测试自己的 `tool.call` 桩之上；deny 时桩不会被调用，调用以错误 resolve、理由为 `text` | cc:14170–14178 |
| `mock` | `mock.clock(on, { now? })`、`mock.store(on, entries?)`、`mock.env(on, vars)` | cc:14681–14723 |
| `MockClock` | `now()`、`advance(ms)`、`set(ms)`、`settle()`、`sleep(ms)`（在桩里模拟慢响应）；挂起超过 10 s 真实时间的等待会被放掉 | cc:14725–14780 |
| `expect` | `toBe/toEqual/toStrictEqual/toMatchObject/toContain/toContainEqual/toHaveLength/toHaveProperty/toBeUndefined/toBeDefined/toBeNull/toBeTruthy/toBeFalsy/toBeGreaterThan…/toMatch/toStartWith/toEndWith/toThrow`，`.not`、`.resolves`、`.rejects`，`expect.any/anything/stringContaining/stringMatching/objectContaining/arrayContaining` | cc:14394–14679 |

桩的返回形状、事件驱动的完整写法、空过陷阱：见 `NOTES/mods-testing-seam.md` 第 4、5 节。
