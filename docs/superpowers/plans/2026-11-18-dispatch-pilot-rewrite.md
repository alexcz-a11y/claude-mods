# dispatch-pilot 重写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `dispatch-pilot/` 原地换成从零写的单插件实现，在普通会话和 Code Mode 会话里用同一条路径做三项换挡和 skill 一组功能，并在两种会话里实机验证。

**Architecture:** 一个 hooks 入口文件注册全部事件，每个 hook 只把 `$` 包成闭包（`io`）再调纯模块；判断由 Drex 回答一道分档题和几道条件题，档位和模型由代码里的表算出。中途换挡在带着脚本结果的工具结果行上加一行说明；每次请求实际带的档位由 `http.fetch` hook 从请求体读出来记进决策记录。

**Tech Stack:** TypeScript（Claude Code 直接加载，无构建），Claude Code mods API 2.1.327，`claude plugin test`（`claude-code/testing`），Nace Drex `POST /v1/systemone`，TypeSafe Jev 同协议。

**Spec:** `docs/superpowers/specs/2026-11-17-dispatch-pilot-rewrite-design.md`（下文「设计 N 节」都指它；3.2 节的 E1 到 E18 是实测的引擎事实）。

**范围：** 这份计划到「mod 做完、测试通过、两种会话实机验证过」为止，门槛用设计 5.2 节的初值。校准（设计第 8 节：用例、对照、定门槛、进展记录的去留、发布 1.0.0）另写一份计划，在这份执行完之后写，因为它要用到做出来的 mod 实际发的请求。

## Global Constraints

- Claude Code `>=2.1.327`；分支 `dp/rewrite`，只在 worktree `/Users/alexnear/Documents/claude-mods/.claude/worktrees/dp-rewrite` 里改。
- hooks 模块里不出现 `tool.call`、`tool.check`、`tool.run`、`tool.judge`、`agent.offer`、`session.send`、任何 `classic.*`，不调用 `$.tool.register`。
- 主 agent 的模型永不改写。
- 任何会话、任何测试都不打开 OpenTelemetry（不设 `CLAUDE_CODE_ENABLE_TELEMETRY`、`ENABLE_BETA_TRACING_DETAILED`）。
- 任何失败都放行：请求失败、超时、回答缺题或类型不对、Drex 回答的 `model` 不是 `drexModel`、`e.effort` 缺省或是数字、`mode` 为 `shadow`。每个 hook 的主体包在兜底里，总是走到 `next(e)`。
- 判断的时限：发消息 4000 ms，中途 2000 ms，agent 3000 ms；超时不重试。
- 发给决策模型的 state 不超过 4000 token（按 `estimateTokens` 估），不脱敏，只截断。除 Drex、Jev 的接口外不向任何地方发送会话内容。
- 默认后端 Drex，模型固定 `drex-max-v1.1`；Jev 用 `jev-latest`；`fallback` 默认关。
- 中途换挡：一轮最多 `midrunMaxNotes`（4）条说明，两次换挡至少隔 3 个工作步，最高到 `xhigh`。
- 决策记录存 `$.store` 的 `log`，只留最近 200 条。
- 所有题的措辞只在 `hooks/questions.ts` 里；题和说明行用英文，给人看的文字（`/dp`、状态行）用中文。
- mod 约束（仓库 CLAUDE.md）：`$` 只交给同一文件顶层声明的函数，不跨 import；同一事件不带 matcher 只注册一次；hook 是函数字面量；相对导入带 `.ts` 后缀；`$` 的 API 写全名。
- 数值配置不声明 `min`/`max`（越界的旧设置会让 mod 加载失败），在 `readConfig` 里夹到范围内。
- 提交信息形如 `dispatch-pilot 1.0.0: …`，末尾加 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`。提交走 pre-commit（`scripts/check.sh`），不用 `--no-verify`。
- 起过的 tmux 会话和后台进程，用完按 PID 或会话名杀掉，再用 `pgrep -fl` 确认没有残留。

## Review Focus

1. 两个密钥都没配：mod 不发任何请求、不改 effort，`/dp` 写明没有可用的后端。测试在 Task 5、Task 6。
2. 后端回了 200，但回答缺题、类型不对、概率不是数：按失败放行并记一条，不当作「否」。测试在 Task 4、Task 6。
3. `turn.step` 的 `e.effort` 缺省（模型不收 effort）或是数字（会话用数字档）：原样放行，不写档位。测试在 Task 6。
4. 用户的消息很长或带大段粘贴内容：state 仍在 4000 token 内，保留开头和结尾。测试在 Task 3。
5. 一步里有几条并行的工具结果行，或同一步派出几个 agent：说明只加在一条行上；每个 agent 各自判断，互不串。测试在 Task 8、Task 9。

---

## 文件结构

```
dispatch-pilot/
  .claude-plugin/plugin.json      清单和 userConfig
  hooks/hooks.json                {"modules": ["./dispatch-pilot.ts"]}
  hooks/dispatch-pilot.ts         入口：全部 on(...)，ioOf($)，把事件接到纯模块
  hooks/config.ts                 readConfig(options)
  hooks/levels.ts                 档位、模型层级
  hooks/questions.ts              所有题的措辞
  hooks/decide.ts                 decide、readNoul、三张表
  hooks/statebuild.ts             三种 state、估 token、截断
  hooks/backend.ts                ask(io, …)：Drex、Jev、核对、时限、fallback
  hooks/journal.ts                从 session.append 的行里读出一轮的依据
  hooks/midrun.ts                 检查点、限制、说明行
  hooks/skills.ts                 解析 skill 列表、推荐、find-skill
  hooks/readout.ts                从请求体读实际档位、认主循环的请求
  hooks/progress.ts               进展记录的提示词和解析
  hooks/log.ts                    决策记录、/dp 和状态行的文字
  skills/find-skill/SKILL.md
  types/index.d.ts                PluginState 契约
  eval/validate.ts                静态检查（scripts/check.sh 会跑）
  tests/support/world.ts          测试用的引擎桩
  tests/*.test.ts
  tsconfig.json  README.md  DEVELOPMENT.md
```

入口文件之外的模块都不碰 `$`，所以都能用普通单元测试直接测。

---

### Task 1: 清掉旧实现，搭新 mod 的骨架

**Files:**
- Delete: `dispatch-pilot/` 下全部旧文件，`dispatch-pilot-extras/` 整个目录
- Create: `dispatch-pilot/.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/dispatch-pilot.ts`、`hooks/config.ts`、`hooks/levels.ts`、`types/index.d.ts`、`tsconfig.json`、`eval/validate.ts`、`tests/config.test.ts`
- Modify: `.claude-plugin/marketplace.json`（去掉 `dispatch-pilot-extras` 一项，改 dispatch-pilot 的说明）、`scripts/check.sh`（`MIN_CLAUDE_CODE=(dispatch-pilot 2.1.327)`）

**Interfaces:**
- Produces（`levels.ts`）:
  - `LEVELS = ['low','medium','high','xhigh','max'] as const`，`type Level`
  - `TIERS = ['haiku','sonnet','opus','fable'] as const`，`type Tier`
  - `isLevel(v: unknown): v is Level`
  - `tierOfModelId(id: string): Tier | null`（按 id 里的家族名认，例如 `claude-fable-5-2` 是 `fable`）
- Produces（`config.ts`）: `type Config` 和 `readConfig(options: Record<string, unknown>): Config`，字段和默认值：

| 字段 | 类型 | 默认 |
|---|---|---|
| `enabled` | boolean | true |
| `mode` | `'apply' \| 'shadow'` | `'apply'` |
| `backend` | `'drex' \| 'jev'` | `'drex'` |
| `fallback` | boolean | false |
| `drexApiKey`、`jevApiKey` | string（sensitive） | `''` |
| `drexModel` | string | `'drex-max-v1.1'` |
| `jevModel` | string | `'jev-latest'` |
| `submitShift`、`midrunShift`、`agentShift`、`skills` | boolean | true |
| `midrunEverySteps` | number，夹到 0–60 | 8 |
| `midrunEveryScripts` | number，夹到 0–60 | 1 |
| `midrunMaxNotes` | number，夹到 0–12 | 4 |
| `agentModels` | 清单里是逗号分隔的字符串，读成 `Tier[]` | `'haiku,sonnet,opus'` |
| `fableAgents` | boolean | false |
| `verifyEffort` | boolean | true |
| `progressNote` | boolean | false |
| `progressNoteModel` | string | `'haiku'` |
| `submitTimeoutMs`、`midrunTimeoutMs`、`agentTimeoutMs` | number，夹到 500–9000 | 4000、2000、3000 |

- [ ] **Step 1: 删旧文件**

```bash
git rm -r -q dispatch-pilot dispatch-pilot-extras
```

- [ ] **Step 2: 写失败的测试 `dispatch-pilot/tests/config.test.ts`**

```ts
import { expect, test } from 'claude-code/testing'
import { readConfig } from '../hooks/config.ts'
import { tierOfModelId } from '../hooks/levels.ts'

test('空的 options 得到设计里的默认值', () => {
  const c = readConfig({})
  expect(c.backend).toBe('drex')
  expect(c.drexModel).toBe('drex-max-v1.1')
  expect(c.fallback).toBe(false)
  expect(c.midrunEveryScripts).toBe(1)
  expect(c.agentModels).toEqual(['haiku', 'sonnet', 'opus'])
  expect([c.submitTimeoutMs, c.midrunTimeoutMs, c.agentTimeoutMs]).toEqual([4000, 2000, 3000])
})
test('越界和认不出的值回到范围内', () => {
  const c = readConfig({ midrunEverySteps: 999, mode: 'nonsense', agentModels: 'opus, gpt, haiku' })
  expect(c.midrunEverySteps).toBe(60)
  expect(c.mode).toBe('apply')
  expect(c.agentModels).toEqual(['haiku', 'opus'])
})
test('从模型 id 认层级', () => {
  expect(tierOfModelId('claude-fable-5-2')).toBe('fable')
  expect(tierOfModelId('claude-haiku-5-5')).toBe('haiku')
  expect(tierOfModelId('some-other-model')).toBe(null)
})
```

- [ ] **Step 3: 写清单和骨架**
  - `plugin.json`：`name` `dispatch-pilot`，`version` `1.0.0`，`engines: { "claude-code": ">=2.1.327" }`，`types: "./types/index.d.ts"`，`userConfig` 按上表逐项写（每项有中文 `title` 和 `description`，两个密钥 `sensitive: true`）。
  - `tsconfig.json`：照 `image-pane/tsconfig.json` 原样。
  - `types/index.d.ts`：先只声明空的 `'dispatch-pilot': {}`，后面的任务往里加键；顶层不写 `export`。
  - `hooks/dispatch-pilot.ts`：`export const register: Register = (on, options) => { const cfg = readConfig(options) }`，暂不注册事件。
  - `eval/validate.ts`（Node 直接跑）：读 `hooks/` 下每个 `.ts`，出现 `on('tool.call'`、`on('tool.check'`、`on('tool.run'`、`on('tool.judge'`、`on('agent.offer'`、`on('session.send'`、`on('classic.`（单双引号都算）或 `$.tool.register` 就打印文件和行号并以 1 退出。

- [ ] **Step 4: 实现 `levels.ts` 和 `config.ts`，生成类型，跑检查**

```bash
command claude -p "hi" --plugin-dir ./dispatch-pilot --plugin-dir ./image-pane >/dev/null; ls dispatch-pilot/.claude-plugin/types image-pane/.claude-plugin/types
command claude plugin test ./dispatch-pilot
node dispatch-pilot/eval/validate.ts && scripts/check.sh
```
Expected: 类型目录存在；3 pass；`check.sh` 每行 `ok`（Desktop 那一行可以是 `note`）。`-p` 没生成类型时，在 tmux 里交互启动一次同样的 `--plugin-dir`，十秒后 `/exit` 并杀掉会话。

- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: a new skeleton in place of the old mod and its extras`）

---

### Task 2: 读回答、定档位（纯函数）

**Files:**
- Create: `dispatch-pilot/hooks/decide.ts`
- Test: `dispatch-pilot/tests/decide.test.ts`

**Interfaces:**
- Consumes: `Level`、`Tier`、`LEVELS`、`TIERS`（Task 1）
- Produces:
  - `type Thresholds = { up: number; upHigh: number; down: number; yes: number; no: number; modelDown: number }`
  - `START: Thresholds = { up: 0.7, upHigh: 0.8, down: 0.7, yes: 0.7, no: 0.3, modelDown: 0.8 }`，`thresholdsFor(backend: 'drex' | 'jev', model: string, action: 'submit' | 'midrun' | 'agent'): Thresholds`（设计 5.2 节：按后端、模型版本和动作各存一张表；现在都返回 `START`，校准后填）
  - `decide(current: Level, probs: readonly number[], t: Thresholds, cap: Level = 'max'): Level`
  - `readNoul(p: number | undefined, t: Thresholds): 'yes' | 'no' | 'unsure'`
  - `type Verdict = { level: Level; why: string }`
  - `submitLevel(base: Level, a: { open: readonly number[]; mechanical?: number; unknownCause?: number }, t: Thresholds): Verdict`
  - `midrunLevel(current: Level, a: { open: readonly number[]; sameFailure?: number; causeFound?: number; onlyCarryingOut?: number; contradictsPlan?: number }, t: Thresholds): Verdict`
  - `agentPlan(inherit: { level: Level | null; tier: Tier | null }, a: { open: readonly number[]; mechanical?: number; unknownCause?: number; readOnly?: number }, opts: { agentModels: readonly Tier[]; fableAgents: boolean }, t: Thresholds): { effort: Level | null; model: Tier | null; why: string }`

规则（设计 5.2、5.4、5.5 节）：
- `decide`：比当前高的各档概率和不低于门槛就升一档，再对新的一档重复；目标档是 `xhigh` 或 `max` 时门槛用 `upHigh`，否则 `up`；不超过 `cap`。升不动时再看降：比当前低的各档概率和不低于 `down` 就降一档，再重复。都不到就不动。
- `submitLevel`：先 `decide(base, open)`；`mechanical` 为 yes 时不高于 `medium`；`unknownCause` 为 yes 时不低于 `high`（两条都成立时取 `high`）。
- `midrunLevel`：升 = `decide(current, open, t, 'xhigh')` 高于当前，或 `sameFailure`、`contradictsPlan` 任一为 yes（这时只升一档，不超过 `xhigh`）。降 = `decide` 低于当前，并且 `causeFound` 或 `onlyCarryingOut` 为 yes。其余返回 `current`。`why` 取下面五句之一：`the remaining problem is more open than assumed`、`the same failure came back after a fix`、`a result contradicts the plan`、`the cause is found and what remains is routine`、`what remains is carrying out decided steps`。
- `agentPlan`：`effort` 同 `submitLevel`（`inherit.level` 为 null 时返回 null）。模型的候选 = `agentModels` 里不高于 `inherit.tier` 的；`fableAgents` 为 false 时去掉 `fable`，继承的是 `fable` 时先降到 `opus`（这一条不看回答）。起步的表：`readOnly` 和 `mechanical` 都不低于 `modelDown` 时取候选里最低的；否则第 0、1 档的概率和不低于 `modelDown` 时比继承的低一层，但不低于 `sonnet`；否则取继承的（封顶后）。`inherit.tier` 为 null 时 `model` 返回 null。

- [ ] **Step 1: 写失败的测试**

```ts
import { expect, test } from 'claude-code/testing'
import { START, agentPlan, decide, midrunLevel, readNoul, submitLevel } from '../hooks/decide.ts'

test('设计里的例子：从 medium 升到 high，不到 xhigh', () => {
  expect(decide('medium', [0.02, 0.08, 0.25, 0.55, 0.1], START)).toBe('high')
})
test('两边都不到门槛时不动', () => {
  expect(decide('high', [0.1, 0.3, 0.3, 0.2, 0.1], START)).toBe('high')
})
test('可以连降几档', () => {
  expect(decide('xhigh', [0.9, 0.05, 0.03, 0.01, 0.01], START)).toBe('low')
})
test('cap 封顶', () => {
  expect(decide('high', [0, 0, 0, 0.05, 0.95], START, 'xhigh')).toBe('xhigh')
})
test('noul 的三种读法', () => {
  expect([readNoul(0.7, START), readNoul(0.3, START), readNoul(0.5, START), readNoul(undefined, START)]).toEqual(['yes', 'no', 'unsure', 'unsure'])
})
test('发消息：机械改动封顶 medium，原因未知保底 high，两条都成立取 high', () => {
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  expect(submitLevel('xhigh', { open: flat, mechanical: 0.9 }, START).level).toBe('medium')
  expect(submitLevel('low', { open: flat, unknownCause: 0.9 }, START).level).toBe('high')
  expect(submitLevel('low', { open: flat, mechanical: 0.9, unknownCause: 0.9 }, START).level).toBe('high')
})
test('中途：默认不动；同一失败复现升一档；降档要两个条件', () => {
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  const easy = [0.8, 0.15, 0.05, 0, 0]
  expect(midrunLevel('high', { open: flat }, START).level).toBe('high')
  expect(midrunLevel('medium', { open: flat, sameFailure: 0.8 }, START)).toEqual({ level: 'high', why: 'the same failure came back after a fix' })
  expect(midrunLevel('high', { open: easy }, START).level).toBe('high')
  expect(midrunLevel('high', { open: easy, onlyCarryingOut: 0.8 }, START).level).toBe('low')
  expect(midrunLevel('xhigh', { open: [0, 0, 0, 0, 1], contradictsPlan: 0.9 }, START).level).toBe('xhigh')
})
test('agent：fableAgents 关着时继承的 fable 降到 opus，即使没有回答', () => {
  const opts = { agentModels: ['haiku', 'sonnet', 'opus'] as const, fableAgents: false }
  expect(agentPlan({ level: 'high', tier: 'fable' }, { open: [0.2, 0.2, 0.2, 0.2, 0.2] }, opts, START).model).toBe('opus')
  expect(agentPlan({ level: 'high', tier: 'opus' }, { open: [0.9, 0.1, 0, 0, 0], readOnly: 0.9, mechanical: 0.9 }, opts, START).model).toBe('haiku')
  expect(agentPlan({ level: 'high', tier: 'opus' }, { open: [0.5, 0.4, 0.1, 0, 0] }, opts, START).model).toBe('sonnet')
  expect(agentPlan({ level: null, tier: null }, { open: [1, 0, 0, 0, 0] }, opts, START)).toMatchObject({ effort: null, model: null })
})
```

- [ ] **Step 2: 跑测试确认失败**（`scripts/test-one.sh dispatch-pilot decide.test.ts`，Expected: FAIL，模块不存在）
- [ ] **Step 3: 按上面的规则实现 `decide.ts`**
- [ ] **Step 4: 跑测试确认通过**（同一命令，Expected: 8 pass）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: answers are read into a level and a model by code`）

---

### Task 3: 题的措辞和三种 state

**Files:**
- Create: `dispatch-pilot/hooks/questions.ts`、`dispatch-pilot/hooks/statebuild.ts`
- Test: `dispatch-pilot/tests/questions.test.ts`

**Interfaces:**
- Produces（`questions.ts`）:
  - `type Question = { type: 'score'; instructions: string; criteria: readonly string[] } | { type: 'noul'; instructions: string; criteria: { true: string; false: string } } | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }`
  - `OPEN_LEVELS: readonly [string, string, string, string, string]`
  - `submitQuestions(hasPrevious: boolean): Record<string, Question>`，键：`open`、`mechanical`、`unknown_cause`，有上一轮时加 `continues`
  - `midrunQuestions(): Record<string, Question>`，键：`open`、`same_failure`、`cause_found`、`only_carrying_out`、`contradicts_plan`
  - `agentQuestions(): Record<string, Question>`，键：`open`、`mechanical`、`unknown_cause`、`read_only`
- Produces（`statebuild.ts`）:
  - `STATE_BUDGET = 4000`，`estimateTokens(text: string): number`（UTF-8 字节数除以 3，向上取整）
  - `clip(text: string, maxTokens: number): string`（超出时留头尾各一半，中间放 ` … `）
  - `type PreviousTurn = { request: string; lastReply: string; ended: 'answered' | 'error' | 'interrupted'; level: Level | null }`
  - `type StepRecord = { did: string; tools: string[]; ok: boolean; result: string }`，`type ProgressNote = { done: string; remaining: string; cause_known: boolean }`
  - `submitState(i: { request: string; previous: PreviousTurn | null }): Record<string, unknown>`
  - `midrunState(i: { request: string; current: Level; stepsSoFar: number; failedSteps: number; recent: StepRecord[]; latest: StepRecord; statedNext: string; progress: ProgressNote | null }): Record<string, unknown>`
  - `agentState(i: { task: string; agentType: string; description: string }): Record<string, unknown>`

固定的文字（起步的写法，校准时再改）：

```ts
export const OPEN_LEVELS = [
  'The way to do it is already given; the work is carrying it out.',
  'A few possibilities within a small area, or one small trap to watch for.',
  'Several workable designs or several possible causes; a choice has to be made between them.',
  'The cause is unknown and the behavior is intermittent, concurrent or state-dependent, or the change is easy to get subtly wrong.',
  'The cause is unknown or the change is easy to get subtly wrong, and in addition it cannot be reproduced, the operation cannot be undone, or it must be switched over while running.',
] as const
```

| 键 | `instructions` | `criteria.true` | `criteria.false` |
|---|---|---|---|
| `open`（发消息） | How open is the problem that `request` asks to solve? | — | — |
| `open`（中途） | How open is the problem in the work that remains for `request`, given `recent` and `latest`? | — | — |
| `open`（agent） | How open is the problem that `task` asks to solve? | — | — |
| `mechanical` | Is the work a repetition of an approach that is already known? | Every change follows a pattern that is stated or already applied elsewhere. | At least one part needs a decision about how to do it. |
| `unknown_cause` | Does the work first require finding the cause of a problem whose cause is not known? | A failure is reported and nothing given says why it happens. | No failure is involved, or its cause is stated. |
| `continues` | Does `request` only ask the assistant to go on with work it already proposed or is doing in `previous_turn`? | The message approves or says to continue, adding no new task. | The message gives a new task, a correction, or answers only a detail. |
| `same_failure` | Does `latest.result` show the same failure that an earlier entry in `recent` showed, after a change was made to fix it? | The same error or failing check appears again after an edit aimed at it. | No failure, a different failure, or no fix was attempted in between. |
| `cause_found` | Do `recent` and `latest` show that the cause of the problem has been identified? | A result shows what makes the problem happen. | The cause is still being looked for, or there is no problem to diagnose. |
| `only_carrying_out` | Is the work that remains only carrying out what has already been decided? | What is left is applying the same change elsewhere, running checks, or writing the summary. | A decision about how to proceed is still open. |
| `contradicts_plan` | Does `latest.result` show something that contradicts what the work so far assumed? | A result shows an assumption of the approach was wrong, or a new problem appeared. | The result is what the approach expected. |
| `read_only` | Does `task` only require finding or reading information, with no changes to make? | Nothing is to be edited, created, run for effect, or sent. | At least one change is to be made. |

`mechanical` 和 `unknown_cause` 在发消息时前面写 `In `request`, `，在 agent 处写 `In `task`, `。题面里的反引号是字面的反引号（设计 5.2 节：题目用反引号里的路径指向字段）。

state 的字段名和每个字段的预算（token）：
- 发消息：`note`、`request`（1200）、`previous_turn: { request(300), last_reply(300), ended, level }`；没有上一轮时不放 `previous_turn`。
- 中途：`note`、`request`（600）、`current_level`、`steps_so_far`、`failed_steps`、`recent`（最多 5 条，从早到晚，每条 `{ did(60), tools, outcome: 'ok' | 'error', result(150) }`）、`latest`（同形，`result` 600）、`stated_next`（200，空就不放）、`progress`（有才放）。
- agent：`note`、`task`（2500）、`agent_type`、`description`（100）。
- 三个 `note`：发消息 `"request" is the user's new message; "previous_turn" is what came just before it.`；中途 `Entries in "recent" are oldest first. Judge by the results, not by what the assistant says it achieved; "stated_next" and "progress" are the assistant's own account.`；agent `"task" is the brief given to a subagent that is about to start.`

- [ ] **Step 1: 写失败的测试**

```ts
import { expect, test } from 'claude-code/testing'
import { OPEN_LEVELS, agentQuestions, midrunQuestions, submitQuestions } from '../hooks/questions.ts'
import { STATE_BUDGET, clip, estimateTokens, midrunState, submitState } from '../hooks/statebuild.ts'

test('每处问的题', () => {
  expect(Object.keys(submitQuestions(false))).toEqual(['open', 'mechanical', 'unknown_cause'])
  expect(Object.keys(submitQuestions(true))).toContain('continues')
  expect(Object.keys(midrunQuestions())).toEqual(['open', 'same_failure', 'cause_found', 'only_carrying_out', 'contradicts_plan'])
  expect(Object.keys(agentQuestions())).toEqual(['open', 'mechanical', 'unknown_cause', 'read_only'])
})
test('分档题五档，每档单独成句；是非题两边都写了情形', () => {
  expect(OPEN_LEVELS).toHaveLength(5)
  for (const q of Object.values({ ...submitQuestions(true), ...midrunQuestions(), ...agentQuestions() })) {
    if (q.type === 'noul') expect(q.criteria.true.length > 10 && q.criteria.false.length > 10).toBe(true)
    if (q.type === 'score') expect(q.criteria).toEqual([...OPEN_LEVELS])
  }
})
test('题面里反引号指到的字段都在 state 里', () => {
  const state = midrunState({ request: 'r', current: 'medium', stepsSoFar: 2, failedSteps: 1, recent: [{ did: 'a', tools: ['Read'], ok: true, result: 'x' }], latest: { did: 'b', tools: ['Bash'], ok: false, result: 'boom' }, statedNext: '', progress: null })
  const top = [...JSON.stringify(midrunQuestions()).matchAll(/`([a-z_]+)/g)].map((m) => m[1])
  for (const name of top) expect(Object.keys(state)).toContain(name)
})
test('很长的消息：state 不超预算，头尾都在（Review Focus 4）', () => {
  const long = 'HEAD ' + 'x'.repeat(200_000) + ' TAIL'
  const state = submitState({ request: long, previous: null })
  expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(STATE_BUDGET)
  expect(String(state.request).startsWith('HEAD')).toBe(true)
  expect(String(state.request).endsWith('TAIL')).toBe(true)
  expect(clip('短', 100)).toBe('短')
})
test('没有上一轮就没有 previous_turn 字段', () => {
  expect('previous_turn' in submitState({ request: 'r', previous: null })).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**（`scripts/test-one.sh dispatch-pilot questions.test.ts`）
- [ ] **Step 3: 实现 `questions.ts`（只放上面的文字和三个函数）和 `statebuild.ts`**
- [ ] **Step 4: 跑测试确认通过**（Expected: 5 pass）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: the questions in one module, and the state each decision sends`）

---

### Task 4: 后端 `ask`

**Files:**
- Create: `dispatch-pilot/hooks/backend.ts`
- Test: `dispatch-pilot/tests/backend.test.ts`

**Interfaces:**
- Consumes: `Config`（Task 1）、`Question`（Task 3）
- Produces:
  - `DREX_URL = 'https://console.nace.ai/v1/systemone'`，`JEV_URL = 'https://api.typesafe.ai/v1/systemone'`
  - `type Io = { fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>; sleep(ms: number, signal: AbortSignal): Promise<void>; now(): number }`
  - `type Answer = { type: 'noul'; noul: number } | { type: 'score'; score: number; probabilities: number[] } | { type: 'choice'; choice: string; probabilities: Record<string, number> }`
  - `type Failure = 'no-key' | 'timeout' | 'http' | 'network' | 'bad-answer' | 'model-mismatch'`
  - `type AskResult = { ok: true; answers: Record<string, Answer>; model: string; backend: 'drex' | 'jev'; ms: number } | { ok: false; reason: Failure; backend: 'drex' | 'jev'; status?: number; requestId?: string; ms: number }`
  - `ask(io: Io, cfg: Config, req: { state: unknown; questions: Record<string, Question> }, deadlineMs: number): Promise<AskResult>`

规则（设计 5.7、5.11 节）：
- 请求：`POST`，头 `authorization: Bearer <key>` 和 `content-type: application/json`，体 `{ model, state, questions }`，`model` 取 `cfg.drexModel` 或 `cfg.jevModel`。
- 回答：两家都是 `{ model, answers, usage, request_id? }`。`score` 的 `probabilities` 以档位号字符串为键，转成按下标的数组，长度必须等于那道题的档数。每道问了的题都要回来，类型要和问的一致，数值要是 0 到 1 的有限数，否则 `bad-answer`。
- Drex 回答的 `model` 不等于 `cfg.drexModel` 时是 `model-mismatch`。Jev 不做这条核对。
- 整个 `ask`（含改问另一家）不超过 `deadlineMs`，用 `io.sleep` 和请求竞速；到时返回 `timeout`。
- 选中的后端没有密钥时 `no-key`，不发请求。失败并且 `cfg.fallback` 为 true、另一家有密钥时，改问另一家一次，返回它的结果。
- 401、402、422 和别的失败一样不重试；失败结果带上回答里的 `request_id`，不带错误正文。

- [ ] **Step 1: 写失败的测试**（用手写的假 `io`，不经过引擎）

```ts
test('发给 Drex 的请求：地址、密钥头、固定版本、state 和题', …)        // url === DREX_URL，body.model === 'drex-max-v1.1'
test('score 的概率从字符串键转成数组', …)                              // {'0':0.1,'1':0.9} -> [0.1, 0.9]
test('回答缺一道题、类型不对、概率不是数，都是 bad-answer（Review Focus 2）', …)
test('Drex 回答的 model 不是固定版本：model-mismatch', …)
test('没有密钥：no-key，一个请求都不发', …)
test('到时限返回 timeout', …)                                          // 假 io 的 fetch 不返回，sleep 立即返回
test('fallback 关着时不改问；开着并且 Jev 有密钥时改问一次，结果的 backend 是 jev', …)
test('HTTP 500 是 http，带 status 和 request_id；fetch 抛错是 network', …)
```
每个测试断言 `AskResult` 的 `ok`、`reason` 或 `answers` 的确切值，以及假 `io.fetch` 被调用的次数。

- [ ] **Step 2: 跑测试确认失败**（`scripts/test-one.sh dispatch-pilot backend.test.ts`）
- [ ] **Step 3: 实现 `backend.ts`**
- [ ] **Step 4: 跑测试确认通过**（Expected: 8 pass）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: one ask() over Drex and Jev, failing open`）

---

### Task 5: 决策记录、状态行、`/dp`

**Files:**
- Create: `dispatch-pilot/hooks/log.ts`、`dispatch-pilot/tests/support/world.ts`、`dispatch-pilot/tests/dp.test.ts`
- Modify: `dispatch-pilot/hooks/dispatch-pilot.ts`、`dispatch-pilot/types/index.d.ts`

**Interfaces:**
- Produces（`log.ts`）:
  - `type Decision = { id: string; at: number; kind: 'submit' | 'midrun' | 'agent' | 'skill' | 'progress'; backend: 'drex' | 'jev' | null; model: string | null; ms: number; raw: Record<string, Answer> | null; from: string | null; to: string | null; why: string; bars: Thresholds | null; failure: Failure | null; requestId: string | null; applied: boolean; sent: Level | 'not-sent' | 'unverified' | null }`
  - `pushLog(log: readonly Decision[], d: Decision): Decision[]`（只留最后 200 条），`amendLog(log: readonly Decision[], id: string, patch: Partial<Decision>): Decision[]`（Task 11 用它补 `sent`）
  - `renderDp(v: { cfg: Config; wanted: Level | null; lastSent: Level | null; lock: Level | null; log: readonly Decision[] }): string`
  - `renderLog(log: readonly Decision[], n: number): string`，`statusLine(v: { level: Level | null; verified: boolean; last: Decision | null }): string`
- Produces（`types/index.d.ts`，一次写全，后面的任务不再改形状；类型用 `import('../hooks/levels.ts').Level` 这种写法引用）:
  - `session: { lock: Level | null; codeMode: boolean; previous: PreviousTurn | null; lastSent: Level | null; pending: { request: string; result: AskResult } | null }`
  - `turn: { turnId: string; request: string; base: Level | null; wanted: Level | null; journal: TurnJournal; midrun: MidrunCounters; pendingNote: string | null; progress: ProgressNote | null; unverified: string | null } | null`（`unverified` 是等着核对实际档位的那条 `Decision` 的 id）
  - `agents: StateFamily<{ effort: Level | null; isEffortExplicit: boolean | null; decisionId: string | null; steps: number }>`（id 是 agentId）
  - `skills: { name: string; description: string }[]`
  - `TurnJournal`、`MidrunCounters` 在 Task 7、Task 8 定义，这里先按那两处的 Produces 写。
- Produces（入口文件）: 顶层函数 `ioOf($): Io`（`fetch` 用 `$.http.fetch`，`sleep` 用 `$.clock.sleep`，`now` 用 `$.clock.now`）；顶层函数 `record($, d: Decision): Promise<void>`（把 `d` 追加进 `$.store` 的 `log`，再用 `statusLine` 更新 `$.ui.status`；之后每个任务写 `Decision` 都走它）；`session.start` 注册命令 `dp`；`command.run`（matcher `{ command: 'dp' }`）回答 `/dp`、`/dp lock <level>`、`/dp unlock`、`/dp log [n]`。
- Produces（`world.ts`，以后每个引擎测试都用）:
  - `world(on: On, o?: { answer?: (req: { url: string; body: any }) => string | null | Promise<string | null>; store?: Record<string, unknown>; agents?: unknown[]; complete?: (e: any) => string | null })`，返回 `{ fetched, statuses, stepsSent, appended, spawned, submitted, attachments, completes, storeWrites, clock }`。它注册 `http.fetch`、`ui.status`、`ui.log`、`store.get`/`store.set`、`command.register`、`agent.list`、`model.complete` 的桩，以及 `session.start`、`prompt.submit`、`turn.start`、`turn.step`、`turn.complete`、`session.append`、`agent.spawn`、`prompt.attachment`、`skill.prompt` 的底层桩；每个桩只注册一次；`mock.clock(on)` 一定调用。
  - `drexOk(answers: Record<string, unknown>, model = 'drex-max-v1.1'): string`，`score(probs: number[])`，`noul(p: number)`
  - 驱动：`start($)`、`submit($, text, origin = { kind: 'composer' })`、`turnStart($, turnId, text, agentId?)`、`step($, i: { turnId: string; index: number; effort?: unknown; model?: string; agentId?: string })`、`complete($, turnId, o?: { answer?: string; isAborted?: boolean })`
  - `KEYS = { drexApiKey: 'k-drex' }`

- [ ] **Step 1: 写失败的测试 `dp.test.ts`**

```ts
test('pushLog 只留最后 200 条', …)
test('/dp 在两个密钥都没配时写明没有可用的后端（Review Focus 1）', …)     // $.command.run({ command: 'dp', args: '' }) 的 text 含「没有可用的后端」
test('/dp lock high 之后主循环每步都是 high；/dp unlock 之后恢复', …)      // stepsSent.map(s => s.effort)
test('/dp lock 给了认不出的档位：回答说明可用的五档，不改状态', …)
test('/dp log 2 列出最近两条，含原始回答', …)                              // 先用 mock.store 预置三条
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `log.ts`、`world.ts`、入口里的 `session.start`、`command.run` 和 `turn.step`（这一步的 `turn.step` 只处理锁：`e.agentId` 为空、`e.effort` 是档位、有锁时写锁定的档）**
- [ ] **Step 4: 跑测试确认通过**（Expected: 5 pass）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: the decision log, the status line and /dp`）

---

### Task 6: 发消息时定 effort

**Files:**
- Modify: `dispatch-pilot/hooks/dispatch-pilot.ts`
- Test: `dispatch-pilot/tests/submit.test.ts`

**Interfaces:**
- Consumes: `ask`、`submitQuestions`、`submitState`、`submitLevel`、`readNoul`、`thresholdsFor`、`pushLog`、`world`
- Produces: hook `prompt.submit`、`turn.start`、`turn.complete`，以及 `turn.step` 里主循环的那一支。

流程（设计 5.3 节）：
1. `prompt.submit`：`cfg.enabled`、`cfg.submitShift` 开着，`e.origin?.kind` 是 `composer`、`sdk`、`bridge` 之一，没有锁，才判断。调 `ask`（时限 `submitTimeoutMs`），结果存进 `session.pending`，然后 `next(e)`。
2. `turn.start`（`agentId` 为空）：新建 `turn`，`request` 取 `e.text`，`pending` 留给第 0 步。
3. `turn.step`（`agentId` 为空）第 0 步：`e.effort` 是档位并且 `pending` 的结果 `ok` 时，`base` = `continues` 为 yes 且 `previous.level` 不为空时取它，否则取 `e.effort`；`wanted = submitLevel(base, …).level`；写一条 `Decision`；清掉 `pending`。失败的 `pending` 也写一条 `Decision`（`failure` 有值）。
4. 每一步：`e.effort` 是档位时写 `lock ?? wanted ?? e.effort`，`model` 原样；`mode` 是 `shadow` 时不写。
5. `turn.complete`（主循环）：`previous = { request, lastReply: e.answer 截到 300 token, ended, level: wanted ?? base }`，`turn = null`。`isAborted` 记为 `interrupted`。

- [ ] **Step 1: 写失败的测试**（都用 `test(name, { options: KEYS }, async ($, on) => …)`，除非另说）

```ts
test('人发的消息：发一个请求，之后每一步都是决定的档，模型不变', …)
// answer: drexOk({ open: score([0.02,0.08,0.25,0.55,0.1]), mechanical: noul(0.1), unknown_cause: noul(0.2) })
// submit → turnStart → step 0,1,2（effort 'medium'，model 'claude-opus-5-5'）
// expect(fetched).toHaveLength(1); expect(fetched[0].url).toBe(DREX_URL)
// expect(stepsSent.map(s => s.effort)).toEqual(['high','high','high']); 每步 model 仍是 'claude-opus-5-5'
test('task-notification、peer 开始的轮不判断', …)                          // fetched 为空
test('没有密钥：不发请求，effort 不变（Review Focus 1）', { options: {} }, …)
test('回答缺题：effort 不变，记录里 failure 是 bad-answer（Review Focus 2）', …)
test('e.effort 缺省或是数字：原样放行（Review Focus 3）', …)               // step 不带 effort，再带 effort: 31999
test('到时限放行', …)                                                      // 桩里 await clock.sleep(60_000)；clock.advance(4000)
test('shadow：发请求、记一条，但 effort 不变', { options: { ...KEYS, mode: 'shadow' } }, …)
test('续做：上一轮定在 xhigh，这一条 continues 为是，从 xhigh 起算', …)    // 第二轮的请求里有 previous_turn 和 continues 题
test('一轮被打断后，下一轮不带着上一轮的档位', …)                          // complete(..., { isAborted: true }) 后新一轮从会话的档起算
```

- [ ] **Step 2: 跑测试确认失败**（`scripts/test-one.sh dispatch-pilot submit.test.ts`）
- [ ] **Step 3: 在入口里实现四个 hook**
- [ ] **Step 4: 跑测试确认通过**（Expected: 9 pass；再跑 `command claude plugin test ./dispatch-pilot` 全绿）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: the effort of a turn is set when the message is sent`）

---

### Task 7: 从行里读出一轮的依据

**Files:**
- Create: `dispatch-pilot/hooks/journal.ts`、`dispatch-pilot/tests/support/rows.ts`
- Test: `dispatch-pilot/tests/journal.test.ts`

**Interfaces:**
- Consumes: `StepRecord`、`clip`（Task 3）
- Produces（`journal.ts`）:
  - `type Row = { door: string; tool: string | null; role: 'user' | 'assistant' | null; type: string; agentId: string | null; text: string; isError: boolean; toolUses: { name: string; description: string }[] }`
  - `rowOf(e: { door: string; origin: { kind: string; tool?: string }; agentId?: string; message: { type: string; role?: string; content: readonly any[] } }): Row`
  - `type RowKind = 'receipt' | 'script-result-poll' | 'script-result-delivery' | 'inner-call' | 'tool-result' | 'new-input' | 'assistant' | 'other'`
  - `kindOf(row: Row): RowKind`
  - `scriptResult(text: string): { ok: boolean; result: string } | null`
  - `type TurnJournal = { steps: StepRecord[]; workSteps: number; failedSteps: number; scriptResults: number; statedNext: string; open: { did: string; tools: string[] } | null; lastError: string | null; editedSinceError: boolean; sameErrorRepeated: boolean; consecutiveFailures: number }`
  - `emptyJournal(): TurnJournal`，`applyRow(j: TurnJournal, row: Row, kind: RowKind): TurnJournal`（返回新对象；`steps` 只留最后 6 条）
- Produces（`rows.ts`，按 E7、E13 实测的形状造行）: `replReceipt(n)`、`pollResult(n, result, o?: { error?: boolean })`、`deliveryResult(n, result)`、`emptyDelivery()`、`innerCall(tool, o?: { error?: string })`、`toolResult(tool, text, o?: { error?: boolean })`、`assistantText(text)`、`assistantToolUse(name, input)`、`promptRow(text)`

认行的规则（设计 3.2 节 E7、E13，都只看主循环的行，`agentId` 不为空的不管）：
- `receipt`：`door` 是 `tool-result`，`role` 是 `user`，`origin.tool` 是 `REPL`，结果文字匹配 `/^\(dispatched #\d+\)$/`。
- `script-result-poll`：`door` 是 `tool-result`，`role` 是 `user`，`origin.tool` 是 `Poll`，文字里有 `kind="repl-eval"`。
- `script-result-delivery`：`door` 是 `delivery`，`role` 是 `user`，文字里有 `kind="repl-eval"`。
- `inner-call`：`door` 是 `tool-result`，`role` 缺省（Code Mode 脚本内部的调用）。
- `tool-result`：`door` 是 `tool-result`，`role` 是 `user`，工具不是 `REPL`、`Poll`。
- `new-input`：一轮开始之后的 `door` 为 `prompt` 的行，或不带 `repl-eval` 的非空 `delivery` 行。
- `assistant`：`door` 是 `response`。文字块更新 `statedNext`（截到 200 token）；`tool_use` 块记进 `open`，`REPL` 的 `did` 取它输入里的 `description`，别的工具取工具名。
- `queue` 行和别的都是 `other`。
- `scriptResult`：从事件文字里取 `<result>…</result>` 或 `<error>…</error>` 的内容，后者 `ok` 为 false。
- 一步结束（`script-result-*` 或 `tool-result`）时把 `open` 加上结果写成一条 `StepRecord`，`workSteps` 加一；`inner-call` 只把工具名并进 `open.tools`，出错时这一步记为失败。只等结果的 `Poll`（它之前没有 `receipt`）不算工作步。
- `consecutiveFailures`：一步失败加一，成功清零。
- `lastError` 取报错文字的第一行；之后有过 `Edit`、`Write`、`NotebookEdit` 或一次新的 `REPL` 时 `editedSinceError` 为 true；同一个 `lastError` 在 `editedSinceError` 为 true 时再次出现，`sameErrorRepeated` 为 true。

- [ ] **Step 1: 写失败的测试**

```ts
test('认出七种行', …)            // 对 rows.ts 造的每种行，kindOf(rowOf(e)) 等于期望的种类；queue 行是 other
test('Code Mode 的一步：回执不算结果，Poll 结果行结束这一步', …)
// assistantToolUse('REPL', { description: 'run the tests' }) → replReceipt(1) → innerCall('Bash') → pollResult(1, '3 failed')
// 之后 j.steps 末条是 { did: 'run the tests', tools: ['REPL','Bash'], ok: true, result: '3 failed' }，j.workSteps === 1，j.scriptResults === 1
test('结果经 delivery 行到达也结束这一步；空的 delivery 行不算', …)
test('脚本报错：ok 为 false，failedSteps 加一', …)                         // pollResult(2, 'TypeError: x', { error: true })
test('同一条报错在一次修改之后再出现：sameErrorRepeated', …)
test('只等结果的 Poll 不算工作步', …)
test('agent 的行不进主循环的记录', …)
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `rows.ts` 和 `journal.ts`**
- [ ] **Step 4: 跑测试确认通过**（Expected: 7 pass）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: a turn's evidence is read from its rows`）

---

### Task 8: 一轮中途换 effort

**Files:**
- Create: `dispatch-pilot/hooks/midrun.ts`
- Modify: `dispatch-pilot/hooks/dispatch-pilot.ts`
- Test: `dispatch-pilot/tests/midrun.test.ts`

**Interfaces:**
- Consumes: Task 2、3、4、7 的产出
- Produces（`midrun.ts`）:
  - `type MidrunCounters = { notes: number; lastShiftAt: number; stepsSinceCheck: number; scriptsSinceCheck: number }`，`emptyCounters(): MidrunCounters`
  - `isCheckpoint(kind: RowKind, j: TurnJournal, m: MidrunCounters, cfg: Config, codeMode: boolean): boolean`
  - `mayShift(m: MidrunCounters, j: TurnJournal, cfg: Config): boolean`（`m.notes < cfg.midrunMaxNotes` 并且 `j.workSteps - m.lastShiftAt >= 3`，第一次换挡不受间隔限制）
  - `carriesNote(kind: RowKind): boolean`（`script-result-poll`、`receipt`、`tool-result` 为 true）
  - `noteText(to: Level, why: string): string`，返回 `[dispatch-pilot] effort is now <to>: <why>.`
  - `withNote<E extends { message: { content: readonly unknown[] } }>(e: E, text: string): E`（在 `content` 末尾加 `{ type: 'text', text }`）
- Produces（入口）: hook `session.append`。

检查点（设计 5.4 节）：
- Code Mode（见过 `receipt` 行就是）：`script-result-poll` 或 `script-result-delivery`，并且 `cfg.midrunEveryScripts > 0`、`scriptsSinceCheck + 1 >= cfg.midrunEveryScripts`。
- 普通会话：`tool-result`，并且 `j.sameErrorRepeated` 或 `j.consecutiveFailures >= 2`，或 `cfg.midrunEverySteps > 0` 且 `stepsSinceCheck + 1 >= cfg.midrunEverySteps`。
- 两种会话：`new-input`。
- 到了检查点就把 `stepsSinceCheck`、`scriptsSinceCheck` 清零，没到就各加一（工作步、脚本结果）。

`session.append` 的流程（主循环的行，`cfg.midrunShift` 开、没有锁、`turn.wanted ?? turn.base` 不为空时）：
1. `applyRow` 更新 `turn.journal`。
2. 有 `turn.pendingNote` 并且这一行 `carriesNote`：把它加到这一行上，清掉，`next`。
3. 是检查点：调 `ask`（`midrunQuestions`、`midrunState`，时限 `midrunTimeoutMs`），`midrunLevel` 得出新档，写一条 `Decision`。
4. 新档和当前不同、`mayShift`、`mode` 是 `apply` 时：`turn.wanted` 设为新档，`notes` 加一，`lastShiftAt = workSteps`。这一行 `carriesNote` 就把说明加在这一行；是 `new-input` 就不加说明；是 `script-result-delivery` 就存进 `turn.pendingNote`。
5. 总是 `next`（改过的或原样的行）。

- [ ] **Step 1: 写失败的测试**

```ts
test('Code Mode：Poll 结果行到达时判断，说明加在这一行，下一步是新档', …)
// 回答 same_failure 0.9；submit 定在 medium → step 0 → REPL 的 tool_use、replReceipt(1)、pollResult(1,'…')
// appended 里最后一条 Poll 行的 content 末块是 { type:'text', text:'[dispatch-pilot] effort is now high: the same failure came back after a fix.' }
// 回执行的 content 没有被改；下一步 stepsSent 末条 effort === 'high'
test('结果经 delivery 行到达：这一行不改，说明加在下一条回执行上', …)
test('回答落在中间带：不加说明，档位不变', …)
test('midrunEveryScripts 为 2：第一次脚本结果不发请求，第二次才发', { options: { ...KEYS, midrunEveryScripts: 2 } }, …)
test('一轮最多 4 条说明；两次换挡之间不足 3 个工作步时不换', …)
test('中途最高到 xhigh', …)
test('普通会话：同一步的两条并行结果行，只在一条上加说明（Review Focus 5）', …)
test('普通会话：连续两步失败是检查点；单独一次失败不是', …)
test('新输入的行：换挡但不加说明', …)
test('时限到了：行原样放行', …)
test('锁定、shadow、midrunShift 关着：都不加说明', …)
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `midrun.ts` 和入口里的 `session.append`**
- [ ] **Step 4: 跑测试确认通过**（Expected: 11 pass；全套测试全绿）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: mid-run shifts are judged when a result arrives and carried by a note on its row`）

---

### Task 9: 派出 agent 时定模型和 effort

**Files:**
- Modify: `dispatch-pilot/hooks/dispatch-pilot.ts`
- Test: `dispatch-pilot/tests/agents.test.ts`

**Interfaces:**
- Consumes: `agentPlan`、`agentQuestions`、`agentState`、`ask`、`tierOfModelId`
- Produces: hook `agent.spawn`，以及 `turn.step` 里 `agentId` 不为空的那一支。

流程（设计 5.5 节）：
1. `e.resume` 有值、`e.fork` 为真、`e.workflow` 有值：原样 `next(e)`，什么都不做。
2. 继承：`tier = tierOfModelId(e.parentModel)`，`level` = 主循环的 `turn.wanted ?? turn.base`。
3. `cfg.agentShift` 开、没有锁时调 `ask`（时限 `agentTimeoutMs`）。失败、超时或没问时这个 agent 不处理（设计 5.5 节：原样放行，之后也不再改），只执行下一条里 `fableAgents` 的上限。
4. `agentPlan` 得出模型和 effort。`e.model` 已有值时模型不改；否则 `agentPlan` 给的层级和继承的不同就 `next({ ...e, model: <层级的别名> })`。`fableAgents` 关着、继承是 `fable`、`e.model` 为空时，即使 `ask` 失败也改成 `opus`。`mode` 是 `shadow` 时不改。
5. `next` 返回的 `agentId` 有值时写 `agents[agentId] = { effort, isEffortExplicit: null, decisionId, steps: 0 }`（没处理的 agent `effort` 为 null），再写一条 `Decision`。
6. `turn.step`（agent）：`agents[e.agentId]` 有 `effort`、`e.effort` 是档位时写它。第一次遇到这个 agent 时调一次 `$.agent.list()`，它那一项的 `effort` 有值就把 `isEffortExplicit` 记为 true，之后不写。

- [ ] **Step 1: 写失败的测试**（`spawnInput(o)` 写全 `AgentSpawnInput` 的必填字段，默认 `parentModel: 'claude-opus-5-5'`）

```ts
test('派出时发一个请求，state.task 是任务原文；只读又机械的任务用 haiku，之后每步写定下的 effort', …)
test('fork、续跑、workflow 的 agent：不发请求，模型不动', …)
test('派出时明写了模型：模型不改，仍然定 effort', …)
test('主 agent 是 Fable、fableAgents 关着：没写模型的 agent 是 opus，后端失败时也是', …)   // http 桩返回 null
test('fableAgents 开着：继承 fable 不改', { options: { ...KEYS, fableAgents: true } }, …)
test('明写了 fable 的 agent 不受开关影响', …)
test('同时派出两个 agent：各按各的回答定，互不串（Review Focus 5）', …)       // answer 按 body.state.task 分别回答；Promise.all 两次 spawn
test('时限到了：原样放行，这个 agent 之后每步的 effort 也不写', …)
test('agent 明写了 effort（agent.list 里有值）：不写 effort', …)
test('agent 的第一步比 agent.spawn 的结果先到：这一步原样放行，下一步起写定下的 effort', …)
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现两个 hook**
- [ ] **Step 4: 跑测试确认通过**（Expected: 10 pass；全套测试全绿）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: a dispatched agent's model and effort are decided at agent.spawn`）

---

### Task 10: skill 列表、推荐和 find-skill

**Files:**
- Create: `dispatch-pilot/hooks/skills.ts`、`dispatch-pilot/skills/find-skill/SKILL.md`
- Modify: `dispatch-pilot/hooks/dispatch-pilot.ts`
- Test: `dispatch-pilot/tests/skills.test.ts`

**Interfaces:**
- Consumes: `ask`、`Question`、`Answer`、`submitQuestions`、`submitState`、`world`
- Produces（`skills.ts`）:
  - `type Skill = { name: string; description: string }`
  - `parseListing(text: string): Skill[]`：每个 skill 一行 `- <name>: <description>`，名字到第一个「冒号加空格」为止（名字里可以有不带空格的冒号，如 `superpowers:brainstorming`）；不以 `- ` 开头的后续行并进上一条的说明；别的行忽略。
  - `LISTING_NOTE`（固定文字，见下）
  - `ACTION_BAR = 0.30`、`NAMED_BAR = 0.50`、`FITS_BAR = 0.30`、`SHORTLIST = 3`、`BATCH = 250`
  - `stageOne(skills: Skill[], backend: 'drex' | 'jev', withGate: boolean): Record<string, Question>`
  - `wantsSkill(a: { acts?: number; procedure?: number; prose?: number; named?: number }): boolean`
  - `shortlist(skills: Skill[], answers: Record<string, Answer>): Skill[]`
  - `stageTwo(short: Skill[], backend: 'drex' | 'jev'): Record<string, Question>`
  - `pick(short: Skill[], answers: Record<string, Answer>): Skill | null`，`pickMany(short: Skill[], answers: Record<string, Answer>): Skill[]`
  - `suggestionBlock(s: Skill): string`，`findSkillReply(query: string, found: Skill[], failure: Failure | null): string`

题和读法照 TypeSafe 的 skill_suggestion cookbook（设计 3.4、5.6 节），原话一字不改：

| 键 | 类型 | `instructions` |
|---|---|---|
| `skill_<批号>` | choice，选项键是 skill 名，值是它在列表里的说明 | Which of these skills, if any, is the right one to load to help with the user's latest request? |
| `acts_on_user_system` | noul | Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise? |
| `would_follow_documented_procedure` | noul | Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding? |
| `prose_suffices` | noul | Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts? |
| `named` | noul | Does the request ask for a specific named tool, format, template, or method to be used, rather than for general help? |
| `which`（第二次） | choice，选项是前三名 | Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name. |
| `fits_<i>`（第二次） | noul | Does the skill '<name>' do the specific thing the user's request asks for? It is described as: <description> |

- 这四道 noul 的 `criteria` 用 `{ true: 'Yes.', false: 'No.' }`（cookbook 不给情形）。
- 候选按名字前缀（第一个冒号之前的部分，即来源）排序，每 `BATCH` 个一道选择题。Drex 的每道选择题多一个选项 `other: null`；Jev 不加。
- `wantsSkill`：`(acts + procedure + (1 - prose)) / 3 >= ACTION_BAR`，或 `named >= NAMED_BAR`。三道里缺一道时前一个条件不成立。
- `shortlist`：各批选择题的概率合在一起，去掉 `other`，取最高的 `SHORTLIST` 个。
- `pick`：`fits_*` 最高的低于 `FITS_BAR` 返回 null；否则返回 `which` 选中的那个；选中 `other` 返回 null。
- `pickMany`（find-skill 用）：`fits` 不低于 `FITS_BAR` 的，从高到低，最多三个。
- 和 cookbook 不同的一处：cookbook 第二次请求的选项是「说明加 SKILL.md 正文前 700 个字符」；mod 拿不到 skill 文件的路径（`CommandInfo` 没有路径），所以只用说明。这一条写进 DEVELOPMENT.md。

```ts
export const LISTING_NOTE =
  "Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it. For any other skill, load the skill dispatch-pilot:find-skill with the Skill tool, with a few words on the work as its args: it answers with the skills that fit. Then load one of them with the Skill tool by its exact name."
```

`skills/find-skill/SKILL.md`：frontmatter `name: find-skill`，`description: Searches this session's skills for the ones that fit a piece of work, and answers with each one's exact name and what it is for. Load it with the work as its args, a few words such as "fill in a form in a PDF file". Use it when the work at hand might have a skill you have not been shown.`；正文一行 `Query: $ARGUMENTS`。

入口里的三处：
1. `prompt.attachment`（matcher `{ type: 'skill_listing' }`）：先 `next(e)`。`e.agentId` 有值、`cfg.skills` 关着、没有可用的后端、`mode` 是 `shadow`、结果的 `text` 是 null、或解析出 0 个 skill 时，原样返回。否则把解析结果存进 `skills`，返回 `{ text: LISTING_NOTE }`。
2. `prompt.submit`：`cfg.skills` 开着并且 `skills` 不为空时，把 `stageOne(skills, backend, true)` 并进 Task 6 的那一次请求（`submitShift` 关着时只问这些题）。`wantsSkill` 成立时发第二次请求 `stageTwo(shortlist(…))`，state 同第一次；两次请求合用 `submitTimeoutMs`，第一次回来后剩下不足 500 ms 就不发第二次。`pick` 有结果时 `next({ ...e, context: [...(e.context ?? []), suggestionBlock(s)] })`。写一条 `kind: 'skill'` 的 `Decision`。
3. `skill.prompt`（matcher `{ skill: /(^|:)find-skill$/ }`，并且 `e.pluginName === 'dispatch-pilot'`）：查询词取 `e.text` 里 `Query: ` 之后的部分；`stageOne(skills, backend, false)`，再 `stageTwo`，返回 `{ text: findSkillReply(query, pickMany(…), null) }`。请求失败时返回 `findSkillReply(query, [], reason)`，写明没查成。

- [ ] **Step 1: 写失败的测试**

```ts
test('parseListing：带冒号的名字、跨行的说明、标题行不算', …)
test('主循环的列表换成 LISTING_NOTE，候选存下；agent 的列表不动', …)        // $.prompt.attachment({ type:'skill_listing', … , agentId? })
test('没有密钥、skills 关着、shadow：列表原样', …)
test('发消息：一次请求里既有 effort 题也有 skill_0 和四道门控题', …)       // Object.keys(fetched[0].body.questions)
test('动作题平均低于 0.30 且点名题低于 0.50：不发第二次请求，context 不变', …)
test('动作题过了：第二次请求有 which 和三道 fits；fits 够高时 context 多一段，写着选中的 skill 名', …)
test('只有点名题过了 0.50 也发第二次请求', …)
test('fits 最高的低于 0.30：不推荐', …)
test('Drex 的选择题有 other，Jev 没有；选中 other 不推荐', …)
test('超过 250 个候选：分成 skill_0 和 skill_1 两道', …)
test('第二次请求赶不上时限：不推荐，effort 的决定照常生效', …)
test('find-skill：不问门控题，回答里最多三个 skill 名；后端失败时写明没查成', …)   // $.skill.prompt({ skill:'dispatch-pilot:find-skill', text:'Query: pdf form', pluginName:'dispatch-pilot', … })
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `skills.ts`、SKILL.md 和入口里的三处**
- [ ] **Step 4: 跑测试确认通过**（Expected: 12 pass；全套测试全绿；`command claude plugin validate ./dispatch-pilot --strict` 通过）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: the skill listing is folded, one skill is suggested with a message, find-skill answers the rest`）

---

### Task 11: 实际发出的档位

**Files:**
- Create: `dispatch-pilot/hooks/readout.ts`
- Modify: `dispatch-pilot/hooks/dispatch-pilot.ts`、`dispatch-pilot/hooks/log.ts`
- Test: `dispatch-pilot/tests/readout.test.ts`

**Interfaces:**
- Produces（`readout.ts`）:
  - `type OpenStep = { turnId: string; index: number; model: string; matched: boolean }`
  - `classify(i: { originPlugin: string | undefined; url: string; body: unknown; open: OpenStep | null; agentStepsOpen: number }): { kind: 'main'; effort: Level | null } | { kind: 'unsure' } | { kind: 'ignore' }`
- Produces（入口）: hook `http.fetch`（只在 `cfg.verifyEffort` 为 true 时注册）；模块级变量 `openMain: OpenStep | null` 和 `agentStepsOpen: number`（注释写明：热重载丢了的代价是那一步记为未核对）。

`classify` 的规则（设计 5.12 节和第 9 节）：
- `ignore`：`originPlugin` 不是 `engine`；或 URL 的路径不以 `/v1/messages` 结尾；或 `body` 不是字符串、不是 JSON 对象；或请求体没有 `thread` 字段（旁路请求，进展记录的调用也在这里被排除）。
- `unsure`：没有开着的主循环步、这一步已经配过一次请求、请求体的 `model` 和这一步的不同，或同时有 agent 的步开着并且用同一个模型。
- `main`：其余。`effort` 取顶层 `output_config.effort`，不是五档之一时为 null。请求体用 `JSON.parse` 读一次，不保留、不记录、不外发；只把档位这一个词交出去。

入口：
- `turn.step` 在调 `next` 之前登记 `openMain`（或 `agentStepsOpen` 加一），结束后清掉。
- `http.fetch`：`classify` 之后总是 `return next(e)`，`e` 原样。`main` 时写 `session.lastSent`；这一轮有一条还没核对的换挡 `Decision` 时，把它的 `sent` 写成这个档位，和它的 `to` 不同就写 `'not-sent'`。`unsure` 时把那条写成 `'unverified'`。整个主体包在兜底里。
- agent：在它的第二步开始时（只有一步的在它的 `turn.complete`）调一次 `$.agent.list()`，把它的 `lastRequest.effort` 写进那条 agent `Decision` 的 `sent`；读不到写 `'unverified'`。
- `statusLine` 和 `renderDp` 的当前档位取 `session.lastSent`；为空时显示 mod 要的档位并标「未核对」。

- [ ] **Step 1: 写失败的测试**

```ts
test('classify：主循环的请求读出顶层的档位', …)                        // body: JSON.stringify({ model:'claude-opus-5-5', thread:{}, output_config:{ effort:'high' }, messages:[…] })
test('classify：没有 thread 的旁路请求、别的插件发的请求、别的地址：ignore', …)
test('classify：只有消息里带 output_config、顶层没有：effort 为 null', …)
test('classify：请求体不是文本或不是 JSON：ignore，不抛错', …)
test('classify：同模型的 agent 步同时开着，或这一步已经配过请求：unsure', …)
test('请求原样放行：桩收到的 url 和 init 与发出的相同', …)
test('换挡之后的那条决策记录带上实际发出的档位；不一致时是 not-sent', …)
test('verifyEffort 关着：记录里 sent 为 null，/dp 标未核对', { options: { ...KEYS, verifyEffort: false } }, …)
```
测试里的 `$.http.fetch` 到 mod 的 hook 时 `next.origin.plugin` 是什么，先用一条断言确认；不是 `engine` 的话，第 7 条改为直接调入口里处理读数的顶层函数，并把这一点记进 DEVELOPMENT.md。

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `readout.ts` 和入口、`log.ts` 里的改动**
- [ ] **Step 4: 跑测试确认通过**（Expected: 8 pass；全套测试全绿）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: the level each request actually carried is read at http.fetch and kept with the decision`）

---

### Task 12: 进展记录（开关，默认关）

**Files:**
- Create: `dispatch-pilot/hooks/progress.ts`
- Modify: `dispatch-pilot/hooks/dispatch-pilot.ts`
- Test: `dispatch-pilot/tests/progress.test.ts`

**Interfaces:**
- Consumes: `ProgressNote`、`StepRecord`、`clip`（Task 3），`midrunState` 的 `progress` 字段
- Produces（`progress.ts`）:
  - `progressPrompt(i: { request: string; previous: ProgressNote | null; latest: StepRecord }): { system: string; prompt: string }`
  - `parseProgress(text: string): ProgressNote | null`（取文字里第一个 JSON 对象；`done`、`remaining` 是字符串，`cause_known` 是布尔，缺一个就是 null；两个字符串各截到 60 token）
- Produces（入口）: 模块级变量 `progressFlight: { settled: boolean; note: ProgressNote | null; refused: boolean } | null`、`progressQueued`、`progressBlocked`（注释：热重载丢了的代价是少一份记录）。

固定的文字：

```ts
const SYSTEM = 'You keep a short progress note on a coding task. Reply with one JSON object and nothing else: {"done": string, "remaining": string, "cause_known": boolean}. "done" and "remaining" are one sentence each. Report only what the results show.'
```
`prompt` 是一个 JSON 字符串：`{ request, previous_note, latest_step: { did, tools, outcome, result } }`，`request` 截到 400 token，`result` 截到 400 token。

流程（设计 5.13 节）：
- 每个中途检查点判断完之后，`cfg.progressNote` 开着且没有 `progressBlocked` 时：没有在途的就发起一次 `$.model.complete({ model: cfg.progressNoteModel, system, prompt, effort: 'low', maxTokens: 200, timeoutMs: 8000 })`，不等它；它的 `.then` 只往 `progressFlight` 里写结果，不碰 `$`。有在途的就把这次的输入放进 `progressQueued`（只留最新的一份）。
- 之后每一条主循环的行到来时：`progressFlight.settled` 的话，有 `note` 就写进 `turn.progress`，没有就保留旧的并记一条 `kind: 'progress'` 的 `Decision`；然后发起排着的那一次。
- `isAnswered` 为 false、`reason` 是 `api-error` 且 `status` 是 400、403 或 404 时 `progressBlocked = true`，这个会话不再调。
- `turn.start` 清掉 `turn.progress` 和排着的输入；在途的那一次回来后丢弃（用 `turnId` 对不上来判断）。

- [ ] **Step 1: 写失败的测试**

```ts
test('parseProgress：纯 JSON、前后带话的 JSON、缺字段、过长的字符串', …)
test('开着时：第一个检查点的请求里没有 progress；记录写好后，下一个检查点的 state.progress 有三个字段', { options: { ...KEYS, progressNote: true } }, …)
// completes[0] 的 model 是 'haiku'，effort 是 'low'
test('hook 不等记录写完：model.complete 的桩还挂着时，这一行已经返回', …)     // 桩里 await clock.sleep(60_000)
test('上一次还在途时不并发：第二个检查点不发新的调用，在途的回来后才发', …)
test('回答不是三个字段：保留旧记录，记一条 progress 的失败', …)
test('模型被拒绝（api-error 403）：这个会话不再调', …)
test('默认关：一次 model.complete 都没有', …)
test('新的一轮开始时记录清空', …)
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `progress.ts` 和入口里的改动**
- [ ] **Step 4: 跑测试确认通过**（Expected: 8 pass；全套测试全绿；`scripts/check.sh` 全 `ok`）
- [ ] **Step 5: Commit**（`dispatch-pilot 1.0.0: an optional progress note, written in the background and read at the next checkpoint`）

---

### Task 13: 文档和仓库里的其余改动

**Files:**
- Create: `dispatch-pilot/README.md`、`dispatch-pilot/DEVELOPMENT.md`、`docs/adr/0029-dispatch-pilot-rewrite-for-code-mode.md`
- Modify: `CLAUDE.md`、`GLOSSARY.md`、`README.md`、`.claude-plugin/marketplace.json`、`scripts/check.sh`（注释里提到 extras 的那一句）
- Delete: `docs/research/board-scenes/`（它只驱动已经去掉的看板）

内容：
- `dispatch-pilot/README.md`（写给使用者）：做什么（三项换挡、skill 一组功能）；要求 Claude Code 2.1.327；安装；配置表（Task 1 的那张，加一列说明）；Code Mode 会话里的行为（每次脚本结果判断一次、说明行长什么样）；发出去的内容（发给 Nace 或 TypeSafe 的 state 有哪些字段；`progressNote` 开着时另有发给会话自己模型的调用；不开 OpenTelemetry）；`/dp` 的用法；门槛是初值、尚未校准；测试时的 Claude Code 版本。
- `dispatch-pilot/DEVELOPMENT.md`：文件划分（本计划的「文件结构」）；测试怎么写（`tests/support/world.ts` 和 `rows.ts` 的用法）；设计 3.2 节 E1 到 E18 的表原样搬来；和 cookbook 不同的那一处（Task 10）；实机验证的结果留给 Task 14 填。
- ADR 0029：这次重写做了什么决定、取代 ADR 0028（两个 plugin）以及看板、看图核对、失败升档这些旧决定的哪几条；旧 ADR 不改。
- `CLAUDE.md`：Code Mode 那一条改成 2.1.327 的事实（挂这些事件不再挡 Code Mode；dispatch-pilot 仍然不挂 `tool.call` 一类事件，理由是不给脚本内部的调用加等待；`eval/validate.ts` 检查）；删掉 extras 和 ADR 0028 的说法、`board-scenes` 那条命令；热重载那一条里的例子换成现在的模块级变量（读数的 `openMain`、进展记录的在途调用）；加一条「任何会话、任何测试都不打开 OpenTelemetry」。
- `GLOSSARY.md`：去掉只属于旧实现的词条，加上「检查点」「说明行」「分档题」「条件题」「进展记录」「实际档位」。
- 根 `README.md`：去掉安装 extras 的那一行，更新 dispatch-pilot 的一句介绍。`marketplace.json` 的说明同步。

- [ ] **Step 1: 写上面这些文件**
- [ ] **Step 2: 检查**

```bash
grep -rn "dispatch-pilot-extras\|board-scenes" --include="*.md" --include="*.json" --include="*.sh" . | grep -v "^./docs/adr/00[012]" | grep -v "^./docs/superpowers/" | grep -v "^./docs/research/"
scripts/check.sh
```
Expected: 第一条没有输出；`check.sh` 全 `ok`。

- [ ] **Step 3: Commit**（`dispatch-pilot 1.0.0: README, development notes, ADR 0029; the repo's docs follow the single plugin`）

---

### Task 14: 两种会话里的实机验证

**Files:**
- Modify: `dispatch-pilot/DEVELOPMENT.md`（「实机验证」一节）；验证中发现的问题按「先写失败的测试、再改」修在对应的文件里

实机会话只能是 tmux 里的交互会话（Code Mode 在 `claude -p` 下不生效）。全程不设任何 OpenTelemetry 的环境变量。

- [ ] **Step 1: 先问用户，得到同意再往下做。** 说明四点：这一步会向 Nace 的 Drex 发真实请求，估计 150 次以内；发出去的是专为这次验证写的提示词和一个临时小项目里的工具结果，不含用户的真实项目内容；用的是用户自己在 plugin 配置里填的密钥，我不读也不打印它；另外会用掉几轮主模型的用量。

- [ ] **Step 2: 准备临时项目和启动命令**

临时项目放在 scratchpad 下的新目录：`src/a.js`，和一个 `check.sh`，前三次运行都打印同一行 `AssertionError: expected 3 to equal 4` 并以 1 退出（用一个计数文件），第四次起通过。

```bash
S='{"enabledPlugins":{"dispatch-pilot@alex-mods":false,"dispatch-pilot-extras@alex-mods":false}}'
# 普通会话
tmux new-session -d -s dpv -x 180 -y 50 -c "$SCRATCH/proj" "env -u CLAUDE_CODE_ENABLE_TELEMETRY command claude --plugin-dir $WT/dispatch-pilot --settings '$S' --debug-file $SCRATCH/dpv.log"
# Code Mode 会话：同一条命令，env 里加 CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1
```
启动后先 `/dp`，确认后端可用；显示没有可用的后端时，请用户在 `/plugin` 里给这个 mod 填密钥。

- [ ] **Step 3: 普通会话跑四个场景，每个场景之后 `/dp log 3` 截屏（`tmux capture-pane -p`）**

| 场景 | 发什么 | 看什么 |
|---|---|---|
| 发消息定档 | 一条机械的小改动；再一条原因不明的偶发故障 | 两条 `submit` 记录的 `to` 不同；每条的 `sent` 等于 `to` |
| 中途换挡 | 「运行 ./check.sh，失败就改 src/a.js 再运行，直到通过」 | 某条结果行后面出现 `[dispatch-pilot] effort is now …`；对应的 `midrun` 记录 `sent` 等于新档；一轮里说明不超过 4 条 |
| agent | 「派一个 agent 数一下这个目录有几个文件」 | `agent` 记录里有模型和 effort，`sent` 来自 `lastRequest` |
| skill | 问「你现在看得到哪些 skill」；发一条明显对应某个已装 skill 的请求；让它加载 `dispatch-pilot:find-skill` 查一个词 | 模型只说得出 `LISTING_NOTE` 的内容；`skill` 记录里有推荐；find-skill 回答了 skill 名 |

- [ ] **Step 4: Code Mode 会话重跑这四个场景**，另外确认：debug log 里没有因为这个 mod 而拒绝 Code Mode 的字样；脚本结果经 `Poll` 行到达时说明加在那一行上。

- [ ] **Step 5: 补测设计第 9 节留下的几条**，结果写进 DEVELOPMENT.md：
  - 一轮中途用户插话那一步改的档位发没发出（看那条记录的 `sent`）。
  - `skill.prompt` 在两种会话里是否触发、`e.skill` 的确切值（和 Task 10 的 matcher 对不上就改 matcher 并补测试）。
  - 说明行在终端里显示成什么样。
  - `http.fetch` hook 每次请求多花的时间（临时在 debug log 里记毫秒数，量完删掉）；超过 20 ms 就换成不整体解析的取法并补测试。
  - `progressNote` 打开后 Haiku 的调用是否成功（`effort: 'low'` 被拒绝的话去掉这个参数并补测试）。

- [ ] **Step 6: 收尾**

```bash
tmux kill-session -t dpv; pgrep -fl "claude.*dispatch-pilot" ; pgrep -fl tmux
scripts/check.sh
```
Expected: 两条 `pgrep` 没有这次起的进程；`check.sh` 全 `ok`。

- [ ] **Step 7: Commit**（`dispatch-pilot 1.0.0: verified live in an ordinary session and a Code Mode session`）

---

## 这份计划之后

校准（设计第 8 节）另写一份计划：用例和参考答案由 Fable 5.2 在 xhigh 档做、每类 15 例、只测 Drex `drex-max-v1.1`；三组对照（问法、上下文、进展记录）；定门槛；按任务结果验收中途换挡；然后发布 1.0.0。中途换挡的效果验收不通过时停下来告诉用户，不自行改成别的做法。
