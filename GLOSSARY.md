# claude-mods

作者自制 Claude Code mod 的集合。本术语表统一各个 mod 设计与讨论时使用的词汇。

## Language

**会话（Session）**：
一次全新启动的 Claude Code 上下文；新开一个 session 即开始一个新会话。
_Avoid_: 对话、聊天

**轮（Turn）**：
会话中用户发出的一条消息，加上 AI 对它的完整处理（其间可能有多次模型请求和工具调用）。
_Avoid_: 对话、回合

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

**预期内失败（Expected Failure）**：
计入的失败其实是工作本来就会遇到的：先写下、要看它红的测试，没找到东西而以非零退出的搜索，探测某样东西是否存在的命令。强制升档的再判断里多问决策模型一题来判断（不靠规则匹配）；是预期内的就不升档，只清零失败计数。
_Avoid_: 正常失败、可忽略的失败

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
各功能每做出一个决定就记录一条：决定了什么、针对什么、理由。最近 50 条存在 `$.state`，用 `/dp log` 查看，同样的内容写进 debug log，不进入对话。
_Avoid_: 决策记录

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
用户发消息时，决策模型从 skill 目录里挑出与这条消息相关的几个 skill，连同名字、描述和相关度附在消息后面交给主 agent。只能由用户触发的 skill 不推荐给主 agent，只在状态行提示用户。
_Avoid_: skill 注入、skill 建议

**skill 查询（find_skill）**：
主 agent 在一轮中途调用 `find_skill` 工具，用几个词说明要做的工作，决策模型用和 skill 推荐相同的排序从 skill 目录里挑出相关的 skill，连同名字、描述和相关度作为工具的回答返回。只在被调用时回答，从不主动推送；只能由用户触发的 skill 不返回。
_Avoid_: skill 搜索、按需推荐

**相关度（Relevance）**：
一个 skill 与一条消息相符的程度，由决策模型给出，0 到 1。#11 起是两段排序第二段里对「这个 skill 是否正好做这条消息要做的那种工作」回答「是」的概率，每个 skill 单独判断，是绝对值；#10 用的是第一段 Choice 里分到的概率，是相对值。
_Avoid_: 匹配度、分数
