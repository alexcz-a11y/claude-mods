# 长任务里什么时候换 effort：一轮中途换档时机调研

调研日期：2026-11-10。用途：dispatch-pilot 要恢复「agent 运行中途换 reasoning effort」（0.9.0 在 ADR 0013 里删掉的中途重判）。用户的 agent 多在跑几十到几百步的工具循环，目标是真的提高效率：难的地方升档，简单的地方降档。本文回答：在长任务里，什么时刻换档最划算，什么时刻不该换。

标注约定：
- **官方原文**：Anthropic 自己的文档、博客，逐字引用（英文原文）并给 URL。
- **仓库证据**：本仓库的文件、提交、评测结果，写明文件和数字。
- **论文**：第三方的一手论文，只作旁证。
- **推断**：由上面几类推出、来源没有明说的结论。
- **未文档化**：查过的来源都没有写。

本文不重测引擎行为，第 1 节的引擎事实是前提。没有调用决策模型的付费 API，没有跑 `claude -p`。

---

## 0. 结论速览

| 问题 | 结论 | 依据 |
|---|---|---|
| effort 改变什么 | 改的是之后每一步的全部输出：思考、工具调用的数量和长短、验证得多不多、多早停下来问人；几乎不改回复长短。带输入的那一步承担一轮里大部分思考，只带工具结果的步在任何档位都可能不思考 | 官方原文（effort、thinking-steering-and-cost、Prompting Fable 5.2） |
| 追加一条输入会不会引出思考 | 很可能会：官方说「新输入之后的第一个请求」通常承担大部分推理；在 high 及以上，Fable 5.2「几乎每次回复前都思考」。升档时这正是想要的，降档时影响小 | 官方原文 + 推断 |
| 一次换档的固定成本 | 几乎为零：per-message effort 不破坏缓存（Opus 5.5 上 10.1 万 token 的对话，换档的请求和不换一样只读不写，约 $0.020）；一条 Jev 请求约 $0.00004–0.001；追加行几十 token。真正的成本是换错的风险和来回抖动 | 官方原文（optimizing-for-cost-and-intelligence 参考 18）+ 仓库证据 |
| 该升没升 vs 该降没降 | 不对称随档位翻转：high 以下，低估一档的代价大（返工、错误传播、报告「已完成」却没验证）；high 以上，高估一档的代价大（xhigh 每多解一题要多花约 $30–100，high 以下只要 $2–30） | 官方原文（成本表）+ 推断 |
| 最划算的换档点 | ① 本来就带输入的步（免费）；② 意外失败成簇时升档（代码按计数定）；③ 升档的原因消失时回到这一轮的基准（代码定）。可选：todo 边界、长的机械段 | 官方原文（re-run failures at higher effort）+ 仓库证据（0.8.x 评测）|
| 不该换的时刻 | 每 N 步定时重判；收尾、写汇报前降档；高风险动作前（已经来不及）；按 hook 拦截或零散报错升档；一轮中途升到 max | 仓库证据 + 官方原文 |
| 0.8.x 的教训 | 防抖规则让该保持的题更准（三次运行 76–78% → 83–91%），却让该升、该降的题都更差（Jev 1.14 那次 75% → 64%、72% → 61%）；该降的题有 27–39% 停在过高的档，正是用户说的「实际走的档偏高」 | 仓库证据（`eval/results/effort-midturn/`，本文重算）|
| 谁最值得中途换档 | 主 agent（长、换不了模型、effort 是唯一的旋钮）。派出 agent 靠派出时定档加失败升模型，长的再加「先升 effort 再升模型」。Workflow 里的 agent 派出时定档就够 | ADR 0001、0015 + 官方原文 |

---

## 1. 前提：已经实测的引擎事实（Claude Code 2.1.322，2026-11-10）

照委托方给的结论，不重测：

- effort 按消息生效：`turn.step` 在只带工具结果的一步上改等级不生效（主 agent 和派出 agent 一样，升降都不行）。数字 effort 只在内部用。
- mod 在 `tool.call` hook 里、`next(e)` 返回之后调 `$.session.append` 追加一条 user 行（主 agent，或带 `agentId` 的派出 agent），下一步就算「带输入的一步」，那一步写的 effort 生效，并保持到之后只带工具结果的各步，直到下一次带输入的一步。在 `turn.step` 里追加则晚一步。
- 本来就带输入的步是免费的换档点：用户在一轮进行中排队的消息、task notification、Stop hook 的反馈、SendMessage 送达运行中 agent 的消息、新的一轮的第一步。
- 换档不影响 prompt cache（`cache_read` 连续增长）。每次换档的代价：上下文里多一条模型读得到的短 user 行；那一步成了「新输入」。
- 中途换模型从改的那一步起生效，但缓存失效（主 agent 不换模型，ADR 0001）。
- 决策模型的延迟：Jev 约 300–500 ms（满 24000 token 的 state 约 0.9 s），d1-ultra 2.0–2.7 s；每个 hook 有 10 秒预算。工具调用在这一步的流还没结束时就开始执行；下一步的 `turn.step` 开始时上一步的工具结果都已回来。一步可以并行多个工具调用。

**这和 API 的 per-message effort 完全对得上（推断：引擎用的就是它）。** 官方原文（https://platform.claude.com/docs/en/build-with-claude/effort ，「Per-message effort (beta)」）：

> "Placed directly after a `user` turn with new input, it sets the level for Claude’s reply to that turn. Placed anywhere else, such as between an `assistant` turn and the next `user` turn as in the following example, it takes effect from the next `user` turn with new input. A `user` turn that holds only `tool_result` blocks doesn’t count as new input, so a change placed after one in a tool-use loop waits for the next `user` turn with new input. The new level then holds until a later message changes it. Everything before that message is unchanged, so the cached prefix still matches."

生成的类型声明也这样写（仓库证据：`dispatch-pilot/.claude-plugin/types/claude-code/index.d.ts` 的 `TurnStepInput.effort`）："On a model that takes effort per message a level stands from one message with input to the next: a change waits through steps whose new input is tool results, and one made on a step with input stays for the tool steps after it."

所以「追加一条 user 行」就是给 API 造出一个「带新输入的 user 轮」。官方对这种中途插话的放法有要求，见第 3.3 节。

---

## 2. 来源

### 2.1 官方原文（2026-11-10 用 Spider 读全文）

| 来源 | 读了什么 | 用在哪 |
|---|---|---|
| https://platform.claude.com/docs/en/build-with-claude/effort | 全文：各档说明、各模型的建议档位、effort 与工具调用、与思考、per-message effort | 第 1、3、4 节 |
| https://platform.claude.com/docs/en/build-with-claude/thinking | 全文：工具循环是一个助手轮、interleaved thinking、进度更新、缓存规则 | 第 3 节 |
| https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost | 全文：每档的思考行为、工具循环里思考在哪一步、per-message steering、成本控制 | 第 3 节 |
| https://platform.claude.com/docs/en/build-with-claude/prompt-caching | 「What invalidates the cache」表里 effort 一行 | 第 4 节 |
| https://platform.claude.com/docs/en/build-with-claude/extended-thinking | interleaved thinking 在手动模式下的预算横跨一个助手轮 | 第 3 节 |
| https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence | Tune effort、Re-run failures at higher effort、What breaks the cache 和参考文献 12、18、21 的测量 | 第 4、5 节 |
| https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5 | Calibrate effort、Unattended agentic runs、User-facing progress updates（harness 追加提醒的做法） | 第 3、5、6 节 |
| https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2 | Calibrate effort、Finish the whole task、Keep caution from piling up | 第 3、5 节 |
| https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 | Calibrate effort、Steer initiative and scope、Mid-turn user messages、Verification on coding tasks | 第 3、5、9 节 |
| https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5 | Use effort to control thinking、Prevent early stopping、Mid-turn user messages | 第 3 节 |
| https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5 | 默认 medium、同档位思考更多、价格 | 第 4 节 |
| https://code.claude.com/docs/en/model-config | Adjust effort level、Choose an effort level、ultrathink、When a new effort level starts、subagent 的 effort | 第 3、5、7 节 |
| https://code.claude.com/docs/en/sub-agents | effort 字段和每次调用的 `effort` 参数、后台 subagent 的完成通知 | 第 5、7 节 |
| https://code.claude.com/docs/en/costs | `/usage` 的建议行（`Switch from max to high effort`）、减少 token 的做法 | 第 4 节 |
| https://code.claude.com/docs/en/workflows 、https://code.claude.com/docs/en/goal | fan-out 里同档位才共用缓存前缀；后台工作完成后作为新的一轮送达 | 第 5、7 节 |
| https://claude.dev/blog/spending-your-effort/ （Thariq Shihipar，2026-09-25） | 全文：effort 曲线、三个构建任务、Terminal-Bench 3.0 的失败分类和分领域通过率 | 第 3、4、5 节 |
| https://claude.dev/blog/what-a-task-costs-on-opus-5-5/ （Addy Osmani，2026-09-25） | 全文：一轮的成本构成、effort 定价的粗算、中途换档、何时换模型 | 第 4、5 节 |
| https://claude.com/resources/articles/claude-model-and-effort-level-in-claude-code （Lydia Hallie，2026-07-07） | 全文：effort 控制的是整体工作量、何时升 effort、何时换模型 | 第 3、4、5 节 |

### 2.2 论文（只作旁证）

| 来源 | 读了什么 |
|---|---|
| Ares: Adaptive Reasoning Effort Selection for Efficient LLM Agents，https://arxiv.org/html/2603.07915 | 摘要、方法、主结果、按步序和动作类型的 effort 分布 |
| Not All Turns Are Equally Hard (TAB)，https://arxiv.org/html/2604.05164v3 | 摘要和引言片段 |
| PORA: Learning When More Reasoning Pays Off for LLM Agents，https://arxiv.org/abs/2610.27119 | 只读了摘要 |

### 2.3 仓库证据

- 0.8.x 的实现：`git show 3985d24^:dispatch-pilot/hooks/features/midturn-effort.ts`、`3985d24^:dispatch-pilot/hooks/decision/midturn.ts`、`3985d24^:dispatch-pilot/hooks/features/escalation.ts`、`3985d24^:dispatch-pilot/.claude-plugin/plugin.json`（选项默认值）。
- 0.8.x 的评测集：`3985d24^:dispatch-pilot/eval/datasets/effort-midturn.jsonl`（100 题，带 `tags`）。
- 结果：`dispatch-pilot/eval/results/effort-midturn/` 下的 `2026-10-04-jev-reviewed.json`、`2026-10-05-jev-theta-down.json`、`2026-10-15-jev-jev114-long.json`、`2026-10-16-d1-merged.json`；本文按方向和标签重算了 `en-score` 的 `picked` 与 `sent`（脚本只读结果文件，不发请求）。
- `dispatch-pilot/DEVELOPMENT.md` 的「一轮中途不再重新判断」「失败时升模型」「降档门槛（0.2.3）」「一轮中途的 effort（effort-midturn，#14）」、延迟表与「按等待时间离线重算」。
- `docs/adr/0001`、`0005`、`0010`、`0013`、`0014`、`0016`；`dispatch-pilot/hooks/features/escalation.ts`、`hooks/core/outcomes.ts`、`hooks/core/prompts.ts`、`hooks/features/main-effort.ts`；`GLOSSARY.md`。
- `docs/research/aa-benchmarks-2026-10.md`（AA 指数的各档分数，第三方数据，仓库里已记录）、`docs/research/decision-models-and-caching.md`（Jev 价格）。

---

## 3. 问题 1：effort 在每种步上到底改变什么

### 3.1 带输入的步与只带工具结果的步

**effort 管整个回复，不只管思考。** 官方原文（effort）：

> "The effort parameter affects **all tokens** in the response, including: Text responses and explanations; Tool calls and function arguments; Thinking (when active)" … "Because effort applies to every output token, it works with or without thinking. Lower effort also means fewer and terser tool calls."

> "Effort is a behavioral signal, not a strict token budget. At lower effort levels, Claude still thinks on sufficiently difficult problems, but thinks less than it would at higher effort levels for the same problem."

**一轮的思考集中在带输入的那一步。** 官方原文（thinking-steering-and-cost，「Effort levels」）：

> "At every level, Claude determines for each request whether to think. In a tool-use loop, the first request after new user input typically carries most of the reasoning, and follow-up requests that only process tool results can skip thinking, including at `xhigh` and `max`. Thinking per request also tends to decrease as a conversation grows longer. No level guarantees a thinking block on every request."

effort 页（「Effort with thinking」）说同一件事："At higher effort levels, Claude thinks more readily and at greater length. In a tool-use loop, follow-up requests that only process tool results can still skip thinking at any level. At lower levels, Claude can skip thinking entirely for simpler problems."

**但只带工具结果的步也会思考。** 官方原文（thinking，「Interleaved thinking」）："With interleaved thinking, the thinking allocation can span the entire assistant turn rather than a single response." 自适应思考下 Opus 5.5、Fable 5.x、Sonnet 5.5 等 "reasoning between tool calls always appears in thinking blocks"。工具循环整体是一个助手轮："**A tool-use loop is one assistant turn.**"

**每档的思考行为**（官方原文，thinking-steering-and-cost 的表）：

| 档 | 思考行为 |
|---|---|
| `max` | "Claude thinks the most readily and at the greatest depth, with no constraint on thinking length." |
| `xhigh` | "Claude thinks more readily and at greater depth than at `high`, suited to extended exploration." |
| `high` | "Claude thinks on most requests that benefit from it. Provides deep reasoning on complex tasks." |
| `medium` | "Claude uses moderate thinking. Might skip thinking for simple queries." |
| `low` | "Claude minimizes thinking. Skips thinking for simple tasks where speed matters most." |

模型差别：Fable 5.2 "At `high` and above, the model thinks before almost every reply, including a reply to a greeting."（Prompting Fable 5.2）；Opus 5.5 "At a given level, Claude Opus 5.5 tends to think more per turn than Claude Opus 5, especially at `xhigh` and `max`."（Prompting Opus 5.5）。

**小结（官方原文 + 推断）：** 带输入的步决定这一段工作的计划和大部分思考；之后只带工具结果的步沿用这一档，档位决定的是「遇到值得想的工具结果时想多少、要不要再调工具去验证」。所以中途换档的效果有两部分：换档那一步（成了新输入）的一次思考，以及之后各工具步的整体倾向。

### 3.2 一次换档对之后各工具步的影响

| 方面 | 升档 | 降档 | 依据 |
|---|---|---|---|
| 工具调用 | 更多调用，先说计划，更详细的总结 | 合并操作、更少调用、直接动手、简短确认 | 官方原文（effort，「Effort with tool use」，见下） |
| 彻底程度、验证 | 测更多边界情况，验证更多，自己做更多决定 | 更早给出一个起点；可能跳过验证 | 官方原文（model-config、Prompting Sonnet 5.5） |
| 多早停下来 | 推得更远才回来问人 | 更容易停下来问人、提前结束 | 官方原文（Lydia、Prompting Fable 5.2 / Sonnet 5.5 / Haiku 5.5） |
| 文字长短 | 几乎不变 | 几乎不变 | 官方原文（Prompting Fable 5.2、effort 页 Opus 5 一段） |
| 思考 | 更容易思考、想得更深 | 简单的步不思考 | 官方原文（上表） |

逐字引文：

- effort，「Effort with tool use」："Lower effort levels tend to: Combine multiple operations into fewer tool calls; Make fewer tool calls; Proceed directly to action without preamble; Use terse confirmation messages after completion" / "Higher effort levels might: Make more tool calls; Explain the plan before taking action; Provide detailed summaries of changes; Include more comprehensive code comments"
- model-config："In tests on Opus 5.5 and Fable 5.1, Claude at a higher level tested more edge cases and verified more of its work before answering. It also made more choices on its own. At a lower level, Claude returned a starting point sooner, which fits work where you review each result and steer the next step."
- Lydia Hallie 的文章："Effort level controls how much work Claude does on your request overall. This does include how long the model thinks, but also: How many files it reads; How much it verifies; and How far it pushes through a multi-step task before checking in with you." 以及 "At lower effort, it would rather ask you for more context than spend tokens figuring something out on its own."
- 同一篇："At higher effort levels, Claude often starts with creating a plan and the level of effort influences the depth and breadth of that plan. However, the plan is not frozen in place."
- Prompting Fable 5.2："The model is more likely to stop early at lower effort levels." "Effort barely changes how long the model’s replies are. To change the length and tone of a reply, use your prompt."
- Prompting Sonnet 5.5："At `low`, it keeps its thinking short and can skip verifying a change. … At `low` and `medium`, on long agentic tasks, it’s more likely to stop and check in with the user before it completes its work."
- Prompting Haiku 5.5："moving from `low` to `medium` effort roughly halved early stopping. It also more than doubled the output tokens for each attempt."
- Thariq 的文章（Terminal-Bench 3.0）："increasing effort tends to reduce failures due to missing edgecases (purple blocks), but does not fix when the model has the wrong approach (blue blocks)." 同一组数字里，Fable 5.1 从 low 到 max，"a bug its tests missed" 40 → 14、"wrong or incomplete fix" 31 → 10，"picked the wrong reading" 却从 25 涨到 47（370 次尝试）。

**对长任务的两个推断：**

1. 降档不只是「少想」，还会让 agent 更早停下来（无人值守的长任务里这就是没做完）。降档的风险主要在这里，不在思考变浅。
2. 升档解决的是「漏了边界情况、没验证」，解决不了「方向错了」。卡住时升一档有用的前提是：失败来自没查全、没验证；同一个问题在高档位上仍反复失败，再升也没用（第 5.2 节）。

另有一条要记住的：一次顶层改档在 Fable 5.1 上 "steers the model less reliably: its earlier replies were written at the previous level, and it tends to stay consistent with them."（effort 页）。官方因此推荐 per-message 的写法；但这也提示（推断）中途换档的效果可能被模型自己的惯性冲淡一部分，要靠本机的统计确认（第 8 节）。

### 3.3 「追加一条输入」这件事本身会不会引出一轮思考

- **很可能会，升档时尤其。** 官方原文：新输入之后的第一个请求 "typically carries most of the reasoning"（3.1 节）；Fable 5.2 在 high 及以上 "thinks before almost every reply"。追加行让下一步成了「新输入之后的第一个请求」（第 1 节），所以（推断）升到 high 及以上时，这一步大概率会有一段思考：模型读到新的一行，重看现状，可能修改计划。这正是升档想要的效果。
- **降档时影响小。** 降到 low/medium 后，"Claude can skip thinking entirely for simpler problems"（effort 页），追加的那一步多半不会多想（推断）。
- **追加行的文字会被模型读，也会左右它。** 官方原文（thinking-steering-and-cost，「Per-message steering」）："Appending `\"Please think hard before responding.\"` to a user message encourages Claude to think on that turn; `\"Answer directly without deliberating.\"` discourages it." 又说："An agent harness, for example, can append the encouraging phrase on planning steps and the discouraging phrase on routine confirmations"。但劝少想的那句在两个模型上不起作用："On Claude Haiku 5.5, the discouraging phrase doesn’t reliably reduce thinking. … The same holds for Claude Fable 5.2."
- **追加得太勤，模型可能当成注入。** Prompting Sonnet 5.5："Frequent harness text after tool results can lead the model to treat that text as a possible prompt injection"。放法：“Deliver mid-turn user input as a user turn. Append the user’s words as a text block in the user message that carries the `tool_result` blocks, after the last `tool_result`.” 以及 "Keep harness notices, such as reminders, in a separate mid-conversation system message after the user’s words. Never put a notice and the user’s words in the same block." Haiku 5.5 的指南写法相同。Opus 5.5 的指南给 harness 追加提醒的上限："If the turn stays quiet, stop after two or three reminders rather than sending more."

**结论：** 每次追加换档都有一次「新输入」带来的思考（升档时大，降档时小），而且会在上下文里留下一条模型读得到的话。前者是升档的主要收益来源，后者要求追加行少而短、只写事实。追加行在请求里的确切形状（并进带 `tool_result` 的那条 user 消息，还是单独一条）没有查清，见第 10 节。

---

## 4. 问题 2：成本模型

### 4.1 官方给出的各档成本和效果

官方原文（optimizing-for-cost-and-intelligence，「Tune effort」的表和参考文献 12）：

| 测量 | low | medium | high | xhigh |
|---|---|---|---|---|
| Opus 5.5，SWE-bench Pro 子集，每题成本 / 解决率 | $0.11 / 87.4% | $0.21 / 92.8% | $0.29 / 95.3% | $0.74 / 96.7%（单次运行） |
| Opus 5.5，内部 370 个仓库任务，每次尝试成本 / 解决率 | $0.35 / 74.8% | $0.84 / 86.6% | $1.38 / 88.4% | $4.11 / 91.1% |
| Fable 5.2，DeepResearch Bench II，每题成本 / 分数 | $1.49 / 54.5% | $2.16 / 55.0% | $4.82 / 57.7% | — |

其他测量（官方原文，同一页）：
- Sonnet 5.5："At `medium`, Claude Sonnet 5.5 scored about 7 points lower than at its default, `high`, on the SWE-bench Pro subset for about 59% of the cost per task"。
- Opus 5.5 在 DRACO 上 low 比 medium 低 13.3 分，"typical task took 84% less time"；内部找缺陷的基准上 "scored 34 points lower at `low` than at `medium`, for about a fifth of the cost"。
- 时间（Thariq 的文章）：一个 HTML 过滤器任务 "A typical attempt at low effort takes about 2 minutes" 对 "A high-effort run finishes in about 33 minutes"。

**每多解一题的边际成本**（推断，按上表算 Δ成本 / Δ解决率）：

| 升档 | 内部 370 个仓库任务 | SWE-bench Pro 子集 |
|---|---|---|
| low → medium | $0.49 / 11.8 点 ≈ 每多解一题 $4 | $0.10 / 5.4 点 ≈ $1.9 |
| medium → high | $0.54 / 1.8 点 ≈ $30 | $0.08 / 2.5 点 ≈ $3.2 |
| high → xhigh | $2.73 / 2.7 点 ≈ $101 | $0.45 / 1.4 点 ≈ $32 |

high 以上边际成本陡增。官方的说法："Most of the gain in capability is already present at `high`"（Prompting Fable 5.2）；model-config："`max` may show diminishing returns and is prone to overthinking"。

**「先低档、失败了再高档」是官方测过最省的策略**（任务粒度，不是一轮中途）。官方原文（「Re-run failures at higher effort」）："When a task’s outcome is checkable, the cheapest policy on the effort curve is not a fixed setting: run every task at a low setting and re-run only the failures at a higher one."

| 策略（Opus 5.5，SWE-bench Pro 子集） | 解决率 | 每题成本 |
|---|---|---|
| `low`，失败的用 `high` 重跑 | 约 97% | 约 $0.17 |
| `medium`，失败的用 `high` 重跑 | 约 97% | 约 $0.24 |
| 全部 `high` | 95.3% | $0.29 |

"At `low`, 13% of tasks failed. With those re-run at `high`, the pass rate was slightly higher than with everything at `high`, for a little over half the cost." 推断：一轮中途的对应做法是「基准档跑，失败信号出现时升档」。区别是中途升档不用重跑前面的步，但前面低档留下的错可能已经传下去（第 4.5 节）。

### 4.2 一次换档的固定成本

| 项 | 量级 | 依据 |
|---|---|---|
| 缓存 | 0。官方测过：10.1 万 token 的对话，"With no change, and with a per-message effort change, the request read all 101,000 tokens and wrote none." Opus 5.5 上这一请求的提示部分 $0.020，和不换一样；顶层改 effort 要 $0.41 | 官方原文（参考文献 18）；引擎实测 `cache_read` 连续增长（第 1 节） |
| 追加行 | 约 20–40 token：写进去不到 $0.001（"a new turn of about 25 tokens adds under $0.001 USD"，同一参考文献）；之后每步按缓存价重读，Opus 5.5 上 40 token × 100 步 ≈ $0.0008 | 官方原文 + 推断 |
| 决策请求 | Jev $0.042/M 输入 token。0.8.x 的评测平均每个中途请求约 900 token、约 $0.00004（1000 个请求 908,778 token、$0.038）；state 满 24000 时约 $0.001 | 仓库证据（`docs/research/decision-models-and-caching.md`、DEVELOPMENT.md「一轮中途的 effort」） |
| 决策延迟 | Jev 的中途请求 p50 257–287 ms、p90 283–358 ms；在工具开始时发出，工具耗时 0 时 ≤300 ms 到达的 70%、≤500 ms 的 99.7%；d1-ultra 2.0–2.7 s | 仓库证据（DEVELOPMENT.md 延迟表和「按等待时间离线重算」）+ 第 1 节 |
| 换档那一步的思考 | 升到 high 及以上时多一段思考（几千 token 量级，待本机统计补上）。Opus 5.5 上 1000 个输出 token = $0.02，"an output token costs 100 times a cache read" | 官方原文（What a task costs）+ 推断 |
| 平台 | 订阅和 API key 上不破坏缓存；"On Amazon Bedrock, Google Cloud's Agent Platform or a Claude apps gateway, a change of effort still clears the cached conversation" | 官方原文（What a task costs）；ADR 0001 只支持订阅 |

**由代码按计数定的换档没有决策延迟**：失败、成功都在 `tool.call` 的 `next(e)` 返回时就知道，同一个 hook 里当场追加。要问决策模型的换档，信号也要等工具结束才有，问的时间要么加在这一步上（Jev 0.3–0.5 s、d1-ultra 2–2.7 s），要么晚一步生效（仓库证据：0.8.x 的 `rejudgeWaitMs` 300 ms，「迟到」就沿用旧档）。

### 4.3 在 N 步任务的第 k 步换档：可测的公式（推断）

记剩下的工作在档位 L 上要 s_L 步，每步的上下文 c token（大部分走缓存，单价 p_r），每步输出 o_L token（单价 p_o，含思考），完成后返工的概率 P_L，返工的代价 R：

```
剩余成本   C_L = s_L × (c × p_r + o_L × p_o) + P_L × R
换档成本   C_sw = C_dec + C_line + B          # 决策请求 + 追加行 + 换档那一步多出的思考
值得换     C_sw + (C_L' − C_L) < 0
```

- 升档值得的条件：`C_sw + s × Δo × p_o + Δs × (c × p_r + o × p_o) < (P_L − P_L') × R`。右边在出现失败信号之后才大：没有信号时 P_L 本来就小。
- 官方的粗算可以当一个刻度（What a task costs）："say high adds 20K thinking tokens across a task. On Opus 5.5 that's $0.40. A retry loop of ten turns at 100K of cached context, with 10K output tokens in total, costs about the same. So high pays for itself on a task where it saves one retry. On a task medium would have finished the first time, it's wasted."
- 每一步本身的价钱（同一篇）："At 20K tokens of context a turn's cache read costs about $0.004 on Opus 5.5. At 150K it costs about $0.03"。升档让工具调用变多（第 3.2 节），每多一步就多一次重读上下文。

o_L、s_L 按阶段和档位的分布官方没有给，等第 8 节的本机统计。

### 4.4 降档要剩多少步才回本（推断）

降一档每步省 π = Δo × p_o（加上少走的步数）。回本的剩余步数：

```
r* = (C_dec + C_line + B_down + ΔP × R) / π
```

- 前三项加起来不到 $0.001（4.2 节），所以**纯机械成本一两步就回本**。
- 决定性的是 ΔP × R：降档后做砸或提前停下的概率增量乘返工代价。举例（数字只为说明，π 待第 8 节补）：Opus 5.5、100K 上下文，若机械段每步只少 100 个输出 token（工具结果步本来就常不思考，见 3.1 节），π ≈ $0.002；ΔP = 1%、R = $1 时 r* ≈ 5 步；ΔP = 5% 时 r* ≈ 25 步。
- 推断：**只有能把 ΔP 压到接近 0 的时候才降**：降回自己临时升上去之前的基准（不是猜测），或者代码确认是一段同形的机械工作、而且第一次失败就自动回到基准。

### 4.5 该升没升与该降没降：不对称在哪

**该升没升（判低）的代价：**
- 做砸、返工，或者更糟：报告「完成」却没验证。官方原文（Prompting Sonnet 5.5）："At `low`, though, it sometimes reports a change as done without running a check that exercises it."
- 错误会传下去。论文（Ares）："A slight reasoning deficit in an early step can lead to error propagation"；BrowseComp-Plus 上 "a single suboptimal selection, such as choosing low effort for a complex retrieval step, can result in poorly formulated search queries"（low 8.0% 对 high 42.7%）。
- 官方的总原则（What a task costs）："every way to spend fewer tokens can also cost you a finished task. … A retry costs more than those savings."

**该降没降（判高）的代价：**
- 多花的 token 和时间，有上界：medium → high 每题多 38–64%（4.1 节的表），high → xhigh 多 155–198%。
- 高档位上的额外工作：Sonnet 5.5 在 xhigh、max 上 "At these levels the model is especially thorough. After it completes a task, it can start its own rounds of review and verification, sometimes with subagents if your harness provides them."，一段提示词 "cut session cost by about a third, with no change in quality"（Prompting Sonnet 5.5）；Fable 5.2 在 xhigh、max 也会派 subagent 审自己的工作。
- 用户自己的不满（仓库证据，DEVELOPMENT.md「降档门槛（0.2.3）」）："用户认为实际走的档偏高太多"。

**不对称随档位翻转（推断，依据 4.1 节的边际成本）：**
- high 以下，判低贵：low → medium 每多解一题只要约 $2–4，medium → high 约 $3–30，而判低的后果是返工。所以 high 以下要「升得快」。
- high 以上，判高贵：high → xhigh 每多解一题约 $32–101，max 还 "prone to overthinking"。所以一轮中途不升到 max，xhigh 只给「升过一次、问题还在」的情况。
- 仓库里原先的说法（`docs/research/aa-benchmarks-2026-10.md`）「低估一档要付的质量大，高估一档只多花 token」只对 high 以下成立。
- 时间是另一笔判高的账：Opus 5.5 在 DRACO 上 low 比 medium 少用 84% 的时间（4.1 节）。对盯着看的交互任务，判高还要付等待。

---

## 5. 问题 3：逐个评估候选换档点

### 5.1 0.8.x 评测里决策模型在各类场景上的表现

评测集是手写的轨迹片段，答案是「从这一步到下一次重判之前需要的档」（仓库证据，DEVELOPMENT.md「一轮中途的 effort」）。下表是本文对 `2026-10-15-jev-jev114-long.json` 的 `en-score` 重算（Jev 1.14，中英两面各跑两遍，每题 4 个回答）。「选对」= Jev 的回答选出的档在 `accept` 里；「发出后对」= 经过 0.8.x 防抖规则（`thetaUp` 0.3、`thetaDown` 0.55、一次只降一档）之后实际会发出的档在 `accept` 里。

| 标签（题数，答案方向） | 回答数 | 选对 | 发出后对 |
|---|---|---|---|
| explore-to-implement（4，3 降 1 保持） | 16 | 16 | 16 |
| hidden-complexity（4，全升） | 16 | 16 | 16 |
| debug（8，4 升 1 降 3 保持） | 32 | 32 | 31 |
| event-trigger（10：派出 agent、Workflow、skill、结果交回） | 40 | 40 | 26 |
| agent-returned（2） / workflow-returned（2） | 8 / 8 | 8 / 8 | 4 / 6 |
| expected-failure（9，6 保持 3 降） | 36 | 28 | 26 |
| wrapup（8，全降） | 32 | 22 | 22 |
| false-wrapup（8，看似收尾其实要升） | 32 | 16 | 11 |
| batch-mechanical（7，5 降 2 保持） | 28 | 18 | 11 |
| stuck（6，全升） | 24 | 16 | 11 |
| forced-escalation（6，5 升） | 24 | 12 | 7 |
| irreversible（5，4 升） | 20 | 12 | 8 |
| security（10） | 40 | 26 | 15 |
| topic-trap（5，4 降：话题听着重要，工作其实简单） | 20 | 12 | 0 |
| anchoring（4，全降） | 16 | 14 | 4 |

按答案方向汇总（同一份重算，三次运行）：

| 运行 | 该升：选对 / 发出后对 | 该降：选对 / 发出后对（发出后过高） | 该保持：选对 / 发出后对 |
|---|---|---|---|
| `2026-10-04-jev-reviewed`（0.4 / 0.6 / 3） | 67% / 62% | 75% / 73%（16/60） | 78% / 91% |
| `2026-10-05-jev-theta-down`（0.3 / 0.55 / 5） | 77% / 69% | 75% / 65%（21/60） | 76% / 83% |
| `2026-10-15-jev-jev114-long`（0.3 / 0.55） | 75% / 64% | 72% / 61%（47/120） | 78% / 88% |

读法：
- Jev 在「阶段从读代码转到实现」「看着简单其实难」「调试」「事件触发」上几乎全对；在「看似收尾」「批量机械」「卡住」「难以挽回」「话题陷阱」上差。
- 防抖规则把保持的题拉高了 7–13 个点，代价是该升的题少对 5–11 个点、该降的题少对 2–11 个点；该降的题有 27–39% 停在过高的档。这就是用户看到的「偏高」。
- `jev114-long` 里该保持的 152 个回答，有 45 个（30%）被规则改了档（37 升 8 降），19 个改到 `accept` 之外。真实轨迹里绝大多数步该保持（评测集故意放了 62% 要换档的题），推断：定时问的次数越多，无谓的换档越多。
- 限制：每个标签 2–10 题，手写场景，问法是 0.8.x 的 Score 题，不代表按 ADR 0014 改成是非题之后的准确率。d1-ultra 在同一套题上 `en-score` 79.0% 对 Jev 75.0%（p = 0.20，DEVELOPMENT.md「d1-ultra」一节），但它 2–2.7 s 的延迟只适合等得起的换档点。

### 5.2 逐个评估

每条写：mod 从哪个事件看到、信号有多可靠、代价和风险、方向、结论。

#### A. 阶段切换

| 切换 | mod 从哪看到 | 可靠性 | 方向 | 结论 |
|---|---|---|---|---|
| 探索 → 规划/设计 | `tool.call` 里 `EnterPlanMode`、第一次 `TodoWrite`；这一步的文字 | 中：不是每个 agent 都用 plan mode 或 todo | 保持或升 | 规划通常在一轮开头，发消息时已定档；中途很少需要 |
| 规划 → 实现 | `ExitPlanMode` 成功、todo 第一项转 in_progress、读之后开始连续 `Edit`/`Write` | Jev 在 explore-to-implement 上 16/16 | 降一档（计划具体、基准 ≥ high 时） | 可选。两份官方说法方向相反，见下 |
| 实现 → 验证（跑测试/构建） | 一串编辑之后第一次跑测试、构建的 `Bash` | 代码就能认出 | 升到 high（基准低于 high 时） | 可选，推荐给基准 ≤ medium 的轮 |
| 验证 → 调试（意外失败） | 测试、构建失败（见 B） | 见 B | 升 | 归到失败信号 |
| → 收尾、写汇报 | 最后一项 todo 完成、文字像总结 | 差：看似收尾的题 Jev 只选对 16/32，发出后 11/32 | 降 | **不要做** |

依据：
- 「规划 → 实现」：Thariq 的循环是 "Give Claude a spec and ask it to interview me … Implement it on low effort … Verify and test on high effort"；model-config 的 medium："day-to-day engineering work with a clear scope, such as implementing a new feature"。而 Prompting Fable 5.2 说 "you might plan and iterate with the model at `medium`, then raise effort for the long, unattended part"：无人值守的执行段要升，不是降。两者的区别在于有没有人盯着、规格写得多细（Thariq："given this spec, the models behaved much more similarly"）。另外，ADR 0016 的「确认」规则让用户批准计划的那条消息至少沿用上一轮的档，和「实现时降档」方向相反。推断：这一点不宜自动化，留作可选，要用户定。
- 「实现 → 验证」：model-config 的 high："Work where verification matters or edge cases are likely"；Prompting Sonnet 5.5：low 时 "can skip verifying a change"；What a task costs："before you raise effort, check whether the model has a way to check its work. A test run costs one turn and its output. More effort adds thinking to every turn." 风险：在 low 上 agent 可能根本不跑测试，这个触发点就不出现；它一开始跑测试时已经决定验证了，升档改的是它怎么读结果、补不补边界用例。
- 「收尾不降」：官方说 effort 几乎不改回复长短（3.2 节），收尾降档省不了写汇报的钱；而降档让模型更容易提前停（Fable 5.2、Sonnet 5.5、Haiku 5.5，3.2 节），正好在收尾时会把没做完的部分丢掉。Opus 5.5 还有 "some of those updates end the turn with text rather than a tool call"（Prompting Opus 5.5）。仓库证据：false-wrapup 8 题的答案都是升，Jev 一半判错。

#### B. 失败信号

| 信号 | mod 从哪看到 | 可靠性 | 方向 | 结论 |
|---|---|---|---|---|
| 测试或构建失败（第一次） | `tool.call` 结果 `isError`、出错行（`decision/escalation.ts` 的 `errorLine`） | 低：TDD 的红灯是预期内的 | — | 单独一次不换 |
| 修改之后同一个失败又出现 / 同一条出错行连续两次 | 同上，比较归一化的出错行，看两次之间有没有改源码 | 高 | 升 | **必做**（代码按计数定） |
| 回归：之前通过的命令现在失败 | 同一命令的成功记录 | 高 | 升 | **必做** |
| 撤销自己的改动（`git checkout --`、`git restore`、`git reset`、`git stash`） | `tool.call` 的 `Bash` 命令 | 中高：方向错了才撤 | 升一次 | 可选，并进失败簇 |
| 原地打转（同一命令重复，中间没有编辑） | 命令字符串 | 低：多半是轮询 | — | 不按它升；有失败才算 |
| 被 hook 拦下 | `core/outcomes.ts` 的 `wasBlocked` | 低：是规矩不是难度 | — | **不要** |
| 工具报错累计（grep 无结果、文件不存在、`old_string` 没找到） | `tool.call` | 低：大多是机械的小错 | — | **不要**按原始计数升 |

依据：
- 官方的升档时机（Lydia）："Pick a higher effort level if Claude got it wrong by skipping a file, not running the tests, or not double-checking its work." 换模型的时机："If Claude has all the pertinent context and clearly tried and still got it wrong, that's a signal to pick a larger model."（主 agent 不换模型，ADR 0001）
- What a task costs："When medium stalls, try high." "If xhigh hits the same problem twice, switch to Fable 5.1." 以及 "The clearest sign you need more effort is a fix that stops at one layer."
- 论文（Ares）：high effort 集中在纠错的动作上："critical decision steps—specifically go_back and branch—require the highest proportion of high reasoning effort"。
- 仓库证据：0.8.x 在失败累计满 `escalateAfter`（2，中间成功不清零）时问决策模型「是不是预期内」（`thetaExpected` 0.25）；manifest 里记着 "Jev 给预期内的失败 0.15 到 0.72，给不是预期内的 0.09 到 0.16"，两组重叠，0.9.0 删了这一问（ADR 0013）。评测里 stuck 6 题全该升，Jev 选对 16/24、发出后 11/24；expected-failure 9 题选对 28/36。
- 推断：用「修改之后同一个失败又出现」代替「失败满 2 次」，就不用问预期不预期：TDD 的第一次红灯之前没有修复的尝试，不会算；修了还红才算。被 hook 拦下和用户拒绝照现在的规矩不算（`hook-block-failures` 默认关）。
- 已经在 high 及以上又卡住：Thariq 的数字说更高的 effort 治不了方向错（3.2 节），high → xhigh 的边际成本又最高（4.1 节）。所以只在「升过一次、问题还在」时再升一档到 xhigh，到 xhigh 为止；主 agent 之后只记进这一轮的事实（ADR 0013 的 `facts`），派出 agent 才升模型（第 7 节）。

#### C. 高风险或难以挽回的动作之前（部署、迁移、删除、push）

- mod 从 `tool.call` 的输入看到 `git push`、部署脚本、迁移、`rm -rf`；这时调用已经发出（引擎在流结束前就开始执行工具），**最早只能影响下一步**，也就是动作之后。
- 要在动作之前升档，只能更早预测：从 todo 或文字里看出「接下来要部署」。可靠性低：irreversible 5 题 Jev 发出后只对 8/20，security 10 题 15/40（5.1 节）。
- 也可以在 `tool.call` 里不调 `next`、拒绝这一次调用，再追加一行升档让它重想（hook 可以直接回答 `{ deny }`）。这改变了 agent 的行为，不只是换档，而且 Fable 5.2 的指南提醒限制性的话会累积成过度谨慎（"Cautious instructions build up wherever context carries over"）。没有测过，不推荐。
- 官方对这类动作的答案不是 effort，是确认：Prompting Opus 5.5 "keep your own confirmation step for risky or irreversible actions"；Fable 5.2、Sonnet 5.5 同样的话。Claude Code 的权限确认就是这一步。
- 结论：**不要做成中途换档点。** 发消息时的规则下限 R2（出错代价，ADR 0014）已经让这类消息开始时就是 xhigh 或 max；中途降档不能越过这一轮的规则下限（第 9 节）。

#### D. 计划相关

| 点 | mod 从哪看到 | 可靠性 | 方向 | 结论 |
|---|---|---|---|---|
| 进入 plan mode | `EnterPlanMode` | 中 | 保持 | 不换 |
| 退出 plan mode、计划获批 | `ExitPlanMode` 的结果 | 中；方向有争议（A 节） | 降一档 | 可选，要用户定 |
| todo 更新、换到下一项 | `TodoWrite` 的输入（每项的文字和 status） | 中高：下一项的文字就是「接下来的工作」 | 升或降一档 | 可选，推荐给长的轮 |

依据：Prompting Opus 5.5 建议 harness "Keep the task’s parts in a checklist the model updates, such as a to-do tool or a file"。todo 的下一项是决策模型最好读的「剩下的工作」：0.8.x 的题面问的就是 "How much step-by-step reasoning does the rest of the work on `user_message` need"，Jev 在阶段转换和隐藏复杂度上几乎全对（5.1 节）。代价：`TodoWrite` 本身很快，等 Jev 要在这一步上加 0.3–0.5 s；todo 粒度因 agent 而异。引擎自己注入的 `todo_reminder` 之类（`prompt.attachment`）算不算输入没有查清（第 10 节）。

#### E. 免费换档点

| 点 | mod 从哪看到 | 现在的代码 | 结论 |
|---|---|---|---|
| 新的一轮第一步 | `prompt.submit` | 已判断（`features/main-effort.ts`） | 保持 |
| 本人在一轮进行中排队的消息 | `prompt.submit`，带 `turnId` | 已判断：送进的那一步起用它的档 | 保持 |
| 空闲时到达的报告（agent 交回、后台任务通知） | `prompt.submit`，`origin.kind` 为 `peer` 或 `task-notification`，没有 `turnId` | 已判断（`startsReportTurn`） | 保持 |
| **送进进行中一轮的报告**（后台 subagent 完成、Workflow 结果、后台任务、其他会话的消息） | 同上，但带 `turnId` | **不判断**：`core/prompts.ts` 注释写 "delivered into a running turn it starts none, and that turn's effort is its own" | **必做**：补上 |
| Stop hook 的反馈、`/goal` 的续跑 | 未查清 mod 从哪个事件看到（第 10 节） | 无 | 必做（查清事件后） |
| SendMessage 送达运行中的派出 agent | 未查清（可能是 `session.append` 的 `door: 'delivery'`） | 无 | 可选（派出 agent 用） |
| 压缩之后 | `session.compact` / `session.append` 的 `door: 'compaction'` | 无 | 待实测：压缩后的第一步算不算带输入 |

依据：
- 这些点不需要追加行，代价只有一次决策请求（4.2 节）。
- 官方原文（sub-agents）："A background subagent's results reach Claude as a completion notification in a later turn." 后台 subagent 是默认的（"With nothing configured, a subagent that Claude spawns from your main conversation starts in the background."），所以长任务里 agent 交回结果是常见的免费点。前台 subagent 的结果是 `tool_result`，不算。
- `/goal` 文档："When the background work finishes, Claude Code delivers the result to Claude as a new turn"。
- 仓库证据：事件触发类题（派出 agent、Workflow、skill、结果交回）Jev 选对 40/40，被 0.8.x 规则改坏到 26/40（5.1 节）。在免费点上应按是非题加代码规则读（ADR 0014），不要套 0.8.x 的 Score 门槛。
- 压缩：官方测过「改动放在压缩之后的第一个请求上最便宜」（Sonnet 5，顶层改 effort 加一个工具：中途 $0.95、压缩之后 $0.75），但那是会破坏缓存的改法；per-message 不破坏缓存，这个好处就没有了。压缩后的第一步若算带输入，它是一个自然的免费点。
- 报告的风险：报告文字可能让决策模型高估（topic-trap 类发出后 0/20）；报告的那一轮在 `main-effort.ts` 里已有专门的读法（只问 effort 题、出错代价和原因未知），中途送达的照它读。

#### F. 长的机械段

| 段 | mod 从哪看到 | 可靠性 | 方向 | 结论 |
|---|---|---|---|---|
| 批量改文件（连续同形的 `Edit`/`Write`、codemod） | `tool.call` 序列；todo 写明 N 个文件 | 代码检测中高；Jev 差（batch-mechanical 发出后 11/28） | 降一档 | 可选 |
| 重复命令 | 命令字符串 | — | — | 不换 |
| 轮询等待（`sleep`、看 CI、`gh run watch`、`BashOutput`） | 命令字符串 | 高 | 降 | **不要**：省得少，还要再升回来 |

依据：
- 官方建议机械工作用 low（What a task costs）："Use **low** for mechanical work, like renames or applying a known pattern across files." "For a mechanical edit across many files, keep Opus 5.5 and set effort to low."
- 但工具结果步本来就常不思考（3.1 节），Lydia："it generally won’t artificially inflate usage for simple tasks at higher effort levels"。推断：在机械段降档，省的是少走的验证步和更短的调用，不是思考；每步省得少，回本要更多步（4.4 节）。
- 轮询：每次轮询的输出已经很短，成本主要是每步重读上下文，effort 不改它。CI 一红就要升回来，等于两次追加、两次思考。
- 仓库证据：long-but-easy 2 题 Jev 选对 4/8。

#### G. 每 N 步或按时间兜底

- 0.8.x 默认每 3 步重判一次（`rejudgeEvery` 3）。
- 仓库证据：该保持的回答 30% 被改了档（5.1 节）；用户觉得实际走的档偏高。
- 官方原文（Lydia）："Think of effort as a manual override … Consider this more as a general preference than a task-by-task decision." Prompting Opus 5.5 对 harness 追加提醒给的上限是两三次（3.3 节），Sonnet 5.5 警告太勤的 harness 文字会被当成注入。
- 论文（Ares）：随机选档 "fails to preserve accuracy or provide meaningful cost reduction"；有效的是按步的难度选，靠的是训练过的路由器，不是定时。
- 结论：**不要定时重判。** 唯一的兜底是事件式的：升档之后若一直没有「问题消失」的信号，就保持到这一轮结束，由下一条消息重新定档（ADR 0014 的 R4 读这一轮的事实）。

#### H. 模型自己的信号

- mod 从 `turn.step` 的结果看到这一步的文字和 `usage.output_tokens`（四个 token 计数，没有单列 thinking；仓库证据：类型声明的 `ModelUsage`）。默认 `display: "omitted"` 时思考文字是空的。
- 自适应思考本来就在按难度分配思考（官方："the model allocates reasoning where reasoning is likely to help"）。模型这一步想得多就升档，是在已经多想的地方再加；想得少就降档，可能正好降在它要开始想的地方之前。
- 文字里的「这条路不行」「我错了」「换个办法」可以作为失败簇的旁证。
- 结论：**不单独作为触发点**，只用来确认 B 类信号，或用来确认机械段（连续很多步输出很短）。

---

## 6. 问题 4：稳定性

### 6.1 0.8.x 怎么做

仓库证据（`3985d24^` 的 `decision/midturn.ts`、`features/escalation.ts`、`plugin.json`）：

| 规则 | 值 | 说明 |
|---|---|---|
| 何时问 | 每 `rejudgeEvery` 3 步；主 agent 调 `Agent`/`Task`/`Workflow`/`Skill` 时 | 问题在 `tool.call` 开始时发出，下一步 `turn.step` 取答案 |
| 等多久 | `rejudgeWaitMs` Jev 300 ms（pplx 6000） | 没到就沿用旧档，记一条「迟到」，答案留给再下一步 |
| 升档 | 置信度 ≥ `thetaUp`（Jev 0.3），可以跳档 | 档位按 `pickEffort` 取（高一档的概率 ≥ 0.3 就往上取一档） |
| 降档 | 置信度 ≥ `thetaDown`（0.2.2 是 0.75，0.2.3 起 0.55），一次只降一档 | 5 题需要降两档以上，规则下不可能对 |
| 升档后 | `holdSteps` 5 步内不降 | 强制升档也算 |
| 强制升档 | 失败累计满 `escalateAfter` 2（中间成功不清零），问「是不是预期内」（`thetaExpected` 0.25），不是就升一档（`escalateMode` one-level，最高 xhigh），每轮最多 `escalateLimit` 2 次 | 之后失败从零数 |

### 6.2 评测显示了什么

- `sent` 的整体准确率 76/77（`2026-10-04-jev-reviewed`，DEVELOPMENT.md），比每题都保持当前档的 52% 高 21–25 个点。
- 但按方向拆开（5.1 节）：防抖让保持的题更准，让该升、该降的题更差；该降的题停在过高档的比例在 `thetaDown` 0.75 时最高。0.2.3 把 `thetaDown` 从 0.75 降到 0.55，偏高从 19.5%/17.5% 降到 16%/16%，仍没回到 11–12% 的对照组（DEVELOPMENT.md「降档门槛（0.2.3）」）。原因写在那里："`sent` 的偏高里有 `picked` 本身偏高的部分"，即往上取一档的 0.3。
- 没有评测过的：`holdSteps`（评测集不记录上次升档在第几步）、真实会话里的换档次数和迟到比例。

### 6.3 建议值和理由（推断）

| 项 | 建议 | 理由 |
|---|---|---|
| 升档幅度 | high 以下可以一步升到 high；high 以上一次一档，到 xhigh 为止；一轮中途不升到 max | 4.5 节的不对称：high 以下判低贵，high 以上判高贵；max "prone to overthinking" |
| 升档后保持多久 | 按事件：保持到引起升档的问题消失（同一命令重新成功、失败的测试通过），至少 3 个工具步；一直没消失就保持到这一轮结束 | 固定步数（0.8.x 的 5）和问题本身的长短无关；一个调试子问题通常要「复现 → 看 → 改 → 再跑」几步 |
| 降档幅度 | 回到这一轮的基准（发消息时定的档）可以一步到位；低于基准只降一档，每轮最多一次 | 回到基准是撤销自己的临时升档，不是猜；低于基准是猜，0.8.x 的数字说明猜降档准确率最低 |
| 降档的地板 | 不低于这一轮的规则下限（R1–R5、确认、要求升级）；用户 `/dp lock` 时什么都不改 | 规则下限是用户的话和出错代价定的，中途的机械段不该越过它 |
| 每轮最多 | 追加行触发的换档 4 次（升两次、回两次）；免费点上的重判不计入，但同样受最小间隔约束 | 官方对 harness 追加提醒 "stop after two or three reminders"；Sonnet 5.5 的注入误读 |
| 两次之间最少 | 4 个工具步；例外：刚回到基准又出现新的失败簇，可以立刻升（计入上限） | 升便宜、判低贵；但来回升降的每一次都有一段思考和一条追加行 |
| 门槛的形式 | 不再用 Score 加 `thetaUp`/`thetaDown`；用是非题（Jev ≥ 0.7 是、≤ 0.3 否，d1-ultra > 0.8 / < 0.2）加写在代码里的规则 | ADR 0014、0017 的读法；0.8.x 的门槛是在自己的题上调的，0.9.0 已经推翻 |

---

## 7. 问题 5：主 agent、派出 agent、Workflow agent

| 类 | 中途换档值不值 | 理由 | 建议 |
|---|---|---|---|
| 主 agent | **最值** | 轨迹最长；模型从不换（ADR 0001），effort 是唯一的旋钮；用户盯着它；per-message effort 不伤它的大缓存；免费点（排队消息、送达的报告）大多落在它身上 | 第 9 节的全部必做项 |
| 派出 agent | 派出时定档通常够；长的值得加一条 | 任务在派出时就写清了，决策模型读 brief 定模型和 effort（ADR 0015）；失败时已经升模型（ADR 0013）。官方的顺序是先升 effort、再换模型：What a task costs "Raise effort before you change models" 和 "If upgrading effort levels and adding checks doesn’t work, then switch to a bigger model"；换模型让这个 agent 的缓存作废，升 effort 不会 | 第一次失败簇：升 effort（带 `agentId` 追加）；升过 effort 问题还在：再升模型（现有的 `stepUp`）。只给预计要走很多步的 agent（例如已经走了 20 步以上），短的照现在直接升模型 |
| Workflow 里的 agent | 派出时定档就够 | 一次 fan-out 很多个、每个都短，脚本可以自己写 effort；同一次运行里 "Two agents that run with the same model, effort level, agent type, tools, output schema, and working directory build the same tools-and-system-prompt prefix"（workflows 文档），派出时档位一致更有利于共用缓存 | 不做中途换档；保留失败升模型 |

补充（官方原文，sub-agents）：派出时的 effort 在恢复后仍有效："The parameter overrides the `effort` field and stays in effect when the subagent is resumed." model-config："On the main conversation's model, a subagent or teammate with no `effort` of its own runs at the level you pick in the session". 所以不给派出 agent 定档时，它会跟着主 agent 的会话档位，不跟主 agent 中途换的档（推断，未验证）。

---

## 8. 本机会话记录的统计

2026-11-10 统计。范围：本机 `~/.claude/projects/` 下近 16 天改动过的会话记录（主 agent 和 `subagents/` 的），只取 Claude Code 2.1.312 及以后写的行（2.1.312 起记录里的 `effort` 是实际生效的档），共 944 个文件、24,315 个模型请求（步）。每个请求取一次 `usage.output_tokens_details.thinking_tokens`（同一请求的几行按 `requestId` 去重）。「带输入的步」指请求前新进来的 user 行里有工具结果以外的内容；「工具步」指只有工具结果。脚本只输出计数，不读内容；脚本没有进仓库。

这些数字是观察到的，不是对照实验：各档上的任务不一样（档是 dispatch-pilot 按消息定的，难的消息本来就分到高档）。

### 8.1 思考几乎都发生在工具步上

| 模型、档 | 步数 | 带输入的步占步数 | 带输入的步占思考 token |
|---|---|---|---|
| Opus high | 2,778 | 19% | 13% |
| Opus xhigh | 9,177 | 8% | 5% |
| Opus max | 9,364 | 5% | 14% |
| Fable xhigh | 217 | 18% | 29% |

Opus xhigh 上 95% 的思考 token 花在只带工具结果的步上。所以长任务的花费由工具循环里生效的那一档决定，而这一档现在只在发消息时定一次。

### 8.2 长循环占了大部分步

按循环（一条带输入的消息到下一条）的步数分：1–5 步的占全部步的 5%，6–20 步 14%，21–50 步 13%，51–100 步 15%，100 步以上 53%（62 个循环）。

### 8.3 档位对工具步思考量的影响（Opus 主 agent，工具步、结果无报错）

| 档 | 步数 | 不思考的步 | 中位数 | p90 | 平均 | 每步耗时平均（秒） |
|---|---|---|---|---|---|---|
| low | 259 | 66% | 0 | 124 | 41 | 6.7 |
| medium | 255 | 55% | 0 | 262 | 111 | 5.0 |
| high | 1,333 | 45% | 39 | 518 | 219 | 6.7 |
| xhigh | 4,227 | 40% | 84 | 1,196 | 485 | 9.0 |
| max | 6,643 | 34% | 172 | 2,335 | 841 | 11.4 |

每升一档，工具步的平均思考 token 大约翻一倍。每步耗时的中位数各档只差 1.4 秒（3.6 到 5.0），差别在尾部：p90 从 9 秒（low、medium）到 18 秒（xhigh）、26 秒（max）。耗时是上一条 user 行到这一步第一条助手行的时间差，含排队和首 token。

### 8.4 思考集中在少数步，模型自己已经在省

- 各档上思考最多的 10% 的步占思考总量的 60–68%；xhigh 和 max 上仍有 34–40% 的工具步完全不思考。
- Fable、Opus 在 xhigh 和 max 上、30 步以上的循环（115 个，14,946 步），按每 10 步一段看：平均思考低于 250 token 的段占 26%，只占思考总量的 6%；平均 1,000 以上的段占 21%，占思考总量的 53%。
- 所以在本来就轻的段上降档，省不了多少思考 token；能省的在中等和重的段上，而那里降档有判错的风险。

### 8.5 重的步成串的程度有限

同一批循环里，「重」定义为一步思考 1,000 token 以上（占 17%）：

- 这一步重，下一步也重的概率是 22%，隔 10 步是 21%，只比基准 17% 高一点。单看上一步的思考量，预测不了下一步。
- 按 10 步一段看有一定持续：这一段轻（平均低于 250），下一段也轻的概率 43%（基准 26%）；这一段重，下一段也重 41%（基准 21%）。

所以判断要看一段（约 10 步）而不是一步，而且只看过去的思考量不够，需要读工作内容。

### 8.6 哪种时刻思考得多

按上一步和这一步各自调用的工具分（Fable、Opus，xhigh 和 max，工具步）：

| 上一步 → 这一步 | 步数 | 平均思考 |
|---|---|---|
| Read/Grep → Write/Edit | 330 | 1,117 |
| Read/Grep → Bash | 1,470 | 1,103 |
| Bash → Write/Edit | 583 | 951 |
| Bash → Agent/Workflow | 152 | 940 |
| Read/Grep → Read/Grep | 1,333 | 932 |
| Bash → Bash | 6,366 | 605 |
| Write/Edit → Write/Edit | 397 | 598 |
| Write/Edit → Bash | 711 | 408 |
| Bash → MCP 等其他工具 | 921 | 321 |
| 任意 → 只写文字（收尾） | 1,020 | 117 |

读完材料之后动手写、动手跑、派出 agent 的那一步思考最多；改完之后跑一下、调 MCP、收尾汇报思考最少。读 `Read` 的结果之后平均思考 1,227（只有 14% 的步不思考），是各工具里最高的。

### 8.7 报错之后模型并不多想

- 工具结果里有报错的步（623 步）：59% 不思考，平均 163 token，比无报错的步低得多。报错后的第二步平均 529，回到平常水平。
- 连续两次以上报错的步只有 33 个。
- 所以「出了一次错」不是变难的信号：多数是被 hook 拦下、命令写错这类一步就改好的错。有意义的是同一个问题改了又失败。

### 8.8 一轮中途进来的输入并不引出更多思考

把带输入的步分成一轮的第一步和一轮中途进来的输入（task notification、hook 反馈、排队的消息等），和同档的工具步比（Fable、Opus）：

| 档 | 第一步平均思考（不思考的比例） | 中途输入 | 工具步 |
|---|---|---|---|
| high | 252（37%） | 140（62%） | 265（40%） |
| xhigh | 600（10%） | 309（64%） | 521（36%） |
| max | 2,952（16%） | 1,573（16%） | 797（33%） |

在 high 和 xhigh 上，中途进来的输入有 62–64% 不引出任何思考，平均比工具步还低；只有 max 上是工具步的两倍。这些输入多数是通知和提醒，内容本身不需要想，所以不能直接推到「追加一条换档行」上；但它说明「新输入」这件事本身在 high、xhigh 上不会自动引出一段思考。

### 8.9 档位也改变思考以外的输出和工具调用数

Opus 主 agent、工具步，每步平均：

| 档 | 输出 token | 其中思考 | 思考以外 | 工具调用数 |
|---|---|---|---|---|
| low | 339 | 39 | 300 | 0.61 |
| medium | 738 | 105 | 633 | 0.84 |
| high | 909 | 211 | 698 | 0.98 |
| xhigh | 1,122 | 470 | 653 | 1.09 |
| max | 1,602 | 822 | 780 | 1.22 |

medium 以上，思考以外的输出差别不大（633–780），差别主要在思考；工具调用数随档位从 0.61 升到 1.22。

### 8.10 长循环的上下文很大

50 步以上的循环里，每个请求的输入（含缓存读取）中位数 40.9 万 token，p10 是 15.5 万，p90 是 75.2 万。每步的输出只有一千多 token。所以长循环里每多走一步都要重读几十万 token 的上下文；档位带来的开销差别，除了每步多出的思考，还有高档多走的步数（上一小节的工具调用数）。这一条的花费换算没有做（订阅用量的计法没有查）。

### 8.11 代码能认出的「失败成簇」很少，或者很吵

这一小节的范围不同：同一批文件但不限版本，按用户消息切分循环，30 步以上的循环 800 个、68,046 步、Bash 报错结果 2,077 个。

- 同一类命令（去掉开头的 `cd` 和环境变量后的前三个词）失败后，改过文件、中间没成功过、又失败：16 次，涉及 16 个循环（2%），每千步 0.2 次；累计到第三次的一次也没有。
- 同一条命令原样（整条命令相同）改过又失败：在 2.1.312 以后的 18,499 步里只有 3 次。模型很少原样重跑同一条命令。
- 同一条报错行（输出的最后一行，数字抹掉）在改过文件之后再出现：262 次，涉及 137 个循环（17%），每千步 3.9 次；但两次之间隔的步数中位数是 33 步，其中混着通用的末行（hook 拦截的提示语、`Shell cwd was reset` 之类），不能当成同一个故障。
- 同一条报错行连续两次：58 次。

所以第 9 节的触发点 ③（失败成簇，由代码按计数定）按「同一类命令」认的话每 5,000 步才触发一次；按「同一条报错行」认要先滤掉通用末行，否则多数是误报。它便宜，可以留，但带不来多少换档。

### 8.12 这些统计对正文的修正

- **第 0 节和 3.1 节「带输入的那一步承担一轮里大部分思考」**：官方原文说的是通常情况。本机长循环里，合计 95% 的思考在工具步上（8.1）；单步比，xhigh 上第一步平均 600、工具步 521，差别不大，只有 max 上第一步明显更多。
- **3.3 节和第 0 节「追加一条输入很可能引出一段思考」**：本机数据不支持在 high、xhigh 上这样预期（上面的中途输入一小节）；max 上有。追加行的实际效果仍要用对照实测。
- **4.3、4.4 节的公式**：每步输出差用上面的表（例如 max 比 high 每步多 693 个输出 token、多 0.24 个工具调用）。
- **9.1 的 ⑦ 长机械段降档**：轻的段只占思考总量的 6%（8.4），省得少，和表里写的风险一致。
- **9.1 的 ③ 失败成簇**：频率见上一小节，触发很少。
- **判断的粒度**：重的步不成串、按 10 步一段才有持续（8.5），支持 6.3 节「两次换档之间至少隔几步」，也说明每一步都重判没有依据。
- **哪些转换点思考多**（8.6）：读完材料后去写、去跑、去派出 agent 的那一步最多；改完后跑一下、收尾最少。mod 看得到上一步调了什么工具，但这一步要做什么是模型自己定的，所以只能按「刚读完一批材料」这类已经发生的事来判断。

---

## 9. 推荐策略

### 9.1 总表

| 触发点 | 方向 | 谁决定 | 依据 | 风险 |
|---|---|---|---|---|
| **必做** | | | | |
| ① 免费点：送进进行中一轮的报告（后台 subagent 完成、Workflow 结果、后台任务通知、其他会话的消息） | 升或降（降只到基准或基准低一档，不低于规则下限） | 决策模型（报告那一轮的读法：effort 题 + 出错代价 + 原因未知）+ 代码规则 | 不需要追加行（引擎事实）；事件触发类 Jev 选对 40/40（仓库证据）；现在的代码没判断（`core/prompts.ts`） | 报告文字让人高估（topic-trap 0/20）；赶在报告送进的那一步之前要答完，Jev 够，d1-ultra 可能要等 |
| ② 免费点：Stop hook 反馈、`/goal` 续跑 | 升或降，同上 | 决策模型读续跑的文字（往往列着没做完的项） | 同上；Prompting Opus 5.5 的续跑消息 "Your task list still has open items" | mod 从哪个事件看到它没查清 |
| ③ 失败簇：修改之后同一失败又出现；同一条出错行连续两次；回归 | 升：基准 ≤ medium 直接到 high；已在 high 且升过一次、问题还在，到 xhigh；到 xhigh 为止 | 代码（计数），在 `tool.call` 返回时当场追加 | 官方「失败了再高档」最省（$0.17 对 $0.29，解决率约 97% 对 95.3%）；Lydia「没跑测试、没查全就升 effort」；What a task costs "When medium stalls, try high" | TDD 红灯误升（用「修改之后」排除）；方向错时升了也没用（到 xhigh 为止，主 agent 记进事实） |
| ④ 升档的原因消失：同一命令重新成功、失败的测试通过 | 降：回到这一轮的基准 | 代码 | 用户嫌偏高；0.8.x 该降的题 27–39% 停在过高档；回到基准不是猜测 | flaky 测试「看似解决」，再失败会再升（受上限和间隔管） |
| **可选** | | | | |
| ⑤ todo 边界：下一项转 in_progress（轮已经走了 ≥ 10 步） | 升或降一档 | 决策模型读下一项的文字，问两道是非题（下一项是不是照已知做法的机械工作；下一项是不是要先查明原因、边界多）+ 代码规则 | Fable 5.2 "mix levels in one workflow"；Jev 在阶段转换 16/16、隐藏复杂度 16/16 | 等 Jev 在这一步上加 0.3–0.5 s；todo 粒度不一 |
| ⑥ 验证开始：一串编辑后第一次跑测试或构建（基准低于 high） | 升到 high | 代码 | Thariq "Verify and test on high effort"；Sonnet 5.5 low 跳过验证；model-config 的 high | 多花；在 low 上它可能根本不跑测试，这个点就不出现 |
| ⑦ 长机械段：≥ 6 个连续成功的同形编辑，或 todo 写明批量 N 个 | 降一档（不低于 low、不低于规则下限） | 代码检测 + 决策模型确认（是非题 ≥ 0.7） | 官方 "Use low for mechanical work"；Jev 单独判机械段差（11/28），所以代码先认 | 省得少（工具结果步本来就常不思考）；第一次失败立刻回到基准 |
| ⑧ 计划获批（`ExitPlanMode` 成功），计划具体、基准 ≥ high | 降一档 | 决策模型 | Thariq 的「低档实现」 | 与 Fable 5.2「无人值守段升档」、ADR 0016「确认至少沿用」方向相反，要用户定 |
| ⑨ 派出的长 agent 第一次失败簇 | 升 effort（带 `agentId` 追加），第二次才升模型 | 代码 | What a task costs "Raise effort before you change models" | 要改现有失败升模型的顺序；多一次换档 |
| **不要做** | | | | |
| 每 N 步、按时间定时重判 | — | — | 该保持的回答 30% 被改档；用户嫌偏高；官方「general preference」；Ares 随机选档无效 | — |
| 收尾、写汇报前降档 | — | — | effort 几乎不改回复长短；低档更容易提前停；false-wrapup Jev 判对一半 | — |
| 高风险动作前换档 | — | — | 调用已发出，最早下一步；irreversible 8/20；官方用确认步管这类动作 | — |
| 按 hook 拦截、用户拒绝、零散工具报错升档 | — | — | 是规矩或机械小错，不是难度 | — |
| 只凭这一步输出长短升档 | — | — | 自适应思考已在按难度分配 | — |
| 一轮中途升到 max | — | — | high 以上边际成本陡增；max 容易过度思考；max 留给发消息时的 R2/R5/用户明说 | — |
| 轮询、等 CI 时降档 | — | — | 省得少，CI 一红要升回来 | — |
| Workflow 里的 agent 中途换档 | — | — | 任务短；派出时档位一致利于共用缓存 | — |

### 9.2 哪些要问决策模型，哪些按计数

- **按计数（代码）**：失败簇、回归、撤销、问题消失、机械段的形状、上限、间隔、地板。理由：信号在 `tool.call` 返回时就有，当场追加没有延迟（4.2 节）；0.8.x 的数字里 Jev 在卡住、机械段上不可靠（5.1 节）。
- **问决策模型**：免费点（读报告或续跑的文字）、todo 边界（读下一项的文字）、机械段降档前的确认。理由：这些是「读懂接下来的工作」，Jev 在阶段转换、隐藏复杂度、调试、事件触发上几乎全对；而且免费点上有时间等它。按 ADR 0014 的方式问：是非题，代码定档。

### 9.3 换档之前先确认的判断（防抖）

1. 这一轮没被锁定（`/dp lock`），模型接受 effort。
2. 升档：失败是「意外」的：修改之后同一失败又出现，或回归，或同一条出错行连续两次。单独一次失败不升。
3. 降档：要么是升档的原因已经消失（同一命令重新成功），要么是代码认出的机械段加决策模型同意；不越过这一轮的规则下限。
4. 不在上一次追加换档后的 4 个工具步之内（失败簇触发的升档在刚回到基准后例外一次）；这一轮追加换档未满 4 次。
5. 新档和现在的档不同（同档不追加）。

### 9.4 追加行的写法（推断，部分依据官方原文）

- 一次换档一条，短，写事实和原因，不写命令语气，例如 `[dispatch-pilot] effort raised to high: the same test failed again after a fix.` / `[dispatch-pilot] effort back to medium: the failing test now passes.`
- 不写「少想」「直接回答」：在 Haiku 5.5、Fable 5.2 上无效（3.3 节），还可能降低质量。升档时可以照官方的鼓励句加一句 "Please think hard before responding."，但它会在之后每一步都留在上下文里，要不要加需实测。
- 只用 `$.session.append` 在 `tool.call` 返回后追加，不放进 `tool_result` 里（官方："Never put user text inside a `tool_result` block"）；这条行在请求里落在哪里没查清（第 10 节）。
- 同一轮不超过 4 条（6.3 节）。

---

## 10. 没查清的问题

1. **追加行会不会被当成注入。** 形状已实测（2.1.322，探针记录里的请求内容）：`$.session.append` 的 user 行并进带 `tool_result` 的那条 user 消息，排在所有 `tool_result` 之后，是一个裸的 text 块；一步有多个并行工具调用时也是这样。Sonnet 5.5、Haiku 5.5 在探针的四步任务里照常做完，但样本只有几次；官方说太勤的 harness 文字会被读成注入，长任务里多次追加的情况没有测。
2. **追加行引出的思考有多大。** 官方只说「新输入之后的第一个请求通常承担大部分推理」，没有数字。第 8 节的本机统计显示一轮中途进来的输入在 high、xhigh 上多数不引出思考，但那些输入多是通知和提醒；追加的换档行本身没有对照实测。
3. **哪些引擎注入的行算「带输入」。** 压缩之后的第一步；`prompt.attachment` 注入的 `todo_reminder`、plan mode 切换；Stop hook 的反馈 mod 从哪个事件看到（`session.append` 的 `door` 是 `hook-context`、`attachment` 还是别的）；SendMessage 送达派出 agent 时 mod 能否认出（`door: 'delivery'`？）。ADR 0013 实测过「工具结果上加 hook 的 `context` 不算输入」，其余没测。
4. **中途换档在 Claude Code 里的实际效果。** 没有同一任务「中途换档 / 不换」的对比；Fable 5.1 的提醒（模型倾向和之前的回复保持一致）说明效果可能被惯性冲淡。
5. **新问法的准确率。** 0.8.x 的评测集手写、62% 的题要换档，问法是 Score 加门槛；按 ADR 0014 改成是非题后在 todo 边界、免费点上的准确率没有评测。d1-ultra 在中途题上比 Jev 好（79.0% 对 75.0%，不显著），延迟却高 5 倍以上。
6. **每档每步的输出差（公式里的 Δo、π）。** 官方只给每题总成本，没有按步、按阶段的数字。
7. **主 agent 中途换档后，未自带 effort 的派出 agent 跟哪一档。** model-config 说跟「会话的档」，中途追加换的档算不算没有查。
8. **在 `tool.call` 里拒绝高风险调用、追加升档让它重想**的可行性和副作用，没测，本文不推荐。
9. **非订阅平台。** 官方说 Bedrock、Google Cloud 的 Agent Platform、Claude apps gateway 上换 effort 仍会清缓存；dispatch-pilot 只支持订阅（ADR 0001），没在这些平台测过中途换档。
10. **官方博客的成本数字是示意。** What a task costs 写明 "Some numbers here are list prices, and some are illustrations built from them"；4.3、4.4 节的例子同样是示意，要用本机统计替换。
