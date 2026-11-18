// Skills (design 5.6): the suggestion's second request, the Decision held for its turn, the listing kept as the
// candidates, and find-skill.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptAttachmentResult } from 'claude-code'

import { ask } from '../backend.ts'
import type { AskResult } from '../backend.ts'
import type { Config } from '../config.ts'
import { decisionId } from '../log.ts'
import { ioOf, record } from '../runtime.ts'
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
  shortlist,
  skillDecision,
  stageOne,
  stageTwo,
} from '../skills.ts'
import type { Skill, SkillOutcome } from '../skills.ts'
import { submitState } from '../statebuild.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
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

// A message's skill judgement, from its prompt.submit to the turn.start its next(e) raises with the same text, where
// the turn's id is known (prompt.submit's own reads cannot see that turn: one dispatch reads one moment). The Decision
// is recorded there, or after next(e) with no turn when none started. Module level: a hot reload in between loses
// that one Decision.
let skillOut: { text: string; outcome: SkillOutcome; applied: boolean } | null = null

// A message's skill judgement, held for the turn.start of its text.
export function holdSkill(held: NonNullable<typeof skillOut>): void {
  skillOut = held
}

// The judgement held for this text, taken so it is recorded once (null: none held for it).
export function takeSkillFor(text: string): typeof skillOut {
  const mine = skillOut !== null && skillOut.text === text ? skillOut : null
  if (mine !== null) skillOut = null
  return mine
}

// After prompt.submit's next(e): whether this judgement is still held (no turn took it), taken if so.
export function takeUnclaimed(outcome: SkillOutcome): boolean {
  if (skillOut?.outcome !== outcome) return false
  skillOut = null
  return true
}

export async function recordSkill($: EngineInterface, o: SkillOutcome, c: { turnId: string | null; applied: boolean }): Promise<null> {
  const at = await $.clock.now()
  await record($, skillDecision(o, { id: decisionId(at), at, turnId: c.turnId, applied: c.applied }))
  return null
}

// The main loop's skill listing: its skills are kept as the candidates, and the main agent reads LISTING_NOTE instead.
// Null: the listing is left as it came.
export async function foldListing($: EngineInterface, text: string): Promise<PromptAttachmentResult | null> {
  const listed = parseListing(text)
  if (listed.length === 0) return null
  // A later listing is a delta (a skill added mid-session): merged into the candidates, never replacing them.
  await update($, SKILLS, (held) => mergeSkills(held, listed))
  return { text: LISTING_NOTE }
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
  if (first !== null && !first.ok) return findSkillReply(query, [], first.reason)
  const short = shortlist(skills, first?.answers ?? {})
  if (short.length === 0) return findSkillReply(query, [], null)
  const left = cfg.submitTimeoutMs - ((await $.clock.now()) - t0)
  if (left < SECOND_MIN_MS) return findSkillReply(query, [], 'timeout')
  const second = await ask(ioOf($), cfg, { state, questions: stageTwo(short, cfg.backend) }, left)
  return second.ok ? findSkillReply(query, pickMany(short, second.answers), null) : findSkillReply(query, [], second.reason)
}
