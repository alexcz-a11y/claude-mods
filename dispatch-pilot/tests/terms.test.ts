// The person's own terms for an agent's work (点名、排除: the model and the
// effort they named, the models they ruled out), kept in the agent's plan:
// whatever changes the agent's model or effort later keeps to them, the forced
// raise (#7) included, and they win over a model or effort a Workflow script
// works out when it runs. Seam 1: the person's message and the agents' spawns
// and steps in; what each step reaches the engine with, the requests, the
// decision log out.

import { expect, test } from 'claude-code/testing'
import { siteJev, type SiteAnswer } from './support/workflow.ts'
import { runWorld } from './support/workflow-run.ts'
import { world, type Reply, type Sent, type ToolRun } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
/** No periodic mid-turn re-decisions: the only requests are the message's, the spawn's and a stuck agent's. */
const ONLY = { ...KEY, rejudgeEvery: 0 }

type AgentAnswers = {
  /** The model question's probability for each option (an option left out gets 0). */
  model?: Record<string, number>
  /** The effort levels' probabilities, lowest first. */
  effort?: readonly number[]
  /** Each yes/no question's answer by its id within the part (`named.haiku`); the rest get 0. */
  nouls?: Record<string, number>
  /** The named-effort question's probability for each option (`none`, `low` .. `max`); without it the answer is `none`. */
  namedEffort?: Record<string, number>
}

/** Jev answering the agent's request at spawn with `spawn`; anything else (the message, a stuck agent: not expected) as plainly. */
function agentJev(spawn: AgentAnswers) {
  return (request: Sent): Reply => {
    const out: Record<string, unknown> = {}
    const questions = (request.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>
    const atSpawn = 'agent.model' in questions
    for (const [id, question] of Object.entries(questions)) {
      const local = id.slice(id.indexOf('.') + 1)
      const answers = atSpawn ? spawn : {}
      if (question.type === 'choice') {
        const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
        const given = local === 'named_effort' ? (answers.namedEffort ?? { none: 1 }) : answers.model
        const probabilities = Object.fromEntries(options.map((option) => [option, given?.[option] ?? 0]))
        const choice = options.reduce((best, option) => ((probabilities[option] ?? 0) > (probabilities[best] ?? 0) ? option : best), options[0] ?? '')
        out[id] = { type: 'choice', choice, probabilities, confidence: 0.5 }
      } else if (question.type === 'score') {
        const levels = answers.effort ?? [0, 1, 0, 0, 0]
        out[id] = { type: 'score', score: 1, legend: {}, probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: 0.7 }
      } else {
        out[id] = { type: 'noul', noul: answers.nouls?.[local] ?? 0 }
      }
    }
    return { status: 200, body: { model: 'jev-1.13.0', answers: out, usage: { input_tokens: 400, output_tokens: 0 } } }
  }
}

const FAILS = { error: 'exit status 1' }
/** Two calls of an agent's step that both fail. */
const failing: ToolRun[] = [
  { tool: 'Bash', input: { command: 'pnpm test auth', description: 'Run the auth tests' }, ends: FAILS },
  { tool: 'Bash', input: { command: 'pnpm test auth --bail', description: 'Run the auth tests, bail out' }, ends: FAILS },
]

/** One step of a dispatched agent's loop, on the model the engine started it on. */
const agentStep = (agentId: string, index: number, model: string, effort: 'low' | 'medium' | 'high' | null, tools?: ToolRun[]) => ({
  index,
  turnId: 'sub-1',
  agentId,
  model,
  effort,
  ...(tools === undefined ? {} : { tools }),
})

const HAIKU = 'claude-haiku-4-5-20251001'

/** The decision log's escalation lines, as /dp log shows them. */
async function escalations(w: ReturnType<typeof world>): Promise<string[]> {
  return (await w.command('dp', 'log')).split('\n').filter((line) => line.includes(' escalation: '))
}

test('a haiku the person named for an agent stays its model however its calls fail: it is not switched to sonnet, and the log says why', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9, sonnet: 0.1 }, nouls: { 'named.haiku': 0.9 } }), store: {}, session: true })
  await w.start()
  await w.submit('用 haiku 查一下哪些文件引用了 legacyAuth，别改代码')
  const { agentId } = (await w.spawn({ prompt: 'List every file under src/ that imports legacyAuth.', description: 'Find legacyAuth' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, HAIKU, null, failing))
  await w.step(agentStep(agentId, 1, HAIKU, null))

  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
  expect(w.steps.map((s) => s.model)).toEqual([HAIKU, HAIKU])
  // Nothing to force: nothing is asked.
  expect(w.requests.filter((r) => 'escalation.expected' in r.body.questions)).toHaveLength(0)
  const log = await escalations(w)
  expect(log).toHaveLength(1)
  expect(log[0]).toContain(`model ${HAIKU} (kept) for agent`)
  expect(log[0]).toContain('haiku is the model you named for it')
})

test('a model the person ruled out is never the one a failing haiku agent is switched to: it goes on as the next model up that is not ruled out', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9, sonnet: 0.1 }, nouls: { 'banned.sonnet': 0.9 } }), store: {}, session: true })
  await w.start()
  await w.submit('别用 sonnet，太贵了。派个 agent 去查 auth 的测试为什么挂')
  const { agentId } = (await w.spawn({ prompt: 'Find out why the auth tests fail. Report the cause only.', description: 'Why auth fails' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, HAIKU, null, failing))
  await w.step(agentStep(agentId, 1, HAIKU, null))

  expect(w.steps.map((s) => s.model)).toEqual([HAIKU, 'claude-opus-5-5'])
  const log = await escalations(w)
  expect(log[0]).toContain(`model claude-opus-5-5 (was ${HAIKU})`)
  expect(log[0]).toContain('sonnet is ruled out for it')
})

test('when the person ruled out every model above haiku that agents may run on, the failing haiku agent stays on haiku, and the log says why', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9 }, nouls: { 'banned.sonnet': 0.9, 'banned.opus': 0.9 } }), store: {}, session: true })
  await w.start()
  await w.submit('sonnet 和 opus 都别用，额度不够了。派个 agent 查一下 auth 的测试')
  const { agentId } = (await w.spawn({ prompt: 'Find out why the auth tests fail.', description: 'Why auth fails' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, HAIKU, null, failing))
  await w.step(agentStep(agentId, 1, HAIKU, null))

  expect(w.steps.map((s) => s.model)).toEqual([HAIKU, HAIKU])
  const log = await escalations(w)
  expect(log[0]).toContain(`model ${HAIKU} (kept)`)
  expect(log[0]).toContain('every model above haiku is ruled out for it (sonnet, opus)')
})

test('an effort the person named for an agent is not raised when its calls keep failing', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { sonnet: 0.9 }, effort: [0, 0, 1, 0, 0], namedEffort: { none: 0, low: 1 } }), store: {}, session: true })
  await w.start()
  await w.submit('派个 agent 把 auth 的测试修好，effort 开 low 就行')
  const { agentId } = (await w.spawn({ prompt: 'Make the failing auth tests pass.', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, 'claude-sonnet-5-5', 'medium', failing))
  await w.step(agentStep(agentId, 1, 'claude-sonnet-5-5', 'medium'))
  await w.step(agentStep(agentId, 2, 'claude-sonnet-5-5', 'medium'))

  expect(w.steps.map((s) => String(s.effort))).toEqual(['low', 'low', 'low'])
  expect(w.requests.filter((r) => 'escalation.expected' in r.body.questions)).toHaveLength(0)
  const log = await escalations(w)
  expect(log[0]).toContain('effort low (kept)')
  expect(log[0]).toContain('low is the effort you named for it')
})

// A Workflow's agents: the label fallback (#9) plans them as they start, the
// forced raise (#7) goes by the model the plan put them on, not the one the
// engine names for the step.

/** A script the main agent saved earlier and runs again by its path. */
const SAVED = '/work/.claude/workflow-scripts/fix.js'

/** The engine keeps a workflow agent's transcript from the mod (`$.session.messages` refuses its id): world's `messages`. */
const NO_TRANSCRIPTS = { messages: (asked: { agentId?: string }) => (asked.agentId === undefined ? [] : { deny: "not one of this session's agents" }) }

/** One step of a workflow agent, on the model and effort the engine resolved for it. */
const workflowStep = (index: number, model: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | null, tools?: ToolRun[]) => ({ index, model, effort, ...(tools === undefined ? {} : { tools }) })

/** The decisions about a script's one call: `call` answers it (part agent-0); the stuck agent's request is answered as not expected. */
const oneCall = (call: SiteAnswer) => siteJev((i) => (i === 0 ? call : {}))

test('a workflow agent the label fallback sent to haiku is switched to sonnet when its calls keep failing: by the model the plan put it on, not the one the engine named', { options: ONLY }, async ($, on) => {
  const script = `export const meta = { name: 'scan', description: 'List what imports legacyAuth', phases: [] }
const found = await agent('List every file under src/ that imports legacyAuth. Report file:line only.', { label: 'scan' })
return found
`
  const w = runWorld($, on, { ...NO_TRANSCRIPTS, disk: { [SAVED]: script }, backend: oneCall({ model: { haiku: 0.9 } }) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'scan')
  await w.agentStep('wa1', workflowStep(0, 'claude-opus-5-5', 'xhigh', failing))
  await w.agentStep('wa1', workflowStep(1, 'claude-opus-5-5', 'xhigh'))

  // On haiku, no effort; switched to sonnet, the engine's own effort again.
  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-haiku-4-5 undefined', 'claude-sonnet-5-5 xhigh'])
})

test('a workflow agent the label fallback moved off haiku onto opus goes out at its planned effort, and is raised a level when its calls keep failing', { options: ONLY }, async ($, on) => {
  const script = `export const meta = { name: 'fix', description: 'Fix the flaky checkout test', phases: [] }
const fixed = await agent('Find why checkout.spec.ts times out intermittently and fix the cause; no retries.', { model: 'haiku', label: 'fix' })
return fixed
`
  const w = runWorld($, on, { ...NO_TRANSCRIPTS, disk: { [SAVED]: script }, backend: oneCall({ model: { opus: 0.9 }, effort: [0, 0, 1, 0, 0] }) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'fix')
  // The engine resolved the script's haiku: no effort on the step.
  await w.agentStep('wa1', workflowStep(0, 'claude-haiku-4-5', null, failing))
  await w.agentStep('wa1', workflowStep(1, 'claude-haiku-4-5', null))

  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-opus-5-5 high', 'claude-opus-5-5 xhigh'])
})

test('a model the person named for a call whose model the script works out when it runs is still the model its agents run on', { options: ONLY }, async ($, on) => {
  const script = `export const meta = { name: 'refactor', description: 'Refactor the retry logic', phases: [] }
const done = await agent('Refactor the retry logic in src/net across the three clients.', { model: pickModel(), label: 'refactor' })
return done
`
  const w = runWorld($, on, { disk: { [SAVED]: script }, backend: oneCall({ model: { sonnet: 0.9 }, effort: [0, 0, 1, 0, 0], nouls: { 'named.opus': 0.9 } }) })
  await w.submit('用 opus 把 src/net 的重试逻辑重构一下')
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'refactor')
  await w.agentStep('wa1', workflowStep(0, 'claude-sonnet-5-5', 'medium'))

  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-opus-5-5 high'])
})

test('a model the person ruled out is not left to a script that works out its model when it runs: the decided model is written in its place', { options: ONLY }, async ($, on) => {
  const script = `export const meta = { name: 'refactor', description: 'Refactor the retry logic', phases: [] }
const done = await agent('Refactor the retry logic in src/net across the three clients.', { model: pickModel(), label: 'refactor' })
return done
`
  const w = runWorld($, on, { backend: oneCall({ model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0], nouls: { 'banned.opus': 0.9 } }) })
  await w.submit('别用 opus，太贵。把 src/net 的重试逻辑重构一下')
  await w.workflow({ script })

  expect(w.reached[0]?.script).toContain("{ model: 'sonnet', label: 'refactor', effort: 'high' }")
})

test("a haiku the person named for a call of a script the main agent sent stays that agent's model however its calls fail", { options: ONLY }, async ($, on) => {
  const script = `export const meta = { name: 'scan', description: 'List what imports legacyAuth', phases: [] }
const found = await agent('List every file under src/ that imports legacyAuth. Report file:line only.', { label: 'scan' })
return found
`
  const w = runWorld($, on, { ...NO_TRANSCRIPTS, backend: oneCall({ model: { haiku: 0.9 }, nouls: { 'named.haiku': 0.9 } }), store: {}, session: true })
  await w.start()
  await w.submit('用 haiku 列一下哪些文件引用了 legacyAuth')
  await w.workflow({ script })
  expect(w.reached[0]?.script).toContain("{ label: 'scan', model: 'haiku' }")
  w.started('wf_test-1', 'wa1', 'scan')
  await w.agentStep('wa1', workflowStep(0, HAIKU, null, failing))
  await w.agentStep('wa1', workflowStep(1, HAIKU, null))

  expect(w.steps.map((s) => s.model)).toEqual([HAIKU, HAIKU])
  const log = await escalations(w)
  expect(log[0]).toContain('haiku is the model you named for it')
})
