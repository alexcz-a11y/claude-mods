// The `ctx30` experiment (2026-10-15, the person's design): thirty questions about one long conversation, all in one
// request, asked of Jev 1.14 twice: with the context the mod sends a message today (the newest 24000 estimated tokens,
// within Jev's default 32k a question and 64k a request) and with the long-context header (the whole conversation, within
// 262k). Each question's decisive turns lie beyond those 24000 tokens, so only the second request can see them.
//
// The conversation is one long working session in a made-up repository (ledgerly), written by hand in
// datasets/ctx30/conversation/*.txt; the questions are in datasets/ctx30/questions.json: fifteen ask the main agent's
// effort for a message the person might send next, fifteen the model of an agent the main agent might dispatch next.
// Every question has one right answer. The questions are the mod's own Chinese ones (decision/effort.ts,
// decision/dispatched-agent.ts); what each asks about (the message, the agent's brief) goes in its instructions instead
// of the state, since thirty share one state, and an agent's question says what `recent_context` is.
//
// Pure: no Node API.

import { BACKEND_DEFAULTS } from '../../hooks/core/setup.ts'
import { JEV_REGULAR_STATE } from '../../hooks/decision/jev.ts'
import { estimateTokens, recentLines, recentWithin, withinTokens, type ContextMessage } from '../../hooks/decision/context.ts'
import { AGENT_MODELS, DEFAULT_DISPATCH_ASK, MODEL, dispatchBrief, dispatchPart, type AgentModel, type Dispatch } from '../../hooks/decision/dispatched-agent.ts'
import { EFFORTS, LEVEL, pickEffort, readEffort, turnStartEffortPart, type Effort } from '../../hooks/decision/effort.ts'
import { redactSecrets } from '../../hooks/decision/redact.ts'
import { answersFor, mergeParts, type Answer, type DecisionRequest, type Part, type Question } from '../../hooks/decision/system-one.ts'

/** One message of the conversation as written: who, what, the tools it called, the questions it is decisive for. */
export type Ctx30Message = {
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  marks: string[]
  /** Where it was written: `<file>:<line>`. */
  at: string
}

export type EffortProbe = { id: string; kind: 'effort'; gold: Effort; naive: Effort; user_message: string; rationale: string }
export type AgentProbe = {
  id: string
  kind: 'agent'
  gold: AgentModel
  naive: AgentModel
  user_message: string
  brief: { description: string; agent_type: string; prompt: string }
  rationale: string
  /** The answer does not rest on the conversation; it may lead a reader astray (a hard history around easy work). */
  trap?: true
}
export type Probe = EffortProbe | AgentProbe

/** The part every question is asked in: its ids are `q.<probe id>`. */
export const PART = 'q'
/** The state the mod gave a message's effort request when the experiment ran: the most without the long-context header (decision/jev.ts). */
export const REGULAR_TOKENS = JEV_REGULAR_STATE
/** What the agent questions say `recent_context` is: the mod's own model question said nothing of it (Jev got none then). */
export const BACKGROUND = '`recent_context` 是主 agent 派出这个 agent 之前和用户的对话。'

const HEAD = /^@@ (user|assistant)((?: [a-z]+=\S+)*)\s*$/
const ATTRIBUTE = / ([a-z]+)=(\S+)/g

/** The messages of the conversation files, in order; a line `%% …` is a note, not part of any message. */
export function parseConversation(files: readonly { name: string; text: string }[]): { messages: Ctx30Message[]; errors: string[] } {
  const messages: Ctx30Message[] = []
  const errors: string[] = []
  for (const file of files) {
    let current: (Ctx30Message & { lines: string[] }) | null = null
    const close = () => {
      if (current === null) return
      const text = current.lines.join('\n').trim()
      if (text === '') errors.push(`${current.at}: an empty message`)
      messages.push({ role: current.role, text, tools: current.tools, marks: current.marks, at: current.at })
      current = null
    }
    file.text.split('\n').forEach((line, index) => {
      if (line.startsWith('%%')) return
      if (line.startsWith('@@')) {
        close()
        const head = HEAD.exec(line)
        const at = `${file.name}:${index + 1}`
        if (head === null) {
          errors.push(`${at}: not a message head: ${line}`)
          return
        }
        const attributes = Object.fromEntries([...(head[2] ?? '').matchAll(ATTRIBUTE)].map((match) => [match[1], match[2]]))
        const tools = (attributes.tools ?? '').split(',').filter(Boolean).flatMap((tool) => {
          const [name, times] = tool.split('*')
          return Array.from({ length: Number(times ?? 1) }, () => name as string)
        })
        const marks = (attributes.mark ?? '').split(',').filter(Boolean)
        const role = head[1] as 'user' | 'assistant'
        if (role === 'user' && tools.length > 0) errors.push(`${at}: a user message with tools`)
        current = { role, text: '', tools, marks, at, lines: [] }
        return
      }
      if (current === null) {
        if (line.trim() !== '') errors.push(`${file.name}:${index + 1}: text outside a message`)
        return
      }
      current.lines.push(line)
    })
    close()
  }
  messages.forEach((message, i) => {
    const before = messages[i - 1]
    if (before !== undefined && before.role === message.role) errors.push(`${message.at}: two ${message.role} messages in a row`)
  })
  return { messages, errors }
}

/** The conversation as the mod writes it into `recent_context`: a line a message (context.ts `recentLines`), oldest first. */
export function conversationLines(messages: readonly Ctx30Message[]): string[] {
  const rows: ContextMessage[] = messages.map((message) => ({ role: message.role, text: message.text, toolUses: message.tools.map((tool) => ({ tool })) }))
  return recentLines(rows, '', rows.length)
}

/** Each line's depth: the estimated tokens from its start to the end of the conversation, each line counting one more (its newline). */
export function depths(lines: readonly string[]): number[] {
  const out: number[] = new Array(lines.length)
  let total = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    total += estimateTokens(lines[i] as string) + 1
    out[i] = total
  }
  return out
}

/** What the mod's secret masking would change in a message: its text masked differs from its text. */
export function maskedMessages(messages: readonly Ctx30Message[]): string[] {
  return messages.filter((message) => redactSecrets(message.text) !== message.text).map((message) => message.at)
}

/** The question about one probe: the mod's Chinese effort question or model question, with what it asks about in its instructions. */
export function probeQuestion(probe: Probe): Question {
  if (probe.kind === 'effort') {
    const asked = turnStartEffortPart({ language: 'zh', primitive: 'score' }).questions[LEVEL] as Question & { instructions: Record<string, string> }
    return { ...asked, instructions: { user_message: probe.user_message, ...asked.instructions } } as Question
  }
  const dispatch: Dispatch = { user_message: probe.user_message, agent_type: probe.brief.agent_type, description: probe.brief.description, prompt: probe.brief.prompt, requested_model: null }
  const asked = dispatchPart(dispatch, { ask: { ...DEFAULT_DISPATCH_ASK, language: 'zh' } }).questions[MODEL] as Question & { instructions: Record<string, string> }
  return {
    ...asked,
    instructions: { brief: dispatchBrief(dispatch, REGULAR_TOKENS), user_message: probe.user_message, 背景: BACKGROUND, ...asked.instructions },
  } as Question
}

/** The thirty questions as one part. */
export function probesPart(probes: readonly Probe[]): Part {
  return { part: PART, questions: Object.fromEntries(probes.map((probe) => [probe.id, probeQuestion(probe)])) }
}

/**
 * The request: `recent_context` is the newest lines within `tokens` as the state is sent (the mod's `withinTokens` and
 * `recentWithin`), or the whole conversation when `tokens` is null.
 */
export function ctx30Request(lines: readonly string[], probes: readonly Probe[], tokens: number | null): { request: DecisionRequest; kept: number } {
  const state = tokens === null ? { recent_context: lines.join('\n') } : withinTokens((budget) => ({ recent_context: recentWithin(lines, budget) }), tokens)
  const kept = state.recent_context === '' ? 0 : state.recent_context.split('\n').length
  return { request: mergeParts(state, [probesPart(probes)]), kept }
}

/** One answer read as the mod reads it: an effort by the effort rules (and the most probable level), a model by the most probable option. */
export type Read = { answer: string | null; top: string | null; p: Record<string, number> | null }

export function readProbe(probe: Probe, answer: Answer | undefined): Read {
  if (probe.kind === 'effort') {
    const reading = readEffort(answer)
    if (reading === null) return { answer: null, top: null, p: null }
    const { thetaMax, roundUp } = BACKEND_DEFAULTS.jev
    const p = Object.fromEntries(EFFORTS.map((level, i) => [level, round(reading.probabilities[i] ?? 0)]))
    return { answer: pickEffort(reading, { thetaMax, roundUp }), top: mostProbable(p), p }
  }
  if (answer === undefined || answer.type !== 'choice') return { answer: null, top: null, p: null }
  const p = Object.fromEntries(AGENT_MODELS.filter((model) => model in answer.probabilities).map((model) => [model, round(answer.probabilities[model] ?? 0)]))
  const top = mostProbable(p)
  return { answer: top, top, p }
}

/** Every probe's answer in one run's response. */
export function readRun(probes: readonly Probe[], raw: Readonly<Record<string, unknown>>): Map<string, Read> {
  const answers = answersFor(probesPart(probes), raw)
  return new Map(probes.map((probe) => [probe.id, readProbe(probe, answers[probe.id])]))
}

function mostProbable(p: Record<string, number>): string | null {
  let best: string | null = null
  for (const [name, value] of Object.entries(p)) if (best === null || value > (p[best] ?? 0)) best = name
  return best
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** The exact two-sided binomial test of the pairs only one run got right (McNemar's, exact). */
export function mcnemar(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB
  if (n === 0) return 1
  const k = Math.min(onlyA, onlyB)
  let tail = 0
  for (let i = 0; i <= k; i++) tail += choose(n, i)
  return Math.min(1, (2 * tail) / 2 ** n)
}

function choose(n: number, k: number): number {
  let out = 1
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i
  return out
}
