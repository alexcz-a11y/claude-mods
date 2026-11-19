import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs } from '../src/args.mjs'
import { run } from './helpers.mjs'

test('flags and other words are told apart', () => {
  const args = parseArgs(['list', 'extra', '--status', 'done', '--verbose'])
  assert.equal(args.command, 'list')
  assert.deepEqual(args.positional, ['extra'])
  assert.equal(args.flags.status, 'done')
  assert.equal(args.flags.verbose, true)
})

test('an unknown command prints the usage and exits with 1', () => {
  const { code, err } = run(['shelve'])
  assert.equal(code, 1)
  assert.match(err[0], /^usage: readlog/)
})
