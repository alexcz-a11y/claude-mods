# Dispatch Pilot

Dispatch Pilot 是 `alex-mods` marketplace 里的一个 Claude Code mod。它在 Claude 之外调用一个决策模型，TypeSafe 的 Jev 或 Cloudflare Workers AI 的 Clef（在配置里二选一），替你决定 Claude Code 怎么干活：主 agent 每一轮用哪档 effort，派出的 agent 用哪个模型和哪档 effort，主 agent 该看哪几个 skill。

主 agent 的模型从不改变，所以 prompt cache 不受影响。这只在 Claude Code 订阅下成立，见「要求」。

## 它做什么

决策模型只负责给出判断，不参与回答你。每个判断都记进决策日志（`/dp log`），状态行写明结果。

- **主 agent 的 effort。** 你每发一条消息，Dispatch Pilot 把这条消息和最近几条消息发给决策模型，问它这项工作需要多少逐步推理，得到 low、medium、high、xhigh、max 五档各自的概率。取概率最高的一档，并列时取较高的一档；`max` 只在它自己的概率达到 `thetaMax` 时才用。这一轮的每个模型请求都按这一档发出。一轮进行中，每隔几步（`rejudgeEvery`），以及主 agent 派出 agent、启动 Workflow 或加载 skill 时，会再判断一次（中途重判）；升档和降档都有防抖，降档一次只降一档。不是你本人发的消息（派出 agent 交回的结果、后台任务通知、其他会话的消息、插件自己发的消息）、斜杠命令和空消息都不判断。
- **派出 agent 的模型和 effort。** 主 agent 用 Agent 工具派出一个 agent 时，决策模型为它选模型（默认在 haiku、sonnet、opus 中选，打开 `agentFable` 后加入 fable）和 effort；选了 haiku 就不设 effort，haiku 不支持。你在消息里点名的模型或 effort（「用 opus」「effort 开 low」）一定照办，你排除的模型（「别用 opus」）不会用（决策请求整体失败时除外，见「局限和待评测」）。主 agent 自己为这个 agent 指定了模型时，只有决策模型选了别的、而且置信度达到 `agentOverride` 才推翻它。
- **Workflow 里的 agent。** 主 agent 提交 Workflow 脚本时，对脚本里每个 `agent()` 调用点做同样的判断，把模型和 effort 写进脚本再运行，并告诉主 agent 写了什么；`workflowMode` 选 `return` 时改为退回脚本，附上逐个调用的推荐，让主 agent 自己写进去。脚本写不进去的（用 `scriptPath` 或 `name` 提交、恢复的运行、读不了的脚本），在每个 agent 启动时按它的 label 设置，这叫兜底。
- **卡住时强制升档。** 主 agent 或派出 agent 的工具调用接连失败（`escalateAfter`，默认 2 次）时，再问决策模型一次，把它的 effort 升一档（`escalateMode` 选 `max` 则直接升到 max）；haiku 没有 effort 可升，改用 sonnet 接着做（`escalateHaikuTo`）。这些失败本来就在意料之中的，例如先写下、要看它红的测试，或者没找到东西而以非零退出的搜索，不升档；是不是预期内失败由决策模型判断，不靠关键词。你自己拒绝的调用从不算失败。
- **skill。** 主 agent 不再读完整的 skill 列表（装的 skill 多时这一段很长），读到的是一句固定的提示。改由决策模型在你发消息时，从本会话的 skill 里挑出相关的几个，连同名字、描述和相关度附在消息后面交给主 agent；只能由你触发的 skill 不推荐给主 agent，只在状态行提示你。一轮进行中，主 agent 还可以用 `find_skill` 工具按几个词查 skill。skill 本身和 Skill 工具都不变，主 agent 仍然可以按名字加载任何 skill。
- **失败时放行。** 决策模型超时（默认 Jev 1.5 秒，Clef 3 秒）、出错、回答无法解析，或者没有配密钥时，消息照常进入，不额外等待，这一轮用会话自己的 effort，状态行写明原因。选了 Jev 就只用 Jev，不会改用 Clef，反过来也一样。

每项功能都可以用 `/dp` 单独关掉，也可以整个 mod 一起关（见「控制：`/dp`」）。完整的行为规则（各种优先级、各种失败情形、状态行和日志的写法）见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「它做什么」。

### 状态行

状态行只有一行，例如 `dp effort high`。`(not routed)` 表示这一轮没有经过路由，用的是会话自己的 effort，后面写原因，例如 `jev: no answer in 1500 ms`；`(locked)` 表示你用 `/dp lock` 锁定了 effort；`dp off` 表示整个 mod 关着。派出 agent、提交 Workflow、推荐 skill、`find_skill` 和强制升档之后，状态行后面会再加一段，例如 `agent sonnet high`、`skills tdd, code-review`、`failed 2, blocked 1, raised 1`。状态行只用英文和 ASCII，界面里不用双宽字符。`claude -p` 没有状态行，内容写进 debug log。

### 发给决策模型的内容

- 你这条消息，加上之前最近的几条消息（`contextMessages`，默认 4 条，总长度不超过 `contextTokens`）。每条只有文字和调用过的工具名，**不包含文件内容和工具输出**。一轮中途重判时发的是这一轮最近几步（`rejudgeSteps`）的摘要：主 agent 写的文字、调用的工具和一句话结果，同样不含文件内容、写入的内容和工具输出。
- 派出 agent 和 Workflow 里的 agent：主 agent 写给它的任务（`prompt`）、描述、agent 类型，加上你这一轮说的话。
- 打开 skill 推荐时：本会话每个 skill 的名字和画像（还没有画像的用描述），以及排在前面的几个 skill 的描述、画像和 SKILL.md 开头约 700 个字符。skill 画像由你自己的 Claude 登录写（`skillsProfileModel`，默认 haiku），用你的用量，不经过决策模型的提供方。
- 发送前对常见的 secret 格式脱敏，替换成 `[REDACTED]`：各家的 API key 和 token、`password=...` 这类赋值、URL 里的密码、私钥和 JWT。
- Jev 的请求发往 TypeSafe（`api.typesafe.ai`），Clef 的发往 Cloudflare（`api.cloudflare.com`）。Cloudflare account ID 是请求地址的一部分，Claude Code 自己的 debug log 会记下请求地址，所以它会出现在那里；mod 自己写的日志行会把它遮掉。
- 每次请求的结果和每个决定都写进 debug log（`claude --debug-file <路径>`），不进入会话。

## 要求

- **Claude Code 2.1.287 及以上**，mod 在 Claude Code 里默认启用。测试用的是 Claude Code 2.1.289（Opus 5.5，订阅登录）、jev-1.13.0 和 Clef（Cloudflare Workers AI，2026-10-04）；跑 `eval/` 和 `scripts/` 里的 Node 脚本用的是 Node 26.5，用 mod 本身不需要 Node。
- **只支持 Claude Code 订阅**（ADR 0001，`docs/adr/0001-main-agent-effort-only-no-model-switch.md`）。Dispatch Pilot 每轮、每一步都改主 agent 的 effort，但从不改它的模型：换模型必然让 prompt cache 失效，而在订阅下，同一个模型内切换 effort 保留缓存（2.1.289 上 Opus 5.5 加订阅实测）。Bedrock、Vertex 和各种网关上切换 effort 会让缓存失效，不在支持范围内。Claude Code 的文档只点名了 Opus 5.5、Sonnet 5.5 和 Fable 5.1 保留缓存，其他大多数模型上每档 effort 各有一份缓存，切换会重算整段请求（见 `docs/research/decision-models-and-caching.md` 的 3.4）。
- **一个决策模型的账号。** Jev 要 TypeSafe 的 API key；Clef 要 Cloudflare 的 account ID 和一个能调用 Workers AI 的 API token。不配密钥时 mod 不发任何请求，每一轮都按会话自己的 effort 走。

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
```

装好后重启 Claude Code。在会话里运行 `/plugin`，看到 `1 mod active · dispatch-pilot` 说明 mod 已经加载；运行 `/dp` 会列出各项功能的开关。接着给它一个决策模型的密钥。

**Jev（默认）。** TypeSafe 的 API key 有两种填法：

1. 启用 mod 时，在 Claude Code 弹出的配置对话框里填，输入会被遮住。
2. 在命令行从 stdin 传进去（需要 `jq`）：

   ```bash
   export TYPESAFE_API_KEY=...   # 先放进环境变量
   jq -n '{typesafeApiKey: env.TYPESAFE_API_KEY}' | claude plugin configure dispatch-pilot@alex-mods --values-stdin
   ```

**不要用 `claude plugin install --config typesafeApiKey=...` 传密钥，也不要用 `jq --arg`**：它们的值会出现在进程参数里，同一台机器上的 `ps` 看得到。把密钥放进环境变量时，用 `read -rs TYPESAFE_API_KEY && export TYPESAFE_API_KEY` 代替上面的 `export` 一行：粘贴密钥后回车，不回显，值也不会留在 shell 历史里。

`--values-stdin` 读一个 JSON 对象，值都是单行字符串，没写到的选项保持原值。不带参数运行 `claude plugin configure dispatch-pilot@alex-mods` 会列出所有选项，并标出哪些还没有设置。

**Clef。** 要填两个键，并把 `decisionModel` 改成 `clef`：

- `cloudflareAccountId`：运行 Workers AI 的 Cloudflare account ID。
- `cloudflareApiToken`：能调用 Workers AI 的 API token。在 Cloudflare 控制台的 Workers AI 页面选 Use REST API，再点 Create a Workers AI API Token。

```bash
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
jq -n '{decisionModel: "clef", cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: env.CLOUDFLARE_API_TOKEN}' | claude plugin configure dispatch-pilot@alex-mods --values-stdin
```

`decisionModel` 在 `/config` 里是下拉选择，也可以在那里改成 `clef`。Clef 和 Jev 有几处不同，见「配置」和「局限和待评测」。

## 从 jev-pilot 切换

Dispatch Pilot 和 jev-pilot 不能共存：两者都在 `turn.step` 上改主 agent 的 effort，会互相覆盖。已经装了 jev-pilot 的话，按这个顺序切换：

1. **先在 jev-pilot 还启用的会话里运行 `/jev-pilot:setup restore`。** 它把 `/jev-pilot:setup` 写进 settings 的 skill 设置（`skillOverrides`）恢复成原样，并删掉备份。这条命令是 jev-pilot 自己的，只有它加载着才能用，所以要在停用它之前运行。不恢复的话，那些 skill 会一直对主 agent 隐藏，Dispatch Pilot 也推荐不了它们。没有运行过 `/jev-pilot:setup` 的话，这一步可以跳过。
2. 停用 jev-pilot：`claude plugin disable jev-pilot@jev-pilot`。
3. 重启 Claude Code：已经开着的会话还带着 jev-pilot，要重启。
4. **之后只用 `claude` 启动，不要用 `claude-jev`。** jev-pilot 的 marketplace 安装停用之后，`claude-jev` 启动器会改用 `--plugin-dir` 加载它在 `~/.claude/plugins/marketplaces/jev-pilot` 里的本地副本，jev-pilot 又被加载进来（还会起它自己的 router），两者就又撞在一起了。

## 配置

选项的值存在两个地方：

- **敏感项**（`typesafeApiKey`、`cloudflareAccountId`、`cloudflareApiToken`）存进平台的安全凭据存储（Claude Code 文档的说法），输入时被遮住，不在 `/config` 里出现。用启用 mod 时的对话框，或者 `claude plugin configure ... --values-stdin` 填，见「安装」。
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

选项留空就按所选的决策模型取默认值：`timeoutMs`、`contextMessages`、`contextTokens`、`thetaMax`、`thetaUp`、`thetaDown`、`rejudgeSteps`、`thetaExpected`、`agentOverride`、`skillsMinRelevance`、`findSkillMinRelevance` 这 11 项在 manifest 里没有默认值，所以 `/config` 里显示为空，你不设时 Dispatch Pilot 按 `decisionModel` 取表里 Jev 或 Clef 那一列。你自己设了某一项，两个决策模型都用你设的值（`contextTokens` 在 Clef 下最多 2000，设得更大也按 2000 算）。会话开始时 debug log 会写一行哪些选项用了默认值。

下表的 Jev 和 Clef 两列是各自的默认值。`起点`：这个默认值是暂定的起点，还没有评测数据支持。`未校准`：Clef 沿用 Jev 的值，没有在 Clef 上量过。没有标注的，是按测到的数据定的，或者本来就不需要校准。

### 决策模型和密钥

| 选项 | 作用 | Jev | Clef |
|---|---|---|---|
| `decisionModel` | 决策模型：`jev`（TypeSafe）或 `clef`（Cloudflare Workers AI），在 `/config` 里是下拉选择。选了一个就只用它，没有备用；填了这两个之外的值，Claude Code 按默认值 `jev` 处理并给出警告 | `jev` | `jev` 要用 Clef 请改成 `clef` |
| `typesafeApiKey` | 选 Jev 时用：TypeSafe 的 API key。敏感项。为空时不发任何请求 | `空` | `空` |
| `cloudflareAccountId` | 选 Clef 时用：运行 Workers AI 的 Cloudflare account ID。敏感项。为空时不发任何请求 | `空` | `空` |
| `cloudflareApiToken` | 选 Clef 时用：能调用 Workers AI 的 Cloudflare API token。敏感项。为空时不发任何请求 | `空` | `空` |

### 等多久，读多少

| 选项 | 作用 | Jev | Clef |
|---|---|---|---|
| `timeoutMs` | 一条消息等决策模型的最长时间（200–8000 毫秒），超过就不经路由地放行 | `1500` | `3000` Clef 更慢 |
| `contextMessages` | 随你的消息一起发的最近消息条数（0–32） | `4` | `4` 未校准 |
| `contextTokens` | 你的消息加上最近消息的 token 预算（100–16000），中英文按同一个尺度数，旧消息先丢 | `2000` | `2000` 最多 2000 |

### 一轮中的 effort

| 选项 | 作用 | Jev | Clef |
|---|---|---|---|
| `thetaMax` | 用 `max` 所需的最低概率（0–1）；发消息时、中途重判和派出 agent 的 effort 都用这个门槛 | `0.5` 起点 | `0.5` 未校准 |
| `rejudgeEvery` | 一轮进行中每隔几步重判一次（0–50）；0 表示不按步数重判，派出 agent、启动 Workflow、加载 skill 时仍会重判 | `3` 起点 | `3` 起点 |
| `rejudgeSteps` | 重判时决策模型读到的最近步数（1–16） | `4` 起点 | `4` 未校准 |
| `rejudgeWaitMs` | 重判的回答还没到时，下一步最多再等多久（0–2000 毫秒），然后沿用原来的 effort | `300` | `300` |
| `thetaUp` | 中途升档所需的最低置信度（0–1）。Clef 的置信度比 Jev 低得多，这个值下它很少改档 | `0.4` 起点 | `0.4` 未校准 |
| `thetaDown` | 中途降档所需的最低置信度（0–1，低于 `thetaUp` 时按 `thetaUp` 算），一次只降一档 | `0.6` 起点 | `0.6` 未校准 |
| `holdSteps` | 升档之后多少步之内不降档（0–50） | `3` 起点 | `3` 起点 |

### 卡住时强制升档

| 选项 | 作用 | Jev | Clef |
|---|---|---|---|
| `escalateAfter` | 计入的工具调用失败满几次就问决策模型并升档（1–20） | `2` 起点 | `2` 起点 |
| `escalateMode` | `one-level` 升一档，最高到 xhigh（决策模型自己有把握给更高时可以更高）；`max` 直接升到 max | `one-level` 起点 | `one-level` 起点 |
| `escalateLimit` | 一轮（或一个派出 agent）最多升几次（0–10）；每次升档后失败计数清零 | `2` 起点 | `2` 起点 |
| `thetaExpected` | 决策模型认为这些失败是预期内失败的概率达到多少就不升档（0–1） | `0.25` 起点 | `0.25` 未校准 |
| `escalateHaikuTo` | 失败的 haiku agent 接着用哪个模型做：`sonnet`、`opus`、`fable` 或完整的模型 id；留空表示不换。你为这个 agent 点名的模型和排除的模型优先 | `sonnet` | `sonnet` |

### 派出 agent 和 Workflow

| 选项 | 作用 | Jev | Clef |
|---|---|---|---|
| `agentFable` | 打开后，决策模型可以为派出 agent（包括 Workflow 里的）选 fable，fable 比 opus 贵；你自己点名 fable 时不受这个开关限制 | `false` | `false` |
| `agentOverride` | 主 agent 为派出的 agent 指定了模型时，决策模型的选择要达到这个置信度（0–1）才推翻它；Workflow 脚本里写了 `model` 时同样适用 | `0.6` 起点 | `0.6` 未校准 |
| `workflowMode` | `rewrite`：把决定写进脚本再运行；`return`：第一次提交被拒绝并附上逐个 agent 的推荐，让主 agent 自己写进去，同一个 Workflow 第二次提交直接放行 | `rewrite` | `rewrite` |

### skill

选 Clef 时，发消息时的 skill 推荐默认关闭（`/dp skills on` 打开，见「局限和待评测」）；`find_skill` 照常可用。

| 选项 | 作用 | Jev | Clef |
|---|---|---|---|
| `skillsMax` | 一条消息最多推荐几个 skill（0–10） | `3` | `3` |
| `skillsMinRelevance` | 推荐一个 skill 所需的最低相关度（0–1）：决策模型对「这个 skill 是否正好做这条消息要做的那种工作」回答「是」的概率 | `0.75` | `0.75` 未校准 |
| `skillsShortlist` | 第二段补读 SKILL.md 开头、逐个判断的 skill 最多几个（1–10） | `4` 起点 | `4` 起点 |
| `skillsProfileModel` | 写 skill 画像的模型，写别名（`haiku`）或完整的模型 id。通过你的 Claude Code 登录调用，算在你的用量里；换了模型，所有画像重写 | `haiku` | `haiku` |
| `skillsProfilesPerSession` | 每次会话开始最多写几份还没有的画像（0–500）；0 表示不写 | `30` | `30` |
| `skillsAlwaysListed` | 一直留在主 agent 的 skill 列表里的 skill，写列表里的名字（同步来的 skill 带前缀，例如 `anthropic-skills:pdf`）。列表项，不在 `/config` 里 | `空` | `空` |
| `skillsNeverSuggested` | 从不推荐给主 agent、也不提示你的 skill，写法同上。它们照常安装，Skill 工具仍能按名字加载，`find_skill` 也不返回它们。列表项，不在 `/config` 里 | `空` | `空` |
| `findSkillMax` | `find_skill` 一次最多返回几个 skill（1–10） | `5` | `5` |
| `findSkillMinRelevance` | `find_skill` 返回一个 skill 所需的最低相关度（0–1），比推荐的门槛低：这是主 agent 主动问的，它会自己看描述再决定 | `0.5` 起点 | `0.5` 未校准 |

## 控制：`/dp`

```
/dp                    是否开启、effort 的锁定状态、各项功能的开关
/dp on | off           总开关。关闭后不发任何决策请求，每一步都按引擎原样发出（锁定也不生效），状态行写 dp off
/dp <功能> on | off    单项功能的开关，例如 /dp main-effort off（功能名见 /dp 的列表）
/dp lock <档位>        把主 agent 的 effort 锁在 low、medium、high、xhigh 或 max，这一轮的每一步和之后的每一轮都用它，优先于决策
/dp unlock             解除锁定（也可以写 /dp lock off）
/dp log [N]            最近 N 次决策和理由，最新的在最后（默认 10，最多 50）
```

- 命令在一轮进行中也立即执行：锁定或解锁从下一步起生效。
- 功能的开关是 `main-effort`、`midturn-effort`、`dispatched-agents`、`workflow-agents`、`workflow-labels`、`escalation`、`skills`、`skill-profiles`、`find-skill` 和 `signals`；另有 `hook-block-failures`，默认关闭，打开后你自己的 settings hook 拦下的调用也算失败，参与强制升档。
- 开关保存下来，下次启动会话时还是你离开时的样子；只保存和默认值不同的开关，所以一个新增的功能默认开着。
- 锁定只在当前会话里有效，`/dp unlock` 或会话结束时解除。锁定期间决策照常进行并记录，不想为此等决策模型的话，用 `/dp main-effort off`。
- `/dp log` 显示每项功能记录的决策：做了什么决定、针对哪条消息、理由（决策模型给出的各档概率和置信度）。同样的内容也写进 debug log。
- 信号（上下文占用、5 小时和 7 天限额的百分比、会话花费）每次变化时写一行进 debug log，只是记录，不参与任何决策；`/dp signals off` 可以停止记录。
- 暂时不想用就 `/dp off`；彻底停用就 `claude plugin disable dispatch-pilot@alex-mods`。

## 局限和待评测

**局限**

- **只支持 Claude Code 订阅**，见「要求」。
- **决策请求整体失败时，你排除的模型仍可能按主 agent 的指定启动。** 哪些模型被排除，是决策模型从你的话里读出来的，没有它的回答就无从知道；mod 不改用关键词去猜，免得把只是提到某个模型的话当成排除。这是有意的取舍。
- fork 出来的 agent（它总是用父 agent 的模型）和 agent team 的 teammate（它会长期存在、处理很多任务，派出时的一次判断看不到这些任务）不处理。
- **主 agent 在推荐漏掉时不会自己去用 `find_skill`。** 一条要写 PR 描述、却没有推荐 `pr` 的消息，有提示、没有提示、提示写得更主动，主 agent 都直接写了正文；被明确要求查时，它能找到 `find_skill` 并用上。所以漏掉的推荐，目前只靠发消息时的推荐。
- Jev 对同一个 key 的并发请求像是依次处理。Workflow 里 prompt 是数据的调用（fan-out）在 agent 启动时当场判断，几个 agent 几毫秒内一起启动，排在后面的可能超时，那些 agent 按引擎原样启动。
- **Clef 只接入，没有校准。** 除 `timeoutMs` 和 `contextTokens` 的上限以外，Clef 的默认值都沿用 Jev 的；它的置信度比 Jev 低得多（中位数 0.24 对 0.66），在 `thetaUp`、`thetaDown` 的默认值下很少改档。Clef 比 Jev 慢（连接建立后 0.6–1.4 秒，冷连接的第一次请求 1.8 秒），所以 `timeoutMs` 默认 3000。带画像的 skill 第一段要 3.7–7.9 秒，超过一条消息能等的时间，所以选 Clef 时发消息的 skill 推荐默认关闭。Clef 还会截断过长的 state，所以选 Clef 时 `contextTokens` 最多 2000（见下面的「Clef 截断 state」）。
- 大多数默认值是暂定的起点（表里标了 `起点`）：评测数据只够定下 `skillsMinRelevance`，其余的见下面的「还没有数据的事」。

**按用户的决定（2026-10-05），#17 不再跑任何对比或扫描评测。** 用户的原话：「那我觉得我们没有必要再跑任何对比测试了 但是我们仍然要做clef接入 提供给有需要的人 我们自己就用jev即可」。所以 Clef 只保留接入，下面列的事大多仍然没有数据；#17 只做了不花钱的收尾（按决策模型取默认值、`skillsMinRelevance` 改成 0.75、文档）和之前已经跑完的 Clef 截断探针。#17 各验收项的状态：

- 上下文范围扫描（最近 2、4、8、16 步 × 1k、2k、4k、8k token）：没有做。现有评测集的上下文太短，扫描几乎测不出差别（16 格 × 4 套的 13,088 个请求里只有 1,226 个不同），要做就得先补长上下文的题，补充集也按用户的决定取消了。默认值保持 Jev 4 条 × 2000 token；Clef 按截断的结论定为 2000（并且最多 2000）。
- Jev 和 Clef 各一套默认值、写回 mod 的配置：已做（见「配置」）。Clef 实测过的三处不同，其余暂沿用 Jev 的值。
- 置信度门槛按语言分别校准：没有做。
- 问题用英文还是中文写：保持英文（`DEFAULT_ASK` 不变）。线索：修复之前的问法上，effort-submit 的 `zh-score` 比 `en-score` 高约 8 个百分点（3 次运行都是），一轮中途的两种语言持平。
- 验证 Clef 是否截断 state：已做，会截断，但时有时无（见下面的「Clef 截断 state」）。
- 中文准确率比英文低不超过 3 个百分点：只有离线数据，而且是修复之前的问法，没有在新问法上验证。按新规则（低不到 3 个百分点才算通过），发布的配置都通过：effort-submit `en-score` 三次平均 +0.7，一轮中途 `en-score` −1 和 +3，派出 agent `models-hint` +2 到 +3（中文高），skill 带画像时在 `skillsMinRelevance` 0.75 下 −2.3（0.7 下是 −3.7，不通过）。不是发布配置的 effort-submit `en-choice` 三次都是 −3.0，按新规则不通过，记在这里。
- 需要真实密钥、会产生少量费用：只有 Clef 截断探针花了钱，两轮合计约 0.036 美元（Clef 约 0.034 美元，Jev 对照约 0.002 美元）。

**问题的文字一改，评测就要重跑。** 发给决策模型的问题、指令和选项描述是被测的对象：改了哪一处，用到它的评测都要重跑，旧结果只能对照。第 1 轮审查改了其中几处（中途重判的工具行和 `trouble` 变体、派出 agent 的 effort 问题和 Workflow 题的合并提问、skill 第一段拆成两题）；按用户的决定，修复之后没有重跑，所以下面「评测」里的数字都是修复之前的问法测得的，只能当预览。每处改动的清单见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「待评测」。

**还没有数据的事**（#17 按用户的决定没有再测；要不要开后续票由用户决定；每一条的数字和依据见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「待评测」）：

- **中途重判的默认值和写法。** `thetaUp` 0.4、`thetaDown` 0.6、`holdSteps` 3、`rejudgeEvery` 3、`rejudgeSteps` 4 都是起点（参考了 jev-pilot 实测的升档 0.3/0.5、降档 0.6），没有按语言分别校准；state 里放不放当前档位和计数、问题用英文还是中文，也都没有结论。Clef 的置信度比 Jev 低得多，门槛要按后端分别校准，现在两个决策模型用同一组起点值。
- **「预期内失败」这一问的写法和门槛。** `thetaExpected` 0.25 来自 11 个手写场景的小实验，样本太小，只能当起点；`escalateMode`、`escalateAfter` 和 `escalateLimit` 没有评测方法，按使用体验调。
- **Clef 截断 state（#17 已测）。** Clef 会截断超过约 2.1k token 的 state，但时有时无：超过的 18 个 state 里截了 4 个（英文 4/14，中文 0/4）。截断时只留 state 开头约 2.1k 个 Clef token，后面的事实都答「没有说」；问题不截断。Jev 全部答对。mod 把最要紧的字段放在 state 最前，但最近的消息和步骤按时间排在最后，截断先丢它们，所以选 Clef 时 `contextTokens` 最多 2000。
- **Clef 的延迟和 `timeoutMs`。** Jev 第一次 0.57 秒，之后 0.28–0.33 秒；Clef 第一次 1.8 秒，之后 0.6–1.4 秒（200 个请求依次发送：p50 699 ms，p90 929 ms，只有 1 条超过 1500 ms）。所以 Clef 的默认 `timeoutMs` 是 3000，没有再细调。
- **派出 agent 的门槛。** `agentOverride` 0.6 在两次 Jev 运行里都不是最好（0.4–0.5 时整题中文 +3、英文 +2 个百分点）；点名的门槛 0.5 偏低；`thetaMax` 0.3 比 0.5 好 1–2 个百分点。#17 没有改这几个门槛。
- **Workflow agent 启动时当场判断的排队。** 一次启动很多个 prompt 是数据的 agent 时，排在后面的会等到超时。常见的 fan-out（几个到十几个 agent）有多少能在 `timeoutMs` 之内答上，还没有量过。
- **skill 推荐的门槛和准确率。** 带画像的线上设置，中文 79.8%、英文 83.5%，差 3.7 个百分点，没过 spec 的门槛；`skillsMinRelevance` 0.75 时差距缩到 −2.3。`skillsShortlist` 和第二段的下限 0.1、第一段拆成两题之后的新问法、用中文写问题、画像只用英文、Choice 选项的顺序对 Jev 的影响，都没有评测。
- **主 agent 会不会主动用 `find_skill`。** 见上面的局限。其他场景（文件格式、某个服务的工具、一轮中途才出现的需要）、其他模型，以及「每轮先查」这类更强的写法值不值得它多出的两步，还没有评测。
- **skill 请求的大小和延迟。** 带全部画像的第一段约 2.19 万 input token（111 个 skill，Jev 计），Jev 第一段 p50 0.56–0.67 秒，慢的时段 p90 到 1.65 秒；Clef 带画像的第一段 3.7–7.9 秒。把第一段单独发、只留英文字段的裁剪画像，没有评测。
- **一个请求里放几个 Workflow 调用，准确率会不会降。** 一个脚本最多 8 个 `agent()` 共用一个请求，其他调用的说明对每个问题来说是无关内容，可能降低准确率。`subagent` 评测里有一个一个请求一个调用的对照变体，没有跑过。

## 评测

评测用真实的 Jev（Clef 只抽样）测决策的准确率，脚本和数据在 `eval/`。每套评测集 100 题上下，中英文对照，答案经过审核；评测发出的请求和 mod 发出的逐字相同（测试核对）。

| 评测集 | 测什么 | 线上的问法，Jev（jev-1.13.0），中文 / 英文 |
|---|---|---|
| `effort-submit`（100 题） | 发消息时的 effort | 79.3% / 78.7%，3 次运行的平均 |
| `effort-midturn`（100 题） | 一轮中途的 effort | 73% / 74%，第二次运行 |
| `subagent`（100 题） | 派出 agent 和 Workflow 里 agent 的模型加 effort，两样都对才算对 | 69% / 66% |
| `skill`（109 题） | skill 推荐，带画像 | 79.8% / 83.5% |

- 中英差距的门槛是中文比英文低不到 3 个百分点，正好低 3 个百分点不通过。上面四行里，`skill` 的差距是 −3.7，没通过；其余三行通过。
- Jev 单个 effort 请求的延迟 p50 约 0.28–0.42 秒，p90 约 0.32–0.46 秒；skill 带画像的第一段 p50 约 0.56–0.67 秒。
- Clef 只做了抽样：`effort-submit` 200 个请求，准确率 74%（p50 699 ms）；`effort-midturn` 选出的档位更准（85% / 87%），但置信度低，默认门槛挡住大部分改档，实际发出的档位只有 58% / 57%；派出 agent 12 题，skill 3 题。
- **这些数字是 2026-10-04 在第 1 轮审查修复之前的问法上测的**，修复之后按用户的决定没有重跑，只能当预览（见「局限和待评测」）。单次运行有波动：同一配置跑两次，单项准确率相差 0–4 个百分点，和 3 个百分点的门槛同一量级。

变体、指标、常数基线、门槛的离线重扫、已知的问题题和复现的命令，见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「评测（接缝 2）」。

## 开发

结构、扩展方式、测试写法、评测的做法和已经实测过的引擎行为，见 [DEVELOPMENT.md](DEVELOPMENT.md)。仓库通用的约定（mod 的结构、命令、编写约束）见 [CLAUDE.md](../CLAUDE.md)。
