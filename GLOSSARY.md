# claude-mods

作者自制 Claude Code mod 的集合。本术语表统一各个 mod 设计与讨论时使用的词汇。

## Language

**会话（Session）**：
一次全新启动的 Claude Code 上下文；新开一个 session 即开始一个新会话。
_Avoid_: 对话、聊天

**轮（Turn）**：
会话中用户发出的一条消息，加上 AI 对它的完整处理（其间可能有多次模型请求和工具调用）。
_Avoid_: 对话、回合

**命令轮（Command Turn）**：
由用户输入的斜杠命令开始的一轮：skill、markdown 命令或 MCP prompt 展开成给模型的 prompt，主 agent 照它工作。和用户的普通消息一样经过路由；`/dp`、`/clear` 这类本地命令不开始一轮，不是命令轮。决策模型读的是用户输入的 `/name args` 加这个命令的说明（skill 画像或描述），不读展开后的正文。
_Avoid_: 斜杠轮、skill 轮

**步（Step）**：
一轮中的一次模型请求；一轮通常由多步组成，每次工具结果返回后发出下一步。
_Avoid_: 轮次、回合

**主 agent（Main Agent）**：
用户直接对话的那个 agent。
_Avoid_: 主对话、主模型

**派出 agent（Dispatched Agent）**：
由主 agent 派出去执行任务的 agent，包括 Workflow 中启动的 agent。
_Avoid_: 子 agent、subagent

**决策模型（Decision Model）**：
mod 在 Claude 之外调用的判断模型，只负责给出判断、不参与回答用户；可选 Jev（TypeSafe 提供）或 Clef（Cloudflare Workers AI 提供），由用户二选一。
_Avoid_: 路由模型、小模型

**决策请求（Decision Request）**：
发给决策模型的一次请求：一份 state 加若干问题，返回每个问题带概率的回答。用户发消息时，各功能的问题合在同一个决策请求里。
_Avoid_: 调用、查询

**中途重判（Mid-turn Re-decision）**：
一轮进行中再判断一次主 agent 的 effort：每隔几步，或主 agent 派出 agent、启动 Workflow、加载 skill 时。决策请求在主 agent 的工具开始执行时就发出，下一步发出前取用回答；只判断 effort，升降档有防抖。
_Avoid_: 轮中重判、中途判断

**强制升档（Forced Escalation）**：
主 agent 的一轮或一个派出 agent 里，计入的工具调用失败满阈值后，再问一次决策模型并强制升高它的 effort：升一档（最高到 xhigh）或直接到 max；haiku 没有 effort 可升，改用 sonnet。用户的拒绝不算失败，被用户自己的 hook 拦下只在开关「hook 拦截计为失败」打开时才算；升档后失败计数清零，每轮最多升有限的几次；失败是预期内的时候不升。
_Avoid_: 自动升级、重试升档

**循环（Loop）**：
失败计数和强制升档的单位：主 agent 的一轮，或一个派出 agent（包括 Workflow 里的）从启动到结束。每个循环有自己的失败计数和升档次数；主 agent 的新一轮从零开始。
_Avoid_: 会话、任务（会话指整个 Claude Code 上下文，任务指派给 agent 的工作内容）

**下限（Floor）**：
计划表里一轮（或一个派出 agent）的 effort 不能低于的那一档：强制升档写下它，在 `holdSteps` 步之内中途重判降不到它以下，之后照常防抖；这一轮没有经过路由时，抬高的是引擎自己的 effort。用户点名的 effort 不受下限影响。
_Avoid_: 保底、最低档

**模型下限（Model Floor）**：
按所选模型给派出 agent 的 effort 设的最低一档（`effortFloor`）：sonnet 和 opus 都至少 medium；haiku 不带 effort。它抬高的是决策出来的 effort；用户点名的 effort 和模型永远优先，不受它管。和上面的「下限（Floor）」不是一回事：那一个由强制升档写进计划表，这一个由模型决定。
_Avoid_: 下限（单说「下限」指计划表里的那一个）

**预期内失败（Expected Failure）**：
计入的失败其实是工作本来就会遇到的：先写下、要看它红的测试，没找到东西而以非零退出的搜索，探测某样东西是否存在的命令。强制升档的再判断里多问决策模型一题来判断（不靠规则匹配）；是预期内的就不升档，只清零失败计数。
_Avoid_: 正常失败、可忽略的失败

**投票箱（Ballot）**：
用户发消息时，各功能把自己要问决策模型的问题（连同读回答的回调）放进这条消息的投票箱；核心收起投票箱，把所有问题合成一个决策请求发出，再把回答分给各功能。只在发消息时使用；一轮中途的判断由各功能自己发请求。
_Avoid_: 问题池、请求队列

**点名（Named）**：
用户在消息里明确指定这项工作用哪个模型或哪一档 effort（「用 opus」「effort 拉到 high」）。点名的模型和 effort 不被决策模型、主 agent 的指定、脚本里写的值或强制升档推翻；「别用 X」是排除，不是点名，被排除的模型不会被选上。点名和排除记在计划表里，后面的功能都照着办。命令轮里只有用户输入的 `/name args` 算数；skill 展开后的正文是作者写的，其中的「用 opus」不是点名。
_Avoid_: 指定（指定专指主 agent 在派出时写的模型）、钦点

**约束（Terms）**：
用户对一项工作的要求合在一起：点名的模型、点名的 effort、排除的模型，由决策模型从用户这一轮的话里读出。记在派出 agent 的计划里（计划表 `agents` 的 `terms`；Workflow 里的调用经 `workflowTerms` 交给兜底），之后改这个 agent 模型或 effort 的功能（强制升档、兜底）都照办，也盖过 Workflow 脚本在运行时才算出来的模型和 effort。
_Avoid_: 条件、限制、偏好

**兜底（Label Fallback）**：
Workflow 里没能在启动前改写的 `agent()` 调用（prompt 读不出任务、脚本读不了、调用太多），在这个 agent 启动时按它的 label 对上调用，再判断一次模型和 effort（#9）。
_Avoid_: 补救、后备路由

**接缝（Seam）**：
测试和评测落脚的公开边界：接缝 1 是引擎事件进、mod 的效果出（`tests/support/world.ts` 扮演引擎）；接缝 2 是 mod 和评测共用的纯函数（拼请求、读回答），评测用真实的决策模型在这里测准确率。测试只写在接缝上，不碰内部实现。
_Avoid_: 测试点、钩子（hook 指 mod 的处理函数）

**计划表（Plan Table）**：
Dispatch Pilot 在 `$.state` 里按「轮 + agentId」记录每一步该发出的 effort（派出 agent 还有模型）的表；各功能写表，每一步由核心照表发出。
_Avoid_: 决策表、路由表

**开关（Switch）**：
用户用 `/dp` 开启或关闭的单位：总开关管整个 mod，每项功能各有一个开关；各功能自己登记，状态保存在 `$.store`，下次启动沿用。总开关关闭时 mod 完全退场：不发决策请求，每一步照引擎原样发出。
_Avoid_: 设置、配置（配置指 userConfig）

**锁定（Lock）**：
用户用 `/dp lock` 把主 agent 的 effort 固定在某一档：每一步都按它发出，优先于任何决策；只在当前会话有效，用 `/dp unlock` 解除。
_Avoid_: 固定、覆盖

**决策日志（Decision Log）**：
各功能每做出一个决定就记录一条：决定了什么、针对哪个 agent、结果、原因和规则推演。保留最近 20 轮、最多 300 条，在依据面板里按轮分组查看（`/dp log` 是打开它的别名），同样的内容写进 debug log，不进入对话。
_Avoid_: 决策记录

**决定汇报（Report）**：
Dispatch Pilot 里唯一写出给人看的内容的 module（ADR 0004）：功能向它交一条结构化的决定（一路数着的计数、开关的变化、skill 画像的进展也一样交，按种类打标签），核心向它交每一步的读数；它写出看板数据、决策日志、debug log 和 toast，界面只从这份数据画。对外只有两个入口：记一条决定（`report`）、记一步读数（`reportStep`）；一个 agent 的派出和结束、轮数由它自己的 hook 听。
_Avoid_: 汇报器、状态管理

**看板（Dashboard）**：
Dispatch Pilot 常驻给人看的实时界面：prompt 上方的 band 列出本轮每个 agent 的模型、effort 和发生的事件，一轮结束后折成一行写上一轮的结果；脚部右侧一个短摘要。只显示读数和结论，依据放在依据面板。
_Avoid_: 状态栏、状态行、仪表盘

**读数（Readout）**：
一个 agent 此刻实际发出的模型和 effort，取自它最近的一步。读数只反映结果，不改变任何决定；它变了，看板上记一条事件。
_Avoid_: 状态、当前值

**依据面板（Rationale Pane）**：
用户按需打开的面板（`/dp`）：上半是选中 agent 的依据卡片，下半是决策日志；每项功能的开关状态在顶部列出（关着的用灰色）。
_Avoid_: 日志面板、诊断面板

**依据卡片（Rationale Card）**：
依据面板里一个 agent 的决定依据：选这个模型的理由、各档 effort 的概率、规则推演、中途重判和最终结果。
_Avoid_: 详情、解释

**规则推演（Rule Trace）**：
从决策模型给出的各档概率走到最终 effort 的每一步规则：最可能的档、max 门槛、上取一档、模型下限、下限、结果；中途重判还有升降档门槛和防抖。由做决定的规则本身给出，界面不重新计算。
_Avoid_: 推理过程、计算过程

**未路由（Not Routed）**：
一轮或一个 agent 的模型和 effort 照引擎原样发出，没有经过 Dispatch Pilot 的决定。显示时总带原因，例如决策模型失败、功能已关。
_Avoid_: 跳过、未决策

**信号（Signals）**：
引擎通过 `session.measure` 报告的会话读数：上下文占用、用量限额百分比、会话花费。第一版只记录（写进 debug log），不参与任何决策。
_Avoid_: 指标、用量

**skill 列表（Skill Listing）**：
引擎在会话开始时作为附件（`skill_listing`）交给模型的全部 skill 的名字和描述。Dispatch Pilot 对主 agent 拦下它（ADR 0002），派出 agent 的不动。
_Avoid_: skill 目录（目录是 Dispatch Pilot 自己读出的）

**skill 目录（Skill Catalog）**：
Dispatch Pilot 读出的本会话的 skill：主 agent 能用 Skill 工具加载的（与引擎给主 agent 的 skill 列表一致），以及只能由用户本人触发的（SKILL.md 写了 `disable-model-invocation: true`），各带名字、描述、SKILL.md 的位置和写好的 skill 画像。skill 推荐和 `find_skill` 都从它挑选。
_Avoid_: skill 库、候选池

**skill 画像（Skill Profile）**：
一个便宜的模型读一个 skill 的 SKILL.md 后写下的简短说明：做什么、什么时候用、什么时候不用，英文和中文各一份。每个 SKILL.md 版本写一次，存在 `$.store`，排序时代替描述交给决策模型，让中文请求也能对上英文描述的 skill。
_Avoid_: skill 摘要、skill 简介

**两段排序（Two-Stage Ranking）**：
skill 推荐和 `find_skill` 共用的排序：第一段用 Choice 问题给 skill 排序（只用来排序）：主 agent 能加载的一题，只能由用户触发的另一题（`find_skill` 只问前一题）；第二段对每题排在前面的几个补读 SKILL.md 开头，逐个判断是否合适，得出相关度。
_Avoid_: 复排、rerank（只指第二段时可以说「第二段」）

**skill 推荐（Skill Suggestion）**：
用户发消息时，决策模型从 skill 目录里挑出与这条消息相关的几个 skill，连同名字、描述和相关度附在消息后面交给主 agent。只能由用户触发的 skill 不推荐给主 agent，只在看板上提示用户。命令轮不做 skill 推荐：用户已经选好了流程。
_Avoid_: skill 注入、skill 建议

**skill 查询（find_skill）**：
主 agent 在一轮中途调用 `find_skill` 工具，用几个词说明要做的工作，决策模型用和 skill 推荐相同的排序从 skill 目录里挑出相关的 skill，连同名字、描述和相关度作为工具的回答返回。只在被调用时回答，从不主动推送；只能由用户触发的 skill 不返回。
_Avoid_: skill 搜索、按需推荐

**相关度（Relevance）**：
一个 skill 与一条消息相符的程度，由决策模型给出，0 到 1。#11 起是两段排序第二段里对「这个 skill 是否正好做这条消息要做的那种工作」回答「是」的概率，每个 skill 单独判断，是绝对值；#10 用的是第一段 Choice 里分到的概率，是相对值。
_Avoid_: 匹配度、分数
