// What the main agent and the dispatched agents read of visual_check (#57, ADR 0008): the tool's description and input schema, which
// never change in a session (the tool list is part of the prompt cache), and, further on, how its answer is worded. All of it is
// written for the model, so in English. Pure (see system-one.ts).

import type { BackendName } from './backend.ts'
import { FRAME_COUNT, type Span, WHOLE_RECORDING } from './visual-check-frames.ts'
import { MAX_LEVELS, SERIES_DESCRIPTION, SERIES_UNAVAILABLE } from './visual-check-sequence.ts'
import type { Check, CheckResult, Comparison } from './visual-check.ts'
import { boxArea, type Box } from './zoom.ts'

/** The tool's name; the model calls it as `mcp__dispatch-pilot__visual_check`. */
export const VISUAL_CHECK_TOOL = 'visual_check'
export const VISUAL_CHECK_TOOL_CALLED = 'mcp__dispatch-pilot__visual_check'

// The engine passes on only the first 4096 characters of an MCP tool's description (Claude Code 2.1.300; tests/visual-check.test.ts
// holds both versions to it). So the guidance every call needs comes first, in this order, and the details of the zoomed re-check,
// of a series and of a recording come last: if the description ever outgrows the limit again, only those are cut.

const WHAT_IT_IS =
  'Checks a screenshot with a small, fast decision model and answers PASS, FAIL or UNSURE for each check you name, so you do not have to look at every image yourself. Use it on your own work as you iterate on a UI, 3D scene or model; it is cheap, so call it often. One screenshot per call, checked against a reference image, another screenshot, or a written spec.'

const HOW_TO_WRITE_CHECKS =
  'Each check names one part of the image and one visible property of it. Against a reference or another screenshot the property is what to compare (part "the primary button", property "corner radius"); against a spec, or nothing, it is the requirement (part "the tab bar", property "has four tabs"). One property per check.'

const WHAT_IT_JUDGES =
  'It judges coarse visible differences well: a missing or extra element, cut-off text, clear overlap or misalignment, a large change of color, a clearly different shape, whether a rendering feature (foam, fog, reflections) is present and how strong. It cannot verify numbers (sizes, corner radii, color values, font weights): read those from the code or the runtime. It cannot judge feel (easing, texture, polish): look at the image yourself.'

const READING_THE_ANSWER =
  'PASS only means that nothing obviously wrong was seen: it is not an acceptance. FAIL can be trusted. For UNSURE the answer includes the screenshot, scaled down: look at it yourself. If the same check fails twice in a row, look at the image yourself before you change anything else.'

const LOOK =
  'With look: true nothing is judged: the images come back scaled to a size you can read, for you to see them yourself.'

const BEFORE_YOU_FINISH =
  'Before you hand your work to the user, look at the final result yourself once. Name the checks you ran, and what they said, in your final report.'

/** With Jev: a part named in a check is cropped out of both images, enlarged and compared again (#59, ADR 0008). */
const COMPARING_WITH_ZOOM =
  'Against a reference or another screenshot, each part you name is also cropped out of both images, enlarged and compared again, so subtle differences are caught and a match can PASS. Name a part in every check: one that names none is judged on the whole images, where a match can never PASS. same_view: true means both images show the same view, so the same area is cropped from both; with false (a photo against your render) each image is cropped on its own. With several references (photos from several sides) a check passes if any one shows the part as your screenshot does. If both images show the same view, the whole image is also scanned for a place where they differ, and a place no check named is reported too, with crops.'

/** With pplx: no boxes, so no zoom (#56, ADR 0008). */
const COMPARING_COARSE =
  'Against a reference or another screenshot it can only look at the whole images, so it catches only clear differences: a FAIL can be trusted, a match is at best UNSURE. Check subtle properties yourself.'

/**
 * A recording (#60): the frames are cut with ffmpeg and sent together, in order of time. The counts are the backend's (the
 * description is a constant per backend, like the rest).
 */
function recordings(frames: number): string {
  return `The images may also be a screen recording (.mov, .mp4, ...): ${frames} frames are cut from it, evenly through the part given by from_seconds and to_seconds (all of it by default), and judged together, so name the part with the motion. Check it against a spec or on the wording of the checks alone, not a reference. Ask only coarse questions of motion: whether the element overshoots and springs back, whether it ends far from where it should, whether something appears or disappears. It cannot judge an easing curve or a slight stutter: look at those yourself. Word each check as what should be true ("the card settles without bouncing back"). Needs ffmpeg on this machine; without it the checks are UNSURE (look at the recording with look: true).`
}

/** What the model reads about the tool, by the decision model that takes its images. Constants: nothing of the session goes in. */
export function visualCheckDescription(backend: BackendName): string {
  const jev = backend === 'jev'
  return [WHAT_IT_IS, HOW_TO_WRITE_CHECKS, WHAT_IT_JUDGES, READING_THE_ANSWER, LOOK, BEFORE_YOU_FINISH, jev ? COMPARING_WITH_ZOOM : COMPARING_COARSE, jev ? SERIES_DESCRIPTION : SERIES_UNAVAILABLE, recordings(FRAME_COUNT[backend])].join(' ')
}

/** The tool's input schema. */
export const VISUAL_CHECK_INPUT = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Path of the screenshot, or screen recording, to check (exactly one, unless look is true: then up to 8 paths of images to look at).',
    },
    reference: {
      type: 'array',
      items: { type: 'string' },
      description: 'Compare against these reference images: a design, or photos of the real object (several, if they show it from different sides). Give one of reference, compare_to, sequence or spec.',
    },
    compare_to: {
      type: 'string',
      description: 'Compare against this other screenshot: the same screen before your change, or at another quality level.',
    },
    sequence: {
      type: 'boolean',
      description: 'images is a series of the same view at rising quality levels, lowest first (2 to 12 stills), to be compared pair by pair in the parts the checks name, to find the level from which the higher ones no longer look different. Needs the zoomed re-check, so not with pplx.',
    },
    spec: {
      type: 'string',
      description: 'Check against this written specification. With none of reference, compare_to, sequence and spec, each check is judged on its own wording.',
    },
    same_view: {
      type: 'boolean',
      description: 'Whether both images show the same view (the same crop of the same screen or scene). Defaults to whether their aspect ratios are the same.',
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          part: { type: 'string', description: 'The part of the image, e.g. "the primary button", "the third list row", "the sea near the horizon".' },
          property: { type: 'string', description: 'One visible property of it to compare, e.g. "corner radius", "foam density"; or, against a spec, the requirement, e.g. "has a blue fill".' },
        },
        required: ['part', 'property'],
        additionalProperties: false,
      },
      description: 'The checks, one property of one part each. Required, unless look is true.',
    },
    look: {
      type: 'boolean',
      description: 'Do not judge: return the images, scaled down to a size you can read. A recording comes back as 8 frames.',
    },
    from_seconds: {
      type: 'number',
      description: 'For a recording: where in it to start, in seconds (0 by default).',
    },
    to_seconds: {
      type: 'number',
      description: 'For a recording: where in it to stop, in seconds (its end by default).',
    },
  },
  required: ['images'],
  additionalProperties: false,
} as const

// ---- What a call is given ------------------------------------------------------------------------------------------

/** Most checks one call takes: they are all in one request, with their images. */
export const MAX_CHECKS = 24
/** Most images `look` returns at once. */
export const MAX_LOOK = 8

/** A call's input, read. */
export type VisualCheckInput = {
  images: readonly string[]
  comparison: Comparison
  /** `same_view` as the agent gave it; null when it did not (the tool then goes by the images' aspect ratios). */
  sameView: boolean | null
  checks: readonly Check[]
  look: boolean
  /** The part of a recording to read (#60); the whole of it when the agent names none. */
  span: Span
}

/** A number of seconds the model gave (a number, or a string of one); null for none, NaN for what is not a number. */
function seconds(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN
}

/** The span a call names, or what is wrong with it. */
function spanOf(raw: Readonly<Record<string, unknown>>): { ok: true; span: Span } | { ok: false; message: string } {
  const from = seconds(raw.from_seconds)
  const to = seconds(raw.to_seconds)
  if (Number.isNaN(from)) return { ok: false, message: 'visual_check: from_seconds must be a number of seconds, 0 or more.' }
  if (Number.isNaN(to)) return { ok: false, message: 'visual_check: to_seconds must be a number of seconds, 0 or more.' }
  if (to !== null && to <= (from ?? 0)) return { ok: false, message: `visual_check: to_seconds (${to}) must be after from_seconds (${from ?? 0}).` }
  return { ok: true, span: from === null && to === null ? WHOLE_RECORDING : { from: from ?? 0, to } }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

function paths(value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  return list.map(text).filter((path) => path !== '')
}

/**
 * A call's input, or what to tell the agent about it (the answer, not an error: the agent reads it and calls again). The input
 * is the model's, so nothing in it is taken for granted.
 */
export function parseVisualCheckInput(raw: Readonly<Record<string, unknown>>): { ok: true; input: VisualCheckInput } | { ok: false; message: string } {
  const images = paths(raw.images)
  if (images.length === 0) return { ok: false, message: 'visual_check needs images: the path of the screenshot to check.' }
  const look = raw.look === true
  const named = spanOf(raw)
  if (!named.ok) return named
  const { span } = named
  const reference = paths(raw.reference)
  const compareTo = text(raw.compare_to)
  const spec = text(raw.spec)
  const given = [reference.length > 0 ? 'reference' : '', compareTo !== '' ? 'compare_to' : '', raw.sequence === true ? 'sequence' : '', spec !== '' ? 'spec' : ''].filter((name) => name !== '')
  if (given.length > 1) return { ok: false, message: `visual_check checks against one thing: give only one of reference, compare_to, sequence and spec (you gave ${given.join(' and ')}).` }
  const comparison: Comparison =
    reference.length > 0 ? { kind: 'reference', paths: reference } : compareTo !== '' ? { kind: 'compare_to', path: compareTo } : raw.sequence === true ? { kind: 'sequence' } : { kind: 'spec', spec: spec === '' ? null : spec }
  if (look) {
    if (images.length > MAX_LOOK) return { ok: false, message: `visual_check with look: true returns at most ${MAX_LOOK} images at once (you gave ${images.length}).` }
    return { ok: true, input: { images, comparison, sameView: null, checks: [], look, span } }
  }
  if (comparison.kind !== 'sequence' && images.length > 1) {
    return { ok: false, message: 'visual_check checks one screenshot per call: give one path in images, and call it again for the next screenshot.' }
  }
  if (comparison.kind === 'sequence' && images.length < 2) {
    return { ok: false, message: `visual_check with sequence: true compares each two neighbouring levels: give at least two images in images, lowest level first (you gave ${images.length}).` }
  }
  if (comparison.kind === 'sequence' && images.length > MAX_LEVELS) {
    return { ok: false, message: `visual_check with sequence: true takes at most ${MAX_LEVELS} levels in one call (you gave ${images.length}): compare the ones around the level you suspect.` }
  }
  const list: unknown[] = Array.isArray(raw.checks) ? raw.checks : []
  const checks = list.flatMap((item): Check[] => {
    if (typeof item === 'string') return text(item) === '' ? [] : [{ part: '', property: text(item) }]
    if (typeof item !== 'object' || item === null) return []
    const { part, property } = item as Record<string, unknown>
    return text(property) === '' ? [] : [{ part: text(part), property: text(property) }]
  })
  if (checks.length === 0) return { ok: false, message: 'visual_check needs checks: each names a part of the image and one visible property of it, e.g. { "part": "the primary button", "property": "corner radius" }.' }
  if (checks.length > MAX_CHECKS) return { ok: false, message: `visual_check takes at most ${MAX_CHECKS} checks in one call (you gave ${checks.length}): split them over two calls.` }
  return { ok: true, input: { images, comparison, sameView: typeof raw.same_view === 'boolean' ? raw.same_view : null, checks, look, span } }
}

// ---- What a call answers -------------------------------------------------------------------------------------------

/** What the answer's text is told. */
export type RunReport = {
  /** The screenshot's path, as the agent gave it. */
  target: string
  against: Comparison
  results: readonly CheckResult[]
  /** Whether the screenshot goes along, scaled down (for what is unsure). */
  attached: boolean
  /** The checks that have now failed twice (or more) in a row in this loop, by their index. */
  repeated: readonly number[]
  /** The target is a recording (#60): the verdicts rest on its frames, and what is unsure is looked at with `look: true`. */
  recording?: boolean
  /** Zoomed crops (#59) that go along, as the images that follow the text (before the screenshot, if that goes along): what each one shows. */
  crops?: readonly string[]
  /** Another place the two images may differ (#59), which no check named; `cropped`: whether crops of it are among `crops`. */
  elsewhere?: ShownPlace | null
}

/** What an attached crop shows: the `side` ('your screenshot' or the other image) of the check, or of the place no check named. */
export function cropLabel(of: { check: number } | { place: true }, side: string): string {
  return `${'check' in of ? `check ${of.check + 1}` : 'the other place'}: ${side}`
}

const AGAINST = {
  spec: 'against the spec',
  none: 'on the wording of the checks alone',
  reference: 'against the reference',
  compare_to: 'against the other screenshot',
  sequence: 'against the series',
} as const

const against = (comparison: Comparison): string => (comparison.kind === 'spec' ? (comparison.spec === null ? AGAINST.none : AGAINST.spec) : AGAINST[comparison.kind])

const BASES = { whole: 'whole image', zoom: 'zoomed crop' } as const

const percent = (share: number): string => `${Math.round(share * 100)}%`

/** Another place the two images may differ, as the answer shows it: where, how sure the model is, and whether crops of it come along. */
export type ShownPlace = { box: Box; confidence: number; cropped: boolean }

/** The place no check named, in words: where it is in the screenshot, how much of it, how sure the model is. */
export function placeLine(place: ShownPlace): string {
  const { box, confidence } = place
  return `Another place may differ, which none of your checks named: ${percent(box.left)} to ${percent(box.right)} across and ${percent(box.top)} to ${percent(box.bottom)} down the screenshot (${percent(boxArea(box))} of it; the model is ${confidence.toFixed(2)} sure of the place).${place.cropped ? ' Crops of it are attached.' : ''} Look at it yourself.`
}

/** The answer's text: the verdicts, then what the agent is to do with them. */
export function visualCheckText(report: RunReport): string {
  const { results } = report
  const kinds = (['pass', 'fail', 'unsure'] as const).map((verdict) => ({ verdict, count: results.filter((result) => result.verdict === verdict).length })).filter((kind) => kind.count > 0)
  const lines = [`Visual check of ${report.target} ${against(report.against)}: ${kinds.map((kind) => `${kind.count} ${kind.verdict.toUpperCase()}`).join(', ')}.`]
  results.forEach((result, i) => {
    const probability = result.probability === null ? 'n/a' : result.probability.toFixed(2)
    const check = result.check.part === '' ? result.check.property : `${result.check.part}: ${result.check.property}`
    lines.push(`${i + 1}. ${result.verdict.toUpperCase()} ${probability} (${report.recording === true && result.basis === 'whole' ? 'frames' : BASES[result.basis]}) ${check}${result.why === undefined ? '' : ` (${result.why})`}`)
  })
  const passed = results.some((result) => result.verdict === 'pass')
  lines.push(`The number is the probability that the check holds.${passed ? ' PASS only means that nothing obviously wrong was seen; it is not an acceptance.' : ''}`)
  if (report.elsewhere != null) lines.push(placeLine(report.elsewhere))
  if (report.crops !== undefined && report.crops.length > 0) lines.push(`Zoomed crops are attached${report.attached ? ' before the screenshot' : ''}, in this order: ${report.crops.join('; ')}.`)
  if (report.attached) lines.push('The screenshot is attached, scaled down: look at it yourself for what is UNSURE.')
  if (report.recording === true && results.some((result) => result.verdict === 'unsure')) lines.push('For what is UNSURE, look at the recording yourself: visual_check with look: true and its path (and from_seconds and to_seconds) returns 8 frames of it.')
  for (const index of report.repeated) lines.push(`Check ${index + 1} has now failed twice in a row: look at the image yourself (visual_check with look: true) before you change anything else.`)
  return lines.join('\n')
}
