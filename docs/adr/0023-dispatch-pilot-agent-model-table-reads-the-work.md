# Dispatch Pilot：派出 agent 的模型表重做，每道题读工作本身而不是话题；失败时可以只升 effort 不换模型

ADR 0022 重定了发消息时的 effort，没有动派出 agent 的模型表（ADR 0015）。那次评测里 Jev 用这张表选模型只对 65% / 64%（`subagent`，中文题 / 英文题），判高为主：200 个回答里该用 haiku 的有 47 个给了更强的模型。用户 2026-11-11 要求：「按照同样严格的标准 /typesafe:typesafe-ai 重做一下模型表 然后给mod加一个选项 不再派出模型后做任何模型切换 出错和主模型一样只升档不换模型（如果已经有这种选项则不加避免重复）」。

「同样严格的标准」照 ADR 0020、ADR 0022 的做法，这次多了留出的题：用 mod 自己的请求在 Jev 上跑，逐条看错在表的哪一行、哪道题；候选题和 mod 的题放进同一个请求对比（TypeSafe 的做法）；先只在奇数题号的 50 题上调，偶数题号的 50 题留着验证；再让一个没看过题面和规则的 agent 按评测集的标注规则另写 48 道新题，作最后的检验；独立代码审查；真实会话验证。

旧表错在哪（2026-11-11，Jev，`nouls`，200 个回答里模型错 71 个）：

- **该用 haiku 的给了 sonnet（28 个）。** 第 ④ 行要「不写东西、一两步、只汇报」三道都答到，200 个回答里它只成立了 1 次。评测集里 haiku 的工作是「不需要判断」：搜索并列出、跑命令并汇报，也包括照明确规则做的机械改写（改 CHANGELOG 的格式、批量重命名、合并 JSON）。`few_steps` 对要跑很多次搜索的查找读成否，`writes` 和 `report_only` 对机械改写读成否。
- **该用 sonnet 的给了 opus（15 个），另有 3 个该用 haiku 的也给了 opus。** `outside_facts` 单独定下的 14 个回答里 13 个是错的（把「用了一个外部工具」读成是）；`stakes.access` 把「在登录逻辑里加一个字段」读成是；`cause_unknown` 对任务里已经给了排查步骤的调试也读成是。
- **该用 opus 的给了 sonnet（9 个）。** 安全审计、判断一个 PR 能否被利用、并发正确性的审查，七道题里没有一道读它们。
- **主 agent 的指定只升不降（16 个）。** 主 agent 给纯汇报的工作指定了 opus 或 fable，表给 haiku，按 ADR 0015 保留它的指定。这是用户当时的决定，这次不动。

第一版新题在调参的 50 题上模型对 94%，留出的 50 题只有 64%。看留出题的错，原因是一条：新题读的是话题，不是工作。评测集的原则是「评工作量而不是话题」（标签 `scary-topic-small-work`）：「列出代码里所有读取密钥的地方，只列事实」是 haiku 的工作，「按给定清单给支付回调写测试」是 sonnet 的工作，而「安全」「并发」两道题对它们都读成是。之后的两轮改的都是这一点。

决定：

- **题。** 关于任务的是非题从十道变成十二道（开了 `agentFable` 十三道），仍是一题一个判断、英文、点名它读的字段、「是」和「否」都写成具体情形：
  - 定 haiku 的两道：`judges`（这项工作是否需要 agent 自己做出判断）、`logic`（是否需要读懂程序代码的逻辑）。`writes`、`few_steps`、`report_only` 删了。
  - 定 opus 的六道（`HARD`）：`diagnosis`（任务是否把「怎么找出故障原因」留给 agent 自己去想；任务给了排查步骤的不算）、`design_open`（id 保留，题面改成：是否要设计我们自己系统的各部分怎样配合；对比文档选一个现成的库不算）、`security`（是否要 agent 自己想出代码或系统可能怎样被攻击；逐条核对任务列出的检查点、只列事实、实现写明做法的安全改动都不算）、`concurrency`（要做对是否取决于想清楚并发和时序会出什么错；按给定清单写测试、运行模型检查器并汇报、只描述这类代码都不算）、`money`（是否要 agent 自己弄清一段算钱或记账的逻辑对不对；按写明的规则实现计费不算）、`science_code`（题面收紧为编写或检查数值计算、科学计算代码；通过 API 调用数学库或密码库不算）。`outside_facts` 删了。
  - `stakes.undo`、`stakes.live`、`stakes.access`、`cause_unknown` 照旧问，题面不变。
  - 每道「否」里写明同一个话题下只是照做的那类工作：这是 TypeSafe 说的「把容易混的情形写进判据」，写的是一类工作，不是某一道评测题。
- **表**（`decision/dispatched-agent.ts` 的 `tableRow`），从上往下第一条成立的那一行：
  - ① 你点名的模型。
  - ② 开了 `agentFable` 而且 `frontier` 为是，fable。
  - ③ `stakes.undo` 或 `stakes.live` 为是（agent 自己做的事收不回来，或者自己动线上）；或者 `judges` 不为否，而且六道 `HARD` 任一为是：opus。
  - ④ `judges` 为否而且 `logic` 为否（两道都要有回答）：haiku。
  - ⑤ 其余 sonnet。
- **`judges` 为否时，`HARD` 为是不算**（记在这一步的 `disarmed` 里，日志和卡片写「读成是，但这项工作不用判断，不算」）。不用判断的工作不会需要 opus 的推理；两者矛盾时，留出题上三次都是 `judges` 对。题面改好之后这条规则在原来的 100 题上不起作用，在 48 道新题上多对 2 个回答，在第二轮较弱的题面上多对 4 个：它是题面读偏时的第二道保险。
- **③b 行删了。** 拿不准的题不让任何一行成立：不给 opus，也不挡 haiku。它原来的用处是把 effort 抬到 max，ADR 0022 已经去掉。
- **`stakes.access` 和 `cause_unknown` 不再定模型**，只管 effort 的下限（ADR 0022 的规则不变）。「改动认证代码」是话题，要不要 opus 看 `security`；「原因未知」里要 opus 的是没有给排查办法的那一种，看 `diagnosis`。
- **主 agent 的指定仍然只升不降**（ADR 0015，用户的决定）。排除的模型、点名的模型和 effort 的规则都没变。d1-ultra 和 d1.1 仍按 Liquid 的路由选模型（ADR 0017），这张表不用于它们，路由的题面没有改。
- **失败时只升 effort 不换模型：用现有的 `escalateLimit`，不加新选项。** `escalateLimit` 设成 0 本来就不换模型，缺的是另一半：那时 effort 也只升一次。现在凡是换不了模型的时候（`escalateLimit` 是 0、已经换满、已经是最强的模型、你点名了模型），失败每累计到 `escalateAfter` 次就把 effort 再升一档，直到 max（`features/escalation.ts` 的 `countAgent`）。默认值（2）不变：先升一档 effort，再换模型，换满之后继续升 effort。Workflow 里的 agent（引擎不让给它追加行）和 `midrun-effort` 关着时中途升不了 effort，`escalateLimit` 是 0 时它们失败什么都不变。effort 或模型升过的那一步里再到门槛，只把计数重新开始，不再升（记录的 `effortStep`、`raiseStep`）：新的档或模型还一步都没用过。

考虑过的其他做法：

- **保留 `report_only`，只去掉 `few_steps`**：`report_only` 对机械改写仍然读成否（改 CHANGELOG 的格式 0.06、批量重命名 0.18），这些评测集里是 haiku 的工作。
- **只问 `judges`，或只问 `logic`**：只问 `judges`，照规格写代码的工作会给 haiku（评测集和 Anthropic 的文档都说小模型不写代码）；只问 `logic`，不读代码但要判断的工作（核对译文、比较方案）会给 haiku。调参的一半上，只问 `judges` 比两道一起少对 6 个回答，只问 `logic` 少对 2 个。
- **`money` 用最初的问法（「这项工作是否决定金额算得对不对」）**：按写明的规则实现计费的工作也读成是，对的和错的几乎相抵。改成问「是否要 agent 自己弄清这段逻辑对不对」之后，296 个回答里读成是的 8 个全是该用 opus 的。
- **`HARD` 只在 `judges` 为是时才算**：`judges` 拿不准（0.54–0.57）的一道设计题会丢掉 opus。拿不准时偏向更强的模型。
- **`diagnosis` 也用来定 effort 的下限，去掉 `cause_unknown`**：下限的规则是 ADR 0022 刚按评测定的，两道题读的东西不一样（原因有没有写明；排查的办法有没有给），不合并。
- **主 agent 的指定高两档、表给 haiku 时降下来**：评测集的规则是这样（「差两档……就推翻」），会多对 10 个回答。它推翻的是用户在 ADR 0015 里的决定，这份 ADR 没有做，留给用户定；用户看了数之后定了要降，见 ADR 0024。
- **加一个新的开关「不换模型」**：和 `escalateLimit` 0 重复。

代价：

- 每个派出 agent 的请求多两道题：一个 agent 13 道（开了 `agentFable` 14 道，你的话提到四个模型、带 effort 字眼时最多 23 道），全部约 3,990 估算 token（Jev 计约 4,430；原来约 3,920）。4 个 agent 合进一个请求是 26,667 + 4 × 4,430 ≈ 44,400，在 64k 的 90%（57,600）以内；你的话提到一两个模型时一个 agent 就有 17 到 21 道题，一个请求只放得下 3 个（最多 63 道题），所以一个 Workflow 脚本最多发的请求数从 6 个加到 8 个（`decision/workflow.ts` 的 `MAX_REQUESTS`），24 个调用仍能问全；四条车道，仍是两轮。你的话提到四个模型、又开了 `agentFable` 或带 effort 字眼时（22 或 23 道题）一个请求只放 2 个，超出 16 个的调用在各自启动时再决定（重做之前这种情形一个请求放 3 个，超出 18 个的在启动时决定）。
- 给 haiku 的 agent 变多：原来 200 个回答里表的第 ④ 行只成立 1 次（跑在 haiku 上的 11 个，其余来自点名和主 agent 的指定），现在每 100 个回答约 24 个停在第 ④ 行、22 个跑在 haiku 上。Anthropic 的文档提醒小模型在长的 agent 循环里会提前停下交回；真实会话里见过一次（「反复跑到通过为止」的任务，haiku 失败五次后交回了）。
- 少了 `outside_facts`：结论靠模型对外部库、标准的记忆的工作不再因此给 opus。AA 上两个模型在事实知识上差得多（Omniscience 40 对 19），但这道题从任务的文字里判断不出来，评测里它单独定下的 14 个回答只有 1 个是对的。
- 这些题面是看着这 100 题的错改的，原评测集上的数字是调过的题上的数字。没被调过的只有新写的 48 题在加 `money` 之前的那一次（43 / 48）；`money` 是看了那一次的错之后加的。
- 存下来的旧日志条目（③b、`writes` 等字段、③b 的 `unsure` 下限）卡片仍按它们当时的意思读（`board/rationale.ts` 留着旧字段的名字和旧步骤的写法）。旧的评测结果文件不受影响：`eval/rescore.ts` 不重算模型，照存下的读；`eval/lib/subagent.ts` 的 `redecide` 遇到重做之前存的回答会报错，不会把它缺的题当成没回答悄悄重判。

验证：

- `subagent`（100 题，Jev jev-1.14.0，`nouls`，3 次，中文题 / 英文题）：模型对 90.0% / 89.3%，effort 对 82.3% / 82.3%，两样都对 82.3% / 82.3%。改之前（0.11.0 的旧表，1 次）：65% / 64%，67% / 65%，58% / 56%。三次之间最多差 1 个百分点。题面用中文问（`nouls-zh`）：模型 91% / 92%，两样都对 82%–85%。结果在 `eval/results/subagent/2026-11-11-jev-table3-x3.json`（`table2-x3` 是加 `money` 之前）。
- 剩下的模型错（三次共 600 个回答里 62 个，每 100 个约 10 个）：48 个是「只升不降」保留了主 agent 过高的指定（每 100 个 8 个）；表自己错的 14 个：两道 haiku 题的 `judges` 或 `logic` 拿不准，给了 sonnet（12 个）；一道 sonnet 题（列出升级 Node 要改的地方）的英文版三次里有两次给了 haiku，它的 `judges` 和 `logic` 都在 0.3 上下。该用 opus 的没有一个给了更弱的模型。
- 新写的 48 题（都没有主 agent 的指定和点名，只看表；另一个 agent 按评测集的标注规则写，没有读过题面、规则和这份 ADR）：加 `money` 之前 43 / 48（中文题、英文题相同），之后 45 / 48；题面用中文问 47 / 48。错的是两道 haiku 题给了 sonnet、一道 opus 题给了 sonnet（两道设计类的题都拿不准）。
- 真实会话（Claude Code 2.1.322，主 agent Sonnet 5.5，决策模型 Jev，`claude -p`）：一条消息派出三个 agent，「跑 `ls` 和 `wc` 并列表」给 haiku low，「给脚本加一个 `--dry-run` 参数」给 sonnet medium，「线上偶发的断言失败，没人知道原因，查」给 opus xhigh（第 ③ 行：自己找原因、并发时序），三个 agent 的对话记录里的模型和 effort 与决定一致。`escalateLimit` 设成 0，一个命令连着失败的 haiku agent：第 2 次失败后 low 升到 medium，第 4 次后升到 high，各追加一行，模型始终是 haiku。
- 一次独立的代码审查，找出的都改了（清单见 DEVELOPMENT.md「派出 agent 的模型表重做」一节）：表本身的 4096 种回答组合和表头逐一对过，没有不一致；改的是失败升级里的两处不实的日志、同一步里重复升模型、Workflow 的请求数、旧日志条目的显示，和几处缺的测试。
- 官方文档（2026-11-10 读）和这张表一致：Anthropic 写小模型适合「lookups, not for writing code」「Keep judgment calls on the main model」，Sonnet 和 Opus 的分界是「complex, open-ended work requiring sustained judgment」；任务中途「Raise effort before you change models」，换模型要重算整个缓存。AA 的指数（v5.0.1）里 Opus 5.5 在科学计算类的分项上仍领先 Sonnet 5.5（Terminal-Bench-Science 43.3 对 34.3，默认 effort），所以 `science_code` 留着，尽管评测集里没有一题用到它。
- 这一轮共约 3,800 个请求，约 0.8 美元（Jev）。
