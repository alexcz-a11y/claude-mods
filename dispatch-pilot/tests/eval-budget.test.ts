import { expect, test } from 'claude-code/testing'
import { CAP, RATE_WAITS, mayAskHeldout, pool, spend } from '../eval/lib/budget.ts'
import type { Spent } from '../eval/lib/budget.ts'
import { checkSessions } from '../eval/lib/case.ts'
import type { AgentCase, Case, MidrunCase, SkillCase, SubmitCase } from '../eval/lib/case.ts'
import { heldoutWants, neverAskedOn, sentState, unknownVariants, variantsFor, wants } from '../eval/lib/plan.ts'

test('花得起：返回花过之后的数', () => {
  expect(spend({ requests: 1, tokens: 10 }, { requests: 1, tokens: 5 })).toEqual({ requests: 2, tokens: 15 })
})
test('请求数到上限：花不起', () => {
  expect(spend({ requests: 2000, tokens: 0 }, { requests: 1, tokens: 1 })).toBe(null)
})
test('token 会超上限：花不起', () => {
  expect(spend({ requests: 0, tokens: 29_999_999 }, { requests: 1, tokens: 2 })).toBe(null)
})
test('留出集：没有 final 不发，发过一次不再发', () => {
  expect(mayAskHeldout({ final: false, alreadyDone: false })).toBe(false)
  expect(mayAskHeldout({ final: true, alreadyDone: true })).toBe(false)
  expect(mayAskHeldout({ final: true, alreadyDone: false })).toBe(true)
})

// A run that records how many were in flight when each started.
function tracker() {
  let active = 0
  const startedWith: number[] = []
  return {
    startedWith,
    run: (limited: boolean) => {
      startedWith.push(active)
      active += 1
      return Promise.resolve().then(() => {
        active -= 1
        return limited
      })
    },
  }
}

test('同时发 4 个：发之前先占预算，在途的请求加起来也超不过上限', async () => {
  let spent: Spent = { requests: CAP.requests - 3, tokens: 0 }
  const t = tracker()
  const order: string[] = []
  const out = await pool([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], {
    concurrency: 4,
    reserve: (i) => {
      const after = spend(spent, { requests: 1, tokens: 100 })
      if (after === null) return false
      spent = after
      order.push('reserve ' + i)
      return true
    },
    run: (i) => {
      order.push('run ' + i)
      return t.run(false)
    },
  })
  expect(out.stopped).toBe(true)
  expect(out.results.length).toBe(3)
  expect(spent.requests).toBe(CAP.requests)
  expect(order).toEqual(['reserve 0', 'run 0', 'reserve 1', 'run 1', 'reserve 2', 'run 2'])
  // all three were in flight together: the cap held without waiting for any of them
  expect(t.startedWith).toEqual([0, 1, 2])
})

test('最多同时 4 个；--concurrency 1 一次一个', async () => {
  for (const concurrency of [4, 1]) {
    const t = tracker()
    const out = await pool([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { concurrency, reserve: () => true, run: () => t.run(false) })
    expect(out.results.length).toBe(10)
    expect(out.stopped).toBe(false)
    expect(Math.max(...t.startedWith)).toBe(concurrency - 1)
  }
})

// Calls in order: which item, and how many runs were in flight when it started.
function calls(isLimited: (item: number, nth: number) => boolean) {
  let active = 0
  const log: [number, number][] = []
  const run = (i: number) => {
    const nth = log.filter(([x]) => x === i).length
    log.push([i, active])
    active += 1
    return Promise.resolve().then(() => {
      active -= 1
      return { i, limited: isLimited(i, nth) }
    })
  }
  return { log, run }
}
type Got = { i: number; limited: boolean }

test('限流：等 20 秒再发，从第一次限流起一次一个；被限流的那次不算回答', async () => {
  const t = calls((i, nth) => i === 0 && nth === 0)
  const waited: number[] = []
  const kept: number[] = []
  const out = await pool([0, 1, 2, 3, 4, 5, 6, 7], {
    concurrency: 4,
    reserve: () => true,
    run: t.run,
    keep: (i) => kept.push(i),
    rateLimit: { limited: (r: Got) => r.limited, sleep: async (ms) => void waited.push(ms) },
  })
  expect(waited).toEqual([20_000])
  expect(out.serial).toBe(true)
  expect(out.rateLimited).toBe(false)
  expect(out.results.length).toBe(8)
  expect(out.results.some((r) => r.limited)).toBe(false)
  expect([...kept].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  // the items started after the rate limit each went alone
  for (const [i, inFlight] of t.log) if (i >= 4) expect([i, inFlight]).toEqual([i, 0])
})

test('重试三次（20、40、80 秒）还被限流：不存、不再开新的请求，告诉调用方', async () => {
  const t = calls((i) => i === 0)
  const waited: number[] = []
  const kept: number[] = []
  let reserved = 0
  const out = await pool([0, 1, 2, 3, 4, 5, 6, 7], {
    concurrency: 4,
    reserve: () => (reserved += 1) > 0,
    run: t.run,
    keep: (i) => kept.push(i),
    rateLimit: { limited: (r: Got) => r.limited, sleep: async (ms) => void waited.push(ms) },
  })
  expect(waited).toEqual(RATE_WAITS)
  expect(RATE_WAITS).toEqual([20_000, 40_000, 80_000])
  expect(out.rateLimited).toBe(true)
  expect(t.log.filter(([i]) => i === 0).length).toBe(4)
  expect(kept.includes(0)).toBe(false)
  expect(out.results.some((r) => r.i === 0)).toBe(false)
  expect(t.log.some(([i]) => i >= 4)).toBe(false)
  // every retry is a request: its cost is reserved before it goes out
  expect(reserved).toBe(4 + 3)
})

test('重试前预算不够：不重试，停下，那次也不存', async () => {
  const t = calls((i) => i === 0)
  let left = 2
  const kept: number[] = []
  const out = await pool([0, 1], {
    concurrency: 1,
    reserve: () => (left -= 1) >= 0,
    run: t.run,
    keep: (i) => kept.push(i),
    rateLimit: { limited: (r: Got) => r.limited, sleep: async () => undefined },
  })
  expect(out.stopped).toBe(true)
  expect(kept).toEqual([])
  expect(t.log.map(([i]) => i)).toEqual([0, 0])
})

test('补位时 reserve 抛错：pool 的 promise 拒绝', async () => {
  const t = calls(() => false)
  let caught: unknown = null
  try {
    await pool([0, 1, 2], {
      concurrency: 1,
      reserve: (i) => {
        if (i === 1) throw new Error('spent.json is not writable')
        return true
      },
      run: t.run,
    })
  } catch (error) {
    caught = error
  }
  expect((caught as Error | null)?.message).toBe('spent.json is not writable')
  expect(t.log.map(([i]) => i)).toEqual([0])
})

test('重复问（修订 A5）：第 1 遍照原样，第 2 遍起 state 末尾加 16 位十六进制的 request_uid', () => {
  const state = { request: 'fix it', previous_turn: null }
  let n = 0
  const uid = () => (n++ % 2 === 0 ? '0123456789abcdef' : 'fedcba9876543210')
  expect(sentState(state, 1, uid)).toEqual(state)
  expect(n).toBe(0)
  const two = sentState(state, 2, uid)
  expect(Object.keys(two)).toEqual(['request', 'previous_turn', 'request_uid'])
  expect(two.request_uid).toMatch(/^[0-9a-f]{16}$/)
  expect(sentState(state, 3, uid).request_uid === two.request_uid).toBe(false)
  expect(state).toEqual({ request: 'fix it', previous_turn: null })
})

const label = { by: 'model' as const, rationale: '手写的用例。' }
const step = { did: 'ran the tests', tools: ['Bash'], ok: true, result: 'ok' }
const submitCase: SubmitCase = {
  id: 'submit-01', category: 'submit', source: 'written', difficulty: 'typical', set: 'heldout', tags: [], label,
  input: { request: 'rename the flag', previous: null, base: 'medium' }, expect: { accept: ['low'] },
}
const midrunCase: MidrunCase = {
  id: 'midrun-01', category: 'midrun', source: 'written', difficulty: 'typical', set: 'heldout', tags: [], label,
  input: { request: 'fix the test', current: 'medium', stepsSoFar: 3, failedSteps: 0, recent: [step], latest: step, statedNext: 'run it', codeMode: false, notes: null },
  expect: { action: 'hold', accept: ['medium'] },
}
const agentCase: AgentCase = {
  id: 'agent-01', category: 'agent', source: 'written', difficulty: 'typical', set: 'heldout', tags: [], label,
  input: { task: 'list files', agentType: 'Explore', description: 'list', inherit: { level: 'medium', tier: 'opus' } },
  expect: { accept: ['low'], models: ['haiku'] },
}
const skillCase: SkillCase = {
  id: 'skill-01', category: 'skill', source: 'written', difficulty: 'typical', set: 'heldout', tags: [], label,
  input: { request: 'review this branch', previous: null }, expect: { skill: null, alsoOk: [] },
}
const tally = (ws: { c: Case; variant: { name: string }; repeat: number }[]) => ws.map((w) => `${w.c.id} ${w.variant.name} #${w.repeat}`)

test('留出集的一次运行：每类登记在它之前的给法都发，default 3 遍（skill 是 stage-1 和 stage-2），其余 1 遍', () => {
  const got = tally(heldoutWants([submitCase, midrunCase, agentCase, skillCase]))
  expect(got).toEqual([
    'submit-01 default #1', 'submit-01 default #2', 'submit-01 default #3',
    'submit-01 with-controls #1', 'submit-01 no-previous #1', 'submit-01 direct-shuffled #1', 'submit-01 with-skills #1', 'submit-01 open-b #1',
    'midrun-01 default #1', 'midrun-01 default #2', 'midrun-01 default #3',
    'midrun-01 with-controls #1', 'midrun-01 recent-1 #1', 'midrun-01 recent-3 #1', 'midrun-01 progress-before #1', 'midrun-01 progress-after #1',
    'midrun-01 recent-1-with-controls #1', 'midrun-01 recent-3-with-controls #1', 'midrun-01 no-stated-next-with-controls #1', 'midrun-01 direct-shuffled #1', 'midrun-01 open-b #1',
    'agent-01 default #1', 'agent-01 default #2', 'agent-01 default #3', 'agent-01 with-controls #1', 'agent-01 direct-shuffled #1', 'agent-01 open-b #1',
    'skill-01 stage-1 #1', 'skill-01 stage-1 #2', 'skill-01 stage-1 #3', 'skill-01 stage-2 #1', 'skill-01 stage-2 #2', 'skill-01 stage-2 #3',
    'skill-01 stage-1-alone #1', 'skill-01 stage-2-alone #1', 'skill-01 stage-1-shuffled #1', 'skill-01 stage-2-shuffled #1',
  ])
  // first-message was registered after the held-out pass, which is not asked again (amendment A1): the pass leaves it out.
  expect(got.some((x) => x.includes('first-message'))).toBe(false)
})

test('neverAskedOn：登记在留出集那一次运行之后的给法，在留出集上从没问过；别的组、别的给法不是', () => {
  const [first] = variantsFor('submit', ['first-message'])
  const [plain] = variantsFor('submit', [])
  expect([neverAskedOn('heldout', first!), neverAskedOn('tune', first!), neverAskedOn('heldout', plain!)]).toEqual([true, false, false])
})

test('--variant first-message：和别的给法一样能选（submit 才有），留出集的那一次运行不带它', () => {
  expect(unknownVariants(['first-message'])).toEqual([])
  expect(variantsFor('submit', ['first-message']).map((v) => v.name)).toEqual(['first-message'])
  for (const category of ['midrun', 'agent', 'skill'] as const) expect(variantsFor(category, ['first-message'])).toEqual([])
  expect(variantsFor('submit', ['all']).map((v) => v.name)).toContain('first-message')
  expect(tally(wants([submitCase, agentCase], ['first-message'], 3))).toEqual(['submit-01 first-message #1', 'submit-01 first-message #2', 'submit-01 first-message #3'])
})

test('--variant：不给是每类的 default（skill 是 stage-1 加 stage-2）；可以给几次；all 是全部；skill 的一步带上它那一对', () => {
  expect(variantsFor('submit', []).map((v) => v.name)).toEqual(['default'])
  expect(variantsFor('skill', []).map((v) => v.name)).toEqual(['stage-1', 'stage-2'])
  expect(variantsFor('midrun', ['recent-1', 'recent-3']).map((v) => v.name)).toEqual(['recent-1', 'recent-3'])
  expect(variantsFor('agent', ['recent-1'])).toEqual([])
  expect(variantsFor('skill', ['stage-2-shuffled']).map((v) => v.name)).toEqual(['stage-1-shuffled', 'stage-2-shuffled'])
  expect(variantsFor('agent', ['all']).map((v) => v.name)).toEqual(['default', 'with-controls', 'direct-shuffled', 'open-b'])
  // The second request of the alone pair takes its shortlist from stage-1-alone's answer.
  expect(variantsFor('skill', ['stage-1-alone']).map((v) => v.name)).toEqual(['stage-1-alone', 'stage-2-alone'])
  expect(tally(wants([agentCase], ['default'], 2))).toEqual(['agent-01 default #1', 'agent-01 default #2'])
})

test('同一会话的用例跨类也只在一组（修订 A2、A13）', () => {
  const a: SubmitCase = { ...submitCase, source: 'real', session: '0a10ce6b', set: 'fit' }
  const b: SkillCase = { ...skillCase, source: 'real', session: '0a10ce6b', set: 'fit' }
  expect(checkSessions([a, b])).toEqual([])
  const problems = checkSessions([a, { ...b, set: 'heldout' }, { ...midrunCase, session: '02d43f60' }])
  expect(problems.length).toBe(1)
  expect(problems[0]).toContain('0a10ce6b')
  expect(problems[0]).toContain('skill-01')
})
