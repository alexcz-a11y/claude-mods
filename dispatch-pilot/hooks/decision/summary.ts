// The problem summary (#36, #40; GLOSSARY 问题摘要): a short running record of the
// problem the person and the main agent are on, for the decision model to read
// beside the conversation, so that it sees the rounds that no longer fit the
// 24000 tokens of `recent_context`. A cheap model continues it after each of the
// person's turns, in the background; this module writes what it is asked, reads its
// reply into a fixed structure within `SUMMARY_TOKENS`, and words the summary for
// the decision model.
//
// The summary records what was tried, never whether it worked: that is the
// person's next message to say (story 14), and the three-way question reads it
// there (decision/unresolved.ts). When that answer is "still unresolved", the
// last try is marked (`markLast`) so that what the record shows is what failed.
//
// Pure (see system-one.ts): the mod and the eval import it as it is.

import { clipToTokens, estimateTokens, said, toolSummary, type ContextMessage } from './context.ts'
import { redactSecrets } from './redact.ts'
import type { Language } from './effort.ts'

/** One thing that was tried; `unresolved`: the person said afterwards that it did not solve the problem. */
export type Attempt = { text: string; unresolved?: true }

/** The summary, in its fixed structure: the problem in one sentence, what was tried item by item (oldest first), where things stand. */
export type Summary = { problem: string; tried: Attempt[]; status: string }

/** The summary is at most this many tokens as the decision model reads it (the estimate of context.ts; the count of `renderSummary`). */
export const SUMMARY_TOKENS = 500

/** The cheap model's reply is cut at this many tokens (the summary itself at `SUMMARY_TOKENS`: the reply is JSON, and Chinese counts more in the model's own tokens than in the estimate), and a write ends after this long. */
export const SUMMARY_MAX_REPLY = 1000
export const SUMMARY_TIMEOUT_MS = 30_000

/** The summary's field in the state of the effort request (beside `user_message` and `recent_context`). */
export const SUMMARY_FIELD = 'problem_summary'

/** The parts of the summary are each cut to this many tokens, so that a runaway reply cannot crowd out the rest. */
const PROBLEM_TOKENS = 80
const ATTEMPT_TOKENS = 80
const STATUS_TOKENS = 80

/** What a reply marks an unresolved try with, at the end of the item. */
const MARK = /\s*\[unresolved\]\s*$/i

/** The text with its whitespace collapsed and secrets masked. */
function tidy(text: string): string {
  return redactSecrets(text).replace(/\s+/g, ' ').trim()
}

/**
 * The summary in the model's reply: the JSON object in it, read into the fixed structure and cut to
 * `SUMMARY_TOKENS`. Null when the reply holds no such object, has no problem, or a field is of the wrong kind.
 */
export function readSummary(reply: string): Summary | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { problem, tried, status } = parsed as Record<string, unknown>
  if (typeof problem !== 'string' || tidy(problem) === '' || typeof status !== 'string' || !Array.isArray(tried)) return null
  if (!tried.every((item) => typeof item === 'string')) return null
  const attempts: Attempt[] = []
  for (const item of tried as string[]) {
    const marked = MARK.test(item)
    const text = tidy(item.replace(MARK, ''))
    if (text !== '') attempts.push(marked ? { text, unresolved: true } : { text })
  }
  return fit({ problem: tidy(problem), tried: attempts, status: tidy(status) })
}

/**
 * The summary within `SUMMARY_TOKENS`: each part cut to its share, then, while it is still over, the two earliest
 * tries made one item (their texts together, cut to an item's share) so that the newest stay as they were written.
 */
export function fit(summary: Summary): Summary {
  let tried = summary.tried.map((attempt) => ({ ...attempt, text: clipToTokens(attempt.text, ATTEMPT_TOKENS) }))
  const cut = { problem: clipToTokens(summary.problem, PROBLEM_TOKENS), status: clipToTokens(summary.status, STATUS_TOKENS) }
  const size = () => estimateTokens(renderSummary({ ...cut, tried }, 'zh'))
  while (size() > SUMMARY_TOKENS && tried.length > 1) {
    const [first, second, ...rest] = tried as [Attempt, Attempt, ...Attempt[]]
    const merged: Attempt = { text: clipToTokens(`${first.text}；${second.text}`, ATTEMPT_TOKENS), ...(first.unresolved === true || second.unresolved === true ? { unresolved: true as const } : {}) }
    tried = [merged, ...rest]
  }
  return { ...cut, tried }
}

/** How the cheap model is held to its task: the reply's shape, what the record is (what was tried, not what it came to), its length. */
export const SUMMARY_SYSTEM = [
  'You keep the record of the problem a person and a coding assistant are working on. Another model reads the record to judge how much careful reasoning the next request needs, so the record is how it sees the rounds that happened long ago.',
  'Reply with one JSON object and nothing else:',
  '{"problem": "...", "tried": ["...", "..."], "status": "..."}',
  '- problem: the one problem they are on, in one sentence.',
  '- tried: what has been tried for it, one short item per attempt, oldest first. Add what the latest turn tried. Keep the trailing "[unresolved]" on an item that has it in the record.',
  '- status: where things stand now, in one sentence: what the assistant did or found, or what it is waiting for.',
  'Record what was tried, not whether it solved the problem: only the person\'s next message says that. Never write that something is fixed, solved or working, and never add "[unresolved]" yourself.',
  'If the latest turn is about another problem than the record\'s, start a new record for it.',
  `The whole record stays within ${SUMMARY_TOKENS} tokens: when there are many attempts, merge the earliest ones into one sentence.`,
  'Write in the language the person writes in. Plain text in the strings, no markdown.',
].join('\n')

/** What is cut from the turn before it goes to the cheap model, in tokens: the person's words, the assistant's reply, its tools. */
const PERSON_TOKENS = 1500
const REPLY_TOKENS = 3000
const TOOLS_TOKENS = 300

/** The turn that ended, as the cheap model is shown it. */
export type TurnInput = {
  /** The record before this turn; null when there is none (the first turn of a problem). */
  previous: Summary | null
  /** The person's message that started the turn. */
  person: string
  /** The assistant's final reply. */
  reply: string
  /** The tools it called, as `turnTools` words them. */
  tools: string
}

/** The record as the model reads it and must write it back: the unresolved tries carry the mark at their end. */
function marked(summary: Summary): string {
  return JSON.stringify({ problem: summary.problem, tried: summary.tried.map((attempt) => (attempt.unresolved === true ? `${attempt.text} [unresolved]` : attempt.text)), status: summary.status })
}

/** What the cheap model is asked after a turn: the record so far and the turn, secrets masked and long text cut. */
export function summaryPrompt(turn: TurnInput): string {
  const person = clipToTokens(redactSecrets(turn.person).trim(), PERSON_TOKENS, 0.3)
  const reply = clipToTokens(redactSecrets(turn.reply).trim(), REPLY_TOKENS, 0.4)
  const tools = clipToTokens(redactSecrets(turn.tools).trim(), TOOLS_TOKENS)
  return [
    turn.previous === null ? 'Record so far: none yet.' : `Record so far:\n${marked(turn.previous)}`,
    '',
    'Latest turn.',
    `The person wrote:\n<<<\n${person}\n>>>`,
    `The assistant called: ${tools === '' ? 'no tools' : tools}`,
    `The assistant's final reply:\n<<<\n${reply === '' ? '(none)' : reply}\n>>>`,
    '',
    'Reply with the updated record as JSON.',
  ].join('\n')
}

/**
 * The tools the assistant called in the turn that just ended, as the decision model reads tools (`Bash x3 (1 failed), Edit`):
 * those of the rows after the person's last message of words (a row of theirs with none carries tool results).
 */
export function turnTools(messages: readonly ContextMessage[]): string {
  const uses: { tool: string; isError?: true }[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ContextMessage
    if (message.role === 'user') {
      if (said(message.text) !== '') break
      continue
    }
    uses.unshift(...(message.toolUses ?? []))
  }
  return toolSummary(uses)
}

/** The summary with its last try marked unresolved: the person's message said it did not solve the problem. */
export function markLast(summary: Summary): Summary {
  const last = summary.tried.at(-1)
  if (last === undefined) return summary
  return { ...summary, tried: [...summary.tried.slice(0, -1), { ...last, unresolved: true }] }
}

/** The labels of a summary in each language. */
const WORDS: Record<Language, { problem: string; tried: string; status: string; unresolved: string }> = {
  en: { problem: 'Problem', tried: 'Tried', status: 'Status', unresolved: 'unresolved' },
  zh: { problem: '问题', tried: '试过', status: '状态', unresolved: '未解决' },
}

/** The summary as text, the way the decision model reads it: the problem, the tries numbered (an unresolved one says so), the status. */
export function renderSummary(summary: Summary, language: Language): string {
  const words = WORDS[language]
  const colon = language === 'zh' ? '：' : ': '
  const lines = [`${words.problem}${colon}${summary.problem}`]
  if (summary.tried.length > 0) {
    lines.push(`${words.tried}${colon.trimEnd()}`)
    summary.tried.forEach((attempt, i) => lines.push(`${i + 1}. ${attempt.text}${attempt.unresolved === true ? (language === 'zh' ? `（${words.unresolved}）` : ` (${words.unresolved})`) : ''}`))
  }
  if (summary.status !== '') lines.push(`${words.status}${colon}${summary.status}`)
  return lines.join('\n')
}
