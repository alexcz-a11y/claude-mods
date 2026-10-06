// Dispatched agents: each agent the main agent starts gets its own decision on
// its model and effort at agent.spawn. Seam 1: engine events in; out, what the
// spawn and the agent's steps reach the engine with, the request the decision
// model got, the board (`w.board()`), the old status line (a few tests), the decision log.

import { expect, test } from 'claude-code/testing'
import { dispatchPart, dispatchState, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { CLEF_OPTIONS, CLEF_URL, clef, clefInputProblems } from './support/cloudflare.ts'
import { world, type Reply, type Sent } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

type AgentAnswers = {
  /** The model question's probability for each option (an option left out gets 0). */
  model?: Record<string, number>
  /** The effort levels' probabilities, lowest first. */
  effort?: readonly number[]
  /** Each yes/no question's answer by its id within the part (`named.haiku`); the rest get 0. */
  nouls?: Record<string, number>
  /** The named-effort question's probability for each option (`none`, `low` .. `max`); without it the answer is `none`. */
  namedEffort?: Record<string, number>
}

/** Jev answering a dispatched agent's request: every question it asked, by type. */
function agentJev(answers: AgentAnswers) {
  return (request: Sent): Reply => {
    const out: Record<string, unknown> = {}
    const questions = (request.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>
    for (const [id, question] of Object.entries(questions)) {
      const local = id.slice(id.indexOf('.') + 1)
      if (question.type === 'choice') {
        const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
        const given = local === 'named_effort' ? (answers.namedEffort ?? { none: 1 }) : answers.model
        const probabilities = Object.fromEntries(options.map((option) => [option, given?.[option] ?? 0]))
        const choice = options.reduce((best, option) => ((probabilities[option] ?? 0) > (probabilities[best] ?? 0) ? option : best), options[0] ?? '')
        out[id] = { type: 'choice', choice, probabilities, confidence: 0.5 }
      } else if (question.type === 'score') {
        const levels = answers.effort ?? [0, 0, 1, 0, 0]
        const probabilities = Object.fromEntries(levels.map((p, i) => [String(i), p]))
        out[id] = { type: 'score', score: levels.reduce((sum, p, i) => sum + p * i, 0), legend: {}, probabilities, confidence: 0.7 }
      } else {
        out[id] = { type: 'noul', noul: answers.nouls?.[local] ?? 0 }
      }
    }
    return { status: 200, body: { model: 'jev-1.13.0', answers: out, usage: { input_tokens: 400, output_tokens: 0 } } }
  }
}

test('a dispatched agent starts on the model decided for it, and every one of its steps goes out at the effort decided for it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.05, sonnet: 0.85, opus: 0.1 }, effort: [0, 0.1, 0.8, 0.1, 0] }) })
  const started = await w.spawn({ prompt: 'Rename getUser to fetchUser across src/api and run `pnpm test api`.', description: 'Rename getUser' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.step({ index: 1, turnId: 'sub-1', agentId: started.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet'])
  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-sonnet-5-5 high', 'claude-sonnet-5-5 high'])
  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['agent.model', 'agent.effort'])
})

test("an agent's effort is lifted to its model's floor, and the log says so: sonnet and opus at medium at least; the person's effort is never lifted", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request) => {
      const prompt = String(request.body.state.brief.prompt)
      if (prompt.startsWith('A')) return agentJev({ model: { sonnet: 1 }, effort: [0.75, 0.25, 0, 0, 0] })(request)
      if (prompt.startsWith('B')) return agentJev({ model: { sonnet: 1 }, effort: [0, 0, 1, 0, 0] })(request)
      if (prompt.startsWith('C')) return agentJev({ model: { opus: 1 }, effort: [1, 0, 0, 0, 0] })(request)
      return agentJev({ model: { opus: 1 }, effort: [0, 0, 0, 1, 0], namedEffort: { none: 0.02, low: 0.96, medium: 0.02 } })(request)
    },
  })
  await w.submit('先看看，D 那个 effort 用 low')
  const spawned = [await w.spawn({ prompt: 'A: list the open TODOs.' }), await w.spawn({ prompt: 'B: rename the helper.' }), await w.spawn({ prompt: 'C: summarize the log.' }), await w.spawn({ prompt: 'D: check the lock.' })]
  for (const [i, started] of spawned.entries()) await w.step({ index: 0, turnId: `sub-${i}`, agentId: started.agentId, model: i < 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.steps.map((s) => String(s.effort))).toEqual(['medium', 'high', 'medium', 'low'])
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^sonnet medium for .*effort lifted from low to medium \(floor for sonnet\)/))
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^opus medium for .*effort lifted from low to medium \(floor for opus\)/))

  // The log entry keeps what the card needs: the levels' probabilities, the rules' working, the floor that lifted.
  const lifted = (await w.board()).log.find((entry) => entry.agent === spawned[0]?.agentId)
  expect(lifted).toMatchObject({ outcome: 'sonnet medium', floor: { from: 'low', to: 'medium', model: 'sonnet' }, conf: 1 })
  expect(Object.keys(lifted?.probs ?? {})).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(lifted?.trace?.map((step) => [step.rule, step.applied, step.level])).toEqual([
    ['top', true, 'low'],
    ['max-gate', false, 'low'],
    ['round-up', false, 'low'],
    ['model-floor', true, 'medium'],
  ])
  // The effort the person asked for is theirs: no floor, and the rules' working is the decision model's.
  expect((await w.board()).log.find((entry) => entry.agent === spawned[3]?.agentId)?.floor).toBeUndefined()
})

test('an agent sent to haiku gets no effort: its steps go out without one, whatever the effort answer says (spec #32)', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9, sonnet: 0.08, opus: 0.02 }, effort: [0, 0, 0, 1, 0] }) })
  const started = await w.spawn({ prompt: 'List every file under src/ that imports legacyAuth. Report file:line only.', description: 'Find legacyAuth imports', subagentType: 'Explore' })
  // Haiku takes no effort: the engine sends none.
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-haiku-4-5', effort: null })
  // Were the engine to send one, the mod would take it off.
  await w.step({ index: 1, turnId: 'sub-1', agentId: started.agentId, model: 'claude-haiku-4-5', effort: 'medium' })

  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
  expect(w.steps.map((s) => String(s.effort))).toEqual(['undefined', 'undefined'])
})

test("the main agent's pick reaches the decision model as a hint, and stands unless it is sure of another one (agentOverride, default 0.6)", { options: KEY }, async ($, on) => {
  // Of three options, p 0.9 is confidence 0.85; p 0.5 is confidence 0.25.
  const sure = { haiku: 0.9, sonnet: 0.05, opus: 0.05 }
  const unsure = { haiku: 0.5, sonnet: 0.3, opus: 0.2 }
  const w = world($, on, { backend: (request, n) => agentJev({ model: n === 1 ? sure : unsure })(request) })
  await w.spawn({ prompt: 'Run `pnpm test` and list the failing tests by package. Do not fix anything.', model: 'opus' })
  await w.spawn({ prompt: 'Run `pnpm lint` and list the warnings by file. Do not fix anything.', model: 'opus' })

  expect(w.spawned.map((s) => s.model)).toEqual(['haiku', 'opus'])
  const instructions = w.requests[0]?.body.questions['agent.model'].instructions
  expect(instructions.requested).toContain('opus')
})

test("agentOverride sets how sure the decision model must be to replace the main agent's pick", { options: { ...KEY, agentOverride: 0.9 } }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 } }) })
  await w.spawn({ prompt: 'Run `pnpm test` and list the failing tests by package. Do not fix anything.', model: 'claude-opus-5-5' })

  // Confidence 0.85 < 0.9: the main agent's pick stands, as it named it.
  expect(w.spawned.map((s) => s.model)).toEqual(['claude-opus-5-5'])
})

test("a model the person names for the work in this turn's message wins over the decision model and the main agent", { options: KEY }, async ($, on) => {
  // The decision model would send it to opus, the main agent asked for sonnet;
  // it reads the person's words as asking for haiku.
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.02, sonnet: 0.03, opus: 0.95 }, nouls: { 'named.haiku': 0.93 } }) })
  await w.submit('给 utils/date.ts 补几个边界情况的单测，用 haiku 跑就行，省点额度')
  await w.step({ index: 0 })
  await w.spawn({ prompt: '为 src/utils/date.ts 的 parseRelative、toBusinessDay 写 vitest 单测，覆盖跨月、跨年、闰年。', description: '补 date 工具单测', model: 'sonnet' })

  const sent = w.requests[1]?.body
  expect(sent?.state.user_message).toBe('给 utils/date.ts 补几个边界情况的单测，用 haiku 跑就行，省点额度')
  expect(Object.keys(sent?.questions)).toContain('agent.named.haiku')
  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
})

test('a model name is no request by itself: the decision model judges each one mentioned (a product compared, a model not to use)', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request, n) =>
      agentJev(
        // Requests 1 and 3 are the messages' own (main effort); 2 and 4 the agents'.
        n === 2
          ? { model: { haiku: 0.05, sonnet: 0.05, opus: 0.9 }, nouls: { 'named.haiku': 0.08, 'named.sonnet': 0.1 } }
          : n === 4
            ? { model: { haiku: 0.05, sonnet: 0.05, opus: 0.9 }, nouls: { 'named.opus': 0.04, 'named.haiku': 0.94 } }
            : {},
      )(request),
  })
  await w.submit('我们的产品要接 Claude API 做工单分类，帮我比较一下 haiku 和 sonnet 哪个性价比高')
  await w.spawn({ prompt: 'Research the current pricing of the latest Haiku and Sonnet models and recommend one for 40k tickets a day.', description: 'Compare Haiku vs Sonnet cost' })
  await w.submit('别用 opus 了，用 haiku 就行：把 #incident-0928 频道导出的聊天记录整理成时间线')
  await w.spawn({ prompt: '读取 exports/slack/incident-0928.json，整理成事故时间线。不要分析根因。', description: '整理事故时间线', model: 'opus' })

  const named = (n: number) => Object.keys(w.requests[n]?.body.questions).filter((id) => id.startsWith('agent.named.'))
  expect(named(1)).toEqual(['agent.named.haiku', 'agent.named.sonnet'])
  expect(named(3)).toEqual(['agent.named.haiku', 'agent.named.opus'])
  // The products compared ask for nothing: the decision model's pick stands.
  // The model asked for wins, not the one named first (and refused).
  expect(w.spawned.map((s) => s.model)).toEqual(['opus', 'haiku'])
})

test('a model the person names is used even when it is not among the options (fable), and gets its decided effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { opus: 1 }, effort: [0, 0, 0, 0.3, 0.7], nouls: { 'named.fable': 0.9 } }) })
  await w.submit('这个调度算法的正确性证明交给 fable 做，其他的先不用管')
  const started = await w.spawn({ prompt: '证明 docs/scheduler.md 第 3 节的优先级继承调度算法满足两条性质；不成立就构造反例。', description: '证明调度算法正确性' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-fable-5-1', effort: 'xhigh' })

  expect(Object.keys(w.requests[1]?.body.questions['agent.model'].criteria)).toEqual(['haiku', 'sonnet', 'opus'])
  expect(w.spawned.map((s) => s.model)).toEqual(['fable'])
  expect(w.steps.map((s) => `${String(s.agentId)} ${String(s.effort)}`)).toEqual([`${started.agentId} max`])
})

test("a model the person rules out is not used: the decision model's next choice takes its place, even over the main agent's pick of it", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request, n) =>
      agentJev(
        n === 2
          ? { model: { haiku: 0.1, sonnet: 0.3, opus: 0.6 }, nouls: { 'banned.opus': 0.92 } }
          : n === 3
            ? { model: { haiku: 0.2, sonnet: 0.5, opus: 0.3 }, nouls: { 'banned.opus': 0.9 } }
            : {},
      )(request),
  })
  await w.submit('这周额度快用完了，派 agent 的时候别用 opus。帮我想想消息队列从 RabbitMQ 换到 Kafka 值不值得')
  await w.spawn({ prompt: '评估把消息队列从 RabbitMQ 换成 Kafka 是否值得：对比三种做法，给出建议、迁移成本和风险。', description: '评估 MQ 迁移' })
  // The main agent asks for opus all the same; sonnet's 0.5 would not be sure
  // enough to replace a pick that stands, but this one is ruled out.
  await w.spawn({ prompt: '列出 12 个服务里依赖消息优先级和延迟队列插件的地方。', description: '查 MQ 特性依赖', model: 'opus' })

  expect(Object.keys(w.requests[1]?.body.questions)).toEqual(['agent.model', 'agent.effort', 'agent.named.opus', 'agent.banned.opus'])
  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet', 'sonnet'])
})

test('a model the person rules out is never the one the agent starts on, whichever way the answer leans: all its probability on the model ruled out, with or without the main agent asking for it', { options: KEY }, async ($, on) => {
  // The answer puts everything on opus and nothing on the models left; the person ruled opus out.
  const w = world($, on, { backend: (request, n) => (n === 1 ? agentJev({})(request) : agentJev({ model: { opus: 1 }, nouls: { 'banned.opus': 0.92 } })(request)) })
  await w.submit('这周额度快用完了，派 agent 的时候别用 opus。帮我想想消息队列从 RabbitMQ 换到 Kafka 值不值得')
  await w.spawn({ prompt: '评估把消息队列从 RabbitMQ 换成 Kafka 是否值得：对比三种做法，给出建议、迁移成本和风险。', description: '评估 MQ 迁移' })
  await w.spawn({ prompt: '列出 12 个服务里依赖消息优先级和延迟队列插件的地方。', description: '查 MQ 特性依赖', model: 'opus' })
  await w.spawn({ prompt: '把 RabbitMQ 的死信队列配置整理成表。', description: '整理死信队列', model: 'claude-opus-5-5' })

  // The nearest model that is left, not the one ruled out.
  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet', 'sonnet', 'sonnet'])
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/ruled out opus.*no probability.*nearest sonnet/))
})

test("a request that failed as a whole decided nothing, so a model the person ruled out is not known: the agent starts as the main agent asked", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 500, body: 'Internal Server Error' }) })
  await w.submit('派 agent 的时候别用 opus')
  await w.spawn({ prompt: 'Summarize what src/billing/invoice.ts does.', model: 'opus' })

  expect(w.spawned.map((s) => s.model)).toEqual(['opus'])
  const board = await w.board()
  expect(board.agents).toMatchObject([{ id: 'a1', kind: 'agent', routed: false, why: 'jev: HTTP 500', failure: { backend: 'jev', kind: 'http', status: 500 } }])
  expect(board.log.filter((entry) => entry.feature === 'dispatched-agents')).toEqual([])
})

test("an effort the person asks for in this turn's message is the effort of the agent, over the one the decision model would give; the decision model judges whether it was asked for", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request, n) =>
      agentJev(
        // Requests 1 and 3 are the messages' own (main effort); 2 and 4 the agents'.
        n === 2
          ? { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0, 0, 0.1, 0.8, 0.1], namedEffort: { none: 0.05, low: 0.9, medium: 0.05 } }
          : n === 4
            ? { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0, 0, 0.1, 0.8, 0.1], namedEffort: { none: 0.9, high: 0.1 } }
            : {},
      )(request),
  })
  await w.submit('用 sonnet、effort 开 low 跑就行，就是把 eslint 报的 unused imports 清掉')
  const first = await w.spawn({ prompt: 'Run `pnpm lint` and remove every import flagged as unused.', description: 'Remove unused imports', model: 'sonnet' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: first.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })
  // A message that only mentions a level asks for none: the decided effort stands.
  await w.submit('这个重构的 effort 通常要 high 才够，你看着办')
  const second = await w.spawn({ prompt: 'Refactor the retry logic in src/net across the three clients.', description: 'Refactor retry' })
  await w.step({ index: 0, turnId: 'sub-2', agentId: second.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(Object.keys(w.requests[1]?.body.questions)).toContain('agent.named_effort')
  expect(w.steps.map((s) => `${String(s.agentId)} ${String(s.effort)}`)).toEqual([`${first.agentId} low`, `${second.agentId} xhigh`])
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^sonnet low for "Remove unused imports".*effort named in your message \(low\)/))
})

test("a message with no word about effort asks no named-effort question: the cheap text sign decides whether to ask, the decision model what the words mean", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { sonnet: 1 } }) })
  await w.submit('给 utils/date.ts 补几个边界情况的单测')
  await w.spawn({ prompt: '为 src/utils/date.ts 写 vitest 单测。', description: '补单测' })

  expect(Object.keys(w.requests[1]?.body.questions).filter((id) => id.includes('effort'))).toEqual(['agent.effort'])
})

test('an effort the person asks for all the agents of the turn reaches each of them', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0, 0, 0.1, 0.8, 0.1], namedEffort: { none: 0.03, high: 0.95, max: 0.02 } }) })
  await w.submit('这次所有 agent 的 effort 都开 high，先查一下登录模块再写测试')
  const a = await w.spawn({ prompt: 'Read src/auth/login.ts and explain the flow.', description: 'Explain login' })
  const b = await w.spawn({ prompt: 'Write unit tests for src/auth/login.ts.', description: 'Login tests' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: a.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.step({ index: 0, turnId: 'sub-2', agentId: b.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.steps.map((s) => String(s.effort))).toEqual(['high', 'high'])
})

test('a named effort needs the answer to be sure (0.5 for the level asked, as for a model): a half-hearted yes leaves the decided effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { sonnet: 1 }, effort: [0, 0, 1, 0, 0], namedEffort: { none: 0.3, low: 0.4, medium: 0.3 } }) })
  await w.submit('effort 低一点也行吧')
  const started = await w.spawn({ prompt: 'Write unit tests for src/cache/lru.ts.' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.steps.map((s) => String(s.effort))).toEqual(['high'])
})

test('an agent that goes to haiku takes no effort, named or not: the person is not overruled but the log says what was asked and why it was not set', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 }, effort: [1, 0, 0, 0, 0], namedEffort: { none: 0, xhigh: 1 } }) })
  await w.submit('所有 agent 的 effort 都用 xhigh')
  const started = await w.spawn({ prompt: 'List every file under src/ that imports legacyAuth. Report file:line only.', description: 'Find legacyAuth imports' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-haiku-4-5', effort: null })

  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
  expect(w.steps.map((s) => String(s.effort))).toEqual(['undefined'])
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^haiku for .*effort xhigh asked for in your message, not set: haiku takes no effort/))
})

test('agents dispatched together are each decided on their own, and each starts as soon as its own answer is in',{ options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request) =>
      String(request.body.state.brief.prompt).startsWith('Design')
        ? { after: 1000, reply: agentJev({ model: { haiku: 0.05, sonnet: 0.05, opus: 0.9 }, effort: [0, 0, 0, 1, 0] })(request) }
        : agentJev({ model: { haiku: 0.05, sonnet: 0.9, opus: 0.05 }, effort: [0, 0, 1, 0, 0] })(request),
  })
  // One assistant message with two Agent calls: two spawns at once.
  const designing = w.spawn({ prompt: 'Design the cache invalidation across the three services.', description: 'Design cache invalidation' })
  const testing = w.spawn({ prompt: 'Write unit tests for src/cache/lru.ts covering eviction order.', description: 'LRU tests' })
  const tests = await testing
  // The tests agent started while the design agent's answer was still out.
  expect(w.spawned.map((s) => s.description)).toEqual(['LRU tests'])
  await w.clock.settle()
  await w.clock.advance(1000)
  const design = await designing
  await w.step({ index: 0, turnId: 'sub-1', agentId: design.agentId, model: 'claude-opus-5-5', effort: 'medium' })
  await w.step({ index: 0, turnId: 'sub-2', agentId: tests.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests.map((r) => r.body.state.brief.description).sort()).toEqual(['Design cache invalidation', 'LRU tests'])
  expect(w.spawned.map((s) => `${s.description}: ${String(s.model)}`)).toEqual(['LRU tests: sonnet', 'Design cache invalidation: opus'])
  expect(w.steps.map((s) => `${String(s.agentId)} ${String(s.effort)}`)).toEqual([`${design.agentId} xhigh`, `${tests.agentId} high`])
})

test('agents dispatched together each have their own decision on the board: model, effort, why, and the log entry it came from', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request) =>
      String(request.body.state.brief.prompt).startsWith('Design')
        ? agentJev({ model: { haiku: 0.05, sonnet: 0.05, opus: 0.9 }, effort: [0, 0, 0, 1, 0] })(request)
        : agentJev({ model: { haiku: 0.05, sonnet: 0.9, opus: 0.05 }, effort: [0, 0, 1, 0, 0] })(request),
  })
  await w.submit('把缓存失效逻辑设计出来，再补上 LRU 的单测')
  const design = await w.spawn({ prompt: 'Design the cache invalidation across the three services.', description: 'Design cache invalidation', subagentType: 'Plan' })
  const tests = await w.spawn({ prompt: 'Write unit tests for src/cache/lru.ts covering eviction order.', description: 'LRU tests' })

  const board = await w.board()
  expect(board.agents).toHaveLength(2)
  // Spawned, not stepped yet: queued, routed as decided, each linked to its own entry of the log, which says what was decided.
  expect(board.agents.find((node) => node.id === design.agentId)).toMatchObject({ kind: 'agent', name: 'Design cache invalidation', type: 'Plan', state: 'queued', routed: true })
  expect(board.agents.find((node) => node.id === tests.agentId)).toMatchObject({ kind: 'agent', name: 'LRU tests', state: 'queued', routed: true })
  for (const node of board.agents) {
    const entry = board.log.find((kept) => kept.n === node.decision)
    expect(entry).toMatchObject({ feature: 'dispatched-agents', agent: node.id, tone: 'ok', turn: 1 })
  }
  expect(board.agents.map((node) => board.log.find((kept) => kept.n === node.decision)).map((entry) => [entry?.model, entry?.effort])).toEqual([
    ['opus', 'xhigh'],
    ['sonnet', 'high'],
  ])
  // Their first steps are what the nodes read: the model and effort that went out, routed as decided.
  await w.step({ index: 0, turnId: 'sub-1', agentId: design.agentId, model: 'claude-opus-5-5', effort: 'medium' })
  await w.step({ index: 0, turnId: 'sub-2', agentId: tests.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })
  const read = (await w.board()).agents
  expect(read.find((node) => node.id === design.agentId)).toMatchObject({ state: 'running', model: 'opus', effort: 'xhigh', routed: true })
  expect(read.find((node) => node.id === tests.agentId)).toMatchObject({ state: 'running', model: 'sonnet', effort: 'high', routed: true })
  expect(board.log.filter((entry) => entry.feature === 'dispatched-agents').map((entry) => entry.outcome)).toEqual(['opus xhigh', 'sonnet high'])
  expect(board.log.find((entry) => entry.agent === design.agentId)?.reason).toMatch(/confidence 0\.85/)
})

test("an agent the decision model could not be asked about is on the board as not routed, with the reason, next to the one that was routed", { options: KEY }, async ($, on) => {
  // Request 1 is the message's own; 2 and 3 are the agents'.
  const w = world($, on, { backend: (request, n) => (n === 3 ? { status: 500, body: 'Internal Server Error' } : agentJev({ model: { sonnet: 1 } })(request)) })
  await w.submit('查一下登录模块')
  const first = await w.spawn({ prompt: 'Read src/auth/login.ts and explain the flow.', description: 'Explain login' })
  const second = await w.spawn({ prompt: 'Write unit tests for src/auth/login.ts.', description: 'Login tests', model: 'opus' })

  const board = await w.board()
  expect(board.agents.map((node) => [node.id, node.routed])).toEqual([
    [first.agentId, true],
    [second.agentId, false],
  ])
  expect(board.agents[1]).toMatchObject({ name: 'Login tests', why: 'jev: HTTP 500', failure: { backend: 'jev', kind: 'http', status: 500 } })
  expect(board.agents[1]?.decision).toBeUndefined()
})

test("what the mod sends about an agent is exactly what the decision module builds from the eval item's fields, so the eval measures the live request (spec #67)", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { sonnet: 1 } }) })
  await w.submit('这个改动涉及权限判断，用 opus 认真审一下')
  const prompt = '审查当前分支相对 main 的 diff（约 30 行，改了 src/policies/document.ts 的 canEdit 和 canShare），列出权限扩大的边界情况。'
  await w.spawn({ prompt, description: '审查权限改动', subagentType: 'general-purpose', model: 'sonnet' })

  // subagent.jsonl's item shape (`zh`), as the eval (#15) reads it.
  const item: Dispatch = {
    user_message: '这个改动涉及权限判断，用 opus 认真审一下',
    kind: 'agent',
    agent_type: 'general-purpose',
    description: '审查权限改动',
    prompt,
    requested_model: 'sonnet',
    workflow_description: null,
    label: null,
  }
  const built = mergeParts(dispatchState(item, 2000), [dispatchPart(item)])
  expect(w.requests[1]?.body).toEqual({ model: 'jev-latest', state: built.state, questions: built.questions })
})

test("with Clef as the decision model, the agent's request passes Clef's input rules and the agent is routed", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('别用 opus 了，用 sonnet 就行：给 src/cache/lru.ts 补单测')
  const started = await w.spawn({ prompt: 'Write unit tests for src/cache/lru.ts covering eviction order.', description: 'LRU tests', model: 'opus' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-sonnet-5-5', effort: 'low' })

  const sent = w.requests[1]
  expect(sent?.url).toBe(CLEF_URL)
  expect(clefInputProblems(sent?.body)).toEqual([])
  expect(Object.keys(sent?.body.questions)).toEqual(['agent.model', 'agent.effort', 'agent.named.sonnet', 'agent.named.opus', 'agent.banned.sonnet', 'agent.banned.opus'])
  // Clef answered medium; a sonnet agent goes at medium at least.
  expect(w.steps.map((s) => String(s.effort))).toEqual(['medium'])
})

test('agentFable adds fable to the models the decision model may choose for an agent', { options: { ...KEY, agentFable: true } }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.02, sonnet: 0.03, opus: 0.15, fable: 0.8 }, effort: [0, 0, 0, 0.2, 0.8] }) })
  await w.spawn({ prompt: 'Prove that the lease-renewal protocol keeps mutual exclusion under clock drift; build a counterexample if it does not.', description: 'Prove mutual exclusion' })

  expect(Object.keys(w.requests[0]?.body.questions['agent.model'].criteria)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  expect(w.spawned.map((s) => s.model)).toEqual(['fable'])
})

test("the status line shows the latest dispatched agent's model and effort, and whose choice the model was", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request, n) =>
      agentJev(
        n === 1
          ? { model: { haiku: 0.05, sonnet: 0.9, opus: 0.05 }, effort: [0, 0, 1, 0, 0] }
          : n === 2
            ? { model: { haiku: 0.4, sonnet: 0.3, opus: 0.3 }, effort: [0, 1, 0, 0, 0] }
            : { model: { opus: 1 }, nouls: { 'named.haiku': 0.9 } },
      )(request),
  })
  const lines: (string | undefined)[] = []
  await w.spawn({ prompt: 'Write tests for src/cache/lru.ts.' })
  lines.push(w.status())
  await w.spawn({ prompt: 'Review the diff of src/policies/document.ts.', model: 'opus' })
  lines.push(w.status())
  await w.submit('这次用 haiku 把日志里的报错列出来就行')
  await w.spawn({ prompt: 'List the errors in logs/app.log.' })
  lines.push(w.status())

  expect(lines).toEqual(['dp agent sonnet high', 'dp agent opus medium (kept)', 'dp agent haiku (you)'])
  // The board keeps every one of them.
  expect((await w.board()).log.filter((entry) => entry.feature === 'dispatched-agents').map((entry) => [entry.model, entry.effort])).toEqual([
    ['sonnet', 'high'],
    ['opus', 'medium'],
    ['haiku', undefined],
  ])
})

test("each dispatched agent's decision is logged with its reason: in the debug log, never in the conversation, and in /dp log", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.05, sonnet: 0.9, opus: 0.05 }, effort: [0, 0, 1, 0, 0] }) })
  await w.spawn({ prompt: 'Rename getUser to fetchUser across src/api.', description: 'Rename getUser', subagentType: 'general-purpose' })

  expect(w.logs.length).toBeGreaterThan(0)
  expect(w.logs.every((log) => log.to === 'debug')).toBe(true)
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^sonnet high for "Rename getUser" \(general-purpose\): .*confidence 0\.85/))
  expect(await w.command('dp', 'log')).toMatch(/#1 dispatched-agents: sonnet high for "Rename getUser" \(general-purpose\): .*confidence 0\.85/)
})

test('/dp dispatched-agents off lets agents start as the main agent sent them, with nothing asked and its status segment gone; on brings the decisions back', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 }, effort: [0, 1, 0, 0, 0] }) })
  expect(await w.command('dp')).toMatch(/\bon +dispatched-agents +\S/)
  await w.spawn({ prompt: 'List the files under src/.' })
  expect((await w.board()).agents).toMatchObject([{ state: 'queued', routed: true, decision: 1 }])
  expect((await w.board()).log).toMatchObject([{ feature: 'dispatched-agents', model: 'haiku', outcome: 'haiku' }])
  expect(w.status()).toBe('dp agent haiku')

  expect(await w.command('dp', 'dispatched-agents off')).toContain('dispatched-agents is off')
  expect(w.status()).toBeUndefined()
  const started = await w.spawn({ prompt: 'List the files under test/.', model: 'opus' })
  await w.step({ index: 0, turnId: 'sub-2', agentId: started.agentId, model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(w.requests).toHaveLength(1)
  expect(w.spawned.map((s) => s.model)).toEqual(['haiku', 'opus'])
  expect(w.steps.map((s) => String(s.effort))).toEqual(['xhigh'])

  await w.command('dp', 'dispatched-agents on')
  await w.spawn({ prompt: 'List the files under docs/.' })
  expect(w.requests).toHaveLength(2)
})

test('/dp off stands dispatched agents down too: nothing is asked and the agent starts as the main agent sent it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 } }) })
  await w.command('dp', 'off')
  await w.spawn({ prompt: 'List the files under src/.', model: 'sonnet' })

  expect(w.requests).toHaveLength(0)
  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet'])
  // Nothing was decided: the agent is on the board all the same, and not routed.
  expect((await w.board()).agents).toMatchObject([{ state: 'queued', routed: false }])
  expect((await w.board()).log).toEqual([])
  expect(w.status()).toBe('dp off')
})

test('no answer within timeoutMs: the agent starts then, on the model it was given, at the engine effort, and the status line says why', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: agentJev({ model: { haiku: 1 } })(request) }) })
  const spawning = w.spawn({ prompt: 'Profile the checkout endpoint and find the slow query.', description: 'Profile checkout', model: 'opus' })
  await w.clock.settle()
  await w.clock.advance(800)
  const started = await spawning
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.spawned.map((s) => s.model)).toEqual(['opus'])
  expect(w.steps.map((s) => String(s.effort))).toEqual(['xhigh'])
  expect((await w.board()).agents).toMatchObject([{ id: started.agentId, routed: false, why: 'jev: no answer in 800 ms', failure: { backend: 'jev', kind: 'timeout' } }])
})

const failures: { name: string; reply: Reply; status: string }[] = [
  { name: 'the key is refused (401)', reply: { status: 401, body: { detail: 'Invalid API key' } }, status: 'jev: key refused (HTTP 401)' },
  { name: 'a server error (500)', reply: { status: 500, body: 'Internal Server Error' }, status: 'jev: HTTP 500' },
  { name: 'the network is down', reply: { reject: 'getaddrinfo ENOTFOUND api.typesafe.ai' }, status: 'jev: unreachable' },
  { name: "an answer without the agent's questions", reply: { status: 200, body: { model: 'jev-1.13.0', answers: {} } }, status: 'jev: unreadable answer' },
]

for (const failure of failures) {
  test(`${failure.name}: the agent starts on the model it was given, at the engine effort, and the status line says why`, { options: KEY }, async ($, on) => {
    const w = world($, on, { backend: () => failure.reply })
    const started = await w.spawn({ prompt: 'Summarize what src/billing/invoice.ts does.', description: 'Explain invoice.ts', model: 'sonnet' })
    await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-sonnet-5-5', effort: 'high' })

    expect(w.requests).toHaveLength(1)
    expect(w.spawned.map((s) => s.model)).toEqual(['sonnet'])
    expect(w.steps.map((s) => String(s.effort))).toEqual(['high'])
    expect((await w.board()).agents).toMatchObject([{ id: started.agentId, name: 'Explain invoice.ts', routed: false, why: failure.status }])
  })
}

test('no TypeSafe key: nothing is sent, the agent starts as the main agent asked, and the status line says to set the key', async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 1 } }) })
  await w.spawn({ prompt: 'Summarize what src/billing/invoice.ts does.', model: 'sonnet' })

  expect(w.requests).toHaveLength(0)
  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet'])
  expect((await w.board()).agents).toMatchObject([{ routed: false, why: 'jev: no TypeSafe API key: set typesafeApiKey', failure: { backend: 'jev', kind: 'config' } }])
})

test("a fork (it always runs on its parent's model) and a teammate (it lives across many tasks) are left as they are, with no decision asked", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { haiku: 1 } }) })
  await w.spawn({ prompt: 'Carry on from here and check the tests.', subagentType: 'fork', fork: true })
  await w.spawn({ prompt: 'You review every pull request the team opens.', description: 'reviewer', isTeammate: true, model: 'sonnet' })

  expect(w.requests).toHaveLength(0)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'sonnet'])
})

test("the decision reads the person's words this turn: the message that started it and those typed during it, masked; no other prompt", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: agentJev({ model: { sonnet: 1 } }) })
  await w.submit('把登录模块拆成三层，测试账号的 token 是 ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789')
  await w.submit('另外，测试那部分单独派个 agent', { turnId: 't1' })
  await w.submit('<task-notification>agent a1 finished</task-notification>', { origin: { kind: 'task-notification' }, turnId: 't1' })
  await w.spawn({ prompt: 'Write the tests for the three new layers.' })
  // A new message sent while idle starts the words afresh.
  await w.submit('好，提交吧')
  await w.spawn({ prompt: 'Commit the change with a conventional message.' })

  const words = w.requests.filter((r) => 'agent.model' in r.body.questions).map((r) => r.body.state.user_message)
  expect(words).toEqual(['把登录模块拆成三层，测试账号的 token 是 [REDACTED]\n另外，测试那部分单独派个 agent', '好，提交吧'])
})
