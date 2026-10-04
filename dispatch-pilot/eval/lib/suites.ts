// Every suite the eval can run, by the name of the dataset it reads
// (eval/datasets/<name>.jsonl). A new kind of dataset brings its suite in a
// file of its own beside effort-submit.ts and adds one line here (#14
// effort-midturn, #15 subagent, #16 skill).

import { effortSubmit } from './effort-submit.ts'
import type { Suite } from './suite.ts'

// Each suite has its own item and prediction types; the runner and the
// metrics are generic over them, so the table holds them loosely.
export const SUITES: Readonly<Record<string, Suite<any, any>>> = {
  'effort-submit': effortSubmit,
}
