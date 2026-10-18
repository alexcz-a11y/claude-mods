// Feature: the prompt hint. While the person writes a message, the prompt box
// shows after the draft, dimmed, what Dispatch Pilot already knows it will do
// with it (decision/prompt-hint.ts): switched off, the effort locked, a model
// or an effort named for the agents the message may dispatch. The text is
// `virtualText`: drawn only, never in the draft or the message sent.
//
// `prompt.edit` paints it after each edit the person types (its answer carries
// the decorations; 50 ms is all the hook has, so it reads one `$.state` value
// and nothing else). A draft that lands without an edit (`prompt.change`: a
// recalled history entry) carries none, so it is put back in the box once with
// the hint painted on it; the box keeps the same text and the cursor at its end,
// where a recall leaves it.
//
// In a session without a terminal (VS Code, Desktop) the same hint also goes on
// the status line under the prompt (board/status-line.ts), in case the app does
// not draw `virtualText`; the line goes back to the band's once the turn starts.
//
// Its switch is `prompt-hint` (`/dp prompt-hint off`).

import type { EngineInterface, On, PromptDecoration } from 'claude-code'
import { promptHint } from '../decision/prompt-hint.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'
import { hintLineIs, statusLineUsed } from '../board/status-line.ts'

const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const

/** The switch's name, in `/dp`. */
const SWITCH = 'prompt-hint'

/**
 * The decorations that draw the hint after `text`; none when there is nothing to say. Where the session uses the
 * status line, the hint goes on it too.
 */
async function hintDecorations($: EngineInterface, text: string): Promise<PromptDecoration[]> {
  // Off with the mod too, but then the hint says so: the master switch is read on its own.
  const silenced = masterOn() && !isOn(SWITCH)
  const { value: lock = null } = masterOn() && !silenced ? await $.state.get(LOCK) : { value: null }
  const hint = silenced ? null : promptHint(text, { master: masterOn(), lock, agents: isOn('dispatched-agents') || isOn('workflow-agents') || isOn('workflow-labels') })
  if (statusLineUsed()) {
    const update = hintLineIs(hint)
    if (update.changed) $.ui.status(update.line)
  }
  return hint === null ? [] : [{ start: text.length, end: text.length, virtualText: `  ${hint}`, dimColor: true }]
}

export function registerPromptHint(on: On): void {
  defineSwitch({ name: SWITCH, info: 'show after the draft what dp will do with it (dim, never sent)' })

  on('prompt.edit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    const box = await next(e)
    try {
      const mine = await hintDecorations($, box.text)
      return mine.length === 0 ? box : { ...box, decorations: [...(box.decorations ?? []), ...mine] }
    } catch {
      // no hint this time: the box is as the edit left it
      return box
    }
  })

  on('prompt.change', { origin: { kind: 'history' } }, async ($, e, next) => {
    const changed = await next(e)
    try {
      const mine = await hintDecorations($, e.text)
      if (mine.length > 0) await $.prompt.fill({ text: e.text, mode: 'replace', decorations: mine })
    } catch {
      // the recalled draft goes without its hint until the next edit
    }
    return changed
  })
}
