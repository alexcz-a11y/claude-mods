# Dispatch Pilot：隐藏 skill 列表，而不是把 skill 改成 user only

为节省上下文，Dispatch Pilot 拦下 Claude Code 在会话开始时注入的完整 skill 列表（`skill_listing` 附件），改由决策模型每轮挑出相关 skill 推荐给主 agent；skill 自身的 frontmatter 一律不改。没有采用「全部设为 user only」：那样 Skill 工具会拒绝模型加载任何 skill，只能把 SKILL.md 全文塞进上下文，还会抹掉作者原本的设置。只能由人触发的 skill（`disable-model-invocation: true`）不推荐给主 agent，改在状态栏提示用户；派出 agent 的 skill 列表保持原样。

后来被 ADR 0004 改了：终端不再用 `$.ui.status`，给人看的提示（例如「可试 /x」）写在看板上，不在状态栏。

后来 ADR 0018 照 TypeSafe 的 skill 推荐 cookbook 改了「挑出相关 skill」的做法：先问三道题判断这条消息要不要 skill，再细看前三名，最多推荐一个，没有合适的也附一句；skill 画像去掉了。拦下主 agent 的列表、派出 agent 的列表保持原样，这两条不变（用户 2026-10-28 确认派出 agent 不拦）。
