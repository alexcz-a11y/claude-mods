// The effort-midrun suite: the main agent's effort at an event of a running turn (ADR 0020, decision/midrun.ts). An item is the
// state of a turn at the moment the mod asks: the task, the latest steps with each call's target, outcome and first error
// line, the facts the code counted, what the event brings (the task list's next item, a report delivered into the turn, the
// two failures a failure that came back compares), and where the turn stands (the level it goes out at, the level its message
// was decided at, whether an earlier failure already read as stuck). It replaces the 0.8.x `effort-midturn` suite, whose items
// were asked every few steps; the 100 items are the old ones converted, the rest are new (eval/datasets/README.md).
//
// The request is the mod's own, built by its own functions and nothing else (ADR 0005): `midrunState` over the item's
// `MidrunInput`, `midrunPart` with the two failures, `mergeParts`. The answers are read as the mod reads them: `answersFor`,
// `readEffort`, `midrunSignals`, and the level is what `decideMidrun` returns for the item's position. That level (`sent`) is
// what is graded against `accept`: the Score alone, the red flags, the one-way ratchet and the bars are all in it. Beside it
// each answer records the level the Score picks alone (`picked`), the move, every Noul's probability, each level's
// probability and the confidence, so that another reading of the same answers needs no new request.
//
// Variants (eval variables; the questions are English whatever the variant, as the mod asks them; every item is asked in both
// languages of its state, so `zh` and `en` rows are the state's content language):
//   mod           the state as the mod sends it (the first)
//   no-facts      the state without `facts`: what the code's counting adds
//   with-outputs  every call's `error` carries what the 0.8.x dataset said of how the call went (ok calls too), cut as the mod
//                 cuts an error line: the information the mod never sends. Not the mod's request.
//
// Not in the position an item has: the gap since the last switch and the turn's switches (none: a hold never applies), and the
// `/dp midrun-down` switch (on, its default). A report event is a step that carries input already, so no row is appended (`free`).
//
// Pure: no Node API.

import { EFFORTS, readEffort, type Effort } from '../../hooks/decision/effort.ts'
import type { Guide } from '../../hooks/decision/guides.ts'
import { decideMidrun, MIDRUN_LEVEL, midrunPart, midrunSignals, midrunState, type MidrunDecision, type MidrunInput, type MidrunPosition, type MidrunSignals } from '../../hooks/decision/midrun.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import type { EffortMidrunItem, Language, MidrunAsked } from './datasets.ts'
import { gradeEffort, guideFor } from './effort-submit.ts'
import { percentText, share, type VariantSummary } from './metrics.ts'
import { midrunDirection, MIDRUN_EVENTS } from './midrun-items.ts'
import type { Row } from './runner.ts'
import { requestFailed, variantIn, type Settings, type Suite } from './suite.ts'

export { guideFor }

/** One way of asking: with the facts or without, and with each call's error line or with what the old dataset said of how it went. */
type MidrunVariant = { facts: boolean; outputs: boolean }

/** The variants by name; the first is the state as the mod sends it. */
export const MIDRUN_VARIANTS: Readonly<Record<string, MidrunVariant>> = {
  mod: { facts: true, outputs: false },
  'no-facts': { facts: false, outputs: false },
  'with-outputs': { facts: true, outputs: true },
}

function variantOf(variant: string): MidrunVariant {
  return variantIn(MIDRUN_VARIANTS, variant)
}

/**
 * What the mod builds a request from (decision/midrun.ts `MidrunInput`, features/midrun-effort.ts `judge`), from one language of
 * an item: its steps without the `result` (the mod never sends how a call went, only its first error line), its facts, and what the
 * event brings. Under `with-outputs` the `error` of every call is its `result`: the free-text field of a call is the only way
 * the mod's state carries a line about a call, and the mod's own cut applies to it.
 */
export function midrunInput(asked: MidrunAsked, variant: MidrunVariant): MidrunInput {
  return {
    task: asked.task,
    recent_steps: asked.recent_steps.map((step) => ({
      step: step.step,
      assistant_text: step.assistant_text,
      tools: step.tools.map((tool) => {
        const error = variant.outputs ? tool.result : tool.error
        return { tool: tool.tool, target: tool.target, outcome: tool.outcome, ...(error === undefined ? {} : { error }) }
      }),
    })),
    facts: variant.facts ? asked.facts : [],
    ...(asked.constraints === undefined ? {} : { constraints: asked.constraints }),
    ...(asked.report === undefined ? {} : { report: asked.report }),
    ...(asked.next_item === undefined ? {} : { next_item: asked.next_item }),
  }
}

/**
 * The request the mod sends at the item's event in `language`: the state over the item's input, the part with the two failures
 * `same_failure` compares (a failure that came back after a fix, or on the same line), asked as the settings' decision model is.
 * The part is returned to read the answers by.
 */
export function midrunRequest(item: EffortMidrunItem, language: Language, variant: string, settings: Settings): { request: DecisionRequest; part: Part } {
  const asked = item[language]
  const part = midrunPart(settings.ask.turnStart, asked.failures === undefined ? {} : { failures: asked.failures })
  return { request: mergeParts(midrunState(midrunInput(asked, variantOf(variant))), [part]), part }
}

/**
 * Where the turn stands when the mod asks (`MidrunPosition`): the item's own level, base, floor and event; a ratchet where an
 * earlier failure already read as stuck (a flag that is raised for it closes the way down, features/midrun-effort.ts); the switch
 * for lowering on; no switch yet this turn.
 */
export function midrunPosition(item: EffortMidrunItem): MidrunPosition {
  return {
    current: item.current,
    base: item.base,
    ruleFloor: item.rule_floor,
    event: item.event,
    ratchet: item.stuck_before,
    stuckBefore: item.stuck_before,
    downAllowed: true,
    free: item.event === 'report',
    sinceSwitch: null,
    switches: 0,
  }
}


const round = (p: number | null): number | null => (p === null ? null : Math.round(p * 1000) / 1000)

/** What a result row keeps of a decision: the Score alone, the level sent and the move, every probability, the confidence. */
export function midrunDetail(reading: { probabilities: readonly number[]; confidence: number | null }, signals: MidrunSignals, decision: MidrunDecision, guide: Guide): Record<string, unknown> {
  return {
    picked: decision.picked,
    sent: decision.effort,
    move: decision.move,
    reason: decision.reason,
    p: reading.probabilities.map((p) => Math.round(p * 1000) / 1000),
    confidence: reading.confidence,
    noul: {
      cause_unknown: round(signals.causeUnknown),
      env_failure: round(signals.envFailure),
      new_ground: round(signals.newGround),
      mechanical_rest: round(signals.mechanicalRest),
      same_failure: round(signals.sameFailure),
      stakes_undo: round(signals.stakes.undo),
      stakes_live: round(signals.stakes.live),
      stakes_access: round(signals.stakes.access),
    },
    flagged: decision.flagged,
    stuck: decision.stuck,
    guide: guide.name,
  }
}

/**
 * The levels the code can send from an item's position at one event (decision/midrun.ts): the one it is at; a raise (to high at
 * once from under it, one level at a time above it, max included; a stake straight to xhigh); the
 * message's level again, for a loop that was raised; one level under the message's, for a loop at it, at an event that is no
 * failure. An item none of whose `accept` levels is among them cannot be answered right by the code, whatever the decision model says.
 */
export function reachableLevels(item: Pick<EffortMidrunItem, 'current' | 'base' | 'event'>): Effort[] {
  const at = (level: Effort): number => EFFORTS.indexOf(level)
  const named = (index: number): Effort => EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, index))] as Effort
  const levels = new Set<Effort>([item.current])
  if (at(item.current) < EFFORTS.length - 1) levels.add(named(Math.max(at('high'), at(item.current) + 1)))
  if (at(item.current) < at('xhigh')) levels.add('xhigh')
  if (item.event !== 'failure') {
    if (at(item.current) > at(item.base)) levels.add(item.base)
    if (item.current === item.base && at(item.current) > 0) levels.add(named(at(item.current) - 1))
  }
  return EFFORTS.filter((level) => levels.has(level))
}

/** The tags that belong together, for reading the errors: an item is in a group when it has any of its tags. */
export const MIDRUN_TAG_GROUPS: Readonly<Record<string, readonly string[]>> = {
  // A failure, a refusal or a surprise that is no reason to think harder.
  noise: ['expected-failure', 'noise-failure', 'env-noise', 'env-failure', 'flaky', 'hook-block', 'user-deny', 'tdd-red', 'grep-miss', 'blocked-external', 'partial-failure', 'cause-named'],
  // A failure that keeps coming back, a fix that did not mend it, a direction the work took wrongly.
  stuck: ['stuck', 'forced-escalation', 'iteration-failure', 'symptom-patching', 'wrong-direction', 'wrong-assumption', 'claimed-fix', 'unexpected-pass'],
  // The work looks finished.
  wrapup: ['wrapup', 'wrapup-partial', 'false-wrapup', 'unverified-step'],
  // The level was set by a word or by an earlier stretch of the run, not by the work ahead.
  anchoring: ['boundary-low', 'boundary-max', 'topic-trap', 'anchoring', 'just-upgraded'],
  // The rest is carrying out a decided change, however many files.
  mechanical: ['batch-mechanical', 'batch-judgment', 'long-but-easy', 'codemod', 'design-to-batch', 'mechanical-rest', 'trivial'],
  // Hard to undo, live, money, access.
  stakes: ['prod', 'irreversible', 'money', 'security', 'data-integrity', 'release', 'compliance', 'security-adjacent'],
  // Design or investigation that is still open.
  open: ['design', 'design-to-docs', 'explore-to-implement', 'debug', 'refactor', 'migration', 'concurrency', 'distributed', 'perf', 'report-new-design'],
  // What a dispatched agent, a Workflow, a skill or a report brings into the run.
  delegated: ['event-trigger', 'agent-pending', 'agent-returned', 'workflow-returned', 'workflow-pending', 'skill-load', 'report-new-design', 'report-done'],
}

type ByLanguage<T> = Record<Language, T>
const eachLanguage = <T>(figure: (language: Language) => T): ByLanguage<T> => ({ zh: figure('zh'), en: figure('en') })

/** The accuracy of the level sent, and of the level the Score picks alone, over a group of items. */
type Group = { items: number; sent: ByLanguage<number | null>; picked: ByLanguage<number | null> }

/**
 * The suite's own figures for one variant (Suite.breakdown). Accuracy is over all the group's items (an item without an answer is
 * wrong); the shares about what the code did (moved, left too high) are over the items that were answered.
 */
export type MidrunBreakdown = {
  /** Accuracy by the way an item's level should move (gold against the level the turn is at). */
  directions: ({ direction: 'up' | 'down' | 'keep' } & Group)[]
  /** Of the items whose level should be kept: the share whose level moved, and moved to outside `accept`. */
  keep: { items: number; moved: ByLanguage<number | null>; movedOutside: ByLanguage<number | null> }
  /** Of the items whose level should go down: the share left where it was, and the share left above every acceptable level. */
  down: { items: number; unchanged: ByLanguage<number | null>; leftHigh: ByLanguage<number | null> }
  /** Of the items whose level should go up: the share left where it was, and the share left under every acceptable level. */
  up: { items: number; unchanged: ByLanguage<number | null>; leftLow: ByLanguage<number | null> }
  /** The items the code cannot answer right from where the turn stands, and the accuracy over the others. */
  reachable: { items: number; unreachable: string[]; sent: ByLanguage<number | null> }
  /** The Score alone against `accept`, over all items. */
  picked: ByLanguage<number | null>
  /** How often each move was made, by language. */
  moves: ByLanguage<Record<string, number>>
  byEvent: Record<string, Group>
  byGroup: Record<string, Group>
}

function breakdownOf(items: readonly EffortMidrunItem[], rows: readonly Row<Effort>[]): MidrunBreakdown {
  const byLanguage = eachLanguage((language) => new Map(rows.filter((row) => row.language === language).map((row) => [row.id, row])))
  const rowOf = (item: EffortMidrunItem, language: Language): Row<Effort> | undefined => byLanguage[language].get(item.id)
  const sentOf = (item: EffortMidrunItem, language: Language): Effort | null => rowOf(item, language)?.prediction ?? null
  const pickedOf = (item: EffortMidrunItem, language: Language): Effort | null => {
    const picked = rowOf(item, language)?.detail?.picked
    return typeof picked === 'string' && (EFFORTS as readonly string[]).includes(picked) ? (picked as Effort) : null
  }
  const at = (level: Effort): number => EFFORTS.indexOf(level)
  const right = (item: EffortMidrunItem, language: Language) => rowOf(item, language)?.correct === true
  const pickedRight = (item: EffortMidrunItem, language: Language) => {
    const picked = pickedOf(item, language)
    return picked !== null && item.accept.includes(picked)
  }
  const accuracy = (group: readonly EffortMidrunItem[], test: (item: EffortMidrunItem, language: Language) => boolean) => eachLanguage((language) => share(group.filter((item) => test(item, language)).length, group.length))
  const answered = (group: readonly EffortMidrunItem[], language: Language) => group.filter((item) => sentOf(item, language) !== null)
  /** The share of a group's answered items for which `test` holds. */
  const among = (group: readonly EffortMidrunItem[], test: (item: EffortMidrunItem, sent: Effort) => boolean) =>
    eachLanguage((language) => {
      const given = answered(group, language)
      return share(given.filter((item) => test(item, sentOf(item, language) as Effort)).length, given.length)
    })
  const groupOf = (members: readonly EffortMidrunItem[]): Group => ({ items: members.length, sent: accuracy(members, right), picked: accuracy(members, pickedRight) })
  const highest = (item: EffortMidrunItem) => Math.max(...item.accept.map(at))
  const lowest = (item: EffortMidrunItem) => Math.min(...item.accept.map(at))

  const ofDirection = (direction: 'up' | 'down' | 'keep') => items.filter((item) => midrunDirection(item) === direction)
  const [keeping, going, rising] = [ofDirection('keep'), ofDirection('down'), ofDirection('up')]
  const cannot = items.filter((item) => !reachableLevels(item).some((level) => item.accept.includes(level)))
  const can = items.filter((item) => !cannot.includes(item))
  const events = Object.fromEntries(MIDRUN_EVENTS.map((event) => [event, items.filter((item) => item.event === event)] as const))
  const groups = Object.entries(MIDRUN_TAG_GROUPS).map(([name, tags]) => [name, items.filter((item) => item.tags.some((tag) => tags.includes(tag)))] as const)

  return {
    directions: (['up', 'down', 'keep'] as const).map((direction) => ({ direction, ...groupOf(ofDirection(direction)) })),
    keep: {
      items: keeping.length,
      moved: among(keeping, (item, sent) => sent !== item.current),
      movedOutside: among(keeping, (item, sent) => sent !== item.current && !item.accept.includes(sent)),
    },
    down: {
      items: going.length,
      unchanged: among(going, (item, sent) => sent === item.current),
      leftHigh: among(going, (item, sent) => at(sent) > highest(item)),
    },
    up: {
      items: rising.length,
      unchanged: among(rising, (item, sent) => sent === item.current),
      leftLow: among(rising, (item, sent) => at(sent) < lowest(item)),
    },
    reachable: { items: can.length, unreachable: cannot.map((item) => item.id), sent: accuracy(can, right) },
    picked: accuracy(items, pickedRight),
    moves: eachLanguage((language) => {
      const counts: Record<string, number> = {}
      for (const item of items) {
        const move = rowOf(item, language)?.detail?.move
        if (typeof move === 'string') counts[move] = (counts[move] ?? 0) + 1
      }
      return counts
    }),
    byEvent: Object.fromEntries(Object.entries(events).map(([event, members]) => [event, groupOf(members)])),
    byGroup: Object.fromEntries(groups.map(([name, members]) => [name, groupOf(members)])),
  }
}

/** The lines `eval/run.ts` prints about one variant, after the figures every suite gets. */
function reportOf(summary: VariantSummary): string[] {
  const b = summary.breakdown as MidrunBreakdown | undefined
  if (b === undefined) return []
  const both = (figure: ByLanguage<number | null>) => `${percentText(figure.zh)}/${percentText(figure.en)}`
  const directions = b.directions.map((d) => `${d.direction} ${both(d.sent)} of ${d.items}`).join(', ')
  const events = Object.entries(b.byEvent).filter(([, group]) => group.items > 0).map(([event, group]) => `${event} ${both(group.sent)} of ${group.items}`).join(', ')
  const groups = Object.entries(b.byGroup).filter(([, group]) => group.items > 0).map(([name, group]) => `${name} ${both(group.sent)} of ${group.items}`).join(', ')
  const moves = (language: Language) => Object.entries(b.moves[language]).map(([move, n]) => `${move} ${n}`).join(' ')
  return [
    `${summary.variant}: the level sent right by the way it should move (zh/en of n): ${directions}`,
    `${summary.variant}: items whose level should be kept (${b.keep.items}): moved ${both(b.keep.moved)}, moved to outside accept ${both(b.keep.movedOutside)}; items that should go down (${b.down.items}): left as they were ${both(b.down.unchanged)}, left too high ${both(b.down.leftHigh)}; items that should go up (${b.up.items}): left as they were ${both(b.up.unchanged)}, left too low ${both(b.up.leftLow)}`,
    `${summary.variant}: the Score alone right (zh/en) ${both(b.picked)}; the level sent right over the ${b.reachable.items} items the code can answer ${both(b.reachable.sent)} (${b.reachable.unreachable.length} cannot: ${b.reachable.unreachable.join(' ') || 'none'}); moves zh ${moves('zh')}; en ${moves('en')}`,
    `${summary.variant}: right by event (zh/en of n): ${events}`,
    `${summary.variant}: right by tag group (zh/en of n): ${groups}`,
  ]
}

export const effortMidrun: Suite<EffortMidrunItem, Effort> = {
  name: 'effort-midrun',
  variants: Object.keys(MIDRUN_VARIANTS),
  async decide(item, language, variant, ask, settings) {
    const { request, part } = midrunRequest(item, language, variant, settings)
    const { asked } = await ask(request)
    if (!asked.ok) return requestFailed(asked.failure)
    const answers = answersFor(part, asked.answers)
    const reading = readEffort(answers[MIDRUN_LEVEL])
    if (reading === null) return { ok: false, failure: 'parse: no effort answer' }
    const guide = guideFor(asked.model, settings)
    const signals = midrunSignals(answers)
    const decision = decideMidrun(reading, signals, midrunPosition(item), guide)
    return { ok: true, prediction: decision.effort, detail: midrunDetail(reading, signals, decision, guide) }
  },
  grade: gradeEffort,
  show: (effort) => effort,
  constants: EFFORTS,
  // Never moving the level: the answer a mid-run question is worth nothing against.
  baselines: { current: (item) => item.current },
  // What a variant asks; `same_failure` is asked only with two failures to compare, so it is shown with the shape of its instructions.
  questions: () => midrunPart({}, { failures: { latest: '<the latest first error line>', earlier: '<the first error line before the fix>' } }).questions,
  breakdown: (items, rows) => breakdownOf(items, rows),
  report: reportOf,
  scoring:
    "Right when the level decideMidrun sends (decision/midrun.ts: the Score's position and its sides, the red flags, the one-way ratchet, the bars of the guide of the model that answered) is in the item's accept; `current` scores never moving the level. " +
    'Each answer records `picked` (the level the Score picks alone), `sent`, the move and why, every Noul\'s probability (`noul`), each level\'s probability (`p`), the confidence and the guide, so another reading of the answers needs no new request. ' +
    "The position is the item's: its level, base, rule floor, event and whether an earlier failure already read as stuck (which closes the way down too); the switch for lowering is on, no switch has been made this turn, so no hold applies, and a report event is a step that carries input (`free`). " +
    'Under `with-outputs` the error of every call is what the 0.8.x dataset said of how it went, cut as the mod cuts a first error line: not the mod\'s request. ' +
    '`breakdown.directions` groups items by gold against the current level; `keep`, `down` and `up` count what the code did to each (shares of the answered items); `reachable` says which items the code cannot answer right from where the turn stands (an acceptable level it can neither reach nor keep), and the accuracy over the rest.',
}
