// The main agent's effort while its turn runs (ADR 0020), and a failing dispatched agent's effort raised before its
// model. Seam 1: engine events in; what reaches the engine (each step's effort, the rows appended), the decision backend
// and the board's log out. The rules and the run's record are also read on their own (decision/midrun.ts,
// decision/midrun-track.ts): pure, as the eval reads them.

import { expect, test } from 'claude-code/testing'
import { LIQUID_GUIDE, TYPESAFE_GUIDE } from '../hooks/decision/guides.ts'
import { decideMidrun, MAX_SWITCHES, midrunPart, midrunState, resolvedDecision, rowsFor, switchNote, type MidrunPosition, type MidrunSignals } from '../hooks/decision/midrun.ts'
import { commandClass, errorKey, factsOf, newRecord, noteCall, type CallEnd, type MidrunRecord } from '../hooks/decision/midrun-track.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { stepLines } from '../hooks/board/rationale.ts'
import { jev, KEY, kind, type Reply, type Sent, type StepOptions, type World, world } from './support/world.ts'

const LOW = [1, 0, 0, 0, 0]
const MEDIUM = [0, 1, 0, 0, 0]
const HIGH = [0, 0, 1, 0, 0]
const XHIGH = [0, 0, 0, 1, 0]

const NO_SIGNALS: MidrunSignals = { causeUnknown: null, envFailure: null, newGround: null, mechanicalRest: null, sameFailure: null, stakes: { undo: null, live: null, access: null } }
const at = (current: MidrunPosition['current'], more: Partial<MidrunPosition> = {}): MidrunPosition => ({ current, base: current, ruleFloor: null, event: 'skill', ratchet: false, stuckBefore: false, downAllowed: true, free: false, sinceSwitch: null, switches: 0, ...more })
const reading = (probabilities: readonly number[], confidence: number | null = 0.8) => ({ probabilities, confidence })

// ---- the rules ----------------------------------------------------------------------

test('a reading above the current level raises it when enough of the probability is on that side: to high at once, above high one level at a time, up to max', () => {
  expect(decideMidrun(reading(HIGH), NO_SIGNALS, at('low'))).toMatchObject({ effort: 'high', move: 'raise', reason: 'reading' })
  // From low, a reading of xhigh goes to high first.
  expect(decideMidrun(reading(XHIGH), NO_SIGNALS, at('low'))).toMatchObject({ effort: 'high', move: 'raise' })
  expect(decideMidrun(reading(XHIGH), NO_SIGNALS, at('high'))).toMatchObject({ effort: 'xhigh', move: 'raise' })
  expect(decideMidrun(reading([0, 0, 0, 0, 1]), NO_SIGNALS, at('high'))).toMatchObject({ effort: 'xhigh', move: 'raise' })
  // No cap in the middle of a run (ADR 0022): a reading of max takes a loop on xhigh to max.
  expect(decideMidrun(reading([0, 0, 0, 0, 1]), NO_SIGNALS, at('xhigh'))).toMatchObject({ effort: 'max', move: 'raise', reason: 'reading' })
  // A reading that still rounds to xhigh keeps it, whatever sits on max.
  expect(decideMidrun(reading([0, 0, 0, 0.8, 0.2]), NO_SIGNALS, at('xhigh'))).toMatchObject({ effort: 'xhigh', move: 'keep' })
  // A turn its message put at max stays there.
  expect(decideMidrun(reading(HIGH), NO_SIGNALS, at('max'))).toMatchObject({ effort: 'max', move: 'keep' })
})

test('a reading that only leans up keeps the level: its rounded position has to pass the current level, and its side has to hold the bar', () => {
  // Position 1.4 rounds to medium: 0.4 above is over the bar, but the answer itself still says medium.
  expect(decideMidrun(reading([0, 0.6, 0.4, 0, 0]), NO_SIGNALS, at('medium'))).toMatchObject({ effort: 'medium', move: 'keep', picked: 'medium' })
  // Two-peaked (TypeSafe's rule): 0.3 on max pulls the position to 1.9 (high) and lifts the reading one more (xhigh); the 0.3
  // above holds the bar, and from under high the level goes to high first.
  expect(decideMidrun(reading([0, 0.7, 0, 0, 0.3]), NO_SIGNALS, at('medium'))).toMatchObject({ effort: 'high', move: 'raise', picked: 'xhigh' })
  // The same tail too thin to hold the bar: position 1.6 rounds to high, but only 0.2 sits above medium.
  expect(decideMidrun(reading([0, 0.8, 0, 0, 0.2]), NO_SIGNALS, at('medium'))).toMatchObject({ effort: 'medium', move: 'keep', picked: 'high' })
  // Liquid's bar is passed, not met: 0.2 above does not move, 0.21 does.
  expect(decideMidrun(reading([0, 0.8, 0, 0, 0.2]), NO_SIGNALS, at('medium'), LIQUID_GUIDE)).toMatchObject({ effort: 'medium', move: 'keep', picked: 'high' })
  expect(decideMidrun(reading([0, 0.79, 0, 0, 0.21]), NO_SIGNALS, at('medium'), LIQUID_GUIDE)).toMatchObject({ effort: 'high', move: 'raise' })
  // An answer the model is unsure of keeps a running loop where it is: a low confidence takes no level up.
  const unsure = decideMidrun(reading([0, 0.75, 0.25, 0, 0], 0.3), NO_SIGNALS, at('medium'), LIQUID_GUIDE)
  expect(unsure).toMatchObject({ effort: 'medium', move: 'keep', picked: 'medium' })
  expect(unsure.steps[0]).toMatchObject({ rule: 'position', level: 'medium' })
})

test('at a failure that came back, an unknown cause lifts the level: to high from under it; from high up one level, and only for a loop already found stuck this turn; in the band to high; not when the environment failed', () => {
  const failed = (current: MidrunPosition['current'], stuckBefore = false) => at(current, { event: 'failure', stuckBefore })
  const cause = (causeUnknown: number, envFailure = 0): MidrunSignals => ({ ...NO_SIGNALS, causeUnknown, envFailure })
  expect(decideMidrun(reading(MEDIUM), cause(0.9), failed('medium'))).toMatchObject({ effort: 'high', move: 'raise', reason: 'cause', flagged: true })
  expect(decideMidrun(reading(LOW), cause(0.9), failed('low'))).toMatchObject({ effort: 'high', move: 'raise' })
  // On high already: the first such failure only marks the loop as stuck; the next one takes it one level up.
  expect(decideMidrun(reading(HIGH), cause(0.9), failed('high'))).toMatchObject({ effort: 'high', move: 'keep', flagged: true, stuck: true })
  expect(decideMidrun(reading(HIGH), cause(0.9), failed('high', true))).toMatchObject({ effort: 'xhigh', move: 'raise', reason: 'cause' })
  // Stuck again on xhigh: one more level, to max; there it stays.
  expect(decideMidrun(reading(XHIGH), cause(0.9), failed('xhigh', true))).toMatchObject({ effort: 'max', move: 'raise', reason: 'cause' })
  expect(decideMidrun(reading(XHIGH), cause(0.9), failed('max', true))).toMatchObject({ effort: 'max', move: 'keep' })
  expect(decideMidrun(reading(MEDIUM), cause(0.5), failed('medium'))).toMatchObject({ effort: 'high', move: 'raise', flagged: false })
  expect(decideMidrun(reading(HIGH), cause(0.5), failed('high'))).toMatchObject({ effort: 'high', move: 'keep' })
  // A timeout or a refused call: more thought does not mend the environment.
  expect(decideMidrun(reading(MEDIUM), cause(0.9, 0.9), failed('medium'))).toMatchObject({ effort: 'medium', move: 'keep' })
  // The same answers at another event lift nothing: the question is about a failure the code saw come back.
  expect(decideMidrun(reading(MEDIUM), cause(0.9), at('medium', { event: 'skill' }))).toMatchObject({ effort: 'medium', move: 'keep' })
})

test('the stakes lift the level at any event: one of them to high, hard to undo together with live or access to xhigh; the loop is not lowered again this turn', () => {
  const stakes = (undo: number | null, live: number | null, access: number | null) => decideMidrun(reading(MEDIUM), { ...NO_SIGNALS, stakes: { undo, live, access } }, at('medium'))
  expect(stakes(0.9, 0.1, null)).toMatchObject({ effort: 'high', move: 'raise', reason: 'stakes', flagged: true, stakes: 'high' })
  expect(stakes(0.1, 0.9, 0.9)).toMatchObject({ effort: 'high', move: 'raise', reason: 'stakes', stakes: 'high' })
  expect(stakes(0.9, 0.9, null)).toMatchObject({ effort: 'xhigh', move: 'raise', reason: 'stakes', flagged: true, stakes: 'xhigh' })
  expect(stakes(0.9, 0.1, 0.9)).toMatchObject({ effort: 'xhigh', move: 'raise', stakes: 'xhigh' })
  // A level already at the stakes' floor is flagged all the same.
  expect(decideMidrun(reading(HIGH), { ...NO_SIGNALS, stakes: { undo: 0.9, live: null, access: null } }, at('high'))).toMatchObject({ effort: 'high', move: 'keep', flagged: true, stakes: 'high' })
  // In the band it lifts nothing in the middle of a run.
  expect(decideMidrun(reading(MEDIUM), { ...NO_SIGNALS, stakes: { undo: 0.5, live: null, access: null } }, at('medium'))).toMatchObject({ effort: 'medium', move: 'keep', flagged: false, stakes: null })
})

test('a raised loop goes back to its message\'s level when the answer reads at or under it, with a yes\'s worth of probability below and the answer settled', () => {
  const raised = at('high', { base: 'medium' })
  expect(decideMidrun(reading([0, 0.8, 0.2, 0, 0]), NO_SIGNALS, raised)).toMatchObject({ effort: 'medium', move: 'return', reason: 'reading' })
  // Two levels back in one move: it is the level the message was decided at, not a guess.
  expect(decideMidrun(reading([0.9, 0.1, 0, 0, 0]), NO_SIGNALS, at('xhigh', { base: 'medium' }))).toMatchObject({ effort: 'medium', move: 'return' })
  expect(decideMidrun(reading([0, 0.6, 0.4, 0, 0]), NO_SIGNALS, raised)).toMatchObject({ effort: 'high', move: 'keep' })
  expect(decideMidrun(reading([0, 0.8, 0.2, 0, 0], 0.4), NO_SIGNALS, raised)).toMatchObject({ effort: 'high', move: 'keep' })
  // A failure's raise is the code's to take back, when its command passes.
  expect(decideMidrun(reading([0, 0.8, 0.2, 0, 0]), NO_SIGNALS, { ...raised, event: 'failure' })).toMatchObject({ effort: 'high', move: 'keep' })
})

test('one level under the message\'s only for a rest that is carrying out: mechanical a yes, nothing new uncovered, the reading below with a yes\'s worth, no ratchet, never under a rule\'s floor', () => {
  const rest: MidrunSignals = { ...NO_SIGNALS, mechanicalRest: 0.9, newGround: 0.05 }
  expect(decideMidrun(reading([0.1, 0.8, 0.1, 0, 0]), rest, at('high'))).toMatchObject({ effort: 'medium', move: 'down', reason: 'mechanical' })
  // One level only, however low the answer reads.
  expect(decideMidrun(reading(LOW), rest, at('xhigh'))).toMatchObject({ effort: 'high', move: 'down' })
  const keeps = (signals: MidrunSignals, position: MidrunPosition, levels = [0.1, 0.8, 0.1, 0, 0], confidence = 0.8) => expect(decideMidrun(reading(levels, confidence), signals, position)).toMatchObject({ effort: position.current, move: 'keep' })
  keeps({ ...rest, mechanicalRest: 0.6 }, at('high'))
  keeps({ ...rest, newGround: 0.5 }, at('high'))
  keeps({ ...rest, newGround: null }, at('high'))
  keeps(rest, at('high'), [0, 0.6, 0.4, 0, 0])
  keeps(rest, at('high'), [0.1, 0.8, 0.1, 0, 0], 0.4)
  keeps(rest, at('high', { ratchet: true }))
  keeps(rest, at('high', { downAllowed: false }))
  keeps(rest, at('high', { ruleFloor: 'high' }))
  keeps(rest, at('high', { event: 'failure' }))
  keeps(rest, at('low'), LOW)
  // Already one under: not a second.
  keeps(rest, at('medium', { base: 'high' }), LOW)
  // A floor under the level leaves room.
  expect(decideMidrun(reading([0.1, 0.8, 0.1, 0, 0]), rest, at('high', { ruleFloor: 'medium' }))).toMatchObject({ effort: 'medium', move: 'down' })
})

test('a move that needs a row keeps to the gap since the last and the turn\'s cap; a red flag\'s raise does not wait out the gap; a step that carries input needs neither', () => {
  expect(decideMidrun(reading(HIGH), NO_SIGNALS, at('medium', { sinceSwitch: 2, switches: 1 }))).toMatchObject({ effort: 'medium', move: 'keep', reason: 'held' })
  expect(decideMidrun(reading(HIGH), NO_SIGNALS, at('medium', { sinceSwitch: 4, switches: 1 }))).toMatchObject({ effort: 'high', move: 'raise' })
  expect(decideMidrun(reading(HIGH), NO_SIGNALS, at('medium', { sinceSwitch: 20, switches: MAX_SWITCHES }))).toMatchObject({ effort: 'medium', move: 'keep', reason: 'held' })
  expect(decideMidrun(reading(MEDIUM), { ...NO_SIGNALS, causeUnknown: 0.9 }, at('medium', { event: 'failure', sinceSwitch: 1, switches: 1 }))).toMatchObject({ effort: 'high', move: 'raise', stuck: true })
  expect(decideMidrun(reading(HIGH), NO_SIGNALS, at('medium', { free: true, sinceSwitch: 0, switches: MAX_SWITCHES }))).toMatchObject({ effort: 'high', move: 'raise' })
})

test('every rule that ran is a step of the trace, with what it read and the bars it held it to', () => {
  const decision = decideMidrun(reading([0, 0.2, 0.8, 0, 0]), { ...NO_SIGNALS, causeUnknown: 0.2 }, at('medium', { event: 'failure' }))
  expect(decision.steps.map((step) => `${step.rule}:${step.applied}`)).toEqual(['position:true', 'two-peaked:false', 'mid-sides:true', 'mid-stakes:false', 'mid-cause:false', 'mid-up:true', 'mid-return:false', 'mid-down:false'])
  expect(decision.steps.find((step) => step.rule === 'mid-sides')).toMatchObject({ picked: 'high', up: 0.8, down: 0, upBar: TYPESAFE_GUIDE.noul.no, downBar: TYPESAFE_GUIDE.noul.yes })
})

// ---- the request ----------------------------------------------------------------------

test('the request: an absolute Score on the same five levels, the signals as yes/no questions, and same_failure only with two failures to compare, which sit in its own instructions', () => {
  expect(Object.keys(midrunPart().questions)).toEqual(['level', 'cause_unknown', 'env_failure', 'new_ground', 'mechanical_rest', 'stakes.undo', 'stakes.live', 'stakes.access'])
  const part = midrunPart({}, { failures: { latest: 'Bash: TypeError: x is not a function', earlier: 'Bash: TypeError: x is not a function' } })
  expect(part.questions.same_failure).toMatchObject({ type: 'noul', instructions: { latest_failure: 'Bash: TypeError: x is not a function', question: 'Is `latest_failure` the same problem as `earlier_failure`, rather than a new one?' } })
  const level = part.questions.level as { type: string; criteria: string[]; instructions: Record<string, string> }
  expect(level.type).toBe('score')
  expect(level.criteria).toHaveLength(5)
  // No question names a level or asks what to do with one.
  const words = JSON.stringify(part.questions)
  for (const banned of ['xhigh', 'current level', 'raise', 'lower', 'should the']) expect(words.toLowerCase().includes(banned)).toBe(false)
})

test('the state: the task, how to read it, the latest steps oldest first with each call\'s target, outcome and first error line, the counted facts; nothing empty, nothing a tool returned, all within its budget', () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ step: i, assistant_text: `第 ${i} 步：${'分析'.repeat(200)}`, tools: [{ tool: 'Bash', target: 'pnpm test auth', outcome: i % 2 === 0 ? ('failed' as const) : ('ok' as const), ...(i % 2 === 0 ? { error: 'TypeError: token is undefined sk-ant-abcdefghijklmnopqrstuvwxyz012345' } : {}) }] }))
  const state = midrunState({ task: '修好登录 '.repeat(4000), recent_steps: steps, facts: ['The command `pnpm test auth` failed again after the assistant edited files since its last failure.'] }) as Record<string, unknown>
  expect(Object.keys(state)).toEqual(['task', 'progress_note', 'recent_steps', 'facts'])
  expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(4000)
  const kept = state.recent_steps as { step: number; tools: { error?: string }[] }[]
  expect(kept.length).toBeLessThanOrEqual(8)
  expect(kept.at(-1)?.step).toBe(11)
  expect(kept.map((step) => step.step)).toEqual([...kept.map((step) => step.step)].sort((a, b) => a - b))
  expect(JSON.stringify(state).includes('sk-ant-abcdefghijklmnopqrstuvwxyz012345')).toBe(false)
  expect('facts' in (midrunState({ task: 't', recent_steps: [], facts: [] }) as object)).toBe(false)
})

test('the row the loop reads says what changed and why, in the engine\'s reminder wrapping, and asks for nothing', () => {
  const note = switchNote('medium', 'high', 'cause')
  expect(note.startsWith('<system-reminder>')).toBe(true)
  expect(note.includes('raised your reasoning effort from medium to high')).toBe(true)
  expect(note.includes('No reply to this note is needed')).toBe(true)
  expect(switchNote('high', 'medium', 'resolved').includes('lowered your reasoning effort from high to medium: the command that kept failing passes again')).toBe(true)
})

// ---- the run's record --------------------------------------------------------------------

test('a command\'s class is what it runs, past the scene set in front of it', () => {
  expect(commandClass('cd packages/api && FOO=1 pnpm test auth --watch')).toBe('pnpm test auth')
  expect(commandClass('pnpm test auth')).toBe('pnpm test auth')
  expect(commandClass('export NODE_ENV=test; time npx vitest run src/a.test.ts')).toBe('npx vitest run src/a.test.ts')
  expect(commandClass('# comment\n\ngit status')).toBe('git status')
  expect(commandClass('   ')).toBe('')
  // Its options are not what it runs: two targets of one runner are two classes.
  expect(commandClass('pnpm --filter api test')).toBe('pnpm api test')
  expect(commandClass('pnpm --filter api build')).toBe('pnpm api build')
  expect(commandClass('cargo test -p foo')).toBe('cargo test foo')
  expect(commandClass('uv run python a.py')).not.toBe(commandClass('uv run python b.py'))
  // The scene on a line of its own, in a subshell, sourced with a dot; a wrapper with its duration; a pipe and a redirection after it.
  expect(commandClass('cd /repo\npnpm test')).toBe('pnpm test')
  expect(commandClass('(cd pkg && pnpm test)')).toBe('pnpm test')
  expect(commandClass('. venv/bin/activate && pytest tests/a.py')).toBe('pytest tests/a.py')
  expect(commandClass('source venv/bin/activate && pytest tests/a.py')).toBe('pytest tests/a.py')
  expect(commandClass('timeout 60 pnpm test')).toBe('pnpm test')
  expect(commandClass('pnpm test 2>&1 | tail -20')).toBe('pnpm test')
  expect(commandClass('bash -lc "pnpm test auth"')).toBe('pnpm test auth')
  // A script written on the spot is no command seen twice; nor is a line that only sets the scene.
  expect(commandClass("python3 - <<'EOF'\nprint(1)\nEOF")).toBe('')
  expect(commandClass('python -c "print(1)"')).toBe('')
  expect(commandClass('cd /repo')).toBe('')
  expect(errorKey('Bash: src/a.ts:12:3 error TS2322 at 0xdeadbeef')).toBe('src/a.ts:#:# error ts# at #')
  expect(errorKey('Bash')).toBe('')
})

const call = (tool: string, input: Record<string, unknown>, more: Partial<CallEnd> = {}): CallEnd => ({ tool, input, outcome: 'ok', step: 0, durationMs: 20, ...more })
const bash = (command: string, step: number, error?: string): CallEnd => call('Bash', { command }, { step, ...(error === undefined ? {} : { outcome: 'failed', text: error }) })
const edit = (step: number): CallEnd => call('Edit', { file_path: '/repo/src/auth/login.ts' }, { step })
/** The record after the calls, and the events they made, in order. */
function run(calls: readonly CallEnd[], from: MidrunRecord = newRecord('t1')) {
  let record = from
  const events: (string | null)[] = []
  for (const one of calls) {
    const noted = noteCall(record, one)
    record = noted.record
    events.push(noted.event === null ? null : noted.event.kind === 'failure' ? `failure:${noted.event.why}` : noted.event.kind)
  }
  return { record, events }
}

test('one failure is no event; a command that fails again after an edit is, and so is one that passed earlier and fails after an edit, and the same error line on the next failing step', () => {
  expect(run([bash('pnpm test auth', 0, 'Exit code 1\nTypeError: token is undefined')]).events).toEqual([null])
  // Again with nothing tried in between: the same line came back.
  expect(run([bash('pnpm test auth', 0, 'TypeError: token is undefined'), bash('pnpm test auth', 1, 'TypeError: token is undefined')]).events).toEqual([null, 'failure:same-line'])
  // A fix tried, and it fails again (another line: still the command that will not pass).
  expect(run([bash('pnpm test auth', 0, 'TypeError: token is undefined'), edit(1), bash('pnpm test auth', 2, 'AssertionError: expected 200')]).events).toEqual([null, null, 'failure:refail'])
  expect(run([bash('pnpm build', 0), edit(1), bash('pnpm build', 2, 'error TS2322: Type string is not assignable')]).events).toEqual([null, null, 'failure:regression'])
  // Two calls of one step that fail alike are one failure, and a line that says nothing of the fault is not compared.
  expect(run([bash('pnpm test a', 0, 'boom: x'), bash('pnpm test b', 0, 'boom: x')]).events).toEqual([null, null])
  expect(run([bash('make a', 0, 'exit status 1'), bash('make b', 1, 'exit status 1')]).events).toEqual([null, null])
  // A call a hook or the person refused is no failure and no fix.
  expect(run([bash('git push', 0, 'x'), call('Bash', { command: 'git push' }, { step: 1, outcome: 'blocked', text: 'x' })]).events).toEqual([null, null])
})

test('the command a raise was for passing again is an event of its own; a skill loaded, an agent that ran in the foreground, and the task list moving on are events too', () => {
  const raised = { ...run([bash('pnpm test auth', 0, 'TypeError: a'), edit(1), bash('pnpm test auth', 2, 'TypeError: b')]).record, raisedFor: 'pnpm test auth', raisedAt: 2 }
  const passed = run([edit(3), bash('pnpm test auth', 4)], raised)
  expect(passed.events).toEqual([null, 'resolved'])
  expect(passed.record.resolved).toBe(true)
  expect(run([call('Skill', { skill: 'tdd' })]).events).toEqual(['skill'])
  expect(run([call('Agent', { description: 'audit the parser', prompt: 'x' }, { durationMs: 40_000 }), call('Agent', { description: 'in the background', prompt: 'x' }, { durationMs: 300 })]).events).toEqual(['handback', null])
  const todos = (doing: string) => call('TodoWrite', { todos: [{ content: 'read the code', status: doing === 'read the code' ? 'in_progress' : 'completed' }, { content: 'write the fix', status: doing === 'write the fix' ? 'in_progress' : 'pending' }] }, { step: doing === 'read the code' ? 0 : 9 })
  expect(run([todos('read the code'), todos('write the fix')]).events).toEqual([null, 'todo'])
})

test('the facts are counted by the code and said as sentences', () => {
  const { record } = run([bash('pnpm test auth', 0, 'TypeError: a'), edit(1), bash('pnpm test auth', 2, 'TypeError: b')])
  const facts = factsOf(record, { kind: 'failure', command: 'pnpm test auth', why: 'refail', refails: 1, latest: 'Bash: TypeError: b', earlier: 'Bash: TypeError: a' })
  expect(facts).toEqual(['The command `pnpm test auth` failed again after the assistant edited files since its last failure.', '2 of the 3 tool calls of this run failed.'])
  expect(factsOf(newRecord('t1'), { kind: 'report' })).toEqual(['A report was just delivered to the assistant while it works (`report`): a background task or a dispatched agent finished.', 'The assistant has not edited any file in this run.'])
})

// ---- the feature ---------------------------------------------------------------------------

/** The message's effort question gets `first`; each mid-run request the next of `later` (the last one again once they run out). */
function backend(first: readonly number[], later: readonly { levels: readonly number[]; nouls?: Record<string, number>; confidence?: number }[]) {
  let asked = 0
  return (request: Sent): Reply => {
    if (kind(request) !== 'midrun.level') return jev(first)(request)
    const answer = later[Math.min(asked++, later.length - 1)] ?? { levels: first }
    return jev(answer.levels, { nouls: answer.nouls ?? {}, ...(answer.confidence === undefined ? { confidence: 0.8 } : { confidence: answer.confidence }) })(request)
  }
}

const FAILS = { error: 'Exit code 1\nTypeError: token is undefined' }
const test0 = (index: number, ends?: StepOptions['tools'] extends (infer T)[] | undefined ? (T extends { ends?: infer E } ? E : never) : never): StepOptions => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Bash', input: { command: 'pnpm test auth', description: '跑 auth 的测试' }, ...(ends === undefined ? {} : { ends }) }] })
const fix = (index: number): StepOptions => ({ index, answer: '改一下 token 的读取', tools: [{ tool: 'Edit', input: { file_path: '/repo/src/auth/login.ts', old_string: 'a', new_string: 'b' } }] })
const quiet = (index: number): StepOptions => ({ index, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })

const efforts = (w: World) => w.steps.map((s) => String(s.effort))
const midrunLog = async (w: World) => (await w.board()).log.filter((entry) => entry.feature === 'midrun-effort')

/** A turn at medium whose test fails, is fixed, and fails again at step 2. */
async function failingTurn(w: World) {
  await w.submit('把登录的 token 读取修好，测试要过')
  await w.step(test0(0, FAILS))
  await w.step(fix(1))
  await w.step(test0(2, FAILS))
}

test('a failure that comes back after a fix asks about the run; an unknown cause raises the level: a row is appended as the call ends, and the steps after it go out at the new level', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }]) })
  await failingTurn(w)
  await w.step(quiet(3))
  await w.step(quiet(4))

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  // The row lands after the third request and before the fourth: the fourth carries input, and takes the level.
  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]).toMatchObject({ type: 'user', agentId: undefined, afterStep: 3 })
  expect(w.appended[0]?.text.includes('raised your reasoning effort from medium to high')).toBe(true)
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'high', 'high'])
  expect(w.turnRecord('t1')).toMatchObject({ effort: 'high', base: 'medium' })

  const [entry] = await midrunLog(w)
  expect(entry).toMatchObject({ agent: 'main', outcome: 'effort high（原 medium）', effort: 'high', tone: 'ok', midrun: { from: 'medium', to: 'high', base: 'medium', move: 'raise', event: 'failure', free: false } })
  expect(entry?.subject).toBe('第 2 步（改过之后又失败：pnpm test auth）')
  expect(entry?.trace?.map((step) => step.rule)).toContain('mid-cause')
  // The main agent's route stays its message's decision.
  expect((await w.board()).main).toMatchObject({ routed: true, effort: 'high' })
})

test('what the decision model reads of the run: the task, the steps oldest first with how each call ended and a failure\'s first line, the counted facts, and the two failures to compare', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM }]) })
  await failingTurn(w)
  const sent = w.requests[1]?.body as { state: Record<string, unknown>; questions: Record<string, { instructions: Record<string, string> }> }
  expect(sent.state.task).toBe('把登录的 token 读取修好，测试要过')
  expect(sent.state.recent_steps).toEqual([
    { step: 0, assistant_text: '第 0 步', tools: [{ tool: 'Bash', target: '跑 auth 的测试', outcome: 'failed', error: 'TypeError: token is undefined' }] },
    { step: 1, assistant_text: '改一下 token 的读取', tools: [{ tool: 'Edit', target: 'auth/login.ts', outcome: 'ok' }] },
    { step: 2, assistant_text: '', tools: [{ tool: 'Bash', target: '跑 auth 的测试', outcome: 'failed', error: 'TypeError: token is undefined' }] },
  ])
  expect(sent.state.facts).toEqual(['The command `pnpm test auth` failed again after the assistant edited files since its last failure.', '2 of the 3 tool calls of this run failed.'])
  expect(sent.questions['midrun.same_failure']?.instructions.latest_failure).toBe('Bash: TypeError: token is undefined')
  expect('current_effort' in sent.state).toBe(false)
})

test('a failure of the environment, or a cause already named, moves nothing: no row, every step at the message\'s level, and the log says the level was kept', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9, 'midrun.env_failure': 0.95 } }]) })
  await failingTurn(w)
  await w.step(quiet(3))
  expect(w.appended).toEqual([])
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'medium'])
  expect((await midrunLog(w))[0]).toMatchObject({ outcome: 'effort medium（保持）', tone: 'info', midrun: { move: 'keep' } })
})

test('the command a raise was for passes again: once the raise has stood long enough, the level goes back to the message\'s with a row and no question', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }]) })
  await failingTurn(w)
  await w.step(fix(3))
  // It passes one step after the raise: too soon for a second row.
  await w.step(test0(4))
  await w.step(quiet(5))
  expect(w.appended).toHaveLength(1)
  // Four steps after the raise the owed return is taken, as that step's call ends.
  await w.step(quiet(6))
  await w.step(quiet(7))

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  expect(w.appended.map((row) => row.afterStep)).toEqual([3, 7])
  expect(w.appended[1]?.text.includes('lowered your reasoning effort from high to medium: the command that kept failing passes again')).toBe(true)
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'high', 'high', 'high', 'high', 'medium'])
  expect((await midrunLog(w)).map((entry) => entry.midrun?.move)).toEqual(['raise', 'return'])
  expect((await midrunLog(w))[1]).toMatchObject({ subject: '第 6 步（失败的命令重新通过：pnpm test auth）', midrun: { event: 'resolved', from: 'high', to: 'medium' } })
})

test('a step after one without tool calls carries input (a Stop hook\'s feedback): the owed return is taken there without a row', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }]) })
  await failingTurn(w)
  await w.step(fix(3))
  await w.step(test0(4))
  // The assistant answers and would stop; a Stop hook sends it on.
  await w.step({ index: 5, answer: '修好了。' })
  await w.step({ index: 6, answer: '记一下。' })
  expect(w.appended).toHaveLength(1)
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'high', 'high', 'high', 'medium'])
  expect((await midrunLog(w))[1]).toMatchObject({ midrun: { move: 'return', free: true } })
})

test('a report delivered into the running turn is asked about before it is delivered, and the level moves without a row', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: [0, 0.1, 0.9, 0, 0] }]) })
  await w.submit('并行审查三个模块，汇总结论')
  await w.step(quiet(0))
  await w.submit('<task-notification>agent a1 finished: found a race in the session cache; the fix needs a design for cross-process locking</task-notification>', { origin: { kind: 'task-notification' }, turnId: 't1' })
  await w.step(quiet(1))

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  expect((w.requests[1]?.body as { state: { report: string; facts: string[] } }).state.report.includes('found a race in the session cache')).toBe(true)
  expect(w.appended).toEqual([])
  expect(efforts(w)).toEqual(['medium', 'high'])
  expect((await midrunLog(w))[0]).toMatchObject({ midrun: { move: 'raise', event: 'report', free: true } })
})

test('a skill loaded asks about the run; a rest that is only carrying out goes one level under the message\'s, and not with midrun-down off', { options: KEY }, async ($, on) => {
  const rest = { levels: [0.1, 0.8, 0.1, 0, 0], nouls: { 'midrun.mechanical_rest': 0.9, 'midrun.new_ground': 0.05 } }
  const skill = (index: number): StepOptions => ({ index, tools: [{ tool: 'Skill', input: { skill: 'changelog' } }] })
  const w = world($, on, { backend: backend(HIGH, [rest]) })
  await w.submit('把这次重构做完，最后更新 CHANGELOG')
  await w.step(skill(0))
  await w.step(quiet(1))
  expect(efforts(w)).toEqual(['high', 'medium'])
  expect(w.appended[0]?.text.includes('lowered your reasoning effort from high to medium: what is left reads as carrying out what is already worked out')).toBe(true)
  expect((await midrunLog(w))[0]).toMatchObject({ midrun: { move: 'down', event: 'skill', base: 'high' } })
})

test('with midrun-down off the same answers keep the level', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(HIGH, [{ levels: [0.1, 0.8, 0.1, 0, 0], nouls: { 'midrun.mechanical_rest': 0.9, 'midrun.new_ground': 0.05 } }]), switches: { 'midrun-down': false } })
  await w.submit('把这次重构做完，最后更新 CHANGELOG')
  await w.step({ index: 0, tools: [{ tool: 'Skill', input: { skill: 'changelog' } }] })
  await w.step(quiet(1))
  expect(efforts(w)).toEqual(['high', 'high'])
  expect(w.appended).toEqual([])
})

test('nothing is asked for a turn the person locked, with midrun-effort off, or with /dp off; and a message\'s rule floor holds against a lowering', { options: KEY }, async ($, on) => {
  const answers = [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }]
  const off = world($, on, { backend: backend(MEDIUM, answers), switches: { 'midrun-effort': false } })
  await failingTurn(off)
  await off.step(quiet(3))
  expect(off.requests.map(kind)).toEqual(['effort.level'])
  expect(efforts(off)).toEqual(['medium', 'medium', 'medium', 'medium'])
  expect(off.appended).toEqual([])
})

test('a locked turn is not asked about and not moved', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }]), session: true })
  await w.start()
  await w.command('dp', 'lock high')
  await failingTurn(w)
  await w.step(quiet(3))
  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(efforts(w)).toEqual(['high', 'high', 'high', 'high'])
  expect(w.appended).toEqual([])
})

test('a request that fails, and a row the engine refuses, leave the level where it was: the board says why, and never names a level the model is not on', { options: KEY }, async ($, on) => {
  const down = world($, on, { backend: (request) => (kind(request) === 'midrun.level' ? { status: 503, body: 'busy' } : jev(MEDIUM)(request)) })
  await failingTurn(down)
  await down.step(quiet(3))
  expect(efforts(down)).toEqual(['medium', 'medium', 'medium', 'medium'])
  expect((await down.board()).notes.filter((note) => note.feature === 'midrun-effort')).toMatchObject([{ kind: 'failed', id: 'main' }])
})

test('a row the engine refuses moves nothing', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }]), appendRefused: 'no rows in this build' })
  await failingTurn(w)
  await w.step(quiet(3))
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'medium'])
  expect(w.turnRecord('t1')).toMatchObject({ effort: 'medium' })
  expect((await midrunLog(w))[0]).toMatchObject({ outcome: 'effort medium（保持）', midrun: { move: 'keep', to: 'medium' } })
})

test('a message typed into the turn sets its level and where a raise returns to; the turn\'s rule floor is its decision\'s highest floor', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (kind(request) === 'midrun.level' ? jev([0.9, 0.1, 0, 0, 0], { nouls: { 'midrun.mechanical_rest': 0.9 }, confidence: 0.9 })(request) : jev(n === 1 ? MEDIUM : HIGH, n === 1 ? {} : { nouls: { 'effort.cause_unknown': 0.9 } })(request)) })
  await w.submit('先看看登录模块')
  await w.step(quiet(0))
  expect(w.turnRecord('t1')).toMatchObject({ effort: 'medium', base: 'medium', ruleFloor: null })
  await w.submit('测试挂了，原因不明，查一下', { turnId: 't1' })
  expect(w.turnRecord('t1')).toMatchObject({ effort: 'high', base: 'high', ruleFloor: 'high' })
  // A rest that reads as carrying out does not take the turn under the floor the person's message set.
  await w.step({ index: 1, tools: [{ tool: 'Skill', input: { skill: 'changelog' } }] })
  await w.step(quiet(2))
  expect(efforts(w)).toEqual(['medium', 'high', 'high'])
  expect(w.appended).toEqual([])
})

// ---- a dispatched agent ------------------------------------------------------------------

const agentFails = (index: number): StepOptions => ({ index, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium', tools: [{ tool: 'Bash', input: { command: 'pnpm test auth' }, ends: FAILS }, { tool: 'Bash', input: { command: 'pnpm test api' }, ends: FAILS }] })

test('a dispatched agent whose calls keep failing has its effort raised one level first, with a row in its own conversation; only when they reach the bar again does its model go up', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), agents: [{ id: 'a1', name: 'fixer', description: 'fix the login tests', type: 'general-purpose', status: 'running' } as never] })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  await w.step(agentFails(0))
  await w.step({ index: 1, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]).toMatchObject({ type: 'user', agentId: 'a1' })
  expect(w.appended[0]?.text.includes('raised your reasoning effort from medium to high: several of your tool calls failed')).toBe(true)
  const agentSteps = () => w.steps.filter((s) => s.agentId === 'a1').map((s) => `${s.model}:${String(s.effort)}`)
  expect(agentSteps()).toEqual(['claude-sonnet-5-5:medium', 'claude-sonnet-5-5:high'])
  const raises = async () => (await w.board()).log.filter((entry) => entry.feature === 'escalation').map((entry) => entry.forced)
  expect(await raises()).toEqual([{ kind: 'effort', from: 'medium', to: 'high' }])

  // The failures are counted afresh; at the bar again, the model.
  await w.step({ ...agentFails(2), effort: 'medium' })
  await w.step({ index: 3, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(w.appended).toHaveLength(1)
  expect(agentSteps().at(-1)).toBe('claude-opus-5-5:high')
  expect(await raises()).toEqual([{ kind: 'effort', from: 'medium', to: 'high' }, { kind: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' }])
})

test('a failing agent on xhigh has its effort raised to max: no cap in the middle of a run', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), agents: [{ id: 'a1', name: 'fixer', description: 'fix the login tests', type: 'general-purpose', status: 'running' } as never] })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  await w.step({ ...agentFails(0), effort: 'xhigh' })
  await w.step({ index: 1, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]?.text.includes('raised your reasoning effort from xhigh to max')).toBe(true)
  expect(w.steps.filter((s) => s.agentId === 'a1').map((s) => `${s.model}:${String(s.effort)}`)).toEqual(['claude-sonnet-5-5:xhigh', 'claude-sonnet-5-5:max'])
  expect((await w.board()).log.filter((entry) => entry.feature === 'escalation').map((entry) => entry.forced)).toEqual([{ kind: 'effort', from: 'xhigh', to: 'max' }])
})

test('a failing agent already on max has no level left: its model goes up at once', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), agents: [{ id: 'a1', name: 'fixer', description: 'fix the login tests', type: 'general-purpose', status: 'running' } as never] })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  await w.step({ ...agentFails(0), effort: 'max' })
  await w.step({ index: 1, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'max' })
  expect(w.appended).toEqual([])
  expect(w.steps.filter((s) => s.agentId === 'a1').map((s) => `${s.model}:${String(s.effort)}`)).toEqual(['claude-sonnet-5-5:max', 'claude-opus-5-5:max'])
})

test('an agent the engine does not list (a Workflow\'s), and any agent with midrun-effort off, goes straight to the next model up, as before', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), agents: [{ id: 'a1', name: 'fixer', description: 'fix', type: 'general-purpose', status: 'running' } as never], switches: { 'midrun-effort': false } })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  await w.step(agentFails(0))
  await w.step({ index: 1, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(w.appended).toEqual([])
  expect(w.steps.filter((s) => s.agentId === 'a1').map((s) => `${s.model}:${String(s.effort)}`)).toEqual(['claude-sonnet-5-5:medium', 'claude-opus-5-5:medium'])
})

test('with escalateLimit 0 a failing agent keeps its model: every time its failures reach the bar its effort goes one more level up, to max', { options: { ...KEY, escalateLimit: 0 } }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), agents: [{ id: 'a1', name: 'fixer', description: 'fix the login tests', type: 'general-purpose', status: 'running' } as never] })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  // Each failing step reaches the bar (two failed calls); the step after it goes out at the level the plan now names.
  for (const index of [0, 2, 4, 6, 8]) {
    await w.step(agentFails(index))
    await w.step({ index: index + 1, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  }
  const agentSteps = w.steps.filter((s) => s.agentId === 'a1').map((s) => `${s.model}:${String(s.effort)}`)
  // Never another model; medium, then a level at each bar, then max for good.
  expect(agentSteps.every((step) => step.startsWith('claude-sonnet-5-5:'))).toBe(true)
  expect(agentSteps.filter((_, at) => at % 2 === 1)).toEqual(['claude-sonnet-5-5:high', 'claude-sonnet-5-5:xhigh', 'claude-sonnet-5-5:max', 'claude-sonnet-5-5:max', 'claude-sonnet-5-5:max'])
  expect(w.appended.map((row) => row.agentId)).toEqual(['a1', 'a1', 'a1'])
  const log = (await w.board()).log.filter((entry) => entry.feature === 'escalation')
  expect(log.map((entry) => entry.forced)).toEqual([{ kind: 'effort', from: 'medium', to: 'high' }, { kind: 'effort', from: 'high', to: 'xhigh' }, { kind: 'effort', from: 'xhigh', to: 'max' }])
  expect(log[0]?.reason).toContain('不换模型（escalateLimit 是 0），再失败到门槛就再升一档，直到 max')
})

test('an agent whose model cannot go up any more has its effort raised again instead: on the top model, and with its step-ups used up', { options: { ...KEY, escalateLimit: 1 } }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), agents: [{ id: 'a1', name: 'fixer', description: 'fix the login tests', type: 'general-purpose', status: 'running' } as never] })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  for (const index of [0, 2, 4, 6]) {
    await w.step(agentFails(index))
    await w.step({ index: index + 1, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  }
  // The effort first, the model once (escalateLimit 1), then the effort again, a level at each bar.
  expect((await w.board()).log.filter((entry) => entry.feature === 'escalation').map((entry) => entry.forced)).toEqual([
    { kind: 'effort', from: 'medium', to: 'high' },
    { kind: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' },
    { kind: 'effort', from: 'high', to: 'xhigh' },
    { kind: 'effort', from: 'xhigh', to: 'max' },
  ])
  expect(w.steps.filter((s) => s.agentId === 'a1').at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' })
})

const FIXER = { id: 'a1', name: 'fixer', description: 'fix the login tests', type: 'general-purpose', status: 'running' } as never
/** A failing agent's world, dispatched and one main step in; `raised` is what the escalation feature decided, in order. */
async function failingAgent($: Parameters<typeof world>[0], on: Parameters<typeof world>[1], options: Parameters<typeof world>[2] = {}) {
  const w = world($, on, { backend: jev(MEDIUM), agents: [FIXER], ...options })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  const log = async () => (await w.board()).log.filter((entry) => entry.feature === 'escalation')
  const raised = async () => (await log()).map((entry) => entry.forced)
  const agentSteps = () => w.steps.filter((s) => s.agentId === 'a1').map((s) => `${s.model}:${String(s.effort)}`)
  /** A step whose two calls fail (the bar), then a quiet step that shows what the next step goes out with. */
  const failThenStep = async (index: number, model = 'claude-sonnet-5-5') => {
    await w.step({ ...agentFails(index), model })
    await w.step({ index: index + 1, agentId: 'a1', model, effort: 'medium' })
  }
  return { w, log, raised, agentSteps, failThenStep }
}

test('an agent on the strongest model it may run on has its effort raised again, and the last raise says there is no level left', { options: KEY }, async ($, on) => {
  const { w, log, raised, failThenStep } = await failingAgent($, on)
  // Opus is the top without agentFable: the effort first, then the effort again at every bar, the model never.
  for (const index of [0, 2, 4, 6]) await failThenStep(index, 'claude-opus-5-5')
  // On max with no model above: the fourth bar raises nothing, and its decision says why.
  expect(await raised()).toEqual([{ kind: 'effort', from: 'medium', to: 'high' }, { kind: 'effort', from: 'high', to: 'xhigh' }, { kind: 'effort', from: 'xhigh', to: 'max' }, undefined])
  const reasons = (await log()).map((entry) => entry.reason)
  expect(reasons[1]).toContain('不换模型（已经是 opus（fable 要打开 agentFable）），再失败到门槛就再升一档，直到 max')
  expect(reasons[2]).toContain('已经到 max，之后不再升')
  expect(reasons[2]).not.toContain('再失败到门槛就再升一档')
  expect(reasons[3]).toContain('没有升模型：已经是 opus（fable 要打开 agentFable）')
  expect(w.steps.filter((s) => s.agentId === 'a1').every((s) => s.model === 'claude-opus-5-5')).toBe(true)
})

test('a row the engine refuses raises no effort and says so: the model goes up where it can, and the log never claims a level that did not go out', { options: KEY }, async ($, on) => {
  const { w, log, raised, agentSteps, failThenStep } = await failingAgent($, on, { appendRefused: 'no rows in this build' })
  await failThenStep(0)
  expect(w.appended).toEqual([])
  expect(await raised()).toEqual([{ kind: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' }])
  expect((await log())[0]?.reason).not.toContain('effort 已经升过一档')
  expect(agentSteps()).toEqual(['claude-sonnet-5-5:medium', 'claude-opus-5-5:medium'])
})

test('with escalateLimit 0 a row the engine refuses leaves the agent as it is, and the decision says why', { options: { ...KEY, escalateLimit: 0 } }, async ($, on) => {
  const { log, raised, agentSteps, failThenStep } = await failingAgent($, on, { appendRefused: 'no rows in this build' })
  await failThenStep(0)
  expect(await raised()).toEqual([undefined])
  expect((await log())[0]).toMatchObject({ outcome: 'effort medium（保持）' })
  expect((await log())[0]?.reason).toContain('本想把 effort 升到 high，但给它追加提示行不成，这一档发不出去；不换模型（escalateLimit 是 0）')
  expect(agentSteps()).toEqual(['claude-sonnet-5-5:medium', 'claude-sonnet-5-5:medium'])
})

test('with escalateLimit 0 an agent whose effort cannot be raised in the middle of its run keeps both: a Workflow\'s agent (not in the roster), and any agent with midrun-effort off', { options: { ...KEY, escalateLimit: 0 } }, async ($, on) => {
  const unlisted = await failingAgent($, on, { agents: [] })
  for (const index of [0, 2]) await unlisted.failThenStep(index)
  expect(await unlisted.raised()).toEqual([])
  expect(unlisted.w.appended).toEqual([])
  expect(new Set(unlisted.agentSteps())).toEqual(new Set(['claude-sonnet-5-5:medium']))
})

test('with escalateLimit 0 and midrun-effort off nothing is raised', { options: { ...KEY, escalateLimit: 0 } }, async ($, on) => {
  const off = await failingAgent($, on, { switches: { 'midrun-effort': false } })
  for (const index of [0, 2]) await off.failThenStep(index)
  expect(await off.raised()).toEqual([])
  expect(new Set(off.agentSteps())).toEqual(new Set(['claude-sonnet-5-5:medium']))
})

test('the calls of one step that fail together raise one thing, however many times they reach the bar between them', { options: KEY }, async ($, on) => {
  const { w, raised, agentSteps } = await failingAgent($, on)
  const HAIKU = 'claude-haiku-5-5'
  const four = (index: number): StepOptions => ({ index, agentId: 'a1', model: HAIKU, effort: 'medium', parallel: true, tools: Array.from({ length: 4 }, (_, i) => ({ tool: 'Bash', input: { command: `pnpm test part-${i}` }, ends: FAILS })) })
  const next = (index: number) => w.step({ index, agentId: 'a1', model: HAIKU, effort: 'medium' })
  // Four calls fail at once: the bar is reached twice, the effort goes up once and the model not at all.
  await w.step(four(0))
  await next(1)
  expect(await raised()).toEqual([{ kind: 'effort', from: 'medium', to: 'high' }])
  expect(w.appended).toHaveLength(1)
  // Again: the model goes up once (haiku to sonnet, not on to opus within the step), and is counted once.
  await w.step(four(2))
  await next(3)
  expect(await raised()).toEqual([{ kind: 'effort', from: 'medium', to: 'high' }, { kind: 'model', from: HAIKU, to: 'claude-sonnet-5-5' }])
  expect(agentSteps().at(-1)).toBe('claude-sonnet-5-5:high')
  // So the agent still has its second step-up (escalateLimit 2): counted twice, this bar would have raised the effort instead.
  await w.step(four(4))
  await next(5)
  expect((await raised()).at(-1)).toEqual({ kind: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' })
  expect(await raised()).toHaveLength(3)
})

// ---- the card's words ------------------------------------------------------------------

test('the rules\' working reads in the card\'s words, every number from the step itself', () => {
  const raised = decideMidrun(reading([0, 0.2, 0.8, 0, 0]), { ...NO_SIGNALS, causeUnknown: 0.9, envFailure: 0.1, sameFailure: 0.8, stakes: { undo: 0.1, live: 0.1, access: 0.1 } }, at('medium', { event: 'failure' }))
  const lines = Object.fromEntries(stepLines(raised.steps as never).map((line) => [line.head, `${line.mark}: ${line.body}`]))
  expect(lines['两侧']).toBe('hit: 读出 high，现在 medium；更高各档合计 .80（升档要 ≥ .30），更低各档合计 .00（降档要 ≥ .70）')
  expect(lines['原因未知']).toBe('lift: .90（是） · 环境故障 .10（否） · 同一个故障 .80（是） → 下限 high，抬到 high')
  expect(lines['升档']).toBe('pass: 读出 high，更高各档合计 .80：不升')
  expect(lines['降一档']?.startsWith('pass: 只是照做 没回答 · 发现新工作 没回答 · 更低各档合计 .00')).toBe(true)

  const down = decideMidrun(reading([0.1, 0.8, 0.1, 0, 0]), { ...NO_SIGNALS, mechanicalRest: 0.9, newGround: 0.05 }, at('high'))
  expect(stepLines(down.steps as never).find((line) => line.head === '降一档')).toEqual({ mark: 'hit', head: '降一档', body: '只是照做 .90（是） · 发现新工作 .05（否） · 更低各档合计 .90 ≥ .70：降到 medium' })
  const held = decideMidrun(reading(HIGH), NO_SIGNALS, at('medium', { sinceSwitch: 1, switches: 1 }))
  expect(stepLines(held.steps as never).at(-1)).toEqual({ mark: 'hit', head: '防抖', body: '本想换到 high，但离上一次换档只有 1 步（至少 4）：保持 medium' })
  // On high already, the first failure with an unknown cause says why it lifts nothing yet.
  const first = decideMidrun(reading(HIGH), { ...NO_SIGNALS, causeUnknown: 0.9 }, at('high', { event: 'failure' }))
  expect(stepLines(first.steps as never).find((line) => line.head === '原因未知')?.body).toBe('.90（是） · 环境故障 没回答 → 已在 high 以上：这一轮再有一次这样的失败才升')
})

test('on high already, the first failure whose cause is unknown keeps the level; a second one in the turn takes it to xhigh', { options: KEY }, async ($, on) => {
  const stuck = { levels: HIGH, nouls: { 'midrun.cause_unknown': 0.9 } }
  const w = world($, on, { backend: backend(HIGH, [stuck, stuck]) })
  await failingTurn(w)
  await w.step(fix(3))
  await w.step(test0(4, FAILS))
  await w.step(quiet(5))
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level', 'midrun.level'])
  expect(efforts(w)).toEqual(['high', 'high', 'high', 'high', 'high', 'xhigh'])
  expect((await midrunLog(w)).map((entry) => entry.midrun?.move)).toEqual(['keep', 'raise'])
  expect(w.appended).toHaveLength(1)
})

// ---- after the review and the eval of 2026-11-10 --------------------------------------------

test('a failure of the environment is not raised for what the work reads as; an answer without a confidence goes back to the message\'s level but not under it; the turn\'s last row is a raise\'s', () => {
  const failed = at('medium', { event: 'failure' })
  expect(decideMidrun(reading(HIGH), { ...NO_SIGNALS, envFailure: 0.9, causeUnknown: 0.9 }, failed)).toMatchObject({ effort: 'medium', move: 'keep' })
  expect(decideMidrun(reading(HIGH), { ...NO_SIGNALS, envFailure: 0.9 }, at('medium'))).toMatchObject({ effort: 'high', move: 'raise', reason: 'reading' })
  expect(decideMidrun(reading(HIGH), { ...NO_SIGNALS, envFailure: 0.9, stakes: { undo: 0.9, live: 0.9, access: null } }, failed)).toMatchObject({ effort: 'xhigh', reason: 'stakes' })
  expect(stepLines(decideMidrun(reading(HIGH), { ...NO_SIGNALS, envFailure: 0.9 }, failed).steps as never).find((line) => line.head === '升档')?.body).toBe('读出 high，更高各档合计 1.0，但这次失败来自环境：不升')

  const rest = { ...NO_SIGNALS, mechanicalRest: 0.9, newGround: 0.05 }
  expect(decideMidrun(reading([0.1, 0.8, 0.1, 0, 0], null), rest, at('high'))).toMatchObject({ effort: 'high', move: 'keep' })
  expect(decideMidrun(reading([0.1, 0.8, 0.1, 0, 0], null), NO_SIGNALS, at('high', { base: 'medium' }))).toMatchObject({ effort: 'medium', move: 'return' })

  const oneLeft = { sinceSwitch: 20, switches: MAX_SWITCHES - 1 }
  const back = decideMidrun(reading([0, 0.9, 0.1, 0, 0]), NO_SIGNALS, at('high', { base: 'medium', ...oneLeft }))
  expect(back).toMatchObject({ effort: 'high', move: 'keep', reason: 'held' })
  expect(stepLines(back.steps as never).at(-1)?.body).toBe(`本想换到 medium，但这一轮追加换档已有 ${MAX_SWITCHES - 1} 次（最后一次留给升档，往回最多 ${MAX_SWITCHES - 1}）：保持 high`)
  expect(decideMidrun(reading(HIGH), NO_SIGNALS, at('medium', oneLeft))).toMatchObject({ effort: 'high', move: 'raise' })
})

test('what counts as the same thing failing again: a tool of an MCP server by its name, a fix made from the shell, and not two failures that only open with the same generic line', () => {
  const build = (step: number, error?: string): CallEnd => call('mcp__xcode__BuildProject', {}, { step, ...(error === undefined ? {} : { outcome: 'failed', text: error }) })
  const mcp = run([build(0, "error: cannot find 'foo' in scope"), call('mcp__xcode__XcodeUpdate', { file_path: '/app/B.swift' }, { step: 1 }), build(2, "error: cannot find 'bar' in scope")])
  expect(mcp.events).toEqual([null, null, 'failure:refail'])
  expect(mcp.record.edits).toBe(1)
  // An MCP tool that never fails is not kept among the commands.
  expect(Object.keys(run([call('mcp__spider__spider_scrape', { url: 'https://example.com' })]).record.commands)).toEqual([])

  const patched = run([bash('pnpm test auth', 0, 'TypeError: a'), bash("python3 - <<'EOF'\nopen('a.ts', 'w').write('x')\nEOF", 1), bash('pnpm test auth', 2, 'TypeError: b')])
  expect(patched.events).toEqual([null, null, 'failure:refail'])
  // A command that only reads leaves the count of edits alone.
  expect(run([bash('pnpm test auth 2>&1 | tail -5', 0), bash('ls > /dev/null', 1)]).record.edits).toBe(0)

  const traceback = (file: string, step: number, error: string) => bash(`python ${file}`, step, `Traceback (most recent call last):\n  File "${file}", line 3\n${error}`)
  expect(run([traceback('a.py', 0, 'KeyError: 1'), traceback('b.py', 1, 'ValueError: 2')]).events).toEqual([null, null])
  expect(run([bash('npm test', 0, 'npm error code ELIFECYCLE'), bash('npm run build', 1, 'npm error code ELIFECYCLE')]).events).toEqual([null, null])
})

test('a dispatch that only launched its agent is no hand-back, however long the call took; the task list moves on through TaskUpdate and a host\'s plan tool too', () => {
  expect(run([call('Agent', { description: 'audit the parser', prompt: 'x' }, { durationMs: 40_000, text: 'Async agent launched successfully.\nagentId: a1' })]).events).toEqual([null])
  expect(run([call('Workflow', { script: 'x' }, { durationMs: 9_000, text: 'Workflow launched in background (run wf_1).' })]).events).toEqual([null])
  expect(run([call('Agent', { description: 'audit the parser', prompt: 'x' }, { durationMs: 40_000, text: 'The parser drops trailing commas in two places.' })]).events).toEqual(['handback'])

  const started = (taskId: string, step: number): CallEnd => call('TaskUpdate', { taskId, status: 'in_progress' }, { step })
  const tasks = run([started('1', 0), call('TaskUpdate', { taskId: '1', status: 'completed' }, { step: 8 }), started('2', 8)])
  expect(tasks.events).toEqual([null, null, 'todo'])
  expect(factsOf(tasks.record, { kind: 'todo', item: '', done: 0, total: 0 })[0]).toBe("The assistant's task list has just moved on to its next item.")

  const plan = (input: Record<string, unknown>, step: number): CallEnd => call('mcp__ccd_turn__update_plan', input, { step })
  const planned = run([plan({ items: [{ content: 'read the code', status: 'in_progress' }, { content: 'write the fix', status: 'pending' }] }, 0), plan({ done: ['read the code'], start: 'write the fix' }, 7), plan({ advance: true }, 12)])
  expect(planned.events).toEqual([null, 'todo', 'todo'])
  expect(planned.record.edits).toBe(0)
})

test('the state keeps within its budget whatever a step held: the latest calls of a step with the count of the others, the latest of the person\'s rules', () => {
  const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ tool: 'Read', target: `src/file-${i}.ts`, outcome: 'ok' as const }))
  const [shown] = midrunState({ task: '读一遍', recent_steps: [{ step: 3, assistant_text: '看一下', tools: calls(60) }], facts: [] }).recent_steps as { tools: { target: string }[]; earlier_calls_not_shown?: number }[]
  expect(shown?.tools).toHaveLength(12)
  expect(shown?.earlier_calls_not_shown).toBe(48)
  expect(shown?.tools.at(-1)?.target).toBe('src/file-59.ts')

  // The record keeps the latest calls of a step too, with the count of those it dropped.
  const [kept] = run(Array.from({ length: 30 }, (_, i) => call('Read', { file_path: `/repo/src/f${i}.ts` }, { step: 0 }))).record.recent
  expect(kept?.tools).toHaveLength(24)
  expect(kept?.earlier_calls_not_shown).toBe(6)

  const rules = Array.from({ length: 5 }, (_, i) => ({ person_said: `rule ${i} ${'word '.repeat(290)}`, assistant_before: 'reply '.repeat(140) }))
  const full = midrunState({ task: '任务 '.repeat(4000), recent_steps: Array.from({ length: 8 }, (_, step) => ({ step, assistant_text: '想法 '.repeat(200), tools: calls(40) })), facts: ['A report was just delivered.'], constraints: rules, report: 'r '.repeat(3000), next_item: 'item '.repeat(300) })
  expect(estimateTokens(JSON.stringify(full))).toBeLessThanOrEqual(4000)
  const sent = full.standing_constraints as { person_said: string }[]
  expect(sent.length).toBeLessThan(5)
  expect(sent.at(-1)?.person_said.startsWith('rule 4 ')).toBe(true)
  expect((full.recent_steps as unknown[]).length).toBeGreaterThanOrEqual(1)
})

test('of the calls of a step that end together, one takes the level back: one row, one switch counted', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }]) })
  await failingTurn(w)
  await w.step(fix(3))
  await w.step(test0(4))
  await w.step(quiet(5))
  await w.step({ index: 6, parallel: true, tools: [1, 2, 3, 4].map((n) => ({ tool: 'Read', input: { file_path: `/repo/src/p${n}.ts` } })) })
  await w.step(quiet(7))

  expect(w.appended).toHaveLength(2)
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'high', 'high', 'high', 'high', 'medium'])
  expect((await midrunLog(w)).map((entry) => entry.midrun?.move)).toEqual(['raise', 'return'])
})

test('a raise the stakes then hold is not taken back when the failing command passes', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }, { levels: MEDIUM, nouls: { 'midrun.stakes.undo': 0.9, 'midrun.stakes.live': 0.9 } }]) })
  await failingTurn(w)
  for (const index of [3, 4, 5]) await w.step(quiet(index))
  await w.step({ index: 6, tools: [{ tool: 'Skill', input: { skill: 'release' } }] })
  await w.step(fix(7))
  await w.step(test0(8))
  for (const index of [9, 10, 11, 12, 13]) await w.step(quiet(index))

  expect((await midrunLog(w)).map((entry) => [entry.midrun?.event, entry.midrun?.move, entry.midrun?.to])).toEqual([['failure', 'raise', 'high'], ['skill', 'raise', 'xhigh']])
  expect(w.appended).toHaveLength(2)
  expect(efforts(w).slice(7)).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh'])
})

test('a raise for a failure that stands above the level the stakes asked for is taken back to that level, not to the message\'s, when the command passes', { options: KEY }, async ($, on) => {
  const stuckAndRisky = { levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9, 'midrun.stakes.undo': 0.9 } }
  const w = world($, on, { backend: backend(MEDIUM, [stuckAndRisky, stuckAndRisky]) })
  await failingTurn(w)
  await w.step(fix(3))
  await w.step(test0(4, FAILS))
  await w.step(fix(5))
  await w.step(test0(6))
  for (const index of [7, 8, 9, 10]) await w.step(quiet(index))

  const log = await midrunLog(w)
  expect(log.map((entry) => [entry.midrun?.event, entry.midrun?.move, entry.midrun?.to])).toEqual([['failure', 'raise', 'high'], ['failure', 'raise', 'xhigh'], ['resolved', 'return', 'high']])
  expect(w.appended).toHaveLength(3)
  expect(efforts(w).slice(5)).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh', 'high', 'high'])
  // The log says where it went back to, and that it is not the message's level.
  expect(log.at(-1)?.reason).toBe('失败的命令重新通过，回到出错代价要的 high（发消息时是 medium）')

  // The decision alone: the floor is the higher of the message's level and the stakes'; at or under it nothing moves.
  expect(resolvedDecision({ current: 'xhigh', base: 'medium' }, 'pnpm test auth', 4, 'high')).toMatchObject({ effort: 'high', move: 'return', reason: 'resolved' })
  expect(resolvedDecision({ current: 'high', base: 'medium' }, 'pnpm test auth', 4, 'high')).toMatchObject({ effort: 'high', move: 'keep' })
  expect(resolvedDecision({ current: 'xhigh', base: 'high' }, 'pnpm test auth', 4, 'medium')).toMatchObject({ effort: 'high', move: 'return' })
  expect(resolvedDecision({ current: 'high', base: 'medium' }, 'pnpm test auth', 4)).toMatchObject({ effort: 'medium', move: 'return' })
})

test('a loop that climbed three rows to max may take the turn\'s last row to come back: on max there is no raise to keep it for', { options: KEY }, async ($, on) => {
  const stuck = { levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }
  const w = world($, on, { backend: backend(MEDIUM, [stuck, stuck, stuck]) })
  await failingTurn(w)
  await w.step(fix(3))
  await w.step(test0(4, FAILS))
  await w.step(fix(5))
  await w.step(test0(6, FAILS))
  await w.step(fix(7))
  await w.step(test0(8))
  for (const index of [9, 10, 11]) await w.step(quiet(index))

  expect((await midrunLog(w)).map((entry) => [entry.midrun?.move, entry.midrun?.to])).toEqual([['raise', 'high'], ['raise', 'xhigh'], ['raise', 'max'], ['return', 'medium']])
  expect(w.appended).toHaveLength(MAX_SWITCHES)
  expect(efforts(w).at(-1)).toBe('medium')
  expect((await midrunLog(w)).at(-1)?.reason).toBe('失败的命令重新通过，回到发消息时的 medium')

  // The rule alone: the last row is a raise's, except on max.
  expect([rowsFor('raise'), rowsFor('return'), rowsFor('down', 'xhigh'), rowsFor('return', 'max')]).toEqual([MAX_SWITCHES, MAX_SWITCHES - 1, MAX_SWITCHES - 1, MAX_SWITCHES])
  const spent = { base: 'medium' as const, event: 'todo' as const, switches: MAX_SWITCHES - 1, sinceSwitch: 9 }
  expect(decideMidrun(reading(MEDIUM), NO_SIGNALS, at('max', spent))).toMatchObject({ effort: 'medium', move: 'return' })
  expect(decideMidrun(reading(MEDIUM), NO_SIGNALS, at('xhigh', spent))).toMatchObject({ effort: 'xhigh', move: 'keep', reason: 'held' })
})

test('a message typed into the turn drops what the run had flagged before it: a raise after it is taken back to the new message\'s level', { options: KEY }, async ($, on) => {
  let asked = 0
  let messages = 0
  const w = world($, on, {
    backend: (request) => {
      if (kind(request) === 'midrun.level') return jev(MEDIUM, { nouls: asked++ === 0 ? { 'midrun.stakes.undo': 0.9 } : { 'midrun.cause_unknown': 0.9 }, confidence: 0.8 })(request)
      return jev(messages++ === 0 ? MEDIUM : LOW)(request)
    },
  })
  await w.submit('把发布脚本过一遍')
  // A skill is loaded: the stakes read yes, the loop goes to high and the turn's record keeps that floor.
  await w.step({ index: 0, tools: [{ tool: 'Skill', input: { skill: 'release' } }] })
  await w.step(quiet(1))
  expect(efforts(w)).toEqual(['medium', 'high'])
  await w.submit('先别管发布，只跑一下单元测试', { turnId: 't1' })
  await w.step(test0(2, FAILS))
  await w.step(fix(3))
  await w.step(test0(4, FAILS))
  await w.step(fix(5))
  await w.step(test0(6))
  for (const index of [7, 8, 9]) await w.step(quiet(index))

  expect((await midrunLog(w)).map((entry) => [entry.midrun?.event, entry.midrun?.move, entry.midrun?.to])).toEqual([['skill', 'raise', 'high'], ['failure', 'raise', 'high'], ['resolved', 'return', 'low']])
  expect(efforts(w).slice(2)).toEqual(['low', 'low', 'low', 'high', 'high', 'high', 'high', 'low'])
})

test('a command that passed and fails after an edit is asked about no sooner than the gap after the last question; one that fails again after a fix is asked about at once', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, [{ levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.1 } }]) })
  await failingTurn(w)
  await w.step(test0(3))
  await w.step(fix(4))
  // Passed at step 3, edited, fails at step 5: three steps after the question at step 2.
  await w.step(test0(5, FAILS))
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  await w.step(fix(6))
  await w.step(test0(7, FAILS))
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level', 'midrun.level'])
})

test('a dispatched agent whose calls of one step reach the bar twice has its effort raised, and its model left for a later step', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM), agents: [{ id: 'a1', name: 'fixer', description: 'fix the login tests', type: 'general-purpose', status: 'running' } as never] })
  await w.submit('派一个 agent 去修登录测试')
  await w.step({ index: 0 })
  await w.step({ index: 0, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium', tools: ['auth', 'api', 'web', 'cli'].map((name) => ({ tool: 'Bash', input: { command: `pnpm test ${name}` }, ends: FAILS })) })
  await w.step({ index: 1, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(w.steps.filter((s) => s.agentId === 'a1').map((s) => `${s.model}:${String(s.effort)}`)).toEqual(['claude-sonnet-5-5:medium', 'claude-sonnet-5-5:high'])
  expect((await w.board()).log.filter((entry) => entry.feature === 'escalation').map((entry) => entry.forced)).toEqual([{ kind: 'effort', from: 'medium', to: 'high' }])
  // A step has run on the new level: at the bar again, the model.
  await w.step({ index: 2, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium', tools: ['auth', 'api'].map((name) => ({ tool: 'Bash', input: { command: `pnpm test ${name}` }, ends: FAILS })) })
  await w.step({ index: 3, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(w.steps.filter((s) => s.agentId === 'a1').at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})
