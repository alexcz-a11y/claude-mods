// Writes the problem summaries the long-context suite's flow variants carry (eval/datasets/long-context-summaries.json): for each
// item the record the mod would hold at the end of the deep conversation, written turn by turn by the same cheap model (haiku) from
// the mod's own prompt and read the mod's own way (decision/summary.ts: SUMMARY_SYSTEM, summaryPrompt, readSummary), with the
// person's messages moving the record as the dataset's `says` have it (lib/long-summaries.ts). The suite then asks with the
// summary, the count and the strong hint, so the flow is the same in every run (a summary is not written twice the same way).
//
//   node dispatch-pilot/eval/long-context-summaries.ts --estimate    how many items need writing and how many calls that is; nothing is asked
//   node dispatch-pilot/eval/long-context-summaries.ts               writes the missing ones; keeps those written for the same conversation
//
// Options: --concurrency 6 (items at once; the turns of one item are asked one after another), --only long-001,long-002,
// --force (write again those already written), --model haiku (the mod's summaryModel).
//
// `$.model.complete` exists only inside Claude Code, so each turn is one `claude -p` on the person's own login (their
// subscription), as bare as the CLI allows, as eval/profiles.ts does it: the system prompt is SUMMARY_SYSTEM alone, no tools, no
// thinking, no user or project settings, safe mode, no MCP, in an empty directory. The mod's own call also cuts the reply at 1000
// tokens (`maxTokens`); here the reply is read whole and then cut to the record's 500 tokens by `readSummary`, as the mod does.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { SUMMARY_SYSTEM } from '../hooks/decision/summary.ts'
import type { LongContextItem } from './lib/datasets.ts'
import { SUMMARY_FILE, type SummaryFile } from './lib/long-context.ts'
import { conversationOf, fingerprint, unresolvedCount } from './lib/long-conversation.ts'
import { writeSummary } from './lib/long-summaries.ts'
import { longContextItems } from './long-context-items.ts'
import { DATASETS_DIR, shown } from './node.ts'

const { values } = parseArgs({
  options: {
    estimate: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '6' },
    only: { type: 'string' },
    force: { type: 'boolean', default: false },
    model: { type: 'string', default: 'haiku' },
  },
})

const FILE = join(DATASETS_DIR, SUMMARY_FILE)
const SETTINGS = JSON.stringify({ enabledPlugins: { 'jev-pilot@jev-pilot': false }, alwaysThinkingEnabled: false })
const items: LongContextItem[] = longContextItems()
const only = values.only?.split(',')
const before: SummaryFile = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { items: {} }
const current = (item: LongContextItem) => {
  const kept = before.items[item.id]
  return kept !== undefined && kept.conversation === fingerprint(conversationOf(item, 'deep')) && kept.count === unresolvedCount(item) && kept.failed === 0
}
const due = items.filter((item) => (only === undefined || only.includes(item.id)) && (values.force || !current(item)))
const calls = due.reduce((sum, item) => sum + conversationOf(item, 'deep').length / 2, 0)
console.log(`${items.length} items: ${items.length - due.length} have a summary written for their conversation, ${due.length} to write now with ${values.model} (${calls} turns, one claude -p call each)`)
if (values.estimate || due.length === 0) process.exit(0)

const dir = mkdtempSync(join(tmpdir(), 'dp-summaries-'))
const systemFile = join(dir, 'system.txt')
writeFileSync(systemFile, SUMMARY_SYSTEM)
const answeredBy = new Set<string>(((before.about?.answered_by as string[] | undefined) ?? []))

/** One completion through `claude -p`: the reply's text, or null when there is none (an error, a timeout of a minute). */
function complete(prompt: string): Promise<string | null> {
  return new Promise((done) => {
    const args = ['-p', '--model', values.model, '--safe-mode', '--setting-sources', 'project', '--tools', '', '--system-prompt-file', systemFile, '--output-format', 'json', '--no-session-persistence', '--settings', SETTINGS, '--strict-mcp-config']
    const child = spawn('claude', args, { cwd: dir, env: { ...process.env, MAX_THINKING_TOKENS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill(), 60_000)
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => done(null))
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(out) as { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> }
        if (result.is_error || typeof result.result !== 'string') return done(null)
        for (const name of Object.keys(result.modelUsage ?? {})) answeredBy.add(name)
        done(result.result)
      } catch {
        done(null)
      }
    })
    child.stdin.end(prompt)
  })
}

const written: SummaryFile['items'] = { ...before.items }
let next = 0
let finished = 0
const save = () => {
  const ordered = Object.fromEntries(Object.entries(written).sort(([x], [y]) => (x < y ? -1 : 1)))
  const about = {
    what: "The problem summary the mod would hold at the end of each item's deep conversation: the cheap model's record continued after each turn with the mod's own prompt (decision/summary.ts), read the mod's way, the person's messages marking or clearing it as the dataset's `says` have it. Written by eval/long-context-summaries.ts.",
    model: values.model,
    answered_by: [...answeredBy].sort(),
    written: new Date().toISOString().slice(0, 10),
    how: `claude -p --model ${values.model} --safe-mode --setting-sources project --tools "" --system-prompt-file <SUMMARY_SYSTEM> --output-format json --no-session-persistence --settings '${SETTINGS}' --strict-mcp-config, MAX_THINKING_TOKENS=0, summaryPrompt on stdin, in an empty directory; up to 3 asks of a turn whose reply is no record`,
  }
  writeFileSync(FILE, `${JSON.stringify({ about, items: ordered }, null, 2)}\n`)
}
const worker = async () => {
  while (next < due.length) {
    const item = due[next++] as LongContextItem
    const result = await writeSummary(item, complete)
    if (result.summary === null) console.log(`  ${item.id}: no summary (${result.failed} of ${result.turns} turns got no record)`)
    else written[item.id] = { conversation: fingerprint(conversationOf(item, 'deep')), count: unresolvedCount(item), summary: result.summary, turns: result.turns, failed: result.failed }
    console.log(`  ${item.id}: ${result.turns} turns, ${result.failed} without a record (${++finished}/${due.length})`)
    save()
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker))
rmSync(dir, { recursive: true, force: true })
save()
const missing = items.filter((item) => written[item.id] === undefined)
console.log(`${shown(FILE)}: ${Object.keys(written).length} of ${items.length} items have a summary${missing.length > 0 ? `; none for ${missing.map((item) => item.id).join(', ')}` : ''}`)
process.exit(missing.length > 0 ? 1 : 0)
