# dispatch-pilot 校准记录

这份记录写 dispatch-pilot 1.0.0 的校准（设计第 8 节；计划 `docs/superpowers/plans/2026-11-19-dispatch-pilot-calibration.md`，以计划末尾的「修订」为准）。官方要求见同目录的 `STANDARD.md`，下文的 S1、S2……是它的编号。

## 摘要（Task 16 Step 1）

- **校准的是什么。** dispatch-pilot 1.0.0 把决策模型的回答读成 effort 档位、子 agent 的模型和推荐的 skill；校准的是这套读法，只对 Drex `drex-max-v1.1`（Jev 没有参加，仍用起步值）。所有请求都在 2026-11-19（UTC）发出：调整集 05:32–05:33 和 12:08–12:09，进展记录 12:33，留出集 12:33:45–12:34:15（只此一次），验收会话 12:34 起；没有候选 skill 时的请求在留出集之后的 13:21 另在调整集上问过，只作观察（Ruling C41）。
- **用例。** 四类（发消息定档 submit、中途换挡 midrun、派 agent agent、推荐 skill skill）各 15 例，共 60 例：取自本仓库自己的 Claude Code 会话记录 30 例，模型写的 30 例；下面每个分数都把两种来源分开报。每类分成 `fit` 6 例（用来挑）、`check` 4 例（每次改动后复查）、留出 5 例（只在最后问一次）。
- **参考答案是模型标的。** Fable 5.2（xhigh）出题时答一遍，另一个只看发出去内容的读者再答一遍，两遍不一致的交给第三个读者裁定；全部 60 例的参考答案列成一张表，在 Task 8 的关口交给用户；用户回答「全部同意」，没有改任何一例（60 例的 `label.by` 都是 `model`）；每一例用户是否逐个读过，没有记录。这不是几家不同模型的合标（S12、S13）。

**结果。** 唯一公平的测试是留出集在最终配置下的第 1 遍；调整集上的数是挑选时用过的，不是公平的测试（S16、S18、S20）。

| 类别 | 留出集 5 例（公平的测试） | 其中真实 / 补写 | 调整集 10 例（不是公平的测试） | 其中真实 / 补写 |
| --- | --- | --- | --- | --- |
| submit | 3 | 3/5 / — | 9 | 4/4 / 5/6 |
| midrun | 3 | 3/5 / — | 10 | 3/3 / 7/7 |
| agent | 2 | — / 2/5 | 7 | 3/5 / 4/5 |
| skill | 4 | 3/4 / 1/1 | 9 | 3/4 / 6/6 |
| 合计 | 12/20（60%） | 9/14 / 3/6 | 35/40（87.5%） | 13/16 / 22/24 |

留出集四类都比调整集低，错的 8 例里 4 例是档位高了（调整集在最终配置下没有一例高了）。

**发消息时的请求有两种。** 有候选 skill 时，mod 发的是档位题加 skill 第一次请求的题，校准问的就是这一种；没有候选时（每个会话的第一条消息，因为 skill 列表在它之后才到；`skills` 关着时的每条消息）只有档位题。后一种不在校准的取舍里，是事后在调整集上作为观察问的（Ruling C41）：调整集 10 例的决定和前一种全部相同（9/10），概率并不都相同；这不是公平的测试，留出集没有用这种请求问过（修订 A1），所以会话第一条消息上的门槛只靠这一点吻合。有候选时请求的样子还随用户自己的 skill 列表变：校准用的是一份 169 个 skill 的快照，skill 的题是一道 choice；超过 250 个就是两道。

**代码里的门槛。** 只对 `drex-max-v1.1`：只有派 agent 的降档门槛 `agent.down` 是 0.95，其余都是起步值（`up` 0.7、`upHigh` 0.8、`down` 0.7、`yes` 0.7、`no` 0.3、`modelDown` 0.8；skill 的 `action` 0.3、`named` 0.5、`fits` 0.3）；别的后端和模型全用起步值。**留出集上 `agent.down` 0.95 比起步值 0.70 少对 2 例**（agent 2/5 比 4/5，合计 12/20 比 14/20）；按修订 A1 没有改。

**每项比较的结论**（除最后一项外都在调整集上判）：

- 问法，一道题直接选档位（R-问法）：不换，三类都少对。
- 加「长时间无人看管」题（R-加题）：不加。
- 打乱直接选档位那道题的选项（修订 A13）：只报数（它没胜出）。
- skill 题陪着问（Ruling C18b）：保持默认，只 1 例变了。
- skill 打乱候选顺序（修订 A9）：调整集 10 例、留出集 5 例的决定都不变。
- 发消息时带上一轮（R-删字段 `previous_turn`）：留（9 比 7）。
- 中途的 `recent` 条数（R-recent）：保持 5 条——**看不出**（1、3、5 条都是 10/10）。
- 中途的 `stated_next`（R-删字段）：删——**看不出**好处（带不带都是 10/10，删是规则的结果）。
- 请求改成 mod 实际发的（修订 A16）：改了，因为同一请求里的题会互相移动回答。
- 只说「接着做」的消息沿用上一轮的档位（Ruling C38）：采用（调整集 submit 多对 2 例；是看过 `fit` 的两例之后定的）；它的代价调整集和留出集都**看不出**。
- 档位说明的另一种写法（`open-b`，Ruling C36）：撤回。
- 进展记录，不带 / 截至上一步 / 含最新一步（R-进展记录）：**看不出**（三种都是 10/10），只报数，由用户定。
- 门槛（R-门槛）：19 个里 13 个单独扫就没有用例卡得住，`agent.modelDown` 在 `agent.down` 取 0.95 之后也没有，这 14 个**看不出**，留初值；4 个初值已在最好的那一段里，留；只挪了 `agent.down`。修订 A15 和两个 agent 门槛的先后（C39）是看过调整集上扫门槛的表之后定的。
- 没有候选 skill 时的请求（只有档位题，`first-message`，Ruling C41）：不在取舍里，事后在调整集上观察：10 例的决定和 `default` 全部相同（9/10）；不是公平的测试，留出集没有问。
- **验收**（R-验收：中途换挡在真实任务上有没有用）：**看不出**。16 次运行全部通过；开着的一组总 token 中位数低 5.2%，没到 15%；开着的一组降了 6 次档、升了 0 次档，升档在真实任务上没有被检验过。

**用了多少。** Drex：675 个请求（其中 30 个是留出集之后问的 `first-message`），失败 0 个，回答的 `model` 都对；估算输入 2,770,165 token（上限 2000 个请求、3000 万 token）。另外：写进展记录用了 63 次 Haiku 调用（`claude -p`）；验收 16 个会话、试跑 4 个会话，主模型都是 Sonnet 5.5（这些会话里 mod 自己发给 Drex 的请求不在 675 个里）。

**怎么重算（不发任何请求）。** 在仓库根目录运行 `node dispatch-pilot/eval/run.ts score --set tune|fit|check|heldout`、`sweep --path <门槛>`、`stability --set tune|heldout`；`score`、`stability` 默认用代码里取定的门槛，加 `--bars start` 用起步值，`sweep` 从起步值扫。它们只读私有数据目录里存下的回答（不在仓库里，没有它就重算不了）。验收的数用「验收」一节写的命令从验收的记录重算。

**还没定、由用户定的事：**

- `agent.down` 是否退回 0.70。controller 建议退回（计划在修订 A1 之前的原规则正会这样做）；退回之后，留出集上 agent 的数就参与过取舍，不再是公平的测试。
- 进展记录用不用、默认开不开。
- 中途换挡留不留（验收看不出）。
- 续做的消息沿用上一轮的档位（Ruling C38）留不留。这条规则改了要发布的行为，却是 controller 定的：它是看过 `fit` 的两例之后定的，在 `check` 上的确认是空的（唯一的一例 submit-05 在两种规则下都对），在留出集上一次也没起作用。请用户确认或撤回。
- 什么时候发版。

### 读这份记录之前

- **除了摘要和「留出集」一节，下面的分数都是调整集上的分数。** 调整集是每类 10 例（`fit` 6 例、`check` 4 例），措辞、问法、上下文和门槛的取舍都在这些用例上做，所以这些数字不是公平的测试（S18、S20）。留出集（每类 5 例）只在 Task 14 发了一次，它的分数只在「留出集」一节和摘要里；其余各节的分数都是调整集上的。几处例外不是分数：C38 一节引了留出集 3 例的 `continues` 值，「用例是怎么来的」一节讲留出集的构成；验收一节的数出自真实任务的运行，既不是调整集的也不是留出集的。
- 只校准 Drex `drex-max-v1.1`。Jev 没有参加。
- 判分用每个请求的第 1 遍回答；第 2、3 遍只用来看稳定性（修订 A5）。「基线」「问法」「上下文」「请求改成 mod 实际发的」四节的门槛一律是起步值（`START`：升档 0.7，升到 xhigh 和 max 0.8，降档 0.7，`noul` 读作「是」0.7、读作「否」0.3，换模型 0.8；skill 的 action 0.30、named 0.50、fits 0.30）。runner 的 `score`、`stability` 现在默认用取定的门槛（见「门槛」一节），重算这几节要加 `--bars start`。
- 「基线」「问法」「上下文」三节用的是第一遍的请求：submit、midrun、agent 带两道对照题，skill 的第一次请求不带档位题。这些请求现在叫 `with-controls`（skill 是 `stage-1-alone`、`stage-2-alone`），`default` 已经改成 mod 实际发的请求（修订 A16）。这三节的读法也在 Ruling C38 之前；现在的读法下 submit-02 在这些请求里读成 xhigh（原来是 high，两个都可接受，合计不变）。要逐字重算这三节，用 C38 之前的代码：`git archive 21ac303 dispatch-pilot | tar -x -C <空目录>`，在那里运行原来的命令（变体名用各节写的，不加 `--bars start`：那时的 runner 默认就是起步值）。
- 每个数字都能重算：在仓库根目录运行表格旁边写的命令。命令只读私有数据目录里存下的回答（`run.ts` 的 `--data`，默认值见 `run.ts` 开头），不发请求。私有数据目录不在仓库里，没有它就重算不了。
- 仓库是公开的。取自真实会话的用例只写编号和结果，不写原文；真实 skill 用例的期望和回答也不写 skill 的名字，只写对没对。
- 标记的意思：`right` 对；`under` 档位低了；`over` 档位高了；`missed-shift` 该换挡没换；`wrong-model` 档位对、模型不在可接受的范围里；`wrong-skill` 推荐了另一个 skill；`needless-shift` 不该换挡却换了；`needless-skill` 不该推荐 skill 却推荐了。

## 基线（Task 9）

### 请求

- 日期：2026-11-19（UTC 05:32–05:33；本机时间 PST 是 2026-11-18 晚上）。
- 回答报告的模型：236 个回答全部是 `drex-max-v1.1`。
- 请求数：236 个，失败 0 个，回答的 `model` 不对的 0 个。其中 1 个是发调整集之前的合成小请求（`smoke`，用一例模型写的用例，修订 A4），它的回答不计分；其余 235 个：默认给法（就是现在的 `with-controls` 和 `stage-1-alone`、`stage-2-alone`）每例 3 遍（四类各 10 例，共 120 个，另加 skill 第二次请求 30 个），其余登记的给法各 1 遍（85 个；和默认给法发出的请求完全相同的，按 `hash` 共用一个回答，不另发）。
- 耗时：235 个请求用了约 35 秒（最多同时 4 个），单个请求中位数 526 ms，最长 1249 ms。
- token：823,895，这是 runner 发请求之前的估算，不是 Drex 回报的用量。

### 每类的对错

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant with-controls --bars start`，skill 是 `--variant stage-1-alone --bars start`（分组看用 `--set fit`、`--set check`）。调整集上的分数，取舍都在这些用例上做。

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

命令：`node dispatch-pilot/eval/run.ts stability --set tune --variant with-controls --bars start`、`stability --set tune --variant stage-1-alone --bars start`（起步门槛下）。

- 调整集 40 例都问了 3 遍。第 2、3 遍的 state 末尾多一个一次性的 `request_uid`（修订 A5）。
- 3 遍决定不一样的有 2 例：
  - submit-02（fit）：high、xhigh、high。两种都在可接受的范围里。（C38 之后的读法下 submit-02 3 遍都是 xhigh，不再不稳定。）
  - midrun-11（check）：low、medium、medium。两种都在可接受的范围里。
- 这是第一遍的判断。门槛后来在 mod 形式的请求上扫（修订 A16），那里起步值下不稳定的是 submit-12 和 midrun-11，都不在 `fit`，`sweep` 没有去掉任何用例（见「门槛」一节）。
- 另有 3 例有一遍读不出决定：skill-03（第 2、3 遍）、skill-12（第 3 遍）、skill-13（第 3 遍）。原因是 runner 的第二次请求按第 1 遍的候选短名单发出，3 遍共用；这几遍的第一次请求排出的前三名里有一个和第 1 遍不同（第一名没变），第二次请求就答不了那一遍的短名单，按规则算没有回答。能读出来的几遍，这 3 例的决定都一样。所以这 3 例的稳定性只看了一部分。（缺的是这一节用的 `stage-1-alone` 给法；mod 形式的默认给法 `stability --set tune` 下这 3 例不缺。）

### 回答不对的用例，逐个查（Task 9 Step 4）

照设计第 8 节和 S30 的顺序查：实际发出的请求、state、选项、题的范围、措辞。只记录，不改任何措辞和门槛。下面的概率是第 1 遍的，括号里是 3 遍的范围。`open` 的五个概率依次对应第 0 到第 4 档（low 到 max）。

**submit-12（check，补写；期望 max，得到 high）**

1. 发出的请求：state 是 `note` 和 `request` 两个字段（这一例没有上一轮，所以没有 `previous_turn`），题是 mod 的 `open`、`mechanical`、`unknown_cause`，加两道对照题 `direct`、`long_unattended`。和 `build` 给出的请求一致。顺带记下：`note` 是固定的一句，提到了 `previous_turn`，这一例里没有这个字段。
2. state：参考答案的依据都在 `request` 里（在线改主键类型、没有停写的窗口、从库延迟有上限），只看 state 能答出来。
3. 选项：第 4 档就是参考答案，在选项里。
4. 题的范围：`open` 只量一个维度。第 4 档的说明是两个条件的组合，但模型选中了它，范围没有挡住。
5. 措辞：没有读错的迹象。概率最高的就是第 4 档：`open` = [0.045, 0.008, 0.175, 0.059, 0.712]，`mechanical` 0.037，`unknown_cause` 0.009，对照题 `direct` 给 max 0.857。

查到第 5 步。差在门槛：从起点 medium 逐档往上，高于 medium 的概率和 0.946，过了 0.7，升到 high；高于 high 的概率和 0.771（0.744–0.771），没到升到 xhigh 要的 0.8；max 一档是 0.712，也没到 0.8。这是门槛的事，留给 Task 13（Task 13 没有挪 `submit.upHigh`：`fit` 里没有用例卡得住它，按修订 A14 留在初值，见「门槛」一节）；submit-12 在 `check`，扫门槛只用 `fit`，它只能用来核对。

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
2. state：一条普通的请求，只看 state 能答。参考答案是接近的：出题者和盲答者都选了同一个 skill，盲答者提了疑问，裁定维持。
3. 选项：参考答案在第一次请求的候选里，也进了第二次请求的短名单，但余地不大：第一次请求的 choice 很平，最大的概率只有 0.121（「other」也是 0.121），参考答案 0.116，排第二，和第三名相同，第四名是 0.084。打乱候选顺序的那一遍（`stage-1-shuffled`）里，参考答案掉出了前三名（0.066），那一遍的第二次请求里根本没有正确的选项。
4. 题的范围：gate 的读法对了（三道动手题的均值 0.526，过了 0.30，该推荐 skill）；第二次请求的 choice 只问一件事。
5. 措辞：第二次请求的 choice 给错的那个 0.474（0.437–0.492），参考答案 0.346（0.327–0.382）；`fits_` 两个都读成合适：参考答案 0.556（0.523–0.643），错的那个 0.632（0.611–0.683）。错的那个候选的说明和参考答案的说明有一部分重叠。

查到第 5 步。我们的题（照抄 TypeSafe skill_suggestion cookbook）没有读错的迹象：模型照题目的要求读了候选的说明，偏差来自两个候选的说明重叠，而候选的说明不是 mod 写的。门槛救不了它：`fits` 的门槛调高只会变成不推荐，仍然不对。

## 问法（Task 10 Step 1–2）

默认的问法是「问工作本身，代码查表」；对照一是 `direct`（一道 choice 直接选档位，选项的说明就是五档的说明），对照二是 `long_unattended`（候选的加题：读作「是」时档位至少 high）。两道对照题和默认题在同一个请求里问（S22），所以下表三列读的是同一批回答。`direct` 打乱选项是另一个请求（`direct-shuffled`，每例 1 遍）。midrun 不问 `long_unattended`。skill 不参加这一节。

命令：默认（当时的默认，现在的 `with-controls`）`score --set tune --variant with-controls --bars start`；direct `score --set tune --variant with-controls --form direct --bars start`；long-unattended `score --set tune --variant with-controls --long-unattended --bars start`；direct 打乱选项 `score --set tune --variant direct-shuffled --form direct --bars start`（命令都是 `node dispatch-pilot/eval/run.ts` 加这些参数）。调整集上的分数，取舍都在这些用例上做。

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

打乱的只是 `direct` 这一道题的选项顺序，其余的题和 state 一字不差，可 `open` 等题的回答也跟着动了。按默认问法读 `direct-shuffled` 的回答（命令：`node dispatch-pilot/eval/run.ts score --set tune --variant direct-shuffled --bars start`，和 `--variant with-controls --bars start` 比），30 例里有 6 例的决定和默认请求的不同：

| 编号 | 默认的请求 | 只打乱 direct 选项的请求 |
| --- | --- | --- |
| agent-01 | low · sonnet under | medium · opus right |
| agent-02 | low · sonnet under | low · opus under |
| agent-03 | medium · sonnet right | medium · opus wrong-model |
| agent-10 | medium · sonnet right | medium · opus right |
| midrun-11 | low right | medium right |
| submit-02 | high right | xhigh right |

（C38 之前的读法。现在的读法下 submit-02 两边都是 xhigh，决定不同的是 5 例。）

例如 agent-01 的 `open` 在第 0 档的概率从 0.775 变成 0.654，同一请求重复问 3 遍的范围只是 0.746–0.775。S23 说同一请求里的题读不到彼此的回答，这里的数说明：同一请求里别的题的写法会移动回答，移动的幅度比重复问的大。它不改上面任何判定（判定比的都是同一批回答，或者差得远），但有两处要知道：默认给法的请求带着两道对照题，mod 实际发的请求没有（Ruling C18a，为了让各给法只差在 state）；修订 A8 要把新旧措辞放进同一请求比，加进去的新题本身也可能移动旧题的回答。这两处后来都改了：默认给法改成 mod 实际发的请求（修订 A16，Ruling C34），A8 撤回、新措辞各发一份请求比（Ruling C35），见「请求改成 mod 实际发的」一节。

### skill 题陪着问（with-skills）

mod 发消息时，在定档的题旁边还会问第一次请求的 skill 题；当时的默认给法（现在的 `with-controls`）没有带。跑之前定下的规则（Ruling C18b）：带上 skill 题之后，调整集 10 例里定档的决定和默认不同的有 2 例及以上，就说陪着的题会移动回答，submit 的门槛改用 with-skills 的回答来扫；否则保持默认。

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant with-skills --bars start`（和 `--variant with-controls --bars start` 比）。调整集上的分数，取舍都在这些用例上做。

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

不同的只有 1 例（submit-12，从 high 变成 xhigh，两个都低了）。**判定：保持默认**，submit 的门槛照常用默认给法的回答扫（后来按修订 A16，门槛改在 mod 形式的请求上扫，那种请求本来就带着 skill 题）。

### skill 打乱候选顺序

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant stage-1-shuffled --bars start`（第二次请求也是打乱的那一遍）。调整集上 9 例对，和当时的默认（现在的 `stage-1-alone`）相同；10 例的决定都没变（修订 A9）。skill-09 仍然错，只是打乱后正确的 skill 连短名单都没进（见上文）。

## 上下文（Task 11 Step 2）

同一批调整集用例，只改 state 的一个字段。改了之后请求和默认完全相同的用例（例如没有上一轮的用例去掉 `previous_turn`），不另发，表里写「同一请求」，它的结果就是默认的结果。调整集上的分数，取舍都在这些用例上做。

### 发消息时带不带上一轮（`previous_turn`）

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant no-previous --bars start`。去掉上一轮时，只在有上一轮时才问的 `continues` 也不问了。

| 编号 | 组 | 期望 | 带 `previous_turn`（当时的默认，现在的 `with-controls`） | 不带（no-previous） |
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

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant with-controls`（5 条，当时的默认）、`--variant recent-3-with-controls`、`--variant recent-1-with-controls`、`--variant no-stated-next-with-controls`（都加 `--bars start`）。现在的 `recent-1`、`recent-3` 是 mod 形式的请求，调整集上没有问。

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

**R-删字段（`stated_next`）：删。** 带着它 10 例对，不带也是 10 例对，带着它没有多对任何一例，按规则删。删字段的代码改动已经做完：中途的 state 不再带 `stated_next`（commit 5c7994b），state 开头的说明也不再提它（commit 21ac303）。

**两边都在顶上，比较看不出好处。** `recent` 的三种条数和 `stated_next` 的两种给法在调整集上都是 10 例全对，已经没有可以多对的用例，所以这两项比较本来就不可能显出更多上下文的好处；「不多对」在这里只说明调整集分不出来，不说明这些字段没有用。`previous_turn` 不是这种情况（7 比 9）。

## 请求改成 mod 实际发的（修订 A16）和措辞（Task 10 Step 3）

### 为什么改、改了什么

第一遍（「问法」一节的「另记」）发现同一请求里的题会互相移动回答：只打乱 `direct` 一道题的选项顺序，其余的题和 state 一字不差，按默认问法读，30 例里 6 例的决定变了。第一遍的默认请求带着两道对照题（`direct`、`long_unattended`），mod 实际发的请求没有；对照题要做的比较已经做完（R-问法、R-加题都判了不换）。所以从这里起，`default` 和 mod 发的请求逐题相同（Ruling C34、修订 A16），之后的数（门槛、进展记录的比较、留出集）都在这种请求上取：

- submit：档位题（`open`、`mechanical`、`unknown_cause`，有上一轮时加 `continues`）加 skill 第一次请求的题，像 mod 有候选 skill 时一样一起发；不带对照题。mod 没有候选时（每个会话的第一条消息、`skills` 关着）只发档位题，那一种不在这里，见本节最后的「没有候选 skill 时的请求」。
- midrun：只有自己的题，不带 `direct`；state 里没有 `stated_next`，说明也不再提它（R-删字段的结果）。
- agent：只有自己的题，不带对照题。
- skill：`stage-1` 带上档位题，和 mod 发消息时一样。

原来的请求改名留着：submit、midrun、agent 的叫 `with-controls`，skill 的叫 `stage-1-alone`、`stage-2-alone`；存下的回答照旧能读。修订 A8（新旧措辞放进同一请求比）撤回：同一请求里的题会互相移动，新措辞改为各发一份 mod 形式的请求、各 3 遍，比决定（Ruling C35）。

请求：2026-11-19 UTC 12:08–12:09，`ask --set tune --repeat 3` 135 个（submit、midrun、agent 90 个，skill 第一次请求 27 个、第二次请求 18 个；和已存的请求完全相同的共用一个回答，例如 skill-01 的第一次请求就是 submit-01 的请求），`ask --set tune --variant open-b --repeat 3` 90 个。225 个都有回答，失败 0 个，回答的 `model` 都是 `drex-max-v1.1`；估算 1,188,666 token。到这里累计 461 个请求、2,012,561 token。

### 旧请求和新请求，逐例

下表是 Ruling C38（见下一小节）之前的读法、起步门槛，也就是当时下决定所用的数。C38 已经写进 runner 的读法，用现在的代码重算这张表要用 C38 之前的代码：`git archive 21ac303 dispatch-pilot | tar -x -C <空目录>`，在那个目录里运行 `node dispatch-pilot/eval/run.ts score --set tune --variant with-controls`（旧请求）、`score --set tune`（新请求），分组加 `--set fit`、`--set check`；skill 的旧请求是 `--variant stage-1-alone`。调整集上的分数，取舍都在这些用例上做。

| 类别 | 旧请求 `with-controls`（fit / check / 调整集） | 新请求 `default`（fit / check / 调整集） |
| --- | --- | --- |
| submit | 6 / 3 / 9 | 4 / 3 / 7 |
| midrun | 6 / 4 / 10 | 6 / 4 / 10 |
| agent | 3 / 4 / 7 | 2 / 4 / 6 |
| skill（旧的是 `stage-1-alone`） | 5 / 4 / 9 | 5 / 4 / 9 |

决定不同的有 3 例，skill 10 例的决定都没变：

| 编号 | 组 | 期望 | 旧请求 | 新请求 |
| --- | --- | --- | --- | --- |
| submit-02 | fit | high/xhigh | high right | medium under |
| submit-09 | fit | xhigh | xhigh right | low under |
| agent-03 | fit | medium · sonnet | medium · sonnet right | medium · opus wrong-model |

- **submit-02、submit-09** 都是只说「接着做」的消息，上一轮都是 xhigh。当时的读法从上一轮的档位起算，再看降档。差在 `open` 对这样一句话的回答：没有对照题时，它把大部分概率放到第 0 档（「做法已经给定」）。submit-09 的第 0 档：带对照题 0.456，带对照题和 skill 题（`with-skills`）0.501，mod 自己的请求 0.795（3 遍 0.795–0.801）。于是低于 xhigh 的概率和从 0.631 变成 0.960，过了降档门槛 0.7，一路降到 low（低于 medium 的也有 0.795）。submit-02 带对照题时 `open` = [0.512, 0.138, 0.096, 0.173, 0.080]，低于 high 的和 0.650，停在 high；mod 的请求里是 [0.676, 0.174, 0.097, 0.041, 0.012]，低于 high 的和 0.850，降到 medium，低于 medium 的 0.676 没到 0.7，停在 medium。
- **agent-03**：继承 medium 和 opus，期望换到 sonnet。往下换一档要第 0、1 档的概率和到换模型门槛 0.8：带对照题 0.859（3 遍 0.848–0.859），mod 的请求 0.796（3 遍 0.745–0.796），差一点没到。

所以第一遍 submit 的 9/10 有一部分来自 mod 从来不发的题：换成 mod 的请求是对的。

### 续做的消息沿用上一轮的档位（Ruling C38）

规则：`continues` 读成「是」并且上一轮的档位已知时，这一轮的档位就是上一轮的；`open`、`mechanical`、`unknown_cause` 问的是一句只说「接着做」的话，不再挪动它。理由：上一轮的档位代码自己知道；上面的数说明模型把一句光秃秃的「接着做」读成「做法已经给定」。

这条是看了 `fit` 的两例（submit-02、submit-09）之后定的，再到 `check` 上确认：submit-05（`check`，上一轮 low、期望 low，`continues` 0.999）照样对，`check` 仍是 3/4。起步门槛下的数（命令：C38 之前用上面 `<空目录>` 里的 `score --set tune`；之后 `node dispatch-pilot/eval/run.ts score --set tune --bars start`）：

| | submit（fit / check / 调整集） |
| --- | --- |
| C38 之前 | 4 / 3 / 7 |
| C38 之后 | 6 / 3 / 9 |

多对 2 例（submit-02 得到 xhigh，submit-09 得到 xhigh），和 R-问法 的门限一样。旧请求在 C38 之下仍是 9/10，只是 submit-02 从 high 变成 xhigh（两个都可接受）。

调整集看不出这条规则的代价：调整集里 `continues` 读成「是」的 4 例（submit-02、05、09、10）期望的都是上一轮的档位或旁边一档；一句「接着做」开始的工作比上一轮难或易得多时，这条规则会让它留在上一轮的档位（中途换挡仍能把它往上挪），调整集里没有这样的例子。留出集里有上一轮的 3 例（submit-07、14、15），`continues` 是 0.135–0.327，都没读成「是」，这条规则在留出集上一次也没起作用，留出集也看不出它。

### 档位说明的另一种写法（`open-b`）

备选写法 `OPEN_LEVELS_B` 试在 submit、midrun、agent 三类上（三类共用一套档位说明），各发一份 mod 形式的请求、各 3 遍。跑之前定下的规则（Ruling C36）：agent 在调整集上多对至少 2 例、今天对的 `check` 用例一例不错、submit 和 midrun 在调整集上不变差，三类都换；只有 agent 满足就只给 agent 换；否则撤回。最多这一轮。

命令：C38 之前（当时下决定所用）在上面 `<空目录>` 里 `score --set tune --variant open-b`（分组加 `--set fit`、`--set check`），稳定性 `stability --set tune --variant open-b`；C38 之后 `node dispatch-pilot/eval/run.ts score --set tune --variant open-b --bars start`。起步门槛，调整集上的分数，取舍都在这些用例上做。

| 类别 | `default`（fit / check / 调整集） | `open-b`（fit / check / 调整集） | C38 之后：`default` / `open-b` |
| --- | --- | --- | --- |
| submit | 4 / 3 / 7 | 3 / 3 / 6 | 9 / 8 |
| midrun | 6 / 4 / 10 | 5 / 4 / 9 | 10 / 9 |
| agent | 2 / 4 / 6 | 4 / 3 / 7 | 6 / 7 |

决定不同的用例（C38 之前；C38 之后 submit-09 两种写法都是 xhigh，其余相同）：

| 编号 | 组 | 期望 | `default` | `open-b` |
| --- | --- | --- | --- | --- |
| submit-01 | fit | low | low right | medium over |
| submit-09 | fit | xhigh | low under | medium under |
| midrun-03 | fit | down low/medium | low right | medium right |
| midrun-11 | check | down low/medium | low right | medium right |
| midrun-13 | fit | hold high | high right | medium needless-shift |
| agent-01 | fit | medium · sonnet/opus | low · sonnet under | medium · sonnet right |
| agent-02 | fit | high · opus/fable | low · sonnet under | medium · opus under |
| agent-03 | fit | medium · sonnet | medium · opus wrong-model | medium · sonnet right |
| agent-13 | check | high · opus | high · opus right | medium · sonnet under |

`open-b` 3 遍决定不一样的有 1 例：midrun-13（medium、medium、high）。

**判定（Ruling C36）：撤回。** agent 净多对 1 例（多对 agent-01、agent-03，少对 agent-13），要求 2 例；`check` 里今天对的 agent-13 变错；submit、midrun 都少对。按 C38 之后的读法重算，结论不变（submit 8 比 9，midrun 9 比 10，agent 7 比 6）。`open-b` 留在登记里，存下的回答仍能读；`hooks/questions.ts` 不改。按 C36 不再做第二轮措辞。

三例只读的审查派发（agent-01、agent-02、agent-09）措辞没有解决：`open-b` 只让 agent-01 对了，而它已撤回。最终配置里 agent-01 是靠降档门槛（见「门槛」一节）变对的，agent-02、agent-09 仍然低了。

### 没有候选 skill 时的请求（`first-message`，Ruling C41）

mod 发消息时发的请求有两种（`hooks/flows/submit.ts`）。有候选 skill 时是档位题加 skill 第一次请求的题，按 partial 读，就是上面的 `default`，校准的取舍都在它上面做。没有候选时只有档位题（有上一轮时加 `continues`），state 相同，不按 partial：每个会话的第一条消息都是这样（会话的 skill 列表在第一条消息之后才到，实测），`skills` 关着时每条消息都是这样。第二种不在校准的取舍里：门槛、C38 和留出集问的都是第一种。最终审查指出这一点之后，登记了给法 `first-message`（和 mod 没有候选时发的请求逐题相同，`tests/eval-request.test.ts` 核对），在调整集 submit 10 例上各问 3 遍，只作观察（Ruling C41）。留出集没有用它问过（修订 A1；它登记在留出集那一次之后，runner 的留出集运行不带它）。

有候选时，请求的样子还随用户自己的 skill 列表变：skill 的第一次请求把候选分成 ceil(n/250) 道 choice。校准用的是一份 169 个 skill 的快照，是一道；超过 250 个就是两道，那样的请求没有问过。

请求：2026-11-19 UTC 13:21:43–13:21:47，`ask --set tune --variant first-message --repeat 3` 30 个，失败 0 个，回答的 `model` 都是 `drex-max-v1.1`；单个请求中位数约 500 ms，最长 981 ms；估算 22,678 token。到这里累计 675 个请求、2,770,165 token。

命令：`node dispatch-pilot/eval/run.ts score --set tune --variant first-message`（分组加 `--set fit`、`--set check`）、`stability --set tune --variant first-message`；对照的 `default` 是 `score --set tune`、`stability --set tune`。取定的门槛（submit 的门槛和起步值相同）。调整集上的观察，不是公平的测试。

| 编号 | 组 | 上一轮 | 期望 | `default`（3 遍） | `first-message`（3 遍） |
| --- | --- | --- | --- | --- | --- |
| submit-01 | fit | 无 | low | low ×3 right | low ×3 right |
| submit-02 | fit | xhigh | high/xhigh | xhigh ×3 right | xhigh ×3 right |
| submit-03 | fit | 无 | xhigh | xhigh ×3 right | xhigh ×3 right |
| submit-09 | fit | xhigh | xhigh | xhigh ×3 right | xhigh ×3 right |
| submit-10 | fit | low | low | low ×3 right | low ×3 right |
| submit-11 | fit | 无 | medium | medium ×3 right | medium ×3 right |
| submit-04 | check | low | high | high ×3 right | high ×3 right |
| submit-05 | check | low | low | low ×3 right | low ×3 right |
| submit-12 | check | 无 | max | high、xhigh、high（第 1 遍 under） | high ×3 under |
| submit-13 | check | 无 | low | low ×3 right | low ×3 right |
| 合计（第 1 遍） | | | | 9/10（fit 6/6，check 3/4） | 9/10（fit 6/6，check 3/4） |

10 例的决定（第 1 遍）两种请求全部相同；`first-message` 3 遍决定不一样的 0 例，`default` 是 submit-12 一例。

决定相同，概率并不都相同（第 1 遍，括号里是 3 遍的范围；`open` 的五个概率依次是 low 到 max）：

- 没有上一轮的 5 例，`open` 大多只差几个百分点：submit-01 第 0 档 0.834 比 0.840（0.829–0.834 比 0.840–0.876），submit-13 0.834 比 0.853。挪得最多的是 submit-12：第 4 档 0.764 比 0.639（0.761–0.782 比 0.639–0.725），第 2 档 0.120 比 0.236；从 medium 往上，高于 high 的和 0.783 比 0.667（3 遍 0.667–0.756），离升到 xhigh 要的 0.8 更远，所以 3 遍都是 high（`default` 第 2 遍是 0.801，升到了 xhigh）。
- 有上一轮的 5 例，`continues` 大多不动（submit-02 0.938 比 0.923，submit-05 0.999 比 0.999，submit-09 0.875 比 0.880），但 submit-10 从 0.721（0.712–0.721）降到 0.683（0.600–0.683），落到读作「是」的 0.7 以下：`default` 里它按 C38 沿用上一轮的 low，`first-message` 里 C38 没有起作用，是 `open` 从 medium 降到 low（第 0 档 0.929）。同一个决定，由另一条规则得出。`open` 也挪了：submit-09 第 0 档 0.795 比 0.660（它的决定由 C38 定，`open` 不起作用）；submit-04 第 2 档 0.658 比 0.730，`unknown_cause` 0.730 比 0.556（0.712–0.730 比 0.556–0.747）。

所以两种请求在这 10 例上决定一致，概率不一致：同一档的概率差到约 0.13，一例的 `continues` 跨过了门槛，又一次说明同一请求里的题会互相移动回答。会话第一条消息上的门槛只靠这 10 例决定的吻合，别无依据；这是调整集上的观察，不是公平的测试，留出集没有用这种请求问过（修订 A1）。要不要给这种请求另调读法，由用户定。

## 进展记录（Task 12）

### 进展记录怎么写出来的

- 用 mod 自己的提示（`hooks/progress.ts` 的 `progressPrompt`）构造，交给 `claude -p --model haiku --setting-sources project --system-prompt <提示的 system 部分>` 逐条生成，用 `parseProgress` 解析；生成的小脚本是 `eval/notes.ts`。每次调用在一个新的空目录里跑，环境里去掉了打开 OpenTelemetry 的变量。
- 每个最近的步一次调用：「截至上一步」(`before`) 沿着 `recent` 一步一步累积，每次在上一条记录的基础上写；「含最新一步」(`after`) 再在 `before` 上加最新一步。15 例 midrun 共 63 次调用（每例 `recent` 的条数加 1），写出 29 条记录；midrun-06（留出）没有更早的步，它的 `before` 是空的，带 `before` 的请求和默认相同。解析失败的 0 条。记录是英文的。
- 这和 mod 里的通路不同：mod 用 `$.model.complete`（low effort，最多 200 token），这里用的是 `claude -p` 调 Haiku。所以下面比的是「这样写出的记录」，不是 mod 运行时实际写出的记录。
- 请求：2026-11-19 UTC 12:33，`ask --set tune --variant progress-before --variant progress-after`，20 个（各 10 个，各 1 遍），失败 0 个，估算 28,453 token。

### 三种给法并排

命令：`node dispatch-pilot/eval/run.ts score --set tune`（不带，mod 的默认）、`--variant progress-before`、`--variant progress-after`。调整集上的分数，取舍都在这些用例上做。

| 编号 | 组 | 期望 | 不带 | 截至上一步 | 含最新一步 |
| --- | --- | --- | --- | --- | --- |
| midrun-01 | fit | hold low | low right | low right | low right |
| midrun-02 | fit | up high | high right | high right | high right |
| midrun-03 | fit | down low/medium | low right | low right | low right |
| midrun-04 | check | up high/xhigh | high right | high right | high right |
| midrun-05 | check | hold high | high right | high right | high right |
| midrun-09 | fit | hold medium | medium right | medium right | medium right |
| midrun-10 | fit | up xhigh | xhigh right | xhigh right | xhigh right |
| midrun-11 | check | down low/medium | low right | low right | low right |
| midrun-12 | check | hold low | low right | low right | low right |
| midrun-13 | fit | hold high | high right | high right | high right |
| 合计 | | | 10/10 | 10/10 | 10/10 |

三种都是 10 例全对，10 例的决定一模一样。**三种都在顶上，这个比较显不出进展记录的好处**；「没有多对」在这里只说明调整集分不出来。按 R-进展记录，这里只报数和逐例对照，用不用、默认开不开由用户定。

### 带标签的用例

`looks-finished`、`batch-mechanical`、`stuck` 三种标签的用例单独列出。决定三种给法都一样，下表给的是决定所依据的概率（第 1 遍）：「往上」是 `open` 里高于当前档位的概率和，「往下」是低于当前档位的，后面是和这一例有关的 `noul`。概率读自存下的回答，runner 不打印概率。

| 编号 | 标签 | 组 | 期望 | 相关的概率（不带 / 截至上一步 / 含最新一步） | 离参考答案 |
| --- | --- | --- | --- | --- | --- |
| midrun-01 | looks-finished | fit | hold low | 往上 0.329 / 0.257 / 0.302 | 两种记录都更近（往上的概率小了） |
| midrun-03 | batch-mechanical | fit | down low/medium | 往下 0.958 / 0.976 / 0.971；`only_carrying_out` 0.988 / 0.992 / 0.998 | 都更近一点 |
| midrun-11 | batch-mechanical | check | down low/medium | 往下 0.950 / 0.964 / 0.964；`cause_found` 0.764 / 0.909 / 0.870 | 都更近 |
| midrun-12 | batch-mechanical | check | hold low | 往上 0.044 / 0.071 / 0.049 | 都远了一点（离门槛仍很远） |
| midrun-04 | stuck | check | up high/xhigh | 往上 0.590 / 0.637 / 0.651；`same_failure` 0.987 / 0.997 / 0.984 | 往上的更近，仍没到 0.7；三种都是靠 `same_failure` 升一档 |

其余 5 例的方向不一：midrun-02（`up`）往上 0.509 / 0.438 / 0.689，截至上一步的记录远了，含最新一步的记录近了很多（离 0.7 只差 0.011；三种都是靠 `contradicts_plan` 0.923 / 0.893 / 0.988 升的档）；midrun-10（`up`）往上 0.952 / 0.970 / 0.975，近了；midrun-13（`hold`，`cause_found` 三种都是 0.998 以上）往下 0.540 / 0.432 / 0.408，近了；midrun-05（`hold` high）往上 0.589 / 0.623 / 0.633、midrun-09（`hold` medium）往下 0.431 / 0.443 / 0.502，远了。

概率能说的只有这些：记录让大多数相关的概率挪了几个百分点，多数朝参考答案的方向，也有几例相反；挪得最多的是 midrun-02 含最新一步的记录（往上 +0.18）。没有一例因此跨过门槛，调整集看不出它会不会改决定。

## 门槛（Task 13）

扫门槛用新的 `default` 的回答（mod 形式的请求，读法里有 C38），每个门槛在 `fit` 6 例上算对的例数，其余门槛取起步值。网格按修订 A3：`up`、`upHigh`、`down`、`yes`、`modelDown` 0.50–0.95，`no` 0.05–0.50，skill 的 `action`、`fits` 0.10–0.60，`named` 0.30–0.80，每隔 0.05 一个值。按修订 A13，稳定性在扫之前按起步值判一次：起步值下 3 遍决定不一样的是 submit-12 和 midrun-11，都在 `check`，`fit` 里没有，所以没有用例被去掉（`sweep` 没有打印 left out）。表里每个取值都没有「读不出决定」的用例。

取值的规则：修订 A3（对得最多的那一段里保守的一端：`no` 取最低，其余取最高）、A14（那一段盖住整个网格，就是 `fit` 里没有哪一例卡得住它，保留初值，写明没有依据）、A15（初值已经在那一段里就不挪）。**A15 是看过第一遍（带对照题的旧请求）扫门槛的表之后才加的**（2026-11-19，Ruling C32）：它只会让门槛留在初值，不会让任何门槛挪得更远；不加它，下面 4 个门槛会挪到那一段的边上、紧贴着一例用例，而对的例数并不增加（S48）。**同一类的两个门槛 `agent.down` 和 `agent.modelDown` 先后取、先取哪个（Ruling C39），也是看过下面的表之后定的。**

命令：`node dispatch-pilot/eval/run.ts sweep --path <门槛>`（例如 `--path submit.down`），从起步值扫；表里「`modelDown`（`down` 取 0.95 之后）」一列是 `sweep --path agent.modelDown --bars <文件>`，文件内容 `{"agent":{"down":0.95}}`。每格是 `fit` 6 例里对的例数和对应的条。调整集上的分数，取舍都在这些用例上做。

### submit

| 取值 | `up` | `upHigh` | `down` | `yes` |
| --- | --- | --- | --- | --- |
| 0.50 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.55 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.60 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.65 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.70 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.75 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.80 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.85 | 6 ██████ | 6 ██████ | 5 █████ | 6 ██████ |
| 0.90 | 6 ██████ | 6 ██████ | 5 █████ | 5 █████ |
| 0.95 | 6 ██████ | 6 ██████ | 5 █████ | 4 ████ |

| 取值 | `no` |
| --- | --- |
| 0.05 | 6 ██████ |
| 0.10 | 6 ██████ |
| 0.15 | 6 ██████ |
| 0.20 | 6 ██████ |
| 0.25 | 6 ██████ |
| 0.30 | 6 ██████ |
| 0.35 | 6 ██████ |
| 0.40 | 6 ██████ |
| 0.45 | 6 ██████ |
| 0.50 | 6 ██████ |

### midrun

| 取值 | `up` | `upHigh` | `down` | `yes` |
| --- | --- | --- | --- | --- |
| 0.50 | 6 ██████ | 6 ██████ | 5 █████ | 6 ██████ |
| 0.55 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.60 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.65 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.70 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.75 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.80 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.85 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.90 | 6 ██████ | 6 ██████ | 6 ██████ | 6 ██████ |
| 0.95 | 6 ██████ | 6 ██████ | 6 ██████ | 5 █████ |

| 取值 | `no` |
| --- | --- |
| 0.05 | 6 ██████ |
| 0.10 | 6 ██████ |
| 0.15 | 6 ██████ |
| 0.20 | 6 ██████ |
| 0.25 | 6 ██████ |
| 0.30 | 6 ██████ |
| 0.35 | 6 ██████ |
| 0.40 | 6 ██████ |
| 0.45 | 6 ██████ |
| 0.50 | 6 ██████ |

### agent

| 取值 | `up` | `upHigh` | `down` | `yes` | `modelDown` | `modelDown`（`down` 取 0.95 之后） |
| --- | --- | --- | --- | --- | --- | --- |
| 0.50 | 2 ██ | 2 ██ | 2 ██ | 2 ██ | 3 ███ | 3 ███ |
| 0.55 | 2 ██ | 2 ██ | 2 ██ | 2 ██ | 3 ███ | 3 ███ |
| 0.60 | 2 ██ | 2 ██ | 2 ██ | 2 ██ | 3 ███ | 3 ███ |
| 0.65 | 2 ██ | 2 ██ | 2 ██ | 2 ██ | 3 ███ | 3 ███ |
| 0.70 | 2 ██ | 2 ██ | 2 ██ | 2 ██ | 3 ███ | 3 ███ |
| 0.75 | 2 ██ | 2 ██ | 2 ██ | 2 ██ | 3 ███ | 3 ███ |
| 0.80 | 2 ██ | 2 ██ | 3 ███ | 2 ██ | 2 ██ | 3 ███ |
| 0.85 | 2 ██ | 2 ██ | 3 ███ | 2 ██ | 2 ██ | 3 ███ |
| 0.90 | 2 ██ | 2 ██ | 3 ███ | 2 ██ | 2 ██ | 3 ███ |
| 0.95 | 2 ██ | 2 ██ | 3 ███ | 2 ██ | 2 ██ | 3 ███ |

| 取值 | `no` |
| --- | --- |
| 0.05 | 2 ██ |
| 0.10 | 2 ██ |
| 0.15 | 2 ██ |
| 0.20 | 2 ██ |
| 0.25 | 2 ██ |
| 0.30 | 2 ██ |
| 0.35 | 2 ██ |
| 0.40 | 2 ██ |
| 0.45 | 2 ██ |
| 0.50 | 2 ██ |

### skill

| 取值 | `action` | `fits` |
| --- | --- | --- |
| 0.10 | 5 █████ | 5 █████ |
| 0.15 | 5 █████ | 5 █████ |
| 0.20 | 5 █████ | 5 █████ |
| 0.25 | 5 █████ | 5 █████ |
| 0.30 | 5 █████ | 5 █████ |
| 0.35 | 5 █████ | 5 █████ |
| 0.40 | 5 █████ | 5 █████ |
| 0.45 | 5 █████ | 5 █████ |
| 0.50 | 5 █████ | 5 █████ |
| 0.55 | 5 █████ | 5 █████ |
| 0.60 | 5 █████ | 5 █████ |

| 取值 | `named` |
| --- | --- |
| 0.30 | 5 █████ |
| 0.35 | 5 █████ |
| 0.40 | 5 █████ |
| 0.45 | 5 █████ |
| 0.50 | 5 █████ |
| 0.55 | 5 █████ |
| 0.60 | 5 █████ |
| 0.65 | 5 █████ |
| 0.70 | 5 █████ |
| 0.75 | 5 █████ |
| 0.80 | 5 █████ |

### 每个门槛的结论

| 门槛 | 对得最多的那一段（`fit` 6 例里对的） | 初值 | 只按 A3 会取 | 结论 |
| --- | --- | --- | --- | --- |
| submit.up | 0.50–0.95（6），整个网格 | 0.70 | 0.95 | 留初值，没有依据（A14） |
| submit.upHigh | 0.50–0.95（6），整个网格 | 0.80 | 0.95 | 留初值，没有依据（A14） |
| submit.down | 0.50–0.80（6），0.85 起 5 | 0.70 | 0.80 | 初值在段内，留（A15） |
| submit.yes | 0.50–0.85（6），0.90 起 5、4 | 0.70 | 0.85 | 初值在段内，留（A15） |
| submit.no | 0.05–0.50（6），整个网格 | 0.30 | 0.05 | 留初值，没有依据（A14） |
| midrun.up | 0.50–0.95（6），整个网格 | 0.70 | 0.95 | 留初值，没有依据（A14） |
| midrun.upHigh | 0.50–0.95（6），整个网格 | 0.80 | 0.95 | 留初值，没有依据（A14） |
| midrun.down | 0.55–0.95（6），0.50 是 5 | 0.70 | 0.95 | 初值在段内，留（A15） |
| midrun.yes | 0.50–0.90（6），0.95 是 5 | 0.70 | 0.90 | 初值在段内，留（A15） |
| midrun.no | 0.05–0.50（6），整个网格 | 0.30 | 0.05 | 留初值，没有依据（A14） |
| agent.up | 0.50–0.95（2），整个网格 | 0.70 | 0.95 | 留初值，没有依据（A14） |
| agent.upHigh | 0.50–0.95（2），整个网格 | 0.80 | 0.95 | 留初值，没有依据（A14） |
| agent.down | 0.80–0.95（3），0.50–0.75 是 2 | 0.70 | 0.95 | 初值在段外，取 **0.95**（A3） |
| agent.yes | 0.50–0.95（2），整个网格 | 0.70 | 0.95 | 留初值，没有依据（A14） |
| agent.no | 0.05–0.50（2），整个网格 | 0.30 | 0.05 | 留初值，没有依据（A14） |
| agent.modelDown | 单独扫 0.50–0.75（3），0.80 起 2；`down` 取 0.95 之后 0.50–0.95（3），整个网格 | 0.80 | 单独扫 0.75 | 先后取（C39）：留初值，没有依据（A14） |
| skill.action | 0.10–0.60（5），整个网格 | 0.30 | 0.60 | 留初值，没有依据（A14） |
| skill.named | 0.30–0.80（5），整个网格 | 0.50 | 0.80 | 留初值，没有依据（A14） |
| skill.fits | 0.10–0.60（5），整个网格 | 0.30 | 0.60 | 留初值，没有依据（A14） |

- 19 个门槛里 13 个单独扫就没有用例卡得住（A14）；`agent.modelDown` 在 `agent.down` 取 0.95 之后也没有（A14，C39）；4 个初值在最好的那一段里（A15）；只有 `agent.down` 挪了（13 + 1 + 4 + 1 = 19）。`sweep` 现在在「conservative end」那一行之后另打一行按 A14、A15、A3 取的值（只动这一个门槛时）：19 个里除 `agent.down`（0.95）和单独扫的 `agent.modelDown`（0.75，先后取之后是 0.80，见下）以外都是初值。A3 里「`yes` 减 `no` 小于 0.2 时两个都留初值」这一条没有用上（`yes`、`no` 都留在初值，差 0.4）。
- `agent.down`：卡住它的是 agent-01（继承 xhigh，期望 medium）。mod 形式的请求里它的 `open` 第 0 档 0.775（3 遍 0.775–0.793），降档门槛在 0.80 以上时停在 medium，0.75 以下一路降到 low。
- `agent.modelDown`（C39）：两个门槛先后取，先 `agent.down` 再 `agent.modelDown`。单独扫时 `modelDown` 在 0.75 以下多对的是 agent-03（第 0、1 档的和 0.796，见「请求改成 mod 实际发的」一节）；`down` 取 0.95 之后再扫，0.75 以下 agent-03 变对、agent-01 换到 haiku 变错，整个网格都是 3 例，按 A14 留 0.80。两个一起挪（`down` 0.95、`modelDown` 0.75）`fit` 仍是 3 例，并且 agent-01 换到 haiku（wrong-model），agent-02、agent-03 的 3 遍变得不稳定（命令：`score --set fit --bars <文件>`、`stability --set tune --bars <文件>`，文件内容 `{"agent":{"down":0.95,"modelDown":0.75}}`）。反过来的顺序（先 `modelDown` 0.75，再扫 `down`：整个网格都是 3 例，留 0.70）`fit` 也是 3 例、`check` 也是 4/4，但同样让 agent-02、agent-03 不稳定（文件内容 `{"agent":{"modelDown":0.75}}`）。在调整集上两种顺序对的例数相同，取哪一个是看过表之后定的。
- `check` 上核对（R-门槛）：取定的门槛下 `check` 是 submit 3/4、midrun 4/4、agent 4/4、skill 4/4，和起步值下一样，没有少对，不触发「保留初值」。

### 取定的门槛

| 类别 | `up` | `upHigh` | `down` | `yes` | `no` | `modelDown` |
| --- | --- | --- | --- | --- | --- | --- |
| submit | 0.7 | 0.8 | 0.7 | 0.7 | 0.3 | 0.8 |
| midrun | 0.7 | 0.8 | 0.7 | 0.7 | 0.3 | 0.8 |
| agent | 0.7 | 0.8 | **0.95** | 0.7 | 0.3 | 0.8 |

skill：`action` 0.3、`named` 0.5、`fits` 0.3（都是初值）。只对 Drex `drex-max-v1.1`；别的后端和模型仍用起步值。

### 调整集在取定的门槛下

命令：`node dispatch-pilot/eval/run.ts score --set fit`、`--set check`、`--set tune`（runner 的 `score`、`stability` 默认用取定的门槛；起步值加 `--bars start`）。调整集上的分数，取舍都在这些用例上做。

| 类别 | `fit` 6 例 | `check` 4 例 | 调整集 10 例 | 错的按标记 | 起步值下的调整集 |
| --- | --- | --- | --- | --- | --- |
| submit | 6 | 3 | 9 | under 1（submit-12） | 9 |
| midrun | 6 | 4 | 10 | — | 10 |
| agent | 3 | 4 | 7 | under 2（agent-02、agent-09），wrong-model 1（agent-03） | 6 |
| skill | 5 | 4 | 9 | wrong-skill 1（skill-09） | 9 |

合计 40 例里 35 例对（起步值下 34 例；差的就是 agent-01）。按来源：取自真实会话的 16 例里对 13 例，模型写的 24 例里对 22 例。

还错的（概率是第 1 遍的）：

- **submit-12**（`check`，模型写的）：要 max，得到 high。`open` 的第 4 档 0.764，从 medium 往上，高于 high 的和 0.783，没到升到 xhigh 要的 0.8；第 2 遍是 0.801，升到了 xhigh，所以 3 遍不稳定。它在 `check`，扫门槛不用它。
- **agent-02**（`fit`，真实）：只读的审查派发，继承 low。`open` = [0.624, 0.276, 0.065, 0.028, 0.007]，高于 low 的和 0.376，网格里没有哪个升档门槛能让它升；第 0、1 档的和 0.900 过了 0.8，模型往下换到 sonnet。是读法，不是门槛。
- **agent-09**（`fit`，真实）：只读的评判派发，继承 medium。高于 medium 的和 0.282，升不上去；模型 opus 是对的。
- **agent-03**（`fit`，模型写的）：档位对，模型差一点：第 0、1 档的和 0.796，没到 0.8（见上面 C39）。
- **skill-09**（`fit`，真实）：原因同「基线」一节，两个候选的说明重叠，门槛救不了它。

### 稳定性（修订 A13）

命令：`node dispatch-pilot/eval/run.ts stability --set tune --bars start`（起步值）、`stability --set tune`（取定的门槛）。

- 起步值下（扫门槛之前判的那一次）：40 例都问了 3 遍，2 例决定不一样：submit-12（high、xhigh、high；都低了）、midrun-11（low、low、medium；都可接受）。都在 `check`，扫门槛时没有要去掉的用例。
- 取定的门槛下（判第二次，不重扫）：同样是这 2 例。

### 中途无谓换挡的比例

每个检查点都判一次（`midrunEveryScripts` 为 1）时，调整集 midrun 里期望保持的 5 例（midrun-01、05、09、12、13）没有一例标 `needless-shift`：0/5，3 遍都是如此（这 5 例 3 遍决定都一样）。命令：`score --set tune`、`stability --set tune`。调整集上的分数，取舍都在这些用例上做。

## 留出集之前定下的（Task 14 Step 1）

这一节在留出集的请求发出之前提交（commit a60fd6f），下面是当时的原文，没有改动。

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

## 留出集（Task 14）

### 请求

- 只发了一次：`node dispatch-pilot/eval/run.ts ask --set heldout --final`，2026-11-19 UTC 12:33:45–12:34:15（约 30 秒，最多同时 4 个）。发之前，「留出集之前定下的」一节已经提交。
- 164 个请求，失败 0 个，回答的 `model` 都是 `drex-max-v1.1`；单个请求中位数 528 ms，最长 2225 ms；估算 706,473 token（发之前 `plan` 估的是 164 个、约 0.72M）。
- 组成：最终配置每例 3 遍——submit、midrun、agent 各 15 个，skill 第一次请求 12 个、第二次请求 15 个（skill-14 和 submit-15 是同一句话，skill-14 的第一次请求就是 submit-15 的请求，共用回答）；观察用的给法各 1 遍——`with-controls` 15、`direct-shuffled` 15、`open-b` 15、`with-skills` 5、`no-previous` 3、`progress-before` 4、`progress-after` 5、`recent-1`、`recent-3`、`recent-1-with-controls`、`recent-3-with-controls`、`no-stated-next-with-controls` 各 2、`stage-1-alone`、`stage-2-alone`、`stage-1-shuffled`、`stage-2-shuffled` 各 5。和默认相同的请求不另发（例如只有一条 `recent` 的用例取 1 条、3 条都和默认相同）。
- 整个校准到这里一共 645 个请求、2,747,487 token（估算），上限是 2000 个、3000 万。

### 最终配置下每类的对错

最终配置就是「留出集之前定下的」一节写的那一套（mod 形式的请求、C38、取定的门槛），判分用 3 遍里的第 1 遍。命令：`node dispatch-pilot/eval/run.ts score --set heldout`；最后一列是起步门槛，`score --set heldout --bars start`。

| 编号 | 来源 | 期望 | 最终配置 | 起步门槛 |
| --- | --- | --- | --- | --- |
| submit-06 | 真实 | high | medium under | medium under |
| submit-07 | 真实 | medium | medium right | medium right |
| submit-08 | 真实 | low | medium over | medium over |
| submit-14 | 真实 | low/medium | medium right | medium right |
| submit-15 | 真实 | high | high right | high right |
| midrun-06 | 真实 | hold low | low right | low right |
| midrun-07 | 真实 | hold high | high right | high right |
| midrun-08 | 真实 | down low | high missed-shift | high missed-shift |
| midrun-14 | 真实 | hold xhigh | xhigh right | xhigh right |
| midrun-15 | 真实 | down low | medium over | medium over |
| agent-06 | 补写 | xhigh · opus | high · opus under | high · opus under |
| agent-07 | 补写 | medium/high · sonnet | high · sonnet right | medium · sonnet right |
| agent-08 | 补写 | low · sonnet | medium · sonnet over | low · sonnet right |
| agent-14 | 补写 | low · haiku/sonnet | medium · haiku over | low · haiku right |
| agent-15 | 补写 | high · opus | high · opus right | high · opus right |
| skill-06 | 真实 | （两个 skill 之一） | 同期望 right | 同期望 right |
| skill-07 | 真实 | 无 | 无 right | 无 right |
| skill-08 | 补写 | domain-modeling | domain-modeling right | domain-modeling right |
| skill-14 | 真实 | （一个 skill） | 同期望 right | 同期望 right |
| skill-15 | 真实 | 无 | 一个 skill needless-skill | 一个 skill needless-skill |

| 类别 | 留出 5 例里对的（取自真实会话 / 补写） | 调整集 10 例 | 错的按标记 |
| --- | --- | --- | --- |
| submit | 3（3/5 / —） | 9 | under 1（submit-06），over 1（submit-08） |
| midrun | 3（3/5 / —） | 10 | missed-shift 1（midrun-08），over 1（midrun-15） |
| agent | 2（— / 2/5） | 7 | under 1（agent-06），over 2（agent-08、agent-14） |
| skill | 4（3/4 / 1/1） | 9 | needless-skill 1（skill-15） |
| 合计 | 12/20（真实 9/14，补写 3/6） | 35/40（真实 13/16，补写 22/24） | |

和调整集比：调整集 40 例里对 35 例（87.5%），留出集 20 例里对 12 例（60%）；每类都更低（submit 3/5 比 9/10，midrun 3/5 比 10/10，agent 2/5 比 7/10，skill 4/5 比 9/10）。留出集一例就是 20 个百分点，但四类都低、合计差 27.5 个百分点，这是明显的差。调整集里没有出现的标记这里出现了：`over`（档位高了）4 例，调整集在最终配置下一例都没有。

midrun 里期望保持的 3 例（midrun-06、07、14）没有一例标 `needless-shift`（0/3）。

### 不稳定的用例

命令：`node dispatch-pilot/eval/run.ts stability --set heldout`（起步门槛下加 `--bars start`，结果相同）。20 例都问了 3 遍，决定不一样的 1 例：submit-14（medium、low、medium；两种都可接受），低于 medium 的概率 3 遍是 0.672、0.745、0.656，在降档门槛 0.7 的两边。skill 打乱候选顺序之后（`stage-1-shuffled` 加 `stage-2-shuffled`），5 例的决定都没变，没有要单独列出的用例。

### 错的用例，逐个（第 1 遍的概率；括号里是 3 遍的范围）

- **submit-06**（真实，没有上一轮）：要 high，得到 medium。从 medium 往上，高于 medium 的概率和 0.501（0.501–0.527），没到升档门槛 0.7；`unknown_cause` 0.400，在中间带，不把档位托到 high。`open` 的概率分得很散（第 0 档 0.238、第 1 档 0.261、第 3 档 0.342）。
- **submit-08**（真实，没有上一轮）：要 low，得到 medium。low 一档 0.599（0.599–0.615），没到降档门槛 0.7；`mechanical` 0.673，也没到「是」的 0.7。带对照题的旧请求里 low 一档是 0.741，就降到了 low。
- **midrun-08**（真实，当前 high）：要降到 low，没换挡。低于 high 的概率和 0.607（0.516–0.607），没到降档门槛 0.7；降档还要「原因找到了」或「只剩照着做」读成「是」，`only_carrying_out` 0.663、`cause_found` 0.317，都没到。
- **midrun-15**（真实，当前 high）：要降到 low，降到 medium。低于 high 的和 0.928，降一档；low 一档 0.577（0.535–0.577），没到 0.7，停在 medium；`cause_found` 0.994 允许降。
- **agent-06**（补写，继承 medium、opus）：要 xhigh，得到 high。高于 medium 的和 0.822，升到 high；xhigh 及以上的和 0.620（0.620–0.688），没到升到 xhigh 要的 0.8。模型 opus 是对的。
- **agent-08**（补写，继承 high、opus）：要 low，得到 medium。low、medium 两档的和 0.967，过了取定的降档门槛 0.95，降到 medium；low 一档 0.889（0.872–0.895），没到 0.95，停在 medium（起步值 0.7 下降到 low，对）。模型 sonnet 是对的。
- **agent-14**（补写，继承 high、opus）：要 low，得到 medium。low 一档 0.905（0.891–0.920），没到 0.95（起步值下降到 low，对）。模型 haiku 在可接受的范围里（`read_only` 0.996、`mechanical` 0.954，换到最便宜的）。
- **skill-15**（真实，期望不推荐）：推荐了一个 skill。第一次请求的三道动手题均值 0.494（0.468–0.494），过了 `action` 的 0.30；第二次请求的 choice 选了短名单里的一个（0.432），它的 `fits` 0.898。

### 观察用的给法（各 1 遍，取定的门槛下；不改任何配置）

命令：`node dispatch-pilot/eval/run.ts score --set heldout --variant <给法>`，起步门槛加 `--bars start`。默认（最终配置）是 submit 3、midrun 3、agent 2、skill 4（各 5 例）。

- `with-controls`（旧请求，带两道对照题）：submit 4、midrun 3、agent 2（起步门槛下 4）。和默认不同的：submit-08 medium → low（变对），submit-14 medium → low（都可接受）。
- `with-controls` 按 `--form direct` 读（直接选档位）：submit 3、midrun 3、agent 5，合计 11/15，默认是 8/15（起步门槛下一样）。调整集上它三类都少对（7、8、6 比 9、10、7），R-问法 判了不换。
- `with-controls` 按 `--long-unattended` 读：submit 4、agent 2，和 `with-controls` 相同；agent-08、agent-14 抬到 high，仍是 over。
- `no-previous`（不带上一轮，带对照题；3 个不同的请求）：submit 4，决定和 `with-controls` 完全相同。
- `with-skills`（对照题加 skill 题）：submit 4，决定和 `with-controls` 完全相同。
- `recent-1`、`recent-3`（mod 形式；各 2 个不同的请求）：midrun 都是 3，决定和默认相同。`recent-1-with-controls`、`recent-3-with-controls`：都是 3，比 `with-controls` 多一例变化（midrun-15 从 medium over 变成 high missed-shift）；`no-stated-next-with-controls`：3，和 `with-controls` 相同。
- `progress-before`：midrun 3，midrun-15 从 medium over 变成 high missed-shift（低于 high 的和 0.928 → 0.566）。`progress-after`：3，决定和默认相同（midrun-08 高于 high 的和 0.244 → 0.627，离参考答案更远，没有跨门槛）。
- `open-b`：submit 4、midrun 3、agent 2（起步门槛下 4）。和默认不同的：submit-08 medium → low（变对），submit-14 medium → low（都可接受），agent-06 high → medium（仍低了）。
- `direct-shuffled`（只打乱 `direct` 的选项，按默认问法读）：submit 3、midrun 3、agent 1（起步门槛下 4）；和只差选项顺序的 `with-controls` 比，4 例的决定变了（submit-08、submit-14、midrun-15、agent-07）。按 `--form direct` 读：submit 3、midrun 3、agent 4，和 `with-controls` 的 direct 比 3 例变了（midrun-08、midrun-14、agent-06）。同一请求里一道题的选项顺序移动别的题的回答，留出集上又出现了一次。
- `stage-1-alone` 加 `stage-2-alone`（skill 题单独问）：skill 4，决定和默认相同。`stage-1-shuffled` 加 `stage-2-shuffled`（打乱候选顺序）：4，决定和默认相同。

### 起步门槛和取定的门槛

命令：`score --set heldout`（取定的）、`score --set heldout --bars start`（起步值）。

| 类别 | 取定的门槛 | 起步门槛 |
| --- | --- | --- |
| submit | 3 | 3 |
| midrun | 3 | 3 |
| agent | 2 | 4 |
| skill | 4 | 4 |
| 合计 | 12/20 | 14/20 |

调整集挪动的唯一一个门槛 `agent.down`（0.70 → 0.95）在留出集上少对 2 例：agent-08、agent-14 都要 low，停在 medium（low 一档 0.889、0.905，过了 0.7，没到 0.95）。另有 agent-07 从 medium 变成 high，两种都可接受。调整集上它多对 1 例（agent-01）。

按修订 A1，留出集的结果不改任何配置，这里没有改。controller 建议把 `agent.down` 退回 0.70；计划在修订 A1 之前的原规则（Task 14 Step 5：门槛在留出集上比初值少对 2 例及以上的，退回初值）正好会这样做。由用户定。

### 留出集看不出的事

- 「留出集之前定下的」一节写下的：中途换挡的留出集没有升档的例子；submit 的留出集没有要 xhigh 或 max 的例子，5 例里 3 例是同一段对话相邻的三轮；派 agent 的留出集 5 例都是补写的，取自真实会话的派发一例也没有。
- 没有候选 skill 时 mod 发的请求（只有档位题：每个会话的第一条消息、`skills` 关着时的每条消息）留出集没有问过；它只在留出集之后在调整集上观察过（`first-message`，Ruling C41，见「请求改成 mod 实际发的」一节最后）。留出集 submit 里没有上一轮的 2 例（submit-06、08，两例都错）在 mod 里正是这种请求，留出集问的却是带 skill 题的那一种。
- 另外几件：留出集 20 例里 9 例出自同一个会话；skill-14 和 submit-15 是同一句话，共用一个请求；C38（续做的消息沿用上一轮的档位）在留出集上一次也没起作用（有上一轮的 3 例 `continues` 都没读成「是」）；skill 的留出集里没有正确候选缺说明的正例。

### 哪些数是公平的测试

照 S16、S18、S20：措辞、问法、上下文、续做规则和门槛都是在调整集上挑的，**这份记录里调整集上的所有数（包括最终配置的 35/40）都不是公平的测试**，只说明这些取舍在挑它们的用例上的样子。公平的测试只有一组：**留出集在最终配置下的第 1 遍，12/20**（submit 3/5、midrun 3/5、agent 2/5、skill 4/5），它没有参与任何取舍。

观察用的给法在留出集上的数也没有参与取舍，但它们都已经在调整集上判过不用；要是现在按留出集上的数改用其中一种（例如直接选档位在 agent 上 5/5），或者因为上面的数把 `agent.down` 退回 0.70，留出集就参与了取舍，它的数从那以后也不再是公平的测试（S18），再要一个公平的数只能另找没用过的用例。

## 验收：中途换挡在真实任务上（Task 15）

这一节回答设计第 8 节「中途换挡的验收」的第二层：在真实任务上，开着中途换挡和关着相比，这一轮的结果（做对没有、步数、token）有没有分别。第一层（换挡发没发出去）看会话自己的记录里每次请求实际带的档位，单独列在后面。

### 跑了什么

- 任务：6 个模型写的小项目（`dispatch-pilot/eval/accept/tasks/01` 到 `06`），每个一条提示词、一个判对错的 `check.sh`。按设计各两个：「卡住」（01、02，`meta.json` 里期望的换挡方向 `up`）、「先难后机械」（03、04，期望 `down`）、「平稳」（05、06，期望 `none`）。任务不依赖网络，不含任何真实项目的内容。
- 次数：16 次 = 8 对。6 个任务在 Code Mode 会话里各跑一对（开、关各 1 次），另有 01（卡住）和 03（先难后机械）在普通会话里各跑一对。计划原定 28 次（6 个任务 × 两组 × 2 遍 Code Mode，加 2 个任务 × 两组 × 1 遍普通会话），用户为了快减到 16 次，每格只跑 1 次；判定规则在跑之前按 8 对定下（controller 的 Ruling C31，见下）。
- 两组的差别只有 `midrunShift` 一个设置，发消息定档两组都开着。每一对的第一档（发消息时定的档）两组相同，见下表。
- 主模型：Sonnet 5.5（两组相同）。决策模型：Drex `drex-max-v1.1`。
- 跑法：`node dispatch-pilot/eval/accept/run.ts --task <编号> --arm on|off --mode code|ordinary`，每次是一个新的交互会话（tmux 里，`--plugin-dir` 加载本 mod，临时设置文件按组开关 `midrunShift`、按模式开关 Code Mode，不开 OpenTelemetry），任务的 `project/` 复制到一个新的临时目录，发提示词，等这一轮结束，跑 `check.sh`，从会话自己的记录读用量和档位，然后删掉会话、设置文件和目录。
- mod 是最终配置：请求和 mod 实际发的相同（修订 A16），带 Ruling C38（续做的消息沿用上一轮的档），门槛是 Task 13 取定的那一组。
- 并发：8 个同时跑（用户定的，偏离了修订 A12 原定的 2 个；每一波开始前看过空闲内存，68% 到 71%），同一个任务的两组在同一波里。2026-11-19（UTC）两波：第一波 12:34–12:36 开始，Code Mode 的 01 到 04；第二波 12:38–12:39 开始，Code Mode 的 05、06 和普通会话的 01、03。每次 1 到 2 分钟。
- 数据：私有数据目录里的 `accept.jsonl`，16 行。`steps` 是主循环发给主模型的请求数（Code Mode 里一步可以是一个带多次工具调用的脚本）；`inputTokens` 含写入缓存的输入；用量只数主循环，不含 mod 发给决策模型的请求，也不含子 agent。`levelsSent` 是主循环每次请求实际带的 effort，按顺序、连续相同的并成一个；`shifts` 是它变了几次。两者都从会话自己的记录读出（`eval/accept/lib/records.ts` 的 `levelsOf`）。行里另有一个 `midrunDecisions` 字段，它来自 mod 的 store，多个会话同时跑时分不清是哪个会话的（试跑时关着的一组也数出了 3），这里不用。

下文的数字都可以重算：在仓库根目录，`DATA` 设为私有数据目录（`run.ts` 的 `--data`，默认值见 `run.ts` 开头），运行每张表旁边的命令。命令只读 `accept.jsonl`，不起会话、不发请求。

### 逐次

命令：`node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n")) console.log(l)' "$DATA/accept.jsonl"`（逐行原样输出；类型和期望方向取自各任务的 `meta.json`）。

| 任务 | 类型 | 期望方向 | 模式 | 中途换挡 | 结果 | 步数 | 输入 token | 输出 token | 读缓存 token | 一轮用时（秒） | 实际发出的档位 | 换挡次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | 卡住 | `up` | Code Mode | 开 | 通过 | 5 | 26,532 | 2,861 | 154,012 | 48.6 | high → medium | 1 |
| 01 | 卡住 | `up` | Code Mode | 关 | 通过 | 6 | 24,317 | 2,617 | 188,962 | 56.2 | high | 0 |
| 02 | 卡住 | `up` | Code Mode | 开 | 通过 | 5 | 24,411 | 2,244 | 152,245 | 62.1 | high → medium | 1 |
| 02 | 卡住 | `up` | Code Mode | 关 | 通过 | 5 | 21,876 | 2,580 | 153,600 | 49.6 | high | 0 |
| 03 | 先难后机械 | `down` | Code Mode | 开 | 通过 | 6 | 38,291 | 8,067 | 216,150 | 87.6 | high → medium | 1 |
| 03 | 先难后机械 | `down` | Code Mode | 关 | 通过 | 8 | 36,576 | 8,040 | 284,334 | 92.1 | high | 0 |
| 04 | 先难后机械 | `down` | Code Mode | 开 | 通过 | 9 | 39,389 | 5,134 | 358,428 | 90.2 | xhigh → medium | 1 |
| 04 | 先难后机械 | `down` | Code Mode | 关 | 通过 | 6 | 48,778 | 7,270 | 242,301 | 94.6 | xhigh | 0 |
| 05 | 平稳 | `none` | Code Mode | 开 | 通过 | 7 | 25,277 | 5,514 | 232,886 | 79.4 | medium | 0 |
| 05 | 平稳 | `none` | Code Mode | 关 | 通过 | 4 | 23,439 | 4,921 | 113,549 | 62.4 | medium | 0 |
| 06 | 平稳 | `none` | Code Mode | 开 | 通过 | 4 | 23,773 | 5,060 | 107,446 | 60.0 | medium | 0 |
| 06 | 平稳 | `none` | Code Mode | 关 | 通过 | 7 | 26,131 | 5,428 | 224,897 | 83.1 | medium | 0 |
| 01 | 卡住 | `up` | 普通 | 开 | 通过 | 8 | 31,954 | 3,089 | 435,874 | 54.0 | high → medium | 1 |
| 01 | 卡住 | `up` | 普通 | 关 | 通过 | 10 | 32,320 | 4,135 | 584,268 | 67.5 | high | 0 |
| 03 | 先难后机械 | `down` | 普通 | 开 | 通过 | 9 | 41,106 | 9,442 | 513,665 | 102.6 | high → medium | 1 |
| 03 | 先难后机械 | `down` | 普通 | 关 | 通过 | 8 | 41,538 | 8,540 | 473,169 | 99.0 | high | 0 |

### 每对的对照

命令：

```
node -e 'const r=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const t3=x=>x.usage.inputTokens+x.usage.outputTokens+x.usage.cacheReadTokens,t2=x=>x.usage.inputTokens+x.usage.outputTokens;for(const on of r.filter(x=>x.arm==="on")){const off=r.find(x=>x.arm==="off"&&x.task===on.task&&x.mode===on.mode);console.log(on.task,on.mode,on.pass,off.pass,t3(on),t3(off),(100*(t3(on)/t3(off)-1)).toFixed(1),t2(on),t2(off),(100*(t2(on)/t2(off)-1)).toFixed(1),on.levelsSent.join(">"),off.levelsSent.join(">"))}' "$DATA/accept.jsonl"
```

每格写「开 / 关」。「总 token」是输入 + 输出 + 读缓存；差值是开着的一组比关着的一组多（+）或少（−）多少。关着的一组每一对都只发了一个档，和开着的一组的第一档相同。

| 任务 | 模式 | 结果 | 步数 | 总 token | 差 | 输入 + 输出 | 差 | 用时（秒） | 开着的一组发出的档位 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Code Mode | 通过 / 通过 | 5 / 6 | 183,405 / 215,896 | -15.0% | 29,393 / 26,934 | +9.1% | 48.6 / 56.2 | high→medium |
| 02 | Code Mode | 通过 / 通过 | 5 / 5 | 178,900 / 178,056 | +0.5% | 26,655 / 24,456 | +9.0% | 62.1 / 49.6 | high→medium |
| 03 | Code Mode | 通过 / 通过 | 6 / 8 | 262,508 / 328,950 | -20.2% | 46,358 / 44,616 | +3.9% | 87.6 / 92.1 | high→medium |
| 04 | Code Mode | 通过 / 通过 | 9 / 6 | 402,951 / 298,349 | +35.1% | 44,523 / 56,048 | -20.6% | 90.2 / 94.6 | xhigh→medium |
| 05 | Code Mode | 通过 / 通过 | 7 / 4 | 263,677 / 141,909 | +85.8% | 30,791 / 28,360 | +8.6% | 79.4 / 62.4 | medium |
| 06 | Code Mode | 通过 / 通过 | 4 / 7 | 136,279 / 256,456 | -46.9% | 28,833 / 31,559 | -8.6% | 60.0 / 83.1 | medium |
| 01 | 普通 | 通过 / 通过 | 8 / 10 | 470,917 / 620,723 | -24.1% | 35,043 / 36,455 | -3.9% | 54.0 / 67.5 | high→medium |
| 03 | 普通 | 通过 / 通过 | 9 / 8 | 564,213 / 523,247 | +7.8% | 50,548 / 50,078 | +0.9% | 102.6 / 99.0 | high→medium |

8 对里，总 token 开着的一组少的 4 对、多的 4 对；只算输入 + 输出，少的 3 对、多的 5 对。

### 按 R-验收 判定（Ruling C31）

跑之前定下的规则（C31，把计划的 R-验收 从 14 对改成这 8 对，形式不变）：开着中途换挡的一组比关着的一组多通过至少 2 次，或者通过次数相同而总 token 的中位数低 15% 及以上，写「看得出」；否则写「看不出」，停下，由用户定。

命令：

```
node -e 'const r=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const m=a=>{a=[...a].sort((x,y)=>x-y);const n=a.length;return n%2?a[n>>1]:(a[n/2-1]+a[n/2])/2};const t3=x=>x.usage.inputTokens+x.usage.outputTokens+x.usage.cacheReadTokens,t2=x=>x.usage.inputTokens+x.usage.outputTokens;const s={};for(const a of["on","off"]){const g=r.filter(x=>x.arm===a);s[a]=[g.filter(x=>x.pass).length,g.length,m(g.map(t3)),m(g.map(t2))];console.log(a,...s[a])}console.log("lower by %",(100*(1-s.on[2]/s.off[2])).toFixed(1),(100*(1-s.on[3]/s.off[3])).toFixed(1))' "$DATA/accept.jsonl"
```

1. 通过次数：开着 8 次里通过 8 次，关着 8 次里通过 8 次。多通过 0 次，不到 2 次，第一个条件不成立。
2. 通过次数相同，看总 token 的中位数（每组 8 次，中位数是第 4、5 个的平均）：
   - 输入 + 输出 + 读缓存：开着 263,092.5，关着 277,402.5，低 5.2%。
   - 只算输入 + 输出：开着 32,917，关着 34,007，低 3.2%。
   - 两种算法都不到 15%，第二个条件不成立。
3. 结论：**看不出。**

另记（不参与判定）：16 次的总和，开着的一组总 token 2,462,850、关着 2,563,586（低 3.9%）；步数 53 和 54；一轮用时合计 584.6 秒和 604.5 秒。

两个「平稳」任务（05、06）两组发出的档位完全相同（都只有 medium，没有换挡），总 token 却一对开着多 85.8%、一对开着少 46.9%。这说明每格只跑一次时，同一任务两次运行之间本来就有这么大的出入，比判定线 15% 大得多；其余几对的差值也在这个范围里。

### 开着的一组：换挡发没发出去

从会话自己的记录读出的实际档位（`levelsSent`），和各任务 `meta.json` 的期望方向对照：

| 任务 | 模式 | 类型 | 期望方向 | 实际发出 | 和期望相符 |
| --- | --- | --- | --- | --- | --- |
| 01 | Code Mode | 卡住 | `up` | high → medium（降） | 否 |
| 02 | Code Mode | 卡住 | `up` | high → medium（降） | 否 |
| 03 | Code Mode | 先难后机械 | `down` | high → medium（降） | 是 |
| 04 | Code Mode | 先难后机械 | `down` | xhigh → medium（降） | 是 |
| 05 | Code Mode | 平稳 | `none` | medium（不换） | 是 |
| 06 | Code Mode | 平稳 | `none` | medium（不换） | 是 |
| 01 | 普通 | 卡住 | `up` | high → medium（降） | 否 |
| 03 | 普通 | 先难后机械 | `down` | high → medium（降） | 是 |

- 8 次里 6 次换了一次挡，全部是降到 medium（5 次从 high，1 次从 xhigh）；两个平稳任务没有换挡。换挡确实发出去了：换挡之后的请求带的就是新档。
- **哪一次都没有升档。** 两种会话都一样。
- 两个「卡住」的任务没有让模型卡住：Sonnet 5.5 在开着的一组里 5、5、8 步做完，关着的一组里 6、5、10 步做完，全部通过。设计时设想的「同一失败在修改后复现」没有拖住这一轮，所以升档的条件没有出现；mod 在这三次里降了档，降档之后照样做对。这三次记作「和期望不符」，是按任务设计时的期望，不等于降错了：模型没有卡住，查明之后剩下的工作也许确实只需要 medium。这份数据里没有每次换挡发生在第几步，判断不了。
- 这些运行能说明的：降档实际发出去了，而且 8 对里没有一次因为中途降档而做错；在两个平稳任务上没有无谓的换挡。不能说明的：升档在真实任务上管不管用（一次都没发生）；降档省没省 token（差别落在两次运行之间本来的出入里）。

### 局限

- 每格只跑 1 次。上面平稳任务的两对表明，单次运行之间 token 的出入可以超过 80%，一次异常的运行就能左右一对的对照。
- 任务都很小：每次 1 到 2 分钟、4 到 10 步。中途换挡要省的是长一轮里后半段的花费，这么短的一轮里能换挡的检查点本来就少。
- 只有一个主模型（Sonnet 5.5）。换了更强或更弱的主模型，卡不卡住、几步做完都可能不同。
- 平稳任务尤其短（4 到 7 步），只能说明短的平稳工作上不会无谓换挡，不能说明长的平稳工作上也不会。
- 两种会话不对称：普通会话只跑了 01、03 两对。
- 正式运行之前的试跑（Task 15 Step 4）只用来检查跑具本身，不计入：第一次试跑两个会话都在 2 秒内退出（信任对话框的默认选项是「不，退出」，跑具按的回车退出了会话），修好之后第二次试跑通过了检查（普通会话确实没有 Code Mode，设置传到了 mod，会话和临时文件都清理干净）。试跑的两对是同一个任务在两种不同模式下各跑一组，本来就不成对，记在另一个文件里，不在上面的表里。

### 交给用户

按计划（Task 15 Step 6），判定是「看不出」就停在这里：中途换挡留不留由用户定，这里不改成别的做法。用户需要的事实：

- 16 次全部通过；开着和关着的总 token 中位数只差 5.2%（只算输入 + 输出差 3.2%），远小于 15% 的判定线，也小于同一任务两次运行之间本来的出入。
- 开着的一组发出了 6 次降档、0 次升档；降档之后没有一次做错，平稳任务上没有无谓的换挡。
- 两个「卡住」的任务没有让 Sonnet 5.5 卡住，所以升档这一半在真实任务上没有被检验过。
- 每格只跑 1 次、任务 1 到 2 分钟、一个主模型：这些运行既不能说明中途换挡有用，也没有显出它有害。

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

- 出题、审查、盲答、裁定都由同一个模型（Fable 5.2，xhigh）做：出题者写参考答案，盲答者只看发出去的内容再答一遍，不一致的交给裁定。60 例里两遍直接一致 48 例，一致但盲答者提了疑问 2 例，重叠（一边一档、一边两档，或一边的模型范围更宽）10 例，相反 0 例；裁定 8 例取盲答者、3 例取出题者、1 例两边各取一部分；最后改了 9 例的参考答案。这是同一个模型答两遍加裁定，不是几家不同模型的合标（S12、S13，修订 A11）。发请求之前，全部 60 例的参考答案列成一张表，在 Task 8 的关口交给用户；用户回答「全部同意」，没有改任何一例，60 例都标为模型标的（`label.by` 是 `model`）；每一例用户是否逐个读过，没有记录。
- 出题和审查多一项 human test：只看发出去的 state 和题能不能答出参考答案，依据必须在 state 里（修订 A6）。
- 派出 agent 的用例：默认配置下 Fable 不当子 agent，继承 fable 的用例「不换便宜的模型」写成 opus（mod 给不出 fable）。
- 中途的真实检查点全部来自 Code Mode 会话，其中只有 6 个的最新一步失败；非 Code Mode 的和大多数「卡住」的用例是补写的。原先整个 midrun 里没有 Code Mode 下该升档的用例，于是把 midrun-10（`fit`，补写）改写成 Code Mode 的。「修过之后还是同一个错误」明确为是的只有 midrun-04（`check`）一例。
- skill：原来没有哪个正例只靠「点名」那道题就能过，`named` 的门槛没有用例卡得住，于是加了一例用户随口点出可用 skill 名字的补写用例（skill-11，`fit`）。三种反例（日常请求、没有 skill 管的技术问题、点名了候选里没有的东西）各至少 1 例（修订 A7）。
- submit：有上一轮的用例里，只有一例期望的档位和上一轮不同；`check` 里没有降一档才对的用例；「接着做」在 `fit` 里由同一会话的两例测，`check` 里另有一例（submit-05）。

留出集看不出的东西（留出集的结果见「留出集」一节，这里只说构成）：

- midrun 的留出 5 例全是真实的 Code Mode 用例：3 例保持、2 例降档、没有升档。留出集的分数看不出漏掉的升档。升档只在 `fit`、`check` 上调；验收（Task 15）里设计了「卡住」的任务，但一次升档也没有发生（见验收一节），所以中途升档在独立的数据上没有被检验过。
- submit 的留出 5 例全是真实的，其中 3 例是同一会话的连续几轮（留出集上 60 个百分点出自一段对话）；没有要 xhigh 或 max 的用例。
- skill 的留出集里，没有正确候选缺说明的正例。
- agent 的留出 5 例全是补写的。

请求本身：

- 第一遍（Task 9 到 Task 11）除 skill 外每种给法的请求都带着两道对照题（`direct`、`long_unattended`），所以各给法只差在 state；mod 实际发的请求没有这两道题。从 Task 10 Step 3 起，`default` 和 mod 发的请求逐题相同，带对照题的请求改名 `with-controls` 等（修订 A16）；submit 的 `default` 是 mod 有候选 skill 时的那一种，没有候选时的那一种（`first-message`）留出集之后才在调整集上问过（Ruling C41）。
- 两种给法构造出完全相同的请求时共用一个回答；从第 2 遍起 state 末尾多一个 `request_uid`，已经顶到 4000 token 上限的 state 会把一个长字段再截短一点（发出去的就是存下来的）。
- midrun-08（留出）的 state 在每种给法里都被 150 token 的截断去掉了三行，出题审查认为答案仍然能从剩下的内容得出。
