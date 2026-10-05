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
import { DEFAULT_AGENT_MODELS, dispatchPart } from '../hooks/decision/dispatched-agent.ts'
import { DEFAULT_ASK, turnStartEffortPart } from '../hooks/decision/effort.ts'
import { expectedFailurePart } from '../hooks/decision/escalation.ts'
import { midturnEffortPart, midturnState } from '../hooks/decision/midturn.ts'
import { questionBudget } from '../hooks/decision/skills.ts'
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

/** A message 25000 tokens long as the mod counts them (one a Chinese character): longer than any budget. */
const LONG = '把登录模块重构成三层'.repeat(2500)

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

// The context budget by kind of request (core/setup.ts BACKEND_DEFAULTS contextByKind): with Jev, a message that carries the
// skills' question (and find_skill's first stage) 6000 tokens, every other kind of request 24000 (what 32k for the state and
// the longest question leaves beside a question of at most 700 tokens, DEVELOPMENT.md, 配置); 2000 with Clef for all. A budget
// the person sets holds for every kind, each kind taking the smaller of it and its own: Jev reads one above the manifest's
// 16000 as 16000 and Clef one above 2000 as 2000 (it sometimes reads only the first ~2.1k tokens of a state, and the newest
// messages come last).
const SKILLS_WORLD: SkillsWorld = {
  commands: [{ name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' }],
  listed: [{ name: 'tdd', source: 'userSettings', tokens: 52 }],
}
const BUDGETS = [
  { name: 'Jev, by default', options: JEV, budget: 24000 },
  { name: 'Jev, set to 4000', options: { ...JEV, contextTokens: 4000 }, budget: 4000 },
  { name: 'Jev, set to 16000', options: { ...JEV, contextTokens: 16000 }, budget: 16000 },
  { name: 'Jev with skill suggestions, by default', options: JEV, budget: 6000, skills: true },
  { name: 'Jev with skill suggestions, set to 4000', options: { ...JEV, contextTokens: 4000 }, budget: 4000, skills: true },
  { name: 'Jev with skill suggestions, set to 16000 (read as 6000 for that request)', options: { ...JEV, contextTokens: 16000 }, budget: 6000, skills: true },
  { name: 'Clef, by default', options: CLEF_OPTIONS, budget: 2000 },
  { name: 'Clef, set to 4000 (read as 2000)', options: { ...CLEF_OPTIONS, contextTokens: 4000 }, budget: 2000 },
  { name: 'Clef, set to 1500', options: { ...CLEF_OPTIONS, contextTokens: 1500 }, budget: 1500 },
] as const

for (const { name, options, budget, ...more } of BUDGETS) {
  test(`the context budget of a message with ${name} is ${budget} tokens: a long message is cut to it`, { options }, async ($, on) => {
    const skills = 'skills' in more
    const clefChosen = 'cloudflareAccountId' in options
    const w = world($, on, { backend: clefChosen ? clef([0, 1, 0, 0, 0]) : skills ? rates({ tdd: 0.5, '(none)': 0.5 }, { tdd: 0.5 }) : jev([0, 1, 0, 0, 0]), ...(skills ? { skills: SKILLS_WORLD } : {}) })
    await w.submit(LONG)
    if (skills) expect(Object.keys(w.requests[0]?.body.questions)).toContain('skills.which')
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

// The effort question beside each message is written in the decision model's language: Chinese with Jev (on the
// current wording, 2026-10-05: asked in Chinese, Chinese items 85% and English 89%; asked in English, 79% and 78%),
// English with Clef (never measured in Chinese). Every other question stays in English: none has data in Chinese.

test("with Jev, the effort question beside a message is written in Chinese; the skills questions in its request, and the second request's, stay in English", { options: JEV }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }), skills: SKILLS })
  await w.submit('先写一个失败的测试')

  const effort = w.requests[0]?.body.questions['effort.level']
  expect(Object.keys(effort.instructions)).toEqual(['问题', '评什么', '简短回复'])
  expect(effort.criteria[0]).toMatch(/^凭已知信息就能回答/)
  expect(Object.keys(w.requests[0]?.body.questions['skills.which'].instructions)).toContain('question')
  expect(Object.keys(w.requests[1]?.body.questions['skills.fits.0'].instructions)).toContain('question')
})

test('with Clef, the effort question beside a message is written in English', { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]) })
  await w.submit('先写一个失败的测试')

  const effort = w.requests[0]?.body.questions['effort.level']
  expect(Object.keys(effort.instructions)).toEqual(['question', 'rate', 'short_replies'])
  expect(effort.criteria[0]).toMatch(/^Answered from what is already known/)
})

test("with Jev, the questions asked later stay in English: a mid-turn re-decision's and a dispatched agent's", { options: JEV }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]) })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0, effort: 'medium', tools: [{ tool: 'Skill', input: { skill: 'tdd' } }] })
  await w.spawn({ prompt: 'Run the tests and report what fails.', description: 'Run the tests' })

  const midturn = w.requests.find((request) => 'midturn.level' in request.body.questions)
  expect(Object.keys(midturn?.body.questions['midturn.level'].instructions)).toEqual(['question', 'rate'])
  const agent = w.requests.find((request) => 'agent.effort' in request.body.questions)
  expect(Object.keys(agent?.body.questions['agent.effort'].instructions)).toContain('question')
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

test("at session start the debug log says which options took the decision model's defaults, and one cut to Clef's most", { options: { ...CLEF_OPTIONS, contextTokens: 4000, thetaUp: 0.35 } }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  expect(w.logs.map((log) => log.text)).toContain(
    "settings for clef: left unset, so clef's defaults: timeoutMs 3000, contextMessages 4, rejudgeSteps 4, thetaDown 0.75, thetaMax 0.5, thetaExpected 0.25, agentOverride 0.6, skillsMinRelevance 0.75, findSkillMinRelevance 0.5; skill suggestions off until /dp skills on; contextTokens 4000 reads as 2000, the most with clef",
  )
})

// The reading the mod, the eval and scripts/decide*.ts share.

test("readConfig: an option left unset takes the decision model's default; Clef's are Jev's but for its timeout, the three that say how much is read (kept as they were), the skill suggestions and find_skill's wait and first request", () => {
  const jevConfig = readConfig({})
  expect([jevConfig.backend, jevConfig.timeoutMs, jevConfig.context, jevConfig.skills.suggest.minRelevance, jevConfig.skills.suggestByDefault]).toEqual(['jev', 1500, { messages: 32, tokens: 6000 }, 0.75, true])
  expect(jevConfig.midturn.limits).toEqual({ steps: 16, tokens: 24000 })
  expect([jevConfig.skills.findWaitMs, jevConfig.skills.findByProfile]).toEqual([1500, true])
  const clefConfig = readConfig({ decisionModel: 'clef' })
  expect([clefConfig.backend, clefConfig.timeoutMs, clefConfig.context, clefConfig.skills.suggest.minRelevance, clefConfig.skills.suggestByDefault]).toEqual(['clef', 3000, { messages: 4, tokens: 2000 }, 0.75, false])
  expect(clefConfig.midturn.limits).toEqual({ steps: 4, tokens: 2000 })
  expect([clefConfig.skills.findWaitMs, clefConfig.skills.findByProfile]).toEqual([8000, false])
  expect(clefConfig.midturn.rules).toEqual(jevConfig.midturn.rules)
  expect([clefConfig.escalation.thetaExpected, clefConfig.agents.thetaOverride, clefConfig.skills.find.minRelevance]).toEqual([0.25, 0.6, 0.5])
  // Not calibrated for Clef: Jev's values, but for these, each set for Clef (measured, or kept as it was when Clef was connected).
  const own = { timeoutMs: 1500, contextMessages: 32, contextTokens: 6000, contextTokensMax: 16000, contextByKind: { messagePlain: 24000, rejudge: 24000, agent: 24000, workflow: 24000 }, rejudgeSteps: 16, suggestSkills: true, findSkillWaitMs: null, findSkillProfiles: true, turnStartLanguage: 'zh' }
  expect({ ...BACKEND_DEFAULTS.clef, ...own }).toEqual(BACKEND_DEFAULTS.jev)
  expect(clefConfig.defaults.used.map(([option]) => option)).toEqual([...PER_BACKEND_OPTIONS])
})

// Raising is easy, lowering is hard (AA's scores fall steeply as effort falls, DEVELOPMENT.md, 「按 AA 基准校正」): the
// mid-turn gates, the same for both decision models.
test('the mid-turn gates by default: a raise needs 0.3, a lowering 0.75 and no raise in the last 5 steps; Clef reads the same', () => {
  for (const options of [{}, { decisionModel: 'clef' }] as Record<string, string>[]) {
    expect(readConfig(options).midturn.rules).toEqual({ thetaUp: 0.3, thetaDown: 0.75, thetaMax: 0.5, holdSteps: 5 })
  }
  // What the person sets is what is used.
  expect(readConfig({ thetaUp: 0.4, thetaDown: 0.6, holdSteps: 3 }).midturn.rules).toMatchObject({ thetaUp: 0.4, thetaDown: 0.6, holdSteps: 3 })
})

// The budget by kind of request, as readConfig gives it: `context` is the message that carries the skills' question (and
// find_skill's first stage), `contextByKind` has the others.
test("readConfig: the context budget is read by kind of request: Jev 6000 with the skills' question and 24000 for the rest, Clef 2000 for all; a value the person sets caps each kind at the smaller", () => {
  const kinds = (options: Record<string, string | number>) => {
    const config = readConfig(options)
    return { message: config.context.tokens, ...config.contextByKind, rejudge: config.midturn.limits.tokens }
  }
  expect(kinds({})).toEqual({ message: 6000, messagePlain: 24000, rejudge: 24000, agent: 24000, workflow: 24000 })
  expect(kinds({ decisionModel: 'clef' })).toEqual({ message: 2000, messagePlain: 2000, rejudge: 2000, agent: 2000, workflow: 2000 })
  // A budget the person sets applies to every kind, none above its own most.
  expect(kinds({ contextTokens: 4000 })).toEqual({ message: 4000, messagePlain: 4000, rejudge: 4000, agent: 4000, workflow: 4000 })
  expect(kinds({ contextTokens: 16000 })).toEqual({ message: 6000, messagePlain: 16000, rejudge: 16000, agent: 16000, workflow: 16000 })
  expect(kinds({ decisionModel: 'clef', contextTokens: 1500 })).toEqual({ message: 1500, messagePlain: 1500, rejudge: 1500, agent: 1500, workflow: 1500 })
  expect(kinds({ decisionModel: 'clef', contextTokens: 9000 })).toEqual({ message: 2000, messagePlain: 2000, rejudge: 2000, agent: 2000, workflow: 2000 })
  // The debug log's note on a value cut down is about the person's setting against the manifest's and Clef's most, not each kind.
  expect(readConfig({ contextTokens: 16000 }).defaults.capped).toEqual([])
})

// Jev's context defaults are the most it accepts (DEVELOPMENT.md, 配置, 「Jev 的上下文默认值怎么算」), not what the eval ran
// (4 messages, 2000 tokens, 4 steps). Jev takes 64k tokens a request and 32k for the state plus the longest question.
// Each request kind's longest question, as Jev counts it, against that budget with the state at its most.
const JEV_LIMIT = { request: 64_000, stateAndQuestion: 32_000 }
/** The share of each limit the default may use: the rest is left for what the estimates cannot see. */
const USED = 0.9
/** The mod counts the state about 10% under Jev (the mod's 100 tokens are Jev's 111). */
const STATE_REAL_PER_ESTIMATED = 1 / 0.9
/** The question as Jev counts it, per token as the mod does: 111 skills with profiles, about 16k by the mod, 21.9k reported by Jev. */
const QUESTION_REAL_PER_ESTIMATED = 21_900 / 16_000
/** The first stage of the skills with every profile of 111 skills, as Jev reported it: the longest question there is, in message requests and in find_skill's. */
const SKILLS_FIRST_STAGE_REAL = 21_900

test("Jev's context budget by default, kind of request by kind, keeps the state plus the longest question within 32k and the whole request within 64k, with room to spare", () => {
  const config = readConfig({})
  const size = (part: { questions: Record<string, unknown> }) => {
    const sizes = Object.values(part.questions).map((question) => estimateTokens(JSON.stringify(question)) * QUESTION_REAL_PER_ESTIMATED)
    return { longest: Math.max(...sizes), total: sizes.reduce((sum, n) => sum + n, 0) }
  }
  const mentions = { user_message: 'Use opus, ask for effort max, do not use haiku, sonnet is fine for the rest', agent_type: 'general-purpose', description: 'd', prompt: 'p', requested_model: 'sonnet' }
  const effort = size(turnStartEffortPart({ language: 'zh' }))
  const agent = size(dispatchPart(mentions, { models: [...DEFAULT_AGENT_MODELS, 'fable'] }))
  const rejudge = size(midturnEffortPart({}, { trouble: true }))
  // Each kind of request: the budget its state takes, the longest question it carries and all its questions together (Jev's count).
  const kinds = {
    // The first stage of the skills shares the request with the effort question and, for the skills only the person can start, a second question as long.
    'a message, skills on': { budget: config.context.tokens, longest: SKILLS_FIRST_STAGE_REAL, total: 2 * SKILLS_FIRST_STAGE_REAL + effort.total },
    "find_skill's first stage": { budget: config.context.tokens, longest: SKILLS_FIRST_STAGE_REAL, total: SKILLS_FIRST_STAGE_REAL },
    'a message, skills off': { budget: config.contextByKind.messagePlain, ...effort },
    'a mid-turn re-decision': { budget: config.midturn.limits.tokens, ...rejudge },
    'a stuck re-decision': { budget: config.midturn.limits.tokens, longest: rejudge.longest, total: rejudge.total + size(expectedFailurePart({})).total },
    'a dispatched agent': { budget: config.contextByKind.agent, ...agent },
    // At most 8 calls share a request, each with the questions of an agent (a Workflow's state is at most a third of the budget and the briefs, within it).
    'a Workflow batch': { budget: config.contextByKind.workflow, longest: agent.longest, total: 8 * agent.total },
  }
  const over = Object.entries(kinds).flatMap(([kind, { budget, longest, total }]) => {
    const real = budget * STATE_REAL_PER_ESTIMATED
    return [
      ...(real + longest > JEV_LIMIT.stateAndQuestion * USED ? [`${kind}: state plus its longest question is ${Math.round(real + longest)}`] : []),
      ...(real + total > JEV_LIMIT.request * USED ? [`${kind}: the whole request is ${Math.round(real + total)}`] : []),
    ]
  })
  expect(over).toEqual([])
  // The skills' kinds take the most that leaves that room: 500 tokens more would not.
  const budget = config.context.tokens
  expect((budget + 500) * STATE_REAL_PER_ESTIMATED + SKILLS_FIRST_STAGE_REAL).toBeGreaterThan(JEV_LIMIT.stateAndQuestion * USED)
  // The other kinds take a round number below what their longest question leaves (about 25,400 to 25,600): the longest of them, a dispatched agent's request, is the one that sets it.
  for (const tokens of [config.contextByKind.messagePlain, config.midturn.limits.tokens, config.contextByKind.agent, config.contextByKind.workflow]) expect(tokens).toBe(24000)
  expect(25_000 * STATE_REAL_PER_ESTIMATED + agent.longest).toBeLessThanOrEqual(JEV_LIMIT.stateAndQuestion * USED)
  // The profiles of 111 skills (16k by the mod's count) are cut by `questionBudget` once the state leaves less than they need, 10% to spare: the default leaves them whole.
  expect(questionBudget(budget)).toBeGreaterThanOrEqual(16_000 * 1.1)
  expect(questionBudget(budget + 500)).toBeLessThan(16_000 * 1.1)
  // Whatever budget the person sets within the manifest's most, the skills' question is cut so that state and question still fit 32k.
  const most = BACKEND_DEFAULTS.jev.contextTokensMax
  expect(most * STATE_REAL_PER_ESTIMATED + questionBudget(most) * QUESTION_REAL_PER_ESTIMATED).toBeLessThanOrEqual(JEV_LIMIT.stateAndQuestion)
  // And what is read of a budget the person sets never exceeds a kind's own: the skills' kinds stay at 6000 whatever is set.
  expect(readConfig({ contextTokens: most }).context.tokens).toBe(6000)
})

test("with Jev, a dispatched agent's state and a mid-turn re-decision's message take up to 24000 tokens (a Workflow's briefs too): their questions are short", { options: { ...JEV, rejudgeEvery: 1 } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]) })
  await w.submit(LONG)
  const reading = (index: number) => ({ index, answer: `step ${index}`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  await w.step(reading(0))
  await w.step(reading(1))
  await w.step({ index: 2 })
  await w.spawn({ prompt: LONG, description: 'Check the cache config' })

  const stateOf = (id: string) => w.requests.find((request) => id in request.body.questions)?.body.state
  const agent = stateOf('agent.model')
  expect(sentTokens(agent)).toBeLessThanOrEqual(24000)
  expect(sentTokens(agent)).toBeGreaterThan(23000)
  // The re-decision keeps the turn's message to half of its budget.
  const midturn = stateOf('midturn.level')
  expect(estimateTokens(String(midturn.user_message))).toBeLessThanOrEqual(12000)
  expect(estimateTokens(String(midturn.user_message))).toBeGreaterThan(11000)
  expect(sentTokens(midturn)).toBeLessThanOrEqual(24000)
})

test('with Clef a message carries 4 recent messages by default, however many there are', { options: CLEF_OPTIONS }, async ($, on) => {
  const messages = Array.from({ length: 40 }, (_, i): SessionMessage => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message number ${i}`, toolUses: [] }))
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]), messages })
  await w.submit('continue with the next one')
  expect(String(w.requests[0]?.body.state.recent_context).split('\n')).toHaveLength(4)
})

test("with Jev a message carries up to 32 recent messages by default and a re-decision up to 16 steps, as far as the budget goes (Clef's re-decision: 4 steps)", { options: JEV }, async ($, on) => {
  const messages = Array.from({ length: 40 }, (_, i): SessionMessage => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message number ${i}`, toolUses: [] }))
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), messages })
  await w.submit('continue with the next one')
  const lines = String(w.requests[0]?.body.state.recent_context).split('\n')
  expect(lines).toHaveLength(32)
  expect(lines.at(-1)).toBe('assistant: message number 39')

  const steps = Array.from({ length: 20 }, (_, i) => ({ assistant_text: `step ${i}`, tools: [{ name: 'Bash', result: 'Success: run the tests' }] }))
  const input = { message: 'fix it', step: 20, current_effort: 'high' as const, counts: { judgments: 1, changes: 0, failures: 0, hook_blocks: 0 }, recent_steps: steps }
  const kept = (config: ReturnType<typeof readConfig>) => (midturnState(input, config.midturn.limits).recent_steps as unknown[]).length
  expect(kept(readConfig({}))).toBe(16)
  expect(kept(readConfig({ decisionModel: 'clef' }))).toBe(4)
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
  // Jev's most is the manifest's: a value above it reads as 16000, and the debug log says so.
  const jevCapped = readConfig({ contextTokens: 20000 })
  expect(jevCapped.contextByKind.agent).toBe(16000)
  expect(jevCapped.context.tokens).toBe(6000)
  expect(jevCapped.defaults.capped).toEqual([{ option: 'contextTokens', set: 20000, read: 16000 }])
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
