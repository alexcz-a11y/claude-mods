// The prompt hint: what the person's draft will meet once it is sent, drawn in
// the prompt box after it as dim text that never enters the draft
// (`virtualText`, 2.1.300 on). Only what is known without asking anyone,
// within `prompt.edit`'s 50 ms: Dispatch Pilot switched off, the main agent's
// effort locked, and words the decision model reads as a model or an effort
// named for the agents dispatched from the message (a dispatched agent's
// decision asks about them; the main agent's model never changes).
//
// Pure (see system-one.ts).

import { AGENT_MODELS, mentionsEffort, type AgentModel } from './dispatched-agent.ts'
import type { Effort } from './effort.ts'

/** What the hint reads besides the draft. */
export type HintState = {
  /** Dispatch Pilot is on (the master switch). */
  master: boolean
  /** The person's lock on the main agent's effort; null when none. */
  lock: Effort | null
  /** A feature that routes the agents dispatched from the message is on (dispatched-agents, workflow-agents or workflow-labels). */
  agents: boolean
}

/** A model's name as the person may write it: the family's alias, as a word of its own. */
const MODEL_WORD = new RegExp(`\\b(${AGENT_MODELS.join('|')})\\b`, 'gi')

/** The hint for `draft`, without its leading space; null when there is nothing to say (an empty draft, a slash command, nothing known). */
export function promptHint(draft: string, state: HintState): string | null {
  const text = draft.trim()
  if (text === '' || text.startsWith('/')) return null
  if (!state.master) return 'dp 已关 · 这条消息不路由'
  const parts: string[] = []
  if (state.lock !== null) parts.push(`effort 锁定 ${state.lock}`)
  if (state.agents) {
    // One phrase for whatever may be named: the models by name, then the effort.
    const named: string[] = [...new Set([...text.matchAll(MODEL_WORD)].map((match) => (match[1] as string).toLowerCase() as AgentModel))]
    if (mentionsEffort(text)) named.push('effort')
    if (named.length > 0) parts.push(`识别 agent 点名：${named.join('、')}`)
  }
  return parts.length === 0 ? null : `dp · ${parts.join(' · ')}`
}
