# 参考 mod 调研：jev-pilot 与 jev-skill-suggestion

调研日期 2026-10-04。路径缩写：`J` = `/Users/alexnear/.claude/plugins/cache/jev-pilot/jev-pilot/0.12.1`（本机已装，版本 0.12.1，与 GitHub tag `jev-pilot--v0.12.1` 同源，仓库 https://github.com/Akramovic1/jev-pilot）。`P2` = https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/productivity/jev-skill-suggestion（本地副本在会话 scratchpad，内容取自 raw.githubusercontent.com 同路径，共 7 个文件：`.claude-plugin/plugin.json`、`commands/setup.md`、`hooks/hooks.json`、`hooks/jev-skill-suggestion.ts`、`hooks/policy.ts`、`tests/policy.test.ts`、`README.md`，已全部读完）。平台文档：https://code.claude.com/docs/en/plugins/mods/overview 与 https://code.claude.com/docs/en/plugins/mods/reference 。

关系：jev-pilot 自述 "Built on claude-code-templates' jev-model-router and jev-skill-suggestion"（`J/.claude-plugin/plugin.json` description），即 P2 是 jev-pilot 技能部分的祖先；`J/docs/model-router.md:1` 也明说该文档是 davila7 `jev-model-router` 的原文。

---

## 一、jev-pilot

### 1. 是 mod 还是 settings hook

纯 mod，只有函数 hook，没有 shell/http 型 settings hook。
- `J/hooks/hooks.json` 全文：`{"description": "...", "modules": ["./jev-pilot.ts"]}`，只有 `modules` 一个入口。
- `J/hooks/jev-pilot.ts:1-9`：注释 "Claude Code loads a single hooks module per plugin, so this entry registers both mods on the same `on` and the same options"，再 `registerModelRouter / registerSkillSuggestion / registerPet / initFeatures / initCrew`（`jev-pilot.ts:19-39`）。
- 注意：一个插件只加载一个 hooks 模块；同一事件上多个 hook 靠"matcher 不同"共存（见 `jev-model-router.ts:964-966` 注释："one unmatched hook per plugin"，所以第二个模块用 `{ sessionId: /(?:)/ }`、`{ text: /(?:)/ }` 之类全匹配 matcher）。这是设计自己 mod 时的坑。

使用的事件（精确名称，均来自 `on('...')`）：
- `session.start`（`jev-model-router.ts:388`，`jev-pet.tsx:95`，带 `{cwd:/(?:)/}`）
- `prompt.submit`（`jev-model-router.ts:418`；`jev-skill-suggestion.ts:274`，带 `{text:/(?:)/}`）
- `prompt.attachment`，matcher `{ type: 'skill_listing' }`（`jev-skill-suggestion.ts:224`）
- `turn.start`（`jev-pet.tsx:308`）
- `turn.step`（`jev-model-router.ts:628`，generator 形式 `async function* ($, e, next)`；`jev-pet.tsx:328`）
- `tool.call`（`jev-model-router.ts:875`；`jev-pet.tsx:343`）
- `turn.complete`（`jev-model-router.ts:905`；`jev-pet.tsx:356`）
- `agent.spawn`（`jev-model-router.ts:1020`）
- `skill.prompt`，matcher `{skill:'jev-pilot:report'}` / `{skill:'jev-pilot:setup'}` 与无 matcher 观察版（`jev-model-router.ts:996`；`jev-skill-suggestion.ts:619,692`）
- `session.end`、`session.compact`（`jev-model-router.ts:966,988`；`jev-skill-suggestion.ts:597,609`）
- `command.run`，matcher `{command:'jev'}`（`jev-pet.tsx:180`）
- `ui.render`，matcher `{component:'AbovePrompt'}`（`jev-pet.tsx:371`）

用到的 `$` API（从源码可见）：`$.http.fetch`、`$.clock.sleep/now/every/after`、`$.ui.log/status/invalidate/resolve`、`$.session.messages/cwd`、`$.fs.read/write/exists/list`、`$.env.get`、`$.store.get/set/delete`、`$.process.run`、`$.model.classify`、`$.command.list/register`、`$.agent.register/list`、`$.tool.list`。

### 2. 主对话每轮 reasoning effort 怎么设

机制：在 `turn.step`（每个发给模型的请求前触发）里改写事件字段 `effort`，`return yield* next({ ...e, ...change })`（`jev-model-router.ts:867`）。平台文档对 `turn.step` 的说明是 "One request is about to go to the model … `yield* next(e)`, or `next({ ...e, model })`, `next({ ...e, effort })`"（reference 页）。

流程：
1. `prompt.submit` 先分类（调 Jev，见第 6 点），决策放进 `pending` 槽（`jev-model-router.ts:530`），并不在此处改 effort。
2. 本轮第一个 `turn.step`（`e.index === 0` 或 turnId 变化）取出决策：`pending.take()`（`:750`）→ `route(decision, {model:e.model, effort:e.effort}, policy, ...)`（`:753`，实现 `J/hooks/model-router.policy.ts:748-833`）→ `if (routeMainEffort() && routing.effort) change.effort = routing.effort`（`:777`）。
3. 本轮后续请求复用 `applied`，不再变（`:678-741`，`return yield* next(applied ? {...e, ...applied} : e)`）。
- 档位：`EFFORT_ORDER = ['low','medium','high','xhigh','max']`（policy `:179`）。Jev 回答一个 `effort` choice，每档配一句"什么任务需要它"（`EFFORT_RUBRIC` policy `:202-208`）；对概率分布做"接近平局取高档"（`effortCloseMargin`，默认 0.15）；升档要置信度 ≥ `minUpgradeConfidence`(0.3)，升到 high 以上要 ≥ `minHighConfidence`(0.5)，降档要 ≥ `minDowngradeConfidence`(0.6)；起始上限 `maxEffort` 默认 xhigh，且 xhigh/max 合计概率要 ≥ `VERY_HARD_CONFIDENCE=0.6`（policy `:513, :528-559`）；`risky>0.7` 强制 deep + 至少 high。短跟进（≤8 词的非疑问句）只许升不许降（`isFollowUp`，policy `:287`）。
- 缓存保护：Bedrock/Vertex/网关上改 effort 会清缓存，`effortChanges: auto` 时首轮 effort 整个会话固定（`effortClearsCache`，policy `:1230`；`jev-model-router.ts:765-779`）。
- 是否同时改 model：能，但默认关。`routeMainModel`（默认 false）开启时同一个 `turn.step` 里 `change.model = requestModelId(routing.model, ids)`（`:758-764`），因为主循环的 model 会原样发给 API，别名要换成引擎见过的完整 id（`ids.learn(e.model)`，`:638`）。关闭理由：切模型会使 prompt cache 失效（`jev-model-router.ts:17-19`、plugin.json `routeMainModel` 描述）。
- 在 `turn.step` 里 `if (e.agentId)` 分支处理子 agent 的请求，主循环逻辑只在无 `agentId` 时走（`:654, :673`）。

"工具连续失败就升一档"：
- `tool.call` 观察：`const result = await next(e)`，仅主循环（`!e.agentId`）且非被拒（`!result.deny`）时，`failedInARow = result.isError ? failedInARow + 1 : 0`（`:875-880`）。用户拒绝权限不计数也不清零。
- 下一次 `turn.step`（同一 turn，`e.index>0`）里：若 `failed >= escalateAfterErrors`（默认 2）或"原地打转"（`spinOf`：同一文件改 4 次 `SPIN_EDITS`，同一命令失败 3 次 `SPIN_RUNS`，policy `:1172-1204`），则本 turn 只升一次（`escalatedTurnId`）：再向 Jev 重新分类一次，请求 state 里带 `trouble: "<n> tool calls in a row have failed while working on this request"`（`:696-708`），然后 `escalate(effort, failed, escalateAfterErrors, level, raisedCeiling)`（policy `:1028-1044`）：至少升一档、可按新读数再高、不超过 `maxRaisedEffort`（默认 max），数值型 effort 不动。结果写入 `applied.effort`，之后该轮其余请求都用新档（`:712`）。`maxEffort`(起始上限 xhigh) 与 `maxRaisedEffort`(升档上限 max) 分开：max 只能靠中途升档到达。
- 同时往工具结果里追加 `stepBackNote`（`tool.call` 返回 `{...result, context:[...result.context, note]}`，`:897`），让模型换思路。
- `holdEffort` 为真（云/网关）时不做中途升档（`:679` 条件 `!holdEffort`）。

### 3. 子 agent 的 model 与 effort

- model：`agent.spawn`（`jev-model-router.ts:1020-1175`）。字段：`e.prompt, e.description, e.subagentType, e.model, e.parentModel, e.fork`，返回 `next({ ...e, model })`（`:1168`）。平台文档 `agent.spawn`："`next({ ...e, model })` to choose its model, or `{ deny: reason }`"，只开放 model。
  - 对子 agent 的 brief 单独调一次 Jev：state = `{ prompt: e.prompt, description: e.description, agentType: e.subagentType }`，不带对话上下文（`:1100-1109`，注释 "A subagent's brief is self-contained by design: no conversation added"），不问 strategy（`withStrategy=false`）。
  - 尊重主 agent/用户指定的 model：`const named = e.model ?? null; ... if (named) { model = null; reason = "the caller named ..." }`（`:1085, :1142-1144`），即不覆盖；`fork` 子 agent 直接放行（`:1036`，"A fork inherits its parent's model"）。但 quality 模式且未指名时一律 deep（opus）（`:1088`）。降档需 `minDowngradeConfidence`，升档 `minUpgradeConfidence`（同 route）。
  - 特例：reviewer（codex/opencode）强制 fast tier，junior 子 agent 走自定义 slot 或 balanced（`:1058-1081`）。
- effort：Agent 工具本身没有 effort 参数（源码注释 `jev-model-router.ts:26-27`），所以在 `agent.spawn` 里只把决策存进 `subagents` Map（key 是 `result.agentId`，`:1170-1172`），然后在该子 agent 的**第一个 `turn.step` 请求**（`e.agentId` 有值）里设：`route(known.decision, {model:e.model, effort:e.effort}, policy)` → `effort = routing.effort`，缓存在 `subagentEffort`，之后每个请求 `next({ ...e, effort })`（`:654-672`）。引擎没给 effort 的模型（`e.effort === undefined`）保持不动（`:659`）。开关 `routeSubagentEffort`（默认 true，从属于 `routeSubagentModel`）。子 agent 用的 effort 问题措辞不同（`SUBAGENT_EFFORT_INSTRUCTIONS`，policy `:270`：已写明文件/步骤/测试的 brief 属于"执行"而非设计）。低 effort 且会改代码的 brief 追加 `CHECK_AT_LOW` 句子（`:1165-1167`）。
- 两个新点：model 在 spawn 时设（可保留别名），effort 在后续 turn.step 时设。这说明 effort 对子 agent 要靠 turn.step 而非 agent.spawn。

### 4. Workflow 工具的 agent()

源码原话：
- `J/hooks/crew.ts:657-662`：`// Workflow agents never pass the Agent tool, so jev-pilot can't route them: // the script sets each one's model (agent(prompt, { model })).` 以及注入给主模型的提示 `"Agents a Workflow script starts (agent()) don't pass through jev-pilot, so choose each one's model in the script with opts.model: 'haiku' for searching, reading and reporting, 'sonnet' for ordinary well-specified work, and leave it out for work that needs judgment."`
- `J/README.md:297`："**Workflows.** Agents a workflow script starts don't go through the Agent tool, so jev-pilot can't pick their model the way it does for subagents. Instead, the note Claude gets tells it to set each workflow agent's model in the script (`opts.model`)..."
- `J/CHANGELOG.md:83`："Workflow agents don't pass the Agent tool, so jev-pilot couldn't route them: in budget mode a workflow's agents ran on Opus."
- 另见 `model-router.policy.ts:972` "(workflow scripts are the exception, see below)"：对主模型说"别在 Agent 调用里钉 model，但 workflow 脚本例外"。

结论：jev-pilot 作者陈述的是"平台行为"，即 workflow 里的 agent() 不走 Agent 工具，因而 jev-pilot 的路由拿不到；它的应对是**改提示**（让主模型在脚本里自己写 `opts.model`），不是 hook 里补救。平台文档里 `agent.spawn` 的说明只写 "A subagent or an agent team teammate is about to start"，没有明确说 Workflow 的 agent() 触发或不触发该事件。所以"workflow agent 不经过 `agent.spawn`"这件事只有 jev-pilot 作者的实证说法（他在 changelog 里有实测：custom model 在 workflow 里生效），官方文档里无法确认是平台限制还是别的原因；jev-pilot 自己并未区分，更偏"平台没触发，被迫绕行"，不是它主动的设计选择。需要自己的 mod 做这件事时应实测 `agent.spawn` 是否对 workflow agent 触发。

### 5. 怎么"附上一个请求需要的 skill"

注入的是**完整 SKILL.md 正文**（默认 `inject: "content"`），不是列表条目；也可选 `"suggest"` 仅给名字。
- 挑选：`prompt.submit`（`jev-skill-suggestion.ts:274-592`）调决策模型（Jev），一次请求里有一个 `which` choice，选项是所有候选 skill，criterion = 描述（+ 默认前 300 字符的 SKILL.md 摘要 `excerptChars`），外加 `(none)` 选项（`NO_SKILL`，policy-skill `:509`）；`rerank: false` 默认只一次请求，`true` 时再发第二次请求重读前 3 名并能全部否决。三个 gate noul（`acts_on_user_system`、`would_follow_documented_procedure`、`prose_suffices`，`:408-415`）均值低于 `gateThreshold` 0.3 则不推荐；`pickSkill`：首选概率 ≥ `SURE_PICK=0.5` 直接采纳，否则需过 gate 且 ≥ `fitsThreshold`（`:533-553`）。
- 注入块：`injectionBlock`（`J/hooks/skill-suggestion.policy.ts:358-393`）生成
  `<skill_relevance> Relevant to the current request: <name>. Ignore this if it does not fit... Its instructions follow: follow them now ... Do not load it with the Skill tool ... <skill name dir> ...body (frontmatter 去掉，${CLAUDE_SKILL_DIR}/${CLAUDE_PROJECT_DIR} 替换)... </skill> </skill_relevance>`；通过 `next({ ...e, context: [...(e.context ?? []), ...blocks] })` 追加到 prompt（`jev-skill-suggestion.ts:589-591`）。同一会话已注入过的 skill 只再提名字（`injected` Set，`/clear`、`session.end`、`session.compact` 时清空）。找不到文件则退化为"用 Skill 工具加载"的指示。
- SKILL.md 读取：自己在磁盘上按 Claude Code 布局找（项目与用户 `.claude/skills`、`.claude/commands`、`~/.claude/plugins/installed_plugins.json` 的 installPath、`~/.claude/skills/synced/<account>`，`fileOf` `:342-383`），用 `$.fs.exists/read`。`disable-model-invocation: true` 的 skill 永不选（`modelInvocable`）。
- 是否从正常 listing 隐藏：是。`prompt.attachment`，`{type:'skill_listing'}` 里 `return { text: kept }`，`kept = trimListing(e.text, alwaysListed)` 为 null 即整段去掉（"Answered without `next`: the engine's text never reaches the model"，`:254-268`）。子 agent 的 listing 不动（`if (e.agentId) return next(e)`，`:233`）。开关 `hideListing`（默认 true）、`suggestSkills`（默认 true，`/jev skills off` 实时关）。
- 进一步用 `/jev-pilot:setup` 让模型自己把所有 skill 设成 `user-invocable-only`（写 `~/.claude/settings.json` 的 `skillOverrides`，并设 `disableBundledSkills: true`），这样 `/context` 也计为 0（`J/commands/setup.md`，`skill.prompt` 里改写 prompt，`jev-skill-suggestion.ts:619-690`）。因为 mod 直接注入正文，所以即使 Skill 工具会拒绝 user-only skill 也能用。
- 候选来源：`$.command.list()`（非 listing，因为 listing 在 turn 首个请求才渲染，晚于 `prompt.submit`，`jev-skill-suggestion.ts:43-47`）；`inject=content` 时不受 listing 限制（`catalog(commands, injectContent ? new Set() : listed, neverSuggested)`，`:415`）。

### 6. 决策模型 / API

- 模型：TypeSafe 的 Jev（System One 决策模型：状态进，类型化选择+概率分布出，无自由文本）。四个后端，`provider: auto` 优先级 typesafe > openrouter > gateway > builtin（`policy:235-249`）。
  - typesafe：`POST https://api.typesafe.ai/v1/systemone`，model `jev-latest`
  - openrouter：`POST https://openrouter.ai/api/v1/systemone`，model `~typesafe/jev-latest`，另带 `http-referer`、`x-openrouter-title`、`x-title`
  - gateway：`POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`，model 放 header `ai-model-id: typesafe-ai/jev`，另有 `ai-gateway-auth-method: api-key`、`ai-gateway-protocol-version: 0.0.1`、`ai-evaluation-model-specification-version: 4`，无校准 confidence
  - builtin：`$.model.classify(input, labels)`，只返回一个标签，无置信度、无 strategy、无 gate、无 rerank（`jev-model-router.ts:603-625`）
  (`model-router.policy.ts:210-256, :381-402`)
- 请求体（typesafe/openrouter）：`{"model": ..., "state": {...}, "questions": {...}}`；gateway 去掉 `model`（`policy:356-371`）。认证：`authorization: Bearer <key>`，key 来自 `userConfig`（`typesafeApiKey` / `openrouterApiKey` / `gatewayApiKey`，均 `sensitive:true`，`plugin.json`），经 `register(on, options)` 的 `options` 读取，不读环境变量（源码注释 "Never hardcode it in this file"）。
- 响应：`{"answers": {"<question>": {choice, probabilities, confidence | noul | probability}}}`，`readDecision`（`policy:424-481`）解析；confidence 缺失时取分布最大值；无法解析即视为失败。
- 每轮问题：`tier`(choice: fast/balanced/deep)、`effort`(choice 5 档)、`risky`(noul)，可选 `strategy`(choice: direct/delegate/parallel/graph…)、quality 四个 noul(`corrects/underspecified/sensitive/bugfix`)，以及 skill 模块追加的 `which`、`gate::*`、`ui_design`。
- **一次请求合并**：router 先 `offerPart` 把自己的问题挂起，skill 模块的 `prompt.submit`（嵌在 router 内层）`takePart` 后把两套问题合进同一个请求（`J/hooks/jev-call.ts:1-19`，`jev-skill-suggestion.ts:453-470`）。没人接手则 router 自己发（`jev-model-router.ts:599`）。
- 发送上下文：主对话 `state = { prompt, recent_context, signals, project_platforms? }`（`jev-model-router.ts:576`）。`recent_context` 来自 `$.session.messages()`，最近 `contextMessages`=4 条、总计 `contextChars`=2000 字符，只含文本与工具名，不含工具输入输出（plugin.json `contextMessages` 描述；`context.ts`）。`project_platforms` 是对 cwd 及一层子目录做 `$.fs.list` 得到的文件名推断（Vercel/Supabase 等，只看名字，不读内容，`:557-575`）。skill 单独请求（没 router part 时）state 是 `{ request, recent_context }`（`skill-suggestion.policy.ts:590`）。子 agent：`{prompt, description, agentType}`。
- 超时：`timeoutMs` 默认 1500，用 `Promise.race([$.http.fetch(...), $.clock.sleep(timeoutMs)])`（`jev-model-router.ts:145-152`）。README 称典型 ~0.5s，实测中位 540ms、p90 910ms、97% 的轮次有答复（`J/README.md:354, :443`）。
- 缓存：没有结果缓存。仅有：`lastDecision` 供"continue/keep going/继续"这类续接提示直接复用（`isContinuation`，`jev-call.ts:91`），SKILL.md 文件每会话读一次（`files` Map），平台识别每个 cwd 一次，`prompt.attachment` 对同一会话总是同样回答以保护 prompt cache。
- 失败降级：全部 fail-open。超时/非 2xx/抛异常/无法解析 → 返回 `{decision:null}`，请求按引擎原样发出。`429/502/503/529` 视为 busy（只在 verbose 记日志），其他状态才记错误（`missOf`，policy `:1001`）。无 key 或强制 provider 缺 key 时降级到 builtin 并只提示一次。置信度缺失（gateway/builtin）可以升不能降。
- 隐私：有 key 时 prompt、最近上下文、候选 skill 名称与描述、前 300 字符的 SKILL.md 摘要发给对应后端。

### 7. 配置面 / UI / 日志 / 测试

- userConfig（`J/.claude-plugin/plugin.json`，约 50 项）：密钥与后端（`typesafeApiKey/gatewayApiKey/openrouterApiKey/provider/*BaseUrl/*Model`）、tier 模型别名（`fastModel=haiku/balancedModel=sonnet/deepModel=opus`）、各置信度阈值、`routeSubagentModel/routeSubagentEffort/routeMainEffort/routeMainModel`、`maxEffort/maxRaisedEffort/escalateAfterErrors/effortChanges`、`contextMessages/contextChars`、strategy 与 graph 相关、`timeoutMs`、`display`(pet|transcript|both|off)、`logDecisions/verboseLog/recordDecisions`、skill 相关（`inject/hideListing/suggestSkills/rerank/shortlist/gateThreshold/fitsThreshold/excerptChars/alwaysListed/neverSuggested`）、`qualityAdvice/designPack/designSkills`、crew（`mode/alpha|beta|gammaModel/*When/junior/reviewer`）。安装时 `claude plugin install jev-pilot@jev-pilot --config openrouterApiKey=... --config timeoutMs=1500`（`J/README.md:83`）。
- slash command：`/jev`（用 `$.command.register({name:'jev', argumentHint, immediate:true})` 在 `session.start` 注册，`command.run` 处理，`jev-pet.tsx:98-105,180`）。子命令：无参显示所有开关；`<feature> on|off`，feature ∈ `effort|raise|subagents|skills|strategy|quality|design|model|pet`（`features.ts:9-24`）；`all on|off`、`reset`、`status`、`mode <name>`、`alpha|beta|gamma <model>`、`junior`、`reviewer`、`tune [apply|reset]`。开关覆盖值存 `$.store`（`FEATURES_KEY`）跨会话保留。另有 markdown 命令 `/jev-pilot:setup`、`/jev-pilot:report`，其文案只是占位，真正的 prompt 由 `skill.prompt` hook 在运行时重写（`commands/*.md`）。
- UI：`ui.render` 的 `AbovePrompt` band 画"驾驶员宠物"（Box/Text + 边框气泡，`jev-pet.tsx:371-405`，用 `$.ui.resolve(e)` 取 Box/Text，TSX），随 turn 状态动画（think/write/read/search/edit/fly），用 `$.clock.every` 定时 `$.ui.invalidate('ui.render')`；仅 `e.surface === 'terminal'` 且无 survey 时绘制。另有 `$.ui.status(...)` 常驻状态行，`$.ui.log(...)` 把一行写进 transcript（`display: transcript|both`），例如 `jev · low (93% sure) · no skill · 1.3s`（`J/README.md:239`）。没有看到 toast API 的使用。
- 日志：`logDecisions`（总开关，错误始终输出）、`verboseLog`（每一步）。`recordDecisions` 把每轮决策与结局（effort、升档、失败数、token，不含 prompt 文本）写入 `$.store` 的 ledger（`ledger.ts`，`LEDGER_KEY`），`/jev-pilot:report` 汇总并给出调参建议，`/jev tune` 可应用。
- 测试：两层。`bun test`（`tests/*.spec.ts`，`bunfig.toml` 设 `root="tests"`，纯函数/policy 单测）；`claude plugin test .`（`engine/*.test.ts`，在 Claude Code 自身引擎里跑 hook，用 `import { expect, mock, test } from 'claude-code/testing'`，`mock.clock/env/store`，`$.turn.step`、`$.tool.call`、`$.ui.mount` 等，见 `J/engine/turn.test.ts:1-70`）。CI：`J/.github/workflows/test.yml`（bun test、`bash -n` 检查脚本、plugin.json 与 marketplace.json 版本一致）。另有 `bench/`（10 个任务的基准）。
- 其他：`bin/claude-jev` 启动器与 `router/jev-router.mjs`（本地代理，把 `jev-<slot>` 请求转 OpenRouter，用于自定义模型），属于 jev-pilot 额外功能，与设计 mod 无直接关系。

---

## 二、jev-skill-suggestion（P2）

### 形态
mod，纯函数 hook：`P2/hooks/hooks.json` 为 `{"description": "...", "modules": ["./jev-skill-suggestion.ts"]}`。事件：`prompt.attachment`（`{type:'skill_listing'}`）、`prompt.submit`、`session.end`、`session.compact`、`skill.prompt`（`{skill:'jev-skill-suggestion:setup'}` 与无 matcher 观察版）。无 turn/agent/ui.render hook，无宠物 UI。README 的 `claude --debug` 样例显示加载日志 "events: prompt.attachment,prompt.submit,skill.prompt"（`P2/README.md` "No lines at all" 一节）。

### 5. 怎么附 skill
同 jev-pilot（jev-pilot 由它演化而来）：默认 `inject: "content"`，把选中 skill 的 SKILL.md 正文（去 frontmatter，替换 `${CLAUDE_SKILL_DIR}`/`${CLAUDE_PROJECT_DIR}`）放进 `<skill_relevance>` 块，经 `next({ ...e, context: [...(e.context ?? []), block] })` 追加到 prompt（`P2/hooks/jev-skill-suggestion.ts:453-473`，`policy.ts` `injectionBlock`）。`inject: "suggest"` 只给名字，由模型用 Skill 工具加载；此时 `hideListing:false` 还会在无推荐时发 "No skill in the roster appears relevant to this request."（README "How it works"）。
选择：TypeSafe cookbook 的**两次请求**（https://docs.typesafe.ai/cookbooks/skill_suggestion，README 称 182 skill 上错误加载 16.8%→7.3%、无谓加载 9.8%→4.0%）：
- 请求 1：`which` choice（全部候选，criterion=单行描述）+ 3 个 gate noul（`acts_on_user_system`、`would_follow_documented_procedure`、`prose_suffices`），均值 < `gateThreshold` 0.3 则不推荐。
- 请求 2（`rerank` 默认 **true**）：前 `shortlist`=3 个，criterion=frontmatter 描述 + SKILL.md 前 `excerptChars`=**700** 字符，每个候选再问一个 `fits::<name>` noul；最佳 fits < `fitsThreshold` 0.3 就整体丢弃。第二次请求失败则不推荐（`P2/README.md` "How it decides"）。
- 与 jev-pilot 的差异（均可由两边源码对照）：jev-pilot 默认单请求（`rerank` 默认 false，`excerptChars` 默认 300，加 `(none)` 选项并支持 255 选项分批）、`timeoutMs` 默认 1500；P2 `timeoutMs` 默认 **800**（`P2/hooks/jev-skill-suggestion.ts:174`）；P2 的 state 不带 recent context（`policy.ts:455` `{ request: prompt, recent_context: '' }`，注意是空字符串），jev-pilot 带最近 4 条。
- 不提供：Skill 工具对 skill 的 `allowed-tools` 不会生效，也不计为 skill 调用（README "What the Skill tool does that this does not"）。

### 6. 决策模型 / API
- 只有两个后端：typesafe（`POST https://api.typesafe.ai/v1/systemone`，`jev-latest`）与 gateway（`POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`，`typesafe-ai/jev`）；无 openrouter。`provider: auto|typesafe|gateway|builtin`。key 来自 userConfig（`typesafeApiKey`、`gatewayApiKey`），header `authorization: Bearer`。无 key 时 `$.model.classify(classifyText(prompt, skills), [NONE, ...names])` 单次分类、无 gate、无 rerank。
- 发送内容：prompt 文本、每个候选 skill 的名称+单行描述（请求 1）、shortlist 的 SKILL.md 前 700 字符（请求 2）（`P2/README.md` "Privacy"）。
- 超时：每个请求 `timeoutMs`=800（`Promise.race` + `$.clock.sleep`）。延迟：README 日志样例显示 ranking ~160ms、rerank ~90ms（样例，非基准）。
- 缓存：无决策缓存；SKILL.md 每会话读一次（`files` Map）；`prompt.attachment` 恒定回答以保 prompt cache（README："the engine asks once per attachment and keeps the answer for the process"）。
- 失败降级：fail-open，超时/非 2xx/异常/格式错 → 不推荐，prompt 照常通过。
- 注意 P2 对错误状态只打印状态码，未打印响应体；jev-pilot 版打印前 200 字符（对比 `P2:279` 与 `J/hooks/jev-skill-suggestion.ts:333`）。

### 7. 配置面 / UI / 日志 / 测试
- userConfig（`P2/.claude-plugin/plugin.json`，README "Options"）：`typesafeApiKey/gatewayApiKey/provider/typesafeBaseUrl/typesafeModel/gatewayBaseUrl/gatewayModel/inject/hideListing/rerank/shortlist/gateThreshold/fitsThreshold/excerptChars/alwaysListed/neverSuggested/timeoutMs/logDecisions`。配置路径：`pluginConfigs["jev-skill-suggestion@skills-dir"].options`（`--mod` 安装，项目 `.claude/skills/` 自动加载）或 `"jev-skill-suggestion"`（`--plugin-dir`）。
- 命令：只有 `/jev-skill-suggestion:setup [restore]`（markdown 占位，`skill.prompt` hook 运行时改写成具体计划，模型用 Edit 工具改 `~/.claude/settings.json`，备份在 `~/.claude/jev-skill-suggestion.skill-overrides.backup.json`）。没有运行时开关命令。
- UI：只有 `$.ui.status("jev · skill: <name>" / "jev · no skill")` 与 `$.ui.log("[jev-skill-suggestion] ...")`。没有 pane/band/toast。
- 日志：`logDecisions` 开关，输出 ready/ranking/rerank/suggesting/injected/withheld 等行（见 README "What you see in the transcript"）。headless `claude -p` 时进 `~/.claude/debug/<session-id>.txt`。
- 测试：`bun test cli-tool/components/mods/productivity/jev-skill-suggestion/tests`，唯一测试文件 `tests/policy.test.ts`（约 30 个 `test(...)`，全是 policy 纯函数：listing 解析、trimListing、catalog、gate、rank、rerank、requestBody、injectionBlock、setup plan 等）。没有引擎内测试（`claude plugin test` 那类）。

### 额外问题：怎么拿到"所有可用 skill 列表"，是否让 skill "user only"/从 system prompt 移除

- 收集列表：不靠 listing（因为 listing 在 turn 第一个请求才渲染，晚于 `prompt.submit`），而用 `$` API **`$.command.list()`**（`P2/hooks/jev-skill-suggestion.ts:341`），返回每个命令的 `name/description/source/plugin`；`catalog()` 去掉 `source==='builtin'`、`neverSuggested` 与插件自己的命令。`inject: "suggest"` 时一旦见过 listing，候选收窄到 listing 里的名字（`listed` Set，由 `prompt.attachment` 回调累计）。skill 正文靠 `$.fs`（`$.env.get('HOME')`、`$.fs.exists/read/list`）按目录约定找（含 `~/.claude/plugins/installed_plugins.json`）。frontmatter `name:` 带空格的 skill 用目录名映射（`displayIds/canonical`）。
- 是否移除/user only：两条路径叠加。
  1. 运行时：事件 **`prompt.attachment`**，matcher `{ type: 'skill_listing' }`，回调 `return { text: kept }`（`kept` 为 null 或只留 `alwaysListed`），不调 `next`，所以引擎生成的 skill 列表不进模型上下文（`P2/hooks/jev-skill-suggestion.ts:211-246`）。子 agent（`e.agentId`）的 listing 不动。要求 Claude Code ≥ 2.1.278（README："the `prompt.attachment` event it hooks … first shipped there"）。
  2. 持久：`/jev-skill-suggestion:setup` 让模型把所有用户/项目 skill 写成 `skillOverrides: {name: "user-invocable-only"}` 并加 `disableBundledSkills: true`（`policy.ts:868-869`），以便 `/skills`、`/context` 也显示节省；插件自带的 skill 改不了（`locked by plugin`）。因为 Skill 工具会拒绝 `user-invocable-only`，所以靠 `inject: "content"` 直接注入正文。
- 没有用 `prompt.section` 或 `skill.prompt` 去删 system prompt：`skill.prompt` 只用于观察与改写 setup 命令的 prompt；`prompt.section` 在 P2 与 jev-pilot 的源码中都没有出现（已全文检查）。
- 注意：mod 方案只去掉 listing 这一块（"one line per skill"），其余 system prompt 没动。

---

## 三、对我们设计的启示（来自这两份源码，非二手判断）

- 主循环 effort：`turn.step` 里改 `e.effort`，首请求决定，后续复用，仅升档例外。需要自己用 `turn.id`/`e.index` 判断"这是新一轮"，因为 `prompt.submit` 与 turn 之间没有 id 关联（见 `pendingDecisions` 的注释，policy `:1046-1056`）：两个 prompt 同时排队时放弃决策。
- 子 agent：model 用 `agent.spawn`；effort 只能靠子 agent 自己的 `turn.step`（`e.agentId`）。主 agent 显式指定的 `e.model` 要保留。
- Workflow agent：别指望 hook 能拦；jev-pilot 采用"给主模型发提示让它写 `opts.model`"。是否能 hook 需自己实测，官方文档没说。
- skill：`prompt.attachment`+`{text:null}` 去 listing，`$.command.list()` 取候选，`next({...e, context:[...]})` 注入正文。同一会话重复注入只提名字，`session.compact`/`session.end` 要清状态。
- 通用工程习惯：每条路径 fail-open、`Promise.race` 超时、`announced` 一次性"我加载了"提示、`catch` 后继续、状态保存在模块闭包变量与 `$.store`。

## 无法确定的事项

- Workflow 工具的 `agent()` 是否触发 `agent.spawn`，以及不触发是平台限制还是设计：官方文档（reference 页 `agent.spawn` 行）没有说明，jev-pilot 只断言"don't pass through"并改用提示绕过。
- jev-pilot 是否真的在"当前会话"生效，未验证；只确认已安装于 `/Users/alexnear/.claude/plugins/cache/jev-pilot/jev-pilot/0.12.1`。
- P2 `hooks/policy.ts` 与 jev-pilot `*.policy.ts` 中打分细节（如 `shortlistOf`、`decide`、`describe*`）未逐行核对，上文只引用了读过的函数。
- jev-pilot 的 toast：源码中未见使用，结论是"没有 toast"，但只检查了 `hooks/` 目录里 `$.ui.*` 的调用。
