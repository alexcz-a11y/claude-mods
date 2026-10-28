# Dispatch Pilot：派出 agent 的模型改由是非题和代码里的模型表定，主 agent 的指定只升不降

ADR 0014 按 TypeSafe 的官方指南重做了发消息时的判断，派出 agent（包括 Workflow 里的 `agent()`）选模型却还是 0.8.x 的做法：一道选择题「哪个是能把任务做好的最便宜的模型」，选项写着各模型适合什么工作，主 agent 的指定作为强提示写进题里，决策模型的选择置信度到 `agentOverride`（0.6）才推翻它。用户 2026-10-28 指出这是旧流程，没有按 TypeSafe 的 cookbook 和官网推荐做。TypeSafe 的要点：判断交给模型，决定写在代码里（每种回答组合都有它的那一行）；一道题只量一件事，「是」和「否」写成具体情形；是非题从 0.7 / 0.3 起步，中间带有自己的去向；置信度不是门槛。那道选择题把「要不要改东西、几步、要不要判断、出错代价、原因未知、要不要设计、靠不靠外部事实、是不是科学计算」这些判断揉进一个答案，又用置信度决定推不推翻主 agent。用户批准的做法：「按照你的建议来」，拿不准时「effort 至少 max」；主 agent 的指定不降级。

决定：

- **关于任务的是非题。** 派出 agent 的请求里，原来那道选择题换成十道是非题（开了 `agentFable` 十一道），英文，每道一个判断，点名它读的字段：`writes`（`brief.prompt` 是否要新建、修改、删除文件，或执行会改变什么的命令）、`few_steps`（一两次工具调用能否做完）、`report_only`（结果是否只是按要求收集、排版，没有要判断的）、`stakes.undo`、`stakes.live`、`stakes.access`（主 agent 那三道出错代价，改读任务）、`cause_unknown`（是否要追查任务里没写明原因的故障）、`design_open`（是否要 agent 自己选一个任务没给出的做法）、`outside_facts`（结论是否靠仓库和文档里查不到的外部事实，比如 API 的行为、标准、版本差异）、`science_code`（是否涉及数值、算法或科学计算代码），以及 `frontier`（严格证明，或没有现成答案的新算法、新架构，只在开了 `agentFable` 时问）。主 agent 的指定不进任何一道题。effort 题（Score）、点名和排除模型、点名 effort 的题不变，和它们在同一个请求里。
- **读法。** 是非题 ≥ 0.7 是、≤ 0.3 否，中间拿不准（`decision/nouls.ts`）。你点名、排除的模型和点名的 effort 也按 0.7 算（0.8.x 是 0.5）。没回答的题当否，什么都不抬。
- **模型表**（`decision/dispatched-agent.ts` 的 `tableRow`），从上往下第一条成立的那一行：① 你点名的模型；② 开了 `agentFable` 而且 `frontier` 为是，fable；③ 三道出错代价、`cause_unknown`、`design_open`、`outside_facts`、`science_code` 任一为是，opus；③b 这七道没有为是、但至少一道拿不准，sonnet，effort 至少 max；④ `writes` 否、`few_steps` 是、`report_only` 是，haiku（三道都要有回答）；⑤ 其余 sonnet。
- **排除的模型。** 表给的模型被你排除时，换成最近的可用模型：先往强的找（haiku < sonnet < opus < fable，可用的是 `agents.models` 里没被排除的），没有再往弱的找；都被排除时没有模型。
- **主 agent 的指定只升不降。** 主 agent（Workflow 里是脚本写的 `model`）指定了模型时，表给的（换过之后的）更强才换成表给的，否则保留它的指定，包括 `agentFable` 没开时它指定的 fable。你排除了它的指定，它就不算数，用表给的。`agentOverride` 选项和它的置信度门槛删了。
- **effort。** 你点名的 effort 照办，任何下限都不动它。否则从 effort 题的基础档起（和主 agent 同一个 `traceEffort`：位置四舍五入，双峰再高一档），按下限只抬不压、取最高：出错代价（难以挽回为是而且线上或权限为是 max，任一为是至少 xhigh，任一拿不准至少 high）、原因未知（是至少 xhigh，拿不准至少 high）、表停在 ③b 时 max，最后是模型下限（sonnet 和 opus 至少 medium）。前两条和发消息时的 R2、R3 是同一个函数（`stakesFloor`、`causeFloor`）。
- **看得见的依据。** 每一步记进决定的 `steps`，日志条目的 `trace` 就是它（ADR 0004，卡片不重算）：两步写每道是非题的概率和是、否、拿不准（`lookup-signs`、`careful-signs`），一步写表停在哪一行、因为哪几道题、排除换成了什么（`model-table`），一步写主 agent 的指定保留还是升级（`main-pick`），然后是 effort 的基础档和各条下限（`stakes`、`cause-unknown`、`unsure`、`model-floor`），你点名 effort 时最后一步写它（`named-effort`）。决策日志、看板 band 的理由和 Agent 工具结果后面给主 agent 的英文说明都按这些写。
- **请求的大小。** 一个 agent 11 到 19 道题，一个请求最多 64 道，所以合并请求里的 agent 从最多 8 个降到 4 个（`MAX_PER_REQUEST`；题多的由 `MAX_QUESTIONS` 再分），一个脚本最多 6 个请求（`MAX_REQUESTS`，原来 4 个），仍能问满 24 个调用。按 ADR 0014 的算法验算（Jev 计）：state 24000 估算 token 约 26,667，加最长的一题（effort 题约 454；那道选择题约 803，删了）是 27,121，在 32k 的 90%（28,800）以内；4 个题最多的 agent 合进一个请求是 26,667 + 4 × 3,916 = 42,331，在 64k 的 90%（57,600）以内。8 个会到 57,995，而且题数超过 64，所以降的是每个请求的 agent 数，不是 state 的预算（24000 不变）。
- **评测。** `subagent` suite 发的请求和 mod 逐字相同（ADR 0005），按同一张表读回答：变体改成 `nouls`、`nouls-single`、`nouls-zh`；0.8.x 的六个变体和门槛扫描删了，汇总里加上每一行定了多少题、模型对了多少。`eval/rescore.ts` 重算旧结果时模型按它们存下的回答，只重算 effort。这次没有跑任何付费评测。

考虑过的其他做法：

- **保留选择题，把置信度门槛换成读概率**（0.9.0 计划里第 4 阶段的做法）：选项里的工作类型仍揉着几个判断，看板说不出是哪一个让它选了 opus；官方的写法是一题一个判断、决定在代码里。
- **主 agent 的指定也可以降级**（表给的更便宜就换）：用户选了不降级。主 agent 写任务时看得到 Claude 这边的上下文，它指定的模型是一个判断；降级出错的代价（便宜模型做不好、重做）比多花一点贵。
- **拿不准时用 opus**：③b 用 sonnet 加 max effort，是用户批准的取舍：AA 上 sonnet 在终端和执行类工作上不输 opus，effort 拉满补上拿不准的那部分推理，比直接换 opus 便宜。
- **排除的模型按距离取最近、并列取便宜**（0.8.x 的 `nearestPick`）：排除一个模型不该让工作落到更弱的模型上，所以先往强的找。

代价：

- 没有重跑评测，新题和新表的准确率不知道。`subagent` 评测集按 0.8.x 的约定标注，`priority:main-overridden` 的 16 题里有 8 题的 gold 比主 agent 的指定弱（024、027、028、030、034、068、070、096），新规则只升不降，这 8 题的模型部分按设计会错。
- 每个派出 agent 的请求多九到十道题（十到十一道是非题换掉一道选择题，约多 900 估算 token，Jev 计约 1,200），一个请求放的 agent 少了一半，一起派出很多个时请求数翻倍（Jev 最多 4 个同时在途，再多就排队）。
- ③b 和出错代价、原因未知的下限只抬不压：一部分 agent 会比以前用更高的 effort，拿不准的 sonnet 直接 max，更贵。
- 主 agent 给简单任务指定了贵的模型时不再降下来，省不到这部分钱。
- 存下的 `agentOverride` 设置不再起作用（选项从 manifest 里删了）。

版本号保持 0.9.0（和 ADR 0013、0014 是同一个版本）。

后来 ADR 0017 加了可选的 d1-ultra：选它时不用模型表，改按 Liquid 官方的路由示例问一道选择题（`route`：fast、standard、powerful，开了 `agentFable` 加 frontier），置信度低于 0.5 退到最强的可用模型；只升不降、点名和排除照旧，线是 Liquid 的 0.8 / 0.2。模型表仍是 Jev 和 pplx 的做法。
