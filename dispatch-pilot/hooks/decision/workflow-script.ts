// A Workflow script read just far enough to find its `agent()` calls, and to
// write a model and an effort into each one (#8).
//
// A script is plain JavaScript, and a mod has no JavaScript parser to import,
// so this reads it with a tokenizer that knows what a string, a template, a
// comment and a regular expression are. It finds each call's arguments, and
// edits the script as text, only at the spots it found: everything else comes
// back exactly as it was written. Anything it cannot read with confidence is
// left alone, never guessed at.
//
// Pure (see system-one.ts): no `$`; the mod, its tests and Node import it as it is.

/** One `agent()` call of a script, as far as it could be read. */
export type AgentCall = {
  /** Its place among the script's `agent()` calls in source order, from 0. */
  index: number
  /** The line it starts on, from 1. */
  line: number
  /** The prompt as written (a template keeps its `${...}`), for the decision model; null when the script builds it at run time. */
  prompt: string | null
  /** The `label` option as written; null when there is none or it is built at run time. */
  label: string | null
  /** The `agentType` option when it is a string; null otherwise. */
  agentType: string | null
  /** The `model` option: absent, a string the script wrote, or some other expression (`dynamic`). */
  model: { kind: 'none' } | { kind: 'literal'; value: string } | { kind: 'dynamic' }
  /** Where the edits go (internal to `rewriteWorkflow`); null for a call whose options cannot be edited. */
  edit: CallEdit | null
}

/** What `parseWorkflow` reads of a script. */
export type ParsedWorkflow = {
  /** The script itself, which `rewriteWorkflow` edits. */
  script: string
  /** What the script's `meta` block says about the workflow. */
  meta: { name: string | null; description: string | null }
  /** Every `agent()` call, in source order. */
  calls: AgentCall[]
}

/** What to write into one call: a model, an effort (`null` takes out the one the script wrote). */
export type CallWrite = { model?: string; effort?: string | null }

/** Where one call takes its edits: its options object, or the spot an options argument goes. */
type CallEdit = { kind: 'object'; object: ObjectLiteral } | { kind: 'append'; at: number; trailingComma: boolean }

/** One property of an options object literal. */
type Property = {
  /** The key when it is a plain identifier or a string (a shorthand `model` has one too); null for a spread, a computed key or a method. */
  key: string | null
  start: number
  end: number
  /** The value of `key: value`: where it is, and its text when it is a plain string or a template. */
  value: { start: number; end: number; text: string | null; interpolated: boolean } | null
}

/** An object literal's braces and properties. */
type ObjectLiteral = {
  open: number
  close: number
  properties: Property[]
  /** Where the last property's trailing comma ends, when it has one. */
  trailingCommaEnd: number | null
}

/** A lexical token; a template literal carries the code of its `${...}` as streams of their own. */
type Token = { kind: 'id' | 'num' | 'str' | 'tpl' | 're' | 'p'; text: string; start: number; end: number; streams?: Stream[] }

/** The tokens of a stretch of code, and for each opening bracket the index of its closing one. */
type Stream = { tokens: Token[]; pairs: Map<number, number> }

/**
 * Reads a Workflow script. Null when it cannot be read with confidence (an
 * unterminated string, brackets that do not pair, no `meta` block): the
 * caller leaves such a script alone.
 */
export function parseWorkflow(script: string): ParsedWorkflow | null {
  const lexed = lexStream(script, 0, false)
  if (lexed === null) return null
  const meta = readMeta(script, lexed.stream)
  if (meta === null) return null
  const calls: AgentCall[] = []
  findCalls(script, lexed.stream, calls, lineCounter(script))
  calls.forEach((call, index) => (call.index = index))
  return { script, meta, calls }
}

/**
 * The script with `writes[i]` written into its call `i` (`null`: the call is
 * left as it is). A model or effort goes into the call's options object, in
 * place of the one the script wrote or after the last property; a call
 * without options gets an object. Nothing else changes.
 */
export function rewriteWorkflow(parsed: ParsedWorkflow, writes: readonly (CallWrite | null)[]): string {
  const edits: Edit[] = []
  for (const call of parsed.calls) {
    const write = writes[call.index]
    if (write === undefined || write === null || call.edit === null) continue
    const edit = call.edit
    if (edit.kind === 'append') {
      const added = entriesOf(write)
      if (added.length > 0) edits.push({ start: edit.at, end: edit.at, text: `${edit.trailingComma ? ' ' : ', '}{ ${added.join(', ')} }` })
    } else {
      edits.push(...objectEdits(parsed.script, edit.object, write))
    }
  }
  // In one pass over the script. An edit that starts inside the one before it
  // (a call in a value that was replaced) is dropped: its text is gone.
  const pieces: string[] = []
  let at = 0
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < at) continue
    pieces.push(parsed.script.slice(at, edit.start), edit.text)
    at = edit.end
  }
  pieces.push(parsed.script.slice(at))
  return pieces.join('')
}

type Edit = { start: number; end: number; text: string }

/** The `model: 'x'` and `effort: 'y'` entries a write adds to an options object. */
function entriesOf(write: CallWrite): string[] {
  const entries: string[] = []
  if (write.model !== undefined) entries.push(`model: '${write.model}'`)
  if (typeof write.effort === 'string') entries.push(`effort: '${write.effort}'`)
  return entries
}

/**
 * The edits that put a write into an options object: the value of a `model`
 * or `effort` the script already wrote is replaced where it stands; one it
 * did not write goes after the last property. An effort to take out means the
 * object is written out again from its properties, without it.
 */
function objectEdits(src: string, object: ObjectLiteral, write: CallWrite): Edit[] {
  // The last property of a key is the one that counts, as in JavaScript.
  const existing = (key: string): Property | undefined => object.properties.findLast((property) => property.key === key)
  // What a property the script wrote is replaced with: its value, or all of it when it is a shorthand (`{ model }`).
  const replaced = new Map<Property, Edit>()
  const added: string[] = []
  let removed: Property | undefined
  const set = (key: 'model' | 'effort', value: string) => {
    const at = existing(key)
    if (at === undefined) added.push(`${key}: '${value}'`)
    else if (at.value !== null) replaced.set(at, { start: at.value.start, end: at.value.end, text: `'${value}'` })
    else replaced.set(at, { start: at.start, end: at.end, text: `${key}: '${value}'` })
  }
  if (write.model !== undefined) set('model', write.model)
  if (typeof write.effort === 'string') set('effort', write.effort)
  else if (write.effort === null) removed = existing('effort')
  if (removed !== undefined) {
    const kept = object.properties.filter((property) => property !== removed).map((property) => propertyText(src, property, replaced.get(property)))
    const body = [...kept, ...added].join(', ')
    return [{ start: object.open, end: object.close + 1, text: body === '' ? '{}' : `{ ${body} }` }]
  }
  const edits: Edit[] = [...replaced.values()]
  if (added.length > 0) {
    const text = added.join(', ')
    const last = object.properties[object.properties.length - 1]
    if (last === undefined) edits.push({ start: object.open, end: object.close + 1, text: `{ ${text} }` })
    else if (object.trailingCommaEnd !== null) edits.push({ start: object.trailingCommaEnd, end: object.trailingCommaEnd, text: ` ${text}` })
    else edits.push({ start: last.end, end: last.end, text: `, ${text}` })
  }
  return edits
}

/** A property's source text, with `edit` (a span inside it) applied when given. */
function propertyText(src: string, property: Property, edit: Edit | undefined): string {
  if (edit === undefined) return src.slice(property.start, property.end)
  return src.slice(property.start, edit.start) + edit.text + src.slice(edit.end, property.end)
}

// --- tokens -----------------------------------------------------------------

/** Words after which a `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

const ID_START = /[\p{ID_Start}_$]/u
const ID_PART = /[\p{ID_Continue}$‌‍]/u

/**
 * The tokens of the code from `from`: to the end of the script, or (inside a
 * template's `${`) to the `}` that closes it, whose offset is `end`. Null
 * when the code cannot be read: a string, template, comment or bracket that
 * does not end.
 */
function lexStream(src: string, from: number, inTemplate: boolean): { stream: Stream; end: number } | null {
  const tokens: Token[] = []
  let depth = 0
  let i = from
  const finish = (end: number): { stream: Stream; end: number } | null => {
    const pairs = pairBrackets(tokens)
    return pairs === null ? null : { stream: { tokens, pairs }, end }
  }
  while (i < src.length) {
    const c = src.charAt(i)
    const next = src.charAt(i + 1)
    if (/\s/.test(c)) {
      i++
    } else if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      i = end < 0 ? src.length : end + 1
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 2
    } else if (c === "'" || c === '"') {
      const end = endOfString(src, i)
      if (end === null) return null
      tokens.push({ kind: 'str', text: src.slice(i, end), start: i, end })
      i = end
    } else if (c === '`') {
      const template = lexTemplate(src, i)
      if (template === null) return null
      tokens.push(template)
      i = template.end
    } else if (c === '/' && regexAllowed(tokens.at(-1)) && endOfRegex(src, i) !== null) {
      const end = endOfRegex(src, i) as number
      tokens.push({ kind: 're', text: src.slice(i, end), start: i, end })
      i = end
    } else if (ID_START.test(c)) {
      let end = i + 1
      while (end < src.length && ID_PART.test(src.charAt(end))) end++
      tokens.push({ kind: 'id', text: src.slice(i, end), start: i, end })
      i = end
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next))) {
      let end = i + 1
      while (end < src.length && /[0-9A-Za-z_.]/.test(src.charAt(end))) end++
      tokens.push({ kind: 'num', text: src.slice(i, end), start: i, end })
      i = end
    } else if (c === '.' && next === '.' && src.charAt(i + 2) === '.') {
      tokens.push({ kind: 'p', text: '...', start: i, end: i + 3 })
      i += 3
    } else {
      if (c === '}' && inTemplate && depth === 0) return finish(i)
      if (c === '{') depth++
      else if (c === '}') depth--
      tokens.push({ kind: 'p', text: c, start: i, end: i + 1 })
      i++
    }
  }
  return inTemplate ? null : finish(src.length)
}

/** The template literal that starts at `start`: one token, its `${...}` code lexed as streams of their own; null when it never ends. */
function lexTemplate(src: string, start: number): Token | null {
  const streams: Stream[] = []
  let i = start + 1
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === '\\') {
      i += 2
    } else if (c === '`') {
      return { kind: 'tpl', text: src.slice(start, i + 1), start, end: i + 1, streams }
    } else if (c === '$' && src.charAt(i + 1) === '{') {
      const inner = lexStream(src, i + 2, true)
      if (inner === null) return null
      streams.push(inner.stream)
      i = inner.end + 1
    } else {
      i++
    }
  }
  return null
}

/** Whether a `/` after `previous` starts a regular expression (it divides after a value, a closing `)` or `]`). */
function regexAllowed(previous: Token | undefined): boolean {
  if (previous === undefined) return true
  switch (previous.kind) {
    case 'id':
      return BEFORE_REGEX.has(previous.text)
    case 'num':
    case 'str':
    case 'tpl':
    case 're':
      return false
    default:
      return previous.text !== ')' && previous.text !== ']'
  }
}

/** Where the regular expression that starts at `start` ends (past its flags); null when it does not close on its line, so the `/` divides. */
function endOfRegex(src: string, start: number): number | null {
  let i = start + 1
  let inClass = false
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === '\n') return null
    if (c === '\\') i++
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      i++
      while (i < src.length && /[A-Za-z]/.test(src.charAt(i))) i++
      return i
    }
    i++
  }
  return null
}

/** Where the string that starts at `start` ends (just past its closing quote); null when it never closes on its line. */
function endOfString(src: string, start: number): number | null {
  const quote = src.charAt(start)
  let i = start + 1
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === '\\') i++
    else if (c === quote) return i + 1
    else if (c === '\n') return null
    i++
  }
  return null
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** For each opening bracket's token index, its closing bracket's; null when they do not pair. */
function pairBrackets(tokens: readonly Token[]): Map<number, number> | null {
  const pairs = new Map<number, number>()
  const open: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind !== 'p') continue
    if (token.text in OPENERS) {
      open.push(i)
    } else if (token.text === ')' || token.text === ']' || token.text === '}') {
      const at = open.pop()
      if (at === undefined || OPENERS[(tokens[at] as Token).text] !== token.text) return null
      pairs.set(at, i)
    }
  }
  return open.length === 0 ? pairs : null
}

// --- meta -------------------------------------------------------------------

/** What the script's `export const meta = { ... }` says (its name and description when they are strings); null when the script has no such block. */
function readMeta(src: string, stream: Stream): ParsedWorkflow['meta'] | null {
  const { tokens, pairs } = stream
  for (let i = 0; i + 4 < tokens.length; i++) {
    if (!['export', 'const', 'meta', '=', '{'].every((text, k) => (tokens[i + k] as Token).text === text)) continue
    const object = readObject(src, stream, i + 4, pairs.get(i + 4) as number)
    if (object === null) return null
    const text = (key: string): string | null => {
      const value = object.properties.find((property) => property.key === key)?.value
      return value !== undefined && value !== null && !value.interpolated ? value.text : null
    }
    return { name: text('name'), description: text('description') }
  }
  return null
}

// --- calls ------------------------------------------------------------------

/** Adds the `agent()` calls of a stream, and of the code in its templates, to `calls`, in source order. */
function findCalls(src: string, stream: Stream, calls: AgentCall[], lineOf: (offset: number) => number): void {
  const { tokens } = stream
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind === 'tpl') {
      for (const inner of token.streams ?? []) findCalls(src, inner, calls, lineOf)
    } else if (isAgentCall(tokens, i)) {
      const call = readCall(src, stream, i, lineOf)
      if (call !== null) calls.push(call)
    }
  }
}

/** Whether token `i` is the `agent` of a call `agent(`: not a member (`x.agent(`) and not a declaration. */
function isAgentCall(tokens: readonly Token[], i: number): boolean {
  const token = tokens[i] as Token
  if (token.kind !== 'id' || token.text !== 'agent' || tokens[i + 1]?.text !== '(') return false
  const before = tokens[i - 1]
  return !(before !== undefined && (before.text === '.' || before.text === 'function'))
}

/** The arguments of the call whose `(` is token `open`: each one's first and last token index (inclusive), and whether a comma trails the last. */
function splitArguments(stream: Stream, open: number): { args: { first: number; last: number }[]; trailingComma: boolean } {
  const { tokens, pairs } = stream
  const close = pairs.get(open) as number
  const args: { first: number; last: number }[] = []
  let first = open + 1
  let trailingComma = false
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i] as Token
    if (token.kind === 'p' && token.text in OPENERS) {
      i = pairs.get(i) as number
    } else if (token.kind === 'p' && token.text === ',') {
      if (i > first) args.push({ first, last: i - 1 })
      first = i + 1
      trailingComma = i === close - 1
    }
  }
  if (close > first) args.push({ first, last: close - 1 })
  return { args, trailingComma }
}

function readCall(src: string, stream: Stream, at: number, lineOf: (offset: number) => number): AgentCall | null {
  const { tokens, pairs } = stream
  const open = at + 1
  const { args, trailingComma } = splitArguments(stream, open)
  const promptArg = args[0]
  if (promptArg === undefined || args.length > 2 || (tokens[promptArg.first] as Token).text === '...') return null
  const call: AgentCall = {
    index: 0,
    line: lineOf((tokens[at] as Token).start),
    prompt: textOf(src, tokens, promptArg.first, promptArg.last)?.text ?? null,
    label: null,
    agentType: null,
    model: { kind: 'none' },
    edit: null,
  }
  const optionsArg = args[1]
  if (optionsArg === undefined) {
    // After the prompt, or after the comma that trails it.
    const close = pairs.get(open) as number
    call.edit = { kind: 'append', at: (tokens[trailingComma ? close - 1 : promptArg.last] as Token).end, trailingComma }
    return call
  }
  const object = readObject(src, stream, optionsArg.first, optionsArg.last)
  if (object === null) return call
  call.edit = { kind: 'object', object }
  for (const property of object.properties) {
    const text = property.value !== null && !property.value.interpolated ? property.value.text : null
    if (property.key === 'label') call.label = property.value?.text ?? null
    else if (property.key === 'agentType') call.agentType = text
    else if (property.key === 'model') call.model = text === null ? { kind: 'dynamic' } : { kind: 'literal', value: text }
  }
  return call
}

/** The object literal that is exactly tokens `first`..`last`; null when those tokens are anything else. */
function readObject(src: string, stream: Stream, first: number, last: number): ObjectLiteral | null {
  const { tokens, pairs } = stream
  const open = tokens[first] as Token
  if (open.text !== '{' || pairs.get(first) !== last) return null
  const properties: Property[] = []
  let start = first + 1
  let trailingCommaEnd: number | null = null
  const push = (from: number, to: number) => {
    const head = tokens[from] as Token
    const colon = tokens[from + 1]
    const plain = (head.kind === 'id' || head.kind === 'str') && colon?.text === ':' && to > from + 1
    const shorthand = head.kind === 'id' && from === to
    const text = plain ? textOf(src, tokens, from + 2, to) : null
    properties.push({
      key: plain || shorthand ? (head.kind === 'str' ? (textOf(src, tokens, from, from)?.text ?? null) : head.text) : null,
      start: head.start,
      end: (tokens[to] as Token).end,
      value: plain ? { start: (tokens[from + 2] as Token).start, end: (tokens[to] as Token).end, text: text?.text ?? null, interpolated: text?.interpolated ?? false } : null,
    })
  }
  for (let i = first + 1; i < last; i++) {
    const token = tokens[i] as Token
    if (token.kind === 'p' && token.text in OPENERS) {
      i = pairs.get(i) as number
    } else if (token.kind === 'p' && token.text === ',') {
      if (i > start) push(start, i - 1)
      trailingCommaEnd = i === last - 1 ? token.end : null
      start = i + 1
    }
  }
  if (last > start) push(start, last - 1)
  return { open: open.start, close: (tokens[last] as Token).start, properties, trailingCommaEnd }
}

// --- text -------------------------------------------------------------------

/** The text of tokens `first`..`last` when they are one string or one template; a template keeps its `${...}` as written. */
function textOf(src: string, tokens: readonly Token[], first: number, last: number): { text: string; interpolated: boolean } | null {
  if (first !== last) return null
  const token = tokens[first] as Token
  if (token.kind === 'str') return { text: stringValue(token.text), interpolated: false }
  if (token.kind === 'tpl') return { text: src.slice(token.start + 1, token.end - 1), interpolated: (token.streams ?? []).length > 0 }
  return null
}

/** The line (from 1) of an offset; asked for in source order, it counts each line break once. */
function lineCounter(src: string): (offset: number) => number {
  let at = 0
  let line = 1
  return (offset) => {
    if (offset < at) {
      at = 0
      line = 1
    }
    for (; at < offset; at++) if (src.charCodeAt(at) === 10) line++
    return line
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

/** The value of a string literal's source text. */
function stringValue(literal: string): string {
  return literal.slice(1, -1).replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g, (_, braced?: string, unicode?: string, hex?: string, plain?: string) => {
    const code = braced ?? unicode ?? hex
    if (code !== undefined) return String.fromCodePoint(Number.parseInt(code, 16))
    if (plain === '\n' || plain === '\r\n') return ''
    return ESCAPES[plain as string] ?? (plain as string)
  })
}
