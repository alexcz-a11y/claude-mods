// Feature: image routing (#63, ADR 0008), the first half. When the person's message comes with reference images, its effort is
// decided from what the images read as, not from the words alone: how complex it is to build what they show.
//
// The switch is `image-routing` (`/dp image-routing on`), off by default: the images leave the machine for the decision model.
//
// The effort question of such a message is not in its ballot (features/main-effort.ts hands it to core/deferred.ts instead). The
// images are not in `prompt.submit` (it carries their metadata only), they are in the message's row when the engine appends it
// (`session.append`, door `prompt`; the row also names the file the original is in). So the decision waits for the turn:
//   1. session.append  notes the message's images (their files, or their bytes when no file is named), not the whole conversation.
//   2. turn.start      reads the images (core/complexity.ts: a request to the decision model that takes images, at most ~3 s, a
//                      group asked only once), then sends the effort question with the reading in its state, as any message's,
//                      and writes the answer as a pending decision, which the core claims in this same `turn.start`: the first
//                      step goes out at that effort. The core stays the one writer of the plan (ADR 0003).
// Whatever goes wrong with the reading, the effort is decided without it; when the effort request fails, the turn goes out
// unrouted, and says why (the main-effort feature's report). A lock, and an effort or a model the person named, still come
// first: the plan table's priorities are not touched (core/plans.ts `planStep`).

import type { EngineInterface, HttpInit, On } from 'claude-code'
import { type BackendIo, describeAsked, errorText, within } from '../decision/backend.ts'
import type { ReferenceReading } from '../decision/complexity.ts'
import { askGroup, type AskIo } from '../core/ask-group.ts'
import { readReferenceComplexity, type ComplexityIo, type ReferenceReadings, type ReferenceSource } from '../core/complexity.ts'
import { enteringPrompt } from '../core/core.ts'
import { takeDeferred } from '../core/deferred.ts'
import type { ImageFilesIo } from '../core/image-files.ts'
import { report, type NodeFailure, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'

/** The switch's name, in `/dp` and in the decision log. */
export const IMAGE_ROUTING_SWITCH = 'image-routing'

const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const
const READINGS = { plugin: 'dispatch-pilot', key: 'referenceReadings' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** How long the turn's start waits for the reading: the images prepared and the request answered (ADR 0008: about 3 seconds). */
export const READING_WAIT_MS = 3000

/**
 * The hook's own time, which a `$.clock.sleep` counts toward (10 s): the effort request after the reading waits for what is
 * left of this, never longer than the decision model's own setting.
 */
const HOOK_ROOM_MS = 9000

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

type Block = { type: string; [field: string]: unknown }

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

/** The images of the message the turn starts for (the one whose words are one of `texts`, else the latest); they are taken. */
function takePasted(texts: readonly string[]): Pasted | null {
  const wanted = texts.map((text) => text.trim())
  let at = -1
  pasted.forEach((one, i) => {
    if (wanted.includes(one.text)) at = i
  })
  const found = pasted[at === -1 ? pasted.length - 1 : at]
  pasted.length = 0
  return found ?? null
}

// ---- The engine, as closures -----------------------------------------------------------------------------------------

/** The session's temporary directory for derived images, made on first use; it holds nothing that outlives the session. */
let workDir: Promise<string> | undefined
let fileCount = 0

/** Everything the images need of the engine, as closures (a module may not pass `$` across an import). */
export function filesOf($: EngineInterface): ImageFilesIo {
  return {
    run: (argv, init) => $.process.run(argv, init),
    readBytes: async (path) => (await $.fs.read(path, { as: 'bytes' })).base64,
    newFile: async (extension) => {
      workDir ??= (async () => {
        const base = ((await $.env.get('TMPDIR').catch(() => undefined)) ?? '').trim() || '/tmp'
        const dir = `${base.replace(/\/+$/, '')}/dispatch-pilot-${Math.floor(Math.random() * 0xffffffff).toString(16)}`
        await $.process.run(['mkdir', '-p', dir])
        return dir
      })().catch((error: unknown) => {
        // Not made (no CLI, a full disk): the next reading tries again.
        workDir = undefined
        throw error
      })
      return `${await workDir}/reference-${++fileCount}.${extension}`
    },
  }
}

export function registerImageRouting(on: On, ctx: Ctx): void {
  defineSwitch({ name: IMAGE_ROUTING_SWITCH, info: '带图路由：发消息带参考图时，先读出图的复杂度，再决定主 agent 的 effort（默认关，图会发给决策模型）', default: false })

  // The message's row: its images, noted for the turn that starts next. Looked at only while the feature could use them, and
  // never changed.
  on('session.append', { door: 'prompt' }, async (_$, e, next) => {
    if (e.agentId === undefined && e.message.type === 'user' && isOn(IMAGE_ROUTING_SWITCH) && ctx.images !== null) {
      const one = pastedOf(e.message.content as Block[])
      if (one !== null) {
        pasted.push(one)
        if (pasted.length > MOST_PASTED) pasted.shift()
      }
    }
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
      if (masterOn()) await decide($, ctx, taken, [e.text, taken.prompt])
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

/**
 * What the reference images `sources` read as: asked of the image backend (a group read before is answered from the readings
 * kept), within `READING_WAIT_MS`. Null when there is no reading: no image backend, the images could not be read, the request
 * failed or came too late; the board notes a failed one, beside the route and without a toast. Never throws. The message that
 * starts a turn (below) and a picture met in the middle of one (features/reference-midturn.ts) read the same way.
 */
export async function readReference($: EngineInterface, ctx: Ctx, sources: readonly ReferenceSource[]): Promise<ReferenceReading | null> {
  const images = ctx.images
  if (images === null || sources.length === 0) return null
  const debug = (line: string) => $.ui.log(line, { to: 'debug' })
  const backend = backendOf($)
  try {
    const io: ComplexityIo = {
      files: filesOf($),
      ask: async (request) => {
        const at = await $.clock.now()
        const asked = await images.backend.ask(backend, request, READING_WAIT_MS)
        debug(`complexity reading [${Object.keys(request.questions).join(', ')}] to ${images.backend.name}: ${describeAsked(asked, (await $.clock.now()) - at)}`)
        return asked
      },
      store: { get: () => $.state.get(READINGS), set: (value: ReferenceReadings, options) => $.state.set(READINGS, value, options) },
      now: () => $.clock.now(),
      backend: images.name,
      debug,
    }
    const late = { late: true } as const
    const read = await within((ms, signal) => $.clock.sleep(ms, { signal }), readReferenceComplexity(io, sources), READING_WAIT_MS, late)
    if ('late' in read) {
      debug(`image routing: no reading in ${READING_WAIT_MS} ms; the effort is decided without it`)
      await note($, { backend: images.name, kind: 'timeout', detail: `no reading in ${READING_WAIT_MS} ms` })
      return null
    }
    if (read.ok) {
      debug(`image routing: the images read as level ${read.reading.level} (${read.cached ? 'read before' : 'asked'}), from ${read.reading.images} image${read.reading.images === 1 ? '' : 's'}`)
      return read.reading
    }
    debug(`image routing: no reading (${read.reason}); the effort is decided without it`)
    if (read.failure !== undefined) await note($, { backend: images.name, ...read.failure })
    return null
  } catch (error) {
    debug(`image routing: ${errorText(error)}`)
    return null
  }
}

/** The message's effort, decided with the reading of its images when there is one. */
async function decide($: EngineInterface, ctx: Ctx, taken: NonNullable<ReturnType<typeof takeDeferred>>, texts: readonly string[]): Promise<void> {
  const debug = (line: string) => $.ui.log(line, { to: 'debug' })
  const backend = backendOf($)
  const startedAt = await $.clock.now()
  let reading: ReferenceReading | null = null
  // Off since the message was sent: it is decided as any message is, without its images.
  if (ctx.images !== null && isOn(IMAGE_ROUTING_SWITCH)) {
    const found = takePasted(texts)
    if (found === null || found.sources.length === 0) debug('image routing: the message came with images, but none was found to read; its effort is decided without a reading')
    else reading = await readReference($, ctx, found.sources)
  }
  // The effort question, as a message's ever is: the reading is in its state. Its answer is written as the pending decision.
  const messages = ctx.config.context.messages > 0 ? await $.session.messages().catch(() => []) : []
  const spent = (await $.clock.now()) - startedAt
  const io: AskIo = { backend, now: () => $.clock.now(), debug }
  await askGroup(io, ctx, { prompt: taken.prompt, messages, group: [taken.deferred(reading)], timeoutMs: Math.max(200, Math.min(ctx.config.timeoutMs, HOOK_ROOM_MS - spent)) })
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
