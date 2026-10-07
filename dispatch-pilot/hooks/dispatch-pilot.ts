// Dispatch Pilot's entry: it only assembles. Each feature lives in its own
// file under features/ and registers its own hooks; the core goes last.
//
// Order is nesting: what registers first is outermost and sees an event
// first. Features go above the core so that on every event they share, each
// feature has run before the core finishes the event (sends the decision
// request, writes the step). To add a feature: one file, one line here,
// above `registerCore` (DEVELOPMENT.md, 开发).

import type { Register } from 'claude-code'
import { registerScreens } from './board/screens.tsx'
import { registerCore } from './core/core.ts'
import { registerReport } from './core/report.ts'
import { setup } from './core/setup.ts'
import { registerControl } from './features/control.ts'
import { registerDispatchedAgents } from './features/dispatched-agents.ts'
import { registerEscalation } from './features/escalation.ts'
import { registerFindSkill } from './features/find-skill.ts'
import { registerMainEffort } from './features/main-effort.ts'
import { registerMidturnEffort } from './features/midturn-effort.ts'
import { registerUnresolved } from './features/unresolved.ts'
import { registerSkillProfiles } from './features/skill-profiles.ts'
import { registerSkills } from './features/skills.ts'
import { registerWorkflowAgents } from './features/workflow-agents.ts'
import { registerWorkflowLabels } from './features/workflow-labels.ts'

export const register: Register = (on, options) => {
  const ctx = setup(options)

  // The decision report keeps the board's turn count: outermost, so a turn is counted before anything beneath reads the board.
  registerReport(on)
  // The screens draw the report's data (the band, the footer); no feature touches them.
  registerScreens(on)

  // Features, outermost first.
  registerControl(on, ctx)
  registerMainEffort(on, ctx)
  registerUnresolved(on, ctx)
  registerEscalation(on, ctx) // above the mid-turn feature: its raise is in the plan before a mid-turn answer is applied
  registerMidturnEffort(on, ctx)
  registerDispatchedAgents(on, ctx)
  registerWorkflowAgents(on, ctx)
  // Inside workflow-agents: a Workflow call is this feature's only once that feature has sent the script on, so the
  // agents of other runs never wait while it is still deciding.
  registerWorkflowLabels(on, ctx)
  // Outside skills: at session start it writes the profiles of the skills that feature has just read.
  registerSkillProfiles(on, ctx)
  registerSkills(on, ctx)
  registerFindSkill(on, ctx)

  // The core: always last.
  registerCore(on, ctx)
}
