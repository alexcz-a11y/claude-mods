// Dispatch Pilot's entry: it only assembles. Each feature lives in its own
// file under features/ and registers its own hooks; the core goes last.
//
// Order is nesting: what registers first is outermost and sees an event
// first. Features go above the core so that on every event they share, each
// feature has run before the core finishes the event (sends the decision
// request, writes the step). To add a feature: one file, one line here,
// above `registerCore` (README, 开发).

import type { Register } from 'claude-code'
import { registerCore } from './core/core.ts'
import { setup } from './core/setup.ts'
import { registerControl } from './features/control.ts'
import { registerDispatchedAgents } from './features/dispatched-agents.ts'
import { registerMainEffort } from './features/main-effort.ts'
import { registerMidturnEffort } from './features/midturn-effort.ts'
import { registerSkills } from './features/skills.ts'

export const register: Register = (on, options) => {
  const ctx = setup(options)

  // Features, outermost first.
  registerControl(on, ctx)
  registerMainEffort(on, ctx)
  registerMidturnEffort(on, ctx)
  registerDispatchedAgents(on, ctx)
  registerSkills(on, ctx)

  // The core: always last.
  registerCore(on, ctx)
}
