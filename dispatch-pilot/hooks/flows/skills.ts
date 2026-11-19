// Skills (design 5.6): the suggestion's second request, the Decision held for its turn, the listing kept as the
// candidates, and find-skill.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptAttachmentResult } from 'claude-code'

import { ask } from '../backend.ts'
import type { AskResult } from '../backend.ts'
import type { Config } from '../config.ts'
import { decisionId } from '../log.ts'
import { failOpen, ioOf, record } from '../runtime.ts'
import {
  LISTING_NOTE,
  NO_CANDIDATES_REPLY,
  SECOND_LATE,
  SECOND_MIN_MS,
  findSkillReply,
  mergeSkills,
  parseListing,
  pickMany,
  queryOf,
  readStageOne,
  readStageTwo,
  searchFailedReply,
  shortlist,
  skillDecision,
  stageOne,
  stageTwo,
  suggestionBlock,
} from '../skills.ts'
import type { Skill, SkillOutcome } from '../skills.ts'
import { emptySession } from '../state.ts'
import { submitState } from '../statebuild.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const SKILLS = atom({ plugin: 'dispatch-pilot', key: 'skills' } as const, [])

// The second request, on the shortlist, with what is left of submitTimeoutMs.
export async function suggestSkill($: EngineInterface, cfg: Config, c: { skills: Skill[]; state: unknown; first: AskResult; asked: string[]; t0: number }): Promise<SkillOutcome> {
  const none = { first: c.first, asked: c.asked, second: null, skill: null }
  const one = readStageOne(c.skills, c.first, true)
  if ('detail' in one) return { ...none, detail: one.detail }
  const left = cfg.submitTimeoutMs - ((await $.clock.now()) - c.t0)
  if (left < SECOND_MIN_MS) return { ...none, detail: SECOND_LATE }
  const second = await ask(ioOf($), cfg, { state: c.state, questions: stageTwo(one.short, cfg.backend) }, left)
  return { ...none, second, ...readStageTwo(one.short, second) }
}

// A message's skill judgement, from its prompt.submit to the turn.start of its text, where the turn's id is known
// (prompt.submit's own reads cannot see that turn: one dispatch reads one moment). prompt.submit cannot tell after
// next(e) whether a turn took it: next(e) returns once turn.start's hook has started, and that hook may finish after
// (measured on 2.1.328; F1). So it stays held until one of three records it, once: the turn.start of its text; the
// prompt.submit of a dropped message; or the next message's holdSkill, with no turn, when no turn took it (none
// started, or another mod rewrote the text). Module level: a hot reload or the session's end loses a held judgement.
let skillOut: { text: string; outcome: SkillOutcome; applied: boolean } | null = null

// A message's skill judgement, held for the turn.start of its text. One still held (no turn took it) is recorded
// first, with no turn; the new one is held even when that write fails.
export async function holdSkill($: EngineInterface, held: NonNullable<typeof skillOut>): Promise<null> {
  const stale = skillOut
  skillOut = null
  try {
    if (stale !== null) await recordSkill($, stale.outcome, { turnId: null, applied: false })
  } finally {
    skillOut = held
  }
  return null
}

// The judgement held for this text, taken so it is recorded once (null: none held for it).
export function takeSkillFor(text: string): typeof skillOut {
  const mine = skillOut !== null && skillOut.text === text ? skillOut : null
  if (mine !== null) skillOut = null
  return mine
}

// A message that did not go in starts no turn: its judgement, if still held, is recorded now, with none.
export async function recordDropped($: EngineInterface, outcome: SkillOutcome): Promise<null> {
  if (skillOut?.outcome !== outcome) return null
  skillOut = null
  return recordSkill($, outcome, { turnId: null, applied: false })
}

// A message sent while no candidate was recorded yet (measured: a session's first listing comes after its first message's
// prompt.submit), held by its text for its turn.start to mark the turn (TurnState.skillsDue): the first main-loop listing
// in that turn judges it then. Module level: a hot reload in between loses it, and that message gets no suggestion.
let unjudged: string | null = null

/** A message judged for nothing about skills for want of candidates (apply mode only: shadow suggests nothing). */
export function holdUnjudged(text: string): void {
  unjudged = text
}

/** At a main-loop turn.start: whether its message was held so; whatever was held is let go. */
export function takeUnjudged(text: string): boolean {
  const mine = unjudged === text
  unjudged = null
  return mine
}

export async function recordSkill($: EngineInterface, o: SkillOutcome, c: { turnId: string | null; applied: boolean }): Promise<null> {
  const at = await $.clock.now()
  await record($, skillDecision(o, { id: decisionId(at), at, turnId: c.turnId, applied: c.applied }))
  return null
}

// The main loop's skill listing: its skills are kept as the candidates, and the main agent reads LISTING_NOTE instead,
// with a suggestion after it when the running turn's message is judged now (judgeLate). In shadow the listing is kept
// and left as it came (design 5.10: judge and record, change nothing). Null: the listing is left as it came.
export async function foldListing($: EngineInterface, cfg: Config, text: string): Promise<PromptAttachmentResult | null> {
  const listed = parseListing(text)
  if (listed.length === 0) return null
  // A later listing is a delta (a skill added mid-session): merged into the candidates, never replacing them.
  const box: { skills: Skill[] } = { skills: [] }
  await update($, SKILLS, (held) => {
    box.skills = mergeSkills(held, listed)
    return box.skills
  })
  if (cfg.mode !== 'apply') return null
  // A failure here folds all the same: the suggestion is what is lost.
  const block = await failOpen($, 'prompt.attachment', null, () => judgeLate($, cfg, box.skills))
  return { text: block === null ? LISTING_NOTE : `${LISTING_NOTE}\n\n${block}` }
}

// The running turn's message, sent when no candidate was recorded (TurnState.skillsDue), judged now with these: the
// two requests as at prompt.submit, within submitTimeoutMs in all, once per turn. The suggestion block, or null.
async function judgeLate($: EngineInterface, cfg: Config, skills: Skill[]): Promise<string | null> {
  const held = await read($, TURN)
  if (held === null || !held.skillsDue || skills.length === 0) return null
  const turnId = held.turnId
  // Claimed on what update() reads, so two listings at once judge it once.
  const box = { mine: false }
  await update($, TURN, (cur) => {
    box.mine = cur !== null && cur.turnId === turnId && cur.skillsDue
    return box.mine && cur !== null ? { ...cur, skillsDue: false } : cur
  })
  if (!box.mine) return null
  const state = submitState({ request: held.request, previous: (await read($, SESSION)).previous })
  const t0 = await $.clock.now()
  const questions = stageOne(skills, cfg.backend, true)
  const first = await ask(ioOf($), cfg, { state, questions }, cfg.submitTimeoutMs)
  const outcome = await suggestSkill($, cfg, { skills, state, first, asked: Object.keys(questions), t0 })
  const block = outcome.skill === null ? null : suggestionBlock(outcome.skill)
  await recordSkill($, outcome, { turnId, applied: block !== null })
  return block
}

// find-skill: the same two requests on a few words of the agent's, without the gate (the agent is already asking for
// a skill), answering with every skill that fits, at most three.
export async function findSkill($: EngineInterface, cfg: Config, text: string): Promise<string> {
  const query = queryOf(text)
  if (query === '') return findSkillReply('', [], null)
  const skills = await read($, SKILLS)
  if (skills.length === 0) return NO_CANDIDATES_REPLY
  const state = submitState({ request: query, previous: null })
  const t0 = await $.clock.now()
  // A single candidate on Jev has no choice to ask: it is the shortlist without a first request.
  const questions = stageOne(skills, cfg.backend, false)
  const first: AskResult | null = Object.keys(questions).length === 0 ? null : await ask(ioOf($), cfg, { state, questions }, cfg.submitTimeoutMs)
  // The search did not run: the reply lists the candidates instead (never worse than the listing it replaced).
  if (first !== null && !first.ok) return searchFailedReply(query, first.reason, skills)
  const short = shortlist(skills, first?.answers ?? {})
  if (short.length === 0) return findSkillReply(query, [], null)
  const left = cfg.submitTimeoutMs - ((await $.clock.now()) - t0)
  if (left < SECOND_MIN_MS) return searchFailedReply(query, 'timeout', skills)
  const second = await ask(ioOf($), cfg, { state, questions: stageTwo(short, cfg.backend) }, left)
  return second.ok ? findSkillReply(query, pickMany(short, second.answers), null) : searchFailedReply(query, second.reason, skills)
}
