# dispatch-pilot 校准 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Drex `drex-max-v1.1` 上用 60 个有参考答案的用例校准 dispatch-pilot 的题、上下文和门槛，并在真实任务上验收中途换挡，产出一份校准记录，供用户决定发布。

**Architecture:** 校准工具放在 `dispatch-pilot/eval/`，用 `node` 直接跑 TypeScript，请求由 mod 自己的纯函数（`hooks/statebuild.ts`、`hooks/questions.ts`、`hooks/skills.ts`、`hooks/backend.ts`）构造，所以用例存下的就是 mod 实际会发的请求。回答原样存在仓库外的私有目录里，判分和扫门槛都离线做。用例和参考答案由 Fable 5.2（xhigh）的 agent 出，调整只在调整集上做，留出集最后算一次。

**Tech Stack:** TypeScript（Node 26 直接执行，不构建）、`claude-code/testing`（纯函数的测试）、Drex System One 接口、tmux（验收用的交互会话）。

**Spec:** `docs/superpowers/specs/2026-11-17-dispatch-pilot-rewrite-design.md` 第 8 节（校准）和它引用的 3.4、4.3、5.2 到 5.6、5.13 节。

## Global Constraints

- 分支 `dp/rewrite`，只在 worktree `/Users/alexnear/Documents/claude-mods/.claude/worktrees/dp-rewrite` 里改；Claude Code `>=2.1.327`（本机 2.1.328）。
- 只校准 Drex `drex-max-v1.1`；Jev 不参加任何测试，不向 TypeSafe 发任何请求。
- 出题、给参考答案、设计验收任务的 agent 一律明写模型 `fable` 和 effort `xhigh`。派出前确认 `~/.claude/settings.json` 里 `dispatch-pilot@alex-mods` 和 `dispatch-pilot-extras@alex-mods` 是 `false`。
- 每类 15 例，四类共 60 例：6 例 `fit`（用来改）、4 例 `check`（每次改动后复查）、5 例 `heldout`（留出）。边界例和反例合计每类不少于 5 例，其中留出集里不少于 2 例。分组在看到任何回答之前定下，之后不改。
- 留出集的请求只在 Task 14 发一次；在那之前不发、不看、不算分。
- 任何会话、任何命令都不打开 OpenTelemetry（不设 `CLAUDE_CODE_ENABLE_TELEMETRY`、`ENABLE_BETA_TRACING_DETAILED`、`OTEL_*`）。
- 密钥只从环境变量 `NACE_API_KEY` 读，不读它的值到对话里，不打印，不写进仓库、日志和回答文件。
- 真实请求的总预算：不超过 2000 次请求、3000 万输入 token（按现价 $0.03 / 百万约 1 美元）。超过任何一个上限就停下，不自行加预算。
- 第一次真实请求之前必须得到用户同意（Task 8 的关口）：预算、会发送哪些内容、用谁的密钥。
- 取自真实会话的用例、候选 skill 的快照和所有原始回答放在仓库外的 `~/.config/dispatch-pilot/calibration/`（目录 0700），不进 git。仓库是公开的 marketplace 源，仓库里只放工具、模型写的用例、清单和校准记录；校准记录里提到真实用例时只写编号和结果，不写原文。
- 不做的事（设计第 8 节）：criteria 里点名用例或为每个失败用例加一句；为解释某次怪回答加说明；让门槛贴着个别用例；测试里断言精确概率；用代码悄悄改写回答。
- 所有题的措辞只在 `hooks/questions.ts`；只在校准里当对照用的题放在 `eval/lib/controls.ts`，赢了才搬进去。
- 请求失败、超时、回答的 `model` 不是 `drex-max-v1.1` 的，都不是答案：不计分，单独报数。
- 提交信息形如 `dispatch-pilot 1.0.0: …`，走 pre-commit（`scripts/check.sh`），不用 `--no-verify`；署名用各自会话给的那一行。
- 起过的 tmux 会话和后台进程，用完按会话名或 PID 杀掉，再用 `pgrep -fl` 确认没有残留。

## 角色和模型

| 工作 | 模型 / effort |
|---|---|
| 官方要求清单、出题、参考答案、验收任务的设计、用例的审查 | `fable` / `xhigh` |
| 校准工具的代码（Task 2 到 6、15 的跑具） | `opus` / `high` |
| 跑对照、扫门槛、写记录（Task 9 到 14） | `opus` / `high`，数字由 controller 复核 |
| 代码的审查 | `opus` / `high` |

## 跑之前定死的判定规则

用例少（留出集一例就是 20 个百分点），所以只在差别明显时下结论，其余如实写「看不出」。

- **R-问法**：把「一道题直接选档位」换成默认问法，要同时满足：调整集 10 例上它比默认多对至少 2 例，`check` 4 例上不比默认差，留出集 5 例上多对至少 2 例。否则保持默认。
- **R-加题**（「长时间无人看管」）：同 R-问法的三个条件；否则不加。
- **R-删字段**（`previous_turn`、`stated_next`）：带着它在调整集上不多对任何一例，并且留出集上也不多对任何一例，就删；否则留。
- **R-recent**（1、3、5 条）：取调整集上对得最多的；并列时取最少的条数；留出集上比默认（5）差 2 例及以上就退回 5。
- **R-进展记录**：三种（不带、带截至上一步的、带含最新一步的）只报数和逐例对照，不由执行者定；由用户定。
- **R-门槛**：每个门槛在 0.50 到 0.95 之间每隔 0.05 取一个值，在 `fit` 上算对的例数，取对得最多的那一段里最保守的一端（升档、降档、换模型、推荐 skill 的门槛取最高的值；`no` 取最低的值）；再到 `check` 上核对，比初值少对 2 例及以上就保留初值并写「看不出」。
- **R-稳定**：同一请求问 3 遍，决定不一样的用例单独列出；这样的用例不参与门槛的选取。
- **R-验收**（中途换挡有没有用）：14 对运行里，开着的一组比关着的一组多通过至少 2 次，或者通过次数相同而总 token 的中位数低 15% 及以上，写「看得出」；否则写「看不出」，停下告诉用户。

## Review Focus

- 用例里带着密钥、令牌或本机的用户名路径：取料和校验都拒绝，不让它进用例文件（Task 2、3 的测试）。
- 请求失败或回答的模型不对：不当成答案，不当成「否」，报告里单独列（Task 5、6 的测试）。
- 预算用尽：发下一个请求之前停下，已经拿到的回答都在（Task 6 的测试）。
- 留出集被提前发出或算分：没有 `--final` 就拒绝，`--final` 只成功一次（Task 6 的测试）。
- 改了措辞以后拿旧回答算分：回答按请求内容的哈希取，对不上就算没问过（Task 4、6 的测试）。

---

### Task 1: 官方要求清单

**Files:**
- Create: `dispatch-pilot/eval/STANDARD.md`

**Interfaces:**
- Produces: 清单里每一条有编号 `S1`、`S2`…，后面的任务和用例的审查按编号引用。

由 `fable` / `xhigh` 的 agent 做。

- [ ] **Step 1:** 用 Exa 搜、Spider 读（`respect_robots: false`），把设计 3.4 节列的页面重新取一遍：`https://console.nace.ai/docs/drex/` 下的 questions、reading-answers、drex-max、errors-and-retries、reference/models、reference/pricing；`https://github.com/nace-ai/drex-agent-skills` 的 `drex-for-harness`；`https://docs.typesafe.ai/` 下的 primitives、confidence、model-jaggedness 和 skill_suggestion、consistency、llm_guardrails、basic_memory、autoresearch、verify_llm_outputs 各 cookbook；本机的 `typesafe:typesafe-ai` skill。TypeSafe 的页面只读它对出题、标注和定门槛的说法，不向它的接口发请求。
- [ ] **Step 2:** 写 `STANDARD.md`：一张表，列为 编号、要求（英文原文逐字引用）、出处 URL、取回日期、本计划由哪个任务的哪一步满足。只收和出题、参考答案、分组、定门槛、比较措辞、稳定性、发请求前的同意有关的条目。末尾一节「和设计 3.4 节不一致的地方」：没有就写「没有」。
- [ ] **Step 3:** 核对：表里每一条引文都能在取回的页面文字里逐字找到（取回的文字存在 scratchpad，用 `grep -F` 逐条查）。Expected: 每条都找到。
- [ ] **Step 4:** 「不一致」一节不是「没有」时停下，报告 controller（门槛或流程可能要改）。
- [ ] **Step 5:** Commit（`dispatch-pilot 1.0.0: the vendors' requirements for a calibration set, quoted`）。

### Task 2: 用例的形状和校验

**Files:**
- Create: `dispatch-pilot/eval/lib/case.ts`
- Test: `dispatch-pilot/tests/eval-case.test.ts`

**Interfaces:**
- Consumes: `Level`、`Tier`（`hooks/levels.ts`）、`PreviousTurn`、`StepRecord`、`ProgressNote`（`hooks/statebuild.ts`）。
- Produces:

```ts
export type Category = 'submit' | 'midrun' | 'agent' | 'skill'
export type Difficulty = 'typical' | 'hard' | 'boundary' | 'negative'
export type CaseSet = 'fit' | 'check' | 'heldout'
type Base = { id: string; source: 'real' | 'written'; difficulty: Difficulty; set: CaseSet; tags: string[]; label: { by: 'model' | 'human'; rationale: string } }
export type SubmitCase = Base & { category: 'submit'; input: { request: string; previous: PreviousTurn | null; base: Level }; expect: { accept: Level[] } }
export type MidrunCase = Base & { category: 'midrun'; input: { request: string; current: Level; stepsSoFar: number; failedSteps: number; recent: StepRecord[]; latest: StepRecord; statedNext: string; codeMode: boolean; notes: { before: ProgressNote | null; after: ProgressNote | null } | null }; expect: { action: 'hold' | 'up' | 'down'; accept: Level[] } }
export type AgentCase = Base & { category: 'agent'; input: { task: string; agentType: string; description: string; inherit: { level: Level; tier: Tier } }; expect: { accept: Level[]; models: Tier[] } }
export type SkillCase = Base & { category: 'skill'; input: { request: string; previous: PreviousTurn | null }; expect: { skill: string | null; alsoOk: string[] } }
export type Case = SubmitCase | MidrunCase | AgentCase | SkillCase
/** 一个用例的问题；空数组是合格。skills：候选快照里的名字。 */
export function checkCase(c: unknown, skills: readonly string[]): string[]
/** 一类 15 例的问题；空数组是合格。 */
export function checkSet(category: Category, cases: readonly Case[]): string[]
/** 文字里像密钥、令牌或带用户名的本机路径的片段。 */
export function secretsIn(text: string): string[]
```

`checkCase` 的规则：`id` 形如 `<category>-<两位数字>`；`accept` 是 1 个或 2 个相邻的档位；midrun 的 `action` 为 `hold` 时 `accept` 只能是 `[current]`，`up` 时都高于 `current` 且不超过 `xhigh`，`down` 时都低于；`recent` 不超过 5 条；agent 的 `models` 都不高于 `inherit.tier`；skill 的 `expect.skill` 和 `alsoOk` 都在 `skills` 里；`label.rationale` 非空；任何文字字段 `secretsIn` 非空就是问题。

`checkSet` 的规则：正好 15 例、`id` 不重复；`fit` 6、`check` 4、`heldout` 5；`boundary` 加 `negative` 不少于 5，其中 `heldout` 里不少于 2；另外：
- submit：`previous` 非空的不少于 5 例，其中带标签 `continues` 的不少于 2；带标签 `long-unattended` 的不少于 2。
- midrun：`action` 为 `hold` 的不少于 8；标签 `looks-finished`、`batch-mechanical`、`stuck` 各不少于 2；`codeMode` 为真的不少于 5、为假的不少于 5。
- agent：`models` 不含 `inherit.tier` 的（应该换低）不少于 3；只含 `inherit.tier` 的（不该换）不少于 5。
- skill：`expect.skill` 为 `null` 的不少于 5。

`secretsIn` 认：`sk-`、`nace_sk_`、`ghp_`、`Bearer ` 开头的串；32 个字符以上的十六进制或 base64 串；`/Users/<名字>/` 和 `/home/<名字>/`（`/Users/user/` 除外）。

- [ ] **Step 1: 写失败的测试**（`tests/eval-case.test.ts`）。至少这些：

```ts
test('一例合格的 submit 用例没有问题', () => { expect(checkCase(okSubmit, [])).toEqual([]) })
test('accept 里两个档位不相邻：是问题', () => { expect(checkCase({ ...okSubmit, expect: { accept: ['low', 'high'] } }, [])).toHaveLength(1) })
test('hold 的 midrun 用例 accept 必须是 [current]', () => { expect(checkCase({ ...okMidrun, expect: { action: 'hold', accept: ['high'] } }, [])).toHaveLength(1) })
test('skill 用例期望的名字不在候选里：是问题', () => { expect(checkCase(okSkill, ['other'])).toHaveLength(1) })
test('文字里有密钥或带用户名的路径：是问题', () => {
  expect(secretsIn('key nace_sk_abcdefghijklmnop')).toHaveLength(1)
  expect(secretsIn('at /Users/someone/project/a.ts')).toHaveLength(1)
  expect(secretsIn('at /Users/user/project/a.ts')).toEqual([])
})
test('一类 15 例：分组 6/4/5、边界和反例不少于 5 且留出集里不少于 2', () => { expect(checkSet('submit', fifteen)).toEqual([]) })
test('midrun 里 hold 少于 8 例：是问题', () => { expect(checkSet('midrun', sevenHolds)).toHaveLength(1) })
```

- [ ] **Step 2:** `scripts/test-one.sh dispatch-pilot eval-case.test.ts`。Expected: FAIL（模块不存在）。先确认测试能从 `../eval/lib/case.ts` 导入；导入不了时停下报告，不改放到别处。
- [ ] **Step 3:** 实现 `eval/lib/case.ts`（纯函数，不导入 `node:` 模块）。
- [ ] **Step 4:** 同一命令。Expected: PASS。再跑 `scripts/check.sh dispatch-pilot`。Expected: 全部 ok。
- [ ] **Step 5:** Commit（`dispatch-pilot 1.0.0: the shape of a calibration case and its checks`）。

### Task 3: 从会话记录里取料

**Files:**
- Create: `dispatch-pilot/eval/lib/transcript.ts`、`dispatch-pilot/eval/mine.ts`
- Test: `dispatch-pilot/tests/eval-transcript.test.ts`

**Interfaces:**
- Consumes: `newTurn`（`hooks/state.ts`）、`planRow`（`hooks/midrun.ts`）、`kindOf` 和 `Row`（`hooks/journal.ts`）、`secretsIn`（Task 2）。行的形状见 `docs/research/dispatch-pilot-real-rows.md` 和 `dispatch-pilot/DEVELOPMENT.md` 的「Code Mode 一轮里的行」。
- Produces:

```ts
export type Mined =
  | { kind: 'submit'; session: string; request: string; previous: PreviousTurn | null }
  | { kind: 'midrun'; session: string; input: Omit<MidrunCase['input'], 'notes'>; isCheckpoint: boolean; after: StepRecord[]; ended: string }
  | { kind: 'agent'; session: string; task: string; agentType: string; description: string; parentModel: string }
/** 一个会话的记录（JSONL 逐行解析后的对象）里能当素材的地方；不认识的记录跳过。 */
export function mine(session: string, records: readonly unknown[]): Mined[]
/** 把本机主目录换成 /Users/user，把用户名换成 user。 */
export function scrub(text: string, home: string, user: string): string
```

`mine` 把一轮的记录逐条换成 mod 的 `Row`，用 `planRow`（默认配置、`judging: true`）重放，所以 midrun 素材里的 `recent`、`latest`、`statedNext`、步数 就是 mod 在那一行会算出来的；每个结果行出一条素材，`isCheckpoint` 写 mod 在那里会不会问；`after` 是这之后直到轮末的步（给标注的人看这一轮后来怎么走的），`ended` 是这一轮怎么结束的。主循环之外的记录（子 agent 的）不算。CLI：`node dispatch-pilot/eval/mine.ts --projects <目录>… --out <数据目录>/mined.jsonl`，输出前每段文字过 `scrub`，`secretsIn` 非空的素材丢掉并计数。

- [ ] **Step 1: 写失败的测试**：用测试里手写的几段小记录（普通会话一轮：消息、两次工具调用和结果、回答；Code Mode 一轮：回执、poll_events、Poll 的结果）断言——submit 素材的 `request` 和 `previous`；midrun 素材的 `stepsSoFar`、`latest.result` 的开头、失败结果的 `outcome`；Agent 工具调用出一条 agent 素材；子 agent 的记录不出素材；`scrub('/Users/someone/x', '/Users/someone', 'someone')` 得 `/Users/user/x`；CLI 用的筛选函数把文字里带密钥的素材丢掉并计数。
- [ ] **Step 2:** `scripts/test-one.sh dispatch-pilot eval-transcript.test.ts`。Expected: FAIL。
- [ ] **Step 3:** 实现。`transcript.ts` 是纯的；读文件只在 `mine.ts`。
- [ ] **Step 4:** 同一命令 PASS；`scripts/check.sh dispatch-pilot` 全部 ok。
- [ ] **Step 5:** Commit（`dispatch-pilot 1.0.0: calibration material mined from session records the way the mod reads them`）。

### Task 4: 请求的构造和对照题

**Files:**
- Create: `dispatch-pilot/eval/lib/request.ts`、`dispatch-pilot/eval/lib/controls.ts`
- Test: `dispatch-pilot/tests/eval-request.test.ts`

**Interfaces:**
- Consumes: `Case`（Task 2）；`submitState`、`midrunState`、`agentState`；`submitQuestions`、`midrunQuestions`、`agentQuestions`；`stageOne`、`stageTwo`、`Skill`；`Question`、`Answer`。
- Produces:

```ts
export type Variant = { name: string; previous?: boolean; recent?: 1 | 3 | 5; statedNext?: boolean; progress?: 'none' | 'before' | 'after'; controls?: boolean; shuffle?: number; stage?: 1 | 2 }
export type Built = { caseId: string; variant: string; state: Record<string, unknown>; questions: Record<string, Question>; hash: string }
/** 一个用例在一种给法下的请求；skill 的第二次请求要给第一次选出的 short。 */
export function build(c: Case, v: Variant, ctx: { skills: readonly Skill[]; short?: readonly Skill[] }): Built
/** 每一类预先登记的给法；第一项是默认（和 mod 发的一样）。 */
export const VARIANTS: Record<Category, readonly Variant[]>
// controls.ts
export const DIRECT_LEVEL: Question      // choice，id 用 'direct'
export const LONG_UNATTENDED: Question   // noul，id 用 'long_unattended'
/** 直接选档位那道题的读法：选中项概率不低于 0.5 取它，否则取概率最高两项里较低的一档。 */
export function readDirect(a: Answer | undefined): Level | null
```

`VARIANTS`（名字固定，报告和记录都用它）：
- submit：`default`（`controls: true`，带 `previous`）、`no-previous`（`previous: false`）。
- midrun：`default`（recent 5、带 stated_next、不带进展记录、`controls: true`）、`recent-1`、`recent-3`、`no-stated-next`、`progress-before`、`progress-after`。
- agent：`default`（`controls: true`）。
- skill：`stage-1`、`stage-2`、`stage-1-shuffled`（`shuffle: 1`）、`stage-2-shuffled`。

`controls: true` 时在同一请求里多问 `direct`（三类都问）和 `long_unattended`（只在 submit 和 agent 问）。两道对照题的措辞：

```ts
export const DIRECT_LEVEL: Question = {
  type: 'choice',
  instructions: 'Which effort level fits the work described? Judge how open the problem is; the amount of work never raises the level.',
  criteria: {
    low: 'The way to do it is already given; the work is carrying it out.',
    medium: 'A few possibilities within a small area, or one small trap to watch for.',
    high: 'Several workable designs or several possible causes; a choice has to be made between them.',
    xhigh: 'The cause is unknown and the behavior is intermittent, concurrent or state-dependent, or the change is easy to get subtly wrong.',
    max: 'The cause is unknown or the change is easy to get subtly wrong, and in addition it cannot be reproduced, the operation cannot be undone, or it must be switched over while running.',
  },
}
export const LONG_UNATTENDED: Question = {
  type: 'noul',
  instructions: 'Does the work hand over a long job to be finished alone, with nobody checking in between?',
  criteria: { true: 'Many files or stages are to be completed in one go, and no checkpoint with the user is asked for.', false: 'The work is a few steps, or the user is following along and will answer questions.' },
}
```

`long_unattended` 的候选规则（只在算分时试，不进 mod）：读成「是」时档位不低于 `high`。`hash` 是 state 和 questions 的 JSON 的 FNV-1a 64 位十六进制（纯函数，不导入 `node:crypto`）。`shuffle` 用给定的数做种子，把 choice 的选项顺序确定地打乱。

- [ ] **Step 1: 写失败的测试**：`default` 给法下 submit 的 `state` 等于 `submitState(...)`、`questions` 含 `submitQuestions(...)` 的每一题外加 `direct`、`long_unattended`；`recent-1` 的 `state.recent` 长 1；`no-stated-next` 没有 `stated_next`；`progress-after` 的 `state.progress` 来自 `notes.after`；同一用例同一给法两次 `build` 的 `hash` 相同，改一个字 `hash` 不同；`stage-1-shuffled` 的选项集合和 `stage-1` 相同而顺序不同；`readDirect` 在 0.6/0.3 时取选中项、0.45/0.40 时取较低的一档。
- [ ] **Step 2:** `scripts/test-one.sh dispatch-pilot eval-request.test.ts`。Expected: FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 同一命令 PASS；`scripts/check.sh dispatch-pilot` 全部 ok。
- [ ] **Step 5:** Commit（`dispatch-pilot 1.0.0: a case becomes the request the mod would send, in each registered variant`）。

### Task 5: 读回答、判分、扫门槛

**Files:**
- Create: `dispatch-pilot/eval/lib/read.ts`、`dispatch-pilot/eval/lib/sweep.ts`
- Modify: `dispatch-pilot/hooks/skills.ts`（`wantsSkill`、`pick` 多收一个门槛参数，默认值是现在的常数，行为不变）
- Test: `dispatch-pilot/tests/eval-read.test.ts`

**Interfaces:**
- Consumes: `submitLevel`、`midrunLevel`、`agentPlan`、`Thresholds`、`START`（`hooks/decide.ts`）；`wantsSkill`、`shortlist`、`pick`；`readDirect`（Task 4）。
- Produces:

```ts
export type SkillBars = { action: number; named: number; fits: number }
export type Bars = { submit: Thresholds; midrun: Thresholds; agent: Thresholds; skill: SkillBars }
export const START_BARS: Bars
export type Stored = { ok: true; model: string; answers: Record<string, Answer> } | { ok: false; reason: string }
export type Outcome = { level: Level | null; model: Tier | null; skill: string | null }
export type Mark = 'right' | 'over' | 'under' | 'needless-shift' | 'missed-shift' | 'wrong-model' | 'wrong-skill' | 'missed-skill' | 'needless-skill'
/** 按给定门槛读一个用例的回答；回答不可用（失败、模型不对、缺题）时是 null。 */
export function outcomeOf(c: Case, first: Stored, bars: Bars, opt?: { form?: 'default' | 'direct'; longUnattended?: boolean; second?: Stored }): Outcome | null
export function mark(c: Case, o: Outcome): Mark
// sweep.ts
export type Row = { value: number; right: number; marks: Record<string, Mark> }
/** 只动一个门槛（path 如 'submit.up'、'skill.fits'），其余用 base。 */
export function sweep(cases: readonly Case[], stored: (id: string) => Stored | undefined, base: Bars, path: string, grid?: readonly number[]): Row[]
/** 对得最多的那一段和取哪一端；conservative 'high' 取最大的值，'low' 取最小的。 */
export function plateau(rows: readonly Row[], conservative: 'high' | 'low'): { best: number; from: number; to: number; pick: number }
```

`mark`：档位在 `accept` 里是 `right`，高了 `over`，低了 `under`；midrun 期望 `hold` 而换了是 `needless-shift`，期望换而没换是 `missed-shift`；agent 档位对而模型不在 `models` 里是 `wrong-model`；skill 推荐了别的 `wrong-skill`、该推荐没推荐 `missed-skill`、不该推荐却推荐了 `needless-skill`。agent 的模型按默认配置算（`agentModels` 是 haiku、sonnet、opus，`fableAgents` 关）。

- [ ] **Step 1: 写失败的测试**：回答 `ok: false` 或 `model` 不是 `drex-max-v1.1` 时 `outcomeOf` 是 `null`；一例 submit 在 `START_BARS` 下的档位等于 `submitLevel` 的结果；`form: 'direct'` 时取 `readDirect`；`longUnattended: true` 且那题读成「是」时不低于 `high`；期望 hold 而换挡标 `needless-shift`；skill 三种错各一例；`sweep` 对 `submit.up` 给出 10 行、`value` 从 0.5 到 0.95；`plateau` 在 `right` 为 3,5,5,5,4 时 `conservative: 'high'` 取第四个值、`'low'` 取第二个。测试里的回答都是手写的概率，只断言决定，不断言概率。
- [ ] **Step 2:** `scripts/test-one.sh dispatch-pilot eval-read.test.ts`。Expected: FAIL。
- [ ] **Step 3:** 实现；改 `hooks/skills.ts` 的两个签名（`wantsSkill(a, bars = { action: ACTION_BAR, named: NAMED_BAR })`、`pick(short, answers, fits = FITS_BAR)`）。
- [ ] **Step 4:** 同一命令 PASS；全套测试和 `scripts/check.sh dispatch-pilot` 全部 ok（原有 456 条不变）。
- [ ] **Step 5:** Commit（`dispatch-pilot 1.0.0: stored answers are read with the mod's own rules, marked, and swept over thresholds`）。

### Task 6: 发请求、存回答、预算

**Files:**
- Create: `dispatch-pilot/eval/lib/budget.ts`、`dispatch-pilot/eval/lib/store.ts`、`dispatch-pilot/eval/lib/drex.ts`、`dispatch-pilot/eval/run.ts`
- Test: `dispatch-pilot/tests/eval-budget.test.ts`

**Interfaces:**
- Consumes: `ask`、`Io`、`Config`、`readConfig`；`build`、`VARIANTS`；`outcomeOf`、`mark`、`sweep`、`plateau`；`checkCase`、`checkSet`；`estimateTokens`。
- Produces:

```ts
// budget.ts（纯）
export const CAP = { requests: 2000, tokens: 30_000_000 } as const
export type Spent = { requests: number; tokens: number }
/** 花得起就返回花过之后的数，花不起返回 null。 */
export function spend(spent: Spent, cost: Spent, cap?: Spent): Spent | null
/** 留出集能不能发：没有 final 不能；已经发过一次不能。 */
export function mayAskHeldout(o: { final: boolean; alreadyDone: boolean }): boolean
```

数据目录（`--data`，默认 `~/.config/dispatch-pilot/calibration`）：`cases/<category>.json`（取自真实会话的用例）、`skills.json`（候选快照）、`answers.jsonl`（一行一条：哈希、第几遍、用例、给法、时间、耗时、发出的请求原文（state 和题）、回答或失败原因）、`spent.json`、`heldout-done`。模型写的用例在仓库里的 `dispatch-pilot/eval/cases/<category>.json`；两处合起来是一类的 15 例。

`node dispatch-pilot/eval/run.ts <命令>`（`--set tune` 指 `fit` 加 `check` 的 10 例）：
- `check-cases`：四类都过 `checkCase` 和 `checkSet`，否则列出问题并以 1 退出。
- `plan --set tune|heldout [--variant <名字>] [--repeat <n>]`：列出还没有回答的请求数和估算的 token，什么都不发。
- `ask --set tune [--variant <名字>] [--repeat <n>]`：发还没有回答的请求（按哈希和第几遍判断），一次一个，每个请求的时限 60000 ms（Nace 文档要求的客户端下限），失败的记下原因不重发（`--retry-failed` 才重发一次）。发每个请求之前用 `spend` 查预算，花不起就停。skill 的 `stage-2` 用同一用例 `stage-1` 的回答算 short。
- `ask --set heldout --final`：只在 `mayAskHeldout` 允许时发，发完写 `heldout-done`。
- `score --set <fit|check|tune|heldout> [--bars <文件>] [--form direct] [--long-unattended] [--variant <名字>]`：逐例一行（编号、期望、结果、标记）加汇总；`heldout` 在 `heldout-done` 存在之前拒绝。
- `sweep --path <submit.up|…|skill.fits>`：在 `fit` 上出表和 `plateau` 的结果。
- `stability`：同一请求几遍的决定不一样的用例。

密钥：`process.env.NACE_API_KEY`，没有就报「没有密钥」并以 1 退出；任何输出里都不出现它。

- [ ] **Step 1: 写失败的测试**（`tests/eval-budget.test.ts`）：

```ts
test('花得起：返回花过之后的数', () => { expect(spend({ requests: 1, tokens: 10 }, { requests: 1, tokens: 5 })).toEqual({ requests: 2, tokens: 15 }) })
test('请求数到上限：花不起', () => { expect(spend({ requests: 2000, tokens: 0 }, { requests: 1, tokens: 1 })).toBe(null) })
test('token 会超上限：花不起', () => { expect(spend({ requests: 0, tokens: 29_999_999 }, { requests: 1, tokens: 2 })).toBe(null) })
test('留出集：没有 final 不发，发过一次不再发', () => {
  expect(mayAskHeldout({ final: false, alreadyDone: false })).toBe(false)
  expect(mayAskHeldout({ final: true, alreadyDone: true })).toBe(false)
  expect(mayAskHeldout({ final: true, alreadyDone: false })).toBe(true)
})
```

- [ ] **Step 2:** `scripts/test-one.sh dispatch-pilot eval-budget.test.ts`。Expected: FAIL。
- [ ] **Step 3:** 实现四个文件。`store.ts`、`drex.ts`、`run.ts` 可以导入 `node:` 模块，不被测试和 hooks 导入。
- [ ] **Step 4:** 测试 PASS。用一个临时数据目录和两例手写的用例跑 `check-cases`（Expected: 列出「不是 15 例」并以 1 退出）和 `plan --set tune`（Expected: 打印请求数，不发请求）；去掉 `NACE_API_KEY` 跑 `ask --set tune`（Expected: 「没有密钥」，退出码 1）；`score --set heldout`（Expected: 拒绝）；往 `answers.jsonl` 手写一条某个请求的回答，`plan` 少算这一个，再改那个用例的一个字，`plan` 又把它算作没问过（回答按哈希取）。这一步不发任何真实请求。
- [ ] **Step 5:** `scripts/check.sh dispatch-pilot` 全部 ok；Commit（`dispatch-pilot 1.0.0: the calibration runner: asks within a budget, keeps every raw answer, holds the held-out set back`）。

### Task 7: 出题（Fable 5.2，xhigh）

**Files:**
- Create: `dispatch-pilot/eval/cases/{submit,midrun,agent,skill}.json`（模型写的用例）、数据目录里的 `cases/*.json`（取自真实会话的用例）和 `skills.json`

**Interfaces:**
- Consumes: `STANDARD.md`（Task 1）、用例的形状（Task 2）、`mined.jsonl`（Task 3 的 CLI）、`run.ts check-cases`（Task 6）。
- Produces: 60 个用例，`expect` 先由出题者填（Task 8 独立再答一遍）。

- [ ] **Step 1（controller）:** 确认旧版 dispatch-pilot 关着；在用户同意的范围内跑 `mine.ts`（范围见文末「请你定的事」第 1 条），并存下候选 skill 的快照 `skills.json`（名字和描述）：用一个一次性的探针 mod（只挂 `prompt.attachment` 的 `skill_listing`，把文字写进调试日志，不进仓库）在不加载 dispatch-pilot 的交互会话里发一条消息取到完整列表，用 `hooks/skills.ts` 的 `parseListing` 解析。
- [ ] **Step 2:** 派四个出题 agent（`fable` / `xhigh`，一类一个，互不知道别类）。每个 agent：读 `STANDARD.md`、设计第 8 节和本类在 5.3 到 5.6 节的说明、本类题目的措辞；从 `mined.jsonl` 里挑有代表性的、难的、处在两档之间的和答案是「否」「保持不变」「不推荐」的；真实素材里缺的类别自己补写并标 `source: 'written'`；按 Task 2 的规则配齐标签和 6/4/5 的分组（分组时不看任何模型回答）；每例在 `label.rationale` 里写清为什么是这个答案、依据 `STANDARD.md` 的哪几条。真实用例写进数据目录，补写的写进仓库。
- [ ] **Step 3:** `node dispatch-pilot/eval/run.ts check-cases`。Expected: 四类都合格，退出码 0。不合格的退回同一个出题 agent 改。
- [ ] **Step 4:** 派一个审查 agent（`fable` / `xhigh`）：逐例对照 `STANDARD.md` 的每一条，查有没有泄题（用例文字里直接写了档位或答案）、是不是太容易、同一类里有没有重复的情形、真实用例里有没有该抹掉的内容。有问题的退回出题 agent，改到审查通过。
- [ ] **Step 5:** Commit 仓库里的四个文件（`dispatch-pilot 1.0.0: the written calibration cases`）。数据目录里的不进 git。

### Task 8: 参考答案、抽查和同意（到这里停下等用户）

**Files:**
- Modify: 四类用例文件里的 `expect` 和 `label`
- Create: 数据目录里的 `labels.md`（两遍答案的对照）

- [ ] **Step 1:** 派四个答题 agent（`fable` / `xhigh`，一类一个）。给它的用例去掉 `expect`、`label`、`difficulty`、`tags`、`set`；真实的 midrun 用例附上 `after` 和 `ended`（这一轮后来怎么走的）。它读完整上下文，按题目的定义给出每例的答案和理由，不知道出题者的答案。
- [ ] **Step 2:** 对照两遍答案，写进 `labels.md`。一致的留用；不一致的交给第三个 agent（`fable` / `xhigh`）看两边的理由裁定：用例本身有歧义的改写或换一例（换的那一例重新走 Task 7 的 Step 3、4 和本步），答案取裁定的结果。`label.by` 都是 `model`。
- [ ] **Step 3:** `node dispatch-pilot/eval/run.ts check-cases` 合格；`node dispatch-pilot/eval/run.ts plan --set tune` 和 `plan --set heldout` 给出请求数和 token 估算。
- [ ] **Step 4（controller，停下）:** 给用户：用例文件的位置；一张表（编号、类别、来源、难度、期望）；两遍答案不一致过的用例；预算（请求数上限 2000、估算的 token 和费用）；会发出去的内容（60 个用例的全文，含取自真实会话的那些，外加候选 skill 的名字和描述）；用的密钥（环境变量 `NACE_API_KEY`，不读不打印）。请用户抽查并回答是否同意开始发请求。用户改过答案的用例把 `label.by` 改成 `human`。
- [ ] **Step 5:** 用户同意后 Commit 仓库里改动的用例（`dispatch-pilot 1.0.0: reference answers for the written cases, answered twice`）。

### Task 9: 调整集的基线

**Files:**
- Create: `dispatch-pilot/eval/CALIBRATION.md`（第一节）

- [ ] **Step 1:** `node dispatch-pilot/eval/run.ts ask --set tune --variant default --repeat 3`（skill 是 `stage-1` 再 `stage-2`）。Expected: 四类各 10 例都有 3 遍回答；失败的请求列出原因。
- [ ] **Step 2:** `score --set tune` 和 `stability`。
- [ ] **Step 3:** 写 `CALIBRATION.md` 的「基线」一节：日期、模型版本（回答里的 `model`）、请求数和失败数、每类的对错（按标记分列）、逐例的表（真实用例只写编号）、决定不稳定的用例。每个数字都能由 `score` 重新算出。
- [ ] **Step 4:** 回答看着不对的用例，按这个顺序查并记下查到哪一步：实际发出的请求、state、选项、题的范围、措辞（设计第 8 节）。这一步只记录，不改措辞。
- [ ] **Step 5:** Commit（`dispatch-pilot 1.0.0: calibration, the baseline on the tuning set`）。

### Task 10: 对照一，问法和要不要加题

- [ ] **Step 1:** 基线的回答里已经有 `direct` 和 `long_unattended`（同一请求里问的）。`score --set tune --form direct`、`score --set tune --long-unattended`。
- [ ] **Step 2:** 把默认问法和两种对照逐例并排写进 `CALIBRATION.md` 的「问法」一节（三类分开），按 R-问法、R-加题在调整集上的两个条件写出「候选」或「不换」。留出集上的那个条件到 Task 14 才看。
- [ ] **Step 3:** 默认问法的措辞要不要改：只在 `fit` 的 6 例上看哪一档的说明或哪道条件题读得不对；改 `hooks/questions.ts`（改法照 3.4 节：每档写成单独成立的情形，一题一个判断；不点名用例），重新 `ask --set tune --variant default --repeat 3`，在 `check` 的 4 例上复查：比改之前少对就撤回。每类最多改 3 轮；每一轮的改动、理由和前后的数都记进记录。没有明显读错的就不改。
- [ ] **Step 4:** 全套测试和 `scripts/check.sh dispatch-pilot` 全部 ok；Commit（`dispatch-pilot 1.0.0: calibration, the two ways of asking compared on the tuning set`）。

### Task 11: 对照二，上下文

- [ ] **Step 1:** `ask --set tune --variant no-previous`（submit 里 `previous` 非空的用例）；`ask --set tune --variant recent-1`、`recent-3`、`no-stated-next`。
- [ ] **Step 2:** 各给法 `score --set tune --variant <名字>`，逐例并排写进「上下文」一节，按 R-删字段、R-recent 在调整集上的条件写出候选。
- [ ] **Step 3:** Commit（`dispatch-pilot 1.0.0: calibration, what each context field is worth on the tuning set`）。

### Task 12: 对照三，进展记录

- [ ] **Step 1:** 给每个 midrun 用例补 `notes`：用 mod 自己的 `progressPrompt`（`hooks/progress.ts`）构造提示，`before` 的输入是截至上一步的步、`after` 再加最新一步；用 `command claude -p --model haiku --system-prompt <progressPrompt 的 system>` 逐条生成（不设任何 OpenTelemetry 变量），`parseProgress` 解析不了的记 `null`。这和 mod 里的 `$.model.complete` 不是同一条通路，记录里写明。生成用的小脚本放 `dispatch-pilot/eval/notes.ts`。
- [ ] **Step 2:** `ask --set tune --variant progress-before`、`progress-after`；`score`。
- [ ] **Step 3:** 「进展记录」一节：三种逐例并排，标签 `looks-finished`、`batch-mechanical`、`stuck` 的用例单独成表。只报数（R-进展记录）。
- [ ] **Step 4:** Commit（`dispatch-pilot 1.0.0: calibration, the progress note compared three ways on the tuning set`）。

### Task 13: 门槛

**Files:**
- Modify: `dispatch-pilot/hooks/decide.ts`（`thresholdsFor`）、`dispatch-pilot/hooks/skills.ts`（新增 `skillBarsFor`）、调用它们的 flows
- Test: `dispatch-pilot/tests/decide.test.ts`、`dispatch-pilot/tests/skills.test.ts`

**Interfaces:**
- Produces: `thresholdsFor('drex', 'drex-max-v1.1', action)` 返回校准后的表，别的后端和模型仍返回 `START`；`export function skillBarsFor(backend: 'drex' | 'jev', model: string): { action: number; named: number; fits: number }`，同样只有 Drex 的这一版有自己的值。

- [ ] **Step 1:** 对每个门槛跑 `sweep`：`submit.up`、`submit.upHigh`、`submit.down`、`submit.yes`、`submit.no`，midrun 和 agent 的同名各项，`agent.modelDown`，`skill.action`、`skill.named`、`skill.fits`。去掉 R-稳定列出的用例。
- [ ] **Step 2:** 按 R-门槛取值，在 `check` 上核对。把每张表、取的值、取值的那一段和「看不出」的项写进「门槛」一节；另报 `midrunEveryScripts` 为 1 时每个检查点上无谓换挡的比例（midrun 里期望 hold 的用例中标 `needless-shift` 的比例）。
- [ ] **Step 3: 写失败的测试**：`thresholdsFor('drex', 'drex-max-v1.1', 'submit')` 等于记录里取的值；`thresholdsFor('jev', 'jev-latest', 'submit')` 等于 `START`；`skillBarsFor` 同理。跑，Expected: FAIL。
- [ ] **Step 4:** 实现；flows 里取门槛的地方改用 `skillBarsFor`。测试 PASS，全套和 `scripts/check.sh dispatch-pilot` 全部 ok。
- [ ] **Step 5:** Commit（`dispatch-pilot 1.0.0: thresholds for drex-max-v1.1 from the tuning set`）。

### Task 14: 留出集，一次

- [ ] **Step 1:** 先把 Task 10 到 13 定下的候选写进记录的「留出集之前定下的」一节并提交（这样留出集的结果不会倒过来影响候选）。
- [ ] **Step 2:** `node dispatch-pilot/eval/run.ts ask --set heldout --final`，一次发完登记过的全部给法（默认 3 遍，其余各 1 遍，skill 两阶段加打乱顺序的一遍）。
- [ ] **Step 3:** `score --set heldout`（默认、`--form direct`、`--long-unattended`、各给法）、`stability`；skill 打乱顺序后结果变了的用例单独列出。
- [ ] **Step 4:** 按预先定死的规则逐条下结论，写进「留出集」一节：每类的对错（取自真实会话的和模型写的分开报数）、和调整集的差、每条规则的结论（换、不换、删、留、看不出）。报告里的数字用留出集的。
- [ ] **Step 5:** 规则说要改的才改代码（换问法：把 `controls.ts` 里那道题搬进 `hooks/questions.ts` 并改读法；删字段：改 `hooks/statebuild.ts`；改 recent 的条数），每处先写失败的测试。门槛在留出集上比初值少对 2 例及以上的，退回初值并写明。
- [ ] **Step 6:** 全套测试和 `scripts/check.sh dispatch-pilot` 全部 ok；Commit（`dispatch-pilot 1.0.0: calibration, the held-out set scored once`）。

### Task 15: 中途换挡在真实任务上的验收

**Files:**
- Create: `dispatch-pilot/eval/accept/tasks/<编号>/{prompt.txt,check.sh,meta.json,project/…}`（6 个任务）、`dispatch-pilot/eval/accept/lib/usage.ts`、`dispatch-pilot/eval/accept/run.ts`
- Test: `dispatch-pilot/tests/eval-usage.test.ts`

**Interfaces:**
- Produces: `export function usageOf(records: readonly unknown[]): { steps: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; turnMs: number }`（只数主循环）；`node dispatch-pilot/eval/accept/run.ts --task <编号> --arm on|off --mode code|ordinary --model <模型>` 往数据目录的 `accept.jsonl` 追加一行（任务、组、模式、通过与否、`usageOf` 的数、本轮的中途决策记录条数和实际发出的档位）。

- [ ] **Step 1:** 派一个 agent（`fable` / `xhigh`）设计 6 个任务，每个是一个小项目加一条提示词和一个判对错的 `check.sh`（退出码 0 为做对），一轮能做完：2 个会卡住（同一失败在修改后复现，真正的原因要读懂另一个文件才找得到）、2 个开头像难题而查明后只剩照做的批量改动、2 个从头到尾平稳。`meta.json` 写期望的换挡方向（`up`、`down`、`none`）。任务不依赖网络，不含任何真实项目的内容。
- [ ] **Step 2:** 写 `usageOf` 的失败测试（手写几条记录：两步主循环各带 usage、一条子 agent 的记录不算），实现到 PASS。
- [ ] **Step 3:** 实现 `run.ts`：把任务的 `project/` 复制到 scratchpad 下的新目录；从环境变量生成 0600 的临时设置文件（关掉已装的旧版；`drexApiKey`；`midrunShift` 按组开关；Code Mode 按模式），不打印密钥；在 tmux 里起交互会话（`--plugin-dir` 指向本 mod，不设任何 OpenTelemetry 变量），发提示词，等这一轮结束（最长 15 分钟），跑 `check.sh`，读会话记录算 `usageOf`，杀掉会话，删掉临时设置文件。
- [ ] **Step 4:** 先各跑一次确认跑具可用（一个任务、两组、Code Mode）。Expected: `accept.jsonl` 多两行，`pgrep -fl tmux` 没有残留。
- [ ] **Step 5:** 正式跑：6 个任务 × 两组 × 2 遍（Code Mode）加 2 个任务 × 两组 × 1 遍（普通会话），共 28 次，模型见「请你定的事」第 2 条。两组除 `midrunShift` 外完全相同（发消息定档都开着）。
- [ ] **Step 6:** 「验收」一节：逐次的表、每个任务两组的对照、按 R-验收的结论；开着的那一组里换挡发没发出去（记录里的实际档位）单独列。写「看不出」时停下，把这一节交给用户，这项功能留不留由用户定，不自行改成别的做法。
- [ ] **Step 7:** `scripts/check.sh dispatch-pilot` 全部 ok；确认没有残留进程；Commit（`dispatch-pilot 1.0.0: mid-run shifts tried on real tasks, with and without`）。

### Task 16: 校准记录收尾，交给用户

**Files:**
- Modify: `dispatch-pilot/eval/CALIBRATION.md`、`dispatch-pilot/README.md`、`dispatch-pilot/DEVELOPMENT.md`、`docs/superpowers/specs/2026-11-17-dispatch-pilot-rewrite-design.md`（第 11 节）

- [ ] **Step 1:** `CALIBRATION.md` 开头加摘要：模型版本和日期；用例的来源（真实多少、模型写的多少，分开报数）；参考答案是模型标的（Fable 5.2，xhigh，答两遍），用户抽查改过几例；留出集上每类的结果；定下的门槛；每组对照的结论和「看不出」的项；验收的结论；一共用了多少请求和 token；怎么重算（`score`、`sweep` 不用再发请求）。
- [ ] **Step 2:** README：配置表里门槛和默认值的变化、Drex 已校准而 Jev 标「未校准」、建议先用 `shadow` 在真实会话里跑一段再开 `apply`（设计第 8 节「上线」）。DEVELOPMENT.md：校准工具怎么跑、数据目录里有什么。设计文档第 11 节加校准定下的事。
- [ ] **Step 3:** `scripts/check.sh` 全部 ok；Commit（`dispatch-pilot 1.0.0: the calibration record`）。
- [ ] **Step 4（controller，停下）:** 把记录交给用户，请用户定：进展记录用哪一种、要不要默认打开；中途换挡留不留（验收写「看不出」时）；什么时候合并到 `main`（合并就是发布）并把已装的 dispatch-pilot 打开。

---

## 请你定的事（开始执行前）

1. **真实用例从哪些会话里取。** 我的建议：只取本仓库（claude-mods）自己的会话记录，取料时把主目录和用户名换掉、像密钥的内容整条丢掉，60 个用例在发请求之前全部给你看（Task 8）。这些内容会发给 Nace，也会被出题的 Fable agent 读到。也可以选「全部由模型写」（最干净，但两家的文档都说模型写的用例比真实请求容易，结果会偏乐观），或者指定更多项目。
2. **验收用哪个主模型跑。** 我的建议：Sonnet 5.5（28 次交互会话）。你平时用 Fable，想看 Fable 上的效果可以改成 Fable，代价是 Fable 的周额度。
3. **预算。** Drex 最多 2000 次请求（约 1 美元）；Fable 5.2 xhigh 的 agent 大约 12 到 15 个（清单 1、出题 4、审查 1、答题 4、裁定 1、验收任务 1，加返工）。

---

## 修订（2026-11-19，对照 Task 1 的官方要求清单之后；和上文不一致的地方以这一节为准）

**A1 留出集不参与任何取舍（清单 S17、S18）。** 上文「跑之前定死的判定规则」里凡是看留出集的条件都作废。所有取舍只在调整集上做：`fit` 上选，`check` 上确认。
- R-问法、R-加题：候选在调整集 10 例上比默认多对至少 2 例，并且 `check` 4 例上不比默认差，才换；否则保持默认。
- R-删字段：带着这个字段在调整集上不多对任何一例，就删；否则留。
- R-recent：取调整集上对得最多的条数，并列取最少的。
- 这些取舍引起的代码改动（换问法、加题、删字段、改条数）在 Task 10、11 里做完，都先写失败的测试；Task 13 在最终的措辞和 state 上扫门槛（清单 S9）。
- Task 14 只发一次、只报数：用最终配置（`default` 3 遍，skill 加打乱顺序的一对），另把登记过的其余给法各问 1 遍作为观察。留出集的结果不改任何配置；比调整集明显差时照实写进记录，由用户定。Task 14 的 Step 5 作废。

**A2 同一会话的用例不跨组（清单 S17）。** 取自真实会话的用例带 `session` 字段（会话编号的前 8 位）；同一个 `session` 的用例不能一部分在 `heldout`、一部分在 `fit` 或 `check`。`checkSet` 检查这一条。

**A3 门槛的网格按门槛定（清单 S35、S45、S51）。** `up`、`upHigh`、`down`、`yes`、`modelDown`：0.50 到 0.95；`no`：0.05 到 0.50；`skill.action`、`skill.fits`：0.10 到 0.60；`skill.named`：0.30 到 0.80；都每隔 0.05 取一个值。保守的一端：`no` 取最低的值，其余取最高的值。扫出来的 `yes` 减 `no` 小于 0.2 时两个都保留初值（中间那一段要留着）。

**A4 先发一个合成的小请求（清单 S61）。** `run.ts` 多一个命令 `smoke`：用一例模型写的用例构造一个请求发出去，核对 HTTP 状态、回答的 `model` 是 `drex-max-v1.1`、每道题的编号和类型都在、choice 的选项名对得上；不通过就以 1 退出。Task 9 的第一步先跑它，通过了才发调整集。

**A5 重复问的请求互不相同（清单 S58）。** 同一请求的第 1 遍照原样发（判分和扫门槛只用第 1 遍）；第 2、3 遍在 state 末尾加一个一次性的 `request_uid` 字段，免得路上的缓存把旧回答还回来。稳定与否按当时生效的门槛离线判，门槛变了就重判（清单 S54）。

**A6 参考答案要能只凭发出去的内容得出（清单 S7）。** 出题和审查多一项「human test」：只看发出去的 state 和题，一个聪明人能不能答出参考答案；理由里引的依据必须在 state 里。答题的 agent 仍然看得到真实 midrun 用例后来怎么走的，但只用来确认当时该怎么做；答案依赖 state 里没有的信息的用例要改写或换掉。

**A7 skill 的反例三种都要有（清单 S5）。** `expect.skill` 为 `null` 的用例里，标签 `everyday`（日常请求）、`uncovered`（没有 skill 管的技术问题）、`named-missing`（点名了候选里没有的东西）各不少于 1 例。`checkSet` 检查这一条。

**A8 改措辞时新旧两种写法放进同一请求（清单 S22）。** Task 10 Step 3 要改默认题的措辞时，把新写法作为另一道题（`controls.ts` 里加，编号如 `open_b`）和旧写法在同一请求里问同一个 state，比完再决定留哪一个。

**A9 打乱选项顺序在调整集上也做（清单 S56）。** skill 的 `stage-1-shuffled`、`stage-2-shuffled` 在调整集上也各问 1 遍。

**A10 题和门槛放在同一个模块（清单 S33）。** Task 13 把门槛的表放进 `hooks/questions.ts`，和题在一起；`hooks/decide.ts`、`hooks/skills.ts` 只留读法，从那里取门槛。记录里每张扫门槛的表带一列文字画的条（清单 S47）。

**A11 不改的地方，照实写进记录。** 每类 15 例是用户定的，处在 Nace 说的「tens」的下沿（清单 S20）；参考答案由同一个模型（Fable 5.2，xhigh）答两遍加裁定，不是几家不同的模型合标（清单 S12、S13）；每类用来取门槛的只有 6 例（清单 S48）。设计 3.4 节有三处要更正（用例数量 Nace 有说法；那句 "try a score question on a few samples" 的出处；拼错的模型名返回 422），Task 16 改。

**A12 并行（用户 2026-11-19 的要求：更快）。** Task 1 到 3 做完就开始出题，和 Task 4 到 6 同时进行；出题、审查用例、盲答各用 8 个并行的 agent（每类两个，一个出 01 到 08，一个出 09 到 15，各自的分组和配额由 controller 预先分好），裁定在不一致的用例多时最多 8 个；Task 4 和 5 合并派发；`ask` 最多同时发 4 个请求，发每个请求之前照样查预算；调整集的请求一次发完；验收的会话 2 个同时跑。

**A13 清单修订后仍只满足一部分的几条（Task 1 的报告）。**
- A2 加严：同一个 `session` 的用例必须全部在同一组里（`fit`、`check`、`heldout` 三者之一），不只是不跨留出集。
- R-recent 加门限：别的条数在调整集上比默认的 5 条多对至少 2 例才换，否则保持 5。
- 稳定性只判两次：扫门槛之前按初值判一次，不稳定的用例不参与扫；门槛取定之后按新门槛再判一次并报出来，不再重扫。
- `direct`（直接选档位）如果按 R-问法 胜出，采用之前先把它的选项打乱顺序在调整集上再问一遍：10 例里决定不变的不到 8 例就不采用。

**A14 没有用例约束的门槛保留初值。** 扫一个门槛时，如果对得最多的那一段盖住了整个网格（`fit` 里没有哪一例能把它卡住），这个门槛保留初值，不取「保守的一端」；记录里写明它没有依据。只有一侧被卡住时照 A3 取保守的一端。
