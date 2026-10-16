// The merged run (eval/lib/merge.ts, run.ts --merge), the d1-ultra backend (eval/lib/d1.ts) and the paired test
// (eval/lib/paired.ts): DEVELOPMENT.md 「d1-ultra 核验」. Only the network is pretend.

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { D1_MODEL, D1_URL, d1Backend } from '../eval/lib/d1.ts'
import type { EffortSubmitItem } from '../eval/lib/datasets.ts'
import { effortSubmit } from '../eval/lib/effort-submit.ts'
import { estimateRunPerQuestion } from '../eval/lib/estimate.ts'
import { merge, runSuiteMerged } from '../eval/lib/merge.ts'
import { paired, scanRules } from '../eval/lib/paired.ts'
import { runSuite } from '../eval/lib/runner.ts'
import { optionsFor, settingsFrom } from '../eval/lib/suite.ts'

function item(id: string, message: string): EffortSubmitItem {
  return { id, zh: { message, recent_context: [] }, en: { message, recent_context: [] }, gold: 'high', accept: ['high'], rationale: '理由', difficulty: 'hard', tags: [] }
}

/** A d1 network: every question is answered `p` (lowest level first), 100 tokens a question; each request's url, headers and body are kept. */
function network(p: readonly number[]) {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = []
  const io: BackendIo = {
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body))
      sent.push({ url, headers: init.headers ?? {}, body })
      const answers = Object.fromEntries(
        Object.entries(body.questions as Record<string, { type: string }>).map(([id, question]) => [
          id,
          { type: question.type, probabilities: Object.fromEntries(EFFORTS.map((level, i) => [question.type === 'score' ? String(i) : level, p[i] ?? 0])), confidence: 0.6, score: 2, choice: 'high' },
        ]),
      )
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: D1_MODEL, answers, usage: { input_tokens: 100 * Object.keys(body.questions).length } }) }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, sent }
}

const HIGH = [0, 0.1, 0.6, 0.2, 0.1]
const settings = settingsFrom(optionsFor('jev', {}))

test('d1 is asked at Liquid with the System One body and no TypeSafe header', async () => {
  const { io, sent } = network(HIGH)
  const asked = await d1Backend('liquid_x').ask(io, { state: { a: 1 }, questions: { q: { type: 'noul', instructions: 'yes?' } } }, 1000)
  expect(asked.ok).toBe(true)
  expect(sent[0]?.url).toBe(D1_URL)
  expect(sent[0]?.body).toEqual({ model: D1_MODEL, state: { a: 1 }, questions: { q: { type: 'noul', instructions: 'yes?' } } })
  expect(Object.keys(sent[0]?.headers ?? {}).some((name) => name.toLowerCase().startsWith('typesafe'))).toBe(false)
  expect((await d1Backend('').ask(io, { state: {}, questions: {} }, 1000)).ok).toBe(false)
})

test('a merged run asks the variants of an item that share a state in one request, and grades each as a run on its own does', async () => {
  const items = [item('a', '重构认证模块'), item('b', '改个错别字')]
  const options = (io: BackendIo) => ({ backend: d1Backend('liquid_x'), io, now: () => 0, pause: async () => {}, settings, variants: ['zh-score', 'zh-choice'], languages: ['zh' as const], timeoutMs: 1000, retries: 0, concurrency: 2 })
  const merged = network(HIGH)
  const run = await runSuiteMerged(effortSubmit, items, options(merged.io))
  const alone = network(HIGH)
  const rows = await runSuite(effortSubmit, items, options(alone.io))
  expect(run.requests).toBe(2)
  expect(alone.sent.length).toBe(4)
  for (const one of merged.sent) expect(Object.keys(one.body.questions).map((id) => id.split('.')[0]).sort()).toEqual(['m0', 'm1'])
  expect(run.rows.map((row) => [row.id, row.variant, row.shown, row.correct])).toEqual(rows.map((row) => [row.id, row.variant, row.shown, row.correct]))
  // Each answer's part of the request's tokens: two questions of 100 each, one to each variant.
  expect(run.rows.map((row) => row.inputTokens)).toEqual([100, 100, 100, 100])
})

test('merging: the same request once, another state apart, at most 64 questions a request', () => {
  const ask = (state: unknown, id: string): DecisionRequest => ({ state: state as DecisionRequest['state'], questions: { [id]: { type: 'noul', instructions: id } } })
  const give = () => {}
  const twice = merge([{ request: ask({ s: 1 }, 'q'), give }, { request: ask({ s: 1 }, 'q'), give }, { request: ask({ s: 2 }, 'q'), give }])
  expect(twice.length).toBe(2)
  expect(twice[0]?.parts.length).toBe(1)
  expect(twice[0]?.parts[0]?.waiting.length).toBe(2)
  const many = merge(Array.from({ length: 65 }, (_, i) => ({ request: ask({ s: 1 }, `q${i}`), give })))
  expect(many.map((one) => Object.keys(one.request.questions).length)).toEqual([64, 1])
})

test('d1 is estimated with the state once for each question', () => {
  const request: DecisionRequest = { state: { text: 'x'.repeat(4000) }, questions: { a: { type: 'noul', instructions: 'a' }, b: { type: 'noul', instructions: 'b' } } }
  const one: DecisionRequest = { state: request.state, questions: { a: { type: 'noul', instructions: 'a' } } }
  const two = estimateRunPerQuestion([request], { model: D1_MODEL, factor: 1, usdPerMillionTokens: 1 })
  const single = estimateRunPerQuestion([one], { model: D1_MODEL, factor: 1, usdPerMillionTokens: 1 })
  expect(two.tokens).toBe(2 * single.tokens)
})

test('the paired test counts what only one run got right, an answer missing in a run as wrong', () => {
  const a = new Map([['1 zh', true], ['2 zh', true], ['3 zh', false], ['4 zh', true]])
  const b = new Map([['1 zh', true], ['2 zh', false], ['3 zh', true]])
  const r = paired(a, b)
  expect([r.n, r.rightA, r.rightB, r.onlyA, r.onlyB]).toEqual([4, 3, 2, 2, 1])
  expect(r.p).toBe(1)
  // Ten only in A, none only in B: 2 / 2^10.
  expect(paired(new Map(Array.from({ length: 10 }, (_, i) => [String(i), true])), new Map()).p).toBe(2 / 1024)
})

test('the scan puts the best rule first, a tie to the rule nearer the one preferred', () => {
  const scanned = scanRules((rules) => (rules.thetaMax >= 0.6 ? 1 : 0.5), { thetaMax: 0.5, roundUp: 0.3 })
  expect(scanned[0]?.rules).toEqual({ thetaMax: 0.6, roundUp: 0.3 })
  expect(scanned[0]?.accuracy).toBe(1)
})
