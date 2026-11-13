# Nace Drex Max v1.1 作为决策模型：用法、官方问法与读图对比（对 Jev）

调研日期：2026-11-12。用途：dispatch-pilot 的决策模型现在是 Jev（带图走 `jev-latest` 加 `TypeSafe-Danger-Zone-Images` 头），没有 TypeSafe 密钥时退到 pplx。本文回答 Nace 的 `drex-max-v1.1` 是否值得考虑：怎么调用、官方怎么建议问判定问题和图片问题、读图能力与 Jev 比有没有官方证据。**没有发过任何 API 请求，没有登录、没有注册**；所有数字都是官方文档或官方发布物的原文。Jev 一侧的旧结论见 `decision-model-images.md`（c09a249），本文对着 TypeSafe 官方文档重新核了一遍，有出入的在 0.2 列出。

标注约定（沿用 `decision-model-images.md`）：
- **官方**：Nace（console.nace.ai 文档、nace.ai 研究页、GitHub `nace-ai` 组织、Hugging Face `nace-ai`、Nace 官方社交账号）和 TypeSafe（docs.typesafe.ai、typesafe.ai 博客）自己发布的内容。
- **第三方**：Artificial Analysis、新闻站、聚合站、博客，未经厂商确认。
- **推断**：由已查到的事实推出、文档没有明说。
- **未文档化**：查过的官方来源都没写。

引文保持英文原文。文中不含任何真实密钥，密钥一律写 `$NACE_API_KEY`。

读法说明：Nace 文档页是 Fumadocs 站，在页面 URL 末尾加 `.md` 即得干净 Markdown（本次所有 `console.nace.ai/docs/...` 页面都这样读，其中 `<ModelName />` 一类 MDX 组件占位符的值另用渲染后的页面核对过）。

---

## 0. 结论摘要

### 0.1 一句话

`drex-max-v1.1` 与 Jev 是**同一套 System One 协议**（同一个 `POST /v1/systemone`，`noul` / `choice` / `score`，同样的响应形状），迁移代价很低；文档规格上它读图的方式更正式（不需要 danger-zone 开关，有 8 张/请求的明确上限，超大图自动缩放而不是拒收），但**没有任何官方资料能证明它读图比 Jev 更准**，因为 Nace 自己的对比里 Jev 是在「没拿到图、只拿到图的文字描述」的条件下被比的。

### 0.2 与 `decision-model-images.md` 相比，Jev 官方资料已经变了的地方

| # | 旧记录（2026-10-14） | 现在（2026-11-12 重读 TypeSafe 官方） | 来源 |
| --- | --- | --- | --- |
| 1 | `jev-latest` → `jev-1.13.0`，约一周后换成 1.14.0 | `jev-latest` → `jev-1.14.0`（已换） | https://docs.typesafe.ai/models.md |
| 2 | `jev-preview` → `jev-1.14.0` | `jev-preview` 也指 `jev-1.14.0`，页面警告 "`jev-preview` currently points to the same model as `jev-latest`. There is no preview build available right now." | https://docs.typesafe.ai/models.md |
| 3 | 模型页 "Input: Text" 与 images 页矛盾 | 模型页已改：两个版本 Input 都是 "Text, images" | https://docs.typesafe.ai/models.md |
| 4 | 宽高各 256 到 1568 px | 宽高各 **280** 到 1568 px，"An image with either side under 280 pixels is rejected."（总像素 78,400 到 2,458,624 不变） | https://docs.typesafe.ai/images.md |
| 5 | 每张图 token 数未文档化 | 仍未文档化，原文仍是 "We'll be providing guidance on estimating image token usage soon." | https://docs.typesafe.ai/images.md |
| 6 | 每请求张数未文档化 | 仍未文档化："How many images fit in one request depends on these limits and on the context length." | https://docs.typesafe.ai/images.md |
| 7 | 图像仍是 "Dreamer-ready" | 仍是，原文 "Images and Box questions aren't yet up to our standards to call ready for production" | https://docs.typesafe.ai/images.md |

**含义（推断）**：dispatch-pilot 现在发的 `jev-latest` 已在 2026-10-21 前后从 1.13.0 变成 1.14.0，行为变化没有伴随任何代码改动；TypeSafe 的原话 "If you have tuned confidence thresholds against one version, send that version's ID instead of the alias."（https://docs.typesafe.ai/models.md ）。

### 0.3 十条要点

| # | 结论 | 来源 |
| --- | --- | --- |
| 1 | 端点 `POST https://console.nace.ai/v1/systemone`，`Authorization: Bearer nace_sk_...`（`nace_sk_` 加 43 个 URL 安全字符），每账号最多 3 个有效密钥。 | https://console.nace.ai/docs/drex/guides/authentication |
| 2 | `drex-max-v1.1`：2026-10-28 发布，输入 $0.03 / 百万 token，输出不计费，整请求 262,144 token 上限（含图、全部问题、格式标记）。官方社交帖称这是 "50% launch discount"，优惠何时结束**未文档化**。 | https://console.nace.ai/docs/drex/reference/models ；https://console.nace.ai/docs/drex/reference/pricing ；https://nitter.gq/NaceAI/status/2115458409407611154 （官方账号 @NaceAI 帖子镜像） |
| 3 | **`drex-latest` 与不写 `model` 都会选 `drex-max-v1.1`**；已退役的 `drex-max`、`drex-v1.5`、`drex-v1.0`、`drex-v1.1` 都改由 `drex-max-v1.1` 应答并按它的价格计费。TypeSafe 的默认模型名 `jev-latest` 在 Drex 上返回 `422`。 | https://console.nace.ai/docs/drex/reference/models ；https://console.nace.ai/docs/drex/guides/migrate-from-typesafe |
| 4 | 限额：免费档 120 RPM / 8 并发，付费档 1200 RPM / 16 并发；每请求最多 512 题；序列化请求体 4 MiB；Drex 最多等模型 55 秒，官方建议客户端超时至少 60 秒。 | https://console.nace.ai/docs/drex/reference/limits ；https://console.nace.ai/docs/drex/guides/errors-and-retries |
| 5 | **官方没有「判定问题怎么写」的专门最佳实践页**，只有 Questions / State / Reading answers 三页和官方 agent skill `drex-for-harness`（见第 2 节）。**托管 API 没有 `temperature`、`logprobs` 之类的请求参数**（OpenAPI 请求体里没有），概率本身就是输出。 | https://console.nace.ai/docs/drex/api-reference/systemone |
| 6 | 官方对阈值的态度：阈值是业务决定，不是模型属性；对窄类请求要在带标注的数据上调（论文直接建议调 temperature，但托管 API 不开放它）。 | https://console.nace.ai/docs/drex/guides/reading-answers ；https://arxiv.org/pdf/2611.07854 |
| 7 | 图放在**顶层 `images` 数组**（不是 `state` 里），所有问题共享这批图，按数组顺序编号 "Image 1"、"Image 2"，在文字里这样称呼它们；一请求最多 8 张；PNG / JPEG / WebP（JSON）或仅 PNG / JPEG（multipart）；内联 base64 合计约 3 MiB。 | https://console.nace.ai/docs/drex/guides/drex-max |
| 8 | Drex Max 把每张图缩到最多 1,638,400 像素（1,280 × 1,280 的面积），"so detail past that is not kept"；输入像素上限 4000 万；超限的图不是被缩小，而是 `422`。 | https://console.nace.ai/docs/drex/guides/drex-max |
| 9 | Nace 自己的读图证据只有「Drex Max 对 Drex Max 的文字描述版」和「对 GPT-6 Sol / Claude Opus 5.5 / d3-turbo」的比较；**Jev 1.14 在 Decision Bench v4 里被当作 "Text-only model"，图题是用文字描述喂给它的**，所以官方没有 Drex Max 对 Jev 的读图 head-to-head。 | https://arxiv.org/pdf/2611.07854 （Table 2 脚注） |
| 10 | TypeSafe 一侧没有公布任何读图基准数字；官方只有定性声明："all models (Jev included) perform worse on multimodality over pure text"。 | https://typesafe.ai/blog/jev-1-14 |

---

## 1. 用法

### 1.1 端点、鉴权、请求与响应

出处：https://console.nace.ai/docs/drex/quickstart ；https://console.nace.ai/docs/drex/guides/authentication ；https://console.nace.ai/docs/drex/guides/reading-answers ；https://console.nace.ai/docs/drex/api-reference/systemone

```http
POST https://console.nace.ai/v1/systemone
Authorization: Bearer $NACE_API_KEY
Content-Type: application/json
```

```json
{
  "model": "drex-max-v1.1",
  "state": "My parcel arrived with the box crushed and the lamp inside cracked. I want a new one.",
  "questions": {
    "damaged": { "type": "noul", "instructions": "Did the item arrive damaged?" },
    "intent": {
      "type": "choice",
      "instructions": "What does the customer want?",
      "criteria": { "refund": "Money back", "replace": "A new item", "info": "Information only" }
    }
  }
}
```

（请求示例来自 Drex Max 页，原样。）

- 请求体字段：`model`（可选）、`state`（必填，任意 JSON）、`questions`（必填，至少 1 题）、`images`（可选，仅 Drex Max 系）。官方 OpenAPI 的请求体里**没有**别的参数；没有 `temperature`、`logprobs`、`max_tokens`、`detail`。（读 OpenAPI JSON 全文后确认，来源同上。）
- `model` 的正则是 `^(?:drex|nacedm)-[A-Za-z0-9.-]+$`；列表之外的值返回 `422` 且 `path` 为 `model`。
- 响应：`model`（实际应答的固定版本，从不回显别名）、`answers`（以你的问题 ID 为键）、`usage.input_tokens` / `output_tokens`（带图时还可能有 `usage.image_tokens`，已包含在 `input_tokens` 里）、`evaluation_time_ms`、`request_id`。
- 与 Jev 的差别：Drex 的响应形状与 Jev 相同；`score` 的 `legend` 对 TypeSafe SDK 返回对象，对其他客户端返回数组，可用请求头 `X-Nace-Legend: object|array` 强制（https://console.nace.ai/docs/drex/guides/reading-answers ）。dispatch-pilot 用 `$.http.fetch` 自拼请求，所以默认拿到数组。
- Drex 自称与 Jev 线路兼容："Drex is wire-compatible with TypeSafe's Jev. The `@typesafe-ai/sdk` package works against `https://console.nace.ai` without a fork."（https://console.nace.ai/docs/drex/guides/migrate-from-typesafe ）。迁移要改的三项：base URL、密钥、默认模型名；`box` 题不支持（`422`）；`TypeSafe-Danger-Zone-Images: true` 头 "is accepted, and Drex does not require it"。
- 另有 OpenAI 兼容路由 `POST /v1/decisions`（`input_image` 部分；`detail` "is accepted and ignored, because Drex has one image profile"）和批处理（`/v1/batches`，"at a discount"，一批最多 1,000 个请求，"Submit many System One requests at once; they run when Drex has spare capacity"）。dispatch-pilot 的实时路由用不上批处理。

### 1.2 型号与差别

出处：https://console.nace.ai/docs/drex/reference/models （渲染后的表）；https://console.nace.ai/docs/drex/reference/limits

| 型号 | API id | 发布 | 价格 / 百万输入 token | 上下文口径 | 读图 |
| --- | --- | --- | --- | --- | --- |
| Drex Max v1.1 | `drex-max-v1.1`（`drex-latest` 指向它） | 2026-10-28 | $0.03 | 整请求 262,144 | 是 |
| Drex Max Finance | `drex-max-finance` | 2026-11-01 | $0.03 | 整请求 262,144 | 是（金融版，同样的请求格式） |
| Drex 2.0 | `drex-v2.0` | 2026-10-06 | $0.03 | state 131,072；state 加最长一题 262,144 | 否，只读文本 |

- 已退役（由 `drex-max-v1.1` 应答并按其价格计费）：`drex-v1.0`（2026-10-21）、`drex-v1.1`（2026-09-28）、`drex-v1.5`（2026-11-08）、`drex-max`（2026-11-08）。
- `drex-v2.0`："a mixture of experts with 3B active parameters"；Drex Max 是 27B 稠密多模态（https://github.com/nace-ai/drex-decision-models/blob/main/models/drex-max-v1/README.md ，该页是开源 `drex-max-v1` 的模型页，**不是** v1.1；v1.1 权重未发布，v1.1 的参数量文档未写）。
- "Drex Max models — whole request. One shared budget covers the state once, all images, every question and its options, formatting and decision markers. Adding a question consumes more of that same budget; each question does not get a separate input allowance."（models 页）。
- 速度口径（官方论文）：Drex Max 中位延迟 183 ms，Jev 1.14 为 196 ms，含 70–215 ms 网络往返，测试机在俄勒冈（https://arxiv.org/pdf/2611.07854 ，延迟表）。注意这是文本决策的数字，不是带图。Drex Max "reads each question in full"，论文局限一节写 "The cost of Drex Max on a long state grows with the number of questions, since it processes the state once per question"。**推断**：一请求塞很多问题 + 长 state 时，Max 的计算量按题数线性增长，而按文档计费只算一次 state（因为 `usage.input_tokens` 是 "state and questions ... as the model counts them"）。
- 第三方：Artificial Analysis 列 Drex Max v1.1 为 "283 ms Time per task"，"notably slow (median: 209 ms)"（https://artificialanalysis.ai/decision-models/drex-max-v1-1 ），标明 "This model's cost reflects a temporary launch price. At its standard price, its cost would be double."。

### 1.3 限额

出处：https://console.nace.ai/docs/drex/reference/limits ；https://console.nace.ai/docs/drex/guides/drex-max

| 项 | 值 |
| --- | --- |
| 每请求题数 | 1 到 512 |
| `choice` 选项 / `score` 档位 | 最多 255 |
| 序列化请求体 | 4,194,304 字节（含内联图的 base64）；托管层在约 4.5 MB 以上直接 `413` 且没有 `request_id` |
| 每请求图数 | 8（纯文本请求不限） |
| 每张图 / 全部图合计 | 16 MiB / 32 MiB |
| 单图输入像素 | 4000 万 |
| 免费档 RPM / 并发 | 120 / 8 |
| 付费档 RPM / 并发 | 1200 / 16 |
| 模型等待 | 55 秒后 `529 overloaded`；路由 maxDuration 60 秒 |
| 上传图的取回与校验 | 每请求 20 秒内 |

付费档指「完成过充值、开启 auto-pay 或付过用量发票」的账户；注册赠金不算（limits 页 Tiers）。

### 1.4 计费

出处：https://console.nace.ai/docs/drex/reference/pricing

- "The cost of a request is `usage.input_tokens` multiplied by the per-token price of the model that answered it ... There is no per-request fee and no charge per question." 每个输入 token 30 nUSD；输出不计费。
- "Only a `200` response is debited. A request that ends in `401`, `402`, `422`, `429`, `500`, or `529` costs nothing."
- 注册赠金 $5.00（3 个月内有效，需 "a person is behind the account"：Google 登录、满 30 天的 GitHub 账号或验证银行卡），之后每月 $5 额度；最低充值 $5。余额为零且未开 auto-pay：`402 insufficient_credit`。
- 不要并行发两份相同请求："Every successful response is billed, including duplicates."（errors-and-retries 页）。

### 1.5 数据保留（未读到）

Nace 的 data-retention 页（https://console.nace.ai/docs/perception/data-retention ）写的是 Perception（文档工具）的保留，**没有写 `POST /v1/systemone` 的 state 和图是否被存储、存多久**。Drex 页面也没有。上线前要读 Terms / Privacy / DPA（https://console.nace.ai/terms 、/privacy、/dpa），这三页本次**未读**。对比 TypeSafe：模型页写 "Jev is not trained on customer requests or responses."（https://docs.typesafe.ai/models.md ）。

---

## 2. 决策问题：官方问法与配置

### 2.1 官方有什么、没有什么

- Nace 文档站里与写问题相关的只有：Questions（https://console.nace.ai/docs/drex/guides/questions ）、State（https://console.nace.ai/docs/drex/guides/state ）、Reading answers（https://console.nace.ai/docs/drex/guides/reading-answers ）。**没有**独立的 prompting / best practices 页，也没有 changelog 页（`llms.txt` 目录里没有；https://drex.nace.ai/llms.txt ）。
- 官方 agent skill `drex-for-harness`（https://github.com/nace-ai/drex-agent-skills/blob/main/skills/drex-for-harness/SKILL.md ）的 "Design the questions" 一节是最接近「写问题指南」的官方文字。注意这份 skill **部分过时**：它写 "Inputs are text; do not embed images, audio, video, or PDFs"、"`drex-latest` is an alias for `drex-v2.0`"、主机用 `https://drex.nace.ai` 与 `DREX_API_KEY`，而最新文档里 `drex-latest` 指 `drex-max-v1.1`、Max 能读图、主机是 `console.nace.ai` 与 `NACE_API_KEY`。skill 自己写 "Live Drex docs are the source of truth"，所以两者冲突时以文档为准。
- 没有 system prompt：Drex 请求里没有 system / developer 角色这个概念。指令放在每个问题的 `instructions` 与 `criteria` 里；skill 原话："Put the full question meaning in `instructions` and `criteria`. Question ids are response keys, not model-visible instructions."

### 2.2 选题型

> "Start from the code that consumes the answer, not from the text you are asking about."

| 需要 | 题型 | 官方例子 |
| --- | --- | --- |
| 是/否，阈值自己定 | `noul` | Is the customer asking for a refund? |
| 无序集合里选一个 | `choice` | Is this ticket about billing, a technical problem, or the account? |
| 有序量表上的位置 | `score` | How upset is the customer, from calm to angry? |

> "If the labels have an order, use `score` and you get a fractional position on the scale. If the labels have no order, use `choice`. If there are only two outcomes, use `noul` and compare the probability with a threshold."（Questions 页）

### 2.3 措辞与结构

逐字引用，均出自 Questions 页（https://console.nace.ai/docs/drex/guides/questions ）除非注明：

- 标签名："Keep them short and machine friendly, such as `billing` rather than `Billing and payments`."
- 标签描述有用且应只给边界不明的标签加："Write a description for any label whose boundary is not obvious from its name. Each description costs input tokens, so keep descriptions short and skip them for labels like `other`." 官方的实测：审核问题里 `remove` 标签从 `null` 描述改成 "Explicit threat of violence or doxxing" 后，`remove` 概率从 0.34 降到 0.15。
- `noul` 的 `criteria.true` / `criteria.false`："Use criteria when your team's definition of yes differs from the everyday meaning of the question." 官方的实测：同一个 bug 报告问题，无 criteria 为 0.3505，`true` 写成 "Anything that does not work as expected, including slowness" 为 0.9696，写成 "A crash, an error, or a broken feature" 为 0.0167。"A sentence in `instructions`, such as "Treat slowness and performance complaints as bugs", also helps, but it moves the answer less than criteria do, because criteria state both sides of the boundary."
- 问题 ID："Name each id for the field it fills in your code ... An id like `q1` forces every reader of the answer to look up what `q1` asked." skill 补充："Question ids are response keys, not model-visible instructions"，所以意思不能只放在 ID 里。
- 一批问题共用一个 state："One request accepts up to 512 questions about the same `state`. Drex bills input tokens, and a batch sends the state once instead of once per question". 官方实测：4 题一起 127 token，分 4 次 241 token，"47% fewer input tokens"。
- 一条问题几个属性：官方 Questions 页**没有**明说「一问一属性」。skill 里最接近的是 "Separate independently useful judgments." 与 "Put independent questions about the same state into one `questions` map."；`promptfoo` 集成页明说 "Write each rubric as one yes/no statement, and use several assertions rather than one compound rubric."（https://console.nace.ai/docs/integrations/promptfoo ）。TypeSafe 对应的更强的话是 "Ask the most explicit, narrow, specific, atomic questions you can ... This is probably the most important concept in this guide."（https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md ）。**官方没有给 Drex 写过同样强度的话；不能把 Jev 的原则当作 Drex 的官方建议，但两者不矛盾。**
- 一批里每个条目一问时，必须在问题文字里点名条目："Questions with identical text get identical answers, because the model never sees the ids."（skill）
- 候选里要留 "none of the above"："Include a no-match option when appropriate. A model cannot select a candidate omitted by the application."（skill）；promptfoo 页同："add a catch-all label such as `other` when none may fit."
- `score` 档位："Order the levels from low to high." skill："Describe concrete situations rather than vague labels when possible."
- 结构化描述：`criteria` 描述和 `instructions` 可以是对象/数组，被渲染成缩进文本，最多嵌套 8 层。
- **正反例**：官方文档里没有「在问题里写正例/反例」的专门建议。TypeSafe 的 how-to-build 页有（`examples`、`not_for` 字段），Nace 没有。**官方资料不足以判断**示例是否提升 Drex 的准确率。
- **中英文**：Nace 文档没有写问题应该用英文还是中文，也没有声明语言支持矩阵（我读到的 Drex 页面里没有）。**未文档化**。

### 2.4 state

出处：https://console.nace.ai/docs/drex/guides/state

- "`state` is required. It can be any JSON value: a string, an object, an array, a number, a boolean, or `null`."
- 文本还是 JSON："The `noul` answer moved by 0.13, so the format is part of the question. If you compare a probability with a fixed threshold, keep the format of `state` fixed too." 即同一内容用句子写还是用对象写，同一个 `noul` 在官方样例里相差 0.13（0.8226 对 0.6883）。
- 只放相关内容："Send only the fields the questions need ... Every field you send is billed as input tokens and counts toward the limit."
- 不要把媒体放进 `state` 或 `questions`：base64 data URL、`image_url` 内容部分等会被 `422` 拒绝，图要放顶层 `images`。

### 2.5 输出形式、阈值与参数

出处：https://console.nace.ai/docs/drex/guides/reading-answers

- 输出是概率，不是裁决："Drex does not return a verdict. It returns a probability for each question, and your code turns that into a decision."
- `noul`：0 到 1，是 yes 的概率；`confidence = max(noul, 1 − noul)`，下限 0.5；"For your own decisions, threshold `noul`, which keeps the direction."
- 阈值："There is no built-in cutoff. You choose a threshold, and the right one depends on what each kind of mistake costs you." "A threshold is a business decision, not a property of the model. Log the raw `noul` value with each decision, so you can move the threshold later and replay past traffic against the new one." 两个阈值加中间带转人工是官方推荐的写法之一。
- `choice`：`choice` 标签、每个标签的 `probabilities`、`confidence`（"the average of the confidence (probability) scores the model produced for this answer ... it tracks the top probability but is a different number"）。
- `score`：`score` 是期望档位（"the sum of each index times its probability"），`legend`，各档 `probabilities`，`confidence`。"Rounding `score` to the nearest level loses information."
- **`confidence` 的定义在 Nace 内部两处不一致**：托管 API 页（上面）写 "average of the confidence (probability) scores"；开源自托管的请求格式文档写 "For `choice`, `confidence` rescales the winning probability above a uniform baseline; for `score`, it measures concentration around the modal level. The local `score` formula approximates the hosted API's."（https://github.com/nace-ai/drex-decision-models/blob/main/docs/request-format.md ）。**推断**：不要把 dispatch-pilot 里按 Jev 的 confidence 公式（本仓库 `typesafe-question-guide.md` 第 0 节第 7 条）定的门槛直接搬到 Drex 上。
  - **2026-11-13 实测补充**（一个三题请求，各发 Jev 和 Drex 一次）：托管 API 回的数和 TypeSafe 文档的公式对得上，choice 是 `(p_max − 1/n) / (1 − 1/n)`（0.9951 → 0.9926），score 是 `1 − Σ p_i·|i − m| / MAD_unif`（期望距离 0.3901 → 0.6099；4 档时 `MAD_unif` 恰好是 1，分不出有没有这一步归一化）。所以是文档表述不同，实测一例相同；另外 Drex 的 noul 多一个 `confidence = max(p, 1 − p)`，Jev 的概率四舍五入到两位小数。后续的对照和接入见 `docs/adr/0026-dispatch-pilot-drex-max-default-text-decisions.md`。
- 温度："temperature、logprob" 这类参数：托管 API **没有**。论文的建议原文是：

> "A single temperature fitted on one distribution or domain of decisions therefore does not guarantee good calibration on another. Thus, we recommend that, for any application of Drex Max that contains a component that depends on whether Max's predicted probability exceeds a threshold, and that serves a narrow type of request, the temperature parameter should be tuned on labeled decisions of that type."（https://arxiv.org/pdf/2611.07854 ，校准一节）

  这是说自托管开源权重（`decision_config.json` 里有 "Option codes, temperature and the non-causal attention setting"）。托管 API 不暴露它，所以对 dispatch-pilot 来说等价的做法是**在代码里按带标注的样本调阈值**，不调模型温度。
- 校准数据（官方论文）："When Drex Max is at least 93% sure, it is right 97% of the time."（nace.ai 研究页）；但 6–20 个选项的问题偏过度自信（ECE 8.4%，准确率 71.7%）。选项多时不要直接信概率。
- 选项顺序："When the answer options in a prompt are randomly reordered, only 4.3% of Max's answers change"（nace.ai 研究页）。论文给的做法是看置信度而不是看顺序一致性："An application that uses the model can therefore reduce the impact of both effects by routing on confidence"。Jev 一侧也有对应声明（`jaggedness`：Jev 偏向第一个选项，建议换序复核）。
- 论文的使用警示（原文）：

> "A decision whose probability is close to its threshold can therefore change between runs ... Deployments should monitor confidence and accuracy on live traffic. They should also keep a margin around decision thresholds, send low-confidence decisions to human review, and log the request, the output distribution, and the model version as the record of each decision."

### 2.6 错误和重试（官方写法）

出处：https://console.nace.ai/docs/drex/guides/errors-and-retries

- 重试 `429`、`529`、`500` 和网络错误，读 `retry-after-ms`；不重试 `401` / `402` / `422`。
- 客户端超时至少 60 秒："A client timeout below 60 seconds abandons requests that were about to succeed, and the retry joins the queue again at the back." **与 dispatch-pilot 的矛盾（推断）**：dispatch-pilot 在发消息时的等待只有 8000 ms；Nace 官方明说重载时请求可能排队接近 55 秒。典型延迟是几百毫秒（论文中位 183 ms），但官方没有给 p95 / p99。
- 重要的服务端行为（skill 原文）："Drex answers a mistyped or retired model id with another model instead of an error." 文档里的说法有分歧：最新 models 页说未知的 id 返回 `422`；skill 说以 `drex-` 开头的未知 id 被 `drex-latest` 的模型应答。两者冲突，**以 models 页为准（它是文档的、较新的一份）**，但客户端仍应核对响应里的 `model`。

---

## 3. 图片：官方问法与配置

### 3.1 怎么传

出处：https://console.nace.ai/docs/drex/guides/drex-max （逐字）

> "Add an `images` array to the request. Every question sees the same images, in array order, before the state and the questions. Refer to them as "Image 1", "Image 2" and so on in the state or the instructions. Those words stay plain text: Drex inserts nothing where they appear, and the model matches them to the images by their order in the array. A URL in the request is text too; Drex never fetches it."

> "Each `images` entry is either an uploaded file or the image's bytes inline. You can mix the two in one request. Keep images out of `state` and `questions`: media placed there returns `422`."

三种传法：

| 方式 | 形态 | 限制 |
| --- | --- | --- |
| 内联 | `"images": ["data:image/jpeg;base64,..."]`，也接受裸 base64 | 计入 4 MiB 请求体；"a request holds about 3 MiB of inline image bytes in all" |
| 已上传文件 | `{ "type": "workspace_file", "workspace_id": "...", "file_id": "..." }`，先走 Perception 的直接上传流程（不带 `workspace_id`） | 上传免费；文件须由持有 API 密钥的账户在不指定 workspace 的情况下上传；读取在每请求 20 秒内。上传流程页（https://console.nace.ai/docs/perception/uploads ）**本次未读** |
| multipart | `request` 部分放 JSON，每图一个文件部分，`assets` 里写名字和 `part`，名字出现在 `state` / `instructions` / `criteria` 里会被替换成 "Image N" | 仅 PNG / JPEG（"A WebP or GIF returns `422`"）；整体 4 MiB（约 3 MiB 图片字节）；这是 TypeSafe SDK 发图的格式，Drex 为它做了兼容 |

- **不接受 URL**，"The API never fetches a URL"（内联路径同样：`https` 图片 URL 返回 `422`）。
- 格式（JSON 路径）：PNG / JPEG / WebP；动图、损坏的图返回 `422`：

> "Image could not be read. Use an accessible, valid still PNG/JPEG/WebP, at most 16 MiB and 40 megapixels; all images together must be at most 32 MiB."（https://console.nace.ai/docs/drex/reference/errors ）

- 张数：8 张（`at most 8 images allowed`）。
- 尺寸：

> "Drex Max resizes each image to at most 1,638,400 pixels (the area of 1,280 × 1,280), so detail past that is not kept. Image tokens count toward the token limits above: in the shared packed request for Max v1.1 and Max Finance. A long state with several images and many questions can therefore be refused with a `422` even when each question fits on its own; send fewer questions per request."

- 缩放行为：超过 1,638,400 像素的图在服务端缩小（不报错）；超过 4000 万输入像素才被拒。没有 `detail` 参数："`detail` ... is accepted and ignored, because Drex has one image profile."（OpenAI 兼容路由，https://console.nace.ai/docs/drex/guides/openai-compatible-decisions ）。**没有切瓦片或多分辨率档位**。
- token 计量："Responses to image requests can include `usage.image_tokens`, the tokens the images took."（drex-max 页）。**每张图占多少 token 的公式/表格没有文档化**（和 Jev 一样），只能用响应里的 `usage.image_tokens` 实测。
- 不支持（OpenAI 兼容页）："per-question images or `input_json` inside `instructions` ..., image URLs, more than 8 images". 但用 multipart + `assets` 时仍可以把引用写进某题的 `instructions`；它们都被放大成全局编号的 "Image N"，**所有问题照样看到全部图**（drex-max 页 "References" 一条加上 "Every question sees the same images"）。**推断**：Drex 里不存在「只给某一题的图」，这与 Jev 不同（Jev："An image in a question's `instructions` is part of that question and is sent only with that question."）。
- 视频：官方社交帖称 Drex Max 1.1 "Multimodal (text, image, and video)"（https://nitter.gq/NaceAI/status/2115458409407611154 ），但 API 文档只有图片，且 "audio, video or PDFs" 放在 `state` 里返回 `422`。**API 层面的视频输入文档里没有**。

### 3.2 多图对比怎么问

- 官方只给了编号规则（上面第一段引文）和 `receipt` 一类的单图例子：`"state": "Inspect Image 1."`，问题 `Is Image 1 a purchase receipt?`。
- **官方没有多图对比的示例，也没有对比写法的建议。** 由编号规则推断：对比题写成 `Is the dog in Image 1 the same dog as in Image 2?`，把两张图按顺序放进 `images`。这是推断，不是官方写法。
- Jev 一侧有官方对比例子（同一只狗、门口人脸与徽章照片）和一张「Patterns」表（"Compare against a known picture"、"What changed"、"Look closer when needed"……），见 https://docs.typesafe.ai/images.md 。

### 3.3 官方对「看图判定问题怎么写」的建议

很少，且主要在论文里：

- 用原图，不要用描述："It reads the image, not a description of it. On image-only questions, Max is right 63% of the time from a text description of the image and 98% from the raw image."（https://www.nace.ai/research/towards-foundation-decision-models ）
- 官方 agent skill **没有**图片写法一节（它写的是文本）。
- 集成页 promptfoo 只给出：图叫 "Image 1"、"Image 2"，按附加顺序编号；"The provider returns an error rather than dropping images when the model is text-only"。
- 论文提到的最佳场景：文档、表单、图表读取（InfographicVQA、KIE、CharXiv）和网页元素选择（Mind2Web）；最弱的是需要多步推理的图（见 3.4）。

### 3.4 官方声明的局限（Nace）

出处：论文 https://arxiv.org/pdf/2611.07854 ；模型页 https://github.com/nace-ai/drex-decision-models/blob/main/models/drex-max-v1/README.md ；v1.1 结果 https://huggingface.co/datasets/nace-ai/drex-max-v1.1-decision-index-results/blob/main/README.md

- 论文自己承认图像证据较薄："Decision Bench contains only 60 questions whose state consists of an image alone, which is a small sample for conclusions about image inputs, so our claims about images rest mainly on the vision suites."
- 公开视觉基准（Decision Index 视觉套件，11 个基准，v1.1，"Images at native resolution, capped at 1,638,400 pixels"）综合 **75.78**（v1 为 73.92）。分项（得分为机会校正后的技能值 ×100）：

| 基准 | v1.1 | 备注 |
| --- | --- | --- |
| InfographicVQA | 98.4 | 文档类最强 |
| KIE (CORD+FUNSD) | 93.2 | |
| Winoground | 86.8 | |
| Mind2Web | 86.3 | 网页元素选择 |
| CV-Bench | 77.4 | |
| CharXiv | 79.9 | |
| RealWorldQA | 73.1 | |
| BLINK | 61.3 | 感知/多图类 |
| R-Bench-M | 50.4 | 权重 0.5 |
| MMMU-Pro vision | 47.0 | 权重 0.25 |
| Moderation (Hateful Memes) | 45.6 | 最弱 |

  论文对 v1 的描述："It has its lowest accuracy on benchmarks whose images require multi-step reasoning"（论文 8.6 节）。以上是 Nace 自己跑的结果，每个基准的原始数据在其公开 Hugging Face 数据集里，但**不是独立复核**。
- 论文的局限段还提到"closed-book knowledge"是最大弱项，以及 Decision Bench 里 Max 在 "Trust & Safety" 类别（91.7%）低于包括 Jev 1.14 在内的其他模型（原文："vs. 95.0–98.3% for Jev 1.14, d3-turbo, and the frontier models"，没有单列 Jev 的数字）。
- 论文还写 Drex Max 的图片编码器是单独的训练阶段（"SFT of the image encoder and of its projection into the language model, which teaches the model to make decisions from images"），Max 是 "the only one that accepts images as input" 的 Drex 型号。

---

## 4. 与 Jev 的读图对比

范围：只比 Jev（`jev-1.13.0` / `jev-1.14.0`，经 `jev-latest`）。依据只限双方官方文档、官方发布的规格与官方基准。**规格差异和实际效果分开列；实际效果没有测过。**

### 4.1 规格对比（文档写了什么）

| 维度 | Drex Max v1.1 | Jev 1.13 / 1.14 | 谁在规格上更宽松 | 来源 |
| --- | --- | --- | --- | --- |
| 是否需要开关 | 不需要（`TypeSafe-Danger-Zone-Images` 被接受但不必要） | 需要 `TypeSafe-Danger-Zone-Images: true`；官方自称 "Dreamer-ready ... not yet up to our standards to call ready for production" | Drex | drex-max 页；images.md |
| 图放哪 | 顶层 `images` 数组，全部问题共享；文字里写 "Image N" | 顶层 `assets` + 引用字符串，可放在 `state` / 某题 `instructions` / `criteria` | 各有取舍：Jev 可按题分图、可把图当选项定义；Drex 只能共享 | 同上 |
| 编码 | 内联 base64 / data URL，已上传文件引用，multipart | multipart（官方推荐），或 `data_base64` + `format`；不收 URL / `data:` | 持平；Drex 多一种已上传文件引用 | 同上 |
| 格式 | PNG / JPEG / WebP（JSON）；multipart 仅 PNG / JPEG | PNG / JPEG，静态 | Drex（多 WebP） | 同上 |
| 单图字节 | 16 MiB（全部图 32 MiB） | 16 MiB（全部图 32 MiB，按服务端重编码后算） | 持平 | 同上 |
| 请求体上限 | **4 MiB**（内联图约 3 MiB） | 32 MiB | **Jev** | 同上 |
| 张数 / 请求 | **8** | 未文档化（受上下文和 32 MiB 约束，每处引用都重复计） | Drex 有明确数字；Jev 可能更多，但官方没写 | 同上 |
| 单图输入像素范围 | 至多 4000 万输入像素；无明确下限（"not valid" 才拒收） | 宽高各 280–1568，总像素 78,400–2,458,624；范围外 `400`/`413`，"never resized to fit" | Drex（自动缩放，不拒收） | 同上 |
| 模型实际看到的最大像素 | 缩到最多 1,638,400（1280×1280 面积） | 官方未写 Jev 是否在内部缩放；接受上限是 2,458,624（1568×1568 面积） | **官方资料不足以判断**哪边实际保留的细节更多：Jev 的接受上限更大，但 Jev 内部怎么处理未文档化 | 同上 |
| 每张图 token 数 | 未文档化；响应有 `usage.image_tokens` | 未文档化（"guidance ... soon"）；`usage.input_tokens` 含图 | 持平（都得实测） | 同上 |
| 上下文 | 整请求 262,144（含图） | 默认 64k/请求 + 32k/题；加长上下文头后 262k（官方说更慢、更不准） | Drex（默认就是 262k） | models 页；models.md |
| 价格 | $0.03/M 输入（"50% launch discount"） | $0.042/M 输入 | Drex（目前） | pricing 页；models.md |
| 支持的图像任务 | `noul` / `choice` / `score`，不支持 `box` | `noul` / `choice` / `score` 加 **`box`**（仅 1.14，定位框） | Jev（多一种定位题） | 同上；questions 页 |
| 多模态官方声明的状态 | 正式功能；Nace 自己的图像基准见 3.4 | 实验性；"As a warning, all models (Jev included) perform worse on multimodality over pure text. Breaking down questions into the simplest possible decompositions helps a lot." | Drex（正式 vs 实验） | blog；images.md |
| 官方读图示例 | 单图的 `receipt` 例；集成页 promptfoo；Nace 的 Drex Browser Use 项目（截图选下一步） | 多个：images.md 的找狗、门口、手势；OCR 置信度与框 cookbook；扫描疫苗记录 cookbook；feeder 摄像头 cookbook | **Jev 的官方读图样例更多** | 同上；https://docs.typesafe.ai/cookbooks/ocr_confidence_bounding_boxes.md |

### 4.2 官方数字（实际效果相关）

| 证据 | 内容 | 能否用于 Drex Max 对 Jev 的读图比较 |
| --- | --- | --- |
| Decision Index 0.4.1 公开文本套件 | Drex Max 67.52，Jev 1.14.0 60.70，Jev 1.13.0 57.96（论文 Table 1；Nace 自己评测并引自榜单） | **不能**：这是纯文本。 |
| Decision Bench v4（1,071 题：949 文本、62 文本加图、60 纯图） | Drex Max 94.0% [92.4, 95.3]（拿到图）；Max（文字渲染）92.1%；Jev 1.14 † 92.3%。脚注原文："† Text-only model; image questions are answered from the text rendering. The images are provided to d3-turbo, GPT-6 Sol and Claude Opus 5.5 via their image encoders." 纯图题：Max 98.3%，Max（文字渲染）63.3%，Jev 1.14 † 66.7%。Design 类（图题为主）：Max 96.7%，文字渲染 26.7%，v2.0 / v1.5 / Jev 1.14 为 33.3–46.7%。 | **不能当作读图比较**：Nace 没有把图喂给 Jev（实际上 Jev 接受图，需要 danger-zone 头），Jev 的数字是它读「文字描述」的成绩，Nace 自己也标注了 † 与 "Text-only model"。可以说的只有：Max 读原图远好于读文字描述（98.3% 对 63.3%）。 |
| Decision Bench 成对检验 | Max 对 Jev 1.14 +1.8 点（p = 0.048，"a difference that comes from the image questions, since the two models are tied on text-only questions"） | 同上，Jev 没有收到图。 |
| 公开视觉套件（11 个基准） | 只评了 Drex Max；论文另与 GPT-6 Luna Decisions 比了 80 题/基准（Table 21）。**没有 Jev 的视觉分数。** | 无 Jev 数据。 |
| Jev 的官方基准 | TypeSafe 博客有内部基准图，但说明 "We're including only open weight models"（Jev 自己不是开源权重，故不在里面）；没有视觉分项数字；"This is likely biased towards our models" | 无。 |
| 第三方 | 聚合站 / 媒体对 Drex Max v1.1 视觉分数的转述（如 orcarouter 的 v1 到 v1.1 对比）与官方 Hugging Face 数据不完全一致（例如 BLINK 75.0 对官方 61.3，口径是准确率而不是技能值） | 未采用。 |

### 4.3 结论

**文档规格上的差异（有官方证据）：**

1. Drex Max 读图是正式功能，不需要开关；Jev 的图是实验功能，官方明说不适合生产，且版本之间格式、答案和限制可能变。
2. Drex Max 对图的尺寸更宽容（自动缩放到 ≤1,638,400 像素；4000 万输入像素内不拒收），Jev 对 280–1568 px 之外直接拒收。dispatch-pilot 现状是自己在本地压缩图，两边都要压。
3. Drex 有 8 张/请求的明确上限，Jev 没有明确张数（只受上下文与 32 MiB 约束）。Drex 请求体只有 4 MiB（内联图约 3 MiB），Jev 是 32 MiB；**多张高分辨率截图在 Drex 上更容易撞到体积上限**。
4. Jev 多一种 `box` 定位题和按题放图/把图当选项定义的写法；Drex 都没有。
5. 每张图 token 数两家都没公开。

**实际读图效果（官方证据不足）：**

- **官方资料不足以判断 Drex Max 的读图是否比 Jev 更强。** 唯一的 Max 对 Jev 的官方数据是 Decision Bench v4，但 Jev 在其中拿到的是图的文字描述而不是图，所以那个差距（纯图题 98.3% 对 66.7%）不能当作「Max 读图比 Jev 读图强」的证据；它只说明「原图比文字描述信息多」。
- Jev 一侧没有任何公布的读图数字；Nace 一侧只有 Drex Max 自己的分数。
- 两家的官方态度都带有保留：TypeSafe 说读图比读文字差，要把问题拆到最简单；Nace 论文说它在多步推理类图像（R-Bench-M、MMMU-Pro、Hateful Memes）上最弱。
- 对 dispatch-pilot 的任务（看截图/图片后判断 effort、路由、核对）**没有任何官方基准直接对应**；最接近的是 Nace 的 Mind2Web（网页元素选择，Max v1.1 为 86.3，Jev 无数据）和 KIE/InfographicVQA（文档读取，Jev 无数据）。
- 要得出「实际效果」只能自己用带标注的截图集对两边同时跑，这一步**没有做**。

---

## 5. 对 dispatch-pilot 的含义（推断，不是官方结论）

- 协议兼容，所以接入成本主要是：一个新的 `NaceBackend`（base URL、`nace_sk_` 密钥、`drex-max-v1.1` 固定写死而不用 `drex-latest`）、`images` 数组的拼装、把本地压缩的目标改成「内联合计 ≤ 约 3 MiB、每请求 ≤ 8 张」、核对响应 `model`。
- 阈值要重调：Drex 与 Jev 的 `confidence` 定义不同；`noul` 在 Drex 官方样例里对 state 的格式敏感（句子对对象差 0.13）。
- 延迟：论文给的中位数 183 ms 是文本、含网络；dispatch-pilot 发消息时等待 8000 ms 以内，但官方没有给 p95，且重载时可能排队到 55 秒。需要实测。
- 价格：目前更便宜（$0.03 对 $0.042），但官方社交帖称 "50% launch discount"，之后可能翻倍（Artificial Analysis 也这样写）。
- 好处之一是迁移后 pplx 回退可保留；坏处是图片请求体 4 MiB 上限。

---

## 6. 未能确认的事项

| # | 事项 | 现状 |
| --- | --- | --- |
| 1 | Drex Max 对 Jev（**拿到图**）的读图 head-to-head | 没有官方数据；Nace 的对比里 Jev 只读文字描述 |
| 2 | Jev 的任何读图基准 | TypeSafe 没公布 |
| 3 | 每张图的 token 数（两家） | 都没文档化；Drex 响应有 `usage.image_tokens`，要实测 |
| 4 | Jev 每请求张数上限；Jev 内部是否缩放图 | 未文档化 |
| 5 | Drex 的 launch discount 结束日期与之后的价格 | 官方帖子只说 "50% launch discount"；文档页只写 $0.03 |
| 6 | Drex 推理请求（state 与图）是否被存储、保留多久、是否用于训练 | 读到的页面没写；Terms / Privacy / DPA 页本次**未读** |
| 7 | 带图请求的延迟分布（p50 / p95 / p99） | 官方只有文本的中位数 183 ms（论文）；示例响应里的 `evaluation_time_ms` 官方标注为 "illustrative" |
| 8 | Drex 的 `confidence` 到底用哪种公式 | 托管文档与自托管文档两种说法 |
| 9 | 问题语言（中文）对 Drex 的影响 | 官方没写 |
| 10 | 视频输入 | 官方社交帖称支持，API 文档只有图片 |
| 11 | 论文全文 | 以关键词检索方式读了 Table 1、2、3、14、21、25、第 8.6 节、局限与 I 节、第 5/9 节摘录，**没有逐页通读**；论文 Section 5（输入格式）、Section 9（服务）未完整阅读 |
| 12 | 未读页面 | `perception/uploads`（直接上传流程）、`browser-runs`、`batches`、`developer-tools/*`（SDK / CLI / MCP）、Terms / Privacy / DPA、控制台 Playground 与 Dashboard（需登录，没有尝试登录）、nace.ai/drex 产品页、`drex-browser-harness-pub` 仓库、`drex-agent-skills/docs/reference.md`、TypeSafe 的 api.md / errors.md / box.md（本轮沿用 `decision-model-images.md` 的结论） |
| 13 | 自托管 / 开源权重 | 开源的是 `drex-max-v1`（v1），不是 v1.1；本文只关注托管 API |

---

## 7. 来源清单

**官方：Nace**
- https://console.nace.ai/docs （入口）；https://console.nace.ai/docs/drex ；https://console.nace.ai/docs/drex/quickstart
- https://console.nace.ai/docs/drex/guides/drex-max （图像、限制、选型）
- https://console.nace.ai/docs/drex/guides/questions ；/state ；/reading-answers ；/authentication ；/errors-and-retries ；/migrate-from-typesafe ；/openai-compatible-decisions
- https://console.nace.ai/docs/drex/reference/models ；/limits ；/pricing ；/errors
- https://console.nace.ai/docs/drex/api-reference/systemone （OpenAPI）
- https://console.nace.ai/docs/integrations/promptfoo
- https://console.nace.ai/docs/perception/data-retention （只涉及 Perception）
- https://drex.nace.ai/llms.txt
- https://www.nace.ai/research/towards-foundation-decision-models ；https://arxiv.org/pdf/2611.07854 （技术报告，arXiv 摘要页本身抓不到正文，用的是 PDF）
- https://github.com/nace-ai/drex-decision-models （及 `models/drex-max-v1/README.md`、`docs/request-format.md`）
- https://github.com/nace-ai/drex-agent-skills （及 `skills/drex-for-harness/SKILL.md`）
- https://huggingface.co/datasets/nace-ai/drex-max-v1.1-decision-index-results （v1.1 的公开指数与视觉分数）
- https://nitter.gq/NaceAI/status/2115458409407611154 （官方账号 @NaceAI 2026-10-28 帖子的镜像）

**官方：TypeSafe（Jev）**
- https://docs.typesafe.ai/images.md ；https://docs.typesafe.ai/models.md ；https://docs.typesafe.ai/changelog.md ；https://docs.typesafe.ai/model-jaggedness.md ；https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md ；https://docs.typesafe.ai/cookbooks/ocr_confidence_bounding_boxes.md
- https://typesafe.ai/blog/jev-1-14

**第三方（只作线索，未据以下结论）**
- https://artificialanalysis.ai/decision-models/drex-max-v1-1 ；https://www.orcarouter.ai/blog/drex-max-1-1-vs-drex-max ；https://modelsystem.one/news/drex-max-1-1/ ；https://www.llmreference.com/model/drex-max-v1.1 ；https://vercel.com/ai-gateway/models/drex-max-v1.1

**本仓库**
- `/Users/alexnear/Documents/claude-mods/docs/research/decision-model-images.md` （Jev 与 pplx 图像处理，c09a249）
- `/Users/alexnear/Documents/claude-mods/docs/research/typesafe-question-guide.md` （Jev 问题写法与 confidence 公式）
