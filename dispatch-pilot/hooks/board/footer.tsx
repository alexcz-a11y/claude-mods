// The short summary at the right end of the prompt footer (spec #22 「脚部」,
// story 17): a state glyph, the main agent's model·effort, `+N` agents
// running, in at most `FOOTER_COLUMNS` cells, so the band can be collapsed and
// the person's own statusLine keeps its room. Where the whole does not fit,
// the effort's word goes short first (`xhi`), then the model goes. Pure.

import type { Effort } from '../decision/effort.ts'
import type { Model } from '../core/report.ts'
import { ACCENT, EFFORT_COLOR, MODEL_BG, MUTED, SPIN, WARN, width, type T } from './kit.tsx'
import type { ScreenView } from './view.ts'

/** The most cells Dispatch Pilot adds to the footer on the terminal. */
export const FOOTER_COLUMNS = 12

const SHORT: Record<Effort, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhi', max: 'max' }

/** What the footer says, as parts: the glyph and its colour, the readout's words, the agents running. */
export type FooterParts = { glyph: string; color: string; model?: Model; effort?: string; level?: Effort; more: number; routed: boolean }

/** The footer's parts for the view; null when there is nothing to say (no turn yet). */
export function footerParts(view: ScreenView): FooterParts | null {
  if (view.off) return { glyph: '○', color: MUTED, effort: 'dp 已关', more: 0, routed: true }
  const main = view.rows.find((row) => row.node.id === 'main')?.node
  if (main === undefined && view.counts.running === 0) return null
  const running = view.live && (main?.state === 'running' || view.counts.running > 0)
  const routed = main?.routed !== false
  const level = typeof main?.effort === 'string' ? main.effort : undefined
  return {
    glyph: running ? (SPIN[view.frame] ?? '◆') : '◆',
    color: routed ? ACCENT : WARN,
    ...(main?.model === undefined ? {} : { model: main.model }),
    ...(main?.effort === undefined ? {} : { effort: String(main.effort) }),
    ...(level === undefined ? {} : { level }),
    more: view.counts.running,
    routed,
  }
}

/** The words that fit, longest first: the model and the effort, the effort short, the effort alone, short. */
export function footerWords(parts: FooterParts): { model?: Model; effort?: string } {
  const short = parts.level === undefined ? parts.effort : SHORT[parts.level]
  const tries: { model?: Model; effort?: string }[] = [
    { ...(parts.model === undefined ? {} : { model: parts.model }), ...(parts.effort === undefined ? {} : { effort: parts.effort }) },
    { ...(parts.model === undefined ? {} : { model: parts.model }), ...(short === undefined ? {} : { effort: short }) },
    parts.effort === undefined ? { ...(parts.model === undefined ? {} : { model: parts.model }) } : { effort: parts.effort },
    short === undefined ? {} : { effort: short },
    {},
  ]
  return tries.find((words) => width(footerText(parts, words)) <= FOOTER_COLUMNS) ?? {}
}

/** The footer as plain text, with these words. */
export function footerText(parts: FooterParts, words: { model?: Model; effort?: string }): string {
  const readout = [words.model, words.effort].filter((word) => word !== undefined).join('·')
  return [parts.glyph, readout, parts.more > 0 ? `+${parts.more}` : ''].filter((part) => part !== '').join(' ')
}

/** The footer's own tree (beside the engine's modes), or null. */
export function footerTree(t: T, view: ScreenView) {
  const { Box, Text } = t
  const parts = footerParts(view)
  if (parts === null) return null
  const words = footerWords(parts)
  const level = parts.level !== undefined && words.effort !== undefined ? parts.level : undefined
  return (
    <Box key="dp-footer">
      <Text>
        <Text color={parts.color} bold>{parts.glyph}</Text>
        {words.model === undefined && words.effort === undefined ? null : <Text> </Text>}
        {words.model === undefined ? null : <Text color={parts.routed ? MODEL_BG[words.model] : WARN}>{words.model}</Text>}
        {words.model !== undefined && words.effort !== undefined ? <Text color={MUTED}>·</Text> : null}
        {words.effort === undefined ? null : <Text color={!parts.routed ? WARN : level === undefined ? MUTED : EFFORT_COLOR[level]}>{words.effort}</Text>}
        {parts.more > 0 ? <Text color={ACCENT} bold>{` +${parts.more}`}</Text> : null}
      </Text>
    </Box>
  )
}
