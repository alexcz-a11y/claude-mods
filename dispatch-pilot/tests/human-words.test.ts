// What the person reads is Chinese (#32, GLOSSARY): the board's reasons, the decision log, the toast, /dp's answers,
// the failed requests' words. Model names and effort levels are written as /model and /effort write them, and the
// words the model reads stay English (tests/model-facing.test.ts). Seam 2 (the pure words) and seam 1 (what the
// screens and commands say after a real turn).

import { expect, test } from 'claude-code/testing'
import { failureLine, type Failure } from '../hooks/decision/backend.ts'
import { profileWhy } from '../hooks/core/report.ts'
import { jev, world } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

/** Words and abbreviations a person must not meet: an HTTP code's name, a unit, an option's internal name, the old English log words. */
const LEFTOVER = /\b(HTTP|ms|thetaMax|thetaUp|thetaDown|thetaExpected|holdSteps|agentOverride|escalateHaikuTo|kept|written|failed|confidence|decided|pick|unreadable|unreachable|refused|expected|asked|ruled)\b/

test('a failed decision request reads in Chinese, with the decision model named and the number the backend gave', () => {
  const words: [Failure, string][] = [
    [{ kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey' }, 'jev：没有填 typesafeApiKey'],
    [{ kind: 'config', detail: 'no Cloudflare account ID or API token: set cloudflareAccountId and cloudflareApiToken' }, 'jev：没有填 cloudflareAccountId 和 cloudflareApiToken'],
    [{ kind: 'config', detail: 'no Cloudflare API token: set cloudflareApiToken' }, 'jev：没有填 cloudflareApiToken'],
    [{ kind: 'config', status: 401, detail: 'HTTP 401' }, 'jev：密钥被拒绝（状态码 401）'],
    [{ kind: 'timeout', detail: 'no answer in 1500 ms' }, 'jev：1500 毫秒内没有回答'],
    [{ kind: 'timeout', detail: 'no time left for the second request' }, 'jev：没有及时回答'],
    [{ kind: 'network', detail: 'ENOTFOUND' }, 'jev：连不上'],
    [{ kind: 'busy', status: 503, detail: 'HTTP 503' }, 'jev：繁忙（状态码 503）'],
    [{ kind: 'quota', status: 429, detail: 'HTTP 429' }, 'jev：今天的额度用完了'],
    [{ kind: 'http', status: 500, detail: 'HTTP 500' }, 'jev：出错（状态码 500）'],
    [{ kind: 'parse', detail: 'not JSON' }, 'jev：回答读不懂'],
    [{ kind: 'request', detail: 'bad' }, 'jev：请求出错（详见 debug log）'],
  ]
  for (const [failure, text] of words) expect(failureLine('jev', failure)).toBe(text)
})

test('why a skill got no profile reads in Chinese; what the server said of itself is left as it said it', () => {
  expect(profileWhy('empty-reply')).toBe('模型回了空内容')
  expect(profileWhy('aborted')).toBe('请求被中断')
  expect(profileWhy('an API error, HTTP 529 overloaded')).toBe('接口出错（状态码 529 overloaded）')
  expect(profileWhy('an API error, HTTP none ')).toBe('接口出错（状态码 none）')
  expect(profileWhy('something new')).toBe('something new')
})

test('after a decided turn the board, the log and /dp say nothing in English but model names, effort levels and option names the person types', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.6, 0.2, 0.05]) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, effort: 'medium' })

  const board = await w.board()
  const said = [
    ...board.log.flatMap((entry) => [entry.outcome, entry.reason]),
    await w.command('dp', 'status'),
    await w.command('dp', 'log 10'),
    await w.command('dp', 'lock max'),
    await w.command('dp', 'unlock'),
    await w.command('dp', 'main-effort off'),
    await w.command('dp', 'frobnicate'),
  ]
  for (const text of said) expect(text, text).not.toMatch(LEFTOVER)
})

test('a route that failed is Chinese on the toast and on the board', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 503, body: 'overloaded' }) })
  await w.submit('把登录模块重构成三层')
  const main = (await w.board()).main
  expect(main?.why).toBe('jev：繁忙（状态码 503）')
  expect(w.toasts.map((toast) => toast.text)).toEqual(['主 agent 未路由：决策模型繁忙（jev：繁忙（状态码 503））'])
  for (const text of [main?.why ?? '', ...w.toasts.map((toast) => toast.text)]) expect(text).not.toMatch(LEFTOVER)
})
