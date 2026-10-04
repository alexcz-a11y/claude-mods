// The subagent suite of the eval (seam 2): what it sends for an item is what
// the mod sends when the person sends that message and the main agent then
// dispatches that agent, and what it decides from an answer is what the mod
// does with the same answer (checked against the mod itself, through seam 1's
// world).

import { expect, test } from 'claude-code/testing'
import type { PluginOptions } from 'claude-code'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import type { Language, SubagentItem } from '../eval/lib/datasets.ts'
import { subagent } from '../eval/lib/subagent.ts'
import { settingsFrom, type Ask } from '../eval/lib/suite.ts'
import { jev, world } from './support/world.ts'

const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'
const ZH = '上周的事故复盘里提到权限判断有漏洞，'
const EN = "Last week's incident review said the permission checks have holes. "

/**
 * An agent item longer than every budget: the person's message is cut twice
 * (to the context budget when it is kept for the turn, then to a third of it
 * in the agent's state) and the prompt once; both hold a secret. The message
 * names a model at its end, and mentions another in the middle that the
 * first cut drops.
 */
const LONG: SubagentItem = {
  id: 'subagent-900',
  zh: {
    user_message: `${ZH.repeat(120)}（上次那版是 haiku 写的）${ZH.repeat(80)}密钥是 ${SECRET}，别外传。这次用 opus 认真审一下`,
    kind: 'agent',
    agent_type: 'general-purpose',
    description: '审查权限改动',
    prompt: `${'逐条核对 src/policies/ 下每条规则与新的同部门规则是否冲突，'.repeat(120)}token ${SECRET}，最后用表格汇报发现。`,
    requested_model: 'sonnet',
    workflow_description: null,
    label: null,
  },
  en: {
    user_message: `${EN.repeat(120)}(haiku wrote the last version) ${EN.repeat(80)}The key is ${SECRET}, keep it private. Use opus to review it carefully this time.`,
    kind: 'agent',
    agent_type: 'general-purpose',
    description: 'Review permission change',
    prompt: `${'Check each rule under src/policies/ against the new same-department rule. '.repeat(120)}Token ${SECRET}. Report the findings as a table.`,
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

/** The request the eval sends for `item` in `language` (asked of no backend: the request is all that is read). */
async function evalRequest(item: SubagentItem, language: Language, options: PluginOptions = {}): Promise<DecisionRequest> {
  let sent: DecisionRequest | undefined
  const ask: Ask = async (request) => {
    sent = request
    return { request, asked: { ok: false, failure: { kind: 'config', detail: 'not sent' } }, ms: 0, attempts: 1 }
  }
  await subagent.decide(item, language, 'models-hint', ask, settingsFrom(options))
  if (sent === undefined) throw new Error('the suite sent no request')
  return sent
}

for (const language of ['zh', 'en'] as const) {
  test(`the eval's request for an agent item is the mod's request when the main agent dispatches that agent after that message (${language})`, { options: { typesafeApiKey: 'k' } }, async ($, on) => {
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

test("a Workflow's agent() is asked about like a dispatched agent, one agent a request, the workflow's description and its label in the brief, placeholders as written", async () => {
  // The mod has no Workflow event to compare with until #8; #8 decides each agent() with the same decision module.
  const item: SubagentItem = {
    ...LONG,
    id: 'subagent-901',
    zh: {
      user_message: '把 12 个包的重试实现盘点一下',
      kind: 'workflow',
      agent_type: null,
      description: null,
      prompt: '在 packages/${pkg} 里找出所有与重试相关的代码，每处列出文件:行号和退避策略。',
      requested_model: 'opus',
      workflow_description: '盘点 12 个包的重试实现：按包并行扫描 → 汇总判断是否值得统一',
      label: 'scan:${pkg}',
    },
    tags: ['fan-out', 'priority:main-overridden'],
  }
  const request = await evalRequest(item, 'zh')

  expect(request.state).toEqual({
    brief: { workflow_description: item.zh.workflow_description, label: 'scan:${pkg}', prompt: item.zh.prompt },
    user_message: '把 12 个包的重试实现盘点一下',
  })
  expect(Object.keys(request.questions)).toEqual(['agent.model', 'agent.effort'])
  // The pick the script wrote for the agent() is the main agent's: a hint in the model question.
  expect(JSON.stringify(request.questions['agent.model'])).toContain('asked for opus')
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
function agentItem(id: string, asked: Partial<SubagentItem['zh']>): SubagentItem {
  const zh: SubagentItem['zh'] = {
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

test("the eval decides an agent as the mod does from the same answers, under the mod's options (agentOverride, agentFable)", { options: { typesafeApiKey: 'k', agentOverride: 0.9, agentFable: true } }, async ($, on) => {
  const cases: { item: SubagentItem; answers: Answers }[] = [
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

    const decided = await subagent.decide(
      item,
      'zh',
      'models-hint',
      async (request) => ({ request, asked: { ok: true, answers: answersTo(request.questions, answers), model: 'jev-1.13.0', inputTokens: 1500 }, ms: 0, attempts: 1 }),
      settingsFrom({ agentOverride: 0.9, agentFable: true }),
    )
    // An agent on haiku goes out at the engine's effort (`low` in this step).
    evaluated.push(decided.ok ? `${item.id}: ${decided.prediction.model} ${decided.prediction.effort ?? 'low'}` : `${item.id}: ${decided.failure}`)
  }
  expect(mod).toEqual(['keep: opus xhigh', 'fable: fable max', 'named: sonnet medium', 'haiku: haiku low'])
  expect(evaluated).toEqual(mod)
})
