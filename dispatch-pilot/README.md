# Dispatch Pilot

Dispatch Pilot 是 `alex-mods` marketplace 里的一个 Claude Code mod。它在 Claude 之外调用一个决策模型（默认是 TypeSafe 的 Jev；把 `decisionModel` 设成 `pplx` 才用 Perplexity 的 pplx，不按密钥自动换），替你决定 Claude Code 怎么干活：主 agent 每一轮用哪档 effort，派出的 agent 用哪个模型和哪档 effort，主 agent 该看哪几个 skill。它还能替 agent 看图：截图、录屏交给一个看图的模型核对，agent 不必自己看（0.5.0 起，见「看图核对」和「图像：发给谁，什么时候发」）。

主 agent 的模型从不改变，所以 prompt cache 不受影响。这只在 Claude Code 订阅下成立，见「要求」。

## 它做什么

决策模型只负责给出判断，不参与回答你。每个判断的结果写在看板上，依据记进决策日志，在依据面板里看（`/dp`），也可以用 `/dp log N` 在对话里列出。

- **主 agent 的 effort。** 你每发一条消息，Dispatch Pilot 把这条消息和最近几条消息发给决策模型，问它这项工作需要多少逐步推理（「这项工作」指主 agent 为这条消息做的全部事情，直到它下次停下来等你），得到 low、medium、high、xhigh、max 五档各自的概率；同一个请求里还有几道是非题（见下一条）。档位由代码按固定的规则定，决策模型只给判断（ADR 0014，按 TypeSafe 的官方指南）：先算回答所在的位置（各档序号乘它的概率再相加），四舍五入到最近的一档（正好一半往上取）；比这一档高两档以上的某一档还有 0.3 以上的概率（回答分在两头）时，再往上取一档。置信度只记录，不参与定档。这是 Jev 和 pplx 的读法；选 d1-ultra 时按 Liquid 的：不看两头，置信度低于 0.5 时再往上取一档（见「d1-ultra」）。然后取它和几条下限里最高的一个，`/dp lock` 的锁定优先于这一切。这一轮的每个模型请求都按这一档发出，一轮进行中不再重新判断：2.1.312 起引擎按消息取 effort，一档从一条带输入的消息用到下一条，只带工具结果的那几步改了 effort 也不生效（ADR 0013）。一轮进行中你又输入的消息照常判断，它在哪一步送进这一轮，就从那一步起用它的档。派出 agent 交回结果、后台任务结束，会话空闲时它们会开始主 agent 的新一轮，这样的一轮也走同样的判断（会话自己的 xhigh 用在只是看一眼结果上是浪费）：决策模型读到的是那条报告的文字，只问 effort、三道出错代价和原因未知：不推荐 skill，不问还是不是没解决、有没有定规矩；报告送进一轮正在进行的对话时不另外判断。引擎把派出 agent 交回的结果和另一个 Claude 会话的消息都当作 `peer` 消息交来，mod 分不开它们，所以会话空闲时到达的另一个会话的消息，同样开始这样的一轮、同样只问这几道。定时任务、插件自己发的消息和空消息都不判断。你输入的 skill 或 markdown 命令（例如 `/implement #19`）开始的一轮也照常判断：决策模型读你输入的命令和参数，以及这个命令是做什么的，不读命令展开后的正文；参数里的点名照样算；这样的一轮不推荐 skill。`/dp`、`/clear` 这类本地命令不开始一轮，也就不判断。
- **派出 agent 的模型和 effort。** 主 agent 用 Agent 工具派出一个 agent 时（Workflow 里的 `agent()` 也一样），决策模型不直接选模型，只回答关于这个任务的十道是非题，模型由代码按一张表定（ADR 0015，按 TypeSafe「判断交给模型、决定写在代码里」的官方做法）。选 d1-ultra 时不用这张表，改按 Liquid 官方的路由示例问一道选择题，见「d1-ultra」；下面说的是 Jev 和 pplx。十道题：改不改东西（`writes`）、一两次工具调用能不能做完（`few_steps`）、结果是不是只按要求汇报（`report_only`）、三道出错代价（难以挽回、线上或真钱、权限和密钥）、原因未知、方案未定（要 agent 自己选做法）、结论靠仓库外查不到的事实、数值算法或科学计算；打开 `agentFable` 再加一道「是不是严格证明或没有现成答案的新算法、新架构」。是非题 ≥ 0.7 算是、≤ 0.3 算否，中间拿不准。表从上往下，第一条成立的定模型：① 你点名的模型；② 开了 `agentFable` 而且是前沿难题，fable；③ 出错代价、原因未知、方案未定、仓库外事实、科学计算任一为是，opus；③b 这七道没有为是、但有拿不准的，sonnet，effort 至少 max；④ 不改东西、一两步、只汇报，haiku；⑤ 其余 sonnet。你排除的模型（「别用 opus」）换成最近的可用模型，先往强的找，没有再往弱的找。主 agent 自己为这个 agent 指定了模型时只升不降：表给的更强才换成表给的，否则保留它的指定（你排除了它的指定时除外）。effort：你点名的照办，不受任何下限影响；否则先按 effort 题定基础档（和主 agent 一样），再按下限往上抬，只抬不压、取最高：出错代价（难以挽回为是而且线上或权限为是 max，任一为是至少 xhigh，任一拿不准至少 high）、原因未知（是至少 xhigh，拿不准至少 high）、表停在 ③b 时 max，最后是模型下限：sonnet 和 opus 至少 medium，haiku 和 fable 没有下限（haiku 用的是 Haiku 5.5，也带 effort）。你在消息里点名的模型或 effort（「用 opus」「effort 开 low」）照办：点没点名由决策模型判断，把握要达到 0.7，effort 的点名只在消息里出现 effort、档位名、推理这类字眼时才问；决策请求整体失败时读不出点名，见「局限和待评测」。每次 Agent 调用的结果后面还会附一段英文说明，告诉主 agent 这个 agent 以什么模型和 effort 启动、表停在哪一行、它的指定是保留还是升级、哪条下限抬了 effort（没路由时写原因）；fork、teammate 和被拒绝启动的派出不附。
- **Workflow 里的 agent。** 主 agent 提交 Workflow 脚本时，对脚本里每个 `agent()` 调用点做同样的判断，把模型和 effort 写进脚本再运行，并告诉主 agent 写了什么；`workflowMode` 选 `return` 时改为退回脚本，附上逐个调用的推荐，让主 agent 自己写进去。一个脚本最多问 24 个调用点、4 个请求；脚本里写的 `model` 只有是字面量时才当作主 agent 的指定。脚本写不进去的（用 `scriptPath` 或 `name` 提交、恢复的运行、读不了的脚本），以及超出 24 个、prompt 在运行时才拼出来看不出任务、选项不是对象字面量写不进去的调用，在每个 agent 派出时（`agent.spawn`）按它的 label 对上调用来设置，这叫兜底：模型设在派出上，effort 在它的每一步发出；对不上调用、或调用当时没能判断的，按派出带来的任务当场判断。
- **失败时升模型。** 派出的 agent（包括 Workflow 里的）工具调用失败累计到 `escalateAfter` 次时（中间成功一次不清零，升过一次、或到顶升不了之后重新数），从它的下一步起改用高一档的模型：haiku 升到 `escalateHaikuTo`（默认 sonnet），sonnet 升到 opus，打开 `agentFable` 时 opus 再升到 fable；一个 agent 最多升 `escalateLimit` 次。你为这个 agent 点名的模型不换，你排除的模型跳过。只换模型，不问决策模型，也不改 effort：一轮中途改 effort 不生效，改模型从下一步起就生效（2.1.312 实测，ADR 0013）。主 agent 的失败照样数，但什么都不升（它的模型从不改）：你本人的消息开始的那一轮结束时，把这一轮的情况记下来：这一轮用的 effort、工具调用次数、失败和被 hook 拦下的次数、失败是否到了 `escalateAfter`（卡住了），以及最后最多两行出错信息（先脱敏、截短）。这一轮有失败或被拦下的调用时，你的下一条消息的请求带上它（`last_turn`），决策模型判断原因是否未知时读它；下一条消息又被判为仍未解决、而这一轮卡住了，就至少比这一轮高一档（规则 R4）。`/clear` 和新会话时清掉。你自己拒绝的调用从不算失败。
- **是非题和下限。** 你本人的每条消息（包括斜杠命令），effort 题旁边还问十道是非题（Noul，答「是」的概率；Jev 和 pplx 0.7 以上算是、0.3 以下算否，d1-ultra 按 Liquid 的 0.8 以上、0.2 以下，中间算拿不准），每道的「是」和「否」都写成具体的情形，题面点名它读 state 里的哪些字段：这项工作出了错是否难以挽回（删数据、发出去的消息、发布）、是否作用在线上系统或真钱上、是否改权限、登录或密钥（三道「出错代价」），是否要先查出一个还没人说清楚的故障原因（「原因未知」），这条消息是否在说上次试的没用、是否说问题解决了、是否换了别的任务（三道关于问题的题，见下一条），是否给接下来的工作定了规矩（见「长期约束」），是否只是同意、让继续或从助手给出的选项里选一个（「确认」），是否要求多想、更仔细或用更强的模型（「要求升级」，ADR 0016）。这些回答只按写在代码里的规则起作用（ADR 0014），每条规则只抬高、从不压低：R1 消息里写了 `ultrathink`（单独一个词，不在引号、代码块或路径里）至少 xhigh，环境变量 `CLAUDE_CODE_DISABLE_ULTRATHINK` 设成 `1`、`true`、`yes` 或 `on` 时不算（Claude Code 2.1.316 起这样关掉这个关键词，引擎不再抬档，R1 也不抬；没设或设成 `false`、`0` 照常）；要求升级为是也至少 xhigh；确认为是至少等于你上一条消息那一轮的档位（这条消息要做的就是上一轮定下的事，消息本身再短也不判低）；R2 难以挽回为是、而且线上或权限也为是直接 max，任何一道出错代价为是至少 xhigh、拿不准至少 high；R3 原因未知为是至少 xhigh、拿不准至少 high；R4 这条消息说还是不行、而你上一条消息开始的那一轮卡住了（失败到了 `escalateAfter`），至少比那一轮高一档；R5 说还是不行、而未解决次数（算上这一条）到了 `unresolvedMaxAfter`，直接 max。没回答的题不起作用。依据卡片逐条写出这些规则走到了哪一档（ADR 0004）。
- **未解决次数。** 关于问题的三道题按这个规则动次数：这条消息说上次试的没用（仍未解决为是）加一；说问题解决了，或者换了别的任务而且没说还是不行（新任务为是、仍未解决为否）清零；其余不变。只是同意某个方案、让助手照做或继续，不算解决，不清零（「已解决」的「否」点名了这种情形，ADR 0016）。不靠关键词，「再看看」或贴一段同样的报错也认得出。次数一直在数，没有开关；存在会话里，`/clear` 和新会话清零，`/compact` 和热重载保留；agent 交回结果、后台任务通知开始的一轮不问。次数大于 0 时进发消息时的请求（`unresolved_count`），R5 读它；依据卡片显示次数和这一次三道题的回答。0.8.x 的三选一和「强提示」（另问一道带提示的 effort 题）都去掉了。
- **问题摘要**（`summary`，默认开）。你本人的消息开始的那一轮结束后，一个便宜的模型（`summaryModel`，默认 haiku，用你的 Claude 登录和用量）在后台用英文续写一份简短的摘要：问题是什么、试过哪些做法、现在到了哪一步，不超过 500 token，只记试过什么，不判断成没成功；你的下一条消息被判为仍未解决时，最后一次尝试标上未解决。决策模型发消息时读它（以有名字的字段发送：`problem`、`tried`（每一条带 `unresolved`）、`status`），借此看到超出上下文预算的更早几轮；它从不等摘要写完，来不及时用上一份。写失败（出错、超时）保留旧摘要并在决策日志里记一条。问题解决、换了任务、`/clear` 和新会话时和次数一起清空，`/compact` 和热重载保留。依据面板里能看摘要全文。交给写摘要模型的内容先脱敏；`contextMessages` 为 0 时不写（摘要是对话的转述）。`/dp summary off` 只停写、停发摘要，次数照数。0.8.x 里它和次数共用默认关的 `unresolved` 开关，那个开关去掉了，存下的设置不再起作用。
- **长期约束。** 你说「这是真钱」「生产库千万别动」这类要对之后一直有效的话时，定规矩那道题为是，Dispatch Pilot 把你的原话和你回的那条助手消息的最后一段（「这个也别动」要知道「这个」指什么）都原样记下（先脱敏、截短），之后你的每条消息的请求都带上（`standing_constraints`），出错代价的三道题读它们。最多记 5 条，旧的先丢，同一句不记两遍；没有时不发这个字段。报告开始的一轮不记也不带。`/clear` 和新会话时清空，`/compact` 和热重载保留。依据面板的决策日志里每记下一条写一条「记下长期约束」。
- **skill。** 主 agent 不再读完整的 skill 列表（装的 skill 多时这一段很长），读到的是一句固定的提示。改由决策模型在你发消息时，按 TypeSafe 的 skill 推荐 cookbook 先判断这条消息要不要 skill，再细看最相关的三个，最多挑出一个，连同名字和描述附在消息后面交给主 agent，没有合适的就附一句「没有相关的 skill」（ADR 0018）；只能由你触发的 skill 不推荐给主 agent，只在看板上提示你（「可试 /x」）。一轮进行中，主 agent 还可以用 `find_skill` 工具按几个词查 skill。skill 本身和 Skill 工具都不变，主 agent 仍然可以按名字加载任何 skill。
- **看图核对**（`visual-check`，默认开）。agent 截了图、录了屏，不必自己看：它调用 `visual_check` 工具，交上截图或录屏、比较的对象和几条检查项。比较的对象可以是参考图（设计稿、实物照片）、另一张截图（改动前后、另一个画质档位）、一串画质档位，或一段文字规范；每条检查项点名图上的一个部分，加一个看得见的属性。图像后端（见下面的「图像：发给谁，什么时候发」）一两秒内对每条回答过、不过或没把握。一次调用最多 24 条检查项；不过的检查项最多附 3 条的裁图；`look: true` 一次最多回 8 张图；画质档位最多 12 档。图的路径按模型给的原样用，只去掉首尾的空白（macOS 截图的文件名里有 U+202F，不能折叠空白）。有参考图或另一张截图时，先在两张图上框出点名的部分，裁下来放大再判断（放大复核，要 Jev），全屏另扫一遍「哪里不同」，没点名的地方变了也会报出来；录屏由 mod 用 `ffmpeg` 均匀抽帧，几帧一起判断，只问粗的运动问题（有没有回弹、终点是否大偏、元素出现或消失）。「不过」时附出问题那一块的裁图，「没把握」时把缩过的整图还给 agent 当场自己看，「过」只代表没看出明显问题。判定看决策模型说「成立」的概率：截图（整图、放大复核的裁图）至少 0.8 过、至多 0.2 不过，录屏至多 0.4 就不过，其间没把握（2026-10-15 之前是 0.9 / 0.2）；比画质档位时判「没差别」仍要每个点名区域到 0.9。检查项要对照画面上看得见的东西来写（另一个元素、画面边缘、画上标出的目标），不要写像素坐标，工具说明里也这么要求。它只判粗的差异：尺寸、圆角、色值、字重这类数值查代码或运行时的值，缓动、质感这类观感自己看，交付前主 agent 仍亲自看一次最终结果。同一条检查项连续两次不过，回答里提醒先自己看一次图。比一串画质档位时（`sequence`，要 Jev），逐对比较相邻两档在点名区域里有没有看得出的差别，找到再往上看不出差别的那一档，省得交给你逐档去看。派出 agent 和 Workflow 里的 agent 也能用。
- **截图接管**（`screenshot-takeover`，默认关）。打开后，agent 在当前这个循环里自己生成的图（截图、抽出的帧）在它看到之前被换成一句说明：图存在哪、有多大、请用看图核对；它要亲自看时，用 `visual_check` 的 `look: true` 取回缩过的原图。Read 读到的图片文件算；任何 `mcp__` 开头的工具（除了 Dispatch Pilot 自己的）返回的图块也算，不限于截图类工具，换掉的图块先存成临时文件。参考图、你贴的图和循环开始前就有的文件照常给 agent 看。适合调 3D 效果、反复建模这类粗调阶段：截图多，又不必每张都进上下文。它要 `visual-check` 开着、而且有图像后端，否则不生效（图换掉了 agent 就看不到了）。
- **带图路由**（`image-routing`，默认关）。你贴了参考图让 agent 建模时，Dispatch Pilot 先把参考图交给图像后端，读出「照着做出来有多复杂」，是 0 到 4 的一个读数；同一组图只读一次。读数以文字作为提示进入主 agent 的 effort、派出 agent 和 Workflow 里 agent 的模型和 effort，只是提示，不直接定档，锁定、点名和下限照旧优先。带图的消息因此晚一点才定 effort（多等的时间不超过约 3 秒，等不到就照常按文字定）；一轮进行中你又输入了带图的消息，这条消息只按文字定一次，不读它的图：图读完再定的那一次可能落在只带工具结果的一步上，那一步改 effort 不生效，看板上却会写着它（ADR 0013、0014）。主 agent 一轮做到一半才读的参考图不再触发判断（ADR 0013）。agent 自己截的图不算参考图。读数失败时决定照常进行，只是不带读数。
- **失败时放行。** 决策模型超时（`timeoutMs`）、出错、回答无法解析，或者没有配密钥时，消息照常进入，不额外等待，这一轮用会话自己的 effort，看板上写明原因，并弹一个 toast。

本文提到的配置项（例如 `escalateAfter`、`timeoutMs`），默认值都在「配置」的表里。每项功能都可以用 `/dp` 单独关掉，也可以整个 mod 一起关（见「控制：`/dp`」）。完整的行为规则（各种优先级、各种失败情形、看板和日志的写法）见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「它做什么」。

### 模型和 effort 的依据

模型的分工和各模型的 effort 下限，都按 Artificial Analysis（AA）Intelligence Index v4.3.2 的十个分项校正过（0.8.x 的往上取一档也是按它定的，0.9.0 起按 TypeSafe 的官方规则去掉了，ADR 0014）。几个要点：Sonnet 5.5 的分数随 effort 掉得很快（Terminal-Bench：low 20.7%、medium 29.8%、high 43.9%、max 63.6%；指数 36、41、47、56），所以低估 sonnet 的代价大；Opus 5.5 在 medium 就有 51；Sonnet 与 Opus 在终端、自动化、知识工作上持平或略高，拉开的是事实知识（Omniscience 32 对 46）、难推理（HLE 差 6.4）和科学代码（SciCode 差 5.9）；Haiku 4.5 在 Terminal-Bench 上是 0%。数字、来源和已存评测回答按新规则离线重算的结果见 [docs/research/aa-benchmarks-2026-10.md](../docs/research/aa-benchmarks-2026-10.md)。

### 看板

看板是 Dispatch Pilot 常驻的界面，只显示读数和结论，依据放在依据面板里。给人看的文字都是中文，模型名和 effort 档名照 `/model`、`/effort` 的写法。

- **prompt 上方的 band。** 一轮进行中，顶上一条状态条：第几轮、用时、agent 的运行 / 完成 / 失败 / 排队数、Workflow 的进度。下面每个 agent 一行：主 agent 在最前，其余按开始的先后，各带数字键（0 是主 agent，1 到 9 按先后）、名字、模型和 effort、状态，以及一条时间色带（同一根时间轴，看得出谁和谁并行）。状态格写运行或完成了多久、失败、排队，或者「未路由 · 原因」。再下面是这一轮的事件流：每个决定、派出 agent 失败后的升模型（写从哪个模型升到哪个、失败了几次）、skill 推荐和「可试 /x」、`find_skill` 的查询，以及请求失败、回答迟到。一轮结束后 band 折成一行：主 agent 的模型和 effort、这一档是怎么来的、「可试 /x」。引擎给 band 的行数不到 4 行时，退成一行摘要。
- **脚部右端的摘要。** 连同和左边隔开的一列，不超过 12 列：状态符号、主 agent 的模型和 effort、`+N` 个运行中的 agent；放不下时 effort 先写短（`xhi`），再省掉模型。
- **未路由。** 一轮或一个 agent 的模型和 effort 照引擎原样发出、没有经过 Dispatch Pilot 的决定，看板上总写原因：决策模型超时、连不上、繁忙、被限速、额度用完、密钥被拒绝、没配好、回答读不懂，或者功能已关。路由失败时还会弹一个 toast，写谁没路由和原因；离上一个 toast 不到 2 秒的不弹，免得几个 agent 一起失败时刷屏（失败照样写在看板上）。
- **看图核对的计数。** `visual-check` 开着时，band 里每个 agent 的行末多一格「核对 N：x 过 · y 不过 · z 没把握」（N 是检查项数，一轮里原地更新），截图接管开着时再加「接管 n」。每次核对和每次接管在决策日志里留一条：检查项、结论、概率、图片路径、是否放大复核、用时。核对出错不弹 toast，只在看板和日志里记。依据卡片多一行「看图核对」；带图路由读过参考图时，卡片多一行「参考图」，写读数的档位和来自几张图。
- **选中一个 agent。** 在空的 prompt 里按它的数字键，依据面板就打开在它的卡片上。
- **别的端（Desktop、VS Code、手机）。** 时间色带、概率条和置信条改用 Svg 画（这些端没有终端的 Raster），数字用等宽数字，列能对齐。这些端用鼠标点，不用按键（ADR 0012）：band 状态条右边有「依据」（打开依据面板）和「▾ 收起」（折成一行，行末是「▸ 展开」，本会话里一直保持）；agent 的名字可以点，不带数字键；effort 写成彩色的字。agent 在跑时每 5 秒才重画一次，运行中的色带自己往前长。依据面板顶上是一排 agent 标签、「看它的对话」和「关闭」；卡片里的规则是一张清单，effort 概率是一条堆叠条，份额写在下面；决策日志点轮次折叠，每条一行，指着它看概率和理由；最下面「功能开关」展开后，每个开关一个按钮，effort 锁定用下拉选择，按下就改，和 `/dp` 改的一样会保存。脚部是一个不超过 24 个字符的标签。
- **状态行（只在 VS Code 和手机上）。** VS Code 不画 band，所以用 prompt 下方的状态行写 band 的一行摘要：第几轮、主 agent 的模型·effort；一轮结束后加上这一档是怎么来的和「可试 /x」；还有各个 agent 的个数。你写消息时，prompt 提示也写在这一行（ADR 0011）。终端上不用状态行，因为终端会在这一行前面加一个关不掉的 ⚠（ADR 0004）；Desktop 上也不用，band 空闲时照样画着那一行，你写消息时 prompt 提示就写在 band 的那一行上（ADR 0012）。
- **Desktop 用的是它自带的 Claude Code**，要 2.1.300 及以上，否则整个 mod 加载不了，而且不报错（怎么看版本、密钥怎么填，见「安装」的「Claude Desktop」）。版本不够时，在菜单 Claude → Check for Updates 更新 Desktop，再开新会话。本机 Desktop 自带的 Claude Code 已是 2.1.309（2026-10-31 查看），main 上的版本直接在 Desktop 里用，不再另出兼容版；2.1.309 上跑过 `plugin validate` 和 stream-json 输入（0.9.1），界面还没在它上面亲眼看过（0.8.1 的改动在 2.1.299 的兼容版上真机点过）。
- 关掉的功能（`/dp <功能> off`）的决定、事件和计数不出现在 band 和脚部；`/dp off` 时 band 上没有 Dispatch Pilot 的内容，脚部写 `○ dp 已关`。`claude -p` 没有界面，内容写进 debug log。

### 依据面板

`/dp` 打开依据面板，再输一次或按 `Esc` 关掉；`/dp log` 也是打开它。全屏且终端够宽时它停靠在对话右边（约 75 列），否则在 prompt 上方。面板窄时文字换行缩进，不截断。

- **顶部**（灰字）：每项功能的开关状态（名字加「开」或「关」，关着的用灰色，默认关的 `hook-block-failures` 也在内）和 `/dp lock` 的锁定。
- **依据卡片。** 「‹ 上一个 (p) / 下一个 › (n)」按 band 的顺序翻看 agent。选中派出的 agent 时旁边多一个「看它的对话 (x)」，按下后主视图换成这个 agent 的对话，按钮变成「↩ 回主对话 (x)」；Workflow 里的 agent 没有这个按钮（2.1.302 实测引擎不让打开），主视图没切过去时弹一个 toast 写原因。需要 Claude Code 2.1.300 及以上。卡片是选中 agent 的依据：状态；没路由时几个字的原因，再写失败的类型、决策模型、细节和去 debug log 哪里看；给它的模型（派出 agent 和 Workflow 里的 agent）和理由（主 agent 也有）；各档 effort 的概率；规则推演，从决策模型给的概率走到最终的 effort，每一步写它做了什么（位置和四舍五入、双峰；主 agent 再写每条下限：ultrathink、出错代价、原因未知、上一轮卡住、未解决次数，锁定时写锁定；派出 agent 先写关于任务的每道是非题是、否还是拿不准，模型表停在哪一行，主 agent 的指定保留还是升级，再写出错代价、原因未知、③b 和模型下限）；结果。主 agent 的卡片还注明置信度只记录、不参与定档；派出 agent 的卡片列出它每次失败后升模型（失败了几次，从哪个模型升到哪个）。卡片只画决定时存下的推演，从不重新计算。
- **决策日志。** 按轮分组，最新的一轮在前，每条带编号、结果（颜色和 ✔ · ⚠ ✘ 符号；每轮的标题按同样的符号计数）、模型和 effort、是哪项功能针对什么、各档概率和理由。每轮有一个字母键（从 `a` 起，跳过 `p`、`n`、`f`）折叠或展开，最新两轮默认展开。日志保留最近 20 轮、最多 300 条。
- 面板的按键只在面板拿到键盘时有用（`/dp` 打开时会拿键盘；在 band 上按数字键打开的不抢键盘，可以接着按别的数字）。面板没被放出来时（比如接着的端不放面板）会立即关掉，并说明原因（`/dp` 在回复里说，按数字键打开的弹一个 toast），这时用 `/dp log 10` 在对话里看。

### 发给决策模型的内容

- 你这条消息，加上之前最近的几条消息（最多 `contextMessages` 条，总长度不超过 `contextTokens`）。主 agent 的 effort 题（连同它的是非题）单独发一个请求，能读到的最近对话比和 skill 推荐一起发时长得多（Jev 默认 24000 token，对 6000；pplx 48000）；skill 推荐的请求和它并行发出。选 Jev 时，默认值让每种请求都留在 Jev 的常规上限之内（state 加最长的那一题不超过 32k，整个请求不超过 64k），所以不带长上下文请求头（官方文档：长上下文更慢，也不那么准；ADR 0014）；只有几个 agent 合进一个请求、加起来超过常规上限时才带上 `TypeSafe-Danger-Zone-Long-Context`，这批请求最多等 3000 毫秒。每条只有文字和调用过的工具名，**不包含文件内容和工具输出**。
- 问题摘要（写好之后、`summary` 开着时，发消息时的 effort 请求里，以有名字的字段发送）：不超过 500 token，是 `summaryModel` 用英文对你和主 agent 这个问题的转述，输入给它的内容先脱敏；它占 state 的预算，最近的对话让给它。未解决次数（大于 0 时）、你的长期约束（有时）和你上一轮的失败情况（有失败或被拦下的调用时）也在这个请求的 state 里（`unresolved_count`、`standing_constraints`、`last_turn`）；没有内容的字段不发，题面也只在有这个字段时才点名它。
- 派出 agent 和 Workflow 里的 agent：主 agent 写给它的任务（`prompt`）、描述、agent 类型，加上你这一轮说的话；还有问题摘要（`summary` 开着时，`summaryModel` 写的，默认 Haiku 5.5）和次数（只当背景，不进规则）；还有它的背景（ADR 0007，选 Jev 时 2026-10-15 起也带，ADR 0009）：派出它的那段对话，到这次 Agent 或 Workflow 调用为止（同样只有文字和工具名，**不包含文件内容和工具输出**；子 agent 派出的 agent 读那个子 agent 自己的对话）；Workflow 里的 agent 还有整个脚本（脱敏）。先放任务和你的话，背景填剩下的预算（Jev 24000，pplx 派出 agent 32000、Workflow 一个请求 48000），脚本最多占三分之一，对话从新往旧放。
- **一起派出的 agent 合进一个请求**（ADR 0009）。同一条消息里的几个 Agent 调用，和 Workflow 里一起启动、要当场判断的那批 agent（fan-out），共用一个请求：你的话、摘要、对话和脚本只放一份，每个 agent 的任务各占一个字段、各问各的题。一个请求最多 4 个 agent（每个 agent 11 到 19 道题，一个请求最多 64 道，ADR 0015），多了分成几个合并请求。同一条消息里的 Agent 调用要都到齐才发，没到的最多多等 300 毫秒（fork、teammate 这类不经路由的调用永远不会到）；只派出一个 agent 时不等。同时在途的请求有上限：Jev 最多 4 个（1.14 实测同时答 4 个长请求和答 1 个一样快），pplx 最多 5 个，占满时新到的 agent 并进下一个请求；所有请求还都受账号的速率限额约束（`jevQps`、`jevTokensPerSecond`、`pplxQps`）。Workflow 的 agent 不是一次生成的（分阶段、按结果再派），后来启动的 agent 进下一个请求。每个 agent 最多等 6000 毫秒（Jev；pplx 8000），等不到就按主 agent 原来的要求启动，看板写明原因。
- Workflow 在后台运行、你又发了消息时，等到 agent 启动才判断的那些 agent（prompt 是数据的调用、读不了的脚本），读的仍是启动 Workflow 那一轮你的话、那时的问题摘要和到那次调用为止的对话，不是你后来的消息。
- 打开 skill 推荐时：本会话每个 skill 的名字和描述，以及排在前面的三个 skill（`find_skill` 是最多 `findSkillMax` 个）的描述和 SKILL.md 开头 700 个字符。
- 发送前对常见的 secret 格式脱敏，替换成 `[REDACTED]`：各家的 API key 和 token（含 Perplexity 的 `pplx-...`）、`password=...` 这类赋值（键名带引号的 JSON 写法 `"apiKey": "..."` 也算）、URL 里的密码、私钥和 JWT。
- 请求发往你用的决策模型：默认的 Jev 发往 TypeSafe（`api.typesafe.ai`），选 pplx 时发往 Perplexity（`api.perplexity.ai`），选 d1-ultra 时发往 Liquid（`api.liquid.ai`）。**带图的请求不是这样，见下一节。**
- 每次请求的结果和每个决定都写进 debug log（`claude --debug-file <路径>`），不进入会话。

### d1-ultra

`decisionModel` 设成 `d1-ultra`，文字的判断改由 Liquid 的 d1-ultra 做（ADR 0017）；看图核对、带图路由和截图接管仍用 Jev，要 TypeSafe 的 key。它用的是和 Jev 同一套 System One 接口和同一套英文题面，固定版本 `d1-ultra`（不用会自动更新的 `d1-ultra:latest`）。Liquid 的控制台写明它的所有模型零数据保留：不存储、不记录，也不拿发过去的内容训练。key 填在 `liquidApiKey`，或者放进环境变量 `LIQUID_API_KEY`。

它的回答按 Liquid 官方的读法读，和 Jev 分开（`decision/guides.ts`）：

- **是非题** 大于 0.8 算是、小于 0.2 算否，中间拿不准（Liquid 指南的二元判断示例：`p > 0.8` 拦截，`p < 0.2` 放行，其间交给人复核）。主 agent 的各题、派出 agent 的出错代价和原因未知、点名和排除模型、点名 effort 都按这两条线；R1–R5 和确认、要求升级的规则不变。
- **effort** 位置四舍五入不变；置信度低于 0.5 时再往上取一档，代替 Jev 的「分在两头」。这条是我们借 Liquid 路由示例的 0.5 补的，Liquid 没写打分题怎么处理。
- **派出 agent 的模型** 按 Liquid 的路由示例：一道选择题「Which model tier should handle the work in `brief.prompt`?」，选项 `fast`（收集、查找、按要求列出）→ haiku，`standard`（方法已知的常规软件工作）→ sonnet，`powerful`（出错代价高、原因未知、要选做法、靠仓库外的事实、数值或科学计算）→ opus，开了 `agentFable` 再加 `frontier` → fable。取概率最高的一档；置信度低于 0.5 时退到可用模型里最强的（opus，开了 `agentFable` 是 fable）。选中的被你排除时取可用的里概率最高的一档；你点名的模型优先，主 agent 的指定只升不降。出错代价和原因未知仍然问，只用来抬 effort；没有模型表的 ③b，也就没有它的 max。看板写「路由 powerful 62%」，拿不准时写「路由拿不准 → opus」。

它比 Jev 慢：满预算的请求 2.0–2.7 秒（Jev 约 0.9 秒），所以一条消息默认最多等 4000 毫秒。预算沿用 Jev 的（实测 Liquid 数的 token 约是 mod 估算的 1.09 倍，24000 的 state 加最长的一题约 2.72 万，在它每题 32,768 的上限之内）。没有 key 时不发请求，看板写明缺 `liquidApiKey` 或 `LIQUID_API_KEY`，不会换成别的模型。按用户的决定没有做评测，见「局限和待评测」。

### 图像：发给谁，什么时候发

**图没法脱敏，带图请求里的文字也不脱敏。** 只有不带图的决策请求，文字发出前才会替换常见的 secret 格式；看图核对的检查项、文字规范和图一样原样发出，截图里的密钥、聊天记录、个人信息也会原样发出去。装之前请先想清楚你的 agent 会截什么图。debug log 只记张数、尺寸、估算的 token 和耗时，从不写图的内容和密钥。

**发给谁。** 带图的请求用图像后端，和 `decisionModel` 无关：

- 有 TypeSafe 的 key：发往 TypeSafe（`api.typesafe.ai`），固定用 `jev-1.14.0`（框题只有 1.14 有，也免得 `jev-latest` 改指向时看图的行为悄悄变），请求头带 `TypeSafe-Danger-Zone-Images: true`。
- 没有 TypeSafe 的 key、但有 Perplexity 的 key：发往 Perplexity（`api.perplexity.ai`）。决策日志里记一条「看图改用 pplx」。
- 两个 key 都没有：三项图像功能都不可用，`visual_check` 不会出现在 agent 的工具列表里。

所以决策模型选了 pplx、又填了 TypeSafe 的 key 时，图发给 TypeSafe，不发给 Perplexity；不带图的决策仍照你选的决策模型走，带图路由读出的读数是文字，随后和别的文字一起发往你选的决策模型。

**哪些功能、什么时候发。**

- **看图核对：只在 agent 调用 `visual_check` 时发**（`look: true` 不发，只把缩过的图还给 agent）。发的是这次调用里 `images`、`reference`、`compare_to` 点名的图；录屏发抽出的帧（Jev 12 帧，pplx 8 帧）；有参考图时还有从图上裁下来的局部放大图。每次调用在对话里看得见。开关关着时调用不发请求。
- **截图接管：自己不发任何图。** 它把图拦在 agent 之外；图会不会发给图像后端，要看 agent 之后是否拿它调用看图核对。
- **带图路由：你发的消息带图时发**，一轮进行中你又输入了带图的消息时也发；一组最多 6 张，每张缩到约 100 万像素以内，同一组图只发一次。agent 自己截的图不发。
- 默认设置下，只有看图核对会发图（它默认开，但要 agent 去调用）。截图接管和带图路由默认关，装好后不会有图被自动发出去。

**磁盘上的临时文件。** 缩图、裁图、抽帧要写临时文件，放在 `$TMPDIR/dispatch-pilot/<会话 id>/`（截图接管存下的 MCP 截图也在这里），mod 不清理，由系统清 `$TMPDIR`。缩图用 macOS 自带的 `sips`，录屏抽帧用 `ffmpeg`（要自己装）。不在 CLI 里（`$.process.run` 不可用）或没有 `sips` 时，图已经合格（PNG 或 JPEG、尺寸在限制内、方向正）就原样发，否则相关的检查项记没把握并写明原因；没有 `ffmpeg` 时，录屏的检查项记没把握。

不想发图：`/dp visual-check off`（以及 `/dp image-routing off`、`/dp screenshot-takeover off`，后两个默认就是关）。

### 开销

- **决策请求。** 评测里 800 个 effort 请求共 614,292 input token（平均约 770 个），Jev 约 0.026 美元。d1-ultra 也只按输入计费，每百万 token 0.042 美元，一个请求的 state 只算一次（10 道题、约 1,600 字的 state 计 1,641 token）。评测的上下文很短；Jev 的 state 现在最多约 6.7k token，一个这样的 effort 请求不到 0.0003 美元（Jev 只按输入计费，每百万 token 0.042 美元），带 skill 推荐的约 2.9 万 token，约 0.0012 美元。pplx 同样只按输入计费，每百万 token 0.02 美元，同样大小的请求约是 Jev 的一半。
- **skill 推荐。** 打开后，每条消息的第一个请求还带着本会话每个 skill 的名字和描述（111 个 skill 时约 8.6k input token）和三道判断要不要 skill 的是非题；这三道题的平均过了门槛，才发第二个请求，带同样的 state 和三个候选的描述、SKILL.md 开头。作为交换，隐藏 skill 列表每个会话省下约 6.6k input token（本机 66 个 skill 时实测），换成的提示只有 360 个字符。
- **问题摘要**同样用你自己的 Claude 登录写（模型是 `summaryModel`），算在你的用量里：你本人的消息开始的每一轮结束后一次，输入是上一份摘要加这一轮（你的话、主 agent 的最终回复、工具汇总，各自截断），输出不超过 500 token。
- **图像**（只在你用到这些功能时才有开销）。看图核对：Jev 约每百万像素 2,600 token，每张图只算一次，每百万 token 0.042 美元；评测集基线里每张图平均约 2,300 token、不到 0.0001 美元，界面和海面的整套判断（整图加放大复核）一次约 6,000 token，延迟一题中位约 1.6 秒（两个请求接着发）。pplx 约每百万像素 1,000 token，要再乘题数，所以带图请求的题要少。带图路由的复杂度读数每张图约 1,000 token，另加最多约 3 秒的等待。截图接管不发请求，省的是 agent 上下文里的图。
- `claude plugin details dispatch-pilot@alex-mods`（2.1.289）显示 0 个组件、常驻开销约 0 token：它看不到 mod 在运行时附加和替换的内容。其中有两样常驻：`find_skill` 工具和（图像后端可用时）`visual_check` 工具的说明都在主 agent 的工具列表里，每个会话都占一点上下文（`visual_check` 的 Jev 版说明约 3,900 个字符），这里没有算进去。

## 要求

- **Claude Code 2.1.300 及以上**，mod 在 Claude Code 里默认启用。兜底在 `agent.spawn` 上设 Workflow agent 的模型，2.1.300 起才生效；更早的版本上这些 agent 只改得了 effort，模型按脚本或引擎的走。**0.9.2 测试用的是 Claude Code 2.1.316 和 Desktop 自带的 2.1.309**（适配 2.1.313–2.1.316：设了 `CLAUDE_CODE_DISABLE_ULTRATHINK` 时 R1 不再抬档，和引擎一样；没路由的 agent，给主 agent 的说明不再说它按会话的 effort 运行，因为设了 `CLAUDE_CODE_SUBAGENT_EFFORT` 时不是。用测试里扮演引擎的 world 验证，引擎读这个变量的办法从 2.1.316 的二进制里核对过；没有在真实会话里设过这个变量），**0.9.1 测试用的是 Claude Code 2.1.312 和 Desktop 自带的 2.1.309**（命令轮的参数末尾带空白时，判断落不到这一轮上、按会话的 effort 发出：引擎在命令轮开始时去掉参数的首尾空白，dp 却按原文比对；用 Desktop 的 2.1.309 以 stream-json 输入复现并验证了修复），**0.9.0 测试用的是 Claude Code 2.1.312**（按 TypeSafe 的官方指南重做发消息时的判断，ADR 0014：Jev 成为默认、不再按密钥自动换，所有问题用英文、请求留在 Jev 的常规上限内，effort 题旁边加八道是非题，档位按写在代码里的规则定，次数、长期约束和上一轮的情况进 state；用测试里扮演引擎的 world 验证过，真实的 Jev 只用 `claude -p` 跑过一次冒烟，没有重跑评测。之后又加了确认、要求升级两道题（ADR 0016）和可选的 d1-ultra（ADR 0017），同样只用 world 和冒烟验证：d1-ultra 3 次请求、Jev 1 次，见 DEVELOPMENT.md 的「d1-ultra 的预算」。skill 推荐照 TypeSafe 的 skill 推荐 cookbook 重写（ADR 0018），用 world 验证，再用 `claude -p` 核对主 agent 确实看不到 skill 列表（只加载工作区的 dp 时模型列出 0 个，关掉 dp 列出 126 个），这一次真实的 Jev 跑了两段 skill 请求；d1-ultra 只跑了一次第一段。还有删掉一轮中途重判；派出 agent 失败后改为升模型，主 agent 只记下这一轮的情况。依据是用临时探针在 2.1.312 的真实会话里实测的引擎行为：一轮中途改 effort 不生效，改模型从下一步起生效，见 DEVELOPMENT.md 的「已实测的引擎行为」和 ADR 0013；改动本身用测试里扮演引擎的 world 验证过，没有在真实会话里跑过一轮），**0.8.2 测试用的是 Claude Code 2.1.302**（选 Jev 时 skill 推荐的第二段至少等 800 毫秒：同一个 key 上几个会话同时发消息时，第一段变慢，共用的 1500 毫秒不够第二段用；用测试里扮演引擎的 world 验证，并用 5 个并行的无头会话在真实 Jev 上实测过；同样的改动在 0.8.2-desktop.1 里，用 Desktop 自带的 2.1.299 跑过同样的并行实测），**0.8.1 也是**（Desktop 等非终端端按「点」来画，ADR 0012：重画放慢到 5 秒、运行中的色带用 SMIL 自己长、band 的「依据」按钮、依据面板的 agent 标签和底部开关、Desktop 上不写状态行；同样的改动用兼容版 0.8.0-desktop.1 在 Desktop 自带的 2.1.299 上真机点过一遍），**0.8.0 测试用的是 Claude Code 2.1.302**（Desktop 等非终端端的 Svg 标记、等宽字、band 折叠和状态行只用测试里扮演引擎的 world 验证过，SVG 渲染出来看过；没在 Desktop 上亲眼看过，Desktop 自带的 2.1.299 加载不了 dp），0.7.1 也是（`TYPESAFE_API_KEY` 的环境变量兜底，用测试里扮演引擎的 world 验证过；为它而做的 Claude Desktop 没法试，Desktop 内置的 2.1.299 加载不了 0.7.0 起的 mod，见「安装」的「Claude Desktop」），0.7.0 也是（兜底改在 `agent.spawn` 上：派出时改模型对 Workflow agent 生效、派出带着 label 和任务、没写 label 的调用 label 是 prompt 前 60 个字符、运行的第一个 agent 在 Workflow 工具返回之前就派出而工具不等它，用临时探针在真实会话里实测过；新的兜底用测试里扮演引擎的 world 验证过，没有在真实会话里跑过一轮），0.6.2 用的是 Claude Code 2.1.301（强提示改成另问一道 effort 题、按同一请求的三选一取用、max 门槛用 `hintThetaMax`：用测试里扮演引擎的 world 和评测里的真实 Jev 验证过，没有在真实会话里跑过一轮），0.6.1 也是（全面代码审查的修复，用测试里扮演引擎的 world 验证过，没有在真实会话里跑过一轮），0.6.0 也是（Jev 1.14 的长上下文、一起派出的 agent 合进一个请求和 Jev 的限速，用测试里扮演引擎的 world 和评测里的真实 Jev 验证过，没有在真实会话里跑过一轮），0.5.0 用的是 Claude Code 2.1.300（图像功能用到的引擎行为用 event-probe 实测过：引擎里图块的形状、引擎把图缩到长边 2000、换掉 Read 的图片结果又不留 `[Image: …]` 文字的写法、注册工具的回答能用哪些形式、hook 的 10 秒只算 mod 自己的代码；整套图像功能没有在真实会话里跑通一轮，见「局限」），0.4.5 也是（`find_skill` 直接在主 agent 的工具列表里，用 event-probe 实测过；看板的模型名新字色在浅色终端上目测过），0.4.4 也是（派出 agent 自己那一轮的 `turn.start`、被 SendMessage 唤醒的 agent 的 `agent.spawn`，在真实会话里实测过），0.4.3 用的是 Claude Code 2.1.296（选 pplx 时派出 agent 和 Workflow 请求里的对话和脚本、agent 启动时才判断的读启动那一轮，在真实会话里实测过），0.4.2 也是（被 TaskStop 停掉的 Workflow agent 的结束实测过），0.4.1 也是（Workflow agent 的 `agent.spawn`、Haiku 5.5 的 effort 在真实会话里实测过），0.4.0 用的是 Claude Code 2.1.294（默认的 pplx 配置跑通一轮真实流程，见 #53），此前版本用的是 2.1.291（订阅登录，看板和依据面板在终端里看过）和 jev-1.13.0；缓存和评测的实测是在 2.1.289 上做的；跑 `eval/` 和 `scripts/` 里的 Node 脚本用的是 Node 26.5，用 mod 本身不需要 Node。
- **只支持 Claude Code 订阅**（ADR 0001，`docs/adr/0001-main-agent-effort-only-no-model-switch.md`）。Dispatch Pilot 每轮、每一步都改主 agent 的 effort，但从不改它的模型：换模型必然让 prompt cache 失效，而在订阅下，同一个模型内切换 effort 保留缓存（2.1.289 上 Opus 5.5 加订阅实测）。Bedrock、Vertex 和各种网关上切换 effort 会让缓存失效，不在支持范围内。Claude Code 的文档只点名了 Opus 5.5、Sonnet 5.5 和 Fable 5.1 保留缓存，其他大多数模型上每档 effort 各有一份缓存，切换会重算整段请求（见 `docs/research/decision-models-and-caching.md` 的 3.4）。
- **一个决策模型的账号。** 默认的决策模型是 Jev，要 TypeSafe 的 API key；把 `decisionModel` 设成 `pplx` 才用 pplx，要 Perplexity 的 API key（Decisions API）；设成 `d1-ultra` 才用 d1-ultra，要 Liquid 的 API key（图像功能仍要 TypeSafe 的）。不按密钥自动换（ADR 0014）：所选模型的 key 没有时 mod 不发任何请求，每一轮都按会话自己的 effort 走，看板上写明缺的是哪个 key。0.9.0 之前默认是 pplx，没有 Perplexity 的 key 时退回 Jev；只填了 Perplexity 的 key、没设 `decisionModel` 的，升级后要么补上 TypeSafe 的 key，要么把 `decisionModel` 设成 `pplx`。
- **要用全部图像功能，需要 TypeSafe 的 API key。** 放大复核、全屏「哪里不同」、档位序列、录屏取 12 帧都靠 Jev 1.14。只有 Perplexity 的 key 时（没有 TypeSafe 的 key），三项图像功能仍可用，但看图核对只做整图判断：不框、不裁、没有放大复核，有参考图时「过」只能记没把握；档位序列不可用；一个请求最多 8 张图，录屏取 8 帧。两个 key 都没有，图像功能都不可用。图发给谁见「图像：发给谁，什么时候发」。
- **缩图、裁图用 macOS 自带的 `sips`，录屏抽帧用 `ffmpeg`**（要自己装）。只有看图核对和带图路由需要它们，其余功能不需要。截图接管把 MCP 工具返回的图存成临时文件，用的是 macOS 的 `base64 -D`（Linux 的 base64 不认这个参数）；存不下来时图原样留给 agent。

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
```

想改 mod 或者试未发布的改动时，也可以从本地克隆添加：`claude plugin marketplace add ./claude-mods`（相对路径要以 `./` 或 `../` 开头，否则会被当成 GitHub 仓库）。从本地目录添加的 marketplace，Claude Code 直接从那个目录加载 mod，克隆里检出的是哪个版本，用的就是哪个版本。

在 shell 里装好的 mod，下次启动 Claude Code 时才加载：装好后重启 Claude Code，或者在已经开着的会话里运行 `/reload-plugins`。在会话里运行 `/plugin`，看到 `1 mod active · dispatch-pilot` 说明 mod 已经加载；运行 `/dp` 会打开依据面板，`/dp status` 列出各项功能的开关。接着给它一个决策模型的密钥。

**Jev（默认）。** 给它 TypeSafe 的 API key，有两种给法，同时给了就用第 1 种：

1. 在 Claude Code 的会话里运行 `/plugin configure dispatch-pilot@alex-mods`，在弹出的配置对话框里填 `typesafeApiKey`；输入会被遮住。在会话里用 `/plugin` 安装时也会弹出这个对话框；在 shell 里用 `claude plugin install` 安装不会弹，装好后用这条命令，或者用 stdin 传进去（需要 `jq`）：

   ```bash
   read -rs TYPESAFE_API_KEY && export TYPESAFE_API_KEY   # 粘贴密钥后回车，不回显，值也不会留在 shell 历史里
   jq -n '{typesafeApiKey: env.TYPESAFE_API_KEY}' | claude plugin configure dispatch-pilot@alex-mods --values-stdin
   ```

2. 设环境变量 `TYPESAFE_API_KEY`（启动 Claude Code 的环境里要有）。在 Claude Desktop 里只能用这一种，填在哪见下面的「Claude Desktop」。

**不要用 `claude plugin install --config typesafeApiKey=...` 传密钥，也不要用 `jq --arg`**：它们的值会出现在进程参数里，同一台机器上的 `ps` 看得到。

`--values-stdin` 读一个 JSON 对象，值都是单行字符串，没写到的选项保持原值。保存之后要重启 Claude Code 才生效，命令也会提示 `Configuration saved. Restart Claude Code to apply it.`。不带参数运行 `claude plugin configure dispatch-pilot@alex-mods` 会列出所有选项，并标出哪些还没有设置。

**pplx。** 想用 pplx，就把 `decisionModel` 设成 `pplx`（在 `/config` 里选，或写进 `pluginConfigs`），再给它 Perplexity 的 API key，给法同上，同时给了也用第 1 种：配置对话框里填 `perplexityApiKey`（或者 stdin 的 JSON 里写 `perplexityApiKey`），或者设环境变量 `PERPLEXITY_API_KEY`。设成 `pplx` 就始终用 pplx，哪怕也有 TypeSafe 的 key；pplx 0.9.0 起不再评测，它的回答按和 Jev 一样的规则读。全部图像功能要 TypeSafe 的 key（见「要求」），不管决策模型是哪个。Jev 的决策固定用 `jev-1.14.0`，不跟着 `jev-latest` 走：TypeSafe 换版本时 mod 的行为不会悄悄变。

两种 key 都只放在请求头里，不会出现在 debug log、看板、依据面板和 `$.state` 里；会话开始时 debug log 只写 key 从哪里来（`pplx key:`、`jev key:` 后面是 `from the options`、环境变量名或 `not set`），不写 key 本身。

**Claude Desktop（Code 标签）。** Desktop 的 Code 标签收不到 keychain 里的敏感 userConfig（#35，上游 anthropics/claude-code#89749）：在那里 mod 拿到的 `typesafeApiKey`、`perplexityApiKey` 总是空的，配置对话框里填过也一样。Desktop 也不读 `~/.zshrc` 里 export 的变量（从 Dock 或 Finder 打开时，它只从 shell 配置里取 `PATH` 和固定的几个 Claude Code 变量）。所以在 Desktop 里，密钥只能用环境变量 `PERPLEXITY_API_KEY` 和（或）`TYPESAFE_API_KEY` 给，可以放在两个地方：

- **已保存的环境（加密保存）。** 从 Desktop 2.31226.0（2026-10-08）起，环境变量挂在已保存的环境上，不再有对所有本地会话都生效的那一份。每个已保存的环境各有一份变量，开会话时选的是哪个环境，会话就带上哪个环境的变量；「This computer」从空白开始，不带任何变量。所以每个用来开会话的环境都要加上密钥，直接从「This computer」开的会话拿不到。改版前全机通用的变量，已经复制进了 Desktop 自动建的那些环境。Claude Code 文档的 Desktop 页还写着鼠标悬停在 Local 上、点齿轮打开本地环境编辑器，那是改版前的入口。
- **`~/.claude/settings.json` 的 `env`（明文）。** 写在这里，Desktop 的每个会话都拿得到，终端也一样，不用一个环境一个环境地加；代价是密钥明文存在这个文件里。同一个变量两处都设了，Desktop 的会话用已保存环境里的那个：Desktop 启动会话时，它给的环境优先于 settings 文件的 `env`。

Desktop 内置的 Claude Code 版本还要在 2.1.300 及以上（在 Desktop 的会话里运行 `/status`，看 Claude Code 那一行）。0.7.0 起 mod 用到 `prompt.change` 事件，2.1.299 不认它，整个模块加载失败，而且界面上什么也不报：没有看板，`/dp` 也没有，只有 `--debug-file` 的日志里有一行 `hooks module dispatch-pilot@alex-mods failed to load`。0.7.1 的环境变量兜底（`TYPESAFE_API_KEY`）只用测试里扮演引擎的 world 验证过，没有在真实的 Desktop 会话里试过：写这段时 Desktop 内置的是 2.1.299，加载不了 Dispatch Pilot。2026-10-22 起 Desktop 内置的是 2.1.308，可以加载；2026-10-31 是 2.1.309。

**从 0.8.x 升级的。** 只有 TypeSafe 的 key 的，不用改任何配置：Jev 就是默认，决策日志里不再有「改用 Jev」那一条。`decisionModel` 没设、只有 Perplexity 的 key 的，升级后不再路由（看板写缺 TypeSafe 的 key）：补上 TypeSafe 的 key，或者把 `decisionModel` 设成 `pplx`。

`decisionModel` 在 `/config` 里是下拉选择，有 `jev`（默认）和 `pplx` 两项；填了别的值（包括已移除的 `clef`），按没设处理，也就是默认的 Jev。

## 更新

从 GitHub 添加 marketplace 的，在 shell 里运行：

```bash
claude plugin marketplace update alex-mods
claude plugin update dispatch-pilot@alex-mods
```

第一条刷新 marketplace 的列表，第二条更新 mod。更新之后重启 Claude Code，或者在开着的会话里运行 `/reload-plugins`。

`claude plugin update` 看的是版本号（`.claude-plugin/plugin.json` 的 `version`）：版本号和你装的一样，它就回答已经是最新版本（`is already at the latest version`），不换掉本机的副本，哪怕分支上已经有新的提交。新的版本会升版本号。这个 marketplace 默认不自动更新；要打开，在会话里运行 `/plugin`，到 Marketplaces 里选 `alex-mods`，再选 Enable auto-update。自动更新同样只在版本号变了时才换。

从本地克隆安装的，不用 `claude plugin update`：在克隆里取新的提交（例如 `git -C claude-mods pull`），然后重启 Claude Code 或运行 `/reload-plugins`。Claude Code 直接从克隆加载 mod，不看版本号。

## 从 jev-pilot 切换

Dispatch Pilot 和 jev-pilot 不能共存：两者都在 `turn.step` 上改主 agent 的 effort，会互相覆盖。已经装了 jev-pilot 的话，按这个顺序切换：

1. **先在 jev-pilot 还启用的会话里运行 `/jev-pilot:setup restore`。** 它把 `/jev-pilot:setup` 改过的 skill 设置（settings 里的 `skillOverrides`）恢复成原样，并删掉备份。这条命令是 jev-pilot 自己的，只有它加载着才能用，所以要在停用它之前运行。不恢复的话，那些 skill 会一直对主 agent 隐藏，Dispatch Pilot 也推荐不了它们。没有运行过 `/jev-pilot:setup` 的话，这一步可以跳过。
2. 停用 jev-pilot：`claude plugin disable jev-pilot@jev-pilot`。
3. 重启 Claude Code：已经开着的会话还带着 jev-pilot，要重启。
4. **之后只用 `claude` 启动，不要用 `claude-jev`。** jev-pilot 的 marketplace 安装停用之后，`claude-jev` 启动器会改用 `--plugin-dir` 加载它在 `~/.claude/plugins/marketplaces/jev-pilot` 里的本地副本，jev-pilot 又被加载进来（还会起它自己的 router），两者就又撞在一起了。

## 配置

选项的值存在两个地方：

- **敏感项**（`typesafeApiKey`、`perplexityApiKey`、`liquidApiKey`）存进平台的安全凭据存储（Claude Code 文档的说法），输入时被遮住，不在 `/config` 里出现。用配置对话框（`/plugin configure dispatch-pilot@alex-mods`），或者 `claude plugin configure ... --values-stdin` 填，见「安装」。三项为空时分别读环境变量 `TYPESAFE_API_KEY`、`PERPLEXITY_API_KEY`、`LIQUID_API_KEY`；Claude Desktop 的 Code 标签读不到敏感项（#35），在那里只能用环境变量，见「安装」的「Claude Desktop」。
- **其他选项**存在 user settings 的 `pluginConfigs` 下，在 `/config` 面板里一项一行，可以直接改（需要 Claude Code 2.1.269 及以上）。两个列表项 `skillsAlwaysListed` 和 `skillsNeverSuggested` 不在 `/config` 里出现，要在 `~/.claude/settings.json` 里写成字符串数组。项目和本地 settings 里的 `pluginConfigs` 会被 Claude Code 忽略。

```json
{
  "pluginConfigs": {
    "dispatch-pilot@alex-mods": {
      "options": { "timeoutMs": 2500, "skillsAlwaysListed": ["anthropic-skills:pdf"] }
    }
  }
}
```

选项留空就取决策模型的默认值：`timeoutMs`、`contextMessages`、`contextTokens` 这 3 项在 manifest 里没有默认值，所以 `/config` 里显示为空，你不设时 Dispatch Pilot 取表里你选的决策模型的那一列。你自己设了某一项，就用你设的值。会话开始时 debug log 会写一行哪些选项用了默认值。

另有几个值也随决策模型而定，但不是选项，`/config` 里改不了，也不在下面的表里：问题怎么问（0.9.0 起三个决策模型的所有问题都用英文，ADR 0014、ADR 0017；effort 是 Score，其余是是非题或选择题），`contextMessages` 的上限（两个都是 2000；Jev 在 2026-10-15 之前是 32），合并的 agent 请求超出常规上限时的等待（Jev 3000 毫秒，见「发给决策模型的内容」），以及同时在途的 agent 请求数（Jev 4，pplx 5）。它们和上面那些默认值一起写在 `core/setup.ts` 的 `BACKEND_DEFAULTS`，评测和 mod 读的是同一张表。定档的规则不随决策模型变；是非题的线、effort 拿不准时的规则和派出 agent 选模型的方法按各家的官方指南：Jev 和 pplx 按 TypeSafe 的（0.7 / 0.3、分在两头、模型表，ADR 0014、0015），d1-ultra 按 Liquid 的（0.8 / 0.2、置信度低于 0.5、路由选择题，ADR 0017），skill 推荐的两道门槛也是（Jev 和 pplx 用 TypeSafe cookbook 的 0.30 和 0.30，d1-ultra 用 Liquid 的 0.2 和 0.5，ADR 0018），写在 `decision/guides.ts`，都不是选项。

**pplx 的默认值**（B′，ADR 0006，`docs/adr/0006-dispatch-pilot-pplx-default-decision-model.md`；预算和限速见 ADR 0007）：pplx 一个请求最多收 262,144 token（state 加全部问题），不受 Jev 那 32k 的限制，但真正限制它的是时间：请求越长回答越慢（Perplexity 文档：9 万 token 约 5 秒、19 万约 14 秒、接近上限约 23 秒），而一次决策最多等 8000 毫秒（hook 自己的上限是 10 秒）。2026-10-13 实测，pplx 数的 token 约是 mod 估算的 2.2 倍，48000 估算 token 的 state 单发要 4.3–5.9 秒，72000 要 8.3–8.8 秒，已经超过等待时间。所以发消息时的 effort 题和 Workflow 的一个请求各取 48000；派出 agent 常常几个一起派，每个请求又会被对话填满，同时发 5 个 32000 的都在 5.2 秒内答完，3 个 48000 的最慢要 7.6 秒，所以派出 agent 取 32000（Workflow 的调用分成几个请求时、以及 agent 启动时才判断的，每个请求也是 32000）。最近 2000 条消息（由 token 预算截断，不是条数），skill 的两段排序仍是 6000，因为 B′ 没有评测过 skill 题。`find_skill` 等 6000 毫秒。所有问题都用英文问。0.9.0 起它的回答按和 Jev 一样的规则读，0.8.x 为它离线定的 `thetaMax` 0.47 和往上取一档的 0.45 一起去掉了；pplx 不再评测。skill 推荐的门槛和 Jev 一样用 TypeSafe cookbook 的。用户自己设的值总是优先。

**Jev 的默认值是按 Jev 的常规上限配置的**（ADR 0014）。Jev 一个请求最多收 64k token，其中 state 加上最长的那一道题不能超过 32k；默认值都留出一成余量，不带长上下文请求头。最长的题是发消息时 skill 推荐的第一段，一道列出全部 skill 的选择题（0.9.0 之前带画像，111 个 skill 时 Jev 计约 2.19 万 token；0.9.0 起只带描述，短得多，超出预算时每个描述截到同样长），所以带 skill 题的请求（发消息时打开了 skill 推荐，以及 `find_skill` 的第一段）的 `contextTokens` 取 6000：state 最多约 6.7k（Jev 的计数），加上那一题约 28.6k，在 32k 的 90% 以内。其余的请求没有这么长的题：发消息时的 effort 请求（effort 题加十道是非题，最长的一道约 370 token，全部约 1,830，Jev 计约 500 和 2,500）、派出 agent（0.9.0 起最长的是 effort 题，Jev 计约 450；一个 agent 11 到 19 道题，全部 Jev 计最多约 3,900，ADR 0015）、Workflow 里的 agent（一个请求最多 64 道题，所以最多 4 个 agent），state 都取 24000（Jev 计约 2.67 万）：加上最长的那一题约 2.71 万，在 32k 的 90%（2.88 万）以内，4 个 agent 合进一个请求时整个请求最多约 4.2 万，在 64k 的 90% 以内。按这个算法 agent 的 state 最多可到约 25,500，取整到 24000。0.8.x 里这几种是 96000 加长上下文请求头（ADR 0009）：ctx30 上更好，eval v2 上不比 24000 好，官方文档说长上下文更慢、也不那么准，所以改回常规上限，没有重跑评测；更早的几轮靠问题摘要、长期约束和上一轮的情况带到决策模型那里。你自己设了 `contextTokens`，所有种类都用它，但每个种类各取它和自己的上限里较小的一个（设 16000 的话，带 skill 题的请求仍是 6000，其余是 16000）。`contextMessages` 取最大值（2000 条），让 token 预算而不是条数决定发多少，旧的消息放不下就整条丢掉。仍然只发文字和工具名，不发文件内容、写入的内容和工具输出。计算过程见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「Jev 的上下文默认值怎么算」。

**d1-ultra 的默认值**（ADR 0017）：Liquid 的 d1-ultra 每道题连同 state 最多 32,768 token，没有长上下文请求头。2026-10-28 实测，它数的 token 是 mod 估算的 1.092 倍（一份 23,346 估算 token、中英各半带代码的 state 计 25,484），所以沿用 Jev 的预算：effort、派出 agent 和 Workflow 都是 24000（约 2.62 万，加最长的一题约 2.72 万，是上限的 83%），带 skill 题的 6000。它比 Jev 慢：同样满预算的发消息请求（11 道题）2.0 秒，只问一题的 2.7 秒，Jev 0.9 秒，所以 `timeoutMs` 取 4000（约慢的那次的 1.5 倍），`find_skill` 的两段 6000 毫秒，skill 第二段至少 1500 毫秒（没实测，按 token 比例推的）。同时在途的 agent 请求最多 4 个，Liquid 每个模型每秒 20 个请求、所有 key 共用，mod 不另外限速，遇到 429 写「被限速」放行。skill 推荐的门槛按 Liquid 的：三道是非题的平均低于 0.2 不推荐，候选「是否正好做这件事」要高于 0.5 才推荐或返回（ADR 0018）。

下表的 Jev、pplx 和 d1-ultra 三列是各自的默认值。`起点`：这个默认值是暂定的起点，还没有评测数据支持。`按 Jev 的上限`：按上面的算法取 Jev 能接受的最大值，没有评测。`按 AA 基准`：按 Artificial Analysis 的基准校正过（见「模型和 effort 的依据」），没有在这套评测集上量过。没有标注的，是按测到的数据定的，或者本来就不需要校准。

### 决策模型和密钥

| 选项 | 作用 | Jev | pplx | d1-ultra |
|---|---|---|---|---|
| `decisionModel` | 决策模型，在 `/config` 里是下拉选择：`jev`（TypeSafe 的 Jev）、`pplx`（Perplexity 的 `pplx-decider-v1.1-27b`，0.9.0 起不再评测）或 `d1-ultra`（Liquid 的 d1-ultra，按 Liquid 官方的读法，没有评测，见「d1-ultra」）。默认 `jev`；填了别的值（包括已移除的 `clef`），按没设处理。不按密钥自动换：所选模型的 key 没有时不发请求，看板写明缺哪个 key | `jev` | `jev` | `jev` |
| `typesafeApiKey` | TypeSafe 的 API key，默认的决策模型 Jev 用它；全部图像功能也要它。敏感项。为空时读环境变量 `TYPESAFE_API_KEY`，两处都有就用这里的。key 只放在请求头里，不进日志、看板和 `$.state` | `空` | `空` | `空` |
| `perplexityApiKey` | Perplexity 的 API key，`decisionModel` 设成 `pplx` 时用；没有 TypeSafe 的 key 时图像功能也改用它（不能放大复核）。敏感项。为空时读环境变量 `PERPLEXITY_API_KEY`，两处都有就用这里的。key 只放在请求头里，不进日志、看板和 `$.state` | `空` | `空` | `空` |
| `liquidApiKey` | Liquid 的 API key（以 `liquid_` 开头），`decisionModel` 设成 `d1-ultra` 时用；图像功能不用它，仍用 TypeSafe 的 key。敏感项。为空时读环境变量 `LIQUID_API_KEY`，两处都有就用这里的。key 只放在请求头里，不进日志、看板和 `$.state` | `空` | `空` | `空` |
| `pplxQps` | 每秒最多向 Perplexity 发几个请求（1–50），只对 `pplx` 有用，Jev 看下面两项。Perplexity 的文档写每个组织每秒 10 个；默认 5，几个同时派出的 agent 可以一起发出（实测同时发 5 到 8 个都没有 429，而按 1 个每秒排队时第 4、5 个要 8.5 秒、10.7 秒才答完），也给同一个 key 的其他会话留出余量。超出的在 mod 里排队，发消息时的 effort 题最先发，排队的时间算进该请求自己的等待。遇到 429 时，剩余等待时间不少于 `Retry-After` 加约 5 秒就按 `Retry-After` 重试一次，不够就不经路由地放行，看板写「被限速」 | `5` 仅 `pplx` 用 | `5` | `5` 仅 `pplx` 用 |
| `jevQps` | 每秒最多向 TypeSafe 发几个请求（1–1000），只对 `jev` 有用。填你的账号在 TypeSafe 控制台 Rate limits 页上的限额，默认 80 是默认套餐的值。超出的在 mod 里排队，发消息时的 effort 题最先发，排队的时间算进该请求自己的等待 | `80` 默认套餐 | `80` 仅 `jev` 用 | `80` 仅 `jev` 用 |
| `jevTokensPerSecond` | 每秒最多向 TypeSafe 发多少 input token（10000–100000000），只对 `jev` 有用。填控制台上的限额，默认 100000 是默认套餐的值。mod 按令牌桶算：桶里最多存 5 秒的额度（默认 50 万 token，约 4 个带满对话的请求），之后按每秒的额度补；请求按估算的 token 数（mod 的估算乘 1.3）取出，答完按 Jev 报的实数多退少补。额度不够的请求排队，effort 题最先发；排到时离它自己的等待结束不到 200 毫秒的，不发，按超时处理。遇到 429 或 529，所有请求按 `Retry-After` 暂停，最多暂停 5 秒（写一个小时也只停 5 秒；没有 `Retry-After` 就 1 秒，529 是 0.5 秒）；收到的那个请求剩余等待时间够用就重试一次，重试遇到的第二次 429 也让所有请求暂停；被暂停挡得在自己的等待里发不出去的请求不发，看板写「繁忙」，不写「超时」 | `100000` 默认套餐 | `100000` 仅 `jev` 用 | `100000` 仅 `jev` 用 |

### 等多久，读多少

| 选项 | 作用 | Jev | pplx | d1-ultra |
|---|---|---|---|---|
| `timeoutMs` | 一条消息等决策模型的最长时间（200–8000 毫秒），超过就不经路由地放行 | `1500` | `8000` | `4000` 按冒烟实测（满预算的请求 2.0–2.7 秒） |
| `contextMessages` | 随你的消息一起发的最近消息条数，从 0 到决策模型能接受的条数（两个都是 2000）。两个模型都默认取上限，由 `contextTokens` 决定实际发多少 | `2000` 按上限 | `2000` | `2000` |
| `contextTokens` | 发给决策模型的 state 的 token 预算（100–16000，pplx 到 48000）：你的消息加上最近的消息（以及摘要、次数、长期约束、上一轮的情况），按发出去的样子数（连同字段名和转义），中英文按同一个尺度数，旧消息先丢。按请求的种类取：默认值带 skill 题的请求 6000；发消息时单独发的 effort 请求（见上面，它恒单独成一个请求，预算恒按这一档）、派出 agent 和 Workflow 里的 agent，Jev 24000（常规上限之内，不带长上下文请求头），pplx 48000（派出 agent 32000）；你设了就每个种类取它和自己上限里较小的 | `6000` 按 Jev 的上限，其余种类 24000（常规上限） | `6000`，派出 agent 32000，其余种类 48000，按 pplx 的回答时间 | `6000` 按 d1-ultra 的上限，其余种类 24000 |

### effort

| 选项 | 作用 | Jev | pplx | d1-ultra |
|---|---|---|---|---|
| `unresolvedMaxAfter` | 规则 R5：这条消息被判为仍未解决、而且未解决次数（算上这一条）达到它时，这一轮直接用 max。0 表示从不，最大 10。次数一直在数，不受开关影响 | `3` 暂定 | `3` 暂定 | `3` 暂定 |

### 失败时升模型

| 选项 | 作用 | Jev | pplx | d1-ultra |
|---|---|---|---|---|
| `escalateAfter` | 派出的 agent 计入的工具调用失败满几次，就从它的下一步起升一档模型（1–20）。主 agent 不升，这一轮结束时记下失败是否到了这个数 | `2` 起点 | `2` 起点 | `2` 起点 |
| `escalateLimit` | 一个派出 agent 最多升几次模型（0–10）；每升一次（或到顶升不了时）失败重新数 | `2` 起点 | `2` 起点 | `2` 起点 |
| `escalateHaikuTo` | 失败的 haiku agent 升到哪个模型：`sonnet`、`opus`、`fable` 或完整的模型 id；留空表示 haiku 不升。你为这个 agent 点名的模型不换，你排除的模型跳过 | `sonnet` | `sonnet` | `sonnet` |

### 派出 agent 和 Workflow

| 选项 | 作用 | Jev | pplx | d1-ultra |
|---|---|---|---|---|
| `agentFable` | 打开后，决策模型可以为派出 agent（包括 Workflow 里的）选 fable，fable 比 opus 贵；你自己点名 fable 时不受这个开关限制 | `false` | `false` | `false` |
| `workflowMode` | `rewrite`：把决定写进脚本再运行；`return`：第一次提交被拒绝并附上逐个 agent 的推荐，让主 agent 自己写进去，同一个 Workflow 第二次提交直接放行 | `rewrite` | `rewrite` | `rewrite` |

### skill

每条消息最多推荐一个 skill，两道门槛不是选项（ADR 0018）：Jev 和 pplx 按 TypeSafe 的 skill 推荐 cookbook，三道「要不要 skill」的是非题平均低于 0.30 就不推荐，细看的三个候选里「是否正好做这件事」最高的不到 0.30 也不推荐；d1-ultra 按 Liquid，低于 0.2 不推荐，要高于 0.5 才推荐。0.8.x 的 `skillsMax`、`skillsMinRelevance`、`skillsShortlist`、`findSkillMinRelevance`、`skillsProfileModel` 和 `skillsProfilesPerSession` 去掉了，存下的值不再起作用。

| 选项 | 作用 | Jev | pplx | d1-ultra |
|---|---|---|---|---|
| `skillsAlwaysListed` | 一直留在主 agent 的 skill 列表里的 skill，写列表里的名字（同步来的 skill 带前缀，例如 `anthropic-skills:pdf`）。列表项，不在 `/config` 里 | `空` | `空` | `空` |
| `skillsNeverSuggested` | 从不推荐给主 agent、也不提示你的 skill，写法同上。它们照常安装，Skill 工具仍能按名字加载，`find_skill` 也不返回它们。列表项，不在 `/config` 里 | `空` | `空` | `空` |
| `findSkillMax` | `find_skill` 一次最多返回几个 skill（1–10）：第一段排在前面的这么多个在第二段逐个判断，过了决策模型的门槛（Jev、pplx ≥ 0.30，d1-ultra > 0.5）的才返回 | `5` | `5` | `5` |

### 问题摘要

| 选项 | 作用 | Jev | pplx | d1-ultra |
|---|---|---|---|---|
| `summaryModel` | 在你本人的消息开始的那一轮结束后，在后台用英文续写问题摘要的模型，写别名（`haiku`）或完整的模型 id。通过你的 Claude Code 登录调用，算在你的用量里；摘要是对话的转述，所以 `contextMessages` 为 0 或 `summary` 开关关着时不写 | `haiku` | `haiku` | `haiku` |

## 控制：`/dp`

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
- 功能的开关是 `main-effort`、`summary`、`dispatched-agents`、`workflow-agents`、`workflow-labels`、`escalation`、`skills`、`find-skill`、`signals`、`hook-block-failures`、`visual-check`、`screenshot-takeover`、`image-routing` 和 `prompt-hint`。`summary` 管问题摘要的写和发（默认开）；未解决次数、长期约束和上一轮的情况没有开关，`main-effort` 关着时不问也不记。`prompt-hint` 在你写消息时，在提示框里草稿后面用灰字写出 dp 已经知道的事：dp 关着、effort 锁定了哪档、派出 agent 时会识别你点名的模型或 effort；这段字只画在框里，不进草稿，也不随消息发出。`hook-block-failures` 打开后，你自己的 settings hook 拦下的调用也算失败（派出 agent 的升模型和主 agent 记下的失败都算上它们）。`visual-check`（看图核对）、`screenshot-takeover`（截图接管）和 `image-routing`（带图路由）是 0.5.0 加的图像功能，会把图发给 TypeSafe 或 Perplexity（见「图像：发给谁，什么时候发」）。**默认关闭的有 `hook-block-failures`、`screenshot-takeover` 和 `image-routing`，其余默认开着**，所以装好之后图像功能只有看图核对是开的，而且要 agent 去调用 `visual_check` 才会发图。0.8.x 的 `unresolved` 开关去掉了：存下的 `unresolved` 设置不再起作用。
- 开关保存下来，下次启动会话时还是你离开时的样子，总开关也一样：`/dp off` 同样存进 `$.store`，跨会话保持，要 `/dp on` 才开回来（只有 `/dp lock` 的锁定只限本会话）；只保存和默认值不同的开关，所以一个新增的功能默认开着。
- 锁定只在当前会话里有效，`/dp unlock` 或会话结束时解除。锁定期间决策照常进行并记录，不想为此等决策模型的话，用 `/dp main-effort off`。
- 依据面板的决策日志和 `/dp log N` 显示每项功能记录的决策：做了什么决定、针对哪条消息、理由（决策模型给出的各档概率、回答的位置、抬高它的那条下限，置信度只记录）。同样的内容也写进 debug log，不进入对话。
- 信号（上下文占用、5 小时和 7 天限额的百分比、会话花费）每次变化时写一行进 debug log，只是记录，不参与任何决策；`/dp signals off` 可以停止记录。
- 暂时不想用就 `/dp off`（它和别的开关一样会保存，下个会话还是关的，`/dp on` 开回来）；彻底停用就 `claude plugin disable dispatch-pilot@alex-mods`。

## 局限和待评测

**局限**

- **只支持 Claude Code 订阅**，见「要求」。
- **决策请求整体失败时，你排除的模型仍可能按主 agent 的指定启动。** 哪些模型被排除，是决策模型从你的话里读出来的，没有它的回答就无从知道；mod 不改用关键词去猜，免得把只是提到某个模型的话当成排除。这是有意的取舍。同样的原因，决策请求整体失败时，你点名的模型和 effort 也读不出来，不会生效。
- fork 出来的 agent（它总是用父 agent 的模型）和 agent team 的 teammate（它会长期存在、处理很多任务，派出时的一次判断看不到这些任务）不处理。已经结束、又被消息唤醒的 agent 不重新判断，沿用派出时的决定（引擎不让改它的模型）。看板上这三种都写明原因：「未路由 · fork 沿用主 agent 的模型和 effort」、「未路由 · teammate 跨多个任务，派出时不判断」、「未路由 · 续跑沿用原来的决定」（在派出的那一轮里续跑的，照旧显示派出时的决定）。
- **主 agent 在推荐漏掉时不会自己去用 `find_skill`。** 一条要写 PR 描述、却没有推荐 `pr` 的消息，有提示、没有提示、提示写得更主动，主 agent 都直接写了正文；被明确要求查时，它能找到 `find_skill` 并用上。所以漏掉的推荐，目前只靠发消息时的推荐。
- **选 Jev 时，真正的上限是账号的 token 速率。** Jev 1.14 能同时答一个 key 的几个长请求（2026-10-15 实测：4 个各约 11.5 万 token 的请求同时发，1.39–1.53 秒全部答完，单发一个 1.44 秒，没有 429）；而默认套餐每秒 10 万 input token，一个带满对话的请求就要用掉约 1.15 秒的额度。mod 自己按 `jevQps` 和 `jevTokensPerSecond` 排队：一阵最多花掉 5 秒的额度（约 4 个满请求），之后约每 1.15 秒放出一个满请求，effort 题插到最前。所以长会话里一下派出很多 agent（分属 5 组以上），或者别的会话也在用同一个 key 时，排在后面的 agent 可能等不到回答、按主 agent 原来的要求启动。换了更高的套餐，就把这两项改成控制台上的数。
- **选 Jev 时，长会话里更早的几轮只能靠摘要和长期约束。** 0.9.0 起每种请求都留在 Jev 的常规上限之内（state 24000，ADR 0014），超出预算的更早几轮决策模型读不到原文，靠问题摘要、长期约束和上一轮的情况。0.8.x 用的 96000 加长上下文请求头在 ctx30 上更好（25/30 对 13/30），在 eval v2 上不比 24000 好，而且每个请求多等约 1–1.5 秒；改回常规上限没有重跑评测。
- **选 pplx 时，派出的 agent 要多等几秒才启动。** 请求里带着派出它的那段对话，会话长了每个请求都满 32000 估算 token，pplx 约 4 到 5 秒才答（只带任务时不到 1 秒）。一起派出的几个合进一个请求；一次派出很多个时，最多 5 个请求同时在途，后面的排队，最后几个可能超时、不经路由地启动；嫌慢可以调小 `contextTokens`。
- **同一个 Jev key 上几个会话同时发消息，skill 推荐更容易失败。** 带 skill 推荐的第一段 0.9.0 之前带画像，约 2.6 万 token，单个会话 0.6–0.8 秒，5 个会话同时发时 0.9–1.3 秒（2026-10-19 实测；0.9.0 起只带描述，更短，没有重测）。第二段至少等 800 毫秒，所以这时这条消息最多等约 2.3 秒（长会话里 3.8 秒）才进入；第一段本身也只等 1500 毫秒，再慢就整段放行，不推荐 skill。Desktop 上常同时开着几个会话，比终端更容易遇到。
- **Jev 的请求比以前大，延迟会多一点。** 默认值把 Jev 的 state 放到最多约 6.7k token（带 skill 题的请求，`contextTokens` 6000），发消息时带 skill 推荐的请求最多约 2.9 万 token；发消息时的 effort 请求和关于 agent 的请求最多 24000。已有的实测：Jev 处理 2.19 万 token（skill 第一段，带全部画像）时 p50 约 560 毫秒、p90 约 615 毫秒；另一次整体偏慢的运行里，这一段 218 条中有 24 条（约 11%）超过 1500 毫秒，这些消息的决策整个超时，effort 也没有经过路由。按每多 1k token 约多 13 毫秒外推，现在的 state 再多约 80 毫秒，慢的时段超过 1500 毫秒的消息会比 11% 更多；这是外推，没有在新默认值上量过。如果看板上「决策模型超时」变多，可以把 `contextTokens` 调小（每少 1k 约快 13 毫秒），或者把 `timeoutMs` 调大；skill 那一题本身有 2.2 万 token，想去掉这部分延迟只能 `/dp skills off`。
- **看图核对只看得出粗的差异，「过」不是验收。** 评测集上（Jev 1.14，一次基线）：不成立的检查项里 1 条被判成过（字重，0.91，刚好过了当时 0.9 的门槛；现在的门槛 0.8 它也过），抓到 10 条（共 20 条，界面 3/8，海面 7/9，动画 0/3），字重和 4 px 偏移是盲区；动画在当时的帧（没有画出终点）上一条也没判出来，15 条都在没把握；后来把终点画成绿色虚线的 TARGET 框、问法里也告诉它终点的样子，再各跑 3 次：没毛病的和有毛病的分得开了（回弹 0.24–0.29、卡顿 0.34–0.36、终点错 0.15–0.21，其余多在 0.8 以上，3 次之间差不过 0.05），但按当时的 0.9 / 0.2 的门槛，只有终点错 3 次里有 2 次判出不过，回弹和卡顿仍然没把握。用户看了这两次评测后把门槛改成：过 0.8（静态截图、放大复核的裁图、录屏），不过 0.2（静态截图）或 0.4（录屏），档位序列判「没差别」仍要每个区域到 0.9；按存下的概率重算（没有发新请求），动画（带终点框的帧）不成立的 9 条全部判出不过（原来 2 条），成立的判过 28 / 36（原来 9 / 36），没把握从 76% 降到 18%，不成立却判过、成立却判不过都是 0；界面和海面的数一条没变，字重和 4 px 偏移仍是盲区。动画只有 5 个合成动画、每个 3 遍，0.4 是事后在这批题上看出来的，所以结论只是「这批题上没有误判」。所以它省的是「明显有问题的先挡住」，不省交付前主 agent 亲自看的那一次。
- **图像功能没有在真实会话里端到端跑过**（用户决定不再做实测）：引擎里的图块、缩图、Read 结果的换法、注册工具的回答、hook 时限是用 event-probe 实测的，其余用测试里扮演引擎的 world 和评测里的真实 Jev 验证。**没验证的有**：截图类 MCP 工具返回的图块在 `tool.call` 里长什么样（两种写法都认）、`session.append` 里是否一定带 `[Image: source: …]` 文字、实物照片对渲染图和档位序列这两种用法（评测集没有）。
- 大多数默认值是暂定的起点（表里标了 `起点`）：评测数据只够定下少数几项，其余的见下面的「还没有数据的事」。

**问题用什么语言写。** 0.9.0 起三个决策模型的所有问题都用英文写（ADR 0014：TypeSafe 的官方指南说英文是 Jev 最准的语言）。d1-ultra 按用户的例外做过一次语言测试（一次请求，同样五个判断中英各问一遍）：两种问法都答对，差距都在 0.03 以内，所以和 Jev 共用英文题面（ADR 0017）。0.8.x 里 Jev 的发消息时 effort 题和派出 agent、Workflow 里 agent 的题用中文：`effort-submit` 上用中文问，中文题 85.0%、英文题 89.0%，用英文问是 79.0%、78.0%（各 1 次，之前 3 次中文问法也高约 8 个百分点）。这次按官方指南改回英文，题目也一起改了（加了是非题），没有重跑评测，所以这组数字不能当 0.9.0 的准确率。

**中文和英文的差距。** 门槛是中文准确率比英文低不超过 4 个百分点，正好低 4 个百分点也算通过。0.8.x 的配置（Jev，effort 用中文问）在 `effort-submit` 上那一次正好差 −4.0，同样的请求之前 3 次是 0、0、−1。0.9.0 用英文问之后的差距没有量过；其余三套评测都在门槛之内（见「评测」），但都是改措辞之前测的。

**派出 agent 的模型文字按 AA 的基准重写，并用真实的 Jev 调过（0.8.x）。** 0.9.0 起不再用这段文字：模型改由十道是非题和代码里的模型表定（ADR 0015），没有重跑评测，下面的数字只是 0.8.x 那道选择题的。 重写后的第一次评测（`models-hint`，100 题中英各一遍）整体从 70%/68% 掉到 60%/58%（模型部分 82/81，effort 部分 64/62）。之后调了三轮文字和 sonnet 的 effort 下限（sonnet 从 high 降到 medium），最后一版是整体 69%/68%、模型部分 89%/91%、effort 部分 71%/71%，同一版重复一次是 69%/67%、89%/90%、71%/71%。和重写之前（70%/68%，85%/85%，74%/72%）比，模型部分更好，effort 部分低 3 到 1 个百分点：往上取一档和模型下限让偏高多了、gold 命中从 50%/48% 变成 44%/44%，因为数据集的 gold 是按「够用的最便宜档」标的，没有按 AA 重标。注意这三轮文字是对着这 100 题的错题调的，所以最后的模型部分是在调过的题上量的，对没见过的请求会低一些。逐轮的表、发消息和中途重判的真实对照在 [docs/research/aa-benchmarks-2026-10.md](../docs/research/aa-benchmarks-2026-10.md) 的第六节。

**问题的文字一改，评测就要重跑。** 发给决策模型的问题、指令和选项描述是被测的对象：改了哪一处，用到它的评测都要重跑，旧结果只能对照。派出 agent 的 effort 问题和 Workflow 题的合并提问、skill 第一段拆成两题，这几处在评测之后改过，没有重跑，所以下面「评测」里这两套的数字只能当预览；0.9.0 发消息时的请求（英文、十道是非题、写在代码里的定档规则）也没有重跑。每处改动的清单见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「待评测」。

**还没有数据的事**（每一条的数字和依据见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「待评测」）：

- **上下文的范围。** 0.9.0 回到 Jev 的常规上限（24000，ADR 0014）。0.8.x 的 96000 只有两组数据：ctx30（一段长对话 30 题，决定性的几轮都在 24000 之外，所以是长上下文最有利的设计）长上下文 25/30 对 13/30；eval v2（120 题）整段对话平均 14.6 万 token 时 60.0%，不比 24000 的 67.5% 好。摘要、长期约束和上一轮的情况能补回多少，没有评测；`contextMessages` 2000 也没有在评测集上扫过。
- **按语言分别定门槛。** 各个置信度门槛都是中英文共用一个值，没有按语言分别校准。
- **失败时升模型的门槛。** `escalateAfter`、`escalateLimit` 和 `escalateHaikuTo` 没有评测方法，按使用体验调。
- **d1-ultra 没有评测**（用户的决定）。它的线（0.8 / 0.2）是 Liquid 文档写明的示意值，路由的档位描述是我们写的；2026-10-16 用 Jev 的题核验时，它在派出 agent 那套上显著不如 Jev 1.14（62.0 对 71.5）。它的回答同一请求两次会差约 0.08，中间带又更宽，拿不准抬到 high 的情况会比 Jev 多。
- **确认和要求升级两道题没有评测**（ADR 0016）；冒烟时 Jev 和 d1-ultra 对同一条「还是不行……你再仔细查查」都答要求升级为是、确认为否。
- **派出 agent 的模型表。** 0.9.0 起模型由十道是非题和代码里的模型表定，主 agent 的指定只升不降，`agentOverride` 删了（ADR 0015）；是非题、点名和排除都按 TypeSafe 的起点 0.7 / 0.3 读，effort 按基础档和下限定，都没有评测。`subagent` 评测已按新的请求和规则改好（`nouls` 变体），还没跑；表里 ③b（拿不准时 sonnet 加 max effort）会让一部分 agent 用得比以前贵。
- **Jev 同时答几个长请求、账号能突发多少。** 同时发 4 个长请求只量过一次（见「限制」），关于 agent 的请求同时在途 4 个就是按它定的；5 个以上没有试过。TypeSafe 没写它的限额怎么计（令牌桶还是时间窗、一次能突发多少），mod 按「最多存 5 秒的额度」算，只知道一次 45 万 token 没有被限速；算多了会遇到 429，靠暂停和重试补救。
- **skill 推荐没有在 0.9.0 的做法上评测过。** 0.9.0 起按 TypeSafe 的 skill 推荐 cookbook 做（ADR 0018）：问题照 cookbook 原文，门槛是 cookbook 的 0.30 和 Liquid 的 0.2、0.5，都没有在这套评测集上量过，评测代码只保证能编译。下面「评测结果」里 `skill` 一行是 2026-10-04 带画像、可推荐多个的旧做法。
- **主 agent 会不会主动用 `find_skill`。** 见上面的局限。其他场景（文件格式、某个服务的工具、一轮中途才出现的需要）、其他模型，以及「每轮先查」这类更强的写法值不值得它多出的两步，还没有评测。
- **skill 请求的大小和延迟。** 0.9.0 之前带全部画像的第一段约 2.19 万 input token（111 个 skill，Jev 计），Jev 第一段 p50 0.56–0.67 秒，慢的时段 p90 到 1.65 秒；0.9.0 起只带描述，第二段在三道是非题说要 skill 时总会发，都没有重新测。
- **背景让派出 agent 判得更准多少。** 派出 agent 和 Workflow 的请求带着对话和脚本（ADR 0007；选 Jev 时 2026-10-15 起，ADR 0009），这是按「给得越多判得越准」加的；ctx30 的 15 道派出 agent 题里，长上下文对 13 道、24000 对 8 道（同一请求里问的，不是 mod 的派出请求）。`subagent` 评测集的题只有任务和你的话，没有对话和脚本，量不出背景的作用，也量不出背景里的无关内容会不会干扰判断；几个派出 agent 合进一个请求后彼此的任务算不算干扰，也没有量过。
- **一个请求里放几个 Workflow 调用，准确率会不会降。** 一个脚本最多 4 个 `agent()` 共用一个请求，其他调用的说明对每个问题来说是无关内容，可能降低准确率。`subagent` 评测里有一个一个请求一个调用的对照变体，没有跑过。

## 评测

评测用真实的 Jev 测决策的准确率，脚本和数据在 `eval/`。每套评测集 100 题上下，中英文对照，答案经过审核；评测发出的请求和 mod 发出的逐字相同（测试核对）。

| 评测集 | 测什么 | 线上的问法，Jev（jev-1.13.0），中文 / 英文 |
|---|---|---|
| `effort-submit`（100 题） | 发消息时的 effort | 85.0% / 89.0%（0.8.x 的中文问法，1 次运行；同样的请求之前 3 次的平均是 87.3% / 87.7%；0.9.0 的英文问法和规则没有重跑） |
| `subagent`（100 题） | 派出 agent 和 Workflow 里 agent 的模型加 effort，两样都对才算对 | 69% / 68%（`models-hint`，0.2.2 的文字和规则，2026-10-05，重复一次是 69% / 67%）；之前 70% / 68% |
| `skill`（109 题） | skill 推荐，0.9.0 之前带画像的做法 | 79.8% / 83.5% |

- 中英差距的门槛是中文比英文低不超过 4 个百分点，正好低 4 个百分点也算通过。上面三行都在门槛之内：`effort-submit` 那一次正好是 −4.0，`skill` 是 −3.7。
- 一轮中途的 effort 那一套（`effort-midturn`，100 题）随一轮中途重判一起删掉了（0.9.0，ADR 0013），旧结果留在 `eval/results/effort-midturn/`。
- Jev 单个 effort 请求的延迟 p50 约 0.28–0.42 秒，p90 约 0.32–0.46 秒；skill 带画像的第一段（0.9.0 之前）p50 约 0.56–0.67 秒。
- **`skill` 一行是 2026-10-04 测的**，之后问题改过措辞，没有重跑，只能当预览（见「局限和待评测」）；`effort-submit` 的数字和 `subagent` 的 `models-hint` 是 2026-10-05 在 0.2.2 的规则和文字上重跑的（`subagent` 的其余变体没有重跑）。`subagent` 和 `skill` 的中文问法变体（`models-hint-zh`、`profiles-zh`）未运行。0.9.0 的 `subagent` 改成是非题和模型表（`nouls`、`nouls-single`、`nouls-zh`，ADR 0015），还没跑。单次运行有波动：同一配置跑两次，单项准确率相差 0–4 个百分点，和 4 个百分点的门槛同一量级。评测的设置是 4 条消息、2000 个 token，不是 0.2.1 起 Jev 的默认值（32 条、6000 个 token）；评测集的上下文很短，离线重建请求核对过，换成新默认值后 `effort-submit` 的 200 个请求里 state 变了 2 个，`skill` 和 `subagent` 没有变，所以这些数字仍可以参考，但不是在新默认值上量的。

**看图核对**另有一套评测（`visual-check`，24 题：界面、3D 海面、动画帧、参考图复杂度，带真值；图和真值在 `eval/datasets/visual-check/`），发的请求和 mod 逐字相同，Jev 出新版本时重跑。2026-10-15 在 `jev-1.14.0` 上的基线：64 个请求约 0.014 美元；不成立的检查项 1/20 判成过，抓到 10/20，对照（一模一样的图）12 条检查项没有一条被判不过；三组参考图的复杂度读数按立方体 < 海面 < 城市排对了。它是一次快照，没有调过问法和门槛，题少，差一两条不算差别。基线是按 0.9 / 0.2 判的，门槛改成 0.8（录屏不过线 0.4）之后按存下的概率重算的数在 `eval/results/visual-check/2026-10-15-bars-rescored.json`。基线之后，动画题的帧重画过（画出绿色虚线的 TARGET 终点框，问法里描述终点的样子），那 5 题各跑 3 次的结果单独存在 `eval/results/visual-check/2026-10-15-jev-anim-target.json`，基线文件里的动画是旧帧。命令和指标见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「看图核对（visual-check，#65，spec #55 的接缝 2）」。

变体、指标、常数基线、门槛的离线重扫、已知的问题题和复现的命令，见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「评测（接缝 2）」。

## 开发

结构、扩展方式、测试写法、评测的做法和已经实测过的引擎行为，见 [DEVELOPMENT.md](DEVELOPMENT.md)。仓库通用的约定（mod 的结构、命令、编写约束）见 [CLAUDE.md](../CLAUDE.md)。
