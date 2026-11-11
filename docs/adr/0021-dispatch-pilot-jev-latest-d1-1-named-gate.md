# Dispatch Pilot：Jev 用 jev-latest，可选 Liquid 的 d1.1，skill 门控加 cookbook 的 named 一题

用户 2026-11-10 的三个决定，都照决策模型提供方最新的文档改：

1. 「让 jev 使用 latest 始终指向最新版本」：Jev 的请求，带图的和不带图的，都用 `jev-latest`，不再固定 `jev-1.14.0`。
2. Liquid 也加上最新的模型 `d1.1`，作为 `decisionModel` 的一个选项，放在 `d1-ultra` 旁边。
3. skill 推荐的第一段跟上 TypeSafe skill 推荐 cookbook 新加的 `named` 一题。

依据（2026-11-10 读的原文）：

- TypeSafe 的 models 页（docs.typesafe.ai/models）：别名表里 `jev-latest` 指向 `jev-1.14.0`，「The most recent stable, official release. The default in our client SDKs」；「An alias moves when a new release ships, so its answers can change without any change to your code. Each response's `model` field gives the versioned ID that answered, so you can log which model produced each result. If you have tuned confidence thresholds against one version, send that version's ID instead of the alias, and switch to the new version when you are ready.」；「Box questions need Jev 1.14」。
- Liquid：`GET /decisions/v1/models` 列出 `d1`（2026-09-29）、`d1-ultra`（2026-10-14）和 `d1.1`（2026-10-19），三个都收文字和图。d1 的文档页：`d1.1`「Default hosted decision model」，`d1-ultra`「Most capable decision model」。decision-model skill：「`d1.1` (default, lower cost) or `d1-ultra` (most capable, for harder decisions)」。API 参考：「the input limits apply to the state, images, and one question together: `d1` and `d1.1` allow 65,536 tokens and `d1-ultra` 32,768, and all three 250 KB of text, and they return 422 over either」；「Up to 128 named questions」；「A request is billed its state and images once plus each question's own tokens」；「`d1:latest` and `d1-ultra:latest` always point to the newest model of their family; pin an exact id such as `d1-ultra` to keep the same model」（`d1:latest` 现在答题的是 `d1.1`）。价格：每百万 input token d1.1 0.02 美元，d1-ultra 0.042，回答的 `usage.cost` 也是这个数。Decision Model Guide 的例子现在都用 `d1.1` 写，二元判断（`p > 0.8` 拦截、`p < 0.2` 放行）、路由（置信度低于 0.5 退到最强）和重排（高于 0.5）都没变。
- TypeSafe 的 skill 推荐 cookbook（docs.typesafe.ai/cookbooks/skill_suggestion，2026-10-30 渲染的版本）：`ACTION_THRESHOLD = 0.30`（「mean of the three action nouls; at or above it, a skill is wanted」，原来叫 `GATE_THRESHOLD`）、`NAMED_THRESHOLD = 0.50`（「the "names a method" noul; at or above it, a skill is wanted too」）、`NAMED_QUESTION = "Does the request ask for a specific named tool, format, template, or method to be used, rather than for general help?"`；`needs_skill(wide)`：「Either reason is enough: an action is wanted, or a named method is asked for.」，`return wide["action"] >= ACTION_THRESHOLD or wide["named"] >= NAMED_THRESHOLD`。正文：「A turn can need a skill for either of two reasons: it wants an action taken, or it names a method a skill owns ... `named` measures the second, so it gets its own threshold instead of joining the average, where the three action answers would outvote it. We suggest nothing only when both reasons come back low.」例子是要一张「格鲁的计划」梗图：不动用户的任何东西，三道动手题都低（0.12），点名题 0.87，推荐 meme 的 skill。结果（Hermes 的 194 个 skill，452 个请求，`jev-1.14.0` 加 `claude-haiku-4-5`）：装错 skill 从 15.7% 降到 7.9%，不该装时装了从 14.0% 降到 5.2%。

决定：

- **Jev 用 `jev-latest`**（`decision/jev.ts` 的 `JEV_MODEL` 和 `JEV_IMAGE_MODEL`）。文档说的代价是：对着某个版本调过门槛的，要钉那个版本。我们的门槛是 TypeSafe 的起始值，没有对着哪个版本调过（ADR 0014），所以不钉。回答的 `model` 写着答题的版本，debug log 每个请求那一行（`describeAsked`）照旧记下它。带图的请求也用别名：框题要 1.14，别名现在指向它；Jev 再出新版时，看图和文字一起换。评测（`eval/run.ts`）默认也问 `jev-latest`，结果文件的 `backend.answeredBy` 记下版本；要停在某个版本，用 `--model`。
- **`decisionModel: d1.1`**：`decision/liquid.ts` 的同一个后端，模型固定 `d1.1`（不用 `d1:latest`），看板和日志里叫 `d1.1`，key 同 d1-ultra（`liquidApiKey`、`LIQUID_API_KEY`），回答按 `LIQUID_GUIDE` 读，失败的字（被限速等）同 d1-ultra。图仍给 Jev（`chooseImageBackend` 不变）：Liquid 的模型现在也收图，但放大复核要 Jev 的 Box 题，Liquid 的 API 没有。照 `BackendDefaults` 注释里的清单改了 `BackendName`、`backendNameOf`、`setup()`、`BACKEND_DEFAULTS`、`DECISION_MODELS`、`rateLimited`、plugin.json 的选项、README 每张配置表的一列、`eval/node.ts` 的 `backendFor` 和 `PRICES`、`eval/run.ts` 的 `--backend d1.1`（读它自己那一行默认值）、`eval/lib/estimate.ts` 的 `ESTIMATE_FACTOR`、`eval/lib/docs.ts` 的 `BACKENDS`。`eval/eval-v2-flow.ts` 没有加：它按 TypeSafe 的线挪未解决次数，Liquid 的模型按自己的线读，d1-ultra 也不在里面。
- **d1.1 的默认值**：预算和 d1-ultra 一样（effort、派出 agent、Workflow 24000，带 skill 题的 6000），没有因为上限翻倍放大：48000 的 state 实测 4.6 秒，超过一条消息的等待。`timeoutMs` 3500（满预算的请求单发最慢 2.27 秒的约 1.5 倍）、`skillsSecondStageMs` 1000（第二段最慢 0.63 秒）、`findSkillWaitMs` 跟 `timeoutMs`（两段合计 1.1–1.3 秒）、`agentLanes` 4（4 个满预算的请求同时发最慢 3.3 秒），数字见 DEVELOPMENT.md「d1.1 的预算」。
- **计费核实了**：同一份 state 问 1 道和 5 道很短的题，d1.1 和 d1-ultra 都计 2,992 和 3,096 token：state 只算一次，每道题加上它自己的 token，和 API 参考一致。d1 的文档页还写「Every question is charged for its text and all the images again」，图没有量（mod 不给 Liquid 发图）。eval 的 `--backend d1` 仍按每题一份 state 估算（偏高），`--backend d1.1` 按实际的计法。
- **skill 推荐加点名题 `skills.named`**（`decision/skills.ts`，GLOSSARY 的「点名题」）：第一段在三道门控题后面加 cookbook 的 `NAMED_QUESTION`，一字不改。题面说「the request」，state 里叫 `user_message`；三道门控题也是照原话写的（ADR 0018），这一题同样。`readGate` 另记 `named`；`wantsSkill` 是 cookbook 的 `needs_skill`：门控的平均到了 `gateBelow`，或 `named` 到了 `namedBelow`，有一个就发第二段，两个都低才不推荐。门槛在 `decision/guides.ts` 的 `SkillBars.namedBelow`：TypeSafe 0.50，到了就算（cookbook 的 `>=`）；Liquid 0.2，它的二元判断里「明确的否」，和 `gateBelow` 0.2 同一个来源。`named` 没有回答时不算理由，只看平均，和以前一样。`find_skill` 不问门控，也不问它。决策日志的理由写成 `要不要 skill 0.12、点名方法 0.87（两项分别低于 0.30、0.50 才不推荐）`，`named` 没有回答时照旧只写平均；评测的结果行多记 `named`。

考虑过的其他做法：

- **Jev 继续钉版本，有新版时跑评测再换**：用户不要。门槛本来就不是对着版本调的，钉版本只是把变化推后。
- **d1.1 的预算放大到上限的九成**：请求慢一倍以上，超过一条消息的等待；TypeSafe 说长上下文更慢、不那么准，Liquid 的文档没写长度和准确率，没有理由放大。
- **用 d1.1 换掉 d1-ultra**：用户要的是加一个选项；d1-ultra 仍是 Liquid 说的「most capable」。
- **`named` 并进门控的平均**：cookbook 明说不这样做，平均会把它压下去。
- **Liquid 的 `named` 也用 0.50**：Liquid 的读法里 0.2 以下才是明确的否，和门控平均是同一条线，两条线同一个来源。

代价：

- Jev 换版本时 mod 的判断跟着变，事先没有评测，只能事后对照 debug log 里的版本。看图的行为也会跟着变（图像是 TypeSafe 说的「Dreamer-ready」功能）。
- d1.1 在发消息时的几套评测上没有跑过，读法是 Liquid 的示意值。2026-11-10 满预算的请求它比 d1-ultra 慢（中位约 1.7 秒对 1.06 秒），小请求快一点。
- Liquid 的 `named` 线 0.2 很低：点名题到 0.2 就发第二段，第二段会多发几次；第二段的相关度要高于 0.5 才推荐，挡得住不相关的。
- `named` 在我们的评测集上只在 Jev 上量过一遍（见验证）：218 个回答里它单独决定了 3 个。cookbook 的数字是在 Hermes 的 skill 上量的。每条消息的第一段多一道题，约 30 token。
- README 的每张配置表多了一列 `d1.1`，以后加的选项每行要多写一格（`tests/docs-sync.test.ts` 查格数）。

验证（2026-11-10）：

- `scripts/check.sh dispatch-pilot` 通过（测试、`validate --strict`、tsc、`eval/validate.ts`）。新加和改的测试：`tests/d1-1.test.ts`（选它、默认值、请求的模型和名字、没有 key、环境变量里的 key、被限速的字），`tests/skills.test.ts`（`named` 的原话、点名题单独过门槛、0.50 到了就算 0.49 不算、两家的线、`named` 没有回答只看平均、`find_skill` 不问），`tests/jev-1-14.test.ts`（请求的 model 是 `jev-latest`，debug log 记下答题的版本）。
- Liquid 的实测见 DEVELOPMENT.md「d1.1 的预算」：59 个请求，约 0.022 美元。
- `named` 在真实的 d1.1 和 d1-ultra 上各问了六条合成的消息（8 个编出来的 skill，mod 自己组装的第一段，12 个请求）：梗图请求 d1.1 平均 0.44、点名 0.96（d1-ultra 0.65、0.77）；「按 Conventional Commits 的格式帮我写这次提交的说明」点名 1.00 和 0.97；「Explain what a monad is」点名 0.09 和 0.05，「这个报错什么意思」0.03 和 0.03，平均都在 0.05 以下，不推荐。这六条里点名题都没有单独决定过（它高的时候平均也过了 0.2）。
- Jev 当天没有实测（环境里的 TypeSafe key 被拒绝，401），用户给了新 key 之后补了。`jev-latest` 的回答写着 `jev-1.14.0`，和 models 页一致；真实会话里（`claude -p`，2.1.322）发消息、skill 两段和中途的请求都由它应答。
- `skill` 评测在 Jev 上跑了一遍（`dispatch-pilot/eval/results/skill/2026-11-11-jev-named.json`，文件名的日期是 UTC；109 题中英各一遍，410 个请求，约 0.094 美元，答题的是 jev-1.14.0）：该不该推荐、推荐哪个，对 78.9% / 78.0%（中文 / 英文）。点名题单独让第二段发出的有 3 个回答：skill-084 中英各一个（三道动手题的平均 0.28 和 0.297，点名 0.74 和 0.62，推荐对了），skill-023 中文一个（没有 skill 合适，点名 0.51，第二段没有推荐，多发了一个请求）；没有点名题时这一项是 78.0% / 77.1%。门控拦下的：没有 skill 合适的 68 个回答里 15 个，有 skill 合适的 150 个里 11 个（没有点名题是 13 个）。同一次运行里给用户的 `try /x` 提示偏多：中文 109 个回答里 79 个给了提示，64 个是评测集认为不该给的（英文 71 和 57），连提示一起算对的只有 25.7% / 29.4%。提示的读法是 0.9.0 定的（ADR 0018），这次没有动；评测集的 `user_only_hint` 是按 0.9.0 之前的做法标的，这个数先当线索。

版本 0.11.0（和 ADR 0020 同一个版本）。

改了 ADR 0008（带图的请求固定 `jev-1.14.0`）、ADR 0014（门槛不按版本调，现在也不按版本钉）、ADR 0017（可选的 Liquid 模型多了 d1.1）和 ADR 0018（第一段多了点名题，自己一条门槛）。
