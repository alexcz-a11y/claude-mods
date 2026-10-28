# Dispatch Pilot 的 effort 和 agent 决策流程

本文画的是 dispatch-pilot 0.8.2 的流程，也就是升级到 Claude Code 2.1.312、按 TypeSafe 官方指南改动之前的版本。改动后的流程见 [dispatch-pilot-decision-flow-0.9.0.md](dispatch-pilot-decision-flow-0.9.0.md)，图号一一对应。默认的决策模型是 pplx；两个模型默认值不同的参数，表里分列 Jev 和 pplx。

图里的颜色：

- 蓝色：问决策模型（pplx 或 Jev）
- 黄色：代码里的规则
- 绿色：最后用的 effort 或模型
- 粉色：你自己的控制（锁定、点名）
- 灰色：不判断，或判断失败、放行
- 橙色虚线框：`dp/official-guide` 分支上正在删除或改写的部分，见文末「改动预告」

目录：

- 图 0　总览：一条消息从进来到这一轮结束
- 图 1　发消息时：主 agent 的 effort
- 图 2　档位规则：五档概率怎么变成一档
- 图 3　一轮进行中：每一步怎么发出（3a），中途重判（3b）
- 图 4　卡住时强制升档
- 图 5　派出 agent 的模型和 effort
- 图 6　Workflow 里的 agent
- 图 7　未解决次数、强提示和问题摘要

---

## 图 0　总览

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    U["一条消息到达<br/>prompt.submit（发消息事件）"] --> K{"是哪一类消息？"}
    K -->|"你本人的消息<br/>或你输入的 skill、markdown 命令"| D1["完整判断，见图 1"]
    K -->|"agent 交回结果、后台任务通知<br/>（会话空闲时它们开始新一轮）"| D2["报告轮：只判 effort<br/>不推荐 skill、不问未解决、不中途重判"]
    K -->|"一轮进行中你又发的消息"| D3["排队消息：下一步送进这一轮<br/>它的判断从那一步起接管这一轮"]
    K -->|"/dp、/clear 等本地命令<br/>定时任务、插件消息、空消息"| D0["不判断"]
    D1 --> RUN["这一轮开始运行"]
    D2 --> RUN
    D3 --> RUN
    RUN --> STEP["每一步发出前：turn.step（每一步事件）<br/>核心按计划表写出这一步的 effort，见图 3a"]
    STEP --> EV{"这一步里发生了什么？"}
    EV -->|"到了重判间隔，或派出 agent、<br/>启动 Workflow、加载 skill"| MID["中途重判，见图 3b<br/>改完计划表，回到下一步"]
    EV -->|"工具调用失败累计到 escalateAfter"| ESC["强制升档，见图 4<br/>改完计划表，回到下一步"]
    EV -->|"调用 Agent 工具"| AG["派出 agent 的判断，见图 5"]
    EV -->|"调用 Workflow 工具"| WF["Workflow agent 的判断，见图 6"]
    EV -->|"这一轮结束"| DONE["turn.complete（一轮结束事件）<br/>unresolved 开着时，haiku 在后台续写问题摘要，见图 7"]

    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,color:#1f2937
    classDef skip fill:#f1f5f9,stroke:#94a3b8,color:#334155
    classDef change fill:#fff7ed,stroke:#ea580c,stroke-width:2px,stroke-dasharray:6 4,color:#1f2937
    class D1,D2,D3,AG,WF rule
    class STEP out
    class D0 skip
    class MID,ESC change
```

| 英文 | 中文 | 是什么意思 |
|---|---|---|
| `prompt.submit` | 发消息事件 | 你发出一条消息、引擎收到它时触发。发消息时的判断都从这里开始 |
| `turn.step` | 每一步事件 | 一轮里每个模型请求发出前触发。dp 的核心在这里写出这一步用的 effort（派出 agent 还有模型） |
| `turn.complete` | 一轮结束事件 | 一轮结束时触发。问题摘要在这之后写 |
| 报告轮 | | 派出 agent 交回结果、后台任务结束、另一个 Claude 会话发来消息，会话空闲时它们会开始主 agent 的新一轮。这种轮只判 effort |
| 排队消息 | | 你在一轮进行中又发的消息，引擎在下一步把它送进这一轮。它照常判断，判出的 effort 从那一步起接管这一轮 |

---

## 图 1　发消息时：主 agent 的 effort

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    M["你本人的消息<br/>prompt.submit"] --> SW{"dp 和 main-effort<br/>都开着？"}
    SW -->|否| ENG["不判断，这一轮用会话自己的 effort"]
    SW -->|是| IMG{"带图，且开了<br/>image-routing？"}
    IMG -->|是| RD["先读参考图：reference_complexity（参考图复杂度，0 到 4）<br/>最多多等约 3 秒，读不到就不带"]
    IMG -->|否| ST
    RD --> ST["拼 state（发给决策模型的材料）<br/>user_message：你的消息<br/>recent_context：最近的对话，只有文字和工具名<br/>command：命令轮里你输入的命令和它的用途"]
    ST --> UN{"开了 unresolved？"}
    UN -->|是| UQ["加三选一题，state 加 problem_summary 和 unresolved_count<br/>次数到了 unresolvedMaxAfter，另加一道强提示题，见图 7"]
    UN -->|否| REQ
    UQ --> REQ["effort 题单独发一个请求（skill 推荐另发一个，同时发出）<br/>state 预算 contextTokens：Jev 96000，pplx 48000"]
    REQ --> DM[("决策模型 decisionModel<br/>默认 pplx，可选 Jev")]
    DM --> OK{"timeoutMs 之内<br/>拿到能读的回答？"}
    OK -->|"否：超时、出错、读不懂、没有 key"| FAIL["放行：这一轮用会话自己的 effort<br/>看板写明原因，弹一个 toast"]
    OK -->|是| PICK["五档概率，按档位规则定一档，见图 2"]
    PICK --> PLAN["写进计划表：这一轮的 effort"]
    PLAN --> LOCK{"/dp lock<br/>锁定了档位？"}
    LOCK -->|是| L1["每一步用锁定的档位<br/>（判断照常记进日志）"]
    LOCK -->|否| L2["这一轮每一步都用这一档<br/>中途重判、强制升档还可能改它"]

    classDef dm fill:#dbeafe,stroke:#2563eb,color:#1f2937
    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,color:#1f2937
    classDef skip fill:#f1f5f9,stroke:#94a3b8,color:#334155
    classDef you fill:#fce7f3,stroke:#db2777,color:#1f2937
    classDef change fill:#fff7ed,stroke:#ea580c,stroke-width:2px,stroke-dasharray:6 4,color:#1f2937
    class DM dm
    class ST,RD,PLAN rule
    class L2 out
    class L1,LOCK you
    class ENG,FAIL skip
    class UQ,REQ,PICK change
```

| 英文 | 中文 | 是什么意思 | Jev | pplx |
|---|---|---|---|---|
| `main-effort` | 主 agent effort 开关 | 关掉后发消息时不判 effort | 开 | 开 |
| `image-routing` | 带图路由开关 | 你贴了参考图时，先读出「照着做有多复杂」，作为提示交给决策模型 | 关 | 关 |
| `reference_complexity` | 参考图复杂度 | 图像后端给的 0 到 4 的读数，只是提示，不直接定档 | | |
| `state` | 决策材料 | 和问题一起发给决策模型的数据 | | |
| `user_message` | 你的消息 | 你这条消息的原文，secret 已脱敏 | | |
| `recent_context` | 最近对话 | 这条消息之前的对话，只有文字和调用过的工具名（比如 `Bash x3 (1 failed)`），不含文件内容和工具输出 | | |
| `command` | 命令 | 命令轮里你输入的命令和参数，以及这个命令是做什么的；不读命令展开后的正文 | | |
| `unresolved` | 未解决次数开关 | 打开后多问一道三选一题，还会数次数、写摘要、给强提示，见图 7 | 关 | 关 |
| `contextTokens` | state 预算 | state 最多占多少 token，旧消息先丢。Jev 超过 24000 时带长上下文请求头 | 96000 | 48000 |
| `contextMessages` | 最近消息条数上限 | 最多带多少条最近的消息，实际发多少由 token 预算决定 | 2000 | 2000 |
| `decisionModel` | 决策模型 | 由谁来判断。默认 pplx；没有 Perplexity key 但有 TypeSafe key 时退回 Jev | | 默认 |
| `timeoutMs` | 等待上限 | 等决策模型回答的最长时间，超过就放行 | 1500 毫秒 | 8000 毫秒 |
| `/dp lock 档位` | 锁定 | 本会话里主 agent 每一步都用这一档，优先于所有判断 | | |
| `/dp off` | 总开关 | 关掉后不发任何决策请求，锁定也不生效，每一步按引擎原样发出 | | |

---

## 图 2　档位规则：五档概率怎么变成一档

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    P["决策模型给的五档概率<br/>low · medium · high · xhigh · max"] --> T1["① 取概率最高的一档，并列取较高的"]
    T1 --> G{"② 最高的是 max，<br/>但 p(max) 低于 thetaMax？"}
    G -->|是| G1["改取其余四档里概率最高的"]
    G -->|否| U
    G1 --> U{"③ 高一档的概率<br/>≥ roundUp？"}
    U -->|"是（高一档是 max 时，还要 ≥ thetaMax）"| U1["往上取一档，只取一次"]
    U -->|否| U2["不变"]
    U1 --> F{"④ 派出 agent：<br/>低于模型下限？"}
    U2 --> F
    F -->|"是：sonnet、opus 至少 medium"| F1["抬到下限"]
    F -->|"否，或是主 agent"| F2["这就是结果"]

    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,color:#1f2937
    classDef change fill:#fff7ed,stroke:#ea580c,stroke-width:2px,stroke-dasharray:6 4,color:#1f2937
    class P,T1,F rule
    class F1,F2 out
    class G,G1,U,U1,U2 change
```

| 英文 | 中文 | 是什么意思 | Jev | pplx |
|---|---|---|---|---|
| `low` `medium` `high` `xhigh` `max` | 五档 effort | 模型每次回答前思考的深度，从浅到深 | | |
| `p(max)` | max 的概率 | 决策模型认为该用 max 的概率 | | |
| `thetaMax` | max 门槛 | max 自己的概率至少要到这么高才用 max。发消息时、中途重判和派出 agent 都用它 | 0.5 | 0.47 |
| `roundUp` | 上取一档门槛 | 高一档的概率达到它，就往上取一档。理由是低估一档损失质量，高估一档只多花 token。内部值，不是选项 | 0.3 | 0.45 |
| 模型下限 | | 只对派出 agent：sonnet、opus 至少 medium；haiku、fable 没有下限 | | |

---

## 图 3　一轮进行中

### 3a　每一步怎么发出

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    S0["引擎要发下一个模型请求<br/>turn.step"] --> OFF{"/dp off？"}
    OFF -->|是| S1["按引擎原样发出"]
    OFF -->|否| LK{"是主 agent，<br/>且锁定了档位？"}
    LK -->|是| S2["用锁定的档位"]
    LK -->|否| PL{"计划表里<br/>有档位？"}
    PL -->|有| S3["用计划的档位<br/>派出 agent 有你点名的 effort 时用点名的<br/>强制升档的下限还在时，至少用下限"]
    PL -->|没有| S4["用引擎自己的 effort"]

    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,color:#1f2937
    classDef skip fill:#f1f5f9,stroke:#94a3b8,color:#334155
    classDef you fill:#fce7f3,stroke:#db2777,color:#1f2937
    class OFF,PL rule
    class S3 out
    class S1,S4 skip
    class LK,S2 you
```

### 3b　中途重判

整张图都在 `dp/official-guide` 分支上删除。

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    TR["触发（只对你本人的消息开始的一轮）<br/>每 rejudgeEvery 步一次<br/>或主 agent 派出 agent、启动 Workflow、加载 skill<br/>或读到参考图（开了 image-routing）"] --> Q["工具一开始运行（tool.call）就发问<br/>决策模型读这一轮最近 rejudgeSteps 步"]
    Q --> DM[("决策模型")]
    DM --> WAIT{"下一步发出前<br/>回答到了？"}
    WAIT -->|"没到（已多等 rejudgeWaitMs）"| KEEP["沿用原来的档位，看板记「迟到」"]
    WAIT -->|到了| DIR{"按图 2 算出的建议档，<br/>比现在高还是低？"}
    DIR -->|高| UP{"置信度<br/>≥ thetaUp？"}
    UP -->|是| UP1["升到建议档"]
    UP -->|否| KEEP2["保持"]
    DIR -->|低| HOLD{"升档后已过 holdSteps 步，<br/>且置信度 ≥ thetaDown？"}
    HOLD -->|是| DN["只降一档"]
    HOLD -->|否| KEEP3["保持（防抖）"]
    DIR -->|一样| KEEP4["保持"]
    UP1 --> PLN["写进计划表，下一步发出时用它"]
    DN --> PLN

    classDef change fill:#fff7ed,stroke:#ea580c,stroke-width:2px,stroke-dasharray:6 4,color:#1f2937
    class TR,Q,DM,WAIT,KEEP,DIR,UP,UP1,KEEP2,HOLD,DN,KEEP3,KEEP4,PLN change
```

| 英文 | 中文 | 是什么意思 | Jev | pplx |
|---|---|---|---|---|
| `planStep` | 计划表写出 | 核心按顺序决定这一步的 effort（图 3a）。主 agent 的模型从不改 | | |
| `midturn-effort` | 中途重判开关 | 关掉后一轮进行中不再重新判断 | 开 | 开 |
| `tool.call` | 工具调用事件 | 工具开始运行时触发。重判在这时发问，趁工具运行的时间等回答 | | |
| `rejudgeEvery` | 重判间隔 | 一轮里每隔几步重判一次；0 表示不按步数，但派出 agent、启动 Workflow、加载 skill 时仍会重判 | 3 | 3 |
| `rejudgeSteps` | 重判读几步 | 决策模型读这一轮最近几步：主 agent 写的最后一段文字、调用的工具和每个调用怎么结束 | 16 | 16 |
| `rejudgeWaitMs` | 重判等待 | 下一步要发出时回答还没到，最多再等多久；等不到就沿用原来的档位 | 300 毫秒 | 6000 毫秒 |
| 置信度（confidence） | | 决策模型的回答有多集中，不等于「判对的概率」 | | |
| `thetaUp` | 升档门槛 | 升档要求的最低置信度 | 0.3 | 0 |
| `thetaDown` | 降档门槛 | 降档要求的最低置信度（不低于升档门槛），一次只降一档 | 0.55 | 0.55 |
| `holdSteps` | 升档后保持 | 升档之后多少步之内不降档（强制升档也算） | 5 | 5 |

---

## 图 4　卡住时强制升档

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    C["主 agent 或派出 agent 的一个工具调用结束"] --> K{"算失败吗？"}
    K -->|"你自己拒绝的"| N0["不算"]
    K -->|"被你的 settings hook 拦下"| HB{"开了<br/>hook-block-failures？"}
    HB -->|否| N0
    HB -->|是| CNT
    K -->|"工具报错"| CNT["失败计数加一，中间成功一次不清零"]
    CNT --> TH{"累计<br/>≥ escalateAfter？"}
    TH -->|否| GO["继续"]
    TH -->|是| ASK["立刻问决策模型：带着这些失败重判 effort<br/>并问这些失败是不是本来就在意料之中"]
    ASK --> EXP{"预期内的概率<br/>≥ thetaExpected？"}
    EXP -->|"是（比如先写的红测试、没搜到东西）"| RST["计数清零，当作一次普通的中途重判"]
    EXP -->|"否，或等不到回答"| LIM{"已经升了<br/>escalateLimit 次？"}
    LIM -->|是| STOP["不再升"]
    LIM -->|否| MODE{"escalateMode"}
    MODE -->|one-level| ONE["升一档，最高到 xhigh<br/>决策模型有把握时可以更高"]
    MODE -->|max| MAX["直接升到 max"]
    ONE --> TOP{"haiku agent 的<br/>effort 已到顶？"}
    MAX --> TOP
    TOP -->|是| HK["改用 escalateHaikuTo（默认 sonnet）"]
    TOP -->|否| FL["写进计划表作为下限，计数清零"]

    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef skip fill:#f1f5f9,stroke:#94a3b8,color:#334155
    classDef change fill:#fff7ed,stroke:#ea580c,stroke-width:2px,stroke-dasharray:6 4,color:#1f2937
    class K,HB,CNT,TH,LIM rule
    class N0,GO,STOP,RST skip
    class ASK,EXP,MODE,ONE,MAX,FL,TOP,HK change
```

| 英文 | 中文 | 是什么意思 | Jev | pplx |
|---|---|---|---|---|
| `escalation` | 强制升档开关 | 关掉后失败再多也不升 | 开 | 开 |
| `escalateAfter` | 升档失败次数 | 失败累计满几次就问决策模型并升档 | 2 | 2 |
| `thetaExpected` | 预期内门槛 | 决策模型认为这些失败在意料之中的概率达到它，就不升档 | 0.25 | 0.25 |
| `escalateLimit` | 升档次数上限 | 一轮（或一个派出 agent）最多因为失败升几次；每次升档后计数清零 | 2 | 2 |
| `escalateMode` | 升档方式 | `one-level` 升一档，最高到 xhigh；`max` 直接升到 max | `one-level` | `one-level` |
| `escalateHaikuTo` | haiku 换成的模型 | 失败的 haiku agent 的 effort 已到顶时，接着用哪个模型；你点名或排除的模型优先 | `sonnet` | `sonnet` |
| `hook-block-failures` | hook 拦截算失败 | 打开后，你自己的 settings hook 拦下的调用也算失败 | 关 | 关 |

---

## 图 5　派出 agent 的模型和 effort

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    A["主 agent 调用 Agent 工具<br/>agent.spawn（派出事件）"] --> SK{"fork、teammate、<br/>被唤醒的，或开关关着？"}
    SK -->|是| PASS["原样放行"]
    SK -->|否| REQ["问决策模型（同一条消息里一起派出的合进一个请求）<br/>选哪个模型（选择题）、每步用哪档 effort（打分题）<br/>你在消息里点名或排除了哪个模型、哪档 effort<br/>state：任务、描述、agent 类型、你这一轮的话、派出它的对话"]
    REQ --> DM[("决策模型")]
    DM --> OK{"等待上限之内<br/>拿到回答？"}
    OK -->|否| PASS2["按主 agent 原来的要求启动<br/>用引擎的 effort，看板写「未路由」"]
    OK -->|是| NM{"你点名了模型？"}
    NM -->|"是（把握 ≥ 0.5）"| M1["用你点名的"]
    NM -->|否| MS{"主 agent<br/>指定了模型？"}
    MS -->|否| M2["用决策模型选的：haiku、sonnet、opus<br/>（开了 agentFable 加 fable；你排除的不选）"]
    MS -->|是| OV{"决策模型选了别的，<br/>且置信度 ≥ agentOverride？"}
    OV -->|是| M2
    OV -->|否| M3["保留主 agent 的指定"]
    M1 --> EF{"你点名了 effort？"}
    M2 --> EF
    M3 --> EF
    EF -->|是| E1["用你点名的，不受下限影响"]
    EF -->|否| E2["决策模型的 effort，按图 2 定档<br/>再抬到模型下限（sonnet、opus 至少 medium）"]
    E1 --> SP["改 spawn 的 model，启动 agent<br/>计划表记下它的 effort 和你的点名"]
    E2 --> SP
    SP --> STEPS["这个 agent 的每一步：核心按计划写 effort，见图 3a"]
    SP --> NOTE["Agent 工具结果后面附一段说明：<br/>用了什么模型和 effort、是谁定的"]

    classDef dm fill:#dbeafe,stroke:#2563eb,color:#1f2937
    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,color:#1f2937
    classDef skip fill:#f1f5f9,stroke:#94a3b8,color:#334155
    classDef you fill:#fce7f3,stroke:#db2777,color:#1f2937
    class DM dm
    class REQ,MS,OV,EF,NOTE rule
    class SP,STEPS,M2,M3,E2 out
    class NM,M1,E1 you
    class PASS,PASS2 skip
```

| 英文 | 中文 | 是什么意思 | Jev | pplx |
|---|---|---|---|---|
| `agent.spawn` | 派出事件 | 一个 agent 启动前触发，dp 在这里改它的模型 | | |
| `dispatched-agents` | 派出 agent 开关 | 关掉后派出的 agent 按主 agent 的要求启动 | 开 | 开 |
| fork、teammate | 分叉、队友 | 这两种 agent，以及被唤醒继续工作的 agent，dp 不改 | | |
| 点名（terms） | | 你在消息里说「用 opus」「effort 开 low」「别用 opus」。点名的照办，不受下限影响；排除的模型不用。判为点名要把握 ≥ 0.5；effort 的点名只在消息里出现 effort、档位名、推理这类字眼时才问 | | |
| `agentOverride` | 推翻门槛 | 主 agent 为它指定了模型时，决策模型选了别的、而且置信度达到它，才推翻主 agent 的指定 | 0.6 | 0.6 |
| `agentFable` | 允许 fable | 打开后决策模型也可以选 fable（比 opus 贵） | 关 | 关 |
| `contextTokens` | state 预算 | 派出 agent 的请求最多读多少 token | 96000 | 32000 |

---

## 图 6　Workflow 里的 agent

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    S["主 agent 调用 Workflow 工具"] --> HOW{"脚本怎么交的？"}
    HOW -->|"scriptPath、name 或恢复的运行"| LB["不改脚本：workflow-labels 读运行用的脚本<br/>先为每个调用定好"]
    HOW -->|"inline script（直接写在调用里）"| RD{"读得懂吗？"}
    RD -->|否| LB2["不改脚本：每个 agent 派出时当场判断"]
    RD -->|是| Q["workflow-agents：每个 agent() 调用点问一次<br/>循环和 parallel 里的也只问一次<br/>最多 24 个调用点、4 个请求"]
    Q --> DM[("决策模型")]
    DM --> MODE{"workflowMode"}
    MODE -->|rewrite| WR["prompt 读得出来的调用：把 model、effort 写进它的选项<br/>prompt 运行时才拼出来的：留到派出时再定"]
    MODE -->|return| RT["第一次提交被拒绝，附上逐个调用的推荐<br/>主 agent 自己写进去再交，第二次直接放行"]
    WR --> RUN["脚本运行到某个 agent()，它被派出（agent.spawn）"]
    LB --> RUN
    LB2 --> RUN
    RUN --> HAS{"按 label 对上调用，<br/>它有决定了吗？"}
    HAS -->|"已写进脚本"| A1["照脚本运行，只记你的点名约束"]
    HAS -->|"已定好，没写进脚本"| A2["改 spawn 的 model，计划表写 effort"]
    HAS -->|"没有"| A3["当场问决策模型，再改 model、写 effort"]
    A1 --> STEPS["这个 agent 的每一步：核心按计划写 effort"]
    A2 --> STEPS
    A3 --> STEPS

    classDef dm fill:#dbeafe,stroke:#2563eb,color:#1f2937
    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,color:#1f2937
    class DM dm
    class Q,LB,LB2,HAS,MODE,HOW,RD rule
    class WR,RT,A1,A2,A3,STEPS out
```

| 英文 | 中文 | 是什么意思 | 默认 |
|---|---|---|---|
| `workflow-agents` | 提交时判断的开关 | 主 agent 提交脚本时为每个 `agent()` 调用定模型和 effort | 开 |
| `workflow-labels` | 派出时设置的开关 | 脚本改不了或没来得及定的调用，在 agent 派出时按 label 设置 | 开 |
| `inline script` | 内联脚本 | 脚本直接写在 Workflow 调用里，dp 可以改写它 | |
| `scriptPath` / `name` | 脚本文件 / 存好的 Workflow | 这两种交法，以及恢复的运行，dp 改不了脚本 | |
| `label` | 标签 | 每个 `agent()` 的名字，派出时靠它找到对应的调用 | |
| `workflowMode` | Workflow 模式 | `rewrite`：把决定写进脚本再运行；`return`：退回给主 agent 自己写 | `rewrite` |

---

## 图 7　未解决次数、强提示和问题摘要

这一块要 `unresolved` 开关打开（默认关）。

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 340}}}%%
flowchart TD
    M["你本人的消息"] --> Q["三选一：你在说那个问题<br/>仍未解决 / 已解决 / 换了新问题或无关"]
    Q --> A{"哪个概率够高？"}
    A -->|"仍未解决 ≥ 0.5"| ADD["未解决次数加一<br/>摘要里最后一次尝试标上「未解决」"]
    A -->|"已解决或新问题 ≥ 0.7"| CLR["次数清零，摘要清空"]
    A -->|"都不够"| SAME["次数不变"]
    ADD --> H{"这条消息之前的次数<br/>≥ unresolvedMaxAfter？"}
    H -->|是| HQ["用带强提示那道 effort 题的回答<br/>强提示：这项工作属于多次尝试都没解决的故障<br/>max 门槛改用 hintThetaMax"]
    H -->|否| PQ["用普通 effort 题的回答"]
    CLR --> PQ
    SAME --> PQ

    T["这一轮结束（turn.complete）"] --> SUM["summaryModel（默认 haiku）在后台续写问题摘要<br/>问题是什么、试过什么、现在到哪一步，不超过 500 token<br/>只记试过什么，不判断成没成功"]
    SUM --> NEXT["下一条消息的 state 带上<br/>problem_summary 和 unresolved_count"]

    classDef dm fill:#dbeafe,stroke:#2563eb,color:#1f2937
    classDef rule fill:#fef3c7,stroke:#d97706,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,color:#1f2937
    classDef change fill:#fff7ed,stroke:#ea580c,stroke-width:2px,stroke-dasharray:6 4,color:#1f2937
    class Q dm
    class ADD,CLR,SAME,SUM,NEXT,T,M rule
    class PQ out
    class A,H,HQ change
```

| 英文 | 中文 | 是什么意思 | Jev | pplx |
|---|---|---|---|---|
| `still_unresolved` / `resolved` / `new_or_unrelated` | 仍未解决 / 已解决 / 新问题或无关 | 三选一题的三个选项。只看你自己的话；助手说的「已修复」不算 | | |
| 0.5 和 0.7 | 加一门槛、清零门槛 | 「仍未解决」概率 ≥ 0.5 就加一；「已解决」或「新问题」≥ 0.7 才清零。内部暂定值 | 0.5 / 0.7 | 0.5 / 0.7 |
| `unresolvedMaxAfter` | 强提示门槛 | 未解决次数达到它，就另问一道带强提示的 effort 题；0 表示不给 | 3 | 3 |
| `hintThetaMax` | 强提示时的 max 门槛 | 用带强提示的回答时，max 门槛改用它。内部值 | 0.4 | 0.47 |
| `problem_summary` | 问题摘要 | haiku 写的「问题、试过什么、现在到哪一步」，让决策模型看到超出预算的更早几轮 | | |
| `unresolved_count` | 未解决次数 | 你说「仍未解决」的次数；`/clear` 和新会话清零 | | |
| `summaryModel` | 写摘要的模型 | 用你的 Claude Code 登录和用量调用；判断从不等它写完 | `haiku` | `haiku` |

---

## 改动预告（`dp/official-guide` 分支）

图里橙色虚线框的部分正在改：

| 图 | 现在 | 改成 |
|---|---|---|
| 图 1 | 默认 pplx；Jev 用中文问法，state 最多 96000 并带长上下文请求头 | 默认 Jev，英文问法，state 留在每题 32k 的常规上限内；加几道窄的是非题和代码规则；问题摘要单独一个开关，默认开 |
| 图 2 | `thetaMax`、`roundUp` 这些按我们自己 eval 调出的门槛 | 删除。读打分题的加权位置并四舍五入；双峰时往上取一档；没有置信度门槛 |
| 图 3b | 中途重判 | 整块删除。Claude Code 2.1.312 起，一轮中途改 effort 要等到下一条有新输入的消息才生效 |
| 图 4 | 主 agent 和派出 agent 都升 effort | 主 agent：失败记录带到你的下一条消息，由那里的规则抬档；派出 agent：改成升模型（中途换模型立即生效） |
| 图 7 | 三选一，0.5 / 0.7 门槛，强提示另问一道题 | 拆成三道是非题，门槛用官方起点 0.7 / 0.3；强提示改成代码里的下限 |
