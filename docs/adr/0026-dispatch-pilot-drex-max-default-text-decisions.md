# Dispatch Pilot：文字的判断默认用 Nace 的 Drex Max v1.1，看图留在 Jev

用户 2026-11-13 的决定：「把文字决策默认改成 drex，看图留在 jev」。0.13.0。

依据：

- 调研（`docs/research/drex-max-decision-model.md`，2026-11-12 读的 Nace 和 TypeSafe 官方文档）：Drex Max v1.1 和 Jev 是同一套 System One 协议，请求和回答的形状相同；整个请求一个 262,144 token 的上限，没有 Box 题；每百万 input token 0.03 美元（Nace 称是五折的发布价）。Nace 的指南不给门槛：「There is no built-in cutoff」「Choose a threshold from a labeled sample」「Pin a model ... when you tune a threshold」。
- 对照（DEVELOPMENT.md「Drex Max v1.1」，同一天、同一份数据集、同一套题面和代码，各跑一遍）：发消息时的 effort 和派出 agent 两边持平（94.0% / 95.0% 对 97.0% / 94.0%，87.0% / 87.0% 对 89.0% / 89.0%，逐题配对 p 0.75 和 0.42），运行中的 effort Drex 高（83.6% / 83.6% 对 78.7% / 79.5%，p 0.013），skill 推荐 Drex 高得多（86.2% / 83.5% 对 25.7% / 30.3%）。Drex 的延迟约是 Jev 的两倍（单个请求 p50 约 0.52 秒），四套题的花费约六成。
- 看图：给 Drex 设计的不靠 Box 的方案（同一个请求里附上放大的分块）和 Jev 现在的方案抓到的差异一样多（15 / 20），但把两处差异判成过（Jev 一处），而且更慢。

决定：

- **`decisionModel` 的默认是 `drex`**（`core/setup.ts` 的 `DEFAULT_BACKEND`、`backendNameOf`，plugin.json 的 `default`）。Jev 要点名（`decisionModel: jev`）才用，和 pplx、d1-ultra、d1.1 一样。不按密钥自动换（ADR 0014 不变）：没有 Nace 的 key 时不发请求，看板写明缺 `naceApiKey` 或 `NACE_API_KEY`。
- **后端 `decision/drex.ts`**：`POST https://console.nace.ai/v1/systemone`，Bearer 认证，固定 `drex-max-v1.1`（不用 `drex-latest`，照 Nace 说的调门槛时钉版本），不带请求头，不收图和 Box 题。key 是新选项 `naceApiKey` 或环境变量 `NACE_API_KEY`。没有 mod 自己的限速，429 读成「被限速」。照 `BackendDefaults` 注释里的清单改了 `BackendName`、`setup()`、`BACKEND_DEFAULTS`、`DECISION_MODELS`、`rateLimited`、plugin.json、README 的配置表，以及评测的 `PRICES`、`ESTIMATE_FACTOR`、`BACKENDS`、`--backend`。
- **题面、预算和读法都用 Jev 的**（`DREX_DEFAULTS`：`TYPESAFE_GUIDE`，state 24000，带 skill 题的 6000）。这就是评测时发给它的请求；Nace 说门槛在标注样本上定，这套评测就是那份样本，在上面 Drex 用 TypeSafe 的线不输 Jev。`timeoutMs` 2500、`skillsSecondStageMs` 1000（按测到的延迟），`longWaitMs` 没有（没有长上下文头），`agentLanes` 4。
- **看图留在 Jev**（`chooseImageBackend` 不变）：有 TypeSafe 的 key 用 Jev，否则有 Perplexity 的 key 用 pplx，都没有就不可用。所以默认配置下要两个 key：Nace 的管文字，TypeSafe 的管图。

考虑过的其他做法：

- **看图也换成 Drex**：对照里没有更好，最不该出的错（差异判成过）还多一处，放大复核和全屏「哪里不同」也都要 Box 题。以后要再试，方向是把分块切细，或者先用一道选择题让 Drex 指出部件在哪一块。
- **为 Drex 重写题面**：mod 的问法已经是 Nace 的 Questions 页推荐的形式；改了就分不清差别来自模型还是问法。skill 的选择题没有逐条对照 Nace 的建议（兜底选项、短描述），留着没动。
- **在 Drex 上重定门槛**：评测集只有几百题，在同一批题上定门槛又报成绩会偏乐观；现有的线下它已经不输。原始概率都存着，以后可以离线重扫。
- **放大预算到 Drex 的窗口**：没有量过更长的 state 要多久、准不准，评测用的是 24000。
- **保留 Jev 为默认、Drex 作为选项**：用户要的是换默认。

要知道的：

- 升级到 0.13.0 而没设 `decisionModel` 的，从 Jev 变成 Drex：要补上 Nace 的 key，或者把 `decisionModel` 设成 `jev`。
- Nace 的 Drex 文档没有写它是否保留请求里的 state（它的 data-retention 页讲的是文档工具），Terms、Privacy 和 DPA 没有读。
- 评测各只跑了一遍；Jev 同一套题重复三遍时本身有 1 到 2 个点的波动。题集当初是对着 Jev 调问法的。
- Nace 说繁忙时一个请求可能排队到 55 秒，mod 一条消息只等 2500 毫秒，过了就不经路由地放行。
