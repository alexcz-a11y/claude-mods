// What image routing shows (#63): the rationale card of a decision made with a complexity reading says what the images read as, how
// many images it came from, and that it is only a hint. Seam 1: the board data and the pane mounted through the mod.

import { expect, test } from 'claude-code/testing'
import type { PastedImage } from './support/pasted.ts'
import { jev, world } from './support/world.ts'

const JEV = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }
const at = (level: number): number[] => [0, 1, 2, 3, 4].map((i) => (i === level ? 1 : 0))
const SCENE: PastedImage = { path: '/refs/scene.png', shown: { format: 'png', width: 2000, height: 1333, label: 'shown-scene' } }
const FILES = { '/refs/scene.png': { format: 'png' as const, width: 3000, height: 2000, label: 'scene' } }

type Drawn = { type?: string; key?: string | undefined; props?: Record<string, unknown>; children?: unknown[] }

/** What a drawn element shows: its descendants' text in order. */
function shown(element: unknown): string {
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (element === null || typeof element !== 'object') return ''
  const { children = [], props = {} } = element as Drawn
  const kids = Array.isArray(props.children) ? props.children : children
  return kids.map(shown).join('')
}

test("the card of a decision made with a reading says the level, the words for it and how many images it came from; it is a hint, the level of the effort is still the decision model's", { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: { 'image-routing': true }, files: FILES, process: true, backend: jev(at(1), { scores: { 'complexity.level': at(3), 'effort.level': at(2) } }) })
  await w.submit('Build this scene in three.js', { images: [SCENE] })
  await w.step({ index: 0 })

  const ui = await w.pane()
  const card = shown(await ui.find({ key: 'pane-card-reference' }))
  expect(card).toContain('参考图')
  expect(card).toContain('3/4')
  expect(card).toContain('较复杂')
  expect(card).toContain('1 张图')
  expect(card).toContain('只作提示')
})

test('a decision made without a reading has no row for it: a message without images, and one whose images could not be read', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: { 'image-routing': true }, files: {}, process: true, backend: jev(at(2)) })
  await w.submit('Rename the helper')
  await w.step({ index: 0 })
  expect(await (await w.pane({ id: 'plain' })).find({ key: 'pane-card-reference' })).toBeUndefined()

  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0 })
  expect(await (await w.pane({ id: 'unread' })).find({ key: 'pane-card-reference' })).toBeUndefined()
})
