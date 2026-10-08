// The `subagent` suite of the eval, dispatched agents (seam 2): what it sends for an item is what
// the mod sends when the person sends that message and the main agent then
// dispatches that agent, or submits the Workflow script whose agent() it is,
// and what it decides from an answer is what the mod does with the same
// answer (checked against the mod itself, through seam 1's world).

import { expect, test } from 'claude-code/testing'
import type { PluginOptions } from 'claude-code'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import type { Language, AgentItem } from '../eval/lib/datasets.ts'
import { agentSuite } from '../eval/lib/subagent.ts'
import { settingsFrom, type Ask } from '../eval/lib/suite.ts'
import { siteJev, workflowWorld } from './support/workflow.ts'
import { jev, world } from './support/world.ts'

const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'
const ZH = '上周的事故复盘里提到权限判断有漏洞，'
const EN = "Last week's incident review said the permission checks have holes. "

/**
 * An agent item longer than every budget (Jev's default for an agent's request is 24000 tokens): the
 * person's message is cut twice (to the context budget when it is kept for the
 * turn, then to a third of it in the agent's state) and the prompt once; both
 * hold a secret. The message
 * names a model at its end, and mentions another in the middle that the
 * first cut drops.
 */
const LONG: AgentItem = {
  id: 'subagent-900',
  zh: {
    user_message: `${ZH.repeat(400)}（上次那版是 haiku 写的）${ZH.repeat(300)}密钥是 ${SECRET}，别外传。这次用 opus 认真审一下`,
    kind: 'agent',
    agent_type: 'general-purpose',
    description: '审查权限改动',
    prompt: `${'逐条核对 src/policies/ 下每条规则与新的同部门规则是否冲突，'.repeat(1500)}token ${SECRET}，最后用表格汇报发现。`,
    requested_model: 'sonnet',
    workflow_description: null,
    label: null,
  },
  en: {
    user_message: `${EN.repeat(400)}(haiku wrote the last version) ${EN.repeat(300)}The key is ${SECRET}, keep it private. Use opus to review it carefully this time.`,
    kind: 'agent',
    agent_type: 'general-purpose',
    description: 'Review permission change',
    prompt: `${'Check each rule under src/policies/ against the new same-department rule. '.repeat(2500)}Token ${SECRET}. Report the findings as a table.`,
    requested_model: 'sonnet',
    workflow_description: null,
    label: null,
  },
  gold: { model: 'opus', effort: 'high' },
  accept: { model: ['opus'], effort: ['high', 'xhigh'] },
  rationale: '用户点名 opus 来审。',
  difficulty: 'hard',
  tags: ['security', 'priority:user'],
}

/**
 * The request the eval sends for `item` in `language` (asked of no backend:
 * the request is all that is read), its suite built over `dataset`.
 */
async function evalRequest(item: AgentItem, language: Language, options: PluginOptions = {}, dataset: readonly AgentItem[] = [item], variant = 'models-hint'): Promise<DecisionRequest> {
  let sent: DecisionRequest | undefined
  const ask: Ask = async (request) => {
    sent = request
    return { request, asked: { ok: false, failure: { kind: 'config', detail: 'not sent' } }, ms: 0, attempts: 1 }
  }
  await agentSuite(dataset).decide(item, language, variant, ask, settingsFrom({ decisionModel: 'jev', ...options }))
  if (sent === undefined) throw new Error('the suite sent no request')
  return sent
}

for (const language of ['zh', 'en'] as const) {
  test(`the eval's request for an agent item is the mod's request when the main agent dispatches that agent after that message (${language})`, { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
    const asked = LONG[language]
    const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
    await w.submit(asked.user_message)
    await w.spawn({ prompt: asked.prompt, description: asked.description ?? '', subagentType: asked.agent_type ?? 'general-purpose', model: asked.requested_model ?? undefined })

    const request = await evalRequest(LONG, language)
    // requests[0] is the main agent's effort, decided when the message was sent.
    expect(w.requests).toHaveLength(2)
    expect(w.requests[1]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
    // What the request holds, so the equality above is not two empty things:
    // both texts cut and masked, the model named at the message's end asked about.
    const brief = request.state.brief as Record<string, string>
    const words = String(request.state.user_message)
    expect(words).toContain('[REDACTED]')
    expect(words).toContain(' … ')
    expect(words.slice(words.lastIndexOf(' … '))).toContain('opus')
    expect(brief.prompt).toContain(' … ')
    expect(brief.prompt).toContain('[REDACTED]')
    expect(JSON.stringify(request)).not.toContain(SECRET)
    // Asked about opus, named at the end; not about haiku, which the mod cut
    // from the middle when it kept the message for the turn.
    expect(asked.user_message).toContain('haiku')
    expect(Object.keys(request.questions)).toEqual(['agent.model', 'agent.effort', 'agent.named.opus', 'agent.banned.opus'])
  })
}

/** A Workflow's agent() as the dataset writes it: one item per call, the script's description and the person's message the same in each. */
function workflowItem(id: string, call: { prompt: Record<Language, string>; label: string; requested_model: AgentItem['zh']['requested_model'] }): AgentItem {
  const asked = (language: Language): AgentItem['zh'] => ({
    user_message: language === 'zh' ? '我们每个包的重试逻辑都不太一样，帮我摸个底，看看值不值得统一' : 'Every package retries in its own way. Take stock and tell me whether it is worth unifying.',
    kind: 'workflow',
    agent_type: null,
    description: null,
    prompt: call.prompt[language],
    requested_model: call.requested_model,
    workflow_description: language === 'zh' ? '盘点 12 个包的重试实现：按包并行扫描 → 汇总判断是否值得统一' : 'Audit the retry code of 12 packages: scan each package in parallel, then judge whether to unify',
    label: call.label,
  })
  return { id, zh: asked('zh'), en: asked('en'), gold: { model: 'sonnet', effort: 'medium' }, accept: { model: ['sonnet'], effort: ['medium'] }, rationale: '理由', difficulty: 'hard', tags: ['fan-out'] }
}

// Two calls of one script: a fan-out over the packages, the main agent's opus written in it, then a summary.
const SCAN = workflowItem('subagent-901', {
  prompt: { zh: '在 packages/${pkg} 里找出所有与重试相关的代码，每处列出文件:行号和退避策略。', en: 'Find every piece of retry code in packages/${pkg}; list file:line and the backoff of each.' },
  label: 'scan:${pkg}',
  requested_model: 'opus',
})
const SYNTH = workflowItem('subagent-902', {
  prompt: { zh: '读各包的扫描结果，判断重试实现是否值得统一，给出建议和迁移顺序。', en: "Read every package's scan, judge whether the retry code is worth unifying, and propose an order to migrate." },
  label: 'synthesize',
  requested_model: null,
})

/** The script the main agent submits for SCAN and SYNTH: their calls in the items' order. */
function retryScript(language: Language): string {
  return [
    `export const meta = { name: 'retry-audit', description: ${JSON.stringify(SCAN[language].workflow_description)}, phases: [] }`,
    'const scans = await Promise.all(PACKAGES.map((pkg) => agent(`' + SCAN[language].prompt + '`, { label: `scan:${pkg}`, model: \'opus\' })))',
    `const summary = await agent(${JSON.stringify(SYNTH[language].prompt)}, { label: 'synthesize' })`,
    'return summary',
    '',
  ].join('\n')
}

for (const language of ['zh', 'en'] as const) {
  test(`a Workflow's agents are asked about as the mod asks about the agent() calls of the script the main agent submits: in one request, a part and a brief each (${language})`, { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
    const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 } })) })
    await w.submit(SCAN[language].user_message)
    await w.workflow({ script: retryScript(language) })

    const forScan = await evalRequest(SCAN, language, {}, [SCAN, SYNTH])
    const forSynth = await evalRequest(SYNTH, language, {}, [SCAN, SYNTH])
    // requests[0] is the main agent's effort, decided when the message was sent; then the script's one request.
    expect(w.requests).toHaveLength(2)
    expect(w.requests[1]?.body).toEqual({ model: JEV_MODEL, state: forScan.state, questions: forScan.questions })
    expect(forSynth).toEqual(forScan)
    // What the request holds, so the equality above is not two empty things.
    expect(Object.keys(forScan.questions)).toEqual(['agent-0.model', 'agent-0.effort', 'agent-1.model', 'agent-1.effort'])
    expect(forScan.state.brief_0).toEqual({ workflow_description: SCAN[language].workflow_description, label: 'scan:${pkg}', prompt: SCAN[language].prompt })
    // The pick the script wrote for the call is the main agent's: a hint in its model question.
    expect(JSON.stringify(forScan.questions['agent-0.model'])).toContain('asked for opus')
  })
}

test("the single variant asks about each of a Workflow's agents in a request of its own, with the part and the brief the script's request gives it", async () => {
  const scan = await evalRequest(SCAN, 'zh', {}, [SCAN, SYNTH], 'models-hint-single')
  const synth = await evalRequest(SYNTH, 'zh', {}, [SCAN, SYNTH], 'models-hint-single')
  expect(Object.keys(scan.questions)).toEqual(['agent-0.model', 'agent-0.effort'])
  expect(Object.keys(synth.questions)).toEqual(['agent-1.model', 'agent-1.effort'])
  expect(Object.keys(synth.state)).toEqual(['brief_1', 'user_message'])
})

/** Whether a value holds Chinese text anywhere. */
const hasChinese = (value: unknown) => /[一-鿿]/.test(JSON.stringify(value))

test('the models-hint-zh variant asks what models-hint asks, every question written in Chinese: the same state, the same questions in the same order', async () => {
  for (const [item, dataset] of [
    [LONG, [LONG]],
    [SCAN, [SCAN, SYNTH]],
  ] as const) {
    const english = await evalRequest(item, 'en', {}, dataset, 'models-hint')
    const chinese = await evalRequest(item, 'en', {}, dataset, 'models-hint-zh')
    expect(chinese.state).toEqual(english.state)
    expect(Object.keys(chinese.questions)).toEqual(Object.keys(english.questions))
    expect(hasChinese(english.questions)).toBe(false)
    for (const [id, question] of Object.entries(chinese.questions)) expect([id, hasChinese(question)]).toEqual([id, true])
  }
  // The questions as the mod writes them in Chinese (decision/dispatched-agent.ts), the brief's field named in them.
  const asked = await evalRequest(LONG, 'zh', {}, [LONG], 'models-hint-zh')
  expect(asked.questions['agent.model']?.instructions).toMatchObject({ 问题: '哪个模型是能把 `brief` 做好的最便宜的一个？' })
  expect(JSON.stringify(asked.questions['agent.model']?.instructions)).toContain('写 `brief` 的主 agent 指定了 sonnet')
  expect(asked.questions['agent.effort']?.instructions).toMatchObject({ 问题: '一个派出的 agent 要完成 `brief`，需要多少逐步推理？' })
})

test("from the same answers the eval decides each of a Workflow's agents as the mod writes it into the script", { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
  const answers = siteJev((i) =>
    i === 0 ? { model: { haiku: 0.05, sonnet: 0.15, opus: 0.8 }, effort: [0, 0, 0.1, 0.8, 0.1] } : { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0, 0.8, 0.2, 0, 0] },
  )
  const w = workflowWorld($, on, { backend: answers })
  await w.submit(SCAN.zh.user_message)
  const told = ((await w.workflow({ script: retryScript('zh') })).context ?? []).join('\n')

  const suite = agentSuite([SCAN, SYNTH])
  const ask: Ask = async (request) => {
    const reply = answers({ url: '', method: 'POST', headers: {}, body: request, at: 0 }) as { body: { answers: Record<string, never> } }
    return { request, asked: { ok: true, answers: reply.body.answers, model: 'jev-1.13.0', inputTokens: 400 }, ms: 0, attempts: 1 }
  }
  const decided = await Promise.all([SCAN, SYNTH].map((item) => suite.decide(item, 'zh', 'models-hint', ask, settingsFrom({ decisionModel: 'jev' }))))
  expect(decided.map((one) => (one.ok ? `${one.prediction.model} ${one.prediction.effort}` : one.failure))).toEqual(['opus xhigh', 'sonnet medium'])
  expect(told).toContain('"scan:${pkg}": opus xhigh')
  expect(told).toContain('"synthesize": sonnet medium')
})

/** A decision model's answers about one agent: the model question's probabilities, the effort levels', and yes/no answers by id within the part (0 otherwise). */
type Answers = { model: Record<string, number>; effort: readonly number[]; nouls?: Record<string, number> }

/** The answers part of a backend's reply to a request about one agent, every question answered from `answers`. */
function answersTo(questions: Readonly<Record<string, { type: string }>>, answers: Answers): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(questions)) {
    const local = id.slice(id.indexOf('.') + 1)
    if (question.type === 'choice') out[id] = { type: 'choice', choice: '', probabilities: answers.model, confidence: 0.5 }
    else if (question.type === 'score') out[id] = { type: 'score', score: 0, probabilities: Object.fromEntries(answers.effort.map((p, i) => [String(i), p])), confidence: 0.6 }
    else out[id] = { type: 'noul', noul: answers.nouls?.[local] ?? 0 }
  }
  return out
}

/** An agent item (zh only is asked here); `asked` fills in the brief. */
function agentItem(id: string, asked: Partial<AgentItem['zh']>): AgentItem {
  const zh: AgentItem['zh'] = {
    user_message: '看一下',
    kind: 'agent',
    agent_type: 'general-purpose',
    description: id,
    prompt: `${id}: 把 src/cache/ 的淘汰策略查清楚并汇报。`,
    requested_model: null,
    workflow_description: null,
    label: null,
    ...asked,
  }
  return { id, zh, en: zh, gold: { model: 'sonnet', effort: 'medium' }, accept: { model: ['sonnet'], effort: ['medium'] }, rationale: '理由', difficulty: 'hard', tags: ['priority:none'] }
}

test("the eval decides an agent as the mod does from the same answers, under the mod's options (agentOverride, agentFable)", { options: { decisionModel: 'jev', typesafeApiKey: 'k', agentOverride: 0.9, agentFable: true } }, async ($, on) => {
  const cases: { item: AgentItem; answers: Answers }[] = [
    // Of four options p 0.9 is confidence 0.87: under agentOverride 0.9, the main agent's opus stands.
    { item: agentItem('keep', { requested_model: 'opus' }), answers: { model: { haiku: 0.9, sonnet: 0.05, opus: 0.05, fable: 0 }, effort: [0, 0, 0, 1, 0] } },
    // fable is offered (agentFable): sure enough to replace the main agent's sonnet.
    { item: agentItem('fable', { requested_model: 'sonnet' }), answers: { model: { haiku: 0, sonnet: 0, opus: 0.02, fable: 0.98 }, effort: [0, 0, 0, 0.3, 0.7] } },
    // The person names sonnet for the work: it wins over the main agent's opus and the decision model's haiku.
    { item: agentItem('named', { user_message: '这活儿 sonnet 就够了', requested_model: 'opus' }), answers: { model: { haiku: 0.97, sonnet: 0.01, opus: 0.01, fable: 0.01 }, effort: [0, 1, 0, 0, 0], nouls: { 'named.sonnet': 0.9 } } },
    // haiku takes no effort: the agent's steps keep the engine's.
    { item: agentItem('haiku', {}), answers: { model: { haiku: 0.99, sonnet: 0.01, opus: 0, fable: 0 }, effort: [0, 0, 1, 0, 0] } },
  ]
  const byPrompt = new Map(cases.map(({ item, answers }) => [item.zh.prompt, answers]))
  const w = world($, on, {
    backend: (request) => {
      const answers = byPrompt.get(request.body.state.brief?.prompt) ?? { model: {}, effort: [0, 0, 1, 0, 0] }
      return { status: 200, body: { model: 'jev-1.13.0', answers: answersTo(request.body.questions, answers), usage: { input_tokens: 1500 } } }
    },
  })
  const mod: string[] = []
  const evaluated: string[] = []
  for (const { item, answers } of cases) {
    const asked = item.zh
    await w.submit(asked.user_message)
    const started = await w.spawn({ prompt: asked.prompt, description: asked.description ?? '', subagentType: asked.agent_type ?? 'general-purpose', model: asked.requested_model ?? undefined })
    await w.step({ index: 0, turnId: `sub-${item.id}`, agentId: started.agentId, model: 'claude-sonnet-5-5', effort: 'low' })
    mod.push(`${item.id}: ${String(w.spawned.at(-1)?.model)} ${String(w.steps.at(-1)?.effort)}`)

    const decided = await agentSuite([item]).decide(
      item,
      'zh',
      'models-hint',
      async (request) => ({ request, asked: { ok: true, answers: answersTo(request.questions, answers), model: 'jev-1.13.0', inputTokens: 1500 }, ms: 0, attempts: 1 }),
      settingsFrom({ decisionModel: 'jev', agentOverride: 0.9, agentFable: true }),
    )
    // An agent on haiku goes out at the engine's effort (`low` in this step).
    evaluated.push(decided.ok ? `${item.id}: ${decided.prediction.model} ${decided.prediction.effort ?? 'low'}` : `${item.id}: ${decided.failure}`)
  }
  expect(mod).toEqual(['keep: opus xhigh', 'fable: fable max', 'named: sonnet medium', 'haiku: haiku low'])
  expect(evaluated).toEqual(mod)
})
