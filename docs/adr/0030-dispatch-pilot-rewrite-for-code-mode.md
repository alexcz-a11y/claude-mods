# Dispatch Pilot：从零重写成单个 plugin，普通会话和 Code Mode 会话走同一条路径；新看板是时间轴加分区面板

2026-11-17 到 11-18 用户的决定。起因：ADR 0028 为了让 Code Mode 能开，把 Dispatch Pilot 拆成本体和一个 extras plugin 两个 plugin，本体在 extras 不在时走另一条路，结果是两套路径、两套测试，两种会话的行为不一致。Claude Code 2.1.327 起，挂了 `tool.call`、`agent.spawn` 这类事件的 mod 不再挡 Code Mode（release note："Changed Code Mode to no longer refuse to start when an installed mod hooks tool calls"），拆分的理由不在了。用户要求：从零重写，不沿用旧代码和旧注释；三项换挡（发消息时、一轮中途、派出 agent）和 skill 一组功能都保留；同一套代码在两种会话里行为一致，并且不抵消 Code Mode 的收益；决策模型的问法、读法和参数严格照 Nace 和 TypeSafe 现行的官方文档；旧看板又丑又乱，整个删掉重做；任何会话、任何测试都不打开 OpenTelemetry。设计见 `docs/superpowers/specs/2026-11-17-dispatch-pilot-rewrite-design.md`。

## 决定

- **单个 plugin、单条路径。** 删掉 extras plugin，`dispatch-pilot` 原地换成新实现，版本 `1.0.0`，要求 Claude Code 2.1.327 及以上。挂的事件：`session.start`、`command.run`（`/dp`）、`prompt.submit`、`prompt.attachment`（`skill_listing`）、`skill.prompt`、`turn.start`、`turn.step`、`agent.spawn`、`session.append`、`turn.complete`、`http.fetch`，以及看板的 `ui.render` 和 `ui.close`。
- **不挂 `tool.call` 一类的事件。** 2.1.327 起挂了也不挡 Code Mode。但 mod 不为脚本内部的每次调用发决策请求、做决定，这些调用的结果行经过 `session.append` 时只记下工具名和是否失败（这会不会让脚本变慢没有测过）。所以 `tool.call`、`tool.check`、`tool.run`、`tool.judge`、`agent.offer`、`session.send`、`classic.*` 和 `$.tool.register` 都不用，`eval/validate.ts` 检查。中途判断的依据从 `session.append` 的行里读。`agent.spawn` 只落在派出 agent 的那一次调用上，所以用它。
- **模型只给判断，决定在代码里。** 每处判断都问同一道 `score` 题（问题有多开放，五档各是一种情形）和几道 `noul` 条件题，档位和模型由代码里的规则从概率算出，没有一道题问「该用哪一档」。门槛按后端、模型版本和动作各存一张表，现在全是初值（0.7、0.8、0.7/0.3），校准之后再定。
- **一轮中途在结果行上加一行说明换档。** 只带工具结果的步上改 effort 发不出去（E4），在结果行上加一个 text 块，下一次请求起就是新档（E5、E6）。Code Mode 会话里每到达一份脚本结果是一个检查点，普通会话里是失败成簇和每 8 个工作步，两种会话里都有新输入。一轮最多 4 条说明，两次换档至少隔 3 个工作步，中途最高 `xhigh`（后来被 ADR 0031 改了：中途可以升到 `max`）。
- **派出 agent 在 `agent.spawn` 上判断。** hook 最多等 3 秒，用 `next({ ...e, model })` 定模型，effort 由 agent 的每一步写出。模型只往下换，只在把握大时才换；`fableAgents` 关着时没有明写模型的 agent 最高到 `opus`。
- **skill 照旧：** 收起主循环的 skill 列表，发消息时照 TypeSafe 的 skill_suggestion cookbook 最多推荐一个，`dispatch-pilot:find-skill` 是 plugin 自带的 skill（ADR 0002、0018、0021 的做法，ADR 0028 里 `find_skill` 改成 skill 的那一条留下）。发消息时 effort 题和 skill 的第一次请求合成一次请求。
- **后端：** 默认 Drex `drex-max-v1.1`（固定版本，回答的 `model` 不符按失败处理），另一个是 Jev `jev-latest`。失败时改问另一个后端由开关 `fallback` 控制，默认关，因为 Jev 不参加校准。时限：发消息 4 秒、中途 2 秒、agent 3 秒，超时放行、不重试。
- **任何失败都放行。** 每个 hook 的主体包在兜底里，总是走到 `next(e)`。`mode: shadow` 只判断和记录，不改任何东西。
- **读实际发出的档位。** mod 挂 `http.fetch`，从引擎每次模型请求的请求体里只取顶层 `output_config.effort`，请求原样放行（E15）。看板、`/dp` 和决策记录上的档位以它为准，读不到时标「未核对」。
- **新看板。** 旧的 band、脚部摘要、依据面板和它们的代码全部删掉，不沿用布局。用户在四种风格里选了时间轴加分区面板：时间轴常驻在 prompt 上方（每个工作步一格、评估的记号、下次评估的触发条件），分区面板由 `/dp` 开关（现在、换挡记录、上次评估、下次评估、功能、agent、skill）。终端和 Desktop 用同一份数据和同一套布局。文字的颜色只用主题键；图形里固定的颜色用一种在明暗主题上都看得清的中灰。
- **配置从 40 项减到 24 项**，四个布尔开关 `submitShift`、`midrunShift`、`agentShift`、`skills` 管四项功能。`/dp` 不再翻转开关，只有 `lock`、`unlock` 和 `log`。数值选项仍不声明 `min`、`max`（ADR 0027 的理由）。
- **进展记录**（`progressNote`）作为待比较的选项做出来，默认关，留不留由校准定。

## 取代的旧决定

旧 ADR 不改，下表说明哪些条目不再成立。

| ADR | 不再成立的部分 |
|---|---|
| 0028 | 整条：两个 plugin、经 `$.dispatchPilot` 的桥、extras 不在时的另一条路、只有 `Poll` 的步不算一步、`script-results` 开关、`visual_check` 工具。留下的只有 `find_skill` 改成 plugin 自带的 skill |
| 0004 | 「给人看的输出只有一个写入者」的汇报模块、band 和依据面板。终端仍不用 `$.ui.status` |
| 0011 | 不带终端的会话用状态行、非终端端的色带和概率条。现在状态行只在 Desktop 上写，VS Code 和手机端不画看板 |
| 0012 | Desktop 上按「点」画的界面和「状态行让给 band」。Desktop 上状态行写当前档位和最近一次换挡 |
| 0008、0019 | 看图核对、放大复核、复杂度读数、带图请求走 Jev、发消息时读图：都不做 |
| 0013、0023 | 失败时派出 agent 改模型或只升 effort（失败升档）：不做，agent 的模型只在派出时定一次 |
| 0027 | `escalateAfter` 和 `/dp` 翻转开关并写回配置；「开关是配置里的选项、数值不声明 min/max」留下 |
| 0003 | 功能分文件、核心最后注册、计划表和投票箱 |
| 0005、0006、0007、0009、0010、0017 | 单独的 effort 请求、pplx 默认、背景、长上下文和合并的 agent 请求、强提示、Liquid 的 d1-ultra 和 d1.1 |
| 0014、0016、0022 | 规则下限 R1 到 R5、未解决次数、问题摘要、长期约束、上一轮的事实、「确认」和「要求升级」两题。发消息时只留一道「是否只是续做」，为是时从上一轮的档位起算 |
| 0015、0024 | 派出 agent 的模型表、主 agent 的指定只升不降、降到 haiku 的那一条 |
| 0020、0025 | 一轮中途在事件上追加一行输入换档、按步数再看默认关。现在在结果行上加说明，检查点见上 |

0001（主 agent 只调 effort，不换模型）、0002（隐藏 skill 列表）、0018 和 0021（skill 照 cookbook，Jev 用 `jev-latest`，named 一题）、0026（Drex 默认，现在所有判断都只有文字）仍然成立。

## 实测（Claude Code 2.1.326 和 2.1.327）

见 `dispatch-pilot/DEVELOPMENT.md` 的「设计 3.2 节的实测」「引擎规则」和「Code Mode 一轮里的行」。要点：挂了 `tool.call`、`agent.spawn`、`agent.offer`、`session.send`、`ui.render`、`http.fetch` 的 mod 都不挡 Code Mode；Code Mode 下主循环在 `Poll` 的结果行或 `REPL` 的回执行上加说明之后，下一次请求起就是新档，`delivery` 行带不了换档；`agent.spawn` 上改模型生效；换档不丢缓存。2.1.327 的交互终端里加载过新实现（没有密钥、没有发消息）：Code Mode 照常开启，时间轴、脚部标签和面板都画了出来。带着真实密钥跑完三项换挡的实机验证还没有做。

## 代价和没做的

- 每次中途换档往上下文里加一行，约几十 token。
- 档位发出去之后模型的做法不一定跟着变（E14）；效果要在校准时用真实任务的结果来验，验不过时停下来问用户，不自行降级。
- 门槛和措辞都没有校准；Jev 没有校准过的门槛。
- Workflow 派出的 agent、续跑的和 fork 出来的 agent 不处理；agent 中途不再判断。
- 一轮中途进来的新输入只有 prompt 行被当作自己带着输入的一步，作为附件送进来的输入和脚本结果一样要靠说明行。
- Desktop 上的看板只由测试验证：Claude Desktop 自带的 Claude Code 是 2.1.325，低于 2.1.327。
