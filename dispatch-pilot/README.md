# Dispatch Pilot

Dispatch Pilot 在 Claude 之外调用一个决策模型（TypeSafe 的 Jev 或 Cloudflare Workers AI 的 Clef，在配置里二选一），替你决定 Claude Code 怎么干活。现阶段做两件事：**每次你发消息时，判断主 agent 这一轮该用哪档 effort**，并让这一轮的每一步都按这一档发出，一轮进行中还会每隔几步、以及在主 agent 派出 agent、启动 Workflow 或加载 skill 时重新判断（#5，见下文「一轮中途重新判断」）；**主 agent 每派出一个 agent，判断它该用哪个模型、哪档 effort**（#6）。主 agent 的模型从不改变，所以 prompt cache 不受影响（ADR 0001）。另外，主 agent 不再读完整的 skill 列表，改由决策模型在你发消息时挑出相关的几个 skill 推荐给它（#10，见下文「skill：隐藏列表，发消息时推荐」）：它先按每个 skill 的中英双语画像给全部 skill 排序，再补读前几名的 SKILL.md 开头，逐个判断是否合适（#11）；一轮进行中，主 agent 还可以用 `find_skill` 工具按需查询 skill（#12，见下文「find_skill：主 agent 中途查询 skill」）。Workflow 里的 agent 等功能由后续的票实现，完整设计见 spec（issue #1）。用斜杠命令 `/dp` 可以开关整个 mod 或其中的单项功能、临时锁定 effort、查看最近的决策和理由（#13，见下文「控制：`/dp`」）。

测试环境：Claude Code 2.1.289（Opus 5.5，订阅登录）、Node 26.5、jev-1.13.0、Clef（Cloudflare Workers AI，2026-10-04）。

## 它做什么

- 你发出一条消息时（在终端输入、用 `claude -p`、通过 Remote Control 或 Slack，或由插件代你输入），Dispatch Pilot 把这条消息和最近几条对话发给决策模型（Jev 或 Clef），问它「这项工作需要多少逐步推理」。它给出 low、medium、high、xhigh、max 五档各自的概率。
- 取概率最高的一档，并列时取较高的一档。`max` 只在它自己的概率达到 `thetaMax` 时才使用，否则取其余四档中概率最高的一档。
- 这一轮的每个模型请求都按这一档发出。Claude Code 每一步都会把 effort 恢复成会话设置，所以每一步都要重新设置。模型按引擎给的原样发出，包括引擎过载时自动换用的模型。
- 一轮进行中你又发了一条消息：这条消息会在下一步送进当前这一轮，所以它的判断从下一步起接管这一轮。
- 不是你本人发的新消息（子 agent 交回的结果、后台任务通知、其他会话的消息、插件自己发的消息）、斜杠命令和空消息都不判断，也不改变任何一轮的 effort。
- 派出 agent 见下一节。Workflow 里的 agent：本阶段不做改动，按引擎原样发出。

### 派出 agent

- 主 agent 用 Agent 工具派出一个 agent 时，Dispatch Pilot 在它启动前问一次决策模型，同一个请求里问两件事：它该用哪个模型（默认在 haiku、sonnet、opus 中选，打开 `agentFable` 后加入 fable），以及它的每一步该用哪档 effort。模型直接改在这次派发上；effort 在这个 agent 的每一步都重新设置。选了 haiku 就不设 effort（haiku 不支持）。
- 发给决策模型的是主 agent 写给这个 agent 的任务（`prompt`）、简短描述、agent 类型，以及你这一轮说的话：开始这一轮的那条消息，加上这一轮进行中你又发的消息。和发消息时一样，发送前对 secret 脱敏，总长度按 token 预算（`contextTokens`）截断，你的话最多占三分之一。
- 模型的优先级：
  1. 你在这一轮的消息里为这项工作点名的模型，一定照办，即使它不在可选范围内（例如没打开 `agentFable` 时点名 fable）。
  2. 否则用决策模型选的模型。
  3. 主 agent 自己指定了模型时，这个指定作为强提示交给决策模型；只有决策模型选了别的模型、而且置信度达到 `agentOverride`（默认 0.6）时才推翻，否则保留主 agent 的指定。
- 你在消息里排除的模型（例如「这周额度快用完了，别用 opus」）不会被选中，主 agent 指定了它也会被换掉，换成决策模型在其余模型里最看好的那个。
- 「点名」和「排除」都由决策模型结合上下文判断，而不是看消息里有没有模型名：模型名只是作为产品被讨论（「比较一下 haiku 和 sonnet」）、说的是之前写代码的模型、是否定说法（「别用 opus 了，用 haiku 就行」里的 opus），或者点名针对的是另一项工作（「调研那种活儿用 haiku，实现你看着办」之于实现的 agent），都不算为这个 agent 点名。消息里提到了哪个模型，请求里才问它是否被点名或排除。
- 只在派出时判断一次。一条消息里派出几个 agent，就逐个判断，每个拿到自己的回答就立刻放行，不互相等待。
- 不处理的 agent：fork 出来的 agent（它总是用父 agent 的模型）和 agent team 的 teammate（它会长期存在、处理很多任务，派出时的一次判断看不到这些任务）。
- 失败时放行：决策模型超时、出错或回答无法解析时，agent 按主 agent 原来的要求启动，用引擎自己的 effort，状态行写明原因。
- 每个决定都记进 `/dp log`：选了什么模型和 effort、是哪个 agent、理由（模型是谁定的、决策模型的选择和置信度、被排除的模型、effort 各档的概率）。`/dp dispatched-agents off` 单独关掉这项功能，之后派出的 agent 都按主 agent 原来的要求启动。

### 一轮中途重新判断

- 一轮进行中，每到第 N 步（`rejudgeEvery`，默认 3，即第 3、6、9……步，从 0 数），以及主 agent 派出 agent、启动 Workflow 或加载 skill 时，Dispatch Pilot 再问一次决策模型：剩下的工作还需要多少逐步推理。只判断 effort，不推荐 skill。
- 问题在主 agent 的工具开始执行时就发出，工具运行期间得到回答，下一步发出前取用，所以一般不增加等待。回答还没到时，下一步最多再等 `rejudgeWaitMs`（默认 300 毫秒）；仍然没有就沿用上一步的 effort，状态行注明 `(late)`，这个回答到了以后用在再下一步。请求失败时同样沿用，状态行写明原因。
- 防抖：升档要求决策模型的置信度不低于 `thetaUp`；降档要求不低于 `thetaDown`（更高的门槛），而且每次只降一档；升档后 `holdSteps` 步之内不降档；用 `max` 仍要它自己的概率达到 `thetaMax`。
- 决策模型读到的是：这一轮你的消息，即将发出的是第几步，当前的 effort，这一轮的计数（判断次数、档位变化次数、失败的工具调用数、被 hook 拦截的次数），以及最近几步（`rejudgeSteps`，默认 4）的摘要。每一步的摘要是主 agent 在那一步最后写的文字，加上它调用的工具和一句话结果，结果以「成功：」「失败：」「被 hook 拦截：」「用户拒绝：」开头（你的消息不含中文时用 `Success:`、`Failed:`、`Blocked by hook:`、`Denied by user:`），正在运行的那个工具写「进行中：」。结果后面只说明这次调用在做什么：调用自带的 `description`、skill 或 Workflow 的名字、文件路径的最后两段、搜索的 pattern 或 query、URL，或者 shell 命令的第一行。**不包含文件内容、工具写入的内容和工具输出**；同样脱敏，同样受 `contextTokens` 限制（你的消息最多占一半）。
- 这些情况不重判：你用 `/dp lock` 锁定了 effort；这一轮开始时没有经过路由（不是你本人发的消息，或者那次判断失败），整轮都用会话自己的 effort；模型不接受 effort 档位（haiku 这类）。`/dp midturn-effort off` 关掉这项功能。
- 这一轮第一次重判之后，状态行多出一段，例如 `dp effort xhigh | steps 7, judged 3, changed 1`：已经发出的步数、这一轮的判断次数（包括发消息时的那一次）、档位变化的次数。
- 每次重判都记进 debug log 和 `/dp log`，例如 `#5 midturn-effort: effort xhigh (was medium) for step 3 (every 3 steps): p low 0.00, medium 0.05, high 0.15, xhigh 0.70, max 0.10; confidence 0.80; up`。
- 在 Sonnet 5.5 上也照常重判：实测一轮中途改 effort 不会返回 400（见「开发」里的「已实测的引擎行为」）。

### 失败时放行

如果决策模型超时（默认 1.5 秒）、出错、回答无法解析，或者没有配置 key（Clef 是 account ID 和 token），消息照常进入，不会额外等待，这一轮使用会话自己的 effort。状态行会写明原因，例如 `dp effort xhigh (not routed) | jev: no answer in 1500 ms`、`dp effort xhigh (not routed) | clef: key refused (HTTP 401)`。选了其中一个就只用它，失败时不会改用另一个。Clef 的免费额度当天用完时写 `clef: daily quota used up`（Cloudflare 的错误码 3036），和一时繁忙的 `clef: busy (HTTP 429)`（错误码 3040）区分开：两者的 HTTP 状态都是 429。

### 状态行

状态行只有一行，例如 `dp effort high`。`(not routed)` 表示这一轮没有经过路由，用的是会话自己的 effort；`(locked)` 表示你用 `/dp lock` 锁定了 effort；`dp off` 表示你用 `/dp off` 关掉了整个 mod。本仓库约定界面里只用单宽字符，而中文是双宽字符，所以状态行用英文。`claude -p` 模式没有状态行，内容会写进 debug log。

派出 agent 后，状态行后面会加一段，显示最近一个派出 agent 的模型和 effort，例如 `dp effort high | agent sonnet high`。`(you)` 表示模型是你点名的，`(kept)` 表示保留了主 agent 的指定；`agent not routed (jev: no answer in 1500 ms)` 表示这个 agent 没有经过路由，括号里是原因。

### 发给决策模型的内容

- `user_message` 是你这条消息。`recent_context` 是之前最近的几条消息，同一方连续写的几行算作一条。每条只有文字和调用过的工具名（例如 `[tools: Read, Bash (failed)]`），**不包含文件内容和工具输出**。
- 发送前会对常见的 secret 格式脱敏，替换成 `[REDACTED]`。覆盖的格式包括各家的 API key 和 token、`password=...` 这类赋值、URL 里的密码、私钥和 JWT。
- 总长度按 token 预算截断。中文约 1 个字算 1 个 token，其他文字约 4 个字符算 1 个 token，因此中英文按同一个尺度截断。预算先保证你的消息，剩下的分给最近的消息：旧消息整条丢弃，最新一条放不下时保留开头和结尾。
- 每次请求的结果和每次决定都写进 debug log（`claude --debug-file <path>`），不会进入对话。
- skill 推荐打开时，同一个请求里还有本会话每个 skill 的名字和画像（还没有画像的用描述）；需要第二个请求时，它带着排在前面的几个 skill 的描述、画像和 SKILL.md 正文的开头（约 700 个英文字符，先脱敏），见下一节。画像本身由你自己的 Claude 登录生成（`skillsProfileModel`），不经过决策模型的提供方。

### skill：隐藏列表，发消息时推荐

Claude Code 在会话开始时把所有 skill 的名字和描述作为一条附件（`skill_listing`）交给主 agent，装的 skill 多时这一段很长：本机 66 个 skill，实测每个会话多出约 6.6k input token。Dispatch Pilot 对主 agent 拦下这条附件（ADR 0002），改为在你每次发消息时推荐相关的几个：

- **推荐分两段。** 第一段和 effort 在同一个决策请求里，多问一个问题：在本会话主 agent 能加载的 skill 中，加上只能由你本人触发的 skill，再加上「都不合适」，哪个最适合这条消息要做的工作？每个 skill 用它的画像描述（见下一条），还没有画像的用描述。这一段的概率在全部选项之间加起来为 1，只用来排序。第一段分到 0.1 以上的 skill 里，最多取前 `skillsShortlist` 个（默认 4）进入第二段：再发一个请求，问的是同样的消息和对话，补上每个 skill 的 SKILL.md 正文开头，对每个 skill 单独问「它是否正好做这条消息要做的那种工作」，回答的概率（0 到 1）就是相关度，是绝对值，几个 skill 可以同时很高，也可以都很低。相关度不低于 `skillsMinRelevance`（默认 0.7）的 skill，最多 `skillsMax` 个，按相关度从高到低写成一个文字块附在消息后面交给主 agent，内容是名字、相关度和描述。主 agent 用 Skill 工具按名字加载，也可以不理会。没有合适的就不附任何东西；第一段没有哪个 skill 到 0.1 时不发第二个请求。
- **两个请求共用一次等待。** 消息最多等 `timeoutMs`：第二个请求只能用第一个请求剩下的时间。第二个请求超时或失败时，这条消息不推荐 skill，照常进入，状态行写明原因，例如 `skills not rated (jev: no answer in 1100 ms)`；effort 的判断不受影响。实测（真实引擎、Jev）第一段约 0.3–0.5 秒，第二段约 0.26 秒，合计在 1.5 秒之内。
- **中英双语的 skill 画像。** 会话开始时，Dispatch Pilot 在后台让一个便宜的模型（`skillsProfileModel`，默认 haiku，通过你自己的 Claude Code 登录调用，算在你的用量里）读每个 skill 的 SKILL.md，写一份简短的画像：做什么、什么时候用、什么时候不用，英文和中文各一份。这样中文消息也能对上英文描述的 skill，「什么时候不用」还能挡掉似是而非的匹配。画像按 SKILL.md 的内容（以及模型名、提示词版本）做哈希，存在 `$.store` 里，下次会话直接用；SKILL.md 改了才重写。每次会话开始最多写 `skillsProfilesPerSession` 份（默认 30，0 表示不写），其余留给以后的会话，第一次装了很多 skill 时不会一下子花掉很多用量。写的过程不阻塞你的消息：写好一份用一份，还没写好或写失败的 skill 用名字和描述。没有 SKILL.md 的 skill（内置 skill）从描述写画像。每份画像的每个字段都有长度上限，最多保留 500 份（超过时删掉最早写的、本会话不用的，删到 400 份），在 `$.store` 4 MiB 的总上限里只占几百 KB。`/dp skill-profiles off` 停止写画像，并改回只用名字和描述排序。实测 haiku 写一份约 2.2–2.6 秒、约 2k 输入和 200 输出 token。
- **已经推荐过的只再提名字。** 同一段对话里描述过一次的 skill，再推荐时只写名字和相关度。`/compact` 和 `/clear` 之后重新给描述。
- **只能由你触发的 skill**（SKILL.md 的 frontmatter 写了 `disable-model-invocation: true`）从不推荐给主 agent，Skill 工具也加载不了它们。合适时状态行提示你自己输入，例如 `try /grill-me`。settings 的 `skillOverrides` 设成 `off` 的 skill 不提示。
- **主 agent 仍然可以按名字加载任何 skill。** 隐藏的只是列表，skill 本身和 Skill 工具不变（已实测，包括 `anthropic-skills:` 开头的同步 skill）。`skillsAlwaysListed` 里的 skill 留在列表里，推荐到它们时只写名字。派出 agent 和 Workflow 里的 agent 的列表不动。
- **什么时候不隐藏。** 没有配置决策模型（Jev 没有 key，Clef 缺 account ID 或 token）、读不到本会话的 skill，或者 skill 推荐被关掉时，主 agent 照常读完整的列表。
- **开关。** `/dp skills off`（以及 `/dp off`）停止推荐，并把列表还给主 agent：之后引擎再问到的列表原样放行；这段对话里已经被拦下的列表（引擎在整段对话里沿用当时的回答），随你的下一条消息作为附件补给主 agent，只补一次，`/compact` 之后再补一次。`/dp skills on` 恢复推荐；已经还给主 agent 的列表留在这段对话里，下一段对话（`/clear` 或新会话）起才重新隐藏。
- **状态行和日志。** 状态行写出这条消息推荐的 skill 和给你的提示，例如 `dp effort high | skills tdd, code-review | try /grill-me`。每次推荐都记进决策日志（`/dp log`）和 debug log，写出第一段排在前面的 skill 和它们分到的概率、第二段每个 skill 的相关度，例如 `suggested code-review for "帮我审一下这个分支相对 main 的改动": first code-review 1.00, none 0.00; fits code-review 0.96; suggested from 0.70, at most 3`。会话开始时 debug log 写一行画像的情况（`skill profiles: 3 kept, 84 to write with haiku (at most 30 this session)`），每写好一份再写一行。

### find_skill：主 agent 中途查询 skill

推荐只在你发消息时做一次。一轮进行中，主 agent 发现手头的工作可能有合适的 skill（例如要处理某种文件格式、用某个服务的工具，或者按某种流程审查、规划、发布），可以调用 `find_skill` 工具，用几个词说明要做的工作：

- **同一套排序。** 请求和发消息时推荐用的是同一个排序入口、同样的两段（同样的画像、同样的第二段补读）、同样的候选 skill（包括只能由你触发的 skill，好让相关度和推荐时可比），最近的对话也按同样的规则截取（`contextMessages`、`contextTokens`，不含文件内容和工具输出，先脱敏）；只是 `user_message` 换成主 agent 写的查询，第一段只问 skill，不问 effort。两个请求各自最多等 `timeoutMs`。
- **返回什么。** 相关度（第二段的绝对值）不低于 `findSkillMinRelevance`（默认 0.5，比推荐的门槛低：这是主 agent 主动问的，它会自己看描述再决定）的 skill，最多 `findSkillMax` 个，按相关度从高到低，每个写名字（Skill 工具接受的写法，同步来的 skill 带 `anthropic-skills:` 前缀）、相关度和描述。主 agent 再用 Skill 工具按名字加载。都不够相关时，回答没有合适的 skill，并提示主 agent 不用 skill 继续，或者按名字加载它已知的 skill。
- **只在被调用时回答。** 一轮中途不会主动推送 skill；结果只作为这次工具调用的回答交给主 agent。
- **不返回的 skill。** 只能由你本人触发的 skill 从不返回给主 agent，即使它最相关；`skillsNeverSuggested` 里的 skill 既不问也不返回。派出 agent 调用时，工具让它从自己的 skill 列表里挑（派出 agent 的列表没有隐藏），不发请求。
- **不影响缓存。** 工具在会话开始时注册（只在配置了决策模型时），描述固定不变，不含任何会话内容。实测它是延迟加载的工具：主 agent 的工具列表里先只有它的名字，用 ToolSearch 加载之后才调用。
- **开关。** `/dp find-skill off`（以及 `/dp off`）之后，工具仍然注册着，调用时只回答它已关闭、可以用 `/dp find-skill on` 打开，不发请求。它和 skill 推荐的开关 `skills` 互相独立：推荐关掉时 `find_skill` 照常工作（会话开始没有读 skill 目录的话，第一次调用时再读）。
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

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
```

Dispatch Pilot 不能和 jev-pilot 同时启用：两者都在 `turn.step` 上改 effort，会互相覆盖。请先停用 jev-pilot，可以在 `/plugin` 里关掉它，也可以在设置里写 `"enabledPlugins": { "jev-pilot@jev-pilot": false }`。

## 配置

在 `/config` 里设置，或写在 settings 的 `pluginConfigs` 里：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `decisionModel` | `jev` | 决策模型：`jev`（TypeSafe）或 `clef`（Cloudflare Workers AI），在 `/config` 里是下拉选择。选了一个就只用它，没有备用。填了这两个之外的值，引擎会按默认值 `jev` 处理并给出警告。 |
| `typesafeApiKey` | 空 | 选 `jev` 时用：TypeSafe 的 API key，是敏感字段，保存在安全存储里。为空时不发送任何请求。 |
| `cloudflareAccountId` | 空 | 选 `clef` 时用：运行 Workers AI 的 Cloudflare account ID，是敏感字段。为空时不发送任何请求。它是请求地址的一部分，Claude Code 自己的 debug log 会记下请求地址，所以会出现在那里；mod 自己写的日志行会把它遮掉。 |
| `cloudflareApiToken` | 空 | 选 `clef` 时用：能调用 Workers AI 的 Cloudflare API token（控制台里 Workers AI，Use REST API，Create a Workers AI API Token），是敏感字段。为空时不发送任何请求。 |
| `timeoutMs` | 1500 | 等待决策模型的最长时间，范围 200–8000 毫秒。Clef 比 Jev 慢（见「待评测」），选 Clef 时建议先调到 3000 左右。 |
| `contextMessages` | 4 | 随你的消息一起发送的最近消息条数，范围 0–32。 |
| `contextTokens` | 2000 | 你的消息加上最近对话的 token 预算，范围 100–16000。 |
| `thetaMax` | 0.5 | 使用 `max` 所需的最低概率，范围 0–1。发消息时、一轮中途和派出 agent 的 effort 都用这个门槛。 |
| `rejudgeEvery` | 3 | 一轮进行中每到第几步重新判断一次，范围 0–50；0 表示不按步数重判（派出 agent、启动 Workflow、加载 skill 时仍会重判）。 |
| `rejudgeSteps` | 4 | 重判时决策模型读到的最近步数，范围 1–16。 |
| `rejudgeWaitMs` | 300 | 重判的回答还没到时，下一步最多再等多久，范围 0–2000 毫秒。 |
| `thetaUp` | 0.4 | 中途升档所需的最低置信度，范围 0–1。 |
| `thetaDown` | 0.6 | 中途降档所需的最低置信度，范围 0–1；低于 `thetaUp` 时按 `thetaUp` 算。 |
| `holdSteps` | 3 | 中途升档之后，多少步之内不降档，范围 0–50。 |
| `agentFable` | 关 | 打开后，派出 agent 的可选模型加入 fable（比 opus 更贵）。你自己点名 fable 时不受这个开关限制。 |
| `agentOverride` | 0.6 | 主 agent 为派出的 agent 指定了模型时，决策模型的选择要达到这个置信度才推翻它，范围 0–1。 |
| `skillsMax` | 3 | 一条消息最多推荐几个 skill，范围 0–10。 |
| `skillsMinRelevance` | 0.7 | 推荐一个 skill 所需的最低相关度，范围 0–1。相关度是第二段里决策模型对「这个 skill 是否正好做这条消息要做的那种工作」回答「是」的概率，每个 skill 单独判断（#11 起；#10 用的是第一段里分到的概率）。 |
| `skillsShortlist` | 4 | 第二段补读正文、逐个判断的 skill 最多几个（第一段排在最前、分到 0.1 以上的），范围 1–10。 |
| `skillsProfileModel` | `haiku` | 写 skill 画像的模型，写别名（`haiku`）或完整的模型 id。通过你的 Claude Code 登录调用，算在你的用量里。换了模型，所有画像会重写。 |
| `skillsProfilesPerSession` | 30 | 每次会话开始时最多写几份还没有的画像，范围 0–500；0 表示不写（已有的照常用）。 |
| `skillsAlwaysListed` | 空 | 一直留在主 agent 的 skill 列表里的 skill，写列表里的名字（同步来的 skill 要带前缀，例如 `anthropic-skills:pdf`）。 |
| `skillsNeverSuggested` | 空 | 从不推荐给主 agent、也不提示你的 skill，同样写列表里的名字。它们照常安装，Skill 工具照样能按名字加载。`find_skill` 也不返回它们。 |
| `findSkillMax` | 5 | `find_skill` 一次最多返回几个 skill，范围 1–10。 |
| `findSkillMinRelevance` | 0.5 | `find_skill` 返回一个 skill 所需的最低相关度，范围 0–1。相关度的含义和 `skillsMinRelevance` 相同。 |

`contextMessages`、`contextTokens`、`thetaMax` 和 `agentOverride` 的默认值是暂定的，评测（#4、#15、#17）之后会更新；中途重判的几项（`rejudgeEvery` 到 `holdSteps`）同样是暂定的，由 #14 的评测校准。`skillsMinRelevance`、`findSkillMinRelevance` 和 `skillsShortlist` 同样是暂定的：#11 用真实的 Jev 在 21 条消息上定了起点（见「待评测」），评测（#16）之后会更新。

## 待评测

还没有数据的事，留给评测票（#17；中途重判的几项留给 #14）：

- **中途重判的默认值和写法。** `thetaUp` 0.4、`thetaDown` 0.6、`holdSteps` 3、`rejudgeEvery` 3、`rejudgeSteps` 4 都是起点（参考了 jev-pilot 实测的升档 0.3/0.5、降档 0.6），按语言分别校准。state 里放不放当前档位和计数、问题用英文还是中文，都是评测变量（见「开发」里的「中途重判」）。`rejudgeWaitMs` 300 毫秒按回答延迟的 p90 和工具的平均执行时间来定：实测 Jev 的中途请求 313–330 ms。

- **Clef 是否只读 state 的前约 2K token。** 第三方资料（OpenRouter 的模型页）说 Workers AI 只读 state 的前约 2K token，官方 schema 只写了「过长的 state 会被截断」。mod 已经尽量不吃亏：state 里 `user_message` 排在最前，`contextTokens` 的默认值也是 2000。方法：发一个已知长度的 state，在末尾放一个只有靠它才能作答的探针事实，并对比 `usage.input_tokens`；还要确认截断是否也作用于问题（skill 画像在 criteria 里）。基线（#3 实测）：一条中文消息、不带上下文的 effort 请求，Clef 报 460 input tokens，Jev 报 626。
- **Clef 的延迟和 `timeoutMs`。** 本机用 Node 的 fetch 连发 6 次同一个请求：Clef 第一次 1.8 秒，之后 0.6–1.4 秒；Jev 第一次 0.57 秒，之后 0.28–0.33 秒。默认的 `timeoutMs` 1500 对 Clef 偏紧（在真实引擎里，第一次请求的冷连接用了 1.3 秒才拿到 Cloudflare 的 401）。按延迟的 p50 和 p90 为 Clef 定 `timeoutMs` 的默认值。#4 的正式基线是第一批数据：200 个请求依次发送时 p50 699 ms、p90 929 ms，只有 1 条超过 1500 ms（见「开发」里的「评测」）。
- **skill 推荐的门槛和准确率（#16）。** #11 的起点：用 mod 自己的排序代码（`skillsRequest` + `modRanker`）和真实的 Jev（jev-1.13.0），在本机 87 个 skill（66 个主 agent 能加载、21 个只能由用户触发）上问了 21 条消息：18 条中文（10 条该推荐 skill、8 条不该），3 条 find_skill 式的英文查询（2 条有对应的 skill）。先不带画像：该推荐的 skill 在第二段的相关度是 0.81–0.98（最低的是 `pr` 0.81）；不该推荐的消息里进入第二段的 skill 是 0.07–0.66（两次重命名都给了 `implement`，0.49 和 0.66），另有两个可争议的 0.80 左右（「这个函数为什么返回 undefined」的 `diagnosing-bugs`，「解释一下这个正则」里只能由用户触发的 `teach` 0.79）。所以 `skillsMinRelevance` 取两组之间的 0.7，`findSkillMinRelevance` 取 0.5（主 agent 主动问时宁多勿漏，它自己会看描述）。给 3 个 skill 写了画像后再问一遍：该推荐的照旧（`code-review` 0.96、`codebase-design` 0.96、`diagnosing-bugs` 0.94），`diagnosing-bugs` 对「为什么返回 undefined」降到 0.53（它的画像写了「不用于简单问题」）。第一段的分布：该推荐的 skill 都分到 0.34 以上（多数 0.96–1.00），不需要 skill 的消息里分给 skill 的最多 0.10，所以第二段只补读分到 0.1 以上的（`SHORTLIST_FLOOR`），多数普通消息只发一个请求。还要评测：按语言分别校准这两个门槛和 0.1 这个下限；`skillsShortlist` 取几；画像用中英双语、只用英文还是只用描述（criteria 的写法在 `profileFields` 一处）；Choice 选项顺序的影响（Jev 偏向排在前面的选项）。
- **skill 请求的大小和延迟。** 不带画像时第一段约 6.4k input token（87 个选项），真实引擎里 0.3–0.6 秒；每份画像约多 110 token（实测 3 份画像多出 330–380 token），全部写好后估计 16k 左右，在 Jev「state + 最长的问题 ≤ 32k」之内；`questionBudget` 再按估算值留了余量（估算比 Jev 报的少约 10%，按 1.35 倍留），超出时先去掉「何时不用」，再从后往前改回描述。第二段约 0.5–1.5k token、0.25–0.5 秒。`-p` 进程启动时的第一个请求有一次用了 1.7 秒（#10 实测，进程启动时其他工作同时在跑），超时后照常放行。

---

## 开发

这一节是后续每张票的实现说明，包括结构、扩展方式、测试写法，以及已经实测过的引擎行为。通用规则（mod 的结构、命令、编写约束）见仓库根目录的 CLAUDE.md，这里只写本 mod 自己的约定。设计理由见 `docs/adr/0003-dispatch-pilot-core-innermost-plan-table.md`。

### 命令（在仓库根目录执行）

```bash
command claude plugin test ./dispatch-pilot               # 接缝 1 的测试，不联网，不需要 key
command claude plugin validate ./dispatch-pilot --strict
tsc -p ./dispatch-pilot                                   # 需要先用 --plugin-dir 加载一次，生成 .claude-plugin/types/
claude --plugin-dir ./dispatch-pilot --settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}'
TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' [--zh] [--choice]   # 用 Node 调一次真实的 Jev
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AUTH_TOKEN=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' --clef   # 调一次真实的 Clef
TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-agent.ts --file <subagent.jsonl> --id subagent-011 [--lang en] [--zh] [--work] [--noul] [--fable]   # 一个派出 agent 的判断（Jev），请求与 mod 发出的相同
node dispatch-pilot/eval/validate.ts                      # 校验评测集（接缝 2，见下文「评测」）
node dispatch-pilot/eval/run.ts effort-submit --estimate  # 估算请求数、token 和费用，不发请求
node dispatch-pilot/eval/run.ts effort-submit --label <名字> [--backend clef]   # 用真实 Jev（或 Clef）跑一次评测，结果存进 eval/results/
node dispatch-pilot/eval/apply-review.ts effort-submit --from <审核记录.jsonl>  # 应用用户的审核决定，再校验
node dispatch-pilot/eval/compare.ts <结果 a.json> <结果 b.json>                # 两次运行逐项对照，不发请求
```

凭证放在环境变量里，脚本不会打印它们。把它们存在 `~/.config/dispatch-pilot/eval.env` 时，可以用 Node 自带的 `node --env-file=<那个文件> dispatch-pilot/scripts/decide.ts ...` 载入，不必先在 shell 里 source。

mod 根目录的 `tsconfig.json` 是手写的。它继承生成的配置，并加上 `allowImportingTsExtensions`，因为相对导入都带 `.ts` 后缀（Node 直接运行也需要这样写）。Claude Code 发现已有 tsconfig.json 时不会覆盖它。

### 结构

```
hooks/
├── dispatch-pilot.ts       入口，只负责组装：先按顺序注册各项功能，最后注册核心
├── features/               每项功能一个文件，导出 register<X>(on, ctx)
│   ├── control.ts          /dp 命令：开关、锁定 effort、最近的决策；记录 session.measure 的读数（#13）
│   ├── dispatched-agents.ts  派出 agent 时判断它的模型和 effort（#6）
│   ├── find-skill.ts       主 agent 的 find_skill 工具：会话开始时注册，被调用时按查询给 skill 排序（#12）
│   ├── main-effort.ts      发消息时判断主 agent 的 effort（#2）
│   ├── midturn-effort.ts   一轮中途重新判断主 agent 的 effort（#5）
│   └── skills.ts           对主 agent 隐藏 skill 列表，发消息时推荐 skill（#10）；会话开始时在后台写 skill 画像（#11）
├── core/                   各功能共用的机制，不含具体功能
│   ├── core.ts             核心的 hook：发消息时的决策请求、一轮的开始、每一步的写入
│   ├── ballot.ts           一条消息的「投票箱」：各功能放进问题，由核心一次发出
│   ├── decisions.ts        决策日志：recordDecision，各功能记录自己的每个决定（debug log 和 /dp log）
│   ├── plans.ts            计划表的类型和纯函数（planStep 决定每一步发出什么）
│   ├── profiles.ts         skill 画像（#11）：给模型的提示、读回答、store 的键和淘汰、readSessionSkills（目录加画像）
│   ├── prompts.ts          isPersonsMessage：判断哪些 prompt 是用户本人的新消息
│   ├── skills.ts           skill 目录：loadCatalog（经闭包读命令、引擎的 skill 清单、settings、磁盘，找到每个 skill 的文件）；读和裁剪 skill 列表（#10）；rankingSettings、describeStages（#11）
│   ├── status.ts           状态行：由各段组成，每段只有一个主人
│   ├── switches.ts         开关：总开关和各功能的开关，defineSwitch 登记、isOn 判断
│   └── setup.ts            把 userConfig 读成 ctx（共用的配置和决策后端）
└── decision/               决策请求模块：纯模块，不依赖 $，Node 可以直接 import（#4 的评测会用）
    ├── system-one.ts       System One 请求和回答的类型；mergeParts、answersFor
    ├── effort.ts           effort 问题（英文或中文 × Score 或 Choice）、读回答、选档位
    ├── midturn.ts          中途重判：state（与评测集 effort-midturn 同形）、问题、防抖规则、工具调用的一句话结果
    ├── dispatched-agent.ts 派出 agent 的问题（模型 Choice + effort Score + 点名和排除）、按优先级读回答
    ├── skills.ts           skill 的两段排序（modRanker 是推荐和 find_skill 共用的唯一入口；第一段 skillsPart，第二段 rerankPart）、画像的写法、挑选、给主 agent 的文字块；skillsRequest（#16 的评测用）
    ├── context.ts          state：token 估算和截断、最近的对话、turnStartState
    ├── redact.ts           secret 脱敏
    ├── backend.ts          决策后端的接口、超时、失败分类
    ├── jev.ts              Jev 后端
    └── clef.ts             Clef 后端（Cloudflare Workers AI，#3）
scripts/decide.ts           用 Node 发一次真实的判断（Jev 或 `--clef`），请求内容与 mod 发出的完全相同
scripts/decide-agent.ts     同上，判断一个派出 agent（输入是评测集 subagent.jsonl 的一题）
eval/                       评测（接缝 2）：评测集、Node 脚本、结果，见下文「评测」
tests/support/world.ts      接缝 1 的测试脚手架
tests/support/cloudflare.ts world 的 Cloudflare 一侧：clef(levels) 是 jev(levels) 的孪生，按 Workers AI 的方式回答和拒绝
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
  | `classic.PreToolUse` | `{ tool: /(?:)/ }` | 已实测（kit 和真实引擎），`features/midturn-effort.ts` 用它认出 settings hook 拦下的调用 |

  其他事件请选一个每次都存在的字段。字段不存在时 matcher 不会命中，hook 会被静默跳过，所以新写的 matcher 要有测试覆盖。
- **`$` 只能在 hook 所在的文件里使用**，不能传给从别的文件导入的函数，否则加载时会被拒绝。共用的逻辑写成纯函数；需要 `$` 的能力时，让函数接收闭包，例如 `BackendIo`（`{ fetch: (u, i) => $.http.fetch(u, i), sleep: (ms, s) => $.clock.sleep(ms, { signal: s }) }`）或 `$.state` 的 `Cell`（`{ get: () => $.state.get(REF), set: (v, o) => $.state.set(REF, v, o) }`）。`ctx` 里只有数据和纯函数。
- **`$.state` 的 ref 在每个文件里各自写成字面量常量**，例如 `const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const`，family 写成 `{ ...TURNS, id }`。validate 要求 `plugin` 和 `key` 是字面量。
- **每个字段只由一个 hook 写出。** 主 agent 的 effort 和非主 agent 的 model 只由核心的 `turn.step` 写出。功能通过计划表影响它们，不要在自己的 `turn.step` 里改 `e.effort` 或 `e.model`：内层的改写会覆盖外层，而核心在最内层。
- **主 agent 永远不写 model**（ADR 0001）。`planStep` 从结构上保证这一点：主 agent 的步最多只改 effort。
- **一律放行。** 决策模型失败、超时、回答不完整，或者自己的代码出错时，都让事件照常往下走，不阻塞用户，并在状态行说明原因。

### 往计划表写：effort、floor、model、lock

计划表在 `$.state` 里，契约见 `types/index.d.ts`，类型见 `core/plans.ts`。核心的 `turn.step` 每一步都会读它，所以写进去的值从下一步起生效。在同一步里，外层 hook 写入的值内层马上就能读到（已实测）。

| key | id | 内容 | 由谁写 |
|---|---|---|---|
| `turns` | `turnKey(turnId, agentId)`，即 `main:<turnId>` 或 `<agentId>:<turnId>` | 一轮的计划 `{ effort, floor, model }`，另有 `prompt`（主 agent 这一轮的消息，已脱敏和截断）、`decisions`、`changes` | #2 发消息时写；#5 中途重判用 `revise` 写；#7 强制升档写 `floor` |
| `agents` | `agentId` | 一个派出 agent 或 Workflow agent 所有轮的计划 `{ effort, floor, model }` | #6 在 `agent.spawn` 时写 effort（haiku 不写；model 已经改在派发上，表里留 `null`，免得每一步都把引擎过载时换用的模型改回去）；#9 查到 label 后写；#7 把 haiku 换成 sonnet 时写 |
| `lock` | 无 | 用户锁定的主 agent effort，`null` 表示没有锁定 | #13：`/dp lock`、`/dp unlock`（`features/control.ts`） |
| `decisionLog` | 无 | 各功能记录的决策，最近 50 条，`/dp log` 显示（见下「记录一次决策」） | 各功能，用 `recordDecision` |
| `pending` | 无 | 发消息时做出的判断，等它的那一轮开始时由核心认领 | #2 |
| `said` | 无 | 用户本人这一轮说的话（已脱敏和截断）：空闲时发的那条消息开始新的一组，这一轮进行中发的消息追加进去，其他来源的 prompt 不动它；派出 agent 的判断把它当作 `user_message` | #6 |
| `midturn` | `main:<turnId>` | 中途重判自己的记录：步数、最近 16 步的文字和工具调用（各带结局）、`failures`（失败的工具调用，不含 hook 拦截和拒绝）、`hookBlocks`、最近一次重判和升档在第几步 | #5 |
| `mainStep` | 无 | 主 agent 正在进行的一步 `{ turnId, index }`（`tool.call` 上没有 turnId，靠它对上） | #5 |
| `demand` | `main:<turnId>` | 别的功能要求的一次重判 `{ trouble, atLeast, at }`，见下「中途重判」 | #7 写，#5 读 |

`planStep` 按以下规则决定每一步发出什么：

- effort：主 agent 有 lock 时用 lock。否则取这一轮的 `effort`（非主 agent 这一轮没有时，用它在 `agents` 里的计划），再抬到 `floor`（取这一轮和 agent 计划中较高的 floor）。没有任何 effort 但有 floor 时，抬高的是引擎自己的 effort。什么都没有时用引擎的 effort。
- model：主 agent 永远不改。其他 agent 用这一轮的 `model`，没有时用 `agents` 计划里的。
- 引擎没有给 effort（haiku 这类模型）或给的是数字时，不改 effort。

其他约定：

- 当前是第几步不需要另外记录，`turn.step` 的 `e.index` 就是（从 0 开始）。
- 读改写用 `update(cell, change)`，它按版本号做比较后写入，冲突时重试；`change` 必须是纯函数。改主 agent 某一轮的 effort 用 `revise(record, effort)`，它会同时更新 `decisions` 和 `changes`。
- 新的计数（例如 #7 的失败次数）放在自己的 key 下，id 同样用 `turnKey`，并在契约里加上相应的一段。
- 表项不会被删除。每条记录很小，一个会话里的增长可以忽略。

### 在 turn.step 上注册一层

如果某项功能需要在某一步发出前做决定（#5 取预判结果、#7 判断是否卡住、#9 按 label 查表），就在自己的文件里注册一层，写好计划表，再交给下一层：

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

判断一个 agent 的模型和 effort，用 `decision/dispatched-agent.ts`：输入 `Dispatch` 的字段与评测集 subagent.jsonl 的题目相同，`dispatchState` 拼 state，`dispatchPart` 出问题，`decideDispatch` 按优先级读回答。Workflow 改写（#8）把几个 `agent()` 放进同一个请求时，给每个 agent 不同的 `part` 和 `field`（例如 `agent-0` 和 `brief_0`），state 用 `dispatchBrief` 拼各自的 brief，`user_message` 只放一份。

### 中途重判（#5）

`features/midturn-effort.ts` 注册三层，都带 matcher：

- `tool.call`：只看主 agent 自己的调用（`e.agentId` 为空，并且 `next.origin.plugin === 'engine'`，排除插件的 `$.tool.call`）。调用开始时，如果这是重判的时机，就拼好请求、发出去但不等待，把 Promise 放进模块级的 Map（`$.state` 只收 JSON）；调用结束后，把结局记进 `midturn`。
- `classic.PreToolUse`：settings hook 拒绝的调用在 `tool.call` 里只是一个错误（理由是错误文字），所以在这里按 `tool_use_id` 记下来。
- `turn.step`（在核心之外）：取这一步的回答，必要时等 `rejudgeWaitMs`，按防抖规则写 `turns[main:<turnId>]`（有变化时用 `revise`），再交给核心；同时边转发边收集这一步的文字。

同一步只问一次：并行的几个调用里只有第一个发请求，`midturn.askedFor` 记下已经问过的步。热重载后计数和摘要都在 `$.state` 里；在途的回答在模块里，会丢，那一步就沿用原来的 effort。

**给 #7（失败计数和强制升档）的入口。** 要求一次带「卡住」标记的重判，就写 `demand[main:<turnId>]`：

```ts
const DEMAND = { plugin: 'dispatch-pilot', key: 'demand' } as const
await $.state.set({ ...DEMAND, id: turnKey(turnId, undefined) }, {
  trouble: '2 tool calls in a row have failed while working on this request', // 一句英文，原样放进决策模型的 state
  atLeast: 'high',  // 这一轮至少升到的档位（通常是当前档位的上一档）；null 表示不限
  at: 3,            // 这是第几次要求：值变了才算新的要求，每个值只问一次
})
```

`midturn-effort` 在下一次机会发出这个请求：主 agent 的下一个工具调用开始时、当前调用结束时（`demand` 在调用期间写入时），或者下一步开始时。请求的 state 里带上 `trouble`，问题里加一句「`trouble` 说明出了什么问题，评解决它需要多少推理」。结果不低于 `atLeast`，不受 `thetaDown` 和 `holdSteps` 的限制；回答失败或迟到时也照样升到 `atLeast`。失败和 hook 拦截的次数已经在 `midturn` 里（`failures`、`hookBlocks`，从这一轮开始累计，用户拒绝不计入），#7 在此基础上实现阈值、「hook 拦截算不算失败」的开关和升档后清零（自己记一个基数即可）。结局的分类是 `decision/midturn.ts` 的 `outcomeOf`：用户拒绝按 Claude Code 自己的文字认（`The user doesn't want to proceed with this tool use`、`Permission to use ...`、`Permission for this ...`），MCP 工具的错误文字是它自己写的，一律算失败。

**给 #14（中途重判的评测）。** 评测集 `effort-midturn` 每题的 `zh` 或 `en` 对象就是 `MidturnInput`，可以直接传进去：

```ts
import { midturnEffortPart, midturnState, judgeMidturn } from '../hooks/decision/midturn.ts'
const request = mergeParts(midturnState(row.zh, { steps: 4, tokens: 2000 }), [midturnEffortPart({ language: 'en' })])
// 读回答：readEffort(answersFor(midturnEffortPart(), answers).level)，再用 judgeMidturn 得到 mod 实际会发出的档位
```

- `judgeMidturn(reading, { current, sinceRaise, atLeast }, { thetaUp, thetaDown, thetaMax, holdSteps })` 就是 mod 用的防抖规则，返回 `{ effort, why, picked, confidence }`：`picked` 是不加防抖时选的档位，`effort` 是 mod 发出的档位，两者都可以拿去和 `gold`、`accept` 比较。
- 评测变量：`midturnState` 的第三个参数 `{ currentEffort: false }`、`{ counts: false }` 可以去掉当前档位和计数（指南 §4.1 担心当前档位会产生锚定）；`midturnEffortPart({ language: 'zh' })` 是中文问题；`{ trouble: true }` 加上「卡住」的说明，006、017、051、053、056、057 这几题可以对比带与不带。
- 线上请求和评测集有两处不同：线上请求在工具开始执行时发出，所以最新一步里正在运行的工具写「进行中：」（评测集里没有这种结果）；线上的一句话结果只有结局加上调用在做什么（例如 `失败：server/proxy.ts`），评测集的结果是人写的摘要、信息更多（例如 `失败：old_string 未找到`）。要量出这个差距，可以把评测集的结果截成「前缀 + 文件名」再跑一遍。

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

**skill 画像**（#11，`core/profiles.ts` 纯模块；生成在 `features/skills.ts`）：

- 一份画像是 `SkillProfile { en: { what, use_when, not_for }, zh: { what, use_when, not_for } }`。`profilePrompt(skill, markdown)` 是给模型的提示（名字、描述、SKILL.md 的前 3000 token，要求只回一个 JSON 对象；system 是 `PROFILE_SYSTEM`），`readProfile(reply)` 取出回答里的 JSON，每个字段折叠空白、脱敏，英文截到 200 字符、中文截到 60 字符；`what`、`use_when` 缺一个就不算画像，`not_for` 可以为空。
- **存储。** 每份画像一个 `$.store` 键：`profile.<28 位十六进制>`，值是 `{ name, at, profile }`（`at` 是写下的时间）。键由 `profileKey(skill, markdown, model)` 算出：SKILL.md 全文（没有文件时用描述）、名字、模型和 `PROFILE_VERSION` 的哈希（两个 53 位的 cyrb53，同步计算），所以 SKILL.md 一改、换了模型或改了提示词，就是新的键，旧的不会再被读到。每个键单独写，几个会话同时写不会互相覆盖；`$.store` 读不到时不写画像（写了也留不住，每次会话都会重写）。
- **淘汰。** 每批写完后，`profile.` 开头的键超过 `MAX_PROFILES`（500）时，按 `at` 删掉最早写的、本会话目录里用不到的，删到 `EVICT_TO`（400）。每份画像最多约 1.3 KB（实测 450–520 字节），500 份也不到 1 MB。
- **查。** `lookUpProfiles(skills, { read, get }, model)` 给目录里的每个 skill 算 `profileKey`，从 store 取画像（`storedProfile` 再校验一遍），放进 `profile`；读不到 store 时 `store: false`，所有 `profile` 为 `null`。
- **写。** `features/skills.ts` 的 `session.start` 读完目录后，`void writeProfiles(...)` 在后台按目录的顺序逐个写（主 agent 能加载的在前），每次 `$.model.complete({ model: skillsProfileModel, system, prompt, maxTokens: 700, timeoutMs: 60000 })`，写好一份就存进 store，并用 `update` 放进 `$.state` 的目录（`withProfile`），下一条消息就用上。每批最多 `skillsProfilesPerSession` 份；写之前再看一眼 store（别的会话可能刚写好）。模型被引擎拒绝（`$.model.complete` reject）或回答 API 错误时，这次会话不再写；回答没有文字、被截断或不是画像时跳过这一个。剩下的留给下一次 `session.start`（热重载也算）。`skills` 或 `skill-profiles` 关掉、或决策模型没配好时停下。`skillsNeverSuggested` 里的 skill 不写。任何错误都只写进 debug log，不会留下没处理的 rejection。

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
- `part(options)`（第一段，`skillsPart`）：一个 Choice `skills.which`，选项依次是全部候选（`by: 'model'` 在前，`by: 'person'` 在后），最后是 `(none)`。有画像的选项用 `profileFields(profile)`（`what`、`use_when`、`not_for`、`用途`、`何时用`、`何时不用`，空的「不用于」不写），没有的仍是描述字符串，和 #10 一样。超过 254 个候选时，后面的不问（Choice 最多 255 个选项）。整个问题按 `estimateTokens` 估算不超过 `settings.questionTokens`（`questionBudget(contextTokens)`）：超出时所有画像先去掉两个「不用于」字段，还超出就从最后一个起改回描述，直到放得下。问题用英文或中文写，跟 `ctx.ask.language`。
- `rank(answers, options, { state, timeoutMs? })`：读第一段（`readSkills`，概率归一化），取分到 `SHORTLIST_FLOOR`（0.1）以上的前 `shortlist` 个；一个都没有就返回空的 `ranked`，不发第二个请求。否则并行读它们的正文开头，用 `rerankPart(candidates)` 拼第二段：每个候选一个 Noul `skills.fits.<i>`（问题 ID 用下标，skill 的数据放在结构化 instructions 的 `skill` 字段：名字、描述、画像、正文开头），两个以上候选时再加一个 Choice `skills.best`（Clef 不接受只有一个选项的 Choice）。请求的 state 就是第一段问过的 state（核心通过投票箱的 `PartOutcome.state` 交给 `settle`），超时用 `timeoutMs`（不给时用 `settings.timeoutMs`；小于 1 毫秒时不发，算超时）。`readRerank` 读回答：相关度是 `fits` 的值，从高到低，相同时看 `best` 分到的概率，再看第一段的顺序。
- 返回 `SkillRanking { ranked, none, shortlist?, failed? }`：`ranked` 是第二段的相关度（绝对值），`none` 和 `shortlist`（第一段排在前面的 skill 及其概率）供日志用（`core/skills.ts` 的 `describeStages`）；第二段失败（超时、出错、回答里没有 `fits`）时 `failed` 是失败原因，`ranked` 为空，什么都不推荐。第一段没有可用的回答时 `rank` 返回 `null`。
- `pickSkills(ranking, options, { max, minRelevance })` 返回 `suggest`（`by: 'model'`，最多 `max` 个）和 `hint`（`by: 'person'`，最多 2 个，只上状态行）。`relevanceBlock(suggest, described)` 生成给主 agent 的 `<skill_relevance>` 文字块；`described` 里的 skill（已经描述过的，以及常驻列表里的）只写名字。
- 发消息时：`features/skills.ts` 在 `prompt.submit` 里构造 ranker，`part` 放进投票箱，并记下 `$.clock.now()`；`settle` 里用 `timeoutMs` 减去已经过去的时间作为第二段的超时（两个请求共用一次等待，hook 也不会超过 10 秒的预算），调用 `rank`，第二个请求写一行 debug log（`second skills request [...] to jev: ...`）。`find_skill` 在自己的 `tool.call` 里构造同样的 ranker，自己发第一段的请求，再把它的 `state` 交给 `rank`（见下文「find_skill（#12）」）。
- `choiceRanker` 仍然导出，是 #10 的只有第一段的排序（相关度是相对值），mod 不再使用，留给评测做对照。

**评测（#16）**。`skillsRequest(item, options, { limits, ask?, ranker? })` 用 `item = { message, recent_context }` 拼出 mod 发出的同一个第一段请求：共用的 state、effort 问题、skill 问题（同样按 `questionBudget(limits.tokens)` 控制大小），顺序和投票箱一样。它返回 `{ request, part }`，读回答用 `answersFor(part, answers)`，再交给 `modRanker(io, settings).rank(answers, options, { state: request.state })` 发第二段，最后 `pickSkills`。候选要带上画像才和 mod 一样：可以用同一个 `$.store` 里的画像（`lookUpProfiles` 的 `get` 读 store 文件，键里有模型名，默认 `haiku`），也可以不带，作为「只用描述」的变量。skill 的 `Suite`（见下文「评测」的「加一类题型」）在 `decide` 里这样调用：`skillsRequest({ message: asked.message, recent_context: contextMessages(asked.recent_context) }, options, { limits: settings.context, ask })`。其中 `contextMessages` 来自 `eval/lib/effort-submit.ts`，它把评测集里的 `{ role, text, tools }` 换成 `{ role, text, toolUses }`。候选 `options` 由 `skill-catalog.json` 快照得到（`lib/datasets.ts` 的 `SkillCatalog`）：`status: candidate` 对应 `by: 'model'`，`user-only-frontmatter` 对应 `by: 'person'`，`off` 不进候选；`name` 就是列表里的写法，描述取快照里的 `description`。第二段要读 SKILL.md，快照还需要每个 skill 的文件位置（或者在评测时按 `loadCatalog` 的规则在本机找）。评分时，`pickSkills` 的 `suggest` 对照 `gold`、`accept`、`must_not`，`hint` 对照 `user_only_hint`。

**排序**（`decision/skills.ts`，纯模块，mod 和评测共用）。`SkillRanker { part, rank }` 是可以替换的接缝：

- `part(options)`：这一排序要往发消息时的决策请求里加的问题。#10 的 `choiceRanker` 只加一个 Choice `skills.which`：选项依次是全部候选（`by: 'model'` 在前，`by: 'person'` 在后），最后是 `(none)`，每个选项的说明就是 skill 的描述；超过 254 个候选时，后面的不问（Choice 最多 255 个选项）。问题用英文或中文写，跟 `ctx.ask.language`。
- `rank(answers, options)`：把这一部分的回答变成按相关度排好的列表 `SkillRanking { ranked: { name, relevance }[], none }`。它是异步的，所以 #11 的第二段可以在这里补读正文、发出自己的第二个请求，再复排。**#10 的相关度是选项在 Choice 里分到的概率**，是相对值（全部选项加 `(none)` 合计为 1）；#11 改用每个候选单独作答的 `fits` Noul，那是绝对值（指南 §4.3），`skillsMinRelevance` 的含义随之改变，要重新校准。
- `pickSkills(ranking, options, { max, minRelevance })` 返回 `suggest`（`by: 'model'`，最多 `max` 个）和 `hint`（`by: 'person'`，最多 2 个，只上状态行）。`relevanceBlock(suggest, described)` 生成给主 agent 的 `<skill_relevance>` 文字块；`described` 里的 skill（已经描述过的，以及常驻列表里的）只写名字。
- 功能在 `prompt.submit` 里调用 `ranker.part(catalog)`，放进投票箱；在 `settle` 里调用 `await ranker.rank(answers, catalog)`。`find_skill` 在自己的 `tool.call` 里走同样两步，只是请求由它自己发出（见下文「find_skill（#12）」）。
- **排序入口只有一个：`modRanker(...)`**（`decision/skills.ts`）。发消息时的推荐（`features/skills.ts`）和 `find_skill`（`features/find-skill.ts`）都从它取 ranker，现在它返回 #10 的 `choiceRanker`。换排序（#11 的两段排序）只改这一个函数，两处一起换。需要 `$` 的排序（发请求、读文件）通过 `modRanker` 的参数接收闭包，由两处调用方各自在 hook 里构造（`$` 不能跨文件）。评测的 `skillsRequest` 默认仍用 `choiceRanker`，要测别的排序就传 `ranker`。

**评测（#16）**。`skillsRequest(item, options, { limits, ask?, ranker? })` 用 `item = { message, recent_context }` 拼出 mod 发出的同一个请求：共用的 state、effort 问题、skill 问题，顺序和投票箱一样。它返回 `{ request, part }`，读回答用 `answersFor(part, answers)`，再交给 `ranker.rank` 和 `pickSkills`。skill 的 `Suite`（见下文「评测」的「加一类题型」）在 `decide` 里这样调用：`skillsRequest({ message: asked.message, recent_context: contextMessages(asked.recent_context) }, options, { limits: settings.context, ask })`。其中 `contextMessages` 来自 `eval/lib/effort-submit.ts`，它把评测集里的 `{ role, text, tools }` 换成 `{ role, text, toolUses }`。候选 `options` 由 `skill-catalog.json` 快照得到（`lib/datasets.ts` 的 `SkillCatalog`）：`status: candidate` 对应 `by: 'model'`，`user-only-frontmatter` 对应 `by: 'person'`，`off` 不进候选；`name` 就是列表里的写法，描述取快照里的 `description`。评分时，`pickSkills` 的 `suggest` 对照 `gold`、`accept`、`must_not`，`hint` 对照 `user_only_hint`。

**`$.state` 里的 skill 记录**（契约见 `types/index.d.ts`）：

| key | 内容 | 由谁写 |
|---|---|---|
| `skillCatalog` | 本会话的 skill 目录 `{ skills }`，每个 skill 带 `file`、`profileKey` 和 `profile`（#11，画像写好之前是 `null`）；`null` 表示要重新读 | `features/skills.ts`（读目录，后台写好画像时用 `update` 放进去）；它没读时，`features/find-skill.ts` |
| `skillsShown` | 这段对话里描述过的 skill（再推荐时只写名字）；`/compact`、`/clear` 后清空 | `features/skills.ts` |
| `skillListing` | 对主 agent 列表的回答：`withheld`（连同引擎的原文）、`passed` 或 `restored`（开关关掉后已经随消息补给主 agent） | `features/skills.ts` |

### find_skill（#12）

- **注册。** `session.start`（matcher `{ cwd: /(?:)/ }`，在 `next(e)` 之后）调用 `$.tool.register({ name: 'find_skill', description, inputSchema })`，输入只有必填的字符串 `query`。没有配置决策模型（`ctx.backend.configured === false`）时不注册。描述和 schema 都是常量，不拼进任何会话内容，开关变化也不重新注册。注册被拒绝时在 debug log 说一声；引擎给的全名不是 `mcp__dispatch-pilot__find_skill`（hook 的 matcher 就对不上）时也说一声。
- **回答。** `tool.call` 的 matcher 是 `{ tool: 'mcp__dispatch-pilot__find_skill' }`。hook 直接返回 `{ result: <文字> }`，从不调用 `next`（没有别人回答这个工具，落空的调用会失败）。照官方文档的写法，失败也作为普通的 `result` 返回，用文字说明，不用 `isError`。
- **请求。** state 是 `turnStartState({ prompt: query, messages: $.session.messages(), limits: ctx.config.context })`；问题是 `modRanker(io, rankingSettings(ctx)).part(candidates)`，只有 `skills.which`；候选是目录去掉 `skillsNeverSuggested`，和发消息时相同（`skill-profiles` 关着时去掉画像，和发消息时一样）。请求带着 `timeoutMs` 发给 `ctx.backend`，回答连同这个请求的 `state` 交给 `ranker.rank`（它发第二段，同样最多等 `timeoutMs`），再经 `pickSkills(ranking, candidates, { max: findSkillMax, minRelevance: findSkillMinRelevance })`，只返回 `suggest`（`by: 'model'`）。第二段失败（`ranking.failed`）和第一段失败一样回答「无法评分」。`io` 的 `ask` 和 `opening` 在 `tool.call` 里用这次调用的 `$` 构造。
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

在 `.claude-plugin/plugin.json` 的 `userConfig` 里声明。几项功能共用的配置放进 `core/setup.ts` 的 `Config`；只有一项功能用的，在这项功能自己的 register 里从 `ctx.options` 读取，用 `numberIn`、`stringOf` 做类型检查和范围截断。敏感字段在没有配置时是空字符串。取值固定的字符串（例如 `decisionModel`）在 manifest 里用 `options` 声明，在 `/config` 里是下拉选择；填了列表之外的值，引擎读作默认值并给出警告，mod 里不必再处理。

### 测试怎么写（接缝 1）

测试只看 mod 对外的行为：发进事件，检查到达引擎和决策后端的东西，包括每一步的 effort 和 model、请求的内容、附加的 context、状态行和 debug log。不测内部函数。`decision/` 是评测要用的公开接口，可以直接测（`tests/decision-module.test.ts`）。

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
- 两段排序（#11）：`rates(shares, fits)` 同时回答一条消息的两个 skill 请求：第一个请求的 `skills.which` 按 `shares`（effort 默认 medium），第二个请求（`isSecondSkillsRequest(request)` 为真）里每个 `skills.fits.<i>` 按它 instructions 里 skill 的名字取 `fits` 的值（没列出的是 0），`skills.best` 全给 fits 最高的那个。`disk` 也回答 `$.fs.list`（列出某个目录下的文件和子目录），同步 skill 的账号目录就这样找到。例子见 `tests/skill-ranking.test.ts`。
- skill 画像（#11）：`model` 回答 `$.model.complete`（`(request, n) => Completion`：`{ text }`、`{ fails: 'api-error' | 'empty-reply' | 'aborted' }`、`{ reject }`（引擎拒绝发出，调用 reject）或 `{ after: ms, reply }`），每次调用记在 `w.completions`；没给 `model` 时每次调用都被拒绝。画像在 `session.start` 之后在后台写，所以先 `await w.start()` 再 `await w.clock.settle()`；再调一次 `w.start()` 就是「下一次会话」（同一个 store）。`w.storedKeys()` 列出 store 里现在的键。例子见 `tests/skill-profiles.test.ts`。
- `session` 打开时，mod 用 `$.tool.register` 注册的工具记在 `w.tools`（`registerError` 同样拒绝它们）。`w.findSkill(query, { agentId })` 像模型那样调用 `find_skill`（带 `agentId` 是派出 agent 的调用），返回工具的回答 `{ result }`。例子见 `tests/find-skill.test.ts`。
- 选 Clef 的测试：`options` 用 `tests/support/cloudflare.ts` 的 `CLEF_OPTIONS`（假的 account ID 和 token），`backend` 用 `clef(levels)`。它是 `jev(levels)` 的 Cloudflare 版：token 或地址不对时回真实的 401、404；请求体不符合 Clef 的输入规则时回 400（`clefInputProblems` 按 Cloudflare 的 schema 检查：问题 ID 的字符集和长度、1–64 个问题、Choice 至少 2 个选项、Score 2–10 档、instructions 非空）；其余按 `jev(levels)` 作答，放进 Cloudflare 的外壳。新增问题的票可以用它确认自己的问题 Clef 也接受。`cloudflareError(status, code, message)` 生成 Cloudflare 的失败响应。
- `w.submit(text, { origin, turnId, wait })` 默认模拟用户在终端按回车；带 `turnId` 表示在那一轮进行中发的，不会开始新的一轮。`w.startTurn(text)` 模拟排队的消息稍后开始自己的一轮。`w.step({...})` 发出一步并把流读完。
- `w.step({ index, answer, tools })` 还可以让这一步像真实引擎那样流出文字（`answer`），并在流还没结束时依次执行工具调用（`tools`，每个是 `{ tool, input, ends }`），所以功能的 `tool.call` hook 是在这一步之内触发的。`ends` 决定调用的结局：`{ text }`（成功，默认 `ok`）、`{ error }`（工具报错；用户在权限对话框里拒绝时也是这样，文字是引擎的那句话）、`{ blockedByHook }`（PreToolUse settings hook 拒绝，工具不会执行）。到达工具的调用记在 `w.toolCalls`（参数是经过 mod 各层改写后的样子；被 hook 拦下的调用不在其中）。`jev(levels, { confidence })` 可以指定回答的置信度（默认 0.7）。例子见 `tests/midturn-effort.test.ts`。
- `w.spawn({ prompt, description, subagentType, model, fork, isTeammate })` 模拟主 agent 调用 Agent 工具，返回 `{ model, agentId }`（agent 按到达引擎的顺序命名为 a1、a2……）；`spawned` 记录每次派发到达引擎时的样子。拿到的 `agentId` 传给 `w.step` 就是这个 agent 的步。
- 要模拟别的功能已经写好的计划表，就在测试里回答 `state.get`，见 `tests/plan-table.test.ts` 的 `table()`。
- 每个测试都要断言一个实际产物（发出的请求、某一步的 effort、状态行），否则可能空过。例如不给 origin 时 hook 会被跳过；没有 `http.fetch` 桩时 fetch 会失败、走放行分支，「effort 不变」照样成立。
- `world()` 总会装上 `mock.clock(on)`。测超时时，先 `const p = w.submit(...)`，再依次 `await w.clock.settle()`、`await w.clock.advance(ms)`、`await p`。
- 同一个事件的桩不能注册两次：`world()` 已经注册过的事件，测试里不要再注册。`http.fetch`、`fs.read`、`fs.exists`、`fs.list`、`model.complete`、`session.messages`、`ui.*` 和引擎那几个事件总会注册；开了 `store` 就是 `store.*`；开了 `session` 就是 `session.start`、`session.measure`、`session.compact`、`session.end`、`command.register` 和 `tool.register`；开了 `skills` 就是 `command.list`、`session.usage`、`settings.read`、`session.cwd`、`env.*` 和 `prompt.attachment`。想自己写这些桩的测试，就不要打开对应的选项。
- 每个测试拿到的都是全新的模块实例，模块级变量不会跨测试残留。

### 评测（接缝 2）

评测用真实的 Jev 或 Clef（`--backend clef`）测决策的准确率，脚本用 Node 运行，放在 `eval/`：

```
eval/
├── datasets/<类>.jsonl     评测集，一行一题，中英对照；格式和校验规则见 lib/datasets.ts
├── review/<类>.review.jsonl 用户的审核决定（应用时由 apply-review.ts 放进来，和改动一起提交）
├── review/<类>.review-summary.md  审核总结：判断基准、规则决定（R1、R2……）和要跟进的事项
├── results/<类>/*.json     每次运行的结果：设置、答题的模型版本、汇总、逐题答案
├── lib/                    纯模块（测试也 import）：datasets、review、suite、runner、metrics、compare、各类题型的 suite
└── validate.ts、run.ts、apply-review.ts、compare.ts、node.ts   Node 脚本
```

- **测到的就是线上的请求。** 每类题型的 suite 用 `hooks/decision/` 拼请求，设置取 manifest 的默认值，经 `setup()` 读出（`--option contextTokens=4000` 可以改）。`tests/eval-effort-submit.test.ts` 用 world 核对：同一条消息和对话，评测发的请求与 mod 发的逐字相同。
- **变量。** effort-submit 有四个变体：`en-score`（mod 现在的问法）、`zh-score`、`en-choice`、`zh-choice`，即问题用英文还是中文写、用 Score 还是 Choice 问；用户的原文总是照搬进 state。每题的中文版和英文版都问。
- **指标**（`lib/metrics.ts`）：每个变体的中文、英文准确率（答案在可接受集合里；没答上的算错，另列条数），gold 命中率，答偏的方向，中英差距和 spec 的 3 个百分点门槛，中英一致率，延迟 p50 和 p90（以及超过 mod 超时的条数），按 tag 分组的错题数；另报「每题都答同一档」的常数基线。
- **延迟只在 `--concurrency 1`（默认）时可信。** 实测 Jev 对同一个 key 的并发请求像是依次处理：p50 在 1 个并发时约 270–290 ms，2 个时约 540 ms，4 个时 700–1100 ms。
- **单次运行有波动。** 2026-10-04 用同一配置跑了两次（`results/effort-submit/` 里的两份 preliminary），四个变体分别有 192、192、191、193 / 200 个答案相同，单项准确率相差 0–3 个百分点，zh-score 的中英差距一次是 −2、一次是 −4，和 3 个百分点的门槛同一量级。比较写法或判断门槛时多跑几次，用 `compare.ts` 对照。
- **结果文件**记录后端、请求的模型和响应里的模型版本、日期、变量、mod 的设置、评测集和 `hooks/decision/` 各文件的哈希、每个变体问的问题、汇总，以及逐题答案（每个档位的概率和 confidence，供 #17 校准门槛），不含凭证。判断提示词有没有变，看拼请求的文件（effort-submit 是 `system-one.ts`、`effort.ts`、`context.ts`、`redact.ts`）和记录下来的问题；`backend.ts`、`clef.ts` 这类文件变了不影响请求内容。凭证按「进程环境变量优先，其次 `~/.config/dispatch-pilot/eval.env`」读取。
- **审核。** 用户的审核 wizard 每行写一个决定（`agree`、`edit`、`note`）。`apply-review.ts --from <文件>` 把它复制到 `eval/review/`，把 `edit` 写进评测集（只改答案字段，其他行逐字不变），列出改过答案的题（它们的理由需要重写）和要跟进的 note，再校验一遍；有任何一条无法应用时整份不写。
- **加一类题型**（#14、#15、#16）：评测集放进 `eval/datasets/<类>.jsonl`（校验规则已经在 `lib/datasets.ts` 里），在 `eval/lib/<类>.ts` 实现 `Suite`（`lib/suite.ts`：怎么问、怎么评分、怎么显示、常数基线），在 `lib/suites.ts` 登记一行，再仿照 `tests/eval-effort-submit.test.ts` 用 world 核对请求与 mod 的一致。

#### effort-submit 的正式基线（2026-10-04）

评测集是审核后的版本（100 题；审核 99 题同意、1 题备注，没有改答案），设置取 manifest 的默认值（`contextMessages` 4、`contextTokens` 2000、`thetaMax` 0.5），`--concurrency 1`。Jev 用同一配置跑了 3 次（`results/effort-submit/2026-10-04-jev-baseline-1.json` 到 `-3.json`），每次 800 个请求、614,292 input token、约 0.026 美元，没有失败。Clef 只跑了默认变体一次（`2026-10-04-clef-baseline.json`，`--option timeoutMs=3000`）：200 个请求、102,900 input token（约 2,300 neurons，在 Workers AI 每天免费的 10,000 之内），5 个请求第一次失败、重试一次后答上，没有失败的题。

准确率、一致率和 gold 命中率是百分比，差距是百分点。Jev 写 3 次的均值，括号里是最低到最高；延迟写 3 次运行各自的 p50 和 p90 的范围。

| 后端（答题的模型） | 变体 | 中文准确率 | 英文准确率 | 中英差距 | 3 个百分点的门槛 | 中英一致率 | gold 命中（中 / 英） | p50 / p90 ms |
|---|---|---|---|---|---|---|---|---|
| Jev（jev-1.13.0） | `en-score`（线上的问法） | 79.3（78–80） | 78.7（78–80） | +0.7（0 到 +2） | 3 次都通过 | 92.3（91–93） | 61.3 / 59.7 | 278–418 / 316–464 |
| Jev（jev-1.13.0） | `zh-score` | 87.3（87–88） | 87.7（87–88） | −0.3（−1 到 0） | 3 次都通过 | 92.0（91–93） | 65.0 / 66.3 | 278–419 / 314–484 |
| Jev（jev-1.13.0） | `en-choice` | 82.3（82–83） | 85.3（85–86） | −3.0（3 次都是 −3） | 3 次都正好等于门槛 | 88.3（86–90） | 65.0 / 66.0 | 279–419 / 318–483 |
| Jev（jev-1.13.0） | `zh-choice` | 85.0（3 次都是 85） | 86.3（86–87） | −1.3（−2 到 −1） | 3 次都通过 | 93.7（91–96） | 62.3 / 63.7 | 278–413 / 318–492 |
| Clef（响应里只写 `clef`，没有版本号） | `en-score` | 74.0 | 74.0 | 0 | 通过（1 次） | 89.0 | 53.0 / 54.0 | 699 / 929 |

- **常数基线。** 每题都答 high 能对 55%（gold 命中 26%），medium 49%，xhigh 39%，low 30%，max 12%。Jev 的四个变体比 high 的 55% 高约 24–33 个百分点，Clef 高 19 个百分点。
- **3 个百分点的门槛在多次运行下是否稳定成立。** 3 次运行里四个变体都通过，但余量不同。线上的 `en-score` 中文不比英文差（差距 0 到 +2），稳定成立；`zh-score` 和 `zh-choice` 的差距在 −2 到 0 之间；`en-choice` 3 次都正好是 −3，没有余量。同一题同一种语言 3 次答案都相同的，四个变体分别是 190、192、191、188 / 200，即有 4–6% 的答案在 3 次运行里变过，差距最多摆动 2 个百分点。之前的两次 preliminary 运行发的请求逐字相同（评测集只差 submit-055 的理由，答案字段相同），其中一次 `zh-score` 是 −4。所以门槛只对 `en-score` 算稳定成立；要换成别的问法，先多跑几次再判断。
- **延迟。** 第 1 次运行整体慢了约 130 ms（p50 413–419 ms，分布同样集中，不像是并发排队），第 2、3 次的 p50 是 278–286 ms，和 preliminary 相近：同样是 1 个并发，不同时段的延迟也会差上百毫秒。超过 mod 超时 1500 ms 的，每个变体每次 0–1 条，最长 2245 ms。Clef 在连接已经建立、请求依次发送时 p50 699 ms、p90 929 ms，最长 2148 ms，200 条里只有 1 条超过 1500 ms（冷连接的第一次请求更慢，见「待评测」）。
- **Clef 偏高。** Clef 每种语言答错 26 题，其中 25 题是答高了；Jev 的 `en-score` 每种语言答高 16–18 题、答低 3–5 题。
- **审核规则 R4 暴露的提示词问题（留给 #17）。** 线上提示词（`hooks/decision/effort.ts`）的 high 档写着「writing tests」（中文版是「编写测试」），把写测试整体放在 high 档；审核规则 R4（`eval/review/effort-submit.review-summary.md`）定的是写测试按范围定档。submit-056（给二十来行的纯函数补几个用户已经列明的用例，只接受 medium）因此很难答对：3 次运行里，`en-score`、`zh-score`、`en-choice` 中英文各 3 次全部答 high（`en-score` 给 high 的概率是 0.71–0.76），只有 `zh-choice` 6 次里答对 5 次；Clef 中英文也都答 high。对照题 submit-055（为三个外部依赖设计 mock、覆盖率要到 80%，接受 medium 和 high）24 次都答 high，这是对的。#17 改提示词时，可以考虑把 high 档的写测试改成按范围描述，改完再跑一遍，用 `compare.ts` 对照这两题。#4 没有改提示词。

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
- 斜杠命令作为 `claude -p` 的整个 prompt 时在本地运行，不调用模型（`claude -p "/dp"`）。引擎会在命令回答的前面加上插件名（`dispatch-pilot: ...`），所以命令的文字自己不要再带前缀。`--input-format stream-json` 里连续发多条用户消息，其中的 `/dp ...` 照常当斜杠命令处理，`$.state` 在同一个进程里跨消息保留。
- `$.command.register` 在 `session.start` 的 `next(e)` 之后调用，命令当场被列出；`$.store` 在 `next(e)` 之前就能读，读到上次保存的内容，两次 `claude -p` 之间也保留（文件在配置目录的 `plugins/store/` 下，`--plugin-dir` 加载时叫 `dispatch-pilot_inline-<hash>.json`）。
- `session.measure` 在订阅会话里每个主线程轮次后触发一次，读数有 `context`（`tokens`、`window`、`percent`）、`rateLimits`（`five_hour` 和 `seven_day`，各带 `percentUsed` 和 `resetsAt`）和 `cost.usd`；matcher `{ context: { window: /(?:)/ } }` 在真实引擎里命中。headless 下状态行以 `ui_status` 事件输出（也写进 debug log），`to: 'debug'` 的日志不会出现在输出流里。
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
