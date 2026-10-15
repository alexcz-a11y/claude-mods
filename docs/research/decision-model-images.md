# 决策模型（Jev / pplx）的图像输入：调研记录

调研日期：2026-10-14。用途：dispatch-pilot 要决定，要不要把会话里的图像发给它的决策模型（现在有 Jev 和 pplx 两个后端）。本文只回答「两家怎么收图、怎么计费、限制是什么」，以及「mod 这一侧能拿到哪些图」。没有发过任何付费 API 请求，延迟和 token 数都只引文档。

标注约定：
- **官方**：TypeSafe、Perplexity 自己的文档、API reference、changelog、博客、cookbook。
- **第三方**：OpenRouter、新闻站、媒体、个人博客，未经厂商确认。
- **推断**：由已查到的事实推出、文档里没有明说的结论。
- **未文档化**：查过的官方来源都没有写。

所有引文保持英文原文。所有 key 用占位符表示（`$TYPESAFE_API_KEY`、`$PERPLEXITY_API_KEY`），本文不含任何真实密钥。

---

## 0. 结论摘要

| # | 结论 | 来源 |
| --- | --- | --- |
| 1 | **两家都能收图，但成熟度不同。** pplx 把图像当作正式功能写在 quickstart 里，不需要任何开关。Jev 把图像归为 "Dreamer-ready"：官方明说不适合生产，格式、答案和限制都可能在版本之间变，每个带图请求必须加请求头 `TypeSafe-Danger-Zone-Images: true`。 | https://docs.perplexity.ai/docs/decisions/quickstart ；https://docs.typesafe.ai/images.md |
| 2 | **「新 Jev」是 `jev-1.14.0`（2026-10-14 发布），但图像和长上下文都不是它独有的。** 两项都以请求头开关的形式同时给 `jev-1.13.0` 和 `jev-1.14.0`；1.14 独有的只有 Box 题型和「微小的整体改进，多语言提升最大」。 | https://typesafe.ai/blog/jev-1-14 ；https://docs.typesafe.ai/models.md |
| 3 | **Jev 的「4 倍上下文」是可选请求头，不是默认值。** 默认仍是 64k/请求、32k/题；加 `TypeSafe-Danger-Zone-Long-Context: true` 后，请求上下文和单题上下文**都是 262k**（不是只有请求这一项）。官方说它更慢、更不准。 | https://docs.typesafe.ai/models.md |
| 4 | **Jev 一张图占多少 token，官方没写**：「We'll be providing guidance on estimating image token usage soon.」只知道图像 token 与文本同价，没有另收图像费，并且计入上下文上限。 | https://docs.typesafe.ai/images.md |
| 5 | **pplx 的图像 token 数，官方两处写法相差约 6 倍**：quickstart 写「about 1,000 input tokens per megapixel」，同一站点的浏览器 agent cookbook 写 1280×800 截图约占 6,000 token（约 1,000 个 32×32 图块，约 6 token/块）。预算按大的算（推断）。 | https://docs.perplexity.ai/docs/decisions/quickstart ；https://docs.perplexity.ai/docs/cookbook/examples/decisions-api-browser-agent/README |
| 6 | **图像尺寸的失败方式差别很大。** Jev：宽高须在 256–1568 px、总像素 78,400–2,458,624，范围外直接 400/413，「never resized」。pplx：超过 2,048 个图块**不会报 400**，会挂约一分钟再返回 `504`。dispatch-pilot 发消息时的等待只有 8000 ms，所以发图前必须在本地把尺寸压到限制内。 | https://docs.typesafe.ai/images.md ；https://docs.perplexity.ai/docs/decisions/quickstart |
| 7 | **价格：pplx $0.02/M，Jev $0.042/M，输出都免费，都不另收图像费。** 带图请求的钱主要看图像 token 数，而 Jev 的这个数字未文档化。 | https://docs.perplexity.ai/docs/getting-started/pricing ；https://docs.typesafe.ai/models.md |
| 8 | **带图延迟：pplx 有一个官方数据点，Jev 没有。** pplx cookbook：一张 1,000 图块的截图（单次请求约 7,300 input token）五次请求 258–1141 ms，第一次约 1 秒。Jev 带图延迟未文档化。 | https://docs.perplexity.ai/docs/cookbook/examples/decisions-api-browser-agent/README |
| 9 | **mod 这一侧：user scope 安装拿不到「本次提交」的图像字节。** `$.prompt.media` 只答 mod managed settings install，其余返回 `{ deny }`；`prompt.submit` 的 `e.attachments` 只给图的种类、MIME 和文件名，没有字节。图要等进了会话以后，从 `$.session.messages({ as: "api" })` 的 `image` 块里读（推断：下一个事件起可读，需要用 event-probe 实测）。 | 本地 `index.d.ts`（见第 4 节） |

---

## 1. Jev（TypeSafe）

### 1.1 模型 ID 与别名（问题 6）

官方模型页（当日抓取）：

| | Jev 1.14 | Jev 1.13 |
| --- | --- | --- |
| Model ID | `jev-1.14.0` | `jev-1.13.0` |
| Price (per Btok / per Mtok) | $42 / $0.042 | $42 / $0.042 |
| Context length | 64k per-request / 32k per-question | 64k per-request / 32k per-question |
| Input | Text | Text |

- "Jev 1.14 is the newest Jev release, available from October 14, 2026."（https://docs.typesafe.ai/models.md）
- 别名（同页）：`jev-latest` → `jev-1.13.0`，"The most recent stable, official release. The default in our client SDKs"；`jev-preview` → `jev-1.14.0`，"The most recent release, official or not. Moves ahead of `jev-latest` when a preview build is available."
- 博客：「`jev-latest` will be updated to `jev-1.14.0` in a week. `jev-1.13.0` will be available for a while.」也就是约 2026-10-21 前后，`jev-latest` 会从 1.13.0 换成 1.14.0（https://typesafe.ai/blog/jev-1-14 ）。**推断**：如果 dispatch-pilot 现在发的是 `jev-latest`，那一周后它的行为会在没有任何代码改动的情况下变，需要在响应里记下 `model` 字段，或者固定成 `jev-1.13.0`。官方原话："If you have tuned confidence thresholds against one version, send that version's ID instead of the alias."
- 模型页表格的 "Input" 一行两个版本都写 `Text`，与 images 页互相矛盾。官方 images 页写 "Jev 1.13 and Jev 1.14 both accept images."，博客写 "the Jev you all know and love (`jev-1.13.0`) was multimodal all along!"。**推断**：模型页表格没有跟上，以 images 页为准（带请求头时）。
- 废弃时间：「We intend to give 60 days warning before `jev-1.13.0` is formally deprecated, and 30 days for `jev-1.14.0`. We'll release a deprecation policy prior to this.」（博客）。具体日期**未文档化**。
- 与 1.13 的其他差别：
  - 题型：1.14 多一个 `box`（见 1.5）。其余 `noul` / `choice` / `score` 不变。博客原话："We made huge leaps and bounds on this one recently, so we're enabling this only for `jev-1.14.0`."
  - 模型本身：「Not meant to be flashy but instead be small, subtle improvements to everything. Most things should be a tiny bit better, but we expect the largest gain in multi-lingual support.」（博客）。**未给任何数字**。
  - 价格不变。端点和请求结构不变（`POST https://api.typesafe.ai/v1/systemone`，`{ model, state, questions }`）。
  - 速率限制：「Rate limits are set per organization.」具体数字只在控制台（https://console.typesafe.ai/rate-limits ），公开文档**未文档化**。images 页明说「Images have no separate rate limits: a request with images counts against the same limits as any other request.」
  - 响应格式：`model` / `answers` / `usage` 不变，`box` 答案是新增的一种 answer。
  - 官方 `api.md` 的请求体表里目前**没有** `assets` 字段，只有 `state`、`model`、`questions`；`assets` 只写在 images 页。**推断**：API reference 还没更新，以 images 页为准。

### 1.2 请求里怎么放图（问题 1）

出处：https://docs.typesafe.ai/images.md 。

- **开关**：「To use them, send the `TypeSafe-Danger-Zone-Images: true` header with each request that contains an image or a Box question.」没带头而请求里有图，返回 `400`。
- **位置**：不是放在 `state` 里，而是顶层 `assets` 字典，再在 `state`、`instructions`、`criteria` 里用引用字符串占位。"Each image is listed once, in the request's top-level `assets` map. Its key in that map is a reference string. Write the reference wherever the image belongs, as a whole string value or inside a longer string, and the model receives the image in its place."
- **格式**：两种。
  - JSON 里的 base64：`{"type": "image", "format": "jpg", "data_base64": "/9j/4AAQSkZJRg..."}`。"Use the standard base64 alphabet with `=` padding, no line breaks or other whitespace, and no `data:` prefix." `format` 只能是 `png` / `jpg` / `jpeg`（小写），用 `data_base64` 时必填。
  - `multipart/form-data`（官方推荐）：第一部分叫 `request`，是 JSON；每张图是一个文件部分，`assets` 里用 `part` 指向它。"Multipart is the better choice: it sends the file as it is, while base64 makes each image about a third larger."
  - 不收 URL，不收 `data:` URI。**推断**（文档里没有任何 URL 或 data URI 的字段）。
  - 官方 SDK（Python `typesafe-sdk` 0.7.5、JS `@typesafe-ai/sdk` 0.7.0，均 2026-10-14 发布）自动生成引用并走 multipart。mod 不能用 SDK，只能自己拼 JSON 或 multipart；**推断**：mod 沙箱里拼 multipart 比 JSON+base64 麻烦，但 base64 会让请求体大 1/3。
- **MIME**：只有 PNG 和 JPEG，静态图。"Format: PNG or JPEG, still images only. Animated PNGs are rejected." 其他格式（GIF、WebP、HEIC）要先转换。API 按字节判断格式，不看你写的 `format` 以外的东西（Python SDK 页："The API detects each image's format from its bytes."）。multipart 部分的 content type 只能是 `image/png`、`image/jpeg`、`image/jpg`、`application/octet-stream` 或不写。
- **大小与像素**（官方 Limits 表）：

| 限制 | 值 |
| --- | --- |
| 单张文件大小 | 16 MiB（base64 时按解码后算） |
| 宽、高 | 各 256 到 1568 px |
| 总像素（宽×高） | 78,400 到 2,458,624（280×280 到 1568×1568 的面积），256×256 太小 |
| 请求体 | 32 MiB（含 JSON、base64、multipart 边框），压缩不放宽 |
| 请求内所有图合计 | 32 MiB，按服务端处理（重编码）后的大小算 |
| 展开后的请求 | 32 MiB，每处引用都把图再算一遍 |

  - "All limits include both ends of the range. An image outside them is rejected, never resized to fit."
  - 出错码：`400`（没开头、图坏了、太小、资产没被引用、`max_tokens_exceeded`）；`413`（任一尺寸或体积上限）。
  - 其他要求："The API removes all metadata (EXIF, color profiles, comments) and does not apply the EXIF orientation."，要自己把像素转正；"Prefer standard JPEG"，渐进式 JPEG 要重存为 baseline。
- **每个请求的张数上限**：**未文档化**。官方只说 "How many images fit in one request depends on these limits and on the context length." 即受 32 MiB、上下文上限约束。每处引用都再算一次，所以「同一张图被多个问题引用」时，应放进 `state` 一次，各题按路径引用："When several questions use the same image, put it in the `state` once and refer to it by path from each question. That uses fewer tokens and less of the size limits."
- 引用规则要点：每个资产必须在请求里被引用，否则 `400`；对象的键（问题 ID、Choice 选项名）不会被替换；一个请求里所有引用字符串合计最多 65,536 字节；引用建议用每请求新生成的 UUID，避免和正文撞上。

### 1.3 图怎么计 token，算不算进上限（问题 2）

- 「Each image counts as input tokens, billed at the same per-token input price as text. There is no separate charge for images. The `usage.input_tokens` field in the response includes the tokens for every image in the request. Image tokens also count toward the request's context length.」
- 「We'll be providing guidance on estimating image token usage soon.」（均出自 https://docs.typesafe.ai/images.md ）
- **公式、表格、固定值：均未文档化**（官方、第三方都没有 Jev 的每图 token 数；OpenRouter 的 Jev 页也没有）。
- 超出时：`400`，`max_tokens_exceeded`："the images and text together exceed the request's context length. Send fewer or smaller images, or move images out of `instructions` into the `state`."
- 单题上下文的算法：「Per-question context: the `state` plus any one question.」放在某题 `instructions` 里的图会算进那一题（**推断**，依据 "An image in a question's `instructions` is part of that question and is sent only with that question."）。
- **第三方**（OpenRouter）说：「Requests with more than about 32,000 bytes of text, and every request with an image, run in TypeSafe's long-context mode, which TypeSafe says is slower and less accurate than staying within its default limits.」（https://openrouter.ai/docs/guides/community/jev ；https://openrouter.ai/docs/guides/community/multimodal-decisions ）。TypeSafe 自己的文档没有这句话，所以「带图请求是不是一律走长上下文模式、算不算 262k 上限」**需要实测**（见第 5 节）。

### 1.4 上下文上限（问题 3）

出处：https://docs.typesafe.ai/models.md 。

| | 默认 | 加 `TypeSafe-Danger-Zone-Long-Context: true` |
| --- | --- | --- |
| 请求上下文（`state` 加所有题） | 64k | 262k |
| 单题上下文（`state` 加任一题） | 32k | 262k |

- 原文：「With the header, the per-request context and the per-question context are both 262k tokens. Requests without the header keep the default limits in the table above.」「Long context is off by default and works on both Jev 1.14 and Jev 1.13.」
- 「Long context costs the same per token as any other request. It is slower and less accurate than staying within the default limits, so turn it on only for requests that need it.」
- 「There is no separate limit on the number of questions in a request.」
- **第三方的数字有冲突**：AlphaSignal 写 "Long context: 256,000 / 128,000"，称单题上限是 128,000（https://alphasignal.ai/news/typesafe-ai-s-jev-1-14-brings-vision-and-256k-context-to-typed-decisions ）。官方模型页写的是两个都是 262k。以官方为准。另外，官方只写 "262k"，没有写精确值；OpenRouter 的 Jev 页写 262,144（**第三方**），与 pplx 的 262,144 相同。精确值是否一致**未文档化**。
- 官方对「长上下文会变差」的态度很明确：博客说「while we strongly recommend limiting context length, you no longer have to」；jaggedness 页："Accuracy falls as the state grows with content unrelated to the decision."（https://docs.typesafe.ai/model-jaggedness/jev-1.13.md ）

### 1.5 Box 题型（1.14 独有）

- 请求：`{"type": "box", "instructions": "the coffee mug in `photo`"}`，没有 `criteria`；模型必须用 `jev-preview` 或 `jev-1.14.0`。
- 答案：`{"type":"box","box":{"top":0.25,"bottom":0.82,"left":0.44,"right":0.84},"confidence":0.92}`，边是占图宽高的比例，原点在左上角。
- 「A Box answer is always a box. There is no "not found" answer」，要同时问一个 Noul 判断目标在不在。（https://docs.typesafe.ai/primitives/box.md ）
- 对 dispatch-pilot 的决策（effort、模型、skill）基本用不到，记在这里只为说明 1.14 的差别。

### 1.6 带图请求的延迟（问题 5）

- 官方对带图请求的延迟：**未文档化**。官方只说长上下文 "slower"。
- 参考（不是带图数据）：文本请求中位数 524.1 ms（见 `decision-models-and-caching.md` 第 0 节，Cloudflare changelog）。

### 1.7 官方示例（问题 7）

- TypeSafe 的 cookbook 目录（https://docs.typesafe.ai/llms.txt ，30 余篇）里**没有**带图的 cookbook。带图的官方示例只在 images 页和两个 SDK 页。
- 可以照抄的最小请求（来自 images 页的 "Base64 in JSON" 标签，字段原样，key 用占位符）：

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
TypeSafe-Danger-Zone-Images: true
```

```json
{
  "model": "jev-1.14.0",
  "state": {"door": "a3f1c2e8-door"},
  "assets": {
    "a3f1c2e8-door": {"type": "image", "format": "jpg", "data_base64": "/9j/4AAQSkZJRg..."}
  },
  "questions": {
    "person_present": {"type": "noul", "instructions": "Is there a person in `door`?"}
  }
}
```

  - 想让带图请求也能放进更大的上下文，再加头 `TypeSafe-Danger-Zone-Long-Context: true`（是否必须，见第 5 节）。
  - 多张图的「帧历史」写法也有官方示例：`state: {"frames": [{"seconds_ago": 2, "frame": "5c0e9a12-f1"}, ...]}`，问题里用 `` `frames[2].frame` `` 引用。

---

## 2. pplx（Perplexity Decisions API）

主要出处：https://docs.perplexity.ai/docs/decisions/quickstart （2026-10-14 重读，输入上限、body、题数、价格、延迟、速率这几个数字与 2026-10-13 读到的一致）。

### 2.1 请求里怎么放图（问题 1）

- **位置与格式**：放在 `state` 里，`state` 必须是数组，图是 OpenAI 风格的 `image_url` 部分，值是 base64 data URL：

```json
{
  "model": "pplx-decider-v1.1-27b",
  "state": [
    "Which color is the square?",
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
  ],
  "questions": {"color": {"type": "choice", "instructions": "What color is the square?", "criteria": {"red": null, "blue": null, "green": null}}}
}
```

  （官方原文。头和端点：`POST https://api.perplexity.ai/v1/decisions`，`Authorization: Bearer $PERPLEXITY_API_KEY`，不需要任何开关头。）
- **MIME**：「PNG, JPEG, and WebP data URLs are accepted. The API never fetches a URL: an `http` or `https` image URL returns `400`.」其他格式（GIF 等）：文档只列了这三种，其余**推断**为不支持。
- 「An image can also be the whole `state`, with no text.」
- 图只写在 `state` 里。图能不能放在问题的 `instructions` / `criteria` 里：**未文档化**（文档只有 `state` 的写法）。
- 请求体里有未知的顶层字段返回 `400`（"An unknown top-level field returns `400`."），所以别用 SGLang 自托管文档里的 `images` 字段（那是自托管 `/v1/systemone` 路由的写法，见 https://docs.sglang.io/cookbook/autoregressive/Perplexity/pplx-decider-v1-27b ，**第三方**）。
- **大小与像素**：「The API reads images in 32 × 32 pixel tiles. Keep each image at or under 2,048 tiles: round the width and the height to the nearest multiple of 32 and keep (width / 32) × (height / 32) at or under 2,048. 1440 × 1440 and 2048 × 1024 fit; 1600 × 1310 does not. A larger image does not return `400`: the request waits about a minute and then returns `504`. Resize before you send.」2,048 个图块 = 2,097,152 像素（约 2.1 MP）。没有单独的最小尺寸和单文件字节数上限；整个请求体上限 32 MiB（超出返回 `413`）。
- **张数上限**：**未文档化**，只受「输入 token 小于 262,144」和「body 32 MiB」约束（"Under 262,144, counting `state`, images, and every question"）。

### 2.2 图怎么计 token，算不算进上限（问题 2）

- 「Image tokens count toward `usage.input_tokens` and the input limit like text. In our tests an image cost about 1,000 input tokens per megapixel.」（quickstart）
- cookbook 给出另一个数：1280×800 的截图是 1,000 个图块，"The screenshot accounts for about 6,000 of the roughly 7,300 input tokens in each request."，五步合计 36,944 token（https://docs.perplexity.ai/docs/cookbook/examples/decisions-api-browser-agent/README ）。
- **两处不一致**：1280×800 ≈ 1.02 MP，按 quickstart 应约 1,000 token；cookbook 却是约 6,000。**推断**：每图块约 6 token（cookbook 的值），那么一张 2,048 图块的满尺寸图约 12,000 token；若 quickstart 对，则约 2,100 token。**要用 `usage.input_tokens` 实测**（见第 5 节）。
- 没有分块公式以外的表格；不分「低/高清」档位。**推断**：没有 `detail` 参数（pplx 页没提；OpenRouter 对 Decisions 的 `detail` 说 "accepted"，部分模型忽略，**第三方**，且不是 pplx 直连）。

### 2.3 上下文上限（问题 3）

- 输入上限：「Input tokens per request: Under 262,144, counting `state`, images, and every question」；请求体 32 MiB；题数每请求 1–128；`choice` 选项 1–255；`score` 档位 1–10。
- 没有 Jev 那样的「单题上下文」概念，文档只有一个输入上限。**推断**：所有题共享同一个 `state`，总量限制是一个。

### 2.4 价格（问题 4）

- 「The Decisions API costs $0.02 per million input tokens. Output tokens are free, and there is no per-request fee.」「you pay for input tokens only. The `state`, every question, and any images count as input」（https://docs.perplexity.ai/docs/getting-started/pricing ；quickstart）。没有另收图像费。
- changelog：v1.1 把价格从 $0.04 降到 $0.02；「Requests that still name `pplx-decider-v1-27b` continue to work and bill at the same $0.02 rate.」（https://docs.perplexity.ai/docs/resources/changelog ）

### 2.5 带图请求的延迟（问题 5）

- 文本：「a request with a few hundred input tokens answered in under 2 seconds, about 90,000 tokens took 5 seconds, about 190,000 tokens took 14 seconds, and just under the input limit took 23 seconds」（2026-09-30 的测试）。文档没有按图像单独给延迟。
- **带图的官方数据点**（cookbook）：每步一张 1,280×800 的截图，约 7,300–7,500 input token，五次请求 1141、417、267、258、305 ms；"The first request took about a second; the others took a quarter to half a second."；代码注释："a 1,000-tile screenshot answers in about a second"。
- 对比同一站点的纯文本 triage cookbook："most requests 150–250 ms at 590–659 input tokens"（这一句出自第三方 jev101.org 对该 cookbook 的转述；cookbook 页上的原话需以页面为准，本文未逐字核对）。
- 超限的图会阻塞约一分钟再 `504`（见 2.1），不是延迟问题而是失败方式。

### 2.6 速率限制、模型 ID 与其他

- 速率：「Every organization can send 10 requests per second to the Decisions API, on every plan. A token limit also applies to large bursts.」token 限额的数字**未文档化**，大图请求可能先触到它（**推断**）。
- 模型：`pplx-decider-v1.1-27b`（文档默认）和 `pplx-decider-v1-27b`（仍可用）。没有 `-latest` 别名：「Invalid model 'pplx-decider-v1.1-27b-latest'」会返回 `400`。响应的 `model` 字段只回显你发的名字，所以拿不到「实际是哪个版本」。
- 超时建议：「The examples on this page use 30 seconds, which covers any request under the input limit; for small inputs, 10 seconds is plenty.」

### 2.7 官方示例（问题 7）

- **带图**：Drive a Browser with the Decisions API（https://docs.perplexity.ai/docs/cookbook/examples/decisions-api-browser-agent/README ）。核心请求结构（cookbook 里的 `decide()`）：

```python
body = {
    "model": MODEL,                       # "pplx-decider-v1.1-27b"
    "state": [
        f"Goal: {goal}",
        f"Step {step}. Last action: {last_action}",
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
        f"The clickable elements carry red numbered badges 1 to {count}. Answer with the badge number.",
    ],
    "questions": build_questions(count),
}
```

  文字、图、文字混排在同一个 `state` 数组里，每次请求都重发目标，"the model retains nothing between requests"。
- 其余 Decisions cookbook（ticket-triage、answer-gate、action-gate、quote-finder）都是纯文本。triage 页写："This recipe sends text only; the same request accepts images in `state` when your tickets carry screenshots."
- **第三方**：Vercel 的 "How to classify images with Perplexity's Decisions API" 用 sharp 把图缩到 1024×1024 以内再转 PNG，对应 2.1 的限制（https://vercel.com/i/classify-images-perplexity-decisions-api ）。

---

## 3. 两者对比表

| 项 | Jev（`jev-1.13.0` / `jev-1.14.0`） | pplx（`pplx-decider-v1.1-27b`） |
| --- | --- | --- |
| 是否需要开关 | 要：请求头 `TypeSafe-Danger-Zone-Images: true`，官方称 "Dreamer-ready"，不建议生产 | 不要，正式功能 |
| 图放在哪 | 顶层 `assets` 字典 + `state` / `instructions` / `criteria` 里的引用字符串 | `state` 数组里的 `image_url` 部分 |
| 编码 | multipart（推荐）或 `data_base64` + `format`；不收 URL / `data:` URI | 只收 base64 data URL；`http(s)` 返回 400 |
| MIME | PNG、JPEG（静态） | PNG、JPEG、WebP |
| 单张大小 | 16 MiB（解码后） | 未文档化（受 32 MiB body 约束） |
| 像素范围 | 宽高各 256–1568；总像素 78,400–2,458,624；范围外拒绝、不缩放 | ≤ 2,048 个 32×32 图块（约 2.1 MP）；超出挂约 1 分钟后 `504` |
| 每请求张数 | 未文档化（受上下文和 32 MiB 约束，每处引用都重复计） | 未文档化（受 262,144 token 和 32 MiB 约束） |
| 图像 token | 未文档化（"guidance … soon"） | 文档自相矛盾：≈1,000/MP 或 ≈6/图块 |
| 计入上限吗 | 计入 | 计入 |
| 上下文 | 默认 64k/请求 + 32k/题；加长上下文头后都是 262k | 262,144（<），含图和所有题 |
| 价格 | $0.042/M 输入，输出免费，图像不另收 | $0.02/M 输入，输出免费，图像不另收 |
| 带图延迟 | 未文档化 | cookbook：1,000 图块截图 258–1141 ms；超限图约 1 分钟后 504 |
| 速率 | 按组织，数字在控制台；图像无单独限额 | 10 请求/秒/组织 + 未公开的 token 限额 |
| 模型 ID | `jev-latest`（现为 1.13.0，约一周后换成 1.14.0）、`jev-preview`（1.14.0）、固定版本 ID；响应的 `model` 回显实际版本 | `pplx-decider-v1.1-27b`、`pplx-decider-v1-27b`；无别名；响应只回显发送的名字 |
| 其他 | 1.14 独有 `box` 题型；60/30 天废弃通知 | 无 |
| 带图官方示例 | images 页、SDK 页；cookbook 目录里没有 | 浏览器 agent cookbook |

---

## 4. mod 这一侧能拿到哪些图

依据：`dispatch-pilot/.claude-plugin/types/claude-code/index.d.ts`（Claude Code 2.1.300 生成，共 16,670 行；该目录在 `.gitignore` 里，用 `cat -n … | grep` 或 Read 查看）。dispatch-pilot 以 user scope 安装，不是 mod managed settings install。本节只读声明，**没有运行**任何 mod，所以「声明说能读」不等于「实测能读」。

### 4.1 逐项核对

| 来源 | 声明里写了什么（行号） | user scope 能拿到吗 |
| --- | --- | --- |
| `$.prompt.media({ id })` | 第 3032–3043 行："Returns one image or document of the prompt being submitted, by the `id` `e.attachments` lists it under: its bytes, base64, 4 MiB a call. For a mod managed settings install, in its `prompt.submit` hook; else `{ deny }`". 第 9028–9085 行 `PromptMedia` 重申："Only a mod managed settings install is answered, inside that submission."；图是引擎缩放之后的字节，一次最多 4 MiB，用 `next` 偏移续读 | **不能。** 返回 `{ deny }` |
| `prompt.submit` 的 `e.attachments` | 第 9372–9394 行 `PromptSubmitAttachment`："A pasted or attached non-text item of a submitted prompt; its kind, never its bytes"。字段：`type: 'image' \| 'audio' \| 'document'`、`mediaType?`、`filename?`、`id?`。第 9450–9453 行："Present only when the submission carried images or other non-text items." | **能，但只有元数据**，没有字节。能知道「这条消息带了几张图、什么类型、叫什么名字」 |
| `prompt.submit` 的 `e.text` | 第 9421–9425 行："The prompt's text as typed, pastes already expanded"；第 9360 行："`@file` mentions and pasted images are not expanded for a plugin's prompt"（指 `$.prompt.submit` 发出的提示） | 文本里有没有图的占位符，声明**未说明**，需要实测 |
| `$.session.messages({ as: "api" })` | 第 643–681 行 `ApiMessage` / `ApiContentBlock`："`type` names its kind (`text`, `tool_use`, `tool_result`, `image`, `document`, `thinking`, ...). The other fields are that kind's as the Messages API defines them (see its reference); the engine hands the block over as it holds it, nothing renamed or dropped." 内容："text, tool_use and tool_result (paired across an assistant message and the next), image and document. Media inline as the engine holds it". 第 2791–2824 行：最多 4096 条，"blocks intact" | **声明说能**：返回的 `image` 块带内联媒体（块的字段按 Messages API，**推断**为 `source: { type: 'base64', media_type, data }`，需实测）。这个函数没有 managed 限制的说明，dispatch-pilot 现在已在 user scope 调用 `$.session.messages()` |
| `$.session.messages()`（不带 `as`） | 第 11593–11622 行 `SessionMessage`：`text` 是 "Its text blocks joined"，`toolResults` 的 `text` 是 "The result as the model read it (text blocks joined)" | **看不到图。** 只有文本；dispatch-pilot 现有代码（`core.ts`、`context.ts` 等）读的正是这个形态 |
| 子 agent 的图 | 第 11663–11682 行：`agentId` 读某个子 agent 的会话，`as: "api"` 同样可用；读不了就 `{ deny }` | 能（同上），agent 结束后读不到 |
| 工具结果里的图 | 第 13713–13747 行 `ToolResultSummary`：`text` 只是文本块拼接；`result` 是 "What the transcript stored for the call"，类型 `unknown`。`BuiltinToolResults` 为空接口（第 1082 行），内置工具的结构化结果声明里**未写**是否含图。`$.mcp.call` 的结果类型 `McpToolResult` 明写会有 `image` 块（第 6052–6073、6141–6159 行："text, image, resource, resource_link"），但那是 mod 自己调 MCP 的结果，不是会话里工具的结果。`session.append` 第 11021–11039 行："Rewritable: text blocks, a tool_result's `content` and `is_error`. Media blocks may be dropped or moved, not changed or added." | **`tool_result` 的 `content` 里能不能有 `image` 块：声明没有逐字说，但「tool_result 的 content 可改写」和「Media blocks may be dropped or moved」两句合起来，意味着行里可以有媒体块（推断）。** 实际要从 `{ as: "api" }` 的结果里看 `tool_result.content` 是不是数组、里面有没有 `image`，需要实测 |
| `session.append` 事件 | 第 4458–4469 行："Fires once per row a conversation of this session keeps (a prompt, a response block, a tool result, a notice), before it is stored." `e.message.content` 是 `ApiContentBlock[]`；`e.door` 是 `'prompt' \| 'tool-result' \| …`（第 10958 行） | 声明未写 managed 限制，user scope 应该能收到（**推断**，需实测）。这是在图被存进会话**之前**看到它的位置，可以丢掉或移动媒体块，但不能改、不能加 |
| `$.fs.read(path, { as: "bytes" })` | 第 3298–3325 行：`{ base64 }`，最大 4 MiB | 如果事件里能看到图的文件路径（例如 Read 工具的 `file_path`、`@file` 提及），mod 可以自己读字节。路径从哪个事件拿，声明未说 |
| `$.process.run(argv)` | 第 3575–3598 行：运行主机命令，"CLI only" | 可以调用系统的图像工具缩放（例如 macOS 的 `sips`），仅 CLI；这是**推断**，沙箱本身没有图像编解码 |

### 4.2 dispatch-pilot（user scope）在哪些事件里读得到哪些图

下表是**推断**，依据 4.1 的声明与事件顺序（`prompt.submit` 是「输入成为用户消息之后、进入会话之前」，第 9416–9419 行），需要用 `docs/research/event-probe/run.sh` 用带图的提示实测。

| 事件 / 调用 | 能得到什么 |
| --- | --- |
| `prompt.submit`（`main-effort.ts` 现在在这里做 effort 决定） | 只有 `e.attachments` 的元数据；字节读不到（`$.prompt.media` 返回 `{ deny }`）。此时本条提示的图**还不在**会话里，`$.session.messages({ as: "api" })` 读到的是之前的消息。结论：**本轮消息自带的图，在 `prompt.submit` 里发不到决策模型** |
| `session.append`（`door: 'prompt'`），在 `prompt.submit` 之后 | 本条提示的 `content` 里应有 `image` 块（带内联字节），可读、可丢，不可改；但它晚于 `prompt.submit`，要用它就得把 effort 决定挪到更晚的地方 |
| `turn.start` / `turn.step` / `tool.call` / `turn.complete` | `$.session.messages({ as: "api" })` 里有**之前所有轮**的图（用户贴的、工具返回的），最多 4096 条；中途重判（`midturn-effort.ts`）、find_skill、升级判断（`escalation.ts`）用这条路最合适。注意：带图的会话这个调用返回的数据量可能很大，要在 mod 里按需过滤 |
| 子 agent 的 `tool.call` / `turn.step` | `$.session.messages({ as: "api", agentId })`，图同上 |
| 工具结果里的图（比如 Read 读到一张 png） | 只有在 `{ as: "api" }` 里（如果 `tool_result.content` 里有 `image` 块）或 `session.append { door: 'tool-result' }` 里；`ToolResultSummary.text` 里没有 |
| `$.prompt.media` | 不可用（user scope） |

**推断出来的实际含义**：
1. 用户直接贴图的那一轮，如果还想让 effort 决定看到图，在 user scope 下只能把决定推迟到 `turn.start` 之后（那时图已经进了会话），而这会改变 dispatch-pilot 现在「发消息时立刻决定」的时序，值得单独评估。
2. 装成 managed 才能在 `prompt.submit` 里拿字节，这是组织级安装，对个人使用不现实。
3. 无论走哪条路，mod 沙箱没有图像编解码，图的缩放、转码要靠 `$.process.run` 调系统命令，或者只发满足限制的图、其余的发文字占位。引擎自己会缩放图（"after the engine's own resize"），缩放后的最大边长声明里**未写**，因此无法保证落进 Jev 的 256–1568 px 或 pplx 的 2,048 图块范围。

---

## 5. 未文档化与待实测的事项

| # | 问题 | 现状 | 怎么测 |
| --- | --- | --- | --- |
| 1 | Jev 每张图的 token 数（公式 / 表格 / 固定值） | **未文档化**，官方说 "guidance … soon" | 发几张已知尺寸的图（256×256 以上的几档），记 `usage.input_tokens` 减去纯文本基线 |
| 2 | pplx 每张图的 token 数：≈1,000/MP 还是 ≈6/图块 | 官方两处矛盾 | 同上，用 1024×1024、1440×1440 等 |
| 3 | Jev 带图请求是否一律走长上下文模式、是否必须带 `TypeSafe-Danger-Zone-Long-Context` | 只有第三方（OpenRouter）说「every request with an image」走长上下文；TypeSafe 文档没说 | 带图请求只加图像头、不加长上下文头，看是否 `max_tokens_exceeded` |
| 4 | Jev 带图请求的延迟，以及长上下文模式对延迟的影响 | **未文档化** | 单张图、几张图，各测若干次 |
| 5 | pplx 带图延迟随图块数的变化 | 只有 1,000 图块一个数据点 | 256 / 1,024 / 2,048 图块各测 |
| 6 | Jev 与 pplx 在「看图后决定 effort / 模型 / skill」这类任务上的准确率 | 官方只有 "all models (Jev included) perform worse on multimodality over pure text"；没有按任务的数字 | 做一份带图的标注集，对比不带图的结果，看图是否真的改变决定 |
| 7 | pplx 每请求张数上限、图能不能放进 `instructions` / `criteria` | **未文档化** | 小规模探测，不要长循环 |
| 8 | pplx 的 token 限额数字 | "A token limit also applies to large bursts."，数字**未文档化** | 看 `x-ratelimit-*` 响应头 |
| 9 | Jev 速率限制的具体数字 | 只在控制台 | 读控制台，不用发请求 |
| 10 | Jev 废弃日期 | 只有 60 天 / 30 天的承诺，政策 "prior to this" 发布 | 关注 TypeSafe 之后发布的废弃政策 |
| 11 | `{ as: "api" }` 里 `image` 块的真实字段、`tool_result.content` 里是否有图、`session.append` 在 user scope 是否触发、`e.text` 里图的占位符 | 声明的描述是「按 Messages API」，未给字段 | 用 `docs/research/event-probe/run.sh` 带一张图和一次读图工具调用实测 |
| 12 | 引擎缩放后的最大边长 | 声明未写 | 同上，读 `image` 块的字节头 |
| 13 | Jev 模型页 "Input: Text" 与 images 页 "both accept images" 的矛盾 | 以 images 页为准（推断） | 带头发一个小请求即可确认，属于之后的实验 |
| 14 | 图像数据的保留和训练政策 | 本次没有查 Perplexity 的图像保留政策；Jev 的模型页写 "Jev is not trained on customer requests or responses."，但博客另有一个 opt-in 的「调试」选项 | 上线前读 Perplexity 的 Privacy & Security 页和 TypeSafe 的 Legal 页 |
| 15 | TypeSafe Python SDK 的 basic usage 页写 "As of November 14, 2026, image support is only dreamer-ready." | 日期在调研日之后，疑似笔误（应为 October） | 无需处理，记在这里避免误引 |

---

## 6. 来源清单

**官方：TypeSafe**
- https://docs.typesafe.ai/images.md （图像：请求格式、限制、token、错误；2026-10-14 抓取）
- https://docs.typesafe.ai/models.md （模型、别名、上下文、长上下文头、价格、速率）
- https://docs.typesafe.ai/api.md （端点、请求规则、错误码；尚无 `assets`）
- https://docs.typesafe.ai/primitives/box.md
- https://docs.typesafe.ai/sdk/python/usage/basic.md ；https://docs.typesafe.ai/sdk/python/api/types/assets.md ；https://docs.typesafe.ai/sdk/python/changelog.md
- https://docs.typesafe.ai/sdk/javascript/changelog.md ；https://docs.typesafe.ai/sdk/javascript/api/functions/image.md ；https://docs.typesafe.ai/sdk/javascript/api/variables/withAssets.md
- https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- https://docs.typesafe.ai/llms.txt （cookbook 目录）
- https://typesafe.ai/blog/jev-1-14 （2026-10-14 发布公告）

**官方：Perplexity**
- https://docs.perplexity.ai/docs/decisions/quickstart
- https://docs.perplexity.ai/api-reference/decisions-post
- https://docs.perplexity.ai/docs/getting-started/pricing
- https://docs.perplexity.ai/docs/resources/changelog
- https://docs.perplexity.ai/docs/cookbook/examples/decisions-api-browser-agent/README （带图 cookbook，含延迟与 token）
- https://docs.perplexity.ai/docs/cookbook/examples/decisions-api-ticket-triage/README
- https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers （无 Decisions 条目，Decisions 的 10 请求/秒只在 quickstart）
- https://docs.perplexity.ai/llms.txt

**第三方**
- https://openrouter.ai/docs/guides/community/jev ；https://openrouter.ai/docs/guides/community/multimodal-decisions （OpenRouter 对 Jev 与 pplx 的转述；「every request with an image run in … long-context mode」只在这里）
- https://alphasignal.ai/news/typesafe-ai-s-jev-1-14-brings-vision-and-256k-context-to-typed-decisions （把单题长上下文上限写成 128k，与官方不符）
- https://explainx.ai/blog/jev-1-14-danger-zone-multimodal-box-long-context-claimed-vs-verified-2026
- https://vercel.com/i/classify-images-perplexity-decisions-api
- https://docs.sglang.io/cookbook/autoregressive/Perplexity/pplx-decider-v1-27b （自托管路由，不适用于托管 API）
- https://jev101.org/guides/pplx-decider-guide

**本地**
- `/Users/alexnear/Documents/claude-mods/dispatch-pilot/.claude-plugin/types/claude-code/index.d.ts` （Claude Code 2.1.300 生成的声明，第 4 节的依据）
- `/Users/alexnear/Documents/claude-mods/docs/research/decision-models-and-caching.md` （体例参照；Jev 文本延迟中位数）
