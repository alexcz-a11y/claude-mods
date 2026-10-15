// Feature: visual_check (#57, ADR 0008). An agent (the main agent, or a dispatched one) hands this tool screenshots and a few
// checks, and the decision model that takes images (Jev; pplx without a TypeSafe key) answers pass, fail or unsure for each, in a
// second or two, where the agent would have had to look at every image itself.
//
// Its switch is `visual-check` (`/dp visual-check off`), on by default. The tool stays registered whatever the switches say,
// with a description that never changes (the tool list is part of the prompt cache); switched off, it says so when called.
//
// A call is a line of stages (`check`), and each later ticket of the images work (#55) has its place in it: the zoomed re-check
// (#59) goes between the first request and the verdicts, the frames of a recording (#60) are read where the images are, the
// quality series (#61) is another kind of comparison, and the report to the board and the log (#58) goes after the verdicts.
// Whatever goes wrong in a stage, the checks it touches end unsure with the reason, and the tool never fails.

import type { EngineInterface, HttpInit, On } from 'claude-code'
import { type Asked, type BackendIo, describeAsked, errorText, failureText } from '../decision/backend.ts'
import { imageMegapixelBudget, PPLX_MAX_IMAGES, type Picture } from '../decision/images.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { type ImageLimits, LOOK_IMAGE_LIMITS, limitsFor } from '../decision/image-fit.ts'
import { forgetLoop, noteResults, readWholeImage, wholeImageRequest, type Check, type CheckResult, type Comparison, type Streaks } from '../decision/visual-check.ts'
import { parseVisualCheckInput, visualCheckText, VISUAL_CHECK_INPUT, VISUAL_CHECK_TOOL, VISUAL_CHECK_TOOL_CALLED, visualCheckDescription, type VisualCheckInput } from '../decision/visual-check-tool.ts'
import { FRAME_COUNT, type Frame, framesRequest, isRecording, LOOK_FRAME_COUNT, type Span } from '../decision/visual-check-frames.ts'
import { recordOf, type VisualCheckRecord } from '../decision/visual-check-record.ts'
import { type ImageFilesIo, type Loaded, type LoadedImage, loadImage, loadImages } from '../core/image-files.ts'
import { type RecordingFrames, readRecording } from '../core/video-frames.ts'
import { report, type ReportIo } from '../core/report.ts'
import { type CallTrouble, reportCall } from '../core/visual-check-report.ts'
import { newWorkFile } from '../core/work-files.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'

const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'visual-check'

/**
 * How long a request with images may take (ADR 0008): a tool call is not held to the 1500 ms Jev has beside a message, and the
 * hook's own 10 s count only the mod's code, not `$.http.fetch` or `$.process.run`.
 */
const REQUEST_MS = 8000

/** What a tool call answers: a string, or Messages API blocks (the engine takes nothing else of a registered tool). */
type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

const imageBlock = (picture: Picture): Block => ({ type: 'image', source: { type: 'base64', media_type: `image/${picture.format}`, data: picture.base64 } })

/** A call that did not run: the agent is told why, and that it can look at the images itself. */
const LOOK_YOURSELF = 'Look at the images yourself.'

/**
 * How many times in a row each check has failed, by agent, in its loop (module level: a hot reload loses it, at the cost of one
 * reminder less).
 */
const streaks: Streaks = new Map()

/** Everything one call needs of the engine, as closures (a module may not pass `$` across an import). */
async function filesOf($: EngineInterface): Promise<ImageFilesIo> {
  return {
    run: (argv, init) => $.process.run(argv, init),
    readBytes: async (path) => (await $.fs.read(path, { as: 'bytes' })).base64,
    // Derived images go to the session's directory in the mod's temporary directory (core/work-files.ts).
    newFile: (extension) => newWorkFile({ run: (argv) => $.process.run(argv), tmpdir: () => $.env.get('TMPDIR'), sessionId: () => $.session.id() }, extension),
  }
}

export function registerVisualCheck(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: '看图核对：agent 交上截图和检查项，决策模型对每条回答过、不过或没把握', parts: ['checks'] })

  // Registered once every plugin is loaded, under a match-all matcher. Without a decision model that takes images (no TypeSafe
  // and no Perplexity key) the tool would only ever fail, so it is not offered.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    const images = ctx.images
    if (images === null) return result
    try {
      const { tool } = await $.tool.register({
        name: VISUAL_CHECK_TOOL,
        description: visualCheckDescription(images.name),
        inputSchema: VISUAL_CHECK_INPUT,
        isDeferred: false,
      })
      if (tool !== VISUAL_CHECK_TOOL_CALLED) $.ui.log(`visual_check is registered as ${tool}, but the hook answers ${VISUAL_CHECK_TOOL_CALLED}: its calls will fail`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`visual_check was not registered: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })

  // A loop begins (a turn of the main agent, an agent's run): the count of failed checks starts again.
  on('turn.start', { turnId: /(?:)/ }, async (_$, e, next) => {
    forgetLoop(streaks, e.agentId ?? 'main')
    return next(e)
  })

  // The model's call: answered here, never passed on. Whatever goes wrong, the answer says so at once.
  on('tool.call', { tool: VISUAL_CHECK_TOOL_CALLED }, async ($, e) => {
    if (!masterOn()) return { result: `Dispatch Pilot is switched off (/dp on turns it back on), so visual_check checked nothing. ${LOOK_YOURSELF}` }
    if (!isOn(SWITCH)) return { result: `visual_check is switched off (/dp ${SWITCH} on turns it back on), so it checked nothing. ${LOOK_YOURSELF}` }
    const parsed = parseVisualCheckInput(e as Record<string, unknown>)
    if (!parsed.ok) return { result: parsed.message }
    const agent = e.agentId ?? 'main'
    const reportTo: ReportIo = {
      board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
      decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
      debug: (line) => $.ui.log(line, { to: 'debug' }),
      now: () => $.clock.now(),
      toast: (text) => $.ui.toast(text),
    }
    try {
      const files = await filesOf($)
      // Looking at images asks nothing of the decision model.
      if (parsed.input.look) return { result: await look(files, parsed.input.images, parsed.input.span) }
      // #61: a series of quality levels is compared pair by pair here.
      if (parsed.input.comparison.kind === 'sequence') return { result: 'visual_check cannot compare a series of images (sequence) yet. Compare two of them at a time with compare_to, or look at them yourself.' }
      const images = ctx.images
      if (images === null) return { result: `visual_check has no decision model that takes images (it needs a TypeSafe or a Perplexity key), so it checked nothing. ${LOOK_YOURSELF}` }
      const io: BackendIo = {
        fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
        sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
        pace: { now: () => $.clock.now(), sentAt: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
      }
      const ask = async (request: DecisionRequest): Promise<Asked> => {
        const startedAt = await $.clock.now()
        const asked = await images.backend.ask(io, request, REQUEST_MS)
        const ms = (await $.clock.now()) - startedAt
        $.ui.log(`visual_check request [${Object.keys(request.questions).join(', ')}] to ${images.backend.name}: ${describeAsked(asked, ms)}`, { to: 'debug' })
        return asked
      }
      const deps: Deps = { files, ask, backend: images.name, agent, now: () => $.clock.now(), debug: reportTo.debug, report: (record, trouble) => reportCall(reportTo, agent, record, trouble) }
      return { result: await check(deps, parsed.input) }
    } catch (error) {
      $.ui.log(`visual_check failed: ${errorText(error)}`, { to: 'debug' })
      // A bug of the mod's own, beside the agent's route: a note on the board, no toast.
      await report(reportTo, { decision: { feature: SWITCH, agent, aside: true, skipped: 'error' } })
      return { result: `visual_check could not run (an error in Dispatch Pilot, written to the debug log). ${LOOK_YOURSELF}` }
    }
  })
}

/** What a call needs of the world: files and programs, the decision model that takes images. */
type Deps = {
  files: ImageFilesIo
  ask: (request: DecisionRequest) => Promise<Asked>
  backend: 'jev' | 'pplx'
  /** Who calls: 'main', or a dispatched agent's id. */
  agent: string
  /** `$.clock.now()`: a call's duration is in its record. */
  now: () => Promise<number>
  /** A line for the debug log. */
  debug: (line: string) => void
  /** Hands a finished call to the board and the decision log (core/visual-check-report.ts); `trouble`: what went wrong beyond a check's own doubt. */
  report: (record: VisualCheckRecord, trouble?: CallTrouble) => Promise<void>
}

/** All the checks end unsure, for a reason that touches them all. */
function allUnsure(checks: readonly Check[], why: string): CheckResult[] {
  return checks.map((check) => ({ check, verdict: 'unsure' as const, probability: null, basis: 'whole' as const, why }))
}

/** One call, from its input to its answer. */
async function check(deps: Deps, input: VisualCheckInput): Promise<Block[]> {
  const { comparison, checks } = input
  const target = input.images[0] as string
  const startedAt = await deps.now()
  let trouble: CallTrouble | undefined

  // Stage 1, the images: the screenshot, and what it is compared with. A recording is read into its frames here (#60).
  const subjects = await subjectsOf(deps, comparison, target, checks.length, input.span)
  let results: CheckResult[]
  let attached: Picture | null = subjects.screenshot
  if (!subjects.ok) {
    results = allUnsure(checks, subjects.reason)
    trouble = { kind: 'error' }
    deps.debug(`visual_check could not use its images: ${subjects.reason}`)
  } else if (subjects.kind === 'recording') {
    // The frames of a recording, all in one request, in order of time: only the wording of the checks, or a spec, to judge them by.
    const { request, part } = framesRequest(comparison.kind === 'spec' ? comparison.spec : null, subjects.frames, checks)
    const asked = await deps.ask(request)
    results = asked.ok ? readWholeImage(comparison, part, asked.answers, checks) : allUnsure(checks, failureText(deps.backend, asked.failure))
    if (!asked.ok) trouble = { kind: 'request', failure: { backend: deps.backend, ...asked.failure } }
  } else {
    // Stage 2, the first request: every check about the whole images, in one request.
    const { request, part } = wholeImageRequest(comparison, { screenshot: subjects.screenshot, references: subjects.references }, checks)
    const asked = await deps.ask(request)
    // Stage 3 (#59): the zoomed re-check of the parts the checks name, when the checks compare two images.
    // Stage 4, the verdicts.
    results = asked.ok ? readWholeImage(comparison, part, asked.answers, checks) : allUnsure(checks, failureText(deps.backend, asked.failure))
    if (!asked.ok) trouble = { kind: 'request', failure: { backend: deps.backend, ...asked.failure } }
  }
  // The screenshot goes along for what is unsure, to be looked at.
  if (!results.some((result) => result.verdict === 'unsure')) attached = null
  const repeated = noteResults(streaks, deps.agent, results)
  // Stage 5 (#58): the report to the board and the decision log; a recording is reported like a screenshot, by its path.
  await deps.report(recordOf({ image: target, comparison, backend: deps.backend, results, ms: (await deps.now()) - startedAt }), trouble)
  const text = visualCheckText({ target, against: comparison, results, attached: attached !== null, repeated, recording: isRecording(target) })
  return [{ type: 'text', text }, ...(attached === null ? [] : [imageBlock(attached)])]
}

const failed = (error: unknown): Loaded => ({ ok: false, reason: errorText(error) })

/**
 * The images of a call, loaded; or why not, with the screenshot if that one was got (it is then still handed back to look at). A
 * recording (#60) is its frames, in order of time, and there is no screenshot to hand back.
 */
type Subjects =
  | { ok: true; kind: 'still'; screenshot: LoadedImage; references: LoadedImage[] }
  | { ok: true; kind: 'recording'; screenshot: null; frames: Frame[] }
  | { ok: false; reason: string; screenshot: LoadedImage | null }

/** The screenshot and what it is compared with (the references, or the other screenshot; none against a spec), as one request holds them. */
async function subjectsOf(deps: Deps, comparison: Comparison, target: string, questions: number, span: Span): Promise<Subjects> {
  const others = comparison.kind === 'reference' ? comparison.paths : comparison.kind === 'compare_to' ? [comparison.path] : []
  const paths = [target, ...others]
  const compared = others.length > 0
  if (isRecording(target)) {
    if (compared) return { ok: false, screenshot: null, reason: `${target} is a recording, which is checked against a spec or on the wording of the checks alone, not against ${comparison.kind === 'reference' ? 'a reference' : 'another screenshot'}` }
    const read = await readRecording(deps.files, target, span, FRAME_COUNT[deps.backend], limitsFor(deps.backend), imageMegapixelBudget(deps.backend, questions))
    return read.ok ? { ok: true, kind: 'recording', screenshot: null, frames: read.frames } : { ok: false, screenshot: null, reason: read.reason }
  }
  const recording = others.find(isRecording)
  if (recording !== undefined) return { ok: false, screenshot: null, reason: `${recording} is a recording, and only the screenshot to check can be one` }
  if (deps.backend === 'pplx' && paths.length > PPLX_MAX_IMAGES) {
    return { ok: false, screenshot: null, reason: `pplx takes at most ${PPLX_MAX_IMAGES} images in one request, and this call has ${paths.length}` }
  }
  let loaded: Loaded[]
  try {
    loaded = await loadImages(deps.files, paths, limitsFor(deps.backend), imageMegapixelBudget(deps.backend, questions))
  } catch (error) {
    return { ok: false, screenshot: null, reason: errorText(error) }
  }
  const first = loaded[0]
  const screenshot = first?.ok ? first.image : null
  const broken = loaded.find((one) => !one.ok)
  if (broken !== undefined && !broken.ok) return { ok: false, screenshot, reason: broken.reason }
  return screenshot === null ? { ok: false, screenshot, reason: 'no image was loaded' } : { ok: true, kind: 'still', screenshot, references: loaded.slice(1).flatMap((one) => (one.ok ? [one.image] : [])) }
}

/** An image file for `look`, loaded within the limits; a failure of any kind is a reason, never a throw. */
async function load(files: ImageFilesIo, path: string, limits: ImageLimits): Promise<Loaded> {
  return loadImage(files, path, limits).catch(failed)
}

/** `look` at a recording (#60): a line saying when each frame was cut, then the frames; or a line saying why there are none. */
async function lookAtRecording(files: ImageFilesIo, path: string, span: Span): Promise<Block[]> {
  const read = await readRecording(files, path, span, LOOK_FRAME_COUNT, LOOK_IMAGE_LIMITS).catch((error: unknown): RecordingFrames => ({ ok: false, reason: errorText(error) }))
  if (!read.ok) return [{ type: 'text', text: read.reason }]
  return [{ type: 'text', text: `Frames of ${path}, in order of time, cut at ${read.frames.map((frame) => `${frame.seconds} s`).join(', ')}.` }, ...read.frames.map((frame) => imageBlock(frame.picture))]
}

/** `look`: the images as they are handed back, each one that cannot be got as a line saying why; a recording as frames of it, through `span`. */
async function look(files: ImageFilesIo, paths: readonly string[], span: Span): Promise<Block[]> {
  const blocks: Block[] = []
  for (const path of paths) {
    if (isRecording(path)) {
      blocks.push(...(await lookAtRecording(files, path, span)))
      continue
    }
    const loaded = await load(files, path, LOOK_IMAGE_LIMITS)
    blocks.push(loaded.ok ? imageBlock(loaded.image) : { type: 'text', text: loaded.reason })
  }
  return blocks
}
