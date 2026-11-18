# dispatch-pilot 重写：原生适配 Code Mode（设计）

日期：2026-11-17　分支：`dp/rewrite`　Claude Code：2.1.326　修订：2026-11-18

## 1. 意图

dispatch-pilot 用 Claude 之外的决策模型替主 agent 定 effort、替派出的 agent 定模型和 effort。上一版为了适配 Code Mode 拆成了两个 plugin、两条代码路径。这次从零重写，不沿用旧代码和旧注释，让同一套代码在普通会话和 Code Mode 会话里行为一致，并且不抵消 Code Mode 带来的收益。决策模型的问法、读法和参数严格照 Nace 和 TypeSafe 现行官方文档。

## 2. 目标、非目标、反目标

**目标**

1. 三项换挡都保留：发消息时定 effort；一轮中途换 effort；派出 agent 时定模型和 effort。
2. skill 一组功能保留：去掉引擎的 skill 列表、发消息时推荐、`find-skill`。
3. 单个 plugin，只注册 Code Mode 允许的事件，两种会话走同一条路径。
4. 决策模型默认 Drex `drex-max-v1.1`，另一个后端是 Jev `jev-latest`。
5. 任何决策失败或超时都放行，会话照没有这个 mod 时那样继续。

**非目标（这次不做，以后各自立项）**

失败升档、未解决次数、长期约束、摘要、看图核对、截图接管、图片路由、Workflow 专门处理、依据面板（pane）、pplx 和 Liquid 后端。

**反目标（做到了也算失败）**

- 装上后 Code Mode 不能启动。
- 往上下文里加固定内容，或让固定内容比不装时更多。
- 给脚本内部的工具调用加等待。
- 换主 agent 的模型，或以别的方式让主 agent 的 prompt cache 失效。
- 决策模型不可用时卡住用户的消息。

## 3. 约束

### 3.1 Code Mode

- Code Mode（实验功能，2.1.323 起，只在交互终端可用）不和挂了以下事件的 mod 一起开：`tool.call`、`tool.check`、`tool.judge`、`tool.run`、`agent.offer`、`agent.spawn`、`session.send`，以及 `classic.PreToolUse`、`classic.PermissionRequest`、`classic.PermissionDenied`、`classic.PostToolUse`、`classic.PostToolUseFailure`、`classic.TaskCreated`、`classic.TaskCompleted`、`classic.Elicitation`、`classic.ElicitationResult`、`classic.WorktreeCreate`。引擎按 hooks 模块的静态扫描判定，不看 matcher。
- 所以 `$.tool.register` 注册的工具不能用（它靠 `tool.call` 回答）。
- Anthropic 没有专讲 Claude Code Code Mode 的博客，官方只有文档页（https://code.claude.com/docs/en/code-mode ）和 changelog。收益来自更少的固定工具说明和不进上下文的中间结果。本设计按第 2 节的反目标来保护它。

### 3.2 引擎行为（2.1.326，2026-11-17 用一次性探针实测，探针不进仓库）

| # | 行为 | 普通会话 | Code Mode 会话 |
|---|---|---|---|
| E1 | 挂了 5.1 节全部九个事件的 mod 不挡 Code Mode；`prompt.submit`、`prompt.attachment`（`skill_listing`）、`turn.start`、`turn.step`、`session.append`、`turn.complete`、`command.run` 在 Code Mode 会话里都实际触发过，`skill.prompt` 只验证了注册不挡 | — | 已测 |
| E2 | agent 的 `turn.start` 上 `e.text` 是派出时的任务原文，`e.agentId` 是它的 id | 已测 | 已测 |
| E3 | agent 的 `turn.step` 上 `next({ ...e, model })` 生效：`$.agent.list()` 的 `lastRequest.model` 是改后的模型（Sonnet 5.5 改 Haiku 5.5）。改写只管一步，每步都要重写 | 已测 | 未单独测（同一引擎路径） |
| E4 | 在只带工具结果的步上改 `effort` 不发出：`lastRequest.effort` 仍是原档 | 已测（agent 循环） | — |
| E5 | 在 `session.append`（door `tool-result`）里、`next` 之前给结果行加一个 text 块，下一步改的 `effort` 就发出，并保持到之后只带工具结果的步 | 已测（agent 循环，Sonnet 5.5 和 Haiku 5.5） | 已测（Code Mode 会话里的 agent 循环） |
| E6 | 主循环的 E5 | 未能直接读出（引擎不给主循环的 `lastRequest`）；core 收到了改后的值 | 同左 |
| E7 | Code Mode 下主循环的行：请求会带上的结果行是 `tool-result`、`origin.tool` 为 `REPL` 或 `Poll`、`message.role` 为 `user`。脚本内部调用（`Read`、`Agent` 等）也各有一条 `tool-result` 行，但 `message.role` 缺省，请求不带它 | — | 已测 |
| E8 | 加在结果行上的 text 块在终端里显示成一行以 `❯` 开头的文字 | — | 已测 |
| E9 | 环境变量 `CLAUDE_EFFORT` 不反映 hook 改写的档位 | 已测 | — |

类型文件对 E4、E5 的原文（`TurnStepInput.effort`）："A rewrite lasts one step. On a model that takes effort per message, a level on tool results alone is not sent if another is in force, and one on a step with input stays for later tool steps whose `effort` is a level."

E6 的依据是同一条引擎规则加上 agent 循环的实测；上一版在 2.1.326 上也报告过主循环可用。实施时按第 9 节补一条主循环的旁证。

### 3.3 缓存

- 官方文档：在 Fable 5.1 及以后、Opus 5.5、Sonnet 5.5、Haiku 5.5 上用 API key 或订阅时，换 effort 不丢缓存；换模型会丢。Bedrock、Google Cloud、网关上换 effort 也会丢。
- 主 agent 的模型永不改写。agent 的模型只在它第一步之前定一次，之后每步写同一个值。
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
- 客户端要核对回答的 `model`："Compare the response `model` with the pinned id. A mismatch means a retired or mistyped id: log it as an error and handle the call as failed."（拼错或退役的 `drex-` id 会被别的版本回答，不报错。）还要核对每道题都带着要求的类型回来，失败时记 `request_id`，401、402、422 不重试。
- 等不起 60 秒的请求路径："a shorter total budget wins over the 60-second floor. It abandons slow requests, so treat its expiry like any other Drex failure."
- 不是护栏的判断在 Drex 不可用时放行并记一行日志；失败不能和真实的「否」用同一个结果表示。
- 换提供方：Drex 被设为默认提供方时，Drex 失败后新写的决策代码不得改调别家；"Keeping the existing provider path behind an explicit configuration switch is allowed, because a person selects it."
- 这份 skill 写 `drex-latest` 指向 `drex-v2.0`，和现行 models 页不一致（页面 2026-11-18 渲染后读到：`drex-latest` 指向 `drex-max-v1.1`，不写 `model` 时也选它）。skill 自己说以现行文档为准，这里按页面。

**TypeSafe Jev**（https://docs.typesafe.ai/ 下的 primitives、confidence、models、model-jaggedness 各页和 skill_suggestion cookbook）

- Score 的 `criteria` 是 2 到 10 档的有序数组，回答里有 `probabilities`。
- "Ask one yes/no question per Noul."，高值表示「是」。
- "Good starting thresholds are 0.7 and 0.3 ... Give the band between 0.3 and 0.7 its own outcome in code rather than rounding it to one side."，门槛随出错代价调整，用自己的数据测。
- "Include only the context relevant to the current questions."。默认上限每次请求 64k、每题 32k。同一请求里的题互不影响。
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
- Score："Choose examples with known expected levels, then test the revised descriptions on separate inputs before keeping them."（TypeSafe）；"try a score question on a few samples before you rely on it."（Nace）。
- 比较措辞时把每种写法作为同一请求里的不同题来问；逐条看回答，不只看汇总；保存每个用例的原始请求以便重跑（TypeSafe skill）。
- 警示信号：criteria 里点名测试用例或每个失败用例加一句、为解释模型怪癖加说明、门槛贴着个别用例调、测试断言精确概率、代码悄悄改写回答（TypeSafe skill）。
- Choice 的选项顺序会影响 Jev，换顺序复查（model-jaggedness）。
- "Log the raw `noul` value with each decision, so you can move the threshold later and replay past traffic against the new one."、"don't treat 0.5 as the answer"、调门槛时固定模型（Nace）。
- Nace 文档对用例数量、类别比例、标注方法没有说法；TypeSafe 文档没有规定用例格式和数量。
- 向真实接口发测试请求前，先征得用户同意，说明预算、会发送哪些数据、用谁的密钥（TypeSafe skill）。

**effort 和模型路由**

- 两家都没有官方配方。TypeSafe 只在 use-case-map 页有一条想法："Model router: match each prompt to a model … Classify each prompt's intent and subject area. Estimate difficulty and risk."，没有例题。
- Nace 的例题直接问决定（"How should accounts payable handle this invoice?"，选项 `pay`、`hold`、`reject`；"Which priority should this ticket get?"，选项 `p0` 到 `p3`，说明写成情形）。Nace 没有哪一页比较过「问判断」和「问决定」两种写法。
- Nace 文档收了一个社区贡献的集成（Oh My Pi 的 `auto` thinking level）："Drex rates how hard each prompt is, and omp picks the thinking level for that turn."，页面没给题目。它的源码（第三方，不是 Nace 写的）用一道 Choice 直接选 `low` 到 `max`，各选项的说明是情形；评的是问题有多开放（"Volume of work never raises it."），`max` 另需一个附加条件（"Difficulty alone is insufficient."），拿不准时取低的一档。没有公开的评测数据。
- 逐条出处见 `docs/research/decision-question-layer.md`。

## 4. 做法的选择

| 做法 | 内容 | 取舍 |
|---|---|---|
| 一、单插件、单路（**选定**） | 只挂 Code Mode 允许的事件；中途换挡时在结果行上加一行说明 | 每次中途换挡往上下文加一行，约几十 token |
| 二、单路、零追加 | 同上，但中途只在本来带新输入的步换挡 | 上下文一个字不加；按 E4，Code Mode 的一轮几乎全是只带工具结果的步，中途换挡基本不起作用 |
| 三、双插件、双路 | 核心加 extras，普通会话里用 `agent.spawn`、`tool.call` | 信号更全；两套路径、两套测试，两种会话行为不一致 |

用户选了一：三项换挡在两种会话里都能用，代码只有一条路。让 Claude 自己在脚本里申请换挡的路也考虑过，它要加固定说明，也绕过了决策模型，已排除。

## 5. 设计

### 5.1 事件

| 事件 | 用途 |
|---|---|
| `session.start` | 注册 `/dp` 命令，读配置，建会话状态 |
| `prompt.submit` | 发消息时的判断：effort 题和 skill 题；把推荐的 skill 放进 `context` |
| `prompt.attachment`（`type: 'skill_listing'`） | 记下列表里的 skill，主循环的列表换成固定的一句；agent 的列表不动 |
| `skill.prompt` | 回答 `dispatch-pilot:find-skill` |
| `turn.start` | 主循环：记下这一轮的基准档。agent：拿任务原文，发起判断 |
| `turn.step` | 每步写 effort；agent 每步写定下的模型和 effort |
| `session.append` | 读每步的结果行作为依据；到检查点时判断，要换挡就在结果行上加说明 |
| `turn.complete` | 收尾：清这一轮的计数 |
| `command.run`（`command: 'dp'`） | `/dp` |

不注册 3.1 列出的任何事件，不调用 `$.tool.register`。

### 5.2 怎么问、怎么读（三项换挡共用）

**模型只给判断，决定在代码里。** 没有任何一题问"该用哪一档"或"该用哪个模型"。题目问的是工作本身，档位和模型由代码里的表从回答算出来。所有题的措辞集中在一个模块里。

依据（3.4 节）：这是 TypeSafe 现行文档和官方 skill 的写法。Nace 的 skill 同样要求从判断倒推、把门槛留在代码里，但它的例题允许直接问动作，也没有比较过两种问法。所以默认用这一种，「直接选档位」的写法只在校准时作对照（第 8 节）。

- **工作有多难**用一道 `score` 题，只量一个维度：问题有多开放，也就是做法是不是已经给定、还有多少原因或设计没有定下来。工作量大小不算在这道题里（score 页："Keep each Score question to one dimension."）。五档从低到高，每一档写成一种单独读也成立的情形，不用程度词。起步的五档：做法已经给定，照着改；小范围内有少数几种可能，或有一处小坑；有几种可行的设计或几个可能的原因，要做取舍；原因不明的偶发、并发或状态问题，或容易出细微错误的改法；上一档的情形，再加上没有复现、操作不可逆、要在运行中切换三者之一。代码把第 0 到 4 档对应到 `low`、`medium`、`high`、`xhigh`、`max`。这五档的分法参考了 3.4 节那个社区实现，文字自己写，以校准为准。
- 读这道题用函数 `decide(current, probabilities)`，三处共用：
  - 升：比当前高一档及以上的概率和不低于升档门槛，就升一档，再对新的一档重复。
  - 降：比当前低一档及以下的概率和不低于降档门槛，就降一档，再重复。
  - 两边都不到，保持当前档。这就是文档说的中间带。
- **条件类的判断**各用一道 `noul`，一题一个条件，高值表示「是」，`criteria.true` 和 `criteria.false` 都写成具体情形。起步的两道：「这项工作是不是照已知做法重复的机械改动」（是，则上限 `medium`）、「这项工作是不是要先查明一个原因未知的问题」（是，则下限 `high`）。读法用两个门槛，落在中间带时这一条不起作用。每道题都必须在表里有用处，没有用处的不问。
- 门槛按后端、模型版本和动作各存一张表。初值：升档 0.7，降档 0.7（即文档的 0.7/0.3 起步），升到 `xhigh` 和 `max` 的门槛更高（初值 0.8），`noul` 用 0.7 和 0.3。初值只是起点，发布前校准（第 8 节）。 0.7 和 0.3 是 TypeSafe 文档给 Jev 的起步值；Nace 的 skill 要求门槛在自己的数据上定，不照搬别家模型的校准，所以 Drex 那张表在校准前只是占位，不当作 Nace 认可的值。
- 一次判断的所有题放进同一次请求。
- state 是带名字字段的对象（例如 `request`、`recent_steps`、`current_level`），题目用反引号里的路径指向字段；只放和题有关的字段，上限 4000 token，两家都不触发抽取或长上下文模式。
- 请求失败记为失败并放行，不当作「否」。

### 5.3 发消息时定 effort

- 只处理人发的消息（`origin.kind` 为 `composer`、`sdk`、`bridge`），其他来源直接放行。
- state：用户这条消息，加上一段简短的近况（上一轮在做什么、上一轮的档位）。
- 题：5.2 节的 `score` 题和两道条件题，加一道 `noul`「这条消息是否只是让助手继续它已经提出或正在做的工作」。
- `current` 的取值：续做题为「是」时取上一轮的档位，否则取会话设定的档位。结果写进状态，由这一轮的每个 `turn.step` 发出。
- 用户用 `/dp lock` 锁了档位时不判断。

### 5.4 一轮中途换 effort

- 依据来自 `session.append` 的行：这一轮里每步用了哪些工具、是否报错、结果文字的开头（Code Mode 下是 `REPL` 和 `Poll` 结果行的文字，以及脚本内部调用行的工具名和报错标记，见 E7）。
- 检查点（到了才问决策模型）：
  1. 这一轮中途进来了新输入（用户插话、后台任务通知、agent 交回报告）。这种步本来就带输入，换挡不用加说明。
  2. 代码数到失败成簇：同一处报错在一次修改之后再次出现，或连续两步报错。
  3. 距离上一个检查点满 N 个工作步（`midrunEverySteps`，默认 8，0 为关闭）。只等事件的 `Poll` 步不算工作步。
- 在检查点：state 是用户这一轮的请求、当前档位和最近几步的摘要，题是 5.2 节的 `score` 题和两道条件题，问的是「接下来的工作」，用 `decide` 读。
- 要换挡时，在这条结果行存下之前给它加一个 text 块（E5），下一步起每个 `turn.step` 发新档。说明是一行英文事实，例如 `[dispatch-pilot] effort is now high: the same test failed again after a fix.`，不带命令语气。
- 限制：一轮最多加 4 条说明（`midrunMaxNotes`）；两次换挡至少隔 3 个工作步；一轮中途最高升到 `xhigh`，不升到 `max`；新档和当前档相同时不加说明。
- Code Mode 下说明只加在请求会带的结果行上（`REPL` 或 `Poll`），不加在脚本内部调用的行上。

### 5.5 派出 agent 的模型和 effort

- agent 的 `turn.start` 带任务原文（E2）。在这里发起一次判断，它的第一个 `turn.step` 等这次判断，最多等到时限；之后每步写同一组值（E3）。超时就按继承值跑，这个 agent 之后也不再改。等的是 agent 自己的第一次请求，不是主循环脚本里的调用。
- 派出时已经明写了模型或 effort 的（`$.agent.list()` 里它的 `model`、`effort` 有值），那一项不改。
- 题：5.2 节的 `score` 题和两道条件题，再加一道 `noul`「这项任务是不是只需要查找或阅读信息，不用做任何改动」。effort 和模型层级都由代码里的表从这些回答算出，不问模型该用哪个模型。
- 模型层级的顺序固定为 `haiku` < `sonnet` < `opus` < `fable`，候选取 `agentModels`（默认 `haiku`、`sonnet`、`opus`）里不高于主 agent 的那些。
- **Fable 作为子 agent 有单独的开关 `fableAgents`，默认关。** 关着时 mod 不会让任何 agent 跑在 `fable` 上：主 agent 是 Fable 而 agent 没有明写模型时，它的上限是 `opus`，这条是配置规则，决策模型失败时也照样执行。打开后 `fable` 才进候选。派出时明写了 `fable` 的 agent 不受这个开关影响（见上一条）。写给引擎的是别名本身，由引擎解析成具体模型（实测 `haiku` 解析为 `claude-haiku-5-5`）。主 agent 的层级按它的模型 id 里的家族名认；认不出时不改 agent 的模型，只定 effort。
- `current` 取继承值（主 agent 的当前档位；模型取继承值，受上面的上限约束）。模型只往下换，而且只在把握大时才换：门槛初值 0.8。
- `e.text` 为空的 agent（续跑的，或引擎不让 hook 看到的）不处理。agent 中途不再判断。

### 5.6 skill

- `prompt.attachment` 收到主循环的 `skill_listing` 时，解析出里面的 skill 名和说明，存进会话状态，作为候选集；这样候选只含引擎允许模型调用的 skill。然后把这条附件换成固定的一句：说明列表被收起，合适的 skill 会随消息推荐，其他的用 `dispatch-pilot:find-skill` 查。agent 的列表原样放行。
- 发消息时的推荐照 TypeSafe cookbook 的结构和门槛（3.4 节）。第一次请求和 effort 题合并成同一次请求。需要第二次请求时才发。最多推荐一个 skill，放进 `prompt.submit` 的 `context`，内容是 skill 名、说明和「用 Skill 工具加载」的一句。不推荐时什么也不加。
- Drex 没有 skill 配方，用同一结构；门槛初值同 cookbook，校准后各存各的。「都不合适」的处理各照各的文档：Jev 用陪伴的 Noul，不加 "other" 选项；Drex 在选项里加一个 `other`。
- `find-skill`：plugin 自带的 skill（`skills/find-skill/SKILL.md`），`skill.prompt` 收到它时，用参数里的几个词对候选集做同样的两步判断，回答最多三个合适的 skill 名和说明。
- 候选超过 255 个时（Drex 每题上限）按来源分批问。

### 5.7 后端

- 接口是一个函数：`ask({ state, questions }) -> { answers, model, ms }`，`drex` 和 `jev` 各一个实现。两家的请求体都是 `state` 加 `questions`，回答字段名相同的部分直接用，不同的部分（Jev 的 `legend` 是对象、`noul` 没有 `confidence`）在各自的实现里抹平。
- 默认后端 Drex（`drex-max-v1.1`，固定版本）。另一个是 Jev（`jev-latest`）。另一个后端接手由开关 `fallback` 控制（默认开）：配置了两个密钥并且开关开着时，默认后端请求失败或超时，同一次判断改问另一个，只改问一次，并在决策记录里写明是谁答的。Nace 的 skill 要求换提供方必须出自人选定的配置开关，所以这里做成开关，不写死在代码里。
- 核对回答：Drex 回答里的 `model` 和 `drexModel` 不一致时，这次调用记为错误并按失败处理（Nace skill）。Jev 用的是别名，不做这条核对，只记下实际版本（第 8 节）。每道题都要带着要求的类型回来，缺题或类型不对按失败处理。失败记录带上 `request_id`，不记密钥，也不记可能回显 state 的错误正文。
- 每次判断有总时限，到时放行：发消息 4 秒，中途检查点 2 秒，agent 3 秒，可配置。这比 Nace 建议的 60 秒客户端超时短，是有意的：用户在等。Nace 的 skill 对等不起的请求路径写的是 "a shorter total budget wins over the 60-second floor"，到时按失败处理。超时的请求不重试。
- 发给决策模型的内容：用户的消息、近况和最近几步的摘要（含工具结果文字的开头），按 5.2 节的上限截断，不脱敏。这沿用用户此前对脚本结果的决定。除两家决策模型的接口外不向任何地方发送。
- 每条决策记录写下：时间、哪一项换挡、题的原始回答（分布和 noul 值）、门槛、结果、回答里的 `model` 字段、耗时、是否放行。存进 `$.store`，只留最近 200 条。

### 5.8 状态

- `$.state`：会话当前档位和基准档、锁定、这一轮的步数和说明数、最近几步的摘要、每个 agent 定下的模型和 effort、skill 候选集。
- 模块级变量只放相邻两个事件之间传的值（例如 agent 判断的进行中请求），注释写明丢了的代价是这一次不换挡。
- `$.store`：决策记录。

### 5.9 界面和命令

- `$.ui.status` 一行：当前档位，以及最近一次换挡的方向和原因。
- `/dp`：当前档位、锁定状态、后端、最近 5 条决策。
- `/dp lock <level>` 和 `/dp unlock`：本会话锁定或解锁档位，锁定时三项 effort 判断都不做。
- `/dp log [n]`：最近 n 条决策记录，含原始回答。
- 不做看板 band 和依据面板。

### 5.10 配置（`userConfig`）

`enabled`、`mode`（`apply` 或 `shadow`，后者只判断和记录、不改任何东西；默认 `apply`）、`backend`、`fallback`（默认开）、`drexApiKey`、`jevApiKey`（sensitive）、`drexModel`、`jevModel`、`midrunEverySteps`、`midrunMaxNotes`、`agentModels`、`fableAgents`（默认关）、三个时限，以及四个布尔开关 `submitShift`、`midrunShift`、`agentShift`、`skills`，分别开关发消息定档、中途换挡、agent 定档和 skill 一组功能，默认都开。没有密钥的后端视为不可用；两个都没有时 mod 什么也不做，并在 `/dp` 里说明。

### 5.11 放行规则

以下情况一律放行（不改 effort、不改模型、不加说明、不换 skill 列表以外的任何东西），并记一条记录：请求失败、超时、回答缺字段或题的类型不对、Drex 回答的 `model` 和固定版本不一致、模型不接受 effort（`e.effort` 缺省）、`mode` 为 `shadow`。hook 自己抛错时引擎会跳过它，所以每个 hook 的主体都包在一层兜底里，保证总是走到 `next(e)`。

## 6. 仓库里的变化

- `dispatch-pilot/` 原地替换成新实现，plugin 名不变，版本 `1.0.0`，`engines["claude-code"]` 写 `>=2.1.326`。
- 删除 `dispatch-pilot-extras/`，同时从 `.claude-plugin/marketplace.json` 去掉它，并更新 dispatch-pilot 的说明。
- 新写一条 ADR 记这次重写和它取代的旧决定；旧 ADR 保留不动。更新 `GLOSSARY.md` 和 `CLAUDE.md` 里提到两个 plugin 的段落。
- README 写给使用者：功能、配置、Code Mode 下的行为、测试用的 Claude Code 版本。DEVELOPMENT.md 记第 3.2 节的实测。

## 7. 测试

- `claude plugin test`：每个 hook 的行为、`decide` 的各种分布、两个后端的请求体和回答解析、放行规则、限制（说明条数、间隔、上限）。`http.fetch` 全部打桩，不联网。
- 一条静态检查：hooks 模块里出现的事件名都不在 3.1 的名单里，也没有 `$.tool.register`。接进 `scripts/check.sh`。
- 实机：普通会话和 Code Mode 会话各跑一遍三项换挡和 skill 推荐，记进 DEVELOPMENT.md。

## 8. 校准（照 3.4 节两家的说法）

校准属于这个项目，是最后一个阶段；`1.0.0` 在校准之后发布。

**用例**

- 来源首选真实流量：本机 Claude Code 的会话记录，以及 mod 在 `shadow` 模式下记下的决策记录。手写或模型写的用例只用来补真实流量里缺的难例、边界例和反例，单独标记、单独报数，因为它们比真实请求容易。
- 四类：发消息定档、中途换挡、agent 定档和模型、skill 推荐。每类都要有代表性的、难的、处在两档之间的，以及答案是「否」「保持不变」「不推荐任何 skill」的。文档没有规定数量，这里定每类至少 60 例，其中边界例和反例合计不少于三分之一。
- 一个用例存：mod 实际会发的完整请求（state 和题）、期望结果（期望档位或可接受的范围、是或否、期望的 skill 或「无」）、来源、难度、属于调整集还是留出集。回答原样存下来，重算门槛时不用再发请求。

**参考答案**

- 由强模型在 high 档读完整上下文后给出（真实流量的用例包括这一轮后来实际怎么走的），写明是模型标的；用户抽查，抽查改动过的用例标为人工标注。

**调整和验收**

- 用例分调整集和留出集。措辞和门槛只在调整集上改，每次改动都在没用来调的用例上复查；留出集只在最后算一次分，报告里的数字来自它。
- 比较措辞时，把几种写法作为同一请求里的不同题，对同一个 state 问。逐条看回答，不只看汇总。Score 的各档说明先在几个样例上试，改写后在另一批输入上验证再留下。
- 问法的对照：两家都没有 effort 路由的官方配方，Nace 的例题和它文档收录的社区实现用的又是直接选档位的写法。所以在调整集上把两种问法放进同一请求比较：默认的「问工作本身，代码查表」，和「一道题直接选档位，各选项的说明写成情形」。留出集上后者在某个后端明显更好时，才在那个后端换用，并把依据写进校准记录；否则保持默认。
- `score` 题只量问题有多开放。要不要另加一道判断来管「连续很多步、中间没有人看着」的工作，看它在留出集上有没有用；没有用就不加。
- 门槛从保守的初值起步。在调整集上画出概率和正确率的关系，按每种动作出错的代价定（升档、降档、换模型、推荐 skill 各自一张表），再到留出集上核对。一段很宽的门槛范围结果相同时取保守的一端。
- 不做的事：criteria 里点名用例或为每个失败用例加一句；为解释某次怪回答加说明；让门槛贴着个别用例；测试里断言精确概率（单元测试只用打桩的回答）；用代码悄悄改写回答。回答看着不对时按这个顺序查：实际发出的请求、state、选项、题的范围、措辞。
- 稳定性：skill 的 Choice 把选项顺序打乱再问一遍，结果变了的用例单独列出；同一请求重复问，看决定会不会变。

**版本**

- 校准记录写明所用的模型版本。Drex 固定版本。Jev 按用户要求用别名 `jev-latest`，而 TypeSafe 文档建议调过门槛后固定版本：所以 mod 记下校准时的版本，回答里的 `model` 和它不一致时在 `/dp` 和状态行里提示需要重新校准。想照文档固定版本，把 `jevModel` 设成具体版本号即可。

**发真实请求之前**

- 先向用户说明并取得同意：预算、会发送哪些会话内容、用的是用户自己的 Drex 和 Jev 密钥。

**上线**

- 先用 `shadow` 模式在真实会话里跑，看记录再打开 `apply`。决策记录保留原始回答，以后调门槛可以拿旧记录重算。

## 9. 留给实施者

- 各题的具体措辞、各档情形的文字、条件题的最终清单和代码里那张表的具体内容，以校准结果为准；约束见 5.2 节和第 8 节。
- 一步里有多个并行工具调用时说明加在哪一条结果行上（实测每个结果各有一行）。
- Code Mode 下 `queue`、`delivery` 这两种行算不算带新输入，没测；没测清之前按不算处理。
- 主循环上 E5 的旁证（E6）：比较加说明前后几步的思考量，或用引擎以后提供的读数。主 agent 的中途换挡是必须保留的功能：如果旁证显示它在主循环上不起作用，停下来告诉用户，不要自行降级成做法二。
- `$.http.fetch` 在 2.1.326 的超时和取消方式，以及时限怎么和 hook 的 10 秒预算配合。
- 说明行在终端里的显示（E8）要不要改写法。
- 状态的具体形状、文件划分、`/dp` 输出的排版。

## 10. 我替用户做的决定（请在读的时候核对）

1. Drex 作默认，Jev 作另一个后端并在 Drex 失败时接手；接手做成开关 `fallback`，默认开（Nace 的 skill 要求换提供方出自人选定的开关）。核心版没有看图功能，所以没有「带图给 Jev」这条。
2. `jev-latest` 按用户要求用别名；每条记录写实际版本，和校准时的版本不一致就提示重新校准。TypeSafe 文档的建议是固定版本，可以用 `jevModel` 改。
3. 题目只问工作本身，档位和模型由代码里的表算出。2026-11-18 对照现行文档核对过：TypeSafe 的 skill（0.6.2 是最新版，这一节是它新加的）和现行文档都这样写；Nace 不反对，但它的例题直接问动作。所以默认不变，校准时拿「直接选档位」的写法作对照。`score` 题只量问题有多开放，不量工作量（TypeSafe：一题一个维度）。门槛初值取 0.7/0.3 的起步值，高档更严，发布前校准；Drex 的门槛不照搬 TypeSafe 的数。
4. 中途检查点三种：新输入、失败成簇、每 8 个工作步；一轮最多 4 条说明；中途不升到 `max`。
5. agent 的模型只往下换、只在把握大时才换，层级 `haiku` < `sonnet` < `opus` < `fable`，不高于主 agent。`fableAgents` 关着时（默认），没有明写模型的 agent 最高到 `opus`；派出时明写的值不改，包括明写的 `fable`。agent 的第一步最多等 3 秒。
6. 时限 4 秒、2 秒、3 秒，短于 Nace 建议的 60 秒（Nace 的 skill 允许等不起的路径用更短的总时限），超时不重试。
7. 只留状态行和 `/dp`，不做 band 和面板。配置从 40 项减到十几项，加了 `shadow` 模式。
8. 版本号 `1.0.0`，删除 `dispatch-pilot-extras`。
9. agent 的 skill 列表不动，只收起主循环的。
10. 发给决策模型的内容不脱敏，只截断，沿用此前对脚本结果的决定。
11. 校准算在这个项目里，不用旧评测集；用例首选本机真实会话记录，参考答案由强模型标、用户抽查，每类至少 60 例（文档没有规定数量）；默认 `apply`，校准后才发 `1.0.0`。
12. 主循环中途换挡若验证不通过，停下来问，不自行降级。
13. Drex 回答的 `model` 和固定版本不一致时按失败处理并放行（照 Nace 的 skill）；Jev 用别名，只记版本并提示重新校准。
