// The visual-check suite (#65, ADR 0008, spec #55 seam 2): how well the decision model that takes images judges what visual_check asks
// of it, against the truth of the experiment's pictures (eval/datasets/visual-check.jsonl and the pictures beside it).
//
// What is asked is what the mod asks when an agent calls visual_check, request for request: the questions come from the mod's pure
// functions (hooks/decision/visual-check*.ts, complexity.ts), the pictures are sized and cut by the mod's own image code
// (hooks/core/image-files.ts, zoom-review.ts, complexity.ts) running the same sips arguments, on Node's files and programs
// (`ImageHost`) in place of the engine's. tests/eval-visual-check-requests.test.ts holds the suite's requests to the mod's, through
// the mod's tool in the world. The stages of a call are the feature's own (hooks/features/visual-check.ts `check`): the first request
// with every check, the Box questions beside it when the images are compared and the model is Jev, the zoomed re-check on the crops.
//
// Items and what is measured (the ticket's list): a check that holds judged PASS or FAIL, one that does not hold judged PASS (should
// be none), FAIL on the controls, UNSURE, the tokens, the latency and the price of each image, and whether the groups of reference
// images read in the order of their complexity. The raw probabilities are kept with each answer, so that the bars (a screenshot 0.8
// and 0.2, a recording 0.8 and 0.4; before 2026-10-15 0.9 and 0.2 for both) can be swept offline: `thresholds` in the figures, and
// eval/lib/visual-check-rescore.ts for the verdicts of a stored result by the bars of now.
//
// Pure: no Node API; the pictures and programs come in as `ImageHost` (SuiteHost.images).

import { type ComplexityIo, readReferenceComplexity, type ReferenceReadings } from '../../hooks/core/complexity.ts'
import { type ImageFilesIo, loadAll, type LoadedAll, type LoadedImage } from '../../hooks/core/image-files.ts'
import { zoomReview } from '../../hooks/core/zoom-review.ts'
import type { Asked, BackendName } from '../../hooks/decision/backend.ts'
import { complexityRequest, COMPLEXITY_LEVEL, COMPLEXITY_LEVELS } from '../../hooks/decision/complexity.ts'
import { limitsFor } from '../../hooks/decision/image-fit.ts'
import { imageMegapixelBudget, PPLX_MAX_IMAGES } from '../../hooks/decision/images.ts'
import type { DecisionRequest } from '../../hooks/decision/system-one.ts'
import { FRAME_COUNT, framesRequest } from '../../hooks/decision/visual-check-frames.ts'
import { batchPairs, locatePlan, readLocated, withBoxes, zoomRequest, type ZoomPair } from '../../hooks/decision/visual-check-zoom.ts'
import { comparedNames, FAIL_AT, judge, PASS_AT, readWholeImage, RECORDING_BARS, RECORDING_FAIL_AT, SERIES_PASS_AT, wholeImageRequest, type Basis, type Check, type CheckResult, type Comparison, type Verdict } from '../../hooks/decision/visual-check.ts'
import { sameView } from '../../hooks/decision/zoom.ts'
import type { Language } from './datasets.ts'
import { rate, type VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'
import { requestFailed, type Ask, type Decided, type Grade, type ImageHost, type Sent, type Settings, type Suite } from './suite.ts'
import { CONTROL, type AnimItem, type ComparedItem, type ComplexityItem, type VisualCheckItem } from './visual-check-items.ts'

export type { ImageHost } from './suite.ts'
export type { VisualCheckItem } from './visual-check-items.ts'

/** What one check came to: the mod's `CheckResult` less the check, which the item holds. */
export type CheckOutcome = { verdict: Verdict; probability: number | null; basis: Basis; why?: string }

/**
 * The suite's answer: the outcome of each check (the mod's verdicts), or the level a group of references read as. `always` is a
 * baseline, a tool that gave the same verdict to every check.
 */
export type VisualPrediction = { kind: 'checks'; outcomes: CheckOutcome[] } | { kind: 'level'; level: number } | { kind: 'always'; verdict: Verdict }

/**
 * How it asks. `mod`: as the mod does with the decision model of the run: Jev gets the Box questions beside the checks and the zoomed
 * re-check after them (#59), pplx the whole images only. `whole`: the first request alone, the whole images, as before #59 and as pplx
 * does it: what the zoom adds is what the two give apart.
 */
export const VISUAL_VARIANTS = ['mod', 'whole'] as const

/** One request of an item, for the figures: what it held and what it cost. */
export type RequestDetail = { questions: number; images: number; ms: number; tokens: number | null }

/** What the suite keeps of a check's answer: the raw probabilities and what was true, for the figures and for sweeping the bars. */
export type CheckDetail = {
  part: string
  property: string
  /** The truth: the part is the same, or the requirement holds. */
  holds: boolean
  verdict: Verdict
  /** The probability the verdict rests on (null: none), and whether it is the crop's (`zoom`) or the whole images' (`whole`). */
  p: number | null
  basis: Basis
  /** What the probability may decide: a pass and a fail, or only a fail (a match with a reference cannot be confirmed from the whole images). */
  trust: 'both' | 'fail'
  /** The probability the whole images gave, whatever the verdict rests on. */
  whole: number | null
  why?: string
}

/** The row's detail for a check item. */
export type CheckedDetail = { kind: 'ui' | 'sea' | 'anim'; images: number; checks: CheckDetail[]; elsewhere: { confidence: number; area: number } | null; requests: RequestDetail[] }
/** The row's detail for a complexity item: the level's probabilities, as the answer gave them, and the expected level they come to. */
export type ReadingDetail = { kind: 'complexity'; images: number; p: number[]; expected: number | null; requests: RequestDetail[] }

const requestDetail = (sent: Sent): RequestDetail => ({
  questions: Object.keys(sent.request.questions).length,
  images: sent.request.images?.length ?? 0,
  ms: Math.round(sent.ms),
  tokens: sent.asked.ok ? sent.asked.inputTokens : null,
})

/** `count` of `frames`, evenly spread, the first and the last among them (what a recording is cut into for a decision model that takes fewer: pplx's 8). */
export function evenly<T>(frames: readonly T[], count: number): T[] {
  if (frames.length <= count) return [...frames]
  return Array.from({ length: count }, (_, i) => frames[Math.round((i * (frames.length - 1)) / (count - 1))] as T)
}

/** The tool's own trace of an item's requests: what `ask` sent, in order. */
function traced(ask: Ask): { ask: Ask; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    ask: async (request) => {
      const one = await ask(request)
      sent.push(one)
      return one
    },
  }
}

const asAsked = (ask: Ask) => async (request: DecisionRequest): Promise<Asked> => (await ask(request)).asked

/** What an item with checks is asked as: against the reference image(s), or, for a motion, against its spec (on its frames alone). */
const comparisonOf = (item: ComparedItem | AnimItem): Comparison => (item.kind === 'anim' ? { kind: 'spec', spec: item.asked.spec } : { kind: 'reference', paths: item.asked.reference })

/** The images of a compared item, loaded as the mod loads a call's (features/visual-check.ts `subjectsOf`): within the model's limits, together within its token budget. */
const loadCompared = (files: ImageFilesIo, paths: readonly string[], backend: BackendName, checks: number): Promise<LoadedAll> => loadAll(files, paths, limitsFor(backend), imageMegapixelBudget(backend, checks))

/** What an item's verdicts say beside the truth: a part that is the same (`holds`) judged FAIL, a part that differs judged PASS. */
function outcomeOf(result: CheckResult, whole: CheckResult | undefined, compared: boolean): { outcome: CheckOutcome; trust: 'both' | 'fail'; whole: number | null } {
  const outcome: CheckOutcome = { verdict: result.verdict, probability: result.probability, basis: result.basis, ...(result.why === undefined ? {} : { why: result.why }) }
  return { outcome, trust: compared && result.basis === 'whole' ? 'fail' : 'both', whole: whole?.probability ?? null }
}

/** The area of a box the whole-screen question gave, as a share of the screen. */
const areaOf = (box: { top: number; bottom: number; left: number; right: number }): number => (box.right - box.left) * (box.bottom - box.top)

/** The suite. `images` is what a run gives it to read and cut pictures with (SuiteHost.images); without it every item says so. */
export function visualCheckSuite(images: ImageHost | undefined): Suite<VisualCheckItem, VisualPrediction> {
  async function decideCompared(item: ComparedItem, variant: string, ask: Ask, backend: BackendName, host: ImageHost): Promise<Decided<VisualPrediction>> {
    const { screenshot, reference, checks } = item.asked
    const comparison = comparisonOf(item)
    if (backend === 'pplx' && reference.length + 1 > PPLX_MAX_IMAGES) return { ok: false, failure: `images: pplx takes at most ${PPLX_MAX_IMAGES} images in one request` }
    const loaded = await loadCompared(host.io, [screenshot, ...reference].map(host.path), backend, checks.length)
    if (!loaded.ok) return { ok: false, failure: `images: ${loaded.reason}` }
    const [candidate, ...others] = loaded.images as [LoadedImage, ...LoadedImage[]]
    const traces = traced(ask)
    // The first request: every check about the whole images; with Jev, beside them the Box questions that locate the named parts (#59).
    const whole = wholeImageRequest(comparison, { screenshot: candidate, references: others }, checks)
    const names = comparedNames(comparison, others.length)
    const sameViews = others.map((other) => sameView(item.asked.same_view, candidate, other))
    const plan = backend === 'jev' && variant === 'mod' ? locatePlan(names, sameViews, checks) : null
    const sent = await traces.ask(plan === null ? whole.request : withBoxes(whole, plan))
    if (!sent.asked.ok) return requestFailed(sent.asked.failure)
    const wholeResults = readWholeImage(comparison, whole.part, sent.asked.answers, checks)
    let results = wholeResults
    let elsewhere: CheckedDetail['elsewhere'] = null
    // The zoomed re-check: the crops decide where they could be made; the whole images give only a fail where they could not.
    if (plan !== null) {
      const zoomed = await zoomReview({ files: host.io, ask: asAsked(traces.ask), backend }, { candidate, others, names, sameViews }, checks, wholeResults, plan, readLocated(plan, sent.asked.answers))
      results = zoomed.results
      if (zoomed.elsewhere !== null) elsewhere = { confidence: zoomed.elsewhere.place.confidence, area: areaOf(zoomed.elsewhere.place.box) }
    }
    return decided(item, results, wholeResults, true, loaded.images.length, elsewhere, traces.sent)
  }

  async function decideAnim(item: AnimItem, ask: Ask, backend: BackendName, host: ImageHost): Promise<Decided<VisualPrediction>> {
    const { checks, spec } = item.asked
    // pplx takes eight frames at the most: a recording is cut into fewer for it (FRAME_COUNT), here the dataset's frames are spread so.
    const frames = evenly(item.asked.frames, FRAME_COUNT[backend])
    const loaded = await loadCompared(host.io, frames.map((frame) => host.path(frame.file)), backend, checks.length)
    if (!loaded.ok) return { ok: false, failure: `images: ${loaded.reason}` }
    const traces = traced(ask)
    const { request, part } = framesRequest(spec, loaded.images.map((picture, i) => ({ picture, seconds: (frames[i] as { seconds: number }).seconds })), checks)
    const sent = await traces.ask(request)
    if (!sent.asked.ok) return requestFailed(sent.asked.failure)
    // A motion is judged by the bars of a recording, as the mod judges the frames of one.
    const results = readWholeImage(comparisonOf(item), part, sent.asked.answers, checks, RECORDING_BARS)
    return decided(item, results, results, false, loaded.images.length, null, traces.sent)
  }

  /** The row's prediction and detail for an item with checks. */
  function decided(item: ComparedItem | AnimItem, results: readonly CheckResult[], wholeResults: readonly CheckResult[], compared: boolean, images: number, elsewhere: CheckedDetail['elsewhere'], sent: readonly Sent[]): Decided<VisualPrediction> {
    const read = results.map((result, i) => outcomeOf(result, wholeResults[i], compared))
    const detail: CheckedDetail = {
      kind: item.kind,
      images,
      checks: read.map(({ outcome, trust, whole }, i) => ({
        part: (item.asked.checks[i] as Check).part,
        property: (item.asked.checks[i] as Check).property,
        holds: item.gold.holds[i] as boolean,
        verdict: outcome.verdict,
        p: outcome.probability,
        basis: outcome.basis,
        trust,
        whole,
        ...(outcome.why === undefined ? {} : { why: outcome.why }),
      })),
      elsewhere,
      requests: sent.map(requestDetail),
    }
    return { ok: true, prediction: { kind: 'checks', outcomes: read.map(({ outcome }) => outcome) }, detail: detail as unknown as Record<string, unknown> }
  }

  async function decideComplexity(item: ComplexityItem, ask: Ask, backend: BackendName, host: ImageHost): Promise<Decided<VisualPrediction>> {
    const traces = traced(ask)
    // The group is read as the mod reads one (core/complexity.ts): its images brought to about a megapixel, one Score question. A store of its own, so that no group is read from a cache.
    let kept: { value: ReferenceReadings | undefined; version: number } = { value: undefined, version: 0 }
    const io: ComplexityIo = {
      files: host.io,
      ask: asAsked(traces.ask),
      store: {
        get: async () => kept,
        set: async (value, options) => {
          if (options.ifVersion !== kept.version) return { isSet: false, version: kept.version }
          kept = { value, version: kept.version + 1 }
          return { isSet: true, version: kept.version }
        },
      },
      now: async () => 0,
      backend,
    }
    const read = await readReferenceComplexity(io, item.asked.references.map((path) => ({ path: host.path(path) })))
    if (!read.ok) return { ok: false, failure: read.failure === undefined ? `reading: ${read.reason}` : requestFailed(read.failure).failure }
    // The probabilities the answer gave the five levels, as the mod's reading takes them.
    const answered = traces.sent.flatMap((one) => (one.asked.ok ? [one.asked.answers[`complexity.${COMPLEXITY_LEVEL}`]] : [])).at(-1) as { probabilities?: Record<string, number> } | undefined
    const p = COMPLEXITY_LEVELS.map((_, i) => Math.round((answered?.probabilities?.[String(i)] ?? 0) * 1000) / 1000)
    const detail: ReadingDetail = { kind: 'complexity', images: read.reading.images, p, expected: expectedLevel(p), requests: traces.sent.map(requestDetail) }
    return { ok: true, prediction: { kind: 'level', level: read.reading.level }, detail: detail as unknown as Record<string, unknown> }
  }

  return {
    name: 'visual-check',
    variants: VISUAL_VARIANTS,
    // Chinese only, as eval-v2's: the questions are the mod's English whatever the language, so there is no other side to ask.
    languages: ['zh'],
    async decide(item, language: Language, variant, ask, settings) {
      if (language !== 'zh') return { ok: false, failure: 'the questions are in English whichever the language: run with --languages zh' }
      if (!(VISUAL_VARIANTS as readonly string[]).includes(variant)) throw new RangeError(`no variant "${variant}" (${VISUAL_VARIANTS.join(', ')})`)
      if (images === undefined) return { ok: false, failure: 'config: this run has no host for pictures and programs (SuiteHost.images)' }
      const backend = settings.backend
      if (item.kind === 'complexity') return decideComplexity(item, ask, backend, images)
      if (item.kind === 'anim') return decideAnim(item, ask, backend, images)
      return decideCompared(item, variant, ask, backend, images)
    },
    grade: gradeItem,
    show: (prediction) => (prediction.kind === 'level' ? `level ${prediction.level}` : prediction.kind === 'always' ? `always ${prediction.verdict}` : prediction.outcomes.map((outcome) => outcome.verdict).join(' ')),
    constants: [
      { kind: 'always', verdict: 'pass' },
      { kind: 'always', verdict: 'fail' },
      { kind: 'always', verdict: 'unsure' },
    ],
    questions: questionsOf,
    estimate: async (item, language, variant, settings) => {
      const planned: DecisionRequest[] = []
      await visualCheckSuite(images).decide(item, language, variant, async (request) => {
        planned.push(request)
        return answeredAt(request)
      }, settings)
      return planned
    },
    breakdown: breakdownOf,
    report: reportOf,
    scoring:
      'An item with checks: each check holds (the part is the same as in the reference, or the frames meet the requirement) or does not. A check that holds is right when it is judged PASS, a check that does not hold when it is judged FAIL; UNSURE is neither right nor wrong. ' +
      'The item is `correct` when none of its checks is judged the wrong way round (`false-pass`: a part that differs judged PASS, which must not happen; `false-fail`: a part that is the same judged FAIL), `exact` when every check is right: an item all UNSURE is correct and not exact, so read `exact` and the figures, not `correct` alone. ' +
      'A complexity item: right when the level the group reads as is in gold.accept, exact when it is gold.level; whether the groups read in the order of their rank is in the figures (`complexity`). ' +
      'The verdicts are the mod\'s (PASS from 0.8, FAIL up to 0.2 for a screenshot and up to 0.4 for the frames of a motion, as of 2026-10-15; against a reference a PASS is the crop\'s and a whole image only fails, ADR 0008); the raw probabilities are kept with each answer, and `thresholds` gives what other bars would have said. Controls are the items in which nothing differs.',
    about: {
      variants:
        '`mod`: as the mod asks with the run\'s decision model: against a reference, Jev gets the checks and the Box questions in the first request and the zoomed re-check on the crops after it, pplx the first request alone; a motion is its frames in one request against its spec; a group of references is the complexity reading. ' +
        '`whole`: the first request alone with every decision model, so that what the zoomed re-check adds can be read from the two.',
      images: 'The experiment\'s pictures (2026-10-15), copied into eval/datasets/visual-check/; sized and cut as the mod does (core/image-files.ts, core/zoom-review.ts, sips). A motion is its 12 frames as files (8 of them for pplx), not a recording: the mod\'s ffmpeg is not run.',
    },
  }
}

// ---- Grading ---------------------------------------------------------------------------------------------------------------

/** How one check was answered: right, wrong the way round it was, or neither (UNSURE). */
function judged(holds: boolean, verdict: Verdict): 'right' | 'false-pass' | 'false-fail' | 'unsure' {
  if (verdict === 'unsure') return 'unsure'
  if (verdict === 'pass') return holds ? 'right' : 'false-pass'
  return holds ? 'false-fail' : 'right'
}

function gradeItem(item: VisualCheckItem, prediction: VisualPrediction): Grade {
  if (item.kind === 'complexity') {
    if (prediction.kind !== 'level') return { correct: false, exact: false, miss: 'no-level' }
    const correct = item.gold.accept.includes(prediction.level)
    const lowest = Math.min(...item.gold.accept)
    return { correct, exact: prediction.level === item.gold.level, ...(correct ? {} : { miss: prediction.level < lowest ? 'under' : 'over' }) }
  }
  if (prediction.kind === 'level') return { correct: false, exact: false, miss: 'no-verdicts' }
  const verdicts = prediction.kind === 'always' ? item.gold.holds.map(() => prediction.verdict) : prediction.outcomes.map((outcome) => outcome.verdict)
  const how = item.gold.holds.map((holds, i) => judged(holds, verdicts[i] ?? 'unsure'))
  const wrong = how.includes('false-pass') ? 'false-pass' : how.includes('false-fail') ? 'false-fail' : null
  return { correct: wrong === null, exact: how.every((one) => one === 'right'), ...(wrong === null ? {} : { miss: wrong }) }
}

// ---- Asking nothing: the estimate and the questions' wording ----------------------------------------------------------------

/** An answer to every question of a request, as the middle of nowhere: Box questions the middle of the image, Noul 0.5, Score even: what an estimate lets the flow go on with. */
function answeredAt(request: DecisionRequest): Sent {
  const answers: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'box') answers[id] = { type: 'box', box: { top: 0.25, bottom: 0.75, left: 0.25, right: 0.75 }, confidence: 0.5 }
    else if (question.type === 'score') answers[id] = { type: 'score', score: 2, probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), 1 / question.criteria.length])), confidence: 0.5 }
    else if (question.type === 'choice') answers[id] = { type: 'choice', choice: Object.keys(question.criteria)[0] ?? '', probabilities: {}, confidence: 0.5 }
    else answers[id] = { type: 'noul', noul: 0.5 }
  }
  return { request, asked: { ok: true, answers, model: null, inputTokens: null }, ms: 0, attempts: 0 }
}

/** The wording of what a variant asks, written out beside the results: one worked example of each question the mod's builders make. */
function questionsOf(variant: string): unknown {
  const picture = { format: 'png' as const, base64: '', width: 800, height: 600 }
  const check: Check = { part: '<part>', property: '<property>' }
  const compared = wholeImageRequest({ kind: 'reference', paths: ['<reference>'] }, { screenshot: picture, references: [picture] }, [check])
  const spec = wholeImageRequest({ kind: 'spec', spec: '<spec>' }, { screenshot: picture, references: [] }, [check])
  const out: Record<string, unknown> = {
    againstAReference: compared.request.questions,
    againstASpec: spec.request.questions,
    frames: framesRequest('<spec>', [{ picture, seconds: 0 }], [check]).request.questions,
    complexity: complexityRequest([picture]).request.questions,
  }
  if (variant === 'mod') {
    const plan = locatePlan(['reference'], [true], [check])
    out.locating = Object.fromEntries(plan.parts.flatMap((part) => Object.entries(part.questions).map(([id, question]) => [`${part.part}.${id}`, question])))
    const crop = { name: 'crop', picture }
    const pair: ZoomPair = { index: 0, reference: 0, check, candidate: crop, other: { name: 'other', picture }, otherField: 'reference_crop' }
    out.zoomedReCheck = zoomRequest(batchPairs([pair])[0] as ZoomPair[]).request.questions
  }
  return out
}

// ---- Figures ----------------------------------------------------------------------------------------------------------------

/**
 * What the bars were swept over: PASS from, FAIL up to. The mod's sets are in the grid: a screenshot (PASS_AT 0.8, FAIL_AT 0.2),
 * a recording (0.8, RECORDING_FAIL_AT 0.4), a series (SERIES_PASS_AT 0.9, 0.2).
 */
export const SWEPT = { passAt: [0.7, 0.75, PASS_AT, 0.85, SERIES_PASS_AT, 0.95], failAt: [0.1, FAIL_AT, 0.3, RECORDING_FAIL_AT] } as const

/** The verdict a probability gives at other bars (`judge` of the mod, with the bars given). */
export function verdictAt(p: number | null, trust: 'both' | 'fail', passAt: number, failAt: number): Verdict {
  return judge(p, trust, { passAt, failAt }).verdict
}

/** The expected level of the five probabilities (the mod rounds this for its reading; unrounded it tells two groups of one level apart). */
export function expectedLevel(p: readonly number[]): number | null {
  const sum = p.reduce((a, b) => a + b, 0)
  return sum > 0 ? Math.round((p.reduce((total, one, i) => total + (one / sum) * i, 0)) * 1000) / 1000 : null
}

type Counts = { checks: number; differ: number; same: number; caught: number; falsePass: number; falseFail: number; unsureDiffer: number; unsureSame: number; right: number }
const emptyCounts = (): Counts => ({ checks: 0, differ: 0, same: 0, caught: 0, falsePass: 0, falseFail: 0, unsureDiffer: 0, unsureSame: 0, right: 0 })

function count(into: Counts, holds: boolean, verdict: Verdict): void {
  into.checks++
  if (holds) into.same++
  else into.differ++
  const how = judged(holds, verdict)
  if (how === 'right') into.right++
  if (how === 'right' && !holds) into.caught++
  if (how === 'false-pass') into.falsePass++
  if (how === 'false-fail') into.falseFail++
  if (how === 'unsure') {
    if (holds) into.unsureSame++
    else into.unsureDiffer++
  }
}

const share = (n: number, of: number): number | null => (of === 0 ? null : rate(n, of))
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100)

/** What the answers of one variant come to: the ticket's measures. `prices`: the price of an input token, for the cost of each image (none: no dollars). */
export function breakdownOf(items: readonly VisualCheckItem[], rows: readonly Row<VisualPrediction>[], _variant: string, _settings: Settings, prices?: { usdPerMillionTokens: number }): Record<string, unknown> {
  const byId = new Map(rows.filter((row) => row.language === 'zh').map((row) => [row.id, row]))
  const answered = items.flatMap((item) => {
    const row = byId.get(item.id)
    const detail = row?.detail as unknown as CheckedDetail | ReadingDetail | null | undefined
    return row?.ok === true && detail != null ? [{ item, row, detail }] : []
  })
  const checked = answered.flatMap(({ item, row, detail }) => (detail.kind === 'complexity' ? [] : [{ item, row, detail }]))
  // Every check of every answered item, with the item it is in.
  const all = checked.flatMap(({ item, detail }) => detail.checks.map((check) => ({ item, check, control: item.tags.includes(CONTROL) })))
  const total = emptyCounts()
  const byKind: Record<string, Counts> = {}
  for (const { item, check } of all) {
    count(total, check.holds, check.verdict)
    count((byKind[item.kind] ??= emptyCounts()), check.holds, check.verdict)
  }
  const controls = all.filter(({ control }) => control)
  const controlFails = controls.filter(({ check }) => check.verdict === 'fail')
  const falsePasses = all.filter(({ check }) => !check.holds && check.verdict === 'pass')
  const answeredChecks = all.length
  const unsure = all.filter(({ check }) => check.verdict === 'unsure').length

  const sweep = SWEPT.passAt.flatMap((passAt) =>
    SWEPT.failAt.map((failAt) => {
      const counts = emptyCounts()
      for (const { check } of all) count(counts, check.holds, verdictAt(check.p, check.trust, passAt, failAt))
      return { passAt, failAt, falsePass: counts.falsePass, caught: counts.caught, differ: counts.differ, falseFail: counts.falseFail, same: counts.same, unsureRate: share(counts.unsureDiffer + counts.unsureSame, counts.checks) }
    }),
  )

  const usdOf = (tokens: number) => (prices === undefined ? null : (tokens * prices.usdPerMillionTokens) / 1e6)
  const cost = (members: typeof answered) => {
    const pictures = members.reduce((sum, { detail }) => sum + detail.images, 0)
    const tokens = members.reduce((sum, { row }) => sum + (row.inputTokens ?? 0), 0)
    const ms = members.reduce((sum, { row }) => sum + (row.ms ?? 0), 0)
    const usd = usdOf(tokens)
    return {
      items: members.length,
      images: pictures,
      tokens,
      perImage: { tokens: pictures === 0 ? null : Math.round(tokens / pictures), ms: pictures === 0 ? null : Math.round(ms / pictures), usd: usd === null || pictures === 0 ? null : Number((usd / pictures).toFixed(6)) },
      perItem: { tokens: members.length === 0 ? null : Math.round(tokens / members.length), ms: members.length === 0 ? null : Math.round(ms / members.length), usd: usd === null || members.length === 0 ? null : Number((usd / members.length).toFixed(6)) },
      usd: usd === null ? null : Number(usd.toFixed(6)),
    }
  }

  // The groups of reference images, in the order the dataset gives them (rank): do they read in that order?
  const groups = answered
    .flatMap(({ item, detail }) => (item.kind === 'complexity' && detail.kind === 'complexity' ? [{ id: item.id, rank: item.gold.rank, gold: item.gold.level, level: byId.get(item.id)?.prediction?.kind === 'level' ? (byId.get(item.id)?.prediction as { level: number }).level : null, expected: detail.expected, p: detail.p }] : []))
    .sort((a, b) => a.rank - b.rank)
  const increasing = (values: readonly (number | null)[], strictly: boolean): boolean | null => (values.length < 2 || values.some((value) => value === null) ? null : values.every((value, i) => i === 0 || (strictly ? (value as number) > (values[i - 1] as number) : (value as number) >= (values[i - 1] as number))))

  return {
    checks: { total: total.checks, differ: total.differ, same: total.same, controlChecks: controls.length, answeredItems: checked.length },
    // The ticket's measures. falsePass must be 0: a check that does not hold, judged PASS.
    falsePass: { count: falsePasses.length, of: total.differ, items: [...new Set(falsePasses.map(({ item }) => item.id))] },
    controlFails: { count: controlFails.length, of: controls.length, items: [...new Set(controlFails.map(({ item }) => item.id))] },
    falseFail: { count: total.falseFail, of: total.same },
    caught: { count: total.caught, of: total.differ, rate: share(total.caught, total.differ) },
    unsure: { count: unsure, of: answeredChecks, rate: share(unsure, answeredChecks), onDiffering: share(total.unsureDiffer, total.differ), onSame: share(total.unsureSame, total.same) },
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, own]) => [kind, { checks: own.checks, differ: own.differ, caught: own.caught, falsePass: own.falsePass, same: own.same, falseFail: own.falseFail, unsure: share(own.unsureDiffer + own.unsureSame, own.checks) }])),
    // Another place that differs reported by the whole-screen question: on an item with nothing to find it is a false alarm.
    elsewhere: {
      reported: checked.filter(({ detail }) => detail.elsewhere !== null).length,
      onControls: checked.filter(({ item, detail }) => item.tags.includes(CONTROL) && detail.elsewhere !== null).map(({ item }) => item.id),
    },
    cost: {
      all: cost(answered),
      byKind: Object.fromEntries((['ui', 'sea', 'anim', 'complexity'] as const).flatMap((kind) => (answered.some(({ item }) => item.kind === kind) ? [[kind, cost(answered.filter(({ item }) => item.kind === kind))]] : []))),
      requests: answered.reduce((sum, { detail }) => sum + detail.requests.length, 0),
      latencyMs: { p50: percentile(answered.map(({ row }) => row.ms), 0.5), max: Math.max(0, ...answered.map(({ row }) => row.ms ?? 0)) },
    },
    complexity: {
      groups,
      // The rounded levels the mod reads, and the unrounded expectation that tells two groups of one level apart.
      inOrder: increasing(groups.map((group) => group.level), false),
      strictlyInOrder: increasing(groups.map((group) => group.level), true),
      expectedStrictlyInOrder: increasing(groups.map((group) => group.expected), true),
      meanLevelError: mean(groups.flatMap((group) => (group.level === null ? [] : [Math.abs(group.level - group.gold)]))),
    },
    thresholds: sweep,
  }
}

function percentile(values: readonly (number | null)[], p: number): number | null {
  const sorted = values.flatMap((value) => (value === null ? [] : [value])).sort((a, b) => a - b)
  return sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number)
}

/** The figures a run prints for one variant, after the ones every suite gets. */
function reportOf(summary: VariantSummary): string[] {
  const breakdown = summary.breakdown as ReturnType<typeof breakdownOf> | undefined
  if (breakdown === undefined) return []
  const pct = (figure: number | null | undefined) => (figure == null ? '-' : `${(figure * 100).toFixed(1)}%`)
  const num = (figure: number | boolean | null | undefined) => (figure == null ? '-' : String(figure))
  const variant = summary.variant
  const falsePass = breakdown.falsePass as { count: number; of: number; items: string[] }
  const controlFails = breakdown.controlFails as { count: number; of: number; items: string[] }
  const falseFail = breakdown.falseFail as { count: number; of: number }
  const caught = breakdown.caught as { count: number; of: number; rate: number | null }
  const unsure = breakdown.unsure as { count: number; of: number; rate: number | null; onDiffering: number | null; onSame: number | null }
  const cost = breakdown.cost as { all: { perImage: { tokens: number | null; ms: number | null; usd: number | null }; usd: number | null; images: number; tokens: number }; byKind: Record<string, { perImage: { tokens: number | null; ms: number | null; usd: number | null } }>; latencyMs: { p50: number | null; max: number } }
  const complexity = breakdown.complexity as { groups: { id: string; level: number | null; expected: number | null; gold: number }[]; inOrder: boolean | null; strictlyInOrder: boolean | null; expectedStrictlyInOrder: boolean | null }
  const elsewhere = breakdown.elsewhere as { reported: number; onControls: string[] }
  return [
    `${variant}: a part that differs judged PASS: ${falsePass.count} of ${falsePass.of}${falsePass.count > 0 ? ` (${falsePass.items.join(', ')})` : ' (it must be none)'}; the controls judged FAIL: ${controlFails.count} of ${controlFails.of} checks${controlFails.count > 0 ? ` (${controlFails.items.join(', ')})` : ''}; a part that is the same judged FAIL: ${falseFail.count} of ${falseFail.of}`,
    `${variant}: the differences caught (FAIL): ${caught.count} of ${caught.of} (${pct(caught.rate)}); UNSURE ${unsure.count} of ${unsure.of} checks (${pct(unsure.rate)}; on the ones that differ ${pct(unsure.onDiffering)}, on the ones that are the same ${pct(unsure.onSame)}); another place reported on ${elsewhere.reported} items${elsewhere.onControls.length > 0 ? `, on the controls ${elsewhere.onControls.join(', ')}` : ''}`,
    `${variant}: each image costs ${num(cost.all.perImage.tokens)} input tokens, ${num(cost.all.perImage.ms)} ms${cost.all.perImage.usd === null ? '' : `, $${cost.all.perImage.usd}`} (${cost.all.images} images, ${cost.all.tokens} tokens${cost.all.usd === null ? '' : `, $${cost.all.usd}`}); by kind ${Object.entries(cost.byKind).map(([kind, c]) => `${kind} ${num(c.perImage.tokens)} tokens ${num(c.perImage.ms)} ms`).join(', ')}; an item takes ${num(cost.latencyMs.p50)} ms at the median, ${cost.latencyMs.max} ms at most`,
    `${variant}: the groups of reference images read as ${complexity.groups.map((group) => `${group.id} ${num(group.level)} (expected ${num(group.expected)}, gold ${group.gold})`).join(', ')}: in order ${num(complexity.inOrder)}, strictly ${num(complexity.strictlyInOrder)}, by the unrounded expectation ${num(complexity.expectedStrictlyInOrder)}`,
  ]
}

