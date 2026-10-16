// A conversation as `$.session.messages()` hands it to the mod, built from the entries the eval's datasets write (`recent_context`,
// a v2 item's turns). Not a test file.

import type { SessionMessage } from 'claude-code'

/** One message of a dataset's conversation: who said it, what, and the tools the assistant's reply called. */
export type Entry = { role: 'user' | 'assistant'; text: string; tools?: string[] }

/** The conversation as the engine's transcript holds it: an assistant reply's tool calls, without inputs or outputs. */
export function transcript(entries: readonly Entry[]) {
  return entries.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool, i) => ({ tool_use_id: `toolu_${i}`, tool, input: {}, text: '' })) }))
}

/**
 * The transcript for a conversation whose tool calls carry their input and output: each call's result comes back on a user row of
 * its own with no text (Claude Code 2.1.289).
 */
export function transcriptWithResults(entries: readonly Entry[]): SessionMessage[] {
  return entries.flatMap((entry, i): SessionMessage[] => {
    const tools = entry.tools ?? []
    const uses = tools.map((tool, j) => ({ tool_use_id: `toolu_${i}_${j}`, tool, input: { file_path: '/repo/secret.ts' }, text: 'FILE CONTENT that never travels' }))
    const row: SessionMessage = { role: entry.role, text: entry.text, toolUses: uses }
    if (uses.length === 0) return [row]
    const results: SessionMessage = { role: 'user', text: '', toolUses: [], toolResults: uses.map((use) => ({ tool_use_id: use.tool_use_id, text: use.text, isError: false })) }
    return [row, results]
  })
}
