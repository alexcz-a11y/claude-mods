// The progress note (design 5.13, approach B of 4.3; off unless progressNote): after each mid-run checkpoint a small
// model rewrites a three-field note on the turn in the background, and the next checkpoint's state carries it. Pure:
// no $ calls. The entry keeps the call in the air and the input waiting behind it, starts the call, and reads and
// writes state by the plans made here.
import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'

import type { Failure } from './backend.ts'
import type { Config } from './config.ts'
import type { Decision } from './log.ts'
import type { TurnState } from './state.ts'
import { clip } from './statebuild.ts'
import type { ProgressNote, StepRecord } from './statebuild.ts'

const SYSTEM = 'You keep a short progress note on a coding task. Reply with one JSON object and nothing else: {"done": string, "remaining": string, "cause_known": boolean}. "done" and "remaining" are one sentence each. Report only what the results show.'

/** Token budgets: the request and the latest result in the prompt, and each sentence of a note kept. */
const REQUEST_TOKENS = 400
const RESULT_TOKENS = 400
const NOTE_TOKENS = 60

export function progressPrompt(i: { request: string; previous: ProgressNote | null; latest: StepRecord }): { system: string; prompt: string } {
  const { did, tools, ok, result } = i.latest
  const prompt = JSON.stringify({
    request: clip(i.request, REQUEST_TOKENS),
    previous_note: i.previous,
    latest_step: { did, tools, outcome: ok ? 'ok' : 'error', result: clip(result, RESULT_TOKENS) },
  })
  return { system: SYSTEM, prompt }
}

/** The whole call (design 5.13): a cheap model at low effort, a small cap, bounded by the clock. */
export function progressRequest(cfg: Config, p: { system: string; prompt: string }): ModelCompleteRequest {
  return { model: cfg.progressNoteModel, system: p.system, prompt: p.prompt, effort: 'low', maxTokens: 200, timeoutMs: 8000 }
}

// Where the JSON object that opens at `start` closes (strings and their escapes skipped), or -1.
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

function firstObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start)
    if (end === -1) return null
    try {
      const v: unknown = JSON.parse(text.slice(start, end + 1))
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // not JSON from this brace: try the next one
    }
  }
  return null
}

/** The first JSON object in the reply, when it has all three fields of the right types; each sentence clipped. */
export function parseProgress(text: string): ProgressNote | null {
  const o = firstObject(text)
  if (o === null) return null
  const { done, remaining, cause_known } = o
  if (typeof done !== 'string' || typeof remaining !== 'string' || typeof cause_known !== 'boolean') return null
  return { done: clip(done, NOTE_TOKENS), remaining: clip(remaining, NOTE_TOKENS), cause_known }
}

/** What a settled call came to: a note, or why there is none (refused: the engine will not run this model). */
export type ProgressOutcome = { note: ProgressNote | null; refused: boolean; failure: Failure | null; detail: string }

/** A call in the air (settled false) or come back (settled true), for the turn and from the time it was started. */
export type ProgressFlight = { turnId: string; startedAt: number; settled: boolean } & ProgressOutcome

/** What one note is written from; previous_note is read from the turn when the call starts. */
export type ProgressInput = { turnId: string; request: string; latest: StepRecord }

const NOT_THREE = '回答不是三个字段'

/** Statuses by which the provider refuses the model itself: a call this session would be refused again. */
const REFUSING = [400, 403, 404]

/**
 * A settled call, read: `r` is what $.model.complete resolved, or null when it rejected (only a request the engine
 * refuses to send rejects: a blocked model, since the cap, effort and time limit here are always valid).
 */
export function readCompletion(r: ModelCompleteResult | null): ProgressOutcome {
  if (r === null) return { note: null, refused: true, failure: 'http', detail: '引擎拒绝了这个模型' }
  if (r.isAnswered) {
    const note = parseProgress(r.text)
    return note === null ? { note: null, refused: false, failure: 'bad-answer', detail: NOT_THREE } : { note, refused: false, failure: null, detail: '' }
  }
  if (r.reason === 'empty-reply') return { note: null, refused: false, failure: 'bad-answer', detail: NOT_THREE }
  // timeoutMs elapsed, or the turn whose hook started it was interrupted.
  if (r.reason === 'aborted') return { note: null, refused: false, failure: 'timeout', detail: '没有在时限内写完' }
  if (r.status === null) return { note: null, refused: false, failure: 'network', detail: '没有收到回答' }
  const refused = REFUSING.includes(r.status)
  return { note: null, refused, failure: 'http', detail: refused ? `模型被拒绝：HTTP ${r.status}` : `HTTP ${r.status}` }
}

/**
 * After a checkpoint (`fresh`: its input) or when a call has come back (`fresh` null): the call to start now, and
 * the input left waiting. One call at a time: while one is in the air only the newest input waits behind it.
 */
export function nextFlight(s: { on: boolean; blocked: boolean; busy: boolean; queued: ProgressInput | null; fresh: ProgressInput | null }): { start: ProgressInput | null; queue: ProgressInput | null } {
  if (!s.on || s.blocked) return { start: null, queue: null }
  const newest = s.fresh ?? s.queued
  return s.busy ? { start: null, queue: newest } : { start: newest, queue: null }
}

/**
 * A call that has come back, against the turn as it is now: the note to write on it, the Decision a failure records,
 * and whether the session stops calling. A call of a turn that has ended is dropped (it still blocks when refused:
 * the model is refused whatever the turn). A note that was written records nothing.
 */
export function settleFlight(
  f: ProgressFlight,
  turn: TurnState | null,
  c: { cfg: Config; id: string; at: number },
): { progress: ProgressNote | null; decision: Decision | null; block: boolean } {
  if (turn === null || turn.turnId !== f.turnId) return { progress: null, decision: null, block: f.refused }
  if (f.note !== null) return { progress: f.note, decision: null, block: false }
  const decision: Decision = {
    id: c.id,
    at: c.at,
    kind: 'progress',
    backend: null,
    model: c.cfg.progressNoteModel,
    // Read once the call was seen to settle, by the clock the hooks read: the .then that settles it cannot read it.
    ms: Math.max(0, c.at - f.startedAt),
    raw: null,
    from: null,
    to: null,
    reason: null,
    detail: f.detail,
    turnId: f.turnId,
    step: turn.journal.workSteps,
    bars: null,
    failure: f.failure,
    requestId: null,
    applied: false,
    sent: null,
  }
  return { progress: null, decision, block: f.refused }
}
