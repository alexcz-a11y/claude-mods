// The Workflow fallback (#9): which `agent()` call of a script an agent of a
// running Workflow stands for, found by the label the engine recorded for it,
// and what to set on that agent's steps.
//
// A Workflow's agents never pass `agent.spawn`, and the workflow-agents
// feature (#8) can write their model and effort into the script only when the
// script is inline and it can read the call. For the rest (a script given by
// path or by name, a resumed run, a script it cannot read, a call whose prompt
// is data), the model and effort are set on each agent's own steps: the run's
// journal says which label each agent started under, the label says which call
// it is, and the call's decision (made when the run started, or from the
// agent's own prompt when it starts) goes into the plan table.
//
// Pure (see system-one.ts).

import type { Failure } from './backend.ts'
import { modelFamily, type AgentModel } from './dispatched-agent.ts'
import type { Effort } from './effort.ts'
import { modelId } from './model-ids.ts'
import type { AgentCall, Written } from './workflow-script.ts'
import { callName, outcomeOf, whyOf, type CallOutcome, type Skipped } from './workflow.ts'

/** How the agents of one call are routed. */
export type SiteRoute =
  /** Decided when the run started: what each of its agents is set to (null: the step's own). */
  | { kind: 'set'; model: AgentModel | null; effort: Effort | null }
  /** Decided when each of its agents starts, from that agent's own prompt. */
  | { kind: 'runtime' }
  /** Left to the script: the workflow-agents feature wrote it, it already says what was decided, or no decision was made. */
  | { kind: 'script' }

/** How a label the journal recorded is told to be a call's. */
export type LabelMatch =
  /** A label the script writes as a string: that string. */
  | { kind: 'exact'; label: string }
  /** A template label: a regular expression's source, its `${...}` matching anything. */
  | { kind: 'pattern'; source: string }
  /** No label: the engine records the prompt's start; `whole` when the prompt is a string, not a template. */
  | { kind: 'head'; head: string; whole: boolean }
  /** Nothing to tell it by: a label, or a prompt without one, that the script works out when it runs. */
  | { kind: 'none' }

/** One `agent()` call of a run's script, as the fallback keeps it (`labelRuns` in types/index.d.ts). */
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
}

/** The routes of a script's calls, from what was decided about them when the run started (`readOutcomes`). */
export function sitesOf(calls: readonly AgentCall[], outcomes: readonly CallOutcome[]): RunSite[] {
  return calls.map((call, index) => siteOf(call, routeOf(outcomes[index])))
}

/**
 * The routes of the calls of a script the main agent sent inline: the
 * workflow-agents feature asked about every call but those in `skipped` (a
 * prompt it cannot read, a call past what it asks about), and wrote what it
 * could into the script; those are decided as their agents start.
 */
export function inlineSites(calls: readonly AgentCall[], skipped: readonly Skipped[]): RunSite[] {
  const left = new Set(skipped.map((skip) => skip.index))
  return calls.map((call) => siteOf(call, left.has(call.index) ? { kind: 'runtime' } : { kind: 'script' }))
}

function siteOf(call: AgentCall, route: SiteRoute): RunSite {
  return { line: call.line, label: call.label, match: matchOf(call), route, model: call.model, effort: call.effort, agentType: call.agentType }
}

function routeOf(outcome: CallOutcome | undefined): SiteRoute {
  if (outcome === undefined || outcome.kind === 'kept') return { kind: 'script' }
  if (outcome.kind === 'left') return outcome.reason === 'unreadable' || outcome.reason === 'capped' ? { kind: 'runtime' } : { kind: 'script' }
  const model = (outcome.write.model ?? null) as AgentModel | null
  const effort = typeof outcome.write.effort === 'string' ? (outcome.write.effort as Effort) : null
  return { kind: 'set', model, effort }
}

/**
 * How the label the engine records for one of the call's agents is told to be
 * this call's. A label the script writes as a string is that string. A
 * template label (`migrate:${file}`, read as written: the parser keeps its
 * `${...}`) is a pattern: its own text must be there, each placeholder matches
 * anything; one with no text of its own says nothing. A call without a label
 * is recorded under the start of its prompt (measured on 2.1.289: whitespace
 * collapsed, cut at 60 characters): a string prompt's start, or a template's
 * own text before its first placeholder.
 */
function matchOf(call: AgentCall): LabelMatch {
  if (call.labelKind === 'string' && call.label !== null) return { kind: 'exact', label: call.label }
  if (call.labelKind === 'template' && call.label !== null) {
    const pieces = templatePieces(call.label)
    if (pieces.every((piece) => piece.placeholder || piece.text.trim() === '')) return { kind: 'none' }
    const source = pieces.map((piece) => (piece.placeholder ? '[\\s\\S]*' : escapeRegExp(cooked(piece.text)))).join('')
    return { kind: 'pattern', source: `^${source}$` }
  }
  if (call.labelKind === 'none' && call.prompt !== null) {
    const pieces = call.prompt.includes('${') ? templatePieces(call.prompt) : [{ text: call.prompt, placeholder: false }]
    const first = pieces[0]
    const whole = pieces.length === 1 && first?.placeholder === false
    // A string prompt is already cooked; a template's text is as written.
    const head = first === undefined || first.placeholder ? '' : flat(whole ? first.text : cooked(first.text))
    return head === '' ? { kind: 'none' } : { kind: 'head', head: whole ? head.slice(0, ENGINE_LABEL) : head, whole }
  }
  return { kind: 'none' }
}

/** How many characters of a prompt the engine records as the label of a call without one. */
const ENGINE_LABEL = 60

/** Text with each run of whitespace one space, trimmed: how a label and a prompt's start compare. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whether `label` is what the engine records for a call without one whose prompt starts as `match` says. */
function startsAs(label: string, match: { head: string; whole: boolean }): boolean {
  const recorded = flat(label)
  if (match.whole || match.head.length >= ENGINE_LABEL) return recorded === flat(match.head.slice(0, ENGINE_LABEL))
  return recorded.startsWith(match.head)
}

/** A template's text as written, cut into its own text and its `${...}` (braces counted, so a placeholder holding an object goes whole). */
function templatePieces(template: string): { text: string; placeholder: boolean }[] {
  const pieces: { text: string; placeholder: boolean }[] = []
  let text = ''
  let i = 0
  while (i < template.length) {
    if (template.charAt(i) === '\\') {
      text += template.slice(i, i + 2)
      i += 2
    } else if (template.charAt(i) === '$' && template.charAt(i + 1) === '{') {
      let depth = 1
      let end = i + 2
      while (end < template.length && depth > 0) {
        if (template.charAt(end) === '{') depth++
        else if (template.charAt(end) === '}') depth--
        end++
      }
      if (text !== '') pieces.push({ text, placeholder: false })
      pieces.push({ text: template.slice(i, end), placeholder: true })
      text = ''
      i = end
    } else {
      text += template.charAt(i)
      i++
    }
  }
  if (text !== '') pieces.push({ text, placeholder: false })
  return pieces
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

/** A template's own text as the script's value has it: its escapes worked out. */
function cooked(raw: string): string {
  return raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g, (_, braced?: string, unicode?: string, hex?: string, plain?: string) => {
    const code = braced ?? unicode ?? hex
    if (code !== undefined) return String.fromCodePoint(Number.parseInt(code, 16))
    if (plain === '\n' || plain === '\r\n') return ''
    return ESCAPES[plain as string] ?? (plain as string)
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** What the engine's journal says of one agent: the label it started under. */
export type JournalStart = { label: string; phase: string | null }

/** The `started` line of `agentId` in a run's journal (`journal.jsonl`); null when the agent is not in it (yet). */
export function startedIn(journal: string, agentId: string): JournalStart | null {
  for (const line of journal.split('\n')) {
    if (!line.includes(agentId)) continue
    try {
      const row = JSON.parse(line) as { type?: unknown; agentId?: unknown; label?: unknown; phase?: unknown }
      if (row.type === 'started' && row.agentId === agentId && typeof row.label === 'string') {
        return { label: row.label, phase: typeof row.phase === 'string' ? row.phase : null }
      }
    } catch {
      // a line being written: not this agent's
    }
  }
  return null
}

/**
 * The calls of `sites` an agent the journal recorded under `label` can be
 * one of: the calls whose string label it is; else those whose template it
 * fits; else, when none does, the calls nothing tells apart (a label or prompt
 * the script works out when it runs).
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

/**
 * The task a workflow agent was given, from its transcript
 * (`agent-<agentId>.jsonl`): the first user message, without the frame the
 * engine puts around a task a script computed. Null when the transcript holds
 * no such message (yet).
 */
export function taskOf(transcript: string): string | null {
  for (const line of transcript.split('\n')) {
    let row: { type?: unknown; message?: { role?: unknown; content?: unknown } }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }
    if (row.type !== 'user' || row.message?.role !== 'user') continue
    const content = row.message.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block: { text?: unknown }) => (typeof block?.text === 'string' ? block.text : '')).join('') : ''
    const at = text.indexOf(TASK_FOLLOWS)
    if (at < 0) return text.trim() === '' ? null : text
    return text
      .slice(at + TASK_FOLLOWS.length)
      .split('\n')
      .map((taskLine) => (taskLine.startsWith('  ') ? taskLine.slice(2) : taskLine))
      .join('\n')
  }
  return null
}

/** Whether `label` is only what the engine records for an agent of a call without a label: the start of its task. */
export function isTaskStart(label: string, task: string): boolean {
  const recorded = flat(label)
  return recorded !== '' && flat(flat(task).slice(0, ENGINE_LABEL)) === recorded
}

/** What one agent's steps go out with: a model id when it changes the step's family (null keeps the step's own), and the effort. */
export function agentPlan(route: { model: AgentModel | null; effort: Effort | null }, stepModel: string): { model: string | null; effort: Effort | null } {
  const model = route.model !== null && route.model !== modelFamily(stepModel) ? modelId(route.model) : null
  return { model, effort: route.effort }
}

/** How the Workflow tool was handed the script: inline (`script`), by `scriptPath`, by `name`, or inline to resume an earlier run. */
export type Given = 'script' | 'path' | 'name' | 'resume'

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
      ? 'Dispatch Pilot decides the model and effort of the agents of the agent() calls left as written when each one starts, from its label and its task.'
      : null
  }
  if (launched === null) return null
  const lines = launched.outcomes.map((outcome, index) => {
    const call = launched.calls[index] as AgentCall
    if (outcome.kind === 'written') {
      const why = whyOf(outcome.decision)
      return `- ${callName(call)}: ${outcomeOf(call, outcome.decision)}${why === '' ? '' : ` (${why})`}`
    }
    if (outcome.kind === 'kept') return `- ${callName(call)}: as the script has it (${outcomeOf(call, outcome.decision)})`
    if (outcome.reason === 'unreadable' || outcome.reason === 'capped') return `- ${callName(call)}: decided as each of its agents starts, from its label and its task`
    return `- ${callName(call)}: as the script has it (${outcome.failure === undefined ? 'no answer from the decision model' : launched.describe(outcome.failure)})`
  })
  const header = launched.outcomes.some((outcome) => outcome.kind !== 'left')
    ? "Dispatch Pilot (the user's routing plugin) chose a model and an effort for the agent() calls of this Workflow. The script is unchanged: each agent gets its call's choice as it starts, found by its label."
    : "Dispatch Pilot (the user's routing plugin) decides the model and effort of this Workflow's agents as each one starts. The script is unchanged."
  return [header, ...lines].join('\n')
}

/** Whether two routes set the same thing. */
export function sameRoute(a: SiteRoute, b: SiteRoute): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'set' || b.kind !== 'set' || (a.model === b.model && a.effort === b.effort)
}
