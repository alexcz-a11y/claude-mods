# Dispatch Pilot：隐藏 skill 列表，而不是把 skill 改成 user only

为节省上下文，Dispatch Pilot 拦下 Claude Code 在会话开始时注入的完整 skill 列表（`skill_listing` 附件），改由决策模型每轮挑出相关 skill 推荐给主 agent；skill 自身的 frontmatter 一律不改。没有采用「全部设为 user only」：那样 Skill 工具会拒绝模型加载任何 skill，只能把 SKILL.md 全文塞进上下文，还会抹掉作者原本的设置。只能由人触发的 skill（`disable-model-invocation: true`）不推荐给主 agent，改在状态栏提示用户；派出 agent 的 skill 列表保持原样。
