// visual_check (#57): `look: true` judges nothing and only hands the images back, scaled down to a size the agent can read (the
// way it gets a screenshot back that it was not shown, and looks at the final result before it hands work over). Seam 1.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } }

test('look hands the images back as image blocks and nothing else: too large ones scaled down, small ones left alone, no request sent', { options: JEV }, async ($, on) => {
  const w = world($, on, {
    session: true,
    process: true,
    files: { '/shots/wide.png': { format: 'png', width: 3000, height: 1000 }, '/shots/icon.png': { format: 'png', width: 100, height: 60 } },
    backend: jev([0, 1, 0, 0, 0]),
  })
  await w.start()
  const answer = await w.visualCheck({ images: ['/shots/wide.png', '/shots/icon.png'], look: true })

  const blocks = answer.result as Block[]
  expect(blocks.map((block) => block.type)).toEqual(['image', 'image'])
  expect(blocks.map((block) => readFake(block.source?.data ?? ''))).toMatchObject([
    { format: 'png', width: 1568, height: 523 },
    { format: 'png', width: 100, height: 60 },
  ])
  expect(blocks[0]?.source).toMatchObject({ type: 'base64', media_type: 'image/png' })
  expect(w.requests).toHaveLength(0)
})

test('look needs no checks, and an image it cannot get is a line of text among the images, with the reason', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, files: { '/shots/a.png': { format: 'png', width: 800, height: 600 } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = await w.visualCheck({ images: ['/shots/a.png', '/shots/gone.png'], look: true })

  const blocks = answer.result as Block[]
  expect(blocks.map((block) => block.type)).toEqual(['image', 'text'])
  expect(blocks[1]?.text).toBe('/shots/gone.png is not an image sips can read (is the path right?)')
})
