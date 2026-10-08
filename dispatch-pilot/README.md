# Dispatch Pilot

Dispatch Pilot 是 `alex-mods` marketplace 里的一个 Claude Code mod。它在 Claude 之外调用一个决策模型（默认是 Perplexity 的 pplx；没有 Perplexity 的 key、但有 TypeSafe 的 key 时退回 TypeSafe 的 Jev，也可以指定用 Jev），替你决定 Claude Code 怎么干活：主 agent 每一轮用哪档 effort，派出的 agent 用哪个模型和哪档 effort，主 agent 该看哪几个 skill。

主 agent 的模型从不改变，所以 prompt cache 不受影响。这只在 Claude Code 订阅下成立，见「要求」。

## 它做什么

决策模型只负责给出判断，不参与回答你。每个判断的结果写在看板上，依据记进决策日志，在依据面板里看（`/dp`），也可以用 `/dp log N` 在对话里列出。

- **主 agent 的 effort。** 你每发一条消息，Dispatch Pilot 把这条消息和最近几条消息发给决策模型，问它这项工作需要多少逐步推理，得到 low、medium、high、xhigh、max 五档各自的概率。取概率最高的一档，并列时取较高的一档；如果高一档的概率也有 0.3 以上，就再往上取一档（升高容易：低估一档要付出质量，高估一档只多花 token）；`max` 只在它自己的概率达到 `thetaMax` 时才用。这一轮的每个模型请求都按这一档发出。一轮进行中，每隔几步（`rejudgeEvery`），以及主 agent 派出 agent、启动 Workflow 或加载 skill 时，会再判断一次（中途重判）；升档和降档都有防抖：升档要置信度达到 `thetaUp`（0.3），降档要达到 `thetaDown`（0.75）而且一次只降一档，升档之后 `holdSteps`（5）步之内不降。派出 agent 交回结果、后台任务结束，会话空闲时它们会开始主 agent 的新一轮，这样的一轮也走同样的判断：决策模型读到的是那条报告的文字，不推荐 skill，也不在这一轮中途重判（会话自己的 xhigh 用在只是看一眼结果上是浪费）；报告送进一轮正在进行的对话时不另外判断。其他会话的消息、插件自己发的消息和空消息都不判断。你输入的 skill 或 markdown 命令（例如 `/implement #19`）开始的一轮也照常判断：决策模型读你输入的命令和参数，以及这个命令是做什么的，不读命令展开后的正文；参数里的点名照样算；这样的一轮不推荐 skill。`/dp`、`/clear` 这类本地命令不开始一轮，也就不判断。
- **派出 agent 的模型和 effort。** 主 agent 用 Agent 工具派出一个 agent 时，决策模型为它选模型（默认在 haiku、sonnet、opus 中选，打开 `agentFable` 后加入 fable）和 effort；选了 haiku 就不设 effort，haiku 不支持。三个模型的分工按 Artificial Analysis 的基准定（见下面的「模型和 effort 的依据」）：haiku 只做一两步就能跑完、结果只需要收集起来并按要求排版的只读查找，sonnet 承担大多数执行类工作（终端、需求明确的代码修改、自动化、调研汇报），opus 做需要审慎判断或细微错误代价高的工作（安全、并发、涉及钱、迁移、生产）、难推理、设计、原因未知的 bug、科学或算法类代码，以及结论取决于记忆中的事实、而且无法在仓库或文档里查证的调研；fable 在 AA 上没有领先 Opus 的地方，价格是 2.5 倍，所以仍默认关闭。决策出来的 effort 不低于所选模型的下限：sonnet 和 opus 至少 medium，haiku 不带 effort。你在消息里点名的模型或 effort（「用 opus」「effort 开 low」）一定照办，下限和往上取的一档都不会改你点名的值，你排除的模型（「别用 opus」）不会用（决策请求整体失败时除外，见「局限和待评测」）。主 agent 自己为这个 agent 指定了模型时，只有决策模型选了别的、而且置信度达到 `agentOverride` 才推翻它。
- **Workflow 里的 agent。** 主 agent 提交 Workflow 脚本时，对脚本里每个 `agent()` 调用点做同样的判断，把模型和 effort 写进脚本再运行，并告诉主 agent 写了什么；`workflowMode` 选 `return` 时改为退回脚本，附上逐个调用的推荐，让主 agent 自己写进去。脚本写不进去的（用 `scriptPath` 或 `name` 提交、恢复的运行、读不了的脚本），在每个 agent 启动时按它的 label 设置，这叫兜底。
- **卡住时强制升档。** 主 agent 或派出 agent 的工具调用接连失败 `escalateAfter` 次时，再问决策模型一次，把它的 effort 升一档（`escalateMode` 选 `max` 则直接升到 max）；haiku 没有 effort 可升，改用 sonnet 接着做（`escalateHaikuTo`）。这些失败本来就在意料之中的，例如先写下、要看它红的测试，或者没找到东西而以非零退出的搜索，不升档；是不是预期内失败由决策模型判断，不靠关键词。你自己拒绝的调用从不算失败。
- **未解决次数。** 你本人的每条消息（包括斜杠命令）发出时，决策模型还回答一道三选一的题：这条消息是在说你和主 agent 最近在处理的那个问题仍未解决、已经解决，还是换了新问题或无关；不靠关键词，「再看看」或贴一段同样的报错也认得出。「仍未解决」把握够（暂定 0.5）次数加一，「已经解决」或「新问题或无关」把握更高（暂定 0.7）才清零，都没到次数不变。次数存在会话里，`/clear` 和新会话清零，`/compact` 和热重载保留；agent 交回结果、后台任务通知开始的一轮不问。依据卡片显示次数和这一次的结论。次数和下面的摘要一起作为决策模型判断 effort 的依据，见「强提示」。**这项功能（`unresolved` 开关，次数、摘要、强提示共用）默认关闭**：评测里它对默认的决策模型没有提升，所以不问这道题、不数次数、不写摘要、不给强提示。`/dp unresolved on` 打开，对 pplx 和 Jev 都生效；`/dp unresolved off` 再关。开关存在 `$.store`，你手动设过的状态升级后保持原样；0.3.1 里它是默认开着的，开着时没有保存过任何设置，所以从 0.3.1 升级上来、一直开着的，现在变成了关闭，要用请自己打开。
- **问题摘要。** 你本人的消息开始的那一轮结束后，一个便宜的模型（`summaryModel`，默认 haiku，用你的 Claude 登录和用量）在后台续写一份简短的摘要：问题是什么、试过哪些做法、现在到了哪一步，不超过 500 token，只记试过什么，不判断成没成功；你的下一条消息说「仍未解决」时，最后一次尝试标上「未解决」。决策模型发消息时读它，借此看到超出上下文预算的更早几轮；它从不等摘要写完，来不及时用上一份。写失败（出错、超时）保留旧摘要并在决策日志里记一条。问题解决、换了问题、`/clear` 和新会话时和次数一起清空，`/compact` 和热重载保留。依据面板里能看摘要全文。交给写摘要模型的内容先脱敏；`contextMessages` 为 0 时不写（摘要是对话的转述）。默认关闭，随 `unresolved` 开关一起打开和关闭。
- **强提示。** 次数达到 `unresolvedMaxAfter`（默认 3，0 到 10，0 表示不给）时，发消息时和中途重判时 effort 题的说明里多一条：这项工作属于多次尝试都没解决的故障。它只描述情境：不写档位的名字或序号，`pickEffort` 的规则和 `thetaMax` 都不变，用不用最高一档仍由决策模型结合摘要和对话自己决定。次数和摘要也进这两种请求的 state（`unresolved_count`、`problem_summary`）；派出 agent 的决定读摘要和次数当背景，但从不加强提示（「查一个文件」这类子任务不该因此判到最高一档）。发消息时带的是这条消息之前的次数（这条消息自己的结论要同一个请求的回答才知道），所以默认设置下第四次说「仍未解决」的那条消息的中途重判先读到强提示，下一条消息的请求再带上。每次给了强提示，决策日志记一条（次数、已给强提示、决策模型判出的档位），依据卡片显示「已给强提示」；看板不新增事件。`unresolved` 开关关着（默认）时这些都不带。
- **skill。** 主 agent 不再读完整的 skill 列表（装的 skill 多时这一段很长），读到的是一句固定的提示。改由决策模型在你发消息时，从本会话的 skill 里挑出相关的几个，连同名字、描述和相关度附在消息后面交给主 agent；只能由你触发的 skill 不推荐给主 agent，只在看板上提示你（「可试 /x」）。一轮进行中，主 agent 还可以用 `find_skill` 工具按几个词查 skill。skill 本身和 Skill 工具都不变，主 agent 仍然可以按名字加载任何 skill。
- **失败时放行。** 决策模型超时（`timeoutMs`）、出错、回答无法解析，或者没有配密钥时，消息照常进入，不额外等待，这一轮用会话自己的 effort，看板上写明原因，并弹一个 toast。

本文提到的配置项（例如 `escalateAfter`、`timeoutMs`），默认值都在「配置」的表里。每项功能都可以用 `/dp` 单独关掉，也可以整个 mod 一起关（见「控制：`/dp`」）。完整的行为规则（各种优先级、各种失败情形、看板和日志的写法）见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「它做什么」。

### 模型和 effort 的依据

模型的分工、往上取一档、中途的门槛和各模型的 effort 下限，都按 Artificial Analysis（AA）Intelligence Index v4.3.2 的十个分项校正过。几个要点：Sonnet 5.5 的分数随 effort 掉得很快（Terminal-Bench：low 20.7%、medium 29.8%、high 43.9%、max 63.6%；指数 36、41、47、56），所以低估 sonnet 的代价大；Opus 5.5 在 medium 就有 51；Sonnet 与 Opus 在终端、自动化、知识工作上持平或略高，拉开的是事实知识（Omniscience 32 对 46）、难推理（HLE 差 6.4）和科学代码（SciCode 差 5.9）；Haiku 4.5 在 Terminal-Bench 上是 0%。数字、来源和已存评测回答按新规则离线重算的结果见 [docs/research/aa-benchmarks-2026-10.md](../docs/research/aa-benchmarks-2026-10.md)。

### 看板

看板是 Dispatch Pilot 常驻的界面，只显示读数和结论，依据放在依据面板里。给人看的文字都是中文，模型名和 effort 档名照 `/model`、`/effort` 的写法。

- **prompt 上方的 band。** 一轮进行中，顶上一条状态条：第几轮、用时、agent 的运行 / 完成 / 失败 / 排队数、Workflow 的进度、中途重判的次数。下面每个 agent 一行：主 agent 在最前，其余按开始的先后，各带数字键（0 是主 agent，1 到 9 按先后）、名字、模型和 effort、状态，以及一条时间色带（同一根时间轴，看得出谁和谁并行）。状态格写运行或完成了多久、失败、排队，或者「未路由 · 原因」。再下面是这一轮的事件流：每个决定、中途重判和强制升档（一次改档只算一条，写从哪档到哪档）、skill 推荐和「可试 /x」、`find_skill` 的查询，以及请求失败、回答迟到。一轮结束后 band 折成一行：主 agent 的模型和 effort、这一档是怎么来的、「可试 /x」。引擎给 band 的行数不到 4 行时，退成一行摘要。
- **脚部右端的摘要。** 连同和左边隔开的一列，不超过 12 列：状态符号、主 agent 的模型和 effort、`+N` 个运行中的 agent；放不下时 effort 先写短（`xhi`），再省掉模型。
- **未路由。** 一轮或一个 agent 的模型和 effort 照引擎原样发出、没有经过 Dispatch Pilot 的决定，看板上总写原因：决策模型超时、连不上、繁忙、被限速、额度用完、密钥被拒绝、没配好、回答读不懂，或者功能已关。路由失败时还会弹一个 toast，写谁没路由和原因。
- **选中一个 agent。** 在空的 prompt 里按它的数字键，依据面板就打开在它的卡片上。
- **别的端。** Desktop 等不支持时间色带和概率条的端画同样内容的纯文字版：band 的每行没有时间色带，脚部是一个不超过 24 个字符的标签（同样连隔开的那一列算在内）。没在 Desktop 上亲眼看过。
- 关掉的功能（`/dp <功能> off`）的决定、事件和计数不出现在 band 和脚部；`/dp off` 时 band 上没有 Dispatch Pilot 的内容，脚部写 `○ dp 已关`。`claude -p` 没有界面，内容写进 debug log。

### 依据面板

`/dp` 打开依据面板，再输一次或按 `Esc` 关掉；`/dp log` 也是打开它。全屏且终端够宽时它停靠在对话右边（约 75 列），否则在 prompt 上方。面板窄时文字换行缩进，不截断。

- **顶部**（灰字）：每项功能的开关状态（名字加「开」或「关」，关着的用灰色，默认关的 `hook-block-failures` 也在内）、`/dp lock` 的锁定，以及本会话 skill 画像的情况（`skill 画像：保留 52 · 新写 3 · 失败 1`；写的过程中是「生成中 2/5」；停写时写原因；有失败时按 `f` 列出失败的 skill 和原因）。
- **依据卡片。** 「‹ 上一个 (p) / 下一个 › (n)」按 band 的顺序翻看 agent。卡片是选中 agent 的依据：状态；没路由时几个字的原因，再写失败的类型、决策模型、细节和去 debug log 哪里看；给它的模型（派出 agent 和 Workflow 里的 agent）和理由（主 agent 也有）；各档 effort 的概率；规则推演，从决策模型给的概率走到最终的 effort，每一步写它做了什么（最可能的一档、max 门槛、上取一档、模型下限、下限或强制升档）；结果。主 agent 的卡片还注明发消息时的置信度只记录、不参与选档，并列出这一轮的强制升档和每次中途重判（建议档、当前档、带门槛刻度的置信条，和结论：升档、降档、降档被拦、防抖中还差几步、保持）。卡片只画决定时存下的推演，从不重新计算。
- **决策日志。** 按轮分组，最新的一轮在前，每条带编号、结果（颜色和 ✔ · ⚠ ✘ 符号；每轮的标题按同样的符号计数）、模型和 effort、是哪项功能针对什么、各档概率和理由。每轮有一个字母键（从 `a` 起，跳过 `p`、`n`、`f`）折叠或展开，最新两轮默认展开。日志保留最近 20 轮、最多 300 条。
- 面板的按键只在面板拿到键盘时有用（`/dp` 打开时会拿键盘；在 band 上按数字键打开的不抢键盘，可以接着按别的数字）。面板没被放出来时（比如接着的端不放面板）会立即关掉，并说明原因（`/dp` 在回复里说，按数字键打开的弹一个 toast），这时用 `/dp log 10` 在对话里看。

### 发给决策模型的内容

- 你这条消息，加上之前最近的几条消息（最多 `contextMessages` 条，总长度不超过 `contextTokens`）。主 agent 的 effort 题单独发一个请求，能读到的最近对话比和 skill 推荐一起发时长得多（Jev 默认 24000 token，对 6000）；skill 推荐的请求和它并行发出，不增加等待。每条只有文字和调用过的工具名，**不包含文件内容和工具输出**。一轮中途重判时发的是这一轮最近几步（`rejudgeSteps`）的摘要：主 agent 写的文字、调用的工具和一句话结果，同样不含文件内容、写入的内容和工具输出。
- 问题摘要（写好之后，发消息时的 effort 请求里）：不超过 500 token，是 `summaryModel` 对你和主 agent 这个问题的转述，输入给它的内容先脱敏；它占 state 的预算，最近的对话让给它。
- 派出 agent 和 Workflow 里的 agent：主 agent 写给它的任务（`prompt`）、描述、agent 类型，加上你这一轮说的话。
- 打开 skill 推荐时：本会话每个 skill 的名字和画像（还没有画像的用描述），以及排在前面的几个 skill 的描述、画像和 SKILL.md 开头约 700 个字符。skill 画像由你自己的 Claude 登录写（模型是 `skillsProfileModel`），用你的用量，不经过决策模型的提供方。
- 发送前对常见的 secret 格式脱敏，替换成 `[REDACTED]`：各家的 API key 和 token、`password=...` 这类赋值、URL 里的密码、私钥和 JWT。
- 请求发往 TypeSafe（`api.typesafe.ai`）。
- 每次请求的结果和每个决定都写进 debug log（`claude --debug-file <路径>`），不进入会话。

### 开销

- **决策请求。** 评测里 800 个 effort 请求共 614,292 input token（平均约 770 个），Jev 约 0.026 美元。评测的上下文很短；Jev 的 state 现在最多约 6.7k token，一个这样的 effort 请求不到 0.0003 美元（Jev 只按输入计费，每百万 token 0.042 美元），带 skill 推荐的约 2.9 万 token，约 0.0012 美元。
- **skill 推荐。** 打开后，每条消息的第一个请求还带着本会话每个 skill 的名字和画像：111 个 skill 都写好画像时约 2.19 万 input token（不带画像约 8.6k）；第一段分到 0.1 以上的 skill 才会发第二个请求，约 1.3k。作为交换，隐藏 skill 列表每个会话省下约 6.6k input token（本机 66 个 skill 时实测），换成的提示只有 360 个字符。
- **skill 画像**用你自己的 Claude 登录写（模型是 `skillsProfileModel`），算在你的用量里：每份约 2k 输入和 200 输出 token，每个 SKILL.md 版本只写一次，每次会话开始最多写 `skillsProfilesPerSession` 份。
- **问题摘要**同样用你自己的 Claude 登录写（模型是 `summaryModel`），算在你的用量里：你本人的消息开始的每一轮结束后一次，输入是上一份摘要加这一轮（你的话、主 agent 的最终回复、工具汇总，各自截断），输出不超过 500 token。
- `claude plugin details dispatch-pilot@alex-mods`（2.1.289）显示 0 个组件、常驻开销约 0 token：它看不到 mod 在运行时附加和替换的内容。

## 要求

- **Claude Code 2.1.287 及以上**，mod 在 Claude Code 里默认启用。**测试用的是 Claude Code 2.1.291**（订阅登录，看板和依据面板在终端里看过）和 jev-1.13.0；缓存和评测的实测是在 2.1.289 上做的；跑 `eval/` 和 `scripts/` 里的 Node 脚本用的是 Node 26.5，用 mod 本身不需要 Node。
- **只支持 Claude Code 订阅**（ADR 0001，`docs/adr/0001-main-agent-effort-only-no-model-switch.md`）。Dispatch Pilot 每轮、每一步都改主 agent 的 effort，但从不改它的模型：换模型必然让 prompt cache 失效，而在订阅下，同一个模型内切换 effort 保留缓存（2.1.289 上 Opus 5.5 加订阅实测）。Bedrock、Vertex 和各种网关上切换 effort 会让缓存失效，不在支持范围内。Claude Code 的文档只点名了 Opus 5.5、Sonnet 5.5 和 Fable 5.1 保留缓存，其他大多数模型上每档 effort 各有一份缓存，切换会重算整段请求（见 `docs/research/decision-models-and-caching.md` 的 3.4）。
- **一个决策模型的账号。** 默认的决策模型是 pplx，要 Perplexity 的 API key（Decisions API）；Jev 要 TypeSafe 的 API key。没有 Perplexity 的 key、但有 TypeSafe 的 key 时，自动退回 Jev（0.3.1 的老用户升级后不会失去路由，依据面板的决策日志里会有一条说明原因）；两种 key 都没有时 mod 不发任何请求，每一轮都按会话自己的 effort 走，看板上写明缺的是 Perplexity 的 key。

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
```

想改 mod 或者试未发布的改动时，也可以从本地克隆添加：`claude plugin marketplace add ./claude-mods`（相对路径要以 `./` 或 `../` 开头，否则会被当成 GitHub 仓库）。从本地目录添加的 marketplace，Claude Code 直接从那个目录加载 mod，克隆里检出的是哪个版本，用的就是哪个版本。

在 shell 里装好的 mod，下次启动 Claude Code 时才加载：装好后重启 Claude Code，或者在已经开着的会话里运行 `/reload-plugins`。在会话里运行 `/plugin`，看到 `1 mod active · dispatch-pilot` 说明 mod 已经加载；运行 `/dp` 会打开依据面板，`/dp status` 列出各项功能的开关。接着给它一个决策模型的密钥。

**pplx（默认）。** 给它 Perplexity 的 API key，有两种给法，同时给了就用第 1 种：

1. 在 Claude Code 的会话里运行 `/plugin configure dispatch-pilot@alex-mods`，在弹出的配置对话框里填 `perplexityApiKey`；输入会被遮住。在会话里用 `/plugin` 安装时也会弹出这个对话框；在 shell 里用 `claude plugin install` 安装不会弹，装好后用这条命令，或者用 stdin 传进去（需要 `jq`）：

   ```bash
   read -rs PERPLEXITY_API_KEY && export PERPLEXITY_API_KEY   # 粘贴密钥后回车，不回显，值也不会留在 shell 历史里
   jq -n '{perplexityApiKey: env.PERPLEXITY_API_KEY}' | claude plugin configure dispatch-pilot@alex-mods --values-stdin
   ```

2. 设环境变量 `PERPLEXITY_API_KEY`（启动 Claude Code 的环境里要有）。Claude Code Desktop 读不到敏感的 userConfig（#35），用环境变量就绕开了这个问题。

**不要用 `claude plugin install --config perplexityApiKey=...` 传密钥，也不要用 `jq --arg`**：它们的值会出现在进程参数里，同一台机器上的 `ps` 看得到。

`--values-stdin` 读一个 JSON 对象，值都是单行字符串，没写到的选项保持原值。保存之后要重启 Claude Code 才生效，命令也会提示 `Configuration saved. Restart Claude Code to apply it.`。不带参数运行 `claude plugin configure dispatch-pilot@alex-mods` 会列出所有选项，并标出哪些还没有设置。

key 只放在请求头里，不会出现在 debug log、看板、依据面板和 `$.state` 里；会话开始时 debug log 只写 key 从哪里来（选项还是环境变量），不写 key 本身。

**Jev。** 想用 Jev，就把 `decisionModel` 设成 `jev`（在 `/config` 里选，或写进 `pluginConfigs`），再填 TypeSafe 的 API key `typesafeApiKey`，填法同上（配置对话框，或 stdin 的 JSON 里写 `typesafeApiKey`；环境变量 `TYPESAFE_API_KEY` 只用来放进 stdin，mod 本身不读它）。设成 `jev` 就始终用 Jev，哪怕也有 Perplexity 的 key。

**只有 TypeSafe 的 key 的老用户**不用改任何配置：`decisionModel` 没设（或设的是 `pplx`、已移除的 `clef`、拼错的值）又没有 Perplexity 的 key 时，用 Jev，每个会话的决策日志（`/dp` 打开的依据面板）里有一条「改用 Jev」写明原因。以后想换成 pplx，只要填上 Perplexity 的 key。

`decisionModel` 在 `/config` 里是下拉选择，有 `pplx`（默认）和 `jev` 两项；填了别的值（包括已移除的 `clef`），按没设处理，也就是默认的 pplx（没有 Perplexity 的 key 时按上面的规则退回 Jev）。

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

- **敏感项**（`typesafeApiKey`、`perplexityApiKey`）存进平台的安全凭据存储（Claude Code 文档的说法），输入时被遮住，不在 `/config` 里出现。用配置对话框（`/plugin configure dispatch-pilot@alex-mods`），或者 `claude plugin configure ... --values-stdin` 填，见「安装」。
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

选项留空就取决策模型的默认值：`timeoutMs`、`contextMessages`、`contextTokens`、`thetaMax`、`thetaUp`、`thetaDown`、`rejudgeSteps`、`rejudgeWaitMs`、`thetaExpected`、`agentOverride`、`skillsMinRelevance`、`findSkillMinRelevance` 这 12 项在 manifest 里没有默认值，所以 `/config` 里显示为空，你不设时 Dispatch Pilot 取表里你选的决策模型的那一列。你自己设了某一项，就用你设的值。会话开始时 debug log 会写一行哪些选项用了默认值。

另有几个值也随决策模型而定，但不是选项，`/config` 里改不了，也不在下面的表里：往上取一档的门槛（高一档的概率达到它，就往上取一档；Jev 是 0.3，pplx 是 0.45），问题怎么问（语言和题型：Jev 发消息时判 effort 的那一题用中文，其余所有问题用英文；pplx 所有问题都用英文；都是 Score），以及 `contextMessages` 的上限（Jev 是 32，pplx 是 2000）。它们和上面那些默认值一起写在 `core/setup.ts` 的 `BACKEND_DEFAULTS`，评测和 mod 读的是同一张表。依据卡片的规则推演里，「上取一档」一步写的就是这里的门槛。

**pplx 的默认值**（B′，ADR 0006，`docs/adr/0006-dispatch-pilot-pplx-default-decision-model.md`）：pplx 的窗口大得多，不受 Jev 那 32k 的限制，所以发消息时的 effort 题、中途重判、派出 agent 和 Workflow 的 state 各取 48000 token、最近 2000 条消息（由 token 预算截断，不是条数），skill 的两段排序（它们带着每个 skill 的画像）仍是 6000，因为 B′ 没有评测过 skill 题。它回答要几秒（eval v2 里 48000 token 的请求约 5 秒），所以发消息等 8000 毫秒（hook 自己的上限是 10 秒），中途重判和 `find_skill` 各等 6000 毫秒。所有问题都用英文问。`thetaMax` 0.47、`thetaUp` 0、`thetaDown` 0.55 和往上取一档的 0.45 是按已存的 pplx 回答离线定的（DEVELOPMENT.md 的「eval v2 的结果」）：0.45 让日常消息判高从 18.5% 降到 13.0%，max 的召回不变。`thetaExpected`、`agentOverride` 和两个相关度门槛没有为 pplx 校准过，沿用 Jev 的值。用户自己设的值总是优先。

**Jev 的默认值是按 Jev 的上下文上限配置的。** Jev 一个请求最多收 64k token，其中 state 加上最长的那一道题不能超过 32k。最长的题是发消息时 skill 推荐的第一段（111 个 skill 带画像时 Jev 计约 2.19 万 token），所以带 skill 题的请求（发消息时打开了 skill 推荐，以及 `find_skill` 的第一段）的 `contextTokens` 取 6000：state 最多约 6.7k（Jev 的计数），加上那一题约 28.6k，在 32k 的 90% 以内，整个请求在 64k 之内，而且这个值正好让每个 skill 的画像不被裁短。其余的请求没有这么长的题（最长的不到 700 token），所以按种类各取一个更大的值：关着 skill 推荐的发消息、中途重判（包括卡住时的）、派出 agent、一批 Workflow 调用，state 最多 24000（Jev 的计数约 26.7k，加上最长的题仍在 32k 的 90% 以内）。你自己设了 `contextTokens`，所有种类都用它，但每个种类各取它和自己的上限里较小的一个（设 16000 的话，带 skill 题的请求仍是 6000，其余是 16000）。`contextMessages` 和 `rejudgeSteps` 取 manifest 允许的最大值（32 条、16 步），让 token 预算而不是条数决定发多少，旧的消息、步骤放不下就整条丢掉。仍然只发文字和工具名，不发工具的输入和输出。这样配置是为了让 Jev 看到尽量多的信息；它没有评测过：评测用的是 4 条、2000 个 token、4 步，更多上下文是否真的判得更准没有数据，延迟见「局限和待评测」。计算过程见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「Jev 的上下文默认值怎么算」。

下表的 Jev 和 pplx 两列是各自的默认值。`起点`：这个默认值是暂定的起点，还没有评测数据支持。`按 Jev 的上限`：按上面的算法取 Jev 能接受的最大值，没有评测。`按 AA 基准`：按 Artificial Analysis 的基准校正过（见「模型和 effort 的依据」），没有在这套评测集上量过。没有标注的，是按测到的数据定的，或者本来就不需要校准。

### 决策模型和密钥

| 选项 | 作用 | Jev | pplx |
|---|---|---|---|
| `decisionModel` | 决策模型，在 `/config` 里是下拉选择：`pplx`（Perplexity 的 `pplx-decider-v1.1-27b`）或 `jev`（TypeSafe 的 Jev）。默认 `pplx`；填了别的值（包括已移除的 `clef`），按没设处理。设成 `jev` 就始终用 Jev；其他情况有 Perplexity 的 key 用 pplx，没有但有 TypeSafe 的 key 就退回 Jev（决策日志里记一条原因），两种都没有就不发请求 | `pplx` | `pplx` |
| `typesafeApiKey` | TypeSafe 的 API key，选 `jev` 时用；没有 Perplexity 的 key 时默认的 pplx 退回 Jev，用的也是它。敏感项 | `空` | `空` |
| `perplexityApiKey` | Perplexity 的 API key，默认的决策模型 pplx 用它。敏感项。为空时读环境变量 `PERPLEXITY_API_KEY`，两处都有就用这里的；Perplexity 和 TypeSafe 的 key 都没有时不发任何请求。key 只放在请求头里，不进日志、看板和 `$.state` | `空` | `空` |
| `pplxQps` | 每秒最多向 Perplexity 发几个请求（1–50），只对 `pplx` 有用，Jev 不受它限制。Tier 0 账户限 1 QPS，一条消息又发 2 到 3 个请求，所以超出的在 mod 里排队，发消息时的 effort 题最先发，排队的时间算进该请求自己的等待。遇到 429 时，剩余等待时间不少于 `Retry-After` 加约 5 秒就按 `Retry-After` 重试一次，不够就不经路由地放行，看板写「被限速」。升级了账户就调高 | `1` 仅 `pplx` 用 | `1` |

### 等多久，读多少

| 选项 | 作用 | Jev | pplx |
|---|---|---|---|
| `timeoutMs` | 一条消息等决策模型的最长时间（200–8000 毫秒），超过就不经路由地放行 | `1500` | `8000` |
| `contextMessages` | 随你的消息一起发的最近消息条数，从 0 到决策模型能接受的条数（Jev 是 32，pplx 是 2000）。两个模型都默认取上限，由 `contextTokens` 决定实际发多少 | `32` 按 Jev 的上限 | `2000` |
| `contextTokens` | 发给决策模型的 state 的 token 预算（100–16000，pplx 到 48000）：你的消息加上最近的消息，按发出去的样子数（连同字段名和转义），中英文按同一个尺度数，旧消息先丢。按请求的种类取：默认值带 skill 题的请求 6000，其余 Jev 24000、pplx 48000，包括发消息时单独发的 effort 请求（见上面）；你设了就每个种类取它和自己上限里较小的 | `6000` 按 Jev 的上限，其余种类 24000 | `6000`，其余种类 48000 |

### 一轮中的 effort

| 选项 | 作用 | Jev | pplx |
|---|---|---|---|
| `thetaMax` | 用 `max` 所需的最低概率（0–1）；发消息时、中途重判和派出 agent 的 effort 都用这个门槛 | `0.5` 起点 | `0.47` 按已存的评测回答校准 |
| `rejudgeEvery` | 一轮进行中每隔几步重判一次（0–50）；0 表示不按步数重判，派出 agent、启动 Workflow、加载 skill 时仍会重判 | `3` 起点 | `3` 起点 |
| `rejudgeSteps` | 重判时决策模型读到的最近步数（1–16）。Jev 取上限，由 `contextTokens` 决定实际发多少 | `16` 按 Jev 的上限 | `16` 同 Jev |
| `rejudgeWaitMs` | 重判的回答还没到时，下一步最多再等多久（0–8000 毫秒），然后沿用原来的 effort | `300` | `6000` |
| `thetaUp` | 中途升档所需的最低置信度（0–1） | `0.3` 按 AA 基准 | `0` 按已存的评测回答校准 |
| `thetaDown` | 中途降档所需的最低置信度（0–1，低于 `thetaUp` 时按 `thetaUp` 算），一次只降一档 | `0.55` 按已存的评测回答扫出 | `0.55` 同 Jev |
| `holdSteps` | 升档之后多少步之内不降档（0–50） | `5` 按 AA 基准 | `5` 按 AA 基准 |

### 卡住时强制升档

| 选项 | 作用 | Jev | pplx |
|---|---|---|---|
| `escalateAfter` | 计入的工具调用失败满几次就问决策模型并升档（1–20） | `2` 起点 | `2` 起点 |
| `escalateMode` | `one-level` 升一档，最高到 xhigh（决策模型自己有把握给更高时可以更高）；`max` 直接升到 max | `one-level` 起点 | `one-level` 起点 |
| `escalateLimit` | 一轮（或一个派出 agent）最多升几次（0–10）；每次升档后失败计数清零 | `2` 起点 | `2` 起点 |
| `thetaExpected` | 决策模型认为这些失败是预期内失败的概率达到多少就不升档（0–1） | `0.25` 起点 | `0.25` 沿用 Jev 的起点 |
| `escalateHaikuTo` | 失败的 haiku agent 接着用哪个模型做：`sonnet`、`opus`、`fable` 或完整的模型 id；留空表示不换。你为这个 agent 点名的模型和排除的模型优先 | `sonnet` | `sonnet` |

### 派出 agent 和 Workflow

| 选项 | 作用 | Jev | pplx |
|---|---|---|---|
| `agentFable` | 打开后，决策模型可以为派出 agent（包括 Workflow 里的）选 fable，fable 比 opus 贵；你自己点名 fable 时不受这个开关限制 | `false` | `false` |
| `agentOverride` | 主 agent 为派出的 agent 指定了模型时，决策模型的选择要达到这个置信度（0–1）才推翻它；Workflow 脚本里写了 `model` 时同样适用 | `0.6` 起点 | `0.6` 沿用 Jev 的起点 |
| `workflowMode` | `rewrite`：把决定写进脚本再运行；`return`：第一次提交被拒绝并附上逐个 agent 的推荐，让主 agent 自己写进去，同一个 Workflow 第二次提交直接放行 | `rewrite` | `rewrite` |

### skill

| 选项 | 作用 | Jev | pplx |
|---|---|---|---|
| `skillsMax` | 一条消息最多推荐几个 skill（0–10） | `3` | `3` |
| `skillsMinRelevance` | 推荐一个 skill 所需的最低相关度（0–1）：决策模型对「这个 skill 是否正好做这条消息要做的那种工作」回答「是」的概率 | `0.75` | `0.75` 沿用 Jev |
| `skillsShortlist` | 第二段补读 SKILL.md 开头、逐个判断的 skill 最多几个（1–10） | `4` 起点 | `4` 起点 |
| `skillsProfileModel` | 写 skill 画像的模型，写别名（`haiku`）或完整的模型 id。通过你的 Claude Code 登录调用，算在你的用量里；换了模型，所有画像重写 | `haiku` | `haiku` |
| `skillsProfilesPerSession` | 每次会话开始最多写几份还没有的画像（0–500）；0 表示不写 | `30` | `30` |
| `skillsAlwaysListed` | 一直留在主 agent 的 skill 列表里的 skill，写列表里的名字（同步来的 skill 带前缀，例如 `anthropic-skills:pdf`）。列表项，不在 `/config` 里 | `空` | `空` |
| `skillsNeverSuggested` | 从不推荐给主 agent、也不提示你的 skill，写法同上。它们照常安装，Skill 工具仍能按名字加载，`find_skill` 也不返回它们。列表项，不在 `/config` 里 | `空` | `空` |
| `findSkillMax` | `find_skill` 一次最多返回几个 skill（1–10） | `5` | `5` |
| `findSkillMinRelevance` | `find_skill` 返回一个 skill 所需的最低相关度（0–1），比推荐的门槛低：这是主 agent 主动问的，它会自己看描述再决定 | `0.5` 起点 | `0.5` 沿用 Jev 的起点 |

### 问题摘要

| 选项 | 作用 | Jev | pplx |
|---|---|---|---|
| `unresolvedMaxAfter` | 未解决次数达到它时，发消息时和中途重判时 effort 题的说明里多一条强提示（这项工作属于多次尝试都没解决的故障）；0 表示不给，只带摘要和次数，最大 10。强提示不写档位，不改 `pickEffort` 和 `thetaMax` | `3` 暂定 | `3` 暂定 |
| `summaryModel` | 在你本人的消息开始的那一轮结束后，在后台续写问题摘要的模型，写别名（`haiku`）或完整的模型 id。通过你的 Claude Code 登录调用，算在你的用量里；摘要是对话的转述，所以 `contextMessages` 为 0 或 `unresolved` 开关关着（默认）时不写 | `haiku` | `haiku` |

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
- 功能的开关是 `main-effort`、`unresolved`、`midturn-effort`、`dispatched-agents`、`workflow-agents`、`workflow-labels`、`escalation`、`skills`、`skill-profiles`、`find-skill` 和 `signals`；另有 `hook-block-failures`，打开后你自己的 settings hook 拦下的调用也算失败，参与强制升档。`unresolved` 和 `hook-block-failures` 默认关闭，其余默认开着。
- 开关保存下来，下次启动会话时还是你离开时的样子；只保存和默认值不同的开关，所以一个新增的功能默认开着。
- 锁定只在当前会话里有效，`/dp unlock` 或会话结束时解除。锁定期间决策照常进行并记录，不想为此等决策模型的话，用 `/dp main-effort off`。
- 依据面板的决策日志和 `/dp log N` 显示每项功能记录的决策：做了什么决定、针对哪条消息、理由（决策模型给出的各档概率和置信度）。同样的内容也写进 debug log，不进入对话。
- 信号（上下文占用、5 小时和 7 天限额的百分比、会话花费）每次变化时写一行进 debug log，只是记录，不参与任何决策；`/dp signals off` 可以停止记录。
- 暂时不想用就 `/dp off`；彻底停用就 `claude plugin disable dispatch-pilot@alex-mods`。

## 局限和待评测

**局限**

- **只支持 Claude Code 订阅**，见「要求」。
- **决策请求整体失败时，你排除的模型仍可能按主 agent 的指定启动。** 哪些模型被排除，是决策模型从你的话里读出来的，没有它的回答就无从知道；mod 不改用关键词去猜，免得把只是提到某个模型的话当成排除。这是有意的取舍。
- fork 出来的 agent（它总是用父 agent 的模型）和 agent team 的 teammate（它会长期存在、处理很多任务，派出时的一次判断看不到这些任务）不处理。
- **主 agent 在推荐漏掉时不会自己去用 `find_skill`。** 一条要写 PR 描述、却没有推荐 `pr` 的消息，有提示、没有提示、提示写得更主动，主 agent 都直接写了正文；被明确要求查时，它能找到 `find_skill` 并用上。所以漏掉的推荐，目前只靠发消息时的推荐。
- Jev 对同一个 key 的并发请求像是依次处理。Workflow 里 prompt 是数据的调用（fan-out）在 agent 启动时当场判断，几个 agent 几毫秒内一起启动，排在后面的可能超时，那些 agent 按引擎原样启动。
- **Jev 的请求比以前大，延迟会多一点。** 默认值把 Jev 的 state 放到最多约 6.7k token（带 skill 题的请求，`contextTokens` 6000），发消息时带 skill 推荐的请求最多约 2.9 万 token；其余种类的 state 最多 24000（约 2.67 万 token），中途重判、派出 agent 和关着 skill 推荐的发消息请求，满了的话比以前多约 2.4 万 token，按每 1k 约 13 毫秒外推，最多多约 0.3 秒（同样是外推，没有量过）。已有的实测：Jev 处理 2.19 万 token（skill 第一段，带全部画像）时 p50 约 560 毫秒、p90 约 615 毫秒；另一次整体偏慢的运行里，这一段 218 条中有 24 条（约 11%）超过 1500 毫秒，这些消息的决策整个超时，effort 也没有经过路由。按每多 1k token 约多 13 毫秒外推，现在的 state 再多约 80 毫秒，慢的时段超过 1500 毫秒的消息会比 11% 更多；这是外推，没有在新默认值上量过。如果看板上「决策模型超时」变多，可以把 `contextTokens` 调小（每少 1k 约快 13 毫秒），或者把 `timeoutMs` 调大；skill 那一题本身有 2.2 万 token，想去掉这部分延迟只能 `/dp skills off`。
- 大多数默认值是暂定的起点（表里标了 `起点`）：评测数据只够定下少数几项，其余的见下面的「还没有数据的事」。

**问题用什么语言写。** 选 pplx 时所有问题都用英文写（eval v2：pplx 英文问法更准）。选 Jev 时，发消息时判断主 agent effort 的那一个问题用中文写；其余问题（一轮中途重判、派出 agent、Workflow 里的 agent、卡住时的强制升档、skill 推荐和 `find_skill`）都用英文。依据是 `effort-submit` 在现在的问法上的对比（Jev，各 1 次）：用中文问，中文题 85.0%、英文题 89.0%；用英文问，79.0%、78.0%。同样的请求之前跑过 3 次，中文问法也都高约 8 个百分点。其余问题在现在的问法上没有中文问法的数据，所以都没有改。派出 agent 和 skill 的评测已经有中文问法的变体（`models-hint-zh`、`profiles-zh`），还没有运行。发消息时的请求里，中文的 effort 问题和英文的 skill 问题放在一起，这种混合的请求没有单独评测过。

**中文和英文的差距。** 门槛是中文准确率比英文低不超过 4 个百分点，正好低 4 个百分点也算通过。现在的配置（Jev，effort 用中文问）在 `effort-submit` 上那一次正好差 −4.0，同样的请求之前 3 次是 0、0、−1；而中文题的准确率比用英文问时高 6 个百分点。其余三套评测都在门槛之内（见「评测」），但都是改措辞之前测的。

**派出 agent 的模型文字按 AA 的基准重写，并用真实的 Jev 调过。** 重写后的第一次评测（`models-hint`，100 题中英各一遍）整体从 70%/68% 掉到 60%/58%（模型部分 82/81，effort 部分 64/62）。之后调了三轮文字和 sonnet 的 effort 下限（sonnet 从 high 降到 medium），最后一版是整体 69%/68%、模型部分 89%/91%、effort 部分 71%/71%，同一版重复一次是 69%/67%、89%/90%、71%/71%。和重写之前（70%/68%，85%/85%，74%/72%）比，模型部分更好，effort 部分低 3 到 1 个百分点：往上取一档和模型下限让偏高多了、gold 命中从 50%/48% 变成 44%/44%，因为数据集的 gold 是按「够用的最便宜档」标的，没有按 AA 重标。注意这三轮文字是对着这 100 题的错题调的，所以最后的模型部分是在调过的题上量的，对没见过的请求会低一些。逐轮的表、发消息和中途重判的真实对照在 [docs/research/aa-benchmarks-2026-10.md](../docs/research/aa-benchmarks-2026-10.md) 的第六节。

**问题的文字一改，评测就要重跑。** 发给决策模型的问题、指令和选项描述是被测的对象：改了哪一处，用到它的评测都要重跑，旧结果只能对照。中途重判的工具行和 `trouble` 变体、派出 agent 的 effort 问题和 Workflow 题的合并提问、skill 第一段拆成两题，这几处在评测之后改过，没有重跑，所以下面「评测」里这三套的数字只能当预览；`effort-submit` 的请求没有变。每处改动的清单见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「待评测」。

**还没有数据的事**（每一条的数字和依据见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「待评测」）：

- **上下文的范围。** 随消息发出的最近几条消息和 token 预算（2、4、8、16 条 × 1k–8k token）没有扫描：现有评测集的上下文太短，扫描测不出差别。Jev 的 `contextMessages`、`contextTokens`、`rejudgeSteps` 默认值是按 Jev 的上限算的（见「配置」），不是按准确率挑的：更多的上下文是不是让 Jev 判得更准、旧消息会不会干扰当前这条，都没有数据，各个门槛也是在 4 条、2000 个 token、4 步的设置上定的。
- **按语言分别定门槛。** 各个置信度门槛都是中英文共用一个值，没有按语言分别校准。
- **中途重判的默认值和写法。** `thetaUp` 0.3、`thetaDown` 0.75、`holdSteps` 5 是按 AA 的基准定的方向（升高容易、降低难），具体数值没有在评测集上扫过：真实的 Jev 评测（`en-score` 和 `zh-score`，和 0.2.1 的规则比）上，回答选出的档偏低少了 5.5 到 7.5 个百分点、准确率不降（+1 和 +4）；但中途重判后实际走的档（`sent`）偏低只少 2 到 6 个百分点，偏高多 6 到 8 个百分点，准确率在英文问法上降 6 个百分点、中文问法上持平，原因是 `thetaDown` 抬到 0.75 之后该降的一轮降不下来，见 [docs/research/aa-benchmarks-2026-10.md](../docs/research/aa-benchmarks-2026-10.md) 的第六节；`rejudgeEvery`、`rejudgeSteps` 的默认值仍是起点。这些都没有按语言分别校准；state 里放不放当前档位和计数、问题用英文还是中文，也没有结论。
- **「预期内失败」这一问的写法和门槛。** `thetaExpected` 的默认值来自 11 个手写场景的小实验，样本太小，只能当起点；`escalateMode`、`escalateAfter` 和 `escalateLimit` 没有评测方法，按使用体验调。
- **派出 agent 的门槛。** `agentOverride` 的默认值在两次 Jev 运行里都不是最好（0.4–0.5 时整题中文 +3、英文 +2 个百分点）；点名的门槛 0.5 偏低；`thetaMax` 取 0.3 比默认值好 1–2 个百分点。这几个默认值没有改。
- **Workflow agent 启动时当场判断的排队。** 一次启动很多个 prompt 是数据的 agent 时，排在后面的会等到超时。常见的 fan-out（几个到十几个 agent）有多少能在 `timeoutMs` 之内答上，还没有量过。
- **skill 推荐的门槛和准确率。** 带画像的线上设置，中文 79.8%、英文 83.5%，差 3.7 个百分点，在 4 个百分点的门槛之内。`skillsMinRelevance` 的默认值是在同一套题上挑的：0.7 和 0.8 下两次的差距都是 −3.7，默认值下是 −1.8 和 −2.8，相差只有 1–2 题（109 题里 1 题约 0.9 个百分点），在单次运行的波动之内，也没有在现在的问法上验证过。`skillsShortlist` 和第二段的下限 0.1、第一段拆成两题之后的新问法、用中文写问题、画像只用英文、Choice 选项的顺序对 Jev 的影响，都没有评测。
- **主 agent 会不会主动用 `find_skill`。** 见上面的局限。其他场景（文件格式、某个服务的工具、一轮中途才出现的需要）、其他模型，以及「每轮先查」这类更强的写法值不值得它多出的两步，还没有评测。
- **skill 请求的大小和延迟。** 带全部画像的第一段约 2.19 万 input token（111 个 skill，Jev 计），Jev 第一段 p50 0.56–0.67 秒，慢的时段 p90 到 1.65 秒。把第一段单独发、只留英文字段的裁剪画像，没有评测。
- **一个请求里放几个 Workflow 调用，准确率会不会降。** 一个脚本最多 8 个 `agent()` 共用一个请求，其他调用的说明对每个问题来说是无关内容，可能降低准确率。`subagent` 评测里有一个一个请求一个调用的对照变体，没有跑过。

## 评测

评测用真实的 Jev 测决策的准确率，脚本和数据在 `eval/`。每套评测集 100 题上下，中英文对照，答案经过审核；评测发出的请求和 mod 发出的逐字相同（测试核对）。

| 评测集 | 测什么 | 线上的问法，Jev（jev-1.13.0），中文 / 英文 |
|---|---|---|
| `effort-submit`（100 题） | 发消息时的 effort | 85.0% / 89.0%（中文问法，1 次运行；同样的请求之前 3 次的平均是 87.3% / 87.7%） |
| `effort-midturn`（100 题） | 一轮中途的 effort | 77% / 75%（`en-score`，0.2.3 的规则，2026-10-05）；0.2.2 是 77% / 72%，之前 73% / 74% |
| `subagent`（100 题） | 派出 agent 和 Workflow 里 agent 的模型加 effort，两样都对才算对 | 69% / 68%（`models-hint`，0.2.2 的文字和规则，2026-10-05，重复一次是 69% / 67%）；之前 70% / 68% |
| `skill`（109 题） | skill 推荐，带画像 | 79.8% / 83.5% |

- 中英差距的门槛是中文比英文低不超过 4 个百分点，正好低 4 个百分点也算通过。上面四行都在门槛之内：`effort-submit` 那一次正好是 −4.0，`skill` 是 −3.7。
- Jev 单个 effort 请求的延迟 p50 约 0.28–0.42 秒，p90 约 0.32–0.46 秒；skill 带画像的第一段 p50 约 0.56–0.67 秒。
- **`skill` 一行是 2026-10-04 测的**，之后问题改过措辞，没有重跑，只能当预览（见「局限和待评测」）；`effort-submit`、`effort-midturn` 的数字和 `subagent` 的 `models-hint` 是 2026-10-05 在 0.2.2 的规则和文字上重跑的（`subagent` 的其余变体没有重跑）。`subagent` 和 `skill` 的中文问法变体（`models-hint-zh`、`profiles-zh`）未运行。单次运行有波动：同一配置跑两次，单项准确率相差 0–4 个百分点，和 4 个百分点的门槛同一量级。评测的设置是 4 条消息、2000 个 token、4 步，不是 0.2.1 起 Jev 的默认值（32、6000、16）；评测集的上下文很短，离线重建请求核对过，换成新默认值后 `effort-submit` 的 200 个请求里 state 变了 2 个，`effort-midturn` 200 个里变了 10 个，`skill` 和 `subagent` 没有变，所以这些数字仍可以参考，但不是在新默认值上量的。

变体、指标、常数基线、门槛的离线重扫、已知的问题题和复现的命令，见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「评测（接缝 2）」。

## 开发

结构、扩展方式、测试写法、评测的做法和已经实测过的引擎行为，见 [DEVELOPMENT.md](DEVELOPMENT.md)。仓库通用的约定（mod 的结构、命令、编写约束）见 [CLAUDE.md](../CLAUDE.md)。
