# Dispatch Pilot：一轮中途换档的提示加在工具结果那一行上，不再另外追加一行

2026-11-17 用户的决定。起因：Claude Code 2.1.326 上一轮中途换档不再生效。0.11.0 起的做法（ADR 0020）是要换档时用 `$.session.append` 往对话里追加一行 user 行，让下一步带上输入；2.1.326 把 plugin 追加的、紧跟工具结果的行改成系统消息发出（会话记录里是 `plugin_note` 附件，`sentAs: "system"`），它不算新输入，`turn.step` 里写的档发不出去。同一个探针在 2.1.325 上是 low、low、high ×4，在 2.1.326 上追加之后一直是 low。

原因在 API 一侧：按消息的 effort 由一条空的 system 消息携带，只有带新输入的 user 轮才接受，`A user turn that holds only tool_result blocks doesn't count as new input`（平台文档 `effort-per-message`）。

## 决定

- **提示加在工具结果那一行上。** `session.append`（`door: 'tool-result'`）的 hook 在 `next` 之前，往这一行的 `content` 末尾加一个 text 块（文字是 `switchNote` 的那一句英文；原来包在 `<system-reminder>` 里，屏幕上两行标签原样显示，用户决定去掉，只留这一句；自己回读对话的地方按这句话的写法把它剔除，`decision/context.ts` 的 `withoutReminders`）。下一个请求的 user 消息里就有工具结果和这段文字，是带输入的一步，新档从那一步起生效并保持。这是平台文档 `mid-conversation-system-messages` 给出的写法（文字作为 text 块放在同一条 user 消息的最后一个 `tool_result` 后面）。纯函数在 `hooks/core/notes.ts`，hook 在用它的两个功能里。
- **先挂着，行存下了才算换。** 决定换档时只把这次换档挂起来（主 agent 的在 `features/midrun-effort.ts` 的 `pending`，派出 agent 的在 `features/escalation.ts` 的 `waitingRaises`）；提示加上、`next` 返回的行里确实有它，才改计划表、改记录、记决定。行里没有提示时不换，日志照实写；派出 agent 的那一次升档退回去不算，换得了模型就换模型。挂着的时候这一轮不再问决策模型：别的调用看到的还是旧档。模块级变量，热重载丢了的代价是这一次不换。
- **只加在请求会带上的行上。** Code Mode 会话里脚本各调用的行（id 是 `repl_…`）只在会话记录里，请求不带；提示加在下一个 `REPL` 或 `Poll` 的结果行上，新档比普通会话晚一步生效。
- **两个 plugin 都装时，判断的位置不变。** 仍在 `tool.call` 的 hook 里问决策模型（经 `dispatch-pilot-extras` 的桥）；那次调用的结果行在它的 hook 全部返回之后才到，提示就加在这一行上。只有本体时，判断从「行存下之后」挪到「行存下之前」（同一个 hook 里、`next` 之前）。
- **提示在对话里看得到。** 追加的行原来不显示；加在结果行上的文字显示成一行。用户的决定：可以接受，它正好标出从哪里开始换档。
- **不按版本分两条路。** 加在结果行上的写法在 2.1.325 的二进制上也生效，所以只留这一种。

## 没有采用的

- 等引擎改回去，或按版本各走一条路：两套机制、两套测试，而新写法在旧版本上同样有效。
- `$.prompt.submit`、`$.command.run`：等会话空闲才执行，到不了这一轮中间。
- `$.session.send` 发给本会话：`-p` 下没有可送达的会话；交互会话里也是一条排队的消息，不在这一步。
- `tool.call` 结果上的 `context`：系统消息，不算输入（2.1.312 测过）。
- 关掉按消息的 effort（`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`）：effort 变成请求级的，每次换档重写缓存（实测 10 万 token 的上下文一次 0.41 美元，对比 0.02 美元）。

## 一并改的（同一次审查，2.1.326 新增的字段）

- **`AgentInfo.model`**：只有本体的会话里，派出 agent 在它自己那一轮开始时判断。它实际跑在哪个模型上以前只能猜（主 agent 调用里写的，没写就当会话的模型）；现在读名单里的 `model`，已经在决定的模型上就不把模型写进计划表（免得压住引擎自己的过载回退），看板上的模型也是实际的。它分不出「指定的」和「默认的」，所以「主 agent 指定了什么」仍从调用里读。
- **`isTextDisplayOnly`**：`/dp` 的回答只给用户看，2.1.326 起不再进请求。
- **`engines`**：两个 plugin 的 `plugin.json` 写明 `claude-code >= 2.1.300`。
- **没有换的**：`$.session.info()`（`-p` 下只有 `transcriptPath`、`platform`、`isHosted`，没有要用的）；`$.agent.limits()`（并发上限 mod 用不上）；`AgentInfo.effort`（agent 开始时还没有）；`usage`、`cost`、`lastRequest`（看板不画花费，加了是新功能，不是替换）；Code Mode 的拒绝名单没有放开任何事件（反而多了 `tool.judge`、`tool.run`），extras 的 hook 搬不回本体。

## 依据

实测记录在 `dispatch-pilot/DEVELOPMENT.md` 的「已实测的引擎行为」（2.1.326 一节）：追加一行在两个版本上的对照，加在结果行上的各种情形（主 agent、并行调用、派出 agent、Code Mode、2.1.325）。

接续 ADR 0013（effort 按消息生效）、ADR 0020（一轮中途在事件上换档）、ADR 0028（两个 plugin 和 Code Mode）。
