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
       * Effort decided for the person's message at prompt.submit, waiting for
       * the turn that message starts (core's turn.start takes it); oldest
       * first, at most 16. `effort` null: the decision failed (the turn is
       * still the person's own, so mid-turn re-decisions may route it).
       */
      pending: { text: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null; at: number }[]
      /**
       * One record per turn of each loop, id `<loop>:<turnId>` where loop is
       * `main` or the agentId. The core's turn.step writer sends what it says.
       */
      turns: StateFamily<{
        /** The routed effort: the latest decision; null leaves the engine's. */
        effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        /** No step of the turn goes below it while it holds (forced raises); null for none. */
        floor: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        /** The model to name, for a dispatched or workflow agent only; never sent for main. */
        model: string | null
        /** The text the turn started with (main), redacted and clipped; '' when unknown. */
        prompt: string
        /** Decisions made for the turn: the one at its start plus re-decisions. */
        decisions: number
        /** Times the routed effort moved from one decided level to another. */
        changes: number
        /** Whether the person's own message started the turn (decided at its start or not). */
        person: boolean
        /** The step from which `floor` no longer holds; null: for the rest of the turn. */
        floorUntil: number | null
        /** The step the turn's effort last went up mid-turn (re-decided or forced); null when it has not. */
        raisedAt: number | null
      }>
      /**
       * A plan for every turn of one dispatched or workflow agent, id = agentId
       * (written at agent.spawn, or once the agent is known); a turn-level
       * plan of that agent wins over it slot by slot. `terms`: what the person
       * asked of its work in their own words (the model and the effort they
       * named, the models they ruled out); whatever changes the agent's model
       * or effort keeps to them.
       */
      agents: StateFamily<{
        effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        floor: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        model: string | null
        terms: {
          model: 'haiku' | 'sonnet' | 'opus' | 'fable' | null
          effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
          banned: ('haiku' | 'sonnet' | 'opus' | 'fable')[]
        } | null
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
       * Failed tool calls piling up in one loop (#7), id `main` for the main
       * agent (its counts are those of the turn `turnId`; a new turn starts them
       * afresh) or the agentId of a dispatched or workflow agent (counted for as
       * long as it lives). Written by features/escalation.ts only.
       */
      escalation: StateFamily<{
        /** The main turn the counts belong to; '' for an agent. */
        turnId: string
        /** Tool calls that failed since the loop began (hook blocks and the person's refusals not counted). */
        failures: number
        /** Tool calls a hook refused. */
        hookBlocks: number
        /** What escalating (or deciding the failures were expected) has already dealt with: the counts at that moment. */
        base: { failures: number; hookBlocks: number }
        /** Forced raises so far (an expected-failure verdict is not one). */
        raises: number
        /** The step a stuck re-decision was last made for; null before the first. */
        askedAt: number | null
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
       * The Workflow runs whose agents the workflow-labels feature (#9) routes
       * as each one starts, by the label the run's journal records for it;
       * newest last, at most 8. Written when the run's tool call returns.
       */
      labelRuns: {
        /** The run's id (`runId` of the Workflow tool's result). */
        runId: string
        /** The run's directory (`transcriptDir`): its journal.jsonl, and each agent's transcript. */
        dir: string
        /** The script's `meta` name and description; null when it has none (or could not be read). */
        workflow: string | null
        description: string | null
        /** The script's agent() calls in order; null when the script could not be read: each agent is decided from its own prompt. */
        sites: {
          /** The line the call starts on. */
          line: number
          /** The label as the script writes it (a template keeps its `${...}`); null when it has none, or works it out when it runs. */
          label: string | null
          /**
           * How a label the journal recorded is told to be this call's: `exact` (a string label),
           * `pattern` (a template label, a regular expression's source), `head` (no label: the engine
           * records the prompt's start, `whole` when the prompt is a string), `none` (nothing to tell it by).
           */
          match: { kind: 'exact'; label: string } | { kind: 'pattern'; source: string } | { kind: 'head'; head: string; whole: boolean } | { kind: 'none' }
          /** `set`: decided when the run started; `runtime`: decided from each agent's prompt as it starts; `script`: left as the script says. */
          route:
            | { kind: 'set'; model: 'haiku' | 'sonnet' | 'opus' | 'fable' | null; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null }
            | { kind: 'runtime' }
            | { kind: 'script' }
          /** The call's own `model`, `effort` and `agentType` options, for a decision made as its agents start. */
          model: { kind: 'none' } | { kind: 'literal'; value: string } | { kind: 'dynamic' }
          effort: { kind: 'none' } | { kind: 'literal'; value: string } | { kind: 'dynamic' }
          agentType: string | null
          /** The person's terms for the call's work, as its decision read them; its agents' plans keep them. */
          terms: {
            model: 'haiku' | 'sonnet' | 'opus' | 'fable' | null
            effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
            banned: ('haiku' | 'sonnet' | 'opus' | 'fable')[]
          } | null
        }[] | null
      }[]
      /**
       * What the workflow-agents feature (#8) read of the person's terms for
       * each agent() call of a script the main agent sent inline (by the
       * call's index; null for none), id = the Workflow call's tool_use_id.
       * Written before the tool runs, read by the workflow-labels feature (#9)
       * within the same call, so the agents of the calls #8 wrote into get the
       * terms in their plans as they start.
       */
      workflowTerms: StateFamily<({
        model: 'haiku' | 'sonnet' | 'opus' | 'fable' | null
        effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        banned: ('haiku' | 'sonnet' | 'opus' | 'fable')[]
      } | null)[]>
      /**
       * Skills the main agent has had described beside a message in this
       * conversation (#10): suggested again, they are only named. Emptied by
       * /compact and /clear.
       */
      skillsShown: string[]
      /**
       * The session's skills (hooks/core/skills.ts `CatalogSkill`), read once
       * per session (#10; #11 reads it too). find_skill (#12) reads it, and
       * reads and keeps it itself when the skills feature did not. `file` is
       * the SKILL.md (or command file) found on disk, null when none (a
       * built-in skill); `profileKey` the store key of its profile (#11,
       * core/profiles.ts), `profile` that profile once written (null until
       * then). null: read it again.
       */
      skillCatalog: {
        skills: {
          name: string
          description: string
          by: 'model' | 'person'
          source: string
          file: string | null
          profileKey?: string | null
          profile?: {
            en: { what: string; use_when: string; not_for: string }
            zh: { what: string; use_when: string; not_for: string }
          } | null
        }[]
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
