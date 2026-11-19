// Inline plugins the tests load beside the mod (an inline plugin's register is loaded again from its source, so it
// may reference nothing outside itself), and the helper that sends a request through one of them.
import type { Engine, Plugin } from 'claude-code/testing'

/**
 * Sits above every mod (prepend) and answers each request with what next.trace says of the links beneath it: the
 * plugins whose hooks ran (x-links), and whether every one of them received the same request (x-same).
 */
export const WATCHER: Plugin = {
  name: 'fetch-watcher',
  tier: 'prepend',
  register(on) {
    on('http.fetch', async (_$, e, next) => {
      // A $ call's chain answers { value } or { deny }.
      const r = await next(e)
      const v = r.value
      if (v === undefined) return r
      const received = next.trace.map((t) => JSON.stringify(t.received))
      const same = received.every((x) => x === received[0])
      return { value: { ...v, headers: { ...v.headers, 'x-links': next.trace.map((t) => t.plugin).join(','), 'x-same': String(same) } } }
    })
  },
}

/** Sends the request a test names ({ url, init } in the args) from its own $: the kit's own $ has no http. */
export const WIRE: Plugin = {
  name: 'wire',
  register(on) {
    on('command.run', { command: 'wire' }, async ($, e) => {
      const r = JSON.parse(e.args)
      return { text: JSON.stringify(await $.http.fetch(r.url, r.init)) }
    })
  },
}

export async function viaWire($: Engine, url: string, i?: unknown): Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }> {
  const r = await $.command.run({ command: 'wire', args: JSON.stringify({ url, init: i }), origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}
