// The /dp command: its registration at session.start and its answers. Bare, it opens or closes the board's pane, or
// answers with the text version where there is no pane.
import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface } from 'claude-code'

import { PANE_ID, isPaneShown } from '../board/board.tsx'
import type { Config } from '../config.ts'
import { DP_USAGE, badLevelReply, lockReply, parseDp, readLog, renderDp, renderLog, unlockReply } from '../log.ts'
import { LOG, failOpen, redraw } from '../runtime.ts'
import { emptySession } from '../state.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])

// session.start's registration of the command.
export async function registerDp($: EngineInterface): Promise<null> {
  await $.command.register({
    name: 'dp',
    description: 'dispatch-pilot：档位、锁定、后端和最近的决策（lock <档位>、unlock、log [n]）',
    argumentHint: '[lock <档位> | unlock | log [n]]',
  })
  return null
}

const shown = (text: string): CommandRunResult => ({ text, isTextDisplayOnly: true })

// The text version (design 5.9): the level wanted and the one sent, the lock, the backend, the last decisions.
async function textDp($: EngineInterface, cfg: Config): Promise<string> {
  const session = await read($, SESSION)
  const turn = await read($, TURN)
  const wanted = turn?.wanted ?? turn?.base ?? null
  return renderDp({ cfg, wanted, lastSent: session.lastSent, lock: session.lock, log: await read($, RECENT) })
}

// The pane on screen closes; otherwise it opens. One the surface cannot place is closed again, so it does not turn up
// later on its own, and the text version answers. The band is drawn again: with the pane open it has fewer rows.
async function togglePane($: EngineInterface, cfg: Config): Promise<string> {
  if (await isPaneShown($)) {
    await $.ui.close({ id: PANE_ID })
    redraw($)
    return '面板已关上。'
  }
  const opened = await $.ui.open({ id: PANE_ID, title: 'Dispatch Pilot' })
  if (opened.isPlaced) {
    redraw($)
    return '面板已打开。'
  }
  await $.ui.close({ id: PANE_ID })
  return `面板放不出来（${opened.reason}），下面是文字版。\n\n${await textDp($, cfg)}`
}

export async function answerDp($: EngineInterface, cfg: Config, args: string): Promise<CommandRunResult> {
  const c = parseDp(args)
  if (c.kind === 'show') {
    // A pane call that fails answers with the text version all the same.
    const pane = cfg.board ? await failOpen($, 'command.run', null, () => togglePane($, cfg)) : null
    return shown(pane ?? (await textDp($, cfg)))
  }
  if (c.kind === 'lock') {
    await update($, SESSION, (s) => ({ ...s, lock: c.level }))
    redraw($)
    return shown(lockReply(c.level, cfg))
  }
  if (c.kind === 'unlock') {
    const was = (await read($, SESSION)).lock
    if (was !== null) await update($, SESSION, (s) => ({ ...s, lock: null }))
    redraw($)
    return shown(unlockReply(was))
  }
  if (c.kind === 'log') {
    const held = await $.store.get(LOG).then(
      (v) => readLog(v),
      () => null,
    )
    return shown(held === null ? '读不到决策记录（$.store 出错了）。' : renderLog(held, c.n))
  }
  if (c.kind === 'bad-level') return shown(badLevelReply(c.word))
  return shown(DP_USAGE)
}
