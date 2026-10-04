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
        /** The `at` of the last `demand` asked about (each is asked once); null for none. */
        served: number | null
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
      /**
       * A re-decision another feature asks of the mid-turn feature, id
       * `main:<turnId>`: #7 writes one when the turn is stuck. It is asked at
       * the turn's next tool call (or next step) with `trouble` in the
       * decision model's state, and the turn goes at least to `atLeast`
       * whatever the answer (or with no answer). Each `at` (a number the
       * writer increases) is asked once. Written by #7, read by #5.
       */
      demand: StateFamily<{
        /** What has gone wrong, in one English sentence for the decision model: "2 tool calls in a row have failed ...". */
        trouble: string
        /** The lowest level the turn may go at from then on; null for none. */
        atLeast: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        /** Which demand this is: a new value is a new demand. */
        at: number
      }>
      /**
       * The person's own words this turn, masked and clipped, oldest first: the
       * last message they sent while the session was idle, then the ones they
       * typed while its turn ran (at most 8). A dispatched agent's decision reads
       * them as `user_message`.
       */
      said: string[]
      /**
       * The Workflows the workflow-agents feature sent back to the main agent
       * (return mode), as a hash of each one's name and prompts, oldest first,
       * at most 16: a Workflow is sent back once, its second submission runs.
       */
      returned: string[]
      /**
       * What the workflow-agents feature did with each Workflow run, id = the
       * run's id (`runId` of the Workflow tool's result). Written as the tool
       * returns, a few milliseconds before the run's first agent takes a step
       * (16 ms measured on 2.1.289): a reader on that step may find nothing yet.
       */
      workflows: StateFamily<{
        /** Whether model and effort were written into the run's script; the persisted script (`scriptPath`) holds them. */
        rewritten: boolean
        /**
         * When not: why, in a word. `scriptPath`, `name` or `resume` (an input it does not rewrite),
         * `unreadable` (a script it cannot read, or none of whose agent() prompts it can), `failed` (no
         * decision), `second` (return mode: the Workflow was sent back before), `no agents`,
         * `rewrite failed` (the tool refused the rewritten script; the original ran).
         */
        reason: string
        /** The agent() calls it decided, by label (null: the call has none, or its label is built when the script runs). */
        agents: { label: string | null; model: string | null; effort: string | null }[]
        /** The agent() calls it left as the script wrote them. */
        left: number
      }>
      /**
       * Skills the main agent has had described beside a message in this
       * conversation (#10): suggested again, they are only named. Emptied by
       * /compact and /clear.
       */
      skillsShown: string[]
      /**
       * The session's skills (hooks/core/skills.ts `CatalogSkill`), read once
       * per session (#10; #11 reads it too). find_skill (#12) reads it, and
       * reads and keeps it itself when the skills feature did not. null: read
       * it again.
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
