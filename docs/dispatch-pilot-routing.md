# Dispatch Pilot 的路由逻辑：普通子 agent 与 Workflow agent

本文对应 dispatch-pilot 0.4.1（Claude Code 2.1.296 实测）；决策模型读到什么、预算多大，见第四节（0.4.3 起，ADR 0007）。主 agent 自己的模型从不改变，这里只讲它派出去的 agent。

两类 agent 的根本区别：

| | 普通子 agent | Workflow agent |
|---|---|---|
| 谁启动它 | 主 agent 调用 Agent 工具 | Workflow 脚本里的 `agent()` |
| 什么时候决定 | 启动那一刻（`agent.spawn`）决定一次 | 能读懂的调用在**提交脚本时**决定；prompt 要运行时才拼出来的调用，在**那个 agent 自己的第 0 步**决定 |
| 模型怎么改 | 改 `agent.spawn` 的 model（写别名，引擎解析） | 写进脚本的 `agent()` 选项；或写进计划表，由核心在每一步写完整模型 ID |
| effort 怎么改 | 写进计划表，核心每一步写出 | 同左 |
| 负责的功能 | `dispatched-agents` | `workflow-agents`（提交时）+ `workflow-labels`（运行中） |

---

## 一、普通子 agent（Agent 工具）

### 时序

```mermaid
sequenceDiagram
    autonumber
    participant M as 主 agent
    participant E as 引擎
    participant D as dispatched-agents
    participant J as 决策模型（pplx / Jev）
    participant P as 计划表 agents
    participant C as 核心 turn.step
    participant B as 看板

    M->>E: 调用 Agent 工具（prompt、description、可选 model）
    E->>D: agent.spawn
    alt fork、teammate 或功能关着
        D->>E: 原样放行
    else 正常路由
        D->>J: 一个请求：选哪个模型？每步用哪档 effort？<br/>你点名或排除了哪个模型、哪档 effort？<br/>（读任务和你的话；pplx 再读派出它的对话）
        J-->>D: 各选项概率
        D->>D: decideDispatch 算出模型和 effort
        D->>E: next(spawn)，model 改成决定的别名
        E-->>D: agentId 和实际模型
        D->>P: agents[agentId] = { effort, terms }
        D->>B: 记一条决定（模型、effort、理由）
    end
    loop agent 的每一步
        E->>C: turn.step
        C->>P: 读这个 agent 的计划
        C->>E: 按计划写 effort（点名的优先，下限兜底）
        C->>B: 记这一步实际发出的模型和 effort
    end
    E-->>M: Agent 工具结果 + 一段说明（实际模型、effort、谁定的）
```

### 模型和 effort 怎么定（decideDispatch）

```mermaid
flowchart TD
    A["决策模型的回答"] --> B{"你在消息里<br/>点名了模型？"}
    B -- 是 --> M1["用你点名的模型"]
    B -- 否 --> C{"主 agent 指定了模型？"}
    C -- 否 --> M2["用决策模型选的<br/>（排除的模型不选）"]
    C -- 是 --> D{"决策模型选了别的，<br/>且置信度 ≥ agentOverride（0.6）？"}
    D -- 是 --> M2
    D -- 否 --> M3["保留主 agent 的指定<br/>（被你排除时除外）"]

    M1 --> E
    M2 --> E
    M3 --> E
    E{"你在消息里<br/>点名了 effort？"}
    E -- 是 --> F1["用你点名的 effort<br/>（不受下限影响）"]
    E -- 否 --> F2["决策模型的 effort<br/>（往上取一档、max 门槛）"]
    F2 --> G{"低于模型下限？<br/>sonnet / opus 至少 medium"}
    G -- 是 --> F3["抬到下限"]
    G -- 否 --> F4["照用"]
```

haiku（Haiku 5.5）和其他模型一样带 effort，没有下限。

### 请求失败时

决策模型超时、出错或回答读不懂时，agent 按主 agent 原来的要求启动，用引擎自己的 effort，看板上这一行写「未路由」和原因。

---

## 二、Workflow agent

Workflow 是**循序渐进**的：脚本运行到哪个 `agent()`，那个 agent 才启动；后面 agent 的 prompt 常常由前面 agent 的结果拼出来。所以路由分两个阶段。

### 阶段 1：主 agent 提交脚本时

```mermaid
flowchart TD
    S["主 agent 调用 Workflow 工具"] --> T{"怎么交的脚本？"}
    T -- "scriptPath / name / resume" --> P1["不改写脚本"]
    P1 --> L1["workflow-labels：工具启动后读运行用的脚本，<br/>对每个调用问一次决策模型，决定先记下来"]
    T -- "inline script" --> R{"脚本读得懂吗？"}
    R -- 否 --> P2["不改写；之后每个 agent<br/>在第 0 步当场决定"]
    R -- 是 --> Q["workflow-agents：每个 agent() 调用点问一次<br/>（循环、parallel 里的调用也只问一次），分批发请求"]
    Q --> K{"这个调用的 prompt<br/>提交时读得出来吗？"}
    K -- "读得出来<br/>（字符串或模板）" --> W["把决定的 model、effort<br/>直接写进这个 agent() 的选项"]
    K -- "读不出来<br/>（运行时才拼，如 MAP_PROMPT(...)）" --> X["留着不写，标成<br/>「启动时再定」"]
    W --> Run["工具运行改写后的脚本"]
    X --> Run
    P2 --> Run
    L1 --> Run
    Run --> N["工具结果后面告诉主 agent：<br/>写了什么、哪些等启动时再定"]
    Run --> Rec["workflow-labels 记下这次运行：<br/>runId、运行目录、每个调用的去向"]
```

`workflowMode: return` 时不改写，而是把决定退回给主 agent，让它自己写进脚本再交一次。

### 阶段 2：脚本运行中，每个 agent 启动时

```mermaid
sequenceDiagram
    autonumber
    participant S as Workflow 脚本
    participant E as 引擎
    participant D as dispatched-agents / 看板 spawn hook
    participant L as workflow-labels
    participant J as 决策模型
    participant P as 计划表 agents
    participant C as 核心 turn.step

    S->>E: 运行到 agent(prompt, { label })<br/>（prompt 可能用到前面 agent 的结果）
    E->>D: agent.spawn（带 workflow 字段）
    D->>E: 跳过：Workflow agent 不归它们管<br/>（引擎也不让改它的模型）
    E->>E: journal 写一行 started（agentId、label）
    E->>L: 这个 agent 的第 0 步 turn.step
    L->>L: 按 label 在记下的运行里找到它的 agent() 调用
    alt 调用已写进脚本
        L->>P: 只写你的约束（点名、排除）
    else 提交时已决定、脚本没改写（path / name / resume）
        L->>P: 写决定好的模型（完整 ID）和 effort
    else 启动时再定（prompt 运行时才拼）
        L->>E: 读这个 agent 的 transcript，取出真实任务
        L->>J: 按这个任务和启动运行那一轮的话问模型和 effort<br/>（pplx 再加脚本、到 Workflow 调用为止的对话）
        J-->>L: 回答
        L->>P: 写模型（完整 ID，如 claude-sonnet-5-5）和 effort
    end
    L->>C: next(e)
    loop 这个 agent 的每一步（含第 0 步）
        C->>P: 读计划
        C->>E: 写出这一步的 model 和 effort
    end
```

### 一个真实的例子

```mermaid
gantt
    title client-panel-inventory 的运行（示意）
    dateFormat mm:ss
    axisFormat %M:%S
    section 提交时
    workflow-agents 决定并写进脚本（transcribe、verify、write、qa） :done, a1, 00:00, 6s
    map 调用的 prompt 读不出，留到启动时 :done, a2, 00:00, 6s
    section 运行中
    transcribe 各批（脚本里写好的 sonnet high） :b1, 00:06, 50s
    verify 各批（脚本里写好的 sonnet high） :b2, after b1, 40s
    map clashmac 启动，第 0 步当场决定 :crit, c1, after b2, 2s
    map clashmac 按决定的模型和 effort 运行 :c2, after c1, 50s
```

---

## 三、两类 agent 共用的后续环节

```mermaid
flowchart LR
    A["每一步 turn.step"] --> B["核心 planStep：<br/>模型 = 计划的，没有就用引擎的<br/>effort = 点名的 > 计划的（抬到下限）> 引擎的"]
    B --> C["看板记下这一步实际发出的模型和 effort"]
    A --> D{"工具调用接连失败<br/>达到 escalateAfter？"}
    D -- 否 --> A
    D -- 是 --> E["再问决策模型：失败是预期内的吗？"]
    E -- 预期内 --> A
    E -- 不是 --> F{"effort 已经到顶？"}
    F -- 否 --> G["effort 升一档<br/>（escalateMode: max 则直接到 max）"]
    F -- "是，且是 haiku agent" --> H["改用 escalateHaikuTo（默认 sonnet）"]
    F -- "是，其他模型" --> I["保持，记一条决定"]
```

看板上：依据面板里的「模型」是**决定**，agent 行上的模型是**实际发出的**。两者不一致说明决定没生效，以 agent 行为准。

---

## 四、决策模型读到什么（0.4.3 起，ADR 0007）

| 请求 | 一定有 | 选 pplx 时另有（背景） | 预算（Jev / pplx，估算 token） |
|---|---|---|---|
| 普通子 agent | 任务、描述、agent 类型、你这一轮的话；`unresolved` 开着时的问题摘要和次数 | 派出它的对话，到这次 Agent 调用为止（子 agent 派出的读那个子 agent 的） | 24000 / 32000 |
| Workflow：一个请求装得下所有调用 | 每个调用的 brief（平分预算）、你这一轮的话、摘要和次数 | 整个脚本（最多三分之一）、到这次 Workflow 调用为止的对话 | 24000 / 48000 |
| Workflow：分成几个请求同时发 | 同上 | 同上 | 24000 / 每个 32000 |
| Workflow：agent 启动时当场判断 | 它的真实任务、**启动运行那一轮**的话、那时的摘要和次数 | 那份脚本、到那次 Workflow 调用为止的对话 | 24000 / 32000 |

- 对话只有文字和工具名，不含文件内容和工具输出；任务和你的话先放，背景填剩下的预算，对话从新往旧放。
- 预算按 pplx 的回答时间定，不按窗口：pplx 一个请求最多 262,144 token，但 48000 估算 token 单发就要 4.3–5.9 秒，而一次决策最多等 8 秒；几个 agent 一起派出时，同时 5 个 32000 都在 5.2 秒内。`pplxQps` 默认 5，让它们一起发出。
- Jev 不带背景：它只等 1500 毫秒，同一个 key 的请求一个一个答。
