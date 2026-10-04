// dispatch-pilot's $.state contract (PluginState), by key. Hand-written and
// committed; `claude plugin validate` checks every $.state read and write
// against it. No top-level export: a contract declares types and nothing else.
//
// The shapes mirror hooks/core/plans.ts (Plan, TurnRecord, PendingDecision);
// tsc checks the two agree wherever the hooks read or write these values.

declare module 'claude-code' {
  interface PluginState {
    'dispatch-pilot': {
      /**
       * Effort decided for a prompt at prompt.submit, waiting for the turn that
       * prompt starts (core's turn.start takes it); oldest first, at most 16.
       */
      pending: { text: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; at: number }[]
      /**
       * One record per turn of each loop, id `<loop>:<turnId>` where loop is
       * `main` or the agentId. The core's turn.step writer sends what it says.
       */
      turns: StateFamily<{
        /** The routed effort: the latest decision; null leaves the engine's. */
        effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        /** No step of the turn goes below it (forced raises); null for none. */
        floor: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        /** The model to name, for a dispatched or workflow agent only; never sent for main. */
        model: string | null
        /** The text the turn started with (main), redacted and clipped; '' when unknown. */
        prompt: string
        /** Decisions made for the turn: the one at its start plus re-decisions. */
        decisions: number
        /** Times the routed effort moved from one decided level to another. */
        changes: number
      }>
      /**
       * A plan for every turn of one dispatched or workflow agent, id = agentId
       * (written at agent.spawn, or once the agent is known); a turn-level
       * plan of that agent wins over it slot by slot.
       */
      agents: StateFamily<{
        effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        floor: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        model: string | null
      }>
      /**
       * What the features recorded about their decisions (core/decisions.ts),
       * oldest first, at most 50: what `/dp log` shows. `n` counts the session's
       * decisions from 1.
       */
      decisionLog: { n: number; feature: string; outcome: string; about: string; reason: string }[]
      /** The person's lock on the main agent's effort: wins over every decision; null when unlocked. */
      lock: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
      /**
       * The mid-turn re-decision's own record of a main turn (#5), id
       * `main:<turnId>` (turnKey): its steps, the tool calls they made and how
       * they ended, and when its effort was last asked about and raised.
       */
      midturn: StateFamily<{
        /** Steps the turn has made: the latest step's index + 1. */
        steps: number
        /** The engine's own effort on the latest step; null when the model takes no level (nothing to re-decide). */
        engine: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        /** The step the latest re-decision was asked for; null before the first. */
        askedFor: number | null
        /** The step from which a re-decision last raised the effort; null when none did. */
        raisedAt: number | null
        /** The turn's tool calls that failed (not counting hook blocks and denials). */
        failures: number
        /** The turn's tool calls a hook refused. */
        hookBlocks: number
        /** The latest steps, oldest first (at most 16): the last text written and the tools called, each with how it ended. */
        recent: {
          index: number
          text: string
          tools: { name: string; detail: string; outcome: 'ok' | 'failed' | 'blocked' | 'denied' }[]
        }[]
      }>
      /** The main agent's step in progress (its tool calls carry no turn id); null before the first. */
      mainStep: { turnId: string; index: number } | null
    }
  }
}
