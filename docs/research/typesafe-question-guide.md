# 决策问题写法与接口指南（Dispatch Pilot · 决策请求模块用）

整理日期：2026-10-04。读者：实现 #2（Jev 骨架）、#3（Clef 后端）、#6（派出 agent 路由）、#10/#11（skill 推荐与两段排序）的实现者。本笔记只给写法规则、接口事实和示例请求草稿，不含仓库代码；没有调用任何真实 API，所有「示意响应」都不是真实输出。

> **#2 实现之后的说明（2026-10-04）**：本笔记从会话 scratchpad 移入仓库，正文保持原样，只在这里补充与实现的对应关系。
>
> - 代码在 `dispatch-pilot/hooks/decision/`：`system-one.ts`（请求和回答的类型、合并与拆分）、`effort.ts`（4.1 的 effort 问题）、`context.ts`（state）、`backend.ts` 和 `jev.ts`（3.1、3.4、3.5）。
> - **问题 ID 带前缀**：同一个请求里每项功能的问题放在自己的命名空间下，请求里的 ID 是 `<part>.<id>`，例如 4.1 的 `effort` 在 mod 里是 `effort.level`，4.3 的 `which`、`fits.0` 会是 `skills.which`、`skills.fits.0`。回答交还给各功能时会去掉前缀。ID 字符集按 0 节第 2 条，`mergeParts` 会拒绝不合规的 ID 和超过 64 个问题的请求。
> - 发消息时的 state 是 `{ user_message, recent_context }`，没有 4.1 示例里的 `signals`（spec 没有要求，是否加入可作为评测变量）。功能可以往共用 state 里加字段（例如 4.3 的 `project_platforms`），排在共用字段之后。
> - 0 节第 8、9 条的两个评测变量都已实现为参数：问题语言 `en`/`zh`，effort 原语 Score/Choice（`turnStartEffortPart({ language, primitive })`）。mod 里用 spec 的默认值：英文问题、Score。中文写法逐句翻译了英文问题，档位描述相同；结构化 instructions 的字段名也译成了中文。
> - 用真实 Jev（jev-1.13.0）验证过（`dispatch-pilot/scripts/decide.ts`）：英文 Score、中文 Score、英文 Choice 三种写法 API 都接受，回答都能解析。发消息时的请求（无上下文）输入约 620–750 token，延迟约 510–560 ms。
> - 6 节第 12 条（`$.http.fetch` 是否复用连接）：在新进程里，`$.http.fetch` 的第一个请求耗时 509–522 ms，和 Node `fetch` 的 526 ms 相当，没有看到额外的握手开销，但还不能确定之后的请求是否复用连接。

标注约定（沿用 `docs/research/decision-models-and-caching.md`）：

- **官方**：TypeSafe / Cloudflare 自己的文档、schema 或博客。
- **第三方**：独立作者或社区，未经厂商确认。
- **jev-pilot**：本机 jev-pilot 0.12.1 源码或 CHANGELOG 里作者的实测结论（第三方，但有数据）。
- **推断**：由上述事实推出，文档没有明说。
- **未文档化**：查过的官方来源都没写。

引文一律保持英文原文。路径缩写：`J` = `~/.claude/plugins/cache/jev-pilot/jev-pilot/0.12.1`。

---

## 0. 结论速览（实现前先看这 12 条）

1. **Clef 的答案在 `result.answers`。** REST 响应外壳是 `{"result": {...}, "success": true, "errors": [], "messages": []}`，System One 形状的 `model / answers / usage` 在 `result` 里面。依据：Cloudflare REST 入门页的通用外壳（官方）+ 实测输出（第三方，Flavio Copes）。Clef 模型页本身**没有**展示 REST 响应原文，所以 #3 仍要实测确认一次。Worker 绑定 `env.AI.run()` 返回的是无外壳的对象。
2. **问题 ID 字符集按 Clef 的规则写，两个后端通用**：只用字母、数字、`_`、`.`、`-`，最长 100（官方 Clef schema）。jev-pilot 的 `gate::x`、`fits::<skill名>` 含 `:`，在 Clef 上不合法；本机 skill 名还带插件前缀（如 `cloudflare:wrangler`），所以 `fits` 一类问题要用下标 ID（`fits.0`、`fits.1`）加一张对照表。Choice 的**选项键**没有字符限制，skill 全名可以直接当选项键。
3. **上限**：Choice 选项 Jev ≤255（官方），Clef 2–255；Score 档位 2–10（两家一致）；问题数 Clef 1–64，Jev 没有文档化的条数上限、只受 token 预算约束（64k 整请求 / 32k「state + 最长的一个问题」）。按 ≤64 题、每个 Choice ≥2 个选项来设计，两个后端都能用。
4. **Score 档位要写「情境」，不要写「程度」**：`"Describe situations, not degrees."`；模型逐档单独评估，看不到档位编号和相邻档位，所以「比上一档更难」、数字、档位名（low/medium…）写进描述或 instructions 都没用。
5. **Choice 有首项偏好**：`jev-1.13 leans toward the option that comes first`，官方建议换序复核。生产里固定一个顺序，评测里跑换序一致性；需要时可在同一请求里加一个倒序的同题 Choice 取平均（推断）。
6. **问题 ID 不会发给模型**，选项名和选项描述会发给模型。完整语义必须写在 `instructions` 里。
7. **Confidence 公式**（官方）：Choice `(p_max − 1/n)/(1 − 1/n)`；Score `max(0, 1 − Σ p_i·|i − m| / MAD_unif)`，5 档时 `MAD_unif = 1.2`；Noul 不返回 confidence，需要时用 `|2p − 1|`。门槛「按风险分级、用自己的数据定」，官方示例值 0.3 / 0.5 / 0.6 / 0.8 / 0.85 / 0.9 都只是示例。
8. **语言**：官方只说英语准确率最好、CJK「handled but not equally well」，要求看 Confidence；**官方没有说问题该用英文还是中文写**（未文档化）。「问题保持英文」是第三方实测建议。按 spec，问题语言是评测变量。
9. **effort 用 Score 还是 Choice 尚无定论**：spec 定的是 Score；jev-pilot 0.4.13 在 76 条标注请求上实测 Choice 更好（错 2 档以上从 8–9 降到 5）。建议评测时两种问法放进同一请求同时问（互不影响，几乎不增加延迟），用数据定。
10. **skill「相关度」要读第二段的 `fits` Noul（绝对概率），不要拿第一段 Choice 的概率当相关度**：Choice 的概率在全部候选之间加起来等于 1，只代表相对排名。官方 cookbook 原话：Choice 决定 *which*，Noul 决定 *whether*。
11. **超时与重试**：`$.http.fetch` 无超时，自己用 `Promise.race` + `$.clock.sleep` 截断；参考 jev-pilot 默认 1500 ms。热路径上不做内联重试（失败即放行），429/502/503/529 当作「忙」安静记录。SDK 默认（每次 10 s、重试 2 次、退避 0.5→5 s）是给批处理用的，不适合在 hook 里照搬。
12. **jev-pilot 有大量可借鉴的实测措辞**：effort 五档描述、「Rate the work, not how important the topic sounds」、子 agent 的 effort 问法、三个 gate Noul、`(none)` 选项、rerank 的 `fits` 问法，见第 5 节（附行号）。

---

## 1. 读过的来源

TypeSafe（全部用 Firecrawl 通读，2026-10-04 抓取）：

| 页面 | URL |
| --- | --- |
| 文档索引 | https://docs.typesafe.ai/llms.txt |
| API reference | https://docs.typesafe.ai/api.md |
| State | https://docs.typesafe.ai/concepts/state.md |
| Primitives (Questions) | https://docs.typesafe.ai/primitives.md |
| Choice | https://docs.typesafe.ai/primitives/choice |
| Score | https://docs.typesafe.ai/primitives/score.md |
| Noul | https://docs.typesafe.ai/primitives/noul |
| Advanced: structure | https://docs.typesafe.ai/primitives/advanced |
| Confidence | https://docs.typesafe.ai/confidence.md |
| How to build with TypeSafe（写法总纲） | https://docs.typesafe.ai/concepts/how-to-build-with-system-one |
| Jev 1.13 jaggedness | https://docs.typesafe.ai/model-jaggedness/jev-1.13.md |
| Models（语言声明、上下文、速率） | https://docs.typesafe.ai/models.md |
| Cookbook: Skill suggestion | https://docs.typesafe.ai/cookbooks/skill_suggestion.md |
| Cookbook: Parallel questions | https://docs.typesafe.ai/cookbooks/parallel_questions.md |
| Cookbook: Re-ranking | https://docs.typesafe.ai/cookbooks/rerank_typesafe.md |
| Cookbook: Classifying RAG passages | https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md |
| Pattern: Intent routing | https://docs.typesafe.ai/patterns/intent-routing.md |
| Pattern: Confidence-gated routing | https://docs.typesafe.ai/patterns/confidence-routing |
| Pattern: Speculative fan-out | https://docs.typesafe.ai/patterns/fan-out |
| Python SDK：Retries / Constants / Exceptions | https://docs.typesafe.ai/sdk/python/api/retries.md ；https://docs.typesafe.ai/sdk/python/api/constants.md ；https://docs.typesafe.ai/sdk/python/api/exceptions |
| JS SDK：RetryPolicy / TypeSafeClientConfig / ScoreResponse / SystemOneRequestPayload | https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md 等 |
| 本机 skill | `~/.claude/plugins/cache/typesafe-ai/typesafe/0.5.7/skills/typesafe-ai/SKILL.md` |

Cloudflare / Clef：

| 页面 | URL |
| --- | --- |
| Clef 模型页 | https://developers.cloudflare.com/workers-ai/models/clef/ |
| 输入 schema | https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json |
| 输出 schema | https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json |
| REST 入门 | https://developers.cloudflare.com/workers-ai/get-started/rest-api/ |
| Workers AI 错误码 | https://developers.cloudflare.com/workers-ai/platform/errors/ |
| Cloudflare API 通用外壳（OpenAPI） | https://raw.githubusercontent.com/cloudflare/api-schemas/b49df8c23d1daf1cb9820e11f7edc6603fade56d/common.yaml |
| Changelog（发布说明） | https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/ （仅读 Exa 摘录，主要内容与模型页一致） |

第三方：Flavio Copes《A deep dive into Clef》https://flaviocopes.com/clef/ （实测 REST 输出、错误码 5006、延迟）；jevaiguide《Jev API》https://jevaiguide.com/jev-api/ （实测错误体、模型名）；jev-fanout-bench https://huggingface.co/datasets/lisonallen/jev-ai-benchmark （语言与 token 系数）。

---

## 2. 写法规则清单

表中「来源」列用的是短名（`state.md`、`how-to-build`、`jaggedness`、`choice` 等），完整 URL 见第 1 节的表格。

### 2.1 State

| # | 规则 | 官方原文 | 来源 |
| --- | --- | --- | --- |
| S1 | 同一请求里所有问题看同一份 state，互相独立评估 | "Each request evaluates one state against one or more questions. All questions see the same state and are evaluated independently." | state.md |
| S2 | 多部分内容用对象，每部分起有名字的键 | "Use an object for most requests so each part of the state has a descriptive name and its relationships remain clear." | state.md |
| S3 | 需要相互比较的信息放在同一个 state 里 | "Put related information together when the decision requires comparing those parts." | state.md |
| S4 | 内容放 state，判断放问题 | "The state contains the content and supporting facts. Questions define the judgments the model should make about that material." | state.md |
| S5 | 只放与本次问题相关的内容，避免干扰和 context rot | "Include only the context relevant to the current questions. This helps the model avoid distractions and context rot." | how-to-build |
| S6 | 无关内容越多，准确率越低；先在代码里过滤 | "Accuracy falls as the state grows with content unrelated to the decision." / "**Instead:** retrieve and filter in code first, and send only the fields the question needs." | jaggedness |
| S7 | 只收文本 | "Jev accepts text only. State must be a string, JSON object, or array of text values." | state.md |
| S8 | state 是数据，模型默认不把它当作敌意内容；写明确的 criteria | "State is data, and `jev-1.13` does not treat it as hostile by default." | jaggedness |
| S9 | Clef：长文本 state 会被截断 | "Long text state is truncated to fit the model's token limit." | Clef schema-input |

对本 mod 的含义（推断）：

- state 用对象，字段名直接描述含义：`user_message`、`recent_context`、`signals`、`brief`……问题里用反引号点名字段（见 2.2 Q6）。
- **把最关键的字段放在对象最前面**（`user_message` / `brief` 先于 `recent_context`）。JS 对象的字符串键按插入顺序序列化；如果 Clef 真的只读前约 2K token（第三方说法，见第 6 节），被截掉的是排在后面的上下文。
- 不发送文件内容和工具输出原文，与 jev-pilot 的做法一致（`J/hooks/context.ts:1-9`："Only message text and tool names travel, never a tool's input or output"）。
- state 里的用户文本可能带有试图左右判断的字句（S8）。路由判断的风险不高，但 criteria 要写得明确。

### 2.2 所有问题通用

| # | 规则 | 官方原文 | 来源 |
| --- | --- | --- | --- |
| Q1 | 一个问题只问一个「一秒钟能做出的」判断 | "Ask for a judgment a knowledgeable person makes in a second given the right context." | primitives.md |
| Q2 | 拆成最窄、最明确的原子问题（「本指南最重要的概念」） | "Ask the most explicit, narrow, specific, atomic questions you can." / "This is probably the most important concept in this guide." | how-to-build |
| Q3 | 问题 ID 不发给模型，完整语义写进 `instructions` | "Question IDs are for your code. They are not sent to the model. Write the complete question in `instructions`, even when the ID seems self-explanatory." | primitives.md |
| Q4 | 按字面理解：写出确切条件，边界情况放进 criteria | "`jev-1.13` answers the question you wrote, not the one you meant." / "**Instead:** state the exact condition in the `instructions`. Be specific. Put boundary cases in the criteria." | jaggedness |
| Q5 | 避免双重否定和多跳间接 | "Instructions carrying double negatives or complex indirection are answered less reliably." | jaggedness |
| Q6 | 用反引号路径点名 state 里的字段 | "Point questions at specific values when that removes ambiguity, and include the backtick characters around each path inside the question." | how-to-build |
| Q7 | instructions 与 criteria 不能互相矛盾 | "When the `instructions` and the `criteria` ask for different things, `jev-1.13` might get confused." | jaggedness |
| Q8 | 问题保持简短；需要背景、示例或代码提供的数据时用结构化对象，把问题放一个字段，数据放其他字段 | "Keep questions short." / "Put the question in one field and the data that guides the question in the others." / "Part of the question comes from your code. When a value comes from a database, put it in its own field instead of splicing it into a string template." | how-to-build |
| Q9 | 结构化字段名自定，模型看得到字段名，要短且能标明内容；同一问题的各选项/各档位用同一套字段名 | "The field names ... are not part of the API, and none are reserved. ... The model sees the names along with the values, so use short names that label what follows." / "Use the same field names across options so the model can compare them directly." | choice / how-to-build |
| Q10 | 同一 state 的独立问题放在同一请求里，几乎不增加延迟 | "Adding questions barely changes the response time and costs only the tokens for the extra questions, which are cheap. Asking a question you might not need is close to free." | primitives.md |
| Q11 | 可以问「投机性」问题，代码只取用得到的答案 | "Ask every question your code might need, including ones whose answer only matters for some inputs, and let the code decide which answers to use." | primitives.md |
| Q12 | 同请求里的问题互相看不到答案，批量问不改变答案 | "Questions in the same request are independent: one answer does not become context for another question." / cookbook 实测："no question's answer depends on the 12 other questions sharing its request" | primitives.md / parallel_questions |
| Q13 | 只有「必须先拿到第一次的答案才能构造第二次请求」时才发第二次；skill 推荐是官方点名的正当例子 | "Two requests are the exception, not the rule." / "[Skill suggestion] ranks 182 skills in one request, then fetches the full text of the top three and judges them again against that better evidence." | primitives.md |
| Q14 | 不要让模型算数、计数、比较日期 | "Jev is not a calculator." / "`jev-1.13` does not count reliably." / "reads dates as text, not as ordered quantities" | jaggedness |

### 2.3 Score

| # | 规则 | 官方原文 | 来源 |
| --- | --- | --- | --- |
| SC1 | criteria 是从低到高的有序数组，2–10 档 | "An ordered array of level descriptions, from the low end of the scale to the high end. Should have at least two levels; the API accepts up to 10." | score.md |
| SC2 | 模型只看描述，每档单独对照 state 评估 | "The model gets the descriptions and nothing else, and each level is judged on its own against the state." | score.md |
| SC3 | **写情境，不写程度** | "Describe situations, not degrees. \"Broken or degraded feature, but workaround exists\" gives the model something to match the state against. \"Moderately severe\" doesn't." | score.md |
| SC4 | 看不到编号和相邻档，「比上一档更严重」、数字都无效 | "Every level is evaluated separately. The model doesn't see a level's number or its neighbours, so \"worse than the previous level\" means nothing to it, and numbers in the descriptions or the instructions don't help." | score.md |
| SC5 | 只用能区分开的档数 | "Use as many levels as you can describe distinctly, up to 10. Three is fine. Don't add levels you can't describe distinctly." | score.md |
| SC6 | 一个 Score 只量一个维度 | "Keep each Score question to one dimension." | score.md |
| SC7 | 顶端罕见、需要不同处理的极端情况单独一档 | "If the top of your scale has a rare extreme case you need to act on differently, give it its own level." | score.md |
| SC8 | 用已知样例检验，置信度变高不代表描述更好 | "Check the answers against known examples; higher confidence alone does not show that a description is better." | score.md |
| SC9 | 同一量表的两种措辞在你的数据上表现可能不同 | "Two wordings of the same scale can behave differently on your data." | score.md |
| SC10 | 先用字符串；相邻两档总是分不开时才改成对象（描述 + 示例），各档字段名一致 | "Start with a basic text description for each level. When the model keeps scoring between two neighbouring levels on inputs you think are clear, give each level an object instead of a string ... Use the same field names on every level so the model can compare like with like." | score.md |
| SC11 | 示例只在像真实输入时才有用 | "Examples steer the model, and they only help when they look like your real inputs." | score.md |
| SC12 | `score` 是概率加权位置，可以落在两档之间；分布不同可能得到相同 score，要连同 `probabilities`、`confidence` 一起读 | "Different distributions can produce the same score. ... Read `probabilities` and `confidence` alongside the score to distinguish these cases." | score.md |
| SC13 | score 只适合与阈值比较，不能用来插值出精确数值 | "You can use the expectation to check if it passes a particular threshold, but `jev-1.13`'s score levels are weak in numerical calibration." | jaggedness |
| SC14 | 低置信度通常意味着：档位在此情形下重叠、问题量了不止一件事、或 state 信息不足 | "Low confidence on a Score usually means one of three things. The levels overlap for this state, the question is measuring more than one thing, or the state doesn't say enough to place it." | score.md |
| SC15 | HTTP 响应里 `probabilities`、`legend` 的键是**字符串**档位号；Python SDK 改成了整数键 | "`probabilities`: The probability of each level, keyed by level number as a string." / "The SDK keys `probabilities` and `legend` by integer level rather than by string." | score.md |

对 effort 的含义：

- effort 五档的**名字**（low…max）只存在于代码里，模型只看到每档的情境描述；index 0–4 与档位名一一对应。
- 「`max` 门槛最高」正好对应 SC7：给 `max` 写一个罕见、具体的情境，不要写成「比 xhigh 更难」。
- jev-pilot 0.4.12 的实测：「Examples on each level of the rating scale were tried and made things worse; they're not used.」（`J/CHANGELOG.md:154`）。与 SC11 并不矛盾（示例不像真实输入就没用甚至有害），但说明**加示例要当作评测变量**，不能默认加。`docs/research/decision-models-and-caching.md` §4.1 提出的「在 criteria 的 examples 里放中文样例」也属于这一类，需要评测。

### 2.4 Choice

| # | 规则 | 官方原文 | 来源 |
| --- | --- | --- | --- |
| C1 | 选项名和描述都发给模型，描述要能把选项彼此区分开 | "The option names and their descriptions are both sent to the model, so write descriptions that separate the options from each other." | choice |
| C2 | ≤255 个选项；给全列表，列表可能不全时加 `other` / `none of the above` | "A Choice question accepts up to 255 options, and adding options costs a few tokens each, so give the model the full list ... Add an `other` or `none of the above` option when the list might not cover every input" | choice |
| C3 | 两个选项容易混时，用对象写「覆盖什么 / 不覆盖什么（归邻近选项）/ 几个示例输入」 | "When two options are similar and the model keeps confusing them, describe each one with an object instead of a string. Give it fields for what the option covers, what belongs to a neighboring option instead, and a few example inputs." | choice |
| C4 | 名字自明的选项描述可以写 `null` | "The `tone` question uses `null` descriptions because the option names are clear on their own." | choice |
| C5 | **首项偏好**：选项顺序可能影响答案，`jev-1.13` 偏向第一个选项，要换序复核 | "In some cases, we observed that the order of a Choice's options can affect the answer, and `jev-1.13` leans toward the option that comes first. **Instead:** reorder the options to double check that the answer stays consistent." | jaggedness |
| C6 | 大分类体系按层用多个 Choice，每层可以把子树当选项值 | "To classify into a deep taxonomy, ask one Choice per level and walk the tree in code." | advanced |
| C7 | 大名单可以分块排序 | "One `Choice` question holds a roster this size comfortably. A few times larger and you would split it into chunks and rank each one, then run this same shortlist step over the winners." | skill_suggestion |
| C8 | 低置信度可能只是有几个都可以接受的选项 | "Several acceptable alternatives can also spread probability; low confidence need not invalidate a harmless preference choice." | 本机 SKILL.md |

### 2.5 Noul

| # | 规则 | 官方原文 | 来源 |
| --- | --- | --- | --- |
| N1 | 一个 Noul 只问一个是非题；两个条件拆成两个 | "Ask one yes/no question per Noul." | noul |
| N2 | 措辞让「高值 = 是」 | "Phrase the question so that a high value means yes." | noul |
| N3 | 陈述句和问句都可以 | "A statement works as well as a question." | noul |
| N4 | 是非边界要清楚；边界微妙时加 `criteria.true/false`，有无 criteria 都试一下 | "Make the boundary between yes and no unambiguous." / "try your questions with and without `criteria` and keep whichever gives better answers" | noul |
| N5 | criteria 的 true 必须对应「是」（反过来写会变差） | "a Noul where `true` maps to no and `false` maps to yes will perform worse." | jaggedness |
| N6 | 0.5 附近表示不确定，不表示「中等程度」；要量程度用 Score | "A Noul value of 0.5 means the model gives yes and no equal probability. It does not mean the candidate has a medium skill level." | primitives.md |
| N7 | 门槛取决于错误代价：两边代价相同用 0.5；误判「是」代价高就提高；漏判「是」代价高就降低；中间值可以交给人 | "Use 0.5 when yes and no are equally easy to act on. Raise it when acting on a false yes is expensive ... Lower it when missing a true yes is expensive" | noul |

### 2.6 Confidence

**公式（官方，https://docs.typesafe.ai/confidence.md）**：

- Choice（n 个选项，`p_max` 为最高概率）：`confidence = (p_max − 1/n) / (1 − 1/n)`。原文："Only the top probability counts, so (0.6, 0.3, 0.1) and (0.6, 0.2, 0.2) both have confidence 0.4."
  - n=3：`(3·p_max − 1) / 2`；n=4（加入 fable）：`(4·p_max − 1) / 3`。
- Score（n 档，`m` 为概率最高的档）：`confidence = max(0, 1 − Σ_i p_i·|i − m| / MAD_unif)`，`MAD_unif = (1/n)·Σ_i |i − (n−1)/2|`。
  - 5 档时 `MAD_unif = (2+1+0+1+2)/5 = 1.2`（官方 demo 原文："It divides that by 1.2, the same average for an even spread over five levels measured from the middle level"）。
  - 例：`(0, .05, .9, .05, 0)` → 1 − 0.1/1.2 ≈ 0.92；`(0, .55, .45, 0, 0)` → 1 − 0.45/1.2 ≈ 0.63；`(.55, 0, 0, 0, .45)` → 0。
  - 原文："Probability on a neighboring level lowers confidence less than the same probability on a level further away."
- Noul：不返回 confidence。原文："The probability already carries the uncertainty"。需要统一量纲时用 `|2p − 1|`。

**两个替代指标（官方明确推荐试用）**："Two simpler measures, computed from the same `probabilities`, are often very effective in practice and are worth trying alongside `confidence`":

- **Top probability** `p_max`："Its meaning depends on the number of options ... so set its threshold per question."
- **Top-to-second ratio** `p_max / p_second`："Many real decisions come down to the top two candidates, and this ratio targets exactly that."

**门槛怎么定（官方）**：

- "A confidence threshold is not one number. Different actions within the same system should be gated at different levels depending on the consequences of getting it wrong."
- "The correct threshold values depend on your domain and the performance of the model for your use case. Start with conservative thresholds, test with your own data, and adjust as you observe results."
- "Test thresholds by plotting confidence against accuracy on your data."（how-to-build）
- 三段式："High confidence: Act automatically." / "Medium confidence: Proceed with caution." / "Low confidence: Do not act."
- "Choice/Score confidence summarizes distribution concentration, not overall workflow correctness or permission to act." / "Ignore uncertainty on unused branches."（本机 SKILL.md）
- 官方示例里出现过的数值（都只是示例）：`< 0.5` 转人工（confidence.md、intent-routing）；`< 0.6` 下限、`> 0.85` 才自动执行高风险操作（confidence-routing）；`> 0.9` 自动转账（confidence.md）；`< 0.3` 转人工分拣、`< 0.5` 先问客户（choice 页）；`< 0.8` 转人工复核（how-to-build）；skill cookbook 的 `GATE_THRESHOLD = 0.30`、`FITS_THRESHOLD = 0.30`。
- 版本固定："If you have tuned confidence thresholds against a specific version, pin that version's ID instead of the alias and move to the new one on your own schedule."（models.md）

**映射到 spec 的门槛（推断，起点值待评测校准）**：

| spec 门槛 | 读哪个字段 | jev-pilot 的实测起点 |
| --- | --- | --- |
| θ_max（用 `max` 需要它的概率达到） | `answers.effort.probabilities["4"]`（归一化后） | jev-pilot 用「xhigh+max 合计 ≥ 0.6」才进入 xhigh 以上（`VERY_HARD_CONFIDENCE`，`J/hooks/model-router.policy.ts:513`） |
| θ_up（升档） | Score `confidence`，或目标档的 top probability / top-to-second ratio | 升到 medium：0.3；升到 high 及以上：0.5（`minUpgradeConfidence` / `minHighConfidence`，同文件 `:671-703`，CHANGELOG 0.4.14 实测） |
| θ_down（降档，高于 θ_up） | 同上 | 0.6（`minDowngradeConfidence`） |
| 推翻主 agent 指定的模型 | 模型 Choice 的 `confidence` + 4.2 节的 `requested_fits` Noul | jev-pilot 子 agent 降级需 0.6 |
| skill 最低相关度 | 第二段 `fits.i` 的 `noul` | cookbook 0.30 |

注意：spec 要求门槛按语言分别校准；官方 models.md 也要求非英语工作负载「pay close attention to Confidence when routing」。

### 2.7 语言

**官方说法（全部原文）**：

- models.md「Language support」："Jev accepts natural-language text. English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; test on your own content before relying on Jev for a non-English workload, and pay close attention to [Confidence](/confidence) when routing."
- state.md："Jev's primary training language is English; other languages, including CJK scripts, are accepted but currently have lower accuracy"
- **问题（instructions / criteria）该用英文还是中文：官方没有说明（未文档化）。** 官方也没有任何中文或多语言准确率数字。
- Clef：模型页、schema、changelog 都没有语言声明（未文档化；基座 Qwen 的情况见既有调研 §4.2）。

**第三方**：

- jev-fanout-bench（https://huggingface.co/datasets/lisonallen/jev-ai-benchmark ，本次复核原文）："Keep the questions in English even when the text is not: translating the questions as well as the text cost 9–48% more tokens and moved yes/no answers further from the English baseline in all seven languages we tried." 同页实测每个计费 token 对应字符数：English 4.92、Chinese 1.00、Japanese 1.01、JSON 2.4。
- jev-pilot：所有问题都用英文写；它对中文的处理只在自己的启发式规则里（判断短跟进、是否疑问句、长度换算），见 5.6 节。

**建议（推断）**：默认「英文 instructions / criteria + 中文原文 state」；按 spec #70 把问题语言做成评测变量。skill 画像（#11）的 criteria 用英文、中文还是中英双语，也做成评测变量（双语会多花 token，中文约 1 token/字）。

### 2.8 jev-1.13 的已知短板（与本 mod 相关的部分）

官方列表（jaggedness 页）与对策：

| 短板 | 对本 mod 的影响 | 对策 |
| --- | --- | --- |
| Literal reading | effort 问题如果只写「难不难」，会按字面读主题的严重程度 | 写明「Rate the work, not how important the topic sounds」（jev-pilot 实测有效） |
| Math and Numbers / Math using score | 不要让模型从 `score` 插值出「需要 2.7 档」 | 用 `probabilities` 加阈值，在代码里决定档位 |
| Large state | 上下文给多了反而不准 | 上下文条数和 token 预算按评测扫描结果定（spec #71） |
| Choice option order | 模型 Choice、skill Choice 都受影响 | 固定顺序 + 换序评测 + 可选的倒序重复问 |
| Indirection | 「主 agent 选的模型是否合适」这种多跳问题 | 把主 agent 指定的模型做成结构化数据，单独问一个 Noul（见 4.2） |
| Adversarial content | 用户消息里的文字可能左右路由 | criteria 写明确；路由失败的代价有限 |

---

## 3. 接口：Jev 与 Clef 的确切结构

### 3.1 Jev（TypeSafe System One）

**端点（官方 api.md）**：

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

**请求体**：

| 字段 | 类型 | 必填 | 说明（官方） |
| --- | --- | --- | --- |
| `state` | `string \| object \| array` | 是 | 要评估的内容 |
| `model` | `string` | 是 | `"jev-latest"`（别名，现指 `jev-1.13.0`）、`"jev-preview"`、`"jev-1.13.0"`。第三方实测：`"jev-1.13"` 返回 HTTP 400 "Unknown model: jev-1.13"，虽然官方 jaggedness 页的示例就是这么写的；缺 `model` 返回 422 |
| `questions` | `map<string, Question>` | 是 | 键由调用方定，"The key is not sent to the underlying model and is not used in inference." 条数没有文档化上限；第三方称「只受 token 预算限制」 |

**Question**（三种类型都有 `type` 和必填的 `instructions`）：

| 类型 | `instructions` | `criteria` |
| --- | --- | --- |
| `noul` | 必填，`string \| object \| array` | 可选，`{ "true"?: string\|object\|array, "false"?: string\|object\|array }` |
| `choice` | 必填 | 必填，`map<string, string \| object \| array \| null>`，"You can have a maximum of 255 options per Choice." |
| `score` | 必填 | 必填，`array<string \| object \| array>`，"A Score should have at least two levels; the API accepts up to 10." |

Advanced 页说 instructions 也接受 `null`，但 API 页标为必填、Clef 要求非空。**一律不要发 `null` instructions。**

**响应体（官方）**：

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent":   { "type": "noul", "noul": 0.95 },
    "department":  { "type": "choice", "choice": "billing",
                     "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
                     "confidence": 0.81 },
    "frustration": { "type": "score", "score": 1.05,
                     "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
                     "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
                     "confidence": 0.92 }
  },
  "usage": { "input_tokens": 304, "output_tokens": 18 }
}
```

（上面是把官方 API 页三个示例拼在一起的示意。）字段含义：

- `model`：实际作答的版本号（即使发的是别名）。
- Noul：`noul` ∈ [0,1]，"The yes/no answer on a scale from 0 (no) to 1 (yes)."，**没有** `confidence`。
- Choice：`choice` = 概率最高的选项；`probabilities` 覆盖全部选项，"floats that sum to 1"；`confidence`。
- Score：`score` = 概率加权位置；`legend` 档位号→描述（criteria 用对象时，legend 的值也是对象，所以 API 页写的 `map<string,string>` 类型不准，按 unknown 解析）；`probabilities` 档位号（字符串）→概率；`confidence`。
- `usage.input_tokens` / `output_tokens`（只按输入计费）。官方示例里的概率保留两位小数，加起来不一定恰好为 1，用之前先归一化（推断）。
- 响应头 `x-typesafe-request-id`（Python SDK 的 `TypeSafeAPIError.request_id` 读的就是它），可写进 debug log。

**上下文与速率（官方 models.md）**："64k tokens per request; 32k tokens for `state` plus the longest question"；"The 64k budget covers the `state` plus all questions combined; the 32k budget applies to the `state` plus the single longest question."；"100K tokens per second / 80 requests per second"，并且 "Rate limits are adjusting dynamically ... can change without notice"。第三方实测：32,204 输入 token 通过，约 33,600 被拒（HTTP 400 `max_tokens_exceeded`）。

### 3.2 Clef（Cloudflare Workers AI）

**端点（官方模型页的 Python/curl 示例）**：

```http
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef
Authorization: Bearer <CLOUDFLARE_AUTH_TOKEN>
Content-Type: application/json        ← 官方 curl 示例没写，建议显式带上
```

clef-flash：路径换成 `@cf/cloudflare/clef-flash`，`model` 换成 `"clef-flash"`。Token 从 Dashboard → Workers AI → Use REST API → Create a Workers AI API Token 获取，官方说这是 "an API token that grants Workers AI read permissions to your account"；第三方说手工建 token 要同时给 `Workers AI - Read` 和 `Workers AI - Edit`。

**请求体（官方 schema-input.json，逐条）**：

| 字段 | 约束 |
| --- | --- |
| `model` | `string`，**必填**，`pattern: ^\s*(clef\|clef-flash)\s*$`。路径里已有模型名，body 里仍然必须填。第三方：填 `jev-latest` 会失败，错误码 5006（字段不匹配 pattern） |
| `state` | 必填。"a string, or structured data (object/array) such as records, chat logs, or application state. Long text state is truncated to fit the model's token limit." |
| `questions` | `object`，必填，`minProperties: 1`，`maxProperties: 64`。"ids may use letters, digits, '_', '.', '-' (max 100 chars)" |
| Noul | `required: [type, instructions]`；instructions："a non-empty string, or an object/array that holds the question in one field and referenced data in others"；`criteria.true/false` 可选 |
| Choice | `required: [type, instructions, criteria]`；criteria："Map of option id (non-empty string) to its description: string, object, array, or null when no detail is needed. 2 to 255 options." |
| Score | `required: [type, instructions, criteria]`；criteria：`minItems: 2`、`maxItems: 10`，"lowest first; levels are indexed from 0" |
| `images` | Clef 扩展，本 mod 不用。最多 4 张 PNG/JPEG/WebP，data URL 或 `{content_type, base64}`；"whole request body max 13 MiB"；不接受远程 URL |

**响应**：

- 模型输出（官方 schema-output.json）：`required: [model, answers, usage]`；三种答案的必填字段与 Jev 相同（Noul `type, noul`；Choice `type, choice, probabilities, confidence`；Score `type, score, legend, probabilities, confidence`）；`usage.input_tokens / output_tokens` 必填。
- **REST 外壳**：REST 入门页的通用格式（官方）：

  ```json
  { "result": { ... }, "success": true, "errors": [], "messages": [] }
  ```

  第三方实测的 Clef REST 原始输出（Flavio Copes，clef-flash）：

  ```json
  {
    "result": {
      "model": "clef-flash",
      "answers": {
        "category": { "type": "choice", "choice": "bug_report",
                      "probabilities": { "bug_report": 0.9664, "feature_request": 0.0135, "billing": 0.0058, "other": 0.0143 },
                      "confidence": 0.9126 },
        "severity": { "type": "score", "score": 1.1069,
                      "legend": { "0": "Cosmetic; no impact on functionality", "1": "Broken or degraded feature, but a workaround exists", "2": "Blocking issue; no workaround exists" },
                      "probabilities": { "0": 0.0636, "1": 0.766, "2": 0.1704 },
                      "confidence": 0.4298 },
        "has_repro_steps": { "type": "noul", "noul": 0.5355 }
      },
      "usage": { "input_tokens": 395, "output_tokens": 0 }
    },
    "success": true,
    "errors": [],
    "messages": []
  }
  ```

  原文："The REST API wraps the answer in Cloudflare's usual envelope, with `success`, `errors` and `messages`, so the Jev-shaped part lives under `result`. Also, `model` says `clef-flash`, with no version number." 另外：每次响应都报 `"output_tokens": 0`。
- **失败外壳（官方 Cloudflare OpenAPI `api-response-common-failure`）**：`required: [success, errors, messages, result]`；`success` 为 `false`；`errors` 至少一项，每项 `{code: integer ≥1000, message: string, documentation_url?, source?: {pointer?}}`，示例 `{code: 7003, message: "No route for the URI"}`；`result: null`。第三方的同类测试桩也按 `{ success: false, errors: [{ code: 5007, message: "No such model" }], result: null }` 处理。
- **Worker 绑定**（`env.AI.run()`）直接返回无外壳的 `{model, answers, usage}`。本 mod 走 REST，不涉及。

### 3.3 Jev 与 Clef 的差异对照

| 项 | Jev | Clef |
| --- | --- | --- |
| URL | `https://api.typesafe.ai/v1/systemone` | `https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef` |
| 凭据 | TypeSafe API key | Cloudflare account ID + Workers AI API token |
| `model` | `jev-latest` / `jev-1.13.0` / `jev-preview` | 必须是 `clef` 或 `clef-flash`（与路径一致） |
| 响应位置 | 顶层 `answers` | `result.answers`，先检查 `success` |
| 响应 `model` | 带版本（`jev-1.13.0`） | 不带版本（`clef` / `clef-flash`） |
| 问题数 | 未文档化（受 token 预算限制） | 1–64 |
| 问题 ID 字符 | 未文档化 | `[A-Za-z0-9_.-]`，≤100 |
| Choice 选项 | ≤255 | 2–255 |
| Score 档位 | 2–10 | 2–10 |
| 上下文 | 64k / 32k（state + 最长问题） | 标称 65,536；第三方称 state 实际只读约前 2K token（待评测） |
| 价格（输入） | $0.042/M | clef $0.24/M，clef-flash $0.09/M |
| 速率 | 80 req/s、100K tok/s（动态） | 按 Text Generation 类推断 300 req/min（专属限额未文档化） |
| 图片 | 不支持 | 支持（本 mod 不用） |

结论：**一个统一的请求拼装函数可以同时服务两个后端**，后端层只负责换 URL、头、`model` 字段，以及剥/不剥 `result` 外壳。前提是拼装函数按两家规则的交集来写：问题 ID 用 `[A-Za-z0-9_.-]`，问题 ≤64 个，Choice 选项 2–255 个，instructions 永远是非空内容。

### 3.4 错误码与重试建议

**Jev（官方 api.md）**：

| 状态 | 官方含义 | 处理（推断） |
| --- | --- | --- |
| 401 | Missing or invalid API key | 配置错误：状态行提示密钥无效，不重试 |
| 422 | 请求体校验失败，"The body details the offending field." | 本 mod 的 bug：记录响应体前 200 字（jev-pilot 做法），不重试 |
| 429 | 超出速率限制，"Back off and retry after a short delay." | 「忙」：本轮放行，安静记录 |
| 529 | 服务过载，"Retry after a short delay." | 同上 |

官方："When you receive a `429 Too Many Requests` or `529 Overloaded` response, retry the request with exponential backoff instead of retrying immediately." 第三方实测补充：错误体是 `{"detail": ...}`；401/403 `authentication_error`；400 `api_usage_error`（"Invalid request."，例如未知问题类型；"Unknown model: …"）；400 `max_tokens_exceeded`（state 太大）；422 "Field required"。Python SDK 还定义了 400/403/404/5xx 的异常类（官方 exceptions 页）。

**SDK 默认重试与超时（官方）**：Python `RetryPolicy(max_retries=2, backoff_initial=0.5, backoff_max=5.0, backoff_jitter=0.25, http_statuses={408, 429, 500–599}, respect_retry_after=True, timeout=30.0)`，`DEFAULT_TIMEOUT = 10.0` 秒；JS `timeout` 默认 10000 ms（"Timeout per attempt in milliseconds, without a total retry budget"），`maxRetries` 2，`backoffInitialMs` 500，`backoffMaxMs` 5000，`httpStatuses` 408、429、500–599，`maxRetryAfterMs` 60000，并识别 `Retry-After` 与 `retry-after-ms` 头。这些默认值是给批处理脚本用的；mod 每个 hook 只有 10 秒，而且路由要求失败即放行，不能照搬。

**Clef / Workers AI（官方错误码页）**：

| 内部码 | HTTP | 含义 | 处理（推断） |
| --- | --- | --- | --- |
| 5007 | 400 | No such model | 配置/拼写错误，不重试 |
| 3042 | 404 | Invalid model ID | 同上 |
| 3003 | 400 | Request is missing headers or body | bug，不重试 |
| 5004 | 400 | Invalid data type for base64 input | 不涉及（不发图片） |
| 3006 | 413 | Request is too large | 缩小 state 或 skill 列表 |
| 5018 / 3041 | 403 | 账号无权访问该模型 | 配置错误 |
| 3023 | 403 | Service unavailable for account | 配置错误 |
| 5035 | 403 | This model requires a Workers Paid plan | 配置错误（Clef 页没写需要 Paid） |
| 3007 / 3008 | 408 | Request timeout / aborted | 「忙」 |
| **3036** | 429 | "You have used up your daily free allocation of 10,000 neurons." | **当天不要再重试**，状态行明确提示额度用尽 |
| **3040** | 429 | "Capacity temporarily exceeded, please try again." | 「忙」，可稍后再试 |

第三方补充：`model` 不匹配 pattern 时返回内部码 **5006**；图片过大时报 `exceeded this model context window limit (65536)`。同样是 HTTP 429，3036 和 3040 的处理完全不同，必须读 `errors[0].code`，不能只看状态码。

**热路径策略（推断，与 spec「失败或超时一律放行」一致）**：

- 不做内联重试。一次请求、一个超时，失败就放行并写状态行。
- 「忙」类（Jev 429/502/503/529、Clef 3040/3007/3008）：安静记录到 debug log，状态行轻提示。jev-pilot `missOf` 把 429/502/503/529 归为 busy（`J/hooks/model-router.policy.ts:994-1004`）。
- 「配置」类（401/403、5007/3042/5035/3023、3036）：状态行醒目提示，并且同一会话只提示一次（jev-pilot 对缺 key 也只提示一次）。
- 「bug」类（422、5006、3003、Jev 400 `api_usage_error`）：把请求的问题 ID 和响应体片段写进 debug log，方便评测脚本复现。
- 解析失败（缺 `answers`、答案 `type` 与问题不符、Choice 的 `choice` 不在选项里）一律按失败处理（jev-pilot `readDecision` 的做法）。

### 3.5 超时建议

延迟参考：

| 来源 | 数字 |
| --- | --- |
| TypeSafe 官方（how-to-build） | "Most queries complete in about 100 ms." |
| Cloudflare 官方（43 项基准，含公网往返） | Jev 中位 524.1 ms / p95 536.0 ms；Clef 209.3 / 238.6 ms；clef-flash 38.8 / 122.4 ms |
| 第三方（Flavio，意大利经 REST） | clef-flash 中位 191–205 ms，最慢 676 ms；Clef 中位 524–726 ms，单次最慢约 3 s |
| 第三方（jevaiguide） | 一次 3 题请求 539 ms；一次 20 个 Noul 332 ms，与一次 1 个相同 |
| jev-pilot README | 典型约 0.5 s；实测中位 540 ms、p90 910 ms，97% 的轮次拿到答复 |

建议（推断）：

- 用户发消息时的首次判断（`prompt.submit`）：默认超时 **1500 ms**（jev-pilot 默认值，`J/hooks/jev-model-router.ts:226`；P2 用 800 ms），可配置。
- 中途预判（工具开始执行时就发出）：预算是工具的执行时间；到下一次 `turn.step` 时如果还没回来，再等一个很短的上限（例如 300 ms，可配置）就沿用上一步的 effort，并在状态行提示。spec 的评测标准「延迟 p90 小于工具的平均执行时间」可以直接用来定这个上限。
- 派出 agent：每个派发一次请求，超时同首次判断。
- skill 两段排序是串行两次请求，总预算要覆盖两段；第二段超时就只推荐第一段的结果，或者什么都不推荐（jev-pilot 的选择是「第二段尝试过但失败就不推荐」，`J/hooks/skill-suggestion.policy.ts:785`）。
- 第三方实测：新建 HTTPS 连接约 1,630 ms，复用连接时 1K token 的请求约 375 ms（既有调研 §1.5）。`$.http.fetch` 是否复用连接需要实测；如果不复用，首个请求会明显偏慢。

### 3.6 解析骨架（TypeScript 类型 + 伪代码，供实现参考）

```ts
type NoulAnswer   = { type: 'noul'; noul: number }
type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
type ScoreAnswer  = { type: 'score'; score: number; legend: Record<string, unknown>; probabilities: Record<string, number>; confidence: number }
type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer
type SystemOneResult = { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }
type CfMessage = { code: number; message: string }
type CfEnvelope<T> = { result: T | null; success: boolean; errors: CfMessage[]; messages: CfMessage[] }

// 后端层：只负责剥外壳和分类错误
function unwrap(backend: 'jev' | 'clef', status: number, body: unknown):
  { ok: true; result: SystemOneResult } | { ok: false; kind: 'busy' | 'config' | 'quota' | 'bug'; detail: string } {
  if (backend === 'jev') {
    if (status >= 200 && status < 300 && isResult(body)) return { ok: true, result: body }
    // 401 → config；422/400 → bug；429/502/503/529 → busy
  } else {
    const env = body as CfEnvelope<SystemOneResult>
    if (status >= 200 && status < 300 && env?.success === true && isResult(env.result)) return { ok: true, result: env.result }
    // 读 env.errors[0]?.code：3036 → quota；3040/3007/3008 → busy；5006/3003 → bug；5007/3042/5035/3023/401/403 → config
  }
}

// Score：按档位下标读，不要读 legend（legend 会回显 criteria 对象）
function scoreProbs(a: ScoreAnswer, levels: number): number[] {
  const raw = Array.from({ length: levels }, (_, i) => a.probabilities[String(i)] ?? 0)
  const sum = raw.reduce((x, y) => x + y, 0)
  return sum > 0 ? raw.map((p) => p / sum) : raw   // 官方示例两位小数，Clef 四位小数，先归一化
}
```

校验（推断）：答案的 `type` 必须与问题一致；Choice 的 `choice` 必须是本次发送的选项之一；Score 的概率键必须是 `"0"`…`"n-1"`；缺任何一个**本次要用到的**答案就判为失败（用不到的投机性答案缺了无所谓）。

---

## 4. 三份示例请求（英文问题，按官方写法起草）

三份都写成 Jev 请求体。换成 Clef 时只改三处：URL、`Authorization`、`"model": "clef"`（或 `"clef-flash"`），问题部分不变。示例里的中文用户消息是虚构的。

### 4.1 (a) 主 agent 本轮 effort：5 档 Score

```json
{
  "model": "jev-latest",
  "state": {
    "user_message": "登录接口偶发 502，日志里只有 upstream timeout，帮我查一下原因并修掉",
    "recent_context": "assistant: 已部署到 staging，健康检查通过。要我继续处理告警吗？ [tools: Bash]",
    "signals": {
      "prompt_chars": 117,
      "files_mentioned": 0,
      "has_code_or_error": true,
      "is_question": false,
      "recent_tools": { "edits": 0, "commands": 3, "reads": 2, "subagents": 0, "failed": 1 }
    }
  },
  "questions": {
    "effort": {
      "type": "score",
      "instructions": {
        "question": "How much step-by-step reasoning does the work that `user_message` asks for need, given `recent_context`?",
        "rate": "Rate the work the request asks for, not how important its topic sounds. Advice or an explanation given in words, even about architecture or security, is not design work.",
        "short_replies": "When `user_message` only approves, continues or picks an option (such as \"go ahead\", \"1\", \"继续\"), rate the work it approves, as described at the end of `recent_context`."
      },
      "criteria": [
        "Answered from what is already known, or mechanical work with nothing to work out: a lookup, a single command, a rename or find-and-replace (even across many files), a search that lists what it finds, formatting, a one-line change.",
        "An ordinary, well-specified change to one or a few files, or a direct question about code already in view.",
        "A change across several files that needs working out, a bug whose cause is described but has to be traced, writing tests, or reviewing a diff with care.",
        "Design across several components, a bug whose cause is unknown, a refactor with many dependents, or careful reasoning about concurrency, performance or failure modes.",
        "Novel architecture, a security or data-integrity question, a failure that resisted earlier attempts, or work where a subtle mistake is costly and hard to undo."
      ]
    }
  }
}
```

写法依据：

- 五档描述取自 jev-pilot 实测过的 `EFFORT_RUBRIC`（`J/hooks/model-router.policy.ts:202-208`），每档都是可以对照的「工作情境」（SC3），没有数字、没有「比上一档更……」（SC4），也没有出现档位名 low…max。
- `max` 档写成罕见的极端情境，单独成档（SC7），对应 spec「max 门槛最高」。
- `rate` 字段取自 jev-pilot `EFFORT_INSTRUCTIONS`（`:279-280`），作者在 76 条标注请求上实测：只评主题会把 26 个 medium 任务里的 8 个评成 xhigh，加上这句后错 2 档以上的次数从 19 降到 9（`J/CHANGELOG.md:149-152`）。jev-pilot 原句写的是「is low or medium」，这里改成「is not design work」，因为 Score 里模型看不到档位名（SC4）。
- 问题用结构化对象，问题本身放在 `question` 字段，补充规则放在其他字段（Q8），并用反引号点名 state 字段（Q6）。
- 只问一个维度：需要多少逐步推理（SC6）。「这件事有没有风险」「需不需要动手」这类判断要另开问题（Q2）。

读取方式：

```ts
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const          // 下标即 criteria 下标
const a = res.answers.effort as ScoreAnswer
const p = scoreProbs(a, 5)                                                  // [p_low, …, p_max]
const top = p.indexOf(Math.max(...p))                                       // 并列时取较高档（jev-pilot 的做法）
const conf = a.confidence                                                   // 或用 1.2 公式自己算
const pMax = p[4]                                                           // θ_max 读这里
const veryHard = p[3] + p[4]                                                // jev-pilot：≥0.6 才进 xhigh 以上
```

示意响应（非真实输出）：`{"type":"score","score":2.31,"probabilities":{"0":0.0,"1":0.08,"2":0.55,"3":0.35,"4":0.02},"confidence":0.6,"legend":{...}}` → top 是 index 2（high），`p_max=0.02` 远低于 θ_max，`xhigh+max=0.37 < 0.6`，所以不进 xhigh。升降档、`K` 步内不降档等防抖逻辑都在代码里做。

**中途重判的变体**（spec #16–#23）：state 换成 `{ "turn_request": <本轮用户消息>, "recent_steps": <最近几步摘要：工具名、是否失败、助手文字片段>, "trouble"?: "2 tool calls in a row have failed while working on this request" }`；问题改成 "How much step-by-step reasoning does the remaining work on `turn_request` need, given `recent_steps`?"；**criteria 不变**，这样整轮的档位可以直接比较。`trouble` 这个字段的写法来自 jev-pilot（`J/hooks/jev-model-router.ts:696-708`）。

与 spec 的一处张力：spec #20 要求中途判断时让决策模型看到「当前 effort」。但按 SC2/SC4，模型看不到档位名和编号，state 里写一个「current_effort: high」，它没法拿来和五档描述对照，只会起锚定作用（推断）。建议：state 里不放当前 effort，滞回和防抖都在代码里做；如果一定要放，就作为评测变量比较放与不放。

**Score 还是 Choice（待评测）**：spec 要求用 Score。jev-pilot 0.4.13 把 effort 从 0–4 的 Score 改成五个具名选项的 Choice，在 76 条标注请求上「answers off by two or more levels went from 8-9 to 5 across two runs, medium tasks answered right from 7 to 10 of 26, and the misses are balanced instead of mostly too high」（`J/CHANGELOG.md:144`）。不过它当时的 Score 档位写法未知，而且 Choice 有首项偏好（C5）。建议评测阶段在**同一请求**里同时问 `effort`（Score）和 `effort_choice`（Choice，选项键 low…max、描述同上），两者互不影响（Q12），几乎不增加延迟（Q10）；用评测数据决定线上读哪一个。

### 4.2 (b) 派出 agent：模型 Choice + effort Score，同一请求

```json
{
  "model": "jev-latest",
  "state": {
    "brief": {
      "description": "查登录 502 的根因",
      "agent_type": "general-purpose",
      "prompt": "Investigate the intermittent 502 on POST /login. Read src/server/proxy.ts and deploy/nginx.conf, find why the upstream times out, fix it, and run `npm test -- proxy`. Report the root cause and the diff."
    },
    "user_message": "登录接口偶发 502，日志里只有 upstream timeout，帮我查一下原因并修掉"
  },
  "questions": {
    "model": {
      "type": "choice",
      "instructions": {
        "question": "Which option is the cheapest kind of model that can carry out `brief` well?",
        "focus": "Judge the work that `brief.prompt` asks for: what has to be read, decided, written and checked."
      },
      "criteria": {
        "read_and_report": {
          "choose_for": "Read-only lookups where a mistake is cheap to spot: search or list files, find where something is defined, read files, logs or test output and report what is there, run a command and report the result.",
          "not_for": "Anything that writes or changes files, or that needs a judgment call."
        },
        "specified_work": {
          "choose_for": "Read-only work that needs understanding (summarize or explain code, research across many files, review a diff and report the findings), and code changes with a clear spec and a way to check the result: a bug whose cause is known, a feature to a written spec, tests for existing code, a scoped refactor.",
          "not_for": "Design, an open spec, a bug whose cause is unknown, or long work across many components."
        },
        "judgment_work": {
          "choose_for": "Work that needs careful judgment or runs long: design, a change whose spec is open or that nothing can check, a bug whose cause is unknown, long multi-step work across many components, security, data migrations, production or money.",
          "not_for": "Mechanical or well-specified work that a written plan and a test already cover."
        }
      }
    },
    "effort": {
      "type": "score",
      "instructions": {
        "question": "How much step-by-step reasoning does a subagent need to carry out `brief`?",
        "execution": "A brief that already names the files, the steps and the tests has done the design: carrying it out is execution. Rate higher only when the brief itself asks for design, an unknown cause, or reasoning that is not already written out.",
        "rate": "Rate the work, not how important the topic sounds: reviewing a small diff is ordinary work, even for security."
      },
      "criteria": [
        "Answered from what is already known, or mechanical work with nothing to work out: a lookup, a single command, a rename or find-and-replace (even across many files), a search that lists what it finds, formatting, a one-line change.",
        "An ordinary, well-specified change to one or a few files, or a direct question about code already in view.",
        "A change across several files that needs working out, a bug whose cause is described but has to be traced, writing tests, or reviewing a diff with care.",
        "Design across several components, a bug whose cause is unknown, a refactor with many dependents, or careful reasoning about concurrency, performance or failure modes.",
        "Novel architecture, a security or data-integrity question, a failure that resisted earlier attempts, or work where a subtle mistake is costly and hard to undo."
      ]
    },
    "requested_fits": {
      "type": "noul",
      "instructions": {
        "requested_kind": {
          "choose_for": "Read-only work that needs understanding (summarize or explain code, research across many files, review a diff and report the findings), and code changes with a clear spec and a way to check the result: a bug whose cause is known, a feature to a written spec, tests for existing code, a scoped refactor.",
          "not_for": "Design, an open spec, a bug whose cause is unknown, or long work across many components."
        },
        "question": "Is the work that `brief` asks for within what `requested_kind` covers?"
      }
    }
  }
}
```

写法依据与使用方式：

- **选项键用「工作形态」而不是模型名**，代码里再映射成 `haiku / sonnet / opus`：选项名会发给模型（C1），官方要求名字「label what follows」（Q9）。jev-pilot 也特意把档位写成「工作的形态而不是模型名」（`J/hooks/model-router.policy.ts:185-194` 的注释，不过它的描述开头仍然写了 "Haiku." 等）。直接用模型名当键也可以，作为评测变量。
- 三档描述取自 jev-pilot 0.12.0 的 `TIER_CRITERIA`，它在 40 条真实子 agent brief 上实测过（`J/CHANGELOG.md:10-13`）。这里拆成 `choose_for` / `not_for` 两个字段，是官方处理易混选项的写法（C3），各选项字段名一致（Q9）。
- 配置里加入 fable 时，增加第四个选项（例如 `frontier_work`），字段同样是 `choose_for / not_for`。描述要按 Anthropic 官方对 Fable 的定位来写，**本笔记不替它编写**。
- **选项顺序**：固定按便宜到贵排列（与 jev-pilot 的 `TIER_ORDER` 一致）。首项偏好（C5）会让答案偏向 `read_and_report`，所以：(1) 评测时跑全部排列，量化顺序敏感度；(2) 如果敏感度明显，在同一请求里再问一个选项倒序的 `model_rev`，两者概率取平均（推断，成本只是多一份 criteria 的 token）。
- **effort** 的问法取自 jev-pilot `SUBAGENT_EFFORT_INSTRUCTIONS`（`:270-271`）。作者实测：14 条真实的 builder/fixer brief，用通用问法有 10 条被评成 xhigh，用这个问法只有 1 条（`:263-269` 注释）。原句里的「is medium」改成了「is ordinary work」，理由同 4.1。
- **主 agent 指定的模型**（spec #34「作为强提示交给决策模型」）：不要放进 state。放进 state 的话，所有问题都看得到它，`model` 这道题会被锚定（推断）。官方做法是把代码提供的数据放进**单个问题的结构化 instructions**（Q8；noul 页的 `potential_duplicate` 示例就是这么做的）。所以单独问一个 `requested_fits` Noul，把被指定档位的描述原样放进去。只有主 agent 指定了模型时才加这道题。
- **代码里的优先级**（spec #33/#34）：
  1. 用户本轮消息明确点名了模型：代码直接采用，不用决策模型推翻。是否「明确点名」先用规则判断（中英文模型名 + 「用/换成/run on」之类）；如果要判断「让子代理用便宜点的模型」这种模糊说法，可以加一个投机 Noul，作为评测项。
  2. 主 agent 指定了模型：默认保留。只有在 `requested_fits.noul < θ_fit`、`model.choice` 与指定的不同、并且 `model.confidence ≥ θ_override` 三个条件都满足时才推翻。
  3. 都没有指定：按 `model.choice` + 升降级门槛（降级门槛更高，与 jev-pilot `allowed()` 相同，`:722-742`）。
- 选中 `read_and_report`（haiku）时，**整个 effort 答案都不用**（spec #32），它的不确定性也不用理会（"Ignore uncertainty on unused branches."）。
- state 不带对话上下文，只带 brief 和用户本轮消息。jev-pilot 只发 `{prompt, description, agentType}`，原因是「A subagent's brief is self-contained by design」（`J/hooks/jev-model-router.ts:1099-1110`）；spec #30 额外要求带上用户本轮消息。

读取方式：

```ts
const KIND_TO_MODEL = { read_and_report: 'haiku', specified_work: 'sonnet', judgment_work: 'opus' } as const
const m = res.answers.model as ChoiceAnswer
const pick = KIND_TO_MODEL[m.choice as keyof typeof KIND_TO_MODEL]       // 不在表里 → 解析失败 → 放行
const probs = m.probabilities                                             // 按选项键索引
const conf = m.confidence                                                 // (p_max − 1/3)/(2/3)
const ratio = topToSecond(probs)                                          // 可选的第二指标
const keep = res.answers.requested_fits ? (res.answers.requested_fits as NoulAnswer).noul : null
const effortProbs = pick === 'haiku' ? null : scoreProbs(res.answers.effort as ScoreAnswer, 5)
```

### 4.3 (c) skill 两段排序

两段都用同一个 state（spec #10 要求 skill 判断和 effort 判断合并成一次请求：第一段可以和 4.1 的 `effort` 放进同一个请求。合并后 state 只有一份，问题里统一引用 `user_message`）。

**第一段：对全部候选做相对排序 + 判断这一轮要不要 skill**

```json
{
  "model": "jev-latest",
  "state": {
    "user_message": "按我们的模板把这个分支的 PR 描述写一下",
    "recent_context": "assistant: 已提交 3 个 commit，测试全部通过。 [tools: Bash, Edit]",
    "project_platforms": "Cloudflare Workers, GitHub Actions"
  },
  "questions": {
    "which": {
      "type": "choice",
      "instructions": {
        "question": "Which of these skills, if any, is the right one to load to help with `user_message`?",
        "focus": "Match the kind of work `user_message` asks for (such as debugging a failure, planning, reviewing, designing, writing a document), not only a product or technology it names.",
        "platforms": "A skill for one product or platform fits only when `user_message`, `recent_context` or `project_platforms` shows that product is the one in use here; otherwise choose a general skill or none."
      },
      "criteria": {
        "pr": {
          "what": "Writes the body of a pull request.",
          "use_when": "The user wants a PR description or PR body written.",
          "not_for": "Reviewing code, or opening and merging the pull request."
        },
        "code-review": {
          "what": "Reviews changes since a fixed point against the repo's standards and the originating issue.",
          "use_when": "The user wants a branch, a PR or work in progress reviewed.",
          "not_for": "Writing new code or PR text."
        },
        "cloudflare:wrangler": {
          "what": "Runs and troubleshoots Wrangler CLI commands and Worker project configuration.",
          "use_when": "The user wants to deploy, develop locally or configure a Cloudflare Worker.",
          "not_for": "Work unrelated to Cloudflare Workers."
        },
        "(none)": "None of these skills fits: the request is ordinary work that no listed skill is specifically about."
      }
    },
    "gate.acts_on_user_system": {
      "type": "noul",
      "instructions": "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?"
    },
    "gate.would_follow_documented_procedure": {
      "type": "noul",
      "instructions": "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?"
    },
    "gate.prose_suffices": {
      "type": "noul",
      "instructions": "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?"
    }
  }
}
```

- 三个 gate Noul 照抄官方 cookbook（jev-pilot 也一字不改，`J/hooks/skill-suggestion.policy.ts:408-415`）。官方解释："Write these three to ask whether an action is wanted. A question about subject matter will not separate *explain what a monad is* from a request that needs a skill, since both are software." `prose_suffices` 方向相反，求均值前要先取 `1 − p`。
- `(none)` 选项来自 jev-pilot（`:500-511`）：「Without it the ranking always names a skill ... With it, Jev puts its weight on "none" instead: measured on 16 prompts, the one request agreed with the two-request pick on 14, and the other two were better」。它和 cookbook 的 gate 并不冲突，两者可以一起用；也符合官方「列表可能不全时加 none」（C2）。
- `instructions` 改写自 jev-pilot `WHICH_INSTRUCTIONS`（`:520-521`），它解决了两类实测误判：失败的测试被分到以库名命名的 skill；AWS 项目里的「deploy」被分到 Vercel 的 skill。
- **criteria 就是 #11 的 skill 画像**：`{what, use_when, not_for}` 正是官方易混选项的结构化写法（C3），全部选项字段名一致（Q9）。画像用英文、中文还是双语，是评测变量（2.7）。
- 选项键直接用 skill 全名（含 `:` 也可以，选项键不受 ID 字符集限制）。
- **超过 254 个候选**（255 减去 `(none)`）就分批：按 jev-pilot `batchesOf` 分成尽量等大的几批（`:425-444`；例如 302 个分成 151 + 151，而不是 255 + 47），gate 只在第一批问。各批的概率是各自独立的分布，不能直接比较，合并时按名次交错（`mergeWide`，`:446-473`）。
- token 预算：Jev 要求「state + 这个 Choice」≤ 32k（Choice 是一个问题，而且是最长的那个）。60 个 skill、每个画像约 90 token，大约 5.4K，余量很大（既有调研 §1.6 的估算）。双语画像大约翻倍。

读取第一段：

```ts
const w = res.answers.which as ChoiceAnswer
const ranked = Object.entries(w.probabilities).sort((a, b) => b[1] - a[1])   // 相对排名，不是相关度
const pNone = w.probabilities['(none)'] ?? 0
const g = (k: string) => (res.answers[`gate.${k}`] as NoulAnswer | undefined)?.noul
const gate = mean([g('acts_on_user_system'), g('would_follow_documented_procedure'), 1 - g('prose_suffices')])
// cookbook：gate < 0.30 → 不推荐；jev-pilot：首选概率 ≥ 0.5（SURE_PICK）时无视 gate（:523-553）
const shortlist = ranked.filter(([n]) => n !== '(none)').slice(0, N).map(([n]) => n)
```

**第二段：只对前 N 名补读正文后复排，并给出每个候选的绝对相关度**

```json
{
  "model": "jev-latest",
  "state": { "...": "与第一段相同" },
  "questions": {
    "which": {
      "type": "choice",
      "instructions": "Exactly one of these skills is the right one to load for the request in `user_message`. Which one? Read what each actually does, not just its name.",
      "criteria": {
        "pr": {
          "what": "Writes the body of a pull request.",
          "use_when": "The user wants a PR description or PR body written.",
          "not_for": "Reviewing code, or opening and merging the pull request.",
          "opening": "<SKILL.md 正文（去掉 frontmatter）前约 700 字符>"
        },
        "code-review": { "what": "…", "use_when": "…", "not_for": "…", "opening": "…" },
        "cloudflare:wrangler": { "what": "…", "use_when": "…", "not_for": "…", "opening": "…" }
      }
    },
    "fits.0": {
      "type": "noul",
      "instructions": {
        "skill": { "name": "pr", "what": "Writes the body of a pull request.", "use_when": "The user wants a PR description or PR body written." },
        "question": "Does `skill` do the specific thing that `user_message` asks for?"
      }
    },
    "fits.1": {
      "type": "noul",
      "instructions": {
        "skill": { "name": "code-review", "what": "…", "use_when": "…" },
        "question": "Does `skill` do the specific thing that `user_message` asks for?"
      }
    },
    "fits.2": {
      "type": "noul",
      "instructions": {
        "skill": { "name": "cloudflare:wrangler", "what": "…", "use_when": "…" },
        "question": "Does `skill` do the specific thing that `user_message` asks for?"
      }
    }
  }
}
```

- 结构照搬官方 cookbook 第二次请求：Choice 的 criteria 是「完整描述 + SKILL.md 开头」（cookbook 的 `EXCERPT_CHARS = 700`），外加每个候选一个 `fits` Noul。官方原文："The Choice settles *which* skill, and the nouls settle *whether* to say anything at all." / "Each is answered on its own, so they can all come back low, and a shortlist whose highest one lands under 0.30 gets dropped entirely."
- `fits` 问法改写自 cookbook 的 "Does the skill '{name}' do the specific thing the user's request asks for? It is described as: …"，这里把 skill 数据放进结构化 instructions 的 `skill` 字段（Q8）。
- **问题 ID 用下标** `fits.0 … fits.{N-1}`，代码里保存「下标 → skill 名」的对照表（Clef 的 ID 字符集，见 0 节第 2 条）。
- 短名单只剩 1 个候选时，**不要发 Choice**（Clef 要求 Choice 至少 2 个选项），只问 `fits.0`。
- 推荐数量：spec 允许最多 k 个（默认 3，可以是 0）。cookbook 只选 1 个；要推荐多个时，按 `fits` 排序、用门槛过滤（推断）。
- cookbook 公布的数字（错误加载 16.8% → 7.3% 等）和 `GATE_THRESHOLD = 0.30`、`FITS_THRESHOLD = 0.30`，都是用 `jev-1.12` 加 `claude-haiku-4-5-20251001` 跑出来的（见其 Caching 一节）。对 `jev-1.13` 或 Clef 来说只是起点，需要按本仓库的评测集和语言重新校准。

读取第二段：

```ts
const relevance = shortlist.map((name, i) => ({ name, fit: (res.answers[`fits.${i}`] as NoulAnswer).noul }))
const which = res.answers.which as ChoiceAnswer | undefined                     // 只有 ≥2 个候选时才有
relevance.sort((a, b) => b.fit - a.fit || (which?.probabilities[b.name] ?? 0) - (which?.probabilities[a.name] ?? 0))
const recommended = relevance.filter((r) => r.fit >= thetaRel).slice(0, k)     // θ_rel 起点 0.30（cookbook）
// 展示给主 agent 的「相关度」= fit（绝对概率）；第一段 Choice 的概率只用来挑短名单
```

为什么相关度读 `fits` 而不读 Choice 概率：Choice 的 `probabilities` 在全部选项之间加起来等于 1（API 页："floats that sum to 1"），候选越多，每个分到的概率越小，所以它只表示相对排名，不能拿来和一个固定的「最低相关度」比较。`fits` Noul 是每个候选单独作答的「是」的概率（N6），可以设绝对门槛。re-ranking cookbook 也是用「每个 query-candidate 对一个 Noul，再按 noul 排序」的做法。

注意 N6：Noul 的值是「是」的概率，不是相关「程度」。如果将来想把相关度显示成「不相关 / 沾边 / 部分相关 / 直接相关」这样的程度，应该改成每个候选一个 Score（score 页的 "Candidate fit" 示例就是这种量表），作为评测变量。

`find_skill` 工具（spec #53）：把查询词和上下文作为 `user_message` 走同一套两段流程，返回名字、描述和 `fits`。

---

## 5. jev-pilot 里值得借鉴的写法与解析（附文件与行号）

`J` = `~/.claude/plugins/cache/jev-pilot/jev-pilot/0.12.1`。

### 5.1 effort 问法与档位（`J/hooks/model-router.policy.ts`）

- `:196-208` `EFFORT_RUBRIC`，注释原文："Each level names the kind of task that needs it, not an amount ("some", "a lot"): an amount leaves the decision model to guess what it means for code, a kind of task is something it can recognise in the request." 这和官方的「写情境不写程度」是同一个原则。
- `:273-280` `EFFORT_INSTRUCTIONS`："How much step-by-step reasoning does the work this request asks for need? Rate the work, not how important the topic sounds: a question or advice answered in words, even about architecture or security, is low or medium, and reviewing a small diff is medium. A short reply that approves, continues or picks an option ("go ahead", "fix all and continue", "1") takes the size of the work it approves, from the recent conversation."
- `:263-271` `SUBAGENT_EFFORT_INSTRUCTIONS`（14 条真实 brief 上，评成 xhigh 的从 10 条降到 1 条）。
- `:282-292` `isFollowUp`：不是疑问句的短回复（≤8 词）只许升档、不许降档。`J/hooks/cjk.ts` 把这条规则移植到中文：`:21` 每个英文词约等于 1.5 个汉字（220 对中英 prompt 实测），`:29-34` `wordCount`，`:119-126` `asksInChinese`（疑问词、句末「吗」、全角问号、「A 不 A」句式），`:136` `CJK_CONTINUE`（继续 / 请继续 / 接着来）。这项中文修复正是本仓库作者提交给 jev-pilot 的（`J/CHANGELOG.md:5-6`）。
- `:294-303` `EFFORT_CHOICES` 的注释，以及 `J/CHANGELOG.md:144`：effort 从 Score 改成 Choice 的实测数据（见 4.1）。
- `J/CHANGELOG.md:138-139`（0.4.14）：「Low now names mechanical work across many files」，rename 和 search 因此从 high 回到 low；新增 `minHighConfidence` 0.5 后，被送到 high 及以上的轮次从 25 降到 13，medium 任务判对的从 14 增到 20（共 26 个）。
- `J/CHANGELOG.md:154`（0.4.12）：给每档加示例反而更差。

### 5.2 模型档位与风险问题（同文件）

- `:185-194` `TIER_CRITERIA`：按工作形态描述三档。
- `:311-316` tier 问题："Which is the cheapest tier that can complete this coding task well?"
- `:322-336` + `:101-104` risky Noul：问的是「做这件事会不会对真实系统产生持久影响」，不是「话题是否涉及生产、钱」。注释原话：第一版措辞把「add a refund endpoint that calls Stripe」评到 0.96。这是 Q4（字面理解）的好例子。
- `:116-148` 四个质量 Noul（corrects / underspecified / sensitive / bugfix），每个都带 `criteria.true/false`，并附实测分数；门槛 `:151`。

### 5.3 解析与策略（同文件）

- `:415-481` `readDecision`：先确认 `answers` 是对象，缺必需答案就返回 null（视为失败）；effort 同时兼容 Choice（按名字取概率）和 Score（按 "0"…"4" 取概率）；`confidence` 缺失时用最高概率代替，`:494-503` `confidenceOf`。
- `:505-559` `effortScoreOf`：high 及以下的接近平局取较高档（`closeMargin`）；xhigh 以上要求「xhigh+max 合计 ≥ 0.6」（`VERY_HARD_CONFIDENCE`，`:513`）。
- `:671-703` 门槛：升档 0.3、升到 high 及以上 0.5、降档 0.6。`:722-742` `allowed()`：后端没给 confidence 时可以升、不能降。
- `:748-833` `route()`：`risky > 0.7` 时强制至少 high，并且绕过门槛。
- `:994-1004` `missOf`：429/502/503/529 归为 busy，其余状态码归为 error，超时单独一类。
- `:1018-1044` `escalate`：工具失败满阈值时至少升一档，同时参考重判结果，但不超过上限。spec 的「强制升档」可以直接照这个逻辑实现。

### 5.4 请求与超时（`J/hooks/jev-model-router.ts`）

- `:132-163` `askJev`：`Promise.race([fetch, sleep(timeoutMs)])`；非 2xx 时把响应体前 200 字写进日志；异常一律返回失败（fail-open）。
- `:226` `timeoutMs` 默认 1500；`:284-285` 上下文默认 4 条、2000 字符。
- `:576` 主对话的 state：`{ prompt, recent_context, signals, project_platforms? }`。
- `:696-708` 卡住时重判的 state，额外带 `trouble` 字段。
- `:1099-1110` 子 agent 的 state 只有 `{prompt, description, agentType}`；`:1133-1149` 调用方指定了模型就保留；`:1170-1172` 按 `agentId` 记下决策，供该 agent 后续的 `turn.step` 设置 effort。

### 5.5 上下文与信号（`J/hooks/context.ts`）

- `:41-51` `lineOf`：每条消息压成一行，只保留文字和工具名（失败的工具标 `(failed)`）。
- `:63-102` `recentContext`：去掉与当前 prompt 重复的最后一条；最近一条助手消息拿约一半预算，并保留开头和结尾（「Shall I start?」这类问话通常在结尾）；最新的消息优先占预算，旧消息整条丢弃而不是截短。
- `:104-160` `signalsOf`：只发计数和标志（字符数、提到的文件数、是否带代码或报错、是否疑问句、最近工具使用次数），不引用对话原文。中文报错词见 `J/hooks/cjk.ts:133` `CJK_ERROR`。spec 要求按 token 截断，可以在这一层把字符预算换成 token 估算（中文约 1 字 1 token，英文约 4.9 字符 1 token，第三方系数）。

### 5.6 skill 推荐（`J/hooks/skill-suggestion.policy.ts`）

- `:307-328` `detailOf`：第二段 criteria = frontmatter 的完整 description + 正文开头若干字符。
- `:395-400` `modelInvocable`：frontmatter 里有 `disable-model-invocation: true` 的 skill 不进候选。
- `:402-418` 三个 gate Noul，以及方向相反的 `prose_suffices`。
- `:425-473` 255 个选项上限（注释说在 OpenRouter 上实测超过时返回 400 "Too many choices. Must have at most 255 choices."）、等分批次、按名次合并。
- `:500-521` `(none)` 选项与 `WHICH_INSTRUCTIONS`。
- `:523-553` `pickSkill`：首选概率 ≥ 0.5 时无视 gate（注释：gate 曾经挡掉了「brainstorm ideas…」这种 0.82 的确定选择）。
- `:555-577` `rerankQuestions`：第二段的 Choice 加上每个候选一个 fits Noul。注意它的 ID `fits::<name>` 在 Clef 上不合法。
- `:579-593` skill 请求的 state：`{ request, recent_context }`（与 cookbook 相同）。
- `:620-694` `answersOf / readWide / readRerank`：Choice 的 `probabilities` 排序后得到排名；后端没给分布时，只把 `choice` 本身作为唯一一名；gate 取「已作答的 Noul 按方向调整后」的平均值。
- `:757-814` `decide`：gate 不过 → 不推荐；第二段尝试过但没有答复 → 不推荐；`fits` 最高值低于门槛 → 不推荐；Choice 选中的那个自己的 `fits` 也必须过门槛。

### 5.7 一次请求合并多个模块的问题（`J/hooks/jev-call.ts:1-19`）

router 把自己的问题交给 skill 模块，合成一个请求发出，原文："One request with both sets of questions takes as long as the slower of the two alone, and answers them the same (measured: same effort, tier and strategy on every prompt tried)." 这与官方 Q10/Q12 一致，spec「skill 判断和 effort 判断合并在同一个决策请求里」可以直接照这个思路做。`:91-94` `isContinuation`：「继续」类提示直接复用上一次的决策，不再请求。

---

## 6. 待实测 / 待评测事项（汇总给 #2、#3、#16）

1. **Clef REST 的 `result.answers`**：官方 Clef 页没有给出 REST 响应原文；依据是通用外壳和第三方实测。#3 实现时用一次真实调用确认（spec 已列）。
2. **Clef 是否只读 state 的前约 2K token**：第三方说法（OpenRouter 模型页、decisions-api.dev，见既有调研 §2.6，本次未复核），官方 schema 只写了 "Long text state is truncated to fit the model's token limit."。评测方法：在 state 末尾放一个探针事实，再对比 `usage.input_tokens`。另外要确认截断是否也作用于 questions/criteria（skill 列表在 criteria 里）。
3. **effort 用 Score 还是 Choice**（4.1）：同一请求里两种问法一起问，用数据决定。
4. **问题语言**（spec #70）：英文 instructions + 中文 state 是默认值；中文 instructions 作对照。skill 画像语言（英 / 中 / 双语）另做一个变量。
5. **Choice 顺序敏感度**：模型 Choice 跑全部排列；skill Choice 至少跑「随机打乱」和「固定字母序」两种。
6. **Score 档位加示例**：官方说示例像真实输入才有用；jev-pilot 实测反而变差。只作为评测变量。
7. **中途重判的 state 放不放「当前 effort」**（4.1 末尾）。
8. **主 agent 指定的模型**：放在单题 instructions 里（本笔记推荐）与放在 state 里对比，看 `model` Choice 有没有被锚定。
9. **相关度用 Noul 还是 Score**（4.3 末尾）。
10. **门槛按语言分别校准**：θ_up、θ_down、θ_max、θ_override、θ_fit、θ_rel、gate。绘制「confidence 对准确率」曲线（官方建议）。
11. **版本固定**：评测时记录响应里的 `model`（Jev 带版本号，Clef 不带）。线上可以考虑固定 `jev-1.13.0`（不要写 `jev-1.13`，第三方实测会返回 400），换版本时重新校准。
12. **`$.http.fetch` 是否复用连接**：影响首个请求的延迟。
