# 评测集的约定

这里的四个评测集是 Dispatch Pilot 评测（`eval/`，见上一级的 README「评测」）的题目。每题怎么写、答案怎么标，都按这份约定；新加题、改题也照此。校验规则在 `eval/lib/datasets.ts`，`node dispatch-pilot/eval/validate.ts` 逐条检查。

这份约定来自评测集起草时的两份说明（起草时的「README」和「SOURCES.md」，当时放在仓库之外）。审核总结（`eval/review/*.review-summary.md`）里说的「README 档位表」就是下面的「effort 档位的含义」，说的「SOURCES.md 的附加约定」就是下面各类题的「附加约定」。

## 文件

| 文件 | 评测的是 | 票 |
|---|---|---|
| `effort-submit.jsonl` | 发消息时主 agent 的 effort | #4 |
| `effort-midturn.jsonl` | 一轮中途重新判断主 agent 的 effort | #14 |
| `subagent.jsonl` | 派出 agent（普通派发，以及 Workflow 里的 `agent()`）的模型和 effort | #15 |
| `skill.jsonl`，加上 `skill-catalog.json`、`skill-profiles.json` | skill 匹配（用本机真实的 skill 目录出题） | #16 |

每个文件约 100 题，每行一个 JSON 对象，UTF-8，不加注释。

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

### effort-midturn（#14）

```json
"zh": {
  "message": "本轮用户消息原文",
  "step": 7,
  "current_effort": "medium",
  "counts": { "judgments": 2, "changes": 1, "failures": 0, "hook_blocks": 0 },
  "recent_steps": [
    {
      "assistant_text": "主 agent 这一步最后写的文字",
      "tools": [
        { "name": "Bash", "result": "失败：npx vitest run duration：7 个新用例失败", "input": { "command": "npx vitest run duration" } }
      ]
    }
  ]
}
```

- 每题是一段真实执行轨迹的片段，问的是「下一步应该用哪档 effort」：标的是从这一步到下一次重判之前的工作需要的档位。`recent_steps` 按时间顺序，最后一项是最新的一步。
- 覆盖：任务从探索转入实现、从实现转入收尾（应降档）；连续失败、方向错误（应升档）；工作内容没变（应保持）；刚升档不久；`current_effort` 已经是 `max` 或 `low` 的边界情况。
- `gold`：一个 effort 档位；`accept`：档位数组。
- 附加约定：
  - `step` 是即将发出的那个 `turn.step` 的下标，从 0 开始，和 `e.index` 相同。
  - 每个调用的 `result` 以「成功：」「失败：」「被 hook 拦截：」「用户拒绝：」开头（英文版是 `Success: `、`Failed: `、`Blocked by hook: `、`Denied by user: `，和 mod 写的一样，见 `hooks/decision/midturn.ts` 的 `OUTCOME_WORDS`），后面是人写的「做的是什么、结果如何」。中英文两版同一个调用的结局相同。
  - 每个调用的 `input`（第 1 轮审查后加上）是这个调用说明自己做的是什么的参数，只取 mod 的 `toolDetail` 读的那几个（`DETAIL_KEYS`：`description`、`skill`、`name`、`file_path`、`notebook_path`、`pattern`、`query`、`url`、`command`），不写它写进去的内容（`content`、`new_string`）和返回的任何东西；没有可写的（TodoWrite、ExitPlanMode、按脚本启动的 Workflow）写 `{}`。评测按 mod 的写法把它和 `result` 开头的结局写成一行发出去（`成功：utils/duration.ts`），`result` 后面「结果如何」的部分 mod 从来不发，只留给审核和标注（`raw-results` 变体照原文发，用来量这部分信息的影响）。
    - 路径、命令、搜索的模式、网址在中英文两版里相同；`description`（模型自己写的几个字：Bash 调用的说明、Agent 的任务描述）跟着各自的语言写。
    - Bash 调用：`result` 写出了命令的，`input` 是 `command`；`result` 只用文字说明做了什么的（「只读查询」「压测 10 分钟」），`input` 是 `description`，就是那句说明。真实的 Bash 调用多半两样都有，mod 发的是 `description`，评测集里只有一样，这是已知的差别。
    - `input` 是起草之后补写的：照 `result` 里写到的文件、命令和搜索还原；`result` 没写全的（只写了类名的文件、Grep 的模式、WebFetch 的网址），按题意补一个合理的值。
  - `counts.failures` 是自上次清零以来（这一轮开始，或上一次强制升档）的失败次数，和 mod 的计数同义；hook 拦截和用户拒绝不计入。
  - `accept` 最多两档宽；降两档以上时不接受「保持当前档」；因为真实的失败或新发现的大问题而升档时，也不接受「保持」。
  - 「每题都保持当前档」能对 52%，这是常数基线。
  - midturn-006、017、051、053、056、057 的 `failures` 已到 2，正是强制升档再判断的时刻（评测的 `trouble` 变体这几题照 #7 的请求发）。006 的两次失败都是计划内的 TDD 红灯，标「保持」：按用户的拍板（issue #1），失败是不是预期内的由决策模型判断，预期内的不强制升档。

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
- `skill-profiles.json` 是快照里每个 skill 的画像，键和值都和 mod 存进 `$.store` 的一样（`eval/profiles.ts` 写）。
- 答案：`"gold": ["skill-a"]`（最该推荐的 skill，按优先顺序；空数组表示「不该推荐任何 skill」）；`"accept": ["skill-a", "skill-b"]`（推荐了其中任何一个都算对）；另有两个字段：
  - `"must_not": ["skill-x"]`：推荐了就算错的 skill（典型的是看起来相关、其实不适用的干扰项）。
  - `"user_only_hint": ["skill-y"]`：只能由用户本人触发（`disable-model-invocation: true`）、应该在状态行提示用户而不是推荐给主 agent 的 skill。
- 覆盖：中文请求对上英文描述的 skill；没有任何 skill 相关（至少 20%）；几个 skill 部分相关；名字相近的干扰项；只能由用户触发的 skill（至少 10 题）。`near-duplicate`、`lexical-trap` 标签按 skill 家族标。

## 来源

四个评测集起初在仓库之外用脚本生成（每类题一组生成脚本和校验脚本），审核后搬进这里。搬进来之后，这里的 JSONL 是唯一的数据源，那些生成脚本已经作废：改题直接改 JSONL（答案字段经审核记录和 `apply-review.ts` 改），再跑 `validate.ts`。
