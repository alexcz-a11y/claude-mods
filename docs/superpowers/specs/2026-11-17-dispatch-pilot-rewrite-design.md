# dispatch-pilot 重写：原生适配 Code Mode（设计）

日期：2026-11-17　分支：`dp/rewrite`　Claude Code：2.1.327　修订：2026-11-18

## 1. 意图

dispatch-pilot 用 Claude 之外的决策模型替主 agent 定 effort、替派出的 agent 定模型和 effort。上一版为了适配 Code Mode 拆成了两个 plugin、两条代码路径。这次从零重写，不沿用旧代码和旧注释，让同一套代码在普通会话和 Code Mode 会话里行为一致，并且不抵消 Code Mode 带来的收益。决策模型的问法、读法和参数严格照 Nace 和 TypeSafe 现行官方文档。

## 2. 目标、非目标、反目标

**目标**

1. 三项换挡都保留：发消息时定 effort；一轮中途换 effort；派出 agent 时定模型和 effort。
2. skill 一组功能保留：去掉引擎的 skill 列表、发消息时推荐、`find-skill`。
3. 单个 plugin，两种会话走同一条路径。
4. 决策模型默认 Drex `drex-max-v1.1`，另一个后端是 Jev `jev-latest`。
5. 任何决策失败或超时都放行，会话照没有这个 mod 时那样继续。

**非目标（这次不做，以后各自立项）**

失败升档、未解决次数、长期约束、跨轮的问题摘要、看图核对、截图接管、图片路由、Workflow 专门处理、旧的看板和依据面板（整个删掉，新看板见 5.14 节）、pplx 和 Liquid 后端。

看板在范围内（5.14 节）。它原先被我划在范围外，用户 2026-11-18 指出漏了并补上。

一轮之内的进展记录（5.13 节）在范围内。它原先只作为待比较的选项、由校准定留不留；校准看不出它有好处，用户 2026-11-19 定下默认开（第 11 节第 42 条）。

**反目标（做到了也算失败）**

- 装上后 Code Mode 不能启动。
- 往上下文里加固定内容，或让固定内容比不装时更多。
- 给脚本内部的工具调用加等待。
- 换主 agent 的模型，或以别的方式让主 agent 的 prompt cache 失效。
- 决策模型不可用时卡住用户的消息。
- 打开 OpenTelemetry，或把会话内容、请求内容发到两家决策模型接口以外的任何地方。

## 3. 约束

### 3.1 Code Mode

- Code Mode 是实验功能，只在有 TUI 的交互终端里可用，`claude -p` 这类方式不生效。
- 2.1.326 及以前，它不和挂了 `tool.call`、`agent.spawn` 等事件的 mod 一起开。2.1.327 起不再因此拒绝启动（release note："Changed Code Mode to no longer refuse to start when an installed mod hooks tool calls"）；实测见 3.2 节 E10 到 E12。本 mod 因此要求 2.1.327 及以上。
- 不论普通会话还是 Code Mode 会话，都不打开 OpenTelemetry（用户 2026-11-18 的要求，避免泄漏隐私）。mod 自己不开，测试和校准也不开。另一个事实：开了它的会话里 Code Mode 不可用（2.1.327 启动提示）。
- 本设计仍不注册 `tool.call` 一类的事件，也不用 `$.tool.register`：依据从结果行读（5.4 节），脚本内部的调用本身不挂任何 hook。它们的结果行仍要经过 mod 的 `session.append` hook，那里会读写状态；这给每条结果行添了多少时间没有测过。
- Anthropic 没有专讲 Claude Code Code Mode 的博客，官方只有文档页（https://code.claude.com/docs/en/code-mode ）和 changelog。收益来自更少的固定工具说明和不进上下文的中间结果。本设计按第 2 节的反目标来保护它。

### 3.2 引擎行为（E1 到 E9：2.1.326，2026-11-17；E6 和 E10 到 E18：2.1.327，2026-11-18。都用一次性探针在 tmux 里的交互会话实测，探针不进仓库）

| # | 行为 | 普通会话 | Code Mode 会话 |
|---|---|---|---|
| E1 | 只挂 `session.start`、`command.run`、`prompt.submit`、`prompt.attachment`（`skill_listing`）、`skill.prompt`、`turn.start`、`turn.step`、`session.append`、`turn.complete` 这九个事件的 mod 不挡 Code Mode（2.1.326）。除 `skill.prompt` 只验证了注册不挡以外，都在 Code Mode 会话里实际触发过 | — | 已测 |
| E2 | agent 的 `turn.start` 上 `e.text` 是派出时的任务原文，`e.agentId` 是它的 id | 已测 | 已测 |
| E3 | agent 的 `turn.step` 上 `next({ ...e, model })` 生效：`$.agent.list()` 的 `lastRequest.model` 是改后的模型（Sonnet 5.5 改 Haiku 5.5）。改写只管一步，每步都要重写 | 已测 | 未单独测（同一引擎路径） |
| E4 | 在只带工具结果的步上改 `effort` 不发出：`lastRequest.effort` 仍是原档 | 已测（agent 循环） | — |
| E5 | 在 `session.append`（door `tool-result`）里、`next` 之前给结果行加一个 text 块，下一步改的 `effort` 就发出，并保持到之后只带工具结果的步 | 已测（agent 循环，Sonnet 5.5 和 Haiku 5.5） | 已测（Code Mode 会话里的 agent 循环） |
| E6 | 主循环上的 E4 和 E5（读数见 E15，读的是线上请求体） | 已测：不加说明时请求里仍是原档；在工具结果行上加了说明，下一次请求起是新档，并保持到这一轮结束 | 已测：同样的结果。说明加在 `Poll` 的结果行上、加在 `REPL` 那条 `(dispatched #N)` 行上都有效；从高到低、从低到高各测过。请求体里，带说明的那条消息自己带一个 `output_config.effort`，从那次请求起顶层的 `output_config.effort` 也是新档 |
| E7 | Code Mode 下主循环的行：请求会带上的结果行是 `tool-result`、`origin.tool` 为 `REPL` 或 `Poll`、`message.role` 为 `user`。脚本内部调用（`Read`、`Agent` 等）也各有一条 `tool-result` 行，但 `message.role` 缺省，请求不带它 | — | 已测 |
| E8 | 加在结果行上的 text 块在终端里显示成一行以 `❯` 开头的文字 | — | 已测 |
| E9 | 环境变量 `CLAUDE_EFFORT` 不反映 hook 改写的档位 | 已测 | — |
| E10 | 挂了 `tool.call`、`agent.spawn`、`agent.offer`、`session.send` 的 mod 不挡 Code Mode | — | 已测 |
| E11 | `agent.spawn` 在 Code Mode 下触发，带任务原文、`subagentType`、`parentModel`、`background`。`next({ ...e, model: 'haiku' })` 生效：返回值和 agent 的 `lastRequest.model` 都是 `claude-haiku-5-5`。`next` 的返回值带 `agentId`，实测比这个 agent 的第一个 `turn.step` 早约 70 ms | — | 已测 |
| E12 | Code Mode 下脚本内部的每次调用各触发一次 `tool.call`（`Read`、`Agent`，以及 agent 自己的 `Bash`）；外层的 `REPL` 没有触发 | — | 已测 |
| E13 | Code Mode 下一次脚本的顺序：`REPL` 的结果行立刻回来，内容只是 `(dispatched #N)`；脚本结束后，结果作为一个事件到达。模型这一步没有同时调 `Poll` 时，结果在 `delivery` 行里（一条 attachment）；调了 `Poll` 时，结果在 `Poll` 的结果行里，`delivery` 行是空的。之后才有下一个 `turn.step`。`delivery` 行带不了换挡：它到达后改的档位不发出，往它里面加的文字（新加一块或接在原有文字后面）也不会存下、不会发出 | — | 已测 |
| E14 | 请求带上了新档，不等于模型的做法跟着变。读数确认请求已从 `low` 变成 `xhigh` 之后，每步的输出量仍接近一直是 `low` 的基线，低于从头就是 `xhigh` 的基线。只测了一道逐步重复的算术题、Sonnet 5.5、每种各一次；输出量本身也不是可靠的指标，效果要用任务结果来验（第 8 节） | 已测 | 已测 |
| E15 | 每次请求实际带的档位，由 mod 挂 `http.fetch` 来读：引擎每发一次模型请求都触发它（类型文件："Every model request the engine sends raises this event too, with `next.origin.plugin` \"engine\", once per send"），`e.init.body` 是发出去的请求体，读其中顶层的 `output_config.effort`。凭据头对 hook 显示为 `[redacted]`。挂它不挡 Code Mode。组织的守卫插件加载时，只有组织自己的 mod 看得到引擎请求。会话记录文件里 `type` 为 `api-request` 的行也带 `params.output_config.effort`，逐次和它一致，但那是没有文档的内部格式，只作旁证 | 已测（会话记录） | 已测（两种都测了） |
| E16 | 不能用的读数：`$.model.fork` 返回的 `effort` 是会话的档位，不反映 hook 的改写；`CLAUDE_EFFORT` 同样不反映（E9）；`$.agent.list()` 的 `lastRequest` 只有 agent 有，主循环没有。OpenTelemetry 的 `api_request` 事件带 `effort`，2026-11-18 的探针用它对照过一次（数据只发到本机的监听器，抓到的文件已删除），按 3.1 节以后不再使用 | 已测 | 已测 |
| E17 | 中途换档不丢缓存：换档前后每次请求读到的缓存量连续增长，没有重写整段对话（Sonnet 5.5，订阅登录） | 已测 | 已测 |
| E18 | 本机三个真实的 Code Mode 会话（Fable 5.2）里，脚本结果有 307 次在 `Poll` 的结果行里到达，9 次在 `delivery` 行里到达 | — | 统计自会话记录 |

类型文件对 E4、E5 的原文（`TurnStepInput.effort`）："A rewrite lasts one step. On a model that takes effort per message, a level on tool results alone is not sent if another is in force, and one on a step with input stays for later tool steps whose `effort` is a level."

两种会话的主循环都已经用 E15 的读数直接测到（E6）。还没验证的是效果：E14 说明档位发出去之后，模型的做法不一定跟着变。处理办法见第 8 节。

### 3.3 缓存

- 官方文档：在 Fable 5.1 及以后、Opus 5.5、Sonnet 5.5、Haiku 5.5 上用 API key 或订阅时，换 effort 不丢缓存；换模型会丢。Bedrock、Google Cloud、网关上换 effort 也会丢。
- 主 agent 的模型永不改写。agent 的模型只在派出时定一次（`agent.spawn`），之后不再改。
- skill 列表的替换文字是固定的一句，回答稳定，只在第一次请求时改变一次前缀。

### 3.4 决策模型官方文档

**Nace Drex**（https://console.nace.ai/docs/drex/ 下的 questions、reading-answers、drex-max、errors-and-retries、reference/models 各页）

- 有序标签用 `score`，无序用 `choice`。`score` 的 `criteria` 是从低到高的数组，回答里 `probabilities` 按档位下标给出分布。
- "Rounding `score` to the nearest level loses information."，读尾部概率和，例如 `probabilities["2"] + probabilities["3"]`。
- "There is no built-in cutoff."，门槛按两类错误的代价定；两类都贵时用两个门槛，中间带单独处理。
- `noul` 用 `criteria.true` 和 `criteria.false` 写清两边，比只写 `instructions` 更能移动答案。
- state 约 8000 token 以内全文读，更长只读抽取的片段。一次请求最多 512 题。
- 调门槛时固定模型版本。`drex-latest` 现在指向 `drex-max-v1.1`。
- 文档建议客户端超时不低于 60 秒（服务端最多排队 55 秒）。

**Nace 官方 skill（`nace-ai/drex-agent-skills` 0.8.0 的 `drex-for-harness`，https://github.com/nace-ai/drex-agent-skills ）**

- "Start from the behavior the user wants, then work backward to the semantic judgments it requires. Keep deterministic checks, calculations, execution, and permissions in code."
- 它的对照表：路由或选一个有限的下一步动作，用 "`choice` over named destinations or actions"；评估质量、相关度、紧急度或风险，用 "`score` against concrete ordered levels"，代码 "apply reviewed thresholds"；同一 state 的几个方面，用同一请求里互相独立的题，代码 "Combine answers into policy"。
- `score` 的档位："Describe concrete situations rather than vague labels when possible."
- "Keep questions and thresholds reviewable in one module."、"Evaluate thresholds on representative data and consequences rather than copying a cookbook cutoff or another model's calibration."
- 客户端要核对回答的 `model`："Compare the response `model` with the pinned id. A mismatch means a retired or mistyped id: log it as an error and handle the call as failed."（2026-11-19 更正：原先这里写拼错或退役的 `drex-` id 都会被别的版本回答、不报错。照现在的 models 页，拼错的 `drex-` id 返回 `422 invalid_request_error`，只有退役的 id 和别名由现行版本回答。）还要核对每道题都带着要求的类型回来，失败时记 `request_id`，401、402、422 不重试。
- 等不起 60 秒的请求路径："a shorter total budget wins over the 60-second floor. It abandons slow requests, so treat its expiry like any other Drex failure."
- 不是护栏的判断在 Drex 不可用时放行并记一行日志；失败不能和真实的「否」用同一个结果表示。
- 换提供方：Drex 被设为默认提供方时，Drex 失败后新写的决策代码不得改调别家；"Keeping the existing provider path behind an explicit configuration switch is allowed, because a person selects it."
- 这份 skill 写 `drex-latest` 指向 `drex-v2.0`，和现行 models 页不一致（页面 2026-11-18 渲染后读到：`drex-latest` 指向 `drex-max-v1.1`，不写 `model` 时也选它）。skill 自己说以现行文档为准，这里按页面。

**TypeSafe Jev**（https://docs.typesafe.ai/ 下的 primitives、confidence、models、model-jaggedness 各页和 skill_suggestion cookbook）

- Score 的 `criteria` 是 2 到 10 档的有序数组，回答里有 `probabilities`。
- "Ask one yes/no question per Noul."，高值表示「是」。
- "Good starting thresholds are 0.7 and 0.3 ... Give the band between 0.3 and 0.7 its own outcome in code rather than rounding it to one side."，门槛随出错代价调整，用自己的数据测。
- "Include only the context relevant to the current questions."。默认上限每次请求 64k、每题 32k。同一请求里的题互不影响。（2026-11-19 校准时在 Drex `drex-max-v1.1` 上实测，那里不是这样：只把一道题的选项打乱顺序，按别的题读出来的决定 30 例里变了 6 例；去掉两道对照题之后，对一句光秃秃的「继续」，`open` 落在第 0 档的概率从约 0.5 变到 0.8。所以校准问的就是 mod 实际发的请求，见第 11 节第 39 条。Jev 上没有测。）
- Choice 偏向排在前面的选项；用陪伴的 Noul 代替 "other" 选项。
- `jev-latest` 现在指向 `jev-1.14.0`，别名会随新版移动；回答的 `model` 字段给出实际版本；调过门槛就该固定版本。
- skill cookbook：第一次请求问一道 Choice（选项是各 skill 的说明）、三道「是否要动手」的 Noul 和一道「是否点名了方法」的 Noul；三道的均值不低于 0.30 或点名题不低于 0.50 才算需要 skill。第二次请求对前三名重排，并逐个问「这个 skill 是否正好做用户要的事」，最高分低于 0.30 就不推荐。

**TypeSafe 官方 skill（`typesafe:typesafe-ai` 0.6.2）和现行文档对问法的要求**

- 这份 skill 是现行版本：上游 `typesafe-ai/skills` 只有 `v0.5.7`（2026-09-12）和 `v0.6.2`（2026-10-23）两个标签，本机的 0.6.2 和上游逐字相同。「Judgments from Jev, decisions in code」一节是 0.6.2 新加的，0.5.7 里没有。
- 现行文档说的是同一件事：use-case-map 页（2026-11-13 更新）"Start from the action your system takes, and list the judgments it depends on. Turn each judgment into a question for Jev. Keep the rules that combine the answers into a decision in your code."；patterns 页 "Every pattern splits a decision into small System One questions and leaves the decision to your code"；primitives 页把 "Analyze this message and determine the best course of action" 列为不该问的题。"truth table" 和 "wrong layer" 这两个说法只在 skill 里有。
- skill 对自己的限定："None of it is absolute. … When a situation calls for something else, test the alternative and use your judgment."
- 模型只给判断，决定写在代码里。让模型直接做决定的题（"该不该升级"）问错了层，要拆成它依赖的几个判断，决定用代码里的表来做，每种回答组合都要有结果，包括落在两个门槛之间的情况。
- 问具体、能指出来的事，一题一个判断，"或""和"连接的条件拆成两题。
- Score 的每一档写成一种情形，单独读也成立，不写"比上一档更…"。Noul 的 `false` 也写成具体情形。 score 页："Describe situations, not degrees."、"Keep each Score question to one dimension."
- state 用带名字的字段，题目用反引号里的路径指向字段；每个字段都要和题有关；代码已经知道的事实直接写出来。
- Choice 总会选一个，所以另问一道 Noul"有没有任何一个合适"。
- 请求失败要当作错误处理，不能当作"否"。所有题的措辞放在一个模块里。

**两家对测试和校准的说法**

- 用例要有代表性的、难的和答案是"否"或"都不合适"的（TypeSafe skill）；清楚的用例对谁都容易，要专门放边界用例（consistency cookbook）。
- 用例来源首选自己的真实流量："set the thresholds in `POLICIES` from labeled examples of your own traffic."（llm_guardrails cookbook）。模型写的用例比真实请求容易（skill_suggestion cookbook）。
- 参考答案可以由人标，也可以用强模型的回答，后者要写明（evals.typesafe.ai、verify_llm_outputs cookbook）。
- 留出一部分用例不参与调整："pick the probability that best separates the two groups, and check it on pairs you didn't use to pick it."（basic_memory cookbook）；留出的那部分只在最后算一次分（autoresearch cookbook）。
- "Start with conservative thresholds, test with your own data, and adjust as you observe results."、"Test thresholds by plotting confidence against accuracy on your data."、"Avoid fitting thresholds closely to a handful of test cases."（TypeSafe）。风险高的动作门槛更高，每种动作各有门槛。
- Score："Choose examples with known expected levels, then test the revised descriptions on separate inputs before keeping them."（TypeSafe）；"try a score question on a few samples before you rely on it."（Nace）。（2026-11-19 更正：这句出自 Nace 的 Langfuse 集成页，说的是那个适配器，不是在说 score 题的档位说明。）
- 比较措辞时把每种写法作为同一请求里的不同题来问；逐条看回答，不只看汇总；保存每个用例的原始请求以便重跑（TypeSafe skill）。
- 警示信号：criteria 里点名测试用例或每个失败用例加一句、为解释模型怪癖加说明、门槛贴着个别用例调、测试断言精确概率、代码悄悄改写回答（TypeSafe skill）。
- Choice 的选项顺序会影响 Jev，换顺序复查（model-jaggedness）。
- "Log the raw `noul` value with each decision, so you can move the threshold later and replay past traffic against the new one."、"don't treat 0.5 as the answer"、调门槛时固定模型（Nace）。
- Nace 文档对用例数量、类别比例、标注方法没有说法；TypeSafe 文档没有规定用例格式和数量。（2026-11-19 更正：Nace 对用例数量有说法，在它官方的 `drexify` skill 里："Keep live evaluation small, tens of labeled examples per site, and say how many billable calls ran."。每类 15 例在 tens 的下沿。）
- 向真实接口发测试请求前，先征得用户同意，说明预算、会发送哪些数据、用谁的密钥（TypeSafe skill）。

**effort 和模型路由**

- 两家都没有官方配方。TypeSafe 只在 use-case-map 页有一条想法："Model router: match each prompt to a model … Classify each prompt's intent and subject area. Estimate difficulty and risk."，没有例题。
- Nace 的例题直接问决定（"How should accounts payable handle this invoice?"，选项 `pay`、`hold`、`reject`；"Which priority should this ticket get?"，选项 `p0` 到 `p3`，说明写成情形）。Nace 没有哪一页比较过「问判断」和「问决定」两种写法。
- Nace 文档收了一个社区贡献的集成（Oh My Pi 的 `auto` thinking level）："Drex rates how hard each prompt is, and omp picks the thinking level for that turn."，页面没给题目。它的源码（第三方，不是 Nace 写的）用一道 Choice 直接选 `low` 到 `max`，各选项的说明是情形；评的是问题有多开放（"Volume of work never raises it."），`max` 另需一个附加条件（"Difficulty alone is insufficient."），拿不准时取低的一档。没有公开的评测数据。
- 逐条出处见 `docs/research/decision-question-layer.md`。

## 4. 做法的选择

### 4.1 插件结构

| 做法 | 内容 | 取舍 |
|---|---|---|
| 一、单插件、单路（**选定**） | 只挂 Code Mode 允许的事件；中途换挡时在结果行上加一行说明 | 每次中途换挡往上下文加一行，约几十 token |
| 二、单路、零追加 | 同上，但中途只在本来带新输入的步换挡 | 上下文一个字不加；按 E4，Code Mode 的一轮几乎全是只带工具结果的步，中途换挡基本不起作用 |
| 三、双插件、双路 | 核心加 extras，普通会话里用 `agent.spawn`、`tool.call` | 信号更全；两套路径、两套测试，两种会话行为不一致 |

用户选了一：三项换挡在两种会话里都能用，代码只有一条路。让 Claude 自己在脚本里申请换挡的路也考虑过，它要加固定说明，也绕过了决策模型，已排除。

2.1.327 放开事件限制后（3.1 节），做法一不变，只多用一个 `agent.spawn`（5.5 节）。做法三当初的理由是普通会话里能挂更多事件，现在两种会话能挂的事件相同，这个理由不再成立。

### 4.2 怎么用决策模型选档

两家官方都没有 effort 路由的现成配方（3.4 节），所以这是要选的。

| 做法 | 问什么 | 取舍 |
|---|---|---|
| 一、分档题加条件题，代码定档（**选定**） | 一道 `score` 题问问题有多开放，五档各是一种情形；几道 `noul` 条件题；代码读概率分布和条件题定档 | 两家的书面要求都满足；风险集中在五档文字写得准不准 |
| 二、直接选档 | 一道题直接选 `low` 到 `max`，各选项配一句情形 | 最简单，Nace 的例题和社区实现这样写；TypeSafe 说这是问错了层；用 `choice` 会丢掉顺序 |
| 三、全拆成是非题 | 六到十道 `noul`，代码里的表把组合映射到档位 | 最容易审计；表要自己设计和校准，工作量和所需用例最多 |

用户 2026-11-18 选了一。校准时把做法二的那道题放进同一请求对照（第 8 节）。

### 4.3 要不要另用一个模型写进展记录


担心的是：决策模型只看到最近几步，长轮次里不知道整个任务做到哪了，中途的判断落在拿不准的区间。

| 做法 | 内容 | 取舍 |
|---|---|---|
| A、不加 | 进展只来自代码数的事实、脚本自带的说明、助手自己写的话 | 不等、不花钱；窗口之外做过什么看不到 |
| B、后台写进展记录（**先做这个**） | 每个检查点之后在后台让 Haiku 5.5 更新一份几行的记录，下一次判断时读现成的那份 | 主循环不多等；记录晚一步；它是另一个模型的说法，写错会带下去 |
| C、判断前等记录写完 | 同 B，但每次判断先等 Haiku | 记录最新；每次脚本结果多等一次模型调用 |

用户 2026-11-18 的决定：先按 B 做出来，最终用哪一种、要不要加，在找门槛的那轮测试里对比之后定（第 8 节）。

### 4.4 看板长什么样

用户的要求（2026-11-18）：旧看板又丑又乱、抓不住重点，整个删掉，不以它为基础。新看板要准确显示当前的 effort、什么时候换的、离下一次评估还有多久、评估结果是什么、哪些功能开着并且生效；终端和 Desktop 各一版；由我设计，先出几种风格给用户选。

四种风格做成了可切换的原型（`docs/research/board-prototype/four-styles.html`，六个场景）：

| 风格 | 重点 | 取舍 |
|---|---|---|
| A、一行 | prompt 上方两行，一眼看档位 | 最省地方；评估结果只有结论，换过几次挡只看得到最近一次 |
| B、时间轴 | 这一轮每一步画成一格，换挡、每次评估和下一次评估都标在轴上 | 什么时候换的、评估密不密一眼可见；常驻五行，概率细节放不下 |
| C、分区面板 | 右边一栏，固定分区，信息最全 | 每个问题有固定位置；要占右边一栏，面板关着时只剩一行 |
| D、档位梯 | 五档排成梯子，当前档对着决策模型给的概率 | 为什么升、为什么不动最清楚；常驻七行，没有历史 |

用户选了 B 和 C 搭配：时间轴常驻在 prompt 上方，分区面板在右边按需打开。合起来的样子见 `docs/research/board-prototype/timeline-and-pane.html`。

## 5. 设计

### 5.1 事件

| 事件 | 用途 |
|---|---|
| `session.start` | 注册 `/dp` 命令，读配置，建会话状态 |
| `prompt.submit` | 发消息时的判断：effort 题和 skill 题；把推荐的 skill 放进 `context` |
| `prompt.attachment`（`type: 'skill_listing'`） | 记下列表里的 skill，主循环的列表换成固定的一句；agent 的列表不动 |
| `skill.prompt` | 回答 `dispatch-pilot:find-skill` |
| `turn.start` | 主循环：记下这一轮的基准档 |
| `agent.spawn` | 派出 agent 时判断，定它的模型和 effort |
| `turn.step` | 每步写 effort；agent 每步写派出时定下的 effort |
| `session.append` | 读每步的结果行作为依据；到检查点时判断，要换挡就在结果行上加说明 |
| `turn.complete` | 收尾：清这一轮的计数 |
| `http.fetch` | 读引擎每次模型请求实际带的档位（5.12 节），只读不改 |
| `command.run`（`command: 'dp'`） | `/dp` |
| `ui.render`（时间轴、面板、脚部标签各一个 matcher） | 画看板（5.14 节） |
| `ui.close`（面板的 id） | 面板不管怎么关上，都重画时间轴（5.14 节） |

不注册 `tool.call`、`tool.check`、`tool.run`、`tool.judge`、`agent.offer`、`session.send` 和 `classic.*`，不调用 `$.tool.register`。

### 5.2 怎么问、怎么读（三项换挡共用）

**模型只给判断，决定在代码里。** 没有任何一题问"该用哪一档"或"该用哪个模型"。题目问的是工作本身，档位和模型由代码里的表从回答算出来。所有题的措辞集中在一个模块里。

这是用户在三种做法里选定的（4.2 节）。依据（3.4 节）：它是 TypeSafe 现行文档和官方 skill 的写法；Nace 的 skill 同样要求从判断倒推、把门槛留在代码里，但它的例题允许直接问动作，也没有比较过两种问法。「直接选档位」的写法只在校准时作对照（第 8 节）。

骨架三处共用：同一道 `score` 题、同一个 `decide`。每一处有自己的上下文、自己的条件题和自己的门槛（5.3 到 5.5 节）。

- **工作有多难**用一道 `score` 题，只量一个维度：问题有多开放，也就是做法是不是已经给定、还有多少原因或设计没有定下来。工作量大小不算在这道题里（score 页："Keep each Score question to one dimension."）。五档从低到高，每一档写成一种单独读也成立的情形，不用程度词。起步的五档：做法已经给定，照着改；小范围内有少数几种可能，或有一处小坑；有几种可行的设计或几个可能的原因，要做取舍；原因不明的偶发、并发或状态问题，或容易出细微错误的改法；上一档的情形，再加上没有复现、操作不可逆、要在运行中切换三者之一。代码把第 0 到 4 档对应到 `low`、`medium`、`high`、`xhigh`、`max`。这五档的分法参考了 3.4 节那个社区实现，文字自己写，以校准为准。
- 读这道题用函数 `decide(current, probabilities)`，三处共用：
  - 升：比当前高一档及以上的概率和不低于升档门槛，就升一档，再对新的一档重复。
  - 降：比当前低一档及以下的概率和不低于降档门槛，就降一档，再重复。
  - 两边都不到，保持当前档。这就是文档说的中间带。
- **条件类的判断**各用一道 `noul`，一题一个条件，高值表示「是」，`criteria.true` 和 `criteria.false` 都写成具体情形。起步的两道：「这项工作是不是照已知做法重复的机械改动」（是，则上限 `medium`）、「这项工作是不是要先查明一个原因未知的问题」（是，则下限 `high`）。读法用两个门槛，落在中间带时这一条不起作用。每道题都必须在表里有用处，没有用处的不问。
- 门槛是插件的选项，按动作分（第 11 节第 42 条），不管哪个后端回答都用；原先按后端、模型版本和动作各存一张表，已经去掉。初值：升档 0.7，降档 0.7（即文档的 0.7/0.3 起步），升到 `xhigh` 和 `max` 的门槛更高（初值 0.8），`noul` 用 0.7 和 0.3。初值只是起点，发布前校准（第 8 节）。 0.7 和 0.3 是 TypeSafe 文档给 Jev 的起步值；Nace 的 skill 要求门槛在自己的数据上定，不照搬别家模型的校准，所以校准前的值只是占位，不当作 Nace 认可的值；现在选项的默认值是在 `drex-max-v1.1` 上校准的那组。
- 一次判断的所有题放进同一次请求。同一请求里的题会互相影响（2026-11-19 校准时实测，见 3.4 节），所以门槛是跟着这一份请求校准的：请求里加一道题或去掉一道题，都要重新校准（第 11 节第 39 条）。
- state 的写法（三处共用，各处的字段见 5.3 到 5.5 节）：
  - 带名字字段的对象，题目用反引号里的路径指向字段。
  - 只放和题有关的字段（TypeSafe："Include only the context relevant to the current questions."；Nace："Send only the fields the questions need."）。上限 4000 token，两家都不触发抽取或长上下文模式。各字段先按自己的预算截断；序列化之后仍超的（JSON 转义会多出字符），由发请求的那一处统一缩短最长的几个字段，直到放得下。
  - 代码数得出来的事实直接写成字段，不让模型自己去数。
  - 多条内容按时间从早到晚排。
  - 有一个 `note` 字段，用一两句说明这份内容怎么读。
  - 格式定下来就不再改：Nace 实测同一份数据写成文字和写成 JSON，`noul` 的回答差了 0.13，门槛是跟着格式调的。
  - state 里的工具输出可能带着指令。题只问事实，mod 不执行 state 里的任何内容。
- 请求失败记为失败并放行，不当作「否」。

### 5.3 发消息时定 effort

- 只处理人发的消息（`origin.kind` 为 `composer`、`sdk`、`bridge`），其他来源直接放行。送进一轮正在进行中的消息（`e.turnId` 有值）也不在这里判断，由中途的新输入检查点处理。
- state 的字段：
  - `note`：这份内容怎么读。
  - `request`：用户这条消息。
  - `previous_turn`：上一轮用户说了什么、助手最后回了什么（各一小段）、怎么结束的（答完、报错、被打断）、用的档位。没有上一轮时不放。带它的理由：「还是不行」「继续」这类短消息离开上一轮没法判断。
- 题：5.2 节的 `score` 题和两道条件题，加一道 `noul`「这条消息是否只是让助手继续它已经提出或正在做的工作」。
- 续做题为「是」并且上一轮的档位已知时，这一轮就用上一轮的档位，`open` 和两道条件题都不再挪动它（2026-11-19 校准定的，第 11 节第 36 条）；否则 `current` 取会话设定的档位，由 `open` 和条件题挪动。结果写进状态，由这一轮的每个 `turn.step` 发出。
- 这条决定绑在它开始的那一轮上：引擎在 `prompt.submit` 的 `next(e)` 里开始这条消息的一轮（实测；`turn.start` 的 hook 在那里开始，可能在 `next(e)` 返回之后才结束，第 0 步等它），所以决定在 `next(e)` 之前写下；`turn.start` 只在它的文字和这条消息相同时留下决定，否则清掉；`next(e)` 回答 `drop` 时也清掉。对不上时宁可丢掉这次决定（等于放行），不会用到别的一轮上。
- 发消息时没有定档的一轮（`submitShift` 关着，或者由通知、别的会话开始的一轮），第一步时把引擎带来的档位记作这一轮的基准档，所以这些轮照样有中途判断，看板也有档位可显示。
- 用户用 `/dp lock` 锁了档位时不判断。

### 5.4 一轮中途换 effort

- 依据来自 `session.append` 的行：这一轮里每步用了哪些工具、是否报错、结果文字的开头（Code Mode 下是带着脚本结果的那一行的文字，也就是 `Poll` 的结果行或 `delivery` 行，以及脚本内部调用行的工具名和报错标记，见 E7 和 E13）。
- 判断的时机是一份结果到了模型手里、模型还没发下一次请求的那一刻，不在脚本运行中途。脚本是一个整体：模型要等结果回来才会发下一次请求，effort 也只在那次请求上起作用，中途换了也要等整个脚本跑完才用得上（E13）。
- 检查点（到了才问决策模型）：
  - Code Mode 会话：每到达 N 次脚本结果是一个检查点（`midrunEveryScripts`，默认 1，也就是每次都判断；0 为关闭）。`REPL` 那条只写着 `(dispatched #N)` 的结果行不算。脚本里的失败已经写在脚本的结果里，不另外数。
    - 结果在 `Poll` 的结果行里（绝大多数情况，E18）：在这一行上判断，要换挡就把说明加在这一行，下一次请求就是新档。
    - 结果在 `delivery` 行里（模型这一步没调 `Poll`）：这一行带不了换挡（E13）。照常判断并记下结果，说明加在之后第一条 `REPL` 或 `Poll` 的结果行上，所以新档晚一次请求生效。
  - 普通会话：代码数到失败成簇（同一处报错在一次修改之后再次出现，或连续两步报错），或距离上一个检查点满 N 个工作步（`midrunEverySteps`，默认 8，0 为关闭）。
  - 两种会话都有：这一轮中途进来了新输入（用户插话、后台任务通知、agent 交回报告）。作为 prompt 行进来的输入，那一步本来就带输入，换挡不用加说明。作为 `delivery` 行送进来的输入和 `delivery` 行上的脚本结果一样带不了换挡（E13）：说明排到之后第一条 `REPL` 或 `Poll` 的结果行上，也占说明条数。
- 中途判断的是「拿到这份结果之后，剩下的工作和现在的档位还相称吗」。请求没变，所以绝大多数时候答案是不变；读法把不变当默认。
- 题：
  - 5.2 节的 `score` 题，问的对象是剩下的工作。
  - 四道中途专有的 `noul`，每道只问最新结果里看得见的一件事：① 一次修改之后，同一个失败是不是又出现了；② 问题的原因是不是已经查明；③ 剩下的是不是只是把已定的做法做完（同样的改动用到别处、跑检查、写总结）；④ 最新结果是不是出现了和原计划矛盾的新情况。
  - 5.2 节那两道通用的条件题在这里不问，它们的意思已经在 ②、③ 里。
- 读法：
  - 升：`score` 更高各档的概率和过升档门槛，或者 ①、④ 任一道过 0.7。分档题自己可以连升几档（`decide` 反复上挪，最高 `xhigh`）；只因 ① 或 ④ 为「是」升的只升一档；两者都有时取高的那个。
  - 降：两个条件同时满足才降，`score` 更低各档的概率和过降档门槛，并且 ② 或 ③ 过 0.7。
  - 其余不动。升和降各用各的门槛。
- state 的字段：
  - `note`：按结果判断，不按助手自己的说法。
  - `request`：这一轮用户的请求。
  - `current_level`、`steps_so_far`、`failed_steps`：代码知道和数出来的。
  - `recent`：最近 5 次脚本（普通会话里是最近 5 步），从早到晚，每次三项：做了什么（脚本自带的说明和调用过的工具）、成败、结果文字的头尾。校准比过 1、3、5 次，保持 5 次。
  - `latest`：最新这一次，结果给得更长。
  - 原先还有 `stated_next`（助手最近写的下一步打算）。2026-11-19 校准之后删掉了：调整集上带着它没有多对任何一例（第 11 节第 37 条）。思考内容从来不放。
  - `progress`：进展记录（5.13 节），开着并且已经有一份时才放。
- 要换挡时，在这条结果行存下之前给它加一个 text 块（E5），下一步起每个 `turn.step` 发新档。说明是一行英文事实，例如 `[dispatch-pilot] effort is now high: the same test failed again after a fix.`，不带命令语气。
- 限制：一轮最多加 4 条说明（`midrunMaxNotes`）；两次换挡至少隔 3 个工作步（`midrunShiftGap`），这期间到达的结果行（工具结果、脚本结果）不触发评估（换不了档，问了只会按住那一行），新输入照常评估；一轮中途最高升到 `xhigh`，不升到 `max`；新档和当前档相同时不加说明。说明条数用完之后，脚本结果、步数和 `delivery` 行送进来的输入都不再触发评估（换挡要靠说明行才发得出去，问了也用不上）；作为 prompt 行进来的新输入照常评估，它的换挡不用说明、也不占条数。
- 锁定期间排着的说明不加到行上，也不丢：同一轮里解锁之后照常加上。
- Code Mode 下 `REPL` 的结果行不是 `(dispatched #N)` 回执（调用被拒或出错）时，当作普通的工具结果，结束它那一步。
- Code Mode 下说明只加在 `REPL` 或 `Poll` 的结果行上（E6），不加在 `delivery` 行上，也不加在脚本内部调用的行上。

### 5.5 派出 agent 的模型和 effort

- 判断在 `agent.spawn` 上做（E11）。事件带任务原文、agent 类型和主 agent 的模型。hook 在这里等判断，最多等到时限，然后用 `next({ ...e, model })` 定模型；effort 记进状态，由这个 agent 的每个 `turn.step` 写出。超时就原样放行，这个 agent 之后也不再改。这点等待落在派出 agent 的那一次调用上，别的调用不受影响；用户已同意（2026-11-18）。
- 2.1.327 起，第一个用某个模型的 subagent 还会等最多 1.5 秒取那个模型的设置，这是引擎自己的等待，和判断的时限相加。
- 派出时已经明写了模型的（`e.model` 有值），模型不改。明写了 effort 的（`$.agent.list()` 里它的 `effort` 有值），effort 不改。
- state 的字段：`note`、`task`（派出时的任务原文）、`agent_type`、`description`。
- 题：5.2 节的 `score` 题和两道条件题，再加一道 `noul`「这项任务是不是只需要查找或阅读信息，不用做任何改动」。effort 和模型层级都由代码里的表从这些回答算出，不问模型该用哪个模型。
- 模型层级的顺序固定为 `haiku` < `sonnet` < `opus` < `fable`，候选取 `agentModels`（默认 `haiku`、`sonnet`、`opus`）里不高于主 agent 的那些。
- **只给已知沿用主 agent 模型的类型定模型。** 调用没写模型时，agent 先用它的定义里写的模型，定义没写才用主 agent 的（类型文件 `AgentSpawnInput.model`："undefined lets the agent's own model, then the parent's, decide"）。2026-11-18 在 2.1.327 上实测（没有密钥，一个定义写了 `model: haiku` 的一次性类型，主 agent 是 Sonnet）：调用没写模型时 `e.model` 是 undefined，`next` 回答 `claude-haiku-5-5`；hook 写了 `sonnet` 时这个 agent 跑在 sonnet 上。所以按主 agent 的层级去换，会把定义里写了更低模型的类型往上换。mod 在会话状态里按 `subagentType` 记下它没给模型、调用也没写模型的每次派出：`next` 回答的模型的层级（认不出时为空）和当时主 agent 的层级，类型数有上限。只有调用没写模型、记过这个类型、记下时主 agent 的层级和现在相同、记下的层级又等于主 agent 的层级（这个类型沿用主 agent 的模型）时，才定模型（下面的往下换和 `fableAgents` 的上限都是）；别的派出一律不动模型，mod 没给模型时再记一次。代价：每种类型在一个会话里的第一次派出（主 agent 换了模型之后也一样）既不受上限，也不往下换。决策记录的 `from` 写这个类型自己的层级（沿用时就是主 agent 的），还不知道时写 `?`；因为不知道而没动模型的，`detail` 里写明。effort 的判断不受这一条影响。
- **Fable 作为子 agent 有单独的开关 `fableAgents`，默认关。** 关着时 mod 不会让沿用主 agent 模型的 agent 跑在 `fable` 上：主 agent 是 Fable、agent 没有明写模型而且它的类型已知沿用主 agent 的模型时，它的上限是 `opus`，这条是配置规则，决策模型失败时也照样执行。打开后 `fable` 才进候选。派出时明写了 `fable` 的 agent 不受这个开关影响（见上一条）。写给引擎的是别名本身，由引擎解析成具体模型（实测 `haiku` 解析为 `claude-haiku-5-5`）。主 agent 的层级按它的模型 id 里的家族名认；认不出时不改 agent 的模型，只定 effort。
- `current` 取继承值（主 agent 的当前档位；模型取继承值，受上面的上限约束）。模型只往下换，而且只在把握大时才换：门槛初值 0.8。往下一档只换到 `agentModels` 里有的层级，不在里面就保持继承值；没有候选时也保持继承值；继承的档位读不到时 effort 不定。
- 续跑的（`e.resume` 有值）、fork 出来的（`e.fork` 为真，它沿用主 agent 的缓存，换模型会丢）和 workflow 派出的 agent 不处理。agent 中途不再判断。

### 5.6 skill

- `prompt.attachment` 收到主循环的 `skill_listing` 时，解析出里面的 skill 名和说明，按名字并进会话状态里的候选集；这样候选只含引擎允许模型调用的 skill。引擎给的是增量（实测：第一次 169 条，会话中途加一个 skill 时再来一条只有它的列表），所以候选只合并、不整个替换，同名的新条目替换旧的，mod 从不清空它。然后把这条附件换成固定的一句：说明列表被收起，合适的 skill 会随消息推荐，其他的用 `dispatch-pilot:find-skill` 查。agent 的列表原样放行。`shadow` 里列表照样解析、并进候选集，但原样放行（5.10 节）。
- 发消息时的推荐照 TypeSafe cookbook 的结构和门槛（3.4 节）。第一次请求和 effort 题合并成同一次请求。需要第二次请求时才发。最多推荐一个 skill，放进 `prompt.submit` 的 `context`，内容是 skill 名、说明和「用 Skill 工具加载」的一句。不推荐时什么也不加。
- 晚到的第一份列表：会话的第一份列表在第一次 `prompt.submit` 之后才到（实测），这时候选集是空的，那条消息只问了 effort 题。这条消息（人发的、开了一轮的）开的那一轮记一个标记；这一轮里第一份主循环的列表到达时，并进候选之后就用它判断这条消息：同样的两步请求，合起来在 `submitTimeoutMs` 之内，推荐的那段接在收起列表的那句话后面，skill 决定记在这一轮上。每轮最多一次，`shadow` 里不做；请求失败时照常收起，记一条失败的 skill 决定。
- Drex 没有 skill 配方，用同一结构；门槛初值同 cookbook，校准后各存各的。「都不合适」的处理各照各的文档：Jev 用陪伴的 Noul，不加 "other" 选项；Drex 在选项里加一个 `other`。
- `find-skill`：plugin 自带的 skill（`skills/find-skill/SKILL.md`），`skill.prompt` 收到它时，用参数里的几个词对候选集做同样的两步判断，回答最多三个合适的 skill 名和说明。判断请求没成（失败、超时、第二次请求赶不上时限）时，回答照实说没查成，再列出候选集里全部的 skill 名和说明；超过约 6000 token 时每条说明截成一样长，还放不下就只列名字。列表已经被收起，没查成时不能让主 agent 比原样拿到列表时知道得更少。
- 候选超过 255 个时（Drex 每题上限）按来源分批问。

### 5.7 后端

- 接口是一个函数：`ask({ state, questions }) -> { answers, model, ms }`，`drex` 和 `jev` 各一个实现。两家的请求体都是 `state` 加 `questions`，回答字段名相同的部分直接用，不同的部分（Jev 的 `legend` 是对象、`noul` 没有 `confidence`）在各自的实现里抹平。
- 默认后端 Drex（`drex-max-v1.1`，固定版本）。另一个是 Jev（`jev-latest`）。另一个后端接手由开关 `fallback` 控制（默认关，因为 Jev 没有校准，见第 8 节）：配置了两个密钥并且开关开着时，默认后端请求失败或超时，同一次判断改问另一个，只改问一次，并在决策记录里写明是谁答的。Nace 的 skill 要求换提供方必须出自人选定的配置开关，所以这里做成开关，不写死在代码里。
- 核对回答：Drex 回答里的 `model` 和 `drexModel` 不一致时，这次调用记为错误并按失败处理（Nace skill）。Jev 用的是别名，不做这条核对，只记下实际版本（第 8 节）。每道题都要带着要求的类型回来，缺题或类型不对按失败处理。失败记录带上 `request_id`，不记密钥，也不记可能回显 state 的错误正文。
- 每次判断有总时限，到时放行：发消息 4 秒，中途检查点 2 秒，agent 3 秒，可配置。`fallback` 开着并且另一个后端有密钥时，第一次请求只用总时限的 60%，剩下的留给改问，这样默认后端超时后还来得及改问；总时限不变。这比 Nace 建议的 60 秒客户端超时短，是有意的：用户在等。Nace 的 skill 对等不起的请求路径写的是 "a shorter total budget wins over the 60-second floor"，到时按失败处理。超时的请求不重试。
- 发给决策模型的内容：用户的消息、近况和最近几步的摘要（含工具结果文字的开头），按 5.2 节的上限截断，不脱敏。这沿用用户此前对脚本结果的决定。除两家决策模型的接口外不向任何地方发送。
- 每条决策记录写下：时间、哪一项换挡、题的原始回答（分布和 noul 值）、门槛、结果、回答里的 `model` 字段、耗时、是否放行，以及之后那次请求实际带的档位（5.12 节）。存进 `$.store`，只留最近 200 条。

### 5.8 状态

- `$.state`：会话当前档位和基准档、锁定、这一轮的步数和说明数、最近几步的摘要、每个 agent 定下的模型和 effort、skill 候选集。
- 模块级变量只放相邻两个事件之间传的值（例如读数用的「现在开着的是哪一步」、进展记录的在途调用、一条消息的 skill 判断等它那一轮的 `turn.start` 来记下），注释写明丢了的代价。agent 定下的 effort 存在 `$.state` 里。
- `$.store`：决策记录。

### 5.9 界面和命令

- 看板见 5.14 节。`$.ui.status` 只在 Desktop 上用（终端会在这一行前面加 ⚠），写当前档位和最近一次换挡。
- `/dp`：打开或关上看板的面板。面板放不出来时（终端不够宽、这个端不放面板、`board` 关着），在对话里输出文字版：mod 要的档位和实际发出的档位、锁定状态、后端、最近 5 条决策。
- `/dp lock <level>` 和 `/dp unlock`：本会话锁定或解锁档位，锁定时三项 effort 判断都不做。
- `/dp log [n]`：最近 n 条决策记录，含原始回答。
- 旧的 band、脚部摘要和依据面板全部删掉，不沿用其中任何布局。

### 5.10 配置（`userConfig`）

选项在清单里的顺序就是配置界面里的顺序：一般设置 `enabled`（总开关；关掉后每个 hook 原样放行，不读不写状态，看板不画，`/dp` 回答 mod 关着）、`board`（看板，默认开；关掉后不画任何界面，只剩 `/dp` 的文字版）、`mode`（`apply` 或 `shadow`，后者只判断和记录、不改任何东西；默认 `apply`。shadow 里 skill 列表照样并进候选集但原样放行，发消息时照样问 skill 的题、记 skill 决定，不加推荐，看板上 skill 那一行写「只记录，不改」）、`backend`、`drexApiKey`、`jevApiKey`（sensitive）、`drexModel`（只有 `drex-max-v1.1` 一个可选值，门槛是在它上面校准的）、`jevModel`、`fallback`（默认关）；开关 `submitShift`、`midrunShift`、`agentShift`、`skills`（分别开关发消息定档、中途换挡、agent 定档和 skill 一组功能，默认都开）、`progressNote`（默认开，用户 2026-11-19 定的）、`progressNoteModel`（默认 `haiku`）、`verifyEffort`（默认开）；时机和限制 `midrunEverySteps`（普通会话，默认 8）、`midrunEveryScripts`（Code Mode 会话，默认 1）、`midrunShiftGap`（两次换档至少隔几个工作步，默认 3）、`midrunMaxNotes`（默认 4）、`agentModels`、`fableAgents`（默认关）、三个时限；最后是按判断分组的门槛：`submitUp`、`submitUpHigh`、`submitDown`、`submitYes`，`midrun…` 和 `agent…` 同样四个，`agentModelDown`，`skillAction`、`skillNamed`、`skillFits`（默认值见第 11 节第 42 条）。除了两个密钥，每个选项都是开关或者带 `options` 的字符串（从一列值里选），因为 `/plugin` 的 Configure 只给这两种显示默认值（第 11 节第 43 条）；`readConfig` 把选中的字读成数，也读直接给的数，越界的照旧夹到范围里。每个选项有一个短标题（不超过 14 个字，门槛的标题以判断开头，例如「发消息 · 升档门槛」）和一两句说明（不超过 70 个字）。没有密钥的后端视为不可用；两个都没有时 mod 什么也不做，并在 `/dp` 里说明。

### 5.11 放行规则

以下情况一律放行（不改 effort、不改模型、不加说明、不换 skill 列表以外的任何东西），并记一条记录：请求失败、超时、回答缺字段或题的类型不对、Drex 回答的 `model` 和固定版本不一致、模型不接受 effort（`e.effort` 缺省）、`mode` 为 `shadow`。skill 的请求失败时列表照样收起（收起不靠判断），推荐没有；`find-skill` 的判断没成时列出候选（5.6 节）。hook 自己抛错时引擎会跳过它，所以每个 hook 的主体都包在一层兜底里，保证总是走到 `next(e)`。

### 5.12 实际发出的档位（运行时读数）

由 `verifyEffort` 控制，默认开；关掉后不注册这个 hook。

- mod 挂 `http.fetch`（E15）。hook 只看 `next.origin.plugin` 为 `engine`、发往 Messages 接口的请求，从请求体里取顶层的 `output_config.effort` 这一个值，然后原样 `next(e)`。请求不改、不拦、不重发；hook 的主体包在兜底里，出错也照样放行。
- 隐私：请求体只在进程内读，留下的只有档位这一个词。请求体的其他内容不记录、不存储、不发送。凭据头对 hook 本来就是 `[redacted]`。
- 每次换挡（发消息时定的、中途换的）之后，把主循环下一次请求实际带的档位记进那条决策记录。和 mod 要的档位不一致时记为「未发出」，状态行显示实际的档位。只记录，不重试。
- 看板的状态行、脚部标签和 `/dp` 里的当前档位取这一步的主循环请求实际带的档位（这一步自己格子的读数）；这一步的请求还没读到时显示这一步写的档位，并标明未核对，不拿更早一步的读数。最近一次读到的档位记在会话上，两轮之间写「上一轮结束在 X」。
- agent 用有文档的读数：`$.agent.list()` 里它的 `lastRequest.model` 和 `lastRequest.effort`，在它第一步之后读一次，记进那条决策记录。mod 给它定了模型或 effort 的才读：模型按层级比，effort 按档名比，有一样不同就记「未发出」。mod 没动的 agent 没有可核对的东西。
- 读数分三种，看板上各有各的字：已发出（读到了，一样）、没发出（读到了，不一样）、未核对（没读到：认不准、读数关着，或者还没来）。说明还排着、没放上行的换挡写「（还没发出）」。`verifyEffort` 关着时没有换挡显示警告色。
- 读不到的情况：组织的守卫插件加载时 mod 看不到引擎请求；请求体不是文本，或取不出这个字段。这时记为「未核对」，其余功能照常。
- 认不准是不是主循环的请求时（同一时间有 agent 在用同一个模型、同一步已经读过一次、模型名对不上）：主循环的一步开着时，等核对的那条决策先记「未核对」，但继续等，下一次认准的主循环请求再写上真正的档位；没有主循环的一步开着时（两步之间 agent 或旁路的请求），什么也不改。比较模型名时，两边都去掉末尾的方括号后缀（例如 `[1m]`）。
- `enabled` 关着时这个 hook 什么也不读、不写，请求照样放行。
- 开销：每个模型请求多过一道 hook。请求体可能有几百 KB，取值的做法不能明显拖慢请求。

### 5.13 进展记录

由 `progressNote` 控制，默认开（用户 2026-11-19 定的；校准的比较看不出它有好处，见第 11 节第 41、42 条）。4.3 节的做法 B。

- 每个中途检查点之后，在后台调一次 `$.model.complete`（模型 `progressNoteModel`，默认 `haiku`；effort `low`；带时限）。hook 不等它。
- 输入：这一轮用户的请求、上一份记录、最新这一步做了什么和结果的头尾。输出是三个字段：已完成什么、还剩什么、原因查明没有，合计一百来 token。
- 写好的记录存进 `$.state`。下一次判断读现成的那一份，所以它比最新结果晚一步；还没有记录时不放这个字段。每轮开始时清掉。
- 上一次还没写完时，新的一次排在它后面，不并发写。
- 失败（接口报错、超时、用量上限、回答不是这三个字段）时保留旧记录并记一条。引擎拒绝这个模型时，这个会话不再调。
- 记录是另一个模型的说法：`note` 字段要写明它是转述，题目仍然按结果判断。
- 这些调用走会话自己的凭据，记在用户的用量里。5.12 节的读数不把它们算作主循环的请求。

### 5.14 看板

做法见 4.4 节，样子以原型为准（`docs/research/board-prototype/timeline-and-pane.html`，六个场景，面板开和关各一种）。

**两块，一份数据。** prompt 上方是时间轴，常驻；右边是分区面板，`/dp` 开关。一个纯函数从状态算出看板的数据，两块和两个端都只从这份数据画。

**现在的档位必须准。** 看板上的档位取这一步的主循环请求实际带的档位（5.12 节）。这一步还没读到时显示这一步写的档位并标「未核对」，不拿更早一步的读数。mod 要的和实际发出的不一样时两个都写出来（「要 xhigh，实际发出 high」）。「mod 要的档位」和步上写的档位出自同一个函数：mod 关着或 `shadow` 时 mod 不写任何档位，看板上「要的」就是引擎自己的档位，不会把 `shadow` 里假想的换挡显示成没发出去。

**没有执行的评估不算换挡。** 决策模型想换档但没有换成（`shadow` 模式，或者换档被拒）时，记号是「不变」，不进换挡记录，上次评估写「想升到 X，未执行」或「想降到 X，未执行」。

时间轴：

- 第 1 行：档位（五格加档名）、状态（已发出、要 X 实际发出 Y、未核对、已锁定）、第几轮第几步、会话种类。
- 第 2 行：这一轮每个工作步一格，颜色是那一步实际发出的档位。后面用虚线和一个空心记号画出下一次评估，并写「下次评估：…」。
- 第 3 行：每次评估在它那一步下面标一个记号，分四种：不变、升、降、失败。后面写最近一次换挡从哪到哪和原因。
- 一格的定义：一格是一个工作步，正在进行的那一步也有一格，所以格数就是「第几步」。普通会话里一次回答的几条并行结果是同一个工作步：第一条结果结束这一步，下一条回答之前的其余结果并进它（有一条失败就算失败，只算一次），所以「再 N 步」、换挡间隔和「连续两步报错」也都按回答数，不按结果的条数。颜色取这一步第一次请求实际带的档位。格子下面的记号是这一步之前那次评估的结果，第一格是发消息时的那次。
- 第 4 行：上次评估的结论、各条件题的值、谁答的、耗时。
- 第 5 行：生效的功能、锁定的功能、关着的功能；后端有问题时也写在这一行。
- 面板开着时只画前 3 行，同一件事不显示两遍。面板不管怎么关上（`/dp`、关闭键、卸载），时间轴马上重画，回到完整的行数。没有记号也没有换挡的一轮（例如锁定时）不画第 3 行。
- 空闲时终端折成一行：会话设定的档位、上一轮结束在哪一档、下次评估在什么时候、会话种类。
- 步数多于可用的列数时一格代表几步，并写明比例；一格里有几次评估时记号取最要紧的（失败先于升降，升降先于不变）。

「离下次评估还有多久」按触发条件写，不按时间，因为评估是事件触发的：

- Code Mode 会话：「下一份脚本结果到达时」，`midrunEveryScripts` 大于 1 时是「再 N 份脚本结果」。
- 普通会话：「再 N 步」，并注明同一失败复现或连续两步失败会提前。
- 这一轮的说明条数用完：「本轮不再换挡」。锁定：「不评估」。空闲：「发出下一条消息时」。
- 看板不预告不会发生的评估，按下面的先后取第一条成立的（mod 关着时看板整个不画，见 5.10 节的 `enabled`）：mod 关着，「不评估 · dispatch-pilot 已关闭」；锁定，「不评估 · /dp unlock 解锁后恢复」；空闲时按下一条消息实际会遇到的写（发消息定档开着并且有可用的后端，「发出下一条消息时」；没有可用的后端，「不评估」；只开着中途换挡，「下一轮中途」；两者都关着，「不评估」）；这个模型不收 effort，「不评估」（会话用数字 effort 时写「数字 effort，不判断」）；然后才是上面按触发条件写的几种，换挡间隔之内数到间隔过了的那一份结果。

面板的分区和顺序固定：

1. 现在：档位、状态、第几轮第几步和会话种类（空闲时会话种类单独一行）、最近一次换挡和原因。
2. 换挡记录：这一轮每次换挡在哪一步、从哪到哪、原因。
3. 上次评估：结论、五档的概率条（标出当前档）、每道条件题的值和读法（是、否、拿不准）、规则算到了哪一步、谁答的、耗时。失败时写原因。一轮之内只看这一轮的评估，还没有时写「本轮还没有评估」；空闲时显示上一次的评估并标明是此前的。换了档的，规则先写从新档再往同一方向挪还差多少，再写为什么到了这一档（过了哪个门槛，或者哪道条件题）；没换的写从当前档往上、往下各差多少。
4. 下次评估：触发条件，以及这一轮还能换几次挡。
5. 功能：每项一行，四种状态：生效、未生效（加原因）、关、已锁定；另有后端一行。
6. agent：这一轮派出的每个 agent 的模型和 effort，以及核对结果。没有时不显示这一区。
7. skill：这条消息推荐的 skill。没有时不显示这一区。

「生效」的意思是开关开着，并且它依赖的条件成立：有可用的后端；skill 推荐要已经拿到候选集；档位核对要最近一次读到了。开着但条件不成立的写「未生效」和原因。

两个端：

- 同一份数据、同一套布局，按 `e.surface` 换画法：终端用字符画色块和记号，Desktop 用 Svg 画轨道和概率条。vscode 和 mobile 不画，直接 `next(e)`。
- 终端：时间轴在 prompt 上方（引擎自带折叠）；面板在全屏并且约 110 列以上时停靠在右边，否则落到 prompt 上方；脚部最右边一个标签写「dp 档位 状态」。
- Desktop：时间轴在输入框上方，空闲时引擎不显示它，只剩脚部的标签和状态行；面板是侧边的一栏。树少于 2000 个节点，时间轴不超过 12 行。
- 颜色：五档各一个颜色，由冷到暖。hook 读不到会话是明色还是暗色主题，所以文字（包括档名）的颜色只用主题键，由引擎按主题给出对比度够的颜色；固定的色值只用在图形上（Desktop 的轨道和概率条）。图形里不分档位的记号用一种在明暗两种主题上都看得清的中灰（`#8b8f98`），不用 `currentColor`：Desktop 把 Svg 当图片画，`currentColor` 可能画成黑色。状态用主题键（成功、警告、错误）。给人看的文字用中文，档名照 `/effort` 的写法。
- Desktop 上一行放不放得下，文字按字符算列数，图按像素宽度算（各张图共用一个「每列多少像素」的常数），轨道能放几格也由它算出。

重画的时机：每条决策之后、每次读到实际档位之后、每个工作步结束之后。

`board` 关着时不注册渲染 hook。看板只读状态，不参与任何判断；画的过程出错不能影响换挡。

## 6. 仓库里的变化

- `dispatch-pilot/` 原地替换成新实现，plugin 名不变，版本 `1.0.0`，`engines["claude-code"]` 写 `>=2.1.327`。
- 删除 `dispatch-pilot-extras/`，同时从 `.claude-plugin/marketplace.json` 去掉它，并更新 dispatch-pilot 的说明。
- 新写一条 ADR 记这次重写和它取代的旧决定；旧 ADR 保留不动。`docs/research/board-scenes/` 按新看板重写（用原型的六个场景驱动真实的渲染，供目测），旧的场景删掉。更新 `GLOSSARY.md` 和 `CLAUDE.md` 里提到两个 plugin 的段落。 `CLAUDE.md` 里讲 Code Mode 事件限制的那一条也按 2.1.327 改，并加一条：任何会话、任何测试都不打开 OpenTelemetry。
- README 写给使用者：功能、配置、Code Mode 下的行为、测试用的 Claude Code 版本。DEVELOPMENT.md 记第 3.2 节的实测。

## 7. 测试

- `claude plugin test`：每个 hook 的行为、`decide` 的各种分布、两个后端的请求体和回答解析、放行规则、限制（说明条数、间隔、上限）、5.12 节的读数（给 hook 一个来源为 `engine` 的请求，看它记下的档位，并确认请求原样放行）。发往决策模型的 `$.http.fetch` 全部打桩，不联网。
- 一条静态检查：hooks 模块里没有 `tool.call`、`tool.check`、`tool.run`、`tool.judge`，也没有 `$.tool.register`，以保证脚本内部的调用本身不挂 hook（它们的结果行仍经过 `session.append`，那里读写状态，开销没有测过）。接进 `scripts/check.sh`。
- 看板：数据函数用六个场景做单元测试；两个端各用 `$.ui.mount` 挂载时间轴和面板，断言档位、状态、下次评估、功能状态这几处的文字，以及面板开着时时间轴只有 3 行。
- 实机：普通会话和 Code Mode 会话各跑一遍三项换挡和 skill 推荐，记进 DEVELOPMENT.md。换挡有没有发出去，看 mod 自己记下的实际档位（5.12 节，`/dp log`），不用输出量或思考量来推断。实机测试不开 OpenTelemetry。

## 8. 校准（照 3.4 节两家的说法）

校准属于这个项目，是最后一个阶段；`1.0.0` 在校准之后发布。

**用例**

- 来源首选真实流量：本机 Claude Code 的会话记录，以及 mod 在 `shadow` 模式下记下的决策记录。手写或模型写的用例只用来补真实流量里缺的难例、边界例和反例，单独标记、单独报数，因为它们比真实请求容易。
- 四类：发消息定档、中途换挡、agent 定档和模型、skill 推荐。每类都要有代表性的、难的、处在两档之间的，以及答案是「否」「保持不变」「不推荐任何 skill」的。文档页没有规定数量（Nace 的 `drexify` skill 说 "tens of labeled examples per site"，见 3.4 节的更正）；用户 2026-11-18 定每类 15 例，其中边界例和反例合计不少于三分之一。
- 用例由 Fable 5.2 在 xhigh 档设计：从真实流量里挑，缺的类别由它补写并标明。设计时照 3.4 节两家的要求逐条核对。
- 每类 15 例里 10 例用来调、5 例留出。这个量只够看出明显的差别：留出集上一例就是 20 个百分点。所以门槛只取保守的一端，对照（问法、上下文、进展记录）只在差别明显时才下结论，差别不明显的如实写「看不出」。
- 一个用例存：mod 实际会发的完整请求（state 和题）、期望结果（期望档位或可接受的范围、是或否、期望的 skill 或「无」）、来源、难度、属于调整集还是留出集。回答原样存下来，重算门槛时不用再发请求。

**参考答案**

- 由 Fable 5.2 在 xhigh 档读完整上下文后给出（真实流量的用例包括这一轮后来实际怎么走的），写明是模型标的；用户抽查，抽查改动过的用例标为人工标注。

**调整和验收**

- 用例分调整集和留出集。措辞和门槛只在调整集上改，每次改动都在没用来调的用例上复查；留出集只在最后算一次分，报告里的数字来自它。
- 比较措辞时，每种写法各发一份和 mod 相同的请求，对同一个 state 问，各问 3 遍。逐条看回答，不只看汇总。（2026-11-19 更正：原先写的是把几种写法作为同一请求里的不同题来问；同一请求里的题会互相影响，见 3.4 节。）Score 的各档说明先在几个样例上试，改写后在另一批输入上验证再留下。
- 问法的对照：两家都没有 effort 路由的官方配方，Nace 的例题和它文档收录的社区实现用的又是直接选档位的写法。所以在调整集上把两种问法放进同一请求比较：默认的「问工作本身，代码查表」，和「一道题直接选档位，各选项的说明写成情形」。后者在调整集上多对至少 2 例、并且 `check` 上不比默认差时，才在那个后端换用，并把依据写进校准记录；否则保持默认。（2026-11-19 更正：原先写的是看留出集；留出集不参与任何取舍，第 11 节第 40 条。）
- `score` 题只量问题有多开放。要不要另加一道判断来管「连续很多步、中间没有人看着」的工作，照问法对照的同一条规则在调整集上定；没有用就不加（同上更正）。
- 上下文的对照：同一批用例比较几种给法，调整集上没有改善的字段删掉（同上更正）。发消息时比带不带 `previous_turn`；中途比 `recent` 取 1、3、5 次，比带不带 `stated_next`。
- 进展记录的对照（4.3 节）：同一批中途用例比三种，不带记录、带截至上一步的记录（做法 B）、带包含最新一步的记录（做法 C 的效果，离线可以算出来）。重点看「看似收尾」「批量机械」「卡住」这几类。结果和门槛一起报给用户，由用户定最终用哪一种、要不要加；选 C 意味着放宽中途的时限。
- 中途的用例里，答案是「保持不变」的不少于一半。另报一个数：`midrunEveryScripts` 为 1 时，每个检查点上无谓换挡的比例。
- 门槛从保守的初值起步。在调整集上画出概率和正确率的关系，按每种动作出错的代价定（升档、降档、换模型、推荐 skill 各自一张表），在 `fit` 上取、到 `check` 上核对（2026-11-19 更正：原先写的是到留出集上核对）。一段很宽的门槛范围结果相同时取保守的一端。
- 不做的事：criteria 里点名用例或为每个失败用例加一句；为解释某次怪回答加说明；让门槛贴着个别用例；测试里断言精确概率（单元测试只用打桩的回答）；用代码悄悄改写回答。回答看着不对时按这个顺序查：实际发出的请求、state、选项、题的范围、措辞。
- 稳定性：skill 的 Choice 把选项顺序打乱再问一遍，结果变了的用例单独列出；同一请求重复问，看决定会不会变。
- 中途换挡的验收分两层。发没发出去：看 mod 记下的每次请求实际带的档位（5.12 节），这是确定的。有没有用：在真实任务上比较换挡和不换挡两种情况下这一轮的结果（做对没有、用了多少步和多少 token），不用单步的输出量或思考量来判断（E14）。看不出效果时如实写进校准记录并告诉用户，这项功能留不留由用户定。

**版本**

- 只校准 Drex `drex-max-v1.1`，Jev 不参加测试（用户 2026-11-18 定）。校准记录写明模型版本。
- 出题和回答的 agent 都明写模型 `fable` 和 effort `xhigh`。跑之前确认已装的旧版 dispatch-pilot 关着，免得它改动这些 agent 的模型或 effort。
- Jev 因此没有校准过的门槛：它用 TypeSafe 文档的起步值，`/dp` 和决策记录里标明「未校准」。所以 `fallback` 的默认值改为关，要让 Jev 在 Drex 失败时接手，由用户自己打开。

**发真实请求之前**

- 先向用户说明并取得同意：预算、会发送哪些会话内容、用的是用户自己的 Drex 和 Jev 密钥。
- 校准和实机测试都不打开 OpenTelemetry。

**上线**

- 先用 `shadow` 模式在真实会话里跑，看记录再打开 `apply`。决策记录保留原始回答，以后调门槛可以拿旧记录重算。

## 9. 留给实施者

- 各题的具体措辞、各档情形的文字、条件题的最终清单和代码里那张表的具体内容，以校准结果为准；约束见 5.2 节和第 8 节。
- 一步里有多个并行工具调用时说明加在哪一条结果行上（实测每个结果各有一行）。
- 一轮中途进来的新输入（用户插话、后台任务通知）那一步改的档位发不发出，还没单独测；按引擎规则应当发出，实施时用 5.12 节的读数补测。
- `agent.spawn` 的 `next` 返回 `agentId` 之后才能按 id 记下 effort。实测它比 agent 的第一个 `turn.step` 早约 70 ms（E11）；实施时要处理万一倒过来的情况。
- 进展记录的提示词怎么写、三个字段的具体形状。中途四道条件题和降档「两个条件」的最终形式以校准为准。
- 5.12 节的读数：怎么从引擎的请求里认出主循环的那一次（同一时间还有 agent 的请求和标题、提示建议一类的旁路请求），以及怎么取值才不拖慢请求。实测的线索，都没有文档，不能只靠它们：主循环的请求在它的 `turn.step` 开始后几到二十毫秒内发出；它的请求体带 `thread` 字段，旁路请求不带。认不准时记为「未核对」，不要记错。
- 主 agent 的中途换挡是必须保留的功能：第 8 节的效果验收不通过时，停下来告诉用户，不要自行降级成做法二。
- `$.http.fetch` 在 2.1.327 的超时和取消方式，以及时限怎么和 hook 的 10 秒预算配合。
- 说明行在终端里的显示（E8）要不要改写法。
- 状态的具体形状、文件划分、`/dp` 输出的排版。
- 看板要在 2.1.327 上实测的事（调研是在 2.1.289 上做的）：挂渲染 hook 的 mod 是否仍然不挡 Code Mode；Desktop 上实际的样子（此前一次都没亲眼见过）；脚部标签和状态行在两个端的表现；记号字符在终端里是不是单宽；终端的轨道用字符还是 Raster。和设计不符时停下来告诉用户。
- 看板各处的具体字符、颜色值、间距，以原型为起点，实机上调整。

## 10. 我替用户做的决定（请在读的时候核对）

1. Drex 作默认，Jev 作另一个后端并在 Drex 失败时接手；接手做成开关 `fallback`，默认关（Jev 不参加校准，这个默认值是我改的）（Nace 的 skill 要求换提供方出自人选定的开关）。核心版没有看图功能，所以没有「带图给 Jev」这条。
2. `jev-latest` 按用户要求用别名；每条记录写实际版本，和校准时的版本不一致就提示重新校准。TypeSafe 文档的建议是固定版本，可以用 `jevModel` 改。
3. 用决策模型选档的做法：用户 2026-11-18 在三种里选了「分档题加条件题，代码定档」（4.2 节）。`score` 题只量问题有多开放，不量工作量（TypeSafe：一题一个维度）。门槛初值取 0.7/0.3 的起步值，高档更严，发布前校准；Drex 的门槛不照搬 TypeSafe 的数。
4. 中途检查点：Code Mode 会话里每到达 N 次脚本结果判断一次，`midrunEveryScripts` 默认 1（用户 2026-11-18 定）；普通会话里是失败成簇和每 8 个工作步；两种会话都算新输入。一轮最多 4 条说明；中途不升到 `max`。
5. agent 的模型只往下换、只在把握大时才换，层级 `haiku` < `sonnet` < `opus` < `fable`，不高于主 agent，只换已知沿用主 agent 模型的类型（第 11 节第 27 条）。`fableAgents` 关着时（默认），沿用主 agent 模型的 agent 最高到 `opus`；派出时明写的值不改，包括明写的 `fable`。判断在 `agent.spawn` 上做，最多等 3 秒（用户 2026-11-18 同意）。
6. 时限 4 秒、2 秒、3 秒，短于 Nace 建议的 60 秒（Nace 的 skill 允许等不起的路径用更短的总时限），超时不重试。
7. 看板：我原先决定不做，用户 2026-11-18 指出漏了。旧看板整个删掉；新看板由我设计，用户在四种风格里选了时间轴加分区面板（4.4、5.14 节）。配置从 40 项减到十几项，加了 `shadow` 模式。
8. 版本号 `1.0.0`，删除 `dispatch-pilot-extras`。
9. agent 的 skill 列表不动，只收起主循环的。
10. 发给决策模型的内容不脱敏，只截断，沿用此前对脚本结果的决定。
11. 校准算在这个项目里，不用旧评测集；用例首选本机真实会话记录，用例和参考答案都由 Fable 5.2 在 xhigh 档做、用户抽查，每类 15 例，只测 Drex（用户 2026-11-18 定）；默认 `apply`，校准后才发 `1.0.0`。
12. 主循环中途换挡若效果验收不通过，停下来问，不自行降级。档位有没有发出去已在两种会话的主循环上直接测到（E6、E15）；一次测试里档位发出去后模型的做法没有明显变化（E14），已告诉用户。
13. Drex 回答的 `model` 和固定版本不一致时按失败处理并放行（照 Nace 的 skill）；Jev 用别名，只记版本并提示重新校准。
14. 最低版本提到 2.1.327。不注册 `tool.call`，依据只从结果行读。
15. 运行时读实际发出的档位，`verifyEffort` 默认开（用户 2026-11-18 定）。我定的细节：只记录和显示，不一致时不重试；状态行显示实际的档位；agent 用 `lastRequest` 读一次；读不到时记「未核对」。
16. 任何会话都不打开 OpenTelemetry，测试和校准也不开（用户 2026-11-18 定）。
17. 中途的题、读法和上下文（5.4 节）是我 2026-11-18 提给用户的方案，用户已同意：四道中途专有的条件题；升档看分档题或 ①、④，降档要两个条件同时满足；把助手写的下一步打算发给决策模型，思考内容不发（下一步打算在 2026-11-19 校准之后删掉了，第 11 节第 37 条）。
18. 发消息时带上一轮的情况（`previous_turn`），我提的方案，用户已同意。
19. 进展记录：用户 2026-11-18 选了先做后台写的那种（做法 B），最终用哪一种、要不要加，由找门槛的那轮测试对比后定。校准前开关默认关。（2026-11-19 校准时比过三种给法，调整集上都全对，看不出好处；用户 2026-11-19 定下默认开，第 11 节第 42 条。）
20. 看板里我定的细节（5.14 节）：面板开着时时间轴只留 3 行；空闲时终端折成一行；「下次评估」按触发条件写而不是倒计时；「生效」的定义；面板的七个分区和顺序；`board` 开关。
21. 实施和校准期间不让已装的旧版改动派出的 agent（用户 2026-11-18 的要求）：开始实施前把已装的 `dispatch-pilot@alex-mods` 关掉并确认。校准出题和回答的 agent 用 `fable`、`xhigh`。2026-11-18 查过 Claude Code 的设置：没有限制子 agent 模型的项，Agent 工具的模型列表里有 `fable`，不用另加。
22. 写实施计划时补的三处（2026-11-18，5.4 和 5.14 节已同步）：时间轴一格的定义；文字的颜色只用主题键；说明条数用完后不再按脚本结果评估。

## 11. 实施中定下的事

按计划实施时（2026-11-18）定下的、改变或补充了上面行为的事。上面各节里和它们不符的句子已经改过来了。

1. **一条消息的决定绑在它开始的那一轮上。** 实测引擎在 `prompt.submit` 的 `next(e)` 里触发 `turn.start`（它的 hook 在那里开始，可能在 `next(e)` 返回之后才结束，第 0 步等它），带的就是交下去的文字。所以发消息时的决定在 `next(e)` 之前写下，`turn.start` 只在文字相同时留下它，否则清掉；`next(e)` 回答 `drop` 时也清掉；送进一轮进行中的消息（`e.turnId` 有值）不在发消息时判断，由中途的新输入检查点处理。对不上时丢掉这次决定，等于放行，不会用到别的一轮上（5.3 节）。
2. **没有在发消息时定档的一轮也有基准档。** 第一步时把引擎带来的档位记作基准档，这样 `submitShift` 关着、或者由通知和别的会话开始的一轮也有中途判断，看板也有档位可显示（5.3 节）。
3. **中途升档可以连升几档。** 分档题自己按 `decide` 反复上挪，最高 `xhigh`；只因「同一失败又出现」或「和计划矛盾」为「是」升的只升一档；两者都有时取高的那个。这是 5.2 节「升一档，再对新的一档重复」的读法（5.4 节）。
4. **agent 的几处空白。** `xhigh` 上条件题为「是」时保持；往下一档只换到 `agentModels` 里有的层级，否则保持继承值；没有候选时保持继承值；继承的档位读不到时 effort 不定（5.5 节）。
5. **state 的上限在发请求的那一处统一保证。** 各字段先按自己的预算截断；JSON 转义可能让序列化后的 state 超过 4000 token，所以 `ask` 发出前再统一缩短最长的几个字段，直到放得下：约束说的是发出去的东西，`ask` 是唯一发出去的地方（5.2 节）。
6. **fallback 的时间分配。** `fallback` 开着并且另一个后端有密钥时，第一次请求只用总时限的 60%，剩下的留给改问；总时限不变；没有第二个密钥时第一次请求用满时限（5.7 节）。
7. **不是回执的 `REPL` 结果行当作普通工具结果。** 调用被拒或出错时 `REPL` 的结果行不是 `(dispatched #N)`，它要结束它那一步，否则这一步永远不关（5.4 节）。
8. **只有 prompt 行进来的输入自己带着换档。** `delivery` 行送进来的输入和 `delivery` 行上的脚本结果一样带不了换挡（E13），说明排到之后第一条 `REPL` 或 `Poll` 的结果行上，也占说明条数；说明用完之后它也不再触发评估。代价是这种换挡晚一次请求生效（5.4 节）。
9. **锁定期间排着的说明留着。** 不加到行上，也不丢，同一轮里解锁之后照常加上；没有它，想要的档位就发不出去（5.4 节）。
10. **skill 候选只合并。** 引擎给的 skill 列表是增量（实测：第一次 169 条，会话中途加一个 skill 时再来一条只有它的列表），所以候选按名字合并，同名的新条目替换旧的，mod 从不整个替换或清空。丢了候选的代价是每次推荐都没有，留着一个已删的 skill 的代价最多是一次推荐错（5.6 节）。
11. **读数拿不准时的规则。** 一个主循环的步开着时读到认不准的请求（同一时间有 agent 用同一个模型、同一步已经读过、模型名对不上），等核对的决策先记「未核对」但继续等，下一次认准的主循环请求再写上真正的档位：Code Mode 里脚本派出的 agent 常在说明加上之后马上发请求，主循环的下一次请求仍然能核对这次换挡。两步之间读到的（agent 或旁路的请求）什么也不改。比较模型名时两边都去掉末尾的方括号后缀，因为 `[1m]` 这类后缀在哪一边留着没有测过（5.12 节）。
12. **`enabled` 关着时读数什么也不做。** 关掉的 mod 显示的档位没有意义（5.12 节）。
13. **决策记录里的实际档位两份都写。** `$.store` 的 `log` 和 `$.state` 的 `recent` 里同一条决策的 `sent` 都改，因为看板读的是 `recent`。
14. **没有执行的评估不算换挡。** `shadow` 模式或换档被拒时，记号是「不变」，不进换挡记录，上次评估写「想升到 X，未执行」或「想降到 X，未执行」：看板要准确显示档位什么时候换了，而这时它没换（5.14 节）。
15. **「下次评估」不预告不会发生的评估。** 按 mod 关着、锁定、空闲（按下一条消息实际会遇到的写）、这个模型不收 effort 的先后，再按触发条件写（5.14 节）。
16. **看板上「要的档位」和步上写的档位出自同一个函数。** mod 关着或 `shadow` 时 mod 不写档位，看板上「要的」就是引擎自己的档位；此前 `shadow` 里的假想换挡会让一整轮显示「要 high，实际发出 medium」（5.14 节）。
17. **上次评估的规则行。** 换了档的，先写从新档再往同一方向挪还差多少，再写为什么到了这一档；没换的写从当前档往上、往下各差多少。只照当前档写的话，已经发生的换挡读起来像一个还没满足的条件（5.14 节）。
18. **一轮之内只看这一轮的评估。** 还没有时写「本轮还没有评估」；空闲时显示上一次的评估并标明是此前的；第几步按工作步数，不管模型收不收 effort（5.14 节）。
19. **面板关上时马上重画时间轴。** 挂一个 `ui.close` 的 hook（引擎对插件关、人关、卸载都触发它），关上之后重画，时间轴回到完整的行数；否则在下一次写状态之前，上次评估和功能哪里都看不到（5.1、5.14 节）。
20. **图形里的中灰。** 不分档位的记号用固定的 `#8b8f98`，不用 `currentColor`：Desktop 把 Svg 当图片画，`currentColor` 可能画成黑色（5.14 节）。
21. **Desktop 上按像素排一行。** 文字按字符算列数，图按像素宽度算，各张图共用一个「每列多少像素」的常数，轨道能放几格也由它算出（5.14 节）。
22. **入口按功能拆开。** 入口文件到第 12 个任务时已有七百多行，所以拆成：`hooks/dispatch-pilot.ts` 只留 `register`、各 `on(...)` 和每个事件里各功能动手的先后；每个功能碰 `$` 的代码放进 `hooks/flows/` 下自己的文件，写成以 `$` 为参数的顶层函数（validate 允许从本 mod 的文件导入这样的函数）；共用的部分放进 `hooks/runtime.ts`；发消息和派出 agent 的纯判断代码放进 `hooks/submit.ts` 和 `hooks/agents.ts`。行为不变。
23. **atom 在用它的文件里各声明一次。** 实测从别的文件导入的 atom 会让模块加载失败，所以每个文件各自声明自己用到的 atom，一个一行，`eval/validate.ts` 检查同一个 key 的声明逐字相同。
24. **状态契约自成一体。** `claude plugin validate` 不许 `types/index.d.ts` 里有任何 import，所以契约自己写出状态的形状，`hooks/state.ts` 里有一处编译期核对两边一致。
25. **看板场景有两份。** plugin 只能导入自己目录里的文件，所以目测探针 `docs/research/board-scenes/` 里的场景是 `tests/support/scenes.ts` 的原样拷贝，`eval/validate.ts` 检查两份一字不差。
26. **`scripts/check.sh` 接受只有 TS5097 的报告。** Claude Desktop 自带的 2.1.325 的 validate 对每个以 `.ts` 结尾的相对导入都报 TS5097，不接受的话每次提交都过不去。
27. **agent 的模型只在已知这个类型沿用主 agent 的模型时才动。** 调用没写模型时，agent 先用它的定义里写的模型（类型文件和 2026-11-18 的实测，见 5.5 节），所以「调用没写模型」不等于「沿用主 agent」，按主 agent 的层级去换会把定义写了 `haiku` 的类型往上换，没有密钥时 `fableAgents` 的上限也会这样做。mod 按 `subagentType` 记下它没给模型的派出实际用的模型和当时主 agent 的层级，只给记下时主 agent 层级相同、记下的层级就是主 agent 的层级的类型定模型，往下换和上限都一样；effort 的判断不变。代价：每种类型在一个会话里的第一次派出（主 agent 换了模型之后也一样）既不受上限，也不往下换（5.5 节）。
28. **看板要的这一轮的评估记在这一轮上。** 换挡记录、最近一次换挡和上次评估取自 `turn` 上记下的这一轮的换挡（条数不超过说明条数加发消息那一次）和最后一次评估，空闲时的「此前」取一轮结束时留在会话上的那一次，不从只留 30 条各种决策的 `recent` 里找：一轮里几十份脚本结果或几十个 agent 就会把它们挤出去（5.14 节）。
29. **什么都没问、什么都没改的 agent 派出不记决策。** 只有上限改了模型的照样记一条（5.5 节）。
30. **三种读数，三种字。** 换挡和 agent 的读数分「已发出」「没发出」「未核对」三种，各有各的字；「（还没发出）」只留给说明还排着、没放上行的换挡。状态行和脚部标签取这一步自己格子的读数，这一步还没读到就是「未核对」，不拿更早一步的读数（同一模型的 agent 在跑时主循环的读数会认不准）。agent 只在 mod 给它定了模型或 effort 时才有读数，模型从 `lastRequest.model` 读回，按层级比（5.12、5.14 节）。
31. **一次回答的结果是一个工作步。** 普通会话里一次回答并行调了几个工具，回答之后的第一条结果结束这一步，下一条回答之前到达的其余结果并进这一步的记录（工具名加进去，有一条失败就算失败，结果文字取失败的那条，否则取最后一条），不再给工作步、失败步和连续失败计数；并进来的结果只有把这一步变成失败时才可能是检查点，而且只按失败成簇算，不按步数算。按每条结果数步时，三条并行结果会算成三步，「再 N 步」和换挡间隔在一次请求之内就走完，两条并行的失败会被当成连续两步报错（GLOSSARY、5.14 节）。Code Mode 的回执和脚本结果不变。
32. **skill 的三处补齐。** 第一条消息早于第一份列表时，到列表来时再判断那条消息（每轮一次，不在 shadow 里做）；`find-skill` 没查成时列出记下的候选（约 6000 token 以内），因为列表已经收起，查不成就什么也不给会让主 agent 比不装 mod 时更差；shadow 里列表记下候选、照样问 skill 的题并记决定、不加推荐，这样 shadow 跑出来的记录能看出 skill 推荐会怎么判断（5.6、5.10、5.11 节）。代价：晚到的那次判断让那份列表的附件多等两次请求（合起来不超过 `submitTimeoutMs`）。
33. **换挡间隔之内不问结果行。** 上次换挡之后不足 `midrunShiftGap` 个工作步（默认 3）时换挡反正会被拒绝，工具结果和脚本结果的检查点就不问，免得把行按住；新输入照问，它的评估照样记下（5.4 节）。看板的「下次评估」按这条数（5.14 节）。
34. **总开关关着就什么也不做。** `enabled` 关着时 hook 不读不写状态，看板不画，`/dp` 只回答 mod 关着；之前关着的 mod 照样在每一行和每一步上写状态、画时间轴（5.10 节）。
35. **一条消息的 skill 决定由它的轮记下。** 2.1.328 实测 `prompt.submit` 的 `next(e)` 在 `turn.start` 的 hook 开始之后、可能在它结束之前返回，所以 skill 判断一直放着，直到同一段文字的 `turn.start` 带那一轮的 id 记下它；`prompt.submit` 只在消息被丢掉时记成没有轮，没有轮来取的在下一次 `prompt.submit` 开始时记成没有轮、未执行并放掉（那条消息有没有自己的判断都一样），每个判断只记一次（5.6 节）。

### 校准定下的（2026-11-19）

只校准了 Drex `drex-max-v1.1`（第 8 节），Jev 没有参加。用例、每一步的表和重算的命令在 `dispatch-pilot/eval/CALIBRATION.md`。

36. **只说接着做的消息沿用上一轮的档位。** 续做题读作「是」并且上一轮的档位已知时，这一轮就是上一轮的档位，`open`、「机械改动」「原因未知」三道题都不再挪动它；续做题拿不准，或者不知道上一轮的档位时，照旧从会话设定的档位按 `open` 和条件题挪。上一轮的档位是代码知道的事，代码直接用；调整集上，在 mod 实际发的请求里，决策模型把一句光秃秃的「继续」读成「做法已经给定」（第 0 档），于是从 `xhigh` 降到了 `low`。这条是看过 `fit` 的两例之后定的（两例都变对），`check` 上没有变差，记录里写明了。代价：一句「继续」开始的工作比上一轮难时，这一轮停在上一轮的档位，只能靠中途换挡升上去；调整集里有上一轮的用例期望的都是上一轮的档位或旁边一档，看不出这一点（5.3 节）。
37. **中途的 state 不再有 `stated_next`。** 调整集上带着它没有多对任何一例，照事先定的规则删掉；中途 state 的 `note` 里提到它的那句也删了（5.4 节）。
38. **门槛只挪了一个。** Drex `drex-max-v1.1` 派出 agent 时降一档的门槛从 0.70 改到 0.95，其余都是初值（升档 0.7、升到 `xhigh` 和 `max` 0.8、降档 0.7、是非题 0.7 和 0.3、换模型 0.8；skill 的 0.3、0.5、0.3）。门槛的默认值和题一起放在 `hooks/questions.ts`（`DEFAULT_BARS`），`hooks/decide.ts`、`hooks/skills.ts` 只留读法，门槛从配置传进来，不管哪个后端回答都用同一组。校准时门槛按后端和模型查表（`thresholdsFor`、`skillBarsFor`），别的 Drex 版本和 Jev 读的是初值；那张表已经去掉。留出集没有证实这次改动：派出 agent 的留出 5 例在 0.70 下对 4 例，在 0.95 下对 2 例。按第 40 条，留出集的结果本身不改配置；用户 2026-11-19 定下留在 0.95，做成选项 `agentDown`（第 42 条）。
39. **校准问的就是 mod 实际发的请求。** 发消息时是档位题加 skill 第一次请求的题，中途和派 agent 时只有各自的题，都不带对照题；skill 的第一次请求也带着档位题。原因是实测同一请求里的题会互相影响（3.4 节）：只打乱一道题的选项顺序，按别的题读出来的决定 30 例里变了 6 例；去掉两道对照题，对一句光秃秃的「继续」，`open` 第 0 档的概率从约 0.5 变到 0.8。所以门槛是跟着这一份请求定的，请求里加一道题或去掉一道题，调整集都要重新问、门槛重新扫。比较措辞时也不再把新旧两种写法放进同一请求，而是各发一份和 mod 相同的请求，各问 3 遍。发消息时 mod 的请求其实有三种：上面说的是有候选 skill 时的那一种；没有候选时（每个会话的第一条消息，列表在它之后才到，见 5.6 节；`skills` 关着时的每条消息）只有档位题；`submitShift` 关着或档位锁定时只有 skill 的题，和档位门槛无关。第二种不在校准的取舍里，是事后在调整集上作为观察问的（给法 `first-message`，Ruling C41）：10 例的决定和第一种全部相同，概率并不都相同；其中只有没有上一轮的 5 例是会话的第一条消息，另外 5 例代表 `skills` 关着时的消息；这不是公平的测试，留出集没有用它问过（修订 A1），所以会话第一条消息上的门槛只靠这 5 例的吻合。有候选时请求的样子还随用户自己的 skill 列表变：校准用的是一份 169 个 skill 的快照，skill 的题是一道 choice；超过 250 个就是两道。
40. **判定的规则。** 跑之前定下的：问法、加题、删字段、`recent` 条数、门槛、稳定性和验收各有一条规则；所有取舍只在调整集上做，`fit` 上选、`check` 上确认；门槛按各自的网格扫，取对得最多的那一段里保守的一端，没有哪一例卡得住的门槛保留初值；留出集只问一次、只报数，它的结果本身不改任何配置。看过调整集上扫门槛的表之后才加的两条，记录里写明了：一个门槛的初值已经落在对得最多的那一段里时，保留初值（这一条只会让门槛留在初值，不会让它挪得更远）；同一类的两个门槛依次扫，不同时挪（派 agent 的降档门槛先挪，换模型的门槛在它之下再扫一遍，结果整个网格都一样，保留初值 0.80）。
41. **没有改的。** 问法不换（直接选档位的问法、加一道「长时间无人看管」的题，在调整集上都更差）；档位说明的措辞不改（另一种写法试过，撤回）；`previous_turn` 留着；`recent` 保持 5 条；skill 的门槛不动。最终配置下调整集对 9、10、7、9 例（每类 10 例，取舍都在这些用例上做，不是公平的测试），留出集对 3、3、2、4 例（每类 5 例）。进展记录在调整集上三种给法都全对，看不出好处；真实任务上的验收（8 对运行，两边都全过，token 的中位数低约 5%，进展记录都关着）按事先的规则看不出中途换挡有用。这两项和第 38 条的门槛怎么定，见第 42 条。

### 用户定下的（2026-11-19）和选项（修订 A17）

42. **用户的四个决定，以及每个可调的参数都是选项。** 用户定下：派 agent 的降档门槛留在 0.95，做成选项 `agentDown`，说明里写可以调到 0.70；进展记录默认开；中途换挡默认开；只说接着做的消息沿用上一轮档位的规则（第 36 条）保留。另外要求每个可调的参数都是插件配置里的选项，显示默认值，配一两句好懂的说明（修订 A17）。哪些算（Ruling C43）：改变 mod 拿回答做什么、什么时候问的数和开关都是选项——每个会改变决定的门槛（按判断分：发消息、中途、派 agent 各有 `up`、`upHigh`、`down`、`yes`，派 agent 还有 `modelDown`；skill 有 `action`、`named`、`fits`）、检查间隔、两次换档的间隔（`midrunShiftGap`，原来是常数 3）、条数上限、时限、模型列表；读作「否」的 `no` 不改任何决定（只用在面板上显示读法），发消息和中途不读 `modelDown`，这几个不是选项。决定请求长什么样的数（state 的预算、`recent` 的条数、各字段的截断、短名单和每批的大小）不是选项：改它们就改了校准问的东西；存储和绘制的尺寸、时限内部的分配也不是。门槛的选项对哪个后端回答都用，默认值是在 `drex-max-v1.1` 上校准的那组（`agent.down` 0.95，其余是起步值）；原来按后端和模型查的表去掉了：只有一处来源，界面上显示的就是用的。代价：Jev 的 `agent.down` 默认从起步值 0.70 变成 0.95（Jev 没有校准，默认也不用）；想把决定请求形状的数做成选项的，要另提。默认值放在 `hooks/questions.ts` 的 `DEFAULT_BARS`，`hooks/config.ts` 按它读选项，清单里再写一遍，`eval/validate.ts` 核对两边一致。
43. **除了密钥，选项都是开关或从一列值里选。** 实测（2.1.328）`/plugin` 的 Configure 只给布尔和带 `options` 的字符串显示默认值，`number` 和普通字符串没设时是空的（Ruling C44）。所以门槛、间隔、条数、时限和模型都写成带 `options` 的字符串：门槛的可选值是扫门槛的网格（`up` 等 0.50 到 0.95，skill 的 `action`、`fits` 0.10 到 0.60，`named` 0.30 到 0.80，每隔 0.05）。存下的值不在可选值里时按默认值读，启动时有一句提示；README 写了升级时怎么办。
