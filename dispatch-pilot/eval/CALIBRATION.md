# dispatch-pilot 校准记录

这份记录写 dispatch-pilot 1.0.0 的校准（设计第 8 节；计划 `docs/superpowers/plans/2026-11-19-dispatch-pilot-calibration.md`，以计划末尾的「修订」为准）。官方要求见同目录的 `STANDARD.md`，下文的 S1、S2……是它的编号。

读这份记录之前要知道的几件事：

- **下面所有的分数都是调整集上的分数。** 调整集是每类 10 例（`fit` 6 例、`check` 4 例），措辞、问法、上下文和门槛的取舍都在这些用例上做，所以这些数字不是公平的测试（S18、S20）。留出集（每类 5 例）到 Task 14 才发一次，这份记录里没有它的任何数字。
- 只校准 Drex `drex-max-v1.1`。Jev 没有参加。
- 判分用每个请求的第 1 遍回答；第 2、3 遍只用来看稳定性（修订 A5）。门槛一律是起步值（`START`：升档 0.7，升到 xhigh 和 max 0.8，降档 0.7，`noul` 读作「是」0.7、读作「否」0.3，换模型 0.8；skill 的 action 0.30、named 0.50、fits 0.30）。扫门槛是 Task 13 的事，不在这几节里。
- 每个数字都能重算：在仓库根目录运行表格旁边写的命令。命令只读私有数据目录里存下的回答（`run.ts` 的 `--data`，默认值见 `run.ts` 开头），不发请求。私有数据目录不在仓库里，没有它就重算不了。
- 仓库是公开的。取自真实会话的用例只写编号和结果，不写原文；真实 skill 用例的期望和回答也不写 skill 的名字，只写对没对。
- 标记的意思：`right` 对；`under` 档位低了；`over` 档位高了；`missed-shift` 该换挡没换；`wrong-model` 档位对、模型不在可接受的范围里；`wrong-skill` 推荐了另一个 skill。

## 基线（Task 9）

### 请求

- 日期：2026-11-19（UTC 05:32–05:33；本机时间 PST 是 2026-11-18 晚上）。
- 回答报告的模型：236 个回答全部是 `drex-max-v1.1`。
- 请求数：236 个，失败 0 个，回答的 `model` 不对的 0 个。其中 1 个是发调整集之前的合成小请求（`smoke`，用一例模型写的用例，修订 A4），它的回答不计分；其余 235 个：默认给法每例 3 遍（四类各 10 例，共 120 个，另加 skill 第二次请求 30 个），其余登记的给法各 1 遍（85 个；和默认给法发出的请求完全相同的，按 `hash` 共用一个回答，不另发）。
- 耗时：235 个请求用了约 35 秒（最多同时 4 个），单个请求中位数 526 ms，最长 1249 ms。
- token：823,895，这是 runner 发请求之前的估算，不是 Drex 回报的用量。

### 每类的对错

命令：`node dispatch-pilot/eval/run.ts score --set tune`（分组看用 `--set fit`、`--set check`）。调整集上的分数，取舍都在这些用例上做。

| 类别 | 调整集 10 例里对的 | `fit` 6 例 | `check` 4 例 | 错的按标记 |
| --- | --- | --- | --- | --- |
| submit（发消息定档） | 9 | 6 | 3 | under 1（submit-12） |
| midrun（中途换挡） | 10 | 6 | 4 | — |
| agent（agent 定档和模型） | 7 | 3 | 4 | under 3（agent-01、agent-02、agent-09） |
| skill（skill 推荐，第一次请求和第二次请求合读） | 9 | 5 | 4 | wrong-skill 1（skill-09） |

### 逐例

命令同上。调整集上的分数。agent 的「期望」写成「可接受的档位 · 可接受的模型」；midrun 的写成「该不该换挡 可接受的档位」。

| 编号 | 组 | 来源 | 期望 | 得到 | 标记 |
| --- | --- | --- | --- | --- | --- |
| submit-01 | fit | 真实 | low | low | right |
| submit-02 | fit | 真实 | high/xhigh | high | right |
| submit-03 | fit | 补写 | xhigh | xhigh | right |
| submit-04 | check | 补写 | high | high | right |
| submit-05 | check | 补写 | low | low | right |
| submit-09 | fit | 真实 | xhigh | xhigh | right |
| submit-10 | fit | 真实 | low | low | right |
| submit-11 | fit | 补写 | medium | medium | right |
| submit-12 | check | 补写 | max | high | under |
| submit-13 | check | 补写 | low | low | right |
| midrun-01 | fit | 真实 | hold low | low | right |
| midrun-02 | fit | 补写 | up high | high | right |
| midrun-03 | fit | 补写 | down low/medium | low | right |
| midrun-04 | check | 补写 | up high/xhigh | high | right |
| midrun-05 | check | 补写 | hold high | high | right |
| midrun-09 | fit | 真实 | hold medium | medium | right |
| midrun-10 | fit | 补写 | up xhigh | xhigh | right |
| midrun-11 | check | 补写 | down low/medium | low | right |
| midrun-12 | check | 真实 | hold low | low | right |
| midrun-13 | fit | 补写 | hold high | high | right |
| agent-01 | fit | 真实 | medium · sonnet/opus | low · sonnet | under |
| agent-02 | fit | 真实 | high · opus/fable | low · sonnet | under |
| agent-03 | fit | 补写 | medium · sonnet | medium · sonnet | right |
| agent-04 | check | 真实 | low · haiku | low · haiku | right |
| agent-05 | check | 补写 | high · sonnet | high · sonnet | right |
| agent-09 | fit | 真实 | high · opus/fable | medium · opus | under |
| agent-10 | fit | 真实 | medium · sonnet/opus | medium · sonnet | right |
| agent-11 | fit | 补写 | xhigh · opus | xhigh · opus | right |
| agent-12 | check | 补写 | xhigh · opus | xhigh · opus | right |
| agent-13 | check | 补写 | high · opus | high · opus | right |
| skill-01 | fit | 真实 | （一个 skill） | 同期望 | right |
| skill-02 | fit | 真实 | 无 | 无 | right |
| skill-03 | fit | 补写 | gsap-timeline | gsap-timeline | right |
| skill-04 | check | 补写 | speech-to-text | speech-to-text | right |
| skill-05 | check | 补写 | 无 | 无 | right |
| skill-09 | fit | 真实 | （一个 skill） | 另一个 skill | wrong-skill |
| skill-10 | fit | 真实 | 无 | 无 | right |
| skill-11 | fit | 补写 | superpowers:receiving-code-review | superpowers:receiving-code-review | right |
| skill-12 | check | 补写 | diagnosing-bugs/superpowers:systematic-debugging | diagnosing-bugs | right |
| skill-13 | check | 补写 | 无 | 无 | right |

### 决定不稳定的用例

命令：`node dispatch-pilot/eval/run.ts stability --set tune`（起步门槛下）。

- 调整集 40 例都问了 3 遍。第 2、3 遍的 state 末尾多一个一次性的 `request_uid`（修订 A5）。
- 3 遍决定不一样的有 2 例：
  - submit-02（fit）：high、xhigh、high。两种都在可接受的范围里。
  - midrun-11（check）：low、medium、medium。两种都在可接受的范围里。
- 按 R-稳定，submit-02 不参与扫门槛（`sweep` 会把它列为 left out）。midrun-11 在 `check`，扫门槛本来就不用它。
- 另有 3 例有一遍读不出决定：skill-03（第 2、3 遍）、skill-12（第 3 遍）、skill-13（第 3 遍）。原因是 runner 的第二次请求按第 1 遍的候选短名单发出，3 遍共用；这几遍的第一次请求排出的前三名里有一个和第 1 遍不同（第一名没变），第二次请求就答不了那一遍的短名单，按规则算没有回答。能读出来的几遍，这 3 例的决定都一样。所以这 3 例的稳定性只看了一部分。

### 回答不对的用例，逐个查（Task 9 Step 4）

照设计第 8 节和 S30 的顺序查：实际发出的请求、state、选项、题的范围、措辞。只记录，不改任何措辞和门槛。下面的概率是第 1 遍的，括号里是 3 遍的范围。`open` 的五个概率依次对应第 0 到第 4 档（low 到 max）。

**submit-12（check，补写；期望 max，得到 high）**

1. 发出的请求：state 是 `note` 和 `request` 两个字段（这一例没有上一轮，所以没有 `previous_turn`），题是 mod 的 `open`、`mechanical`、`unknown_cause`，加两道对照题 `direct`、`long_unattended`。和 `build` 给出的请求一致。顺带记下：`note` 是固定的一句，提到了 `previous_turn`，这一例里没有这个字段。
2. state：参考答案的依据都在 `request` 里（在线改主键类型、没有停写的窗口、从库延迟有上限），只看 state 能答出来。
3. 选项：第 4 档就是参考答案，在选项里。
4. 题的范围：`open` 只量一个维度。第 4 档的说明是两个条件的组合，但模型选中了它，范围没有挡住。
5. 措辞：没有读错的迹象。概率最高的就是第 4 档：`open` = [0.045, 0.008, 0.175, 0.059, 0.712]，`mechanical` 0.037，`unknown_cause` 0.009，对照题 `direct` 给 max 0.857。

查到第 5 步。差在门槛：从起点 medium 逐档往上，高于 medium 的概率和 0.946，过了 0.7，升到 high；高于 high 的概率和 0.771（0.744–0.771），没到升到 xhigh 要的 0.8；max 一档是 0.712，也没到 0.8。这是门槛的事，留给 Task 13；submit-12 在 `check`，扫门槛只用 `fit`，它只能用来核对。

**agent-01（fit，真实；期望 medium · sonnet/opus，得到 low · sonnet）**

1. 发出的请求：state 是 `note`、`task`、`agent_type`、`description`，`task` 全文没有被截断；题是 `open`、`mechanical`、`unknown_cause`、`read_only` 加两道对照题。继承的是 xhigh 和 fable（默认配置下上限 opus）。
2. state：这是一个只读的复审派发；`task` 写明了要核对什么和输出格式，引到的文件不在 state 里，但参考答案的依据都在 `task` 里（审查时按修订 A6 的 human test 过了）。参考答案本身是接近的：出题者收 low 或 medium，盲答者收 medium，裁定取 medium。
3. 选项：medium（第 1 档）在选项里；可接受的模型 sonnet 和 opus 都在候选里。
4. 题的范围：`open` 只量一个维度，没有发现需要拆的地方。
5. 措辞：概率大多在第 0 档「做法已经给定，照着做」：`open` = [0.775, 0.191, 0.014, 0.016, 0.004]，`mechanical` 0.739（0.721–0.739，读作「是」），`read_only` 0.73。模型把 `task` 写明的审查步骤读成了「做法已经给定」。

查到第 5 步，两样都有：从 xhigh 逐档往下，低于 medium 的概率和是 0.775（0.746–0.775），刚过降档门槛 0.7，所以一路降到 low；降档门槛在 0.80 及以上时 3 遍都会停在 medium。模型 sonnet 是因为第 0、1 档的概率和 0.966 过了换模型的 0.8，往下换了一档，在可接受的范围里。

**agent-02（fit，真实；期望 high · opus/fable，得到 low · sonnet）**

1. 发出的请求：结构同 agent-01，`task` 全文没有被截断。继承的是 low 和 fable。
2. state：一个只读的审查派发；`task` 写明了审查的步骤和输出格式，哪里有问题、算哪一级没有给。参考答案是接近的：出题者收 medium 或 high，盲答者收 high，裁定两边各取一部分（档位 high，模型写 opus/fable）。依据在 `task` 里。
3. 选项：high（第 2 档）在选项里；opus 在候选里。
4. 题的范围：同上。
5. 措辞：`open` = [0.584, 0.325, 0.067, 0.019, 0.005]，参考答案那一档只有 0.067；`mechanical` 0.683（0.683–0.721，第 2、3 遍读作「是」，会把档位封在 medium），`read_only` 0.802。

查到第 5 步，是读法，不是门槛：要从 low 升到 high，高于 medium 的概率和（0.091–0.125）得过升档门槛，门槛的网格是 0.50 到 0.95，取哪一个都不行。模型也错了：第 0、1 档的概率和 0.909 过了 0.8，往下换到 sonnet，而参考答案不许往下换。错的模型和错的档位出自同一个读法。

**agent-09（fit，真实；期望 high · opus/fable，得到 medium · opus）**

1. 发出的请求：结构同上，`task` 很短，引到的文档不在 state 里。继承的是 medium 和 fable。
2. state：一个只读的评判派发（标签 design-critique）。参考答案的依据是 `task` 写明的工作种类（修订 A6）。出题者和盲答者都答 high，盲答者把握接近并提了疑问，裁定维持。
3. 选项：high 在选项里；opus 在候选里。
4. 题的范围：同上。
5. 措辞：`open` = [0.272, 0.49, 0.207, 0.024, 0.007]，最多的是第 1 档「小范围里少数几种可能」，参考答案那一档 0.207；`mechanical` 0.556（0.556–0.589，落在中间带），`read_only` 0.893。

查到第 5 步，是读法：从 medium 往上，高于 medium 的概率和 0.238（0.217–0.267），网格里没有哪个升档门槛能让它升。模型 opus 是对的（第 0、1 档的概率和 0.762，没到 0.8，不往下换）。

三个错的 agent 用例都在 `fit`，都是只读的审查或评判工作，档位都低了。`check` 里的 agent 用例 4 例全对。

**skill-09（fit，真实；期望一个 skill，得到另一个）**

1. 发出的请求：第一次请求的 state 是 `request` 和 `previous_turn`（上一轮是同一句话，没有回复）；题是一道 choice（169 个候选 skill，其中 89 个在列表里没有说明）和四道 gate 的 `noul`。第二次请求对前三名问一道 choice 和三道 `fits_` 题。和 `build` 给出的一致。
2. state：一条查资料类的请求，只看 state 能答。参考答案是接近的：出题者和盲答者都选了同一个 skill，盲答者提了疑问，裁定维持。
3. 选项：参考答案在第一次请求的候选里，也进了第二次请求的短名单，但余地不大：第一次请求的 choice 很平，最大的概率只有 0.121（「other」也是 0.121），参考答案 0.116，排第二，和第三名相同，第四名是 0.084。打乱候选顺序的那一遍（`stage-1-shuffled`）里，参考答案掉出了前三名（0.066），那一遍的第二次请求里根本没有正确的选项。
4. 题的范围：gate 的读法对了（三道动手题的均值 0.526，过了 0.30，该推荐 skill）；第二次请求的 choice 只问一件事。
5. 措辞：第二次请求的 choice 给错的那个 0.474（0.437–0.492），参考答案 0.346（0.327–0.382）；`fits_` 两个都读成合适：参考答案 0.556（0.523–0.643），错的那个 0.632（0.611–0.683）。错的那个 skill 的说明自带一长串触发条件，覆盖到问大模型设置的请求。

查到第 5 步。我们的题（照抄 TypeSafe skill_suggestion cookbook）没有读错的迹象：模型照题目的要求读了候选的说明，偏差来自两个候选的说明重叠，而候选的说明不是 mod 写的。门槛救不了它：`fits` 的门槛调高只会变成不推荐，仍然不对。

## 问法（Task 10 Step 1–2）

默认的问法是「问工作本身，代码查表」；对照一是 `direct`（一道 choice 直接选档位，选项的说明就是五档的说明），对照二是 `long_unattended`（候选的加题：读作「是」时档位至少 high）。两道对照题和默认题在同一个请求里问（S22），所以下表三列读的是同一批回答。`direct` 打乱选项是另一个请求（`direct-shuffled`，每例 1 遍）。midrun 不问 `long_unattended`。skill 不参加这一节。

命令：默认 `score --set tune`；direct `score --set tune --form direct`；long-unattended `score --set tune --long-unattended`；direct 打乱选项 `score --set tune --variant direct-shuffled --form direct`（命令都是 `node dispatch-pilot/eval/run.ts` 加这些参数）。调整集上的分数，取舍都在这些用例上做。

### submit

| 编号 | 组 | 期望 | 默认 | direct | direct 打乱选项 | long-unattended |
| --- | --- | --- | --- | --- | --- | --- |
| submit-01 | fit | low | low right | low right | low right | low right |
| submit-02 | fit | high/xhigh | high right | low under | low under | high right |
| submit-03 | fit | xhigh | xhigh right | xhigh right | xhigh right | xhigh right |
| submit-04 | check | high | high right | high right | high right | high right |
| submit-05 | check | low | low right | low right | low right | high over |
| submit-09 | fit | xhigh | xhigh right | low under | max over | xhigh right |
| submit-10 | fit | low | low right | low right | low right | low right |
| submit-11 | fit | medium | medium right | low under | low under | medium right |
| submit-12 | check | max | high under | max right | max right | high under |
| submit-13 | check | low | low right | low right | low right | high over |

### midrun

| 编号 | 组 | 期望 | 默认 | direct | direct 打乱选项 | long-unattended |
| --- | --- | --- | --- | --- | --- | --- |
| midrun-01 | fit | hold low | low right | low right | low right | （不问） |
| midrun-02 | fit | up high | high right | medium missed-shift | medium missed-shift | （不问） |
| midrun-03 | fit | down low/medium | low right | low right | low right | （不问） |
| midrun-04 | check | up high/xhigh | high right | medium missed-shift | medium missed-shift | （不问） |
| midrun-05 | check | hold high | high right | high right | high right | （不问） |
| midrun-09 | fit | hold medium | medium right | medium right | medium right | （不问） |
| midrun-10 | fit | up xhigh | xhigh right | xhigh right | xhigh right | （不问） |
| midrun-11 | check | down low/medium | low right | low right | low right | （不问） |
| midrun-12 | check | hold low | low right | low right | low right | （不问） |
| midrun-13 | fit | hold high | high right | high right | high right | （不问） |

### agent

| 编号 | 组 | 期望 | 默认 | direct | direct 打乱选项 | long-unattended |
| --- | --- | --- | --- | --- | --- | --- |
| agent-01 | fit | medium · sonnet/opus | low · sonnet under | low · sonnet under | low · opus under | low · sonnet under |
| agent-02 | fit | high · opus/fable | low · sonnet under | low · sonnet under | low · opus under | low · sonnet under |
| agent-03 | fit | medium · sonnet | medium · sonnet right | medium · sonnet right | medium · opus wrong-model | medium · sonnet right |
| agent-04 | check | low · haiku | low · haiku right | low · haiku right | low · haiku right | low · haiku right |
| agent-05 | check | high · sonnet | high · sonnet right | high · sonnet right | high · sonnet right | high · sonnet right |
| agent-09 | fit | high · opus/fable | medium · opus under | low · opus under | low · opus under | medium · opus under |
| agent-10 | fit | medium · sonnet/opus | medium · sonnet right | low · sonnet under | low · opus under | medium · sonnet right |
| agent-11 | fit | xhigh · opus | xhigh · opus right | xhigh · opus right | xhigh · opus right | xhigh · opus right |
| agent-12 | check | xhigh · opus | xhigh · opus right | xhigh · opus right | xhigh · opus right | xhigh · opus right |
| agent-13 | check | high · opus | high · opus right | high · opus right | high · opus right | high · opus right |

### 合计

| 类别 | 默认（fit / check / 调整集） | direct | long-unattended | direct 打乱选项 |
| --- | --- | --- | --- | --- |
| submit | 6 / 3 / 9 | 3 / 4 / 7 | 6 / 1 / 7 | 3 / 4 / 7 |
| midrun | 6 / 4 / 10 | 5 / 3 / 8 | （不问） | 5 / 3 / 8 |
| agent | 3 / 4 / 7 | 2 / 4 / 6 | 3 / 4 / 7 | 1 / 4 / 5 |

### 判定（修订 A1：只看调整集）

- **R-问法：不换。** 换成 `direct` 要在调整集 10 例上比默认多对至少 2 例，并且 `check` 4 例上不比默认差。三类都没有多对，反而少对：submit 7 比 9，midrun 8 比 10，agent 6 比 7。`check` 上 submit 的 `direct` 多对 1 例（submit-12，它直接选了 max），midrun 少对 1 例，agent 持平；第一个条件已经不满足，不用再看第二个。
- **R-加题：不加。** `long_unattended` 规则在 submit 上 7 比 9：它把 `check` 里的 submit-05、submit-13（都是不用人看着的机械批量）抬到 high，判成 over；`fit` 上没有变化。agent 上 7 比 7，没有哪一例的决定变了。出题审查时已经记下：`check` 里有不用人看着的机械批量，这条规则不管模型怎么答都过不了 R-加题。
- **打乱 `direct` 的选项（修订 A13）。** 这项复查只在 `direct` 胜出时才是条件；它没有胜出，所以只报数。按 `direct` 读，打乱前后决定不变的：submit 9 例（submit-09 从 low 变成 max）、midrun 10 例；agent 的档位 10 例都没变，但 agent-01、agent-02、agent-03、agent-10 的模型从 sonnet 变成了 opus，按「档位 · 模型」算不变的是 6 例。

### 另记：同一请求里别的题动了

打乱的只是 `direct` 这一道题的选项顺序，其余的题和 state 一字不差，可 `open` 等题的回答也跟着动了。按默认问法读 `direct-shuffled` 的回答（命令：`node dispatch-pilot/eval/run.ts score --set tune --variant direct-shuffled`），30 例里有 6 例的决定和默认请求的不同：

| 编号 | 默认的请求 | 只打乱 direct 选项的请求 |
| --- | --- | --- |
| agent-01 | low · sonnet under | medium · opus right |
| agent-02 | low · sonnet under | low · opus under |
| agent-03 | medium · sonnet right | medium · opus wrong-model |
| agent-10 | medium · sonnet right | medium · opus right |
| midrun-11 | low right | medium right |
| submit-02 | high right | xhigh right |

例如 agent-01 的 `open` 在第 0 档的概率从 0.775 变成 0.654，同一请求重复问 3 遍的范围只是 0.746–0.775。S23 说同一请求里的题读不到彼此的回答，这里的数说明：同一请求里别的题的写法会移动回答，移动的幅度比重复问的大。它不改上面任何判定（判定比的都是同一批回答，或者差得远），但有两处要知道：默认给法的请求带着两道对照题，mod 实际发的请求没有（Ruling C18a，为了让各给法只差在 state）；修订 A8 要把新旧措辞放进同一请求比，加进去的新题本身也可能移动旧题的回答。

### skill 题陪着问（with-skills）

mod 发消息时，在定档的题旁边还会问第一次请求的 skill 题；默认给法没有带。跑之前定下的规则（Ruling C18b）：带上 skill 题之后，调整集 10 例里定档的决定和默认不同的有 2 例及以上，就说陪着的题会移动回答，submit 的门槛改用 with-skills 的回答来扫；否则保持默认。

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant with-skills`。调整集上的分数，取舍都在这些用例上做。

| 编号 | 组 | 期望 | 默认 | with-skills | 决定变了吗 |
| --- | --- | --- | --- | --- | --- |
| submit-01 | fit | low | low right | low right | 否 |
| submit-02 | fit | high/xhigh | high right | high right | 否 |
| submit-03 | fit | xhigh | xhigh right | xhigh right | 否 |
| submit-04 | check | high | high right | high right | 否 |
| submit-05 | check | low | low right | low right | 否 |
| submit-09 | fit | xhigh | xhigh right | xhigh right | 否 |
| submit-10 | fit | low | low right | low right | 否 |
| submit-11 | fit | medium | medium right | medium right | 否 |
| submit-12 | check | max | high under | xhigh under | 是 |
| submit-13 | check | low | low right | low right | 否 |

不同的只有 1 例（submit-12，从 high 变成 xhigh，两个都低了）。**判定：保持默认**，submit 的门槛照常用默认给法的回答扫。

### skill 打乱候选顺序

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant stage-1-shuffled`（第二次请求也是打乱的那一遍）。调整集上 9 例对，和默认相同；10 例的决定都没变（修订 A9）。skill-09 仍然错，只是打乱后正确的 skill 连短名单都没进（见上文）。

## 上下文（Task 11 Step 2）

同一批调整集用例，只改 state 的一个字段。改了之后请求和默认完全相同的用例（例如没有上一轮的用例去掉 `previous_turn`），不另发，表里写「同一请求」，它的结果就是默认的结果。调整集上的分数，取舍都在这些用例上做。

### 发消息时带不带上一轮（`previous_turn`）

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant no-previous`。去掉上一轮时，只在有上一轮时才问的 `continues` 也不问了。

| 编号 | 组 | 期望 | 带 `previous_turn`（默认） | 不带（no-previous） |
| --- | --- | --- | --- | --- |
| submit-01 | fit | low | low right | 同一请求（没有上一轮） |
| submit-02 | fit | high/xhigh | high right | medium under |
| submit-03 | fit | xhigh | xhigh right | 同一请求（没有上一轮） |
| submit-04 | check | high | high right | high right |
| submit-05 | check | low | low right | low right |
| submit-09 | fit | xhigh | xhigh right | low under |
| submit-10 | fit | low | low right | low right |
| submit-11 | fit | medium | medium right | 同一请求（没有上一轮） |
| submit-12 | check | max | high under | 同一请求（没有上一轮） |
| submit-13 | check | low | low right | 同一请求（没有上一轮） |

真正不同的请求有 5 例（submit-02、04、05、09、10）。不带上一轮时 submit-02、submit-09 档位低了：这两例是「接着做」，档位要从上一轮接下来。

**R-删字段（`previous_turn`）：留。** 调整集上带着它 9 例对，不带 7 例对，带着它多对 2 例。

### 中途的 `recent` 取几条、带不带 `stated_next`

命令：`node dispatch-pilot/eval/run.ts score --set tune`（5 条，默认）、`--variant recent-3`、`--variant recent-1`、`--variant no-stated-next`。

| 编号 | 组 | 期望 | `recent` 5 条（默认） | 3 条 | 1 条 | 不带 `stated_next` |
| --- | --- | --- | --- | --- | --- | --- |
| midrun-01 | fit | hold low | low right | 同一请求 | 同一请求 | 同一请求 |
| midrun-02 | fit | up high | high right | high right | high right | high right |
| midrun-03 | fit | down low/medium | low right | low right | low right | low right |
| midrun-04 | check | up high/xhigh | high right | high right | high right | high right |
| midrun-05 | check | hold high | high right | high right | high right | high right |
| midrun-09 | fit | hold medium | medium right | 同一请求 | 同一请求 | 同一请求 |
| midrun-10 | fit | up xhigh | xhigh right | 同一请求 | xhigh right | xhigh right |
| midrun-11 | check | down low/medium | low right | medium right | medium right | medium right |
| midrun-12 | check | hold low | low right | 同一请求 | 同一请求 | 同一请求 |
| midrun-13 | fit | hold high | high right | high right | high right | high right |

- `recent` 只有 1 条的 midrun-01、09、12，三种条数的请求都相同；只有 3 条的 midrun-10，取 3 条和默认相同。真正不同的请求：3 条 6 例，1 条 7 例。没有 `stated_next` 的 midrun-01、09、12，去掉它请求不变；真正不同的 7 例。
- 唯一变了决定的是 midrun-11（low 变成 medium，两个都可接受）；它正是 3 遍决定不一样的那一例。

**R-recent：保持 5 条。** 1、3、5 条在调整集上都是 10 例全对。按修订 A1 并列时取最少的条数，但修订 A13 要求别的条数比默认的 5 条多对至少 2 例才换，所以保持 5 条。

**R-删字段（`stated_next`）：删。** 带着它 10 例对，不带也是 10 例对，带着它没有多对任何一例，按规则删。删字段的代码改动由 Task 11 另做（先写失败的测试，修订 A1）。

**两边都在顶上，比较看不出好处。** `recent` 的三种条数和 `stated_next` 的两种给法在调整集上都是 10 例全对，已经没有可以多对的用例，所以这两项比较本来就不可能显出更多上下文的好处；「不多对」在这里只说明调整集分不出来，不说明这些字段没有用。`previous_turn` 不是这种情况（7 比 9）。

## 用例是怎么来的

数量和分组：

- 每类 15 例，四类 60 例：`fit` 6、`check` 4、留出 5。每类 15 例是用户定的，处在 Nace 说的「tens」的下沿（S20）；每类用来取门槛的只有 `fit` 的 6 例（S48）。这两点不改，照实写在这里（修订 A11）。
- 真实用例 30 例、补写 30 例：submit 9/6、midrun 8/7、agent 5/10、skill 8/7（真实/补写）。按组分：

| 类别 | `fit`（真实/补写） | `check` | 留出 |
| --- | --- | --- | --- |
| submit | 4/2 | 0/4 | 5/0 |
| midrun | 2/4 | 1/3 | 5/0 |
| agent | 4/2 | 1/3 | 0/5 |
| skill | 4/2 | 0/4 | 4/1 |

- submit 和 skill 的 `check` 没有真实用例，agent 的留出集没有真实用例。分组按会话定，在写任何用例之前就定下了：一个会话的用例全部在同一组（修订 A2、A13）；分到 `check` 的会话没有可用的材料（太短或像探针），之后又不能挪会话，`check` 就用补写的填。所以 submit 和 skill 的 `check` 只是在补写的用例上确认，补写的比真实请求容易（S4）。agent 的真实材料全部来自一个会话，它分在 `fit`。

真实用例从哪里来、去掉了什么：

- 只取自本仓库自己的 Claude Code 会话记录（仓库和它的 worktree 两个项目目录），在用户同意之前没有发给 Nace 任何东西。挖出 82 个会话文件里的条目（submit 135、midrun 680、agent 75）；含有像密钥的字符串或用户路径的条目丢掉了 280 个（完整的 git SHA 也算），提交多的步骤因此少了一些。mod 自己的 52 个脚本化探针会话不用，剩下 17 个真实会话，其中两个很长。
- 合并进用例时机械地替换过（只动真实用例，别的字一个不改）：旧版 dispatch-pilot 自动追加在请求末尾的一个词（用户没有打过）从 3 条请求里删掉；仓库文件夹名（43 处）、mod 的名字（12 例里 84 处）换成占位词；3 个会话 UUID 换成全 0。之后又按用户名、git 用户、邮箱和路径的各种写法逐字扫过所有用例的输入，没有找到。出题时还发现清理漏掉一种被截断的、用短横线编码的路径，用到它的条目没有用。
- 一例真实请求里有一个多出来的字母，会话记录本身就是这样，保留原样。

用例和参考答案怎么定的：

- 出题、审查、盲答、裁定都由同一个模型（Fable 5.2，xhigh）做：出题者写参考答案，盲答者只看发出去的内容再答一遍，不一致的交给裁定。60 例里两遍直接一致 48 例，一致但盲答者提了疑问 2 例，重叠（一边一档、一边两档，或一边的模型范围更宽）10 例，相反 0 例；裁定 8 例取盲答者、3 例取出题者、1 例两边各取一部分；最后改了 9 例的参考答案。这是同一个模型答两遍加裁定，不是几家不同模型的合标（S12、S13，修订 A11）。用户在发请求之前看过全部 60 例，没有改参考答案，60 例都标为模型标的。
- 出题和审查多一项 human test：只看发出去的 state 和题能不能答出参考答案，依据必须在 state 里（修订 A6）。
- 派出 agent 的用例：默认配置下 Fable 不当子 agent，继承 fable 的用例「不换便宜的模型」写成 opus（mod 给不出 fable）。
- 中途的真实检查点全部来自 Code Mode 会话，其中只有 6 个的最新一步失败；非 Code Mode 的和大多数「卡住」的用例是补写的。原先整个 midrun 里没有 Code Mode 下该升档的用例，于是把 midrun-10（`fit`，补写）改写成 Code Mode 的。「修过之后还是同一个错误」明确为是的只有 midrun-04（`check`）一例。
- skill：原来没有哪个正例只靠「点名」那道题就能过，`named` 的门槛没有用例卡得住，于是加了一例用户随口点出可用 skill 名字的补写用例（skill-11，`fit`）。三种反例（日常请求、没有 skill 管的技术问题、点名了候选里没有的东西）各至少 1 例（修订 A7）。
- submit：有上一轮的用例里，只有一例期望的档位和上一轮不同；`check` 里没有降一档才对的用例；「接着做」在 `fit` 里由同一会话的两例测，`check` 里另有一例（submit-05）。

留出集看不出的东西（到 Task 14 才发，这里只说构成）：

- midrun 的留出 5 例全是真实的 Code Mode 用例：3 例保持、2 例降档、没有升档。留出集的分数看不出漏掉的升档。升档只在 `fit`、`check` 上调，并在真实任务的验收（Task 15）里试。
- submit 的留出 5 例全是真实的，其中 3 例是同一会话的连续几轮（留出集上 60 个百分点出自一段对话）；没有要 xhigh 或 max 的用例。
- skill 的留出集里，没有正确候选缺说明的正例。
- agent 的留出 5 例全是补写的。

请求本身：

- 除 skill 外，每种给法的请求都带着两道对照题（`direct`、`long_unattended`），所以各给法只差在 state；mod 实际发的请求没有这两道题。
- 两种给法构造出完全相同的请求时共用一个回答；从第 2 遍起 state 末尾多一个 `request_uid`，已经顶到 4000 token 上限的 state 会把一个长字段再截短一点（发出去的就是存下来的）。
- midrun-08（留出）的 state 在每种给法里都被 150 token 的截断去掉了三行，出题审查认为答案仍然能从剩下的内容得出。

## 留出集之前定下的（Task 14 Step 1）

这一节在留出集发出之前写下并提交。留出集只发一次、只报数；它的结果不改下面任何一项（修订 A1）。比调整集明显差的地方照实写进「留出集」一节，由用户定。

**最终配置**

- 请求：和 mod 实际发的逐题相同（修订 A16）。发消息时是档位题加 skill 第一次请求的题；中途和派 agent 时只有各自的题；都不带对照题。
- 问法：不换。直接选档位的问法在调整集上三类都少对（7、8、6 比 9、10、7），「无人看管」加题在 submit 上少对（7 比 9）。
- 档位说明的措辞：不改。备选写法（`OPEN_LEVELS_B`）各发一份 mod 形式的请求、各 3 遍：agent 多对 1 例（要求 2 例），`check` 里一例由对变错，submit、midrun 少对，撤回。
- state：`previous_turn` 留着；`stated_next` 已从中途的 state 和说明里删掉；`recent` 保持 5 条。
- 续做的消息：续做题读成「是」并且上一轮的档位已知时，这一轮沿用上一轮的档位，不再由档位题挪动。这条是看了 `fit` 的两例之后定的，`check` 上没有变差。
- 门槛（Drex `drex-max-v1.1`）：只有派 agent 时的降档门槛从 0.70 改成 0.95，其余都是初值（`up` 0.7、`upHigh` 0.8、`down` 0.7、`yes` 0.7、`no` 0.3、`modelDown` 0.8；skill 的 `action` 0.3、`named` 0.5、`fits` 0.3）。逐个门槛的表和取法见「门槛」一节。
- 进展记录：留出集的三遍不带进展记录（mod 的默认）。带进展记录的两种给法各问 1 遍，只作观察；用不用、默认开不开由用户定。

**这套配置在调整集上的数**（`node dispatch-pilot/eval/run.ts score --set tune`；调整集上的分数，取舍都在这些用例上做）：submit: right 9 of 10 (right 9, under 1)；midrun: right 10 of 10 (right 10)；agent: right 7 of 10 (right 7, under 2, wrong-model 1)；skill: right 9 of 10 (right 9, wrong-skill 1)。

**留出集会报什么**

- 每类 5 例在最终配置下的对错（三遍里的第 1 遍），取自真实会话的和模型写的分开报数。
- 三遍之间决定不一样的用例。
- 登记过的其余给法各 1 遍，只作观察：带对照题的旧请求、不带上一轮、`recent` 1 条和 3 条、带进展记录的两种、备选措辞、打乱选项顺序的几种。
- 留出集看不出的事（出题时已记下）：中途换挡的留出集没有升档的例子；submit 的留出集没有要求 xhigh 或 max 的例子，5 例里 3 例是同一段对话相邻的三轮；派 agent 的留出集 5 例都是模型写的。
