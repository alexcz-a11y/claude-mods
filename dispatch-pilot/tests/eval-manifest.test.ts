import { expect, test } from 'claude-code/testing'
import { OPTION_BARS, optionKey, readConfig } from '../hooks/config.ts'
import { DESCRIPTION_MAX, FREE_TEXT, TITLE_MAX, changeProblems, optionProblems } from '../eval/lib/manifest.ts'

const SECRET = ['drexApiKey', 'jevApiKey']

// A userConfig the checker accepts, built from the code's own defaults: switches, pickers of the default and one more
// choice the code reads, the two keys as sensitive strings, the two model names as free text; a short title and
// description each.
const OTHER: Record<string, string> = { mode: 'shadow', backend: 'jev', agentModels: 'haiku' }
function sound(): Record<string, Record<string, unknown>> {
  const c = readConfig({})
  const values: [string, unknown][] = Object.entries(c).filter(([k]) => k !== 'bars')
  for (const [group, fields] of Object.entries(OPTION_BARS)) for (const f of fields) values.push([optionKey(group, f), (c.bars as any)[group][f]])
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, v] of values) {
    const words = { title: '标题', description: '说明。' }
    if (SECRET.includes(key)) out[key] = { type: 'string', ...words, default: v, sensitive: true }
    else if ((FREE_TEXT as readonly string[]).includes(key)) out[key] = { type: 'string', ...words, default: v }
    else if (typeof v === 'boolean') out[key] = { type: 'boolean', ...words, default: v }
    else {
      const label = Array.isArray(v) ? v.join(',') : String(v)
      const other = typeof v === 'number' ? String(Math.round(v * 900) / 1000) : (OTHER[key] ?? label + '-b')
      out[key] = { type: 'string', ...words, options: [label, other], default: label }
    }
  }
  return out
}

test('optionProblems：照着代码的默认值写全的 userConfig 没有问题', () => {
  expect(optionProblems(sound())).toEqual([])
})

test('optionProblems：默认值读出来和 readConfig({}) 不一样、不在选项里、缺默认值', () => {
  const u = sound()
  u.midrunShiftGap = { ...u.midrunShiftGap, default: '4' }
  u.progressNote = { ...u.progressNote, default: false }
  u.agentDown = { ...u.agentDown, options: ['0.70', '0.95'], default: '0.70' }
  delete u.skillFits!.default
  expect(optionProblems(u)).toEqual([
    'midrunShiftGap: the default "4" is not one of its options',
    'progressNote: the default false is not readConfig({})\'s true',
    'agentDown: the default "0.70" is not readConfig({})\'s 0.95',
    'skillFits: no default',
  ])
})

test('optionProblems：除了两个密钥和两个模型名，每个选项都是开关或带选项的列表；每个选项读出来就是它写的值', () => {
  const u = sound()
  // A plain number: /plugin's Configure shows it blank while unset (measured on 2.1.328).
  u.midrunEverySteps = { type: 'number', title: '标题', description: '说明。', default: 8 }
  // A choice the clamp would move, and one too long for the engine.
  u.submitUp = { ...u.submitUp, options: ['0.7', '1.50'] }
  u.agentModels = { ...u.agentModels, options: ['haiku,sonnet,opus', 'haiku', 'x'.repeat(65)] }
  expect(optionProblems(u)).toEqual([
    'midrunEverySteps: no options, so /plugin shows no default; make it a picker',
    'agentModels: the choice "' + 'x'.repeat(65) + '" is not 1 to 64 characters',
    'agentModels: the choice "' + 'x'.repeat(65) + '" reads as "haiku,sonnet,opus"',
    'submitUp: the choice "1.50" reads as 0.99',
  ])
})

test('optionProblems：两个模型名是自由填写的例外：字符串，没有 options，默认值不空、就是 readConfig({}) 的', () => {
  expect(FREE_TEXT).toEqual(['drexModel', 'jevModel'])
  const u = sound()
  u.drexModel = { ...u.drexModel, options: ['drex-max-v1.1', 'drex-v2.0'] }
  u.jevModel = { ...u.jevModel, default: '' }
  expect(optionProblems(u)).toEqual(['drexModel: free text, so no options', 'jevModel: free text needs a default that is not blank'])
  const v = sound()
  v.drexModel = { ...v.drexModel, type: 'number' }
  v.jevModel = { ...v.jevModel, default: 'jev-1.14.0' }
  expect(optionProblems(v)).toEqual(['drexModel: free text whose type is not string', 'jevModel: the default "jev-1.14.0" is not readConfig({})\'s "jev-latest"'])
  // Not on the list: a plain string is still a picker to be.
  const w = sound()
  w.progressNoteModel = { type: 'string', title: '标题', description: '说明。', default: 'haiku' }
  expect(optionProblems(w)).toEqual(['progressNoteModel: no options, so /plugin shows no default; make it a picker'])
})

test('optionProblems：readConfig 不读的键，代码里有却没有键的选项', () => {
  const u = sound()
  u.submitNo = { type: 'string', title: '门槛', description: '说明。', options: ['0.30'], default: '0.30' }
  delete u.midrunShiftGap
  delete u.agentModelDown
  expect(optionProblems(u)).toEqual([
    'submitNo: readConfig has no field for it',
    'midrunShiftGap: a Config field with no option',
    'agentModelDown: a Config field with no option',
  ])
})

test(`optionProblems：标题最多 ${TITLE_MAX} 个字，说明最多 ${DESCRIPTION_MAX} 个字，都不能缺`, () => {
  const u = sound()
  u.board!.title = '一二三四五六七八九十一二三四五'
  u.mode!.description = '字'.repeat(DESCRIPTION_MAX + 1)
  delete u.backend!.title
  u.fallback!.description = ''
  u.verifyEffort!.title = '一二三四五六七八九十一二三四'
  u.skills!.description = '字'.repeat(DESCRIPTION_MAX)
  expect(optionProblems(u)).toEqual([
    `board: the title is 15 characters, more than ${TITLE_MAX}`,
    `mode: the description is 71 characters, more than ${DESCRIPTION_MAX}`,
    'backend: no title',
    'fallback: no description',
  ])
})

test('changeProblems：每个选项都要有改过去的值：开关翻过来，列表里的另一个值，一个密钥，自由填写的另一个名字；没有多出的键', () => {
  const u = {
    a: { type: 'boolean', default: true },
    b: { type: 'string', options: ['x', 'y'], default: 'x' },
    drexModel: { type: 'string', default: 'drex-max-v1.1' },
    k: { type: 'string', default: '', sensitive: true },
    d: { type: 'string', options: ['x', 'y'], default: 'x' },
  }
  expect(changeProblems(u, { a: false, b: 'y', drexModel: 'drex-v2.0', k: 'key', d: 'y' })).toEqual([])
  expect(changeProblems(u, { a: true, b: 'z', drexModel: 'drex-max-v1.1', k: 5, e: 'y' })).toEqual([
    'a: the changed value true is its default',
    'b: the changed value "z" is not one of its options',
    'drexModel: the changed value "drex-max-v1.1" is its default',
    'k: the changed value 5 is no key',
    'd: no changed value in tests/support/option-changes.ts',
    'e: in tests/support/option-changes.ts but not an option',
  ])
  // A blank name reads as the default, and null is no value: neither changes anything.
  expect(changeProblems(u, { a: false, b: null, drexModel: null, k: 'key', d: 'y' })).toEqual([
    'b: the changed value null is not one of its options',
    'drexModel: the changed value null is not a model name',
  ])
  expect(changeProblems(u, { a: false, b: 'y', drexModel: '  ', k: 'key', d: 'y' })).toEqual(['drexModel: the changed value "  " is not a model name'])
  expect(changeProblems(u, { a: false, b: 'y', drexModel: ' drex-max-v1.1 ', k: 'key', d: 'y' })).toEqual(['drexModel: the changed value " drex-max-v1.1 " is its default'])
})
