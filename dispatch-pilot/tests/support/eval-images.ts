// What the visual-check suite of the eval (#65) needs of a machine, on the world's fake disk (tests/support/images.ts): the files
// and programs its images are read and cut with (`ImageHost`, the same programs the mod's world runs), and the decision model it
// asks, called through the very backend the eval uses and answered by a world's fake, so that a test reads what went out on the wire.
//
// Not a test file (no `.test.ts`).

import { jevBackend, JEV_MODEL } from '../../hooks/decision/jev.ts'
import { pplxBackend } from '../../hooks/decision/pplx.ts'
import type { Backend, BackendIo } from '../../hooks/decision/backend.ts'
import type { Ask } from '../../eval/lib/suite.ts'
import type { ImageHost } from '../../eval/lib/visual-check.ts'
import { absolute, BASE_DIRS, type Disk, type FakeFile, fileBase64, fileSize, mkdir, sips } from './images.ts'
import type { Reply, Sent } from './world.ts'

/** Where the eval's pictures lie on the fake disk: an item names `ui/c1.png`, the disk has `/set/ui/c1.png`. */
export const SET_DIR = '/set'
/** The most a read gives, as the engine's `$.fs.read` (4 MiB); the eval's Node reader refuses more alike. */
const MOST_BYTES = 4 * 1024 * 1024

/** The host of an eval run on a disk of `files` (by absolute path): sips and mkdir as the world has them, no ffmpeg. */
export function imageHost(files: Record<string, FakeFile>): { host: ImageHost; disk: Disk; ran: string[][] } {
  const disk: Disk = { files: new Map(Object.entries(files).map(([path, file]) => [absolute(path), file])), dirs: new Set([...BASE_DIRS, '/tmp/eval-work']) }
  const ran: string[][] = []
  let count = 0
  const host: ImageHost = {
    path: (relative) => `${SET_DIR}/${relative}`,
    io: {
      run: async (argv) => {
        ran.push([...argv])
        const [program, ...args] = argv
        if (program === 'sips') return sips(args, disk)
        if (program === 'mkdir') return mkdir(args, disk)
        throw new Error(`spawn ${program} ENOENT`)
      },
      readBytes: async (path) => {
        const file = disk.files.get(absolute(path))
        if (file === undefined) throw new Error(`ENOENT: no such file ${path}`)
        if (fileSize(file) > MOST_BYTES) throw new Error(`${path} is over 4 MiB`)
        return fileBase64(file)
      },
      newFile: async (extension) => `/tmp/eval-work/image-${++count}.${extension}`,
    },
  }
  return { host, disk, ran }
}

/**
 * The eval's `Ask` for `backend`: each request goes out through the backend as the runner sends it (no retry here), the world's fake
 * `reply` answers it as the real API would, and what went out is kept as the mod's world keeps its own (`Sent`).
 */
export function askThrough(backend: Backend, reply: (request: Sent) => Reply): { ask: Ask; sent: Sent[] } {
  const sent: Sent[] = []
  const io: BackendIo = {
    fetch: async (url, init) => {
      const request: Sent = { url, method: init.method, headers: { ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), at: 0 }
      sent.push(request)
      const answer = await reply(request)
      if (!('status' in answer)) throw new Error('a reply of the eval\'s fake backend has a status')
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
      return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, headers: answer.headers ?? {}, text }
    },
    sleep: () => new Promise(() => {}),
  }
  return {
    sent,
    ask: async (request) => ({ request, asked: await backend.ask(io, request, 60_000), ms: 7, attempts: 1 }),
  }
}

/** Jev as the eval's run builds it (eval/node.ts `backendFor`: the key and, by default, the mod's pinned model, JEV_MODEL). */
export const evalJev = (key: string): Backend => jevBackend(key, { model: JEV_MODEL })
/** pplx as the eval's run builds it. */
export const evalPplx = (key: string): Backend => pplxBackend(key)

/** A request as the world keeps it, with what is made new for each request (the references' UUID) and what only differs by construction (the bytes of an image) made alike. */
export function comparable(request: Sent, options: { bytes?: boolean } = {}): unknown {
  const text = JSON.stringify({ url: request.url, headers: request.headers, body: request.body })
  const sameId = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, 'ID')
  const value = JSON.parse(sameId) as { body?: { assets?: Record<string, { data_base64?: string; format?: string }> } }
  // The frames of a recording are JPEGs ffmpeg cut; the eval's are PNG files of the dataset: only that they are there is the same.
  if (options.bytes === false && value.body?.assets !== undefined) {
    for (const asset of Object.values(value.body.assets)) {
      delete asset.data_base64
      delete asset.format
    }
  }
  return value
}
