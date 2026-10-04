// Forced escalation (#7): the question the decision model answers when a loop's
// tool calls keep failing, and the rules that turn the answer into a level.
//
// Pure (see system-one.ts). The question is asked in the same request as the
// mid-turn effort question (midturn.ts, with its `trouble` flag): is what
// failed what the work expects at this point (a test written to fail first, a
// search that finds nothing), or is the work stuck? Written to TypeSafe's guide
// for Noul (docs/research/typesafe-question-guide.md §2.5): one yes/no
// question, a high value means yes, `criteria.true` is yes.

import { DEFAULT_ASK, EFFORTS, higherEffort, pickEffort, type Effort, type EffortAsk, type EffortReading, type Language } from './effort.ts'
import { outcomeOf, resultLine, toolDetail, type MidturnStep, type MidturnTool } from './midturn.ts'
import type { Answer, Part, Question } from './system-one.ts'

/** The part's name and its one question's id: `escalation.expected` in a request. */
export const ESCALATION_PART = 'escalation'
export const EXPECTED = 'expected'

/**
 * How a forced raise moves the level: `one-level` goes up one level, never
 * past xhigh; `max` goes straight to max.
 */
export const RAISE_MODES = ['one-level', 'max'] as const
export type RaiseMode = (typeof RAISE_MODES)[number]

/** The level a forced raise goes to from `current`; null when there is nowhere to go (xhigh or max in `one-level`, max in `max`). */
export function forcedTarget(current: Effort, mode: RaiseMode): Effort | null {
  const at = EFFORTS.indexOf(current)
  const top = mode === 'max' ? EFFORTS.indexOf('max') : EFFORTS.indexOf('xhigh')
  const to = mode === 'max' ? top : Math.min(at + 1, top)
  return to > at ? (EFFORTS[to] as Effort) : null
}

/**
 * The level a forced raise ends at: `target` (the one level, or max, the
 * failures force), or the decision model's own pick when that is higher and
 * its answer is sure enough (`thetaUp`, as for any mid-turn raise); `max` only
 * past `thetaMax`, as everywhere.
 */
export function raisedLevel(reading: EffortReading | null, target: Effort, rules: { thetaUp: number; thetaMax: number }): Effort {
  if (reading === null) return target
  const confidence = reading.confidence ?? Math.max(...reading.probabilities)
  return confidence >= rules.thetaUp ? (higherEffort(target, pickEffort(reading, rules.thetaMax)) as Effort) : target
}

/** What went wrong, in one English sentence for the decision model's state (`trouble`): `2 tool calls have failed while working on this request`. */
export function troubleText(counted: { failures: number; hookBlocks: number }): string {
  const n = counted.failures + counted.hookBlocks
  const how = counted.hookBlocks > 0 ? 'failed or been blocked by a hook' : 'failed'
  return `${n} tool call${n === 1 ? ' has' : 's have'} ${how} while working on this request`
}

/** A transcript row as `$.session.messages()` gives it (the part read here). */
export type TranscriptRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool_use_id?: string; tool: string; input?: Readonly<Record<string, unknown>>; text?: string; isError?: true }[]
  toolResults?: readonly unknown[]
}

/**
 * What a loop has done since the last thing a person said, as the decision
 * model reads it: the steps, oldest first, each the text the agent wrote and
 * its tool calls with how they ended (the mid-turn request's `recent_steps`).
 * The transcript gives a response one row per block and the tool results rows
 * of their own, so a step is the run of assistant rows between two user rows.
 * `blocked` says which calls a hook refused (their error reads as any other).
 */
export function stepsFromRows(rows: readonly TranscriptRow[], options: { language: Language; blocked?: (toolUseId: string) => boolean }): MidturnStep[] {
  const said = (row: TranscriptRow) => row.role === 'user' && row.text.trim() !== '' && (row.toolResults?.length ?? 0) === 0
  const from = rows.findLastIndex(said) + 1
  const steps: MidturnStep[] = []
  let texts: string[] = []
  let tools: MidturnTool[] = []
  const close = () => {
    if (texts.length > 0 || tools.length > 0) steps.push({ assistant_text: texts.join('\n'), tools })
    texts = []
    tools = []
  }
  for (const row of rows.slice(from)) {
    if (row.role === 'user') {
      close()
      continue
    }
    if (row.text.trim() !== '') texts.push(row.text.trim())
    for (const use of row.toolUses ?? []) {
      const outcome = outcomeOf(use.tool, { isError: use.isError, text: use.text }, options.blocked?.(use.tool_use_id ?? '') ?? false)
      tools.push({ name: use.tool, result: resultLine(outcome, toolDetail(use.input ?? {}), options.language) })
    }
  }
  close()
  return steps
}

const EXPECTED_QUESTION: Record<Language, Question> = {
  en: {
    type: 'noul',
    instructions: 'Are the failed tool calls in `recent_steps` what the work on `user_message` expects at this point, rather than a sign that the work is stuck?',
    criteria: {
      true: 'The failures are part of how the work goes: a test written first and run to watch it fail, a search or check that exits with an error because it found nothing or has something to report, a command run to find out whether something exists or works.',
      false: 'The failures are obstacles: the same call failing again and again, a command, path or tool that does not exist or is used wrongly, an error in code just written, or a fix that did not take.',
    },
  },
  zh: {
    type: 'noul',
    instructions: '`recent_steps` 里失败的工具调用，是不是 `user_message` 这项工作此时本来就会遇到的，而不是工作卡住的迹象？',
    criteria: {
      true: '失败本来就是工作的一部分：先写下并运行、要看它失败的测试；因为没找到东西或有东西要报告而以错误退出的搜索或检查；为了弄清某样东西是否存在、能否运行而执行的命令。',
      false: '失败是障碍：同一个调用一再失败；命令、路径或工具不存在或用法不对；刚写的代码有错误；修复没有生效。',
    },
  },
}

/** The part a stuck re-decision adds to its request: `escalation.expected`. */
export function expectedFailurePart(ask: Partial<EffortAsk> = {}): Part {
  const asked = { ...DEFAULT_ASK, ...ask }
  return { part: ESCALATION_PART, questions: { [EXPECTED]: EXPECTED_QUESTION[asked.language] } }
}

/** The probability that the failures were expected (the answer's `noul`); null without a usable answer. */
export function readExpected(answers: Readonly<Record<string, Answer>>): number | null {
  const answer = answers[EXPECTED]
  return answer?.type === 'noul' ? answer.noul : null
}
