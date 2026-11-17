// A note for the model, put on a tool result's row (ADR 0029).
//
// A model takes a new effort only at a step with new input, and a step whose input is tool results alone has none
// (the API's per-message effort; DEVELOPMENT.md 「已实测的引擎行为」). Until Claude Code 2.1.325 a row appended with
// `$.session.append` made the next step one with input. From 2.1.326 such a row goes out as a system message right
// behind the tool results, which is no input, and the level written for the step does not go out. A text block on the
// tool result's own row does: the user message of the next request then holds the results and that text (measured on
// 2.1.325 and 2.1.326, the main loop, a dispatched agent's, two calls in one step, a Code Mode session). The person
// sees the text in the conversation as a line of their own, which says where the level moved.
//
// So a feature that moves a level does not append: it leaves its note with its own `session.append` hook
// (door `tool-result`), which adds it to the next row a request carries, before the row is stored, and takes the move
// once the stored row holds it. Like the other modules that read rows, this one is pure: the hooks are the features'.

import type { ApiContentBlock } from 'claude-code'

type Block = ApiContentBlock & { type: string; tool_use_id?: unknown; text?: unknown }

/** The id of a call a Code Mode script made: its rows are the transcript's alone, no request carries them (`repl_…`, `repl-error-…`). */
const SCRIPT_CALL = /^repl[_-]/

/**
 * Whether a request carries a tool result's row to the model: it holds a result, and none of its results is a call a
 * Code Mode script made (those rows are kept beside the conversation; the model reads the script's own result instead).
 */
export function carriedByRequest(content: readonly ApiContentBlock[]): boolean {
  const results = (content as readonly Block[]).filter((block) => block.type === 'tool_result')
  return results.length > 0 && results.every((block) => typeof block.tool_use_id === 'string' && !SCRIPT_CALL.test(block.tool_use_id))
}

/** The row's message with `text` as a text block after its blocks. */
export function withNote<M extends { content: ApiContentBlock[] }>(message: M, text: string): M {
  return { ...message, content: [...message.content, { type: 'text', text } as ApiContentBlock] }
}

/** Whether a stored row holds the note: the engine puts back what a hook may not change, so the note is read back. */
export function holdsNote(stored: unknown, text: string): boolean {
  if (typeof stored !== 'object' || stored === null) return false
  const content = (stored as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) && (content as Block[]).some((block) => block.type === 'text' && block.text === text)
}
