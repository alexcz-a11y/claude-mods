// Dispatch Pilot Extras: the hooks of the events Claude Code's Code Mode refuses a mod for (2.1.325 does not start
// Code Mode beside a mod that hooks `tool.call`, `agent.spawn` or `classic.PreToolUse`). Nothing is decided here:
// each hook below runs a hook of Dispatch Pilot's by name, through the noun that plugin adds to `$`
// (`$.dispatchPilot`, its hooks/core/bridge.ts), which keeps the state, the decision model and its keys.
//
// A hook there calls `next` in the middle, and a function does not cross from one plugin to another: `start` runs it
// up to its `next` and answers with the input it passed, the engine's `next` is called here, and `resume` hands the
// hook what came back. Without Dispatch Pilot beside it (or with one that has no hook of that name), and whenever the
// noun fails, the event goes on as the engine raised it.
//
// The order is the nesting Dispatch Pilot's entry gave these hooks when it registered them itself: what is first is
// outermost. A name here and the hook there go together (dispatch-pilot's eval/validate.ts checks the two lists).

let runs = 0

/** Runs Dispatch Pilot's hook `name` for the event `e`: the two halves around the engine's `next`. */
async function through($, e, next, name) {
  const id = `${name}#${++runs}`
  let step
  try {
    step = await $.dispatchPilot.start({ name, id, e, origin: { plugin: next.origin.plugin } })
  } catch {
    return next(e)
  }
  let result
  while (step.kind === 'next') {
    let answer
    try {
      result = await next(step.input)
      answer = { id, result }
    } catch (error) {
      answer = { id, error: String(error instanceof Error ? error.message : error) }
    }
    try {
      step = await $.dispatchPilot.resume(answer)
    } catch {
      step = { kind: 'pass' }
    }
    if (step.kind === 'pass') {
      if (answer.error !== undefined) throw new Error(answer.error)
      return result
    }
  }
  if (step.kind === 'done') return step.result
  if (step.kind === 'error') throw new Error(step.message)
  return next(e)
}

export function register(on) {
  on('tool.call', { tool: /(?:)/ }, ($, e, next) => through($, e, next, 'midrun.call'))
  on('tool.call', { tool: /(?:)/ }, ($, e, next) => through($, e, next, 'escalation.call'))
  on('tool.call', { tool: 'Agent' }, ($, e, next) => through($, e, next, 'agents.call'))
  on('tool.call', { tool: 'Workflow' }, ($, e, next) => through($, e, next, 'workflow-agents.call'))
  on('tool.call', { tool: 'Workflow' }, ($, e, next) => through($, e, next, 'workflow-labels.call'))
  on('tool.call', { tool: 'mcp__dispatch-pilot__find_skill' }, ($, e, next) => through($, e, next, 'find-skill.call'))
  on('tool.call', { tool: 'mcp__dispatch-pilot__visual_check' }, ($, e, next) => through($, e, next, 'visual-check.call'))
  on('tool.call', { tool: 'Read' }, ($, e, next) => through($, e, next, 'takeover.read'))
  on('tool.call', { tool: /^mcp__/ }, ($, e, next) => through($, e, next, 'takeover.mcp'))

  on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through($, e, next, 'report.spawn'))
  on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through($, e, next, 'screens.spawn'))
  on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through($, e, next, 'loops.spawn'))
  on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through($, e, next, 'agents.spawn'))
  on('agent.spawn', { tool_use_id: /(?:)/ }, ($, e, next) => through($, e, next, 'workflow-labels.spawn'))

  on('classic.PreToolUse', ($, e, next) => through($, e, next, 'core.pretooluse'))
}
