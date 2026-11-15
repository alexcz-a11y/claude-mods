// dispatch-pilot-extras in a test: the hooks that plugin registers on `tool.call`, `agent.spawn` and
// `classic.PreToolUse`, each run in dispatch-pilot through its noun (hooks/core/bridge.ts, ADR 0028), loaded beside
// the mod as an inline plugin (`test(name, { plugins: [EXTRAS] }, body)`; support/test.ts adds it to every test).
// A test that loads the mod alone is a session without the other plugin: a Code Mode session.
//
// The hooks are the other plugin's (../../dispatch-pilot-extras/hooks/dispatch-pilot-extras.mjs), which a test cannot
// import: `register` below is that file's, written out again; eval/validate.ts checks the two lists against each other.
// An inline plugin's `register` closes over nothing of this file, so `through` is inside it.

import type { Plugin } from 'claude-code/testing'

export const EXTRAS: Plugin = {
  name: 'dispatch-pilot-extras',
  register(on) {
    let runs = 0
    type Step = { kind: 'next'; input: unknown } | { kind: 'done'; result: unknown } | { kind: 'error'; message: string } | { kind: 'pass' }
    type Start = (call: { name: string; id: string; e: unknown; origin?: { plugin?: string } }) => Promise<Step>
    type Resume = (answer: { id: string; result?: unknown; error?: string }) => Promise<Step>
    type Next = ((e: never) => unknown) & { origin: { plugin: string } }
    /** Runs dispatch-pilot's hook `name` for the event `e`: the two halves around the engine's `next` (`start` and `resume` are the noun's, called at the hook, where `$` is). */
    async function through(start: Start, resume: Resume, e: unknown, next: Next, name: string): Promise<never> {
      const id = `${name}#${++runs}`
      let step: Step
      try {
        step = await start({ name, id, e, origin: { plugin: next.origin.plugin } })
      } catch {
        return (await next(e as never)) as never
      }
      let result: unknown
      while (step.kind === 'next') {
        let answer: { id: string; result?: unknown; error?: string }
        try {
          result = await next(step.input as never)
          answer = { id, result }
        } catch (error) {
          answer = { id, error: String(error instanceof Error ? error.message : error) }
        }
        try {
          step = await resume(answer)
        } catch {
          step = { kind: 'pass' }
        }
        if (step.kind === 'pass') {
          if (answer.error !== undefined) throw new Error(answer.error)
          return result as never
        }
      }
      if (step.kind === 'done') return step.result as never
      if (step.kind === 'error') throw new Error(step.message)
      return (await next(e as never)) as never
    }

    on('tool.call', { tool: /(?:)/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'midrun.call'))
    on('tool.call', { tool: /(?:)/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'escalation.call'))
    on('tool.call', { tool: 'Agent' }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'agents.call'))
    on('tool.call', { tool: 'Workflow' }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'workflow-agents.call'))
    on('tool.call', { tool: 'Workflow' }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'workflow-labels.call'))
    on('tool.call', { tool: 'mcp__dispatch-pilot__find_skill' }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'find-skill.call'))
    on('tool.call', { tool: 'mcp__dispatch-pilot__visual_check' }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'visual-check.call'))
    on('tool.call', { tool: 'Read' }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'takeover.read'))
    on('tool.call', { tool: /^mcp__/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'takeover.mcp'))

    on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'report.spawn'))
    on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'screens.spawn'))
    on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'loops.spawn'))
    on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'agents.spawn'))
    on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'workflow-labels.spawn'))

    on('classic.PreToolUse', ($, e, next) => through((call) => $.dispatchPilot.start(call), (answer) => $.dispatchPilot.resume(answer), e, next, 'core.pretooluse'))
  },
}
