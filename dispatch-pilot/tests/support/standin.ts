// A stand-in $ for calling flows/readout.ts's openStep and readout directly: the kit raises no http.fetch as the
// engine (its $ has no http, and a plugin named engine does not load: DEVELOPMENT.md). Seeded with the state an
// engine-driven run left (seedOf), it has what the readout touches: $.state with versions (the state library's
// compare-and-set), $.store and $.ui.log; `refuse` and `refuseStore` make a state or store write throw.
import type { Decision } from '../../hooks/log.ts'
import type { SessionState, TurnState } from '../../hooks/state.ts'
import type { world } from './world.ts'

type World = ReturnType<typeof world>

/** The state an engine-driven run left: each state key's last landed value, and $.store's log. */
export function seedOf(w: World): { state: Record<string, unknown>; store: { log: Decision[] } } {
  const state: Record<string, unknown> = {}
  for (const key of ['session', 'turn', 'recent']) {
    const v = w.stateWrites.filter((s) => s.key === key && s.isSet).at(-1)?.value
    if (v !== undefined) state[key] = v
  }
  return { state, store: { log: (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[] } }
}

export function standIn(
  seed: { state?: Record<string, unknown>; store?: Record<string, unknown> } = {},
  o: { refuse?: (key: string, value: unknown) => boolean; refuseStore?: (key: string) => boolean } = {},
) {
  const state = new Map<string, { value: unknown; version: number }>(Object.entries(seed.state ?? {}).map(([k, v]) => [k, { value: v, version: 1 }]))
  const store = new Map<string, unknown>(Object.entries(JSON.parse(JSON.stringify(seed.store ?? {}))))
  const logs: string[] = []
  const writes: { key: string; value: unknown }[] = []
  const $ = {
    ui: { log: (text: string) => void logs.push(text) },
    state: {
      get: async (ref: { key: string }) => state.get(ref.key) ?? { value: undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown, opts?: { ifVersion?: number }) => {
        if (o.refuse?.(ref.key, value)) throw new Error('refused by the test')
        const held = state.get(ref.key) ?? { value: undefined, version: 0 }
        if (opts?.ifVersion !== undefined && opts.ifVersion !== held.version) return { isSet: false, version: held.version }
        state.set(ref.key, { value, version: held.version + 1 })
        writes.push({ key: ref.key, value })
        return { isSet: true, version: held.version + 1 }
      },
    },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        if (o.refuseStore?.(key)) throw new Error('store refused by the test')
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
  }
  const value = (key: string): unknown => state.get(key)?.value
  return {
    $: $ as never,
    logs,
    writes,
    /** What $.store holds now, every key. */
    stored: () => [...store.values()],
    log: () => (store.get('log') ?? []) as Decision[],
    recent: () => (value('recent') ?? []) as Decision[],
    session: () => value('session') as SessionState,
    turn: () => value('turn') as TurnState | null,
    /** Every level written as the session's current one, in order. */
    lastSents: () => writes.filter((x) => x.key === 'session').map((x) => (x.value as SessionState).lastSent),
  }
}
