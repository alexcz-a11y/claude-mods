# Dispatch Pilot 的路由逻辑：普通子 agent 与 Workflow agent

本文最初对应 dispatch-pilot 0.4.1（Claude Code 2.1.296 实测），现按 0.7.0 的代码更新（Workflow agent 在派出时路由，Claude Code 2.1.300 起）；决策模型读到什么、预算多大，见第四节（ADR 0007、0009）。0.9.0 起模型由是非题加代码里的模型表定（ADR 0015），下面的「模型和 effort 怎么定」按它改过。主 agent 自己的模型从不改变，这里只讲它派出去的 agent。

两类 agent 的根本区别：

| | 普通子 agent | Workflow agent |
|---|---|---|
| 谁启动它 | 主 agent 调用 Agent 工具 | Workflow 脚本里的 `agent()` |
| 什么时候决定 | 启动那一刻（`agent.spawn`）决定一次 | 能读懂的调用在**提交脚本时**决定；prompt 要运行时才拼出来的调用，在**那个 agent 派出时**（`agent.spawn`）决定 |
| 模型怎么改 | 改 `agent.spawn` 的 model（写别名，引擎解析） | 写进脚本的 `agent()` 选项；或改 `agent.spawn` 的 model（同左） |
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
    alt fork、teammate、被唤醒的 agent（e.resume）或功能关着
        D->>E: 原样放行
    else 正常路由
        D->>J: 一个请求：关于任务的十道是非题（改不改东西、几步、只汇报、出错代价、原因未知、方案未定、仓库外事实、科学计算；开了 agentFable 加前沿难题）<br/>每步用哪档 effort？你点名或排除了哪个模型、哪档 effort？<br/>（读任务和你的话，再读派出它的对话；同一条消息里派出的几个 agent 合进一个请求，每个请求最多 4 个，ADR 0009、0015）
        J-->>D: 每道是非题的概率、各档概率
        D->>D: decideDispatch 按模型表定模型，按基础档和下限定 effort
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

是非题 ≥ 0.7 算是、≤ 0.3 算否，中间拿不准（TypeSafe 的起点）；你点名、排除的模型和点名的 effort 也按 0.7 算。

```mermaid
flowchart TD
    A["决策模型的回答"] --> B{"① 你在消息里<br/>点名了模型？"}
    B -- 是 --> M1["用你点名的模型"]
    B -- 否 --> T{"模型表，第一条成立的定模型<br/>② 开了 agentFable 且前沿难题是 → fable<br/>③ 出错代价、原因未知、方案未定、仓库外事实、科学计算任一为是 → opus<br/>③b 这七题任一拿不准 → sonnet，effort 至少 max<br/>④ 不改东西、一两步、只汇报 → haiku<br/>⑤ 其余 → sonnet"}
    T --> X{"表给的被你排除了？"}
    X -- 是 --> N["换最近的可用模型<br/>先往强的找，没有再往弱的找"]
    X -- 否 --> C
    N --> C{"主 agent 指定了模型<br/>（你没排除它）？"}
    C -- 否 --> M2["用表给的"]
    C -->|是，表给的更强| M3["升级到表给的"]
    C -->|是，表给的不比它强| M4["保留主 agent 的指定（只升不降）"]

    M1 --> E
    M2 --> E
    M3 --> E
    M4 --> E
    E{"你在消息里<br/>点名了 effort？"}
    E -- 是 --> F1["用你点名的 effort<br/>（不受任何下限影响）"]
    E -- 否 --> F2["基础档：各档概率的加权位置四舍五入，双峰再高一档"]
    F2 --> G["按下限抬，只抬不压，取最高：<br/>出错代价（max / xhigh / high）、原因未知（xhigh / high）<br/>表停在 ③b（max）、模型下限（sonnet、opus 至少 medium）"]
```

haiku（Haiku 5.5）和其他模型一样带 effort，没有模型下限。

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
    R -- 否 --> P2["不改写；之后每个 agent<br/>派出时当场决定"]
    R -- 是 --> Q["workflow-agents：每个 agent() 调用点问一次<br/>（循环、parallel 里的调用也只问一次），分批发请求"]
    Q --> K{"这个调用的 prompt<br/>提交时读得出来吗？"}
    K -- "读得出来<br/>（字符串或模板）" --> W["把决定的 model、effort<br/>直接写进这个 agent() 的选项"]
    K -- "读不出来<br/>（运行时才拼，如 MAP_PROMPT(...)）" --> X["留着不写，标成<br/>「派出时再定」"]
    W --> Run["工具运行改写后的脚本"]
    X --> Run
    P2 --> Run
    L1 --> Run
    Run --> N["工具结果后面告诉主 agent：<br/>写了什么、哪些等派出时再定"]
    Run --> Rec["workflow-labels 记下这次运行：<br/>runId、每个调用的去向"]
```

`workflowMode: return` 时不改写，而是把决定退回给主 agent，让它自己写进脚本再交一次。

### 阶段 2：脚本运行中，每个 agent 派出时

```mermaid
sequenceDiagram
    autonumber
    participant S as Workflow 脚本
    participant E as 引擎
    participant L as workflow-labels
    participant J as 决策模型
    participant P as 计划表 agents
    participant B as 看板 spawn hook
    participant C as 核心 turn.step

    S->>E: 运行到 agent(prompt, { label })<br/>（prompt 可能用到前面 agent 的结果）
    E->>L: agent.spawn（带 workflow 字段；description 是 label，prompt 是任务）<br/>dispatched-agents 跳过它
    L->>L: 按 runId 找到记下的运行（运行的第一个 agent 等 Workflow 调用处理完），<br/>按 label 找到它的 agent() 调用
    alt 调用已写进脚本
        L->>E: next(e)，模型照脚本
        L->>P: 只写你的约束（点名、排除）
    else 提交时已决定、脚本没改写（path / name / resume）
        L->>E: next(spawn)，model 改成决定的别名
        L->>P: 写决定好的 effort 和约束
    else 派出时再定（prompt 运行时才拼）
        L->>J: 按派出带来的任务和启动运行那一轮的话问模型和 effort<br/>（再加脚本、到 Workflow 调用为止的对话；一起派出的合进一个请求）
        J-->>L: 回答
        L->>E: next(spawn)，model 改成决定的别名
        L->>P: 写 effort 和约束
    end
    E-->>B: agentId：节点接替它的调用的节点
    loop 这个 agent 的每一步（含第 0 步）
        E->>C: turn.step
        C->>P: 读计划
        C->>E: 写出这一步的 effort
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
    map clashmac 派出时当场决定 :crit, c1, after b2, 2s
    map clashmac 按决定的模型和 effort 运行 :c2, after c1, 50s
```

---

## 三、两类 agent 共用的后续环节

```mermaid
flowchart LR
    A["每一步 turn.step"] --> B["核心 planStep：<br/>模型 = 计划的，没有就用引擎的<br/>effort = 点名的 > 计划的（抬到下限）> 引擎的"]
    B --> C["看板记下这一步实际发出的模型和 effort"]
    T["工具调用结束"] --> D{"计入的失败累计<br/>达到 escalateAfter？"}
    D -- 否 --> T
    D -- 是 --> F{"能升吗？<br/>没点名模型、没到 escalateLimit、<br/>往上还有没被排除的模型"}
    F -- 能 --> G["计划的模型升一档，下一步起生效：<br/>haiku → escalateHaikuTo（默认 sonnet）<br/>sonnet → opus → fable（要 agentFable）<br/>effort 不变，不问决策模型"]
    F -- 不能 --> I["保持，记一条决定写明原因"]
```

0.9.0 起（ADR 0013）失败到门槛不再问决策模型「是不是预期内的」，也不升 effort（2.1.312 起一轮中途改 effort 不生效），只换模型。

看板上：依据面板里的「模型」是**决定**，agent 行上的模型是**实际发出的**。两者不一致说明决定没生效，以 agent 行为准。

---

## 四、决策模型读到什么（0.4.3 起，ADR 0007）

| 请求 | 一定有 | 背景（pplx 带；Jev 2026-10-15 起也带） | 预算（Jev / pplx，估算 token） |
|---|---|---|---|
| 普通子 agent | 任务、描述、agent 类型、你这一轮的话；`unresolved` 开着时的问题摘要和次数 | 派出它的对话，到这次 Agent 调用为止（子 agent 派出的读那个子 agent 的） | 96000 / 32000 |
| Workflow：一个请求装得下所有调用 | 每个调用的 brief（平分预算）、你这一轮的话、摘要和次数 | 整个脚本（最多三分之一）、到这次 Workflow 调用为止的对话 | 96000 / 48000 |
| Workflow：分成几个请求同时发 | 同上 | 同上 | 96000 / 每个 32000 |
| Workflow：agent 派出时当场判断 | 派出带来的任务、**启动运行那一轮**的话、那时的摘要和次数 | 那份脚本、到那次 Workflow 调用为止的对话 | 96000 / 32000 |

- 对话只有文字和工具名，不含文件内容和工具输出；任务和你的话先放，背景填剩下的预算，对话从新往旧放。
- 预算按 pplx 的回答时间定，不按窗口：pplx 一个请求最多 262,144 token，但 48000 估算 token 单发就要 4.3–5.9 秒，而一次决策最多等 8 秒；几个 agent 一起派出时，同时 5 个 32000 都在 5.2 秒内。`pplxQps` 默认 5，让它们一起发出。
- Jev 在 2026-10-15 之前不带背景（它只等 1500 毫秒，当时以为同一个 key 的请求一个一个答，那是 1.13 上短请求的实测）。之后也带，上表的 Jev 一列就是现在的值：预算 96000，超过 24000 带长上下文请求头，一起派出的 agent 合进一个请求，最多 4 个请求同时在途，所有 Jev 请求按账号的限额限速（ADR 0009）。
