// What a calibration case is, and the checks every case and every category of 15 must pass (calibration plan, Task 2).
// Pure: imported by tests and by other eval code, so no node: module here.
import { LEVELS, TIERS } from '../../hooks/levels.ts'
import type { Level, Tier } from '../../hooks/levels.ts'
import type { PreviousTurn, ProgressNote, StepRecord } from '../../hooks/statebuild.ts'

export type Category = 'submit' | 'midrun' | 'agent' | 'skill'
export type Difficulty = 'typical' | 'hard' | 'boundary' | 'negative'
export type CaseSet = 'fit' | 'check' | 'heldout'
type Base = {
  id: string
  source: 'real' | 'written'
  /** A case taken from a real session: the first 8 characters of its session id (amendments A2, A13). */
  session?: string
  difficulty: Difficulty
  set: CaseSet
  tags: string[]
  label: { by: 'model' | 'human'; rationale: string }
}
export type SubmitCase = Base & { category: 'submit'; input: { request: string; previous: PreviousTurn | null; base: Level }; expect: { accept: Level[] } }
export type MidrunCase = Base & {
  category: 'midrun'
  input: {
    request: string
    current: Level
    stepsSoFar: number
    failedSteps: number
    recent: StepRecord[]
    latest: StepRecord
    statedNext: string
    codeMode: boolean
    notes: { before: ProgressNote | null; after: ProgressNote | null } | null
  }
  expect: { action: 'hold' | 'up' | 'down'; accept: Level[] }
}
export type AgentCase = Base & {
  category: 'agent'
  input: { task: string; agentType: string; description: string; inherit: { level: Level; tier: Tier } }
  expect: { accept: Level[]; models: Tier[] }
}
export type SkillCase = Base & { category: 'skill'; input: { request: string; previous: PreviousTurn | null }; expect: { skill: string | null; alsoOk: string[] } }
export type Case = SubmitCase | MidrunCase | AgentCase | SkillCase

const CATEGORIES: readonly Category[] = ['submit', 'midrun', 'agent', 'skill']
const DIFFICULTIES: readonly Difficulty[] = ['typical', 'hard', 'boundary', 'negative']
const SETS: readonly CaseSet[] = ['fit', 'check', 'heldout']
const SPLIT: Record<CaseSet, number> = { fit: 6, check: 4, heldout: 5 }
const SET_SIZE = 15
const MAX_RECENT = 5
const SKILL_NEGATIVE_TAGS = ['everyday', 'uncovered', 'named-missing']
const MIDRUN_TAGS = ['looks-finished', 'batch-mechanical', 'stuck']

type Obj = Record<string, unknown>
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isStr(v: unknown): v is string {
  return typeof v === 'string'
}
function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr)
}
function oneOf<T extends string>(all: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (all as readonly string[]).includes(v)
}
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}
const levelAt = (l: Level): number => LEVELS.indexOf(l)
const tierAt = (t: Tier): number => TIERS.indexOf(t)

/** Collects one problem per failed check, each naming the field. */
class Problems {
  readonly list: string[] = []
  need(ok: boolean, path: string, what: string): boolean {
    if (!ok) this.list.push(`${path}: must be ${what}`)
    return ok
  }
}

function checkPrevious(p: Problems, path: string, v: unknown): void {
  if (v === null) return
  if (!p.need(isObj(v), path, 'null or a previous turn')) return
  const t = v as Obj
  p.need(isStr(t.request), `${path}.request`, 'a string')
  p.need(isStr(t.lastReply), `${path}.lastReply`, 'a string')
  p.need(oneOf(['answered', 'error', 'interrupted'], t.ended), `${path}.ended`, "'answered', 'error' or 'interrupted'")
  p.need(t.level === null || oneOf(LEVELS, t.level), `${path}.level`, 'null or a level')
}

function checkStep(p: Problems, path: string, v: unknown): void {
  if (!p.need(isObj(v), path, 'a step record')) return
  const s = v as Obj
  p.need(isStr(s.did), `${path}.did`, 'a string')
  p.need(isStrArr(s.tools), `${path}.tools`, 'an array of strings')
  p.need(typeof s.ok === 'boolean', `${path}.ok`, 'a boolean')
  p.need(isStr(s.result), `${path}.result`, 'a string')
}

function checkNote(p: Problems, path: string, v: unknown): void {
  if (v === null) return
  if (!p.need(isObj(v), path, 'null or a progress note')) return
  const n = v as Obj
  p.need(isStr(n.done), `${path}.done`, 'a string')
  p.need(isStr(n.remaining), `${path}.remaining`, 'a string')
  p.need(typeof n.cause_known === 'boolean', `${path}.cause_known`, 'a boolean')
}

/** The accepted levels when they are 1 level or 2 adjacent ones, else null (and the problem noted). */
function checkAccept(p: Problems, v: unknown): Level[] | null {
  const ok =
    Array.isArray(v) &&
    (v.length === 1 || v.length === 2) &&
    v.every((l) => oneOf(LEVELS, l)) &&
    (v.length === 1 || Math.abs(levelAt(v[0] as Level) - levelAt(v[1] as Level)) === 1)
  return p.need(ok, 'expect.accept', '1 level or 2 adjacent levels') ? (v as Level[]) : null
}

function checkSubmit(p: Problems, input: Obj, expect: Obj): void {
  p.need(isStr(input.request), 'input.request', 'a string')
  checkPrevious(p, 'input.previous', input.previous)
  p.need(oneOf(LEVELS, input.base), 'input.base', 'a level')
  checkAccept(p, expect.accept)
}

function checkMidrun(p: Problems, input: Obj, expect: Obj): void {
  p.need(isStr(input.request), 'input.request', 'a string')
  const current = p.need(oneOf(LEVELS, input.current), 'input.current', 'a level') ? (input.current as Level) : null
  p.need(isCount(input.stepsSoFar), 'input.stepsSoFar', 'a whole number, 0 or more')
  p.need(isCount(input.failedSteps), 'input.failedSteps', 'a whole number, 0 or more')
  if (p.need(Array.isArray(input.recent), 'input.recent', 'an array of step records')) {
    const recent = input.recent as unknown[]
    p.need(recent.length <= MAX_RECENT, 'input.recent', `at most ${MAX_RECENT} step records`)
    recent.forEach((s, i) => checkStep(p, `input.recent[${i}]`, s))
  }
  checkStep(p, 'input.latest', input.latest)
  p.need(isStr(input.statedNext), 'input.statedNext', 'a string')
  p.need(typeof input.codeMode === 'boolean', 'input.codeMode', 'a boolean')
  if (input.notes !== null && p.need(isObj(input.notes), 'input.notes', 'null or { before, after }')) {
    const notes = input.notes as Obj
    checkNote(p, 'input.notes.before', notes.before)
    checkNote(p, 'input.notes.after', notes.after)
  }
  const action = p.need(oneOf(['hold', 'up', 'down'], expect.action), 'expect.action', "'hold', 'up' or 'down'") ? expect.action : null
  const accept = checkAccept(p, expect.accept)
  if (current === null || action === null || accept === null) return
  const at = levelAt(current)
  if (action === 'hold') p.need(accept.length === 1 && accept[0] === current, 'expect.accept', `[current] ('${current}') when the action is hold`)
  if (action === 'up') p.need(accept.every((l) => levelAt(l) > at && levelAt(l) <= levelAt('xhigh')), 'expect.accept', `above current ('${current}') and at most xhigh when the action is up`)
  if (action === 'down') p.need(accept.every((l) => levelAt(l) < at), 'expect.accept', `below current ('${current}') when the action is down`)
}

function checkAgent(p: Problems, input: Obj, expect: Obj): void {
  p.need(isStr(input.task), 'input.task', 'a string')
  p.need(isStr(input.agentType), 'input.agentType', 'a string')
  p.need(isStr(input.description), 'input.description', 'a string')
  let tier: Tier | null = null
  if (p.need(isObj(input.inherit), 'input.inherit', '{ level, tier }')) {
    const inherit = input.inherit as Obj
    p.need(oneOf(LEVELS, inherit.level), 'input.inherit.level', 'a level')
    if (p.need(oneOf(TIERS, inherit.tier), 'input.inherit.tier', 'a model tier')) tier = inherit.tier as Tier
  }
  checkAccept(p, expect.accept)
  const models = expect.models
  if (!p.need(Array.isArray(models) && models.length > 0 && models.every((t) => oneOf(TIERS, t)), 'expect.models', 'a non-empty array of model tiers')) return
  if (tier !== null) p.need((models as Tier[]).every((t) => tierAt(t) <= tierAt(tier)), 'expect.models', `no higher than input.inherit.tier ('${tier}')`)
}

function checkSkill(p: Problems, input: Obj, expect: Obj, skills: readonly string[]): void {
  p.need(isStr(input.request), 'input.request', 'a string')
  checkPrevious(p, 'input.previous', input.previous)
  if (expect.skill !== null) p.need(isStr(expect.skill) && skills.includes(expect.skill), 'expect.skill', 'null or the name of a candidate skill')
  if (p.need(isStrArr(expect.alsoOk), 'expect.alsoOk', 'an array of strings')) {
    for (const name of expect.alsoOk as string[]) p.need(skills.includes(name), 'expect.alsoOk', `names of candidate skills ('${name}' is not one)`)
  }
}

/** Every string in a value, with its path. */
function strings(v: unknown, path: string, out: [string, string][]): [string, string][] {
  if (isStr(v)) out.push([path, v])
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out))
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) strings(x, path ? `${path}.${k}` : k, out)
  return out
}

/** A case's problems; an empty array means it passes. skills: the names in the candidate snapshot. */
export function checkCase(c: unknown, skills: readonly string[]): string[] {
  const p = new Problems()
  if (!p.need(isObj(c), 'case', 'an object')) return p.list
  const k = c as Obj
  const category = p.need(oneOf(CATEGORIES, k.category), 'category', 'one of ' + CATEGORIES.map((x) => `'${x}'`).join(', ')) ? (k.category as Category) : null
  if (category !== null) p.need(isStr(k.id) && new RegExp(`^${category}-\\d{2}$`).test(k.id), 'id', `'${category}-' and two digits`)
  p.need(oneOf(['real', 'written'], k.source), 'source', "'real' or 'written'")
  // A real case names its session, so checkSet can keep one session's cases in one set.
  if (k.source === 'real' || k.session !== undefined) p.need(isStr(k.session) && /^[0-9a-f]{8}$/.test(k.session), 'session', 'the first 8 characters of the session id')
  p.need(oneOf(DIFFICULTIES, k.difficulty), 'difficulty', 'one of ' + DIFFICULTIES.map((x) => `'${x}'`).join(', '))
  p.need(oneOf(SETS, k.set), 'set', 'one of ' + SETS.map((x) => `'${x}'`).join(', '))
  p.need(isStrArr(k.tags), 'tags', 'an array of strings')
  if (p.need(isObj(k.label), 'label', '{ by, rationale }')) {
    const label = k.label as Obj
    p.need(oneOf(['model', 'human'], label.by), 'label.by', "'model' or 'human'")
    p.need(isStr(label.rationale) && label.rationale.trim() !== '', 'label.rationale', 'a non-empty string')
  }
  const input = k.input
  const expect = k.expect
  if (category !== null && p.need(isObj(input), 'input', 'an object') && p.need(isObj(expect), 'expect', 'an object')) {
    const i = input as Obj
    const e = expect as Obj
    if (category === 'submit') checkSubmit(p, i, e)
    if (category === 'midrun') checkMidrun(p, i, e)
    if (category === 'agent') checkAgent(p, i, e)
    if (category === 'skill') checkSkill(p, i, e, skills)
  }
  // The fragments themselves stay out of the message: it may be printed or logged.
  for (const [path, text] of strings(c, '', [])) {
    const found = secretsIn(text).length
    if (found > 0) p.list.push(`${path}: looks like a key, a token or a local path with a user name (${found} fragment${found > 1 ? 's' : ''})`)
  }
  return p.list
}

function count<T>(xs: readonly T[], f: (x: T) => boolean): number {
  return xs.filter(f).length
}

/**
 * A category's problems (its 15 cases); an empty array means it passes. Every case must already have passed
 * checkCase: a malformed one (an input field missing, say) may make this throw.
 */
export function checkSet(category: Category, cases: readonly Case[]): string[] {
  const problems: string[] = []
  const want = (ok: boolean, what: string): void => {
    if (!ok) problems.push(`${category}: needs ${what}`)
  }
  want(cases.length === SET_SIZE, `exactly ${SET_SIZE} cases (has ${cases.length})`)
  const strays = cases.filter((c) => c.category !== category).map((c) => c.id)
  want(strays.length === 0, `only ${category} cases (${strays.join(', ')} are not)`)
  const ids = cases.map((c) => c.id)
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  want(repeated.length === 0, `distinct ids (${repeated.join(', ')} repeat)`)
  const sizes = SETS.map((s) => count(cases, (c) => c.set === s))
  want(SETS.every((s, i) => sizes[i] === SPLIT[s]), `the split fit 6 / check 4 / heldout 5 (is ${sizes.join(' / ')})`)
  const hardish = cases.filter((c) => c.difficulty === 'boundary' || c.difficulty === 'negative')
  want(hardish.length >= 5, `at least 5 boundary or negative cases (has ${hardish.length})`)
  const hardishHeldout = count(hardish, (c) => c.set === 'heldout')
  want(hardishHeldout >= 2, `at least 2 boundary or negative cases in heldout (has ${hardishHeldout})`)
  // Amendments A2, A13: related cases stay in one set, so no set learns from another's session.
  const sessions = new Map<string, Case[]>()
  for (const c of cases) if (c.session !== undefined) sessions.set(c.session, [...(sessions.get(c.session) ?? []), c])
  for (const [session, group] of sessions) {
    const sets = [...new Set(group.map((c) => c.set))]
    want(sets.length === 1, `all cases of session ${session} in one set (${group.map((c) => `${c.id} in ${c.set}`).join(', ')})`)
  }
  const tagged = (xs: readonly Case[], tag: string): number => count(xs, (c) => c.tags.includes(tag))

  if (category === 'submit') {
    const withPrevious = cases.filter((c): c is SubmitCase => c.category === 'submit' && c.input.previous !== null)
    want(withPrevious.length >= 5, `at least 5 cases with a previous turn (has ${withPrevious.length})`)
    const continues = tagged(withPrevious, 'continues')
    want(continues >= 2, `at least 2 cases with a previous turn tagged 'continues' (has ${continues})`)
    const unattended = tagged(cases, 'long-unattended')
    want(unattended >= 2, `at least 2 cases tagged 'long-unattended' (has ${unattended})`)
  }
  if (category === 'midrun') {
    const midrun = cases.filter((c): c is MidrunCase => c.category === 'midrun')
    const holds = count(midrun, (c) => c.expect.action === 'hold')
    want(holds >= 8, `at least 8 cases whose action is hold (has ${holds})`)
    for (const tag of MIDRUN_TAGS) {
      const n = tagged(midrun, tag)
      want(n >= 2, `at least 2 cases tagged '${tag}' (has ${n})`)
    }
    const code = count(midrun, (c) => c.input.codeMode)
    want(code >= 5, `at least 5 cases with codeMode true (has ${code})`)
    want(midrun.length - code >= 5, `at least 5 cases with codeMode false (has ${midrun.length - code})`)
  }
  if (category === 'agent') {
    const agent = cases.filter((c): c is AgentCase => c.category === 'agent')
    const lower = count(agent, (c) => !c.expect.models.includes(c.input.inherit.tier))
    want(lower >= 3, `at least 3 cases whose models leave out input.inherit.tier (has ${lower})`)
    const keep = count(agent, (c) => c.expect.models.length > 0 && c.expect.models.every((t) => t === c.input.inherit.tier))
    want(keep >= 5, `at least 5 cases whose models are only input.inherit.tier (has ${keep})`)
  }
  if (category === 'skill') {
    const none = cases.filter((c): c is SkillCase => c.category === 'skill' && c.expect.skill === null)
    want(none.length >= 5, `at least 5 cases whose expect.skill is null (has ${none.length})`)
    // Amendment A7: the three kinds of "nothing fits" each appear.
    for (const tag of SKILL_NEGATIVE_TAGS) want(tagged(none, tag) >= 1, `a case tagged '${tag}' among those whose expect.skill is null`)
  }
  return problems
}

// Prefixed tokens need 8 more characters, so prose like "the sk- prefix" passes; a bearer token also needs a digit,
// so "Bearer authentication" passes.
const PREFIXED = [/\b(?:sk-|ghp_)[A-Za-z0-9_-]{8,}/g, /\bnace_sk_[A-Za-z0-9_-]{8,}/g]
const BEARER = /\bBearer [A-Za-z0-9._~+/=-]{8,}/g
const HEX = /\b[0-9a-fA-F]{32,}\b/g
// A random base64 run of 32 or more has a digit and both cases all but always; a long identifier or path seldom does.
const BASE64 = [/[A-Za-z0-9+/]{32,}={0,2}/g, /[A-Za-z0-9_-]{32,}/g]
// A home directory with or without a path after it ("cd /Users/someone"); quotes and brackets end the name.
const USER_PATH = /\/(?:Users|home)\/[^/\s'"`()<>[\]{},;]+\/?/g
// The placeholder user, however the path ends ("/Users/user", "/Users/user/", "/Users/user.").
const isPlaceholderUser = (s: string): boolean => s.replace(/[/.:]+$/, '') === '/Users/user'

/** The fragments of a text that look like a key, a token or a local path with a user name in it. */
export function secretsIn(text: string): string[] {
  const hits: { at: number; text: string }[] = []
  const scan = (re: RegExp, keep: (s: string) => boolean = () => true): void => {
    for (const m of text.matchAll(re)) if (keep(m[0])) hits.push({ at: m.index, text: m[0] })
  }
  for (const re of PREFIXED) scan(re)
  scan(BEARER, (s) => /[0-9]/.test(s))
  scan(HEX)
  for (const re of BASE64) scan(re, (s) => /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s))
  scan(USER_PATH, (s) => !isPlaceholderUser(s))
  // One secret can match several patterns: keep the first and longest of overlapping hits.
  hits.sort((a, b) => a.at - b.at || b.text.length - a.text.length)
  const out: string[] = []
  let end = -1
  for (const h of hits) {
    if (h.at < end) continue
    out.push(h.text)
    end = h.at + h.text.length
  }
  return out
}
