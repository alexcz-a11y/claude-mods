# eval v2 的数据格式（#45）

eval v2 是 120 题的长对话数据集：每题的对话由**素材段**（一段 = 一轮普通的工作，几十段拼成中间的大段对话）和**题目自己写的几轮**（开头、决定性几轮、最后几轮）拼成，总长大多 8 万到 16 万 token。素材作者写素材段，出题作者写题目和出题者金标，标注者另写一份金标；生成脚本按种子把它们拼成完整对话。

写完一个文件就自查：

```bash
node dispatch-pilot/eval/eval-v2-check.ts dispatch-pilot/eval/datasets/eval-v2/pool/frontend-same-problem-01.json   # 一个或几个文件
node dispatch-pilot/eval/eval-v2-check.ts dispatch-pilot/eval/datasets/eval-v2/items/                              # 一个目录
```

每个文件一行：`ok`、`warn`（通过，但有提醒）或 `FAIL`，下面是原因（`-` 是错误，`~` 是提醒）。`FAIL` 的文件要改到通过；`warn` 读一下，确实是有意的就不用改。规则写在 `eval/lib/eval-v2.ts`，`eval/validate.ts` 对全部文件跑同样的检查。

## 目录

```
dispatch-pilot/eval/datasets/
├── eval-v2/
│   ├── FORMAT.md                         本文件
│   ├── pool/<domain>-<relation>-<nn>.json 素材段：一个文件一段（素材作者）
│   ├── items/<category>-<nn>.json         题目：一个文件一题，不含答案（出题作者）
│   ├── gold-author/<id>.json              出题者的金标（出题作者）
│   ├── gold-labeler/<id>.json             标注者的金标（标注者，不看 gold-author）
│   ├── gold/<id>.json                     最终金标，评测用它：双方一致的取出题者那份（source "agreed"）；不一致的按用户裁决（source "user:author" / "user:labeler" / "user:custom"），字段同上加 source
│   └── generated.json                     生成记录（eval-v2-gen.ts 写，提交）
└── eval-v2.jsonl                          生成的数据集（eval-v2-gen.ts 写，几十 MB，不提交）
```

## 共同约定

- 每个文件是一个 UTF-8 的 JSON 对象，文件名是 `id` 加 `.json`，字段不多不少（多一个、少一个都是错误）。JSON 字符串里换行写 `\n`，双引号写 `\"`，反斜杠写 `\\`；正文很长时，先写好纯文本再用脚本（例如 Python 的 `json.dump(..., ensure_ascii=False, indent=2)`）转成 JSON 最省事。
- **只有中文对话**：用户和助手都用中文说话；代码、路径、命令、报错、日志照原样。口吻照协调者给的风格指南。
- **token 数一律按 mod 的估算**（`hooks/decision/context.ts` 的 `estimateTokens`）：汉字和全角标点每个 1，其余字符每 4 个 1。一条消息按 mod 写进 state 的那一行算：`user: 正文` 或 `assistant: [tools: Grep, Read] 正文`，空白折叠成一个空格，再加 1（换行）。不用自己数，检查命令会算。
- 不写真实的密钥、token、密码（mod 发给决策模型前会脱敏成 `[REDACTED]`，检查会提醒）；不写 `<system-reminder>`（mod 会把它整段丢掉）。
- **每个领域是一个虚构的仓库**，这个领域的素材段和题目都发生在这个仓库里：技术栈和目录照下表，模块名、业务细节自己补，不要和表冲突。

| 领域 | 虚构仓库 |
|---|---|
| `frontend` | `shop-admin`：电商后台的 Web 前端。React 18 + TypeScript + Vite；`src/pages/`、`src/components/`、`src/hooks/`、`src/api/`（axios 封装）、`src/store/`（Zustand）；Vitest + Testing Library，Playwright 在 `e2e/` |
| `backend-api` | `order-api`：订单和支付的 HTTP 服务。Go 1.22 + chi；`cmd/server/`、`internal/handler/`、`internal/service/`、`internal/store/`（sqlc + PostgreSQL）、`internal/middleware/`；`go test ./...`，接口定义在 `api/openapi.yaml` |
| `database` | `shop-db`：电商的数据库层。PostgreSQL 15，迁移 `migrations/V0xx__*.sql`（Flyway），查询 `queries/`，Python 数据访问层 `dal/`（SQLAlchemy 2），定时任务 `jobs/`；pytest + testcontainers |
| `ios` | `Ledger`：记账 App。SwiftUI + Combine，iOS 17；`Ledger/Features/`、`Ledger/Services/`、`Ledger/Persistence/`（Core Data）、`LedgerTests/`、`LedgerUITests/`；SPM、`xcodebuild`、fastlane |
| `data-scripts` | `etl-scripts`：报表数据的处理脚本。Python 3.12 + pandas / polars；`pipelines/`、`sources/`、`sql/`、`tests/`（pytest）；`Makefile` 加 cron 调度 |
| `devops-ci` | `infra`：部署和 CI。GitHub Actions（`.github/workflows/`）、Docker（`docker/`）、Terraform（`terraform/`，AWS）、Helm（`charts/`）、`scripts/` |
| `cc-mods` | `my-mods`：Claude Code mod 仓库。TypeScript，每个 mod 一个目录：`<mod>/hooks/*.ts`、`<mod>/tests/*.test.ts`、`<mod>/.claude-plugin/plugin.json`；`claude plugin test`、`claude plugin validate` |
| `docs-writing` | `docs-site`：产品文档站。Docusaurus + MDX；`docs/`、`i18n/zh/`、`blog/`、`sidebars.js`、`scripts/`（链接检查、截图）；CI 跑 `npm run build` 和 markdownlint |
| `perf` | `search-svc`：搜索服务。Java 21 + Spring Boot 3，Elasticsearch 客户端，Redis 缓存；`src/main/java/com/acme/search/`、`bench/`（k6 压测）、`perf/`（火焰图、JFR 记录） |
| `security` | `auth-svc`：登录和权限服务。Node.js + TypeScript + Express；`src/auth/`、`src/oauth/`、`src/session/`、`src/crypto/`、`policies/`；`npm audit`，Semgrep 规则在 `semgrep/` |

## 素材段（`pool/`）

一个文件一段，**恰好一轮**：用户的一条消息，加主 agent 的一条回复。

```json
{
  "id": "frontend-same-problem-01",
  "domain": "frontend",
  "relation": "same-problem",
  "user": "{{FEATURE}} 那个问题先别急着改，帮我把 {{FILE}} 里 {{SYMBOL}} 的调用链理一遍，看看哪些路径会走到 `{{ERROR}}`",
  "assistant": {
    "text": "从 {{SYMBOL}} 往上追了三层调用方，一共四条路径会走到这里：……（正文省略）",
    "tools": ["Grep", "Read", "Bash"]
  }
}
```

| 字段 | 写什么 |
|---|---|
| `id` | `<domain>-<relation>-<nn>`，`nn` 是两位数字（`01` 起），和文件名、`domain`、`relation` 一致。编号段由协调者分配，别和别人重复 |
| `domain` | 上表十个领域之一 |
| `relation` | `same-problem` 或 `unrelated`（见下） |
| `user` | 用户这一轮的消息 |
| `assistant.text` | 主 agent 的回复正文 |
| `assistant.tools` | 这次回复调用过的工具名，按第一次调用的顺序，每个名字写一次（`["Grep", "Read", "Bash"]`），至少一个 |

- **长度**：整段（两行加起来）**3000 到 5000 token**，平均 4000 左右最好。主要篇幅在回复里：读了什么、查到了什么、代码片段、列表、下一步建议。
- **工具汇总的写法和现有数据集一样**：mod 发给决策模型的只有工具名，没有工具的输入和输出，所以回复正文要用文字交代工具做了什么、结果如何（「读了 `src/api/orders.ts`：……」「跑了 `npx vitest run src/pages/orders`：14 个用例，全部通过」）；可以引一小段代码或日志，别整段贴工具输出。工具名用 Claude Code 的名字：Read、Edit、Write、Grep、Glob、Bash、WebFetch、WebSearch、Agent、TodoWrite、Skill 等（MCP 工具写 `mcp__…`）。
- **每段自成一轮**：生成时段是随机拼的，前后是哪一段不知道，所以用户消息不要承接上一轮（不写「刚才那个」「接着上面」「你说的第二点」），回复也不要等下一轮接话。
- **`same-problem` 段**：用户和主 agent 继续围绕题目的那个问题干活，**不下结论**：看代码、理调用链、看日志和监控、加观测、写复现脚本、问原理、列可能的原因。不改实现，不宣布找到原因，不说修好了，用户也不评价之前的尝试（不说「还是不行」「好了」）。问题的名字一律用**占位符**，生成时换成每题自己的值：用户消息里至少一个，回复里至少一个。
- **`unrelated` 段**：同一个仓库里别的活，和任何一题的问题都无关：加个字段、改文案、补测试、写文档、升级依赖、解释一段代码、整理配置。**不用占位符**。可以有小改动和测试运行，但别写成又一个反复未果的故障。

### 占位符（只用于 `same-problem` 段）

只认双花括号里的大写名字。`{{ .Values.image }}`（Helm）、`${{ github.sha }}`（GitHub Actions）这类代码照写，不算占位符。

| 占位符 | 是什么 | 句子里这样用 | 检查时量长度用的示例值 |
|---|---|---|---|
| `{{FEATURE}}` | 出问题的功能，中文名词短语 | 「{{FEATURE}} 那个问题」「{{FEATURE}} 这块」 | 订单列表的分页 |
| `{{SYMPTOM}}` | 现象，一句中文短句，不带句号 | 「现在的现象是{{SYMPTOM}}」 | 翻到第二页时列表是空的 |
| `{{ERROR}}` | 用户贴过的那一行报错或日志原文 | 「会走到 `{{ERROR}}` 的那条路径」 | `TypeError: Cannot read properties of undefined (reading 'items')` |
| `{{FILE}}` | 问题所在的主要文件 | 「{{FILE}} 里」 | `src/pages/orders/OrderList.tsx` |
| `{{FILE2}}` | 和它相关的第二个文件：调用方、配置或测试 | 「{{FILE}} 和 {{FILE2}} 之间」 | `src/api/orders.ts` |
| `{{SYMBOL}}` | 牵涉的主要函数、类或方法 | 「{{SYMBOL}} 的调用方」 | `useOrderPagination` |
| `{{COMMAND}}` | 复现或验证用的命令 | 「跑一下 `{{COMMAND}}`」 | `npx vitest run src/pages/orders` |

句子要对这个领域里任何合理的值都通顺：`{{FEATURE}}` 当名词用，`{{SYMPTOM}}` 当一句话用。题目的问题有故障也有任务（例如一块要改的计费代码），所以别写只有故障才说得通的话。

## 题目（`items/`）

一个文件一题。题目只写对话里**题目自己的几轮**，中间的大段对话由生成脚本从素材池拼进来。**题目文件里没有答案**（答案在金标文件里）。

```json
{
  "id": "explicit-unresolved-01",
  "category": "explicit-unresolved",
  "domain": "frontend",
  "bin": "d2",
  "relation": "same-problem",
  "placeholders": {
    "FEATURE": "订单列表的分页",
    "SYMPTOM": "翻到第二页时列表是空的",
    "ERROR": "TypeError: Cannot read properties of undefined (reading 'items')",
    "FILE": "src/pages/orders/OrderList.tsx",
    "FILE2": "src/api/orders.ts",
    "SYMBOL": "useOrderPagination",
    "COMMAND": "npx vitest run src/pages/orders"
  },
  "opening": [],
  "decisive": [
    { "role": "user", "msg": "d1", "text": "订单列表翻到第二页是空的，控制台报 `TypeError: Cannot read properties of undefined (reading 'items')`，代码在 src/pages/orders/OrderList.tsx，帮我查一下" },
    { "role": "assistant", "text": "useOrderPagination 里 offset 按页码直接乘了页大小……我改成了 (page - 1) * size。", "tools": ["Read", "Edit"] },
    { "role": "user", "msg": "d2", "text": "还是空的，刷新了也一样" },
    { "role": "assistant", "text": "那可能是 src/api/orders.ts 把 page 参数丢了……我在请求里补上了 page。", "tools": ["Grep", "Edit", "Bash"] }
  ],
  "final": [
    { "role": "user", "text": "回到分页那个问题，我刚又试了一下，第二页还是空的" }
  ],
  "middle_hint": "中间是同一个问题的继续排查：读调用链、看请求和日志，没有新的尝试，也没有结论。"
}
```

| 字段 | 写什么 |
|---|---|
| `id` | `<category>-<nn>`，`nn` 两位数字，和文件名、`category` 一致 |
| `category` | 十类之一（下表） |
| `domain` | 十个领域之一，这题发生在那个领域的虚构仓库里 |
| `bin` | `d1`–`d4`：决定性几轮离对话末尾多远（下表） |
| `relation` | 中间的大段对话和原问题的关系：`same-problem`（继续排查原问题、不下结论）或 `unrelated`（同一仓库里别的事；真实流程里次数会在这里清零） |
| `placeholders` | `same-problem` 题：七个占位符的值，一个不少（中间段可能用到任何一个），值都是一行，`FILE`、`FILE2`、`SYMBOL` 不带空格，`FILE` 和 `FILE2` 不同；`unrelated` 题写 `{}` |
| `opening` | 开头几轮，可以是 `[]`：决定性几轮之前的铺垫 |
| `decisive` | 决定性的几轮：答案取决于读没读到它们（之前试过哪些办法、约定过什么、这块代码的硬性要求……） |
| `final` | 最后几轮，最后一条是**被问的那条用户消息** |
| `middle_hint` | 给标注者看的一两句：中间那段对话大致是什么（标注者不读几万 token 的中间轮次） |

每一轮的消息是 `{ "role": "user" | "assistant", "text": "…" }`，助手的消息可以带 `tools`（写法同素材段，可以省略）。三段的规则：

- **都是整轮，从用户开始**：`opening` 和 `decisive` 以助手结束（条数是偶数，`opening` 可以为空），`final` 以用户结束（条数是奇数，通常只有一条）。
- **`decisive` 里用户的消息带 `msg`**：`d1`、`d2`……按顺序编号，助手的消息不带。金标要给每一条 `d` 消息标三选一。别的地方都不写 `msg`（生成时自动编号）。
- **判断要用的东西都写进 `decisive` 或最后那条消息**。`opening` 和 `final` 里最后一条之前的用户消息不评分，所以它们不能对问题表态（不说解决了没有，不换话题）；不需要就别写。
- **命令轮**（`category` 是 `command-turn`）：最后那条消息是用户输入的命令，开头是 `/<name>`，并带 `command`：

  ```json
  { "role": "user", "text": "/debug 第二页还是空的", "command": { "name": "debug", "description": "系统地排查一个问题：复现、缩小范围、找到根因再修。" } }
  ```

  `name` 不带斜杠，`description` 是这个命令是干什么的（mod 把它放在消息旁边给决策模型看）。只有命令轮带 `command`，也只能带在最后那条消息上。
- **题目里不用占位符**，一律写成具体的字（`placeholders` 是给中间段用的）。`same-problem` 题要在 `opening` 或 `decisive` 里提到 `FILE`、`SYMBOL`、`ERROR` 中至少一个的值，否则中间段谈论的东西在前面从没出现过（检查会提醒）。
- **衔接**：生成时 `opening`（没有就是 `decisive`）前面可能接一段别的工作，也可能就是对话的开头；`final` 前面接的是中间段的最后一段。第一条消息和 `final` 的第一条消息要在这两种情况下都读得通。
- **长度上限**：`opening` 8000、`decisive` 9000、`final` 6000 token（最浅的 d1 档要装得下它们再加一段）。

**十类**（每类 12 题，金标往高、往低大致各半；每类至少覆盖 6 个领域）：

| `category` | 是什么 |
|---|---|
| `explicit-unresolved` | 明说没解决 |
| `implicit-unresolved` | 隐含没解决（贴同样的报错、「再看看」、只报一个没变的数字） |
| `single-attempt` | 只试过一次（这是第二次，防止判得太高） |
| `resolved` | 已经解决 |
| `new-topic` | 换了话题 |
| `cheap-agreement` | 早先约定了低成本做法 |
| `looks-hard-is-easy` | 看似复杂其实简单 |
| `misleading-history` | 被历史误导（前面反复未果，但这条消息是另一件小事） |
| `hard-constraint` | 硬性约束（早先说了这块是真金白银、不可回滚、会越权） |
| `command-turn` | 命令轮 |

**四档**（每档 30 题，其中一半 `same-problem`、一半 `unrelated`）：

| `bin` | 决定性信息离末尾 | 谁的 state 读得到（测试组的预算） |
|---|---|---|
| `d1` | 24k 以内 | 24000（Jev）、48000、135000 都读得到 |
| `d2` | 24k–48k | 48000、135000 读得到，24000 读不到 |
| `d3` | 48k–135k | 只有 135000 读得到 |
| `d4` | 135k 以外 | 都读不到，只能靠问题摘要和未解决次数 |

## 金标（`gold-author/`、`gold-labeler/`）

两边字段完全相同，一题一个文件，文件名是题目的 `id`。出题作者写 `gold-author/`；标注者只看题目文件（和 `middle_hint`）写 `gold-labeler/`，**不看 `gold-author/`**。

```json
{
  "id": "explicit-unresolved-01",
  "effort": "max",
  "accept": ["xhigh", "max"],
  "effort_without_decisive": "high",
  "triage_final": "still_unresolved",
  "triage_decisive": [
    { "msg": "d1", "triage": "new_or_unrelated" },
    { "msg": "d2", "triage": "still_unresolved" }
  ],
  "rationale": "分页问题已经改了两次都没好，这是第三次说还是空的：max，xhigh 也可以。删掉决定性几轮，只看最后一句是一般的调试：high。"
}
```

| 字段 | 写什么 |
|---|---|
| `effort` | 最后那条消息该用的主 agent effort：`low`、`medium`、`high`、`xhigh`、`max`，依据是 `datasets/README.md` 的「effort 档位的含义」 |
| `accept` | 可以接受的档位，必须是相邻的几档，包含 `effort`（例如 `["xhigh", "max"]`；唯一答案就只写一个） |
| `effort_without_decisive` | 把 `decisive` 整段删掉（只剩前面的段、`opening`、中间段、`final`）时最后那条消息该用的档位 |
| `triage_final` | 最后那条消息的三选一 |
| `triage_decisive` | `decisive` 里每条用户消息的三选一，按 `d1`、`d2`……的顺序，一条不少 |
| `rationale` | 中文理由：为什么是这一档、为什么 `accept` 里的也行、删掉决定性几轮为什么变（或不变）、三选一怎么判的 |

三选一的取值用 mod 的选项名，判的是这条消息对用户之前在处理的那个问题说了什么，只看用户自己的话（助手说「已修复」不算）：

- `still_unresolved`：为那个问题试过的办法没用，或问题还在：同样的报错又出现、同样的错误行为、让再看一遍同一个问题、贴出来的就是之前那个报错。中间隔着别的活、用户又回头说这个问题还在，也是它。
- `resolved`：那个问题解决了，或用户接受了结果：现在好了、谢谢、可以了，或者让提交、推送、收尾。
- `new_or_unrelated`：转去做别的问题或任务，问的和那个问题无关，或者之前根本没有问题可言（例如对话里第一次提出这个问题的那条消息）。

## 生成（`eval/eval-v2-gen.ts`）

```bash
node dispatch-pilot/eval/eval-v2-gen.ts               # 写 eval-v2.jsonl 和 eval-v2/generated.json（种子用 generated.json 里记的，没有就是 "eval-v2"）
node dispatch-pilot/eval/eval-v2-gen.ts --seed s2     # 换一个种子（generated.json 会记下它）
node dispatch-pilot/eval/eval-v2-gen.ts --check       # 什么都不写；generated.json（和本地的 eval-v2.jsonl）不是现在的文件生成出来的就退出 1
```

任何文件有错误、或者素材池拼不出某一题时，什么都不写，退出 1，并说明是哪一题、缺什么。

**每题的对话**：`[前置段] + opening + decisive + [中间段] + final`。

- **中间段**：`same-problem` 题用本领域的 `same-problem` 段，占位符换成这一题的值；`unrelated` 题用本领域的 `unrelated` 段。长度让**决定性几轮整段**落在这一题那一档的深度区间里（下表），深度在区间里按种子抽；至少一段。
- **前置段**：本领域的 `unrelated` 段，把整段对话垫到按种子抽的总长（82000 到 150000 token）；d4 的题本身就有 14 万以上，多半不用垫。
- **复用**：同一题里一段只用一次；跨题每段最多用 6 次；用得少的先用，同样少的按种子排。中间段先给最深的题挑（它们一题就要三四十段不重复的），前置段每题轮流拿一段（池子不够时大家都少一点，而不是最后几题没有）。
- **深度**：从一条消息开头到对话末尾，按 mod 挑消息的数法算的 token：被问的那条消息（state 里的 `user_message`），加之后每一行（每行的估算加 1）。state 的预算小于一条消息的深度，就一定读不到它。区间的下界按这个数查（决定性几轮最新的那一行至少这么深），上界按 state **发出时**的大小查（JSON，引号、反斜杠的转义也算；决定性几轮的第一条至多这么深），两边离测试组的预算都留了 2000 到 8000 token，给问题摘要和次数占的约 600 token、给 mod 截 state 时的取整：

| `bin` | 决定性几轮整段落在 | 读得到它们的预算 |
|---|---|---|
| `d1` | 0 到 21000 | 24000、48000、135000 |
| `d2` | 26000 到 45000 | 48000、135000 |
| `d3` | 51000 到 127000 | 135000 |
| `d4` | 140000 到 160000 | 都读不到 |

**输出 `eval-v2.jsonl`**：一行一题，按 `id` 排序，不含金标（金标按 `id` 对上）：

```json
{"id":"explicit-unresolved-01","category":"explicit-unresolved","domain":"frontend","bin":"d2","relation":"same-problem","middle_hint":"……",
 "turns":[{"role":"user","msg":"p1","part":"lead","segment":"frontend-unrelated-07","text":"……"},{"role":"assistant","part":"lead","segment":"frontend-unrelated-07","text":"……","tools":["Read","Edit"]},
          ……,{"role":"user","msg":"d1","part":"decisive","text":"……"},……,{"role":"user","msg":"f1","part":"final","text":"……"}],
 "decisive":[{"msg":"d1","at":52,"depth":34246},{"msg":"d2","at":54,"depth":34100}],
 "depth":34246,"depth_end":34168,"tokens":131754,
 "segments":{"lead":["frontend-unrelated-07","……"],"middle":["frontend-same-problem-12","……"]}}
```

- `turns`：整段对话，最后一条是被问的消息。`part` 是它来自哪里（`lead` 前置段、`opening`、`decisive`、`middle` 中间段、`final`），来自素材池的带 `segment`。**每条用户消息都有 `msg`**：前置段 `p1`……、`opening` 里 `o1`……、决定性几轮沿用题目的 `d1`……、中间段 `m1`……、`final` 里 `f1`……（最后一个就是被问的消息）。命令轮最后那条带 `command`。
- `decisive`：每条决定性的用户消息在 `turns` 里的位置（`at`）和深度；`depth` 是第一条的深度，`depth_end` 是决定性几轮最后一行（助手那条）的深度，`tokens` 是整段对话的长度（第一条消息的深度）。
- `segments`：前置段和中间段各用了哪些素材段，按出现的顺序。

**`eval-v2.jsonl` 不提交，`generated.json` 提交。** 120 题的 JSONL 有四五十 MB（`datasets/.gitignore` 把它挡在 git 外面）。`generated.json` 记着种子、JSONL 的 sha256 和字节数、素材池用了多少、每题的深度和长度。`eval/validate.ts` 每次（`scripts/check.sh` 也会跑）按记下的种子从 `pool/` 和 `items/` 重新生成，生成出来的 `generated.json` 必须和提交的一字不差，所以 JSONL 的 sha256 也对得上；本地有 `eval-v2.jsonl` 时它也要一样。改了素材段或题目，就重跑 `eval-v2-gen.ts`，把新的 `generated.json` 一起提交。金标不在 JSONL 里，改金标不用重新生成。

还没有 `generated.json`（数据还在写）时，`validate.ts` 只检查每个文件，配额不够、素材池还拼不出某些题都只是警告，不算失败。

## 素材池要多大

每个领域至少 **40 段 `same-problem`、50 段 `unrelated`**（全部约 900 段），每段平均 4000 token 左右。

- `same-problem`：d4 的 `same-problem` 题一题就要 35 到 45 段**不重复的**同领域 `same-problem` 段（14 万 token），这是下限。
- `unrelated`：本领域每一题的前置段、`unrelated` 题的中间段都从这里拿，跨题每段最多用 6 次。
- 按每个领域 12 题（每档 3 题、两种关系各半）、段长 3000 到 5000 模拟：40 加 50 时全部拼得出、总长都在 8 万以上；`unrelated` 只有 40 段时，十来题的总长掉到 5 到 8 万；段平均只有 3500 token 时，两边各要多 5 段左右。
- 段越短、某个领域的深档题越多，要的越多。`validate.ts` 会列出每个领域现在有多少段，`eval-v2-gen.ts` 拼不出时会说是哪一题、差多少。
