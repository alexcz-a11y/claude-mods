// The prompt hint: dim text after the draft in the prompt box (`virtualText`) saying what Dispatch Pilot already knows it
// will do with the message: switched off, the effort locked, a model or an effort named for the agents it may dispatch.
// Seam 1: the person's edits (`prompt.edit`), a recalled draft (`prompt.change`), `/dp` in; the decorations the box is
// answered with and the fills the mod makes out. Plus the pure wording (`promptHint`).

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptChangeInput, PromptDecoration, PromptEditInput, PromptEditResult } from 'claude-code'
import { promptHint } from '../hooks/decision/prompt-hint.ts'
import { KEY, world } from './support/world.ts'

const STATE = { master: true, lock: null, agents: true } as const

test('the hint says only what is known: switched off, the effort locked, a model or an effort named for the agents; nothing for an empty draft or a command', () => {
  expect(promptHint('', STATE)).toBeNull()
  expect(promptHint('   ', STATE)).toBeNull()
  expect(promptHint('/dp lock high', STATE)).toBeNull()
  expect(promptHint('把登录页的错别字改了', STATE)).toBeNull()
  expect(promptHint('把登录页的错别字改了', { ...STATE, master: false })).toBe('dp 已关 · 这条消息不路由')
  expect(promptHint('把登录页的错别字改了', { ...STATE, lock: 'xhigh' })).toBe('dp · effort 锁定 xhigh')
  expect(promptHint('这几个审查都用 Opus 跑，汇总用haiku', STATE)).toBe('dp · 识别 agent 点名：opus、haiku')
  expect(promptHint('effort 开 low 就行', STATE)).toBe('dp · 识别 agent 点名：effort')
  expect(promptHint('用 opus，effort 拉满', { ...STATE, lock: 'high' })).toBe('dp · effort 锁定 high · 识别 agent 点名：opus、effort')
  // A word that only holds a model's name is none.
  expect(promptHint('the opuses and sonnets of Shakespeare', STATE)).toBeNull()
  // With no feature routing agents, a named model changes nothing.
  expect(promptHint('用 opus 跑', { ...STATE, agents: false })).toBeNull()
})

/** The engine beneath the prompt box: an edit spliced as the editor does, the fills and views the mod asks for recorded. */
function box($: Engine, on: On) {
  // The engine raises both as its prompt box changes; the kit's `$` types neither, though it raises them.
  const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult>; change: (e: PromptChangeInput) => Promise<unknown> }
  const fills: { text: string; mode?: string; decorations?: PromptDecoration[] }[] = []
  on('prompt.edit', (_$, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  on('prompt.fill', (_$, e) => {
    fills.push({ text: e.text, mode: e.mode, ...(e.decorations === undefined ? {} : { decorations: e.decorations }) })
    return { isFilled: true }
  })
  on('prompt.change', (_$, e) => ({ text: e.text }))
  return {
    fills,
    /** The person types `typed` at the end of `draft`: resolves to the box the mod answers with. */
    type: (draft: string, typed: string) =>
      prompt.edit({ origin: { kind: 'composer' }, text: draft, cursor: draft.length, start: draft.length, end: draft.length, inputText: typed }),
    /** A history entry is recalled into the box. */
    recall: (text: string) => prompt.change({ text, cursor: text.length, origin: { kind: 'history' } }),
  }
}

test('as the person types, the box is answered with the hint after the draft, dimmed, at its end and never in its text', { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, {})
  await w.submit('先开个头')
  const typed = await b.type('这几个审查都用 opus 跑', '吧')
  expect(typed.text).toBe('这几个审查都用 opus 跑吧')
  expect(typed.decorations).toEqual([{ start: typed.text.length, end: typed.text.length, virtualText: '  dp · 识别 agent 点名：opus', dimColor: true }])
  // Nothing to say: no decoration at all.
  expect((await b.type('把错别字改了', '吧')).decorations).toBeUndefined()
})

test('the lock and the master switch show at once: /dp lock and /dp off are read as the person types the next message', { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, {})
  await w.submit('先开个头')
  await w.command('dp', 'lock xhigh')
  expect((await b.type('把错别字改了', '吧')).decorations?.[0]?.virtualText).toBe('  dp · effort 锁定 xhigh')
  await w.command('dp', 'off')
  expect((await b.type('把错别字改了', '吧')).decorations?.[0]?.virtualText).toBe('  dp 已关 · 这条消息不路由')
})

test('/dp prompt-hint off: no hint while the person types; on brings it back', { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, {})
  await w.submit('先开个头')
  expect(await w.command('dp', 'prompt-hint off')).toContain('prompt-hint 已关闭')
  expect((await b.type('用 opus 跑', '吧')).decorations).toBeUndefined()
  await w.command('dp', 'prompt-hint on')
  expect((await b.type('用 opus 跑', '吧')).decorations).toHaveLength(1)
})

test('a recalled history entry, which no edit carried, is put back in the box once with its hint painted on it; one with nothing to say is left as it is', { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, {})
  await w.submit('先开个头')
  await b.recall('这几个审查都用 opus 跑')
  expect(b.fills).toEqual([
    { text: '这几个审查都用 opus 跑', mode: 'replace', decorations: [{ start: 14, end: 14, virtualText: '  dp · 识别 agent 点名：opus', dimColor: true }] },
  ])
  await b.recall('把错别字改了')
  expect(b.fills).toHaveLength(1)
})
