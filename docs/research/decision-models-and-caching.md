# 决策模型（Jev / Clef）与 Claude 提示缓存 × 推理强度：调研记录

调研日期：2026-10-04。用途：为一个 Claude Code mod 选型。该 mod 每轮调用一个「决策模型」，为主循环挑选推理强度（effort），为子代理挑选模型和 effort，并挑选相关技能（skills）。

标注约定：
- **官方**：厂商自己的文档、博客或模型卡。
- **第三方**：独立作者或媒体，未经厂商确认。
- **推断**：由官方事实推出、文档里没有明说的结论。
- **未文档化**：查过的官方来源都没有写。

所有引文保持英文原文。所有 key 用占位符表示（`$TYPESAFE_API_KEY`、`$CLOUDFLARE_AUTH_TOKEN`），本文不含任何真实密钥。

---

## 0. 结论速览

| 问题 | 结论 | 来源 |
| --- | --- | --- |
| Jev 是什么 | TypeSafe 的 System One 决策模型。它不生成文本，只对 `state` 回答 typed 问题（`choice` / `score` / `noul`），并返回概率 | https://docs.typesafe.ai/concepts/system-one.md |
| Clef 是什么 | Cloudflare 的开源决策模型（27B，flash 版 9B），与 Jev 的 System One API 兼容。在 Workers AI 上托管，但被归类为 "Text Generation" | https://developers.cloudflare.com/workers-ai/models/clef/ |
| 价格 | Jev 为 $0.042/M 输入 token，输出免费。Clef 为 $0.24/M 输入（21818 neurons/M），clef-flash 为 $0.09/M（8182 neurons/M） | https://docs.typesafe.ai/models.md ；https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| 延迟 | Cloudflare 测得的中位数：Clef 209.3 ms，Clef-flash 38.8 ms，Jev 524.1 ms。TypeSafe 文档没有给延迟 SLA | https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/ |
| **Clef 风险** | 第三方报告：Workers AI 目前只读取 state 的前约 2K token，而官方标称 65,536。官方没有给出具体数字，**需要实测** | https://openrouter.ai/cloudflare/clef |
| 改 effort 是否破坏缓存 | **会**。改顶层 `output_config.effort` 一定使 messages 缓存失效，tools/system 是否失效因模型而异。例外：在支持 per-message effort 的模型上，用 `role: "system"` 消息改 effort 可以保住缓存 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| 改 thinking 是否破坏缓存 | **会**，规则与 effort 相同 | 同上 |
| 换模型是否破坏缓存 | **会**。原文："The cache is per-model." | https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics |
| Claude Code 主循环的 effort 档位 | `low` / `medium` / `high` / `xhigh` / `max`（另有 `auto` 和 `ultracode`，二者不是档位）。Haiku 4.5 **不支持** effort | https://code.claude.com/docs/en/model-config.md |
| 子代理 | 子代理有独立缓存，选择它的模型和 effort **不影响**父会话缓存 | https://code.claude.com/docs/en/prompt-caching.md |
| 中文 | Jev 官方声明 CJK「可用但准确率较低」。Clef 没有任何官方语言声明。两者都没有官方中文基准，详见第 4 节 | https://docs.typesafe.ai/models.md |

---

## 1. TypeSafe / Jev（A）

### 1.1 本地技能文件

- 位置：`~/.claude/plugins/cache/typesafe-ai/typesafe/0.5.7/skills/typesafe-ai/SKILL.md`（marketplace 副本在 `~/.claude/plugins/marketplaces/typesafe-ai/skills/typesafe-ai/SKILL.md`）。该插件**没有** `references/` 目录，只有 SKILL.md、README.md 和 LICENSE。
- 技能要求以在线文档为准："The live TypeSafe docs are the source of truth. Read them as part of the task." 文档索引是 https://docs.typesafe.ai/llms.txt 。

### 1.2 Jev 与 System One 是什么

- "System One models are a class of AI models built to make fast, structured decisions that software can use directly. A System One model evaluates a state and returns typed answers and probabilities."（https://docs.typesafe.ai/concepts/system-one.md）
- "Jev is TypeSafe's flagship model and the first System One model."（同上）
- "System One models do not write replies, produce code, or generate explanations of their reasoning."（同上）
- Jev 是用 RLCD（Reinforcement Learning for Calibrated Decisions）训练的："Higher probability should correspond to a greater chance that the answer is correct."（https://docs.typesafe.ai/introduction/machine-learning-primer.md）
- Jev 不能替代 Claude Code 背后的 LLM："Jev is **not** a drop-in replacement for the LLM behind Claude Code..."（https://docs.typesafe.ai/introduction/coding-agents.md）。它适合放在 mod 里**做决策**，正是本项目的用法。
- 目前只有 Jev 一个 System One 模型。版本为 `jev-1.13.0`，别名 `jev-latest` 和 `jev-preview` 都指向它（https://docs.typesafe.ai/models.md）。文档没有列出别的 System One 模型。

### 1.3 HTTP API

**端点与鉴权**（https://docs.typesafe.ai/api.md）：

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

- 环境变量：Python SDK 用 `API_KEY_ENV = 'TYPESAFE_API_KEY'`，基址用 `TYPESAFE_BASE_URL`（默认 `https://api.typesafe.ai`），默认模型用 `TYPESAFE_DEFAULT_MODEL`（默认 `jev-latest`）。SDK 默认超时 `DEFAULT_TIMEOUT = 10.0` 秒（https://docs.typesafe.ai/sdk/python/api/constants.md）。
- SDK 包名：Python 是 `typesafe-sdk`（`from typesafe_sdk import Choice, Noul, Score, TypeSafeClient`），JS 是 `@typesafe-ai/sdk`（https://docs.typesafe.ai/introduction/quickstart.md ；https://docs.typesafe.ai/models.md）。
- 列模型：`GET https://api.typesafe.ai/v1/models`（https://docs.typesafe.ai/models.md）。
- 另一条接入路径：OpenRouter Decisions API，`POST https://openrouter.ai/api/alpha/decisions`，模型 ID 为 `typesafe/jev-1.13` 或 `~typesafe/jev-latest`，只需要 OpenRouter key。TypeSafe SDK 把 base URL 设成 `https://openrouter.ai/api` 也能用（OpenRouter 官方博客：https://openrouter.ai/blog/insights/what-is-jev/ ）。
- 账户可用性（**第三方**新闻）：TypeSafe 于 9 月 22 日暂停新注册，9 月 27 日重新开放，但新账户不再赠送额度（https://jevainews.com/news/typesafe-signups-paused/ ）。

**请求体**（https://docs.typesafe.ai/api.md）：顶层字段为 `state`（string | object | array，必填）、`model`（必填，如 `"jev-latest"`）、`questions`（`map<string, Question>`，必填）。问题 ID 由调用方自定，"is not sent to the underlying model"。

三种问题：
- `noul`：是非题。`criteria` 可选（`{"true": ..., "false": ...}`），返回 `noul`（0–1）。
- `choice`：从你定义的选项里选一个。`criteria` 是「选项 → 描述」的 map，"You can have a maximum of 255 options per Choice."。返回 `choice`、`probabilities`（总和为 1）和 `confidence`。
- `score`：在有序档位上评分。`criteria` 是有序数组，"A Score should have at least two levels; the API accepts up to 10."。返回 `score`（概率加权，可以落在两档之间）、`legend`、`probabilities` 和 `confidence`。

响应体包含 `model`（实际版本，例如 `"jev-1.13.0"`）、`answers`（按问题 ID 索引）和 `usage.input_tokens/output_tokens`。

错误码：`401`、`422`、`429 Too Many Requests`、`529 Overloaded`。遇到 429/529 时"retry the request with exponential backoff"，官方 SDK 默认会自动重试（https://docs.typesafe.ai/api.md）。

**示例 1：effort 五档。** 档位有序，最自然的是 Score（上限 10 档，返回每档概率），也可以用 Choice。以下请求为**按官方 schema 组装的示意**：

```json
{
  "model": "jev-latest",
  "state": {"user_message": "...", "recent_context": "...", "repo_signals": {"files_touched": 3}},
  "questions": {
    "effort": {
      "type": "score",
      "instructions": "How much reasoning effort does the assistant need for `user_message`?",
      "criteria": [
        "low: trivial lookup, rename, or one-line answer",
        "medium: clear, well-scoped change or explanation",
        "high: debugging or multi-file change where edge cases matter",
        "xhigh: long-horizon agentic or architectural work",
        "max: hardest problems such as security audits or proofs"
      ]
    }
  }
}
```

代码里可以取 `probabilities` 的 argmax，或者对 `score` 四舍五入。官方提醒 Score 的插值"weak in numerical calibration"，适合做阈值判断，但不能用来精确换算数值（https://docs.typesafe.ai/model-jaggedness/jev-1.13.md）。档位描述要写成具体情境："Describe situations, not degrees."，而且"Every level is evaluated separately. The model doesn't see a level's number or its neighbours"（https://docs.typesafe.ai/primitives/score.md）。

如果改用 Choice，要注意选项顺序偏差："the order of a Choice's options can affect the answer, and `jev-1.13` leans toward the option that comes first. **Instead:** reorder the options and check the answer is consistent."（https://docs.typesafe.ai/model-jaggedness/jev-1.13.md）

**示例 2：从 N 个技能里选 top-k。** 官方有一份几乎同题的 cookbook，见 1.7。核心做法是：一个 Choice 覆盖全部技能（`criteria` 为「技能名 → 描述」），按 `probabilities` 排序取 top-k；再配几个 Noul 判断「这一轮是否需要技能」；第二次请求只对 top-3 带上完整描述做复核。

### 1.4 类型化输出、概率与置信度

- Choice 置信度公式：$(p_{max}-1/n)/(1-1/n)$。Score 的公式会考虑偏离峰值的档位距离。Noul 没有单独的置信度："The probability already carries the uncertainty"（https://docs.typesafe.ai/confidence.md）。
- 官方建议按风险设置阈值："A confidence threshold is not one number... Your code encodes the risk tolerance."，并给出两种替代指标：top probability 和 top-to-second ratio（同上）。
- 意图路由的示例代码在 `intent.confidence < 0.5` 时转人工（https://docs.typesafe.ai/patterns/intent-routing.md）。
- "Typed output guarantees the interface, not truth."（本地 SKILL.md）

### 1.5 延迟

- **官方文档没有给出延迟 SLA，也没有 p50/p95 数字。** 只有 cookbook 里的单次计时（jev-1.12）：
  - 技能建议 cookbook：全量排序 182 个技能的单次请求耗时 0.31 s、0.16 s、0.16 s；对 top-3 复核耗时 0.12 s、0.09 s、0.09 s（https://docs.typesafe.ai/cookbooks/skill_suggestion.md）。
  - 并行问题 cookbook：在约 54K 字符的文章上，一次请求 13 个问题平均 0.27 s；拆成 13 次调用总计 2.71 s（https://docs.typesafe.ai/cookbooks/parallel_questions.md）。
  - 选择题文档："Adding questions barely changes the response time"（https://docs.typesafe.ai/primitives/choice.md）。
- **Cloudflare 测得**（43 项基准）：Jev median 524.1 ms，p95 536.0 ms（https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/ ；https://huggingface.co/Cloudflare/clef ）。
- **第三方**（jev-fanout-bench，经 OpenRouter 调用）：在复用连接、1 个问题的条件下，1K token 时 375 ms，32K token 时 734 ms；新建 HTTPS 连接需 1,630 ms（https://huggingface.co/datasets/lisonallen/jev-ai-benchmark ）。**推断**：mod 应该复用 HTTP 连接，否则握手时间会占掉大部分延迟。

### 1.6 价格、速率与上下文

| 项 | 值 | 来源 |
| --- | --- | --- |
| 价格 | "$42 / $0.042"（per Btok / per Mtok）。"Charged per input token. Output tokens are free." | https://docs.typesafe.ai/models.md |
| 速率 | "100K tokens per second / 80 requests per second"。官方警告："Rate limits are adjusting dynamically... can change without notice" | 同上 |
| 上下文 | "64k tokens per request; 32k tokens for `state` plus the longest question"。Cloudflare 博客把 Jev 写成 "Jev's 32k"，与此不一致，以 TypeSafe 官方为准 | 同上 ；https://blog.cloudflare.com/clef-decision-models/ |
| 输入 | "Text only. String, JSON object, or array of text values." | 同上 |
| 第三方实测 | 每次请求固定约 261 token 开销；每个问题约 8 token 框架；带短描述的 Choice 选项约 21 token；上下文上限实测在 32,768 和 65,536 附近 | https://huggingface.co/datasets/lisonallen/jev-ai-benchmark |

**能放下多少技能描述（推断，系数来自第三方）**：
- 一个 Choice 最多 255 个选项。整个 Choice 算作一个「问题」，所以 `state` 加上这个 Choice 必须 ≤ 32K token。
- 按每个选项约 8 token 的框架开销加上英文描述约 1 token/词估算：60 个技能、每个描述约 80 词，大约 60 × 90 ≈ 5.4K token，余量很大。
- 255 个技能、每个 100 词，大约 27K token，就会挤占 state 的预算。这时要按官方建议分块排序："A few times larger and you would split it into chunks and rank each one"（https://docs.typesafe.ai/cookbooks/skill_suggestion.md）。
- 中文描述的 token 成本见第 4 节。
- 官方提醒 state 越大准确率越低："Accuracy falls as the state grows with content unrelated to the decision."（https://docs.typesafe.ai/model-jaggedness/jev-1.13.md）。所以 state 只放本轮相关的内容。

### 1.7 官方 cookbook：路由与选型

- **Skill suggestion**（与本 mod 的选技能需求同题）：https://docs.typesafe.ai/cookbooks/skill_suggestion.md
  - 两次请求。请求 1 用一个 Choice 覆盖全部 182 个技能，再加 3 个「是否要动手做事」的 Noul 作门控（均值 < `GATE_THRESHOLD = 0.30` 时不建议任何技能）。请求 2 只对 top-3（`SHORTLIST = 3`）带完整描述加 SKILL.md 开头 700 字符，用一个 Choice 和每个候选一个 `fits::{name}` Noul 复核（最高 Noul < `FITS_THRESHOLD = 0.30` 时放弃）。
  - 效果（agent 为 `claude-haiku-4-5-20251001`，488 条请求）：wrong load 从 16.8% 降到 7.3%，needless load 从 9.8% 降到 4.0%。
  - **与缓存的配合方式（可直接借鉴）**：建议文本写成 `<skill_relevance>` 块，追加在带 `cache_control` 的技能清单**之后**。"The roster itself never changes, so any prefix caching over it still holds."
  - 无建议时也要明确写一句"No skill in the roster appears relevant to this request."，否则清单原有的"err on the side of loading"指令会失去制衡。
- **Intent routing**：用一个 Choice 判意图、一个 Score 判复杂度，置信度不足时升级处理（https://docs.typesafe.ai/patterns/intent-routing.md）。
- **SDE cascade**："mini → verify → reasoning"，按需升级到推理模型（索引条目：https://docs.typesafe.ai/llms.txt ；正文未细读）。
- **Confidence-gated routing**：https://docs.typesafe.ai/patterns/confidence-routing.md（正文未细读）。
- **Speculative fan-out**：把所有可能用到的问题放进同一次请求，由代码决定用哪些答案（https://docs.typesafe.ai/primitives/choice.md ；https://docs.typesafe.ai/cookbooks/parallel_questions.md ）。对本 mod 的含义：effort、子代理模型、子代理 effort 和技能排序可以合并成**一次**请求，并行求值，互不可见。

---

## 2. Cloudflare Workers AI「Clef」（B）

### 2.1 Clef 是什么

- "Clef is a 27B multimodal decision model that turns a state and a schema of typed questions into decisions. It reads the state as text, JSON, images, or video, and returns a probability for every allowed option of every question."（https://developers.cloudflare.com/workers-ai/models/clef/）
- 它是**决策模型**（与 Jev 同族），不是生成式 LLM，也不是传统的固定标签分类器。目录把它归在 "Text Generation" 类别下（同上）。
- "Clef is a decision model, in the same family as Typesafe's Jev... There is no free-form output to parse and no reasoning tokens to wait for."（https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/）
- 两个尺寸：`@cf/cloudflare/clef`（27B，基于 Qwen3.8-27B）和 `@cf/cloudflare/clef-flash`（9B，基于 Qwen3.5-9B）。权重以 Apache-2.0 开源（https://huggingface.co/Cloudflare/clef ；https://huggingface.co/Cloudflare/clef-flash ）。
- 架构："Clef uses Qwen for a prefill-only pass, then scores the valid schema choices in parallel. The decision step is non-autoregressive"（https://blog.cloudflare.com/clef-decision-models/）。
- 与 Jev 兼容："Clef follows the System One API, so you can switch an existing Jev integration to Clef by changing the endpoint and model."（changelog）

### 2.2 输入输出 schema

输入（官方 JSON Schema：https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json ）：
- `model`：**必填**，匹配 `^\s*(clef|clef-flash)\s*$`。注意 URL 路径里已有模型名，body 里仍然必须填。
- `state`：必填。"Long text state is truncated to fit the model's token limit."
- `questions`：`minProperties: 1`，`maxProperties: 64`。问题 ID 可用字母、数字、`_`、`.`、`-`，最长 100 字符。
  - Choice："2 to 255 options"。
  - Score："2 to 10 levels"。
  - Noul 的 `criteria.true/false` 可选。
- `images`：Clef 对 System One API 的扩展。最多 4 张，每张 4 MiB / 16 MP，解码后合计 8 MiB；整个请求体最大 13 MiB；不接受远程 URL。

输出（https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json ）：`model`、`answers`（noul / choice / score 三种结构与 Jev 相同，choice 和 score 都带 `confidence`）、`usage.input_tokens/output_tokens`。

### 2.3 在 Worker 之外用 REST 调用

```bash
curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_AUTH_TOKEN" \
  -d '{"model": "clef", "state": "...", "questions": {"urgent": {"type": "noul", "instructions": "Is this support request urgent?"}}}'
```

（官方示例：https://developers.cloudflare.com/workers-ai/models/clef/ 。flash 版把路径和 `model` 都换成 `clef-flash`：https://developers.cloudflare.com/workers-ai/models/clef-flash/ 。）

- Token：在 Dashboard 的 Workers AI 页面选 "Use REST API"，再点 "Create a Workers AI API Token"。这样得到的是"an API token that grants Workers AI read permissions to your account"（https://developers.cloudflare.com/workers-ai/get-started/rest-api/）。
- 响应外壳：REST 入门页的通用格式是 `{"result": {...}, "success": true, "errors": [], "messages": []}`（同上）。**推断**：Clef 的 `answers` 位于 `result.answers`。Clef 页面没有展示 REST 响应原文，需实测确认。
- 也可以经 AI Gateway 调用："You can also use AI Gateway with these endpoints."（changelog）

### 2.4 延迟

| | Clef | Clef-flash | Jev |
| --- | --- | --- | --- |
| Median | 209.3 ms | 38.8 ms | 524.1 ms |
| p95 | 238.6 ms | 122.4 ms | 536.0 ms |

上表是 Cloudflare 官方在 43 项基准上测得的模型请求延迟（https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/ ；https://huggingface.co/Cloudflare/clef ）。

**第三方**数据：OpenRouter 页面显示 Clef 经 OpenRouter 的端到端 P50 为 0.73 s（近 3 天均值 0.60 s），P95 均值 1.54 s，包含网络往返（https://openrouter.ai/cloudflare/clef ）。clef-router 的说明是："Latency depends on your network to Cloudflare. The 38.8 ms median is Cloudflare's measurement; add your round trip."（https://pypi.org/project/clef-router/0.3.0/）

### 2.5 价格（neurons）

- Workers AI 统一按 "$0.011 per 1,000 Neurons" 计价，每天免费 10,000 neurons，超出需要 Workers Paid 计划（https://developers.cloudflare.com/workers-ai/platform/pricing/）。
- `@cf/cloudflare/clef`："$0.240 per M input tokens"，即 "21818 neurons per M input tokens"。
- `@cf/cloudflare/clef-flash`："$0.090 per M input tokens"，即 "8182 neurons per M input tokens"。
- 输出不计费（定价表只列输入；OpenRouter 显示输出 $0）。
- **推断**：每日免费额度约合 Clef 458K 输入 token（10,000 / 21,818 M），或 clef-flash 约 1.22M 输入 token。
- **第三方**：clef-router 实测平均每次决策 324 输入 token，约合 $0.078 / 千次决策（https://pypi.org/project/clef-router/0.3.0/）。

### 2.6 上下文与限制

- 官方标称：Context Window 65,536 tokens（模型页）。Changelog 表格写的是 "64K tokens"。
- **重大风险（第三方报告，官方没有给出数字）**：
  - OpenRouter 模型页："Note: Workers AI currently truncates long text state to roughly the first 2K tokens, so content beyond that is not read; images are counted separately."（https://openrouter.ai/cloudflare/clef）
  - decisions-api.dev："Clef models currently read only about the first 2K text-state tokens on Workers AI, despite the 65,536-token listing."（https://decisions-api.dev/model/clef）
  - 官方 schema 只写了 "Long text state is truncated to fit the model's token limit."
  - **建议**：上线前实测，发送一个已知长度的 state，比较 `usage.input_tokens`，并在 state 末尾放一个探针事实看模型能否读到。
- 本地运行时，HF 代码 `encode_record` 的 `max_length` 默认 16,384 token，可用 `max_state_tokens` 另行限制（https://huggingface.co/Cloudflare/clef）。
- 速率限制：Limits 页只按任务类型列出。"Text Generation: 300 requests per minute, unless the model requires the Workers Paid plan"（https://developers.cloudflare.com/workers-ai/platform/limits/）。Clef 页面没有写需要 Paid 计划，所以**推断**适用每分钟 300 次。Clef 专属的限额**未文档化**。
- 数据承诺："we don't read, store, or train on your requests or responses (unless you want to use our fine-tuning product"（https://blog.cloudflare.com/clef-decision-models/）。

### 2.7 是否适合「选 effort 档 / 选模型 / 选技能」

- **适合，但有条件（推断）**。三类任务都能直接映射到 System One 原语：
  - effort 用 Score 或 Choice。
  - 子代理模型用 Choice，例如 `haiku`/`sonnet`/`opus`/`fable`。
  - 技能用 Choice（≤255 个选项）加每个候选一个 Noul（≤64 个问题）。
- Cloudflare 自己列的用例里就有 "Agent guardrails: Let an agent check "should I take this action?" in tens of milliseconds before calling a tool."（changelog）
- 在 Decision Index 里，**RouterBench（selected quality）**是专门的路由基准，三者几乎持平：Clef 79.7，Clef-flash 79.9，Jev 79.9（https://huggingface.co/Cloudflare/clef ）。这说明在路由任务上 Clef 并不比 Jev 更强，优势主要在延迟。
- **主要障碍**：上面提到的约 2K token state 截断。如果属实，state 里只能放「本轮用户消息 + 极简摘要」，不能放长上下文。
- **用作路由器的例子（第三方）**：`clef-router`（PyPI，Apache-2.0）是一个 OpenAI 兼容代理，用 Clef 在 cheap 与 frontier 两档模型之间路由。
  - 问题集是 `team`、`urgency`。
  - 策略："When the `team` answer names a tier, that tier wins, unless its confidence is below `min_confidence` (default 0.45), which escalates to frontier."
  - 默认模型为 `clef-flash`。
  - 来源：https://pypi.org/project/clef-router/0.3.0/
- 官方没有发布把 Clef 用作路由器的教程（**未文档化**）。

---

## 3. Anthropic 提示缓存 × effort / thinking / 模型（C）

### 3.1 改 effort 会不会使缓存失效：会（有例外）

prompt caching 文档的失效表，"Effort setting" 行（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）：

> | **Effort setting** | Model-specific | Model-specific | ✘ | Changing the [`output_config.effort`](https://platform.claude.com/docs/en/build-with-claude/effort) value always invalidates message blocks, with the same model-specific effect on tool and system caches as thinking parameters. Setting effort explicitly to the model's default is equivalent to omitting it and does not invalidate. On models that support [per-message effort](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta), an effort change carried in a `role: "system"` message inside `messages` leaves the cached prefix intact. |

（三列依次是 Tools cache、System cache、Messages cache。）

effort 文档（https://platform.claude.com/docs/en/build-with-claude/effort）：

> "You can run later turns of a conversation at a different effort level in two ways. On Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, Claude Opus 5, and Claude Sonnet 5.5, use a per-message effort change, which keeps the prompt cache. On other models, set a new top-level value on the next request, which starts the cache over."

> "Because top-level effort shapes the rendered prompt, changing it between requests doesn't preserve cached prefixes from earlier turns. If you rely on prompt caching across a long session and your model doesn't support per-message effort, pick an effort level at the start and keep it constant."

per-message effort 的具体写法（同页）：

- 需要 beta header `mid-conversation-output-config-2026-07-01`。
- 在 messages 中插入 `{"role": "system", "content": [], "output_config": {"effort": "low"}}`。"The new level takes effect from the next `user` turn and holds until a later message changes it. Everything before that message is unchanged, so the cached prefix still matches."
- 不支持的模型返回 400：`output_config.effort requires a model that supports per-turn effort; this model does not`。
- Sonnet 5.5 在 `thinking: {"type": "between_tools"}` 下不能中途改 effort："a per-message `output_config.effort` that differs from the level in effect returns a 400 error."
- 对 Fable 5.1，官方更推荐 per-message 方式："A top-level change restarts the cache and also steers the model less reliably"。

**tools/system 缓存的「Model-specific」**：文档没有列出哪些模型把配置渲染在 tools/system 之前（**未文档化**）。thinking 文档的说法是 "tool and system-prompt breakpoints can miss too, depending on where the model renders the configuration"，并建议 "Treat any thinking or top-level effort change as starting the cache over."（https://platform.claude.com/docs/en/build-with-claude/thinking）

### 3.2 改 thinking（模式或预算）会不会使缓存失效：会

失效表 "Thinking parameters" 行（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）：

> | **Thinking parameters** | Model-specific | Model-specific | ✘ | The thinking configuration (mode, and `budget_tokens` in extended mode) is rendered into the prompt, so changing it always invalidates message blocks; tool and system caches are also invalidated on models that render the configuration ahead of them. |

thinking 文档的 "Thinking and prompt caching" 一节（https://platform.claude.com/docs/en/build-with-claude/thinking）：

> "**Configuration changes invalidate caching.** The thinking configuration and the resolved `effort` level are rendered into the prompt itself, so changing any of them starts a new cache prefix. Switching between `adaptive`, `enabled`, and `disabled`, changing `budget_tokens`, and changing the effort value all invalidate cache breakpoints: message-level breakpoints always miss, and tool and system-prompt breakpoints can miss too, depending on where the model renders the configuration. Treat any thinking or top-level effort change as starting the cache over. ... Consecutive requests that keep the same configuration preserve the cache, and setting a parameter explicitly to its default value is equivalent to omitting it."

FAQ："Changing thinking parameters (switching modes, or changing the budget in extended mode) invalidates cached message prefixes, and can invalidate cached system prompts and tools as well, because the thinking configuration is rendered into the prompt. The `output_config.effort` value behaves the same way."（prompt caching 页）

同页的另外两条：
- 预热缓存时："Use the same thinking configuration and `output_config.effort` as your follow-up requests too"。
- 排障清单："Verify that `tool_choice`, image usage, the thinking configuration, and `output_config.effort` remain consistent between calls"。

### 3.3 换模型会不会使缓存失效：会

- cache diagnostics 的 `cache_miss_reason` 表："`model_changed` | The `model` differs from the previous request (for example, a router, A/B test, or fallback selected a different model). The cache is per-model. | Hold the model constant within a cached conversation."（https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics）
- Claude Code 文档："Each model has its own cache. Switching with `/model` means the next request reads the entire conversation history with no cache hits, even though the content is identical."（https://code.claude.com/docs/en/prompt-caching.md）
- 同一页还说，如果 skill 的 frontmatter 指定了别的 `model`，那一轮也算一次换模型。

### 3.4 Claude Code 中的行为（对 mod 最关键）

https://code.claude.com/docs/en/prompt-caching.md ：

> "**Effort level**: on most models, each effort level has its own cache, so changing effort mid-session recomputes the entire request. On Opus 5.5, Sonnet 5.5, and Fable 5.1 with an API key or a Claude subscription, the cache stays intact by default."

> "On Opus 5.5, Sonnet 5.5, and Fable 5.1 with an API key or a Claude subscription, changing effort keeps the cache, and Claude Code applies the new level without asking. This doesn't apply on Amazon Bedrock, Google Cloud's Agent Platform, or a Claude apps gateway, or when you set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` or your organization has a HIPAA configuration."

> "Before v2.1.260, changing effort on Fable 5.1 with an API key or a Claude subscription also invalidated the cache."

**推断**：Claude Code 在这三个模型上用的就是 API 的 per-message effort beta。API 文档也把 Opus 5 列为支持 per-message effort，但 Claude Code 文档只点名了 Opus 5.5、Sonnet 5.5 和 Fable 5.1。Opus 5 在 Claude Code 里是否保缓存**未文档化**。

**技能注入保缓存**："Skills and commands inject their instructions as user messages at the point of invocation. Nothing earlier in the conversation changes."（同页）

**子代理与父缓存互不影响**（同页）：

> "A subagent starts its own conversation with its own system prompt and tool set, separate from the parent's. Its first request doesn't read the parent's cache, because the two prefixes differ, and it warms a cache of its own across its turns. ... The parent's cache is unaffected. From the parent's side, the subagent's call and result append to the conversation, leaving the parent's prefix intact."

**推断，对架构影响最大**：
- 为子代理选模型和 effort，对父会话缓存是零成本的。Claude Code 也已经支持在 subagent / skill 的 frontmatter 里写 `effort` 和 `model`（https://code.claude.com/docs/en/model-config.md ）。
- 只有**主循环每轮换 effort** 才牵涉缓存。走 Claude Code 自带的 effort 切换路径时，在 Opus 5.5 / Sonnet 5.5 / Fable 5.1 + API key 或订阅的组合下不丢缓存。其他模型和其他接入方式下，每次改档都等于重算整段历史。
- 本次**未调研**：mod 能否用程序化手段触发这条保缓存路径，例如通过 hook 设置每轮 effort。

### 3.5 Claude Code 主循环的 effort 档位与模型支持

Claude Code 文档的档位表（https://code.claude.com/docs/en/model-config.md）：

| Model | Levels |
| :- | :- |
| Fable 5.1 and Fable 5 | `low`, `medium`, `high`, `xhigh`, `max` |
| Opus 5.5, Sonnet 5.5, Opus 5, Sonnet 5, Opus 4.8, and Opus 4.7 | `low`, `medium`, `high`, `xhigh`, `max` |
| Opus 4.6 and Sonnet 4.6 | `low`, `medium`, `high`, `max` |

- 文档还写明："Models not listed here do not support effort"。
- 设置方式：`/effort`（交互滑块、直接写档位名、`/effort auto` 清除）、`--effort`、`CLAUDE_CODE_EFFORT_LEVEL`、`modelSettings` / `effortLevel`（"`max` isn't accepted as a level in either key"），以及 skill 或 subagent frontmatter 里的 `effort`。
- 回落规则："If you set a level the active model does not support, Claude Code falls back to the highest supported level at or below the one you set."
- `ultracode` "is a Claude Code setting rather than a model effort level"。
- 默认档："`high` on every model that supports effort, except that Opus 5.5 and Sonnet 5.5 default to `medium`, Opus 4.7 defaults to `xhigh`"。
- 档位跨模型不可比："The effort scale is calibrated per model, so the same level name does not represent the same underlying value across models."

用户点名的四个模型：

| 模型 | API 支持的 effort 档 | API 默认 | Claude Code 默认 | thinking 约束 | 来源 |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | low / medium / high / xhigh / max | `medium` | `medium` | 不能关 thinking（`disabled` 返回 400）。支持 per-message effort | https://platform.claude.com/docs/en/build-with-claude/effort ；https://platform.claude.com/docs/en/build-with-claude/thinking |
| Sonnet 5.5 | low / medium / high / xhigh / max | `high` | `medium` | 最低设置是 `between_tools`，只在 ≤`high` 时可用。支持 per-message effort（`between_tools` 下除外） | 同上 ；https://code.claude.com/docs/en/model-config.md |
| Haiku 4.5 | **不支持 effort** | — | — | 只支持 `enabled` + `budget_tokens`（`adaptive` 返回 400）。不支持 interleaved thinking。缓存最小长度 4,096 token | effort 页 Compatibility 列表（不含 Haiku）；thinking 页配置表；prompt caching 页 |
| Fable 5.1 | low / medium / high / xhigh / max | `high` | `high` | 不能关 thinking。支持 per-message effort | effort 页 ；thinking 页 |

API 层的完整支持列表：
- `max`："Available on Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, Claude Mythos 5, Claude Mythos Preview, Claude Opus 5.5, Claude Opus 5, Claude Opus 4.8, Claude Opus 4.7, Claude Opus 4.6, Claude Sonnet 5.5, Claude Sonnet 5, and Claude Sonnet 4.6."
- `xhigh`：同上，但去掉 Mythos Preview、Opus 4.6 和 Sonnet 4.6。
- Compatibility 区块列出的支持模型为：Fable 5 and 5.1；Mythos 5, 5.1, and Preview；Opus 4.5, 4.6, 4.7, 4.8, 5, and 5.5；Sonnet 4.6, 5, and 5.5（https://platform.claude.com/docs/en/build-with-claude/effort ）。

### 3.6 其他与缓存相关的数字

- 最小可缓存长度：Fable 5.1、Opus 5.5、Sonnet 5.5 为 512 token；Haiku 4.5 为 4,096 token（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）。
- 缓存读价格：Opus 5.5 为 0.05× 基础输入价，Fable 5.1 为 0.025×，其余模型为 0.1×（同上）。
- `max_tokens: 0` 可用于预热缓存（同上）。
- cache diagnostics 遇到 `output_config` 或 `thinking` 不同时，返回 `unavailable` 而不是 `*_changed`："another prompt-affecting request parameter (`tool_choice`, `thinking`, `context_management`, `output_config`, ...) differs"（https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics）。

---

## 4. 中文支持

### 4.1 Jev / TypeSafe

**语言支持（官方）**：
- "Jev accepts natural-language text. English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; test on your own content before relying on Jev for a non-English workload, and pay close attention to Confidence when routing."（https://docs.typesafe.ai/models.md ，Language support 一节）
- "Jev's primary training language is English; other languages, including CJK scripts, are accepted but currently have lower accuracy"（https://docs.typesafe.ai/concepts/state.md）

**多语言基准**：官方没有发布中文或多语言的准确率数字（**未文档化**）。

**分词与上下文**：
- 官方没有公开 Jev 的 tokenizer，也没有中文 token 换算系数（**未文档化**）。
- **第三方实测**（jev-fanout-bench，经 OpenRouter 调用 jev-1.13 计费 token；https://huggingface.co/datasets/lisonallen/jev-ai-benchmark ）：
  - 每个计费 token 对应的字符数：English 4.92，Chinese 1.00，Japanese 1.01，JSON 2.4。原文："Chinese and Japanese cost ~5× more tokens per character than English"。
  - 注意这是**按字符**比，不是按语义量比。一个汉字的信息量远高于一个英文字母，因此「同一句话中文比英文贵 5 倍」**不能**由此推出。
- **推断**（用第三方系数）：32K token 的 state 预算约等于 3.2 万汉字；一条 200 字的中文技能描述约 200 token。
- 同一来源给出的建议（第三方）："**Keep the questions in English** even when the text is not: translating the questions as well as the text cost 9–48% more tokens and moved yes/no answers further from the English baseline in all seven languages we tried."
- **推断**：本 mod 的 `instructions` 和 `criteria`（技能描述、档位描述）尽量用英文；中文只放在 `state`（用户消息）里。

**自己提升中文准确率的手段（官方）**：
- **少样本或示例**：Choice 和 Score 的 `criteria` 可以写成对象，自定义字段（例如 `what`、`not_for`、`examples`）。"The field names ... are not part of the API, and none are reserved."（https://docs.typesafe.ai/primitives/choice.md ）
  - 示例要贴近真实输入才有用："Examples steer the model, and they only help when they look like your real inputs."（https://docs.typesafe.ai/primitives/score.md ）
  - **推断**：可以在 `examples` 里放中文样例。官方没有专门评估中文示例的效果。
- **自定义标签和描述**：选项名和描述完全由调用方定义（https://docs.typesafe.ai/api.md ）。
- **微调：官方不提供**。"Jev is not fine-tuned or LoRA-adapted with customer data. It is trained with RLCD to return calibrated decisions, and the same weights serve every account. You shape its answers to your domain through the request rather than through per-account weights"（https://docs.typesafe.ai/models.md ）。
- **事后校准**：
  - 官方建议用自己的数据定阈值（https://docs.typesafe.ai/confidence.md ）。
  - 官方有一份 cookbook 把 Jev 概率作为特征，训练下游 CatBoost 模型："the AutoResearch cookbook for training a downstream classical model on Jev's probabilities"（https://docs.typesafe.ai/models.md ）。
  - **推断**：可以对中文样本单独拟合阈值，或做一层校准。

### 4.2 Cloudflare Clef

**语言支持**：
- Clef 的模型页、changelog、博客和 HF 模型卡**都没有**语言支持声明，也没有中文声明（**未文档化**）。
- 基座模型的声明（不能直接等同于 Clef）：
  - Clef-flash 的基座 Qwen3.5-9B 模型卡写有 "Expanded support to 201 languages and dialects"（https://huggingface.co/Qwen/Qwen3.5-9B ）。
  - Clef 的基座 Qwen3.8-27B 模型卡（README 全文已检索）没有语言数量声明，只写了 "Built on the architectural foundation of Qwen3.5"（https://huggingface.co/Qwen/Qwen3.8-27B ）。
- Cloudflare 后训练用的是"our own internal synthetic datasets"，语种未说明（https://blog.cloudflare.com/clef-decision-models/ ）。

**多语言基准**：
- 官方 Decision Index 0.2.1 在模型卡上列了 41 项基准（BFCL、BANKING77、CLINC150、RouterBench、MMLU 等），没有一项被标为中文或多语言（https://huggingface.co/Cloudflare/clef ）。**推断**（依据数据集名称）：这些都是英文任务或与语言无关的任务。
- **第三方**：MindStudio 测试过一张乌兹别克语新闻截图，Clef 识别出语言（95.9%）和主题（https://www.mindstudio.ai/blog/clef-27b-multimodal-capabilities-test ）。这不是中文，也不是系统评测。

**分词与上下文**：
- Clef 用 Qwen 基座的 tokenizer（HF 仓库里有 `tokenizer.json`）。Clef 处理中文的 token 效率，官方**未文档化**。
- 如果约 2K token 的 state 截断属实（见 2.6），按第三方的 Jev 系数（1 汉字 ≈ 1 token）粗算，Workers AI 上大约只能读约 2,000 个汉字。这是**推断**，因为两种 tokenizer 不同，必须实测。

**自己提升中文准确率的手段**：
- **少样本或示例、自定义标签**：Clef 的 schema 与 Jev 相同，`criteria` 接受 "string, object, array, or null"（https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json ）。因此 4.1 里的结构化示例写法同样适用。Clef 是否同样受益，**未文档化**。
- **微调（官方）**：
  - Cloudflare 提供 RL 微调服务，目前以设计伙伴形式与 FDE 团队合作，之后会推出自助平台（https://blog.cloudflare.com/clef-decision-models/ ；报名入口 https://www.cloudflare.com/resource/clef-rl-interest ）。
  - 权重以 Apache-2.0 开源，可以自己做 LoRA 或微调（https://huggingface.co/Cloudflare/clef ）。
- **校准**：每个 answer 都返回完整的 `probabilities`（官方 output schema），可以在本地拟合中文专用阈值（**推断**）。

### 4.3 中文结论（推断）

1. 两家都**没有**「中文与英文同等准确」的官方证据。Jev 官方明确承认中文准确率较低。Clef 没有声明，它的基座 Qwen 在多语言上通常较强，但基座声明不等于 Clef 的决策头经过了中文训练或评测。
2. 要满足「中文路由与英文一样准」，必须**自建中英文平行评测集**：同一批请求各有中文和英文版本，并标注 effort、模型和技能的金标准。用它比较两家模型和各种提示写法（英文 instructions 加中文 state，对比全中文），并按语言分别设定置信度阈值。
3. 可以采用的现成做法：
   - instructions 和 criteria 用英文，state 保留中文原文（第三方建议）。
   - 在 `criteria` 的 `examples` 里加入中文样例（官方结构）。
   - 低置信度时升级处理（官方模式），例如回退到默认 effort 或不建议技能。
   - Clef 还可以选择微调。Jev 不能微调。

---

## 5. 未覆盖与待验证

- Clef 在 Workers AI 上的 state 截断长度（第三方说约 2K token），以及 REST 响应外壳是否为 `result.answers`：**需要实测**。
- 哪些 Claude 模型把 thinking 和 effort 配置渲染在 tools/system 之前，也就是改 effort 是否连 system 缓存一起失效：**未文档化**。
- Claude Code 在 Opus 5 上改 effort 是否保缓存：API 支持 per-message effort，但 Claude Code 文档没有点名，**未文档化**。
- mod 如何程序化地每轮设置主循环 effort（hook、设置项或环境变量的时机）：**本次未调研**。
- Jev 官方延迟 SLA：**未文档化**。
- Clef 专属速率限制：**未文档化**，按 "Text Generation" 类推断为每分钟 300 次。
