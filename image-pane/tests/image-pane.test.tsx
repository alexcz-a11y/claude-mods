import type { On, RenderSurface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { classify, findImages, fitCells, imageSources, pngSize } from '../hooks/core.ts'

// 一张 1×1 的 PNG。
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const PANE = {
  plugin: 'image-pane',
  component: 'Pane',
  requestId: 'image-pane',
  surface: 'terminal',
  props: {
    title: 'Images',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('认得 Read、MCP、Messages API 三种图片形状', () => {
  expect(findImages({ type: 'image', file: { base64: PNG, type: 'image/png' } })).toHaveLength(1)
  expect(findImages({ content: [{ type: 'text', text: 'x' }, { type: 'image', data: PNG, mimeType: 'image/jpeg' }] })).toHaveLength(1)
  expect(findImages({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: PNG } })[0]?.mediaType).toBe(
    'image/webp',
  )
  expect(findImages({ type: 'text', text: PNG })).toHaveLength(0)
})

test('按工具名分来源', () => {
  expect(classify('Read')).toBe('read')
  expect(classify('mcp__computer-use__app_screenshot')).toBe('screenshot')
  expect(classify('mcp__Claude_Browser__computer')).toBe('screenshot')
  expect(classify('Bash')).toBe('tool')
})

test('PNG 宽高和格子尺寸', () => {
  expect(pngSize(PNG)).toEqual({ width: 1, height: 1 })
  expect(pngSize('not-a-png-at-all-but-long-enough-xxxx')).toBe(null)
  expect(fitCells(2000, 1000, 40, 30)).toEqual({ columns: 40, rows: 10 })
  expect(fitCells(1000, 2000, 40, 10)).toEqual({ columns: 10, rows: 10 })
})

function engine(on: On, surfaces: RenderSurface[], opened?: string[][], saved?: string[][]) {
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', () => ({ value: { command: 'images' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'open') opened?.push([...e.argv])
    else saved?.push([...e.argv])
    return { value: { exitCode: 0, stdout: '1 1', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } }))
}

test('终端里，截图工具的结果出现在图片栏', async ($, on) => {
  engine(on, ['terminal'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__computer-use__app_screenshot' } as never)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /1\/1 · 截图/ }))?.text).toMatch(/app_screenshot/)
  await ui.unmount()
})

test('同一张图只收一次', async ($, on) => {
  engine(on, ['terminal'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__computer-use__app_screenshot' } as never)
  await $.tool.call({ tool: 'mcp__computer-use__app_screenshot' } as never)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^1\/1/ })).toBeTruthy()
  await ui.unmount()
})

test('Claude Desktop 里什么都不收', async ($, on) => {
  engine(on, ['desktop'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__computer-use__app_screenshot' } as never)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /还没有图片/ })).toBeTruthy()
  await ui.unmount()
})

test('按「打开原图」用 open 打开原件', async ($, on) => {
  const opened: string[][] = []
  engine(on, ['terminal'], opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__computer-use__app_screenshot' } as never)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'open' })
  expect(opened).toEqual([['open', '/tmp/image-pane/s1/1.orig.png']])
  await ui.unmount()
})

test('贴图消息里的原文件路径', () => {
  expect(imageSources('[Image: source: /private/tmp/x/images/1.png]')).toEqual(['/private/tmp/x/images/1.png'])
  expect(imageSources('[Image: source: /Users/a/Pictures/截屏2026-10-23 02.08.11.png]')).toEqual([
    '/Users/a/Pictures/截屏2026-10-23 02.08.11.png',
  ])
})

test('Read 的图从原文件做显示用的 PNG，读不到时脚本回退到引擎那份', async ($, on) => {
  const saved: string[][] = []
  engine(on, ['terminal'], undefined, saved)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/Users/a/logo.png' } as never)

  // argv：sh -c SAVE sh <dir> <n> <mediaType> <source>
  expect(saved[0]?.slice(4)).toEqual(['/tmp/image-pane/s1', '1', 'image/png', '/Users/a/logo.png'])
})

test('没有原文件路径时不传来源', async ($, on) => {
  const saved: string[][] = []
  engine(on, ['terminal'], undefined, saved)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__computer-use__app_screenshot' } as never)

  expect(saved[0]?.at(-1)).toBe('')
})

// visual_check 这类工具由先加载的 mod 在 tool.call 里直接答掉，image-pane 的 tool.call 看不到，只能从对话里收。
function conversation(on: On, toolUseId: string, data = PNG) {
  on('session.messages', () => ({
    value: [
      { role: 'user', content: [{ type: 'text', text: '看图' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__dispatch-pilot__visual_check', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
        ],
      },
    ],
  }))
}

async function step($: { turn: { step: (e: never) => AsyncIterable<unknown> } }) {
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'opus', messageCount: 3 } as never)) {
    // 只要跑完
  }
}

test('tool.call 没经手的工具结果里的图，下一步从对话里收', async ($, on) => {
  engine(on, ['terminal'])
  conversation(on, 'toolu_vc')
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /1\/1 · 工具结果/ }))?.text).toMatch(/visual_check/)
  await ui.unmount()
})

test('tool.call 已经手的调用不从对话里再收一次', async ($, on) => {
  engine(on, ['terminal'])
  // 对话里那份和 tool.call 拿到的字节不同（引擎可能重编码），指纹去重拦不住，要靠 tool_use_id。
  conversation(on, 'toolu_seen', `${PNG}AAAA`)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_seen' } as never)
  await step($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^1\/1/ })).toBeTruthy()
  await ui.unmount()
})
