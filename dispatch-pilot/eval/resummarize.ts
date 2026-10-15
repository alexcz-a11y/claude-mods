// Brings saved results up to the metrics of now (eval/lib/resummarize.ts),
// from the answers each file holds; nothing is sent, nothing else changes.
//
//   node dispatch-pilot/eval/resummarize.ts                every eval/results/<suite>/*.json that is a result (not probes/;
//                                                          flow files and scans are skipped, each with a line saying so)
//   node dispatch-pilot/eval/resummarize.ts <file> ...     these files (one that is no result stops it: nothing is written)
//   node dispatch-pilot/eval/resummarize.ts --dry-run      what would change; nothing is written
//
// Everything is read and checked before the first file is written.
//
// What it brings up to date: each variant's pass (the Chinese-English bar of
// 2026-10-05: at most 4 points below, exactly 4 passing), and each language's
// late, retried and inTime (an answer that came after the mod's timeoutMs, or
// only after the eval asked again, is one the mod would not have had).

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resummarizeAll } from './lib/resummarize.ts'
import { RESULTS_DIR, formatResult, shown } from './node.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean', default: false }, date: { type: 'string' } } })
const date = values.date ?? new Date().toISOString().slice(0, 10)

const files =
  positionals.length > 0
    ? positionals
    : readdirSync(RESULTS_DIR)
        .filter((suite) => suite !== 'probes' && statSync(join(RESULTS_DIR, suite)).isDirectory())
        .flatMap((suite) => readdirSync(join(RESULTS_DIR, suite)).filter((name) => name.endsWith('.json')).map((name) => join(RESULTS_DIR, suite, name)))
        .sort()

const { done, skipped } = resummarizeAll(files.map((file) => ({ file, text: readFileSync(file, 'utf8') })), date)
for (const { file, why } of skipped) console.log(`${shown(file)}: skipped (${why})`)
if (positionals.length > 0 && skipped.length > 0) {
  console.error('nothing written: a file given is no result')
  process.exit(2)
}

const pct = (rate: number | undefined) => (rate === undefined ? '-' : (rate * 100).toFixed(1))
for (const { file, before, after } of done) {
  const lines = after.summary.variants.map((variant, i) => {
    const was = before.summary.variants[i]
    const pass = was?.pass === variant.pass ? `pass ${variant.pass}` : `pass ${was?.pass} -> ${variant.pass}`
    return `  ${variant.variant}: gap ${pct(variant.gap)}, ${pass}; in time zh ${pct(variant.zh.inTime)} (late ${variant.zh.late}, retried ${variant.zh.retried}), en ${pct(variant.en.inTime)} (late ${variant.en.late}, retried ${variant.en.retried})`
  })
  console.log(`${shown(file)}:`)
  for (const line of lines) console.log(line)
}
if (!values['dry-run']) for (const { file, after } of done) writeFileSync(file, formatResult(after))
