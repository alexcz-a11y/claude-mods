# Artificial Analysis 的基准与 Dispatch Pilot 的路由规则（2026-10）

按 Artificial Analysis（下称 AA）Intelligence Index v4.3.2 的数字，校正了 Dispatch Pilot 派出 agent 时的模型选项文字、effort 的取法和中途重判的门槛。这份笔记写下依据、哪条规则用了哪些数字，以及用已存的评测回答离线重算的结果。数字取自 2026-10-05 的抓取，AA 页面会漂移，同一格在不同抓取里偶有 1% 以内的小差；只能和同一版本的分数比（Fable 5.1 在 9 月 1 日发布时按旧版 v4.1 是 66 分，v4.3.2 是 53 分，模型没变）。

## 一、AA 的指数由哪十项组成

v4.3.2 只有这十项（来源：<https://artificialanalysis.ai/methodology/intelligence-benchmarking>，读到了版本史一节）。GPQA Diamond、MMLU-Pro、LiveCodeBench、AIME 2025、tau-bench 都已经移出指数，页面上查不到四个模型在它们上面的分数；AA Coding Index、AA Agentic Index 也没有查到。

| 类别（权重） | 分项 | 权重 |
|---|---|---|
| Agents（30%） | AA-Briefcase v1.1、GDPval-AA v2.1、AutomationBench-AA | 15%、10%、5% |
| Coding（20%） | Terminal-Bench 4.0、SciCode | 各 10% |
| General（30%） | AA-Omniscience、GDP.pdf、AA-LCR v1.1 | 15%、10%、5% |
| Scientific Reasoning（20%） | Humanity's Last Exam、CritPt | 各 10% |

## 二、四个模型各分项（各自最高档；Haiku 取 Reasoning）

| 项 | Haiku 4.5 | Sonnet 5.5 | Opus 5.5 | Fable 5.1 |
|---|---|---|---|---|
| Intelligence Index | 17 | 56 | 58 | 53 |
| Terminal-Bench 4.0 | 0.0% | 63.6% | 59.6% | 52.0% |
| AutomationBench-AA | 3.2% | 71.8% | 69.5% | 59.4% |
| AA-Briefcase / GDPval-AA（Elo） | 614 / 735 | 1823 / 1839 | 1807 / 1866 | 1676 / 1758 |
| SciCode | 42.2% | 61.0% | 66.9% | 63.1% |
| Humanity's Last Exam | 10.4% | 55.0% | 61.4% | 59.1% |
| AA-Omniscience（指数） | -4 | 32 | 46 | 43 |
| AA-LCR | 74.3% | 82.7% | 84.7% | 85.3% |
| 价格 input / output（美元每百万 token） | 1 / 5 | 2 / 10 | 4 / 20 | 10 / 50 |
| 每个指数任务的成本 | $0.28 | $7.67 | $5.98 | $7.63 |

AA 的所有 Anthropic 条目都是「default fallback」配置，被安全分类器拦下的请求会路由到别的模型；Haiku 4.5 只有 Reasoning 和 Non-reasoning 两个条目，没有 effort 档。

## 三、effort 档的影响（Sonnet 5.5 和 Opus 5.5，指数和三个分项）

| 档 | Sonnet 5.5 指数 / Terminal-Bench / HLE | Opus 5.5 指数 / Terminal-Bench / HLE |
|---|---|---|
| low | 36 / 20.7% / 36.2% | 42 / 31.3% / 48.3% |
| medium | 41 / 29.8% / 39.8% | 51 / 52.5% / 54.7% |
| high | 47 / 43.9% / 45.8% | 54 / 56.6% / 55.6% |
| xhigh | 52 / 57.1% / 50.0% | 56 / 59.6% / 57.5% |
| max | 56 / 63.6% / 55.0% | 58 / 59.6% / 61.4% |

Sonnet 5.5 对 effort 极敏感（Terminal-Bench 从 low 到 high 差 23 个点），Opus 5.5 在 medium 就已经有 51。Fable 5.1 的下限最高（low 就有 47），上限 53 却被 Opus 5.5 的 high（54）超过。

## 四、规则怎么用这些数字

- **模型选项文字**（`hooks/decision/dispatched-agent.ts` 的 `KINDS`）：
  - Haiku 与 Sonnet 之间差距最大：Terminal-Bench 0% 对 63.6%，AutomationBench 3.2% 对 71.8%，HLE 10.4% 对 55.0%。所以 haiku 只做一两步就能跑完的只读查找（结果只需要收集起来并按要求排版），连续很多步的探查、写入和判断都不给它。
  - Sonnet 与 Opus 之间大多数工作差距在误差内（终端、自动化、知识工作上 Sonnet 持平或略高），拉开的是事实知识（Omniscience 32 对 46，Sonnet 的幻觉率 47%）、难推理（HLE 差 6.4）和科学代码（SciCode 差 5.9）。所以 sonnet 承担大多数执行类工作；opus 留给需要审慎判断或细微错误代价高的工作（安全、并发、涉及钱、迁移、生产）、难推理、设计、原因未知的 bug、科学或算法类代码，以及结论取决于记忆中的事实、而且无法在仓库或文档里查证的调研（能查文档的比较类调研仍归 sonnet）。
  - Opus 与 Fable 之间 AA 上看不到 Fable 在任何领域领先（只有 AA-LCR 高 0.6），价格是 2.5 倍，所以 fable 的文字不变，仍默认关闭。
- **effort 往上取一档**（`decision/effort.ts` 的 `pickEffort`，常量 `ROUND_UP` 0.3）：高一档的概率有 0.3 以上就取高一档，`max` 仍要它自己的概率达到 `thetaMax`。低估一档，Sonnet 的 Terminal-Bench 要掉 14 个点（high 到 medium），高估一档只多花 token。
- **中途重判的门槛**：`thetaUp` 0.4 改 0.3，`thetaDown` 0.6 改 0.75，`holdSteps` 3 改 5：升档容易，降档难。
- **按模型设 effort 下限**（`decision/dispatched-agent.ts` 的 `effortFloor`）：sonnet 和 opus 都至少 medium（Sonnet 从 medium 到 low 指数掉 5、Terminal-Bench 掉 9 个点，Opus 从 medium 到 low 指数掉 9）；haiku 不带 effort，fable 没有下限。用户点名的 effort 和模型永远优先，下限不抬高用户点名的 effort。第一版（0.2.2 的第一次真实评测）把 sonnet 的下限放在 high（只有 low 的概率 ≥ 0.8 时才放到 medium），派出 agent 的 effort 部分从 74/72 掉到 64/62，偏高从 21/25 个升到 32/34 个，用户决定把 sonnet 的下限降到 medium，见下面的第六节。

## 五、已存的评测回答，按新规则离线重算

`node dispatch-pilot/eval/rescore.ts [--markdown]` 读 `eval/results/` 里已存的回答，用旧规则（0.2.1）和新规则各选一次档，和数据集的 gold 与 accept 比较；不向任何决策模型发请求，不改任何结果文件。每格是旧 -> 新，单位百分点，每个变体是中英文两种语言合在一起（`n` 为被回答的个数）。

- `picked`：回答选出的档；`sent`：中途重判后 mod 实际走的档（旧门槛 0.4 / 0.6 对新门槛 0.3 / 0.75）；`agent`：派出 agent 的模型和 effort 都对（模型照存下来的回答，没有重新问）。
- 准确率是落在 accept 里的比例；gold 是正好等于 gold 的比例；偏高、偏低是落在 accept 的最高档以上、最低档以下的比例。派出 agent 的偏高、偏低只看 effort 这一部分，最后一列是 effort 这一部分对的比例。

| file | variant | what | n | accuracy | gold | too high | too low | effort part |
|---|---|---|---|---|---|---|---|---|
| effort-midturn/2026-10-04-clef-wiring | en-score | picked | 200 | 86.0 -> 85.0 | 67.5 -> 66.0 | 7.5 -> 9.5 | 6.5 -> 5.5 | - |
| effort-midturn/2026-10-04-clef-wiring | en-score | sent | 200 | 57.5 -> 60.5 | 42.5 -> 45.5 | 21.0 -> 23.5 | 21.5 -> 16.0 | - |
| effort-midturn/2026-10-04-jev-reviewed | en-score | picked | 200 | 74.0 -> 74.5 | 56.0 -> 55.0 | 6.5 -> 9.0 | 19.5 -> 16.5 | - |
| effort-midturn/2026-10-04-jev-reviewed | en-score | sent | 200 | 76.5 -> 74.0 | 51.5 -> 52.0 | 11.5 -> 17.0 | 12.0 -> 9.0 | - |
| effort-midturn/2026-10-04-jev-reviewed | zh-score | picked | 200 | 72.5 -> 74.5 | 50.5 -> 52.0 | 4.5 -> 6.5 | 23.0 -> 19.0 | - |
| effort-midturn/2026-10-04-jev-reviewed | zh-score | sent | 200 | 73.5 -> 76.0 | 50.0 -> 51.5 | 11.0 -> 13.5 | 15.5 -> 10.5 | - |
| effort-submit/2026-10-04-clef-baseline | en-score | picked | 200 | 74.0 -> 67.5 | 53.5 -> 44.5 | 25.0 -> 31.5 | 1.0 -> 1.0 | - |
| effort-submit/2026-10-04-jev-baseline-3 | en-score | picked | 200 | 80.0 -> 81.0 | 60.5 -> 59.5 | 16.5 -> 16.5 | 3.5 -> 2.5 | - |
| effort-submit/2026-10-04-jev-baseline-3 | zh-score | picked | 200 | 87.5 -> 86.0 | 65.0 -> 65.0 | 4.5 -> 7.5 | 8.0 -> 6.5 | - |
| effort-submit/2026-10-04-jev-baseline-3 | en-choice | picked | 200 | 83.5 -> 83.5 | 64.5 -> 64.5 | 9.5 -> 11.0 | 7.0 -> 5.5 | - |
| effort-submit/2026-10-04-jev-baseline-3 | zh-choice | picked | 200 | 85.5 -> 87.5 | 62.5 -> 67.0 | 4.0 -> 5.5 | 10.5 -> 7.0 | - |
| effort-submit/2026-10-05-jev-ac4-question-language | zh-score | picked | 200 | 87.0 -> 86.5 | 65.5 -> 64.5 | 6.0 -> 8.0 | 7.0 -> 5.5 | - |
| effort-submit/2026-10-05-jev-ac4-question-language | en-score | picked | 200 | 78.5 -> 80.0 | 60.0 -> 59.0 | 17.0 -> 17.0 | 4.5 -> 3.0 | - |
| subagent/2026-10-04-clef-sample | models-hint | agent | 24 | 66.7 -> 58.3 | 41.7 -> 33.3 | 25.0 -> 33.3 | 8.3 -> 8.3 | 66.7 -> 58.3 |
| subagent/2026-10-04-jev-named-effort-after | models-hint | agent | 200 | 69.0 -> 61.5 | 49.0 -> 40.0 | 23.0 -> 30.5 | 4.0 -> 4.0 | 73.0 -> 65.5 |
| subagent/2026-10-04-jev-named-effort-after | work-hint | agent | 200 | 69.0 -> 61.5 | 47.0 -> 37.5 | 22.0 -> 30.0 | 5.0 -> 5.0 | 73.0 -> 65.0 |
| subagent/2026-10-04-jev-named-effort-after | models-noul | agent | 200 | 67.0 -> 59.0 | 45.5 -> 35.5 | 23.0 -> 31.0 | 6.5 -> 6.5 | 70.5 -> 62.5 |
| subagent/2026-10-04-jev-named-effort-after | work-noul | agent | 200 | 70.0 -> 62.5 | 48.5 -> 39.0 | 23.0 -> 30.5 | 3.5 -> 3.5 | 73.5 -> 66.0 |

（下限改成 sonnet 和 opus 都至少 medium 之后重算；派出 agent 的行里「偏低」「effort 部分」只看 effort 一部分。）

读法：

- **准确率略降，偏低减少、偏高增加，这是规则的本意**：数据集的 gold 是按「够用的最便宜档」标的，没有参考 AA 的 effort 曲线，所以往上取一档、抬下限一定会让一部分原来正好的回答变成偏高。effort-submit 里 Jev 的偏低少 1.5 到 3.5 个百分点（`zh-choice` 最多，10.5 到 7.0），偏高多 0 到 2 个百分点，准确率变化在 -1.5 到 +2 之间；Clef 的概率更平，`en-score` 偏高多 6.5 个百分点，准确率降 6.5 个百分点。
- **中途重判**：`picked` 的偏低在 Jev 上少 2 到 4 个百分点，偏高多 2 到 3.5 个百分点，准确率变化在 -1 到 +2 之间；`sent` 的偏低少 1 到 5 个百分点，但降档的门槛从 0.6 抬到 0.75 之后，该降而没降的偏高多 2.5 到 7 个百分点，所以 `sent` 的准确率在 `zh-score` 上升 2.5 个百分点，在其余四个变体上降 2 到 6 个百分点；Clef 的 `sent` 准确率升 3 个百分点。
- **派出 agent**：已存回答上，Jev 的准确率降 7.5 到 8.5 个百分点（`models-hint` 69.0 到 61.5），gold 命中降约 9 个百分点，多出来的几乎全是偏高（23% 变 30 到 31.5%）；偏低没有变（4.0%：8 个回答里 4 个选了 haiku、而 gold 要 opus 或 sonnet，4 个是 opus 答在 high、gold 是 xhigh 或 max），这些不是下限抬得到的。Clef 只有 12 题（24 个回答），样本太小，只作参考。**真实调用上降得少得多**，因为新的模型文字同时让模型部分对得更多，见第六节。
- **这些数字只说规则怎么改变已存回答的选档，不说选档对不对**：gold 本身没有按 AA 重标，所以「准确率降」不等于更差。
- **模型选项文字改了，已存的模型回答不再代表新请求**：这几行里的模型部分取已存的，新文字的效果只能重跑，见第六节（用户用 `!` 跑了第一次，之后在他授权的预算内又跑了几次）。

## 六、真实调用的核对（用户授权，只用 Jev）

离线重算只能改选档，改不了模型文字，所以模型选项和 effort 下限用真实的 Jev 调用核对（`eval/run.ts`）。运行前后的代码哈希都存在结果文件里，结果文件在 `eval/results/` 下提交了。

### 6.1 派出 agent（`subagent`，`models-hint` 变体，100 题中英各一遍，每次约 0.018 美元）

| 运行 | 整体 中/英 | 模型部分 中/英 | effort 部分 中/英 | 整体 gold 中/英 | model-over 题数 | model-under 题数 | effort 偏高 | effort 偏低 |
|---|---|---|---|---|---|---|---|---|
| 0.2.1 的规则和文字（`2026-10-04-jev-named-effort-after`） | 70/68 | 85/85 | 74/72 | 50/48 | 8/10 | 7/5 | 21/25 | 5/3 |
| 第一次真实运行：sonnet 下限 high，opus 原文（`aa-routing`，用户跑的） | 60/58 | 82/81 | 64/62 | 36/35 | 12/12 | 6/7 | 32/34 | 4/4 |
| 迭代 1：sonnet 下限 medium；opus 收窄成「记忆中的事实、无法在仓库或文档里查证」（`aa-iter1`） | 59/56 | 77/77 | 67/64 | 32/30 | 10/11 | 13/12 | 28/32 | 5/4 |
| 迭代 2：opus 先写「需要审慎判断或细微错误代价高」，记忆中的事实放到最后（`aa-iter2`） | 64/61 | 84/84 | 67/65 | 39/38 | 10/10 | 6/6 | 28/31 | 5/4 |
| 迭代 3：haiku 写成「结果只需收集并按要求排版的查找」（`aa-iter3`） | 69/68 | 89/91 | 71/71 | 44/44 | 6/4 | 5/5 | 24/25 | 5/4 |
| 迭代 3 重复一次（`aa-iter3-repeat`） | 69/67 | 89/90 | 71/71 | 43/43 | 6/4 | 5/6 | 24/25 | 5/4 |

单位是百分点或题数（100 题，各语言）；「model-over」是选了比 accept 里最贵的还贵的模型，「model-under」是比最便宜的还便宜。

- **每次迭代改了什么、为什么**：迭代 1 照用户的决定（sonnet 下限 medium、收窄 opus），但收窄之后，原来选 opus 的题（安全、并发调试、审计、设计，gold 都是 opus）有一批掉到 sonnet 或 haiku，model-under 从 6/7 升到 13/12，模型部分掉到 77。迭代 2 把原来写得很有效的框架句「需要审慎判断或细微错误代价高的工作」放回 opus 最前面，记忆中的事实的限定语留在最后，model-under 回到 6/6，模型部分 84。迭代 3 针对剩下的 haiku 题被判给 sonnet 或 opus（`subagent-024`、`035`、`055`：grep 加表格、列出 import 加计数、跑一条命令加表格）：haiku 的描述原来写「一两步」，被读成只做最简单的一件事，改成「一两步就能跑完、结果只需要收集起来并按要求排版」，model-over 从 10/10 降到 6/4，模型部分升到 89/91。
- **用户的目标**：模型部分回到改动前的 85% 附近或更高：89/91，达到；model-over 不比改动前（8/10）多：6/4，达到；effort 部分比第一次真实运行（64/62）高：71/71，达到。整体 69/68，和改动前的 70/68 持平；effort 部分比改动前（74/72）低 3 到 1 个百分点，是往上取一档和模型下限的代价：effort 偏高从 21/25 个变成 24/25 个，gold 命中从 50/48 变成 44/44。
- **单次运行的波动**：同一版文字重复一次，整体 69/68 对 69/67，模型部分 89/91 对 89/90，effort 部分 71/71 对 71/71，所以同一版重复时差距在 1 个百分点以内。但不同版本之间的差别里，小于约 2 个百分点的不能当结论（例如迭代 3 的 model-under 5/5 与改动前的 7/5）。
- **过拟合的提醒**：三次文字迭代都是看着这 100 题的错题改的，被改的几道题（`024`、`035`、`055`、`048` 等）直接出现在评测集里，所以 89/91 的模型部分是在调过的题上量的，对没见过的请求大概率会低一些，低多少没有量。重点看方向：model-under 回到 6 和 5，model-over 比改动前少。

### 6.2 发消息时的 effort（`effort-submit`，`zh-score` 和 `en-score`，约 0.013 美元）

和用户在 2026-10-05 跑的 `ac4-question-language`（0.2.1 的规则，请求逐字相同）比。每格是旧 -> 新，单位百分点，中英两种语言合在一起：

| 变体 | 准确率 | gold 命中 | 偏高 | 偏低 |
|---|---|---|---|---|
| `zh-score` | 87.0 -> 87.0 | 65.5 -> 66.5 | 6.0 -> 8.0 | 7.0 -> 5.0 |
| `en-score` | 78.5 -> 78.5 | 60.0 -> 57.5 | 17.0 -> 16.5 | 4.5 -> 5.0 |

真实调用上准确率不变，偏低在 `zh-score` 上少 2 个百分点，偏高多 2 个百分点；这和离线重算（`zh-score` 87.0 -> 86.5，偏高 6.0 -> 8.0，偏低 7.0 -> 5.5）一致，在 ±2 的波动之内。中英差距在这一次是 +4.0（中文 89.0、英文 85.0），上一次是 -4.0，同样的请求之前 3 次是 0、0、-1：一次运行的差距不稳。

### 6.3 一轮中途的 effort（`effort-midturn`，`en-score` 和 `zh-score`，约 0.015 美元）

和 `2026-10-04-jev-reviewed`（0.2.1 的规则）比。`picked` 是回答选出的档，`sent` 是 mod 按门槛实际走的档：

| 变体 | 看什么 | 准确率 | gold 命中 | 偏高 | 偏低 |
|---|---|---|---|---|---|
| `en-score` | picked | 73.5 -> 74.5 | 55.5 -> 52.5 | 6.5 -> 11.0 | 20.0 -> 14.5 |
| `en-score` | sent | 76.5 -> 70.5 | 51.5 -> 46.0 | 11.5 -> 19.5 | 12.0 -> 10.0 |
| `zh-score` | picked | 72.5 -> 76.5 | 50.5 -> 53.0 | 4.5 -> 8.0 | 23.0 -> 15.5 |
| `zh-score` | sent | 73.5 -> 73.0 | 50.0 -> 48.5 | 11.0 -> 17.5 | 15.5 -> 9.5 |

`picked` 上偏低少了 5.5 到 7.5 个百分点，准确率不降反升（离线重算预测的是 -1 到 +2，这里 +1 和 +4，在 ±2 到 ±3 的波动之内）；`sent` 上偏低只少了 2 到 6 个百分点，偏高多了 6 到 8 个百分点，所以 `sent` 的准确率在 `en-score` 上降 6 个百分点，在 `zh-score` 上基本持平。原因是降档的门槛从 0.6 抬到 0.75：该降的一轮（30 题）降不下来，留在偏高的档上，这是「降低难」的直接代价。离线重算对这一点的预测（`en-score` -2.5，`zh-score` +2.5）和真实的 -6、-0.5 方向一致，数值差了几个点，在这一块的波动之内。

### 6.4 花费

用户的第一次运行 0.0177 美元，我跑了 subagent 4 次（迭代 1 到 3 和一次重复，各约 0.018）、effort-submit 0.0126、effort-midturn 0.0149，合计约 0.10 美元，在 0.25 美元的上限之内。

## 七、没查到的和局限

- AIME、GPQA Diamond、MMLU-Pro、LiveCodeBench、tau-bench、AA Coding Index、AA Agentic Index：v4.3.2 的页面上没有四个模型的分数。
- 指数外的附加评测（Harvey LAB-AA、APEX-Agents-AA、IFBench、MMMU Pro 等）没有读到四个模型的数字。
- AA 衡量的是整套指数，不是 Claude Code 里的子 agent 工作；这份笔记只用了 AA 一家的数字。

## 八、来源

- <https://artificialanalysis.ai/models/releases/comparisons/claude-sonnet-5-5-vs-claude-opus-5-5>：Sonnet 5.5 与 Opus 5.5 各档全表。
- <https://artificialanalysis.ai/models/releases/comparisons/claude-fable-5-1-vs-claude-opus-5-5>：Fable 5.1 与 Opus 5.5 各档全表，含价格、速度、延迟。
- <https://artificialanalysis.ai/models/releases/comparisons/claude-sonnet-5-5-vs-claude-4-5-haiku>：Haiku 4.5 两个条目。
- <https://artificialanalysis.ai/models/releases/claude-fable-5-1>、<https://artificialanalysis.ai/articles/claude-fable-5-1>、<https://artificialanalysis.ai/articles/claude-sonnet-5-5>：Fable 5.1 概览与发布文章、Sonnet 5.5 文章（Omniscience 准确率和幻觉率）。
- <https://artificialanalysis.ai/methodology/intelligence-benchmarking>：十个分项、权重和版本史。
