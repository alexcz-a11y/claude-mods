import { TIERS } from './levels.ts'
import type { Tier } from './levels.ts'

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

// The manifest declares no min or max (an old setting outside them would fail the load), so clamp here.
function clamped(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
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
    midrunMaxNotes: clamped(options.midrunMaxNotes, 4, 0, MAX_NOTES),
    agentModels: tiers(options.agentModels),
    fableAgents: bool(options.fableAgents, false),
    verifyEffort: bool(options.verifyEffort, true),
    progressNote: bool(options.progressNote, false),
    progressNoteModel: text(options.progressNoteModel, 'haiku'),
    submitTimeoutMs: clamped(options.submitTimeoutMs, 4000, 500, 9000),
    midrunTimeoutMs: clamped(options.midrunTimeoutMs, 2000, 500, 9000),
    agentTimeoutMs: clamped(options.agentTimeoutMs, 3000, 500, 9000),
  }
}
