import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, Register, TurnStepInput } from 'claude-code'

import { ask } from './backend.ts'
import type { Answer, AskResult, Io, Miss } from './backend.ts'
import { readConfig } from './config.ts'
import type { Config } from './config.ts'
import { readNoul, submitLevel, thresholdsFor } from './decide.ts'
import { isLevel } from './levels.ts'
import type { Level } from './levels.ts'
import { DP_USAGE, RECENT_KEEP, badLevelReply, decisionId, lockReply, parseDp, pushLog, readLog, renderDp, renderLog, unlockReply } from './log.ts'
import type { Decision } from './log.ts'
import { submitQuestions } from './questions.ts'
import type { Question } from './questions.ts'
import { emptySession, newTurn } from './state.ts'
import type { SessionState, TurnState } from './state.ts'
import { clip, submitState } from './statebuild.ts'
import type { PreviousTurn } from './statebuild.ts'

// $.state, through the state library: a read of a key never written gives the initial, and update()
// writes with compare-and-set and tries again on a miss. So no key needs initialising: session.start,
// which fires again on every hot reload and plugin enable, only refreshes session.surfaces, and an
// existing session (its lock), turn, recent or skills stays as it was.
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])

/** $.store key of the decision log, shared by every session on this machine. */
const LOG = 'log'

/** Where a message a person sent comes from: only these are judged when sent (design 5.3). */
const PERSON: readonly string[] = ['composer', 'sdk', 'bridge']

/** How much of the last answer the next message's judgement sees of it. */
const LAST_REPLY_TOKENS = 300

// One line in the debug log for an error the mod swallowed: the hook and the error's message, never
// state or message content. A log call that throws itself is swallowed too.
function trace($: EngineInterface, hook: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err)
    $.ui.log(`${hook} failed open: ${message.slice(0, 200)}`, { to: 'debug' })
  } catch {
    // fail open
  }
}

// The catch-all every hook decides inside: a throw anywhere in `decide` hands back `unchanged`, and
// the hook passes that on with next(...) outside the try, so it always reaches next and never calls it
// twice. Every failure fails open, and leaves a line in the debug log.
async function failOpen<T>($: EngineInterface, hook: string, unchanged: T, decide: () => Promise<T>): Promise<T> {
  try {
    return await decide()
  } catch (err) {
    trace($, hook, err)
    return unchanged
  }
}

/** The I/O backend.ts asks through; it never touches $ itself. */
export function ioOf($: EngineInterface): Io {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    now: () => $.clock.now(),
  }
}

// $.store has no compare-and-set, so this process's writes to the log go through one chain: two
// decisions recorded at once would otherwise read the same log and the later write would drop the
// other. A hot reload starts a new chain; what that costs is at most an entry written in that instant.
let logWrites: Promise<void> = Promise.resolve()

async function appendLog($: EngineInterface, d: Decision): Promise<void> {
  try {
    // Other sessions on the machine write here too: nothing is awaited between the read and the
    // write, so another session's write can only be lost in that one gap.
    const held = await $.store.get(LOG)
    await $.store.set(LOG, pushLog(readLog(held), d))
  } catch (err) {
    trace($, 'record', err)
  }
}

/** Appends a decision to $.store's log and to this session's recent. Never throws. */
export async function record($: EngineInterface, d: Decision): Promise<void> {
  // Each write fails on its own: losing one copy must not lose the other.
  try {
    await update($, RECENT, (list) => pushLog(list, d, RECENT_KEEP))
  } catch (err) {
    trace($, 'record', err)
  }
  const mine = logWrites.then(() => appendLog($, d))
  logWrites = mine
  await mine
}

const shown = (text: string): CommandRunResult => ({ text, isTextDisplayOnly: true })

async function answerDp($: EngineInterface, cfg: Config, args: string): Promise<CommandRunResult> {
  const c = parseDp(args)
  if (c.kind === 'show') {
    const session = await read($, SESSION)
    const turn = await read($, TURN)
    const wanted = turn?.wanted ?? turn?.base ?? null
    return shown(renderDp({ cfg, wanted, lastSent: session.lastSent, lock: session.lock, log: await read($, RECENT) }))
  }
  if (c.kind === 'lock') {
    await update($, SESSION, (s) => ({ ...s, lock: c.level }))
    return shown(lockReply(c.level, cfg))
  }
  if (c.kind === 'unlock') {
    const was = (await read($, SESSION)).lock
    if (was !== null) await update($, SESSION, (s) => ({ ...s, lock: null }))
    return shown(unlockReply(was))
  }
  if (c.kind === 'log') {
    const held = await $.store.get(LOG).then(
      (v) => readLog(v),
      () => null,
    )
    return shown(held === null ? '读不到决策记录（$.store 出错了）。' : renderLog(held, c.n))
  }
  if (c.kind === 'bad-level') return shown(badLevelReply(c.word))
  return shown(DP_USAGE)
}

// The judgement when a person sends a message. The level itself is settled at the turn's first step,
// which is the first place the session's own effort can be read.
async function judgeMessage($: EngineInterface, cfg: Config, text: string, origin: string | undefined): Promise<null> {
  if (!cfg.enabled || !cfg.submitShift || origin === undefined || !PERSON.includes(origin)) return null
  const session = await read($, SESSION)
  if (session.lock !== null) return null
  // Every question this message is asked goes into the one map and the one request; each part then
  // reads the answers it needs from the one result (the effort: open, mechanical, unknown_cause, continues).
  const questions: Record<string, Question> = { ...submitQuestions(session.previous !== null) }
  const state = submitState({ request: text, previous: session.previous })
  const result = await ask(ioOf($), cfg, { state, questions }, cfg.submitTimeoutMs)
  await update($, SESSION, (s) => ({ ...s, pending: { request: text, result } }))
  return null
}

const BACKEND_NAME = { drex: 'Drex', jev: 'Jev' } as const

function missText(m: Miss): string {
  const b = BACKEND_NAME[m.backend]
  if (m.reason === 'no-key') return `${b} 没有密钥`
  if (m.reason === 'timeout') return `${b} 没有在时限内回答`
  if (m.reason === 'http') return m.status === undefined ? `${b} 的请求失败` : `${b} 回答 HTTP ${m.status}`
  if (m.reason === 'network') return `连不上 ${b}`
  if (m.reason === 'bad-answer') return `${b} 的回答缺题或类型不对`
  return `${b} 回答的模型不是固定的版本`
}

const NO_LEVEL = 'effort 缺省或是数字，没有改'

const noulOf = (a: Answer | undefined): number | undefined => (a?.type === 'noul' ? a.noul : undefined)
const scoreOf = (a: Answer | undefined): readonly number[] => (a?.type === 'score' ? a.probabilities : [])

type Settled = { base: Level | null; wanted: Level | null; decision: Decision }

// What a message's answers make of its turn: the level it starts from, the level the mod wants, and
// the Decision that records both. Pure. `writes`: the mod would write a level (apply mode, no lock).
function settle(
  r: AskResult,
  c: { effort: unknown; previousLevel: Level | null; writes: boolean; turnId: string; id: string; at: number },
): Settled {
  const own = isLevel(c.effort) ? c.effort : null
  const common = { id: c.id, at: c.at, kind: 'submit' as const, backend: r.backend, ms: r.ms, turnId: c.turnId, step: 0, sent: null }
  if (!r.ok) {
    // A failed request changes nothing: the turn runs at the session's own level.
    const detail = r.firstFailure ? `${missText(r.firstFailure)}；${missText(r)}` : missText(r)
    const decision: Decision = { ...common, model: null, raw: null, from: own, to: own, reason: null, detail, bars: null, failure: r.reason, requestId: r.requestId ?? null, applied: false }
    return { base: own, wanted: null, decision }
  }
  if (own === null) {
    // Answers came, but the step has no level to start from or to replace.
    const decision: Decision = { ...common, model: r.model, raw: r.answers, from: null, to: null, reason: null, detail: NO_LEVEL, bars: null, failure: null, requestId: null, applied: false }
    return { base: null, wanted: null, decision }
  }
  const bars = thresholdsFor(r.backend, r.model, 'submit')
  // "Go on" carries the last turn's level; anything else starts from the session's.
  const continues = readNoul(noulOf(r.answers.continues), bars) === 'yes'
  const base = continues && c.previousLevel !== null ? c.previousLevel : own
  const v = submitLevel(base, { open: scoreOf(r.answers.open), mechanical: noulOf(r.answers.mechanical), unknownCause: noulOf(r.answers.unknown_cause) }, bars)
  const decision: Decision = { ...common, model: r.model, raw: r.answers, from: base, to: v.level, reason: v.reason, detail: '', bars, failure: null, requestId: null, applied: c.writes }
  return { base, wanted: v.level, decision }
}

// The turn's first step takes the decision its message left, once: it is cleared whatever comes of it.
async function takePending($: EngineInterface, cfg: Config, e: TurnStepInput, session: SessionState, own: TurnState | null): Promise<TurnState | null> {
  const pending = session.pending
  if (pending === null) return own
  await update($, SESSION, (s) => ({ ...s, pending: null }))
  const at = await $.clock.now()
  const writes = cfg.enabled && cfg.mode === 'apply' && session.lock === null
  const s = settle(pending.result, { effort: e.effort, previousLevel: session.previous?.level ?? null, writes, turnId: e.turnId, id: decisionId(at), at })
  const turn: TurnState = { ...(own ?? newTurn(e.turnId, pending.request)), base: s.base, wanted: s.wanted }
  await update($, TURN, () => turn)
  await record($, s.decision)
  return turn
}

// The main loop's branch of turn.step. Returns the step as it goes on.
async function mainStep($: EngineInterface, cfg: Config, e: TurnStepInput): Promise<TurnStepInput> {
  // Agents' steps (e.agentId set) are left as they come; they get their own branch later.
  if (e.agentId !== undefined) return e
  const session = await read($, SESSION)
  const held = await read($, TURN)
  let turn = held !== null && held.turnId === e.turnId ? held : null
  // takePending hands back the turn it wrote, so nothing is read back.
  if (e.index === 0) turn = await takePending($, cfg, e, session, turn)
  // A step whose effort is absent (the model takes none) or a number (the session uses numeric
  // effort) passes as it came; so does every step while the mod is off or only watching.
  if (!isLevel(e.effort) || !cfg.enabled || cfg.mode === 'shadow') return e
  // Only effort is written: the main loop's model is never changed (it would break the prompt cache).
  const level = session.lock ?? turn?.wanted ?? null
  return level === null ? e : { ...e, effort: level }
}

function endedOf(e: { reason: string; isAborted: boolean }): PreviousTurn['ended'] {
  if (e.isAborted || e.reason === 'aborted') return 'interrupted'
  return e.reason === 'answer' ? 'answered' : 'error'
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await failOpen($, 'session.start', null, async () => {
      await $.command.register({
        name: 'dp',
        description: 'dispatch-pilot：档位、锁定、后端和最近的决策（lock <档位>、unlock、log [n]）',
        argumentHint: '[lock <档位> | unlock | log [n]]',
      })
      return null
    })
    await failOpen($, 'session.start', null, async () => {
      const surfaces = [...(await $.session.surfaces())]
      // Only the surfaces are refreshed: a reload keeps the lock and everything else.
      await update($, SESSION, (s) => ({ ...s, surfaces }))
      return null
    })
    return next(e)
  })

  on('command.run', { command: 'dp' }, async ($, e, next) => {
    const answer = await failOpen($, 'command.run', null, () => answerDp($, cfg, e.args))
    return answer ?? next(e)
  })

  // The person is waiting for the message to go in: the one ask() is the only wait here.
  on('prompt.submit', async ($, e, next) => {
    await failOpen($, 'prompt.submit', null, () => judgeMessage($, cfg, e.text, e.origin?.kind))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await failOpen($, 'turn.start', null, async () => {
      // A subagent's turns are its own: the main loop's turn is not touched by them.
      if (e.agentId !== undefined) return null
      // The message's decision stays pending: the first step takes it, once the effort is known.
      await update($, TURN, () => newTurn(e.turnId, e.text))
      return null
    })
    return next(e)
  })

  // The one turn.step hook (no matcher may be registered twice): the main loop's branch here, agents'
  // (e.agentId set) in a later task.
  on('turn.step', async function* ($, e, next) {
    const out = await failOpen($, 'turn.step', e, () => mainStep($, cfg, e))
    return yield* next(out)
  })

  on('turn.complete', async ($, e, next) => {
    await failOpen($, 'turn.complete', null, async () => {
      if (e.agentId !== undefined) return null
      const held = await read($, TURN)
      const turn = held !== null && held.turnId === e.turnId ? held : null
      const previous: PreviousTurn = {
        request: turn?.request ?? '',
        lastReply: clip(e.answer, LAST_REPLY_TOKENS),
        ended: endedOf(e),
        level: turn ? (turn.wanted ?? turn.base) : null,
      }
      await update($, SESSION, (s) => ({ ...s, previous }))
      await update($, TURN, () => null)
      return null
    })
    return next(e)
  })
}
