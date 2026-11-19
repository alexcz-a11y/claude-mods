import { TIERS } from './levels.ts'
import type { Tier } from './levels.ts'
import { DEFAULT_BARS } from './questions.ts'
import type { Bars, SkillBars, Thresholds } from './questions.ts'

export type Config = {
  enabled: boolean
  /** The timeline and pane. Off: nothing is drawn, only /dp remains. */
  board: boolean
  /** shadow: judge and record, change nothing. */
  mode: 'apply' | 'shadow'
  backend: 'drex' | 'jev'
  /** On a failed request, ask the other backend once (needs both keys). */
  fallback: boolean
  drexApiKey: string
  jevApiKey: string
  drexModel: string
  jevModel: string
  submitShift: boolean
  midrunShift: boolean
  agentShift: boolean
  skills: boolean
  /** Ordinary sessions: a mid-run check every N working steps; 0 is off. */
  midrunEverySteps: number
  /** Code Mode sessions: a mid-run check every N script results; 0 is off. */
  midrunEveryScripts: number
  /** Two shifts in one turn are at least this many work steps apart. */
  midrunShiftGap: number
  midrunMaxNotes: number
  /** In tier order, whatever order the setting listed them in. */
  agentModels: Tier[]
  fableAgents: boolean
  verifyEffort: boolean
  progressNote: boolean
  progressNoteModel: string
  submitTimeoutMs: number
  midrunTimeoutMs: number
  agentTimeoutMs: number
  /** The thresholds each action's answers are read with, and the skill bars: options, whichever backend answers. */
  bars: Bars
}

const DEFAULT_AGENT_MODELS: Tier[] = ['haiku', 'sonnet', 'opus']

/** The most notes a turn may be given (midrunMaxNotes is clamped to it). */
export const MAX_NOTES = 12

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

// A blank string counts as unset, so a cleared field cannot send an empty model name.
function text(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === v) ?? fallback
}

// A number option is a picker in the manifest (Ruling C44: the configuration screens show a picker's default), so it
// comes as its label ("0.70", "8"); a plain number (the tests, the eval, a setting saved before the pickers) is read as
// well. Anything that is no number is the default; the clamp stays as a guard.
function clamped(v: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  const n = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * The thresholds that are options, by action: those some decision depends on. Not `no`: readNoul's "no" decides
 * nothing (only the board shows the reading). Not modelDown for submit and midrun: only an agent's model is chosen.
 */
export const OPTION_BARS = {
  submit: ['up', 'upHigh', 'down', 'yes'],
  midrun: ['up', 'upHigh', 'down', 'yes'],
  agent: ['up', 'upHigh', 'down', 'yes', 'modelDown'],
  skill: ['action', 'named', 'fits'],
} as const satisfies { [G in keyof Bars]: readonly (keyof Bars[G])[] }

/** An option's key: the action, then the threshold's name (agent and modelDown: agentModelDown). */
export function optionKey(group: string, field: string): string {
  return group + field.charAt(0).toUpperCase() + field.slice(1)
}

function levelBars(options: Record<string, unknown>, group: 'submit' | 'midrun' | 'agent'): Thresholds {
  const out: Thresholds = { ...DEFAULT_BARS[group] }
  for (const field of OPTION_BARS[group]) out[field] = clamped(options[optionKey(group, field)], out[field], 0.5, 0.99)
  return out
}

function skillBars(options: Record<string, unknown>): SkillBars {
  const out: SkillBars = { ...DEFAULT_BARS.skill }
  for (const field of OPTION_BARS.skill) out[field] = clamped(options[optionKey('skill', field)], out[field], 0.05, 0.95)
  return out
}

function tiers(v: unknown): Tier[] {
  const words = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : []
  const named = new Set(words.map((w) => (typeof w === 'string' ? w.trim().toLowerCase() : '')))
  const found = TIERS.filter((tier) => named.has(tier))
  return found.length > 0 ? found : [...DEFAULT_AGENT_MODELS]
}

export function readConfig(options: Record<string, unknown>): Config {
  return {
    enabled: bool(options.enabled, true),
    board: bool(options.board, true),
    mode: oneOf(options.mode, ['apply', 'shadow'], 'apply'),
    backend: oneOf(options.backend, ['drex', 'jev'], 'drex'),
    fallback: bool(options.fallback, false),
    drexApiKey: text(options.drexApiKey, ''),
    jevApiKey: text(options.jevApiKey, ''),
    drexModel: text(options.drexModel, 'drex-max-v1.1'),
    jevModel: text(options.jevModel, 'jev-latest'),
    submitShift: bool(options.submitShift, true),
    midrunShift: bool(options.midrunShift, true),
    agentShift: bool(options.agentShift, true),
    skills: bool(options.skills, true),
    midrunEverySteps: clamped(options.midrunEverySteps, 8, 0, 60),
    midrunEveryScripts: clamped(options.midrunEveryScripts, 1, 0, 60),
    midrunShiftGap: clamped(options.midrunShiftGap, 3, 0, 20),
    midrunMaxNotes: clamped(options.midrunMaxNotes, 4, 0, MAX_NOTES),
    agentModels: tiers(options.agentModels),
    fableAgents: bool(options.fableAgents, false),
    verifyEffort: bool(options.verifyEffort, true),
    progressNote: bool(options.progressNote, true),
    progressNoteModel: text(options.progressNoteModel, 'haiku'),
    submitTimeoutMs: clamped(options.submitTimeoutMs, 4000, 500, 9000),
    midrunTimeoutMs: clamped(options.midrunTimeoutMs, 2000, 500, 9000),
    agentTimeoutMs: clamped(options.agentTimeoutMs, 3000, 500, 9000),
    bars: { submit: levelBars(options, 'submit'), midrun: levelBars(options, 'midrun'), agent: levelBars(options, 'agent'), skill: skillBars(options) },
  }
}
