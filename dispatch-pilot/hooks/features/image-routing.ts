// Feature: image routing (#63, ADR 0008), the first half. When the person's message comes with reference images, its effort is
// decided from what the images read as, not from the words alone: how complex it is to build what they show.
//
// The switch is `image-routing` (`/dp image-routing on`), off by default: the images leave the machine for the decision model.
//
// The effort question of such a message is not in its ballot (features/main-effort.ts hands it to core/deferred.ts instead). It
// is decided in one of two ways (ADR 0019):
//   prompt.submit      Claude Code 2.1.316 on: `$.prompt.media` hands any `prompt.submit` hook the bytes of the message's images
//                      (after the engine's own resize; `attachedImages`). They are read (core/complexity.ts: a request to the
//                      decision model that takes images, at most ~3 s, a group asked only once), and the effort part goes in the
//                      message's ballot with the reading in its state, as any message's: the core sends it a moment later, in the
//                      same `prompt.submit`, and gives it what is left of the hook's room (`waitedMs`). A message typed into a
//                      running turn (#64) is decided this way too, before the step that delivers it.
//   turn.start         an engine before 2.1.316 refuses the read (`{ deny }`; so does the test kit, which has no implementation):
//                      the images are in the message's row when the engine appends it (`session.append`, door `prompt`; the row
//                      also names the file the original is in), so the decision waits for the turn:
//                        1. session.append  notes the message's images (their files, or their bytes when no file is named).
//                        2. turn.start      reads them, then sends the effort question with the reading in its state, and
//                                           writes the answer as a pending decision, which the core claims in this same
//                                           `turn.start`: the first step goes out at that effort. The core stays the one
//                                           writer of the plan (ADR 0003).
//                      A message typed into a running turn cannot wait for a turn to start: it is decided at once, on its words.
// Whatever goes wrong with the reading, the effort is decided without it; when the effort request fails, the turn goes out
// unrouted, and says why (the main-effort feature's report). A lock, and an effort or a model the person named, still come
// first: the plan table's priorities are not touched (core/plans.ts `planStep`).
//
// A picture the main agent reads in the middle of a turn decides nothing: a decision made then could land on a step of tool
// results, where a level no longer goes out (ADR 0013), while the board would show it.

import type { EngineInterface, HttpInit, On, PromptMedia, PromptMediaArgs } from 'claude-code'
import { type BackendIo, describeAsked, errorText, within } from '../decision/backend.ts'
import type { ReferenceReading } from '../decision/complexity.ts'
import { MIN_ASK_MS } from '../core/agent-lane.ts'
import { askGroups, type AskIo } from '../core/ask-group.ts'
import { CALL_ROOM_MS } from '../core/call-budget.ts'
import { readReferenceComplexity, type ComplexityIo, type ReferenceReadings, type ReferenceSource } from '../core/complexity.ts'
import { enteringPrompt } from '../core/core.ts'
import type { Cell } from '../core/plans.ts'
import { contribute } from '../core/ballot.ts'
import { isDeferred, takeDeferred } from '../core/deferred.ts'
import type { ImageFilesIo } from '../core/image-files.ts'
import { report, type NodeFailure, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'
import { newWorkFile } from '../core/work-files.ts'

/** The switch's name, in `/dp` and in the decision log. */
export const IMAGE_ROUTING_SWITCH = 'image-routing'

const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const
const READINGS = { plugin: 'dispatch-pilot', key: 'referenceReadings' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** How long the turn's start waits for the reading: the images prepared and the request answered (ADR 0008: about 3 seconds). */
const READING_WAIT_MS = 3000

/** Whether a prompt's attachments (`prompt.submit`'s `e.attachments`) include an image. */
export function hasImage(attachments: readonly { type: string }[] | undefined): boolean {
  return attachments?.some((attachment) => attachment.type === 'image') === true
}

// ---- The images of the message --------------------------------------------------------------------------------------

/** A message's images as its row carried them: the words (what the person typed) and the images to read. */
type Pasted = { text: string; sources: ReferenceSource[] }

/**
 * The latest messages' images, newest last (module level: the message's row comes in `session.append` and its turn starts a
 * moment later; a hot reload in between loses them, at the cost of that one message's reading). They are taken when the turn
 * starts, and a message that never starts a turn is pushed out by the next ones.
 */
const pasted: Pasted[] = []
const MOST_PASTED = 4

/** A pasted image's bytes are kept for a reading only up to this long (base64 characters): the file the row names is the better source. */
const MOST_BYTES = 12_000_000

/** A block of a row's content, as the engine appends it. */
export type Block = { type: string; [field: string]: unknown }

/**
 * The file a row names for an image the person pasted: the engine adds a text block, `[Image: source: <path> ...]`, with the
 * path of the original (before it was scaled to fit the model). Null for any other text.
 */
function sourceOf(text: string): string | null {
  return /\[Image: source: (\/[^\s\]]*?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))/i.exec(text)?.[1] ?? null
}

/** What the images of a user row come to: their files when the row names them, else their bytes. Null for a row with no image. */
export function pastedOf(content: readonly Block[]): Pasted | null {
  const images = content.filter((block) => block.type === 'image')
  if (images.length === 0) return null
  const texts = content.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
  const paths = texts.flatMap((text) => {
    const path = sourceOf(text)
    return path === null ? [] : [path]
  })
  const bytes = images.flatMap((block) => {
    const source = block.source as { data?: unknown } | undefined
    return typeof source?.data === 'string' && source.data.length <= MOST_BYTES ? [source.data] : []
  })
  const sources: ReferenceSource[] = paths.length > 0 ? paths.map((path) => ({ path })) : bytes.map((base64) => ({ base64 }))
  return { text: texts.filter((text) => !text.startsWith('[Image')).join('\n').trim(), sources }
}

/**
 * The images of the message the turn starts for (the latest one whose words are one of `texts`); they are taken. Null when no
 * message matches: the images of another message are not guessed at, the effort is decided without a reading.
 */
function takePasted(texts: readonly string[]): Pasted | null {
  const wanted = texts.map((text) => text.trim())
  let at = -1
  pasted.forEach((one, i) => {
    if (wanted.includes(one.text)) at = i
  })
  const found = pasted[at]
  pasted.length = 0
  return found ?? null
}

// ---- The images as the message is submitted (2.1.316 on) ----------------------------------------------------------------

/** What reads one slice of an attached item: `$.prompt.media`, as a closure. */
export type MediaRead = (args: PromptMediaArgs) => Promise<PromptMedia>

/**
 * The message's images as `prompt.submit` hands them: `ok` with their bytes, or why there are none. Unavailable (`ok: false`)
 * when the engine refuses a read (`{ deny }`: an engine before 2.1.316) or the read throws (the test kit has no implementation):
 * the images are then read from the message's row, as before. An image the engine could not process (`{ unreadable }`) or too big
 * to keep (`MOST_BYTES` of base64) is left out (`skipped`), the others still read.
 */
export type Attached = { ok: true; sources: ReferenceSource[]; skipped: number } | { ok: false; reason: string }

/** Reads every image of `attachments` through `read`, slice by slice (4 MiB a call, `next` goes on). Never throws. */
export async function attachedImages(read: MediaRead, attachments: readonly { type: string; id?: string }[]): Promise<Attached> {
  const sources: ReferenceSource[] = []
  let skipped = 0
  try {
    for (const attachment of attachments) {
      if (attachment.type !== 'image' || attachment.id === undefined) continue
      let base64 = ''
      let offset: number | undefined
      let kept = true
      for (;;) {
        const slice = await read(offset === undefined ? { id: attachment.id } : { id: attachment.id, offset })
        if (slice.deny !== undefined) return { ok: false, reason: `the engine refused its bytes (${slice.deny})` }
        if (slice.unreadable !== undefined) {
          kept = false
          break
        }
        base64 += slice.base64
        if (base64.length > MOST_BYTES) {
          kept = false
          break
        }
        if (slice.next === undefined) break
        offset = slice.next
      }
      if (kept && base64 !== '') sources.push({ base64 })
      else skipped++
    }
  } catch (error) {
    return { ok: false, reason: `its bytes could not be read (${errorText(error)})` }
  }
  return { ok: true, sources, skipped }
}

// ---- The engine, as closures -----------------------------------------------------------------------------------------

/** The files the images need of the engine, as closures. */
function filesOf($: EngineInterface): ImageFilesIo {
  return {
    run: (argv, init) => $.process.run(argv, init),
    readBytes: async (path) => (await $.fs.read(path, { as: 'bytes' })).base64,
    // The session's directory in the mod's temporary directory, like every file the mod makes (core/work-files.ts, #62).
    newFile: (extension) => newWorkFile({ run: (argv) => $.process.run(argv), tmpdir: () => $.env.get('TMPDIR'), sessionId: () => $.session.id() }, extension),
  }
}

export function registerImageRouting(on: On, ctx: Ctx): void {
  defineSwitch({ name: IMAGE_ROUTING_SWITCH, info: '带图路由：发消息带参考图时，先读出图的复杂度，再决定主 agent 的 effort（默认关，图会发给决策模型）', default: false })
  /** Whether images met now are to be read: the feature is on and there is an image backend. */
  const reading = () => isOn(IMAGE_ROUTING_SWITCH) && ctx.images !== null

  // The message as it is submitted (inside main-effort's hook, above the core's): when the engine hands over its images' bytes
  // (2.1.316 on), they are read now and its effort part goes in the ballot with the reading. Otherwise one typed into a running
  // turn goes in on its words, and one that starts a turn waits for it (below).
  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    if (!isDeferred(e.text)) return next(e)
    const debug = (line: string) => $.ui.log(line, { to: 'debug' })
    try {
      const startedAt = await $.clock.now()
      // Off since main-effort deferred it (or the whole mod): nothing is read; the part goes in on its words, the core decides whether to ask.
      const attached: Attached = reading() && masterOn() ? await attachedImages((args) => $.prompt.media(args), e.attachments ?? []) : { ok: false, reason: 'image routing is off' }
      if (attached.ok) {
        const taken = takeDeferred([e.text])
        if (taken !== null) {
          let read: ReferenceReading | null = null
          if (attached.sources.length === 0) debug(`image routing: none of the message's images could be read as submitted (${attached.skipped} left out); its effort is decided without a reading`)
          else {
            if (attached.skipped > 0) debug(`image routing: ${attached.skipped} of the message's images left out (unreadable or too big)`)
            read = await readReference(readIoOf($), ctx, attached.sources)
          }
          const waitedMs = (await $.clock.now()) - startedAt
          contribute(e.text, { ...taken.deferred(read, 'submit'), ...(waitedMs > 0 ? { waitedMs } : {}) })
        }
      } else if (e.turnId !== undefined) {
        debug(`image routing: ${attached.reason}; typed into a running turn, the message is decided on its words`)
        const taken = takeDeferred([e.text])
        if (taken !== null) contribute(e.text, taken.deferred(null, 'submit'))
      } else debug(`image routing: ${attached.reason}; the message is decided when its turn starts, from its row`)
    } catch (error) {
      debug(`image routing: ${errorText(error)}`)
      // Typed into a running turn, the part must not wait for a turn start that will not take it.
      const taken = e.turnId !== undefined ? takeDeferred([e.text]) : null
      if (taken !== null) contribute(e.text, taken.deferred(null, 'submit'))
    }
    return next(e)
  })

  // The message's row: its images are noted for the turn that starts next. Looked at only while the feature could use them,
  // and never changed. A message typed into a running turn (door `queue`) is not: it was decided at its submit.
  on('session.append', { door: /^prompt$/ }, async (_$, e, next) => {
    if (e.agentId !== undefined || e.message.type !== 'user' || !reading()) return next(e)
    const one = pastedOf(e.message.content as Block[])
    if (one === null) return next(e)
    pasted.push(one)
    if (pasted.length > MOST_PASTED) pasted.shift()
    return next(e)
  })

  // The main agent's turn starts: the message that came with images is decided now. Inside the core's `turn.start`, which claims
  // the decision written here.
  on('turn.start', { turnId: /(?:)/ }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const entering = enteringPrompt()
    const taken = takeDeferred(entering === undefined ? [e.text] : [entering, e.text])
    if (taken === null) return next(e)
    try {
      // Switched off (/dp off) since the message was sent: nothing is asked, the turn goes out as the engine made it.
      if (masterOn()) await decide($, ctx, taken, reading() ? takePasted([e.text, taken.prompt]) : null)
    } catch (error) {
      $.ui.log(`image routing: ${errorText(error)}`, { to: 'debug' })
    }
    return next(e)
  })

}

/** What a request to the decision model needs of the engine, as closures. */
function backendOf($: EngineInterface): BackendIo {
  return {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
    pace: { now: () => $.clock.now(), sentAt: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
  }
}

/** Everything a reading needs of the engine, as closures: `$` may not cross a file (DEVELOPMENT.md 「事件和 matcher」). */
export type ReadIo = {
  backend: BackendIo
  files: ImageFilesIo
  store: Cell<ReferenceReadings>
  now: () => Promise<number>
  debug: (line: string) => void
  /** A reading that failed, for the board's notes: beside the route, no toast. */
  note: (failure: NodeFailure) => Promise<void>
}

/**
 * What the reference images `sources` read as: asked of the image backend (a group read before is answered from the readings
 * kept), within `READING_WAIT_MS`. Null when there is no reading: no image backend, the images could not be read, the request
 * failed or came too late; the board notes a failed one, beside the route and without a toast. Never throws.
 */
export async function readReference(io: ReadIo, ctx: Ctx, sources: readonly ReferenceSource[]): Promise<ReferenceReading | null> {
  const images = ctx.images
  if (images === null || sources.length === 0) return null
  try {
    const complexity: ComplexityIo = {
      files: io.files,
      ask: async (request) => {
        const at = await io.now()
        const asked = await images.backend.ask(io.backend, request, READING_WAIT_MS)
        io.debug(`complexity reading [${Object.keys(request.questions).join(', ')}] to ${images.backend.name}: ${describeAsked(asked, (await io.now()) - at)}`)
        return asked
      },
      store: io.store,
      now: io.now,
      backend: images.name,
      debug: io.debug,
    }
    const late = { late: true } as const
    const read = await within(io.backend.sleep, readReferenceComplexity(complexity, sources), READING_WAIT_MS, late)
    if ('late' in read) {
      io.debug(`image routing: no reading in ${READING_WAIT_MS} ms; the effort is decided without it`)
      await io.note({ backend: images.name, kind: 'timeout', detail: `no reading in ${READING_WAIT_MS} ms` })
      return null
    }
    if (read.ok) {
      io.debug(`image routing: the images read as level ${read.reading.level} (${read.cached ? 'read before' : 'asked'}), from ${read.reading.images} image${read.reading.images === 1 ? '' : 's'}`)
      return read.reading
    }
    io.debug(`image routing: no reading (${read.reason}); the effort is decided without it`)
    if (read.failure !== undefined) await io.note({ backend: images.name, ...read.failure })
    return null
  } catch (error) {
    io.debug(`image routing: ${errorText(error)}`)
    return null
  }
}

/** What a reading needs of the engine, from this file's hooks. */
function readIoOf($: EngineInterface): ReadIo {
  return {
    backend: backendOf($),
    files: filesOf($),
    store: { get: () => $.state.get(READINGS), set: (value: ReferenceReadings, options) => $.state.set(READINGS, value, options) },
    now: () => $.clock.now(),
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    note: (failure) => note($, failure),
  }
}

/** The message's effort, decided with the reading of its images (`found`; null: the feature was switched off meanwhile) when there is one. */
async function decide($: EngineInterface, ctx: Ctx, taken: NonNullable<ReturnType<typeof takeDeferred>>, found: Pasted | null): Promise<void> {
  const debug = (line: string) => $.ui.log(line, { to: 'debug' })
  const backend = backendOf($)
  const startedAt = await $.clock.now()
  let reading: ReferenceReading | null = null
  // Off since the message was sent: it is decided as any message is, without its images.
  if (ctx.images !== null && isOn(IMAGE_ROUTING_SWITCH)) {
    if (found === null || found.sources.length === 0) debug('image routing: the message came with images, but none was found to read; its effort is decided without a reading')
    else reading = await readReference(readIoOf($), ctx, found.sources)
  }
  // The effort question, as a message's ever is: the reading is in its state. Its answer is written as the pending decision.
  const messages = ctx.config.context.messages > 0 ? await $.session.messages().catch(() => []) : []
  const spent = (await $.clock.now()) - startedAt
  const io: AskIo = { backend, now: () => $.clock.now(), debug }
  // A `$.clock.sleep` counts toward the hook's 10 s: the effort request waits for what is left of the call room, never longer than the decision model's own setting.
  await askGroups(io, ctx, { prompt: taken.prompt, messages, groups: [[taken.deferred(reading, 'turn-start')]], maxWaitMs: Math.max(MIN_ASK_MS, CALL_ROOM_MS - spent) })
}

/** A reading that failed, for the board's notes: beside the route, no toast (the effort is decided all the same). */
async function note($: EngineInterface, failure: NodeFailure): Promise<void> {
  const io: ReportIo = {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
  }
  await report(io, { decision: { feature: IMAGE_ROUTING_SWITCH, agent: 'main', aside: true, failure } })
}
