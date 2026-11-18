import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { DREX_URL, JEV_URL } from '../hooks/backend.ts'
import type { Answer } from '../hooks/backend.ts'
import type { Decision } from '../hooks/log.ts'
import {
  ACTION_BAR,
  BATCH,
  FITS_BAR,
  LISTING_NOTE,
  NAMED_BAR,
  SHORTLIST,
  findSkillReply,
  parseListing,
  pick,
  pickMany,
  shortlist,
  stageOne,
  stageTwo,
  suggestionBlock,
  wantsSkill,
} from '../hooks/skills.ts'
import type { Skill } from '../hooks/skills.ts'
import { KEYS, dp, drexOk, noul, score, start, step, submit, turns, world } from './support/world.ts'

type World = ReturnType<typeof world>

const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const skillDecisions = (w: World): Decision[] => logged(w).filter((d) => d.kind === 'skill')
const submitDecisions = (w: World): Decision[] => logged(w).filter((d) => d.kind === 'submit')
const skillWrites = (w: World): unknown[] => w.stateWrites.filter((s) => s.key === 'skills' && s.isSet).map((s) => s.value)
const efforts = (w: World): unknown[] => w.stepsSent.map((s) => s.effort)

const PDF: Skill = { name: 'pdf', description: 'Fill in, merge and split PDF files.' }
const XLSX: Skill = { name: 'anthropic-skills:xlsx', description: 'Read, write and chart spreadsheets.' }
const WRANGLER: Skill = { name: 'cloudflare:wrangler', description: 'Run or troubleshoot Wrangler CLI commands.' }
const BRAIN: Skill = { name: 'superpowers:brainstorming', description: 'You MUST use this before any creative work.' }
const GSAP: Skill = { name: 'gsap-core', description: '' }
const FIVE = [PDF, XLSX, WRANGLER, BRAIN, GSAP]

// A listing as the engine words it in an ordinary session: a preamble, then one line per skill.
function listingOf(skills: Skill[]): string {
  const lines = skills.map((s) => (s.description ? '- ' + s.name + ': ' + s.description : '- ' + s.name))
  return ['The following skills are available for use with the Skill tool:', '', ...lines].join('\n')
}

function attach($: Engine, text: string, agentId?: string) {
  return $.prompt.attachment({ type: 'skill_listing', text, origin: { kind: 'engine' }, ...(agentId === undefined ? {} : { agentId }) })
}

function findSkill($: Engine, text: string, pluginName = 'dispatch-pilot') {
  return $.skill.prompt({ skill: 'dispatch-pilot:find-skill', text, pluginName, source: 'plugin', frontmatter: {} })
}

// Answers whose level, read from medium, is high.
const RAISE = { open: score([0.02, 0.08, 0.25, 0.55, 0.1]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
const EFFORT_IDS = ['open', 'mechanical', 'unknown_cause', 'continues']
const GATE_IDS = ['acts_on_user_system', 'would_follow_documented_procedure', 'prose_suffices', 'named']

type Gates = { acts: number; procedure: number; prose: number; named: number }
// The action answers average (0.8 + 0.6 + 0.8) / 3 = 0.73: a skill is wanted.
const WANTED: Gates = { acts: 0.8, procedure: 0.6, prose: 0.2, named: 0.1 }
// (0.1 + 0.2 + 0.4) / 3 = 0.23, under 0.30, and named 0.2, under 0.50: nothing is wanted.
const NOT_WANTED: Gates = { acts: 0.1, procedure: 0.2, prose: 0.6, named: 0.2 }

// A choice answer over the options asked: each named option weighs what is given, the rest 0.01; the heaviest is chosen.
function choiceOf(options: string[], weights: Record<string, number>) {
  const raw = options.map((o) => weights[o] ?? 0.01)
  const sum = raw.reduce((s, x) => s + x, 0)
  const probabilities = Object.fromEntries(options.map((o, i) => [o, raw[i]! / sum]))
  const choice = options.reduce((best, o) => (probabilities[o]! > probabilities[best]! ? o : best), options[0]!)
  return { type: 'choice', choice, probabilities }
}

type Plan = {
  effort?: Record<string, unknown>
  gates?: Gates
  /** Stage one's choice weights by skill name. */
  first?: Record<string, number>
  which?: string
  /** Each fits noul by skill name; 0.1 for one not given. */
  fits?: Record<string, number>
  /** Questions left out of the answer. */
  drop?: string[]
  model?: string
}

// Answers every question a request asks, the effort ones and the skill ones alike, as the plan says.
function answering(p: Plan) {
  return ({ body }: { body: any }) => {
    const out: Record<string, unknown> = {}
    const gates = p.gates ?? WANTED
    const gateOf: Record<string, number> = { acts_on_user_system: gates.acts, would_follow_documented_procedure: gates.procedure, prose_suffices: gates.prose, named: gates.named }
    for (const [id, q] of Object.entries(body.questions as Record<string, any>)) {
      if (EFFORT_IDS.includes(id)) out[id] = (p.effort ?? RAISE)[id as 'open'] ?? noul(0.1)
      else if (id.startsWith('skill_')) out[id] = choiceOf(Object.keys(q.criteria), p.first ?? {})
      else if (id === 'which') out[id] = choiceOf(Object.keys(q.criteria), { [p.which ?? '']: 1 })
      else if (id.startsWith('fits_')) out[id] = noul(p.fits?.[/Does the skill '([^']+)'/.exec(q.instructions)![1]!] ?? 0.1)
      else out[id] = noul(gateOf[id] ?? 0.5)
    }
    for (const id of p.drop ?? []) delete out[id]
    return drexOk(out, p.model)
  }
}

const TASK = 'Fill in the tax form in ~/Downloads/form.pdf with my details'

// Folds the listing and sends one message, its turn started inside prompt.submit as the engine does.
async function sendWithListing($: Engine, w: World, skills: Skill[] = FIVE, text = TASK) {
  await start($)
  await attach($, listingOf(skills))
  await submit($, text)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
}

// The brief's twelve.

test('parseListing：带冒号的名字、跨行的说明、标题行不算', () => {
  // Lines as the real 2.1.327 listing has them (real-skill-listing.txt).
  const text = [
    'The following skills are available for use with the Skill tool:',
    '',
    '- gsap-core',
    '- code-review:code-review: Code review a pull request',
    '- superpowers:brainstorming: You MUST use this before any creative work - creating features, building components.',
    '- claude-api: Reference for the Claude API / Anthropic SDK — model ids, pricing.',
    'TRIGGER — read FIRST, before you answer: the prompt names Claude/Anthropic in any form.',
    'SKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini.',
    '- init: Initialize a new CLAUDE.md file with codebase documentation',
  ].join('\n')
  expect(parseListing(text)).toEqual([
    { name: 'gsap-core', description: '' },
    { name: 'code-review:code-review', description: 'Code review a pull request' },
    { name: 'superpowers:brainstorming', description: 'You MUST use this before any creative work - creating features, building components.' },
    {
      name: 'claude-api',
      description:
        'Reference for the Claude API / Anthropic SDK — model ids, pricing.\nTRIGGER — read FIRST, before you answer: the prompt names Claude/Anthropic in any form.\nSKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini.',
    },
    { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
  ])
})

test('主循环的列表换成 LISTING_NOTE，候选存下；agent 的列表不动', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  const text = listingOf(FIVE)
  const forAgent = await attach($, text, 'agent-1')
  expect(forAgent.text).toBe(text)
  expect(skillWrites(w)).toEqual([])

  const forMain = await attach($, text)
  expect(forMain.text).toBe(LISTING_NOTE)
  expect(skillWrites(w)).toEqual([FIVE])
  // Both went through to the engine as they came: the mod answers on the way back.
  expect(w.attachments.map((a) => a.text)).toEqual([text, text])
})

test('没有密钥：列表原样', { options: {} }, async ($, on) => {
  const w = world(on)
  await start($)
  const r = await attach($, listingOf(FIVE))
  expect(r.text).toBe(listingOf(FIVE))
  expect(w.attachments).toHaveLength(1)
  expect(skillWrites(w)).toEqual([])
})

test('skills 关着：列表原样', { options: { ...KEYS, skills: false } }, async ($, on) => {
  const w = world(on)
  await start($)
  const r = await attach($, listingOf(FIVE))
  expect(r.text).toBe(listingOf(FIVE))
  expect(skillWrites(w)).toEqual([])
})

test('shadow：列表原样', { options: { ...KEYS, mode: 'shadow' } }, async ($, on) => {
  const w = world(on)
  await start($)
  const r = await attach($, listingOf(FIVE))
  expect(r.text).toBe(listingOf(FIVE))
  expect(skillWrites(w)).toEqual([])
})

test('发消息：一次请求里既有 effort 题也有 skill_0 和四道门控题', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: NOT_WANTED }) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(1)
  expect(w.fetched[0]!.url).toBe(DREX_URL)
  const qs = w.fetched[0]!.body.questions
  expect(Object.keys(qs)).toEqual(['open', 'mechanical', 'unknown_cause', 'skill_0', ...GATE_IDS])
  expect(w.fetched[0]!.body.state.request).toBe(TASK)
  // The cookbook's words, verbatim; the options are the skills by source (no prefix first), each with its description.
  expect(qs.skill_0).toEqual({
    type: 'choice',
    instructions: 'Which of these skills, if any, is the right one to load to help with the user\'s latest request?',
    criteria: { pdf: PDF.description, 'gsap-core': null, 'anthropic-skills:xlsx': XLSX.description, 'cloudflare:wrangler': WRANGLER.description, 'superpowers:brainstorming': BRAIN.description, other: null },
  })
  expect(qs.acts_on_user_system).toEqual({
    type: 'noul',
    instructions: "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
    criteria: { true: 'Yes.', false: 'No.' },
  })
  expect(qs.would_follow_documented_procedure.instructions).toBe(
    'Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?',
  )
  expect(qs.prose_suffices.instructions).toBe(
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
  )
  expect(qs.named.instructions).toBe('Does the request ask for a specific named tool, format, template, or method to be used, rather than for general help?')
  // The effort decision is taken from the same answers.
  expect(efforts(w)).toEqual(['high'])
  expect(submitDecisions(w)).toHaveLength(1)
  expect(Object.keys(submitDecisions(w)[0]!.raw!)).toEqual(['open', 'mechanical', 'unknown_cause'])
})

test('动作题平均低于 0.30 且点名题低于 0.50：不发第二次请求，context 不变', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: NOT_WANTED, first: { pdf: 0.9 } }) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(1)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]!.text).toBe(TASK)
  expect(w.submitted[0]!.context).toBeUndefined()
  const d = skillDecisions(w)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ kind: 'skill', to: null, from: null, applied: false, failure: null, turnId: 't1', step: 0, backend: 'drex', model: 'drex-max-v1.1' })
  expect(d[0]!.detail).toContain('0.23')
  expect(Object.keys(d[0]!.raw!)).toEqual(['skill_0', ...GATE_IDS])
})

test('动作题过了：第二次请求有 which 和三道 fits；fits 够高时 context 多一段，写着选中的 skill 名', { options: KEYS }, async ($, on) => {
  const w = world(on, {
    onSubmit: turns($),
    answer: answering({ gates: WANTED, first: { pdf: 0.6, 'anthropic-skills:xlsx': 0.2, 'cloudflare:wrangler': 0.1 }, which: 'pdf', fits: { pdf: 0.9 } }),
  })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(2)
  const second = w.fetched[1]!.body
  expect(second.state).toEqual(w.fetched[0]!.body.state)
  expect(Object.keys(second.questions)).toEqual(['which', 'fits_0', 'fits_1', 'fits_2'])
  expect(second.questions.which).toEqual({
    type: 'choice',
    instructions: 'Exactly one of these skills is the right one to load for the user\'s latest request. Which one? Read what each actually does, not just its name.',
    criteria: { pdf: PDF.description, 'anthropic-skills:xlsx': XLSX.description, 'cloudflare:wrangler': WRANGLER.description, other: null },
  })
  expect(second.questions.fits_0).toEqual({
    type: 'noul',
    instructions: "Does the skill 'pdf' do the specific thing the user's request asks for? It is described as: " + PDF.description,
    criteria: { true: 'Yes.', false: 'No.' },
  })
  expect(second.questions.fits_1.instructions).toContain("'anthropic-skills:xlsx'")

  expect(w.submitted[0]!.text).toBe(TASK)
  expect(w.submitted[0]!.context).toEqual([suggestionBlock(PDF)])
  expect(suggestionBlock(PDF)).toContain('pdf')
  expect(suggestionBlock(PDF)).toContain(PDF.description)
  expect(suggestionBlock(PDF)).toContain('Skill tool')

  const d = skillDecisions(w)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ kind: 'skill', to: 'pdf', detail: '', applied: true, failure: null, turnId: 't1', step: 0 })
  expect(Object.keys(d[0]!.raw!)).toEqual(['skill_0', ...GATE_IDS, 'which', 'fits_0', 'fits_1', 'fits_2'])
  // The effort decision stands beside it.
  expect(efforts(w)).toEqual(['high'])
})

test('只有点名题过了 0.50 也发第二次请求', { options: KEYS }, async ($, on) => {
  const gates = { ...NOT_WANTED, named: 0.87 }
  const w = world(on, { onSubmit: turns($), answer: answering({ gates, first: { 'superpowers:brainstorming': 0.7 }, which: 'superpowers:brainstorming', fits: { 'superpowers:brainstorming': 0.8 } }) })
  await sendWithListing($, w, FIVE, 'Brainstorm a name for the project with the brainstorming method')

  expect(w.fetched).toHaveLength(2)
  expect(Object.keys(w.fetched[1]!.body.questions)).toContain('which')
  expect(w.submitted[0]!.context).toEqual([suggestionBlock(BRAIN)])
  expect(skillDecisions(w)[0]).toMatchObject({ to: 'superpowers:brainstorming', applied: true })
})

test('fits 最高的低于 0.30：不推荐', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.29, 'anthropic-skills:xlsx': 0.2 } }) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(2)
  expect(w.submitted[0]!.context).toBeUndefined()
  const d = skillDecisions(w)[0]!
  expect(d).toMatchObject({ to: null, applied: false, failure: null })
  expect(d.detail).toContain('0.29')
  expect(Object.keys(d.raw!)).toContain('fits_2')
})

test('Drex 的选择题有 other，Jev 没有；选中 other 不推荐', { options: { backend: 'jev', jevApiKey: 'k-jev' } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.9 }, model: 'jev-1.14.0' }) })
  await sendWithListing($, w)

  expect(w.fetched.map((f) => f.url)).toEqual([JEV_URL, JEV_URL])
  expect(Object.keys(w.fetched[0]!.body.questions.skill_0.criteria)).not.toContain('other')
  expect(Object.keys(w.fetched[0]!.body.questions.skill_0.criteria)).toHaveLength(5)
  expect(Object.keys(w.fetched[1]!.body.questions.which.criteria)).toEqual(['pdf', 'gsap-core', 'anthropic-skills:xlsx'])
  // Jev's own answer is taken as it comes.
  expect(w.submitted[0]!.context).toEqual([suggestionBlock(PDF)])

  // Drex's questions carry other, and an answer that picks it suggests nothing.
  expect(Object.keys(stageOne(FIVE, 'drex', true).skill_0!.criteria)).toContain('other')
  expect(Object.keys(stageTwo([PDF, XLSX], 'drex').which!.criteria)).toEqual(['pdf', 'anthropic-skills:xlsx', 'other'])
  const short = [PDF, XLSX, WRANGLER]
  const fits = { fits_0: { type: 'noul', noul: 0.9 }, fits_1: { type: 'noul', noul: 0.2 }, fits_2: { type: 'noul', noul: 0.1 } } as Record<string, Answer>
  expect(pick(short, { ...fits, which: { type: 'choice', choice: 'other', probabilities: { pdf: 0.3, 'anthropic-skills:xlsx': 0.1, 'cloudflare:wrangler': 0.1, other: 0.5 } } })).toBeNull()
  expect(pick(short, { ...fits, which: { type: 'choice', choice: 'pdf', probabilities: { pdf: 0.7, 'anthropic-skills:xlsx': 0.1, 'cloudflare:wrangler': 0.1, other: 0.1 } } })).toEqual(PDF)
})

test('Drex 的第二次请求选中 other：不推荐', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'other', fits: { pdf: 0.9 } }) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(2)
  expect(Object.keys(w.fetched[1]!.body.questions.which.criteria)).toContain('other')
  expect(w.submitted[0]!.context).toBeUndefined()
  expect(skillDecisions(w)[0]).toMatchObject({ to: null, applied: false, failure: null })
  expect(skillDecisions(w)[0]!.detail).toContain('other')
})

test('超过 250 个候选：分成 skill_0 和 skill_1 两道', { options: KEYS }, async ($, on) => {
  // 160 from a source late in the alphabet listed first, then 140 from an early one.
  const many: Skill[] = [
    ...Array.from({ length: 160 }, (_, i) => ({ name: 'zeta:s' + i, description: 'Zeta skill ' + i + '.' })),
    ...Array.from({ length: 140 }, (_, i) => ({ name: 'alpha:s' + i, description: 'Alpha skill ' + i + '.' })),
  ]
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: NOT_WANTED }) })
  await sendWithListing($, w, many)

  expect(skillWrites(w)).toEqual([many])
  const qs = w.fetched[0]!.body.questions
  expect(Object.keys(qs).filter((k) => k.startsWith('skill_'))).toEqual(['skill_0', 'skill_1'])
  const zero = Object.keys(qs.skill_0.criteria)
  const one = Object.keys(qs.skill_1.criteria)
  // Each batch is at most BATCH skills, plus Drex's other.
  expect(zero.length <= BATCH + 1 && one.length <= BATCH + 1).toBe(true)
  expect(zero.at(-1)).toBe('other')
  expect(one.at(-1)).toBe('other')
  // By source: every alpha before any zeta, each source in listing order.
  const names = [...zero, ...one].filter((n) => n !== 'other')
  expect(names).toEqual([...many.slice(160), ...many.slice(0, 160)].map((s) => s.name))
})

test('第二次请求赶不上时限：不推荐，effort 的决定照常生效', { options: KEYS }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const answer = answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.9 } })
  const w = world(on, {
    onSubmit: turns($),
    answer: async (req) => {
      // The first request takes 3600 ms of the 4000: 400 are left, under the 500 a second one needs.
      await late.clock!.sleep(3600)
      return answer(req)
    },
  })
  late.clock = w.clock
  await start($)
  await attach($, listingOf(FIVE))
  const sent = submit($, TASK)
  await w.clock.settle()
  await w.clock.advance(3600)
  await sent
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })

  expect(w.fetched).toHaveLength(1)
  expect(w.submitted[0]!.context).toBeUndefined()
  expect(efforts(w)).toEqual(['high', 'high'])
  expect(submitDecisions(w)[0]).toMatchObject({ from: 'medium', to: 'high', applied: true, failure: null })
  const d = skillDecisions(w)[0]!
  expect(d).toMatchObject({ to: null, applied: false, failure: null, ms: 3600 })
  expect(d.detail).toContain('500')
})

test('find-skill：不问门控题，回答里最多三个 skill 名；后端失败时写明没查成', { options: KEYS }, async ($, on) => {
  const down = { yes: false }
  const answer = answering({ first: { pdf: 0.5, 'anthropic-skills:xlsx': 0.3, 'cloudflare:wrangler': 0.1 }, which: 'pdf', fits: { pdf: 0.9, 'anthropic-skills:xlsx': 0.6, 'cloudflare:wrangler': 0.5 } })
  const w = world(on, { answer: (req) => (down.yes ? null : answer(req)) })
  await start($)
  await attach($, listingOf(FIVE))

  const r = await findSkill($, 'Query: pdf form')
  expect(w.fetched).toHaveLength(2)
  expect(Object.keys(w.fetched[0]!.body.questions)).toEqual(['skill_0'])
  expect(w.fetched[0]!.body.state.request).toBe('pdf form')
  expect(Object.keys(w.fetched[1]!.body.questions)).toEqual(['which', 'fits_0', 'fits_1', 'fits_2'])
  expect(r.text).toBe(findSkillReply('pdf form', [PDF, XLSX, WRANGLER], null))
  expect(r.text).toContain('pdf: ' + PDF.description)
  expect(r.text).toContain('anthropic-skills:xlsx')
  expect(r.text).toContain('cloudflare:wrangler')

  down.yes = true
  const failed = await findSkill($, 'Query: pdf form')
  expect(w.fetched).toHaveLength(3)
  expect(failed.text).toBe(findSkillReply('pdf form', [], 'network'))
  expect(failed.text).toContain('did not run')
  expect(failed.text).not.toContain('cloudflare:wrangler')
})

// Beyond the brief's twelve: listings as they really come.

test('列表包在 system-reminder 里：照样读出', () => {
  const text = '<system-reminder>\n' + listingOf([PDF, BRAIN]) + '\n</system-reminder>'
  expect(parseListing(text)).toEqual([PDF, BRAIN])
  // Tags on the same line as the first or the last entry.
  expect(parseListing('<system-reminder>- pdf: ' + PDF.description + '\n- gsap-core</system-reminder>')).toEqual([PDF, GSAP])
})

test('没有说明的条目：说明是空的，选项里写 null，fits 题照样能问', () => {
  expect(parseListing('- gsap-core\n- tripo3d\n- pdf: ' + PDF.description)).toEqual([GSAP, { name: 'tripo3d', description: '' }, PDF])
  expect(stageOne([GSAP, PDF], 'jev', false).skill_0!.criteria).toEqual({ 'gsap-core': null, pdf: PDF.description })
  const fits = stageTwo([GSAP, PDF], 'jev').fits_0!
  expect(fits.instructions.startsWith("Does the skill 'gsap-core' do the specific thing the user's request asks for?")).toBe(true)
  expect(fits.instructions).not.toMatch(/described as: $/)
})

test('前言里以 - 开头、名字带空格的行不算 skill；名字重复时只留第一个', () => {
  const text = ['Use the Skill tool to load one:', '- Use the exact name below.', '- pdf: ' + PDF.description, '- pdf: Another pdf skill.'].join('\n')
  expect(parseListing(text)).toEqual([PDF])
})

test('一个条目也没有的列表：原样放行，候选不动', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  const text = 'The following skills are available for use with the Skill tool:\n\n'
  const r = await attach($, text)
  expect(r.text).toBe(text)
  expect(w.attachments).toHaveLength(1)
  expect(skillWrites(w)).toEqual([])
})

test('引擎这一层把附件去掉（text 为 null）：原样放行', { options: KEYS }, async ($, on) => {
  const w = world(on, { attachmentText: () => null })
  await start($)
  const r = await attach($, listingOf(FIVE))
  expect(r.text).toBeNull()
  expect(w.attachments).toHaveLength(1)
  expect(skillWrites(w)).toEqual([])
})

test('第二份列表（/clear 之后）换掉候选', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: NOT_WANTED }) })
  await start($)
  await attach($, listingOf(FIVE))
  const second = await attach($, listingOf([BRAIN, WRANGLER]))
  expect(second.text).toBe(LISTING_NOTE)
  expect(skillWrites(w)).toEqual([FIVE, [BRAIN, WRANGLER]])
  await submit($, TASK)
  expect(Object.keys(w.fetched[0]!.body.questions.skill_0.criteria)).toEqual(['cloudflare:wrangler', 'superpowers:brainstorming', 'other'])
})

// The readings, as pure functions.

const choice = (probabilities: Record<string, number>): Answer => ({
  type: 'choice',
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
  probabilities,
})
const n = (p: number): Answer => ({ type: 'noul', noul: p })

test('两批选择题的概率合成一张短名单，去掉 other', () => {
  const a = { name: 'a', description: 'A.' }
  const b = { name: 'b', description: 'B.' }
  const c = { name: 'c', description: 'C.' }
  const d = { name: 'd', description: 'D.' }
  const answers = { skill_0: choice({ a: 0.35, b: 0.15, other: 0.5 }), skill_1: choice({ c: 0.6, d: 0.4 }) }
  expect(shortlist([a, b, c, d], answers)).toEqual([c, d, a])
  expect(SHORTLIST).toBe(3)
  // A missing batch leaves the batches that came.
  expect(shortlist([a, b, c, d], { skill_1: choice({ c: 0.6, d: 0.4 }) })).toEqual([c, d])
  expect(shortlist([a, b], {})).toEqual([])
})

test('wantsSkill：动手题的平均、点名题，三道动手题缺一道时只看点名题', () => {
  expect(ACTION_BAR).toBe(0.3)
  expect(NAMED_BAR).toBe(0.5)
  // (0.3 + 0.3 + (1 - 0.7)) / 3 = 0.30: at the bar counts.
  expect(wantsSkill({ acts: 0.3, procedure: 0.3, prose: 0.7, named: 0 })).toBe(true)
  expect(wantsSkill({ acts: 0.2, procedure: 0.3, prose: 0.7, named: 0.49 })).toBe(false)
  expect(wantsSkill({ acts: 0.1, procedure: 0.1, prose: 0.9, named: 0.5 })).toBe(true)
  // One of the three missing: the average is not taken, however high the other two.
  expect(wantsSkill({ acts: 0.95, procedure: 0.95, named: 0.1 })).toBe(false)
  expect(wantsSkill({ procedure: 0.95, prose: 0.0, named: 0.1 })).toBe(false)
  expect(wantsSkill({ acts: 0.95, prose: 0.0, named: 0.6 })).toBe(true)
  expect(wantsSkill({})).toBe(false)
})

test('pick 和 pickMany 的读法', () => {
  expect(FITS_BAR).toBe(0.3)
  const short = [PDF, XLSX, WRANGLER]
  const which = choice({ pdf: 0.2, 'anthropic-skills:xlsx': 0.7, 'cloudflare:wrangler': 0.1 })
  // which settles the skill once any fits reaches the bar, even another one's.
  expect(pick(short, { which, fits_0: n(0.9), fits_1: n(0.1), fits_2: n(0.1) })).toEqual(XLSX)
  expect(pick(short, { which, fits_0: n(0.3), fits_1: n(0.1), fits_2: n(0.1) })).toEqual(XLSX)
  expect(pick(short, { which, fits_0: n(0.29), fits_1: n(0.1), fits_2: n(0.1) })).toBeNull()
  expect(pick(short, { fits_0: n(0.9) })).toBeNull()
  expect(pickMany(short, { fits_0: n(0.4), fits_1: n(0.8), fits_2: n(0.2) })).toEqual([XLSX, PDF])
  expect(pickMany(short, { fits_0: n(0.3), fits_1: n(0.3), fits_2: n(0.3) })).toEqual(short)
  expect(pickMany(short, { fits_0: n(0.1) })).toEqual([])
})

test('findSkillReply 的几种回答', () => {
  const found = findSkillReply('pdf form', [PDF, GSAP], null)
  expect(found).toContain('pdf: ' + PDF.description)
  expect(found).toContain('- gsap-core')
  expect(found).toContain('Skill tool')
  const none = findSkillReply('pdf form', [], null)
  expect(none).toContain('pdf form')
  expect(none).not.toContain('did not run')
  expect(findSkillReply('pdf form', [], 'timeout')).toContain('did not run')
  expect(findSkillReply('', [], null)).toContain('a few words')
})

// Beyond the brief's twelve: the two parts of one answer stand apart.

test('skill 的部分不能用（缺 skill_0）：不推荐，effort 的决定照常', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.9 }, drop: ['skill_0'] }) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(1)
  expect(w.submitted[0]!.context).toBeUndefined()
  expect(efforts(w)).toEqual(['high'])
  expect(submitDecisions(w)[0]).toMatchObject({ to: 'high', failure: null, applied: true })
  const d = skillDecisions(w)[0]!
  expect(d).toMatchObject({ to: null, applied: false })
  expect(d.detail).not.toBe('')
})

test('effort 的部分不能用（缺 open）：effort 放行，skill 照样推荐', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.9 }, drop: ['open'] }) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(2)
  expect(w.submitted[0]!.context).toEqual([suggestionBlock(PDF)])
  expect(efforts(w)).toEqual(['medium'])
  expect(submitDecisions(w)[0]).toMatchObject({ failure: 'bad-answer', from: 'medium', to: 'medium', applied: false, raw: null })
  expect(skillDecisions(w)[0]).toMatchObject({ to: 'pdf', applied: true, failure: null })
})

test('submitShift 关着、skills 开着：请求里只有 skill 题，不留 effort 判断', { options: { ...KEYS, submitShift: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.9 } }) })
  await sendWithListing($, w)

  expect(Object.keys(w.fetched[0]!.body.questions)).toEqual(['skill_0', ...GATE_IDS])
  expect(w.submitted[0]!.context).toEqual([suggestionBlock(PDF)])
  expect(efforts(w)).toEqual(['medium'])
  expect(submitDecisions(w)).toHaveLength(0)
  expect(skillDecisions(w)[0]).toMatchObject({ to: 'pdf', applied: true, turnId: 't1' })
})

test('第一次请求失败：不推荐，记一条失败的 skill 决定', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(1)
  expect(w.submitted[0]!.context).toBeUndefined()
  expect(skillDecisions(w)[0]).toMatchObject({ kind: 'skill', to: null, failure: 'http', applied: false, raw: null, turnId: 't1' })
  expect(submitDecisions(w)[0]).toMatchObject({ failure: 'http' })
})

test('第二次请求用的是剩下的时间：到点按超时记', { options: KEYS }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const answer = answering({ gates: WANTED, first: { pdf: 0.6 } })
  const w = world(on, {
    onSubmit: turns($),
    answer: async (req) => {
      await late.clock!.sleep('which' in req.body.questions ? 60_000 : 3000)
      return answer(req)
    },
  })
  late.clock = w.clock
  await start($)
  await attach($, listingOf(FIVE))
  const sent = submit($, TASK)
  await w.clock.settle()
  await w.clock.advance(3000)
  await w.clock.settle()
  await w.clock.advance(1000)
  await sent

  expect(w.fetched).toHaveLength(2)
  expect(w.submitted[0]!.context).toBeUndefined()
  expect(skillDecisions(w)[0]).toMatchObject({ to: null, failure: 'timeout', applied: false, ms: 4000 })
})

test('shadow：列表没有收起，发消息时只问 effort 题，不加推荐', { options: { ...KEYS, mode: 'shadow' } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({}) })
  await sendWithListing($, w)

  expect(w.fetched).toHaveLength(1)
  expect(Object.keys(w.fetched[0]!.body.questions)).toEqual(['open', 'mechanical', 'unknown_cause'])
  expect(w.submitted[0]!.context).toBeUndefined()
  expect(submitDecisions(w)[0]).toMatchObject({ to: 'high', applied: false })
  expect(skillDecisions(w)).toHaveLength(0)
})

test('find-skill：还没有候选时不发请求，照实回答', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: answering({}) })
  await start($)
  const r = await findSkill($, 'Query: pdf form')
  expect(w.fetched).toHaveLength(0)
  expect(r.text).toBe(findSkillReply('pdf form', [], null))
})

test('别的 plugin 的 find-skill：原样放行', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: answering({}) })
  await start($)
  await attach($, listingOf(FIVE))
  const r = await findSkill($, 'Query: pdf form', 'someone-else')
  expect(r.text).toBe('Query: pdf form')
  expect(w.fetched).toHaveLength(0)
})

test('消息被丢掉：推荐不算数，skill 决定记下但没有轮', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: () => ({ drop: 'blocked by a hook' }), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.9 } }) })
  await start($)
  await attach($, listingOf(FIVE))
  const r = await submit($, TASK)

  expect(r.drop).toBe('blocked by a hook')
  // The suggestion went down with the message; the message did not go in.
  expect(w.submitted[0]!.context).toEqual([suggestionBlock(PDF)])
  expect(skillDecisions(w)[0]).toMatchObject({ to: 'pdf', applied: false, turnId: null, step: 0 })
})

test('锁定时只问 skill 题', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering({ gates: WANTED, first: { pdf: 0.6 }, which: 'pdf', fits: { pdf: 0.9 } }) })
  await start($)
  await dp($, 'lock high')
  await sendWithListing($, w)

  expect(Object.keys(w.fetched[0]!.body.questions)).toEqual(['skill_0', ...GATE_IDS])
  expect(w.submitted[0]!.context).toEqual([suggestionBlock(PDF)])
  expect(efforts(w)).toEqual(['high'])
  expect(submitDecisions(w)).toHaveLength(0)
})
