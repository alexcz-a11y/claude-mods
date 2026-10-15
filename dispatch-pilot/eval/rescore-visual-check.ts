// The visual-check results read again by the bars of 2026-10-15 (eval/lib/visual-check-rescore.ts); nothing is sent.
//
//   node dispatch-pilot/eval/rescore-visual-check.ts [--write <file>] [<result.json> ...]
//
// With no file, the two results of 2026-10-15 (the baseline and the animation redone with a TARGET box). Prints, for each variant and
// each kind (ui, sea, anim), what the old bars (PASS from 0.9, FAIL up to 0.2) and the new ones (0.8 and 0.2 for a screenshot, 0.8 and
// 0.4 for a recording) say of the very probabilities the runs kept. `--write` saves the figures as JSON (the results are not touched).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { BARS_NOTE, KINDS, rescoreResult, type Rescored, type Tally } from './lib/visual-check-rescore.ts'
import { RESULTS_DIR, shown } from './node.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { write: { type: 'string' }, date: { type: 'string' } } })
const DIR = join(RESULTS_DIR, 'visual-check')
const files = positionals.length > 0 ? positionals : [join(DIR, '2026-10-15-jev-baseline.json'), join(DIR, '2026-10-15-jev-anim-target.json')]

const rescored = files.map((file) => rescoreResult(shown(file), JSON.parse(readFileSync(file, 'utf8'))))

const fraction = (n: number, of: number) => (of === 0 ? '-' : `${n}/${of}`)
const line = (label: string, t: Tally) =>
  `  ${label.padEnd(5)} ${String(t.checks).padStart(3)} checks | false pass ${fraction(t.falsePass, t.differ).padStart(6)} | false fail ${fraction(t.falseFail, t.same).padStart(6)} | caught ${fraction(t.caught, t.differ).padStart(6)} | passed ${fraction(t.passed, t.same).padStart(6)} | unsure ${fraction(t.unsure, t.checks).padStart(6)}${t.checks === 0 ? '' : ` (${((100 * t.unsure) / t.checks).toFixed(1)}%)`}`
const show = (v: Rescored, which: 'before' | 'now') => {
  for (const kind of [...KINDS, 'all'] as const) if (v[which][kind].checks > 0) console.log(line(kind, v[which][kind]))
}
for (const file of rescored) {
  for (const v of file.variants) {
    console.log(`${file.file} (${file.label}, ${v.variant}${file.repeats > 1 ? `, ${file.repeats} runs of each item` : ''}) - the stored verdicts are reproduced by the old bars: ${v.notReproduced === 0 ? 'every check' : `NOT for ${v.notReproduced} checks`}`)
    console.log(' old bars (PASS from 0.9, FAIL up to 0.2)')
    show(v, 'before')
    console.log(' new bars (screenshot 0.8 / 0.2, recording 0.8 / 0.4)')
    show(v, 'now')
  }
}

if (values.write !== undefined) {
  const out = {
    what: 'The visual-check results of 2026-10-15 judged again by the bars the user set that day (after the baseline and the animation redone with a TARGET box), from the probabilities the runs kept: no request was sent, the result files are untouched. `before` is the old bars (0.9 / 0.2 for every kind) and reproduces the stored verdicts; `now` is the mod\'s bars now.',
    date: values.date ?? new Date().toISOString().slice(0, 10),
    by: 'eval/rescore-visual-check.ts',
    bars: BARS_NOTE,
    results: rescored,
  }
  writeFileSync(values.write, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`written ${shown(values.write)}`)
}
