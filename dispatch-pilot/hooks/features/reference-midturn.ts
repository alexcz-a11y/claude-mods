// Feature: image routing, the second half (#64, ADR 0008). The first half (features/image-routing.ts) reads the reference images a
// message comes with before its turn's first effort. Here the main agent meets reference images in the middle of a turn, and
// the effort is judged again, with what they read as:
//   - a Read of a picture file that was there before the loop began (a design the person pointed it at, a photo they pasted
//     earlier): not one the agent made itself in this loop, a screenshot or a frame it rendered, which is not a reference;
//   - a message with images the person types into the running turn.
// Either way the images are read first (a request to the image backend; a group read before is answered from the readings kept),
// and the re-decision goes out the moment the reading is in, for the next step (features/midturn-effort.ts
// `judgeAgainWithReference`). Its answer is taken as any re-decision's: before the next step goes out, by the same thresholds,
// debounce, floor and lock. Whatever goes wrong with the reading, the re-decision is asked without it.
//
// The switch is `image-routing` (off by default: the images leave the machine), and the re-decision is the mid-turn feature's,
// so it needs `midturn-effort` on too. With the first off, nothing here does anything.

import type { EngineInterface, HttpInit, On } from 'claude-code'
import { errorText, type BackendIo } from '../decision/backend.ts'
import { keepNewest } from '../decision/keep-newest.ts'
import type { ReferenceReadings } from '../core/complexity.ts'
import type { ImageFilesIo } from '../core/image-files.ts'
import { startedBefore } from '../core/loop-start.ts'
import { MAIN, update, type Cell } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { report, type NodeFailure, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { isOn, masterOn } from '../core/switches.ts'
import { newWorkFile } from '../core/work-files.ts'
import { type Block, hasImage, IMAGE_ROUTING_SWITCH, pastedOf, readReference, type ReadIo } from './image-routing.ts'
import { askedFor, judgeAgainWithReference, type LaunchIo, type MidturnRecord } from './midturn-effort.ts'
import { UNRESOLVED_SWITCH } from './unresolved.ts'

const LOOPS = { plugin: 'dispatch-pilot', key: 'loops' } as const
const MAIN_STEP = { plugin: 'dispatch-pilot', key: 'mainStep' } as const
const READINGS = { plugin: 'dispatch-pilot', key: 'referenceReadings' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const MIDTURN = { plugin: 'dispatch-pilot', key: 'midturn' } as const
const FAILURES = { plugin: 'dispatch-pilot', key: 'escalation', id: MAIN } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const

/**
 * The messages with images typed into a running turn, by their words, with the turn they were typed into (module level: the
 * message's row comes in `session.append` a moment after `prompt.submit`; a hot reload in between loses the reading of that one
 * message). One the engine refuses beneath is taken back out; the most recent few are kept.
 */
const typedIn = new Map<string, string>()
const MOST_TYPED = 8

export function registerReferenceMidturn(on: On, ctx: Ctx): void {
  /** Whether images met now are to be read: the feature is on and there is an image backend. */
  const reading = () => masterOn() && isOn(IMAGE_ROUTING_SWITCH) && ctx.images !== null

  // A Read of a picture. By the time the call returns, the mid-turn feature (beneath) has recorded it in the turn's steps.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e)
    // The main agent's own calls only, as the mid-turn feature's: its dispatched agents' are theirs.
    if (e.agentId !== undefined || next.origin.plugin !== 'engine' || !reading() || result.deny !== undefined || result.isError === true) return result
    try {
      const read = result.result as { type?: unknown } | undefined
      const path: unknown = e.file_path
      if (read?.type !== 'image' || typeof path !== 'string') return result
      const [started, modified] = await Promise.all([$.state.get({ ...LOOPS, id: MAIN }), $.fs.stat(path).catch(() => null)])
      // Made in this loop (or no way to tell when the loop began): the agent's own picture, not a reference.
      if (modified === null || started.value === undefined || !startedBefore(modified.mtimeMs, started.value.startedAt)) return result
      await judgeAgainWithReference(launchIoOf($), ctx, () => readReference(readIoOf($), ctx, [{ path }]), '读到参考图')
    } catch (error) {
      $.ui.log(`reference images: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })

  // A message with images typed while a turn runs: `prompt.submit` says so (and what the turn is), its row, which has the images,
  // comes a moment after.
  on('prompt.submit', { text: /(?:)/ }, async (_$, e, next) => {
    const typed = e.turnId !== undefined && isPersonsMessage(e) && hasImage(e.attachments) && reading()
    if (typed) {
      typedIn.delete(e.text.trim())
      typedIn.set(e.text.trim(), e.turnId as string)
      keepNewest(typedIn, MOST_TYPED)
    }
    const result = await next(e)
    if (typed && result.drop !== undefined) typedIn.delete(e.text.trim())
    return result
  })

  on('session.append', { door: /^(?:prompt|queue)$/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.message.type !== 'user' || typedIn.size === 0 || !reading()) return result
    try {
      const row = pastedOf(e.message.content as Block[])
      const turnId = row === null ? undefined : typedIn.get(row.text)
      if (row === null || turnId === undefined) return result
      typedIn.delete(row.text)
      // The turn it was typed into must still be the one running.
      const step = (await $.state.get(MAIN_STEP)).value ?? null
      if (step === null || step.turnId !== turnId || row.sources.length === 0) return result
      await judgeAgainWithReference(launchIoOf($), ctx, () => readReference(readIoOf($), ctx, row.sources), '轮中贴了参考图')
    } catch (error) {
      $.ui.log(`reference images: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })
}

/** What a request to the decision model needs of the engine, as closures (`$` may not cross a file, so this file builds its own). */
function backendOf($: EngineInterface): BackendIo {
  return {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
    pace: { now: () => $.clock.now(), sentAt: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
  }
}

/** What a reading of the pictures needs of the engine (features/image-routing.ts `ReadIo`). */
function readIoOf($: EngineInterface): ReadIo {
  const files: ImageFilesIo = {
    run: (argv, init) => $.process.run(argv, init),
    readBytes: async (path) => (await $.fs.read(path, { as: 'bytes' })).base64,
    newFile: (extension) => newWorkFile({ run: (argv) => $.process.run(argv), tmpdir: () => $.env.get('TMPDIR'), sessionId: () => $.session.id() }, extension),
  }
  const reporting: ReportIo = {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
  }
  return {
    backend: backendOf($),
    files,
    store: { get: () => $.state.get(READINGS), set: (value: ReferenceReadings, options) => $.state.set(READINGS, value, options) },
    now: () => $.clock.now(),
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    note: (failure: NodeFailure) => report(reporting, { decision: { feature: IMAGE_ROUTING_SWITCH, agent: 'main', aside: true, failure } }),
  }
}

/** What a re-decision needs of the engine (features/midturn-effort.ts `LaunchIo`). */
function launchIoOf($: EngineInterface): LaunchIo {
  return {
    backend: backendOf($),
    now: () => $.clock.now(),
    mainStep: async () => (await $.state.get(MAIN_STEP)).value ?? null,
    state: async (key) => {
      const [{ value: turn }, { value: record }, { value: lock = null }, { value: failures }, { value: held }] = await Promise.all([
        $.state.get({ ...TURNS, id: key }),
        $.state.get({ ...MIDTURN, id: key }),
        $.state.get(LOCK),
        $.state.get(FAILURES),
        isOn(UNRESOLVED_SWITCH) ? $.state.get(COUNT) : Promise.resolve({ value: undefined }),
      ])
      return { turn, record, lock, failures, held }
    },
    asked: async (key, upcoming) => {
      const ref = { ...MIDTURN, id: key }
      const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
      await update(cell, (r) => askedFor(r, upcoming))
    },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
  }
}
