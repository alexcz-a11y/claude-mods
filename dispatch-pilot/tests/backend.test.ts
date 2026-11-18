import { expect, test } from 'claude-code/testing'
import { readConfig } from '../hooks/config.ts'
import type { Config } from '../hooks/config.ts'
import { DREX_URL, FIRST_SHARE, JEV_URL, ask, canAsk, partOf } from '../hooks/backend.ts'
import type { Io } from '../hooks/backend.ts'
import type { Question } from '../hooks/questions.ts'
import { STATE_BUDGET, estimateTokens } from '../hooks/statebuild.ts'

// A hand-written io: a clock the test moves and fetch replies played in order. The k-th sleep
// races the k-th fetch: it passes its whole time when that fetch hangs, and otherwise waits for its abort.
type Reply =
  | { status?: number; body?: unknown; text?: string; headers?: Record<string, string>; takes?: number }
  | 'hang'
  | 'throw'
  | 'throw-sync'

function fakeIo(replies: Reply[]) {
  let t = 1000
  const calls: { url: string; headers: Record<string, string>; method: string; body: string }[] = []
  const played: Reply[] = []
  const sleeps: { ms: number; aborted: boolean }[] = []
  const io: Io = {
    async now() {
      return t
    },
    fetch(url, init) {
      calls.push({ url, headers: init.headers, method: init.method, body: init.body })
      const r = replies.shift()
      if (r === undefined) return Promise.reject(new Error('no reply left'))
      played.push(r)
      if (r === 'hang') return new Promise(() => {})
      if (r === 'throw') return Promise.reject(new Error('offline'))
      if (r === 'throw-sync') throw new Error('refused before sending')
      t += r.takes ?? 0
      const status = r.status ?? 200
      return Promise.resolve({ status, ok: status >= 200 && status < 300, headers: r.headers ?? {}, text: r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body)) })
    },
    sleep(ms, signal) {
      const s = { ms, aborted: false }
      const k = sleeps.push(s) - 1
      return new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          s.aborted = true
          reject(new Error('aborted'))
        })
        // ask() may start the sleep before or after the fetch it races; look once both have started.
        void Promise.resolve().then(() => {
          if (played[k] === 'hang') {
            t += ms
            resolve()
          }
        })
      })
    },
  }
  return { io, calls, sleeps }
}

const QUESTIONS: Record<string, Question> = {
  open: { type: 'score', instructions: 'How open?', criteria: ['given', 'open'] },
  mechanical: { type: 'noul', instructions: 'Mechanical?', criteria: { true: 'yes it is', false: 'no it is not' } },
  pick: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: 'the second' } },
}
const REQ = { state: { request: 'fix the flaky test' }, questions: QUESTIONS }

function goodAnswers() {
  return {
    open: { type: 'score', score: 0.9, legend: ['given', 'open'], probabilities: { '0': 0.1, '1': 0.9 }, confidence: 0.8 },
    mechanical: { type: 'noul', noul: 0.25 },
    pick: { type: 'choice', choice: 'b', probabilities: { a: 0.3, b: 0.7 }, confidence: 0.4 },
  }
}
const drexBody = (over: Record<string, unknown> = {}) => ({ model: 'drex-max-v1.1', answers: goodAnswers(), usage: { input_tokens: 90, output_tokens: 3 }, request_id: 'req_d', ...over })
const jevBody = (over: Record<string, unknown> = {}) => ({ model: 'jev-1.14.0', answers: goodAnswers(), usage: { input_tokens: 90, output_tokens: 3 }, ...over })

const drexOnly: Config = readConfig({ drexApiKey: 'nace_sk_test' })
const both = (fallback: boolean, backend: 'drex' | 'jev' = 'drex'): Config => readConfig({ drexApiKey: 'nace_sk_test', jevApiKey: 'ts_test', fallback, backend })

const EXPECTED = {
  open: { type: 'score', score: 0.9, probabilities: [0.1, 0.9] },
  mechanical: { type: 'noul', noul: 0.25 },
  pick: { type: 'choice', choice: 'b', probabilities: { a: 0.3, b: 0.7 } },
}

// The brief's eight.

test('发给 Drex 的请求：地址、密钥头、固定版本、state 和题', async () => {
  const { io, calls } = fakeIo([{ body: drexBody(), takes: 120 }])
  const r = await ask(io, drexOnly, REQ, 4000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe(DREX_URL)
  expect(DREX_URL).toBe('https://console.nace.ai/v1/systemone')
  expect(calls[0]!.method).toBe('POST')
  expect(calls[0]!.headers).toEqual({ authorization: 'Bearer nace_sk_test', 'content-type': 'application/json' })
  expect(JSON.parse(calls[0]!.body)).toEqual({ model: 'drex-max-v1.1', state: REQ.state, questions: QUESTIONS })
  expect(r).toEqual({ ok: true, answers: EXPECTED, model: 'drex-max-v1.1', backend: 'drex', ms: 120 })
})

test('score 的概率从字符串键转成数组', async () => {
  const { io, calls } = fakeIo([{ body: drexBody() }])
  const r = await ask(io, drexOnly, REQ, 4000)
  expect(calls).toHaveLength(1)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.answers.open).toEqual({ type: 'score', score: 0.9, probabilities: [0.1, 0.9] })
  const five = { open: { type: 'score', instructions: 'x', criteria: ['a', 'b', 'c', 'd', 'e'] } as Question }
  // Keys out of order still land at their level's index.
  const answers = { open: { type: 'score', score: 2.5, probabilities: { '4': 0.25, '2': 0.5, '0': 0, '3': 0.25, '1': 0 } } }
  const second = fakeIo([{ body: drexBody({ answers }) }])
  const r5 = await ask(second.io, drexOnly, { state: {}, questions: five }, 4000)
  expect(r5).toEqual({ ok: true, answers: { open: { type: 'score', score: 2.5, probabilities: [0, 0, 0.5, 0.25, 0.25] } }, model: 'drex-max-v1.1', backend: 'drex', ms: 0 })
})

test('回答缺一道题、类型不对、概率不是数，都是 bad-answer（Review Focus 2）', async () => {
  const missing = goodAnswers() as Record<string, unknown>
  delete missing.pick
  const wrongType = { ...goodAnswers(), mechanical: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1 } } }
  const notNumber = { ...goodAnswers(), open: { type: 'score', score: 0.9, probabilities: { '0': 'low', '1': 0.9 } } }
  const nan = { ...goodAnswers(), pick: { type: 'choice', choice: 'b', probabilities: { a: null, b: 0.7 } } }
  for (const answers of [missing, wrongType, notNumber, nan]) {
    const { io, calls } = fakeIo([{ body: drexBody({ answers }) }])
    const r = await ask(io, drexOnly, REQ, 4000)
    expect(calls).toHaveLength(1)
    expect(r).toEqual({ ok: false, reason: 'bad-answer', backend: 'drex', requestId: 'req_d', ms: 0 })
  }
})

test('Drex 回答的 model 不是固定版本：model-mismatch', async () => {
  const { io, calls } = fakeIo([{ body: drexBody({ model: 'drex-v2.0' }) }])
  const r = await ask(io, drexOnly, REQ, 4000)
  expect(calls).toHaveLength(1)
  expect(r).toEqual({ ok: false, reason: 'model-mismatch', backend: 'drex', requestId: 'req_d', ms: 0 })
})

test('没有密钥：no-key，一个请求都不发', async () => {
  const { io, calls } = fakeIo([{ body: drexBody() }])
  expect(await ask(io, readConfig({}), REQ, 4000)).toEqual({ ok: false, reason: 'no-key', backend: 'drex', ms: 0 })
  expect(await ask(io, readConfig({ backend: 'jev', drexApiKey: 'nace_sk_test' }), REQ, 4000)).toEqual({ ok: false, reason: 'no-key', backend: 'jev', ms: 0 })
  // Fallback needs both keys (design 5.7): a missing first key is not a reason to ask the other.
  expect(await ask(io, readConfig({ jevApiKey: 'ts_test', fallback: true }), REQ, 4000)).toEqual({ ok: false, reason: 'no-key', backend: 'drex', ms: 0 })
  expect(calls).toHaveLength(0)
})

test('到时限返回 timeout', async () => {
  const { io, calls, sleeps } = fakeIo(['hang'])
  const r = await ask(io, drexOnly, REQ, 4000)
  expect(calls).toHaveLength(1)
  expect(sleeps.map((s) => s.ms)).toEqual([4000])
  expect(r).toEqual({ ok: false, reason: 'timeout', backend: 'drex', ms: 4000 })
})

test('fallback 关着时不改问；开着并且 Jev 有密钥时改问一次，结果的 backend 是 jev', async () => {
  const off = fakeIo([{ status: 500, body: { request_id: 'req_500' } }, { body: jevBody() }])
  expect(await ask(off.io, both(false), REQ, 4000)).toEqual({ ok: false, reason: 'http', backend: 'drex', status: 500, requestId: 'req_500', ms: 0 })
  expect(off.calls).toHaveLength(1)

  const on = fakeIo([{ status: 500, body: { request_id: 'req_500' } }, { body: jevBody() }])
  const r = await ask(on.io, both(true), REQ, 4000)
  expect(on.calls).toHaveLength(2)
  expect(on.calls.map((c) => c.url)).toEqual([DREX_URL, JEV_URL])
  expect(r).toEqual({ ok: true, answers: EXPECTED, model: 'jev-1.14.0', backend: 'jev', ms: 0, firstFailure: { reason: 'http', backend: 'drex', status: 500, requestId: 'req_500' } })

  // Only once: the other backend failing too does not send a third request.
  const twice = fakeIo([{ status: 500 }, { status: 503 }, { body: drexBody() }])
  const r2 = await ask(twice.io, both(true), REQ, 4000)
  expect(twice.calls).toHaveLength(2)
  expect(r2.ok).toBe(false)
})

test('HTTP 500 是 http，带 status 和 request_id；fetch 抛错是 network', async () => {
  // The error body may echo the state: only its request_id is kept.
  const http = fakeIo([{ status: 500, body: { error: { message: 'state was: fix the flaky test' }, request_id: 'req_e' } }])
  const r = await ask(http.io, drexOnly, REQ, 4000)
  expect(http.calls).toHaveLength(1)
  expect(r).toEqual({ ok: false, reason: 'http', backend: 'drex', status: 500, requestId: 'req_e', ms: 0 })
  expect(JSON.stringify(r).includes('flaky')).toBe(false)

  const net = fakeIo(['throw'])
  expect(await ask(net.io, drexOnly, REQ, 4000)).toEqual({ ok: false, reason: 'network', backend: 'drex', ms: 0 })
  expect(net.calls).toHaveLength(1)
})

// Beyond the brief's eight.

test('发给 Jev 的请求：地址、密钥、jev-latest', async () => {
  const { io, calls } = fakeIo([{ body: jevBody(), takes: 200 }])
  const r = await ask(io, both(false, 'jev'), REQ, 4000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe(JEV_URL)
  expect(JEV_URL).toBe('https://api.typesafe.ai/v1/systemone')
  expect(calls[0]!.headers).toEqual({ authorization: 'Bearer ts_test', 'content-type': 'application/json' })
  expect(JSON.parse(calls[0]!.body)).toEqual({ model: 'jev-latest', state: REQ.state, questions: QUESTIONS })
  // Jev answers the alias with the version it resolved to; that is accepted and recorded.
  expect(r).toEqual({ ok: true, answers: EXPECTED, model: 'jev-1.14.0', backend: 'jev', ms: 200 })
})

test('Jev 的 request_id 在 x-typesafe-request-id 头里', async () => {
  const { io } = fakeIo([{ status: 429, text: '{"detail":"slow down"}', headers: { 'x-typesafe-request-id': 'ts_req_1' } }])
  expect(await ask(io, both(false, 'jev'), REQ, 4000)).toEqual({ ok: false, reason: 'http', backend: 'jev', status: 429, requestId: 'ts_req_1', ms: 0 })
})

test('noul 不在 0 到 1 之间、score 的概率个数不对：bad-answer', async () => {
  const cases = [
    { ...goodAnswers(), mechanical: { type: 'noul', noul: 1.2 } },
    { ...goodAnswers(), mechanical: { type: 'noul', noul: -0.1 } },
    { ...goodAnswers(), open: { type: 'score', score: 0.9, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 } } },
    { ...goodAnswers(), open: { type: 'score', score: 0.9, probabilities: { '0': 1 } } },
    { ...goodAnswers(), open: { type: 'score', score: 0.9, probabilities: { '0': 0.1, '2': 0.9 } } },
    { ...goodAnswers(), pick: { type: 'choice', choice: 'c', probabilities: { a: 0.3, b: 0.7 } } },
    { ...goodAnswers(), pick: { type: 'choice', choice: 'b', probabilities: { b: 1 } } },
  ]
  for (const answers of cases) {
    const { io, calls } = fakeIo([{ body: drexBody({ answers }) }])
    const r = await ask(io, drexOnly, REQ, 4000)
    expect(calls).toHaveLength(1)
    expect(r).toEqual({ ok: false, reason: 'bad-answer', backend: 'drex', requestId: 'req_d', ms: 0 })
  }
})

test('回答不是 JSON、没有 answers：bad-answer', async () => {
  for (const reply of [{ text: '<html>gateway</html>' }, { text: 'null' }, { body: { model: 'drex-max-v1.1' } }]) {
    const { io, calls } = fakeIo([reply])
    const r = await ask(io, drexOnly, REQ, 4000)
    expect(calls).toHaveLength(1)
    expect(r).toEqual({ ok: false, reason: 'bad-answer', backend: 'drex', ms: 0 })
  }
})

test('多回来的题不算错，也不带进结果', async () => {
  const { io } = fakeIo([{ body: drexBody({ answers: { ...goodAnswers(), extra: { type: 'noul', noul: 2 } } }) }])
  expect(await ask(io, drexOnly, REQ, 4000)).toEqual({ ok: true, answers: EXPECTED, model: 'drex-max-v1.1', backend: 'drex', ms: 0 })
})

test('改问的那家也失败：结果写后答的那家，第一次的失败还在', async () => {
  const { io, calls } = fakeIo([{ body: drexBody({ model: 'drex-v2.0' }) }, 'throw'])
  const r = await ask(io, both(true), REQ, 4000)
  expect(calls).toHaveLength(2)
  expect(r).toEqual({ ok: false, reason: 'network', backend: 'jev', ms: 0, firstFailure: { reason: 'model-mismatch', backend: 'drex', requestId: 'req_d' } })
})

test('从 Jev 改问 Drex 也行', async () => {
  const { io, calls } = fakeIo([{ status: 502 }, { body: drexBody() }])
  const r = await ask(io, both(true, 'jev'), REQ, 4000)
  expect(calls.map((c) => c.url)).toEqual([JEV_URL, DREX_URL])
  expect(r).toEqual({ ok: true, answers: EXPECTED, model: 'drex-max-v1.1', backend: 'drex', ms: 0, firstFailure: { reason: 'http', backend: 'jev', status: 502 } })
})

test('时限由第一次请求和改问共用', async () => {
  const { io, calls, sleeps } = fakeIo([{ status: 500, takes: 3000 }, { body: jevBody(), takes: 500 }])
  const r = await ask(io, both(true), REQ, 4000)
  expect(calls).toHaveLength(2)
  // The first race gets 60% of 4000; the second what is left of the whole: 4000 - 3000.
  expect(sleeps.map((s) => s.ms)).toEqual([2400, 1000])
  expect(r.ok).toBe(true)
  expect(r.ms).toBe(3500)
})

test('改问时超时：按剩下的时间算', async () => {
  const { io, calls, sleeps } = fakeIo([{ status: 500, takes: 2500 }, 'hang'])
  const r = await ask(io, both(true), REQ, 4000)
  expect(calls).toHaveLength(2)
  expect(sleeps.map((s) => s.ms)).toEqual([2400, 1500])
  expect(r).toEqual({ ok: false, reason: 'timeout', backend: 'jev', ms: 4000, firstFailure: { reason: 'http', backend: 'drex', status: 500 } })
})

test('改问前时限已用完就不改问', async () => {
  const spent = fakeIo([{ status: 500, takes: 4000 }, { body: jevBody() }])
  expect(await ask(spent.io, both(true), REQ, 4000)).toEqual({ ok: false, reason: 'http', backend: 'drex', status: 500, ms: 4000 })
  expect(spent.calls).toHaveLength(1)
})

test('第一次在 60% 处超时，改问的那家在剩下的时间里答上', async () => {
  expect(FIRST_SHARE).toBe(0.6)
  const { io, calls, sleeps } = fakeIo(['hang', { body: jevBody(), takes: 300 }])
  const r = await ask(io, both(true), REQ, 4000)
  expect(calls.map((c) => c.url)).toEqual([DREX_URL, JEV_URL])
  expect(sleeps.map((s) => s.ms)).toEqual([2400, 1600])
  expect(r).toEqual({ ok: true, answers: EXPECTED, model: 'jev-1.14.0', backend: 'jev', ms: 2700, firstFailure: { reason: 'timeout', backend: 'drex' } })
})

test('两家都超时：timeout，总共等满 deadlineMs', async () => {
  const { io, calls, sleeps } = fakeIo(['hang', 'hang'])
  const r = await ask(io, both(true), REQ, 4000)
  expect(calls).toHaveLength(2)
  expect(sleeps.map((s) => s.ms)).toEqual([2400, 1600])
  expect(sleeps[0]!.ms + sleeps[1]!.ms).toBe(4000)
  expect(r).toEqual({ ok: false, reason: 'timeout', backend: 'jev', ms: 4000, firstFailure: { reason: 'timeout', backend: 'drex' } })
})

test('60% 向下取整', async () => {
  const { io, sleeps } = fakeIo(['hang', 'hang'])
  const r = await ask(io, both(true), REQ, 2001)
  expect(sleeps.map((s) => s.ms)).toEqual([1200, 801])
  expect(r.ms).toBe(2001)
})

test('fallback 关着：第一次就用满整个时限', async () => {
  const { io, calls, sleeps } = fakeIo(['hang', { body: jevBody() }])
  const r = await ask(io, both(false), REQ, 4000)
  expect(calls).toHaveLength(1)
  expect(sleeps.map((s) => s.ms)).toEqual([4000])
  expect(r).toEqual({ ok: false, reason: 'timeout', backend: 'drex', ms: 4000 })
})

test('fallback 开着但另一家没有密钥：第一次也用满整个时限', async () => {
  const { io, calls, sleeps } = fakeIo(['hang', { body: jevBody() }])
  const r = await ask(io, readConfig({ drexApiKey: 'nace_sk_test', fallback: true }), REQ, 4000)
  expect(calls).toHaveLength(1)
  expect(sleeps.map((s) => s.ms)).toEqual([4000])
  expect(r).toEqual({ ok: false, reason: 'timeout', backend: 'drex', ms: 4000 })
})

test('io.fetch 同步抛错也是 network，计时的 sleep 被中止', async () => {
  const { io, calls, sleeps } = fakeIo(['throw-sync'])
  expect(await ask(io, drexOnly, REQ, 4000)).toEqual({ ok: false, reason: 'network', backend: 'drex', ms: 0 })
  expect(calls).toHaveLength(1)
  expect(sleeps).toHaveLength(1)
  expect(sleeps[0]!.aborted).toBe(true)
})

test('最外层兜底：时钟还能用时报出用掉的时间，时钟坏了报 0', async () => {
  // A cyclic state cannot be serialized: the throw comes from inside ask, after the clock started.
  const cyclic: Record<string, unknown> = { request: 'r' }
  cyclic.self = cyclic
  let t = 1000
  let fetches = 0
  const ticking: Io = {
    async now() {
      t += 10
      return t
    },
    fetch() {
      fetches++
      return new Promise(() => {})
    },
    sleep: () => new Promise(() => {}),
  }
  expect(await ask(ticking, drexOnly, { state: cyclic, questions: QUESTIONS }, 4000)).toEqual({ ok: false, reason: 'network', backend: 'drex', ms: 10 })
  expect(fetches).toBe(0)
  const broken: Io = { ...ticking, now: () => Promise.reject(new Error('no clock')) }
  expect(await ask(broken, drexOnly, REQ, 4000)).toEqual({ ok: false, reason: 'network', backend: 'drex', ms: 0 })
  expect(fetches).toBe(0)
})

test('401、402、422 都是 http，带 status，不重试', async () => {
  for (const status of [401, 402, 422]) {
    const { io, calls } = fakeIo([{ status, body: { request_id: 'req_' + status } }, { body: drexBody() }])
    expect(await ask(io, drexOnly, REQ, 4000)).toEqual({ ok: false, reason: 'http', backend: 'drex', status, requestId: 'req_' + status, ms: 0 })
    expect(calls).toHaveLength(1)
  }
})

test('请求先回来时，计时的 sleep 被中止', async () => {
  const { io, sleeps } = fakeIo([{ body: drexBody() }])
  await ask(io, drexOnly, REQ, 4000)
  expect(sleeps).toHaveLength(1)
  expect(sleeps[0]!.aborted).toBe(true)
})

test('发出的 state 不超预算：引号和换行转义后也不超', async () => {
  const state = { note: 'quotes', request: '"'.repeat(3000), latest: { result: '\n'.repeat(3000), tools: ['Read'] } }
  expect(estimateTokens(JSON.stringify(state))).toBeGreaterThan(STATE_BUDGET)
  const { io, calls } = fakeIo([{ body: drexBody() }])
  await ask(io, drexOnly, { state, questions: QUESTIONS }, 4000)
  const sent = JSON.parse(calls[0]!.body) as { state: unknown }
  expect(estimateTokens(JSON.stringify(sent.state))).toBeLessThanOrEqual(STATE_BUDGET)
})

test('partial：缺一道题时其余的照样作数，partOf 按部分拆开', async () => {
  const { mechanical: _gone, ...rest } = goodAnswers()
  const { io } = fakeIo([{ body: drexBody({ answers: rest }) }])
  const r = await ask(io, drexOnly, { ...REQ, partial: true }, 4000)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(Object.keys(r.answers)).toEqual(['open', 'pick'])
  expect(partOf(r, ['pick'])).toMatchObject({ ok: true, answers: { pick: { type: 'choice', choice: 'b' } } })
  expect(partOf(r, ['open', 'mechanical'])).toEqual({ ok: false, reason: 'bad-answer', backend: 'drex', ms: r.ms })
  // Without partial the same answer fails whole.
  const whole = await ask(fakeIo([{ body: drexBody({ answers: rest }) }]).io, drexOnly, REQ, 4000)
  expect(whole).toMatchObject({ ok: false, reason: 'bad-answer' })
  // partial with nothing usable still fails.
  const none = await ask(fakeIo([{ body: drexBody({ answers: {} }) }]).io, drexOnly, { ...REQ, partial: true }, 4000)
  expect(none).toMatchObject({ ok: false, reason: 'bad-answer' })
  // A failure passes through partOf as it is.
  expect(partOf(none, ['open'])).toBe(none)
  expect(canAsk(drexOnly)).toBe(true)
  expect(canAsk(readConfig({ jevApiKey: 'k' }))).toBe(false)
})
