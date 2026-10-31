# Dispatch Pilot：带图消息在发消息时读图（Claude Code 2.1.316 起的 `$.prompt.media`），旧引擎照旧在这一轮开始时读

Claude Code 2.1.316 改了 `$.prompt.media`：生成的类型声明从 "For a mod managed settings install, in its `prompt.submit` hook; else `{ deny }`" 改成 "For a `prompt.submit` hook; else `{ deny }`"，`PromptMedia` 从 "Only a mod managed settings install is answered" 改成 "Only a hook on the `prompt.submit` that lists the item is answered"。2026-10-31 用临时探针 mod 实测（`--plugin-dir` 加载，debug log 写 tier user；`claude -p --input-format stream-json` 贴一张 40×30 的 PNG，探针读完就 `{ drop }`，没有发模型请求）：`$.prompt.media({ id })` 返回了这张图的字节（`size: 114`，没有 `deny`）。详见 `docs/research/decision-model-images.md` 第 4 节开头的更正。

在这之前，user scope 安装的 mod 在 `prompt.submit` 里拿不到图的字节（ADR 0008 的调研第 9 条），所以带图路由（#63）把开始一轮的带图消息推到 `turn.start` 才定：`session.append` 记下这条消息的图，`turn.start` 读出复杂度读数，再单独发一次 effort 请求。一轮进行中又输入的带图消息不能等一轮开始，0.9.0 起只按文字定一次（ADR 0014）：图读完再定的那一次可能落在只带工具结果的一步上，不生效（ADR 0013）。

决定（0.10.0）：

- **能读就在发消息时读。** main-effort 对带图的消息（开关开着、有图像后端、不是命令轮、不是报告）一律把 effort part 交给 `core/deferred.ts`，一轮进行中输入的也一样。image-routing 在同一次 `prompt.submit` 里（main-effort 之内、核心之外）用 `$.prompt.media` 一片一片读出每张图（`attachedImages`：每次最多 4 MiB，按 `next` 续读），读出复杂度读数（最多等 3 秒，和以前一样），再把带着读数的 part 放进投票箱，由核心和其他题一起发出。effort 题仍单独一个请求（ADR 0005）。
- **等待共用一个 hook 的时间。** 读数用掉的时间记在 part 上（`waitedMs`），核心发投票箱时等待取 `min(决策模型的等待, 9000 − 读数用掉的)`，至少 `MIN_ASK_MS`（`ballotWaitMs`）。和以前 `turn.start` 那条路的算法相同。
- **一轮进行中输入的带图消息带着读数定一次。** 它仍在送进这一轮的那一步之前定（发消息时），所以那一步带着输入，档位生效；看板上的档就是引擎用的档。它的读数也进 `referenceReadings`，派出 agent 和 Workflow 取最近一次读数时能取到。
- **读不到就按旧路走。** 引擎拒绝（`{ deny }`，2.1.316 之前的引擎；Desktop 自带的 2.1.309 就是）或调用抛错（测试框架没有 `$.prompt.media` 的实现，调用报 `no implementation for prompt.media`）时，开始一轮的消息照旧等到 `turn.start` 从这条消息的行里读图；一轮进行中输入的照旧只按文字定。所以最低版本仍是 2.1.300。
- **单张图的问题不连累整组。** 引擎处理不了的图（`{ unreadable }`）或太大的图（base64 超过 1200 万个字符）跳过，其余照读；一张都读不到就不带读数定。只有引擎拒绝读（`deny`）时整条消息改走旧路。

代价：

- 新路读的是引擎缩放之后的字节（长边约 2000），旧路优先读 `[Image: source: <路径>]` 指向的原图。复杂度读数本来就先把每张图缩到约 100 万像素，影响应该很小，但没有评测过。
- 新路只在 2.1.316 起的引擎上走；测试框架不能模拟 `$.prompt.media`，world 里的带图测试走的都是旧路。新路只有 `attachedImages` 和 `ballotWaitMs` 两个纯函数的单元测试（`tests/prompt-media.test.ts`），整条流程（读图、读数、带着读数的 part 进投票箱）没有在真实会话里跑过：用户要求不再做图像的实测（2026-10-15），这次也没有跑。
- 开始一轮的带图消息改在发消息时定，effort 请求和 skill 推荐等题同时发出，不再在 `turn.start` 另发一次；这一轮的决定在看板上记在下一轮（`forTurn: next`），和不带图的消息一样，旧路仍记 `current`。

改了 ADR 0008（带图消息在 `turn.start` 定，现在只是旧引擎的后备）和 ADR 0014 的「一轮进行中贴图的消息只判一次」（仍只判一次，但能读图时带着读数判）。
