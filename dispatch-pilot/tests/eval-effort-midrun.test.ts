// The effort-midrun suite of the eval (seam 2, ADR 0020): the dataset's format (the rules lib/midrun-items.ts checks an item
// against), what the suite sends for an item (the mod's own functions over the item's input, nothing else), how the answers
// become the level that is graded (decision/midrun.ts `decideMidrun`, as the mod decides), and what the report adds.

import { expect, test } from 'claude-code/testing'
import { EFFORTS, type Effort } from '../hooks/decision/effort.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import { decideMidrun, midrunPart, midrunSignals, midrunState } from '../hooks/decision/midrun.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { LIQUID_GUIDE, TYPESAFE_GUIDE } from '../hooks/decision/guides.ts'
import { parseJsonl, validateDataset, type EffortMidrunItem, type Language, type MidrunAsked } from '../eval/lib/datasets.ts'
import { effortMidrun, guideFor, MIDRUN_VARIANTS, midrunInput, midrunPosition, midrunRequest, reachableLevels, type MidrunBreakdown } from '../eval/lib/effort-midrun.ts'
import { midrunDirection } from '../eval/lib/midrun-items.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite, type Row } from '../eval/lib/runner.ts'
import { settingsFrom, type Grade } from '../eval/lib/suite.ts'
import { network } from './support/eval-network.ts'

const SETTINGS = settingsFrom({ decisionModel: 'jev' })

/** One language of a run in which `pnpm test auth` failed, was edited at, and failed again with the same first line. */
function asked(language: Language): MidrunAsked {
  const zh = language === 'zh'
  const failed = (step: number) => ({ step, assistant_text: zh ? '跑一下登录的测试。' : 'Running the auth tests.', tools: [{ tool: 'Bash', target: 'pnpm test auth', outcome: 'failed' as const, error: 'TypeError: token is undefined', result: zh ? 'pnpm test auth：2 个失败，token is undefined' : 'pnpm test auth: 2 failed, token is undefined' }] })
  return {
    task: zh ? '修好登录接口，别动其他模块' : 'Fix the login endpoint; leave the other modules alone',
    recent_steps: [
      failed(4),
      { step: 5, assistant_text: zh ? '先判断 token 是否存在。' : 'Guarding the token first.', tools: [{ tool: 'Edit', target: 'src/auth/login.ts', outcome: 'ok', result: zh ? 'login.ts 增加了判空' : 'login.ts: added a guard' }] },
      failed(6),
    ],
    facts: ['The command `pnpm test auth` failed again after the assistant edited files since its last failure.', '2 of the 7 tool calls of this run failed.'],
    failures: { latest: 'Bash: TypeError: token is undefined', earlier: 'Bash: TypeError: token is undefined' },
  }
}

/** A well-formed item at a failure that came back; `change` edits a copy. */
function item(id: string, change: (item: EffortMidrunItem) => void = () => {}): EffortMidrunItem {
  const result: EffortMidrunItem = {
    id,
    zh: asked('zh'),
    en: asked('en'),
    event: 'failure',
    current: 'medium',
    base: 'medium',
    rule_floor: null,
    stuck_before: false,
    gold: 'high',
    accept: ['high', 'xhigh'],
    rationale: '同一条命令改过文件之后又失败，报错是同一行，原因没找到，high。',
    difficulty: 'hard',
    tags: ['stuck'],
  }
  change(result)
  return result
}

/** A well-formed item at the task list moving on, in both languages. */
function moving(id: string, change: (item: EffortMidrunItem) => void = () => {}): EffortMidrunItem {
  return item(id, (one) => {
    one.event = 'todo'
    one.gold = 'medium'
    one.accept = ['low', 'medium']
    for (const language of ['zh', 'en'] as const) {
      const side = one[language]
      delete side.failures
      side.next_item = language === 'zh' ? '补上登录的测试' : 'Add the login tests'
      side.facts = ["The assistant's task list has 2 of 4 items done; it has just moved on to `next_item`.", '2 of the 7 tool calls of this run failed.']
    }
    change(one)
  })
}

// ---- the dataset's format ---------------------------------------------------------------------------------------------------

test('an effort-midrun dataset passes when every item is well formed, and the quotas it falls short of are warnings, not errors', () => {
  const checked = validateDataset('effort-midrun', [item('midrun-001'), moving('midrun-002')])
  expect(checked.errors).toEqual([])
  expect(checked.warnings.join('\n')).toMatch(/items should go (up|down|keep)/)
  expect(checked.warnings.join('\n')).toMatch(/at a (report|handback|skill) event/)
})

test('each broken rule is reported with the id of the item that breaks it', () => {
  const edit = (id: string, change: (item: EffortMidrunItem) => void) => item(id, change)
  const items = [
    edit('midrun-001', (i) => ((i as { event: string }).event = 'timer')),
    edit('midrun-002', (i) => (i.en.recent_steps[0]!.tools[0]!.error = '')),
    edit('midrun-003', (i) => ((i.zh.recent_steps[1]!.tools[0] as { error?: string }).error = 'old_string not found')), // an error on a call that went through
    edit('midrun-004', (i) => (i.zh.recent_steps[2]!.tools[0]!.outcome = 'ok')), // zh and en differ
    edit('midrun-005', (i) => (i.en.facts = ['The assistant is worried about this one.', '2 of the 7 tool calls of this run failed.'])), // not a sentence factsOf writes
    edit('midrun-006', (i) => {
      for (const language of ['zh', 'en'] as const) i[language].facts = ['The command `pnpm test auth` failed again after the assistant edited files since its last failure.', '1 of the 7 tool calls of this run failed.']
    }), // two failed calls are shown, one is counted
    edit('midrun-007', (i) => {
      for (const language of ['zh', 'en'] as const) i[language].next_item = 'Add the login tests'
    }), // next_item at a failure event
    edit('midrun-008', (i) => (i.zh.failures = { latest: 'Bash: something else', earlier: 'Bash: TypeError: token is undefined' })),
    edit('midrun-009', (i) => (i.rule_floor = 'xhigh')), // above base
    edit('midrun-010', (i) => (i.zh.facts = ['The command `pnpm test auth` failed again after the assistant edited files since its last failure.'])), // facts differ between zh and en
    edit('midrun-011', (i) => {
      for (const language of ['zh', 'en'] as const) i[language].facts = [...i[language].facts, 'The assistant has not edited any file in this run.']
    }), // an edit went through in the steps shown
    edit('midrun-012', (i) => (i.en.recent_steps[2]!.step = 5)), // steps not rising
    edit('midrun-013', (i) => delete (i.zh as Partial<MidrunAsked>).failures), // one language only
    edit('midrun-001-again', (i) => (i.stuck_before = 'yes' as unknown as boolean)),
  ]
  const { errors } = validateDataset('effort-midrun', items)
  const of = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(of('midrun-001')).toMatch(/event "timer" is not one of failure, report, handback, skill, todo/)
  expect(of('midrun-002')).toMatch(/en\.recent_steps\[0\]\.tools\[0\]\.error must be a non-empty string/)
  expect(of('midrun-003')).toMatch(/zh\.recent_steps\[1\]\.tools\[0\]\.error: only a call that failed/)
  expect(of('midrun-004')).toMatch(/recent_steps\[2\]\.tools\[0\] differs between zh and en/)
  expect(of('midrun-005')).toMatch(/en\.facts: a failure event starts with one of the three sentences/)
  expect(of('midrun-006')).toMatch(/facts: 1 calls failed, but 2 failed calls are shown/)
  expect(of('midrun-007')).toMatch(/zh\.next_item is only for a todo event/)
  expect(of('midrun-008')).toMatch(/zh\.failures\.latest .* is not the latest failed call's line/)
  expect(of('midrun-009')).toMatch(/rule_floor xhigh is above base medium/)
  expect(of('midrun-010')).toMatch(/facts differ between zh and en/)
  expect(of('midrun-011')).toMatch(/says no file was edited, but a call that edited one went through/)
  expect(of('midrun-012')).toMatch(/en\.recent_steps\[2\]\.step 5 does not come after 5/)
  expect(of('midrun-013')).toMatch(/failures is in one language only/)
  expect(of('midrun-001-again')).toMatch(/stuck_before must be true or false/)
})

test('the facts are the sentences factsOf writes: the event first, then the failure count, then what was edited; a todo event needs its item, a report its text, a handback its tool, a skill its call', () => {
  const todo = (id: string, change: (side: MidrunAsked) => void) => moving(id, (i) => ['zh', 'en'].forEach((language) => change(i[language as Language])))
  const { errors } = validateDataset('effort-midrun', [
    todo('midrun-020', (side) => delete side.next_item), // the task list moved on to nothing
    todo('midrun-023', (side) => (side.facts = ["The assistant's task list has 4 of 4 items done; it has just moved on to `next_item`.", '2 of the 7 tool calls of this run failed.'])), // nothing left to do
    todo('midrun-024', (side) => (side.facts = [side.facts[0] as string, '2 of the 1 tool calls of this run failed.'])), // more calls failed than the run made
    todo('midrun-025', (side) => (side.facts = [side.facts[0] as string, '2 of the 7 tool calls of this run failed.', 'No file was edited in the latest 3 steps.'])), // from 5 steps only, and an edit is shown
    item('midrun-021', (i) => {
      i.event = 'handback'
      for (const language of ['zh', 'en'] as const) {
        delete i[language].failures
        i[language].facts = ["A dispatched agent's result has just come back to the assistant (the latest Agent call in `recent_steps`).", '2 of the 7 tool calls of this run failed.']
      }
    }), // no Agent call in the steps
    item('midrun-022', (i) => {
      i.event = 'report'
      for (const language of ['zh', 'en'] as const) {
        delete i[language].failures
        i[language].facts = ['A report was just delivered to the assistant while it works (`report`): a background task or a dispatched agent finished.', '2 of the 7 tool calls of this run failed.']
      }
    }), // a report event delivers a report
  ])
  const text = errors.join('\n')
  expect(text).toMatch(/midrun-020: zh\.next_item is missing/)
  expect(text).toMatch(/4 of 4 items done: the item it moved on to is not done yet/)
  expect(text).toMatch(/2 of 1 calls failed/)
  expect(text).toMatch(/"latest N steps" is for the 3 steps shown, and only from 5/)
  expect(text).toMatch(/midrun-021: .*no Agent call that went through is in recent_steps/)
  expect(text).toMatch(/midrun-022: zh\.report is missing/)
})

test('lines that are not an item the format knows are errors with the line number; the JSONL of a dataset parses as any other', () => {
  const parsed = parseJsonl(`${JSON.stringify(item('midrun-001'))}\nnot json\n`)
  expect(parsed.items).toHaveLength(1)
  expect(parsed.errors).toEqual(['line 2: not JSON'])
})

// ---- what the suite sends ---------------------------------------------------------------------------------------------------

for (const language of ['zh', 'en'] as const) {
  test(`the request for an item is the mod's: the state over its input, and the part with the two failures to compare (${language})`, () => {
    const one = item('midrun-001')
    const { request, part } = midrunRequest(one, language, 'mod', SETTINGS)
    const side = one[language]
    // The input the mod builds (features/midrun-effort.ts `judge`): the steps as its record holds them, the facts the code counted.
    const input = {
      task: side.task,
      recent_steps: side.recent_steps.map((step) => ({ step: step.step, assistant_text: step.assistant_text, tools: step.tools.map(({ result: _result, ...call }) => call) })),
      facts: side.facts,
    }
    expect(request).toEqual(mergeParts(midrunState(input), [midrunPart(SETTINGS.ask.turnStart, { failures: side.failures as { latest: string; earlier: string } })]))
    expect(part.questions.same_failure).toBeDefined()
    // What the request holds, so the equality above is not two empty things.
    expect(Object.keys(request.state)).toEqual(['task', 'progress_note', 'recent_steps', 'facts'])
    expect(Object.keys(request.questions)).toEqual(['midrun.level', 'midrun.cause_unknown', 'midrun.env_failure', 'midrun.new_ground', 'midrun.mechanical_rest', 'midrun.stakes.undo', 'midrun.stakes.live', 'midrun.stakes.access', 'midrun.same_failure'])
    // Never how a call went (the old dataset's words), never the level the loop is on.
    expect(JSON.stringify(request)).not.toContain(language === 'zh' ? '2 个失败' : '2 failed, token')
    expect(JSON.stringify(request.state)).not.toContain('medium')
  })
}

test('the task list moving on brings next_item, a report delivered brings report; neither is there at another event, and a failure without an earlier one to compare asks no same_failure', () => {
  const todo = midrunRequest(moving('midrun-002'), 'en', 'mod', SETTINGS)
  expect(todo.request.state.next_item).toBe('Add the login tests')
  expect(todo.request.questions['midrun.same_failure']).toBeUndefined()
  const reported = item('midrun-003', (i) => {
    i.event = 'report'
    for (const language of ['zh', 'en'] as const) {
      delete i[language].failures
      i[language].report = '<task-notification>\n<status>completed</status>\n</task-notification>'
      i[language].facts = ['A report was just delivered to the assistant while it works (`report`): a background task or a dispatched agent finished.', '2 of the 7 tool calls of this run failed.']
    }
  })
  expect(validateDataset('effort-midrun', [reported]).errors).toEqual([])
  expect(midrunRequest(reported, 'en', 'mod', SETTINGS).request.state.report).toContain('task-notification')
  expect('next_item' in midrunRequest(item('midrun-004'), 'en', 'mod', SETTINGS).request.state).toBe(false)
})

test('the other variants: no-facts sends no facts; with-outputs sends how every call went in the call\'s error line, cut as the mod cuts one', () => {
  const one = item('midrun-001')
  expect(Object.keys(MIDRUN_VARIANTS)).toEqual(['mod', 'no-facts', 'with-outputs'])
  expect('facts' in midrunRequest(one, 'en', 'no-facts', SETTINGS).request.state).toBe(false)
  expect('same_failure' in midrunRequest(one, 'en', 'no-facts', SETTINGS).part.questions).toBe(true)
  const lines = (variant: string) => (midrunRequest(one, 'en', variant, SETTINGS).request.state.recent_steps as { tools: { outcome: string; error?: string }[] }[]).flatMap((step) => step.tools.map((tool) => tool.error ?? null))
  expect(lines('mod')).toEqual(['TypeError: token is undefined', null, 'TypeError: token is undefined'])
  expect(lines('with-outputs')).toEqual(['pnpm test auth: 2 failed, token is undefined', 'login.ts: added a guard', 'pnpm test auth: 2 failed, token is undefined'])
  expect(midrunInput(one.en, MIDRUN_VARIANTS['mod'] as never).recent_steps[1]?.tools[0]).toEqual({ tool: 'Edit', target: 'src/auth/login.ts', outcome: 'ok' })
})

test('where the turn stands is the item\'s: its level, base, floor and event; an earlier stuck failure is a ratchet too; a report is a step that carries input', () => {
  expect(midrunPosition(item('midrun-001', (i) => (i.stuck_before = true)))).toEqual({ current: 'medium', base: 'medium', ruleFloor: null, event: 'failure', ratchet: true, stuckBefore: true, downAllowed: true, free: false, sinceSwitch: null, switches: 0 })
  expect(midrunPosition(item('midrun-002', (i) => ((i.event = 'report'), (i.current = 'xhigh'), (i.base = 'high'), (i.rule_floor = 'medium')))))
    .toMatchObject({ current: 'xhigh', base: 'high', ruleFloor: 'medium', event: 'report', free: true, ratchet: false })
})

// ---- the answers and the level graded ---------------------------------------------------------------------------------------

const LEVELS = { low: [1, 0, 0, 0, 0], medium: [0, 1, 0, 0, 0], high: [0, 0, 1, 0, 0], xhigh: [0, 0, 0, 1, 0], max: [0, 0, 0, 0, 1] } as const

/** A Jev (or d1) reply: the Score on `levels`, and each Noul by its id within the part (0 where not given). */
function reply(body: { questions: Record<string, { type: string }> }, levels: readonly number[], nouls: Record<string, number> = {}, model = JEV_MODEL, confidence = 0.8) {
  const answers: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(body.questions)) {
    const local = id.slice('midrun.'.length)
    if (id === 'midrun.level') answers[id] = { type: 'score', probabilities: Object.fromEntries(EFFORTS.map((_, i) => [String(i), levels[i] ?? 0])), confidence, score: 0 }
    else if (question.type === 'noul') answers[id] = { type: 'noul', noul: nouls[local] ?? 0 }
  }
  return { status: 200, body: { model, answers, usage: { input_tokens: 700 } } }
}

async function run(items: EffortMidrunItem[], answer: (body: any) => ReturnType<typeof reply>, variants = ['mod']) {
  const net = network(answer)
  const rows = await runSuite(effortMidrun, items, { backend: jevBackend('k'), io: net.io, now: net.now, pause: async () => {}, settings: SETTINGS, variants, timeoutMs: 10_000, retries: 0, concurrency: 1 })
  return { rows, net }
}

test('the level graded is the one decideMidrun sends for the answers; the row keeps the Score alone, the move, every Noul, each level and the confidence', async () => {
  // A failure that came back at medium, its cause not found and no word of the environment: the code raises it to high.
  const nouls = { cause_unknown: 0.9, env_failure: 0.1, same_failure: 0.8, new_ground: 0.2 }
  const { rows } = await run([item('midrun-001')], (body) => reply(body, LEVELS.medium, nouls))
  expect(rows.map((r) => `${r.language}: ${r.shown} ${r.correct ? 'right' : `wrong (${r.miss})`}`)).toEqual(['zh: high right', 'en: high right'])
  const reading = { probabilities: LEVELS.medium, confidence: 0.8 }
  const direct = decideMidrun(reading, midrunSignals({ 'cause_unknown': { type: 'noul', noul: 0.9 }, 'env_failure': { type: 'noul', noul: 0.1 } }), midrunPosition(item('midrun-001')))
  expect(direct).toMatchObject({ effort: 'high', move: 'raise', reason: 'cause' })
  expect(rows[0]?.detail).toEqual({
    picked: 'medium',
    sent: 'high',
    move: 'raise',
    reason: 'cause',
    p: [0, 1, 0, 0, 0],
    confidence: 0.8,
    noul: { cause_unknown: 0.9, env_failure: 0.1, new_ground: 0.2, mechanical_rest: 0, same_failure: 0.8, stakes_undo: 0, stakes_live: 0, stakes_access: 0 },
    flagged: true,
    stuck: true,
    guide: 'typesafe',
  })
})

test('a failure of the environment keeps the level; a stake lifts it; a loop already found stuck goes one level up from high; the same answers at another event lift nothing', async () => {
  const levelFor = async (one: EffortMidrunItem, levels: readonly number[], nouls: Record<string, number>) => (await run([one], (body) => reply(body, levels, nouls))).rows[0]?.shown
  const stuck = { cause_unknown: 0.9, env_failure: 0.1 }
  expect(await levelFor(item('midrun-001'), LEVELS.medium, { ...stuck, env_failure: 0.9 })).toBe('medium')
  expect(await levelFor(item('midrun-002'), LEVELS.medium, { 'stakes.live': 0.9 })).toBe('high')
  expect(await levelFor(item('midrun-002'), LEVELS.medium, { 'stakes.live': 0.9, 'stakes.undo': 0.9 })).toBe('xhigh')
  expect(await levelFor(item('midrun-003', (i) => ((i.current = 'high'), (i.base = 'high'), (i.stuck_before = true))), LEVELS.high, stuck)).toBe('xhigh')
  expect(await levelFor(item('midrun-004', (i) => ((i.current = 'high'), (i.base = 'high'))), LEVELS.high, stuck)).toBe('high')
  expect(await levelFor(moving('midrun-005'), LEVELS.medium, stuck)).toBe('medium')
})

test('a rest that is only carrying out goes one level under the message\'s: the Noul for the rest, no new ground, the Score below, settled; not at a failure, not after a stuck failure', async () => {
  const rest = { mechanical_rest: 0.9, new_ground: 0.05 }
  const batch = (id: string, change: (item: EffortMidrunItem) => void = () => {}) => moving(id, (i) => ((i.current = 'high'), (i.base = 'high'), (i.gold = 'medium'), change(i)))
  const answer = (body: any) => reply(body, [0, 0.9, 0.1, 0, 0], rest)
  expect((await run([batch('midrun-001')], answer)).rows.map((r) => r.shown)).toEqual(['medium', 'medium'])
  expect((await run([batch('midrun-002', (i) => (i.stuck_before = true))], answer)).rows.map((r) => r.shown)).toEqual(['high', 'high'])
  expect((await run([batch('midrun-003', (i) => (i.event = 'skill'))], (body) => reply(body, [0, 0.9, 0.1, 0, 0], { ...rest, mechanical_rest: 0.5 }))).rows.map((r) => r.shown)).toEqual(['high', 'high'])
})

test('the guide an answer is read by is its maker\'s: d1 answers by Liquid\'s bars (a yes above 0.8, the Score\'s side above 0.2), the others by TypeSafe\'s; each row says which', async () => {
  expect(guideFor('d1-ultra', SETTINGS)).toBe(LIQUID_GUIDE)
  expect(guideFor('d1.1', SETTINGS)).toBe(LIQUID_GUIDE)
  expect(guideFor('jev-1.14.0', SETTINGS)).toBe(TYPESAFE_GUIDE)
  expect(guideFor(null, SETTINGS)).toBe(SETTINGS.guide)
  // A cause 0.75 sure: a yes for TypeSafe (at least 0.7), not for Liquid (it has to pass 0.8).
  const answer = (model: string) => (body: any) => reply(body, LEVELS.medium, { cause_unknown: 0.75, env_failure: 0 }, model)
  const jev = await run([item('midrun-001')], answer('jev-1.14.0'))
  const d1 = await run([item('midrun-001')], answer('d1-ultra'))
  expect(jev.rows.map((r) => `${r.shown} ${r.detail?.guide}`)).toEqual(['high typesafe', 'high typesafe'])
  // Liquid's band (0.2 to 0.8) lifts to high too, but as no flag: the loop is not marked stuck.
  expect(d1.rows.map((r) => `${r.shown} ${r.detail?.guide} ${r.detail?.stuck}`)).toEqual(['high liquid false', 'high liquid false'])
  expect(jev.rows[0]?.detail?.stuck).toBe(true)
})

test('an answer without a level, or a request the backend refuses, is a failed item, not a guess', async () => {
  const { rows } = await run([item('midrun-001')], (body) => {
    const done = reply(body, LEVELS.medium)
    delete (done.body.answers as Record<string, unknown>)['midrun.level']
    return done
  })
  expect(rows.map((r) => r.failure)).toEqual(['parse: no effort answer', 'parse: no effort answer'])
  const refused = await run([item('midrun-001')], () => ({ status: 401, body: { error: 'no' } }) as never)
  expect(refused.rows.every((r) => !r.ok && r.failure?.startsWith('config'))).toBe(true)
})

// ---- the report -------------------------------------------------------------------------------------------------------------

/** An item at `current` whose answer is `gold` (any level in `accept` is right). */
function at(id: string, current: Effort, gold: Effort, accept: Effort[], change: (item: EffortMidrunItem) => void = () => {}): EffortMidrunItem {
  return item(id, (i) => {
    i.current = current
    i.base = current
    i.gold = gold
    i.accept = accept
    change(i)
  })
}

/** An answer as the runner records it: graded on the level sent, with the Score's pick and the move beside it; null when there was none. */
function answered(one: EffortMidrunItem, language: Language, sent: Effort | null, picked: Effort | null = sent, move = 'keep'): Row<Effort> {
  const grade: Grade = sent === null ? { correct: false, exact: false } : effortMidrun.grade(one, sent)
  return {
    id: one.id, language, variant: 'mod', ok: sent !== null, prediction: sent, shown: sent, correct: grade.correct, exact: grade.exact, miss: grade.miss ?? null,
    failure: sent === null ? 'timeout: no answer in 10000 ms' : null, detail: sent === null ? null : { picked, sent, move }, ms: 300, attempts: 1, inputTokens: 900, model: JEV_MODEL, state: null,
  }
}

test('the summary scores never moving the level as a baseline, and groups the items by the way their level should move, with what the code did to each', () => {
  const items = [
    at('a', 'medium', 'high', ['high', 'xhigh']), // up: wants high
    at('b', 'high', 'high', ['medium', 'high']), // keep
    at('c', 'xhigh', 'low', ['low', 'medium']), // down, and the code cannot reach low or medium from xhigh at a failure
    at('d', 'high', 'medium', ['medium'], (i) => ((i.event = 'todo'), (i.tags = ['mechanical-rest']))), // down
    at('e', 'low', 'low', ['low'], (i) => (i.event = 'todo')), // keep
  ]
  const [a, b, c, d, e] = items as [EffortMidrunItem, EffortMidrunItem, EffortMidrunItem, EffortMidrunItem, EffortMidrunItem]
  expect(items.map(midrunDirection)).toEqual(['up', 'keep', 'down', 'down', 'keep'])
  const rows = [
    answered(a, 'zh', 'high', 'xhigh', 'raise'), answered(a, 'en', 'medium'), // zh right, en left where it was
    answered(b, 'zh', 'high'), answered(b, 'en', 'xhigh', 'xhigh', 'raise'), // en moved a level that should be kept, to outside accept
    answered(c, 'zh', 'xhigh'), answered(c, 'en', 'xhigh'), // left too high, both
    answered(d, 'zh', 'medium', 'low', 'down'), answered(d, 'en', 'high'), // zh lowered, en left too high
    answered(e, 'zh', 'low'), answered(e, 'en', null), // en unanswered
  ]
  const summary = summarize(effortMidrun, items, rows, { slowMs: 1500, settings: SETTINGS })
  // Never moving the level is right on b and e, wrong on the other three.
  expect(summary.constants.find((c2) => c2.answer === 'current')).toEqual({ answer: 'current', accuracy: 0.4, exact: 0.4 })
  const breakdown = summary.variants[0]?.breakdown as MidrunBreakdown
  expect(breakdown.directions.map((d2) => `${d2.direction} ${d2.items} ${d2.sent.zh}/${d2.sent.en}`)).toEqual(['up 1 1/0', 'down 2 0.5/0', 'keep 2 1/0'])
  expect(breakdown.keep).toEqual({ items: 2, moved: { zh: 0, en: 1 }, movedOutside: { zh: 0, en: 1 } })
  expect(breakdown.down).toEqual({ items: 2, unchanged: { zh: 0.5, en: 1 }, leftHigh: { zh: 0.5, en: 1 } })
  expect(breakdown.up).toEqual({ items: 1, unchanged: { zh: 0, en: 1 }, leftLow: { zh: 0, en: 1 } })
  // The Score alone: a is right in zh (xhigh), b right, c wrong, d right in zh (low is not accepted: wrong), e right.
  expect(breakdown.picked.zh).toBe(0.6)
  expect(breakdown.reachable.unreachable).toEqual(['c'])
  expect(breakdown.reachable.items).toBe(4)
  expect(breakdown.byEvent.failure).toMatchObject({ items: 3 })
  expect(breakdown.byEvent.todo).toMatchObject({ items: 2 })
  expect(breakdown.byGroup.mechanical).toMatchObject({ items: 1 })
  expect(breakdown.moves.zh).toEqual({ raise: 1, keep: 3, down: 1 })
  const lines = effortMidrun.report?.(summary.variants[0] as never) ?? []
  expect(lines.some((line) => line.includes('items whose level should be kept (2): moved 0.0%/100.0%'))).toBe(true)
  expect(lines.some((line) => line.includes('1 cannot: c'))).toBe(true)
})

test('what the code can send from where a turn stands: the level it is at, a raise to high at once and then a level at a time, a stake straight to xhigh, the message\'s level again, one under it, but not at a failure', () => {
  const from = (current: Effort, base: Effort, event: EffortMidrunItem['event'] = 'todo') => reachableLevels({ current, base, event })
  expect(from('low', 'low')).toEqual(['low', 'high', 'xhigh'])
  expect(from('medium', 'medium')).toEqual(['low', 'medium', 'high', 'xhigh'])
  expect(from('high', 'high')).toEqual(['medium', 'high', 'xhigh'])
  expect(from('xhigh', 'xhigh')).toEqual(['high', 'xhigh', 'max'])
  expect(from('max', 'max')).toEqual(['xhigh', 'max'])
  // Raised for a failure: back to where the message put it.
  expect(from('high', 'medium')).toEqual(['medium', 'high', 'xhigh'])
  expect(from('xhigh', 'high')).toEqual(['high', 'xhigh', 'max'])
  expect(from('high', 'high', 'failure')).toEqual(['high', 'xhigh'])
  expect(from('xhigh', 'medium', 'failure')).toEqual(['xhigh', 'max'])
})

test('the suite names its dataset, its variants and the questions it asks (what a prompt change changes), and scores keeping the level as a baseline', () => {
  expect(effortMidrun.name).toBe('effort-midrun')
  expect(effortMidrun.variants).toEqual(['mod', 'no-facts', 'with-outputs'])
  expect(Object.keys(effortMidrun.questions('mod') as object)).toContain('same_failure')
  expect(Object.keys(effortMidrun.baselines ?? {})).toEqual(['current'])
})
