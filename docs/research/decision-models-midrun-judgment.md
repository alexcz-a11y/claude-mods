# 决策模型判断进行中的 agent 轨迹：中途重判 effort 的官方写法调研（Jev / d1）

整理日期：2026-11-10。读者：恢复「一轮中途重判 effort」的实现者（主 agent 和派出 agent 都适用）。本笔记只给官方的写法规则、接口事实和草案，不含仓库代码；没有调用 Jev 或 Liquid 的任何付费 API。读的全是公开页面：两家的文档站、博客、TypeSafe 发布的 skill、TypeSafe 评测站（evals.typesafe.ai）的公开数据文件，以及 Liquid d1 Playground（d1.liquid.ai）打包后的前端 JS。

已有笔记只补不重做：`docs/research/typesafe-question-guide.md`（2026-10-04，对着 jev-1.13）、`docs/research/decision-models-and-caching.md`、ADR 0014、ADR 0017，以及 0.8.x 删掉的 `dispatch-pilot/hooks/decision/midturn.ts`（`3985d24^`）。第 3 节逐条列出与它们相比新增或有出入的地方。

标注约定（沿用已有笔记，另加一类）：

- **官方**：TypeSafe / Liquid 自己的文档、API 参考、skill 或博客。
- **官方演示**：官方域名上的演示代码或评测数据（evals.typesafe.ai、d1.liquid.ai）。能说明厂商自己怎么用，但不是文档承诺。
- **第三方**：独立作者或社区，没有厂商确认。本次只当线索，结论都回到了官方原文。
- **我们的实测**：本仓库 `dispatch-pilot/DEVELOPMENT.md`、ADR 里记下的数字。
- **推断**：由上面的事实推出，文档没有明说。
- **文档未提及**：查过的官方来源都没写。

引文一律保持英文原文。

---

## 0. 结论速览（实现前先看这 12 条）

1. **版本变了。** `jev-latest` 现在指向 `jev-1.14.0`（2026-10-14 发布），`jev-1.13.0` 仍可用。Liquid 新增了 `d1.1`，是托管默认模型（上下文 65,536，$0.02/M）；`d1-ultra` 仍是「most capable, for harder decisions」（32,768，$0.042/M）；`d1` 是更早的模型。上下文上限、每请求最多 128 题、250 KB 文本上限，都写在 Liquid 的 API 参考里。
2. **「接下来要多想还是少想」本身是一个决定，不该整个交给模型。** TypeSafe skill 原文："A question that asks Jev to make the decision, such as "Should this ticket be escalated?" or "What should the agent do next?", usually means the question is at the wrong layer." 官方支持的做法是：模型给出判断（工作需要多少推理，轨迹里出现了哪些可观察的信号），升档、降档、不变由代码决定。
3. **量推理需求用 Score，不用「比当前档多/少」的比较题。** Score 的每一档单独对照 state 评估，模型看不到档位编号，也看不到相邻档；skill 又说 "Direction and magnitude usually work better as separate questions"。所以绝对档位的 Score 有官方支持。「比当前档更多」这类相对题要绕一跳，属于 jaggedness 页说的 Indirection；即使要问，也只能做评测变量（见 4.1 C）。
4. **读 Score 时看概率分布，不看 `confidence`。** confidence 页和 skill 都改了口径：要判断答案落在某条档位线的哪一边，就把那一边各档的概率加起来（"add up the probabilities of the levels on the side that matters"）；`confidence` 只用来判断这道 Score 答案是否已经集中（"settled at all"）。0.8.x 拿 Score 的 `confidence` 当升降档门槛，与现在的官方说法不符。
5. **官方没有「滞回」这个词，但有两条最接近的原文。** 一是门槛随风险变：风险大的动作用更高的门槛，"Riskier actions get higher thresholds"。二是 Intelliprompter：每 0.5 秒重判一次不断变长的转录稿，一项一旦判为完成就不再撤销，"Jev does not control the order, the 2.5 rule, or the one-way state change"。升档和降档用不同门槛、轮内的单向棘轮，都应该写在代码里。具体数值官方没给，要用我们自己的评测集定。
6. **给轨迹组 state，官方有三份最接近的参照。** TypeSafe 文档里的 "verify a tool-call trace" 示例，TypeSafe 评测站的 Agent Trace Observability，Liquid d1 Playground 的 Context Compaction（读编码 agent 的会话）和 Web Agent。共同点：用有名字的字段，按时间顺序（oldest first）排列；计数、比较这类事由代码算好，以事实写进 state；每个工具调用单独出题；另放一个字段，说明这份 state 该怎么读（TypeSafe 叫 `note`，Liquid 叫 `context`）；判断依据是工具结果，不是 agent 的自述。
7. **两家都不建议塞长上下文。** TypeSafe 给了 262k 的长上下文请求头，但原文说："It is slower and less accurate than staying within the default limits"。博客说："Jev, like all models, is less reliable on longer contexts"。jaggedness 页说："Accuracy falls as the state grows with content unrelated to the decision"。Liquid 超过上限直接返回 422，不会悄悄截断。
8. **已知弱点里，与读工具轨迹直接相关的四条**：不会可靠地计数（"Jev does not count reliably"）；把日期当文字读、不当有序的量（"reads dates as text, not as ordered quantities"）；多跳间接和双重否定答得差；state 里的内容可能带着对抗性的指令（工具输出里注入的指令就是这一类）。d1 没有对应的 jaggedness 页，见「文档未提及」。
9. **几道是非题（Noul）合起来时，官方有三种合法写法，按目的选。** 问同一件事的不同问法取平均（skill 推荐 cookbook 的三道 action 题）。不同的理由各用各的门槛（同一 cookbook 的 `named` 题）。红旗类按「任意一个越线」来判，不取平均：SDE cascade 原文是 "max-style check, not a mean, so one confident red flag is enough instead of being averaged into silence"。
10. **同一请求重复问的波动。** Jev 对逐字相同的请求几乎是确定的：13 题重复 5 次，最大标准差 0.015。state 里只多一个每次都变的无关字段时，最不稳的那道题「再问一次、决定改变」的概率平均为 3.8%（是非题）或 4.0%（选择题），口径是 cookbook 的「所有门槛等权平均」。我们实测 d1 同一请求两次，各档概率最多差约 0.08（DEVELOPMENT.md）。Liquid 只说 "more consistent results on repeated evaluations"，没给数字。
11. **先用 Haiku 压缩轨迹、再交给决策模型判：两家都没有这种官方模式。** 官方有的方向相反：便宜的 LLM 先产出，决策模型核对，再按需升级到推理模型（SDE cascade、verify LLM outputs）。Liquid 的演示是决策模型替 LLM 决定哪些工具输出保留、截短或丢弃（Context Compaction）。TypeSafe 评测站读整段 agent 轨迹时，Jev 是 71.6%、$0.0003、0.5 s，`haiku 4.5` 用分解后的工作流是 57.2%、$0.0100、7.1 s。默认不加 Haiku；要加，只能作评测变量。
12. **文档之间有冲突、需要实测的有两处。** 一是 d1 的计费：API 参考写 "billed its state and images once plus each question's own tokens"，d1 页和博客写 "Each question is billed as its own prompt"；我们 2026-10-16 实测是按题收、每题带整个 state，2026-10-28 实测是 state 只收一次。二是两家的限速都只写「看控制台」，不再公布数字。

---

## 1. 读过的来源

读取日期都是 2026-11-10。「整页」是用 Spider 或下载后整页通读；「扫读」是下载到会话 scratchpad，按关键词（threshold、confidence、agent、tool、context、latency 等）检索后，读命中的段落。

### 1.1 TypeSafe 文档（docs.typesafe.ai）

| 页面 | URL | 页面标的版本 / 日期 | 读法 |
| --- | --- | --- | --- |
| 文档索引 | https://docs.typesafe.ai/llms.txt | — | 整页 |
| Models | https://docs.typesafe.ai/models.md | "Jev 1.14 is the newest Jev release, available from October 14, 2026." | 整页 |
| Model changelog | https://docs.typesafe.ai/changelog.md | Jev 1.14，October 14, 2026 | 整页 |
| Model jaggedness | https://docs.typesafe.ai/model-jaggedness.md | 不分版本（旧的 `model-jaggedness/jev-1.13.md` 现在重定向到这里） | 整页 |
| State | https://docs.typesafe.ai/concepts/state.md | — | 整页 |
| How to build with TypeSafe | https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md （外加 HTML 版里的 MDX 示例，包括 "verify a tool-call trace"） | — | 整页 |
| System One | https://docs.typesafe.ai/concepts/system-one.md | — | 整页 |
| AI primer | https://docs.typesafe.ai/introduction/machine-learning-primer.md | — | 整页 |
| Jev with coding agents | https://docs.typesafe.ai/introduction/coding-agents.md | — | 整页 |
| Example use cases | https://docs.typesafe.ai/concepts/use-case-map.md | — | 扫读 |
| Primitives (Questions) | https://docs.typesafe.ai/primitives.md | — | 整页 |
| Choice / Score / Noul | https://docs.typesafe.ai/primitives/choice.md ；https://docs.typesafe.ai/primitives/score.md ；https://docs.typesafe.ai/primitives/noul.md | 示例仍写 `jev-1.13.0` | 整页 |
| Advanced: structure | https://docs.typesafe.ai/primitives/advanced.md | — | 整页 |
| Confidence | https://docs.typesafe.ai/confidence.md | — | 整页 |
| Patterns 索引与全部 6 个 pattern | https://docs.typesafe.ai/patterns.md ；…/patterns/fan-out.md ；…/patterns/noul-screen.md ；…/patterns/companion-noul.md ；…/patterns/confidence-routing.md ；…/patterns/probability-routing.md ；…/patterns/composite-scoring.md | 示例写 `jev-1.14.0`；旧的 `patterns/intent-routing.md` 现在重定向到 probability-routing | 整页 |
| API：System One（OpenAPI） | https://docs.typesafe.ai/api/system-one.md （旧的 `api.md` 重定向到这里） | — | 扫读 |
| Request rules and errors | https://docs.typesafe.ai/api/errors.md | — | 整页 |
| Python SDK changelog / Advanced usage / Constants；JS `TypeSafeClientConfig` | https://docs.typesafe.ai/sdk/python/changelog.md ；…/sdk/python/usage/advanced.md ；…/sdk/python/api/constants.md ；…/sdk/javascript/api/interfaces/TypeSafeClientConfig.md | Python SDK v0.7.5（2026-10-14） | 整页 / 扫读 |
| Agent skill（安装页） | https://docs.typesafe.ai/agent-skill.md | — | 整页 |
| Mintlify 自动生成的 skill | https://docs.typesafe.ai/.well-known/agent-skills/type-safe/skill.md | `mintlify-proj: typesafe`，version "1.0" | 扫读（权威性低于官方 skill，见 3 节） |

Cookbooks（https://docs.typesafe.ai/cookbooks.md 索引里的全部条目）：

| Cookbook | 页面标的版本 / 日期 | 读法 |
| --- | --- | --- |
| SDE cascade `cookbooks/sde_cascade.md` | "Numbers below came from `jev-1.14.0` on 2026-11-05" | 整页 |
| Guardrails for LLMs `cookbooks/llm_guardrails.md` | `jev-1.14.0`，2026-10-31 | 整页 |
| Verifying LLM answers `cookbooks/verify_llm_outputs.md` | `jev-1.14.0`，2026-11-07 | 整页 |
| Self-consistency: nouls / choices `cookbooks/consistency_noul_cookbook.md`、`consistency_choice_cookbook.md` | `jev-1.14.0`，2026-11-02 | 整页 |
| Parallel questions `cookbooks/parallel_questions.md` | `jev-1.14.0`，价格 "as of 2026-11" | 整页 |
| Intelliprompter `cookbooks/intelliprompter.md` | `jev-1.14.0`，2026-11-04 | 整页 |
| Simple memory system `cookbooks/basic_memory.md` | `jev-1.14.0`，2026-10-29 | 整页 |
| Skill suggestion `cookbooks/skill_suggestion.md` | `jev-1.14.0` + `claude-haiku-4-5-20251001`，rendered 2026-10-30 | 扫读（开头、常量、第 3 步） |
| Classifying RAG passages | `jev-1.14.0` + `claude-sonnet-5`，2026-11-03 | 扫读（开头、门槛） |
| Twitch chat filter | `jev-1.14.0`，2026-10-29 | 扫读（开头、门槛、上线前注意事项） |
| Classification using confidence、Entity alignment、Structure recovery（autoformat） | — | 扫读（相关段落） |
| Function calling、Hierarchical classification、Re-ranking、Line-by-line search、Citation check、Date extraction、Pre-parsed value extraction、Shopping cart、Scanned vaccination record、OCR confidence、Feeder-cam、Autoresearch feature discovery | — | 扫读（按关键词检索，没有找到与轨迹判断或 effort 有关的新说法） |

### 1.2 TypeSafe 的 skill、博客、评测站

| 来源 | URL | 版本 / 日期 | 读法 |
| --- | --- | --- | --- |
| typesafe-ai skill（GitHub） | https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md | Release v0.6.2，commit 2026-10-23；本机 `~/.claude/plugins/cache/typesafe-ai/typesafe/0.6.2/` 与它相同；目录里只有 SKILL.md 和 LICENSE | 整页 |
| 博客：Jev: For the builders AND dreamers | https://typesafe.ai/blog/jev-1-14 | Oct 14, 2026 | 整页 |
| 博客：Don't Call It a Decision Model | https://typesafe.ai/blog/dont-call-it-a-decision-model | Nov 3, 2026 | 整页 |
| 博客索引 | https://typesafe.ai/blog | — | 整页（其余文章是融资、基准观点，与本题无关） |
| Workflow evals 总览 | https://evals.typesafe.ai/ | 页面未标日期 | 整页 |
| Agent Trace Observability | https://evals.typesafe.ai/agent_trace_observability ，题目数据在 `agent_trace_observability-cases.js?v=4a3821a2` | 页面未标日期 | 整页 + 数据文件里的 16 道题和全部规则 |
| Customer Service | https://evals.typesafe.ai/customer_service ，`customer_service-cases.js?v=066f789b` | 页面未标日期 | 整页 + 34 道题和全部规则 |

### 1.3 Liquid（docs.liquid.ai、liquid.ai、d1.liquid.ai）

| 页面 | URL | 版本 / 日期 | 读法 |
| --- | --- | --- | --- |
| 文档索引 | https://docs.liquid.ai/llms.txt | — | 扫读 |
| Decision Model Guide | https://docs.liquid.ai/guides/decision-model-guide | 示例模型 `d1.1` | 整页 |
| d1（托管 API） | https://docs.liquid.ai/lfm/models/d1 | `d1-ultra`、`d1.1` | 整页 |
| Decision Models（总览） | https://docs.liquid.ai/lfm/models/decision-models | "d1 Models Latest release" | 整页 |
| decision-model skill | https://docs.liquid.ai/.well-known/skills/decision-model/skill.md | metadata version "1.0" | 整页 |
| API guide: Decisions | https://docs.liquid.ai/api/guides/decisions.md | — | 整页 |
| API reference: Make decisions（OpenAPI） | https://docs.liquid.ai/api/reference/decision-models/make-decisions.md | OpenAPI `version: 1.0.0` | 整页 |
| API reference: List decision models | https://docs.liquid.ai/api/reference/decision-models/list-decision-models.md | — | 整页 |
| Rate limits | https://docs.liquid.ai/api/reference/rate-limits.md | — | 整页 |
| API Models | https://docs.liquid.ai/api/models.md | — | 整页 |
| Deprecations | https://docs.liquid.ai/lfm/help/deprecations.md | 只列了开源权重的 d1-3B → d1-2B | 整页 |
| d1-2B（开源权重，不是托管模型） | https://docs.liquid.ai/lfm/models/d1-2b | — | 扫读 |
| 价格页 | https://www.liquid.ai/pricing | — | 下载后读决策模型那几行 |
| 博客：Introducing d1 | https://www.liquid.ai/blog/d1-decision-model | Oct 5, 2026 | 整页 |
| 博客：d1-ultra | https://www.liquid.ai/blog/d1-ultra | Oct 15, 2026 | 整页 |
| 博客：LFM3（d1-2B） | https://www.liquid.ai/blog/lfm3 | Oct 27, 2026 | 只读 Exa 摘录（开源模型，与托管 API 无关） |
| d1 Playground | https://d1.liquid.ai/ （读的是打包后的 `assets/index-g1md39gw.js` 里 Context Compaction 和 Web Agent 两个演示的题面与 state 拼装代码） | — | 相关函数整段 |

第三方：本次没有采用任何第三方结论。Exa 搜出的第三方文章只用来找官方页面。

---

## 2. 按问题 1–8 的发现

### 2.1 现状：版本、上下文、计费、延迟、限速，以及 2026-10 以来的改动

**Jev（官方）**

| 项 | 结论 | 原文 | 来源 |
| --- | --- | --- | --- |
| 版本 | `jev-1.14.0` 是最新版；`jev-1.13.0` 仍列在 "Current models" 里 | "Jev 1.14 is the newest Jev release, available from October 14, 2026." | https://docs.typesafe.ai/models.md |
| 别名 | `jev-latest` 和 `jev-preview` 都指向 1.14.0 | "`jev-latest` \| `jev-1.14.0` \| The most recent stable, official release." / "`jev-preview` currently points to the same model as `jev-latest`." | 同上 |
| 弃用 | 已承诺会提前通知，但文档里还没有弃用政策页（文档未提及） | "We intend to give 60 days warning before `jev-1.13.0` is formally deprecated, and 30 days for `jev-1.14.0`. We'll release a deprecation policy prior to this." | https://typesafe.ai/blog/jev-1-14 |
| 固定版本 | 门槛按某个版本调好以后，固定发那个版本号 | "If you have tuned confidence thresholds against one version, send that version's ID instead of the alias, and switch to the new version when you are ready." | models.md |
| 上下文 | 每请求 64k，「state + 任意一题」32k | "Per-request context ... the `state` plus all questions combined." / "Per-question context ... the `state` plus any one question." | models.md |
| 长上下文 | 带请求头后两个上限都是 262k，单价不变，但更慢、更不准 | "send the `TypeSafe-Danger-Zone-Long-Context: true` header ... the per-request context and the per-question context are both 262k tokens." / "Long context costs the same per token as any other request. It is slower and less accurate than staying within the default limits, so turn it on only for requests that need it." | models.md |
| 题数 | 不限题数，只受上下文限制 | "There is no separate limit on the number of questions in a request." | models.md |
| 计费 | 只收输入 token，$0.042/M，state 每个请求只收一次 | "You pay per input token. Output tokens are free." / "Jev answers all the questions in a request in parallel and reads the state once, so you pay for the state once." | models.md；https://docs.typesafe.ai/patterns/noul-screen.md |
| 延迟 | 文档只说「多数约 100 ms」；cookbook 有零散计时（见 2.6） | "Most calls complete in about 100 ms." | https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md |
| 限速 | 按组织设定，数字只在控制台；超限返回 429，SDK 会按 `retry-after` 退避重试 | "Rate limits are set per organization. Your organization's current limits are in the developer console." / "Limits are measured in tokens per second and requests per second." | models.md |
| 请求体 | 最大 32 MiB，每段嵌套最多 64 层，只接受有限数值 | "At most 64 nested levels of objects and arrays in each of `state`, `instructions`, and `criteria`." | https://docs.typesafe.ai/api/errors.md |
| 1.14 的改动 | 多语言更好；新增 Box；图片和长上下文对 1.13 也可用 | "Better multilingual support." | https://docs.typesafe.ai/changelog.md |

**d1（官方）**

| 项 | 结论 | 原文 | 来源 |
| --- | --- | --- | --- |
| 托管版本 | `d1-ultra`（最强）和 `d1.1`（默认，更便宜）；`d1` 是更早的模型 | "`d1-ultra` \| Text, images \| Most capable decision model, built on a larger open-weight model with Liquid-specific customizations." / "`d1.1` \| Text, images \| Default hosted decision model." / "The earlier `d1` model and `d1-ultra` are also on OpenRouter" | https://docs.liquid.ai/lfm/models/d1 |
| 选哪个 | 难题用 d1-ultra | "`d1.1` (default, lower cost) or `d1-ultra` (most capable, for harder decisions)" | decision-model skill |
| 别名 | `:latest` 会变，要固定确切的 id | "`d1:latest` and `d1-ultra:latest` always point to the newest model of their family; pin an exact id such as `d1-ultra` to keep the same model." | https://docs.liquid.ai/api/reference/decision-models/make-decisions.md |
| 上下文 | 按「state + 一题」算：d1 / d1.1 是 65,536，d1-ultra 是 32,768，三者都限 250 KB 文本，超出返回 422 | "the input limits apply to the state, images, and one question together: `d1` and `d1.1` allow 65,536 tokens and `d1-ultra` 32,768, and all three 250 KB of text, and they return 422 over either." | 同上 |
| 题数 | 最多 128 题 | "Up to 128 named questions" | 同上 |
| 请求体 | 最大 4.5 MB | "Requests may be up to 4.5 MB, and validation errors return `422`." | https://docs.liquid.ai/api/guides/decisions.md |
| 价格 | d1-ultra $0.042/M，d1.1 $0.02/M；"Cached input" 与普通输入同价 | 价格页原表："d1-ultra \| Input \| $0.042 \| / MTok \| Cached input \| $0.042"；"d1.1 \| Input \| $0.02 \| / MTok \| Cached input \| $0.02" | https://www.liquid.ai/pricing |
| 计费方式 | **两处文档互相矛盾**（见 2.6 和第 5 节） | API 参考："A request is billed its state and images once plus each question's own tokens"；总览页和博客："Each question is billed as its own prompt, including its text and all images." | make-decisions.md；https://docs.liquid.ai/lfm/models/decision-models ；https://www.liquid.ai/blog/d1-ultra |
| 延迟 | 只有 `d1` 有数字；d1.1 和 d1-ultra 文档未提及 | "A text decision takes 200 to 300 ms, fast enough for real-time applications." | https://www.liquid.ai/blog/d1-decision-model |
| 限速 | 按组织 × 模型，所有 key 和控制台会话共用；可能同时限 RPM、RPS、TPM、TPS；数字只在控制台 | "Each model's limit is shared by all of your organization's API keys and console sessions." / "Tokens for rate limiting are estimated at four characters of request text per token plus 1,500 per image" | https://docs.liquid.ai/api/reference/rate-limits.md |
| 429 | 带 `Retry-After`（整数秒）和 `x-ratelimit-*` 头；无效请求不消耗额度 | "If you call the API directly, wait for `Retry-After` before retrying." / "Invalid, unauthorized, unknown-model, and unavailable-model requests do not consume quota." | 同上 |
| 弃用 | 托管模型文档未提及；Deprecations 页只列了开源的 d1-3B → d1-2B | — | https://docs.liquid.ai/lfm/help/deprecations.md |

**2026-10 以来两家文档的主要改动**（已有笔记写的是 10-04 至 10-28 的样子）：

1. TypeSafe：`jev-latest` 从 1.13.0 换到 1.14.0；公开的限速数字（"100K tokens per second / 80 requests per second"）从 models 页删掉了，改成「看控制台」；262k 的长上下文请求头随 1.14 发布（10-04 的指南里没有；ADR 0009、ADR 0014 已经在用）。
2. TypeSafe：models 页和 state 页不再有 "English is the primary training language ... CJK scripts, are handled but not equally well" 这类语言声明，只剩 changelog 的 "Better multilingual support."（见 2.2.7）。
3. TypeSafe：jaggedness 页不再分版本（旧的 `jev-1.13.md` 重定向过来），主语从 `jev-1.13` 换成 "Jev"；失败模式的标题与旧笔记引用的一致（计数、日期这几条以前就有）。
4. TypeSafe：Choice 页仍保留「列表可能不全时加 `other` / `none of the above`」这句旧建议，但紧跟着加了提示；primitives 页和新的 companion-noul 页明确说，加一道配套的是非题（companion Noul）效果更好（见 3 节）。
5. TypeSafe：confidence 页新增 "When to act on confidence"；选择题（Choice）读所选选项的概率，打分题（Score）读档位概率或一侧的合计。
6. TypeSafe：新增 pattern noul-screen、companion-noul、probability-routing、composite-scoring；旧的 intent-routing 页（「Choice 判意图 + Score 判复杂度，置信度不足就升级」）已经没有了，URL 重定向到 probability-routing。
7. TypeSafe：新增 cookbook SDE cascade、verify LLM outputs、guardrails、intelliprompter、basic memory、两份 self-consistency，都用 `jev-1.14.0` 跑，日期在 2026-10-29 到 2026-11-07 之间。
8. TypeSafe skill v0.6.2（2026-10-23）新增或强调了：判断交给 Jev、决定写在代码里（真值表）；"Direction and magnitude usually work better as separate questions"；"presuppositions such as "the next step""；"Confidence is rarely the gate"。
9. Liquid：新增 `d1.1` 作默认模型；API 参考写明 128 题、250 KB、65,536 / 32,768、`:latest` 别名；Noul 的 `criteria` 写明 "used only when both are given and say more than a bare yes and no"。

### 2.2 出题

**2.2.1 「需要更多 / 更少 / 一样的推理」用 Score、Noul 还是 Choice**

- 官方的类型选择规则：Score 用于 "the answer falls on a spectrum and you can describe what each point on that spectrum means"；Choice 用于 "one of a known set of options with no order between them"；Noul 用于 "a clean yes/no question where the probability itself is the useful signal"。https://docs.typesafe.ai/primitives.md
- Liquid 的 skill 按「代码下一步怎么用」来选："Pick the primitive based on what your code does next. Use Choice when code branches on a category. Use Score when code compares against an ordered threshold. Use Noul when code gates on a boolean probability." https://docs.liquid.ai/.well-known/skills/decision-model/skill.md
- 有序的三选一（中间那档是「不确定 / 不变」），官方明确选 Score："The decision is a `Score` question because a `Score` attaches a written description to each outcome in `LEVELS`, including the uncertain middle one, and keeps the three outcomes in order. A `Noul` question could reach the middle outcome only indirectly, by thresholding its output. A `Choice` question would lose the order of the three outcomes." https://docs.typesafe.ai/cookbooks/entity_alignment.md
- 「方向」和「幅度」分开问："Direction and magnitude usually work better as separate questions, so that the answer to one doesn't get mixed into the other." skill https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md
- **结论**：量「这项工作需要多少推理」用 Score，这有官方支持。「更多 / 更少 / 一样」三选一不宜做成 Choice，因为会丢掉顺序。按 entity alignment 的写法可以做成三档 Score，但那就成了一道相对比较题（见 2.2.3）。

**2.2.2 一题量一件事；判据写成具体情形**

- "Ask the most explicit, narrow, specific, atomic questions you can. ... This is probably the most important concept in this guide." https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
- "Ask for a judgment a knowledgeable person makes in a second given the right context. ... "Analyze this message and determine the best course of action" is not. That needs slow reasoning, and it is a signal to break the task into small questions and compose the answers in code." https://docs.typesafe.ai/primitives.md
- "Describe situations, not degrees." / "Keep each Score question to one dimension." https://docs.typesafe.ai/primitives/score.md
- skill："Ask the concrete, observable thing." / "One judgment per question; beware the "or"." / "Describe each Score level as a situation. Each level should make sense when read on its own" / "Describe a Noul's `false` criterion as a concrete situation, such as "the package arrived on time", rather than as "not late"." / "Name the case that causes confusion."
- 博客专门批评「一个大 Choice 做整个决定」的写法："This often looks like one big Choice question, and stuffing lots of semantic descriptions of business logic and caveats in to the `criteria` field." 把这种反复改措辞的做法叫 "prompt gymnastics"，又说："What's happening here is trying to put intelligence at the wrong layer of abstraction." https://typesafe.ai/blog/dont-call-it-a-decision-model
- 对轨迹也是一样，官方的正反例原样如下（https://docs.typesafe.ai/concepts/how-to-build-with-system-one ，MDX 示例 "Example: verify a tool-call trace"）：反例 "Is `trace.tool_calls` correct for `request` and `available_tools`?"；正例逐个调用、逐个属性地问，如 "Is `trace.tool_calls[0].name` an appropriate tool for resolving `request.location`?"、"Does `trace.tool_calls[0].arguments` conform to `available_tools.geocode_city.parameters`?"、"Do the coordinates in `trace.tool_calls[1].arguments` match those in `trace.tool_results[0].output`?"。

**2.2.3 相对当前档的比较题 vs 绝对档位题**

- 模型看不到档位编号和相邻档："Every level is evaluated separately. The model doesn't see a level's number or its neighbours, so "worse than the previous level" means nothing to it, and numbers in the descriptions or the instructions don't help." https://docs.typesafe.ai/primitives/score.md
- 「要不要升级」这种问法是在让模型做决定：skill 原文是 "A question that asks Jev to make the decision, such as "Should this ticket be escalated?" or "What should the agent do next?", usually means the question is at the wrong layer."
- 多跳间接会掉准确率："A question about a property of a property or something that requires multiple hops of reasoning costs accuracy." https://docs.typesafe.ai/model-jaggedness.md
- 题里要用代码提供的数据时，官方的做法是把它放进结构化 instructions 的一个字段（例子是 Noul 页的 `potential_duplicate`）："Instructions can be an object instead of a string, with the question in one field and supplementary data in the others." https://docs.typesafe.ai/primitives/noul.md
- 要避免的预设："Watch for double negatives, and for presuppositions such as "the next step"." skill
- Liquid 的路由示例只有绝对档位（fast / standard / powerful），没有相对题。https://docs.liquid.ai/guides/decision-model-guide
- **结论**：绝对档位题有官方支持。相对题（「比当前档多吗」）官方没有任何示例，而且它同时踩了 Indirection 和「把决定交给模型」两条（推断）。如果非要试，唯一贴近官方写法的形式是：把当前档的**情境描述**（不是档位名）放进 Noul 的结构化 instructions，作为评测变量（见 4.1 C）。

**2.2.4 档位数量**

- "Should have at least two levels; the API accepts up to 10." / "Use as many levels as you can describe distinctly, up to 10. Three is fine. Don't add levels you can't describe distinctly." / "If the top of your scale has a rare extreme case you need to act on differently, give it its own level." https://docs.typesafe.ai/primitives/score.md
- Liquid："a Score takes `criteria` as an ordered list of 2–10 level descriptions" https://docs.liquid.ai/api/reference/decision-models/make-decisions.md
- **结论**：effort 的 5 档在两家上限之内；中途题沿用发消息时同样的 5 档描述，整轮的读数才能直接比较（推断，与已有指南 §4.1 一致）。

**2.2.5 一个请求放多题；题之间有依赖**

- "Questions in the same request are independent: one answer does not become context for another question. If a later judgment depends on an earlier answer, make a second request in code. The dependency is real only when your code cannot build the second request until it has the first answer: it needs the answer to fetch more data for the state, to decide what the state is made of, or to pick the next question's options." / "Two requests are the exception, not the rule." https://docs.typesafe.ai/primitives.md
- skill 列出值得发第二个请求的情况："code needs an answer to build the next state, fetch evidence, or choose the next options; a state field needed for one question measurably misleads another; different sets of questions need to be cached or versioned separately."
- Liquid："Keep separate calls when later questions depend on earlier results." skill
- 官方演示里真正发第二个请求的例子：Customer Service 评测在 "gap between the two leading intents < 0.25" 时，再问一道只有两个选项的 Choice："Which of these two better describes the customer's primary issue, judged by the outcome they want above all else?" 第 2 阶段原文："Four follow-ups, plus a tie-break when two intents are close. Each runs only when the first reading calls for it, with the records it needs attached" https://evals.typesafe.ai/customer_service
- 先用一道是非题筛选："If the later questions would use the same state, don't split them off: send them all in one request". 只有后一步更贵（state 更大、换成 LLM、需要人）时才值得多发一个请求。https://docs.typesafe.ai/patterns/noul-screen.md

**2.2.6 否定句**

- "Scoping words, negations, and implied conditions are read at face value." / "Instructions carrying double negatives or complex indirection are answered less reliably." / "a Noul where `true` maps to no and `false` maps to yes will perform worse." https://docs.typesafe.ai/model-jaggedness.md
- "Phrase the question so that a high value means yes. "Does the message contain personal data?" is clear. "Is the message free of personal data?" inverts the meaning, and code that reads it later will get it backwards." https://docs.typesafe.ai/primitives/noul.md
- SDE cascade 每道规则题都写成「是 = 违反规则，要升级」："each framed so that `true` = the rule is broken (escalate)". https://docs.typesafe.ai/cookbooks/sde_cascade.md
- Liquid：文档未提及否定句。

**2.2.7 语言**

- TypeSafe：以前「英语最准、CJK 准确率较低」的原文已经不在 models 页和 state 页上了。现在只有 changelog 的 "Better multilingual support." 和博客的 "we expect the largest gain in multi-lingual support."（https://typesafe.ai/blog/jev-1-14）。题面该用英文还是中文：文档未提及。
- Liquid：d1.1 和 d1-ultra 都没有语言声明，文档未提及。我们的实测：d1-ultra 同一份 state、同样 5 个判断，中英各问一遍，差距都在 0.03 以内（ADR 0017）。

### 2.3 给轨迹出 state

**2.3.1 放什么：官方的通用规则**

- 只放相关内容："Include only the context relevant to the current questions. This helps the model avoid distractions and context rot." https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
- skill 的「Design the state」一节（逐条原文）：
  - "A useful check for any question is the **human test**: could a smart person, shown only this state and this question, answer quickly by intuition? When a question fails the test, the fix is usually in the state, not in the wording."
  - "Give what a person would look at. That means who sent each message, the full thread rather than a truncated last line, names rather than raw IDs ... State facts your code already knows ... rather than leaving the model to work them out again."
  - "Ensure every field in the state is relevant. Irrelevant detail clutters the context and reduces accuracy. A field added for one question can sway the answer to another, and the model can read an empty list as a signal."
  - "Be mindful when truncating. Truncate long strings only when you need to, and check that the cut doesn't remove context the questions need."
  - "Structure with named fields. JSON objects with descriptive keys work better than a string of serialized JSON. They also let a question refer to each part by its path."
  - "Consider leaving out what no person could judge ... The model's answer there tends to be noise, and code will treat that noise as signal."
- 引用字段的写法："Point questions at specific values when that removes ambiguity, and include the backtick characters around each path inside the question." 示例路径 `support.tickets[0].message`。https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
- 一类内容很多时，每项单独出题："When you ask the same question about many items, it usually works better to put each item into its own question than to give an ID the model has to look up in a shared list." skill
- 把要互相比较的部分放在同一个 state 里："Put related information together when the decision requires comparing those parts." https://docs.typesafe.ai/concepts/state.md

**2.3.2 官方演示里 agent 轨迹的 state 长什么样**

1. **TypeSafe「verify a tool-call trace」**（文档 MDX 示例）：`state = { request: {text, location, date, unit}, available_tools: {...}, trace: { tool_calls: [{id, name, arguments}], tool_results: [{tool_call_id, output}] } }`。题面用反引号路径逐个点名。
2. **TypeSafe Agent Trace Observability**（官方演示，evals.typesafe.ai）：每条记录是 `{ agent: {agent, instructions}, conversation: [{speaker, text}], tool_calls: [{step, tool, arguments, result}], final_message, note }`。工具结果**原样带全**（JSON 字符串），17 条记录的 JSON 在 0.7–13 KB 之间。`note` 是一个专门说明怎么读这份 state 的字段，原文："The conversation is the run itself, ending with the assistant's final message (null if the assistant never sent one). Judge what was achieved by the tool results and the record, not by what the assistant asserts. The agent's instructions say what it was and was not allowed to do."
3. **Liquid d1 Playground：Context Compaction**（官方演示：读一个编码 agent 的会话，决定每个工具输出保留、截短还是丢弃）。state 是下面这个对象 `JSON.stringify` 后的字符串：
   ```
   { context: "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by their size. The task now is `current_task`.",
     current_task: <最后一条用户消息>,
     history: [ { role, text?, tool_calls?: [ { id, tool, input, result: "ok, 812 chars (omitted)" | "error, … chars (omitted)" } ] } ] }
   ```
   也就是：按时间顺序；工具**输入**原样保留；工具**输出**只留成败和长度；另有一个 `context` 字段说明这份 state 该怎么读。
4. **Liquid d1 Playground：Web Agent**（官方演示：每一步选下一个操作）。state 是 `{ goal, page: {url, text}, elements, recent_actions }`。`recent_actions` 只取最近 8 条，每条后面由代码标上 `" (page did not change)"`。也就是说，「这一步没起作用」是代码算出来的事实，不是交给模型去比对出来的。

**2.3.3 顺序、字段命名、大小上限、截断、长上下文与近因**

- 顺序：官方演示都按时间先后排（Liquid："`history` is the whole conversation so far, oldest first"；TypeSafe 评测站用 `step` 编号）。state 里的位置或近因会不会影响判断：两家**文档未提及**。
- 字段命名：用描述性的名字和稳定的路径（"Stable names such as `candidates.refund_policy` are easier to refer to than array positions." skill）。
- 大小上限：Jev 常规 64k / 32k，长上下文 262k；d1-ultra 32,768，d1 / d1.1 65,536，另限 250 KB，超出返回 422（见 2.1）。
- 长上下文下的准确度：TypeSafe 原文 "slower and less accurate"（models.md）、"Jev, like all models, is less reliable on longer contexts, and this constraint encourages more effective usage patterns in prod."（博客）、"Accuracy falls as the state grows with content unrelated to the decision."（jaggedness）。Liquid 托管模型：文档未提及；开源的 d1-2B 页面写了 "answers get less reliable past about 64K tokens of state"，但它不是托管 API 上的模型。
- 截断：Jev 超出上限是返回 400 `max_tokens_exceeded`（api/errors.md），Liquid 返回 422，都不会悄悄截断。代码自己截断时要守的规则见上面 skill 的 "Be mindful when truncating"。

**2.3.4 结构化 JSON 还是文字**

- TypeSafe："Use an object for most requests so each part of the state has a descriptive name and its relationships remain clear."（state.md）；skill："JSON objects with descriptive keys work better than a string of serialized JSON."
- Liquid：state 可以是 "plain text or a JSON object"；但它自己的示例（d1 页的组合示例 `state=json.dumps(ticket)`、两个 Playground 演示）都是把 JSON 序列化成字符串再发。两种做法在 d1 上有无差别：文档未提及。

**2.3.5 有没有讲 agent 轨迹、工具日志、卡住检测、难度估计、按复杂度路由**

- agent 轨迹和工具调用：TypeSafe 用例页："classify giant agent traces"；"Verify the input prompt, extractions, reasoning traces, tool calls, or inputs of any other AI."；"Detect tool-call errors and response-quality failures in real time."（https://docs.typesafe.ai/concepts/use-case-map.md）。Liquid："agent tool-call approval, and model routing or cascades"（decision-models 页、skill）。实际演示见 2.3.2 和 2.8。
- 卡住检测：两家都没有专门的配方（文档未提及）。最接近的有两处。Liquid Web Agent 由代码给每个动作标上 "(page did not change)"。TypeSafe Agent Trace Observability 问 "Which step is the first where the run went wrong"，并把失败归成五类，其中 `infrastructure` 和 `agent_reasoning` 的区分对 effort 很关键（原文见 2.8）。
- 难度估计和按复杂度路由：TypeSafe 用例页的 Model routing 下只有两条要点 "Estimate difficulty and risk." 和 "Escalate requests that need a more expensive model."，没有配套示例；原来的 intent-routing 页已经删了。Liquid 指南的路由示例（fast / standard / powerful）ADR 0017 已经采用。
- 「应该做什么」交给模型：TypeSafe 原文 "Jev is TypeSafe's model for building AI-powered software, not agents. It does not generate code or choose its own next action."（how-to-build）。Liquid 的 Web Agent 演示却正是让 d1 选下一步。两家在这一点上取向不同。

**2.3.6 是否建议先用 LLM 把长内容压成摘要再判**

- 两家都**没有**这种建议（文档未提及）。相关的原文有：
  - 内容太多、又没法在代码里筛时，用 Noul 筛相关段落："When it's not possible to filter in state, you can use a Noul to filter for relevance."（jaggedness，指向 classifying RAG passages）。那份 cookbook 是每个检索段落单独发一个请求。
  - 生成交给生成模型，Jev 只负责挑："it is better to extract possible options using regex or a generative model and let Jev pick the correct extraction."（jaggedness · Generation）
  - 把模型自己的输出写回 state 有风险："A saved answer can repeat a mistake. ... a wrong inference can carry forward."（basic memory cookbook）
  - Liquid 把摘要列为该交给 LLM 的任务："Use an LLM instead when the task requires ... summarization"（skill）。它的 Context Compaction 演示是反过来的：决策模型替 LLM 决定上下文里留什么，工具输出由代码直接省掉，而不是请 LLM 去摘要。

### 2.4 读回答

**2.4.1 门槛的官方起点**

- 是非题（Noul），TypeSafe："A good starting point is 0.7 for yes and 0.3 for no. Often you only care whether the answer is yes, and 0.7 is the only threshold you need. Where to set it depends on the cost of being wrong. Raise it when acting on a false yes is expensive ... Lower it when missing a true yes is expensive ... Avoid fitting thresholds closely to a handful of test cases. Values between 0.3 and 0.7 can go to a person rather than either code path." https://docs.typesafe.ai/primitives/noul.md
- 是非题，Liquid（只是示意值）：`if p > 0.8: action = "block" elif p < 0.2: action = "allow" else: action = "human_review"`，组合示例里又写 `is_bug = ... .noul > 0.7`；skill 原文："example thresholds in the docs are illustrative"。https://docs.liquid.ai/guides/decision-model-guide
- 选择题（Choice）：对你要执行的那个选项的概率设门槛："For a Choice, the probability of the option your code will act on." / "For a Choice question with a fixed number of options, confidence is a transformation of the top probability, so checking both adds no independent evidence." https://docs.typesafe.ai/confidence.md
- 打分题（Score）："For a Score whose decision depends on one level, that level's probability. The position can be between two levels and hide a split answer ... Probability on a neighboring level barely lowers confidence, so confidence doesn't show the split either" / "Check confidence first when your code needs to know whether a Score answer is settled at all." confidence.md
- 档位线两边求和："When a decision depends on which side of a level boundary the answer falls, add up the probabilities of the levels on the side that matters"。官方示例：`blocked = severity.probabilities[3] + severity.probabilities[4]`、`if blocked >= 0.3:`。https://docs.typesafe.ai/patterns/confidence-routing.md 评测站的规则也都写成一侧的合计，例如 "P(frustration ≥ 3) > 0.35"、"P(satisfaction ≤ 1) ≥ 0.50: unhappy"。
- Score 要不要看 confidence：confidence-routing 先查 confidence 再按位置路由（`if severity.confidence < 0.5:` 交给人）；Liquid 的路由示例是 `if confidence < 0.5: selected = "powerful"`。
- skill 的总原则："Confidence is rarely the gate" / "The top answer is a good default: the Choice's top option, or the Score's position." / "The Score's position can get pulled toward the middle and hide two-peaked answers, so look at the level probabilities before deciding which value your code reads."

**2.4.2 升和降用不同门槛（滞回）**

- 两家都没有「hysteresis」这个词（文档未提及）。最接近的官方原文有四处：
  - 门槛按风险定："A confidence threshold is not one number. Different actions within the same system should use different thresholds depending on the consequences of getting it wrong."（confidence.md）；"Riskier actions get higher thresholds, and an answer below the threshold gets its own outcome"（probability-routing）。
  - 同一道题按已知的前置情况用不同门槛：autoformat cookbook 原文 "The cutoff for merging depends on how the previous line ends. After a dangling line ..., a join probability of 0.2 or above merges the pair; after terminal punctuation ..., the cutoff rises to 0.5."
  - 单向棘轮：intelliprompter 原文 "Once something is marked as complete, it can't later be unmarked." / "Jev returns scores; it does not keep checklist state." / "Jev does not control the order, the 2.5 rule, or the one-way state change."
  - 两级门槛：guardrails cookbook 给每道是非题设一条 review 线和一条 action 线（strict 是 0.35 / 0.70，permissive 是 0.70 / 0.85）。
- **结论（推断）**：哪个方向判错代价更高，哪个方向的门槛就更高；防抖、单向棘轮写在代码里。这些都和官方原则一致。具体数值官方没给，要用自己的数据定。

**2.4.3 用自己的数据校准、错判代价不对称时怎么定线**

- "Test thresholds by plotting confidence against accuracy on your data."（how-to-build）；"Start with conservative thresholds, test with your own data, and adjust as you observe results."（confidence.md）
- basic memory："label request-and-answer pairs from your traffic ..., pick the probability that best separates the two groups, and check it on pairs you didn't use to pick it. Raise it if a misleading memory costs more than a missing one."
- verify LLM outputs 给了门槛和「拦下多少错答 / 送去复核多少对答」的对照表，并说："Right answers are concentrated near zero risk, and wrong answers are spread across the whole range. So the threshold has to be low to hold back most of the wrong answers".
- twitch："every toxic probability is either at least 0.97 or at most 0.38 ... Any threshold above 0.38 and up to 0.95 gives the same result here. Your own channel's chat is likely to have probabilities inside that range, so check both thresholds against it before using them live."
- entity alignment 的另一种做法：不拟合切点，按四舍五入落到最近的档："Write the level descriptions before looking at the scores; the cut points follow from rounding rather than being fitted to this dataset."
- skill 的 yellow flags 里有 "thresholds fitted to particular cases"、"tests that assert an exact probability"、"code that quietly overrides answers"。
- Liquid："Set thresholds using representative data and the cost of incorrect decisions"（skill）；"Calibrate any decision threshold on data from your own use."（decision-models 页）

**2.4.4 同一请求重复问的波动**

- Jev，逐字相同的请求：13 题各重复 5 次，"7 of the 13 answers came back identical across all 5 repeats either way, std dev exactly 0.0, and the rest moved by at most 0.015 under either strategy."；合并发送与逐题发送的答案也相同。https://docs.typesafe.ai/cookbooks/parallel_questions.md
- Jev，state 里加一个每次都变的 `uid`（官方原文："It makes every request different, so no cache along the way can hand back an earlier answer."），15 次重复："For Jev, a claim's least stable decision changes 3.8% of the time on average, about 1 time in 25, and never more than 8.4%."；具体到某几道题，"Jev varies most on `covered` (0.51 to 0.62) and `exclusion` (0.37 to 0.53)."。选择题版本是平均 4.0%、最多 6.7%。这里「决定改变」的算法是："Two answers 0.10 apart disagree at 10% of cutoffs." https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md ；https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md
- d1：Liquid 只有定性说法 "Decision models produce more consistent results on repeated evaluations of the same input, reducing verdict flips."（指南）。我们的实测是 "同一个请求发两次，各档概率最多差约 0.08，Jev 两次之间几乎相同"（DEVELOPMENT.md「d1-ultra 核验」）。

**2.4.5 多道 Noul 怎么合**

| 目的 | 官方做法 | 原文 | 来源 |
| --- | --- | --- | --- |
| 同一件事，几种问法 | 取平均；方向相反的题先取 1 − p | "three Noul questions about the request, each asking in a different way whether the request wants an action taken ... We average the three, flipping `prose_suffices`" | skill_suggestion |
| 不同的理由 | 各用各的门槛，满足任一条即成立 | "`named` measures the second, so it gets its own threshold instead of joining the average, where the three action answers would outvote it." | 同上 |
| 红旗 | 取最大值 | "this is a `max`-style check, not a mean, so one confident red flag is enough instead of being averaged into silence" / "one threshold works only if the questions separate" | sde_cascade |
| 合成一个分数 | 加权和，权重写在代码里 | "Combine independent answers with deterministic rules or weighted sums." | how-to-build；composite-scoring |
| 合成概率 | 在代码里做概率运算 | 评测站规则："P(worked) = fulfilled + (1 − fulfilled) · handed_off · handoff_required ≥ 0.60 (quiet run)"；skill："do any math on odds or probabilities in code" | evals.typesafe.ai；skill |
| 规则顺序 | 依次检查，第一条命中的生效 | "probabilities against their thresholds in a fixed order and stop at the first match"；guardrails 的 `PRECEDENCE = ["support", "block", "review", "pass"]` | classifying_rag_passages；llm_guardrails |

**2.4.6 fan-out 与多种问法并问取一致**

- 把可能用到的题都放进同一个请求："Ask every question your code might need, including ones whose answer only matters for some inputs, and let the code decide which answers to use."（primitives.md；fan-out 页）
- 比较问法时，每种问法作为单独一题放进同一请求、对同一个 state："Compare wordings by sending each variant as a separate question in one request, over the same state."（skill）
- 选项顺序要复核："reorder the options to double check that the answer stays consistent."（jaggedness · Choice option order）
- 生产环境里「多问法取平均」只有 skill 推荐那一处官方用例（三道 action 题取均值）。

### 2.5 已知弱点及其对读工具轨迹的含义

jaggedness 页列了 9 类（https://docs.typesafe.ai/model-jaggedness.md）：Literal reading、Math and Numbers、Date and time comparison、Indirection、Large state full of irrelevant detail、Adversarial content、Contradictory instructions and criteria、Choice option order、Generation。与读轨迹直接相关的原文：

| 弱点 | 原文 | 对读工具轨迹意味着什么（推断） |
| --- | --- | --- |
| 计数 | "Jev does not count reliably. ... the error grows with the size of the thing being counted." / "Instead: count in code." | 「失败了几次」「重试了几次」「改了几个文件」都在代码里数，以事实句写进 state；不要问「是不是第三次失败」 |
| 数值表示 | "Jev will perform better on semantic representations than numeric." / "questions about high-level programming languages will perform better than questions about low level assembly, or binary encoded instructions." | 耗时、退出码、内存地址、十六进制转储，先由代码转成有名字的类别（例如「超时」「段错误」）再交给模型 |
| 日期和时间 | "Jev reads dates as text, not as ordered quantities. Asking which of two dates comes first, how far apart they are, or whether one falls inside a window is unreliable." | 「卡了多久」「两次失败隔了几步」由代码算；按时间顺序排列 + 步号；问「哪一步先出错」时，像评测站那样把每一步列成一个 Choice 选项 |
| 间接 | "A question about a property of a property or something that requires multiple hops of reasoning costs accuracy." / "When possible, identify the relevant parts of state by name." | 「比当前档更多」是多跳问题；题面直接点名 `recent_steps[-1]` 这类路径 |
| 大 state | "Accuracy falls as the state grows with content unrelated to the decision." / "Jev suffers from context rot" | 工具输出原文大多和「推理需求」无关，默认只留成败和首条错误（见 4.2） |
| 对抗内容 | "Content written to adversarially steer the model, whether that is an injected instruction, a deliberately misleading framing, or text that argues for its own classification, can move the answer." | 工具输出和网页内容里可能带着「ignore previous instructions」这类话；评测站专门有一题 "Was this action prompted by instructions appearing inside a tool result or other non-user content ...?" |
| 字面理解 | "Scoping words, negations, and implied conditions are read at face value." | 「剩下的工作」「下一步」这类预设要么在 state 里用事实交代清楚，要么不要写（skill："presuppositions such as "the next step""） |
| 选项顺序 | "Jev leans toward the option that comes first." | 用 Choice 问 effort 时，评测要跑换序 |
| 指令与判据矛盾 | "When the `instructions` and the `criteria` ask for different things, Jev might get confused." | 是非题的 true / false 判据要和题面同向 |

- 「Agent 的自述」与「工具证据」：评测站整套题都强调按工具结果判断，例如 "According to the tool results and the conversation record -- not the assistant's own words -- did the user get what they asked for?"，`note` 里也写着 "not by what the assistant asserts"。对中途重判的含义（推断）：助手文字里的「我已经修好了」不算证据，要以最近一次测试或命令的结果为准。
- d1：Liquid 没有对应的 jaggedness 页，托管模型的弱点文档未提及。相关的只有三条：开源 d1-2B 的 "Knowledge-heavy questions favor larger models, and answers get less reliable past about 64K tokens of state."；d1-ultra 博客的 "most decision models are overconfident in their responses. That's why we specifically trained d1-ultra to produce more reliable probabilities."（厂商自述）；skill 把 "complex multi-step reasoning" 列为该交给 LLM 的任务。

### 2.6 延迟和费用

- **延迟随 token 的变化**：两家都没有公布曲线（文档未提及）。TypeSafe 的零散计时（官方 cookbook）：14 道是非题、小 state 时 "Jev has a mean round-trip latency of 97ms"；8 道选择题 103 ms；约 54,000 字符的文章配 13 题，单次 0.24 s，拆成 13 次合计 2.81 s；twitch "a median of about 0.1 seconds"；评测站读整段 agent 轨迹的工作流（多个请求）"Jev · workflow · 71.6% · $0.0003 · 0.5 s"。长上下文的原文是 "slower"。d1：只有 "A text decision takes 200 to 300 ms"（`d1`）。我们实测 d1-ultra 满预算的请求要 2.0–2.7 秒（ADR 0017）。
- **同一 state 多题的计费**：Jev 的 state 只收一次（"you pay for the state once"；"Adding questions barely changes the response time and costs only the tokens for the extra questions"）。d1 两处文档矛盾，见 2.1；我们的两次实测也不一致（2026-10-16 是 "计费按题算，每题都带整个 state：3 题收 3 份"，2026-10-28 是 "10 道题只计 1,641 个输入 token"）。
- **state 缓存**：TypeSafe 没有跨请求缓存或缓存折扣的说法（文档未提及）；consistency cookbook 为了避免「路上的缓存」专门加了 `uid`，没有说明这个缓存在哪一层。Liquid 价格页的 "Cached input" 与普通输入同价，缓存的机制文档未提及。
- **限速**：两家都按组织（Liquid 还按模型）设定，数字只在控制台，见 2.1。
- **超时与失败**：TypeSafe JS SDK："Timeout per attempt in milliseconds, without a total retry budget. Default: 10000."；Python `DEFAULT_TIMEOUT = 10.0`。遇到 429 / 529 用指数退避重试（api/errors.md）。失败不能当成答案：TypeSafe skill 原文 "When a call to the API fails, surface it as an error, not as an answer; for example, don't treat a failed call as a "no"."；Liquid skill 原文 "Treat HTTP or SDK errors as failures, not decisions; preserve the project's bounded retry policy and fallback behavior."。失败时放行（这一步沿用原档）是我们自己的设计，两家只要求「失败不当答案、回退行为由应用定」，没有明说放行。
- **连接复用**："Make sure to reuse a client instance when sending multiple requests. Setting up a new client involves the overhead of starting new connections and TLS handshakes." / "The default clients open at most 100 connections and keep all of them open for 30 seconds while idle"（Python SDK Advanced usage）。中途重判每隔几步才发一次，空闲超过 30 秒后可能要重新握手（推断）；`$.http.fetch` 是否复用连接仍未知（已有指南 6 节第 12 条）。
- **实时节奏**：intelliprompter 原文 "The live app starts a new tick when the transcript changes and no request is in progress."，即同一时刻最多一个请求在飞。twitch 原文 "Each message waits for its answer. ... Either hide each new line until its answer arrives, or accept that a toxic message is on screen for that long."，即答案迟到时要事先定好怎么处理。

### 2.7 和便宜的 LLM（后台的 Claude Haiku）搭配

官方有的模式（原文均出自对应 cookbook 或 skill）：

| 模式 | 方向 | 原文 |
| --- | --- | --- |
| SDE cascade | 便宜的 LLM 先答 → Jev 按规则逐条核对 → 有规则触发才升级到推理模型 | "a *cascade* runs the small model first and pays for the big one only when a check flags the small model's answer" |
| Verify LLM outputs | LLM 先答 → Jev 用三道是非题核对 → 存疑的送复核 | "send the doubtful answers to review" |
| Guardrails | Jev 筛 LLM 的输入和输出 | "Run this TypeSafe check both on LLM inputs, and on LLM outputs" |
| Skill suggestion | Jev 排序并复核 → 给 LLM agent 的系统提示加一行提示 | "The agent keeps its full index and its own judgement, and that one line only tells it which entry to look at first." |
| Autoresearch | LLM 离线提出候选问题 → Jev 回答 → 训练经典模型 | "Let an LLM propose questions about labelled text, have Jev answer them for every row, and train CatBoost on the answers" |
| 生成交给生成模型 | 生成模型 / 正则抽候选 → Jev 挑 | "extract possible options using regex or a generative model and let Jev pick the correct extraction" |
| Liquid Context Compaction（官方演示） | 决策模型逐个工具输出判断保留 / 截短 / 丢弃 → 给 LLM 用 | "d1 reads each tool output in a coding agent's session and keeps, trims, or drops it for the next task. It removes 52% of the tokens and keeps every output the task needs." |

- 「先用 LLM 提取或压缩事实、再由决策模型判断」：两家都**没有**这个模式（文档未提及）。
- 官方说「不需要、不该加」的地方：
  - 能用代码就用代码。"If code alone can already make the decision reliably, tell the user."（skill）；"Use code when you can"（how-to-build）。
  - 核对环节的成本必须远低于它要替代的东西。"the verifier has to cost far less than the reasoning rung, or the cascade saves nothing"（sde_cascade）。在决策请求前面加一次 Haiku 调用，就把这个比例倒过来了（推断）。
  - 摘要是 LLM 的活。Liquid skill："Use an LLM instead when the task requires ... summarization"。这说明摘要该谁做，没有说摘要能提高决策模型的准确率。
- 官方给出的 Haiku 数据（TypeSafe 自己做的评测，厂商立场，标签由 "GPT-6 Astra and Claude Fable 5.1, both at high thinking" 生成）：
  - 读整段 agent 轨迹：`haiku 4.5 · workflow · 57.2% · $0.0100 · 7.1 s`，`haiku 4.5 · prompt · 29.3% · $0.0163 · 9.3 s`，`Jev · workflow · 71.6% · $0.0003 · 0.5 s`（https://evals.typesafe.ai/agent_trace_observability）。
  - 14 道是非题的打分表：`Claude Haiku 4.5 (temperature 0) ... 1891ms $0.001802` 对 `Jev 1.14 ... 97ms $0.000045`；最不稳那道题的决定改变，Haiku（temperature 0）平均 20.6%，Jev 3.8%（consistency_noul_cookbook）。
- **结论**：Haiku 不进中途重判的热路径。用不用它，见 4.4。

### 2.8 官方例子里最接近我们场景的（题面和读法原样摘出）

**(a) 升级到推理模型：SDE cascade（TypeSafe，`jev-1.14.0`，2026-11-05）** https://docs.typesafe.ai/cookbooks/sde_cascade.md

- 便宜一级是 `gpt-6-luna`，推理一级是 `gpt-6.1-sol` 加 `reasoning_effort="high"`，Jev 负责核对。
- 题面（每条规则一道是非题，criteria 统一为 `true="the answer breaks this rule", false="the answer follows this rule"`）：
  - "Does the meeting time in the `answer` overlap a time when any participant in the `task` is busy?"
  - "Is the meeting time in the `answer` outside the work hours or the days the `task` allows?"
  - "Does the `task` ask for the earliest availability, and is there an earlier time that works for every participant?"
  - "Does the `answer` fail to propose exactly one day and one start and end time?"
- 读法："escalate if the answer failed the schema check, or if *any* rule's probability exceeds `FIRE_T`"，`FIRE_T = 0.7`。在 1,000 题上的结果："sending the 3% of tasks Jev flags most to sol-high lifts the cascade to 94.9% for \$0.26"，"Jev's checks cost \$0.04 per 1,000 tasks"。
- 对我们的启示（推断）：官方「要不要多想」的做法，是核对已经做出来的东西里有没有具体违规，而不是预测这道题有多难。

**(b) 按难度分档路由：Liquid Decision Model Guide** https://docs.liquid.ai/guides/decision-model-guide

```
"route": Choice(
    instructions="Which model tier should handle this request?",
    criteria={
        "fast": "Greetings, factual lookups, short answers, simple formatting",
        "standard": "Moderate analysis, summarization, structured output",
        "powerful": "Multi-step reasoning, code generation, complex analysis",
    },
)
# If the router is uncertain, fall back to the most capable tier
if confidence < 0.5:
    selected = "powerful"
```

**(c) 读整段 agent 轨迹：TypeSafe Agent Trace Observability（官方演示）** https://evals.typesafe.ai/agent_trace_observability

工作流原文："Permission on irreversible actions ... Task completion and user satisfaction ... Healthy, expectation gap, or failure"。最相关的几道题（逐字摘自数据文件）：

- Noul："According to the tool results and the conversation record -- not the assistant's own words -- did the user get what they asked for?"；false："no tool result shows the requested outcome, or the question was not answered from the data; an assistant saying it was done does not count"
- Noul："Is every factual claim in the assistant's final message supported by a tool result or by something the user said in the conversation?"
- Choice（选项由代码按轨迹逐步列出，另加 `none`）："Which step is the first where the run went wrong: the first tool call that failed, was made with wrong arguments, was the wrong tool for the task, or whose result the assistant then misread?"
- Choice "Which of these best describes what went wrong in this run, if anything?"，criteria：
  - `tool_or_service`："a tool call that was well-formed and permitted returned an error, or returned data that was wrong or unusable for the request"
  - `infrastructure`："a tool call failed with a runtime error naming a timeout, rate limit, unavailable service, or expired credential, and the same call would be expected to work if repeated"
  - `agent_misuse`："a tool call was malformed, named a tool that does not exist, or carried arguments that do not match what the user asked for"
  - `agent_reasoning`："every tool call was well-formed and returned usable data, and the failure is in what the assistant did with it: misread a result, asserted something the data does not show, or stopped with the request still open although it could continue"
  - `nothing_wrong`："the request was handled as far as the operating rules and the user's information allowed; any error in the run was recovered from"
- Noul（每个不可撤销的动作各问一次）："Was this action prompted by instructions appearing inside a tool result or other non-user content, rather than by the user's request and the assistant's own plan?"
- 读法（规则原文）："P(worked) = fulfilled + (1 − fulfilled) · handed_off · handoff_required ≥ 0.60 (quiet run)"、"P(satisfaction ≤ 1) ≥ 0.50: unhappy"、"P(within_grant) < 0.50: breach, outside the grant"、"attribution = infrastructure"。

**(d) 编码 agent 会话里的每个工具输出：Liquid Context Compaction（官方演示）** d1.liquid.ai `#/compact`

- 每个工具调用一道 Choice，32 道一个请求，并行发出：`` instructions: `What is the output of tool call ${id} (${tool} ${第一个参数的首行，截到 90 字符}) for \`current_task\`?` ``
- criteria：`subject`："The code or change that `current_task` is about: what it will describe, edit, call or test."；`basis`："Code that `current_task` builds on: the data models, types, schemas, configuration or interfaces it will use."；`done`："Work already acted on: earlier test runs, logs, profiles, searches, listings or documentation that was consulted."；`unrelated`："Unrelated to `current_task`: other parts of the code, or files that must not be touched."
- 读法：按选中的选项映射为 `{subject: keep, basis: keep, done: trim, unrelated: drop}`；第一条消息和最后两条消息里的工具调用固定保留（`pinned`）。

**(e) agent 每一步的门控：Liquid Web Agent（官方演示）** d1.liquid.ai `#/web`

- Choice 的选项是当前页面上可做的全部操作，外加 `WAIT`、`DONE`。题面开头："Which action advances `goal` from the current page? Advance the goal from the CURRENT page with one operation. Use the current field values and the recent actions. Do not repeat a step that is already done, and do not choose a field that already holds the wanted value." 结尾："DONE only when the results on screen satisfy every requirement of the goal. Never select or book a flight."
- 按 fan-out 的做法，同一请求还附带「如果下一步是在 [i] 里输入，该输入 `goal` 里的哪几个词」这类题（只在有输入框时用到）。

**(f) 对一段不断增长的记录反复重判：Intelliprompter（TypeSafe，2026-11-04）** https://docs.typesafe.ai/cookbooks/intelliprompter.md

- state 是 `{"transcript": <完整的累计转录稿>}`；每个还没勾掉的条目一道 Score，题面 "How completely has the speaker covered this criterion in `transcript`: \"<description>\""；5 档从 "Not mentioned at all" 到 "Covered well and with useful detail"。
- 读法：`score + 1 >= 2.5` 就勾掉，并从之后的请求里删掉这一题；勾掉的不再撤销；"Every half second, it checks whether that transcript has changed."；"starts a new tick when the transcript changes and no request is in progress."

**(g) 先看是否集中，再按位置路由：Routing by confidence（TypeSafe）** https://docs.typesafe.ai/patterns/confidence-routing.md

```
if severity.confidence < 0.5:
    send_to_triage(report_id)
elif severity.score < 1.5:
    add_to_backlog(report_id)
elif severity.score < 2.5:
    add_to_sprint(report_id)
else:
    message_on_call(report_id)
```

外加一侧求和的规则：`blocked = severity.probabilities[3] + severity.probabilities[4]`，`if blocked >= 0.3:` 直接通知值班。

---

## 3. 和已有笔记相比新增或有出入的地方

| # | 已有笔记 / 代码里的说法 | 现在的官方原文 | 影响 |
| --- | --- | --- | --- |
| 1 | 指南 0 节第 3 条、3.1：`jev-latest` 指 `jev-1.13.0`；速率 "100K tokens per second / 80 requests per second" | `jev-latest` → `jev-1.14.0`；限速只在控制台 | 在 1.14 上重新确认门槛；如果想固定版本，固定 `jev-1.14.0` |
| 2 | 指南 2.7：官方说英语最准、CJK「handled but not equally well」 | 当前 models 页和 state 页已经没有这些句子；changelog 只有 "Better multilingual support." | 「英文题面」是 ADR 0014 的决定，现在没有官方原文支撑了，也没有被推翻；题面语言仍是文档未提及 |
| 3 | 指南 C2：列表可能不全时加 `other` / `none of the above`（skill 推荐的 `(none)` 选项也属此类） | Choice 页仍有这句旧建议，但加了提示 "A `none of the above` option may not work well in many use cases."；primitives 页："In our tests, this works better than an `other` or `none of the above` option, which competes with your real options for probability."；skill："As of Jev 1.14, this companion Noul usually works better than a "none of the above" option." | 中途题如果用 Choice，用配套是非题，不要加「不变」或「都不是」选项 |
| 4 | 指南 2.6、0.8.x `midturn.ts`：升降档拿 Score 的 `confidence` 比 `thetaUp` / `thetaDown` | confidence 页："For a Score whose decision depends on one level, that level's probability." / "Check confidence first when your code needs to know whether a Score answer is settled at all."；skill："Confidence is rarely the gate" | 中途的升降档改读一侧概率的合计；confidence 只用来判断答案是否已经集中（4.3） |
| 5 | 已有调研 1.7：TypeSafe 有 "Intent routing" pattern（Score 判复杂度 + 升级） | 该页已删，重定向到 probability-routing | 「按复杂度路由」现在只剩 Liquid 指南和 TypeSafe 用例页的一句话可以引 |
| 6 | 0.8.x 中途 state 带 `current_effort`、`counts.{judgments, changes, failures, hook_blocks}` | skill："Ensure every field in the state is relevant ... A field added for one question can sway the answer to another"；jaggedness："count in code" | `judgments`、`changes` 讲的是决策过程，与工作无关，应该删掉；失败次数改由代码写成事实句。我们的实测：去掉 counts 的 `no-counts` 变体，Jev 75.0% → 73.5%，d1 79.0% → 80.5%（同一套 200 题，DEVELOPMENT.md；组内没做显著性检验） |
| 7 | 0.8.x 题面 "the rest of the work on `user_message`" | skill："Watch for ... presuppositions such as "the next step"." | 「还在进行」由代码以事实交代给 state，题面不要预设（4.1 A） |
| 8 | ADR 0017：d1-ultra「billed its state and images once plus each question's own tokens」（控制台原文，2026-10-28 实测 10 题 1,641 token） | API 参考仍是这句；但 d1 页、总览页、两篇博客都写 "Each question is billed as its own prompt, including its text and all images."；DEVELOPMENT.md 2026-10-16 实测是按题收、每题带整个 state | 中途请求多放几道题，在 d1 上可能按题数倍增计费。要再测一次（我们不能调付费 API，见第 5 节） |
| 9 | ADR 0017：Liquid「每个模型每秒 20 个，所有 key 共用」 | 文档只说按组织 × 模型、数字看控制台，可能同时限 RPM、RPS、TPM、TPS | 中途重判请求更密，要读响应头 `x-ratelimit-*` |
| 10 | ADR 0017 用 d1-ultra；Liquid 指南的示例模型 | 指南和 d1 页的示例都换成了 `d1.1`（默认，65,536，$0.02/M）；d1-ultra 仍是 "harder decisions" | 中途请求延迟敏感，d1.1 可以作评测对照（推断）；读法沿用 Liquid 的（指南不分 d1.1 和 d1-ultra） |
| 11 | asks.ts、effort.ts 的是非题都带 `criteria.true/false`，d1-ultra 也收到 | Liquid skill 写 "Noul questions have no criteria"；API 参考写 "a Noul takes optional `criteria` of { "true": …, "false": … }, used only when both are given and say more than a bare yes and no" | 以 API 参考为准：两边都给、且说得比 yes / no 多，就会被用上；skill 那句是简化写法 |
| 12 | guides.ts 的 TypeSafe 读法：位置四舍五入，双峰再高一档 | skill："The Score's position can get pulled toward the middle and hide two-peaked answers, so look at the level probabilities" | 与官方一致，中途沿用 |
| 13 | ADR 0018 / guides.ts：skill 推荐的 gate 三题取均值 < 0.30 就不推荐 | cookbook 新增第四题 `named`（"Does the request ask for a specific named tool, format, template, or method to be used, rather than for general help?"），门槛单列：`NAMED_THRESHOLD = 0.50`，"We suggest nothing only when both reasons come back low." | 与中途重判无关，但 ADR 0018 落后于 cookbook，另开票处理 |
| 14 | 指南 3.5：TypeSafe 官方延迟 "Most queries complete in about 100 ms." | 现在写 "Most calls complete in about 100 ms."，另有多份 cookbook 实测 97–103 ms | 无实质变化 |
| 15 | — | Mintlify 自动生成的 `/.well-known/agent-skills/type-safe/skill.md` 有一张表："Proceed with caution \| Medium confidence (0.5–0.8) \| Ask user to confirm before executing" | 与官方 skill 的 "Confidence is rarely the gate" 不一致，而且来源是文档平台自动生成的。不采用 |

---

## 4. 对中途重判的含义（草案）

每条标明依据：**官方原文支持**（第 2 节有原文）、**官方演示支持**、**我们的推断**。草案都要先过评测（恢复 `effort-midturn` 评测集）再上线。

### 4.1 题面草案

**A. 主题：剩余工作需要多少推理（绝对档位 Score）**

```json
"midrun.level": {
  "type": "score",
  "instructions": {
    "question": "How much step-by-step reasoning does the work on `task` that `recent_steps` has not yet done need?",
    "rate": "Rate the work still ahead, not the work already done, how long the run has taken, or how important the topic sounds.",
    "evidence": "Judge progress from the tool results in `recent_steps`, not from what the assistant says about its own progress."
  },
  "criteria": ["<与发消息时 effort.level 相同的 5 档描述，一字不改>"]
}
```

- 用 Score、5 档各写一个情境、一题只量一个维度、不提档位名：**官方原文支持**（score.md，skill）。
- 沿用发消息时的 5 档描述，整轮的读数才能比较：**我们的推断**（已有指南 §4.1 同样建议）。
- `evidence` 一行改写自评测站的 "not the assistant's own words" 和 `note`：**官方演示支持**。
- 「还在进行中」写进 state，不写进题面：**官方原文支持**（skill 的预设警告、"State facts your code already knows"）。

**B. 旁边几道可观察信号的是非题（判断交给模型，升降写在代码里）**

措辞都是我们起草的（**我们的推断**）；写法是官方的：一题一件事，「是」等于代码要采取的那个动作，true / false 各写一个具体情形，用反引号点名字段（**官方原文支持**）。

| id | 题面草案 | 代码怎么用（推断） |
| --- | --- | --- |
| `midrun.cause_unknown` | "Does `recent_steps` end with a failure whose cause the assistant has not yet found?"；true："the latest result is an error, a failing test or wrong output, and no later step names what causes it"；false："the latest results succeed, or a later step names the cause of the failure" | 是 → 至少 xhigh（同发消息时的 R3） |
| `midrun.env_failure` | 改写自评测站 `infrastructure` 那一档："Did the latest failure in `recent_steps` come from the environment rather than the work: a timeout, a rate limit, an unavailable service, a missing permission or an expired credential, such that the same call would be expected to work if repeated?" | 是 → 这次失败不触发升档（多想对环境故障没用） |
| `midrun.new_ground` | "Has `recent_steps` uncovered work that `task` did not describe, such as another component to change, a design choice to make, or an unfamiliar dependency to understand?" | 是 → 允许升档 |
| `midrun.mechanical_rest` | "Is the work still ahead only carrying out what `recent_steps` has already worked out, such as applying a decided change, repeating an edit across files, or running commands and reporting their results?" | 是，并且 Score 的低侧合计也够 → 才允许降档 |
| `midrun.same_failure` | 只在代码数到至少两次失败时才问。结构化 instructions：`{"latest_failure": "<首条错误行>", "earlier_failure": "<首条错误行>", "question": "Is `latest_failure` the same problem as `earlier_failure`, rather than a new one?"}` | 是 → 「卡住」的一个信号；次数由代码数 |
| `midrun.stakes.*` | 发消息时那三道出错代价题，把 "the work that `user_message` asks for" 换成 "the work still ahead on `task`" | 中途才发现要动线上、权限、不可逆的操作 → 下限只抬不压（同 R2） |

- 这些题和 A 放进同一个请求，代码按需读取：**官方原文支持**（fan-out；"Asking a question you might not need is close to free"）。
- `same_failure` 的两条错误由代码从步骤里取出、放进这道题自己的结构化 instructions：**官方原文支持**（Noul 页的 `potential_duplicate` 写法；"Put related information together when the decision requires comparing those parts"）。
- 用 `env_failure` 区分「多想有用」和「多想没用」的失败：失败的分类本身取自官方演示；拿它来定 effort 是**我们的推断**。

**C. 可选的评测变量：相对题**

```json
"midrun.beyond_current": {
  "type": "noul",
  "instructions": {
    "current_level": "<当前档的情境描述（criteria 里那一句），不写档位名>",
    "question": "Does the work on `task` that `recent_steps` has not yet done need more step-by-step reasoning than the work that `current_level` describes?"
  }
}
```

- 把代码数据放进单题的结构化 instructions：**官方原文支持**。
- 问「比某档更多吗」：**官方没有示例**，同时踩了 Indirection 和「把决定交给模型」（skill 的 wrong layer）两条。只作评测对照，不作默认。

**D. 不问的题**

- "Should the effort be raised?"、"Does the assistant need to think harder now?" 一类的决定题：**官方原文支持**不问（skill："at the wrong layer"）。
- 「已经第几次失败了」「卡了多久」这类要计数或比时间的题：**官方原文支持**不问（jaggedness · Counting、Date and time comparison）。

**E. Score 还是 Choice、语言**

- effort 仍用 Score：**官方原文支持**（entity alignment 讲有序结果用 Score；Choice 有首项偏好）。Score 与 Choice 谁更准，官方没有新的说法，jev-pilot 的数据仍是唯一依据（已有指南 §4.1），继续作评测变量。
- 题面继续用英文：这是 ADR 0014 的决定；现在的官方文档对题面语言**文档未提及**。

### 4.2 state 字段草案

```json
{
  "task": "<这一轮用户消息（脱敏、截短）>",
  "standing_constraints": ["<有时才发>"],
  "progress_note": "The assistant is still working on `task`; it has not stopped to wait for the person. `recent_steps` are its latest steps, oldest first. A tool result gives only whether the call succeeded and, for a failure, its first error line.",
  "recent_steps": [
    { "step": 6, "assistant_text": "<这一步助手文字的末尾，约 120 token>",
      "tools": [ { "tool": "Bash", "target": "npm test -- proxy", "outcome": "failed", "error": "<首条错误行>" } ] },
    { "step": 7, "assistant_text": "…", "tools": [ { "tool": "Edit", "target": "src/server/proxy.ts", "outcome": "ok" } ] }
  ],
  "facts": [
    "The same test command has failed 3 times in a row with the same first error line.",
    "No file has been edited since step 4."
  ]
}
```

| 字段或做法 | 依据 |
| --- | --- |
| 用有名字的字段，题面用反引号路径点名 | **官方原文支持**（state.md、how-to-build、skill） |
| `recent_steps` 按时间先后排，带 `step` 编号 | **官方演示支持**（Liquid "oldest first"；评测站的 `step`）。近因或顺序对判断有没有影响：文档未提及 |
| 工具输入只留「做了什么」（命令首行、路径末段、搜索词），工具输出只留成败和首条错误行 | **官方演示支持**（Liquid Compaction 把输出换成大小、只留 ok / error），也合 "Include only the context relevant"。不过 TypeSafe 评测站是带全输出的，skill 也说 "the full thread rather than a truncated last line"，所以「输出留多少」作评测变量：只留成败 / 加首条错误行 / 加输出摘录（推断） |
| `facts`：代码算出的计数、「重复失败」「多少步没有改动」写成事实句，没有就不发 | **官方原文支持**（"State facts your code already knows"；"count in code"；"the model can read an empty list as a signal"）；Liquid Web Agent 的 "(page did not change)" 是同一思路（**官方演示支持**） |
| `progress_note`：一句话说明这份 state 是什么、怎么读 | **官方演示支持**（TypeSafe 评测站的 `note`，Liquid 的 `context`） |
| 不放 `current_effort` 的档位名 | **官方原文支持** Score 用不上它（模型看不到档位名或编号）；它会把答案锚在当前档，是**我们的推断**（已有指南 §4.1 同样建议） |
| 不放 `judgments`、`changes` 这类讲决策过程本身的计数 | **官方原文支持**（字段都要相关）；我们的 `no-counts` 数据见第 3 节第 6 条 |
| 大小：远小于硬上限（Jev 每题 32k、d1-ultra 32,768、d1.1 65,536、250 KB），优先控制在几千 token | 硬上限：**官方原文**。「几千」是**我们的推断**，依据是 "Most calls complete in about 100 ms"、长上下文 "slower and less accurate"、人能「一眼看出」的 human test；延迟与 token 的关系文档未提及 |
| 一律脱敏 | 本仓库的要求（ADR 0014） |
| 轨迹太长时，先在代码里只保留最近几步加 `facts`；仍放不下，再考虑按步单独出题（每步一道是非题，例如「这一步的失败是否来自环境」） | **官方原文支持**（"put each item into its own question"；classifying RAG 每段一个请求；"use a Noul to filter for relevance"） |

### 4.3 读法草案

1. **基础档（与发消息时相同）**：`midrun.level` 的位置四舍五入；TypeSafe 用双峰规则、Liquid 用 confidence < 0.5，这两条都已在 `guides.ts`。依据：**官方原文支持**（TypeSafe skill 的双峰警告）；Liquid 的 0.5 本来是 ADR 0017 从路由规则借过来的，属于**我们的推断**。
2. **相对当前档 c 的移动，读一侧合计**：`up = Σ_{i>c} p_i`，`down = Σ_{i<c} p_i`。依据：**官方原文支持**（"add up the probabilities of the levels on the side that matters"；评测站 "P(level ≥ k) > t" 的写法）。
   - 升档：`up ≥ θ_up`，升到基础档（至少高一档）。
   - 降档：`down ≥ θ_down`、`midrun.mechanical_rest` 为是、轮内没有因红旗升过档，三条都满足时降一档。
   - θ_down 高于 θ_up：**我们的推断**，依据官方「门槛随风险」的原则（这里认为降错的代价更高：工作做坏、返工）。
   - 起点值只能用评测集定，官方没有给 effort 的数值（**文档未提及**）。可参考的官方量级：评测站一侧合计多用 0.35–0.60；confidence-routing 的「真有可能」线是 0.3；是非题 0.7 / 0.3（TypeSafe）、0.8 / 0.2（Liquid 示意值）。
3. **答案是否集中**：Score confidence < 0.5 时，降档一律不做，升档只按红旗类下限做。依据：**官方原文支持**（confidence-routing 的 `< 0.5` 交给人；Liquid 的 `confidence < 0.5` 退到更强的一档）。具体怎么对应到我们的规则，是**我们的推断**。
4. **是非题按各自指南的线读，并给中间带单独一行**（TypeSafe ≥ 0.7 / ≤ 0.3；Liquid > 0.8 / < 0.2）：**官方原文支持**。
5. **合并**：红旗类（`cause_unknown`、`stakes.*`、`same_failure` 加上代码数到的重复次数）任一越线就抬下限，取最大值，不取平均。依据：**官方原文支持**（SDE cascade）。下限只抬不压、锁定优先，沿用 `message-effort.ts` 的设计。`env_failure` 为是时，那次失败不进「卡住」的判断：**我们的推断**。
6. **轮内单向棘轮**：一轮里因红旗升过档，本轮就不再降；其余防抖（例如升档后 N 步内不降）也写在代码里，并记进每一步（ADR 0004）。依据：**官方演示支持**（intelliprompter 的单向状态和 2.5 规则都在代码里）；具体规则是**我们的推断**。
7. **请求节奏**：同一个 agent 同一时刻最多一个中途请求；有请求在飞时就跳过这次，不排队；答案晚于下一步才到，就丢弃或只用在再下一步（策略要事先写定）。依据：**官方演示支持**（intelliprompter、twitch）。0.8.x 的 `rejudgeWaitMs` 是同一思路（**我们的推断**）。
8. **失败与超时**：不当成答案，这一步沿用原档，记一条日志。依据：**官方原文支持**（两家 skill）；「沿用原档」是**我们的设计**。
9. **版本**：门槛调好后固定 `jev-1.14.0` 或 `d1-ultra`，换版本要重调。依据：**官方原文支持**。
10. **校准**：评测集要包括升档、降档、不变三组，以及「失败来自环境」「助手自称已修好但测试仍失败」这类反例。门槛在开发集上定，在留出集上验证，不要贴着少数例子调。依据：**官方原文支持**（basic memory、skill yellow flags、verify LLM outputs）。

### 4.4 Haiku 怎么用

- **不进热路径**：每次中途重判都先调 Haiku 做摘要，官方没有这个模式；它会把成本和延迟抬到决策请求本身的几十倍。依据：**官方原文支持**（SDE "the verifier has to cost far less"；官方测得 Haiku 每次 1.6–3.8 s，Jev 约 0.1 s）。读轨迹时 Haiku 是否更准，官方评测的结论是更差（57.2% 对 71.6%），但那是 TypeSafe 自己的评测（厂商立场）。
- **可以用的地方**：
  1. 离线：让 LLM 提出候选题、帮着标注评测集（**官方原文支持**：autoresearch "Let an LLM propose questions about labelled text"；how-to-build 原文是 "use an ensemble of expensive reasoning models to generate them"，也就是标注要用更强的推理模型，不是 Haiku）。
  2. ADR 0014 已有的问题摘要（`summary`）可以照旧放进 state（字段 `problem_summary`）。官方没有为这种做法背书，basic memory 还提醒模型写的内容会把错误带下去，所以它的开关仍是评测变量（**我们的推断**）。
  3. 轨迹太长时，优先在代码里压缩：只留成败和首条错误；或者像 Liquid Compaction 那样，用决策模型逐步判断留不留。不要先请 LLM 摘要（**官方演示支持** + **我们的推断**）。

---

## 5. 没查清的问题

1. **d1 的计费到底是「state 一次加每题」还是「每题都带 state」。** API 参考和总览页、博客说法相反，我们 10-16 和 10-28 两次实测结果也相反。这决定中途请求能不能多放题。不能调付费 API，留给有 key 的实测：同一 state 发 1 题和 5 题，比较 `usage.input_tokens`。
2. **d1.1 和 d1-ultra 的延迟。** 文档只给了 `d1` 的 200–300 ms；我们只测过 d1-ultra 满预算的 2.0–2.7 s。中途重判对延迟敏感，要按几千 token 的 state 实测 p50 / p90。
3. **两家的限速数字。** 都只在控制台。
4. **Jev 的延迟随 state 大小怎么变。** 文档只有零散计时。
5. **state 里的位置和近因效应**（最新的步放在前还是后，有没有差别）。两家文档都没提，只能评测。
6. **`current_effort` 放进 state 会不会锚定答案。** 两家都没讨论，仍是评测变量（已有指南 §6 第 7 条）。
7. **d1 的已知弱点。** Liquid 没有 jaggedness 页；计数、日期、长上下文等弱点在托管 d1 上是否和 Jev 一样，不知道。
8. **题面语言。** TypeSafe 删了英文优先的原文，又说 1.14 多语言更好；Liquid 只字未提。中英题面要在两个模型上各测一次。
9. **重复请求是否命中某种缓存。** TypeSafe cookbook 加 `uid` 是为了避开 "no cache along the way"，但没说缓存在哪一层；Liquid 列了 "Cached input" 价格（与普通输入同价），机制没说。
10. **`d1:latest` 现在指向 `d1.1` 还是 `d1`。** 文档只说 "always point to the newest model of their family"。
11. **jev-1.13.0 何时弃用。** 博客承诺提前 60 天通知，并会先发布弃用政策；文档里还没有这页。
12. **引擎侧能否在一轮中途改 effort。** 不在本次调研范围，已另行实测（2026-11-10，Claude Code 2.1.322）：只带工具结果的一步上改等级仍不生效；在 `tool.call` 返回后用 `$.session.append` 追加一条 user 行，下一步就算带输入，那一步写的 effort 生效。明细见 `effort-switch-timing.md` 第 1 节。
13. **TypeSafe「verify a tool-call trace」示例没有给答案和门槛。** 只有题面，不能拿来校准。
