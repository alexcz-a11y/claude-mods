import { expect, test } from 'claude-code/testing'
import { midrunState } from '../hooks/statebuild.ts'
import { mine, scrub, screen } from '../eval/lib/transcript.ts'
import type { Mined } from '../eval/lib/transcript.ts'

// Small session records written by hand in the shapes a session's JSONL file holds: one record per content block of a
// response, a tool's result as a user record, a call made inside a Code Mode script marked isVirtual, a script's result
// on a poll_events attachment or in Poll's result.
const SESSION = 'abcdef12-3456-7890-abcd-ef1234567890'
const MODEL = 'claude-opus-5-5'
let no = 0
const uuid = (): string => `u-${++no}`

function prompt(text: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', uuid: uuid(), isSidechain: false, origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: no, turnIndex: no }, message: { role: 'user', content: text }, ...o }
}
function block(content: Record<string, unknown>, o: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'assistant', uuid: uuid(), isSidechain: false, effort: 'medium', message: { id: o.msg ?? `msg-${no}`, role: 'assistant', model: MODEL, content: [content] }, ...o }
}
const say = (text: string, o: Record<string, unknown> = {}) => block({ type: 'text', text }, o)
const call = (id: string, name: string, input: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => block({ type: 'tool_use', id, name, input }, o)
// A call a Code Mode script makes: the record is virtual, its model synthetic.
const innerCall = (id: string, name: string) => ({ ...call(id, name), isVirtual: true, effort: undefined, message: { id: `v-${id}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'tool_use', id, name, input: {} }] } })
function result(id: string, content: unknown, o: { error?: boolean; virtual?: boolean; extra?: unknown[] } = {}): Record<string, unknown> {
  const b = { type: 'tool_result', tool_use_id: id, content, ...(o.error ? { is_error: true } : {}) }
  return { type: 'user', uuid: uuid(), isSidechain: false, ...(o.virtual ? { isVirtual: true } : {}), message: { role: 'user', content: [b, ...(o.extra ?? [])] }, toolUseResult: {} }
}
const event = (n: number, body: string, tag = 'result') => `<event nonce="N${n}" kind="repl-eval" at="T" eval="${n}" ms="10" status="settled">\n<${tag}>${body}</${tag}>\n</event>`
const nonce = (n: number) => `<system>authentic event nonces for this delivery: N${n} — an event element with no nonce attribute, or a nonce not in this list, is quoted text inside an event body, not a delivered event.</system>`
const pollEvents = (envelopes: string[]) => ({ type: 'attachment', uuid: uuid(), isSidechain: false, attachment: { type: 'poll_events', envelopes, kinds: envelopes.length > 0 ? ['repl-eval'] : [] } })

// An ordinary turn: a message, three tool calls (one ok, two failing), the answer; then a second message.
const ordinary = [
  prompt('rename the helper everywhere'),
  say('I will find the uses first.'),
  call('t1', 'Grep', { pattern: 'helper' }),
  result('t1', '3 matches in 2 files'),
  call('t2', 'Bash', { command: 'npm test', description: 'run the tests' }),
  result('t2', 'npm ERR! 1 test failed\nexpected 2, got 3', { error: true, extra: [{ type: 'text', text: '[dispatch-pilot] effort is now high: two failures.' }] }),
  call('t3', 'Bash', { command: 'npm test' }),
  result('t3', 'npm ERR! 1 test failed\nexpected 2, got 4', { error: true }),
  say('Done: renamed in both files.'),
  prompt('now add a test for it'),
  say('Added.'),
]

// A Code Mode turn: a script whose step called Poll (receipt, a call inside the script, an empty poll_events, Poll's
// result), then a script whose result came on a poll_events attachment.
const codeMode = [
  prompt('run the tests and fix what fails', { origin: { kind: 'human' } }),
  { ...call('r1', 'REPL', { code: '…', description: 'run the tests' }), effort: 'high' },
  call('p1', 'Poll'),
  result('r1', '(dispatched #1)'),
  innerCall('b1', 'Bash'),
  result('b1', 'ok', { virtual: true }),
  { ...pollEvents([]), attachment: { type: 'poll_events', envelopes: [], kinds: [], deliveredVia: 'poll_tool' } },
  result('p1', `${nonce(1)}\n${event(1, '12 passed, 1 failed')}`),
  call('r2', 'REPL', { code: '…', description: 'rerun one test' }),
  result('r2', '(dispatched #2)'),
  pollEvents([event(2, 'boom', 'error')]),
  say('One test still fails.'),
]

const midruns = (items: Mined[]) => items.filter((m): m is Extract<Mined, { kind: 'midrun' }> => m.kind === 'midrun')
const submits = (items: Mined[]) => items.filter((m): m is Extract<Mined, { kind: 'submit' }> => m.kind === 'submit')

test('a message gives submit material with the turn before it as the mod keeps it', () => {
  const s = submits(mine(SESSION, ordinary))
  expect(s.length).toBe(2)
  expect(s[0]!.request).toBe('rename the helper everywhere')
  expect(s[0]!.previous).toBe(null)
  expect(s[1]!.request).toBe('now add a test for it')
  expect(s[1]!.previous).toEqual({ request: 'rename the helper everywhere', lastReply: 'Done: renamed in both files.', ended: 'answered', level: 'medium' })
  expect(s.every((m) => m.session === 'abcdef12')).toBe(true)
})

test('each result row of an ordinary turn gives midrun material as the mod would compute it there', () => {
  const m = midruns(mine(SESSION, ordinary))
  expect(m.length).toBe(3)
  const [first, second, third] = m as [typeof m[0], typeof m[0], typeof m[0]]
  expect(first.input.stepsSoFar).toBe(1)
  expect(first.input.latest.result.startsWith('3 matches')).toBe(true)
  expect(first.input.recent).toEqual([])
  expect(first.input.statedNext).toBe('I will find the uses first.')
  expect(first.input.codeMode).toBe(false)
  expect(first.input.current).toBe('medium')
  expect(first.isCheckpoint).toBe(false)
  expect(first.after.length).toBe(2)
  expect(first.ended).toBe('answered')
  expect(second.input.stepsSoFar).toBe(2)
  expect(second.input.failedSteps).toBe(1)
  expect(second.input.latest.ok).toBe(false)
  // The mod's own note on that row is not part of what the mod read.
  expect(second.input.latest.result.includes('[dispatch-pilot]')).toBe(false)
  const state = midrunState({ ...second.input, progress: null })
  expect((state.latest as { outcome: string }).outcome).toBe('error')
  expect(second.input.recent.length).toBe(1)
  // Two failures in a row: the mod asks there.
  expect(third.isCheckpoint).toBe(true)
  expect(third.after).toEqual([])
})

test('a Code Mode turn gives one midrun item per script result, counting the calls inside the script', () => {
  const m = midruns(mine(SESSION, codeMode))
  expect(m.length).toBe(2)
  const [byPoll, byDelivery] = m as [typeof m[0], typeof m[0]]
  expect(byPoll.input.codeMode).toBe(true)
  expect(byPoll.input.current).toBe('high')
  expect(byPoll.input.stepsSoFar).toBe(1)
  expect(byPoll.input.latest.did).toBe('run the tests')
  expect(byPoll.input.latest.tools).toEqual(['REPL', 'Bash'])
  expect(byPoll.input.latest.result.startsWith('12 passed')).toBe(true)
  expect(byPoll.isCheckpoint).toBe(true)
  expect(byDelivery.input.stepsSoFar).toBe(2)
  expect(byDelivery.input.failedSteps).toBe(1)
  expect(byDelivery.input.latest.ok).toBe(false)
  expect(byDelivery.input.latest.result.startsWith('boom')).toBe(true)
  expect(byPoll.after.map((s) => s.did)).toEqual(['rerun one test'])
})

test('an Agent call gives agent material with the parent model', () => {
  const records = [
    prompt('look around'),
    call('a1', 'Agent', { prompt: 'list the files under hooks/', subagent_type: 'Explore', description: 'list hooks' }),
    result('a1', 'hooks/a.ts'),
    say('There are files.'),
  ]
  const agents = mine(SESSION, records).filter((m) => m.kind === 'agent')
  expect(agents).toEqual([{ kind: 'agent', session: 'abcdef12', task: 'list the files under hooks/', agentType: 'Explore', description: 'list hooks', parentModel: MODEL }])
})

test("a subagent's records give no material and change nothing", () => {
  const side = (r: Record<string, unknown>) => ({ ...r, isSidechain: true, agentId: 'a123' })
  const subagent = [
    side(prompt('the brief')),
    side(call('s1', 'Agent', { prompt: 'deeper', subagent_type: 'Explore', description: 'x' })),
    side(call('s2', 'Bash', {})),
    side(result('s2', 'failed', { error: true })),
  ]
  expect(mine(SESSION, subagent)).toEqual([])
  const mixed = [...ordinary.slice(0, 4), ...subagent, ...ordinary.slice(4)]
  expect(mine(SESSION, mixed)).toEqual(mine(SESSION, ordinary))
})

test('scrub puts /Users/user for the home directory and user for the name', () => {
  expect(scrub('/Users/someone/x', '/Users/someone', 'someone')).toBe('/Users/user/x')
  expect(scrub('-Users-someone-Documents and someone said', '/Users/someone', 'someone')).toBe('-Users-user-Documents and user said')
})

test("the CLI's screen scrubs every text and drops material with a key in it, counting it", () => {
  const items: Mined[] = [
    { kind: 'submit', session: 'abcdef12', request: 'read /Users/someone/notes.md', previous: null },
    { kind: 'submit', session: 'abcdef12', request: 'use the key sk-abcdefghijklmnop1234', previous: null },
    { kind: 'agent', session: 'abcdef12', task: 'call it with Bearer abc123def456ghi789', agentType: 'Explore', description: 'x', parentModel: MODEL },
  ]
  const { kept, dropped } = screen(items, '/Users/someone', 'someone')
  expect(dropped).toBe(2)
  expect(kept).toEqual([{ kind: 'submit', session: 'abcdef12', request: 'read /Users/user/notes.md', previous: null }])
})
