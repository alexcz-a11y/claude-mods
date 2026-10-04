// Feature: the person's control over Dispatch Pilot, the `/dp` command.
//
//   /dp                  what is on, the lock
//   /dp on | off         the whole mod
//   /dp <name> on | off  one feature (each registers its own, core/switches.ts)
//   /dp lock <effort>    hold the main agent at that effort on every step
//   /dp unlock           release it
//   /dp log [N]          the last N decisions and why (10 by default)
//
// What the person flips is kept in $.store and loaded back at session start.
// The engine puts the plugin's name before a command's answer, so the texts
// here do not start with one.
//
// It also records what the engine measures of the session (context fill, limit
// percentages, cost) in the debug log. Only recorded: nothing reads them to
// decide anything (spec, 可见性与控制; a later quota-saving mode may).

import type { On, SessionMeasureInput } from 'claude-code'
import { EFFORTS, isEffort, type Effort } from '../decision/effort.ts'
import { decisionLine, MAX_DECISIONS, type DecisionEntry } from '../core/decisions.ts'
import type { Ctx } from '../core/setup.ts'
import { pauseStatus, setStatus } from '../core/status.ts'
import { defineSwitch, isOn, listSwitches, loadOverrides, masterOn, overrides, parseOverrides, setMaster, setSwitch } from '../core/switches.ts'

const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
/** The switches the person flipped, in $.store. */
const SWITCHES_KEY = 'switches'

export function registerControl(on: On, _ctx: Ctx): void {
  defineSwitch({ name: 'signals', info: 'records context, limit and cost readings in the debug log; no decision uses them' })

  // Under a match-all matcher: other features set themselves up at session start too.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    // The person's switches first: the features beneath read them while the session starts.
    loadOverrides(await $.store.get(SWITCHES_KEY).catch(() => undefined))
    const result = await next(e)
    if (!masterOn()) pauseStatus(true, (line) => $.ui.status(line))
    await $.command
      .register({
        name: 'dp',
        description: 'Dispatch Pilot: switches, effort lock, recent decisions',
        argumentHint: '[on|off | <name> on|off | lock <effort> | unlock | log [N]]',
        immediate: true,
      })
      .catch((error) => $.ui.log(`/dp was not registered: ${errorText(error)}`, { to: 'debug' }))
    return result
  })

  // `window` is in every measurement: a matcher on a field that is always there.
  on('session.measure', { context: { window: /(?:)/ } }, async ($, e, next) => {
    if (isOn('signals')) {
      try {
        $.ui.log(describeSignals(e), { to: 'debug' })
      } catch {
        // a reading that cannot be written down is skipped
      }
    }
    return next(e)
  })

  on('command.run', { command: 'dp' }, async ($, e) => {
    const command = parseControl(e.args)
    const show = (line: string | undefined) => $.ui.status(line)
    // Keeps one switch as the person just flipped it, beside whatever another session saved meanwhile;
    // says so when it cannot.
    const save = async (name: string) => {
      try {
        const saved = parseOverrides(await $.store.get(SWITCHES_KEY))
        const now = overrides()[name]
        if (now === undefined) delete saved[name]
        else saved[name] = now
        await $.store.set(SWITCHES_KEY, saved)
        return ''
      } catch {
        return ' (not saved: the store is unavailable, so this lasts until the session ends)'
      }
    }
    try {
      switch (command.kind) {
        case 'status': {
          const { value: lock = null } = await $.state.get(LOCK)
          return { text: describeStatus(lock) }
        }
        case 'master':
          setMaster(command.on)
          pauseStatus(!command.on, show)
          return { text: `Dispatch Pilot is ${command.on ? 'on' : 'off'}${await save('master')}` }
        case 'switch': {
          const spec = listSwitches().find((s) => s.name === command.name)
          if (spec === undefined || !setSwitch(command.name, command.on)) {
            const names = listSwitches().map((s) => s.name).join(', ')
            return { text: `no switch named "${command.name}" (switches: ${names})` }
          }
          if (!command.on) for (const segment of spec.segments) setStatus(segment, null, show)
          return { text: `${spec.name} is ${command.on ? 'on' : 'off'} (${spec.info})${await save(spec.name)}` }
        }
        case 'lock': {
          await $.state.set(LOCK, command.effort)
          const inert = masterOn() ? '' : ' (Dispatch Pilot is off: /dp on to apply it)'
          return { text: `the main agent is locked at ${command.effort} effort on every step${inert}; /dp unlock releases it` }
        }
        case 'unlock':
          await $.state.set(LOCK, null)
          return { text: 'unlocked, effort goes back to the decisions' }
        case 'log': {
          const { value: kept = [] } = await $.state.get(DECISIONS)
          return { text: describeDecisions(kept.slice(-command.count)) }
        }
        case 'unknown':
          return { text: `not understood.\n${USAGE}` }
      }
    } catch (error) {
      // Always answer: a failing command must not leave the person without a word.
      return { text: `failed (${errorText(error)})` }
    }
  })
}

type Control =
  | { kind: 'status' }
  | { kind: 'master'; on: boolean }
  | { kind: 'switch'; name: string; on: boolean }
  | { kind: 'lock'; effort: Effort }
  | { kind: 'unlock' }
  | { kind: 'log'; count: number }
  | { kind: 'unknown' }

/** How many decisions `/dp log` shows when not told. */
const DEFAULT_LOG = 10

/** The words after `/dp`, case and spacing aside. */
function parseControl(args: string): Control {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [first, second] = words
  if (words.length === 0 || (words.length === 1 && first === 'status')) return { kind: 'status' }
  if (words.length === 1 && (first === 'on' || first === 'off')) return { kind: 'master', on: first === 'on' }
  if (words.length === 1 && first === 'unlock') return { kind: 'unlock' }
  if (words.length === 2 && first === 'lock' && second === 'off') return { kind: 'unlock' }
  if (words.length === 2 && first === 'lock' && isEffort(second)) return { kind: 'lock', effort: second }
  if (words.length === 1 && first === 'log') return { kind: 'log', count: DEFAULT_LOG }
  if (words.length === 2 && first === 'log' && /^[1-9]\d*$/.test(second ?? '')) return { kind: 'log', count: Math.min(MAX_DECISIONS, Number(second)) }
  if (words.length === 2 && first !== undefined && (second === 'on' || second === 'off')) return { kind: 'switch', name: first, on: second === 'on' }
  return { kind: 'unknown' }
}

const USAGE = `/dp on|off | /dp <name> on|off | /dp lock <${EFFORTS.join('|')}> | /dp unlock | /dp log [N]`

/** `/dp`'s answer: whether the mod is on, the lock, each feature's switch. */
function describeStatus(lock: Effort | null): string {
  const switches = listSwitches()
  const width = Math.max(0, ...switches.map((s) => s.name.length))
  return [
    `Dispatch Pilot is ${masterOn() ? 'on' : 'off'}. Effort lock: ${lock ?? 'none'}.`,
    'Switches (/dp <name> on|off):',
    ...switches.map((s) => `  ${s.on ? 'on ' : 'off'}  ${s.name.padEnd(width)}  ${s.info}`),
    USAGE,
  ].join('\n')
}

/** `/dp log`'s answer: the decisions, oldest first, each with its reason. */
function describeDecisions(entries: readonly DecisionEntry[]): string {
  if (entries.length === 0) return 'no decisions recorded yet'
  const header = `the last ${entries.length === 1 ? 'decision' : `${entries.length} decisions`}, newest last`
  return [header, ...entries.map((entry) => `#${entry.n} ${entry.feature}: ${decisionLine(entry)}`)].join('\n')
}

/** One measurement as a debug-log line: what the engine reported, `n/a` for what it has no figure for. */
function describeSignals(measure: SessionMeasureInput): string {
  const { context, rateLimits, cost } = measure
  const fill = context.percent === undefined ? `n/a (window ${context.window})` : `${context.percent}% (${context.tokens ?? '?'}/${context.window} tokens)`
  const limits = rateLimits.length === 0 ? 'n/a' : rateLimits.map((limit) => `${limit.kind} ${limit.percentUsed}%${limit.resetsAt === undefined ? '' : ` resets ${limit.resetsAt}`}`).join(', ')
  const spent = cost === undefined ? 'n/a' : `$${cost.usd.toFixed(4)}`
  return `signals: context ${fill}; limits ${limits}; cost ${spent}; changed ${measure.changed.join(', ')}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
