// Run with `node dispatch-pilot/eval/run.ts <command> [flags]` (calibration plan, Task 6). The calibration runner: checks
// the cases, plans and sends their requests to Drex within the budget, keeps every raw answer in the private data
// directory (--data, default ~/.config/dispatch-pilot/calibration), and scores, sweeps and checks the stability of
// what came back. It writes nothing outside --data. The held-out set is asked once, with --final (Ruling C3).
//
//   check-cases                                   every case, every category of 15, and sessions across categories
//   plan  --set tune|fit|check|heldout [--variant <name>|all]... [--repeat <n>]     what is still unasked; sends nothing
//   ask   --set tune|fit|check [--variant <name>|all]... [--repeat <n>] [--concurrency <n>] [--retry-failed]
//   ask   --set heldout --final [--concurrency <n>] [--retry-failed]               the held-out pass, resumable
//   smoke                                         one request, checked field by field (amendment A4)
//   score --set fit|check|tune|heldout [--bars <file>] [--form direct] [--long-unattended] [--variant <name>]
//   sweep --path <submit.up|...|skill.fits> [--bars <file>]                         on fit
//   stability [--set ...] [--bars <file>] [--variant <name>] [--form direct] [--long-unattended]
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from '../hooks/config.ts'
import { SHORTLIST } from '../hooks/skills.ts'
import type { Skill } from '../hooks/skills.ts'
import { estimateTokens, fitState } from '../hooks/statebuild.ts'
import { CAP, mayAskHeldout, pool, spend } from './lib/budget.ts'
import type { Spent } from './lib/budget.ts'
import { checkCase, checkSessions, checkSet } from './lib/case.ts'
import type { Case, CaseSet, Category } from './lib/case.ts'
import { askDrex, hasKey } from './lib/drex.ts'
import type { Reply } from './lib/drex.ts'
import { heldoutWants, inOrder, sentState, stageOneOf, unknownVariants, variantsFor, wants } from './lib/plan.ts'
import type { Want } from './lib/plan.ts'
import { START_BARS, mark, outcomeOf, shortlistOf } from './lib/read.ts'
import type { Bars, Outcome, Stored } from './lib/read.ts'
import { VARIANTS, build } from './lib/request.ts'
import type { Built, Variant } from './lib/request.ts'
import { RATE_LIMITED, SMOKE, Store } from './lib/store.ts'
import type { Result } from './lib/store.ts'
import { conservativeFor, plateau, sweep } from './lib/sweep.ts'

const USAGE = 'usage: node dispatch-pilot/eval/run.ts <check-cases|plan|ask|smoke|score|sweep|stability> [--data <dir>] [flags]; see the head of run.ts'
const CATEGORIES: readonly Category[] = ['submit', 'midrun', 'agent', 'skill']
const SETS: Record<string, readonly CaseSet[]> = { fit: ['fit'], check: ['check'], tune: ['fit', 'check'], heldout: ['heldout'] }
const MODEL = readConfig({}).drexModel
const REPO_CASES = fileURLToPath(new URL('./cases/', import.meta.url))
const HELDOUT_STARTED = 'heldout-started'
const HELDOUT_DONE = 'heldout-done'

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

type Args = {
  cmd: string
  data: string
  set: string | null
  variants: string[]
  repeat: number
  concurrency: number
  retryFailed: boolean
  final: boolean
  bars: string | null
  form: 'default' | 'direct'
  longUnattended: boolean
  path: string | null
}

function count(v: string | undefined, flag: string, min: number): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) fail(`${flag} takes a whole number, ${min} or more\n${USAGE}`, 2)
  return n
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { cmd: argv[0] ?? '', data: join(homedir(), '.config', 'dispatch-pilot', 'calibration'), set: null, variants: [], repeat: 1, concurrency: 4, retryFailed: false, final: false, bars: null, form: 'default', longUnattended: false, path: null }
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!
    const value = (): string => argv[++i] ?? fail(`${flag} needs a value\n${USAGE}`, 2)
    if (flag === '--data') a.data = value()
    else if (flag === '--set') a.set = value()
    else if (flag === '--variant') a.variants.push(value())
    else if (flag === '--repeat') a.repeat = count(value(), flag, 1)
    else if (flag === '--concurrency') a.concurrency = count(value(), flag, 1)
    else if (flag === '--bars') a.bars = value()
    else if (flag === '--path') a.path = value()
    else if (flag === '--form') {
      const form = value()
      if (form !== 'direct' && form !== 'default') fail(`--form takes direct or default\n${USAGE}`, 2)
      a.form = form
    } else if (flag === '--retry-failed') a.retryFailed = true
    else if (flag === '--final') a.final = true
    else if (flag === '--long-unattended') a.longUnattended = true
    else fail(`unknown argument: ${flag}\n${USAGE}`, 2)
  }
  if (a.set !== null && SETS[a.set] === undefined) fail(`--set takes fit, check, tune or heldout\n${USAGE}`, 2)
  const unknown = unknownVariants(a.variants)
  if (unknown.length > 0) fail(`no category registers the variant ${unknown.join(', ')}`, 2)
  return a
}

// ---- the data: cases from the repository and the data directory, the skills snapshot

function readArray(path: string): unknown[] {
  if (!existsSync(path)) return []
  let v: unknown
  try {
    v = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`${path}: not JSON`)
  }
  if (!Array.isArray(v)) fail(`${path}: not a JSON array of cases`)
  return v
}

type Found = { where: string; value: unknown }

/** A category's cases: the model-written ones in the repository and the real ones in the data directory. */
function rawCases(data: string, category: Category): Found[] {
  return [join(REPO_CASES, category + '.json'), join(data, 'cases', category + '.json')].flatMap((path) => readArray(path).map((value) => ({ where: path, value })))
}

function readSkills(data: string): Skill[] | null {
  const path = join(data, 'skills.json')
  if (!existsSync(path)) return null
  const v = readArray(path)
  const ok = v.every((s) => typeof s === 'object' && s !== null && typeof (s as Skill).name === 'string' && typeof (s as Skill).description === 'string')
  if (!ok) fail(`${path}: not an array of { name, description }`)
  return v as Skill[]
}

const idOf = (v: unknown): string => (typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : '?')

/** Every case, each passed through checkCase; one that does not pass stops the command. */
function loadCases(data: string, skills: readonly Skill[]): Case[] {
  const names = skills.map((s) => s.name)
  const out: Case[] = []
  const problems: string[] = []
  for (const category of CATEGORIES) {
    for (const f of rawCases(data, category)) {
      const found = checkCase(f.value, names)
      if (found.length === 0) out.push(f.value as Case)
      else problems.push(...found.map((p) => `${idOf(f.value)} (${f.where}): ${p}`))
    }
  }
  if (problems.length > 0) fail(problems.join('\n') + '\nsome cases do not pass checkCase: run check-cases')
  return out
}

const inSet = (cases: readonly Case[], set: string): Case[] => cases.filter((c) => SETS[set]!.includes(c.set))

// ---- requests: built, looked up, and their state

type Ctx = { store: Store; skills: readonly Skill[] }

const variantNamed = (category: Category, name: string): Variant | undefined => VARIANTS[category].find((v) => v.name === name)

/**
 * The request of a case in a variant. A second skill request takes its shortlist from the first request's answer
 * (the same pair, repeat 1) with shortlistOf, as read.ts reads it; null when that answer is not there.
 */
function builtFor(ctx: Ctx, c: Case, v: Variant): Built | null {
  if (v.stage !== 2) return build(c, v, { skills: ctx.skills })
  const first = storedFor(ctx, c, variantNamed(c.category, stageOneOf(v.name))!, 1)
  if (first === undefined || !first.ok) return null
  const short = shortlistOf(first.answers).map((s) => ctx.skills.find((k) => k.name === s.name) ?? fail(`${c.id}: the skill ${s.name} in its stored answer is not in skills.json`))
  return build(c, v, { skills: ctx.skills, short })
}

function storedFor(ctx: Ctx, c: Case, v: Variant, repeat: number): Stored | undefined {
  const b = builtFor(ctx, c, v)
  return b === null ? undefined : ctx.store.get(b.hash, repeat)
}

type Status = 'answered' | 'failed' | 'pending' | 'after-first' | 'blocked'

/**
 * Where a wanted request stands. pending: never sent, or (with retry) failed once. after-first: a second skill request
 * whose first is still to be asked. blocked: its first request failed for good, so it cannot be built.
 */
function statusOf(ctx: Ctx, w: Want, retryFailed: boolean): { status: Status; built: Built | null } {
  const built = builtFor(ctx, w.c, w.variant)
  if (built === null) {
    const first = variantNamed(w.c.category, stageOneOf(w.variant.name))!
    const firstStatus = statusOf(ctx, { ...w, variant: first, repeat: 1 }, retryFailed).status
    return { status: firstStatus === 'pending' ? 'after-first' : 'blocked', built }
  }
  const stored = ctx.store.get(built.hash, w.repeat)
  if (stored?.ok === true) return { status: 'answered', built }
  const failures = ctx.store.failures(built.hash, w.repeat)
  return { status: failures === 0 || (retryFailed && failures === 1) ? 'pending' : 'failed', built }
}

// A request's input tokens as estimated: the body ask() sends.
function costOf(state: Record<string, unknown>, questions: unknown): Spent {
  return { requests: 1, tokens: estimateTokens(JSON.stringify({ model: MODEL, state: fitState(state), questions })) }
}

const uid = (): string => randomBytes(8).toString('hex')
const keyOf = (b: Built, repeat: number): string => `${b.hash}:${repeat}`
const budgetLine = (s: Spent): string => `spent ${s.requests} requests / ${s.tokens} tokens of ${CAP.requests} / ${CAP.tokens}`

// ---- check-cases

function checkCases(a: Args): void {
  const skills = readSkills(a.data)
  const problems: string[] = []
  if (skills === null) problems.push(`no skills.json in ${a.data}: skill cases cannot name a candidate`)
  const names = (skills ?? []).map((s) => s.name)
  const passed: Case[] = []
  for (const category of CATEGORIES) {
    const ok: Case[] = []
    let bad = 0
    for (const f of rawCases(a.data, category)) {
      const found = checkCase(f.value, names)
      if (found.length === 0) ok.push(f.value as Case)
      else (bad += 1), problems.push(...found.map((p) => `${idOf(f.value)} (${f.where}): ${p}`))
    }
    // checkSet takes only cases that passed checkCase.
    if (bad === 0) problems.push(...checkSet(category, ok))
    else problems.push(`${category}: ${bad} case(s) fail checkCase, so the category of 15 is not checked`)
    passed.push(...ok)
  }
  problems.push(...checkSessions(passed))
  if (problems.length > 0) fail(problems.join('\n'))
  console.log(`all four categories pass (${passed.length} cases)`)
}

// ---- plan and ask

function wanted(a: Args, cases: readonly Case[]): Want[] {
  if (a.set === null) fail(`--set is needed\n${USAGE}`, 2)
  const set = inSet(cases, a.set)
  if (a.set === 'heldout') return heldoutWants(set)
  return wants(set, a.variants, a.repeat)
}

function plan(a: Args, ctx: Ctx, cases: readonly Case[]): void {
  const rows = new Map<string, { pending: number; waiting: number; answered: number; failed: number; blocked: number; tokens: number }>()
  const seen = new Set<string>()
  let pending = 0
  let tokens = 0
  // A second skill request not yet buildable is estimated over a stand-in shortlist.
  const standIn = ctx.skills.slice(0, SHORTLIST)
  for (const w of wanted(a, cases)) {
    const label = `${w.c.category} ${w.variant.name}`
    const row = rows.get(label) ?? { pending: 0, waiting: 0, answered: 0, failed: 0, blocked: 0, tokens: 0 }
    rows.set(label, row)
    const { status, built } = statusOf(ctx, w, a.retryFailed)
    if (status === 'answered') row.answered += 1
    else if (status === 'failed') row.failed += 1
    else if (status === 'blocked') row.blocked += 1
    else {
      const b = built ?? build(w.c, w.variant, { skills: ctx.skills, short: standIn })
      // The same request wanted twice (two variants that come out alike) is sent once.
      if (built !== null && seen.has(keyOf(built, w.repeat))) continue
      if (built !== null) seen.add(keyOf(built, w.repeat))
      const cost = costOf(sentState(b.state, w.repeat, () => '0'.repeat(16)), b.questions).tokens
      if (status === 'after-first') row.waiting += 1
      else row.pending += 1
      row.tokens += cost
      pending += 1
      tokens += cost
    }
  }
  for (const [label, r] of rows) {
    const waiting = r.waiting > 0 ? ` (${r.waiting} after their first skill request)` : ''
    const blocked = r.blocked > 0 ? `, ${r.blocked} blocked by a failed first request` : ''
    console.log(`${label}: ${r.pending + r.waiting} to ask${waiting}, about ${r.tokens} tokens; ${r.answered} answered, ${r.failed} failed${blocked}`)
  }
  console.log(`total: ${pending} requests to ask, about ${tokens} tokens; ${budgetLine(ctx.store.spent())}`)
}

type Sent = { w: Want; built: Built; result: Result; state: Record<string, unknown>; at: string; ms: number }

const isRateLimit = (r: Result): boolean => !r.ok && r.status === RATE_LIMITED
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * serial: a rate limit was met, so whatever this run sends next goes one at a time. rateLimited: a request was still
 * rate-limited after its retries; it is not stored, and the run must stop.
 */
async function send(ctx: Ctx, items: readonly { w: Want; built: Built }[], concurrency: number): Promise<{ sent: Sent[]; stopped: boolean; serial: boolean; rateLimited: boolean }> {
  const out = await pool(items, {
    concurrency,
    reserve: (it) => {
      const cost = costOf(sentState(it.built.state, it.w.repeat, () => '0'.repeat(16)), it.built.questions)
      const after = spend(ctx.store.spent(), cost)
      if (after === null) {
        console.log(`budget reached, stopping: ${budgetLine(ctx.store.spent())}`)
        return false
      }
      ctx.store.setSpent(after)
      return true
    },
    run: async (it) => {
      const state = sentState(it.built.state, it.w.repeat, uid)
      const at = new Date().toISOString()
      const { result, ms } = await askDrex({ state, questions: it.built.questions, partial: it.built.partial })
      return { w: it.w, built: it.built, result, state, at, ms }
    },
    // A rate-limited answer never gets here: it is neither an answer nor a failure, so it is not stored.
    keep: (_, s) => {
      ctx.store.add({ hash: s.built.hash, repeat: s.w.repeat, caseId: s.w.c.id, category: s.w.c.category, variant: s.w.variant.name, at: s.at, ms: s.ms, request: { state: fitState(s.state), questions: s.built.questions }, result: s.result })
      const how = s.result.ok ? 'ok' : `failed: ${s.result.reason}${s.result.status !== undefined ? ' ' + s.result.status : ''}`
      console.log(`${s.w.c.id} ${s.w.variant.name} #${s.w.repeat}: ${how} (${s.ms} ms)`)
    },
    rateLimit: {
      limited: (s) => isRateLimit(s.result),
      sleep: wait,
      onWait: (it, ms) => console.log(`${it.w.c.id} ${it.w.variant.name} #${it.w.repeat}: rate limited; asking again in ${ms / 1000} s, and one at a time from now on`),
    },
  })
  return { sent: out.results, stopped: out.stopped, serial: out.serial, rateLimited: out.rateLimited }
}

function pendingOf(a: Args, ctx: Ctx, ws: readonly Want[]): { w: Want; built: Built }[] {
  const seen = new Set<string>()
  const out: { w: Want; built: Built }[] = []
  for (const w of ws) {
    const { status, built } = statusOf(ctx, w, a.retryFailed)
    if (status !== 'pending' || built === null || seen.has(keyOf(built, w.repeat))) continue
    seen.add(keyOf(built, w.repeat))
    out.push({ w, built })
  }
  return out
}

async function askCommand(a: Args, ctx: Ctx, cases: readonly Case[]): Promise<void> {
  if (a.set === 'heldout') {
    const done = existsSync(join(a.data, HELDOUT_DONE))
    if (!mayAskHeldout({ final: a.final, alreadyDone: done })) fail(done ? 'the held-out set has been asked: heldout-done exists' : 'the held-out set is asked only with --final')
    if (a.variants.length > 0 || a.repeat !== 1) fail('the held-out pass asks every registered variant: it takes no --variant or --repeat', 2)
  }
  if (!hasKey()) fail('没有密钥: NACE_API_KEY is not set')
  if (a.set === 'heldout') {
    if (!existsSync(join(a.data, HELDOUT_STARTED))) writeFileSync(join(a.data, HELDOUT_STARTED), new Date().toISOString() + '\n', { mode: 0o600 })
  }
  const all = wanted(a, cases)
  const { first, second } = inOrder(all)
  const one = await send(ctx, pendingOf(a, ctx, first), a.concurrency)
  // Second skill requests are built from the first answers just stored; after a rate limit they too go one at a time.
  const two = one.stopped || one.rateLimited ? { sent: [], rateLimited: false } : await send(ctx, pendingOf(a, ctx, second), one.serial ? 1 : a.concurrency)
  const sent = [...one.sent, ...two.sent]
  const ok = sent.filter((s) => s.result.ok).length
  console.log(`stored ${sent.length}: ${ok} answered, ${sent.length - ok} failed; ${budgetLine(ctx.store.spent())}`)
  // Still rate-limited after the retries: nothing more is sent, and the held-out pass stays open to be resumed.
  if (one.rateLimited || two.rateLimited) fail('still rate limited after 3 retries: stopped; that request is not stored, so the same command asks it again later', 3)
  if (a.set !== 'heldout') return
  // Every planned request answered, failed, or blocked by its failed first request: the pass is over.
  const left = all.filter((w) => {
    const s = statusOf(ctx, w, false).status
    return s === 'pending' || s === 'after-first'
  }).length
  if (left === 0) {
    writeFileSync(join(a.data, HELDOUT_DONE), new Date().toISOString() + '\n', { mode: 0o600 })
    console.log('the held-out pass is complete: heldout-done written')
  } else console.log(`the held-out pass stopped with ${left} requests unasked: run the same command again to go on`)
}

// ---- smoke (amendment A4)

async function smoke(a: Args, ctx: Ctx, cases: readonly Case[]): Promise<void> {
  if (!hasKey()) fail('没有密钥: NACE_API_KEY is not set')
  // A model-written case outside the held-out set: nothing held out is sent before its one pass.
  const c = cases.filter((x) => x.category === 'submit' && x.source === 'written' && x.set !== 'heldout').sort((x, y) => (x.id < y.id ? -1 : 1))[0]
  if (c === undefined) fail('no model-written submit case outside the held-out set to build the smoke request from')
  const v = VARIANTS.submit[0]!
  const built = build(c, v, { skills: ctx.skills })
  const after = spend(ctx.store.spent(), costOf(built.state, built.questions))
  if (after === null) fail(`budget reached: ${budgetLine(ctx.store.spent())}`)
  ctx.store.setSpent(after)
  let reply: Reply | undefined
  const at = new Date().toISOString()
  const { result, ms } = await askDrex({ state: built.state, questions: built.questions, partial: built.partial }, (r) => (reply = r))
  ctx.store.add({ hash: built.hash, repeat: 1, caseId: c.id, category: c.category, variant: SMOKE, at, ms, request: { state: fitState(built.state), questions: built.questions }, result })
  const body = (reply?.body ?? {}) as { model?: unknown; answers?: Record<string, { type?: unknown; choice?: unknown; probabilities?: unknown }> }
  const answers = typeof body.answers === 'object' && body.answers !== null ? body.answers : {}
  const ids = Object.keys(built.questions)
  const missing = ids.filter((id) => answers[id]?.type !== built.questions[id]!.type)
  const badOptions = ids.filter((id) => {
    const q = built.questions[id]!
    if (q.type !== 'choice') return false
    const p = answers[id]?.probabilities
    const names = typeof p === 'object' && p !== null ? Object.keys(p) : []
    const want = Object.keys(q.criteria)
    return names.length !== want.length || !want.every((n) => names.includes(n)) || !want.includes(answers[id]?.choice as string)
  })
  const status = reply?.status
  const checks: [boolean, string][] = [
    [status !== undefined && status >= 200 && status < 300, status !== undefined ? `HTTP ${status}` : `no HTTP reply (${result.ok ? 'ok' : result.reason})`],
    [body.model === MODEL, `model ${typeof body.model === 'string' ? body.model : '(none)'}, wanted ${MODEL}`],
    [missing.length === 0, missing.length === 0 ? `all ${ids.length} questions answered with their type` : `not answered with their type: ${missing.join(', ')}`],
    [badOptions.length === 0, badOptions.length === 0 ? "every choice answer's options are the question's" : `options differ from the question's: ${badOptions.join(', ')}`],
    [result.ok, result.ok ? 'ask() reads the answer' : `ask() reads no answer: ${result.reason}`],
  ]
  for (const [ok, text] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`)
  console.log(`smoke request (${c.id}, ${ms} ms) stored as variant ${SMOKE}; ${budgetLine(ctx.store.spent())}`)
  if (checks.some(([ok]) => !ok)) process.exit(1)
}

// ---- reading: score, sweep, stability

function readBars(path: string | null): Bars {
  if (path === null) return START_BARS
  let v: Record<string, Record<string, unknown>>
  try {
    v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>
  } catch {
    fail(`${path}: not a JSON file`)
  }
  const bars = { ...START_BARS } as Record<string, Record<string, number>>
  for (const [group, values] of Object.entries(v)) {
    if (bars[group] === undefined || typeof values !== 'object' || values === null) fail(`${path}: no threshold group ${group}`)
    for (const [k, x] of Object.entries(values)) {
      if (!(k in bars[group]!) || typeof x !== 'number' || x < 0 || x > 1) fail(`${path}: ${group}.${k} must be a known threshold between 0 and 1`)
    }
    bars[group] = { ...bars[group]!, ...(values as Record<string, number>) }
  }
  return bars as unknown as Bars
}

/** The variant read for a category (the first of a skill pair), or null when the category does not register it. */
function readVariant(category: Category, names: readonly string[]): Variant | null {
  if (names.length > 1 || names.includes('all')) fail(`score and stability read one variant at a time: give one --variant <name>, or none for the default\n${USAGE}`, 2)
  const name = names[0] ?? VARIANTS[category][0]!.name
  return variantNamed(category, category === 'skill' ? stageOneOf(name) : name) ?? null
}
const secondOf = (v: Variant): Variant | undefined => variantNamed('skill', v.name.replace('stage-1', 'stage-2'))

type Opt = { form: 'default' | 'direct'; longUnattended: boolean }

/** A case's outcome at the nth asking, or why there is none. */
function outcomeAt(ctx: Ctx, c: Case, v: Variant, repeat: number, bars: Bars, opt: Opt): Outcome | string {
  const first = storedFor(ctx, c, v, repeat)
  if (first === undefined) return 'not asked'
  if (!first.ok) return `failed: ${first.reason}`
  const second = c.category === 'skill' ? storedFor(ctx, c, secondOf(v)!, repeat) : undefined
  return outcomeOf(c, first, bars, { ...opt, second }) ?? (c.category === 'skill' && second === undefined ? 'no second request' : 'unreadable')
}

function expected(c: Case): string {
  if (c.category === 'skill') return [c.expect.skill ?? 'none', ...c.expect.alsoOk].join('/')
  if (c.category === 'midrun') return `${c.expect.action} ${c.expect.accept.join('/')}`
  if (c.category === 'agent') return `${c.expect.accept.join('/')} · ${c.expect.models.join('/')}`
  return c.expect.accept.join('/')
}

function decision(c: Case, o: Outcome): string {
  if (c.category === 'skill') return o.skill ?? 'none'
  return c.category === 'agent' ? `${o.level} · ${o.model}` : String(o.level)
}

function refuseHeldout(a: Args): void {
  if (a.set === 'heldout' && !existsSync(join(a.data, HELDOUT_DONE))) fail('the held-out set is not read before its one pass is complete (no heldout-done)')
}

function score(a: Args, ctx: Ctx, cases: readonly Case[]): void {
  if (a.set === null) fail(`--set is needed\n${USAGE}`, 2)
  refuseHeldout(a)
  const bars = readBars(a.bars)
  const opt: Opt = { form: a.form, longUnattended: a.longUnattended }
  for (const category of CATEGORIES) {
    const v = readVariant(category, a.variants)
    const set = inSet(cases, a.set).filter((c) => c.category === category).sort((x, y) => (x.id < y.id ? -1 : 1))
    if (v === null || set.length === 0) continue
    const marks: Record<string, number> = {}
    let none = 0
    for (const c of set) {
      const o = outcomeAt(ctx, c, v, 1, bars, opt)
      if (typeof o === 'string') {
        none += 1
        console.log(`${c.id}  expected ${expected(c)}  no answer (${o})`)
        continue
      }
      const m = mark(c, o)
      marks[m] = (marks[m] ?? 0) + 1
      console.log(`${c.id}  expected ${expected(c)}  got ${decision(c, o)}  ${m}`)
    }
    const tally = Object.entries(marks).map(([m, n]) => `${m} ${n}`).join(', ')
    console.log(`${category} ${v.name}: right ${marks.right ?? 0} of ${set.length}, no answer ${none}${tally ? ` (${tally})` : ''}`)
  }
}

/** The cases whose repeats decide differently under these bars, and those with a repeat that has no outcome. */
function stabilityOf(ctx: Ctx, cases: readonly Case[], names: readonly string[], bars: Bars, opt: Opt): { asked: number; unstable: { c: Case; got: string[] }[]; gaps: Case[] } {
  const unstable: { c: Case; got: string[] }[] = []
  const gaps: Case[] = []
  let asked = 0
  for (const c of cases) {
    const v = readVariant(c.category, names)
    const built = v === null ? null : builtFor(ctx, c, v)
    if (v === null || built === null) continue
    const repeats = ctx.store.repeats(built.hash)
    if (repeats.length < 2) continue
    asked += 1
    const got = repeats.map((r) => {
      const o = outcomeAt(ctx, c, v, r, bars, opt)
      return typeof o === 'string' ? null : decision(c, o)
    })
    if (got.includes(null)) gaps.push(c)
    const decided = got.filter((d): d is string => d !== null)
    if (new Set(decided).size > 1) unstable.push({ c, got: got.map((d, i) => `#${repeats[i]} ${d ?? '(no answer)'}`) })
  }
  return { asked, unstable, gaps }
}

function stability(a: Args, ctx: Ctx, cases: readonly Case[]): void {
  const set = a.set ?? 'tune'
  refuseHeldout({ ...a, set })
  const s = stabilityOf(ctx, inSet(cases, set), a.variants, readBars(a.bars), { form: a.form, longUnattended: a.longUnattended })
  for (const u of s.unstable) console.log(`${u.c.id}: ${u.got.join(', ')}`)
  if (s.gaps.length > 0) console.log(`a repeat with no answer: ${s.gaps.map((c) => c.id).join(', ')}`)
  console.log(`${s.asked} cases asked more than once, ${s.unstable.length} decide differently`)
}

function sweepCommand(a: Args, ctx: Ctx, cases: readonly Case[]): void {
  if (a.path === null) fail(`--path is needed\n${USAGE}`, 2)
  const path = a.path
  const category = path.split('.')[0] as Category
  if (!CATEGORIES.includes(category)) fail(`no threshold at ${path}`, 2)
  const base = readBars(a.bars)
  const fit = inSet(cases, 'fit').filter((c) => c.category === category)
  // Amendment A13: stability is judged once under the start values, before any sweep; a case whose repeats decide
  // differently there takes no part in the sweep, whatever --bars gives.
  const { unstable } = stabilityOf(ctx, fit, [], START_BARS, { form: 'default', longUnattended: false })
  const out = new Set(unstable.map((u) => u.c.id))
  if (out.size > 0) console.log(`left out (repeats decide differently): ${[...out].join(', ')}`)
  const kept = fit.filter((c) => !out.has(c.id))
  const byId = new Map(kept.map((c) => [c.id, c]))
  const stored = (id: string, variant: string): Stored | undefined => {
    const c = byId.get(id)!
    const v = variantNamed(c.category, variant)
    return v === undefined ? undefined : storedFor(ctx, c, v, 1)
  }
  const rows = sweep(kept, stored, base, path)
  for (const r of rows) console.log(`${r.value.toFixed(2)}  right ${String(r.right).padStart(2)}  no answer ${r.unusable}  ${'█'.repeat(r.right)}`)
  const p = plateau(rows, conservativeFor(path))
  console.log(`${path}: best ${p.best} of ${kept.length} from ${p.from.toFixed(2)} to ${p.to.toFixed(2)}; the conservative end is ${p.pick.toFixed(2)}`)
}

// ---- main

const a = parseArgs(process.argv.slice(2))
if (!existsSync(a.data) || !statSync(a.data).isDirectory()) fail(`no data directory: ${a.data}`)
if (a.cmd === 'check-cases') checkCases(a)
else if (['plan', 'ask', 'smoke', 'score', 'sweep', 'stability'].includes(a.cmd)) {
  // Skill cases and the with-skills variant are built over the candidates snapshot.
  const skills = readSkills(a.data) ?? fail(`no skills.json in ${a.data}: the requests are built over the candidates snapshot`)
  const cases = loadCases(a.data, skills)
  const ctx: Ctx = { store: new Store(a.data), skills }
  if (a.cmd === 'plan') plan(a, ctx, cases)
  else if (a.cmd === 'ask') await askCommand(a, ctx, cases)
  else if (a.cmd === 'smoke') await smoke(a, ctx, cases)
  else if (a.cmd === 'score') score(a, ctx, cases)
  else if (a.cmd === 'sweep') sweepCommand(a, ctx, cases)
  else stability(a, ctx, cases)
} else fail(USAGE, 2)
