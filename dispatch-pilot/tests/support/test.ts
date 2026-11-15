// The kit's `test` with dispatch-pilot-extras loaded beside the mod (support/extras.ts), as it is in a session with
// both plugins installed: every test file takes its `test` from here. A test of a session without the other plugin (a
// Code Mode session) takes the kit's own `test`, which loads the mod alone.

import { test as kitTest, type TestBody, type TestOptions } from 'claude-code/testing'
import { EXTRAS } from './extras.ts'

export const test = (name: string, ...rest: readonly [body: TestBody] | readonly [options: TestOptions, body: TestBody]): void => {
  const [options, body] = rest.length === 1 ? [{} as TestOptions, rest[0]] : rest
  kitTest(name, { ...options, plugins: [EXTRAS, ...(options.plugins ?? [])] }, body)
}
