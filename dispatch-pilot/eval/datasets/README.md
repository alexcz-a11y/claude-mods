# 评测集的约定

这里的评测集是 Dispatch Pilot 评测（`eval/`，见上一级的 DEVELOPMENT.md「评测」）的题目。每题怎么写、答案怎么标，都按这份约定；新加题、改题也照此。校验规则在 `eval/lib/datasets.ts`，`node dispatch-pilot/eval/validate.ts` 逐条检查。

这份约定来自评测集起草时的两份说明（起草时的「README」和「SOURCES.md」，当时放在仓库之外）。审核总结（`eval/review/*.review-summary.md`）里说的「README 档位表」就是下面的「effort 档位的含义」，说的「SOURCES.md 的附加约定」就是下面各类题的「附加约定」。

## 文件

| 文件 | 评测的是 | 票 |
|---|---|---|
| `effort-submit.jsonl` | 发消息时主 agent 的 effort | #4 |
| `effort-midrun.jsonl` | 一轮中途在事件上（失败复现、交回结果、加载 skill、任务清单换项、送进这一轮的报告）重新判断主 agent 的 effort；0.8.x `effort-midturn` 的 100 题转过来，再加 22 题 | ADR 0020 |
| `subagent.jsonl` | 派出 agent（普通派发，以及 Workflow 里的 `agent()`）的模型和 effort | #15 |
| `skill.jsonl`，加上 `skill-catalog.json` | skill 匹配（用本机真实的 skill 目录出题） | #16 |
| `unresolved.jsonl` | 和主 agent 为同一个问题来回多轮都没解决时，发消息时判出的主 agent effort（以及这条消息和之前的问题是什么关系） | #37（spec #36） |
| `long-context.jsonl`，加上 `long-context-summaries.json` | 决定答案的几轮在很长的对话里很早的位置时，决策模型读多远、读更多带来多少准确率（只有中文对话；由 `long-context-items.ts` 生成） | #44 |
| `eval-v2/`（素材池、题目、两份金标、`generated.json`），生成 `eval-v2.jsonl`（不提交） | 多 agent 出题的 120 题长对话真实流程评测（只有中文对话）；格式见 `eval-v2/FORMAT.md` | #45 |
| `visual-check.jsonl`，加上文件夹 `visual-check/`（图和真值） | 看图核对：界面和 3D 海面对着参考图、动画的 12 帧对着规范、一组参考图的复杂度读数（没有 `zh`/`en`，见下文） | #65（spec #55） |

每个文件约 100 题（`unresolved.jsonl` 约 30 题，其中一部分对话很长），每行一个 JSON 对象，UTF-8，不加注释。eval v2 不是这种一行一题的手写文件：它的来源是 `eval-v2/` 下一个个 JSON 文件，格式和规则全在 `eval-v2/FORMAT.md`（见文末「eval v2」）。

**名字的例外。** 术语表（仓库根目录的 `GLOSSARY.md`）不用「子 agent」「subagent」，统一叫「派出 agent」。`subagent.jsonl` 这个文件名、题号 `subagent-001` 起、suite 名 `subagent` 和 `results/subagent/` 都保留原来的写法：结果文件、审核记录和 issue 里的讨论都按这些名字引用，改名只会让它们对不上。新写的说明和代码里的标识符仍用「派出 agent」。

## 每题共用的字段

```json
{
  "id": "submit-001",
  "zh": { ... },
  "en": { ... },
  "gold": ...,
  "accept": [ ... ],
  "rationale": "中文理由：为什么是 gold，为什么 accept 里的其他答案也可以接受，为什么相邻的答案不行",
  "difficulty": "hard",
  "tags": ["follow-up", "misleading-length"]
}
```

- `zh` 和 `en` 是同一道题的中文版和英文版，结构完全相同，含义一致。英文版是忠实的翻译，不是改写；中文版要像真实的中文用户写的（可以夹英文术语、代码、路径，这本身也是考点）。
- `gold` 是最好的答案；`accept` 是所有可以接受的答案（必须包含 `gold`）。没有唯一正确答案的题用 `accept` 放宽，有唯一答案的题 `accept` 只有一个元素。
- `difficulty`：`hard` 或 `medium`。题目要偏难，至少 70% 是 `hard`。
- `tags`：自由标签，用来事后分析错在哪里。常用的有：`short-but-hard`、`long-but-easy`、`follow-up`、`code-switching`、`idiom`、`ambiguous`、`debug`、`refactor`、`design`、`security`、`trivial`、`question-only`、`continuation`。
- 理由一律用中文写。
- 审核的决定记在 `eval/review/<类>.review.jsonl`，每行 `{ id, verdict, changes?, note?, at }`：`agree`（同意）、`edit`（`changes` 里是新的答案字段）或 `note`（答案不变，意见要跟进）。同一题以最后一行为准。`eval/apply-review.ts` 把它应用到这里的 JSONL 上（只改答案字段），审核记录和改动一起提交。

## effort 档位的含义（所有 effort 题共用）

| 档位 | 什么情况 |
|---|---|
| `low` | 查一个事实、改一个名字、一行答案、照着明确指令做的机械改动 |
| `medium` | 范围清楚的单点改动或解释，不需要权衡 |
| `high` | 调试、跨多个文件的改动、边界条件要紧的工作 |
| `xhigh` | 长链路的 agent 工作、架构设计、需要反复验证的复杂改动 |
| `max` | 最难的问题：安全审计、证明、疑难并发问题、高风险且不可逆的操作。门槛最高，只在真正需要时给 |

effort 题的 `accept` 必须是连续的档位（例如 `["high","xhigh"]`，不能是 `["medium","xhigh"]`）。审核时补充的判断规则（例如量大但机械的改动按每一步需要的推理定档、写测试按范围定档）见各类的审核总结。

这张表是标注的依据。`hooks/decision/effort.ts` 里的档位描述是被测的提示词，不能拿它来放宽 `accept`。

## 各类题的 `zh` / `en` 和答案

### effort-submit（#4）

```json
"zh": {
  "message": "用户这一轮发的消息原文",
  "recent_context": [
    { "role": "user", "text": "……" },
    { "role": "assistant", "text": "……", "tools": ["Read", "Edit"] }
  ]
}
```

- `recent_context` 是这一轮之前的最近几条消息，只有文字和工具名，没有文件内容和工具输出（和 mod 发给决策模型的一样）；可以为空数组。
- `gold`：一个 effort 档位；`accept`：档位数组。
- 附加约定：85 题的 `accept` 是相邻两档，所以「每题都答 high」就能对 55%。报告准确率时同时给出这个常数基线和 gold 命中率。

### effort-midrun（ADR 0020）

0.8.x 的 `effort-midturn`（每隔几步重判，100 题）随一轮中途重判在 0.9.0 删掉；0.11.0 的一轮中途换档只在事件上问（`decision/midrun-track.ts`：失败复现、前台的派出 agent 或 Workflow 交回结果、加载 skill、任务清单换项、送进这一轮的报告），请求和读法都是新的（`decision/midrun.ts`）。这套题是旧的 100 题转成新的输入，再加 22 道旧题没有的情形。每题是「mod 此刻去问决策模型」的一个时刻：

```json
{
  "id": "midrun-006",
  "zh": {
    "task": "用 TDD 给优惠券加一个规则：满 200 减 20，但不能和会员折扣叠加",
    "recent_steps": [
      { "step": 2, "assistant_text": "跑一下，应该失败，规则类还没写。",
        "tools": [ { "tool": "Bash", "target": "pytest tests/coupon_rules_test.py", "outcome": "failed",
                     "error": "ImportError: cannot import name 'FullReductionRule'", "result": "pytest tests/coupon_rules_test.py：3 个失败，ImportError: …" } ] }
    ],
    "facts": ["The command `pytest tests/coupon_rules_test.py` failed again after the assistant edited files since its last failure.", "2 of the 5 tool calls of this run failed."],
    "failures": { "latest": "Bash: 2 个断言失败（期望 180，实际 200）", "earlier": "Bash: ImportError: cannot import name 'FullReductionRule'" }
  },
  "en": { ... },
  "event": "failure", "current": "medium", "base": "medium", "rule_floor": null, "stuck_before": false,
  "gold": "medium", "accept": ["medium"], "rationale": "……", "difficulty": "hard", "tags": ["expected-failure", "tdd-red"]
}
```

- **`zh` / `en` 是 mod 给决策模型的输入**（`MidrunInput`，`midrunState` 照它拼 state）：`task` 是这一轮的消息；`recent_steps` 按时间先后，每步是 `step`（下标，递增）、助手这一步最后写的文字、各个工具调用，每个调用是 `tool`、`target`（`toolTarget` 从调用的参数读出的「做的是什么」：说明、skill 或 agent 名、路径末两段、搜索词、网址、命令第一行；路径和命令两种语言相同，模型自己写的说明跟着语言走）、`outcome`（`ok`、`failed`、`blocked` 被 hook 拦、`denied` 被用户拒，后两种不是失败）、`error`（只有失败的调用有，工具说的第一行，工具什么都没说时没有）；`facts` 是代码数出来的事实，**照 `factsOf` 的句式写，两种语言里逐字相同**（mod 的事实句永远是英文）；事件带来的字段：`next_item`（任务清单换到的那一项，`todo` 事件）、`report`（送进这一轮的报告原文，`report` 事件）、`failures`（失败复现时 `same_failure` 比较的两条报错，`Bash: <首行>` 的形式，最新的和之前的；原先通过的命令改过之后失败没有）。可选的 `constraints` 同 mod（用户早先定下的规矩）。
- **`result` 不是 mod 发的。** 每个调用另带 `result`：0.8.x 评测集里这个调用的「结果如何」（新题照同样的写法），只有 `with-outputs` 变体发，放进 `error`（mod 的 state 里调用唯一能带一行话的地方，成功的调用也一样），再按 mod 的规矩截成一行。mod 从不发工具返回的内容，所以这个变体量的是 mod 不发它的代价。
- **位置** 是 `decideMidrun` 要的 `MidrunPosition`：`event`（`failure`、`report`、`handback`、`skill`、`todo`）、`current`（这一轮现在发出去的档）、`base`（发消息时定的档：没有升过档的题等于 `current`；带 `just-upgraded` 标签的 3 题刚在中途升过，`base` 低一档）、`rule_floor`（发消息时那几条规则下限里最高的，现在都是 null）、`stuck_before`（这一轮此前已有一次失败被读成「原因未找到」：为它升过档，档位不再降，高于 high 的升档也由它放行）。评测不记的：离上次换档的步数和这一轮换过几次（都当作没有，不会遇到「等间隔」和每轮上限），`/dp midrun-down`（开着，默认值）；`report` 事件是本来就带输入的一步（`free`，不追加提示行）。
- **事件按 mod 会在哪里问来定，不按旧题的写法。** 失败复现是 `noteCall` 认的三种：同一类命令改过文件后又失败（`refail`，`facts` 里写连续次数）、原先通过的命令改过之后失败（`regression`）、报错首行和上一次相同（`same-line`）；**第一次失败不是事件**（一次失败多半是被拦的调用或打错的命令，本机记录里报错的步 59% 不思考），所以旧题里最近一步是失败、却只失败了一次的 001、005、008、009，事件是任务清单换到下一项（`todo`），不是 `failure`。旧题里失败过不止一次的 6 题（006、017、051、053、056、057）是失败事件；017 的两次失败是 Edit 的，`noteCall` 只在 Bash 上认失败，这一类 mod 不会问，题留着是为了量决策模型。`handback` 是前台的派出 agent 或 Workflow 交回了结果（081、082、085、086、088 和新题 122）；后台派出（087）和 Workflow 刚启动（090）没有交回，事件是 `todo`。`skill` 只在 skill 刚加载的那一刻（083、089）；084 的 skill 是前几步加载的，这一题是任务清单换项时再问，事件是 `todo`。其余旧题的事件是 `todo`（一段工作的边界），`next_item` 写成这一项在清单里会有的样子（任务层面的一句话，不写做法），`done`/`total` 是编的小数字。
- **旧题的转换**（一次性的，转换脚本没有留在仓库里，规则如下）：`outcome` 取旧结果行开头的「成功：/失败：/被 hook 拦截：/用户拒绝：」；`target` 是旧题 `input` 经 `toolTarget` 得到的；失败调用的 `error` 是旧结果行去掉前缀和 `target` 之后的第一个分句（38 个失败调用里 13 个就是这样取的；2 个没有 `error`，`rg`、`grep` 无匹配的退出码 1 工具什么都没说；23 个分句取得不对，按旧结果行的意思手写，如 `pytest` 的 `3 failed` 改成 `ImportError: cannot import name …`）；旧的 `counts.judgments`、`changes` 不再有（新 state 不给），`counts.failures` 和 `step` 只用来算 `facts` 里「N of M tool calls failed」；`step` 下标按旧题 `step` 往回数；`facts` 照 `factsOf` 写（失败复现句的命令类 `command` 取调用的前三个词，没有命令的调用补了一个合理的）；旧题没有的 `result` 取旧结果行去掉前缀的整句。**21 道题的理由改了几句**：凡是提到 `failures=`、`changes=`、「卡住标记」「强制升档」「防抖规则」「每 N 步重判」的句子，改成新机制里的说法（001、002、005、006、007、015、019、021、026、038、039、044、053、056、057、061、065、081、084、087、090），答案字段（`gold`、`accept`）一个都没动。另有两处按新状态改了：081 的三个 Agent 调用在新 state 里是已经结束的调用，`result` 从「结果还没回来」改成「已交回」；006 第二次 `pytest` 的命令改得和第一次同类，才算「又失败」。
- **新题 101–122**（22 道，旧题没有的情形，中英文各写）：环境的失败，该保持（101 超时、102 限流、103 缺程序、104 凭证过期；105 hook 连拒三次，之后用项目自己的脚本）；助手说修好了、下一次结果仍失败，该升（106，107 是已经在 high 且此前被判过卡住的，该再升一档）；预期内的红灯，该保持（108 TDD 连续三次红灯但一次比一次少，109 改 token 之后快照会变，是预告过的）；原因助手已经点明的失败复现，该保持（110 tsc、111 mvn）；送进这一轮的报告（112 后台测试通过，只说完成，保持；113 agent 交回的盘点挖出了账本归属的设计问题，该升；114 agent 写完测试，只说完成）；只剩照做（115 xhigh 的迁移剩 7 个服务，116 high 的 20 个 DTO，117 获批的目录整理，各降一档）；看似照做其实不是（118 `Date.now()` 换 `Clock`，租约和退避各要判断）；看似收尾其实有一步没验证（119 最后一次测试之后又改了代码，120 测试跑的不是改动的那几个模块）；任务没写到的新工作（121 导出 200 万行要流式或后台生成）；Workflow 交回的几份报告互相矛盾（122）。
- **附加约定：**
  - `accept` 同其他 effort 题：连续的档位，最多两档宽，包含 `gold`。降两档以上的题，`accept` 里没有「保持当前档」。
  - **有 6 道题 `decideMidrun` 一次事件答不出**（`reachableLevels`：能发出去的档是现在这一档、升到 high（high 以上一次一档，可以到 max；出错代价直接到 xhigh）、回到发消息时的档、比发消息时低一档、失败事件里不降也不回）：007、061、066、068、091 的 `accept` 比现在的档低两档以上（发消息时的档被话题字样带高，一轮中途只能降一档），017 要 medium 而失败事件里原因未找到只能升到 high。0.11.0 放开一轮中途的上限之前（ADR 0022）还有 053：要 max，而那时中途最高到 xhigh；2026-11-11 及之前存的结果文件里 `breakdown.reachable` 仍按 7 题算。它们留在集里，汇总另给不含这几题的准确率（`breakdown.reachable`）。
  - 「每题都保持当前档」的基线是 `current`，在汇总里和常数基线一起评分。

**suite**（`lib/effort-midrun.ts`）：请求是 mod 在事件上发的那一个，**只用 mod 的函数拼**：`midrunState`（state）、`midrunPart`（问题，失败复现时带两条报错）、`mergeParts`，回答用 `answersFor`、`readEffort`、`midrunSignals` 读，评分的档位是 `decideMidrun` 返回的那一档（`sent`）：Score 的位置和两侧、红旗、一轮里只升不降的棘轮、决策模型自己指南的门槛都在里面（回答的 `model` 以 `d1` 开头读 Liquid 的指南，别的读设置里的，TypeSafe 的）。每个回答另记 `picked`（只看 Score 选出的档）、`move`、`reason`、每道是非题的概率（`noul`）、各档概率（`p`）、置信度和读它用的指南。变体：`mod`（mod 发的 state）、`no-facts`（去掉 `facts`）、`with-outputs`（每个调用的 `error` 是旧评测集的 `result`，不是 mod 的请求）；题面永远是英文（`midrunPart` 就是这样），`zh`/`en` 是 state 内容的语言，每个变体两种都问。汇总（`breakdown`）：按该升、该降、该保持分组的准确率，该保持的题被动了多少（动到 `accept` 之外多少）、该降的题没降够多少、该升的题没升够多少，`picked` 的准确率，不含答不出的题的准确率，每种 `move` 的次数，按事件和按标签组（`MIDRUN_TAG_GROUPS`）的准确率。

### subagent（#15）

```json
"zh": {
  "user_message": "用户本轮的消息原文",
  "kind": "agent",
  "agent_type": "general-purpose",
  "description": "主 agent 写的 3–5 词描述",
  "prompt": "主 agent 写给这个 agent 的完整任务",
  "requested_model": null,
  "workflow_description": null,
  "label": null
}
```

- `kind`：`agent`（普通派发，经 Agent 工具）或 `workflow`（Workflow 脚本里的 `agent()`，这时 `workflow_description` 和 `label` 有值，`agent_type` 通常为 null）。两类都要覆盖，`workflow` 至少占 30%。同一个 workflow 的几个 `agent()`（`workflow_description` 和用户的消息都相同）就是同一个脚本的几个调用：评测按 #8 的方式把它们放在一起问，按题号的顺序。
- `requested_model`：主 agent 自己指定的模型（`haiku`、`sonnet`、`opus`、`fable`）或 null。覆盖：主 agent 指定得对、指定得不对、用户在 `user_message` 里明确点名了某个模型（这时用户点名的模型是唯一可接受的答案）。
- 答案是对象：`"gold": { "model": "sonnet", "effort": "medium" }`，`"accept": { "model": ["sonnet"], "effort": ["low", "medium"] }`。模型是 `haiku` 时 effort 一律为 null（haiku 不设 effort），`accept.effort` 写 `[null]`。可选的模型默认是 `haiku`、`sonnet`、`opus`；`fable` 只在确有必要的题里出现，并加标签 `fable`。
- 附加约定：
  - workflow 题的 `description` 为 null；`agent_type` 只在脚本给 `agent()` 传了 `agentType` 时才有值。
  - fan-out 题的 `label` 和 `prompt` 保留 `${file}` 这类占位符。
  - 评分：选了 haiku，effort 必须为 null；选了其他模型，effort 必须在 `accept.effort` 的非 null 部分里。`accept.effort` 含 null，当且仅当 `accept.model` 含 haiku。
  - 每题恰好一个 `priority:*` 标签（用户点名、保留主 agent 的指定、推翻主 agent 的指定、无指定）。用户写出的 effort 同样是唯一可接受的档位（issue #1）。
  - 保留还是推翻主 agent 的指定：差两档、让 haiku 写代码或做判断、让 opus 或 fable 做只需汇报、不需判断的只读工作或机械工作，就推翻；只差一档、这个选择说得过去，就保留，gold 用主 agent 的指定，更合适的模型放进 accept。（「只读」指只搜索、只汇报、不需要判断的工作，不是字面上的「不改代码」：审核总结的建议。）
  - 只有肯定的说法（「用 X」「X 就够了」）才算点名；「别用 X」是约束，X 不进 accept，标 `priority:none`。
  - 只提到 fable、答案却是默认模型的题，也打 `fable` 标签。

### skill（#16）

```json
"zh": {
  "message": "用户这一轮发的消息原文",
  "recent_context": []
}
```

- 题目必须基于 `skill-catalog.json`：本机真实 skill 目录的快照（名字、描述、来源、是否 `disable-model-invocation`、SKILL.md 的位置和 sha256）。快照按用户的决定反映撤销 jev-pilot 写进 settings 的 `user-invocable-only` 覆盖之后的环境：被这些覆盖挡住的已安装 skill 算作主 agent 能加载的候选；frontmatter 写了 `disable-model-invocation` 的仍只用于 `user_only_hint`；仓库 settings 里设成 off 的保持 off。
- 答案：`"gold": ["skill-a"]`（最该推荐的 skill，按优先顺序；空数组表示「不该推荐任何 skill」）；`"accept": ["skill-a", "skill-b"]`（推荐了其中任何一个都算对）；另有两个字段：
  - `"must_not": ["skill-x"]`：推荐了就算错的 skill（典型的是看起来相关、其实不适用的干扰项）。
  - `"user_only_hint": ["skill-y"]`：只能由用户本人触发（`disable-model-invocation: true`）、应该在状态行提示用户而不是推荐给主 agent 的 skill。
- 覆盖：中文请求对上英文描述的 skill；没有任何 skill 相关（至少 20%）；几个 skill 部分相关；名字相近的干扰项；只能由用户触发的 skill（至少 10 题）。`near-duplicate`、`lexical-trap` 标签按 skill 家族标。

### unresolved（#37，spec #36）

量的是「多轮未解决」这个漏洞：用户和主 agent 为同一个问题来回好几轮都没解决，决策模型发消息时读不到那么远（effort 题和 skill 排序题合在一个请求里，state 只有约 6000 token，助手的一两条长回复就把预算占满），几乎从不判到最高一档。ADR 0005 的做法（effort 题单独成一个请求、state 24000、再加问题摘要和未解决次数）要靠这个评测集量出效果；它先在改动之前的代码上跑出基线，之后每一步都和基线比。

```json
"zh": {
  "message": "用户这一轮发的消息原文",
  "recent_context": [ { "role": "user", "text": "……" }, { "role": "assistant", "text": "……", "tools": ["Edit"] } ],
  "command": { "name": "debug", "description": "这个命令是干什么的" }
}
```

- `zh` / `en` 的形状同 effort-submit，另有可选的 `command`：这条消息开始的是命令轮时才有（`message` 写成用户输入的 `/name args`，`command` 是 mod 在 state 里放在消息旁边的命令说明，`name` 两种语言相同，`description` 各用各的语言）。中英两版要么都有，要么都没有。
- `gold`、`accept`：这条消息该用的主 agent effort，规则同 effort-submit（`accept` 是相邻的档位，`gold` 在里面）。
- `triage`：三选一题的金标，`unresolved`（同一问题仍未解决）、`resolved`（已经解决）、`new`（新问题或无关）。判的是这条消息和它之前的那个问题的关系，只看用户的话，不看主 agent 自己说「已修复」。suite 把 mod 里的三选一题（`effort.unresolved`，和 effort 题在同一个请求里）一起问，取概率最高的选项和这个金标比（`still_unresolved` 是 `unresolved`，`new_or_unrelated` 是 `new`）。
- 约 30 题，覆盖五种情形：明说没解决（`explicit-unresolved`，5 题）、隐含的没解决（`implicit-unresolved`，7 题：贴同样的报错、「再看看」、只报一个没变的数字）、只失败过一次的第二次（`second-attempt`，3 题：gold 是 high 或 xhigh，不是 max，防止判得太高）、已经解决（`resolved`，6 题：道谢、接着提交、清理、问原因、写复盘；gold 是 low 或 medium）、换了话题或无关（`new-topic`、`unrelated`，7 题，其中一题是长对话里新报一个原因不明的 bug：gold 是 xhigh，不是 max）。命令轮（`command-turn`，3 题）混在里面：同一个问题改用 `/debug`、`/implement #19` 再跑一次，还有解决之后的 `/review`。gold 为 `max` 的 13 题是衡量最高一档召回的样本；其余的用来看判得太高。
- 有 10 题的对话超过现在发消息时 state 的预算（6000 token，`BACKEND_DEFAULTS.jev.contextTokens`），带标签 `over-budget`；校验会按 mod 自己的估算（`stateTokens`）核对：中英文都超过才算，标签和实际必须一致。这些题里早几轮的尝试落在预算之外：有的是用户贴了一大段日志（GC 日志、数据库日志、抓包），这一段本身就把预算占满，只剩最后一条回复；有的是每一轮都贴一份 CI 日志或查询计划，最早的一轮被挤出去。其中 `long-but-easy`（`unresolved-018`、`030`）是对话很长但问题已经解决的对照题：长不等于难。
- 标签另有：`hidden-history`（答案要靠更早几轮的尝试才看得出）、`pasted-log`、`pasted-error`（消息就是同一条报错）、`short-reply`（「再看看」）、`misleading-history`（前面有一个未解决的问题，但这条消息是另一件事）。
- 构造：对话文字是手写的，每个失败的尝试都是真实的做法（加长等待、fake timers、改隔离级别、换 poetry 等），中文版像中文用户写的，英文版是忠实的翻译。贴出的日志（`--trace-gc` 输出、PostgreSQL 死锁日志、tcpdump、jest 的 CI 输出、慢查询计划、diff）是用脚本按固定种子生成的、格式和真实输出一致的 ASCII 文本，两种语言里逐字相同；用 ASCII 日志是因为中文每字约一个 token、英文约四个字符一个 token，只有这样两种语言的 state 才都超过 6000 token。生成脚本不在仓库里（和上面「来源」一样，这份 JSONL 是唯一的数据源）；改题直接改 JSONL，再跑 `validate.ts`。
- 附加约定：
  - 「第几次」按用户的话和对话里的尝试数：第一次修复之后用户说没好，是第二次（`second-attempt`，gold high 或 xhigh）；三轮失败之后再提，才是 `max`。
  - 用户贴同样的报错、说「再看看」「你上次改的没用」，都算没解决。只有主 agent 自己说「已修复」不算解决，要用户的话确认。
  - 命令轮和普通消息一样算一次尝试。
  - effort 的标注依据仍是上面「effort 档位的含义」，不看主 agent 提示词里的档位描述。
- 评分（`lib/unresolved.ts`）：答案是 effort（`pickEffort`，`max` 要过 `thetaMax`），在 `accept` 里算对；三选一题的答案作为 `triage` 单独评分，整题仍以 effort 为准。汇总里另给三选一的准确率、混淆表，和 mod 现在的两档门槛对这些回答做的事（`change`：该加一的加了一、该清零的清零了，不是「仍未解决」的被加了一，「仍未解决」的被清零了，最后一项是丢掉一份记录）；另给：最高一档的召回（gold 为 `max` 的题里答成 `max` 的比例）、判得太高和太低各占全部题的比例、长对话和短对话分开的准确率与召回、各个 `thetaMax` 下的召回（按已存的各档概率重算）。变体：`zh-score`（Jev 的问法）、`en-score`（Clef 的），state 预算 6000，是 #38 之前 effort 题和 skill 题合在一个请求里时 effort 拿到的；带 `-wide` 的 state 预算 24000，是 #38 之后 effort 请求（ADR 0005）拿到的，也就是 mod 现在的请求。#38 之前跑的基线用的是不带 `-wide` 的，那时还没有三选一题。数据集没有问题摘要的字段：每题都按「一个问题的第一条消息」问，请求的 state 里没有摘要（摘要是便宜的模型逐轮续写的，对话记录里没有）；请求函数 `unresolvedRequest` 可以带一份摘要，要不要给各题配摘要是校准（#42）时的决定。

### long-context（#44）

量的是「决策模型读更多对话，effort 判断准了多少」：现有数据集里最长的对话只有约 8000 估算 token，state 预算从 24000 提到 48000、96000 请求逐字相同（#43），量不出更大窗口的价值。这个数据集的每一题把**决定答案的几轮**（之前试过哪些做法都失败了、早先约定了低成本做法、这块代码的硬性要求）放在对话**很早**的位置，后面接大段真实感的中间轮次，最后是用户的一条消息。**金标是起草者写的，用户尚未审。**

文件名 `long-context.jsonl`，30 题，**只有中文对话**（没有 `en`；英文问法是 suite 的变体，问题用英文写，对话仍是中文）。它**不是手改的 JSONL**：唯一的来源是 `eval/long-context-items.ts`（决定性几轮、词汇、消息、答案都在那里），`node dispatch-pilot/eval/long-context-gen.ts` 写出这个文件，`eval/validate.ts` 核对文件和它一致。

```json
"zh": {
  "message": "回到重连那个问题，我在弱网下又跑了一遍，还是会掉线。",
  "decisive": [ { "role": "user", "text": "……", "says": "new" }, { "role": "assistant", "text": "……", "tools": ["Edit"] } ],
  "vocab": { "area": "WebSocket 重连", "files": ["ws/reconnect.ts"], "symbols": ["scheduleRetry"], "terms": ["心跳"] }
},
"depth": 30000,
"gold": "max", "accept": ["xhigh", "max"], "triage": "unresolved",
"without": { "gold": "high", "accept": ["high", "xhigh"] }
```

- **`decisive`**：决定答案的几轮，手写，用户和助手交替，从用户开始、以助手结束。用户消息可带 `says`（`unresolved` / `resolved` / `new`）：这条消息对「它之前那个问题」说了什么，也就是三选一题对它的金标答案。`says` 是**未解决次数**的来源：`unresolved` 加一，`resolved`、`new` 清零，不带 `says` 的消息不动。中间轮次的用户消息都不带，所以到最后一条消息时的次数就是决定性几轮自己算出来的次数（`lib/long-conversation.ts` `unresolvedCount`）。
- **`vocab`** 和 **`depth`**：中间轮次不在 JSONL 里，是 `lib/long-filler.ts` 按种子（题号加 `vocab.area`）和 `vocab` 里的文件、符号、术语写出来的，每次一样；这样数据集只有 40KB，而不是几十 MB，每个版本的对话都能从题目重建。`depth` 是从消息往前数到决定性几轮**开头**的估算 token 数，取 30000、60000、120000 三档（各 10 题）；校验会把真的建出来的对话量一遍，要在 `depth` 的 97% 到 105% 之间。
- **中间轮次是什么**：用户在读和整理这块代码：这个函数是干什么的、这个值是怎么传的、跑一下测试（都通过）、改个名、补一段注释、列最近的提交、贴一段普通日志问是干嘛的、几句「好，往下走」。工具只有 Read、Grep、Glob、Edit、Bash，不带工具的输出。**它从不说任何一次尝试怎么样了**：没有失败、没有成功，没有密钥，没有被脱敏改写的东西（测试会查），所以「之前试过什么」只有决定性几轮里有，读不到那里就不可能知道。回复的长度有长有短（几个字的应答到约 3300 估算 token，平均约 1000，中位 860），每个回复由模板里的句子、代码模式（接口加函数、类、测试、switch、分块循环、配置表）和列表拼成。**它是模板生成的，不是真实对话**：粗看像一次代码阅读，细读会看出句式重复、代码没有逻辑。这是代价：几十万 token 的真实对话没有现成的，也写不出来。
- **三个版本**（`lib/long-conversation.ts` `conversationOf`；同一题的中间轮次逐字相同，顺序相同）：`deep` 决定性几轮在最前面，离消息 `depth` 个估算 token；`near`（对照 a）决定性几轮挪到离消息约 2500 到 5800 token 的地方，其余是同一批中间轮次，对话一样长；`none`（对照 b）决定性几轮整段删掉，只剩中间轮次，用 `without` 的答案评分。
- **答案**：`gold` / `accept` / `triage` 是对话里**有**决定性几轮时（`deep`、`near`、真实流程）的答案；`without` 是删掉之后的答案（单看那条消息会怎么判）。`without.gold` 和 `gold` 不同的题（占 70% 以上，校验会警告）才分得出「读到了」和「没读到」。
- **六个类别**（每题一个类别标签）：`repeated-failure`（10 题，gold `max`，accept `xhigh`/`max`：同一个问题已经按三四种办法改了三四轮，用户每次说没好；消息只说「还是…」）；`second-attempt`（4 题，gold `high`，accept `high`/`xhigh`：只改过一次，这是第二次，防止判得太高）；`agreed-low-cost`（5 题，gold `low`，accept `low`/`medium`：早先约定了这类小改动不用想太多，消息是一个小改动）；`looks-complex`（5 题，gold `medium`，accept `low`/`medium`：消息听起来是一大块工作，其实早先已经定了一一对应的清单和样板，每步机械）；`misleading-history`（3 题，gold `low`，accept `low`/`medium`：前面是反复未果的问题，但已经解决或放弃，消息是一件小事，防止被历史带高）；`hard-constraint`（3 题，gold `xhigh`，accept `xhigh`/`max`：早先说了这块是真金白银、生产不可回滚或会越权，消息听起来是一个小改动）。不只往高判：17 题 gold 在 `high` 以上，13 题在 `medium` 以下。
- **三选一题**（`triage`）：和 `unresolved` 数据集一样，effort 题旁边问三选一，单独评分；`says` 是它在对话里的金标。
- 标签 `difficulty`：`agreed-low-cost` 的 5 题是 `medium`，其余 `hard`。

**suite**（`lib/long-context.ts`）：请求是 mod 发消息时的 effort 请求（`turnStartPart` 加 `messageRequest`，和 `unresolved` suite 同一个函数），state 的预算和消息条数取 run 的设置：mod 的是 24000 token 和**最多 32 条消息**。**32 条消息也是一个限制**：对话每条消息平均约 500 估算 token，24000 token 的预算大约装 48 条，32 条先到（32 条只有约 16000 token）；所以 `run.ts --state-tokens N` 之外要加 `--state-messages M` 放开条数（这个数据集的扫描都用 2000），结果文件的 `settings.stateMessages` 记着。变体：

| 变体 | 请求 |
|---|---|
| `zh-score-deep`、`en-score-deep` | 决定性几轮在最前面，不带摘要和次数（state 就是对话加消息） |
| `zh-score-near`、`en-score-near` | 对照 a：同一批轮次，决定性几轮在末尾附近 |
| `zh-score-none`、`en-score-none` | 对照 b：决定性几轮删掉，按 `without` 评分 |
| `zh-flow`、`en-flow` | 真实流程：deep 的对话加 mod 在这个对话之后会有的问题摘要、未解决次数、达到 `unresolvedMaxAfter`（默认 3）时的强提示 |
| `zh-summary`、`en-summary` | 流程的一半：只带问题摘要（没有次数和强提示） |
| `zh-count`、`en-count` | 流程的另一半：只带次数和强提示（没有摘要，不需要摘要文件） |

`zh-` 和 `en-` 只是问题（effort 题、三选一题）用哪种语言写，对话都是中文。要用 `--languages zh` 跑（`en` 行没有对话，会失败）。每个回答的 `detail.seen` 记着这次的 state 里有没有决定性几轮（`recent_context` 里有它第一条消息的开头），`detail.stateTokens` 记着 state 的估算大小，`detail.kept` 记着留下几条消息；结果文件里每个回答的 `state` 是摘要（`stateDigest`：短字段原样，对话只记字符数、行数、第一行和最后一行的开头），因为一个 state 就有几十万字节。

**问题摘要**（`long-context-summaries.json`，`zh-flow` 用）：mod 在每个用户回合之后让便宜的模型续写问题摘要。`node dispatch-pilot/eval/long-context-summaries.ts` 对每题 deep 的对话逐轮做同样的事：用 mod 自己的 `summaryPrompt`、`SUMMARY_SYSTEM`、`readSummary`（同样的脱敏、截断、500 token 上限），模型是 `claude -p --model haiku`（用你自己的登录和订阅，写法同 `profiles.ts`），决定性几轮里用户消息的 `says` 照 mod 的两档门槛的作用移动摘要（`unresolved` 给最后一条尝试标「未解决」，`resolved` 和 `new` 清空重写）。每题存：摘要、次数、对话的指纹（对话或中间轮次变了，摘要就作废，suite 会拒绝用）、问了多少轮、几轮没有拿到摘要。没有文件、或指纹不对、或次数和决定性几轮算出来的不同时，`zh-flow` 的回答是失败，说明原因，**不编摘要**。

### eval v2（#45）

120 题的长对话，由多个 agent 写成：素材作者写**素材段**（`eval-v2/pool/`，一段一轮普通工作，3000 到 5000 token，`same-problem` 段用占位符代替问题的名字），出题作者写**题目**（`eval-v2/items/`，开头、决定性几轮、最后几轮，不含答案）和**出题者金标**（`eval-v2/gold-author/`），标注者双盲另写一份（`eval-v2/gold-labeler/`）。`eval/eval-v2-gen.ts` 按种子把素材段拼进每一题，写出 `eval-v2.jsonl`（几十 MB，不提交）和提交的 `eval-v2/generated.json`（种子、JSONL 的 sha256、每题的深度和长度）；`validate.ts` 每次重新生成并核对。文件格式、占位符、四个深度档、生成规则、检查命令都在 `eval-v2/FORMAT.md`，规则的代码在 `eval/lib/eval-v2.ts`；作者自查用 `node dispatch-pilot/eval/eval-v2-check.ts <文件或目录>`。

### visual-check（#65，spec #55）

量的是 `visual_check` 用的决策模型（Jev，或没有 TypeSafe 密钥时的 pplx）判看图核对判得准不准。**图和真值是 2026-10-15 实验里已有的**（`.scratch/visual-judge-experiment-2026-10-15/`，被 .gitignore 忽略），复制进 `visual-check/` 提交，没有新做实测；唯一重画过的是动画的 60 帧（每帧加了终点框，见下面「动画帧的终点」）。24 题，**没有 `zh` 和 `en` 两面**（决策模型读的是 mod 的英文问法，不分语言）；`difficulty` 的 `hard` 占 75%。图的路径相对 `visual-check/`，都是 PNG，`validate.ts` 核对它们都在，也提醒没有题用的图。

```json
{ "id": "ui-c1-radius", "kind": "ui",
  "asked": { "screenshot": "ui/c1.png", "reference": ["ui/ref.png"], "same_view": null,
             "checks": [ { "part": "the primary button (\"Upgrade to Premium\")", "property": "corner radius" },
                         { "part": "the tab bar at the bottom", "property": "number of tabs" } ] },
  "gold": { "holds": [false, true] },
  "rationale": "……", "difficulty": "hard", "tags": ["corner_radius"] }
```

| `kind` | 题数 | 图 | `asked` | `gold` |
|---|---|---|---|---|
| `ui` | 9 | 参考图 `ui/ref.png`（702×1519，iOS 的账户页），候选 `ui/c1.png`–`c9.png`：圆角 12→6、边距 16→24、颜色、按钮文字字重 600→400、一行图标右移 4px、一行图标没了、标题被截断、标签栏少一个标签，`c9` 与参考图完全相同 | `screenshot`、`reference`（一张或几张）、`same_view`（`null`：按宽高比推断，和 mod 一样）、`checks`（和 mod 的 `Check` 同形：`part` 点名部分，`property` 一个看得见的属性） | `holds`：每条检查项是否成立（这个部分和参考图一样）。每个候选另有一条没改动部分的检查项（应当成立），对照 `c9` 三条全部成立 |
| `sea` | 7 | 参考图 `sea/ref.png` 和候选 `fogNone`、`fogDense`、`big`、`calm`、`flat`、`noFoam`、`twin`（`twin` 是同一片海的另一个时刻，对照）；640×400 | 同上，三条检查项：浪高、浪花量、雾的浓度 | 取自实验 `sea/run.ts` 的 TRUTH 表 |
| `anim` | 5 | 一张卡片从左滑入的 12 帧，`linear`、`ease_out`、`spring`（回弹）、`janky`（中间几帧停住）、`wrong_end`（停在 x=140，离终点差 60px）；400×400，帧文件 `anim/<运动>-00.png`–`11.png`；**每帧都画出终点**（见下面「动画帧的终点」） | `frames`（每帧的文件和秒数，每 50 ms 一帧）、`spec`（规范：卡片从左滑入，终点是和卡片一样大、标着 TARGET 的绿色虚线框，画在最上层，卡片最后应当正好停在框里；文字里没有像素坐标）、`checks`（写成「应该是怎样」，用画面上看得见的东西：①右边缘没超过 TARGET 框的右边缘再退回来、②一直在动到 TARGET 框、③末帧正好落在 TARGET 框里） | `holds`，取自 `anim/truth.json` |
| `complexity` | 3 | 三组参考图：立方体（`effort/cube-*.png`，2 张）、海面（`sea/ref.png`、`refB.png`、`refC.png`，3 张）、城市（`effort/city-*.png`，4 张） | `references` | `level`（实验里读出的档：0、2、3）、`accept`（相邻的几档）、`rank`（复杂度的顺序，评测看三组读出来是不是这个顺序） |

- **对照。** 一题里每条检查项都成立（`gold.holds` 全是 `true`）就是对照，必须有标签 `control`，反过来也一样（格式的规则）：`ui-c9-same`、`sea-twin`，另有 `anim` 里没有毛病的 `linear` 和 `ease_out`。对照被判不过是误报，被判过是对的，没把握不算错。
- **`blind-spot` 标签。** `c4`（字重）和 `c5`（4px 偏移）是实验里放大复核也抓不到的（落在没把握），所以留在集里作为已知的盲区；只要它们没被判过，指标就不扣分。
- **真值文件。** `visual-check/ui/truth.json`（每个候选改了什么、改的地方的框）和 `anim/truth.json`（每种运动的 x 坐标和三个真值）是实验的原文件，原样复制，题目的 `gold` 由它们和 `sea/run.ts` 的 TRUTH 表来。
- **动画帧的终点。** 第一版的帧只有背景、左上角的帧号、一条横贯的灰线和卡片，终点只在文字里用像素给出（右边缘在 x=350），模型既要猜终点在哪，又要猜卡片有没有到过，15 条检查项全部没把握（基线）。现在每帧都把终点画出来：一个和卡片同样大小（150×170）、同样圆角（18 px）的绿色虚线框（`#14A44D`，3 px 虚线），左边缘 x=200、和卡片同一个 top（110），画在卡片上面（卡片停对时正好落在框里）；框上方（左边缘对齐，top 90）一行绿色小字 `TARGET`。其余不变：背景、帧号、灰线、卡片、每帧卡片的位置（`anim/truth.json` 的 `xs`，没改）。`spring` 回弹到 242（右边缘 392，越过框的右边缘 350），`wrong_end` 停在 140（右边缘 290，框内只盖住一部分）。
  - **帧是怎么生成的**：这类图一向没有提交生成脚本（上面说的「来源」同理），所以这次也没有：脚本在被忽略的 `.scratch/visual-judge-experiment-2026-10-15/anim-target/`（`card.html` 加 `build.ts`，无头 Chrome 经 CDP 按 `anim/truth.json` 的位置逐帧截图，400×400、缩放 1）。要重做就照上面的参数写一个页面：卡片按 `xs[运动][帧号]` 定位，终点框和 `TARGET` 的位置、颜色、大小如上，再逐帧截图覆盖 `anim/<运动>-NN.png`。真值不会变，因为它只取决于卡片的位置。
  - **要求的写法。** 规范和检查项不再给像素，只说画面上看得见的东西：TARGET 框和卡片的相对位置。文字在 `visual-check.jsonl` 的五条 `anim-*` 里，五条的规范和检查项逐字相同。
- **suite**（`lib/visual-check.ts`，变体 `mod` 和 `whole`）：请求和 mod 的逐字相同，细节、指标和花费见 DEVELOPMENT.md「评测」的「看图核对」。

## 来源

四个评测集起初在仓库之外用脚本生成（每类题一组生成脚本和校验脚本），审核后搬进这里。搬进来之后，这里的 JSONL 是唯一的数据源，那些生成脚本已经作废：改题直接改 JSONL（答案字段经审核记录和 `apply-review.ts` 改），再跑 `validate.ts`。
