# 决策问题放在哪一层：TypeSafe Jev 与 Nace Drex 的官方材料核对

调研日期：2026-11-18（抓取日期同）。用途：dispatch-pilot 重写时，决定「这段工作多费力、该用哪档 effort 和模型」这类问题，是按方式 A（问工作本身，代码查表得出档位和模型）写，还是按方式 B（直接问决策模型「该用哪档」）写；并核对 TypeSafe 官方 skill 里「Judgments from Jev, decisions in code」一节是否过时。没有调用任何厂商的付费模型 API，没有运行 claude，所有外发请求里没有个人或项目信息。

标注约定：**官方原文** = 厂商自己的页面、skill 或源码里的原话（英文逐字引用，附 URL）；**推断** = 我由已查到的事实推出；**未文档化** = 查过、没找到（写明查了哪里）。第三方（非厂商）的材料单独写「第三方原文」，不算官方。

TypeSafe 文档站现在用 llms.txt 里的新路径，用户给的旧路径（例如 `/go/how-to-build.md`、`/go/patterns.md`）返回 HTTP 307，跳到 `/concepts/how-to-build-with-system-one.md` 和 `/patterns.md`（**官方原文**，响应头 `location`，2026-11-18 实测）。本文用新路径。

---

## 结论

### 一、TypeSafe

1. **skill 0.6.2 是最新版。** **官方原文**：上游仓库 `typesafe-ai/skills` 的标签只有 `v0.6.2` 和 `v0.5.7`；`v0.6.2` 的提交是 2026-10-23（"Release v0.6.2"），`main` 上的 `SKILL.md` 与本机缓存里 0.6.2 的 `SKILL.md` 逐字相同（diff 为空），本机 marketplace 克隆的 HEAD 也是同一提交 `302eea6`。
2. **那一节不是过时的旧文，是较新加的。** **官方原文**：上一个标签 `v0.5.7`（2026-09-12）的 `SKILL.md` 里没有「Judgments from Jev, decisions in code」这一节，也没有 "truth table"、"wrong layer"；0.6.2（2026-10-23）加入了。**推断**：它是 TypeSafe 在 9 月到 10 月之间加强的立场，不是被取代的立场。
3. **活文档（2026-11 的页面）在实质上支持同一原则，但没有用 "truth table" 和 "wrong layer" 这两个说法。** **未文档化**：这两个短语在 llms.txt 列出的全部非 SDK、非 API-reference 页面里都搜不到，只在 skill 里有。活文档的写法是：
   - 最强的支持原文（use-case-map）："Start from the action your system takes, and list the judgments it depends on. Turn each judgment into a question for Jev. Keep the rules that combine the answers into a decision in your code."
   - 同页的具体例子："Instead of asking Jev whether an email is fraudulent, ask about the signs of fraud."
4. **反面和限定的材料也在官方文档里：**
   - skill 自己的限定："None of it is absolute. Models change, applications differ, and edge cases exist. When a situation calls for something else, test the alternative and use your judgment."
   - 官方 cookbook 里直接问决策的问题（不是为了推荐写法，是在测稳定性）：自洽性 cookbook 问 "What enforcement action should be taken on this post?"（选项 Allow / Warn / Remove / Strike / Escalate）、"Which single moderation queue should own this post?"、"Who should make the final call on this post?"；noul 版问 "Should this claim be routed for manual/supervisor review before payout?"。
   - 官方 Choice 页的基本示例问 "Which team should handle this?"。
   - skill 推荐 cookbook（skill_suggestion）里的主问题是 "Which of these skills, if any, is the right one to load to help with the user's latest request?"，选项是各 skill 自己的描述，另有若干问输入的 Noul 做闸门。
   - entity_alignment 把一个 Score 的每个档位写成一个结局："you describe one level per outcome"，代码四舍五入到最近档位后查表。
5. **选模型、选 effort、评估「这活多难」：两家都没有官方配方。** **未文档化**。TypeSafe 只在 use-case-map 的 "More ideas" 里有一行："Model router: match each prompt to a model"，列了 "Estimate difficulty and risk."，没有示例问题、没有 cookbook。

### 二、Nace Drex

1. **Nace 没有写过「问题该在判断层还是决策层」「拆成真值表」这类原则。** **未文档化**（读了 llms.txt 列出的全部 Drex 指南、API reference 页的示例、集成页、官方 skill 仓库、开源模型仓库的 README；没有 cookbook 页，也没有更新日志页）。
2. Nace 的问题指南的出发点是下游代码：**官方原文**："Start from the code that consumes the answer, not from the text you are asking about."
3. Nace 自己的示例和官方 skill 直接问决策，没有保留意见：
   - Drex Max 指南的示例问 "How should accounts payable handle this invoice?"，选项 `pay` / `hold` / `reject`。
   - state 指南和 API reference 的示例问 "Which priority should this ticket get?"，选项 `p0`…`p3`，每项描述是一种情形（"Production down for many users"）。
   - 官方 skill `drex-for-harness`：路由和「选下一步动作」用 "`choice` over named destinations or actions"。
4. 但 Nace 官方 skill 同时写了 "Start from the branch the application will take, then work backward to the semantic judgments it requires. Keep deterministic checks, calculations, execution, and permissions in code."，所以它对方式 A 也不反对。

### 三、方式 A 与方式 B 各自得到谁的支持

- **TypeSafe：支持方式 A，不支持方式 B 作为默认写法。** 依据是上面第一节的 1 到 4 条里的原文。限定：skill 本身说"不是绝对的"；官方 cookbook 里有直接问决策的例子，但都是选项描述被判断对象的路由、或稳定性测试，没有哪个例子论证「直接问决策比拆开问更好」。
- **Nace：两者都不反对；官方示例偏向方式 B 的写法**（直接问 "How should…handle"、"Which priority should…get"），但没有任何文字比较过两种写法。
- **推断（混合方案）**：对 effort 档位，这样做同时落在两家的官方写法里——用一个 Score，五个档位各写成一种独立的情形（TypeSafe："Describe situations, not degrees"；Nace skill："Describe concrete situations rather than vague labels when possible"），再加几个条件 Noul；代码读 `probabilities`（不只读 `score`），查表得出档位。档位的数目与动作一一对应本身不被禁止（entity_alignment 就这样做），要避免的是把档位写成「应该用 high」这种动作名。选模型档位同理，没有官方依据说 Score 或 Choice 直接问「用哪个模型」会更好或更差。
- **推断（风险）**：方式 B 的问题（"which effort level should the agent use"）会落在 TypeSafe 说的 "Analyze this message and determine the best course of action" 同一类上（一个问题里藏着多个判断）；这是类比，TypeSafe 没有对 effort 或模型选择说过话。

---

## 1. TypeSafe 现在对「问题层」的立场

页面日期：Mintlify 站点的 `sitemap.xml` 有 `lastmod`，页面正文里没有 "last updated" 标记（**未文档化**：查了所有 .md 页面的正文）。以下 `lastmod` 取自 https://docs.typesafe.ai/sitemap.xml：how-to-build 2026-11-04，use-case-map 2026-11-13，primitives 2026-11-12，patterns 2026-11-12，patterns/composite-scoring 2026-11-04，patterns/probability-routing 2026-11-04，agent-skill 2026-11-04，changelog 2026-11-03，introduction/coding-agents 2026-11-12，cookbooks 各页 2026-11-16（function_calling 为 2026-11-17）。响应头 `last-modified` 对多数页是 2026-11-17，那是站点重建时间，不是内容修改时间（**推断**）。

### 1.1 仍然写着「判断来自模型，决策在代码里」的页面

**官方原文**（https://docs.typesafe.ai/concepts/use-case-map.md ，lastmod 2026-11-13）：

> Build business workflows where Jev makes the judgments and your code acts on them.

> Start from the action your system takes, and list the judgments it depends on. Turn each judgment into a question for Jev. Keep the rules that combine the answers into a decision in your code.

> Instead of asking Jev whether an email is fraudulent, ask about the signs of fraud. Send one request with the email, the vendor's record on file, the open invoices, and specific questions to help you determine if the email is fraud:

同页给出的真值表式表格（"Answers | Action"，例如 "Asks to change payment or bank details, and either the sender's address looks wrong or the email pressures the reader | Hold payments to that vendor and alert finance"），以及 "Decision shapes" 表里 "Routing | A category selects the next code path | Tool use, escalation, model routing, support queues"。

**官方原文**（https://docs.typesafe.ai/patterns.md ，lastmod 2026-11-12）：

> Every pattern splits a decision into small System One questions and leaves the decision to your code: Jev answers each question with a probability, and your code decides what happens next.

**官方原文**（https://docs.typesafe.ai/primitives.md ，lastmod 2026-11-12）：

> System One models are built for fast, focused judgments. Ask for a judgment a knowledgeable person makes in a second given the right context. "Does this message convey urgency?" is a good question. "Analyze this message and determine the best course of action" is not. That needs slow reasoning, and it is a signal to break the task into small questions and compose the answers in code.

> You compose the answers in your code to make decisions.

**官方原文**（https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md ，lastmod 2026-11-04）：

> Jev is TypeSafe's model for building AI-powered software, not agents. It does not generate code or choose its own next action. It provides AI primitives that embed into software, so code remains in control while the model handles common-sense judgments over unstructured data.

> Keep control flow, deterministic rules, and side effects in code.

> This is probably the most important concept in this guide. Broad questions hide several judgments behind one answer. Atomic questions expose those judgments so you can inspect, tune, and combine them in code.

**官方原文**（https://docs.typesafe.ai/cookbooks/sde_cascade.md）：

> a single "is this answer right?" returns one score that cannot say what went wrong

**官方原文**（https://docs.typesafe.ai/model-jaggedness.md）末尾的提醒列表：

> Hiding several judgments inside one question.

**官方原文**（https://docs.typesafe.ai/introduction.md）：

> If the question you want to ask would require extended reasoning or weighs multiple independent factors, decompose it. Ask each factor as a separate question, then combine the results with logic in your code.

**未文档化**：skill 里的 "truth table"、"wrong layer"、"Should this ticket be escalated?"、"What should the agent do next?" 这几个说法，在活文档里没有逐字出现（搜了 llms.txt 里除 `/sdk/*` 和 `/api/*` 之外的全部 .md 页）。

### 1.2 skill 里的原文（本机缓存 0.6.2，与上游 main 相同）

文件：~/.claude/plugins/cache/typesafe-ai/typesafe/0.6.2/skills/typesafe-ai/SKILL.md ；上游 https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md 。

**官方原文**：

> The rest of this skill is guidance: patterns that tend to produce reliable integrations. None of it is absolute. Models change, applications differ, and edge cases exist. When a situation calls for something else, test the alternative and use your judgment.

> ## Judgments from Jev, decisions in code
>
> Integrations tend to work best when Jev makes the judgments and code decides what to do with them. Think of each decision as a **truth table**. Jev supplies the inputs, such as "Does the customer sound frustrated?" or "Which product is the message about?". Code holds the logic that maps those inputs to an action.
>
> A question that asks Jev to make the decision, such as "Should this ticket be escalated?" or "What should the agent do next?", usually means the question is at the wrong layer. Instead, break the decision into the judgments it depends on, and write the decision itself in code, where it's visible and testable. Writing out the table often shows gaps in the business logic too. A combination of judgments with no defined outcome is a design question about the system, and it is best settled in code.

「Write the questions」一节同向：

> Break complex judgments or decisions into their parts, and combine the answers in code with weighted sums, boolean logic, thresholds, or other heuristics to reach the final decision. For example, rather than asking "Is this fraud?" or "Is this spam?", ask the set of atomic questions about what might make something fraud or spam.

> **Anchor intent to the goal.** When the judgment is about what someone wants, it helps to name their goal: "Which of these files does the user want copied?" rather than "Which of these names the main input?".

### 1.3 有没有更新的材料软化、反转或限定它？

- **软化：有，措辞层面。** skill 用 "tend to"、"usually"、"None of it is absolute"；活文档用 "probably the most important concept"、"is a signal to"。没有一句是 "never"。（**官方原文**，见上。）
- **反转：没有找到。** **未文档化**：没有任何页面说「直接问决策更好」，也没有更新日志条目改变问题写法建议（见第 7 节）。
- **限定：有。**
  - https://docs.typesafe.ai/primitives.md 说 Choice 适合路由："**Choice** fits when the answer is one of a known set of options with no order between them: routing a ticket to a department, classifying a document type, detecting a programming language." 并且 "A Choice between `refund`, `rebook`, and `information` maps straight onto three code paths."
  - https://docs.typesafe.ai/primitives/choice.md 的示例问题：`instructions="Which team should handle this?"`，选项 `returns` / `shipping` / `billing`（每项描述的是工单内容）。
  - https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md 的完整示例里，Choice `topic` 的 `instructions 是 "Which team should handle `ticket.message`?"，同一问题里 `focus` 写 "Classify the customer's primary request."；随后代码用 `answers["topic"].choice == "billing"` 走分支。
  - **推断**：官方把「选项是内容类别、问题问输入是什么」的 Choice 当作路由写法，不算越层；越层的是把多个判断（风险、紧急度、权限）压成一个「该怎么办」的问题。

### 1.4 与旧笔记的差别

旧笔记 .claude/worktrees/dp-rewrite/docs/research/typesafe-question-guide.md（整理日期 2026-10-04）里没有 "truth table" 或 "wrong layer"（grep 无命中），并且它的 effort 示例问题写成 "Which is the cheapest tier that can complete this coding task well?"（引自笔记第 824 行附近的 jev-pilot 引用）。**推断**：旧笔记早于 skill 0.6.2（2026-10-23）。活文档在以下方面与旧笔记写作时不同或需要重新核对：（a）文档路径已改（见开头）；（b）skill 多了这一节；（c）更新日志现在只列到 Jev 1.14（2026-10-14）。

---

## 2. skill 0.6.2 是不是最新版

- **官方原文**：本机 `plugin.json` 的 `version` 是 `0.6.2`，`repository` 是 https://github.com/typesafe-ai/skills ；`installed_plugins.json` 记录 `gitCommitSha` `302eea662c54bca6730873fe245bec1d69ebc23d`，`lastUpdated` 2026-10-28。
- **官方原文**（GitHub API，2026-11-18）：标签 `v0.6.2` → `302eea6…`，`v0.5.7` → `65a39f3…`。提交列表只有三条："Release v0.6.2"（2026-10-23T21:40:51Z）、"Release v0.5.7"（2026-09-12T05:42:05Z）、"Initial commit"（2026-08-25T00:23:24Z）。GitHub Releases 列表为空。
- **官方原文**：上游 `main` 的 `SKILL.md` 与本机缓存 0.6.2 的 `SKILL.md` 的 diff 为空（18085 字节）。上游 `.claude-plugin/plugin.json` 的 `version` 也是 `0.6.2`。
- **官方原文**（https://docs.typesafe.ai/agent-skill.md ，lastmod 2026-11-04）：安装命令 `claude plugin marketplace add typesafe-ai/skills` / `claude plugin install typesafe@typesafe-ai`；更新命令 `claude plugin marketplace update typesafe-ai` / `claude plugin update typesafe@typesafe-ai`。
- **0.5.7 与 0.6.2 的实质差别**（我 diff 了两个版本）：0.5.7 没有「Judgments from Jev, decisions in code」一节；0.5.7 的 "Find the useful shape" 写的是 "Start from the behavior the user wants: what will the application show, select, change, or hand off? Work backward to the judgments it needs. Keep known rules, calculations, exact lookups, and execution in code."（**官方原文**）。0.6.2 把这个想法单独成节并加了「question at the wrong layer」的明确说法，同时加了 "None of it is absolute"。
- **结论**：0.6.2 是上游当前最新的发布；本机没有落后。我没有找到比 0.6.2 更新的版本、分支或预发布，所以「最新版是否仍含该节」的答案是：含，原文相同。

---

## 3. TypeSafe cookbook 和 pattern 里「由答案选出路线 / 工具 / 处理器 / 模型 / 升级 / 档位」的例子

我读了每个 cookbook 里定义问题和读答案的代码段，以及全部 pattern 页、primitives 各页、use-case-map、how-to-build；没有逐页通读每个 cookbook 的叙述部分（见末尾页面列表）。下表的「问输入 / 问决策」列是我的判断（**推断**），问题措辞和读法是**官方原文**。

| 页面 | 问题措辞（逐字） | 类型 | 代码怎么读 | 问输入还是问决策 |
|---|---|---|---|---|
| function_calling（2026-11-17） https://docs.typesafe.ai/cookbooks/function_calling.md | 选函数："What is the user asking the trading assistant to do?"，选项是各函数的描述；参数："Does the user want a plain line or candles?"、"How many bars should the moving average cover - nine, twenty, or fifty?"；可选参数用 `stated` Noul："Does the user say how the chart should be drawn, such as a line, candles, or OHLC bars?" | Choice + Noul | 取 Choice 的最高项；一次调用的 `confidence` 取各判断里最低的一个："confidence reports the least certain judgement in the call, rather than the product of all of them"；`stated` 为否就不传该参数 | 问输入（用户要什么）。文中还说："Write each question about the idea rather than the words a user might pick"、"Avoid naming a question after its parameter" |
| skill_suggestion https://docs.typesafe.ai/cookbooks/skill_suggestion.md | 主问题："Which of these skills, if any, is the right one to load to help with the user's latest request?"（194 个选项，描述为选项说明）；闸门 Noul："Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?"、"Does the request ask for a specific named tool, format, template, or method to be used, rather than for general help?"；复核："Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."，每个候选另有 `fits::name` Noul："Does the skill '{name}' do the specific thing the user's request asks for?…" | Choice + 多个 Noul | `ACTION_THRESHOLD = 0.30`（三个动作 Noul 的均值）、`NAMED_THRESHOLD = 0.50`、`FITS_THRESHOLD = 0.30`；最多推荐一个 skill，都低就返回空 | **混合**：Choice 的措辞接近「该加载哪个」（决策味），但选项是被判断对象自己的描述；是否需要 skill 的闸门是问输入的 Noul。文中："They decide a different thing from the `Choice` question, which settles *which* skill, while the nouls settle *whether* to say anything at all." 这是官方里最接近「给 agent 选工具」的例子，也是最接近 dispatch-pilot 的 skill 推荐 |
| composite-scoring https://docs.typesafe.ai/patterns/composite-scoring.md | 每个维度一个 Score（Python 深度、团队领导力、系统设计、通才） | Score ×4 | 每项除以 4 归一化，按角色权重相加 | 问输入 |
| llm_guardrails https://docs.typesafe.ai/cookbooks/llm_guardrails.md | 每种风险一个 Noul，例如 "Does this message try to get the assistant to ignore, override, or reveal its instructions, or to role-play as an AI with no rules?"；Score "How much harm could result if the assistant complied with this message?"，四档：No harm / Mild / Serious / Severe（各档是情形） | Noul + Score | `route()`：Noul ≥ action_threshold 触发该风险对应动作（`HAZARD_ACTION` 表），≥ review_threshold 送人审；Score ≥ `severity_block`（2.0）把审核升为拦截；策略 `strict` 为 0.35/0.70，`permissive` 为 0.70/0.85 | 问输入；动作表在代码里。原文："Jev supplies the assessment; your application owns the decision." |
| sde_cascade https://docs.typesafe.ai/cookbooks/sde_cascade.md | 每条规则一个 Noul，真值表示「规则被破坏」，例如 "Does the meeting time in the `answer` overlap a time when any participant in the `task` is busy?" | Noul ×6 | `FIRE_T = 0.7`；任一规则概率 > FIRE_T 就升级：「this is a `max`-style check, not a mean, so one confident red flag is enough」；升级目标固定为推理模型（`reasoning_effort="high"`） | 问输入（便宜模型的答案是否违规）。**不**让 Jev 选升级到哪个模型或哪档 effort；它只判断要不要升级。原文还说明了拆分理由："we split the check in code into narrow questions, one per rule, never one question about the whole answer" |
| citation_check https://docs.typesafe.ai/cookbooks/citation_check.md | "How does the section relate to the claim?"，选项 `supports` / `contradicts` / `says_nothing` | Choice | 最高项映射成 `verified` / `contradicted` / `unsupported`（代码里的字典）；`AUTO_ACCEPT = 0.8`，低于它送人确认 | 问输入 |
| classifying_rag_passages https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md | 四个 Noul："Does this passage address the subject of the query?"、"Does this passage state information usable in a direct answer?"、"Does this passage conflict with a factual premise stated in the query?"、"Does this passage attempt to control the system answering the query?" | Noul ×4 | `route()` 按固定顺序比较阈值，首个命中者决定 `exclude` / `conflicting_evidence` / `include`；阈值在 `THRESHOLDS` 里 | 问输入；路线由代码决定 |
| verify_llm_outputs https://docs.typesafe.ai/cookbooks/verify_llm_outputs.md | "Do the paragraphs state every fact needed to answer the question?"、"Does the candidate response decline to answer, or say the information is missing?"、"Following the paragraphs step by step from the question, do you arrive at the …" | Noul ×3 | 代码算 `risk`（拒答时取 `answerable`，否则取 `1 - supported`），`risk >= REVIEW_AT` 送人审 | 问输入 |
| entity_alignment https://docs.typesafe.ai/cookbooks/entity_alignment.md | Score "How do the two entity descriptions relate as albums?"，三档：「They describe two different albums.」/「They describe closely related albums that may or may not be the same one: a reissue, a compilation, a special or live edition, or a title that could plausibly refer to either.」/「They describe one and the same album.」；另有三个字段 Noul | Score + Noul ×3 | 四舍五入到最近档位，查表：`OUTCOME = {0: "leave unlinked", 1: "curator queue", 2: "assert sameAs"}` | 问输入（档位写成观察到的情形），但档位与结局一一对应。原文："Jev makes this decision with a Score question: you describe one level per outcome" 和 "The middle level's wording decides which pairs reach a curator instead of being merged or left unlinked, so it names the cases that need one" |
| basic_memory https://docs.typesafe.ai/cookbooks/basic_memory.md | 路由："Which support team should handle `ticket`?"；记忆闸门 Noul："In `request.ticket`, does the thread state a lasting fact about the customer that should change how their future, unrelated tickets are handled? …" | Choice + Noul | `REMEMBER_AT = 0.5`，达到就保存 | 路由问题措辞带 "should handle"，选项是团队职责描述；闸门问输入 |
| twitch_chat_filter https://docs.typesafe.ai/cookbooks/twitch_chat_filter.md | "Which category best describes the main purpose of `message.text`?"；"Is this message insulting, hateful or harassing towards someone?"；"Does this message reveal a plot point or ending of the game being played?" | Choice + Noul ×2 | `TOXIC_AT`、`SPOILER_AT` 阈值；代码决定显示、高亮、变暗、隐藏、模糊 | 问输入 |
| classification_using_confidence https://docs.typesafe.ai/cookbooks/classification_using_confidence.md | Choice，问题是公司属于哪个行业（"Which broad industry does this company operate in? …"） | Choice | 读答案自己的 `confidence`，低时报告上一级大类 | 问输入 |
| semantic_find https://docs.typesafe.ai/cookbooks/semantic_find.md | "Which line of the document contains the answer to: "{query}"?"，选项是行号；Noul "Does any line of the document address or answer: "{query}"?" | Choice + Noul | Choice 概率即排序；Noul 判断文档里有没有答案 | 问输入 |
| intelliprompter https://docs.typesafe.ai/cookbooks/intelliprompter.md | Score "How completely has the speaker covered this criterion in `transcript`: …" | Score | `COVERED_AT = 2.5`（1 到 5 档），代码保存已勾选集合 | 问输入 |
| **consistency_choice_cookbook**（2026-11-16） https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md | 八个 Choice，其中 "What enforcement action should be taken on this post?"（Allow/Warn/Remove/Strike/Escalate）、"Which single moderation queue should own this post?"（Auto/General/Threat/Spam/TSLead）、"How should any external link or off-platform invite in the post be handled?"、"Who should make the final call on this post?"（Auto/Human/Senior/Legal）、"What is the primary moderation risk that should drive triage for this post?" | Choice ×8 | 稳定性测试：把每个选项概率在 0 到 1 的所有阈值上算「再问一次会不会改变决定」；Jev 的最不稳定决策平均变 4.0% | **问决策**，选项按动作命名。这是唯一一处官方直接用动作命名的 Choice，目的是测稳定性，不是推荐写法，页面没有论证它比拆开问好。原文开头："A pipeline that hands decisions to a model needs the same post to get the same decision every time." 并说明 "That says nothing about whether the decision is right" |
| **consistency_noul_cookbook** https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md | 十四个 Noul，其中 "Should this claim be routed for manual/supervisor review before payout?"、"Are there indicators that warrant a fraud review?" | Noul ×14 | 同上 | **问决策**（人工复核要不要）。同样是稳定性测试 |

没有找到的：**未文档化**——查了 https://docs.typesafe.ai/llms.txt 全部 cookbook 与 demo 页的标题、描述、问题定义，没有「选 LLM / 选模型档位」「选推理力度」「难度评级」「优先级 P0–P3」的 cookbook。content-audit demo（https://docs.typesafe.ai/demos/content-audit.md）有 Choice 分类 "fix effort"、"complexity"、"the best single fix"，是评价页面的，不是选系统动作。

我略过没有逐页细读的 cookbook（原因：它们做抽取、搜索、排序、图像，不选路线、模型或档位）：hierarchical_classification、date_extraction_cookbook、pre_parsed_value_extraction_cookbook、autoformat、cart_from_primitives、reading_scanned_documents、ocr_confidence_bounding_boxes、feeder_watch、rerank_typesafe、infinite_cardinality_choice、parallel_questions、autoresearch_feature_discovery、demos/airbnb-listing-search、demos/smart-home（只读了叙述部分：其问题 "What category of request is this?"、"What action should be taken on the lights?" 问的是用户请求要什么，属于问输入）。

### 官方有没有直接问决策？怎么论证？

- **有**：见上表最后两行，以及 Choice 页 "Which team should handle this?"、skill_suggestion 的 "is the right one to load"。
- **论证**：**未文档化**。官方没有页面说「直接问决策的写法也可以」或「在什么条件下可以」。自洽性 cookbook 的前提是 "A pipeline that hands decisions to a model"，并明说它不衡量决定是否正确。
- **推断**：官方例子分三类：（a）问输入的判断，代码查表（绝大多数）；（b）选项是被选对象的 Choice，措辞带 "should/right one"（路由、skill）；（c）稳定性基准里的决策问题。没有例子在「选 effort 档位」或「选模型」上做过任何一种。

---

## 4. 有序的五档结果：Score、Choice 还是几个 Noul

**官方原文**：

- https://docs.typesafe.ai/primitives.md ："**Score** fits when the answer falls on a spectrum and you can describe what each point on that spectrum means: bug severity, customer frustration, skill level. The levels are yours to define, and the model returns a position along them."
- 同页："If two types both seem to fit, prefer the one whose answer your code can act on directly. A Choice between `refund`, `rebook`, and `information` maps straight onto three code paths. A Score of customer frustration maps onto a threshold. A Noul maps onto an `if`."
- https://docs.typesafe.ai/primitives/score.md ："Use as many levels as you can describe distinctly, up to 10. Three is fine. Don't add levels you can't describe distinctly."（最多 10 档，至少 2 档）
- 同页："If there is no in-between at all, and the answer is one of a few discrete categories, use a Choice instead, or split the question into several Noul questions."
- https://docs.typesafe.ai/primitives/noul.md 把 Score 和 Noul 对照："The Noul judges one proposition, "strong", and the values are how likely it is. You could create levels in the 0 to 1 range in your code … but the model will not see them, so nothing in the answer was judged against them." 以及 "The Score judges each level description on its own, so every candidate landed on or near a level you wrote, and the returned probabilities show how the model divided its judgment between levels."
- skill："Use a Noul per statement when more than one can be true."

**档位写法**（**官方原文**，score.md）：

> Describe situations, not degrees. "Broken or degraded feature, but workaround exists" gives the model something to match the state against. "Moderately severe" doesn't.

> Every level is evaluated separately. The model doesn't see a level's number or its neighbours, so "worse than the previous level" means nothing to it, and numbers in the descriptions or the instructions don't help.

同页的对照实验：档位只写 `["0", "1", "2"]`、指令写 "Rate severity from 0 to 2, where 2 is worst" 时，得 `score 0.55, confidence 0.33`；用三个描述性档位同一份报告得 `0.0`、置信度 `1.0`。skill 的对应条目："Describe each Score level as a situation. Each level should make sense when read on its own".

> Keep each Score question to one dimension.

> If the top of your scale has a rare extreme case you need to act on differently, give it its own level.

**怎么把 Score 映射成动作、读分布还是位置**（**官方原文**）：

- score.md："A fractional score is a position. You can use it to rank reports by severity, or round it to the nearest level when your code needs one outcome. Our entity alignment cookbook shows an example of rounding to the nearest level to make a decision."
- score.md："Different distributions can produce the same score. A score of 1.0 can mean all probability is on level 1, or half is on each of levels 0 and 2. Read `probabilities` and `confidence` alongside the score to distinguish these cases."
- https://docs.typesafe.ai/patterns/confidence-routing.md ：先看 `confidence < 0.5` 送人，再按 `score < 1.5` / `< 2.5` 分三路；并写："When a decision depends on which side of a level boundary the answer falls, add up the probabilities of the levels on the side that matters:"，示例 `blocked = severity.probabilities[3] + severity.probabilities[4]`，`if blocked >= 0.3:` 时通知值班工程师。该页的五档示例（Cosmetic / Minor / Major with a workaround / Major with no workaround / Critical）每档是情形，动作（backlog / sprint / on-call）在代码里。
- https://docs.typesafe.ai/confidence.md ："**For a Score whose decision depends on one level, that level's probability.** The position can be between two levels and hide a split answer, where the probability is high on two separate levels."
- https://docs.typesafe.ai/agent-skill.md ："Read a Score's level probabilities when its position could hide a split answer. The `confidence` field summarizes uncertainty, so it's often not the number to act on."
- https://docs.typesafe.ai/model-jaggedness.md ："Please do not use score outputs … to compute the exact magnitude of a number between two levels of a criterion. You can use the expectation to check if it passes a particular threshold, but Jev's score levels are weak in numerical calibration."
- 同页关于 Choice："In some cases, we observed that the order of a Choice's options can affect the answer, and Jev leans toward the option that comes first." 对策："reorder the options to double check that the answer stays consistent."

**档位按动作命名的例子**：
- Score 档位按观察到的情形命名、动作在代码里：score.md 的 bug 严重度、confidence-routing 的五档严重度、llm_guardrails 的 `SEVERITY`、primitives 的 frustration。
- 档位与动作一一对应的：entity_alignment（上表），档位文字是情形，但整体设计成「一档一结局」，原文称 "one level per outcome"。
- Score 档位直接叫 "P0–P3"、"escalate now" 一类动作名：**未文档化**，在 TypeSafe 文档里没有找到这样的 Score。唯一接近的是 Nace 的 `priority` Choice，见第 5 节。

**推断**：对「五档 effort」，TypeSafe 的材料指向「一个 Score，五档各写成独立情形，读 `probabilities`，代码映射」；不指向五个 Noul（档位有序，Noul 没有位置），也不指向按名字选的 Choice（会丢掉顺序，并有首项偏好）。如果各档与 effort 一一对应，entity_alignment 的做法（档位写情形、代码查表）是官方先例。

---

## 5. Nace Drex

### 5.1 页面清单

llms.txt：https://console.nace.ai/llms.txt（有）；全文：https://console.nace.ai/llms-full.txt（有，约 298 万字符）；站点地图：https://console.nace.ai/sitemap.xml（只列 URL，没有 lastmod）；单页 Markdown：在页面 URL 后加 `.md`（例如 https://console.nace.ai/docs/drex.md）。**未文档化**：Nace 文档页没有 "last updated" 标记，响应头没有 `last-modified`，只有 `etag`。

Drex 部分的页面（**官方原文**，llms.txt）：Overview、Quickstart、API reference（systemone、decisions、models、batches、browser-runs、balance）、Guides（Authentication、Batches、Browser runs、Drex Max、Errors and retries、Migrate from TypeSafe、OpenAI-compatible decisions、Questions、Reading answers、State）、Reference（Errors、Limits、Models、Pricing）。另有 Developer tools（Agent skills、CLI、Remote MCP server、Local MCP server、Python SDK、TypeScript SDK）、Integrations（BigQuery、Braintrust、ClickHouse、dbt、DSPy、DuckDB、Langfuse、MLflow、Oh My Pi、Opik、Postgres、promptfoo、Snowflake、Spark、Vercel AI SDK、Weave）、Perception、Workspaces。

**未文档化**：Nace 文档里没有 cookbook 页、没有 recipes 页、没有更新日志页（搜了 llms.txt 和 llms-full.txt 里的 "changelog"、"release notes"、"What changed"，只有 "What changed in Drex 2.0" 一节，见第 7 节）。

### 5.2 Nace 对「问题放在哪一层」说了什么

**官方原文**（https://console.nace.ai/docs/drex/guides/questions ）：

> Pick the type by the decision you make next
>
> Start from the code that consumes the answer, not from the text you are asking about.

表格："A yes or no, with a threshold you set | noul | Is the customer asking for a refund?"、"One label from a fixed set with no order | choice | Is this ticket about billing, a technical problem, or the account?"、"A position on an ordered scale | score | How upset is the customer, from calm to angry?"。

> If the labels have an order, use `score` and you get a fractional position on the scale. If the labels have no order, use `choice`.

**官方原文**（https://console.nace.ai/docs/drex/guides/reading-answers ）：

> Drex does not return a verdict. It returns a probability for each question, and your code turns that into a decision.

> A threshold is a business decision, not a property of the model. Log the raw `noul` value with each decision, so you can move the threshold later and replay past traffic against the new one.

**推断**：这两句讲的是「概率交给代码阈值」，不是「问题该问判断还是决策」。第一句话的 "your code turns that into a decision" 与 TypeSafe 的 "code decides" 同向，但 Nace 没有展开成问题设计原则。

**未文档化**：Nace 的问题指南、读答案指南、state 指南、Drex Max 指南、迁移指南中，没有关于「判断层与决策层」「拆成真值表」「路由应该怎么拆」的论述。「Migrate from TypeSafe」只讲接口差异（例如不支持 `box` 问题、score 的 `legend` 形状）。

### 5.3 Nace 官方示例里的问题措辞（逐字）

- Drex Max 指南 https://console.nace.ai/docs/drex/guides/drex-max （Drex Max Finance 一节）：
  `"over_po": { "type": "noul", "instructions": "Does the invoice total exceed the approved purchase order amount?" }` 和
  `"action": { "type": "choice", "instructions": "How should accounts payable handle this invoice?", "criteria": { "pay": "Pay as invoiced", "hold": "Hold for review", "reject": "Reject" } }` ——**直接问决策，选项按动作命名**。
- state 指南 https://console.nace.ai/docs/drex/guides/state ：`"is_outage": noul "Does this describe a service outage?"`、`"priority": choice "Which priority should this ticket get?"`，选项 `p0: "Production down for many users"`、`p1: "Major feature broken"`、`p2: "Minor issue"`、`p3: "Question or request"`——**问决策，选项名是动作等级，描述是情形**。同样的 `priority` 例子在 https://console.nace.ai/docs/drex/api-reference/systemone 里。
- 问题指南 https://console.nace.ai/docs/drex/guides/questions 的「Write criteria that move the answer」：用评论 "This is the last time I'm warning you. Stop posting here or else." 和标签 `allow` / `flag` / `remove` 做实验，措辞为 "We asked how to moderate the comment …"；结果：无描述时 `allow 0.18, flag 0.48, remove 0.34`；加了 "Explicit threat of violence or doxxing" 等描述后 `allow 0.33, flag 0.52, remove 0.15`。结论："Write a description for any label whose boundary is not obvious from its name."
- 同一指南的其它示例：Choice "What is this support ticket about?"（选项 billing / technical / account / other）、Score "How upset is the customer?"（档位 "Calm"、"Mildly annoyed"、"Frustrated"、"Angry"）、Score "How urgent is this ticket?"（["Low", "Medium", "High"]，档位是程度词）。
- OpenAI 兼容路由 https://console.nace.ai/docs/drex/api-reference/decisions 的示例：Choice "Should we refund?"，选项 `true / false / "partial"`（这是 OpenAI Decisions 线格式的示例）。
- 问 Score 档位写法：Nace 问题指南："The array index is the score. `Calm` is 0 and `Angry` is 3. Order the levels from low to high."，只给了程度词，没有说「写情形而非程度」；官方 skill 说了（见 5.4）。

**推断**：Nace 的文档示例不遵守「问输入、代码查表」，而是直接问决策并按动作命名选项；档位多用程度词。这与 TypeSafe 的写法建议不同，但 Nace 没有说过两种写法孰优。

### 5.4 Nace 官方 skill、插件、llms.txt

- 有。**官方原文**：https://github.com/nace-ai/drex-agent-skills （MIT；非 fork；README 称 "Drex for coding agents"）。Claude Code 安装：`claude plugin marketplace add nace-ai/drex-agent-skills` / `claude plugin install drex@nace-ai --config make_default=true`。`plugin.json` 版本 `0.8.0`（提交 "Production hardening: implement-step fixes, faster scan, recall CI, docs (0.8.0)"，2026-10-15）；仓库 2026-11-10 仍有提交（README 与 `X-Nace-Client` 头）。两个 skill：`drex-for-harness`（设计并调用决策：路由、分类、排序、抽取校验、护栏、核对）和 `drexify`（扫描仓库里的决策点）。
- `drex-for-harness` 的 `SKILL.md` 里和问题层有关的原文（https://raw.githubusercontent.com/nace-ai/drex-agent-skills/main/skills/drex-for-harness/SKILL.md ）：

  > Start from the behavior the user wants, then work backward to the semantic judgments it requires. Keep deterministic checks, calculations, execution, and permissions in code.

  > | Route a request or select a bounded next action | `choice` over named destinations or actions | Validate arguments, enforce permissions, execute the selected handler |

  > | Rank candidates or assess quality, relevance, urgency, or risk | `score` against concrete ordered levels | Retrieve candidates, aggregate scores, apply reviewed thresholds |

  > | Handle uncertain cases | Probabilities inform an escalation branch | Choose a domain-tested threshold and route to a person or reasoning model |

  > Separate independently useful judgments. Give speculative questions explicit premises: questions in one request cannot read each other's answers.

  > `score.criteria` is an array of strings, lowest first. The API accepts one level, but use at least two so the score carries information. Describe concrete situations rather than vague labels when possible.

  > Start from the branch the application will take:

  > Typed output is not a truth guarantee. Confidence is not correctness, permission to act, or workflow success. A `noul` near 0.5 means uncertainty between yes and no, not medium intensity. Evaluate thresholds on representative data and consequences rather than copying a cookbook cutoff or another model's calibration.

  **推断**：Nace 的 skill 允许「选下一步动作」直接用 `choice` over actions（方式 B 的形态），同时要求 "Keep deterministic checks … in code" 并建议分开问独立的判断；没有「决策问题在错误层」的措辞。
- Nace 另有 `ndi-agent-skill`（连接 NDI 文档与 Drex 决策；未读正文）、CLI 内置的 `drex-search` 和 `drex-workspace` skill（https://console.nace.ai/docs/developer-tools/agent-skill ，面向文档搜索，不是决策问题设计）、远程 MCP 的 `decide` 工具（https://console.nace.ai/docs/developer-tools/hosted-mcp ）。
- llms.txt 和 llms-full.txt：有（上面）。Nace 的 skill 还引用 `https://drex.nace.ai/llms.mdx/docs/drex/<slug>/content.md` 这个路径形式，我没有访问 `drex.nace.ai` 域的页面（改读 `console.nace.ai`，skill 自己说两者是同一个 API）。

### 5.5 Nace 里与「为别的 agent 选 effort / 模型」有关的材料

- **官方原文**（https://console.nace.ai/docs/integrations/oh-my-pi ，社区贡献的集成："Drex support in Oh My Pi was contributed by the community."）列出终端编码 agent Oh My Pi 用 judge 角色回答的事：

  > The `auto` thinking level. With `omp --thinking auto` or `defaultThinkingLevel: auto` in `config.yml`, Drex rates how hard each prompt is, and omp picks the thinking level for that turn.

  这页没有给出问题措辞。
- **第三方原文**（Oh My Pi 源码，非 Nace 官方，https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/judge/auto-thinking.json ）：它问一个 Choice `level`，选项 `low / medium / high / xhigh / max`，措辞为：

  > The state is a user's request to a coding agent. Judge how open-ended its problem is: whether the fix or design is given, or which causes or designs remain open. Choose the reasoning effort that needs, judging inherent difficulty rather than phrasing politeness or verbosity. Volume of work never raises it. If torn between levels, choose the lower one …

  档位描述（情形式）："low": "One obvious solution, mechanically applied: target, mapping, or fix given."；"xhigh": "Open cause of flaky, concurrent, or stale behavior; solutions that are easy to get subtly wrong (races, invariants, cross-version compatibility)."；"max" 要求同时满足一个附加条件（无复现、不可逆或数据丢失、不能停的在线切换），并写 "Difficulty alone is insufficient."。
  源码 `classifier.ts` 的说明："A local on-device candidate gets the coarser `trivial|moderate|hard` question (3-class is more reliable than 4-way ordinal on sub-2B models), mapped to `low|high|xhigh`." 另有 `auto-prewalk/classifier.ts`：一个 Choice 问 "Decide where the strong model's reasoning has to be spent: before the first edit, or after it."，选项 `prewalk / primary / direct`，代码用 `AUTO_PREWALK_MIN_PROBABILITY = 0.7` 才启用。
  **推断**：这是一个真实在用的实现，写法是方式 B 的形态（直接选 effort 名），但档位描述是情形、并有「难度而非工作量」的限定；它不是 Nace 官方推荐，我没有它的评测数据。
- **未文档化**：Nace 官方材料里没有「选模型 / 选推理力度 / 评估任务难度」的配方、示例问题或评测。docs 页只有上面这一句话。

### 5.6 dbt / Postgres 等集成

这些页（ClickHouse、dbt、DuckDB、Postgres、Snowflake、Spark、BigQuery）提供 `drex_decide`、`drex_noul`、`drex_choice`、`drex_score` 函数，用来对每行提问。读过标题和说明，没有读到有关「问题该问什么层」的指导（**未文档化**）。

---

## 6. 两家关于「为另一个 LLM / agent 选模型、推理力度、任务多难」的材料

- **TypeSafe：没有配方。** **官方原文**（https://docs.typesafe.ai/concepts/use-case-map.md ，"Agents and verification" 的 "More ideas"）：

  > Model router: match each prompt to a model
  >
  > * Use Jev to build a custom router that chooses which LLM receives each prompt.
  > * Set routing rules and thresholds for your specific workflow.
  > * Classify each prompt's intent and subject area.
  > * Estimate difficulty and risk.

  这是唯一的相关文字；没有示例问题、没有页面。相邻的真实配方是 sde_cascade（先便宜模型，由 Jev 检查输出，规则被破坏才升级到 `reasoning_effort="high"` 的推理模型）：它检查「答案」，不评估「任务难度」，也不选 effort。**推断**：官方给出的「模型路由」路径是「分类意图和主题、估计难度和风险」，再由代码设规则和阈值，这与方式 A 同向；但没有写难度该怎么问。
- **TypeSafe 的 Jev 与 coding agent 的关系**（https://docs.typesafe.ai/introduction/coding-agents.md ，lastmod 2026-11-12）：

  > Jev is **not** a drop-in replacement for the LLM behind Claude Code, Cursor, opencode, Copilot, Muse Spark, Grok Bot, or similar tools. Instead, you can use your coding agent as usual to write code that uses Jev to make decisions.

  同页的适用场景之一："Route a request to one of a fixed set of destinations, and know how confident that routing is."、"Score something on a rubric (urgency, quality, risk) and branch on the number."
- **Nace：没有配方**（见 5.5）。
- 第三方实现（不是官方，仅作存在性记录）：Oh My Pi 的 auto thinking（5.5）；GitHub `atostivint/hermes-adaptive-effort`（Hermes 插件，用决策模型给每个请求设推理力度，Jev 为默认，可选 Nace Drex；Nace 的 GitHub 组织里有它的 fork）。我没有读它的问题措辞。

---

## 7. 近期变更：更新日志对问题写法有没有影响

**TypeSafe**（https://docs.typesafe.ai/changelog.md ，lastmod 2026-11-03）。**官方原文**：

> **Jev 1.14**
>
> October 14, 2026
>
> * Model ID `jev-1.14.0`.
> * Better multilingual support.
> * New Box question type, which finds where something is in an image and answers with a bounding box. Box questions need Jev 1.14.
> * Images can go in the `state`, `instructions`, or `criteria` of a request. This also works on Jev 1.13.
> * Long context raises both context limits to 262k tokens for requests that send the long-context header. This also works on Jev 1.13.

- 页面只列了 1.14 一条；1.13 没有条目、没有日期（**未文档化**）。https://docs.typesafe.ai/models.md 写 "Jev 1.14 is the newest Jev release, available from October 14, 2026."，`jev-latest` 指向 `jev-1.14.0`，`jev-preview` 也指向 `jev-1.14.0`。
- 对问题写法的影响：**未文档化**。更新日志没有改变问题写法的条目。skill 里有一处与版本相关的写法："As of Jev 1.14, this companion Noul usually works better than a "none of the above" option."（只关于「没有选项适用」，与决策层无关）。
- 其它与写法有关的页面内容（非更新日志）：https://docs.typesafe.ai/primitives/choice.md 写 "Add an `other` or `none of the above` option when the list might not cover every input"，同页下文又写 "A `none of the above` option may not work well in many use cases. As an alternative, ask a companion Noul question"；skill 写 "As of Jev 1.14, this companion Noul usually works better"。**推断**：同一份文档内这两处没有对齐，以 skill 与 patterns/companion-noul 的说法为准。

**Nace**：
- **未文档化**：没有更新日志页。
- 官方 GitHub（https://github.com/nace-ai/drex-decision-models ，README 里的日期）：2026-10-13 Drex v2.0；2026-10-14 Drex Max；2026-11-05 Drex 技术报告（https://arxiv.org/abs/2611.07854 ）。Hugging Face 数据集 `nace-ai/drex-max-v1.1-decision-index-results` 最后修改 2026-10-27（"Drex Max v1.1 … Decision Index: 70.79"）。
- 文档中的模型信息（https://console.nace.ai/docs/drex/reference/models ）："`drex-latest` is an alias. It currently points to <ModelName />"（占位符，实际值由页面组件渲染；官方 skill 称 `drex-latest` 指向 `drex-v2.0`，`drex-v1.1` 已退役，由 `drex-v1.5` 回答；Oh My Pi 集成页称 `nace/drex-max-v1.1` 是该 provider 的默认）。**推断**：官方各页对「当前默认模型」的说法并不一致，写代码前应以 `GET /v1/models` 为准。
  - **补充（2026-11-18，主会话用带渲染的抓取核对同一页）**：**官方原文**（https://console.nace.ai/docs/drex/reference/models ，渲染后）："When `model` is omitted, Drex selects `drex-max-v1.1`."、"`drex-latest` is an alias. It currently points to `drex-max-v1.1`. It moves to a newer version only on a date announced in advance"；表里 Drex Max v1.1 的发布日期是 2026-10-28，退役的 `drex-v1.0`、`drex-v1.1`、`drex-v1.5`、`drex-max` 现在都由 `drex-max-v1.1` 回答。官方 skill 里 "`drex-latest` is an alias for `drex-v2.0`" 的说法比这页旧，以页面为准。
- 对问题写法的影响：**未文档化**。没有任何发布说明改变问题写法建议。

---

## 8. 核对「方式 A / 方式 B」的结论（来源说什么，与我的推断分开）

### 官方来源说什么

1. TypeSafe 活文档与 skill 一致地说：模型给出判断，代码做决策；越过这一层的典型问题是 "Analyze this message and determine the best course of action"、"Should this ticket be escalated?"、"What should the agent do next?"（后两个只在 skill 里）。用 "Instead of asking Jev whether an email is fraudulent, ask about the signs of fraud" 做过具体示范。（**官方原文**）
2. TypeSafe 同时让 Choice 承担路由："Which team should handle this?"，选项描述的是内容；skill_suggestion 用 "is the right one to load" 的 Choice。（**官方原文**）
3. TypeSafe 的稳定性 cookbook 直接问「该做什么动作」，并且 Jev 的稳定性数字是在这种问法上测的。（**官方原文**）
4. TypeSafe 对有序结果的建议：一个 Score，档位写成情形，读概率分布，代码映射成动作；有一档一结局的先例（entity_alignment）。（**官方原文**）
5. Nace 没有谈层次；官方示例和 skill 直接问决策（"How should accounts payable handle this invoice?"、"Which priority should this ticket get?"、"choice over named destinations or actions"），同时说 "Keep deterministic checks … in code"。（**官方原文**）
6. 两家都没有任何「选模型 / 选 effort / 评估任务难度」的官方配方。（**未文档化**）

### 我的推断

- **方式 A 与 TypeSafe 的官方立场一致**，是比方式 B 更有依据的选择；skill 的这一节没有过时，是 2026-10-23 的 0.6.2 才加的，现行活文档在实质上给了相同的建议。
- 「一个 Score 问『这活有多费力』，五档各写成独立情形，另加条件 Noul（机械重复已知做法、先要找未知问题的原因），代码查表」落在 TypeSafe 的官方写法里。要点：档位描述要是情形，别用程度词；读 `probabilities`（例如把高档位的概率相加）而不只读 `score`；Noul 用 0.7 / 0.3 起步，中间带单独处理。
- **对 Nace**，方式 A 同样可行（Score 和 Noul 是它的原生类型；官方 skill 要求档位写具体情形、阈值在代码里复核），但没有官方材料说方式 B 更差；若 dispatch-pilot 同时支持两家，用同一套「问工作本身」的问题可以直接用于两家，只是不能指望 Nace 的材料为这种写法背书。
- 一个需要自己评测的点（不是官方结论）：Nace 官方示例里 Score 的档位常是程度词（"Low / Medium / High"），而 TypeSafe 明确说程度词没有情形词好；Nace 的 Drex 是否对此同样敏感，官方没有数据。旧笔记里 jev-pilot 把 effort 从 Score 改成按名字选的 Choice 的那条数据（来自第三方 CHANGELOG），与官方建议方向相反，但我没有核对它当时的档位写法，不能据此推翻官方建议。
- 如果要保留方式 B，可行的最小形态是：Choice 选项名用动作名，但每个选项的描述写成情形（Nace 的 `priority` p0…p3 和 Oh My Pi 的 `level` 就是这样），并同时问几个条件 Noul 作为代码里的覆盖规则。这是推断，没有官方评测。

---

## 附：读过的页面

### TypeSafe（2026-11-18 抓取；全部用 `.md` 形式，通过 Spider 抓取）

- https://docs.typesafe.ai/llms.txt ：索引，枚举全部页面。
- https://docs.typesafe.ai/sitemap.xml ：取 lastmod。
- 概念：introduction、introduction/quickstart、introduction/coding-agents、introduction/machine-learning-primer（只抓取，未细读）、concepts/use-case-map（全文）、concepts/system-one、concepts/state、concepts/how-to-build-with-system-one（全文）。
- 原语：primitives（全文）、primitives/choice、primitives/score（全文）、primitives/noul、primitives/box（未细读）、primitives/advanced（未细读）、images（未细读）、confidence（读了 "When to act" 一节及相关）。
- patterns：patterns、patterns/fan-out、noul-screen、companion-noul、confidence-routing（全文）、probability-routing（全文）、composite-scoring（全文）。后三个之外只读了开头和要点。
- cookbooks：cookbooks 索引；读了问题定义与读答案的代码段：function_calling、skill_suggestion、llm_guardrails、citation_check、verify_llm_outputs、classifying_rag_passages、basic_memory、classification_using_confidence、twitch_chat_filter、sde_cascade、entity_alignment、semantic_find、intelliprompter、consistency_choice_cookbook、consistency_noul_cookbook。
- demos：demos/smart-home、demos/content-audit；demos/airbnb-listing-search 只抓取。
- 模型：models、model-jaggedness、changelog、agent-skill。
- 跳过：sdk/*、api/*（接口参考，不涉及问题写法）、legal；其余未读 cookbook 见第 3 节末尾。
- 抓取了但只做了全文关键词搜索（"truth table"、"wrong layer"、"judgment"、"which model"、"reasoning effort"、"difficulty"、"router" 等）：上面所有 .md 页。
- GitHub：https://github.com/typesafe-ai/skills （标签、提交、`v0.5.7` 与 `main` 的 `SKILL.md`、`plugin.json`、`marketplace.json`）；本机 ~/.claude/plugins/marketplaces/typesafe-ai （git log 与 marketplace.json）。

### Nace（2026-11-18 抓取）

- https://console.nace.ai/llms.txt 、https://console.nace.ai/llms-full.txt 、https://console.nace.ai/sitemap.xml 。
- 读过（取自 llms-full.txt，与 `.md` 页对应）：docs/drex（Overview）、docs/drex/guides/questions（全文）、reading-answers（全文）、state（读了示例与「Send text, not media」）、drex-max（读了开头与 Finance 示例）、migrate-from-typesafe（关键词）、docs/drex/reference/models（全文）、docs/drex/api-reference/systemone 与 decisions（读了示例问题）、docs/developer-tools/agent-skill、hosted-mcp、mcp（关键词）、docs/integrations/oh-my-pi（全文）、docs/integrations/* 其余（关键词搜索）、docs/drex/reference/pricing（用途列表）。
- GitHub：https://github.com/nace-ai/drex-agent-skills （README、`plugin.json`、`marketplace.json`、`skills/drex-for-harness/SKILL.md` 全文、`skills/drexify/SKILL.md` 关键词）；https://github.com/nace-ai/drex-decision-models （README、提交）；https://huggingface.co/datasets/nace-ai/drex-max-v1.1-decision-index-results ；https://arxiv.org/abs/2611.07854 及其 HTML 版（只做了关键词搜索，没有通读）。
- 第三方：https://github.com/can1357/oh-my-pi 的 `packages/coding-agent/src/auto-thinking/classifier.ts`、`prompts/judge/auto-thinking.json`、`prompts/judge/auto-prewalk.json`、`auto-prewalk/classifier.ts` 和 `docs/prewalk.md`（开头）；https://github.com/nace-ai/hermes-adaptive-effort 的 README（这是 fork，上游 `atostivint/hermes-adaptive-effort`，只读 README）。

### 没有读到或不能读的

- Nace 控制台里需要登录的页面（Playground、Dashboard）：没有登录。
- `drex.nace.ai` 域的文档页（skill 引用的路径形式）：没有访问，用 `console.nace.ai` 的同名页替代。
- Nace 的 `ndi-agent-skill`、`langchain-nace`（有 router 与 model routing 中间件的说明）、`drexgrep`、`intern` 仓库：只在组织仓库列表里看到名称和简介，没有读正文；其中 `langchain-nace` 简介写 "classifier, router, LangGraph edge and agent middleware"，可能含路由问题示例，值得下一轮单独读。
- Drex 技术报告（arXiv 2611.07854）全文：没有通读。
- TypeSafe 的 Jev 1.13 发布日期和更新记录：文档里没有。
