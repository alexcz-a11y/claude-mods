# dispatch-pilot 开发说明

README 写给使用者；这里写代码怎么划分、测试怎么写、实测过的引擎行为和测试工具的限制。设计以 `docs/superpowers/specs/2026-11-17-dispatch-pilot-rewrite-design.md` 为准，这次重写的决定见 `docs/adr/0030-dispatch-pilot-rewrite-for-code-mode.md`。

## 文件划分

```
dispatch-pilot/
  .claude-plugin/plugin.json   清单和 userConfig（数值选项不声明 min/max，范围在 readConfig 里夹）
  hooks/hooks.json             {"modules": ["./dispatch-pilot.ts"]}
  hooks/dispatch-pilot.ts      入口：register 和每个 on(...)，每个 hook 里各功能动手的先后
  hooks/runtime.ts             各 flow 共用的、碰 $ 的部分：trace、failOpen、ioOf、record、amendSent、redraw、verifies、keepSurfaces
  hooks/flows/dp.ts            /dp 的注册和回答
  hooks/flows/submit.ts        发消息时的判断、一轮的开始、主循环的每一步、一轮的结束
  hooks/flows/skills.ts        收起 skill 列表、推荐、find-skill
  hooks/flows/agents.ts        agent.spawn 上的判断、agent 的每一步、核对 agent 实际发出的档位
  hooks/flows/midrun.ts        session.append 的每一行：检查点、判断、说明行
  hooks/flows/progress.ts      进展记录的在途调用
  hooks/flows/readout.ts       http.fetch 上读实际档位
  hooks/config.ts              readConfig(options)
  hooks/levels.ts              档位、模型层级
  hooks/questions.ts           所有题的措辞
  hooks/decide.ts              decide、读是非题、发消息/中途/agent 的读法、门槛表
  hooks/statebuild.ts          三种 state、估 token、截断、fitState
  hooks/backend.ts             ask(io, …)：Drex、Jev、核对回答、时限、fallback
  hooks/journal.ts             从 session.append 的行里读出一轮的依据
  hooks/midrun.ts              检查点、限制、说明行
  hooks/submit.ts              发消息时的读法和 ownLevel（mod 在这一步写的档位）
  hooks/agents.ts              settleSpawn：agent 的模型、effort 和决策记录；记下的 agent 类型（knownType、learnType）
  hooks/skills.ts              解析 skill 列表、合并候选、两步问法、find-skill 的回答
  hooks/readout.ts             从请求体读实际档位、认主循环的请求
  hooks/progress.ts            进展记录的提示词和解析
  hooks/log.ts                 决策记录、/dp 的文字版
  hooks/state.ts               状态的类型（SessionState、TurnState、AgentState、TurnJournal 等）和它们的初值
  hooks/board/model.ts         看板的数据：boardModel、中文文字表
  hooks/board/view.ts          时间轴的行、面板的分区、终端的字符、Desktop 的 Svg（不碰 $）
  hooks/board/board.tsx        registerBoard(on, cfg)：三个 ui.render hook、面板的 ui.close hook
  skills/find-skill/SKILL.md
  types/index.d.ts             PluginState 契约（自成一体，不能 import；hooks/state.ts 里有一处编译期核对两边一致）
  eval/validate.ts             静态检查（scripts/check.sh 会跑）
  tests/support/world.ts       测试里垫在 mod 下面的引擎
  tests/support/rows.ts        按引擎的样子造 session.append 的行
  tests/support/standin.ts     直接调导出函数时用的替身 $
  tests/support/scenes.ts      看板的六个场景（测试和目测探针共用）
  tests/*.test.ts(x)
  tsconfig.json  README.md  DEVELOPMENT.md
```

- **纯模块** `hooks/*.ts`（agents、backend、decide、journal、log、midrun、progress、questions、readout、skills、statebuild、submit、state、levels、config）、`hooks/board/model.ts`（看板的数据）和 `hooks/board/view.ts`（看板的行和分区、每种 part 在终端画成什么字符、按显示宽度裁行；Desktop 上三种 part 的 Svg 源码、按像素宽度裁行，以及 Desktop 的状态行和脚部标签的文字）：判断、计划、文字和类型，不碰 `$`。
- **看板** `hooks/board/board.tsx`：`registerBoard`、三个渲染 hook（时间轴、面板、脚部标签，终端和 Desktop 各有画法，别的端 `next(e)`）和面板的 `ui.close` hook（不管怎么关上都重画，时间轴马上回到完整的几行（一轮进行中通常五行，没有记号行的一轮是四行）；关闭照原样往下走）。渲染 hook 读 session、turn、recent、skills 四个 atom，只画不写，也不问决策模型。这一轮的换挡（最多 `SHIFTS_KEEP` 条）和最后一次发消息或中途的评估由 `record` 记在 turn 上（`keepJudged`），一轮结束时最后那次留到 session 上作空闲时的「此前」，读数改 `sent` 时这几份副本一起改（`judgedWithSent`）：`recent` 只留 30 条各种决策，一轮里几十份脚本结果或几十个 agent 就会把它们挤出去。什么都没问、什么都没改的 agent 派出不记决策。读数分三种（`readoutOf`：已发出、没发出、未核对），排着的说明是「（还没发出）」；状态行取这一步自己格子的读数，`session.lastSent` 只给空闲时用；agent 的模型也从 `lastRequest.model` 读回（`agentSent`）。出错时 `next(e)`，每个 hook 只在第一次出错时写一行调试日志。入口只调 `registerBoard`，`/dp` 开关面板在 `flows/dp.ts`。
- **flow** `hooks/flows/*.ts`：每个功能一个文件，放在它的纯模块旁边（dp、submit、skills、agents、midrun、progress、readout）。读写状态、发请求、调 `$` 的代码都在这里，导出以 `$` 为第一个参数的顶层函数。模块级变量跟着它的 flow 走，入口要赋值或读它时，由 flow 导出一个只做这一件事的小函数。
- **`hooks/runtime.ts`**：各 flow 共用的部分，即 `trace`、`failOpen`、`ioOf`、`record` 和它的 `$.store` 写入链、`amendSent`、`redraw`、`verifies`、`keepSurfaces` 和共用常量。除了 flow 和 `board/board.tsx`，只有它碰 `$`。`redraw` 先请引擎重画，再在挂着 desktop 的会话里写 Desktop 的状态行（`$.session.surfaces()` 里没有 desktop 时只多这一次调用）。状态行要用配置：`registerBoard` 调 `holdBoard(cfg)` 把它交给 runtime.ts 的模块级变量，`board` 关着时是 null，也就不写状态行。热重载会先重新执行 `register`，所以这个变量丢了没有代价。
- **入口** `hooks/dispatch-pilot.ts`：只有 `register` 和每个 `on(...)`，每个 hook 里是各功能动手的先后顺序。它不直接调 `$.`，也不读写状态。
- flow 只在真的调用时才导入别的 flow（midrun → progress，submit → skills），不能成环。

`eval/validate.ts` 检查：hooks 模块里没有 `tool.call`、`tool.check`、`tool.run`、`tool.judge`、`agent.offer`、`session.send`、`classic.*` 的注册，也没有 `$.tool.register`（不为脚本内部的每次调用发决策请求、做决定）；同一个 state key 的 atom 声明在各文件里逐字相同；`docs/research/board-scenes/hooks/scenes-data.ts` 和 `tests/support/scenes.ts` 一字不差。

## 引擎规则（2.1.327 实测）

- **atom 要在用它的文件里声明。** `read`/`update` 的状态来源必须是字面量引用，或者是本文件里一个 const 的 `atom`/`memberOf`/`derive`。从别的文件导入的 atom 会让模块加载失败，validate 和测试工具都报 `the state library's read takes a source the scan can read: … written there or in a const of this file`。所以每个文件在顶部各自声明自己用到的 atom，一个一行，默认值取自 `hooks/state.ts` 或同样的字面量；同样的 plugin 和 key 在几个文件里各声明一次，加载和测试都没有问题。`eval/validate.ts` 检查同一个 key 的声明逐字相同。agents 这一族照旧在每个调用处写出字面量引用。
- **`$` 可以交给导入的顶层函数。** validate 和测试工具都顺着导入扫描，validate 列出调用时写成 `$.command.register (via registerDp)` 这样。限制只是：不起别名、不解构、不交给局部函数。`on` 也一样可以交给导入的函数（入口里的 `registerBoard(on, cfg)`）。
- **一次 dispatch 里的每次 `$.state` 读取读的是同一个时刻**（类型文件：「Every `get` of one dispatch reads one moment, whatever is written meanwhile.」）。所以 `prompt.submit` 自己读不到它的 `next(e)` 里开始的那一轮：一条消息的 skill 判断先放在模块级变量里，到同一段文字的 `turn.start` 上再记下（`flows/skills.ts` 的 `holdSkill` 和 `takeSkillFor`）。还没有候选时发的消息也一样：`holdUnjudged` 记下它的文字，`turn.start` 用 `takeUnjudged` 在那一轮上置 `skillsDue`，这一轮里第一份主循环的列表在 `foldListing` 里判断它（`judgeLate`，先用 `update` 把标记取走，两份列表同时到也只判断一次）。
- **`turn.start` 在 `prompt.submit` 的 `next(e)` 里面触发**，带的就是 `prompt.submit` 交下去的那段文字（顺序：submit 的 hook 开始 → `turn.start` → submit 的 `next` 返回 → 第 0 步）。一轮进行中打的消息被引擎排队，到它自己那一轮开始时才有 `prompt.submit`（没见到带 `e.turnId` 的）；mod 注册的本地命令不触发 `prompt.submit`。所以发消息时的判断在 `next(e)` 之前写进 `session.pending`，`turn.start` 只在文字相同时留下它（一条消息的决定绑在它开始的那一轮上）。
- **skill 列表是增量。** 第一次的 `skill_listing` 有全部条目（实测 169 条、约 3 万字符）；会话中途在磁盘上加一个 skill，再来的是只有那一条的列表，开头的说明相同。所以候选按名字合并，后来的同名条目替换旧的，从不整个替换或清空（`mergeSkills`）。`/clear` 之后的下一条消息前 12 秒内没有新的列表，`session.start` 也没有再触发。
- **热重载。** 改入口文件会重载 mod（「reloaded in 3.2ms」），入口和它导入的模块的模块级变量都从头开始；只改一个被导入的模块，6 秒内没有重载。所以 `hooks/flows/*` 里的模块级变量（读数的 `openMain` 和 `agentStepsOpen`、进展记录的在途调用、一条消息的 skill 判断）热重载会丢，丢了的代价写在各自的注释里；改了 flow 文件之后要看到效果，就再保存一次入口文件。
- **内联插件的选项。** `--plugin-dir` 加载的 mod 拿不到用户存的 plugin 选项（那些只给装好的 plugin）。选项（包括敏感的密钥）可以经 `--settings` 传：`{"pluginConfigs":{"dispatch-pilot@inline":{"options":{...}}}}`。
- `claude -p` 不生成 `.claude-plugin/types/`；在 tmux 里交互启动一次 `--plugin-dir` 会生成（约 12 秒）。生成的 `tsconfig.json` 不要提交。
- **调用没写模型的 agent 用它自己定义里的模型。** 2026-11-18 实测（没有密钥，一个定义写了 `model: haiku` 的一次性 agent 类型，主 agent 是 Sonnet）：Agent 调用没写模型时，`agent.spawn` 的 `e.model` 是 undefined，`next(e)` 回答 `{ model: 'claude-haiku-5-5', agentId }`，也就是定义里的模型；hook 在这次派出上写了 `model: 'sonnet'` 时，agent 跑在 sonnet 上。类型文件的原话是 "undefined lets the agent's own model, then the parent's, decide"。所以「调用没写模型」不等于「沿用主 agent 的模型」，按主 agent 的层级去换会把定义写了 `haiku` 的类型往上换。mod 因此在 `session.agentTypes` 里按 `subagentType` 记下它没给模型、调用也没写模型的每次派出：`next` 回答的模型的层级（`tierOfModelId`，认不出时是 null）和当时主 agent 的层级，最多记 32 种类型（`AGENT_TYPES_KEEP`，最早记的先走）。只有调用没写模型、记过这个类型、记下时主 agent 的层级和现在相同、记下的层级又正是主 agent 的层级（这个类型沿用主 agent 的模型）时，mod 才定模型，往下换和 `fableAgents` 的上限都一样；别的派出一律不动模型，mod 没给模型的派出再记一次。代价：每种类型在一个会话里的第一次派出（主 agent 换了模型之后也一样）既不受上限，也不往下换。决策记录的 `from` 写这个类型自己的层级（沿用时就是主 agent 的），还不知道时写 `?`；因为不知道而没动模型的，`detail` 在类型后面写「模型没动：还不知道这个类型是否沿用主 agent 的模型」，看板的 agent 行只取类型（`agentTypeOf`）。world 的 `agent.spawn` 桩照引擎的样子回答解析后的 id，选项 `typeModels` 给出各类型定义里的模型。
- 挂了 `ui.render`（AbovePrompt、SessionMode）、`http.fetch` 和 `agent.spawn` 的 mod 不挡 Code Mode。加载成功时调试日志里是 `hooks module dispatch-pilot@inline loaded … events: session.start,command.run,prompt.submit,prompt.attachment,skill.prompt,turn.start,turn.step,agent.spawn,session.append,turn.complete,http.fetch`。

## Code Mode 一轮里的行

一次实测（2.1.327，交互会话，Sonnet 5.5，探针记下每一行 `session.append`）：模型依次跑三个脚本，每个等 6 秒；一轮进行中又打了一条消息。逐行的记录在 `.superpowers/sdd/2026-11-18-dispatch-pilot-rewrite/real-rows.md`，`tests/support/rows.ts` 照它造行。看到的：

- 见到的 door：`hook-context`、`prompt`、`attachment`、`response`、`tool-result`、`queue`、`delivery`、`notice`。一轮中途引擎的提醒走 `attachment`（origin `engine`），不走 `delivery`。
- 这一轮自己的 prompt 行（连同它的 attachment 行和 hook-context 行）在 `turn.start` 之前到达。
- 每个 `tool_use` 各是一条 response 行（第 1 步有两条：先 `REPL`，再 `Poll`）。
- 脚本的结果先出现在一条 `queue` 行上（type `user`、role `user`、origin `engine`），里面是光秃秃的 `<event kind="repl-eval" …>`。把结果交给模型的不是这一行。
- 然后是一条 `delivery` 行：type `attachment`、name `poll_events`、role `user`、origin `engine`。
  - 模型这一步没有调 `Poll` 时（这里的第 0 步），它的内容是一个 text 块：一个 `<system-reminder>` 包着「`<system>authentic event nonces for this delivery: …</system>`」和那个事件。结果由这一行交给模型。
  - 模型调了 `Poll` 时，它的内容是空的，结果在 `Poll` 的 tool-result 行里，那一行的文字以「`<system>authentic event nonces for this delivery: …`」开头。
- 带着结果的 delivery 行之后，同一条 queue 行会再出现一次。
- 一轮进行中打的那条消息被排队，到 `turn.complete` 之后才提交（它的 `prompt.submit`、prompt 行和 `turn.start` 都在那之后），一轮中途没有见到 prompt 行。

mod 怎么归类这些行（`journal.ts` 的 `kindOf`）：主循环的 `REPL` 结果行只写着 `(dispatched #N)` 时是 `receipt`，不算一份结果，但第一次见到它就把会话当作 Code Mode 会话；不是 receipt 的 `REPL` 结果行（被拒或出错）当作普通的工具结果。`Poll` 结果行里有脚本的 `<result>` 或 `<error>` 时是 `script-result-poll`；`delivery` 行里有时是 `script-result-delivery`，别的非空内容是 `delivered-input`；`role` 缺省的 tool-result 行是脚本内部的调用（`inner-call`），只记工具名和报错标记；prompt 行是 `new-input`。普通会话里一次回答并行调了几个工具时，第一条 `tool-result` 结束这一步，下一条回答（`assistant`）之前的其余结果并进同一条 `StepRecord`（`TurnJournal.joins` 记着可以并进的那一步和它之前的连续失败数），不再给 `workSteps`、`failedSteps`、`consecutiveFailures` 计数；这样的结果只有把这一步变成失败时才可能是检查点（`planRow`），也只按失败成簇算。说明只加在 `receipt`、`script-result-poll` 和普通工具结果这类行上：`delivery` 行带不了换档（E13），排在那里的说明留给之后第一条能带的行。

## 设计 3.2 节的实测（E1 到 E18）

E1 到 E9 是 2.1.326（2026-11-17），E6 和 E10 到 E18 是 2.1.327（2026-11-18），都用一次性探针在 tmux 里的交互会话实测，探针不进仓库。

| # | 行为 | 普通会话 | Code Mode 会话 |
|---|---|---|---|
| E1 | 只挂 `session.start`、`command.run`、`prompt.submit`、`prompt.attachment`（`skill_listing`）、`skill.prompt`、`turn.start`、`turn.step`、`session.append`、`turn.complete` 这九个事件的 mod 不挡 Code Mode（2.1.326）。除 `skill.prompt` 只验证了注册不挡以外，都在 Code Mode 会话里实际触发过 | — | 已测 |
| E2 | agent 的 `turn.start` 上 `e.text` 是派出时的任务原文，`e.agentId` 是它的 id | 已测 | 已测 |
| E3 | agent 的 `turn.step` 上 `next({ ...e, model })` 生效：`$.agent.list()` 的 `lastRequest.model` 是改后的模型（Sonnet 5.5 改 Haiku 5.5）。改写只管一步，每步都要重写 | 已测 | 未单独测（同一引擎路径） |
| E4 | 在只带工具结果的步上改 `effort` 不发出：`lastRequest.effort` 仍是原档 | 已测（agent 循环） | — |
| E5 | 在 `session.append`（door `tool-result`）里、`next` 之前给结果行加一个 text 块，下一步改的 `effort` 就发出，并保持到之后只带工具结果的步 | 已测（agent 循环，Sonnet 5.5 和 Haiku 5.5） | 已测（Code Mode 会话里的 agent 循环） |
| E6 | 主循环上的 E4 和 E5（读数见 E15，读的是线上请求体） | 已测：不加说明时请求里仍是原档；在工具结果行上加了说明，下一次请求起是新档，并保持到这一轮结束 | 已测：同样的结果。说明加在 `Poll` 的结果行上、加在 `REPL` 那条 `(dispatched #N)` 行上都有效；从高到低、从低到高各测过。请求体里，带说明的那条消息自己带一个 `output_config.effort`，从那次请求起顶层的 `output_config.effort` 也是新档 |
| E7 | Code Mode 下主循环的行：请求会带上的结果行是 `tool-result`、`origin.tool` 为 `REPL` 或 `Poll`、`message.role` 为 `user`。脚本内部调用（`Read`、`Agent` 等）也各有一条 `tool-result` 行，但 `message.role` 缺省，请求不带它 | — | 已测 |
| E8 | 加在结果行上的 text 块在终端里显示成一行以 `❯` 开头的文字 | — | 已测 |
| E9 | 环境变量 `CLAUDE_EFFORT` 不反映 hook 改写的档位 | 已测 | — |
| E10 | 挂了 `tool.call`、`agent.spawn`、`agent.offer`、`session.send` 的 mod 不挡 Code Mode | — | 已测 |
| E11 | `agent.spawn` 在 Code Mode 下触发，带任务原文、`subagentType`、`parentModel`、`background`。`next({ ...e, model: 'haiku' })` 生效：返回值和 agent 的 `lastRequest.model` 都是 `claude-haiku-5-5`。`next` 的返回值带 `agentId`，实测比这个 agent 的第一个 `turn.step` 早约 70 ms | — | 已测 |
| E12 | Code Mode 下脚本内部的每次调用各触发一次 `tool.call`（`Read`、`Agent`，以及 agent 自己的 `Bash`）；外层的 `REPL` 没有触发 | — | 已测 |
| E13 | Code Mode 下一次脚本的顺序：`REPL` 的结果行立刻回来，内容只是 `(dispatched #N)`；脚本结束后，结果作为一个事件到达。模型这一步没有同时调 `Poll` 时，结果在 `delivery` 行里（一条 attachment）；调了 `Poll` 时，结果在 `Poll` 的结果行里，`delivery` 行是空的。之后才有下一个 `turn.step`。`delivery` 行带不了换挡：它到达后改的档位不发出，往它里面加的文字（新加一块或接在原有文字后面）也不会存下、不会发出 | — | 已测 |
| E14 | 请求带上了新档，不等于模型的做法跟着变。读数确认请求已从 `low` 变成 `xhigh` 之后，每步的输出量仍接近一直是 `low` 的基线，低于从头就是 `xhigh` 的基线。只测了一道逐步重复的算术题、Sonnet 5.5、每种各一次；输出量本身也不是可靠的指标，效果要用任务结果来验（第 8 节） | 已测 | 已测 |
| E15 | 每次请求实际带的档位，由 mod 挂 `http.fetch` 来读：引擎每发一次模型请求都触发它（类型文件："Every model request the engine sends raises this event too, with `next.origin.plugin` \"engine\", once per send"），`e.init.body` 是发出去的请求体，读其中顶层的 `output_config.effort`。凭据头对 hook 显示为 `[redacted]`。挂它不挡 Code Mode。组织的守卫插件加载时，只有组织自己的 mod 看得到引擎请求。会话记录文件里 `type` 为 `api-request` 的行也带 `params.output_config.effort`，逐次和它一致，但那是没有文档的内部格式，只作旁证 | 已测（会话记录） | 已测（两种都测了） |
| E16 | 不能用的读数：`$.model.fork` 返回的 `effort` 是会话的档位，不反映 hook 的改写；`CLAUDE_EFFORT` 同样不反映（E9）；`$.agent.list()` 的 `lastRequest` 只有 agent 有，主循环没有。OpenTelemetry 的 `api_request` 事件带 `effort`，2026-11-18 的探针用它对照过一次（数据只发到本机的监听器，抓到的文件已删除），按 3.1 节以后不再使用 | 已测 | 已测 |
| E17 | 中途换档不丢缓存：换档前后每次请求读到的缓存量连续增长，没有重写整段对话（Sonnet 5.5，订阅登录） | 已测 | 已测 |
| E18 | 本机三个真实的 Code Mode 会话（Fable 5.2）里，脚本结果有 307 次在 `Poll` 的结果行里到达，9 次在 `delivery` 行里到达 | — | 统计自会话记录 |

类型文件对 E4、E5 的原文（`TurnStepInput.effort`）："A rewrite lasts one step. On a model that takes effort per message, a level on tool results alone is not sent if another is in force, and one on a step with input stays for later tool steps whose `effort` is a level."

## 测试怎么写

`command claude plugin test ./dispatch-pilot` 跑全部，`scripts/test-one.sh dispatch-pilot <file.test.ts(x)>...` 只跑几个（它把别的测试文件临时挪开，所以不能同时跑两个）。测试不联网：发往决策模型的 `$.http.fetch` 全部由 world 回答。

- **纯模块**（`decide`、`statebuild`、`journal`、`midrun`、`board/model`、`board/view` 等）直接 import 来测，不用 `$`。
- **引擎测试**用 `tests/support/world.ts`：`const w = world(on, { ... })` 把所有桩注册在 mod 下面，测试再用它导出的 `start`、`submit`、`turnStart`、`step`、`spawn`、`append`/`appendAll`、`complete`、`dp` 发引擎事件。行为从选项进来：`answer` 回答决策模型的请求（`drexOk({ open: score([...]), mechanical: noul(0.1) })` 造一个 Drex 的回答，不给就是 HTTP 500），`onSubmit: turns($)` 让引擎像实测那样在 `prompt.submit` 里开始一轮，`onSpawn`、`onStep`、`onStateSet` 在引擎回答之前插进别的事件，`complete` 回答 `$.model.complete`，`refuse` 拒掉某些 `$` 调用，`scene` 让看板读场景，`pane` 定 `$.ui.open` 放不放得下。world 返回的数组是到了引擎的东西（`fetched`、`stepsSent`、`appended`、`spawned`、`storeWrites`、`stateWrites`、`footers` 等），断言它们。每个测试至少断言一样正面的结果：缺一个桩时 mod 的调用被拒、mod 放行，「什么都没变」就白白通过了。测试的 `on` 同一事件只能注册一次，所以要新的桩就给 world 加选项，不要在测试里另注册。
- **行**用 `tests/support/rows.ts` 造，形状照实测：`replReceipt(n)`、`pollResult(n, text)`、`deliveryResult(n, text)`、`emptyDelivery()`、`queueRow`、`innerCall(tool, { error })`、`toolResult`、`assistantToolUse`、`assistantText`、`promptRow`，以及整段脚本 `scriptByPoll` 和 `scriptByDelivery`。主循环的行不带 `agentId`，加上就是 agent 的行。
- **替身 `$`**（`tests/support/standin.ts`）用在测试工具做不到的地方：先用引擎事件把会话跑到某一步，`seedOf(w)` 取出留下的状态，交给 `standIn(...)`，再直接调导出的函数（读数的 `openStep`、`readout`，`redraw`）。它可以让某个状态或 store 的写入、`$.ui.invalidate` 抛错。
- **场景**（`tests/support/scenes.ts`）是看板的六个固定状态，看板的测试和目测探针都用它。

测试工具的限制和绕法（2.1.327 实测）：

- `session.append` 的 hook 不调 `next(e)` 就回答时，测试工具会跳过它；world 最底下的桩把 `next(e)` 接着传下去。
- 测试拿到的 `$` 没有 `http`，发不出来源为引擎的请求，见下一节。
- 场景回答 `state.get` 时要用测试工具自己的版本号，否则 mod 的每次 `update()` 都重试到上限再抛错。
- 在 mod 自己的 `ui.invalidate` hook 里读 `$.state` 会在测试工具里挂住；测试的 `$` 发不出 `ui.close`；invalidate 的桩要交给 `next(e)`，测试工具才会重画还 mount 着的画面。详见「看板在测试里」。

## 实际发出的档位：测试里发不出引擎的请求

`http.fetch` 的读数（设计 5.12）只认 `next.origin.plugin` 为 `engine` 的请求，而 2.1.327 的测试工具发不出这样的请求：测试拿到的 `$` 没有 `http`（只有 tool、command、config、telemetry、prompt、skill、attribution、agent、session、turn、ui、classic）；内联插件用自己的 `$.http.fetch` 发的请求，到每个 hook 时 `next.origin.plugin` 都是那个插件的名字；名叫 `engine` 的内联插件加载不了（"the name is the engine's own chain member"）。

所以 `tests/readout.test.ts` 分两段测引擎请求的读数：先用引擎事件把会话跑到某一步，从 world 记下的写入里取出状态（哪条决策在等核对、记录里有什么），交给一个替身 `$`；再直接调 `hooks/flows/readout.ts` 导出的 `openStep` 和 `readout`，读一次引擎的请求，看替身里写了什么。hook 本身用内联插件 `wire` 发请求来测：请求原样到达底层；prepend 层的 `fetch-watcher` 读 `next.trace`，看 mod 的 hook 在不在链上（`verifyEffort` 关着时不在）、每一环收到的是不是同一个请求。

## 看板在测试里（2.1.327 实测）

- `$.ui.mount` 里，`next(e)` 的结果（以及没有 hook 时整棵树）是 `{ type: 'engine', ref }`：引擎自己画的东西测试看不到，`find` 也搜不进去。所以脚部标签不在画出来的树里断言，而在 world 垫在 mod 下面的 `SessionMode` hook 里看 mod 传下去的 `modes`（`world(...).footers`）；交给 `next` 的时间轴和面板断言 `drawn()` 是 `{ type: 'engine' }`。
- 嵌套的 `Text`：外层 `Text` 的 `text` 是里面所有字符串连起来，所以一行（外层一个 `Text`，每段颜色一个内层 `Text`）可以按整行的文字找。
- 渲染 hook 抛错时，引擎跳过它、画自己的，但测试工具把这条报成测试失败（`hook was skipped`）。没有桩的 `$` 调用（比如 `$.ui.panes()`）是 `HooksError: no implementation`：world 给 `ui.open`、`ui.close`、`ui.panes`、`ui.invalidate` 都垫了桩（选项 `pane`，默认 `refused`）。
- `$.ui.invalidate` 是同步的，返回 `undefined`；桩看到的是 `{ event: 'ui.render' }`。桩回答 `{ deny }` 或者抛错，mod 这边既不抛也不 reject。所以「重画出错不连累 hook」只能用替身 `$` 测（`standIn(..., { refuseInvalidate: true })`）。world 的桩记下之后交给 `next(e)`：测试工具自己的 invalidate 会把还 mount 着的画面重画一遍，所以可以在同一个 mount 上看重画后的样子（桩自己回答时不重画）。
- 测试的 `$` 发不出 `ui.close`（它的 `ui` 只有 render、scroll、focus，外加 mount、press、input、select）。要模拟「不是 /dp 关上的」，用一个内联插件的 `$.ui.close`（`tests/board.test.tsx` 的 `CLOSER`），走的是同一条 `ui.close` 链，origin 是 `plugin`。mod 自己的 `$.ui.close` 也会经过 mod 自己的 `ui.close` hook（实测：/dp 关面板时那个 hook 照样重画）。
- 选项 `scene` 用 `state.get` 的桩回答 mod 对四个状态的读取。版本号要用测试工具自己的（`next(e)` 的结果）：固定回答 `version: 1` 时，mod 的每次 `update()` 都对不上版本，重试到上限后抛 `the value was written by another every time it was read`。
- `on` 也可以交给导入的函数（入口里的 `registerBoard(on, cfg)`）：validate 顺着导入扫描，hooks 列表里照样有 `ui.render{component=AbovePrompt}` 这几项。
- `AbovePrompt` 在 `vscode` 和 `mobile` 上也能 mount（hook 照样被调用），所以「别的端交给 next」要由 hook 自己判断 `e.surface`。
- Desktop 的画法只有测试能验证：Claude Desktop 自带的 Claude Code 是 2.1.325，低于 2.1.327。`$.ui.mount({ surface: 'desktop' })` 能 mount，`findAll({ type: 'Svg' })` 的 `props` 带 `source`、`alt`、`width`、`height`。`Text` 写了 `weight: 'semibold'` 时，`find` 拿到的 props 里还会多出 `bold: true`。
- `find` 的 `text` 给字符串时按包含匹配，外层 `Text` 也会被找到（例如 `'high'` 会找到整行）。要精确匹配就用 `/^…$/`。
- 测试文件自己 import 的 hooks 模块，和测试工具加载的插件不是同一个模块实例。`register` 设下的模块级变量（例如 runtime.ts 的 `board`），在测试文件 import 的那份里看不到，所以替身 `$` 调 `redraw` 时不会写状态行。
- 在 mod 自己的 `ui.invalidate` hook 里（`$.ui.invalidate` 的 op 事件；`next.origin.plugin` 是 mod 自己）读 `$.state`，在测试工具里会挂住，有的读取一直等不到结果，不报错，也不超时（2.1.327 实测）。所以状态行由 `redraw` 在调用者的 hook 里写，不挂在 `ui.invalidate` 上。
- world 用 `refuse: ['ui.status']` 拒掉 `$.ui.status` 时，引擎自己把这次调用丢掉，测试输出里报一行 `$.ui.status dropped`，mod 这边既不抛也不 reject。所以「`$.ui.status` 抛错」只能用测试文件自己的 runtime.ts（先 `holdBoard(cfg)`）加一个替身 `$` 来测。
- 一个插件的 `$.ui.invalidate('ui.render')` 只重画它自己在 `ui.render` 上的 matcher 选得中的实例。别的插件要重画 dispatch-pilot 的面板，就挂一个原样放行的 hook，matcher 写明 `plugin: 'dispatch-pilot'`（板子场景探针就是这样做的）。实测：没有这个 hook 时，探针的 invalidate 不重画 mod 的面板和时间轴；有了就重画。加载在 mod 之后的插件，这个 hook 本身从来不会被调用，因为 mod 不调 `next` 就回答了。
- 内联插件（测试的 `plugins: [...]`）的 `register` 是按源码重新加载的，引用不到测试文件里的变量（`hooks module did not load: withHook is not defined`）。
- Desktop 上一行按 `fitDesktopRow` 裁：文字按字符算列数，每张图按像素算，`PX_PER_COLUMN`（8）像素一列，向上取整。Desktop 轨道的格数是 `desktopTrackCells(bodyColumns)`。

## skill 推荐和 TypeSafe cookbook 不同的地方

推荐照 TypeSafe 的 skill_suggestion cookbook 做（设计 3.4、5.6 节，ADR 0018、0021），题目原话一字不改，只有一处不同：cookbook 第二次请求的选项是「说明加 SKILL.md 正文前 700 个字符」；mod 拿不到 skill 文件的路径（`CommandInfo` 没有路径），所以第二次请求的选项只用 skill 列表里的说明。

另外两点：候选按来源排序后分成 ceil(n/250) 批、每批数量尽量相等（不是 250 加余数），这样不会出现只有一个选项的批：Jev 的选择题要 2 到 255 个选项，被拒的一题会让整个请求失败，同一请求里的 effort 判断也跟着失败。只有一个候选（或短名单只有一个）时，Jev 不问这道选择题，直接看 fits；Drex 的选项多一个 `other`，照常问。

## 看板怎么目测

`docs/research/board-scenes/` 是目测用的探针插件，不属于 mod：它回答 dispatch-pilot 对 `session`、`turn`、`recent`、`skills` 四个状态的读取，换成六个固定场景之一，真的时间轴、面板和脚部标签照常画，不跑任何一轮，也不发模型或决策模型的请求。启动、换场景（`/dpscene <名字>`）、截图和收尾的命令见它的 README。要点：

- 用 `--settings` 给 dispatch-pilot 一个编出来的 Drex 密钥（见上面「内联插件的选项」），否则每个场景都是「没有密钥」。探针会话里不发消息，这个值不会被发出去。
- 探针给时间轴、面板和脚部标签各挂了一个原样放行、matcher 写明 `plugin: 'dispatch-pilot'` 的渲染 hook，所以 `/dpscene` 之后三处一起重画。
- 实测（2.1.327，tmux 180×50）：没有面板时一轮五行、空闲一行；面板开着时时间轴三行，面板停靠在右边；100 列时面板落到 prompt 上方；`/dp` 关上面板时时间轴马上回到完整的行数；锁定的场景没有记号行。
- 改了 `tests/support/scenes.ts` 就重新拷一份到 `docs/research/board-scenes/hooks/scenes-data.ts`，`eval/validate.ts` 会比对两份。
- Desktop 上还不能目测：Claude Desktop 自带的 Claude Code 是 2.1.325，低于 2.1.327。

## 实机验证

在普通会话和 Code Mode 会话里实际跑完三项换挡和 skill 推荐之后填写。
