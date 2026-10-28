// Feature: find_skill (#12). Most skills are left out of the main agent's
// listing (features/skills.ts, ADR 0002), so when, partway through a turn,
// the work turns out to need a skill nobody suggested, the main agent can ask:
// it calls the tool with a few words on the work, and the decision model rates
// the session's skills against them with the ranker it picks a message's skill
// with (`modRanker`, ADR 0018), over the same skills by their own descriptions,
// with the recent conversation read by the same rules. Two differences: the
// main agent has asked for a skill, so the gate (does this need a skill at
// all) is not asked; and it may get several back, so stage two re-reads as
// many as it may return (findSkillMax) and returns every one whose fit reaches
// the bar, best first. Nothing is pushed: the skills come back only as the
// tool's answer.
//
// Its switch is `find-skill` (`/dp find-skill off`), apart from `skills`
// (spec #56). The tool stays registered whatever the switches say, with a
// description that never changes (the tool list is part of the prompt cache);
// switched off, it says so when called.

import type { EngineInterface, HttpInit, On } from 'claude-code'
import { type Asked, type BackendIo, describeAsked, errorText, failureText } from '../decision/backend.ts'
import { turnStartState } from '../decision/context.ts'
import { fitsBarText, type SkillBars } from '../decision/guides.ts'
import { quoteStart } from '../decision/redact.ts'
import { findSkills, modRanker, skillOpening, type SkillPick } from '../decision/skills.ts'
import { answersFor, mergeParts, type DecisionRequest } from '../decision/system-one.ts'
import { report, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { describeStages, loadCatalog, rankingSettings, secondStageMs, type CatalogSkill } from '../core/skills.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'

const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'find-skill'
/** The tool's name; the model calls it as `mcp__dispatch-pilot__find_skill`. */
const TOOL = 'find_skill'
const TOOL_CALLED = 'mcp__dispatch-pilot__find_skill'

/** What the model reads about the tool. Fixed: nothing of the session goes into it. */
const DESCRIPTION =
  "Searches this session's skills for the ones that fit a piece of work, and returns each one's exact name, its relevance (0 to 1) and what it is for. Use it when the work at hand might have a skill you have not been shown: a file format, a service or its tooling, or a way of working such as reviewing, planning, testing or releasing. Load a skill it returns with the Skill tool by that exact name. Skills only the user can start are never returned."
const INPUT = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The kind of work you need a skill for, in a few words, such as "fill in a form in a PDF file" or "review a branch before merging".',
    },
  },
  required: ['query'],
  additionalProperties: false,
}
/** How an answer that brings no skill ends: the main agent's way on. */
const CARRY_ON = 'Carry on without it, or load a skill you know with the Skill tool by its exact name.'

/**
 * The session's skills: as read earlier this session (the skills feature
 * reads them at its start), else read now and kept for the session; null
 * when the session cannot be read.
 */
async function sessionCatalog($: EngineInterface): Promise<CatalogSkill[] | null> {
  const { value } = await $.state.get(CATALOG)
  if (value) return value.skills
  const skills = await loadCatalog({
    commands: () => $.command.list(),
    listed: async () => (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.skills?.skillFrontmatter ?? [],
    overrides: async (source) => (await $.settings.read({ source })).skillOverrides,
    home: () => $.env.get('HOME'),
    cwd: () => $.session.cwd(),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    list: (path) => $.fs.list(path),
  }).catch(() => null)
  if (skills !== null) await $.state.set(CATALOG, { skills })
  return skills
}

/** One decision request for find_skill through the person's decision model, its outcome in the debug log. */
async function askLogged($: EngineInterface, ctx: Ctx, what: string, about: string, request: DecisionRequest, timeoutMs: number): Promise<Asked> {
  const io: BackendIo = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
    pace: { now: () => $.clock.now(), sentAt: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
  }
  const startedAt = await $.clock.now()
  const asked = await ctx.backend.ask(io, request, timeoutMs)
  const ms = (await $.clock.now()) - startedAt
  $.ui.log(`${what} [${Object.keys(request.questions).join(', ')}] to ${ctx.backend.name} ${about}: ${describeAsked(asked, ms)}`, { to: 'debug' })
  return asked
}

/** The opening of a catalog skill's SKILL.md for the ranking's second stage; null when it has no file. */
async function openingOf($: EngineInterface, catalog: readonly CatalogSkill[], name: string): Promise<string | null> {
  const file = catalog.find((skill) => skill.name === name)?.file ?? null
  return file === null ? null : skillOpening(await $.fs.read(file))
}

export function registerFindSkill(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: '回答主 agent 的 find_skill：挑出适合它说的那项工作的 skill' })

  /** Skills never offered (the option the skills feature reads too). */
  const neverSuggested = new Set(ctx.config.skills.neverSuggested)
  /** The decision model's bars (decision/guides.ts), and how many skills come back at most (findSkillMax). */
  const bars = () => ctx.config.guide.skills
  const most = () => ctx.config.skills.findMax
  /** How the mod's ranker ranks for find_skill: no gate, as many re-read as may come back. */
  const rankBy = rankingSettings(ctx, 'find')

  // Registered once every plugin is loaded, under a match-all matcher (other
  // features set themselves up at session start too). Without a decision
  // model nothing could rate the skills, and the main agent keeps its listing.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (ctx.backend.configured === false) return result
    try {
      // In the prompt's tool list (2.1.293 on; older engines put it behind ToolSearch, as the listing's hint allows for):
      // the main agent's skill listing is cut short, and this is its way to the rest. Its description never changes.
      const { tool } = await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: INPUT, isDeferred: false })
      if (tool !== TOOL_CALLED) $.ui.log(`find_skill is registered as ${tool}, but the hook answers ${TOOL_CALLED}: its calls will fail`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`find_skill was not registered: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })

  // The model's call: answered here, never passed on. Whatever goes wrong,
  // the answer says so at once (fail open: the turn goes on without a skill).
  on('tool.call', { tool: TOOL_CALLED }, async ($, e) => {
    if (!masterOn()) return { result: `Dispatch Pilot is switched off (/dp on turns it back on), so find_skill rated no skills. ${CARRY_ON}` }
    if (!isOn(SWITCH)) return { result: `find_skill is switched off (/dp ${SWITCH} on turns it back on), so it rated no skills. ${CARRY_ON}` }
    // A dispatched agent's listing is left whole (ADR 0002): it has every skill in view.
    if (e.agentId !== undefined) {
      return { result: "find_skill rates skills for the main agent, whose skill listing is cut short. Yours lists this session's skills: pick from it and load one with the Skill tool by its exact name." }
    }
    const query = typeof e.query === 'string' ? e.query.replace(/\s+/g, ' ').trim() : ''
    if (query === '') return { result: 'find_skill needs a query: a few words on the kind of work you need a skill for.' }
    const io: ReportIo = {
      board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
      decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
      debug: (line) => $.ui.log(line, { to: 'debug' }),
      now: () => $.clock.now(),
      toast: (text) => $.ui.toast(text),
    }
    // The main agent's own call, beside its decision for the turn: in the log, not on its node.
    const call = { feature: SWITCH, agent: 'main', aside: true as const }
    try {
      // The skills the main agent can load (those only the person can start never come back), each by its own description.
      const known = await sessionCatalog($)
      const candidates = known?.filter((skill) => skill.by === 'model' && !neverSuggested.has(skill.name)) ?? null
      if (candidates === null) {
        await report(io, { decision: { ...call, skipped: 'unread' as const } })
        return { result: `find_skill could not read this session's skills. ${CARRY_ON}` }
      }
      if (candidates.length === 0) {
        await report(io, { decision: { ...call, skipped: 'none' as const } })
        return { result: `This session has no skill that find_skill could return. ${CARRY_ON}` }
      }
      const about = `for find_skill ${quoteStart(query)}`
      const ranker = modRanker(
        {
          ask: (request, timeoutMs) => askLogged($, ctx, 'second request', about, request, timeoutMs),
          opening: (option) => openingOf($, candidates, option.name),
        },
        rankBy,
      )

      // The same state as beside a message, the work named in place of the message; the ranker's second request asks
      // about the same. Both requests share one wait: the second gets what the first left of it, and with Jev 800 ms at
      // least (core/skills.ts secondStageMs). The wait is the decision model's (findWaitMs: a message's timeoutMs with
      // Jev), within the hook's own 10 s. With one skill alone there is no Choice to ask first: it is re-read at once.
      const waitMs = ctx.config.skills.findWaitMs
      const startedAt = await $.clock.now()
      const messages = ctx.config.context.messages > 0 ? await $.session.messages().catch(() => []) : []
      const state = turnStartState({ prompt: query, messages, limits: ctx.config.context })
      const part = ranker.part(candidates)
      const asked: Asked = part === null ? { ok: true, answers: {}, model: null, inputTokens: null } : await askLogged($, ctx, 'request', about, mergeParts(state, [part]), waitMs)
      const left = secondStageMs(waitMs, (await $.clock.now()) - startedAt, ctx.config.skills.secondStageMs)
      const ranked = asked.ok ? await ranker.rank(part === null ? {} : answersFor(part, asked.answers), candidates, { state, timeoutMs: left }) : null
      const unranked = { kind: 'parse' as const, detail: 'no answer about the skills' }
      const lost = !asked.ok ? asked.failure : ranked === null ? unranked : ranked.failed
      if (ranked === null || lost !== undefined) {
        const failure = lost ?? unranked
        const why = failureText(ctx.backend.name, failure)
        await report(io, { decision: { ...call, failure: { backend: ctx.backend.name, ...failure } } })
        return { result: `find_skill could not rate the skills (${why}). ${CARRY_ON}` }
      }

      const picks = findSkills(ranked, candidates, bars(), most())
      const names = picks.map((skill) => skill.name).join('、')
      await report(io, {
        decision: {
          ...call,
          subject: quoteStart(query),
          outcome: picks.length > 0 ? `查到 ${names}` : '没查到 skill',
          reason: `${describeStages(ranked, bars(), 'find')}；最多返回 ${most()} 个`,
          tone: picks.length > 0 ? 'ok' : 'info',
          skills: { suggest: picks.map(({ name, relevance }) => ({ name, relevance })), try: [] },
        },
      })
      return { result: found(query, picks, bars()) }
    } catch (error) {
      $.ui.log(`find_skill failed: ${errorText(error)}`, { to: 'debug' })
      await report(io, { decision: { ...call, skipped: 'error' as const } })
      return { result: `find_skill could not rate the skills (an error in Dispatch Pilot, written to the debug log). ${CARRY_ON}` }
    }
  })
}

/** The answer: the skills that fit, each by name, relevance and description, most relevant first; or that none does. */
function found(query: string, picks: readonly SkillPick[], bars: SkillBars): string {
  if (picks.length === 0) {
    return `No skill fits "${query}": none reached relevance ${fitsBarText(bars)}. Carry on without one, try other words for the work, or load a skill you know with the Skill tool by its exact name.`
  }
  return [
    `Skills that fit "${query}", rated by Dispatch Pilot’s decision model (relevance 0 to 1), most relevant first. Load one with the Skill tool by its exact name if it fits the work:`,
    ...picks.map((skill) => `- ${skill.name} (relevance ${skill.relevance.toFixed(2)})${skill.description ? `: ${skill.description}` : ''}`),
  ].join('\n')
}
