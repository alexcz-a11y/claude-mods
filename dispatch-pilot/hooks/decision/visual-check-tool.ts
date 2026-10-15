// What the main agent and the dispatched agents read of visual_check (#57, ADR 0008): the tool's description and input schema, which
// never change in a session (the tool list is part of the prompt cache), and, further on, how its answer is worded. All of it is
// written for the model, so in English. Pure (see system-one.ts).

import { FRAME_COUNT, type Span, WHOLE_RECORDING } from './visual-check-frames.ts'
import type { Check, CheckResult, Comparison } from './visual-check.ts'

/** The tool's name; the model calls it as `mcp__dispatch-pilot__visual_check`. */
export const VISUAL_CHECK_TOOL = 'visual_check'
export const VISUAL_CHECK_TOOL_CALLED = 'mcp__dispatch-pilot__visual_check'

const WHAT_IT_IS =
  'Checks screenshots with a small, fast decision model and answers PASS, FAIL or UNSURE for each check you name, in about a second, so that you do not have to look at every image yourself. Use it to check your own work while you iterate on a UI, a 3D scene or a model; it is cheap, so call it often. Give one screenshot per call, and what it is checked against: a reference image, another screenshot, or a written spec.'

const HOW_TO_WRITE_CHECKS =
  'Each check names one part of the image and one visible property of it. Against a reference or another screenshot the property is what to compare, e.g. part "the primary button", property "corner radius". Against a spec (or against nothing) it is the requirement, e.g. part "the tab bar", property "has four tabs". One property per check; any number of checks go in one call.'

const WHAT_IT_JUDGES =
  'It judges coarse, visible differences well: an element missing or extra, text cut off, clear overlap or misalignment, a large change of color, a clearly different shape, whether a rendering feature (foam, fog, reflections) is present and how strong. It cannot verify numbers (sizes, corner radii, color values, font weights): read those from the code or the runtime. It cannot judge feel (easing, texture, polish): look at the image yourself.'

/**
 * With Jev: a part named in a check is cropped out of both images, enlarged and compared again. This is written ahead of the
 * zoomed re-check itself (#59): until that is in the flow, a comparison reaches only a FAIL or an UNSURE.
 */
const COMPARING_WITH_ZOOM =
  'Against a reference or another screenshot, each part you name is also cropped out of both images, enlarged and compared again, so that subtle differences (a smaller corner radius) can be caught and a match can PASS. Pass same_view: true when both images show the same view, so that the same area is cropped from both; with false (a photo of a real object against your render) the part is cropped from each image on its own. The tool also scans the whole image for a place where the two differ and reports it, even if no check named it.'

/** With pplx: no boxes, so no zoom (#56, ADR 0008). */
const COMPARING_COARSE =
  'Against a reference or another screenshot it can only look at the whole images, so it catches only clear differences: a FAIL can be trusted, a match is at best UNSURE. Check subtle properties yourself.'

const READING_THE_ANSWER =
  'PASS only means that nothing obviously wrong was seen: it is not an acceptance. FAIL can be trusted. For UNSURE the answer includes the screenshot, scaled down: look at it yourself. If the same check fails twice in a row, look at the image yourself before you change anything else.'

const LOOK =
  'With look: true nothing is judged: the images in images come back scaled to a size you can read, for when you need to see a screenshot yourself.'

/**
 * A recording (#60): the frames are cut with ffmpeg and sent together, in order of time. The counts are the backend's (the
 * description is a constant per backend, like the rest).
 */
function recordings(frames: number): string {
  return `images may also be a screen recording (.mov, .mp4, .webm, ...): ${frames} frames are cut from it, evenly through the part given by from_seconds and to_seconds (all of it by default), and judged together, so name the part with the motion and not a long recording. Check it against a spec or on the wording of the checks alone, not against a reference. Ask only coarse questions of motion: whether the element overshoots and springs back, whether it ends far from where it should, whether something appears or disappears. It cannot judge an easing curve or a slight stutter: look at those yourself. Word each check as what should be true ("the card settles without bouncing back"). It needs ffmpeg on this machine; without it the checks are UNSURE. For what is UNSURE, look at the recording with look: true.`
}

const BEFORE_YOU_FINISH =
  'Before you hand your work to the user, look at the final result yourself once. Name the checks you ran, and what they said, in your final report.'

/** What the model reads about the tool, by the decision model that takes its images. Constants: nothing of the session goes in. */
export function visualCheckDescription(backend: 'jev' | 'pplx'): string {
  return [WHAT_IT_IS, HOW_TO_WRITE_CHECKS, WHAT_IT_JUDGES, backend === 'jev' ? COMPARING_WITH_ZOOM : COMPARING_COARSE, recordings(FRAME_COUNT[backend]), READING_THE_ANSWER, LOOK, BEFORE_YOU_FINISH].join(' ')
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
      description: 'images is a series of the same view at rising quality levels, to be compared pair by pair, to find the level from which they no longer look different.',
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
  if (report.attached) lines.push('The screenshot is attached, scaled down: look at it yourself for what is UNSURE.')
  if (report.recording === true && results.some((result) => result.verdict === 'unsure')) lines.push('For what is UNSURE, look at the recording yourself: visual_check with look: true and its path (and from_seconds and to_seconds) returns 8 frames of it.')
  for (const index of report.repeated) lines.push(`Check ${index + 1} has now failed twice in a row: look at the image yourself (visual_check with look: true) before you change anything else.`)
  return lines.join('\n')
}
