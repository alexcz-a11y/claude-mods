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
       * The person's own words this turn, masked and clipped, oldest first: the
       * last message they sent while the session was idle, then the ones they
       * typed while its turn ran (at most 8). A dispatched agent's decision reads
       * them as `user_message`.
       */
      said: string[]
      /**
       * Skills the main agent has had described beside a message in this
       * conversation (#10): suggested again, they are only named. Emptied by
       * /compact and /clear.
       */
      skillsShown: string[]
      /**
       * The session's skills (hooks/core/skills.ts `CatalogSkill`), read once
       * per session (#10; #11 and #12 read it too). null: read it again.
       */
      skillCatalog: {
        skills: { name: string; description: string; by: 'model' | 'person'; source: string }[]
      } | null
      /**
       * How the skills feature answered the main agent's skill listing, which
       * the engine keeps for the conversation (#10): `withheld` (with the
       * engine's text), `passed`, or `restored`: withheld, then sent beside a
       * message once the `skills` switch went off. null: not answered in
       * this conversation.
       */
      skillListing: { answered: 'withheld' | 'passed' | 'restored'; text: string } | null
    }
  }
}
