# claude-mods

作者自制 Claude Code mod 的集合。本术语表统一各个 mod 设计与讨论时使用的词汇。

## Language

**会话（Session）**：
一次全新启动的 Claude Code 上下文；新开一个 session 即开始一个新会话。
_Avoid_: 对话、聊天

**轮（Turn）**：
会话中用户发出的一条消息，加上 AI 对它的完整处理（其间可能有多次模型请求和工具调用）。后台通知、别的会话的消息也会开始一轮。
_Avoid_: 对话、回合

**步（Step）**：
一轮中的一次模型请求（引擎的 `turn.step`）；一轮通常由多步组成，每次工具结果返回后发出下一步。**工作步**是模型在这一步里做了事的步：派出一段脚本或调用了一个工具。普通会话里一次回答并行调了几个工具时，它们的结果是同一个工作步：回答之后的第一条结果结束这一步，下一条回答之前到达的其余结果并进这一步，有一条失败这一步就算失败，只算一次。Dispatch Pilot 的步数、换挡间隔、「连续两步报错」和时间轴的格子都按工作步数。
_Avoid_: 轮次、回合

**主 agent（Main Agent）**：
用户直接对话的那个 agent，它的一轮也叫主循环。
_Avoid_: 主对话、主模型

**派出 agent（Dispatched Agent）**：
由主 agent 派出去执行任务的 agent。Dispatch Pilot 在派出时（`agent.spawn`）给它定模型和 effort；续跑的、fork 出来的和 Workflow 派出的不处理。
_Avoid_: 子 agent、subagent

**决策模型（Decision Model）**：
mod 在 Claude 之外调用的判断模型，只负责给出判断、不参与回答用户。Dispatch Pilot 默认用 Nace 的 Drex（固定 `drex-max-v1.1`），也可以改用 TypeSafe 的 Jev（`jev-latest`）；开了 `fallback` 时默认的那个失败才改问另一个（ADR 0030）。判断交给它，决定写在代码里：它给概率，mod 的规则定档。
_Avoid_: 路由模型、小模型、判官

**决策请求（Decision Request）**：
发给决策模型的一次请求：一份 state 加若干题，返回每道题带概率的回答。一次判断的所有题放进同一次请求；发消息时 effort 题和 skill 推荐的第一次请求合在一起。
_Avoid_: 调用、查询

**放行（Fail Open）**：
判断失败时（请求失败、超时、回答缺题或类型不对、Drex 回答的版本不符、模型不收 effort）mod 什么也不改，会话照没有这个 mod 时那样继续，只记一条决策记录。
_Avoid_: 降级、兜底

**分档题（Openness Score）**：
每处 effort 判断都问的那道 `score` 题：问题有多开放，也就是做法是不是已经给定、还有多少原因或设计没有定下来。五档从低到高各写成一种情形，代码把第 0 到 4 档对应到 `low` 到 `max`。工作量大小不算在里面。读它用 `decide`：高于当前档的概率合计过了升档门槛就升一档，再从新的一档重复；降档同理；两边都不到就不变。
_Avoid_: effort 题、难度分

**条件题（Condition Question）**：
分档题旁边的 `noul` 题，一题一个条件，高值表示「是」，「是」和「否」都写成具体的情形。0.7 以上算是、0.3 以下算否，中间算拿不准、不起作用。发消息时问「是否机械重复」「是否要先查明原因未知的问题」「是否只是续做」；中途问「同一失败是否又出现」「原因是否已查明」「是否只剩照做」「是否与计划矛盾」；派出 agent 时另问「是否只读」。每道题都在代码的规则里有用处。skill 推荐的门控题和点名题也是 `noul`，但不是条件题。
_Avoid_: 是非题（泛指任何 `noul` 时可以用）

**基准档（Base）**：
这一轮开始时的档位：发消息时判断定下的，没有判断时是引擎第一步带来的档位。中途判断从当前的档位起算。
_Avoid_: 基础档

**检查点（Checkpoint）**：
一轮中途 Dispatch Pilot 问决策模型的时刻：Code Mode 会话里每到达 `midrunEveryScripts` 份脚本结果；普通会话里同一处报错在修改之后又出现、连续两步报错，或每过 `midrunEverySteps` 个工作步；两种会话里中途进来了新输入。只有一条 `(dispatched #N)` 的 `REPL` 结果行不算一份结果。说明条数用完之后，只有作为 prompt 行进来的新输入还算检查点。
_Avoid_: 中途重判、评估点

**说明行（Note）**：
中途要换档时，Dispatch Pilot 在一条工具结果行存下之前给它加的一个 text 块，一行英文事实，例如 `[dispatch-pilot] effort is now high: the same failure came back after a fix.`。只带工具结果的步上改 effort 发不出去，带了这一行，下一次请求起就是新档。Code Mode 下只加在 `Poll` 的结果行和 `REPL` 的回执行上，`delivery` 行带不了它，这时说明排到之后第一条能带的行。一轮最多 `midrunMaxNotes` 条。
_Avoid_: 追加行、提醒、注入

**进展记录（Progress Note）**：
开了 `progressNote` 时，每个检查点之后在后台由一个便宜的模型（`progressNoteModel`，默认 haiku）写的三个字段：已完成什么、还剩什么、原因查明没有。下一次中途判断把它作为 `progress` 交给决策模型，所以它晚一步。它是另一个模型的转述，不是结果。默认开（用户 2026-11-19 定的；校准时看不出它有好处）。
_Avoid_: 问题摘要、轮次摘要

**实际档位（Sent Level）**：
引擎发出的一次模型请求实际带的 effort，由 `http.fetch` 从请求体顶层的 `output_config.effort` 读出，只读不改（`verifyEffort`）。看板、`/dp` 和决策记录上的档位以它为准；mod 要的和它不同时两个都写出来；读不到或认不准是不是主循环的请求时记为「未核对」。派出 agent 的读 `$.agent.list()` 的 `lastRequest`。
_Avoid_: 读数（旧实现的说法）、当前值

**锁定（Lock）**：
用户用 `/dp lock <档位>` 把主 agent 的 effort 固定在某一档：每一步都按它发出，三项 effort 判断都不做；只在当前会话有效，用 `/dp unlock` 解除。
_Avoid_: 固定、覆盖

**开关（Switch）**：
plugin 配置里的布尔选项，在 `/plugin` 里改：总开关 `enabled`，四项功能各一个（`submitShift`、`midrunShift`、`agentShift`、`skills`），另有 `board`、`verifyEffort`、`progressNote`、`fallback`、`fableAgents`。`mode: shadow` 让 mod 只判断和记录、不改任何东西。
_Avoid_: 设置

**决策记录（Decision Record）**：
每做一次判断记的一条：哪一项、决策模型的原始回答、门槛、结果、回答里的模型版本、耗时、失败原因和 `request_id`、之后实际发出的档位。存在 `$.store` 的 `log`，本机共用，只留最近 200 条；`/dp log [n]` 查看。不存用户的消息和工具结果。
_Avoid_: 决策日志

**看板（Board）**：
Dispatch Pilot 给人看的界面，由一个纯函数从状态算出一份数据，再画成两块：常驻的时间轴和按需打开的分区面板，另有脚部最右边的一个标签（例如 `dp high ✓`）。终端和 Desktop 用同一份数据和同一套布局，VS Code 和手机端不画。它只读状态，不参与任何判断；`board` 关着时不画，只剩 `/dp` 的文字版。
_Avoid_: 仪表盘、状态栏、band（指渲染位时可以说 band）

**时间轴（Timeline）**：
看板常驻在 prompt 上方的那一块。一轮进行中有五行：现在的档位、状态、第几轮第几步和会话种类；这一轮每个工作步一格、颜色是它实际发出的档位，后面是下一次评估；每次评估在它那一步下面的记号（不变、升、降、失败）和最近一次换挡；上次评估；各项功能的状态。面板开着时只画前三行；没有记号也没有换挡的一轮不画记号行；两轮之间折成一行。「下次评估」按触发条件写，不是倒计时。
_Avoid_: 进度条、band

**分区面板（Pane）**：
`/dp` 打开或关上的面板，七个分区按固定顺序：现在、换挡记录、上次评估（五档概率条、条件题的值和读法、规则算到了哪一步）、下次评估、功能、agent、这条消息推荐的 skill；后两个没有内容时不显示。终端够宽时停靠在右边，否则落到 prompt 上方。
_Avoid_: 依据面板（旧看板的说法）、日志面板

**状态行（Status Line）**：
prompt 下方的 `$.ui.status` 那一行。Dispatch Pilot 只在 Desktop 上写它（当前档位和最近一次换挡）；终端上不用，因为终端会在这一行前面加一个关不掉的 ⚠。它不是看板。
_Avoid_: 状态栏

**skill 列表（Skill Listing）**：
引擎作为附件（`skill_listing`）交给模型的 skill 名字和描述。它是增量：第一次是全部，之后只有新加的。Dispatch Pilot 把主 agent 的换成固定的一句（ADR 0002），派出 agent 的不动。
_Avoid_: skill 目录

**候选集（Skill Candidates）**：
Dispatch Pilot 从主 agent 的 skill 列表里读出、按名字合并起来的 skill，只含引擎允许模型调用的。skill 推荐和 `find-skill` 都从它挑；mod 从不清空它。
_Avoid_: skill 目录、skill 库

**skill 推荐（Skill Suggestion）**：
用户发消息时，决策模型按两段排序从候选集里最多挑出一个 skill，连同它的说明和「用 Skill 工具加载」的一句放在消息旁边交给主 agent；没有合适的就什么也不加（ADR 0018）。
_Avoid_: skill 注入、skill 建议

**skill 查询（find-skill）**：
Dispatch Pilot 自带的 skill `dispatch-pilot:find-skill`：主 agent 用 Skill 工具加载它、参数写几个词，mod 在 `skill.prompt` 上用和 skill 推荐相同的排序（不问门控题）回答最多三个合适的 skill。只在被调用时回答。
_Avoid_: `find_skill` 工具（ADR 0028 之前的形式）、skill 搜索

**两段排序（Two-Stage Ranking）**：
skill 推荐和 `find-skill` 共用的排序，照 TypeSafe 的 skill_suggestion cookbook：第一段用 Choice 题给候选排序（每个 skill 用它在列表里的说明，候选多时分批），发消息时同一请求里还有门控题和点名题；第二段对排在前面的三个，一道 Choice 选哪一个，再逐个问它是否正好做用户要的事，得出相关度。
_Avoid_: 复排、rerank

**门控题（Skill Gate）**：
skill 推荐第一段里 cookbook 的三道 `noul`，问这条消息是要动手做事还是只要解释：要不要操作用户的文件、账户、设备或在线服务；细心的专家会不会照现成的流程或命令做；懂行的人能不能光用文字答完（这一道反过来算）。三道的平均不到 0.30 而且点名题不到 0.50 时就不推荐，也不发第二段。
_Avoid_: 过滤、预判

**点名题（Named Method）**：
skill 推荐第一段里 cookbook 的第四道 `noul`：这条消息是否点名要用某个具体的工具、格式、模板或方法。到 0.50 就算需要 skill，和门控题有一个过了就发第二段（ADR 0021）。
_Avoid_: 指名

**相关度（Relevance）**：
两段排序第二段里，对「这个 skill 是否正好做这条消息要的事」回答「是」的概率，每个 skill 单独判断。最高的不到 0.30 就不推荐。
_Avoid_: 匹配度、分数

**接缝（Seam）**：
测试落脚的公开边界：引擎事件进、mod 的效果出（`tests/support/world.ts` 扮演引擎），以及不碰 `$` 的纯函数（拼 state、读回答、算看板的数据）。测试只写在接缝上，不碰内部实现。
_Avoid_: 测试点、钩子（hook 指 mod 的处理函数）
