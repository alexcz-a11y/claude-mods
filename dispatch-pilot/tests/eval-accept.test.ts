import { expect, test } from 'claude-code/testing'
import { levelsSent, ownMidrun } from '../eval/accept/lib/decisions.ts'
import { recordDir, turnEnded, turnSpan } from '../eval/accept/lib/records.ts'
import { paneCommand, pasted, screenState, sessionEnv, settingsFor } from '../eval/accept/lib/session.ts'
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
  const s = settingsFor({ arm: 'off', mode: 'code', key: 'K', userConfig: USER_CONFIG })
  expect(s.enabledPlugins).toEqual({ 'dispatch-pilot@alex-mods': false, 'dispatch-pilot-extras@alex-mods': false })
  expect(s.pluginConfigs['dispatch-pilot@inline']!.options).toEqual({
    enabled: true, mode: 'apply', backend: 'drex', drexApiKey: 'K', drexModel: 'drex-max-v1.1', submitShift: true, midrunShift: false, progressNote: false, agentModels: 'haiku,sonnet,opus',
  })
  expect(settingsFor({ arm: 'on', mode: 'code', key: 'K', userConfig: USER_CONFIG }).pluginConfigs['dispatch-pilot@inline']!.options.midrunShift).toBe(true)
})

test('settingsFor：Code Mode 按模式写进 env（盖过用户设置里的值）', () => {
  expect(settingsFor({ arm: 'on', mode: 'code', key: 'K', userConfig: USER_CONFIG }).env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' })
  expect(settingsFor({ arm: 'on', mode: 'ordinary', key: 'K', userConfig: USER_CONFIG }).env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '' })
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

test('screenState：信任对话框、权限请求、还在跑、空闲', () => {
  expect(screenState('Quick safety check\nIs this a project you created or one you trust?\n❯ 1. Yes, I trust this folder')).toBe('trust')
  expect(screenState('Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again')).toBe('permission')
  expect(screenState('✻ Working… (12s · esc to interrupt)')).toBe('busy')
  expect(screenState('❯ \n  ? for shortcuts')).toBe('idle')
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

test('ownMidrun：这次会话的轮由时间窗里它的 submit 决定；旧记录和别的轮不算', () => {
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
  expect(levelsSent(own.midrun!)).toEqual([{ from: 'medium', to: 'high', sent: 'high' }])
})

test('ownMidrun：时间窗里有两个会话的 submit：分不清，不算数', () => {
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
