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
       * they ended, and when its effort was last asked about.
       */
      midturn: StateFamily<{
        /** Steps the turn has made: the latest step's index + 1. */
        steps: number
        /** The engine's own effort on the latest step; null when the model takes no level (nothing to re-decide). */
        engine: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        /** The step the latest re-decision was asked for; null before the first. */
        askedFor: number | null
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
       * Each loop's failed tool calls and forced raises (#7), id `main` for the
       * main agent (its counts are those of the turn `turnId`; a new turn starts
       * them afresh) or the agentId of a dispatched or workflow agent (counted
       * for as long as it lives). The one count of failures: the mid-turn
       * re-decision (#5) sends the main agent's in its counts. Written by
       * features/escalation.ts only.
       */
      escalation: StateFamily<{
        /** The main turn the counts belong to; '' for an agent. */
        turnId: string
        /** Tool calls that failed since the loop began (hook blocks and the person's refusals not counted). */
        failures: number
        /** Tool calls a hook refused. */
        hookBlocks: number
        /** The counts when they last started over (a forced raise, failures found expected, nothing left to raise): what is counted is the rest. */
        base: { failures: number; hookBlocks: number }
        /** Forced raises so far (an expected-failure verdict is not one). */
        raises: number
        /** The loop's latest step, the engine's effort and model on it: what a stuck re-decision asked as a call ends reads. */
        step: number | null
        engine: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        model: string | null
        /** The step a stuck re-decision was last asked for; null before the first. */
        askedFor: number | null
        /** An agent's step at its latest forced raise (the main agent's is its turn's `raisedAt`); null before one. */
        raisedAt: number | null
        /** The escalation switch was off when the loop was last seen: what was counted meanwhile is written off once it is on. */
        paused: boolean
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
       * The directories of the session's Workflow runs, as the escalation
       * feature (#7) notes them when a run's tool call returns (newest last, at
       * most 8), whatever the other features' switches say: it reads a workflow
       * agent's transcript there (the engine keeps it from `$.session.messages`).
       */
      workflowRuns: {
        /** The run's id (`runId` of the Workflow tool's result). */
        runId: string
        /** The run's directory (`transcriptDir`): its journal.jsonl, and each agent's transcript. */
        dir: string
      }[]
      /**
       * The Workflow runs of the session, as the workflow-labels feature (#9)
       * records them when the run's tool call returns (newest last, at most 8):
       * it routes their agents as each one starts, by the label the run's
       * journal records for it.
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
       * per session by the skills feature (#10). The skill-profiles feature
       * (#11, features/skill-profiles.ts) reads it and puts each profile in
       * as it is written. find_skill (#12) reads it, and reads and keeps it
       * itself when the skills feature did not. `file` is the SKILL.md (or
       * command file) found on disk, null when none (a built-in skill);
       * `profileKey` the store key of its profile (core/profiles.ts),
       * `profile` that profile once written (null until then). null: read it
       * again.
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
