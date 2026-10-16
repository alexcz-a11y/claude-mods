// The screenshot takeover, MCP tools (#62, spec #55 「截图接管」): the image blocks in the result of a screenshot tool are saved as
// files and swapped for the note, and the path in the note is one visual_check reads, and `look` brings the image back. Seam 1:
// `w.callTool` runs the mod's hooks and ends at a tool the test scripts to return the blocks; the world's `base64` and sips work
// on the world's disk. How the engine hands an MCP image block to a tool.call hook was never measured (no more probes, by the
// person's decision), so both shapes it may have are tried: MCP's (`data`, `mimeType`) and the Messages API's (`source`).

import { expect, test } from 'claude-code/testing'
import { base64, readFake, screenshotContent } from './support/images.ts'
import { jev, KEY, world } from './support/world.ts'

const OPTIONS = { ...KEY, rejudgeEvery: 0 }
const ON = { 'screenshot-takeover': true }
const TOOL = 'mcp__chrome-devtools__take_screenshot'
const PAGE = { format: 'png', width: 1440, height: 900, label: 'the page as the browser tool drew it' }
const CHECKS = [{ part: 'the title', property: 'is fully visible' }]
const BACKEND = jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.97 } })

type Block = { type: string; text?: string; [field: string]: unknown }

/** The path the note names as where the image was saved. */
const savedPath = (text: string | undefined): string => /saved at (\S+) \(/.exec(text ?? '')?.[1] ?? ''

/** A session at the first step of a turn, with the takeover on. */
async function begin(...[$, on, options]: Parameters<typeof world>) {
  const w = world($, on, { session: true, process: { programs: { base64 } }, switches: ON, env: { TMPDIR: '/var/T/' }, backend: BACKEND, ...options })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  return w
}

test('an MCP screenshot\'s image block is saved to a file in the session\'s directory and swapped for the note; the rest of the result stays', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on)
  const got = await w.callTool(TOOL, { ends: { returns: screenshotContent(PAGE), text: 'Took a screenshot of the page.' } })

  const blocks = got.result as Block[]
  expect(blocks.map((block) => block.type)).toEqual(['text', 'text'])
  expect(blocks[0]?.text).toBe('Took a screenshot of the page.')
  const path = savedPath(blocks[1]?.text)
  expect(path).toMatch(/^\/var\/T\/dispatch-pilot\/s1\/image-[\w-]+\.png$/)
  expect(blocks[1]?.text).toContain('1440x900')
  expect(blocks[1]?.text).toContain('visual_check')
  expect(blocks[1]?.text).toContain('look: true')
  // The file is the image, byte for byte.
  expect(w.files.get(path)).toMatchObject({ format: 'png', width: 1440, height: 900, label: PAGE.label })
  // Nothing of the image, nor of the engine's own text and reference for the result, is left.
  expect(JSON.stringify(got)).not.toContain('base64')
  expect(got.text).toBeUndefined()
  expect(got.ref).toBeUndefined()
})

test('the path in the note is one visual_check reads, and look brings the image itself back', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on)
  const got = await w.callTool(TOOL, { ends: { returns: screenshotContent(PAGE) } })
  const path = savedPath((got.result as Block[])[1]?.text)

  const checked = await w.visualCheck({ images: [path], checks: CHECKS })
  expect(JSON.stringify(checked.result)).toContain('Visual check of ')
  const sent = Object.values(w.requests.at(-1)?.body.assets ?? {}) as { data_base64: string }[]
  expect(readFake(sent[0]?.data_base64 as string)).toMatchObject({ width: 1440, height: 900, label: expect.stringContaining(PAGE.label) })

  // The note's second way: the image back, as a block of the tool's answer, which the takeover leaves alone (it is this plugin's own tool).
  const looked = (await w.visualCheck({ images: [path], look: true })).result as Block[]
  expect(looked.map((block) => block.type)).toEqual(['image'])
  expect(readFake((looked[0] as any).source.data)).toMatchObject({ width: 1440, height: 900 })
})

test('the Messages API\'s shape of a block, in the result of an MCP tool that wraps its blocks in `content`, is swapped in place', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on)
  const got = await w.callTool(TOOL, { ends: { returns: { isError: false, content: screenshotContent(PAGE, 'api') } } })

  const result = got.result as { isError: boolean; content: Block[] }
  expect(result.isError).toBe(false)
  expect(result.content.map((block) => block.type)).toEqual(['text', 'text'])
  expect(w.files.get(savedPath(result.content[1]?.text))).toMatchObject({ width: 1440, height: 900 })
})

test('every image of a result is kept, each in a file of its own', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on)
  const content = [...screenshotContent(PAGE), ...screenshotContent({ ...PAGE, label: 'a second one' }, 'api')]
  const got = await w.callTool(TOOL, { ends: { returns: content } })

  const paths = (got.result as Block[]).flatMap((block) => (block.text?.includes('saved at') ? [savedPath(block.text)] : []))
  expect(paths).toHaveLength(2)
  expect(new Set(paths).size).toBe(2)
  expect(JSON.stringify(got)).not.toContain('"image"')
})

test('a result with no image is left as it is', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on)
  const got = await w.callTool('mcp__chrome-devtools__list_pages', { ends: { returns: [{ type: 'text', text: '1 page open' }], text: '1 page open' } })

  expect(got.result).toEqual([{ type: 'text', text: '1 page open' }])
  expect(got.text).toBe('1 page open')
})

test('off, an MCP tool\'s image reaches the agent', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on, { switches: { 'screenshot-takeover': false } })
  const got = await w.callTool(TOOL, { ends: { returns: screenshotContent(PAGE) } })

  expect((got.result as Block[]).map((block) => block.type)).toEqual(['text', 'image'])
})

test('an image that cannot be saved stays in the result: the agent loses nothing it cannot be given back', { options: OPTIONS }, async ($, on) => {
  const missing = await begin($, on, { process: { programs: { base64: null } } })
  const first = await missing.callTool(TOOL, { ends: { returns: screenshotContent(PAGE) } })
  expect((first.result as Block[]).map((block) => block.type)).toEqual(['text', 'image'])
  expect((await missing.board()).log.filter((entry) => entry.feature === 'screenshot-takeover')).toEqual([])
})

test('outside the CLI, where no program can be run, nothing is taken over', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on, { process: { unavailable: 'process.run is for the CLI' } })
  const got = await w.callTool(TOOL, { ends: { returns: screenshotContent(PAGE) } })

  expect((got.result as Block[]).map((block) => block.type)).toEqual(['text', 'image'])
})

test('base64 failing on the file is a failure to save, the image stays', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on, { process: { programs: { base64: () => ({ exitCode: 1, stdout: '', stderr: 'base64: disk full' }) } } })
  const got = await w.callTool(TOOL, { ends: { returns: screenshotContent(PAGE) } })

  expect((got.result as Block[]).map((block) => block.type)).toEqual(['text', 'image'])
})

test('a dispatched agent\'s tool call is taken over as the main agent\'s is, and counted on the agent\'s own row', { options: OPTIONS }, async ($, on) => {
  const w = await begin($, on)
  const started = await w.spawn({ prompt: 'Check the home screen.', description: '核对首页' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId })
  const got = await w.callTool(TOOL, { agentId: started.agentId, ends: { returns: screenshotContent(PAGE) } })

  expect((got.result as Block[]).map((block) => block.type)).toEqual(['text', 'text'])
  const { main, agents } = await w.board()
  expect(agents.find((node) => node.id === started.agentId)?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 0, takeovers: 1 })
  expect(main?.visualChecks).toBeUndefined()
})
