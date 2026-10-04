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

**计划表（Plan Table）**：
Dispatch Pilot 在 `$.state` 里按「轮 + agentId」记录每一步该发出的 effort（派出 agent 还有模型）的表；各功能写表，每一步由核心照表发出。
_Avoid_: 决策表、路由表
