// A calibration case as the request the mod itself would send, in each registered variant (calibration plan, Task 4).
// Pure: no node: module, no I/O; the runner sends what build() returns.
import { agentQuestions, midrunQuestions, submitQuestions } from '../../hooks/questions.ts'
import type { Question } from '../../hooks/questions.ts'
import { stageOne, stageTwo } from '../../hooks/skills.ts'
import type { Skill } from '../../hooks/skills.ts'
import { agentState, fitState, midrunState, submitState } from '../../hooks/statebuild.ts'
import type { Case, Category } from './case.ts'
import { DIRECT_LEVEL, LONG_UNATTENDED } from './controls.ts'

/**
 * One way of asking. A field left out is what the mod does (previous on, recent 5, stated_next on, no progress note,
 * stage 1); controls, skills and shuffle are off unless set. skills: the questions the mod's submit flow adds for the
 * session's skills go into the same request.
 */
export type Variant = { name: string; previous?: boolean; recent?: 1 | 3 | 5; statedNext?: boolean; progress?: 'none' | 'before' | 'after'; controls?: boolean; skills?: boolean; shuffle?: number; stage?: 1 | 2 }
export type Built = { caseId: string; variant: string; state: Record<string, unknown>; questions: Record<string, Question>; hash: string }

/**
 * 每一类预先登记的给法；第一项是默认（和 mod 发的一样）。Every variant of submit, midrun and agent carries the control
 * questions, so one differs from its default in the state only (Ruling C18a); with-skills adds questions, nothing else.
 */
export const VARIANTS: Record<Category, readonly Variant[]> = {
  submit: [
    { name: 'default', previous: true, controls: true },
    { name: 'no-previous', previous: false, controls: true },
    // Amendment A13: the direct question's options in another order, to see whether its pick follows the order.
    { name: 'direct-shuffled', previous: true, controls: true, shuffle: 1 },
    // Ruling C18b: the request as the mod sends it when the session has skills, the skill questions beside the level's.
    { name: 'with-skills', previous: true, controls: true, skills: true },
  ],
  midrun: [
    { name: 'default', recent: 5, statedNext: true, progress: 'none', controls: true },
    { name: 'recent-1', recent: 1, controls: true },
    { name: 'recent-3', recent: 3, controls: true },
    { name: 'no-stated-next', statedNext: false, controls: true },
    { name: 'progress-before', progress: 'before', controls: true },
    { name: 'progress-after', progress: 'after', controls: true },
    { name: 'direct-shuffled', recent: 5, statedNext: true, progress: 'none', controls: true, shuffle: 1 },
  ],
  agent: [
    { name: 'default', controls: true },
    { name: 'direct-shuffled', controls: true, shuffle: 1 },
  ],
  skill: [
    { name: 'stage-1', stage: 1 },
    { name: 'stage-2', stage: 2 },
    { name: 'stage-1-shuffled', stage: 1, shuffle: 1 },
    { name: 'stage-2-shuffled', stage: 2, shuffle: 1 },
  ],
}

// The calibration asks Drex only (global constraints); the backend decides whether a choice carries the option other.
const BACKEND = 'drex'

/** 一个用例在一种给法下的请求；skill 的第二次请求要给第一次选出的 short。 */
export function build(c: Case, v: Variant, ctx: { skills: readonly Skill[]; short?: readonly Skill[] }): Built {
  let state: Record<string, unknown>
  let questions: Record<string, Question>
  if (c.category === 'submit') {
    const previous = v.previous === false ? null : c.input.previous
    state = submitState({ request: c.input.request, previous })
    questions = submitQuestions(previous !== null)
    if (v.controls) questions = { ...questions, direct: DIRECT_LEVEL, long_unattended: LONG_UNATTENDED }
    // Merged as hooks/flows/submit.ts merges them: the level's questions first, the skill questions after.
    if (v.skills) questions = { ...questions, ...stageOne([...ctx.skills], BACKEND, true) }
  } else if (c.category === 'midrun') {
    const i = c.input
    const progress = v.progress === 'before' ? (i.notes?.before ?? null) : v.progress === 'after' ? (i.notes?.after ?? null) : null
    state = midrunState({
      request: i.request,
      current: i.current,
      stepsSoFar: i.stepsSoFar,
      failedSteps: i.failedSteps,
      recent: i.recent.slice(-(v.recent ?? 5)),
      latest: i.latest,
      statedNext: v.statedNext === false ? '' : i.statedNext,
      progress,
    })
    questions = midrunQuestions()
    // The long-unattended flag is about a whole job handed over, which a check in mid-run is not.
    if (v.controls) questions = { ...questions, direct: DIRECT_LEVEL }
  } else if (c.category === 'agent') {
    state = agentState({ task: c.input.task, agentType: c.input.agentType, description: c.input.description })
    questions = agentQuestions()
    if (v.controls) questions = { ...questions, direct: DIRECT_LEVEL, long_unattended: LONG_UNATTENDED }
  } else {
    // The skill flow asks about the message as the submit flow states it.
    state = submitState({ request: c.input.request, previous: c.input.previous })
    if (v.stage === 2) {
      if (ctx.short === undefined) throw new Error(`${c.id}: the second skill request needs the shortlist from the first`)
      questions = stageTwo([...ctx.short], BACKEND)
    } else {
      questions = stageOne([...ctx.skills], BACKEND, true)
    }
  }
  if (v.shuffle !== undefined) questions = shuffled(questions, v.shuffle)
  // ask() fits the state to its budget before sending; the request recorded is the one sent.
  state = fitState(state)
  return { caseId: c.id, variant: v.name, state, questions, hash: fnv1a64(JSON.stringify({ state, questions })) }
}

// mulberry32: a small seeded generator, so a shuffle is the same on every run.
function generator(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Every choice question's options in a seeded order. Drex's option other ("none fits") stays last, where the mod puts
// it: the shuffle tests the order of the real options. An order that comes out unchanged is rotated by one, so a
// shuffled variant always differs from its plain one.
function shuffled(questions: Record<string, Question>, seed: number): Record<string, Question> {
  const next = generator(seed)
  const out: Record<string, Question> = {}
  for (const [id, q] of Object.entries(questions)) {
    if (q.type !== 'choice') {
      out[id] = q
      continue
    }
    const keys = Object.keys(q.criteria)
    const real = keys.filter((k) => k !== 'other')
    const order = [...real]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    if (order.length > 1 && order.every((k, i) => k === real[i])) order.push(order.shift()!)
    if (keys.includes('other')) order.push('other')
    out[id] = { ...q, criteria: Object.fromEntries(order.map((k) => [k, q.criteria[k]!])) }
  }
  return out
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

// UTF-8 bytes counted by hand, as statebuild.ts does: the test sandbox is not guaranteed a TextEncoder.
function utf8(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    let cp = ch.codePointAt(0) ?? 0
    // A lone surrogate is encoded as U+FFFD.
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return out
}

/** FNV-1a, 64 bits, as 16 hex digits: the key a stored answer is found by (a changed word is a new request). */
export function fnv1a64(text: string): string {
  let h = FNV_OFFSET
  for (const b of utf8(text)) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK
  return h.toString(16).padStart(16, '0')
}
