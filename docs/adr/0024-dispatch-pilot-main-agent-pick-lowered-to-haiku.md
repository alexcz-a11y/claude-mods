# Dispatch Pilot：主 agent 给只是照做的工作指定了 opus 或 fable 时，降到 haiku

ADR 0015 定了「主 agent 的指定只升不降」：主 agent（Workflow 里是脚本写的 `model`）给派出的 agent 指定了模型时，表给的更强才换，否则保留，理由是它写任务时看得到上下文，降级出错的代价比多花一点贵。ADR 0023 重做模型表之后，Jev 选模型对 90%，剩下的错每 100 个回答有 8 个出在这条规则上：主 agent 给「跑两条命令并列出失败项」「按模式搜索并列表」这类工作指定了 opus 或 fable，表给 haiku，仍照它的指定用。把这个数报给用户之后，用户 2026-11-11 定了：「agent的制定允许降低模型」；同一条消息里也定了 Liquid 不用模型表，继续按它们官方的路由（ADR 0017 不变）。路由选了 `fast` 时同样降，用户看了 d1.1 的数之后确认了：「liquid也允许降」。

决定：

- **降的只有一种情形**：规则读成这项工作只是照做（模型表停在第 ④ 行：`judges` 否而且 `logic` 否；d1-ultra、d1.1 是路由选了 `fast`），而主 agent 指定的是 opus 或 fable。这时用规则给的 haiku（`requested.outcome` 为 `lowered`；`decision/dispatched-agent.ts` 的 `LOWERED_FROM`）。高出两档以上才降。
- **其余和以前一样**：规则给的更强就升；给照做的工作指定 sonnet（高一档）保留；给普通工作（第 ⑤ 行，sonnet）指定 opus 或 fable 保留。第 ⑤ 行是「其余」，没有哪道题说这项工作不值 opus；第 ④ 行是两道题都明确答否。
- **只有规则自己读出来的 haiku 才降**：表给 sonnet、而 sonnet 和 opus 被你排除才顶上来的 haiku 不算；路由拿不准退到最强的模型时也不降。
- 你点名的模型、排除的模型照旧优先；你点名了模型时这条规则不起作用。
- Workflow 脚本里写的 `model` 同样处理：表给 haiku 而脚本写的是 opus 或 fable，改写成 haiku。
- 日志、卡片和给主 agent 的说明都写明是降下来的（「主 agent 指定的 opus 高出两档以上，降到 haiku」「lowered from the opus you asked for: …」），说明里那句路由规则也改了：指定的模型保留，除非工作需要更强的，或者给只是照做的工作指定了 opus 或 fable。

考虑过的其他做法（在 ADR 0023 存下的回答上离线比，Jev，600 个回答，模型对的比例）：

- **只升不降**（原来的）：89.7%。
- **表给 haiku 而指定是 opus 或 fable 时降**（选的）：95.7%，改了 36 个回答，全对。
- **高出两档以上一律降**（多一种：指定 fable、表给 sonnet）：评测集里没有这种题，结果相同。没选：`agentFable` 关着时不问前沿难题那一道，表说不出一项工作不值 fable。
- **不管指定，一律用表的**：94.7%。它把主 agent 给普通工作指定的 opus 也降成 sonnet，评测集里有两道这样的题（审 refresh token 的改动、重写 CSV 解析器）认为该保留：只差一档、说得过去的指定是主 agent 的判断。

代价：

- 主 agent 确有理由用强模型做一件看上去只是照做的事时（任务文字里没写出来的理由），现在会被降到 haiku。评测里没有这样的题；真遇到时，在消息里点名模型就照办。
- 给 haiku 的 agent 更多了。Anthropic 的文档提醒小模型在长的循环里会提前交回。
- d1.1 的路由只对 77% / 75%，按它降的 15 个回答里错了 1 个。

验证：

- `subagent`（Jev jev-1.14.0，`nouls`，3 次，中文题 / 英文题）：模型对 96.0% / 96.0%，effort 对 88.3% / 89.0%，两样都对 88.3% / 89.0%（只升不降时 90.0% / 89.3%，82.3% / 82.3%，82.3% / 82.3%）。降下来的 36 个回答全对。结果在 `eval/results/subagent/2026-11-11-jev-pick-lower-x3.json`。
- d1.1（路由，1 次）：模型 77% / 75%，两样都对 71% / 69%（只升不降时 72% / 71%，67% / 63%）。结果在 `-d1.1-pick-lower.json`。
- 真实会话（Claude Code 2.1.322，主 agent Sonnet 5.5，Jev）：主 agent 给两个 agent 都指定了 opus。「跑 `ls` 和 `wc` 并列表」降到 haiku low，对话记录里跑的是 `claude-haiku-5-5`；「给脚本加一个 `--reset` 参数」保留 opus（表给 sonnet，只差一档）。同一个提示词里写出「opus」这个词时，决策模型读成你点名了 opus，两个都照用 opus：点名优先。
- 测试：`tests/dispatched-agent-module.test.ts`（升、降、保留各一种，替被排除的模型顶上来的 haiku 不降，日志、卡片和说明的写法）、`tests/d1-ultra.test.ts`（路由的 `fast`，拿不准时不降）、`tests/workflow-agents.test.ts`（脚本里的 `model` 被改写）。
