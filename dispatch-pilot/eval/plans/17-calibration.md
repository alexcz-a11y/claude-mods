# #17 上下文范围扫描与门槛校准：第二阶段方案

> **2026-10-05 更新：范围已缩减。** 按用户的决定，#17 不再跑任何对比或扫描评测，只做了不花钱的收尾。现状、每条验收项的状态和没做的实验见 8.8 节；第 0–7 节的方案和预算作废，只留作记录。8.4–8.7 节的 Clef 截断探针已经做完，结论有效。

这是 #17 第一阶段的交付：设计、估算、待拍板的问题。第一阶段没有发出任何会产生费用的请求；下文的数字来自 `run.ts --estimate`、已存结果的离线重算，以及各票实测过的 token 数和延迟。用户确认方案和预算之后再进入第二阶段。

## 0. 结论先行

- **AC 要求的「2、4、8、16 步 × 1k、2k、4k、8k token」扫描，在现有四套评测集上几乎是空操作**（第 1.1 节）。现有题目的上下文太短：effort-submit 75 题没有上下文、24 题只有 2 条；state 最大只有约 420 token，token 预算一格也起不了作用；16 格 × 4 套共 13,088 个请求里，不同的只有 1,226 个，其中 818 个（默认格）已经有回答。照原样跑，「中文准确率距最好不超过 1 个百分点的最小组合」会由波动决定，结果必然是最小的那一格（2 条 × 1k），但这并不说明真实会话里 1k 就够。要让这条 AC 有实验依据，需要一个长上下文的补充评测集（拍板 D1）。
- **各配置单次运行的波动是 0–3 个百分点**（第 1.2 节），和 AC 的 1 个百分点、3 个百分点同一量级，所以每个要做决定的配置都要重复跑（第 2 节）。
- **Jev 的费用不是约束，Clef 的免费额度才是。** 完整方案 Jev 约 2.7 美元，Clef 约 11.5 万 neurons（免费额度约 12 天，或开通 Workers Paid 后一两天跑完，用量约 1.3 美元，另加月费）；精简方案 Jev 约 0.9 美元，Clef 约 1.9 万 neurons（含余量），包括今天在内 3 天跑完，都在免费额度之内（第 4 节）。
- 需要拍板的设计问题见第 5 节：D1 长上下文补充集、D2 skill 与 effort 的请求结构（第 4 条）、D3 按后端取默认值的机制（第 9 条）、D4「预期内失败」的标注、D5 问题语言按后端、D6 Clef 的付费方式、D7 改共用的档位描述。

## 1. 已经离线确认的事实（零费用）

### 1.1 扫描在现有评测集上几乎没有差别

用评测的拼请求代码（与 mod 相同）把每套评测集在 16 个格子里各拼一遍，比较请求是否逐字相同（mod 的默认值是 4 条 × 2000 token；midturn 的「步数」是 `rejudgeSteps`，其余是 `contextMessages`）：

| 评测集 | 每格回答数 | 16 格里不同的请求 | 与默认格不同的回答 | state 的估算 token（p50 / p90 / 最大） |
|---|---|---|---|---|
| effort-submit（`en-score`） | 200 | 204 / 3,200 | 2、8、16 步各 2 个（就是那一道有 6 条上下文的题）；token 预算一个也不改变 | 71 / 135 / 202 |
| effort-midturn（`en-score`） | 200 | 386 / 3,200 | 2 步 176 个；8、16 步 10 个（有 5 步的那 5 题）；token 预算一个也不改变 | 260 / 342 / 417 |
| subagent（`models-hint`） | 200 | 200 / 3,200 | 0（派出 agent 不读最近的消息，brief 也都短于 1k） | 180 / 234 / 283 |
| skill（`profiles`） | 218 | 436 / 3,488 | 只有 8k 那一列 218 个全变：那是 `questionBudget(8000)` 把画像裁短了（问题变了），不是上下文 | 44 / 83 / 153 |

原因是评测集本来就不是为扫描上下文写的：effort-submit 的 `recent_context` 条数是 0（75 题）、2（24 题）、6（1 题），skill 是 0（89 题）、2（20 题），midturn 的 `recent_steps` 是 2–5 步。

所以在现有数据上，只有「midturn 的 2 步 对 4 步」能测（176 个回答不同），其余的格子要么和默认格逐字相同，要么只差几题。照 AC 原样跑 16 格，`run.ts --estimate` 给出的单个变体费用是：effort-submit 16 × 0.0059 美元、midturn 16 × 约 0.007 美元、subagent 16 × 0.013 美元、skill（`profiles`，按实测）16 × 约 0.21 美元，合计约 3.8 美元 Jev；Clef 上 skill 一项就要约 123 万 neurons（免费额度 120 多天）。而其中 90% 以上是重复的请求。第二阶段给运行器加一个按请求内容去重的缓存（第 6 节），同一个请求只发一次、各格共用回答，现有数据上的整个网格只剩约 190 个新请求（skill 的 8k 一列另算，那是画像裁剪，归 E3）。

我原想用本机的 transcript 统计真实会话里最近 2/4/8/16 条消息有多长（只算大小，不输出内容），好判断 token 预算在实际使用中会不会起作用；这一步被权限分类器拦下了，没有做，也不会换办法去做。用户愿意的话，可以自己运行这段统计（第 6 节列出了它要做什么），结果能帮助决定 D1。

### 1.2 单次运行的波动

用同一配置重复跑过的结果（effort-submit 3 次，midturn 2 次，subagent 3 次，skill 2 次，都是 Jev）：

- 每个变体、每种语言的准确率在几次运行之间的标准差是 0–2.8 个百分点，合起来约 1.1；两次运行之间对错变了的题有 0–7 题（每 100 题）。
- 最大的一次摆动：midturn `en-score` 的中文 77 → 73。effort-submit 的 `zh-score` 比 `en-score` 高约 8 个百分点，3 次运行都是，标准差不到 1.2，这种差别远超波动。

### 1.3 工具的执行时间（延迟门槛用）

数据来源：本机 `~/.claude/projects/` 下的 transcript，只读了每一行的时间戳和工具名，没有读消息内容和工具的输入输出，也没有发到任何地方。293 份 transcript 里主 agent 的 18,029 次工具调用（去掉了等人回答的 AskUserQuestion、ExitPlanMode）：平均 5.3 秒，p50 1.66 秒，p25 235 ms；25% 短于 300 ms，47% 短于 1.5 秒。时间是从 tool_use 那一行到 tool_result 那一行，包含等用户批准权限的时间，所以偏长。

- AC 写的是「延迟 p90 小于工具的平均执行时间」。按平均值（5.3 秒），Jev 和 Clef 在所有格子上都满足；按更严的 p50（1.66 秒），Jev 仍然全满足，Clef 只有 state 约 2k token 以内满足（见下一节）。方案按两种口径都报，默认值按 p50 口径取。
- 同一份分布还可以离线定 `rejudgeWaitMs`：回答在「工具执行时间 + 等待」之内到达的比例（第 3 节 E0）。

### 1.4 延迟随请求大小的变化

各票的实测：Jev 约 0.8k token 时 p50 280 ms，8.6k 时 317–362 ms，21.9k 时 561–615 ms，即每多 1k token 约多 13 ms（另有整体慢的时段）。Clef 约 0.5–0.6k token 时 633–699 ms，1.1k 时 802 ms，1.5 万 token 时 3.7–7.9 秒，即每多 1k Clef token 约多 250 ms。按这个关系估算 Clef 的 p50：state 1k 约 1.0 秒，2k 约 1.2 秒，4k 约 1.8 秒，8k 约 2.9 秒。所以 Clef 的 4k、8k 两列不用实测准确率就可以按延迟排除（AC 的延迟条件），第二阶段只用截断探针（E1）顺带量几个点来核对这个关系。

### 1.5 费用换算

- `run.ts --estimate` 的系数（1.6）是按 Jev 的计数校准的。同一个请求，Clef 计的 input token 约是 Jev 的 0.67–0.69 倍（460 对 626；effort-submit 200 个请求 102,900 对约 153,600；skill 第一段 1.5 万对 2.19 万）。下文的 Clef token 都按「估算 × 0.68」或实测值算。
- 1 neuron 约等于 45 个 Clef input token（实测 2,300 neurons 对 102,900 token）。每天免费 10,000 neurons，约 45 万 Clef token；超出部分 0.24 美元/百万 token，即每 1,000 neurons 0.011 美元。今天各票已经用掉约 35 万，剩约 10 万 token（约 2,200 neurons）。
- 一个变体、中英各跑一遍的费用（Jev 用实测，Clef 用实测或按上面换算）：

| 评测集 | 请求 | Jev input token | Jev 美元 | Clef input token | Clef neurons | 占免费额度 |
|---|---|---|---|---|---|---|
| effort-submit | 200 | 15.4 万 | 0.0065 | 10.3 万（实测） | 2.3k | 0.23 天 |
| effort-midturn | 200 | 18.2 万 | 0.0076 | 12.5 万（实测） | 2.8k | 0.28 天 |
| subagent | 200 | 25.6 万 | 0.011 | 22 万 | 4.9k | 0.5 天 |
| skill `descriptions` | 约 430 | 215 万 | 0.09 | 147 万 | 33k | 3.3 天 |
| skill `profiles` | 约 420 | 500 万 | 0.21 | 345 万 | 77k | 7.7 天 |

`run.ts --estimate` 对 skill 给的是上限（第二段按每题都发、短名单排满算：`profiles` 0.337 美元、`descriptions` 0.159 美元），实测约是它的 60%，上表用实测。

## 2. 重复几次，怎样算有差别

- **Jev：每个要据以做决定的配置跑 3 次**（effort-submit、midturn、subagent、预期内失败）；skill 每次约 0.1–0.2 美元、两次运行的标准差不超过 0.65，跑 2 次。按 1.2 节的波动，单次运行时两个配置之差的标准差约 1.7 个百分点，3 次平均后约 1.0，可以把 3 个百分点的差别和波动分开；2 个百分点勉强；1 个百分点在任何负担得起的次数下都分不开（要十几次），而且 100 题里 1 个百分点就是 1 题。
- **判定规则：** 平均后相差不到 2 个百分点算持平，取上下文更小、更便宜的那个；AC 的「距最好不超过 1 个百分点」照算照报，但注明它在噪声以内，两条规则结论不同时以 2 个百分点为准，并在结果里写明。再加一道逐题的配对检查：3 次里至少 2 次 A 对 B 错的题，和反过来的题，做符号检验，p < 0.1 才算真的有差别。
- **Clef：** 精简方案每个配置只跑 1 次，作为筛选；完整方案对前两名相差不到 2 个百分点的 Clef 决定再跑 1 次。
- **门槛防过拟合：** 门槛都在同一套题上扫，所以按题号单双分两半：一半上选值，另一半上验证；取平台中间的值，按 0.05 取整。
- **去重缓存与重复：** 同一配置的重复运行要真的重新请求（缓存只在同一次运行的各格之间共用），否则测不到波动。

## 3. 实验

各实验的顺序有讲究：门槛要在最终的问题写法上校准（问题语言和档位描述一变，confidence 的分布就变），所以先定写法（E2、E7），再定请求结构（E3）、上下文（E4），最后在最终写法的运行上离线校准门槛（E0b 在最终运行上再做一次）。

### E0 离线（零费用，先做）

- **E0a 网格去重**（1.1 节已做）。运行器加按请求内容去重的缓存后，扫描只发不同的请求。
- **E0b 门槛重扫，按后端、按语言**（第 1 条）：
  - effort-submit 的 `thetaMax`：已存的各档概率 `p` 重新 `pickEffort`。Jev 3 次 × 4 个变体，Clef 1 次 `en-score`。
  - midturn 的 `thetaUp`、`thetaDown`、`thetaMax`：已存 `p` 和 `confidence`，用 `judgeMidturn` 重新判断，评 `sent`。midturn 还没有 `breakdown.sweeps`，第二阶段补上（同 subagent 的写法）。Clef 的 confidence 中位数 0.24（Jev 0.66），另扫一种读法：Clef 改看概率最高那一档的概率（DEVELOPMENT.md「待评测」提过）。Jev 2 次 × 5 个变体，Clef 1 次。
  - subagent 的 `agentOverride`、`thetaNamed`、`thetaMax`：已有 `breakdown.sweeps`，Jev 4 次。Clef 只有 24 个回答，要 E6。
  - skill 的 `skillsMinRelevance`、`findSkillMinRelevance`：已有 sweeps，Jev 2 次。`skillsShortlist` 1–3 和第二段下限 0.1 以上也能离线模拟：已存第一段前 5 名的份额（`first`）和第二段的相关度（`fits`），按第一段的顺序取前 k 个、只保留它们的 `fits` 即可；短名单 5 个以上或下限低于 0.1 要重新请求（每次约 0.21 美元，完整方案可选）。
  - `thetaExpected` 没有可用的数据，要 E8。
- **E0c 中英差距现状**：effort-submit、midturn、subagent 都过 3 个百分点的门槛；skill `profiles` 两次都是 −3.7，不过。离线把 `skillsMinRelevance` 改成 0.75 时是 −2.3。最终运行（E10）后再判，不过就另开新票。
- **E0d 延迟门槛与 `rejudgeWaitMs`**：1.3 节的工具时间分布配上各后端的延迟分布，算出回答在「工具时间 + `rejudgeWaitMs`」之内到达的比例，按后端定 `rejudgeWaitMs`（不是本票的 AC，但同一份数据，顺带给出建议）。

### E1 Clef 是否截断 state（AC，今天就能做，排在所有 Clef 运行之前）

- 做法：新写 `eval/probe-truncation.ts`。state 里放已知长度（约 1k、2k、3k、6k 估算 token）的无关填充，另有一个只有读到才答得出的探针事实，分别放在 state 开头（对照）和末尾；问题是一个 Choice，问探针的内容。中英各一遍。另发 2 个「长问题」探针：决定答案的选项放在约 8k token 的 criteria 列表末尾，看截断是否也作用于问题（skill 画像在 criteria 里）。每个请求同时记下 `usage.input_tokens` 和延迟，用来核对 1.4 节的延迟关系。Jev 发同样的请求作对照。
- 规模：Clef 18 个请求，约 7.5 万 token，约 1.7k neurons，今天剩下的额度够；Jev 约 11 万 token，约 0.005 美元。
- 已于 2026-10-05 完成，实际做法与上面略有不同（每个请求同时问开头、中间、末尾三个事实，9 个请求），设计、结果和补测建议见 8.4–8.6 节。
- 结论直接影响后面：如果 Clef 真的只读前约 2k，Clef 的 2k 以上的格子都不用测，`contextTokens` 对 Clef 的上限就是 2k；如果问题（criteria）也被截断，Clef 读不到排在后面的 skill，带画像或描述的 skill 排序在 Clef 上都不可靠，E3 的 Clef 抽样就不必做，D2 里 Clef 那一半直接变成「选 Clef 时默认关掉 skill 推荐」。

### E2 问题用英文还是中文写（第 2 条）

- 已有数据：Jev 上 effort-submit 的 `zh-score` 比 `en-score` 高约 8 个百分点（3 次，稳定）；midturn 两种语言持平；`en-choice` 的中英差距 3 次都正好是 −3（没有余量），所以 Choice 不考虑，保持 Score。
- 缺的：subagent 和 skill 没有中文问题的变体（`dispatched-agent.ts`、`skillsPart`、`rerankPart` 都已经支持中文，评测的 suite 只是没开出来）；Clef 只跑过英文问题。
- 要跑的：
  - Jev：subagent `models-hint` 的中文问题 3 次（600 个请求，约 0.03 美元）；skill `profiles` 的中文问题 2 次（约 0.42 美元；精简方案不跑，或在 E3 选出的裁剪画像上跑 1 次，约 0.13 美元）。
  - Clef：effort-submit `zh-score` 1 次（2.5k neurons，排在 E1 之后的第一个付费 Clef 运行）；midturn `zh-score` 1 次（2.8k，只在完整方案）；subagent 中文问题全量 1 次（4.9k，完整方案；它同时是 E6 的数据）。
- 决定的方式：每个后端用一种问题语言（所有问题都用它），除非某一套明显反对。这是代码改动：现在 `setup()` 固定用 `DEFAULT_ASK`（英文）。

### E3 skill 与 effort 的请求结构（第 4 条）

背景：skill 第一段带画像约 2.19 万 Jev token，和 effort 在同一个请求里。Jev 慢的时段有 11% 的消息第一段就超过 1500 ms，effort 跟着没有经过路由；Clef 上第一段 3.7–7.9 秒，`timeoutMs` 3000 下每条消息都超时。

- **E3a 生产形状下的 effort 准确率**：effort-submit 的题按线上的样子附上 skill 问题（带画像）再问，看 effort 的准确率和单独问时是否不同。现在的 effort-submit 评测只测单独的 effort 请求，而线上打开 skill 推荐时从来不是单独的。Jev 1 次（选定的问题语言），200 个请求 × 约 2.2 万 token，约 0.18 美元。没有离线的办法。
- **E3b 裁剪画像**：skill suite 加两种裁剪变体：T1 只用英文画像（去掉三个中文字段，第一段估计约 1.4 万 Jev token）；T2 英文、只留「用途」和「何时用」（再去掉「何时不用」）。另有一个不用改代码的近似：`--option contextTokens=8000` 时 `questionBudget` 会先去掉「不用于」字段、再把末尾的 skill 改回描述（1.1 节表里 skill 8k 那一列）。Jev 每种裁剪 2 次，每次约 0.13 美元。
- **E3c 拆成两个并行请求的延迟**：同一个 key 并发发出 effort 请求和 skill 请求，20 条消息、40 个请求，看 Jev 是否把它们依次处理（DEVELOPMENT.md「评测」实测：2 个并发时 p50 从约 280 ms 变成约 540 ms）。约 0.02 美元。拆开之后准确率不会变（同一个 state、同样的问题，只是分开发），所以不需要跑全量。
- **Clef**：不跑全量。在 E3b 选出的最小裁剪上抽 10 题 × 中英（20 个回答，约 20 万 Clef token，4.4k neurons），只看延迟和是否答得上。
- 预判和要拍板的问题见 D2。

### E4 上下文范围（AC 的扫描）

- **E4a 现有数据上能测的部分**：midturn 的 2 步对 4 步（176 个不同的回答）和 8、16 步（10 个），开去重缓存后 Jev 3 次共约 560 个请求，约 0.02 美元；Clef 1 次 2 步（176 个请求，约 11 万 token，2.5k neurons）。effort-submit 只有那一道 6 条上下文的题在 2、8、16 步时不同（中英 2 个回答，3 次共约 6 个请求，可以忽略不计）；subagent、skill 的格子不必再请求。和默认格逐字相同的格子直接共用已有的回答，结果照 AC 的格式填表，注明「请求相同」。
- **E4b 长上下文补充集（D1 选 b 时）**：
  - `effort-submit` 补 30 题（中英对照）：每题之前有 8–16 条接近真实长度的消息（共约 6–10k token）。一半是「稀释」题：较早的消息是别的已经做完的工作，决定这条消息的上下文就在最近两条里，测上下文多了会不会变差；一半是「深度」题：决定档位的信息在 3–12 条之前（例如更早说定的范围），最近几条只是「好」「继续」之类，测上下文少了会不会丢分。由 Claude 起草，像前四套一样由 Opus 5.5 high 的审核会话审核。
  - `effort-midturn` 补 20 题：8–16 步的轨迹，决定性的事件在 5–12 步之前。
  - 开去重缓存后，effort-submit 的长题在 16 格里约有 10 个不同的请求（1k 那一列都相同），midturn 约 7 个。
  - Jev：每格 3 次，effort-submit 长题约 1,800 个请求、约 980 万 token（按估算系数 1.6，偏上限），约 0.41 美元；midturn 长题约 840 个请求、约 290 万 token，约 0.12 美元。
  - Clef：只跑关键的格子：effort-submit 长题 {2, 4} 条 × {1k, 2k}（3 个不同的请求）、midturn 长题 {2, 4, 8} 步 × {1k, 2k}（4 个），各 1 次，约 69 万 Clef token，15.3k neurons（约 1.6 天）。4k、8k 按 1.4 节的延迟关系排除，E1 的延迟点用来核对。
- 选法：AC 的规则（中文准确率距最好不超过 1 个百分点里取最小，再要求延迟 p90 小于工具的平均执行时间），同时报 2 个百分点规则和 p50 口径；「最小」先比 token 预算、再比条数，因为延迟和费用随 token 走。Jev 和 Clef 各定一组。

### E5 Workflow 一个请求放几个 agent（第 5 条）

- 评测集里 39 道 workflow 题来自 14 个 workflow，每个 2–4 题，所以按脚本原样分组时一个请求最多 4 个 agent，`MAX_PER_REQUEST` 的 8 个测不到。做两种分组：按 workflow 原样（14 组，就是 mod 会发的样子），和把不同 workflow 的题拼成 8 个一组（每种语言 5 组，最坏情形：其他 agent 的 brief 全是无关内容）。和已有的一个请求一个 agent 的回答（Jev 4 次运行）逐题比较。
- subagent suite 加一个用 `workflowBatches` 分批的变体。Jev 3 次，约 110 个请求（每种语言 14 + 5 组）、约 60 万 token，约 0.025 美元；Clef 原样分组 1 次，约 8.6 万 token，1.9k neurons（只在完整方案）。

### E6 Clef 的派出 agent 门槛（第 1 条）

Clef 的 subagent 只有 12 题抽样。全量 1 次（选定的问题语言；中文时就是 E2 那一次），4.9k neurons；精简方案抽 50 题，2.5k。之后和 Jev 一样离线扫 `agentOverride`、`thetaNamed`、`thetaMax`。

### E7 档位描述里的「写测试」（第 6 条，审核规则 R4）

- 现在 high 档写着「writing tests」（「编写测试」），把写测试整体放在 high，submit-056（给二十来行的纯函数补几个已经列明的用例，只接受 medium）一直答错。改成按范围：设计测试方案、为难以测试的代码设计 mock 放在 high；照着已经列明的用例补测试放在 medium（中英两版一起改）。
- 这五档的描述（`effort.ts` 的 `LEVELS`）是所有 effort 问题共用的：发消息时、中途重判、派出 agent、Workflow、强制升档都用它。所以不是两道题的对照，要重跑：effort-submit（选定语言和 `en-score`，各 3 次，约 0.04 美元）、midturn 2 次（约 0.015 美元）、subagent 1 次抽查（约 0.011 美元），用 `compare.ts` 逐题看 055、056 和其他题有没有变坏。Clef：effort-submit 1 次（2.3k neurons，只在完整方案）。

### E8 「失败是不是预期内的」（第 7 条）

- 标注：midturn 里有失败的 28 题（失败 2 次以上的只有 6 题）加一个标注「这些失败是不是预期内的」（TDD 红灯、没结果的搜索、探测……对比真的卡住），完整方案再补约 12 题让两类大致平衡。由 Claude 起草、Opus 审核会话审核（D4）。
- 请求：和 mod 发的相同（`midturnState` + 带 `trouble` 的 `midturnEffortPart` + `expectedFailurePart`），比较三种问法：现在的写法、反过来问「是不是卡住」、不带 `criteria`。
- Jev：40 题 × 中英 × 3 种问法 × 2 次，约 480 个请求，约 0.02 美元（精简：28 题、两种问法，约 0.01 美元）。Clef：现在的写法加最好的另一种，1 次，约 12 万 token，2.7k neurons（精简：只跑现在的写法，0.9k）。
- 离线按语言、按后端校准 `thetaExpected`，指标是「预期内的放过、卡住的升档」两边的准确率。

### E9 只能由用户触发的 skill 挤占短名单（第 8 条）

- 第一段改成两个 Choice：主 agent 能加载的 skill 加「都不合适」一个，只能由用户触发的 skill 加「都不合适」一个，两类各自取短名单（033、090、091、092 这几题的病因）。这是排序代码（`decision/skills.ts`）的改动，先作为一个变体评测，赢了再换成默认。
- Jev 2 次（精简 1 次，用 E3 选出的画像形式），约 0.13–0.42 美元。Clef 不跑（费用），结构跟随 Jev 的结论。

### E10 最终运行和中英差距（AC）

- 所有默认值定下来之后，用最终的写法和设置：Jev effort-submit 3 次、midturn 2 次、subagent 2 次、skill 2 次（约 0.33 美元）；门槛的最终校准（E0b）就在这些运行的回答上离线做。
- Clef：effort-submit、midturn、subagent 各 1 次（和 E2、E6 的设置相同时直接用那几次，约 1 万 neurons 以内）；skill 在最终的裁剪画像上全量 1 次（约 48k neurons，约 5 天），只在完整方案。
- 四套都确认中文准确率比英文低不超过 3 个百分点（按几次运行的平均，并列出单次最差）；不过的另开新票。

## 4. 两档方案

| 实验 | 完整：Jev 美元 | 完整：Clef neurons | 精简：Jev 美元 | 精简：Clef neurons |
|---|---|---|---|---|
| E0 离线 | 0 | 0 | 0 | 0 |
| E1 截断探针 | 0.005 | 1.7k | 0.005 | 1.7k |
| E2 问题语言 | 0.45 | 10.2k | 0.02 | 2.5k |
| E3 请求结构 | 0.74 | 4.4k | 0.45 | 4.4k |
| E4a 现有数据上的扫描 | 0.02 | 2.5k | 0.02 | 2.5k |
| E4b 长上下文补充集（D1 选 b） | 0.53 | 15.3k | （另加 0.53） | （另加 15.3k） |
| E5 Workflow 分批 | 0.025 | 1.9k | 0.01 | 0 |
| E6 Clef 派出 agent | 0 | 4.9k（中文问题时并入 E2） | 0 | 2.5k |
| E7 档位描述 | 0.07 | 2.3k | 0.05 | 0 |
| E8 预期内失败 | 0.02 | 2.7k | 0.01 | 0.9k |
| E9 分开取短名单 | 0.42 | 0 | 0.13 | 0 |
| E10 最终运行 | 0.33 | 58k | 0.2 | 0（用 E2、E4a、E6 的运行） |
| 合计 | 约 2.6（另加可选的短名单重扫 0.4） | 约 10.4 万，加重试余量约 11.5 万 | 约 0.9（选 b 时约 1.4） | 约 1.45 万，加上建议的 Clef midturn 最终运行约 1.7 万，加余量约 1.9 万（选 b 时约 3.6 万） |

- **完整方案**：Clef 约 11.5 万 neurons，约 510 万 Clef token。按免费额度（每天按 9,500 用，留余量）约 12 天；开通 Workers Paid 的话一两天跑完，用量约 1.3 美元，另加月费（按 Cloudflare 现行价目，Workers Paid 每月 5 美元起，超出每日免费额度后每 1,000 neurons 0.011 美元；开通前以控制台为准）。大头是 Clef 的 skill 全量（E10，约 48k）和长上下文的关键格子（E4b，约 15k）。
- **精简方案**：Clef 只跑关键组合，免费额度内 3 天（包括今天）：
  - 今天（剩约 2.2k）：E1 截断探针（1.7k）。
  - 第 2 天（约 8.4k）：E2 Clef effort-submit `zh-score`（2.5k）、E4a Clef midturn 2 步（2.5k）、E6 Clef subagent 50 题（2.5k）、E8 Clef（0.9k）。
  - 第 3 天（约 4.4k，加上下面建议的 midturn 运行约 7.2k）：E3 Clef 裁剪画像抽样。
  - D1 选 b 时再加 2 天（E4b 的 15.3k）。
  - 精简方案不做的：Clef 的 midturn 中文问题、Clef 的档位描述复查、Clef 的 skill 全量（Clef 的 skill 门槛先沿用 Jev 的、标为暂定，或按 D2 默认关掉 Clef 的 skill 推荐）、Workflow 的 8 个一组、E9 的第二次运行、skill 的中文问题。
  - 精简方案的一个前提：Clef 的 `thetaUp`、`thetaDown` 用已有的 Clef `en-score` midturn 回答离线校准。如果 D5 让 Clef 改用中文问题，或者 E7 改了档位描述，这批回答就不再代表 mod 发出的请求，Clef 的中途门槛只能标为暂定；要让它有依据，就在第 3 天加一次 Clef midturn 运行（最终写法，约 2.8k neurons），第 3 天合计约 7.2k，仍在当天的额度内。我建议加上。
- **Jev 的墙钟时间**：完整方案约 1.3 万个请求，精简约 5 千个，1 个并发每个 0.3–0.6 秒，分别约 1.5–2 小时和 40 分钟。
- Clef 的每次运行都要在一天的额度内跑完（Cloudflare 额度用完时返回 3036，`run.ts` 会把剩下的题记为失败）；精简方案的每次运行都不超过 5k neurons。

## 5. 需要拍板的问题和预判

- **D1 上下文扫描怎么做。** (a) 只用现有数据：midturn 的 2 步对 4 步照常比较，其余格子按「请求相同」填表，token 预算和消息条数的默认值按延迟、费用和 midturn 的结果定，并在 README 写明「更长的上下文没有数据」。(b) 先做长上下文补充集（effort-submit 30 题、midturn 20 题，起草加审核约半天），在 #17 里做；或者 (b′) 把补充集另开一张票，#17 先按 (a) 定临时默认值。我建议 (b)：AC 明确要求这组扫描有实验依据，补充集不大，Jev 约 0.5 美元。预判：Jev 上 1k 已经够大多数消息，稀释题在 4k、8k 时也不会明显变差，深度题要 4 条以上；Jev 的默认值大概是 4 条（或 8 条）× 2k，和现在接近；Clef 因为延迟，大概是 2–4 条 × 1k–2k（如果 E1 证实它只读前约 2k，就是 2k 封顶）。midturn 的 2 步对 4 步，预判持平或 4 步略好，保持 4。
- **D2 skill 与 effort 的请求结构（第 4 条）。** 预判：Jev 上「拆成两个并行请求」换不来更短的等待，因为 Jev 对同一个 key 的并发请求依次处理，消息仍要等两个都回来；它唯一的好处是 effort 不再被慢的 skill 段拖累。Clef 上拆开也救不了：只有 skill 的第一段（带画像）仍要 3.7–7.9 秒。最可能有效的是裁剪画像：只用英文字段（T1）预计少约 40% 的 token、准确率损失不超过 1 个百分点（`profiles` 的中英差距本来就比 `descriptions` 大，去掉中文字段甚至可能缩小差距），Jev 的超时率会明显下降。建议先评测 E3a、E3b，「拆开」只做 E3c 的延迟抽样；拆开改变了 #10 AC 写明的做法，只有在裁剪之后 Jev 慢时段仍有 2% 以上的消息因 skill 段超时时，再请你决定是否拆开。Clef 上任何结构都很难让带画像的排序在 3 秒内完成，需要你在两条路里选一条：Clef 的 skill 推荐用描述或最小的裁剪、并允许 skill 段单独多等（每条消息多等 1–2 秒）；或者选 Clef 时默认关掉 skill 推荐（`find_skill` 保留）。我倾向后者，等 E3 的 Clef 抽样出来再定。
- **D3 按后端取默认值的机制（第 9 条）。** 引擎交给 mod 的选项是「填好默认值的」（生成的类型说明里写着 defaults filled in），mod 分不清「没设置」和「设成了默认值」。三种做法：(i) 这些字段在 manifest 里不写 `default`，说明文字写出 Jev 和 Clef 各自的默认值，`setup()` 在字段缺失时按后端（和消息的语言）取值；要先在 kit 和真实引擎里确认没有默认值的字段确实不传。(ii) 用哨兵值表示自动（数字门槛里 0 是有意义的值，不好用）。(iii) 只写一个默认值，README 给出 Clef 的推荐值，让选 Clef 的用户自己改。我建议 (i)。涉及的选项：`timeoutMs`、`contextMessages`、`contextTokens`、`rejudgeSteps`、`thetaUp`、`thetaDown`、`thetaMax`、`thetaExpected`、`agentOverride`、`skillsMinRelevance`、`findSkillMinRelevance`；`thetaNamed`、`thetaFit` 现在是代码里的常量，按后端分开就改常量表。门槛按语言分开时，按消息是否含中文取（mod 已经这样判断语言）；用户显式设置了某个值，就两种语言都用它。
- **D4 「预期内失败」的标注。** 给 midturn 有失败的 28 题加标注（完整方案再补约 12 题），由 Claude 起草、Opus 审核会话审核，和之前四套评测集一样以审核结论为准。可以吗？
- **D5 问题语言按后端。** 预判：Jev 全部改用中文问题（effort-submit +8 个百分点，midturn 持平，subagent 和 skill 待 E2）；Clef 待 E2，倾向同样用中文，但 Clef 只跑 1 次，差距在 2 个百分点以内就保持英文。这需要把 `setup()` 里固定的 `DEFAULT_ASK` 改成按后端取。
- **D6 Clef 的付费方式。** 完整方案在免费额度内约 12 天；开通 Workers Paid 一两天跑完，约 1.3 美元用量加月费。精简方案不需要开通。
- **D7 改共用的档位描述。** E7 改的是所有 effort 问题共用的五档描述，会影响每一个功能的判断；我会用 E7 的几次运行确认没有题变坏再合入。确认可以改吗？

## 6. 第二阶段的代码改动

- **评测：** 运行器按请求内容去重的缓存（同一次运行的各格共用回答）；`run.ts` 支持一次跑多个 `--option` 组合（一个格子一行汇总）；midturn 和 effort-submit 的离线门槛扫描（`breakdown.sweeps`），以及对已存结果重新汇总、不发请求的脚本；单双题号的交叉验证；截断探针 `eval/probe-truncation.ts`；suite 变体：subagent 中文问题、Workflow 分批（`workflowBatches`）、skill 中文问题、两种裁剪画像、两个短名单、effort-submit 附带 skill 问题、midturn 的「预期内失败」三种问法；长上下文补充集和「预期内失败」标注的校验规则（`lib/datasets.ts`）和审核记录。
- **mod：** 按后端（和语言）取默认值（D3，`core/setup.ts`、manifest、各功能读选项的地方，加接缝 1 的测试）；问题语言按后端（D5）；档位描述（E7）；画像裁剪（E3，如采用）；两个短名单（E9，如采用）；`MAX_PER_REQUEST`（E5，如要改）；manifest 里 `skillsShortlist` 的说明写的是「0.05」，代码里的下限是 0.1，顺手改正；README 的配置表、待评测和评测各节。
- **可选、需要你本人运行的统计：** 本机 transcript 里，每条你发的消息之前最近 2、4、8、16 条消息的估算 token 数（只输出分位数，不输出内容），用来判断 token 预算在实际使用中多常起作用。第一阶段我没有权限运行它。

## 7. 预计时间

- 精简方案：代码和数据约 1–1.5 个工作日（含一次审核往返），Jev 运行约 1 小时，Clef 3 个日历日（包括今天）；D1 选 b 时再加约半天和 2 个日历日。
- 完整方案：约 2–3 个工作日，Jev 运行约 2 小时；Clef 在免费额度内约 12 个日历日，开通 Workers Paid 则一两天。

## 8. 拍板结果和之后的变化（2026-10-05）

### 8.1 用户的决定

- **方案：** 完整方案，开通 Workers Paid（已开通，`~/.config/dispatch-pilot/eval.env` 里有 `CLOUDFLARE_WORKERS_PAID=yes`）。跑会超出每日免费额度的 Clef 任务之前，先确认这个标记还在。
- **D1：** 做长上下文补充集（effort-submit 30 题、effort-midturn 20 题），另行起草，由 Opus 5.5 high 审核；路径另行通知。E4b 按第 3 节做。
- **D2：** 按第 5 节的顺序，先评测裁剪画像（只留英文字段）。选 Clef 时，发消息时的 skill 推荐默认关闭（可以用 `/dp skills on` 打开），`find_skill` 保留；Clef 用裁剪后的画像能在 3 秒内答完，就重新默认打开。这一条要写进按后端取的默认值（D3）。
- **D3–D7：** 按第 5 节的预判做，由数据决定，结论写进本文件。
- **开工时间：** 第二阶段等第 1 轮代码审查的修复（`dp/review-fixes`）合入、补充集审核完成之后，从最新的 `dp/integration` 开始。

### 8.2 代码审查修复对本方案的影响

修复会改评测框架的保真度：卡住请求的拼装、Workflow 分批、`counts.failures` 的语义、工具结果的渲染、超时计数、`--option` 的布尔值、中英差距的判定（差距小于 3 个百分点才算通过），以及发给决策模型的问题措辞（改用术语表的词）。对本方案的影响：

- **已存的回答只能当预览。** 问题措辞一变，`results/` 里各次运行的回答就不再代表 mod 发出的请求。第 3 节里「直接共用已有的回答」的默认格（E4a）和离线门槛扫描（E0b）都要改用修复之后的新运行；E10 本来就在最终写法上重新跑、在它的回答上校准门槛，不受影响。多出的费用很小：E4a 的默认格重新问一遍（effort-submit 和 midturn 各 200 个请求 × 3 次，Jev 约 0.04 美元；Clef 的默认格并入 E10 的运行）。
- **中英差距的门槛按新的判定**：差距必须小于 3 个百分点。`en-choice` 那种正好 −3 的不再算通过。

### 8.3 审查提出、属于本票的两件事

- **故事 70：派出 agent 和 skill 两套补中文问法。** 已在 E2 里（subagent 中文问题 3 次、skill `profiles` 中文问题 2 次，Clef 的 subagent 中文问题 1 次），完整方案都做。
- **skill 带画像时差距 −3.7。** E0c 的预览（旧措辞）显示 `skillsMinRelevance` 取 0.75 时是 −2.3。在 E10 的最终运行上定默认值并附证据（几次运行的平均和单次最差都要小于 3 个百分点）；做不到就按 AC 另开新票。

### 8.4 E1 截断探针

- **设计依据。** Clef 的开源权重附带的编码代码（Hugging Face 上 `Cloudflare/clef` 的 `joint_schema_model.py`）里，state 的截断只保留开头：先 `state_ids[:max_state_tokens]`，再截到 `max_length` 减去问题和固定前后缀之后剩下的长度（`max_length` 默认 16,384）；问题从不截断，问题本身超过 `max_length` 时直接报错。官方模型页仍然只写「Long text state is truncated to fit the model's token limit」，上下文窗口 65,536；Workers AI 上实际用的 `max_state_tokens` 和 `max_length` 没有公开。所以有两件事要量：state 有没有一个约 2k 的上限；以及问题很长时（skill 第一段约 1.5 万 Clef token）留给 state 的位置会不会被挤小。后者如果成立，带画像的 skill 请求里 effort 问题读到的 state 也被截了，和 D2 有关。
- **探针**（`eval/probe-truncation.ts`）。9 个请求：一次热身；英文 state 约 1.2k、2.4k、4.8k、9.6k 估算 token，中文约 1.2k、2.4k、4.8k，`recent_context` 的开头、中间、末尾各藏一个事实，各用一个带「没有说」选项的 Choice 问；再加一个长问题（72 个目录条目，正确答案是最后一个，测问题是否被截断）配 1.2k 的 state。每个回答都记下后端计的 input token 和耗时，Jev 发同样的请求作对照。
- **运行。** 2026-10-05 第一次运行被权限分类器拦下；用户在仓库设置里放行之后运行，结果在 `eval/results/probes/2026-10-05-truncation.json`。Clef 共计 37,414 input token（约 830 neurons，约 0.009 美元），Jev 共计 43,586（约 0.002 美元），没有失败和重试。结果文件的 `design` 说长问题「about 15k tokens as Clef counts them」，实测只有约 1.19 万（整条 13,162 减去 1.2k 的 state），脚本里的说明已经改正，结果文件保持原样。

### 8.5 E1 的结果

| 探针 | Clef 计的 input token | Clef 开头 / 中间 / 末尾 | Clef 耗时 ms | Jev 计的 input token | Jev |
|---|---|---|---|---|---|
| 英文 1.2k | 1,620 | 对 / 对 / 对 | 875 | 1,726 | 全对 |
| 英文 2.4k | 2,599 | 对 / 对 / 对 | 1,135 | 2,717 | 全对 |
| 英文 4.8k | **2,650** | 对 / 对 / **没有说（0.974）** | 1,134 | 4,808 | 全对 |
| 英文 9.6k | 8,798 | 对 / 对 / 对 | 2,357 | 8,990 | 全对 |
| 中文 1.2k | 1,531 | 对 / 对 / 对 | 1,284 | 2,135 | 全对 |
| 中文 2.4k | 2,451 | 对 / 对 / 对 | 898 | 3,503 | 全对 |
| 中文 4.8k | 4,335 | 对 / 对 / 对 | 1,226 | 6,274 | 全对 |
| 英文 1.2k + 长问题 | 13,162 | 对 / 对 / 对；长问题选对最后一项（0.693） | 2,587 | 12,993 | 全对，长问题 1.0 |

（热身请求：Clef 2,123 ms、Jev 1,486 ms，都是新建连接；Jev 其余请求 356–532 ms。Clef 答「对」的概率都在 0.96 以上（长问题除外），Jev 都在 0.99 以上。）

- **Clef 会截断 state，但不是每次都截。** 英文 4.8k 那一次，Clef 只计了 2,650 个 token（同样的请求 Jev 计 4,808），末尾的事实答「没有说」，概率 0.974；开头和中间（约 2.3k 估算 token 处）的事实都答对了。所以那一次 state 只保留了开头约 2.1k 个 Clef token（2,650 减去问题、字段名和模板约 500–550；由这一组请求的计数推算），和第三方说的「约前 2K token」一致，而且计费的 token 也是截断之后的。可是更长的英文 9.6k（Clef 计 8,798）和中文 4.8k（4,335）都完整读到了末尾。三个超过约 2.1k 的 state 里截了一个：截断时有时无，可能取决于请求落到哪一组服务上。这一轮只有一个截断的样本，截断的比例和确切的上限要靠重复测（见 8.6）。
- **问题不截断。** 约 1.19 万 token 的问题，Clef 选对了它的最后一项（概率 0.693，比 Jev 的 1.0 低，但对了）；同一请求里 1.2k 的 state 也完整读到。问题很长时会不会挤掉 state（开源代码里的 `max_length`），这一次没有测出来：整条请求只有 13,162，低于 16,384。线上 skill 第一段约 1.5 万 Clef token，配上 1.5k 以上的 state 才会越过 16,384，要用更大的问题再测一次。
- **对 mod 的影响：**
  - **选 Clef 时 `contextTokens` 不能超过约 2000。** mod 估算的 token 比 Clef 计的多（按这一组请求的增量，英文约 1.1–1.15 倍、中文约 1.25 倍），所以 2000 估算 token 的 state 约是 1.6–1.8k Clef token，在约 2.1k 的上限之内，截断时也不丢东西。超过这个值，截断就可能发生；而 mod 的 state 把最近的对话按时间顺序放（`recent_context` 最新的一条在最后，midturn 的 `recent_steps` 最新的一步在最后），截掉的正好是最新、最要紧的那部分。第二阶段按后端取默认值时（D3），Clef 的 `contextTokens` 默认值不超过 2000，并考虑把 Clef 的上限也截在 2000（用户设得更大时按 2000 算，并在说明里写原因）；这比把顺序倒过来简单。E4b 里 Clef 本来只跑 1k、2k 两列，不变。
  - **AC 的延迟条件对 Clef 也宽松一些。** 这一轮 Clef 在 1.5–4.3k token 时 0.9–1.3 秒，8.8k 时 2.4 秒，13.2k（带 72 个选项的 Choice）时 2.6 秒，比 1.4 节按 skill 第一段推的「每 1k 多 250 ms」快；不过每个大小只有一个样本，延迟仍以 E4、E10 的成批运行为准。
  - **费用换算要分语言。** Clef 和 Jev 计的 token 之比：中文 state 约 0.69–0.72，英文 state 约 0.94–1.01；Jev 每个请求还多约 170 个固定的 token（热身请求 440 对 268）。1.5 节的 0.68 是从短请求和中文多的请求得来的，对英文为主的大请求偏低。受影响最大的是 E3、E10 里只留英文字段的画像：Clef 的 skill 全量按 1:1 算约 7.4 万 neurons（第 4 节按 0.68 算的是 4.8 万），E3 的 Clef 抽样和 E4b 也略多；完整方案的 Clef 总量改按约 15 万 neurons 算，用量约 1.7 美元。已开通 Workers Paid，不影响方案。

### 8.6 补测（2026-10-05，已确认并完成）

为了得到截断的比例和上限，以及长问题会不会挤掉 state，补测了 18 个 Clef 请求：热身 1 次，英文 4.8k 6 次，英文 3.2k、中文 4.8k、英文 9.6k 各 3 次，再把长问题加大到 96 个条目（约 1.54 万 Clef token）、配 2.4k 的 state，跑 2 次（整条约 1.8 万，越过 16,384）。Jev 第一轮全对，没有再发对照。脚本加了两个选项：`--only <名字[:次数],...>` 只发点名的探针、各发几次，`--repeat <n>` 是不写次数时的默认次数；重复的请求按轮发出（每个探针先发一次，再发第二轮），好让它们分散在整个运行里。英文 3.2k 和这个更大的长问题（`en-2400-bulk96`）只在点名时才发，默认的阶梯和第一轮逐字相同（改脚本后用 `--show` 逐个比对过）。命令：

```bash
node dispatch-pilot/eval/probe-truncation.ts --backend clef --only warmup,en-4800:6,en-3200:3,zh-4800:3,en-9600:3,en-2400-bulk96:2
```

结果在 `eval/results/probes/2026-10-05-truncation-2.json`：Clef 共计 104,705 input token（约 2,330 neurons，约 0.025 美元），没有失败和重试。

### 8.7 补测的结果和结论

| 探针 | 次数 | 截断的次数 | Clef 计的 input token | 开头 / 中间 / 末尾读到的次数 | 耗时 ms |
|---|---|---|---|---|---|
| 英文 4.8k | 6 | 1 | 4,666 ×5，2,650 ×1 | 6 / 6 / 5 | 991–1,882 |
| 英文 3.2k | 3 | 1 | 3,287 ×2，2,650 ×1 | 3 / 3 / 2 | 1,049–1,510 |
| 中文 4.8k | 3 | 0 | 4,335 ×3 | 3 / 3 / 3 | 1,232–1,795 |
| 英文 9.6k | 3 | 1 | 8,798 ×2，2,650 ×1 | 3 / 2 / 2 | 1,055–2,091 |
| 英文 2.4k + 96 条的长问题 | 2 | 0 | 17,991 ×2 | 2 / 2 / 2；长问题两次都选对最后一项（0.633） | 3,544–4,152 |

- **Clef 会截断 state，大约每四五个长请求截一次。** 两轮合起来，state 超过上限（约 2.1k Clef token）的请求有 18 个（英文 14 个、中文 4 个），截了 4 个，约 22%；英文 4/14，中文 0/4（样本小，看不出语言的差别）。只有 18 个样本，真实比例大致在 6%–48% 之间。
- **截断的位置是固定的：只留 state 的开头约 2.1k 个 Clef token。** 4 次截断里，不论 state 原来是 3.2k、4.8k 还是 9.6k，Clef 计的都正好是 2,650 个 token（这组探针的问题和模板约占 510），开头的事实每次都读到，超过这个位置的都答「没有说」（英文 9.6k 那一次连中间约 4k 处的事实也丢了）。计费也按截断后的 token 算。哪一次会截看不出规律，连续发同一个请求也是有时截、有时不截，像是取决于请求落到哪一组服务上。
- **问题不截断，长问题也不会把 state 挤短。** 96 个选项、约 1.54 万 token 的问题，Clef 两次都选对了最后一项；整条请求约 1.8 万 token，越过了开源代码默认的 16,384，同一请求里 2.4k 的 state 也完整读到。所以线上 skill 第一段（问题约 1.5 万 token）不会让同一请求里的 effort 问题少读 state，D2 不用为此担心。
- **AC「验证 Clef 是否截断 state」的结论：** 会截断，但时有时无（约五分之一的长请求），截断时只读 state 开头约 2.1k Clef token，问题从不截断。mod 把最重要的字段放在 state 最前（`user_message`、`brief`），已经尽量不吃亏；但最近的对话和步骤是按时间顺序排在最后的，截断先丢它们。所以选 Clef 时 `contextTokens` 的默认值和上限都定在 2000（约 1.6–1.8k Clef token，在截断位置之内），在第二阶段按后端取默认值（D3）时实现，并在 README 写明原因；E4b 里 Clef 只跑 1k、2k 两列。
- **延迟（补充 1.4 节）：** 没截断时，4.3–4.7k token 1.1–1.9 秒，8.8k 1.7–2.1 秒，1.8 万 3.5–4.2 秒；截断的请求 1.0–1.2 秒。

## 8.8 范围缩减（用户决定，2026-10-05）

用户的原话：「那我觉得我们没有必要再跑任何对比测试了 但是我们仍然要做clef接入 提供给有需要的人 我们自己就用jev即可」。所以 #17 不再跑任何评测，Jev 和 Clef 都不跑；长上下文补充集也取消了。仓库 `.claude/settings.local.json` 里为评测加的三条放行规则已按用户的要求删除。Clef 只保留接入，供需要的人用；用户自己用 Jev。

### 8.8.1 做了什么（都不花钱）

- **按决策模型取默认值（D3，按第 5 节的做法 (i)）。** `core/setup.ts` 的 `BACKEND_DEFAULTS` 是唯一一张表：`PER_BACKEND_OPTIONS` 里的 11 个选项（`timeoutMs`、`contextMessages`、`contextTokens`、`rejudgeSteps`、`thetaUp`、`thetaDown`、`thetaMax`、`thetaExpected`、`agentOverride`、`skillsMinRelevance`、`findSkillMinRelevance`）各有一个默认值，另有 `contextTokensMax` 和 `suggestSkills`。这 11 个选项在 manifest 里去掉了 `default`，说明文字写出各决策模型的默认值。`readConfig` 按 `decisionModel` 取表里的值；mod、`scripts/decide*.ts` 和评测（`eval/lib/suite.ts` 的 `optionsFor`）都经它取值。`scripts/decide*.ts` 的 `--timeout` 默认就是所选模型的 `timeoutMs`；`eval/run.ts` 的 `--timeout` 是评测每次尝试的耐心，默认是它的 4 倍、至少 10 秒（Jev 10 秒，Clef 12 秒）。
  - Clef：`timeoutMs` 3000；`contextTokens` 默认 2000，上限也是 2000（设得更大按 2000 算，原因是 8.7 节的截断结论）；发消息时的 skill 推荐（`skills` 开关）默认关闭，`/dp skills on` 打开，`find_skill` 保留。
  - Jev：默认值都和以前一样，只有 `skillsMinRelevance` 改成 0.75（下一条）。
  - 其余选项两个模型用同一个值（就是原来的默认值），说明和 README 里标为「Clef 未校准，暂沿用 Jev 的值」。`thetaNamed`、`thetaFit` 是代码里的常量，没有动。
  - **不写 `default` 的字段，引擎确实不传：** kit 里，`tests/backend-defaults.test.ts` 的「with Clef, a message waits 3000 ms」在 1500 ms 时仍在等、3000 ms 时超时，说明没有任何值顶替；生成的类型里 kit 的 `TestOptions` 写明「`register(on, options)` receives them as a load does: unlisted values unset, defaults filled in」；真实引擎里，2026-10-05 用 `command claude -p "/dp" --plugin-dir ./dispatch-pilot --strict-mcp-config --settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}' --debug-file <临时文件>` 跑了一次（没有配置密钥，没有发出任何 Jev 或 Clef 请求；debug log 里唯一的 `$.http.fetch` 是引擎自己的遥测；日志在临时目录，没有提交，这一行的写法由 `tests/backend-defaults.test.ts` 在会话开始时断言），debug log 写着 `settings for jev: left unset, so jev's defaults: timeoutMs 1500, contextMessages 4, contextTokens 2000, rejudgeSteps 4, thetaUp 0.4, thetaDown 0.6, thetaMax 0.5, thetaExpected 0.25, agentOverride 0.6, skillsMinRelevance 0.75, findSkillMinRelevance 0.5; skill suggestions on until /dp skills off`。
  - 接缝 1 的测试（`tests/backend-defaults.test.ts`）覆盖：两个模型各自的默认值（超时、上下文预算、skill 推荐的开关、`skillsMinRelevance`）；Clef 的 `contextTokens` 上限；你设了值时两个模型都用你的值；会话开始时 debug log 写的那一行；`readConfig` 和评测的 `optionsFor` 取的是同一张表。
- **`skillsMinRelevance` 默认改成 0.75。** 依据是 E0c 的离线重算（#16 两次 Jev 运行已存的 `breakdown.sweeps`）：带画像时，0.7 下中英差距两次都是 −3.67；0.75 下是 −1.84 和 −2.76，平均 −2.3。这是第 1 轮审查修复之前的问法上的预览，修复后没有重跑。
- **离线重判中英差距（按新规则：中文比英文低不到 3 个百分点才算通过）。** 只读已存结果的 `summary` 和 `breakdown.sweeps`，没有发请求，也没有写新工具：
  - effort-submit（Jev 3 次）：`en-score` 0、+2、0，通过；`zh-score` 0、0、−1，通过；`zh-choice` −1、−2、−1，通过；`en-choice` 三次都是 −3.0，按新规则不通过（它不是发布配置）。Clef `en-score` 0，通过。
  - effort-midturn（Jev 2 次，5 个变体）：−2 到 +3，都通过；Clef `en-score` −2，通过。
  - subagent（Jev 3 次，4 个变体）：0 到 +6（中文都不低于英文），都通过。
  - skill（Jev 2 次）：`profiles` 在 0.7 下 −3.67，两次都不通过（新旧规则都不通过）；在新的默认值 0.75 下 −1.84、−2.76，通过。`descriptions` 在 0.7 下 −1.84、−0.92，0.75 下 −1.84、−2.75，都通过。
- **文档。** README 的配置表和「按决策模型取的默认值」、「待评测」开头的各验收项状态、「评测」一节开头的说明（那些数字都是修复之前的问法测得的，修复后没有重跑），以及本节。（#18 把「待评测」「评测」和「配置」的完整说明放进了 DEVELOPMENT.md，README 只留概要和配置表。）

### 8.8.2 每条验收项的状态

- **AC1 上下文范围扫描：没有做。** 原因见 1.1 节：现有评测集的上下文太短，16 格里请求几乎都一样；长上下文补充集也按用户的决定没有做。默认值保持 Jev 4 条 × 2000 token；Clef 按截断的结论定为 2000，并且最多 2000。
- **AC2 Jev 和 Clef 各一套默认值、写回 mod 的配置：已做**（8.8.1 第一条）。
- **AC3 置信度门槛按语言分别校准：没有做。**
- **AC4 问题用英文还是中文写：保持英文**，`DEFAULT_ASK` 不改。线索：修复之前的问法上，effort-submit 的 `zh-score` 比 `en-score` 高约 8 个百分点（3 次运行都是）。
- **AC5 验证 Clef 是否截断 state：已做**（8.4–8.7 节）。会截断，但时有时无：超过约 2.1k token 的 18 个 state 截了 4 个，截断时只留开头约 2.1k 个 Clef token；问题不截断。
- **AC6 中文准确率比英文低不超过 3 个百分点：** 按离线数据（修复之前的问法），发布配置的中英差距都小于 3 个百分点（skill 带画像时靠 `skillsMinRelevance` 0.75）；`en-choice` 的 −3.0 不通过，但它不是发布配置，记在这里。这一条没有在新问法上验证。
- **AC7 需要真实密钥、会产生少量费用：已做。** 只有截断探针花了钱，两轮合计约 0.036 美元（Clef 约 14.2 万 token，约 0.034 美元；Jev 约 4.4 万 token，约 0.002 美元）。

### 8.8.3 没做的实验

E2–E4、E6–E10 的运行都没有做；长上下文补充集没有做；E7 的档位描述改动（审核规则 R4，「写测试」整体放在 high）没有做；E3 的画像裁剪（只留英文字段）没有评测，也没有改。E9 的「两类 skill 分开问」已经在第 1 轮审查的修复里实现（`skills.which` 和 `skills.hint` 两题），但没有重跑。E5（Workflow 一个请求放几个 agent）同样没有跑：`subagent` 评测已经有 `models-hint-single` 变体可以对照。

没有新开 GitHub issue；要不要为这些开后续票，由编排者去问用户。
