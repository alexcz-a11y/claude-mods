// The skill suite of the eval (seam 2): what it asks about an item is what
// the mod asks when the person sends that message after that conversation,
// both stages of the cookbook's ranking (checked against the mod itself,
// through seam 1's world), and it suggests and hints what the mod would from
// the same answers.

import { expect, test } from 'claude-code/testing'
import type { PluginOptions } from 'claude-code'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import type { SkillItem } from '../eval/lib/datasets.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite } from '../eval/lib/runner.ts'
import { skillSuite } from '../eval/lib/skill.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { transcriptWithResults } from './support/conversation.ts'
import { fitsSkill, isSecondSkillsRequest, rates, world, type Reply, type Sent, type SkillsWorld } from './support/world.ts'

const TDD_DESCRIPTION = 'Test-driven development. Use when the user wants to build features or fix bugs test-first.'
const REVIEW_DESCRIPTION = 'Review the changes since a fixed point along two axes: Standards and Spec.'
const RUN_DESCRIPTION = "Launch and drive this project's app to see a change working."
const GRILL_DESCRIPTION = 'A relentless interview to sharpen a plan or design.'
const HANDOFF_DESCRIPTION = 'Hand the current conversation off to a fresh background agent.'

/**
 * A session's skills as the snapshot (skill-catalog.json) records them, in
 * the snapshot's order: the main agent may load tdd, run (built in, no
 * SKILL.md) and code-review, in the order the engine lists them; grill-me only
 * the person can start; claude-handoff is switched off.
 */
const CATALOG = {
  skills: [
    { name: 'tdd', description: TDD_DESCRIPTION, status: 'candidate', engine_source: 'userSettings', path: '~/.claude/skills/tdd/SKILL.md' },
    { name: 'claude-handoff', description: HANDOFF_DESCRIPTION, status: 'off', engine_source: null, path: '~/.claude/skills/claude-handoff/SKILL.md' },
    { name: 'run', description: RUN_DESCRIPTION, status: 'candidate', engine_source: 'built-in', path: null },
    { name: 'grill-me', description: GRILL_DESCRIPTION, status: 'user-only-frontmatter', engine_source: null, path: '~/.claude/skills/grill-me/SKILL.md' },
    { name: 'code-review', description: ` ${REVIEW_DESCRIPTION} `, status: 'candidate', engine_source: 'userSettings', path: '~/.claude/skills/code-review/SKILL.md' },
  ],
}

/** The same session as the engine shows it to the mod. */
const SKILLS: SkillsWorld = {
  commands: [
    { name: 'tdd', description: TDD_DESCRIPTION, source: 'user' },
    { name: 'claude-handoff', description: HANDOFF_DESCRIPTION, source: 'user' },
    { name: 'run', description: RUN_DESCRIPTION, source: 'builtin' },
    { name: 'grill-me', description: GRILL_DESCRIPTION, source: 'user' },
    { name: 'code-review', description: ` ${REVIEW_DESCRIPTION} `, source: 'user' },
  ],
  listed: [
    { name: 'tdd', source: 'userSettings', tokens: 52 },
    { name: 'run', source: 'built-in', tokens: 30 },
    { name: 'code-review', source: 'userSettings', tokens: 144 },
  ],
  overrides: { local: { 'claude-handoff': 'off' } },
}

const DISK: Record<string, string> = {
  '/home/u/.claude/skills/tdd/SKILL.md': `---\nname: tdd\ndescription: ${TDD_DESCRIPTION}\n---\n\n# Test-Driven Development\n\nWrite one failing test, then only the code that makes it pass.\n`,
  '/home/u/.claude/skills/code-review/SKILL.md': `---\nname: code-review\ndescription: ${REVIEW_DESCRIPTION}\n---\n\n# Code review\n\nReview the diff against the repo's standards, then against the issue.\n`,
  '/home/u/.claude/skills/grill-me/SKILL.md': `---\nname: grill-me\ndescription: ${GRILL_DESCRIPTION}\ndisable-model-invocation: true\n---\n\nInterview me relentlessly about every aspect of this plan until we reach a shared understanding.\n`,
  '/home/u/.claude/skills/claude-handoff/SKILL.md': `---\nname: claude-handoff\ndisable-model-invocation: true\n---\n\nHand off.\n`,
}

/** A SKILL.md by the snapshot's path, as the eval's host reads it (`~` is the home directory). */
async function read(path: string): Promise<string> {
  const text = DISK[path.replace(/^~/, '/home/u')]
  if (text === undefined) throw new Error(`ENOENT: ${path}`)
  return text
}

/** A follow-up whose work is in the conversation before it. */
const ITEM: SkillItem = {
  id: 'skill-900',
  zh: {
    message: '好，就照这个思路来，先写一个会失败的测试，再实现限流',
    recent_context: [
      { role: 'user', text: '登录接口要加限流，你看怎么做' },
      { role: 'assistant', text: '可以在网关前加令牌桶，每个 IP 每分钟 20 次。要先写测试吗？', tools: ['Grep', 'Read'] },
    ],
  },
  en: {
    message: "OK, go that way: first write a test that fails, then implement the rate limit",
    recent_context: [
      { role: 'user', text: 'The login endpoint needs rate limiting. How would you do it?' },
      { role: 'assistant', text: 'A token bucket in front of the gateway, 20 a minute per IP. Shall I write the tests first?', tools: ['Grep', 'Read'] },
    ],
  },
  gold: ['tdd'],
  accept: ['tdd'],
  must_not: ['code-review'],
  user_only_hint: [],
  rationale: '测试先行。',
  difficulty: 'hard',
  tags: ['needs-context'],
}

/**
 * Jev's own client (jevBackend) over a fake network that answers as the
 * world's backend answers the mod (`answer`); every request body it carried
 * is kept, as it went out.
 */
function network(answer: (request: Sent) => Reply) {
  const bodies: unknown[] = []
  const io: BackendIo = {
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const reply = answer({ url, method: init.method, headers: { ...(init.headers ?? {}) }, body, at: 0 })
      if (!('status' in reply)) throw new Error('this network only answers')
      return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text: JSON.stringify(reply.body) }
    },
    // The backend's own timeout timer: never fires here; it is aborted once the answer is in.
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, bodies, now: () => 0, pause: async () => {} }
}

/** How the decision model rates this session's skills for the item: tdd first by far; on a second look tdd fits, code-review less, grill-me does. */
const ANSWER = rates({ tdd: 0.55, 'code-review': 0.2, 'grill-me': 0.15, run: 0.02, '(none)': 0.08 }, { tdd: 0.93, 'code-review': 0.4, 'grill-me': 0.81 })

/** The gate's three questions, as stage one asks them beside the Choices. */
const GATE = ['skills.gate.acts_on_user_system', 'skills.gate.would_follow_documented_procedure', 'skills.gate.prose_suffices']

for (const language of ['zh', 'en'] as const) {
  test(`the eval asks about an item what the mod asks when the person sends its message after its conversation, in both stages, each skill by its own description (${language})`, { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
    const w = world($, on, { backend: ANSWER, skills: SKILLS, disk: DISK, messages: transcriptWithResults(ITEM[language].recent_context) })
    await w.submit(ITEM[language].message)

    const suite = await skillSuite({ catalog: CATALOG, read })
    const net = network(ANSWER)
    await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom({ decisionModel: 'jev' }), variants: ['cookbook'], languages: [language], timeoutMs: 10_000, retries: 0, concurrency: 1 })

    // The mod's effort request is the effort eval's (tests/eval-effort-submit.test.ts); the skills' two are this one's.
    expect(w.requests).toHaveLength(3)
    expect(w.withoutEffort).toHaveLength(2)
    expect(net.bodies).toEqual(w.withoutEffort.map((request) => request.body))
    // What the two requests hold, so the equality above is not two empty things: every skill the main agent can load in
    // one Choice, by its description (grill-me, the only one the person can start, has none), and the gate;
    const first = w.withoutEffort[0]?.body.questions
    expect(Object.keys(first)).toEqual(['skills.which', ...GATE])
    expect(first['skills.which'].criteria).toEqual({ tdd: TDD_DESCRIPTION, run: RUN_DESCRIPTION, 'code-review': REVIEW_DESCRIPTION })
    expect(String(w.withoutEffort[0]?.body.state.recent_context)).toContain('[tools: Grep, Read]')
    // the second re-reads the three of the Choice and grill-me, the Choice's with the opening of each SKILL.md.
    const second = w.withoutEffort[1]?.body.questions
    expect(Object.keys(second)).toEqual(['skills.which', 'skills.fits.0', 'skills.fits.1', 'skills.fits.2', 'skills.fits.3'])
    expect(second['skills.which'].criteria.tdd).toBe(`${TDD_DESCRIPTION} — # Test-Driven Development Write one failing test, then only the code that makes it pass.`)
    expect(Object.values(second).flatMap((question: any) => (question.type === 'noul' ? [fitsSkill(question.instructions)] : []))).toEqual(['tdd', 'code-review', 'run', 'grill-me'])
  })
}

/**
 * The same answers under some of the person's options: what the mod shows the
 * main agent and the person (the skill its decision suggests, and the one it
 * names for the person to try), and what the eval records for the item.
 */
const PICKS: { options: PluginOptions; suggest: string[]; tried: string[]; shown: string }[] = [
  { options: {}, suggest: ['tdd'], tried: ['grill-me'], shown: 'tdd | try /grill-me' },
  // Never offered: stage one rates the rest, and code-review (0.4, past the cookbook's 0.30) is the Choice's.
  { options: { skillsNeverSuggested: ['tdd'] }, suggest: ['code-review'], tried: ['grill-me'], shown: 'code-review | try /grill-me' },
  { options: { skillsNeverSuggested: ['tdd', 'grill-me'] }, suggest: ['code-review'], tried: [], shown: 'code-review' },
]

for (const { options, suggest, tried, shown } of PICKS) {
  test(`from the same answers the eval suggests and hints what the mod does, under the person's options (${JSON.stringify(options)})`, { options: { decisionModel: 'jev', typesafeApiKey: 'k', ...options } }, async ($, on) => {
    const w = world($, on, { backend: ANSWER, skills: SKILLS, disk: DISK, messages: transcriptWithResults(ITEM.zh.recent_context) })
    await w.submit(ITEM.zh.message)
    await w.step({ index: 0 })

    const suite = await skillSuite({ catalog: CATALOG, read })
    const net = network(ANSWER)
    const [row] = await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom({ decisionModel: 'jev', ...options }), variants: ['cookbook'], languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })

    const picked = (await w.board()).log.findLast((entry) => entry.feature === 'skills')?.skills
    expect(picked?.suggest.map((skill) => skill.name)).toEqual(suggest)
    expect(picked?.try.map((skill) => skill.name)).toEqual(tried)
    expect(row?.shown).toBe(shown)
    expect(net.bodies).toEqual(w.withoutEffort.map((request) => request.body))
  })
}

/** An item with these answers (only they are graded). */
function answered(id: string, answers: { gold?: string[]; accept?: string[]; must_not?: string[]; hint?: string[] }, tags: string[] = []): SkillItem {
  const asked = (message: string) => ({ message, recent_context: [] })
  return {
    id,
    zh: asked(`${id}（中文）`),
    en: asked(`${id} (English)`),
    gold: answers.gold ?? [],
    accept: answers.accept ?? answers.gold ?? [],
    must_not: answers.must_not ?? [],
    user_only_hint: answers.hint ?? [],
    rationale: '理由',
    difficulty: 'hard',
    tags,
  }
}

test("an answer is graded by the review's rules: a must_not skill is wrong, neutral skills alone miss, nothing is right only where nothing fits; the hint is graded beside it", async () => {
  const suite = await skillSuite({ catalog: CATALOG, read })
  const grade = (item: SkillItem, suggest: string[], hint: string[] = []) => {
    const graded = suite.grade(item, { suggest, hint })
    const parts = Object.entries(graded.parts ?? {}).map(([part, right]) => `${part} ${right ? 'right' : 'wrong'}`)
    return [graded.correct ? 'right' : `wrong (${graded.miss})`, ...(graded.exact ? ['gold'] : []), ...parts].join(', ')
  }
  const tdd = answered('a', { gold: ['tdd'], accept: ['tdd', 'code-review'], must_not: ['run'] })
  const none = answered('b', { must_not: ['run'] })
  const person = answered('c', { hint: ['grill-me', 'grill-with-docs'] })
  const both = answered('d', { gold: ['grilling', 'domain-modeling'], hint: ['grill-with-docs'] })

  expect([
    grade(tdd, ['tdd']),
    grade(tdd, ['code-review']),
    // A neutral skill (neither acceptable nor must_not) costs nothing beside an acceptable one...
    grade(tdd, ['tdd', 'other']),
    // ...but alone it misses.
    grade(tdd, ['other']),
    grade(tdd, ['tdd', 'run']),
    grade(tdd, []),
    grade(tdd, ['tdd'], ['grill-me']),
    grade(none, []),
    grade(none, ['other']),
    grade(none, ['run']),
    grade(person, [], ['grill-me']),
    grade(person, [], ['grill-with-docs', 'grill-me']),
    grade(person, [], []),
    grade(person, [], ['wayfinder']),
    grade(person, [], ['grill-me', 'wayfinder']),
    grade(person, ['other'], ['grill-me']),
    // Two gold skills, each covering part of the work: either is right, both are gold.
    grade(both, ['domain-modeling'], ['grill-with-docs']),
    grade(both, ['grilling', 'domain-modeling'], ['grill-with-docs']),
    grade(both, ['grilling', 'domain-modeling'], []),
  ]).toEqual([
    'right, gold, suggest right, hint right',
    'right, suggest right, hint right',
    'right, suggest right, hint right',
    'wrong (neutral-only), suggest wrong, hint right',
    'wrong (must-not), suggest wrong, hint right',
    'wrong (missed), suggest wrong, hint right',
    'wrong (hint-extra), suggest right, hint wrong',
    'right, gold, suggest right, hint right',
    'wrong (extra), suggest wrong, hint right',
    'wrong (must-not), suggest wrong, hint right',
    'right, suggest right, hint right',
    'right, gold, suggest right, hint right',
    'wrong (hint-missed), suggest right, hint wrong',
    'wrong (hint-other), suggest right, hint wrong',
    'right, suggest right, hint right',
    'wrong (extra), suggest wrong, hint right',
    'right, suggest right, hint right',
    'right, gold, suggest right, hint right',
    'wrong (hint-missed), suggest right, hint wrong',
  ])
})

/**
 * Four items and how the decision model rates the skills for each, zh | en: stage one's shares (`(none)` is how little the
 * gate thinks a skill is needed), then how well each skill it re-read fits.
 *   a  tdd .93 | code-review .72 over tdd .50 (must_not)
 *   b  the gate says no | run .20 (under the bar)
 *   c  grill-me .85 (to hint) | the gate says no (hint missed)
 *   d  code-review .25 (under the bar: missed) | code-review .90
 */
const FOUR = [
  answered('a', { gold: ['tdd'], must_not: ['code-review'] }, ['near-duplicate']),
  answered('b', {}, ['none', 'lexical-trap']),
  answered('c', { hint: ['grill-me'] }, ['user-only']),
  answered('d', { gold: ['code-review'] }, ['multi-partial', 'needs-context']),
]
const RATED: Record<string, { shares: Record<string, number>; fits: Record<string, number> }> = {
  'a zh': { shares: { tdd: 0.7, '(none)': 0.3 }, fits: { tdd: 0.93 } },
  'a en': { shares: { tdd: 0.5, 'code-review': 0.4, '(none)': 0.1 }, fits: { tdd: 0.5, 'code-review': 0.72 } },
  'b zh': { shares: { '(none)': 1 }, fits: {} },
  'b en': { shares: { run: 0.3, '(none)': 0.6 }, fits: { run: 0.2 } },
  'c zh': { shares: { 'grill-me': 0.6, '(none)': 0.4 }, fits: { 'grill-me': 0.85 } },
  'c en': { shares: { 'grill-me': 0.2, '(none)': 0.8 }, fits: { 'grill-me': 0.65 } },
  'd zh': { shares: { 'code-review': 0.9, '(none)': 0.1 }, fits: { 'code-review': 0.25 } },
  'd en': { shares: { 'code-review': 0.9, '(none)': 0.1 }, fits: { 'code-review': 0.9 } },
}

/** The decision model rating each item as RATED says; stage one takes 300 ms of the fake clock, stage two 200 ms. */
function ratedNetwork() {
  let clock = 0
  const net = network((request) => {
    const words = String(request.body.state.user_message)
    const key = words.includes('（中文）') ? `${words.slice(0, words.indexOf('（'))} zh` : `${words.slice(0, words.indexOf(' ('))} en`
    const rated = RATED[key] ?? { shares: { '(none)': 1 }, fits: {} }
    clock += isSecondSkillsRequest(request) ? 200 : 300
    return rates(rated.shares, rated.fits)(request)
  })
  return { ...net, now: () => clock }
}

async function runFour() {
  const suite = await skillSuite({ catalog: CATALOG, read })
  const settings = settingsFrom({ decisionModel: 'jev' })
  const rows = await runSuite(suite, FOUR, { backend: jevBackend('k'), ...ratedNetwork(), settings, variants: ['cookbook'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
  return { rows, summary: summarize(suite, FOUR, rows, { slowMs: 1500, settings }) }
}

test("what an answer records: the gate, what stage one put forward, how well each fits by stage two and whom its Choices picked, how long each stage took", async () => {
  const { rows } = await runFour()
  const row = (key: string) => rows.find((r) => `${r.id} ${r.language}` === key)

  expect(row('a en')?.detail).toEqual({
    gate: 0.9,
    stopped: false,
    first: [
      { name: 'tdd', share: 0.556 },
      { name: 'code-review', share: 0.444 },
      { name: 'run', share: 0 },
    ],
    hints: [{ name: 'grill-me', share: 1 }],
    fits: [
      { name: 'tdd', relevance: 0.5 },
      { name: 'code-review', relevance: 0.72 },
      { name: 'run', relevance: 0 },
      { name: 'grill-me', relevance: 0 },
    ],
    winner: 'code-review',
    hint_winner: 'grill-me',
    stages_ms: [300, 200],
  })
  // The gate said no: no second request.
  expect(row('b zh')?.detail).toMatchObject({ gate: 0, stopped: true, fits: [], winner: null, stages_ms: [300] })
  expect(row('b zh')?.ms).toBe(300)
  expect(rows.map((r) => `${r.id} ${r.language}: ${r.shown} ${r.correct ? 'right' : `wrong (${r.miss})`}`)).toEqual([
    'a zh: tdd right',
    'a en: code-review wrong (must-not)',
    'b zh: none right',
    'b en: none right',
    'c zh: none | try /grill-me right',
    'c en: none wrong (hint-missed)',
    'd zh: none wrong (missed)',
    'd en: code-review right',
  ])
})

test("a run reports each part right, each situation's accuracy, each stage's latency, what the gate stopped, and the score of never suggesting anything", async () => {
  const { summary } = await runFour()
  const [v] = summary.variants
  expect(v?.zh.parts).toEqual({ suggest: 0.75, hint: 1 })
  expect(v?.en.parts).toEqual({ suggest: 0.75, hint: 0.75 })
  // Never suggesting or hinting anything is right where nothing fits (b), and the suggestions alone also on c.
  expect(summary.constants).toEqual([{ answer: 'none', accuracy: 0.25, exact: 0.25, parts: { suggest: 0.5, hint: 0.75 } }])
  expect(v?.breakdown).toEqual({
    groups: [
      { group: 'none', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
      { group: 'skill-needed', items: 2, zh: { whole: 0.5, suggest: 0.5, hint: 1 }, en: { whole: 0.5, suggest: 0.5, hint: 1 } },
      { group: 'multi-partial', items: 1, zh: { whole: 0, suggest: 0, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
      { group: 'near-duplicate', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 0, suggest: 0, hint: 1 } },
      { group: 'lexical-trap', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
      { group: 'user-only', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 0, suggest: 1, hint: 0 } },
      { group: 'needs-context', items: 1, zh: { whole: 0, suggest: 0, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
    ],
    // Stage two was asked for 6 of 8 answers (not b zh, c en: the gate said no).
    stages: { first: { answers: 8, p50: 300, p90: 300, max: 300 }, second: { answers: 6, share: 0.75, p50: 200, p90: 200, max: 200 } },
    // Of the items no skill fits (b, c), and of those one does (a, d): the share the gate stopped.
    gate: { zh: { quietStopped: 0.5, neededStopped: 0 }, en: { quietStopped: 0.5, neededStopped: 0 } },
    // Of the items a skill fits (a, d): an acceptable one put forward by stage one, and suggested.
    funnel: { zh: { items: 2, shortlisted: 2, passed: 1 }, en: { items: 2, shortlisted: 2, passed: 1 } },
  })
  expect(v?.latency).toMatchObject({ answers: 8, p50: 500, max: 500 })
})

test('what the variant asks is recorded with the results: stage one over every skill offered, and the questions of stage two for the first two', async () => {
  const suite = await skillSuite({ catalog: CATALOG, read })
  const asked = suite.questions('cookbook') as { first: Record<string, { criteria?: Record<string, unknown> }>; second: Record<string, unknown> }

  expect(suite.variants).toEqual(['cookbook'])
  expect(Object.keys(asked.first)).toEqual(['skills.which', ...GATE])
  expect(asked.first['skills.which']?.criteria?.tdd).toBe(TDD_DESCRIPTION)
  expect(Object.keys(asked.second)).toEqual(['skills.which', 'skills.fits.0', 'skills.fits.1'])
})

test('the estimate counts both stages: stage one as asked, and stage two as if stage one put a full shortlist forward (the skills the item wants first)', async () => {
  const suite = await skillSuite({ catalog: CATALOG, read })
  const net = network(ANSWER)
  await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom({ decisionModel: 'jev' }), variants: ['cookbook'], languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
  // The skills stage two asks about, in order: each fits question names its skill.
  const fitted = (questions: Readonly<Record<string, unknown>>) => Object.values(questions as Record<string, { type?: string; instructions?: unknown }>).flatMap((question) => (question.type === 'noul' ? [fitsSkill(question.instructions)] : []))

  const planned = (await suite.estimate?.(ITEM, 'zh', 'cookbook', settingsFrom({ decisionModel: 'jev' }))) ?? []
  expect(planned).toHaveLength(2)
  expect({ model: JEV_MODEL, ...planned[0] }).toEqual(net.bodies[0])
  expect(fitted(planned[1]?.questions ?? {})).toEqual(['tdd', 'run', 'code-review', 'grill-me'])
  expect(planned[1]?.state).toEqual(planned[0]?.state)
})

test('what the suite read besides its items is recorded with the results, and a warning says what does not match the snapshot', async () => {
  const sha = (name: string, sha256: string) => ({ ...(CATALOG.skills.find((skill) => skill.name === name) as object), sha256 })
  const catalog = {
    skills: [
      // sha256 of the SKILL.md on this disk (worked out by hand with Node's crypto), and one that no longer matches.
      sha('tdd', '7066b6816ecf8ab363edfdb82ff22f8e8c04815c0282a9d1ebd5bd4f6f87a700'),
      sha('code-review', '0'.repeat(64)),
      ...CATALOG.skills.filter((skill) => skill.name !== 'tdd' && skill.name !== 'code-review'),
      { name: 'ghost', description: 'Gone from the disk.', status: 'candidate', engine_source: 'userSettings', path: '~/.claude/skills/ghost/SKILL.md' },
    ],
  }
  const suite = await skillSuite({ catalog, read })

  expect(suite.about).toEqual({
    skills: { offered: 5, model: 4, person: 1 },
    files: { read: 3, unreadable: ['ghost'], changed: ['code-review'] },
    warnings: ['SKILL.md differs from the snapshot for 1 skill: code-review', 'SKILL.md cannot be read for 1 skill: ghost'],
  })
})
