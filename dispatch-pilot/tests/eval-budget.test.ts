import { expect, test } from 'claude-code/testing'
import { CAP, mayAskHeldout, pool, spend } from '../eval/lib/budget.ts'
import type { Spent } from '../eval/lib/budget.ts'
import { checkSessions } from '../eval/lib/case.ts'
import type { AgentCase, Case, MidrunCase, SkillCase, SubmitCase } from '../eval/lib/case.ts'
import { heldoutWants, sentState, variantsFor, wants } from '../eval/lib/plan.ts'

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

test('有一个请求因为限流失败：这次运行剩下的一次一个', async () => {
  const t = tracker()
  const out = await pool([0, 1, 2, 3, 4, 5, 6, 7], { concurrency: 4, reserve: () => true, run: (i) => t.run(i === 0), limited: (r) => r })
  expect(out.serial).toBe(true)
  expect(out.results.length).toBe(8)
  expect(t.startedWith.slice(0, 4)).toEqual([0, 1, 2, 3])
  expect(t.startedWith.slice(4)).toEqual([0, 0, 0, 0])
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

test('留出集的一次运行：每类每种登记的给法都发，default 3 遍（skill 是 stage-1 和 stage-2），其余 1 遍', () => {
  const got = tally(heldoutWants([submitCase, midrunCase, agentCase, skillCase]))
  expect(got).toEqual([
    'submit-01 default #1', 'submit-01 default #2', 'submit-01 default #3',
    'submit-01 no-previous #1', 'submit-01 direct-shuffled #1', 'submit-01 with-skills #1',
    'midrun-01 default #1', 'midrun-01 default #2', 'midrun-01 default #3',
    'midrun-01 recent-1 #1', 'midrun-01 recent-3 #1', 'midrun-01 no-stated-next #1', 'midrun-01 progress-before #1', 'midrun-01 progress-after #1', 'midrun-01 direct-shuffled #1',
    'agent-01 default #1', 'agent-01 default #2', 'agent-01 default #3', 'agent-01 direct-shuffled #1',
    'skill-01 stage-1 #1', 'skill-01 stage-1 #2', 'skill-01 stage-1 #3', 'skill-01 stage-2 #1', 'skill-01 stage-2 #2', 'skill-01 stage-2 #3',
    'skill-01 stage-1-shuffled #1', 'skill-01 stage-2-shuffled #1',
  ])
})

test('--variant：不给是每类的 default（skill 是 stage-1 加 stage-2）；可以给几次；all 是全部；skill 的一步带上它那一对', () => {
  expect(variantsFor('submit', []).map((v) => v.name)).toEqual(['default'])
  expect(variantsFor('skill', []).map((v) => v.name)).toEqual(['stage-1', 'stage-2'])
  expect(variantsFor('midrun', ['recent-1', 'recent-3']).map((v) => v.name)).toEqual(['recent-1', 'recent-3'])
  expect(variantsFor('agent', ['recent-1'])).toEqual([])
  expect(variantsFor('skill', ['stage-2-shuffled']).map((v) => v.name)).toEqual(['stage-1-shuffled', 'stage-2-shuffled'])
  expect(variantsFor('agent', ['all']).map((v) => v.name)).toEqual(['default', 'direct-shuffled'])
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
