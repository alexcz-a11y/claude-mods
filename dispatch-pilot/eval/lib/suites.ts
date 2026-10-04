// Every suite the eval can run, by the name of the dataset it reads
// (eval/datasets/<name>.jsonl). A new kind of dataset brings its suite in a
// file of its own beside effort-submit.ts and adds one line here (#14
// effort-midturn, #15 subagent, #16 skill). A suite that reads more than its
// items is built when a run starts, from what the host gives it (SuiteHost).

import { effortMidturn } from './effort-midturn.ts'
import { effortSubmit } from './effort-submit.ts'
import { skillSuite } from './skill.ts'
import { subagent } from './subagent.ts'
import type { Suite, SuiteHost } from './suite.ts'

// Each suite has its own item and prediction types; the runner and the
// metrics are generic over them, so the table holds them loosely.
export const SUITES: Readonly<Record<string, Suite<any, any> | ((host: SuiteHost) => Promise<Suite<any, any>>)>> = {
  'effort-submit': effortSubmit,
  'effort-midturn': effortMidturn,
  subagent,
  skill: (host) => skillSuite({ catalog: host.beside('skill-catalog.json'), profiles: host.beside('skill-profiles.json'), read: host.read }),
}
