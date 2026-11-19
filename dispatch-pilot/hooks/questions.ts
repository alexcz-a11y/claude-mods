// Every question the decision model is asked, and the thresholds its answers are read with, in one place. Pure data:
// no $ calls.
// Questions point at state fields with a backtick path (`request`, `latest.result`), so a field
// renamed in statebuild.ts must be renamed here too (a test checks the top-level names).
// The wording is a starting point; calibration may change it.

export type Question =
  | { type: 'score'; instructions: string; criteria: readonly string[] }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }

// One situation per level, lowest first; each stands on its own, with no degree words.
export const OPEN_LEVELS = [
  'The way to do it is already given; the work is carrying it out.',
  'A few possibilities within a small area, or one small trap to watch for.',
  'Several workable designs or several possible causes; a choice has to be made between them.',
  'The cause is unknown and the behavior is intermittent, concurrent or state-dependent, or the change is easy to get subtly wrong.',
  'The cause is unknown or the change is easy to get subtly wrong, and in addition it cannot be reproduced, the operation cannot be undone, or it must be switched over while running.',
] as const

function open(instructions: string): Question {
  return { type: 'score', instructions, criteria: OPEN_LEVELS }
}

function noul(instructions: string, yes: string, no: string): Question {
  return { type: 'noul', instructions, criteria: { true: yes, false: no } }
}

// `where` is the state field the work is described in: `request` or `task`.
function mechanical(where: string): Question {
  return noul(
    `In \`${where}\`, is the work a repetition of an approach that is already known?`,
    'Every change follows a pattern that is stated or already applied elsewhere.',
    'At least one part needs a decision about how to do it.',
  )
}

function unknownCause(where: string): Question {
  return noul(
    `In \`${where}\`, does the work first require finding the cause of a problem whose cause is not known?`,
    'A failure is reported and nothing given says why it happens.',
    'No failure is involved, or its cause is stated.',
  )
}

export function submitQuestions(hasPrevious: boolean): Record<string, Question> {
  const questions: Record<string, Question> = {
    open: open('How open is the problem that `request` asks to solve?'),
    mechanical: mechanical('request'),
    unknown_cause: unknownCause('request'),
  }
  if (hasPrevious) {
    questions.continues = noul(
      'Does `request` only ask the assistant to go on with work it already proposed or is doing in `previous_turn`?',
      'The message approves or says to continue, adding no new task.',
      'The message gives a new task, a correction, or answers only a detail.',
    )
  }
  return questions
}

export function midrunQuestions(): Record<string, Question> {
  return {
    open: open('How open is the problem in the work that remains for `request`, given `recent` and `latest`?'),
    same_failure: noul(
      'Does `latest.result` show the same failure that an earlier entry in `recent` showed, after a change was made to fix it?',
      'The same error or failing check appears again after an edit aimed at it.',
      'No failure, a different failure, or no fix was attempted in between.',
    ),
    cause_found: noul(
      'Do `recent` and `latest` show that the cause of the problem has been identified?',
      'A result shows what makes the problem happen.',
      'The cause is still being looked for, or there is no problem to diagnose.',
    ),
    only_carrying_out: noul(
      'Is the work that remains only carrying out what has already been decided?',
      'What is left is applying the same change elsewhere, running checks, or writing the summary.',
      'A decision about how to proceed is still open.',
    ),
    contradicts_plan: noul(
      'Does `latest.result` show something that contradicts what the work so far assumed?',
      'A result shows an assumption of the approach was wrong, or a new problem appeared.',
      'The result is what the approach expected.',
    ),
  }
}

// The skill suggestion, in the words of TypeSafe's skill_suggestion cookbook (verbatim; ADR 0018, 0021).
// skills.ts builds the questions from these; the cookbook gives the four nouls no criteria of their own.

export const SKILL_CHOICE = "Which of these skills, if any, is the right one to load to help with the user's latest request?"
export const SKILL_RERANK = "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."
export const SKILL_NOUL_CRITERIA = { true: 'Yes.', false: 'No.' } as const

/** The three action nouls (prose_suffices counts the other way round) and the named one, by question id. */
export const SKILL_GATES = {
  acts_on_user_system: 'Is the assistant being asked to act on the user\'s files, accounts, devices, or online services, rather than only to explain or advise?',
  would_follow_documented_procedure: 'Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?',
  prose_suffices: 'Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user\'s files or accounts?',
  named: 'Does the request ask for a specific named tool, format, template, or method to be used, rather than for general help?',
} as const

/** A skill the listing gives no description is said to have none, so the sentence still ends in words. */
export function skillFits(name: string, description: string): string {
  return `Does the skill '${name}' do the specific thing the user's request asks for? It is described as: ${description || '(no description)'}`
}

// The thresholds the answers are read with, beside the questions they read (amendment A10). decide.ts and skills.ts
// hold the reading; thresholdsFor and skillBarsFor pick a table from here.

export type Thresholds = { up: number; upHigh: number; down: number; yes: number; no: number; modelDown: number }
export type SkillBars = { action: number; named: number; fits: number }

/** The start values, for every backend and model no calibration covers (TypeSafe's 0.7 and 0.3, design 3.4). */
export const START: Thresholds = { up: 0.7, upHigh: 0.8, down: 0.7, yes: 0.7, no: 0.3, modelDown: 0.8 }
/** The skill_suggestion cookbook's ACTION_THRESHOLD, NAMED_THRESHOLD and FITS_THRESHOLD. */
export const START_SKILL_BARS: SkillBars = { action: 0.3, named: 0.5, fits: 0.3 }

export type Calibrated = { backend: 'drex' | 'jev'; model: string; submit: Thresholds; midrun: Thresholds; agent: Thresholds; skill: SkillBars }

// Calibrated on 2026-11-19 against drex-max-v1.1 on a tuning set of 10 cases per action; see eval/CALIBRATION.md.
// A threshold the tuning set did not constrain keeps its start value.
export const CALIBRATED: readonly Calibrated[] = [
  {
    backend: 'drex',
    model: 'drex-max-v1.1',
    submit: { up: 0.7, upHigh: 0.8, down: 0.7, yes: 0.7, no: 0.3, modelDown: 0.8 },
    midrun: { up: 0.7, upHigh: 0.8, down: 0.7, yes: 0.7, no: 0.3, modelDown: 0.8 },
    agent: { up: 0.7, upHigh: 0.8, down: 0.95, yes: 0.7, no: 0.3, modelDown: 0.8 },
    skill: { action: 0.3, named: 0.5, fits: 0.3 },
  },
]

export function agentQuestions(): Record<string, Question> {
  return {
    open: open('How open is the problem that `task` asks to solve?'),
    mechanical: mechanical('task'),
    unknown_cause: unknownCause('task'),
    read_only: noul(
      'Does `task` only require finding or reading information, with no changes to make?',
      'Nothing is to be edited, created, run for effect, or sent.',
      'At least one change is to be made.',
    ),
  }
}
