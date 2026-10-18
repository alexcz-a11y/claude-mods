// The TypeSafe key from the environment (#35): Claude Code Desktop hands a mod no sensitive option, so `typesafeApiKey` arrives
// empty there and `TYPESAFE_API_KEY` stands in, as `PERPLEXITY_API_KEY` does for pplx (pplx-model.test.ts). The options' key
// comes first; the environment's is read at the session start. Seam 1 (engine events in; the requests, the board, the debug
// log and every write to `$.state` out), with `setup()` for the choice it makes (the same ctx the features read).

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { keySource, readConfig, setup, typesafeKey } from '../hooks/core/setup.ts'
import { jev, world, type Reply } from './support/world.ts'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

/** The debug log's line on where Jev's key came from. */
const keyLine = (w: ReturnType<typeof world>) => w.logs.filter((log) => log.text.startsWith('jev key:')).map((log) => log.text)

/** Every value the mod writes to `$.state`, as written: registered before the world, it sees each write on its way down. */
function stateWrites(on: On): string[] {
  const written: string[] = []
  on('state.set', async (_$, e, next) => {
    written.push(JSON.stringify(e.value))
    return next(e)
  })
  return written
}

/** Everything the mod writes that a person or another load can read: the debug log, the board, the toasts, the status row and `$.state`. */
const writtenOut = async (w: ReturnType<typeof world>, state: string[]) => JSON.stringify({ logs: w.logs, board: await w.board(), toasts: w.toasts, statuses: w.statuses, state })

// ---- the choice ----------------------------------------------------------------------------------

test('typesafeKey: the options first, the environment where they are empty, else none; keySource says where it came from, never what', () => {
  const secrets = { perplexityEnvKey: '', typesafeEnvKey: 'env-key' }
  expect(typesafeKey(readConfig({ typesafeApiKey: 'opt-key' }), secrets)).toBe('opt-key')
  expect(typesafeKey(readConfig({}), secrets)).toBe('env-key')
  expect(typesafeKey(readConfig({}), { ...secrets, typesafeEnvKey: '' })).toBe('')
  expect([keySource('opt-key', 'env-key', 'TYPESAFE_API_KEY'), keySource('', 'env-key', 'TYPESAFE_API_KEY'), keySource('', '', 'TYPESAFE_API_KEY')]).toEqual([
    'from the options',
    'from TYPESAFE_API_KEY',
    'not set',
  ])
})

test('a TypeSafe key only in the environment, once read, is the one Jev decides with (the way back from pplx) and takes images with', () => {
  const ctx = setup({})
  expect([ctx.backend.name, ctx.backend.configured, ctx.images]).toEqual(['pplx', false, null])
  ctx.secrets.typesafeEnvKey = 'env-key'
  expect([ctx.backend.name, ctx.backend.configured, ctx.fellBack, ctx.images?.name, ctx.images?.backend.configured, ctx.images?.fellBack]).toEqual(['jev', true, true, 'jev', true, false])

  const asked = setup({ decisionModel: 'jev' })
  expect(asked.backend.configured).toBe(false)
  asked.secrets.typesafeEnvKey = 'env-key'
  expect([asked.backend.name, asked.backend.configured, asked.fellBack]).toEqual(['jev', true, false])
})

// ---- only the environment ------------------------------------------------------------------------

test('only TYPESAFE_API_KEY, with decisionModel jev: Jev is asked with it, the turn goes out at the decided effort, and the key is written nowhere', { options: { decisionModel: 'jev' } }, async ($, on) => {
  const state = stateWrites(on)
  const w = world($, on, { session: true, env: { TYPESAFE_API_KEY: 'env-key-7c1d' }, backend: jev([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
  expect(w.requests[0]?.headers.authorization).toBe('Bearer env-key-7c1d')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
  expect(keyLine(w)).toEqual(['jev key: from TYPESAFE_API_KEY'])
  expect(state.length).toBeGreaterThan(0)
  expect(await writtenOut(w, state)).not.toContain('env-key-7c1d')
})

test('only TYPESAFE_API_KEY and no decisionModel: Jev decides for want of a Perplexity key, as with the key in the options', { options: {} }, async ($, on) => {
  const w = world($, on, { session: true, env: { TYPESAFE_API_KEY: 'env-key' }, backend: jev([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')

  expect(w.requests.map((request) => request.headers.authorization)).toEqual(['Bearer env-key'])
  expect((await w.board()).log.filter((entry) => entry.feature === 'decision-model')).toMatchObject([{ fallbackFor: 'text', outcome: '改用 Jev' }])
  // pplx decides nothing, so there is no line for its key; Jev's says where its key came from.
  expect(w.logs.map((log) => log.text)).not.toContainEqual(expect.stringContaining('pplx key:'))
  expect(keyLine(w)).toEqual(['jev key: from TYPESAFE_API_KEY'])
})

test('a TypeSafe key with spaces around it in the environment is sent without them', { options: { decisionModel: 'jev' } }, async ($, on) => {
  const w = world($, on, { env: { TYPESAFE_API_KEY: '  env-key\n' }, backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.headers.authorization)).toEqual(['Bearer env-key'])
})

test('only TYPESAFE_API_KEY, with pplx deciding on a Perplexity key: images still go to Jev, with the environment key', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const shot = '/shots/home.png'
  const w = world($, on, { session: true, env: { TYPESAFE_API_KEY: 'env-key' }, files: { [shot]: { format: 'png', width: 1200, height: 800 } }, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = await w.visualCheck({ images: [shot], checks: [{ part: 'the title', property: 'is fully visible' }] })

  expect(JSON.stringify(answer.result)).toContain('Visual check of /shots/home.png')
  expect(w.requests.map((request) => `${request.url} ${request.headers.authorization}`)).toEqual([`${JEV_URL} Bearer env-key`])
  // Nothing says images fell back to pplx; both keys' lines are there, each saying only where.
  expect((await w.board()).log.filter((entry) => entry.feature === 'decision-model')).toEqual([])
  expect(w.logs.map((log) => log.text)).toContainEqual('pplx key: from the options')
  expect(keyLine(w)).toEqual(['jev key: from TYPESAFE_API_KEY'])
})

// ---- both ----------------------------------------------------------------------------------------

test('the TypeSafe key in the options wins over the environment when both are set, and neither is written anywhere', { options: { decisionModel: 'jev', typesafeApiKey: 'opt-key-4b2e' } }, async ($, on) => {
  const state = stateWrites(on)
  const w = world($, on, { session: true, env: { TYPESAFE_API_KEY: 'env-key-9f3a' }, backend: jev([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.headers.authorization)).toEqual(['Bearer opt-key-4b2e'])
  expect(keyLine(w)).toEqual(['jev key: from the options'])
  const written = await writtenOut(w, state)
  expect(written).not.toContain('opt-key-4b2e')
  expect(written).not.toContain('env-key-9f3a')
})

// ---- neither -------------------------------------------------------------------------------------

test('no TypeSafe key in the options or the environment, with decisionModel jev: nothing is sent, the turn keeps the engine effort, the board names both places', { options: { decisionModel: 'jev' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: jev([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  expect((await w.board()).main).toMatchObject({
    effort: 'medium',
    routed: false,
    why: 'jev：没有填 typesafeApiKey 或 TYPESAFE_API_KEY',
    failure: { backend: 'jev', kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey or TYPESAFE_API_KEY' },
  })
  expect(keyLine(w)).toEqual(['jev key: not set'])
})

test('only a Perplexity key, and no TypeSafe key anywhere: the decision log says images go to pplx, naming both places for the TypeSafe key', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {} })
  await w.start()
  expect((await w.board()).log.filter((entry) => entry.feature === 'decision-model')).toMatchObject([
    { fallbackFor: 'images', reason: '没有 Jev 的密钥（typesafeApiKey 或环境变量 TYPESAFE_API_KEY），看图改用 pplx，放大复核不可用；补上密钥就用 Jev' },
  ])
  expect(keyLine(w)).toEqual([])
})

// ---- a key echoed back ---------------------------------------------------------------------------

test('a key from the environment that TypeSafe echoes in an error is kept out of the debug log, the board and $.state', { options: { decisionModel: 'jev' } }, async ($, on) => {
  const state = stateWrites(on)
  const refused = (): Reply => ({ status: 400, body: { error: { message: 'bad header Bearer env-key-5e8a', type: 'invalid_request_error' } } })
  const w = world($, on, { session: true, env: { TYPESAFE_API_KEY: 'env-key-5e8a' }, backend: refused })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests[0]?.headers.authorization).toBe('Bearer env-key-5e8a')
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { backend: 'jev' } })
  expect(await writtenOut(w, state)).not.toContain('env-key-5e8a')
})
