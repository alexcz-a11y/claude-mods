// Forced escalation (#7, ADR 0013): seam 1 (engine events in; what reaches the
// engine, the decision backend, the board data `w.board()` and the turn's
// record `w.turnRecord()` out). Since 2.1.312 an effort raised mid-turn does not
// go out, so a loop whose tool calls keep failing raises no effort and asks the
// decision model nothing: a dispatched agent goes on as the next model up, and
// the main agent's turn keeps its facts for the next message.

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { briefOf, errorLine, outcomeOf, rowsFromTranscript, stepUp, withError, type StepUpSettings, type TranscriptRow } from '../hooks/decision/escalation.ts'
import { agentJev, siteJev } from './support/workflow.ts'
import { runDir, runWorld } from './support/workflow-run.ts'
import { jev, KEY, kind, type Reply, type Sent, type ToolRun, type World, world } from './support/world.ts'

/** The escalation decisions the board keeps, oldest first. */
async function escalations(w: World) {
  return (await w.board()).log.filter((entry) => entry.feature === 'escalation')
}

const MEDIUM = [0, 1, 0, 0, 0]

const FAILS = { error: 'exit status 1' }
/** What Claude Code answers when the person refuses a call at the permission prompt. */
const REFUSED_AT_PROMPT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
/** A PreToolUse settings hook refusing the call. */
const BLOCKED = { blockedByHook: 'git push is blocked by policy' }

/** A step whose response makes these two calls, which end as `ends` says. */
const calls = (index: number, ends: NonNullable<ToolRun['ends']>) => ({
  index,
  tools: [
    { tool: 'Bash', input: { command: 'git push origin main', description: '推送到远端' }, ends },
    { tool: 'Bash', input: { command: 'git push origin dev', description: '推送 dev' }, ends },
  ],
})

/** A step whose response runs two commands that both fail. */
const failing = (index: number) => ({
  index,
  answer: `第 ${index} 步：跑测试。`,
  tools: [
    { tool: 'Bash', input: { command: 'pnpm test auth', description: '跑 auth 的测试' }, ends: FAILS },
    { tool: 'Bash', input: { command: 'pnpm test api', description: '跑 api 的测试' }, ends: FAILS },
  ],
})

const failingOnce = (index: number) => ({ index, tools: [{ tool: 'Bash', input: { command: 'pnpm test auth', description: '跑 auth 的测试' }, ends: FAILS }] })

// The main agent.

test("the main agent's failed calls ask nothing and raise nothing: every step of the turn goes out at the level its message was decided at", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step(failing(0))
  await w.step(failing(1))
  await w.step({ index: 2 })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium'])
  expect(await escalations(w)).toEqual([])
  // The node still shows the turn's failures.
  expect((await w.board()).main?.counts).toEqual({ failed: 4, blocked: 0, raised: 0 })
})

test("as a turn the person's message started ends, its facts go on its record: the effort it went out at, its calls, failures and hook blocks, whether the failures reached escalateAfter, the last two error lines", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, tools: [{ tool: 'Read', input: { file_path: '/repo/src/auth/index.ts' } }] })
  await w.step(failing(1))
  await w.step({ index: 2, tools: [{ tool: 'Bash', input: { command: 'pnpm lint', description: '跑 lint' }, ends: { error: 'Exit code 1\n\nsrc/auth/login.ts:12:3  error  no-unused-vars' } }] })
  await w.step(calls(3, BLOCKED))
  await w.step({ index: 4 })
  expect(w.turnRecord('t1')?.facts).toBeUndefined()
  await w.complete()

  expect(w.turnRecord('t1')).toMatchObject({ person: true, effort: 'medium' })
  expect(w.turnRecord('t1')?.facts).toEqual({
    effort: 'medium',
    calls: 6,
    failed: 3,
    blocked: 2,
    stuck: true,
    // The line that says what went wrong, not the exit code; a hook's refusal by its reason; oldest first.
    errors: ['Bash: git push is blocked by policy', 'Bash: git push is blocked by policy'],
  })
})

test('the error lines are the last two failed or blocked calls, each the tool and the first line that says what went wrong', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1, tools: [{ tool: 'Bash', input: { command: 'pnpm lint', description: '跑 lint' }, ends: { error: 'Exit code 1\n\nsrc/auth/login.ts:12:3  error  no-unused-vars' } }] })
  await w.step({ index: 2 })
  await w.complete()

  expect(w.turnRecord('t1')?.facts?.errors).toEqual(['Bash: exit status 1', 'Bash: src/auth/login.ts:12:3  error  no-unused-vars'])
})

test('a turn whose failures stay under escalateAfter is not stuck; escalateAfter sets the bar', { options: { ...KEY, escalateAfter: 3 } }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 })
  await w.complete()
  expect(w.turnRecord('t1')?.facts).toMatchObject({ calls: 2, failed: 2, stuck: false })

  await w.submit('再试一次')
  await w.step(failing(0))
  await w.step(failingOnce(1))
  await w.step({ index: 2 })
  await w.complete()
  expect(w.turnRecord('t2')?.facts).toMatchObject({ calls: 3, failed: 3, stuck: true })
})

test('a call the person refused is no failure, a hook block only counts toward the bar with hook-block-failures on, a plugin\'s own refusal is no call at all', { options: KEY }, async ($, on) => {
  on('tool.call', { tool: /^Handback$/ }, () => ({ deny: 'Workflow sent back with a recommendation for each agent' }))
  const w = world($, on, { backend: jev(MEDIUM), store: {}, session: true })
  await w.start()
  expect(await w.command('dp', 'status')).toContain('关  hook-block-failures')
  await w.submit('把 main 分支推上去')
  await w.step(calls(0, { error: REFUSED_AT_PROMPT }))
  await w.step(calls(1, BLOCKED))
  await w.step({ index: 2, tools: [{ tool: 'Handback', input: {} }] })
  await w.complete()
  expect(w.turnRecord('t1')?.facts).toMatchObject({ calls: 4, failed: 0, blocked: 2, stuck: false })

  expect(await w.command('dp', 'hook-block-failures on')).toContain('hook-block-failures 已打开')
  await w.submit('再推一次')
  await w.step(calls(0, BLOCKED))
  await w.step({ index: 1 })
  await w.complete()
  expect(w.turnRecord('t2')?.facts).toMatchObject({ calls: 2, failed: 0, blocked: 2, stuck: true })
})

test("the effort a turn's facts keep is the one its steps went out at: the person's lock, or the engine's own when nothing was decided", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 2 ? { status: 503, body: 'overloaded' } : jev(MEDIUM)(request)), store: {}, session: true })
  await w.start()
  await w.command('dp', 'lock low')
  await w.submit('把登录模块重构成三层')
  await w.step({ ...failing(0), effort: 'high' })
  await w.complete()
  expect(w.turnRecord('t1')?.facts?.effort).toBe('low')

  await w.command('dp', 'unlock')
  await w.submit('再看看另一个模块')
  await w.step({ index: 0, effort: 'high' })
  await w.complete()
  // Its decision request failed: the turn went out at the engine's own high.
  expect(w.turnRecord('t2')?.facts?.effort).toBe('high')
})

test("a turn the person's own message did not start keeps no facts", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), store: {}, session: true })
  await w.start()
  // With main-effort off no decision waits for the turn: nothing says the person's message started it.
  await w.command('dp', 'main-effort off')
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.complete()

  expect(w.turnRecord('t1')).toMatchObject({ person: false })
  expect(w.turnRecord('t1')?.facts).toBeUndefined()
})

test('a new turn starts the counts afresh: its facts are its own, its node has no counts until it fails', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.complete()
  await w.submit('再看看另一个模块')
  await w.step({ index: 0 })
  expect((await w.board()).main).toMatchObject({ turn: 2 })
  expect((await w.board()).main?.counts).toBeUndefined()
  await w.step(failingOnce(1))
  await w.complete()

  expect(w.turnRecord('t1')?.facts).toMatchObject({ calls: 2, failed: 2, stuck: true })
  expect(w.turnRecord('t2')?.facts).toMatchObject({ calls: 1, failed: 1, stuck: false, errors: ['Bash: exit status 1'] })
})

test('/dp off stops the counting; the facts keep what was counted while it was on', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), store: {}, session: true })
  await w.start()
  await w.submit('把登录模块重构成三层')
  await w.step(failingOnce(0))
  await w.command('dp', 'off')
  await w.step(failing(1))
  await w.command('dp', 'on')
  await w.step({ index: 2 })
  await w.complete()

  expect(w.turnRecord('t1')?.facts).toMatchObject({ calls: 1, failed: 1 })
})

// Dispatched agents.

type Spawn = {
  /** The model question's probability for each option. */
  model: Record<string, number>
  /** The effort levels' probabilities, lowest first. */
  effort?: readonly number[]
  /** Each yes/no question's answer by its id within the part (`named.haiku`, `banned.opus`). */
  nouls?: Record<string, number>
}

/** Jev answering an agent's decision at spawn with `spawn`, anything else (a message) medium. */
function withAgents(spawn: Spawn) {
  return (request: Sent): Reply => ('agent.effort' in (request.body?.questions ?? {}) ? agentJev(spawn, MEDIUM)(request) : jev(MEDIUM)(request))
}

/** The transcript of an agent whose two calls failed: its task, one step, the two results. */
const agentRows: SessionMessage[] = [
  { role: 'user', text: 'Make the failing auth tests pass: run `pnpm test auth`, find what breaks and fix it.', toolUses: [] },
  { role: 'assistant', text: "I'll run the tests first.", toolUses: [] },
]

/** One step of a dispatched agent's loop (the engine's own model and effort on it). */
const agentStep = (agentId: string, index: number, more: { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null; tools?: ToolRun[] } = {}) => ({
  index,
  turnId: 'sub-1',
  agentId,
  model: more.model ?? 'claude-sonnet-5-5',
  effort: more.effort === undefined ? 'high' : more.effort,
  ...(more.tools === undefined ? {} : { tools: more.tools }),
})

const agentFailing: ToolRun[] = [
  { tool: 'Bash', input: { command: 'pnpm test auth', description: 'Run the auth tests' }, ends: FAILS },
  { tool: 'Bash', input: { command: 'pnpm test auth --bail', description: 'Run the auth tests, bail out' }, ends: FAILS },
]

test('a dispatched agent whose calls reach escalateAfter goes on as the next model up from its next step: nothing is asked, its effort is left as it was', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: MEDIUM }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { tools: agentFailing }))
  await w.step(agentStep(agentId, 1))
  await w.step(agentStep(agentId, 2))

  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-sonnet-5-5 medium', 'claude-opus-5-5 medium', 'claude-opus-5-5 medium'])
  // The one request is the agent's decision at its spawn.
  expect(w.requests).toHaveLength(1)
  const [stepped] = await escalations(w)
  expect(stepped).toMatchObject({
    agent: agentId,
    tone: 'warn',
    outcome: 'model claude-opus-5-5（原 claude-sonnet-5-5）',
    subject: 'agent "Make the failing auth tests pass: run `p..."，第 0 步，工具调用失败 2 次',
    forced: { kind: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' },
    counts: { failed: 2, blocked: 0, raised: 1 },
  })
  expect(stepped?.reason).toContain('工具调用失败 2 次（门槛 2），从它的下一步起改用 claude-opus-5-5')
  const board = await w.board()
  expect(board.agents.find((node) => node.id === agentId)?.counts).toEqual({ failed: 2, blocked: 0, raised: 1 })
  expect(board.main?.counts).toBeUndefined()
})

/** A Haiku 5.5 agent's step. */
const HAIKU = { model: 'claude-haiku-5-5', effort: 'medium' as const }

test('a haiku agent goes on as escalateHaikuTo (sonnet unless set), then as opus; at most escalateLimit step-ups a run, the failures counted afresh after each', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { haiku: 1 }, effort: MEDIUM }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Find the auth failures', subagentType: 'Explore' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { ...HAIKU, tools: agentFailing }))
  await w.step(agentStep(agentId, 1, { ...HAIKU, tools: [agentFailing[0] as ToolRun] }))
  await w.step(agentStep(agentId, 2, { ...HAIKU, tools: [agentFailing[0] as ToolRun] }))
  await w.step(agentStep(agentId, 3, { ...HAIKU, tools: agentFailing }))
  await w.step(agentStep(agentId, 4, HAIKU))

  // Step 0's two failures: sonnet. One more is not enough; the second one since: opus. The third pair: the limit (2) is reached.
  expect(w.steps.map((s) => s.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
  expect((await escalations(w)).map((entry) => entry.forced)).toEqual([
    { kind: 'model', from: 'claude-haiku-5-5', to: 'claude-sonnet-5-5' },
    { kind: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' },
  ])
})

for (const [written, sent] of [
  ['claude-sonnet-9-9', 'claude-sonnet-9-9'],
  ['opus', 'claude-opus-5-5'],
  ['Sonnet', 'claude-sonnet-5-5'],
] as const) {
  test(`escalateHaikuTo ${JSON.stringify(written)}: a failing haiku agent goes on as ${sent} (an alias becomes the id a step must name: the engine takes no alias there)`, { options: { ...KEY, escalateHaikuTo: written } }, async ($, on) => {
    const w = world($, on, { backend: withAgents({ model: { haiku: 1 }, effort: MEDIUM }), messages: agentRows })
    const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Find the auth failures' })) as { agentId: string }
    await w.step(agentStep(agentId, 0, { ...HAIKU, tools: agentFailing }))
    await w.step(agentStep(agentId, 1, HAIKU))

    expect(w.steps.map((s) => s.model)).toEqual(['claude-haiku-5-5', sent])
  })
}

test('an escalateHaikuTo that names no model the mod knows switches nothing, and the log says why; the failures are written off', { options: { ...KEY, escalateHaikuTo: 'gpt-5' } }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { haiku: 1 }, effort: MEDIUM }), messages: agentRows, store: {}, session: true })
  await w.start()
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Find the auth failures' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { ...HAIKU, tools: agentFailing }))
  await w.step(agentStep(agentId, 1, HAIKU))

  expect(w.steps.map((s) => s.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
  const [kept] = await escalations(w)
  expect(kept).toMatchObject({ tone: 'info', outcome: 'model claude-haiku-5-5（保持）', counts: { failed: 2, blocked: 0, raised: 0 } })
  expect(kept?.forced).toBeUndefined()
  const log = (await w.command('dp', 'log 10')).split('\n').filter((line) => line.includes(' escalation：'))
  expect(log[0]).toContain('没有升模型：设置的改用模型 "gpt-5" 这个 mod 不认识')
})

test('an opus agent stays on opus while agentFable is off, and the log says why', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { opus: 1 }, effort: MEDIUM }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { model: 'claude-opus-5-5', tools: agentFailing }))
  await w.step(agentStep(agentId, 1, { model: 'claude-opus-5-5' }))

  expect(w.steps.map((s) => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect((await escalations(w))[0]?.reason).toContain('没有升模型：已经是 opus（fable 要打开 agentFable）')
})

test('with agentFable on, an opus agent whose calls keep failing goes on as fable', { options: { ...KEY, agentFable: true } }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { opus: 1 }, effort: MEDIUM }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { model: 'claude-opus-5-5', tools: agentFailing }))
  await w.step(agentStep(agentId, 1, { model: 'claude-opus-5-5' }))

  expect(w.steps.map((s) => s.model)).toEqual(['claude-opus-5-5', 'claude-fable-5-1'])
})

test('a model the person named for the work is never changed, however its calls fail', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { haiku: 0.02, sonnet: 0.03, opus: 0.95 }, effort: MEDIUM, nouls: { 'named.haiku': 0.93 } }), messages: agentRows })
  await w.submit('给 utils/date.ts 补几个边界情况的单测，用 haiku 跑就行，省点额度')
  await w.step({ index: 0 })
  const { agentId } = (await w.spawn({ prompt: '为 src/utils/date.ts 写 vitest 单测。', description: '补 date 工具单测' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { ...HAIKU, tools: agentFailing }))
  await w.step(agentStep(agentId, 1, HAIKU))

  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
  expect(w.steps.filter((s) => s.agentId === agentId).map((s) => s.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
  expect((await escalations(w))[0]?.reason).toContain('没有升模型：haiku 是你给它点名的模型')
})

test('a model the person ruled out is passed over for the next one up', { options: { ...KEY, agentFable: true } }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: MEDIUM, nouls: { 'banned.opus': 0.92 } }), messages: agentRows })
  await w.submit('这周额度快用完了，派 agent 的时候别用 opus。帮我修一下登录的测试')
  await w.step({ index: 0 })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { tools: agentFailing }))
  await w.step(agentStep(agentId, 1))

  expect(w.steps.filter((s) => s.agentId === agentId).map((s) => s.model)).toEqual(['claude-sonnet-5-5', 'claude-fable-5-1'])
})

test("an agent's calls the person refused are no failures; a hook's blocks count with hook-block-failures on", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: MEDIUM }), messages: agentRows, store: {}, session: true })
  await w.start()
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  const twice = (ends: NonNullable<ToolRun['ends']>): ToolRun[] => [
    { tool: 'Bash', input: { command: 'git push', description: 'Push' }, ends },
    { tool: 'Bash', input: { command: 'git push -f', description: 'Push again' }, ends },
  ]
  await w.step(agentStep(agentId, 0, { tools: twice({ error: REFUSED_AT_PROMPT }) }))
  await w.step(agentStep(agentId, 1, { tools: twice(BLOCKED) }))
  await w.step(agentStep(agentId, 2))
  expect(w.steps.map((s) => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])

  await w.command('dp', 'hook-block-failures on')
  await w.step(agentStep(agentId, 3, { tools: twice(BLOCKED) }))
  await w.step(agentStep(agentId, 4))
  expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
})

test('/dp escalation off: an agent stays on its model, and what failed meanwhile is written off once it is back on', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: MEDIUM }), messages: agentRows, store: {}, session: true })
  await w.start()
  expect(await w.command('dp', 'escalation off')).toContain('escalation 已关闭')
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { tools: agentFailing }))
  await w.step(agentStep(agentId, 1))
  await w.command('dp', 'escalation on')
  await w.step(agentStep(agentId, 2, { tools: [agentFailing[0] as ToolRun] })) // counted from here on: one
  await w.step(agentStep(agentId, 3, { tools: [agentFailing[0] as ToolRun] })) // two
  await w.step(agentStep(agentId, 4))

  expect(w.steps.map((s) => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
})

/** The engine keeps a workflow agent's transcript from the mod: `$.session.messages` refuses its id. */
const refusing = (agentId: string) => (asked: { agentId?: string }) => (asked.agentId === undefined ? [] : { deny: `${agentId} is not one of this session's agents` })

/** A workflow agent's transcript file as the engine writes it (2.1.289): its framed task, then each step's blocks and each call's result. */
function agentTranscript(task: string, steps: { text: string; calls: { id: string; command: string; description: string; error?: string }[] }[]): string {
  const frame = "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n"
  const rows: unknown[] = [{ type: 'user', message: { role: 'user', content: `${frame}${task.split('\n').map((line) => `  ${line}`).join('\n')}` } }, { type: 'attachment', attachment: { type: 'environment' } }]
  for (const step of steps) {
    rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } })
    rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.text }] } })
    for (const call of step.calls) rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: 'Bash', input: { command: call.command, description: call.description } }] } })
    for (const call of step.calls) rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: call.error ?? 'ok', ...(call.error === undefined ? {} : { is_error: true }) }] } })
  }
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

const SCRIPT = `export const meta = { name: 'fix', description: 'Fix the flaky checkout test', phases: [] }
const fixed = await agent('Find why checkout.spec.ts times out intermittently and fix the cause.', { label: 'fix' })
return fixed
`

test("a workflow agent whose calls keep failing goes on as the next model up; the decision names its task, read from its transcript on disk", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, {
    messages: refusing('wa1'),
    disk: { '/work/fix.js': SCRIPT },
    backend: siteJev(() => ({ model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] })),
  })
  await w.workflow({ scriptPath: '/work/fix.js' })
  await w.started('wf_test-1', 'wa1', 'fix')
  w.disk[`${runDir('wf_test-1')}/agent-wa1.jsonl`] = agentTranscript('Find why checkout.spec.ts times out intermittently and fix the cause.', [
    { text: 'Running the checkout tests first.', calls: [{ id: 'toolu_1', command: 'npx playwright test checkout', description: 'Run the checkout tests', error: 'Timeout of 30000ms exceeded' }] },
  ])
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium', tools: agentFailing })
  await w.agentStep('wa1', { index: 1, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-sonnet-5-5 medium', 'claude-opus-5-5 medium'])
  expect(w.requests.map(kind).filter((asked) => asked.includes('escalation'))).toEqual([])
  expect((await escalations(w))[0]).toMatchObject({ agent: 'wa1', subject: 'agent "Find why checkout.spec.ts times out inte..."，第 0 步，工具调用失败 2 次', forced: { kind: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' } })
})

test("with workflow-labels switched off a workflow agent still steps up, and its run's directory is still noted for its transcript", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { messages: refusing('wa1'), disk: { '/work/fix.js': SCRIPT }, backend: jev(MEDIUM) })
  await w.command('dp', 'workflow-labels off')
  await w.workflow({ scriptPath: '/work/fix.js' })
  await w.started('wf_test-1', 'wa1', 'fix')
  w.disk[`${runDir('wf_test-1')}/agent-wa1.jsonl`] = agentTranscript('Find why checkout.spec.ts times out intermittently and fix the cause.', [])
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium', tools: agentFailing })
  await w.agentStep('wa1', { index: 1, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  expect((await escalations(w))[0]?.subject).toBe('agent "Find why checkout.spec.ts times out inte..."，第 0 步，工具调用失败 2 次')
})

// The decision module: where a failing agent goes, how a call ended, the error lines, an agent's transcript.

const SETTINGS: StepUpSettings = { haikuTo: { family: 'sonnet', id: 'claude-sonnet-5-5' }, haikuToWritten: 'sonnet', models: ['haiku', 'sonnet', 'opus'] }
const NO_TERMS = null

test('stepUp: haiku to escalateHaikuTo, sonnet to opus, opus to fable only among the models agents may run on; none past the top, or for a model of no family', () => {
  expect(stepUp('claude-haiku-5-5', SETTINGS, NO_TERMS)).toEqual({ to: { family: 'sonnet', id: 'claude-sonnet-5-5' }, note: '' })
  expect(stepUp('claude-sonnet-5-5', SETTINGS, NO_TERMS)).toEqual({ to: { family: 'opus', id: 'claude-opus-5-5' }, note: '' })
  expect(stepUp('claude-opus-5-5', SETTINGS, NO_TERMS)).toEqual({ why: '已经是 opus（fable 要打开 agentFable）' })
  expect(stepUp('claude-opus-5-5', { ...SETTINGS, models: ['haiku', 'sonnet', 'opus', 'fable'] }, NO_TERMS)).toEqual({ to: { family: 'fable', id: 'claude-fable-5-1' }, note: '' })
  expect(stepUp('claude-fable-5-1', { ...SETTINGS, models: ['haiku', 'sonnet', 'opus', 'fable'] }, NO_TERMS)).toEqual({ why: '已经是最高一档的 fable' })
  expect(stepUp('gpt-5', SETTINGS, NO_TERMS)).toEqual({ why: 'gpt-5 不属于 haiku、sonnet、opus、fable，不知道往哪升' })
  expect(stepUp('', SETTINGS, NO_TERMS)).toEqual({ why: '它的模型 不属于 haiku、sonnet、opus、fable，不知道往哪升' })
})

test("stepUp keeps to the person's terms: a named model stays, a ruled-out one is passed over (for haiku's escalateHaikuTo too), and none is left when all up are ruled out", () => {
  expect(stepUp('claude-sonnet-5-5', SETTINGS, { model: 'sonnet', effort: null, banned: [] })).toEqual({ why: 'sonnet 是你给它点名的模型' })
  expect(stepUp('claude-haiku-5-5', SETTINGS, { model: null, effort: null, banned: ['sonnet'] })).toEqual({ to: { family: 'opus', id: 'claude-opus-5-5' }, note: '（sonnet 被你排除了）' })
  expect(stepUp('claude-haiku-5-5', SETTINGS, { model: null, effort: null, banned: ['sonnet', 'opus'] })).toEqual({ why: 'haiku 以上的模型都被你排除了（sonnet、opus）' })
  expect(stepUp('claude-sonnet-5-5', SETTINGS, { model: null, effort: null, banned: ['opus'] })).toEqual({ why: 'sonnet 以上的模型都被你排除了（opus）' })
  expect(stepUp('claude-haiku-5-5', { ...SETTINGS, haikuTo: null, haikuToWritten: '' }, NO_TERMS)).toEqual({ why: '没有设置失败的 haiku 改用哪个模型' })
})

test('the error line: the tool and the first line that says what went wrong (an exit code alone does not), secrets masked, cut short; the last two kept', () => {
  expect(errorLine('Bash', 'Exit code 1\n\nnpm ERR! missing script: test')).toBe('Bash: npm ERR! missing script: test')
  expect(errorLine('Bash', '')).toBe('Bash')
  expect(errorLine('Read', undefined)).toBe('Read')
  expect(errorLine('Bash', 'curl failed: Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
  expect(errorLine('Bash', 'x'.repeat(2000)).length).toBeLessThan(400)
  expect(withError(withError(withError([], 'a'), 'b'), 'c')).toEqual(['b', 'c'])
})

test("a call's outcome: blocked when a hook refused it, denied when the person did (by the engine's own words, never for an MCP tool), failed for any other error, else ok", () => {
  const refused = "The user doesn't want to proceed with this tool use. The tool use was rejected."
  expect(outcomeOf('Bash', { text: 'ok' }, false)).toBe('ok')
  expect(outcomeOf('Bash', { isError: true, text: 'exit 1' }, false)).toBe('failed')
  expect(outcomeOf('Bash', { isError: true, text: 'blocked by policy' }, true)).toBe('blocked')
  expect(outcomeOf('Bash', { deny: 'refused by a plugin' }, false)).toBe('blocked')
  expect(outcomeOf('Edit', { isError: true, text: refused }, false)).toBe('denied')
  expect(outcomeOf('Write', { isError: true, text: 'Permission to use Write has been denied.' }, false)).toBe('denied')
  expect(outcomeOf('mcp__github__create_pr', { isError: true, text: refused }, false)).toBe('failed')
})

const REMINDER = '<system-reminder>The task tools have not been used recently.</system-reminder>'

test("an agent's transcript file reads as the session's rows: its task unframed (a relayed request of the person, as earlier engines write first, left out), each step's text and calls, and how each call ended", () => {
  const relayed = { type: 'user', message: { role: 'user', content: '[Workflow harness — user request] The harness relays, verbatim and indented below, the user request.\n  fix checkout' } }
  const transcript = [
    JSON.stringify(relayed),
    agentTranscript('Find why checkout.spec.ts times out.\nFix the cause.', [
      { text: 'Running it first.', calls: [{ id: 'toolu_1', command: 'npx playwright test checkout', description: 'Run the checkout test', error: 'Timeout of 30000ms exceeded' }] },
      { text: 'Reading the spec.', calls: [{ id: 'toolu_2', command: 'cat checkout.spec.ts', description: 'Read the spec' }] },
    ]),
  ].join('\n')
  const rows = rowsFromTranscript(transcript)

  expect(briefOf(rows)).toBe('Find why checkout.spec.ts times out.\nFix the cause.')
  expect(rows.filter((row) => row.role === 'assistant' && (row.toolUses?.length ?? 0) > 0).map((row) => row.toolUses?.map((use) => [use.tool_use_id, use.isError === true]))).toEqual([[['toolu_1', true]], [['toolu_2', false]]])
})

test('a user row that only holds a system reminder is not something the person said: the task is what was said', () => {
  const rows: TranscriptRow[] = [
    { role: 'user', text: REMINDER, toolUses: [] },
    { role: 'user', text: '修一下登录', toolUses: [] },
    { role: 'assistant', text: '先跑测试。', toolUses: [] },
  ]

  expect(briefOf(rows)).toBe('修一下登录')
})
