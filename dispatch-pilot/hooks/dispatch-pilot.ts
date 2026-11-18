// The mod's wiring: every hook, and inside each the order in which the features act. What each feature does with $
// lives in flows/ (beside its pure module in hooks/), what they share in runtime.ts (DEVELOPMENT.md, "Where code lives").
import type { Register } from 'claude-code'

import { canAsk } from './backend.ts'
import { registerBoard } from './board/board.tsx'
import { readConfig } from './config.ts'
import { SEARCH_OFF_REPLY, isFindSkill, suggestionBlock } from './skills.ts'
import { agentStep, checkAgent, endAgent, keepSpawn, planSpawn } from './flows/agents.ts'
import type { Stepped } from './flows/agents.ts'
import { answerDp, registerDp } from './flows/dp.ts'
import { onRow } from './flows/midrun.ts'
import { dropQueuedInput, noteCameBack, tickProgress } from './flows/progress.ts'
import { openStep, readout } from './flows/readout.ts'
import { findSkill, foldListing, holdSkill, recordSkill, takeSkillFor, takeUnclaimed } from './flows/skills.ts'
import { dropPending, endTurn, judgeMessage, mainStep, startTurn } from './flows/submit.ts'
import { failOpen, keepSurfaces, verifies } from './runtime.ts'

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await failOpen($, 'session.start', null, () => registerDp($))
    await failOpen($, 'session.start', null, () => keepSurfaces($))
    return next(e)
  })

  on('command.run', { command: 'dp' }, async ($, e, next) => {
    const answer = await failOpen($, 'command.run', null, () => answerDp($, cfg, e.args))
    return answer ?? next(e)
  })

  // The person is waiting for the message to go in: the asks are the only wait here. The pending decision is
  // written before next(e), inside which the engine starts the message's turn; a suggestion goes down as context.
  on('prompt.submit', async ($, e, next) => {
    const skill = await failOpen($, 'prompt.submit', null, () => judgeMessage($, cfg, { text: e.text, origin: e.origin?.kind, turnId: e.turnId }))
    const block = skill?.skill && cfg.mode === 'apply' ? suggestionBlock(skill.skill) : null
    if (skill !== null) holdSkill({ text: e.text, outcome: skill, applied: block !== null })
    const r = await next(block === null ? e : { ...e, context: [...(e.context ?? []), block] })
    if (r.drop !== undefined) await failOpen($, 'prompt.submit', null, () => dropPending($))
    // Still here: no turn started with it (a drop, or the engine started none inside next).
    if (skill !== null && takeUnclaimed(skill)) {
      await failOpen($, 'prompt.submit', null, () => recordSkill($, skill, { turnId: null, applied: false }))
    }
    return r
  })

  // Answered on the way back: what the engine rendered is what is parsed. A subagent keeps its listing whole.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const r = await next(e)
    const text = r.text
    if (e.agentId !== undefined || !cfg.enabled || !cfg.skills || cfg.mode === 'shadow' || !canAsk(cfg) || text === null) return r
    return (await failOpen($, 'prompt.attachment', null, () => foldListing($, text))) ?? r
  })

  on('skill.prompt', { skill: /(^|:)find-skill$/ }, async ($, e, next) => {
    if (!isFindSkill(e)) return next(e)
    // The listing was left whole in these cases: the body ("Query: …") would tell the agent nothing.
    if (!cfg.enabled || !cfg.skills || cfg.mode === 'shadow') return { text: SEARCH_OFF_REPLY }
    const text = await failOpen($, 'skill.prompt', null, () => findSkill($, cfg, e.text))
    return text === null ? next(e) : { text }
  })

  on('turn.start', async ($, e, next) => {
    // A new main-loop turn: no input of the last one waits for a progress note (a call still in the air is kept, and
    // dropped when it comes back).
    if (e.agentId === undefined) dropQueuedInput()
    await failOpen($, 'turn.start', null, async () => {
      // A subagent's turns are its own: the main loop's turn is not touched by them.
      if (e.agentId !== undefined) return null
      // A decision that stays pending is taken by this turn's first step, once the effort is known.
      return startTurn($, e.turnId, e.text)
    })
    const mine = e.agentId === undefined ? takeSkillFor(e.text) : null
    if (mine !== null) {
      await failOpen($, 'turn.start', null, () => recordSkill($, mine.outcome, { turnId: e.turnId, applied: mine.applied }))
    }
    return next(e)
  })

  // The one turn.step hook (no matcher may be registered twice): the main loop's branch, and an agent's (e.agentId set).
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const plan = await failOpen<Stepped>($, 'turn.step', { step: e, check: null }, async () => (agentId === undefined ? { step: await mainStep($, cfg, e), check: null } : agentStep($, cfg, e, agentId)))
    // An agent's check runs beside its step, which does not wait for it; the hook returns once both are done.
    const held = plan.check
    const checking = held !== null && agentId !== undefined ? failOpen($, 'turn.step', null, () => checkAgent($, agentId, held)) : null
    // Open for the readout while the step's request may go.
    const close = verifies(cfg) ? openStep(plan.step) : null
    try {
      return yield* next(plan.step)
    } finally {
      close?.()
      if (checking !== null) await checking
    }
  })

  // The judgement waits before next(e); once next has answered, what the type ran on is learned and the started agent's
  // entry and Decision are written. A refused spawn keeps nothing; one that started no local agent only teaches.
  on('agent.spawn', async ($, e, next) => {
    const plan = await failOpen($, 'agent.spawn', null, () => planSpawn($, cfg, e))
    const r = await next(plan === null || plan.model === null ? e : { ...e, model: plan.model })
    if (plan !== null) await failOpen($, 'agent.spawn', null, () => keepSpawn($, plan, r))
    return r
  })

  // Each row is held here until the hook passes it on; at a checkpoint, for as long as the question is out.
  on('session.append', async ($, e, next) => {
    // A progress note come back is read before the row, so a checkpoint on this very row asks with the newest one.
    if (e.agentId === undefined && noteCameBack()) await failOpen($, 'progress', null, () => tickProgress($, cfg, null))
    const out = await failOpen($, 'session.append', e, () => onRow($, cfg, e))
    return next(out)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    // The main loop's turn ends: no input of it waits for a progress note any more.
    if (agentId === undefined) dropQueuedInput()
    await failOpen($, 'turn.complete', null, () => (agentId !== undefined && verifies(cfg) ? endAgent($, agentId) : endTurn($, e)))
    return next(e)
  })

  // The board: the timeline, the pane and the footer's label (design 5.14); nothing while cfg.board is off.
  registerBoard(on, cfg)

  // Every request the engine and the plugins send passes here. Each goes on as it came; the readout is written beside
  // it (design 5.12). Not registered at all while the readout is off (verifyEffort, or the mod, off).
  if (verifies(cfg)) {
    on('http.fetch', async ($, e, next) => {
      const keeping = readout($, e, next.origin.plugin)
      try {
        return await next(e)
      } finally {
        if (keeping !== null) await keeping
      }
    })
  }
}
