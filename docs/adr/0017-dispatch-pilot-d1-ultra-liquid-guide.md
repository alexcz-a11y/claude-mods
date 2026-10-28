# Dispatch Pilot：文本决策可选 Liquid 的 d1-ultra，按 Liquid 官方的读法，和 Jev 分开

Liquid 的 d1-ultra 实现的是 TypeSafe 的 System One API（同样的 state、问题和回答），控制台写明所有模型零数据保留。2026-10-16 的核验（DEVELOPMENT.md「d1-ultra 核验」）用的是 Jev 的题和门槛。用户 2026-10-28 决定：默认文本决策仍是 Jev，图片固定用 Jev，文本类可以选 d1-ultra；d1-ultra 的分数门槛按 Liquid 官方的说法，和 Jev 分开；派出 agent 选模型直接按 Liquid 的官方示例；不做对比评测，直接接入；问题用什么语言可以开一个例外测试（一次请求，最多 10 道题，中英各 5 道）。

那次语言测试（d1-ultra，同一份 state，同样五个判断中英各问一遍）两种问法都答对，差距都在 0.03 以内，所以 d1-ultra 和 Jev 共用同一套英文题面。同一次请求 10 道题只计 1,641 个输入 token，证实控制台说的「billed its state and images once plus each question's own tokens」。

Liquid 的依据（2026-10-28 读的原文）：

- Decision Model Guide 的二元判断：`if p > 0.8: action = "block" elif p < 0.2: action = "allow" else: action = "human_review"`。
- 同一页的路由：`Choice(instructions="Which model tier should handle this request?", criteria={"fast": ..., "standard": ..., "powerful": ...})`，`# If the router is uncertain, fall back to the most capable tier`，`if confidence < 0.5: selected = "powerful"`；「You get a `confidence` value, so you can fall back to a stronger model when the router is uncertain instead of trusting a binary label」。
- 打分：「Levels are indexed from 0 ... The score is continuous ... You get the full probability distribution across all levels, so you can detect ambiguous cases」；示例拿连续分和档位比。
- decision-model skill：「Use Noul and convert its probability to an action using explicit thresholds. Do not cast a nonzero probability directly to a boolean」；「Set thresholds using representative data and the cost of incorrect decisions; example thresholds in the docs are illustrative」；「Treat HTTP or SDK errors as failures, not decisions」；「Keep separate calls when later questions depend on earlier results」；`d1-ultra`「most capable, for harder decisions」。
- 控制台 API 参考：pin「an exact id such as `d1-ultra`」，`:latest` 会变；每道题连同 state 最多 32,768 token；429 是限速。

决定：

- **后端**（`decision/liquid.ts`）：`decisionModel: d1-ultra` 选它，`POST https://api.liquid.ai/decisions/v1/systemone`，固定模型 `d1-ultra`。请求和回答就是 Jev 的（`postJson`、`readPosted` 共用），没有长上下文请求头，不收图、不问 Box。key 是新的敏感选项 `liquidApiKey`，留空读 `LIQUID_API_KEY`，处理同 `typesafeApiKey`。没有 key 时和 Jev 一样不发请求、看板写明缺哪个，不换后端。429 当限速（看板写「被限速」），读 `Retry-After`，不加 mod 自己的限速：Liquid 每个模型每秒 20 个，所有 key 共用，一个会话发不到。所有失败都当失败，不当答案（fail open）。
- **图片固定用 Jev**（`chooseImageBackend` 从不选 d1-ultra）：看图核对、带图路由、截图接管仍要 TypeSafe 的 key，没有就退到 pplx 或不可用，和以前一样。
- **读法写在一个地方**（`decision/guides.ts`），`BACKEND_DEFAULTS` 给每个决策模型一份，所有规则从 `ctx.config.guide` 读，用了哪条线记进每一步（ADR 0004）：
  - TypeSafe 的（Jev、pplx）：是非题 ≥ 0.7 是、≤ 0.3 否；effort 位置四舍五入，双峰再高一档；派出 agent 用模型表（ADR 0015）。
  - Liquid 的（d1-ultra）：是非题 > 0.8 是、< 0.2 否、中间拿不准（指南的 block / allow / human_review），用于主 agent 的各题、派出 agent 的出错代价和原因未知、点名模型、点名 effort、排除模型；effort 位置四舍五入，置信度 < 0.5 再高一档，代替双峰；派出 agent 用路由。主 agent 的 R1–R5、`confirm`、`escalate`（ADR 0016）规则不变，只换线。
- **派出 agent 的路由**（`decision/dispatched-agent.ts` 的 `readRoute`），贴近官方示例：
  - 一道选择题 `route`：「Which model tier should handle the work in `brief.prompt`?」，选项 `fast`（收集、查找、按要求列出，没有要决定的、没有要改的）→ haiku，`standard`（方法已知的常规软件工作）→ sonnet，`powerful`（出错代价高或难以挽回、故障原因未知、要选做法、依赖仓库外的事实，或数值、科学计算代码）→ opus；开了 `agentFable` 再加 `frontier`（严格证明，或没有已知答案的新算法、新架构）→ fable。
  - 取概率最高的一档；置信度 < 0.5 时退到可用模型里最强的（opus，开了 `agentFable` 是 fable；最强的被你排除就取次强的可用模型）。
  - 选中的模型被你排除：取可用的档位里概率最高的。
  - 你点名的模型（> 0.8）最优先；主 agent（Workflow 里是脚本）的指定只升不降，和 ADR 0015 一样。
  - 模型表那几道（`writes`、`few_steps`、`report_only`、`design_open`、`outside_facts`、`science_code`、`frontier`）在 d1-ultra 上不问；`stakes.undo`、`stakes.live`、`stakes.access`、`cause_unknown` 仍问，只为 effort 的下限（规则同 Jev，换线）。没有 ③b，所以也没有 ③b 的 max 下限；模型下限照旧（sonnet、opus 至少 medium）。
  - 看板写「路由 powerful 62%」、拿不准时「路由拿不准 → opus」；卡片写档位、概率、置信度、是否退到最强、排除换了什么；主 agent 的说明写「its router rated the brief as ...」。
- **预算和等待**（实测，2026-10-28，DEVELOPMENT.md「d1-ultra 的预算」）：Liquid 数的 token 是 mod 估算的 1.092 倍，所以沿用 Jev 的预算（effort、agent、Workflow 24000，带 skill 题的 6000），约 2.72 万 token 加最长的一题，在 32,768 的 83%。它比 Jev 慢：满预算的请求 2.0–2.7 秒（Jev 0.9 秒），所以 `timeoutMs` 默认 4000，`find_skill` 6000，skill 第二段至少 1500（没实测，按 token 比例推的）。
- **skill 推荐和 find_skill** 照现在的逻辑在 d1-ultra 上跑，门槛沿用 Jev 的，第 4 阶段按 cookbook 重写。

哪些是我们补的（Liquid 没写）：

- 打分题拿不准的规则：Liquid 只写了路由「置信度 < 0.5 退到最强」，打分题没写。我们借这个 0.5，只往上提一档，不直接到 max。
- 「最强的模型」指 opus，开了 `agentFable` 是 fable；最强的被排除时取次强的可用模型。
- 档位描述是我们按 dp 的工作写的（Liquid 示例的描述是聊天请求的：问候、摘要、多步推理）。
- 置信度没有回来时（Liquid 总会给）不退到最强。概率并列时取更强的档。

考虑过的其他做法：

- **d1-ultra 也用模型表**：用户要求选模型直接按 Liquid 的官方方法。
- **按字面，打分题拿不准直接到 max**：Liquid 的「fall back to the most capable tier」说的是路由；effort 一下拉满太贵，留给用户决定。
- **先做对比评测再接入**：用户决定不做。

代价：

- 没有评测：d1-ultra 的题、线和路由在 dp 的工作上准不准不知道，0.8 / 0.2 是 Liquid 写明的示意值。2026-10-16 的核验（Jev 的题）里 d1-ultra 在派出 agent 那套上显著不如 Jev 1.14（62.0 对 71.5）。
- 中间带比 Jev 宽（0.2–0.8 对 0.3–0.7），d1 的回答同一请求两次还会差约 0.08，拿不准的情况会更多：出错代价和原因未知更常抬到 high。
- 每条消息多等 1–2 秒（4000 毫秒的等待）。
- 选了 d1-ultra 还想用看图功能，要同时有 TypeSafe 的 key。
- eval 的 `--backend d1` 仍是 2026-10-16 那次核验的做法（Jev 的那一行默认值、模型表），和 mod 的 d1-ultra 不同。

版本号保持 0.9.0。

后来 ADR 0018 照 TypeSafe 的 skill 推荐 cookbook 重写了 skill 推荐和 `find_skill`，上面「门槛沿用 Jev 的」不再成立：d1-ultra 的两道门槛按 Liquid 的，三道门控题的平均低于 0.2 不推荐，候选的「是否正好做这件事」要高于 0.5（重排示例）才推荐或返回。
