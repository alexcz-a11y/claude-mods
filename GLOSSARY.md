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
