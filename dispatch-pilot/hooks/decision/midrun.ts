// The effort of a loop that is already running, judged again at an event of the run (ADR 0020): what the decision model is
// shown, what it is asked, and how the code turns its answers into the level the loop goes on at.
//
// Pure (see system-one.ts): the mod and the eval ask and decide alike. Written to the decision models' own guides
// (docs/research/decision-models-midrun-judgment.md has the sources):
//
//   judgments from the model, decisions in code   no question asks whether to raise or lower ("A question that asks Jev to
//                                                  make the decision ... is at the wrong layer")
//   an absolute Score                              the same five situations a message's effort is rated on; the model never
//                                                  sees the level the loop is on, so nothing anchors its answer there
//   observable signals as yes/no questions         a failure whose cause is not found, a failure of the environment, work the
//                                                  task did not describe, a rest that is only carrying out, the same failure
//                                                  again, the stakes
//   a small state                                  the task, a note on how to read the state, the latest steps oldest first
//                                                  (a tool result is only how it ended and its first error line), and the
//                                                  facts the code counted ("count in code")
//   the Score read by its sides                    the share of probability above and below the current level, each direction
//                                                  with its own bar (decision/guides.ts MIDRUN_BARS)
//   red flags by the highest, never the mean       one confident flag lifts the level ("a max-style check, not a mean")
//   a one-way ratchet                              a loop a red flag raised is not lowered below its base again
//
//   base      the Score's position rounded; TypeSafe's two peaks take it one level up, an answer the model is unsure of
//             does not (the guide's own reading, decision/guides.ts `scoreUnsure`)
//   sides     up: Σ p above the current level; down: Σ p below it
//   stakes    hard to undo, and live or about access (both yes)          → at least xhigh (not a message's max: read again
//                                                                          at every event, the two at max cost answers on all
//                                                                          three decision models, effort-midrun, ADR 0022)
//             any one stake yes                                          → at least high (one stake alone sent to xhigh lost
//                                                                          more answers than it won, on d1-ultra and on d1.1)
//   cause     at a failure: cause unknown yes, and not the environment   → at least high; from high up one level, to max at
//                                                                          most, and only when an earlier failure of the turn
//                                                                          already read so (Anthropic: "When medium stalls, try
//                                                                          high"; above high each level costs far more, and more
//                                                                          thought does not mend a wrong direction)
//             cause unknown in the band                                  → at least high
//   up        the base above the current level and up at its bar         → the base: to high at once, above high one level a
//                                                                          time, max included (no cap in the middle of a run,
//                                                                          the person's decision, ADR 0022: the decision model's
//                                                                          reading takes a loop there); not at a failure of the
//                                                                          environment (more thought does not bring a service
//                                                                          back)
//   return    the loop was raised and the answer reads at or below what the message was decided at, down at its bar, the
//             answer settled, no flag                                    → back to the message's level
//   down      the loop is on the message's level, the event is no failure, the rest is only carrying out (yes), nothing new
//             was uncovered, down at its bar, the answer settled, no ratchet → one level down, never under the message's rule
//             floors (`/dp midrun-down off` turns it off)
//   hold      a move that needs a row appended waits out the gap since the last one and the turn's cap; the turn's last
//             row is kept for a raise, except on max
//
// Missing answers lift and lower nothing.

import { clipToTokens, estimateTokens, messageText, withinTokens } from './context.ts'
import { CONSTRAINTS_FIELD, type StandingConstraint } from './constraints.ts'
import { EFFORTS, effortLevels, effortQuestion, LEVEL, STAKES_ACCESS, STAKES_LIVE, STAKES_UNDO, stakeSituations, traceEffort, type Effort, type EffortAsk, type EffortReading, type EffortStep } from './effort.ts'
import { MIDRUN_BARS, TYPESAFE_GUIDE, type Guide, type MidrunBars } from './guides.ts'
import { readNoul, verdictOrNo } from './nouls.ts'
import { redactSecrets } from './redact.ts'
import type { Answer, Part, Question, State } from './system-one.ts'

/** The mid-run part's name; its effort question is `midrun.level`, like the message's `effort.level`. */
export const MIDRUN_PART = 'midrun'
export const MIDRUN_LEVEL = LEVEL
export const CAUSE_UNKNOWN = 'cause_unknown'
export const ENV_FAILURE = 'env_failure'
export const NEW_GROUND = 'new_ground'
export const MECHANICAL_REST = 'mechanical_rest'
export const SAME_FAILURE = 'same_failure'

/** How a tool call ended, as the state says it: a call a hook or the person refused is no failure of the work. */
export type CallOutcome = 'ok' | 'failed' | 'blocked' | 'denied'

/** One tool call of a step: the tool, what it worked on (never what it wrote or returned), how it ended, and a failure's first line. */
export type MidrunTool = { tool: string; target: string; outcome: CallOutcome; error?: string }
/** One step of the run: its index, the end of what the assistant wrote in it, its tool calls (the latest of them, with the count of those before when a step made more than are kept). */
export type MidrunStep = { step: number; assistant_text: string; earlier_calls_not_shown?: number; tools: readonly MidrunTool[] }

/**
 * What made the code ask (the run's events, decision/midrun-track.ts): a failure that came back, a report delivered into the
 * run, a dispatched agent's result handed back, a skill loaded, the task list moving to its next item.
 */
export type MidrunEventKind = 'failure' | 'report' | 'handback' | 'skill' | 'todo' | 'steps'

/** What a mid-run request is built from. */
export type MidrunInput = {
  /** The message the loop works on (the turn's prompt, an agent's brief). */
  task: string
  /** The latest steps, oldest first. */
  recent_steps: readonly MidrunStep[]
  /** What the code counted and knows, one sentence each; left out when there is none. */
  facts: readonly string[]
  /** The person's lasting rules, when there are any. */
  constraints?: readonly StandingConstraint[]
  /** A report delivered into the run (a background task's notice, a dispatched agent's hand-back), as it will reach the assistant. */
  report?: string
  /** The item of the assistant's task list it has just moved to. */
  next_item?: string
  /** The two failures `same_failure` compares: the latest first error line and the one before the fix. */
  failures?: { latest: string; earlier: string }
}

export type MidrunLimits = {
  /** How many of the latest steps go along at most. */
  steps: number
  /** What the whole state may take, in estimated tokens. */
  tokens: number
}

/**
 * A few thousand tokens: both vendors say a longer state is slower and less accurate, a person could not take in more at a
 * glance (TypeSafe's human test), and the request is sent while a tool result waits. Eight steps is what Liquid's own agent
 * demo keeps of its history (`recent_actions`).
 */
export const MIDRUN_LIMITS: MidrunLimits = { steps: 8, tokens: 4000 }

/** A step's text keeps this many tokens at most, most of them from its end (what the assistant is about to do). */
const STEP_TEXT_TOKENS = 120
const STEP_TAIL = 0.75
/** What a call worked on keeps this many tokens, a failure's first line this many. */
const TARGET_TOKENS = 24
const ERROR_TOKENS = 40
/** A step shows this many of its tool calls at most, the latest ones. */
export const STEP_TOOLS = 12
/** A report keeps this many tokens (its end too: a hand-back's conclusion is there), the next item this many. */
const REPORT_TOKENS = 600
const ITEM_TOKENS = 120

/** How the state is to be read: a field of its own, as both vendors' agent-trace examples have one (`note`, `context`). */
const PROGRESS_NOTE =
  'The assistant is in the middle of its work on `task` and has not stopped to wait for the person. `recent_steps` are its latest steps, oldest first: each has the end of what the assistant wrote and its tool calls. A tool call gives what it worked on (`target`), how it ended (`outcome`) and, for a failure, its first error line (`error`); nothing a tool returned is shown. `facts` are counted by the program that runs the assistant.'

/** The arguments that say what a call worked on without carrying content, in the order they are taken. */
const TARGET_KEYS = ['description', 'skill', 'subagent_type', 'name', 'file_path', 'notebook_path', 'pattern', 'query', 'url', 'command'] as const

/**
 * What a tool call worked on, from the few arguments that say so: the call's own `description`, a skill's or an agent's name,
 * the end of a file path, a search pattern or query, a URL; else the first line of a shell command. Never what it wrote
 * (`content`, `new_string`) or anything it returned. Masked and cut short; '' when nothing fits.
 */
export function toolTarget(input: Readonly<Record<string, unknown>>): string {
  let named = ''
  for (const key of TARGET_KEYS) {
    const value = typeof input[key] === 'string' ? (input[key] as string).trim() : ''
    if (key === 'file_path' || key === 'notebook_path') named = value.split('/').filter(Boolean).slice(-2).join('/')
    else if (key === 'command') named = value.split('\n')[0] ?? ''
    else named = value
    if (named !== '') break
  }
  return clipToTokens(redactSecrets(named).replace(/\s+/g, ' ').trim(), TARGET_TOKENS)
}

function cleanText(text: string, tokens: number, tail = 0): string {
  return clipToTokens(redactSecrets(text.replace(/\s+/g, ' ').trim()), tokens, tail)
}

function cleanStep(step: MidrunStep): MidrunStep {
  const shown = step.tools.slice(-STEP_TOOLS)
  const earlier = (step.earlier_calls_not_shown ?? 0) + step.tools.length - shown.length
  return {
    step: step.step,
    assistant_text: cleanText(step.assistant_text, STEP_TEXT_TOKENS, STEP_TAIL),
    ...(earlier > 0 ? { earlier_calls_not_shown: earlier } : {}),
    tools: shown.map((tool) => ({
      tool: tool.tool,
      target: cleanText(tool.target, TARGET_TOKENS),
      outcome: tool.outcome,
      ...(tool.error === undefined || tool.error === '' ? {} : { error: cleanText(tool.error, ERROR_TOKENS) }),
    })),
  }
}

/**
 * The state of a mid-run request: `{ task, standing_constraints?, progress_note, report?, next_item?, recent_steps, facts? }`,
 * within `limits.tokens` as it is sent. The task takes at most a third, the person's lasting rules a quarter (the latest of
 * them first); the latest steps fill what is left, newest first, an older step dropped whole rather than squeezed; the newest
 * always goes, its text cut to fit and then its earliest calls. A field with nothing in it is left out (an empty list reads
 * as a signal). Secrets are masked everywhere.
 */
export function midrunState(input: MidrunInput, limits: MidrunLimits = MIDRUN_LIMITS): State {
  return withinTokens((tokens) => midrunFields(input, { ...limits, tokens }), limits.tokens)
}

function midrunFields(input: MidrunInput, limits: MidrunLimits): State {
  const constraints = latestWithin(input.constraints ?? [], Math.floor(limits.tokens / 4))
  const head = {
    task: messageText(input.task, Math.floor(limits.tokens / 3)),
    ...(constraints.length === 0 ? {} : { [CONSTRAINTS_FIELD]: constraints.map((one) => ({ ...one })) }),
    progress_note: PROGRESS_NOTE,
    ...(input.report === undefined || input.report.trim() === '' ? {} : { report: cleanText(input.report, REPORT_TOKENS, 0.5) }),
    ...(input.next_item === undefined || input.next_item.trim() === '' ? {} : { next_item: cleanText(input.next_item, ITEM_TOKENS) }),
  }
  const facts = input.facts.length === 0 ? {} : { facts: input.facts.map((fact) => redactSecrets(fact)) }
  let room = limits.tokens - estimateTokens(JSON.stringify({ ...head, recent_steps: [], ...facts }))
  const steps = input.recent_steps.slice(-Math.max(1, limits.steps)).map(cleanStep)
  const kept: MidrunStep[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as MidrunStep
    const size = estimateTokens(JSON.stringify(step)) + 1
    if (size <= room) {
      kept.unshift(step)
      room -= size
      continue
    }
    if (kept.length === 0) {
      // The newest step always goes: without its text if need be, then without its earliest calls.
      let last = step
      const bareOf = (one: MidrunStep): number => estimateTokens(JSON.stringify({ ...one, assistant_text: '' })) + 1
      while (bareOf(last) > room && last.tools.length > 1) last = { ...last, earlier_calls_not_shown: (last.earlier_calls_not_shown ?? 0) + 1, tools: last.tools.slice(1) }
      const left = room - bareOf(last)
      kept.unshift({ ...last, assistant_text: left > 0 ? clipToTokens(last.assistant_text, left, STEP_TAIL) : '' })
    }
    break
  }
  return { ...head, recent_steps: kept, ...facts }
}

/** The latest of the person's lasting rules that fit in `tokens`, in the order they were given. */
function latestWithin(constraints: readonly StandingConstraint[], tokens: number): StandingConstraint[] {
  const kept: StandingConstraint[] = []
  let room = tokens
  for (let i = constraints.length - 1; i >= 0; i--) {
    const one = constraints[i] as StandingConstraint
    const size = estimateTokens(JSON.stringify(one)) + 1
    if (size > room) break
    kept.unshift({ ...one })
    room -= size
  }
  return kept
}

/** The effort question about a running loop: the work `recent_steps` has not done yet. That the loop still runs is the state's to say (`progress_note`), not the question's to presuppose. */
const LEVEL_WORDS: Readonly<Record<string, string>> = {
  question: 'How much step-by-step reasoning does the work on `task` that `recent_steps` has not yet done need?',
  rate: 'Rate the work still ahead, not the work already done, how long the run has taken, or how important its topic sounds.',
  evidence: 'Judge what is done and what is left from the tool results in `recent_steps` and from `facts`, not from what the assistant says about its own progress.',
}

type NoulWords = { question: string; reads: string; yes: string; no: string }

/** The observable signals, one judgment each, yes meaning the signal is there; true and false are situations (TypeSafe's Noul page). */
const SIGNALS: Readonly<Record<string, NoulWords>> = {
  [CAUSE_UNKNOWN]: {
    question: 'Does `recent_steps` end with a failure whose cause the assistant has not yet found?',
    reads: 'Judge from the tool calls in `recent_steps`, from what the assistant wrote at those steps, and from `facts`.',
    yes: 'The latest result is an error, a failing test or wrong output; the assistant did not say before the call that it would fail, and nothing it wrote at that step or after names what causes it.',
    no: 'The latest results succeed; or the assistant wrote before the call that this result was expected (a test written to fail first, a change it said would break the output); or what it wrote at that step or after names the cause.',
  },
  [ENV_FAILURE]: {
    question: 'Did the latest failure in `recent_steps` come from the environment rather than from the work itself?',
    reads: 'Judge from the `error` lines of the tool calls in `recent_steps`.',
    yes: 'The call failed on a timeout, a rate limit, an unavailable service, a missing program, a missing permission or an expired credential, or it was refused: the same work would be expected to succeed once that is out of the way.',
    no: 'There is no failure, or it comes from the work: a failing test, a build or type error, wrong output, or a command or an edit that was itself wrong.',
  },
  [NEW_GROUND]: {
    question: 'Has `recent_steps` uncovered work that `task` did not describe?',
    reads: 'Judge from `task` and the tool calls in `recent_steps`.',
    yes: 'The steps show another component that has to change, a design choice that has to be made, or an unfamiliar dependency that has to be understood before the task can be finished.',
    no: 'The steps stay within what `task` asked for.',
  },
  [MECHANICAL_REST]: {
    question: 'Is the work still ahead only carrying out what `recent_steps` has already worked out?',
    reads: 'Judge from `task`, the tool calls in `recent_steps` and `facts`.',
    yes: 'What is left is applying a change already decided, repeating the same edit across files, or running commands and reporting their results.',
    no: 'Something still has to be worked out: a cause to find, a design to choose, code to write that is not settled yet, or results to weigh.',
  },
}

function noul(words: NoulWords, extra: Readonly<Record<string, string>> = {}): Question {
  return { type: 'noul', instructions: { ...extra, question: words.question, reads: words.reads }, criteria: { true: words.yes, false: words.no } }
}

/** The three stakes about the work still ahead, held to the same situations as a message's (decision/effort.ts). */
function stakeQuestion(id: typeof STAKES_UNDO | typeof STAKES_LIVE | typeof STAKES_ACCESS): Question {
  const questions = {
    [STAKES_UNDO]: 'Would a mistake in the work still ahead on `task` be hard to undo, such as deleted data, a sent message, or a published release?',
    [STAKES_LIVE]: 'Does the work still ahead on `task` act on a live production system or on real money?',
    [STAKES_ACCESS]: 'Does the work still ahead on `task` change permissions, authentication, or secrets?',
  }
  const { yes, no } = stakeSituations(id)
  return noul({ question: questions[id], reads: 'Judge from `task` and the tool calls in `recent_steps`.', yes, no })
}

/**
 * The part a mid-run request carries: `midrun.level` and the signals. `same_failure` is asked only with two failures to
 * compare, which sit in its own instructions (TypeSafe's Noul page: "Instructions can be an object ... with the question in
 * one field and supplementary data in the others"), so no other question reads them. Every question the code might read
 * goes in the one request (fan-out: "Asking a question you might not need is close to free").
 */
export function midrunPart(ask: Partial<EffortAsk> = {}, options: { failures?: { latest: string; earlier: string } } = {}): Part {
  // English, a Score: what every effort question of the mod is asked as (ADR 0014); the variants stay the eval's.
  const asked: EffortAsk = { language: 'en', primitive: ask.primitive ?? 'score' }
  const questions: Record<string, Question> = {
    [MIDRUN_LEVEL]: effortQuestion(LEVEL_WORDS, asked),
    [CAUSE_UNKNOWN]: noul(SIGNALS[CAUSE_UNKNOWN] as NoulWords),
    [ENV_FAILURE]: noul(SIGNALS[ENV_FAILURE] as NoulWords),
    [NEW_GROUND]: noul(SIGNALS[NEW_GROUND] as NoulWords),
    [MECHANICAL_REST]: noul(SIGNALS[MECHANICAL_REST] as NoulWords),
    [STAKES_UNDO]: stakeQuestion(STAKES_UNDO),
    [STAKES_LIVE]: stakeQuestion(STAKES_LIVE),
    [STAKES_ACCESS]: stakeQuestion(STAKES_ACCESS),
  }
  const failures = options.failures
  if (failures !== undefined && failures.latest !== '' && failures.earlier !== '') {
    questions[SAME_FAILURE] = {
      type: 'noul',
      instructions: {
        latest_failure: cleanText(failures.latest, ERROR_TOKENS),
        earlier_failure: cleanText(failures.earlier, ERROR_TOKENS),
        question: 'Is `latest_failure` the same problem as `earlier_failure`, rather than a new one?',
      },
      criteria: { true: 'Both come from the same underlying fault: what was tried in between did not remove it.', false: 'The earlier problem is gone and this is a different one.' },
    }
  }
  return { part: MIDRUN_PART, questions }
}

/** The signals out of the part's answers; null where an answer is missing or was not asked. */
export type MidrunSignals = {
  causeUnknown: number | null
  envFailure: number | null
  newGround: number | null
  mechanicalRest: number | null
  sameFailure: number | null
  stakes: { undo: number | null; live: number | null; access: number | null }
}

export function midrunSignals(answers: Readonly<Record<string, Answer>>): MidrunSignals {
  return {
    causeUnknown: readNoul(answers[CAUSE_UNKNOWN]),
    envFailure: readNoul(answers[ENV_FAILURE]),
    newGround: readNoul(answers[NEW_GROUND]),
    mechanicalRest: readNoul(answers[MECHANICAL_REST]),
    sameFailure: readNoul(answers[SAME_FAILURE]),
    stakes: { undo: readNoul(answers[STAKES_UNDO]), live: readNoul(answers[STAKES_LIVE]), access: readNoul(answers[STAKES_ACCESS]) },
  }
}

/** A row is appended for a switch at most this many times a turn (Anthropic's harness advice: "stop after two or three reminders"). */
export const MAX_SWITCHES = 4
/** Two appended switches are at least this many steps apart; a raise for a failure that came back does not wait. */
export const MIN_GAP_STEPS = 4
/** A level raised for a failure is kept at least this many steps, however soon the failing command passes. */
export const HOLD_STEPS = 3
/** The decision model is asked at most this many times a turn, and (but for a failure) no sooner than this many steps after the last time. */
export const MAX_JUDGMENTS = 12
export const JUDGE_GAP_STEPS = 4
/** A look by step count that wants the level moved is asked again this many steps on, and moves it only when both agree (`mid-hold`, `confirm`). */
export const CONFIRM_STEPS = JUDGE_GAP_STEPS
/** Looks by step count a turn gets at most, counted apart from the questions its events ask: neither takes the other's. */
export const MAX_STEP_LOOKS = 12

/**
 * The rows a turn may have had and still take one more for this move: a raise may take the last, a move down may not,
 * unless the loop is on max (`current`): nothing is left to raise there, and a turn that climbed three levels would
 * otherwise stay on the dearest one to its end.
 */
export function rowsFor(move: MidrunMove, current?: Effort): number {
  return move === 'raise' || current === 'max' ? MAX_SWITCHES : MAX_SWITCHES - 1
}

/** Where the loop stands when it is judged. */
export type MidrunPosition = {
  /** The level its steps go out at now. */
  current: Effort
  /** The level its message was decided at (an agent's: its dispatch): where a raise returns to. */
  base: Effort
  /** The highest of the message's rule floors (its stakes, an unknown cause, `ultrathink`, ...); null for none. Nothing lowers under it. */
  ruleFloor: Effort | null
  event: MidrunEventKind
  /** A red flag raised this loop earlier in the turn: nothing lowers it under its base again. */
  ratchet: boolean
  /** An earlier failure of the turn already read as one whose cause is not found: the loop is stuck, and may go above high. */
  stuckBefore: boolean
  /** Whether lowering under the message's level is on (`/dp midrun-down`). */
  downAllowed: boolean
  /** The move needs no row appended: the step that takes it carries input already (a report delivered into the run). */
  free: boolean
  /** Steps since the last appended switch (null: none yet), and how many the turn has had. */
  sinceSwitch: number | null
  switches: number
  /**
   * A look by step count only (`event: 'steps'`): the way the look before it wanted the level to go and did not take it
   * (`MidrunDecision.awaits`); null or left out when it wanted none.
   */
  awaited?: 'raise' | 'lower' | null
}

type Fields = Record<string, string | number | boolean | null>
/** One step of a mid-run decision, in the order the rules ran; `level` is the level after it. Data only (ADR 0004). */
export type MidrunStepTrace = EffortStep | ({ rule: 'mid-sides' | 'mid-stakes' | 'mid-cause' | 'mid-up' | 'mid-return' | 'mid-down' | 'mid-hold' | 'mid-resolved'; applied: boolean; level: Effort } & Fields)

/** What came of it: `raise`, `return` (back to the message's level), `down` (one under it), or `keep`. */
export type MidrunMove = 'raise' | 'return' | 'down' | 'keep'
/** Why, for the row the loop reads and the log: the flag or the reading that moved it. */
export type MidrunReason = 'stakes' | 'cause' | 'reading' | 'resolved' | 'mechanical' | 'held' | 'none'

export type MidrunDecision = {
  effort: Effort
  move: MidrunMove
  reason: MidrunReason
  /** The level the answer's base came to (the card shows it beside where the loop was). */
  picked: Effort
  /** A red flag lifted the level: the loop is not lowered under its base again this turn. */
  flagged: boolean
  /** At a failure, its cause read as not found (and it was no failure of the environment): the next such failure finds the loop stuck. */
  stuck: boolean
  /** The level the stakes ask for at least, null for none: a raise the code takes back goes no lower than the highest of the turn. */
  stakes: Effort | null
  steps: MidrunStepTrace[]
  /** A look by step count wanted the level moved this way and waits for the next look to say the same (`MidrunPosition.awaited`). */
  awaits?: 'raise' | 'lower'
}

const at = (level: Effort): number => EFFORTS.indexOf(level)
const named = (index: number): Effort => EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, index))] as Effort
const higher = (a: Effort, b: Effort | null): Effort => (b !== null && at(b) > at(a) ? b : a)
const round3 = (p: number | null): number | null => (p === null ? null : Math.round(p * 1000) / 1000)

/** Whether a share of probability reaches a bar, as the guide counts a value on it. */
function reaches(share: number, bar: number, inclusive: boolean): boolean {
  // A sum of probabilities that is on the bar in decimals can come out a hair off it in floats.
  return inclusive ? share >= bar - EPSILON : share > bar + EPSILON
}
const EPSILON = 1e-9

/**
 * The level a running loop goes on at, from a mid-run answer (the table at the top of the file). Every rule that ran is a step
 * of the trace, with the numbers it read and the bars it held them to.
 */
export function decideMidrun(reading: EffortReading, signals: MidrunSignals, position: MidrunPosition, guide: Guide = TYPESAFE_GUIDE): MidrunDecision {
  const bars: MidrunBars = MIDRUN_BARS[guide.name]
  const noulBars = guide.noul
  const held = { yes: noulBars.yes, no: noulBars.no, inclusive: noulBars.inclusive }
  const { current, base } = position
  const pick = traceEffort(reading, {}, guide.scoreUnsure)
  const picked = pick.effort
  const steps: MidrunStepTrace[] = [...pick.steps]

  const up = reading.probabilities.reduce((sum, p, i) => (i > at(current) ? sum + p : sum), 0)
  const down = reading.probabilities.reduce((sum, p, i) => (i < at(current) ? sum + p : sum), 0)
  steps.push({ rule: 'mid-sides', applied: true, level: current, picked, up: round3(up), down: round3(down), upBar: bars.up, downBar: bars.down, inclusive: bars.inclusive })

  let level: Effort = current
  let reason: MidrunReason = 'none'
  let flagged = false
  /** A floor lifts the level; it never lowers it. */
  const lift = (floor: Effort | null): boolean => {
    if (floor === null || at(floor) <= at(level)) return false
    level = floor
    return true
  }

  // The stakes, read by the highest of the flags and never their mean: hard to undo together with live or access is the
  // case a message gets max for; one of them alone lifts to high.
  const undo = verdictOrNo(signals.stakes.undo, noulBars)
  const live = verdictOrNo(signals.stakes.live, noulBars)
  const access = verdictOrNo(signals.stakes.access, noulBars)
  const stakesFloor: Effort | null = undo === 'yes' && (live === 'yes' || access === 'yes') ? 'xhigh' : undo === 'yes' || live === 'yes' || access === 'yes' ? 'high' : null
  const stakesLifted = lift(stakesFloor)
  if (stakesLifted) reason = 'stakes'
  if (stakesFloor !== null) flagged = true
  steps.push({ rule: 'mid-stakes', applied: stakesLifted, level, floor: stakesFloor, undo: round3(signals.stakes.undo), undoVerdict: undo, live: round3(signals.stakes.live), liveVerdict: live, access: round3(signals.stakes.access), accessVerdict: access, ...held })

  // A failure whose cause is not found: only at a failure the code saw come back, and not when the environment failed.
  const cause = verdictOrNo(signals.causeUnknown, noulBars)
  const env = verdictOrNo(signals.envFailure, noulBars)
  const same = verdictOrNo(signals.sameFailure, noulBars)
  let causeFloor: Effort | null = null
  const stuck = position.event === 'failure' && env !== 'yes' && cause === 'yes'
  if (position.event === 'failure' && env !== 'yes') {
    // Under high, to high. From high up, one level, and only for a loop already found stuck once this turn.
    if (cause === 'yes') causeFloor = at(current) < at('high') ? 'high' : position.stuckBefore ? named(at(current) + 1) : null
    else if (cause === 'band') causeFloor = 'high'
  }
  const causeLifted = lift(causeFloor)
  if (causeLifted) reason = 'cause'
  if (stuck) flagged = true
  steps.push({ rule: 'mid-cause', applied: causeLifted, level, floor: causeFloor, failure: position.event === 'failure', stuckBefore: position.stuckBefore, p: round3(signals.causeUnknown), verdict: cause, env: round3(signals.envFailure), envVerdict: env, same: round3(signals.sameFailure), sameVerdict: same, ...held })

  // The reading itself: its base above the current level, with enough of the probability on that side.
  const upEnough = reaches(up, bars.up, bars.inclusive)
  // A failure of the environment is not mended by more thought, whatever the work reads as.
  const envFailed = position.event === 'failure' && env === 'yes'
  let readTo: Effort | null = null
  if (at(picked) > at(current) && upEnough && !envFailed) {
    // To high at once; above high one level at a time (each level above high costs far more than the one before).
    const most = Math.max(at('high'), at(current) + 1)
    readTo = named(Math.min(at(picked), most))
  }
  const before = level
  const readLifted = readTo !== null && at(readTo) > at(level)
  if (readLifted) {
    level = readTo as Effort
    if (reason === 'none') reason = 'reading'
  }
  steps.push({ rule: 'mid-up', applied: readLifted, level, from: before, picked, up: round3(up), bar: bars.up, inclusive: bars.inclusive, env: envFailed })

  const raised = at(level) > at(current)
  // Going back to the message's level undoes the mod's own raise; going under it is a guess, and takes a confidence that says the answer is settled.
  const settled = reading.confidence === null || reading.confidence >= bars.settled
  const settledDown = reading.confidence !== null && reading.confidence >= bars.settled
  const downEnough = reaches(down, bars.down, bars.inclusive)
  const anyFlag = stakesFloor !== null || causeFloor !== null
  let move: MidrunMove = raised ? 'raise' : 'keep'

  // Back to the message's level: the loop was raised, and the answer now reads at or under where the message put it.
  const aboveBase = at(current) > at(base)
  const returns = !raised && aboveBase && position.event !== 'failure' && !anyFlag && at(picked) <= at(base) && downEnough && settled
  if (returns) {
    level = base
    move = 'return'
    reason = 'reading'
  }
  steps.push({ rule: 'mid-return', applied: returns, level, base, raised: aboveBase, picked, down: round3(down), bar: bars.down, inclusive: bars.inclusive, confidence: round3(reading.confidence), settled: bars.settled })

  // One level under the message's: only for a rest that is carrying out, never after a red flag, never under a rule's floor.
  // Both signals have to be answered: a missing answer lowers nothing.
  const mechanical = verdictOrNo(signals.mechanicalRest, noulBars)
  const ground = verdictOrNo(signals.newGround, noulBars)
  const floor = position.ruleFloor
  const room = at(current) === at(base) && at(current) > 0 && (floor === null || at(current) - 1 >= at(floor))
  const lowers = !raised && !returns && position.downAllowed && position.event !== 'failure' && !position.ratchet && !anyFlag && room && mechanical === 'yes' && signals.newGround !== null && ground === 'no' && at(picked) < at(current) && downEnough && settledDown
  if (lowers) {
    level = named(at(current) - 1)
    move = 'down'
    reason = 'mechanical'
  }
  steps.push({
    rule: 'mid-down',
    applied: lowers,
    level,
    allowed: position.downAllowed,
    atBase: at(current) === at(base),
    ratchet: position.ratchet,
    ruleFloor: floor,
    mechanical: round3(signals.mechanicalRest),
    mechanicalVerdict: mechanical,
    ground: round3(signals.newGround),
    groundVerdict: ground,
    picked,
    down: round3(down),
    bar: bars.down,
    confidence: round3(reading.confidence),
    settled: bars.settled,
    // `inclusive` among them: a guide counts a value on a bar the same way for a yes/no and for a side of the Score.
    ...held,
  })

  // A look by step count has no event behind it, and most of them should change nothing: of the looks that should keep the
  // level about one in twelve reads otherwise (DEVELOPMENT.md, effort-midrun), and a long turn has many. So what such a look
  // wants is taken only when the look before it wanted the same way; the first one waits (`awaits`: the feature asks again
  // `CONFIRM_STEPS` on). The stakes do not wait: a red flag is read by the highest, at once.
  if (position.event === 'steps' && move !== 'keep' && reason !== 'stakes') {
    const way = move === 'raise' ? 'raise' : 'lower'
    if (position.awaited !== way) {
      steps.push({ rule: 'mid-hold', applied: true, level: current, wanted: level, why: 'confirm', lowering: move !== 'raise', again: CONFIRM_STEPS })
      return { effort: current, move: 'keep', reason: 'held', picked, flagged, stuck, stakes: stakesFloor, steps, awaits: way }
    }
  }

  // A move that needs a row appended keeps to the turn's cap and the gap since the last one; a raise for a red flag does not wait
  // out the gap. The turn's last row is a raise's: a loop that could no longer be raised is worse off than one left a level high
  // (on max there is no raise to keep it for).
  if (move !== 'keep' && !position.free) {
    const most = rowsFor(move, current)
    const capped = position.switches >= most
    const tooSoon = position.sinceSwitch !== null && position.sinceSwitch < MIN_GAP_STEPS && !(move === 'raise' && (reason === 'cause' || reason === 'stakes'))
    if (capped || tooSoon) {
      steps.push({ rule: 'mid-hold', applied: true, level: current, wanted: level, why: capped ? 'cap' : 'gap', switches: position.switches, most, lowering: move !== 'raise', sinceSwitch: position.sinceSwitch, gap: MIN_GAP_STEPS })
      return { effort: current, move: 'keep', reason: 'held', picked, flagged, stuck, stakes: stakesFloor, steps }
    }
  }
  return { effort: level, move, reason, picked, flagged, stuck, stakes: stakesFloor, steps }
}

/**
 * A level the code moves by itself, with no question asked: the failing command a raise was for passes again, so the loop goes
 * back to its message's level, or to the level the stakes asked for this turn (`floor`) when that is higher.
 */
export function resolvedDecision(position: Pick<MidrunPosition, 'current' | 'base'>, command: string, sinceRaise: number, floor: Effort | null = null): MidrunDecision {
  const to = higher(position.base, floor)
  const back = at(position.current) > at(to)
  const level = back ? to : position.current
  return {
    effort: level,
    move: back ? 'return' : 'keep',
    reason: back ? 'resolved' : 'none',
    picked: level,
    flagged: false,
    stuck: false,
    stakes: null,
    steps: [{ rule: 'mid-resolved', applied: back, level, base: position.base, floor, from: position.current, command, sinceRaise, hold: HOLD_STEPS }],
  }
}

/** Why a level moved, in the row the loop reads: a fact, never an order to think less (Anthropic's guides: such words do not lower the thinking and can lower the work). */
const NOTE_WHY: Readonly<Record<MidrunReason, string>> = {
  stakes: 'the work ahead now includes something hard to undo, live, or about access',
  cause: 'a failure came back after a fix and its cause is not found yet',
  reading: 'the work ahead reads differently from when this level was set',
  resolved: 'the command that kept failing passes again',
  mechanical: 'what is left reads as carrying out what is already worked out',
  held: '',
  none: '',
}

/**
 * The row appended for a switch (features/midrun-effort.ts): one short reminder in the engine's own wrapping, which says
 * what changed and why and asks for nothing. It has to be there: a model takes a new level only at a step with input.
 */
export function switchNote(from: Effort, to: Effort, reason: MidrunReason | 'failures'): string {
  const why = reason === 'failures' ? 'several of your tool calls failed' : NOTE_WHY[reason]
  const verb = at(to) > at(from) ? 'raised' : 'lowered'
  return `<system-reminder>\nDispatch Pilot (the user's routing plugin) ${verb} your reasoning effort from ${from} to ${to}${why === '' ? '' : `: ${why}`}. No reply to this note is needed; carry on with the work.\n</system-reminder>`
}
