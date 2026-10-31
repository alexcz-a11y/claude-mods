# Dispatch Pilot：开发说明

这份文档给要改这个 mod 的人看。面向使用者的说明（用途、要求、安装、配置、`/dp` 命令）在 [README.md](README.md)，那里只留概要；完整的内容都在这里，各节的名字不变：

- 「它做什么」：每项功能的完整行为，README 里是它的概要。
- 「配置」：每个配置项的校准依据和说明；默认值只写在 README 的配置表里（`node dispatch-pilot/eval/validate.ts docs` 核对它和 `.claude-plugin/plugin.json`、`BACKEND_DEFAULTS` 一致），这份文档不再重复。
- 「待评测」：#17 的范围缩减说明，以及各项还没有数据的评测，完整版。
- 「开发」：结构、扩展方式、测试写法、评测，以及已经实测过的引擎行为。

下面第一段是各项功能和票号的对应。

Dispatch Pilot 在 Claude 之外调用一个决策模型（TypeSafe 的 Jev），替你决定 Claude Code 怎么干活。现阶段做三件事：**每次你发消息时，判断主 agent 这一轮该用哪档 effort**，并让这一轮的每一步都按这一档发出（0.8.x 在一轮进行中还会重新判断，0.9.0 删了，见下文「一轮中途不再重新判断」）；**主 agent 每派出一个 agent，判断它该用哪个模型、哪档 effort**（#6）；**主 agent 提交 Workflow 时，对脚本里的每个 `agent()` 做同样的判断，并写进脚本**（#8，见下文「Workflow 里的 agent」）；脚本写不进去的（用 `scriptPath` 或 `name` 提交、恢复的运行、读不了的脚本或调用），**在每个 agent 启动时按它的 label 设置**（#9，见下文「Workflow 兜底：agent 启动时按 label 设置」）。主 agent 的模型从不改变，所以 prompt cache 不受影响（ADR 0001）：这只在 Claude Code 订阅下成立（同一模型内切换 effort 保留缓存，2.1.289 实测），所以 Dispatch Pilot 只面向订阅用户；Bedrock、Vertex 和各种网关上切换 effort 会让缓存失效，不在支持范围内。另外，主 agent 不再读完整的 skill 列表，改由决策模型在你发消息时挑出相关的几个 skill 推荐给它（#10，见下文「skill：隐藏列表，发消息时推荐」）：照 TypeSafe 的 skill 推荐 cookbook，先问三道题判断这条消息要不要 skill，再用一道选择题给 skill 排序（每个用它自己的描述；主 agent 能加载的一题，只能由你触发的另一题），细看前三名的 SKILL.md 开头，最多推荐一个（ADR 0018）；一轮进行中，主 agent 还可以用 `find_skill` 工具按需查询 skill（#12，见下文「find_skill：主 agent 中途查询 skill」）。派出 agent 的工具调用失败累计到一定次数时，Dispatch Pilot 让它从下一步起改用高一档的模型；主 agent 的失败只记在这一轮的记录上（#7，见下文「失败时升模型」）。完整设计见 spec（issue #1）。用斜杠命令 `/dp` 可以开关整个 mod 或其中的单项功能、临时锁定 effort、查看最近的决策和理由（#13，见下文「控制：`/dp`」）。

测试环境：Claude Code 2.1.289（Opus 5.5，订阅登录）、Node 26.5；0.9.0 依据的引擎行为是在 2.1.312 上实测的（见「已实测的引擎行为」）。Jev 固定用 jev-1.14.0（2026-10-15 起，见「Jev 1.14」）；这份文档里更早的评测数字是在 jev-1.13.0 上测的，表里写明。

## 它做什么

- 你发出一条消息时（在终端输入、用 `claude -p`、通过 Remote Control 或 Slack，或由插件代你输入），Dispatch Pilot 把这条消息和最近几条对话发给决策模型（默认 Jev，ADR 0014），用英文问它「这项工作需要多少逐步推理」（「这项工作」指主 agent 为这条消息做的全部事情，直到它下次停下来等你）。它给出 low、medium、high、xhigh、max 五档各自的概率；同一个请求里还有十道是非题，见「是非题和下限」。决策模型可以改成 pplx 或 Liquid 的 d1-ultra（ADR 0017）；回答按各家的官方读法读（`decision/guides.ts`）。
- 怎么定档写在代码里（ADR 0014；`decision/effort.ts` 的 `traceEffort`，`decision/message-effort.ts` 的 `decideMessage`）：先算回答所在的位置（各档序号乘它的概率再相加，TypeSafe 的 `score`），四舍五入到最近的一档，正好一半往上取（`floor(position + 0.5)`，最多 max）；比这一档高两档以上的某一档概率不低于 0.3（`SECOND_PEAK`）时，再往上取一档（回答分在两头，只取一次）。置信度只记录，不参与定档（TypeSafe 的指南：置信度不是门槛）。然后取它和各条下限里最高的一个（「是非题和下限」），锁定优先于这一切。派出 agent 的 effort 用同一个基础档，再加它的模型下限（`traceEffort(reading, { model })`）。0.8.x 的规则（取概率最高的一档、`max` 要到 `thetaMax`、高一档到 `roundUp` 就往上取，`pickEffort`）删了：那几个门槛是在我们自己的评测上调的，0.9.0 按官方指南改回 TypeSafe 的起始规则，不再调（用户的决定，2026-10-28）。
- 这一轮的每个模型请求都按这一档发出。Claude Code 每一步都会把 effort 恢复成会话设置，所以每一步都要重新设置（2.1.312 起只有带输入的那一步写的生效，ADR 0013；照旧每一步都写，不必分辨哪一步带输入）。模型按引擎给的原样发出，包括引擎过载时自动换用的模型。
- 一轮进行中你又发了一条消息：这条消息会在下一步送进当前这一轮，所以它的判断从下一步起接管这一轮（那一步带着输入，写的 effort 生效，ADR 0013）。
- 不是你本人发的新消息的，分两种。**报告开始的一轮**：派出 agent 交回的结果或另一个 Claude 会话的消息（引擎都以 `origin.kind` 为 `peer` 交来，mod 分不开它们），或后台任务通知（`task-notification`），在会话空闲时到达（没有 `turnId`），会开始主 agent 的新一轮；这一轮也走同样的 effort 判断，请求里的 `user_message` 是那段报告的文字（截断、脱敏和你的消息一样），只问 effort 题、三道出错代价和原因未知（关于你的话的四道不问：还是不行、解决了、换任务、定规矩），不问 skill（它不是你的请求，所以状态里的预算按没有 skill 题的发消息取，见「Jev 的上下文默认值怎么算」），这一轮结束时不记这一轮的事实（`turns[].person` 为 false，见「失败时升模型」），你用 `/dp lock` 锁定的 effort 仍然优先。决策记作 `main-effort (agent report)`，与你的消息的决策区分；判断失败时和你的消息一样用会话自己的 effort，看板写明原因并弹一个 toast，成功后不再写「未路由」。报告送进一轮正在进行的对话（带 `turnId`）时不开始新的一轮，不判断，也不改变那一轮的 effort。**其余**（定时任务、插件自己发的消息）和空消息都不判断，也不改变任何一轮的 effort。你输入的 skill 或 markdown 命令（例如 `/implement #19`）开始的一轮是命令轮（#19），和你的消息一样判断：决策模型读你输入的 `/name args`，以及这个命令是做什么的（它的描述），不读命令展开后的正文；参数里的「用 opus」照样算点名，skill 正文里写的不算；命令轮不推荐 skill，你已经选好了流程。`/dp`、`/clear` 这类本地命令不开始一轮，引擎也不把它们交给 `prompt.submit`。以 `/` 开头但不是命令的消息（例如 `/Users/me/notes.txt 这是什么`）是普通消息。
- 派出 agent 见「派出 agent」一节，Workflow 里的 agent 见「Workflow 里的 agent」一节。

### 派出 agent

- 主 agent 用 Agent 工具派出一个 agent 时，Dispatch Pilot 在它启动前问一次决策模型。模型不再是一道选择题（0.8.x 的「哪个是能做好的最便宜的模型」），而是 TypeSafe 的「判断交给模型、决定写在代码里」（ADR 0015）：决策模型回答关于任务的十道是非题，代码按模型表定模型；同一个请求里还问 effort（打分题，和发消息时同样五档），以及你点名、排除了哪个模型、点名了哪档 effort。模型直接改在这次派发上；effort 在这个 agent 的每一步都重新设置。haiku 也设 effort：haiku 是 Haiku 5.5（`claude-haiku-5-5`），它接受 effort（0.4.1 之前按 Haiku 4.5 不设）。
- **关于任务的是非题**（`decision/dispatched-agent.ts` 的 `briefWords`，中英两版，英文发出）：`writes`（是否要新建、修改、删除文件，或执行会改变什么的命令）、`few_steps`（一两次工具调用能否做完）、`report_only`（结果是否只是按要求收集排版，没有要判断的）、`stakes.undo`、`stakes.live`、`stakes.access`（主 agent 那三道出错代价，改读 `brief.prompt`）、`cause_unknown`（是否要追查任务里没写明原因的故障）、`design_open`（是否要 agent 自己选一个任务没给出的做法）、`outside_facts`（结论是否靠仓库和文档里查不到的外部事实）、`science_code`（是否涉及数值、算法或科学计算代码），打开 `agentFable` 再加 `frontier`（严格证明，或没有现成答案的新算法、新架构）。每道一个判断，「是」和「否」写成具体情形，都点名它读的字段（`<field>.prompt` 和 `user_message`）；主 agent 的指定不进任何一道题。几道题的分工来自 0.8.x 按 AA 基准写的模型选项文字（haiku 只做一两步的只读查找；opus 做出错代价高、原因未知、要设计、靠外部事实、科学算法类的工作），现在每个条件单独成题。
- **模型表**（`tableRow`，从上往下第一条成立的那一行）：① 你点名的模型（`named.<model>` ≥ 0.7）；② 开了 `agentFable` 而且 `frontier` 为是，fable；③ 出错代价三道、`cause_unknown`、`design_open`、`outside_facts`、`science_code` 任一为是，opus；③b 这七道没有为是、但至少一道拿不准，sonnet，effort 至少 max；④ `writes` 否、`few_steps` 是、`report_only` 是，haiku（三道都要有回答：没回答的题不会让 agent 用上更便宜的模型）；⑤ 其余 sonnet。是非题 ≥ 0.7 算是、≤ 0.3 算否（`decision/nouls.ts`，TypeSafe 的起点）；没回答的题当否，什么都不抬。一道关于任务的题都没回答时没有表（`table` 为 null），模型按主 agent 的指定或引擎的。
- **d1-ultra 的路由**（ADR 0017，`readRoute`）：选 d1-ultra 时上面的模型表不用，十道关于任务的题里只问 `stakes.undo`、`stakes.live`、`stakes.access`、`cause_unknown`（`FLOOR_NOULS`，只为 effort 的下限），模型改由一道选择题 `route` 定，照 Liquid 指南的路由示例（「Which model tier should handle the work in `brief.prompt`?」）：`fast` → haiku、`standard` → sonnet、`powerful` → opus，开了 `agentFable` 加 `frontier` → fable（`TIER_MODELS`）。取概率最高的一档（并列取强的）；置信度低于 0.5（`guide.routeFallbackBelow`）退到可用模型里最强的，最强的被排除就取次强的；选中的被排除时取可用的里概率最高的一档（`replaced`）。点名模型、排除模型、点名 effort 都按 Liquid 的 > 0.8；主 agent 的指定只升不降，同上。没有 ③b，所以没有 `unsure` 那一步；effort 的拿不准按置信度。steps 里是 `route`（档位、概率、置信度、是否退到最强、要的和给的模型）或你点名时的 `named-model`，`main-pick` 带 `by: 'route'`。
- **effort 的下限**：先按 effort 题定基础档（位置四舍五入，双峰再高一档，和主 agent 同一个 `traceEffort`），再按下限只抬不压、取最高：出错代价（`stakesFloor`：难以挽回为是而且线上或权限为是 max，任一为是至少 xhigh，任一拿不准至少 high）、原因未知（`causeFloor`：是至少 xhigh，拿不准至少 high）、表停在 ③b 时 max（`unsure`），最后是模型下限（`effortFloor`）：sonnet 和 opus 至少 medium，haiku 和 fable 没有下限（常量，不是配置项；0.2.2 的第一版把 sonnet 放在 high，第一次真实评测 effort 部分从 74/72 掉到 64/62，降到 medium，见「按 AA 基准校正」）。你点名的 effort 不受任何下限影响。每一步都记进规则推演（`steps`），决策日志写最后抬起它的那条，例如「effort 从 low 抬到 medium（模型下限）」。
- 发给决策模型的是主 agent 写给这个 agent 的任务（`prompt`）、简短描述、agent 类型，以及你这一轮说的话：开始这一轮的那条消息，加上这一轮进行中你又发的消息（每条存到 `saidTokens`：两种 agent 请求里较大预算的三分之一，pplx 16000、Jev 32000（两种预算都是 96000）；0.4.3 之前是 6000）。和发消息时一样，发送前对 secret 脱敏，总长度按 token 预算（`contextTokens`）截断，你的话最多占三分之一。还发派出它的那段对话（`recent_context`，ADR 0007；选 Jev 时 2026-10-15 起也发，ADR 0009）：主对话（子 agent 派出的读那个子 agent 自己的，`e.parentAgentId`），到含这次 Agent 调用（`e.tool_use_id`）的那条消息为止（对话里找不到那条消息时取整段），和发消息时的 `recent_context` 一样只有文字和工具名；任务和你的话先放，对话从新往旧填剩下的预算（Jev 96000，带长上下文请求头；pplx 32000）。`BACKEND_DEFAULTS` 的 `agentBackground` 两个决策模型都开。
- 模型的优先级：
  1. 你在这一轮的消息里为这项工作点名的模型，一定照办，即使表里没有它（例如没打开 `agentFable` 时点名 fable）。
  2. 否则用模型表给的模型；你排除了它时换成最近的可用模型（`nearestAllowed`：先往强的找，没有再往弱的找，强弱是 haiku < sonnet < opus < fable，可用的是 `agents.models` 里没被排除的）。
  3. 主 agent 自己指定了模型时只升不降：表给的（换过之后的）更强才用表给的（`requested.outcome` 为 `upgraded`），否则保留主 agent 的指定（`kept`），包括它指定了 fable 而 `agentFable` 没开的时候。你排除了它的指定时，这个指定不算数。0.8.x 的强提示和 `agentOverride` 置信度门槛都删了：置信度不是门槛（TypeSafe）。
- effort 的优先级：你在这一轮的消息里为这项工作点名的 effort（「effort 开 low」「这次所有 agent 都用 high」），一定照办，也不会被推翻（模型的下限和往上取的一档都不碰它）；否则用决策模型给的 effort，按上面的下限抬（#6 的补丁，与点名模型同样对待）。点名了哪一档由决策模型判断（请求里的 `named_effort`：没有点名 / low / medium / high / xhigh / max，最可能的一档不是「没有点名」并且概率达到 0.7 才算，`NOUL_YES`；点名、排除模型的是非题也是 0.7，0.8.x 是 0.5），不靠关键词匹配；只有消息里出现可能点名 effort 的字眼（effort、档位名、推理、思考、强度、拉满……；英文的 think、reason 太常用，只认 think hard、more reasoning、ultrathink 这样的说法）时才在请求里加这一题，只是为了省 token，判断仍交给决策模型。点名只管它说的那项工作，「这次所有 agent」管这一轮全部 agent。模型最后是 haiku 时也照设（Haiku 5.5 接受 effort；0.4.1 之前不设）。Workflow 里的 `agent()` 同样：点名的 effort 写进脚本，盖过脚本里写的 effort，也盖过脚本在运行时才算出来的 effort。
- 你在消息里排除的模型（例如「这周额度快用完了，别用 opus」）在任何情况下都不会成为 agent 启动的模型：不论表给的是不是它，也不论主 agent 是否指定了它。表给的被排除时换成最近的可用模型（先强后弱），`/dp log` 里写明「opus 被你排除，取最近的 sonnet」；所有可用模型都被排除时没有模型（主 agent 指定了一个没被排除的，就用它）。只有整个决策请求失败（没有任何判断）时才照常放行，按主 agent 原来的要求启动：这时你排除的模型仍可能启动。这是有意的取舍：哪些模型被排除，是决策模型从你的话里读出来的，没有它的回答就无从知道；mod 不改用关键词去猜，以免把只是提到某个模型的话当成排除。
- 你点名的模型、点名的 effort 和排除的模型记进这个 agent 的计划（计划表 `agents` 的 `terms`），之后会改它模型的功能都照办：失败时升模型不会换掉你点名的模型（点名了 haiku 就一直是 haiku），不会换上你排除的模型（跳过它，换没被排除的上一档，往上都被排除就不换）；核心每一步都按你点名的 effort 发出。Workflow 里的 agent 同样（见下两节）。
- 「点名」和「排除」都由决策模型结合上下文判断，而不是看消息里有没有模型名：模型名只是作为产品被讨论（「比较一下 haiku 和 sonnet」）、说的是之前写代码的模型、是否定说法（「别用 opus 了，用 haiku 就行」里的 opus），或者点名针对的是另一项工作（「调研那种活儿用 haiku，实现你看着办」之于实现的 agent），都不算为这个 agent 点名。消息里提到了哪个模型，请求里才问它是否被点名或排除。
- 只在派出时判断一次。**一条消息里派出的几个 agent 合进一个请求**（`core/agent-lane.ts`，ADR 0009；0.5.0 及以前逐个判断）：按来源分组（主对话，或派出它的那个子 agent，`agent:<loop>`），一组最多 4 个（`MAX_PER_REQUEST`：一个 agent 有 11 到 19 道题，一个请求最多 64 道；0.8.x 是 8 个）；你的话、问题摘要和次数、参考图读数、对话只放一份，每个 agent 一个 part（`agent-<i>`）和一个 state 字段（`brief_<i>`），和 Workflow 的一批调用是同一种请求（`decision/workflow.ts` 的 `agentBatches`）。只有一个 agent 时仍是原来的请求（part `agent`、字段 `brief`，评测的请求）。一组什么时候发：同一条消息里的 Agent 调用（transcript 里和这次调用同一条助手消息的 `Agent` 调用，`agentCallsBeside`）都到了才发，没到的最多等 300 毫秒（`agent-lane.ts` 里的 `GATHER_MS`，不导出：fork、teammate 这类不经路由的调用永远不会到）；transcript 里还没有这条消息时不等。发出去要占一条车道：关于 agent 的请求同时在途最多 `agents.lanes` 个（`BACKEND_DEFAULTS.agentLanes`：Jev 4，1.14 同时答 4 个长请求和单发一个一样快，再多就受账号的 token 速率限制，见「Jev 的限速」；pplx 5），车道占满时组在队里等，新到的同来源 agent 并进这个还没发的组（不满 4 个时），满了另开一组。每个 agent 最多等 `agents.waitMs`（`agentWaitMs`：两个请求的等待，它自己的和排在它前面的一个，每个按长请求的等待算，最多 8000：Jev 6000，pplx 8000），过了就按主 agent 原来的要求启动，看板写「6000 毫秒内没有回答」；组发出时已经过了 deadline、或离 deadline 不到 `MIN_ASK_MS`（200 毫秒，`core/agent-lane.ts` 导出，Workflow 兜底和带图路由也用它）的成员不放进请求，照样按主 agent 原来的要求启动。一组的 brief 加起来超过预算时，在同一条车道里依次发几个请求（`askGroup`）。车道用宿主的 `$.clock.sleep` 等（`LaneIo.backend.sleep`，没有自己的 `sleep`）。请求发出、记 debug 行由车道做，一行写这个请求里所有 agent（`for agent "…"（type）, agent "…"（type）`）。
- 不处理的 agent：fork 出来的 agent（它总是用父 agent 的模型）、agent team 的 teammate（它会长期存在、处理很多任务，派出时的一次判断看不到这些任务）、Workflow 的 agent（`e.workflow` 有值，归下一节的两项功能管，见「已实测的引擎行为」），以及被唤醒的 agent（`e.resume` 有值：2.1.299 起，已结束的子 agent 被消息唤醒时引擎也触发 `agent.spawn`，只能拒绝，改模型无效；它沿用原来的模型，计划表里派出时写的计划照常生效）。
- 失败时放行：决策模型超时、出错或回答无法解析时，agent 按主 agent 原来的要求启动，用引擎自己的 effort，看板上它那一行写「未路由」和原因，并弹一个 toast。
- 每个决定都记进 `/dp log`：选了什么模型和 effort、是哪个 agent、理由（模型表停在哪一行、因为哪几道题，主 agent 的指定保留还是升级，被排除的模型，哪条下限抬了 effort，effort 各档的概率）。日志条目的 `trace` 是完整的规则推演（`lookup-signs`、`careful-signs` 两步写每道是非题的概率和是、否、拿不准，`model-table`、`main-pick`，然后是 effort 的各步），依据卡片照着画，不重算（ADR 0004）。`/dp dispatched-agents off` 单独关掉这项功能，之后派出的 agent 都按主 agent 原来的要求启动。
- **告诉主 agent**（#34）。Agent 工具的结果后面附一段英文说明（`decision/dispatched-agent.ts` 的 `dispatchNote`）：这个 agent 以什么模型和 effort 启动，模型是谁定的（你点名的；保留了主 agent 的指定，并写出表给的不比它强；把主 agent 的指定升级到表给的；没有指定时表给的；都写出表读到的是哪一类工作、因为哪几道题），effort 是谁定的（哪条下限抬的）；没路由（决策请求失败、功能关着）时写原因和它按主 agent 的要求启动，effort 是 Claude Code 给的（会话的；2.1.316 起设了 `CLAUDE_CODE_SUBAGENT_EFFORT` 时是它的），所以说明里只写 "at the effort Claude Code gives it"，0.9.1 及以前写的是 "at the session's effort"。fork、teammate 和被拒绝启动的派出不附。`agent.spawn` 在 Agent 工具调用里面触发，用同一个 `tool_use_id`，所以 spawn 把说明留在模块变量里，Agent 的 `tool.call` 返回时取走（热重载时正在跑的 agent 会少这一段）。

### Workflow 里的 agent

主 agent 用 `Workflow` 工具提交脚本时，Dispatch Pilot 在脚本运行之前，对脚本里的每个 `agent()` 调用点问一次决策模型：它该用哪个模型、哪档 effort（#8）。Workflow 里的 agent 不经过 Agent 工具；2.1.294 起引擎也为它们触发 `agent.spawn`，但只能拒绝、改不了它的模型（见「已实测的引擎行为」），所以脚本是提前给它们定模型和 effort 的唯一位置，默认**直接把决定写进脚本**：工具运行的是改写后的脚本，写了什么、为什么，在工具结果后面告诉主 agent。

- **一个调用点判断一次。** 循环、`pipeline`、`parallel` 里的 `agent()` 会运行很多次，但它只有一个调用点，只判断一次，改写也写在这个调用点上。prompt 和 label 写成模板字符串（`` `migrate:${file}` ``）也行：决策模型看到的是模板原文，`${file}` 保持原样。
- **写法。** 决定的 `model` 和 `effort` 写进这个调用的选项对象：脚本已经写了字符串值的就原地替换，没写的加在最后一个属性后面，没有选项的调用补一个选项对象。脚本的其他部分逐字不变。选了 haiku 也写 effort。
- **优先级和派出 agent 一致。** 同样的题、同一张模型表（ADR 0015）：你这一轮的消息里点名的模型 > 模型表 > 脚本里已经写的 `model`（当作主 agent 的指定，只升不降：表给的更强才写进去）。脚本里的 `effort` 没有这条规则，用决策模型的；你点名的 effort 除外，它盖过脚本里写的 effort（见「派出 agent」）。脚本在运行时才算出来的 `model`（`model: pickModel()`）只有你没点名模型、也没排除任何模型时才不动：否则写进决定的模型（你点名的，或者没被排除的那个），你的约束优先于脚本；运行时才算出来的 `effort` 同样只有你没点名 effort 时才不动。你对每个调用的约束交给下面的兜底功能，写进这些 agent 的计划（见「派出 agent」）。
- **发给决策模型的内容**和派出 agent 一样：这个调用的 prompt、label、`agentType`，脚本 `meta` 里的 description，以及你这一轮的话，`unresolved` 开着时还有问题摘要和次数（不加强提示），发送前脱敏，按 token 预算（`contextTokens`）截断。同一个脚本的几个调用放进同一个请求，每个调用有自己的 part（`agent-<n>`）和 state 字段（`brief_<n>`），`n` 是它在脚本里的序号（从 0 起），你的话只放一份。每个 brief 最多占平分的一份：你的话和摘要剩下的预算，除以一个请求里放得下的调用数（脚本的可读调用数，最多 4）；只有一个调用的脚本，它的 prompt 可以用满（0.4.3 之前每个 brief 固定最多 400 token，长 prompt 只剩开头和结尾）。每个请求还带整个脚本（`workflow_script`，脱敏，最多占预算的三分之一，太长时保留开头和结尾）和启动它的那段对话（`recent_context`，到含这次 Workflow 调用的那条消息为止，找不到那条消息时取整段），brief 先放，脚本和对话填剩下的（ADR 0007；选 Jev 时 2026-10-15 起，ADR 0009，预算 96000）。
- **调用多时分批。** 一个请求最多 64 个问题（`system-one.ts` 的 `MAX_QUESTIONS`）、最多 4 个调用（`MAX_PER_REQUEST`；0.8.x 是 8 个），各调用的 brief 加起来不超过 `contextTokens`，所以调用多时分成几个请求，每个调用只问一次。一个请求装得下时用 Workflow 的预算（Jev 96000，pplx 48000）；要分几个请求时，每个改用派出 agent 的预算（Jev 96000，pplx 32000，`planBatches`），因为 pplx 同时答几个大请求要慢得多（见「pplx 的 agent 预算」）。一个脚本最多问 24 个调用、6 个请求（`MAX_REQUESTS`；0.8.x 是 4 个），超出的调用保持脚本里写的样子，并告诉主 agent。几个请求按车道发（`core/agent-lane.ts` 的 `askInLane`，ADR 0009）：Jev 最多 4 个同时，pplx 最多 5 个；每个请求从发出起等它需要的时间（`waitFor`：带长上下文请求头的至少 3000 毫秒），全部在提交起的 8000 毫秒内（`BATCHES_BUDGET_MS`），到时还没轮上的请求里的调用保持原样。0.5.0 及以前是同时发出、每个等 `timeoutMs` 乘请求数。
- **读不了的调用保持原样。** prompt 不是字符串或模板（`agent(q.prompt)`、`agent(buildPrompt(x))`，也就是在数组上 `map` 出来的那种写法）时看不到任务内容，不问决策模型；模板里除了 `${...}` 自己没有几个字（不到约 6 个 token，例如 `` `${CONTEXT}\n\n${l.prompt}` ``：共用的上下文加上表里的一行）也一样，因为这样的 prompt 没说要做什么；不带占位符的短 prompt 就是完整的任务，照常判断。选项不是对象字面量（`agent('x', opts)`）写不进去，也就不问（工具结果和看板写明「它的选项不是对象字面量，写不进脚本」；0.4.4 及以前照样问，再报成「已写入」）。读不了的脚本（没有 `meta` 块，引号、模板或括号不成对）整个放行。这些调用的 agent 在启动时由兜底功能判断（#9，见下一节）。
- **告诉主 agent。** 工具结果后面附一段说明（引擎把它显示为 `tool.call hook additional context`，只有模型看得到）：逐个调用写了哪个模型和 effort、依据，以及哪些调用保持原样。工具返回的脚本文件（`Script file:`）就是改写后的那一份，主 agent 之后用 `scriptPath` 重跑，改写还在。
- **失败时放行。** 决策模型超时、出错或回答不完整时，这个请求里的调用保持原样，看板上这些调用写「未路由」和原因（并弹一个 toast）；这个功能自己出错时，整个脚本照原样运行。改写后的脚本如果被工具判为语法错误（工具在启动任何 agent 之前检查），就改用主 agent 原来的脚本再提交一次，并告诉主 agent。
- **不改写的输入。**（脚本是怎么交的，只在 `decision/workflow-labels.ts` 的 `submissionOf` 读一处：内联 `script`、`scriptPath`、`name`，或带 `resumeFromRunId` 的恢复；workflow-agents 和 workflow-labels 都用它，所以两边分到的运行互补。）用 `scriptPath` 或 `name` 提交的脚本（这里读不到内容，由 #9 在 agent 启动时设置）；带 `resumeFromRunId` 恢复的运行（缓存按每个 `agent()` 的 prompt 和选项匹配，改写会让已完成的 agent 重跑；#9 在 agent 启动时设置，不动脚本，所以缓存照样命中）；没有 `agent()` 的脚本。
- **退回模式**（配置 `workflowMode` 选 `return`）：不改写，拒绝这次提交，把逐个调用的决定写成给主 agent 的改写说明：要加什么选项，并说明这是路由插件的策略、是你设的。主 agent 照着改好再提交，这第二次提交直接放行，不再问决策模型。「同一个 Workflow」按脚本 `meta.name` 和各调用的 prompt 判断，主 agent 只加选项不影响它；退回过的 Workflow 记在 `$.state`（最近 16 个）。没有要写的（脚本已经是对的）、决策模型没答、读不了的脚本，都不退回。
- **每个决定记进 `/dp log`**，每个调用一条，例如 `sonnet medium · "rename"（Workflow tidy-api）：模型表第 5 行 → sonnet；effort 概率 ...`；退回模式的决定后面加「（已退回）」，日志条目带 `sentBack`。`/dp workflow-agents off` 单独关掉这项功能，之后 Workflow 照主 agent 写的运行。

### Workflow 兜底：agent 派出时按 label 设置

上一节的改写只能用在主 agent 直接交来、读得懂的脚本上。其余情况（#9）不改脚本，而是在每个 agent 派出时（`agent.spawn`，带 `e.workflow`）设置：模型设在派出上，effort 写进计划，在它自己的每一步发出。2.1.300 起 Workflow agent 的派出改模型才生效（之前只能拒绝），所以兜底从这一版起不再读运行目录（0.6.2 及以前在 agent 的第 0 步读 `journal.jsonl` 或 `agent-<id>.meta.json` 找 label、等 transcript 写到磁盘再取任务，并把完整的模型 ID 写进计划，每一步都覆盖）：

- **处理哪些运行。** 用 `scriptPath` 或 `name` 提交的脚本、带 `resumeFromRunId` 恢复的运行（运行时设置不改 `agent()` 的 prompt 和选项，缓存照样命中）、读不了的脚本，以及上一节留下的调用（prompt 是数据，例如 `agent(q.prompt, { label: q.label })`；或者超出 24 个的调用）。上一节写进脚本的调用不再处理；它没答上的调用（决策模型失败）照样保持原样，不再问第二次。两项功能的开关互相独立：`/dp workflow-agents off` 时，直接交来的脚本里读得懂的调用照主 agent 写的运行，读不了的仍由这里在 agent 启动时判断。
- **运行开始时。** Workflow 工具启动运行之后，读这次运行用的脚本：工具结果的 `scriptPath`（`scriptPath` 提交的就是那个文件；`name` 提交的是引擎解析好、存在会话目录里的那一份，所以项目、个人、插件和内置的命名 workflow 都一样处理）。能读懂的调用，用和上一节相同的请求逐个判断（同一个调用点判断一次）。
- **agent 派出时。** 引擎为脚本的每个 `agent()` 触发 `agent.spawn`：`e.workflow` 是 `{ runId, agentIndex }`，`description` 是它的 label，`prompt` 是它的任务（脚本算出来的），`tool_use_id` 是启动这次运行的 Workflow 调用的（2.1.302 实测）。按 `runId` 找到运行的记录，按 label 找到它是哪个 `agent()` 调用：字符串 label 按原文；模板 label（`` `migrate:${file}` ``）要求模板自己的文字都在、`${...}` 处可以是任何内容；不写 label 的调用，引擎拿 prompt 的开头作 label（空白折叠成一个空格、截到 60 个字符，2.1.289 的 journal 和 2.1.302 的派出都实测过），就按 prompt 的开头认；label 在运行时才算出来的调用，只在其他调用都对不上时才算。找到的调用在运行开始时已经判断过，就用它的决定；它的 prompt 是数据、两个调用用了同一个 label 却决定不同、对不上任何调用，或者整个脚本读不了，就用派出带来的任务（`e.prompt`）当场问决策模型，请求和上一节一个调用的请求相同。当场判断读的是**启动这次运行的那一轮**（ADR 0007）：Workflow 工具返回时，每个运行的记录（`labelRuns[].launch`）都存下那时你的话（0.4.4 及以前只在有调用留到 agent 启动时判断时才存，对不上任何调用的 agent 因此读到的是后来的消息）（`said`）、问题摘要和次数，`agentBackground` 为真时（Jev 和 pplx 都是）再存脚本原文（截到派出 agent 预算的三分之一，`SCRIPT_SHARE`）和调用 Workflow 的是哪个循环；agent 启动时从那个循环的对话里截到含这次 Workflow 调用（运行的 `callId`）的那条消息为止，找不到（被 `/compact` 压掉了）就不带对话。所以 Workflow 在后台跑、你又发了一条无关的消息时，后启动的 agent 不会把它当成你对这项工作说的话（0.4.2 及之前会：`said` 在你空闲时发消息就被换成那条新消息，实测后启动的 agent 读到的是新消息，点名的 opus 和 effort 都丢了）。当场判断的 agent 和同一次运行里一起派出的 agent 合进一个请求（ADR 0009，0.5.0 及以前一个 agent 一个请求）：派出时就进组（`run:<runId>`），fan-out 的几个 agent 一起问；之后才派出的 agent（Workflow 的 agent 不是一次生成的：分阶段、按结果再派）进下一个请求。预算用派出 agent 的（Jev 96000，pplx 32000）。每个 agent 最多等 `agents.waitMs`，和派出的 9 秒取早的。
- **设置什么。** 模型设在派出上（`next({ ...e, model })`，写家族的别名，引擎自己解析；agent 本来就在决定的家族上时不改）；effort 和你对这项工作的约束（`terms`）写进计划表（`agents[agentId]`，`model` 留 `null`，和 #6 一样，免得每一步都把引擎过载时换用的模型改回去），核心在这个 agent 的每一步都照写。换到 haiku 的 agent 也按决定的 effort 发出（Haiku 5.5 接受 effort）。脚本在运行时才算出来的 `model` 或 `effort` 的处理和上一节相同（你点名或排除模型时以你的为准）。上一节已经写进脚本的调用，它们的 agent 派出时只把你的约束写进计划（上一节把约束按 Workflow 调用的 `tool_use_id` 放在 `$.state` 的 `workflowTerms` 交过来）。
- **等待。** 运行开始时已经判断过的 agent 不等；当场判断的 agent 等一次决策请求。运行的第一个 agent 在 Workflow 工具返回之前就派出（2.1.302 实测：派出时工具的 `next` 还没回来，工具也不等派出），这时它等运行开始时的判断完成（按 Workflow 调用的 `tool_use_id` 等，别的运行的 agent 不受影响）。一个 agent 的派出最多等 9 秒（hook 自己的时间上限是 10 秒）。
- **常驻提示。** Workflow 工具的描述后面附一段固定的话，请主 agent 给每个 `agent()` 写固定且唯一的 label（对每一项都运行的调用，写固定前缀加这一项，例如 `` `audit:${file}` ``）。引擎在会话里第一次给出工具描述时问一次，之后一直沿用，所以文字固定，不影响 prompt cache；只在配置了决策模型、`workflow-labels` 开着时附上。
- **告诉主 agent。** 工具结果后面附一段说明：运行开始时每个调用定了什么、哪些调用在 agent 启动时再判断；读不了的脚本说明每个 agent 都在启动时判断。主 agent 直接交来的脚本，上一节已经说明了写进去的调用，这里只补一句：保持原样的调用由 agent 启动时判断。
- **失败时放行。** 决策模型失败或超时、任务里看不出要做什么、或者这个功能自己出错时，agent 按引擎原样启动，看板上它那一行写明原因。
- **看板和日志。** 按 label 设置的每个 agent 在 band 上有自己的一行（它的 label、模型、effort；没设置成的写「未路由」和原因，例如「它的任务里没说要做什么」），运行开始时判断过的调用在事件流里合成一条（「Workflow <名字> · 按 label N 个 agent()」）。运行开始时判断过的调用、启动时当场判断的 agent，各记一条进 `/dp log` 和 debug log，例如 `opus high · "q-license"（Workflow e2e-labels）：按它启动时的任务；已决定；选 opus，...`。`/dp workflow-labels off` 单独关掉这项功能。
- **限制。** 一组最多 4 个 agent（0.8.x 是 8 个，ADR 0015 加了题之后一个请求放不下）：更大的 fan-out 分成几组，Jev 最多 4 组同时在途（每组约 1–1.5 秒），后面的组等车道空出来，还要过账号的 token 速率（见「Jev 的限速」），等过 `agents.waitMs` 的按引擎原样启动。pplx 最多 5 组同时（实测 8 个 24000 估算 token 的请求同时发，都在 5 秒内），`pplxQps`（默认 5）让同一秒最多发 5 个。失败时升模型（#7）按计划表里的有效模型判断（计划的 `model`，没有才看引擎这一步的）：被换成 haiku 的 agent 失败到门槛时升到 `escalateHaikuTo`。

### 一轮中途不再重新判断（0.9.0，ADR 0013）

- 0.8.x 在一轮进行中每隔几步（`rejudgeEvery`），以及主 agent 派出 agent、启动 Workflow 或加载 skill 时，再问一次决策模型，按防抖规则（`thetaUp`、`thetaDown`、`holdSteps`）改这一轮的 effort（#5，`features/midturn-effort.ts`）。2.1.312 起引擎按消息取 effort：一档从一条带输入的消息用到下一条，`turn.step` 在只带工具结果的一步上改的 effort 不生效（实测见「已实测的引擎行为」的「2.1.312：一轮中途改 effort 不生效，改模型生效」）。看板会写出一次次从没发出去的改档，所以 0.9.0 删掉了这项功能：开关 `midturn-effort`，选项 `rejudgeEvery`、`rejudgeSteps`、`rejudgeWaitMs`、`thetaUp`、`thetaDown`、`holdSteps`，`$.state` 的 `midturn`、`mainStep` 和计划表 `turns` 的 `floorUntil`、`raisedAt`，看板上的中途重判次数和改档事件，`decision/midturn.ts`，以及评测集 `effort-midturn`（旧结果留在 `eval/results/effort-midturn/`）和 `scripts/decide-stuck.ts`。
- 一轮的 effort 只在发消息时定。一轮进行中你又输入的消息照常判断（`features/main-effort.ts`）：它在下一步送进这一轮，那一步带着输入，所以从那一步起用它的档。带图的这样一条消息只按文字定一次，不读它的图（0.9.0，ADR 0014）：0.8.x 在图读完后带着读数再判一次，那一次可能落在只带工具结果的一步上，在 2.1.312 上不生效，看板上却写着它（见「带图路由」）。主 agent 一轮中途读的参考图不再触发判断（0.8.x 的 `features/reference-midturn.ts` 一起删了）。

### 失败时升模型（#7）

- **记什么。** 主 agent 和它派出的每个 agent（包括 Workflow 里的），工具调用出错一次记一次。**你自己拒绝的调用从不算**；插件自己的 `$.tool.call`、插件 hook 拒绝的调用（`{ deny }`，例如 Workflow 退回模式退回的脚本）也不算。被你自己的 settings hook 拦下的调用，只有打开 `/dp hook-block-failures on` 才算失败（默认关闭，免得你的 PreToolUse hook 正常拦截时误触发）。不管开关，看板上这个循环的那一行都显示失败次数和被 hook 拦下的次数。计数只看总开关，不看 `escalation` 自己的开关（主 agent 的这一轮照样要记下）；`/dp escalation off` 只停升模型，再打开时，关着期间记下的失败不算，从打开起重新数。
- **派出 agent：升模型。** 一个派出 agent 计入的失败满 `escalateAfter` 次，在那个失败的调用一结束时就定下来：写进它的计划（`agents[agentId].model`，完整的模型 id），核心从它的下一步起照写（`turn.step` 改 `model`，2.1.312 实测从改的那一步起就生效）。不问决策模型，也不改 effort（一轮中途改的 effort 不生效）。往哪升（`decision/escalation.ts` 的 `stepUp`）：haiku → `escalateHaikuTo`（默认 sonnet）；sonnet → opus；opus → fable，只在打开 `agentFable` 时，否则 opus 就是顶。按计划表里的有效模型算（计划的 `model`，没有才看引擎这一步的；兜底换过的模型算数）。升过一次（或到了门槛却升不了）之后失败重新数；一个 agent 最多升 `escalateLimit` 次，之后失败照常记、看板照常显示，但不再升。
  - **你的约束优先**：你为这个 agent 点名了模型，就不换；你排除的模型跳过，换没被排除的上一档（只在 agent 可用的模型里选），往上都被排除就不换；haiku 的去处没设（`escalateHaikuTo` 留空）或写的不是已知模型，也不换。不换的这几种情况同样记一条决策，写明原因。
  - 换模型时计划里的 effort 保留，核心照常把它补进每一步；换模型只影响这个 agent 自己的缓存。
  - 同一步里一起失败的几个调用只升一次：计数和升级在同一次 `$.state` 写入里（`core/plans.ts` 的 `replace`），哪一次写入把基数换掉，哪一次就是升级的那次。
- **主 agent：只记下。** 主 agent 的失败照样数，但什么都不升：它的模型从不改（ADR 0001），effort 一轮中途改了也不生效。你本人的消息开始的那一轮结束时（`turn.complete`），把这一轮的事实写进计划表里它的记录（`turns[main:<turnId>].facts`，`decision/escalation.ts` 的 `TurnFacts`）：

  ```ts
  { effort: Effort | null,  // 这一轮发出的 effort（锁定的、决策的或引擎原样的）；模型不接受 effort 时为 null
    calls: number,          // 结束了的工具调用（插件拒绝的不算）
    failed: number,         // 失败的
    blocked: number,        // 被你的 settings hook 拦下的
    stuck: boolean,         // 计入的失败到没到 escalateAfter
    errors: string[] }      // 最后最多两行出错信息（MAX_ERRORS），每行先脱敏，截到 40 token
  ```

  每行出错信息是工具名，加上这次失败或被拦的结果里第一行有内容、又不是 `Exit code 1`、`Error:` 这类空话的那一行（`errorLine`）；没有这样的一行就只写工具名。报告开始的一轮（`person` 为 false）不记。同一份事实还存进 `$.state` 的 `lastTurn`（`{ turnId, facts }`，只有你本人的消息开始的一轮写）：你的下一条消息的请求在这一轮有失败或被拦下的调用时带上 `last_turn`（`decision/turn-start.ts` 的 `lastTurnState`：`effort`、`tool_calls`、`failed_calls`、`hook_blocked_calls`、`reached_escalate_after`、`last_errors`；没有失败时不发），原因未知那道题读它；规则 R4 读 `stuck` 和 `effort`（ADR 0014）。`/clear` 和新会话清掉（`features/unresolved.ts` 的 `session.end`），`/compact` 和热重载保留。
- **看板。** 每个循环（主 agent 的这一轮，或一个派出 agent）的那一行写它的计数，例如 `失败 2 · 拦截 1 · 升模型 1`；每次升模型是事件流里的一条（标签「升级」，写哪个 agent、从哪个模型升到哪个、失败了几次），依据卡片列出这个 agent 的每次升模型。新的一轮从零开始。
- **记录。** 每次升模型、每次到了门槛却没升（点名、排除、到顶、haiku 没有去处）都记进 `/dp log` 和 debug log，例如 `escalation：model claude-opus-5-5（原 claude-sonnet-5-5） · agent "修测试"，第 1 步，工具调用失败 2 次：工具调用失败 2 次（门槛 2），从它的下一步起改用 claude-opus-5-5；effort 在一轮中途改了也不生效，所以只换模型`。`/dp escalation off` 单独关掉升模型；`/dp hook-block-failures on` 让被 hook 拦下的调用也算失败。

### 是非题和下限（ADR 0014）

- **effort part 问什么。** `decision/turn-start.ts` 的 `turnStartPart({ kind })`：你本人的消息（`own`，含命令轮、一轮进行中发的消息）问十一道，effort 题 `level`（Score）加十道是非题（Noul）：`stakes.undo`（出了错是否难以挽回：删数据、发出去的消息、发布）、`stakes.live`（是否作用在线上系统或真钱上）、`stakes.access`（是否改权限、登录或密钥）、`cause_unknown`（是否要先查出一个还没人说清楚的故障原因）、`still_failing`、`solved`、`new_task`（关于问题的三道，见下一节）、`constraint`（是否给接下来的工作定了规矩，见「长期约束」）、`confirm`（是否只是同意、让继续或从助手给出的选项里选一个）、`escalate`（是否要求多想、更仔细或更强的模型；这两道在 `decision/asks.ts`，ADR 0016）。报告开始的一轮（`report`）只问前五道。按 TypeSafe 的提问指南写：effort 题只量一件事（需要多少逐步推理），不再提「之前多次没解决」「难以挽回」，这些拆成了是非题；每道是非题的 `criteria.true`、`criteria.false` 都写成具体的情形；题面用反引号点名它读的 state 字段，`standing_constraints`、`last_turn` 只在 state 里有这两个字段时才点名（`has`）。0.9.0 起三个决策模型都用英文问（`BACKEND_DEFAULTS` 的 `ask.turnStart`），中文写法留给评测的 `zh-` 变体。
- **怎么读。** 按决策模型的指南（`decision/guides.ts`，`ctx.config.guide`，ADR 0017）：Jev 和 pplx 用 TypeSafe 的，「是」的概率 ≥ 0.7 算是、≤ 0.3 算否；d1-ultra 用 Liquid 的，> 0.8 算是、< 0.2 算否；中间算拿不准（`decision/nouls.ts` 的 `verdictOf(p, bars)`，两家的值都不调）。effort 题拿不准时 TypeSafe 看两头（`two-peaked`），Liquid 看置信度是否低于 0.5（`low-confidence`，`traceEffort` 的第三个参数）。没回答的题（`readNoul` 为 null）按否，不抬任何东西。
- **下限**（`decision/message-effort.ts` 的 `decideMessage`，按这个顺序，每条只抬不压，结果取最高的）：
  - 要求升级（ADR 0016）：`escalate` 为是，至少 xhigh，和 R1 一样。
  - 确认（ADR 0016）：`confirm` 为是，至少等于你上一条消息那一轮的 effort（`lastTurn.facts.effort`，各步实际发出的档位）；没有记录不起作用。它不碰未解决次数：`solved` 的「否」点名了「只是同意、让继续不算解决」。
  - R1 `ultrathink`：你的话里写了它（`namesUltrathink`：单独一个词，大小写不论，不在代码块里、不在一对引号之间，前后不挨着路径或名字的字符；中文字不算挨着，所以「请ultrathink一下」算），至少 xhigh。2.1.311 起引擎自己也把它当 xhigh 的请求；规则让看板说出原因。环境变量 `CLAUDE_CODE_DISABLE_ULTRATHINK`（2.1.316 起）关掉这个关键词时，引擎不再抬档，R1 也不抬（0.9.2）：会话开始时 `features/control.ts` 读它，按引擎读布尔变量的办法（`1`、`true`、`yes`、`on`，不分大小写、去掉首尾空白；2.1.316 的二进制里 `iPt()` 是 `!env.CLAUDE_CODE_DISABLE_ULTRATHINK && <功能开关>`，布尔变量都用同一个函数读），记在 `ctx.engineEnv.ultrathinkOff`；没设、空、`0`、`false` 或别的值，R1 照常。关着时消息写了 ultrathink，这一步不抬档，带 `off: true`，卡片写「消息里写了 ultrathink，但 CLAUDE_CODE_DISABLE_ULTRATHINK 关掉了这个关键词」。改了变量要开新会话（或热重载）才读到。
  - R2 出错代价：`stakes.undo` 为是、而且 `stakes.live` 或 `stakes.access` 为是，max；任何一道为是，至少 xhigh；任何一道拿不准，至少 high。
  - R3 原因未知：为是至少 xhigh，拿不准至少 high。
  - R4 上一轮卡住：`still_failing` 为是，而且你上一条消息开始的那一轮卡住了（`lastTurn.facts.stuck`，失败到了 `escalateAfter`），至少那一轮的 effort 再高一档。
  - R5 未解决次数：`still_failing` 为是，而且次数（算上这一条消息的加一）不低于 `unresolvedMaxAfter`（0 表示从不），max。
  - 锁定：`/dp lock` 的档位优先于以上一切（核心的 `planStep`；trace 的最后一步写锁定和规则定的档）。
- **trace。** 每一步进决策的 `trace`（`RuleStep`：`rule`、`applied`、`level`、`floor` 和这一条自己的字段，概率、判定、两条线和 `inclusive`（线上算不算：TypeSafe 算，Liquid 不算）），顺序是位置、双峰或置信度、`ultrathink`、`escalate`、`confirm`、`stakes`、`cause-unknown`、`stuck-again`、`unresolved-count`、锁定，看板只画存下的步骤，从不重算（ADR 0004）；band 的一行用最后一条起作用的下限（`view.ts` 的 `traceReason`：「出错代价：至少 xhigh」，没有下限时「位置 2.3 → high」）。
- **测试。** `tests/rule-trace.test.ts` 逐行写真值表（含拿不准的行）、位置和双峰、ultrathink 的例子（引号和路径）、派出 agent 的读法；`tests/unresolved-question.test.ts` 写每种轮问哪些题、state 字段没有内容时不发；`tests/message-state.test.ts` 用 world 测长期约束、`last_turn` 和 R4；`tests/unresolved.test.ts` 测次数和 R5；`tests/asks.test.ts` 测确认和要求升级（两家的线、和次数无关）；`tests/d1-ultra.test.ts` 测 Liquid 的线、置信度规则、路由和后端。

### 未解决次数（#39，ADR 0014）

- **三道是非题。** 你本人的消息问 `still_failing`（这条消息是否在说你和主 agent 最后在处理的那个问题上次试的没用、问题还在）、`solved`（是否说解决了或接受了结果）、`new_task`（是否转到别的问题或任务）。只看你自己的话，助手说的「已修复」不算结果（题里的 `results` 一条）。0.6.2 到 0.8.x 是一道三选一（`effort.unresolved`，Choice），加上两档门槛 0.5 / 0.7；0.9.0 换成三道是非题，读法统一成 0.7 / 0.3。
- **次数怎么动**（`decision/unresolved.ts` 的 `judgeUnresolved`，`countAfter`）：`still_failing` 为是，加一（同时摘要最后一次尝试标未解决）；`solved` 为是，或 `new_task` 为是而且 `still_failing` 为否，清零（摘要一起清掉）；其余不变（换任务时旧问题可能还没解决，`still_failing` 拿不准就不清）。三道都没回答时不动，debug log 记一行。
- **次数。** 存在 `$.state` 的 `unresolved`（`{ count, summary?, writing?, owed? }`，只由 `core/unresolved.ts` 写）：一直在数，没有开关（R5 要读它，数它不花钱）；热重载不丢，`session.end`（`/clear`、新会话）清零，`/compact` 保留。锁定或点名 effort 时照常计数；报告开始的一轮不问、不动。`main-effort` 关着时不问（题挂在它那一份投票箱里）。次数大于 0 时进发消息时的请求（`unresolved_count`，这条消息之前的次数）；R5 用这条消息动过之后的次数（`features/main-effort.ts` 先动次数再定档）。派出 agent 和 Workflow 的请求也带次数当背景，不进规则。
- **0.8.x 的开关。** 次数和摘要以前共用 `unresolved` 开关（默认关，#48）。0.9.0 去掉了它：次数一直数，摘要有自己的 `summary` 开关（默认开）；`$.store` 里存着的 `unresolved` 设置读到也不起作用（`isOn` 对没定义的开关名回答开，但没有代码再问它）。
- **看板。** 依据卡片（主 agent）在 effort 的结果下写「未解决：次数 2 → 3 次数加一」和三道题各自的概率和判定（`pane-card-unresolved`、`pane-card-unresolved-odds`，读决定里存的 `UnresolvedRecord`：`probs`、`verdicts`、`thresholds`）；次数真的变了才另记一条 `unresolved` 的决定进决策日志和 debug log；band 和脚部不画它。

### 问题摘要（#40）

- **写什么。** 你本人的消息（含命令轮）开始的那一轮结束时（`turn.complete`，主循环，`turns[main:<turnId>].person` 为真；agent 交回结果、后台任务通知开始的轮、派出 agent 的轮不写），在后台调用 `$.model.complete`，模型是 `summaryModel`（默认 haiku，写法同 `skillsProfileModel`），hook 不等它。输入（`decision/summary.ts` 的 `summaryPrompt`）：上一份摘要（它写回的样子，`[unresolved]` 标记留在条目末尾）、这一轮你的话（`turns` 记录里的 `prompt`，命令轮是你输入的 `/name args`）、主 agent 的最终回复（`e.answer`）、这一轮的工具汇总（`turnTools`：对话记录里你最后一条有文字的消息之后，助手调用的工具，写法同决策模型读的 `[tools: Bash x3 (1 failed)]`；一轮中途你又发了消息，那条之前的工具读不到），都先脱敏再截断（你的话 1500、回复 3000、工具 300 token）。输出是 JSON `{problem, tried: [..], status}`（`SUMMARY_SYSTEM` 规定：问题一句、尝试逐条、状态一句、只记试过什么不写成没成功），`readSummary` 读它并限在 `SUMMARY_TOKENS`（500）以内：每一部分先各截到自己的份额，还超就把最早的两条尝试并成一条（它们的字接起来再截），最新的原样保留。摘要的 token 按渲染成文字的样子数（`renderSummary(.., 'zh')`，中文标签是上限），不是 JSON。回答缺字段、不是 JSON、被 `maxTokens`（`SUMMARY_MAX_REPLY`，1000）截断时不算摘要，当作失败。0.9.0 起 `SUMMARY_SYSTEM` 要它用英文写（名字、路径、命令和报错原样保留，ADR 0014：英文是 Jev 最准的语言）。
- **存放。** `$.state` 的 `unresolved` 里：`summary`（`problem`、`tried: [{ text, unresolved? }]`、`status`、`turn`：它写到哪一轮的 turnId）、`writing`（排队或在写的轮的 turnId）、`owed`（见下）。只由 `core/unresolved.ts` 写：`queueSummary`（轮结束时登记）、`summaryFor`（写之前读：这一轮还要不要写、上一份是什么）、`landSummary`、`dropSummary`、`lostSummaries`、`moveCount` 和 `clearCount`。次数清零（问题解决、换了问题）和 `/clear`、新会话把摘要、`writing` 和 `owed` 一起清掉，下一轮从头写。
- **写的顺序。** 写是一个接一个的（`features/unresolved.ts` 的模块变量 `chain`）：一轮结束时前一次写还没完，这一次排在它后面，开始时才读那时的摘要，所以接着前一次写下的续写，不会各写各的。一次写开始前先看它的轮是否还在 `writing` 里：清零把它拿掉了（或开关已关、模型被拒绝过）就不写；写好落下时再看一次，拿掉了就丢掉这份（决策日志不记，它是被清零作废的，不是失败）。
- **决定时从不等。** 发消息时 `features/main-effort.ts` 读 `$.state` 里现有的摘要放进 effort 请求（`turnStartPart` 的 state 字段 `problem_summary`，以有名字的字段发送：`summary.ts` 的 `summaryState` 写成 `{ problem, tried: [{ text, unresolved }], status }`，0.9.0 起；之前是按决策模型的语言写成的一段文字），还没写完就用上一份。它只进 effort 请求，不进 skill 请求；关于问题的三道题读到的是上一份摘要（它们和 effort 题在同一个请求里，读同一份 state）。`summary` 开关关着时不放。
- **标「未解决」。** `still_failing` 为是（加一）时，`moveCount` 把摘要最后一条尝试标上 `unresolved`。这条消息说的是上一轮的做法，而上一轮的摘要可能还在写（你回得很快）：`writing` 不空时不标现有摘要的最后一条（那是更早一轮的），改记 `owed` 为排在最后的那一轮，写好落下时（`landSummary`）标新摘要的最后一条。模型续写时被告知保留条目末尾的 `[unresolved]`，读回来时它仍是标记；标记只是提示，模型丢了不影响次数。
- **失败。** 模型出错（API 错误）、没有文字、超时（`SUMMARY_TIMEOUT_MS`，30 秒）、回答不是摘要的结构：保留旧摘要，`report` 记一条旁支决定（`feature: 'summary'`，`outcome: '摘要没写成'`，`tone: 'warn'`，原因写明哪一种，`summaryFailure`）。引擎拒绝这个模型（`$.model.complete` reject）时记一条，之后这个会话不再问（`refused`，`/clear` 或新会话再试；排在后面的写也跳过），免得每一轮记一条。热重载丢掉在途的调用：`session.start`（热重载也会触发）发现 `writing` 里有这个 load 没在跑的轮，拿掉它们、记一条「热重载中断了正在写摘要的调用」；摘要和次数不丢。
- **不写的情况。** `/dp summary off`、总开关关着、没有配置决策模型、`contextMessages` 为 0（摘要是对话的转述，你不让决策模型读对话，就不交给它转述）、`main-effort` 关着（认不出哪一轮是你本人的消息开始的）。
- **请求的 state 预算。** 摘要和 `command` 这类 part 加进 state 的字段，以前合进去时不占 `limits.tokens`（Jev 的 24000 有余量，没关系）。现在 `decision/turn-start.ts` 的 `messageRequest` 把这些字段的 token 先从预算里扣掉再取最近的对话，整个 state（JSON 的样子）仍在预算内；核心和评测都用它拼请求。
- **依据面板。** 面板在卡片和决策日志之间有「问题摘要」一块（`pane-summary`，行 `pane-summary-problem`、`pane-summary-try-<i>`、`pane-summary-status`），写摘要全文，标了「未解决」的尝试带着标记；没有摘要或 `summary` 关着时不画。`screens.tsx` 从 `$.state` 的 `unresolved` 读，`PaneInput.summary`。

### 长期约束（ADR 0014）

- **为什么。** 四十轮之前说的「这是真钱」「生产库千万别动」早就不在 state 的预算里了。TypeSafe 的记忆示例（memory cookbook）的做法：说的时候用一道是非题判断值不值得记，代码记下来，之后每个请求都带上，题就不用再到对话里去找。
- **记什么。** `constraint` 为是时（`features/main-effort.ts` 的 `keepConstraint`），`decision/constraints.ts` 的 `constraintOf` 记下你的原话（`person_said`，脱敏，截到 300 token，留三成给结尾）和你回的那条助手消息的最后一段（`assistant_before`：`$.session.messages()` 里最后一条有文字的助手消息，按空行分段取最后一段，脱敏，截到 150 token；「这个也别动」要知道「这个」指什么）。只记原文，不记模型写的转述，免得把误读一起带下去。
- **存放。** `$.state` 的 `constraints`（数组，旧的在前）：最多 5 条（`MOST_CONSTRAINTS`），多了丢最旧的；同一句原话再说一遍只留最新的一份。`session.end`（`/clear`、新会话）清空，`/compact` 和热重载保留。报告开始的一轮不问这道题，不记、也不带。
- **发送。** 有时才进你本人的消息的请求（`standing_constraints`），出错代价的三道题点名读它。决策日志每记下一条写一条 `main-effort` 的旁支决定「记下长期约束」。

### 强提示（#41，0.9.0 删了）

0.6.2 到 0.8.x：次数到 `unresolvedMaxAfter` 时另问一道带提示的 effort 题（`effort.level_unsolved`），这条消息自己的三选一判仍未解决时取它的回答，max 门槛用 `hintThetaMax`（ADR 0010）。官方指南要求判断交给 Jev、决定写在代码里，0.9.0 把它换成规则 R5（`still_failing` 为是、次数到 `unresolvedMaxAfter` 就 max），次数只作为 state 里的事实发出（ADR 0014）。当时的量法和结果留在 ADR 0010 和 `eval/results/*/2026-10-16-jev-hint-*.json`。

### 失败时放行

如果决策模型超时（`timeoutMs`）、出错、回答无法解析，或者没有配置 key，消息照常进入，不会额外等待，这一轮使用会话自己的 effort。看板上主 agent 那一行写「未路由」和几个字的原因（「决策模型超时」「决策模型拒绝了密钥」），同时弹一个 toast 写明细节，例如 `jev：1500 毫秒内没有回答`、`jev：密钥被拒绝（状态码 401）`。账号的额度用完时（状态码 402；TypeSafe 和 Perplexity 在账号没有额度时都这样回，额度不是按天重置的）写 `jev：额度用完了（状态码 402）`，band 上写「决策模型额度用完」，卡片写「决策模型账号的额度用完了（状态码 402）」，给模型的英文是 `jev: out of credits (HTTP 402)`，和一时繁忙的 `jev：繁忙（状态码 503）`、请求太密被限速的 `pplx：被限速（状态码 429）` 区分开。

### 看板

给人看的读数都在看板上（#29，ADR 0004），终端上不再有 `$.ui.status` 那一行（它前面的 ⚠ 关不掉，一行也放不下几个 agent）；不带终端的会话用它写 band 的一行摘要（ADR 0011，见下面「非终端端」）：

- **prompt 上方的 band。** 一轮进行中，顶上一条状态条（第几轮、用时、agent 的运行 / 完成 / 失败 / 排队数、Workflow 的进度），下面每个 agent 一行：主 agent 在最前，其余按开始的先后，各带数字键（0 是主 agent，1–9 按先后）、名字（太长时末尾截断）、模型标签、effort 标签、状态符号、一条时间色带（同一根时间轴，看得出谁和谁并行），最后是状态格：运行或完成了多久、失败、排队，或者「未路由 · 原因」（决策模型超时、出错、没配好、功能已关……，完整的原因在依据面板）。再下面是这一轮的事件流：每个决定、派出 agent 失败后的升模型（标签「升级」，写哪个 agent、从哪个模型升到哪个、失败了几次）、skill 推荐和「可试 /x」、skill 查询，以及请求失败、回答迟到这类以前只在状态行出现的事。一轮结束后 band 折成一行：主 agent 的模型·effort、这一档是怎么来的（例如「位置 2.3 → high」「出错代价：至少 xhigh」，或未路由的原因）、「可试 /x」、agent 的结果。引擎给 band 不到 4 行时，退成一行摘要。同一位置上别的 mod 画的内容保留在上面。
- **脚部右端的摘要。** 不超过 12 列（引擎在那里写着模式、或别的 mod 画了东西时，隔开它们的那一列也算在内）：状态符号（有 agent 在跑时是转圈）、主 agent 的模型·effort、`+N` 个运行中的 agent；放不下时 effort 先写短（`xhi`），再省掉模型。band 收起时也看得到。
- **几条读法**（`view.ts`、`kit.tsx`）。更早一轮开始、这一轮仍在跑的 agent（Workflow 跨轮），状态格的「运行 m:ss」从它自己的开始算，不是这一轮已经过的时间。更早一轮的主 agent 不带进后面的一轮，哪怕它的节点还写着在跑（下一轮开始，主 agent 的那一轮就结束了）。band 窄于 70 列时 effort 格只剩五格 pip。卡片上未解决那一行（`pane-card-unresolved-odds`）读记录里存的 `verdicts`，不重新套 0.7 / 0.3。格宽（`kit.tsx` 的 `cells`）把 emoji 和 CJK 扩展 B 的字符按 2 格算。模型·effort 的读数（`readout`）、skill 提示的文字（`skillsText`）和百分比（`pctText`）在 kit.tsx 各写一份，band、脚部和面板共用。
- **toast。** 路由失败（主 agent 或某个 agent 的决策请求失败）时弹一个，写谁没路由、原因和细节；按数字键要的依据面板没被放出来时也弹一个，写原因和 `/dp log 10`；在面板里按 x 要看的对话引擎没切过去时也弹一个（`unviewed`），写引擎给的原因。离上一个 toast 不到 2 秒的不弹（失败照样在看板上）：2.1.290 之前是引擎会丢掉同一个插件 2 秒内的第二个 toast，现在不丢了（官方排错页），这条限频留着，免得几个 agent 一起失败时刷屏。
- 关掉的功能（`/dp <功能> off`）的决定、事件和它拥有的部分（失败计数、看图核对的计数）不出现在 band 和脚部；`/dp off` 时 band 上没有 Dispatch Pilot 的内容，脚部写 `○ dp 已关`。
- **依据面板（`/dp`，`/dp log` 是别名）。** 全屏且终端够宽时停靠在对话右边（约 75 列），否则在 prompt 上方。顶部灰字列出每项功能的开关状态（名字加「开」或「关」，关着的用灰色，默认关的 `hook-block-failures` 也在内；整个 mod 关着时另有一行说明）和锁定。下面是「‹ 上一个 (p) / 下一个 › (n)」，按 band 的顺序翻看 agent；在 band 上按数字键（空的 prompt 里）也直接选中一个 agent 并打开面板，面板不抢键盘，可以接着按别的数字。圆角框里是选中 agent 的依据卡片：状态（没路由时写「未路由 · 原因」，几个字；没有单独的「原因」一行），请求失败时下面还有类型、后端、细节和去 debug log 哪里看几行，给它的模型（派出 agent、Workflow agent；主 agent 的模型从不由决定改）和理由（主 agent 也有：决策模型的回答），各档 effort 的概率条，规则推演（位置 → 双峰 → 主 agent 的五条下限和锁定；派出 agent 先是「只读查找」「审慎」两步写每道关于任务的是非题、「模型表」那一行、「主 agent」或「脚本」的指定保留还是升级，再是位置、双峰、出错代价、原因未知、「拿不准」（③b）和模型下限，点名 effort 时最后写「点名」；每一步写它做了什么），结果；主 agent 还注明置信度只记录、不参与定档；派出 agent 列出它每次失败后升模型（失败了几次，从哪个模型升到哪个，`pane-raise-<n>`）。卡片只画决定时存下的推演，从不重新计算。再下面是决策日志，按轮分组、最新的一轮在前，每条带编号、结果（颜色、字重和 ✔ · ⚠ ✘ 符号；每轮的标题按同样的符号计数）、模型和 effort、是哪项功能针对什么、各档概率和理由；每轮有一个字母键（`a` 起，跳过 `p`、`n`、`f`，20 轮各有一个）折叠或展开，最新两轮默认展开。面板窄时文字悬挂缩进换行，不截断。`Esc` 关掉面板，`/dp` 再输一次也关掉。面板没被放出来时（比如接着的端不放面板）立即关掉，并说明原因（`/dp` 在回复里，数字键弹一个 toast），可以改用 `/dp log 10` 在对话里看。
- **Desktop 等非终端端（#31，ADR 0011、0012）。** 同一份 band、脚部和依据面板，一个 Raster 都没有（Raster 在这些端被拒）：时间色带、概率条、置信条画成 Svg（`kit.tsx` 的 `Marks`：终端用 `rasterMarks`，其他端用 `svgMarks`；一格按 `CELL_PX` 7 px，宁短勿长；Svg 不收 key，外面包一个带 key 的 Box），数字照样写在旁边。模型标签、pip、状态符号和用空格对齐的列 `mono`，数字 `tabular`（Desktop 的正文是比例字体；终端忽略这两项）。band 的折叠：终端由引擎折，其他端在状态条右端放「▾ 收起」（`band-fold-button`），存在 `$.state` 的 `bandFolded`，整个会话有效，折起时就是那一行摘要加「▸ 展开」。面板按钮的文字在非终端不写按键（`PaneInput.spellKeys`）：Desktop 在按钮旁边自己画键，VS Code 和手机不收键。ADR 0012：会话里有 Desktop 时不写状态行，prompt 提示写进 `$.state` 的 `draftHint`，band 的空闲行在用户写草稿时换成它（`band-hint`，下一轮开始时清掉）；band 上 agent 的名字不带数字键，effort 写成彩色的字（`effortWord`），不画 pip；依据面板另画一份（`pane-app.tsx`）。会话的 surface 里既没有终端也没有 Desktop 时（`$.session.surfaces()`，VS Code、手机），状态行写 band 的一行（`band.tsx` 的 `statusText`；`board/status-line.ts` 存着这一行该写什么，`screens.tsx` 的 `registerStatus` 在 session.start、turn.start、agent.spawn、turn.complete 和 `/dp` 之后更新，注册在最外层，所以一轮结束时读到的是 report 刚写的看板），用户写草稿时 prompt 提示优先占这一行，主 agent 的下一轮开始时换回去；只在变了时才调 `$.ui.status`。Desktop 自带的 Claude Code 落后于终端：`scripts/check.sh` 会用它再跑一遍 `plugin validate`，低于 README 写的最低版本时只记一条 note。脚部标签沿用同一个排法，预算放宽到 24 个字符（Desktop 的脚部 chip 最宽 24ch，超出会被截；隔开别的内容的那一列同样算在内）。Desktop 不画 PromptHint，这里也不用它。Desktop 页面拒收 2000 个节点以上的树：面板在非终端上只画日志最新的 40 条，更早的写「更早 N 条没有画出」；树仍超过 1800 个节点就换更小的窗口（16、4、0 条）。2026-10-18 Desktop 自带的是 2.1.299，dp 加载不了，当时另维护过兼容分支 `dp/desktop-299`；2026-10-22 Desktop 自带的升到 2.1.308，validate 通过，兼容分支已删除，只维护 main。在 2.1.308 的 Desktop 上还没亲眼看过界面，只测了树（`$.ui.mount`，surface 为 `desktop`、`vscode`、`mobile`，`tests/desktop.test.ts`），SVG 用 qlmanage 渲染出来在浅色和深色底上看过。

### 发给决策模型的内容

- `user_message` 是你这条消息。`recent_context` 是之前最近的几条消息，同一方连续写的几行算作一条。每条只有文字和调用过的工具名（例如 `[tools: Read, Bash (failed)]`），**不包含文件内容和工具输出**。
- 发送前会对常见的 secret 格式脱敏，替换成 `[REDACTED]`。覆盖的格式包括各家的 API key 和 token、`password=...` 这类赋值、URL 里的密码、私钥和 JWT。
- 总长度按 token 预算（`contextTokens`）截断，数的是发出去的整个 state：序列化成 JSON 的样子，字段名、引号和转义都算。中文约 1 个字算 1 个 token，其他文字约 4 个字符算 1 个 token，因此中英文按同一个尺度截断。预算先保证你的消息，剩下的分给最近的消息：旧消息整条丢弃，最新一条放不下时保留开头和结尾。
- 派出 agent 和 Workflow 里的 agent 的请求见「派出 agent」「Workflow 里的 agent」：它们也带对话（同样只有文字和工具名），Workflow 的还带脚本（ADR 0007；选 Jev 时 2026-10-15 起，ADR 0009）；一起派出、一起启动的 agent 合进一个请求。
- 每次请求的结果和每次决定都写进 debug log（`claude --debug-file <path>`），不会进入对话。派出 agent 和 Workflow 的请求行末尾还写 state 的大小和每个字段的大小（`state 593 tokens (brief 45, user_message 255, recent_context 283)`，只有字段名和估算 token，不写内容），用来核对决策模型读到了哪些背景。
- 图（看图核对、带图路由，ADR 0008）：带图的请求用图像后端（`chooseImageBackend`），不看 `decisionModel`，发出的图没法脱敏；哪些功能什么时候发、发给谁，见 README 的「图像：发给谁，什么时候发」，请求的格式见「带图的决策请求和图像后端（#56，ADR 0008）」。debug log 只记张数、尺寸、估算 token 和耗时。
- skill 推荐打开时，另一个请求（和 effort 的请求并行，两个请求各用各的 state 预算）里有本会话每个 skill 的名字和描述，以及三道判断要不要 skill 的是非题；三道题的平均过了门槛时发第二个请求，带着排在前面的三个 skill 的描述和 SKILL.md 正文的开头（700 个字符，先脱敏），见下一节（ADR 0018）。

### skill：隐藏列表，发消息时推荐

Claude Code 在会话开始时把所有 skill 的名字和描述作为一条附件（`skill_listing`）交给主 agent，装的 skill 多时这一段很长：本机 66 个 skill，实测每个会话多出约 6.6k input token。Dispatch Pilot 对主 agent 拦下这条附件（ADR 0002），换成一句固定的提示，改为在你每次发消息时推荐相关的几个：

- **推荐按 TypeSafe 的 skill 推荐 cookbook 做（ADR 0018），分两段。** 第一段和 effort 并行，是一个自己的决策请求（ADR 0005）：在本会话主 agent 能加载的 skill 里，哪个最适合用户最新的请求？每个 skill 用它自己的描述（主 agent 在列表里看到的那段），没有「都不合适」这个选项；装了两个以上只能由你本人触发的 skill 时，再单独问一题同样的问题（它们放在一题里会和能加载的 skill 互相抢概率）。同一个请求里还有 cookbook 的三道是非题，换三种说法问这条消息是要动手做事还是只要解释：要不要操作你的文件、账户、设备或在线服务；一个细心的专家会不会照某个现成的流程或命令来做；一个懂行的人能不能光用文字就答完（这一道反过来算）。三道的平均低于门槛（Jev、pplx 0.30，d1-ultra 0.2）就不推荐，也不发第二段。过了门槛，每题排在前面的三个进入第二段：再发一个请求，问的是同样的消息和对话，一道选择题在这三个里选一个（每个用描述加 SKILL.md 正文前 700 个字符），再对每个 skill 单独问「它是否正好做这条消息要的事」（问题里带着它的描述），回答的概率（0 到 1）是相关度。选择题决定推荐哪个，相关度决定说不说：三个里相关度最高的过了门槛（Jev、pplx ≥ 0.30，d1-ultra > 0.5），就推荐选择题选中的那一个，最多一个；否则不推荐。给主 agent 的文字照 cookbook：`Relevant to the current request: <名字>. Ignore this if it does not fit what the user actually asked for.`，这段对话里第一次提到的 skill 另起一行写上它的描述（cookbook 的 agent 有完整列表，这里列表被拿走了）；没有推荐时也附一句 `No skill in the roster appears relevant to this request.`，不让主 agent 自己去猜。只能由你触发的 skill 同样走一遍，选中的只在看板上提示你。
- **两个请求共用一次等待。** 消息最多等 `timeoutMs`（有请求带长上下文请求头时取 `timeoutMs` 和 `longWaitMs` 里较大的，Jev 是 3000，`waitFor`）：第二个请求用第一个请求剩下的时间；选 Jev 时至少给它 800 毫秒（`BACKEND_DEFAULTS` 的 `skillsSecondStageMs`，`core/skills.ts` 的 `secondStageMs`；两段合计不超过 8000 毫秒，给 hook 的 10 秒留余地），d1-ultra 1500 毫秒，pplx 没有保底（它的等待本来就是几秒）。第二个请求超时或失败时，这条消息不推荐 skill，也不附任何文字，照常进入，看板的事件流记一条失败和原因，例如 `jev：800 毫秒内没有回答`；effort 的判断不受影响。2026-10-19 的实测（当时第一段带画像，约 2.6 万 token）：单个会话第一段 0.6–0.84 秒、第二段 0.27–0.48 秒，同一个 key 上 5 个会话同时发消息时第一段到 0.86–1.3 秒，共用 1500 毫秒时第二段只剩 150–300 毫秒，15 条里 3 条第二段没发出去就判了超时；保底 800 毫秒后同样的并发 10 条全部推荐成功。0.9.0 起第一段只带描述，第二段在三道是非题说要 skill 时总会发，都没有重测。
- **已经推荐过的只再提名字。** 同一段对话里描述过一次的 skill，再推荐时只写 cookbook 的那句话，不再写描述。`/compact` 和 `/clear` 之后重新给描述。
- **只能由你触发的 skill**（SKILL.md 的 frontmatter 写了 `disable-model-invocation: true`）从不推荐给主 agent，Skill 工具也加载不了它们。合适时看板提示你自己输入，例如「可试 /grill-me」。settings 的 `skillOverrides` 设成 `off` 的 skill 不提示。
- **列表的位置上是一句固定的提示。** 主 agent 读到的不是空白，而是：`Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it. For any other skill, call the find_skill tool (mcp__dispatch-pilot__find_skill; load it with ToolSearch first if it is deferred) with a few words on the work, then load a skill it returns with the Skill tool by its exact name.` 也就是：skill 不再列出；和消息相关的会随消息推荐；需要别的 skill 时用 `find_skill` 按几个词查找，再用 Skill 工具按名字加载。写出 `find_skill` 的全名、提到 ToolSearch，是因为它是延迟加载的工具，加载之前主 agent 只看得到名字。`skillsAlwaysListed` 里的 skill 照旧留在列表里，提示跟在它们后面。提示不含任何 skill 的名字或数量，每次问到都一字不差，不破坏 prompt cache（360 个字符，本机原来的列表 18,397 个）。实测它并不能让主 agent 主动去查 skill（见「开发」里的「已实测的引擎行为」）。
- **`find-skill` 关掉时，提示不提 `find_skill`**，最后一句换成 `...; load one, or any skill you know, with the Skill tool by its exact name.`。用哪一句，看的是引擎问到列表那一刻 `find-skill` 开关的状态。引擎在整段对话里沿用这个回答，对话中途调用 `$.ui.invalidate` 也不会重问（已实测），所以**对话中途切换 `find-skill`，提示要到下一段对话（`/clear` 或新会话）才跟着变**；`/compact` 之后引擎不再问列表（#10 实测），提示既不会变，也不会重发。这期间工具本身按当前的开关回答：中途关掉后，主 agent 照提示去调用，会得到「已关闭」的回答，不发请求；中途打开后，下一段对话之前，主 agent 只能从延迟加载的工具名里看到它。
- **主 agent 仍然可以按名字加载任何 skill。** 隐藏的只是列表，skill 本身和 Skill 工具不变（已实测，包括 `anthropic-skills:` 开头的同步 skill）。`skillsAlwaysListed` 里的 skill 留在列表里，推荐到它们时只写名字。派出 agent 和 Workflow 里的 agent 的列表不动。
- **什么时候不隐藏。** 没有配置决策模型（没有 TypeSafe 的 key）、读不到本会话的 skill、没有一个能推荐的 skill（主 agent 能加载的一个都没有，或者都在 `skillsNeverSuggested` 里），或者 skill 推荐被关掉时，主 agent 照常读完整的列表。没有能推荐的 skill 时，只能由你触发的 skill 照样会在看板上提示。
- **开关。** `/dp skills off`（以及 `/dp off`）停止推荐，并把列表还给主 agent：之后引擎再问到的列表原样放行；这段对话里已经被拦下的列表（引擎在整段对话里沿用当时的回答），随你的下一条消息作为附件补给主 agent，只补一次，`/compact` 之后再补一次。`/dp skills on` 恢复推荐；已经还给主 agent 的列表留在这段对话里，下一段对话（`/clear` 或新会话）起才重新隐藏。这个开关默认打开，两个决策模型一样：开关在 register 时定义，那时还不知道最后用哪个决策模型（`core/setup.ts` 的 `Ctx`），所以它的默认值不进 `BACKEND_DEFAULTS`。`find_skill` 不跟这个开关走，照样注册、照样回答。
- **看板和日志。** 每条消息推荐的 skill（带相关度）和给你的提示（「可试 /grill-me」）是事件流里的一条，一轮结束后那一行末尾也写「可试 /x」。每次推荐都记进决策日志（`/dp log`）和 debug log，写出三道是非题的平均和门槛、第一段每题排在前面的 skill 和概率、第二段每个 skill 的相关度和门槛，以及选择题选中谁，例如 `推荐 tdd · "先写一个失败的测试再实现登录限流"：要不要 skill 0.86（低于 0.30 不推荐）；第一段 tdd 0.72、code-review 0.27、anthropic-skills:computer-use 0.01；第二段相关度 tdd 0.97、code-review 0.41、anthropic-skills:computer-use 0.00（≥ 0.30 才推荐），选择题选 tdd`；三道是非题说不要时只写第一句，例如 `没有推荐 skill · "这个报错什么意思"：要不要 skill 0.02（低于 0.30 不推荐）`。

### find_skill：主 agent 中途查询 skill

推荐只在你发消息时做一次。一轮进行中，主 agent 发现手头的工作可能有合适的 skill（例如要处理某种文件格式、用某个服务的工具，或者按某种流程审查、规划、发布），可以调用 `find_skill` 工具，用几个词说明要做的工作：

- **同一套排序。** 请求和发消息时推荐用的是同一个排序入口（`modRanker`）、同样的两段，第一段的选择题和发消息时那一题主 agent 能加载的 skill 一字不差（只能由你触发的 skill 不问），最近的对话也按同样的规则截取（`contextMessages`、`contextTokens`，不含文件内容和工具输出，先脱敏）；只是 `user_message` 换成主 agent 写的查询，不问 effort，也不问那三道「要不要 skill」：主 agent 已经在要 skill 了。两个请求共用一次等待：第二个只能用第一个剩下的时间。
- **等多久。** 两个请求合计等 `findSkillWaitMs`（Jev 是 `timeoutMs`，和发消息时一样；pplx 和 d1-ultra 6000 毫秒）。这个值写在 `core/setup.ts` 的 `BACKEND_DEFAULTS`，按延迟定，没有校准，不是配置项。hook 自己的时间上限是 10 秒，只算它自己的代码和 `$.clock.sleep`，不算 `next` 和别的 `$` 调用（mods reference 的 Limits 一节；生成的类型里是 `HookBudget`），后端的超时正是用 `$.clock.sleep` 计的。
- **返回什么。** 第一段排在前面的 `findSkillMax` 个都在第二段逐个判断，相关度过了决策模型的门槛（Jev、pplx ≥ 0.30，d1-ultra > 0.5）的都返回，按相关度从高到低（一样高时选择题给得多的在前），每个写名字（Skill 工具接受的写法，同步来的 skill 带 `anthropic-skills:` 前缀）、相关度和描述。主 agent 再用 Skill 工具按名字加载。都不够相关时，回答没有合适的 skill，并提示主 agent 不用 skill 继续，或者按名字加载它已知的 skill。
- **只在被调用时回答。** 一轮中途不会主动推送 skill；结果只作为这次工具调用的回答交给主 agent。
- **不返回的 skill。** 只能由你本人触发的 skill 和 `skillsNeverSuggested` 里的 skill 既不问也不返回。派出 agent 调用时，工具让它从自己的 skill 列表里挑（派出 agent 的列表没有隐藏），不发请求。
- **不影响缓存。** 工具在会话开始时注册（只在配置了决策模型时），描述固定不变，不含任何会话内容。注册时带 `isDeferred: false`（2.1.293 起生效）：它和它的描述直接在主 agent 的工具列表里，不在 ToolSearch 后面（2.1.300 用 event-probe 实测：它的 `tool.describe` 里没有 `isDeferred`，即在列表里；同一会话里 haiku 被问到时却自称它是延迟加载的，模型的自述不可信）。0.4.4 及以前没带，实测是延迟加载的工具（主 agent 的工具列表里先只有它的名字，用 ToolSearch 加载之后才调用），2.1.293 之前的引擎也仍是这样，所以 skill 列表换成的那句提示写出了它的全名，并说明延迟加载时要先用 ToolSearch 加载（见上一节）。
- **开关。** `/dp find-skill off`（以及 `/dp off`）之后，工具仍然注册着，调用时只回答它已关闭、可以用 `/dp find-skill on` 打开，不发请求；列表位置上的提示也不再提它，从下一段对话起生效（见上一节）。它和 skill 推荐的开关 `skills` 互相独立：推荐关掉时 `find_skill` 仍然回答（会话开始没有读 skill 目录的话，第一次调用时再读）。
- **失败时放行。** 决策模型超时、出错、回答里没有 skill 问题（两个请求中任何一个），读不到本会话的 skill，或者 mod 自己出错时，工具都立即回答失败的原因，并提示主 agent 不用 skill 继续，或者按名字加载已知的 skill。看板的事件流记一条失败和原因，例如 `jev：1500 毫秒内没有回答`。两个请求共用一次等待，第二个的保底（Jev 800 毫秒）和发消息时一样（见上面「两个请求共用一次等待」）。
- **看板和日志。** 每次查询是事件流里的一条：查了什么、返回了哪些 skill（带相关度），没有合适的写「没有合适的 skill」。每次查询的两个请求都写进 debug log，结果记进决策日志（`/dp log`）和 debug log，例如 `查到 anthropic-skills:pdf、code-review · "fill in a form in a PDF"：第一段 anthropic-skills:pdf 0.76、code-review 0.22、tdd 0.02；第二段相关度 anthropic-skills:pdf 0.93、code-review 0.61、tdd 0.00（≥ 0.30 才返回）；最多返回 5 个`。

### 控制：`/dp`

```
/dp                    打开依据面板；已经打开时关掉它
/dp log                打开依据面板（老习惯的别名，不会关掉它）
/dp status             是否开启、effort 的锁定状态、各项功能的开关
/dp on | off           总开关。关闭后不发任何决策请求，每一步都按引擎原样发出（锁定也不生效），脚部写 ○ dp 已关
/dp <功能> on | off    单项功能的开关，例如 /dp main-effort off（功能名见 /dp status 的列表）
/dp lock <档位>        把主 agent 的 effort 锁在 low、medium、high、xhigh 或 max，这一轮的每一步和之后的每一轮都用它，优先于决策
/dp unlock             解除锁定（也可以写 /dp lock off）
/dp log N              在对话里列出最近 N 次决策和理由，最新的在最后（最多 300；日志保留最近 20 轮、最多 300 条）
```

- 命令在一轮进行中也立即执行：锁定或解锁从下一步起生效。
- 开关保存在 `$.store`，下次启动会话时还是你离开时的样子；只保存和默认值不同的开关，所以一个新增的功能默认开着。几个会话同时在用时，改动不会覆盖别的会话刚保存的开关，但已经在运行的会话要到下次启动才会读到。
- 锁定只在当前会话里有效，`/dp unlock` 或会话结束时解除。锁定期间决策照常进行并记录（锁定优先），不想为此等决策模型的话，用 `/dp main-effort off`。
- `/dp log N` 列出每项功能记录的决策：做了什么决定、针对哪条消息、理由（决策模型给出的各档概率、回答的位置、抬高它的那条下限，置信度只记录）。`/dp`、`/dp status`、`/dp log N` 和各开关的回答都是中文，格式见下面的「语言」。同样的内容也写进 debug log，依据面板的决策日志也是这些条目。
- 会话的读数（上下文占用、5 小时和 7 天限额的百分比、会话花费）每次变化时写一行进 debug log，例如 `signals: context 3% (28866/1000000 tokens); limits five_hour 26% resets ..., seven_day 50% resets ...; cost $0.1433; changed context, rateLimits, cost`。这些读数只是记录，不参与任何决策，留给以后设计「省额度模式」用；`/dp signals off` 可以停止记录。

## 配置

这一节逐个说明配置项，留着每个选项的校准依据。默认值只写在 README 的配置表里（`node dispatch-pilot/eval/validate.ts docs` 核对它和 manifest、`BACKEND_DEFAULTS` 一致），这里不再重复。

**按决策模型取值的表（`core/setup.ts` 的 `BACKEND_DEFAULTS`）。** 每个决策模型一项，里面有：按决策模型取默认值的选项（`PER_BACKEND_OPTIONS`；这些选项在 manifest 里不能有 `default`，README 每张配置表里每个决策模型一列）；`contextTokensMax`、`contextMessagesMax` 两个上限；问法 `ask`（`turnStart` 是发消息时的 effort part，`agent` 是派出 agent 和 Workflow 里 agent 的题，`other` 是其余所有问题，mod 里的 `ctx.ask` 就是 `other`；0.9.0 起两个决策模型都是英文，ADR 0014）；skill 推荐和 `find_skill` 的几项；agent 的请求带不带背景（`agentBackground`）、长请求至少等多久（`longWaitMs`，Jev 3000，pplx 没有）、关于 agent 的请求同时在途几个（`agentLanes`，Jev 4，pplx 5）。这些值 mod 和评测读的是同一张表（`readConfig`，评测经 `settingsFrom`）。加一个决策模型：往表里加一项，`eval/lib/docs.ts` 的 `BACKENDS` 加一行，README 每张配置表加一列。`readConfig` 和 `settingsFrom` 的第二个参数可以传别的表（默认是 `BACKEND_DEFAULTS`），用来读一个表里还没有的决策模型；表里现在有 Jev 和 pplx 两项（#50），它们在每个值上都不同，`tests/backend-defaults.test.ts` 就拿这两项对比，看每个值是否传到用它的地方。

在 `/config` 里设置，或写在 settings 的 `pluginConfigs` 里：

| 选项 | 说明 |
|---|---|
| `decisionModel` | 决策模型，在 `/config` 里是下拉选择：`jev`（TypeSafe）或 `pplx`（Perplexity，#50，0.9.0 起不再评测）。默认 `jev`（ADR 0014；0.4.0 到 0.8.x 默认 `pplx`，#52，ADR 0006）；填了别的值（包括已移除的 `clef`），引擎按默认值处理并给出警告。只看这个值，不按密钥换（下面「选哪个决策模型」）。 |
| `typesafeApiKey` | TypeSafe 的 API key，是敏感字段，保存在安全存储里。为空时读环境变量 `TYPESAFE_API_KEY`（#35），两处都有用这里的；两处都没有，Jev 不发送任何请求。读法见「pplx 的默认值和密钥」。 |
| `perplexityApiKey` | Perplexity 的 API key（#50），是敏感字段。为空时读环境变量 `PERPLEXITY_API_KEY`，两处都有用这里的。读法见「pplx 的默认值和密钥」。 |
| `timeoutMs` | 等待决策模型的最长时间，范围 200–8000 毫秒。 |
| `contextMessages` | 随你的消息一起发送的最近消息条数，范围 0 到决策模型的上限（`BACKEND_DEFAULTS` 的 `contextMessagesMax`，两个决策模型都是 2000；Jev 在 2026-10-15 之前是 32）。默认取上限：真正限制发多少的是 `contextTokens`，放不下的旧消息整条丢掉（见「Jev 的上下文默认值怎么算」）。 |
| `contextTokens` | 发给决策模型的 state 的 token 预算，范围 100–16000：你的消息加上最近对话，按发出去的样子数（整个 state 序列化成 JSON，连同字段名、引号和转义）。默认值按 Jev 的上限算出来，而且按请求的种类分开取：带 skill 题的请求一个值，其余种类一个更大的值；你设了值，每个种类取它和自己上限里较小的一个（见「Jev 的上下文默认值怎么算」）。整个 state 都要在预算之内，不靠字段的顺序。 |
| `escalateAfter` | 一个派出 agent（包括 Workflow 里的）计入的失败累计满几次，就从它的下一步起升一档模型（见「失败时升模型」），范围 1–20。是累计，不是接连：中间成功一次不清零，升过一次（或到了门槛却升不了）之后重新数。主 agent 的失败不升任何东西，这一轮结束时记下计入的失败到没到这个数（`facts.stuck`，规则 R4 读它）。0.9.0 之前到了这个数是问决策模型、强制升 effort。 |
| `escalateLimit` | 一个派出 agent 最多升几次模型，范围 0–10；0 表示只数不升。 |
| `escalateHaikuTo` | 失败的 haiku agent 升到哪个模型。写别名（`sonnet`、`opus`、`fable`）或完整的模型 id；别名由 mod 换成步骤需要的完整 id（`decision/model-ids.ts`，引擎对每一步的模型不认别名），不是已知模型的值不换。你为这个 agent 点名的模型不换，你排除的模型跳过。留空表示 haiku 不升。0.9.0 之前是 haiku 的 effort 到顶之后才换。 |
| `agentFable` | 打开后，派出 agent（包括 Workflow 里的）的可选模型加入 fable（比 opus 更贵）。你自己点名 fable 时不受这个开关限制。 |
| `summaryModel` | 写问题摘要的模型（#40），写别名（`haiku`）或完整的模型 id，默认 `haiku`；读成 `ctx.config.unresolved.summaryModel`。0.9.0 起摘要用英文写。 |
| `unresolvedMaxAfter` | 规则 R5（ADR 0014）：这条消息 `still_failing` 为是、而且未解决次数（算上这一条）到这个数时直接 max，0 到 10，默认 3，0 从不；读成 `ctx.config.unresolved.maxAfter`。0.6.2 到 0.8.x 它是给强提示的次数（#41）。 |
| `skillsAlwaysListed` | 一直留在主 agent 的 skill 列表里的 skill，写列表里的名字（同步来的 skill 要带前缀，例如 `anthropic-skills:pdf`）。 |
| `skillsNeverSuggested` | 从不推荐给主 agent、也不提示你的 skill，同样写列表里的名字。它们照常安装，Skill 工具照样能按名字加载。`find_skill` 也不返回它们。 |
| `findSkillMax` | `find_skill` 一次最多返回几个 skill，范围 1–10；第一段排在前面的这么多个在第二段逐个判断。推荐和 `find_skill` 的门槛不是选项，按决策模型的官方指南（`decision/guides.ts`，ADR 0018）。0.8.x 的 `skillsMax`、`skillsMinRelevance`、`skillsShortlist`、`findSkillMinRelevance`、`skillsProfileModel`、`skillsProfilesPerSession` 去掉了。 |
| `workflowMode` | Workflow 里的 agent 怎么路由：`rewrite` 把决定写进脚本再运行；`return` 第一次提交被拒绝并附上逐个 agent 的推荐，让主 agent 自己写进去，同一个 Workflow 第二次提交直接放行（见「Workflow 里的 agent」）。在 `/config` 里是下拉选择。 |

**按决策模型取的默认值（#17）。** 上表里这 3 项（`timeoutMs`、`contextMessages`、`contextTokens`；0.9.0 之前还有 `skillsMinRelevance`、`findSkillMinRelevance`、`thetaMax`、`agentOverride`，以及中途重判和「预期内失败」的 5 项），默认值取决于决策模型。它们在 manifest 里没有默认值，所以 `/config` 里显示为空，你不设时引擎什么也不传（kit 的测试和真实引擎都确认过），Dispatch Pilot 按决策模型取默认值（Jev 和 pplx 各一列，`core/setup.ts` 的 `BACKEND_DEFAULTS`；`contextTokens`、`contextMessages` 的默认值 0.2.1 起按 Jev 的上限取，见下面的「Jev 的上下文默认值怎么算」）。另外，问题的语言（0.9.0 起两个决策模型都是英文，ADR 0014）、`find_skill` 的等待和第一段带不带画像（见「find_skill：主 agent 中途查询 skill」），也按决策模型取，这些不是配置项，依据见「待评测」。你自己设了某一项，就用你设的值。会话开始时 debug log 写一行哪些选项用了默认值，例如 `settings for jev: left unset, so jev's defaults: timeoutMs 1500, ...; skill suggestions on until /dp skills off; contextTokens 20000 reads as 16000, the most with jev`。skill 推荐那一段按此刻的开关写：`skills` 开着而且 `skillsMax` 大于 0 时是 `skill suggestions on until /dp skills off`，开关关着时是 `skill suggestions off (/dp skills on)`，`skillsMax` 为 0 时是 `skill suggestions off (skillsMax 0)`（`describeDefaults` 读 `core/switches.ts` 的开关，所以 `session.start` 先载入开关再写这一行）。

这些默认值大多是暂定的。按用户的决定（2026-10-05），#17 没有再跑对比或扫描评测：`skillsMinRelevance` 按 #16 已有的数据改成 0.75，Jev 的上下文三项在 0.2.1 按 Jev 的上限取（下一节）；`escalateAfter` 和 `escalateLimit` 都还是起点（`agentOverride` 0.9.0 删了，ADR 0015；skill 的门槛和短名单 0.9.0 起照官方指南，不再是选项，ADR 0018），现有的数据和没做的评测见「待评测」。

### pplx 的默认值和密钥

`decisionModel: pplx`（#50，ADR 0006 的 B′）用 Perplexity 的 `pplx-decider-v1.1-27b`（`POST https://api.perplexity.ai/v1/decisions`，Bearer key；请求体只有 `model`、`state`、`questions`，多一个顶层字段 API 就回 400）。它的一行在 `BACKEND_DEFAULTS.pplx`，值和依据：

| 项 | 值 | 依据 |
|---|---|---|
| `timeoutMs`、`findSkillWaitMs` | 8000、6000 | 请求要几秒（eval v2 的 B′ 约 5 秒）；hook 自己的上限是 10 秒，`timeoutMs` 的上限本来就是 8000 |
| `contextMessages`（默认和上限） | 2000 | 和 eval v2 的 B′ 一致（`--state-messages 2000`），实际由 token 预算截断 |
| 发消息 effort、Workflow 一个请求的预算 | 各 48000 | eval v2 的 B′；一个请求最多 262,144 token，不受 Jev 那 32k 的限制，但时间才是限制：48000 估算 token 的 state 单发 4.3–5.9 秒（下面「pplx 的 agent 预算」） |
| 派出 agent 的预算（也是 Workflow 分几个请求时每个的、agent 启动时当场判断的） | 32000 | 几个 agent 一起派出，每个请求都被对话填满：同时 5 个 32000 都在 5.2 秒内答完，3 个 48000 最慢 7.6 秒（下面「pplx 的 agent 预算」，ADR 0007） |
| agent 的背景（`agentBackground`） | 开 | 派出 agent 带对话，Workflow 带脚本和对话；Jev 2026-10-15 起也开（ADR 0007、0009） |
| 长请求的等待（`longWaitMs`） | 没有 | pplx 每个请求都收 262k，不分常规和长上下文；它自己的等待本来就是几秒 |
| 关于 agent 的请求同时在途（`agentLanes`） | 5 | 同时发 5 个 32000 的请求都在 5.2 秒内答完；`pplxQps` 也是 5 |
| `contextTokens`（skill 两段的预算） | 6000 | B′ 没有评测过 skill 题，沿用 Jev 的值（两个模型的 skill 选择题一样长） |
| `ask` | 所有问题英文，Score | eval v2：pplx 英文问法更准 |
| 定档的规则 | 和 Jev 一样 | 0.9.0 起写在代码里（ADR 0014），不随决策模型变；0.8.x 按已存的 pplx 回答离线定的 `thetaMax` 0.47、`roundUp` 0.45 随之去掉；pplx 不再评测 |
| 两个相关度门槛 | 沿用 Jev 的 0.75、0.5 | 没有为 pplx 校准过 |
| `findSkillProfiles` | 开 | 同 Jev |

**密钥怎么读。** `perplexityApiKey`（userConfig）优先，空时用环境变量 `PERPLEXITY_API_KEY`；TypeSafe 的一样，`typesafeApiKey` 优先，空时用 `TYPESAFE_API_KEY`（0.7.1，#35：Claude Desktop 的 Code 标签收不到 keychain 里的敏感 userConfig，上游 anthropics/claude-code#89749，两项在那里总是空的）。下面以 Perplexity 为例，TypeSafe 的对应 `ctx.secrets.typesafeEnvKey`、`typesafeKey(config, secrets)`，`jevBackend` 同样收一个 `() => string`，`setup()` 的 `keys()`（选决策模型、选图像后端）也读 `typesafeKey`。`$.env.get` 是异步的、要 `$`，`setup()` 和 `readConfig` 是同步的、没有 `$`，`$` 也不能跨 import；所以环境变量在 `session.start`（`features/control.ts`）里读一次，存进 `ctx.secrets.perplexityEnvKey`（`Secrets`，`core/setup.ts`；热重载会重新触发 `session.start`），pplx 的后端每次 `ask` 时才取 `perplexityKey(config, secrets)`（`pplxBackend` 收一个 `() => string`；`Backend.configured` 是它的 getter，所以各功能读 `configured` 时看到的就是现在有没有 key）。没有放进 `BackendIo` 的闭包里，是因为那要在 9 处 `io` 字面量里各写一遍 `$.env.get('PERPLEXITY_API_KEY')`，而且 #52 要在发请求之前、同步地知道有没有 key（选 pplx 还是退回 Jev，决定 `Config` 用哪一行）：那也只能在 `session.start` 读好再用（下一段）。key 只出现在请求头里：两个后端都用 `backend.ts` 的 `withoutKey` 把失败的 detail 里出现的 key 换成 `[REDACTED]`，`session.start` 的 debug log 只写 key 从哪里来（`keySource`：`pplx key: from the options` / `from PERPLEXITY_API_KEY` / `not set`；Jev 决策或看图时还有一行 `jev key: …`，变量名是 `TYPESAFE_API_KEY`）。`tests/pplx-model.test.ts` 的测试在日志、看板、toast 里搜 key 的原文，`tests/typesafe-key.test.ts` 另外搜每一次 `$.state` 写入。`Config` 里的 `typesafeApiKey`、`perplexityApiKey` 是不可枚举的属性（`readConfig` 用 `Object.defineProperties` 加上），`JSON.stringify(config)`、`{ ...config }`、`Object.keys` 都碰不到它们，以后有人把 config 写进日志或评测结果文件也带不出 key（`tests/backend-defaults.test.ts` 锁定）；取 key 的地方照旧读 `config.perplexityApiKey`，但不要复制一份 config 再从副本取 key。

**限速和 429（#51；默认值见 ADR 0007）。** 当初按 Tier 0 账户限 1 QPS 把 `pplxQps` 默认设成 1。Perplexity 的文档现在写「Every organization can send 10 requests per second to the Decisions API, on every plan. A token limit also applies to large bursts.」（docs/decisions/quickstart，2026-10-13 读；突发的 token 限额没写多少），实测同时发 5 个、8 个 24000 估算 token 的请求都没有 429，所以 0.4.3 把默认改成 5：按 1 个每秒排队时，5 个一起派出的 agent 第 4、5 个要 8.5、10.7 秒才答完（超过 8 秒的等待），同时发都在 4.8 秒内；5 而不是 10，是给同一个 key 的其他会话留出余量。一条消息发 2 到 3 个请求（effort、skill 第一段和第二段），派出 agent、`find_skill` 也在抢。`setup()` 把 `pplxBackend` 包进 `decision/pplx-rate.ts` 的 `rateLimited(backend, qps)`（#52 之后 `setup()` 为 pplx 那一份 `Config` 建它，用 `configs.pplx.pplxQps`；pplx 那支始终经过它，不管最后选的是不是 pplx），所以所有 pplx 请求都经它；Jev 有自己的限速（`decision/jev-rate.ts`，见「Jev 的限速」）。要点：
- **每秒最多 `pplxQps` 个。** 滑动窗口，不是固定间隔：`pplxQps: 2` 时两个请求同时发出，第三个等到最早那个满一秒。最近发出的时间（至多 `pplxQps` 个）记在 `$.state` 的 `pplxRate`（`number[]`），热重载后不会一下子放出一串；改发送时间用 `$.state` 的版本号做乐观并发（`ifVersion`），读写失败、或者写入连续 8 次被别的写入抢先，就放行（最坏是 Perplexity 自己回 429），并在这个请求的 debug log 那一行末尾写 `rate limit not kept (...)`（`Asked.notes`，`describeAsked` 会带上）。限速保证的是计数（乐观写入）；先后顺序只保证到「队首开始占位」为止：占位中的那几次 await 里到的更优先请求，要等下一个位置。
- **排队。** 排队的队列是 `decision/rate-queue.ts` 的 `rateQueue()`，pplx 和 Jev 的限速共用（各用自己的一个队列；队列是后端对象的状态，热重载丢了也没关系：旧模块的请求引擎自己会丢掉）；这个文件还有 `priorityOf`（优先级）、`handedOver`（交出去的回答）和 `LEAST_SEND_MS`。队首永远是优先级最高、来得最早的一个：发消息的 effort 请求（问题名以 `effort.` 开头）优先级 0，其余都是 1，先来先发。一个请求在被问的那一刻拿一张 `Ticket`（`priority`、`order`），重试也用这一张。队首轮到的时候才占位，所以一个更优先的请求后来也能插到已经在等的 skill 请求前面。等不到位的请求（占位要等到离它的 deadline 不到 `LEAST_SEND_MS`，200 毫秒）当场失败，不白等；占到位、却只剩不到 200 毫秒的，也不发。
- **排队的时间算进该请求自己的等待。** `ask(io, request, timeoutMs)` 的 `timeoutMs` 从被问的那一刻算起，发出去之后只剩下没用完的部分；等不回来的失败写的仍是 `no answer in <timeoutMs> ms`。skill 第二段本来就用第一段剩下的时间，所以自然包括排队。
- **429。** `pplxFailure` 把 `Retry-After`（整数秒，不区分大小写；日期形式不读）读成 `Failure.retryAfterMs`，只有 429 有。限速层收到 429 带着 `retryAfterMs` 时：剩余等待时间不少于 `retryAfterMs` 加 `EXPECTED_REQUEST_MS`（`pplx-rate.ts` 里不导出的常量，5000，ADR 0006 说的约 5 秒）就睡过 `Retry-After` 再问一次，用第二次的结果，第二次再 429 就是失败；不够、或者 429 没带可读的 `Retry-After`，就原样失败。`Retry-After` 的睡眠在队列之外（睡的时候不占队首）；睡完重新排队，用的还是它原来的 `Ticket`，位置和优先级都保留。其他失败都不重试。失败交出去之前去掉 `retryAfterMs`（`handedOver`），看板里存的 `failure` 形状不变。
- **「被限速」。** 429 的失败（`busy`，状态码 429）在看板、toast 和决策日志里写 `pplx：被限速（状态码 429）`，band 上写「决策模型被限速」，卡片的类型行写「请求太密，被决策模型限速了」（`FAILURE_WORDS`，只有 pplx 的 429 这样写：那是 mod 自己按 `pplxQps` 守的限速；Jev 的 429 仍是 0.3.1 的「繁忙（状态码 429）」「决策模型繁忙」；模型读到的英文 `busy (HTTP 429)` 没变）。
- **接线。** 限速需要时钟和 `$.state`，`$` 不能跨 import，所以 `BackendIo` 多了一个可选的 `pace`（`now`、`sentAt` 这个 `$.state` 的 Cell），发请求的 `io` 字面量（`core.ts`、`skills.ts`、`find-skill.ts`、`dispatched-agents.ts`、`workflow-agents.ts`、`workflow-labels.ts`、`image-routing.ts`、`visual-check.ts`）各写一遍。没给 `pace` 的（评测，它自己控制节奏）直接放行。Jev 的限速也靠它（只用 `now`，不用 `sentAt`）。新增一处 `ctx.backend.ask` 时记得给它的 `io` 加 `pace`，否则那个请求不受限速。
- **测试。** `tests/pplx-rate.test.ts`（接缝 1，`mock.clock`；`Sent.at` 是请求发出的时间，`Reply.headers` 给 429 带 `Retry-After`，`seed.pplxRate` 和 `w.pplxRate()` 读写限速的记录）；429 的分类和 `Retry-After` 的读取在 `tests/pplx.test.ts`（接缝 2）。别的 pplx 测试把 `pplxQps` 设成 50，免得被排队拖住；`pplx-rate.test.ts` 自己设 1，测按每秒一个排队。

**选哪个决策模型（ADR 0014；之前 #52，ADR 0006）。** `backendNameOf(options)`（`core/setup.ts`）：`decisionModel` 是 `pplx` 才用 pplx；其余（没设、`jev`、`clef`、拼错的值：引擎把选项列表之外的值读成 manifest 的默认值 `jev` 并警告，mod 看不到原值）都是 Jev。不按密钥换：所选模型没有 key 时，它的每次 `ask` 以 `config` 失败返回，`why` 写「jev：没有填 typesafeApiKey 或 TYPESAFE_API_KEY」（pplx 的写 `perplexityApiKey`、`PERPLEXITY_API_KEY`），每一轮按会话自己的 effort 走。0.4.0 到 0.8.x 的 `chooseBackend` 按密钥选（没有 Perplexity 的 key、有 TypeSafe 的 key 时退回 Jev，记 `fellBack`），0.9.0 删了：用户说只谈 Jev、Jev 是默认，自动换模型会让一个人在不知情时被另一套没评测过的回答路由。

**带图的决策请求和图像后端（#56，ADR 0008）。** 预备重构：不带图的请求一个字没变，带图的功能（看图核对、带图路由）后面的票才加。
- **请求。** `DecisionRequest.images?: RequestImage[]`（`decision/system-one.ts`：`name`、`format`、`base64`、`width`、`height`）。state 和题目的任何字符串里用 `imageRef(name)` 写引用（`⟦image:name⟧`），由后端换成各家的形式：Jev 换成 `<每个请求新生成的 UUID>-<name>`，图放顶层 `assets`（`data_base64` 加 `format`；引擎的 http body 只收字符串，所以不能 multipart），请求头 `TypeSafe-Danger-Zone-Images: true`，model 固定 `jev-1.14.0`（`jevBackend` 的 `model` 选项不管带图的请求）；pplx 的 state 变成数组：先是 state 的 JSON 文字（引用写成 `[image 1: name]`），再是每张图：一行 `[image 1: name]:` 加一个 `image_url` data URL。图放进题目 instructions 的引用，在 pplx 一样只能放在 state 里（所以图按题数重复计 token）。
- **拼请求就报错的情况**（`RangeError`，`ask` 接住，回 `request` 失败，不发出去）：pplx 超过 8 张；图名不合规或重名；有张图没有任何地方引用它（Jev 对没被引用的资产回 400）。写在 state 里、但 `images` 里没有这个名字的 `imageRef` 原样保留（可能就是用户消息里的文字）。
- **token 估算。** `imageTokens(backend, images, questions)`：Jev 约每百万像素 2,600，每张图只算一次；pplx 约每百万像素 1,000，再乘以题数。后端把 `describeImages` 的一句（张数、尺寸、估算 token）放进 `Asked.notes`，所有调用 `describeAsked` 的 debug log 行都会带上；日志里从不出现图的内容：失败详情里 60 个字符以上的 base64 串用 `withoutBase64` 去掉，密钥照旧 `[REDACTED]`。
- **图像后端。** `chooseImageBackend({ perplexity, typesafe })`（`core/setup.ts`，纯函数）和 `backendNameOf` 并列，不看 `decisionModel`：有 TypeSafe key → Jev；没有但有 Perplexity key → pplx（`fellBack: true`，放大复核不可用）；都没有 → `null`。`ctx.images` 是 `{ name, backend, fellBack } | null`，每次读都按当时的密钥算（环境里的 Perplexity key 在 `session.start` 才读到）；`backend` 就是 `ctx.backend` 用的同一批对象，所以 pplx 的带图请求照样排队限速——调用方的 `io` 要带 `pace`，和别的请求一样。`fellBack` 时 `session.start` 经决定汇报记一条「看图改用 pplx」（`feature` 仍是 `decision-model`，`outcome` 为「看图改用 pplx」，同一轮重复启动只留一条）；没有图像后端时只写一行 debug log。
- **Box 题。** `system-one.ts` 有 `BoxQuestion`、`BoxAnswer`（`readAnswer` 读 `box` 的四条边和 `confidence`）。框题没有「找不到」的答案。
- **测试。** `tests/image-request.test.ts`（接缝 2：两家的请求形状、token、debug log）、`tests/image-backend.test.ts`（密钥四种组合、`session.start` 的汇报）、`tests/image-world.test.ts`（world 的 `jev`、`pplx` 假后端认图：Jev 没带请求头回 400、`boxes` 给框题答案，pplx 第 9 张图回 400；pplx 带图请求的限速）。测试模块自己不能调 `$.http.fetch`，所以后两者里假后端放在测试自己的 `io.fetch` 后面。

**看图核对 `visual_check`（#57，ADR 0008）。** 只在有图像后端（`ctx.images`）时注册，`isDeferred: false`，名字 `mcp__dispatch-pilot__visual_check`；说明和 schema 是常量，说明按后端分两版（`visualCheckDescription('jev' | 'pplx')`：Jev 版有「放大复核」一段，pplx 版没有）。开关 `visual-check`（默认开）；开关关着或总开关关着，调用不发请求，回一句已关闭。派出 agent 调用和主 agent 一样（`e.agentId` 只用来分开连续不过的记录）。
- **分工。** 判断全在 `decision/` 的纯模块里，评测（#65）共用：`visual-check.ts`（`Check`、`Comparison`、`judge`、`wholeImageRequest`、`readWholeImage`、`noteResults`；还有 `requestImage(name, picture)`，把一张读好的图（`Picture`）变成请求里的图，放大复核、录屏抽帧和复杂度读数都用它，只此一处；以及 `percent`）和 `visual-check-tool.ts`（工具说明、schema、`parseVisualCheckInput`、`visualCheckText`；`checkLine` 是一条检查项的一行，档位序列的回答 `seriesText` 也用它）。读图规整是 `core/image-files.ts` 加 `decision/image-fit.ts`、`decision/image-header.ts`，别的功能（放大复核、录屏抽帧、复杂度读数、截图接管）直接调用。`LoadedImage` 是 `Picture & { file }`（读好的图加它在磁盘上的文件），`core/image-crops.ts` 的 `Crop` 是 `Picture & { rect }`；`asArgument`、`failedRun`（sips 失败的一句原因）由 `image-files.ts` 导出，`image-crops.ts` 共用。`features/visual-check.ts` 只做接线和流程。
- **一次调用的流程**（`features/visual-check.ts` 的 `check`，每个阶段留了后面的票接入的位置）：① `subjectsOf` 读图（截图和比较对象；录屏在这里抽成帧，见「录屏」）→ ② 请求一：每条检查项一道 Noul（题号 `check.<i>`），图在 state 里一次（`wholeImageRequest`；Jev 对着参考图或另一张截图时同一个请求里加框题，`withBoxes`，见下面「放大复核」）→ ③ 放大复核（#59，`zoomReview`，只走截图那一支，录屏不做）→ ④ 判定 → ⑤（#58）汇报 → 回答。任何一步失败，受影响的检查项记没把握并写明原因（`allUnsure`），工具从不报错。
- **判定。** 「一致」概率 ≥ 0.8 过，≤ 0.2 不过，其间没把握（两端都含）。门槛只在 `decision/visual-check.ts` 里写一遍，三组各有自己的常量：静态截图（整图、放大复核的裁图，`STILL_BARS`）过 `PASS_AT` 0.8、不过 `FAIL_AT` 0.2；录屏（按帧判，`RECORDING_BARS`）过同样是 `PASS_AT`、不过 `RECORDING_FAIL_AT` 0.4；档位序列的每一对（`SERIES_BARS`）过 `SERIES_PASS_AT` 0.9、不过 `FAIL_AT`。`judge(p, trust, bars = STILL_BARS)`，`readWholeImage`、`judgeZoom`、`zoomReview`、`comparePair` 都带可省的 `bars`，录屏那一支传 `RECORDING_BARS`，`core/quality-series.ts` 传 `SERIES_BARS`。放大复核失败时采信的整图「不过」仍按 `FAIL_AT`（0.2）。门槛是用户 2026-10-15 看了两次评测后定的（原来 0.9 / 0.2，见 ADR 0008 末尾的修订，和下面「看图核对」评测一节里重算的数）。没有参考图（文字规范，或什么都不给：每条检查项按自己的话）时过和不过都采信；有参考图或另一张截图（`reference`、`compare_to`）时整图只采信不过（`judge(p, 'fail')`），本该过的记没把握，原因写「a match with a reference cannot be confirmed from the whole image」，等放大复核来确认（放大复核做不了时就停在这里）。检查项的题：`In \`candidate\`, is the <property> of <part> the same as in \`reference\`?`（比较）；`In \`screenshot\`, does <part> meet this requirement: <property>?`（规范）。
- **回答。** 一个英文文字块（结论、概率、依据是整图还是放大复核；有「过」时加一句「过不是验收」），没把握时附整张缩过的截图，`look: true` 只回图（失败的图是一块说明原因的文字）。同一个 agent、同一个循环里同一条检查项（按部分和属性的文字，忽略大小写和空白）连续两次不过，文字末尾加提醒；记录是 `features/visual-check.ts` 的模块级 `streaks`，`turn.start` 清（主 agent 每轮，派出 agent 每次运行）。依据：派出 agent 的每次运行（包括被消息唤醒的）从 2.1.299 起有自己的、带 `agentId` 的 `turn.start`（2.1.300 实测，见「已实测」里 `turn.start` 和 `agent.spawn` 带 `resume` 那两条）；更早的引擎上 agent 没有被唤醒的运行，它唯一的一个循环从第一次调用算起，没有要清的东西，所以不必另按 `core/loop-start.ts` 的循环记。热重载丢掉的代价是少一次提醒；中间出现过或没把握就从头数。
- **读图规整**（`loadImage`）。sips 查尺寸和格式 → `planSize` 定尺寸（Jev：每边 256–1568、78,400–2,458,624 像素；pplx：不超过 2,048 个 32×32 图块；`look`：长边不超过 1568，小图不放大）→ 需要时 `sips -z H W [-s format png|jpeg]` 写到临时文件 → `$.fs.read` 的 bytes 模式 → JPEG 的 EXIF 方向不是 1 就转正（Jev 不应用方向；sips 读不出方向，所以从 JPEG 的字节里读 `readImageHeader`，再用 `uprightArgs`，七种方向对照 Pillow 的 `exif_transpose` 实测过）。格式：PNG 和 JPEG 原样，HEIC 一类照片转 JPEG（质量 85），其余转 PNG。引擎只读 4 MiB：读被拒（不管错误文字，引擎的措辞没测过）就依次改成 JPEG、3/4 大小、1/2 大小再读。一次请求的图合计有 token 预算（`imageMegapixelBudget`：Jev 24k，pplx 32k 再除以题数），超了统一缩一个份额重做（`loadImages`）。临时文件在 `$TMPDIR`（没有就 `/tmp`）下 `dispatch-pilot-<随机>/`，会话里第一次要用时建，不清理。
- **不在 CLI**（`$.process.run` 拒绝）。没有 sips：读 bytes，按文件头判断，PNG 或 JPEG、在限制内、方向正才直接发；其余写明原因记没把握。
- **文字不脱敏。** 看图核对发出去的文字（`spec`、检查项的部件和属性，录屏、放大复核的题里也是）原样发出，不经 `redactSecrets`；只有不带图的决策请求才脱敏。这是用户 2026-10-15 的决定（审查时曾提出带图请求的文字也要脱敏，用户不做），README「图像：发给谁，什么时候发」一节如实写了这一点。
- **请求的等待。** 每个带图请求最多 8 秒（`REQUEST_MS`，不受发消息时 Jev 的 1500 毫秒限制），但一次调用里所有请求共用 hook 的 10 秒（ADR 0007）：`core/call-budget.ts` 的 `callBudget` 记着这次调用已经等了多久（算「至少有一个请求在等」的时间，同时发的请求只算一次，sips 和 ffmpeg 的运行不算：`$.process.run` 不计时），总预算 `CALL_ROOM_MS`（9000，留 1 秒给 hook 的其余部分；`callBudget(now)` 没有别的预算可选，带图路由发消息时 effort 请求在读数之后的等待也用同一个常量）；每个请求的上限取 `min(REQUEST_MS, 剩余)`，剩余不到 `LEAST_REQUEST_MS`（1500，`core/call-budget.ts` 里不导出的常量）就不发，相关检查项记没把握，理由是 `no time left in this call`。同时发的请求在引擎那边怎么计时没实测（和带图路由的两个请求同一个假设）。pplx 的请求带 `pace`，照样限速。debug log 一行：`visual_check request [check.0, ...] to jev: answered in 310 ms by ... (N input tokens); images: 1 (1200x800), about 2496 tokens`，从不写图的内容和密钥。
- **输入的取舍**（票没写死的地方）。① 比较对象至多一种（`reference`、`compare_to`、`sequence`、`spec`），两种以上回文字说明；一种都不给时每条检查项按自己的话判（和文字规范同样处理）。② 非 `look`、非 `sequence` 的调用 `images` 只能有一张（要核对几张就调用几次；`reference` 可以多张，都放进同一个请求）。③ `sequence`（#61）见「档位序列」一节，录屏（#60）见「录屏」一条。④ `same_view` 给放大复核用（不给就按两张图的宽高比推断）。⑤ pplx 一次请求最多 8 张图（截图加参考图），多了在读图之前就记没把握。
- **录屏（#60）。** `images` 的路径按扩展名认录屏（`isRecording`：mov、mp4、m4v、webm、mkv、avi 等；GIF 是 sips 读得动的图，不算）。只有要核对的那一个可以是录屏，且只对文字规范或不给对象（`reference`、`compare_to` 回「没把握」并写明原因，参考图是录屏也一样）。输入多两个可选数：`from_seconds`、`to_seconds`（默认全片；`to` 要大于 `from`，数字字符串也收；非录屏时忽略）。
  - **抽帧**（`core/video-frames.ts` 的 `readRecording`，经 `ImageFilesIo.run`，位置在 `subjectsOf` 里）：先 `ffmpeg -hide_banner -i <文件>` 从 stderr 的 `Duration:` 读长度（它以 exit code 1 结束，没有输出文件，是正常的），再按 `frameTimes` 在时间段内均匀取 N 个时刻（Jev 12、pplx 8，`FRAME_COUNT`；首尾都取；到全片结尾时最后一帧往前让 0.1 秒，因为 ffmpeg 在 `-ss` 等于结尾时没有帧），一帧一次 `ffmpeg -hide_banner -loglevel error -y -ss <秒> -i <文件> -frames:v 1 -q:v 2 <临时>.jpg`，每次最多 60 秒（`$.process.run` 默认 30 秒不够长录屏 seek）。某个时刻没有帧（exit ≠ 0；变帧率的录屏画面静止到结尾时会这样）就依次往前退 0.25、1、4、16 秒再试，退到时间段起点之前就放弃；帧上记的是真正取的那一秒。文件路径不是绝对路径的一律写成 `./路径`，不会被当成选项或协议（`http:`、`concat:`）。验证过：ffmpeg 8.1.2 在 `-ss` 超出最后一帧时 exit 234 且不写文件，所以以 exit code 判断成败。
  - **规整。** 抽出的 JPEG 当作普通图走 `loadImages`（限制、转正方向、合计 token 预算：Jev 24k，pplx 32k 除以题数），帧一起缩，不拼联系表。`loadImage` 的 `share` 现在是「限制允许的尺寸」的份额（#60 之前对超限的图是原图的份额，超限图的合计会超预算；录屏帧常常超限）。
  - **请求。** `framesRequest`（`decision/visual-check-frames.ts`，评测共用）：state 是 `frames: [{ seconds, frame: imageRef('frame-N') }, ...]`（加 `specification`），每条检查项一道 Noul（题号 `check.<i>`），问法是「`frames` 是按时间排列的 N 帧，从一帧到下一帧画面怎么变，<部分>是否满足这个要求：<属性>」；按规范的判法读回答（`readWholeImage`，带 `RECORDING_BARS`：≥ 0.8 过、≤ 0.4 不过；静态截图的不过线是 0.2，录屏放宽到 0.4 是因为带终点标记的动画题里不成立的格子在 0.15–0.36，成立的最低 0.49），结论的依据在回答里写 `(frames)`。工具说明（`recordings(n)`）写明录屏只问粗的运动问题（回弹、终点大偏、出现或消失），检查项写成「应该是怎样」，没有 ffmpeg 就是没把握。
  - **失败。** 没有 ffmpeg 或不在 CLI（`io.run` 拒绝）、ffmpeg 读不了文件（最后一行 stderr 当原因）、时间段起点在片尾之后、某一帧取不出，检查项都记没把握并写明原因，不发请求；回答里加一句「用 `look: true` 自己看」。没有单张截图可附。
  - **`look`。** 录屏回 8 帧（`LOOK_FRAME_COUNT`，时间段同上），前面一行文字写每帧取自哪一秒；读不了就是一行原因。
- **汇报**（#58，流程的第 ⑤ 步，`deps.report` → `core/visual-check-report.ts` 的 `reportCall`）。每次走到 `check` 的调用经 `report` 记两样：① 一条 aside 的决定（`feature: 'visual-check'`，`agent` 是调用者，`subject` 是截图路径，`outcome` 是「核对 N：x 过 · y 不过 · z 没把握」，`reason` 逐条写检查项、结论、概率、整图还是放大复核、是否做了放大复核、用时；`visualCheck` 字段是同样内容的数据：`VisualCheckRecord`，在 `decision/visual-check-record.ts`），不碰调用者节点的 route；② 一个 `Tallied`（`feature: 'visual-check'`，**增量**，不是累计：`withTally` 把它加到节点的 `visualChecks`）。节点按轮（主 agent）或按运行（派出 agent）各有一份，所以「下一轮重新计」不需要清零；派出 agent 的行只有在它已经有节点（它的第一步之后）时才有计数。录屏（#60）和截图走同一条汇报：决定的 `subject` 是录屏文件的路径，帧的请求失败也进 `trouble`（`failure`，note 是 `failed`），录屏读不了（没有 ffmpeg、抽帧失败）同读不了图（`skipped: 'error'`）。`look: true`（含看录屏的帧）、参数不全、开关关着的调用不经 `check`，不汇报也不计数。
  - **失败只写 board notes，不弹 toast。** 决策请求失败（第一个请求，`Asked.ok === false`）：aside 的 `failure`，note 的 kind 是 `failed`；读不了图（`subjectsOf` 失败）和工具里意外抛出的错误：`skipped: 'error'`，note 的 kind 是 `skipped`，原因写进 debug log（`visual_check could not use its images: …`）。受影响的检查项照旧记没把握，进计数的「没把握」。决定本身照常记一条，`tone` 是 `fail`（有失败）、`warn`（有检查项不过）或 `ok`。
  - **给后面的票留的位置。** `CheckTally.takeovers`（可选）：截图接管（#62）用 `{ feature: 'visual-check', agent, passed: 0, failed: 0, unsure: 0, takeovers: 1 }` 加「接管 n」，和核对计数在同一个字段、同一行（`tallyText` 写成 `核对 N：… · 接管 n`）。是否放大复核：每条检查项的 `zoomed` 取自 `CheckResult.basis === 'zoom'`，整次调用的 `zoomed` 是它们的或；放大复核（#59）填 `basis: 'zoom'` 就进了日志。放大复核的请求（请求二，或 `comparePair` 的框题请求）失败时，`ZoomOutcome.failure` 是第一个失败的 `Failure`，`check` 把它也交给 `trouble`（和请求一的失败同样处理：note 的 kind 是 `failed`，不弹 toast）；请求一失败就没有放大复核，不会两个都有。
  - **看板上。** `BoardPart` 加了 `checks`（`visual-check` 开关的 `parts`），关着开关，行上不画计数。计数在 band 的每个 agent 行里状态格的后面（`AgentRow.checks`；`columnsOf` 给它留宽度，名字至少留 10 格，列宽不够就截断）和依据卡片的「看图核对」一行；日志条目在依据面板里照常列出，带一个动词「已核对 / 核对失败」。依据面板顶部的开关列表本来就读 `listSwitches()`，`visual-check` 登记了就在里面。画面上的功能叫法在 `board/view.ts` 的 `FEATURE_WORDS`：看图核对、截图接管、带图路由（后两个的开关在 #62、#63 登记）。
- **测试。** 接缝 1：`tests/visual-check*.test.ts`（登记、判定、比较、尺寸、失败、`look`、调用、连续不过、pplx、预算、方向、日志、录屏 `visual-check-recording*.test.ts`、看板计数 `visual-check-band|board|pane.test.ts`）。world 新零件见 `tests/support/images.ts` 和下文「测试怎么写」。接缝 2：`tests/image-header.test.ts`（真实的 PNG、JPEG 字节）。

**截图接管（#62，ADR 0008）。** 开关 `screenshot-takeover`（默认关，不拥有看板部分；`/dp screenshot-takeover on`）。打开后 agent 在本循环里自己生成的图不进它的上下文，换成一段英文说明，由 `visual_check` 去看。`features/screenshot-takeover.ts` 是接线，判断在 `decision/screenshot-takeover.ts`（纯），汇报在 `core/takeover-report.ts`。
- **生效条件。** 开关开着（总开关也开着），并且 agent 有地方可去：`visual-check` 开着、`ctx.images` 不是 null（没有 visual_check 可调，图换掉了 agent 就看不到了）。只处理模型自己的调用（`next.origin.plugin === 'engine'`），别的插件用 `$.tool.call` 调 Read 不动。出任何错，图原样给 agent，原因写 debug log。
- **循环从什么时候算起**（`core/loop-start.ts`，#64 共用）。主 agent 每个 `turn.start` 记一次；派出 agent（含 Workflow 的、续跑的）在 `agent.spawn` 记（取 spawn 到达时的时刻，spawn 返回才知道 agentId；续跑 `resume` 是新的一轮循环，记新的时刻）；没见到 spawn 的 agent 用它第一个 `turn.start` 补上。都在 `$.state` 的 `loops` 族（id 是 `main` 或 agentId，值 `{ startedAt }`），热重载不丢。找不到记录就不接管（不知道哪些文件更早）。`isFromLoop(mtimeMs, startedAt)` 是 `mtimeMs >= startedAt`：和循环同一毫秒存下的算本循环的。state 的引用要在读它的文件里写成字面量（validate 的规定），所以读的人各写一行 `const LOOPS = { plugin: 'dispatch-pilot', key: 'loops' } as const`。
- **Read。** `tool.call` 在 `next` 之后：结果是 `type: 'image'`，`$.fs.stat(file_path).mtimeMs` 不早于循环开始，就换成 `{ ...r（去掉 text 和 ref）, result: { type: 'text', file: { filePath, content: 说明, numLines: 1, startLine: 1, totalLines: 1 } } }`，这是 spec「实测得到的形状」里已实测的写法，不留 `[Image: …]`。尺寸取 `dimensions.originalWidth/Height`（磁盘上的原图，不是引擎缩过的），没有就从 base64 的文件头读。`stat` 失败（文件已不在）：不动。
- **MCP 工具。** 名字以 `mcp__` 开头、不是 `mcp__dispatch-pilot__` 的工具，`isError` 的不动，结果里有 image 块就逐块存成文件、换成说明块。**引擎在 tool.call 里给 MCP 图块的形状没有实测**（用户决定不再测），所以两种写法都认：MCP 的 `{ type: 'image', data, mimeType }` 和 Messages API 的 `{ type: 'image', source: { type: 'base64', media_type, data } }`；结果可以是块数组，也可以是带 `content` 数组的对象（其余字段原样保留）。换完去掉 `text` 和 `ref`，让核心按 `result` 重新生成给模型看的内容（这一步同样没在真实引擎里验证）。存文件：`newWorkFile` 取路径，`$.process.run(['base64', '-D', '-o', 路径], { stdin: base64 })`（macOS 的 base64；`$.fs.write` 只写文本）。存不下来（不在 CLI、没有 base64、退出码不是 0、临时目录建不出）：这一块图原样留给 agent，不记日志、不计数。一个结果里有几张图，各存各的。
- **说明**（`takeoverNote`，给模型看，英文）。三句：这张图在本循环里生成、被接管挡在上下文之外，存在哪里（路径、尺寸、格式）；用 `mcp__dispatch-pilot__visual_check` 检查（`images`、检查项）；要亲自看就加 `look: true`；并说明再用 Read 读它只会得到这段说明（接管会再接一次）。
- **临时目录。** `core/work-files.ts`：`$TMPDIR/dispatch-pilot/<会话 id>/`（`$.session.id()`，非 `[A-Za-z0-9_-]` 的字符换成 `_`），第一次要用时 `mkdir -p`，文件名 `image-<本次加载的随机数>-<序号>.<扩展名>`（热重载后序号从头数，随机数不同，不会盖掉 agent 手里还有路径的旧文件）。不清理（系统会清 TMPDIR）。`/clear` 后进程换了会话 id，新文件进新目录。这同时改了 #57 的做法（原来是 `$TMPDIR/dispatch-pilot-<随机>/`，不分会话），`features/visual-check.ts` 和 `features/image-routing.ts`（#63 自己也有一份同样的写法，已改成调它）的 `newFile` 都走 `newWorkFile`。
- **汇报**（`reportTakeover(io, agent, kept)`）。每张图一条 aside 的决定（`feature: 'screenshot-takeover'`，`subject` 是路径，`outcome` 「接管截图」，`reason` 写尺寸和去向，`tone: 'ok'`；依据面板的动词「已接管」），再一次 `{ tally: { feature: 'visual-check', agent, passed: 0, failed: 0, unsure: 0, takeovers: n } }`，看板那一行写「接管 n」，和核对计数在同一格（没做过核对时只写「接管 n」，`tallyText`）。这一格属于 `visual-check` 开关的 `checks` 部分：`visual-check` 关着时不画，而这时接管本来也不生效。
- **测试。** 接缝 1：`tests/screenshot-takeover.test.ts`（Read：默认关、换成说明、参考图不动、新一轮、派出 agent 的 spawn、续跑、没有 visual_check 时不动）、`screenshot-takeover-mcp.test.ts`（两种图块写法、存成文件、`visual_check` 能读、`look` 取回、存不下来）、`screenshot-takeover-board.test.ts`（日志、「接管 n」、依据面板）、`session-files.test.ts`（临时目录）。接缝 2：`screenshot-takeover-swap.test.ts`。world 的新零件：`w.save(path, file)`（存下一个文件，修改时间是此刻的 mock 时钟）、`w.read(path, { agentId })`、`w.callTool(tool, { input, ends: { returns, text }, agentId })`（结果是结构化的，如 MCP 截图的内容块）、`sessionId` 选项和 `w.setSessionId`、`fs.stat` 桩（`FakeFile.mtimeMs`，缺省 0）；Read 读 `files` 里的图片文件时回引擎的结构化结果（`readImageResult`）。测试要让「更早就有的文件」早于循环：文件给 `mtimeMs`，再 `w.clock.advance(...)` 之后才 `submit`。

**带图路由的第一半：复杂度读数和带图消息的推迟决定（#63，ADR 0008）。** 开关 `image-routing`（默认关：图会发给决策模型）。只管主 agent 在用户发消息时的 effort；轮中贴的图、派出 agent 和 Workflow 是 #64，它们复用这里的读数。
- **读数题和读法**在 `decision/complexity.ts`（纯，#65 评测共用）：一道 0–4 五档的 Score 题，英文问「照着这些参考图做出来有多复杂」，每档是一句情形的描述；图放在 state 的 `reference_images`。读数是各档概率的期望四舍五入（实测立方体 0.14、海面 1.77、城市 3.14，期望比最大概率那一档平滑）。`referenceState(reading)` 是 effort 请求里的 `reference_complexity` 字段：`{ level, scale, description, images }`；`turnStartPart({ reference })` 把它并进 state，effort 题本身不改，不带图时请求逐字不变。
- **一组图得到读数、读数的存取**只在 `core/complexity.ts`：`readReferenceComplexity(io, sources)` 先规整图（每张不超过 100 万像素、一组最多 6 张，超了取前 6 张），按规整后字节的 hash（`referenceKey`，和顺序无关）认是不是读过的一组，读过的直接回（不发请求，并把它排到最近），没读过的发一个请求。读数存在 `$.state` 的 `referenceReadings`（最近 8 组，最近用的排最后；契约在 `types/index.d.ts`）。`latestReading(store)` 取最近一组的读数：#64 里不带图的请求（派出 agent、Workflow 批）用它。`ComplexityIo` 是闭包（`files`、`ask`、`store`、`now`、`backend`），谁要读就用自己的 `$` 造一份；`sources` 是 `{ path }`（文件）或 `{ base64 }`（引擎只给了字节，先用 `base64 -D -o` 写成文件）。不抛错：失败是 `{ ok: false, reason, failure? }`。
- **带图的消息的流程。** ① `prompt.submit`：main-effort 看 `e.attachments` 里有没有 image（`hasImage`），开关开着、有图像后端、不是命令轮、不是报告、不是进行中的轮里发的，就不把 effort 题放进投票箱，而是交给 `core/deferred.ts`（一个从读数到 part 的函数）；此时只发投票箱里其他的题（skill 推荐等）。② `session.append`（door 为 prompt）：`features/image-routing.ts` 记下这条消息的 image 块和 `[Image: source: <路径>]` 文字（路径下是引擎缩小之前的原图），不读整个 `as: "api"` 会话。③ 主 agent 的 `turn.start`（在核心之前）：取走推迟的 part，先读图（最多等 3 秒，`features/image-routing.ts` 里不导出的 `READING_WAIT_MS`，含规整），再用 `askGroup`（`core/ask-group.ts`，和发消息时同一个函数）发 effort 请求，state 带 `reference_complexity`；回答经原来 main-effort 的 `settle` 写成待用的决定，核心在同一次 `turn.start` 里认领，所以第一步就是这个 effort，计划表仍然只有核心写。decision 里 `forTurn` 记 `current`（这一轮已经开始）。
- **失败。** 读数等不到、请求失败、图读不了、没找到图：debug log 一行，照常定（请求失败还往看板的 notes 记一条 `image-routing` 的失败，不弹 toast）。effort 请求也失败：和任何消息一样，这一轮按引擎原样发出，看板写 `routed: false` 和原因，弹 toast。hook 的 10 秒里 `$.clock.sleep` 算数，所以 effort 请求的等待取 `min(timeoutMs, 9000 − 读数用掉的)`（9000 是 `core/call-budget.ts` 的 `CALL_ROOM_MS`，至少留 `MIN_ASK_MS`）。
- **优先级没变。** 锁定 > 点名 > 路由抬到下限 > 引擎，`planStep` 没动；读数只是 state 里的一个字段，不进规则推演。
- **依据卡片。** 日志条目 `LogEntry.reference = { level, images }`（`Decided.reference`，`entryOf` 复制），卡片多一行「参考图」（`board/reference.ts` 的 `referenceWords`：档位 3/4、中文档名和说明、来自几张图、「只作提示」）。
- **偏离或没解决的地方**（票没写死的）。① 图的来源以 `[Image: source: <路径>]` 里的路径为准，没有这块文字时才用 image 块的字节（引擎已缩到长边 2000），这一条没在真实引擎上验证过 `session.append` 里是不是一定带这块文字。② 一轮进行中发的带图消息（`e.turnId` 有值）不推迟：它不开始新的一轮，effort 题照常在发消息时问；它的图读完后再判一次（见下面第二半的「轮中贴的图」）。③ 读数匹配消息靠文字（行里的话和这一轮的话相同）；对不上就不读，照常定 effort，不去猜是哪一条消息的图（`takePasted`；真实引擎里 `session.append` 的话是不是总和 `turn.start` 的话一致没验证过，不一致时带图的消息就没有读数）。④ 读数的档位用期望四舍五入，不是最大概率。
- **测试。** 接缝 2：`tests/reference-complexity.test.ts`（题、读法、state 字段、hash）、`tests/reference-readings.test.ts`（一组图只问一次、缓存、上限、失败）。接缝 1：`tests/image-routing.test.ts`（带图的消息整条流程、默认关、不带图逐字不变、读数超时和失败、锁定、两家后端分工、图的来源）、`tests/image-routing-card.test.ts`（卡片）。world：`w.submit(text, { images })`（`tests/support/pasted.ts`：attachments 加引擎追加的那一行）、`jev(levels, { scores: { 'complexity.level': [...] } })` 按题号给 Score 题各自的概率。

**带图路由的第二半：轮中贴的图、派出 agent 和 Workflow 带读数（#64，ADR 0008；0.9.0 改过，ADR 0013）。** 同一个开关 `image-routing`。
- **什么算参考图。** 你贴进消息的图：开始一轮的消息（第一半），以及一轮进行中你又输入的带图消息。agent 自己生成或读到的图、看图核对和截图接管经手的图都不算。0.8.x 还把主 agent 一轮中途 `Read` 到的、早于本循环的图片文件当参考图，读完触发一次中途重判（`features/reference-midturn.ts`）；中途改的 effort 在 2.1.312 上不生效，0.9.0 随中途重判一起删了。
- **轮中贴的图**（`features/main-effort.ts`；0.9.0 改过，ADR 0014）。一轮进行中你又输入的带图消息只按文字定一次：main-effort 照常把它的 effort part 放进发消息时的投票箱，不读它的图，也不再判一次（`imaged` 只对开始一轮的消息成立）。0.8.x 在它的行 `session.append`（door 为 `prompt` 或 `queue`）到了之后读图、带着读数再判一次（image-routing 的模块变量 `typedIn`、`running`，`effortPart(reading, true)`），赶在送进这条消息的那一步之前就用新的档；到晚了，在 2.1.312 上那一档落在只带工具结果的一步上，不生效，看板上却写着它（ADR 0013）。0.9.0 删了这条路，看板上每个档都是引擎会用的；开始一轮的带图消息照旧在 `turn.start` 读图再定（第一半）。`tests/image-routing.test.ts` 钉住：一个 effort 请求、没有读图的请求、看板只有一条决定，送进它的那一步和之后的工具结果步都按文字定的档。
- **派出 agent 和 Workflow**：`features/reference-hint.ts` 的 `sessionReading(readings, debug)`（`readings` 是 `referenceReadings` 的读闭包，`debug` 是 debug log 的闭包；不收 `$`），开关开着时回 `latestReading`（本会话最近一次的读数）或 undefined，不发请求、不等。三处取它放进 state 的 `reference_complexity`（`Dispatch`、`WorkflowBackground` 的同名可选字段，decision 层用 `referenceState` 渲染，只有文字）：`dispatched-agents.ts` 的 `agent.spawn`（`dispatchState` 在 `recent_context` 之前并进去，所以预算先扣）、`workflow-agents.ts`（`planBatches` 的 `background`，进每个请求共用的那一份 `shared`，所以每批的预算都扣了）、`workflow-labels.ts`（启动时按脚本路径发的批，和每个 agent 启动时当场判断的请求；后者取的是 agent 启动那一刻的最近读数，不是 Workflow 启动时的，所以不进 `labelRuns[].launch`，契约没动）。开关关着、还没读过图，请求逐字不变。
- **偏离或没解决的地方**（票没写死的）。① 轮中贴图的行在真实引擎里的 door 没验证过（世界里是 `prompt`）。② 一轮进行中贴的图不读（0.9.0，见上），它的读数也就不给派出 agent。③ 并行读几组图时，哪一组「最近」（派出 agent 读的那一组）取决于谁后到。
- **测试。** 接缝 1：`tests/image-routing.test.ts` 的轮中贴图几条（再判一次赶在送进的那一步之前、不带图、被拒绝、开关关着、主 agent 一轮中途 `Read` 图不判断）、`tests/reference-agents.test.ts`（`agent.spawn`、Workflow 批、按脚本路径启动的批和当场判断的 state 里有读数，无图，不超预算；开关关着、没读过时逐字不变）。world 用 #62 加的零件：`FakeFile.mtimeMs`（缺省 0）和 `fs.stat` 桩，Read 一个 `files` 里的图片，结果就是引擎的结构化图片结果（并行的一步里也是）；测「更早就有的文件」要先 `w.clock.advance` 再 `submit`（循环从那一刻开始），本循环生成的文件给更大的 `mtimeMs`。

**放大复核（#59，ADR 0008）。** 只在 Jev 且对着参考图或另一张截图（`reference`、`compare_to`）时做；pplx 没有框题，不发框题也不做放大复核，判定停在整图。
- **分工。** `decision/zoom.ts`（几何：`cropRect`、`scaleRect`、`unionBox`、`sipsCropArgs`、`sipsEnlargeArgs`、`sameView`，导出的常量 `ENLARGE_TO`、`ELSEWHERE_*`；`MARGIN`、`MIN_CROP`、`MAX_ASPECT` 是文件内的常量，不导出）和 `decision/visual-check-zoom.ts`（题：`locatePlan`、`withBoxes`、`readLocated`、`zoomRequest`、`batchPairs`、`readZoom`、`judgeZoom`、`fallBack`）是纯模块，评测（#65）共用；`core/image-crops.ts`（`cropImage`：两次 sips，再读成 base64）和 `core/zoom-review.ts`（`zoomReview`、`comparePair`）经闭包做文件和请求；`features/visual-check.ts` 只接线并把裁图放进回答。
- **请求一里的框题。** 在整图的 Noul 之外：每个点名了部分的检查项，在截图（`box.<i>.candidate`）和每张比较对象（`box.<i>.reference` / `.reference-<k>` / `.other`）上各一道 Box（`The primary button in \`candidate\`.`）；比较对象只有一张、且视角相同时再加一道全屏的 `where.screen`（`The region of \`candidate\` that differs from \`reference\`.`）。没点名部分的检查项没有框题；一个请求最多 64 题，放不下的（排在后面的）检查项不框，退回整图并写明原因。
- **裁图。** 视角相同（`same_view` 或宽高比相差 ≤2%）：取两个框的并集，按截图的像素算裁剪区域，另一张图按比例取同一块（`scaleRect`）；视角不同：各裁各的。框外加 15%（每边，按框自己的宽高），每边至少 160 px，长宽比不超过 3.5:1（短边加长，图本身放不下就缩小），移进图内；再放大到长边 1000 px。sips 参数：`sips -c <h> <w> --cropOffset <y> <x> <源> --out <临时文件>`，然后 `sips -Z 1000 <临时文件> --out <临时文件>`。**两次调用不能合并**：实测（macOS 26）同一次调用里 `-Z` 先于 `-c` 生效。裁图从 `LoadedImage.file`（已转正、已缩到限制内的那个文件）裁，格式不变，放大后的尺寸按公式算（`enlargedSize`），不再查一次 sips。
- **请求二。** 每对裁图一道 Noul（`zoom.<检查项>.<第几张比较对象>`），两张裁图在这道题的 instructions 里（`{ question, candidate_crop, reference_crop }`，`imageRef` 引用），state 只有一句说明。裁图合计按每百万像素 2,600 token 估，超过约 48k 就拆成几个请求同时发（`batchPairs`）。
- **判定。** 只看裁图上的「一致」概率：≥0.8 过（`PASS_AT`），≤0.2 不过（`FAIL_AT`），其间没把握；档位序列里的裁图用 `SERIES_BARS`（0.9 / 0.2），见「档位序列」；对着几张参考图（不同侧面的照片）时取最高的一个。某条检查项的放大复核做不了（没点名部分、模型没框出、sips 失败、请求二失败或没答）：退回整图的答案，只采信不过，其余记没把握，原因里写放大复核为什么失败（`fallBack`）。点名框的置信度不参与判断；本来就没有选择题。
- **另一处可能不同。** `where.screen` 的框置信度 ≥0.2 且面积 ≤25% 才报（两端都含），并附两张图同一块的裁图；这块若有一半以上落在已经不过的检查项的框里，不重复报（那条检查项自己带裁图）。裁图做不了仍报，不附图。
- **回答里的裁图。** 不过的检查项附截图的裁图和比较对象的裁图（多张参考图时取概率最低的那一对），最多三条检查项；裁图占截图面积超过 90% 的不附（和整张图没区别）；之后是「另一处」的两张，最后才是没把握时的整张截图。文字里按顺序列出每张图是什么（`cropLabel`）。
- **`comparePair(deps, { candidate, other, sameView }, checks)`**（`core/zoom-review.ts`）。给任意一对已读好的图（`LoadedImage`）和点名的部分，不经请求一的整图判断：发一个只有框题的请求，裁图，发请求二，回 `ZoomOutcome`（每条检查项的结果、不过的裁图、另一处）。做不了的检查项记没把握并写明原因，从不抛错。#61 的档位序列对相邻两档调用它（`core/quality-series.ts`）。
- **测试。** 接缝 1：`tests/visual-check-zoom-request.test.ts`（请求一的框题）、`-crops.test.ts`（sips 参数、两种视角、边距、最小尺寸、长宽比、请求二的题和图）、`-verdicts.test.ts`（判定、退回、原因）、`-report.test.ts`（回答里的裁图、另一处的两个条件）、`-limits.test.ts`（题数和 token 的上限、`comparePair`）、`-board.test.ts`（日志里的「是否放大复核」、放大复核请求失败的 note）。world 的零件 `tests/support/zoom.ts`：`zoomBackend({ whole, boxes, zoom, zoomReply })` 按题号分开回答请求一和请求二（`where.screen` 默认是置信度 0.05 的框，不报）。

**档位序列（#61，ADR 0008）。** `visual_check` 收到 `sequence: true`：`images` 是同一机位下按档位从低到高排的 2 到 12 张静态图（`MAX_LEVELS`），`checks` 点名档位可能改变的部分。只在 Jev 上做：它是一连串放大复核，要框题；图像后端是 pplx 时，调用不发请求，回一句说明「档位序列需要放大复核，需要 TypeSafe 的 key，当前不可用」（`features/visual-check.ts` 的 `SERIES_NEEDS_JEV`），pplx 版工具说明里也写了同一件事（`SERIES_UNAVAILABLE`），Jev 版有一段 `SERIES_DESCRIPTION`。
- **分工。** `decision/visual-check-sequence.ts`（纯，评测 #65 共用）：`pairConclusion`（一对的结论：每条检查项都「过」才是 `same`，有一条「不过」就是 `differs`，其余 `unsure`）、`seriesVerdict`（从哪一档起往上看不出差别）、`pairWaves`（分批）、`MAX_LEVELS`、两版工具说明的文字；`decision/visual-check-sequence-text.ts`（英文，回答的文字 `seriesText`）；`core/quality-series.ts` 的 `compareLevels(deps, levels, sameView, checks)` 对相邻两档调 `comparePair`（高档当 candidate，低档当 other），经闭包做文件和请求；`features/visual-check-series.ts` 的 `checkSeries` 读图、汇报、回答，`features/visual-check.ts` 只多了分派一行。
- **判定。** 「没差别」是整个设计里较弱的那个方向，所以要每对每个点名的区域都在裁图上「过」（≥ 0.9，`SERIES_PASS_AT`；2026-10-15 静态截图的过线降到 0.8，档位序列按用户的决定仍是 0.9，`SERIES_BARS`）才算；任一区域不过，这一对就是 `differs`，没把握（0.2 到 0.9 之间、请求失败、没点名部分）是 `unsure`，同样不算没差别。`seriesVerdict` 取最上面连续的 `same` 对的起点：第 k 对到最后一对都是 `same`，就是「从第 k 档起」；最上面一对 `differs` 就是「没有这样的档」（所有对都 `differs` 时写成「每一档都有差别」）；最上面一对 `unsure` 是「说不准」。下面某一对看着没差别、上面又有差别的，不算。全屏「哪里不同」的框（没点名的另一处）只在那一对下面报一句文字，不改结论，也不附裁图（一串档位的裁图会把上下文撑大；要看用 `look: true`）。
- **分批。** 每一对是自己的请求（一个框题请求，一个裁图请求，裁图请求由 `batchPairs` 再按 48k token 拆），不是把所有档位塞进一个请求：一个请求只放两张图。图读到 `JEV_IMAGE_LIMITS` 以内就够（两张最大的约 12,800 token，在一个请求的 24,000 以内），不再按预算缩。对数多时 `pairWaves` 把各对分成几批：一批内的各对同时发，一批发完再发下一批，一批的图像合计不超过 `WAVE_TOKENS`（72,000，约三个满请求）、至多 `WAVE_PAIRS`（6）对（两个都是 `visual-check-sequence.ts` 里的文件内常量，不导出）；一对不拆。每个请求仍是 `REQUEST_MS`（8 秒）的上限，而且整个调用共用 9 秒的预算（见上面「请求的等待」）：档位多、请求慢时，靠后的几批可能没有时间可用，那几对的检查项记没把握，理由写明没时间了。
- **录屏。** 档位序列只比静态图。动态效果（闪烁、波纹抖动）静态图上看不出来：工具说明和回答里都写明，要从每一档的录屏里同一时刻各取一帧（例如 ffmpeg），把这些帧当作序列；给了录屏路径就回一句说明。
- **汇报。** 一次调用一条决策日志（`seriesRecordOf`，`decision/visual-check-record.ts`）：`image` 是第一档，`against` 是 `{ kind: 'sequence', paths: 全部档位 }`，每对每条检查项一条 `CheckRecord`，带可选的 `pair: [低档, 高档]`（从 1 数；读不了图时没有）；日志的字句多一个前缀「档 1→2 · 」。计数的 N 是做过的检查数（每对每条检查项各算一次）。请求失败只写 board notes，不弹 toast。回答最后要求 agent 在最终汇报里列出试了哪些档、比了哪些区域、结论和概率。
- **不做实测。** 按用户的决定（#55 的 Out of Scope），档位序列的阈值和判定没有实测过，只有放大复核本身的实验（圆角、颜色、缺图标靠得住，边距和 4 px 偏移、字重抓不到）；所以回答里照旧写「过只代表没看出明显问题」。
- **代码审查后留下的取舍（#55，2026-10-15；审查列了，没改，依据在这里）。**
  - 全屏「哪里不同」（`where.screen`）只在比较对象只有一张、视角相同时才问（`locatePlan`）：视角不同，或有几张参考图（不同侧面的照片）时，两张图本来处处不同，全屏比较问不出东西。
  - 几张参考图时放大复核取最高的「一致」概率（`judgeZoom`）：不同侧面的照片里，点名的部分不一定每张都看得到，只要有一张对得上就算对得上。
  - 工具里的内部上限 `MAX_CHECKS`=24（`visual-check-tool.ts`，导出）、`MAX_LOOK`=8（同一个文件，文件内）、`MAX_LEVELS`=12（`visual-check-sequence.ts`）、`MAX_CROPPED_CHECKS`=3（`visual-check-zoom.ts`）：不是 spec 写死的数，spec 允许内部常量，它们是为了不超出一个请求能装的题数、图数和回答里的裁图数。
  - 截图接管要 `visual-check` 开着、而且有图像后端才生效（`features/screenshot-takeover.ts` 的 `acts`）：图被换掉之后，agent 只能靠看图核对取回它；README 的「截图接管」一条写明了这一点。
  - 「另一处可能不同」落在已经不过的检查项的框里时不重复报（`withinFailed`，上面「另一处可能不同」一条）。
  - `registerLoopStart`（`core/loop-start.ts`）不看任何开关，每个循环都记：它只花一次 `$.state.set`，而读它的两处（截图接管的「本循环里生成的」，#64 的「循环开始前就有的参考图」）开关各不相同，开关打开的那一刻起就要有记录；连续两次不过的计数不用它（见「回答」一条）。
  - 截图接管把 MCP 截图存成临时文件用 `base64 -D -o`，这只在 macOS 上可用：`sips` 本来就只有 macOS 有，整个看图功能是 macOS 的。
  - 「核对 N：x 过 · y 不过 · z 没把握」的 N 是检查项数，不是调用次数：和 spec 例子「核对 12 次：9 过 · 2 不过 · 1 没把握」的算术一致（9 + 2 + 1 = 12）。
- **测试。** 接缝 2：`tests/visual-check-sequence-verdict.test.ts`（`pairConclusion`、`seriesVerdict`、`pairWaves`）。接缝 1：`tests/visual-check-sequence.test.ts`（相邻两档的请求、回答的文字、任一区域没过、说不准、分批的时间、超时只影响那一对）、`-calls.test.ts`（档数的上下限、录屏、读不了的档、pplx、工具说明）、`-board.test.ts`（日志、计数、失败的 note）。world 的零件 `tests/support/series.ts`：档位文件 `levels(n, size)`（标签就是路径）和 `seriesBackend({ zoom, boxes, reply })`，按请求里图的标签认出是哪一对，每对各回各的答案。

**「`Config` 晚一点才知道用哪一行」怎么解决：方案 3，两行都先算好，`ctx` 每次读时选。** 难点是环境变量只能在 `session.start` 里异步读，而 0.8.x 的 `Config` 默认值行取决于最后用哪个模型（按密钥选），不少功能又在 register 时把 `ctx.config.*` 取走了。`setup()` 对 pplx 和 Jev 各算一份 `Config`（`readConfig(options, table, backend)`，纯、便宜）和各建一个后端，`Ctx` 的 `config`、`backend`、`ask` 是 getter，每次读时取其中一份。0.9.0 起选哪一份只看 `decisionModel`（`backendNameOf`，ADR 0014），register 时就定了；getter 留着：后端的密钥（环境变量里的要到 `session.start` 才读到）和图像后端（`ctx.images`，仍按密钥选）都是读的时候才算。没选「`ctx` 里放个会被替换的 `current`，在 `session.start` 和 `prompt.submit` 里 `await resolve($)`」（方案 2）：getter 不要求每个入口都记得先 resolve，热重载（`register` 重新执行、`session.start` 再触发）也自然对。代价是 register 时取走 `ctx.config.*` 的功能必须改成用时再读：`escalation` 的 `Settings` 现在是 getter 对象（当时还有 `midturn-effort` 的）；`dispatchSettings(ctx)`（派出 agent、两个 Workflow 功能）和 `rankingSettings(ctx)`（skill 推荐、find_skill）返回 getter 对象；`skills`、`find-skill` 的门槛（`guide.skills`）和 `findWaitMs` 在用的地方读。不随决策模型变的值（`neverSuggested`、`alwaysListed`、`findMax`、`workflowMode`）仍在 register 时取；`skills` 开关的默认值（开）也不随决策模型而变，所以不放进表里。新写的功能不要在 register 时取 `ctx.config.<随决策模型而定的值>`；`tests/decision-model.test.ts` 里有「环境变量里有 key」的例子（pplx 等 8000 毫秒、按 `pplxQps` 排队）。

**看图改用 pplx 要写下来。** `control.ts` 的 `session.start` 在读完环境变量之后，若 `ctx.images?.fellBack`（没有 TypeSafe 的 key、有 Perplexity 的 key），`report(io, { fellBack: { asked: 'jev', using: 'pplx', for: 'images' } })`（`core/report.ts`，ADR 0004：只有 report 写给人看的东西；给人看的名字和各模型的密钥设置名都在 report.ts 的 `DECISION_MODELS` 一张表里）：决策日志里一条 `feature: 'decision-model'`、`tone: 'info'` 的会话级条目（没有 `agent`，同一轮号的热重载换掉前一条），原因写缺哪个 key、怎么补。看板的节点、band 和 toast 都不动。0.8.x 还有决策模型本身退回 Jev 的那一条（`fallbackFor: 'text'`），0.9.0 随自动退回一起删了（ADR 0014）；旧条目的 `fallbackFor` 仍可能是 `text`，类型里留着。

**默认是 Jev 对测试的影响（0.9.0，ADR 0014）。** 测试世界大多仍显式设了 `decisionModel: 'jev'`（`KEY` 常量）；断言默认、「不按密钥换」和缺 key 时看板写什么的在 `tests/decision-model.test.ts`、`typesafe-key.test.ts`、`pplx-model.test.ts`、`image-backend.test.ts`。评测的 `optionsFor(backend, ...)` 始终显式写 `decisionModel`；`eval/lib/rescore.ts` 读没记下决策模型的旧结果文件时按 Jev；`scripts/decide*.ts` 经 `scriptDecision` 用 Jev。评测不看密钥：`readConfig(options)` 按「要的是哪个」读。

### pplx 的 agent 预算（2026-10-13，ADR 0007）

用户要求按决策模型能接受的最大 token 数，给派出 agent 和 Workflow 里 agent 的请求分配上下文：agent 的 prompt、脚本、这一轮的对话（「尽量让决策模型拿到更多的上下文内容，这样它才能做更准确的判断」），和 0.2.1 按 Jev 的上限定默认值是同一个道理。

**事实（Perplexity 官方文档，2026-10-13 读的全文）。**

- 一个请求的输入：「Under 262,144, counting `state`, images, and every question」（docs/decisions/quickstart 的 Request limits；api-reference/decisions-post 写「Input must stay under 262,144 tokens and the body under 32 MiB」）。超出按 400 处理（400 那一行包括「a limit in Request limits is exceeded」，没写具体的报错），文档没有说会截断。每个请求 1 到 128 道题，body 最大 32 MiB。
- 只按输入计费，每百万 token 0.02 美元，输出免费。
- 时间随输入变长：「a request with a few hundred input tokens answered in under 2 seconds, about 90,000 tokens took 5 seconds, about 190,000 tokens took 14 seconds, and just under the input limit took 23 seconds」（quickstart 的 Timeouts，9 月 30 日的测试）。
- 速率：「Every organization can send 10 requests per second to the Decisions API, on every plan. A token limit also applies to large bursts.」突发的 token 限额是多少没写。
- 文档没有推荐 state 多大，也没说一个请求放多少道题会影响准确率；每道题读同一个 state。

**实测（本机，pplx-decider-v1.1-27b，真实 key）。** 请求是派出 agent 的形状（`dispatchPart` 的题，state 是 `{ brief, user_message, recent_context }`），内容取仓库自己的文字：DEVELOPMENT.md（中文为主，夹着代码标识）或 `hooks/` 下的 TypeScript。探针脚本放在会话的 scratchpad，没有进仓库。

单发，每格 3 次：

| 内容 | mod 估算的 state | pplx 计的 input token | 倍数 | 用时 |
|---|---|---|---|---|
| 文字 | 24000 | 4.3–4.5 万 | 1.8–1.9 | 2.3–3.8 秒 |
| 文字 | 48000 | 8.7–9.8 万 | 1.8–2.0 | 4.3–5.2 秒 |
| 文字 | 72000 | 14.4–15.5 万 | 2.0–2.1 | 8.3–8.8 秒 |
| 文字 | 96000 | 20.7–21.6 万 | 2.1–2.2 | 13.6–14.8 秒 |
| 代码 | 16000 | 3.7–3.8 万 | 2.3 | 1.9–3.3 秒 |
| 代码 | 32000 | 7.2–7.3 万 | 2.2 | 3.6–3.7 秒 |
| 代码 | 48000 | 10.7 万 | 2.2 | 5.5–5.9 秒 |
| 代码 | 64000 | 14.4 万 | 2.2 | 7.9–8.1 秒 |

几个一起发，从第一个发出算起，到各自答完：

| 请求 | 发法 | 各自答完 |
|---|---|---|
| 3 个 24000 | 每秒一个 | 3.7、5.4、6.3 秒 |
| 3 个 48000 | 每秒一个 | 5.6、7.9、12.4 秒 |
| 5 个 24000 | 每秒一个 | 3.6、5.3、6.2、8.5、10.7 秒 |
| 5 个 16000 | 每秒一个 | 2.7、4.3、4.5、5.8、7.0 秒 |
| 3 个 24000 | 同时 | 3.6–4.3 秒 |
| 5 个 24000 | 同时 | 4.0–4.8 秒 |
| 8 个 24000 | 同时 | 3.6–5.0 秒 |
| 5 个 32000 | 同时 | 4.0–5.2 秒 |
| 3 个 48000 | 同时 | 5.6、7.0、7.6 秒 |

没有一次 429 或失败。一共约 510 万 input token，约 0.10 美元。

**结论。**

- 窗口不是限制，时间才是。mod 的估算比 pplx 的计数少一半多（文字 1.8–2.2 倍，代码 2.2–2.3 倍，#43 测过的日志 2.9–3.3 倍）；一次决策最多等 8000 毫秒（hook 自己的上限是 10 秒），而 72000 估算 token（约 15 万 pplx token）单发就要 8.3–8.8 秒。262,144 的窗口在等待时间里用不到一半。
- 单个请求取 48000：单发 4.3–5.9 秒，给排队和慢的时段留出 2 秒多。发消息时的 effort 题、Workflow 的一个请求（当时还有中途重判）都是 48000，和以前一样。
- 派出 agent 取 32000：主 agent 常常一次派出几个，每个请求都带对话，会话一长就满。同时发 5 个 32000 都在 5.2 秒内，3 个 48000 最慢 7.6 秒，贴着 8 秒。Workflow 要分几个请求同时发时、agent 启动时当场判断时（fan-out 的 agent 一起启动），每个请求同样取 32000。
- `pplxQps` 默认从 1 改成 5：按每秒一个排队，后面的请求先等上几秒，自己处理时也更慢（第 5 个 24000 的请求自己用了 6.7 秒），同时发反而都在 5 秒内。
- 背景只给 pplx：Jev 只等 1500 毫秒，一个 key 的请求一个一个答，24000 估算 token 的请求约 0.6 秒，几个 agent 一起派出时第三个就超时。（2026-10-15 改了：Jev 也带背景，一起派出的 agent 合进一个请求，关于 agent 的请求最多 4 个同时在途，见「Jev 的长上下文」「Jev 的限速」，ADR 0009。）
- 代价：选 pplx 时，长会话里每个派出的 agent 要等 4 到 5 秒才启动（以前只带任务，不到 1 秒）。准确率没有量，见「待评测」。

**真实会话（2026-10-13，Claude Code 2.1.296，`claude -p`，主 agent 用 haiku，`--settings` 关掉已装的版本，`--plugin-dir` 加载工作区）。** 派出 agent 和 Workflow 的请求行末尾现在写 state 的大小和各字段的大小（`describeState`：只有字段名和估算 token，不写内容）。派出的 Explore agent 是 `state 593 tokens (brief 45, user_message 255, recent_context 283)`，659 毫秒答完。内联 Workflow 的请求是 `brief_0 35, user_message 255, workflow_script 120, recent_context 286`。两个 prompt 是数据的 agent 在启动时各问一次，`workflow_script 128`，读的是 workflow-agents 改写后真正运行的那份；`recent_context 286`，截到 Workflow 调用为止；各约 480 毫秒。`$.session.messages()` 在 `agent.spawn`、Workflow 的 `tool.call` 和 agent 的第 0 步里都读得到。

**整个请求在窗口之内（`tests/backend-defaults.test.ts`）。** 按最坏的 3.3 倍算：48000 × 3.3 = 15.8 万，加上 8 个调用的题（约 4.8 万，同样按 3.3 倍算）是 20.7 万，在 262,144 的 90% 以内；其余种类更小。

### Jev 的上下文默认值怎么算

0.2.1 把 Jev 的 `contextTokens`、`contextMessages`、`rejudgeSteps`（0.9.0 随中途重判删了）的默认值，从评测时用的 2000、4、4，调大到 Jev 能接受的上限。这是用户的决定（2026-10-05）：「能给到 Jev 越多的信息，它的判断就会越准」，「默认值主要以 Jev 最大的上下文窗口和 input 来配置」。这几个数都只写在 `core/setup.ts` 的 `BACKEND_DEFAULTS` 里，值写在 README 的配置表里；`tests/backend-defaults.test.ts` 的「Jev's context budget by default…」把下面的算式写成了测试。

**事实。**

- Jev 有两条限制（TypeSafe 官方 models.md，见 `docs/research/typesafe-question-guide.md` 的「上下文与速率」和 `docs/research/decision-models-and-caching.md`）：一个请求最多 64k token；state 加上最长的那一道题不超过 32k（第三方实测 32,204 token 通过，约 33,600 被拒，HTTP 400 `max_tokens_exceeded`）。
- mod 的估算（`decision/context.ts` 的 `estimateTokens`）比 Jev 报的少。0.2.1 当时按少约 10% 算，state 的真实 token 数 ≈ 估算 ÷ 0.9，约 1.11 倍；下面 0.2.1、0.2.2 的推算和 `tests/backend-defaults.test.ts` 的 `STATE_REAL_PER_ESTIMATED` 至今用这个系数。后来在中文对话上量到 1.17–1.2 倍（eval v2、ctx30），英文和 skill 画像约 1.37 倍（见「Jev 的长上下文」）。不带长上下文请求头的两条上限，`decision/jev.ts` 的 `JEV_REGULAR_STATE` 和 `JEV_REGULAR_REQUEST`，按 1.2 倍算：24000 = 0.9 × 32,000 ÷ 1.2，48000 = 0.9 × 64,000 ÷ 1.2，正好除尽（数值没变，只是系数的说法换成了量到的）。`decision/jev-rate.ts` 估要花多少额度时取 1.3 做计划，比常见的 1.2 高，比英文的 1.37 低。按 1.2 算，下面表里 24000 的 state 加最长的题约 29.5k，仍在 32k 之内，只是超出了 90% 的余量。
- 最长的题是发消息时 skill 推荐的第一段（`skills.which`；下面是 0.9.0 之前带画像时的推算，ADR 0018 起只带描述，题更短，6000 没有改）：111 个 skill 都带画像时，mod 估算约 16k，Jev 报 2.19 万（#16 实测，约 1.37 倍；2.19 万是整个请求的计数，含评测里很短的 state 和 effort 题，下面当作题的长度算，偏大约 1k，算作余量）。`decision/skills.ts` 的 `questionBudget` 按 32k ÷ 1.35 留了余量，问题长过预算就先去掉「何时不用」，再从后往前改回描述。只能由你触发的 skill 另有一题（`skills.hint`），不会比它长。`find_skill` 的第一段是同一道题。
- 其余的题都很短。用 `decision/` 里的构造函数量过（mod 的估算，题序列化成 JSON 的样子）：0.9.0 发消息时的 effort part（英文，ADR 0014）effort 题 368、八道是非题 120–196，合计 1,526（Jev 计约 504 和 2,089）；加了 `confirm`（160）、`escalate`（147）之后十道合计 1,831（ADR 0016，Jev 计约 2,500）；d1-ultra 上一个派出 agent 的题（路由题 192，带 fable、点名和排除时 11 道）合计 1,854；派出 agent 最长的一道（模型题，带 fable、点名和排除）约 587，一个 agent 的题合计约 1,962（Jev 计约 803 和 2,685）。0.2.2 时量的是：effort 题 343（英文）、421（中文）；派出 agent 的 model 题 363–457，effort 题 334，点名了 3 个模型又要了 effort 的那种最长的一个请求，9 道题合计 1,836。

**算式。** 记 `contextTokens` 为 C（mod 的估算 token）。每条限制只用到 90%，剩下的留给估算看不到的东西（符号多的内容估算偏少，skill 增加时题会变长）：

- state 加最长的题：1.11 × C + Q ≤ 0.9 × 32,000 = 28,800
- 整个请求：1.11 × C + 所有题合计 ≤ 0.9 × 64,000 = 57,600

Q 取 Jev 的计数：skill 第一段 21,900，其余的题按「估算 × 1.37」折算（同一个比例）。每种请求的 C 上限：

| 请求 | 最长的题 | 所有题合计 | C 的上限（32k 一条） | C 的上限（64k 一条） |
|---|---|---|---|---|
| 发消息，开着 skill 推荐 | 21,900 | 约 44,400（`which` 和 `hint` 都按最长算） | 6,210 | 11,900 |
| `find_skill` 的第一段 | 21,900 | 21,900 | 6,210 | 32,100 |
| 发消息，关着 skill 推荐 | 580 | 580 | 25,400 | 约 51,000 |
| 派出 agent | 630 | 2,500 | 25,400 | 49,600 |
| 一批 Workflow 调用（0.2.2 时最多 8 个；0.9.0 起最多 4 个，见下面 ADR 0015 的验算） | 630 | 最多 20,100 | 25,400 | 33,700 |

**取值。** 最紧的是带 skill 推荐的发消息请求和 `find_skill`：C ≤ 6,210，取整到 6000。验算：6000 × 1.11 = 6,670，加 21,900 是 28,570，在 32k 的 89%；整个请求最坏 51,000（两道 skill 题都按最长算），在 64k 的 80%。同一个 6000 让 `questionBudget(6000)` 是 17,700，比 16k 的画像宽 10%，画像不会被裁；再大 500，`questionBudget` 就小于 17.6k，画像开始被裁，所以 6000 也是不裁画像的最大整数档。如果 skill 变多、题长过预算，`questionBudget` 会裁题，不会让 state 加题越过 32k：在 C 取上限 16000 时，16000 × 1.11 + 7,700 × 1.37 = 28,300 仍在 32k 之内。state 里有估算偏少的内容（代码、JSON）时，6000 的余量约 3,400 token，真实 token 数到估算的 1.68 倍才会越过。

**按请求的种类分开取（0.2.2）。** 0.2.1 取了最紧的 6000 一个数，因为带 skill 推荐的发消息请求和 `find_skill` 的第一段受那道 2.2 万 token 的题限制，而其余种类的最长一题不到 700 token，按上表在 32k 的 90% 以内能放约 25k。用户要「尽量给 Jev 更多信息」，所以 0.2.2 把 state 的预算按种类分开：

| 种类 | `Config` 里的位置 | Jev |
|---|---|---|
| 发消息，skill 题（投票箱里除 effort 外的题合成的请求）；`find_skill` 的第一段 | `config.context.tokens` | 6000 |
| 发消息，主 agent 的 effort part（单独一个请求，ADR 0005）；没有 skill 题的消息（skill 推荐关着，或这一轮是报告开始的）也是这一种 | `config.contextByKind.messagePlain` | 24000（0.9.0 起，常规上限内，ADR 0014；2026-10-15 到 0.8.x 是 96000 带长上下文请求头，再之前 24000） |
| 派出 agent | `config.contextByKind.agent` | 24000（同上） |
| 一批 Workflow 调用 | `config.contextByKind.workflow` | 24000（同上） |

- **0.9.0 的验算（ADR 0014，`tests/backend-defaults.test.ts` 的「Jev's context budget by default…」）。** 三种都取 `JEV_REGULAR_STATE`（24000）：1.11 × 24000 = 26,667；发消息的 effort part 加最长的一题（Jev 计约 504）是 27,171，整个请求（全部九道约 2,089）是 28,756；派出 agent 加最长的一题（约 803）是 27,470；8 个 agent 合进一个请求（题合计约 21,480）是 48,147。都在 28,800 和 57,600 之内，所以不带长上下文请求头。按这个算式 agent 的 C 最多约 25,197、effort 约 25,466，取整到 24000。
- **派出 agent 改成是非题之后的验算（ADR 0015，同一个测试）。** 一个 agent 的题最多的情形（`agentFable` 开，你的话提到三个模型、带 effort 字眼）是 19 道：十一道关于任务的、effort、三个模型各一道点名和一道排除、点名 effort；最长的一道是 effort 题（Jev 计约 454，模型题删了），全部约 3,916（只有关于任务的题时 11 或 12 道，约 2,280 或 2,469）。state 加最长的一题 26,667 + 454 = 27,121，在 28,800 之内；一个请求放 4 个 agent（`MAX_PER_REQUEST`）是 26,667 + 4 × 3,916 = 42,331，在 57,600 之内。8 个就是 57,995，而且题数 8 × 12 = 96 也超过一个请求的 64 道，所以 `MAX_PER_REQUEST` 从 8 降到 4（12 道 × 4 = 48；题多的 agent 由 `MAX_QUESTIONS` 再分），state 的预算不用降；`MAX_REQUESTS` 从 4 升到 6，一个脚本仍能问满 24 个调用。agent 的 C 最多约 (28,800 − 454) / 1.11 = 25,511，24000 不变。更早的几轮由问题摘要、长期约束和上一轮的情况（`last_turn`）带进 state。
- 这些值是 `core/setup.ts` 的 `BACKEND_DEFAULTS` 里的内部常量（`contextTokens` 是带 skill 题的那一种，`contextByKind` 是其余几种），不是配置项。下面是 0.2.2 的推算，那时其余种类都取 24000（2026-10-15 起发消息的 effort 题、派出 agent 和 Workflow 取 96000，带长上下文请求头，见下面的「Jev 的长上下文」；24000 仍是不带请求头的上限，`decision/jev.ts` 的 `JEV_REGULAR_STATE`）：上表里它们的 C 上限是 25,400–25,600，取整到 24000；验算 1.11 × 24000 = 26,640，加最长的题（派出 agent 约 630）是 27,270，在 28,800 之内；Workflow 一批（最多 8 个调用，题合计约 20,100）是 46,740，在 57,600 之内。所有种类的 C 加上它最长的题，都用同一个算式在 `tests/backend-defaults.test.ts` 的「Jev's context budget by default, kind of request by kind…」里量过：题用真实的构造函数量（`turnStartEffortPart`、`dispatchPart`），每个种类断言 C × 1.11 加最长的题不超过 28,800，整个请求不超过 57,600。
- `contextTokens` 是用户的覆盖值：设了，所有种类都用它，但每个种类各取它和自己的上限里较小的一个（设 4000 是所有种类 4000，设 16000 是带 skill 题的 6000、其余 16000）；没设，每个种类取自己的默认值。manifest 的范围 100–16000 对 Jev 没有放宽；pplx 的上限（`contextTokensMax`）是 48000，设得再大也读成 48000。`readConfig` 里 `byKind` 做这件事，`describeDefaults` 的那一行 debug log 只报 `contextTokens` 本身。
- 谁读哪一个：`core/core.ts` 对投票箱拆出的每个请求，按它有没有 skill 的 part 用 `messageLimits`（`core/setup.ts`）选 `context.tokens` 或 `messagePlain`，eval 的 `submitRequest` 用同一个函数；`features/dispatched-agents.ts` 用 `agent`；`features/workflow-agents.ts`、`features/workflow-labels.ts` 在运行开始时用 `workflow`（分成几个请求时每个用 `agent`，`planBatches`），`features/workflow-labels.ts` 在 agent 启动时当场判断用 `agent`；`features/find-skill.ts` 和 `core/skills.ts` 仍用 `context.tokens`；评测里的 `eval/lib/subagent.ts` 和 `scripts/decide-agent.ts` 也读 `agent`、`workflow`。你的话（`said`，`dispatched-agents.ts` 在 `prompt.submit` 时存下的每一轮的消息）和一轮记录里的消息（`turns[].prompt`，写问题摘要时读它）各有一份截断：`said` 按 `saidTokens(config)`（`agent`、`workflow` 里较大的那个的三分之一：Jev 32000，pplx 16000；它要存进 `$.state`，最多 8 条；0.4.3 之前是 `context.tokens` 的 6000，评测的 `eval/lib/subagent.ts` 跟着改），`turns[].prompt` 也按 `saidTokens`（0.9.0 之前按中途重判的 `rejudge`，24000）；发给决策模型的 state 再按各自种类的预算截。
- 延迟：没有量过，只有外推（每 1k token 约 13 ms）：state 满了的非 skill 请求比 0.2.1 多约 2.4 万 token，约 0.3 秒；这些请求的 effort 题都很短，慢的时段超时的消息会比以前多一些，没有量。超时变多就把 `contextTokens` 调小，或把 `timeoutMs` 调大。

**`contextMessages`。** 默认值 4 条，在 6000 个 token 里装不满：一条助手的回复就常有几百 token。所以 Jev 取 manifest 范围的上限 32 条（2026-10-15 起是 2000，和 pplx 一样：32 条装不满 96000；0.9.0 之前中途重判读的步数 `rejudgeSteps` 同样取上限 16），让 token 预算而不是条数决定发多少：从最新的往前装，放不下的旧消息整条丢掉，不挤压。消息都很短时 32 条也只有一两千 token。这只是个上限，不是目标；发出去的仍然只有文字和工具名，不发文件内容、写入的内容和工具输出，脱敏，这条隐私设计没有改。

**没有量过的。** 按用户的决定没有再跑评测：`contextTokens`、`contextMessages` 这几个值是按上限算的，不是按准确率挑的，更多的上下文是不是真的让 Jev 判得更准、会不会让旧消息干扰当前这条的判断，都没有数据，各个置信度门槛也是在 2000、4、4 的设置上定的。评测集的上下文很短，新默认值对它们几乎没有影响：用离线重建请求核对，`effort-submit` 的 200 个请求里 state 变了 2 个，`skill` 的 218 个和 `subagent` 的 200 个都没有变；所以 README「评测」里的数字仍然是新默认值的预览，但不是新默认值上量的。延迟见下。

**延迟和花费。** 已有的实测：Jev 处理 2.19 万 token 的 skill 第一段，第一次运行 p50 561 ms、p90 615 ms；8.6k 时 317 / 362 ms；0.8k 时 p50 约 280 ms；约每多 1k token 多 13 ms；第二次运行整体慢（各时段都慢，不集中在某一段），218 条里有 24 条（约 11%）第一段就超过 1500 ms。新默认值让 state 最多到 6.7k（真实 token；以前最多 2.2k，评测里的更短），带 skill 推荐的请求最多到约 2.9 万，按每 1k token 多 13 ms 外推，p50 比评测时最多多约 80 ms（外推，没有实测）；慢的时段超过 1500 ms 的消息会比约 11% 更多，多多少没有量。不带 skill 推荐的 effort 请求，state 满了也只有 6.7k，估计 p50 在 0.4 秒上下。超时的消息不经路由，用会话自己的 effort（见「失败时放行」）。超时变多就调小 `contextTokens`（每少 1k 约快 13 ms，但 skill 的那一题仍是 2.2 万，要快得多得 `/dp skills off`）。花费：Jev 只按输入计费，每百万 token 0.042 美元；一个 state 满了的 effort 请求约 6.7k token，不到 0.0003 美元，带 skill 推荐的约 2.9 万 token，约 0.0012 美元。

### Jev 的长上下文（2026-10-15，ADR 0009）

> **0.9.0 起默认值不再用它（ADR 0014）。** TypeSafe 的文档说长上下文比留在常规限制里慢、也不那么准，官方指南要我们把请求留在常规上限内：发消息的 effort part、派出 agent 和 Workflow 的 state 都回到 24000（「Jev 的上下文默认值怎么算」），不带请求头。`needsLongContext` 和 `longWaitMs` 留着当保险：几个 agent 合进一个请求、加起来超出 `JEV_REGULAR_REQUEST` 时才带请求头，那批请求最多等 3000 毫秒。下面是 2026-10-15 到 0.8.x 的做法和依据，只作记录。

用户的要求：「固定 jev1.14 版本……在某大模型的最大上下文窗口内 40%-60% 以内是模型能力表现能力最好的时候，我们要开启长上下文请求但是不能占满，你来定一个合理的默认值」；随后「派出 agent 和 workflow agent 跟随一起改动……合并为一个请求判断，如果太长就分成几个合并请求，不要一条条的判断，懂得并行，但是并行不能超出我们的最佳性能范围」，「派出 agent 和 workflowagent 的判断要带上 haiku5.5 对对话的背景摘要」，「有可能 workflow 的 agent 不是一次性生成的」。

**事实（docs.typesafe.ai/models 和 API reference，2026-10-15 读；博客 2026-10-14）。** 请求头 `TypeSafe-Danger-Zone-Long-Context: true` 让一个请求和「state 加任何一道题」都到 262,144 token（不带时 64k 和 32k），1.14 和 1.13 都能用。文档说它 "slower and less accurate than staying within the default limits, so turn it on only for requests that need it"；博客说 danger-zone 的功能 "way too much jaggedness for us to vouch for these for production use cases"。准确率随长度怎么变，没有任何数字。

**数据。**
- ctx30（`eval/ctx30.ts`，用户设计：一段 6.2 万估算 token 的长对话，30 道题在一个请求里问，决定性的几轮都在最近 24000 之外，所以是长上下文最有利的设计）：长上下文（Jev 计 9.4 万 token，窗口的 36%）对 25/30（effort 12/15、派出 agent 13/15），最近 24000 对 13/30（5/15、8/15）；只有长上下文对的 12 题、只有 24000 对的 0 题，精确 McNemar p = 0.0005。
- eval v2（120 题，见「Jev 1.14」）：整段对话平均 14.6 万（56%）、最多 19.5 万时 60.0%，不比 24000 的 67.5% 好（p = 0.12）。
- 延迟（eval v2 的 1.14 长上下文运行，并发 1）：Jev 计 10–12 万 token p50 1.34 秒、最慢 1.55 秒；12–14 万 1.72 / 1.95 秒；14–16 万 1.83 / 2.36 秒；16–20 万 2.33 / 2.76 秒；约每 1k token 14 毫秒。ctx30 的 9.4 万用了 1.24 秒。
- Jev 计的 token 约是 mod 估算的 1.17–1.2 倍（中文对话，eval v2、ctx30）；英文更多，skill 画像约 1.37 倍。

**取值。**
- 发消息时主 agent 的 effort 题、派出 agent、Workflow 里的 agent：state 最多 96000 估算 token。按 Jev 的计数约 11.5 万（1.2 倍）到 13.2 万（1.37 倍），是 262k 的 44%–50%，在用户说的 40%–60% 里，不占满；比 ctx30 的 9.4 万大一些，比 eval v2 平均的 14.6 万（56%，没有变好）小。state 超过 24000（`JEV_REGULAR_STATE`）或 state 加全部题超过 48000（`JEV_REGULAR_REQUEST`）的请求才带请求头（`decision/jev.ts` 的 `needsLongContext`，`Backend.longContext`），其余请求和以前一字不差；带图的请求从不带（各自的功能把它们留在常规限制里）。`tests/backend-defaults.test.ts` 核对这三种的整个请求（state 按 1.37 倍，加最长的 8 个 agent 的题）在 262k 的 60% 以内。
- 中途重判（含卡住时）当时不变，24000，不带请求头：它读这一轮的几步，一般几千，步骤只等它 `rejudgeWaitMs`（300 毫秒），一个 1–1.5 秒的长请求几乎每次都会迟到。0.9.0 删了中途重判（ADR 0013）。
- skill 两段不变，6000。`contextMessages` 32 → 2000（上限同改）：32 条装不满 96000，长会话里条数先于 token 截断（ctx30 的 24000 已经要 100 条）。
- 等待：带请求头的请求至少等 `longWaitMs` 3000 毫秒（`BACKEND_DEFAULTS`，不是选项；按上面的延迟，9.6 万约 1.3–1.6 秒，再给排队等账号额度的时间留出余量：桶空了时一个满请求要等约 1.2 秒，见「Jev 的限速」）；和它一起发的请求也一样（一条消息的 effort 请求和 skill 请求一起发，额度紧时 skill 请求排在 effort 后面等额度；`core/setup.ts` 的 `waitFor`，`core/ask-group.ts` 用）；skill 第二段用这个等待剩下的（`PartOutcome.waitMs`）。一个 agent 最多等 `agents.waitMs` 6000（`agentWaitMs`：它的请求和车道里排在它前面的一个，各按 3000 算；pplx 8000）。
- 花费：Jev 只按输入计费，每百万 0.042 美元；一个满的请求约 11.5 万 token，约 0.0048 美元，长会话里每条消息约 0.5 美分（以前约 0.12 美分），每批派出的 agent 同样一份。

**agent 的请求合并（`core/agent-lane.ts`）。** 规则见「派出 agent」和「Workflow 兜底」。理由：每个 agent 的请求都要带一遍同样的背景（对话、摘要、脚本）：三个 agent 各一个 9.6 万的请求，token 花三份，按默认套餐每秒 10 万 input token 要用掉约 3.5 秒的额度；合进一个请求 token 一份，约 1.5 秒答完。「并行不超出最佳性能范围」落在车道和限速上：关于 agent 的请求同时在途 `agentLanes` 个，Jev 4（这一节起初定为 1，依据是 1.13 上短请求的实测像是依次处理；同一天量了 1.14 同时 4 个长请求，和单发一样快，改成 4，见「Jev 的限速」），pplx 5；车道占满时新到的 agent 并进下一个请求，不另发；所有请求还要过账号的限速。Workflow 的 agent 不是一次生成的：之后才启动的进下一个请求。

**问题摘要。** 派出 agent 和 Workflow 的请求本来就带问题摘要（`summary` 开着时，0.9.0 起默认开；之前 `unresolved` 开着时；`summaryModel` 默认 haiku，就是 Haiku 5.5），合并之后在一个请求里只放一份（`problem_summary`，和次数 `unresolved_count`；只当背景，不进规则）。Workflow 里启动时才判断的 agent 读启动运行那一轮的摘要（ADR 0007 的「启动那一轮」）。

**没有量的。** 96000 本身没有在评测集上扫过；agent 的请求带背景、几个合进一个请求之后准确率如何，没有量（`subagent` 评测集没有对话和脚本）；1.14 同时 4 个长请求量过一次（「Jev 的限速」），5 个以上没有量。

### Jev 的限速（2026-10-15）

用户给了账号的限额（默认套餐，TypeSafe 控制台 Rate limits 页）：每秒 80 个请求、每秒 10 万 input token，要求「按照这个限制调整并发，让我们的 mod 更加健壮稳定快速高效」。文档（docs.typesafe.ai，2026-10-15 读）：限额按组织算，按每秒请求数和每秒 token 数，超了回 429；529 是 TypeSafe 过载；SDK 遇到它们按 `Retry-After` 或退避重试；没写限额是令牌桶还是时间窗、一次能突发多少。

**实测（同一天，用户要的「测一下同时迸发 4 个请求」，只跑一遍，约 0.024 美元；脚本在会话的 scratchpad 里，不在仓库）。** 请求是 mod 发消息时的 effort 请求，state 约 9.4–9.55 万估算 token，带长上下文请求头，eval v2 里 5 段不同的对话（`cheap-agreement-01..05`），不会有缓存。先发一个很小的请求预热（637 毫秒）；单发一个：1443 毫秒（Jev 计 115,069 token）；歇 10 秒后 4 个同时发：各 1394–1527 毫秒（10.9–11.7 万 token），1.53 秒全部答完，都是 200，没有 429，响应里没有限速相关的头。所以 1.14 能同时答一个 key 的几个长请求；「一个 key 的请求一个一个答」是 2026-10-04 在 1.13 上用短请求量的（并发 1、2、4 时 p50 约 280、540、700–1100 毫秒），对 1.14 不成立。真正的上限是 token 速率：一个满请求约 11.5 万 token，默认套餐每秒只补 10 万。

`setup()` 把 `jevBackend` 包进 `decision/jev-rate.ts` 的 `jevRateLimited(backend, () => configs.jev.jevLimits)`，所有 Jev 请求都经过它。要点：
- **两个选项。** `jevQps`（1–1000，默认 80）、`jevTokensPerSecond`（10000–100000000，默认 100000），`readConfig` 读成 `Config.jevLimits`；每个请求现读，`/config` 改了马上生效。换了套餐就填控制台上的数。
- **令牌桶。** 桶最多存 `BURST_SECONDS`（5）秒的额度（默认 50 万 token），按每秒的额度补。请求发出时按 `jevRequestTokens` 预取：mod 的估算（state 和题目的 JSON）乘 `JEV_TOKENS_PER_ESTIMATED` 1.3（中文对话实测 1.15–1.30，英文到 1.37），图按 `imageTokens`；答完按 Jev 报的 `usage.input_tokens` 多退少补，退了就叫醒等额度的请求。被 429、529 拒的请求全额退回；其他失败（超时、5xx）不退，它可能已经被算进去了。比整个桶还大的请求等桶满了再发（mod 的请求没有这么大）。为什么是桶：4 个满请求之后，第 5 个只等补够它缺的那部分（约 0.7 秒），固定时间窗要等整个窗口过去。为什么是 5 秒：一次 45 万 token 的突发没有被限，所以 TypeSafe 至少允许这么大的突发，5 秒（50 万）是比它略大的猜测，猜多了靠下面的 429 处理补救。
- **每秒请求数。** 最近一秒发出的时间记一个列表，满 `jevQps` 个就等到最早那个满一秒。mod 的请求多是长请求，默认套餐下它几乎碰不到，token 速率先到。
- **排队。** 和 pplx 共用 `decision/rate-queue.ts` 的 `rateQueue()`（各有各的一个队列）：effort 题（`priorityOf`，也在 rate-queue.ts）优先级 0，其余 1、先来先发；只有队首占位，后面的就算装得下也等着，免得大请求一直被小请求插队。一个请求被问的那一刻拿一张 `Ticket`（`priority`、`order`），遇到 429 重试时还用这一张，所以重试排在它出去期间才到的请求前面。入队之前先读时钟，时钟出错的请求不留在队里，不会占着队首让后面的都等不到。桶空了的最坏情况，effort 题排在最前，只等补够它自己的 token（满请求约 1.2 秒），再加约 1.4 秒回答，仍在 `longWaitMs` 3000 之内。
- **排队的时间算进该请求自己的等待。** 和 pplx 一样：离 deadline 不到 `LEAST_SEND_MS`（200 毫秒，rate-queue.ts，两个限速都用）的请求不占位也不发。排队的请求在 deadline 前 200 毫秒放弃；占到位之后才发现只剩不到 200 毫秒的，取出的 token 退回桶里。这样排不上位的请求按超时失败（`no answer in <timeoutMs> ms`），不发。等过的请求在 debug log 那一行末尾写 `waited N ms for its place within the account's rate limit`（`Asked.notes`）。
- **429 和 529。** `httpFailure`（`decision/backend.ts`）只在 429、529 上把 `Retry-After`（整数秒，和 pplx 共用 `retryAfterSeconds`）读成 `retryAfterMs`。收到 `busy` 的 429 或 529 时，所有请求暂停到 `Retry-After` 之后，但最多 `MAX_HOLD_MS`（5 秒，`BURST_SECONDS` × 1000）：写一个小时的 `Retry-After` 也只停 5 秒，更长的等待说明别处出了问题，请求发出去才知道，攥着不发不知道。没有 `Retry-After` 就 429 停 1 秒、529 停 0.5 秒。暂停先写好，再把被拒请求的 token 退回桶里：退回会叫醒等 token 的请求，它们必须看到暂停已经在了。收到的那个请求剩余等待时间不少于暂停加预计用时（`expectedMs`：每千 token 15 毫秒，至少 300）就重试一次（重新排队，用原来的 `Ticket`），用第二次的结果，debug log 写 `HTTP 429, asked again after N ms`。重试遇到的第二次 429 或 529 也让所有请求暂停（以前不会）。其他失败不重试。失败交出去之前去掉 `retryAfterMs`（`handedOver`，rate-queue.ts，和 pplx 共用）。Jev 的 429 在看板上仍写「繁忙（状态码 429）」（0.3.1 的写法，没有改）。
- **被暂停挡住的请求写「繁忙」，不写「超时」。** 暂停一直到这个请求的等待结束之后还不完，它在自己的等待里发不出去，就不发，按 `busy` 失败：状态码是那次 429 或 529 的，detail 写 `HTTP 429 earlier: not sent, the account was told to wait N ms more and this request waits M ms`，看板写「繁忙（状态码 429）」。其他排不上位的请求仍按超时失败。
- **状态放在后端对象里**（桶、最近一秒的发送、暂停到何时），不在 `$.state`：热重载会重建它，桶是满的，刚好接着一阵突发时可能多放出去一些，靠 429 补救；同一个 key 的其他会话也看不到，一样靠 429。pplx 把发送时间放进 `$.state`，是因为它每秒只有 5 个，多放一个就是 429；Jev 的桶有 50 万，一次热重载的误差小得多。
- **评测不经过**：评测的 `io` 没有 `pace`，直接放行，并发由它自己的 `--concurrency` 管。
- **随之改的。** `agentLanes` Jev 1 → 4（「Jev 的长上下文」的「agent 的请求合并」）。`longWaitMs` 3000、`agentWaitMs` 6000、一条消息的几个请求共用等待都留着（当时还有重判请求等 3000，0.9.0 随中途重判删了），理由从「Jev 一个一个答」换成「额度紧时要排队等 token」。
- **测试。** `tests/jev-rate.test.ts`（接缝 2，`mock.clock`，假后端记下每个请求到达的时间）：4 个满请求一起发、第 5 个等补足；答完按实数退回、等着的马上发；`jevQps` 2 时第 3 个等一秒；effort 题插队；429 带和不带 `Retry-After`、529、503 不等；等不到位的按超时失败、不发；剩不到 200 毫秒的从不发出；重试遇到的第二次 429 也让所有请求暂停；一个小时的 `Retry-After` 只停 `MAX_HOLD_MS`；被暂停挡住的写 `busy` 而不是超时；暂停在退回的 token 叫醒下一个请求之前就已经在；重试保留原来的位置；时钟出错不卡住队列；没有 `pace` 直接放行。`tests/jev-failures.test.ts` 新增（接缝 2）：402 是 `quota`，`Retry-After` 只在 429 和 529 上读，key 不留在失败的 detail 里，读不懂的 2xx 是 `parse`。接缝 1：`tests/main-effort.test.ts` 测 429 重试后这一轮按第二次的回答走，`tests/dispatched-agents.test.ts` 测 4 条车道，`tests/backend-defaults.test.ts` 测选项的读法。

## 按 AA 基准校正（0.2.2）

> 0.9.0 删掉了一轮中途重判和卡住时的强制升档（ADR 0013）；这一节里说到它们的地方只作记录。

用户 2026-10-05 要求按 Artificial Analysis 智力指数 v4.3.2 的十个分项校正模型选择和 effort 规则。原始数据、来源 URL 和已存评测回答按新规则离线重算的结果在 `docs/research/aa-benchmarks-2026-10.md`。改了这几处，每一处都是代码里的常量或 `BACKEND_DEFAULTS`，不进 `userConfig`（除了本来就是配置项的三个门槛）：

1. **派出 agent 的模型选项文字**（`KINDS`）：haiku 只做一两步就能完成的只读查找（Terminal-Bench 0%，AutomationBench 3.2%，HLE 10.4%）；sonnet 承担大多数执行类工作（终端、自动化、知识工作上与 Opus 持平或略高；Omniscience 32 对 46，幻觉率 47%，HLE 差 6.4，SciCode 差 5.9）；opus 管依赖事实知识的调研、难推理、设计、原因未知的 bug、科学或算法类代码和高风险工作；fable 文字不变，仍默认关闭（AA 上没有领先 Opus 5.5 的地方，价格 2.5 倍）。选项名、`work` 键、问题结构都不变。
2. **effort 往上取一档**（`pickEffort`、`roundUp`，0.2.2 时是 `effort.ts` 的常量 `ROUND_UP` 0.3，现在是 `BACKEND_DEFAULTS` 里按决策模型取的值，Jev 仍是 0.3）：先取概率最高的一档，高一档的概率也有 `roundUp` 以上就往上取一档，只取一次；`max` 仍要它自己的概率达到 `thetaMax`（不论它是最高的一档还是往上取会到的那一档）。发消息时、中途重判（`judgeMidturn`）、卡住时的强制升档（`traceRaise`）、派出 agent 的 effort 都用这一个函数。
3. **中途门槛**：`thetaUp` 0.4 改 0.3，`thetaDown` 0.6 改 0.75（每次最多降一档的规则保留；0.2.3 起是 0.55，见「降档门槛（0.2.3）」），`holdSteps` 3 改 5。`thetaUp`、`thetaDown` 在 `BACKEND_DEFAULTS`，`holdSteps` 是 manifest 的默认值（同时是 `readConfig` 的后备值），README 的配置表同步。
4. **按模型设 effort 下限**（`effortFloor`）：sonnet 和 opus 至少 medium；haiku 和 fable 没有。用在派出 agent 和 Workflow 里 `agent()` 的决策上；你点名的 effort 和模型永远优先，下限和往上取的一档都不碰它们（`decideDispatch` 里 `namedEffort ?? lifted ?? decided`）；主 agent 自己的 effort 不受下限管（它没有模型可选）。对已经有 effort 的 agent，卡住后「预期内」的重判也不降到它的下限以下。
5. **报告开始的轮次也走 effort 路由**（见「它做什么」）：`origin.kind` 是 `peer`（子 agent 交回的结果）或 `task-notification`，没有 `turnId`；用的是同一题，`user_message` 换成报告的文字；不问 skill，状态里的预算取 `messagePlain`；用户的锁定优先；决策日志记作 `main-effort (agent report)`；这一轮不做中途重判。这是 `core/prompts.ts` 的 `startsReportTurn`（其他非本人的 origin 保持不判断），`PendingDecision.report` 让 `turn.start` 把这一轮记成不是本人开始的。生成的类型（`PromptOrigin`）和 `docs/research/mods-api-routing-capabilities.md` 说明了这两个 origin：`peer` 是另一个会话或 agent 的模型，`task-notification` 是后台任务的通知，闲置时到达的开始新的一轮（`turnId` 不在），送进正在进行的一轮的带着那一轮的 `turnId`。
6. **Jev 的上下文按请求种类分开取**（见「Jev 的上下文默认值怎么算」）。

**依据的数字**（max 档，Haiku 取 Reasoning；各 effort 档见研究笔记）：

| 项 | Haiku 4.5 | Sonnet 5.5 | Opus 5.5 | Fable 5.1 |
|---|---|---|---|---|
| Intelligence Index v4.3.2 | 17 | 56 | 58 | 53 |
| Terminal-Bench 4.0 | 0.0% | 63.6% | 59.6% | 52.0% |
| AutomationBench-AA | 3.2% | 71.8% | 69.5% | 59.4% |
| SciCode | 42.2% | 61.0% | 66.9% | 63.1% |
| Humanity's Last Exam | 10.4% | 55.0% | 61.4% | 59.1% |
| AA-Omniscience | -4 | 32 | 46 | 43 |

Sonnet 5.5 在 low、medium、high、max 的指数是 36、41、47、56（Terminal-Bench 20.7%、29.8%、43.9%、63.6%）；Opus 5.5 是 42、51、54、58。低估一档要付的质量大，高估一档只多花 token，所以往上取、抬下限、抬降档门槛。

**离线重算（零费用）。** `node dispatch-pilot/eval/rescore.ts [--markdown]`（`eval/lib/rescore.ts`，`tests/eval-rescore.test.ts` 用手算的小例子测过）读 `eval/results/` 里已存的回答，用 0.2.1 的规则和现在的规则各选一次档，和数据集的 gold、accept 比较，报告准确率、gold 命中率、偏高率、偏低率；不发请求，不改结果文件。旧规则作为 `legacyPickEffort` 和 `LEGACY_RULES` 留在评测库里。`node dispatch-pilot/eval/real.ts <结果文件> ...` 对 effort 两套评测按存着的回答原样算同样的四项（`sent` 另列一行），用来对照真实运行的前后。在已存的回答上：准确率略降（effort-submit Jev 的变化在 -1.5 到 +2 个百分点之间，派出 agent 降 7.5 到 8.5 个百分点），偏低减少（effort-submit 少 1.5 到 3.5 个百分点，中途重判的 `picked` 少 2 到 4 个），偏高增加；数据集的 gold 是按「够用的最便宜档」标的，没有参考 AA，所以这个方向是规则的本意，不是变差。完整的表在研究笔记里。离线重算改不了模型文字，所以模型文字和 sonnet 的下限用真实调用调过（下一小节）。

### 评测迭代（真实的 Jev，用户授权，约 0.10 美元）

用户先跑了一次 `subagent`（`models-hint`）：整体 70/68 掉到 60/58，模型部分 85/85 到 82/81（model-over 从 8/10 题增加到 12/12 题），effort 部分 74/72 到 64/62。用户决定：sonnet 的下限降到 medium、收窄 opus 的「适合」、用真实调用调（总花费上限 0.25 美元，每次只改一处文字，最多 5 轮）。逐轮的结果（整体、模型部分、effort 部分，中/英）：

| 版本 | 改了什么 | 整体 | 模型 | effort | model-over | model-under |
|---|---|---|---|---|---|---|
| 0.2.1 | （改动前） | 70/68 | 85/85 | 74/72 | 8/10 | 7/5 |
| `aa-routing` | 第一版 0.2.2：sonnet 下限 high，opus 原文 | 60/58 | 82/81 | 64/62 | 12/12 | 6/7 |
| `aa-iter1` | sonnet 下限 medium；opus 只留「记忆中的事实、无法在仓库或文档里查证」 | 59/56 | 77/77 | 67/64 | 10/11 | 13/12 |
| `aa-iter2` | opus 先写「需要审慎判断或细微错误代价高」，记忆中的事实放最后 | 64/61 | 84/84 | 67/65 | 10/10 | 6/6 |
| `aa-iter3` | haiku 写成「结果只需收集并按要求排版的查找」 | 69/68 | 89/91 | 71/71 | 6/4 | 5/5 |
| `aa-iter3-repeat` | 同一版重复一次 | 69/67 | 89/90 | 71/71 | 6/4 | 5/6 |

结论：目标（模型部分回到 85% 附近或更高，model-over 不比改动前多，effort 部分比第一次真实运行高）都达到。限制：(1) 同一版重复时差在 1 个百分点以内，但版本之间小于约 2 个百分点的差别不能当结论；(2) 三轮文字是看着这 100 题的错题改的，最后的模型部分是在调过的题上量的，对没见过的请求大概率更低，低多少没有量；(3) effort 部分比改动前低 3 到 1 个百分点，是往上取一档和模型下限的代价，gold 命中 50/48 变 44/44。每一轮的原因、发消息和中途重判的真实对照（`effort-submit` 准确率不变；`effort-midturn` 的 `picked` 偏低少 5.5 到 7.5 个百分点，`sent` 的偏高多 6 到 8 个百分点，因为 `thetaDown` 0.75 让该降的一轮降不下来）和花费在 `docs/research/aa-benchmarks-2026-10.md` 的第六节。结果文件：`eval/results/subagent/2026-10-05-jev-aa-*.json`、`eval/results/effort-submit/2026-10-05-jev-aa-final.json`、`eval/results/effort-midturn/2026-10-05-jev-aa-final.json`。

## 降档门槛（0.2.3）

> 这一节调的是一轮中途重判的降档门槛 `thetaDown`；0.9.0 删了中途重判（ADR 0013），这里只作记录。

0.2.2 把 `thetaDown` 从 0.6 抬到 0.75 之后，真实运行里 `effort-midturn` 的 `sent` 偏高从 11.5% / 11.0%（`en-score` / `zh-score`，0.2.1 的规则）涨到 19.5% / 17.5%，`en-score` 准确率 76.5 掉到 70.5。用户认为实际走的档偏高太多，同意调低，具体值靠数据定。

**扫描（零费用）。** `node dispatch-pilot/eval/rescore.ts --theta-down 0.55,0.6,0.65,0.7,0.75 <结果文件>`（`eval/lib/rescore.ts` 的 `scanThetaDown`，`tests/eval-rescore.test.ts` 用手算的小例子测过）在已存的各档概率和 confidence 上，只改 `thetaDown`，其余规则不变（`thetaUp` 0.3、往上取一档、`thetaMax`），重算 `sent`，按语言（`zh`、`en`、两者合计 `both`）报准确率、gold 命中、偏高、偏低。`2026-10-05-jev-aa-final.json` 上两者合计（200 个回答，单位 %；括号外是准确率 / gold，括号内是偏高 / 偏低）：

| `thetaDown` | `en-score` 准确率 / gold | 偏高 / 偏低 | `zh-score` 准确率 / gold | 偏高 / 偏低 |
|---|---|---|---|---|
| 0.55 | 73.0 / 45.5 | 17.0 / 10.0 | 74.5 / 47.0 | 16.0 / 9.5 |
| 0.60 | 72.5 / 46.0 | 17.5 / 10.0 | 73.0 / 46.0 | 17.5 / 9.5 |
| 0.65 | 71.5 / 46.0 | 18.5 / 10.0 | 73.0 / 47.0 | 17.5 / 9.5 |
| 0.70 | 71.5 / 45.5 | 18.5 / 10.0 | 73.0 / 48.0 | 17.5 / 9.5 |
| 0.75 | 70.5 / 46.0 | 19.5 / 10.0 | 73.0 / 48.5 | 17.5 / 9.5 |
| 对照组（0.2.1：0.4 / 0.6 / 3） | 76.5 / 51.5 | 11.5 / 12.0 | 73.5 / 50.0 | 11.0 / 15.5 |

中文题和英文题分开看是同一个趋势（见命令的输出）。

**选值规则（用户定）。** 偏高回到对照组附近（约 11%–12%），偏低仍低于对照组（`en` 12.0，`zh` 15.5）；满足的取最高的一个（降低难）；都不满足就取偏高加偏低最小的。结果：0.55 到 0.75 里没有一个值让偏高回到 11%–12%（最低是 0.55 的 17.0 / 16.0），偏低在每个值上都低于对照组，所以走第三条：偏高加偏低 `en-score` 是 0.55 的 27.0 最小（0.75 是 29.5），`zh-score` 是 0.55 的 25.5 最小（其余都是 27.0）。`thetaDown` 定为 0.55。

**扫描没有覆盖的。** 最小值落在扫描范围的下沿，所以另外扫了 0.3 到 0.5（也是零费用，没有进默认值）：`en-score` 偏高 15.5–17.0、偏低 10.5–11.0；`zh-score` 偏高 12.5–15.5、偏低 10.0–10.5（0.3 到 0.4 的 12.5 接近目标，但 `en-score` 在同样的值上是 15.5 到 16.5，两个变体不一致；而且降档的门槛和升档的 0.3 贴在一起，已经没有「降低更难」的意思）；就算降到 `thetaUp` 的 0.3（再低按 `thetaUp` 算），`en-score` 的偏高也回不到 11%–12%。原因：`sent` 的偏高里有 `picked` 本身偏高的部分（往上取一档之后 `en-score` 11.0、`zh-score` 8.0，0.2.1 是 6.5 和 4.5），这一部分 `thetaDown` 管不到；要回到对照组的水平，得动往上取一档的 0.3，那是另一个决定，这里没有动。

**真实验证（Jev，`eval/results/effort-midturn/2026-10-05-jev-theta-down.json`，`--label theta-down`，400 个请求，实际花费约 0.0149 美元）。** `node dispatch-pilot/eval/real.ts` 对三份结果算的 `sent`（200 个回答，单位 %）：

| 运行 | 规则 | `en-score` 准确率 / gold | 偏高 / 偏低 | `zh-score` 准确率 / gold | 偏高 / 偏低 |
|---|---|---|---|---|---|
| `2026-10-04-jev-reviewed` | 0.4 / 0.6 / 3（对照组） | 76.5 / 51.5 | 11.5 / 12.0 | 73.5 / 50.0 | 11.0 / 15.5 |
| `2026-10-05-jev-aa-final` | 0.3 / 0.75 / 5 | 70.5 / 46.0 | 19.5 / 10.0 | 73.0 / 48.5 | 17.5 / 9.5 |
| `2026-10-05-jev-theta-down` | 0.3 / 0.55 / 5 | 73.0 / 46.0 | 16.0 / 11.0 | 74.5 / 46.5 | 16.0 / 9.5 |

偏高比 0.75 低 3.5 和 1.5 个点，`en-score` 准确率回升 2.5、`zh-score` 回升 1.5，偏低仍低于对照组，但没有回到对照组的偏高。哪些在波动里：这次运行的 `picked`（没有经过门槛）本身就比上一次的 `aa-final` 准确率高 1.5 和 0.5、`en-score` 偏高低 1.5，说明运行之间有这么大的差；用这次自己的回答离线把门槛换回 0.75，`sent` 偏高是 18.0 和 17.5，所以 0.55 带来的差是 `en-score` −2.0、`zh-score` −1.5 个点，`en-score` 真实运行里的 −3.5 有一部分是运行波动。单次运行的波动约 ±2 个点，所以 `zh-score` 的偏高变化、准确率的两个回升、偏低的 +1.0 和 0 都不能当结论；站得住的只有两条：扫描里（同一批回答，没有抽样波动）偏高随 `thetaDown` 单调下降、偏低不动；偏高没有回到对照组的 11%–12%（差 4.5–5 个点，超出波动）。

## Jev 1.14（2026-10-15）

TypeSafe 在 2026-10-14 发布 `jev-1.14.0`（博客说各方面小幅改进，多语言提升最大；`jev-latest` 一周后才从 1.13 换过去），同时放出长上下文（请求头 `TypeSafe-Danger-Zone-Long-Context: true`，每个请求和每题都到 262k token，1.13 和 1.14 都能用；models 页说它更慢、不那么准）。用户的问题是：effort 和派出 agent 的问法、门槛要不要跟着改。做法是拿已存的 1.13 结果对照，只跑 1.14，每组只跑一遍；长对话的那一组按用户的要求用新的上下文窗口。结果文件都在 `eval/results/` 下，名字带 `jev114` 或 `jev113-long`，共花约 1.78 美元。

**用户的决定**：不带图的 Jev 请求固定用 `jev-1.14.0`（`decision/jev.ts` 的 `JEV_MODEL`，不跟着 `jev-latest` 走：models 页的原话是 "If you have tuned confidence thresholds against one version, send that version's ID instead of the alias"）；派出 agent 和 Workflow 里的 agent 用中文问（`BACKEND_DEFAULTS` 的 `ask.agent`，pplx 仍是英文；0.9.0 起改回英文，ADR 0014）；门槛不改；长上下文当时不给 mod 用（评测里能用：`run.ts --long-context`）。同一天用户看过 ctx30 的结果后改了：见「Jev 的长上下文」。

**只差版本的三套**（请求和 2026-10-07 的 1.13 两遍 r1/r2 逐字相同，数据集哈希一致；题本来就短，放大预算请求不变，只多一个请求头）。准确率是中文题 / 英文题：

| 套 | 问法 | 1.13（两遍） | 1.14 | 读法 |
|---|---|---|---|---|
| effort-submit | `zh-score`（发消息时 Jev 的问法） | 86/86、88/85 | 85/83 | 持平，英文题略降 |
| effort-midturn | `en-score`（中途重判 Jev 的问法） | 78/76、76/74 | 74/76 | 持平 |
| subagent | `models-hint`（原来派出 agent 的问法，英文） | 69/65、70/67 | 71/68 | 持平 |
| subagent | `models-hint-zh`（中文问） | 67/64、65/65 | 72/71，再跑一遍 72/72 | 1.14 上变好；选模型 81–83 → 88–89，effort 70–72 → 74 |

1.14 的 p50 约 260 毫秒，1.13 约 290 毫秒。逐题配对的精确 McNemar 检验：`models-hint-zh` 1.14 对 1.13 是 19 对 7（只有一方判对的题数），p = 0.029；在 1.14 上中文问对英文问是 15 对 11 和 16 对 11，p ≈ 0.5，分不出高下，英文问法选模型还略好一点（89/90 对 88/89），中文问法定 effort 好 2–4 个点。换成中文是用户看了这些数字之后的决定。同样的两遍 1.14 中文问法，200 行里只有 3 行结果不同：Jev 几乎是确定的，多跑几遍不比多一些题有用。

**长对话：eval-v2 的 120 题**（中文问法 `zh-score`，用现在的金标和门槛统一重判，分析脚本不在仓库里）：

| | 旧上下文：最近 24000 token、32 条 | 整段对话：`--long-context --state-tokens 180000 --state-messages 5000` |
|---|---|---|
| 1.13 | 67.5%（J′，2026-10-08；决定性几轮只在 30/120 题的 state 里） | 64.2%（判高 15.0、判低 20.8） |
| 1.14 | 没测 | 60.0%（判高 20.8、判低 19.2） |

- 整段对话按 mod 的估算 7.8 万到 15.8 万 token，Jev 数下来平均 14.6 万、最多 19.5 万（中文对话 Jev 的计数约是估算的 1.17–1.2 倍）。120 题的决定性几轮都在 state 里。两组长上下文的请求逐字相同，延迟一样：p50 约 1.83 秒、最慢 2.8 秒，四分之三超过发消息时 Jev 等的 1500 毫秒。
- 三组之间的差都不显著：旧上下文对 1.13 整段是 11 对 7（p = 0.48），1.13 整段对 1.14 整段是 12 对 7（p = 0.36），旧上下文对 1.14 整段是 18 对 9（p = 0.12）。重扫门槛，1.13 整段在 `roundUp` 0.2 时到 69.2%，1.14 整段最好 62.5%。能说的只有：长上下文没有让判断变好，而且慢过 mod 的等待，所以不开。
- 这套题本身的分辨力有限：两个写金标的人 effort 完全一致的是 82.5%，落在对方可接受档位里的是 95.8%；102 题接受 2 档、17 题接受 3 档，一直答 xhigh 也能对 53.3%。120 题上几个百分点的差分不出来；要量出这种差，要更多的题，不是重复运行。
- eval-v2 的 `zh-score` 同一个请求里还问了三选一题（`unresolved` 开着时 mod 的问法）；默认安装只问 effort（`zh-score-alone`）。各题独立判断，effort 的答案应该不受它影响，但严格说和默认安装发的请求不完全一样。
- 没有用 long-context 套件（#44）：它的长对话是 `lib/long-filler.ts` 按模板生成的填充，用户的要求是喂进去的上下文都要有内容。

## d1-ultra 的预算（2026-10-28，ADR 0017）

用户 2026-10-28 决定接入 d1-ultra、不做评测，等待时间按冒烟实测来定。冒烟一共 3 次 d1-ultra、1 次 Jev 请求，都是合成的 state（脚本在会话的 scratchpad 里，没有提交）：

| 请求 | 题数 | mod 估算 | Liquid / Jev 计 | 耗时 |
|---|---|---|---|---|
| d1-ultra：一份 state 加一道很短的是非题（量 token 比例） | 1 | 23,346 | 25,484（1.092 倍） | 2,696 ms |
| d1-ultra：mod 自己组装的发消息请求（`turnStartPart` + `messageRequest`，预算 24000） | 11 | 23,514（state） | 25,689 | 2,031 ms |
| Jev 1.14：同一个请求 | 11 | 23,514（state） | 28,557 | 887 ms |
| d1-ultra：两个派出 agent 合进一个请求（路由题、四道下限题、effort 题） | 12 | 小 | 2,196 | 726 ms |

- **token。** Liquid 数的是 mod 估算的 1.092 倍（`LIQUID_PER_ESTIMATED_TOKEN`），比 Jev 的约 1.2 倍少。24000 的 state 约 2.62 万，加最长的一题（effort 题约 450 估算）约 2.72 万，是每题上限 32,768 的 83%，所以 d1-ultra 沿用 Jev 的全部预算（`contextByKind` 24000，带 skill 题的 6000），不收紧。
- **计费。** state 只算一次：11 道题的请求只比 1 道题的多约 200 token。2026-10-15 时 Liquid 文档说每道题各算一份 state（eval 的 `estimateRunPerQuestion` 就是按这个写的），现在已经不是这样，那个估算偏高，不会偏低。
- **等待。** 满预算的请求 2.0–2.7 秒，Jev 0.9 秒，所以 `timeoutMs` 默认 4000（慢的那次的约 1.5 倍）；派出 agent 最多等 8000（`agentWaitMs`）。`find_skill` 6000，skill 第二段至少 1500 是按 token 比例推的，没量。
- **答案。** 发消息的那个请求（「还是不行，同样的 401……线上支付回调……不能回滚，你再仔细查查」）：d1-ultra 的 effort 位置 3.37、置信度 0.47（< 0.5，往上一档到 max），`escalate` 0.948、`confirm` 0.062、`still_failing` 0.983、`stakes.undo` 0.902、`stakes.live` 0.655（Liquid 的线下拿不准）；Jev 位置 3.34、置信度 0.64，`escalate` 0.95、`confirm` 0.05，出错代价两道为是，定 max。两个派出 agent：列出 moment.js 的用法 `fast` 0.99 → haiku、low；线上重复扣款 `powerful` 0.97 → opus（主 agent 指定的 sonnet 升级）、xhigh。

d1-ultra 没有评测，是用户的决定；eval 的 `--backend d1` 仍是下面 2026-10-16 那次核验的做法（Jev 那一行的默认值、模型表），不是 mod 的 d1-ultra。

## d1-ultra 核验（2026-10-16）

> 下面 `effort-midturn` 的数字和「中途重判」的结论只作记录：0.9.0 删了中途重判（ADR 0013）。

Liquid AI 在 2026-10-15 发布决策模型 `d1-ultra`。它和 Jev 用同一种 System One 协议：`POST https://api.liquid.ai/decisions/v1/systemone`，题型同样是 noul、choice、score，回答里给概率。它只有托管 API，没有长上下文头。按 Artificial Analysis Decision Index v1.0，d1-ultra 65.2 分，Jev 1.14 57.1 分。不过 8.2 分的差里有 5.9 分来自 Omniscience 的非幻觉率，也就是答不出时选「I don't know」；mod 的题没有这个选项。HLE 和 Omniscience 的准确率，d1-ultra 都低于 Jev 1.14。pplx 用的 Decider v1.1 27B 在这个榜上只有 53.1 分，但在 eval-v2 上比 Jev 高 12 个点，所以 AA 的总分推不出 mod 题上的高下。

用户的问题是值不值得给 mod 接入 d1-ultra。按用户定的标准：
- 只比准确率，延迟和花费都不算。
- 每项只跑一遍。
- 能合进一个请求的题尽量合进一个请求。
- 和 Jev 1.14 比（d1-ultra 争的是 Jev 的位置）；pplx 只拿已有结果作参照。
- 三套短题里至少一套显著更好（逐题配对的精确 McNemar，p < 0.05），其余几套不显著变差。
- 读长对话的几种请求，不显著差于 Jev 的长上下文才算过。

评测侧的改动（mod 本身不动）：
- `eval/lib/d1.ts`：d1 后端。`run.ts --backend d1` 读 Jev 那一行默认值（问法、门槛、预算），所以发出的请求和问 Jev 的一样；三套短题的 state 和题面逐字核对过，和 Jev 1.14 那次相同。
- `run.ts --merge`（`eval/lib/merge.ts`）：同一个 state 的请求合成一个发出，同一个请求只发一次。
- `eval/paired.ts`：逐题配对和门槛扫描。`lib/rescore.ts` 的 `regrade` 按别的门槛重判已存的回答；按原门槛重判，Jev 的三套结果逐条和存下的一致。
- `ctx30.ts --backend --tokens`：按指定后端和预算只发一个请求。

结果文件名带 `d1-merged`、`d1-s28000`、`jev-s28000`、`d1-28000`、`jev-28000`。共花约 0.57 美元，其中包括探针和一次因合并运行收尾 bug 中途停掉、没有存结果的运行。

**探针**（脚本在会话 scratchpad，不在仓库）：
- 上限按题算：每题是 state 加这一题，最多 32,768 token，另有 250,000 字节的上限。一个请求里可以放很多题，28k 的 state 配 3 题共 82k token 也能过。422 的原话是 "The prompt for question `effort.level` is over the model's input limit of 32768 tokens"。
- 计费按题算，每题都带整个 state：3 题收 3 份。所以合并请求在 d1 上省不了 token，在 Jev 上能省。
- d1 数出的 token 约是 mod 估算的 0.86–0.97 倍，评测按 1.1 倍估算（`D1_ESTIMATE_FACTOR`）。state 预算取 28000 估算 token：28,834 估算数下来 27,431 token，能过；36,958 被拒。
- d1 不是确定的：同一个请求发两次，各档概率最多差约 0.08，Jev 两次之间几乎相同。合发和单发之间的差（不超过 0.05）在这个范围内，3 题 × 2 种问法按 mod 的规则定出的档全部相同，所以合并发送。只跑一遍时，落在两档边界上的题可能翻转。

**三套短题**（d1 用 Jev 的门槛 `thetaMax` 0.5、`roundUp` 0.3；中英两面合计 200 个回答；A = Jev 1.14，即 `2026-10-15-jev-jev114-long`，B = d1）：

| 套 | 问法 | Jev | d1 | 只 Jev 对 / 只 d1 对 | p |
|---|---|---|---|---|---|
| effort-submit | `zh-score`（mod 的问法） | 84.0% | 80.0% | 24 / 16 | 0.27 |
| effort-submit | `en-choice` | 81.5% | 76.0% | 18 / 7 | **0.043**（d1 差） |
| effort-midturn | `en-score`（mod 的问法） | 75.0% | 79.0% | 11 / 19 | 0.20 |
| effort-midturn | `no-counts` | 73.5% | 80.5% | 12 / 26 | **0.034**（d1 好） |
| subagent | `models-hint-zh`（mod 的问法） | 71.5% | 62.0% | 29 / 10 | **0.003**（d1 差） |
| subagent | 其余 5 种问法 | 64.0–69.5% | 53.5–57.0% | | 全部 < 0.05（d1 差） |

effort-submit 的另外两种问法、effort-midturn 的另外四种问法都不显著。派出 agent 上 d1 输在两处：选模型 86% 对 88%，定 effort 62% 对 74%。

**各用自己的最优门槛**（`paired.ts --scan`，三套 mod 问法的平均，样本内调出来的）：
- d1 最好的是 `thetaMax` 0.65、`roundUp` 0.45，平均 79.0%（按 Jev 的门槛是 73.7%）。三套分别是 effort-submit 86.0%、effort-midturn 82.5%、subagent 68.5%。
- Jev 最好的是 0.6、0.5，同样是 79.0%（按出厂门槛是 76.8%）。
- d1 用自己的门槛，对 Jev 的出厂门槛：
  - effort-submit 86.0 对 84.0，p = 0.60；
  - effort-midturn 82.5 对 75.0，p = 0.003；
  - subagent 68.5 对 71.5，p = 0.41。
- 对 Jev 的最优门槛：
  - effort-midturn 82.5 对 77.5，p = 0.041；
  - subagent 68.5 对 74.5，p = 0.065。
- d1 的概率校准得比 Jev 好（AA 的校准图），它的最优门槛离 Jev 的很远，所以只用 Jev 的门槛看会低估它；但门槛是在同一套题上调出来的。

**长对话**（d1 每题最多 32k，只能读最新 28000 估算 token）：

| 题集 | d1，28000 | Jev，28000（过 24000 自动带长上下文头，和 mod 一样） | Jev 长上下文 |
|---|---|---|---|
| eval-v2 `zh-score` | **75.0%** | 63.3%（只 Jev 对 13 / 只 d1 对 27，p = 0.039） | 60.8%（13 / 30，p = 0.014；整段对话，2026-10-15） |
| ctx30 | 16/30 | 15/30（2 / 3，p = 1） | **25/30**（只 Jev 对 10 / 只 d1 对 1，p = 0.012） |

- eval-v2：d1 判高 17.5%、判低 7.5%，max 召回 17.9%（Jev 28000 时是 0%）。三选一题 d1 对 78.3%，Jev 对 66.7%。
- ctx30 的关键信息专门放在最新 24000 之外，28000 的 state 里只多看到 E09、A10、A14 三题。读不到的，d1 也判不出。eval-v2 上，同样读 28000 时 d1 比 Jev 好，比 Jev 读整段也好。两套题指的方向相反。

**按用户的标准：不接入，不替换 Jev。**
- 用 mod 现在的门槛：派出 agent 的六种问法 d1 全部显著更差，「其余不显著变差」这一条过不了。
- 用 d1 自己的门槛：中途重判显著更好，派出 agent 差 3–6 个点但不显著，形式上过了。但这组门槛是在同一套题上调出来的，而且 ctx30 上 d1 显著差于 Jev 的长上下文，读长对话这一条过不了。
- 值得以后再看的只有两处：
  - 中途重判：用 d1 自己的门槛，在 200 个回答上比 Jev 高 5–7.5 个点。
  - eval-v2 上发消息的 effort。
- 要拿准，得用没调过门槛的新题再测一遍；ctx30 和 eval-v2 也要更多的题。

## 待评测

**0.9.0（ADR 0014，按 TypeSafe 的官方指南重做发消息时的判断）之后没有数据的：** 新的问法（英文的 effort 题加八道是非题）、写在代码里的定档规则（位置四舍五入、双峰、R1–R5）、回到常规上限的 24000、派出 agent 的英文问法和新的 effort 读法，都没有重跑评测（用户的决定：按官方推荐，不再用我们自己的评测分数调门槛）。是非题的 0.7 / 0.3 是 TypeSafe 的起始值，没有校准。问题摘要、长期约束和上一轮的情况补回了多少更早几轮的信息，没有量。要重跑时，各 suite 发的请求和 mod 的逐字相同（`effort-submit` 的 `en-score`、`unresolved` 的 `en-score-wide`、`long-context` 和 `eval-v2` 的 `en-flow`）；流程文件和长对话的摘要要先用新的英文提示重写（`eval/eval-v2-flow.ts --no-cache`、`eval/long-context-summaries.ts --force`，都走 `claude -p --model haiku`）。

**0.2.2（按 AA 基准校正）之后仍然没有数据的：** 往上取一档（0.3）、各个下限只和 0.2.1 的规则各比了一次（见「按 AA 基准校正」的「评测迭代」），没有扫这些值；派出 agent 的模型文字是对着这 100 题调的，没有在没见过的请求上量；各种类的 state 预算（6000 和 24000）没有量延迟和准确率；报告开始的轮次（agent 交回的结果、任务通知）用的那一题没有专门的评测集，题和发消息时的相同，它们的 `user_message` 是报告文字而不是你的话，决策模型对这样的输入判得准不准没有数据。

**按用户的决定（2026-10-05），#17 不再跑任何对比或扫描评测。** 下面列的事大多仍然没有数据；#17 只做了不花钱的收尾（按决策模型取默认值、`skillsMinRelevance` 改成 0.75、文档）。#17 各验收项的状态：

- 上下文范围扫描（最近 2、4、8、16 步 × 1k、2k、4k、8k token）：没有做。现有评测集的上下文太短，扫描几乎测不出差别（16 格 × 4 套的 13,088 个请求里只有 1,226 个不同），要做就得先补长上下文的题，补充集也按用户的决定取消了。#17 时默认值保持原样；0.2.1 起 Jev 的三项默认值按 Jev 的上限取，不是按这个扫描挑的（见「Jev 的上下文默认值怎么算」，更多上下文是否让判断更准没有数据）。
- 按决策模型取默认值、写回 mod 的配置：已做（见「配置」里「按决策模型取的默认值」）。
- 置信度门槛按语言分别校准：没有做。
- 问题用英文还是中文写：**已改，只改了一个问题。** 用户在现在的问法（代码基点 9ec9c42）上跑了一次 effort-submit 的对比（`results/effort-submit/2026-10-05-jev-ac4-question-language.json`，Jev，`zh-score` 和 `en-score` 各 1 次，400 个请求，0.0126 美元）：用中文问，中文题 85.0%、英文题 89.0%（差距 −4.0）；用英文问，79.0%、78.0%（差距 +1.0）；两种问法的 p50 都是 282 ms，没有迟到或重试的回答。这次的请求和 2026-10-04 的 3 次运行逐字相同，那 3 次里中文问法也都高约 8 个百分点，方向一致。按事先说好的规则（中文问法领先 3 个百分点以上就改），Jev 在发消息时判断 effort 的那一个问题改用中文（`core/setup.ts` 的 `BACKEND_DEFAULTS` 里的 `ask.turnStart`，当时叫 `turnStartLanguage`，不是配置项）。只改这一个，因为其余问题（中途重判、派出 agent、Workflow、卡住时的强制升档、skill 和 `find_skill`）在现在的问法上都没有中文问法的数据：一轮中途的两种语言在旧问法上持平，派出 agent 和 skill 当时没有中文变体（之后加上了 `models-hint-zh` 和 `profiles-zh`，见「开发」里「评测」的这两节，还没有运行）。同一个请求里，中文的 effort 问题和英文的 skill 问题混在一起，这种情况没有测过：effort-submit 只单问 effort。
- 中文准确率比英文低多少算通过：**门槛改成 4 个百分点**（用户 2026-10-05 的决定；原来的 spec 写的是 3 个百分点）：中文比英文低不超过 4 个百分点就算通过，正好低 4.0 也通过（`eval/lib/metrics.ts` 的 `MAX_GAP`、`passes`）。发布的配置（Jev，effort 用中文问）在 effort-submit 上那一次的差距是 −4.0，按新门槛通过；同样的请求在 2026-10-04 的 3 次运行里是 0、0、−1；而中文题的准确率比用英文问时高 6 个百分点（85 对 79）。其余几套都是改措辞之前的问法上的离线数据：一轮中途 `en-score` −1 和 +3，派出 agent `models-hint` +2 到 +3（中文高），skill 带画像时在 `skillsMinRelevance` 0.75 下 −1.8 和 −2.8，按新门槛都通过（0.7 下的 −3.7 也通过）。`en-choice` 的 −3.0 按新门槛也通过。已存结果的 `pass` 都按新门槛离线重算过（`eval/resummarize.ts`）。
- 需要真实密钥、会产生少量费用：问题语言的对比 0.0126 美元。

**问题的文字一改，评测就要重跑。** 发给决策模型的问题、指令和选项描述（`hooks/decision/` 里的那些文字）是被测的对象：改了哪一处，用到它的评测都要重跑，旧结果只能对照，不能当成新问法的数字。结果文件记着每个变体当时问的问题（`questions`）和代码的哈希（`code`），和现在的对不上，就是过期的结果。第 1 轮审查改了下面这些；按用户的决定，修复之后没有重跑，「开发」里「评测」一节的数字都是修复之前的问法测得的，只能当预览：

- `effort-midturn`（0.9.0 随中途重判删了）：每个调用的那一行改成 mod 的写法（不再带评测集里「结果如何」的部分），`trouble` 变体改用 #7 的 `stuckRequest`（多了「是不是预期内」一题）；所有变体都变了，新加了 `raw-results` 作对照。
- `subagent`：effort 问题里的「子 agent」「subagent」改成「派出的 agent」「dispatched agent」；点名 effort 一题不再被英文里随口说的 think、reason 触发；Workflow 的题按 #8 的方式合并提问，新加了 `models-hint-single`。
- `skill`：第一段拆成两题（`skills.which` 只问主 agent 能加载的，`skills.hint` 只问只能由你触发的），第二段的短名单两类分开取。
- `effort-submit`：请求没变（2026-10-05 的问题语言对比就是在现在的代码上跑的，请求和 2026-10-04 的逐字相同）。通过与否的规则先改成中文比英文低不到 3 个百分点，2026-10-05 又按用户的决定改成低不超过 4 个百分点（正好 4.0 也通过）；已存结果的 `pass` 已按 4 个百分点重算。线上的问法从 2026-10-05 起是 Jev 用 `zh-score`（`modVariant`），0.9.0 起是 `en-score`，题也换了（ADR 0014）。

还没有数据的事（#17 按用户的决定没有再测；要不要开后续票由用户决定）：

- **失败时升模型的门槛（#7）。** `escalateAfter`、`escalateLimit` 和 `escalateHaikuTo` 的默认值都是起点，没有评测方法，按使用体验调。0.8.x 到了门槛还问决策模型「这些失败是不是预期内的」（`thetaExpected`，默认值来自 11 个手写场景的小实验），0.9.0 不再问（ADR 0013）。主 agent 每轮记下的事实（`facts`）0.9.0 起进下一条消息的 state（`last_turn`），规则 R4 读它（ADR 0014）；准不准还没有数据。
- **state 的预算按发出去的样子数（#17）。** `contextTokens` 约束的是发出去的整个 state，按它序列化成 JSON 的样子数（字段名、引号和转义都算，`decision/context.ts` 的 `withinTokens`；发消息时、`find_skill`、派出 agent、Workflow 的请求都这样拼）。不靠字段的顺序：决策模型读过长的 state 时可能只读开头。
- **派出 agent 的门槛（#15 的数据）。** `agentOverride` 的默认值在两次 Jev 运行里都不是最好：0.4–0.5 时整题中文 +3、英文 +2 个百分点；点名的门槛 0.5 偏低，英文里只是被提到的模型以 0.5–0.6 被当成点名；（0.8.x 时 `thetaMax` 取 0.3 比默认值好 1–2 个百分点，0.9.0 删了 `thetaMax`）。数字见 `eval/results/subagent/` 各变体的 `breakdown.sweeps`，逐题的原始回答也在里面，可以按语言分别重扫（见「开发」里的「派出 agent（subagent，#15）」）。#17 没有改这几个门槛（用户的决定）。
- **Jev 同时答几个长请求、账号能突发多少（ADR 0009）。** 一起启动的 agent 已经合进一个请求（2026-10-15，原来这一条是「Workflow agent 启动时当场判断的排队（#9）」）。关于 agent 的请求同时在途 4 个（`agentLanes`），依据是同一天的一次实测（「Jev 的限速」：4 个 11.5 万 token 的长请求同时发，和单发一样快，没有 429）；5 个以上、以及 1.13 上像是依次处理的短请求在 1.14 上怎样，没有量。TypeSafe 没写限额怎么计，`BURST_SECONDS`（5 秒，默认套餐 50 万 token）是猜的，只知道一次 45 万没有被限；要量就得故意打到 429（同一个 key 同时发 5、6、8 个满请求各一遍，看第几个开始 429、`Retry-After` 写多少），会花钱、也会让同一个 key 的其他会话被限速，没有做。另外：一次 fan-out 超过 8 个 agent 分几组，常见的 fan-out（十几个）有多少能在 `agents.waitMs`（6000）之内答上，没有量过；同一条消息的 Agent 调用 `agent.spawn` 是一起触发的（#6 实测），但它们要等 300 毫秒合组这件事，没有在真实会话里看过 debug log。
- **skill 推荐的门槛和准确率（#16）。** 0.9.0 起照 TypeSafe 的 skill 推荐 cookbook 做（ADR 0018），问题、门槛都是官方的，没有在这套评测集上评测，评测代码只保证能编译；下面是之前的记录。#11 的起点：用 mod 自己的排序代码（`skillsRequest` + `modRanker`）和真实的 Jev（jev-1.13.0），在本机 87 个 skill（66 个主 agent 能加载、21 个只能由用户触发）上问了 21 条消息：18 条中文（10 条该推荐 skill、8 条不该），3 条 find_skill 式的英文查询（2 条有对应的 skill）。先不带画像：该推荐的 skill 在第二段的相关度是 0.81–0.98（最低的是 `pr` 0.81）；不该推荐的消息里进入第二段的 skill 是 0.07–0.66（两次重命名都给了 `implement`，0.49 和 0.66），另有两个可争议的 0.80 左右（「这个函数为什么返回 undefined」的 `diagnosing-bugs`，「解释一下这个正则」里只能由用户触发的 `teach` 0.79）。所以 `skillsMinRelevance` 取两组之间的 0.7，`findSkillMinRelevance` 取 0.5（主 agent 主动问时宁多勿漏，它自己会看描述）。给 3 个 skill 写了画像后再问一遍：该推荐的照旧（`code-review` 0.96、`codebase-design` 0.96、`diagnosing-bugs` 0.94），`diagnosing-bugs` 对「为什么返回 undefined」降到 0.53（它的画像写了「不用于简单问题」）。第一段的分布：该推荐的 skill 都分到 0.34 以上（多数 0.96–1.00），不需要 skill 的消息里分给 skill 的最多 0.10，所以第二段只补读分到 0.1 以上的（`SHORTLIST_FLOOR`），多数普通消息只发一个请求。#16 的评测（109 题 × 中英 × 有画像和没有画像，真实的 Jev 跑了两次，见「开发」里「评测」的「skill 匹配」）：线上的有画像时中文 79.8%、英文 83.5%，两次都差 3.7 个百分点，没过当时 3 个百分点的门槛，在现在 4 个百分点的门槛之内（没有画像时 −1.8 和 −0.9）；`skillsMinRelevance` 在 0.3–0.8 之间很平，按语言建议中文 0.75、英文 0.8，共用一个值时 0.75（差距缩到 −2.3）；`findSkillMinRelevance` 建议中文 0.3、英文 0.5（共用时保持 0.5）。评测集里九成以上的消息都过了 0.1 这个下限、发了第二段（不该推荐的题多是诱导题）。#17 按这些数据把 `skillsMinRelevance` 的默认值改成 0.75（修复之前的问法上的预览，没有在新问法上重跑），`findSkillMinRelevance` 保持 0.5。按用户的决定没有再评测的：`skillsShortlist` 和 0.1 这个下限（决定第二段问什么，只能重新请求）；第一段拆成两题之后（第 1 轮审查：只能由用户触发的 skill 单独一题，不再挤掉能加载的 skill，033、090、091、092）两个变体都要重跑；问题用中文写；画像只用英文；Choice 选项顺序的影响（Jev 偏向排在前面的选项）。
- **主 agent 会不会主动用 `find_skill`。** 列表换成提示之后，主 agent 在推荐漏掉时并不会自己去查：一条要写 PR 描述、但没有推荐 `pr` 的消息，有提示、没有提示、加上「何时用」的更主动写法各 3 次，都直接写了正文；读到完整列表时第一步就加载了 `pr`（见「开发」里的「已实测的引擎行为」）。这类消息目前靠发消息时的推荐。还要评测：换别的场景（文件格式、某个服务的工具、一轮中途才出现的需要）和别的模型，以及「每轮先查」这类更强的写法值不值得它多出的 ToolSearch 加 `find_skill` 两步。
- **skill 请求的大小和延迟。** 不带画像时第一段约 6.4k input token（87 个选项），真实引擎里 0.3–0.6 秒；每份画像约多 110 token（实测 3 份画像多出 330–380 token），全部写好后估计 16k 左右，在 Jev「state + 最长的问题 ≤ 32k」之内；`questionBudget` 再按估算值留了余量（估算比 Jev 报的少约 10%，按 1.35 倍留），超出时先去掉「何时不用」，再从后往前改回描述。第二段约 0.5–1.5k token、0.25–0.5 秒。`-p` 进程启动时的第一个请求有一次用了 1.7 秒（#10 实测，进程启动时其他工作同时在跑），超时后照常放行。#16 实测（111 个 skill，Jev 计）：不带画像时第一段 8.6k input token，带全部画像 2.19 万（`questionBudget` 没有裁剪），第二段约 1.3k。Jev 第一段 p50 0.32–0.34 秒（不带画像）、0.56–0.67 秒（带画像）；慢的时段带画像的 p90 到 1.65 秒，218 条里 24 条第一段就超过 1500 ms：这条消息的决策请求整个超时，effort 也没有经过路由。把第一段单独发、只留英文字段的裁剪画像都没有评测（用户的决定）。
- **背景（对话、脚本）让 agent 判得多准（ADR 0007）。** 0.4.3 起选 pplx 时、2026-10-15 起选 Jev 时也是，派出 agent 和 Workflow 的请求带着对话和脚本（`agentBackground`），这是按「给得越多判得越准」加的，没有评测：`subagent` 评测集的题只有任务和你的话，评测发的请求不带背景（评测和 mod 的请求逐字相同的核对，是在 mod 不带背景的情形下做的）。要量就得给题补上派出它的那段对话和脚本（有干扰的、带着决定性信息的），和不带背景的同一批题比较。
- **一个请求里放几个 Workflow 调用，准确率会不会降（#8）。** 一个脚本的几个 `agent()` 共用一个请求（最多 8 个，各自的 brief 放在 state 里），对每个问题来说，其他调用的 brief 是无关内容，TypeSafe 的指南说这会降低准确率。实际降不降、降多少，要拿同一批调用，一个请求一个调用和现在的分批各问一遍来比；差距明显就把 `decision/workflow.ts` 的 `MAX_PER_REQUEST` 调小。`subagent` 评测现在就这样问（`models-hint` 按 #8 合并，`models-hint-single` 一个调用一个请求，见「开发」里的「派出 agent（subagent，#15）」），还没有跑过（#17 按用户的决定没有跑）。

---

## 开发

这一节是后续每张票的实现说明，包括结构、扩展方式、测试写法，以及已经实测过的引擎行为。通用规则（mod 的结构、命令、编写约束）见仓库根目录的 CLAUDE.md，这里只写本 mod 自己的约定。设计理由见 `docs/adr/0003-dispatch-pilot-core-innermost-plan-table.md`。

### 命令（在仓库根目录执行）

```bash
command claude plugin test ./dispatch-pilot               # 接缝 1 的测试，不联网，不需要 key
command claude plugin validate ./dispatch-pilot --strict
tsc -p ./dispatch-pilot                                   # 需要先用 --plugin-dir 加载一次，生成 .claude-plugin/types/；只查 hooks、types、tests（eval/ 和 scripts/ 不在内，靠测试和 node --check）
claude --plugin-dir ./dispatch-pilot --settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}'
TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' [--zh | --en] [--choice]   # 用 Node 调一次真实的 Jev；问题默认用 mod 对这个决策模型的写法（Jev 中文）
TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-agent.ts --file <subagent.jsonl> --id subagent-011 [--lang en] [--zh] [--work] [--noul] [--fable]   # 一个派出 agent 的判断（Jev），请求与 mod 发出的相同
node dispatch-pilot/eval/validate.ts                      # 校验评测集（接缝 2，见下文「评测」），再核对 README 的配置表和 plugin.json、BACKEND_DEFAULTS 一致（#18）
node dispatch-pilot/eval/validate.ts docs                 # 只核对文档：README 的配置表、README 里 `/dp` 开关的列表（和代码里 defineSwitch 登记的一致，新加开关要写进「功能的开关是」那句）、「结构」树、一个写者
node dispatch-pilot/eval/run.ts effort-submit --estimate  # 估算请求数、token 和费用，不发请求
node dispatch-pilot/eval/run.ts effort-submit --label <名字>   # 用真实 Jev 跑一次评测，结果存进 eval/results/
node dispatch-pilot/eval/run.ts subagent --label <名字>   # 派出 agent 的模型和 effort（#15）：三个变体 × 中英，600 个请求，Jev 约 0.07 美元（估算，题比 0.8.x 多，按 token 算会更贵一些）；--variants nouls 只跑 mod 的问法（选 Jev 时 mod 的问法），200 个请求，约 0.03 美元
node dispatch-pilot/eval/run.ts eval-v2 --model jev-1.14.0 --long-context --state-tokens 180000 --state-messages 5000 --variants zh-score --label <名字>   # Jev 的长上下文（请求头 TypeSafe-Danger-Zone-Long-Context）：整段对话都进 state，120 个请求约 0.73 美元（见「Jev 1.14」）
node dispatch-pilot/eval/run.ts skill --estimate          # skill 匹配（#16）：一个变体（cookbook，ADR 0018）× 中英，第二段按每条消息都发、短名单排满估算
node dispatch-pilot/eval/run.ts skill --label <名字>      # 用真实 Jev 跑 skill 匹配，两段请求都发
node dispatch-pilot/eval/run.ts visual-check --estimate    # 看图核对（#65）：24 题 × 2 个变体，图按像素算 token（`lib/estimate.ts`），不按 base64 的长度；约 64 个请求、0.014 美元
node dispatch-pilot/eval/run.ts visual-check --max-usd 0.10 --label <名字>   # 用真实 Jev 跑看图核对；估算超过 --max-usd 就一个请求也不发
node dispatch-pilot/eval/run.ts visual-check --ids anim-linear,anim-ease_out,anim-spring,anim-janky,anim-wrong_end --variants mod --repeat 3 --model jev-1.14.0 --max-usd 0.05 --label anim-target   # 只跑指定的题（--ids）、每题问 N 遍看稳不稳（--repeat N，估算和花费都乘 N）：结果文件里每遍一行（answers 的 repeat），summary 是第一遍的，其余在 repeatSummaries
node dispatch-pilot/eval/eval-v2-flow.ts --backend jev [--state-tokens N --state-messages 2000] [--estimate]   # eval v2 的真实流程（#45）：逐条用户消息判三选一、累计次数、Haiku 续写摘要，一个后端加预算一个文件（默认不带 --state-tokens 时用后端的发消息预算和 contextMessages 2000），中断后再跑同一条命令接着跑
node dispatch-pilot/eval/run.ts eval-v2 --variants zh-flow,en-flow --flow <流程文件> --label <名字>   # eval v2（#45）：最后一条消息的 effort 和三选一；zh-score/en-score 不带流程，zh-flow/en-flow 带流程文件里的次数和摘要；zh-score-alone/en-score-alone 只问 effort 题（unresolved 开关关着、也就是默认装好时 mod 发的请求），三选一一项记 null。不写 --variants 时这两个也跑，花费跟着多出它们的那份；量线上默认请求只写 --variants zh-score-alone
node dispatch-pilot/eval/apply-review.ts effort-submit --from <审核记录.jsonl>  # 应用用户的审核决定，再校验
node dispatch-pilot/eval/compare.ts <结果 a.json> <结果 b.json>                # 两次运行逐项对照，不发请求
node dispatch-pilot/eval/resummarize.ts [--dry-run] [<结果.json> ...]          # 按存着的逐题答案重算汇总里的门槛和 inTime（指标改了时），不发请求
node dispatch-pilot/eval/rescore.ts [--markdown] [<结果.json> ...]                # 按存着的各档概率，用 0.2.1 的规则和现在的规则各选一次档，对照 gold，不发请求、不改文件
node dispatch-pilot/eval/rescore-visual-check.ts [--write <文件>] [<结果.json> ...]  # 看图核对：按存着的概率，用旧门槛（0.9 / 0.2）和现在的门槛各判一遍，分界面、海面、动画列误判和没把握，不发请求、不改结果文件
```

`scripts/decide*.ts`（始终 Jev，`scriptDecision` 写死）和 `eval/run.ts`（`--backend` 选）的设置都经 `readConfig` 读出：manifest 的默认值，加上所选决策模型的默认值（`core/setup.ts` 的 `BACKEND_DEFAULTS`）。`--timeout` 是一次请求最多等多久，脚本和 `run.ts` 用同一条规则（`eval/lib/runner.ts` 的 `attemptMs`）：默认是 mod 的 `timeoutMs` 的 4 倍、至少 10 秒，免得冷连接的第一次请求就超时；评测里慢的回答照样量得到，超过 mod 会等的时间的另外统计。两个脚本共用 `eval/node.ts` 的 `scriptArgs`（用 `node:util` 的 `parseArgs` 读参数，不认识的参数直接报错）和 `scriptDecision`（设置、后端和凭证），`--timeout` 经 `scriptTimeout` 严格读成数字。`decide-agent.ts` 按 `ask.agent` 问派出 agent（Jev 中文，和 mod 一样；以前误用 `ask.other`，Jev 因此默认发英文），`decide.ts` 的 state 取发消息时 effort 请求的上限（`messageLimits(settings, false)`，Jev 96000），不再取 skill 共用的 6000。

凭证放在环境变量里，脚本不会打印它们。把它们存在 `~/.config/dispatch-pilot/eval.env` 时，可以用 Node 自带的 `node --env-file=<那个文件> dispatch-pilot/scripts/decide.ts ...` 载入，不必先在 shell 里 source。

mod 根目录的 `tsconfig.json` 是手写的。它继承生成的配置，并加上 `allowImportingTsExtensions`，因为相对导入都带 `.ts` 后缀（Node 直接运行也需要这样写）。Claude Code 发现已有 tsconfig.json 时不会覆盖它。

用 `claude -p` 在真实引擎里跑时，要带 `--strict-mcp-config` 和 `--settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}'`（jev-pilot 不停用会和本 mod 抢 effort），并且不配密钥；`claude -p "/dp"` 这样把斜杠命令当整个 prompt 的运行在本地完成，不调用模型，也不发决策请求。

**发版（#18）。** 递增 `.claude-plugin/plugin.json` 的 `version`；marketplace 条目不写版本，两处不会不一致。不升 `version` 就推新的提交，从 GitHub 装的用户拿不到：`claude plugin update` 和自动更新都先算出版本（plugin.json 的 `version` 优先，其次 marketplace 条目的，两处都没写才用提交的 SHA），和 `installed_plugins.json` 记的相同就不换缓存里的副本（Claude Code 文档 plugins/loading 的「Versions and updates」），重新运行 `plugin install` 也只会报已经装过。从本地目录添加 marketplace 的用户不受影响：mod 从那个目录原地加载，不看 `version`（见「已实测的引擎行为（2.1.289）」里「从 marketplace 安装」那一条）。开发时不用安装，用 `--plugin-dir` 加载（上面的命令），保存就热重载。`claude plugin tag ./dispatch-pilot` 会建 `dispatch-pilot--v<version>` 的 git tag，并核对 plugin.json 和 marketplace 条目一致（`--dry-run` 只打印，不建）。0.2.0 还没有打 tag：按用户的决定，只推送分支，不合并 main，也不打 tag（`--dry-run` 核对过 plugin.json 和 marketplace 条目一致，会建的 tag 是 `dispatch-pilot--v0.2.0`）。0.3.0（看板、依据面板、中文界面）已经升了版本号；发布本身（推送、合并 main、打 tag `dispatch-pilot--v0.3.0`、从 marketplace 装一遍并端到端走一遍）等用户批准之后再做，还没有做。

### 结构

```
hooks/
├── dispatch-pilot.ts       入口，只负责组装：先按顺序注册各项功能，最后注册核心
├── features/               每项功能一个文件，导出 register<X>(on, ctx)
│   ├── control.ts          /dp 命令：开关、锁定 effort、最近的决策；记录 session.measure 的读数（#13）
│   ├── dispatched-agents.ts  派出 agent 时判断它的模型和 effort（#6）
│   ├── escalation.ts       失败计数（#7，ADR 0013）：派出 agent 的失败到 `escalateAfter` 时从下一步起升一档模型（写进它的计划，同一步一起失败的几个调用只升一次）；主 agent 这一轮结束时把事实写进它的一轮记录（`facts`），也存进 `$.state` 的 `lastTurn`（下一条消息的 `last_turn` 和规则 R4 读它）；Workflow agent 的任务按它的 `agent-<id>.jsonl` 找，只用来在日志里写是哪个 agent
│   ├── find-skill.ts       主 agent 的 find_skill 工具：会话开始时注册，被调用时按查询给 skill 排序（#12）
│   ├── image-routing.ts    带图路由（#63、#64，ADR 0008、0013）：开关 `image-routing`（默认关）；`session.append`（door 为 prompt）记下用户贴的图，`turn.start` 读出复杂度读数、再发 effort 题、写成待用的决定由核心认领；一轮进行中输入的带图消息不读图（0.9.0，ADR 0014）；导出 `IMAGE_ROUTING_SWITCH`、`hasImage`
│   ├── main-effort.ts      发消息时判断主 agent 的 effort（#2，ADR 0014）：effort part（effort 题加是非题）放进投票箱，回答动未解决次数、按 decision/message-effort.ts 的规则定档、记下长期约束
│   ├── prompt-hint.ts      提示框里草稿后面的灰字提示（`virtualText`，2.1.300 起）：`prompt.edit` 每次编辑带上，`prompt.change`（翻历史）时把同一段草稿带着提示重新放回去；开关 `prompt-hint`
│   ├── reference-hint.ts   `sessionReading(readings, debug)`：派出 agent、Workflow 批和当场判断取本会话最近一次的复杂度读数（#64）
│   ├── unresolved.ts       问题摘要的开关 `/dp summary`（默认开）；`session.end` 清掉次数、摘要、长期约束和上一轮的情况（#39，ADR 0014）；每轮结束后在后台写问题摘要、热重载丢掉的写的善后（#40）；题和读回答在 main-effort.ts：它们挂在 effort 那一份投票箱里
│   ├── skills.ts           对主 agent 隐藏 skill 列表、换成一句提示，发消息时推荐 skill（#10）
│   ├── visual-check.ts     agent 的 visual_check 工具（看图核对，#57，ADR 0008）：会话开始时注册（有图像后端才注册），被调用时读图、发一个带图请求、按 0.8 / 0.2（录屏 0.8 / 0.4）判定、回答 Messages API 块；流程分阶段，放大复核（#59）、抽帧（#60）、汇报（#58）接在各自留好的位置
│   ├── screenshot-takeover.ts  截图接管（#62，ADR 0008）：开关 `screenshot-takeover`（默认关）；`tool.call` 在 `next` 之后，把 Read 读到的、本循环里新生成的图片文件和 MCP 工具结果里的 image 块换成一段英文说明（Read 的换成文本形态的结果，MCP 的先用 `base64 -D -o` 存成临时文件）；每次接管汇报一条 aside 日志加一次计数
│   ├── visual-check-look.ts  visual_check 的 `look: true`：把图原样（限在 agent 看得清的大小内）交回，录屏交回它的帧；不问决策模型。也放回答用的块类型和 `imageBlock`
│   ├── visual-check-series.ts  visual_check 的档位序列（#61）：`checkSeries` 读各档、对相邻两档做放大复核、汇报、回答
│   ├── workflow-agents.ts  提交 Workflow 时判断脚本里每个 agent() 的模型和 effort，写进脚本或退回（#8）
│   └── workflow-labels.ts  脚本写不进去的 Workflow：运行开始时判断各调用，agent 派出时按 label 设模型、写计划表；Workflow 工具描述里的常驻提示（#9）
├── board/                  看板的画面（ADR 0004）：只画「决定汇报」的数据，功能不碰
│   ├── screens.tsx         三个 ui.render hook：prompt 上方的 band（AbovePrompt）、脚部右端的摘要（SessionMode）和依据面板（Pane，requestId dp-rationale）；按 e.surface 取标记（终端 Raster，别的端 Svg；面板的日志在别的端开窗口，#31），别的端的 band 有自己的折叠（$.state 的 bandFolded）；数字键选中 agent（$.state 的 selected）并打开依据面板；registerStatus：不带终端的会话里状态行的 hook（ADR 0011）
│   ├── status-line.ts      状态行该写什么（纯的模块状态）：会话用不用它（没有终端也没有 Desktop 时用）、band 的一行、prompt 提示，提示优先；screens.tsx 和 features/prompt-hint.ts 照它调 $.ui.status。Desktop 上 band 的空闲行要不要接 prompt 提示（bandHintUsed、bandHintIs）
│   ├── view.ts             从看板数据算出画面要的东西（ScreenView）：哪一轮、按开始先后排的 agent 行、事件流、一轮结束后的一行；关掉的功能不出现；band 和面板共用的读法也在这里：功能的叫法（`FEATURE_WORDS`）、条目的功能（`featureOf`）和档位（`levelOf`）
│   ├── band.tsx            band：状态条、每个 agent 一行（数字键、名字、模型标签、effort 标签、状态符号、时间色带、状态格）、事件流；空闲一行；不到 4 行或折起时一行摘要；状态行的那一行文字（statusText）。非终端端：「依据」按钮代替提示，名字不带数字键，effort 写成字，草稿的 prompt 提示占空闲行
│   ├── footer.tsx          终端的脚部摘要：状态符号、主 agent 的模型·effort、+N，最多 12 列
│   ├── rationale.ts        依据面板看到的东西（纯函数）：选中的 agent 和它的决定（cardOf）、规则推演每一步的说法（stepLines，只读存下的步骤，不重算）、按轮分组的日志和折叠键（logGroups）；面板的 id（每项功能的开关字「开」「关」和整个 mod 关着时的「Dispatch Pilot 已关…」那一行，直接写在 `pane.tsx` 里）
│   ├── reference.ts        卡片上「参考图」一行的中文（#63）：复杂度读数的档位、说明、来自几张图；只把存下的读数说成人话
│   ├── pane.tsx            终端的依据面板：顶部灰字（每项功能的开关状态、锁定）、‹ 上一个 (p) / 下一个 › (n)、看它的对话 (x)（`$.ui.view`，派出 agent 才有；主视图是某个 agent 时变成 ↩ 回主对话）、圆角的依据卡片、按轮分组的决策日志；悬挂缩进，不截断
│   ├── pane-app.tsx        其他端（Desktop、VS Code、手机）的依据面板：一排 agent 标签（选中的是 primary）、看它的对话（引擎 ≥2.1.300 才画）和「关闭」；卡片用 pane.tsx 的 `cardRows` 的 `app` 样式（大一号的名字、没有 ├ └ 的规则清单、份额写在概率条下一行）；日志按轮点标题折叠，每条一行，其余（概率、skill、理由）用 hover 的 `scope` 在指着时显出；最下面折起的「功能开关」：每个开关一个按钮、effort 锁定的 Select，按下就改，和 `/dp` 一样存进 `$.store`（`keepSwitch`）
│   └── kit.tsx             视觉语言：色板（含状态格的 `STATUS_COLOR`）、effort 色阶、模型标签、单元格宽度、标记（`Marks`：时间色带、概率条和置信条，终端是 Raster 的格子，别的端是 SVG）；band、脚部和面板共用的 `readout`（模型·effort）、`skillsText`、`pctText`
├── core/                   各功能共用的机制，不含具体功能
│   ├── core.ts             核心的 hook：发消息时的决策请求、一轮的开始、每一步的写入、认出 settings hook 拦下的调用、记下用户运行的命令
│   ├── ballot.ts           一条消息的「投票箱」：各功能放进问题，由核心一次发出
│   ├── report.ts           「决定汇报」module（ADR 0004）：两个入口，report（记一条决定：决定、计数、开关、面板没放出来，按种类打标签）和 reportStep（记一步读数），看板数据（`board`）、决策日志（`decisionLog`）和 toast 的唯一写入者；自带 turn.start、agent.spawn、turn.complete 三个只看不改的 hook，记轮数和各个 agent 的开始、排队、结束；skill 画像的事件、状态和决定日志条目在 profile-report.ts，Workflow 的两个功能交来的东西在 workflow-report.ts；另外导出 `decisionLine`、`callNodeId`、`callWorkflowOf`、`unplacedText` 和各种数据的类型
│   ├── workflow-report.ts  Workflow 的两个功能（workflow-agents、workflow-labels）交给 report.ts 的东西：每个 agent() 调用一份报告（`callReports`）、整个 Workflow 没走路由的说明（`workflowLeft`）、没读全脚本时 Workflow 的名字
│   ├── plans.ts            计划表的类型和纯函数（planStep 决定每一步发出什么）；`MAIN`（主 agent 的 id `main`）；`Cell` 是 `decision/backend.ts` 的 `StateCell` 的别名，读改写用的 `update`、`replace` 也在这里（二十多个文件在用）
│   ├── outcomes.ts         哪些工具调用被 settings hook 拦下（核心的 classic.PreToolUse 记，#7 读）
│   ├── commands.ts         命令轮（#19）：command.run 记下的命令和随后提交的 prompt 对上，命令在决策请求里的说明，从引擎的命令消息读回输入的命令
│   ├── prompts.ts          isPersonsMessage：判断哪些 prompt 是用户本人的新消息
│   ├── visual-check-report.ts  看图核对的汇报（#58）：一次调用的 aside 决定、增量的计数、失败的 note（`reportCall`）
│   ├── takeover-report.ts  截图接管的汇报（#62）：每张被接管的图一条 aside 决定（路径、尺寸），加一次 `takeovers` 计数（`reportTakeover`）
│   ├── loop-start.ts       循环从什么时候算起（#62，#64 共用）：主 agent 的 `turn.start`、派出 agent 的 `agent.spawn` 记进 `$.state` 的 `loops`（不是功能，没有开关）；`isFromLoop` / `startedBefore` 按文件修改时间分「本循环里生成的」和「更早就有的」
│   ├── work-files.ts       mod 的临时目录（#62）：`$TMPDIR/dispatch-pilot/<会话 id>/`，每个会话一个子目录；`newWorkFile(io, 扩展名)` 给出新文件的路径（缩过的图、抽出的帧、接管存下的截图都放这里）
│   ├── call-budget.ts      一次看图核对调用里各请求共用的等待预算（ADR 0007）：`callBudget(now)` 的 `run(上限, 请求, 没发时的结果)` 把每个请求的上限取成 `min(上限, 剩余)`，剩余太少就不发
│   ├── image-crops.ts      裁图并放大（#59）：`cropImage` 用两次 sips 把图的一块裁下来放大到长边 1000 px，读成 base64
│   ├── zoom-review.ts      放大复核（#59）：`zoomReview`（裁图、请求二、判定）、`comparePair`（对任意一对图，#61 用）
│   ├── quality-series.ts   档位序列（#61）：`compareLevels` 对相邻两档调 `comparePair`，按 `pairWaves` 分批发
│   ├── image-files.ts      读图规整（#57，凡是要给决策模型图的功能都用它）：经 `ImageFilesIo` 的三个闭包用 sips 查尺寸、缩放、转格式、转正方向，读成 base64（`loadImage`、`loadImages`；`asArgument`、`failedRun` 也导出给 `image-crops.ts`）；不在 CLI 时按文件头判断
│   ├── complexity.ts       参考图的复杂度读数和读数的存取（#63，ADR 0008）：`readReferenceComplexity(io, sources)`（一组图：规整、按内容 hash 认组、同一组只问一次、读数存在 `$.state` 的 `referenceReadings`）和 `latestReading`（取最近一组的读数）；凡是要用读数的功能（#64 的轮中贴图、派出 agent、Workflow）都经这里，读数的存取只在这里；经 `ComplexityIo` 的闭包用 `$`
│   ├── ask-group.ts        投票箱里的几组 part 各一次请求（从 core.ts 提出来，`askGroups`）：拼请求、一起发出、共用一个等待（其中一个带长上下文请求头时都等 `longWaitMs`）、记 debug 行、把回答分给各 part；发消息时核心用它，带图的消息在 `turn.start` 里 image-routing 也用它，发出去的和记下的是同一份；一个 part 的 `settle` 抛错时记 debug log、这个 part 不给 context 块，别的 part 不受影响
│   ├── agent-lane.ts       关于 agent 的请求（ADR 0009）：一起派出、一起启动的 agent 合进一个请求（`askAgent`，按来源分组，最多 4 个，组里每个成员的输入都到了、同一条消息的 Agent 调用都到了或等满 300 毫秒才发），同时在途的请求最多 `agents.lanes` 个（Jev 4，pplx 5），等车道时新到的并进还没发的组；Workflow 提交和启动时拼好的成批请求也走这里（`askInLane`）
│   ├── deferred.ts         带图的消息要等读数的 effort 那一份（#63）：main-effort 交到这里（一个从读数到 part 的函数），image-routing 在 `turn.start` 取走（只有开始一轮的消息；一轮进行中输入的 0.9.0 起不等，ADR 0014）
│   ├── video-frames.ts     录屏抽帧（#60）：`readRecording` 经 `ImageFilesIo` 调 ffmpeg 查长度、在时间段内逐帧取成 JPEG，再交 `loadImages` 规整；失败回一句原因，从不抛
│   ├── unresolved.ts       未解决次数（#39）和问题摘要（#40）的唯一写入者（moveCount、clearCount、queueSummary、landSummary 等）、「决定」的字句（含摘要没写成的）和 `UnresolvedRecord`（卡片画的记录）
│   ├── skills.ts           skill 目录：loadCatalog（经闭包读命令、引擎的 skill 清单、settings、磁盘，找到每个 skill 的文件）；读和裁剪 skill 列表（#10）；rankingSettings、describeStages（#11）
│   ├── switches.ts         开关：总开关和各功能的开关，defineSwitch 登记、isOn 判断；isShown：一项功能拥有的看板部分（parts）此刻画不画
│   └── setup.ts            把 userConfig 读成 ctx：每个选项的范围和缺省值只在这里（Config），以及决策后端
└── decision/               决策请求模块：纯模块，不依赖 $，Node 可以直接 import（#4 的评测会用）
    ├── system-one.ts       System One 请求和回答的类型；mergeParts、answersFor
    ├── effort.ts           effort 问题（英文或中文 × Score 或 Choice）、出错代价和原因未知的是非题、读回答、基础档（位置四舍五入加双峰，`traceEffort`，ADR 0014）
    ├── message-effort.ts   发消息时的定档规则（ADR 0014，eval 共用）：`messageSignals`（从是非题的回答和会话记下的事读信号）、`decideMessage`（基础档、R1–R5、锁定，每一步进 trace）、`namesUltrathink`
    ├── nouls.ts            是非题的读法：按决策模型的指南（`guides.ts`）定的线读 `verdictOf`、`isYes`、`readNoul`；`NOUL_YES`、`NOUL_NO` 是 TypeSafe 的 0.7 / 0.3
    ├── guides.ts           各决策模型的读法，只写在这里（ADR 0014、ADR 0017）：TypeSafe 的（Jev、pplx：是非题 ≥ 0.7 / ≤ 0.3，effort 双峰往上一档，派出 agent 用模型表）和 Liquid 的（d1-ultra：> 0.8 / < 0.2，置信度 < 0.5 往上一档，派出 agent 用 route 选择题，置信度 < 0.5 退到最强）；`yesBar`、`noBar`（卡片和日志写 ≥ 还是 >）
    ├── asks.ts             用户这条消息对工作的要求（ADR 0016）：`confirm`（只是同意、继续或选给出的选项）和 `escalate`（要求多想、更仔细或更强的模型）两道是非题，只问用户自己的话
    ├── constraints.ts      长期约束（ADR 0014）：定规矩那道题（`constraintQuestion`）、记下什么（`constraintOf`：原话和助手前一条的最后一段，脱敏、截短）、最多 5 条（`withConstraint`）
    ├── dispatched-agent.ts 派出 agent 的问题（关于任务的是非题 + effort Score + 点名模型、排除模型、点名 effort）、模型表和 effort 下限（ADR 0015）；`dispatchState`（state 的 `brief`）、`backgroundState`（摘要、次数、读数这些背景字段）
    ├── escalation.ts       失败计数要的纯函数（#7，ADR 0013）：调用的结局（`outcomeOf`）、派出 agent 往哪个模型升（`stepUp`）、主 agent 一轮的事实（`TurnFacts`）和出错的那一行（`errorLine`）、从对话记录或 agent 的记录文件取任务（`briefOf`、`rowsFromTranscript`）
    ├── workflow.ts         Workflow 脚本里各个 agent() 的请求（分批）、读回答、写进什么、告诉主 agent 什么（#8）；背景里问题摘要、次数和读数的拼法（`problemBackground`、`problemFields`、`readingBackground`）、`decidedAtStart`、`decidedLine`
    ├── workflow-script.ts  读 Workflow 脚本（找 agent() 调用和它的选项）、把模型和 effort 写进去（#8）；`cooked`（字符串转义）、`templatePieces`（模板切成文字和占位符）、`entriesOf`（`CallWrite` 写成属性）
    ├── workflow-labels.ts  Workflow 兜底：派出带来的 label 对应哪个 agent() 调用、给主 agent 的说明（#9）；`submissionOf`（脚本是怎么交的，只此一处读）；#7 读 Workflow agent 的 transcript 用的 `computedTask`、`isRelayedRequest`
    ├── unresolved.ts       关于问题的三道是非题（`still_failing`、`solved`、`new_task`，`unresolvedQuestions`）、读回答（`readUnresolved`）、判断（`judgeUnresolved`，0.7 / 0.3）、次数怎么变（`countAfter`）（#39，ADR 0014，eval 共用）
    ├── summary.ts          问题摘要（#40，eval 共用）：写给便宜模型的提示（`summaryPrompt`、`SUMMARY_SYSTEM`）、读回答并限在 500 token（`readSummary`）、写成决策模型读的字段（`summaryState`，0.9.0 起）、面板上的中文（`renderSummary`）、标「未解决」（`markLast`）、这一轮的工具汇总（`turnTools`）
    ├── turn-start.ts       发消息时 effort 那一份的拼法（#40，ADR 0014，eval 共用）：`turnStartPart`（按轮的种类问哪些题；state 字段只在有内容时放：命令、摘要、次数、`last_turn`、长期约束、读数）、`lastTurnState`、`messageRequest`（state 加上 part 的字段，字段占预算）
    ├── model-ids.ts        模型家族对应的完整模型 ID：计划表的 model 写它，不写别名（#9）
    ├── skills.ts           skill 推荐（ADR 0018，照 TypeSafe 的 skill 推荐 cookbook）：modRanker 是推荐和 find_skill 共用的唯一入口；第一段 skillsPart（选择题和三道门控题），第二段 stageTwoPart；pickSkills、findSkills、给主 agent 的文字块；skillsRequest（#16 的评测用）
    ├── context.ts          state：token 估算和截断、最近的对话（最近几行只算一次）、`withoutReminders`（去掉 system-reminder 块，escalation 的任务摘要也用它）、turnStartState
    ├── redact.ts           secret 脱敏
    ├── prompt-hint.ts      提示框提示的文字（`promptHint`）：dp 关着、effort 锁定、派出 agent 时会识别的点名（模型名、`mentionsEffort` 的字眼）
    ├── keep-newest.ts      只留一个当提醒用的 Map 里最近的几项（`keepNewest`）：推迟的消息、轮中贴图的消息、连续两次不过的记录都用
    ├── backend.ts          决策后端的接口、超时、失败分类（`BackendIo.pace`：限速要的时钟和 `$.state` 闭包；402 是 `quota`，429 和 529 带 `retryAfterMs`）、两家决策模型的名字 `BackendName`；两家共用的 `postJson`、`timedOut`（超时的 `Failure`）、`readPosted`（读 2xx 的回答）、`withoutKey`（失败里的 key 换成 `[REDACTED]`）
    ├── images.ts           决策请求里的图（#56，ADR 0008）：`imageRef(name)`（state 和题目里的引用）、`placeImages`（两家共用，换引用、检查）、`imageTokens`（token 估算）、`packByCost`（按 token 分批，放大复核的批和档位序列的波共用）、`describeImages`（debug log 里的一句）、`PPLX_MAX_IMAGES`
    ├── image-fit.ts        图要多大决策模型才收（#57）：两家的限制（`JEV_IMAGE_LIMITS`、`PPLX_IMAGE_LIMITS`、`LOOK_IMAGE_LIMITS`）、`planSize`（缩到哪个尺寸）、`uprightArgs`（按 EXIF 方向转正的 sips 参数）；mod 和评测共用
    ├── image-header.ts     PNG 和 JPEG 的文件头（#57）：尺寸、JPEG 的 EXIF 方向（`readImageHeader`，从 base64 直接读，不解码整张图）
    ├── visual-check.ts     看图核对的判断（#57，评测共用）：检查项和比较对象的类型、`wholeImageRequest`（请求一）、`readWholeImage`、`judge`（`PASS_AT` 0.8 / `FAIL_AT` 0.2；录屏 `RECORDING_BARS`，档位序列 `SERIES_BARS`）、连续两次不过的记录（`noteResults`、`forgetLoop`）、`requestImage`（读好的图变成请求里的图，各处共用）
    ├── complexity.ts       参考图的复杂度读数（#63，评测 #65 和 #64 共用）：0–4 五档的 Score 题（英文）、`complexityRequest`、`readComplexity`、`referenceState`（effort 请求的 state 里的 `reference_complexity`）、`referenceKey`（按内容认一组图）、每张图的上限（一组最多 6 张、约 100 万像素）
    ├── zoom.ts             放大复核的几何（#59，评测共用）：框、裁剪区域（边距 15%、至少 160 px、长宽比 ≤3.5）、按比例换算、sips 的参数、视角是否相同
    ├── visual-check-zoom.ts  放大复核的题和判定（#59，评测共用）：请求一里的框题（`locatePlan`、`withBoxes`）、请求二的 Noul（`zoomRequest`、`batchPairs`）、读回答、`judgeZoom`、`fallBack`
    ├── visual-check-frames.ts  看图核对读录屏（#60，评测共用）：`isRecording`、`FRAME_COUNT`（Jev 12、pplx 8）、`frameTimes`（取哪几秒）、ffmpeg 的参数（`probeArgs`、`frameArgs`）、`parseDuration`、`framesRequest`（帧的请求）
    ├── visual-check-sequence.ts  档位序列的判断（#61，评测共用）：`pairConclusion`、`seriesVerdict`（从哪一档起往上看不出差别）、`pairWaves`（分批）、`MAX_LEVELS`、工具说明里档位序列的两段
    ├── visual-check-sequence-text.ts  档位序列的回答（#61，英文）：`seriesText`
    ├── visual-check-record.ts  看图核对留给人看的（#58）：日志里的 `VisualCheckRecord`、`CheckTally`、看板和日志的中文字句（`tallyText`、`reasonText`）
    ├── visual-check-tool.ts  agent 读到的 visual_check（#57，英文）：工具说明（两版）、输入 schema、`parseVisualCheckInput`（图的路径只去掉首尾空白，不折叠中间的空白：macOS 的截图名里有 U+202F）、回答的文字 `visualCheckText`、一条检查项的一行 `checkLine`
    ├── screenshot-takeover.ts  截图接管的判断（#62，纯）：给 agent 的说明 `takeoverNote`、Read 结果的文本形态 `noteAsReadResult`、从工具结果里找 image 块并换掉（`imageOf` 认 MCP 和 Messages API 两种写法，`swapImages`）
    ├── jev.ts              Jev 后端（带图时：顶层 `assets`、`TypeSafe-Danger-Zone-Images` 头、固定 `jev-1.14.0`）；`needsLongContext` 判断带不带长上下文请求头（0.9.0 起默认值都留在常规上限内，只有合并的 agent 请求可能超出，ADR 0014）
    ├── pplx.ts             Perplexity 后端（Decisions API，pplx-decider-v1.1-27b，#43、#50；`decisionModel: pplx` 选它；带图时 state 是数组）
    ├── liquid.ts           d1-ultra 后端（Liquid，ADR 0017）：TypeSafe 的 System One 请求和回答，固定模型 `d1-ultra`，没有长上下文请求头、不收图和 Box 题（图仍走 Jev）；`LIQUID_QUESTION_TOKENS` 32,768、`LIQUID_PER_ESTIMATED_TOKEN` 1.092（实测）
    ├── rate-queue.ts       两个限速共用的排队（pplx-rate、jev-rate）：`rateQueue()`（`ticket`、`place`、`nudge`）、`priorityOf`（effort 题优先）、`handedOver`（交出去前去掉 `retryAfterMs`、带上 notes）、`LEAST_SEND_MS`（200）
    ├── pplx-rate.ts        pplx 的限速和 429 重试（#51）：`rateLimited(backend, qps)` 把后端包起来，按 `pplxQps` 排队（队列是 rate-queue.ts 的），effort 先发
    └── jev-rate.ts         Jev 的限速和 429/529 重试（2026-10-15）：`jevRateLimited(backend, limits)`，按 `jevQps` 和 `jevTokensPerSecond`（令牌桶，存 5 秒）排队，effort 先发；Retry-After 最多停 `MAX_HOLD_MS`（5 秒）
scripts/decide.ts           用 Node 发一次真实的判断（Jev），请求内容与 mod 发出的相同：设置取 manifest 的默认值（`optionsFrom` + `readConfig`，和评测一样），凭证和 Node 的 io 用 `eval/node.ts` 的
scripts/decide-agent.ts     同上，判断一个派出 agent（输入是评测集 subagent.jsonl 的一题）
eval/                       评测（接缝 2）：评测集、Node 脚本、结果，见下文「评测」
tests/support/world.ts      接缝 1 的测试脚手架；导出 `KEY`、`UNRESOLVED_ON` 两个常用的选项常量，假 Jev 的回答带 `JEV_MODEL`
tests/support/pasted.ts     用户贴在消息里的图（#63）：`prompt.submit` 的 attachments（只有元数据）和引擎随后追加的那一行（`session.append`，door 为 prompt：image 块加 `[Image: source: <路径>]` 文字）；`w.submit(text, { images })` 用它
tests/support/images.ts     world 的二进制文件和程序（#57）：`FakeFile`（按格式、尺寸描述的图，`fileBase64` 给出真的 PNG/JPEG 文件头）、`readFake`（从请求里的 base64 读回尺寸和来历）、假的 `sips` 和 `mkdir`（`Program`）；假的 `ffmpeg(videos)`（#60：`videos` 是按绝对路径给的 `FakeVideo`（长度、宽高、帧率），不在 `files` 里；`-i` 单独一次回 `Duration:` 并以 1 结束，`-ss` 超出最后一帧回 234，否则把一帧写成带来历标签的 JPEG；用 `process: { programs: { ffmpeg: ffmpeg(videos) } }`，`ffmpeg: null` 是没装）
                            （#62 加）`FakeFile.mtimeMs`（`fs.stat` 的修改时间）、`readImageResult`（Read 读图时引擎给 `tool.call` 的结果：image 结果加 `[Image: …]` 文字和 ref）、`screenshotContent`（MCP 截图工具的内容块，`mcp` 和 `api` 两种写法）、导出的假 `base64 -D -o 文件`（stdin 解码成文件，假图的字节还原成同一张图；不是缺省程序，要用 `process: { programs: { base64 } }` 装上，#63 的测试靠它缺省没有来测「写不成文件」）
tests/support/eval-images.ts  看图核对评测（#65）的测试要的机器：世界的假磁盘上的文件和程序（`imageHost`，sips 和 mkdir 与世界里的一样），以及评测经它自己用的后端去问、由世界的假模型回答的决策模型
tests/support/eval-network.ts  评测各个 suite 的测试要的假 Jev：每个请求体写一个回答的网络（`network`）、effort 题和是非题的回答（`answers`，`model` 是 `JEV_MODEL`）
tests/support/drawn.ts      挂载界面（`w.band()`、`w.pane()`、`w.footer()`）的测试从画出的树上读东西：`Drawn` 类型、`shown`（元素显示的文字，Button 写成 `hotkey: label`）
tests/support/conversation.ts  `$.session.messages()` 交给 mod 的对话：`Entry`、`transcript`（由评测集的 `recent_context`、v2 题的 turns 拼成；助手回复的 tool 调用只有名字）
tests/support/zoom.ts       放大复核的假决策模型（#59）：`zoomBackend` 按题号分开回答请求一（整图的 Noul、框题）和请求二（裁图的 Noul），`box()` 写一个框答案
tests/support/series.ts     档位序列的假决策模型（#61）：`levels(n)` 档位文件、`seriesBackend` 按请求里图的标签认出是哪一对，每对各回各的答案
tests/support/workflow.ts   Workflow 工具桩和按脚本里第几个调用作答的 siteJev（#8）；workflowWorld 在 world 之外加一层，不改 world.ts
tests/support/workflow-run.ts  Workflow agent 的派出（按运行记下的 Workflow 调用触发 agent.spawn，记下它启动的模型）和 tool.describe 的桩；runWorld 在 workflowWorld 之外再加一层（#9）
types/index.d.ts            $.state 的契约（PluginState）
```

### 一条消息的处理过程

1. `prompt.submit`：各功能的 hook 在外层，带 matcher，先运行。`main-effort` 确认这是用户本人的新消息（或开始一轮的报告）后，往这条消息的投票箱里放 `effort` 这个 part（effort 题 `effort.level` 和是非题：你本人的消息十道，报告开始的一轮四道，ADR 0014、0016；state 字段只在有内容时放）和一个 `settle` 回调，然后放行。
2. 核心的 `prompt.submit` 在最内层。它收起投票箱，按 `requestGroups` 拆成最多两个请求：主 agent 的 effort 题（`effort` 这个 part）单独一个，其余各功能的题合成一个（ADR 0005）；某一组没有 part 就不发。每个请求各拼自己的 state 并合成请求（`decision/turn-start.ts` 的 `messageRequest`：`turnStartState` 加上 `mergeParts`，每个问题 ID 加上 `<part>.` 前缀；预算见 `messageLimits`：含 skill 题的是 `context.tokens`，effort 的是 `contextByKind.messagePlain`；part 加进 state 的字段，如命令和问题摘要，先从预算里扣掉），两个请求并行带着超时发给决策后端，各记一行 debug log，再把各自的回答去掉前缀后交给这个请求里各功能的 `settle`。`settle` 返回的文字块作为 context 附在消息后面，模型能看到，用户看不到。两个请求各自成败，一个失败或超时不影响另一个；消息等到两个请求都有结果（或超时）才进入会话。
3. `main-effort` 的 `settle` 先读关于问题的三道是非题、动次数（`core/unresolved.ts` 的 `moveCount`），再按 `decideMessage` 定档（读动过之后的次数，R5），把这条决定（或决策模型失败的原因）交给「决定汇报」（`report` 的 `decision`；决定里带着规则推演 `trace` 和这次三道题的记录，次数变了另记一条 `unresolved` 的决定），定规矩那道题为是时记下长期约束（另记一条），再把档位记为待用的决定（`$.state` 的 `pending`）。缺 effort 题的回答时这一轮不路由，次数照动；缺关于问题的回答时次数不变，effort 照定。如果这条消息是在某一轮进行中发的，它还会直接改写那一轮的计划。
4. `turn.start`（核心）为这条消息开始的一轮建立记录 `turns[main:<turnId>]`，并认领它的待用决定。优先认领正在进入的那条消息的决定，即使更内层的 hook 改写了消息的文字也能认领；其次认领文字与这一轮相同的排队消息。
5. `turn.step`（核心，最内层）每一步都读计划表，用 `planStep` 算出这一步的 effort（主 agent 不碰 model），写进请求，并把这一步（任何 loop 的）发出的模型和 effort 交给「决定汇报」的 `reportStep`（看板从它画出）。

### 规则

- **入口只负责组装。** 新增一项功能时，在 `features/` 下新建一个文件，导出 `register<X>(on: On, ctx: Ctx)`，然后在入口的 `registerCore` 之前加一行。行的顺序就是嵌套顺序：越靠前越在外层，越先看到事件。
- **核心永远最后注册。** 因此在核心参与的事件上，每项功能都先于核心运行：在 `prompt.submit` 上，功能先往投票箱放问题，核心再发出请求；在 `turn.step` 上，功能先写计划表，核心再按表写出。
- **功能注册事件时一律带 matcher。** 不带 matcher 的位置留给核心。同一事件不带 matcher 注册两次会导致模块加载失败，而且这是跨文件的静态检查，多张票并行开发时很容易撞上。下面是常用的「全匹配」matcher（所用字段每次都存在）：

  | 事件 | matcher | 备注 |
  |---|---|---|
  | `prompt.submit` | `{ text: /(?:)/ }` | 已实测 |
  | `turn.step` | `{ turnId: /(?:)/ }` | 已实测，主 agent 和其他 agent 的每一步都匹配 |
  | `turn.step` | `{ agentId: /(?:)/ }` | 已实测，只匹配派出 agent 和 Workflow agent（主 agent 的步没有这个字段） |
  | `turn.start` | `{ turnId: /(?:)/ }` | |
  | `tool.call` | `{ tool: /(?:)/ }`，或 `{ tool: 'Workflow' }` 这样的具体值 | 已实测；find_skill 用 `{ tool: 'mcp__dispatch-pilot__find_skill' }`（#12） |
  | `agent.spawn` | `{ tool_use_id: /(?:)/ }` | 已实测（#6） |
  | `prompt.attachment` | `{ type: 'skill_listing' }` 这样的具体值 | 已实测 |
  | `session.start` | `{ cwd: /(?:)/ }` | 已实测（`features/control.ts` 用它），每个功能的 session.start 都这样写 |
  | `session.measure` | `{ context: { window: /(?:)/ } }` | 已实测，`window` 每次都有 |
  | `command.run` | `{ command: 'dp' }` | 已实测，只处理自己的命令 |
  | `classic.PreToolUse` | `{ tool: /(?:)/ }` | 已实测（kit 和真实引擎）；认出 settings hook 拦下的调用由核心做（不带 matcher，`core/outcomes.ts`），功能不必再包这一层 |

  其他事件请选一个每次都存在的字段。字段不存在时 matcher 不会命中，hook 会被静默跳过，所以新写的 matcher 要有测试覆盖。
- **`$` 只能在 hook 所在的文件里使用**，不能传给从别的文件导入的函数，否则加载时会被拒绝。同一个文件里的函数可以接收 `$` 当参数（`launch($, s, ...)`），但不能把 `$` 放进对象字面量（例如 `{ $, s, e }`）：加载时报 `$ itself is put in an object`（#7 撞到的），要写成单独的参数。共用的逻辑写成纯函数；需要 `$` 的能力时，让函数接收闭包，例如 `BackendIo`（`{ fetch: (u, i) => $.http.fetch(u, i), sleep: (ms, s) => $.clock.sleep(ms, { signal: s }) }`）或 `$.state` 的 `Cell`（`{ get: () => $.state.get(REF), set: (v, o) => $.state.set(REF, v, o) }`）。`ctx` 里只有数据和纯函数。kit 和 `claude plugin validate` 都不拦这一条，所以 `node dispatch-pilot/eval/validate.ts docs` 查它（`eval/lib/docs.ts` 的 `checkEngineStaysHome`）：导出的函数不能有叫 `$` 的参数，`$` 也不能放进对象字面量。需要 `$` 的共用逻辑（例如带图的读数 `ReadIo`）都收闭包，由每个 hook 所在的文件用自己的 `$` 造一份。
- **`$.state` 的 ref 在每个文件里各自写成字面量常量**，例如 `const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const`，family 写成 `{ ...TURNS, id }`。validate 要求 `plugin` 和 `key` 是字面量。
- **每个字段只由一个 hook 写出。** 主 agent 的 effort 和非主 agent 的 model 只由核心的 `turn.step` 写出。功能通过计划表影响它们，不要在自己的 `turn.step` 里改 `e.effort` 或 `e.model`：内层的改写会覆盖外层，而核心在最内层。
- **主 agent 永远不写 model**（ADR 0001）。`planStep` 从结构上保证这一点：主 agent 的步最多只改 effort。
- **一律放行。** 决策模型失败、超时、回答不完整，或者自己的代码出错时，都让事件照常往下走，不阻塞用户，并在看板上说明原因（路由失败另弹一个 toast）。

### 往计划表写：effort、floor、model、lock

计划表在 `$.state` 里，契约见 `types/index.d.ts`，类型见 `core/plans.ts`。核心的 `turn.step` 每一步都会读它，所以写进去的值从下一步起生效。在同一步里，外层 hook 写入的值内层马上就能读到（已实测）。

| key | id | 内容 | 由谁写 |
|---|---|---|---|
| `turns` | `turnKey(turnId, agentId)`，即 `main:<turnId>` 或 `<agentId>:<turnId>` | 一轮的计划 `{ effort, floor, model }`，另有 `prompt`（主 agent 这一轮的消息，已脱敏和截断）、`decisions`、`changes`、`person`（这一轮是不是你本人的消息开始的，那次判断成功与否都算）和 `facts`（这一轮结束时记下的事实，`TurnFacts`，见「失败时升模型」；0.8.x 还有 `floorUntil`、`raisedAt`） | #2 发消息时写（核心的 `turn.start` 建记录）；#7 在你本人的消息开始的一轮结束时写 `facts` |
| `agents` | `agentId` | 一个派出 agent 或 Workflow agent 所有轮的计划 `{ effort, floor, model, terms }`；`terms` 是你对这项工作的约束 `{ model, effort, banned }`（点名的模型、点名的 effort、排除的模型，决策模型读你的话得出；没有就是 `null`），后面改它模型或 effort 的功能都照办 | #6 在 `agent.spawn` 时写 effort 和 `terms`（model 已经改在派发上，表里留 `null`，免得每一步都把引擎过载时换用的模型改回去）；#9 在 Workflow agent 的 `agent.spawn` 时写 effort 和 `terms`（model 和 #6 一样改在派出上，表里留 `null`；#8 已经写进脚本的调用只写 `terms`）；#7 失败到门槛时写 `model`（升到的模型的完整 id，每一步都发出） |
| `workflowTerms` | Workflow 调用的 `tool_use_id` | #8 判断出的、你对直接交来的脚本里每个调用的约束（按调用序号，没有就是 `null`）；同一次调用里 #9 在内层读它，把约束交给这些 agent 的计划 | #8 在调用工具之前写 |
| `escalation` | `main`（主 agent，记录里的 `turnId` 是它所属的那一轮）或 `agentId` | 每个循环唯一的失败计数：工具调用数（只有主 agent 的全数）、失败次数、被 hook 拦下的次数、重新数的基数 `base`（计入的是减去它之后的数）、升模型的次数 `raises`、这个循环最近一步的序号和引擎给的 model（派出 agent 从它升）、主 agent 最近一步发出的 effort 和最后两行出错信息（写 `facts` 用）、`paused`（开关关着时记下，再打开时把关着期间的失败作废） | #7 |
| `lock` | 无 | 用户锁定的主 agent effort，`null` 表示没有锁定 | #13：`/dp lock`、`/dp unlock`（`features/control.ts`） |
| `board` | 无 | 看板数据：`turn`（本会话开始的主 agent 轮数）、`starts`（最近两轮的开始时间）、`changes`（读数的变化事件）和 `nodes`（最近两轮每个 agent 的一个节点：模型、effort、是否路由、未路由的原因、对应的决策编号，以及失败计数 `counts`），见「记录一次决策」 | 「决定汇报」module（`core/report.ts`）：`report`（`decision`、`decisions`、`tally`）、`reportStep`、自己的 hook |
| `decisionLog` | 无 | 各功能记录的决策，最近 20 轮、最多 300 条，依据面板（`/dp`）按轮分组显示，`/dp log N` 在对话里列出（见下「记录一次决策」） | 「决定汇报」module |
| `pending` | 无 | 发消息时做出的判断，等它的那一轮开始时由核心认领 | #2 |
| `unresolved` | 无 | 未解决次数 `{ count }`：每条你本人的消息按三选一的回答加一、清零或不变；`session.end`（`/clear`、新会话）清零，`/compact` 保留，热重载不丢；缺省按 0 读。同一个 key 里还有问题摘要（#40）：`summary`、在写的轮 `writing`、欠着的标记 `owed`，见「问题摘要（#40）」；清零的地方摘要一起清 | #39、#40：`core/unresolved.ts` |
| `said` | 无 | 用户本人这一轮说的话（已脱敏和截断）：空闲时发的那条消息开始新的一组，这一轮进行中发的消息追加进去，其他来源的 prompt 不动它；派出 agent 和 Workflow 里 agent 的判断把它当作 `user_message` | #6 写，#8 读 |

`planStep` 按以下规则决定每一步发出什么：

- effort：主 agent 有 lock 时用 lock。否则，你为这个 agent 点名的 effort（`terms.effort`）优先，任何 floor 都不抬它；再否则取这一轮的 `effort`（非主 agent 这一轮没有时，用它在 `agents` 里的计划），再抬到 `floor`（取这一轮和 agent 计划中较高的 floor）。没有任何 effort 但有 floor 时，抬高的是引擎自己的 effort。什么都没有时用引擎的 effort。
- model：主 agent 永远不改。其他 agent 用这一轮的 `model`，没有时用 `agents` 计划里的；再没有就是引擎的，这就是这一步的**有效模型**。**计划表里的 model 要写完整的模型 ID**（`decision/model-ids.ts` 的 `modelId('sonnet')`），不能写别名：`turn.step` 的 model 原样发给 API，写 `haiku` 得到 404，agent 失败（#9 实测）。只有 `agent.spawn` 会解析别名，#6 在那里写别名。
- 每个家族都带 effort，haiku 也是（Haiku 5.5 接受 effort；故事 32 让 haiku 不带，那是 Haiku 4.5 的时候，0.4.1 去掉）。引擎没给这一步 effort（它算的模型不收 effort）时不补，除非计划把它换到另一个家族：那时按计划补上 effort。引擎给的是数字时不改 effort。

其他约定：

- 当前是第几步不需要另外记录，`turn.step` 的 `e.index` 就是（从 0 开始）。
- 读改写用 `update(cell, change)`，它按版本号做比较后写入，冲突时重试；`change` 必须是纯函数。改主 agent 某一轮的 effort 用 `revise(record, effort)`，它会同时更新 `decisions` 和 `changes`。
- 新的计数（例如 #7 的失败次数）放在自己的 key 下，id 同样用 `turnKey`，并在契约里加上相应的一段。
- 表项不会被删除。每条记录很小，一个会话里的增长可以忽略。
- `returned`（退回过的 Workflow）是 #8 自己的记录，核心不读，也不是计划表的一部分；见下面「Workflow 脚本的读取和改写」。`labelRuns`（本会话启动过的 Workflow 运行，最近 8 个）是 #9 的记录，见下面「Workflow 兜底（#9）」；`workflowRuns`（同样这些运行的 id 和目录）是 #7 自己记的，它从那里找 Workflow agent 的记录文件，所以 #9 关着也读得到。

### 在 turn.step 上注册一层

如果某项功能需要在某一步发出前做决定或记下这一步（#7 记下这一步的模型和 effort、#9 按 label 查表，见 `features/workflow-labels.ts`），就在自己的文件里注册一层，写好计划表，再交给下一层：

```ts
on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
  if (e.agentId !== undefined) {
    // 决定这个 agent 从这一步起的模型，写进 agents[<agentId>]（主 agent 的 effort 一轮中途改了也不生效，ADR 0013）
  }
  return yield* next(e) // 核心在更内层，会读到刚写入的计划
})
```

只处理派出 agent 和 Workflow agent 的层用 `{ agentId: /(?:)/ }`。在 `next(e)` 之后可以读到这一步的结果（`stopReason`、`toolUses`、`usage`）。

### 给发消息时的决策请求加问题（投票箱）

用户发消息时，各功能的问题合在一个决策请求里（同一个请求里的问题互相独立，几乎不增加延迟），只有主 agent 的 effort 题由核心拆出来单独发一个请求（ADR 0005），两个请求并行。对功能来说投票箱的用法不变。在自己的 `prompt.submit` hook 里这样写：

```ts
on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
  if (!isPersonsMessage(e)) return next(e)
  contribute(e.text, {
    part: 'skills',                               // 请求里的问题 ID 是 skills.<id>；part 名只用字母、数字、_ 和 -
    questions: { which: {/* ... */}, 'fits.0': {/* ... */} }, // 本地 ID 只用 [A-Za-z0-9_.-]
    state: { project_platforms: '...' },          // 可选：加进共用 state 的字段，排在共用字段之后
    settle: async (outcome) => {
      if (!outcome.ok) return                     // outcome.failure 说明原因：放行，交给「决定汇报」，看板上写明
      const which = outcome.answers.which         // 只有自己的回答，键是本地 ID；缺失或格式不对的回答不会出现
      // 这里可以继续使用 $，例如再问一次关于同一个 state 的问题（outcome.state，skill 的第二段就这样做）
      return ['<skill_relevance>...</skill_relevance>'] // 可选：附在消息后面给模型看的文字块
    },
  })
  return next(e)
})
```

- `settle` 由核心的 hook 调用，但它闭包里的 `$` 是你自己那个 hook 的，可以照常使用（已在真实引擎中实测）。`settle` 在消息进入会话之前完成，所以它返回的文字块来得及附上；它花的时间（例如 skill 的第二个请求）也算在消息的等待里，记得给自己限时。`settle` 抛错不会被悄悄吞掉：`core/ask-group.ts` 在 debug log 写 `<part> could not settle its outcome: <message>`，这个 part 不给 context 块，别的 part 不受影响（`tests/ballot.test.ts`）。同一条消息文字再放进问题时，这份投票箱算最新的；未被收走的问题超过 32 个时丢最老的那份，不会把刚放进的一起丢掉。
- 成功时 `outcome.state` 是这个请求问过的 state（共用的 state 加上各部分加进去的字段），后续的请求要问同一件事时就用它（#11）。
- 每条消息最多发两个请求：effort 题一个，其余的题一个（只有其中一类时只发一个）。请求失败或超时时，那个请求里的每项功能都会收到同一个失败，另一个请求不受影响。
- 共用的 state 只有 `{ user_message, recent_context }`；effort 请求的 recent_context 按 `contextByKind.messagePlain` 取（Jev 24000，pplx 48000），带 skill 题的请求按 `context.tokens` 取（6000），所以两个请求里它的长度不同。往里加字段会影响同一请求里的所有问题（无关内容会降低准确率），只加问题确实需要的字段。
- 问题的写法见 `docs/research/typesafe-question-guide.md`。

### 在其他时机发决策请求

派出 agent（#6）不经过投票箱，而是在自己的 hook 里直接发（0.8.x 的中途重判也是）：

```ts
const io = { fetch: (url: string, init: HttpInit) => $.http.fetch(url, init), sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }) }
const request = mergeParts(state, [part])                               // part 的写法同上
const asked = await ctx.backend.ask(io, request, ctx.config.timeoutMs) // 从不抛错；asked.ok 为 false 时放行
const answers = asked.ok ? answersFor(part, asked.answers) : null
```

effort 问题的档位描述是共用的：用 `effortQuestion(instructions, ctx.ask)` 配上自己的 instructions，生成同样五档的问题，这样各处判断出的档位可以直接比较。

判断一个 agent 的模型和 effort，用 `decision/dispatched-agent.ts`：输入 `Dispatch` 的字段与评测集 subagent.jsonl 的题目相同，`dispatchState(dispatch, tokens)` 拼 state（字段永远是 `brief`；对话、摘要和读数这些背景由 `backgroundState` 拼），`dispatchPart` 出问题，`decideDispatch` 按模型表定模型、按基础档和下限定 effort，每一步记进 `steps`（ADR 0015）。Workflow 改写（#8）和合并的 agent 请求（`core/agent-lane.ts`）把几个 agent 放进同一个请求时，每个 agent 有不同的 `part` 和 `field`（例如 `agent-0` 和 `brief_0`）：这是 `decision/workflow.ts` 里 `shapeOf` 和 `workflowBatches`、`agentBatches` 的事，不是 `dispatchState` 的参数；state 用 `dispatchBrief` 拼各自的 brief，`user_message` 只放一份；做法见下节。

### Workflow 脚本的读取和改写（#8）

`decision/workflow-script.ts` 是一个懂 JavaScript 词法的读写器（mod 里没有现成的解析器可用）：它把脚本切成词（字符串、模板、注释、正则字面量、标点），所以注释和字符串里的 `agent(` 不会被认成调用，模板 `${...}` 里的代码会被读到，`.agent(`、`function agent`、`new agent` 和方法定义也不算调用。`parseWorkflow(script)` 返回 `{ meta, calls }`，读不了（字符串、模板或注释不完整，括号不成对，没有 `export const meta`）返回 `null`。每个 `AgentCall` 有 `prompt`（运行时才拼出来的是 `null`）、可选的 `promptTemplate`、`label`、`agentType`、行号，以及 `model` 和 `effort`（`none`、`literal` 或 `dynamic`）。`promptTemplate` 只在 prompt 是带 `${...}` 的模板字面量时为真，这时 `prompt` 是脚本里写的原文（转义原样）；引号字符串，和没有占位符的反引号字符串，存的是处理过转义的值。按 prompt 开头认 label 时（见「Workflow 兜底」），带占位符的模板只处理第一个占位符之前的文字（`cooked`，转义的读法只此一处，`workflow-script.ts` 导出，`workflow-labels.ts` 共用）；`templatePieces` 把模板切成文字和占位符，也是 `workflow.ts` 的 `tellsTheWork(prompt, template = false)` 数占位符用的：它只在被告知 prompt 是模板时才数，所以运行时的任务里含 `${` 只是普通文字。`rewriteWorkflow(parsed, writes)` 只在找到的位置改文本，其余逐字不变，一遍扫完（三万个调用的脚本不到半秒）；`writes` 的每项是 `CallWrite`，`{ model?: string; effort?: string }`（`entriesOf` 把它写成要加的属性）。以前有一条「effort 为 null 就把这个选项删掉」的路径，没有谁产生 null，已经删了。

`decision/workflow.ts` 把调用变成决策请求（`workflowBatches`：同一请求里的 part 是 `agent-<n>`，state 字段是 `brief_<n>`，`n` 是调用在脚本里的序号，所以分成几批后 ID 仍不重复；每个 brief 最多平分的一份，`BRIEF_FIELD` 留出字段名；第五个参数是 `{ perRequest, background }`，`background`（`WorkflowBackground`）是每个请求另带的脚本、对话、摘要和次数，摘要和次数和你的话一起先算，脚本和对话在 brief 之后填剩下的；`planBatches` 在一个请求装不下时改用每个请求的预算重分）、读回答（`readOutcomes`：每个调用的结果是 `written`、`kept` 或 `left`）、写给主 agent 的文字。背景里的问题摘要、次数和参考图读数各只有一处拼法，在这个文件里：`problemBackground`（存着的次数和摘要拼成 `problem_summary`、`unresolved_count`）、`problemFields`（已有的字段取出）、`readingBackground`（`reference_complexity`）；派出 agent（`features/dispatched-agents.ts`）、`workflow-agents.ts` 和 `workflow-labels.ts` 共用它们，派出 agent 一侧的 state 字段由 `decision/dispatched-agent.ts` 的 `backgroundState` 拼。「没有在等待时间内回答」这个 `Failure` 只在 `backend.ts` 的 `timedOut` 造（`failureLine` 从它的 detail 读回毫秒数）。两个模块都是纯的，#9 可以直接复用：用 `scriptPath` 或 `name` 提交的脚本，只要它用 `$.fs.read` 读到了文本，就可以同样 `parseWorkflow`、`workflowBatches`、`readOutcomes`；要改写的话，得去掉 `scriptPath`（它优先于 `script`）再传 `script`。

**给 #9：`$.state` 的 `workflowTerms`。** 直接交来的脚本，#8 在调用工具之前把它读出的、你对每个调用的约束（`termsOf(decision)`，按调用序号，没有就是 `null`；一个都没有就不写）写在这次 Workflow 调用的 `tool_use_id` 下；#9 在内层、同一次调用里读它，放进各调用的 `RunSite.terms`，这些调用的 agent 启动时把约束写进计划。（以前 #8 还按 `runId` 记过一份每次运行的摘要 `workflows`，没有任何功能读它，已删掉。）

读不了的调用要留意：prompt 放在数据里的 fan-out（`QUESTIONS.map((q) => () => agent(q.prompt, { label: q.label }))`，或 `` agent(`${CONTEXT}\n\n${l.prompt}`) ``）这里读不到任务内容，也不能在一个调用点上给每一行定不同的模型，所以整个调用点保持原样（`left` 计入，主 agent 被告知）。这一类要靠 #9 在运行时按每个 agent 的 label 和它实际收到的 prompt 来判断。用本机 `~/.claude/projects` 里已有的 16 个主 agent 写的真实脚本（共 50 个调用点，不含本票的探针）试过：44 个调用点的 prompt 说明了要做什么（多数是 `` `${COMMON} YOUR TOPIC: ...` `` 这样的模板），6 个读不了（1 个整个是运行时拼的，5 个是 `` `${CONTEXT}\n\n${l.prompt}` `` 这样的共用上下文加表里的一行）；改写后的脚本用 Node 的解析器检查过，都能解析。

### Workflow 兜底（#9）

#9 不改写用 `scriptPath` 或 `name` 提交的脚本（上节说的「去掉 `scriptPath` 再传 `script`」）：那样运行的是另一份脚本，主 agent 手里的文件和实际运行的对不上，恢复运行时每个 `agent()` 的缓存 key（prompt 和选项的哈希）也会失配；在 agent 的请求上设置则不动脚本。直接交来的脚本由 #9 自己再读一遍（纯函数，几毫秒），#8 只经 `workflowTerms` 交来你对各调用的约束。

`features/workflow-labels.ts` 注册三个 hook，都带 matcher：

- `tool.describe`（`{ tool: 'Workflow' }`）：在引擎的描述后面附 `LABEL_HINT`。引擎每个会话只问一次并一直沿用（`$.ui.invalidate('tool.describe')` 之前），所以文字是常量，不拼会话内容；开关变化也不重新问。
- `tool.call`（`{ tool: 'Workflow' }`）：在入口里注册在 `workflow-agents` 之后，即在它内层：那个功能问完决策模型、把脚本交下来之后才轮到这里，所以它还在问的时候，别的运行里启动的 agent 不用等这里（见下文的 `launching`）。工具返回后读运行用的脚本：直接交来的读 `e.script`（那个功能交下来的那份：它写进去的调用多了选项，留下的调用照旧），其他读工具结果的 `scriptPath`。这里附的说明排在 `workflow-agents` 的说明之前（外层的功能在内层返回之后才追加自己的）。`scriptPath`、`name`、恢复的运行，各调用用 #8 的 `planBatches`、`readOutcomes` 判断（`agentBackground` 为真时带脚本和截到这次调用的对话）；直接交来的不再问，`planBatches(...).skipped` 就是 #8 没问的调用（读不了的 prompt、超出上限的；摘要和次数要和 #8 用的一样，因为它们占预算、影响分批）。结果写进 `$.state` 的 `labelRuns`：`{ runId, callId, workflow, description, sites, launch? }`，有 agent 要在启动时判断（`sites` 为 `null` 或有 `runtime`）时才存 `launch`：那一轮的 `said`、摘要和次数、脚本原文（`agentBackground` 为真时）、调用 Workflow 的循环（`caller`，主对话不写），`sites` 是各调用的 `RunSite`（`match` 怎么认 label，`route` 是 `set`（运行开始时定的模型家族和 effort）、`runtime`（agent 派出时判断）或 `script`（照脚本），`terms` 是你对这个调用的约束；脚本读不了时 `sites` 为 `null`）。每个启动了的运行都记（没有 `agent()` 的除外），调用全都照脚本的也记：这些调用的 agent 派出时还要把你的约束（`terms`）写进计划。（#7 找 Workflow agent 的记录文件用的是它自己记的 `workflowRuns`，不读这里。）
- `agent.spawn`（`{ tool_use_id: /(?:)/ }`）：只管带 `e.workflow`、不带 `resume` 的派出。按 `runId` 找运行（Workflow 调用还在处理时等它交出的运行，见下），`sitesFor(e.description, sites)` 找调用：字符串 label 精确匹配，模板和「prompt 开头」其次，运行时才算的 label 作通配，只在前两者都对不上时用。所有候选的 route 相同就用它；`script`（#8 已经写进脚本）不改派出，只在候选带着同样的约束（`RunSite.terms`，#8 经 `workflowTerms` 交来）时写一份只有 `terms` 的计划；`set` 在派出上设模型、计划里写 effort 和 `terms`；`runtime`、对不上或候选不一致时，`decideAtStart` 用 `e.prompt` 拼成一个只有一个调用的 `ParsedWorkflow`，同样经 `callDispatch`、`askAgent` 问决策模型：你的话、摘要和次数取 `launch` 里存的（早先的 load 记的运行没有 `launch`，才读现在的 `said`），`agentBackground` 为真时再带 `launch.script` 和 `launchConversation` 截到运行 `callId` 那条消息的对话（找不到那条消息就不带对话），预算是 `agent`。模型和 #6 一样只在要换家族时设（和 `e.model`，没有时和 `e.parentModel` 比家族），写别名。计划和看板在 `next` 返回 agentId 之后写；这之后出的错不影响派出，只在看板上写「出错了，详见 debug log」。

几处要留意的引擎行为：

- **运行的第一个 agent 在 `tool.call` 处理完之前就派出**（2.1.302 实测：派出的 hook 睡 3 秒，工具的 `next` 照样在 4 毫秒后返回，所以工具不等派出，等它不会死锁）。`tool.call` 在 `next(e)` 之前按自己的 `tool_use_id` 把一个 Promise 放进模块级的 `launching`，处理完再交出它记下的运行；派出带着同一个 `tool_use_id`，在 `launching` 里有就等它（最多到派出的 9 秒期限），再看交出来的运行是不是这个 `runId` 的；没有就读 `labelRuns`。别的运行的 agent 和派出 agent 不等。
- **运行要从模块内存交出来，不能等完再读 `$.state`**：一次 dispatch 里的 `$.state.get` 读的是这次 dispatch 开始那一刻（d.ts：Every `get` of one dispatch reads one moment），等待期间 `tool.call` 写进去的 `labelRuns`，这一步再读也读不到（kit 实测）。同一次 dispatch 里外层写、内层读不受影响（见下文「已实测的引擎行为」第一条）。
- **`$` 只能传给文件顶层声明的函数**（validate 和加载器都检查）：`routeSpawn`、`runOf`、`decideAtStart` 都在顶层，`ctx` 和设置作参数传进去。
- `decision/workflow-script.ts` 的 `AgentCall` 为此多了 `labelKind`（`none`、`string`、`template`、`dynamic`）：只有不写 label 的调用，引擎才拿 prompt 开头作 label；写了但运行时才算出来的（`label: q.label`、展开的对象里可能带的）不能这样认。`decision/workflow.ts` 导出了 `whyOf`，给主 agent 的说明和 #8 用同样的写法。

测试用 `tests/support/workflow-run.ts` 的 `runWorld($, on, options)`：它在 `workflowWorld` 之上扮演 Workflow agent 的派出。`w.started(runId, agentId, label, { prompt?, model? })` 在启动这次运行的 Workflow 调用（工具桩记下的 `w.callOf(runId)`）下触发 `agent.spawn`（`prompt` 默认是 label，`model` 是调用自己的），记下它启动的模型；`w.agentStep(agentId, { index, model?, effort })` 发出这个 agent 的一步（turnId 是 `turn-<agentId>`，不写 `model` 就按它启动的模型），`w.describeWorkflow(text)` 像引擎那样问一次 Workflow 工具的描述，`w.workflowSpawn(toolUseId, { runId, agentIndex, agentId, label, prompt, model? })` 直接触发一次派出（测本功能没记下的运行），引擎桩按 hook 交下来的模型启动（2.1.300 起的引擎这样做）。`name` 提交和直接交来的脚本存在 `persisted(runId)`（工具桩结果里的路径），`w.disk` 可以随时增删文件。

### 失败计数和升模型（#7，ADR 0013）

`features/escalation.ts` 带三个 hook，都带 matcher，从不问决策模型（0.8.x 的中途重判 `features/midturn-effort.ts` 和「卡住」时的再判断，0.9.0 删了，见「一轮中途不再重新判断」）：

- `tool.call`（`{ tool: /(?:)/ }`）：每个循环（主 agent、派出 agent、Workflow agent）结束的调用，用 `decision/escalation.ts` 的 `outcomeOf` 分成 `ok`、`failed`、`blocked`、`denied`（`wasBlocked` 认出 settings hook 拦下的，见 `core/outcomes.ts`）。用户拒绝按 Claude Code 自己的文字认（`The user doesn't want to proceed with this tool use`、`Permission to use ...`、`Permission for this ...`），MCP 工具的错误文字是它自己写的，一律算失败。只看引擎的调用（`next.origin.plugin === 'engine'`），不看别的插件的 `$.tool.call`；别的插件的 `tool.call` hook 回答的 `{ deny }`（#8 退回 Workflow）不记。计数在总开关开着时一直做，不看 `escalation` 自己的开关。主 agent 的每个调用都数（`countMain`：`calls`、失败、被拦下的，失败和被拦下的再留一行出错信息，`errorLine`、`withError`，最多两行）；派出 agent 只数失败和被拦下的（`countAgent`）。Workflow 工具返回时记下运行目录（`$.state` 的 `workflowRuns`，最近 8 个，不看别的功能的开关）。
- `turn.step`（`{ turnId: /(?:)/ }`）：记下这个循环在哪一步、引擎给的 model（派出 agent 的计划里没有模型时从它升）；主 agent 的还记下这一步发出的 effort（`planStep` 算出的：锁定、决策或引擎原样），新的一轮把主 agent 的记录换成新的。`escalation` 关着时记 `paused`，再打开时把关着期间的失败作废（`base` 设到那时的数）。
- `turn.complete`（`{ turnId: /(?:)/ }`）：主 agent 的一轮结束，这一轮是你本人的消息开始的（`turns[].person`）、记录也是这一轮的，就把 `TurnFacts` 写进 `turns[main:<turnId>].facts`（`keepFacts`）。

**升模型在失败的调用一结束时就定**，写进计划表，核心从这个 agent 的下一步起照写；`turn.step` 里不等任何东西。`countAgent` 先读这个 agent 的记录和计划，按有效模型（计划的 `model`，没有才是 `turn.step` 记下的引擎的）算出往哪升（`stepUp(from, settings, terms)`），再用一次 `replace` 记下这次失败：计入的失败（失败，加上开关 `hook-block-failures` 开着时被拦下的，各减去 `base`）够 `escalateAfter`、`raises` 还不到 `escalateLimit` 时，同一次写入把 `base` 换成现在的数，能升就 `raises` 加一。同一步里并行的几个调用一起失败时，只有一次写入换掉了 `base`，只有它升级、记决定（`tests/escalation.test.ts`）。能升就把计划的 `model` 设成升到的完整 id，记一条决定（`forced: { kind: 'model', from, to }`，`tone: 'warn'`）；升不了也记一条，写明原因（`tone: 'info'`）。决定的 `subject` 写是哪个 agent（任务的开头、第几步、失败几次）：任务取自 `$.session.messages({ agentId })`；Workflow 的 agent（引擎对 mod 返回 `{ deny }`）从运行目录读 `agent-<agentId>.jsonl`（按这个 agent 自己的 transcript 文件找，不读 journal，所以长运行的 journal 超过 `$.fs.read` 的 4 MiB 也不影响这里），`rowsFromTranscript` 读成同样的行，`briefOf` 取任务（去掉引擎的外框，引擎转述的用户请求不算任务）。

**`stepUp` 的规则**（纯函数，`decision/escalation.ts`）：你点名的模型（`terms.model`）不换；认不出家族（不是 haiku、sonnet、opus、fable）不换；haiku → `escalateHaikuTo`（没设、或写的不是已知模型就不换；被你排除了就往上找没被排除的）；其余按 `AGENT_MODELS` 的顺序在 agent 可用的模型里（`agentFable` 打开才有 fable）往上找第一个没被排除的；到顶或往上都被排除就不换。每种不换都带一句给人看的原因。

**换模型要完整的 id。** 实测（2.1.289）：`turn.step` 的 `model` 写别名 `sonnet`，主 agent 会 `unrecognized_model` 退出，派出 agent 会以 `model_not_found`（HTTP 404）提前结束；写 `claude-sonnet-5-5` 在一个 haiku agent 运行到一半时换上，后面的步骤都由 sonnet 回答，agent 正常完成（`usage.model` 可见）。2.1.312 上主 agent 写别名 `haiku` 生效了（见「已实测的引擎行为」的「2.1.312」一节），mod 仍写完整的 id：`escalateHaikuTo` 由 `decision/model-ids.ts` 的 `resolveModel` 解析，别名换成 `MODEL_IDS` 里的完整 id，带家族名的完整 id 原样用，别的值不换（记一条决策）；往上升到的 sonnet、opus、fable 用 `modelId`。

### 登记功能开关

每项功能在自己的 register 里登记一个开关，一行：

```ts
defineSwitch({ name: 'escalation', info: '派出的 agent 工具调用接连失败时，改用更强的模型；主 agent 这一轮的失败记下来，留给下一条消息', parts: ['counts'] })
```

`/dp` 的列表里会自动出现它，`/dp escalation off` 可以关掉它，状态存进 `$.store`，不需要别的接线。功能在要动手的地方用 `isOn(name)` 判断，例如 `if (!isPersonsMessage(e) || !isOn('main-effort')) return next(e)`。

- `isOn` 同时看总开关：总开关关着时它对所有功能都返回 false，功能不必再单独判断总开关。总开关关着时核心也自己放行：`prompt.submit` 不发决策请求，`turn.step` 不改写任何一步（锁定也不生效），band 上没有 Dispatch Pilot 的内容，脚部只写 `○ dp 已关`。
- 在发消息、每一步、事件发生的时候判断，不要在 register 里判断：register 时还没有读到用户保存的开关（`features/control.ts` 在 `session.start` 里读，热重载后会重新读）。
- `name`：小写字母、数字和 `-`，以字母开头；不能是 `/dp` 自己的词（`master`、`on`、`off`、`all`、`reset`、`status`、`help`、`lock`、`unlock`、`log`），否则登记时抛错。建议和功能的文件名一致。重复登记同一个名字会替换前一次。
- `info`：一行中文，显示在 `/dp status` 的列表和开关的回答里。名字是用户要输入的，保持 ASCII；`info` 是给人看的，不受字符宽度的限制，终端和别的端都用同一份（band、脚部和面板不再靠一行状态行，没有「只准单宽字符」这条约定）。
- `parts`（可选）：这项功能写在看板节点上的部分（`core/switches.ts` 的 `BoardPart`：`counts` 是失败计数，`checks` 是看图核对和截图接管的计数）。功能的决定和事件凭开关名就是它的（日志条目和 note 的 `feature`），不用登记。关掉这项功能时，画面（`hooks/board/`）在画的时候用 `isOn(name)` 和 `isShown(part)` 把它们都略过，`/dp` 经 `report(io, { switched: true })` 让画面重画一次；看板数据和决策日志不动，打开后照常出现。
- `default: false`（可选）：默认关闭；不写就默认开启。
- `$.store` 的 `switches` 里只存用户改过的、和默认值不同的开关（总开关的键是 `master`）。`/dp` 保存时只改动这一个开关，别的会话存下的其他项原样保留，未知的名字也保留（功能改名或回退版本时不丢用户的选择）。

### 记录一次决策

给人看的东西只由「决定汇报」module（`core/report.ts`，ADR 0004）写出：看板数据、决策日志、debug log 和 toast；画面（`hooks/board/`）只画这份数据。功能不拼状态文字，也不直接写决策日志：它只交一条结构化的决定。module 对外只有两个入口（GLOSSARY「决定汇报」），都不会抛错（存不进 `$.state` 时在 debug log 里说一声，决定和这一步照常生效）：

- **入口一，记一条决定：`report(io, what)`。** 功能（和画面）交给 module 的东西都走它，`what` 按种类打一个标签（`Reported`）：`{ decision }` 一个决定或没能决定的原因，`{ decisions: [..] }` 一次事件的几个决定，`{ tally }` 一路数着的计数，`{ switched: true }` 用户拨了开关（没有载荷，画面只是重画），`{ fellBack }` 用的决策模型不是要的那个（退回 Jev），`{ unplaced }` 用户按数字键要的面板没被放出来（画面交的，弹一个 toast）。`io` 按种类要的不一样（由 `what` 的种类算出，类型检查会拦住给错的；这个类型 `IoOf<R>` 不导出）：`switched` 只要 `SwitchIo`，`fellBack` 要 `DecisionModelIo`，`unplaced` 要 `NoticeIo`（debug、时钟、toast），其余是 `ReportIo`。
- **入口二，记一步读数：`reportStep(io, step)`。** 只有核心的 `turn.step` 调，见下面「入口二」。

一个 agent 的派出（`agent.spawn`）和结束（`turn.complete`）、看板的轮数（`turn.start`）由 module 自己的 hook 听（`registerReport`，入口文件最先注册），谁也不调，所以不算入口。`report.ts` 另外导出的 `decisionLine`、`callNodeId`、`callWorkflowOf`、`unplacedText` 和类型只是读写数据的形状，不写任何东西（`appendEntry`、`startTurn` 只在 report.ts 里用，不导出）。

**入口一：`report(io, { decision })`。** `$` 不能越过 import，所以调用方在自己的文件里用 `$` 搭一个 `ReportIo`（五个闭包），文件顶部写自己的字面量 ref：

```ts
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
// ...
const io: ReportIo = {
  board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
  decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
  debug: (line) => $.ui.log(line, { to: 'debug' }),
  now: () => $.clock.now(),
  toast: (text) => $.ui.toast(text),
}
await report(io, { decision: { feature: 'main-effort', agent: 'main', forTurn: 'next', subject: '"把登录模块重构成三层"', routed: true,
  outcome: 'effort high', effort: 'high', reason: '概率 low 0.05, ...；置信度 0.70', probs: { low: 0.05, /* ... */ max: 0.05 }, conf: 0.7 } })
await report(io, { decision: { feature: 'main-effort', agent: 'main', forTurn: 'next', subject: '"..."', routed: false,
  failure: { backend: 'jev', kind: 'timeout', detail: 'no answer in 800 ms' } } }) // 决策模型没给出决定
```

- 决定（`Decided`）：`feature`（开关名；报告开始的一轮写 `main-effort (agent report)`）、`agent`（`main` 或 agentId）、`outcome`（几个词：`effort high`）、`reason`（理由，一行中文）、`subject`（针对什么：消息的开头、agent 的 label）、`forTurn`、`routed`、`tone`（默认 `ok`），以及可选的 `probs`、`conf`、`trace`（规则推演）、`floor`、`forced`（失败时升模型：`kind` 是 `model`，`from` → `to`；0.8.x 还有中途重判的 `mid` 和升 effort 的 `forced`）、`skills`（skill 推荐：`suggest` 给主 agent 的，`try` 只能由用户触发的，即「可试 /x」，各带相关度）、`counts`（这个 agent 的失败、阻塞、升模型计数）、`aside`。每个决定写一条 debug log（`<outcome> · <subject>：<reason>`，和决策日志里的字一样）和一条决策日志（带 `at`：从那一轮开始的秒数，事件流按它排），并写到那个 agent 在这一轮的节点上（`decision` 是日志编号）。`routed: true` 同时清掉节点上旧的 `why` 和 `failure`。`trace` 直接交规则自己给出的步骤，不要另行计算：主 agent 的 effort 决定（`features/main-effort.ts`）带 `decideMessage` 的 `steps`，派出 agent 和 Workflow 里的 agent 带 `decideDispatch` 的 `steps`（`dispatchEvidence`，连同 `probs`；ADR 0015 起不带 `conf` 和 `floor`，band 上 agent 的理由读 `trace` 里的 `model-table` 和 `main-pick`）；升模型的决定不选档，不带 `trace`。
- 旁支决定（`aside: true`）：失败时升模型和 skill 推荐是主 agent（或某个 agent）那一轮的路由之外的决定：写决策日志和 debug log，不碰 agent 的节点（节点的 `decision` 链接、`routed`、`why` 仍是路由自己的）。同一个 agent 的节点上，这几项功能的计数另交 `{ tally }`。
- 没能做出决定（`NotDecided`）：带 `failure`（`{ backend, kind, detail, status? }`，后端名加 `Failure`）。它不进决策日志、不写 debug log（和以前一样，请求本身已经由核心记在 debug log 里），只写到 agent 的节点上：`why` 是简短的原因（`failureLine` 的中文，例如 `jev：1500 毫秒内没有回答`），`failure` 是完整的，`routed` 照 `routed` 字段。不是旁支的（这个 agent 的路由失败了）还弹一个 toast：一次事件最多一个，写谁没路由、`failureWords` 的几个字和 `failureLine` 的细节；离上一个 toast 不到 2 秒的不弹（看板上照样有；2.1.290 之前引擎会丢掉它，现在是 mod 自己限频）。
- `forTurn: 'next'`：在这一轮开始之前做的决定（`prompt.submit` 里，这条消息将开始一轮），归到将开始的那一轮；`'current'`（默认）：正在进行的这一轮，例如在一轮中途发的消息。轮数由 module 自己的 `turn.start` hook 数，只数主 agent 的（带 `agentId` 的是 agent 自己那个 loop 的一轮，2.1.299 起才有），从 1 开始。看板读不到时决定也照常记，记作第 1 轮，debug log 写 `board not read`（`tests/report.test.ts` 断言日志条目的 `turn` 是 1）。
- 什么也没决定、也不是失败的请求时（`Skipped`，必带 `aside`）：`skipped` 是 `unanswered`（回答里没有 skill 那一题）、`unread`（读不到会话的 skill）、`none`（没有可评分的 skill）或 `error`（插件自己出错，debug log 有）。不进决策日志，也不在节点上，在看板的 `notes` 里记一条 `{ turn, id, feature, at, after, kind: 'skipped', why: <skipped> }`，band 的事件流画它。旁支的失败（`failure` 加 `aside`，例如第二段 skill 请求失败、find_skill 的请求失败）同样记一条 note，`kind: 'failed'`、`why` 是 `failureLine`；不弹 toast（那个 agent 的路由还在）。
- 一个 agent 在看板上还没有节点时，第一份报告建它：主 agent 的名字是「主 agent」；其他 agent 带 `node: { kind, name, type }`。
- 一次事件有几个决定时（一个 Workflow 的几个 agent）交 `{ decisions: [..] }`：日志和看板各写一次，toast 也最多一个；`{ decision }` 是只有一条的特例。
- 决定的几种形状，都用 `feature`、`agent`、`subject`、`node` 说是谁的：`Decided`（上面）还可以带 `model`、`effort`（决定了的模型家族和档位，记在决策日志的条目上，不写到节点上：节点的 `model`、`effort` 只是读数，见入口二）；`NotDecided`（失败）；`Left`（`why`：没有请求失败、只是这个 agent 或 Workflow 按原样运行，例如「它的 prompt 要等脚本运行时才拼出来」「按路径提交，没有改写」；`offBoard` 是看板上没有什么可写的）；`Started`（`started: true`：它的决定早先为它的调用做过，现在 agent 启动了，不另记日志）。
- 节点的 `node.state`（`queued`：还没启动）、`node.workflow`（所属 Workflow）和 `replaces`（这个 agent 启动前，是哪个节点替它占着位置：新节点接过它的 `decision` 链接，旧节点撤掉）。
- Workflow 的 agent 启动前没有 id，所以脚本里的每个 `agent()` 调用在看板上占一个 `wf` 节点，状态 `queued`，id 是 `<Workflow 工具调用的 tool_use_id>#<调用的序号>`，`workflow` 是 `{ id: tool_use_id, name }`，`decision` 指向它的日志条目（条目上有决定的 `model`、`effort`）。整个 Workflow 没走路由（用路径或名字提交、脚本读不了、出错）是一个 id 为 `tool_use_id` 的节点，状态 `done`，`why` 说明原因。按 label 兜底时 agent 启动，节点换成 agent 自己（id 是 agentId，`replaces` 指向它的调用）；只认得出一个调用的才换，同一个 label 对应几个调用的不换。workflow-agents 写进脚本的调用：agent 第一步由读数认出它的 label 时，换掉名字相同、还在排队的调用节点（`reportStep`，同一个 Workflow 下）。

**入口二：`reportStep(io, { agentId?, model, effort?, source })`。** 一步发出的读数：模型（按家族记）、effort、有没有路由（`source` 是 `planStep` 的 `locked | planned | engine`）。只观察，从不改写。核心在 `turn.step` 里为每个 loop（主 agent、派出 agent、Workflow agent）的每一步调用它，传的是核心发出的模型和 effort；没有另外一个读数的 hook，也不放在核心之上或之下。`io` 是 `StepIo`（`ReportIo` 加 `agents`、`runDirs`、`journal`），核心自己写这些闭包（`$` 只跟进同文件的函数，不能传给 import 来的函数）。
  - 节点：agent 的节点在 `agent.spawn` 返回时（见下）或它第一步建；名字取 `$.agent.list()` 的 `name`，没有就取 `description`。Workflow agent 不在名单里，它的节点在派出时建（0.6.2 及以前在第 0 步读运行目录的 `journal.jsonl` 和 `agent-<id>.meta.json` 认）：名字是派出的 `description`（它的 label；没写 label 时是 prompt 的前 60 个字符，不处理），`kind: 'wf'`、`type: 'workflow'`，接替同一个 Workflow（按 Workflow 调用的 `tool_use_id`）里它的调用的节点，带上调用的决定和 `routed`，第一步按路由发出时去掉调用留下的 `why`。名单上没有、也没有派出的 loop（引擎自己的压缩、记忆 fork）不上看板；名单晚列出的 agent 记下第一次见到的时间（模块变量，热重载丢了的代价是起点晚一步），下一步或它这个 loop 结束时再认，起点（`t0`）仍是第一次见到的那一步。认不出的 loop 不是每一步都重查：没认出的记在模块变量 `missed` 里（热重载丢了的代价是这样的 loop 多查一次），名单只在它的第 2、4、8……步再查；它的 loop 结束时（`turn.complete`）再完整地认一次。
  - 保留：新一轮开始时（`startTurn`）只留本轮和上一轮的节点，此外还在 `running` 或 `queued` 的节点（Workflow 的 agent，和还没启动 agent 的调用节点）连同它那一轮的开始时间一起留着，最多 20 轮（report.ts 里不导出的 `LOG_TURNS`），和决策日志一样长；看板也显示更早轮次里还在跑的节点。以前只留两轮：Workflow 在后台跑、人又发了两条消息之后，agent 的节点和调用节点都被删掉，它的下一步在当前轮新建节点，照脚本跑的 agent（没有计划，`source` 是 `engine`）就显示「未路由」（tests/workflow-turns.test.ts）。被 TaskStop 停掉的 agent 会收到 `aborted` 的 `turn.complete`，所以不会一直挂着；停掉前没启动的 agent，它们的调用节点留到 20 轮，看板本来就不显示旧轮次里排队的调用节点。
  - 时间：`board.starts` 记最近两轮（和留下来的节点所在轮次）各自开始的 `$.clock.now()`（模块自己的 `turn.start` hook 写）；`t0` 是从它所在那一轮开始到 agent 第一步的秒数（主 agent 恒为 0；排队中的派出 agent 是 spawn 的时刻，第一步时改成第一步的时刻），`dur` 是它这个 loop 的 `turn.complete` 的 `durationMs`（秒）。一个 agent 在下一轮开始时还在跑，就留在它开始的那一轮的节点里继续更新；已经结束的 agent 再走一步，同一轮里重新变成 `running`（去掉 `dur`），隔了一轮就在新一轮建新节点。
  - **调用节点晚到。** 真实引擎在 Workflow 工具返回之前就派出运行的第一个 agent，而 workflow-agents（#8）在工具返回之后才报它的调用，所以 agent 的节点可能先建、接替不到调用（0.7.0 在 herdr 里实测看到过两行同名的 sleeper，一行「未路由」一行「排队」）。`withNode` 收到调用的决定时（`lateCall`），先看这一轮里有没有还没归属任何 Workflow、没有决定、名字是这个 label（或合它的模板）的 `wf` 节点：有就把决定和 Workflow 记到这些 agent 节点上，不再建排队的调用节点（模板调用照旧留一个已开始的节点给后面的 agent）。`tests/workflow-spawn.test.ts` 用 `workflowWorld` 的 `during`（工具返回前派出、不等它）复现这个时序。
  - 状态：`queued`（`agent.spawn` 返回了 agentId，还没走第一步）→ `running`（每个读数）→ `done`（`turn.complete` 的 `reason` 是 `answer`）或 `failed`（`error`、`refusal`、`aborted`；没有别的原因时 `why` 写 `出错`、`拒绝回答`、`被中断`，即 `ENDED_WORDS`）。Workflow agent 的 `turn.complete` 实测会触发（2.1.291，带 `agentId`，`reason: 'answer'`），主 agent 的那一轮可以比它们先结束。
  - 变化事件：同一个 agent 同一轮里，读数（模型的家族，或 effort）和上一步不同才在 `board.changes` 记一条 `{ turn, id, at, after, from, to }`（`at`：从那一轮开始的秒数；`after`：这时决策日志最后一条的 `n`，事件流按它把变化排在决定之后）。第一次读数不算变化；`claude-sonnet-5` 和 `claude-sonnet-5-5` 同一家族不算；不带 effort 的读数照常记，换到别的家族是一条变化。
  - 生命周期的三个 hook（`registerReport`，都只看不改）：`turn.start`（主 agent 的轮数和开始时间，带 `agentId` 的放过）、`agent.spawn`（`next` 返回后给 agent 建一个排队的节点，别的功能先建了就只改成排队；Workflow agent 的节点接替它的调用的节点，只在 Dispatch Pilot 开着时建）、`turn.complete`（节点的 `done`/`failed` 和 `dur`）。

**计数：`report(io, { tally })`。** 功能一路数着的计数，不是决定：`escalation` 每个循环（主 agent 或某个 agent）的失败、阻塞、升模型计数，写到那个 agent 本轮节点的 `counts`（全是 0 时去掉；一轮开始时主 agent 的计数归零，不用另外交什么：每一轮的主 agent 是一个新节点，计数从零数起）。节点没变就不写看板；没有节点的 agent 循环不是看板上的 agent（节点由 `agent.spawn` 和读数建），它的计数不上看板，主 agent 的节点没有就建。（0.8.x 还有中途重判的计数，写到节点的 `midturn`，回答迟到和请求失败各记一条 note；0.9.0 删了。）

**开关：`report(io, { switched })`。** 用户用 `/dp` 开关时交给 module（只有 `features/control.ts` 用）：`{ switched: true }`，没有载荷，开了哪个、开还是关，画面在画的时候自己读开关。`io` 是 `SwitchIo`，只有 `redraw: () => $.ui.invalidate('ui.render')`：画面在画的时候读开关（`isOn`、`isShown`），开关一变就重画一次。看板和决策日志不动。

**一个写入者。** 没有文件调用 `$.ui.status`（终端不再用它，#29），`report.ts` 也不例外；toast 只由 `report.ts` 弹，各文件只以 `toast: (text) => $.ui.toast(text)` 这个交给 `ReportIo` 的闭包碰 `$.ui.toast`；旧的 `setStatus`、`pauseStatus`、`recordDecision` 都已删除。`eval/validate.ts` 的一个写入者检查（`checkOneWriter`，`tests/docs-sync.test.ts` 测它）读 hooks/ 全部源码（`.ts` 和 `.tsx`）来保证这一点。后端失败的一句话有两份，都在 `decision/backend.ts`：`failureText` 是英文，给模型看的文字（Workflow 的改写说明、启动说明、find_skill 的回答）和 debug log 用它，一字不改；`failureLine` 是中文，看板的 `why`、日志的理由、事件流和 toast 用它。band 上的短原因是 `failureWords`，卡片上失败类型的说明是 `failureMeaning`：这几样给人看的字（`failureLine`、`failureWords`、`failureMeaning`）出自 `decision/backend.ts` 的同一张表 `FAILURE_WORDS`，按 `Failure.kind` 排；`failureText` 是给模型的，不在表里，一字不改。

- debug log 里那一行是 `<outcome> · <subject>：<reason>`；`/dp log N` 里是 `#<n> <feature>：` 加同样的一行。
- 只记决定，不记失败的请求：请求的结果已经由核心写进 debug log。升模型（和到了门槛却没升）、派出 agent 的模型选择、skill 推荐，都应该各记一条。
- 决策日志保留最近 20 轮（按条目的 `turn`）、最多 300 条，更早的丢弃；看板的节点只留当前一轮和上一轮。

### 语言：给人看的是中文，给模型看的是英文（#32）

- **给人看的**：看板、依据面板、决策日志（`outcome`、`subject`、`reason`）、toast、`/dp` 各子命令和各开关的回答、开关的 `info`、README、`plugin.json` 里的说明，一律中文，用词照 GLOSSARY。模型名和 effort 档名照 `/model`、`/effort` 的写法（`sonnet`、`xhigh`）；`agent`、`skill`、`Workflow`、`effort`、`prompt` 这些 GLOSSARY 里保留的词照用。不留英文缩写：`HTTP 401` 写「状态码 401」，`ms` 写「毫秒」，`p` 写「概率」，配置项的内部名写成它的意思（「推翻门槛」而不是 `agentOverride`）。用户要输入的名字（开关名、命令的参数、配置项名）保持原样。画面上怎么称呼一项功能只有一张表：`view.ts` 的 `FEATURE_WORDS`（用 GLOSSARY 的词：失败升模型、Workflow 兜底、skill 推荐、skill 查询……），band 的事件流和依据面板的日志都用它。
- **给决策模型的问题**：0.9.0 起两个决策模型的所有问题都用英文（ADR 0014，TypeSafe 的官方指南：英文是 Jev 最准的语言）；模块里的中文写法留给评测的 `zh-` 变体。
- **给模型看的**：Workflow 的改写说明、退回说明和启动说明、skill 推荐的文字块、`find_skill` 的回答和工具描述、列表位置上的提示、Workflow 工具描述后面的常驻提示，一律英文，一字不改。`tests/model-facing.test.ts` 钉住两种 Workflow 说明（改写、退回）和失败的话的英文写法（`failureText`、`leftText`、`whyOf`）；skill 推荐的文字块、`find_skill` 的回答和启动说明由 `skills.test.ts`、`skill-ranking.test.ts`、`find-skill.test.ts`、`workflow-labels.test.ts` 逐字断言。
- **同一个概念给人和给模型的两份文字分开写**：`callName` 和 `callTitle`、`outcomeOf` 和 `callResult`、`leftText` 和 `leftWords`、`failureText` 和 `failureLine`，前者给模型（和 debug log），后者给人。改给人的一份，不要碰给模型的一份。
- **debug log 的诊断行**（请求的结果、`session.measure` 的读数、错误、画面没画出来的原因）是写给开发者的，保持英文。「决定」那一行和决策日志是同一份文字，所以是中文。
- 界面要判断一条日志是什么时，看结构化的字段（`sentBack`、`forced`、`mid`、`skills`、`model`、`effort`），不要去匹配文字：主 agent 的 effort 决定也带 `effort`，band 和面板的档位都由 `view.ts` 的 `levelOf` 从这些字段读（`effort`，没有就是规则推演最后一步的 `level`），不读 `outcome`；`view.ts` 里只剩一处按「（Workflow 名）」取名字的回退，节点上有 Workflow 的信息时不用它。
- `tests/human-words.test.ts` 断言失败的话的中文，并扫一遍一轮之后看板、日志和 `/dp` 的回答里没有留下 `HTTP`、`thetaMax`、`kept`、`confidence` 这类英文。

### 会话的读数

`session.measure` 的读数（上下文占用、限额百分比、花费）由 `features/control.ts` 在每次变化时写一行进 debug log，开关名 `signals`，没有别的出口。它们只是记录：没有任何地方读它们来做决定，也没有写进 `$.state`。以后做「省额度模式」时，再决定怎么用。

### skill 目录、排序和推荐（#10；#11、#12 在这里扩展）

**skill 目录**（`core/skills.ts`）。`loadCatalog(io)` 返回本会话的 skill，每个是 `CatalogSkill { name, description, by, source, file }`（#11 加上了 `file`）：

- `by: 'model'`：主 agent 能用 Skill 工具加载的 skill，即引擎给主 agent 的 skill 清单，由 `$.session.usage({ breakdown: 'summary' }).context.breakdown.skills.skillFrontmatter` 给出，顺序也照它。它在 `session.start` 时就能拿到，和主 agent 收到的列表完全一致，已经算进了 `skillOverrides`（实测）。
- `by: 'person'`：只能由用户本人触发的 skill。条件是：在 `$.command.list()` 里（来源是 user 或 plugin）、不在上面的清单里、SKILL.md（或命令文件）的 frontmatter 写了 `disable-model-invocation: true`，并且没有被 `skillOverrides` 设成 `off`。文件按 Claude Code 的布局找：项目和 `~` 下的 `.claude/skills/<name>/SKILL.md`、`.claude/commands/<name>.md`；插件的从 `~/.claude/plugins/installed_plugins.json` 查安装路径。`skillOverrides` 按来源（user、project、local、flag、policy）逐个读、逐个名字叠加，因为 `$.command.list()` 仍然会列出设成 `off` 的 skill。
- `name` 一律用列表里的写法，也就是 Skill 工具接受的名字。同步来的 skill 在 `skillFrontmatter` 和 `$.command.list()` 里叫 `computer-use`，在列表里叫 `anthropic-skills:computer-use`（个别本来就带前缀，例如 `anthropic-skills:deep-research`）。`description` 取自 `$.command.list()`，除了少数内置 skill 的列表描述后面多一段 when-to-use，其余都和列表一字不差。
- `file`（#11）：这个 skill 的 SKILL.md（或命令文件）在磁盘上的位置，第二段读正文开头用它；找不到时是 `null`（内置 skill 没有文件）。主 agent 能加载的 skill 按清单给的来源找：`userSettings` 在 `~/.claude/skills/<name>/SKILL.md`（或 `~/.claude/commands/<name>.md`），`projectSettings`、`localSettings` 在工作目录的 `.claude/` 下，`plugin` 从 `installed_plugins.json` 查安装路径（`pluginName` 给出插件名），在插件 manifest 的 `skills` 写明的目录（例如 ui-ux-pro-max 的 `./.claude/skills/`）和 `skills/` 下找，`syncedSkills` 在 `~/.claude/skills/synced/<账号>/<名字>/SKILL.md`（账号目录用 `$.fs.list` 列出，所以 `CatalogIo` 多了 `list`）。只能由用户触发的 skill 记下判断它时读到的那个文件。本机实测：66 个能加载的 skill 里 53 个找到文件（13 个内置的没有），21 个只能由用户触发的都有。
- 目录存在 `$.state` 的 `skillCatalog`，一段对话读一次：`session.start`（在 `next(e)` 之后，其他插件的命令已经登记）重新读；没读到时，第一次用到它的 hook 再读；`session.end`（包括 `/clear`）清空。`find_skill`（#12）读 `$.state` 的 `skillCatalog`；`skills` 开关关着时会话开始没有读目录，`find_skill` 第一次被调用时自己读，并存进 `skillCatalog`。命令轮的 effort 判断（`features/main-effort.ts`，#19）只读不写：从里面取命令的描述，目录没读过时改用 `$.command.list()` 的描述。两处都用 `loadCatalog(io)`，各自在自己的文件里用 `$` 构造 `io`（`$` 不能跨文件）。
- 读不到命令或清单时 `loadCatalog` 抛错，功能放行：不问 skill，也不隐藏列表。某个 settings 来源或某个文件读不到时，只是少了那一部分。

**排序**（`decision/skills.ts`，纯模块，mod 和评测共用；ADR 0018）。**排序入口只有一个：`modRanker(io, settings)`**，发消息时的推荐（`features/skills.ts`）、`find_skill`（`features/find-skill.ts`）和评测（#16）都用它：

```ts
const ranker = modRanker(
  {
    ask: (request, timeoutMs) => ctx.backend.ask({ fetch: (u, i) => $.http.fetch(u, i), sleep: (ms, s) => $.clock.sleep(ms, { signal: s }) }, request, timeoutMs),
    opening: async (option) => { const file = catalog.find((s) => s.name === option.name)?.file; return file ? skillOpening(await $.fs.read(file)) : null },
  },
  rankingSettings(ctx, 'message'),                          // core/skills.ts：问不问门控、短名单几个、第一段的 token 预算、timeoutMs、决策模型的门槛
)
const part = ranker.part(options)                           // 第一段的问题，放进投票箱或自己的请求
// ……发出请求，拿到 answers……
const ranking = await ranker.rank(answersFor(part, answers), options, { state: request.state, timeoutMs })   // 第二段：同一个 state
const { suggest, hint } = pickSkills(ranking, options, ctx.config.guide.skills)
```

- `io` 是闭包：`ask` 发一个决策请求（不抛错），`opening` 读一个 skill 的 SKILL.md 正文开头（`skillOpening`：去掉 frontmatter、折叠空白、脱敏、取前 `EXCERPT_CHARS` 700 个字符，cookbook 的 `body[:excerpt]`）。两处调用方各自在 hook 里用自己的 `$` 构造（`$` 不能跨文件）；评测用 Node 的 `fetch` 和 `readFileSync` 构造。
- `rankingSettings(ctx, kind)`：`'message'` 问门控、短名单是 cookbook 的 `SHORTLIST` 3；`'find'` 不问门控、短名单是 `findSkillMax`。门槛是 `ctx.config.guide.skills`（`decision/guides.ts` 的 `SkillBars`：`gateBelow`、`fits`、`fitsInclusive`；TypeSafe 0.30、0.30、含等号，Liquid 0.2、0.5、不含）。
- `part(options)`（第一段，`skillsPart`）：`skills.which` 是主 agent 能加载的 skill（`by: 'model'`）的选择题，`skills.hint` 是只能由你触发的（`by: 'person'`），各自有两个以上候选时才问（只有一个时它直接进第二段），问题是 cookbook 的原话，每个选项用它自己的描述，没有 `(none)`；问门控时再加三道是非题 `skills.gate.acts_on_user_system`、`skills.gate.would_follow_documented_procedure`、`skills.gate.prose_suffices`（cookbook 的原话）。选择题超出 `questionBudget` 时，每个描述截到同样的 token 数，取放得下的最大值。
- `rank(answers, options, { state, timeoutMs? })`：先读门控（`readGate`：三道的平均，`prose_suffices` 反过来算），问了却没有回答就返回 `null`；平均低于 `gateBelow` 就返回 `stopped: 'gate'`，不发第二段。再读两道选择题，各取概率最高的 `shortlist` 个（cookbook 不设下限），一起进入第二段（`stageTwoPart`：同样的两道选择题，每个选项是 `描述 — 正文开头`；每个候选一道 `skills.fits.<i>`，cookbook 的原话 `Does the skill '<名字>' do the specific thing the user's request asks for? It is described as: <描述>`）。返回 `SkillRanking { gate, shortlist, hints, fits, winner, hintWinner, shares, stopped?, failed? }`；第二段失败（超时、出错、回答里没有 `fits`）时带 `failed`，什么也不推荐。
- `pickSkills(ranking, options, bars)` 是 cookbook 的 `suggest()`：每一类里相关度最高的过了门槛，就推荐第二段选择题选中的那一个（相关度是它自己的），能加载的最多一个给主 agent，只能由你触发的最多一个给看板（「可试 /x」）。`findSkills(ranking, options, bars, max)` 是 `find_skill` 的：能加载的候选里相关度过了门槛的都返回，从高到低，最多 `max` 个。`relevanceBlock(pick, described)` 是 cookbook 的 `suggestion_block`：推荐时 `Relevant to the current request: <名字>. Ignore this if it does not fit what the user actually asked for.`，`described` 里没有的 skill 另起一行写描述；不推荐时 `No skill in the roster appears relevant to this request.`。
- 发消息时：`features/skills.ts` 在 `prompt.submit` 里构造 ranker，`part` 放进投票箱，并记下 `$.clock.now()`；`settle` 里用剩下的时间作为第二段的超时（两个请求共用一次等待，hook 也不会超过 10 秒的预算），调用 `rank`，第二个请求写一行 debug log（`second skills request [...] to jev: ...`）。`find_skill` 在自己的 `tool.call` 里做同样的事，只有一个能加载的 skill 时不发第一段，直接进第二段。

**评测（#16）**。`skillsRequest(item, options, { limits, ranker? })` 用 `item = { message, recent_context }` 拼出 mod 发出的同一个第一段请求：共用的 state 和 skill 的问题（同样按 `questionBudget(limits.tokens)` 控制大小）；effort 题不在里面，它有自己的请求（ADR 0005）。评测的 suite（`eval/lib/skill.ts`）只有一个变体 `cookbook`，用 `modRanker` 和 `rankingSettings(..., 'message')` 发两段请求，和 mod 逐字相同。

**`$.state` 里的 skill 记录**（契约见 `types/index.d.ts`）：

| key | 内容 | 由谁写 |
|---|---|---|
| `skillCatalog` | 本会话的 skill 目录 `{ skills }`，每个 skill 带 `file`；`null` 表示要重新读 | `features/skills.ts`（读目录）；skills 没读时，`features/find-skill.ts` |
| `skillsShown` | 这段对话里描述过的 skill（再推荐时只写名字）；`/compact`、`/clear` 后清空 | `features/skills.ts` |
| `skillListing` | 对主 agent 列表的回答：`withheld`（换成了提示，记下引擎的原文）、`passed` 或 `restored`（开关关掉后已经随消息补给主 agent） | `features/skills.ts` |

**列表的提示**（`features/skills.ts` 的 `LISTING_HINT` 和 `LISTING_HINT_WITHOUT_FIND_SKILL`）。`prompt.attachment` 拦下主 agent 的列表时，回答 `trimListing` 留下的常驻清单（引擎的标题加 `skillsAlwaysListed` 里的条目），空一行，再接提示；没有常驻清单时只有提示。用哪一句由回答时的 `isOn('find-skill')` 决定：skills 功能在自己的文件里写 find-skill 的开关名（字面量），不在 register 里判断。debug log 那一行末尾写 `the note names find_skill` 或 `the note leaves find_skill out (switched off)`。两句都是常量：不拼进 skill 的名字、数量或任何会话内容。改它们的文字会改变每个会话第一条消息的前缀，测试（`tests/skills.test.ts`）里有一字不差的原文，要一起改。kit 每次 `w.listing()` 都会重新调用 hook，不模拟引擎「整段对话沿用一个回答」，所以测试只能断言回答稳定、按回答时的开关选句，不能断言「对话中途不变」。

### find_skill（#12）

- **注册。** `session.start`（matcher `{ cwd: /(?:)/ }`，在 `next(e)` 之后）调用 `$.tool.register({ name: 'find_skill', description, inputSchema })`，输入只有必填的字符串 `query`。没有配置决策模型（`ctx.backend.configured === false`）时不注册。描述和 schema 都是常量，不拼进任何会话内容，开关变化也不重新注册。注册被拒绝时在 debug log 说一声；引擎给的全名不是 `mcp__dispatch-pilot__find_skill`（hook 的 matcher 就对不上）时也说一声。
- **回答。** `tool.call` 的 matcher 是 `{ tool: 'mcp__dispatch-pilot__find_skill' }`。hook 直接返回 `{ result: <文字> }`，从不调用 `next`（没有别人回答这个工具，落空的调用会失败）。照官方文档的写法，失败也作为普通的 `result` 返回，用文字说明，不用 `isError`。
- **请求。** state 是 `turnStartState({ prompt: query, messages: $.session.messages(), limits: ctx.config.context })`；问题是 `modRanker(io, rankingSettings(ctx, 'find')).part(candidates)`：只有 `skills.which`，不问门控（主 agent 已经在要 skill）；候选是目录里主 agent 能加载的 skill 去掉 `skillsNeverSuggested`，所以这一题和发消息时的 `skills.which` 一字不差；只能由你触发的 skill 不问（它们反正不返回）。只有一个候选时没有选择题可问，不发第一段，直接进第二段。请求带着 `ctx.config.skills.findWaitMs`（Jev 是 `timeoutMs`）发给 `ctx.backend`，回答连同这个请求的 `state` 交给 `ranker.rank`，第二段用这段等待剩下的时间，选 Jev 时至少 800 毫秒（`secondStageMs`，两段合计不超过 8000 毫秒），短名单是 `findSkillMax` 个，再经 `findSkills(ranking, candidates, ctx.config.guide.skills, findSkillMax)`，返回相关度过了门槛的、从高到低。第二段失败（`ranking.failed`）和第一段失败一样回答「无法评分」。`io` 的 `ask` 和 `opening` 在 `tool.call` 里用这次调用的 `$` 构造。
- **判断顺序。** 总开关、`find-skill` 开关、派出 agent（`e.agentId`，指回它自己的列表）、空查询：这几步不发请求，看板上也没有记录。之后读目录、发请求，结果记进决策日志，失败原因记成看板的 note。
- **日志。** 每次发出的请求写一行（`request [skills.which] to jev for find_skill "<查询>": ...`，第二段是 `second request [skills.which, skills.fits.0, ...] to jev for find_skill "<查询>": ...`）；得到排序后用 `report(io, { decision })` 记一条旁支决定（feature `find-skill`，outcome `查到 <名字>` 或 `没查到 skill`，reason 是 `describeStages` 写出的两段结果和门槛，`skills.suggest` 带名字和相关度）。失败只有请求那几行和看板上的一条 note，不进决策日志。
- **自己出错时。** 读 `$.state` 失败这类错误由 hook 捕获，照样回答失败，并在看板（note）和 debug log 说明，不让调用落空。

### 决策后端

`decision/backend.ts` 定义统一接口：`ask(io, request, timeoutMs)` 返回回答或失败，从不抛错，并自带超时。两个实现发出的请求一样（`model`、`state`、`questions`），问题部分不需要为后端改动：

- `jevBackend(apiKey)`：`POST https://api.typesafe.ai/v1/systemone`，Bearer 认证，回答在响应的顶层 `answers`。`apiKey` 和 `pplxBackend` 的一样，可以是字符串，也可以是每次 `ask` 时才取的函数。
- `pplxBackend(apiKey)`（`decision/pplx.ts`，#43）：Perplexity 的决策模型 `pplx-decider-v1.1-27b`，`POST https://api.perplexity.ai/v1/decisions`，Bearer 认证。请求体只有 `model`、`state`、`questions`（多一个顶层字段文档说返回 400），问题部分和 Jev 一字不差；回答在顶层 `answers`，`score` 的 `legend` 和 `probabilities`、`choice` 的 `probabilities` 都按字符串下标或选项名，`readResponse` 照常读。mod 里用 `decisionModel` 选它（#50），#52 起它是默认。模型名固定（API 只认 `pplx-decider-v1.1-27b` 和 `pplx-decider-v1-27b`，没有 `-latest`）。失败：401 和 403 记 `config`；402（账号没有额度）记 `quota`；429、500、502、503、529 记 `busy`（429 的说明带 `Retry-After` 的秒数）；504 和 408 记 `timeout`（504 是模型一分钟内没答，body 可能是 HTML，说明里写「an HTML page, not JSON」，不抄进日志）；其余（400、413、404、405）记 `http`，说明是 `error.type: error.message`，404 和 405 的 body 是空的写「empty body」；2xx 不是 JSON 或没有 `answers` 记 `parse`；说明里出现密钥的地方换成 `[REDACTED]`。实测（2026-10-07 探针，`tests/pplx.test.ts` 按文档的响应写）：`instructions` 是对象或数组、问题带多余字段、问题 ID 带点号、Choice 的描述是对象，API 都照收（200），所以 mod 的请求原样可发；Score 只有一档时 `usage.input_tokens` 是 0。
- 两个后端都包着各自账号的限速：pplx 的 `rateLimited`（「限速和 429」），Jev 的 `jevRateLimited`（「Jev 的限速」）；Jev 的 429、529 带 `Retry-After` 时 `httpFailure` 把它读成 `retryAfterMs`。
- `liquidBackend(apiKey)`（`decision/liquid.ts`，ADR 0017）：Liquid 的 `d1-ultra`，`POST https://api.liquid.ai/decisions/v1/systemone`，Bearer 认证，请求和回答都是 Jev 的（共用 `postJson`、`readPosted`）。固定模型 `d1-ultra`，不带长上下文头，不收图和 Box 题（图走 Jev）。key 是 `liquidApiKey` 或 `LIQUID_API_KEY`。没有 mod 自己的限速：Liquid 每个模型每秒 20 个请求、所有 key 共用，429 读成 `busy`（看板写「被限速」）。eval 的 `lib/d1.ts` 是它换了名字（`d1`）的一份。
- `core/setup.ts` 的 `setup()` 三个后端都建，`ctx.backend` 每次按 `chooseBackend` 取其中一个（见「pplx 的默认值和密钥」的「选哪个决策模型」）；一次请求失败时不会改用另一个，只有没有 Perplexity key 才用 Jev。
- `Backend.configured` 为 `false` 表示用户还没配好这个后端（Jev 没有 key），这时它的每次 `ask` 都会立刻以 `config` 失败返回。拿东西去换决策的功能，在这种情况下不应该动手：skill 推荐在这时不隐藏列表。新增后端时，要按自己的凭证设置这个字段。

失败的分类见 `Failure.kind`（`config`、`timeout`、`network`、`busy`、`quota`、`http`、`parse`、`request`；HTTP 402 是账号没有额度，TypeSafe 和 Perplexity 都这样回，归 `quota`，不再落到 `http`；Jev 的限速层挡住而没发出的请求，在暂停比它的等待还长时归 `busy`），对应的一句话见 `decision/backend.ts` 的 `failureText`。要给第三个后端留位置时，同样新建 `decision/<name>.ts` 实现 `Backend`，再在 `setup()` 里加一个分支。

### 画面（看板）

`hooks/board/` 画「决定汇报」的数据，自己不写看板（只写看板之外的两个视图状态：`$.state` 的 `selected`，band 上数字键或面板上 p / n 选中的 agent；`paneView`，依据面板里折叠或展开的轮、非终端端是否展开开关；都只在按键的 `onPress` 里写）。`screens.tsx` 有三个 `ui.render` hook（`AbovePrompt`、`SessionMode`、`Pane` 加 `requestId: 'dp-rationale'`，各带 matcher），按 `e.surface` 分支：`marksOf` 把这个端的标记交给 `bandTree` / `paneTree`（画时间色带、概率条和置信条：终端是 `Raster`，其他端是 `Svg`），其他端另外有脚部标签的预算 `TAG_CHARS` 24、面板的日志按 `WINDOWS` 开窗口（树超过 1800 个节点就换小一档，因为 Desktop 页面拒收 2000 个）、band 自己的折叠和「依据」按钮（代替 `/dp log` 和数字键的提示）、面板自己的「关闭」（`role: 'dismiss'`）、不写按键的按钮文字；band 和脚部都先 `await next(e)`，把引擎和别的 mod 的内容放在前面。画的时候从 `$.state` 读 `board`、`decisionLog`、`selected`（画的时候读就订阅了，数据一变宿主就重画），交给 `view.ts` 的 `screenView` 算出 `ScreenView`（哪一轮、agent 行、事件流、一轮结束后的摘要），`band.tsx`、`footer.tsx` 只画它。有 agent 在跑时，终端每 `TICK_MS`（200 ms）、其他端每 `SLOW_TICK_MS`（5 s）用 `$.clock.after` 要一帧（转圈、用时、色带），没有在跑的就不再要。其他端重画得慢，是因为每次重画都给按钮换新 handle，Desktop 按下时带的是它正显示的那棵树的 handle，中间被重画过就丢了这次按键；所以其他端不转圈（`spin` 画成不动的 ●），在跑的色带画成可交互的 Svg，用 SMIL 动画自己长到下一帧的位置（`RibbonBar.grow`，时间轴也放宽到下一帧）。终端的 band 不超过 16 行；多出来的 agent 和事件各折成一行（「另有 N 个 agent」「更早 N 个事件」），留下主 agent、在跑的（按开始先后，保住数字键）和最新的两个事件。行宽按 `bodyColumns` 分配：状态格、effort 先变窄，不到 6 格时去掉时间色带，所以一行永远不折行；固定宽度的格子都 `flexShrink={0}`。新增要在看板上显示的东西，先扩充决定或 note 的结构（`report.ts`），再在 `view.ts` 里算、在 `band.tsx` 里画。

依据面板（`pane.tsx`，从 `rationale.ts` 的纯函数取东西画）用的是同一个 `ScreenView`：卡片是 `view.rows` 里选中的那一行（没选、或选中的已经不在看板上时是主 agent），p / n 沿 `view.rows` 移动、到头停住；卡片上的决定是节点的 `decision` 指向的日志条目，升模型是同一个 agent 的 `escalation` 条目（带 `forced`）。规则推演的每一行由 `stepLines` 从存下的步骤（`trace`）写出，生效与否看步骤自己的 `applied`。不要从 `probs` 或配置里的门槛重新算：卡片要和规则的实际行为一致（ADR 0004、#23）。面板里没有截断：名字、理由、主题都放进带固定宽度标签列的行里换行（`hang`），`Text` 一律 `wrap="wrap"`；概率条和置信条在 8 到 20 格之间随宽度变化；卡片不到 48 格宽时（窄终端上的内联面板），模型标签和 effort 移到名字下面一行。失败的请求在卡片上分几行写：类型（`Failure.kind` 的中文意思）、后端、细节（`failureLine`）、去 debug log 哪里看。打开面板的地方有三处：`/dp`（开关，`focus` + `closeOnEscape`）、`/dp log`（只打开）、band 的数字键（`onPress` 里打开，不要 `focus`，这样下一个数字键还在 band 上起作用）；`$.ui.open` 回答 `isPlaced: false` 时都立刻 `$.ui.close`，并告诉用户为什么、可以去哪里看（`unplacedText`）：命令在回复里说；数字键没有回复可写，交给「决定汇报」一个 `{ unplaced: { reason } }`，由它写 debug log、弹一个 toast（守同样的 2 秒：离上一个 toast 不到 2 秒的不弹）。面板的字母键只在面板拿到键盘时起作用（ctrl+x tab 或 `/dp`）。其他端不用按键：`/dp` 只在会话有终端时带 `focus` 打开（`focus` 只能写 true 或不写），面板画成 `pane-app.tsx`，开关和锁定在面板里点。

**比 spec 多出来、定下来保留的几处**（#22 的代码审查之后确认，改之前先问）：

- band 的事件流除了决定和改档，还画 `board.notes`（旁支请求失败、什么也没给的跳过、回答迟到）和每次 `find_skill` 的查询：这些以前只在状态行出现，状态行去掉后没有别处可写。
- 依据面板顶部除了每项功能的开关，还有一行锁定（`/dp lock` 时写锁在哪一档、怎么解除）：锁定盖过一切决定，看依据的人需要先知道它。
- `/dp off` 时脚部写 `○ dp 已关`，不是什么也不画：spec 说关掉的功能不出现，但整个 mod 关着时脚部要让人看出它关着，否则和「还没有一轮」分不清。
- debug log 里「决定」那一行是中文（`<outcome> · <subject>：<reason>`，和决策日志、`/dp log N` 是同一份字），诊断行（请求的结果、`session.measure` 的读数、错误、画面没画出来的原因）是英文：见上面的「语言」。

### 配置项

在 `.claude-plugin/plugin.json` 的 `userConfig` 里声明。每个选项都只在 `core/setup.ts` 的 `readConfig` 里读一次，用 `numberIn`、`stringOf`、`namesOf`（setup.ts 里的读取函数，不导出；写摘要的默认模型 `DEFAULT_SUMMARY_MODEL` 也是文件内的常量）做类型检查和范围截断，结果放进 `Config`（按功能分组，例如 `escalation`、`agents`、`skills`、`unresolved`），功能和评测都从 `ctx.config` 读，所以范围和缺省值只写在这一处（缺省值就是 manifest 的默认值）。功能的 register 里不再读 `options`。

**按决策模型取的默认值（#17）**只写在 `core/setup.ts` 的 `BACKEND_DEFAULTS` 一张表里：`PER_BACKEND_OPTIONS` 列出的 3 个选项（`timeoutMs`、`contextMessages`、`contextTokens`；`skillsMinRelevance`、`findSkillMinRelevance` 0.9.0 删了，ADR 0018；`thetaMax` 0.9.0 删了，ADR 0014；`agentOverride` 也删了，ADR 0015）各一个默认值，另有几个不是配置项的值：`contextTokensMax`、`contextMessagesMax`（`contextTokens`、`contextMessages` 读到的上限）、`contextByKind`（其余种类请求的 state 预算）、`roundUp`、`agentBackground`、`longWaitMs`、`agentLanes`、`findSkillWaitMs`（`find_skill` 两个请求合计等多久，读成 `ctx.config.skills.findWaitMs`）、`guide`（各家的读法，含 skill 的两道门槛，`decision/guides.ts`），以及 `ask`（问题怎么问：`turnStart` 是发消息时 effort 问题，Jev 中文；读成 `ctx.config.ask.turnStart`，只有 `features/main-effort.ts` 用；`agent` 是派出 agent 和 Workflow 里 agent 的问题；其余问题照 `ctx.ask`，即 `ask.other`）。`skills` 开关的默认值不在这张表里：`features/skills.ts` 的 `defineSwitch` 不写 `default: false`，所以恒默认开，两个决策模型一样（register 时还不知道用哪个，没有 `suggestSkills` 这个值）。这 12 个选项在 manifest 里**不写 `default`**：引擎交给 `register` 的选项是「填好默认值的」，写了就分不清你没设和你设成了默认值。没写默认值的字段，你不设时引擎不传（生成的类型 `.claude-plugin/types/` 里 kit 的 `TestOptions` 写明它和加载时一样：unlisted values unset, defaults filled in；`tests/backend-defaults.test.ts` 在 kit 里确认；2026-10-05 用 `claude -p "/dp" --plugin-dir ./dispatch-pilot` 在真实引擎里确认过，debug log 那一行写着当时的 11 项（`rejudgeWaitMs` 后来才加进来）都取了 Jev 的默认值；日志没有提交，见 `eval/plans/17-calibration.md` 的 8.8.1），`readConfig` 按 `decisionModel` 在表里取。`readConfig` 还记下哪些选项用了默认值、哪个被截到上限（`Config.defaults`），`features/control.ts` 在会话开始时把它写进 debug log（`describeDefaults`）。评测和 `scripts/decide*.ts` 经 `eval/lib/suite.ts` 的 `optionsFor(backend, ...)` 把决策模型交给 `readConfig`，取的是同一张表。要给某个后端改默认值，只改这张表，再改 README 的配置表（`node dispatch-pilot/eval/validate.ts docs` 核对它的 Jev 列是否和这张表一致）和上面「配置」里的校准依据。manifest 里这 12 个选项不能写 `default`，那个核对也会报。敏感字段在没有配置时是空字符串。取值固定的字符串（例如 `decisionModel`）在 manifest 里用 `options` 声明，在 `/config` 里是下拉选择；填了列表之外的值，引擎读作默认值并给出警告，mod 里不必再处理。

### 测试怎么写（接缝 1）

测试只看 mod 对外的行为：发进事件，检查到达引擎和决策后端的东西，包括每一步的 effort 和 model、请求的内容、附加的 context、看板数据（`w.board()`）、toast（`w.toasts`）和 debug log；画面用 `w.band({ columns, rows, isWorking, surface })`、`w.footer({ modes, surface })`、`w.pane({ columns, rows, placement, surface })` 经 `$.ui.mount` 画出来，按 key 找元素（`band-strip`、`band-agent-<i>`、`band-pick-<数字>`、`band-event-<i>`、`band-idle`、`band-squeezed`、`dp-footer`；面板的 `pane-head`、`pane-off`（整个 mod 关着）、`pane-switches`、`pane-switch-<功能名>`、`pane-card`、`pane-card-<部分>`、`pane-card-step-<i>`、`pane-mid-<n>`、`pane-prev`、`pane-next`、`pane-fold-<轮>`、`pane-entry-<n>`），断言里面的数据而不是整行文字（`tests/screens.test.ts`、`tests/pane.test.ts`）。world 在 mod 之下回答 `ui.open`、`ui.close`、`ui.panes`：`w.panes` 是现在开着的面板，`w.paneActs` 记着每次打开和关闭；`beneath: { unplaced: '<原因>' }` 让每次打开都回答 `isPlaced: false`。同一个面板在一个测试里只能 mount 一次（第二次 mount 会报错），之后用 `redraw()`。`w.statuses` 记着 `$.ui.status` 的每次调用，只用来断言它从未被调用（ADR 0004）。非终端端的画面用 `surface: 'desktop'`（以及 `vscode`、`mobile`）mount：断言树里没有 `Raster`、节点数不到 2000（`$.ui.mount` 只按引擎的 20000 校验，Desktop 的 2000 要自己数，两个测试文件里各有一个 `inventory`），脚部标签不超过 24 个字符。脚部的宽度量的是整个加上去的部分（`screens.test.ts` 的 `addedCells`：整棵树按 Ink 的排法量出的宽度减去引擎或别的 mod 画的那一份，`gap` 也算），不只量标签的字。不测内部函数。评测（接缝 2）用到的纯函数是另一个公开接口，可以直接测：`decision/` 的各个模块（拼请求、读回答，`tests/decision-module.test.ts` 等），以及评测也 import 的 `core/setup.ts`（`readConfig`、`dispatchSettings`） 和 `core/skills.ts`（`rankingSettings`、`describeStages`、读目录）。

```ts
import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

test('……', { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) }) // 先注册桩，再调用 $
  await w.submit('消息')                                     // 空闲时，引擎在 next 里开始一轮（t1、t2……）
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
})
```

- `world($, on, options)` 在 mod 之下扮演引擎和外部世界。`backend` 回答 `$.http.fetch`：`jev(levels)` 让每个 Score 问题得到这组概率；`{ status, body }`、`{ reject }`、`{ after: ms, reply }` 分别模拟出错、断网和慢响应。`agents` 回答 `$.agent.list()`（也可以是 `{ deny }`），之后在 `w.agents` 里增减；`w.complete({ agentId?, reason?, durationMs? })` 是一个 loop 的 `turn.complete`；`messages` 是 `$.session.messages()` 的返回值（也可以是函数，拿到这次问的是什么，例如 `{ agentId }`，按调用作答，或者像引擎拒绝 Workflow agent 那样回 `{ deny }`），`disk` 回答 `$.fs.read` 和 `$.fs.exists`（超过 4 MiB 的文件和引擎一样读不了），`beneath` 模拟更内层的 hook 拒绝（`drop`）或改写（`rewrite`）消息。它会记录 `requests`、`steps`、`statuses`、`logs` 和 `prompts`，以及 `looked`（`roster`：读了几次 `$.agent.list()`；`files`：`$.fs.read` 读过的路径，按顺序），用来断言某样东西没有每一步都重读（例子见 `tests/readings.test.ts`）。`store` 给 `$.store` 预置内容（不给时每个 `$.store` 调用都会 reject），mod 写进去的用 `w.stored(key)` 读回；`session: true` 让引擎照常开始会话：`w.start()` 触发 `session.start`，mod 注册的命令记在 `w.commands`（`session: { registerError }` 让注册被拒绝），`w.measure({...})` 触发 `session.measure`；`w.command('dp', 'lock max')` 像用户输入斜杠命令那样运行它，返回它打印的文字（例子见 `tests/control.test.ts`）；`w.slash('implement', '#19')` 是用户输入一个 prompt 命令（skill、markdown 命令）：照引擎的顺序先 `command.run`，再提交输入的 `/implement #19`，这一轮以引擎的命令消息开始（例子见 `tests/command-turns.test.ts`）。这几项都是按需打开的，不用的测试不受影响。
- `tests/support/world.ts` 导出两个常用的选项常量，测试不再各抄一份：`KEY`（`{ decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }`，`{ options: KEY }`）和 `UNRESOLVED_ON`（`{ unresolved: true }`，`world(..., { switches: UNRESOLVED_ON })`）。假 Jev 回答里的 `model` 是 `decision/jev.ts` 的 `JEV_MODEL`（现在是 `jev-1.14.0`），不写死版本号；测试里手写的回答也用它。
- pplx（#50）：`pplx(levels, extra)` 和 `jev` 一样回答每个问题，回答里的 `model` 是 `pplx-decider-v1.1-27b`，并且像真的 API 一样拒绝不对的请求：URL 不是 `https://api.perplexity.ai/v1/decisions` 回 404（空 body），没有 Bearer key（`extra.key` 指定了就要是这一个）回 401 `{ error: { message, type, code } }`，模型名不对或顶层字段多于 `model`、`state`、`questions` 回 400。`rates(shares, fits, levels, pplx)` 的第四个参数让两段排序也由 pplx 作答。`env: { PERPLEXITY_API_KEY: '…' }` 回答 `$.env.get`（和 `skills.home` 的 `HOME` 合在同一个 `mock.env` 里；没给 `env` 时 `$.env.get` 不被回答），世界在第一次驱动引擎之前自己跑 `session.start`（mod 在那里读环境变量），和 `switches` 一样。例子见 `tests/pplx-model.test.ts`（pplx 的 seam 1）、`tests/backend-defaults.test.ts`（Jev 和 pplx 的默认值对比，seam 2）。
- `await w.board()` 读出「决定汇报」存在 `$.state` 的看板数据，是断言「mod 决定了什么、读到了什么」的地方，不要再去比状态字符串：`{ turn, nodes, changes, starts, log, main, agents }`。`turn`、`nodes`、`changes`、`starts`、`log` 就是存着的值（`board.turn`、`board.nodes`、`decisionLog`，契约见 `types/index.d.ts`），`main` 是当前这一轮主 agent 的节点，`agents` 是当前这一轮其他 agent 的节点。例如：`expect((await w.board()).main).toMatchObject({ effort: 'medium', routed: false, failure: { backend: 'jev', kind: 'timeout' } })`、`expect((await w.board()).log.at(-1)).toMatchObject({ feature: 'main-effort', outcome: 'effort high' })`。`board` 和 `decisionLog` 两个值由 world 自己保管（版本号和 `ifVersion` 照宿主的方式），测试里没有 `$.state` 可读；`seed: { board, log }` 让 mod 一启动就看到「上一次加载留下的」数据，用来测热重载后数据还在（例子见 `tests/report.test.ts`、`tests/control.test.ts`）。要让它们读写失败，在 `world()` 之前注册 `on('state.set', { plugin: 'dispatch-pilot', key: 'board' }, () => ({ deny: '...' }))`。
- `skills` 打开本会话的 skill（`SkillsWorld`）：`commands` 回答 `$.command.list()`，`listed` 回答 `$.session.usage({ breakdown })` 里主 agent 的 skill 清单（`null` 让这次调用失败），`overrides` 按来源回答 `$.settings.read({ source })` 的 `skillOverrides`，`home` 和 `cwd` 回答 `$.env.get('HOME')` 和 `$.session.cwd()`。SKILL.md 放进 `disk`。`w.listing(text, agentId?)` 像引擎那样把 skill 列表交给 `prompt.attachment`，返回模型最后读到的内容。`session` 打开时还有 `w.compact()` 和 `w.clear()`。`jev(levels, { shares: { 'skills.which': { tdd: 0.6, '(none)': 0.4 } } })` 让一个 Choice 问题按给定的概率作答（没列出的选项是 0），`nouls: { 'skills.fits.0': 0.9 }` 让 Noul 按问题 ID 作答（默认 0.5）。例子见 `tests/skills.test.ts`。
- 两段排序（ADR 0018）：`rates(shares, fits)` 同时回答一条消息的两个 skill 请求：第一个请求的 `skills.which` 和 `skills.hint` 都按 `shares`（各自只取自己的选项；一个也没给到的选择题平分；effort 默认 medium），三道门控题都按 `1 - shares['(none)']` 回答（`prose_suffices` 反过来），所以 `{ '(none)': 1 }` 就是「这条消息不要 skill」；第二个请求（`isSecondSkillsRequest(request)` 为真）里每个 `skills.fits.<i>` 按问题里写的 skill 名（`fitsSkill`）取 `fits` 的值（没列出的是 0），两道选择题都选 fits 最高的那个。`disk` 也回答 `$.fs.list`（列出某个目录下的文件和子目录），同步 skill 的账号目录就这样找到。例子见 `tests/skill-ranking.test.ts`。
- `session` 打开时，mod 用 `$.tool.register` 注册的工具记在 `w.tools`（`registerError` 同样拒绝它们）。`w.findSkill(query, { agentId })` 像模型那样调用 `find_skill`（带 `agentId` 是派出 agent 的调用），返回工具的回答 `{ result }`。例子见 `tests/find-skill.test.ts`。
- 二进制文件和程序（#57，`tests/support/images.ts`）。`files: { 路径: FakeFile }` 是 world 的二进制磁盘：`FakeFile` 用格式、宽高、`size`（磁盘上的大小，超过 4 MiB 时 `$.fs.read` 的 bytes 模式拒绝，和引擎一样）、`label`（来历）、`orientation`（JPEG 的 EXIF 方向）描述一张图，`fileBase64` 把它变成真的 PNG/JPEG 文件头加一段文字，所以 mod 从字节里读到的尺寸就是描述里的；`readFake(base64)` 把请求里的图读回 `{ format, width, height, label }`，测试用它看「发出去的是哪张图、做过什么」（派生文件的 label 是 `原路径 > resize 523x1568 > format png`）。`process: true`（或 `{ programs, unavailable }`）让 `$.process.run` 作答：程序是 `(args, disk) => { exitCode, stdout, stderr }`，默认有假的 `sips`（`-g`、`-Z`、`-z`、`-c`、`--cropOffset`、`-s format`、`-r`、`-f`、`--out`，输出文件落在 `w.files`，目录要先 `mkdir -p`，和真的一样）和 `mkdir`；`programs: { ffmpeg: fn }` 加程序，`{ sips: null }` 是没装，`unavailable: '原因'` 是不在 CLI（`$.process.run` 拒绝）。`w.ran` 是所有程序的参数表，`w.files`、`w.dirs` 是磁盘现在的样子。`w.visualCheck(input, { agentId })` 像模型那样调用 `visual_check`，返回 `{ result }`（字符串，或 Messages API 块的数组）。例子见 `tests/visual-check*.test.ts`。
- `w.submit(text, { origin, turnId, wait })` 默认模拟用户在终端按回车；带 `turnId` 表示在那一轮进行中发的，不会开始新的一轮。`w.startTurn(text)` 模拟排队的消息稍后开始自己的一轮。`w.step({...})` 发出一步并把流读完。
- `w.step({ index, answer, tools })` 还可以让这一步像真实引擎那样流出文字（`answer`），并在流还没结束时依次执行工具调用（`tools`，每个是 `{ tool, input, ends }`），所以功能的 `tool.call` hook 是在这一步之内触发的；`parallel: true` 让这一步的调用同时执行（每个都以 `ok` 结束），像引擎执行一个回答里的几个调用那样。一个 agent 的第 0 步（`agentId` 加 `index: 0`）之前先触发它自己那一轮的 `turn.start`（带 `agentId`，2.1.299 起引擎这样做）。`ends` 决定调用的结局：`{ text }`（成功，默认 `ok`）、`{ error }`（工具报错；用户在权限对话框里拒绝时也是这样，文字是引擎的那句话）、`{ blockedByHook }`（PreToolUse settings hook 拒绝，工具不会执行）。到达工具的调用记在 `w.toolCalls`（参数是经过 mod 各层改写后的样子；被 hook 拦下的调用不在其中）。`jev(levels, { confidence })` 可以指定回答的置信度（默认 0.7）。例子见 `tests/escalation.test.ts`。
- `w.spawn({ prompt, description, subagentType, model, fork, isTeammate, resume })` 模拟主 agent 调用 Agent 工具，返回 `{ model, agentId }`（agent 按到达引擎的顺序命名为 a1、a2……；带 `resume: { agentId }` 是唤醒一个已结束的 agent，引擎沿用它的 id）；`spawned` 记录每次派发到达引擎时的样子。拿到的 `agentId` 传给 `w.step` 就是这个 agent 的步。
- Workflow 的测试用 `tests/support/workflow.ts` 的 `workflowWorld($, on, options)`：它先注册带 matcher `{ tool: 'Workflow' }` 的 Workflow 工具桩，再调用 `world()`，所以 `world()` 以后再加 `tool.call` 桩也不冲突（但同一个测试里要先于它注册）。`w.workflow({ script | scriptPath | name, args, resumeFromRunId })` 调用工具；`w.reached` 记录到达工具的每次调用（`launched: false` 是工具因语法错误拒绝的）；`w.stateWrites` 是 mod 所有的 `$.state` 写入（key、family 的 id 和值）；选项 `parseError` 和 `fails` 让工具拒绝某个脚本。`siteJev((i) => ({ model, effort, nouls }))` 按脚本里的第 i 个调用回答。
- Workflow agent 派出时的测试（#9）用 `tests/support/workflow-run.ts` 的 `runWorld`：`w.started(runId, agentId, label, { prompt?, model? })` 在启动这次运行的 Workflow 调用下触发 `agent.spawn`，之后 `w.agentStep` 默认按它启动的模型发出；回答 `tool.describe`，见上文「Workflow 兜底（#9）」。agent 派出时当场判断的请求只有一个调用，part 是 `agent-0`，所以 `siteJev` 的下标 0 也会回答它；同一个测试里要区分运行开始时和 agent 派出时的回答，就按请求的序号 `n` 分别作答。
- 要模拟别的功能已经写好的计划表，就在测试里回答 `state.get`，见 `tests/plan-table.test.ts` 的 `table()`。
- **未解决次数的测试（#39）。** `jev(levels)` 对 `effort.unresolved` 默认回答「新问题或无关」100%：次数不动，决策日志里没有 `unresolved` 的条目，所以不关心它的测试不用管；要让某条消息动次数，用 `jev(levels, { shares: { 'effort.unresolved': { still_unresolved: 0.8, resolved: 0.05, new_or_unrelated: 0.15 } } })`。次数用 `w.unresolved()` 读，热重载用 `seed: { unresolved: { count: 2 } }` 带一个旧值进来（`$.state` 的 `unresolved` 这个 key 由 world 接管，和 `board` 一样）。每条人的消息的 effort 请求现在是 `['effort.level', 'effort.unresolved']`（agent 交回结果、后台任务通知开始的轮、`/dp unresolved off` 时只有 `effort.level`）；关心 effort 请求是否等于评测的，用 `withoutUnresolved(body)` 去掉那一题再比（effort-submit 评测测的是 effort 题本身）。mid-turn 和 escalation 的测试里的 `kind()` 把它滤掉了。
- **问题摘要的测试（#40）。** 写摘要的便宜模型是 world 的 `model`（`(request, n) => Completion`，`w.completions` 记着每次问了什么：模型、提示）：摘要要在 `turn.complete` 之后才写，所以测试里 `w.complete({ answer })` 结束一轮，再 `await w.clock.settle()` 等写完，慢的回答用 `{ after: ms, reply }`、`w.clock.advance(ms)`。摘要读 `w.summary()`（带 `turn`），整个 key 读 `w.unresolvedState()`（`count`、`summary`、`writing`、`owed`），热重载前留下的用 `seed: { unresolved: { ... } }`。一轮「是你本人的消息开始的」靠 `main-effort` 的待用决定认出，所以测试要走 `w.submit`（或 `w.slash`），不能只调 `w.complete`。world 没给 `model` 时每次调用被拒绝：不关心摘要、却要数决策日志条数的测试，要给一个回答合法 JSON 的 `model`（见 `tests/pane.test.ts` 的日志分组那条），否则每轮多一条「摘要没写成」。`jev(levels)` 默认把三选一答成「新问题或无关」，这会在每条消息上清零（摘要也清）：要留着摘要的测试用 `shares: { 'effort.unresolved': { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 } }`（两档门槛都不到，什么也不动）。三类测试：`tests/summary-module.test.ts`（接缝 2：读回答、限长、提示、工具汇总、`turnStartPart`、`messageRequest`）、`tests/summary.test.ts`（接缝 1）、`tests/unresolved-board.test.ts` 里的面板那两条。
- 每个测试都要断言一个实际产物（发出的请求、某一步的 effort、看板数据），否则可能空过。例如不给 origin 时 hook 会被跳过；没有 `http.fetch` 桩时 fetch 会失败、走放行分支，「effort 不变」照样成立。
- `world()` 总会装上 `mock.clock(on)`。测超时时，先 `const p = w.submit(...)`，再依次 `await w.clock.settle()`、`await w.clock.advance(ms)`、`await p`。
- 同一个事件的桩不能注册两次：`world()` 已经注册过的事件，测试里不要再注册。`http.fetch`、`fs.read`、`fs.exists`、`fs.list`、`model.complete`、`session.messages`、`ui.*`、带 matcher 的 `state.get` 和 `state.set`（只管 `board`、`decisionLog`、`skillProfiles`、`unresolved` 和 `pplxRate` 这几个 key；`pplxRate` 用 `seed.pplxRate` 和 `pplxRateContended` 控制）和引擎那几个事件总会注册；开了 `store` 就是 `store.*`；开了 `session` 就是 `session.start`、`session.measure`、`session.compact`、`session.end`、`command.register` 和 `tool.register`；开了 `skills` 就是 `command.list`、`session.usage`、`settings.read`、`session.cwd`、`env.*` 和 `prompt.attachment`。想自己写这些桩的测试，就不要打开对应的选项。
- 每个测试拿到的都是全新的模块实例，模块级变量不会跨测试残留。
- **测试文件读不了磁盘上的文件**（2.1.289 实测）。`claude plugin test` 在和 hooks 一样的环境里加载测试文件：`import 'node:fs'` 被拒，`.json` 和 `.md` 也不能 import（只加载 `.ts`、`.tsx`、`.jsx`、`.js`、`.mjs`、`.cjs`、`.mts`、`.cts`），测试里的 `$` 是引擎的 `$`、没有 `$.fs`，也没有 `process` 和 `Bun`。要核对真实的文件，就把检查写成纯函数，测试用自己写的小例子测它，再由 Node 脚本对真实的文件跑它：README 的配置表对 plugin.json 就是这样做的（#18）：纯函数 `checkConfigTable` 在 `eval/lib/docs.ts`，`tests/docs-sync.test.ts` 测它，`node dispatch-pilot/eval/validate.ts` 对真实的 README.md 和 plugin.json 跑它。所以 `claude plugin test` 全部通过，并不说明 README 的配置表还和 manifest 一致，改了配置项或默认值要再跑那条命令。

### 评测（接缝 2）

> 0.9.0 删掉了一轮中途重判（ADR 0013），`effort-midturn` 评测集和 suite 一起删了；下面各节里它的数字，以及 `thetaUp`、`thetaDown`、`holdSteps`、`rejudgeWaitMs` 这几个已删的选项，只作记录。

> **effort-submit 之外，下面各节的数字都是第 1 轮审查修复之前的问法测得的。** 修复改了发给决策模型的问题措辞、工具行的写法、Workflow 题的合并提问，skill 第一段也拆成了两题；按用户的决定（2026-10-05），修复之后没有重跑这几套，所以它们的数字只能当预览，不能当成现在的问法的结果（见「待评测」开头）。effort-submit 的请求没有变，2026-10-05 又在现在的代码上跑了一次问题语言的对比。各结果的 `pass`、`late`、`retried` 和 `inTime` 已按现在的指标离线重算（见下面「已存结果的汇总可以离线重算」一条）。

**给 `unresolved` 评测集（#37、#6）：关于问题的题在接缝 2（0.9.0 起是三道是非题，下面这段写的是 0.6.x 到 0.8.x 的三选一，ADR 0014）。** `decision/unresolved.ts` 是纯模块，评测直接 import：`withUnresolved(turnStartEffortPart(ask), language)` 是发消息时的 effort part（`effort.level` 加 `effort.unresolved`，和线上同一份，拼请求照常 `mergeParts(turnStartState(...), [part])`，限额用 `messageLimits(settings, false)`）；`readUnresolved(answersFor(part, answers).unresolved)` 把回答读成三个选项的概率（归一化，缺了或不是 Choice 是 `null`）；`judgeUnresolved(reading, thresholds?)` 按两档门槛返回 `{ change: 'add' | 'reset' | 'keep', top, probabilities, confidence, thresholds }`：`top` 对三选一的金标，`change` 对「次数该加一、清零还是不变」；门槛 `UNRESOLVED_THRESHOLDS` 是暂定值，评测要扫门槛就传第二个参数。选项名固定为 `still_unresolved`、`resolved`、`new_or_unrelated`（`UNRESOLVED_OPTIONS`，顺序也是问的顺序；Choice 偏向第一项，评测要做换序对照的话改 `decision/unresolved.ts` 里三选一题（文件内的 `unresolvedQuestion`）的 criteria 顺序）。

评测用真实的 Jev 或 Perplexity（`--backend pplx`，#43；密钥是 `PERPLEXITY_API_KEY`，读法同上，价格 0.02 美元每百万 input token，`--estimate` 的系数是 `lib/estimate.ts` 的 `ESTIMATE_FACTOR`：Jev 1.6，pplx 3，`run.ts` 和 `eval-v2-flow.ts` 共用）测决策的准确率，脚本用 Node 运行，放在 `eval/`。`run.ts` 读 mod 的设置时用 `optionsFor(backendName, ...)`（`lib/suite.ts`），`--backend pplx` 取 pplx 自己在 `BACKEND_DEFAULTS` 里的那一列（预算、超时、问题语言、门槛都是 pplx 的），不当作 Jev（#43 当时是当作 Jev 的，那几份结果是那样跑的，见「Perplexity 决策后端对 Jev」）；`--state-tokens N` 把每一类请求的 state 预算设成 N（mod 自己的选项只能调低，这个能调高，结果文件的 `settings.stateTokens` 记着；`settings.messageStateTokens` 记每次运行里发消息时 effort 请求的预算）；`--state-messages N` 放开 state 最多取几条最新消息（mod 的 `contextMessages` 最多是 `contextMessagesMax`，两个决策模型现在都是 2000，所以它只对超过 2000 条消息的对话有用；2026-10-15 之前 Jev 是 32，只放大 `--state-tokens` 还是只读最新 32 条，#44；结果里 `settings.stateMessagesLimit` 是这次运行的上限，放开时 `settings.stateMessages` 记着）：

```
eval/
├── datasets/<类>.jsonl     评测集，一行一题，中英对照；校验规则见 lib/datasets.ts
├── datasets/README.md      评测集的约定：每类题的字段、effort 档位的含义（标注依据）、各类的附加约定、名字的例外
├── datasets/skill-catalog.json   skill 题出题用的本机 skill 目录快照（#16）
├── datasets/eval-v2/       eval v2（#45）的素材池、题目、两份金标和 generated.json；格式见其中的 FORMAT.md
├── datasets/eval-v2.jsonl  eval-v2-gen.ts 拼出的 eval v2 数据集（几十 MB，不提交，见 datasets/.gitignore）
├── datasets/visual-check.jsonl  看图核对的评测集（#65）：一行一题，没有 zh/en 两面；图和真值在 datasets/visual-check/（ui、sea、anim、effort 四个子目录，约 4 MB 的 PNG，加 ui/truth.json、anim/truth.json）
├── review/<类>.review.jsonl 用户的审核决定（应用时由 apply-review.ts 放进来，和改动一起提交）
├── review/<类>.review-summary.md  审核总结：判断基准、规则决定（R1、R2……）和要跟进的事项
├── results/<类>/*.json     每次运行的结果：设置、答题的模型版本、汇总、逐题答案
├── results/eval-v2-flow/<后端>-<预算>.json  eval v2 的真实流程（#45，eval-v2-flow.ts 写）：每题每条用户消息的是非题概率和次数（0.9.0 之前的文件是三选一的）、最后一条消息带的次数和摘要；同目录的 haiku-cache.jsonl 不提交
├── results/probes/*.json   #17 的 Clef 截断 state 探针结果（历史：Clef 和写它的 probe-truncation.ts 已在 0.4.0 删除，结果文件保留；其他目录里文件名带 clef 的结果同样是历史）
├── plans/17-calibration.md #17 的方案、拍板、探针的结果和范围缩减
├── lib/                    纯模块（测试也 import）：datasets、review、suite、runner、metrics、resummarize、rescore、compare、docs、各类题型的 suite；validators（数据集检查共用的 `isRecord`、`nonEmpty`、`exactKeys`、`adjacent`）、random（`mulberry32`，long-filler 和 eval-v2 共用的带种子随机数）、ctx30（ctx30 的 suite）；long-context 另有 long-conversation（三个版本的对话）、long-filler（中间轮次的生成器）、long-summaries（逐轮写问题摘要）；eval-v2（eval v2 的格式检查和拼装）、eval-v2-suite（eval v2 的 suite）、eval-v2-flow（真实流程）、eval-v2-thresholds（三选一门槛扫描）；visual-check（看图核对的 suite 和指标）、visual-check-items（它的评测集格式）、visual-check-rescore（已存结果按新旧门槛重判）、estimate（带图的请求怎么估算 token）
├── long-context-items.ts   long-context 评测集的唯一来源（手写的决定性几轮、答案）；long-context-gen.ts 把它写成 datasets/long-context.jsonl
└── validate.ts、run.ts、apply-review.ts、compare.ts、resummarize.ts、rescore.ts、rescore-visual-check.ts、real.ts、ctx30.ts、long-context-gen.ts、long-context-summaries.ts、eval-v2-gen.ts、eval-v2-check.ts、eval-v2-flow.ts、eval-v2-thresholds.ts、node.ts   Node 脚本
```

- **测到的就是线上的请求。** 每类题型的 suite 用 mod 自己拼请求的函数（`hooks/decision/` 的各个模块，加上 `hooks/core/` 里读设置的 `setup.ts`、读 skill 目录的 `skills.ts`），设置取 manifest 的默认值，manifest 没有默认值的选项取 `--backend` 那个决策模型的（`core/setup.ts` 的 `BACKEND_DEFAULTS`，结果文件的 `settings.backendDefaults` 记着取了哪些），经 mod 自己的 `readConfig()` 读出（`--option contextTokens=4000` 可以改，按 manifest 写的类型读：数字、`true`/`false` 或文字；manifest 里没有的名字、类型不对的值直接报错），所以范围、缺省值和 mod 完全一样。`tests/eval-effort-submit.test.ts` 用 world 核对：同一条消息和对话，评测发的请求与 mod 发的逐字相同。
- **`eval/node.ts` 的共用函数。** `resultFiles()`、`resultFile(path)` 列出结果文件、把参数解析成路径（`rescore`、`resummarize`、`compare`、`real` 共用）；`numberFlag()` 和 `scriptTimeout()` 严格读数字参数（`--max-usd abc`、`--concurrency abc`、`--timeout abc` 这样的笔误在发出任何请求之前就以退出码 2 报错，不再变成 NaN 而悄悄不设花费上限或一个 worker 都不开）；`claudeComplete()` 是 `eval-v2-flow` 和 `long-context-summaries` 共用的那一次 `claude -p` 调用（超时 60 秒）。`lib/metrics.ts` 导出 `share()` 和 `percentText()`，`lib/estimate.ts` 导出 `ESTIMATE_FACTOR`。
- **effort-submit 只问 effort。** 发消息时 effort 题在自己的请求里（ADR 0005），不管 skill 推荐开不开，所以评测发的就是线上的请求：`submitRequest` 用 `messageLimits(settings, false)`（`contextByKind.messagePlain`，Jev 现在是 24000，ADR 0014；2026-10-15 到 0.8.x 是 96000）取 state 的预算，`tests/eval-effort-submit.test.ts` 核对了带 skill 题时，mod 的 effort 请求与评测的逐字相同。拆分前这个请求和 skill 题同在一个请求里、state 只有 6000，评测却按 6000 问；数据集里的对话都短于 6000 token，两种请求逐字相同（2026-10-07 前后各跑一遍 `zh-score`：输入 token 都是 162,722，200 个回答里 192 个相同，准确率 zh 88.0%→88.0%、en 84.0%→84.0%，差的 8 个是 Jev 自己的抽样波动，`results/effort-submit/2026-10-07-jev-split-before.json` 和 `…-split-after.json`）。延迟：消息的实际延迟是两个并行请求里慢的那个，通常是带 skill 题的那个，看 skill 评测的第一段；effort-submit 的延迟是 effort 请求的。
- **变量。** effort-submit 有四个变体：`en-score`、`zh-score`、`en-choice`、`zh-choice`，即问题用英文还是中文写、用 Score 还是 Choice 问；用户的原文总是照搬进 state。每题的中文版和英文版都问。mod 现在的问法看决策模型：0.9.0 起两个都是 `en-score`（`lib/effort-submit.ts` 的 `modVariant`，ADR 0014；0.8.x 的 Jev 是 `zh-score`），请求是整个 effort part（effort 题加十道是非题），读法是 `decideMessageEffort`（和 mod 同一套规则，TypeSafe 的读法）。
- **指标**（`lib/metrics.ts`）：每个变体的中文、英文准确率（答案在可接受集合里；没答上的算错，另列条数），gold 命中率，答偏的方向，中英差距和门槛（中文比英文低不超过 4 个百分点就算通过，正好低 4 个百分点也通过：用户 2026-10-05 定的，原来的 spec 写的是 3 个百分点；`MAX_GAP`、`passes`；一次运行只问一种语言时（eval-v2、visual-check，`languages` 是 `['zh']`）没有可比的另一种，汇总里的差距和是否通过是 `null`，`run.ts` 对没问的那种语言、对差距和通过都打印 `-`；每种语言的汇总形状不变，没问的英文一项是 0 个回答、准确率 0。早先存下的结果里差距是数字（英文当作准确率 0），仍然读得进来），中英一致率，延迟 p50 和 p90（以及超过 mod 超时的条数），按 tag 分组的错题数；另报「每题都答同一档」的常数基线。评测每次最多等 `--timeout`（默认是这个后端的 `timeoutMs` 的 4 倍、至少 10 秒），失败（繁忙、断线、超时）还会重试；mod 只等 `timeoutMs`，也从不重试。所以 mod 拿不到的回答另列：超过 `timeoutMs` 才来的（`late`），和评测重试之后才答上的（`retried`：尝试的次数多于请求数），每种语言各记条数，再给出把它们都算作没有决定的准确率（`inTime`），`run.ts` 每个变体打印一行。
- **已存结果的汇总可以离线重算。** 指标的算法改了时（例如门槛从 3 个百分点改成 4 个，`inTime` 开始扣掉重试过的回答），`node dispatch-pilot/eval/resummarize.ts` 按结果文件里存着的逐题答案重算每种语言的 `late`、`retried`、`inTime` 和每个变体的 `pass`（`lib/resummarize.ts`），不发请求，其余字段原样保留，并在文件里加一段 `resummarized` 说明何时、重算了什么。带 `--repeat` 的运行，每一遍按它自己的行重算（`summary` 是第 1 遍，`repeatSummaries[i]` 是第 i+2 遍）；一个回答用了几个请求，skill 套件从 `stages_ms` 数，visual-check 从 `requests` 数组数；`pass` 可以是 `null`（一种语言的套件）；只写汇总真的变了的文件，已经是最新的打印 `up to date`、不动它，所以不带参数对现有结果运行一遍，什么也不会改。2026-10-05 已经对 `results/` 下的全部结果重算过一次。准确率、一致率、`breakdown` 这些的算法没有变，不重算。
- **延迟只在 `--concurrency 1`（默认）时可信。** 实测 Jev 对同一个 key 的并发请求像是依次处理：p50 在 1 个并发时约 270–290 ms，2 个时约 540 ms，4 个时 700–1100 ms。
- **单次运行有波动。** 2026-10-04 用同一配置跑了两次（`results/effort-submit/` 里的两份 preliminary），四个变体分别有 192、192、191、193 / 200 个答案相同，单项准确率相差 0–3 个百分点，zh-score 的中英差距一次是 −2、一次是 −4，和中英差距的门槛（现在是 4 个百分点）同一量级。比较写法或判断门槛时多跑几次，用 `compare.ts` 对照。
- **结果文件**记录后端、请求的模型和响应里的模型版本、日期、变量、mod 的设置（包括除敏感字段外的全部选项）、评测集和代码的哈希（`hooks/` 下 mod 的全部文件，加上 `eval/lib/` 的 suite：请求和评分都出自它们）、每个变体问的问题、汇总，以及逐题答案（每个档位的概率和 confidence，供以后离线校准门槛；分部分评分的题型另有 `parts`；带 `--repeat` 或几个变体时，某个回答的 state 和这一行顶层存的不同（unresolved 的 `-wide`、effort-midturn 显示开关不同的变体），那个回答带自己的 `state`，更早的文件只有顶层的一份），不含凭证。判断提示词有没有变，看拼请求的文件（effort-submit 是 `system-one.ts`、`effort.ts`、`context.ts`、`redact.ts`）和记录下来的问题；`backend.ts`、`jev.ts` 这类文件变了不影响请求内容。结果文件是历史记录，哈希是写下那一刻的：之后改了代码，已存结果里的哈希就对不上现在的文件（0.6.0 的全面审查改了 `decision/`、`core/`、`features/` 里的许多文件，包括 `pplx-rate.ts`、`jev-rate.ts`，已存结果的哈希因此都过期了，没有重算也没有重跑；哈希是整个 `hooks/` 和 `eval/lib/` 的，改一个无关的文件也会让它们过期，所以它只能说「代码变过」，要知道请求变没变，比较存着的 `questions`）。凭证按「进程环境变量优先，其次 `~/.config/dispatch-pilot/eval.env`」读取。
- **审核。** 用户的审核 wizard 每行写一个决定（`agree`、`edit`、`note`）。`apply-review.ts --from <文件>` 把它复制到 `eval/review/`，把 `edit` 写进评测集（只改答案字段，其他行逐字不变），列出改过答案的题（它们的理由需要重写）和要跟进的 note，再校验一遍；有任何一条无法应用时整份不写。审核之后又有新决定时，追加在记录末尾（同一题以最后一行为准），再运行一次 `apply-review.ts <类>`：提交的记录重新应用后，得到的仍是提交的评测集。0.9.0 删掉的 `effort-midturn.review.jsonl` 的最后一行就是这样，按用户在 issue #1 的拍板撤回了审核者对 midturn-006 的修改。
- **加一类题型**（#14、#15、#16 都这样加过）：
  1. 评测集放进 `eval/datasets/<类>.jsonl`，在 `eval/datasets/README.md` 写下这类题的字段和标注约定。
  2. `lib/datasets.ts`：类名加进 `KINDS`；`FIELDS` 写每题的顶层字段，`RULES` 写逐题的校验（`zh`/`en` 的结构、答案的形状），`QUOTAS` 写整个评测集的配额（hard 的比例、各情形的题数），三处都按类名查，少一处 `validate.ts` 就报错；题和答案的类型也写在这里。
  3. `lib/review.ts` 的 `EDITABLE`：审核的 `edit` 能改哪些答案字段（`long-context` 的文件是生成的，写 `[]`，改动去 `long-context-items.ts` 里做）。`node.ts` 的 `datasetFile` 报错信息里列着各类的名字，一并加上。
  4. 在 `eval/lib/<类>.ts` 实现 `Suite`（`lib/suite.ts`：怎么问、怎么评分、怎么显示、常数基线），请求一律用 mod 自己拼请求的函数；在 `lib/suites.ts` 登记一行。
  5. 仿照 `tests/eval-effort-submit.test.ts` 用 world 核对请求与 mod 发的逐字相同，再写评分和汇总的测试。

  可选的几样：一个答案由几个决定组成时，`grade` 可以给出每部分的对错（`parts`，例如派出 agent 的 `model` 和 `effort`），汇总就会在整题之外给出每部分的准确率（分语言、按 tag、常数基线）；`breakdown` 给出这类题型自己的数字，存进每个变体的汇总；`report` 给出 `run.ts` 打印的几行；`baselines` 是随题而变的基线（例如每题都保持当前档），和常数基线一起评分、一起打印。#16 又加了三样，也都是可选的：一次要看不止一道题、或者除了题目还要读别的东西的 suite（`subagent` 题要把一个 workflow 的几道题放在一起问；skill 题要读目录快照和 SKILL.md），在 `suites.ts` 里登记成一个构造函数 `(host: SuiteHost, items) => Promise<Suite>`，`run.ts` 开始运行时用 `node.ts` 的 `nodeHost` 和评测集的全部题目构造它（`items` 是整个评测集，不只是这次运行问的那些；`beside` 读评测集旁边的 JSON 文件，结果里记下这些文件的哈希；`read` 按路径读文件，`~` 是主目录）；`estimate` 给出一题最多发出的请求（读了第一个回答还要再问的 suite 用它，`--estimate` 就把第二段也算上），没有时 `--estimate` 只算 `decide` 拿到回答之前发出的请求；`about` 说明这个 suite 读到了什么，记进结果文件，其中的 `warnings` 由 `run.ts` 打印。一题发出几个请求记在逐题的 `requests` 里，`run.ts` 汇总的请求数按它算。

#### effort-submit 的正式基线（2026-10-04）

评测集是审核后的版本（100 题；审核 99 题同意、1 题备注，没有改答案），设置取当时的默认值（`contextMessages` 4、`contextTokens` 2000、`thetaMax` 0.5；0.2.1 起 Jev 的前两项默认值是 32 和 6000，评测集的上下文很短，只有 2 个请求的 state 因此变了，见「Jev 的上下文默认值怎么算」；用旧值重现这批结果要加 `--option contextMessages=4 --option contextTokens=2000`），`--concurrency 1`。Jev 用同一配置跑了 3 次（`results/effort-submit/2026-10-04-jev-baseline-1.json` 到 `-3.json`），每次 800 个请求、614,292 input token、约 0.026 美元，没有失败。

准确率、一致率和 gold 命中率是百分比，差距是百分点。Jev 写 3 次的均值，括号里是最低到最高；延迟写 3 次运行各自的 p50 和 p90 的范围。门槛一列按现在的门槛（中文比英文低不超过 4 个百分点，正好 4.0 也通过）。

| 后端（答题的模型） | 变体 | 中文准确率 | 英文准确率 | 中英差距 | 4 个百分点的门槛 | 中英一致率 | gold 命中（中 / 英） | p50 / p90 ms |
|---|---|---|---|---|---|---|---|---|
| Jev（jev-1.13.0） | `en-score` | 79.3（78–80） | 78.7（78–80） | +0.7（0 到 +2） | 3 次都通过 | 92.3（91–93） | 61.3 / 59.7 | 278–418 / 316–464 |
| Jev（jev-1.13.0） | `zh-score`（选 Jev 时线上的问法，2026-10-05 起） | 87.3（87–88） | 87.7（87–88） | −0.3（−1 到 0） | 3 次都通过 | 92.0（91–93） | 65.0 / 66.3 | 278–419 / 314–484 |
| Jev（jev-1.13.0） | `en-choice` | 82.3（82–83） | 85.3（85–86） | −3.0（3 次都是 −3） | 3 次都通过（按当时 3 个百分点的门槛不通过） | 88.3（86–90） | 65.0 / 66.0 | 279–419 / 318–483 |
| Jev（jev-1.13.0） | `zh-choice` | 85.0（3 次都是 85） | 86.3（86–87） | −1.3（−2 到 −1） | 3 次都通过 | 93.7（91–96） | 62.3 / 63.7 | 278–413 / 318–492 |

- **2026-10-05 的问题语言对比**（`results/effort-submit/2026-10-05-jev-ac4-question-language.json`，在现在的代码上跑的，请求和上面 3 次逐字相同）：`zh-score` 中文 85.0、英文 89.0，差距 −4.0，正好在 4 个百分点的门槛上，通过；`en-score` 79.0、78.0，+1.0。两种问法 p50 都是 282 ms，没有迟到或重试的回答。加上这一次，`zh-score` 4 次的差距是 0、0、−1、−4。
- **按 mod 的等法算的准确率**（`inTime`：超过 `timeoutMs` 或重试之后才答上的回答算没有决定，`eval/resummarize.ts` 离线重算过）：Jev 的各变体每次最多比准确率低 1 个百分点。
- **常数基线。** 每题都答 high 能对 55%（gold 命中 26%），medium 49%，xhigh 39%，low 30%，max 12%。Jev 的四个变体比 high 的 55% 高约 24–33 个百分点。
- **中英差距的门槛在多次运行下是否稳定成立。** 门槛原来是 3 个百分点（spec 的写法），2026-10-04 的 3 次运行里，`en-score` 中文不比英文差（差距 0 到 +2），稳定成立；`zh-score` 和 `zh-choice` 的差距在 −2 到 0 之间；`en-choice` 3 次都正好是 −3：当时的 `metrics.ts` 把正好 3 个百分点记成通过，后来改成必须低于 3 个百分点，它就不通过了。2026-10-05 用户把门槛改成 4 个百分点（正好 4.0 也通过），这四个变体按新门槛都通过，结果文件里的 `pass` 已按新门槛重算。同一题同一种语言 3 次答案都相同的，四个变体分别是 190、192、191、188 / 200，即有 4–6% 的答案在 3 次运行里变过，差距最多摆动 2 个百分点；之前的两次 preliminary 运行发的请求逐字相同（评测集只差 submit-055 的理由，答案字段相同），其中一次 `zh-score` 是 −4，2026-10-05 那一次也是 −4。所以 `zh-score` 的差距在 0 到 −4 之间摆动，正好贴着新门槛；要据此做决定，先多跑几次。
- **延迟。** 第 1 次运行整体慢了约 130 ms（p50 413–419 ms，分布同样集中，不像是并发排队），第 2、3 次的 p50 是 278–286 ms，和 preliminary 相近：同样是 1 个并发，不同时段的延迟也会差上百毫秒。超过 mod 超时 1500 ms 的，每个变体每次 0–1 条，最长 2245 ms。
- **审核规则 R4 暴露的提示词问题（原定留给 #17，按用户的决定没有改）。** 线上提示词（`hooks/decision/effort.ts`）的 high 档写着「writing tests」（中文版是「编写测试」），把写测试整体放在 high 档；审核规则 R4（`eval/review/effort-submit.review-summary.md`）定的是写测试按范围定档。submit-056（给二十来行的纯函数补几个用户已经列明的用例，只接受 medium）因此很难答对：3 次运行里，`en-score`、`zh-score`、`en-choice` 中英文各 3 次全部答 high（`en-score` 给 high 的概率是 0.71–0.76），只有 `zh-choice` 6 次里答对 5 次。对照题 submit-055（为三个外部依赖设计 mock、覆盖率要到 80%，接受 medium 和 high）24 次都答 high，这是对的。以后改提示词时，可以考虑把 high 档的写测试改成按范围描述，改完再跑一遍，用 `compare.ts` 对照这两题；这五档描述所有 effort 问题共用，要重跑的不只这一套。#4 和 #17 都没有改提示词。

#### 一轮中途的 effort（effort-midturn，#14）

> 0.9.0 随一轮中途重判删掉了这套评测集、suite 和审核记录（ADR 0013）；结果留在 `results/effort-midturn/`，这一节只作记录。

- **评测集** `datasets/effort-midturn.jsonl`：100 题，中英对照，74 题 hard。每题是一段真实执行轨迹的片段：本轮用户的消息、即将发出的那一步（`step`，从 0 数，就是 `turn.step` 的 `index`）、这一轮现在的档位、计数（判断次数、档位变化次数、失败的工具调用数、被 hook 拦截的次数）和最近几步（主 agent 在那一步最后写的文字、调用的工具和一句话结果，结果以「成功：」「失败：」「被 hook 拦截：」「用户拒绝：」开头；第 1 轮审查后每个调用还有 `input`：说明它做的是什么的参数，只取 mod 的 `toolDetail` 读的那几个，见 `datasets/README.md`）。答案是从这一步到下一次重判之前的工作需要的档位：相对现在的档位，32 题该升、30 题该降、38 题该保持；`accept` 最多两档宽。审核（Opus 5.5 high 的审核会话，用户同意以它的结论为准）同意 96 题、改 1 题、备注 3 题；记录和总结在 `review/effort-midturn.review.jsonl`、`review/effort-midturn.review-summary.md`。总结末尾一节写了之后的处理：midturn-006 按用户在 issue #1 的拍板撤回了审核者的修改（计划内的 TDD 红灯不强制升档，accept 仍是 `[medium]`），053、087 改写了理由，090 在题面里补了一句「等结果都回来再综合」。
- **请求与 mod 相同。** 每题的 `zh` 或 `en` 对象就是 `MidturnInput`，只是每个调用的那一行按 mod 的写法重写（`midturnInput`）：用 mod 的 `resultLine` 写出结局（取自结果开头的那几个字）加上 `toolDetail` 从 `input` 读出的「做的是什么」，语言跟着消息走，和 mod 一样。评测集里结果的其余部分（人写的「结果如何」，例如 `old_string 未找到`、`退出码 1`）mod 从来不发（故事 10），所以不进请求，只留给审核和标注。suite 用 `midturnState`、`midturnEffortPart` 拼请求，`rejudgeSteps`、`thetaUp`、`thetaDown`、`holdSteps` 由 mod 自己的 `readConfig` 读出。`tests/eval-effort-midturn.test.ts` 用 world 核对三种情形下评测发的请求与 mod 发的逐字相同：每隔 N 步的重判（mod 的请求在最新一步里有一个「进行中：」的调用，测试里的题照样写进去，评测集的题没有这种结果）、改过 `rejudgeSteps` 和 `contextTokens` 的重判、主 agent 卡住时 #7 发的再判断（`stuckRequest`：带 `trouble` 的 effort 问题加 `escalation.expected`，在第二次失败的调用结束时发出，这时没有进行中的调用，形状和评测集的题完全一样）；还核对了同样的回答下，评测记下的 `sent` 就是 mod 下一步发出的档位。
- **变体**：`en-score`（mod 现在的问法）、`zh-score`（问题用中文写）、`no-current-effort` 和 `no-counts`（state 里去掉当前档位或计数；指南 §4.1 担心当前档位会产生锚定）、`trouble`（计入的失败达到 `escalateAfter`（默认 2）的 6 题照 #7 的 `stuckRequest` 发：带上「卡住」说明、对应的问题指令和「是不是预期内」一题，那一题的回答记在逐题答案的 `expected` 里、不计分；其余 94 题的请求与 `en-score` 相同，所以这个变体的整体数字也反映了重复提问的波动）、`raw-results`（和 `en-score` 一样，只是每个调用的那一行照评测集的原文发，带着 mod 不发的「结果如何」：量这部分信息对判断的影响）。题里的 `counts.failures` 是「自上次清零以来」的失败，和 mod 的计数同义（mod 只有一份计数，中途重判和 #7 都用它）。2026-10-04 的结果是第 1 轮审查之前跑的：那时每个调用的那一行照评测集原文发（就是现在的 `raw-results`），`trouble` 变体只问 `midturn.level`；所有变体都要重跑才是现在的问法的数字（#17 按用户的决定没有重跑）。
- **评分口径**：回答选出的档位（`pickEffort`：概率最高的一档，`max` 要过 `thetaMax`）在 `accept` 里算对，评测集标的就是这个判断。mod 随后实际发出的档位记在逐题答案的 `sent` 里（`judgeMidturn`：升档要置信度过 `thetaUp`，降档要过 `thetaDown` 而且一次只降一档），`why` 是原因，另有各档概率 `p` 和 `confidence`：校准门槛时可以用同一批回答重新判断，不必重新请求（#17 按用户的决定没有校准）。评测集不记录上次升档在第几步，所以 `holdSteps` 不起作用；强制升档的下限也不加：失败是不是预期内的，按用户的拍板由 #7 让决策模型判断。
- **指标**（共用指标之外）：「每题都保持当前档」的基线（`current`，52%，gold 命中 38%）；按 gold 相对当前档该升、该降、该保持分组的中英准确率（汇总里的 `breakdown.directions`）；`sent` 的中英准确率（`breakdown.sent`）。`sent` 的准确率有上限：5 题（007、061、066、068、091）可接受的档位都比当前档低两档以上，mod 一次只降一档，这 5 题的 `sent` 不可能对。
- **结果**（2026-10-04，审核后的评测集，设置取 manifest 的默认值：`rejudgeSteps` 4、`contextTokens` 2000、`thetaUp` 0.4、`thetaDown` 0.6、`thetaMax` 0.5，`--concurrency 1`）。Jev 用同一配置跑了两次：`results/effort-midturn/2026-10-04-jev-first.json` 在合入 #15 之前跑，`2026-10-04-jev-reviewed.json` 在合入之后跑。两次发的请求逐字相同（评测集和拼请求的文件哈希都一样），只是第一次的汇总早于 #15 的 `breakdown`：分组的数字在 `groups` 里，没有 `sent` 的准确率。每次 1000 个请求、908,778 input token、约 0.038 美元，没有失败。

  准确率、一致率、gold 命中率和 `sent` 准确率是百分比，差距是百分点。Jev 写第二次运行的数字，括号里是第一次。

  | 后端（答题的模型） | 变体 | 中文准确率 | 英文准确率 | 中英差距 | 中英一致率 | gold 命中（中 / 英） | `sent` 准确率（中 / 英） | p50 / p90 ms |
  |---|---|---|---|---|---|---|---|---|
  | Jev（jev-1.13.0） | `en-score`（线上的问法） | 73（77） | 74（74） | −1（+3） | 85（84） | 57 / 54（59 / 55） | 76 / 77（79 / 77） | 286 / 352（278 / 344） |
  | Jev（jev-1.13.0） | `zh-score` | 73（73） | 72（72） | +1（+1） | 88（92） | 52 / 49（51 / 50） | 74 / 73（74 / 74） | 282 / 350（279 / 350） |
  | Jev（jev-1.13.0） | `no-current-effort` | 74（77） | 75（75） | −1（+2） | 86（86） | 56 / 57（60 / 57） | 76 / 77（76 / 76） | 285 / 354（277 / 323） |
  | Jev（jev-1.13.0） | `no-counts` | 75（73） | 74（75） | +1（−2） | 87（87） | 58 / 57（56 / 55） | 78 / 77（77 / 78） | 286 / 358（277 / 326） |
  | Jev（jev-1.13.0） | `trouble` | 75（74） | 73（75） | +2（−1） | 90（87） | 59 / 53（57 / 53） | 77 / 75（78 / 77） | 287 / 346（275 / 333） |

  - **常数基线。** 每题都保持当前档 52%（gold 命中 38%），是最好的常数；每题都答 high 50%，medium 和 xhigh 43%，low 28%，max 12%。Jev 的 `en-score` 比保持当前档高 21–25 个百分点。
  - **中英差距的门槛。** 两次运行五个变体都通过（按当时 3 个百分点的门槛，也按现在的 4 个百分点），差距在 −2 到 +3 之间。同一题同一种语言两次答案相同的，五个变体分别是 185、192、185、188、189 / 200；`en-score` 的中文准确率两次差 4 个百分点（77、73），差距从 +3 摆到 −1。变体之间 1–3 个百分点的差别都在这个波动之内，两次运行看不出哪个变体稳定更好，所以也还看不出去掉当前档位（锚定）或计数有没有好处。
  - **按升、降、保持分组**（`en-score` 第二次，中 / 英）：该升 69 / 66，该降 73 / 77，该保持 76 / 79。答错的大多是答低了：中文 19 题答低、8 题答高，英文 21 题答低、5 题答高（第一次运行中文 19 低 4 高，英文 18 低 8 高）。有 17 题 Jev 两次运行中英文都答错，例如收尾阶段降得太多（042、045、064、066、078 都答 low），该保持 max 的 024、032 答低了，长而机械的批量工作 021、063 答高了；
  - **`sent`：mod 实际会发出的档位。** Jev 的 `sent` 比选出的档位还略好一点（`en-score` 76 / 77，选出的是 73 / 74）：回答不够确定时 mod 保持原档，而保持原档常常也可以接受。
  - **`trouble`（失败满 2 次的 6 题）。** 两次运行合起来 24 个答案，带上「卡住」说明后变对 4 个、变错 2 个（017 英文两次都变对；006、057 各有一次变对、一次变错），样本太小，看不出效果。006（两次失败都是计划内的 TDD 红灯）带不带都大多答 medium。#7 按用户的拍板还要问「这些失败是不是预期内的」，那个问题这里没有评测。
  - **延迟。** Jev 的 p50 275–287 ms、p90 323–358 ms，最长 1305 ms，没有超过 1500 ms 的。mod 在工具开始执行时就发出中途请求，下一步最多再等 `rejudgeWaitMs`（300 ms），按这个延迟，回答一般在工具运行期间就到了。

#### 多轮未解决（unresolved，#37，spec #36）

- **评测集** `datasets/unresolved.jsonl`：30 题，中英对照，26 题 hard，10 题的对话超过发消息时 state 的预算（标签 `over-budget`，校验按 mod 的估算核对）。每题是一条消息加它之前的对话（形状同 effort-submit，命令轮另有 `command`），答案是 effort（`gold`、`accept`）和三选一题的金标 `triage`（`unresolved`、`resolved`、`new`）。各情形的题数和构造见 `datasets/README.md` 的「unresolved」。没有审核记录（`review/unresolved.review.jsonl`）：标注是写题时定的，需要审核时再走 `apply-review.ts`（`EDITABLE` 已登记 `gold`、`accept`、`triage`）。
- **suite**（`lib/unresolved.ts`）：请求是 mod 发消息时拼的那一个：effort 请求单独发，state 是 `turnStartState`，命令轮的 state 多一个 `command`。变体 `zh-score`（Jev 的问法）、`en-score` 和带 `-wide` 的两个。不带 `-wide` 的 state 预算是 `contextTokens`（6000），即 #38 之前 effort 题和 skill 题合在一个请求里时它拿到的；带 `-wide` 的用 `messageLimits(settings, false)`（`contextByKind.messagePlain`，24000），即 #38 之后 effort 请求（ADR 0005）拿到的，也就是 mod 现在的请求（`tests/eval-unresolved-suite.test.ts` 用 world 核对了逐字相同）。**下面的基线是在 #38 之前的代码上跑的，所以「改动之前」指不带 `-wide` 的变体；#38 之后，`zh-score-wide` 才是 mod 现在的问法。****#40 起三选一题和摘要都接上了 mod 的函数**：请求是 `unresolvedRequest` 用 mod 的 `turnStartPart`（effort 题、`withUnresolved` 加进来的三选一题 `effort.unresolved`、命令轮的 `command`、摘要的 `problem_summary`）和 `messageRequest`（state 和预算）拼的，核心发消息时用的是同一对函数，`tests/eval-unresolved-suite.test.ts` 用 world 核对两边的请求逐字相同（整个请求，包括三选一题；也核对带摘要的）。所以 `unresolved` suite 现在每个变体都问 effort 和三选一两题：三选一的回答按 mod 的读法（`readUnresolved`）读，取概率最高的选项（`judgeUnresolved` 的 `top`）映射成数据集的名字（`still_unresolved` 是 `unresolved`，`new_or_unrelated` 是 `new`），和金标 `triage` 比，单独评分（`parts.triage`）；汇总里的 `breakdown.triage` 有准确率、混淆表，和 `change`：mod 现在的两档门槛（`UNRESOLVED_THRESHOLDS`）对这些回答做的事，按次数的说法算：`right`（该加一的加了一、该清零的清零了，占全部题）、`falseAdd`（不是「仍未解决」的题被加了一，占这些题）、`lostRecord`（「仍未解决」的题被清零了，丢掉一份记录，占这些题，最贵的错）；逐题的 `detail.triageP`（三个选项的概率，数据集的名字）和 `detail.triageChange` 存在结果里，#42 校准两档门槛时不用重跑，按存下的概率重算。三选一没有可用的回答时那一题整题失败（`parse: no triage answer`），不猜。**摘要：数据集没有摘要字段，每题都按「一个问题的第一条消息」问，state 里没有 `problem_summary`**（摘要是便宜的模型逐轮续写出来的，一份对话记录里没有）；`unresolvedRequest` 的最后一个参数可以给一份摘要，这样有摘要的一次运行问的就是 mod 带摘要时问的。要不要给 30 题配摘要（手写，或用 mod 自己的 `summaryPrompt` 逐轮让便宜的模型续写，用 `claude -p --model haiku`（`eval/node.ts` 的 `claudeComplete`）），是 #42 校准时的决定。baseline 比的是请求带三选一题之前的数字（见下），题数多了一题、请求略长（240 个请求 928,213 input token，baseline 858,990），Jev 回答 effort 题不受同一请求里别的题影响，是预期，没有单独量过。
- **汇总里的数**（`breakdown`，每个变体）：`top`（gold 为 `max` 的题里答成 `max` 的比例，即最高一档的召回）、`tooHigh`、`tooLow`（判得太高、太低的题占全部题的比例）、`byLength`（长对话和不长的对话分开：准确率和最高一档的召回）、0.8.x 还有 `thetaMax`（各个门槛下的最高一档召回），0.9.0 随门槛删了。
- **改动之前的基线**（2026-10-07，jev-1.13.0，mod 的默认设置：`contextTokens` 6000、`thetaMax` 0.5，`--concurrency 1`）：`results/unresolved/2026-10-07-jev-baseline.json` 和 `-baseline-2.json`，同一配置各跑一次，每次 240 个请求、858,990 input token、约 0.036 美元，没有失败，没有迟到的回答。百分比，中文 / 英文，括号里是第二次：

  | 变体 | 准确率 | 最高一档的召回（13 题） | 判得太高 | 判得太低 | 召回：长对话（10 题）/ 不长（20 题） |
  |---|---|---|---|---|---|
  | `zh-score`（#38 之前 Jev 的问法，state 6000） | 73.3 / 73.3（73.3 / 73.3） | 15.4 / 15.4（15.4 / 7.7） | 0 / 0 | 26.7 / 26.7 | 20 / 20、12.5 / 12.5（20 / 0、12.5 / 12.5） |
  | `en-score` | 76.7 / 80.0（80.0 / 80.0） | 69.2 / 76.9（69.2 / 69.2） | 3.3 / 3.3 | 20.0 / 16.7（16.7 / 16.7） | 60 / 60、75 / 87.5（60 / 40、75 / 87.5） |
  | `zh-score-wide` | 73.3 / 73.3（76.7 / 73.3） | 23.1 / 7.7（23.1 / 23.1） | 0 / 0 | 26.7 / 26.7（23.3 / 26.7） | 40 / 0、12.5 / 12.5（40 / 40、12.5 / 12.5） |
  | `en-score-wide` | 80.0 / 83.3（80.0 / 80.0） | 69.2 / 76.9（69.2 / 76.9） | 3.3 / 3.3 | 16.7 / 13.3（16.7 / 16.7） | 60 / 60、75 / 87.5（60 / 60、75 / 87.5） |

  常数基线：每题都答 xhigh 能对 63.3%（最好的常数；gold 命中 10%），max 46.7%，medium 36.7%，high 30.0%，low 23.3%。
- **读这些数要留意的**：
  - **上线标准的起点是 `zh-score` 的 15.4%（13 题里 2 题）**，判得太高 0%、太低 26.7%。#38 之前 Jev 就是这样问的（#38 只改了 state 预算，`zh-score-wide` 就是它的结果：召回 23.1 / 7.7 和 23.1 / 23.1，几乎没变）。判得太低的 8 题（中文，英文相同）里，6 题是 gold 为 `max` 的，答的是 high。
  - **问题的语言比上下文的长度影响大得多。** 同一个 Jev、同样的 state，`en-score` 的召回是 69–77%，`zh-score` 是 8–23%：中文的 effort 题给最高一档的概率普遍低（明说「第四次了」的 `unresolved-001` 在中文问法里 `max` 的概率是 0.32，英文问法是 0.84）。`thetaMax` 降到 0.2 也只把 `zh-score` 提到 23%，所以光调门槛救不了它。代价是 `en-score` 在第二次失败的题上有一次判到 `max`（`unresolved-014`，判得太高 3.3%）。#4 里 `zh-score` 在 effort-submit 上比 `en-score` 准 8–9 个百分点才定为 Jev 的问法（现在是 `BACKEND_DEFAULTS` 的 `ask.turnStart`，当时叫 `turnStartLanguage`），这里相反：到底是 effort-submit 缺这类题，还是中文题在这一档本身偏保守，要先看这一点再决定上线标准。
  - **state 从 6000 提到 24000 的作用很小**：最高一档的召回，`zh-score` 是 15.4 / 15.4 和 15.4 / 7.7（两次，中文 / 英文），`zh-score-wide` 是 23.1 / 7.7 和 23.1 / 23.1；`en-score` 和 `en-score-wide` 一样（69–77%）。长对话里的召回比不长的低一些（`en-score` 60% 对 75–88%），但提到 24000 没有补上，而且长对话里有 3 道隐含的题（008、009、011），和短对话的构成不同，不能全算在长度上。最后一条（长日志）把预算占满的几题（`unresolved-002`、`004`、`008`、`022`、`024`）在 6000 的预算里只剩 66–120 token：消息和最后一条回复。其中明说没解决的 002、004，`en-score` 答对（max），`zh-score` 答 xhigh 和 max；隐含的 008（「还是一样」）所有变体都没答对。
  - **隐含的没解决几乎没人认出**：`implicit-unresolved` 7 题，`zh-score` 只对 2 题（010、011，都是答 xhigh），`en-score` 对 4 题；贴同样的编译错误（006）和「再看看」（007）在任何变体里都是 low 到 high。这些是摘要和三选一题要补的。
  - **波动**：两次运行请求逐字相同，每个变体 240 个回答里有几个不同；最高一档的召回只有 13 题，一题就是 7.7 个百分点，比较时用同一配置多跑几次，别拿一次的差当结论。
  - baseline 那时三选一题还不存在，这次的结果只有 effort（现在的 suite 一起问它，见上）。`unresolved-014` 一类「第二次」的题和 6 道已解决的题是看判得太高的主要样本，**effort-submit 原有用例的回归还没跑**（那是上线标准的另一半，改动之后再跑）。

#### 派出 agent（subagent，#15）

评测集、题号（`subagent-001` 起）、suite 名和结果目录沿用 `subagent` 这个名字（术语表不用这个词，统一叫「派出 agent」）：结果文件、审核记录和 issue 都按这些名字引用，所以保留，代码里的标识符已经改成 `AgentItem`、`agentSuite` 这样的写法。见 `eval/datasets/README.md` 的「名字的例外」。

- **评测集** `datasets/subagent.jsonl`：100 题，中英对照，76 题 hard。61 题是主 agent 用 Agent 工具派出的 agent（`kind: agent`），39 题是 Workflow 脚本里的一个 `agent()`（`kind: workflow`）。每题是一个 agent：用户这一轮的消息，主 agent 写给它的任务（`prompt`、`description`、agent 类型、主 agent 指定的模型）；workflow 题没有 `description`，另有 workflow 的描述和这个 `agent()` 的 `label`。答案是模型加 effort：`gold` 一个，`accept` 是可接受的模型和可接受的 effort。审核（Opus 5.5 high 的审核会话，用户同意以它的结论为准）同意 99 题，对 subagent-012 留了备注；记录和总结在 `review/subagent.review.jsonl`、`review/subagent.review-summary.md`。
- **请求与 mod 相同。** 普通派发的题：先像 mod 那样把用户的消息存成这一轮说的话（脱敏，按 `contextTokens` 截断），再用 `dispatchPart`、`dispatchState` 拼请求，用 `decideDispatch` 读回答（ADR 0015 的模型表和 effort 下限）；`agentFable` 按 `features/dispatched-agents.ts` 的读法从选项读。`tests/eval-subagent.test.ts` 用 world 核对两件事：同一条消息和同一次派发，评测发的请求与 mod 发的逐字相同；同样的回答，评测和 mod 选出同样的模型和 effort。Workflow 的题按 #8 问一个脚本的方式问：同一个 workflow（`workflow_description` 和用户的消息都相同）的题就是这个脚本的各个 `agent()`，按评测集里的顺序，用 #8 的 `workflowBatches` 分进请求（每个请求最多 4 个，0.8.x 是 8 个，各自一个 part `agent-<i>` 和一个 brief `brief_<i>`，brief 里有 `workflow_description` 和 `label`，`${file}` 这类占位符原样保留），用 #8 的 `readOutcomes` 读回答。评测集的 39 道 workflow 题来自 14 个 workflow，每个 2–4 题，都放进一个请求。每题发出它所在的那个请求、只读自己那一部分（同一请求里别的题的回答不用），所以一个 workflow 的请求一次运行会发几遍，这些题的 token 约是单发时的 2–3 倍。`tests/eval-subagent.test.ts` 核对：主 agent 提交由这几个 `agent()` 组成的脚本时，评测发的请求与 mod 发的逐字相同；同样的回答，评测的决定就是 mod 写进脚本的模型和 effort。第 1 轮审查之前这些题是每题单独一个、按普通派发的形状（`agent.*`、`brief`）问的，结果文件里的 workflow 题是那样问的。
- **变体**（0.9.0 起，ADR 0015）：`nouls`（mod 的问法：关于任务的是非题加 effort 的 Score，英文，按模型表读），`nouls-single`（和 `nouls` 一样，只是 Workflow 的每个 `agent()` 单独一个请求，part 和 brief 和合并时相同；普通派发的题和 `nouls` 完全一样，它们的数字也反映重复提问的波动），`nouls-zh`（每个问题都用 `decision/dispatched-agent.ts` 自己的中文写）。三个都**还没有运行**。0.8.x 的变体（`models-hint`、`work-hint`、`models-noul`、`work-noul`、`models-hint-single`、`models-hint-zh`）问的是那道选模型的选择题，题删了，变体也删了；下面的数字都是它们的，只能对照。注意评测集按 0.8.x 的约定标注：`priority:main-overridden` 的 16 题里有 8 题的 gold 比主 agent 的指定弱（subagent-024、027、028、030、034、068、070、096），新规则只升不降，这 8 题的模型部分按设计会错，这是用户选定的取舍（ADR 0015）。
- **评分口径**：
  - 模型在 `accept.model` 里算对。
  - effort 在 `accept.effort` 里算对。`accept.effort` 是所有可接受模型共用的一组档位，没有按模型分开，所以 accept 有两个模型时，任一个模型配任一个可接受档位都算对（例如 subagent-089 的 opus/low、029 的 sonnet/xhigh）。审核逐题看过这些组合，都说得通；以后加题要留意双模型的 accept 会不会放进不合理的组合。选 haiku 时不设 effort（null），只有 haiku 本身可接受时才算对；其他模型必须有一个档位。数据集是在 haiku 不带 effort（Haiku 4.5）时标的，所以 0.4.1 起 mod 给 Haiku 5.5 设 effort 之后，评测仍只按模型给 haiku 的回答打分（`eval/lib/subagent.ts` 的 `gradedEffort`），和已存的结果可比。
  - 整题（联合）：模型和 effort 都对。gold 命中另报。
  - 答错的方向：`model-under`、`model-over`（比所有可接受的模型都便宜、都贵），`effort-under`、`effort-over`（低于、高于所有可接受的档位，不设 effort 算作最低），`effort-none`（该有档位却没有）。
  - 没有做出决定的题算错，并写明原因：请求失败；回答里没有关于这个 agent 的答案；用户排除了所有可选模型，没有模型可选，mod 这时让 agent 按主 agent 原来的要求启动，评测无从评分。回答把概率全给了被排除的模型时不再算没有决定：选离它最近的、没被排除的模型（subagent-058，#6 的补丁）。
- **指标**（共用指标之外）：模型、effort、整题各自的中英准确率；每个 `priority:*` 情形（用户点名、保留主 agent 的指定、推翻主 agent 的指定、无指定）和每类 agent（普通派发、workflow）的错题数，分模型和 effort；每个情形里模型是谁定的（`user` 用户点名，`table` 模型表给的，`requested` 保留主 agent 的指定；0.8.x 的结果里是 `decided`）；模型表每一行定了多少题、其中模型对了多少（`breakdown.rows`）；模型和 effort 各自的中英一致率；常数基线（总是 haiku、总是 sonnet 的某一档……），以及只看模型、只看 effort 时最好的常数。
- **重新决定不重新请求。** 0.9.0 起读回答没有可调的门槛：是非题、点名和排除都按 TypeSafe 的 0.7 / 0.3（ADR 0014、0015），所以 0.8.x 的门槛扫描（`breakdown.sweeps`：`agentOverride`、`thetaNamed`、`thetaFit`）删了。每个答案仍保存原始回答，可以在规则改了之后不发请求重新决定（`redecide`）：`p_effort` 是各档的概率（从低到高），`nouls` 是每道是非题的概率（关于任务的十一道和点名、排除），`p_named_effort` 是点名 effort 一题各选项的概率（消息里有可能点名 effort 的字眼时才有，`named_effort` 是读出来的那一档），另有 `source`、`row`（模型表停在哪一行）和 `requested`（主 agent 的指定 `kept` 还是 `upgraded`）。0.8.x 的结果文件里是 `p_model`、`pick`、`confidence`，`eval/rescore.ts` 重算那些文件时模型按它们存下的回答（`answer` 的第一个词），只重算 effort。
- **标注约定**（起草和审核时定下的，加题时照此标注）：
  - workflow 题的 `description` 为 null；`agent_type` 只在脚本给 `agent()` 传了 agent 类型时才有值；fan-out 题的 `label` 和 `prompt` 保留 `${file}` 这类占位符。
  - 模型是 haiku 时 effort 为 null；`accept.effort` 含 null，当且仅当 `accept.model` 含 haiku。
  - 每题恰好一个 `priority:*` 标签：`priority:user` 是用户在本轮消息里为这项工作点名了模型，它就是唯一可接受的模型；用户写出的 effort 同样是唯一可接受的档位（用户 2026-10-04 拍板，见 issue #1 的评论）。`priority:main-kept` 的 gold 是主 agent 指定的模型，`priority:main-overridden` 的 gold 不是；`priority:none` 是主 agent 没有指定。
  - 保留还是推翻主 agent 的指定：差两档、让 haiku 写代码或做判断、让 opus 或 fable 只做汇报或机械工作（只搜索、只汇报、不需要判断），就推翻；只差一档、这个选择说得过去，就保留，gold 用主 agent 的指定，更合适的模型放进 accept。
  - 只有肯定的说法（「用 X」「X 就够了」「派个 X 去查」）才算点名。「别用 X」是约束：X 不进 accept，其余交给决策模型，标 `priority:none`；否定加肯定（「别用 opus，用 haiku」）时，肯定的那个算点名。模型名作为被比较的产品、作为线上系统用的模型、作为旧代码由谁生成被提到，都不算点名。点名只管它描述的那部分工作（「调研那种活儿用 haiku」不管实现的 agent），「这次所有 agent」管本轮派出的所有 agent。
  - 只提到 fable、答案却是默认模型的题，也打 `fable` 标签。
- **结果**（2026-10-04，jev-1.13.0，审核后的评测集）：`results/subagent/` 里有两次同样配置的 Jev 运行（`2026-10-04-jev-reviewed.json`、`2026-10-04-jev-reviewed-2.json`，各 800 个请求、约 0.04 美元）。下面的数字取第二次（第一次早于结果里的 `scoring` 说明和 subagent-058 失败原因措辞的修正，两次的答案逐题可比）：
  - mod 现在的问法 `models-hint`：整题中文 69%、英文 66%（中文高 3 个百分点，过中英差距的门槛），模型 83%/82%，effort 74%/70%，gold 命中 50%/47%；中英一致率整题 86%、模型 90%、effort 88%；延迟 p50 286 ms、p90 374 ms，超过 1500 ms 的 1 个。两次运行有 194/200 个答案相同，各项准确率相差 0–2 个百分点。
  - 常数基线：整题最好的是总是 haiku，35%；只看模型，总是 sonnet，47%；只看 effort，总是 high，45%。
  - 按情形，中/英错题数：用户点名 0/0（17 题）；保留主 agent 的指定 5/6（17 题，中文有 6 题被决策模型推翻，3 题因此选错模型）；推翻主 agent 的指定 8/8（16 题，5 题没有推翻）；无指定 18/20（50 题，错的大多在 effort：15/18）。普通派发 18/17（61 题），workflow 13/17（39 题）。
  - 四个变体相差不大，整题都在 68–71%（中文）、65–68%（英文），两次运行里没有哪个变体在两种语言上都稳定好于 `models-hint`。
  - 门槛（用同一批回答重新决定）：`agentOverride` 从 0.6 降到 0.4–0.5，`models-hint` 两次都是中文 +3、英文 +2 个百分点；永不推翻（1）降到 65%/62%。`thetaMax` 0.3 比 0.5 高 1–2 个百分点；`thetaNamed` 0.7 中文 +1。这些都是在同一套题上扫出来的，校准时要防过拟合。
- **已知的问题题**：subagent-021 两种语言都错，但原因不同：中文是决策模型以 0.895 的置信度推翻了主 agent 的 opus（推翻门槛的校准问题），英文是把「之前让 sonnet 生成的」当成了点名（0.57）。点名问题的误判都在英文、概率 0.5–0.6（021 的 sonnet、100 的 fable），中文有一次（038 的 haiku）。subagent-023 两种语言都判成 sonnet xhigh（gold medium）。subagent-012 的用户点名了 effort：用户拍板「点名的 effort 也绝不推翻」，当时 mod 还没有实现，这两次答对只是因为决策模型自己也判了 low。subagent-058 在 `work-*` 变体里没有决定：用户排除了 opus，回答又把概率全给了 opus 那一项，剩下的模型没有概率；当时的 mod 遇到这种情况会让 agent 按原来的指定启动，也就是用户排除的那个模型（`models-hint` 下没有出现）。这两件事都由 #6 的补丁修了，见下一条。
- **点名 effort 和排除模型的补丁（#6、#8，2026-10-04，jev-1.13.0）**：补丁前后各跑一次全量（四个变体 × 中英 × 100 题，各约 0.043 美元；补丁前一次是用补丁前的代码在同一套题上重跑的，不是上面第二次运行）：`2026-10-04-jev-named-effort-before.json`、`2026-10-04-jev-named-effort-after.json`。subagent-058：`work-hint`、`work-noul` 里中英四个答案，补丁前都是没有决定（会启动 opus），补丁后都是 sonnet xhigh，对；`models-*` 两个变体前后都是 sonnet xhigh。subagent-012：八个答案前后都是 sonnet low，对；补丁后的 low 是点名 effort 一题读出来的（`named_effort` 概率 1.0 给 low，中英都是），不再靠决策模型自己的 effort 打分（0.67–0.70 给 low，碰巧一致），所以这题不能区分补丁前后。`priority:user` 的 17 题，四个变体、中英，前后都是 17/17。点名 effort 一题只在消息里有可能点名 effort 的字眼时才问：全量里中文 7 题、英文 6 题出现，决策模型判为没有点名的概率都在 0.91 以上（002、047、057、058、060、077–079、085–087），只有 012 判为点名。整体准确率前后在噪声之内（`models-hint` 中文 69%→70%、英文 69%→68%），逐题变化的题都不在这两件事上（run 之间的随机波动）。

#### skill 匹配（skill，#16）

- **评测集** `datasets/skill.jsonl`：109 题，中英对照，94 题 hard，用本机真实的 skill 目录出题。目录是 `datasets/skill-catalog.json` 这份快照，按用户的决定反映撤销 jev-pilot 写进 settings 的 user-invocable-only 覆盖之后的环境：90 个主 agent 能加载的候选，21 个只能由用户触发，8 个被仓库的 settings 设成 off。每题的答案有四项：`gold`（该推荐的 skill，按优先顺序，可以为空）、`accept`（推荐了也算对的）、`must_not`（推荐了就算错的干扰项）、`user_only_hint`（该在状态行提示用户的、只能由用户触发的 skill）。22 题什么都不该推荐也不该提示，17 题要提示只能由用户触发的 skill，8 题有并列 gold。审核（Opus 5.5 high 的审核会话，用户同意以它的结论为准）同意 105 题、改 4 题：017、042、084 把过严的干扰项改为中立，100 把 run 和 ego-browser 列为并列 gold。记录和总结在 `review/skill.review.jsonl`、`review/skill.review-summary.md`，总结末尾一节写了之后的处理（4 题的理由按新答案改写）。
- **请求与 mod 相同。** suite（`eval/lib/skill.ts`）用 mod 的排序入口拼两段请求：第一段是 `skillsRequest`（共用 state、skill 的选择题和三道门控题，ranker 是 `modRanker` 配 `rankingSettings(..., 'message')`），第二段是 `modRanker(...).rank` 发出的那一个，门槛是这次运行的决策模型的（`settings.guide.skills`）。skill 的顺序从快照得到：主 agent 能加载的按引擎列表的顺序在前，只能由用户触发的按命令列表的顺序在后，off 的不进；描述取快照里的（和 `$.command.list()` 一字不差），`skillsNeverSuggested` 按 mod 的读法从选项读。第二段的正文开头读快照记下的 SKILL.md（`~` 是主目录），读到的每个文件都和快照记下的 sha256 对照，不一致或读不到的 skill 记进结果的 `about`，`run.ts` 打印警告。`tests/eval-skill.test.ts` 用 world 核对：同一条消息和对话，评测发的两段请求与 mod 发的逐字相同；同样的回答，评测和 mod 推荐、提示同样的 skill，设了 `skillsNeverSuggested` 时也一样。
- **变体**：只有 `cookbook`，就是 mod 现在的问法（ADR 0018）。0.8.x 的 `profiles`、`descriptions`、`profiles-zh` 随画像和中文问题一起去掉了，它们的结果文件留着。
- **评分口径**（审核规则；结果文件的 `scoring` 里是英文版）：答案分两部分。`suggest` 是推荐给主 agent 的 skill（0.9.0 起最多一个，cookbook 的挑法；之前最多 `skillsMax` 个，相关度不低于 `skillsMinRelevance`）：gold 为空时什么都不推才算对；否则推荐里至少有一个在 accept、而且没有一个在 must_not 才算对。既不在 accept 也不在 must_not 的 skill 是中立的：和 accept 里的一起推不扣分，只推中立的算未命中。`hint` 是状态行提示用户的、只能由用户触发的 skill（0.9.0 起每条消息最多 1 个，之前 2 个）：user_only_hint 为空时什么都不提示才算对，否则至少提示一个其中的 skill 才算对。两部分都对才算整题对。gold 命中（精确命中）是推荐的正好是 gold、提示的正好是 user_only_hint，不多不少。没有做出决定（请求失败、回答里没有 skill 问题、第二段失败）算错。答错的方式：`must-not`、`extra`（不该推荐时推荐了）、`neutral-only`、`missed`（该推荐时什么都没推），`hint-extra`、`hint-missed`、`hint-other`（只提示了不该提示的）。
- **指标**（共用指标之外，在每个变体汇总的 `breakdown` 里）：按情形分组的整题和两部分的中英准确率（`groups`：什么都不该推荐的 `none`、该推荐 skill 的 `skill-needed`（它的中文一列就是「中文请求对上英文描述的 skill」）、`multi-partial`（几个 skill 都部分相关）、`near-duplicate`（名字相近的干扰项）、`lexical-trap`（字面诱导）、`user-only`、`needs-context`（要读 `recent_context` 才知道做什么））；两段各自的延迟和发第二段的比例（`stages`，总延迟是共用指标里的 `latency`）；该推荐 skill 的题里，第一段把可接受的 skill 送进第二段、第二段让它过了门槛的题数（`funnel`）；常数基线「每题都不推荐、不提示」。延迟按 mod 的方式记两段之和：mod 让两段共用一次等待（`timeoutMs`），评测不按第一段剩下的时间截断第二段，而是数出总延迟超过 `timeoutMs` 的回答。
- **记下什么。** 每个回答存三道门控题的平均（`gate`）和它有没有拦下（`stopped`）、第一段每题排在前面的 skill 和概率（`first`、`hints`）、第二段每个候选的相关度（`fits`）、两道选择题选中谁（`winner`、`hint_winner`）和两段各自的耗时（`stages_ms`）。`breakdown` 给按情形的准确率、两段的延迟、门控拦下了多少（不该推荐的题里、该推荐的题里各占多少），以及该推荐的题里第一段把可接受的 skill 排进前三、最后推荐了它的题数。0.8.x 的门槛离线重扫（`breakdown.sweeps`）去掉了：门槛是各家指南的值，不再是选项，不在评测集上挑。
- **结果**（0.9.0 之前的做法：带画像、有「都不合适」选项、最多推荐 3 个、门槛 0.75；2026-10-04，jev-1.13.0，审核后的评测集，manifest 的默认值，`--concurrency 1`）：同一配置跑了两次，`results/skill/2026-10-04-jev-reviewed.json` 和 `-reviewed-2.json`，每次 436 个回答、843–845 个请求、约 713 万 input token、约 0.30 美元，没有失败。两次的回答 `profiles` 有 213/218 相同、`descriptions` 有 208/218 相同。准确率、一致率、gold 命中率是百分比，差距是百分点；两次不同时写成「第一次 / 第二次」。

  | 变体 | 中文准确率 | 英文准确率 | 中英差距 | 4 个百分点的门槛 | 中英一致率 | gold 命中（中 / 英） | `suggest`（中 / 英） | `hint`（中 / 英） | 总延迟 p50 / p90 ms |
  |---|---|---|---|---|---|---|---|---|---|
  | `profiles`（线上的常态） | 79.8 | 83.5 | −3.7 | 两次都通过（按当时 3 个百分点的门槛不通过） | 85.3 / 88.1 | 68.8 / 72.5 | 81.7 / 80.7；85.3 | 98.2 / 99.1；98.2 | 845 / 927；995 / 2364 |
  | `descriptions` | 80.7 / 81.7 | 82.6 | −1.8 / −0.9 | 通过 | 87.2 / 90.8 | 68.8 / 69.7；69.7 | 83.5 / 84.4；84.4 / 85.3 | 97.3；97.3 | 600 / 668；658 / 1310 |

  - **常数基线。** 每题都不推荐、不提示，整题对 20.2%（gold 命中也是 20.2%，就是那 22 道什么都不该推荐的题）；只看 `suggest` 31.2%，只看 `hint` 84.4%。两个变体都比它高约 60 个百分点。
  - **中英差距的门槛。** 线上的 `profiles` 两次都是中文 79.8、英文 83.5，差 3.7 个百分点：没过当时 3 个百分点的门槛，在现在 4 个百分点的门槛之内；`descriptions` 两次都过（−1.8、−0.9）。差距在 `suggest`：003、009、014、093、105 两次都只在中文错（014 的 git-guardrails-claude-code 和 105 的 text-to-speech 相关度 0.64–0.69，差一点到 0.7；003 第一段把 setup-pre-commit 排第一，update-config 没进第二段；009 第二段只给 revise-claude-md 0.31–0.39；093 推荐了不该推荐的 ego-browser），只在英文错的是 032（多提示了 /improve-codebase-architecture）和第一次的 109。门槛改成 0.75 时差距是 −2.3（中文 81.2、英文 83.5，两次的均值），见下面「门槛」。
  - **画像的作用。** 两个变体整体差不多，画像有得有失：不该推荐的题（`none`）画像好得多，`profiles` 两次都是 81.8 / 86.4，`descriptions` 是 72.7 / 68.2、72.7 / 77.3，画像的「何时不用」挡住了把 `implement` 这种只能由用户触发的 skill 当提示（034、038）、把 `simplify` 当推荐（028）的误判；但该推荐的题里画像略差，第一段把可接受的 skill 送进第二段的题数是中文 68、英文 69（`descriptions` 都是 71），例如 025 的 workflow-authoring 在画像下被 cloudflare:agents-sdk 抢了第一段。`user-only` 一组 `profiles` 是 64.7 / 70.6、70.6 / 70.6，`descriptions` 两次都是 76.5 / 76.5。
  - **按情形**（`profiles` 两次，中 / 英）：`none` 81.8 / 86.4；`skill-needed`（75 题）78.7 / 81.3、77.3 / 81.3；`multi-partial` 77.8 / 83.3、75.0 / 83.3；`near-duplicate` 79.7 / 84.8；`lexical-trap` 78.3 / 80.0、80.0 / 80.0；`user-only` 64.7 / 70.6、70.6 / 70.6；`needs-context` 85.0 / 85.0。`descriptions`：`none` 72.7 / 68.2、72.7 / 77.3；`skill-needed` 80.0 / 84.0、81.3 / 81.3；`multi-partial` 77.8 / 86.1、83.3 / 86.1；`near-duplicate` 84.8 / 88.1、86.4 / 84.8；`lexical-trap` 80.0 / 78.3、80.0 / 80.0；`user-only` 76.5 / 76.5；`needs-context` 90.0 / 90.0。
  - **延迟和请求大小。** `profiles` 的第一段带着 111 份画像，Jev 计 2.19 万 input token（第二段约 1.3k），`descriptions` 的第一段 8.6k。第一次运行第一段 p50 / p90 是 561 / 615 ms（`descriptions` 317 / 362），第二段 284 / 336 ms，两段合计都在 1500 ms 之内；第二次运行整体慢（各时段都慢，不集中在某一段），`profiles` 第一段 p90 1648 ms、最长 7.8 秒，218 个回答里 24 个第一段就超过 1500 ms（mod 里这条消息的整个决策请求超时，effort 也没有经过路由），另有 21 个两段合计超过（mod 里不推荐 skill）；`descriptions` 是 5 个和 8 个。几乎每条消息都发第二段：`profiles` 89.9% / 91.7%，`descriptions` 96.8% / 95.9%，因为评测集里不该推荐的题多是诱导题，第一段常给某个 skill 0.1 以上。
  - **门槛**（两次的均值，`profiles`）：`skillsMinRelevance` 在 0.3–0.8 之间很平（整题中文 79.8–81.2、英文 80.3–84.4），0.85 起明显下降（0.9：中文 70.2、英文 69.7）。中文在 0.3、0.5、0.75 都是 81.2（现在的 0.7 是 79.8），英文最好是 0.8（84.4；0.7 和 0.75 是 83.5）。按语言分别取：中文 0.75，英文 0.8；只用一个值时取 0.75（中文 81.2、英文 83.5，差距 −2.3，过门槛）。`findSkillMinRelevance`（按推荐的规则评，返回最多 5 个）中文 0.3 和 0.75 最好（83.0），0.3 的 recall 也最高（88.0；0.5 是 82.1、85.3）；英文 0.8 最好（86.2），但 recall 从 0.5 的 88.0 降到 82.7，0.5 只低 1.3（84.9）。主 agent 主动问时宁多勿漏，按语言分别取：中文 0.3，英文 0.5；只用一个值时保持 0.5。`descriptions` 下最好的值是：推荐中文 0.7、英文 0.6，`find_skill` 中文 0.4、英文 0.6。这些都是在同一套题上扫出来的，相邻的值相差 1–2 题，校准时要防过拟合；mod 现在两种语言共用一个值。
- **已知的问题题**（两次运行、两个变体、中英文都错的有 9 题：018、033、041、050、052、090、091、092、096）：
  - **只能由用户触发的 skill 挤掉了能加载的 gold**（033、090、091、092）：第一段的 Choice 把几乎全部概率给了只能由用户触发的那个（033 的 improve-codebase-architecture 0.98–1.00、090 的 grill-with-docs 0.99–1.00），能加载的 gold（codebase-design、grilling、domain-modeling）分不到 0.1，进不了第二段。提示是对的，推荐漏了。这是第一段只问一个 Choice 的结构问题：两类 skill 在同一个问题里互相抢概率。第 1 轮审查之后第一段拆成了两题（`skills.which` 只问能加载的，`skills.hint` 只问只能由用户触发的，见「开发」的排序一节），上面的数字都是拆分之前跑的，要重跑两个变体才知道这几题和整体的数字（#17 按用户的决定没有重跑）。
  - **第二段确认了诱导**：041（「这个会话想从 Opus 切到 Sonnet，命令怎么敲」，claude-api 0.91–0.93）、050（问 Graphiti 的一个参数，research 0.74–0.86），017（后台挂着 dev server，run 0.70–0.79，中立但这题不该推荐；8 次里错 7 次）。画像的「何时不用」没有挡住它们。
  - **第二段过严**：096（「ctrl+r 老跟 tmux 撞键」，第一段 keybindings-help 0.71–0.94，第二段只给 0.08–0.46）；018（在输入框上方常驻一条横栏，正是 plugin-authoring 说的 band，第二段只给 0.33–0.68，`profiles` 下还推了中立的 ui-ux-pro-max）；052（claude-api 和 typesafe-ai 之间拿不准，相关度都在 0.6 以下；053、109 也是 8 次里错 7 次）；099 只在 `profiles` 下错（code-review 0.52–0.65，security-review 在第一段只分到 0.03–0.05）。

#### Perplexity 决策后端对 Jev（pplx，#43，2026-10-07）

`pplx-decider-v1.1-27b` 接成后端（`decision/pplx.ts`），在全部评测集上和同一天、同一份代码的 Jev（jev-1.13.0）正面对比。**这一票不改 mod 的默认后端，`userConfig` 也没有它**；换不换、门槛怎么按它校准（#42）、问法用哪种语言，等这些数字之后走 `/grill-with-docs`。

- **做法。** `eval/run.ts <类> --backend pplx|jev --label r1|r2`，每个后端每套评测集跑两遍（`results/<类>/2026-10-07-pplx-r1.json`、`-r2.json`，Jev 同名），都是 `--concurrency 1`，代码是合入 #40 之后的 dp/pplx-43（结果里的 `code` 哈希一致），设置取 Jev 的默认值（pplx 读 mod 的设置时当作 Jev）。**state 预算：发消息时的 effort 请求都是 24000**（`settings.messageStateTokens`；effort-submit、unresolved 只跑 `-wide` 变体 `zh-score-wide`、`en-score-wide`，按协调者的决定不再跑 6000 的）；effort-midturn 的中途重判、subagent 的派出 agent 也是 24000（`contextByKind.rejudge`、`agent`）；skill 的两段请求是带 skill 问题的那个请求，state 6000（`config.context`，线上就是这样）。每个后端每遍 5 套：effort-submit 4 个变体 × 100 题 × 中英，effort-midturn 6 个变体、subagent 6 个变体各 100 题 × 中英，skill 3 个变体 109 题 × 中英，unresolved 2 个变体 30 题 × 中英。费用（按两边响应里的 `usage.input_tokens` 算，Jev 0.042、Perplexity 0.02 美元每百万）：一遍全部 5 套，Jev 约 0.74 美元，pplx 约 0.30 美元；整件事（两遍、扫描、探针）pplx 约 0.8 美元，Jev 约 1.5 美元。`--backend pplx --estimate` 的系数取 3：pplx 数的 token 和 mod 的估算的比，skill 0.7、effort-submit 0.9、midturn 1.0、subagent 1.7、unresolved 2.9（长日志每个字符几乎一个 token，估算是四个字符一个），系数按最坏的取，宁可高估。
- **pplx 几乎是确定的。** 两遍的回答逐题几乎全部相同（effort-submit 四个变体两遍的准确率、判高、判低一模一样），Jev 两遍差 0–3 个百分点（抽样波动）。所以 pplx 两遍的差只在延迟，比较时 Jev 看两遍的范围，pplx 看一遍就够。
- **没有失败。** 两个后端、两遍、全部套件：没有失败，没有重试（`run.attempts` 等于 `run.requests`），没有 429。skill 的行里 `attempts` 是 2，是第一段加第二段两个请求，不是重试。

**准确率、判得太高 / 太低、max 召回**（百分比，题数是 100 或 30，一题 = 1 或 3.3 个百分点；中 / 英；两遍写范围）：

| 套件（变体） | Jev 准确率 | pplx 准确率 | Jev 判高 / 判低 | pplx 判高 / 判低 | max 召回 Jev | max 召回 pplx |
|---|---|---|---|---|---|---|
| effort-submit `zh-score` | 86–88 / 85–86 | 85 / 81 | 7–8 / 5–6；9 / 5–6 | 14 / 1；16 / 3 | 2–4 / 8；2–3 / 8 | 5 / 8；4 / 8 |
| effort-submit `en-score` | 80 / 79–80 | 81 / 79 | 17 / 3；17 / 3–4 | 18 / 1；19 / 2 | 6 / 8；5 / 8 | 5 / 8；5 / 8 |
| effort-submit `zh-choice` | 88–89 / 87–89 | 87 / 83 | 4 / 7–8；5–6 / 6–7 | 9 / 4；13 / 4 | 2 / 8；2–3 / 8 | 2 / 8；2 / 8 |
| effort-submit `en-choice` | 83 / 83–84 | 88 / 83 | 11 / 6；10–11 / 5–7 | 11 / 1；15 / 2 | 6 / 8；5–6 / 8 | 5 / 8；4 / 8 |
| unresolved `zh-score-wide` | 73–77 / 70–73 | 93.3 / 93.3 | 0；0 / 23–27；27–30 | 0；0 / 6.7；6.7 | 15–23 / 13 题 | 92.3 / 13 题 |
| unresolved `en-score-wide` | 80 / 80–83 | 93.3 / 93.3 | 3.3；3.3 / 17；13–17 | 3.3；3.3 / 3.3；3.3 | 69；77–85 / 13 题 | 100；100 / 13 题 |
| effort-midturn 六个变体 | 72–79（`zh-score` 78 / 74–75） | 78–84（`zh-score` 82 / 82） | 6–11 / 13–17 | 4–11 / 6–14 | | |
| subagent `models-hint`（整题） | 69–70 / 65–67 | 62 / 62 | 23–26（effort 判高） | 36–37 | | |
| subagent `work-hint` | 66 / 64 | 68 / 69 | 24–27 | 30–31 | | |
| skill `profiles`（线上的常态） | 78.9–79.8 / 79.8 | 91.7 / 88.1 | | | | |
| skill `descriptions` | 79.8 / 79.8 | 86.2 / 88.1 | | | | |

- **effort-submit**：和 Jev 在同一个量级，不是明显更好。pplx 对「max 召回」（8 题 gold 为 max）5/8，和 Jev 的 `en-score`（5–6/8）相当，比 Jev 的 `zh-score`（2–4/8）高；判高（把不需要这么深的题判深）明显更多（`zh-score` 14–16 对 7–9，`en-score` 18–19 对 17），判低几乎没有（1–3 对 5–6）：pplx 偏向给高档，Jev 的 `pickEffort` 门槛（`thetaMax` 0.5 等）是按 Jev 校准的，换后端要重扫。不该给 max 的 88 题里 pplx 只有 `en-score`（中英各 1 题）和 `en-choice`（英文 1 题）给了 max（Jev `en-score` 英文也是 1 题）。中英差距（中文减英文，门槛是中文不比英文低过 4 个百分点）：pplx 四个变体是 +2、+4、+5、+4，中文都比英文好，都过；Jev 是 −1 到 +3。
- **unresolved**（#37 的 30 题，金标由子代理写、用户尚未审，合入 #40 之后的请求，三选一题和 effort 题在同一个请求里，24000）：**这是差别最大的一套**。线上问法 `zh-score-wide`：Jev 准确率 73–77 / 70–73、max 召回只有 2–3/13，pplx 93.3 / 93.3、max 召回 12/13；`en-score-wide`：Jev 80 / 80–83、max 召回 9–10/13，pplx 93.3、max 召回 13/13；两个后端判高最多 1 题（只在 `en-score-wide`）。中文问法在 pplx 上不再比英文差，两种问法一样好（Jev 上中文问法不敢给 max，要靠 #40 摘要和 #41 强提示补；pplx 上这个缺口基本不在）。三选一题（未解决 / 已解决 / 新问题）两个后端都是 96.7–100（30 题错 0–1 题），按两档门槛对次数的作用：「仍未解决」被清零（`lostRecord`）和被误加一（`falseAdd`）都是 0。
- **effort-midturn**：pplx 六个变体的整题准确率比 Jev 高 1–8 个百分点（多数 4–7），判低从 13–17 降到 6–14，判高相当。
- **subagent**（派出 agent，model 和 effort 两部分）：不是一边倒。`models-hint`、`models-noul`、`models-hint-single`、`models-hint-zh` pplx 低 3–8 个百分点（effort 判高 35–39 对 Jev 的 20–30，`effort` 部分 62 对 71；`model` 部分 84 对 89），`work-hint`、`work-noul` pplx 高 0–5 个百分点。
- **skill**：pplx 整题高 6–13 个百分点（`profiles` 91.7 / 88.1，Jev 78.9–79.8 / 79.8），`suggest` 94.5 / 93.6 对 82.6–83.5 / 85.3，`hint` 97.3 / 93.6 对 95–96 / 94.5。**代价是慢**，见下面。

**延迟**（`--concurrency 1`，ms；p50 / p90 / 最长，两遍的范围）：

| 请求 | Jev | pplx |
|---|---|---|
| 发消息时的 effort 请求（effort-submit，四个变体，24000） | 288–302 / 330–398 / 最长 652 | 428–432 / 445–512 / 最长 1674 |
| unresolved（effort 加三选一，含约 8k 估算 token 的长日志） | 304–332 / 362–406 / 最长 605 | 445–447 / 875–948 / 最长 2002 |
| 中途重判（effort-midturn，六个变体） | 282–291 / 315–349 / 最长 672 | 432–437 / 479–524 / 最长 1853 |
| 派出 agent（subagent，六个变体） | 286–297 / 340–370 / 最长 1384 | 438–493 / 523–650 / 最长 1841 |
| skill 两段合计，`profiles`（线上的常态和 find_skill） | 853–870 / 924–941 / 1182–1199 | **1485–1491 / 1575–1653 / 2605–2676** |
| skill 两段合计，`descriptions` | 602–620 / 656–718 / 823–1048 | 998–1007 / 1071–1151 / 1159–1482 |
| skill 第一段（`profiles`）/ 第二段 | 563–568 / 289–293 | 1062–1063 / 432–434 |

skill 的第一段带着 111 份画像，Jev 计 2.2 万 token，pplx 第一段 p50 就是 1.06 秒，加第二段 0.43 秒，**两段合计 p50 1.49 秒，贴着 Jev 的 `timeoutMs` 1500**。mod 让两段共用一次等待（`timeoutMs`），按 1500 算，`profiles` 里 pplx 的 `late`（总延迟超过 `timeoutMs`）第一遍中文 34、英文 39 题（各 109 题，`inTime` 65.1 / 58.7），第二遍 48 / 47（`inTime` 50.5 / 52.3）；Jev 是 0 / 0。也就是**线上的 skill 推荐按 1500 ms 有 31–44% 赶不上，推荐不出去**（那条消息照常，只是没有 skill 推荐；两遍相差大是因为 p50 正好贴在 1500 上）；`descriptions` 没有赶不上的（p90 1.07–1.15 秒）。`profiles-zh` 和 `profiles` 一样（`late` 第一遍 30 / 36，第二遍 51 / 50）。skill 第一段单独超过 1500 ms 的极少（最长 2.25 秒），慢在两段加起来。

**按等待时间离线重算**（用存下来的逐题 ms，两遍合起来，不重跑；结果里的 `late` 只按 mod 现在的 `timeoutMs` 1500 算，这里看 1500 / 2000 / 2500 / 3000 / 4000 ms 下按时到达的比例）：

| 请求（题数） | 后端 | p99 / 最长 | ≤1500 | ≤2000 | ≤2500 | ≤3000 | ≤4000 |
|---|---|---|---|---|---|---|---|
| 发消息时的 effort（effort-submit，1600） | Jev | 493 / 652 | 100% | 100% | 100% | 100% | 100% |
| | pplx | 599 / 1674 | 99.9% | 100% | 100% | 100% | 100% |
| 发消息时的 effort（unresolved，240） | Jev | 524 / 605 | 100% | 100% | 100% | 100% | 100% |
| | pplx | 1549 / 2002 | 98.8% | 99.6% | 100% | 100% | 100% |
| skill 两段合计 `profiles`（436；find_skill 同） | Jev | 1157 / 1199 | 100% | 100% | 100% | 100% | 100% |
| | pplx | 1786 / 2676 | **61.5%** | 99.5% | 99.5% | 100% | 100% |
| skill 两段合计 `descriptions`（436） | pplx | 1319 / 1482 | 100% | 100% | 100% | 100% | 100% |
| 派出 agent（subagent，2400） | Jev | 607 / 1384 | 100% | 100% | 100% | 100% | 100% |
| | pplx | 896 / 1841 | 99.9% | 100% | 100% | 100% | 100% |

中途重判（effort-midturn，2400 个请求）按「问题在工具开始时发出，下一步最多再等 `rejudgeWaitMs`」算：工具运行 t 毫秒时，回答赶得上的是 ms ≤ t + `rejudgeWaitMs`。Jev：t = 0 时 ≤300 ms 的 70.0%，≤500 的 99.7%；pplx：≤300 的 **0%**，≤500 的 88.0%，≤800 的 99.7%，≤1000 的 99.8%，≤1300 的 99.9%（p50 435）。所以 pplx 在 `rejudgeWaitMs` 300 下，只有工具至少跑了约 150–300 ms 的步才赶得上，快的工具（读文件、grep）后面的回答多半迟到，用在再下一步。

**对 pplx 的建议值（BACKEND_DEFAULTS，这一票不改）**：`timeoutMs` **2500**（发消息时 effort 请求按 2000 已经 99.6–99.9%，skill 的 `profiles` 两段合计 2000 是 99.5%、2500 是 99.5%、3000 是 100%；再算上下面的长状态探针，一个 24000 估算 token 的全日志状态要 2.2 秒，2500 才稳；比 1500 多出的 1 秒只落在慢的请求上，快的不受影响）；`rejudgeWaitMs` **800**（99.7% 的重判回答在下一步赶上；300 的话快工具之后几乎都迟到；这个选项不是按后端取默认值的，所以要先让它进 `PER_BACKEND_OPTIONS`）；`findSkillWaitMs` **3000**（两段合计 100%，最长 2.7 秒，find_skill 是主 agent 自己的调用，等得起）。`skillsMinRelevance`、`thetaUp` 这些门槛没有扫：pplx 的 effort 偏高，`thetaMax`、`thetaDown` 要按它的存下来的概率离线重扫（`eval/rescore.ts`）再定。

**state 预算扫描（只对 pplx，unresolved 的两个 `-wide` 变体，48000、96000 各两遍）**：和 24000 的结果逐字相同（pplx 数的 input token 都是 1,080,644，准确率、max 召回、判高判低、三选一都相同）。原因：unresolved 数据集里最长的对话估算只有约 7,980 token（60 个中英状态里最长的），effort-submit 最长约 270、skill 约 150，都远不到 24000；effort-midturn 和 subagent 没有 `recent_context`，请求平均约 900 和 2,200 token（Jev 数的）。**所以这些评测集量不出更大的窗口值不值**：它们的对话本身不够长，24000、48000、96000 发出去的请求是同一个。（`results/unresolved/2026-10-07-pplx-s48000-r1.json`、`-r2`、`s96000-r1`、`-r2`。）

要看更大窗口的代价，另做了一个探针（不是评测集，结果没有存文件）：用 unresolved 的一题，前面垫上数据集里别的对话的老消息（22 条长消息，全是日志一样的文字），状态估算 5,457 / 20,719 / 42,321 / 91,535 token，各发 5 次，中位延迟 **615 / 2,202 / 5,398 / 15,201 ms**，pplx 数的 input token 是 14,848 / 69,280 / 150,080 / 302,024（文档说上限 262,144，302,024 那次照样返回了 200）。延迟随长度线性涨，约每 1 万 pplx token 0.8–0.9 秒（文档：9 万 token 5 秒、19 万 14 秒、上限附近 23 秒）。结论：**更大的窗口在时间上不划算**：24000 估算 token 的日志状态要 2.2 秒，48000 要 5.4 秒，都在 mod 愿意等的时间之外，而数据里没有任何地方显示更多的对话让 pplx 判得更准（这里量不出来）。真的有那么长的对话，要先有评测集（这一条之后做了：见下面「长上下文」，#44，里面的结论是读到更远的信息确实准得多，但时间上不划算）；mod 的估算也不适合 pplx：长日志里每个字符几乎一个 token，估算低估 4–5 倍（24000 估算 token 的日志状态是 6.9 万 pplx token），所以预算数字对 pplx 要按它自己的 token 数理解。
- **要留意的**：（1）unresolved 的金标是 #37 的子代理写的、用户没有审过，pplx 的 93% 靠它，要审完才能当结论。（2）两个后端的 `max` 召回在 effort-submit 只有 8 题可比。（3）#35（Desktop 读不到敏感的 userConfig）同样会影响新密钥：换后端时，`PERPLEXITY_API_KEY` 要在 `userConfig` 里加一个敏感项，Desktop 的问题要一并解决。（4）mod 的 `Failure` 分类、`failureLine` 都已经覆盖 pplx 的失败，但 `FAILURE_WORDS.config` 里读缺哪个密钥的选项名只有 typesafeApiKey 一个，换后端时要加。（后记：两项都已做完，pplx 读 `PERPLEXITY_API_KEY`，0.7.1 起 Jev 也读 `TYPESAFE_API_KEY`。）

#### 长上下文：读更多对话带来多少准确率（long-context，#44，2026-10-07）

#43 的评测集最长的对话只有约 8000 估算 token，state 预算 24000、48000、96000 发出去的请求逐字相同，量不出更大窗口的价值。`long-context` 评测集（30 题，只有中文对话，字段和构造见 `datasets/README.md`「long-context」，**金标是起草者写的，用户尚未审**）就是为这个问题造的：每题把决定答案的几轮放在对话很早的位置，离最后一条消息 30000、60000、120000 估算 token（各 10 题），中间是大段中间轮次（模板生成的读代码、跑测试、改名、补注释，不是真实对话，见 README）。每题三个版本：`deep`（问题本身）、`near`（对照 a：同样长的对话，决定性几轮挪到末尾附近）、`none`（对照 b：决定性几轮整段删掉，按删掉之后的答案评分）；另有 `flow`（真实流程：deep 加 mod 在这段对话之后会有的问题摘要、未解决次数和强提示）。

- **做法。** `eval/run.ts long-context --backend pplx|jev --variants <变体> --languages zh --state-tokens N --state-messages 2000`。pplx 的 state 预算取 24000、48000、96000、135000（估算 token），Jev 取它的上限 24000；每种两遍（`results/long-context/2026-10-07-<后端>-s<预算>-r1|r2.json`；摘要、次数、强提示那几次的标签是 `flow-…`，流程的两半是 `half-…`；「mod 现在的」是不带 `--state-tokens` 和 `--state-messages` 的，标签 `mod-…`）。中文问法 `zh-*`、英文问法 `en-*` 都跑，对话都是中文。pplx 用 `--concurrency 3 --timeout 240000`（默认的单次尝试 10 秒装不下 20 万 token 的请求；并发 3 下延迟偏高，只作记录），Jev 用 `--concurrency 1`。
- **消息条数也是一个限制。** mod 的 `contextMessages` 最多 32（`readConfig` 的上界；`settings.context.messages`），state 只取最新的 32 条消息，不管预算多大：这个数据集里 32 条平均约 16500 估算 token（deep 最多 22500；near 平均 12800），所以**只放大 `--state-tokens` 不会读到更多**（`tests/eval-long-context-suite.test.ts` 钉住这一点：48000 预算加 32 条，30000 深的决定性几轮读不到）。评测加了 `--state-messages N`（`withStateMessages`）放开条数，扫描都用 2000，结果文件的 `settings.stateMessages` 记着；`pplx 24000、32 条消息` 那行是 mod 现在的两个限制，用来核对放开条数之前和之后在 24000 上是同样的答案（深的几轮都读不到，准确率 73.3 对 70，差一题）。**要用上更大的窗口，mod 里 `contextTokens` 和 `contextMessages` 的上界都要改**，现在后者不能超过 32。
- **读到了没有看得出来。** 每个回答的 `detail.seen` 记着 state 里有没有决定性几轮（`recent_context` 里有它第一条消息的开头：读到最新的若干条、从尾往前装满，有开头就有全部），汇总里 `seen` 是比例，`byDepth` 按深度分；结果文件的 `state` 是摘要（字符数、行数、首尾）。24000 读不到任何一题，48000 读到 30000 深的 10 题（33%），96000 再加 60000 深的（67%），135000 读到全部（100%，最长的 state 约 12 万估算 token，预算再大请求也一样）。**pplx 数的 token 约为估算的 1.95 到 2.1 倍**（这种代码加中文的文字；#43 的长日志是 4 到 5 倍），回包的 `usage.input_tokens` 最大 243,642（135000 预算、120000 深的题带摘要的那次；不带的最大 243,002），在 262,144 之内；按这个倍数 pplx 能读的最大预算约 12.8 万估算 token，已经是这个数据集最长的整个对话，所以 135000 就是「最大可接受值」，再大请求不变。

**问题本身（deep）：准确率、gold 命中、判高、判低（百分比；30 题，一题 3.3 个百分点）、max 召回（10 题 gold 为 max，判成 max）、state 里有决定性几轮的比例。** pplx 两遍逐字相同（确定性），Jev 两遍写范围；`pplx 24000、32 条消息` 只有一遍：第二遍中途 pplx 账户的额度用完了（HTTP 402，62 个请求失败，那份结果已删）。

| 问法 | 运行 | 准确率 | gold 命中 | 判高 | 判低 | max 召回 | 读到 |
|---|---|---|---|---|---|---|---|
| zh | pplx 24000、32 条（mod 现在的） | 73.3 | 13.3 | 13.3 | 13.3 | 0/10 | 0 |
| zh | pplx 24000 | 70.0 | 13.3 | 16.7 | 13.3 | 0/10 | 0 |
| zh | pplx 48000 | 76.7 | 23.3 | 13.3 | 10.0 | 2/10 | 33% |
| zh | pplx 96000 | 80.0 | 30.0 | 13.3 | 6.7 | 4/10 | 67% |
| zh | pplx 135000 | **86.7** | **43.3** | 10.0 | 3.3 | **6/10** | 100% |
| zh | Jev 24000、32 条（mod 现在的） | 56.7–60.0 | 10.0–13.3 | 16.7 | 23.3–26.7 | 0/10 | 0 |
| zh | Jev 24000 | 56.7–60.0 | 10.0 | 13.3 | 26.7–30.0 | 0/10 | 0 |
| en | pplx 24000、32 条（mod 现在的） | 73.3 | 6.7 | 16.7 | 10.0 | 0/10 | 0 |
| en | pplx 24000 | 73.3 | 13.3 | 16.7 | 10.0 | 1/10 | 0 |
| en | pplx 48000 | 80.0 | 26.7 | 13.3 | 6.7 | 3/10 | 33% |
| en | pplx 96000 | 83.3 | 33.3 | 13.3 | 3.3 | 6/10 | 67% |
| en | pplx 135000 | **86.7** | **50.0** | 10.0 | 3.3 | **10/10** | 100% |
| en | Jev 24000、32 条（mod 现在的） | 63.3 | 13.3 | 13.3–16.7 | 20.0–23.3 | 1/10 | 0 |
| en | Jev 24000 | 66.7 | 16.7 | 13.3 | 20.0 | 1/10 | 0 |

- **按决定性几轮的深度**（pplx，准确率 / max 召回，zh；en 的 max 召回是 3/3、3/3、4/4 对 0）：24000 时 30000、60000、120000 深的是 70、70、70（0/3、0/3、0/4）；48000 时 90、70、70（2/3，另两档读不到）；96000 时 90、80、70；135000 时 90、80、90（2/3、2/3、2/4）。每涨一档预算，刚好读到的那一档涨 10 到 20 个百分点，没读到的那几档不变：提升来自读到了那几轮，不是别的。
- **按类别**（pplx zh，24000 到 135000 的准确率）：反复未果（max，10 题）90→100，只试过一次 100→100，约定低成本 100→100，看似复杂其实简单 0→40，被历史误导 100→100，硬性约束 0→67。只有 max 的召回和那两类「早先约定了什么」的题变了；后两类即使决定性几轮就在末尾附近（near）也只有 40% 和 33%：pplx 读到了「按清单做」「改鉴权要列矩阵」，多半仍判得和没读到一样高或一样低。反复未果的题 accept 里有 xhigh，所以 24000 读不到时也判 xhigh 算对，准确率看不出缺口，要看 max 召回。

**对照组：同一对话变长本身的影响，和决定性几轮挪到末尾附近的影响**（pplx 准确率，括号里是 near 的 max 召回；Jev 24000 在后）：

| 问法 | 预算 | (a) near：决定性几轮在末尾附近 | (b) none：删掉决定性几轮（按删掉后的答案评分） |
|---|---|---|---|
| zh | 24000 | 83.3（7/10） | 93.3 |
| zh | 48000 | 83.3（6/10） | 90.0 |
| zh | 96000 | 80.0（7/10） | 90.0 |
| zh | 135000 | 80.0（6/10） | 90.0 |
| en | 24000 | 83.3（10/10） | 86.7 |
| en | 48000 | 83.3（10/10） | 86.7 |
| en | 96000 | 80.0（9/10） | 83.3 |
| en | 135000 | 83.3（9/10） | 83.3 |
| zh | Jev 24000 | 63.3–66.7（0/10） | 90.0 |
| en | Jev 24000 | 56.7–63.3（4/10） | 73.3–76.7 |

- **(b) 只是对话变长、没有那几轮**：zh 从 93.3 到 90.0，en 从 86.7 到 83.3，各差一题，在噪声之内；**对话从 2.3 万到 7 万估算 token（pplx 约 4.7 万到 14 万 token），长度本身没有拖低准确率。**
- **(a) 决定性几轮在末尾附近、对话一样长**：准确率 80 到 83.3，不随预算变；max 召回 zh 6 到 7/10、en 9 到 10/10。deep 在 135000 读到全部时是 86.7（zh）、86.7（en），max 召回 6/10（zh）、10/10（en）：**读到更远的信息和读到近处的信息一样好，所以提升来自「读到了」，不是对话变长或变短。**
- Jev 的 (a) 和 deep 的准确率差不多（zh 63–67 对 57–60，en 57–63 对 67），max 召回 zh 0/10、en 4/10（deep 是 0/10 和 1/10）：近处的几轮也读了，中文问法仍不敢给 max，和 #43 的发现一致。

**真实流程（flow）：摘要加次数加强提示，对大窗口。** `zh-flow`/`en-flow` 的 state 带 Haiku 逐轮续写的摘要（`datasets/long-context-summaries.json`，2214 轮，没有一轮没拿到摘要），次数按决定性几轮的 `says` 累计（反复未果的题 3 到 5 次，其余 0），达到 `unresolvedMaxAfter`（3）时 effort 题带强提示。次数用的是金标，等于三选一读得完全对：这是上限，不是 mod 实际会有的。

| 问法 | 运行 | 准确率 | gold 命中 | 判高 | 判低 | max 召回 | 三选一 |
|---|---|---|---|---|---|---|---|
| zh | pplx 24000，无摘要（deep） | 70.0 | 13.3 | 16.7 | 13.3 | 0/10 | 93.3 |
| zh | pplx 24000 + 摘要/次数/强提示 | 76.7 | 46.7 | 10.0 | 13.3 | **9/10** | 96.7 |
| zh | pplx 135000，无摘要（deep） | **86.7** | 43.3 | 10.0 | 3.3 | 6/10 | 100 |
| zh | pplx 135000 + 摘要/次数/强提示 | 83.3 | **56.7** | 10.0 | 6.7 | **10/10** | 90.0 |
| zh | Jev 24000，无摘要（deep） | 56.7–60.0 | 10.0 | 13.3 | 26.7–30.0 | 0/10 | 90–93.3 |
| zh | Jev 24000 + 摘要/次数/强提示 | 73.3 | 30.0–33.3 | 13.3 | 13.3 | 4–5/10 | 100 |
| en | pplx 24000，无摘要（deep） | 73.3 | 13.3 | 16.7 | 10.0 | 1/10 | 100 |
| en | pplx 24000 + 摘要/次数/强提示 | 76.7 | 40.0 | 13.3 | 10.0 | **9/10** | 93.3 |
| en | pplx 135000，无摘要（deep） | **86.7** | 50.0 | 10.0 | 3.3 | **10/10** | 96.7 |
| en | pplx 135000 + 摘要/次数/强提示 | 83.3 | 50.0 | 10.0 | 6.7 | 10/10 | 90.0 |
| en | Jev 24000，无摘要（deep） | 66.7 | 16.7 | 13.3 | 20.0 | 1/10 | 100 |
| en | Jev 24000 + 摘要/次数/强提示 | 63.3–66.7 | 40.0 | 13.3 | 20.0–23.3 | 9/10 | 93.3–96.7 |

（24000、32 条消息那一档的流程结果和 24000 的一样：pplx zh 76.7、max 9/10，Jev zh 73.3、max 6–7/10。摘要在 24000 时读不到任何决定性几轮，答案完全来自摘要、次数和强提示。）

Jev 24000 下把流程拆成两半（`zh-summary`、`zh-count`、`en-…`，**只对 Jev 跑了：pplx 的额度在这之前用完了**）：zh 只带摘要 66.7 / max 0/10，只带次数和强提示 63.3–66.7 / max 1/10，两样都带 73.3 / max 4–5/10；en 只带摘要 60–63.3 / max 3–4/10，只带次数和强提示 63.3–66.7 / max 6/10，都带 63.3–66.7 / max 9/10。强提示（次数）管 max 召回，摘要自己几乎不动 max，两样加在一起最好。

**结论：更大窗口带来多少提升。**
- **pplx 在这个数据集上，把 state 从 24000 提到 135000（对话全读到），中文问法准确率 70.0→86.7（+16.7），英文 73.3→86.7（+13.3）；gold 命中 +30 和 +37 个百分点；判低 13.3→3.3；max 召回 zh 0→6/10、en 1→10/10。** 提升随预算一档一档出现，正好是读到的那一档（见按深度）；每档预算涨 3 到 7 个百分点，每档多读到 10 题。
- **对话变长本身不拖累**（对照 b），**读到远处和读到近处一样好**（对照 a）。
- **比较摘要加次数加强提示：** 对 max（这个漏洞最要紧的地方），24000 加流程就有 9/10，和大窗口（zh 6/10、en 10/10）一样好甚至更好，请求只有 4.7 万 pplx token，大窗口的 14 万（最大 24.3 万）。对整体准确率和 gold 命中，**大窗口更准**（86.7 对 76.7）：摘要和次数只带「试过什么、失败了几次」，带不了「早先约定了低成本做法」「这块是真金白银」：24000 加流程时看似复杂其实简单只有 40%（zh）、20%（en），硬性约束 0%；大窗口读到原话，硬性约束 67%。大窗口再加流程：zh max 6→10/10，准确率 86.7→83.3（差一题，在噪声之内），英文持平；用流程补 max、用大窗口读约定，两样叠加没有明显的额外好处。Jev 的上限是 24000，没有大窗口可比，加流程准确率 +13（zh）到持平（en），max 召回 0→4–5/10（zh）、1→9/10（en）。
- **时间上不划算。** 并发 3 的延迟：24000 预算 p50 9.6 秒，48000 13.1，96000 17.0，135000 20.0 秒（最长 52.6 秒）；24000 的流程 4.8 秒。单个请求时的延迟更低（探针：24 万 token 14 秒），但都远在 #43 建议的 pplx `timeoutMs`（2500 ms）之外，所以更大的窗口只适合离线评测或不赶时间的请求，真要在线上用，要么只给 max 召回的缺口加流程，要么等 pplx 对长输入更快。延迟不是取舍依据，只作记录。

**要留意的。**（1）金标没有审；`repeated-failure` 的 accept 里有 xhigh，所以准确率低估了缺口，看 max 召回；`without` 的答案（对照 b）是起草者对「单看那条消息」的判断，只和同一份数据里的其他变体比，不要和 deep 的准确率直接比。（2）30 题一题 3.3 个百分点，pplx 两遍相同所以没有波动的估计，小于两题（约 7 个百分点）的差别不要当真；max 召回按 10 题算。（3）中间轮次是模板生成的：粗看像读代码，细读重复、代码没有逻辑；决定性几轮是手写的。用真实的长对话重做才能确定结论不依赖这种填充。（4）摘要是 Haiku 逐轮续写的，对话离开了原问题（中间是读相邻的代码）时它会改写成当前在做的事：反复未果的 10 题里 9 题的摘要还保留着原问题（long-010 变成了「Terraform 漂移这一块一共有哪些文件」），其余 20 题的摘要本来就是任务，跟着最近读的代码走；这是 mod 的摘要实际会有的样子，次数（金标）则是上限。（5）流程里次数是金标，三选一读错了的话次数和强提示会跟着错。（6）pplx 的第二遍「mod 现在的」和 pplx 的流程拆半没有跑，额度用完了（pplx 共花约 3.6 美元，Jev 约 1.25 美元，Haiku 2214 次调用走订阅）。（7）`zh-summary`、`zh-count` 是第一批结果之后才加的变体，所以 `long-context.ts` 的代码哈希在那几份结果里和其余的不同；其他变体的请求没有变（测试核对）。

#### eval v2：多 agent 出题的长对话数据集（#45）

#45 的数据集：120 题，只有中文对话，10 类各 12 题，决定性信息离末尾四档（d1 < 24k、d2 24k–48k、d3 48k–135k、d4 > 135k）各 30 题，中间轮次每档一半 `same-problem`、一半 `unrelated`，10 个领域；设计见 issue #45。这一节记数据的格式和工具，结果见下一小节「eval v2 的结果」。

- **文件**（`datasets/eval-v2/`）：素材段 `pool/<domain>-<relation>-<nn>.json`（一段一轮，3000–5000 token，`same-problem` 段用七个占位符 `{{FEATURE}}` `{{SYMPTOM}}` `{{ERROR}}` `{{FILE}}` `{{FILE2}}` `{{SYMBOL}}` `{{COMMAND}}`）；题目 `items/<category>-<nn>.json`（`opening`、`decisive`（用户消息带 `d1`、`d2`……）、`final`、`placeholders`、`middle_hint`，不含答案）；金标 `gold-author/`、`gold-labeler/`（`effort`、`accept`、`effort_without_decisive`、`triage_final`、`triage_decisive`，三选一用 mod 的选项名）。格式、每个领域的虚构仓库和规则在 `datasets/eval-v2/FORMAT.md`；检查在 `lib/eval-v2.ts`（`checkSegment`、`checkItem`、`checkGold`、`datasetWarnings`），作者自查用 `eval-v2-check.ts <文件或目录>`。
- **生成**（`lib/eval-v2.ts` 的 `buildEvalV2`，`eval-v2-gen.ts` 写文件）：每题 `[前置段] + opening + decisive + [中间段] + final`。中间段是本领域、本关系的段（`same-problem` 段填上题目的占位符值），长度让决定性几轮整段落进这一档的区间（`BINS`：d1 0–21000、d2 26000–45000、d3 51000–127000、d4 140000–160000），区间里的深度按种子抽；前置段是本领域的 `unrelated` 段，垫到按种子抽的总长 82000–150000（`TOTAL`）。同一题里不重复，跨题每段最多 6 次（`MAX_USES`），用得少的先用；中间段先给最深的题挑，前置段每题轮流拿一段（池子不够时大家都少一点）。
- **深度的两种数法**：数据里记的深度（`depth`、`depth_end`、每条决定性消息的 `depth`，以及段长、总长）按 mod 挑消息的数法：每行 `estimateTokens` 加 1，再加被问的消息；state 的预算小于它就一定读不到。区间的下界按这个数查，上界按 state 发出时的大小查（JSON，转义算在内）：mod 挑消息时按不转义的估算，截 state 时按发出的 JSON，所以一行在这两个深度之间的某个预算开始被读到。**发现**：`withinTokens` 最多截 4 次、每次按超出的比例截，引号和反斜杠很多的文字（发出时比估算大 5% 以上）会让发出去的 state 超过预算：合成数据里一题在 120122 的预算下发出的 state 是 121600 token。两边离测试组的预算（24000、48000、135000）都留了 2000 到 8000 token，给问题摘要和次数（约 600）和这种取整；`tests/eval-v2-gen.test.ts` 用 mod 自己的 `turnStartState` 核对：每档在三个预算下（各少 700 时也一样）要么读到全部决定性几轮、要么一行都读不到（素材里三分之一是转义很多的代码）。现有数据集里 state 发出时比估算大：unresolved 中位 2%、最多 16%（贴日志的题），long-context 的模板文字没有引号，不大；发出时大 10% 以上的素材段检查会提醒；整个池子都是这种段（大 17%）时 d4 拼不出来，`eval-v2-gen.ts` 会说明原因。
- **输出**：`datasets/eval-v2.jsonl` 一行一题（按 id），字段 `id`、`category`、`domain`、`bin`、`relation`、`middle_hint`、`turns`（整段对话，最后一条是被问的消息；每条有 `part`，来自素材池的有 `segment`；每条用户消息有 `msg`：前置段 `p`、opening `o`、决定性 `d`、中间段 `m`、final `f`，加序号）、`decisive`（每条决定性用户消息在 `turns` 里的位置 `at` 和深度）、`depth`、`depth_end`、`tokens`、`segments`（前置段、中间段的素材 id）。不含金标，金标按 id 对上。
- **不提交 JSONL，提交 `generated.json`**：120 题约 48.5 MB（16 题合成数据实测 6.1 MB），`datasets/.gitignore` 把它挡在 git 外。`datasets/eval-v2/generated.json` 记着种子、JSONL 的 sha256 和字节数、素材池的用量、每题的深度和长度；`validate.ts` 每次按这个种子从 `pool/` 和 `items/` 重新生成，生成的 `generated.json` 必须一字不差（本地有 JSONL 时 JSONL 也要一样），否则失败并提示重跑 `eval-v2-gen.ts`。没有 `generated.json` 时（数据还在写）只查每个文件，配额和素材池不够只警告。`validate.ts eval-v2` 只查这一部分；按 120 题模拟，生成一次约 0.5 秒。
- **素材池要多大**：按每个领域 12 题（每档 3 题、两种关系各半）、段长 3000–5000 模拟：每个领域 `same-problem` 至少 40 段（d4 的 `same-problem` 题一题就要 35–45 段不重复的）、`unrelated` 50 段（前置段和 `unrelated` 的中间段共用，先到跨题 6 次的上限）；`unrelated` 只有 40 段时十来题的总长掉到 5 万到 8 万，段平均只有 3500 token 时两边各要多 5 段左右（`PLAN`，`validate.ts` 按它警告）。
- **最终金标**（`datasets/eval-v2/gold/<id>.json`）：双方一致的取出题者那份（`source` 为 `agreed`），分歧按用户裁决（`user:author`、`user:labeler`、`user:custom`）；字段同两边的金标再加 `source`，`lib/eval-v2.ts` 的 `checkFinalGold` 检查，`validate.ts` 对着题目的决定性消息逐题核对。
- **suite**（`lib/eval-v2-suite.ts`，`run.ts eval-v2`）：读 `eval-v2.jsonl`（没有就按 `generated.json` 的种子当场拼出来写好；和 `generated.json` 记的 sha256 不符就拒绝），每题配上最终金标。最后一条是被问的消息（命令轮带 `command`），之前的全部是对话，交给 `lib/unresolved.ts` 的 `askedRequest`：和 mod 逐字相同（`tests/eval-v2-suite.test.ts` 用 world 核对）。对话只有中文，`--languages` 默认 `zh`；变体 `zh-score`、`en-score` 是问题用中文还是英文，`zh-flow`、`en-flow` 另外带 `--flow <文件>` 里这一题最后一条消息时的次数和摘要（次数达到 `unresolvedMaxAfter` 时带强提示，与 mod 相同；没有 `--flow` 时 `run.ts` 拒绝这两个变体，流程文件和这次运行的后端、预算不一致时只提醒）。评分对最终金标：可接受准确率、正好命中、判高判低、max 召回和不该给却给了 max 的比例，按深度档、按关系、按两者交叉、按类别分开；三选一对 `triage_final`（准确率、混淆表、按两档门槛次数该动没动）；`seen` 是 state 读没读到决定性几轮；每题存 effort 和三选一的概率，`thetaMax` 一栏是换门槛重算的结果。
- **真实流程**（`lib/eval-v2-flow.ts`，`eval-v2-flow.ts`）：按对话顺序，每条用户消息发 mod 的请求（effort part，带当时的摘要和次数；0.9.0 之前是 effort 题加三选一、到 `unresolvedMaxAfter` 带强提示），按 mod 的规则（`judgeUnresolved`，0.7 / 0.3）动次数：加一时给摘要最后一次尝试标未解决（`markLast`），清零时摘要一起清掉（与 `core/unresolved.ts` 相同）；每轮结束（最后一条除外）用 mod 的 `summaryPrompt` 和 `readSummary` 让 `claude -p --model haiku` 续写摘要，写不出就保留原来的。`tests/eval-v2-flow.test.ts` 用 world 核对：mod 走同一段对话时，每条消息的请求、给 Haiku 的每个提示词、最后一条时的次数和摘要都和流程相同。一个后端加预算一个文件，默认名是 `<后端>-<发消息 effort 请求的预算>.json`（后端的 `contextByKind.messagePlain`：Jev 现在是 96000，写 `results/eval-v2-flow/jev-96000.json`，pplx 是 48000；提交着的 `jev-24000.json` 是 2026-10-08/15 在 Jev 当时 24000 的 state 上跑的流程，`run.ts` 和 `eval-v2-thresholds.ts` 的用法例子仍用它），每条消息记三选一和 effort 的概率、次数前后、写没写成摘要，`final` 是最后一条消息的请求带的次数、摘要和强提示；每条消息存一次进度，再跑同一条命令从停下的消息接着跑；繁忙、断线、超时（重试之后）停下这一题，401、额度用完停下整个运行，HTTP 错误和读不出的回答照 mod 的做法记下、次数不动。Haiku 的回复按提示词缓存在 `haiku-cache.jsonl`（不提交），同一个提示词同一个回复，两个 pplx 预算在次数一致的地方共用摘要；开跑前问一次 Haiku 自己是哪个模型，连同 `claude -p` 报的模型记进文件（2026-10-08 是 `claude-haiku-5-5`）。
- **三选一门槛扫描**（0.6.x 到 0.8.x 的 `eval-v2-thresholds.ts`）：0.9.0 删了（ADR 0014：是非题用 TypeSafe 的起始值 0.7 / 0.3，不再按我们的评测扫门槛）。扫描的结果见下面「eval v2 的结果」的第 5 节，只作记录。

#### eval v2 的结果（#45，2026-10-08）

这一节只摆数字，不下结论：换不换后端、选 A、A⁺、B 哪一组，由用户定。

- **六组**：A、B′、J′ 是真跑的，中文、英文两种问法各一遍。A⁺、B、J 没有另发请求：取真实流程文件里每题最后一条消息那一步的 effort 概率和三选一概率，重放成同格式的结果文件（中文问法，和 `run.ts` 的 `zh-flow` 请求逐字相同；结果文件的 `source` 字段写了来源）。流程只用中文问法跑，所以带流程的三组只有中文问法。这是用户的决定：用户看了六组的表后问「以上这些里面带摘要的测试组是不是可以全部移除了」，同意带流程三组不另跑、不测英文问法（换问法后前面的次数和摘要也会不同）。
- **只跑了一遍，#45 的验收项「6 组 × 两种问法 × 两遍的结果」没有达成。** #45 正文写的是「测试组（各两遍）」。这次每组每种问法只有一遍，带流程三组没有英文问法，A⁺ 只有 63 题。A⁺ 停在 63 题是用户的指示（「A+可以停下了 就做这么多题 然后开始后面的测试」）。「每种问法一遍」也是用户的决定（原话「每种问法只跑一遍」）。下面的「满足 / 不满足」都按这一遍判断。
- **一遍的波动有多大。** Jev 以前同配置跑过两遍：effort-submit zh-score 86.0 / 86.5，准确率只差 0.5，但 200 个回答里有 11 个档位不同（5.5%；en-score 4 个）；unresolved zh 71.7 / 75.0、long-context en 65.6 / 68.9，各差 3.3。今天 Jev 的 effort-submit zh-score 是 88.5，比 10-07 的两遍高 2.0–2.5，和 10-07 第一遍比有 7 个（zh-score）、4 个（en-score）回答档位不同。pplx 在 10-07 的两遍逐位相同（每个概率都一样）。今天的 pplx 回归并发 6，811 次尝试里有 11 次重试；10-07 是并发 1。两次比，zh-score 有 196/200、en-score 有 198/200 个回答的概率不同，档位变了的回答是 4 个和 3 个。准确率差 0.5（83.5 对 83.0，80.5 对 80.0）；zh-score 判高 14.0 对 15.0、判低 2.5 对 2.0，en-score 判低 1.0 对 1.5。所以 pplx 隔一段时间重跑并不逐位相同。带流程三组的回答是流程在 09:41Z–13:39Z 之间跑出来的，不带流程三组在 13:42Z 以后真跑，后端状态不是同一时间的。B 对 B′、A⁺ 对 A 这类比较里混着这种漂移，大小量不出来。
- **离门槛多近。** 第 3 小节每条比较都按题数写了余量：满足的写「余 n」，指朝不利方向再变 n 题仍然满足；不满足的写「差 n」，指朝有利方向还要变 n 题才满足。贴着线的有这几条：A 对 J（63 题）准确率 +4.8，线是 +5，差 1 题（1.6 点）；A⁺ 对 J（63 题）+6.3，余 0；B 对 J（120 题）判高 +2.5，余 0；B 对 B′ 判高 +3.3，线是 +3，差 1 题；A⁺ 对 A 判高 +1.6，余 0；J 对 J′、B 对 B′（thetaMax 0.5）max 召回正好多 3 题，余 0。
- **模型**：pplx `pplx-decider-v1.1-27b`；Jev `jev-latest`，实际答题的是 `jev-1.13.0`；摘要由 `claude -p --model haiku` 续写，它自报和 `modelUsage` 都是 `claude-haiku-5-5`。
- **金标**：`datasets/eval-v2/gold/`。30 题由用户裁决（`user:labeler` 21、`user:author` 7、`user:custom` 2）。其余 90 题出题者和标注者的 effort、`triage_final`、决定性几轮的三选一一致，但其中 30 题的可接受档位（accept）不同、33 题的 `effort_without_decisive` 不同（合计 51 题）：当初的比对只看 effort 和 `triage_final`，这些都默认用了出题者的。2026-10-08 用户把这件事交给协调者裁决：accept 不同的 30 题取两者的并集（`source: "agreed+accept-union"`，提交 `aa6d6e2`），`effort_without_decisive` 仍用出题者的。**第 2–5 小节的表都是并集之前（按出题者的 accept）算的**；并集之后的数字、四种取法的敏感性和方案排名见本节最后一小节「accept 取并集后」。
- **两套门槛**：「Jev 门槛」是 mod 默认的 thetaMax 0.5；「thetaMax 0.47」是在旧数据集上按 agent 自拟的规则给 pplx 选出的值（见第 6 小节）。0.47 那几张表里**所有组都按 0.47 重算，J、J′ 也一样**，只为并排；Jev 自己的门槛是 0.5。J 和 J′ 的中文行在两个门槛下相同。J′ 的英文行在 0.47 下变了：120 题里正好命中从 34.2 变成 35.0，max 召回从 5/28 变成 6/28；63 题里正好命中从 19.0 变成 20.6，max 召回也是 5/28 变成 6/28。比较只用 J 的中文问法，所以「满足 / 不满足」不受影响。eval v2 只问最后一条消息，thetaUp、thetaDown 用不上。两套门槛都是拿存下的概率离线重算的：mod 自己的 `pickEffort`，加上 suite 的 `grade`、`summarize`。
- **单位**：没有特别说明的数字都是百分比，按题数直接算到一位小数。一题在 120 题里是 0.83 个点，在 63 题里是 1.6 个点，在一个深度档（30 题）里是 3.3 个点，在一类（12 题）里是 8.3 个点。金标是 max 的题一共 28 道：explicit-unresolved 12、implicit-unresolved 12、command-turn 4，全部在 A⁺ 的 63 题里。所以下面的 **max 召回只在这三类上量**，别的七类没有金标为 max 的题。

##### 1. 运行、估算费用、延迟

| 组 | 来源 | 请求数 | 失败数 | 估算费用 | 延迟 p50 / p90（秒） |
|---|---|---|---|---|---|
| A：pplx 135000，不带流程 | 真跑，中英问法各 120 题，并发 6，单次超时 240 秒，`--state-messages 2000` | 240 | 0 | 0.954 美元（4771 万 input token，每个请求约 0.0040） | 中文 74.0 / 82.4，英文 73.5 / 84.2 |
| B′：pplx 48000，不带流程 | 真跑，同上 | 240 | 0 | 0.382 美元（1911 万，每个请求约 0.0016） | 中文 22.5 / 23.8，英文 22.5 / 23.9 |
| J′：Jev 24000，不带流程 | 真跑，并发 4，mod 自己的设置（24000 token、32 条） | 240 | 0 | 0.279 美元（664 万，每个请求约 0.0012） | 中文 2.8 / 3.5，英文 2.8 / 3.5 |
| A⁺：pplx 135000，带流程 | 重放 `eval-v2-flow/pplx-135000.json` 中 63 题的最后一步（只有中文问法） | 0（流程 2443） | 0 | 流程 5.11 美元（2.553 亿 token，每条消息约 0.0021；含丢弃的 6 题已发的 102 条） | 没有记录 |
| B：pplx 48000，带流程 | 重放 `eval-v2-flow/pplx-48000.json`，120 题 | 0（流程 4396） | 0 | 流程 5.54 美元（2.772 亿，每条消息约 0.0013） | 没有记录 |
| J：Jev 24000，带流程 | 重放 `eval-v2-flow/jev-24000.json`，120 题 | 0（流程 4396） | 0 | 流程 4.67 美元（1.111 亿；实际发出 5978 个请求，其中 1428 个是 HTTP 402、不计费，另有 1 次 529、1 次超时；4.67 美元含 44 题作废的那部分，4396 只是最终有回答的消息数） | 没有记录 |
| effort-submit 回归 pplx / Jev | 真跑，4 变体 x 100 题 x 中英对话 | 800 / 800 | 0 / 0 | 0.007 / 0.026 美元 | |

- **费用都是估计，不是账单**：input token 乘 `run.ts` 的系数（pplx 每百万 token 0.02 美元，Jev 0.042 美元）。
- 真跑一共 2,320 个请求：三次 eval（A、B′、J′）各 240，两份 effort-submit 回归各 800。0 个失败，估算约 1.65 美元。三份流程估算约 15.3 美元，合计约 17 美元。Haiku 走订阅额度，不计入美元：Jev 流程实际调用 3279 次（缓存命中 2539 次），pplx 48000 流程 1908 次（命中 2377 次），pplx 135000 流程 1231 次（命中 1152 次）。
- 延迟是在负载下测的，包含排队。A、B′、J′ 和两份回归在 13:42:08–13:42:10Z 同时开跑。pplx 这边 A、B′、pplx 回归各开并发 6：回归在 13:48:39Z 跑完之前，同一时间最多有 18 个 pplx 请求；之后最多 12 个；B′ 在 13:57Z 跑完以后只剩 A 的 6 个。Jev 这边 J′ 和 Jev 回归各开并发 4，J′ 在 13:45Z 跑完之前同时有 8 个。#44 在并发 3 时测过：135000 的 p50 是 20.0 秒，48000 是 13.1 秒。按 mod 的超时（Jev 默认 1500 ms），pplx 的全部回答、J′ 的 237/240 个回答都会超时。流程运行器不记每条消息的延迟，所以带流程三组没有延迟数字。它们的请求和同预算、不带流程的组一样大，只多出摘要和次数（约 600 token）。
- 带流程三组的费用是整个流程的费用：每条用户消息都发一次请求。最后一问就是流程的最后一步，没有额外花钱。

##### 2. 六组的结果

**每组自己的全部题（A⁺ 63 题，其余 120 题），Jev 门槛（thetaMax 0.5，mod 默认）**

| 组 | 题数 | 可接受准确率 | 正好命中 | 判高 | 判低 | max 召回 | 误给 max | 三选一准确率 | 该加一却清零 | 不该加一却加一 |
|---|---|---|---|---|---|---|---|---|---|---|
| A（pplx 135000 不带流程，中文问法） | 120 | 69.2 | 30.8 | 12.5 | 18.3 | 25.0（7/28） | 0.0 | 85.8 | 6.8 | 1.6 |
| A（pplx 135000 不带流程，英文问法） | 120 | 72.5 | 34.2 | 13.3 | 14.2 | 42.9（12/28） | 1.1 | 86.7 | 6.8 | 0.0 |
| A⁺（pplx 135000 带流程，中文问法） | 63 | 61.9 | 20.6 | 9.5 | 28.6 | 17.9（5/28） | 0.0 | 85.7 | 12.2 | 4.5 |
| B（pplx 48000 带流程，中文问法） | 120 | 63.3 | 28.3 | 18.3 | 18.3 | 21.4（6/28） | 3.4 | 75.0 | 16.9 | 3.3 |
| B′（pplx 48000 不带流程，中文问法） | 120 | 65.0 | 28.3 | 15.0 | 20.0 | 10.7（3/28） | 0.0 | 79.2 | 11.9 | 3.3 |
| B′（pplx 48000 不带流程，英文问法） | 120 | 71.7 | 30.8 | 15.8 | 12.5 | 35.7（10/28） | 0.0 | 83.3 | 13.6 | 1.6 |
| J（Jev 24000 带流程，中文问法） | 120 | 62.5 | 33.3 | 15.8 | 21.7 | 10.7（3/28） | 0.0 | 70.8 | 22.0 | 0.0 |
| J′（Jev 24000 不带流程，中文问法） | 120 | 62.5 | 30.0 | 15.0 | 22.5 | 0.0（0/28） | 0.0 | 75.0 | 15.3 | 0.0 |
| J′（Jev 24000 不带流程，英文问法） | 120 | 61.7 | 34.2 | 13.3 | 25.0 | 17.9（5/28） | 0.0 | 75.8 | 11.9 | 1.6 |

**每组自己的全部题，thetaMax 0.47（pplx 各组的校准值；J、J′ 也按 0.47 算，只为并排）**

| 组 | 题数 | 可接受准确率 | 正好命中 | 判高 | 判低 | max 召回 | 误给 max | 三选一准确率 | 该加一却清零 | 不该加一却加一 |
|---|---|---|---|---|---|---|---|---|---|---|
| A（pplx 135000 不带流程，中文问法） | 120 | 69.2 | 30.8 | 12.5 | 18.3 | 25.0（7/28） | 0.0 | 85.8 | 6.8 | 1.6 |
| A（pplx 135000 不带流程，英文问法） | 120 | 72.5 | 35.0 | 13.3 | 14.2 | 46.4（13/28） | 1.1 | 86.7 | 6.8 | 0.0 |
| A⁺（pplx 135000 带流程，中文问法） | 63 | 61.9 | 22.2 | 9.5 | 28.6 | 21.4（6/28） | 0.0 | 85.7 | 12.2 | 4.5 |
| B（pplx 48000 带流程，中文问法） | 120 | 63.3 | 29.2 | 18.3 | 18.3 | 25.0（7/28） | 3.4 | 75.0 | 16.9 | 3.3 |
| B′（pplx 48000 不带流程，中文问法） | 120 | 65.0 | 27.5 | 15.0 | 20.0 | 10.7（3/28） | 0.0 | 79.2 | 11.9 | 3.3 |
| B′（pplx 48000 不带流程，英文问法） | 120 | 71.7 | 30.8 | 15.8 | 12.5 | 35.7（10/28） | 0.0 | 83.3 | 13.6 | 1.6 |
| J（Jev 24000 带流程，中文问法） | 120 | 62.5 | 33.3 | 15.8 | 21.7 | 10.7（3/28） | 0.0 | 70.8 | 22.0 | 0.0 |
| J′（Jev 24000 不带流程，中文问法） | 120 | 62.5 | 30.0 | 15.0 | 22.5 | 0.0（0/28） | 0.0 | 75.0 | 15.3 | 0.0 |
| J′（Jev 24000 不带流程，英文问法） | 120 | 61.7 | 35.0 | 13.3 | 25.0 | 21.4（6/28） | 0.0 | 75.8 | 11.9 | 1.6 |

**同一批 63 题（A⁺ 覆盖的那批），Jev 门槛（thetaMax 0.5，mod 默认）**

| 组 | 题数 | 可接受准确率 | 正好命中 | 判高 | 判低 | max 召回 | 误给 max | 三选一准确率 | 该加一却清零 | 不该加一却加一 |
|---|---|---|---|---|---|---|---|---|---|---|
| A（pplx 135000 不带流程，中文问法） | 63 | 60.3 | 25.4 | 7.9 | 31.7 | 25.0（7/28） | 0.0 | 85.7 | 4.9 | 4.5 |
| A（pplx 135000 不带流程，英文问法） | 63 | 71.4 | 31.7 | 7.9 | 20.6 | 42.9（12/28） | 0.0 | 90.5 | 7.3 | 0.0 |
| A⁺（pplx 135000 带流程，中文问法） | 63 | 61.9 | 20.6 | 9.5 | 28.6 | 17.9（5/28） | 0.0 | 85.7 | 12.2 | 4.5 |
| B（pplx 48000 带流程，中文问法） | 63 | 58.7 | 17.5 | 12.7 | 28.6 | 21.4（6/28） | 0.0 | 77.8 | 19.5 | 4.5 |
| B′（pplx 48000 不带流程，中文问法） | 63 | 55.6 | 17.5 | 11.1 | 33.3 | 10.7（3/28） | 0.0 | 81.0 | 12.2 | 4.5 |
| B′（pplx 48000 不带流程，英文问法） | 63 | 69.8 | 25.4 | 11.1 | 19.0 | 35.7（10/28） | 0.0 | 87.3 | 14.6 | 0.0 |
| J（Jev 24000 带流程，中文问法） | 63 | 55.6 | 15.9 | 14.3 | 30.2 | 10.7（3/28） | 0.0 | 73.0 | 26.8 | 0.0 |
| J′（Jev 24000 不带流程，中文问法） | 63 | 49.2 | 9.5 | 15.9 | 34.9 | 0.0（0/28） | 0.0 | 79.4 | 22.0 | 0.0 |
| J′（Jev 24000 不带流程，英文问法） | 63 | 54.0 | 19.0 | 14.3 | 31.7 | 17.9（5/28） | 0.0 | 77.8 | 17.1 | 0.0 |

**同一批 63 题，thetaMax 0.47（J、J′ 也按 0.47 算，只为并排）**

| 组 | 题数 | 可接受准确率 | 正好命中 | 判高 | 判低 | max 召回 | 误给 max | 三选一准确率 | 该加一却清零 | 不该加一却加一 |
|---|---|---|---|---|---|---|---|---|---|---|
| A（pplx 135000 不带流程，中文问法） | 63 | 60.3 | 25.4 | 7.9 | 31.7 | 25.0（7/28） | 0.0 | 85.7 | 4.9 | 4.5 |
| A（pplx 135000 不带流程，英文问法） | 63 | 71.4 | 33.3 | 7.9 | 20.6 | 46.4（13/28） | 0.0 | 90.5 | 7.3 | 0.0 |
| A⁺（pplx 135000 带流程，中文问法） | 63 | 61.9 | 22.2 | 9.5 | 28.6 | 21.4（6/28） | 0.0 | 85.7 | 12.2 | 4.5 |
| B（pplx 48000 带流程，中文问法） | 63 | 58.7 | 19.0 | 12.7 | 28.6 | 25.0（7/28） | 0.0 | 77.8 | 19.5 | 4.5 |
| B′（pplx 48000 不带流程，中文问法） | 63 | 55.6 | 15.9 | 11.1 | 33.3 | 10.7（3/28） | 0.0 | 81.0 | 12.2 | 4.5 |
| B′（pplx 48000 不带流程，英文问法） | 63 | 69.8 | 25.4 | 11.1 | 19.0 | 35.7（10/28） | 0.0 | 87.3 | 14.6 | 0.0 |
| J（Jev 24000 带流程，中文问法） | 63 | 55.6 | 15.9 | 14.3 | 30.2 | 10.7（3/28） | 0.0 | 73.0 | 26.8 | 0.0 |
| J′（Jev 24000 不带流程，中文问法） | 63 | 49.2 | 9.5 | 15.9 | 34.9 | 0.0（0/28） | 0.0 | 79.4 | 22.0 | 0.0 |
| J′（Jev 24000 不带流程，英文问法） | 63 | 54.0 | 20.6 | 14.3 | 31.7 | 21.4（6/28） | 0.0 | 77.8 | 17.1 | 0.0 |

分母：误给 max 按 accept 里没有 max 的题算（120 题里 87 题，63 题里 30 题）；该加一却清零按 `triage_final` 为 still_unresolved 的题算（59 题、41 题）；不该加一却加一按其余的题算（61 题、22 题）。这两项按 mod 现在的 0.5 / 0.7 两档算。

**读到决定性几轮的比例**（全部题，Jev 门槛）：

| 组（问法） | state 读到全部决定性几轮 | 读到其中一部分 | 答得像没读到（题数） | state 平均 token | 最大 token |
|---|---|---|---|---|---|
| A pplx 135000 不带流程 zh | 75.0 | 75.0 | 38.7 (75) | 116691 | 134944 |
| A pplx 135000 不带流程 en | 75.0 | 75.0 | 26.7 (75) | 116691 | 134944 |
| A⁺ pplx 135000 带流程 zh | 76.2 | 76.2 | 37.7 (53) | 117581 | 135015 |
| B pplx 48000 带流程 zh | 50.0 | 50.0 | 41.3 (75) | 46353 | 47984 |
| B′ pplx 48000 不带流程 zh | 50.0 | 50.0 | 42.7 (75) | 46397 | 47999 |
| B′ pplx 48000 不带流程 en | 50.0 | 50.0 | 26.7 (75) | 46397 | 47999 |
| J Jev 24000 带流程 zh | 25.0 | 25.0 | 36.0 (75) | 22388 | 23998 |
| J′ Jev 24000 不带流程 zh | 25.0 | 25.0 | 41.3 (75) | 22424 | 23996 |
| J′ Jev 24000 不带流程 en | 25.0 | 25.0 | 26.7 (75) | 22424 | 23996 |

同一批 63 题上，「答得像没读到」（53 题）是：A 37.7 / 26.4（zh / en），A⁺ 37.7，B 41.5，B′ 45.3 / 22.6，J 35.8，J′ 45.3 / 28.3。

**流程带进最后一问的东西**（`compare.json` 的 `carried`）。带流程组和不带流程组的请求只差三样：摘要、次数、次数达到 3 时的强提示。

| 组 | 题数 | 带了摘要 | 次数 > 0 | 次数达到 3、带强提示 | 次数 > 0 的题的次数 |
|---|---|---|---|---|---|
| A⁺（pplx 135000） | 63 | 63 | 16 | 13 | 1, 1, 2, 3, 4, 5, 6, 7, 7, 7, 10, 10, 31, 35, 38, 40 |
| B（pplx 48000） | 120 | 120 | 39 | 31 | 1 ×5, 2 ×3, 3 ×4, 4 ×3, 5, 6, 7 ×3, 8 ×4, 9 ×3, 10, 13, 14 ×2, 16 ×2, 18, 26, 30, 36, 37, 38 |
| J（Jev 24000） | 120 | 120 | 36 | 24 | 1 ×8, 2 ×4, 3 ×2, 4 ×5, 5 ×5, 6 ×3, 7, 8 ×2, 9, 10, 11 ×2, 13, 18 |

同一批 63 题上，B 有 18 题次数 > 0、15 题带强提示，J 是 19 题、11 题。所以带流程组的大部分请求（A⁺ 47/63、B 81/120、J 84/120）次数是 0、没有强提示，和不带流程组只差一段摘要。pplx 的两份流程里各有几题次数很大（B 有 5 题 26–38，A⁺ 有 4 题 31–40；Jev 最多 18）：pplx 的三选一把许多中间轮次判成「仍未解决」，次数一直没被清零（流程记录 `flow-pplx-48000.md` 写了这一点要在门槛扫描时留意）。

A⁺ 覆盖的 63 题：类别 cheap-agreement、command-turn、explicit-unresolved、hard-constraint、implicit-unresolved 各 12 题，加 looks-hard-is-easy-01..03。misleading-history、new-topic、resolved、single-attempt 四类一题都没有。深度档 d1 16、d2 16、d3 16、d4 15；same-problem 31、unrelated 32。金标 effort 是 low 7、medium 10、high 4、xhigh 14、max 28。三选一金标是 still_unresolved 41、new_or_unrelated 22，没有 resolved。A⁺ 和别的组比，要用「同一批 63 题」那两张表。

##### 3. #45 正文的比较，逐条

余量的写法见本节开头：「余 n」是朝不利方向再变 n 题仍然满足，「差 n」是朝有利方向还要变 n 题才满足。120 题时「J+5 点」要多对 6 题，「J+3 点」最多多 3 题；63 题时分别是多对 4 题、最多多 1 题。

**A、A⁺、B 各对 J**：要求可接受准确率 ≥ J+5 点、判高 ≤ J+3 点、max 召回 ≥ J、effort-submit 判高 ≤ Jev+3 点。J 只有中文问法，所以都用中文问法比。A⁺ 只能在 63 题上比，A、B 在同样 63 题上的行也列出来。

| 比较（中文问法） | 题数 | 门槛 | 可接受准确率（差） | ≥ J+5 点 | 判高（差） | ≤ J+3 点 | max 召回 | ≥ J |
|---|---|---|---|---|---|---|---|---|
| A 对 J | 120 | 0.5 | 69.2 对 62.5（+6.7，多对 8 题） | 满足（余 2） | 12.5 对 15.8（-3.3） | 满足（余 7） | 7/28 对 3/28 | 满足（余 4） |
| B 对 J | 120 | 0.5 | 63.3 对 62.5（+0.8，多对 1 题） | **不满足**（差 5） | 18.3 对 15.8（+2.5） | 满足（余 0） | 6/28 对 3/28 | 满足（余 3） |
| A⁺ 对 J | 63 | 0.5 | 61.9 对 55.6（+6.3，多对 4 题） | 满足（余 0） | 9.5 对 14.3（-4.8） | 满足（余 4） | 5/28 对 3/28 | 满足（余 2） |
| A 对 J | 63 | 0.5 | 60.3 对 55.6（+4.8，多对 3 题） | **不满足**（差 1） | 7.9 对 14.3（-6.3） | 满足（余 5） | 7/28 对 3/28 | 满足（余 4） |
| B 对 J | 63 | 0.5 | 58.7 对 55.6（+3.2，多对 2 题） | **不满足**（差 2） | 12.7 对 14.3（-1.6） | 满足（余 2） | 6/28 对 3/28 | 满足（余 3） |
| A 对 J | 120 | 0.47 | 69.2 对 62.5（+6.7） | 满足（余 2） | 12.5 对 15.8（-3.3） | 满足（余 7） | 7/28 对 3/28 | 满足（余 4） |
| B 对 J | 120 | 0.47 | 63.3 对 62.5（+0.8） | **不满足**（差 5） | 18.3 对 15.8（+2.5） | 满足（余 0） | 7/28 对 3/28 | 满足（余 4） |
| A⁺ 对 J | 63 | 0.47 | 61.9 对 55.6（+6.3） | 满足（余 0） | 9.5 对 14.3（-4.8） | 满足（余 4） | 6/28 对 3/28 | 满足（余 3） |
| A 对 J | 63 | 0.47 | 60.3 对 55.6（+4.8） | **不满足**（差 1） | 7.9 对 14.3（-6.3） | 满足（余 5） | 7/28 对 3/28 | 满足（余 4） |
| B 对 J | 63 | 0.47 | 58.7 对 55.6（+3.2） | **不满足**（差 2） | 12.7 对 14.3（-1.6） | 满足（余 2） | 7/28 对 3/28 | 满足（余 4） |

J 的中文行在 0.47 和 0.5 下相同，所以 0.47 那几行就是「pplx 组 0.47 对 J 0.5」。

effort-submit 判高 ≤ Jev+3 点：这一条不看 state 预算，A、A⁺、B 三组的情况相同。中文问法 pplx 14.0（28/200）对 Jev 7.0（14/200），+7.0，**不满足**（差 8 个回答）；英文问法 18.5（37/200）对 17.5（35/200），+1.0，满足（余 4 个回答）。两套门槛下判高都一样（thetaMax 管不到这部分判高，见第 6 小节）。

满足情况一览（两套门槛结果相同；effort-submit 一栏写中文问法 / 英文问法）。A、B 在 120 题和同一批 63 题上都列出来：

| 候选 | 准确率 ≥ J+5 | 判高 ≤ J+3 | max 召回 ≥ J | effort-submit 判高 ≤ Jev+3 |
|---|---|---|---|---|
| A（120 题） | 满足（+6.7，余 2） | 满足（−3.3） | 满足（7 对 3） | 不满足 / 满足 |
| A（同一批 63 题） | **不满足**（+4.8，差 1） | 满足（−6.3） | 满足（7 对 3） | 不满足 / 满足 |
| A⁺（63 题） | 满足（+6.3，余 0） | 满足（−4.8） | 满足（5–6 对 3） | 不满足 / 满足 |
| B（120 题） | **不满足**（+0.8，差 5） | 满足（+2.5，余 0） | 满足（6–7 对 3） | 不满足 / 满足 |
| B（同一批 63 题） | **不满足**（+3.2，差 2） | 满足（−1.6） | 满足（6–7 对 3） | 不满足 / 满足 |

在同一批 63 题上，准确率这一条只有 A⁺ 满足；A 在 120 题上满足，在这 63 题上不满足。

**带流程对不带流程：A⁺ 对 A、B 对 B′、J 对 J′**。要求 max 召回至少多 3 题，并且判高不超过 3 点。只有中文问法。

「判高不超过 3 点」原文有两种读法：判高比对照组高出不超过 3 点，或者判高本身不超过 3%。下表按前一种算；按后一种，三条都不满足（判高 9.5、18.3、15.8）。

| 比较（中文问法） | 题数 | 门槛 | max 召回（差） | 多 ≥ 3 题 | 判高（差） | ≤ +3 点 | 可接受准确率（差，参考） |
|---|---|---|---|---|---|---|---|
| A⁺ 对 A | 63 | 0.5 | 5/28 对 7/28（-2 题） | **不满足**（差 5） | 9.5 对 7.9（+1.6，多 1 题） | 满足（余 0） | 61.9 对 60.3（+1.6） |
| B 对 B′ | 120 | 0.5 | 6/28 对 3/28（+3 题） | 满足（余 0） | 18.3 对 15.0（+3.3，多 4 题） | **不满足**（差 1） | 63.3 对 65.0（-1.7） |
| A⁺ 对 A | 63 | 0.47 | 6/28 对 7/28（-1 题） | **不满足**（差 4） | 9.5 对 7.9（+1.6） | 满足（余 0） | 61.9 对 60.3（+1.6） |
| B 对 B′ | 120 | 0.47 | 7/28 对 3/28（+4 题） | 满足（余 1） | 18.3 对 15.0（+3.3） | **不满足**（差 1） | 63.3 对 65.0（-1.7） |
| J 对 J′ | 120 | 0.5 | 3/28 对 0/28（+3 题） | 满足（余 0） | 15.8 对 15.0（+0.8，多 1 题） | 满足（余 2） | 62.5 对 62.5（+0.0） |

这三条比较里，带流程组的回答来自 09:41Z–13:39Z 的流程，不带流程组来自 13:42Z 以后的真跑，差别里混着后端随时间的漂移（见本节开头）。

**A 对 B（d3、d4）**：#45 的说法是「A 高 10 点以上说明摘要代替不了原文」。只有中文问法；d1、d2 两行作参考。一个深度档 30 题，10 点是 3 题。d2 正好 +10.0，在边界上：按「≥ 10」读是，按「> 10」读不是。

| 深度档 | 门槛 | A 中文（对的题 / 30） | B 中文 | A − B | A 高 10 点以上 |
|---|---|---|---|---|---|
| d1（参考） | 0.5 | 70.0（21） | 76.7（23） | -6.7 | 否 |
| d2（参考） | 0.5 | 76.7（23） | 66.7（20） | +10.0 | 边界（正好 10） |
| d3 | 0.5 | 80.0（24） | 63.3（19） | +16.7 | 是（余 2） |
| d4 | 0.5 | 50.0（15） | 46.7（14） | +3.3 | 否（差 2） |
| d1（参考） | 0.47 | 70.0（21） | 76.7（23） | -6.7 | 否 |
| d2（参考） | 0.47 | 76.7（23） | 66.7（20） | +10.0 | 边界（正好 10） |
| d3 | 0.47 | 80.0（24） | 63.3（19） | +16.7 | 是（余 2） |
| d4 | 0.47 | 50.0（15） | 46.7（14） | +3.3 | 否（差 2） |

**effort-submit 回归**（当前代码，今天跑一遍，和 10-07 的结果并列）：

| 文件 | 问法 | thetaMax | 回答数 | 可接受准确率 | 判高 | 判低 | max 召回 | 误给 max |
|---|---|---|---|---|---|---|---|---|
| pplx 今天 | zh-score | 0.5 | 200 | 83.5 | 14.0 | 2.5 | 8/16 | 0 |
| pplx 今天 | zh-score | 0.47 | 200 | 84.0 | 14.0 | 2.0 | 9/16 | 0 |
| pplx 今天 | en-score | 0.5 | 200 | 80.5 | 18.5 | 1.0 | 11/16 | 2 |
| pplx 今天 | en-score | 0.47 | 200 | 80.5 | 18.5 | 1.0 | 11/16 | 2 |
| pplx 10-07 r1 | zh-score | 0.5 | 200 | 83.0 | 15.0 | 2.0 | 9/16 | 0 |
| pplx 10-07 r1 | zh-score | 0.47 | 200 | 83.0 | 15.0 | 2.0 | 9/16 | 0 |
| pplx 10-07 r1 | en-score | 0.5 | 200 | 80.0 | 18.5 | 1.5 | 10/16 | 2 |
| pplx 10-07 r1 | en-score | 0.47 | 200 | 80.0 | 18.5 | 1.5 | 11/16 | 2 |
| Jev 今天 | zh-score | 0.5 | 200 | 88.5 | 7.0 | 4.5 | 7/16 | 0 |
| Jev 今天 | en-score | 0.5 | 200 | 80.0 | 17.5 | 2.5 | 12/16 | 2 |
| Jev 10-07 r1 | zh-score | 0.5 | 200 | 86.0 | 8.5 | 5.5 | 6/16 | 0 |
| Jev 10-07 r1 | en-score | 0.5 | 200 | 80.0 | 17.0 | 3.0 | 11/16 | 1 |
| Jev 10-07 r2 | zh-score | 0.5 | 200 | 86.5 | 8.0 | 5.5 | 5/16 | 0 |
| Jev 10-07 r2 | en-score | 0.5 | 200 | 79.5 | 17.0 | 3.5 | 11/16 | 1 |

pplx 今天和 10-07 比：概率向量在 zh-score 196/200、en-score 198/200 个回答上不同，档位不同的是 4 个和 3 个回答。准确率 83.5 对 83.0、80.5 对 80.0，判高 14.0 对 15.0、判低 2.5 对 2.0（zh-score）。今天并发 6、有 11 次重试，10-07 是并发 1。10-07 的两遍 pplx 逐位相同。Jev 今天 zh-score 88.5，10-07 两遍是 86.0、86.5；en-score 80.0，10-07 是 79.5–80.0。Jev 10-07 两遍之间 zh-score 有 11 个、en-score 有 4 个回答档位不同。

##### 4. 按深度档、关系、类别

**按深度档**（全部题，Jev 门槛）：每格依次是可接受准确率 / 判高 / 判低 / max 命中数比金标为 max 的题数，括号里是题数。设计上，d1 三个预算都读得到，d2 只有 48000 和 135000 读得到，d3 只有 135000 读得到，d4 谁都读不到。

| 组 | d1 | d2 | d3 | d4 |
|---|---|---|---|---|
| A 中文 | 70.0 / 10.0 / 20.0 / 0/7（30） | 76.7 / 10.0 / 13.3 / 3/6（30） | 80.0 / 10.0 / 10.0 / 4/8（30） | 50.0 / 20.0 / 30.0 / 0/7（30） |
| A 英文 | 76.7 / 10.0 / 13.3 / 2/7（30） | 80.0 / 10.0 / 10.0 / 4/6（30） | 80.0 / 10.0 / 10.0 / 6/8（30） | 53.3 / 23.3 / 23.3 / 0/7（30） |
| A⁺ 中文 | 68.8 / 12.5 / 18.8 / 0/7（16） | 56.3 / 12.5 / 31.3 / 1/6（16） | 68.8 / 6.3 / 25.0 / 2/8（16） | 53.3 / 6.7 / 40.0 / 2/7（15） |
| B 中文 | 76.7 / 10.0 / 13.3 / 2/7（30） | 66.7 / 20.0 / 13.3 / 1/6（30） | 63.3 / 16.7 / 20.0 / 1/8（30） | 46.7 / 26.7 / 26.7 / 2/7（30） |
| B′ 中文 | 73.3 / 10.0 / 16.7 / 1/7（30） | 73.3 / 13.3 / 13.3 / 2/6（30） | 63.3 / 16.7 / 20.0 / 0/8（30） | 50.0 / 20.0 / 30.0 / 0/7（30） |
| B′ 英文 | 76.7 / 13.3 / 10.0 / 5/7（30） | 76.7 / 13.3 / 10.0 / 5/6（30） | 73.3 / 13.3 / 13.3 / 0/8（30） | 60.0 / 23.3 / 16.7 / 0/7（30） |
| J 中文 | 70.0 / 10.0 / 20.0 / 1/7（30） | 60.0 / 16.7 / 23.3 / 1/6（30） | 66.7 / 10.0 / 23.3 / 0/8（30） | 53.3 / 26.7 / 20.0 / 1/7（30） |
| J′ 中文 | 73.3 / 10.0 / 16.7 / 0/7（30） | 60.0 / 16.7 / 23.3 / 0/6（30） | 63.3 / 6.7 / 30.0 / 0/8（30） | 53.3 / 26.7 / 20.0 / 0/7（30） |
| J′ 英文 | 73.3 / 6.7 / 20.0 / 5/7（30） | 66.7 / 13.3 / 20.0 / 0/6（30） | 53.3 / 10.0 / 36.7 / 0/8（30） | 53.3 / 23.3 / 23.3 / 0/7（30） |

换成 thetaMax 0.47 以后，只有下面 4 格变了，变的都是 max 命中数（准确率、判高、判低不变），其余和上表相同：

- A 英文 d1：max 命中 2/7 → 3/7
- A⁺ 中文 d2：1/6 → 2/6
- B 中文 d3：1/8 → 2/8
- J′ 英文 d2：0/6 → 1/6（Jev 组也按 0.47 算了，只为并排）

**按关系**：中间轮次和原问题的关系是 same-problem 还是 unrelated。有一个混淆要先说明：前 54 题（explicit-unresolved、implicit-unresolved、single-attempt、resolved 全部，以及 new-topic-01..06）里，每个领域只出现一种关系。backend-api、devops-ci、docs-writing、ios、security 全是 same-problem，frontend、database、data-scripts、cc-mods、perf 全是 unrelated；按出题公式，关系和领域编号同奇偶。后 66 题大体反过来：每个领域有 6 题是一种关系，另一种关系只有 0–2 题。全部 120 题每个领域两种关系各 6 题，但关系的差别里同时混着领域的差别。前后两批的类别也大部分不同：前 54 题是上面那四类加 new-topic-01..06，后 66 题是 cheap-agreement、command-turn、hard-constraint、looks-hard-is-easy、misleading-history 加 new-topic-07..12，只有 new-topic 两边都有。所以下面把后 66 题、前 54 题分开再算一遍（Jev 门槛，括号里是题数；A⁺ 只有它覆盖的那部分）。

可接受准确率：

| 组 | 全部：same-problem | 全部：unrelated | 后 66 题：same-problem | 后 66 题：unrelated | 前 54 题：same-problem | 前 54 题：unrelated |
|---|---|---|---|---|---|---|
| A 中文 | 68.3（60） | 70.0（60） | 51.5（33） | 69.7（33） | 88.9（27） | 70.4（27） |
| A 英文 | 70.0（60） | 75.0（60） | 54.5（33） | 69.7（33） | 88.9（27） | 81.5（27） |
| A⁺ 中文 | 71.0（31） | 53.1（32） | 52.6（19） | 65.0（20） | 100.0（12） | 33.3（12） |
| B 中文 | 63.3（60） | 63.3（60） | 45.5（33） | 57.6（33） | 85.2（27） | 70.4（27） |
| B′ 中文 | 63.3（60） | 66.7（60） | 45.5（33） | 63.6（33） | 85.2（27） | 70.4（27） |
| B′ 英文 | 63.3（60） | 80.0（60） | 45.5（33） | 66.7（33） | 85.2（27） | 96.3（27） |
| J 中文 | 73.3（60） | 51.7（60） | 51.5（33） | 51.5（33） | 100.0（27） | 51.9（27） |
| J′ 中文 | 71.7（60） | 53.3（60） | 48.5（33） | 48.5（33） | 100.0（27） | 59.3（27） |
| J′ 英文 | 73.3（60） | 50.0（60） | 54.5（33） | 51.5（33） | 96.3（27） | 48.1（27） |

三选一准确率：

| 组 | 全部：same-problem | 全部：unrelated | 后 66 题：same-problem | 后 66 题：unrelated | 前 54 题：same-problem | 前 54 题：unrelated |
|---|---|---|---|---|---|---|
| A 中文 | 85.0（60） | 86.7（60） | 75.8（33） | 93.9（33） | 96.3（27） | 77.8（27） |
| A 英文 | 90.0（60） | 83.3（60） | 81.8（33） | 84.8（33） | 100.0（27） | 81.5（27） |
| A⁺ 中文 | 93.5（31） | 78.1（32） | 89.5（19） | 85.0（20） | 100.0（12） | 66.7（12） |
| B 中文 | 85.0（60） | 65.0（60） | 75.8（33） | 78.8（33） | 96.3（27） | 48.1（27） |
| B′ 中文 | 86.7（60） | 71.7（60） | 78.8（33） | 81.8（33） | 96.3（27） | 59.3（27） |
| B′ 英文 | 91.7（60） | 75.0（60） | 87.9（33） | 84.8（33） | 96.3（27） | 63.0（27） |
| J 中文 | 91.7（60） | 50.0（60） | 90.9（33） | 69.7（33） | 92.6（27） | 25.9（27） |
| J′ 中文 | 88.3（60） | 61.7（60） | 84.8（33） | 75.8（33） | 92.6（27） | 44.4（27） |
| J′ 英文 | 91.7（60） | 60.0（60） | 87.9（33） | 78.8（33） | 96.3（27） | 37.0（27） |

**按类别**（全部题，Jev 门槛；每类 12 题，A⁺ 的 looks-hard-is-easy 只有 3 题，「–」表示 A⁺ 没有这一类）。

可接受准确率：

| 类别 | A 中文 | A 英文 | A⁺ 中文 | B 中文 | B′ 中文 | B′ 英文 | J 中文 | J′ 中文 | J′ 英文 |
|---|---|---|---|---|---|---|---|---|---|
| explicit-unresolved | 58.3 | 83.3 | 75.0 | 66.7 | 58.3 | 91.7 | 75.0 | 75.0 | 75.0 |
| implicit-unresolved | 58.3 | 75.0 | 58.3 | 66.7 | 50.0 | 83.3 | 58.3 | 50.0 | 50.0 |
| single-attempt | 100.0 | 75.0 | – | 83.3 | 100.0 | 91.7 | 100.0 | 100.0 | 83.3 |
| resolved | 91.7 | 100.0 | – | 91.7 | 91.7 | 100.0 | 83.3 | 100.0 | 91.7 |
| new-topic | 75.0 | 66.7 | – | 50.0 | 66.7 | 58.3 | 33.3 | 41.7 | 33.3 |
| cheap-agreement | 66.7 | 66.7 | 66.7 | 41.7 | 50.0 | 50.0 | 41.7 | 33.3 | 33.3 |
| looks-hard-is-easy | 25.0 | 33.3 | 66.7 | 25.0 | 25.0 | 25.0 | 50.0 | 50.0 | 66.7 |
| misleading-history | 100.0 | 91.7 | – | 91.7 | 91.7 | 91.7 | 83.3 | 91.7 | 83.3 |
| hard-constraint | 25.0 | 33.3 | 25.0 | 25.0 | 25.0 | 25.0 | 33.3 | 16.7 | 25.0 |
| command-turn | 91.7 | 100.0 | 83.3 | 91.7 | 91.7 | 100.0 | 66.7 | 66.7 | 75.0 |

判高 / 判低：

| 类别 | A 中文 | A 英文 | A⁺ 中文 | B 中文 | B′ 中文 | B′ 英文 | J 中文 | J′ 中文 | J′ 英文 |
|---|---|---|---|---|---|---|---|---|---|
| explicit-unresolved | 0.0/41.7 | 0.0/16.7 | 0.0/25.0 | 0.0/33.3 | 0.0/41.7 | 0.0/8.3 | 0.0/25.0 | 0.0/25.0 | 0.0/25.0 |
| implicit-unresolved | 0.0/41.7 | 0.0/25.0 | 0.0/41.7 | 0.0/33.3 | 0.0/50.0 | 0.0/16.7 | 0.0/41.7 | 0.0/50.0 | 0.0/50.0 |
| single-attempt | 0.0/0.0 | 8.3/16.7 | – | 16.7/0.0 | 0.0/0.0 | 0.0/8.3 | 0.0/0.0 | 0.0/0.0 | 0.0/16.7 |
| resolved | 0.0/8.3 | 0.0/0.0 | – | 0.0/8.3 | 0.0/8.3 | 0.0/0.0 | 8.3/8.3 | 0.0/0.0 | 0.0/8.3 |
| new-topic | 16.7/8.3 | 16.7/16.7 | – | 25.0/25.0 | 16.7/16.7 | 25.0/16.7 | 16.7/50.0 | 16.7/41.7 | 8.3/58.3 |
| cheap-agreement | 33.3/0.0 | 33.3/0.0 | 33.3/0.0 | 58.3/0.0 | 50.0/0.0 | 50.0/0.0 | 58.3/0.0 | 66.7/0.0 | 66.7/0.0 |
| looks-hard-is-easy | 75.0/0.0 | 66.7/0.0 | 33.3/0.0 | 75.0/0.0 | 75.0/0.0 | 75.0/0.0 | 50.0/0.0 | 50.0/0.0 | 33.3/0.0 |
| misleading-history | 0.0/0.0 | 8.3/0.0 | – | 8.3/0.0 | 8.3/0.0 | 8.3/0.0 | 16.7/0.0 | 8.3/0.0 | 16.7/0.0 |
| hard-constraint | 0.0/75.0 | 0.0/66.7 | 0.0/75.0 | 0.0/75.0 | 0.0/75.0 | 0.0/75.0 | 0.0/66.7 | 0.0/83.3 | 0.0/75.0 |
| command-turn | 0.0/8.3 | 0.0/0.0 | 8.3/8.3 | 0.0/8.3 | 0.0/8.3 | 0.0/0.0 | 8.3/25.0 | 8.3/25.0 | 8.3/16.7 |

三选一准确率：

| 类别 | A 中文 | A 英文 | A⁺ 中文 | B 中文 | B′ 中文 | B′ 英文 | J 中文 | J′ 中文 | J′ 英文 |
|---|---|---|---|---|---|---|---|---|---|
| explicit-unresolved | 100.0 | 100.0 | 100.0 | 75.0 | 83.3 | 83.3 | 58.3 | 83.3 | 83.3 |
| implicit-unresolved | 66.7 | 83.3 | 66.7 | 58.3 | 58.3 | 75.0 | 58.3 | 58.3 | 50.0 |
| single-attempt | 100.0 | 100.0 | – | 75.0 | 91.7 | 83.3 | 58.3 | 75.0 | 66.7 |
| resolved | 75.0 | 75.0 | – | 66.7 | 66.7 | 66.7 | 41.7 | 41.7 | 50.0 |
| new-topic | 100.0 | 100.0 | – | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| cheap-agreement | 91.7 | 100.0 | 91.7 | 91.7 | 100.0 | 100.0 | 100.0 | 100.0 | 91.7 |
| looks-hard-is-easy | 83.3 | 66.7 | 66.7 | 41.7 | 58.3 | 66.7 | 50.0 | 58.3 | 66.7 |
| misleading-history | 75.0 | 66.7 | – | 66.7 | 66.7 | 75.0 | 83.3 | 75.0 | 83.3 |
| hard-constraint | 91.7 | 100.0 | 91.7 | 91.7 | 91.7 | 100.0 | 83.3 | 91.7 | 100.0 |
| command-turn | 75.0 | 75.0 | 83.3 | 83.3 | 75.0 | 83.3 | 75.0 | 66.7 | 66.7 |

max 命中（只有三类有金标为 max 的题，全部 max 召回就是这三类的合计）：

| 类别 | A 中文 | A 英文 | A⁺ 中文 | B 中文 | B′ 中文 | B′ 英文 | J 中文 | J′ 中文 | J′ 英文 |
|---|---|---|---|---|---|---|---|---|---|
| explicit-unresolved | 5/12 | 7/12 | 3/12 | 4/12 | 3/12 | 5/12 | 2/12 | 0/12 | 2/12 |
| implicit-unresolved | 0/12 | 3/12 | 1/12 | 2/12 | 0/12 | 4/12 | 1/12 | 0/12 | 2/12 |
| command-turn | 2/4 | 2/4 | 1/4 | 0/4 | 0/4 | 1/4 | 0/4 | 0/4 | 1/4 |

每组中英问法的「深度档 x 关系」8 格交叉（`byBinRelation`）在结果文件的 `summary.variants[].breakdown` 里。两套门槛、两种题集的汇总在 `results/eval-v2/compare.json`；它的比例先取到四位小数，换成一位小数的百分数时有十几格会差 0.1，这一节的表是按题数直接算的。

##### 5. 三选一门槛扫描（给 #42）

数据是决定性几轮里用户消息的金标（`triage_decisive`），对照流程文件里同一条消息的三选一概率。#45 定的选法：在误清零 ≤ 2% 的组合里，取加一召回最高的。平手时依次看误加一、清零召回、中间轮次误改，最后看离现在的 0.5/0.7 多近，这个平手顺序是 agent 自定的。中间轮次误改 = same-problem 段被清零加上 unrelated 段被加一。same-problem 段被加一算不算误改有争议，所以另列。完整输出在 `results/eval-v2/thresholds-jev.json`、`thresholds-pplx.json`。

| 流程文件 | 加一 / 清零 | 加一召回 | 误清零 | 误加一 | 清零召回 | 中间轮次 same-problem 被清零 | 中间轮次 unrelated 被加一 | 中间轮次误改合计 | （另列）same-problem 被加一 |
|---|---|---|---|---|---|---|---|---|---|
| Jev 24000（305 条决定性消息） | 现在 0.50 / 0.70 | 96.1 | 1.6 | 2.3 | 85.9 | 31.6 | 0.3 | 15.3 | 37.1 |
| Jev 24000（305 条决定性消息） | 规则选出 0.10 / 0.91 | 100.0 | 0.0 | 34.5 | 49.7 | 2.6 | 6.9 | 4.8 | 96.1 |
| pplx 48000（305 条） | 现在 0.50 / 0.70 | 97.7 | 0.8 | 1.1 | 96.0 | 24.3 | 0.0 | 11.7 | 61.0 |
| pplx 48000（305 条） | 规则选出 0.18 / 0.83 | 100.0 | 0.0 | 4.0 | 93.2 | 12.6 | 0.2 | 6.1 | 82.9 |
| pplx 135000（63 题，171 条） | 现在 0.50 / 0.70 | 98.8 | 1.2 | 0.0 | 95.5 | 17.1 | 0.2 | 7.5 | 67.5 |
| pplx 135000（63 题，171 条） | 规则选出 0.23 / 0.80 | 100.0 | 0.0 | 3.4 | 94.3 | 10.8 | 0.2 | 4.8 | 85.4 |
| pplx 两份合并（476 条） | 现在 0.50 / 0.70 | 98.1 | 0.9 | 0.8 | 95.8 | 22.0 | 0.1 | 10.2 | 63.1 |
| pplx 两份合并（476 条） | 规则选出 0.18 / 0.83 | 100.0 | 0.0 | 3.8 | 92.8 | 11.5 | 0.2 | 5.5 | 84.6 |

分母：305 条决定性消息里金标仍未解决的 128 条（加一召回、误清零），其余 177 条（误加一、清零召回）；135000 是 83 / 88 条，合并是 211 / 265 条。中间轮次 48000 和 Jev 各有 same-problem 1090 条、unrelated 1183 条，135000 是 508 / 666 条，合并是 1598 / 1849 条。

照字面规则选出的值：**Jev 加一 0.10 / 清零 0.91，pplx 加一 0.18 / 清零 0.83**。pplx 48000 单独扫和两份合并扫，选出的值相同；135000 那份只有 63 题，单独扫是 0.23 / 0.80。规则只限误清零、不限误加一，所以 Jev 选出的值误加一是 34.5%。下面列出每个加一门槛下最低可行的清零门槛（frontier，加一门槛每 0.05 一格），想同时限制误加一时可以从这里挑：

**Jev 24000**

| 加一 / 最低可行清零 | 加一召回 | 误清零 | 误加一 | 清零召回 | 中间 same-problem 被清零 | 中间 unrelated 被加一 | 中间误改合计 | same-problem 被加一 |
|---|---|---|---|---|---|---|---|---|
| 0.05 / 0.96 | 100.0 | 0.0 | 68.9 | 21.5 | 0.4 | 25.8 | 13.6 | 99.4 |
| 0.10 / 0.91 | 100.0 | 0.0 | 34.5 | 49.7 | 2.6 | 6.9 | 4.8 | 96.1 |
| 0.15 / 0.86 | 99.2 | 0.8 | 18.1 | 68.9 | 7.9 | 3.4 | 5.5 | 90.3 |
| 0.20 / 0.81 | 98.4 | 0.8 | 13.0 | 78.5 | 14.6 | 1.7 | 7.9 | 81.7 |
| 0.25 / 0.76 | 98.4 | 1.6 | 10.7 | 82.5 | 21.7 | 1.3 | 11.1 | 73.9 |
| 0.30 / 0.71 | 97.7 | 1.6 | 9.0 | 85.9 | 30.4 | 0.8 | 15.0 | 66.2 |
| 0.35 / 0.66 | 97.7 | 1.6 | 7.3 | 87.6 | 38.8 | 0.5 | 18.9 | 58.4 |
| 0.40 / 0.65 | 97.7 | 1.6 | 6.2 | 88.1 | 40.1 | 0.4 | 19.4 | 50.1 |
| 0.45 / 0.65 | 96.9 | 1.6 | 4.0 | 88.1 | 40.1 | 0.3 | 19.4 | 43.7 |
| 0.50 / 0.65 | 96.1 | 1.6 | 2.3 | 88.1 | 40.1 | 0.3 | 19.4 | 37.1 |
| 0.55 / 0.65 | 96.1 | 1.6 | 1.1 | 88.1 | 40.1 | 0.3 | 19.4 | 31.5 |
| 0.60 / 0.65 | 94.5 | 1.6 | 1.1 | 88.1 | 40.1 | 0.2 | 19.3 | 26.7 |
| 0.65 / 0.66 | 91.4 | 1.6 | 0.6 | 87.6 | 38.8 | 0.1 | 18.7 | 21.4 |
| 0.70 / 0.71 | 89.1 | 1.6 | 0.6 | 85.9 | 30.4 | 0.0 | 14.6 | 16.7 |
| 0.75 / 0.76 | 83.6 | 1.6 | 0.6 | 82.5 | 21.7 | 0.0 | 10.4 | 12.6 |
| 0.80 / 0.81 | 79.7 | 0.8 | 0.0 | 78.5 | 14.6 | 0.0 | 7.0 | 8.3 |

**pplx 48000**

| 加一 / 最低可行清零 | 加一召回 | 误清零 | 误加一 | 清零召回 | 中间 same-problem 被清零 | 中间 unrelated 被加一 | 中间误改合计 | same-problem 被加一 |
|---|---|---|---|---|---|---|---|---|
| 0.05 / 0.96 | 100.0 | 0.0 | 13.0 | 79.7 | 0.5 | 0.7 | 0.6 | 97.1 |
| 0.10 / 0.91 | 100.0 | 0.0 | 6.2 | 89.3 | 3.9 | 0.3 | 2.0 | 91.3 |
| 0.15 / 0.86 | 100.0 | 0.0 | 4.0 | 92.1 | 10.2 | 0.3 | 5.1 | 86.1 |
| 0.20 / 0.81 | 99.2 | 0.0 | 3.4 | 94.9 | 14.5 | 0.2 | 7.0 | 80.8 |
| 0.25 / 0.76 | 99.2 | 0.8 | 3.4 | 95.5 | 20.2 | 0.1 | 9.7 | 76.4 |
| 0.30 / 0.71 | 99.2 | 0.8 | 2.8 | 95.5 | 23.9 | 0.1 | 11.5 | 73.1 |
| 0.35 / 0.66 | 98.4 | 0.8 | 2.3 | 96.0 | 27.9 | 0.1 | 13.4 | 70.5 |
| 0.40 / 0.61 | 98.4 | 0.8 | 1.7 | 97.7 | 30.2 | 0.0 | 14.5 | 67.1 |
| 0.45 / 0.56 | 98.4 | 0.8 | 1.1 | 98.9 | 33.5 | 0.0 | 16.1 | 63.9 |
| 0.50 / 0.51 | 97.7 | 0.8 | 1.1 | 98.9 | 36.9 | 0.0 | 17.7 | 61.0 |
| 0.55 / 0.56 | 97.7 | 0.8 | 0.6 | 98.9 | 33.5 | 0.0 | 16.1 | 57.4 |
| 0.60 / 0.61 | 96.9 | 0.8 | 0.6 | 97.7 | 30.2 | 0.0 | 14.5 | 54.4 |
| 0.65 / 0.66 | 96.9 | 0.8 | 0.6 | 96.0 | 27.9 | 0.0 | 13.4 | 51.1 |
| 0.70 / 0.71 | 96.9 | 0.8 | 0.6 | 95.5 | 23.9 | 0.0 | 11.5 | 48.4 |
| 0.75 / 0.76 | 96.1 | 0.8 | 0.6 | 95.5 | 20.2 | 0.0 | 9.7 | 43.9 |
| 0.80 / 0.81 | 96.1 | 0.0 | 0.6 | 94.9 | 14.5 | 0.0 | 7.0 | 39.3 |

**pplx 两份合并**

| 加一 / 最低可行清零 | 加一召回 | 误清零 | 误加一 | 清零召回 | 中间 same-problem 被清零 | 中间 unrelated 被加一 | 中间误改合计 | same-problem 被加一 |
|---|---|---|---|---|---|---|---|---|
| 0.05 / 0.96 | 100.0 | 0.0 | 13.6 | 75.8 | 0.6 | 1.0 | 0.8 | 97.4 |
| 0.10 / 0.91 | 100.0 | 0.0 | 6.4 | 87.9 | 3.6 | 0.4 | 1.9 | 92.0 |
| 0.15 / 0.86 | 100.0 | 0.0 | 4.5 | 90.9 | 8.9 | 0.3 | 4.3 | 87.4 |
| 0.20 / 0.81 | 99.5 | 0.0 | 3.4 | 94.3 | 13.2 | 0.2 | 6.2 | 82.5 |
| 0.25 / 0.76 | 99.1 | 0.5 | 3.4 | 95.5 | 18.0 | 0.1 | 8.4 | 79.0 |
| 0.30 / 0.71 | 99.1 | 0.5 | 2.6 | 95.5 | 21.7 | 0.1 | 10.1 | 75.5 |
| 0.35 / 0.66 | 98.6 | 0.9 | 1.9 | 96.2 | 25.4 | 0.1 | 11.8 | 72.7 |
| 0.40 / 0.61 | 98.6 | 0.9 | 1.5 | 97.4 | 27.9 | 0.1 | 13.0 | 69.3 |
| 0.45 / 0.56 | 98.6 | 0.9 | 1.1 | 98.9 | 31.0 | 0.1 | 14.4 | 66.0 |
| 0.50 / 0.51 | 98.1 | 0.9 | 0.8 | 99.2 | 34.7 | 0.1 | 16.1 | 63.1 |
| 0.55 / 0.56 | 98.1 | 0.9 | 0.4 | 98.9 | 31.0 | 0.1 | 14.4 | 59.9 |
| 0.60 / 0.61 | 97.2 | 0.9 | 0.4 | 97.4 | 27.9 | 0.1 | 13.0 | 56.8 |
| 0.65 / 0.66 | 97.2 | 0.9 | 0.4 | 96.2 | 25.4 | 0.0 | 11.8 | 52.0 |
| 0.70 / 0.71 | 97.2 | 0.5 | 0.4 | 95.5 | 21.7 | 0.0 | 10.0 | 48.6 |
| 0.75 / 0.76 | 96.7 | 0.5 | 0.4 | 95.5 | 18.0 | 0.0 | 8.3 | 44.1 |
| 0.80 / 0.81 | 96.7 | 0.0 | 0.4 | 94.3 | 13.2 | 0.0 | 6.1 | 39.3 |

扫描要留意的：

- **同一批数据上选、同一批数据上评，没有留出集。** 选出的门槛在这些消息上量出的数字会偏好，别的对话上会差一些，差多少没有估计（没有区间，也没有波动估计）。
- **「误清零 ≤ 2%」是很少的几条消息。** 128 条仍未解决的决定性消息，2% 是 2.56 条，所以这条线等于「最多 2 条」；现在的 0.5/0.7 在 Jev 上正好误清零 2 条（1.6%），pplx 48000 上 1 条。这些消息来自 120 题，一题有 1–5 条，同一题里的消息不独立。
- **合并那份重复计数。** pplx 135000 的 171 条是 63 题的决定性消息，同样这 63 题的消息在 48000 那份里也算了一次（按另一个预算的概率），所以合并的 476 条里有 171 对是同一条消息。135000 单独那份只有 63 题，类别不全，缺的 57 题（含没跑完的 looks-hard-is-easy-04..09）不在内。
- **离线重判。** 换门槛后，后面的请求本会带着不同的次数和强提示，这一点没算进去。
- **pplx 的次数会攒得很高**（见第 2 小节「流程带进最后一问的东西」）：现在的门槛下 B 有 5 题次数 26–38、A⁺ 有 4 题 31–40；中间轮次 same-problem 段被加一的比例 pplx 是 61.0–67.5%，Jev 是 37.1%。

##### 6. pplx 门槛校准（在旧数据集上，eval v2 没有参与）

用 effort-submit、unresolved、long-context（中途门槛另用 effort-midturn）里已存的 pplx 回答离线重判，没有发请求。核对过：用当时的门槛重算，每个档位、每个中途 `sent` 都和原结果相同。

**选值规则里 thetaMax 和 thetaUp 两条是做校准的 agent 自己拟的，用户没有确认过**；thetaDown 用的是用户在 0.2.3 定的规则，但「附近」「仍低于」怎么量（判高不超过 Jev 两遍里较高的那遍再加 1 个回答等）也是 agent 的读法。下表的值是这些规则选出来的，不是建议。

| 门槛 | Jev 现值（mod 默认） | 按规则选出的 pplx 值 | 规则和依据 |
|---|---|---|---|
| `thetaMax` | 0.5 | **0.47** | agent 自拟的规则（DEVELOPMENT 原来没有 thetaMax 的选值规则）。逐组判，每组都要满足：只看 thetaMax 管得到的那部分判高（不该给 max 却给了），个数不超过 Jev 同组两遍里较多的那遍再加 1；判低率不超过 Jev 同组较高的那遍；max 召回不少于 Jev 同组较少的那遍。在全部组都可行的值里取最高。中英两种问法共同的可行区间是 0.42–0.48，上沿压在 submit-034 上（p(max) = 0.480，概率只存了三位小数），所以取 0.47 |
| `thetaUp` | 0.3 | 0（保守备选 0.3） | agent 自拟的规则：约束沿用 thetaDown 的两条，在满足约束的值里取 en-score 和 zh-score 判高加判低之和最小的。0–0.35 都满足约束。0 比 0.3 在 400 个中途回答里只多对约 11 个，而且是在同一批题上量的，所以另列 0.3 作保守备选。eval v2 用不上 |
| `thetaDown` | 0.55 | 0.55 | 用户在 0.2.3 定的规则：偏高回到对照组附近，偏低仍低于对照组，满足的取最高。0.6 起 en-score 的判高超过 Jev。eval v2 用不上 |

thetaMax 各组的可行区间：effort-submit 中文问法 0.30–0.58、英文问法 0.42–0.48；unresolved 0.30–0.84 / 0.36–0.73；long-context 135000 0.30–0.90 / 0.32–0.80；long-context 48000 0.30–0.90 / 0.35–0.78；long-context flow 135000 0.30–0.83 / 0.30–0.70。其中 0.30 和 0.90 是扫描范围的端点，不是可行边界：按同一规则扫 0.20–0.95，四组中文问法的下沿都是 0.20，long-context 中文问法到 0.95 仍可行。换一种读法，结果从 0.47 到 0.69 不等：去掉召回这一条是 0.68，按语言合成一个池是 0.69。差别全在「取最高」时让出多少 max 召回。只用中文问法时同一套规则给出 0.58。thetaMax 降不下 pplx 在 effort-submit 中文问法上的判高（0.33 到 0.90 之间一直是 15.0，Jev 是 8.0–8.5），因为多出来的判高来自其他档，不是 max。

用这套门槛时旧数据集上的数字（准确率 / 判高 / 判低 / max 召回；Jev 一栏是两遍的范围）：

| 套件（问法） | Jev（它的门槛） | pplx 用 Jev 门槛（0.5 / 0.3 / 0.55） | pplx 用规则选出的门槛（0.47 / 0 / 0.55） |
|---|---|---|---|
| effort-submit zh-score | 86.0–86.5 / 8.0–8.5 / 5.5 / 5–6 of 16 | 83.0 / 15.0 / 2.0 / 9 | 83.0 / 15.0 / 2.0 / 9 |
| effort-submit en-score | 79.5–80.0 / 17.0 / 3.0–3.5 / 11 | 80.0 / 18.5 / 1.5 / 10 | 80.0 / 18.5 / 1.5 / 11 |
| unresolved zh-score-wide | 71.7–75.0 / 0 / 25.0–28.3 / 5–6 of 26 | 93.3 / 0 / 6.7 / 24 | 93.3 / 0 / 6.7 / 24 |
| unresolved en-score-wide | 80.0–81.7 / 3.3 / 15.0–16.7 / 19 | 93.3 / 3.3 / 3.3 / 26 | 93.3 / 3.3 / 3.3 / 26 |
| long-context zh，pplx 135000（Jev 24000） | 70.0–72.2 / 8.9 / 18.9–21.1 / 0 of 20 | 85.6 / 8.9 / 5.6 / 12 | 85.6 / 8.9 / 5.6 / 14 |
| long-context en，pplx 135000 | 65.6–68.9 / 8.9 / 22.2–25.6 / 5 | 84.4 / 11.1 / 4.4 / 19 | 85.6 / 11.1 / 3.3 / 19 |
| long-context zh，pplx 48000 | 同上 | 83.3 / 10.0 / 6.7 / 8 | 83.3 / 10.0 / 6.7 / 8 |
| long-context en，pplx 48000 | 同上 | 83.3 / 11.1 / 5.6 / 13 | 82.2 / 12.2 / 5.6 / 14 |
| long-context zh-flow，pplx 135000 | 73.3 / 13.3 / 13.3 / 4–5 of 10 | 83.3 / 10.0 / 6.7 / 10 | 83.3 / 10.0 / 6.7 / 10 |
| long-context en-flow，pplx 135000 | 63.3–66.7 / 13.3 / 20.0–23.3 / 9 | 83.3 / 10.0 / 6.7 / 10 | 90.0 / 10.0 / 0.0 / 10 |
| effort-midturn en-score（`sent`） | 72.0–74.0 / 15.0–17.5 / 10.5–11.0 | 75.0 / 17.0 / 8.0 | 77.5 / 18.0 / 4.5 |
| effort-midturn zh-score（`sent`） | 73.5–74.5 / 15.5–17.5 / 9.0–10.0 | 80.5 / 11.0 / 8.5 | 83.0 / 11.0 / 6.0 |

校准没有覆盖到的：

- 门槛是在挑选它们的同一批题上量的，eval v2 是第一次在没见过的题上量。
- **unresolved 和 long-context 的金标是起草者写的，用户没有审过**（见上面 #43、#44 两节）。校准的五组里有四组（unresolved 和三组 long-context）用的是这些金标，pplx 在这两套上的高分也靠它们。
- effort-submit 每种问法只有 8 题金标是 max（中英对话合起来 16 个回答），英文问法的上沿就是被其中 1 题卡住的。
- subagent 套件没有放进校准（pplx 在那里 effort 判高 35–39%，#43），thetaMax 也管派出 agent 的 effort。
- 中途重判是离线做的，`holdSteps` 不起作用。

##### 7. 局限和缺口

- **A⁺ 只有 63 题。** pplx 135000 的流程跑到 63/120 题时用户停下了（「A+可以停下了 就做这么多题 然后开始后面的测试」），没有补跑。misleading-history、new-topic、resolved、single-attempt 四类没有，looks-hard-is-easy 只有 01–03 三题。每个深度档 15–16 题（别组 30 题），一题是 6.3–6.7 个点。另有 6 题只跑了一部分（looks-hard-is-easy-04..09，分别停在第 29、24、21、18、9、1 条消息），没有 `final`，已丢弃；它们留在 `pplx-135000.json` 里，扫描时算作缺题。A⁺ 的 63 题恰好包含全部 28 道 max 题，又没有 resolved 类，所以它的整体数字不能和别组的 120 题直接比。
- **只有一遍，验收项未满足。** 见本节开头：#45 要两遍，带流程三组还缺英文问法。贴着线的几条比较只差一题（第 3 小节的余量），一遍的结果翻转的可能不小。Jev 同配置两遍之间，effort-submit zh-score 有 5.5% 的回答档位不同（en-score 2%）；pplx 隔天重跑也有 1.5–2% 的回答档位不同。
- **流程实际带进去的不多。** 带流程三组里，次数 > 0 的只有 A⁺ 16/63、B 39/120、J 36/120，带强提示的 A⁺ 13/63、B 31/120、J 24/120，其余请求和不带流程组只差摘要（第 2 小节）。带流程和不带流程的回答又不是同一时间跑的。
- **带流程三组不是独立的一次运行。** 它们的回答就是流程最后一步的回答，而流程文件里的概率存到小数点后三位，p(max) 落在 0.47 和 0.5 之间时，结果会因此略有差别。
- **流程文件按「后端 + 预算」各一份。** #45 写的是 A⁺ 和 B 共用 pplx 那份摘要；实际是 48000、135000 各一份，因为三选一（进而次数、摘要的清零）取决于预算。两份共用 Haiku 缓存，三选一一致的地方摘要相同。
- **Haiku 的实际模型。** 这次的摘要是 `claude-haiku-5-5` 写的（`claude -p --model haiku`，它自报和 `modelUsage` 都是这个）。#44 走同一条路，但没有记下模型，所以和 #44 的摘要可能不是同一个模型。mod 在引擎里用 `$.model.complete` 写摘要，以前实测回答它的是 `claude-haiku-4-5-20251001`（见下面「已实测的引擎行为」）；2.1.296 上再测（`unresolved` 开着跑一轮真实会话），摘要和 skill 画像的 `$.model.complete` 都由 `claude-haiku-5-5` 回答（`summary for turn …: written (223 tokens from haiku)`），所以现在和这次的摘要是同一个模型。
- **金标的来源和分歧率。** 90 题是出题者和标注者双盲一致的（只指 effort、`triage_final` 和决定性三选一；其中 30 题 accept 不同，后来取了并集，见最后一小节），30 题是用户裁决的。按 effort 或 `triage_final` 不同算，分歧集中在：hard-constraint 7/12（58%）、misleading-history 4/12、cheap-agreement 3/12、command-turn 3/12、resolved 3/12、single-attempt 2/12、looks-hard-is-easy 1/12；另有 7 题（cheap-agreement 5、misleading-history 2）effort 和 `triage_final` 一致，只有 accept、`effort_without_decisive` 或决定性几轮的三选一不同，也交给用户裁决，所以裁决数是 cheap-agreement 8/12、misleading-history 6/12、hard-constraint 7/12。explicit-unresolved、implicit-unresolved、new-topic 全部一致。#45 规定「某一类分歧 > 40% 时改写该类出题说明并重写该类」。hard-constraint 第一轮是 5/12，按这条改写了出题说明、重写并重新标注过一轮（修订说明在仓库外的交接目录 `guides/revised/hard-constraint.md`；同时重写的还有 looks-hard-is-easy、new-topic、single-attempt）。重写后仍是 7/12，**超过 40%**。交接说明规定只重写一轮，之后没有再写；这 7 题由用户逐题裁决了，但没有找到用户是否放弃这条要求的记录。
- **合成的素材池。** 中间轮次来自 agent 写的 905 段素材，每段跨题最多用 6 次，同一领域的 same-problem 段共用一套虚构背景。long-context（#44）那节提醒过「用真实的长对话重做才能确定结论不依赖这种填充」；eval v2 的素材比模板真实得多，但仍是合成的、反复复用的，结论能不能迁移到真实会话没有验证。
- **max 召回只在三类上量。** 28 道 max 题全在 explicit-unresolved、implicit-unresolved、command-turn 里，第 2、3 小节所有 max 召回的数字都只反映这三类。
- **领域和关系的混淆。** 前 54 题、后 66 题里，关系都和领域绑在一起，方向相反，类别也大部分不同（见第 4 小节）。所以「按关系」的差别不能只归到关系上。
- **resolved-01 略短。** 整段对话 78,330 token，比设计的总长下限 82,000 短；它是唯一一题（次短的是 command-turn-09，83,182）。它是 d1、same-problem，决定性几轮在 5,313 token 处，不影响深度档。
- **缺的或出过问题的运行。** 带流程三组没有英文问法，A⁺ 缺 57 题。Jev 流程第一次运行时 TypeSafe 额度用完，44 题收到 HTTP 402，运行器把它们记成了没回答（运行器在 `a7f88b9` 改成遇到 402 就停下）。充值后这 44 题整题删掉、从头重跑，文件里没有 402 的痕迹。补跑时 single-attempt-12 在 m41 遇到一次 529 和一次 10 秒超时，加 `--timeout 60000` 续跑后完成。除此之外，各组和两份回归都没有失败的请求，流程里也没有一条消息摘要写失败（Haiku 偶尔回的不是摘要：Jev 12 次、pplx 48000 9 次、pplx 135000 3 次，都在 3 次重问以内补上了）。
- **从仓库复现不了这些表。** 重放带流程三组（`flow-groups.ts`）、离线重算出 `compare.json`（`compare.ts`）、回归表（`regress.ts`）、门槛校准（`calibration-scripts/` 下的 `scan.ts`、`rule.ts`、`mid.ts` 等）的脚本和校准的中间输出都在仓库外的交接目录（`claude-mods-evalv2-handoff/phase2/`），没有提交。仓库里只有它们的输出：结果文件、`compare.json` 和两份门槛扫描（扫描本身用的是仓库里的 `eval-v2-thresholds.ts`）。

**accept 取并集后（2026-10-08 补充）**

第二次核对发现，90 题「双方一致」只比了 effort 和 `triage_final`，其中 30 题的 accept 不同、默认用了出题者的，而贴线的几条比较对它敏感。用户把这件事交给协调者裁决：这 30 题的 accept 取两者的并集（两人独立判断、核心档位一致；一人认为可以接受的相邻档位本身有争议，判到那一档不该算错），提交 `aa6d6e2`。下面的数字都按并集后的金标、thetaMax 0.5、各组存下的回答重算（effort-submit 不受影响）。

| 组 | 120 题：可接受准确率 / 判高 / 判低 / max 召回 | 同一批 63 题：可接受准确率 / 判高 / 判低 |
|---|---|---|
| A 中文 | 77.5 / 4.2 / 18.3 / 7/28 | 66.7 / 1.6 / 31.7 |
| A 英文 | 79.2 / 6.7 / 14.2 / 12/28 | 77.8 / 1.6 / 20.6 |
| A⁺ 中文 | — | 68.3 / 3.2 / 28.6（max 5/28） |
| B 中文 | 70.8 / 10.8 / 18.3 / 6/28 | 63.5 / 7.9 / 28.6 |
| B′ 中文 | 72.5 / 7.5 / 20.0 / 3/28 | 61.9 / 4.8 / 33.3 |
| B′ 英文 | 79.2 / 8.3 / 12.5 / 10/28 | 74.6 / 6.3 / 19.0 |
| J 中文 | 65.0 / 13.3 / 21.7 / 3/28 | 58.7 / 11.1 / 30.2 |
| J′ 中文 | 67.5 / 10.0 / 22.5 / 0/28 | 55.6 / 9.5 / 34.9 |
| J′ 英文 | 62.5 / 12.5 / 25.0 / 5/28 | 54.0 / 14.3 / 31.7 |

#45 的标准在并集后（中文问法，和前面同样的读法）：

| 比较 | 并集前 | 并集后 |
|---|---|---|
| A 对 J，准确率 ≥ +5（120 题 / 63 题） | +6.7 满足 / +4.8 不满足 | +12.5 满足 / +8.0 满足 |
| A⁺ 对 J，准确率 ≥ +5（63 题） | +6.3 满足 | +9.6 满足 |
| B 对 J，准确率 ≥ +5（120 题 / 63 题） | +0.8 不满足 / +3.2 不满足 | +5.8 满足（余 0）/ +4.8 不满足（差 1） |
| A、A⁺、B 对 J：判高 ≤ +3、max 召回 ≥ J | 都满足 | 都满足（判高 4.2、3.2、10.8 对 J 13.3、11.1） |
| A⁺ 对 A（63 题）：max 多 ≥ 3 题、判高 ≤ +3 | max 不满足（5 对 7），判高 +1.6 | 不变：max 不满足，判高 +1.6 |
| B 对 B′：max 多 ≥ 3 题、判高 ≤ +3 | max 满足，判高 +3.3 不满足 | max 满足，判高 +3.3 不满足（差 1） |
| J 对 J′：max 多 ≥ 3 题、判高 ≤ +3 | 都满足（判高 +0.8） | max 满足，**判高 +3.3 不满足**（差 1） |
| A 对 B（d3 / d4）：A 高 ≥ 10 点 | +16.7 是 / +3.3 否 | +20.0 是 / +6.7 否（d1 −6.7、d2 +6.7 参考） |
| effort-submit 判高 ≤ Jev+3（中文 / 英文） | 不满足 / 满足 | 不变 |

**四种取法的敏感性**：accept 分别按出题者、标注者、并集、交集取，各组可接受准确率的绝对值相差可到 10 多个点，但先后顺序不变：120 题上 A 英文和 B′ 英文始终在最前，A 中文其次，J、J′ 始终在最后；63 题上 A⁺ 和 A 只差 0–1 题。

**方案排名**（用户要求协调者给出；综合 eval v2 准确率、max 召回、effort-submit 日常消息的判高、延迟和复杂度）：

1. **B′ 英文问法**（pplx，48000，不带流程）：准确率与 A 英文并列最高（79.2），max 召回 10/28，单次约 5 秒，不需要摘要流程。风险：effort-submit 英文问法判高 18.5%，线上 Jev 中文问法是 7.0%（按 #45 和 Jev 英文 17.5% 比是满足的）。
2. **A 英文问法**（pplx，135000，不带流程）：准确率最高、max 召回最高（12/28）、判高最低，但单次 15–75 秒。
3. **J**（Jev + 摘要，#36 的做法）：eval v2 上最低之一，但最快，effort-submit 上最稳（中文 88.5%、判高 7.0%）；摘要和强提示把 max 召回从 0 提到 3/28。
4. **B**（pplx 48000 + 摘要）：不如不带流程的 B′。
5. **A⁺**（pplx 135000 + 摘要）：和 A 几乎一样（63 题上多 1 题），更慢、更复杂，只有 63 题。
6. **J′**（Jev，不带摘要）：max 召回 0/28。

在四种取法下都成立的三点：pplx 用英文问法明显更好（准确率高 3–7 点、max 召回高得多），和 Jev 相反；摘要和强提示对 pplx 基本没有提升（B 对 B′、A⁺ 对 A），对 Jev 只把 max 召回从 0 提到 3/28；决定性信息在 135000 之外的 d4，所有组都在 50% 上下，摘要没有补上。

用户随后决定把 mod 换成 B′ 方案（另开票）。

#### 看图核对（visual-check，#65，spec #55 的接缝 2）

Jev 出新版本时重跑一次，就知道看图核对准不准、能不能换、门槛（静态截图 0.8 / 0.2，录屏 0.8 / 0.4，档位序列 0.9 / 0.2；2026-10-15 之前是 0.9 / 0.2）要不要调。`node dispatch-pilot/eval/run.ts visual-check`，`--backend pplx` 也能跑（没有框题和放大复核，视频取 8 帧）。**只用 2026-10-15 实验里已有的图，没有新的实测**（用户的决定）；基线之后只重画了动画的 60 帧（加终点框，见下面「动画题重做」）。

- **评测集**（`datasets/visual-check.jsonl`，24 题，格式见 `lib/visual-check-items.ts`；图和真值在 `datasets/visual-check/`）：界面 `ui` 9 题（一张参考图，9 张候选，其中 `c9` 与参考图完全相同）；3D 海面 `sea` 7 题（一张参考图，7 张候选，其中 `twin` 是同一片海的另一个时刻）；动画 `anim` 5 题（线性、缓出、弹簧、卡顿、终点大偏，各 12 帧，每帧画着绿色虚线的 TARGET 终点框，规范和检查项描述终点的样子、不给像素）；参考图复杂度 `complexity` 3 组（立方体 2 张、海面 3 张、城市 4 张）。每题有若干条检查项，`gold.holds` 说每条是否成立（部分一致、要求满足）；一题里每条都成立就是对照（tag `control`，格式要求二者一致）。`validate.ts` 核对格式，也核对图都在、是 PNG（测试读不了磁盘，所以这一步在 `node.ts` 的 `checkPictures`）。真值来自实验的 `ui/truth.json`、`anim/truth.json` 和 `sea/run.ts` 的 TRUTH 表；每个界面候选另有一条没改动的部分的检查项（应当成立），测放大复核有没有误伤。
- **请求就是线上的请求。** suite 不重写问法：`wholeImageRequest`、`locatePlan`/`withBoxes`、`readWholeImage`、`framesRequest`、`complexityRequest` 是 mod 的纯函数；读图、缩放、裁剪、复杂度读数直接用 `core/image-files.ts`、`core/zoom-review.ts`、`core/complexity.ts`，它们要的 `ImageFilesIo` 由 `eval/node.ts` 的 `nodeImageHost` 用 Node 的文件和 `child_process` 给（`SuiteHost.images`），所以裁图用的是同一份 sips 参数。流程照 `features/visual-check.ts` 的 `check`：请求一（全部检查项，Jev 再加框题）、放大复核（对裁图的 Noul）、判定。`tests/eval-visual-check-requests.test.ts` 在 world 里让 mod 的工具对同样的图（假磁盘）跑一遍，和 suite 的请求逐字比：Jev 的界面和海面（两个请求，含裁图的字节）、pplx、复杂度读数；录屏和 pplx 的动画只有图不同（mod 用 ffmpeg 抽 JPEG，评测集是现成的 PNG 帧），比的是别的部分。
- **变体**：`mod`（mod 对所选决策模型的问法：Jev 加框题和放大复核，pplx 只有请求一）和 `whole`（只有请求一，放大复核没有时的样子，两者之差就是放大复核的作用）。动画和复杂度题两个变体相同。语言只有 `zh`（问题是 mod 的英文，不分语言），`--languages` 默认 `zh`。
- **指标**（每个变体的 `summary.variants[].breakdown`，`run.ts` 末尾也打印）：`falsePass`（不成立的检查项被判过，**应为 0**，列出哪几题）；`controlFails`（对照里被判不过的检查项）、`falseFail`（成立的被判不过）；`caught`（不成立的被判不过的比例）；`unsure`（没把握的比例，总的、对不成立的、对成立的）；`byKind`；`elsewhere`（全屏「哪里不同」在对照上报了另一处，是误报）；`cost`（每张图的 token、延迟、花费，总的和按种类，另有每题的）；`complexity`（三组读数是否按立方体 < 海面 < 城市排：`inOrder`、`strictlyInOrder`，和不取整的期望 `expectedStrictlyInOrder`）；`thresholds`（每条检查项存着判定依据的原始概率，所以能按别的门槛重算 PASS 从 0.7–0.95、FAIL 到 0.1–0.4 的误判数，不再发请求；`SWEPT`；已存结果按现在的门槛重算见 `lib/visual-check-rescore.ts`、`rescore-visual-check.ts`，和下面的「门槛改成 0.8 之后重算」）。`grade` 的 `correct` 是没有一条判反（没把握不算反），`exact` 是每条都判对：全部「没把握」是 `correct` 而不是 `exact`，看 `exact` 和上面的数字，不要只看 `correct`。
- **花费控制。** `--estimate` 和 `--max-usd` 是 `run.ts` 本来就有的；带图的请求按像素估算（`lib/estimate.ts` 的 `estimateRequest`：Jev 每百万像素约 2,600 token、每张图只计一次，pplx 约 1,000、按题数重复；文字部分照旧乘系数），以前按 base64 的长度估算会大几十倍。放大复核的请求要先有框才能裁，估算时 `suite.estimate` 用「每道框题答图中央」的假回答把流程走完（真的调 sips 裁图），所以估算里有放大复核那一轮请求，大小是中央框裁出来的，不是真实的框。花费 = 回答里的 `usage.input_tokens` × 0.042 美元每百万。
- **失败怎么记。** 图读不到、请求失败、读数没有档位，这题是失败（`ok: false`，写明原因，不算判对也不算判错）；放大复核某一条失败时和 mod 一样退回整图的答案（只采信不过），其余记没把握，原因在这条的 `why`。
- **通用表里的延迟列不适用。** `run.ts` 打印的 `>1500ms`、`late` 是按发消息时 Jev 的 1500 ms 等待算的；看图核对是工具调用，每个请求的上限是 8 秒（`features/visual-check.ts` 的 `REQUEST_MS`），所以这几列只当参考，延迟看 `cost`（每张图的毫秒数、每题的中位数和最大值）。

**基线（2026-10-15，`results/visual-check/2026-10-15-jev-baseline.json`）。** 这是 #65 写定的一次基线（用户批准，不算新的实测；**下面基线和动画重做的数都是按 2026-10-15 之前的 0.9 / 0.2 判的**，现在的门槛重算后的数见「门槛改成 0.8 之后重算」）：真实的 Jev（答题的是 `jev-1.14.0`），24 题 × 2 个变体 = 64 个请求，343,915 input token，约 0.0144 美元（估算 0.0136）。只是 mod 现在的问法和门槛的快照，没有调过，题少（20 条不成立的检查项、35 条成立的），差一两条不算差别。

| 指标 | `mod`（Jev：框题加放大复核） | `whole`（只有请求一） |
|---|---|---|
| 不成立却判成过 | **1 / 20**（`ui-c4-weight`：字重，放大复核给了 0.91，刚过 0.9；实验里同一张图是 0.82–0.89） | 0 / 20（整图只能判不过，设计如此） |
| 对照被判不过（12 条检查项） | 0 | 0 |
| 成立却判成不过 | 0 / 35 | 1 / 35 |
| 抓到的差异（判不过） | 10 / 20（界面 3 / 8，海面 7 / 9，动画 0 / 3） | 12 / 20（界面 4 / 8，海面 8 / 9，动画 0 / 3） |
| 没把握 | 56.4%（对不成立的 45%，对成立的 63%） | 76.4%（对成立的 97%：整图本来就确认不了「一样」） |
| 每张图的 token / 延迟 / 花费 | 2,310 / 398 ms / 0.000097 美元；界面 6,122、海面 5,753、动画 559、复杂度 1,009 token | 1,095 / 169 ms / 0.000046 美元 |
| 一题的延迟 | 中位 1,618 ms，最大 4,192 ms（两个请求接着发） | 中位 712 ms，最大 1,267 ms |
| 三组参考图读出的档 | 立方体 0、海面 2、城市 4（期望 0.10 / 2.44 / 3.93），顺序对，严格递增 | 0 / 2 / 4（期望 0.08 / 2.42 / 3.94） |

- **放大复核让「一样」能判过**：对照 `ui-c9-same` 的三条检查项都判过（0.96–0.99，整图只能给没把握）；没改动的部分在被改过的候选上也都判过（界面 11 条成立的检查项，11 条判过）。另一处「哪里不同」在 2 题上报了，都不是对照。
- **放大复核有时把整图的不过改成了没把握**：它的回答取代整图的（`zoomReview`）。`ui-c7-truncate` 整图 0.05（不过）、裁图 0.24（没把握）；`sea-big` 的浪高整图 0.12、裁图 0.22。所以 `whole` 比 `mod` 多抓 2 条。整图或裁图任何一个判不过就取不过，在这批题上会多抓 2 条（12 / 20），也会多出 1 条成立的被判不过（`sea-flat` 的雾：整图 0.14，裁图 0.40）。**没有改**：这是 mod 的流程，不是 #65 的范围，留给门槛的讨论。
- **PASS 门槛 0.95 去掉那一条误判**，没把握从 56.4% 升到 61.8%（`thresholds`，其余门槛组合见结果文件）。字重（`c4`）和 4px 偏移（`c5`）仍是盲区，和实验一致。
- **动画一条也没判出来**（基线用的是旧帧：没有画终点，终点只在文字里用像素给出）：15 条检查项概率都在 0.39–0.85，全是没把握，包括该判过的（`linear`、`ease_out` 没毛病）和该判不过的（回弹 0.60、卡顿 0.52、终点大偏 0.39）。原因是模型既要猜终点在哪、又要猜卡片有没有到过，两个变量。下面「动画题重做」把终点画进帧里再跑。
- **复杂度的读数比实验的高一档**：实验里的题问法不同（立方体 0.14、海面 1.77、城市 3.14），mod 现在的 `complexityRequest` 把海面读成 2.44、城市读成 3.93（取整后城市是 4，gold 3，在接受的 2–4 之内）。顺序对，这是这项要的。

**动画题重做（2026-10-15，`results/visual-check/2026-10-15-jev-anim-target.json`）。** 用户指出基线里动画的设计有根本问题：终点只在文字里用像素给出（「右边缘在 x=350」），画面上没有终点，模型既要猜终点在哪，又要猜卡片有没有过终点，换成人来判也判不了，两个变量。改法：每帧画出明确的终点（和卡片一样大、一样圆角的绿色虚线框，画在卡片上面，框上写 TARGET），规范和检查项只说画面上看得见的东西，不给像素（原文见 `datasets/visual-check.jsonl` 的 `anim-*`，参数和生成方式见 `datasets/README.md` 的「动画帧的终点」）。卡片的位置、真值都没变。跑法：`--ids` 选 5 条动画题、`--variants mod`（动画两个变体相同）、`--repeat 3`（这次新加的，看稳不稳）、`--model jev-1.14.0`；估算 0.0037 美元，`--max-usd 0.05`，实际 15 个请求、100,236 input token、0.0042 美元。每格是 3 遍的概率（旧基线的数在括号里）；判定按 mod 的 0.9 / 0.2：**过**、**不过**、没把握（不标）。

| | ① 没越过 TARGET 框再退回来 | ② 一直动到 TARGET 框，没有停顿 | ③ 末帧正好落在 TARGET 框里 |
|---|---|---|---|
| `linear`（对照） | 0.83 / 0.84 / 0.84（0.85） | 0.93 / 0.91 / 0.90（0.82）**过** ×3 | 0.96 / 0.95 / 0.96（0.69）**过** ×3 |
| `ease_out`（对照） | 0.81 / 0.77 / 0.78（0.81） | 0.84 / 0.85 / 0.83（0.79） | 0.87 / 0.89 / 0.88（0.62） |
| `spring`（① 不成立） | 0.27 / 0.24 / 0.29（0.60） | 0.52 / 0.51 / 0.49（0.52） | 0.85 / 0.83 / 0.85（0.57） |
| `janky`（② 不成立） | 0.85 / 0.82 / 0.80（0.82） | 0.34 / 0.36 / 0.35（0.52） | 0.95 / 0.96 / 0.93（0.68）**过** ×3 |
| `wrong_end`（③ 不成立） | 0.82 / 0.82 / 0.83（0.65） | 0.65 / 0.61 / 0.63（0.63） | 0.21 / 0.15 / 0.20（0.39）没把握、**不过**、**不过** |

- **稳**：同一格 3 遍的概率最多差 0.06（`wrong_end` ③：0.15–0.21），多数不到 0.04。判定只在门槛上的格子变过：`linear` ② 0.90 刚好够过、`wrong_end` ③ 0.21 比 0.2 高一点。
- **分得开了，但门槛还是够不着。** 不成立的 3 条检查项（9 格）都是各自那一列里最低的：回弹 ① 0.24–0.29 对其余 0.77–0.85，卡顿 ② 0.34–0.36 对其余 0.49–0.93（回弹 ② 约 0.5、终点错 ② 约 0.6 本来成立，却比别的低：「有没有停」本身不容易判），终点错 ③ 0.15–0.21 对其余 0.83–0.96。但按 0.9 / 0.2，9 格里只有终点错 ③ 的 2 格判成不过，回弹和卡顿的 6 格都没把握，另有终点错 ③ 的 1 格（0.21）。**没有一格不成立却判过**（0 / 9）；成立的 36 格里 9 格判过（`linear` ②③、`janky` ③），没有一格判成不过。
- **对照也只判过一半**：`linear` 两条判过，`ease_out` 一条也没有（最高 0.89）。按存下的概率重算（不再发请求）：FAIL 到 0.3 抓到 6 / 9（回弹 ① 和终点错 ③ 各 3 遍），到 0.4 抓到 9 / 9（加上卡顿 ②），成立的没有一格低于 0.49，所以没有误判；PASS 0.85 判过 16 / 36、0.8 判过 28 / 36，不成立却判过一直是 0。样本只有 5 个动画、3 遍，这是事后看出来的，改门槛要另外定，这次没有动 mod 的 0.9 / 0.2（用户随后定了新门槛，见下一节）。
- 和旧帧相比：旧基线里 ③ 的概率是 0.57–0.69（没毛病的）对 0.39（终点错），现在是 0.83–0.96 对 0.15–0.21，**画出终点这一项改动最大**；回弹 ① 从 0.60 降到 0.27、卡顿 ② 从 0.52 降到 0.35。

**门槛改成 0.8 之后重算（2026-10-15）。** 用户看了基线和动画重做两次评测后定了新门槛：「过」从 0.9 降到 0.8（静态截图的整图、放大复核的裁图、录屏），「不过」静态截图仍是 0.2、录屏放宽到 0.4，档位序列判「没差别」仍要每个点名区域到 0.9（实现见「看图核对」一节的「判定」）。同时工具说明加了一句：检查项要对照画面上看得见的东西来写（另一个元素、画面边缘、标出的目标），不要写像素坐标——依据就是动画题重做：画面里有明确的终点标记之后，分数才拉得开。按两个结果文件里存着的概率重算（`node dispatch-pilot/eval/rescore-visual-check.ts --write …`，`lib/visual-check-rescore.ts`，`tests/eval-visual-check-rescore.test.ts` 用手算的例子测过），不发任何请求，结果存在 `results/visual-check/2026-10-15-bars-rescored.json`（原来的两个结果文件没有动；用旧门槛重判能逐条复原它们存着的判定，所以重算依据的是真的概率）。`动画（新帧）` 是 `anim-target` 那个文件（5 题 × 3 遍，每格算一次，45 条检查项）；基线的动画是旧帧（没有终点标记），单列：

| `mod` 变体，旧 → 新 | 不成立却判过 | 成立却判不过 | 抓到（不成立的判不过） | 成立的判过 | 没把握 |
|---|---|---|---|---|---|
| 界面（基线，19 条） | 1 / 8 → 1 / 8 | 0 / 11 → 0 / 11 | 3 / 8 → 3 / 8 | 11 / 11 → 11 / 11 | 21.1% → 21.1% |
| 海面（基线，21 条） | 0 / 9 → 0 / 9 | 0 / 12 → 0 / 12 | 7 / 9 → 7 / 9 | 2 / 12 → 2 / 12 | 57.1% → 57.1% |
| 动画（新帧，45 条） | 0 / 9 → 0 / 9 | 0 / 36 → 0 / 36 | 2 / 9 → **9 / 9** | 9 / 36 → **28 / 36** | 75.6% → **17.8%** |
| 动画（旧帧，基线 15 条） | 0 / 3 → 0 / 3 | 0 / 12 → 0 / 12 | 0 / 3 → 1 / 3 | 0 / 12 → 4 / 12 | 100% → 66.7% |
| 基线合计（55 条） | 1 / 20 → 1 / 20 | 0 / 35 → 0 / 35 | 10 / 20 → 11 / 20 | 13 / 35 → 17 / 35 | 56.4% → 47.3% |

- **界面和海面一格没变**：基线 `mod` 变体里界面、海面没有一条检查项的概率落在 0.8–0.9 之间（落在这个区间的 4 条都是旧帧的动画）；`whole` 变体里界面、海面有 4 条在区间里，但整图对着参考图只能判不过，所以也没变。界面唯一的不成立却判过还是字重 `ui-c4`（0.91，原来就过了 0.9）；字重和 4 px 偏移仍是盲区，降低「过」的门槛不会让它们更好，只会让更多概率在 0.8–0.9 的有毛病的检查项落进「过」，这批题里没有，别的题里不知道。
- **动画受益最大**，而且是新帧：不成立的 9 格全抓到（0.15–0.36，都不高于 0.4），成立的 36 格最低 0.49，所以放宽到 0.4 没有误判；成立的判过从 9 格到 28 格（0.8–0.9 之间的 19 格转成了过）。0.4 是事后在这 5 个合成动画上看出来的，样本很小，这是用户拍板的，不是这批数据推出来的结论。
- 重跑评测时 `breakdown` 里的数字（`falsePass`、`unsure` 等）已经是新门槛的判定（`eval/lib/visual-check.ts` 的 `decideAnim` 按录屏的门槛读，其余按静态截图的）；`thresholds` 扫描的格点变成 PASS 从 0.7、0.75、0.8、0.85、0.9、0.95，FAIL 到 0.1、0.2、0.3、0.4（所有种类用同一组门槛，要看录屏单独的看 `rescore-visual-check.ts`）。

**文件**：`results/eval-v2/2026-10-08-{pplx-A,pplx-A-plus,pplx-B,pplx-B-prime,jev-J,jev-J-prime}.json`（六组）、`compare.json`（两套门槛 x 两种题集的离线重算）、`thresholds-jev.json`、`thresholds-pplx.json`（三选一门槛扫描）；`results/eval-v2-flow/{jev-24000,pplx-48000,pplx-135000}.json`（真实流程）；`results/effort-submit/2026-10-08-{pplx,jev}-regress.json`（回归）。

### 已实测的引擎行为（2.1.289；看板部分 2.1.291；一轮中途改 effort 和模型 2.1.312）

详细记录见 `docs/research/mods-testing-seam.md` 的第 10 节。0.3.0 的看板取代了状态行：下面 0.2.x 时代的条目里写到的状态行（`dp effort ...`、`failed 2, blocked 1`）是当时的实测，保留原样；现在同样的信息在看板和依据面板上。

**2.1.312：一轮中途改 effort 不生效，改模型生效**（2026-10-28，0.9.0 的依据，ADR 0013）。三个临时探针 mod（不在仓库里），各用 `claude -p "<要连跑几次 Bash 的消息>" --model sonnet --plugin-dir <探针> --debug-file <日志>` 跑一轮（Sonnet 5.5，订阅登录，主 agent 4 步），看 debug log 里探针写的行，再读会话记录（`~/.claude/projects/<目录>/<会话 id>.jsonl`）里每条助手消息记的 `model` 和 `effort`：

- **effort。** 探针在主 agent 的第 0 步把 `effort` 改成 `low`，第 1–3 步改成 `max`（引擎每一步给的都是 `medium`）。2.1.312 上 4 条助手消息的 `effort` 都是 `low`：第 1–3 步只带着工具结果，改的 `max` 没有发出去。同一个探针在 2.1.310 上是 `low`、`max`、`max`、`max`。2.1.312 生成的类型声明（`turn.step` 的 `effort`）也写着 "On a model that takes effort per message a level stands from one message with input to the next"。
- **数字 effort 被拒。** 第 1–3 步改成数字 `95`：引擎跳过这个 hook，debug log 写 `turn.step hook skipped: threw effort-probe: next() passed an argument with an effort that is not one of low, medium, high, xhigh, max (a number is ...`，4 条消息仍都是 `low`。
- **hook 加的上下文不算输入。** 第 0 步写 `low`、第 1–3 步写 `max`，同时在每个 `tool.call` 的结果上加一段 `context`（`Note: reasoning level adjusted.`）：4 条消息仍都是 `low`。
- **模型从改的那一步起生效。** 从第 1 步起把主 agent 的 `model` 改成 `haiku`（别名）：会话记录里第 0 条是 `claude-sonnet-5-5`，之后几条都是 `claude-haiku-5-5`，`claude -p` 的结果里两个模型都有用量。
- 所以 0.9.0 删了一轮中途重判，失败时只给派出 agent 换模型（「失败时升模型」）。下面 2.1.289 上「一轮中途改 effort 不会返回 400」那一条仍然成立（不报错），只是 2.1.312 起改了也不发出。按类型声明，带输入的一步（一轮进行中你又输入的消息送进来的那一步）上改的 effort 会生效，main-effort 靠这一点接管这一轮；这一条没有实测。

看板（#29–#31，2.1.291；画面在 iTerm2 加 herdr 里看过）：

- `$.ui.toast` 同一个插件 2 秒内的第二个会被引擎丢掉（2.1.289 实测，debug log 写 `within 2000ms of the last; dropped`；官方排错页说 2.1.290 起不再丢），所以「决定汇报」自己合并：一次事件最多一个，离上一个不到 2 秒的不弹（现在留着这条，是为了不刷屏）。
- 在 `ui.render` hook 里用 `$.clock.after` 要下一帧可以用（转圈、用时、时间色带靠它），没有在跑的 agent 就不再要。
- 固定宽度的格子在行太宽时会被 Ink 缩窄，所以每个固定格子都要 `flexShrink={0}`，宽度从 `bodyColumns` 里预算。
- 全屏且终端够宽时，`$.ui.open` 的面板停靠在对话右边（窗口 194 列时面板约 76 列）；不够宽（97 列）时在 prompt 上方，占用 band 的行。Claude 跟着窗口缩放要 5 到 12 秒，中间会经过约 25 和 52 列。从 band 的数字键 `onPress` 里打开不带 `focus`，下一个数字键仍落在 band 上。
- 非终端端：Raster 被拒；Desktop 的页面拒收 2000 个节点以上的树，而 `$.ui.mount` 只按引擎的 20000 校验，所以测试自己数节点。没有在真实的 Desktop 上看过。
- Desktop 的按键（Desktop App 2.42304.0 带的 2.1.299，按 SDK 协议实测）：Desktop 发 `ui_press`，带 `plugin`、`handle`、`key`。handle 属于画出那棵树的那次 render，重画后就作废：用旧 handle 按，引擎回 `{ handled: false }`，Desktop 的 web 日志记一条 `ui_press not handled`，按键没有任何效果；新 handle 回 `{ handled: true, element }`。同一棵树没变时再 render 走缓存，handle 不变。0.8.0 在 turn 运行时每 200 ms 重画，「▾ 收起」在 Desktop 上几乎按不中。
- `$.ui.open` 的 `focus` 只能是 `true` 或不写，写 `false` 会被 host 拒绝（`ui.open: focus is true or left out`）。
- Desktop 的面板 ×：Desktop 发 `ui_close { id }`，引擎关掉面板，名单变空并发 `ui_panes`（2.1.299 实测）。用 `focus: true` 打开的面板，名单里一直带着 `focus_requested_id`，Desktop 前端看到它会把被隐藏的面板再显示出来；这是 × 关不掉的可疑原因，还没在真机上证实。
- Desktop 的命令列表（Desktop App 2.42304.0）：会话进程没起来时（新会话的第一条消息、会话被回收后），Desktop 另开一个临时 CLI 取命令列表，带 `settings: { disableAllHooks: true }`，hooks 模块不加载，`$.command.register` 的 `/dp` 不在列表里，输入 `/dp` 会出现「/dp isn’t a command here」。消息照常发出，命令照常执行；会话进程起来后列表里就有 `/dp`。上游 anthropics/claude-code#99691。插件的 `commands/dp.md` 会被命名为 `<插件名>:dp`，绕不开。

- 在同一个 dispatch 里，外层 hook 写入的 `$.state`，内层 hook 马上就能读到（kit 和真实引擎都实测过）。反过来不行（kit，#34）：嵌套事件（Agent 的 `tool.call` 里的 `agent.spawn`）的 hook 写入的 `$.state`，外层 hook 在 `next(e)` 返回后读不到，写入返回 `isSet: true`，读到的仍是旧值。
- Agent 工具（2.1.291，`docs/research/event-probe/` 测的）：`agent.spawn` 嵌在 `tool.call`（`tool: 'Agent'`）里面，两者的 `tool_use_id` 相同；前台 agent 的 `tool.call` 在它的 `turn.complete` 之后才返回，结果的 `text` 是它交回的报告。
- 外层 hook 的 `$` 被闭包带进内层 hook 后可以照常调用（kit 和真实引擎）。
- `prompt.submit` 的 text 与随后 `turn.start` 的 text 完全相同（命令轮除外，见下一条），`turn.start` 在 `prompt.submit` 的 `next(e)` 里面触发。2.1.299 之前只有主 agent 的轮才有 `turn.start`；2.1.299 起派出 agent、Workflow agent 和 teammate 的每次运行也有，带 `agentId`（changelog 和声明；派出 agent 的 2.1.300 实测过，text 是它的任务），所以 core 和 report 的 `turn.start` hook 都先放过带 `agentId` 的。
- 已结束的派出 agent 被 SendMessage 唤醒（2.1.300，`docs/research/event-probe/` 测的）：引擎触发 `agent.spawn`，带 `resume: { agentId }`，`prompt` 是发给它的消息，`model` 是它原来的别名，`tool_use_id` 是那次 SendMessage 调用的；`next` 返回原来的 agentId。这次运行有自己的 `turnId` 和 `turn.start`（带 `agentId`，text 是 "The coordinator sent a message while you were working: …"）。dispatched-agents 放过它，不发决策请求。
- 斜杠命令（2.1.291，`-p` 和交互式一致，用 `docs/research/event-probe/` 测的）：prompt 命令（skill、markdown 命令）依次触发 `command.run`（`command` 是引擎解析后的名字，插件命令带插件名，如 `my-plugin:cmd`；`args` 是输入的其余部分）、嵌在它里面的 `skill.prompt`（展开后的正文）、`prompt.submit`（text 是输入的原文 `/name args`）、`turn.start`（text 是 `<command-message>name</command-message>`、`<command-name>/name</command-name>`、`<command-args>args</command-args>` 拼成的命令消息）。本地命令（`/dp`、`/usage`、`/context`）只触发 `command.run`，不触发 `prompt.submit`，不开始一轮。以 `/` 开头但不是命令的文字（`/Users/...`、`/nosuchcmd`）当普通消息提交，没有 `command.run`。`$.command.list()` 的 `source` 只有 `builtin`、`user`、`plugin`、`mcp`，分不出 skill 和本地命令。
- 一轮进行中用户发的新消息：`prompt.submit` 带着这一轮的 `turnId`，消息在下一步作为 `queued_command` 附件送进同一轮，不会开始新的一轮。
- `$.session.messages()` 里，助手的输出每个 block 一行，工具结果是没有文字的 user 行，user 行只包含用户输入的文字。
- debug log 不会记录 `pluginConfigs` 里的 option 值（用假 key 验证过）。
- `agent.spawn` 的 `next(e)` 返回 `agentId` 之后才写进 `agents` 的计划，这个 agent 的第 0 步就已经按计划发出（#6，真实引擎：在 mod 外层和内层各挂一个探针，sonnet agent 第 0 步引擎给的是 `medium`，发出的是计划里的 `low`）。
- 一条消息里的几个 Agent 调用，`agent.spawn` 并发触发，各自的决策请求同时发出，先拿到回答的先启动（#6，真实引擎）。
- Workflow 的 `tool.call`（#8，真实引擎）：`e` 的键是 `script`、`tool`、`tool_use_id`；`next(e)` 返回 `{ ref, result: { status: 'async_launched', taskId, taskType, workflowName, runId, summary, transcriptDir, scriptPath }, text }`。`next({ ...e, script })` 改写的脚本就是工具运行的，也是 `scriptPath` 指向的持久化文件和 `workflows/wf_<runId>.json` 里记下的那一份。
- 返回 `{ ...result, context: [...] }` 时，引擎把 context 作为 `tool.call hook additional context: ...` 附在工具结果后面，主 agent 读得到（它引用过原文），用户看不到。
- 脚本有语法错误时，工具在启动任何东西之前同步检查（约 2 毫秒），`next` 返回 `{ ref, result: 'Error: Invalid workflow script: Script parse error: ...', text: '<tool_use_error>...', isError: true }`；在同一个 hook 里再调一次 `next(e)`，用原脚本可以正常启动。
- Workflow agent 的结束（#27，2.1.291，`claude -p --model haiku --allowedTools Workflow`，两个串行的 `agent()`，只挂探针 mod）：每个 agent 的 loop 在自己的 `turn.step`（`turnId` 是它自己的，不是主轮的）之后触发一次 `turn.complete`，带 `agentId`、`reason: 'answer'`、`durationMs`（3086、3299）；主 agent 的这一轮（`Workflow` 已经 `async_launched`）先于它们结束，agent 都结束之后引擎以 `origin.kind: 'task-notification'` 提交一条消息，开始新的一轮（`turn.start`）。所以 Workflow agent 的结束可以直接看 `turn.complete`，不必读 journal 的 `result` 行；一个 agent 可以比开始它的那一轮活得更久。
- 被停止的 Workflow agent（2.1.296，`claude -p --model haiku`，只挂探针 mod，主 agent 启动 Workflow 后约 8 秒用 TaskStop 停掉它，agent 正在跑 Bash）：agent 的 loop 当场触发 `turn.complete`，带 `agentId`、`reason: 'aborted'`、`isAborted: true`、`answer: ''`（`durationMs` 16224），看板节点因此变成 `failed`（被中断）；停止之后没有 task-notification，也不开新的一轮。
- 工具返回后约 16 毫秒，运行的第一个 agent 就在它的 `turn.step`（index 0）出现。journal 里每个 agent 一行 `{ type: 'started', key, agentId, label, phase }`，`key` 是 prompt 和选项的哈希，所以改写选项会让缓存的 key 变化。
- 真实 Jev 加真实引擎（主 agent 是 sonnet）：一个 3 个 `agent()` 的脚本只发出一个请求（2737 输入 token，310 毫秒），决定 haiku、sonnet low、opus xhigh；三个 agent 的第 0 步在引擎里分别是 haiku（没有 effort）、sonnet low、opus xhigh，`modelUsage` 里三个模型都有用量。状态行是 `dp effort low | workflow routed 3 agents`，主 agent 的最后一句话复述了决定。
- 本机已有的真实脚本经过真实 Jev（Node 里直接用 `parseWorkflow`、`workflowBatches`、`readOutcomes`）：4–7 个调用点的脚本各发一个请求（8–10 个问题，4.0–4.7k 输入 token，545–686 毫秒；每个调用的问题文字约 600 token，所以输入的大小随调用数增长，不受 `contextTokens` 限制，那只管 state），决定多是 sonnet low 或 medium，只有一个涉及付费和购物车的步骤是 xhigh。
- 退回模式（真实引擎）：主 agent 读到拒绝文字后照着改并重新提交，原话是「路由插件（Dispatch Pilot）拦下了这次提交，并给每个 agent 指定了 model 和 effort。我把这些选项写进对应的 agent() 调用，其余内容不变，重新提交」；第二次提交直接放行（没有第二次决策请求），agent 按写进去的模型和 effort 运行。
- 主 agent 自己写 Workflow 时常把 prompt 放进数组再 `map`，这样的调用点这里读不了（见上节）；要测改写，得让它把每个 `agent()` 单独写出来。
- Workflow 兜底（#9，`claude -p --allowedTools "Workflow"`，sonnet 作主 agent，jev-pilot 已关，`--strict-mcp-config`；探针 mod 在 scratchpad，已清理）。journal、meta.json 和 transcript 几条是 0.6.2 及以前的兜底用的，0.7.0 起兜底不再读运行目录（#7 仍读 agent 的 transcript）：
  - **`turn.step` 的 model 原样发给 API，不解析别名。** 在 workflow agent 的每一步写 `model: 'haiku'`：debug log 是 `dispatching to firstParty model=haiku`，API 回 404 `model: haiku`，引擎打印 `[claude-code:unrecognized_model]`，这个 agent 以 null 结束。写 `claude-haiku-4-5` 则每一步都正常，`usage.model` 是 `claude-haiku-4-5-20251001`，请求里的 `medium` effort 被引擎去掉。404 之后引擎重试那一步时 `e.model` 是 `claude-sonnet-5`（不是 `claude-sonnet-5-5`），所以比较模型要按家族。
  - **journal 的格式**：第一行 `{"type":"launched"}`；每个 agent 在第 0 步之前写一行 `{"type":"started","key":"v2:<hash>","agentId":"...","label":"..."}`，脚本调用过 `phase()` 时多一个 `"phase"`；agent 结束时写 `{"type":"result","key":...,"agentId":...,"result":...}`。
  - **不写 label 时**，journal 的 `label` 是 prompt：空白折叠成一个空格、截到 60 个字符（`'Short first line.\nReply with exactly ...'` 记成 `"Short first line. Reply with exactly the word named and noth"`），`agent-<agentId>.meta.json` 的 `description` 也是它；写了 label 时两处都是 label。meta.json 在第 0 步之前就在。
  - **agent 第 0 步开始时，它的 transcript（`agent-<agentId>.jsonl`）还不在磁盘上**（5 个 agent 都是），50–110 毫秒后出现，第 0 步被 hook 挡着时也会写入。第一行是 user 消息：`[Workflow harness — computed task] ... The computed task text follows:\n` 加上任务，任务每一行前面缩进两个空格（空行也是）。
  - **`name` 按脚本 `meta.name` 解析，不是文件名**：`.claude/workflows/probe-file.js`（`meta.name: 'probe-named'`）用 `name: 'probe-named'` 运行。`name` 提交时 `e` 的键是 `name`、`tool`、`tool_use_id`，结果的 `scriptPath` 是会话目录下的持久化副本（`workflows/scripts/<name>-<runId>.js`）；`scriptPath` 提交时结果的 `scriptPath` 就是那个文件，每次运行一个新的 `runId` 和 `transcriptDir`。
  - **2.1.294 起 Workflow agent 也触发 `agent.spawn`**（2.1.289 时没有；2.1.296 实测，`claude -p --model haiku`，scratchpad 里的探针 mod 记 spawn，已清理）：`e.workflow` 是 `{ runId, agentIndex }`（`agentIndex` 从 1 起），`description` 是 label，`subagentType` 是 `workflow-subagent`，`model` 是脚本给这个调用写的（没写是 `undefined`），`tool_use_id` 是开始这次运行的 Workflow 调用的；`next` 返回的 `model` 是它实际启动的（没写就是主 agent 的）。类型声明说 hook 只能拒绝，改内容会被忽略：0.4.0 的 dispatched-agents 没有跳过它们，在 spawn 时把模型改成决策模型选的（被忽略），并把 effort 写进 `agents` 计划表；workflow-labels 在第 0 步看到已有计划就不再决定，于是 agent 用 dispatched-agents 的 effort、主 agent 的模型跑完（同一个脚本：0.4.0 下 `review` 在 spawn 时被决定、实际跑 `claude-haiku-5-5`，跳过之后由 workflow-labels 在第 0 步决定、实际跑 `claude-opus-5-5`）。决定是 haiku 时 dispatched-agents 不写 effort、不写计划，workflow-labels 照常接手，所以只在 spawn 时决定了 sonnet 或 opus 时出错。0.4.1 起 dispatched-agents 跳过有 `workflow` 的 spawn（`tests/workflow-spawn.test.ts`）。
  - **2.1.300 起在 `agent.spawn` 上改 Workflow agent 的 `model` 生效**（changelog 2.1.300；2.1.302 实测，`claude -p --model sonnet`，scratchpad 里的探针 mod，已清理）：脚本写 `model: "sonnet"` 的调用，hook 交下 `{ ...e, model: 'haiku' }`，`next` 返回 `claude-haiku-5-5`，第 0 步的 `e.model` 也是它。派出的 `prompt` 是脚本算好的任务（模板已展开，没有外框），`description` 是 label（模板 label 已展开成 `second:x`；不写 label 时是 prompt 换行变空格、截到 60 个字符）。声明（2.1.300 生成的 d.ts）：`workflow` 的派出改 `prompt` 和 `model` 生效，`description`、`subagentType`、`background`、`cwd` 不生效；拒绝就是脚本里那个 `agent()` 抛的错；运行用固定占位符代替 prompt 的（Code Review 那种不把脚本放进 SDK 事件的运行）改 prompt 不生效。0.7.0 起兜底就在这里设模型，看板节点也在这里建。
  - **运行的第一个 agent 在 Workflow 的 `tool.call` 返回之前就派出，工具不等它**（2.1.302 实测：派出的 hook 先睡 3 秒，工具的 `next` 在派出开始 4 毫秒后照样返回，第 0 步在派出返回之后才发）。旧的记录：**运行的第一个 agent 可能比 Workflow 的 `tool.call` hook 先动**：探针的 hook 在 `next(e)` 返回后记下运行目录，第一个 agent 的第 0 步比它早 1 毫秒；装上本 mod 后，第一个 agent 在工具调用处理完之前约 10 毫秒启动，第 0 步等它处理完才发出。fan-out 的几个 agent 的第 0 步相隔 3 毫秒。
  - **常驻提示到达主 agent**：`tool.describe` 在 Workflow 的描述后面附的文字，主 agent 能原样引用出来。
  - **端到端**（不用 key：先加载的探针插件替 `$.http.fetch` 回答 `api.typesafe.ai` 的请求，`next` 不往下走；另一个后加载的探针记下每一步发出的样子）：`scriptPath` 提交的脚本里，带 label 的调用、不写 label 的调用都在运行开始时判断，各自的 agent 每一步按 `claude-haiku-4-5` 发出、由 `claude-haiku-4-5-20251001` 作答；prompt 是数据的调用，agent 启动时等 transcript（约 100 毫秒）再判断，每一步按 `claude-opus-5-5`、`high` 发出。状态行 `by label: routed 3 agents`，主 agent 读到了说明。直接交来的脚本（本功能注册在 `workflow-agents` 内层之后）：`workflow-agents` 把带 label 的调用写成 haiku，那个 agent 每一步是引擎按脚本解析的 `claude-haiku-4-5-20251001`；prompt 是数据的调用由本功能在 agent 启动时判断，按 `claude-opus-5-5`、`high` 发出；状态行 `workflow routed 1 agent (1 as written) | by label: routed 1 agent`。两段说明作为同一个 `hook_additional_context` 附件到达主 agent，本功能的在前。用假 key 时（请求得到 401）各 agent 按引擎原样运行，状态行写明 `jev: key refused (HTTP 401)`。
- 斜杠命令作为 `claude -p` 的整个 prompt 时在本地运行，不调用模型（`claude -p "/dp"`）。引擎会在命令回答的前面加上插件名（`dispatch-pilot: ...`），所以命令的文字自己不要再带前缀。`--input-format stream-json` 里连续发多条用户消息，其中的 `/dp ...` 照常当斜杠命令处理，`$.state` 在同一个进程里跨消息保留。
- `$.command.register` 在 `session.start` 的 `next(e)` 之后调用，命令当场被列出；`$.store` 在 `next(e)` 之前就能读，读到上次保存的内容，两次 `claude -p` 之间也保留（文件在配置目录的 `plugins/store/` 下，`--plugin-dir` 加载时叫 `dispatch-pilot_inline-<hash>.json`）。
- `session.measure` 在订阅会话里主 agent 的每一轮之后触发一次，读数有 `context`（`tokens`、`window`、`percent`）、`rateLimits`（`five_hour` 和 `seven_day`，各带 `percentUsed` 和 `resetsAt`）和 `cost.usd`；matcher `{ context: { window: /(?:)/ } }` 在真实引擎里命中。headless 下状态行以 `ui_status` 事件输出（也写进 debug log），`to: 'debug'` 的日志不会出现在输出流里。
- 带 `options` 的字符串选项，值不在列表里时，引擎读作默认值并给出警告：`option <名字> in settings is not one of <列表>; it reads as the default, <默认值>`（kit 实测）。
- skill（#10，`claude -p` 加 `--input-format stream-json` 实测，jev-pilot 已关）：
  - `prompt.attachment` 对主 agent 的 `skill_listing` 回答 `{ text: null }` 后，引擎记下 `prompt.attachment skill_listing: dispatch-pilot (user) left it out (18397 characters)`。问模型被告知了哪些 skill，它回答没有。对照组（不隐藏）里模型列出全部 skill。同一个问题的 input token 是 21,914 对 28,547。
  - 隐藏之后，Skill 工具仍按名字加载 skill（`Skill {"skill":"grilling"}` 返回 `Launching skill: grilling`；`anthropic-skills:google-workspace` 也一样）。
  - `/compact` 和 `/clear` 在 stream-json 的 `claude -p` 里都能用。`/compact` 之后引擎没有再发 `skill_listing`，hook 也没有再被调用，模型仍然回答没有 skill。`/clear` 之后引擎为新对话再发一次，hook 再拦一次，模型回答没有。`/clear` 触发 `session.end`（reason 是 `clear`），没有 `session.start`。
  - 引擎对一条附件的回答在整段对话里沿用。对话中途调用 `$.ui.invalidate('prompt.attachment')` 不会让它重问已经发过的 `skill_listing`：没有新的 dispatch，前缀全部命中缓存，模型仍然看不到列表。所以开关关掉后，列表靠下一条消息的附件补回去。补回后，模型数出 66 个 skill。
  - `$.session.usage({ breakdown: 'summary' })` 在 `session.start` 的 `next(e)` 之后就能给出 `skillFrontmatter`。读本机的 skill 目录包括 `$.command.list()`、这个清单、五个 settings 来源，以及不在清单里的四十多个命令的文件。连同 `/dp` 的注册，整个 `session.start` 在 60 ms 内完成。`$.fs.read` 读不到文件时会在 debug log 里留一行 ENOENT，`$.fs.exists` 不会，所以先问 `$.fs.exists`。
  - 带 skill 问题的请求（87 个选项，6.4–6.8k input token）在真实引擎里 611 ms（进程里的第一个请求）和 316 ms 返回。`-p` 进程启动时的第一个请求有一次用了 1.7 秒（进程启动时其他工作同时在跑），这时按超时放行。
- find_skill（#12，`claude -p` 加 `--plugin-dir`、`--strict-mcp-config`，jev-pilot 已关；引擎里用的是假 key，排序另用 Node 问真实的 Jev）：
  - 注册：debug log 先写 `$.tool.register (dispatch-pilot): mcp__dispatch-pilot__find_skill (1 tool(s) on server "dispatch-pilot"); connecting`，43 ms 后写 `visible`。`--plugin-dir` 加载时全名同样是 `mcp__dispatch-pilot__find_skill`，hook 的 matcher 命中：`tool.call mcp__dispatch-pilot__find_skill <id>: resolved by a hooks module (result)`。
  - 它是延迟加载的工具：模型先调用 `ToolSearch`（`select:mcp__dispatch-pilot__find_skill`）加载它，再调用。
  - 假 key 得到 Jev 的 401：工具立即回答 `find_skill could not rate the skills (jev: key refused (HTTP 401)). ...`，状态行是 `dp effort xhigh (not routed) | jev: key refused (HTTP 401) | find_skill failed (jev: key refused (HTTP 401))`。之后模型用 Skill 工具按名字加载 `pr`，得到 `Launching skill: pr`（列表这时是隐藏的）。
  - 用 Node 把 find_skill 的同一个请求发给真实的 Jev（jev-1.13.0，12 个本机 skill，约 1,070 input token，273–500 ms）：`write the description of a pull request` 和 `写 PR 的说明` 都是 `pr` 1.00；`fill in a form in a PDF file` 是 `anthropic-skills:pdf` 1.00；`rename a variable across the repo` 的 none 是 0.97，不返回 skill。
- 列表换成提示（#12 的后续补丁；`claude -p --output-format stream-json --verbose`，主 agent 是 Opus 5.5，`--plugin-dir`、`--strict-mcp-config`，jev-pilot 已关，真实的 TypeSafe key 只放在 `--settings` 的 `pluginConfigs` 里，`skillsMax` 0（不推荐任何 skill，列表照样隐藏），`skillsProfilesPerSession` 0）：
  - 回答换成提示后，引擎记下 `prompt.attachment skill_listing: dispatch-pilot (user) rewrote it (18397 -> 360 characters)`（清空时是 `left it out (18397 characters)`）。
  - 场景：一条需要 skill、发消息时却没有推荐它的消息：「下面这个改动要合进 main，帮我写一段 PR 描述，直接把正文给我，不用创建 PR。改动的要点都在这里，不用去看代码：……」（四条要点，和 skill 无关）。本机有 `pr` skill（`Use when writing a PR body.`）；这条消息第一段 `pr` 1.00，第二段 0.83–0.85，默认设置下会推荐，这里 `skillsMax` 0 所以没有推荐。
  - 没有提示（本补丁之前，列表整段清空）：3 次都在第一步直接写正文，没有调用 ToolSearch、`find_skill` 或 Skill。
  - 有提示：3 次同样直接写正文，没有调用 `find_skill`。
  - 对照（不配 key，mod 不动列表，`find_skill` 不注册，主 agent 读完整的列表）：1 次，第一步就是 `Skill {"skill":"pr"}`，按 `pr` 写正文。Skill 工具的描述要求先加载匹配的 skill，列表里有 `pr` 这一行就够了。
  - 另试过一句更主动的提示：第二句换成 find_skill 描述里的「何时用」（`When the work at hand might have a skill you have not been shown (a file format, a service or its tooling, or a way of working such as reviewing, planning, testing or releasing), call the find_skill tool ... before you start ...`，535 个字符）。3 次也都直接写正文，所以没有采用。
  - 消息开头加上「先查一下有没有适合写 PR 描述的 skill，有的话加载它、按它来写」时，有提示和没有提示各跑 1 次，路径完全相同：`ToolSearch`（`select:mcp__dispatch-pilot__find_skill`）→ `find_skill`（`write a pull request description`）→ `Skill {"skill":"pr"}`，引擎记 `SkillTool returning 3 newMessages for skill pr`，正文按 `pr` 的模板写。真实 Jev 的两段：第一段 `pr` 1.00（347–362 ms，6,973 input token），第二段 fits `pr` 0.91–0.93（313–332 ms，809 input token），状态行 `dp effort low | find_skill pr`。这补上了上面只用假 key 验证过的一段：真实 key 下 `find_skill` 返回的 skill 能直接用 Skill 工具加载。
  - 结论：提示让主 agent 知道 skill 被藏起来了，也写出了 `find_skill` 的全名和加载方法，但没有让主 agent 在推荐漏掉时主动去查；被要求查时，有没有提示它都能从延迟加载的工具名找到 `find_skill`。推荐漏掉的消息仍然拿不到 skill，见「待评测」。
- skill 画像和两段排序（#11，`claude -p --input-format stream-json --model haiku`，`--plugin-dir`、`--strict-mcp-config`，jev-pilot 已关，真实的 TypeSafe key 只放在 `--settings` 的 `pluginConfigs` 里，`skillsProfilesPerSession` 3）：
  - 会话开始：`skills: 66 the main agent can load, 21 only you can start (...)`，`skill profiles: 0 kept, 87 to write with haiku (at most 3 this session)`。画像在后台写，不挡消息：第一条消息（不需要 skill）的请求 535 ms 返回（6,386 input token），第一段没有 skill 到 0.1，不发第二个请求。
  - `$.model.complete` 在后台照常工作（调用它的 hook 早已返回）：引擎记 `$.model.complete (dispatch-pilot): claude-haiku-4-5-20251001 answered in 2189ms, 457 chars`。三份画像各 2.2、2.3、2.6 秒，输入 1.8–2.5k token、输出约 200 token；写完记 `84 left to write at a later session start`。store 里每份 446–521 字节，中英文都简洁、贴切（例如 `code-review` 的「何时不用」写的是「代码检查、单元测试或性能分析等工具化任务」）。
  - 新进程（同一个 store，`skillsProfilesPerSession` 0）：`skill profiles: 3 kept, 84 to write with haiku (at most 0 this session)`，没有再调用模型。消息「帮我审一下这个分支相对 main 的改动」：第一段 496 ms（6,713 input token，比不带画像多 3 份画像的约 330 token），第二段 `[skills.fits.0]` 264 ms（873 input token，带画像和 SKILL.md 开头），`suggested code-review ...: first code-review 1.00, none 0.00; fits code-review 0.96; suggested from 0.70`。主 agent 看到推荐后用 Skill 工具加载了 `code-review`（`SkillTool returning 3 newMessages for skill code-review`）。两段合计约 0.76 秒。
  - 消息里如果写着「这只是一次测试：只回复‘收到’」，第二段的相关度会降到 0.44（不推荐）：它判断的是这条消息真正要做的事。
  - debug log 会把日志里 `"tokens":<数字>` 这样的字段遮成 `[REDACTED]`（引擎自己的脱敏），探针要输出 JSON 时注意。`$.ui.log` 每行最多 4096 个字符，超过的整行丢弃。
- **一步里的工具调用在这一步的流还没结束时就开始执行**：`tool.call` 的开始和结束都早于这一步的 stop chunk，也早于 `turn.step` 的 `next(e)` 返回。所以在 `tool.call` 里读不到这一步完整的 `answer`，需要的话在 `turn.step` 里边转发边收集 text chunk（0.8.x 的 `midturn-effort` 就是这样做的）。下一步的 `turn.step` 开始时，上一步的工具结果都已经回来了。
- **在 `tool.call` 里发出、不等待的 `$.http.fetch`，hook 返回后照常完成**，在之后另一次 dispatch（下一步的 `turn.step`）里取用没有问题；它回调里的 `$.clock.now()` 也照常可用。实测：Sonnet 5.5，每步重判，Jev 回答用了 313–330 ms，都在下一步开始前到达。
- **Sonnet 5.5 上一轮中途改 effort 不会返回 400**（#5 的验证项；2.1.312 起改了也不发出，见上面「2.1.312」那一节）。用一个每步改 effort 的探针 mod 测了三种配置，每轮 4–5 步，都正常完成：思考开着（默认），low → high → medium → high；`"alwaysThinkingEnabled": false`，同样的序列；`MAX_THINKING_TOKENS=0`，high → xhigh → low → max。API 文档说的 400 是 `thinking: {type: "between_tools"}` 加上与当前不同的逐条消息 effort（`messages.N: output_config.effort ... differs from ... in effect`），以及 `between_tools` 配 `xhigh`/`max`；Claude Code 2.1.289 在上面几种配置下都没有触发它（没有抓原始请求体，只看结果）。改档也没有打断缓存：每一步都从缓存读到整个前缀（约 2.85 万 token，新写入 0），没有因为改档重新写缓存。所以 Sonnet 5.5 上不需要关掉中途重判。
- PreToolUse settings hook 拒绝一个调用时，`tool.call` 拿到的是 `{ isError: true, text: <拒绝理由> }`，和工具自己报错一样；包一层 `classic.PreToolUse`，按 `tool_use_id` 才能区分（kit 实测，真实引擎里这一层照常触发）。用户在权限对话框里拒绝、或权限规则拒绝时，错误文字是 Claude Code 固定的几句（`The user doesn't want to proceed with this tool use...`、`Permission to use ... has been denied`、`Permission for this tool use was denied...`），从 2.1.289 的二进制里查到；kit 里无法触发真实的权限对话框，只能按这些文字模拟。
- 强制升档（#7，0.8.x，`claude -p` 实测，jev-pilot 已关；0.9.0 改成只给派出 agent 换模型）：
  - **`turn.step` 的 `model` 不认别名**（2.1.289；2.1.312 上主 agent 写别名 `haiku` 生效了，见上面「2.1.312」那一节）。 把一个 haiku 步骤的 `model` 改成 `sonnet`：主 agent 报 `[claude-code:unrecognized_model] ... There's an issue with the selected model (sonnet)`，进程退出码 1；派出 agent 报 `Agent terminated early due to an API error: ... (error type model_not_found, HTTP 404 ...)`。改成 `claude-sonnet-5-5` 则正常：一个 haiku 派出 agent（`claude-haiku-4-5-20251001`，引擎给它的步骤没有 effort）从第 1 步起每一步都发 `claude-sonnet-5-5`，`turn.step` 结果的 `usage.model` 也是它，agent 正常交回结果。引擎每一步都还是把原来的 haiku 当作这一步的 `e.model`（改写不改变引擎下一步给的值），所以要在每一步都改。
  - **`agent.spawn` 的 `next(e)` 返回的 `model` 是解析后的完整 id**：`sonnet` 解析成 `claude-sonnet-5-5`，`haiku` 解析成 `claude-haiku-4-5-20251001`（2.1.289；2.1.296 起解析成 `claude-haiku-5-5`，见下一条）。
  - **haiku 现在是 Haiku 5.5，接受 effort**（2.1.296）：`haiku` 别名启动的 Workflow agent 的 `next` 返回 `claude-haiku-5-5`；`claude -p --model haiku` 时主 agent 第 0 步的 `turn.step` 是 `model=claude-haiku-5-5 effort=medium`；脚本里写 `model: 'haiku', effort: 'max'` 和 `'xhigh'` 的两个 Workflow agent，第 0 步分别以 `claude-haiku-5-5 max`、`xhigh` 发出，都正常回答，所以最高两档 haiku 也收。所以 0.4.1 把 `MODEL_IDS.haiku` 换成 `claude-haiku-5-5`，haiku 不再特殊处理 effort（派发、改写脚本、核心发出、强制升档先升档）。上面 2.1.289 的几条 haiku 不带 effort 的记录是 Haiku 4.5 的。
  - **`classic.PreToolUse` 在派出 agent 的调用上也触发**，事件里没有 `agentId`（字段是 `tool`、`tool_use_id` 和工具自己的参数），`tool_use_id` 和这个调用的 `tool.call` 一致。settings hook 退出码 2 拦下调用时，`classic.PreToolUse` 的结果是 `{ deny: "PreToolUse:Bash hook error: [...]: <hook 的 stderr>" }`，`tool.call` 的结果是 `{ isError: true, text: <同一段> }`。
  - **一个运行中的派出 agent 的记录可以在 `tool.call` 里读到**：`$.session.messages({ agentId })` 返回的第 0 行是 user 行，文字就是主 agent 写给它的任务；助手的输出每个 block 一行（有一行文字是空的，多半是思考块），一个调用的 `toolUses` 项在这个调用的 `tool.call` 刚结束时还没有 `text`，到下一次读时才带着 `text` 和 `isError`；工具结果是文字为空、带 `toolResults` 的 user 行。下一步的 `turn.step` 开始时，上一步所有调用的结果都已经在里面。
  - **端到端**（决策请求由一个排在 dispatch-pilot 之后、拦 `http.fetch` 的探针 mod 用固定回答作答，不联网）：主 agent 在 Opus 5.5 上，开始时决定 medium，连续两次 `cat` 不存在的文件（`Bash` 报错）后，第 2 步发出前发出 `[midturn.level, escalation.expected]` 的请求，state 里 `trouble` 是 `2 tool calls have failed while working on this request`，`recent_steps` 是真实记录里的两步（`Failed: Read first nonexistent file`），回答「不是预期内」（p 0.05），探针看到第 2 步的 `effort=high`，模型仍是 `claude-opus-5-5`；一个被决定用 haiku 的 agent 连续两次失败后，第 2 步前发出只带 `escalation.expected` 的请求，探针看到这一步和之后的步骤都是 `claude-sonnet-5-5`，第三条命令成功，agent 正常交回结果。
- 从 marketplace 安装（#18，2026-10-05，`CLAUDE_CONFIG_DIR` 指向一个空目录，不配密钥，没有跑 `configure`）：
  - `plugin marketplace add <本地目录>` 记的来源是 `directory`，`installLocation` 就是那个目录，不复制；`plugin install dispatch-pilot@alex-mods --scope user` 把 mod 目录**复制成快照**放进 `<配置目录>/plugins/cache/alex-mods/dispatch-pilot/<version>`（整个目录，包括 `eval/`、`tests/`，约 9 MB），`plugin list --json` 的 `installPath` 指向它，`readFromFolder` 另记着原目录；`installed_plugins.json` 记着装的那一刻的 git commit。会话加载的却不是这份快照：按 Claude Code 文档（plugins/loading 的「In-place and copied plugins」），从本地路径添加的 marketplace 里 `source` 是相对路径的 mod 从原目录原地加载，改了原目录在下次启动或 `/reload-plugins` 时生效，不看 `version`，也不用 `plugin update` 或重新安装；`readFromFolder` 和 2.1.289 二进制里 `/reload-plugins` 的 `re-read from its folder` 与此一致（没有在会话里实测是哪一份被加载）。从 GitHub 添加的 marketplace 才装缓存里的副本，副本只在算出的版本变了时更新，见上面的「发版」。
  - `plugin details dispatch-pilot@alex-mods` 显示 0 个 skill、agent、hook、MCP 服务器和 LSP 服务器，常驻开销约 0 token：mod 的处理函数不在它的统计里，mod 在运行时附加和替换的内容它也看不到。描述取的是 marketplace 条目的 `description`，不是 plugin.json 的。`install` 打印 `31 userConfig options not yet set — run /plugin configure dispatch-pilot@alex-mods in Claude Code, or pass --config KEY=VALUE`：31 个选项都算没设，包括有默认值的。
  - **`CLAUDE_CONFIG_DIR` 没有把这两条命令完全隔离在那个目录里。** `plugin marketplace list` 在它下面只列出内置的 `anthropic-plugin-directory`，`add`、`install`、`list`、`details` 的结果都写在它下面，真实的 `settings.json` 和 `installed_plugins.json` 没变；但真实的 `~/.claude/plugins/known_marketplaces.json` 里 `claude-plugins-official` 的 `lastUpdated` 在 `add` 的同一秒被改了，`plugin-directory-cache-v2.json` 的修改时间也是那一刻，`plugins/cache/` 目录的修改时间正好是 `install` 的那一秒（`marketplaces/` 里没有新目录，真实的 cache 和 marketplaces 里都没有 `alex-mods`）。原因没有查明：像是它们刷新官方 marketplace 时用了真实的目录，也可能是别的会话碰巧在同一秒刷新。之后在另一个空目录下跑的 `plugin test`、`plugin validate` 和 `plugin tag --dry-run` 没有再改动这些文件。要验证安装，别把 `CLAUDE_CONFIG_DIR` 当成完全隔离。
- 图像（#55，2026-10-15，Claude Code 2.1.300，用 event-probe 的做法另写了一个临时探针 mod（日志前缀 `event-probe-img`，注册了一个 `shape_probe` 工具，不在仓库里）测的；用 `claude -p` 加 stream-json 贴图、让 haiku 读图；调研见 `docs/research/decision-model-images.md`，数字另记在 spec #55 的「实测得到的形状」）。**用户决定不再做任何实测**，所以下面没写的（见最后一条）就是没测过：
  - **图块的形状。** `$.session.messages({ as: 'api' })` 和 `session.append` 里是 Messages API 的块：`{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }`。用户贴的图：`prompt.submit` 的 `e.attachments` 只有元数据（`{ type: 'image', mediaType, id: 'media_…' }`，没有字节；`$.prompt.media` 对 user scope 安装一律 `deny`，只放行 managed settings 安装的 mod；2.1.316 起任何 `prompt.submit` hook 都能读，2026-10-31 用探针实测 user scope 读到了字节，见 `docs/research/decision-model-images.md` 第 4 节开头的更正）；`session.append`（door 为 prompt）入会话时 `content` 里已经是 image 块；`turn.start` 和第一个 `turn.step` 起，同一条消息里图块后面跟一块文字 `[Image: source: <会话临时目录>/images/1.png …]`（实测读到 228 个字符，只用到路径前缀），路径下是原图的字节。Read 读图：`tool.call` 在 `next(e)` 之后的结果是 `{ type: 'image', file: { base64, type, originalSize, dimensions: { originalWidth, originalHeight, displayWidth, displayHeight } } }`（内置 Read 的结果类型在 `claude-code-tools/index.d.ts` 里，图像结果带 `file` 对象），`r.text` 是空字符串；下一步的 api 消息里，同一个 user 消息有 tool_result 的 image 块，加一块引擎的 system-reminder 文字，和 `[Image: original 2400x1600, displayed at 2000x1333. Multiply coordinates…]`。`session.append`（door 为 tool-result，`origin` 是 `{ kind: 'tool', tool: 'Read' }`）的 `content` 是带 image 块的 tool_result。
  - **引擎把图缩到长边 2000。** 2400×1600 的 PNG（磁盘上 64,943 字节）经 Read 或用户贴进来，进 `tool.call` 的结果和 api 消息时都是 2000×1333，重新编码过，base64 长 134,052（比原文件还大）；`dimensions` 里 `originalWidth/Height` 是磁盘上的 2400×1600，`displayWidth/Height` 是缩过的。所以 2000 对 Jev 的每边 1568 和 pplx 的 2,048 个图块都太大，mod 要自己再缩（`sips`）；要原图就读 `[Image: source: …]` 的路径，或 Read 的 `file_path`。`$.fs.read(path, { as: 'bytes' })` 能读项目目录外的 PNG（86,592 字符的 base64 解码回 2400×1600）。
  - **换掉 Read 的图片结果、又不留 `[Image: …]` 文字。** 在 `tool.call` 的 `next(e)` 之后返回 `{ ...r（去掉 text 和 ref）, result: { type: 'text', file: { filePath, content: '<说明>', numLines: 1, startLine: 1, totalLines: 1 } } }`：模型读到的是 `file.content` 的第 1 行，图和 `[Image: …]` 文字都不再出现（haiku 的回答是「Read 的返回结果里只有文字，没有图片」）。`session.append`（door 为 tool-result）也能把 tool_result 的 `content` 换成 `[{ type: 'text', text }]`，模型同样看不到图，但 tool_result 之外的 `[Image: …]` 文字还在（声明写明媒体块可能被丢弃或移动，不能改动或新增），所以截图接管不走这条路。
  - **注册工具的回答只认字符串、数组或 `undefined`。** `$.tool.register` 注册的工具，`tool.call` 返回的 `result` 在类型声明里是 `unknown`，没写能不能带图；实测只有字符串、数组、`undefined` 被接受，MCP 形式的 `{ content: [...] }` 被拒绝，里面的 image 块不管写成 `data` 加 `mimeType` 还是 `source` 都不行。数组里放 Messages API 的块（`{ type: 'text', text }`、`{ type: 'image', source: { type: 'base64', media_type, data } }`），`visual_check` 的回答就是这样的数组。
  - **hook 的 10 秒只算 mod 自己的代码。** 在 `tool.call` hook 里 `await $.clock.sleep(12000)`，hook 恰好 10 秒后被跳过，debug log 写 `tool.call hook skipped: ran past its 10s budget`；hook 里 `await` 的 `$.http.fetch` 和 `$.process.run` 不计时。`$.clock.sleep` 算，所以带图路由发消息时等读数加等 effort 请求，总共要留在 10 秒内（见「带图路由的第一半」）。**看图核对也一样**：后端的超时是用 `$.clock.sleep` 计的，请求在等回答时就在睡觉，所以一次调用里先后发的请求（整图、放大复核的框题和裁图、档位序列的各批）共用一个总预算，不是各自 8 秒（见 `core/call-budget.ts`）。
  - **pplx 每题最多 8 张图。** 第 9 张起返回 HTTP 400，`At most 8 images are allowed per question`；图放在 state 里，每道题都带着它们，所以 mod 按一个请求最多 8 张处理：拼请求时就报错，不发出去（`PPLX_MAX_IMAGES`，`RangeError`）。
  - **引擎把 MCP 工具的说明截到 4096 个字符**（2.1.300，2026-10-15 冒烟：`claude -p "/dp" --plugin-dir ./dispatch-pilot`，不开会话）。`visual_check` 的 Jev 版说明当时有 4445 个字符，debug log 写 `MCP server "dispatch-pilot": Tool "visual_check" description truncated from 4445 to 4096 chars`，引擎的警告还有一行 `dispatch-pilot: $.tool.register: the description of visual_check (4445 characters) reaches the model up to its first 4096`：模型看不到最后 349 个字符（「连续两次不过先自己看图」后半、整段 `look: true`、交付前亲自看一次和最终汇报）。所以两版说明都压到 4096 以内（现在 Jev 版 3938，pplx 版 2760），把每次调用都要读的指引放在前面（检查项怎么写、哪些不该交给它、「过」只代表没看出明显问题、连续两次不过先自己看、`look: true`、交付前亲自看一次和最终汇报），放大复核、档位序列、录屏的细节放在后面，万一以后再被截，只截掉细节。`tests/visual-check.test.ts` 钉住这个上限（两版各一个测试，`ENGINE_DESCRIPTION_LIMIT`）和这个顺序；以后给说明加字，先看它们。
  - **没实测的**：截图类 MCP 工具的结果在 `tool.call` 里的 image 块是 MCP 的 `{ data, mimeType }` 还是 Messages API 的 `{ source }`（两种写法都认），换完去掉 `text` 和 `ref` 后核心是否按 `result` 重新生成给模型看的内容；`session.append` 里的 `[Image: source: …]` 文字是否在所有情形下都有；Jev 对没被引用的资产回 400、没带 `TypeSafe-Danger-Zone-Images` 头回 400，用的是实验里的结果，没在 mod 里重测。
