# Dispatch Pilot：一轮中途也可以按步数再看 effort：默认关，想换档要两次看都同意

2026-11-11 用户的决定：「给到一个按照步数换挡的开关以及自定义步数 你列出的几类事件也保留」。ADR 0020 定的是只在事件上看、不定时；这一条在它之上加一个可选项，事件上的做法不变。

## 为什么现在要

ADR 0020 的事件里，「任务清单换到下一项」在新模型上不再出现。Claude Code 的官方记录（2026-11-11 读 `CHANGELOG.md`、`tools-reference.md`、`env-vars.md` 的原文）：

- 2.1.233：「Todo/task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) are no longer available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models; set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to bring them back」。
- 2.1.268：「Changed the task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) to be offered only on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, Haiku 4.5; set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` elsewhere」。
- tools-reference 的理由：「On newer models, Claude keeps track of multi-step work without a written checklist, and the tools' definitions and reminders take up context.」有这组工具时默认是四个 Task 工具，`CLAUDE_CODE_ENABLE_TASKS=0` 才换回 `TodoWrite`。
- 本机近 20 天的会话记录里没有一次 `TodoWrite`、`TaskUpdate`、`TaskCreate` 调用，只有 Desktop 的 `mcp__ccd_turn__update_plan`（最后一次在 2.1.309）。

所以没有失败复现、没有 skill、没有报告的长循环里一个事件也没有，档位就是发消息时定的那一档（ADR 0020「代价」里写过的那一条，现在成了常态）。

## 决定

- **开关 `midrun-steps`，默认关**；选项 `midrunEverySteps`，默认 15，范围 6 到 60。打开后，主 agent 的一轮里离上一次看档位（任何事件上的，或这一轮开始）满这么多步而没有事件时，再问一次。15 的依据是本机记录里思考量按约 10 步一段才有持续性（这一段重、下一段也重 41%，基准 21%），单步预测不了下一步（`docs/research/effort-switch-timing.md` 8.5）。
- **问法不变**（按 TypeSafe 的 skill 重新过了一遍）。同一个请求、同一道 `midrun.level` 和同样的是非题，不加「该不该换档」这种把决定交给模型的题，也不加「比现在这一档多吗」的相对题。不给这次看写事实句：题面已经写明不按这一轮跑了多久来评，「又走了 15 步」是没有题用得上的字段，TypeSafe 的 state 指南说这样的字段会带偏别的题。不放当前档。题面一个字没改，`effort-midrun` 的旧题不用重跑。
- **上下文不扩大**：这一轮的消息、最近 8 步、代码数好的事实句，上限 4000 token。这一档只管到下一次看，用不着知道整个任务还剩多少；两家的文档都写明 state 越长越慢、越不准。
- **读法加一条：想换档要两次看都同意**（`decideMidrun` 的 `mid-hold`，`why: 'confirm'`）。按步数的这一次没有事件在后面，多数时候该保持：现在的规则在该保持的题上对 91–93%，一次看有 7–9% 被误动，100 步的一轮每 15 步看一次，至少误动一次约四成。所以第一次读数想换（升、回到原档、降一档）时不换，只记下方向，4 步之后再问一次，两次方向一致才换；中间来了事件，按事件的规则走，等着的方向作废。出错代价为是的升档不等（红旗取最高，当场升）。没有新造门槛数字。
- **各记各的次数**。按步数的看每轮最多 12 次，和事件上的 12 次分开数，也不占事件的 4 步间隔：先写成共用时，一次按步数的看会把两步之后加载的 skill 挤掉（测试里看到的）。追加换档每轮最多 4 次仍是一个上限。
- **不加 Haiku 总结**。ADR 0020 已经写过：两家都没有「先让便宜的 LLM 压缩、再让决策模型判」的官方模式，TypeSafe 自测读 agent 轨迹 Jev 71.6%、0.5 秒，Haiku 4.5 是 57.2%、7.1 秒。本仓库的未解决次数评测里只带摘要几乎不动结果。摘要还把证据换成转述，而题面要求按工具结果判断、不按助手自述。它唯一补得上的是「中段发生了什么」，帮的是「剩下的是不是长段机械工作」这类降档判断，那是决策模型最不准的一类（0.8.x 批量机械题 28 个回答对 11 个）。
- **任务清单的事件留着**：设了 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 的会话和宿主的计划工具仍会用到。

## 代价和没做的

- 没有评测。`effort-midrun` 的 122 题都是事件上的题，「两次都同意」这条规则值多少没有量过；要量得补一批没有事件的题（多数答案是保持），再用 TypeSafe 的 key 跑。
- 确认要多等 4 步：该升的档晚 4 步才升。
- 每 15 步多一次决策请求（Jev 约 0.3 秒，发生在那次工具调用结束时）。
- 默认关：不打开就和 0.11.x 一样。

版本 0.12.0。改的是 ADR 0020「只在事件上判，不定时」和「不做的：定时重判」两条：定时仍不是默认，打开后也不按 0.8.x 那样一次读数就换。
