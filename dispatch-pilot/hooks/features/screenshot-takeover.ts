// Feature: screenshot takeover (#62, spec #55 「截图接管」, ADR 0008). With the switch on, an image the agent's own loop made does
// not reach the agent: it reads a note in its place (where the image is, how big, and that visual_check checks it, or shows it with
// `look: true`), and the visual_check tool, which reads the file, is where the image goes instead. Two kinds of image are taken:
//
//   - a Read that returns an image file modified since the loop began (core/loop-start.ts): the result is swapped for a Read
//     result in its text form, which the engine records without the `[Image: ...]` text it adds to an image;
//   - an image block in the result of an MCP tool (a screenshot tool): saved as a file in the session's temporary directory
//     (`base64 -D`, since `$.fs.write` writes text only) and swapped for the note.
//
// Not taken: an image file that was there before the loop began (a reference image), the images the person pastes (they never
// come through Read), and dispatch-pilot's own tools (`look: true` hands the image back through the tool). The switch is
// `screenshot-takeover`, off until the person turns it on. It acts only where the agent has the means to check the image: the
// visual-check switch is on and an image backend exists. Every image taken is an entry in the log and a count on the agent's row.

import type { EngineInterface, On } from 'claude-code'
import { errorText } from '../decision/backend.ts'
import { extensionOf, formatOf, type Kept, noteAsReadResult, sizeOfImage, swapImages, takeoverNote } from '../decision/screenshot-takeover.ts'
import { isFromLoop, MAIN_LOOP } from '../core/loop-start.ts'
import type { ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import { reportTakeover } from '../core/takeover-report.ts'
import { newWorkFile } from '../core/work-files.ts'

const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
/** When each loop began (core/loop-start.ts), by `main` or the agentId. */
const LOOPS = { plugin: 'dispatch-pilot', key: 'loops' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'screenshot-takeover'

/** The switch of the tool the images are sent to: without it the agent could not look at what was kept from it. */
const VISUAL_CHECK_SWITCH = 'visual-check'

/** The tools of this plugin as the model names them: what they return is the agent's to see. */
const OWN_TOOLS = 'mcp__dispatch-pilot__'

/** What Read returns for an image file (claude-code-tools' `BuiltinToolResults.Read`, its `image` form): the bytes the engine would show the model, and the size of the file itself. */
type ReadImage = { type: 'image'; file: { base64: string; type: string; dimensions?: { originalWidth?: number; originalHeight?: number } } }

/** Where the board and the log are written (`report`), as closures over `$`. */
function reportIoOf($: EngineInterface): ReportIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
  }
}

export function registerScreenshotTakeover(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: '截图接管：agent 本循环里自己生成的图不给它看，换成一句说明，由看图核对去看', default: false })

  /** Whether the takeover acts now: the switch is on (with the whole mod), and the agent has visual_check to send the images to. */
  const acts = (): boolean => isOn(SWITCH) && isOn(VISUAL_CHECK_SWITCH) && ctx.images !== null

  // Read: an image file the loop made. Only the model's own calls (`origin`), not another plugin's `$.tool.call`.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e)
    if (!acts() || next.origin.plugin !== 'engine' || result.deny !== undefined) return result
    const given = result.result as { type?: unknown } | string | null | undefined
    if (typeof given !== 'object' || given === null || given.type !== 'image') return result
    const read = given as ReadImage
    const agent = e.agentId ?? MAIN_LOOP
    try {
      // Where no beginning is known, which files are older cannot be told: the image is left as it is.
      const loop = (await $.state.get({ ...LOOPS, id: agent })).value
      if (loop === undefined) return result
      const stat = await $.fs.stat(e.file_path)
      if (!isFromLoop(stat.mtimeMs, loop.startedAt)) return result
      const shown = read.file.dimensions
      const size = shown?.originalWidth !== undefined && shown.originalHeight !== undefined ? { width: shown.originalWidth, height: shown.originalHeight } : sizeOfImage(read.file.base64)
      const kept: Kept = { path: e.file_path, width: size?.width ?? 0, height: size?.height ?? 0, format: formatOf(read.file.type) }
      await reportTakeover(reportIoOf($), agent, [kept])
      // The image goes, and with it what the engine added to it: the `[Image: ...]` text and the reference to its message.
      const { text: _text, ref: _ref, ...rest } = result
      return { ...rest, result: noteAsReadResult(e.file_path, takeoverNote(kept, 'Read returned an image file.')) } as typeof result
    } catch (error) {
      $.ui.log(`screenshot takeover of ${e.file_path} failed, the image goes to the agent: ${errorText(error)}`, { to: 'debug' })
      return result
    }
  })

  // An MCP tool's result with image blocks: each one saved as a file, and swapped for the note. One that cannot be saved stays.
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const result = await next(e)
    if (!acts() || next.origin.plugin !== 'engine' || result.deny !== undefined || ('isError' in result && result.isError === true) || e.tool.startsWith(OWN_TOOLS)) return result
    const agent = e.agentId ?? MAIN_LOOP
    try {
      const kept: Kept[] = []
      const swapped = await swapImages(result.result, async (image) => {
        try {
          const path = await newWorkFile({ run: (argv) => $.process.run(argv), tmpdir: () => $.env.get('TMPDIR'), sessionId: () => $.session.id() }, extensionOf(image.mediaType))
          const saved = await $.process.run(['base64', '-D', '-o', path], { stdin: image.base64 })
          if (saved.exitCode !== 0) {
            $.ui.log(`screenshot takeover could not save an image of ${e.tool} (base64 ended with ${saved.exitCode}), the image goes to the agent`, { to: 'debug' })
            return null
          }
          const size = sizeOfImage(image.base64)
          const one: Kept = { path, width: size?.width ?? 0, height: size?.height ?? 0, format: formatOf(image.mediaType) }
          kept.push(one)
          return takeoverNote(one, `The tool ${e.tool} returned an image.`)
        } catch (error) {
          $.ui.log(`screenshot takeover could not save an image of ${e.tool}, the image goes to the agent: ${errorText(error)}`, { to: 'debug' })
          return null
        }
      })
      if (swapped.swapped === 0) return result
      await reportTakeover(reportIoOf($), agent, kept)
      const { text: _text, ref: _ref, ...rest } = result
      return { ...rest, result: swapped.result } as typeof result
    } catch (error) {
      $.ui.log(`screenshot takeover of ${e.tool} failed, the images go to the agent: ${errorText(error)}`, { to: 'debug' })
      return result
    }
  })
}
