// dispatch-pilot's $.state contract (PluginState), by key. Hand-written and
// committed; `claude plugin validate` checks every $.state read and write
// against it. No top-level export: a contract declares types and nothing else.
//
// The shapes mirror hooks/core/plans.ts (Plan, TurnRecord, PendingDecision) and
// hooks/core/report.ts (Board, BoardNode, LogEntry); tsc checks the two agree
// wherever the hooks read or write these values.

declare module 'claude-code' {
  interface PluginState {
    'dispatch-pilot': {
      /**
       * Effort decided for the person's message at prompt.submit, waiting for
       * the turn that message starts (core's turn.start takes it); oldest
       * first, at most 16. `effort` null: the decision failed (the turn is
       * still the person's own, so mid-turn re-decisions may route it).
       */
      pending: { text: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null; at: number; report?: true }[]
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
       * The board (the 「决定汇报」 module, core/report.ts; GLOSSARY 看板): what
       * every screen of Dispatch Pilot draws from, with `decisionLog` below.
       * Written by that module only (the features hand it decisions, the core
       * hands it readings), read by anything that draws or tests.
       *
       * `turn` counts the main agent's turns the session has started (the
       * module's own `turn.start` hook); the person's first message is turn 1.
       * A decision made before its turn starts is filed under the turn to come
       * (`turn + 1`), so its node is already there when the turn begins.
       *
       * `nodes` are the agents of the latest turns, the current one and the one
       * before it (the band folds a finished turn into one line, so it still
       * needs it); each turn has one node per agent, the main agent's `main`.
       */
      board: {
        turn: number
        /**
         * When the latest turns started (`$.clock.now()`, ms), by turn, as the module's `turn.start` hook saw it:
         * what a node's `t0`, a change's `at` and the band's elapsed time count from. Absent in a board an earlier
         * version wrote.
         */
        starts?: { turn: number; at: number }[]
        /**
         * The readings that changed, oldest first: an agent's model (by family) or effort differing from its
         * previous step's in the same turn. The first reading of a node is no change. Kept for the nodes' turns.
         * Absent in a board an earlier version wrote.
         */
        changes?: {
          /** The turn of the agent's node, and the agent (`main`, or the agentId). */
          turn: number
          id: string
          /** Seconds from the start of that turn to the step that read the change. */
          at: number
          /** The `n` of the last `decisionLog` entry when it was read (0: none yet): the event stream places it after that entry. */
          after: number
          from: { model?: 'haiku' | 'sonnet' | 'opus' | 'fable'; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number }
          to: { model?: 'haiku' | 'sonnet' | 'opus' | 'fable'; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number }
        }[]
        nodes: {
          /** The turn it belongs to. */
          turn: number
          /** `main` for the main agent, else the agentId of a dispatched or Workflow agent. */
          id: string
          kind: 'main' | 'agent' | 'wf'
          /** What the person reads: 主 agent, the agent's name or description, a Workflow agent's label. */
          name: string
          /** `main`, the agent type (`Explore`), or `workflow`. */
          type: string
          /** The model of its latest step, by family; absent before its first step or for a model of no known family. */
          model?: 'haiku' | 'sonnet' | 'opus' | 'fable'
          /** The effort of its latest step as it went out (a level, or the engine's integer budget); absent for a model without effort. */
          effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
          /**
           * `queued`: spawned (or decided for) and no step yet; `running`: its latest step has been read and its loop
           * has not ended; `done`: its loop ended with an answer; `failed`: it ended in an error, a refusal or an
           * interruption (`why` says which).
           */
          state: 'queued' | 'running' | 'done' | 'failed'
          /** Seconds from the start of the turn to the start of the agent (its first step; for a queued agent, its spawn). 0 for the main agent. */
          t0: number
          /** Seconds it ran, as its loop's `turn.complete` reports; absent while it runs. */
          dur?: number
          /** Whether its steps go out as Dispatch Pilot decided (or the person locked); false: as the engine made them (未路由). */
          routed: boolean
          /** The person's lock (`/dp lock`) holds the main agent's effort. */
          locked?: true
          /** Why it is not routed, or failed, in a few words. */
          why?: string
          /** The failed decision request behind `why`, for the rationale card. */
          failure?: {
            backend: string
            kind: 'config' | 'timeout' | 'network' | 'busy' | 'quota' | 'http' | 'parse' | 'request'
            detail: string
            status?: number
          }
          /** The `n` of its decision in `decisionLog`. */
          decision?: number
          /**
           * The main agent's mid-turn re-decisions this turn (midturn-effort): steps made, decisions (the turn's
           * own at its start included), level changes. `late`: the answer for the step is not back; `failure`: the
           * latest request failed. Absent until the turn was re-decided once.
           */
          midturn?: {
            steps: number
            judged: number
            changed: number
            late?: true
            failure?: { backend: string; kind: 'config' | 'timeout' | 'network' | 'busy' | 'quota' | 'http' | 'parse' | 'request'; detail: string; status?: number }
          }
          /** The failed tool calls, hook blocks and forced raises of the agent's loop (escalation); absent while none. `late`: a stuck re-decision is not back. */
          counts?: { failed: number; blocked: number; raised: number; late?: true }
        }[]
      }
      /**
       * What the features decided and why (core/report.ts `reportDecision`;
       * core/decisions.ts for the features not yet migrated), oldest first: the
       * last 20 turns, at most 300 entries. `n` counts the session's entries
       * from 1; it is what `/dp log` and the debug log's `#n` show.
       */
      decisionLog: {
        n: number
        /** The turn it was made for (`board.turn`'s numbering). */
        turn: number
        /** Who decided: the feature's switch name (a report's decision adds ` (agent report)`). */
        feature: string
        /** `main`, or the agentId it was about; absent for an entry of a feature not yet migrated. */
        agent?: string
        tone: 'ok' | 'warn' | 'fail' | 'info'
        /** What was decided, in a few words: `effort high`. */
        outcome: string
        /** What it was about: the start of the message, an agent's label. */
        subject: string
        /** Why: what the decision model said, the rule that applied. */
        reason: string
        /** The decision model's probability of each effort level. */
        probs?: { low: number; medium: number; high: number; xhigh: number; max: number }
        /** The decision model's confidence. */
        conf?: number
        /** The rules' working, step by step (`pickEffort`, `judgeMidturn`): each step names its rule and whether it took effect; the rest of its fields are the rule's own. */
        trace?: { rule: string; applied: boolean; [field: string]: string | number | boolean | null }[]
        /** The model's floor lifted the effort (`from` to `to`, because of `model`). */
        floor?: {
          from: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
          to: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
          model: 'haiku' | 'sonnet' | 'opus' | 'fable'
        }
        /** A mid-turn re-decision: the effort it was at, the level the answer picked, where it ended, and why it did not move (`held`). */
        mid?: {
          current: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
          picked: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
          result: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
          /** The confidence the move needed (thetaUp for a raise, thetaDown for a lowering); absent while the lowering was held, and when the answer was the level itself. */
          threshold?: number
          /** Why a lowering did not happen: it was held after a raise. */
          held?: string
          /** The steps still to wait before a held lowering may go through. */
          remaining?: number
        }
        /** A raise the failures forced (escalation): what it went from and to (levels, or for a haiku agent models), and the level it keeps the agent at least at. */
        forced?: { kind: 'effort' | 'model'; from: string; to: string; floor?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
        /** The skills a message or a find_skill call got: those suggested to the main agent, and those only the person can start (「可试 /x」), each with its relevance. */
        skills?: { suggest: { name: string; relevance: number }[]; try: { name: string; relevance: number }[] }
        /** The loop's counts when it was raised (escalation). */
        counts?: { failed: number; blocked: number; raised: number }
      }[]
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
