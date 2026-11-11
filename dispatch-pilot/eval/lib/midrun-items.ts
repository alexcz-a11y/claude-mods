// The effort-midrun dataset's items (ADR 0020): the rules lib/datasets.ts checks them against. The types are lib/datasets.ts's
// (`EffortMidrunItem`); eval/datasets/README.md says how an item is written.
//
// An item holds the state of a running turn as the mod's record of it would give it to the decision model (decision/midrun.ts
// `MidrunInput`, in both languages), where the turn stands (`MidrunPosition`) and the level the work still ahead needs. Its
// `facts` are written as the mod writes them (decision/midrun-track.ts `factsOf`), so this checks their forms, and that the
// numbers in them agree with the steps shown. What the mod's own record could not hold is refused: an `error` on a call that
// did not fail, a `next_item` at an event that is not the task list moving on.
//
// Pure: no Node API.

import { EFFORTS, isEffort, type Effort } from '../../hooks/decision/effort.ts'
import type { CallOutcome, MidrunEventKind } from '../../hooks/decision/midrun.ts'
import { exactKeys, isRecord, nonEmpty, type Add } from './validators.ts'

/** Top-level fields of an item. */
export const MIDRUN_FIELDS = ['id', 'zh', 'en', 'event', 'current', 'base', 'rule_floor', 'stuck_before', 'gold', 'accept', 'rationale', 'difficulty', 'tags'] as const

/** The events of a run at which the mod asks (decision/midrun-track.ts). */
export const MIDRUN_EVENTS = ['failure', 'report', 'handback', 'skill', 'todo'] as const satisfies readonly MidrunEventKind[]
const OUTCOMES = ['ok', 'failed', 'blocked', 'denied'] as const satisfies readonly CallOutcome[]
// A kind or an outcome the mod gains is a type error here until the dataset's rules know it.
type KnownEvents = [Exclude<MidrunEventKind, (typeof MIDRUN_EVENTS)[number]>] extends [never] ? true : never
type KnownOutcomes = [Exclude<CallOutcome, (typeof OUTCOMES)[number]>] extends [never] ? true : never
export const MIDRUN_RULES_KNOW_THE_MOD: [KnownEvents, KnownOutcomes] = [true, true]

const SIDES = ['zh', 'en'] as const
/** The tools whose successful call is a file edited (decision/midrun-track.ts), and those that hand a result back. */
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const DISPATCH_TOOLS: readonly string[] = ['Agent', 'Task', 'Workflow']

type Tool = { tool: string; target: string; outcome: string; error?: string; result: string }
type Step = { step: number; assistant_text: string; tools: Tool[] }

/** The sentences `factsOf` writes (decision/midrun-track.ts), by what they say. */
const FACT = {
  refail: /^The command `[^`]+` failed again after the assistant edited files since its last failure(?:: [2-9]\d* times in a row now)?\.$/,
  regression: /^The command `[^`]+` passed earlier in this run and fails now, after the assistant edited files\.$/,
  sameLine: /^The latest failure has the same first error line as the failure before it\.$/,
  skill: /^The assistant has just loaded the skill "([^"]+)": its instructions are part of the work ahead\.$/,
  handback: /^A dispatched agent's result has just come back to the assistant \(the latest (Agent|Task|Workflow) call in `recent_steps`\)\.$/,
  todo: /^The assistant's task list has (\d+) of (\d+) items done; it has just moved on to `next_item`\.$/,
  report: 'A report was just delivered to the assistant while it works (`report`): a background task or a dispatched agent finished.',
  failed: /^(\d+) of the (\d+) tool calls of this run failed\.$/,
  noEdit: 'The assistant has not edited any file in this run.',
  recentNoEdit: /^No file was edited in the latest (\d+) steps\.$/,
}

/** The failures the mod hands the `same_failure` question: a failed call's line, `Bash: <first error line>` (the tool alone when it said nothing). */
export function failureLine(tool: { tool: string; error?: string }): string {
  return tool.error === undefined || tool.error === '' ? tool.tool : `${tool.tool}: ${tool.error}`
}

function isStep(value: unknown): value is Step {
  return isRecord(value) && Array.isArray(value.tools)
}

/** An item: its position and answer, each language's state, and the two languages against each other. */
export function checkMidrun(item: Record<string, unknown>, add: Add): void {
  const event = item.event
  if (!(MIDRUN_EVENTS as readonly unknown[]).includes(event)) add(`event ${JSON.stringify(event)} is not one of ${MIDRUN_EVENTS.join(', ')}`)
  for (const field of ['current', 'base'] as const) if (!isEffort(item[field])) add(`${field} ${JSON.stringify(item[field])} is not an effort level (${EFFORTS.join(', ')})`)
  if (item.rule_floor !== null && !isEffort(item.rule_floor)) add(`rule_floor ${JSON.stringify(item.rule_floor)} must be null or an effort level`)
  else if (isEffort(item.rule_floor) && isEffort(item.base) && EFFORTS.indexOf(item.rule_floor) > EFFORTS.indexOf(item.base)) add(`rule_floor ${item.rule_floor} is above base ${item.base}: the message's own rules are what base was decided with`)
  if (typeof item.stuck_before !== 'boolean') add('stuck_before must be true or false')
  for (const side of SIDES) checkSide(item[side] as Record<string, unknown>, side, event, add)
  checkSame(item.zh as Record<string, unknown>, item.en as Record<string, unknown>, add)
}

const REQUIRED = ['task', 'recent_steps', 'facts']
const OPTIONAL = ['constraints', 'report', 'next_item', 'failures']

function checkSide(asked: Record<string, unknown>, side: string, event: unknown, add: Add): void {
  const say = (message: string) => add(`${side}.${message}`)
  const keys = [...REQUIRED, ...OPTIONAL.filter((key) => key in asked)]
  exactKeys(asked, keys, side, add)
  if (!nonEmpty(asked.task)) say('task must be a non-empty string')
  const steps = checkSteps(asked.recent_steps, side, add)
  const facts = Array.isArray(asked.facts) && asked.facts.every(nonEmpty) ? (asked.facts as string[]) : null
  if (facts === null) say('facts must be an array of sentences (empty when the code counted nothing)')

  // What an event brings, and only that event.
  const wants = { report: event === 'report', next_item: event === 'todo', failures: event === 'failure' }
  for (const [key, wanted] of Object.entries(wants)) {
    const has = key in asked
    if (wanted && key !== 'failures' && !has) say(`${key} is missing: ${key === 'report' ? 'a report event delivers one' : 'the task list moved on to an item'}`)
    if (!wanted && has) say(`${key} is only for ${key === 'report' ? 'a report' : key === 'next_item' ? 'a todo' : 'a failure'} event`)
  }
  for (const key of ['report', 'next_item'] as const) if (key in asked && !nonEmpty(asked[key])) say(`${key} must be a non-empty string`)
  if ('constraints' in asked) {
    const list = asked.constraints
    if (!Array.isArray(list) || list.length === 0 || !list.every((one) => isRecord(one) && nonEmpty(one.person_said) && typeof one.assistant_before === 'string')) say('constraints must be a non-empty array of { person_said, assistant_before }')
    else list.forEach((one, i) => exactKeys(one as Record<string, unknown>, ['person_said', 'assistant_before'], `${side}.constraints[${i}]`, add))
  }
  if ('failures' in asked) {
    const failures = asked.failures
    if (!isRecord(failures)) say('failures must be { latest, earlier }')
    else {
      exactKeys(failures, ['latest', 'earlier'], `${side}.failures`, add)
      for (const key of ['latest', 'earlier'] as const) if (!nonEmpty(failures[key])) say(`failures.${key} must be a non-empty string`)
      const failed = steps?.flatMap((step) => step.tools.filter((tool) => tool.outcome === 'failed')) ?? []
      const last = failed.at(-1)
      if (last !== undefined && failures.latest !== failureLine(last)) say(`failures.latest ${JSON.stringify(failures.latest)} is not the latest failed call's line ${JSON.stringify(failureLine(last))}`)
    }
  }
  if (steps !== null && facts !== null) checkFacts(facts, steps, asked, event, side, add)
}

/** The steps: each with its index (rising), the end of what the assistant wrote, and its calls as the mod's record holds them. */
function checkSteps(value: unknown, side: string, add: Add): Step[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    add(`${side}.recent_steps must be a non-empty array of steps`)
    return null
  }
  let previous = -1
  let good = true
  value.forEach((step, i) => {
    const at = `${side}.recent_steps[${i}]`
    if (!isStep(step)) {
      good = false
      return add(`${at} must be { step, assistant_text, tools }`)
    }
    exactKeys(step, ['step', 'assistant_text', 'tools'], at, add)
    if (!Number.isInteger(step.step) || step.step < 0) add(`${at}.step must be a whole number from 0`)
    else if (step.step <= previous) add(`${at}.step ${step.step} does not come after ${previous}: the steps are oldest first`)
    else previous = step.step
    if (typeof step.assistant_text !== 'string') add(`${at}.assistant_text must be a string`)
    step.tools.forEach((tool, j) => {
      const here = `${at}.tools[${j}]`
      if (!isRecord(tool)) {
        good = false
        return add(`${here} must be an object`)
      }
      exactKeys(tool, ['tool', 'target', 'outcome', ...('error' in tool ? ['error'] : []), 'result'], here, add)
      if (!nonEmpty(tool.tool)) add(`${here}.tool must be a tool name`)
      if (typeof tool.target !== 'string') add(`${here}.target must be a string (empty when nothing says what the call worked on)`)
      if (!(OUTCOMES as readonly unknown[]).includes(tool.outcome)) add(`${here}.outcome ${JSON.stringify(tool.outcome)} is not one of ${OUTCOMES.join(', ')}`)
      if ('error' in tool && tool.outcome !== 'failed') add(`${here}.error: only a call that failed has a first error line`)
      if ('error' in tool && !nonEmpty(tool.error)) add(`${here}.error must be a non-empty string (leave it out when the tool said nothing)`)
      if (!nonEmpty(tool.result)) add(`${here}.result must be the words the 0.8.x dataset used for how the call went`)
    })
  })
  return good ? (value as Step[]) : null
}

/** The facts are the sentences `factsOf` writes, in its order: the event's, the failure count, the edits; the numbers agree with the steps. */
function checkFacts(facts: readonly string[], steps: readonly Step[], asked: Record<string, unknown>, event: unknown, side: string, add: Add): void {
  const say = (message: string) => add(`${side}.facts: ${message}`)
  const calls = steps.flatMap((step) => step.tools)
  const first = facts[0]
  if (first === undefined) return say('the event has a sentence of its own, first')
  let rest = facts.slice(1)
  switch (event) {
    case 'failure':
      if (!FACT.refail.test(first) && !FACT.regression.test(first) && !FACT.sameLine.test(first)) say(`a failure event starts with one of the three sentences for a failure that came back, not ${JSON.stringify(first)}`)
      // The earlier failure `same_failure` compares is there for a failure that came back after a fix and for the same line, not for a regression.
      if (FACT.regression.test(first) && 'failures' in asked) say('a regression has no earlier failure to compare: no failures')
      if (!FACT.regression.test(first) && !('failures' in asked)) say('a failure with an earlier failure carries it (failures)')
      break
    case 'skill': {
      const named = FACT.skill.exec(first)
      if (named === null) say(`a skill event starts with the sentence for a skill loaded, not ${JSON.stringify(first)}`)
      else if (!calls.some((call) => call.tool === 'Skill' && call.outcome === 'ok' && call.target === named[1])) say(`no Skill call that went through names "${named[1]}"`)
      break
    }
    case 'handback': {
      const named = FACT.handback.exec(first)
      if (named === null) say(`a handback event starts with the sentence for a result handed back, not ${JSON.stringify(first)}`)
      else if (!calls.some((call) => call.tool === named[1] && call.outcome === 'ok')) say(`no ${named[1]} call that went through is in recent_steps`)
      else if (!DISPATCH_TOOLS.includes(named[1] as string)) say(`${named[1]} is not a tool that hands a result back`)
      break
    }
    case 'todo': {
      const list = FACT.todo.exec(first)
      if (list === null) say(`a todo event starts with the sentence for the task list moving on, not ${JSON.stringify(first)}`)
      else if (Number(list[1]) >= Number(list[2])) say(`${list[1]} of ${list[2]} items done: the item it moved on to is not done yet`)
      break
    }
    case 'report':
      if (first !== FACT.report) say(`a report event starts with the sentence for a report delivered, not ${JSON.stringify(first)}`)
      break
    default:
      return
  }

  const shownFailed = calls.filter((call) => call.outcome === 'failed').length
  const counted = rest[0] === undefined ? null : FACT.failed.exec(rest[0])
  if (counted !== null) {
    rest = rest.slice(1)
    const [failed, total] = [Number(counted[1]), Number(counted[2])]
    if (failed < shownFailed) say(`${failed} calls failed, but ${shownFailed} failed calls are shown`)
    if (failed > total) say(`${failed} of ${total} calls failed`)
    if (total < calls.length) say(`${total} calls in the run, but ${calls.length} are shown`)
    if (failed === 0) say('the sentence is left out when no call failed')
  } else if (shownFailed > 0) say('a failed call is shown, so the run has a failure count')
  const edited = calls.some((call) => EDIT_TOOLS.includes(call.tool) && call.outcome === 'ok')
  if (rest.length > 1) say(`${rest.length} sentences after the failure count: at most one, about the edits`)
  const edits = rest[0]
  if (edits === undefined) return
  const recent = FACT.recentNoEdit.exec(edits)
  if (edits !== FACT.noEdit && recent === null) return say(`${JSON.stringify(edits)} is none of the sentences factsOf writes`)
  if (edited) say('says no file was edited, but a call that edited one went through in the steps shown')
  if (recent !== null && (Number(recent[1]) !== steps.length || steps.length < 5)) say(`"latest N steps" is for the ${steps.length} steps shown, and only from 5`)
}

/** Both languages describe the same run: the same steps, calls and outcomes, the same facts (the mod writes them in English), the same optional fields. */
function checkSame(zh: Record<string, unknown>, en: Record<string, unknown>, add: Add): void {
  for (const key of OPTIONAL) if (key in zh !== key in en) add(`${key} is in one language only`)
  if (JSON.stringify(zh.facts) !== JSON.stringify(en.facts)) add('facts differ between zh and en: the mod writes them in English whatever the person writes')
  const [a, b] = [zh.recent_steps, en.recent_steps]
  if (!Array.isArray(a) || !Array.isArray(b)) return
  if (a.length !== b.length) return add(`zh.recent_steps has ${a.length} steps, en.recent_steps ${b.length}`)
  a.forEach((step, i) => {
    const other = b[i]
    if (!isStep(step) || !isStep(other)) return
    if (step.step !== other.step) add(`recent_steps[${i}].step differs between zh and en`)
    if (step.tools.length !== other.tools.length) return add(`recent_steps[${i}] has ${step.tools.length} calls in zh, ${other.tools.length} in en`)
    step.tools.forEach((tool, j) => {
      const twin = other.tools[j] as Tool
      if (tool.tool !== twin.tool || tool.outcome !== twin.outcome) add(`recent_steps[${i}].tools[${j}] differs between zh and en (tool or outcome)`)
      if ('error' in tool !== 'error' in twin) add(`recent_steps[${i}].tools[${j}].error is in one language only`)
    })
  })
}

/** Which way an item's level should move: its gold against the level the turn goes at now. */
export function midrunDirection(item: { gold: Effort; current: Effort }): 'up' | 'down' | 'keep' {
  const [gold, current] = [EFFORTS.indexOf(item.gold), EFFORTS.indexOf(item.current)]
  return gold > current ? 'up' : gold < current ? 'down' : 'keep'
}

/** The dataset-wide shares the drafting asked for (warnings): each way of moving and each event has a sample. */
export function midrunQuotas(items: readonly Record<string, unknown>[]): string[] {
  const warnings: string[] = []
  const typed = items.filter((item) => isEffort(item.gold) && isEffort(item.current))
  for (const direction of ['up', 'down', 'keep'] as const) {
    const n = typed.filter((item) => midrunDirection(item as { gold: Effort; current: Effort }) === direction).length
    if (n < 20) warnings.push(`${n} items should go ${direction}; the drafting rules ask for at least 20`)
  }
  const least: Record<(typeof MIDRUN_EVENTS)[number], number> = { failure: 10, report: 3, handback: 3, skill: 2, todo: 20 }
  for (const event of MIDRUN_EVENTS) {
    const n = items.filter((item) => item.event === event).length
    if (n < least[event]) warnings.push(`${n} items are at a ${event} event; the drafting rules ask for at least ${least[event]}`)
  }
  return warnings
}
