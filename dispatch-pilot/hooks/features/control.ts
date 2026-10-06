// Feature: the person's control over Dispatch Pilot, the `/dp` command.
//
//   /dp                  opens the rationale pane (依据面板), or closes it when open
//   /dp log              opens the same pane (the old habit's name for it)
//   /dp status           what is on, the lock
//   /dp on | off         the whole mod
//   /dp <name> on | off  one feature (each registers its own, core/switches.ts)
//   /dp lock <effort>    hold the main agent at that effort on every step
//   /dp unlock           release it
//   /dp log N            the last N decisions and why, in the conversation
//
// A pane the surface does not place (one that places no panes) is closed again
// at once, and the answer says so (spec #22: no pane left open and waiting).
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
import { decisionLine, LOG_ENTRIES, report, type LogEntry, type SwitchIo } from '../core/report.ts'
import { describeDefaults, type Ctx } from '../core/setup.ts'
import { defineSwitch, isOn, listSwitches, loadOverrides, masterOn, overrides, parseOverrides, setMaster, setSwitch } from '../core/switches.ts'
import { errorText } from '../decision/backend.ts'
import { PANE_COLUMNS, PANE_ID, PANE_TITLE } from '../board/rationale.ts'

const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
/** The switches the person flipped, in $.store. */
const SWITCHES_KEY = 'switches'

export function registerControl(on: On, ctx: Ctx): void {
  defineSwitch({ name: 'signals', info: '把上下文、限额和花费的读数记进 debug log，不参与任何决策' })

  // Under a match-all matcher: other features set themselves up at session start too.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    // The person's switches first: the features beneath read them while the session starts.
    loadOverrides(await $.store.get(SWITCHES_KEY).catch(() => undefined))
    // Which options the decision model's defaults decided (core/setup.ts BACKEND_DEFAULTS).
    $.ui.log(describeDefaults(ctx.config), { to: 'debug' })
    const result = await next(e)
    await $.command
      .register({
        name: 'dp',
        description: 'Dispatch Pilot：依据面板、功能开关、effort 锁定、最近的决定',
        argumentHint: '[log | status | on|off | <name> on|off | lock <effort> | unlock | log N]',
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
    // The screens draw again: they leave out what a feature that is off owns.
    const reporting: SwitchIo = { redraw: () => $.ui.invalidate('ui.render') }
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
        return '（没有保存：本地存储用不了，只在这个会话里有效）'
      }
    }
    try {
      switch (command.kind) {
        case 'pane': {
          // `/dp` toggles; `/dp log` only opens (and asks for the keys again).
          if (command.toggle && (await $.ui.panes()).some((pane) => pane.id === PANE_ID)) {
            await $.ui.close({ id: PANE_ID })
            return { text: '依据面板已关闭' }
          }
          const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true, columns: PANE_COLUMNS })
          if (opened.isPlaced) return { text: '依据面板已打开：p / n 翻看 agent，Esc 关闭' }
          await $.ui.close({ id: PANE_ID })
          return { text: `依据面板没有放出来（${opened.reason}），已经关上；/dp log 10 在对话里列出最近 10 条决定` }
        }
        case 'status': {
          const { value: lock = null } = await $.state.get(LOCK)
          return { text: describeStatus(lock) }
        }
        case 'master':
          setMaster(command.on)
          await report(reporting, { switched: { master: command.on } })
          return { text: `Dispatch Pilot 已${command.on ? '打开' : '关闭'}${await save('master')}` }
        case 'switch': {
          const spec = listSwitches().find((s) => s.name === command.name)
          if (spec === undefined || !setSwitch(command.name, command.on)) {
            const names = listSwitches().map((s) => s.name).join(', ')
            return { text: `没有叫「${command.name}」的开关（现有：${names}）` }
          }
          await report(reporting, { switched: { feature: spec.name, on: command.on } })
          return { text: `${spec.name} 已${command.on ? '打开' : '关闭'}：${spec.info}${await save(spec.name)}` }
        }
        case 'lock': {
          await $.state.set(LOCK, command.effort)
          const inert = masterOn() ? '' : '（Dispatch Pilot 关着：/dp on 才生效）'
          return { text: `主 agent 已锁在 ${command.effort}：每一步都用这一档${inert}；/dp unlock 解除` }
        }
        case 'unlock':
          await $.state.set(LOCK, null)
          return { text: '已解除锁定，effort 回到按决定走' }
        case 'log': {
          const { value: kept = [] } = await $.state.get(DECISIONS)
          return { text: describeDecisions(kept.slice(-command.count)) }
        }
        case 'unknown':
          return { text: `没看懂这条命令。\n${USAGE}` }
      }
    } catch (error) {
      // Always answer: a failing command must not leave the person without a word.
      return { text: `出错了（${errorText(error)}）` }
    }
  })
}

type Control =
  | { kind: 'pane'; toggle: boolean }
  | { kind: 'status' }
  | { kind: 'master'; on: boolean }
  | { kind: 'switch'; name: string; on: boolean }
  | { kind: 'lock'; effort: Effort }
  | { kind: 'unlock' }
  | { kind: 'log'; count: number }
  | { kind: 'unknown' }

/** The words after `/dp`, case and spacing aside. */
function parseControl(args: string): Control {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [first, second] = words
  if (words.length === 0) return { kind: 'pane', toggle: true }
  if (words.length === 1 && first === 'status') return { kind: 'status' }
  if (words.length === 1 && (first === 'on' || first === 'off')) return { kind: 'master', on: first === 'on' }
  if (words.length === 1 && first === 'unlock') return { kind: 'unlock' }
  if (words.length === 2 && first === 'lock' && second === 'off') return { kind: 'unlock' }
  if (words.length === 2 && first === 'lock' && isEffort(second)) return { kind: 'lock', effort: second }
  if (words.length === 1 && first === 'log') return { kind: 'pane', toggle: false }
  if (words.length === 2 && first === 'log' && /^[1-9]\d*$/.test(second ?? '')) return { kind: 'log', count: Math.min(LOG_ENTRIES, Number(second)) }
  if (words.length === 2 && first !== undefined && (second === 'on' || second === 'off')) return { kind: 'switch', name: first, on: second === 'on' }
  return { kind: 'unknown' }
}

const USAGE = `/dp（依据面板） | /dp status | /dp on|off | /dp <功能名> on|off | /dp lock <${EFFORTS.join('|')}> | /dp unlock | /dp log N`

/** `/dp status`'s answer: whether the mod is on, the lock, each feature's switch. */
function describeStatus(lock: Effort | null): string {
  const switches = listSwitches()
  const width = Math.max(0, ...switches.map((s) => s.name.length))
  return [
    `Dispatch Pilot ${masterOn() ? '开着' : '关着'}。effort 锁定：${lock ?? '没有'}。`,
    '功能开关（/dp <功能名> on|off）：',
    ...switches.map((s) => `  ${s.on ? '开' : '关'}  ${s.name.padEnd(width)}  ${s.info}`),
    USAGE,
  ].join('\n')
}

/** `/dp log N`'s answer: the decisions, oldest first, each with its reason. */
function describeDecisions(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return '还没有记下任何决定'
  const header = `最近 ${entries.length} 条决定，最新的在最后`
  return [header, ...entries.map((entry) => `#${entry.n} ${entry.feature}：${decisionLine(entry)}`)].join('\n')
}

/** One measurement as a debug-log line: what the engine reported, `n/a` for what it has no figure for. */
function describeSignals(measure: SessionMeasureInput): string {
  const { context, rateLimits, cost } = measure
  const fill = context.percent === undefined ? `n/a (window ${context.window})` : `${context.percent}% (${context.tokens ?? '?'}/${context.window} tokens)`
  const limits = rateLimits.length === 0 ? 'n/a' : rateLimits.map((limit) => `${limit.kind} ${limit.percentUsed}%${limit.resetsAt === undefined ? '' : ` resets ${limit.resetsAt}`}`).join(', ')
  const spent = cost === undefined ? 'n/a' : `$${cost.usd.toFixed(4)}`
  return `signals: context ${fill}; limits ${limits}; cost ${spent}; changed ${measure.changed.join(', ')}`
}
