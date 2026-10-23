import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { register, SEARCH_STEER } from '../hooks/prefer-search-tools.ts'

const TASK = 'Find where the config is loaded.'

/** The engine at the bottom of agent.spawn: it records the prompt the subagent starts with. */
function engine(on: On) {
  const prompts: string[] = []
  // The matcher (any tool_use_id) lets this stand-in sit beside the mod's own unmatched hook.
  on('agent.spawn', { tool_use_id: /(?:)/ }, (_$, e) => {
    prompts.push(e.prompt)
    return { model: e.parentModel, agentId: `a${prompts.length}` }
  })
  return prompts
}

function spawn(extra: Record<string, unknown> = {}) {
  return {
    tool_use_id: 'toolu_1',
    provider: { plugin: 'engine', tier: 'core' } as const,
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    prompt: TASK,
    description: 'find config',
    subagentType: 'Explore',
    ...extra,
  }
}

test('a subagent starts with the search sentence after its task', async ($, on) => {
  const prompts = engine(on)
  register(on)
  await $.agent.spawn(spawn())
  expect(prompts).toEqual([`${TASK}\n\n${SEARCH_STEER}`])
})

test('a workflow agent gets the sentence too', async ($, on) => {
  const prompts = engine(on)
  register(on)
  await $.agent.spawn(spawn({ subagentType: 'general-purpose', workflow: { runId: 'wf_1', agentIndex: 0 } }))
  expect(prompts).toEqual([`${TASK}\n\n${SEARCH_STEER}`])
})

test('a fork, a resume, a teammate and a task that already has the sentence go on unchanged', async ($, on) => {
  const prompts = engine(on)
  register(on)
  await $.agent.spawn(spawn({ fork: true, subagentType: 'fork' }))
  await $.agent.spawn(spawn({ resume: { agentId: 'a9' } }))
  await $.agent.spawn(spawn({ isTeammate: true, subagentType: 'teammate' }))
  await $.agent.spawn(spawn({ prompt: `${TASK}\n\n${SEARCH_STEER}` }))
  expect(prompts).toEqual([TASK, TASK, TASK, `${TASK}\n\n${SEARCH_STEER}`])
})
