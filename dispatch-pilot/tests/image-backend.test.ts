// Which decision model takes images (#56, ADR 0008), beside the one that decides everything else (decision-model.test.ts):
// Jev when there is a TypeSafe key; else pplx when there is a Perplexity key, and the decision log says once that it looks
// at images with pplx now and cannot zoom; else none, and the features that need images are unavailable. What the person
// chose as `decisionModel` does not move it. Seam 1 for the log, `setup()` for the choice (the same ctx the features read).

import { expect, test } from 'claude-code/testing'
import { chooseImageBackend, setup } from '../hooks/core/setup.ts'
import { world } from './support/world.ts'

const keys = (perplexity: string, typesafe: string) => ({ perplexity, typesafe })

test('chooseImageBackend: Jev with a TypeSafe key, whatever else there is; else pplx with a Perplexity key (a fall back); else none', () => {
  expect(chooseImageBackend(keys('p', 't'))).toEqual({ backend: 'jev', fellBack: false })
  expect(chooseImageBackend(keys('', 't'))).toEqual({ backend: 'jev', fellBack: false })
  expect(chooseImageBackend(keys('p', ''))).toEqual({ backend: 'pplx', fellBack: true })
  expect(chooseImageBackend(keys('', ''))).toBeNull()
})

test('the ctx gives the features the image backend beside the decision backend, and neither moves the other', () => {
  const both = setup({ decisionModel: 'pplx', perplexityApiKey: 'p-key', typesafeApiKey: 't-key' })
  expect([both.backend.name, both.images?.name, both.images?.backend.name, both.images?.fellBack]).toEqual(['pplx', 'jev', 'jev', false])

  const jevChosenPplxKey = setup({ decisionModel: 'jev', perplexityApiKey: 'p-key' })
  expect([jevChosenPplxKey.backend.name, jevChosenPplxKey.images?.name, jevChosenPplxKey.images?.fellBack]).toEqual(['jev', 'pplx', true])

  const none = setup({})
  expect([none.backend.name, none.images]).toEqual(['pplx', null])
})

test('a Perplexity key that is only in the environment, read at the session start, is found too', () => {
  const ctx = setup({})
  expect(ctx.images).toBeNull()
  ctx.secrets.perplexityEnvKey = 'env-key'
  expect([ctx.images?.name, ctx.images?.fellBack]).toEqual(['pplx', true])
})

/** The decision log's entries about the decision model. */
const about = async (w: ReturnType<typeof world>) => (await w.board()).log.filter((entry) => entry.feature === 'decision-model')

test('only a Perplexity key: the decision log says once that images go to pplx now and zooming is not available', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  await w.start() // a hot reload

  const [entry, ...more] = await about(w)
  expect(more).toEqual([])
  expect(entry).toMatchObject({ tone: 'info', fallbackFor: 'images', outcome: '看图改用 pplx', reason: '没有 Jev 的密钥（typesafeApiKey），看图改用 pplx，放大复核不可用；补上密钥就用 Jev' })
  expect(JSON.stringify({ logs: w.logs, board: await w.board() })).not.toContain('pplx-test-key')
})

test('a Perplexity key from the environment gives the same entry', { options: {} }, async ($, on) => {
  const w = world($, on, { session: true, env: { PERPLEXITY_API_KEY: 'env-key' } })
  await w.start()
  expect(await about(w)).toMatchObject([{ outcome: '看图改用 pplx' }])
})

test('with a TypeSafe key images go to Jev: nothing to say, whether or not there is a Perplexity key', { options: { typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  expect(await about(w)).toEqual([])
})

test('with only a TypeSafe key the entry is the one for the decision model (Jev decides), not for images', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {} })
  await w.start()
  expect(await about(w)).toMatchObject([{ fallbackFor: 'text', outcome: '改用 Jev' }])
})

test('no key of either kind: images are unavailable, and the debug log says so (no entry: nothing changed for the person)', { options: {} }, async ($, on) => {
  const w = world($, on, { session: true, env: {} })
  await w.start()
  expect(await about(w)).toEqual([])
  expect(w.logs.map((log) => log.text)).toContain('images: no decision model takes them (no TypeSafe or Perplexity key)')
})
