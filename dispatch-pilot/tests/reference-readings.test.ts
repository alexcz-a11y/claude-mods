// Reading a group of reference images (#63), seam 2: the function other features call to get "the reading of these images" (the
// message that starts a turn now; #64's mid-turn re-decision, dispatched agents and Workflow later). It prepares the images, asks
// once per group of images (by their content) and keeps what it read in one place. Its engine is closures, as BackendIo is: here a
// disk and a sips of the test's own (tests/support/images.ts), a decision model that counts what it is asked, and a `$.state`
// value held in memory.

import { expect, test } from 'claude-code/testing'
import { latestReading, readReferenceComplexity, type ComplexityIo, type ReferenceReadings } from '../hooks/core/complexity.ts'
import type { ImageFilesIo } from '../hooks/core/image-files.ts'
import type { Cell } from '../hooks/core/plans.ts'
import type { Asked } from '../hooks/decision/backend.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { absolute, BASE_DIRS, type Disk, type FakeFile, fileBase64, mkdir, ok, type Program, readFake, sips } from './support/images.ts'

/** A disk and the programs of the world on it, as the closures the mod's image functions take. */
function files(initial: Record<string, FakeFile>, programs: Record<string, Program> = {}) {
  const disk: Disk = { files: new Map(Object.entries(initial)), dirs: new Set([...BASE_DIRS, '/work']) }
  const ran: string[][] = []
  let made = 0
  const all: Record<string, Program> = { sips, mkdir, ...programs }
  const io: ImageFilesIo = {
    run: async (argv, init) => {
      ran.push([...argv])
      const [name = '', ...args] = argv
      const program = all[name]
      if (program === undefined) throw new Error(`spawn ${name} ENOENT`)
      return { ...(await program(args, disk, init)) }
    },
    readBytes: async (path) => {
      const file = disk.files.get(absolute(path))
      if (file === undefined) throw new Error(`ENOENT: ${path}`)
      return fileBase64(file)
    },
    newFile: async (extension) => {
      disk.dirs.add('/tmp/dp')
      return `/tmp/dp/image-${++made}.${extension}`
    },
  }
  return { io, disk, ran }
}

/** A `$.state` value in memory, with the versions it has. */
function memory<T>(): Cell<T> & { value: () => T | undefined } {
  let held: T | undefined
  let version = 0
  return {
    get: async () => ({ value: held, version }),
    set: async (value, options) => {
      if (options.ifVersion !== version) return { isSet: false, version }
      held = value
      version += 1
      return { isSet: true, version }
    },
    value: () => held,
  }
}

/** A decision model that answers the reading with `levels` and keeps what it was asked. */
function model(levels: readonly number[], failure?: { kind: 'timeout' | 'http'; detail: string }) {
  const asked: DecisionRequest[] = []
  const ask = async (request: DecisionRequest): Promise<Asked> => {
    asked.push(request)
    if (failure !== undefined) return { ok: false, failure }
    return { ok: true, answers: { 'complexity.level': { type: 'score', score: 0, probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: 0.7 } }, model: JEV_MODEL, inputTokens: 100 }
  }
  return { ask, asked }
}

function setting(disk: Record<string, FakeFile>, answer: ReturnType<typeof model>, extra: { programs?: Record<string, Program> } = {}) {
  const world = files(disk, extra.programs)
  const store = memory<ReferenceReadings>()
  let clock = 0
  const io: ComplexityIo = { files: world.io, ask: answer.ask, store, now: async () => (clock += 1000), backend: 'jev' }
  return { io, store, world }
}

const PNG = (width: number, height: number, label: string): FakeFile => ({ format: 'png', width, height, label })

test('a group is asked once: the images come to the decision model in one request, sized to about a megapixel each, and the reading is the level they read as', async () => {
  const answer = model([0, 0, 0.1, 0.8, 0.1])
  const s = setting({ '/refs/a.png': PNG(3000, 2000, 'a'), '/refs/b.png': PNG(800, 600, 'b') }, answer)

  const first = await readReferenceComplexity(s.io, [{ path: '/refs/a.png' }, { path: '/refs/b.png' }])

  expect(first).toMatchObject({ ok: true, cached: false, reading: { level: 3, images: 2 } })
  expect(answer.asked).toHaveLength(1)
  const sent = answer.asked[0]?.images ?? []
  expect(sent).toHaveLength(2)
  // 3000x2000 is 6 MP: scaled down to at most 1 MP, keeping its shape; 800x600 is already under.
  const [big, small] = sent.map((image) => readFake(image.base64))
  expect((big?.width ?? 0) * (big?.height ?? 0)).toBeLessThanOrEqual(1_000_000)
  expect(Math.abs((big?.width ?? 0) / (big?.height ?? 1) - 1.5)).toBeLessThan(0.02)
  expect(small).toMatchObject({ width: 800, height: 600 })

  // The same pictures again, in the other order: no request.
  const again = await readReferenceComplexity(s.io, [{ path: '/refs/b.png' }, { path: '/refs/a.png' }])
  expect(again).toMatchObject({ ok: true, cached: true, reading: { level: 3, images: 2 } })
  expect(answer.asked).toHaveLength(1)
})

test('another group is another request, and the latest reading is the one asked or reused last', async () => {
  const answer = model([0.9, 0.1, 0, 0, 0])
  const s = setting({ '/refs/a.png': PNG(800, 600, 'a'), '/refs/b.png': PNG(640, 480, 'b') }, answer)

  expect(await latestReading(s.store)).toBeNull()
  await readReferenceComplexity(s.io, [{ path: '/refs/a.png' }])
  await readReferenceComplexity(s.io, [{ path: '/refs/b.png' }])
  expect(answer.asked).toHaveLength(2)
  expect(await latestReading(s.store)).toEqual({ level: 0, images: 1 })

  // Asked for the first group again: it is reused, and it is now the latest.
  const reused = await readReferenceComplexity(s.io, [{ path: '/refs/a.png' }])
  expect(reused).toMatchObject({ ok: true, cached: true, reading: { level: 0, images: 1 } })
  expect(answer.asked).toHaveLength(2)
  const kept = s.store.value()
  expect(kept).toHaveLength(2)
  expect(kept?.at(-1)?.key).toBe(reused.ok ? reused.key : '')
})

test('a group has at most six images: of more, the first six are read', async () => {
  const answer = model([0, 1, 0, 0, 0])
  const disk = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/refs/${i}.png`, PNG(800, 600, `image ${i}`)]))
  const s = setting(disk, answer)

  const read = await readReferenceComplexity(s.io, Array.from({ length: 8 }, (_, i) => ({ path: `/refs/${i}.png` })))

  expect(read).toMatchObject({ ok: true, reading: { images: 6 } })
  expect(answer.asked[0]?.images).toHaveLength(6)
})

test('an image that cannot be read is left out; when none can, there is no request and the reason says so', async () => {
  const answer = model([0, 1, 0, 0, 0])
  const s = setting({ '/refs/a.png': PNG(800, 600, 'a') }, answer)

  const some = await readReferenceComplexity(s.io, [{ path: '/refs/a.png' }, { path: '/refs/gone.png' }])
  expect(some).toMatchObject({ ok: true, reading: { images: 1 } })

  const none = await readReferenceComplexity(s.io, [{ path: '/refs/gone.png' }])
  expect(none.ok).toBe(false)
  expect(none.ok ? '' : none.reason).toContain('/refs/gone.png')
  expect(answer.asked).toHaveLength(1)

  const empty = await readReferenceComplexity(s.io, [])
  expect(empty).toEqual({ ok: false, reason: 'no reference image to read' })
})

test('a request that fails reads nothing and keeps nothing: the failure is handed back, and the next call asks again', async () => {
  const answer = model([0, 1, 0, 0, 0], { kind: 'timeout', detail: 'no answer in 3000 ms' })
  const s = setting({ '/refs/a.png': PNG(800, 600, 'a') }, answer)

  const failed = await readReferenceComplexity(s.io, [{ path: '/refs/a.png' }])
  expect(failed).toMatchObject({ ok: false, failure: { kind: 'timeout' } })
  expect(s.store.value()).toBeUndefined()
  expect(await latestReading(s.store)).toBeNull()

  await readReferenceComplexity(s.io, [{ path: '/refs/a.png' }])
  expect(answer.asked).toHaveLength(2)
})

test('an answer with no level on it reads as a failure of the reading, and is not kept', async () => {
  const answer = model([0, 0, 0, 0, 0])
  const s = setting({ '/refs/a.png': PNG(800, 600, 'a') }, answer)

  const read = await readReferenceComplexity(s.io, [{ path: '/refs/a.png' }])

  expect(read.ok).toBe(false)
  expect(s.store.value()).toBeUndefined()
})

test('the engine keeps the readings of the last eight groups and no more', async () => {
  const answer = model([0, 1, 0, 0, 0])
  const disk = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/refs/${i}.png`, PNG(800, 600, `image ${i}`)]))
  const s = setting(disk, answer)

  for (let i = 0; i < 10; i++) await readReferenceComplexity(s.io, [{ path: `/refs/${i}.png` }])

  expect(s.store.value()).toHaveLength(8)
  // The oldest were forgotten: asking for the first again is a new request.
  await readReferenceComplexity(s.io, [{ path: '/refs/0.png' }])
  expect(answer.asked).toHaveLength(11)
})

test('an image the engine handed over as bytes, with no file, is written to a file first (the base64 program) and read like any other', async () => {
  const answer = model([0, 0, 1, 0, 0])
  const bytes = fileBase64(PNG(2000, 1333, 'pasted'))
  // macOS's `base64 -D -o <file>` decodes its standard input into a file.
  const base64: Program = (args, disk, init) => {
    const out = args[args.indexOf('-o') + 1] as string
    const header = readFake(init?.stdin ?? '')
    if (header === null) return { exitCode: 1, stdout: '', stderr: 'invalid input' }
    disk.files.set(absolute(out), { format: header.format, width: header.width, height: header.height, label: header.label })
    return ok()
  }
  const s = setting({}, answer, { programs: { base64 } })

  const read = await readReferenceComplexity(s.io, [{ base64: bytes }])

  expect(read).toMatchObject({ ok: true, reading: { level: 2, images: 1 } })
  const sent = readFake(answer.asked[0]?.images?.[0]?.base64 ?? '')
  expect(sent?.label).toContain('pasted')
  expect((sent?.width ?? 0) * (sent?.height ?? 0)).toBeLessThanOrEqual(1_000_000)
})

test('where no program can run (not the CLI), a PNG that already fits is read as it is, and one that does not is a reason', async () => {
  const answer = model([0, 1, 0, 0, 0])
  const world = files({ '/refs/ok.png': PNG(800, 600, 'ok'), '/refs/big.png': PNG(4000, 3000, 'big') })
  const io: ComplexityIo = {
    files: { ...world.io, run: async () => { throw new Error('process.run is only available in the CLI') } },
    ask: answer.ask,
    store: memory<ReferenceReadings>(),
    now: async () => 0,
    backend: 'jev',
  }

  expect(await readReferenceComplexity(io, [{ path: '/refs/ok.png' }])).toMatchObject({ ok: true, reading: { images: 1 } })
  const big = await readReferenceComplexity(io, [{ path: '/refs/big.png' }])
  expect(big.ok).toBe(false)
  expect(answer.asked).toHaveLength(1)
})
