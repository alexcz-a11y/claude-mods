// Dispatch Pilot's entry: it only assembles. Each feature lives in its own
// file under features/ and registers its own hooks; the core goes last.
//
// Order is nesting: what registers first is outermost and sees an event
// first. Features go above the core so that on every event they share, each
// feature has run before the core finishes the event (sends the decision
// request, writes the step). To add a feature: one file, one line here,
// above `registerCore` (DEVELOPMENT.md, 开发).

import type { Register } from 'claude-code'
import { registerScreens, registerStatus } from './board/screens.tsx'
import { registerCore } from './core/core.ts'
import { registerLoopStart } from './core/loop-start.ts'
import { registerReport } from './core/report.ts'
import { setup } from './core/setup.ts'
import { registerControl } from './features/control.ts'
import { registerDispatchedAgents } from './features/dispatched-agents.ts'
import { registerEscalation } from './features/escalation.ts'
import { registerFindSkill } from './features/find-skill.ts'
import { registerImageRouting } from './features/image-routing.ts'
import { registerMainEffort } from './features/main-effort.ts'
import { registerPromptHint } from './features/prompt-hint.ts'
import { registerUnresolved } from './features/unresolved.ts'
import { registerVisualCheck } from './features/visual-check.ts'
import { registerScreenshotTakeover } from './features/screenshot-takeover.ts'
import { registerSkills } from './features/skills.ts'
import { registerWorkflowAgents } from './features/workflow-agents.ts'
import { registerWorkflowLabels } from './features/workflow-labels.ts'

export const register: Register = (on, options) => {
  const ctx = setup(options)

  // The status line where the band is not drawn: outermost of all, so a turn's end reads the board the report wrote.
  registerStatus(on)
  // The decision report keeps the board's turn count: outermost but the status line, so a turn is counted before anything beneath reads the board.
  registerReport(on)
  // The screens draw the report's data (the band, the footer); no feature touches them.
  registerScreens(on)

  // When each loop began (the screenshot takeover and the routing's reference images read it): no switch, no decision.
  registerLoopStart(on)

  // Features, outermost first.
  registerControl(on, ctx)
  registerMainEffort(on, ctx)
  registerUnresolved(on, ctx)
  registerEscalation(on, ctx)
  registerDispatchedAgents(on, ctx)
  registerWorkflowAgents(on, ctx)
  // Inside workflow-agents: a Workflow call is this feature's only once that feature has sent the script on, so the
  // agents of other runs never wait while it is still deciding.
  registerWorkflowLabels(on, ctx)
  registerSkills(on, ctx)
  registerFindSkill(on, ctx)
  registerVisualCheck(on, ctx)
  registerScreenshotTakeover(on, ctx)
  registerImageRouting(on, ctx)
  // The prompt box's hint: it decides nothing, and reads only the switches and the lock.
  registerPromptHint(on)

  // The core: always last.
  registerCore(on, ctx)
}
