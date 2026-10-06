// A dispatched agent's model and effort: the questions the decision model
// answers when the main agent starts an agent, and how the answers become the
// model it runs on and the effort of its steps.
//
// Pure (see system-one.ts). The input is the eval item's shape
// (subagent.jsonl's `zh` / `en`), so the eval (#15) builds the same request
// from an item as the mod builds from an agent.spawn. Written to TypeSafe's
// guide (docs/research/typesafe-question-guide.md §4.2): the model is a Choice
// whose options describe the work each suits (jev-pilot's measured wording),
// the effort a Score with the levels every effort question shares.

import { clipToTokens, estimateTokens, withinTokens } from './context.ts'
import { DEFAULT_ASK, EFFORTS, effortQuestion, levelsText, pickEffort, readEffort, traceEffort, type Effort, type EffortAsk, type EffortTrace, type EffortReading, type Language } from './effort.ts'
import { redactSecrets } from './redact.ts'
import type { Answer, Part, Question, State } from './system-one.ts'

/** The models a dispatched agent can run on, cheapest first: the Agent tool's own aliases. */
export const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type AgentModel = (typeof AGENT_MODELS)[number]
/** The options the decision model chooses from unless the person adds fable. */
export const DEFAULT_AGENT_MODELS: readonly AgentModel[] = ['haiku', 'sonnet', 'opus']

/** One dispatched agent as its decision reads it: the eval item's fields. */
export type Dispatch = {
  /** The person's own words this turn; '' when there are none. */
  user_message: string
  /** The agent type (`general-purpose`, `Explore`, a plugin's agent); null when none was named. */
  agent_type: string | null
  /** The few words the main agent described the task with; null for a workflow's agent. */
  description: string | null
  /** The task the agent is given. */
  prompt: string
  /** The model the main agent asked for (an alias such as `sonnet`, or an id); null when it named none. */
  requested_model: string | null
  /** `agent` (the Agent tool, the default) or `workflow` (an `agent()` of a Workflow script). */
  kind?: 'agent' | 'workflow'
  /** What the workflow as a whole is for (a workflow's agent only). */
  workflow_description?: string | null
  /** The `agent()` call's label (a workflow's agent only). */
  label?: string | null
}

/** How the questions are asked: eval variables (spec #70, guide §4.2); the defaults are the spec's. */
export type DispatchAsk = EffortAsk & {
  /** The model question's option names: the models themselves (spec), or the kind of work each suits (guide §4.2). */
  options: 'models' | 'work'
  /**
   * The main agent's pick: a strong hint inside the model question (spec), or
   * kept out of it and asked about on its own, `requested_fits`, so it cannot
   * anchor the model question (guide §4.2).
   */
  requested: 'hint' | 'noul'
}
export const DEFAULT_DISPATCH_ASK: DispatchAsk = { ...DEFAULT_ASK, options: 'models', requested: 'hint' }

/** What a request about one agent is built from, besides the agent. */
export type DispatchShape = {
  /** The models the decision model may choose (cheapest first); DEFAULT_AGENT_MODELS by default. */
  models?: readonly AgentModel[]
  ask?: Partial<DispatchAsk>
  /** The part's name: question ids are `<part>.<id>`. `agent` by default. */
  part?: string
  /** The state field that holds the agent's brief. `brief` by default. */
  field?: string
}

export const AGENT_PART = 'agent'
export const BRIEF = 'brief'
/** The question ids within the part; a yes/no question about one model is `<prefix>.<model>`. */
export const MODEL = 'model'
export const EFFORT = 'effort'
export const NAMED = 'named'
export const BANNED = 'banned'
/** The question of which effort, if any, the person asks for; asked only when their words may name one (`mentionsEffort`). */
export const NAMED_EFFORT = 'named_effort'
/** The named-effort question's option for no effort asked for. */
const NO_EFFORT = 'none'
export const REQUESTED_FITS = 'requested_fits'

/**
 * The kind of work each model suits, and the option name for it. Written from
 * Artificial Analysis' Intelligence Index v4.3.2 (docs/research/aa-benchmarks-2026-10.md),
 * each option one situation, never a degree (guide §2.4):
 * - Haiku 4.5 scores 0% on Terminal-Bench and 3.2% on AutomationBench: it is for a lookup of one or two steps whose result
 *   is only gathered and laid out as asked, not a long run of tool calls, not a write, not a judgment.
 * - Sonnet 5.5 matches or beats Opus 5.5 on terminal work, automation and knowledge work (Terminal-Bench 63.6% against
 *   59.6%, AutomationBench 71.8% against 69.5%) and trails it where facts, hard reasoning and scientific code decide
 *   (Omniscience 32 against 46, HLE -6.4, SciCode -5.9).
 * - Opus 5.5 takes those; Fable 5.1 leads Opus nowhere on AA at 2.5 times the price, so its text stays and it stays off by default.
 *
 * The wording was then tuned against the real decision model, three rounds on the `subagent` eval (DEVELOPMENT.md, 「按 AA
 * 基准校正」, 评测迭代): opus's "facts" clause alone drew research that can be checked in documents (it goes to sonnet), and
 * narrowing it alone sent the security, concurrency and design work to sonnet, so the careful-judgment frame leads and the
 * recalled-facts clause comes last; haiku's "one or two steps" was read as one trivial thing, so it says what such a lookup
 * returns. Tuned on the same 100 items it is measured on.
 */
const KINDS: Record<Language, Record<AgentModel, { work: string; choose_for: string; not_for: string }>> = {
  en: {
    haiku: {
      work: 'read_and_report',
      choose_for:
        'A read-only lookup that takes a step or two to run, whose result is only gathered and laid out as asked (a list, a table, a count), where a mistake is cheap to spot: search the repository for a pattern, find where something is defined, list the files that match, read a file, a log or test output and report what is there, run a command and report the result.',
      not_for: 'An exploration that needs many tool calls in a row, and anything that writes or changes files or needs a judgment call.',
    },
    sonnet: {
      work: 'specified_work',
      choose_for:
        'Most work that carries something out: terminal and shell work, code changes with a clear requirement (a bug whose cause is known, a feature to a written spec, tests for existing code, a scoped refactor, a change across several files), automation steps, and research or review of material in the repository reported back.',
      not_for:
        'Work whose conclusion depends on facts from outside the repository (how an API behaves, a standard, differences between versions) where a wrong recollection is costly, hard reasoning, a design from an open requirement, or a bug whose cause is unknown.',
    },
    opus: {
      work: 'judgment_work',
      choose_for:
        'Work that needs careful judgment or where a subtle mistake is costly: security, concurrency, money, data migrations or production; hard reasoning, design, or a bug whose cause is unknown; scientific, numerical or algorithmic code; research or an answer whose conclusion rests on facts recalled from memory that cannot be checked in the repository or in documents.',
      not_for: 'Work that carries something out which a written plan and tests already cover.',
    },
    // Anthropic's positioning: the most capable model, for the most demanding
    // reasoning and long-horizon agentic work, priced above Opus. AA shows it
    // ahead of Opus 5.5 in no area, at 2.5 times the price.
    fable: {
      work: 'frontier_work',
      choose_for:
        'The most demanding reasoning, worth the strongest model at a higher cost: a rigorous proof, a novel algorithm or architecture with no known answer, or a long autonomous task that earlier careful attempts did not crack.',
      not_for: 'Work a careful senior engineer can do: design, debugging, refactors, reviews, security or migrations, however important.',
    },
  },
  zh: {
    haiku: {
      work: 'read_and_report',
      choose_for: '一两步就能跑完、结果只需要收集起来并按要求排版（列表、表格、计数）、出错也容易发现的只读查找：在仓库里搜索某个模式，找某个东西在哪里定义，列出匹配的文件，读一个文件、日志或测试输出并汇报内容，执行一条命令并汇报结果。',
      not_for: '需要连续很多步工具调用的探查，以及任何要写入或修改文件、或需要判断的工作。',
    },
    sonnet: {
      work: 'specified_work',
      choose_for:
        '大多数负责执行的工作：终端和 shell 操作，需求明确的代码修改（原因已知的 bug、按书面需求实现的功能、给现有代码写测试、范围明确的重构、跨几个文件的修改），自动化流程的步骤，以及对仓库内材料的调研或审查并汇报。',
      not_for: '结论取决于仓库外的事实（API 的行为、标准、版本之间的差异）而且记错代价高的工作、难推理的工作、需求不明确的设计，或原因未知的 bug。',
    },
    opus: {
      work: 'judgment_work',
      choose_for: '需要审慎判断、或一个细微错误就代价高昂的工作：安全、并发、涉及钱、数据迁移或生产环境；难推理的工作、设计，或原因未知的 bug；科学、数值或算法类代码；结论取决于记忆中的事实、而且无法在仓库或文档里查证的调研或解答。',
      not_for: '书面计划和测试已经覆盖的执行类工作。',
    },
    fable: {
      work: 'frontier_work',
      choose_for: '最高难度、值得为最强的模型多付成本的推理：严格的证明、没有现成答案的全新算法或架构，或之前认真尝试都没能解决的长时间自主任务。',
      not_for: '细心的资深工程师能做好的工作：设计、调试、重构、审查、安全或迁移，无论多重要。',
    },
  },
}

/** The option fields' names in each language (the model reads them: guide Q9). */
const FIELDS: Record<Language, { choose_for: string; not_for: string }> = {
  en: { choose_for: 'choose_for', not_for: 'not_for' },
  zh: { choose_for: '适用', not_for: '不适用' },
}

/**
 * The model question's instructions; `field` is the brief's state field.
 * `requested` is the option the main agent asked for: the spec's strong hint,
 * in a field of its own (code-provided data, guide Q8).
 */
function modelInstructions(language: Language, options: DispatchAsk['options'], field: string, requested: string | null): Record<string, string> {
  if (language === 'zh') {
    return {
      问题: options === 'work' ? `哪个选项是能把 \`${field}\` 做好的最便宜的一类模型？` : `哪个模型是能把 \`${field}\` 做好的最便宜的一个？`,
      关注: `评的是 \`${field}.prompt\` 要求的工作：要读什么、判断什么、写什么、检查什么。`,
      ...(requested === null ? {} : { 指定: `写 \`${field}\` 的主 agent 指定了 ${requested}。除非这项工作明显更适合别的选项，否则选 ${requested}。` }),
    }
  }
  return {
    question: options === 'work' ? `Which option is the cheapest kind of model that can carry out \`${field}\` well?` : `Which model is the cheapest one that can carry out \`${field}\` well?`,
    focus: `Judge the work that \`${field}.prompt\` asks for: what has to be read, decided, written and checked.`,
    ...(requested === null ? {} : { requested: `The main agent that wrote \`${field}\` asked for ${requested}. Choose ${requested} unless the work clearly fits another option better.` }),
  }
}

/** The effort question's instructions (jev-pilot's SUBAGENT_EFFORT_INSTRUCTIONS: 14 real briefs rated xhigh went from 10 to 1; guide §4.2). */
function effortInstructions(language: Language, field: string): Record<string, string> {
  if (language === 'zh') {
    return {
      问题: `一个派出的 agent 要完成 \`${field}\`，需要多少逐步推理？`,
      执行: `如果 \`${field}\` 已经写明了要改的文件、步骤和测试，设计就已经做完了，照着做只是执行。只有它本身要求设计、原因未知，或需要尚未写出的推理时，才评得更高。`,
      评什么: '评的是工作本身，而不是话题听起来有多重要：审查一份小 diff 是常规工作，即使涉及安全。',
    }
  }
  return {
    question: `How much step-by-step reasoning does a dispatched agent need to carry out \`${field}\`?`,
    execution: `A brief that already names the files, the steps and the tests has done the design: carrying it out is execution. Rate higher only when \`${field}\` itself asks for design, an unknown cause, or reasoning that is not already written out.`,
    rate: 'Rate the work, not how important the topic sounds: reviewing a small diff is ordinary work, even for security.',
  }
}

/** The option name of a model in the model question. */
function optionOf(model: AgentModel, options: DispatchAsk['options']): string {
  return options === 'work' ? KINDS.en[model].work : model
}

/**
 * Whether the person asks for `model` to carry out the brief. A model's name
 * in their words is no request by itself: the decision model reads it in
 * context, so a mention as a product, as what wrote earlier code, as the one
 * not to use, or for another part of the work (the eval's traps) is a no.
 */
function namedQuestion(model: AgentModel, language: Language, field: string): Question {
  const title = model.charAt(0).toUpperCase() + model.slice(1)
  if (language === 'zh') {
    return {
      type: 'noul',
      instructions: { 模型: model, 问题: `\`user_message\` 是否要求用 \`模型\` 来做 \`${field}\` 里的工作？` },
      criteria: {
        true: `用户要求这项工作（或所有派出的 agent）用这个模型，例如「用 ${model}」「这活儿 ${model} 就够了」「派个 ${model} 去查」「这次所有 agent 都用 ${model}」「用 ${title} 跑」。`,
        false: `只是提到这个模型：作为讨论或比较的产品、作为之前写某段代码的模型、作为不要用的模型，或者是给 \`${field}\` 以外的另一部分工作点名的模型。`,
      },
    }
  }
  return {
    type: 'noul',
    instructions: { model, question: `Does \`user_message\` ask for \`model\` to carry out the work in \`${field}\`?` },
    criteria: {
      true: `The person asks for this model for this work, or for every agent: "use ${model}", "${model} is enough for this", "send ${model} to look into it", "every agent uses ${model} this time", "run it on ${title}".`,
      false: `The model is only mentioned: as a product being discussed or compared, as what wrote some earlier code, as a model not to use, or as the model for a different part of the work than \`${field}\`.`,
    },
  }
}

/** Whether the work in the brief is within what the main agent's pick covers (the `requested: 'noul'` variant). */
function requestedFitsQuestion(model: AgentModel, language: Language, field: string): Question {
  const kind = KINDS[language][model]
  const names = FIELDS[language]
  const covers = { [names.choose_for]: kind.choose_for, [names.not_for]: kind.not_for }
  if (language === 'zh') return { type: 'noul', instructions: { 指定: covers, 问题: `\`${field}\` 要求的工作是否在 \`指定\` 覆盖的范围内？` } }
  return { type: 'noul', instructions: { requested: covers, question: `Is the work that \`${field}\` asks for within what \`requested\` covers?` } }
}

/** Whether the person rules `model` out for the brief ("别用 opus"): the model is then not used for it. */
function bannedQuestion(model: AgentModel, language: Language, field: string): Question {
  if (language === 'zh') {
    return {
      type: 'noul',
      instructions: { 模型: model, 问题: `\`user_message\` 是否排除了用 \`模型\` 来做 \`${field}\` 里的工作？` },
      criteria: {
        true: `用户说这项工作（或所有派出的 agent）不要用这个模型，例如「别用 ${model}」「别再用 ${model} 了」「${model} 太贵了，换个便宜的」。`,
        false: `要求用这个模型、只是提到它，或者排除它的是 \`${field}\` 以外的另一部分工作。`,
      },
    }
  }
  return {
    type: 'noul',
    instructions: { model, question: `Does \`user_message\` rule out \`model\` for the work in \`${field}\`?` },
    criteria: {
      true: `The person says not to use this model for this work or for any agent: "don't use ${model}", "no more ${model}", "${model} is too expensive, use something cheaper".`,
      false: `The model is asked for, only mentioned, or ruled out for a different part of the work than \`${field}\`.`,
    },
  }
}

/**
 * Whether the person's words may name an effort: a cheap sign of text, only to
 * decide whether the named-effort question is worth its place in the request.
 * It is no judgment (spec #1): the decision model reads the words, and says
 * whether an effort is asked for and which. So it errs wide: a level's name,
 * "effort", or how hard to think, in either language.
 */
export function mentionsEffort(text: string): boolean {
  return EFFORT_WORDS.test(text)
}

/**
 * Words that may ask for an effort: a level's name, or a way of asking for
 * more (or less) thought. "think" and "reason" alone are everyday words ("I
 * think", "the reason"), so in English only a phrase counts ("think hard",
 * "more reasoning", "ultrathink").
 */
const EFFORT_WORDS =
  /effort|\bx-?high\b|extra[- ]high|\b(?:low|medium|high|max|maximum)\b|ultrathink|\bthink(?:ing)?\s+(?:hard|harder|deep(?:ly|er)?|long(?:er)?|carefully|more|less)\b|\b(?:more|less|deep(?:er)?|extra|maximum|minimal|careful)\s+(?:reasoning|thinking|thought)\b|\breasoning\s+(?:effort|level|budget)\b|推理|思考|思维|努力|强度|力度|档|拉满|开满|最低|最高|超高|极高/i

/**
 * Whether the person asks for an effort for the agent that carries out the
 * brief, and which: one of the five levels, or none. Like a model's name, a
 * level's name in their words is no request by itself; the decision model
 * reads it in context, and an effort asked for another part of the work is none.
 */
function namedEffortQuestion(language: Language, field: string): Question {
  if (language === 'zh') {
    return {
      type: 'choice',
      instructions: {
        问题: `\`user_message\` 是否明确要求 \`${field}\` 里的工作用某一档 effort（思考强度）？要求的是哪一档？`,
        范围: '为所有派出的 agent 或这一轮全部工作要求的档位，也管这项工作；只给 `' + field + '` 以外的另一部分工作要求的档位不管。',
        不算: '只说「多想想」「别想太久」而没点名档位、只是提到某一档（讨论、比较、以前的设置、不想要的档位），都选 none。',
      },
      criteria: {
        [NO_EFFORT]: '用户没有为这项工作要求任何一档 effort。',
        low: '用户要求这项工作（或所有派出的 agent）用 low 档，例如「effort 开 low」「用最低档思考」。',
        medium: '用户要求这项工作（或所有派出的 agent）用 medium 档，例如「effort 用 medium」「中档就行」。',
        high: '用户要求这项工作（或所有派出的 agent）用 high 档，例如「effort 开 high」「用高档」。',
        xhigh: '用户要求这项工作（或所有派出的 agent）用 xhigh 档，例如「effort 开 xhigh」「超高档」。',
        max: '用户要求这项工作（或所有派出的 agent）用 max 档，例如「effort 拉满」「用 max」「最高档」。',
      },
    }
  }
  return {
    type: 'choice',
    instructions: {
      question: `Does \`user_message\` explicitly ask for a particular effort level (how hard the agent thinks) for the work in \`${field}\`, and which one?`,
      scope: `A level asked for every agent, or for all the work this turn, covers this work too; a level asked only for a different part of the work than \`${field}\` does not.`,
      not_a_request: 'Asking to think more or less without naming a level, or mentioning a level only in passing (discussed or compared, an earlier setting, a level the person does not want), asks for none.',
    },
    criteria: {
      [NO_EFFORT]: 'The person asks for no effort level for this work.',
      low: 'The person asks for low effort for this work or for every agent: "effort low", "set effort to low", "run it at low effort".',
      medium: 'The person asks for medium effort for this work or for every agent: "effort medium", "medium effort is enough".',
      high: 'The person asks for high effort for this work or for every agent: "effort high", "use high effort".',
      xhigh: 'The person asks for xhigh (extra high) effort for this work or for every agent: "effort xhigh", "extra high effort".',
      max: 'The person asks for max effort for this work or for every agent: "effort max", "max effort", "all the way up".',
    },
  }
}

/** The models whose names `text` mentions, in any case and inside ids (`claude-sonnet-5-5`); cheapest first. */
export function mentionedModels(text: string): AgentModel[] {
  const lower = text.toLowerCase()
  return AGENT_MODELS.filter((model) => lower.includes(model))
}

/** The questions about one dispatched agent, as one part of a request. */
export function dispatchPart(dispatch: Dispatch, shape: DispatchShape = {}): Part {
  const ask = { ...DEFAULT_DISPATCH_ASK, ...shape.ask }
  const field = shape.field ?? BRIEF
  const models = shape.models ?? DEFAULT_AGENT_MODELS
  const names = FIELDS[ask.language]
  const criteria = Object.fromEntries(
    models.map((model) => {
      const kind = KINDS[ask.language][model]
      return [optionOf(model, ask.options), { [names.choose_for]: kind.choose_for, [names.not_for]: kind.not_for }]
    }),
  )
  // The main agent's pick, when it is one of the options.
  const family = modelFamily(dispatch.requested_model)
  const requested = family !== null && models.includes(family) ? family : null
  const hint = requested !== null && ask.requested === 'hint' ? optionOf(requested, ask.options) : null
  const questions: Record<string, Question> = {
    [MODEL]: { type: 'choice', instructions: modelInstructions(ask.language, ask.options, field, hint), criteria },
    [EFFORT]: effortQuestion(effortInstructions(ask.language, field), ask),
  }
  if (requested !== null && ask.requested === 'noul') questions[REQUESTED_FITS] = requestedFitsQuestion(requested, ask.language, field)
  // Asked of every model the person's words mention, offered or not: a model
  // they name is used even when it is not among the options.
  const mentioned = mentionedModels(dispatch.user_message)
  for (const model of mentioned) questions[`${NAMED}.${model}`] = namedQuestion(model, ask.language, field)
  for (const model of mentioned) questions[`${BANNED}.${model}`] = bannedQuestion(model, ask.language, field)
  // Asked when the person's words may name an effort: one they ask for is used.
  if (mentionsEffort(dispatch.user_message)) questions[NAMED_EFFORT] = namedEffortQuestion(ask.language, field)
  return { part: shape.part ?? AGENT_PART, questions }
}

/** The person's words take at most this share of the state's budget; the brief has the rest. */
const WORDS_SHARE = 1 / 3
/** A text cut to fit keeps this share of its budget for its end. */
const TAIL_SHARE = 0.3

/** The brief of one agent as the decision model reads it: secrets masked, the prompt cut to `tokens`. */
export function dispatchBrief(dispatch: Dispatch, tokens: number): Record<string, string> {
  const brief: Record<string, string> = {}
  const short = (text: string, budget: number) => clipToTokens(redactSecrets(text).replace(/\s+/g, ' ').trim(), budget, TAIL_SHARE)
  if (dispatch.description) brief.description = short(dispatch.description, 60)
  if (dispatch.agent_type) brief.agent_type = short(dispatch.agent_type, 30)
  if (dispatch.workflow_description) brief.workflow_description = short(dispatch.workflow_description, 200)
  if (dispatch.label) brief.label = short(dispatch.label, 60)
  const used = Object.values(brief).reduce((sum, text) => sum + estimateTokens(text) + 4, 0)
  brief.prompt = clipToTokens(redactSecrets(dispatch.prompt), Math.max(tokens - used, 100), TAIL_SHARE)
  return brief
}

/**
 * The state of a request about one agent: `{ brief, user_message }`, the
 * brief first (what every question is about), within `tokens` as it is sent
 * (`withinTokens`). The person's words take at most a third of the budget;
 * the brief has the rest.
 */
export function dispatchState(dispatch: Dispatch, tokens: number, field: string = BRIEF): State {
  return withinTokens((budget) => {
    const words = dispatchWords(dispatch.user_message, budget)
    return { [field]: dispatchBrief(dispatch, budget - estimateTokens(words)), user_message: words }
  }, tokens)
}

/** The person's words as a request about an agent (or a Workflow's agents) reads them: secrets masked, at most a third of `tokens`. */
export function dispatchWords(text: string, tokens: number): string {
  return clipToTokens(redactSecrets(text), Math.floor(tokens * WORDS_SHARE), TAIL_SHARE)
}

/** A model counts as named (or ruled out) by the person when its yes/no answer reaches this, unless the settings say otherwise (`thetaNamed`). */
export const THETA_NAMED = 0.5

/** Asked with `requested: 'noul'`: the main agent's pick goes only when `requested_fits` is below this, unless the settings say otherwise (`thetaFit`). */
export const THETA_FIT = 0.5

/** What decides an agent's model and effort from the answers. */
export type DispatchSettings = DispatchShape & {
  /** The decision model's pick replaces the main agent's only at this confidence or above. */
  thetaOverride: number
  /** `max` only when its own probability reaches this. */
  thetaMax: number
  /** A model counts as named by the person when its yes/no answer reaches this; THETA_NAMED by default. */
  thetaNamed?: number
  /** `requested: 'noul'` only: the main agent's pick goes only when `requested_fits` is below this; THETA_FIT by default. */
  thetaFit?: number
}

/**
 * Where the model came from: the person named it, the decision model chose
 * it, the main agent's pick was kept, or nothing applies (the engine's choice
 * stands).
 */
export type ModelSource = 'user' | 'decided' | 'requested' | 'none'

export type DispatchDecision = {
  /** The model to start the agent on; null: no usable answer, the engine's choice stands. */
  model: AgentModel | null
  /** The effort of the agent's steps; null for haiku (it takes none) or without a usable answer. */
  effort: Effort | null
  source: ModelSource
  /**
   * The decision model's pick among the options not ruled out, with its
   * confidence among them; null without a usable answer. `nearest` is set when
   * the answer gave the options left no probability (all of it was on a model
   * the person ruled out): the pick is then the option nearest to the model
   * the decision model chose, at confidence 0.
   */
  pick: { model: AgentModel; confidence: number; nearest?: true } | null
  /** The models the person ruled out for this agent. */
  banned: AgentModel[]
  /** The effort answer's level probabilities, also when unused (haiku); null without a usable answer. */
  reading: EffortReading | null
  /** False when neither the model nor the effort question got a usable answer: a failed request. */
  answered: boolean
  /** The effort the person asked for, as the decision model read their words, whether or not it could be set (haiku takes none); null when none. */
  namedEffort?: Effort | null
  /** Whose the effort is: the person's (`user`, the one they named), the decision model's, or none (haiku, or no usable answer). */
  effortSource?: 'user' | 'decided' | 'none'
  /** The effort rules' working for the decided effort (with the model's floor); the person's named effort is not in it. Null without a usable answer. */
  trace: EffortTrace | null
  /** The decided effort the floor lifted `effort` from; unset when the floor lifted nothing. */
  liftedFrom?: Effort
}

/**
 * The model and effort for one agent, from its part's answers (by their ids
 * within the part, as `answersFor` gives them). Priority (spec #33, #34): a
 * model the person names for the work; else the decision model's pick, which
 * replaces the main agent's only when it is sure enough (`thetaOverride`). A
 * model the person rules out is neither picked nor kept, in any branch: the
 * pick is the most probable of the other options, its confidence taken among
 * them, and when the answer gives them no probability at all, the option
 * nearest to the one it chose. An effort the person names is the agent's
 * effort, over the decided one (haiku takes none).
 */
export function decideDispatch(answers: Readonly<Record<string, Answer>>, dispatch: Dispatch, settings: DispatchSettings): DispatchDecision {
  const ask = { ...DEFAULT_DISPATCH_ASK, ...settings.ask }
  const threshold = settings.thetaNamed ?? THETA_NAMED
  const named = mostLikely(answers, NAMED, threshold)
  const banned = AGENT_MODELS.filter((model) => {
    const answer = answers[`${BANNED}.${model}`]
    return answer?.type === 'noul' && answer.noul >= threshold && model !== named
  })
  const models = (settings.models ?? DEFAULT_AGENT_MODELS).filter((model) => !banned.includes(model))
  const reading = readEffort(answers[EFFORT])
  const requested = modelFamily(dispatch.requested_model)
  // Without probability on the options left, a model ruled out is still not the agent's: the nearest option takes its place.
  const pick = readPick(answers[MODEL], models, ask.options) ?? (banned.length > 0 ? nearestPick(answers[MODEL], models, banned, requested, ask.options) : null)
  // In the requested_fits variant the pick must also be said not to fit.
  const fits = answers[REQUESTED_FITS]
  const misfit = ask.requested !== 'noul' || fits?.type !== 'noul' || fits.noul < (settings.thetaFit ?? THETA_FIT)
  const overridden = pick !== null && pick.nearest !== true && pick.model !== requested && pick.confidence >= settings.thetaOverride && misfit
  let model: AgentModel | null = pick?.model ?? null
  let source: ModelSource = model === null ? 'none' : 'decided'
  if (named !== null) {
    model = named
    source = 'user'
  } else if (requested !== null && !banned.includes(requested) && !overridden) {
    model = requested
    source = 'requested'
  }
  // An effort the person names is the agent's, over the decided one; haiku takes none either way. The decided one
  // is lifted to its model's floor; the person's never is.
  const namedEffort = readNamedEffort(answers[NAMED_EFFORT], threshold)
  const floor = reading === null ? null : effortFloor(model)
  const trace = reading === null ? null : traceEffort(reading, settings.thetaMax, { model: { name: model ?? 'none', floor } })
  const decided = reading === null ? null : pickEffort(reading, settings.thetaMax)
  const lifted = decided !== null && floor !== null && EFFORTS.indexOf(floor) > EFFORTS.indexOf(decided) ? floor : null
  const effort = model === 'haiku' ? null : (namedEffort ?? lifted ?? decided)
  const effortSource = effort === null ? 'none' : namedEffort !== null ? 'user' : 'decided'
  const answered = answers[MODEL]?.type === 'choice' || reading !== null
  return { model, effort, source, pick, banned, reading, answered, namedEffort, effortSource, trace, ...(namedEffort === null && model !== 'haiku' && lifted !== null && decided !== null ? { liftedFrom: decided } : {}) }
}

/**
 * The least effort an agent on `model` goes at; null for none (haiku takes no
 * effort, fable has no floor). Raising is easy, lowering is hard: on AA's
 * Intelligence Index (v4.3.2) Sonnet 5.5 scores 36 at low, 41 at medium, 47 at
 * high (Terminal-Bench 20.7%, 29.8%, 43.9%) and Opus 5.5 42, 51, 54
 * (Terminal-Bench 31.3%, 52.5%, 56.6%): both lose most below medium, so both
 * go at medium at least. (0.2.2 first held sonnet at high; on the eval the
 * dataset's gold, the cheapest level that does the work, was passed by 10
 * points more often, results/subagent/2026-10-05-jev-aa-routing.json, and the
 * floor went down to medium.) Not settings: set from the AA numbers
 * (docs/research/aa-benchmarks-2026-10.md).
 */
export function effortFloor(model: AgentModel | null): Effort | null {
  return model === 'sonnet' || model === 'opus' ? 'medium' : null
}

/**
 * The effort the person asks for: the level the named-effort answer favours,
 * when it beats "none" and reaches `threshold` of the answer's probability;
 * null otherwise (no answer, none asked for, or too unsure).
 */
function readNamedEffort(answer: Answer | undefined, threshold: number): Effort | null {
  if (answer === undefined || answer.type !== 'choice') return null
  const sum = [NO_EFFORT, ...EFFORTS].reduce((total, name) => total + (answer.probabilities[name] ?? 0), 0)
  if (!(sum > 0)) return null
  let best: Effort | null = null
  let top = 0
  for (const level of EFFORTS) {
    const p = (answer.probabilities[level] ?? 0) / sum
    if (p > top) {
      best = level
      top = p
    }
  }
  const none = (answer.probabilities[NO_EFFORT] ?? 0) / sum
  return best !== null && top >= threshold && top > none ? best : null
}

/**
 * The pick when the options left (`models`, those the person did not rule out)
 * have no probability in the answer: the option nearest, among the models, to
 * the one the decision model chose, else to the main agent's pick, else to a
 * model ruled out; a tie goes to the cheaper. Confidence 0: it is no sure
 * choice, only a model that is not ruled out. Null when no option is left.
 */
function nearestPick(answer: Answer | undefined, models: readonly AgentModel[], banned: readonly AgentModel[], requested: AgentModel | null, options: DispatchAsk['options']): DispatchDecision['pick'] {
  let anchor: AgentModel | null = null
  if (answer?.type === 'choice') {
    let top = 0
    for (const model of AGENT_MODELS) {
      const p = answer.probabilities[optionOf(model, options)] ?? 0
      if (p > top) {
        anchor = model
        top = p
      }
    }
  }
  const at = AGENT_MODELS.indexOf(anchor ?? requested ?? banned[0] ?? 'sonnet')
  let best: AgentModel | null = null
  for (const model of models) {
    if (best === null || Math.abs(AGENT_MODELS.indexOf(model) - at) < Math.abs(AGENT_MODELS.indexOf(best) - at)) best = model
  }
  return best === null ? null : { model: best, confidence: 0, nearest: true }
}

/**
 * The person's own terms for one agent's work, as the decision model read
 * their words: the model they named (点名) and the effort they named, the
 * models they ruled out (排除). Kept in the agent's plan (core/plans.ts), so
 * that whatever changes its model or effort later keeps to them.
 */
export type Terms = {
  /** The model they named for the work; null for none. */
  model: AgentModel | null
  /** The effort they named for the work, whether or not its model takes one; null for none. */
  effort: Effort | null
  /** The models they ruled out for the work. */
  banned: AgentModel[]
}

/** The terms a decision read from the person's words; null when they named nothing and ruled nothing out. */
export function termsOf(decision: DispatchDecision): Terms | null {
  const model = decision.source === 'user' ? decision.model : null
  const effort = decision.namedEffort ?? null
  if (model === null && effort === null && decision.banned.length === 0) return null
  return { model, effort, banned: [...decision.banned] }
}

/**
 * What the log says of a decision beyond whose model it is: the models ruled
 * out and what stood in for them, and the effort the person asked for.
 */
export function decisionNotes(decision: DispatchDecision): string[] {
  const notes: string[] = []
  if (decision.banned.length > 0) notes.push(`排除了 ${decision.banned.join('、')}`)
  if (decision.pick?.nearest === true) notes.push(`回答没给其余模型留下概率，取最接近的 ${decision.pick.model}`)
  if (decision.liftedFrom !== undefined && decision.effort !== null) notes.push(`effort 从 ${decision.liftedFrom} 抬到 ${decision.effort}（模型下限：${decision.model ?? '这个模型'}）`)
  if (decision.namedEffort != null) {
    notes.push(
      decision.effortSource === 'user'
        ? `你在消息里点名了 effort（${decision.namedEffort}）`
        : `你在消息里要 effort ${decision.namedEffort}，没有设置：${decision.model ?? '这个模型'} 不带 effort`,
    )
  }
  return notes
}

/**
 * What the decision log keeps of a decision beyond its words, for the card that shows why: the effort levels'
 * probabilities, the confidence of the model pick (else of the effort answer), the effort rules' working and
 * the model's floor when it lifted the effort. Each is left out when the decision has none.
 */
export function dispatchEvidence(decision: DispatchDecision): {
  probs?: Record<Effort, number>
  conf?: number
  trace?: EffortTrace['steps']
  floor?: { from: Effort; to: Effort; model: AgentModel }
} {
  const conf = decision.pick?.confidence ?? decision.reading?.confidence ?? null
  const levels = decision.reading?.probabilities
  return {
    ...(levels === undefined ? {} : { probs: Object.fromEntries(EFFORTS.map((level, i) => [level, levels[i] ?? 0])) as Record<Effort, number> }),
    ...(conf === null ? {} : { conf }),
    ...(decision.trace === null ? {} : { trace: decision.trace.steps }),
    ...(decision.liftedFrom !== undefined && decision.effort !== null && decision.model !== null ? { floor: { from: decision.liftedFrom, to: decision.effort, model: decision.model } } : {}),
  }
}

/**
 * Why an agent goes out as it does, for the decision log (Chinese: the person's
 * words): whose model it is (`asker` is whose pick a kept model was: "主 agent"
 * for a dispatched agent, "脚本" for a Workflow's), the decision model's pick,
 * what was ruled out, the effort answer.
 */
export function dispatchReason(decision: DispatchDecision, requested: string | null, thetaOverride: number, asker: string): string {
  const pick = decision.pick === null ? null : `选 ${decision.pick.model}，置信度 ${decision.pick.confidence.toFixed(2)}`
  const parts: string[] = []
  if (decision.source === 'user') parts.push('你在消息里点名了模型')
  else if (decision.source === 'requested') parts.push(`沿用${asker} ${requested}${decision.pick !== null && decision.pick.model !== requested ? `（置信度没到推翻门槛 ${thetaOverride.toFixed(2)}）` : ''}`)
  else if (decision.source === 'decided') parts.push(requested !== null && requested !== decision.model ? `已决定，不用${asker} ${requested}` : '已决定')
  else parts.push('沿用引擎的模型')
  if (pick !== null) parts.push(pick)
  parts.push(...decisionNotes(decision))
  if (decision.reading !== null) parts.push(`effort 概率 ${levelsText(decision.reading)}`)
  return parts.join('；')
}

/** The model whose `<prefix>.<model>` yes/no answer is highest and reaches `threshold`; null when none does. */
function mostLikely(answers: Readonly<Record<string, Answer>>, prefix: string, threshold: number): AgentModel | null {
  let best: AgentModel | null = null
  let top = threshold
  for (const model of AGENT_MODELS) {
    const answer = answers[`${prefix}.${model}`]
    if (answer?.type === 'noul' && answer.noul >= top && (best === null || answer.noul > top)) {
      best = model
      top = answer.noul
    }
  }
  return best
}

/** The most probable option of the model question, and its confidence; null when the answer is missing or names no option. */
function readPick(answer: Answer | undefined, models: readonly AgentModel[], options: DispatchAsk['options']): DispatchDecision['pick'] {
  if (answer === undefined || answer.type !== 'choice') return null
  const p = models.map((model) => answer.probabilities[optionOf(model, options)] ?? 0)
  const sum = p.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  let best = 0
  for (let i = 1; i < p.length; i++) if ((p[i] ?? 0) > (p[best] ?? 0)) best = i
  const top = (p[best] ?? 0) / sum
  const n = models.length
  return { model: models[best] as AgentModel, confidence: n > 1 ? (top - 1 / n) / (1 - 1 / n) : 1 }
}

/** The model family an alias or id names (`claude-sonnet-5-5` is sonnet); null for none or an unknown one. */
export function modelFamily(model: string | null | undefined): AgentModel | null {
  if (!model) return null
  const lower = model.toLowerCase()
  return AGENT_MODELS.find((family) => lower.includes(family)) ?? null
}
