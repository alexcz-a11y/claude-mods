import { expect, test } from 'claude-code/testing'
import { afterPrompt, beforePrompt, notesWanted, withNotes, withoutTelemetry } from '../eval/lib/notes.ts'
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

test('before：截至上一步，最新一步之前的那一步是 latest_step，没有 previous_note', () => {
  const p = beforePrompt(midrun('m', [step('a'), step('b'), step('c')]).input)!
  const sent = JSON.parse(p.prompt)
  expect(sent.latest_step.did).toBe('c')
  expect(sent.previous_note).toBe(null)
  expect(sent.request).toBe('fix the parser')
})

test('before：最新一步之前没有步，就没有 before（不调用）', () => {
  expect(beforePrompt(midrun('m', []).input)).toBe(null)
})

test('after：before 作为 previous_note，再加最新一步', () => {
  const p = afterPrompt(midrun('m', [step('a')]).input, NOTE)
  const sent = JSON.parse(p.prompt)
  expect(sent.latest_step).toEqual({ did: 'latest', tools: ['Bash'], outcome: 'error', result: 'latest result' })
  expect(sent.previous_note).toEqual(NOTE)
})

test('after：before 是 null 时 previous_note 也是 null；system 是 mod 自己的', () => {
  const c = midrun('m', [step('a')]).input
  const p = afterPrompt(c, null)
  expect(JSON.parse(p.prompt).previous_note).toBe(null)
  expect(p.system).toBe(beforePrompt(c)!.system)
  expect(p.system.includes('cause_known')).toBe(true)
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
