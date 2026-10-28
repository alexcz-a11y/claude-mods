# Dispatch Pilot：按 TypeSafe 的官方指南重做发消息时的判断：Jev 默认、英文、常规上限、是非题和写在代码里的规则

2026-10-28 用户的决定：「全部按照官方的指南来改，忽略我们自己的测试的分数阈值，推翻」；「我们不测试 pplx 模型，我们只谈 jev 模型，将 jev 调整为默认模型」。TypeSafe 的指南（typesafe-ai skill 和 docs.typesafe.ai）要点：判断交给 Jev，决定写在代码里（每种回答组合都有它的那一行）；是非题（Noul）从 0.7 / 0.3 起步；置信度不是门槛；打分题（Score）的加权位置会把两头的概率平均到中间，要看各档概率；代码知道的事实放进 state，不写进题里；没有内容的字段不发；英文是 Jev 最准的语言；长上下文比留在常规上限里慢、也不那么准；一道题只量一件事，判据写成具体的情形。

决定：

- **决策模型。** `decisionModel` 默认 `jev`；`pplx` 只在用户显式选它时用，0.9.0 起不再评测。不按密钥自动换：所选模型没有 key 时不发请求，每一轮按会话自己的 effort 走，看板写明缺哪个 key。图像功能照旧要 TypeSafe 的 key（没有时用 Perplexity 的 key，不能放大复核）。
- **英文。** 两个决策模型的所有问题都用英文问（发消息时的 effort part 和派出 agent 的题以前对 Jev 用中文）。
- **常规上限。** 发消息时的 effort 请求、派出 agent、Workflow 的 state 都是 24000 估算 token（`JEV_REGULAR_STATE`）：加上最长的一题（effort part 约 504、agent 约 803，Jev 计）不超过 32k 的 90%，8 个 agent 合进一个请求也不超过 64k 的 90%，所以默认不带长上下文请求头。请求头和 3000 毫秒的等待只留给合并后超出常规上限的 agent 请求。
- **effort part。** effort 题只量一件事：这项工作需要多少逐步推理；「这项工作」是主 agent 为这条消息做的全部事情，直到它下次停下来等用户。题面不再提「之前多次没解决」「难以挽回」。旁边八道是非题：`stakes.undo`、`stakes.live`、`stakes.access`（出错代价）、`cause_unknown`、`still_failing`、`solved`、`new_task`、`constraint`。每道的「是」和「否」写成具体的情形；题面用反引号点名它读的 state 字段，`standing_constraints`、`last_turn` 只在 state 里有时才点名。报告开始的一轮只问 effort 题、三道出错代价和原因未知。
- **读法。** 是非题 ≥0.7 是、≤0.3 否，中间拿不准。基础档 = min(floor(位置 + 0.5), max)；比基础档高两档以上的某一档 ≥0.3（双峰）再高一档。置信度只记录。下限（只抬不压，取最高）：R1 消息里写了 `ultrathink`（不在引号、代码块或路径里）至少 xhigh；R2 难以挽回为是而且线上或权限为是 max，任一为是至少 xhigh，任一拿不准至少 high；R3 原因未知为是至少 xhigh，拿不准至少 high；R4 `still_failing` 为是而且上一条消息开始的一轮卡住了（失败到了 `escalateAfter`），至少那一轮再高一档；R5 `still_failing` 为是而且未解决次数（算上这一条）≥ `unresolvedMaxAfter`（0 从不），max。锁定优先于一切。派出 agent 用同一个基础档加模型下限，不设置信度门槛；`agentOverride` 不变。删掉 `thetaMax`、`roundUp`、`hintThetaMax` 和带强提示的那道题。看板的规则推演写出每一步，从不重算（ADR 0004）。
- **state 和记忆。** `last_turn`：上一轮有失败或被拦下的调用时才发（effort、tool_calls、failed_calls、hook_blocked_calls、reached_escalate_after、last_errors）。未解决次数一直在数，没有开关：`still_failing` 为是加一（并标摘要的最后一次尝试）；`solved` 为是，或 `new_task` 为是而 `still_failing` 为否，清零（连同摘要）；其余不变；`/clear` 和新会话清零，压缩和热重载保留。`standing_constraints`：`constraint` 为是时原样记下用户的话和前一条助手消息的最后一段（都脱敏、截短），最多 5 条，旧的先丢，`/clear` 和新会话清空，没有时不发，报告的一轮不记。问题摘要有自己的开关 `summary`（默认开），用英文写，以有名字的字段发送（`problem`、`tried[].text`、`tried[].unresolved`、`status`）。原来的 `unresolved` 开关去掉了，存下的设置不再起作用。
- **一轮进行中贴图的消息只判一次。** 它在送进这一轮之前按文字定档，不读图、不再判第二次：图读完再判的那一次可能落在只带工具结果的一步上，在 2.1.312 上不生效，看板却会写着它（ADR 0013）。看板上不记引擎不会用的档。
- **评测。** 各 suite 发的请求和 mod 的逐字相同（ADR 0005）：`effort-submit` 的 `en-score`、`unresolved` 的 `en-score-wide`、`long-context` 和 `eval-v2` 的 `en-flow`，读回答用同一套规则。流程文件和长对话的摘要可以用 `claude -p --model haiku` 按新的英文提示重写（`eval/eval-v2-flow.ts --no-cache`、`eval/long-context-summaries.ts --force`）。三选一门槛的扫描工具删了。这次没有跑任何付费评测。

考虑过的其他做法：

- **保留我们调出来的门槛**（Jev 的 `thetaMax` 0.5、往上取一档 0.3、`hintThetaMax` 0.4；pplx 的 0.47、0.45）。它们是在我们自己的评测集上、对着当时的措辞调的，题一改就不再成立；用户选官方的起始规则。
- **保留强提示那道题**：指南要求决定写在代码里，R5 做的是同一件事，而且看板能说出原因。
- **保留长上下文的 96000**：ctx30 上更好（25/30 对 13/30），eval v2 上不比 24000 好；官方说长上下文更慢、更不准。更早的几轮改由摘要、长期约束和上一轮的情况带进来。
- **保留 pplx 默认或按密钥退回**：用户只谈 Jev；按密钥悄悄换模型，等于让一个人在不知情时被另一套没评测过的回答路由。
- **排队带图的消息限时等读图再判**：引擎只在带输入的那一步认 effort，等读图（最多约 3 秒）既拖住这条消息，赶不上时仍会写出不生效的档。

代价：

- 没有重跑评测，新题和新规则的准确率不知道。0.8.x 在 `effort-submit` 上中文问法比英文高约 8 个百分点（各 1–3 次）；这次按官方指南改回英文，题也一起改了，那组数字不能当 0.9.0 的准确率。
- 每个发消息时的请求多八道题（约 1,500 估算 token，每条消息约多 0.00006 美元），延迟几乎不变。下限只抬不压，出错代价那几道题会让一部分消息判得更高、多花一些。
- 只有 Perplexity 的 key、没设 `decisionModel` 的用户，升级后不再路由，直到补上 TypeSafe 的 key 或把 `decisionModel` 设成 `pplx`。
- 长会话里更早的几轮决策模型读不到原文，只能靠摘要、长期约束和上一轮的情况。
- `unresolved` 开关去掉后，摘要对所有人默认开：每轮多一次 haiku 调用，用的是用户自己的 Claude 用量。

版本号保持 0.9.0（和 ADR 0013 是同一个版本）。

后来被 ADR 0015 改了：派出 agent（包括 Workflow 里的）的模型不再是一道选择题，改成十道关于任务的是非题加代码里的模型表；主 agent 的指定只升不降，`agentOverride` 删了；派出 agent 的 effort 在基础档和模型下限之外，也按出错代价、原因未知和「拿不准」那一行（max）往上抬；一个请求最多放 4 个 agent（原来 8 个），state 仍是 24000。

后来又有两处补充：ADR 0016 在你本人的消息里加了 `confirm`（只是同意或继续：至少沿用上一轮的档位）和 `escalate`（要求多想：至少 xhigh）两道是非题，`solved` 的「否」点名了「只是同意不算解决」；ADR 0017 加了可选的 d1-ultra，它的回答按 Liquid 的读法读（> 0.8 / < 0.2，effort 置信度低于 0.5 往上一档），上面的 0.7 / 0.3 和双峰只管 Jev 和 pplx。
