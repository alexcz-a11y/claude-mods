// The defaults that depend on the decision model (#17, D3): the manifest gives
// those options none, so the engine (and the kit, which loads options the same
// way) passes nothing for them until the person sets one, and the mod takes
// the chosen model's from core/setup.ts BACKEND_DEFAULTS (Jev's or pplx's,
// #50). Seam 1 for what reaches the backend and the board (Jev's here, pplx's
// in pplx-model.test.ts); the shared reading (readConfig, which the eval and
// scripts/decide*.ts use too) directly, for both.

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { BACKEND_DEFAULTS, backendNameOf, dispatchSettings, PER_BACKEND_OPTIONS, readConfig, setup } from '../hooks/core/setup.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { DEFAULT_AGENT_MODELS, dispatchPart } from '../hooks/decision/dispatched-agent.ts'
import { JEV_REGULAR_STATE } from '../hooks/decision/jev.ts'
import { questionBudget } from '../hooks/decision/skills.ts'
import { MAX_QUESTIONS } from '../hooks/decision/system-one.ts'
import { turnStartPart } from '../hooks/decision/turn-start.ts'
import { MAX_PER_REQUEST, workflowBatches } from '../hooks/decision/workflow.ts'
import { parseWorkflow } from '../hooks/decision/workflow-script.ts'
import { modVariant } from '../eval/lib/effort-submit.ts'
import { optionsFor, settingsFrom } from '../eval/lib/suite.ts'
import type { SkillsWorld } from './support/world.ts'
import { jev, KEY, rates, world } from './support/world.ts'

/** A message 105000 tokens long as the mod counts them (one a Chinese character): longer than any budget. */
const LONG = '把登录模块重构成三层'.repeat(10500)

/** How many of the mod's tokens a request's user_message took. */
function messageTokens(request: { body: any } | undefined): number {
  return estimateTokens(String(request?.body.state.user_message))
}

test("with Jev, a message waits 1500 ms for the decision (Jev's default)", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: jev([0, 0, 1, 0, 0])(request) }) })
  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle()
  await w.clock.advance(1500)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: false, failure: { backend: 'jev', kind: 'timeout', detail: 'no answer in 1500 ms' } })
})

test('a timeout the person sets is the one used', { options: { ...KEY, timeoutMs: 2500 } }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: jev([0, 0, 1, 0, 0])(request) }) })
  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle()
  await w.clock.advance(2500)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: false, failure: { backend: 'jev', kind: 'timeout', detail: 'no answer in 2500 ms' } })
})

// The context budget by kind of request (core/setup.ts BACKEND_DEFAULTS contextByKind): with Jev, a message's skills request
// (and find_skill's first stage) 6000 tokens, the message's effort request (ADR 0005) 24000, within Jev's regular limits
// (ADR 0014: no long-context header). A budget the person sets holds for every kind, each kind taking the smaller of it and its
// own: Jev reads one above the manifest's 16000 as 16000.
const SKILLS_WORLD: SkillsWorld = {
  commands: [{ name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' }],
  listed: [{ name: 'tdd', source: 'userSettings', tokens: 52 }],
}
const BUDGETS = [
  { name: 'Jev, by default', options: KEY, budget: 24000 },
  { name: 'Jev, set to 4000', options: { ...KEY, contextTokens: 4000 }, budget: 4000 },
  { name: 'Jev, set to 16000', options: { ...KEY, contextTokens: 16000 }, budget: 16000 },
  { name: 'Jev with skill suggestions, by default', options: KEY, budget: 6000, skills: 24000 },
  { name: 'Jev with skill suggestions, set to 4000', options: { ...KEY, contextTokens: 4000 }, budget: 4000, skills: 4000 },
  { name: 'Jev with skill suggestions, set to 16000 (read as 6000 for the skills request)', options: { ...KEY, contextTokens: 16000 }, budget: 6000, skills: 16000 },
] as const

for (const { name, options, budget, ...more } of BUDGETS) {
  test(`the context budget of a message with ${name} is ${budget} tokens: a long message is cut to it`, { options }, async ($, on) => {
    // With skill suggestions, `skills` is the budget of the effort request, which the message goes in on its own.
    const skills = 'skills' in more
    const w = world($, on, { backend: skills ? rates({ tdd: 0.5, '(none)': 0.5 }, { tdd: 0.5 }) : jev([0, 1, 0, 0, 0]), ...(skills ? { skills: SKILLS_WORLD } : {}) })
    await w.submit(LONG)
    const asked = skills ? w.withoutEffort[0] : w.requests[0]
    if (skills) {
      expect(Object.keys(asked?.body.questions)).toContain('skills.gate.acts_on_user_system')
      const effort = w.requests.find((request) => 'effort.level' in request.body.questions)
      expect(messageTokens(effort)).toBeLessThanOrEqual(more.skills)
      expect(messageTokens(effort)).toBeGreaterThan(more.skills - 50)
    }
    expect(messageTokens(asked)).toBeLessThanOrEqual(budget)
    expect(messageTokens(asked)).toBeGreaterThan(budget - 50)
  })
}

// A state is kept within its budget as sent: the whole of it, field names, quotes and escapes included (a decision model
// may read only the head of a long state, and no field is safe for coming first).

/** JSON as a person may paste it: each quote and backslash of it escaped once more in the state as sent. */
const PASTED = '{"id": 17, "name": "session-cache", "tags": ["auth", "ttl"], "path": "C:\\\\cache\\\\sessions"}\n'.repeat(200)

/** A state as sent, in the mod's tokens. */
const sentTokens = (state: unknown) => estimateTokens(JSON.stringify(state))

test("a Workflow's requests keep within a budget the person sets, as sent (seam 2: what the mod and the eval build)", () => {
  const prompt = PASTED.slice(0, 2400)
  const calls = Array.from({ length: 8 }, (_, i) => `const r${i} = await agent(${JSON.stringify(prompt)}, { label: 'step-${i}' })`).join('\n')
  const parsed = parseWorkflow(`export const meta = { name: 'big', description: 'Check every cache', phases: [] }\n${calls}\nreturn r0\n`)
  if (parsed === null) throw new Error('the script did not parse')
  const { batches } = workflowBatches(parsed, PASTED, dispatchSettings({ config: readConfig({ decisionModel: 'jev', contextTokens: 2000 }) }), 2000)
  expect(batches.length).toBeGreaterThan(0)
  for (const batch of batches) expect(sentTokens(batch.request.state)).toBeLessThanOrEqual(2000)
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

test('with Jev, skills are suggested beside each message by default: the listing is withheld and the request asks about them', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS })
  await w.submit('先写一个失败的测试')
  expect(Object.keys(w.withoutEffort[0]?.body.questions)).toContain('skills.gate.acts_on_user_system')
  expect(await w.listing(LISTING)).not.toEqual({ text: LISTING })
})

// Every question is written in English with Jev (ADR 0014: TypeSafe names English as the language Jev is most accurate in);
// the person's own words go into the state as they are.

test("with Jev, the effort part beside a message is written in English, and so are the skills' questions in both their requests", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }), skills: SKILLS })
  await w.submit('先写一个失败的测试')

  const effort = w.requests[0]?.body.questions['effort.level']
  expect(Object.keys(effort.instructions)).toEqual(['question', 'work', 'rate', 'short_replies'])
  expect(effort.criteria[0]).toMatch(/^Answered from what is already known/)
  // Chinese only in a quoted example of what the person may type (`"继续"`).
  expect(JSON.stringify(w.requests[0]?.body.questions).replace(/\\"[^\\"]*\\"/g, '')).not.toMatch(/[一-鿿]/)
  // The skills' questions are the cookbook's English words (ADR 0018).
  expect(w.withoutEffort[0]?.body.questions['skills.which'].instructions).toMatch(/^Which of these skills, if any, is the right one to load/)
  expect(w.withoutEffort[0]?.body.questions['skills.gate.acts_on_user_system'].instructions).toMatch(/^Is the assistant being asked to act/)
  expect(w.withoutEffort[1]?.body.questions['skills.fits.0'].instructions).toMatch(/^Does the skill 'tdd' do the specific thing/)
})

test('with Jev, a dispatched agent is asked in English', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]) })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0, effort: 'medium', tools: [{ tool: 'Skill', input: { skill: 'tdd' } }] })
  await w.spawn({ prompt: 'Run the tests and report what fails.', description: 'Run the tests' })

  const agent = w.requests.find((request) => 'agent.effort' in request.body.questions)
  expect(Object.keys(agent?.body.questions['agent.effort'].instructions)).toContain('question')
})

test("a long conversation is cut to Jev's regular limits: the effort request's state keeps within 24000 and goes without the long-context header", { options: KEY }, async ($, on) => {
  // About 75000 tokens of conversation: far more than the budget.
  const messages = Array.from({ length: 30 }, (_, i): SessionMessage => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `第 ${i} 条：${'把登录模块重构成三层'.repeat(250)}`, toolUses: [] }))
  const w = world($, on, { backend: rates({ tdd: 0.9, '(none)': 0.1 }, { tdd: 0.9 }), skills: SKILLS, messages })
  await w.submit('先写一个失败的测试')
  const effort = w.requests.find((request) => 'effort.level' in request.body.questions)
  expect(sentTokens(effort?.body.state)).toBeLessThanOrEqual(24000)
  expect(sentTokens(effort?.body.state)).toBeGreaterThan(22000)
  expect(effort?.headers['TypeSafe-Danger-Zone-Long-Context']).toBeUndefined()
  expect(w.withoutEffort[0]?.headers['TypeSafe-Danger-Zone-Long-Context']).toBeUndefined()
  expect((await w.board()).main).toMatchObject({ routed: true })
})

test("the skills' bars are the decision model's guide's, no option (ADR 0018): with Jev the cookbook's 0.30, a fit of 0.29 suggests nothing", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.5, 'code-review': 0.4, '(none)': 0.1 }, { tdd: 0.29, 'code-review': 0.2 }), skills: SKILLS })
  await w.submit('先写测试，再审一下这个分支')
  expect(w.prompts[0]?.context?.[0]).toContain('No skill in the roster appears relevant to this request.')
  expect(readConfig({ decisionModel: 'jev' }).guide.skills).toEqual({ gateBelow: 0.3, fits: 0.3, fitsInclusive: true })
  expect(readConfig({ decisionModel: 'd1-ultra' }).guide.skills).toEqual({ gateBelow: 0.2, fits: 0.5, fitsInclusive: false })
})

test("at session start the debug log says which options took the decision model's defaults, and one cut to Jev's most", { options: { ...KEY, contextTokens: 20000 } }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  expect(w.logs.map((log) => log.text)).toContain(
    "settings for jev: left unset, so jev's defaults: timeoutMs 1500, contextMessages 2000; skill suggestions on until /dp skills off; contextTokens 20000 reads as 16000, the most with jev",
  )
})

test('the settings line does not say skill suggestions are on when the person switched them off', { options: KEY }, async ($, on) => {
  const w = world($, on, { session: true, switches: { skills: false } })
  await w.start()
  const line = w.logs.map((log) => log.text).find((text) => text.startsWith('settings for jev:'))
  expect(line).toContain('; skill suggestions off (/dp skills on)')
  expect(line).not.toContain('skill suggestions on')
})

test("the settings line follows the skills' own switch, not the master: master off leaves it saying on", { options: KEY }, async ($, on) => {
  const w = world($, on, { session: true, switches: { master: false } })
  await w.start()
  const line = w.logs.map((log) => log.text).find((text) => text.startsWith('settings for jev:'))
  expect(line).toContain('; skill suggestions on until /dp skills off')
  expect(line).not.toContain('/dp skills on')
})

// The reading the mod, the eval and scripts/decide*.ts share.

test("readConfig: an option left unset takes the decision model's default", () => {
  const config = readConfig({ decisionModel: 'jev' })
  expect([config.backend, config.timeoutMs, config.context, config.skills.findMax]).toEqual(['jev', 1500, { messages: 2000, tokens: 6000 }, 5])
  // A long request waits 3000 ms at least, an agent 6000 at most (its request and one ahead of it); Jev is asked about agents four requests at a time, with their background.
  expect([config.longWaitMs, config.agents.waitMs, config.agents.lanes, config.agents.background]).toEqual([3000, 6000, 4, true])
  // The default plan's limits (decision/jev-rate.ts).
  expect(config.jevLimits).toEqual({ requestsPerSecond: 80, tokensPerSecond: 100_000 })
  expect(config.skills.findWaitMs).toBe(1500)
  // No threshold reads an agent's answers: its Nouls are read at TypeSafe's 0.7 and 0.3 (ADR 0015).
  expect(PER_BACKEND_OPTIONS as readonly string[]).not.toContain('agentOverride')
  expect(config.defaults.used.map(([option]) => option)).toEqual([...PER_BACKEND_OPTIONS])
  expect(BACKEND_DEFAULTS.jev.ask.turnStart.language).toBe('en')
})

test('readConfig: the TypeSafe account\'s limits are what the person sets (jevQps, jevTokensPerSecond), whole numbers within their ranges', () => {
  expect(readConfig({ decisionModel: 'jev', jevQps: 200, jevTokensPerSecond: 400_000 }).jevLimits).toEqual({ requestsPerSecond: 200, tokensPerSecond: 400_000 })
  // Out of range: the nearest end; not a number: the default.
  expect(readConfig({ decisionModel: 'jev', jevQps: 0, jevTokensPerSecond: 500 }).jevLimits).toEqual({ requestsPerSecond: 1, tokensPerSecond: 10_000 })
  expect(readConfig({ decisionModel: 'jev', jevQps: 'many' }).jevLimits).toEqual({ requestsPerSecond: 80, tokensPerSecond: 100_000 })
})

// The budget by kind of request, as readConfig gives it: `context` is the message that carries the skills' question (and
// find_skill's first stage), `contextByKind` has the others.
test("readConfig: the context budget is read by kind of request: 6000 with the skills' question, 24000 for a message's effort request and an agent's; a value the person sets caps each kind at the smaller", () => {
  const kinds = (options: Record<string, string | number>) => {
    const config = readConfig({ decisionModel: 'jev', ...options })
    return { message: config.context.tokens, ...config.contextByKind }
  }
  expect(kinds({})).toEqual({ message: 6000, messagePlain: 24000, agent: 24000, workflow: 24000 })
  // A budget the person sets applies to every kind, none above its own most.
  expect(kinds({ contextTokens: 4000 })).toEqual({ message: 4000, messagePlain: 4000, agent: 4000, workflow: 4000 })
  expect(kinds({ contextTokens: 16000 })).toEqual({ message: 6000, messagePlain: 16000, agent: 16000, workflow: 16000 })
  // The debug log's note on a value cut down is about the person's setting against the manifest's most, not each kind.
  expect(readConfig({ decisionModel: 'jev', contextTokens: 16000 }).defaults.capped).toEqual([])
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

test("Jev's context budget by default, kind of request by kind: every kind keeps within the regular 32k and 64k with room to spare, so none needs the long-context header (ADR 0014)", () => {
  const config = readConfig({ decisionModel: 'jev' })
  const size = (part: { questions: Record<string, unknown> }) => {
    const sizes = Object.values(part.questions).map((question) => estimateTokens(JSON.stringify(question)) * QUESTION_REAL_PER_ESTIMATED)
    return { longest: Math.max(...sizes), total: sizes.reduce((sum, n) => sum + n, 0) }
  }
  const mentions = { user_message: 'Use opus, ask for effort max, do not use haiku, sonnet is fine for the rest', agent_type: 'general-purpose', description: 'd', prompt: 'p', requested_model: 'sonnet' }
  // The effort request carries the effort question and its eight Nouls (ADR 0014): all count.
  const effort = size(turnStartPart({ ask: { language: 'en' }, constraints: [{ person_said: 'x', assistant_before: 'y' }], lastTurn: { effort: 'high', calls: 1, failed: 1, blocked: 0, stuck: false, errors: [] } }))
  // The most an agent asks: every Noul about its brief with fable's, the effort, a named and a ruled-out question for each model mentioned, the named effort.
  const agent = size(dispatchPart(mentions, { models: [...DEFAULT_AGENT_MODELS, 'fable'] }))
  // A request holds 64 questions: MAX_PER_REQUEST agents asking all of theirs with no model mentioned fit (12 each with fable).
  expect(MAX_PER_REQUEST * Object.keys(dispatchPart({ ...mentions, user_message: 'fix it' }, { models: [...DEFAULT_AGENT_MODELS, 'fable'] }).questions).length).toBeLessThanOrEqual(MAX_QUESTIONS)
  // Each kind of request: the budget its state takes, the longest question it carries and all its questions together (Jev's count).
  const kinds = {
    // The first stage of the skills shares the request with, for the skills only the person can start, a second question as long.
    'a message, skills on': { budget: config.context.tokens, longest: SKILLS_FIRST_STAGE_REAL, total: 2 * SKILLS_FIRST_STAGE_REAL },
    "find_skill's first stage": { budget: config.context.tokens, longest: SKILLS_FIRST_STAGE_REAL, total: SKILLS_FIRST_STAGE_REAL },
    "a message's effort request": { budget: config.contextByKind.messagePlain, ...effort },
    'a dispatched agent': { budget: config.contextByKind.agent, ...agent },
    // At most MAX_PER_REQUEST agents share a request, each with the questions of an agent (a Workflow's script is at most a third of the budget, within it).
    'a request about agents': { budget: config.contextByKind.workflow, longest: agent.longest, total: MAX_PER_REQUEST * agent.total },
  }
  const over = Object.entries(kinds).flatMap(([kind, { budget, longest, total }]) => {
    const real = budget * STATE_REAL_PER_ESTIMATED
    return [
      ...(real + longest > JEV_LIMIT.stateAndQuestion * USED ? [`${kind}: state plus its longest question is ${Math.round(real + longest)}`] : []),
      ...(real + total > JEV_LIMIT.request * USED ? [`${kind}: the whole request is ${Math.round(real + total)}`] : []),
    ]
  })
  expect(over).toEqual([])
  // The long kinds take JEV_REGULAR_STATE: the round number below what an agent's longest question leaves.
  expect(JEV_REGULAR_STATE).toBe(24000)
  for (const tokens of [config.contextByKind.messagePlain, config.contextByKind.agent, config.contextByKind.workflow]) expect(tokens).toBe(JEV_REGULAR_STATE)
  expect(25_000 * STATE_REAL_PER_ESTIMATED + agent.longest).toBeLessThanOrEqual(JEV_LIMIT.stateAndQuestion * USED)
  // The skills' kinds take the most that leaves room for their question: 500 tokens more would not.
  const budget = config.context.tokens
  expect((budget + 500) * STATE_REAL_PER_ESTIMATED + SKILLS_FIRST_STAGE_REAL).toBeGreaterThan(JEV_LIMIT.stateAndQuestion * USED)
  // The profiles of 111 skills (16k by the mod's count) are cut by `questionBudget` once the state leaves less than they need, 10% to spare: the default leaves them whole.
  expect(questionBudget(budget)).toBeGreaterThanOrEqual(16_000 * 1.1)
  expect(questionBudget(budget + 500)).toBeLessThan(16_000 * 1.1)
  // Whatever budget the person sets within the manifest's most, the skills' question is cut so that state and question still fit 32k.
  const most = BACKEND_DEFAULTS.jev.contextTokensMax
  expect(most * STATE_REAL_PER_ESTIMATED + questionBudget(most) * QUESTION_REAL_PER_ESTIMATED).toBeLessThanOrEqual(JEV_LIMIT.stateAndQuestion)
  // And what is read of a budget the person sets never exceeds a kind's own: the skills' kinds stay at 6000 whatever is set.
  expect(readConfig({ decisionModel: 'jev', contextTokens: most }).context.tokens).toBe(6000)
})

/** pplx's input limit: "Under 262,144, counting `state`, images, and every question" (docs.perplexity.ai/docs/decisions/quickstart, Request limits). */
const PPLX_LIMIT = 262_144
/**
 * pplx's tokens for each the mod estimates, at worst: 1.8-2.2 on prose, 2.2-2.3 on code (2026-10-13), 2.9-3.3 on text
 * like a log (#43; DEVELOPMENT.md, 「pplx 的 agent 预算」).
 */
const PPLX_REAL_PER_ESTIMATED = 3.3

test("pplx's budgets by default keep every kind of request well within its 262,144-token input limit: the time it answers in sets them, not the window", () => {
  const config = readConfig({ decisionModel: 'pplx' })
  const questions = (part: { questions: Record<string, unknown> }) => Object.values(part.questions).reduce((sum: number, question) => sum + estimateTokens(JSON.stringify(question)) * PPLX_REAL_PER_ESTIMATED, 0)
  const mentions = { user_message: 'Use opus, ask for effort max, do not use haiku, sonnet is fine for the rest', agent_type: 'general-purpose', description: 'd', prompt: 'p', requested_model: 'sonnet' }
  const agent = questions(dispatchPart(mentions, { models: [...DEFAULT_AGENT_MODELS, 'fable'] }))
  const kinds = {
    'a message, skills off': { budget: config.contextByKind.messagePlain, questions: questions(turnStartPart({ ask: { language: 'en' } })) },
    'a dispatched agent': { budget: config.contextByKind.agent, questions: agent },
    // At most MAX_PER_REQUEST calls share a request, each with the questions of an agent.
    'a Workflow request': { budget: config.contextByKind.workflow, questions: MAX_PER_REQUEST * agent },
  }
  const over = Object.entries(kinds).flatMap(([kind, { budget, questions: asked }]) => (budget * PPLX_REAL_PER_ESTIMATED + asked > PPLX_LIMIT * USED ? [`${kind}: ${Math.round(budget * PPLX_REAL_PER_ESTIMATED + asked)}`] : []))
  expect(over).toEqual([])
  // What pplx answers within the 8000 ms a request waits: a Workflow's one request 48000 (4.3-5.9 s alone), a dispatched
  // agent's 32000 (five at once within 5.2 s; three at 48000 took up to 7.6 s).
  expect([config.contextByKind.workflow, config.contextByKind.agent, config.timeoutMs]).toEqual([48000, 32000, 8000])
})

test("with Jev, a dispatched agent's state takes up to 24000 tokens, without the long-context header", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]) })
  await w.submit(LONG)
  await w.step({ index: 0 })
  await w.spawn({ prompt: LONG, description: 'Check the cache config' })

  const agent = w.requests.find((request) => 'agent.effort' in request.body.questions)
  expect(sentTokens(agent?.body.state)).toBeLessThanOrEqual(24000)
  expect(sentTokens(agent?.body.state)).toBeGreaterThan(23000)
  expect(agent?.headers['TypeSafe-Danger-Zone-Long-Context']).toBeUndefined()
})

test("with Jev a message carries up to 2000 recent messages by default, as far as the budget goes", { options: KEY }, async ($, on) => {
  const messages = Array.from({ length: 40 }, (_, i): SessionMessage => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message number ${i}`, toolUses: [] }))
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), messages })
  await w.submit('continue with the next one')
  const lines = String(w.requests[0]?.body.state.recent_context).split('\n')
  // All 40: the 32 that were the most until 2026-10-15 held a long conversation to a fraction of the budget.
  expect(lines).toHaveLength(40)
  expect(lines.at(-1)).toBe('assistant: message number 39')
})

test("find_skill's wait follows the message's with Jev, timeoutMs set or not", () => {
  expect(readConfig({ decisionModel: 'jev' }).skills.findWaitMs).toBe(1500)
  expect(readConfig({ decisionModel: 'jev', timeoutMs: 2500 }).skills.findWaitMs).toBe(2500)
})

test('readConfig: a value the person sets is the one used', () => {
  const config = readConfig({ decisionModel: 'jev', timeoutMs: 2500, contextMessages: 8, findSkillMax: 3, contextTokens: 1200 })
  expect([config.timeoutMs, config.context, config.skills.findMax]).toEqual([2500, { messages: 8, tokens: 1200 }, 3])
  expect(config.defaults.used.map(([option]) => option)).not.toContain('timeoutMs')
  expect(readConfig({ decisionModel: 'jev', contextTokens: 4000 }).context.tokens).toBe(4000)
  // Jev's most is the manifest's: a value above it reads as 16000, and the debug log says so.
  const jevCapped = readConfig({ decisionModel: 'jev', contextTokens: 20000 })
  expect(jevCapped.contextByKind.agent).toBe(16000)
  expect(jevCapped.context.tokens).toBe(6000)
  expect(jevCapped.defaults.capped).toEqual([{ option: 'contextTokens', set: 20000, read: 16000 }])
})

test("the eval and scripts/decide*.ts read the same table: a run for Jev gets Jev's defaults for what the manifest leaves without one", () => {
  const userConfig = { timeoutMs: { type: 'number' }, contextTokens: { type: 'number' }, findSkillMax: { type: 'number', default: 4 } }
  const jevSettings = settingsFrom(optionsFor('jev', userConfig))
  expect([jevSettings.backend, jevSettings.timeoutMs, jevSettings.skills.findMax]).toEqual(['jev', 1500, 4])
  expect(settingsFrom(optionsFor('jev', userConfig, ['contextTokens=4000'])).context.tokens).toBe(4000)
})

// Clef was removed in 0.4.0: a `decisionModel` of clef left in a 0.3.x configuration reads as unset, which is Jev (the
// default since 0.9.0, ADR 0014). The engine itself reads a value outside the option's list as the default and warns, so the
// mod is handed `jev`; it finds the old value in the person's settings file and says in the debug log why the model is not the
// one written.

const CLEF_LEFT_IN_SETTINGS = { pluginConfigs: { 'dispatch-pilot@alex-mods': { options: { decisionModel: 'clef', timeoutMs: 2500 } } } }

test('a decisionModel of clef, left over from 0.3.x, reads as unset (Jev), and the debug log says clef 已移除', { options: { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), session: true, userSettings: CLEF_LEFT_IN_SETTINGS })
  await w.start()
  expect(w.logs.map((log) => log.text)).toContain('decisionModel clef 已移除，按没设处理')
  await w.submit('看看这个报错是怎么回事')
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
})

const NOT_CLEF = [
  { name: 'no settings file', userSettings: undefined },
  { name: 'an empty one', userSettings: {} },
  { name: 'one that names jev', userSettings: { pluginConfigs: { 'dispatch-pilot@alex-mods': { options: { decisionModel: 'jev' } } } } },
  { name: "another plugin's clef", userSettings: { pluginConfigs: { 'other@somewhere': { options: { decisionModel: 'clef' } } } } },
]

for (const { name, userSettings } of NOT_CLEF) {
  test(`with ${name}, the debug log says nothing about Clef`, { options: KEY }, async ($, on) => {
    const w = world($, on, { session: true, ...(userSettings === undefined ? {} : { userSettings }) })
    await w.start()
    expect(w.logs.map((log) => log.text).filter((text) => text.includes('clef'))).toEqual([])
  })
}

test('readConfig: a decisionModel of clef passed straight in (the eval, a script) reads as unset', () => {
  expect(readConfig({ decisionModel: 'clef' })).toEqual(readConfig({}))
})

// What the table carries besides the options (core/setup.ts BackendDefaults): how the questions are asked (`ask`) and the most
// recent messages `contextMessages` may name (`contextMessagesMax`). Seam 2: the shared reading takes the table as its second
// argument (the shipped one by default). The rules that turn answers into an effort have no parameter in it (ADR 0014).

const PPLX_OPTIONS = { decisionModel: 'pplx' }

test('the table carries no threshold of the effort rules: they are the same with either decision model (TypeSafe\'s starting values, ADR 0014)', () => {
  for (const name of ['thetaMax', 'roundUp', 'hintThetaMax']) {
    expect([name, name in BACKEND_DEFAULTS.jev, name in BACKEND_DEFAULTS.pplx, name in readConfig({ decisionModel: 'jev' })]).toEqual([name, false, false, false])
  }
  expect((PER_BACKEND_OPTIONS as readonly string[]).includes('thetaMax')).toBe(false)
})

test("how the questions are asked is the decision model's: English throughout, with Jev and with pplx", () => {
  expect(readConfig({ decisionModel: 'jev' }).ask).toEqual({ turnStart: { language: 'en', primitive: 'score' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } })
  expect(readConfig(PPLX_OPTIONS).ask).toEqual({ turnStart: { language: 'en', primitive: 'score' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } })
  // `ctx.ask`, which every feature but the message's effort question and an agent's asks with, is the table's "other".
  expect(setup({ decisionModel: 'jev' }).ask).toEqual({ language: 'en', primitive: 'score' })
  expect(setup(PPLX_OPTIONS).ask).toEqual({ language: 'en', primitive: 'score' })
  // A table whose `other` is Chinese reaches it (a decision model the table does not have yet).
  const chinese = { ...BACKEND_DEFAULTS, jev: { ...BACKEND_DEFAULTS.jev, ask: { turnStart: { language: 'en', primitive: 'choice' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'zh', primitive: 'score' } } } } as const
  expect(setup({ decisionModel: 'jev' }, chinese).ask).toEqual({ language: 'zh', primitive: 'score' })
  expect(readConfig({ decisionModel: 'jev' }, chinese).ask.turnStart).toEqual({ language: 'en', primitive: 'choice' })
})

test("contextMessages reads at most what the decision model takes: 2000 with either (Jev's was 32 until 2026-10-15)", () => {
  expect(readConfig({ decisionModel: 'jev', contextMessages: 8 }).context.messages).toBe(8)
  const jevCapped = readConfig({ decisionModel: 'jev', contextMessages: 2400 })
  expect(jevCapped.context.messages).toBe(2000)
  expect(jevCapped.defaults.capped).toEqual([{ option: 'contextMessages', set: 2400, read: 2000 }])
  // Unset, the decision model's default is its most.
  expect(readConfig({ decisionModel: 'jev' }).context.messages).toBe(2000)
  expect(readConfig(PPLX_OPTIONS).context.messages).toBe(2000)
  expect(readConfig({ ...PPLX_OPTIONS, contextMessages: 1500 }).context.messages).toBe(1500)
  expect(readConfig({ ...PPLX_OPTIONS, contextMessages: 5000 }).context.messages).toBe(2000)
})

test('the eval reads the table the mod reads, for either decision model: the same question asked beside a message (the variant it runs as the mod does), the same limit on contextMessages', () => {
  const jevSettings = settingsFrom(optionsFor('jev', {}))
  expect([jevSettings.ask.turnStart, jevSettings.context.messages, modVariant(jevSettings)]).toEqual([{ language: 'en', primitive: 'score' }, 2000, 'en-score'])
  const userConfig = { contextMessages: { type: 'number' } }
  const pplxSettings = settingsFrom(optionsFor('pplx', userConfig, ['contextMessages=5000']))
  expect([pplxSettings.backend, pplxSettings.ask.turnStart, pplxSettings.context.messages, modVariant(pplxSettings)]).toEqual(['pplx', { language: 'en', primitive: 'score' }, 2000, 'en-score'])
})

// Perplexity's pplx-decider-v1.1-27b is the second decision model (`decisionModel: pplx`, #50; B′ of ADR 0006): a 262k window,
// one request a message in English, thresholds calibrated on its own answers. Its row of the table (core/setup.ts BACKEND_DEFAULTS)
// reaches everything that reads a default. Seam 2: the shared reading.

test('readConfig for pplx: its row of the table stands where the person set nothing (B′, ADR 0006)', () => {
  const config = readConfig({ decisionModel: 'pplx' })
  expect(config.backend).toBe('pplx')
  expect([config.timeoutMs, config.context, config.skills.findWaitMs]).toEqual([8000, { messages: 2000, tokens: 6000 }, 6000])
  // Every kind of request but the skills' takes 48000 tokens, a dispatched agent's 32000 (agents go out several at once:
  // DEVELOPMENT.md, pplx 的 agent 预算); the skills' two stages stay at 6000. An agent's request carries its background.
  expect(config.contextByKind).toEqual({ messagePlain: 48000, agent: 32000, workflow: 48000 })
  expect(config.agents.background).toBe(true)
  // The skills' bars are TypeSafe's, as Jev's (pplx answers as Jev does).
  expect(config.guide.skills).toEqual({ gateBelow: 0.3, fits: 0.3, fitsInclusive: true })
  // Every question in English, the effort question beside a message too.
  expect(config.ask).toEqual({ turnStart: { language: 'en', primitive: 'score' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } })
  expect(config.defaults.used.map(([option]) => option)).toEqual([...PER_BACKEND_OPTIONS])
})

test("readConfig for pplx: a value the person sets comes first, within pplx's own most (2000 messages, 48000 tokens, 8000 ms)", () => {
  const config = readConfig({ decisionModel: 'pplx', timeoutMs: 3000, contextMessages: 5000, contextTokens: 60000 })
  expect([config.timeoutMs, config.context.messages]).toEqual([3000, 2000])
  expect(config.contextByKind).toEqual({ messagePlain: 48000, agent: 32000, workflow: 48000 })
  expect(config.defaults.capped).toHaveLength(2)
  expect(config.defaults.capped).toContainEqual({ option: 'contextMessages', set: 5000, read: 2000 })
  expect(config.defaults.capped).toContainEqual({ option: 'contextTokens', set: 60000, read: 48000 })
  // A budget below the kinds' own holds for every kind, the skills' two stages taking the smaller of it and 6000.
  const less = readConfig({ decisionModel: 'pplx', contextTokens: 20000 })
  expect([less.context.tokens, less.contextByKind]).toEqual([6000, { messagePlain: 20000, agent: 20000, workflow: 20000 }])
})

test('readConfig: Jev is the decision model unless decisionModel says pplx; anything else (unset, a typo, clef) reads as unset', () => {
  for (const decisionModel of [undefined, 'jev', 'pplx-typo', 'clef']) expect(readConfig(decisionModel === undefined ? {} : { decisionModel }).backend).toBe('jev')
  expect(readConfig({ decisionModel: 'pplx' }).backend).toBe('pplx')
  expect(backendNameOf({ decisionModel: 'pplx' })).toBe('pplx')
  expect(backendNameOf({})).toBe('jev')
})

// No fallback on the keys (ADR 0014): the decision model is the one asked for, whichever keys there are.
test('the decision model never falls back: Jev without a TypeSafe key stays Jev (unconfigured), pplx only when asked for', () => {
  const onlyPerplexity = setup({ perplexityApiKey: 'p' })
  expect([onlyPerplexity.backend.name, onlyPerplexity.backend.configured]).toEqual(['jev', false])
  const asked = setup({ decisionModel: 'pplx', typesafeApiKey: 't' })
  expect([asked.backend.name, asked.backend.configured]).toEqual(['pplx', false])
  expect(setup({ typesafeApiKey: 't' }).backend.name).toBe('jev')
})

// A key lives in the options and in the backend built from them, nowhere that gets written down by accident: `Config` is
// handed to every feature and the eval, which write settings into logs and result files (`JSON.stringify(config)`).
test('the keys are in the config for the backend to use but do not show when the config is written out or copied', () => {
  const options = { typesafeApiKey: ' ts-secret-key ', perplexityApiKey: ' pplx-secret-key ' }
  const config = readConfig(options)
  expect(config.typesafeApiKey).toBe('ts-secret-key')
  expect(config.perplexityApiKey).toBe('pplx-secret-key')

  expect(JSON.stringify(config)).not.toContain('secret-key')
  expect(Object.keys(config)).not.toContain('typesafeApiKey')
  expect(Object.keys(config)).not.toContain('perplexityApiKey')
  expect(JSON.stringify({ ...config })).not.toContain('secret-key')
  expect(JSON.stringify(setup(options).config)).not.toContain('secret-key')
  expect(JSON.stringify(readConfig({ ...options, decisionModel: 'jev' }))).not.toContain('secret-key')
})
