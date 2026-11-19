import { expect, test } from 'claude-code/testing'
import { callsFor, firstPrompt, foldNotes, noteArgs, notesWanted, withNotes, withoutTelemetry } from '../eval/lib/notes.ts'
import type { MidrunCase } from '../eval/lib/case.ts'
import type { ProgressNote, StepRecord } from '../hooks/statebuild.ts'

const step = (did: string, ok = true): StepRecord => ({ did, tools: ['Bash'], ok, result: did + ' result' })
const NOTE: ProgressNote = { done: 'Read the config.', remaining: 'Fix the parser.', cause_known: true }

function midrun(id: string, recent: StepRecord[], notes: MidrunCase['input']['notes'] = null): MidrunCase {
  return {
    id,
    category: 'midrun',
    source: 'written',
    difficulty: 'typical',
    set: 'fit',
    tags: [],
    label: { by: 'model', rationale: '' },
    input: { request: 'fix the parser', current: 'medium', stepsSoFar: 6, failedSteps: 1, recent, latest: step('latest', false), statedNext: '', codeMode: false, notes },
    expect: { action: 'hold', accept: ['medium'] },
  }
}

// A fake writer: answers each prompt with a note naming its latest step, or nothing for a step named in `unreadable`.
function writer(unreadable: string[] = []) {
  const asked: { previous: unknown; latest: string; system: string }[] = []
  const ask = async (p: { system: string; prompt: string }): Promise<ProgressNote | null> => {
    const sent = JSON.parse(p.prompt)
    asked.push({ previous: sent.previous_note, latest: sent.latest_step.did, system: p.system })
    return unreadable.includes(sent.latest_step.did) ? null : { done: 'did ' + sent.latest_step.did, remaining: 'more', cause_known: false }
  }
  return { asked, ask }
}
const noteOf = (did: string): ProgressNote => ({ done: 'did ' + did, remaining: 'more', cause_known: false })

test('before 按 recent 的顺序一步步写成，每一步带上一份记录；after 在 before 上加最新一步', async () => {
  const w = writer()
  const notes = await foldNotes(midrun('m', [step('a'), step('b'), step('c')]).input, w.ask)
  expect(w.asked.map((x) => [x.previous, x.latest])).toEqual([
    [null, 'a'],
    [noteOf('a'), 'b'],
    [noteOf('b'), 'c'],
    [noteOf('c'), 'latest'],
  ])
  expect(notes).toEqual({ before: noteOf('c'), after: noteOf('latest') })
  expect(w.asked[0]!.system.includes('cause_known')).toBe(true)
})

test('某一步的回答读不了：上一份记录留给下一步', async () => {
  const w = writer(['b'])
  const notes = await foldNotes(midrun('m', [step('a'), step('b'), step('c')]).input, w.ask)
  expect(w.asked.map((x) => x.previous)).toEqual([null, noteOf('a'), noteOf('a'), noteOf('c')])
  expect(notes.before).toEqual(noteOf('c'))
  const last = writer(['c'])
  expect((await foldNotes(midrun('m', [step('a'), step('c')]).input, last.ask)).before).toEqual(noteOf('a'))
})

test('recent 为空：before 是 null，不调用；after 不带上一份记录', async () => {
  const w = writer()
  const notes = await foldNotes(midrun('m', []).input, w.ask)
  expect(w.asked.map((x) => [x.previous, x.latest])).toEqual([[null, 'latest']])
  expect(notes).toEqual({ before: null, after: noteOf('latest') })
})

test('callsFor 和 firstPrompt：每个 recent 一次加 after 一次；第一次调用的提示', () => {
  expect(callsFor(midrun('m', [step('a'), step('b')]).input)).toBe(3)
  expect(callsFor(midrun('m', []).input)).toBe(1)
  expect(JSON.parse(firstPrompt(midrun('m', [step('a'), step('b')]).input).prompt).latest_step.did).toBe('a')
  expect(JSON.parse(firstPrompt(midrun('m', []).input).prompt).latest_step.did).toBe('latest')
})

test('notesWanted：没有 notes 的要写；已有的只在 force 时重写', () => {
  expect(notesWanted(midrun('m', []), false)).toBe(true)
  expect(notesWanted(midrun('m', [], { before: null, after: NOTE }), false)).toBe(false)
  expect(notesWanted(midrun('m', [], { before: null, after: NOTE }), true)).toBe(true)
})

test('withNotes：只换这一例的 notes，别的用例和字段不动', () => {
  const cases = [midrun('m1', [step('a')]), midrun('m2', [step('b')])]
  const out = withNotes(cases, 'm2', { before: NOTE, after: null })
  expect(out[1]!.input.notes).toEqual({ before: NOTE, after: null })
  expect(out[1]!.input.recent).toEqual(cases[1]!.input.recent)
  expect(out[0]).toEqual(cases[0])
  expect(cases[1]!.input.notes).toBe(null)
})

test('withNotes：没有这个编号就抛错', () => {
  expect(() => withNotes([midrun('m1', [])], 'nope', { before: null, after: null })).toThrow()
})

test('withoutTelemetry：去掉 OpenTelemetry 的变量，别的原样留着', () => {
  const env = { PATH: '/bin', HOME: '/h', CLAUDE_CODE_ENABLE_TELEMETRY: '1', ENABLE_BETA_TRACING_DETAILED: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'x', OTEL_LOGS_EXPORTER: 'otlp', NOT_OTEL_X: 'kept' }
  expect(withoutTelemetry(env)).toEqual({ PATH: '/bin', HOME: '/h', NOT_OTEL_X: 'kept' })
  expect(env.OTEL_LOGS_EXPORTER).toBe('otlp')
})

test('noteArgs：haiku、mod 的 system，只读项目的设置（用户的 hooks、env、插件不进来）', () => {
  expect(noteArgs('SYS')).toEqual(['-p', '--model', 'haiku', '--setting-sources', 'project', '--system-prompt', 'SYS'])
})
