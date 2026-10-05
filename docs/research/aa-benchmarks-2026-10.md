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
  - Haiku 与 Sonnet 之间差距最大：Terminal-Bench 0% 对 63.6%，AutomationBench 3.2% 对 71.8%，HLE 10.4% 对 55.0%。所以 haiku 只做一两步就能完成的只读查找，长串的工具调用、写入和判断都不给它。
  - Sonnet 与 Opus 之间大多数工作差距在误差内（终端、自动化、知识工作上 Sonnet 持平或略高），拉开的是事实知识（Omniscience 32 对 46，Sonnet 的幻觉率 47%）、难推理（HLE 差 6.4）和科学代码（SciCode 差 5.9）。所以 sonnet 承担大多数执行类工作，opus 留给事实知识、难推理、设计、原因未知的 bug、科学或算法类代码，以及安全、迁移、生产和涉及钱的工作。
  - Opus 与 Fable 之间 AA 上看不到 Fable 在任何领域领先（只有 AA-LCR 高 0.6），价格是 2.5 倍，所以 fable 的文字不变，仍默认关闭。
- **effort 往上取一档**（`decision/effort.ts` 的 `pickEffort`，常量 `ROUND_UP` 0.3）：高一档的概率有 0.3 以上就取高一档，`max` 仍要它自己的概率达到 `thetaMax`。低估一档，Sonnet 的 Terminal-Bench 要掉 14 个点（high 到 medium），高估一档只多花 token。
- **中途重判的门槛**：`thetaUp` 0.4 改 0.3，`thetaDown` 0.6 改 0.75，`holdSteps` 3 改 5：升档容易，降档难。
- **按模型设 effort 下限**（`decision/dispatched-agent.ts` 的 `effortFloor`）：Sonnet 默认下限 high（high 到 medium 指数掉 6，到 low 掉 11）；只有 effort 回答里 low 的概率有 0.8 以上，下限才放到 medium。Opus 下限 medium（medium 到 high 只差 3，low 到 medium 差 9）。haiku 不带 effort，fable 没有下限。用户点名的 effort 和模型永远优先，下限不抬高用户点名的 effort。

## 五、已存的评测回答，按新规则离线重算

`node dispatch-pilot/eval/rescore.ts [--markdown]` 读 `eval/results/` 里已存的回答，用旧规则（0.2.1）和新规则各选一次档，和数据集的 gold 与 accept 比较；不向任何决策模型发请求，不改任何结果文件。每格是旧 -> 新，单位百分点，每个变体是中英文两种语言合在一起（`n` 为被回答的个数）。

- `picked`：回答选出的档；`sent`：中途重判后 mod 实际走的档（旧门槛 0.4 / 0.6 对新门槛 0.3 / 0.75）；`agent`：派出 agent 的模型和 effort 都对（模型照存下来的回答，没有重新问）。
- 准确率是落在 accept 里的比例；gold 是正好等于 gold 的比例；偏高、偏低是落在 accept 的最高档以上、最低档以下的比例。派出 agent 的偏高、偏低只看 effort 这一部分，最后一列是 effort 这一部分对的比例。

| file | variant | what | n | accuracy | gold | too high | too low | effort part |
|---|---|---|---|---|---|---|---|---|
| effort-midturn/2026-10-04-clef-wiring | en-score | picked | 200 | 86.0 -> 85.0 | 67.5 -> 66.0 | 7.5 -> 9.5 | 6.5 -> 5.5  - |
| effort-midturn/2026-10-04-clef-wiring | en-score | sent | 200 | 57.5 -> 60.5 | 42.5 -> 45.5 | 21.0 -> 23.5 | 21.5 -> 16.0  - |
| effort-midturn/2026-10-04-jev-reviewed | en-score | picked | 200 | 74.0 -> 74.5 | 56.0 -> 55.0 | 6.5 -> 9.0 | 19.5 -> 16.5  - |
| effort-midturn/2026-10-04-jev-reviewed | en-score | sent | 200 | 76.5 -> 74.0 | 51.5 -> 52.0 | 11.5 -> 17.0 | 12.0 -> 9.0  - |
| effort-midturn/2026-10-04-jev-reviewed | zh-score | picked | 200 | 72.5 -> 74.5 | 50.5 -> 52.0 | 4.5 -> 6.5 | 23.0 -> 19.0  - |
| effort-midturn/2026-10-04-jev-reviewed | zh-score | sent | 200 | 73.5 -> 76.0 | 50.0 -> 51.5 | 11.0 -> 13.5 | 15.5 -> 10.5  - |
| effort-midturn/2026-10-04-jev-reviewed | no-current-effort | picked | 200 | 74.5 -> 75.5 | 56.5 -> 55.0 | 6.5 -> 8.5 | 19.0 -> 16.0  - |
| effort-midturn/2026-10-04-jev-reviewed | no-current-effort | sent | 200 | 76.5 -> 74.5 | 53.5 -> 52.5 | 11.5 -> 15.5 | 12.0 -> 10.0  - |
| effort-midturn/2026-10-04-jev-reviewed | no-counts | picked | 200 | 74.5 -> 74.5 | 57.5 -> 56.0 | 6.0 -> 9.5 | 19.5 -> 16.0  - |
| effort-midturn/2026-10-04-jev-reviewed | no-counts | sent | 200 | 77.5 -> 71.5 | 55.0 -> 50.5 | 11.0 -> 18.0 | 11.5 -> 10.5  - |
| effort-midturn/2026-10-04-jev-reviewed | trouble | picked | 200 | 74.0 -> 73.5 | 56.0 -> 54.5 | 7.5 -> 10.0 | 18.5 -> 16.5  - |
| effort-midturn/2026-10-04-jev-reviewed | trouble | sent | 200 | 76.0 -> 72.5 | 53.0 -> 51.0 | 12.0 -> 17.5 | 12.0 -> 10.0  - |
| effort-submit/2026-10-04-clef-baseline | en-score | picked | 200 | 74.0 -> 67.5 | 53.5 -> 44.5 | 25.0 -> 31.5 | 1.0 -> 1.0  - |
| effort-submit/2026-10-04-jev-baseline-3 | en-score | picked | 200 | 80.0 -> 81.0 | 60.5 -> 59.5 | 16.5 -> 16.5 | 3.5 -> 2.5  - |
| effort-submit/2026-10-04-jev-baseline-3 | zh-score | picked | 200 | 87.5 -> 86.0 | 65.0 -> 65.0 | 4.5 -> 7.5 | 8.0 -> 6.5  - |
| effort-submit/2026-10-04-jev-baseline-3 | en-choice | picked | 200 | 83.5 -> 83.5 | 64.5 -> 64.5 | 9.5 -> 11.0 | 7.0 -> 5.5  - |
| effort-submit/2026-10-04-jev-baseline-3 | zh-choice | picked | 200 | 85.5 -> 87.5 | 62.5 -> 67.0 | 4.0 -> 5.5 | 10.5 -> 7.0  - |
| effort-submit/2026-10-05-jev-ac4-question-language | zh-score | picked | 200 | 87.0 -> 86.5 | 65.5 -> 64.5 | 6.0 -> 8.0 | 7.0 -> 5.5  - |
| effort-submit/2026-10-05-jev-ac4-question-language | en-score | picked | 200 | 78.5 -> 80.0 | 60.0 -> 59.0 | 17.0 -> 17.0 | 4.5 -> 3.0  - |
| subagent/2026-10-04-clef-sample | models-hint | agent | 24 | 66.7 -> 50.0 | 41.7 -> 25.0 | 25.0 -> 41.7 | 8.3 -> 8.3 | 66.7 -> 50.0 |
| subagent/2026-10-04-jev-named-effort-after | models-hint | agent | 200 | 69.0 -> 61.5 | 49.0 -> 40.0 | 23.0 -> 30.5 | 4.0 -> 4.0 | 73.0 -> 65.5 |
| subagent/2026-10-04-jev-named-effort-after | work-hint | agent | 200 | 69.0 -> 61.5 | 47.0 -> 37.5 | 22.0 -> 30.0 | 5.0 -> 5.0 | 73.0 -> 65.0 |
| subagent/2026-10-04-jev-named-effort-after | models-noul | agent | 200 | 67.0 -> 58.5 | 45.5 -> 35.5 | 23.0 -> 31.5 | 6.5 -> 6.5 | 70.5 -> 62.0 |
| subagent/2026-10-04-jev-named-effort-after | work-noul | agent | 200 | 70.0 -> 62.5 | 48.5 -> 39.0 | 23.0 -> 30.5 | 3.5 -> 3.5 | 73.5 -> 66.0 |

读法：

- **准确率略降，偏低减少、偏高增加，这是规则的本意**：数据集的 gold 是按「够用的最便宜档」标的，没有参考 AA 的 effort 曲线，所以往上取一档、抬下限一定会让一部分原来正好的回答变成偏高。effort-submit 里 Jev 的偏低少 1.5 到 3.5 个百分点（`zh-choice` 最多，10.5 到 7.0），偏高多 0 到 2 个百分点，准确率变化在 -1.5 到 +2 之间；Clef 的概率更平，`en-score` 偏高多 6.5 个百分点，准确率降 6.5 个百分点。
- **中途重判**：`picked` 的偏低在 Jev 上少 2 到 4 个百分点，偏高多 2 到 3.5 个百分点，准确率变化在 -1 到 +2 之间；`sent` 的偏低少 1 到 5 个百分点，但降档的门槛从 0.6 抬到 0.75 之后，该降而没降的偏高多 2.5 到 7 个百分点，所以 `sent` 的准确率在 `zh-score` 上升 2.5 个百分点，在其余四个变体上降 2 到 6 个百分点；Clef 的 `sent` 准确率升 3 个百分点。
- **派出 agent**：Jev 的准确率降 7.5 到 8.5 个百分点，gold 命中降约 9 个百分点，多出来的几乎全是偏高（23% 变 30 到 31.5%）；偏低没有变（4.0%，`models-hint`：8 个回答里 4 个选了 haiku、而 gold 要 opus 或 sonnet，4 个是 opus 答在 high、gold 是 xhigh 或 max），这些不是下限抬得到的。Clef 只有 12 题（24 个回答），准确率 66.7 变 50.0，样本太小，只作参考。
- **这些数字只说规则怎么改变已存回答的选档，不说选档对不对**：gold 本身没有按 AA 重标，所以「准确率降」不等于更差。
- **模型选项文字改了，已存的模型回答不再代表新请求**：新文字的效果需要重跑 subagent 评测（约 0.011 美元，由用户运行）。

## 六、没查到的和局限

- AIME、GPQA Diamond、MMLU-Pro、LiveCodeBench、tau-bench、AA Coding Index、AA Agentic Index：v4.3.2 的页面上没有四个模型的分数。
- 指数外的附加评测（Harvey LAB-AA、APEX-Agents-AA、IFBench、MMMU Pro 等）没有读到四个模型的数字。
- AA 衡量的是整套指数，不是 Claude Code 里的子 agent 工作；这份笔记只用了 AA 一家的数字。

## 七、来源

- <https://artificialanalysis.ai/models/releases/comparisons/claude-sonnet-5-5-vs-claude-opus-5-5>：Sonnet 5.5 与 Opus 5.5 各档全表。
- <https://artificialanalysis.ai/models/releases/comparisons/claude-fable-5-1-vs-claude-opus-5-5>：Fable 5.1 与 Opus 5.5 各档全表，含价格、速度、延迟。
- <https://artificialanalysis.ai/models/releases/comparisons/claude-sonnet-5-5-vs-claude-4-5-haiku>：Haiku 4.5 两个条目。
- <https://artificialanalysis.ai/models/releases/claude-fable-5-1>、<https://artificialanalysis.ai/articles/claude-fable-5-1>、<https://artificialanalysis.ai/articles/claude-sonnet-5-5>：Fable 5.1 概览与发布文章、Sonnet 5.5 文章（Omniscience 准确率和幻觉率）。
- <https://artificialanalysis.ai/methodology/intelligence-benchmarking>：十个分项、权重和版本史。
