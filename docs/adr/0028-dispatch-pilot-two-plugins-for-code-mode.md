# Dispatch Pilot：拆成两个 plugin，本体不挂 Code Mode 不允许的事件；`find_skill` 改成 skill

2026-11-14 用户的决定。起因：用户要开 Claude Code 的 Code Mode（实验功能，2.1.323 起），启动时提示 `Code Mode (experimental) isn't available: it doesn't yet work with an installed mod (a plugin with JavaScript hooks) that checks tool calls`。从 2.1.325 的二进制里读出判定：引擎扫描每个已启用、非内置的 mod 的 hooks 模块，只要注册了 `tool.call`、`tool.check`、`agent.offer`、`agent.spawn`、`session.send` 或 `classic.PreToolUse` 等十个 classic 事件中的任何一个，就不开 Code Mode（matcher 不看，和文件是 ts 还是 js 无关）。Dispatch Pilot 当时有十五个这样的 hook。用户要求：发消息时的 effort、一轮中途按步数和事件重判并换档、派出 agent 的模型和 effort、skill 推荐和 `find_skill` 在 Code Mode 下照常工作；Workflow 暂时不考虑。

## 决定

- **两个 plugin。** `dispatch-pilot` 是本体，不注册上面任何一个事件（`eval/validate.ts` 检查）。`dispatch-pilot-extras` 注册 `tool.call`、`agent.spawn`、`classic.PreToolUse`，每个 hook 只有一行，自己不做判断、没有配置、不发请求，依赖 `dispatch-pilot`。普通会话两个都装；Code Mode 会话里禁用 extras。
- **逻辑不搬家，经一个桥过去。** 原来那十五个 hook 的主体原样留在本体里，写成本体自己的名词事件 `dispatchPilot.start`（按 hook 的名字匹配）的 hook 的主体（`hooks/core/bridge.ts`）。extras 的 hook 调 `$.dispatchPilot.start` 把主体跑到它的 `next`，自己调引擎的 `next`，再用 `$.dispatchPilot.resume` 把结果交回去让主体跑完。函数过不了 plugin 的边界，所以一个 hook 分成两半跑；状态、决策模型和密钥都留在本体。两个都装时，每个 hook 的行为和拆分之前一样，十五个 hook 的嵌套顺序由 extras 里的注册顺序保持。
- **本体怎么知道 extras 在不在。** extras 在 `engine.create` 里给 `$` 加一个自己的名词（`$.dispatchPilotExtras.present()`）；本体调它，调不到（抛错）就是不在，每次加载问一次（`hasExtras`）。不靠「有没有被调过」来猜。
- **extras 不在时，本体走另一条路（只在那时）：**
  - 工具调用从对话的行里读（`hooks/core/calls.ts`）：`session.append` 的 response 行给出调用的 id、工具和参数，tool-result 行给出 `is_error` 和报错文字。Code Mode 下模型自己的调用只有 `REPL` 和 `Poll`，脚本里的每个调用各有一对行，所以读到的是脚本里的调用，`REPL` 和 `Poll` 不算。一轮中途的 effort（事件、按步数再看、追加一行换档）和失败计数都从这里接着走。「被 settings hook 拦下」靠 Claude Code 的报错文字认。
  - 派出的 agent 在它自己那一轮开始时判断（带 `agentId` 的 `turn.start`，引擎等它返回才发第 0 步）：任务是这一轮的文字，description 和类型来自 `$.agent.list()`。模型和 effort 一起写进计划表，由核心的 `turn.step` 每一步写出。fork、teammate、名单里没有的 agent（Workflow 的）不判断；被消息唤醒的 agent 沿用原来的决定。
  - 按步数再看时，只有 `Poll` 的步不计（`MidrunRecord.idle`）。
- **`find_skill` 改成 skill，两种会话都一样。** plugin 自带 `skills/find-skill/SKILL.md`（正文 `Query: $ARGUMENTS`），主 agent 用 Skill 工具加载 `dispatch-pilot:find-skill`、工作写在参数里，mod 在 `skill.prompt` 上把正文换成查询结果。不再注册工具。列表位置上的提示改成写这个 skill 的名字。它自己不在返回的 skill 里，加载它不算「加载了一个 skill」这个中途事件。
- **`visual_check` 工具只在 extras 在时注册**（它在 `tool.call` 里回答）；Workflow 工具说明里的 label 提示也只在那时加。

## 实测（Claude Code 2.1.325）

见 DEVELOPMENT.md「已实测的引擎行为」的「2.1.325：Code Mode 和 mod」。要点：只挂允许事件的 mod 不挡 Code Mode；`turn.step` 改主 agent 的 effort、改派出 agent 的模型和 effort 都生效；Code Mode 下换档仍要追加一行，从 `session.append` 的 hook 里追加可行；脚本里的每个调用都有一对行；`skill.prompt` 对脚本里的 Skill 调用生效；`user` 层 plugin 加的名词别的 plugin 调得到。Dispatch Pilot 自己：普通会话（`claude -p`，两个 plugin）跑过一次；Code Mode 会话（交互界面，只有本体，Haiku 5.5，auto 模式，Drex）跑过两轮，四项都工作，其中一轮从 high 升到 xhigh 再到 max。

## 代价和没做的

- **Code Mode 下没有的：** Workflow 里的 agent（两个功能都靠 `tool.call` 在脚本运行前改写、`agent.spawn` 上的 label）、看图核对、截图接管、Agent 工具结果旁给主 agent 的说明。
- **Code Mode 下派出 agent 的模型写在计划表里**，每一步都按它发，引擎过载时自动换模型的兜底因此不起作用（派出时设模型没有这个问题，所以两个都装时仍然设在派出上）。主 agent 在脚本里给 agent 指定的模型读不到（那次 Agent 调用的行在 agent 开始之后才出现），「只抬不降主 agent 的选择」这条在那里不成立；你在消息里点名的模型照常算数。同一条消息派出的几个 agent 各问各的，不合并成一个请求。
- **Code Mode 下的一步比普通会话大得多**（一段脚本里可以有很多调用），`midrunEverySteps`、换档间隔这些以步为单位的值没有为它重新定，也没有评测。只有按步数再看的间隔扣掉了只等结果的步。
- **每个工具调用多几次 plugin 之间的往返**（两个都装时，`tool.call` 上两个不带条件的 hook 各一来一回，实测每次不到 1 毫秒）。
- **本体挂了 `engine.create`**：任何一个 mod 重载时所有模块都重载（引擎的规则），`/dp` 翻转开关时也是。
- **没试过的：** auto 以外的权限模式（`REPL` 同步返回时的行）、同时派出多个 agent、Code Mode 下的 fork 和 teammate、Desktop 和 VS Code。extras 自己没有测试文件：它的 hook 在本体的测试里有一份等价的内联 plugin，两份清单由 `eval/validate.ts` 核对。
- **其他 mod。** `image-pane`（`tool.call`）和 `prefer-search-tools`（`agent.spawn`）也挡 Code Mode，这次没有动。
