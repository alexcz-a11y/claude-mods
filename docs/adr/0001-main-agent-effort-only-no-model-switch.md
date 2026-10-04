# Dispatch Pilot：主 agent 只调 effort，绝不换模型

Dispatch Pilot 每轮（及轮内每一步）为主 agent 选择 effort，但从不改主 agent 的模型：换模型必然让 prompt cache 失效（缓存按模型区分），而在 Claude Code 订阅下，同一模型内切换 effort 保留缓存（2.1.289 上 Opus 5.5 + 订阅实测）。模型路由只用于派出 agent，它们各自开一段新对话，不影响主 agent 的缓存。只面向 Claude Code 订阅用户；Bedrock、Vertex、网关等平台上切换 effort 会破坏缓存，不在支持范围内。
