// The Workflow fallback (#9): which `agent()` call of a script an agent of a
// running Workflow stands for, found by the label it is spawned with, and what
// the main agent is told of it.
//
// The workflow-agents feature (#8) can write the agents' model and effort into
// the script only when the script is inline and it can read the call. For the
// rest (a script given by path or by name, a resumed run, a script it cannot
// read, a call whose prompt is data), each agent is routed as it is spawned
// (`agent.spawn` with `e.workflow`, 2.1.300 on): the spawn's `description` is
// its label, the label says which call it is, and the call's decision (made
// when the run started, or from the agent's own prompt then) sets the spawn's
// model and goes into the plan table.
//
// Pure (see system-one.ts).

import type { Failure } from './backend.ts'
import { termsOf, type AgentModel, type Terms } from './dispatched-agent.ts'
import type { Effort } from './effort.ts'
import { cooked, templatePieces, type AgentCall, type Written } from './workflow-script.ts'
import { callName, decidedAtStart, decidedLine, outcomeOf, type CallOutcome, type Skipped } from './workflow.ts'

/** How the agents of one call are routed. */
export type SiteRoute =
  /** Decided when the run started: what each of its agents is set to (null: the step's own). */
  | { kind: 'set'; model: AgentModel | null; effort: Effort | null }
  /** Decided when each of its agents starts, from that agent's own prompt. */
  | { kind: 'runtime' }
  /** Left to the script: the workflow-agents feature wrote it, it already says what was decided, or no decision was made. */
  | { kind: 'script' }

/** How the label an agent is spawned with is told to be a call's. */
export type LabelMatch =
  /** A label the script writes as a string: that string. */
  | { kind: 'exact'; label: string }
  /** A template label: a regular expression's source, its `${...}` matching anything. */
  | { kind: 'pattern'; source: string }
  /** No label: the engine labels the agent with the prompt's start; `whole` when the prompt has no placeholder, so `head` is all of it. */
  | { kind: 'head'; head: string; whole: boolean }
  /** Nothing to tell it by: a label, or a prompt without one, that the script works out when it runs. */
  | { kind: 'none' }

/** One `agent()` call of a run's script, as this feature keeps it (`labelRuns` in types/index.d.ts). */
export type RunSite = {
  /** The line it starts on, for the log. */
  line: number
  /** The label as written (a template keeps its `${...}`); null when there is none or it is worked out when the script runs. */
  label: string | null
  match: LabelMatch
  route: SiteRoute
  /** The call's own options, for a decision made as its agents start (what the script works out itself is left alone). */
  model: Written
  effort: Written
  agentType: string | null
  /** The person's terms for the call's work, as its decision read them (null: none, or not decided yet); its agents' plans keep them. */
  terms: Terms | null
}

/** The routes of a script's calls, from what was decided about them when the run started (`readOutcomes`). */
export function sitesOf(calls: readonly AgentCall[], outcomes: readonly CallOutcome[]): RunSite[] {
  return calls.map((call, index) => {
    const outcome = outcomes[index]
    return siteOf(call, routeOf(outcome), outcome === undefined || outcome.kind === 'left' ? null : termsOf(outcome.decision))
  })
}

/**
 * The routes of the calls of a script the main agent sent inline: the
 * workflow-agents feature asked about every call but those in `skipped` (a
 * prompt it cannot read, a call past what it asks about), and wrote what it
 * could into the script; those are decided as their agents start. `terms`:
 * what its decisions read of the person's terms for each call, by index.
 */
export function inlineSites(calls: readonly AgentCall[], skipped: readonly Skipped[], terms: readonly (Terms | null)[] = []): RunSite[] {
  const left = new Set(skipped.map((skip) => skip.index))
  return calls.map((call) => siteOf(call, left.has(call.index) ? { kind: 'runtime' } : { kind: 'script' }, terms[call.index] ?? null))
}

function siteOf(call: AgentCall, route: SiteRoute, terms: Terms | null): RunSite {
  return { line: call.line, label: call.label, match: matchOf(call), route, model: call.model, effort: call.effort, agentType: call.agentType, terms }
}

function routeOf(outcome: CallOutcome | undefined): SiteRoute {
  if (outcome === undefined || outcome.kind === 'kept') return { kind: 'script' }
  if (outcome.kind === 'left') return decidedAtStart(outcome) ? { kind: 'runtime' } : { kind: 'script' }
  const model = (outcome.write.model ?? null) as AgentModel | null
  const effort = typeof outcome.write.effort === 'string' ? (outcome.write.effort as Effort) : null
  return { kind: 'set', model, effort }
}

/**
 * How the label the engine gives one of the call's agents is told to be this
 * call's. A label the script writes as a string is that string. A template
 * label (`migrate:${file}`, read as written: the parser keeps its `${...}`) is
 * a pattern: its own text must be there, each placeholder matches anything;
 * one with no text of its own says nothing. A call without a label is labelled
 * with the start of its prompt (measured on 2.1.289: whitespace collapsed, cut
 * at 60 characters): a string prompt's start, or a template's own text before
 * its first placeholder.
 */
function matchOf(call: AgentCall): LabelMatch {
  if (call.labelKind === 'string' && call.label !== null) return { kind: 'exact', label: call.label }
  if (call.labelKind === 'template' && call.label !== null) {
    const source = templateSource(call.label)
    return source === null ? { kind: 'none' } : { kind: 'pattern', source }
  }
  if (call.labelKind === 'none' && call.prompt !== null) {
    const template = call.promptTemplate === true
    const pieces = template ? templatePieces(call.prompt) : [{ text: call.prompt, placeholder: false }]
    const first = pieces[0]
    const whole = pieces.length === 1 && first?.placeholder === false
    // A string prompt is already cooked; a template's text is as written.
    const head = first === undefined || first.placeholder ? '' : flat(template ? cooked(first.text) : first.text)
    return head === '' ? { kind: 'none' } : { kind: 'head', head: whole ? head.slice(0, ENGINE_LABEL) : head, whole }
  }
  return { kind: 'none' }
}

/** A template label as a regular expression's source: its own text in place, each `${...}` anything; null when it has no text of its own. */
function templateSource(template: string): string | null {
  const pieces = templatePieces(template)
  if (pieces.every((piece) => piece.placeholder || piece.text.trim() === '')) return null
  return `^${pieces.map((piece) => (piece.placeholder ? '[\\s\\S]*' : escapeRegExp(cooked(piece.text)))).join('')}$`
}

/**
 * Whether `label`, as the engine recorded it for an agent, is one a call whose label is written as the template `written`
 * (`verify:${b.id}`, read as written) gives. False when `written` has no `${...}`, or no text of its own.
 */
export function fitsTemplate(written: string, label: string): boolean {
  if (!written.includes('${')) return false
  const source = templateSource(written)
  return source !== null && new RegExp(source).test(label)
}

/** How many characters of a prompt the engine labels the agent of a call without a label with. */
const ENGINE_LABEL = 60

/** Text with each run of whitespace one space, trimmed: how a label and a prompt's start compare. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whether `label` is what the engine labels the agent of a call without one, whose prompt starts as `match` says, with. */
function startsAs(label: string, match: { head: string; whole: boolean }): boolean {
  const recorded = flat(label)
  if (match.whole || match.head.length >= ENGINE_LABEL) return recorded === flat(match.head.slice(0, ENGINE_LABEL))
  return recorded.startsWith(match.head)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The calls of `sites` an agent spawned with `label` can be one of: the
 * calls whose string label it is; else those whose template it fits; else,
 * when none does, the calls nothing tells apart (a label or prompt the script
 * works out when it runs).
 */
export function sitesFor(label: string, sites: readonly RunSite[]): RunSite[] {
  const exact = sites.filter((site) => site.match.kind === 'exact' && site.match.label === label)
  if (exact.length > 0) return exact
  const fits = sites.filter((site) => (site.match.kind === 'pattern' && new RegExp(site.match.source).test(label)) || (site.match.kind === 'head' && startsAs(label, site.match)))
  if (fits.length > 0) return fits
  return sites.filter((site) => site.match.kind === 'none')
}

/** What the engine writes before a workflow agent's task, up to the task itself (2.1.289); each line of the task follows indented by two spaces. */
const TASK_FOLLOWS = 'The computed task text follows:\n'
/** How the frame starts in which the engine relays the person's request to a workflow agent, before its task (seen on 2.1.281-2.1.282). */
const RELAYED_REQUEST = '[Workflow harness — user request]'

/** The task a script computed, without the frame the engine puts around it; null when `text` is not such a frame. */
export function computedTask(text: string): string | null {
  const at = text.indexOf(TASK_FOLLOWS)
  if (at < 0) return null
  return text
    .slice(at + TASK_FOLLOWS.length)
    .split('\n')
    .map((taskLine) => (taskLine.startsWith('  ') ? taskLine.slice(2) : taskLine))
    .join('\n')
}

/** Whether `text` is the frame in which the engine relays the person's request to a workflow agent (not the agent's task). */
export function isRelayedRequest(text: string): boolean {
  return text.trimStart().startsWith(RELAYED_REQUEST)
}

/** Whether `label` is only what the engine labels the agent of a call without one with: the start of its task. */
export function isTaskStart(label: string, task: string): boolean {
  const recorded = flat(label)
  return recorded !== '' && flat(flat(task).slice(0, ENGINE_LABEL)) === recorded
}

/** How the Workflow tool was handed the script: inline (`script`), by `scriptPath`, by `name`, or inline to resume an earlier run. */
export type Given = 'script' | 'path' | 'name' | 'resume'

/** How a Workflow call was submitted; `script` holds the text when it was inline and is not a resume. */
export type Submission = { given: 'script'; script: string } | { given: Exclude<Given, 'script'> }

/**
 * How the Workflow tool call `e` hands over its script. The one reading of it, for the features that rewrite a script
 * (`script`: the engine runs the text as sent) and those that route by label (every other way): a path or a name runs a
 * script the tool reads itself, and a resume matches the earlier run's agents by their prompts and options.
 */
export function submissionOf(e: { scriptPath?: string | undefined; script?: string | undefined; name?: string | undefined; resumeFromRunId?: string | undefined }): Submission {
  if (e.scriptPath !== undefined) return { given: 'path' }
  if (e.script === undefined || e.name !== undefined) return { given: 'name' }
  return e.resumeFromRunId !== undefined ? { given: 'resume' } : { given: 'script', script: e.script }
}

/**
 * What the main agent reads after the Workflow tool's result about the agents
 * this feature routes as they start; null when there is nothing to say.
 * `launched`: what was decided about each call when the run started (a
 * script given by path or by name, or resumed).
 */
export function launchNote(
  given: Given,
  sites: readonly RunSite[] | null,
  launched: { calls: readonly AgentCall[]; outcomes: readonly CallOutcome[]; describe: (failure: Failure) => string } | null,
): string | null {
  if (sites === null) return "Dispatch Pilot (the user's routing plugin) could not read this script, so it decides each agent's model and effort as the agent starts, from its label and its task."
  if (given === 'script') {
    return sites.some((site) => site.route.kind === 'runtime')
      ? "Dispatch Pilot (the user's routing plugin) sets the model and effort of the agents of the agent() calls it leaves as written, as each one starts, from its label and its task."
      : null
  }
  if (launched === null) return null
  const lines = launched.outcomes.map((outcome, index) => {
    const call = launched.calls[index] as AgentCall
    if (outcome.kind === 'written') return `- ${decidedLine(call, outcome.decision)}`
    if (outcome.kind === 'kept') return `- ${callName(call)}: as the script has it (${outcomeOf(call, outcome.decision)})`
    if (decidedAtStart(outcome)) return `- ${callName(call)}: decided as each of its agents starts, from its label and its task`
    return `- ${callName(call)}: as the script has it (${outcome.failure === undefined ? 'no answer from the decision model' : launched.describe(outcome.failure)})`
  })
  const header = launched.outcomes.some((outcome) => outcome.kind !== 'left')
    ? "Dispatch Pilot (the user's routing plugin) chose a model and an effort for the agent() calls of this Workflow. The script is unchanged: each agent gets its call's choice as it starts, found by its label."
    : "Dispatch Pilot (the user's routing plugin) decides the model and effort of this Workflow's agents as each one starts. The script is unchanged."
  return [header, ...lines].join('\n')
}

/** The person's terms every one of `sites` carries; null when they carry none, or not the same. */
export function sharedTerms(sites: readonly RunSite[]): Terms | null {
  const first = sites[0]?.terms ?? null
  return first !== null && sites.every((site) => JSON.stringify(site.terms) === JSON.stringify(first)) ? first : null
}

/** Whether two routes set the same thing. */
export function sameRoute(a: SiteRoute, b: SiteRoute): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'set' || b.kind !== 'set' || (a.model === b.model && a.effort === b.effort)
}
