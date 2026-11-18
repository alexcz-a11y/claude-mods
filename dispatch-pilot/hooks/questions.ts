// Every question the decision model is asked, in one place. Pure data: no $ calls.
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
