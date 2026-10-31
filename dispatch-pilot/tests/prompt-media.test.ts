// Seam 2: reading a message's images as it is submitted (`$.prompt.media`, Claude Code 2.1.316 on; ADR 0019), and the room the
// ballot's requests are left once a part waited for that reading. The test kit has no implementation of `$.prompt.media` (a call
// throws "no implementation for prompt.media"), so the world's image tests go the way an engine before 2.1.316 does (the row,
// then the turn's start); the read itself is tested here with the engine as a closure.

import { expect, test } from 'claude-code/testing'
import type { PromptMedia, PromptMediaArgs } from 'claude-code'
import { attachedImages } from '../hooks/features/image-routing.ts'
import { ballotWaitMs, type Contribution } from '../hooks/core/ballot.ts'

/** An engine holding these items' base64, answered `per` characters a call (the engine's 4 MiB, made small). */
function engine(items: Readonly<Record<string, string | PromptMedia>>, per = 1_000_000) {
  const calls: PromptMediaArgs[] = []
  const read = async (args: PromptMediaArgs): Promise<PromptMedia> => {
    calls.push(args)
    const item = items[args.id]
    if (item === undefined) return { deny: `no submission in flight carries ${args.id}` }
    if (typeof item !== 'string') return item
    const at = args.offset ?? 0
    const end = Math.min(at + per, item.length)
    return { type: 'image', mediaType: 'image/png', base64: item.slice(at, end), size: item.length, ...(end < item.length ? { next: end } : {}) }
  }
  return { read, calls }
}

const image = (id: string) => ({ type: 'image', mediaType: 'image/png', id })

test("every image of the message is read, slice by slice, in order; other items and items without a handle are left alone", async () => {
  const { read, calls } = engine({ media_1: 'AAAABBBB', media_2: 'CCCC' }, 3)
  const attached = await attachedImages(read, [image('media_1'), { type: 'document', id: 'media_9' }, { type: 'image' }, image('media_2')])
  expect(attached).toEqual({ ok: true, sources: [{ base64: 'AAAABBBB' }, { base64: 'CCCC' }], skipped: 0 })
  expect(calls).toEqual([{ id: 'media_1' }, { id: 'media_1', offset: 3 }, { id: 'media_1', offset: 6 }, { id: 'media_2' }, { id: 'media_2', offset: 3 }])
})

test('an image the engine could not process, or too big to keep, is left out; the others are still read', async () => {
  const { read } = engine({ media_1: { unreadable: 'the image could not be processed' }, media_2: 'x'.repeat(12_000_001), media_3: 'DDDD' }, 6_000_000)
  expect(await attachedImages(read, [image('media_1'), image('media_2'), image('media_3')])).toEqual({ ok: true, sources: [{ base64: 'DDDD' }], skipped: 2 })
})

test('an engine that refuses the bytes (before 2.1.316) or a read that throws (the test kit) leaves the images to the row', async () => {
  const refused = await attachedImages(engine({}).read, [image('media_1')])
  expect(refused).toEqual({ ok: false, reason: 'the engine refused its bytes (no submission in flight carries media_1)' })
  const thrown = await attachedImages(async () => {
    throw new Error('no implementation for prompt.media')
  }, [image('media_1')])
  expect(thrown.ok).toBe(false)
  expect(thrown.ok === false && thrown.reason).toContain('no implementation for prompt.media')
})

test("the ballot's requests get the hook's room less the longest a part waited, never under the least; no wait, no limit", () => {
  const part = (waitedMs?: number) => ({ part: 'p', questions: {}, settle: () => undefined, ...(waitedMs === undefined ? {} : { waitedMs }) }) as unknown as Contribution
  expect(ballotWaitMs([part(), part()], 9000, 200)).toBe(undefined)
  expect(ballotWaitMs([part(), part(3000)], 9000, 200)).toBe(6000)
  expect(ballotWaitMs([part(1000), part(8900)], 9000, 200)).toBe(200)
})
