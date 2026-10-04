# mod 能否做"决策模型选 effort + model + skills"的路由：API 能力调研

调研日期 2026-10-04，本机 Claude Code `2.1.289`。目标是确认一个 mod 能否在不换主模型的前提下按轮（甚至按请求）设置 reasoning effort、拦截子代理并改它的 model 和 effort、管理 skill 列表并按轮注入 skill、调用外部决策服务，以及这些做法对 prompt cache 的影响。

## 证据来源与标注约定

- **d.ts（最权威）**：用一次性 probe mod 让本机 Claude Code 生成的类型声明。路径是
  `<scratchpad>/probe-mod/.claude-plugin/types/claude-code/index.d.ts`，下文简写为 `d.ts:<行号>`。第 1 行写明 `// Written by Claude Code 2.1.289.`，第 4 行写明 `EARLY ACCESS: this surface may change between releases without notice.`。内置工具的输入输出类型在同目录的 `claude-code-tools/index.d.ts`，简写为 `tools.d.ts:<行号>`。这两个文件在 scratchpad 里，会被清理；按文末"复现"一节跑一次 `--plugin-dir` 就会重新生成，行号以 2.1.289 为准。
- **官方文档**：mods 的 [events](https://code.claude.com/docs/en/plugins/mods/events)、[api](https://code.claude.com/docs/en/plugins/mods/api)、[reference](https://code.claude.com/docs/en/plugins/mods/reference)，以及 [workflows](https://code.claude.com/docs/en/workflows)、[skills](https://code.claude.com/docs/en/skills)、[Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)，还有 API 文档 [effort](https://platform.claude.com/docs/en/build-with-claude/effort) 和 [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。reference 页自己说 GitHub 上的 `claude-code.d.ts` 可能比本机版本旧，冲突时以本机生成的为准，所以本文没有用 GitHub 那份。
- **实测**：在 scratchpad 跑了 4 次 `command claude -p`，都用 `--settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}'` 关掉本机已装的 jev-pilot，避免它也改 effort 和 model 干扰结果（debug log 确认只加载了 probe-mod 和内置 mod）。probe 把每个事件写成一行 JSON，日志文件和行号如下（也都在 scratchpad 里）：
  - run 1：只为生成类型，`probe-run1.log`。
  - run A：并行启动两个 Explore 子代理，再用 Skill 工具调用一个 `disable-model-invocation: true` 的 skill。产物是 `probe-events-runA.jsonl` 和 `probe-run2.log`。
  - run B：Workflow 工具跑一个只含一个 `agent()` 的脚本，再启动一个普通 Agent。产物是 `probe-events-runB.jsonl` 和 `probe-run3.log`。
  - run C：`ANTHROPIC_LOG=debug`，看请求头和请求体的结构，并对 Haiku 4.5 子代理强行设 effort。产物是 `probe-events-runC.jsonl`、`probe-run4.out`（SDK 日志）和 `probe-run4.log`。
  - 所有 run 的主模型都是 `claude-opus-5-5`（`probe-events-runA.jsonl:53`），用的是订阅登录（请求头带 `oauth-2025-04-20`，`probe-run4.out:37`），会话默认 effort 是 `xhigh`。
- **第三方实现（只作旁证）**：本机装着 jev-pilot 0.12.1（作者 Ahmed Akram，MIT），它做的就是这类路由：主循环 effort、子代理 model 和 effort、skill 推荐。路径是 `~/.claude/plugins/cache/jev-pilot/jev-pilot/0.12.1/`。它的做法只能证明"这样写能跑"，不是官方保证。
- 每条结论都标了来源：**[读]** 表示来自 d.ts 或文档，**[测]** 表示本次 probe 实际观察到，**[旁证]** 表示来自 jev-pilot。

## 结论速览

| # | 问题 | 结论 |
|---|---|---|
| 1 | 不换模型、只设主循环的 effort；能否在一轮中途改 | **YES**，用 `turn.step` 的 `next({ ...e, effort })`，按请求生效，中途也能改 [读+测]。`prompt.submit`、`turn.start`、`config.set` 都改不了 effort [读+测]。也能改 model，所以要刻意不传 `model` |
| 2 | 拦截子代理并改它的 model 和 effort | model：**YES**，用 `agent.spawn` [测]。effort：`agent.spawn` 上 **NO**（没有这个字段），但可以在该子代理自己的 `turn.step` 上设，**YES** [测]。一条消息里启动几个 Agent，hook 就触发几次，**YES** [测] |
| 3 | Workflow 里 `agent()` 启动的代理会不会经过 `agent.spawn`、`tool.call` | `agent.spawn` 和 `tool.call(Agent)`：**NO** [测]。`turn.step`（带 `agentId`）：**YES**，effort 能改 [测]，model 理论上也能在这里改 [读，未测] |
| 4a | 删掉或缩短 skill 列表 | **YES**，用 `prompt.attachment` 处理 `type: 'skill_listing'`。列表在消息附件里，不在 system prompt 里 [读+测] |
| 4b | 运行时枚举所有 skill 的 name、description、path | **部分可以**：name、description、source、plugin 有 [测]；path 和 frontmatter 标志没有，只能自己到磁盘上找 [读+测+旁证] |
| 4c | 按轮把选中 skill 的条目或 SKILL.md 全文注入主代理的下一次请求 | **YES**，用 `prompt.submit` 的 `context` [读+旁证]，同类路径 `tool.call` 的 `context` 已实测 |
| 4d | mod 能否让模型通过 Skill 工具调用 `disable-model-invocation` 的 skill | 走 Skill 工具：**NO**，引擎会拦 [测]。mod 绕过 Skill 工具直接把内容塞给模型：**能做到** [测]，但这违背 skill 作者的意图 |
| 4e | 每轮改 system prompt 的 section 会不会破坏缓存 | **会**。要按轮注入就走消息附件，不要改 system section [读] |
| 5 | 外部调用、密钥、超时、并行、`$.model.*` | 能 `$.http.fetch` 到任意 http/https 地址，但请求选项里没有超时字段；`userConfig` 支持 `sensitive`；每个 hook 自身代码的预算是 10 s，等 `$` 调用的时间不算；可以并行。详见第 5 节 |
| 6 | 其他相关 API 和限制 | 见第 6 节 |
| 7 | `turn.step` 上设的 effort 走的是不是和 `/effort` 一样能保住缓存的路径；Haiku 4.5 会不会忽略 effort | 保住缓存：**YES**（Opus 5.5 + 订阅，3 次实测）。但这既符合"走 per-message 路径"，也符合"改动根本没发出去"，计数器本身分不开；倾向前者，因为 Haiku 那次 core 会剥掉 effort，说明它确实处理这个字段。请求的具体结构（顶层参数还是 per-message system 消息）**UNKNOWN**。Haiku 4.5 忽略 effort：**YES** [测] |

---

## 1. 主循环 effort

**结论：YES。** 在 `turn.step` hook 里把 `e.effort` 改了再交给 `next`，`e.model` 原样保留，就是"只改 effort，不换模型"。

[读]
- `turn.step` 在引擎即将发出一轮里的每个模型请求时触发，主循环和子代理都会触发：`Fires when the engine is about to send a model request of a turn, main's or a subagent's (e.agentId) ... next({ ...e, model }) or effort sends another; the turn, the index and the message count are pinned.`（`d.ts:4293-4301`）。
- `TurnStepInput`（`d.ts:12769-12811`，字段有 `turnId`、`index`、`model`、`effort`、`messageCount`、`agentId`）：`A hook rewrites model or effort going down; the rest is pinned.`（`d.ts:12774-12775`）。effort 的类型是 `effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number`，注释是 `the session's setting or the model's default, absent for a model without effort; rewritable.`（`d.ts:12792-12796`）。`index` 是这一步在本轮中的位置（`d.ts:12783-12786`）。
- 它是流式事件，hook 必须写成 `async function*`，用 `yield* next(e)` 转发（`d.ts:11610-11619`）。reference 页 Turns 表写的也是 `next({ ...e, model })`, `next({ ...e, effort })`。
- 其他入口都改不了 effort：`turn.start` 只能观察（`Observe: a different return changes nothing.`，`d.ts:4288-4291`、`12734-12740`）；`PromptSubmitInput` 只有 `text`、`attachments`、`context`、`turnId`、`wait`、`origin`，没有 effort（`d.ts:8554-8597`）；`$.settings` 只读（`d.ts:3453-3477`）；classic hook 输入里的 `effort` 也只是可读的信息（`d.ts:793-797`）。

[测]
- 用 `config.list` 列出的 `/config` 行里没有 effort 相关的行，只有 `model`（choice，可选 `default, sonnet, opus, haiku, fable, best, ...`）和被锁定的 `thinking`（`probe-events-runA.jsonl:1`）。所以 `$.config.set` 这条路设不了 effort。
- 主循环 index 0 时，hook 收到的 `effortIn` 是 `xhigh`，改成 `medium` 发出；index 1、2 改成 `high`。`next.trace` 里引擎 core 那一层实际收到的就是改过的值：`{"plugin":"engine","tier":"core","outcome":"returned","effort":"medium"}`，后面几步是 `"effort":"high"`（`probe-events-runA.jsonl:65,124,154,164`，`probe-events-runC.jsonl:65,94,124,128`）。所以**一轮中途、两步之间改 effort 是可以的**。
- 改写不会保留到下一步：index 1 时 hook 收到的 `effortIn` 又变回会话的 `xhigh`（`probe-events-runA.jsonl:154`）。**mod 必须每个 `turn.step` 都重新设一遍**。jev-pilot 也是这么做的：第一步定下 `applied`，之后每步都 `next({ ...e, ...applied })`（`jev-model-router.ts:678-741`）[旁证]。

**能不能换模型（确认需要避开的点）：能。** 有三条路：`turn.step` 的 `model`（`Which model the request names ... next({ ...e, model }) names another.`，`d.ts:12787-12791`）；子代理的 `agent.spawn`；`$.config.set({ key: 'model' })`（这一行存在，`probe-events-runA.jsonl:1`，未测）。要避开，就是在 `turn.step` 只传 `{ ...e, effort }`，永远不往里放 `model`。另外引擎遇到过载会自动 fallback 换模型，这时 `e.model` 本身就会变（`d.ts:12788-12789`），mod 照传即可，不要"改回去"。jev-pilot 默认关闭主循环换模型，理由是 `switching models mid-session invalidates the prompt cache`（`plugin.json:154` 的 `routeMainModel`，`jev-model-router.ts:17-19`）[旁证]。

---

## 2. 子代理：拦截并改 model 和 effort

**拦截：YES。** 有三个事件都能拦，作用不同：
- `tool.call`（`{ tool: 'Agent' }`）：在 `agent.spawn` 之前触发，拿到的是模型写的原始参数（`description`、`subagent_type`、`run_in_background`、`prompt`，以及可选的 `model`、`isolation`、`name`）（`tools.d.ts:6-25`）。可以 deny，也可以改参数。Agent 工具自己的 `model` 参数只接受 `"sonnet" | "opus" | "haiku" | "fable"`（`tools.d.ts:14`）。[测] 两次调用分别记录在 `probe-events-runA.jsonl:82,84`。
- `agent.spawn`：`Fires when the Agent tool is about to start a subagent, everything decided and its model not yet resolved. next(e) resolves to { model }. Return it, next({ ...e, model }), { model } of your own (an alias resolves like the tool's parameter), or { deny: reason }.`（`d.ts:3966-3974`）。
- `agent.offer`：只决定某个代理类型是否出现在列表里、能否被派发（`d.ts:3955-3965`、`216-244`），不能改 model 或 effort。实测它在每次派发时都会对所有类型再触发一遍（runA 里共 35 条）。

**改 model：YES [测]。** probe 在 `agent.spawn` 里 `next({ ...e, model: 'haiku' })`，结果是 `{"model":"claude-haiku-4-5-20251001","agentId":"a801b7f61a2137ece"}`（`probe-events-runA.jsonl:102,104`）；改成 `'sonnet'` 时得到 `claude-sonnet-5-5`（`probe-events-runB.jsonl:117`）。debug log 里对应一行：`agent.spawn general-purpose: model (inherit) -> sonnet by a hook`（`probe-run3.log:596`）。fork 例外，它总是继承父代理的模型，`model` 字段会被忽略（`d.ts:294-300`、`329-333`）。

**改 effort：`agent.spawn` 上 NO，换个地方 YES。**
- [读] `AgentSpawnInput` 可改写的字段只有 `prompt, description, subagentType, model, background, cwd`，没有 effort（`d.ts:259-261`，字段全集见 `263-356`）。Agent 工具的输入也没有 effort（`tools.d.ts:6-25`）。
- [测] 可行的做法：在 `agent.spawn` 里拿到 `next(e)` 返回的 `agentId`，然后在 `e.agentId === 那个 id` 的 `turn.step` 上改 effort（`d.ts:12802-12810`：`The loop the request is made in: a subagent's id ...`）。实测 sonnet 子代理 `effortIn: "medium"` 改成 `low` 后，core 收到的是 `"effort":"low"`（`probe-events-runB.jsonl:118,132`）。jev-pilot 也是这样做的（`jev-model-router.ts:651-672`、`1133-1137`、`1168-1171`）[旁证]。
- 没测过的另一条路：用 `$.agent.register` 注册一个带 `effort?: string | number` 的代理类型（`d.ts:409-442`），再在 `agent.spawn` 里把 `subagentType` 改成它（`d.ts:280-287`：`A rewrite names another agent this call can dispatch, exactly.`）。
- 注意两点。第一，不支持 effort 的模型（Haiku 4.5）在 `turn.step` 上根本没有 `e.effort`（`probe-events-runA.jsonl:106-107`），见第 7 节。第二，mod 自己用 `$.agent.spawn` 启动的子代理会跳过这个 mod 自己的 `turn.step` hook：`A subagent a hook spawned through $.agent.spawn steps past that hook`（`d.ts:12806-12809`）。

**hook 能拿到哪些字段来做判断 [读+测]**：实测 `Object.keys(e)` 是 `tool_use_id, prompt, description, subagentType, provider, model, parentModel, permissionMode, background, fork, name, cwd`（`probe-events-runA.jsonl:100`）。此外类型里还有 `parentAgentId`（嵌套启动时才有）和 `isTeammate`（`d.ts:263-356`）。
- 父代理写给子代理的完整任务就是 `e.prompt`（`d.ts:269-273`）。实测拿到的是全文，probe 只是自己截断了。
- 父代理的上下文：主循环用 `$.session.messages()`，嵌套时用 `$.session.messages({ agentId: e.parentAgentId })`（`d.ts:2638-2669`），最多 4096 条。
- 父代理当前的模型是 `e.parentModel`（`d.ts:302-305`）。

**一条消息里启动多个代理时，hook 是否每个都触发：YES [测]。** 一条 assistant 消息里有两个 Agent 调用，`tool.call` 和 `agent.spawn` 各触发两次，`tool_use_id` 各不相同，结果也是两个不同的 `agentId`（`probe-events-runA.jsonl:82,84,100,101,102,104`）。之后两个子代理的 `turn.step` 交错执行（`:106-107`），说明 hook 会并发运行。

另外，`prompt.submit` 也会收到子代理交回的结果（`origin.kind: "peer"`）和后台任务通知（`"task-notification"`），这时带着正在进行的 `turnId`（`probe-events-runA.jsonl:145-146`，`probe-events-runB.jsonl:135`）。路由器要按 `e.origin.kind` 过滤，别把这些当成新的用户请求重新做决策。

---

## 3. Workflow 工具里的 `agent()`

**结论 [测]：Workflow 启动的代理不经过 `agent.spawn`，也不经过 `tool.call(Agent)`；但每个请求都会经过 `turn.step`，并带着 `agentId`。** 所以 effort 可以在 `turn.step` 上改（已实测），model 理论上也能在那里改（类型声明支持，未对 workflow 代理实测）。

[测] 在 run B 里（`claude -p` 加 `--allowedTools "Workflow,Agent,Bash(sleep:*)"`）：
- 主循环调用 Workflow 时触发了一次 `tool.call`，结果是 `{"status":"async_launched","taskType":"local_workflow","runId":"wf_995cec0b-ebd",...}`（`probe-events-runB.jsonl:82,84`）。
- 脚本里的 `agent(..., { model: 'sonnet' })` 启动的代理 `a828e538a849ced53`：
  - **没有** `agent.spawn` 记录。整个 run 只有一条 `agent.spawn`，对应的是后面那个普通 Agent 调用（`probe-events-runB.jsonl:116`）。debug log 里也只有一行 `... by a hook`（`probe-run3.log:596`）。
  - **没有** 对应的 `tool.call(Agent)`。
  - **有** `turn.step`：`{"index":0,"model":"claude-sonnet-5-5","effortIn":"medium","effortSent":"low","agentId":"a828e538a849ced53"}`，core 收到的是 `"effort":"low"`（`probe-events-runB.jsonl:86,129`）。
  - **有** 带 `agentId` 的 `prompt.attachment`，其中包括它自己的 `skill_listing`；也**有** `turn.complete`，`answer: "ok"`（`probe-events-runB.jsonl:130`）。

[读] d.ts 和这个结果一致：
- `A workflow's agents and the engine's own forks (compaction, memory) carry ids no list names.`（`d.ts:201-202`）
- `$.agent.list()` 的说明：`Loops the engine tracks as agents with no agent.spawn (a forked skill) are here; a workflow's are not.`（`d.ts:3081-3083`）
- `$.session.messages({ agentId })` 读不到 workflow 代理：`Not an agent a workflow run filed under the run.`（`d.ts:10669`、`10697`）

GitHub issue [#75055](https://github.com/anthropics/claude-code/issues/75055)（v2.1.201，已于 2026-08-17 关闭）也写着 `Workflow scripts spawn agents through a path that bypasses both CLAUDE_CODE_SUBAGENT_MODEL and PreToolUse Agent/Task hooks.`。维护者回复说 `CLAUDE_CODE_SUBAGENT_MODEL` 现在 `applies to subagents, agent teams, and every agent spawned by a workflow, taking precedence over the session model and any per-stage` model。另外 [#70287](https://github.com/anthropics/claude-code/issues/70287) 记录了 workflow 代理的工具集里没有 Agent 工具。

**对路由器的影响：**
- 判断依据有限。workflow 代理的任务 prompt 不经过任何能拿到全文的事件，`session.messages` 也读不到。能拿到的只有 Workflow 那次 `tool.call` 的输入：`script`、`scriptPath`、`name`、`args`（`tools.d.ts:717-732`）。mod 可以解析脚本，或者在 `tool.call` 里改写脚本，比如给每个 `agent()` 加上 `model`。改写脚本在类型上可行，但**未测**。
- 怎么认出 workflow 代理：它的 `agentId` 在 `agent.spawn` 里从没出现过，也不在 `$.agent.list()` 里。
- 能非交互运行：文档说 `-p` 下需要 allow 规则 `Workflow`（[workflows](https://code.claude.com/docs/en/workflows) 的 "Approve the plan before it runs" 一节），本次就是这样实测的。
- 文档还说 workflow 代理选模型的顺序和子代理一样，脚本里写的 model 相当于单次调用指定的 model（workflows 页 Cost 一节）。

---

## 4. Skills

### 4a. 删掉或缩短 skill 列表：YES

- [读] `prompt.attachment` 每次请求携带一条引擎自己注入的消息时触发一次；返回 `{ text: null }` 就是去掉这条（`d.ts:4053-4064`）。类型名包括 `skill_listing`（`d.ts:13779-13781`）。`The <system-reminder> wrapper ... goes around what the chain answers`（`d.ts:13788-13790`）。hook 的回答会在整个进程内复用，`The answer holds per attachment for the process (asked again on resume or $.ui.invalidate)`（`d.ts:4057-4059`），所以只要回答稳定就不会反复破坏缓存。
- [测] 主循环第一次请求带着 `{"type":"skill_listing","origin":{"kind":"engine"},"len":17429}`（`probe-events-runA.jsonl:73`）。子代理有自己的一份，带 `agentId`，长度 8062（`:111`）。workflow 代理也有（runB）。所以可以按 `e.agentId` 只处理主循环，或者连子代理一起处理。
- [测] 列表**不在 system prompt 里**。`$.prompt.compose()` 返回的 section 是 `lean_body:shared, communication, pronouns, action_caution, session_guidance, env_info_simple, context_management, act_dont_rederive, total_tokens`，没有 skills（`probe-events-runA.jsonl:28`）。所以想删列表就用 `prompt.attachment`，不要用 `prompt.section`。
- 删列表这件事我没有自己测，但 jev-pilot 就是这么做的（`jev-skill-suggestion.ts:224-268`，直接 `return { text: kept }`）[旁证]。它在本机 run 1 里输出过一句 `65 skills are still listed for the model (withheld here, but /context counts them)`（`probe-run1.log:457`）。
- 其他手段：`tool.describe` 能改 Skill 工具本身的描述（`d.ts:4065-4078`、`12313-12352`）；`prompt.compose` 有一个 `skills` trait（`d.ts:8014`、`8029`）；也可以不用 mod，在设置里用 `skillOverrides` 隐藏（[skills 文档](https://code.claude.com/docs/en/skills)）。

### 4b. 运行时枚举所有 skill：部分可以

- [测] `$.command.list()` 返回 165 条，按来源分是 `user:70, builtin:56, plugin:37, mcp:2`，每条的字段只有 `name, description, source`，来自插件的再加一个 `plugin`（`probe-events-runA.jsonl:2`；类型见 `d.ts:1650-1668`）。**没有 path**，也**没有 frontmatter 标志**：那个 `disable-model-invocation` 的 skill 照样列出来，看不出区别。
- [测] `$.session.usage({ breakdown: 'summary' })` 的 `context.breakdown.skills` 是 `{ totalSkills: 65, includedSkills: 65, tokens: 5767, skillFrontmatter: [{ name, source, tokens }, ...] }`（`probe-events-runA.jsonl:52`；类型见 `d.ts:2154-2195`）。这里也没有 description 和 path。
- [测] `$.skill.prompt` **在 `$` 上不存在**，调用时报 `TypeError: undefined is not an object (evaluating '$.skill.prompt')`（`probe-events-runA.jsonl:4`）。虽然 `EventCalls` 里声明了 `skill.prompt`（`d.ts:4566-4568`），但 `CoreEngineInterface`（`d.ts:2232-3509`）里没有 `skill` 这个名字。所以没法靠 API 取到某个 skill 展开后的全文。
- 要 path 和 SKILL.md 全文，只能按 Claude Code 的目录布局自己到磁盘上找：`<cwd>/.claude/skills/<name>/SKILL.md`、`~/.claude/skills/...`，插件的 skill 要从 `~/.claude/plugins/installed_plugins.json` 查安装路径，然后用 `$.fs.exists`、`$.fs.list`、`$.fs.read` 读（`d.ts:3121-3241`）。jev-pilot 就是这么做的（`jev-skill-suggestion.ts:341-383`、`393-412`）[旁证]。
- 要拿到"模型实际看到的" name 和 description，可以解析 `skill_listing` 的文本。jev-pilot 用这份列表把候选范围缩到引擎允许模型调用的那些（`jev-skill-suggestion.ts:192-196`）[旁证]。

### 4c. 按轮注入 skill 条目或 SKILL.md 全文：YES

- [读] `prompt.submit` 的 `context`：`What the model reads beside the prompt and the user never sees, each entry one block after the prompt as typed ... next({ ...e, context: [...(e.context ?? []), mine] })`。单条超过 100,000 个字符（合计超过 200,000）时，模型只会读到开头和一个文件路径（`d.ts:8563-8571`）。events 页的表里也列了这一项。
- [测，同类路径] 我没有直接测 `prompt.submit` 的 `context`，但测了同样机制的 `tool.call` 的 `context`：它以附件形式出现，`{"type":"hook_additional_context","origin":{"kind":"plugin","event":"tool.call"}}`（`probe-events-runA.jsonl:173`），模型也读到了。`PromptAttachmentOrigin` 的 `kind: 'plugin'` 一项明确写着它涵盖 `prompt.submit` 和 `tool.call` 两种（`d.ts:7868-7877`）。jev-pilot 默认的 `inject: "content"` 就是用 `prompt.submit` 的 `context` 注入 SKILL.md 全文（`jev-skill-suggestion.ts:556-591`）[旁证]。
- 子代理不经过 `prompt.submit`。要给子代理注入，就在 `agent.spawn` 里改写 `prompt`（`d.ts:269-273`），或者用 `AgentSpec.skills` 预加载（`d.ts:465-467`）。

### 4d. `disable-model-invocation` 的 skill：走 Skill 工具 NO，mod 绕过去能做到

- [测] 模型调用 Skill 工具 `probe-mod:probe-secret` 时，引擎返回错误：`<tool_use_error>Skill probe-mod:probe-secret cannot be used with Skill tool due to disable-model-invocation. Ask the user to run /probe-mod:probe-secret themselves — it cannot be invoked via the Skill tool. Do not replicate this skill's workflow by other means — it is reserved for explicit user invocation.</tool_use_error>`（`probe-events-runA.jsonl:162`）。文档也说 `If Claude tries anyway, Claude Code blocks the call`（[skills](https://code.claude.com/docs/en/skills)）。
- [测] mod 能绕过去。在 `tool.call` 里看到这个错误后，不返回它，而是返回 `{ result: { success: true, commandName }, context: [skill 文本] }`。结果被接受，模型看到 `Launching skill: ...` 和注入的文本，最后答出了只存在于注入文本里的 `PINEAPPLE`（`probe-events-runA.jsonl:163,173,177`）。另一条路是 `prompt.submit` 的 `context`，见 4c。
- 建议：这样做直接违背了 skill 作者用 `disable-model-invocation` 表达的意图，引擎的错误文本也明确要求不要用别的办法复制。路由器应该把这类 skill 从候选里排除。jev-pilot 就是这样处理的：`decision = { name: null, reason: '/<name> has disable-model-invocation' }`（`jev-skill-suggestion.ts:532-537`）[旁证]。

### 4e. 缓存：改 system section 会破坏缓存，按轮注入要走消息附件

- [读] `prompt.section`：`Cached until $.ui.invalidate("prompt.section"): an unstable answer spends the prompt cache every call`（`d.ts:4024-4026`）。`prompt.compose` 的 section 以缓存边界为界，分成 `shared` 和 `session` 两侧，`text that varies hits that cache for nobody`（`d.ts:7961-7969`）。`tool.describe` 同理（`d.ts:4069-4070`）。
- [读] Claude Code 文档：skill 和 command 的内容是在调用的位置作为 user 消息追加的，`Nothing earlier in the conversation changes`；会让缓存失效的情况包括改工具定义、换模型、改 effort（大多数模型）等（[prompt caching](https://code.claude.com/docs/en/prompt-caching)）。
- 落点 [测]：`skill_listing` 和 `prompt.submit`、`tool.call` 的 `context` 都是消息附件（`probe-events-runA.jsonl:73,173`），不在 system prompt 里。所以：
  - 每轮用 `prompt.submit` 的 `context` 注入：内容追加在最新的 user 消息后面，之前的前缀不变，缓存保住。
  - 每轮改 `prompt.section` 或 `tool.describe`：system 或 tools 层变了，整段前缀重新计算，缓存失效。
  - 删 `skill_listing`：回答在进程内固定，只在第一次请求时改变一次前缀，之后稳定。

---

## 5. 外部调用、密钥、超时、并行、`$.model.*`

**`$.http.fetch` [读]**
- `http or https, to whatever the host reaches, unless the organization's web-fetch policy refuses it.`（`d.ts:3367-3388`）。
- 请求选项 `HttpInit` 只有 `method`（字符串，`GET` (default), `POST`, ...）、`headers`、`body`（字符串）、`auth`、`socketPath`（`d.ts:5022-5055`）。**没有超时字段，也没有 AbortSignal**。
- 返回 `{ status, ok, headers, text }`（`d.ts:5060-5077`）。
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 只拦内置插件的请求和带 `auth` 的插件请求（`d.ts:3373-3374`、`5039-5041`）。
- 每次 `$` 调用本身也是一个事件（`'http.fetch'`，`d.ts:6824-6827`），排在前面的 mod（比如组织的 prepend mod）可以拦截、改写或拒绝（api 页 "Reach files, processes, and the network" 一节）。
- 超时只能自己做：`Promise.race([$.http.fetch(...), $.clock.sleep(ms)])`。注意 `$.clock.sleep` 的等待时间**会**计入 hook 预算（`d.ts:3335-3337`）。jev-pilot 就是这么写的（`jev-skill-suggestion.ts:318-325`）[旁证]。

**密钥 [读]**
- 在 manifest 的 `userConfig` 里声明，值会作为 `register(on, options)` 的 `options` 传进来（`d.ts:8802`、`7314-7326`；reference 页 Files 一节）。`Stored in settings.json pluginConfigs[<plugin>].options (sensitive ones in secure storage)`（`d.ts:7318-7319`）。用 `--plugin-dir` 加载时，配置的键是 `<name>@inline`（`d.ts:7323-7324`）。jev-pilot 的三个 API key 都设了 `"sensitive": true`（`plugin.json:29,36,43`）[旁证]。
- `$.env.get` 的参数必须写成字符串字面量（`d.ts:3482-3496`）。`claude plugin validate` 会把用到的变量名列出来，管理员也能在 `plugin.register` 的 `uses.env` 里看到（`d.ts:7403-7409`）。

**hook 超时 [读]**
- `HookBudget.ms: 10_000`，`catchMs: 1_000`，`lingerMs: 5_000`（`d.ts:4927-4953`）。
- 预算只计 hook 自己的代码：`the clock stops while a next(e) call or any $ call of the hook's is in flight (a $.clock wait excepted), so a slow chain beneath or a minute-long $.model.complete costs it nothing.`（`d.ts:4920-4925`）。reference 页 Limits 表写的是 10 秒，`prompt.edit` 是 50 毫秒，所有 `session.end` hook 合计 1.5 秒。
- `prompt.submit`、`turn.start`、`agent.spawn` 没有各自单独的限制，都是这个 10 s。也就是说，等 `$.http.fetch` 或 `$.model.complete` 的时间不会触发超时，但用户在这段时间里一直在等。
- 超时或抛错时，这个 hook 被跳过，链条照常往下走。`prompt.submit` 上还有一句 `a broken plugin never blocks a prompt`（`d.ts:3980`）。

**并行 [读+测]**
- hook 就是普通的 async JS，`Promise.all` 和 `Promise.race` 都能用。文档里没有禁止并发 `$` 调用的说法。
- hook 返回之后还能在后台继续跑：d.ts 示例里用 `void (async () => { ... })()`（`d.ts:3433-3442`），也可以用 `$.clock.after` 和 `$.clock.every`。
- 实测两个子代理的 `turn.step` hook 会并发执行（`probe-events-runA.jsonl:106-107`）。所以模块级的状态要按 `agentId` 或 `turnId` 分开存。热重载会重置模块变量，需要保留的放进 `$.state` 或 `$.store`（`d.ts:3249-3315`）。

**`$.model.complete`、`classify`、`fork` [读]**
- `complete`：`Runs one text completion through the session's own API client and resolves a result`。没有工具、没有对话历史，system prompt 只有 CLI 的身份块加上你给的 `system`（`d.ts:2490-2516`）。
  - `model` 必填，可以是别名或完整 id，`resolved and allowlist-checked like a --model value`（`d.ts:5918-5922`）。
  - `maxTokens` 默认 1024，最大 64000；有 `effort`；有 `timeoutMs`（`d.ts:5930-5969`）。
  - 返回值带 `usage`（`d.ts:5982-6066`，`ModelUsage` 见 `6131`）。
  - 费用：`These calls use the user's plan or API key.`（api 页 "Call a model" 一节）。
- `classify`：`default the engine's small fast model`（`d.ts:1320-1326`、`2536-2554`）。具体是哪个模型 **UNKNOWN**，没有验证。请求失败时会 reject。
- `fork`：在主线程最近一次请求的基础上追加一个问题，复用主线程的 prompt cache，用的是主模型（`d.ts:2517-2535`）。适合需要看对话上下文的决策，但按主模型计费。

---

## 6. 其他和路由器相关的事件、API 与限制

**可用的信号：**
- `turn.step` 的结果里有这一次请求的 `usage`、`stopReason`、`toolUses`（`d.ts:12837-12865`），可以用来判断"这一轮在原地打转"然后中途调高 effort。jev-pilot 的做法是连续失败就升一档（`jev-model-router.ts:41-44`、`678-731`）[旁证]。
- `turn.complete` 有 `usage`、`durationMs`、`agentId`、`reason`（`d.ts:12627-12663`）。
- `session.measure` 在每个主线程轮次之后触发，带上下文占用、限额用量 `rateLimits[].percentUsed` 和 `cost.usd`，适合做"按预算降级"（`d.ts:4252-4263`、`10552-10578`；`SessionRateLimit` 见 `10739-10753`）。主动查询用 `$.session.usage()`（`d.ts:2723-2744`、`11157-11184`）。
- `$.session.model()`（`d.ts:2683-2685`）、`$.agent.list()`（`d.ts:3077-3085`）、`$.session.messages()`。
- `prompt.submit` 的 `origin` 能区分用户输入（本次 `-p` 下是 `{"kind":"sdk"}`，`probe-events-runA.jsonl:63`）、`peer`、`task-notification` 等。
- `$.store` 可以把决策记录持久化，跨会话共享，上限 4 MiB（`d.ts:3249-3273`）。
- `next.trace` 能看到 core 实际收到的 `e`，本文就是靠它验证改写确实生效的（`d.ts:12562-12621`）。

**限制和策略 [读]：**
- 管理员设置（reference 页 "Settings and environment variables"）：
  - `allowManagedModsOnly`：只加载组织的 mod 和内置 mod。
  - `allowManagedHooksOnly`。
  - `disableAllHooks`。
  - `disableSideloadFlags`：会拒绝 `--plugin-dir`。
  - `prependPlugins` 和 `appendPlugins`：决定 mod 在链条里的先后，以及谁能用 `next.to`。
  - `allowModsToOverrideDenyRules`。
  - 内置守卫 `sec-default@builtin`。
- 管理员的 mod 可以在 `plugin.register` 里按 `tier` 和 `uses`（比如用了 `http.fetch`）拒绝加载别的 mod（`d.ts:4276-4287`、`7336-7409`；tier 顺序 `["prepend", "user", "append", "builtin", "core"]`，`d.ts:12049`）。
- `availableModels` 白名单：会拦 `$.model.complete`（`d.ts:5919-5921`），workflow 和子代理被拦时会被换成别的模型（workflows 页 Cost 一节）。
- 组织可以用 `maxEffortLevel` 设 effort 上限（[model-config](https://code.claude.com/docs/en/model-config#organization-effort-limits)）。mod 在 `turn.step` 设一个超过上限的值时会不会被截到上限：**UNKNOWN**。
- `CLAUDE_CODE_SUBAGENT_MODEL` 对 workflow 代理的优先级高于脚本里写的 model（issue #75055 的维护者回复）。它和 `agent.spawn` hook 谁优先：**UNKNOWN**。
- 整个接口是 EARLY ACCESS，可能随版本变化（`d.ts:4`）。每次升级 Claude Code 后都要重新生成类型核对一遍。
- 和其他 mod 共存：本机已装的 jev-pilot 同样挂了 `prompt.submit, turn.step, agent.spawn, prompt.attachment, skill.prompt, tool.call` 等事件（`probe-run1.log:252`）。两个 mod 都在 user tier，同时改 effort 会互相覆盖：外层 mod 传给 `next` 的值，内层 mod 还能再改。新 mod 上线时要么停用 jev-pilot，要么约定只由一方负责改写。

---

## 7. 用 `turn.step` 设的 effort 走哪条缓存路径；Haiku 4.5 是否忽略

背景（[读]）：
- API 文档说，改顶层 `output_config.effort` 会让缓存里的 message 块失效：`Changing the output_config.effort value always invalidates message blocks`（[API prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)）。
- 在 Fable 5.1、Mythos 5.1、Opus 5.5、Opus 5、Sonnet 5.5 上，可以改用 per-message effort：带 beta 头 `mid-conversation-output-config-2026-07-01`，在 messages 里放一条 `role: "system"`、内容为空、带 `output_config.effort` 的消息，这样能保住缓存。官方原话：`The new level takes effect from the next user turn`，以及 `On Claude Sonnet 5.5 with thinking: {"type": "between_tools"}, effort can't change mid-conversation: a per-message output_config.effort that differs from the level in effect returns a 400 error.`（[effort](https://platform.claude.com/docs/en/build-with-claude/effort) 的 "Change effort mid-conversation" 一节）。
- Claude Code 文档说，在 Opus 5.5、Sonnet 5.5、Fable 5.1 上用 API key 或订阅时，`/effort` 改档 `keeps the cache`；Bedrock、Google Cloud、Claude apps gateway 上不适用（[Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching) 的 "Changing effort level" 一节）。
- d.ts 只说 `turn.step` 的 effort 可以改写（`d.ts:12793-12796`），完全没提它走哪条缓存路径。

**结论 1：行为上和 `/effort` 一样能保住缓存，YES（Opus 5.5 + 订阅，3 次实测）。请求的具体结构 UNKNOWN。**
- [测] 三次 run 里，mod 都在 index 0 设 `medium`、index 1 设 `high`。如果改的是顶层 effort，按 API 文档 index 1 的 message 块缓存应该失效。实际上 index 1 读到的缓存正好等于 index 0 的全部输入：

  | run | index 0（medium）缓存读 + 缓存写 | index 1（high）缓存读 | 证据 |
  |---|---|---|---|
  | A | 0 + 37392 | 37392 | `probe-events-runA.jsonl:124,164` |
  | B | 16940 + 18775 | 35715 | `probe-events-runB.jsonl:96,128` |
  | C | 16940 + 18655 | 35595 | `probe-events-runC.jsonl:94,128` |

  也就是整段前缀（包括 message 块）都命中了缓存。这有两种可能的解释：一是改动通过 per-message 这条能保住缓存的路发了出去；二是改动根本没发到线上，两次请求都还是会话的 `xhigh`，因为 `next.trace` 只能证明 core 收到了改动，不能证明请求里带了它。缓存计数器本身分不开这两种情况。倾向第一种的理由是：Haiku 那次 core 收到的 `low` 被引擎剥掉了，没有进请求体（见结论 2），说明 core 确实会处理这个字段，而 d.ts 也明说它可改写。
- [测] SDK 日志（`ANTHROPIC_LOG=debug`）：
  - 主循环请求的 beta 头里有 `per-turn-control-2026-07-01`、`mid-conversation-system-2026-04-07`、`effort-2025-11-24`（`probe-run4.out:37`），请求体有顶层 `output_config`（`probe-run4.out:18`）。
  - 但 beta 头里**没有** `mid-conversation-output-config-2026-07-01` 这个字面值，`per-turn-control-2026-07-01` 可能是它的内部名称或相关功能，无法确认。
  - SDK 日志把嵌套内容截断成了 `[Object ...]` 和 `[Array ...]`，看不到 `output_config` 的值，也看不到 messages 里有没有 `role: "system"` 的 effort 消息。所以"顶层值保持不变、改动通过 per-message 发出"这一点**无法直接证实**。
- 没覆盖到、仍为 **UNKNOWN** 的情况：
  - Sonnet 5.5 主循环在两个工具步骤之间改 effort 会不会 400。上面引的 API 文档说 `between_tools` thinking 下会 400，本次子代理只在第一步改过。
  - Bedrock、Vertex、gateway 上的行为。文档说那里改 effort 不保缓存；jev-pilot 在这些环境下默认整个会话只用一个 effort，见 `plugin.json:173` 的 `effortChanges` 和 `jev-model-router.ts:765-779`。
  - 两步之间改的新档位是否真的在模型端立即生效。API 文档说 per-message 改动 `takes effect from the next user turn`；core 确实收到了新值，但模型端的效果没法从这里测。
  - 跨轮改档（上一轮 `high`、这一轮 `low`）没有单独测，不过两步之间改是更严格的情形。

**结论 2：Haiku 4.5 会忽略 `turn.step` 的 effort，YES [测+读]。**
- [测] run C 里，Haiku 4.5 子代理的 `turn.step` 本来没有 `e.effort`，probe 强行传了 `effort: 'low'`。`next.trace` 显示 core 收到了 `"effort":"low"`（`probe-events-runC.jsonl:95,105,110,113`）。但实际发出的 Haiku 请求体里没有 `output_config` 这个键（`probe-run4.out:142-162`），beta 头里也没有 `effort-2025-11-24` 和 `per-turn-control-2026-07-01`（`probe-run4.out:179`）。请求返回 200，正常结束，没有报错。
- [读] 这和类型声明的说法一致：`A model that takes no effort setting is sent none, whatever is asked.`（`d.ts:6068-6074`）；`Sent as the request's effort where the model takes one and dropped where it does not, as the session's own requests do`（`d.ts:5949-5951`）；`turn.step` 的 effort 对没有 effort 的模型是缺省的（`d.ts:12793-12794`）。

---

## 设计含义（给路由 mod 的建议）

1. 主循环只在 `turn.step` 上改 effort，每一步都重新设，不碰 `model`。在 Opus 5.5 或 Sonnet 5.5 加订阅或 API key 时，可以按轮甚至在两步之间调；在 Bedrock、Vertex 或 gateway 上，整个会话固定用一个档位（参考 jev-pilot 的 `effortChanges`）。
2. 决策放在 `prompt.submit` 里做（这里能拿到用户原文和 `$.session.messages()`），只处理用户自己输入的 origin，结果在本轮第一次 `turn.step` 时应用。外部调用用 `Promise.race` 自己加超时，失败就放行。
3. 子代理在 `agent.spawn` 改 model，记下返回的 `agentId`，再在它的 `turn.step` 上改 effort。workflow 代理只能在 `turn.step` 上处理，判断依据只有脚本本身。
4. skill：用 `prompt.attachment` 把 `skill_listing` 固定删掉或裁短（回答要稳定）；用 `prompt.submit` 的 `context` 按轮注入选中的 SKILL.md；排除 `disable-model-invocation` 的 skill。不要每轮改 `prompt.section`。
5. 不要和 jev-pilot 同时启用，否则两边会在同一批事件上互相覆盖。

## 复现

1. 建 `probe-mod/.claude-plugin/plugin.json`（`name: "probe-mod"`）、`hooks/hooks.json`（`{"modules":["./probe.mjs"]}`），`hooks/probe.mjs` 导出 `register(on)`。
2. 运行 `command claude -p "say ok" --plugin-dir ./probe-mod`，会生成 `.claude-plugin/types/claude-code/index.d.ts`。
3. 本次的 probe 挂了 `session.start`（在里面调用 `$.config.list`、`$.command.list`、`$.tool.list`、`$.prompt.compose`、`$.session.usage({ breakdown: 'summary' })`）、`prompt.submit`、`prompt.context`、`prompt.section`、`prompt.attachment`、`turn.start`、`turn.step`（`async function*`，按规则改 effort，并记录 `next.trace` 里每一层收到的 `effort` 和 `model`）、`agent.offer`、`agent.spawn`（改 model）、`tool.call`（一个 matcher 是 `Agent|Workflow|Skill`，另一个匹配全部）、`skill.prompt`、`turn.complete`、`session.end`。每个事件都用 `$.fs.write` 追加写入 JSONL。
4. 每次运行都加 `--settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}' --debug-file <log>`。Workflow 那次需要 `--allowedTools "Workflow,Agent"`。想看请求结构就加环境变量 `ANTHROPIC_LOG=debug`，并把 stdout 和 stderr 一起重定向到文件。

---

## 8. Workflow 拦截细节

本节回答 dispatch-pilot 设计里关于 Workflow 的四个问题。[测] 表示 2.1.289 上用 probe-mod2 实测过，[读] 表示只读了类型声明或文档。测试 mod 在 scratchpad 的 `probe-mod2/hooks/probe.mjs`，日志是 `p2-deny.jsonl`、`p2-rewrite.jsonl`、`p2-model.jsonl`（都在 scratchpad 里，会被清理）。每次运行都是 `command claude -p ... --plugin-dir ./probe-mod2 --settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}' --allowedTools "Workflow" --model sonnet`。

### 8.1 `agent(prompt, opts)` 的选项：有 `effort`，YES

[读] 内置 skill `workflow-authoring`（用 Skill 工具加载，`/workflow-authoring`，文档说明见 [workflows](https://code.claude.com/docs/en/workflows) 的 "Edit a saved script" 一节）给出的签名是：

`agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string, effort?: string, isolation?: 'worktree', agentType?: string})`

- `effort`：`'low' | 'medium' | 'high' | 'xhigh' | 'max'`。不写就继承会话 effort。skill 原话建议 `'low'` 用于便宜的机械阶段，高档只给最难的 verify/judge 阶段。
- `model`：覆盖这次调用的模型。skill 建议默认不写。
- `label`（显示名）、`phase`（进度分组）、`schema`（JSON Schema，强制结构化输出）、`isolation: 'worktree'`、`agentType`（用自定义子代理类型，和 Agent 工具同一个注册表）。
- 官方 workflows 页公开示例只出现 `schema`、`label`；"Prompt caching in a fan-out" 一节提到缓存前缀由 model、effort、agent type、tools、output schema、cwd 决定，间接印证 `effort` 和 `agentType` 存在。
- `claude-code-tools/index.d.ts` 里的 Workflow 输入 schema 只是 `script`/`name`/`args`/`scriptPath`/`resumeFromRunId`（`tools.d.ts:717-732`），没有 `agent()` 选项的信息，选项只在上面这个 skill 里。
- [测] 脚本里写 `{ effort: 'low', label: 'alpha' }` 后，该代理在 `turn.step` 看到的 `e.effort` 是 `"low"`，没写的基线是 `"medium"`（`p2-rewrite.jsonl` 的 step 行，对比 `p2-model.jsonl`）。所以 `effort` 选项确实生效。

另外：workflow 代理选模型的顺序和子代理相同，脚本里的 `model` 只是单次调用指定的 model（workflows 页 Cost 一节）；环境变量 `CLAUDE_CODE_SUBAGENT_MODEL` 优先级更高（见第 3 节引的 #75055）。

### 8.2 `tool.call` 对 Workflow 看到什么，能不能拒绝、改写：全部 YES [测]

- `e` 的键 [测]：`["script","tool","tool_use_id"]`（主模型传 inline `script` 时；`p2-deny.jsonl:1`）。类型上还有 `name`、`args`、`scriptPath`、`resumeFromRunId`、`description`、`title`（`tools.d.ts:717-732`）。`scriptPath` 优先于 `script` 和 `name`（`tools.d.ts:728`），所以 mod 必须三种来源都处理：`script` 直接解析；`scriptPath` 用 `$.fs.read` 读文件；`name` 的命名工作流要自己解析 `.claude/workflows/` 或插件目录（未测）。
- (a) 拒绝 [测]：返回 `{ deny: '...' }`。主模型会收到这段文字作为工具错误并读到它（`p2-deny.jsonl:2`；主模型回复里复述了 "要求给 alpha 和 beta 加上 `effort: "low"`"）。类型依据 `ToolCallResult.deny`：`Refuses the call: the model receives the text as an error result`（`d.ts:12139-12144`）。
  - 注意 [测]：我的测试 prompt 写了"脚本原样运行，不要改动"，主模型因此**没有**重新提交，还说"这个要求来自工具返回的错误信息，不是你的指令"，转而问用户。就是说 deny 理由会被当作不可信的工具输出，不一定被执行。真实场景里用户没有写"不许改"，通常会重写，但 deny 文案要写成明确的修改指令，并说明这是 mod 的策略，别让模型当成注入。这一条没有测"用户没禁止改写"的情形。
- (b) 静默改写 [测]：`next({ ...e, script: newScript })`。我用正则把每个 `{ label: ` 换成 `{ effort: 'low', label: `，代理确实以 `effort: "low"` 运行，Workflow 正常完成并返回 `["ok","pong"]`（`p2-rewrite.jsonl:2-3`）。`tool`、`tool_use_id`、`agentId` 是保留字段，改了会被拒（`d.ts:12100-12101`）。
- 改写的代价：主模型和用户不会知道脚本被改了（Workflow 结果里的持久化脚本是哪一份，没有检查）。`resumeFromRunId` 按 `(prompt, opts)` 匹配缓存（`tools.d.ts:730`），改写 opts 后用同一规则改写才能保持缓存命中。

### 8.3 workflow 代理的 `agentId` 能不能对回 `agent()` 调用：能对回 label，YES [测]

- 没有 API 暴露 [读]：`$.agent.list()` 不含 workflow 代理（`d.ts:3081-3083`），`AgentLoop.agentId` 说明里写 `A workflow's agents ... carry ids no list names`（`d.ts:201-203`），`$.session.messages({ agentId })` 读不到（`d.ts:10669`、`10697`）。`BackgroundTaskSummary` 只有工作流任务一行（`type: 'workflow'`、`name`、`description`，`d.ts:742-773`），没有逐代理明细。`agent.spawn` 不触发，所以 `prompt` 和 `description` 拿不到。
- **磁盘上有** [测]：每个 workflow run 在 `~/.claude/projects/<项目目录>/<sessionId>/subagents/workflows/<runId>/` 下写：
  - `journal.jsonl`：`{"type":"started","key":"v2:<hash>","agentId":"...","label":"alpha"}`，结束时有 `{"type":"result",...,"result":"ok"}`。
  - `agent-<agentId>.jsonl`：这个代理的完整 transcript，第一条 user 消息就是任务 prompt，前面带 `[Workflow harness — computed task]` 的框架文字。
  - `agent-<agentId>.meta.json`：`{"agentType":"workflow-subagent","description":"probe","model":"sonnet",...}`。
- [测] 在 `turn.step` 里（`e.index === 0` 时就已经有）用 `$.fs.list` 和 `$.fs.read` 读 `journal.jsonl`，按 `e.agentId` 找到 `started` 行，拿到 label（`p2-rewrite.jsonl:3,5`：`agentId a5792f5d9d3c3c0de -> alpha`，`ab6bc7c7c363a77ab -> beta`；`p2-model.jsonl` 同样）。`started` 行在 index 0 的 step 之前写好。
- 没测 / UNKNOWN：index 0 时 `agent-<id>.jsonl` 里的 prompt 是否已落盘（label 已够用，所以没查）；`journal.jsonl` 只有 label，没有 `phase`，phase 要从脚本解析（或 label 自带）。
- 要点：label 不写时 journal 里 label 是什么没测（官方示例 `label: file`；文档说 `opts.label` 覆盖显示名）。dispatch-pilot 的映射应该是：在 `tool.call` 里解析 `script`，给每个 `agent()` 建 `label -> 推荐 {model, effort}` 表，`turn.step` 时用 journal 的 label 查表。要求脚本里 label 唯一且是字符串字面量；动态 label（模板字符串，pipeline 里的 `file`）要么拒绝要求改成可枚举的，要么只能在 `tool.call` 阶段处理。更稳的做法是在 `tool.call` 阶段直接改写脚本，不依赖 `turn.step` 反查。

### 8.4 `turn.step` 在 index 0 改 workflow 代理的 model：YES [测]

`next({ ...e, model: 'claude-haiku-4-5' })` 对 `agentId` 非空且 `index === 0` 的 step 生效：`sentModel` 是 haiku，`step.result` 的 `usage.model` 是 `claude-haiku-4-5-20251001`，原始 `e.model` 是 `claude-sonnet-5-5`（`p2-model.jsonl:3-6`）。Workflow 照常完成。没有测的：是否破坏缓存或工具定义（换模型后第一次请求本来就是新缓存，但 workflow 内同批代理的前缀共享会因为 model 不同而分开，这点来自 workflows 页的缓存说明，[读]）；`turn.step` 的 model 字段是整个步骤的模型，要保证 index 0 之后各步一致，所以每一步都要用同一个查表结果改，不能只改 index 0（`model` 不是 pinned，`d.ts:12787-12796`）。

### 8.5 对 dispatch-pilot 的结论

| 做法 | 可行性 | 备注 |
| --- | --- | --- |
| `tool.call` deny 并给出每个 agent 的推荐 model/effort | 可行 [测] | 模型可能把理由当不可信输出；文案要写成明确的重写指令 |
| `tool.call` 里 `next({...e, script})` 静默改写 | 可行 [测] | 不需要主模型配合；要处理 `scriptPath`、`name` |
| `turn.step` 按 label 改 model/effort | 可行 [测] | label 来自 `journal.jsonl`；effort 和 model 都已验证能改 |
| 拿 workflow 代理 prompt 全文 | 只能解析脚本，或读 `agent-<id>.jsonl` | 后者的落盘时机未测 |

推荐顺序：先 deny 一次让主模型自己改（透明、可审计）；若主模型不改，再用 `tool.call` 改写或 `turn.step` 兜底。
