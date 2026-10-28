# Dispatch Pilot：effort 按消息生效，删掉一轮中途重判；失败时派出 agent 改模型，主 agent 只记下这一轮的事实

Claude Code 2.1.312 起 effort 按消息生效：生成的类型声明（`turn.step` 的 `effort`）写着 "On a model that takes effort per message a level stands from one message with input to the next"。2026-10-28 用三个临时探针 mod 在 2.1.312 上实测（Sonnet 5.5，`claude -p`，主 agent 4 步，读会话记录里每条助手消息的 `effort` 和 `model`）：

- `turn.step` 在只带工具结果的一步上把 effort 改成 `max`，不生效：4 条助手消息都是第 0 步写的 `low`。同一个探针在 2.1.310 上，第 1–3 步是 `max`。
- 改成数字 `95`，引擎拒绝：`next() passed an argument with an effort that is not one of low, medium, high, xhigh, max`，那一步照旧是 `low`。
- 在工具结果上加 hook 的 `context`，那一步也不算带输入的消息，effort 照旧是 `low`。
- 从第 1 步起改 `model`（`haiku`），从那一步起就生效：之后各步都是 `claude-haiku-5-5`。

0.8.x 有两项功能靠一轮中途改 effort：中途重判（#5，每隔几步，或派出 agent、启动 Workflow、加载 skill 时，再判一次主 agent 的 effort）和强制升档（#7，失败满 `escalateAfter` 次后问决策模型这些失败是不是预期内的，不是就升 effort）。在 2.1.312 上，它们照样发请求、写看板，改的 effort 却发不出去。

决定：

- **删掉中途重判。** 一起删掉的有：开关 `midturn-effort`；选项 `rejudgeEvery`、`rejudgeSteps`、`rejudgeWaitMs`、`thetaUp`、`thetaDown`、`holdSteps`；`$.state` 的 `midturn`、`mainStep`，以及计划表 `turns` 的 `floorUntil`、`raisedAt`；看板上的中途重判次数和改档事件；评测集 `effort-midturn` 和 `scripts/decide-stuck.ts`（旧结果留在 `eval/results/effort-midturn/`）。主 agent 的 effort 只在发消息时定。一轮进行中用户又输入的消息照常判断：它送进这一轮的那一步带着输入，那一步写的 effort 生效。主 agent 一轮中途读到参考图时再判一次的那条路（`features/reference-midturn.ts`）也删掉；用户在一轮进行中贴的图，读完再判一次这条消息，赶在它送进这一轮之前就用。
- **派出 agent 失败时改模型。** 派出 agent（包括 Workflow 里的）计入的失败满 `escalateAfter` 次，从它的下一步起改用高一档的模型：haiku 升到 `escalateHaikuTo`（默认 sonnet），sonnet 升到 opus，opus 只在打开 `agentFable` 时升到 fable。每个 agent 最多升 `escalateLimit` 次；用户点名的模型不换，排除的模型跳过。不问决策模型，也不改 effort。删掉 `escalateMode` 和 `thetaExpected`（「是不是预期内」那一问），保留 `escalateAfter`、`escalateLimit`、`escalateHaikuTo`。看板和决策日志写「升模型」：从哪个模型升到哪个、失败了几次。
- **主 agent 只记下这一轮的事实。** 主 agent 的模型从不改（ADR 0001），effort 一轮中途改了也不生效，所以它的失败照样数，但什么都不升。用户本人的消息开始的一轮结束时，把这一轮的事实记在它的一轮记录上（`turns[].facts`）：发出的 effort、工具调用次数、失败次数、被 hook 拦下的次数、计入的失败到没到 `escalateAfter`，以及最后最多两行出错信息（先脱敏，截短）。这些事实留给下一条消息的判断，怎么读另行决定；0.9.0 只记下。

考虑过的其他做法：

- **改用数字 effort。** 引擎拒绝数字（见上面的实测）。
- **往工具结果里加上下文，让那一步算作「带输入」。** 实测不算，effort 照旧不生效。
- **保留这两项功能。** 看板和依据卡片会写出一次次从没发出去的改档和升档，让人以为它在起作用，而请求照样花钱、占额度。
- **主 agent 失败时也换模型。** 换模型会让 prompt cache 失效，违反 ADR 0001。

代价：

- 一轮里工作变难（例如卡住），主 agent 要等下一条消息才可能换档。
- 派出 agent 换到更贵的模型会多花钱，每个 agent 最多 `escalateLimit` 次；换模型只影响它自己的缓存。
- 2.1.312 之前的引擎上，一轮中途改 effort 本来生效；0.9.0 在那些版本上也不再改。
- 「一轮进行中输入的消息，从它送进的那一步起用它的档」只是按类型声明推断的，没有实测。

后来被 ADR 0014 改了：一轮进行中贴的图不再读完再判一次，这条消息只按文字判一次；主 agent 一轮的事实进下一条消息的 state（`last_turn`），规则 R4 读它。
