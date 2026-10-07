// The eval v2 files (seam 2, #45): what the checks accept and refuse in a pool segment, an item and a gold file, the
// rules the authors write to (eval/datasets/eval-v2/FORMAT.md) and `eval/eval-v2-check.ts` and `eval/validate.ts` apply.

import { expect, test } from 'claude-code/testing'
import { checkGold, checkItem, checkSegment, datasetWarnings } from '../eval/lib/eval-v2.ts'

/** About `n` tokens of plain Chinese prose (one token a character), ending in a full stop. */
function prose(n: number): string {
  const sentence = '我顺着调用方往上读了一遍，把每一层传下来的参数和默认值都对了一下。'
  return sentence.repeat(Math.ceil(n / sentence.length)).slice(0, n - 1) + '。'
}

/** A well-formed same-problem segment of about 4000 tokens: the person asks to keep looking, the assistant reads and reports. */
function sameProblem(id: string, change: (segment: any) => void = () => {}): any {
  const segment = {
    id,
    domain: 'frontend',
    relation: 'same-problem',
    user: '{{FEATURE}} 那个问题先别急着改，帮我把 {{FILE}} 里 {{SYMBOL}} 的调用链理一遍，看看哪些路径会走到 `{{ERROR}}`',
    assistant: { text: `从 {{SYMBOL}} 往上追了三层调用方。${prose(3900)}`, tools: ['Grep', 'Read'] },
  }
  change(segment)
  return segment
}

/** A well-formed unrelated segment of about 4000 tokens: other work in the same repository, no placeholders. */
function unrelated(id: string, change: (segment: any) => void = () => {}): any {
  const segment = {
    id,
    domain: 'frontend',
    relation: 'unrelated',
    user: '帮我给 src/components/Header.tsx 的用户菜单加一个「切换语言」的入口',
    assistant: { text: `加好了，改了两个文件。${prose(3900)}`, tools: ['Read', 'Edit', 'Bash'] },
  }
  change(segment)
  return segment
}

test('a well-formed segment passes: same-problem with placeholders, unrelated without', () => {
  expect(checkSegment(sameProblem('frontend-same-problem-01'), 'frontend-same-problem-01').errors).toEqual([])
  expect(checkSegment(unrelated('frontend-unrelated-01'), 'frontend-unrelated-01').errors).toEqual([])
})

test('each broken segment rule is reported', () => {
  const errors = (segment: any, name = segment.id as string) => checkSegment(segment, name).errors.join('\n')
  expect(errors(sameProblem('frontend-same-problem-01'), 'frontend-same-problem-02')).toMatch(/id "frontend-same-problem-01" must be the file's name "frontend-same-problem-02"/)
  expect(errors(sameProblem('frontend-same-problem-1'))).toMatch(/id must be frontend-same-problem-<nn>/)
  expect(errors(sameProblem('ios-same-problem-01'))).toMatch(/id must be frontend-same-problem-<nn>/) // the domain says frontend
  expect(errors(sameProblem('mobile-same-problem-01', (s) => (s.domain = 'mobile')))).toMatch(/domain "mobile" is not one of frontend, backend-api/)
  expect(errors(sameProblem('frontend-related-01', (s) => (s.relation = 'related')))).toMatch(/relation "related" is not same-problem or unrelated/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => delete s.user))).toMatch(/user is missing/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.notes = 'x')))).toMatch(/unknown field notes/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.assistant = '一段回复')))).toMatch(/assistant must be \{ text, tools \}/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.assistant.tools = [])))).toMatch(/assistant.tools must be a non-empty array of tool names/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.assistant.tools = ['Read', 'Grep', 'Read'])))).toMatch(/assistant.tools names Read twice/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.assistant.text = `{{SYMBOL}} ${prose(2500)}`)))).toMatch(/\d+ tokens: a segment is 3000 to 5000/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.assistant.text = `{{SYMBOL}} ${prose(5200)}`)))).toMatch(/\d+ tokens: a segment is 3000 to 5000/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.user = '帮我再看看那个问题')))).toMatch(/user has no placeholder/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.assistant.text = prose(3950))))).toMatch(/assistant.text has no placeholder/)
  expect(errors(sameProblem('frontend-same-problem-01', (s) => (s.user += '，还有 {{BUG}}')))).toMatch(/\{\{BUG\}\} is not a placeholder/)
  expect(errors(unrelated('frontend-unrelated-01', (s) => (s.user += '，顺便看看 {{FILE}}')))).toMatch(/an unrelated segment has no placeholders: \{\{FILE\}\}/)
  expect(errors(unrelated('frontend-unrelated-01', (s) => (s.assistant.text += '<system-reminder>x</system-reminder>')))).toMatch(/<system-reminder>/)
  expect(errors(unrelated('frontend-unrelated-01', (s) => (s.assistant.text = '')))).toMatch(/assistant.text must be a non-empty string/)
  expect(errors('not an object' as any, 'x')).toMatch(/not a JSON object/)
})

test('the size is the mod\'s estimate of the two lines with the sample values in place of the placeholders', () => {
  // 2800 characters and twenty {{ERROR}}: under 3000 as written, over it once each {{ERROR}} is the sample error line.
  const segment = sameProblem('frontend-same-problem-01', (s) => (s.assistant.text = `${prose(2800)}${' `{{ERROR}}`'.repeat(20)}`))
  const checked = checkSegment(segment, 'frontend-same-problem-01')
  expect(checked.errors).toEqual([])
  expect(checked.tokens).toBeGreaterThan(3000)
})

test('what the checks cannot judge is a warning: an unknown tool name, a secret the mod would mask, a placeholder with one brace, a same-problem segment that seems to conclude, a segment of mostly quotes', () => {
  const warnings = (segment: any) => checkSegment(segment, segment.id).warnings.join('\n')
  expect(warnings(unrelated('frontend-unrelated-01', (s) => (s.assistant.tools = ['Read', 'read_file'])))).toMatch(/tool "read_file" is not a Claude Code tool/)
  expect(warnings(unrelated('frontend-unrelated-01', (s) => (s.assistant.text += ' 配置里写的是 api_key = "abcd1234efgh"')))).toMatch(/masks 1 .*\[REDACTED\]/)
  expect(warnings(unrelated('frontend-unrelated-01', (s) => (s.user += '，在 {FILE} 里')))).toMatch(/\{FILE\} looks like a placeholder/)
  expect(warnings(sameProblem('frontend-same-problem-01', (s) => (s.assistant.text += '这样就修好了。')))).toMatch(/does not conclude/)
  const json = '{"order":{"id":"A-1","items":[{"sku":"X","qty":1}],"note":"C:\\\\tmp\\\\a"}}\n'
  expect(warnings(unrelated('frontend-unrelated-01', (s) => (s.assistant.text = `接口返回的是：\n${json.repeat(70)}`)))).toMatch(/\d+% bigger as sent/)
  expect(warnings(sameProblem('frontend-same-problem-01'))).toBe('')
  expect(checkSegment(unrelated('frontend-unrelated-01', (s) => (s.assistant.tools = ['Read', 'read_file'])), 'frontend-unrelated-01').errors).toEqual([])
})

const VALUES = {
  FEATURE: '订单列表的分页',
  SYMPTOM: '翻到第二页时列表是空的',
  ERROR: "TypeError: Cannot read properties of undefined (reading 'items')",
  FILE: 'src/pages/orders/OrderList.tsx',
  FILE2: 'src/api/orders.ts',
  SYMBOL: 'useOrderPagination',
  COMMAND: 'npx vitest run src/pages/orders',
}

/** A well-formed same-problem item: a paging bug tried twice, said twice not to work, asked about again at the end. */
function item(id: string, change: (item: any) => void = () => {}): any {
  const result = {
    id,
    category: 'explicit-unresolved',
    domain: 'frontend',
    bin: 'd2',
    relation: 'same-problem',
    placeholders: { ...VALUES },
    opening: [],
    decisive: [
      { role: 'user', msg: 'd1', text: `订单列表翻到第二页是空的，控制台报 \`${VALUES.ERROR}\`，代码在 ${VALUES.FILE}，帮我查一下` },
      { role: 'assistant', text: `${VALUES.SYMBOL} 里 offset 按页码直接乘了页大小，第一页从 1 开始算，所以第二页跳过了。我改成 (page - 1) * size。`, tools: ['Read', 'Edit'] },
      { role: 'user', msg: 'd2', text: '还是空的，刷新了也一样' },
      { role: 'assistant', text: `那可能是 ${VALUES.FILE2} 把 page 参数丢了。我在请求里补上了 page。`, tools: ['Grep', 'Edit', 'Bash'] },
    ],
    final: [{ role: 'user', text: '回到分页那个问题，我刚又试了一下，第二页还是空的' }],
    middle_hint: '中间是同一个问题的继续排查：读调用链、加日志、看请求，没有新的尝试，也没有结论。',
  }
  change(result)
  return result
}

test('a well-formed item passes: same-problem with the placeholders\' values, unrelated with none, a command turn with its command', () => {
  expect(checkItem(item('explicit-unresolved-01'), 'explicit-unresolved-01').errors).toEqual([])
  const other = item('new-topic-03', (i) => ((i.category = 'new-topic'), (i.relation = 'unrelated'), (i.placeholders = {}), (i.bin = 'd4')))
  expect(checkItem(other, 'new-topic-03').errors).toEqual([])
  const command = item('command-turn-12', (i) => {
    i.category = 'command-turn'
    i.final = [{ role: 'user', text: '/debug 第二页还是空的', command: { name: 'debug', description: '系统地排查一个问题：复现、缩小范围、找到根因再修。' } }]
  })
  expect(checkItem(command, 'command-turn-12').errors).toEqual([])
})

test('each broken item rule is reported', () => {
  const errors = (changed: any, name = changed.id as string) => checkItem(changed, name).errors.join('\n')
  expect(errors(item('explicit-unresolved-01'), 'explicit-unresolved-02')).toMatch(/id "explicit-unresolved-01" must be the file's name "explicit-unresolved-02"/)
  expect(errors(item('resolved-01'))).toMatch(/id must be explicit-unresolved-<nn>/)
  expect(errors(item('unsure-01', (i) => (i.category = 'unsure')))).toMatch(/category "unsure" is not one of explicit-unresolved/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.bin = 'd5')))).toMatch(/bin "d5" is not one of d1, d2, d3, d4/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.relation = 'mixed')))).toMatch(/relation "mixed" is not same-problem or unrelated/)
  expect(errors(item('explicit-unresolved-01', (i) => delete i.placeholders.FILE2))).toMatch(/placeholders.FILE2 is missing/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.placeholders.BUG = 'x')))).toMatch(/placeholders has an unknown field BUG/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.placeholders.SYMPTOM = '第二页是空的\n第三页也是')))).toMatch(/placeholders.SYMPTOM must be one line of text/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.placeholders.FILE2 = i.placeholders.FILE)))).toMatch(/placeholders.FILE and FILE2 must differ/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.placeholders.SYMBOL = 'use Order Pagination')))).toMatch(/placeholders.SYMBOL must have no spaces/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.relation = 'unrelated')))).toMatch(/placeholders must be \{\} for an unrelated item/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.opening = [{ role: 'user', text: '先看看' }])))).toMatch(/opening must end with the assistant/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.opening = [{ role: 'assistant', text: '好' }, { role: 'user', text: '先看看' }])))).toMatch(/opening\[0\].role must be "user"/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.decisive = [])))).toMatch(/decisive must hold at least one round/)
  expect(errors(item('explicit-unresolved-01', (i) => i.decisive.pop()))).toMatch(/decisive must end with the assistant/)
  expect(errors(item('explicit-unresolved-01', (i) => delete i.decisive[2].msg))).toMatch(/decisive\[2\].msg must be "d2"/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.decisive[2].msg = 'd3')))).toMatch(/decisive\[2\].msg must be "d2"/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.decisive[1].msg = 'd2')))).toMatch(/decisive\[1\].msg: only a message of the person has an id/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.decisive[0].tools = ['Read'])))).toMatch(/decisive\[0\].tools: only the assistant calls tools/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.decisive[0].text = '{{FILE}} 里的分页坏了')))).toMatch(/decisive\[0\].text has \{\{FILE\}\}: an item is written out/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.decisive[1].note = 'x')))).toMatch(/decisive\[1\] has an unknown field note/)
  expect(errors(item('explicit-unresolved-01', (i) => i.final.push({ role: 'assistant', text: '好的' })))).toMatch(/final must end with the person's message/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.final[0].msg = 'f1')))).toMatch(/final\[0\].msg: only the decisive rounds carry ids/)
  expect(errors(item('command-turn-01', (i) => (i.category = 'command-turn')))).toMatch(/a command-turn item ends with a command/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.final[0].command = { name: 'debug', description: '排查' })))).toMatch(/only a command-turn item ends with a command/)
  expect(
    errors(item('command-turn-01', (i) => ((i.category = 'command-turn'), (i.final = [{ role: 'user', text: '帮我排查', command: { name: 'debug', description: '排查' } }])))),
  ).toMatch(/final's last message must start with \/debug/)
  expect(
    errors(item('explicit-unresolved-01', (i) => (i.final = [{ role: 'user', text: '先看看', command: { name: 'x', description: 'y' } }, { role: 'assistant', text: '好' }, { role: 'user', text: '还是空的' }]))),
  ).toMatch(/final\[0\].command: only the last message can be a command/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.decisive[1].text = '分页的逻辑我又读了一遍。'.repeat(800))))).toMatch(/decisive is \d+ tokens: at most 9000/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.final[0].text = '第二页还是空的。'.repeat(800))))).toMatch(/final is \d+ tokens: at most 6000/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.middle_hint = '')))).toMatch(/middle_hint must be a non-empty string/)
  expect(errors(item('explicit-unresolved-01', (i) => (i.gold = 'max')))).toMatch(/unknown field gold/)
})

test('an item that leaves its readers guessing gets warnings: a same-problem item whose rounds never name the placeholders\' values, earlier messages in final', () => {
  const warnings = (changed: any) => checkItem(changed, changed.id).warnings.join('\n')
  expect(warnings(item('explicit-unresolved-01'))).toBe('')
  const unnamed = item('explicit-unresolved-01', (i) => (i.decisive = [{ role: 'user', msg: 'd1', text: '列表翻页有问题' }, { role: 'assistant', text: '我看看。', tools: ['Read'] }]))
  expect(warnings(unnamed)).toMatch(/none of FILE, SYMBOL, ERROR appears in opening or decisive/)
  const longer = item('explicit-unresolved-01', (i) => (i.final = [{ role: 'user', text: '先跑一下测试' }, { role: 'assistant', text: '跑了，都过了。', tools: ['Bash'] }, { role: 'user', text: '第二页还是空的' }]))
  expect(warnings(longer)).toMatch(/final has 2 messages of the person: only the last is scored/)
})

/** A well-formed gold file for the item above, as either side writes it. */
function gold(id: string, change: (gold: any) => void = () => {}): any {
  const result = {
    id,
    effort: 'max',
    accept: ['xhigh', 'max'],
    effort_without_decisive: 'high',
    triage_final: 'still_unresolved',
    triage_decisive: [
      { msg: 'd1', triage: 'new_or_unrelated' },
      { msg: 'd2', triage: 'still_unresolved' },
    ],
    rationale: '分页问题已经改了两次都没好，这是第三次说还是空的：max，xhigh 也可以。删掉决定性几轮，只看最后一句是一般的调试：high。',
  }
  change(result)
  return result
}

test('a well-formed gold file passes, read against its item\'s decisive messages', () => {
  expect(checkGold(gold('explicit-unresolved-01'), 'explicit-unresolved-01', item('explicit-unresolved-01')).errors).toEqual([])
})

test('each broken gold rule is reported; the three-way answers are the mod\'s option names', () => {
  const errors = (changed: any, name = changed.id as string) => checkGold(changed, name, item('explicit-unresolved-01')).errors.join('\n')
  expect(errors(gold('explicit-unresolved-01'), 'explicit-unresolved-02')).toMatch(/id "explicit-unresolved-01" must be the file's name "explicit-unresolved-02"/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.effort = 'huge')))).toMatch(/effort "huge" is not an effort level/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.accept = ['high', 'max'])))).toMatch(/accept \["high","max"\] is not contiguous/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.accept = ['high', 'xhigh'])))).toMatch(/effort "max" is not in accept/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.effort_without_decisive = 'none')))).toMatch(/effort_without_decisive "none" is not an effort level/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.triage_final = 'unresolved')))).toMatch(/triage_final "unresolved" is not one of still_unresolved, resolved, new_or_unrelated/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.triage_decisive[1].triage = 'new')))).toMatch(/triage_decisive\[1\].triage "new" is not one of still_unresolved/)
  expect(errors(gold('explicit-unresolved-01', (g) => g.triage_decisive.pop()))).toMatch(/triage_decisive must answer d1, d2 in order/)
  expect(errors(gold('explicit-unresolved-01', (g) => g.triage_decisive.reverse()))).toMatch(/triage_decisive must answer d1, d2 in order/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.triage_decisive[0].note = 'x')))).toMatch(/triage_decisive\[0\] has an unknown field note/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.rationale = ' ')))).toMatch(/rationale must be a non-empty string/)
  expect(errors(gold('explicit-unresolved-01', (g) => delete g.effort_without_decisive))).toMatch(/effort_without_decisive is missing/)
  expect(errors(gold('explicit-unresolved-01', (g) => (g.triage = 'x')))).toMatch(/unknown field triage/)
})

test('a gold file without its item is checked on its own and warned about', () => {
  const checked = checkGold(gold('explicit-unresolved-01'), 'explicit-unresolved-01', null)
  expect(checked.errors).toEqual([])
  expect(checked.warnings.join('\n')).toMatch(/no items\/explicit-unresolved-01.json/)
})

test('the dataset\'s plan is checked as warnings while it is being written: items by category, bin and relation, domains per category, pool per domain, both golds per item', () => {
  const items = [item('explicit-unresolved-01'), item('explicit-unresolved-02'), item('resolved-01', (i) => ((i.category = 'resolved'), (i.relation = 'unrelated'), (i.placeholders = {})))]
  const segments = [sameProblem('frontend-same-problem-01'), unrelated('frontend-unrelated-01')]
  const warnings = datasetWarnings({ segments, items, authorGold: ['explicit-unresolved-01', 'resolved-01'], labelerGold: ['explicit-unresolved-01'] }).join('\n')
  expect(warnings).toMatch(/3 of 120 items/)
  expect(warnings).toMatch(/explicit-unresolved 2, .*resolved 1/)
  expect(warnings).toMatch(/d2 3/)
  expect(warnings).toMatch(/d2: 2 same-problem, 1 unrelated/)
  expect(warnings).toMatch(/explicit-unresolved covers 1 domain/)
  expect(warnings).toMatch(/frontend same-problem 1, frontend unrelated 1, backend-api same-problem 0/)
  expect(warnings).toMatch(/no gold-author file: explicit-unresolved-02/)
  expect(warnings).toMatch(/no gold-labeler file: explicit-unresolved-02, resolved-01/)
})
