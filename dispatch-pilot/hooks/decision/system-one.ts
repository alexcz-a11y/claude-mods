// The System One request and answer shapes (TypeSafe's Jev; Cloudflare's Clef
// takes the same), and how several parts' questions share one request.
//
// Pure: no `$`, no value import from 'claude-code'. The mod, its tests and the
// Node eval scripts import this module as it is (relative imports end in .ts).

/** Instructions or a criterion: plain text, or an object/array that holds the question in one field and its data in others. */
export type Text = string | Readonly<Record<string, unknown>> | readonly unknown[]

/** Ordered levels, lowest first; the answer gives each level's probability by index ("0", "1", ...). */
export type ScoreQuestion = { type: 'score'; instructions: Text; criteria: readonly Text[] }
/** Named options; the answer gives each option's probability by name. */
export type ChoiceQuestion = { type: 'choice'; instructions: Text; criteria: Readonly<Record<string, Text | null>> }
/** Yes or no; the answer is the probability of yes. */
export type NoulQuestion = { type: 'noul'; instructions: Text; criteria?: { true?: Text; false?: Text } }
export type Question = ScoreQuestion | ChoiceQuestion | NoulQuestion

export type ScoreAnswer = { type: 'score'; score: number; probabilities: Readonly<Record<string, number>>; confidence: number | null }
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Readonly<Record<string, number>>; confidence: number | null }
export type NoulAnswer = { type: 'noul'; noul: number }
export type Answer = ScoreAnswer | ChoiceAnswer | NoulAnswer

/**
 * What every question of a request reads: one object, its most important
 * field first (the question guide's advice). Clef sorts the keys before it
 * reads a long state's head, so no field relies on its place: the state
 * builders keep the whole state within its budget (context.ts `withinTokens`).
 */
export type State = Readonly<Record<string, unknown>>

/** One decision request, less the backend's own fields (`model`). */
export type DecisionRequest = { state: State; questions: Readonly<Record<string, Question>> }

/**
 * One contributor's questions under its own name. In the request each id is
 * `<part>.<id>`; the answers come back to the part under its own ids.
 */
export type Part = {
  part: string
  questions: Readonly<Record<string, Question>>
  /**
   * Fields this part adds to the shared state, after the shared ones. Every
   * question of the request reads them, so add only what a question needs
   * (unrelated state lowers accuracy: guide §2.1 S5, S6).
   */
  state?: State
}

/** A part's name: no dot, the dot separates it from the question id. */
export const PART_NAME = /^[A-Za-z0-9_-]+$/
/** A question id both backends accept: Clef's rule (Jev documents none). */
export const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/
/** Clef answers at most 64 questions a request (Jev documents no limit). */
export const MAX_QUESTIONS = 64

/**
 * One request asking every part's questions about `state` (plus the fields
 * parts add to it). Throws a RangeError for a malformed part (bad name, a
 * name twice, a bad id, a state field already there) or when the request
 * would hold no question or more than MAX_QUESTIONS.
 */
export function mergeParts(state: State, parts: readonly Part[]): DecisionRequest {
  const merged: Record<string, unknown> = { ...state }
  const questions: Record<string, Question> = {}
  const names = new Set<string>()
  for (const { part, questions: own, state: added } of parts) {
    if (!PART_NAME.test(part)) throw new RangeError(`part name "${part}" must match ${PART_NAME}`)
    if (names.has(part)) throw new RangeError(`part "${part}" appears twice in one request`)
    names.add(part)
    for (const [id, question] of Object.entries(own)) {
      const full = `${part}.${id}`
      if (!QUESTION_ID.test(full)) throw new RangeError(`question id "${full}" must match ${QUESTION_ID}`)
      questions[full] = question
    }
    for (const [field, value] of Object.entries(added ?? {})) {
      if (field in merged) throw new RangeError(`state field "${field}" of part "${part}" is already in the state`)
      merged[field] = value
    }
  }
  const count = Object.keys(questions).length
  if (count === 0) throw new RangeError('a decision request needs at least one question')
  if (count > MAX_QUESTIONS) throw new RangeError(`${count} questions in one request; at most ${MAX_QUESTIONS}`)
  return { state: merged, questions }
}

/**
 * The answers to one part's questions, under the part's own ids. An answer
 * that is missing, of another type than its question, or malformed is left
 * out: the part treats a missing answer as no decision.
 */
export function answersFor(part: Part, answers: Readonly<Record<string, unknown>>): Record<string, Answer> {
  const own: Record<string, Answer> = {}
  for (const [id, question] of Object.entries(part.questions)) {
    const answer = readAnswer(question.type, answers[`${part.part}.${id}`])
    if (answer !== null) own[id] = answer
  }
  return own
}

/** What a System One response body carries, or null when it is not one (no `answers` object). */
export type Response = { model: string | null; answers: Readonly<Record<string, unknown>>; inputTokens: number | null }

export function readResponse(body: unknown): Response | null {
  if (!isRecord(body) || !isRecord(body.answers)) return null
  const usage = isRecord(body.usage) ? body.usage : {}
  return {
    model: typeof body.model === 'string' ? body.model : null,
    answers: body.answers,
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
  }
}

function readAnswer(type: Question['type'], raw: unknown): Answer | null {
  if (!isRecord(raw) || raw.type !== type) return null
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : null
  if (raw.type === 'noul') return typeof raw.noul === 'number' ? { type: 'noul', noul: raw.noul } : null
  const probabilities = numbers(raw.probabilities)
  if (probabilities === null) return null
  if (raw.type === 'score') return { type: 'score', score: typeof raw.score === 'number' ? raw.score : Number.NaN, probabilities, confidence }
  return { type: 'choice', choice: typeof raw.choice === 'string' ? raw.choice : '', probabilities, confidence }
}

function numbers(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null
  const out: Record<string, number> = {}
  for (const [key, p] of Object.entries(value)) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) return null
    out[key] = p
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
