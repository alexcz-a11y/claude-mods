// Feature: the agents of a Workflow (#8). When the main agent submits a
// Workflow script, each `agent()` call of it gets its own decision on model
// and effort, and they are written into the script before the tool runs it.
// The agents of a Workflow never pass the Agent tool (no agent.spawn), so the
// script is the one place their model and effort can be set ahead of time.
//
// The main agent is told what was written and why, in what the tool returns.
// A script this cannot read is let through as it is.

import type { HttpInit, On } from 'claude-code'
import { DEFAULT_AGENT_MODELS, type DispatchSettings } from '../decision/dispatched-agent.ts'
import { parseWorkflow, rewriteWorkflow, type CallWrite } from '../decision/workflow-script.ts'
import { callName, outcomeOf, readBatch, rewriteNote, workflowBatches, writeFor } from '../decision/workflow.ts'
import { numberIn, type Ctx } from '../core/setup.ts'
import { setStatus } from '../core/status.ts'

const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const

export function registerWorkflowAgents(on: On, ctx: Ctx): void {
  const settings: DispatchSettings = {
    models: ctx.options.agentFable === true ? [...DEFAULT_AGENT_MODELS, 'fable'] : DEFAULT_AGENT_MODELS,
    ask: ctx.ask,
    thetaOverride: numberIn(ctx.options.agentOverride, 0, 1, 0.6),
    thetaMax: ctx.config.thetaMax,
  }

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (e.tool !== 'Workflow' || typeof e.script !== 'string') return next(e)
    const parsed = parseWorkflow(e.script)
    if (parsed === null) return next(e)
    const { value: said = [] } = await $.state.get(SAID)
    const words = said.join('\n')
    const io = {
      fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
      sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
    }
    const batches = workflowBatches(parsed, words, settings, ctx.config.context.tokens)
    const asked = await Promise.all(batches.map((batch) => ctx.backend.ask(io, batch.request, ctx.config.timeoutMs)))
    const writes: (CallWrite | null)[] = parsed.calls.map(() => null)
    const lines: string[] = []
    batches.forEach((batch, b) => {
      const answer = asked[b]
      if (answer === undefined || !answer.ok) return
      readBatch(batch, answer.answers, parsed, words, settings).forEach((decision, k) => {
        const call = parsed.calls[batch.calls[k] as number]
        if (call === undefined) return
        const write = writeFor(call, decision)
        writes[call.index] = write
        if (write !== null) lines.push(`${callName(call)}: ${outcomeOf(call, decision)}`)
      })
    })
    const script = rewriteWorkflow(parsed, writes)
    const result = await next({ ...e, script })
    if (result.deny !== undefined) return result
    setStatus('workflow', `workflow routed ${lines.length} agents`, (line) => $.ui.status(line))
    return { ...result, context: [...(result.context ?? []), rewriteNote(lines)] }
  })
}
