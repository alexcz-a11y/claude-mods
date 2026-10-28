// The Workflow script reader and writer's own interface (#8): what it finds of
// a script's agent() calls, and the script it writes back. Pure, no `$`. Each
// case is a script as a main agent writes them; the writer's output is checked
// against the text a person would write by hand.

import { expect, test } from 'claude-code/testing'
import { parseWorkflow, rewriteWorkflow, type CallWrite, type ParsedWorkflow } from '../hooks/decision/workflow-script.ts'
import { problemBackground, problemFields, readingBackground, tellsTheWork } from '../hooks/decision/workflow.ts'
import { submissionOf } from '../hooks/decision/workflow-labels.ts'
import { summaryState } from '../hooks/decision/summary.ts'

const META = "export const meta = { name: 'demo', description: 'A demo workflow', phases: [] }\n"

function parse(script: string): ParsedWorkflow {
  const parsed = parseWorkflow(script)
  if (parsed === null) throw new Error('the script was not read')
  return parsed
}

/** The script with `write` written into every call. */
function rewriteAll(script: string, write: CallWrite): string {
  const parsed = parse(script)
  return rewriteWorkflow(parsed, parsed.calls.map(() => write))
}

test("an agent() in a comment or a string is no call, and an apostrophe in a comment does not open a string", () => {
  const script = `export const meta = { name: 'demo', description: "It's a demo", phases: [] }
// don't call agent('commented out') here
/* nor agent('block'), it's "quoted" */
const text = "agent('in a string')"
const other = 'agent("in another")'
const real = await agent('the real one')
`
  expect(parse(script).calls.map((call) => call.prompt)).toEqual(['the real one'])
})

test('a template literal prompt keeps its ${...} as written, and so does a template label', () => {
  const script = `${META}const files = args
await pipeline(files, (file) => agent(\`Migrate \${file} to the new API, keeping the exports.\`, { label: \`migrate:\${file}\` }))
`
  const [call] = parse(script).calls
  expect(call?.prompt).toBe('Migrate ${file} to the new API, keeping the exports.')
  expect(call?.label).toBe('migrate:${file}')
})

test('a template prompt without a ${...} is its value, escapes worked out, as a string is; one with a ${...} is kept as written and flagged', () => {
  const script = `${META}const a = await agent(\`first line\\nsecond line \\u4e2d\\u6587\`)
const b = await agent('keep the \${HOME} that this string holds')
const c = await agent(\`Migrate \${file}\\nnow\`)
`
  const [a, b, c] = parse(script).calls
  expect([a?.prompt, a?.promptTemplate]).toEqual(['first line\nsecond line 中文', undefined])
  expect([b?.prompt, b?.promptTemplate]).toEqual(['keep the ${HOME} that this string holds', undefined])
  expect([c?.prompt, c?.promptTemplate]).toEqual(['Migrate ${file}\\nnow', true])
})

test('a prompt tells the work unless it is a template whose own words are too few: a ${ in a string or a runtime task is only text', () => {
  expect(tellsTheWork('Fix the flaky test in src/a.test.ts and rerun it.')).toBe(true)
  expect(tellsTheWork('Replace ${HOME} in the file', false)).toBe(true)
  expect(tellsTheWork('Fix it.', true)).toBe(true)
  expect(tellsTheWork('${CONTEXT}\n\n${row.prompt}', true)).toBe(false)
  expect(tellsTheWork('Migrate ${file} to the new API, keeping the exports.', true)).toBe(true)
  expect(tellsTheWork(null)).toBe(false)
})

test("a template's interpolation is code: braces and quotes inside it do not end it early, and an agent() call inside it is found", () => {
  const script = `${META}const note = \`a \${ items.map((i) => \`\${i.name}}\`).join('}') } b \${ await agent('inside a template') } c\`
const real = await agent('after the template')
`
  expect(parse(script).calls.map((call) => call.prompt)).toEqual(['inside a template', 'after the template'])
})

test('a regular expression with quotes in it does not open a string, and a division is not a regular expression', () => {
  const script = `${META}const clean = (s) => s.replace(/['"\`]/g, '')
const half = total / 2
const quarter = half / 2 / 1
const real = await agent('after the regexes')
`
  expect(parse(script).calls.map((call) => call.prompt)).toEqual(['after the regexes'])
})

test('a call without options gets an options object, after the prompt or after the comma that trails it', () => {
  const script = `${META}const a = await agent('one')
const b = await agent(
  'two',
)
`
  expect(rewriteAll(script, { model: 'sonnet', effort: 'low' })).toBe(`${META}const a = await agent('one', { model: 'sonnet', effort: 'low' })
const b = await agent(
  'two', { model: 'sonnet', effort: 'low' }
)
`)
})

test('options are written in after the last property, formatting kept; an empty object is filled', () => {
  const script = `${META}const a = await agent('one', {})
const b = await agent('two', {
  label: 'b',
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, why: { type: 'string' } } },
})
const c = await agent('three', { label: 'c', transform: (x, y) => { return [x, y] } })
`
  expect(rewriteAll(script, { model: 'opus', effort: 'high' })).toBe(`${META}const a = await agent('one', { model: 'opus', effort: 'high' })
const b = await agent('two', {
  label: 'b',
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, why: { type: 'string' } } }, model: 'opus', effort: 'high'
})
const c = await agent('three', { label: 'c', transform: (x, y) => { return [x, y] }, model: 'opus', effort: 'high' })
`)
})

test("a model or effort the script wrote is replaced where it stands, whatever its key's quoting, or written out as a shorthand", () => {
  const script = `${META}const a = await agent('one', { model: 'opus', label: 'a', effort: 'max' })
const b = await agent('two', { 'model': "haiku", "effort": \`low\` })
const c = await agent('three', { model, label: 'c', effort })
`
  expect(rewriteAll(script, { model: 'sonnet', effort: 'medium' })).toBe(`${META}const a = await agent('one', { model: 'sonnet', label: 'a', effort: 'medium' })
const b = await agent('two', { 'model': 'sonnet', "effort": 'medium' })
const c = await agent('three', { model: 'sonnet', label: 'c', effort: 'medium' })
`)
})

test('an options object with a spread gets the model and effort after it, so they win', () => {
  const script = `${META}const a = await agent('one', { ...common, label: 'a' })\n`
  expect(rewriteAll(script, { model: 'sonnet', effort: 'low' })).toBe(`${META}const a = await agent('one', { ...common, label: 'a', model: 'sonnet', effort: 'low' })\n`)
})

test('options that are not an object literal are left alone: the call is found, but nothing is written into it', () => {
  const script = `${META}const opts = { label: 'x' }
const a = await agent('one', opts)
const b = await agent('two', cheap ? { effort: 'low' } : {})
`
  const parsed = parse(script)
  expect(parsed.calls.map((call) => call.prompt)).toEqual(['one', 'two'])
  expect(rewriteWorkflow(parsed, [{ model: 'sonnet', effort: 'low' }, { model: 'sonnet', effort: 'low' }])).toBe(script)
})

test('calls on one line, and a call inside another call\'s template, are all written, each in its place', () => {
  const script = `${META}const both = await parallel([() => agent('one', { label: 'one' }), () => agent('two')])
const nested = await agent(\`Judge \${await agent('inner', { label: 'inner' })}\`, { label: 'outer' })
`
  const parsed = parse(script)
  expect(parsed.calls.map((call) => call.prompt)).toEqual(['one', 'two', 'Judge ${await agent(\'inner\', { label: \'inner\' })}', 'inner'])
  expect(rewriteWorkflow(parsed, [{ model: 'haiku' }, { model: 'sonnet' }, { model: 'opus' }, { model: 'haiku' }])).toBe(`${META}const both = await parallel([() => agent('one', { label: 'one', model: 'haiku' }), () => agent('two', { model: 'sonnet' })])
const nested = await agent(\`Judge \${await agent('inner', { label: 'inner', model: 'haiku' })}\`, { label: 'outer', model: 'opus' })
`)
})

test('what the decision model reads of a call: its prompt as written, its label, its agent type, the model the script names, and where it is', () => {
  const script = `${META}
const a = await agent('It\\'s "quoted"\\nand two lines \\u4e2d\\u6587', { label: "三个文件", agentType: 'Explore', model: 'claude-sonnet-5-5' })
const b = await agent('plain', { model: pickModel(), label: label })
const c = await agent('plain', { model })
`
  const [a, b, c] = parse(script).calls
  expect(a).toMatchObject({ prompt: 'It\'s "quoted"\nand two lines 中文', label: '三个文件', agentType: 'Explore', model: { kind: 'literal', value: 'claude-sonnet-5-5' }, effort: { kind: 'none' }, line: 3 })
  expect(b).toMatchObject({ label: null, model: { kind: 'dynamic' }, line: 4 })
  expect(c?.model).toEqual({ kind: 'dynamic' })
})

test("the effort a script wrote is read the way its model is: a string, or an expression it works out when it runs", () => {
  const script = `${META}const a = await agent('one', { effort: 'high' })
const b = await agent('two', { effort: level })
const c = await agent('three', { label: 'c' })
`
  expect(parse(script).calls.map((call) => call.effort)).toEqual([{ kind: 'literal', value: 'high' }, { kind: 'dynamic' }, { kind: 'none' }])
})

test('a script that cannot be read is not read at all: an unterminated string or template or comment, brackets that do not pair, no meta block', () => {
  const unreadable = [
    `${META}const a = await agent('never closed)\n`,
    `${META}const a = await agent(\`never closed)\n`,
    `${META}/* never closed\nconst a = await agent('x')\n`,
    `${META}const a = await agent('x'\n`,
    `${META}const a = await agent('x'))\n`,
    `${META}const a = [1, 2)\n`,
    `const a = await agent('no meta block')\n`,
  ]
  expect(unreadable.map((script) => parseWorkflow(script))).toEqual(unreadable.map(() => null))
})

test('a method or a constructor that happens to be called agent is no call of the workflow API', () => {
  const script = `${META}const helper = { agent(prompt) { return prompt } }
const made = new agent('constructed')
const real = await agent('the real one')
`
  expect(parse(script).calls.map((call) => call.prompt)).toEqual(['the real one'])
})

test('only calls with a prompt and at most one options argument are calls: not agent(), agent(...args), or a call with extra arguments', () => {
  const script = `${META}const a = await agent()
const b = await agent(...args)
const c = await agent('x', {}, 'extra')
const d = await agent('the real one')
`
  expect(parse(script).calls.map((call) => call.prompt)).toEqual(['the real one'])
})

test('a script of tens of thousands of lines is read in well under a second', { timeoutMs: 30_000 }, () => {
  const body = Array.from({ length: 30_000 }, (_, i) => `const v${i} = await agent('Task number ${i} with a longer prompt that goes on a little', { label: 'task-${i}', schema: { type: 'object', properties: { a: { type: 'string' } } } })`).join('\n')
  const script = `${META}${body}\n`
  const started = Date.now()
  const parsed = parse(script)
  const rewritten = rewriteWorkflow(parsed, parsed.calls.map(() => ({ model: 'sonnet', effort: 'low' })))
  expect(parsed.calls).toHaveLength(30_000)
  expect(rewritten.length).toBeGreaterThan(script.length)
  // About 0.25 s alone, 7-8 s with three suites running at once on a busy machine (5 s, the test's own timeout then, was
  // not enough). A reader that rescans the script for each call scans it 30,000 times: minutes, far past 15 s.
  expect(Date.now() - started).toBeLessThan(15_000)
})

test('only a call of the global agent is a call: not a member, a declaration, another name, or an option called agentType', () => {
  const script = `${META}const a = helper.agent('member')
const b = helper?.agent('optional member')
function agent(prompt) { return prompt }
const c = myagent('longer name')
const d = agent2('suffix')
const e = agents('plural')
const f = await agent('the real one', { agentType: 'general-purpose', label: 'real' })
`
  const calls = parse(script).calls
  expect(calls.map((call) => call.prompt)).toEqual(['the real one'])
  expect(calls[0]?.agentType).toBe('general-purpose')
})

test('how a Workflow call hands over its script: a path, a name (or no script), a resume, or the script itself, in that order of precedence', () => {
  expect(submissionOf({ scriptPath: '/a.js', script: 'x', name: 'n' })).toEqual({ given: 'path' })
  expect(submissionOf({})).toEqual({ given: 'name' })
  expect(submissionOf({ script: 'x', name: 'n' })).toEqual({ given: 'name' })
  expect(submissionOf({ script: 'x', resumeFromRunId: 'wf_1' })).toEqual({ given: 'resume' })
  expect(submissionOf({ script: 'x' })).toEqual({ given: 'script', script: 'x' })
})

test("the background of a request: the problem summary and the count while there are any, the reading when there is one; what is absent, or a count of 0, is left out", () => {
  const summary = { problem: 'The build fails on CI.', tried: [{ text: 'Cleared the cache.' }], status: 'Still failing.' }
  expect(problemBackground(undefined, true)).toEqual({})
  expect(problemBackground({ count: 0 }, true)).toEqual({})
  expect(problemBackground({ count: 2 }, true)).toEqual({ unresolved_count: 2 })
  expect(problemBackground({ count: 0, summary }, true)).toEqual({ problem_summary: summaryState(summary) })
  expect(problemBackground({ count: 3, summary }, true)).toEqual({ problem_summary: summaryState(summary), unresolved_count: 3 })
  // The summary's switch off: the count still goes, the summary does not.
  expect(problemBackground({ count: 3, summary }, false)).toEqual({ unresolved_count: 3 })
  const kept = summaryState(summary)
  expect(problemFields({ problem_summary: kept, unresolved_count: 0 })).toEqual({ problem_summary: kept })
  expect(problemFields(undefined)).toEqual({})
  expect(readingBackground(undefined)).toEqual({})
  expect(readingBackground({ level: 2, images: 1 })).toEqual({ reference_complexity: { level: 2, images: 1 } })
})
