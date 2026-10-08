# Dispatch Pilot：默认决策模型换成 pplx（B′），删掉 Clef，Jev 只作退路

eval v2（#45，120 题，金标 accept 取并集）里 B′ 的可接受准确率是 79.2，现行的 Jev（带摘要 65.0，不带 67.5）排在它后面。B′ 是 Perplexity 的 `pplx-decider-v1.1-27b`，state 预算 48000 token，用英文问法，不带问题摘要。所以默认决策模型换成 pplx。`decisionModel` 只剩 pplx 和 Jev 两个选项，Clef 删掉：它的成绩不突出，维护成本也不低。已经设成 `clef` 的老配置当作没设处理。默认的 pplx 没有密钥、而 Jev 有密钥时，改用 Jev，0.3.1 的老用户升级后不会失去路由。Jev 的默认值完全不动（中文问法，1500 ms，预算 6000 和 24000），它的成绩是按这套配置量出来的。

pplx 下的取值：
- **预算**：发消息时的 effort 题、中途重判、派出 agent、Workflow 都用 48000 token。条数上限放到 2000，和评测一致，实际由 token 预算截断。skill 两段排序仍用 6000，B′ 没有评测过 skill 题。
- **等待时间**：`timeoutMs` 8000（hook 的上限是 10 秒），`rejudgeWaitMs` 6000，`findSkillWaitMs` 6000。主 agent 每次中途重判都可能停顿几秒，这个代价已接受，等待时间都可以调。
- **问法**：所有问题都用英文。
- **门槛**：thetaMax 0.47、thetaUp 0、thetaDown 0.55（离线校准）。"往上取一档"的门槛 `ROUND_UP` 改成按后端设置，pplx 用 0.45：离线测得日常消息的判高从 18.5% 降到 13.0%，max 召回不变，eval v2 的判低从 12.5 升到 15.0。关掉这一步也只能降到 12.5%，用户原定的 12% 达不到，验收线改为 14%。
- **限速**：Perplexity Tier 0 只有 1 QPS，mod 内部按 `$.state` 排队，默认每秒最多 1 个请求（选项 `pplxQps`），先发 effort 题。遇到 429 时，剩余时间够就按 `Retry-After` 重试一次。
- **密钥**：敏感 userConfig `perplexityApiKey`，读不到时用环境变量 `PERPLEXITY_API_KEY`，绕开 Desktop 读不到敏感配置的问题（#35）。

问题摘要、未解决次数和强提示（#36）对 pplx 和 Jev 都没有提升，但代码保留。它们共用的 `unresolved` 开关默认改成关闭，打开后对两个后端都生效。

这次改动行为变化较大，发 0.4.0。

考虑过的其他做法：
- 保留 Jev 作默认、pplx 作选项：新用户就用不上评测第一的方案。
- 直接只留 pplx：没有密钥的老用户升级后会突然失去路由。
- 对 pplx 也关掉"往上取一档"：判高只比 0.45 低 0.5 点，却少 1 个 max 召回，还放弃了"拿不准时偏高"的方向。
