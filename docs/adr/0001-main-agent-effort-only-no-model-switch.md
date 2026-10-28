# Dispatch Pilot：主 agent 只调 effort，绝不换模型

Dispatch Pilot 每轮（及轮内每一步）为主 agent 选择 effort，但从不改主 agent 的模型：换模型必然让 prompt cache 失效（缓存按模型区分），而在 Claude Code 订阅下，同一模型内切换 effort 保留缓存（2.1.289 上 Opus 5.5 + 订阅实测）。模型路由只用于派出 agent，它们各自开一段新对话，不影响主 agent 的缓存。只面向 Claude Code 订阅用户；Bedrock、Vertex、网关等平台上切换 effort 会破坏缓存，不在支持范围内。

后来被 ADR 0013 改了：2.1.312 起 effort 按消息生效，一轮中途改的 effort 发不出去，所以主 agent 的 effort 只在发消息时定（一轮进行中用户又输入的消息照常判断）；派出 agent 失败时改模型（只影响它自己的缓存），主 agent 仍从不换模型。
