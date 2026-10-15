// The mod's temporary directory (#62, spec #55 「图从哪来、怎么规整」): the images the mod derives or keeps (a scaled copy, a
// screenshot the takeover saved) live in `$TMPDIR/dispatch-pilot/<session id>/`, one subdirectory for each session. Seam 1: the
// world's disk and its sips; a test reads where the derived file landed.

import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const CHECK = [{ part: 'the title', property: 'is fully visible' }]
const WIDE = { '/shots/wide.png': { format: 'png', width: 3000, height: 1000 } }

/** The files the mod wrote, by path: everything on the disk besides what the test put there. */
const written = (w: { files: Map<string, unknown> }, given: Record<string, unknown>): string[] => [...w.files.keys()].filter((path) => !(path in given))

test('derived images go to the TMPDIR, in a directory of the mod, in a subdirectory named for the session', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, sessionId: 'sess-42', env: { TMPDIR: '/var/folders/x/T/' }, files: WIDE, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECK })

  const files = written(w, WIDE)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^\/var\/folders\/x\/T\/dispatch-pilot\/sess-42\/[\w.-]+\.png$/)
  expect(w.dirs.has('/var/folders/x/T/dispatch-pilot/sess-42')).toBe(true)
})

test('a session keeps one directory however many files it makes; after a /clear, which gives the process another session, the files go to that one', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, sessionId: 'sess-a', env: { TMPDIR: '/tmp' }, files: WIDE, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECK })
  await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECK })
  const dirOf = (path: string) => path.replace(/\/[^/]*$/, '')
  expect([...new Set(written(w, WIDE).map(dirOf))]).toEqual(['/tmp/dispatch-pilot/sess-a'])
  expect(written(w, WIDE)).toHaveLength(2)

  w.setSessionId('sess-b')
  await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECK })
  expect([...new Set(written(w, WIDE).map(dirOf))].sort()).toEqual(['/tmp/dispatch-pilot/sess-a', '/tmp/dispatch-pilot/sess-b'])
})

test('files made one after another never take one another\'s names, in the session\'s directory', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, sessionId: 'sess-a', env: { TMPDIR: '/tmp' }, files: WIDE, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  for (let i = 0; i < 3; i++) await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECK })
  expect(new Set(written(w, WIDE)).size).toBe(3)
})

test('a session id that is no safe name for a directory is made one', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, sessionId: '../etc/x y', env: { TMPDIR: '/tmp' }, files: WIDE, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECK })

  expect(written(w, WIDE)[0]).toMatch(/^\/tmp\/dispatch-pilot\/[\w-]+\/[\w.-]+\.png$/)
})
