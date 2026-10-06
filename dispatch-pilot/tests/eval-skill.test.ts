// The skill suite of the eval (seam 2): what it asks about an item is what
// the mod asks when the person sends that message after that conversation,
// both stages of the ranking (checked against the mod itself, through seam 1's
// world), and it suggests and hints what the mod would from the same answers.

import { expect, test } from 'claude-code/testing'
import type { PluginOptions, SessionMessage } from 'claude-code'
import { profileKey } from '../hooks/core/profiles.ts'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import type { SkillProfile } from '../hooks/decision/skills.ts'
import type { ContextEntry, SkillItem } from '../eval/lib/datasets.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite } from '../eval/lib/runner.ts'
import { skillSuite } from '../eval/lib/skill.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { isSecondSkillsRequest, rates, world, type Reply, type Sent, type SkillsWorld } from './support/world.ts'

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

/** A profile whose every field names its skill. */
function profileOf(name: string): SkillProfile {
  return {
    en: { what: `${name}: what it does`, use_when: `${name}: when to use it`, not_for: `${name}: when not to` },
    zh: { what: `${name}：用途`, use_when: `${name}：何时用`, not_for: `${name}：何时不用` },
  }
}

/** Each skill's profile under the key the mod files it by in its store (written by haiku from its SKILL.md, or from its description without one). */
const STORE: Record<string, unknown> = Object.fromEntries(
  [
    { name: 'tdd', description: TDD_DESCRIPTION, file: '/home/u/.claude/skills/tdd/SKILL.md' },
    { name: 'run', description: RUN_DESCRIPTION, file: null },
    { name: 'code-review', description: REVIEW_DESCRIPTION, file: '/home/u/.claude/skills/code-review/SKILL.md' },
    { name: 'grill-me', description: GRILL_DESCRIPTION, file: '/home/u/.claude/skills/grill-me/SKILL.md' },
  ].map((skill) => [profileKey(skill, skill.file === null ? null : (DISK[skill.file] as string), 'haiku'), { name: skill.name, at: 1, profile: profileOf(skill.name) }]),
)

/** skill-profiles.json: the same entries as the store holds them. */
const PROFILES = { about: { model: 'haiku' }, profiles: STORE }

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
 * The transcript `$.session.messages()` gives for a conversation the dataset
 * writes as `recent_context`: an assistant reply's tool calls carry their
 * input and output, and each call's result comes back on a user row of its
 * own with no text (Claude Code 2.1.289).
 */
function transcript(context: readonly ContextEntry[]): SessionMessage[] {
  return context.flatMap((entry, i): SessionMessage[] => {
    const tools = entry.tools ?? []
    const uses = tools.map((tool, j) => ({ tool_use_id: `toolu_${i}_${j}`, tool, input: { file_path: '/repo/secret.ts' }, text: 'FILE CONTENT that never travels' }))
    const row: SessionMessage = { role: entry.role, text: entry.text, toolUses: uses }
    if (uses.length === 0) return [row]
    const results: SessionMessage = { role: 'user', text: '', toolUses: [], toolResults: uses.map((use) => ({ tool_use_id: use.tool_use_id, text: use.text, isError: false })) }
    return [row, results]
  })
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
      const reply = answer({ url, method: init.method, headers: { ...(init.headers ?? {}) }, body })
      if (!('status' in reply)) throw new Error('this network only answers')
      return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text: JSON.stringify(reply.body) }
    },
    // The backend's own timeout timer: never fires here; it is aborted once the answer is in.
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, bodies, now: () => 0, pause: async () => {} }
}

/** How the decision model rates this session's skills for the item: tdd first by far; on a second look tdd fits, code-review does not, grill-me does. */
const ANSWER = rates({ tdd: 0.55, 'code-review': 0.2, 'grill-me': 0.15, run: 0.02, '(none)': 0.08 }, { tdd: 0.93, 'code-review': 0.4, 'grill-me': 0.81 })

for (const language of ['zh', 'en'] as const) {
  test(`the eval asks about an item what the mod asks when the person sends its message after its conversation, in both stages, each skill offered by its profile (${language})`, { options: { typesafeApiKey: 'k' } }, async ($, on) => {
    const w = world($, on, { backend: ANSWER, skills: SKILLS, disk: DISK, store: STORE, messages: transcript(ITEM[language].recent_context) })
    await w.submit(ITEM[language].message)

    const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
    const net = network(ANSWER)
    await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom({}), variants: ['profiles'], languages: [language], timeoutMs: 10_000, retries: 0, concurrency: 1 })

    expect(w.requests).toHaveLength(2)
    expect(net.bodies).toEqual(w.requests.map((request) => request.body))
    // What the two requests hold, so the equality above is not two empty things:
    // every skill the main agent can load in one question, the person's own in another, each by its profile;
    const which = w.requests[0]?.body.questions['skills.which']
    expect(Object.keys(which.criteria)).toEqual(['tdd', 'run', 'code-review', '(none)'])
    expect(which.criteria.run).toMatchObject({ what: 'run: what it does', 用途: 'run：用途' })
    expect(Object.keys(w.requests[0]?.body.questions['skills.hint'].criteria)).toEqual(['grill-me', '(none)'])
    expect(String(w.requests[0]?.body.state.recent_context)).toContain('[tools: Grep, Read]')
    // the second re-reads the three rated 0.1 or more in their question, with the opening of each SKILL.md.
    expect(Object.keys(w.requests[1]?.body.questions)).toEqual(['skills.best', 'skills.fits.0', 'skills.fits.1', 'skills.fits.2'])
    expect(w.requests[1]?.body.questions['skills.fits.2'].instructions.skill.opening).toContain('Interview me relentlessly')
  })
}

/**
 * The same answers under some of the person's options: what the mod shows the
 * main agent and the person (the skills its decision suggests, and those it
 * names for the person to try), and what the eval records for the item.
 */
const PICKS: { options: PluginOptions; suggest: string[]; tried: string[]; shown: string }[] = [
  { options: {}, suggest: ['tdd'], tried: ['grill-me'], shown: 'tdd | try /grill-me' },
  // grill-me fits 0.81, tdd 0.93.
  { options: { skillsMinRelevance: 0.85 }, suggest: ['tdd'], tried: [], shown: 'tdd' },
  { options: { skillsMax: 0 }, suggest: [], tried: ['grill-me'], shown: 'none | try /grill-me' },
  // Never offered: stage one rates the rest, and tdd is neither asked about nor suggested.
  { options: { skillsNeverSuggested: ['tdd'] }, suggest: [], tried: ['grill-me'], shown: 'none | try /grill-me' },
]

for (const { options, suggest, tried, shown } of PICKS) {
  test(`from the same answers the eval suggests and hints what the mod does, under the person's options (${JSON.stringify(options)})`, { options: { typesafeApiKey: 'k', ...options } }, async ($, on) => {
    const w = world($, on, { backend: ANSWER, skills: SKILLS, disk: DISK, store: STORE, messages: transcript(ITEM.zh.recent_context) })
    await w.submit(ITEM.zh.message)
    await w.step({ index: 0 })

    const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
    const net = network(ANSWER)
    const [row] = await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom(options), variants: ['profiles'], languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })

    const picked = (await w.board()).log.findLast((entry) => entry.feature === 'skills')?.skills
    expect(picked?.suggest.map((skill) => skill.name)).toEqual(suggest)
    expect(picked?.try.map((skill) => skill.name)).toEqual(tried)
    expect(row?.shown).toBe(shown)
    expect(net.bodies).toEqual(w.requests.map((request) => request.body))
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
  const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
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
 * Four items and how the decision model rates the skills for each, zh | en:
 * stage one's shares, then how well each skill it put forward fits.
 *   a  tdd .93: tdd | tdd .75 and code-review .72 (must_not)
 *   b  nothing put forward | run .60 (nothing fits)
 *   c  grill-me .85 | grill-me .65 (to hint)
 *   d  code-review .55 | code-review .90
 */
const FOUR = [
  answered('a', { gold: ['tdd'], must_not: ['code-review'] }, ['near-duplicate']),
  answered('b', {}, ['none', 'lexical-trap']),
  answered('c', { hint: ['grill-me'] }, ['user-only']),
  answered('d', { gold: ['code-review'] }, ['multi-partial', 'needs-context']),
]
const RATED: Record<string, { shares: Record<string, number>; fits: Record<string, number> }> = {
  'a zh': { shares: { tdd: 0.7, '(none)': 0.3 }, fits: { tdd: 0.93 } },
  'a en': { shares: { tdd: 0.5, 'code-review': 0.4, '(none)': 0.1 }, fits: { tdd: 0.75, 'code-review': 0.72 } },
  'b zh': { shares: { '(none)': 1 }, fits: {} },
  'b en': { shares: { run: 0.3, '(none)': 0.7 }, fits: { run: 0.6 } },
  'c zh': { shares: { 'grill-me': 0.6, '(none)': 0.4 }, fits: { 'grill-me': 0.85 } },
  'c en': { shares: { 'grill-me': 0.2, '(none)': 0.8 }, fits: { 'grill-me': 0.65 } },
  'd zh': { shares: { 'code-review': 0.9, '(none)': 0.1 }, fits: { 'code-review': 0.55 } },
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
  const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
  // The bar these answers were written around (a en's code-review at 0.72 passes it), not today's default of 0.75.
  const settings = settingsFrom({ skillsMinRelevance: 0.7 })
  const rows = await runSuite(suite, FOUR, { backend: jevBackend('k'), ...ratedNetwork(), settings, variants: ['profiles'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
  return { rows, summary: summarize(suite, FOUR, rows, { slowMs: 1500, settings }) }
}

test('what an answer records: what stage one put forward (the skills the main agent can load, then those only the person can start), how well each fits by stage two, how long each stage took', async () => {
  const { rows } = await runFour()
  const row = (key: string) => rows.find((r) => `${r.id} ${r.language}` === key)

  expect(row('a en')?.detail).toEqual({
    first: [{ name: 'tdd', share: 0.5 }, { name: 'code-review', share: 0.4 }],
    none: 0.1,
    hints: [],
    fits: [{ name: 'tdd', relevance: 0.75 }, { name: 'code-review', relevance: 0.72 }],
    stages_ms: [300, 200],
  })
  expect(row('a en')?.shown).toBe('code-review, tdd')
  expect(row('c zh')?.detail).toEqual({ first: [], none: 1, hints: [{ name: 'grill-me', share: 0.6 }], fits: [{ name: 'grill-me', relevance: 0.85 }], stages_ms: [300, 200] })
  // Nothing put forward: no second request.
  expect(row('b zh')?.detail).toEqual({ first: [], none: 1, hints: [], fits: [], stages_ms: [300] })
  expect(row('b zh')?.ms).toBe(300)
  expect(rows.map((r) => `${r.id} ${r.language}: ${r.shown} ${r.correct ? 'right' : `wrong (${r.miss})`}`)).toEqual([
    'a zh: tdd right',
    'a en: code-review, tdd wrong (must-not)',
    'b zh: none right',
    'b en: none right',
    'c zh: none | try /grill-me right',
    'c en: none wrong (hint-missed)',
    'd zh: none wrong (missed)',
    'd en: code-review right',
  ])
})

test("a run reports each part right, each situation's accuracy, each stage's latency, and the score of never suggesting anything", async () => {
  const { summary } = await runFour()
  const [v] = summary.variants
  expect(v?.zh.parts).toEqual({ suggest: 0.75, hint: 1 })
  expect(v?.en.parts).toEqual({ suggest: 0.75, hint: 0.75 })
  // Never suggesting or hinting anything is right where nothing fits (b), and the suggestions alone also on c.
  expect(summary.constants).toEqual([{ answer: 'none', accuracy: 0.25, exact: 0.25, parts: { suggest: 0.5, hint: 0.75 } }])
  expect(v?.breakdown).toMatchObject({
    groups: [
      { group: 'none', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
      { group: 'skill-needed', items: 2, zh: { whole: 0.5, suggest: 0.5, hint: 1 }, en: { whole: 0.5, suggest: 0.5, hint: 1 } },
      { group: 'multi-partial', items: 1, zh: { whole: 0, suggest: 0, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
      { group: 'near-duplicate', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 0, suggest: 0, hint: 1 } },
      { group: 'lexical-trap', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
      { group: 'user-only', items: 1, zh: { whole: 1, suggest: 1, hint: 1 }, en: { whole: 0, suggest: 1, hint: 0 } },
      { group: 'needs-context', items: 1, zh: { whole: 0, suggest: 0, hint: 1 }, en: { whole: 1, suggest: 1, hint: 1 } },
    ],
    // Stage two was asked for 7 of 8 answers (not b zh).
    stages: { first: { answers: 8, p50: 300, p90: 300, max: 300 }, second: { answers: 7, share: 0.875, p50: 200, p90: 200, max: 200 } },
    // Of the items a skill fits (a, d): one acceptable put forward by stage one, and passing the bar.
    funnel: { zh: { items: 2, shortlisted: 2, passed: 1 }, en: { items: 2, shortlisted: 2, passed: 2 } },
  })
  expect(v?.latency).toMatchObject({ answers: 8, p50: 500, max: 500 })
})

type Swept = { value: number; current?: true; zh: Record<string, number>; en: Record<string, number> }

test("both relevance bars are swept over the answers already given, by language; at the run's own values the sweep is the run", async () => {
  const { summary } = await runFour()
  const [v] = summary.variants
  const sweeps = v?.breakdown?.sweeps as Record<string, Swept[]>
  const line = (name: string, language: 'zh' | 'en', field: string) => sweeps[name]?.map((swept) => `${swept.value}${swept.current ? '*' : ''} ${swept[language][field]}`).join(', ')

  // skillsMinRelevance: the skills suggested and hinted again at each bar (at most skillsMax).
  expect(line('skillsMinRelevance', 'zh', 'whole')).toBe('0.3 1, 0.4 1, 0.5 1, 0.6 0.75, 0.65 0.75, 0.7* 0.75, 0.75 0.75, 0.8 0.75, 0.85 0.75, 0.9 0.5, 0.95 0.25')
  expect(line('skillsMinRelevance', 'en', 'whole')).toBe('0.3 0.5, 0.4 0.5, 0.5 0.5, 0.6 0.5, 0.65 0.75, 0.7* 0.5, 0.75 0.75, 0.8 0.5, 0.85 0.5, 0.9 0.5, 0.95 0.25')
  // findSkillMinRelevance: what find_skill would return (at most findSkillMax, never a skill only the person can start), graded as suggestions.
  expect(line('findSkillMinRelevance', 'zh', 'suggest')).toBe('0.3 1, 0.4 1, 0.5* 1, 0.6 0.75, 0.65 0.75, 0.7 0.75, 0.75 0.75, 0.8 0.75, 0.85 0.75, 0.9 0.75, 0.95 0.5')
  expect(line('findSkillMinRelevance', 'en', 'suggest')).toBe('0.3 0.5, 0.4 0.5, 0.5* 0.5, 0.6 0.5, 0.65 0.75, 0.7 0.75, 0.75 1, 0.8 0.75, 0.85 0.75, 0.9 0.75, 0.95 0.5')
  // find_skill's recall: of the items a skill fits, those it returns an acceptable skill for.
  expect(line('findSkillMinRelevance', 'en', 'recall')).toBe('0.3 1, 0.4 1, 0.5* 1, 0.6 1, 0.65 1, 0.7 1, 0.75 1, 0.8 0.5, 0.85 0.5, 0.9 0.5, 0.95 0')
  expect(v?.breakdown?.best).toEqual({
    skillsMinRelevance: { zh: { whole: 1, values: [0.3, 0.4, 0.5] }, en: { whole: 0.75, values: [0.65, 0.75] } },
    findSkillMinRelevance: { zh: { suggest: 1, values: [0.3, 0.4, 0.5] }, en: { suggest: 1, values: [0.75] } },
  })
})

test('what each variant asks is recorded with the results: the effort question, stage one over every skill offered (in its two questions), and the questions of stage two', async () => {
  const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
  const profiles = suite.questions('profiles') as { first: Record<string, { criteria?: Record<string, unknown> }>; second: Record<string, unknown> }
  const descriptions = suite.questions('descriptions') as typeof profiles

  expect(Object.keys(profiles.first)).toEqual(['effort.level', 'skills.which', 'skills.hint'])
  expect(profiles.first['skills.which']?.criteria?.tdd).toMatchObject({ what: 'tdd: what it does' })
  expect(profiles.first['skills.hint']?.criteria?.['grill-me']).toMatchObject({ what: 'grill-me: what it does' })
  expect(descriptions.first['skills.hint']?.criteria?.['grill-me']).toBe(GRILL_DESCRIPTION)
  expect(Object.keys(profiles.second)).toEqual(['skills.best', 'skills.fits.0', 'skills.fits.1'])
})

test("the profiles-zh variant asks what profiles asks, with the skill questions of both stages in Chinese; the effort question beside them is the same (the run's decision model's)", async () => {
  const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
  type Body = { state: unknown; questions: Record<string, { instructions?: Record<string, unknown>; criteria?: Record<string, unknown> }> }
  const sent = async (variant: string): Promise<Body[]> => {
    const net = network(ANSWER)
    await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom({}), variants: [variant], languages: ['en'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
    return net.bodies as Body[]
  }
  const english = await sent('profiles')
  const chinese = await sent('profiles-zh')

  // Both stages, about the same state, the same questions in the same order, over the same skills.
  expect(chinese).toHaveLength(2)
  expect(chinese.map((body) => body.state)).toEqual(english.map((body) => body.state))
  expect(chinese.map((body) => Object.keys(body.questions))).toEqual(english.map((body) => Object.keys(body.questions)))
  expect(Object.keys(chinese[0]?.questions['skills.which']?.criteria ?? {})).toEqual(['tdd', 'run', 'code-review', '(none)'])
  expect(chinese[0]?.questions['effort.level']).toEqual(english[0]?.questions['effort.level'])
  // The skill questions as the mod's ranker writes them in Chinese (decision/skills.ts).
  expect(chinese[0]?.questions['skills.which']?.instructions?.问题).toBe('结合 `recent_context`，要完成 `user_message` 所要求的工作，应该加载下面哪个 skill？如果都不合适，选「都不合适」。')
  expect(chinese[0]?.questions['skills.hint']?.instructions?.问题).toBe('结合 `recent_context`，要完成 `user_message` 所要求的工作，下面哪个 skill 合适？这些 skill 由用户自己输入名字来启动。如果都不合适，选「都不合适」。')
  expect(chinese[1]?.questions['skills.best']?.instructions?.问题).toBe('结合 `recent_context`，要完成 `user_message` 所要求的工作，下面这些 skill 中正好有一个最该加载。是哪一个？')
  expect(chinese[1]?.questions['skills.fits.0']?.instructions?.问题).toBe('结合 `recent_context`，`skill` 是否正好做 `user_message` 所要求的那种工作？')
  expect(english[1]?.questions['skills.fits.0']?.instructions?.question).toBe('Does `skill` do the specific kind of work that `user_message` asks for, given `recent_context`?')
  // What the variant asks is recorded with the results in Chinese too.
  const recorded = suite.questions('profiles-zh') as { first: Body['questions']; second: Body['questions'] }
  expect(recorded.first['skills.which']?.instructions?.问题).toBe(chinese[0]?.questions['skills.which']?.instructions?.问题)
  expect(Object.keys(recorded.second['skills.fits.0']?.instructions ?? {})).toContain('问题')
})

test('the estimate counts both stages: stage one as asked, and stage two as if stage one put a full shortlist forward (the skills the item wants first)', async () => {
  const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
  const net = network(ANSWER)
  await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom({}), variants: ['profiles'], languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
  // The skills stage two asks about, in order: each fits question names its skill.
  const fitted = (questions: Readonly<Record<string, unknown>>) => Object.values(questions as Record<string, { instructions?: { skill?: { name?: string } } }>).flatMap((question) => question.instructions?.skill?.name ?? [])

  const planned = (await suite.estimate?.(ITEM, 'zh', 'profiles', settingsFrom({}))) ?? []
  expect(planned).toHaveLength(2)
  expect({ model: JEV_MODEL, ...planned[0] }).toEqual(net.bodies[0])
  expect(fitted(planned[1]?.questions ?? {})).toEqual(['tdd', 'run', 'code-review', 'grill-me'])
  expect(planned[1]?.state).toEqual(planned[0]?.state)

  // skillsShortlist counts the skills the main agent can load; up to two only the person can start come beside them.
  const two = (await suite.estimate?.(ITEM, 'zh', 'profiles', settingsFrom({ skillsShortlist: 2 }))) ?? []
  expect(fitted(two[1]?.questions ?? {})).toEqual(['tdd', 'run', 'grill-me'])
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
  const reviewKey = profileKey({ name: 'code-review', description: REVIEW_DESCRIPTION }, DISK['/home/u/.claude/skills/code-review/SKILL.md'] as string, 'haiku')
  const { [reviewKey]: _dropped, ...rest } = STORE
  const suite = await skillSuite({ catalog, profiles: { profiles: rest }, read })

  expect(suite.about).toEqual({
    skills: { offered: 5, model: 4, person: 1 },
    profiles: { model: 'haiku', with: 3, without: ['code-review', 'ghost'] },
    files: { read: 3, unreadable: ['ghost'], changed: ['code-review'] },
    warnings: [
      'SKILL.md differs from the snapshot for 1 skill: code-review',
      'SKILL.md cannot be read for 1 skill: ghost',
      'no profile in skill-profiles.json for 2 skills (the profiles variant offers them by their descriptions): code-review, ghost',
    ],
  })
})

test('the descriptions variant asks what the mod asks before any profile is written: each skill by its description', { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  // No store: the mod finds no profile, as on a first session.
  const w = world($, on, { backend: ANSWER, skills: SKILLS, disk: DISK, messages: transcript(ITEM.zh.recent_context) })
  await w.submit(ITEM.zh.message)

  const suite = await skillSuite({ catalog: CATALOG, profiles: PROFILES, read })
  const net = network(ANSWER)
  await runSuite(suite, [ITEM], { backend: jevBackend('k'), ...net, settings: settingsFrom({}), variants: ['descriptions'], languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })

  expect(net.bodies).toEqual(w.requests.map((request) => request.body))
  expect(w.requests[0]?.body.questions['skills.which'].criteria['code-review']).toBe(REVIEW_DESCRIPTION)
  expect(w.requests[1]?.body.questions['skills.fits.0'].instructions.skill).toEqual({
    name: 'tdd',
    description: TDD_DESCRIPTION,
    opening: '# Test-Driven Development Write one failing test, then only the code that makes it pass.',
  })
})
