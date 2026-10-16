// What the skill profiles' events (features/skill-profiles.ts) come to, for the 「决定汇报」 module (core/report.ts,
// `report`'s `profiles`): the events, the state they add up to, the debug line of each and the decision log entry the
// state ends in. Pure data and functions: the module keeps the state and writes the log (see report.ts: `$` stays in the
// hook owner's file).

import type { LogEntry } from './report.ts'

/** Why writing the profiles stopped for the session (types/index.d.ts, `skillProfiles.stop`). */
type ProfilesStopReason = 'store-read' | 'model-refused' | 'api-error' | 'store-write' | 'off' | 'error'

/** How writing the session's skill profiles went (#33; types/index.d.ts, `skillProfiles`). */
export type ProfilesState = {
  phase: 'writing' | 'done' | 'stopped'
  /** The turn the session start belongs to: the turn of its decision log entry. */
  turn: number
  model: string
  kept: number
  planned: number
  written: number
  failed: number
  deferred: number
  stop?: { reason: ProfilesStopReason; detail: string }
  failures: { name: string; reason: string }[]
}

/** The failed skills the state names; `failed` still counts every one. */
const PROFILES_FAILURES_KEPT = 50

/** Why the writing stopped, with what the debug line and the state say of it. */
export type ProfilesStop =
  | { reason: 'model-refused'; model: string; detail: string }
  | { reason: 'api-error'; skill: string; why: string; ms: number }
  | { reason: 'store-write'; skill: string; detail: string }
  | { reason: 'off' }
  | { reason: 'error'; detail: string }

/**
 * What happens as the skill profiles are written (features/skill-profiles.ts), in the order it happens. `left`:
 * the skills lacking a profile that this session did not get to.
 */
export type ProfileEvent =
  /** The session start has read the catalog: `offered` skills can have one, `due` of them lack one; at most `perSession` are written. */
  | { event: 'start'; model: string; perSession: number; offered: number; due: number }
  /** The store cannot be read: nothing is kept or written. */
  | { event: 'unreadable'; model: string; offered: number }
  /** Another session wrote the profile meanwhile: it is kept. */
  | { event: 'found' }
  | { event: 'written'; skill: string; model: string; ms: number; input: number; output: number }
  /** The model gave no profile for the skill (`why`: the reply's reason); the writing goes on. */
  | { event: 'failed'; skill: string; why: string; ms: number }
  /** The reply for the skill is no profile; the writing goes on. */
  | { event: 'unfit'; skill: string; ms: number; text: string }
  /** The session's most is written; `left` is what no longer fits (the debug line counts what is not written, failed included). */
  | { event: 'quota'; perSession: number; left: number }
  /** The loop is over, as it should be. */
  | { event: 'finish'; left: number }
  | { event: 'stop'; cause: ProfilesStop; left: number }
  /** The store's oldest profiles were dropped (`total` kept before, `kb` of them). */
  | { event: 'tidied'; dropped: number; total: number; kb: number }
  | { event: 'tidy-failed'; detail: string }

/** The debug log's line for an event; null when it has none. */
export function profilesLine(event: ProfileEvent): string | null {
  switch (event.event) {
    case 'start':
      return `skill profiles: ${event.offered - event.due} kept, ${event.due} to write with ${event.model} (at most ${event.perSession} this session)`
    case 'unreadable':
      return 'skill profiles: the store cannot be read, so no profile is kept or written; skills are rated by their descriptions'
    case 'found':
      return null
    case 'written':
      return `skill profile written for ${event.skill} by ${event.model} in ${event.ms} ms (${event.input} input, ${event.output} output tokens)`
    case 'failed':
      return `skill profiles: no profile for ${event.skill} (${event.why}, ${event.ms} ms)`
    case 'unfit':
      return `skill profiles: the reply for ${event.skill} is not a profile (${event.ms} ms): ${JSON.stringify(event.text.slice(0, 80))}`
    case 'quota':
      return `skill profiles: ${event.left} left to write at a later session start (at most ${event.perSession} each)`
    case 'finish':
      return null
    case 'stop': {
      const cause = event.cause
      const more = 'no more profiles are written this session'
      if (cause.reason === 'model-refused') return `skill profiles: ${cause.model} was refused (${cause.detail}); ${more}`
      if (cause.reason === 'api-error') return `skill profiles: no profile for ${cause.skill} (${cause.why}, ${cause.ms} ms); ${more}`
      if (cause.reason === 'store-write') return `skill profiles: the store did not keep the profile of ${cause.skill} (${cause.detail}); ${more}`
      if (cause.reason === 'error') return `skill profiles: stopped writing (${cause.detail})`
      return null
    }
    case 'tidied':
      return `skill profiles: dropped the ${event.dropped} oldest of ${event.total} kept (${event.kb} KB)`
    case 'tidy-failed':
      return `skill profiles: could not tidy the store (${event.detail})`
  }
}

/** The state a session start begins with. Nothing to write (or no store to keep it): it is over at once. */
export function profilesBegin(event: Extract<ProfileEvent, { event: 'start' | 'unreadable' }>, turn: number): ProfilesState {
  if (event.event === 'unreadable') {
    return { phase: 'stopped', turn, model: event.model, kept: 0, planned: 0, written: 0, failed: 0, deferred: event.offered, stop: { reason: 'store-read', detail: '' }, failures: [] }
  }
  const planned = event.due > 0 ? Math.max(0, Math.min(event.due, event.perSession)) : 0
  return { phase: planned > 0 ? 'writing' : 'done', turn, model: event.model, kept: event.offered - event.due, planned, written: 0, failed: 0, deferred: event.due - planned, failures: [] }
}

/**
 * What the model's reply for a skill said it failed with (the engine's reason, as the feature words it), in the
 * person's words: `empty-reply`, `an API error, HTTP 529 overloaded`. What the server said of itself stays as it
 * said it; anything this does not know is left as it is.
 */
function profileWhy(why: string): string {
  if (why === 'empty-reply') return '模型回了空内容'
  if (why === 'aborted') return '请求被中断'
  const api = /^an API error, HTTP (\S+)(?: (.*))?$/.exec(why)
  if (api !== null) return `接口出错（状态码 ${api[1]}${api[2] === undefined || api[2] === '' ? '' : ` ${api[2]}`}）`
  return why
}

/** The state after an event that comes while the profiles are being written; the same state (`===`) when the event changes nothing. */
export function profilesAdvance(state: ProfilesState, event: ProfileEvent): ProfilesState {
  switch (event.event) {
    case 'found':
      return { ...state, kept: state.kept + 1 }
    case 'written':
      return { ...state, written: state.written + 1 }
    case 'failed':
    case 'unfit': {
      const reason = event.event === 'failed' ? profileWhy(event.why) : '回复不是画像'
      const failures = state.failures.length < PROFILES_FAILURES_KEPT ? [...state.failures, { name: event.skill, reason }] : state.failures
      return { ...state, failed: state.failed + 1, failures }
    }
    case 'finish':
      return { ...state, phase: 'done', deferred: event.left }
    case 'stop': {
      const cause = event.cause
      const detail = cause.reason === 'api-error' ? profileWhy(cause.why) : cause.reason === 'store-write' ? `${cause.skill}：${cause.detail}` : cause.reason === 'off' ? '' : cause.detail
      return { ...state, phase: 'stopped', deferred: event.left, stop: { reason: cause.reason, detail } }
    }
    default:
      return state
  }
}

/** How many failed skills the entry's reason names. */
const PROFILES_NAMED = 3

/** The session's one decision log entry for a state the writing has ended in. */
export function profilesEntry(state: ProfilesState): Omit<LogEntry, 'n'> {
  const stopped = state.phase === 'stopped'
  const counts = [`保留 ${state.kept}`, `新写 ${state.written}`, ...(state.failed > 0 ? [`失败 ${state.failed}`] : []), ...(state.deferred > 0 ? [`延后 ${state.deferred}`] : [])].join(' · ')
  const named = state.failures.slice(0, PROFILES_NAMED).map((failure) => `${failure.name}：${failure.reason}`)
  const failed = state.failed > 0 ? `（${named.join('；')}${state.failed > named.length ? `；另有 ${state.failed - named.length} 个` : ''}）` : ''
  const stop = state.stop
  const why =
    stop === undefined
      ? ''
      : stop.reason === 'store-read'
        ? '读不到本地存储，不保留也不写'
        : stop.reason === 'model-refused'
          ? `引擎拒绝了 ${state.model}（${stop.detail}）`
          : stop.reason === 'api-error'
            ? `${state.model} 返回了接口错误：${stop.detail}`
            : stop.reason === 'store-write'
              ? `本地存储存不下画像（${stop.detail}）`
              : stop.reason === 'off'
                ? '写的过程中被关掉了'
                : `出错了（${stop.detail}）`
  return {
    turn: state.turn,
    feature: 'skill-profiles',
    tone: stopped ? (stop?.reason === 'off' ? 'info' : 'fail') : state.failed > 0 ? 'warn' : 'ok',
    outcome: stopped ? '画像停写' : state.failed > 0 ? `画像：${state.failed} 个失败` : '画像就绪',
    subject: '',
    reason: `${stopped ? `${why}；` : ''}${counts}${failed}`,
  }
}
