// Every suite the eval can run, by the name of the dataset it reads
// (eval/datasets/<name>.jsonl). A new kind of dataset brings its suite in a
// file of its own beside effort-submit.ts and adds one line here (#14
// effort-midturn, #15 subagent, #16 skill). A suite that needs more than one
// item at a time is built when a run starts: from what the host gives it
// (SuiteHost: the skill suite's catalog, profiles and SKILL.md files), or
// from the dataset's items (the `subagent` suite: a Workflow's agents are asked
// about together).

import { effortMidturn } from './effort-midturn.ts'
import { effortSubmit } from './effort-submit.ts'
import type { FlowFile } from './eval-v2-flow.ts'
import { evalV2Suite } from './eval-v2-suite.ts'
import { longContextSuite, SUMMARY_FILE, type SummaryFile } from './long-context.ts'
import { skillSuite } from './skill.ts'
import { agentSuite } from './subagent.ts'
import { unresolved } from './unresolved.ts'
import type { AgentItem } from './datasets.ts'
import type { Suite, SuiteHost } from './suite.ts'

/** What a run hands a suite besides the host and the items: a flow file (`run.ts --flow`), for the suites that read one. */
export type SuiteRun = { flow?: unknown }

/** The suites that read a flow file (`--flow`); a run refuses one for any other. */
export const READS_FLOW: readonly string[] = ['eval-v2']

/** A suite built when a run starts, from the host and every item of the dataset (not only those the run asks). */
export type SuiteFactory = (host: SuiteHost, items: readonly unknown[], run?: SuiteRun) => Promise<Suite<any, any>>

// Each suite has its own item and prediction types; the runner and the
// metrics are generic over them, so the table holds them loosely.
export const SUITES: Readonly<Record<string, Suite<any, any> | SuiteFactory>> = {
  'effort-submit': effortSubmit,
  'effort-midturn': effortMidturn,
  subagent: async (_host, items) => agentSuite(items as readonly AgentItem[]),
  skill: (host) => skillSuite({ catalog: host.beside('skill-catalog.json'), profiles: host.beside('skill-profiles.json'), read: host.read }),
  unresolved,
  // The summaries beside the dataset are what the flow variants carry; without the file those variants say so.
  'long-context': (host) => longContextSuite(host.beside(SUMMARY_FILE) as SummaryFile | undefined),
  // eval-v2.jsonl with the final gold (eval/node.ts readEvalV2Dataset); the flow variants carry what the run's flow file holds.
  'eval-v2': async (_host, _items, run) => evalV2Suite(run?.flow as FlowFile | undefined),
}
