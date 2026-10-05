// The defaults that depend on the decision model (#17, D3): the manifest gives
// those options none, so the engine (and the kit, which loads options the same
// way) passes nothing for them until the person sets one, and the mod takes
// the chosen model's from core/setup.ts BACKEND_DEFAULTS. Seam 1 for what
// reaches the backend and the status line; the shared reading (readConfig,
// which the eval and scripts/decide*.ts use too) directly.

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { BACKEND_DEFAULTS, dispatchSettings, PER_BACKEND_OPTIONS, readConfig } from '../hooks/core/setup.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { DEFAULT_ASK } from '../hooks/decision/effort.ts'
import { midturnState } from '../hooks/decision/midturn.ts'
import { workflowBatches } from '../hooks/decision/workflow.ts'
import { parseWorkflow } from '../hooks/decision/workflow-script.ts'
import { optionsFor, settingsFrom } from '../eval/lib/suite.ts'
import { CLEF_OPTIONS, clef } from './support/cloudflare.ts'
import type { SkillsWorld } from './support/world.ts'
import { jev, rates, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const CHOSEN = [
  { name: 'Jev', options: JEV },
  { name: 'Clef', options: CLEF_OPTIONS },
] as const

/** A message 5000 tokens long as the mod counts them (one a Chinese character). */
const LONG = '把登录模块重构成三层'.repeat(500)

/** How many of the mod's tokens the first request's user_message took. */
function messageTokens(w: { requests: { body: any }[] }): number {
  return estimateTokens(String(w.requests[0]?.body.state.user_message))
}

test("with Jev, a message waits 1500 ms for the decision (Jev's default)", { options: JEV }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: jev([0, 0, 1, 0, 0])(request) }) })
  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle()
  await w.clock.advance(1500)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.status()).toBe('dp effort xhigh (not routed) | jev: no answer in 1500 ms')
})

test("with Clef, a message waits 3000 ms (Clef's default): nothing the manifest declares stands in for it", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: clef([0, 0, 1, 0, 0])(request) }) })
  let answered = false
  const submitting = w.submit('看看这个报错是怎么回事').then(() => (answered = true))
  await w.clock.settle()
  await w.clock.advance(1500)
  await w.clock.settle()
  // Still waiting at Jev's 1500 ms.
  expect(answered).toBe(false)
  await w.clock.advance(1500)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.status()).toBe('dp effort xhigh (not routed) | clef: no answer in 3000 ms')
})

for (const chosen of CHOSEN) {
  test(`a timeout the person sets holds with ${chosen.name} as well`, { options: { ...chosen.options, timeoutMs: 2500 } }, async ($, on) => {
    const reply = chosen.name === 'Jev' ? jev([0, 0, 1, 0, 0]) : clef([0, 0, 1, 0, 0])
    const w = world($, on, { backend: (request) => ({ after: 60_000, reply: reply(request) }) })
    const submitting = w.submit('看看这个报错是怎么回事')
    await w.clock.settle()
    await w.clock.advance(2500)
    await submitting
    await w.step({ index: 0, effort: 'xhigh' })
    expect(w.status()).toBe(`dp effort xhigh (not routed) | ${chosen.name.toLowerCase()}: no answer in 2500 ms`)
  })
}

// The context budget: 2000 by default with either; a budget the person sets holds, except that Clef reads one above
// 2000 as 2000 (it sometimes reads only the first ~2.1k tokens of a state, and the newest messages come last).
const BUDGETS = [
  { name: 'Jev, by default', options: JEV, budget: 2000 },
  { name: 'Jev, set to 4000', options: { ...JEV, contextTokens: 4000 }, budget: 4000 },
  { name: 'Clef, by default', options: CLEF_OPTIONS, budget: 2000 },
  { name: 'Clef, set to 4000 (read as 2000)', options: { ...CLEF_OPTIONS, contextTokens: 4000 }, budget: 2000 },
  { name: 'Clef, set to 1500', options: { ...CLEF_OPTIONS, contextTokens: 1500 }, budget: 1500 },
] as const

for (const { name, options, budget } of BUDGETS) {
  test(`the context budget with ${name} is ${budget} tokens: a long message is cut to it`, { options }, async ($, on) => {
    const w = world($, on, { backend: 'cloudflareAccountId' in options ? clef([0, 1, 0, 0, 0]) : jev([0, 1, 0, 0, 0]) })
    await w.submit(LONG)
    expect(messageTokens(w)).toBeLessThanOrEqual(budget)
    expect(messageTokens(w)).toBeGreaterThan(budget - 50)
  })
}

// Clef's encoder renders a state as compact JSON with its keys sorted (`json.dumps(..., sort_keys=True)` in
// Cloudflare/clef's joint_schema_model.py) and keeps its head: there the person's message comes after
// recent_context, recent_steps or brief. So no field order is relied on: the budget holds for the whole state as
// sent, field names, quotes and escapes included, which keeps all of it before the cut.

/** JSON as a person may paste it: each quote and backslash of it escaped once more in the state as sent. */
const PASTED = '{"id": 17, "name": "session-cache", "tags": ["auth", "ttl"], "path": "C:\\\\cache\\\\sessions"}\n'.repeat(200)

/** A state as sent, in the mod's tokens. */
const sentTokens = (state: unknown) => estimateTokens(JSON.stringify(state))

test("with Clef, a message's state as sent keeps within the 2000-token budget: the message and the conversation before it, quotes and escapes counted", { options: CLEF_OPTIONS }, async ($, on) => {
  const messages = Array.from({ length: 8 }, (_, i): SessionMessage => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: PASTED.slice(0, 3000), toolUses: [] }))
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]), messages })
  await w.submit(PASTED)
  expect(sentTokens(w.requests[0]?.body.state)).toBeLessThanOrEqual(2000)
  // The budget is used, not thrown away.
  expect(sentTokens(w.requests[0]?.body.state)).toBeGreaterThan(1800)
})

test("with Clef, a dispatched agent's state as sent keeps within the budget too: its brief and the person's words", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]) })
  await w.submit(PASTED)
  await w.spawn({ prompt: PASTED, description: 'Check the cache config' })
  const asked = w.requests.find((request) => 'agent.model' in request.body.questions)
  expect(sentTokens(asked?.body.state)).toBeLessThanOrEqual(2000)
  expect(sentTokens(asked?.body.state)).toBeGreaterThan(1800)
})

test("a Workflow's requests and a mid-turn state keep within the budget as sent (seam 2: what the mod and the eval build)", () => {
  const prompt = PASTED.slice(0, 2400)
  const calls = Array.from({ length: 8 }, (_, i) => `const r${i} = await agent(${JSON.stringify(prompt)}, { label: 'step-${i}' })`).join('\n')
  const parsed = parseWorkflow(`export const meta = { name: 'big', description: 'Check every cache', phases: [] }\n${calls}\nreturn r0\n`)
  if (parsed === null) throw new Error('the script did not parse')
  const { batches } = workflowBatches(parsed, PASTED, dispatchSettings({ config: readConfig(CLEF_OPTIONS), ask: DEFAULT_ASK }), 2000)
  expect(batches.length).toBeGreaterThan(0)
  for (const batch of batches) expect(sentTokens(batch.request.state)).toBeLessThanOrEqual(2000)

  const steps = Array.from({ length: 4 }, () => ({ assistant_text: PASTED.slice(0, 600), tools: [{ name: 'Bash', result: `Failed: ${PASTED.slice(0, 200)}` }] }))
  const state = midturnState({ message: PASTED, step: 3, current_effort: 'high', counts: { judgments: 1, changes: 0, failures: 2, hook_blocks: 0 }, recent_steps: steps }, { steps: 4, tokens: 2000 })
  expect(sentTokens(state)).toBeLessThanOrEqual(2000)
})

const SKILLS: SkillsWorld = {
  commands: [
    { name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' },
    { name: 'code-review', description: 'Review the changes since a fixed point along two axes: Standards and Spec.', source: 'user' },
  ],
  listed: [
    { name: 'tdd', source: 'userSettings', tokens: 52 },
    { name: 'code-review', source: 'userSettings', tokens: 144 },
  ],
}
const LISTING = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- tdd: Test-driven development. Use when the user wants to build features or fix bugs test-first.',
  '- code-review: Review the changes since a fixed point along two axes: Standards and Spec.',
].join('\n')

test('with Jev, skills are suggested beside each message by default: the listing is withheld and the request asks about them', { options: JEV }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS })
  await w.submit('先写一个失败的测试')
  expect(Object.keys(w.requests[0]?.body.questions)).toContain('skills.which')
  expect(await w.listing(LISTING)).not.toEqual({ text: LISTING })
})

test('with Clef, skill suggestions start off: the main agent keeps its listing and no skill is asked about, until /dp skills on', { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]), skills: SKILLS })
  await w.submit('先写一个失败的测试')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
  expect(await w.command('dp')).toMatch(/\boff +skills +suggests the skills that fit each message/)

  expect(await w.command('dp', 'skills on')).toMatch(/^skills is on/)
  await w.submit('再写一个失败的测试')
  expect(Object.keys(w.requests[1]?.body.questions)).toEqual(['effort.level', 'skills.which'])
})

test('with Clef, find_skill still answers while the suggestions are off', { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]), skills: SKILLS, session: true })
  await w.start()
  expect(await w.command('dp')).toMatch(/\bon +find-skill /)
  const answer = await w.findSkill('write a failing test first')
  expect(w.requests.length).toBeGreaterThan(0)
  expect(String(answer.result)).not.toContain('switched off')
})

test("with Clef and the suggestions off, no skill profile is written: find_skill's first request offers skills by their descriptions with Clef, so nothing would read one", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]), skills: SKILLS, store: {}, session: true, model: () => ({ text: '{}' }) })
  await w.start()
  await w.clock.settle()
  expect(w.completions).toHaveLength(0)
  await w.findSkill('write a failing test first')
  expect(w.requests[0]?.body.questions['skills.which'].criteria.tdd).toBe(SKILLS.commands?.[0]?.description)
})

test('skillsMinRelevance is 0.75 by default: a skill that fits at 0.72 is not suggested, one at 0.78 is', { options: JEV }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.5, 'code-review': 0.4, '(none)': 0.1 }, { tdd: 0.78, 'code-review': 0.72 }), skills: SKILLS })
  await w.submit('先写测试，再审一下这个分支')
  const block = w.prompts[0]?.context?.[0] ?? ''
  expect(block).toContain('- tdd (relevance 0.78)')
  expect(block).not.toContain('code-review')
})

test('a relevance bar the person sets is the one used', { options: { ...JEV, skillsMinRelevance: 0.7 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.5, 'code-review': 0.4, '(none)': 0.1 }, { tdd: 0.78, 'code-review': 0.72 }), skills: SKILLS })
  await w.submit('先写测试，再审一下这个分支')
  expect(w.prompts[0]?.context?.[0]).toContain('- code-review (relevance 0.72)')
})

test("at session start the debug log says which options took the decision model's defaults, and one cut to Clef's most", { options: { ...CLEF_OPTIONS, contextTokens: 4000, thetaUp: 0.3 } }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  expect(w.logs.map((log) => log.text)).toContain(
    "settings for clef: left unset, so clef's defaults: timeoutMs 3000, contextMessages 4, rejudgeSteps 4, thetaDown 0.6, thetaMax 0.5, thetaExpected 0.25, agentOverride 0.6, skillsMinRelevance 0.75, findSkillMinRelevance 0.5; skill suggestions off until /dp skills on; contextTokens 4000 reads as 2000, the most with clef",
  )
})

// The reading the mod, the eval and scripts/decide*.ts share.

test("readConfig: an option left unset takes the decision model's default; Clef's are Jev's but for its timeout, its context budget's most, the skill suggestions and find_skill's wait and first request", () => {
  const jevConfig = readConfig({})
  expect([jevConfig.backend, jevConfig.timeoutMs, jevConfig.context, jevConfig.skills.suggest.minRelevance, jevConfig.skills.suggestByDefault]).toEqual(['jev', 1500, { messages: 4, tokens: 2000 }, 0.75, true])
  expect([jevConfig.skills.findWaitMs, jevConfig.skills.findByProfile]).toEqual([1500, true])
  const clefConfig = readConfig({ decisionModel: 'clef' })
  expect([clefConfig.backend, clefConfig.timeoutMs, clefConfig.context, clefConfig.skills.suggest.minRelevance, clefConfig.skills.suggestByDefault]).toEqual(['clef', 3000, { messages: 4, tokens: 2000 }, 0.75, false])
  expect([clefConfig.skills.findWaitMs, clefConfig.skills.findByProfile]).toEqual([8000, false])
  expect(clefConfig.midturn.rules).toEqual(jevConfig.midturn.rules)
  expect([clefConfig.escalation.thetaExpected, clefConfig.agents.thetaOverride, clefConfig.skills.find.minRelevance]).toEqual([0.25, 0.6, 0.5])
  // Not calibrated for Clef: Jev's values, but for these, each measured on Clef.
  const measured = { timeoutMs: 1500, contextTokensMax: 16000, suggestSkills: true, findSkillWaitMs: null, findSkillProfiles: true }
  expect({ ...BACKEND_DEFAULTS.clef, ...measured }).toEqual(BACKEND_DEFAULTS.jev)
  expect(clefConfig.defaults.used.map(([option]) => option)).toEqual([...PER_BACKEND_OPTIONS])
})

test("find_skill's wait follows the message's with Jev, timeoutMs set or not; with Clef it is 8000 ms whatever timeoutMs says", () => {
  expect(readConfig({ timeoutMs: 2500 }).skills.findWaitMs).toBe(2500)
  expect(readConfig({ decisionModel: 'clef', timeoutMs: 5000 }).skills.findWaitMs).toBe(8000)
})

test('readConfig: a value the person sets is the one used with either decision model; Clef reads a context budget above 2000 as 2000', () => {
  for (const decisionModel of ['jev', 'clef']) {
    const config = readConfig({ decisionModel, timeoutMs: 2500, contextMessages: 8, thetaUp: 0.3, thetaDown: 0.7, skillsMinRelevance: 0.6, agentOverride: 0.45, contextTokens: 1200 })
    expect([config.timeoutMs, config.context, config.midturn.rules.thetaUp, config.midturn.rules.thetaDown, config.skills.suggest.minRelevance, config.agents.thetaOverride]).toEqual([2500, { messages: 8, tokens: 1200 }, 0.3, 0.7, 0.6, 0.45])
    expect(config.defaults.used.map(([option]) => option)).not.toContain('timeoutMs')
  }
  expect(readConfig({ contextTokens: 4000 }).context.tokens).toBe(4000)
  const capped = readConfig({ decisionModel: 'clef', contextTokens: 4000 })
  expect(capped.context.tokens).toBe(2000)
  expect(capped.midturn.limits.tokens).toBe(2000)
  expect(capped.defaults.capped).toEqual([{ option: 'contextTokens', set: 4000, read: 2000 }])
})

test("the eval and scripts/decide*.ts read the same table: a run for Clef gets Clef's defaults for what the manifest leaves without one", () => {
  const userConfig = { timeoutMs: { type: 'number' }, contextTokens: { type: 'number' }, skillsMax: { type: 'number', default: 3 } }
  const clefSettings = settingsFrom(optionsFor('clef', userConfig))
  expect([clefSettings.backend, clefSettings.timeoutMs, clefSettings.skills.suggest.max]).toEqual(['clef', 3000, 3])
  expect(settingsFrom(optionsFor('jev', userConfig)).timeoutMs).toBe(1500)
  expect(settingsFrom(optionsFor('clef', userConfig, ['contextTokens=4000'])).context.tokens).toBe(2000)
})
