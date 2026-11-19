import { expect, test } from 'claude-code/testing'
import { ownMidrun } from '../eval/accept/lib/decisions.ts'
import { levelsOf, recordDir, turnEnded, turnSpan } from '../eval/accept/lib/records.ts'
import { holdsUser, noteDefault, paneCommand, pasted, ranWithNote, screenState, sessionEnv, settingsFor, trustSelected } from '../eval/accept/lib/session.ts'
import type { Decision } from '../hooks/log.ts'

const USER_CONFIG = {
  enabled: { type: 'boolean', default: true },
  mode: { type: 'string', default: 'apply' },
  backend: { type: 'string', default: 'drex' },
  drexApiKey: { type: 'string', default: '', sensitive: true },
  drexModel: { type: 'string', default: 'drex-max-v1.1' },
  submitShift: { type: 'boolean', default: true },
  midrunShift: { type: 'boolean', default: true },
  progressNote: { type: 'boolean', default: false },
  agentModels: { type: 'string', default: 'haiku,sonnet,opus' },
}

test('settingsFor：关掉装好的旧版，内联 mod 的选项是默认值加上这几项，midrunShift 按组', () => {
  const s = settingsFor({ arm: 'off', mode: 'code', key: 'K', userConfig: USER_CONFIG, note: false })
  expect(s.enabledPlugins).toEqual({ 'dispatch-pilot@alex-mods': false, 'dispatch-pilot-extras@alex-mods': false })
  expect(s.pluginConfigs['dispatch-pilot@inline']!.options).toEqual({
    enabled: true, mode: 'apply', backend: 'drex', drexApiKey: 'K', drexModel: 'drex-max-v1.1', submitShift: true, midrunShift: false, progressNote: false, agentModels: 'haiku,sonnet,opus',
  })
  expect(settingsFor({ arm: 'on', mode: 'code', key: 'K', userConfig: USER_CONFIG, note: false }).pluginConfigs['dispatch-pilot@inline']!.options.midrunShift).toBe(true)
})

test('settingsFor：进展记录按 --note 写进选项，不管清单的默认值', () => {
  const opts = (note: boolean) => settingsFor({ arm: 'on', mode: 'code', key: 'K', userConfig: USER_CONFIG, note }).pluginConfigs['dispatch-pilot@inline']!.options
  expect([opts(true).progressNote, opts(false).progressNote]).toEqual([true, false])
})

test('noteDefault：不给 --note 时取清单里 progressNote 的默认值', () => {
  expect(noteDefault({ progressNote: { type: 'boolean', default: true } })).toBe(true)
  expect(noteDefault({ progressNote: { type: 'boolean', default: false } })).toBe(false)
})

test('ranWithNote：accept.jsonl 的一行带 progressNote；之前记下的 16 行没有这个字段，读作关着', () => {
  expect([ranWithNote({ progressNote: true }), ranWithNote({ progressNote: false }), ranWithNote({ task: '01', arm: 'on' })]).toEqual([true, false, false])
})

test('settingsFor：Code Mode 按模式写进 env（盖过用户设置里的值）', () => {
  expect(settingsFor({ arm: 'on', mode: 'code', key: 'K', userConfig: USER_CONFIG, note: false }).env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' })
  expect(settingsFor({ arm: 'on', mode: 'ordinary', key: 'K', userConfig: USER_CONFIG, note: false }).env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '' })
})

test('sessionEnv：去掉遥测变量和 Nace 密钥；code 加上 Code Mode，ordinary 去掉它', () => {
  const env = { PATH: '/bin', OTEL_TRACES_EXPORTER: 'otlp', CLAUDE_CODE_ENABLE_TELEMETRY: '1', ENABLE_BETA_TRACING_DETAILED: '1', NACE_API_KEY: 'secret', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' }
  expect(sessionEnv(env, 'ordinary')).toEqual({ PATH: '/bin' })
  expect(sessionEnv(env, 'code')).toEqual({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' })
})

test('paneCommand：在 pane 里再清一遍环境，然后起会话；命令行上没有密钥', () => {
  const c = paneCommand({ pluginDir: '/repo/dispatch-pilot', settings: '/w/run/settings.json', model: 'sonnet', mode: 'ordinary' })
  expect(c.includes("; command claude --plugin-dir '/repo/dispatch-pilot' --settings '/w/run/settings.json' --model 'sonnet'")).toBe(true)
  expect(c.includes('unset CLAUDE_CODE_ENABLE_TELEMETRY ENABLE_BETA_TRACING_DETAILED NACE_API_KEY CLAUDE_CODE_EXPERIMENTAL_CODE_MODE')).toBe(true)
  expect(c.includes('OTEL_')).toBe(true)
  const code = paneCommand({ pluginDir: '/p', settings: '/s', model: 'opus', mode: 'code' })
  expect(code.includes('export CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1')).toBe(true)
  expect(() => paneCommand({ pluginDir: "/it's", settings: '/s', model: 'opus', mode: 'code' })).toThrow()
})

test('pasted：整段作为一次粘贴（多行不被当成几次回车），去掉末尾的换行', () => {
  expect(pasted('line 1\nline 2\n')).toBe('\x1b[200~line 1\nline 2\x1b[201~')
})

// Screens as 2.1.328 draws them (the controller's live trial): the trust dialog's menu starts on "No, exit".
const TRUST_SCREEN = 'Quick safety check\n Is this a project you created or one you trust?\n ❯ 1. No, exit\n   2. Yes, I trust this folder\n'
const READY_SCREEN = '▸ dispatch-pilot · medium\n────────\n❯ \n────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · 12% · 05:02\n\n\n'

test('screenState：信任对话框；输入框的 ❯ 行就是就绪；还在跑', () => {
  expect(screenState(TRUST_SCREEN)).toBe('trust')
  expect(screenState(READY_SCREEN)).toBe('ready')
  // capture-pane drops the space after an empty input box's marker.
  expect(screenState(READY_SCREEN.replace('❯ ', '❯'))).toBe('ready')
  expect(screenState('✻ Working… (12s · esc to interrupt)\n❯ \n')).toBe('busy')
  expect(screenState('starting…\n')).toBe('other')
})

test('screenState：权限请求只认屏幕底部 15 行里、带 ❯ 菜单行的', () => {
  const prompt = 'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No\n\n\n'
  expect(screenState(prompt)).toBe('permission')
  // The model's own text quoting the question, with no menu: not a prompt.
  expect(screenState('⏺ The script asks "Do you want to proceed?" before deleting.\n❯ \n')).toBe('ready')
  // A menu far above the bottom 15 lines is history, not the screen's prompt.
  const old = prompt + Array.from({ length: 20 }, (_, i) => 'line ' + i).join('\n') + '\n❯ \n'
  expect(screenState(old)).toBe('ready')
})

test('trustSelected：只有 ❯ 停在「Yes, I trust this folder」那一行才算选中', () => {
  expect(trustSelected(TRUST_SCREEN)).toBe(false)
  expect(trustSelected('Quick safety check\n   1. No, exit\n ❯ 2. Yes, I trust this folder\n')).toBe(true)
})

test('holdsUser：home 下或者路径里有用户名（不分大小写）都算', () => {
  expect(holdsUser('/private/tmp/dp-accept/01-on-code-x', '/Users/someone', 'someone')).toBe(false)
  expect(holdsUser('/Users/someone/work/x', '/Users/someone', 'someone')).toBe(true)
  expect(holdsUser('/private/tmp/SomeOne-runs/x', '/Users/someone', 'someone')).toBe(true)
  expect(holdsUser('/USERS/SOMEONE/x', '/Users/someone', '')).toBe(true)
})

test('levelsOf：主循环每一步带的 effort 依次排开，相邻重复的并成一个；shifts 是换了几次', () => {
  const at = (id: string, effort: string | undefined, extra: object = {}) => ({ type: 'assistant', isSidechain: false, timestamp: '2031-01-01T00:00:01.000Z', effort, message: { id, model: 'x', content: [{ type: 'text' }] }, ...extra })
  const records = [
    turnStart,
    at('m1', 'medium'),
    at('m1', 'medium'),
    at('m2', 'medium'),
    at('sub', 'low', { isSidechain: true, agentId: 'a' }),
    { type: 'assistant', isSidechain: false, isVirtual: true, effort: 'low', message: { id: 'v', model: '<synthetic>', content: [] } },
    at('m3', 'high'),
    at('m4', undefined),
    at('m5', 'high'),
    at('m6', 'medium'),
  ]
  expect(levelsOf(records)).toEqual({ levels: ['medium', 'high', 'medium'], shifts: 2 })
  expect(levelsOf([turnStart])).toEqual({ levels: [], shifts: 0 })
})

test('recordDir：会话目录按引擎的写法编码（非字母数字都换成 -）', () => {
  expect(recordDir('/h', '/private/tmp/dp-accept/01-on-code-x/project')).toBe('/h/.claude/projects/-private-tmp-dp-accept-01-on-code-x-project')
})

const turnStart = { type: 'user', isSidechain: false, turnPosition: { promptIndex: 1, turnIndex: 1 }, timestamp: '2031-01-01T00:00:00.000Z', message: { content: 'go' } }
const toolUse = { type: 'assistant', isSidechain: false, timestamp: '2031-01-01T00:00:01.000Z', message: { id: 'm1', model: 'x', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } }
const toolResult = { type: 'user', isSidechain: false, timestamp: '2031-01-01T00:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }
const final = { type: 'assistant', isSidechain: false, timestamp: '2031-01-01T00:00:04.000Z', message: { id: 'm2', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }
const duration = { type: 'system', subtype: 'turn_duration', isSidechain: false, durationMs: 4000, timestamp: '2031-01-01T00:00:04.500Z' }

test('turnEnded：主循环最后的回答结束了这一轮才算；还在等工具结果、只有子 agent 结束都不算', () => {
  expect(turnEnded([])).toBe(false)
  expect(turnEnded([turnStart, toolUse])).toBe(false)
  expect(turnEnded([turnStart, toolUse, toolResult])).toBe(false)
  expect(turnEnded([turnStart, toolUse, toolResult, { ...final, isSidechain: true, agentId: 'a' }])).toBe(false)
  expect(turnEnded([turnStart, toolUse, toolResult, final])).toBe(true)
  expect(turnEnded([turnStart, toolUse, duration])).toBe(true)
})

test('turnSpan：从这一轮的提示到 turn_duration（没有时到最后的回答）', () => {
  expect(turnSpan([turnStart, toolUse, toolResult, final, duration])).toEqual({ startedAt: Date.parse('2031-01-01T00:00:00.000Z'), endedAt: Date.parse('2031-01-01T00:00:04.500Z') })
  expect(turnSpan([turnStart, toolUse, toolResult, final])).toEqual({ startedAt: Date.parse('2031-01-01T00:00:00.000Z'), endedAt: Date.parse('2031-01-01T00:00:04.000Z') })
  expect(turnSpan([toolUse])).toBe(null)
})

function decision(id: string, kind: Decision['kind'], turnId: string | null, at: number, extra: Partial<Decision> = {}): Decision {
  return { id, at, kind, backend: 'drex', model: 'drex-max-v1.1', ms: 300, raw: null, from: 'medium', to: 'medium', reason: 'hold', detail: '', turnId, step: 0, bars: null, failure: null, requestId: null, applied: false, sent: null, ...extra }
}

test('ownMidrun：这次会话的轮由它开始时的 submit 决定；旧记录和别的轮不算', () => {
  const log = [
    decision('old', 'midrun', 'T0', 500),
    decision('s1', 'submit', 'T1', 1_200),
    decision('m1', 'midrun', 'T1', 3_000),
    decision('a1', 'agent', 'T1', 3_500),
    decision('m2', 'midrun', 'T1', 8_000, { from: 'medium', to: 'high', reason: 'contradicts-plan', applied: true, sent: 'high' }),
    decision('late', 'midrun', 'T9', 90_000),
  ]
  const own = ownMidrun(log, { seen: new Set(['old']), startedAt: 1_000, endedAt: 10_000 })
  expect(own.turnId).toBe('T1')
  expect(own.midrun!.map((d) => d.id)).toEqual(['m1', 'm2'])
})

test('ownMidrun：另一个会话的 submit 落在这一轮中间：仍认得出这一轮', () => {
  const log = [decision('s1', 'submit', 'T1', 1_200), decision('m1', 'midrun', 'T1', 3_000), decision('s2', 'submit', 'T2', 30_000), decision('m2', 'midrun', 'T2', 31_000), decision('m3', 'midrun', 'T1', 40_000)]
  const own = ownMidrun(log, { seen: new Set(), startedAt: 1_000, endedAt: 60_000 })
  expect(own.turnId).toBe('T1')
  expect(own.midrun!.map((d) => d.id)).toEqual(['m1', 'm3'])
})

test('ownMidrun：这一轮开始时有两个会话的 submit：分不清，不算数', () => {
  const log = [decision('s1', 'submit', 'T1', 1_200), decision('s2', 'submit', 'T2', 1_400), decision('m1', 'midrun', 'T1', 3_000)]
  const own = ownMidrun(log, { seen: new Set(), startedAt: 1_000, endedAt: 10_000 })
  expect(own.turnId).toBe(null)
  expect(own.midrun).toBe(null)
})

test('ownMidrun：没有 submit 记录时，时间窗里只有一个轮的中途记录就是它；没有任何记录是 0 条', () => {
  const one = ownMidrun([decision('m1', 'midrun', 'T1', 3_000)], { seen: new Set(), startedAt: 1_000, endedAt: 10_000 })
  expect(one.turnId).toBe('T1')
  expect(one.midrun!.length).toBe(1)
  const none = ownMidrun({ not: 'a log' }, { seen: new Set(), startedAt: 1_000, endedAt: 10_000 })
  expect(none.turnId).toBe(null)
  expect(none.midrun).toEqual([])
})
