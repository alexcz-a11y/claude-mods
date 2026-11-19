// Stored answers read with the mod's own rules, and marked against a case's labels (calibration plan, Task 5).
// Pure: no node: module. The thresholds come in as Bars, so a sweep can move one of them.
import { noulOf, scoreOf } from '../../hooks/backend.ts'
import type { Answer } from '../../hooks/backend.ts'
import { readConfig } from '../../hooks/config.ts'
import { START, agentPlan, messageLevel, midrunLevel, readNoul, thresholdsFor } from '../../hooks/decide.ts'
import type { Thresholds } from '../../hooks/decide.ts'
import { LEVELS } from '../../hooks/levels.ts'
import type { Level, Tier } from '../../hooks/levels.ts'
import { ACTION_BAR, FITS_BAR, NAMED_BAR, pick, shortlist, skillBarsFor, wantsSkill } from '../../hooks/skills.ts'
import type { Skill, SkillBars } from '../../hooks/skills.ts'
import type { AgentCase, Case, MidrunCase, SkillCase, SubmitCase } from './case.ts'
import { readDirect } from './controls.ts'

export type { SkillBars }
export type Bars = { submit: Thresholds; midrun: Thresholds; agent: Thresholds; skill: SkillBars }
export const START_BARS: Bars = { submit: START, midrun: START, agent: START, skill: { action: ACTION_BAR, named: NAMED_BAR, fits: FITS_BAR } }

export type Stored = { ok: true; model: string; answers: Record<string, Answer> } | { ok: false; reason: string }
export type Outcome = { level: Level | null; model: Tier | null; skill: string | null }
export type Mark = 'right' | 'over' | 'under' | 'needless-shift' | 'missed-shift' | 'wrong-model' | 'wrong-skill' | 'missed-skill' | 'needless-skill'

// The mod's defaults: the pinned Drex version, and the agent models it may choose from (haiku, sonnet, opus; fableAgents off).
const DEFAULTS = readConfig({})

/** The bars the mod reads the pinned Drex version's answers with (Task 13), so a score here is the mod's own reading. */
export const CHOSEN_BARS: Bars = {
  submit: thresholdsFor('drex', DEFAULTS.drexModel, 'submit'),
  midrun: thresholdsFor('drex', DEFAULTS.drexModel, 'midrun'),
  agent: thresholdsFor('drex', DEFAULTS.drexModel, 'agent'),
  skill: skillBarsFor('drex', DEFAULTS.drexModel),
}

type Answers = Record<string, Answer>
const has = (a: Answers, type: Answer['type'], ...ids: string[]): boolean => ids.every((id) => a[id]?.type === type)
const rank = (l: Level): number => LEVELS.indexOf(l)
const HIGH = rank('high')

// A failed request or another model's answer is no answer (global constraints): it is counted apart, never scored.
function usable(s: Stored | undefined): Answers | null {
  return s !== undefined && s.ok && s.model === DEFAULTS.drexModel ? s.answers : null
}

type Opt = { form?: 'default' | 'direct'; longUnattended?: boolean; second?: Stored }

// The candidate rule (Task 4): long_unattended read as yes keeps the level at high or above. Null: the question was
// not asked though the rule was wanted.
function floored(level: Level | null, a: Answers, t: Thresholds, opt: Opt): Level | null {
  if (level === null || !opt.longUnattended) return level
  if (!has(a, 'noul', 'long_unattended')) return null
  return readNoul(noulOf(a.long_unattended), t) === 'yes' && rank(level) < HIGH ? 'high' : level
}

function submitOutcome(c: SubmitCase, a: Answers, t: Thresholds, opt: Opt): Outcome | null {
  let level: Level | null
  if (opt.form === 'direct') level = readDirect(a.direct)
  else {
    if (!has(a, 'score', 'open') || !has(a, 'noul', 'mechanical', 'unknown_cause')) return null
    // The mod's own reading (settleSubmit's): "go on" keeps the last turn's level. continues is asked only with a
    // previous turn (the no-previous variant asks none), so its absence reads as not going on.
    level = messageLevel(
      c.input.base,
      c.input.previous?.level ?? null,
      { open: scoreOf(a.open), mechanical: noulOf(a.mechanical), unknownCause: noulOf(a.unknown_cause), continues: noulOf(a.continues) },
      t,
    ).level
  }
  const out = floored(level, a, t, opt)
  return out === null ? null : { level: out, model: null, skill: null }
}

// A rise mid-run stops at xhigh, as in midrunLevel; a level already above it is not raised.
function capRise(current: Level, level: Level | null): Level | null {
  if (level === null || rank(level) <= rank(current)) return level
  return rank(current) < rank('xhigh') ? LEVELS[Math.min(rank(level), rank('xhigh'))]! : current
}

// long_unattended is not asked mid-run (Task 4), so the rule does not apply here.
function midrunOutcome(c: MidrunCase, a: Answers, t: Thresholds, opt: Opt): Outcome | null {
  let level: Level | null
  if (opt.form === 'direct') level = capRise(c.input.current, readDirect(a.direct))
  else {
    if (!has(a, 'score', 'open') || !has(a, 'noul', 'same_failure', 'cause_found', 'only_carrying_out', 'contradicts_plan')) return null
    level = midrunLevel(
      c.input.current,
      { open: scoreOf(a.open), sameFailure: noulOf(a.same_failure), causeFound: noulOf(a.cause_found), onlyCarryingOut: noulOf(a.only_carrying_out), contradictsPlan: noulOf(a.contradicts_plan) },
      t,
    ).level
  }
  return level === null ? null : { level, model: null, skill: null }
}

// The model is always agentPlan's (it reads open, mechanical and read_only); the direct form replaces only the level.
function agentOutcome(c: AgentCase, a: Answers, t: Thresholds, opt: Opt): Outcome | null {
  if (!has(a, 'score', 'open') || !has(a, 'noul', 'mechanical', 'unknown_cause', 'read_only')) return null
  const plan = agentPlan(
    c.input.inherit,
    { open: scoreOf(a.open), mechanical: noulOf(a.mechanical), unknownCause: noulOf(a.unknown_cause), readOnly: noulOf(a.read_only) },
    { agentModels: DEFAULTS.agentModels, fableAgents: DEFAULTS.fableAgents },
    t,
  )
  const level = floored(opt.form === 'direct' ? readDirect(a.direct) : plan.effort, a, t, opt)
  return level === null ? null : { level, model: plan.model, skill: null }
}

// The candidates as the first request's choice questions listed them (descriptions play no part in the reading).
function candidatesOf(a: Answers): Skill[] {
  const names: string[] = []
  for (const [id, x] of Object.entries(a)) {
    if (!id.startsWith('skill_') || x.type !== 'choice') continue
    for (const name of Object.keys(x.probabilities)) if (name !== 'other' && !names.includes(name)) names.push(name)
  }
  return names.map((name) => ({ name, description: '' }))
}

/**
 * The shortlist a first skill answer gives, names only (descriptions empty). The runner builds the second request from
 * this very function, so a tie at the cut can never give the runner one list and the reader another.
 */
export function shortlistOf(a: Answers): Skill[] {
  return shortlist(candidatesOf(a), a)
}

// As readStageOne and readStageTwo: the gate, the shortlist, then the second request's pick. The second request is
// needed only when the gate lets the message through, as in the mod; the runner asks it of every case with a first
// answer, so a sweep that lowers the gate still finds it.
function skillOutcome(a: Answers, b: SkillBars, opt: Opt): Outcome | null {
  const gate = ['acts_on_user_system', 'would_follow_documented_procedure', 'prose_suffices', 'named']
  const candidates = candidatesOf(a)
  if (!has(a, 'noul', ...gate) || candidates.length === 0) return null
  const none: Outcome = { level: null, model: null, skill: null }
  const wants = wantsSkill(
    { acts: noulOf(a.acts_on_user_system), procedure: noulOf(a.would_follow_documented_procedure), prose: noulOf(a.prose_suffices), named: noulOf(a.named) },
    { action: b.action, named: b.named },
  )
  if (!wants) return none
  const short = shortlistOf(a)
  if (short.length === 0) return none
  const second = usable(opt.second)
  if (second === null || !short.every((_, i) => has(second, 'noul', `fits_${i}`))) return null
  // The second request must have been asked about this shortlist; one asked about another is no answer to it.
  const which = second.which
  if (which?.type === 'choice') {
    const asked = Object.keys(which.probabilities).filter((k) => k !== 'other')
    if (asked.length !== short.length || !short.every((s) => asked.includes(s.name))) return null
  }
  return { ...none, skill: pick(short, second, b.fits)?.name ?? null }
}

/** 按给定门槛读一个用例的回答；回答不可用（失败、模型不对、缺题）时是 null。 */
export function outcomeOf(c: Case, first: Stored, bars: Bars, opt: Opt = {}): Outcome | null {
  const a = usable(first)
  if (a === null) return null
  if (c.category === 'submit') return submitOutcome(c, a, bars.submit, opt)
  if (c.category === 'midrun') return midrunOutcome(c, a, bars.midrun, opt)
  if (c.category === 'agent') return agentOutcome(c, a, bars.agent, opt)
  return skillOutcome(a, bars.skill, opt)
}

function levelMark(accept: readonly Level[], level: Level | null): Mark {
  // outcomeOf gives every level category a level; a null here is a caller's mistake.
  if (level === null) throw new Error('an outcome of a level category has no level')
  if (accept.includes(level)) return 'right'
  return rank(level) > Math.max(...accept.map(rank)) ? 'over' : 'under'
}

function skillMark(c: SkillCase, skill: string | null): Mark {
  const want = c.expect.skill
  if (want === null) return skill === null ? 'right' : 'needless-skill'
  if (skill === null) return 'missed-skill'
  return skill === want || c.expect.alsoOk.includes(skill) ? 'right' : 'wrong-skill'
}

export function mark(c: Case, o: Outcome): Mark {
  if (c.category === 'skill') return skillMark(c, o.skill)
  if (c.category === 'midrun') {
    const shifted = o.level !== c.input.current
    if (c.expect.action === 'hold' && shifted) return 'needless-shift'
    if (c.expect.action !== 'hold' && !shifted) return 'missed-shift'
    return levelMark(c.expect.accept, o.level)
  }
  const m = levelMark(c.expect.accept, o.level)
  if (c.category === 'agent' && m === 'right' && (o.model === null || !c.expect.models.includes(o.model))) return 'wrong-model'
  return m
}
