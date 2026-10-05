# Dispatch Pilot：开发说明

这份文档给要改这个 mod 的人看。面向使用者的说明（用途、要求、安装、配置、`/dp` 命令）在 [README.md](README.md)，那里只留概要；完整的内容都在这里，各节的名字不变：

- 「它做什么」：每项功能的完整行为，README 里是它的概要。
- 「配置」：每个配置项的校准依据和说明；最新的默认值以 README 的配置表和 `.claude-plugin/plugin.json` 为准。
- 「待评测」：#17 的范围缩减说明，以及各项还没有数据的评测，完整版。
- 「开发」：结构、扩展方式、测试写法、评测，以及已经实测过的引擎行为。

下面第一段是各项功能和票号的对应。

Dispatch Pilot 在 Claude 之外调用一个决策模型（TypeSafe 的 Jev 或 Cloudflare Workers AI 的 Clef，在配置里二选一），替你决定 Claude Code 怎么干活。现阶段做三件事：**每次你发消息时，判断主 agent 这一轮该用哪档 effort**，并让这一轮的每一步都按这一档发出，一轮进行中还会每隔几步、以及在主 agent 派出 agent、启动 Workflow 或加载 skill 时重新判断（#5，见下文「一轮中途重新判断」）；**主 agent 每派出一个 agent，判断它该用哪个模型、哪档 effort**（#6）；**主 agent 提交 Workflow 时，对脚本里的每个 `agent()` 做同样的判断，并写进脚本**（#8，见下文「Workflow 里的 agent」）；脚本写不进去的（用 `scriptPath` 或 `name` 提交、恢复的运行、读不了的脚本或调用），**在每个 agent 启动时按它的 label 设置**（#9，见下文「Workflow 兜底：agent 启动时按 label 设置」）。主 agent 的模型从不改变，所以 prompt cache 不受影响（ADR 0001）：这只在 Claude Code 订阅下成立（同一模型内切换 effort 保留缓存，2.1.289 实测），所以 Dispatch Pilot 只面向订阅用户；Bedrock、Vertex 和各种网关上切换 effort 会让缓存失效，不在支持范围内。另外，主 agent 不再读完整的 skill 列表，改由决策模型在你发消息时挑出相关的几个 skill 推荐给它（#10，见下文「skill：隐藏列表，发消息时推荐」）：它先按每个 skill 的中英双语画像给 skill 排序（主 agent 能加载的一题，只能由你触发的另一题），再补读前几名的 SKILL.md 开头，逐个判断是否合适（#11）；一轮进行中，主 agent 还可以用 `find_skill` 工具按需查询 skill（#12，见下文「find_skill：主 agent 中途查询 skill」）。主 agent 或派出 agent 的工具调用接连失败时，Dispatch Pilot 会强制升档，除非这些失败本来就在意料之中（#7，见下文「卡住时强制升档」）。完整设计见 spec（issue #1）。用斜杠命令 `/dp` 可以开关整个 mod 或其中的单项功能、临时锁定 effort、查看最近的决策和理由（#13，见下文「控制：`/dp`」）。

测试环境：Claude Code 2.1.289（Opus 5.5，订阅登录）、Node 26.5、jev-1.13.0、Clef（Cloudflare Workers AI，2026-10-04）。

## 它做什么

- 你发出一条消息时（在终端输入、用 `claude -p`、通过 Remote Control 或 Slack，或由插件代你输入），Dispatch Pilot 把这条消息和最近几条对话发给决策模型（Jev 或 Clef），问它「这项工作需要多少逐步推理」。它给出 low、medium、high、xhigh、max 五档各自的概率。
- 取概率最高的一档，并列时取较高的一档。`max` 只在它自己的概率达到 `thetaMax` 时才使用，否则取其余四档中概率最高的一档。
- 这一轮的每个模型请求都按这一档发出。Claude Code 每一步都会把 effort 恢复成会话设置，所以每一步都要重新设置。模型按引擎给的原样发出，包括引擎过载时自动换用的模型。
- 一轮进行中你又发了一条消息：这条消息会在下一步送进当前这一轮，所以它的判断从下一步起接管这一轮。
- 不是你本人发的新消息（派出 agent 交回的结果、后台任务通知、其他会话的消息、插件自己发的消息）、斜杠命令和空消息都不判断，也不改变任何一轮的 effort。
- 派出 agent 见「派出 agent」一节，Workflow 里的 agent 见「Workflow 里的 agent」一节。

### 派出 agent

- 主 agent 用 Agent 工具派出一个 agent 时，Dispatch Pilot 在它启动前问一次决策模型，同一个请求里问两件事：它该用哪个模型（默认在 haiku、sonnet、opus 中选，打开 `agentFable` 后加入 fable），以及它的每一步该用哪档 effort。模型直接改在这次派发上；effort 在这个 agent 的每一步都重新设置。选了 haiku 就不设 effort（haiku 不支持）。
- 发给决策模型的是主 agent 写给这个 agent 的任务（`prompt`）、简短描述、agent 类型，以及你这一轮说的话：开始这一轮的那条消息，加上这一轮进行中你又发的消息。和发消息时一样，发送前对 secret 脱敏，总长度按 token 预算（`contextTokens`）截断，你的话最多占三分之一。
- 模型的优先级：
  1. 你在这一轮的消息里为这项工作点名的模型，一定照办，即使它不在可选范围内（例如没打开 `agentFable` 时点名 fable）。
  2. 否则用决策模型选的模型。
  3. 主 agent 自己指定了模型时，这个指定作为强提示交给决策模型；只有决策模型选了别的模型、而且置信度达到 `agentOverride`（默认 0.6）时才推翻，否则保留主 agent 的指定。
- effort 的优先级：你在这一轮的消息里为这项工作点名的 effort（「effort 开 low」「这次所有 agent 都用 high」），一定照办，也不会被推翻；否则用决策模型给的 effort（#6 的补丁，与点名模型同样对待）。点名了哪一档由决策模型判断（请求里的 `named_effort`：没有点名 / low / medium / high / xhigh / max，最可能的一档不是「没有点名」并且概率达到 `thetaNamed` 0.5 才算），不靠关键词匹配；只有消息里出现可能点名 effort 的字眼（effort、档位名、推理、思考、强度、拉满……；英文的 think、reason 太常用，只认 think hard、more reasoning、ultrathink 这样的说法）时才在请求里加这一题，只是为了省 token，判断仍交给决策模型。点名只管它说的那项工作，「这次所有 agent」管这一轮全部 agent。模型最后是 haiku 时 effort 无法设置：不设，并在 `/dp log` 里写明「要求了什么、为什么没设」。Workflow 里的 `agent()` 同样：点名的 effort 写进脚本，盖过脚本里写的 effort，也盖过脚本在运行时才算出来的 effort。
- 你在消息里排除的模型（例如「这周额度快用完了，别用 opus」）在任何情况下都不会成为 agent 启动的模型：不论决策模型是不确定、置信度低，还是把概率全给了被排除的那个模型，也不论主 agent 是否指定了它。决策模型在其余模型里最看好的那个会被选中；回答没有给其余模型任何概率时，选离它的选择最近的那个（并列取便宜的，置信度记 0），`/dp log` 里写明。只有整个决策请求失败（没有任何判断）时才照常放行，按主 agent 原来的要求启动：这时你排除的模型仍可能启动。这是有意的取舍：哪些模型被排除，是决策模型从你的话里读出来的，没有它的回答就无从知道；mod 不改用关键词去猜，以免把只是提到某个模型的话当成排除。
- 你点名的模型、点名的 effort 和排除的模型记进这个 agent 的计划（计划表 `agents` 的 `terms`），之后会改它模型或 effort 的功能都照办：卡住时强制升档不会把你点名的 haiku 换成 sonnet，不会换上你排除的模型（改换没被排除的上一档，都被排除就不换），也不会抬高你点名的 effort；核心每一步都按你点名的 effort 发出，不受升档的下限影响。Workflow 里的 agent 同样（见下两节）。
- 「点名」和「排除」都由决策模型结合上下文判断，而不是看消息里有没有模型名：模型名只是作为产品被讨论（「比较一下 haiku 和 sonnet」）、说的是之前写代码的模型、是否定说法（「别用 opus 了，用 haiku 就行」里的 opus），或者点名针对的是另一项工作（「调研那种活儿用 haiku，实现你看着办」之于实现的 agent），都不算为这个 agent 点名。消息里提到了哪个模型，请求里才问它是否被点名或排除。
- 只在派出时判断一次。一条消息里派出几个 agent，就逐个判断，每个拿到自己的回答就立刻放行，不互相等待。
- 不处理的 agent：fork 出来的 agent（它总是用父 agent 的模型）和 agent team 的 teammate（它会长期存在、处理很多任务，派出时的一次判断看不到这些任务）。
- 失败时放行：决策模型超时、出错或回答无法解析时，agent 按主 agent 原来的要求启动，用引擎自己的 effort，状态行写明原因。
- 每个决定都记进 `/dp log`：选了什么模型和 effort、是哪个 agent、理由（模型是谁定的、决策模型的选择和置信度、被排除的模型、effort 各档的概率）。`/dp dispatched-agents off` 单独关掉这项功能，之后派出的 agent 都按主 agent 原来的要求启动。

### Workflow 里的 agent

主 agent 用 `Workflow` 工具提交脚本时，Dispatch Pilot 在脚本运行之前，对脚本里的每个 `agent()` 调用点问一次决策模型：它该用哪个模型、哪档 effort（#8）。Workflow 里的 agent 不经过 Agent 工具（没有 `agent.spawn`），脚本是提前给它们定模型和 effort 的唯一位置，所以默认**直接把决定写进脚本**：工具运行的是改写后的脚本，写了什么、为什么，在工具结果后面告诉主 agent。

- **一个调用点判断一次。** 循环、`pipeline`、`parallel` 里的 `agent()` 会运行很多次，但它只有一个调用点，只判断一次，改写也写在这个调用点上。prompt 和 label 写成模板字符串（`` `migrate:${file}` ``）也行：决策模型看到的是模板原文，`${file}` 保持原样。
- **写法。** 决定的 `model` 和 `effort` 写进这个调用的选项对象：脚本已经写了字符串值的就原地替换，没写的加在最后一个属性后面，没有选项的调用补一个选项对象。脚本的其他部分逐字不变。选了 haiku 就不写 effort，脚本里已有的 effort 也会拿掉。
- **优先级和派出 agent 一致。** 你这一轮的消息里点名的模型 > 决策模型 > 脚本里已经写的 `model`（作为强提示交给决策模型，决策模型的选择达到 `agentOverride` 才推翻它）。脚本里的 `effort` 没有这条规则，用决策模型的；你点名的 effort 除外，它盖过脚本里写的 effort（见「派出 agent」）。脚本在运行时才算出来的 `model`（`model: pickModel()`）只有你没点名模型、也没排除任何模型时才不动：否则写进决定的模型（你点名的，或者没被排除的那个），你的约束优先于脚本；运行时才算出来的 `effort` 同样只有你没点名 effort 时才不动。你对每个调用的约束交给下面的兜底功能，写进这些 agent 的计划（见「派出 agent」）。
- **发给决策模型的内容**和派出 agent 一样：这个调用的 prompt、label、`agentType`，脚本 `meta` 里的 description，以及你这一轮的话，发送前脱敏，按 token 预算（`contextTokens`）截断。同一个脚本的几个调用放进同一个请求，每个调用有自己的 part（`agent-<n>`）和 state 字段（`brief_<n>`），`n` 是它在脚本里的序号（从 0 起），你的话只放一份。
- **调用多时分批。** 一个请求最多 64 个问题（Clef 的限制）、最多 8 个调用，各调用的 brief 加起来不超过 `contextTokens`，所以调用多时分成几个请求，同时发出，每个调用只问一次。一个脚本最多问 24 个调用、4 个请求，超出的调用保持脚本里写的样子，并告诉主 agent。分成几个请求时，等决策模型的时间按请求数放大（`timeoutMs` 乘请求数，最多 8000 毫秒），因为同一个 key 的并发请求可能排队。
- **读不了的调用保持原样。** prompt 不是字符串或模板（`agent(q.prompt)`、`agent(buildPrompt(x))`，也就是在数组上 `map` 出来的那种写法）时看不到任务内容，不问决策模型；模板里除了 `${...}` 自己没有几个字（不到约 6 个 token，例如 `` `${CONTEXT}\n\n${l.prompt}` ``：共用的上下文加上表里的一行）也一样，因为这样的 prompt 没说要做什么；不带占位符的短 prompt 就是完整的任务，照常判断。选项不是对象字面量（`agent('x', opts)`）也不改。读不了的脚本（没有 `meta` 块，引号、模板或括号不成对）整个放行。这些调用的 agent 在启动时由兜底功能判断（#9，见下一节）。
- **告诉主 agent。** 工具结果后面附一段说明（引擎把它显示为 `tool.call hook additional context`，只有模型看得到）：逐个调用写了哪个模型和 effort、依据，以及哪些调用保持原样。工具返回的脚本文件（`Script file:`）就是改写后的那一份，主 agent 之后用 `scriptPath` 重跑，改写还在。
- **失败时放行。** 决策模型超时、出错或回答不完整时，这个请求里的调用保持原样，状态行写明原因；这个功能自己出错时，整个脚本照原样运行。改写后的脚本如果被工具判为语法错误（工具在启动任何 agent 之前检查），就改用主 agent 原来的脚本再提交一次，并告诉主 agent。
- **不改写的输入。** 用 `scriptPath` 或 `name` 提交的脚本（这里读不到内容，由 #9 在 agent 启动时设置）；带 `resumeFromRunId` 恢复的运行（缓存按每个 `agent()` 的 prompt 和选项匹配，改写会让已完成的 agent 重跑；#9 在 agent 启动时设置，不动脚本，所以缓存照样命中）；没有 `agent()` 的脚本。
- **退回模式**（配置 `workflowMode`，默认 `rewrite`；选 `return`）：不改写，拒绝这次提交，把逐个调用的决定写成给主 agent 的改写说明：要加什么选项，并说明这是路由插件的策略、是你设的。主 agent 照着改好再提交，这第二次提交直接放行，不再问决策模型。「同一个 Workflow」按脚本 `meta.name` 和各调用的 prompt 判断，主 agent 只加选项不影响它；退回过的 Workflow 记在 `$.state`（最近 16 个）。没有要写的（脚本已经是对的）、决策模型没答、读不了的脚本，都不退回。
- **每个决定记进 `/dp log`**，每个调用一条，例如 `sonnet medium for "rename" (workflow tidy-api): decided; pick sonnet, confidence 0.70; effort p ...`；退回模式的决定后面加 `(sent back)`。`/dp workflow-agents off` 单独关掉这项功能，之后 Workflow 照主 agent 写的运行。

### Workflow 兜底：agent 启动时按 label 设置

上一节的改写只能用在主 agent 直接交来、读得懂的脚本上。其余情况（#9）不改脚本，而是在每个 agent 启动时，在它自己的请求上设置模型和 effort：

- **处理哪些运行。** 用 `scriptPath` 或 `name` 提交的脚本、带 `resumeFromRunId` 恢复的运行（运行时设置不改 `agent()` 的 prompt 和选项，缓存照样命中）、读不了的脚本，以及上一节留下的调用（prompt 是数据，例如 `agent(q.prompt, { label: q.label })`；或者超出 24 个的调用）。上一节写进脚本的调用不再处理；它没答上的调用（决策模型失败）照样保持原样，不再问第二次。两项功能的开关互相独立：`/dp workflow-agents off` 时，直接交来的脚本里读得懂的调用照主 agent 写的运行，读不了的仍由这里在 agent 启动时判断。
- **运行开始时。** Workflow 工具启动运行之后，读这次运行用的脚本：工具结果的 `scriptPath`（`scriptPath` 提交的就是那个文件；`name` 提交的是引擎解析好、存在会话目录里的那一份，所以项目、个人、插件和内置的命名 workflow 都一样处理）。能读懂的调用，用和上一节相同的请求逐个判断（同一个调用点判断一次）。
- **agent 启动时。** 每个 agent 的第一步发出之前，读这次运行的 `journal.jsonl`，找到这个 agent 的 label，再找到它是哪个 `agent()` 调用：字符串 label 按原文；模板 label（`` `migrate:${file}` ``）要求模板自己的文字都在、`${...}` 处可以是任何内容；不写 label 的调用，引擎把 prompt 的开头记成 label（空白折叠成一个空格、截到 60 个字符，实测），就按 prompt 的开头认；label 在运行时才算出来的调用，只在其他调用都对不上时才算。找到的调用在运行开始时已经判断过，就用它的决定；它的 prompt 是数据、两个调用用了同一个 label 却决定不同、对不上任何调用，或者整个脚本读不了，就用这个 agent 实际收到的任务（它的 transcript 第一条消息）当场问决策模型，请求和上一节一个调用的请求相同。
- **设置什么。** 模型、effort 和你对这项工作的约束（`terms`）写进计划表（`agents[agentId]`），核心在这个 agent 的每一步都照写。模型写引擎认得的完整 ID（`claude-haiku-4-5`、`claude-sonnet-5-5`、`claude-opus-5-5`、`claude-fable-5-1`）：`turn.step` 不解析别名，写 `haiku` 会让 agent 以 404 失败（实测）。agent 本来就在决定的模型家族上时不改模型，只改 effort；换到 haiku 的 agent 每一步都不带 effort（haiku 不收，引擎给的也拿掉）；从 haiku 换到别的模型的 agent，引擎按 haiku 算没给 effort，核心按计划补上。脚本在运行时才算出来的 `model` 或 `effort` 的处理和上一节相同（你点名或排除模型时以你的为准）。上一节已经写进脚本的调用，它们的 agent 启动时只把你的约束写进计划（上一节把约束按 Workflow 调用的 `tool_use_id` 放在 `$.state` 的 `workflowTerms` 交过来）。
- **等待。** agent 启动时它的任务还没写到磁盘上，引擎在 50–110 毫秒后写入（实测），所以当场判断的 agent 第一步最多等 400 毫秒，再加一次决策请求的时间；运行开始时已经判断过的 agent 不等。运行的第一个 agent 可能在工具调用处理完之前就启动（实测相差 1–10 毫秒），这时它等运行开始时的判断完成。一个 agent 的第一步最多等 9 秒（hook 自己的时间上限是 10 秒）。
- **常驻提示。** Workflow 工具的描述后面附一段固定的话，请主 agent 给每个 `agent()` 写固定且唯一的 label（对每一项都运行的调用，写固定前缀加这一项，例如 `` `audit:${file}` ``）。引擎在会话里第一次给出工具描述时问一次，之后一直沿用，所以文字固定，不影响 prompt cache；只在配置了决策模型、`workflow-labels` 开着时附上。
- **告诉主 agent。** 工具结果后面附一段说明：运行开始时每个调用定了什么、哪些调用在 agent 启动时再判断；读不了的脚本说明每个 agent 都在启动时判断。主 agent 直接交来的脚本，上一节已经说明了写进去的调用，这里只补一句：保持原样的调用由 agent 启动时判断。
- **失败时放行。** 决策模型失败或超时、任务没有及时写到磁盘、或者这个功能自己出错时，agent 按引擎原样启动，状态行写明原因。
- **状态行和日志。** 状态行的 `by label:` 一段写最近一个运行里按 label 设置的 agent 数，例如 `by label: routed 3 agents`；有没设置成的写成 `by label: routed 2 agents (1 not: jev: no answer in 1500 ms)` 或 `by label: not routed (task not on disk in time)`。运行开始时判断过的调用、启动时当场判断的 agent，各记一条进 `/dp log` 和 debug log，例如 `opus high for "q-license" (agent a25d..., workflow e2e-labels): from its task as it started; decided; pick opus, ...`。`/dp workflow-labels off` 单独关掉这项功能。
- **限制。** 当场判断是一个 agent 一个请求。一次启动很多个 prompt 是数据的 agent 时（fan-out），这些请求同时发给决策模型，而 Jev 对同一个 key 的并发请求像是依次处理，排在后面的可能超时，那些 agent 按引擎原样启动。强制升档（#7）按计划表里的有效模型判断（计划的 `model`，没有才看引擎的）：被换成 haiku 的 agent 卡住时换模型，从 haiku 换走的照常升 effort。

### 一轮中途重新判断

- 一轮进行中，每到第 N 步（`rejudgeEvery`，默认 3，即第 3、6、9……步，从 0 数），以及主 agent 派出 agent、启动 Workflow 或加载 skill 时，Dispatch Pilot 再问一次决策模型：剩下的工作还需要多少逐步推理。只判断 effort，不推荐 skill。
- 问题在主 agent 的工具开始执行时就发出，工具运行期间得到回答，下一步发出前取用，所以一般不增加等待。回答还没到时，下一步最多再等 `rejudgeWaitMs`（默认 300 毫秒）；仍然没有就沿用上一步的 effort，状态行注明 `(late)`，这个回答到了以后用在再下一步。请求失败时同样沿用，状态行写明原因。
- 防抖：升档要求决策模型的置信度不低于 `thetaUp`；降档要求不低于 `thetaDown`（更高的门槛），而且每次只降一档；升档后 `holdSteps` 步之内不降档（中途重判的升档和卡住时的强制升档都算）；用 `max` 仍要它自己的概率达到 `thetaMax`。
- 决策模型读到的是：这一轮你的消息，即将发出的是第几步，当前的 effort，这一轮的计数（判断次数、档位变化次数、失败的工具调用数、被 hook 拦截的次数），以及最近几步（`rejudgeSteps`，默认 4）的摘要。每一步的摘要是主 agent 在那一步最后写的文字，加上它调用的工具和一句话结果，结果以「成功：」「失败：」「被 hook 拦截：」「用户拒绝：」开头（你的消息不含中文时用 `Success:`、`Failed:`、`Blocked by hook:`、`Denied by user:`），正在运行的那个工具写「进行中：」。结果后面只说明这次调用在做什么：调用自带的 `description`、skill 或 Workflow 的名字、文件路径的最后两段、搜索的 pattern 或 query、URL，或者 shell 命令的第一行。**不包含文件内容、工具写入的内容和工具输出**；同样脱敏，同样受 `contextTokens` 限制（你的消息最多占一半）。
- 这些情况不重判：你用 `/dp lock` 锁定了 effort；这一轮不是你本人的消息开始的（agent 交回的结果、后台任务通知等），整轮都用会话自己的 effort；`main-effort` 关着（这时发消息不经过它，也认不出这一轮是你开始的）；没有配置决策模型；模型不接受 effort 档位（haiku 这类）。你本人的消息开始的一轮，即使发消息时那次判断失败（出错或超时），也照常中途重判，从会话自己的 effort 起算。`/dp midturn-effort off` 关掉这项功能。
- 这一轮第一次重判之后，状态行多出一段，例如 `dp effort xhigh | steps 7, judged 3, changed 1`：已经发出的步数、这一轮的判断次数（包括发消息时的那一次）、档位变化的次数。
- 每次重判都记进 debug log 和 `/dp log`，例如 `#5 midturn-effort: effort xhigh (was medium) for step 3 (every 3 steps): p low 0.00, medium 0.05, high 0.15, xhigh 0.70, max 0.10; confidence 0.80; up`。
- 在 Sonnet 5.5 上也照常重判：实测一轮中途改 effort 不会返回 400（见「开发」里的「已实测的引擎行为」）。

### 卡住时强制升档

- **记什么。** 主 agent 和它派出的每个 agent（包括 Workflow 里的），工具调用出错一次记一次。**你自己拒绝的调用从不算**。被你自己的 settings hook 拦下的调用，只有打开 `/dp hook-block-failures on` 才算失败（默认关闭，免得你的 PreToolUse hook 正常拦截时误触发升档）。不管开关，状态行都显示失败次数和被 hook 拦下的次数。这是唯一的一份失败计数：中途重判发给决策模型的 `counts` 也用它，两边都是「自上次清零以来」的数（强制升档、判为预期内、没有可升的而清零）。`/dp escalation off` 只停升档，计数照常（中途重判还要用）；再打开时，关着期间记下的失败清零，从打开起重新算。
- **什么时候问。** 一个循环（主 agent 的这一轮，或一个派出 agent）里计入的失败满 `escalateAfter` 次（默认 2），**在那个失败的调用一结束时**就问决策模型（故事 18），它的下一步只取回答：回答还没到时最多再等 `rejudgeWaitMs`（默认 300 毫秒），仍然没有就照原样发出这一步、状态行注明 `(late)`，回答到了以后在再下一步生效，和中途重判一样。同一个请求里问两件事：剩下的工作还需要多少逐步推理（和中途重判是同一个问题，带上「卡住」的说明，见上文），以及这些失败是不是**预期内的**：TDD 里先写下、要看它红的测试，没找到东西而以非零退出的搜索，探测某样东西是否存在的命令。「预期内」由决策模型结合你的消息和最近几步判断，不靠关键词匹配；回答的概率达到 `thetaExpected`（默认 0.25）就算预期内。发出的内容和别的决策请求一样：只有文字和工具名，加上每个调用做了什么（`description`、文件路径的最后两段、命令的第一行），不含工具输出，脱敏，受 `contextTokens` 限制。最近几步取自对话的记录（主 agent 的，或这个 agent 自己的；Workflow 里的 agent 的记录引擎不给 mod 读，就读它在运行目录里的 `agent-<agentId>.jsonl`），所以一个 agent 的任务和它做过的事决策模型都看得到。
- **预期内。** 不强制升档，失败计数清零，这次回答里的 effort 按普通的中途重判规则处理（`thetaUp`、`thetaDown`、`holdSteps`）：主 agent 改这一轮的 effort，派出 agent 改它自己的 effort。
- **否则**（包括决策模型超时、出错、没回答这个问题：不知道是不是预期内，就当不是）：强制升档，升档后失败计数清零。
  - **主 agent**：这一轮从这一步起至少升一档（`escalateMode` 是 `one-level` 时最高到 xhigh，是 `max` 时直接升到 max），之后 `holdSteps` 步之内不会被中途重判降到这一档以下，过了这几步照常防抖。决策模型自己给的判断更高、而且有足够把握（`thetaUp`）时，采用它的（强制的下限最高到 xhigh，决策模型自己的判断要到 max 仍须过 `thetaMax`）。一轮最多升 `escalateLimit` 次（默认 2），之后失败照常记、状态行照常显示，但不再升。
  - **派出 agent**：按它在计划表里的有效模型处理（兜底功能换过的模型算数）。它的 effort 升上去之后一直保持到它结束（派出 agent 没有中途重判），其余同上。**haiku 没有 effort 可升**，所以改用 `escalateHaikuTo`（默认 `sonnet`）接着做：写别名或完整的模型 id 都可以，mod 会换成步骤需要的完整 id（实测引擎对每一步的模型不认别名，`sonnet` 会让这个 agent 以 `model_not_found` 提前结束）；写的不是任何已知模型时不换，并记一条决策。换模型之后引擎仍然按 haiku 算、不给这个 agent 的步骤带 effort，所以 sonnet 先用自己的默认档；再卡住时从 medium（引擎给 agent 步骤的默认档，实测）往上升，核心把升到的档位补进每一步。换模型只影响这个 agent 自己的缓存。haiku agent 只问「是不是预期内」，不问 effort。
  - **你的约束优先**：你为这个 agent 点名了 haiku，就不换模型；你排除了 `escalateHaikuTo` 的模型，就换成没被排除的上一档（只在 agent 可用的模型里选），都被排除就不换；你点名了 effort，就不升。这几种情况都不问决策模型，失败计数清零，记一条决策说明原因。
  - 已经到顶（`one-level` 的 xhigh，`max` 的 max）：没有可升的，不问决策模型，失败计数清零，记一条决策。
- **不动的情况。** 你用 `/dp lock` 锁定了 effort（锁定优先）；没有配置决策模型；主 agent 这一步的模型不接受 effort 档位。主 agent 这一轮开始时没有经过路由（决策失败）也照样升：升的是会话自己的 effort。Workflow 里的 agent 的记录要从它的运行目录读，运行目录由兜底功能（`workflow-labels`）在运行开始时记下；这项功能关着时读不到，这样的 agent 只升、不问是不是预期内。
- **状态行。** 主 agent 这一轮的计数在 `midturn` 那一段后面，例如 `dp effort high | steps 5, judged 3, changed 1 | failed 2, blocked 1, raised 1`（`blocked` 是被 hook 拦下的次数，`raised` 是强制升档的次数，回答迟到时后面加 `(late)`）；最近一个有失败的派出 agent 的计数跟在 `agent` 那一段后面，例如 `agent sonnet medium | agent failed 2, raised 1`。新的一轮从零开始。
- **记录。** 每次强制升档、「预期内失败、没有升档」和「已经到顶」都记进 `/dp log` 和 debug log，例如 `#4 escalation: effort high (was medium) for step 2 (2 failed tool calls): forced one level up; not expected (p 0.05, thetaExpected 0.25); p low 0.00, medium 1.00, ...`。`/dp escalation off` 单独关掉这项功能；`/dp hook-block-failures on` 让被 hook 拦下的调用也算失败。

### 失败时放行

如果决策模型超时（默认：Jev 1.5 秒，Clef 3 秒）、出错、回答无法解析，或者没有配置 key（Clef 是 account ID 和 token），消息照常进入，不会额外等待，这一轮使用会话自己的 effort。状态行会写明原因，例如 `dp effort xhigh (not routed) | jev: no answer in 1500 ms`、`dp effort xhigh (not routed) | clef: key refused (HTTP 401)`。选了其中一个就只用它，失败时不会改用另一个。Clef 的免费额度当天用完时写 `clef: daily quota used up`（Cloudflare 的错误码 3036），和一时繁忙的 `clef: busy (HTTP 429)`（错误码 3040）区分开：两者的 HTTP 状态都是 429。

### 状态行

状态行只有一行，例如 `dp effort high`。`(not routed)` 表示这一轮没有经过路由，用的是会话自己的 effort；`(locked)` 表示你用 `/dp lock` 锁定了 effort；`dp off` 表示你用 `/dp off` 关掉了整个 mod。本仓库约定界面里只用单宽字符，而中文是双宽字符，所以状态行用英文。`claude -p` 模式没有状态行，内容会写进 debug log。

派出 agent 后，状态行后面会加一段，显示最近一个派出 agent 的模型和 effort，例如 `dp effort high | agent sonnet high`。`(you)` 表示模型是你点名的，`(kept)` 表示保留了主 agent 的指定，`(effort: you)` 表示 effort 是你点名的；`agent not routed (jev: no answer in 1500 ms)` 表示这个 agent 没有经过路由，括号里是原因。出过错的工具调用的计数（`failed 2, blocked 1, raised 1`）见「卡住时强制升档」。

提交 Workflow 后，状态行再加一段，写最近一个 Workflow 的处理结果：`workflow routed 3 agents` 是三个调用已判断、决定写进了脚本；有调用保持原样时写成 `workflow routed 2 agents (1 as written)`，请求失败的话后面跟原因（`(1 as written: jev: HTTP 500)`）；一个调用也没判断时写 `workflow not routed (...)`，括号里是原因，例如 `jev: no answer in 1500 ms`、`its prompt is built when the script runs`、`given by path`、`given by name`、`resumed from an earlier run`、`script not readable`；退回模式写 `workflow sent back (2 agents)`。

Workflow 的 agent 启动时按 label 设置之后（#9），后面再加一段，写最近一个运行里设置了几个 agent：`by label: routed 3 agents`；有没设置成的，括号里写个数和原因（`by label: routed 2 agents (1 not: jev: HTTP 500)`），一个也没设置成时写 `by label: not routed (...)`。所以用 `scriptPath` 提交的 Workflow 常见的整行是 `dp effort high | workflow not routed (given by path) | by label: routed 3 agents`：前一段说脚本没有改写，后一段说 agent 启动时设置了。

### 发给决策模型的内容

- `user_message` 是你这条消息。`recent_context` 是之前最近的几条消息，同一方连续写的几行算作一条。每条只有文字和调用过的工具名（例如 `[tools: Read, Bash (failed)]`），**不包含文件内容和工具输出**。
- 发送前会对常见的 secret 格式脱敏，替换成 `[REDACTED]`。覆盖的格式包括各家的 API key 和 token、`password=...` 这类赋值、URL 里的密码、私钥和 JWT。
- 总长度按 token 预算（`contextTokens`）截断，数的是发出去的整个 state：序列化成 JSON 的样子，字段名、引号和转义都算。中文约 1 个字算 1 个 token，其他文字约 4 个字符算 1 个 token，因此中英文按同一个尺度截断。预算先保证你的消息，剩下的分给最近的消息：旧消息整条丢弃，最新一条放不下时保留开头和结尾。
- 每次请求的结果和每次决定都写进 debug log（`claude --debug-file <path>`），不会进入对话。
- skill 推荐打开时，同一个请求里还有本会话每个 skill 的名字和画像（还没有画像的用描述）；需要第二个请求时，它带着排在前面的几个 skill 的描述、画像和 SKILL.md 正文的开头（约 700 个英文字符，先脱敏），见下一节。画像本身由你自己的 Claude 登录生成（`skillsProfileModel`），不经过决策模型的提供方。

### skill：隐藏列表，发消息时推荐

Claude Code 在会话开始时把所有 skill 的名字和描述作为一条附件（`skill_listing`）交给主 agent，装的 skill 多时这一段很长：本机 66 个 skill，实测每个会话多出约 6.6k input token。Dispatch Pilot 对主 agent 拦下这条附件（ADR 0002），换成一句固定的提示，改为在你每次发消息时推荐相关的几个：

- **推荐分两段。** 第一段和 effort 在同一个决策请求里，多问一个问题：在本会话主 agent 能加载的 skill 中，加上「都不合适」，哪个最适合这条消息要做的工作？装了只能由你本人触发的 skill 时，再单独问一题同样的问题（它们放在一题里会和能加载的 skill 互相抢概率）。每个 skill 用它的画像描述（见下一条），还没有画像的用描述。每题的概率在它的选项之间加起来为 1，只用来排序。第一段分到 0.1 以上的 skill 里，能加载的最多取前 `skillsShortlist` 个（默认 4），只能由你触发的最多取 2 个，一起进入第二段：再发一个请求，问的是同样的消息和对话，补上每个 skill 的 SKILL.md 正文开头，对每个 skill 单独问「它是否正好做这条消息要做的那种工作」，回答的概率（0 到 1）就是相关度，是绝对值，几个 skill 可以同时很高，也可以都很低。相关度不低于 `skillsMinRelevance`（默认 0.75）的 skill，最多 `skillsMax` 个，按相关度从高到低写成一个文字块附在消息后面交给主 agent，内容是名字、相关度和描述。主 agent 用 Skill 工具按名字加载，也可以不理会。没有合适的就不附任何东西；第一段没有哪个 skill 到 0.1 时不发第二个请求。
- **两个请求共用一次等待。** 消息最多等 `timeoutMs`：第二个请求只能用第一个请求剩下的时间。第二个请求超时或失败时，这条消息不推荐 skill，照常进入，状态行写明原因，例如 `skills not rated (jev: no answer in 1100 ms)`；effort 的判断不受影响。实测（真实引擎、Jev）第一段约 0.3–0.5 秒，第二段约 0.26 秒，合计在 1.5 秒之内。
- **中英双语的 skill 画像。** 会话开始时，Dispatch Pilot 在后台让一个便宜的模型（`skillsProfileModel`，默认 haiku，通过你自己的 Claude Code 登录调用，算在你的用量里）读每个 skill 的 SKILL.md，写一份简短的画像：做什么、什么时候用、什么时候不用，英文和中文各一份。这样中文消息也能对上英文描述的 skill，「什么时候不用」还能挡掉似是而非的匹配。画像按 SKILL.md 的内容（以及模型名、提示词版本）做哈希，存在 `$.store` 里，下次会话直接用；SKILL.md 改了才重写。每次会话开始最多写 `skillsProfilesPerSession` 份（默认 30，0 表示不写），其余留给以后的会话，第一次装了很多 skill 时不会一下子花掉很多用量。写的过程不阻塞你的消息：写好一份用一份，还没写好或写失败的 skill 用名字和描述。没有 SKILL.md 的 skill（内置 skill）从描述写画像。每份画像的每个字段都有长度上限，最多保留 500 份、合计最多 2 MiB（超过任何一个，就删掉最早写的、本会话不用的，删到 400 份以内、1.5 MiB 以内），在 `$.store` 4 MiB 的总上限里通常只占几百 KB。`/dp skill-profiles off` 停止写画像，并改回只用名字和描述排序。实测 haiku 写一份约 2.2–2.6 秒、约 2k 输入和 200 输出 token。
- **已经推荐过的只再提名字。** 同一段对话里描述过一次的 skill，再推荐时只写名字和相关度。`/compact` 和 `/clear` 之后重新给描述。
- **只能由你触发的 skill**（SKILL.md 的 frontmatter 写了 `disable-model-invocation: true`）从不推荐给主 agent，Skill 工具也加载不了它们。合适时状态行提示你自己输入，例如 `try /grill-me`。settings 的 `skillOverrides` 设成 `off` 的 skill 不提示。
- **列表的位置上是一句固定的提示。** 主 agent 读到的不是空白，而是：`Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it. For any other skill, call the find_skill tool (mcp__dispatch-pilot__find_skill; load it with ToolSearch first if it is deferred) with a few words on the work, then load a skill it returns with the Skill tool by its exact name.` 也就是：skill 不再列出；和消息相关的会随消息推荐；需要别的 skill 时用 `find_skill` 按几个词查找，再用 Skill 工具按名字加载。写出 `find_skill` 的全名、提到 ToolSearch，是因为它是延迟加载的工具，加载之前主 agent 只看得到名字。`skillsAlwaysListed` 里的 skill 照旧留在列表里，提示跟在它们后面。提示不含任何 skill 的名字或数量，每次问到都一字不差，不破坏 prompt cache（360 个字符，本机原来的列表 18,397 个）。实测它并不能让主 agent 主动去查 skill（见「开发」里的「已实测的引擎行为」）。
- **`find-skill` 关掉时，提示不提 `find_skill`**，最后一句换成 `...; load one, or any skill you know, with the Skill tool by its exact name.`。用哪一句，看的是引擎问到列表那一刻 `find-skill` 开关的状态。引擎在整段对话里沿用这个回答，对话中途调用 `$.ui.invalidate` 也不会重问（已实测），所以**对话中途切换 `find-skill`，提示要到下一段对话（`/clear` 或新会话）才跟着变**；`/compact` 之后引擎不再问列表（#10 实测），提示既不会变，也不会重发。这期间工具本身按当前的开关回答：中途关掉后，主 agent 照提示去调用，会得到「已关闭」的回答，不发请求；中途打开后，下一段对话之前，主 agent 只能从延迟加载的工具名里看到它。
- **主 agent 仍然可以按名字加载任何 skill。** 隐藏的只是列表，skill 本身和 Skill 工具不变（已实测，包括 `anthropic-skills:` 开头的同步 skill）。`skillsAlwaysListed` 里的 skill 留在列表里，推荐到它们时只写名字。派出 agent 和 Workflow 里的 agent 的列表不动。
- **什么时候不隐藏。** 没有配置决策模型（Jev 没有 key，Clef 缺 account ID 或 token）、读不到本会话的 skill、没有一个能推荐的 skill（主 agent 能加载的一个都没有，或者都在 `skillsNeverSuggested` 里），或者 skill 推荐被关掉时（选 Clef 时它默认就是关的，见下一条），主 agent 照常读完整的列表。没有能推荐的 skill 时，只能由你触发的 skill 照样会在状态行提示。
- **开关。** `/dp skills off`（以及 `/dp off`）停止推荐，并把列表还给主 agent：之后引擎再问到的列表原样放行；这段对话里已经被拦下的列表（引擎在整段对话里沿用当时的回答），随你的下一条消息作为附件补给主 agent，只补一次，`/compact` 之后再补一次。`/dp skills on` 恢复推荐；已经还给主 agent 的列表留在这段对话里，下一段对话（`/clear` 或新会话）起才重新隐藏。这个开关的默认值看决策模型：选 Jev 时打开；选 Clef 时关闭，因为 Clef 带画像的第一段要 3.7–7.9 秒（#16 实测），超过一条消息能等的时间。选 Clef 时用 `/dp skills on` 打开（和别的开关一样会记住）。`find_skill` 不跟这个开关走，照样注册、照样回答；选 Clef 时它自己的等待和第一段另有规定，见下一节。
- **状态行和日志。** 状态行写出这条消息推荐的 skill 和给你的提示，例如 `dp effort high | skills tdd, code-review | try /grill-me`。每次推荐都记进决策日志（`/dp log`）和 debug log，写出第一段排在前面的 skill 和它们分到的概率、第二段每个 skill 的相关度，例如（第一段拆成两题之前的一次实测）`suggested code-review for "帮我审一下这个分支相对 main 的改动": first code-review 1.00, none 0.00; fits code-review 0.96; suggested from 0.70, at most 3`。装了只能由你触发的 skill 时，`first` 之后还有一段 `hint`，写那一题排在前面的 skill 和概率，例如 `first none 1.00; hint grill-me 0.40, none 0.60; fits grill-me 0.93`。会话开始时 debug log 写一行画像的情况（`skill profiles: 3 kept, 84 to write with haiku (at most 30 this session)`），每写好一份再写一行。

### find_skill：主 agent 中途查询 skill

推荐只在你发消息时做一次。一轮进行中，主 agent 发现手头的工作可能有合适的 skill（例如要处理某种文件格式、用某个服务的工具，或者按某种流程审查、规划、发布），可以调用 `find_skill` 工具，用几个词说明要做的工作：

- **同一套排序。** 请求和发消息时推荐用的是同一个排序入口、同样的两段（同样的画像、同样的第二段补读），第一段问的是发消息时那一题主 agent 能加载的 skill，一字不差（只能由你触发的 skill 在发消息时另有一题，这里不问），最近的对话也按同样的规则截取（`contextMessages`、`contextTokens`，不含文件内容和工具输出，先脱敏）；只是 `user_message` 换成主 agent 写的查询，第一段只问 skill，不问 effort。两个请求共用一次等待：第二个只能用第一个剩下的时间。
- **按决策模型等多久、第一段带不带画像。** 选 Jev 时和发消息时一样：两个请求合计等 `timeoutMs`，第一段带画像。选 Clef 时合计最多等 8000 毫秒（不看 `timeoutMs`），第一段只用描述，第二段照样带画像：Clef 带全部画像的第一段要 3.7–7.9 秒（#16，111 个 skill），只用描述约 8.6k token，按 #17 探针里 8.8k 的请求约 1.7–2.4 秒，第二段 0.5–0.8 秒，都在 8000 毫秒之内。这两个值写在 `core/setup.ts` 的 `BACKEND_DEFAULTS`（`findSkillWaitMs`、`findSkillProfiles`），按延迟定，没有校准，不是配置项。hook 自己的时间上限是 10 秒，只算它自己的代码和 `$.clock.sleep`，不算 `next` 和别的 `$` 调用（mods reference 的 Limits 一节；生成的类型里是 `HookBudget`），后端的超时正是用 `$.clock.sleep` 计的，所以 8000 毫秒给其余的代码留出了余量。选 Clef 而发消息时的推荐关着（默认）时，画像不写（`skill-profiles` 只在 `skills` 开着时写），所以不会为没人读的画像花用量；用 `/dp skills on` 打开推荐后才写，写好的画像供发消息时的推荐和 `find_skill` 的第二段用。
- **返回什么。** 相关度（第二段的绝对值）不低于 `findSkillMinRelevance`（默认 0.5，比推荐的门槛低：这是主 agent 主动问的，它会自己看描述再决定）的 skill，最多 `findSkillMax` 个，按相关度从高到低，每个写名字（Skill 工具接受的写法，同步来的 skill 带 `anthropic-skills:` 前缀）、相关度和描述。主 agent 再用 Skill 工具按名字加载。都不够相关时，回答没有合适的 skill，并提示主 agent 不用 skill 继续，或者按名字加载它已知的 skill。
- **只在被调用时回答。** 一轮中途不会主动推送 skill；结果只作为这次工具调用的回答交给主 agent。
- **不返回的 skill。** 只能由你本人触发的 skill 和 `skillsNeverSuggested` 里的 skill 既不问也不返回。派出 agent 调用时，工具让它从自己的 skill 列表里挑（派出 agent 的列表没有隐藏），不发请求。
- **不影响缓存。** 工具在会话开始时注册（只在配置了决策模型时），描述固定不变，不含任何会话内容。实测它是延迟加载的工具：主 agent 的工具列表里先只有它的名字，用 ToolSearch 加载之后才调用。主 agent 的 skill 列表换成的那句提示写出了它的全名，并说明要先用 ToolSearch 加载（见上一节）。
- **开关。** `/dp find-skill off`（以及 `/dp off`）之后，工具仍然注册着，调用时只回答它已关闭、可以用 `/dp find-skill on` 打开，不发请求；列表位置上的提示也不再提它，从下一段对话起生效（见上一节）。它和 skill 推荐的开关 `skills` 互相独立：推荐关掉时 `find_skill` 仍然回答（会话开始没有读 skill 目录的话，第一次调用时再读）。
- **失败时放行。** 决策模型超时、出错、回答里没有 skill 问题（两个请求中任何一个），读不到本会话的 skill，或者 mod 自己出错时，工具都立即回答失败的原因，并提示主 agent 不用 skill 继续，或者按名字加载已知的 skill。状态行写明原因，例如 `find_skill failed (jev: no answer in 1500 ms)`。
- **状态行和日志。** 状态行显示最近一次查询返回的 skill，例如 `dp effort high | find_skill pr`，没有合适的写 `find_skill none`。每次查询的两个请求都写进 debug log，结果记进决策日志（`/dp log`）和 debug log，例如 `found code-review for "review a branch before merging": first code-review 1.00, none 0.00; fits code-review 0.95; returned from 0.50, at most 5`。

### 控制：`/dp`

```
/dp                    是否开启、effort 的锁定状态、各项功能的开关
/dp on | off           总开关。关闭后不发任何决策请求，每一步都按引擎原样发出（锁定也不生效），状态行写 dp off
/dp <功能> on | off    单项功能的开关，例如 /dp main-effort off（功能名见 /dp 的列表）
/dp lock <档位>        把主 agent 的 effort 锁在 low、medium、high、xhigh 或 max，这一轮的每一步和之后的每一轮都用它，优先于决策
/dp unlock             解除锁定（也可以写 /dp lock off）
/dp log [N]            最近 N 次决策和理由，最新的在最后（默认 10，最多 50）
```

- 命令在一轮进行中也立即执行：锁定或解锁从下一步起生效。
- 开关保存在 `$.store`，下次启动会话时还是你离开时的样子；只保存和默认值不同的开关，所以一个新增的功能默认开着。几个会话同时在用时，改动不会覆盖别的会话刚保存的开关，但已经在运行的会话要到下次启动才会读到。
- 锁定只在当前会话里有效，`/dp unlock` 或会话结束时解除。锁定期间决策照常进行并记录（锁定优先），不想为此等决策模型的话，用 `/dp main-effort off`。
- `/dp log` 显示每项功能记录的决策：做了什么决定、针对哪条消息、理由（决策模型给出的各档概率和置信度，被 `thetaMax` 压下的 `max` 会注明）。同样的内容也写进 debug log。
- 会话的读数（上下文占用、5 小时和 7 天限额的百分比、会话花费）每次变化时写一行进 debug log，例如 `signals: context 3% (28866/1000000 tokens); limits five_hour 26% resets ..., seven_day 50% resets ...; cost $0.1433; changed context, rateLimits, cost`。这些读数只是记录，不参与任何决策，留给以后设计「省额度模式」用；`/dp signals off` 可以停止记录。

## 配置

这一节是 README 配置表改版之前的完整说明，留着每个选项的校准依据；默认值以 README 的配置表为准（`node dispatch-pilot/eval/validate.ts docs` 核对它和 manifest、`BACKEND_DEFAULTS` 一致）。

在 `/config` 里设置，或写在 settings 的 `pluginConfigs` 里：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `decisionModel` | `jev` | 决策模型：`jev`（TypeSafe）或 `clef`（Cloudflare Workers AI），在 `/config` 里是下拉选择。选了一个就只用它，没有备用。填了这两个之外的值，引擎会按默认值 `jev` 处理并给出警告。 |
| `typesafeApiKey` | 空 | 选 `jev` 时用：TypeSafe 的 API key，是敏感字段，保存在安全存储里。为空时不发送任何请求。 |
| `cloudflareAccountId` | 空 | 选 `clef` 时用：运行 Workers AI 的 Cloudflare account ID，是敏感字段。为空时不发送任何请求。它是请求地址的一部分，Claude Code 自己的 debug log 会记下请求地址，所以会出现在那里；mod 自己写的日志行会把它遮掉。 |
| `cloudflareApiToken` | 空 | 选 `clef` 时用：能调用 Workers AI 的 Cloudflare API token（控制台里 Workers AI，Use REST API，Create a Workers AI API Token），是敏感字段。为空时不发送任何请求。 |
| `timeoutMs` | Jev 1500，Clef 3000 | 等待决策模型的最长时间，范围 200–8000 毫秒。Clef 比 Jev 慢：连接建立后 0.6–1.4 秒，冷连接的第一次请求 1.8 秒（见「待评测」）。 |
| `contextMessages` | 4（Clef 未校准，暂沿用 Jev 的值） | 随你的消息一起发送的最近消息条数，范围 0–32。 |
| `contextTokens` | 2000（两个决策模型相同） | 发给决策模型的 state 的 token 预算，范围 100–16000：你的消息加上最近对话，按发出去的样子数（整个 state 序列化成 JSON，连同字段名、引号和转义）。**选 Clef 时最多 2000**，设得更大也按 2000 算：Clef 有时只读序列化后 state 开头约 2.1k 个 token（#17 的探针，见「待评测」），而它序列化时按键名排序，哪个字段在前不由 mod 决定，所以整个 state 都要在截断位置之内。 |
| `thetaMax` | 0.5（Clef 未校准，暂沿用 Jev 的值） | 使用 `max` 所需的最低概率，范围 0–1。发消息时、一轮中途和派出 agent（包括 Workflow 里的）的 effort 都用这个门槛。 |
| `rejudgeEvery` | 3 | 一轮进行中每到第几步重新判断一次，范围 0–50；0 表示不按步数重判（派出 agent、启动 Workflow、加载 skill 时仍会重判）。 |
| `rejudgeSteps` | 4（Clef 未校准，暂沿用 Jev 的值） | 重判时决策模型读到的最近步数，范围 1–16。 |
| `rejudgeWaitMs` | 300 | 重判的回答还没到时，下一步最多再等多久，范围 0–2000 毫秒。 |
| `thetaUp` | 0.4（Clef 未校准，暂沿用 Jev 的值） | 中途升档所需的最低置信度，范围 0–1。Clef 的 confidence 比 Jev 低得多（#14：中位数 0.24 对 0.66），这个值下 Clef 很少改档。 |
| `thetaDown` | 0.6（Clef 未校准，暂沿用 Jev 的值） | 中途降档所需的最低置信度，范围 0–1；低于 `thetaUp` 时按 `thetaUp` 算。 |
| `holdSteps` | 3 | 中途升档之后，多少步之内不降档，范围 0–50。 |
| `escalateAfter` | 2 | 一个循环（主 agent 的一轮，或一个派出 agent）里计入的失败满几次，就问决策模型并强制升档（除非是预期内的），范围 1–20。 |
| `escalateMode` | `one-level` | 强制升档的方式，在 `/config` 里是下拉选择：`one-level` 升一档，最高到 xhigh（决策模型自己有把握给更高时可以更高）；`max` 直接升到 max。 |
| `escalateLimit` | 2 | 一轮（或一个派出 agent）最多强制升档几次，范围 0–10；升档后失败计数清零。 |
| `thetaExpected` | 0.25（Clef 未校准，暂沿用 Jev 的值） | 决策模型认为这些失败「是预期内的」的概率达到多少，就不强制升档，范围 0–1。故意定得低：在几个手写的例子上，Jev 对预期内失败的评分是 0.15–0.72，对真的卡住的是 0.09–0.16（Clef：0.27–0.90 和 0.03–0.11）。暂定，见「待评测」。 |
| `escalateHaikuTo` | `sonnet` | 失败的 haiku agent 接着用哪个模型做。haiku 没有 effort 可升。写别名（`sonnet`、`opus`、`fable`）或完整的模型 id；别名由 mod 换成步骤需要的完整 id（`decision/model-ids.ts`，引擎对每一步的模型不认别名），不是已知模型的值不换。你为这个 agent 点名的模型和排除的模型优先。留空表示不换。 |
| `agentFable` | 关 | 打开后，派出 agent（包括 Workflow 里的）的可选模型加入 fable（比 opus 更贵）。你自己点名 fable 时不受这个开关限制。 |
| `agentOverride` | 0.6（Clef 未校准，暂沿用 Jev 的值） | 主 agent 为派出的 agent 指定了模型时，决策模型的选择要达到这个置信度才推翻它，范围 0–1。Workflow 脚本里的 `agent()` 写了 `model` 时同样适用。 |
| `skillsMax` | 3 | 一条消息最多推荐几个 skill，范围 0–10。 |
| `skillsMinRelevance` | 0.75（Clef 未校准，暂沿用 Jev 的值） | 推荐一个 skill 所需的最低相关度，范围 0–1。相关度是第二段里决策模型对「这个 skill 是否正好做这条消息要做的那种工作」回答「是」的概率，每个 skill 单独判断（#11 起；#10 用的是第一段里分到的概率）。0.75 来自 #16 的两次 Jev 运行（第 1 轮审查修复之前的问法）：从 0.7 改成 0.75，带画像时的中英差距从 −3.7 缩到 −2.3 个百分点（两次的均值；−1.8 和 −2.8）。这个值是在同一套题上挑的：0.7 和 0.8 下两次都是 −3.67，和 0.75 只差 1–2 题（109 题里 1 题约 0.9 个百分点），在单次运行的波动之内，也没有在新问法上验证。按当时 3 个百分点的门槛只有它通过；按现在 4 个百分点的门槛，0.7、0.75、0.8 都通过。默认值没有改。 |
| `skillsShortlist` | 4 | 第二段补读正文、逐个判断的、主 agent 能加载的 skill 最多几个（第一段那一题排在最前、分到 0.1 以上的），范围 1–10。只能由你触发的 skill 另外最多 2 个。 |
| `skillsProfileModel` | `haiku` | 写 skill 画像的模型，写别名（`haiku`）或完整的模型 id。通过你的 Claude Code 登录调用，算在你的用量里。换了模型，所有画像会重写。 |
| `skillsProfilesPerSession` | 30 | 每次会话开始时最多写几份还没有的画像，范围 0–500；0 表示不写（已有的照常用）。 |
| `skillsAlwaysListed` | 空 | 一直留在主 agent 的 skill 列表里的 skill，写列表里的名字（同步来的 skill 要带前缀，例如 `anthropic-skills:pdf`）。 |
| `skillsNeverSuggested` | 空 | 从不推荐给主 agent、也不提示你的 skill，同样写列表里的名字。它们照常安装，Skill 工具照样能按名字加载。`find_skill` 也不返回它们。 |
| `findSkillMax` | 5 | `find_skill` 一次最多返回几个 skill，范围 1–10。 |
| `findSkillMinRelevance` | 0.5（Clef 未校准，暂沿用 Jev 的值） | `find_skill` 返回一个 skill 所需的最低相关度，范围 0–1。相关度的含义和 `skillsMinRelevance` 相同。 |
| `workflowMode` | `rewrite` | Workflow 里的 agent 怎么路由：`rewrite` 把决定写进脚本再运行；`return` 第一次提交被拒绝并附上逐个 agent 的推荐，让主 agent 自己写进去，同一个 Workflow 第二次提交直接放行（见「Workflow 里的 agent」）。在 `/config` 里是下拉选择。 |

**按决策模型取的默认值（#17）。** 上表里这 11 项（`timeoutMs`、`contextMessages`、`contextTokens`、`rejudgeSteps`、`thetaUp`、`thetaDown`、`thetaMax`、`thetaExpected`、`agentOverride`、`skillsMinRelevance`、`findSkillMinRelevance`），默认值取决于你选的决策模型。它们在 manifest 里没有默认值，所以 `/config` 里显示为空，你不设时引擎什么也不传（kit 的测试和真实引擎都确认过），Dispatch Pilot 按 `decisionModel` 取默认值。只有这几处因为 Clef 实测过而不同：`timeoutMs`（Clef 3000），`contextTokens` 的上限（Clef 2000），发消息时的 skill 推荐（选 Clef 时默认关闭，见「skill：隐藏列表，发消息时推荐」的「开关」），以及 `find_skill` 的等待和第一段（选 Clef 时合计最多 8000 毫秒、第一段只用描述，见「find_skill：主 agent 中途查询 skill」；这两个不是配置项）；另外发消息时 effort 问题的语言也按决策模型取（Jev 用中文，Clef 用英文，不是配置项，依据见「待评测」）。其余各项 Clef 还没有校准，暂沿用 Jev 的值。你自己设了某一项，两个决策模型都用你设的值（`contextTokens` 在 Clef 下最多 2000）。会话开始时 debug log 写一行哪些选项用了默认值，例如 `settings for clef: left unset, so clef's defaults: timeoutMs 3000, ...; skill suggestions off until /dp skills on; contextTokens 4000 reads as 2000, the most with clef`。

这些默认值大多是暂定的。按用户的决定（2026-10-05），#17 没有再跑对比或扫描评测：Jev 的默认值保持原样，只有 `skillsMinRelevance` 按 #16 已有的数据改成 0.75；中途重判的几项（`rejudgeEvery` 到 `holdSteps`）、`agentOverride`、`thetaMax`、`findSkillMinRelevance`、`skillsShortlist`、`escalateAfter`、`escalateMode`、`escalateLimit` 和 `thetaExpected` 都还是起点，现有的数据和没做的评测见「待评测」。

## 待评测

**按用户的决定（2026-10-05），#17 不再跑任何对比或扫描评测。** 用户的原话：「那我觉得我们没有必要再跑任何对比测试了 但是我们仍然要做clef接入 提供给有需要的人 我们自己就用jev即可」。所以 Clef 只保留接入，下面列的事大多仍然没有数据；#17 只做了不花钱的收尾（按决策模型取默认值、`skillsMinRelevance` 改成 0.75、文档）和之前已经跑完的 Clef 截断探针。#17 各验收项的状态：

- 上下文范围扫描（最近 2、4、8、16 步 × 1k、2k、4k、8k token）：没有做。现有评测集的上下文太短，扫描几乎测不出差别（16 格 × 4 套的 13,088 个请求里只有 1,226 个不同），要做就得先补长上下文的题，补充集也按用户的决定取消了。默认值保持 Jev 4 条 × 2000 token；Clef 按截断的结论定为 2000（并且最多 2000）。
- Jev 和 Clef 各一套默认值、写回 mod 的配置：已做（见「配置」里「按决策模型取的默认值」）。Clef 实测过的几处不同，其余暂沿用 Jev 的值。
- 置信度门槛按语言分别校准：没有做。
- 问题用英文还是中文写：**已改，只改了一个问题。** 用户在现在的问法（代码基点 9ec9c42）上跑了一次 effort-submit 的对比（`results/effort-submit/2026-10-05-jev-ac4-question-language.json`，Jev，`zh-score` 和 `en-score` 各 1 次，400 个请求，0.0126 美元）：用中文问，中文题 85.0%、英文题 89.0%（差距 −4.0）；用英文问，79.0%、78.0%（差距 +1.0）；两种问法的 p50 都是 282 ms，没有迟到或重试的回答。这次的请求和 2026-10-04 的 3 次运行逐字相同，那 3 次里中文问法也都高约 8 个百分点，方向一致。按事先说好的规则（中文问法领先 3 个百分点以上就改），Jev 在发消息时判断 effort 的那一个问题改用中文（`core/setup.ts` 的 `BACKEND_DEFAULTS` 里的 `turnStartLanguage`，不是配置项）。只改这一个，因为其余问题（中途重判、派出 agent、Workflow、卡住时的强制升档、skill 和 `find_skill`）在现在的问法上都没有中文问法的数据：一轮中途的两种语言在旧问法上持平，派出 agent 和 skill 没有中文变体。Clef 没有任何中文问法的数据，全部保持英文。同一个请求里，中文的 effort 问题和英文的 skill 问题混在一起，这种情况没有测过：effort-submit 只单问 effort。
- 验证 Clef 是否截断 state：已做，会截断，但时有时无（见下面的「Clef 截断 state」）。
- 中文准确率比英文低多少算通过：**门槛改成 4 个百分点**（用户 2026-10-05 的决定；原来的 spec 写的是 3 个百分点）：中文比英文低不超过 4 个百分点就算通过，正好低 4.0 也通过（`eval/lib/metrics.ts` 的 `MAX_GAP`、`passes`）。发布的配置（Jev，effort 用中文问）在 effort-submit 上那一次的差距是 −4.0，按新门槛通过；同样的请求在 2026-10-04 的 3 次运行里是 0、0、−1；而中文题的准确率比用英文问时高 6 个百分点（85 对 79）。其余几套都是改措辞之前的问法上的离线数据：一轮中途 `en-score` −1 和 +3，派出 agent `models-hint` +2 到 +3（中文高），skill 带画像时在 `skillsMinRelevance` 0.75 下 −1.8 和 −2.8，按新门槛都通过（0.7 下的 −3.7 也通过）。`en-choice` 的 −3.0 按新门槛也通过。已存结果的 `pass` 都按新门槛离线重算过（`eval/resummarize.ts`）。
- 需要真实密钥、会产生少量费用：Clef 截断探针两轮合计约 0.036 美元（Clef 约 0.034 美元，Jev 对照约 0.002 美元）；问题语言的对比 0.0126 美元。

**问题的文字一改，评测就要重跑。** 发给决策模型的问题、指令和选项描述（`hooks/decision/` 里的那些文字）是被测的对象：改了哪一处，用到它的评测都要重跑，旧结果只能对照，不能当成新问法的数字。结果文件记着每个变体当时问的问题（`questions`）和代码的哈希（`code`），和现在的对不上，就是过期的结果。第 1 轮审查改了下面这些；按用户的决定，修复之后没有重跑，「开发」里「评测」一节的数字都是修复之前的问法测得的，只能当预览：

- `effort-midturn`：每个调用的那一行改成 mod 的写法（不再带评测集里「结果如何」的部分），`trouble` 变体改用 #7 的 `stuckRequest`（多了「是不是预期内」一题）；所有变体都变了，新加了 `raw-results` 作对照。
- `subagent`：effort 问题里的「子 agent」「subagent」改成「派出的 agent」「dispatched agent」；点名 effort 一题不再被英文里随口说的 think、reason 触发；Workflow 的题按 #8 的方式合并提问，新加了 `models-hint-single`。
- `skill`：第一段拆成两题（`skills.which` 只问主 agent 能加载的，`skills.hint` 只问只能由你触发的），第二段的短名单两类分开取。
- `effort-submit`：请求没变（2026-10-05 的问题语言对比就是在现在的代码上跑的，请求和 2026-10-04 的逐字相同）。通过与否的规则先改成中文比英文低不到 3 个百分点，2026-10-05 又按用户的决定改成低不超过 4 个百分点（正好 4.0 也通过）；已存结果的 `pass` 已按 4 个百分点重算。线上的问法从 2026-10-05 起是 Jev 用 `zh-score`、Clef 用 `en-score`（`modVariant`）。

还没有数据的事（#17 按用户的决定没有再测；要不要开后续票由用户决定）：

- **中途重判的默认值和写法。** `thetaUp` 0.4、`thetaDown` 0.6、`holdSteps` 3、`rejudgeEvery` 3、`rejudgeSteps` 4 都是起点（参考了 jev-pilot 实测的升档 0.3/0.5、降档 0.6），按语言分别校准。state 里放不放当前档位和计数、问题用英文还是中文，都是评测变量（见「开发」里的「中途重判」）。`rejudgeWaitMs` 300 毫秒按回答延迟的 p90 和工具的平均执行时间来定：实测 Jev 的中途请求 313–330 ms。#14 的评测（见「开发」里「评测」的「一轮中途的 effort」）给出了第一批数据：Jev 的中途请求 p50 约 280 ms、p90 约 350 ms；去掉当前档位或计数、问题改用中文，两次运行里都看不出稳定的差别；Clef 的 confidence 比 Jev 低得多，默认门槛下几乎不改档，门槛要按后端分别校准。#17 没有校准（用户的决定）：两个决策模型都用这些起点值，Clef 在这些门槛下很少改档。

- **「预期内失败」这一问的写法和门槛（#7；评测归 #14；按语言校准原定由 #17 做，按用户的决定没有做）。** `thetaExpected` 0.25、`escalateAfter` 2、`escalateLimit` 2 都是起点。0.25 来自一次手工的小实验：11 个手写场景（6 个预期内：先写红灯测试、搜索没结果、探测 docker 是否安装、lint 报告问题、探测端口、一道中文红灯题；5 个真的卡住：构建一再失败、Edit 一再失败、部署失败、安装依赖失败、上传凭证错误），用 `scripts/decide-stuck.ts` 的同一份请求，各问 8 种写法。当前写法（英文问题加 `criteria`）：Jev 对预期内的评分 0.15–0.72（均值 0.39），对卡住的 0.09–0.16（均值 0.12）；Clef 对预期内的 0.27–0.90（均值 0.63），对卡住的 0.03–0.11（均值 0.06）。两个后端的分布都偏低，所以门槛取低（0.25 下，Jev 放过 6 个里的 5 个预期内的，Clef 6 个全放过，卡住的 10 次都升了档）。样本太小，只能当起点。要评测它，可以在 `effort-midturn` 的带 `trouble` 的题上加一个标注「这些失败是否预期内」：请求已经是 mod 发出的那一个（`trouble` 变体用 `decision/escalation.ts` 的 `stuckRequest` 拼，回答用 `readExpected` 读，记在逐题答案的 `expected` 里），缺的只是标注和评分；变量有：问题的写法（当前写法、「是不是预期内」改问「是不是卡住」（高值代表卡住）、不带 `criteria`，几种写法在上面的场景里的差别不大，不带 `criteria` 的卡住问法在 Clef 上间隔最大）、中英文、`recent_steps` 条数。`escalateMode`、`escalateAfter` 和 `escalateLimit` 没有评测方法，按使用体验调。
- **Clef 截断 state（#17 已测）。** 第三方资料（OpenRouter 的模型页）说 Workers AI 只读 state 的前约 2K token，官方 schema 只写了「过长的 state 会被截断」；Clef 开源的编码代码（Hugging Face 上 `Cloudflare/clef` 的 `joint_schema_model.py`）截断 state 时只留开头，问题从不截断。#17 用 `eval/probe-truncation.ts` 量了两轮（`eval/results/probes/2026-10-05-truncation.json`、`-2.json`，合计约 0.036 美元）：在 state 的开头、中间、末尾各藏一个事实，各用一个带「没有说」选项的 Choice 问。结论：**Clef 会截断，但时有时无**，超过约 2.1k token 的 18 个 state 里截了 4 个（英文 4/14，中文 0/4）；截断时只留 state 开头约 2.1k 个 Clef token，4 次的计数都正好是 2,650（计费也按截断后），后面的事实都答「没有说」。问题不截断：96 个选项、约 1.54 万 token 的问题选对了最后一项；整条约 1.8 万 token 时 state 也完整读到，所以带画像的 skill 第一段不会把同一请求里的 state 挤短。Jev 全部答对。设计和数字见 `eval/plans/17-calibration.md` 的 8.4–8.7 节。
  - **字段的顺序靠不住。** 截断留下的是序列化之后 state 的开头。Clef 开源的编码代码把 state 序列化成紧凑的 JSON 并按键名排序（`joint_schema_model.py` 的 `render()`：`json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)`），再截 token：这样排，`user_message` 在 `recent_context`（发消息时）、`recent_steps`（一轮中途）、`brief`（派出 agent）之后，截断最先丢的正是它。Workers AI 线上怎么排没有公开。所以 mod 不靠顺序，而是让整个 state 都在截断位置之内：`contextTokens` 约束的是发出去的整个 state，按它序列化成 JSON 的样子数（字段名、引号和转义都算，`decision/context.ts` 的 `withinTokens`；发消息时、`find_skill`、一轮中途和卡住时、派出 agent、Workflow 的请求都这样拼）。选 Clef 时它最多 2000。
  - **预算之外的开销。** 改成按整个 state 数之前，字段名、JSON 的标点和转义不在预算里：普通文字只多 10–30 个估算 token，但贴进来的 JSON、带很多引号和反斜杠的代码会让 2000 的 state 序列化后到约 2,470（离线用最坏的例子量的）。现在这部分也在预算之内，开销的上界就是 0。
  - **按 mod 的估算，2000 个 token 是多少个 Clef token。** 散文约 1.6–1.8k（探针里估算比 Clef 的计数多，英文约 1.15 倍、中文约 1.25 倍），在约 2.1k 的截断位置之内。代码、日志这类符号多的内容没有量过：mod 按约 4 个字符 1 个 token 估算，这类内容 Clef 的计数可能更多，满是代码的 state 可能越过约 2.1k，证明不了不会截断。README 里建议常贴大段代码的人把 `contextTokens` 设小一些（例如 1500）。
- **Clef 的延迟和 `timeoutMs`。** 本机用 Node 的 fetch 连发 6 次同一个请求：Clef 第一次 1.8 秒，之后 0.6–1.4 秒；Jev 第一次 0.57 秒，之后 0.28–0.33 秒。#4 的正式基线：200 个请求依次发送时 p50 699 ms、p90 929 ms，只有 1 条超过 1500 ms（见「开发」里的「评测」）；#17 的截断探针里，1.5–4.7k token 的请求 0.9–1.9 秒，8.8k 时 1.7–2.4 秒，1.8 万时 3.5–4.2 秒。所以 #17 把 Clef 的默认 `timeoutMs` 定为 3000，没有再按 p50、p90 细调。
- **派出 agent 的门槛（#15 的数据）。** `agentOverride` 0.6 在两次 Jev 运行里都不是最好：0.4–0.5 时整题中文 +3、英文 +2 个百分点；点名的门槛 0.5 偏低，英文里只是被提到的模型以 0.5–0.6 被当成点名；`thetaMax` 0.3 比 0.5 好 1–2 个百分点。数字见 `eval/results/subagent/` 各变体的 `breakdown.sweeps`，逐题的原始回答也在里面，可以按语言分别重扫（见「开发」里的「派出 agent（subagent，#15）」）。Clef 只抽样跑了 12 题（p90 约 1.05 秒），全量一个变体约 0.05 美元。#17 没有改这几个门槛（用户的决定）。
- **Workflow agent 启动时当场判断的排队（#9）。** prompt 是数据的调用（fan-out）每启动一个 agent 就发一个请求，fan-out 的几个 agent 几毫秒内一起启动（实测），而 Jev 对同一个 key 的并发请求像是依次处理，排在后面的会等到超时，那些 agent 不经路由。要量一量常见的 fan-out（几个到十几个 agent）有多少能在 `timeoutMs` 之内答上；不够的话，把几毫秒内一起启动的 agent 合进一个请求（#8 的 `workflowBatches` 已经能把几个调用放进一个请求）。
- **skill 推荐的门槛和准确率（#16）。** #11 的起点：用 mod 自己的排序代码（`skillsRequest` + `modRanker`）和真实的 Jev（jev-1.13.0），在本机 87 个 skill（66 个主 agent 能加载、21 个只能由用户触发）上问了 21 条消息：18 条中文（10 条该推荐 skill、8 条不该），3 条 find_skill 式的英文查询（2 条有对应的 skill）。先不带画像：该推荐的 skill 在第二段的相关度是 0.81–0.98（最低的是 `pr` 0.81）；不该推荐的消息里进入第二段的 skill 是 0.07–0.66（两次重命名都给了 `implement`，0.49 和 0.66），另有两个可争议的 0.80 左右（「这个函数为什么返回 undefined」的 `diagnosing-bugs`，「解释一下这个正则」里只能由用户触发的 `teach` 0.79）。所以 `skillsMinRelevance` 取两组之间的 0.7，`findSkillMinRelevance` 取 0.5（主 agent 主动问时宁多勿漏，它自己会看描述）。给 3 个 skill 写了画像后再问一遍：该推荐的照旧（`code-review` 0.96、`codebase-design` 0.96、`diagnosing-bugs` 0.94），`diagnosing-bugs` 对「为什么返回 undefined」降到 0.53（它的画像写了「不用于简单问题」）。第一段的分布：该推荐的 skill 都分到 0.34 以上（多数 0.96–1.00），不需要 skill 的消息里分给 skill 的最多 0.10，所以第二段只补读分到 0.1 以上的（`SHORTLIST_FLOOR`），多数普通消息只发一个请求。#16 的评测（109 题 × 中英 × 有画像和没有画像，真实的 Jev 跑了两次，见「开发」里「评测」的「skill 匹配」）：线上的有画像时中文 79.8%、英文 83.5%，两次都差 3.7 个百分点，没过当时 3 个百分点的门槛，在现在 4 个百分点的门槛之内（没有画像时 −1.8 和 −0.9）；`skillsMinRelevance` 在 0.3–0.8 之间很平，按语言建议中文 0.75、英文 0.8，共用一个值时 0.75（差距缩到 −2.3）；`findSkillMinRelevance` 建议中文 0.3、英文 0.5（共用时保持 0.5）。评测集里九成以上的消息都过了 0.1 这个下限、发了第二段（不该推荐的题多是诱导题）。#17 按这些数据把 `skillsMinRelevance` 的默认值改成 0.75（修复之前的问法上的预览，没有在新问法上重跑），`findSkillMinRelevance` 保持 0.5。按用户的决定没有再评测的：`skillsShortlist` 和 0.1 这个下限（决定第二段问什么，只能重新请求）；第一段拆成两题之后（第 1 轮审查：只能由用户触发的 skill 单独一题，不再挤掉能加载的 skill，033、090、091、092）两个变体都要重跑；问题用中文写；画像只用英文；Choice 选项顺序的影响（Jev 偏向排在前面的选项）。
- **主 agent 会不会主动用 `find_skill`。** 列表换成提示之后，主 agent 在推荐漏掉时并不会自己去查：一条要写 PR 描述、但没有推荐 `pr` 的消息，有提示、没有提示、加上「何时用」的更主动写法各 3 次，都直接写了正文；读到完整列表时第一步就加载了 `pr`（见「开发」里的「已实测的引擎行为」）。这类消息目前靠发消息时的推荐。还要评测：换别的场景（文件格式、某个服务的工具、一轮中途才出现的需要）和别的模型，以及「每轮先查」这类更强的写法值不值得它多出的 ToolSearch 加 `find_skill` 两步。
- **skill 请求的大小和延迟。** 不带画像时第一段约 6.4k input token（87 个选项），真实引擎里 0.3–0.6 秒；每份画像约多 110 token（实测 3 份画像多出 330–380 token），全部写好后估计 16k 左右，在 Jev「state + 最长的问题 ≤ 32k」之内；`questionBudget` 再按估算值留了余量（估算比 Jev 报的少约 10%，按 1.35 倍留），超出时先去掉「何时不用」，再从后往前改回描述。第二段约 0.5–1.5k token、0.25–0.5 秒。`-p` 进程启动时的第一个请求有一次用了 1.7 秒（#10 实测，进程启动时其他工作同时在跑），超时后照常放行。#16 实测（111 个 skill，Jev 计）：不带画像时第一段 8.6k input token，带全部画像 2.19 万（`questionBudget` 没有裁剪），第二段约 1.3k。Jev 第一段 p50 0.32–0.34 秒（不带画像）、0.56–0.67 秒（带画像）；慢的时段带画像的 p90 到 1.65 秒，218 条里 24 条第一段就超过 1500 ms：这条消息的决策请求整个超时，effort 也没有经过路由。Clef 带画像的第一段 1.5 万 token、3.7–7.9 秒，`timeoutMs` 3000 下每条消息都会超时（6 条抽样全部超过）。#17 的处理：选 Clef 时发消息的 skill 推荐默认关闭（`/dp skills on` 可以打开）；`find_skill` 选 Clef 时合计最多等 8000 毫秒、第一段只用描述（见「find_skill：主 agent 中途查询 skill」，按延迟定，没有校准）；把第一段单独发、只留英文字段的裁剪画像都没有评测（用户的决定）。
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
TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' [--zh] [--choice]   # 用 Node 调一次真实的 Jev
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AUTH_TOKEN=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' --clef   # 调一次真实的 Clef
TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-agent.ts --file <subagent.jsonl> --id subagent-011 [--lang en] [--zh] [--work] [--noul] [--fable]   # 一个派出 agent 的判断（Jev），请求与 mod 发出的相同
TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-stuck.ts <输入.json> [--zh] [--clef]   # 一个卡住的循环的再判断（Jev，或 --clef）：输入是 MidturnInput，打印「预期内」的概率和 effort 各档的概率
node dispatch-pilot/eval/validate.ts                      # 校验评测集（接缝 2，见下文「评测」），再核对 README 的配置表和 plugin.json、BACKEND_DEFAULTS 一致（#18）
node dispatch-pilot/eval/validate.ts docs                 # 只核对 README 的配置表
node dispatch-pilot/eval/run.ts effort-submit --estimate  # 估算请求数、token 和费用，不发请求
node dispatch-pilot/eval/run.ts effort-submit --label <名字> [--backend clef]   # 用真实 Jev（或 Clef）跑一次评测，结果存进 eval/results/
node dispatch-pilot/eval/run.ts effort-midturn --label <名字> [--variants en-score] [--backend clef]   # 中途重判的评测（#14）；--backend clef 时 mod 的设置取 Clef 的默认值（timeoutMs 3000 等）
node dispatch-pilot/eval/run.ts subagent --label <名字>   # 派出 agent 的模型和 effort（#15）：五个变体 × 中英，1000 个请求，Jev 约 0.11 美元（估算）
node dispatch-pilot/eval/run.ts subagent --backend clef --variants models-hint --ids subagent-001,...   # Clef 抽样
node dispatch-pilot/eval/run.ts skill --estimate          # skill 匹配（#16）：两个变体 × 中英，第二段按每条消息都发、短名单排满估算（上限）
node dispatch-pilot/eval/run.ts skill --label <名字>      # 用真实 Jev 跑 skill 匹配，两段请求都发
node dispatch-pilot/eval/profiles.ts [--estimate]         # 给快照里的 skill 写画像（每个 skill 一次 claude -p --model haiku，用你的订阅额度），存进 eval/datasets/skill-profiles.json
node dispatch-pilot/eval/apply-review.ts effort-submit --from <审核记录.jsonl>  # 应用用户的审核决定，再校验
node dispatch-pilot/eval/compare.ts <结果 a.json> <结果 b.json>                # 两次运行逐项对照，不发请求
node dispatch-pilot/eval/resummarize.ts [--dry-run] [<结果.json> ...]          # 按存着的逐题答案重算汇总里的门槛和 inTime（指标改了时），不发请求
node dispatch-pilot/eval/probe-truncation.ts --estimate   # Clef 截断 state 的探针（#17）：只估算；--show <名字> 打印一个探针的请求；不带这两个就发真实请求（Clef，Jev 对照）
```

`scripts/decide*.ts` 和 `eval/run.ts` 的设置都经 `readConfig` 读出：manifest 的默认值，加上所选决策模型的默认值（`core/setup.ts` 的 `BACKEND_DEFAULTS`），所以 `--clef` 或 `--backend clef` 时 `timeoutMs` 是 3000、`contextTokens` 最多 2000。脚本的 `--timeout` 默认就是这个 `timeoutMs`；`run.ts` 的 `--timeout` 是评测每次尝试最多等多久，默认是它的 4 倍、至少 10 秒（Jev 10 秒，Clef 12 秒），慢的回答照样量得到，超过 mod 会等的时间的另外统计。

凭证放在环境变量里，脚本不会打印它们。把它们存在 `~/.config/dispatch-pilot/eval.env` 时，可以用 Node 自带的 `node --env-file=<那个文件> dispatch-pilot/scripts/decide.ts ...` 载入，不必先在 shell 里 source。

mod 根目录的 `tsconfig.json` 是手写的。它继承生成的配置，并加上 `allowImportingTsExtensions`，因为相对导入都带 `.ts` 后缀（Node 直接运行也需要这样写）。Claude Code 发现已有 tsconfig.json 时不会覆盖它。

用 `claude -p` 在真实引擎里跑时，要带 `--strict-mcp-config` 和 `--settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}'`（jev-pilot 不停用会和本 mod 抢 effort），并且不配密钥；`claude -p "/dp"` 这样把斜杠命令当整个 prompt 的运行在本地完成，不调用模型，也不发决策请求。

**发版（#18）。** 递增 `.claude-plugin/plugin.json` 的 `version`；marketplace 条目不写版本，两处不会不一致。`claude plugin tag ./dispatch-pilot` 会建 `dispatch-pilot--v<version>` 的 git tag，并核对 plugin.json 和 marketplace 条目一致（`--dry-run` 只打印，不建）。0.2.0 还没有打 tag：按用户的决定，只推送分支，不合并 main，也不打 tag（`--dry-run` 核对过 plugin.json 和 marketplace 条目一致，会建的 tag 是 `dispatch-pilot--v0.2.0`）。

### 结构

```
hooks/
├── dispatch-pilot.ts       入口，只负责组装：先按顺序注册各项功能，最后注册核心
├── features/               每项功能一个文件，导出 register<X>(on, ctx)
│   ├── control.ts          /dp 命令：开关、锁定 effort、最近的决策；记录 session.measure 的读数（#13）
│   ├── dispatched-agents.ts  派出 agent 时判断它的模型和 effort（#6）
│   ├── escalation.ts       失败计数和强制升档：主 agent 和派出 agent（#7）
│   ├── find-skill.ts       主 agent 的 find_skill 工具：会话开始时注册，被调用时按查询给 skill 排序（#12）
│   ├── main-effort.ts      发消息时判断主 agent 的 effort（#2）
│   ├── midturn-effort.ts   一轮中途重新判断主 agent 的 effort（#5）
│   ├── skill-profiles.ts   会话开始时在后台给缺画像的 skill 写画像（#11）；注册在 skills 之外，等它读完目录
│   ├── skills.ts           对主 agent 隐藏 skill 列表、换成一句提示，发消息时推荐 skill（#10）
│   ├── workflow-agents.ts  提交 Workflow 时判断脚本里每个 agent() 的模型和 effort，写进脚本或退回（#8）
│   └── workflow-labels.ts  脚本写不进去的 Workflow：运行开始时判断各调用，agent 启动时按 label 写计划表；Workflow 工具描述里的常驻提示（#9）
├── core/                   各功能共用的机制，不含具体功能
│   ├── core.ts             核心的 hook：发消息时的决策请求、一轮的开始、每一步的写入、认出 settings hook 拦下的调用
│   ├── ballot.ts           一条消息的「投票箱」：各功能放进问题，由核心一次发出
│   ├── decisions.ts        决策日志：recordDecision，各功能记录自己的每个决定（debug log 和 /dp log）
│   ├── plans.ts            计划表的类型和纯函数（planStep 决定每一步发出什么）
│   ├── outcomes.ts         工具调用的结局：哪些被 settings hook 拦下（核心的 classic.PreToolUse 记）、每个调用怎么结束的（#7 记），#5 和 #7 共用
│   ├── profiles.ts         skill 画像（#11）：给模型的提示、读回答、store 的键和淘汰、readSessionSkills（目录加画像）
│   ├── prompts.ts          isPersonsMessage：判断哪些 prompt 是用户本人的新消息
│   ├── skills.ts           skill 目录：loadCatalog（经闭包读命令、引擎的 skill 清单、settings、磁盘，找到每个 skill 的文件）；读和裁剪 skill 列表（#10）；rankingSettings、describeStages（#11）
│   ├── status.ts           状态行：由各段组成，每段只有一个主人
│   ├── switches.ts         开关：总开关和各功能的开关，defineSwitch 登记、isOn 判断
│   └── setup.ts            把 userConfig 读成 ctx：每个选项的范围和缺省值只在这里（Config），以及决策后端
└── decision/               决策请求模块：纯模块，不依赖 $，Node 可以直接 import（#4 的评测会用）
    ├── system-one.ts       System One 请求和回答的类型；mergeParts、answersFor
    ├── effort.ts           effort 问题（英文或中文 × Score 或 Choice）、读回答、选档位
    ├── midturn.ts          中途重判：state（与评测集 effort-midturn 同形）、问题、防抖规则、工具调用的一句话结果
    ├── dispatched-agent.ts 派出 agent 的问题（模型 Choice + effort Score + 点名模型、排除模型、点名 effort）、按优先级读回答
    ├── escalation.ts       强制升档：卡住时的请求（stuckRequest，线上和评测共用）、「失败是不是预期内」的问题、升到哪一档的规则、从对话记录或 agent 的记录文件取任务和最近几步（#7）
    ├── workflow.ts         Workflow 脚本里各个 agent() 的请求（分批）、读回答、写进什么、告诉主 agent 什么（#8）
    ├── workflow-script.ts  读 Workflow 脚本（找 agent() 调用和它的选项）、把模型和 effort 写进去（#8）
    ├── workflow-labels.ts  Workflow 兜底：journal 里的 label 对应哪个 agent() 调用、从 transcript 取任务、给主 agent 的说明（#9）
    ├── model-ids.ts        模型家族对应的完整模型 ID：计划表的 model 写它，不写别名（#9）
    ├── skills.ts           skill 的两段排序（modRanker 是推荐和 find_skill 共用的唯一入口；第一段 skillsPart，第二段 stageTwoPart）、画像的写法、挑选、给主 agent 的文字块；skillsRequest（#16 的评测用）
    ├── context.ts          state：token 估算和截断、最近的对话、turnStartState
    ├── redact.ts           secret 脱敏
    ├── backend.ts          决策后端的接口、超时、失败分类
    ├── jev.ts              Jev 后端
    └── clef.ts             Clef 后端（Cloudflare Workers AI，#3）
scripts/decide.ts           用 Node 发一次真实的判断（Jev 或 `--clef`），请求内容与 mod 发出的相同：设置取 manifest 的默认值（`optionsFrom` + `readConfig`，和评测一样），凭证和 Node 的 io 用 `eval/node.ts` 的
scripts/decide-agent.ts     同上，判断一个派出 agent（输入是评测集 subagent.jsonl 的一题）
scripts/decide-stuck.ts     同上，一个卡住的循环的再判断（输入是 MidturnInput，见 `decision/midturn.ts`；请求用 #7 的 `stuckRequest` 拼）
eval/                       评测（接缝 2）：评测集、Node 脚本、结果，见下文「评测」
tests/support/world.ts      接缝 1 的测试脚手架
tests/support/cloudflare.ts world 的 Cloudflare 一侧：clef(levels) 是 jev(levels) 的孪生，按 Workers AI 的方式回答和拒绝
tests/support/workflow.ts   Workflow 工具桩和按脚本里第几个调用作答的 siteJev（#8）；workflowWorld 在 world 之外加一层，不改 world.ts
tests/support/workflow-run.ts  运行目录（journal、transcript）和 tool.describe 的桩；runWorld 在 workflowWorld 之外再加一层（#9）
types/index.d.ts            $.state 的契约（PluginState）
```

### 一条消息的处理过程

1. `prompt.submit`：各功能的 hook 在外层，带 matcher，先运行。`main-effort` 确认这是用户本人的新消息后，往这条消息的投票箱里放一个问题（`effort.level`）和一个 `settle` 回调，然后放行。
2. 核心的 `prompt.submit` 在最内层。它收起投票箱，拼出 state（`turnStartState`），把所有功能的问题合成一个请求（`mergeParts`，每个问题 ID 加上 `<part>.` 前缀），带着超时发给决策后端，再把回答去掉前缀后交给各功能的 `settle`。`settle` 返回的文字块作为 context 附在消息后面，模型能看到，用户看不到。这些都完成后，消息才进入会话。
3. `main-effort` 的 `settle` 把选出的档位记为待用的决定（`$.state` 的 `pending`）。如果这条消息是在某一轮进行中发的，它还会直接改写那一轮的计划。
4. `turn.start`（核心）为这条消息开始的一轮建立记录 `turns[main:<turnId>]`，并认领它的待用决定。优先认领正在进入的那条消息的决定，即使更内层的 hook 改写了消息的文字也能认领；其次认领文字与这一轮相同的排队消息。
5. `turn.step`（核心，最内层）每一步都读计划表，用 `planStep` 算出这一步的 effort（主 agent 不碰 model），写进请求，并更新状态行。

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
- **`$` 只能在 hook 所在的文件里使用**，不能传给从别的文件导入的函数，否则加载时会被拒绝。同一个文件里的函数可以接收 `$` 当参数（`launch($, s, ...)`），但不能把 `$` 放进对象字面量（例如 `{ $, s, e }`）：加载时报 `$ itself is put in an object`（#7 撞到的），要写成单独的参数。共用的逻辑写成纯函数；需要 `$` 的能力时，让函数接收闭包，例如 `BackendIo`（`{ fetch: (u, i) => $.http.fetch(u, i), sleep: (ms, s) => $.clock.sleep(ms, { signal: s }) }`）或 `$.state` 的 `Cell`（`{ get: () => $.state.get(REF), set: (v, o) => $.state.set(REF, v, o) }`）。`ctx` 里只有数据和纯函数。
- **`$.state` 的 ref 在每个文件里各自写成字面量常量**，例如 `const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const`，family 写成 `{ ...TURNS, id }`。validate 要求 `plugin` 和 `key` 是字面量。
- **每个字段只由一个 hook 写出。** 主 agent 的 effort 和非主 agent 的 model 只由核心的 `turn.step` 写出。功能通过计划表影响它们，不要在自己的 `turn.step` 里改 `e.effort` 或 `e.model`：内层的改写会覆盖外层，而核心在最内层。
- **主 agent 永远不写 model**（ADR 0001）。`planStep` 从结构上保证这一点：主 agent 的步最多只改 effort。
- **一律放行。** 决策模型失败、超时、回答不完整，或者自己的代码出错时，都让事件照常往下走，不阻塞用户，并在状态行说明原因。

### 往计划表写：effort、floor、model、lock

计划表在 `$.state` 里，契约见 `types/index.d.ts`，类型见 `core/plans.ts`。核心的 `turn.step` 每一步都会读它，所以写进去的值从下一步起生效。在同一步里，外层 hook 写入的值内层马上就能读到（已实测）。

| key | id | 内容 | 由谁写 |
|---|---|---|---|
| `turns` | `turnKey(turnId, agentId)`，即 `main:<turnId>` 或 `<agentId>:<turnId>` | 一轮的计划 `{ effort, floor, model }`，另有 `prompt`（主 agent 这一轮的消息，已脱敏和截断）、`decisions`、`changes`、`person`（这一轮是不是你本人的消息开始的，那次判断成功与否都算）、`floorUntil`（`floor` 从第几步起不再生效；`null` 表示整轮）、`raisedAt`（最近一次升档在第几步：中途重判的升档和强制升档） | #2 发消息时写（核心的 `turn.start` 建记录）；#5 中途重判用 `redecided` 写；#7 强制升档用 `forced` 写：`effort` 设到升到的档位，`floor` 是强制的那一档、到 `floorUntil`（升档那步加 `holdSteps`）为止，`raisedAt` 是这一步 |
| `agents` | `agentId` | 一个派出 agent 或 Workflow agent 所有轮的计划 `{ effort, floor, model, terms }`；`terms` 是你对这项工作的约束 `{ model, effort, banned }`（点名的模型、点名的 effort、排除的模型，决策模型读你的话得出；没有就是 `null`），后面改它模型或 effort 的功能都照办 | #6 在 `agent.spawn` 时写 effort 和 `terms`（haiku 不写 effort；model 已经改在派发上，表里留 `null`，免得每一步都把引擎过载时换用的模型改回去）；#9 在 Workflow agent 的第 0 步写（model 只在要换家族时写，写完整 ID；#8 已经写进脚本的调用只写 `terms`）；#7 强制升档时写 `effort`，把 haiku 换成别的模型时写 `model`（完整的模型 id，每一步都发出） |
| `workflowTerms` | Workflow 调用的 `tool_use_id` | #8 判断出的、你对直接交来的脚本里每个调用的约束（按调用序号，没有就是 `null`）；同一次调用里 #9 在内层读它，把约束交给这些 agent 的计划 | #8 在调用工具之前写 |
| `escalation` | `main`（主 agent，记录里的 `turnId` 是它所属的那一轮）或 `agentId` | 每个循环唯一的失败计数：失败次数、被 hook 拦下的次数、清零的基数 `base`（计入的是减去它之后的数）、强制升档的次数、这个循环最近一步的序号和引擎给的 effort、model（调用结束时就发的再判断要读）、最近一次再判断是为第几步问的、派出 agent 最近一次升档在第几步 | #7 写；#5 读主 agent 的，作为请求里的 `counts` |
| `lock` | 无 | 用户锁定的主 agent effort，`null` 表示没有锁定 | #13：`/dp lock`、`/dp unlock`（`features/control.ts`） |
| `decisionLog` | 无 | 各功能记录的决策，最近 50 条，`/dp log` 显示（见下「记录一次决策」） | 各功能，用 `recordDecision` |
| `pending` | 无 | 发消息时做出的判断，等它的那一轮开始时由核心认领 | #2 |
| `said` | 无 | 用户本人这一轮说的话（已脱敏和截断）：空闲时发的那条消息开始新的一组，这一轮进行中发的消息追加进去，其他来源的 prompt 不动它；派出 agent 和 Workflow 里 agent 的判断把它当作 `user_message` | #6 写，#8 读 |
| `midturn` | `main:<turnId>` | 中途重判自己的记录：步数、最近 16 步的文字和工具调用（各带结局）、最近一次重判是为第几步问的 | #5 |
| `mainStep` | 无 | 主 agent 正在进行的一步 `{ turnId, index }`（`tool.call` 上没有 turnId，靠它对上） | #5 |

`planStep` 按以下规则决定每一步发出什么：

- effort：主 agent 有 lock 时用 lock。否则，你为这个 agent 点名的 effort（`terms.effort`）优先，任何 floor 都不抬它；再否则取这一轮的 `effort`（非主 agent 这一轮没有时，用它在 `agents` 里的计划），再抬到 `floor`（取这一轮和 agent 计划中较高的、还在生效的 floor：有 `floorUntil` 的只管它之前的步）。没有任何 effort 但有 floor 时，抬高的是引擎自己的 effort。什么都没有时用引擎的 effort。
- model：主 agent 永远不改。其他 agent 用这一轮的 `model`，没有时用 `agents` 计划里的；再没有就是引擎的，这就是这一步的**有效模型**。**计划表里的 model 要写完整的模型 ID**（`decision/model-ids.ts` 的 `modelId('sonnet')`），不能写别名：`turn.step` 的 model 原样发给 API，写 `haiku` 得到 404，agent 失败（#9 实测）。只有 `agent.spawn` 会解析别名，#6 在那里写别名。
- 有效模型是 haiku 的 agent，这一步不带 effort（故事 32），引擎给了也拿掉（引擎自己对不收 effort 的模型也不发）。有效模型和引擎算的不是一个家族、引擎因此没给 effort（从 haiku 换走的 agent）时，按计划补上 effort。引擎给的是数字时不改 effort。

其他约定：

- 当前是第几步不需要另外记录，`turn.step` 的 `e.index` 就是（从 0 开始）。
- 读改写用 `update(cell, change)`，它按版本号做比较后写入，冲突时重试；`change` 必须是纯函数。改主 agent 某一轮的 effort 用 `revise(record, effort)`，它会同时更新 `decisions` 和 `changes`。
- 新的计数（例如 #7 的失败次数）放在自己的 key 下，id 同样用 `turnKey`，并在契约里加上相应的一段。
- 表项不会被删除。每条记录很小，一个会话里的增长可以忽略。
- `returned`（退回过的 Workflow）是 #8 自己的记录，核心不读，也不是计划表的一部分；见下面「Workflow 脚本的读取和改写」。`labelRuns`（本会话启动过的 Workflow 运行，最近 8 个）是 #9 的记录，#7 也读它来找 Workflow agent 的记录文件，见下面「Workflow 兜底（#9）」。

### 在 turn.step 上注册一层

如果某项功能需要在某一步发出前做决定（#5 取预判结果、#7 判断是否卡住、#9 按 label 查表，见 `features/workflow-labels.ts`），就在自己的文件里注册一层，写好计划表，再交给下一层：

```ts
on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
  if (e.agentId === undefined) {
    // 决定这一轮从这一步起的 effort，写进 turns[main:<turnId>]
  }
  return yield* next(e) // 核心在更内层，会读到刚写入的计划
})
```

只处理派出 agent 和 Workflow agent 的层用 `{ agentId: /(?:)/ }`。在 `next(e)` 之后可以读到这一步的结果（`stopReason`、`toolUses`、`usage`）。

### 给发消息时的决策请求加问题（投票箱）

用户发消息时只发一个决策请求，各功能的问题合在其中（同一个请求里的问题互相独立，几乎不增加延迟）。在自己的 `prompt.submit` hook 里这样写：

```ts
on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
  if (!isPersonsMessage(e)) return next(e)
  contribute(e.text, {
    part: 'skills',                               // 请求里的问题 ID 是 skills.<id>；part 名只用字母、数字、_ 和 -
    questions: { which: {/* ... */}, 'fits.0': {/* ... */} }, // 本地 ID 只用 [A-Za-z0-9_.-]
    state: { project_platforms: '...' },          // 可选：加进共用 state 的字段，排在共用字段之后
    settle: async (outcome) => {
      if (!outcome.ok) return                     // outcome.failure 说明原因：放行，并在状态行说明
      const which = outcome.answers.which         // 只有自己的回答，键是本地 ID；缺失或格式不对的回答不会出现
      // 这里可以继续使用 $，例如再问一次关于同一个 state 的问题（outcome.state，skill 的第二段就这样做）
      return ['<skill_relevance>...</skill_relevance>'] // 可选：附在消息后面给模型看的文字块
    },
  })
  return next(e)
})
```

- `settle` 由核心的 hook 调用，但它闭包里的 `$` 是你自己那个 hook 的，可以照常使用（已在真实引擎中实测）。`settle` 在消息进入会话之前完成，所以它返回的文字块来得及附上；它花的时间（例如 skill 的第二个请求）也算在消息的等待里，记得给自己限时。
- 成功时 `outcome.state` 是这个请求问过的 state（共用的 state 加上各部分加进去的字段），后续的请求要问同一件事时就用它（#11）。
- 每条消息只发一次请求。请求失败或超时时，每项功能都会收到同一个失败。
- 共用的 state 只有 `{ user_message, recent_context }`。往里加字段会影响同一请求里的所有问题（无关内容会降低准确率），只加问题确实需要的字段。
- 问题的写法见 `docs/research/typesafe-question-guide.md`。

### 在其他时机发决策请求

中途重判（#5）和派出 agent（#6）不经过投票箱，而是在自己的 hook 里直接发：

```ts
const io = { fetch: (url: string, init: HttpInit) => $.http.fetch(url, init), sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }) }
const request = mergeParts(state, [part])                               // part 的写法同上
const asked = await ctx.backend.ask(io, request, ctx.config.timeoutMs) // 从不抛错；asked.ok 为 false 时放行
const answers = asked.ok ? answersFor(part, asked.answers) : null
```

effort 问题的档位描述是共用的：用 `effortQuestion(instructions, ctx.ask)` 配上自己的 instructions，生成同样五档的问题，这样各处判断出的档位可以直接比较。

判断一个 agent 的模型和 effort，用 `decision/dispatched-agent.ts`：输入 `Dispatch` 的字段与评测集 subagent.jsonl 的题目相同，`dispatchState` 拼 state，`dispatchPart` 出问题，`decideDispatch` 按优先级读回答。Workflow 改写（#8）把几个 `agent()` 放进同一个请求时，给每个 agent 不同的 `part` 和 `field`（例如 `agent-0` 和 `brief_0`），state 用 `dispatchBrief` 拼各自的 brief，`user_message` 只放一份；做法见下节。

### Workflow 脚本的读取和改写（#8）

`decision/workflow-script.ts` 是一个懂 JavaScript 词法的读写器（mod 里没有现成的解析器可用）：它把脚本切成词（字符串、模板、注释、正则字面量、标点），所以注释和字符串里的 `agent(` 不会被认成调用，模板 `${...}` 里的代码会被读到，`.agent(`、`function agent`、`new agent` 和方法定义也不算调用。`parseWorkflow(script)` 返回 `{ meta, calls }`，读不了（字符串、模板或注释不完整，括号不成对，没有 `export const meta`）返回 `null`。每个 `AgentCall` 有 `prompt`（字符串值，模板保留 `${...}` 原文，运行时才拼出来的是 `null`）、`label`、`agentType`、行号，以及 `model` 和 `effort`（`none`、`literal` 或 `dynamic`）。`rewriteWorkflow(parsed, writes)` 只在找到的位置改文本，其余逐字不变，一遍扫完（三万个调用的脚本不到半秒）。

`decision/workflow.ts` 把调用变成决策请求（`workflowBatches`：同一请求里的 part 是 `agent-<n>`，state 字段是 `brief_<n>`，`n` 是调用在脚本里的序号，所以分成几批后 ID 仍不重复）、读回答（`readOutcomes`：每个调用的结果是 `written`、`kept` 或 `left`）、写给主 agent 和状态行的文字。两个模块都是纯的，#9 可以直接复用：用 `scriptPath` 或 `name` 提交的脚本，只要它用 `$.fs.read` 读到了文本，就可以同样 `parseWorkflow`、`workflowBatches`、`readOutcomes`；要改写的话，得去掉 `scriptPath`（它优先于 `script`）再传 `script`。

**给 #9：`$.state` 的 `workflowTerms`。** 直接交来的脚本，#8 在调用工具之前把它读出的、你对每个调用的约束（`termsOf(decision)`，按调用序号，没有就是 `null`；一个都没有就不写）写在这次 Workflow 调用的 `tool_use_id` 下；#9 在内层、同一次调用里读它，放进各调用的 `RunSite.terms`，这些调用的 agent 启动时把约束写进计划。（以前 #8 还按 `runId` 记过一份每次运行的摘要 `workflows`，没有任何功能读它，已删掉。）

读不了的调用要留意：prompt 放在数据里的 fan-out（`QUESTIONS.map((q) => () => agent(q.prompt, { label: q.label }))`，或 `` agent(`${CONTEXT}\n\n${l.prompt}`) ``）这里读不到任务内容，也不能在一个调用点上给每一行定不同的模型，所以整个调用点保持原样（`left` 计入，主 agent 被告知）。这一类要靠 #9 在运行时按每个 agent 的 label 和它实际收到的 prompt 来判断。用本机 `~/.claude/projects` 里已有的 16 个主 agent 写的真实脚本（共 50 个调用点，不含本票的探针）试过：44 个调用点的 prompt 说明了要做什么（多数是 `` `${COMMON} YOUR TOPIC: ...` `` 这样的模板），6 个读不了（1 个整个是运行时拼的，5 个是 `` `${CONTEXT}\n\n${l.prompt}` `` 这样的共用上下文加表里的一行）；改写后的脚本用 Node 的解析器检查过，都能解析。

### Workflow 兜底（#9）

#9 不改写用 `scriptPath` 或 `name` 提交的脚本（上节说的「去掉 `scriptPath` 再传 `script`」）：那样运行的是另一份脚本，主 agent 手里的文件和实际运行的对不上，恢复运行时每个 `agent()` 的缓存 key（prompt 和选项的哈希）也会失配；在 agent 的请求上设置则不动脚本。直接交来的脚本由 #9 自己再读一遍（纯函数，几毫秒），#8 只经 `workflowTerms` 交来你对各调用的约束。

`features/workflow-labels.ts` 注册三层，都带 matcher：

- `tool.describe`（`{ tool: 'Workflow' }`）：在引擎的描述后面附 `LABEL_HINT`。引擎每个会话只问一次并一直沿用（`$.ui.invalidate('tool.describe')` 之前），所以文字是常量，不拼会话内容；开关变化也不重新问。
- `tool.call`（`{ tool: 'Workflow' }`）：在入口里注册在 `workflow-agents` 之后，即在它内层：那个功能问完决策模型、把脚本交下来之后才轮到这里，所以它还在问的时候，别的运行里启动的 agent 不用等这里（见下文的 `launching`）。工具返回后读运行用的脚本：直接交来的读 `e.script`（那个功能交下来的那份：它写进去的调用多了选项，留下的调用照旧），其他读工具结果的 `scriptPath`。这里附的说明排在 `workflow-agents` 的说明之前（外层的功能在内层返回之后才追加自己的）。`scriptPath`、`name`、恢复的运行，各调用用 #8 的 `workflowBatches`、`readOutcomes` 判断；直接交来的不再问，`workflowBatches(...).skipped` 就是 #8 没问的调用（读不了的 prompt、超出上限的）。结果写进 `$.state` 的 `labelRuns`：`{ runId, dir, workflow, description, sites }`，`dir` 是工具结果的 `transcriptDir`，`sites` 是各调用的 `RunSite`（`match` 怎么认 label，`route` 是 `set`（运行开始时定的模型家族和 effort）、`runtime`（agent 启动时判断）或 `script`（照脚本），`terms` 是你对这个调用的约束；脚本读不了时 `sites` 为 `null`）。每个启动了的运行都记（没有 `agent()` 的除外），调用全都照脚本的也记：#7 要从这里找到 Workflow agent 的运行目录，读它的记录文件。
- `turn.step`（`{ agentId: /(?:)/ }`，在核心外层）：只在 `e.index === 0` 时动手。`agents[agentId]` 已经有计划（#6 派出的 agent，或者引擎重发的第 0 步）就不管。否则从新到旧读各运行的 `journal.jsonl`，按 `agentId` 找 `started` 行拿到 label，`sitesFor(label, sites)` 找调用：字符串 label 精确匹配，模板和「prompt 开头」其次，运行时才算的 label 作通配，只在前两者都对不上时用。所有候选的 route 相同就用它；`script`（#8 已经写进脚本）只在候选带着同样的约束（`RunSite.terms`，#8 经 `workflowTerms` 交来）时写一份只有 `terms` 的计划，`set` 直接写计划（连同 `terms`），`runtime`、对不上或候选不一致时，`decideAtStart` 读 `agent-<agentId>.jsonl`（每 25 毫秒看一次，最多 400 毫秒）、用 `taskOf` 去掉引擎的外框，拼成一个只有一个调用的 `ParsedWorkflow`，同样经 `workflowBatches`、`readOutcomes` 问决策模型。写计划用 `agentPlan`：只在要换家族时写 model（`modelFamily(e.model)` 比较家族，因为引擎重试后会出现 `claude-sonnet-5` 这样的 ID），写完整 ID。

几处要留意的引擎行为：

- **运行的第一个 agent 可能在 `tool.call` 处理完之前就到第 0 步**（实测相差 1–10 毫秒）。`tool.call` 在 `next(e)` 之前把一个 Promise 放进模块级的 `launching`，处理完再交出它记下的运行；第 0 步在已记录的运行里找不到这个 agent、又有正在处理的调用时，等它们（最多到这一步的 9 秒期限），再在交出来的运行里找。所以这段时间里启动的、和本功能无关的 agent（别的运行的、没有计划的派出 agent）也会等一下：通常只是工具启动的那几毫秒；`scriptPath`、`name` 和恢复的运行要加上运行开始时问决策模型的时间。
- **运行要从模块内存交出来，不能等完再读 `$.state`**：一次 dispatch 里的 `$.state.get` 读的是这次 dispatch 开始那一刻（d.ts：Every `get` of one dispatch reads one moment），等待期间 `tool.call` 写进去的 `labelRuns`，这一步再读也读不到（kit 实测）。同一次 dispatch 里外层写、内层读不受影响（见下文「已实测的引擎行为」第一条）。
- **`$` 只能传给文件顶层声明的函数**（validate 和加载器都检查）：`routeAgent`、`decideAtStart`、`readTask` 都在顶层，`ctx` 和设置作参数传进去。
- `decision/workflow-script.ts` 的 `AgentCall` 为此多了 `labelKind`（`none`、`string`、`template`、`dynamic`）：只有不写 label 的调用，引擎才按 prompt 开头记 label；写了但运行时才算出来的（`label: q.label`、展开的对象里可能带的）不能这样认。`decision/workflow.ts` 导出了 `whyOf`，给主 agent 的说明和 #8 用同样的写法。

测试用 `tests/support/workflow-run.ts` 的 `runWorld($, on, options)`：它在 `workflowWorld` 之上按实测的格式扮演运行目录。`w.started(runId, agentId, label, phase?)` 往 journal 加一行 `started`（第一次先写 `launched`），`w.transcript(runId, agentId, task)` 写 agent 的 transcript（外框加两格缩进），`w.agentStep(agentId, { index, model, effort })` 发出这个 agent 的一步（turnId 是 `turn-<agentId>`），`w.describeWorkflow(text)` 像引擎那样问一次 Workflow 工具的描述，`w.disk` 可以随时增删文件（测「transcript 晚到」就在 `w.clock.advance` 之间写进去）。运行目录是 `runDir(runId)`，`name` 提交和直接交来的脚本存在 `persisted(runId)`（工具桩结果里的路径）。

### 中途重判（#5）

`features/midturn-effort.ts` 注册两层，都带 matcher：

- `tool.call`：只看主 agent 自己的调用（`e.agentId` 为空，并且 `next.origin.plugin === 'engine'`，排除插件的 `$.tool.call`）。调用开始时，如果这是重判的时机，就拼好请求、发出去但不等待，把 Promise 放进模块级的 Map（`$.state` 只收 JSON）；调用结束后，把结局记进 `midturn`（被 settings hook 拦下的，由核心的 `classic.PreToolUse` 记在 `core/outcomes.ts`，这里用 `wasBlocked` 认出来）。
- `turn.step`（在核心之外）：取这一步的回答，必要时等 `rejudgeWaitMs`，按防抖规则写 `turns[main:<turnId>]`（用 `redecided`：有变化时改 effort，升档时记 `raisedAt`），再交给核心；同时边转发边收集这一步的文字。

同一步只问一次：并行的几个调用里只有第一个发请求，`midturn.askedFor` 记下已经问过的步。热重载后摘要在 `$.state` 里；在途的回答在模块里，会丢，那一步就沿用原来的 effort。

**失败计数不在这里。** 请求里的 `counts.failures`、`counts.hook_blocks` 读 #7 的 `escalation[main]`（这一轮的那一份），都是「自上次清零以来」的数：只有一份计数，#7 维护，开关 `escalation` 关着也照常计数。结局的分类是 `decision/midturn.ts` 的 `outcomeOf`：用户拒绝按 Claude Code 自己的文字认（`The user doesn't want to proceed with this tool use`、`Permission to use ...`、`Permission for this ...`），MCP 工具的错误文字是它自己写的，一律算失败。卡住时的那次再判断由 #7 自己发（见下节），这里不再有别的功能「要求一次重判」的入口（以前的 `demand` 没有人写，已删掉）。

**给 #14（中途重判的评测）。** 评测集 `effort-midturn` 每题的 `zh` 或 `en` 对象就是 `MidturnInput`，可以直接传进去：

```ts
import { midturnEffortPart, midturnState, judgeMidturn } from '../hooks/decision/midturn.ts'
const request = mergeParts(midturnState(row.zh, { steps: 4, tokens: 2000 }), [midturnEffortPart({ language: 'en' })])
// 读回答：readEffort(answersFor(midturnEffortPart(), answers).level)，再用 judgeMidturn 得到 mod 实际会发出的档位
```

- `judgeMidturn(reading, { current, sinceRaise, atLeast }, { thetaUp, thetaDown, thetaMax, holdSteps })` 就是 mod 用的防抖规则，返回 `{ effort, why, picked, confidence }`：`picked` 是不加防抖时选的档位，`effort` 是 mod 发出的档位，两者都可以拿去和 `gold`、`accept` 比较。
- 评测变量：`midturnState` 的第三个参数 `{ currentEffort: false }`、`{ counts: false }` 可以去掉当前档位和计数（指南 §4.1 担心当前档位会产生锚定）；`midturnEffortPart({ language: 'zh' })` 是中文问题。卡住时的请求用 `decision/escalation.ts` 的 `stuckRequest`（见下节）。
- 线上请求在工具开始执行时发出，所以最新一步里正在运行的工具写「进行中：」（评测集里没有这种结果）。
- #14 照这些做成了 `eval/lib/effort-midturn.ts`，见下文「评测」。

### 强制升档（#7）

`features/escalation.ts` 在入口里注册在 `registerMidturnEffort` **之前**（更外层），带两个 hook：

- `tool.call`：每个循环（主 agent、派出 agent、Workflow agent）结束的调用，用 `outcomeOf` 分类（`wasBlocked` 认出 settings hook 拦下的，见 `core/outcomes.ts`），并用 `noteEnded` 记下结局；失败和被拦下的各记一笔到 `escalation` 的记录里：主 agent 的 id 是 `main`（记录里的 `turnId` 是它属于的那一轮，新的一轮的第 0 步把记录清空），派出 agent 的 id 是 `agentId`。只看引擎的调用（`next.origin.plugin === 'engine'`），不看别的插件的 `$.tool.call`；别的插件的 `tool.call` hook 回答的 `{ deny }`（#8 退回 Workflow）不记。用户拒绝（`outcomeOf` 的 `denied`）不记。计数在总开关开着时一直做，不看 `escalation` 自己的开关（中途重判也要用这份计数）。计入的失败（失败，加上开关 `hook-block-failures` 开着时被拦下的，各减去 `base`，即上次清零时的数）够 `escalateAfter`、`raises` 还不到 `escalateLimit` 时，`launch` 当场发出再判断（故事 18），回答为这个循环的下一步留在模块级的 Map 里（`asking`）。
- `turn.step`：每一步记下这个循环在哪一步、引擎给的 effort 和 model（调用结束时发的请求要读）；`escalation` 关着时记 `paused`，再打开时把关着期间的失败清零。然后取为这一步发的回答（`within` 最多等 `rejudgeWaitMs`；还没到就照原样发出这一步，状态行加 `(late)`，回答留给后面的步），交给 `apply`。没有在途的请求、计入的失败却已够数时（调用结束时没有可升的，或热重载丢了请求），在这里处理：没有可升的就清零、记一条决策；否则当场发出，同样短等。

**再判断在调用结束时发，而不在下一步开始时同步等**（故事 18）：下一步只取结果，和中途重判一样短等、迟到就留给后面的步。代价是回答迟到时升档晚一步。请求由 `decision/escalation.ts` 的 `stuckRequest` 拼（中途重判的 state 加 `trouble`，`midturn.level` 带卡住说明，再加 `escalation.expected`），评测的 `trouble` 变体用的是同一个函数。最近几步取自记录：调用刚结束时记录里还没有它的结果，`stepsFromRows` 用 `noteEnded` 记下的结局（`endedAs`）补上，所以刚失败的调用不会读成「成功」。

**注册顺序有讲究。** 这一步里中途重判自己的回答（#5 的 `turn.step` 层）也可能到了：如果本功能在它之内，那个回答可能先把这一轮降一档，再轮到这里按降过的档位「升一档」，净效果为零；注册在它之外，升档先写进计划表，它读到的 `current` 已经包含这次升档，`floor` 和 `raisedAt` 又保证它在 `holdSteps` 步内降不到这一档以下。`tests/escalation.test.ts` 里有一个测试专门卡这件事（把这一行挪到 `registerMidturnEffort` 之后，它会失败）。

**升什么（`raiseOf`），按这个循环此刻的样子算，发请求时和取回答时各算一次**（中间可能被重判改过）：
- 主 agent：锁定了 effort、或这一步没有 effort 档位时什么都不做。`current` 是这一轮的 `effort`（没有经过路由时是引擎的）抬到还在生效的 `floor`；`forcedTarget(current, mode)` 算出强制升到哪一档，没有（`one-level` 在 xhigh，`max` 在 max）就清零、记一条决策、不问。请求的 `message` 是这一轮的消息，`recent_steps` 取自 `$.session.messages()` 里最近一条用户说的话之后的各步，`counts` 里的失败是自上次清零以来的数。
- 派出 agent：计划在 `agents` 表里（#6 或 #9 写的，没有就空），按有效模型（计划的 `model`，没有才是引擎的）处理。有效模型是 haiku 时换模型：`haikuSwitch` 按 `terms` 和 `escalateHaikuTo` 定换成哪个（你点名的 haiku 不换；被你排除的换成没被排除的上一档），只问 `escalation.expected`。否则升 effort：你点名了 effort 就不升；`current` 是计划的 `effort`（没有时是引擎的，再没有就是 medium：从 haiku 换走的 agent，引擎不给 effort）。任务和最近几步取自 `$.session.messages({ agentId })`；Workflow 的 agent（引擎对 mod 返回 `{ deny }`）从 `labelRuns` 记下的运行目录读 `agent-<agentId>.jsonl`，`rowsFromTranscript` 读成同样的行（任务去掉引擎的外框，引擎转述的用户请求不算任务）；都读不到就不问，按规则升。

**`apply`。** `escalation.expected` 的概率达到 `thetaExpected` 就是预期内：清零，把 `midturn.level` 的回答交给 `judgeMidturn` 做普通重判（主 agent 只对你本人的消息开始的一轮；派出 agent 改它计划里的 effort，`raisedAt` 记在它的 `escalation` 记录里）。否则（包括没回答）：主 agent 用 `forced` 写这一轮（`effort` 设到 `raisedLevel`，`floor` 是强制升的档位、只管到 `floorUntil`，`raisedAt` 是这一步；没有经过路由的一轮也一样写，中途重判看的是 `person`，不是 `decisions`）；派出 agent 把升到的档位写进计划的 `effort`（一直保持到它结束），或把计划的 `model` 设成换到的完整 id。清零以请求发出时的计数为准，之后又失败的照常计入。

**换模型要完整的 id。** 实测（2.1.289）：`turn.step` 的 `model` 写别名 `sonnet`，主 agent 会 `unrecognized_model` 退出，派出 agent 会以 `model_not_found`（HTTP 404）提前结束；写 `claude-sonnet-5-5` 在一个 haiku agent 运行到一半时换上，后面的步骤都由 sonnet 回答，agent 正常完成（`usage.model` 可见）。`agent.spawn` 的返回里的 `model` 是解析后的完整 id（`sonnet` 解析成 `claude-sonnet-5-5`，`haiku` 是 `claude-haiku-4-5-20251001`），但 mod 没有办法在一个 agent 运行中让引擎解析别名，所以 `escalateHaikuTo` 由 `decision/model-ids.ts` 的 `resolveModel` 解析：别名换成 `MODEL_IDS` 里的完整 id，带家族名的完整 id 原样用，别的值不换（记一条决策）。

**给 #14、#17：怎么评测这个新问题。** `decision/escalation.ts` 导出了 `stuckRequest(input, { limits, ask, effort })`（线上就用它拼）、`expectedFailurePart(ask)`（`escalation.expected`，中英文两种写法）、`readExpected`、`troubleText`。评测集 `effort-midturn` 每题的 `zh` 或 `en` 对象就是 `MidturnInput`，加上 `troubleText` 写的 `trouble` 就是线上请求：评测的 `trouble` 变体对计入的失败达到 `escalateAfter` 的题这样发，并把「预期内」的回答记在逐题答案的 `expected` 里（不计分）；`scripts/decide-stuck.ts` 也这样发一道题。评测还缺一个标注（这些失败是不是预期内的：TDD 红灯、没结果的搜索、探测……对比真的卡住的），现有的 006、017、051、053、056、057 几题只有「带不带 trouble」的对比。见上「待评测」里 11 个手写场景的数字。

### 登记功能开关

每项功能在自己的 register 里登记一个开关，一行：

```ts
defineSwitch({ name: 'main-effort', info: "decides the main agent's effort when you send a message", segments: ['decision'] })
```

`/dp` 的列表里会自动出现它，`/dp main-effort off` 可以关掉它，状态存进 `$.store`，不需要别的接线。功能在要动手的地方用 `isOn(name)` 判断，例如 `if (!isPersonsMessage(e) || !isOn('main-effort')) return next(e)`。

- `isOn` 同时看总开关：总开关关着时它对所有功能都返回 false，功能不必再单独判断总开关。总开关关着时核心也自己放行：`prompt.submit` 不发决策请求，`turn.step` 不改写任何一步（锁定也不生效），状态行只写 `dp off`。
- 在发消息、每一步、事件发生的时候判断，不要在 register 里判断：register 时还没有读到用户保存的开关（`features/control.ts` 在 `session.start` 里读，热重载后会重新读）。
- `name`：小写字母、数字和 `-`，以字母开头；不能是 `/dp` 自己的词（`master`、`on`、`off`、`all`、`reset`、`status`、`help`、`lock`、`unlock`、`log`），否则登记时抛错。建议和功能的文件名一致。重复登记同一个名字会替换前一次。
- `info`：一行英文（ASCII），显示在 `/dp` 的列表里。
- `segments`（可选）：这项功能拥有的状态行段（`core/status.ts` 的 `Segment`）。用户关掉这项功能时，`/dp` 会把这些段从状态行上撤掉，免得旧的报错一直挂着。
- `default: false`（可选）：默认关闭；不写就默认开启。
- `$.store` 的 `switches` 里只存用户改过的、和默认值不同的开关（总开关的键是 `master`）。`/dp` 保存时只改动这一个开关，别的会话存下的其他项原样保留，未知的名字也保留（功能改名或回退版本时不丢用户的选择）。

### 记录一次决策

功能每做出一个决定，就记录一次。一次调用同时做两件事：一行写进 debug log（`$.ui.log(..., { to: 'debug' })`，不进入对话），一条存进 `$.state` 的 `decisionLog`（`/dp log` 显示，热重载后还在）。文件顶部写自己的字面量 ref，调用时带上两个闭包：

```ts
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
// ...
await recordDecision(
  { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
  (line) => $.ui.log(line, { to: 'debug' }),
  { feature: 'main-effort', outcome: 'effort high', about: '"把登录模块重构成三层"', reason: 'p low 0.05, ...; confidence 0.70' },
)
```

- `feature` 是功能的开关名；`outcome` 用几个词说清楚决定了什么；`about` 可选，说明针对什么（例如一条消息的开头，已脱敏）；`reason` 是理由：决策模型给的概率，触发了哪条规则。都写成一行英文。
- debug log 里的那一行是 `<outcome> for <about>: <reason>`；`/dp log` 里是 `#<n> <feature>: ` 加同样的一行。
- 只记决定，不记失败的请求：请求的结果已经由核心写进 debug log，失败原因在状态行上。重判、强制升档、派出 agent 的模型选择、skill 推荐，都应该各记一条。
- 从不抛错：存不进 `$.state` 时在 debug log 里说一声，决定照常生效。最多保留 50 条，更早的丢弃。

### 会话的读数

`session.measure` 的读数（上下文占用、限额百分比、花费）由 `features/control.ts` 在每次变化时写一行进 debug log，开关名 `signals`，没有别的出口。它们只是记录：没有任何地方读它们来做决定，也没有写进 `$.state`。以后做「省额度模式」时，再决定怎么用。

### skill 目录、排序和推荐（#10；#11、#12 在这里扩展）

**skill 目录**（`core/skills.ts`）。`loadCatalog(io)` 返回本会话的 skill，每个是 `CatalogSkill { name, description, by, source, file }`（#11 加上了 `file`，查画像后还有 `profileKey`、`profile`）：

- `by: 'model'`：主 agent 能用 Skill 工具加载的 skill，即引擎给主 agent 的 skill 清单，由 `$.session.usage({ breakdown: 'summary' }).context.breakdown.skills.skillFrontmatter` 给出，顺序也照它。它在 `session.start` 时就能拿到，和主 agent 收到的列表完全一致，已经算进了 `skillOverrides`（实测）。
- `by: 'person'`：只能由用户本人触发的 skill。条件是：在 `$.command.list()` 里（来源是 user 或 plugin）、不在上面的清单里、SKILL.md（或命令文件）的 frontmatter 写了 `disable-model-invocation: true`，并且没有被 `skillOverrides` 设成 `off`。文件按 Claude Code 的布局找：项目和 `~` 下的 `.claude/skills/<name>/SKILL.md`、`.claude/commands/<name>.md`；插件的从 `~/.claude/plugins/installed_plugins.json` 查安装路径。`skillOverrides` 按来源（user、project、local、flag、policy）逐个读、逐个名字叠加，因为 `$.command.list()` 仍然会列出设成 `off` 的 skill。
- `name` 一律用列表里的写法，也就是 Skill 工具接受的名字。同步来的 skill 在 `skillFrontmatter` 和 `$.command.list()` 里叫 `computer-use`，在列表里叫 `anthropic-skills:computer-use`（个别本来就带前缀，例如 `anthropic-skills:deep-research`）。`description` 取自 `$.command.list()`，除了少数内置 skill 的列表描述后面多一段 when-to-use，其余都和列表一字不差。
- `file`（#11）：这个 skill 的 SKILL.md（或命令文件）在磁盘上的位置，读画像和第二段的正文开头都用它；找不到时是 `null`（内置 skill 没有文件）。主 agent 能加载的 skill 按清单给的来源找：`userSettings` 在 `~/.claude/skills/<name>/SKILL.md`（或 `~/.claude/commands/<name>.md`），`projectSettings`、`localSettings` 在工作目录的 `.claude/` 下，`plugin` 从 `installed_plugins.json` 查安装路径（`pluginName` 给出插件名），在插件 manifest 的 `skills` 写明的目录（例如 ui-ux-pro-max 的 `./.claude/skills/`）和 `skills/` 下找，`syncedSkills` 在 `~/.claude/skills/synced/<账号>/<名字>/SKILL.md`（账号目录用 `$.fs.list` 列出，所以 `CatalogIo` 多了 `list`）。只能由用户触发的 skill 记下判断它时读到的那个文件。本机实测：66 个能加载的 skill 里 53 个找到文件（13 个内置的没有，它们的画像从描述写），21 个只能由用户触发的都有。
- 目录存在 `$.state` 的 `skillCatalog`，一段对话读一次：`session.start`（在 `next(e)` 之后，其他插件的命令已经登记）重新读；没读到时，第一次用到它的 hook 再读；`session.end`（包括 `/clear`）清空。`find_skill`（#12）读 `$.state` 的 `skillCatalog`；`skills` 开关关着时会话开始没有读目录，`find_skill` 第一次被调用时自己读，并存进 `skillCatalog`。两处都用 `core/profiles.ts` 的 `readSessionSkills(io, model)`（`loadCatalog` 再查画像），各自在自己的文件里用 `$` 构造 `io`（`$` 不能跨文件）。
- 读不到命令或清单时 `loadCatalog` 抛错，功能放行：不问 skill，也不隐藏列表。某个 settings 来源或某个文件读不到时，只是少了那一部分。

**skill 画像**（#11，`core/profiles.ts` 纯模块；生成在 `features/skill-profiles.ts`）：

- 一份画像是 `SkillProfile { en: { what, use_when, not_for }, zh: { what, use_when, not_for } }`。`profilePrompt(skill, markdown)` 是给模型的提示（名字、描述、SKILL.md 的前 3000 token，要求只回一个 JSON 对象；system 是 `PROFILE_SYSTEM`），`readProfile(reply)` 取出回答里的 JSON，每个字段折叠空白、脱敏，英文截到 200 字符、中文截到 60 字符；`what`、`use_when` 缺一个就不算画像，`not_for` 可以为空。
- **存储。** 每份画像一个 `$.store` 键：`profile.<28 位十六进制>`，值是 `{ name, at, profile }`（`at` 是写下的时间）。键由 `profileKey(skill, markdown, model)` 算出：SKILL.md 全文（没有文件时用描述）、名字、模型和 `PROFILE_VERSION` 的哈希（两个 53 位的 cyrb53，同步计算），所以 SKILL.md 一改、换了模型或改了提示词，就是新的键，旧的不会再被读到。每个键单独写，几个会话同时写不会互相覆盖；`$.store` 读不到时不写画像（写了也留不住，每次会话都会重写）。
- **淘汰。** 每批写完后，`profile.` 开头的键超过 `MAX_PROFILES`（500）份，或者合计超过 `MAX_PROFILE_BYTES`（2 MiB，按键名加上值的 JSON 的 UTF-8 字节数，`storedBytes`）时，按 `at` 删掉最早写的、本会话目录里用不到的，删到 `EVICT_TO`（400）份以内、`EVICT_TO_BYTES`（1.5 MiB）以内（`evictions`）。每份画像最多约 1.3 KB（实测 450–520 字节），500 份也不到 1 MB，所以平常是份数先到；字节的上限防的是别的版本写下的、比现在大的值，`$.store` 的 4 MiB 是整个 mod 共用的（开关也在里面）。
- **查。** `lookUpProfiles(skills, { read, get }, model)` 给目录里的每个 skill 算 `profileKey`，从 store 取画像（`storedProfile` 再校验一遍），放进 `profile`；读不到 store 时 `store: false`，所有 `profile` 为 `null`。
- **写。** `features/skill-profiles.ts` 注册在 `features/skills.ts` 之外：后者的 `session.start` 读完目录、放进 `$.state` 之后，前者读出目录，`void writeProfiles(...)` 在后台按目录的顺序逐个写（主 agent 能加载的在前），每次 `$.model.complete({ model: skillsProfileModel, system, prompt, maxTokens: 700, timeoutMs: 60000 })`，写好一份就存进 store，并用 `update` 放进 `$.state` 的目录（`withProfile`），下一条消息就用上。每批最多 `skillsProfilesPerSession` 份；写之前再看一眼 store（别的会话可能刚写好）。模型被引擎拒绝（`$.model.complete` reject）或回答 API 错误时，这次会话不再写；回答没有文字、被截断或不是画像时跳过这一个。剩下的留给下一次 `session.start`（热重载也算）。`skills` 或 `skill-profiles` 关掉、或决策模型没配好时停下。`skillsNeverSuggested` 里的 skill 不写。任何错误都只写进 debug log，不会留下没处理的 rejection。

**排序**（`decision/skills.ts`，纯模块，mod 和评测共用）。**排序入口只有一个：`modRanker(io, settings)`**，发消息时的推荐（`features/skills.ts`）和 `find_skill`（`features/find-skill.ts`）都用它，评测（#16）也应该用它：

```ts
const ranker = modRanker(
  {
    ask: (request, timeoutMs) => ctx.backend.ask({ fetch: (u, i) => $.http.fetch(u, i), sleep: (ms, s) => $.clock.sleep(ms, { signal: s }) }, request, timeoutMs),
    opening: async (option) => { const file = catalog.find((s) => s.name === option.name)?.file; return file ? skillOpening(await $.fs.read(file)) : null },
  },
  rankingSettings(ctx),                                     // core/skills.ts：语言、skillsShortlist、第一段的 token 预算、timeoutMs
)
const part = ranker.part(options)                           // 第一段的问题，放进投票箱或自己的请求
// ……发出请求，拿到 answers……
const ranking = await ranker.rank(answersFor(part, answers), options, { state: request.state, timeoutMs })   // 第二段：同一个 state
const { suggest, hint } = pickSkills(ranking, options, policy)
```

- `io` 是闭包：`ask` 发一个决策请求（不抛错），`opening` 读一个 skill 的 SKILL.md 正文开头（`skillOpening`：去掉 frontmatter、折叠空白、脱敏、截到 180 token）。两处调用方各自在 hook 里用自己的 `$` 构造（`$` 不能跨文件）；评测用 Node 的 `fetch` 和 `readFileSync` 构造。
- `part(options)`（第一段，`skillsPart`）：两个 Choice，各自只在有候选时才问：`skills.which` 的选项是主 agent 能加载的候选（`by: 'model'`），`skills.hint` 的是只能由你触发的（`by: 'person'`，问题里说明这些 skill 由用户自己输入名字启动），各按候选的顺序，最后是 `(none)`。分成两题，是因为放在同一个 Choice 里两类 skill 会互相抢概率：评测里 033、090–092 只能由你触发的那个分走 0.98–1.00，能加载的 gold 分不到 0.1，进不了第二段。有画像的选项用 `profileFields(profile)`（`what`、`use_when`、`not_for`、`用途`、`何时用`、`何时不用`，空的「不用于」不写），没有的仍是描述字符串，和 #10 一样。每题超过 254 个候选时，后面的不问（Choice 最多 255 个选项）。每题按 `estimateTokens` 估算不超过 `settings.questionTokens`（`questionBudget(contextTokens)`；Jev 读的是 state 加最长的那个问题）：超出时所有画像先去掉两个「不用于」字段，还超出就从最后一个起改回描述，直到放得下。问题用英文或中文写，跟 `ctx.ask.language`。
- `rank(answers, options, { state, timeoutMs? })`：分别读两题（`readSkills` 读 `skills.which`、`readHints` 读 `skills.hint`，各自归一化），各取分到 `SHORTLIST_FLOOR`（0.1）以上的前几个：能加载的最多 `shortlist` 个，只能由你触发的最多 2 个（`shortlistCounts`；合计不超过 Clef 的 63 个）；一个都没有就返回空的 `ranked`，不发第二个请求。两题都没有可用的回答时返回 `null`。否则并行读它们的正文开头，用 `stageTwoPart(candidates)` 拼第二段（能加载的在前）：每个候选一个 Noul `skills.fits.<i>`（问题 ID 用下标，skill 的数据放在结构化 instructions 的 `skill` 字段：名字、描述、画像、正文开头），两个以上候选时再加一个 Choice `skills.best`（Clef 不接受只有一个选项的 Choice）。请求的 state 就是第一段问过的 state（核心通过投票箱的 `PartOutcome.state` 交给 `settle`），超时用 `timeoutMs`（不给时用 `settings.timeoutMs`；小于 1 毫秒时不发，算超时）。`readStageTwo` 读回答：相关度是 `fits` 的值，从高到低，相同时看 `best` 分到的概率，再看第一段的顺序。
- 返回 `SkillRanking { ranked, none, shortlist?, hints?, failed? }`：`ranked` 是第二段的相关度（绝对值），`none` 和 `shortlist`（`skills.which` 排在前面的 skill 及其概率；这题没问时 `none` 是 1）、`hints`（`skills.hint` 问了时，同样的两项）供日志用（`core/skills.ts` 的 `describeStages`）；第二段失败（超时、出错、回答里没有 `fits`）时 `failed` 是失败原因，`ranked` 为空，什么都不推荐。
- `pickSkills(ranking, options, { max, minRelevance })` 返回 `suggest`（`by: 'model'`，最多 `max` 个）和 `hint`（`by: 'person'`，最多 2 个，只上状态行）。`relevanceBlock(suggest, described)` 生成给主 agent 的 `<skill_relevance>` 文字块；`described` 里的 skill（已经描述过的，以及常驻列表里的）只写名字。
- 发消息时：`features/skills.ts` 在 `prompt.submit` 里构造 ranker，`part` 放进投票箱，并记下 `$.clock.now()`；`settle` 里用 `timeoutMs` 减去已经过去的时间作为第二段的超时（两个请求共用一次等待，hook 也不会超过 10 秒的预算），调用 `rank`，第二个请求写一行 debug log（`second skills request [...] to jev: ...`）。`find_skill` 在自己的 `tool.call` 里构造同样的 ranker，自己发第一段的请求，再把它的 `state` 和剩下的时间交给 `rank`（见下文「find_skill（#12）」）。
- #10 只有第一段的排序（`choiceRanker`，相关度是相对值）已经删掉：mod 和评测都不用它。

**评测（#16）**。`skillsRequest(item, options, { limits, ask?, ranker? })` 用 `item = { message, recent_context }` 拼出 mod 发出的同一个第一段请求：共用的 state、effort 问题、skill 的两个问题（同样按 `questionBudget(limits.tokens)` 控制大小），顺序和投票箱一样。它返回 `{ request, part }`，读回答用 `answersFor(part, answers)`，再交给 `modRanker(io, settings).rank(answers, options, { state: request.state })` 发第二段，最后 `pickSkills`。skill 的评测（`eval/lib/skill.ts`，见下文「评测」的「skill 匹配」）就是这样调用的：候选由 `skill-catalog.json` 快照按 `loadCatalog` 的顺序得到，画像用 `lookUpProfiles` 从 `skill-profiles.json`（和 `$.store` 同样的键和值）里查，第二段的正文开头读快照记下的 SKILL.md。`tests/eval-skill.test.ts` 用 world 核对两段请求与 mod 发的逐字相同。

**`$.state` 里的 skill 记录**（契约见 `types/index.d.ts`）：

| key | 内容 | 由谁写 |
|---|---|---|
| `skillCatalog` | 本会话的 skill 目录 `{ skills }`，每个 skill 带 `file`、`profileKey` 和 `profile`（#11，画像写好之前是 `null`）；`null` 表示要重新读 | `features/skills.ts`（读目录）；`features/skill-profiles.ts`（后台写好画像时用 `update` 放进去）；skills 没读时，`features/find-skill.ts` |
| `skillsShown` | 这段对话里描述过的 skill（再推荐时只写名字）；`/compact`、`/clear` 后清空 | `features/skills.ts` |
| `skillListing` | 对主 agent 列表的回答：`withheld`（换成了提示，记下引擎的原文）、`passed` 或 `restored`（开关关掉后已经随消息补给主 agent） | `features/skills.ts` |

**列表的提示**（`features/skills.ts` 的 `LISTING_HINT` 和 `LISTING_HINT_WITHOUT_FIND_SKILL`）。`prompt.attachment` 拦下主 agent 的列表时，回答 `trimListing` 留下的常驻清单（引擎的标题加 `skillsAlwaysListed` 里的条目），空一行，再接提示；没有常驻清单时只有提示。用哪一句由回答时的 `isOn('find-skill')` 决定：skills 功能在自己的文件里写 find-skill 的开关名（字面量，和 `skill-profiles` 一样），不在 register 里判断。debug log 那一行末尾写 `the note names find_skill` 或 `the note leaves find_skill out (switched off)`。两句都是常量：不拼进 skill 的名字、数量或任何会话内容。改它们的文字会改变每个会话第一条消息的前缀，测试（`tests/skills.test.ts`）里有一字不差的原文，要一起改。kit 每次 `w.listing()` 都会重新调用 hook，不模拟引擎「整段对话沿用一个回答」，所以测试只能断言回答稳定、按回答时的开关选句，不能断言「对话中途不变」。

### find_skill（#12）

- **注册。** `session.start`（matcher `{ cwd: /(?:)/ }`，在 `next(e)` 之后）调用 `$.tool.register({ name: 'find_skill', description, inputSchema })`，输入只有必填的字符串 `query`。没有配置决策模型（`ctx.backend.configured === false`）时不注册。描述和 schema 都是常量，不拼进任何会话内容，开关变化也不重新注册。注册被拒绝时在 debug log 说一声；引擎给的全名不是 `mcp__dispatch-pilot__find_skill`（hook 的 matcher 就对不上）时也说一声。
- **回答。** `tool.call` 的 matcher 是 `{ tool: 'mcp__dispatch-pilot__find_skill' }`。hook 直接返回 `{ result: <文字> }`，从不调用 `next`（没有别人回答这个工具，落空的调用会失败）。照官方文档的写法，失败也作为普通的 `result` 返回，用文字说明，不用 `isError`。
- **请求。** state 是 `turnStartState({ prompt: query, messages: $.session.messages(), limits: ctx.config.context })`；问题是 `modRanker(io, rankingSettings(ctx)).part(candidates)`，只有 `skills.which`；候选是目录里主 agent 能加载的 skill 去掉 `skillsNeverSuggested`，所以这一题和发消息时的 `skills.which` 一字不差（`skill-profiles` 关着时去掉画像，和发消息时一样）；只能由你触发的 skill 不问（它们反正不返回）。选 Clef 时第一段的候选去掉画像（`ctx.config.skills.findByProfile` 为 false），第二段照样带。请求带着 `ctx.config.skills.findWaitMs`（Jev 是 `timeoutMs`，Clef 是 8000）发给 `ctx.backend`，回答连同这个请求的 `state` 交给 `ranker.rank`，第二段只能用这段等待剩下的时间：两段共用一次等待，不是各等一次（各等一次的话，`timeoutMs` 最多 8000，两段就可能到 16 秒，超过 hook 的 10 秒），再经 `pickSkills(ranking, candidates, { max: findSkillMax, minRelevance: findSkillMinRelevance })`，只返回 `suggest`（`by: 'model'`）。第二段失败（`ranking.failed`）和第一段失败一样回答「无法评分」。`io` 的 `ask` 和 `opening` 在 `tool.call` 里用这次调用的 `$` 构造。
- **判断顺序。** 总开关、`find-skill` 开关、派出 agent（`e.agentId`，指回它自己的列表）、空查询：这几步不发请求，也不动状态行。之后读目录、发请求，结果或失败原因写进状态行。
- **状态行段 `find-skill`**（`core/status.ts` 的 `ORDER` 里排在 `skills` 之后）：`find_skill <名字>`、`find_skill none` 或 `find_skill failed (<原因>)`。`/dp find-skill off` 会撤掉这一段。
- **日志。** 每次发出的请求写一行（`request [skills.which] to jev for find_skill "<查询>": ...`，第二段是 `second request [skills.best, skills.fits.0, ...] to jev for find_skill "<查询>": ...`）；得到排序后用 `recordDecision` 记一条（feature `find-skill`，outcome `found <名字>` 或 `found no skill`，reason 是 `describeStages` 写出的两段结果和门槛）。失败只有请求那几行。
- **自己出错时。** 读 `$.state` 失败这类错误由 hook 捕获，照样回答失败，并在状态行和 debug log 说明，不让调用落空。

### 决策后端

`decision/backend.ts` 定义统一接口：`ask(io, request, timeoutMs)` 返回回答或失败，从不抛错，并自带超时。两个实现发出的请求一样（`model`、`state`、`questions`），问题部分不需要为后端改动：

- `jevBackend(apiKey)`：`POST https://api.typesafe.ai/v1/systemone`，Bearer 认证，回答在响应的顶层 `answers`。
- `clefBackend({ accountId, apiToken })`：`POST https://api.cloudflare.com/client/v4/accounts/<account ID>/ai/run/@cf/cloudflare/clef`，Bearer 认证，请求体必须带 `"model":"clef"`。回答在 Cloudflare 外壳的 `result.answers` 里（`{ result: { model, answers, usage }, success, errors, messages }`，已用真实的 Clef 确认；`result.model` 是 `clef`，不带版本号）。失败也在同一个外壳里：`success: false`、`result: null`、错误码在 `errors[0].code`。同样是 HTTP 429，3036（免费额度当天用完）和 3040（一时繁忙）要分开处理，所以 `clef.ts` 给 `postJson` 传了自己的 `classify`，读错误码分类（3036 记为 `quota`，3040、3007、3008 记为 `busy`，其余按 HTTP 状态）。凭证为空时不发送请求，失败的说明里出现的 account ID 和 token 都会被遮掉。
- `core/setup.ts` 按 `decisionModel` 二选一，只构造被选中的那个后端；失败时不会改用另一个。
- `Backend.configured` 为 `false` 表示用户还没配好这个后端（Jev 没有 key，Clef 缺 account ID 或 token），这时它的每次 `ask` 都会立刻以 `config` 失败返回。拿东西去换决策的功能，在这种情况下不应该动手：skill 推荐在这时不隐藏列表。新增后端时，要按自己的凭证设置这个字段。

失败的分类见 `Failure.kind`（`config`、`timeout`、`network`、`busy`、`quota`、`http`、`parse`、`request`），对应的状态行文字见 `core/status.ts` 的 `failureText`。要给第三个后端留位置时，同样新建 `decision/<name>.ts` 实现 `Backend`，再在 `setup()` 里加一个分支。

### 状态行

调用 `setStatus(segment, text | null, (line) => $.ui.status(line))`。各段按 `core/status.ts` 里 `ORDER` 的顺序显示，整行内容变化时才发送。新功能需要一段时，就在 `ORDER` 里加上，并且只由这项功能自己写。文字只用 ASCII。总开关关着时整行只显示 `dp off`（`pauseStatus`，只有 `features/control.ts` 调用），各段照常记着，打开总开关时清空。

### 配置项

在 `.claude-plugin/plugin.json` 的 `userConfig` 里声明。每个选项都只在 `core/setup.ts` 的 `readConfig` 里读一次，用 `numberIn`、`stringOf`、`namesOf` 做类型检查和范围截断，结果放进 `Config`（按功能分组：`midturn`、`escalation`、`agents`、`skills`），功能和评测都从 `ctx.config` 读，所以范围和缺省值只写在这一处（缺省值就是 manifest 的默认值）。功能的 register 里不再读 `options`。

**按决策模型取的默认值（#17）**只写在 `core/setup.ts` 的 `BACKEND_DEFAULTS` 一张表里：`PER_BACKEND_OPTIONS` 列出的 11 个选项（`timeoutMs`、`contextMessages`、`contextTokens`、`rejudgeSteps`、`thetaUp`、`thetaDown`、`thetaMax`、`thetaExpected`、`agentOverride`、`skillsMinRelevance`、`findSkillMinRelevance`）各一个默认值，另有几个不是配置项的值：`contextTokensMax`（`contextTokens` 读到的上限）、`suggestSkills`（`skills` 开关的默认值，`features/skills.ts` 的 `defineSwitch` 读 `ctx.config.skills.suggestByDefault`）、`findSkillWaitMs` 和 `findSkillProfiles`（`find_skill` 两个请求合计等多久、第一段带不带画像，读成 `ctx.config.skills.findWaitMs`、`findByProfile`），以及 `turnStartLanguage`（发消息时 effort 问题的语言：Jev 中文，Clef 英文；读成 `ctx.config.turnStartLanguage`，只有 `features/main-effort.ts` 用，其余问题照 `ctx.ask`）。这 11 个选项在 manifest 里**不写 `default`**：引擎交给 `register` 的选项是「填好默认值的」，写了就分不清你没设和你设成了默认值。没写默认值的字段，你不设时引擎不传（生成的类型 `.claude-plugin/types/` 里 kit 的 `TestOptions` 写明它和加载时一样：unlisted values unset, defaults filled in；`tests/backend-defaults.test.ts` 在 kit 里确认；2026-10-05 用 `claude -p "/dp" --plugin-dir ./dispatch-pilot` 在真实引擎里确认过，debug log 那一行写着 11 项都取了 Jev 的默认值；日志没有提交，见 `eval/plans/17-calibration.md` 的 8.8.1），`readConfig` 按 `decisionModel` 在表里取。`readConfig` 还记下哪些选项用了默认值、哪个被截到上限（`Config.defaults`），`features/control.ts` 在会话开始时把它写进 debug log（`describeDefaults`）。评测和 `scripts/decide*.ts` 经 `eval/lib/suite.ts` 的 `optionsFor(backend, ...)` 把决策模型交给 `readConfig`，取的是同一张表。要给某个后端改默认值，只改这张表，再改 README 的配置表（`node dispatch-pilot/eval/validate.ts docs` 核对它的 Jev 和 Clef 两列、`未校准` 的标注是否和这张表一致）和上面「配置」里的校准依据。manifest 里这 11 个选项不能写 `default`，那个核对也会报。敏感字段在没有配置时是空字符串。取值固定的字符串（例如 `decisionModel`）在 manifest 里用 `options` 声明，在 `/config` 里是下拉选择；填了列表之外的值，引擎读作默认值并给出警告，mod 里不必再处理。

### 测试怎么写（接缝 1）

测试只看 mod 对外的行为：发进事件，检查到达引擎和决策后端的东西，包括每一步的 effort 和 model、请求的内容、附加的 context、状态行和 debug log。不测内部函数。评测（接缝 2）用到的纯函数是另一个公开接口，可以直接测：`decision/` 的各个模块（拼请求、读回答，`tests/decision-module.test.ts` 等），以及评测也 import 的 `core/setup.ts`（`readConfig`、`dispatchSettings`）、`core/skills.ts`（`rankingSettings`、`describeStages`、读目录）和 `core/profiles.ts`（画像的键和查找）。

```ts
import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

test('……', { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) }) // 先注册桩，再调用 $
  await w.submit('消息')                                     // 空闲时，引擎在 next 里开始一轮（t1、t2……）
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
  expect(w.status()).toBe('dp effort high')
})
```

- `world($, on, options)` 在 mod 之下扮演引擎和外部世界。`backend` 回答 `$.http.fetch`：`jev(levels)` 让每个 Score 问题得到这组概率；`{ status, body }`、`{ reject }`、`{ after: ms, reply }` 分别模拟出错、断网和慢响应。`messages` 是 `$.session.messages()` 的返回值，`disk` 回答 `$.fs.read` 和 `$.fs.exists`，`beneath` 模拟更内层的 hook 拒绝（`drop`）或改写（`rewrite`）消息。它会记录 `requests`、`steps`、`statuses`、`logs` 和 `prompts`。`store` 给 `$.store` 预置内容（不给时每个 `$.store` 调用都会 reject），mod 写进去的用 `w.stored(key)` 读回；`session: true` 让引擎照常开始会话：`w.start()` 触发 `session.start`，mod 注册的命令记在 `w.commands`（`session: { registerError }` 让注册被拒绝），`w.measure({...})` 触发 `session.measure`；`w.command('dp', 'lock max')` 像用户输入斜杠命令那样运行它，返回它打印的文字（例子见 `tests/control.test.ts`）。这几项都是按需打开的，不用的测试不受影响。
- `skills` 打开本会话的 skill（`SkillsWorld`）：`commands` 回答 `$.command.list()`，`listed` 回答 `$.session.usage({ breakdown })` 里主 agent 的 skill 清单（`null` 让这次调用失败），`overrides` 按来源回答 `$.settings.read({ source })` 的 `skillOverrides`，`home` 和 `cwd` 回答 `$.env.get('HOME')` 和 `$.session.cwd()`。SKILL.md 放进 `disk`。`w.listing(text, agentId?)` 像引擎那样把 skill 列表交给 `prompt.attachment`，返回模型最后读到的内容。`session` 打开时还有 `w.compact()` 和 `w.clear()`。`jev(levels, { shares: { 'skills.which': { tdd: 0.6, '(none)': 0.4 } } })` 让一个 Choice 问题按给定的概率作答（没列出的选项是 0），`nouls: { 'skills.fits.0': 0.9 }` 让 Noul 按问题 ID 作答（默认 0.5）。例子见 `tests/skills.test.ts`。
- 两段排序（#11）：`rates(shares, fits)` 同时回答一条消息的两个 skill 请求：第一个请求的 `skills.which` 和 `skills.hint` 都按 `shares`（各自只取自己的选项；effort 默认 medium），第二个请求（`isSecondSkillsRequest(request)` 为真）里每个 `skills.fits.<i>` 按它 instructions 里 skill 的名字取 `fits` 的值（没列出的是 0），`skills.best` 全给 fits 最高的那个。`disk` 也回答 `$.fs.list`（列出某个目录下的文件和子目录），同步 skill 的账号目录就这样找到。例子见 `tests/skill-ranking.test.ts`。
- skill 画像（#11）：`model` 回答 `$.model.complete`（`(request, n) => Completion`：`{ text }`、`{ fails: 'api-error' | 'empty-reply' | 'aborted' }`、`{ reject }`（引擎拒绝发出，调用 reject）或 `{ after: ms, reply }`），每次调用记在 `w.completions`；没给 `model` 时每次调用都被拒绝。画像在 `session.start` 之后在后台写，所以先 `await w.start()` 再 `await w.clock.settle()`；再调一次 `w.start()` 就是「下一次会话」（同一个 store）。`w.storedKeys()` 列出 store 里现在的键。例子见 `tests/skill-profiles.test.ts`。
- `session` 打开时，mod 用 `$.tool.register` 注册的工具记在 `w.tools`（`registerError` 同样拒绝它们）。`w.findSkill(query, { agentId })` 像模型那样调用 `find_skill`（带 `agentId` 是派出 agent 的调用），返回工具的回答 `{ result }`。例子见 `tests/find-skill.test.ts`。
- 选 Clef 的测试：`options` 用 `tests/support/cloudflare.ts` 的 `CLEF_OPTIONS`（假的 account ID 和 token），`backend` 用 `clef(levels)`。它是 `jev(levels)` 的 Cloudflare 版：token 或地址不对时回真实的 401、404；请求体不符合 Clef 的输入规则时回 400（`clefInputProblems` 按 Cloudflare 的 schema 检查：问题 ID 的字符集和长度、1–64 个问题、Choice 至少 2 个选项、Score 2–10 档、instructions 非空）；其余按 `jev(levels)` 作答，放进 Cloudflare 的外壳。新增问题的票可以用它确认自己的问题 Clef 也接受。`cloudflareError(status, code, message)` 生成 Cloudflare 的失败响应。
- `w.submit(text, { origin, turnId, wait })` 默认模拟用户在终端按回车；带 `turnId` 表示在那一轮进行中发的，不会开始新的一轮。`w.startTurn(text)` 模拟排队的消息稍后开始自己的一轮。`w.step({...})` 发出一步并把流读完。
- `w.step({ index, answer, tools })` 还可以让这一步像真实引擎那样流出文字（`answer`），并在流还没结束时依次执行工具调用（`tools`，每个是 `{ tool, input, ends }`），所以功能的 `tool.call` hook 是在这一步之内触发的。`ends` 决定调用的结局：`{ text }`（成功，默认 `ok`）、`{ error }`（工具报错；用户在权限对话框里拒绝时也是这样，文字是引擎的那句话）、`{ blockedByHook }`（PreToolUse settings hook 拒绝，工具不会执行）。到达工具的调用记在 `w.toolCalls`（参数是经过 mod 各层改写后的样子；被 hook 拦下的调用不在其中）。`jev(levels, { confidence })` 可以指定回答的置信度（默认 0.7）。例子见 `tests/midturn-effort.test.ts`。
- `w.spawn({ prompt, description, subagentType, model, fork, isTeammate })` 模拟主 agent 调用 Agent 工具，返回 `{ model, agentId }`（agent 按到达引擎的顺序命名为 a1、a2……）；`spawned` 记录每次派发到达引擎时的样子。拿到的 `agentId` 传给 `w.step` 就是这个 agent 的步。
- Workflow 的测试用 `tests/support/workflow.ts` 的 `workflowWorld($, on, options)`：它先注册带 matcher `{ tool: 'Workflow' }` 的 Workflow 工具桩，再调用 `world()`，所以 `world()` 以后再加 `tool.call` 桩也不冲突（但同一个测试里要先于它注册）。`w.workflow({ script | scriptPath | name, args, resumeFromRunId })` 调用工具；`w.reached` 记录到达工具的每次调用（`launched: false` 是工具因语法错误拒绝的）；`w.records()` 读回 mod 写进 `$.state` 的 `workflows`，`w.stateWrites` 是它所有的 `$.state` 写入；选项 `parseError` 和 `fails` 让工具拒绝某个脚本。`siteJev((i) => ({ model, effort, nouls }))` 按脚本里的第 i 个调用回答，`clefSiteJev` 是它的 Clef 版（同时检查 Clef 的输入规则）。
- Workflow agent 启动时的测试（#9）用 `tests/support/workflow-run.ts` 的 `runWorld`：它在 `workflowWorld` 之上写运行目录（journal、transcript）、回答 `tool.describe`，见上文「Workflow 兜底（#9）」。agent 启动时当场判断的请求只有一个调用，part 是 `agent-0`，所以 `siteJev` 的下标 0 也会回答它；同一个测试里要区分运行开始时和 agent 启动时的回答，就按请求的序号 `n` 分别作答。
- 要模拟别的功能已经写好的计划表，就在测试里回答 `state.get`，见 `tests/plan-table.test.ts` 的 `table()`。
- 每个测试都要断言一个实际产物（发出的请求、某一步的 effort、状态行），否则可能空过。例如不给 origin 时 hook 会被跳过；没有 `http.fetch` 桩时 fetch 会失败、走放行分支，「effort 不变」照样成立。
- `world()` 总会装上 `mock.clock(on)`。测超时时，先 `const p = w.submit(...)`，再依次 `await w.clock.settle()`、`await w.clock.advance(ms)`、`await p`。
- 同一个事件的桩不能注册两次：`world()` 已经注册过的事件，测试里不要再注册。`http.fetch`、`fs.read`、`fs.exists`、`fs.list`、`model.complete`、`session.messages`、`ui.*` 和引擎那几个事件总会注册；开了 `store` 就是 `store.*`；开了 `session` 就是 `session.start`、`session.measure`、`session.compact`、`session.end`、`command.register` 和 `tool.register`；开了 `skills` 就是 `command.list`、`session.usage`、`settings.read`、`session.cwd`、`env.*` 和 `prompt.attachment`。想自己写这些桩的测试，就不要打开对应的选项。
- 每个测试拿到的都是全新的模块实例，模块级变量不会跨测试残留。
- **测试文件读不了磁盘上的文件**（2.1.289 实测）。`claude plugin test` 在和 hooks 一样的环境里加载测试文件：`import 'node:fs'` 被拒，`.json` 和 `.md` 也不能 import（只加载 `.ts`、`.tsx`、`.jsx`、`.js`、`.mjs`、`.cjs`、`.mts`、`.cts`），测试里的 `$` 是引擎的 `$`、没有 `$.fs`，也没有 `process` 和 `Bun`。要核对真实的文件，就把检查写成纯函数，测试用自己写的小例子测它，再由 Node 脚本对真实的文件跑它：README 的配置表对 plugin.json 就是这样做的（#18）：纯函数 `checkConfigTable` 在 `eval/lib/docs.ts`，`tests/docs-sync.test.ts` 测它，`node dispatch-pilot/eval/validate.ts` 对真实的 README.md 和 plugin.json 跑它。所以 `claude plugin test` 全部通过，并不说明 README 的配置表还和 manifest 一致，改了配置项或默认值要再跑那条命令。

### 评测（接缝 2）

> **effort-submit 之外，下面各节的数字都是第 1 轮审查修复之前的问法测得的。** 修复改了发给决策模型的问题措辞、工具行的写法、Workflow 题的合并提问，skill 第一段也拆成了两题；按用户的决定（2026-10-05），修复之后没有重跑这几套，所以它们的数字只能当预览，不能当成现在的问法的结果（见「待评测」开头）。effort-submit 的请求没有变，2026-10-05 又在现在的代码上跑了一次问题语言的对比。Clef 截断 state 的探针（`eval/probe-truncation.ts`，#17）不受影响：它发的是自己的探针问题。各结果的 `pass`、`late`、`retried` 和 `inTime` 已按现在的指标离线重算（见下面「已存结果的汇总可以离线重算」一条）。

评测用真实的 Jev 或 Clef（`--backend clef`）测决策的准确率，脚本用 Node 运行，放在 `eval/`：

```
eval/
├── datasets/<类>.jsonl     评测集，一行一题，中英对照；校验规则见 lib/datasets.ts
├── datasets/README.md      评测集的约定：每类题的字段、effort 档位的含义（标注依据）、各类的附加约定、名字的例外
├── datasets/skill-catalog.json   skill 题出题用的本机 skill 目录快照（#16）
├── datasets/skill-profiles.json  快照里每个 skill 的画像，和 mod 存在 $.store 里的一样（#16，profiles.ts 写）
├── review/<类>.review.jsonl 用户的审核决定（应用时由 apply-review.ts 放进来，和改动一起提交）
├── review/<类>.review-summary.md  审核总结：判断基准、规则决定（R1、R2……）和要跟进的事项
├── results/<类>/*.json     每次运行的结果：设置、答题的模型版本、汇总、逐题答案
├── results/probes/*.json   Clef 截断 state 的探针结果（#17，probe-truncation.ts 写）
├── plans/17-calibration.md #17 的方案、拍板、探针的结果和范围缩减
├── lib/                    纯模块（测试也 import）：datasets、review、suite、runner、metrics、resummarize、compare、docs、各类题型的 suite
└── validate.ts、run.ts、apply-review.ts、compare.ts、resummarize.ts、profiles.ts、probe-truncation.ts、node.ts   Node 脚本
```

- **测到的就是线上的请求。** 每类题型的 suite 用 mod 自己拼请求的函数（`hooks/decision/` 的各个模块，加上 `hooks/core/` 里读设置的 `setup.ts`、读 skill 目录和画像的 `skills.ts`、`profiles.ts`），设置取 manifest 的默认值，manifest 没有默认值的选项取 `--backend` 那个决策模型的（`core/setup.ts` 的 `BACKEND_DEFAULTS`，结果文件的 `settings.backendDefaults` 记着取了哪些），经 mod 自己的 `readConfig()` 读出（`--option contextTokens=4000` 可以改，按 manifest 写的类型读：数字、`true`/`false` 或文字；manifest 里没有的名字、类型不对的值直接报错），所以范围、缺省值和 mod 完全一样。`tests/eval-effort-submit.test.ts` 用 world 核对：同一条消息和对话，评测发的请求与 mod 发的逐字相同。
- **effort-submit 只问 effort。** skill 推荐开着时（默认开），mod 发消息时的请求里还有 skill 的问题。同一个请求里的问题各自独立作答，只以 state 为上下文，看不到彼此（TypeSafe 的说明，指南 S1、Q12），所以 effort 题单独问得到的就是线上的回答；`tests/eval-effort-submit.test.ts` 核对了带 skill 问题时，mod 请求里的 state 和 effort 问题与评测的逐字相同。延迟不同：带着 skill 问题（尤其是写好画像以后）的请求更大、更慢，消息的实际延迟看 skill 评测的第一段（那就是发消息时的整个请求），effort-submit 的延迟只是单问 effort 的。
- **变量。** effort-submit 有四个变体：`en-score`、`zh-score`、`en-choice`、`zh-choice`，即问题用英文还是中文写、用 Score 还是 Choice 问；用户的原文总是照搬进 state。每题的中文版和英文版都问。mod 现在的问法看决策模型：Jev 是 `zh-score`，Clef 是 `en-score`（`lib/effort-submit.ts` 的 `modVariant`；发消息时的 effort 问题用决策模型的语言，见「待评测」）。
- **指标**（`lib/metrics.ts`）：每个变体的中文、英文准确率（答案在可接受集合里；没答上的算错，另列条数），gold 命中率，答偏的方向，中英差距和门槛（中文比英文低不超过 4 个百分点就算通过，正好低 4 个百分点也通过：用户 2026-10-05 定的，原来的 spec 写的是 3 个百分点；`MAX_GAP`、`passes`），中英一致率，延迟 p50 和 p90（以及超过 mod 超时的条数），按 tag 分组的错题数；另报「每题都答同一档」的常数基线。评测每次最多等 `--timeout`（默认是这个后端的 `timeoutMs` 的 4 倍、至少 10 秒：Jev 10 秒，Clef 12 秒），失败（繁忙、断线、超时）还会重试；mod 只等 `timeoutMs`，也从不重试。所以 mod 拿不到的回答另列：超过 `timeoutMs` 才来的（`late`），和评测重试之后才答上的（`retried`：尝试的次数多于请求数），每种语言各记条数，再给出把它们都算作没有决定的准确率（`inTime`），`run.ts` 每个变体打印一行。
- **已存结果的汇总可以离线重算。** 指标的算法改了时（例如门槛从 3 个百分点改成 4 个，`inTime` 开始扣掉重试过的回答），`node dispatch-pilot/eval/resummarize.ts` 按结果文件里存着的逐题答案重算每种语言的 `late`、`retried`、`inTime` 和每个变体的 `pass`（`lib/resummarize.ts`），不发请求，其余字段原样保留，并在文件里加一段 `resummarized` 说明何时、重算了什么。2026-10-05 已经对 `results/` 下的全部结果重算过一次。准确率、一致率、`breakdown` 这些的算法没有变，不重算。
- **延迟只在 `--concurrency 1`（默认）时可信。** 实测 Jev 对同一个 key 的并发请求像是依次处理：p50 在 1 个并发时约 270–290 ms，2 个时约 540 ms，4 个时 700–1100 ms。
- **单次运行有波动。** 2026-10-04 用同一配置跑了两次（`results/effort-submit/` 里的两份 preliminary），四个变体分别有 192、192、191、193 / 200 个答案相同，单项准确率相差 0–3 个百分点，zh-score 的中英差距一次是 −2、一次是 −4，和中英差距的门槛（现在是 4 个百分点）同一量级。比较写法或判断门槛时多跑几次，用 `compare.ts` 对照。
- **结果文件**记录后端、请求的模型和响应里的模型版本、日期、变量、mod 的设置（包括除敏感字段外的全部选项）、评测集和代码的哈希（`hooks/` 下 mod 的全部文件，加上 `eval/lib/` 的 suite：请求和评分都出自它们）、每个变体问的问题、汇总，以及逐题答案（每个档位的概率和 confidence，供以后离线校准门槛；分部分评分的题型另有 `parts`），不含凭证。判断提示词有没有变，看拼请求的文件（effort-submit 是 `system-one.ts`、`effort.ts`、`context.ts`、`redact.ts`）和记录下来的问题；`backend.ts`、`clef.ts` 这类文件变了不影响请求内容。凭证按「进程环境变量优先，其次 `~/.config/dispatch-pilot/eval.env`」读取。
- **审核。** 用户的审核 wizard 每行写一个决定（`agree`、`edit`、`note`）。`apply-review.ts --from <文件>` 把它复制到 `eval/review/`，把 `edit` 写进评测集（只改答案字段，其他行逐字不变），列出改过答案的题（它们的理由需要重写）和要跟进的 note，再校验一遍；有任何一条无法应用时整份不写。审核之后又有新决定时，追加在记录末尾（同一题以最后一行为准），再运行一次 `apply-review.ts <类>`：提交的记录重新应用后，得到的仍是提交的评测集。`effort-midturn.review.jsonl` 的最后一行就是这样，按用户在 issue #1 的拍板撤回了审核者对 midturn-006 的修改。
- **加一类题型**（#14、#15、#16 都这样加过）：
  1. 评测集放进 `eval/datasets/<类>.jsonl`，在 `eval/datasets/README.md` 写下这类题的字段和标注约定。
  2. `lib/datasets.ts`：类名加进 `KINDS`；`FIELDS` 写每题的顶层字段，`RULES` 写逐题的校验（`zh`/`en` 的结构、答案的形状），`QUOTAS` 写整个评测集的配额（hard 的比例、各情形的题数），三处都按类名查，少一处 `validate.ts` 就报错；题和答案的类型也写在这里。
  3. `lib/review.ts` 的 `EDITABLE`：审核的 `edit` 能改哪些答案字段。`node.ts` 的 `datasetFile` 报错信息里列着各类的名字，一并加上。
  4. 在 `eval/lib/<类>.ts` 实现 `Suite`（`lib/suite.ts`：怎么问、怎么评分、怎么显示、常数基线），请求一律用 mod 自己拼请求的函数；在 `lib/suites.ts` 登记一行。
  5. 仿照 `tests/eval-effort-submit.test.ts` 用 world 核对请求与 mod 发的逐字相同，再写评分和汇总的测试。

  可选的几样：一个答案由几个决定组成时，`grade` 可以给出每部分的对错（`parts`，例如派出 agent 的 `model` 和 `effort`），汇总就会在整题之外给出每部分的准确率（分语言、按 tag、常数基线）；`breakdown` 给出这类题型自己的数字，存进每个变体的汇总；`report` 给出 `run.ts` 打印的几行；`baselines` 是随题而变的基线（例如每题都保持当前档），和常数基线一起评分、一起打印。#16 又加了三样，也都是可选的：一次要看不止一道题、或者除了题目还要读别的东西的 suite（`subagent` 题要把一个 workflow 的几道题放在一起问；skill 题要读目录快照、画像和 SKILL.md），在 `suites.ts` 里登记成一个构造函数 `(host: SuiteHost, items) => Promise<Suite>`，`run.ts` 开始运行时用 `node.ts` 的 `nodeHost` 和评测集的全部题目构造它（`items` 是整个评测集，不只是这次运行问的那些；`beside` 读评测集旁边的 JSON 文件，结果里记下这些文件的哈希；`read` 按路径读文件，`~` 是主目录）；`estimate` 给出一题最多发出的请求（读了第一个回答还要再问的 suite 用它，`--estimate` 就把第二段也算上），没有时 `--estimate` 只算 `decide` 拿到回答之前发出的请求；`about` 说明这个 suite 读到了什么，记进结果文件，其中的 `warnings` 由 `run.ts` 打印。一题发出几个请求记在逐题的 `requests` 里，`run.ts` 汇总的请求数按它算。

#### effort-submit 的正式基线（2026-10-04）

评测集是审核后的版本（100 题；审核 99 题同意、1 题备注，没有改答案），设置取 manifest 的默认值（`contextMessages` 4、`contextTokens` 2000、`thetaMax` 0.5），`--concurrency 1`。Jev 用同一配置跑了 3 次（`results/effort-submit/2026-10-04-jev-baseline-1.json` 到 `-3.json`），每次 800 个请求、614,292 input token、约 0.026 美元，没有失败。Clef 只跑了默认变体一次（`2026-10-04-clef-baseline.json`，`--option timeoutMs=3000`）：200 个请求、102,900 input token（约 2,300 neurons，在 Workers AI 每天免费的 10,000 之内），5 个请求第一次失败、重试一次后答上，没有失败的题。

准确率、一致率和 gold 命中率是百分比，差距是百分点。Jev 写 3 次的均值，括号里是最低到最高；延迟写 3 次运行各自的 p50 和 p90 的范围。门槛一列按现在的门槛（中文比英文低不超过 4 个百分点，正好 4.0 也通过）。

| 后端（答题的模型） | 变体 | 中文准确率 | 英文准确率 | 中英差距 | 4 个百分点的门槛 | 中英一致率 | gold 命中（中 / 英） | p50 / p90 ms |
|---|---|---|---|---|---|---|---|---|
| Jev（jev-1.13.0） | `en-score`（选 Clef 时线上的问法） | 79.3（78–80） | 78.7（78–80） | +0.7（0 到 +2） | 3 次都通过 | 92.3（91–93） | 61.3 / 59.7 | 278–418 / 316–464 |
| Jev（jev-1.13.0） | `zh-score`（选 Jev 时线上的问法，2026-10-05 起） | 87.3（87–88） | 87.7（87–88） | −0.3（−1 到 0） | 3 次都通过 | 92.0（91–93） | 65.0 / 66.3 | 278–419 / 314–484 |
| Jev（jev-1.13.0） | `en-choice` | 82.3（82–83） | 85.3（85–86） | −3.0（3 次都是 −3） | 3 次都通过（按当时 3 个百分点的门槛不通过） | 88.3（86–90） | 65.0 / 66.0 | 279–419 / 318–483 |
| Jev（jev-1.13.0） | `zh-choice` | 85.0（3 次都是 85） | 86.3（86–87） | −1.3（−2 到 −1） | 3 次都通过 | 93.7（91–96） | 62.3 / 63.7 | 278–413 / 318–492 |
| Clef（响应里只写 `clef`，没有版本号） | `en-score` | 74.0 | 74.0 | 0 | 通过（1 次） | 89.0 | 53.0 / 54.0 | 699 / 929 |

- **2026-10-05 的问题语言对比**（`results/effort-submit/2026-10-05-jev-ac4-question-language.json`，在现在的代码上跑的，请求和上面 3 次逐字相同）：`zh-score` 中文 85.0、英文 89.0，差距 −4.0，正好在 4 个百分点的门槛上，通过；`en-score` 79.0、78.0，+1.0。两种问法 p50 都是 282 ms，没有迟到或重试的回答。加上这一次，`zh-score` 4 次的差距是 0、0、−1、−4。
- **按 mod 的等法算的准确率**（`inTime`：超过 `timeoutMs` 或重试之后才答上的回答算没有决定，`eval/resummarize.ts` 离线重算过）：Jev 的各变体每次最多比准确率低 1 个百分点；Clef 有 5 个请求是重试之后才答上的，按 mod 的等法是中文 74%、英文 71%。
- **常数基线。** 每题都答 high 能对 55%（gold 命中 26%），medium 49%，xhigh 39%，low 30%，max 12%。Jev 的四个变体比 high 的 55% 高约 24–33 个百分点，Clef 高 19 个百分点。
- **中英差距的门槛在多次运行下是否稳定成立。** 门槛原来是 3 个百分点（spec 的写法），2026-10-04 的 3 次运行里，`en-score` 中文不比英文差（差距 0 到 +2），稳定成立；`zh-score` 和 `zh-choice` 的差距在 −2 到 0 之间；`en-choice` 3 次都正好是 −3：当时的 `metrics.ts` 把正好 3 个百分点记成通过，后来改成必须低于 3 个百分点，它就不通过了。2026-10-05 用户把门槛改成 4 个百分点（正好 4.0 也通过），这四个变体按新门槛都通过，结果文件里的 `pass` 已按新门槛重算。同一题同一种语言 3 次答案都相同的，四个变体分别是 190、192、191、188 / 200，即有 4–6% 的答案在 3 次运行里变过，差距最多摆动 2 个百分点；之前的两次 preliminary 运行发的请求逐字相同（评测集只差 submit-055 的理由，答案字段相同），其中一次 `zh-score` 是 −4，2026-10-05 那一次也是 −4。所以 `zh-score` 的差距在 0 到 −4 之间摆动，正好贴着新门槛；要据此做决定，先多跑几次。
- **延迟。** 第 1 次运行整体慢了约 130 ms（p50 413–419 ms，分布同样集中，不像是并发排队），第 2、3 次的 p50 是 278–286 ms，和 preliminary 相近：同样是 1 个并发，不同时段的延迟也会差上百毫秒。超过 mod 超时 1500 ms 的，每个变体每次 0–1 条，最长 2245 ms。Clef 在连接已经建立、请求依次发送时 p50 699 ms、p90 929 ms，最长 2148 ms，200 条里只有 1 条超过 1500 ms（冷连接的第一次请求更慢，见「待评测」）。
- **Clef 偏高。** Clef 每种语言答错 26 题，其中 25 题是答高了；Jev 的 `en-score` 每种语言答高 16–18 题、答低 3–5 题。
- **审核规则 R4 暴露的提示词问题（原定留给 #17，按用户的决定没有改）。** 线上提示词（`hooks/decision/effort.ts`）的 high 档写着「writing tests」（中文版是「编写测试」），把写测试整体放在 high 档；审核规则 R4（`eval/review/effort-submit.review-summary.md`）定的是写测试按范围定档。submit-056（给二十来行的纯函数补几个用户已经列明的用例，只接受 medium）因此很难答对：3 次运行里，`en-score`、`zh-score`、`en-choice` 中英文各 3 次全部答 high（`en-score` 给 high 的概率是 0.71–0.76），只有 `zh-choice` 6 次里答对 5 次；Clef 中英文也都答 high。对照题 submit-055（为三个外部依赖设计 mock、覆盖率要到 80%，接受 medium 和 high）24 次都答 high，这是对的。以后改提示词时，可以考虑把 high 档的写测试改成按范围描述，改完再跑一遍，用 `compare.ts` 对照这两题；这五档描述所有 effort 问题共用，要重跑的不只这一套。#4 和 #17 都没有改提示词。

#### 一轮中途的 effort（effort-midturn，#14）

- **评测集** `datasets/effort-midturn.jsonl`：100 题，中英对照，74 题 hard。每题是一段真实执行轨迹的片段：本轮用户的消息、即将发出的那一步（`step`，从 0 数，就是 `turn.step` 的 `index`）、这一轮现在的档位、计数（判断次数、档位变化次数、失败的工具调用数、被 hook 拦截的次数）和最近几步（主 agent 在那一步最后写的文字、调用的工具和一句话结果，结果以「成功：」「失败：」「被 hook 拦截：」「用户拒绝：」开头；第 1 轮审查后每个调用还有 `input`：说明它做的是什么的参数，只取 mod 的 `toolDetail` 读的那几个，见 `datasets/README.md`）。答案是从这一步到下一次重判之前的工作需要的档位：相对现在的档位，32 题该升、30 题该降、38 题该保持；`accept` 最多两档宽。审核（Opus 5.5 high 的审核会话，用户同意以它的结论为准）同意 96 题、改 1 题、备注 3 题；记录和总结在 `review/effort-midturn.review.jsonl`、`review/effort-midturn.review-summary.md`。总结末尾一节写了之后的处理：midturn-006 按用户在 issue #1 的拍板撤回了审核者的修改（计划内的 TDD 红灯不强制升档，accept 仍是 `[medium]`），053、087 改写了理由，090 在题面里补了一句「等结果都回来再综合」。
- **请求与 mod 相同。** 每题的 `zh` 或 `en` 对象就是 `MidturnInput`，只是每个调用的那一行按 mod 的写法重写（`midturnInput`）：用 mod 的 `resultLine` 写出结局（取自结果开头的那几个字）加上 `toolDetail` 从 `input` 读出的「做的是什么」，语言跟着消息走，和 mod 一样。评测集里结果的其余部分（人写的「结果如何」，例如 `old_string 未找到`、`退出码 1`）mod 从来不发（故事 10），所以不进请求，只留给审核和标注。suite 用 `midturnState`、`midturnEffortPart` 拼请求，`rejudgeSteps`、`thetaUp`、`thetaDown`、`holdSteps` 由 mod 自己的 `readConfig` 读出。`tests/eval-effort-midturn.test.ts` 用 world 核对三种情形下评测发的请求与 mod 发的逐字相同：每隔 N 步的重判（mod 的请求在最新一步里有一个「进行中：」的调用，测试里的题照样写进去，评测集的题没有这种结果）、改过 `rejudgeSteps` 和 `contextTokens` 的重判、主 agent 卡住时 #7 发的再判断（`stuckRequest`：带 `trouble` 的 effort 问题加 `escalation.expected`，在第二次失败的调用结束时发出，这时没有进行中的调用，形状和评测集的题完全一样）；还核对了同样的回答下，评测记下的 `sent` 就是 mod 下一步发出的档位。
- **变体**：`en-score`（mod 现在的问法）、`zh-score`（问题用中文写）、`no-current-effort` 和 `no-counts`（state 里去掉当前档位或计数；指南 §4.1 担心当前档位会产生锚定）、`trouble`（计入的失败达到 `escalateAfter`（默认 2）的 6 题照 #7 的 `stuckRequest` 发：带上「卡住」说明、对应的问题指令和「是不是预期内」一题，那一题的回答记在逐题答案的 `expected` 里、不计分；其余 94 题的请求与 `en-score` 相同，所以这个变体的整体数字也反映了重复提问的波动）、`raw-results`（和 `en-score` 一样，只是每个调用的那一行照评测集的原文发，带着 mod 不发的「结果如何」：量这部分信息对判断的影响）。题里的 `counts.failures` 是「自上次清零以来」的失败，和 mod 的计数同义（mod 只有一份计数，中途重判和 #7 都用它）。2026-10-04 的结果是第 1 轮审查之前跑的：那时每个调用的那一行照评测集原文发（就是现在的 `raw-results`），`trouble` 变体只问 `midturn.level`；所有变体都要重跑才是现在的问法的数字（#17 按用户的决定没有重跑）。
- **评分口径**：回答选出的档位（`pickEffort`：概率最高的一档，`max` 要过 `thetaMax`）在 `accept` 里算对，评测集标的就是这个判断。mod 随后实际发出的档位记在逐题答案的 `sent` 里（`judgeMidturn`：升档要置信度过 `thetaUp`，降档要过 `thetaDown` 而且一次只降一档），`why` 是原因，另有各档概率 `p` 和 `confidence`：校准门槛时可以用同一批回答重新判断，不必重新请求（#17 按用户的决定没有校准）。评测集不记录上次升档在第几步，所以 `holdSteps` 不起作用；强制升档的下限也不加：失败是不是预期内的，按用户的拍板由 #7 让决策模型判断。
- **指标**（共用指标之外）：「每题都保持当前档」的基线（`current`，52%，gold 命中 38%）；按 gold 相对当前档该升、该降、该保持分组的中英准确率（汇总里的 `breakdown.directions`）；`sent` 的中英准确率（`breakdown.sent`）。`sent` 的准确率有上限：5 题（007、061、066、068、091）可接受的档位都比当前档低两档以上，mod 一次只降一档，这 5 题的 `sent` 不可能对。
- **结果**（2026-10-04，审核后的评测集，设置取 manifest 的默认值：`rejudgeSteps` 4、`contextTokens` 2000、`thetaUp` 0.4、`thetaDown` 0.6、`thetaMax` 0.5，`--concurrency 1`）。Jev 用同一配置跑了两次：`results/effort-midturn/2026-10-04-jev-first.json` 在合入 #15 之前跑，`2026-10-04-jev-reviewed.json` 在合入之后跑。两次发的请求逐字相同（评测集和拼请求的文件哈希都一样），只是第一次的汇总早于 #15 的 `breakdown`：分组的数字在 `groups` 里，没有 `sent` 的准确率。每次 1000 个请求、908,778 input token、约 0.038 美元，没有失败。Clef 只跑了默认变体一次（`2026-10-04-clef-wiring.json`，`--option timeoutMs=3000`）：200 个请求、125,190 input token，没有失败，也没有重试。

  准确率、一致率、gold 命中率和 `sent` 准确率是百分比，差距是百分点。Jev 写第二次运行的数字，括号里是第一次。

  | 后端（答题的模型） | 变体 | 中文准确率 | 英文准确率 | 中英差距 | 中英一致率 | gold 命中（中 / 英） | `sent` 准确率（中 / 英） | p50 / p90 ms |
  |---|---|---|---|---|---|---|---|---|
  | Jev（jev-1.13.0） | `en-score`（线上的问法） | 73（77） | 74（74） | −1（+3） | 85（84） | 57 / 54（59 / 55） | 76 / 77（79 / 77） | 286 / 352（278 / 344） |
  | Jev（jev-1.13.0） | `zh-score` | 73（73） | 72（72） | +1（+1） | 88（92） | 52 / 49（51 / 50） | 74 / 73（74 / 74） | 282 / 350（279 / 350） |
  | Jev（jev-1.13.0） | `no-current-effort` | 74（77） | 75（75） | −1（+2） | 86（86） | 56 / 57（60 / 57） | 76 / 77（76 / 76） | 285 / 354（277 / 323） |
  | Jev（jev-1.13.0） | `no-counts` | 75（73） | 74（75） | +1（−2） | 87（87） | 58 / 57（56 / 55） | 78 / 77（77 / 78） | 286 / 358（277 / 326） |
  | Jev（jev-1.13.0） | `trouble` | 75（74） | 73（75） | +2（−1） | 90（87） | 59 / 53（57 / 53） | 77 / 75（78 / 77） | 287 / 346（275 / 333） |
  | Clef（响应里只写 `clef`） | `en-score` | 85 | 87 | −2 | 88 | 65 / 70 | 58 / 57 | 633 / 761 |

  - **常数基线。** 每题都保持当前档 52%（gold 命中 38%），是最好的常数；每题都答 high 50%，medium 和 xhigh 43%，low 28%，max 12%。Jev 的 `en-score` 比保持当前档高 21–25 个百分点，Clef 高 33–35 个百分点。
  - **中英差距的门槛。** 两次运行五个变体都通过（按当时 3 个百分点的门槛，也按现在的 4 个百分点），差距在 −2 到 +3 之间。同一题同一种语言两次答案相同的，五个变体分别是 185、192、185、188、189 / 200；`en-score` 的中文准确率两次差 4 个百分点（77、73），差距从 +3 摆到 −1。变体之间 1–3 个百分点的差别都在这个波动之内，两次运行看不出哪个变体稳定更好，所以也还看不出去掉当前档位（锚定）或计数有没有好处。
  - **按升、降、保持分组**（`en-score` 第二次，中 / 英）：该升 69 / 66，该降 73 / 77，该保持 76 / 79。答错的大多是答低了：中文 19 题答低、8 题答高，英文 21 题答低、5 题答高（第一次运行中文 19 低 4 高，英文 18 低 8 高）。有 17 题 Jev 两次运行中英文都答错，例如收尾阶段降得太多（042、045、064、066、078 都答 low），该保持 max 的 024、032 答低了，长而机械的批量工作 021、063 答高了；这 17 题里 Clef 中英文都答对的有 7 题，另有 2 题答对一种语言。
  - **`sent`：mod 实际会发出的档位。** Jev 的 `sent` 比选出的档位还略好一点（`en-score` 76 / 77，选出的是 73 / 74）：回答不够确定时 mod 保持原档，而保持原档常常也可以接受。Clef 正好相反：选出的档位最准（85 / 87），`sent` 却只有 58 / 57，只比保持当前档高 5–6 个百分点。原因是 Clef 的 confidence 比 Jev 低得多（`en-score` 200 个回答的中位数 0.24、p90 0.50，158 个低于 0.4，192 个低于 0.6；Jev 两次都是中位数 0.65–0.66、p90 0.97），默认的 `thetaUp` 0.4 和 `thetaDown` 0.6 挡住了它的大部分改档：每种语言约 60 题判为不够确定（`unsure`），一次降档也没有。所以门槛要按后端分别校准，或者让 Clef 改看概率最高那一档的概率（#17 按用户的决定都没有做，Clef 暂用 Jev 的门槛）。
  - **`trouble`（失败满 2 次的 6 题）。** 两次运行合起来 24 个答案，带上「卡住」说明后变对 4 个、变错 2 个（017 英文两次都变对；006、057 各有一次变对、一次变错），样本太小，看不出效果。006（两次失败都是计划内的 TDD 红灯）带不带都大多答 medium。#7 按用户的拍板还要问「这些失败是不是预期内的」，那个问题这里没有评测。
  - **延迟。** Jev 的 p50 275–287 ms、p90 323–358 ms，最长 1305 ms，没有超过 1500 ms 的。mod 在工具开始执行时就发出中途请求，下一步最多再等 `rejudgeWaitMs`（300 ms），按这个延迟，回答一般在工具运行期间就到了。Clef（连接建立后依次发送）p50 633 ms、p90 761 ms，最长 2078 ms，都在 3000 ms 之内。

#### 派出 agent（subagent，#15）

评测集、题号（`subagent-001` 起）、suite 名和结果目录沿用 `subagent` 这个名字（术语表不用这个词，统一叫「派出 agent」）：结果文件、审核记录和 issue 都按这些名字引用，所以保留，代码里的标识符已经改成 `AgentItem`、`agentSuite` 这样的写法。见 `eval/datasets/README.md` 的「名字的例外」。

- **评测集** `datasets/subagent.jsonl`：100 题，中英对照，76 题 hard。61 题是主 agent 用 Agent 工具派出的 agent（`kind: agent`），39 题是 Workflow 脚本里的一个 `agent()`（`kind: workflow`）。每题是一个 agent：用户这一轮的消息，主 agent 写给它的任务（`prompt`、`description`、agent 类型、主 agent 指定的模型）；workflow 题没有 `description`，另有 workflow 的描述和这个 `agent()` 的 `label`。答案是模型加 effort：`gold` 一个，`accept` 是可接受的模型和可接受的 effort。审核（Opus 5.5 high 的审核会话，用户同意以它的结论为准）同意 99 题，对 subagent-012 留了备注；记录和总结在 `review/subagent.review.jsonl`、`review/subagent.review-summary.md`。
- **请求与 mod 相同。** 普通派发的题：先像 mod 那样把用户的消息存成这一轮说的话（脱敏，按 `contextTokens` 截断），再用 `dispatchPart`、`dispatchState` 拼请求，用 `decideDispatch` 读回答；`agentFable`、`agentOverride` 按 `features/dispatched-agents.ts` 的读法从选项读。`tests/eval-subagent.test.ts` 用 world 核对两件事：同一条消息和同一次派发，评测发的请求与 mod 发的逐字相同；同样的回答，评测和 mod 选出同样的模型和 effort。Workflow 的题按 #8 问一个脚本的方式问：同一个 workflow（`workflow_description` 和用户的消息都相同）的题就是这个脚本的各个 `agent()`，按评测集里的顺序，用 #8 的 `workflowBatches` 分进请求（每个请求最多 8 个，各自一个 part `agent-<i>` 和一个 brief `brief_<i>`，brief 里有 `workflow_description` 和 `label`，`${file}` 这类占位符原样保留），用 #8 的 `readOutcomes` 读回答。评测集的 39 道 workflow 题来自 14 个 workflow，每个 2–4 题，都放进一个请求。每题发出它所在的那个请求、只读自己那一部分（同一请求里别的题的回答不用），所以一个 workflow 的请求一次运行会发几遍，这些题的 token 约是单发时的 2–3 倍。`tests/eval-subagent.test.ts` 核对：主 agent 提交由这几个 `agent()` 组成的脚本时，评测发的请求与 mod 发的逐字相同；同样的回答，评测的决定就是 mod 写进脚本的模型和 effort。第 1 轮审查之前这些题是每题单独一个、按普通派发的形状（`agent.*`、`brief`）问的，结果文件里的 workflow 题是那样问的。
- **变体**：`models-hint`（mod 现在的问法：选项按模型命名，主 agent 的指定作为强提示写进模型问题），`work-hint`（选项按适合的工作类型命名），`models-noul`（主 agent 的指定不进模型问题，单独问一题 `requested_fits`：这项工作在不在指定模型的适用范围内），`work-noul`（两者都换），`models-hint-single`（和 `models-hint` 一样，只是 Workflow 的每个 `agent()` 单独一个请求，part 和 brief 和合并时相同；普通派发的题和 `models-hint` 完全一样，所以它们的数字也反映了重复提问的波动）：量合并提问（brief 互相稀释，指南 S5、S6）对判断有没有影响。问题都用英文写，effort 都用 Score 问。
- **评分口径**：
  - 模型在 `accept.model` 里算对。
  - effort 在 `accept.effort` 里算对。`accept.effort` 是所有可接受模型共用的一组档位，没有按模型分开，所以 accept 有两个模型时，任一个模型配任一个可接受档位都算对（例如 subagent-089 的 opus/low、029 的 sonnet/xhigh）。审核逐题看过这些组合，都说得通；以后加题要留意双模型的 accept 会不会放进不合理的组合。选 haiku 时不设 effort（null），只有 haiku 本身可接受时才算对；其他模型必须有一个档位。
  - 整题（联合）：模型和 effort 都对。gold 命中另报。
  - 答错的方向：`model-under`、`model-over`（比所有可接受的模型都便宜、都贵），`effort-under`、`effort-over`（低于、高于所有可接受的档位，不设 effort 算作最低），`effort-none`（该有档位却没有）。
  - 没有做出决定的题算错，并写明原因：请求失败；回答里没有关于这个 agent 的答案；用户排除了所有可选模型，没有模型可选，mod 这时让 agent 按主 agent 原来的要求启动，评测无从评分。回答把概率全给了被排除的模型时不再算没有决定：选离它最近的、没被排除的模型（subagent-058，#6 的补丁）。
- **指标**（共用指标之外）：模型、effort、整题各自的中英准确率；每个 `priority:*` 情形（用户点名、保留主 agent 的指定、推翻主 agent 的指定、无指定）和每类 agent（普通派发、workflow）的错题数，分模型和 effort；每个情形里模型是谁定的（`user` 用户点名，`decided` 决策模型选的，`requested` 保留主 agent 的指定）；模型和 effort 各自的中英一致率；常数基线（总是 haiku、总是 sonnet 的某一档……），以及只看模型、只看 effort 时最好的常数。
- **门槛不重新请求。** `agentOverride`（推翻主 agent 的指定所需的置信度）、点名和排除的门槛 `thetaNamed`、`requested_fits` 的门槛 `thetaFit`（只有 noul 变体问）和 `thetaMax` 都只影响怎么读回答。每个答案都保存了原始回答：`p_model` 是模型问题各选项的概率，`p_effort` 是各档的概率（从低到高），`nouls` 是各是非题的概率，`p_named_effort` 是点名 effort 一题各选项的概率（消息里有可能点名 effort 的字眼时才有，`named_effort` 是读出来的那一档），另有 `source`、`pick`、`confidence`。汇总里的 `breakdown.sweeps` 在一组门槛值上用这些回答重新做决定、重新评分（`redecide`），不再发请求；以后按语言分别校准门槛就从这里出发（#17 按用户的决定没有做）。
- **标注约定**（起草和审核时定下的，加题时照此标注）：
  - workflow 题的 `description` 为 null；`agent_type` 只在脚本给 `agent()` 传了 agent 类型时才有值；fan-out 题的 `label` 和 `prompt` 保留 `${file}` 这类占位符。
  - 模型是 haiku 时 effort 为 null；`accept.effort` 含 null，当且仅当 `accept.model` 含 haiku。
  - 每题恰好一个 `priority:*` 标签：`priority:user` 是用户在本轮消息里为这项工作点名了模型，它就是唯一可接受的模型；用户写出的 effort 同样是唯一可接受的档位（用户 2026-10-04 拍板，见 issue #1 的评论）。`priority:main-kept` 的 gold 是主 agent 指定的模型，`priority:main-overridden` 的 gold 不是；`priority:none` 是主 agent 没有指定。
  - 保留还是推翻主 agent 的指定：差两档、让 haiku 写代码或做判断、让 opus 或 fable 只做汇报或机械工作（只搜索、只汇报、不需要判断），就推翻；只差一档、这个选择说得过去，就保留，gold 用主 agent 的指定，更合适的模型放进 accept。
  - 只有肯定的说法（「用 X」「X 就够了」「派个 X 去查」）才算点名。「别用 X」是约束：X 不进 accept，其余交给决策模型，标 `priority:none`；否定加肯定（「别用 opus，用 haiku」）时，肯定的那个算点名。模型名作为被比较的产品、作为线上系统用的模型、作为旧代码由谁生成被提到，都不算点名。点名只管它描述的那部分工作（「调研那种活儿用 haiku」不管实现的 agent），「这次所有 agent」管本轮派出的所有 agent。
  - 只提到 fable、答案却是默认模型的题，也打 `fable` 标签。
- **结果**（2026-10-04，jev-1.13.0，审核后的评测集）：`results/subagent/` 里有两次同样配置的 Jev 运行（`2026-10-04-jev-reviewed.json`、`2026-10-04-jev-reviewed-2.json`，各 800 个请求、约 0.04 美元）和一次 Clef 抽样（`2026-10-04-clef-sample.json`）。下面的数字取第二次（第一次早于结果里的 `scoring` 说明和 subagent-058 失败原因措辞的修正，两次的答案逐题可比）：
  - mod 现在的问法 `models-hint`：整题中文 69%、英文 66%（中文高 3 个百分点，过中英差距的门槛），模型 83%/82%，effort 74%/70%，gold 命中 50%/47%；中英一致率整题 86%、模型 90%、effort 88%；延迟 p50 286 ms、p90 374 ms，超过 1500 ms 的 1 个。两次运行有 194/200 个答案相同，各项准确率相差 0–2 个百分点。
  - 常数基线：整题最好的是总是 haiku，35%；只看模型，总是 sonnet，47%；只看 effort，总是 high，45%。
  - 按情形，中/英错题数：用户点名 0/0（17 题）；保留主 agent 的指定 5/6（17 题，中文有 6 题被决策模型推翻，3 题因此选错模型）；推翻主 agent 的指定 8/8（16 题，5 题没有推翻）；无指定 18/20（50 题，错的大多在 effort：15/18）。普通派发 18/17（61 题），workflow 13/17（39 题）。
  - 四个变体相差不大，整题都在 68–71%（中文）、65–68%（英文），两次运行里没有哪个变体在两种语言上都稳定好于 `models-hint`。
  - 门槛（用同一批回答重新决定）：`agentOverride` 从 0.6 降到 0.4–0.5，`models-hint` 两次都是中文 +3、英文 +2 个百分点；永不推翻（1）降到 65%/62%。`thetaMax` 0.3 比 0.5 高 1–2 个百分点；`thetaNamed` 0.7 中文 +1。这些都是在同一套题上扫出来的，校准时要防过拟合。
  - Clef 抽样（每个 `priority:*` 情形 3 题，共 12 题 × 中英，`models-hint`，`--option timeoutMs=3000`）：24 个请求都有回答，Clef 接受派出 agent 的问题；整题中英各 8/12（同样 12 题上 Jev 中文 9/12、英文 7/12），中英答案完全一致；延迟 p50 802 ms、p90 1047 ms、最长 1925 ms，都在 3000 ms 之内；26.5k input token，约 0.006 美元。
- **已知的问题题**：subagent-021 两种语言都错，但原因不同：中文是决策模型以 0.895 的置信度推翻了主 agent 的 opus（推翻门槛的校准问题），英文是把「之前让 sonnet 生成的」当成了点名（0.57）。点名问题的误判都在英文、概率 0.5–0.6（021 的 sonnet、100 的 fable），中文有一次（038 的 haiku）。subagent-023 两种语言都判成 sonnet xhigh（gold medium）。subagent-012 的用户点名了 effort：用户拍板「点名的 effort 也绝不推翻」，当时 mod 还没有实现，这两次答对只是因为决策模型自己也判了 low。subagent-058 在 `work-*` 变体里没有决定：用户排除了 opus，回答又把概率全给了 opus 那一项，剩下的模型没有概率；当时的 mod 遇到这种情况会让 agent 按原来的指定启动，也就是用户排除的那个模型（`models-hint` 下没有出现）。这两件事都由 #6 的补丁修了，见下一条。
- **点名 effort 和排除模型的补丁（#6、#8，2026-10-04，jev-1.13.0）**：补丁前后各跑一次全量（四个变体 × 中英 × 100 题，各约 0.043 美元；补丁前一次是用补丁前的代码在同一套题上重跑的，不是上面第二次运行）：`2026-10-04-jev-named-effort-before.json`、`2026-10-04-jev-named-effort-after.json`。subagent-058：`work-hint`、`work-noul` 里中英四个答案，补丁前都是没有决定（会启动 opus），补丁后都是 sonnet xhigh，对；`models-*` 两个变体前后都是 sonnet xhigh。subagent-012：八个答案前后都是 sonnet low，对；补丁后的 low 是点名 effort 一题读出来的（`named_effort` 概率 1.0 给 low，中英都是），不再靠决策模型自己的 effort 打分（0.67–0.70 给 low，碰巧一致），所以这题不能区分补丁前后。`priority:user` 的 17 题，四个变体、中英，前后都是 17/17。点名 effort 一题只在消息里有可能点名 effort 的字眼时才问：全量里中文 7 题、英文 6 题出现，决策模型判为没有点名的概率都在 0.91 以上（002、047、057、058、060、077–079、085–087），只有 012 判为点名。整体准确率前后在噪声之内（`models-hint` 中文 69%→70%、英文 69%→68%），逐题变化的题都不在这两件事上（run 之间的随机波动）。

#### skill 匹配（skill，#16）

- **评测集** `datasets/skill.jsonl`：109 题，中英对照，94 题 hard，用本机真实的 skill 目录出题。目录是 `datasets/skill-catalog.json` 这份快照，按用户的决定反映撤销 jev-pilot 写进 settings 的 user-invocable-only 覆盖之后的环境：90 个主 agent 能加载的候选，21 个只能由用户触发，8 个被仓库的 settings 设成 off。每题的答案有四项：`gold`（该推荐的 skill，按优先顺序，可以为空）、`accept`（推荐了也算对的）、`must_not`（推荐了就算错的干扰项）、`user_only_hint`（该在状态行提示用户的、只能由用户触发的 skill）。22 题什么都不该推荐也不该提示，17 题要提示只能由用户触发的 skill，8 题有并列 gold。审核（Opus 5.5 high 的审核会话，用户同意以它的结论为准）同意 105 题、改 4 题：017、042、084 把过严的干扰项改为中立，100 把 run 和 ego-browser 列为并列 gold。记录和总结在 `review/skill.review.jsonl`、`review/skill.review-summary.md`，总结末尾一节写了之后的处理（4 题的理由按新答案改写）。
- **请求与 mod 相同。** suite（`eval/lib/skill.ts`）用 mod 的排序入口拼两段请求：第一段是 `skillsRequest`（共用 state、effort 问题、skill 的两个问题，和投票箱合出来的一样），第二段是 `modRanker(...).rank`。候选按 `loadCatalog` 的顺序从快照得到：主 agent 能加载的按引擎列表的顺序在前，只能由用户触发的按命令列表的顺序在后，off 的不进；描述取快照里的（和 `$.command.list()` 一字不差），`skillsNeverSuggested`、`skillsMax`、`skillsMinRelevance`、`skillsShortlist` 按 mod 的读法从选项读。画像用 `lookUpProfiles` 从 `datasets/skill-profiles.json` 查，键和值都和 `$.store` 里的一样；第二段的正文开头读快照记下的 SKILL.md（`~` 是主目录），读到的每个文件都和快照记下的 sha256 对照，不一致、读不到或者没有画像的 skill 记进结果的 `about`，`run.ts` 打印警告。`tests/eval-skill.test.ts` 用 world 核对：同一条消息和对话，评测发的两段请求与 mod 发的逐字相同（有画像、没有画像两种）；同样的回答，评测和 mod 推荐、提示同样的 skill，改过 `skillsMinRelevance`、`skillsMax`、`skillsNeverSuggested` 时也一样。
- **变体**：`profiles`（每个 skill 都有画像：mod 写好画像之后的样子，线上的常态）和 `descriptions`（都按描述：第一次会话还没写好画像，或者关掉了 `skill-profiles`）。问题都用英文写，和 mod 现在一样。
- **画像文件** `datasets/skill-profiles.json`：111 个 skill（90 个候选加 21 个只能由用户触发的，mod 都写画像）各一份，由 `eval/profiles.ts` 写。提示词就是 mod 的（`PROFILE_SYSTEM`、`profilePrompt`，读 SKILL.md 的前 3000 token；13 个内置 skill 没有文件，从描述写），回答用 `readProfile` 读，存成 `{ <profileKey>: { name, at, profile } }`，和 mod 存进 `$.store` 的一样。`$.model.complete` 在 Node 里调不到，所以每个 skill 调一次 `claude -p --model haiku`，用你自己的登录和订阅额度（2026-10-04 写了 111 份，111 次调用，答题的是 claude-haiku-4-5-20251001），并且尽量做成裸的补全：`PROFILE_SYSTEM` 就是整个系统提示词，不给工具，不思考（`MAX_THINKING_TOKENS=0`、`alwaysThinkingEnabled: false`），不读用户和项目的 settings（避开个人设置里的 `language` 和 `outputStyle`：带着它们时 haiku 先用中文写一段分析，再给 JSON），`--safe-mode`（不读 CLAUDE.md、插件、hook），`--strict-mcp-config`，在空目录里跑。实测 tdd 的一份是 1.5k input、220 output token、2.7 秒，和 mod 自己写画像时同一个量级（111 份 4 个并发共用了 2 分 47 秒）。某个 SKILL.md 改了，它的画像键就变了：再跑一次 `profiles.ts`，只补写缺的，去掉过时的。
- **评分口径**（审核规则；结果文件的 `scoring` 里是英文版）：答案分两部分。`suggest` 是推荐给主 agent 的 skill（最多 `skillsMax` 个，相关度不低于 `skillsMinRelevance`）：gold 为空时什么都不推才算对；否则推荐里至少有一个在 accept、而且没有一个在 must_not 才算对。既不在 accept 也不在 must_not 的 skill 是中立的：和 accept 里的一起推不扣分，只推中立的算未命中。`hint` 是状态行提示用户的、只能由用户触发的 skill（每条消息最多 2 个）：user_only_hint 为空时什么都不提示才算对，否则至少提示一个其中的 skill 才算对。两部分都对才算整题对。gold 命中（精确命中）是推荐的正好是 gold、提示的正好是 user_only_hint，不多不少。没有做出决定（请求失败、回答里没有 skill 问题、第二段失败）算错。答错的方式：`must-not`、`extra`（不该推荐时推荐了）、`neutral-only`、`missed`（该推荐时什么都没推），`hint-extra`、`hint-missed`、`hint-other`（只提示了不该提示的）。
- **指标**（共用指标之外，在每个变体汇总的 `breakdown` 里）：按情形分组的整题和两部分的中英准确率（`groups`：什么都不该推荐的 `none`、该推荐 skill 的 `skill-needed`（它的中文一列就是「中文请求对上英文描述的 skill」）、`multi-partial`（几个 skill 都部分相关）、`near-duplicate`（名字相近的干扰项）、`lexical-trap`（字面诱导）、`user-only`、`needs-context`（要读 `recent_context` 才知道做什么））；两段各自的延迟和发第二段的比例（`stages`，总延迟是共用指标里的 `latency`）；该推荐 skill 的题里，第一段把可接受的 skill 送进第二段、第二段让它过了门槛的题数（`funnel`）；常数基线「每题都不推荐、不提示」。延迟按 mod 的方式记两段之和：mod 让两段共用一次等待（`timeoutMs`），评测不按第一段剩下的时间截断第二段，而是数出总延迟超过 `timeoutMs` 的回答。
- **门槛离线重扫。** 每个回答都存了第一段排在前面的 skill 和分到的概率（能加载的一题是 `first`、`none`，只能由用户触发的一题是 `hints`）、第二段每个 skill 的相关度（`fits`，原值）和两段各自的耗时（`stages_ms`）。`breakdown.sweeps` 用这些回答按一组门槛重新挑选、重新评分，不再发请求：`skillsMinRelevance`（推荐和提示，最多 `skillsMax` 个，整题和两部分）；`findSkillMinRelevance`（`find_skill` 会返回什么：最多 `findSkillMax` 个，只返回主 agent 能加载的，按 `suggest` 的规则评分，另报 `recall`：该推荐 skill 的题里返回了可接受 skill 的比例，`quiet`：不该推荐的题里什么都不返回的比例）。`breakdown.best` 是每种语言最好的值。`find_skill` 用的是同一个排序，但真实的查询是主 agent 写的几个词，这里用用户的消息代替，是近似。`skillsShortlist` 和第二段的下限 0.1（`SHORTLIST_FLOOR`）决定第二段问什么，没法离线重扫，要重新请求。
- **结果**（2026-10-04，jev-1.13.0，审核后的评测集，manifest 的默认值，`--concurrency 1`）：同一配置跑了两次，`results/skill/2026-10-04-jev-reviewed.json` 和 `-reviewed-2.json`，每次 436 个回答、843–845 个请求、约 713 万 input token、约 0.30 美元，没有失败。两次的回答 `profiles` 有 213/218 相同、`descriptions` 有 208/218 相同。准确率、一致率、gold 命中率是百分比，差距是百分点；两次不同时写成「第一次 / 第二次」。

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
  - **Clef 抽样**（`results/skill/2026-10-04-clef-sample.json`，`profiles`，skill-001、002、004 × 中英，`--option timeoutMs=3000`）：6 个回答都对，中英完全一致，Clef 接受 112 个选项、带画像的第一段和第二段的问题。但第一段很慢：3.7–7.9 秒（p50 4.4 秒；第二段 0.5–0.8 秒），6 个都超过 3000 ms，也就是 mod 里选 Clef、装了这么多 skill、画像都写好以后，每条消息的决策请求（effort 和 skill 在同一个请求里）都会超时。Clef 计第一段 1.5 万 input token；这次连同先发的一个探针共用了 11.2 万 token（按 Clef 的价格约 0.027 美元，在每天的免费额度之内），所以没有跑更多。
- **已知的问题题**（两次运行、两个变体、中英文都错的有 9 题：018、033、041、050、052、090、091、092、096）：
  - **只能由用户触发的 skill 挤掉了能加载的 gold**（033、090、091、092）：第一段的 Choice 把几乎全部概率给了只能由用户触发的那个（033 的 improve-codebase-architecture 0.98–1.00、090 的 grill-with-docs 0.99–1.00），能加载的 gold（codebase-design、grilling、domain-modeling）分不到 0.1，进不了第二段。提示是对的，推荐漏了。这是第一段只问一个 Choice 的结构问题：两类 skill 在同一个问题里互相抢概率。第 1 轮审查之后第一段拆成了两题（`skills.which` 只问能加载的，`skills.hint` 只问只能由用户触发的，见「开发」的排序一节），上面的数字都是拆分之前跑的，要重跑两个变体才知道这几题和整体的数字（#17 按用户的决定没有重跑）。
  - **第二段确认了诱导**：041（「这个会话想从 Opus 切到 Sonnet，命令怎么敲」，claude-api 0.91–0.93）、050（问 Graphiti 的一个参数，research 0.74–0.86），017（后台挂着 dev server，run 0.70–0.79，中立但这题不该推荐；8 次里错 7 次）。画像的「何时不用」没有挡住它们。
  - **第二段过严**：096（「ctrl+r 老跟 tmux 撞键」，第一段 keybindings-help 0.71–0.94，第二段只给 0.08–0.46）；018（在输入框上方常驻一条横栏，正是 plugin-authoring 说的 band，第二段只给 0.33–0.68，`profiles` 下还推了中立的 ui-ux-pro-max）；052（claude-api 和 typesafe-ai 之间拿不准，相关度都在 0.6 以下；053、109 也是 8 次里错 7 次）；099 只在 `profiles` 下错（code-review 0.52–0.65，security-review 在第一段只分到 0.03–0.05）。

### 已实测的引擎行为（2.1.289）

详细记录见 `docs/research/mods-testing-seam.md` 的第 10 节。

- 在同一个 dispatch 里，外层 hook 写入的 `$.state`，内层 hook 马上就能读到（kit 和真实引擎都实测过）。
- 外层 hook 的 `$` 被闭包带进内层 hook 后可以照常调用（kit 和真实引擎）。
- `prompt.submit` 的 text 与随后 `turn.start` 的 text 完全相同，`turn.start` 在 `prompt.submit` 的 `next(e)` 里面触发。只有主 agent 的轮才有 `turn.start`。
- 一轮进行中用户发的新消息：`prompt.submit` 带着这一轮的 `turnId`，消息在下一步作为 `queued_command` 附件送进同一轮，不会开始新的一轮。
- `$.session.messages()` 里，助手的输出每个 block 一行，工具结果是没有文字的 user 行，user 行只包含用户输入的文字。
- debug log 不会记录 `pluginConfigs` 里的 option 值（用假 key 验证过）。
- `agent.spawn` 的 `next(e)` 返回 `agentId` 之后才写进 `agents` 的计划，这个 agent 的第 0 步就已经按计划发出（#6，真实引擎：在 mod 外层和内层各挂一个探针，sonnet agent 第 0 步引擎给的是 `medium`，发出的是计划里的 `low`）。
- 一条消息里的几个 Agent 调用，`agent.spawn` 并发触发，各自的决策请求同时发出，先拿到回答的先启动（#6，真实引擎）。
- Workflow 的 `tool.call`（#8，真实引擎）：`e` 的键是 `script`、`tool`、`tool_use_id`；`next(e)` 返回 `{ ref, result: { status: 'async_launched', taskId, taskType, workflowName, runId, summary, transcriptDir, scriptPath }, text }`。`next({ ...e, script })` 改写的脚本就是工具运行的，也是 `scriptPath` 指向的持久化文件和 `workflows/wf_<runId>.json` 里记下的那一份。
- 返回 `{ ...result, context: [...] }` 时，引擎把 context 作为 `tool.call hook additional context: ...` 附在工具结果后面，主 agent 读得到（它引用过原文），用户看不到。
- 脚本有语法错误时，工具在启动任何东西之前同步检查（约 2 毫秒），`next` 返回 `{ ref, result: 'Error: Invalid workflow script: Script parse error: ...', text: '<tool_use_error>...', isError: true }`；在同一个 hook 里再调一次 `next(e)`，用原脚本可以正常启动。
- 工具返回后约 16 毫秒，运行的第一个 agent 就在它的 `turn.step`（index 0）出现。journal 里每个 agent 一行 `{ type: 'started', key, agentId, label, phase }`，`key` 是 prompt 和选项的哈希，所以改写选项会让缓存的 key 变化。
- 真实 Jev 加真实引擎（主 agent 是 sonnet）：一个 3 个 `agent()` 的脚本只发出一个请求（2737 输入 token，310 毫秒），决定 haiku、sonnet low、opus xhigh；三个 agent 的第 0 步在引擎里分别是 haiku（没有 effort）、sonnet low、opus xhigh，`modelUsage` 里三个模型都有用量。状态行是 `dp effort low | workflow routed 3 agents`，主 agent 的最后一句话复述了决定。
- 本机已有的真实脚本经过真实 Jev（Node 里直接用 `parseWorkflow`、`workflowBatches`、`readOutcomes`）：4–7 个调用点的脚本各发一个请求（8–10 个问题，4.0–4.7k 输入 token，545–686 毫秒；每个调用的问题文字约 600 token，所以输入的大小随调用数增长，不受 `contextTokens` 限制，那只管 state），决定多是 sonnet low 或 medium，只有一个涉及付费和购物车的步骤是 xhigh。
- 退回模式（真实引擎）：主 agent 读到拒绝文字后照着改并重新提交，原话是「路由插件（Dispatch Pilot）拦下了这次提交，并给每个 agent 指定了 model 和 effort。我把这些选项写进对应的 agent() 调用，其余内容不变，重新提交」；第二次提交直接放行（没有第二次决策请求），agent 按写进去的模型和 effort 运行。
- 主 agent 自己写 Workflow 时常把 prompt 放进数组再 `map`，这样的调用点这里读不了（见上节）；要测改写，得让它把每个 `agent()` 单独写出来。
- Workflow 兜底（#9，`claude -p --allowedTools "Workflow"`，sonnet 作主 agent，jev-pilot 已关，`--strict-mcp-config`；探针 mod 在 scratchpad，已清理）：
  - **`turn.step` 的 model 原样发给 API，不解析别名。** 在 workflow agent 的每一步写 `model: 'haiku'`：debug log 是 `dispatching to firstParty model=haiku`，API 回 404 `model: haiku`，引擎打印 `[claude-code:unrecognized_model]`，这个 agent 以 null 结束。写 `claude-haiku-4-5` 则每一步都正常，`usage.model` 是 `claude-haiku-4-5-20251001`，请求里的 `medium` effort 被引擎去掉。404 之后引擎重试那一步时 `e.model` 是 `claude-sonnet-5`（不是 `claude-sonnet-5-5`），所以比较模型要按家族。
  - **journal 的格式**：第一行 `{"type":"launched"}`；每个 agent 在第 0 步之前写一行 `{"type":"started","key":"v2:<hash>","agentId":"...","label":"..."}`，脚本调用过 `phase()` 时多一个 `"phase"`；agent 结束时写 `{"type":"result","key":...,"agentId":...,"result":...}`。
  - **不写 label 时**，journal 的 `label` 是 prompt：空白折叠成一个空格、截到 60 个字符（`'Short first line.\nReply with exactly ...'` 记成 `"Short first line. Reply with exactly the word named and noth"`），`agent-<agentId>.meta.json` 的 `description` 也是它；写了 label 时两处都是 label。meta.json 在第 0 步之前就在。
  - **agent 第 0 步开始时，它的 transcript（`agent-<agentId>.jsonl`）还不在磁盘上**（5 个 agent 都是），50–110 毫秒后出现，第 0 步被 hook 挡着时也会写入。第一行是 user 消息：`[Workflow harness — computed task] ... The computed task text follows:\n` 加上任务，任务每一行前面缩进两个空格（空行也是）。
  - **`name` 按脚本 `meta.name` 解析，不是文件名**：`.claude/workflows/probe-file.js`（`meta.name: 'probe-named'`）用 `name: 'probe-named'` 运行。`name` 提交时 `e` 的键是 `name`、`tool`、`tool_use_id`，结果的 `scriptPath` 是会话目录下的持久化副本（`workflows/scripts/<name>-<runId>.js`）；`scriptPath` 提交时结果的 `scriptPath` 就是那个文件，每次运行一个新的 `runId` 和 `transcriptDir`。
  - **运行的第一个 agent 可能比 Workflow 的 `tool.call` hook 先动**：探针的 hook 在 `next(e)` 返回后记下运行目录，第一个 agent 的第 0 步比它早 1 毫秒；装上本 mod 后，第一个 agent 在工具调用处理完之前约 10 毫秒启动，第 0 步等它处理完才发出。fan-out 的几个 agent 的第 0 步相隔 3 毫秒。
  - **常驻提示到达主 agent**：`tool.describe` 在 Workflow 的描述后面附的文字，主 agent 能原样引用出来。
  - **端到端**（不用 key：先加载的探针插件替 `$.http.fetch` 回答 `api.typesafe.ai` 的请求，`next` 不往下走；另一个后加载的探针记下每一步发出的样子）：`scriptPath` 提交的脚本里，带 label 的调用、不写 label 的调用都在运行开始时判断，各自的 agent 每一步按 `claude-haiku-4-5` 发出、由 `claude-haiku-4-5-20251001` 作答；prompt 是数据的调用，agent 启动时等 transcript（约 100 毫秒）再判断，每一步按 `claude-opus-5-5`、`high` 发出。状态行 `by label: routed 3 agents`，主 agent 读到了说明。直接交来的脚本（本功能注册在 `workflow-agents` 内层之后）：`workflow-agents` 把带 label 的调用写成 haiku，那个 agent 每一步是引擎按脚本解析的 `claude-haiku-4-5-20251001`；prompt 是数据的调用由本功能在 agent 启动时判断，按 `claude-opus-5-5`、`high` 发出；状态行 `workflow routed 1 agent (1 as written) | by label: routed 1 agent`。两段说明作为同一个 `hook_additional_context` 附件到达主 agent，本功能的在前。用假 key 时（请求得到 401）各 agent 按引擎原样运行，状态行写明 `jev: key refused (HTTP 401)`。
- 斜杠命令作为 `claude -p` 的整个 prompt 时在本地运行，不调用模型（`claude -p "/dp"`）。引擎会在命令回答的前面加上插件名（`dispatch-pilot: ...`），所以命令的文字自己不要再带前缀。`--input-format stream-json` 里连续发多条用户消息，其中的 `/dp ...` 照常当斜杠命令处理，`$.state` 在同一个进程里跨消息保留。
- `$.command.register` 在 `session.start` 的 `next(e)` 之后调用，命令当场被列出；`$.store` 在 `next(e)` 之前就能读，读到上次保存的内容，两次 `claude -p` 之间也保留（文件在配置目录的 `plugins/store/` 下，`--plugin-dir` 加载时叫 `dispatch-pilot_inline-<hash>.json`）。
- `session.measure` 在订阅会话里主 agent 的每一轮之后触发一次，读数有 `context`（`tokens`、`window`、`percent`）、`rateLimits`（`five_hour` 和 `seven_day`，各带 `percentUsed` 和 `resetsAt`）和 `cost.usd`；matcher `{ context: { window: /(?:)/ } }` 在真实引擎里命中。headless 下状态行以 `ui_status` 事件输出（也写进 debug log），`to: 'debug'` 的日志不会出现在输出流里。
- 带 `options` 的字符串选项，值不在列表里时，引擎读作默认值并给出警告：`option decisionModel in settings is not one of jev, clef; it reads as the default, jev`（kit 实测）。
- Cloudflare 的真实错误响应（假 token 实测）：HTTP 401，`{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}`。引擎自己的 `$.http.fetch` 日志会记下完整的请求地址，其中有 account ID（真实引擎实测）。
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
- **一步里的工具调用在这一步的流还没结束时就开始执行**：`tool.call` 的开始和结束都早于这一步的 stop chunk，也早于 `turn.step` 的 `next(e)` 返回。所以在 `tool.call` 里读不到这一步完整的 `answer`，需要的话在 `turn.step` 里边转发边收集 text chunk（`midturn-effort` 就是这样做的）。下一步的 `turn.step` 开始时，上一步的工具结果都已经回来了。
- **在 `tool.call` 里发出、不等待的 `$.http.fetch`，hook 返回后照常完成**，在之后另一次 dispatch（下一步的 `turn.step`）里取用没有问题；它回调里的 `$.clock.now()` 也照常可用。实测：Sonnet 5.5，每步重判，Jev 回答用了 313–330 ms，都在下一步开始前到达。
- **Sonnet 5.5 上一轮中途改 effort 不会返回 400**（#5 的验证项）。用一个每步改 effort 的探针 mod 测了三种配置，每轮 4–5 步，都正常完成：思考开着（默认），low → high → medium → high；`"alwaysThinkingEnabled": false`，同样的序列；`MAX_THINKING_TOKENS=0`，high → xhigh → low → max。API 文档说的 400 是 `thinking: {type: "between_tools"}` 加上与当前不同的逐条消息 effort（`messages.N: output_config.effort ... differs from ... in effect`），以及 `between_tools` 配 `xhigh`/`max`；Claude Code 2.1.289 在上面几种配置下都没有触发它（没有抓原始请求体，只看结果）。改档也没有打断缓存：每一步都从缓存读到整个前缀（约 2.85 万 token，新写入 0），没有因为改档重新写缓存。所以 Sonnet 5.5 上不需要关掉中途重判。
- PreToolUse settings hook 拒绝一个调用时，`tool.call` 拿到的是 `{ isError: true, text: <拒绝理由> }`，和工具自己报错一样；包一层 `classic.PreToolUse`，按 `tool_use_id` 才能区分（kit 实测，真实引擎里这一层照常触发）。用户在权限对话框里拒绝、或权限规则拒绝时，错误文字是 Claude Code 固定的几句（`The user doesn't want to proceed with this tool use...`、`Permission to use ... has been denied`、`Permission for this tool use was denied...`），从 2.1.289 的二进制里查到；kit 里无法触发真实的权限对话框，只能按这些文字模拟。
- 强制升档（#7，`claude -p` 实测，jev-pilot 已关）：
  - **`turn.step` 的 `model` 不认别名。** 把一个 haiku 步骤的 `model` 改成 `sonnet`：主 agent 报 `[claude-code:unrecognized_model] ... There's an issue with the selected model (sonnet)`，进程退出码 1；派出 agent 报 `Agent terminated early due to an API error: ... (error type model_not_found, HTTP 404 ...)`。改成 `claude-sonnet-5-5` 则正常：一个 haiku 派出 agent（`claude-haiku-4-5-20251001`，引擎给它的步骤没有 effort）从第 1 步起每一步都发 `claude-sonnet-5-5`，`turn.step` 结果的 `usage.model` 也是它，agent 正常交回结果。引擎每一步都还是把原来的 haiku 当作这一步的 `e.model`（改写不改变引擎下一步给的值），所以要在每一步都改。
  - **`agent.spawn` 的 `next(e)` 返回的 `model` 是解析后的完整 id**：`sonnet` 解析成 `claude-sonnet-5-5`，`haiku` 解析成 `claude-haiku-4-5-20251001`。
  - **`classic.PreToolUse` 在派出 agent 的调用上也触发**，事件里没有 `agentId`（字段是 `tool`、`tool_use_id` 和工具自己的参数），`tool_use_id` 和这个调用的 `tool.call` 一致。settings hook 退出码 2 拦下调用时，`classic.PreToolUse` 的结果是 `{ deny: "PreToolUse:Bash hook error: [...]: <hook 的 stderr>" }`，`tool.call` 的结果是 `{ isError: true, text: <同一段> }`。
  - **一个运行中的派出 agent 的记录可以在 `tool.call` 里读到**：`$.session.messages({ agentId })` 返回的第 0 行是 user 行，文字就是主 agent 写给它的任务；助手的输出每个 block 一行（有一行文字是空的，多半是思考块），一个调用的 `toolUses` 项在这个调用的 `tool.call` 刚结束时还没有 `text`，到下一次读时才带着 `text` 和 `isError`；工具结果是文字为空、带 `toolResults` 的 user 行。下一步的 `turn.step` 开始时，上一步所有调用的结果都已经在里面。
  - **端到端**（决策请求由一个排在 dispatch-pilot 之后、拦 `http.fetch` 的探针 mod 用固定回答作答，不联网）：主 agent 在 Opus 5.5 上，开始时决定 medium，连续两次 `cat` 不存在的文件（`Bash` 报错）后，第 2 步发出前发出 `[midturn.level, escalation.expected]` 的请求，state 里 `trouble` 是 `2 tool calls have failed while working on this request`，`recent_steps` 是真实记录里的两步（`Failed: Read first nonexistent file`），回答「不是预期内」（p 0.05），探针看到第 2 步的 `effort=high`，模型仍是 `claude-opus-5-5`；一个被决定用 haiku 的 agent 连续两次失败后，第 2 步前发出只带 `escalation.expected` 的请求，探针看到这一步和之后的步骤都是 `claude-sonnet-5-5`，第三条命令成功，agent 正常交回结果。
- 从 marketplace 安装（#18，2026-10-05，`CLAUDE_CONFIG_DIR` 指向一个空目录，不配密钥，没有跑 `configure`）：
  - `plugin marketplace add <本地目录>` 记的来源是 `directory`，`installLocation` 就是那个目录，不复制；`plugin install dispatch-pilot@alex-mods --scope user` 把 mod 目录**复制成快照**放进 `<配置目录>/plugins/cache/alex-mods/dispatch-pilot/<version>`（整个目录，包括 `eval/`、`tests/`，约 9 MB），`plugin list --json` 的 `installPath` 指向它，`readFromFolder` 另记着原目录；`installed_plugins.json` 记着装的那一刻的 git commit。所以改了源目录要重新安装才会进快照。
  - `plugin details dispatch-pilot@alex-mods` 显示 0 个 skill、agent、hook、MCP 服务器和 LSP 服务器，常驻开销约 0 token：mod 的处理函数不在它的统计里，mod 在运行时附加和替换的内容它也看不到。描述取的是 marketplace 条目的 `description`，不是 plugin.json 的。`install` 打印 `31 userConfig options not yet set — run /plugin configure dispatch-pilot@alex-mods in Claude Code, or pass --config KEY=VALUE`：31 个选项都算没设，包括有默认值的。
  - **`CLAUDE_CONFIG_DIR` 没有把这两条命令完全隔离在那个目录里。** `plugin marketplace list` 在它下面只列出内置的 `anthropic-plugin-directory`，`add`、`install`、`list`、`details` 的结果都写在它下面，真实的 `settings.json` 和 `installed_plugins.json` 没变；但真实的 `~/.claude/plugins/known_marketplaces.json` 里 `claude-plugins-official` 的 `lastUpdated` 在 `add` 的同一秒被改了，`plugin-directory-cache-v2.json` 的修改时间也是那一刻，`plugins/cache/` 目录的修改时间正好是 `install` 的那一秒（`marketplaces/` 里没有新目录，真实的 cache 和 marketplaces 里都没有 `alex-mods`）。原因没有查明：像是它们刷新官方 marketplace 时用了真实的目录，也可能是别的会话碰巧在同一秒刷新。之后在另一个空目录下跑的 `plugin test`、`plugin validate` 和 `plugin tag --dry-run` 没有再改动这些文件。要验证安装，别把 `CLAUDE_CONFIG_DIR` 当成完全隔离。
