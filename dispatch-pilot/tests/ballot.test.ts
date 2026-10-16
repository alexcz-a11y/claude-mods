// A message's ballot (core/ballot.ts) and the requests it goes out in (core/ask-group.ts). Pure of `$`: the ballot is module state, the
// requests take their engine as closures, so both are called directly.

import { expect, test } from 'claude-code/testing'
import { askGroups, type AskIo } from '../hooks/core/ask-group.ts'
import { collect, contribute } from '../hooks/core/ballot.ts'
import { setup } from '../hooks/core/setup.ts'

const QUESTION = { type: 'noul', instructions: 'Is it?' } as const

test('a part whose settle throws is logged and gives no context; the other parts of the ballot are still handed their outcomes', async () => {
  const debug: string[] = []
  const io: AskIo = {
    backend: { fetch: () => Promise.reject(new Error('no network')), sleep: () => Promise.resolve() },
    now: () => Promise.resolve(0),
    debug: (line) => debug.push(line),
  }
  const settled: string[] = []
  // A part name with a dot is no part: the group's request cannot be built, so nothing is sent and every part is handed a failure.
  const broken = { part: 'bad.part', questions: { q: QUESTION }, settle: () => Promise.reject(new Error('settle blew up')) }
  const fine = {
    part: 'fine',
    questions: { q: QUESTION },
    settle: (outcome: { ok: boolean }) => {
      settled.push(`fine ok=${String(outcome.ok)}`)
      return ['context block']
    },
  }
  const blocks = await askGroups(io, setup({}), { prompt: 'hello', messages: [], groups: [[broken, fine]] })

  expect(blocks).toEqual(['context block'])
  expect(settled).toEqual(['fine ok=false'])
  expect(debug.filter((line) => line.includes('bad.part could not settle its outcome: settle blew up'))).toHaveLength(1)
})

test('a prompt that gets another contribution is the newest of the open ballots: the oldest ballot is the one dropped past the limit', () => {
  const part = (name: string) => ({ part: name, questions: {}, settle: () => undefined })
  contribute('first', part('one'))
  for (let i = 0; i < 31; i++) contribute(`filler ${i}`, part('filler'))
  // 32 contributions are waiting; this one makes 33, and the oldest ballot goes: not the prompt that has just been added to.
  contribute('first', part('two'))

  expect(collect('first').map((one) => one.part)).toEqual(['one', 'two'])
  expect(collect('filler 0')).toEqual([])
  expect(collect('filler 1')).toHaveLength(1)
  for (let i = 1; i < 31; i++) collect(`filler ${i}`)
})
