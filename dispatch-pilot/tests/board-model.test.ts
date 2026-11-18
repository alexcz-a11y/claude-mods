import { expect, test } from 'claude-code/testing'

import { readConfig } from '../hooks/config.ts'
import type { Decision } from '../hooks/log.ts'
import { boardModel, markOf } from '../hooks/board/model.ts'
import type { BoardState } from '../hooks/board/model.ts'
import { SCENES } from './support/scenes.ts'

// Compile-time: every scene is a complete BoardState as the state is now (scenes.ts imports nothing, so tsc checks it here).
const scenes: Record<keyof typeof SCENES, BoardState> = SCENES

const of = (name: keyof typeof SCENES, options: Record<string, unknown> = {}) => boardModel(readConfig({ drexApiKey: 'k', ...options }), scenes[name])

// The brief's nine.

test('中途升过一次档', () => {
  const m = of('up')
  expect(m.where).toBe('第 7 轮 · 第 10 步')
  expect([m.level, m.status.kind, m.status.text]).toEqual(['high', 'sent', '已发出'])
  expect(m.track).toHaveLength(10)
  expect(m.track[6]).toEqual({ level: 'high', sent: 'high', mark: 'up' })
  expect(m.shifts).toEqual([{ at: '第 6 步后', from: 'medium', to: 'high', why: '同一失败在修改后又出现', isSent: true }])
  expect(m.last).toMatchObject({ at: '第 9 步后', mark: 'hold', text: '不变', by: 'Drex · 312 ms' })
  expect(m.last?.nouls.map((n) => [n.label, n.reading])).toEqual([['同一失败又出现', 'no'], ['原因已查明', 'no'], ['只剩照做', 'no'], ['与计划矛盾', 'no']])
  expect(m.last?.rules).toEqual(['再升一档要上方合计 ≥ 0.80，现在 0.41', '降一档要下方合计 ≥ 0.70，现在 0.13'])
  expect(m.next).toMatchObject({ main: '下一份脚本结果到达时', ahead: 1 })
  expect(m.features.map((f) => f.state)).toEqual(['active', 'active', 'active', 'active', 'active', 'off'])
  expect(m.agents).toHaveLength(2)
})

test('刚发消息：第一格带着发消息那次评估的记号', () => {
  const m = of('start')
  expect(m.track).toEqual([{ level: 'high', sent: 'high', mark: 'up' }])
  expect(m.last).toMatchObject({ at: '发消息时', mark: 'up', text: '升到 high' })
  expect(m.skill).toBe('superpowers:systematic-debugging')
})

test('普通会话、评估失败', () => {
  const m = of('ordinary')
  expect(m.last).toMatchObject({ mark: 'fail', text: '评估失败，档位不变', probs: null, by: 'Drex 超时', rules: ['评估失败：超时，按规则放行'] })
  expect(m.next.main).toBe('再 8 步')
  expect(m.backend.isOk).toBe(false)
})

test('要换的档还没发出：两个档位都写出来', () => {
  const m = of('notsent')
  expect(m.status).toEqual({ kind: 'mismatch', text: '要 xhigh，实际发出 high' })
  expect(m.shifts.at(-1)).toMatchObject({ to: 'xhigh', isSent: false })
})

test('空闲：显示会话设定的档位', () => {
  const m = of('idle')
  expect([m.isIdle, m.level, m.status.kind, m.track.length]).toEqual([true, 'medium', 'idle', 0])
  expect(m.next).toMatchObject({ main: '发出下一条消息时', sub: '说「继续」这类话会从上一轮的 high 起算' })
})

test('已锁定', () => {
  const m = of('locked')
  expect(m.status).toEqual({ kind: 'locked', text: '已锁定' })
  expect(m.features.slice(0, 3).map((f) => f.state)).toEqual(['locked', 'locked', 'locked'])
  expect([m.last, m.next.main]).toEqual([null, '不评估'])
})

test('开着但不生效的功能写出原因', () => {
  expect(boardModel(readConfig({}), scenes.up).features[0]).toMatchObject({ state: 'inactive', note: '没有可用的后端' })
  expect(of('up', { mode: 'shadow' }).features[1]).toMatchObject({ state: 'inactive', note: '只记录，不改' })
  expect(boardModel(readConfig({ drexApiKey: 'k' }), { ...scenes.up, skills: [] }).features[3]).toMatchObject({ state: 'inactive', note: '还没拿到 skill 列表' })
  expect(of('up', { progressNote: true }).features[5]!.state).toBe('active')
})

test('下次评估的几种写法', () => {
  expect(of('up', { midrunEveryScripts: 3 }).next.main).toBe('再 3 份脚本结果')
  expect(of('up', { midrunMaxNotes: 1 }).next.main).toBe('本轮不再换挡')
  expect(of('up', { midrunShift: false }).next.main).toBe('本轮不再评估')
})

test('模型不收 effort', () => {
  const s = SCENES.start
  const m = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, session: { ...s.session, lastSent: null }, turn: { ...s.turn, wanted: null, base: null, track: [] } })
  expect(m.status).toEqual({ kind: 'none', text: '这个模型不收 effort' })
})

// Beyond the brief: every field of the six scenes, and states the scenes do not reach.

test('六个场景：其余各项', () => {
  const up = of('up')
  expect([up.isIdle, up.wanted, up.sent]).toEqual([false, 'high', 'high'])
  expect(up.track.map((c) => c.level)).toEqual(['medium', 'medium', 'medium', 'medium', 'medium', 'medium', 'high', 'high', 'high', 'high'])
  expect(up.track.map((c) => c.mark)).toEqual(['hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'up', 'hold', 'hold', 'hold'])
  expect(up.last?.probs).toEqual([0.03, 0.1, 0.46, 0.33, 0.08])
  expect(up.last?.nouls.map((n) => n.value)).toEqual([0.12, 0.22, 0.18, 0.09])
  expect(up.next).toEqual({ main: '下一份脚本结果到达时', sub: '每 1 份脚本结果评估一次 · 本轮还可换挡 3 次', ahead: 1 })
  expect(up.features).toEqual([
    { label: '发消息定档', state: 'active', note: '' },
    { label: '中途换挡', state: 'active', note: '每 1 份脚本结果' },
    { label: 'agent 定档', state: 'active', note: '本轮 2 个' },
    { label: 'skill 推荐', state: 'active', note: '62 个候选' },
    { label: '档位核对', state: 'active', note: '' },
    { label: '进展记录', state: 'off', note: '' },
  ])
  expect(up.backend).toEqual({ isOk: true, text: 'Drex drex-max-v1.1 · 可用' })
  expect(up.agents).toEqual([
    { type: 'Explore', text: 'haiku · low', isVerified: true },
    { type: 'general-purpose', text: 'sonnet · medium', isVerified: true },
  ])
  expect(up.skill).toBe(null)

  const start = of('start')
  expect(start.where).toBe('第 7 轮 · 第 1 步')
  expect(start.shifts).toEqual([{ at: '发消息时', from: 'medium', to: 'high', why: '要先查明一个原因未知的问题', isSent: true }])
  expect(start.last?.nouls).toEqual([
    { label: '机械重复', value: 0.04, reading: 'no' },
    { label: '原因未知', value: 0.81, reading: 'yes' },
    { label: '只是续做', value: 0.06, reading: 'no' },
  ])
  // A submit decision is weighed from the level it started at, up to max.
  expect(start.last?.rules).toEqual(['再升一档要上方合计 ≥ 0.70，现在 0.90', '降一档要下方合计 ≥ 0.70，现在 0.02'])
  expect(start.next).toEqual({ main: '下一份脚本结果到达时', sub: '每 1 份脚本结果评估一次 · 本轮还可换挡 4 次', ahead: 1 })
  expect(start.agents).toEqual([])

  const ordinary = of('ordinary')
  expect(ordinary.next).toEqual({ main: '再 8 步', sub: '每 8 步评估一次 · 同一失败复现或连续两步失败会提前', ahead: 8 })
  expect(ordinary.backend).toEqual({ isOk: false, text: 'Drex drex-max-v1.1 · 最近一次超时' })
  expect(ordinary.last).toMatchObject({ at: '第 13 步后', nouls: [] })
  expect(ordinary.features[1]).toEqual({ label: '中途换挡', state: 'active', note: '每 8 步' })
  expect(ordinary.track.map((c) => c.mark)).toEqual(['up', null, null, null, null, null, null, null, 'hold', null, null, null, null, 'fail'])

  const notsent = of('notsent')
  expect([notsent.level, notsent.wanted, notsent.sent]).toEqual(['high', 'xhigh', 'high'])
  expect(notsent.shifts).toEqual([
    { at: '第 3 步后', from: 'medium', to: 'high', why: '同一失败在修改后又出现', isSent: true },
    { at: '第 7 步后', from: 'high', to: 'xhigh', why: '最新结果和原计划矛盾', isSent: false },
  ])
  // Mid-run the cap is xhigh: from high one more level up is xhigh, with the stricter bar.
  expect(notsent.last).toMatchObject({ at: '第 7 步后', mark: 'up', text: '升到 xhigh', rules: ['再升一档要上方合计 ≥ 0.80，现在 0.80', '降一档要下方合计 ≥ 0.70，现在 0.05'] })
  expect(notsent.next).toMatchObject({ sub: '每 1 份脚本结果评估一次 · 本轮还可换挡 2 次' })

  const idle = of('idle')
  expect([idle.where, idle.wanted, idle.sent, idle.shifts, idle.agents, idle.skill]).toEqual(['空闲', null, 'high', [], [], null])
  expect(idle.status).toEqual({ kind: 'idle', text: '空闲' })
  // Between turns the last check is the last turn's last.
  expect(idle.last).toMatchObject({ at: '第 13 步后', mark: 'hold', by: 'Drex · 301 ms' })
  expect(idle.next.ahead).toBe(0)
  expect(idle.features[4]).toEqual({ label: '档位核对', state: 'active', note: '' })

  const locked = of('locked')
  expect([locked.level, locked.wanted, locked.where]).toEqual(['high', 'high', '第 2 轮 · 第 5 步'])
  expect(locked.next).toEqual({ main: '不评估', sub: '/dp unlock 解锁后恢复', ahead: 0 })
  expect(locked.features.slice(3).map((f) => f.state)).toEqual(['active', 'active', 'off'])
})

test('总能算出：空的 recent、raw 为 null 或没有 open、bars 为 null、没有格子、不认识的题、reason 为 null', () => {
  const s = scenes.up
  const cfg = readConfig({ drexApiKey: 'k' })
  const empty = boardModel(cfg, { ...s, recent: [] })
  expect([empty.last, empty.shifts, empty.agents, empty.skill]).toEqual([null, [], [], null])
  expect(empty.backend).toEqual({ isOk: true, text: 'Drex drex-max-v1.1 · 可用' })
  expect(empty.features[2]).toEqual({ label: 'agent 定档', state: 'active', note: '' })

  const base = s.recent.at(-1)!
  const odd: Decision = { ...base, raw: { odd_question: { type: 'noul', noul: 0.5 }, choice: { type: 'choice', choice: 'a', probabilities: { a: 1 } } }, bars: null, reason: null }
  const m = boardModel(cfg, { ...s, recent: [odd] })
  // No open answer: no distribution and no rules; an unknown question is shown by its key, read with the starting bars.
  expect(m.last).toMatchObject({ mark: 'hold', text: '不变', probs: null, rules: [], nouls: [{ label: 'odd_question', value: 0.5, reading: 'unsure' }] })

  const noRaw = boardModel(cfg, { ...s, recent: [{ ...base, raw: null }] })
  expect(noRaw.last).toMatchObject({ probs: null, nouls: [], rules: [] })

  // A shift with no reason has an empty why.
  const shift: Decision = { ...base, from: 'medium', to: 'high', reason: null, applied: true, sent: 'not-sent' }
  expect(boardModel(cfg, { ...s, recent: [shift] }).shifts).toEqual([{ at: '第 9 步后', from: 'medium', to: 'high', why: '', isSent: false }])

  // A turn with no cells yet: no step taken, the readout not yet due.
  const fresh = boardModel(cfg, { ...s, session: { ...s.session, lastSent: null }, turn: { ...s.turn!, track: [], stepNo: 0 } })
  expect([fresh.track, fresh.where, fresh.status.kind, fresh.level]).toEqual([[], '第 7 轮 · 第 0 步', 'unverified', 'high'])
  expect(fresh.status.text).toBe('未核对')
  expect(fresh.features[4]).toEqual({ label: '档位核对', state: 'active', note: '' })
  // Cells but no reading: the readout reads nothing.
  const unread = boardModel(cfg, { ...s, session: { ...s.session, lastSent: null } })
  expect(unread.features[4]).toEqual({ label: '档位核对', state: 'inactive', note: '读不到请求' })

  // The state as a fresh session holds it, before any turn.
  const nothing = boardModel(cfg, { session: { ...s.session, turnNo: 0, sessionLevel: null, previous: null, lastSent: null }, turn: null, recent: [], skills: [] })
  expect([nothing.isIdle, nothing.level, nothing.last, nothing.next]).toEqual([true, null, null, { main: '发出下一条消息时', sub: '', ahead: 0 }])
})

test('功能：mod 关着六行都是关；开关关着是关；锁定时关着的仍是关', () => {
  expect(of('up', { enabled: false }).features.map((f) => f.state)).toEqual(['off', 'off', 'off', 'off', 'off', 'off'])
  expect(of('locked', { midrunShift: false }).features.slice(0, 3).map((f) => f.state)).toEqual(['locked', 'off', 'locked'])
  const off = of('up', { submitShift: false, agentShift: false, skills: false, verifyEffort: false })
  expect(off.features.map((f) => f.state)).toEqual(['off', 'active', 'off', 'off', 'off', 'off'])
  // Without the backend's key the three judgements and the skills cannot ask; the rest do not need it.
  expect(boardModel(readConfig({}), scenes.up).features.map((f) => [f.state, f.note])).toEqual([
    ['inactive', '没有可用的后端'],
    ['inactive', '没有可用的后端'],
    ['inactive', '没有可用的后端'],
    ['inactive', '没有可用的后端'],
    ['active', ''],
    ['off', ''],
  ])
  // The progress note's model refused this session.
  const s = scenes.up
  expect(boardModel(readConfig({ drexApiKey: 'k', progressNote: true }), { ...s, session: { ...s.session, progressBlocked: true } }).features[5]).toEqual({ label: '进展记录', state: 'inactive', note: '模型被拒绝' })
  // Every N steps off: the row says how it is still evaluated.
  expect(of('ordinary', { midrunEverySteps: 0 }).features[1]).toEqual({ label: '中途换挡', state: 'active', note: '按步数的评估关着' })
})

test('后端：没有密钥；Jev；最近一次失败；进展记录的失败不算后端的', () => {
  const s = scenes.ordinary
  expect(boardModel(readConfig({}), s).backend).toEqual({ isOk: false, text: '没有密钥' })
  // Only the chosen backend's key counts.
  expect(boardModel(readConfig({ backend: 'jev', drexApiKey: 'k' }), s).backend).toEqual({ isOk: false, text: '没有密钥' })
  expect(boardModel(readConfig({ backend: 'jev', jevApiKey: 'k' }), scenes.up).backend).toEqual({ isOk: true, text: 'Jev jev-latest · 可用' })
  const progress: Decision = { ...s.recent.at(-1)!, id: 'p1', kind: 'progress', backend: null, model: 'haiku', failure: 'http', detail: 'HTTP 500' }
  const ok = scenes.up.recent.at(-1)!
  expect(boardModel(readConfig({ drexApiKey: 'k' }), { ...s, recent: [ok, progress] }).backend).toEqual({ isOk: true, text: 'Drex drex-max-v1.1 · 可用' })
  const http: Decision = { ...s.recent.at(-1)!, failure: 'model-mismatch' }
  expect(boardModel(readConfig({ drexApiKey: 'k' }), { ...s, recent: [http] }).backend).toEqual({ isOk: false, text: 'Drex drex-max-v1.1 · 最近一次应答的模型不对' })
  expect(boardModel(readConfig({ drexApiKey: 'k' }), { ...s, recent: [http] }).last).toMatchObject({ by: 'Drex 应答的模型不对', rules: ['评估失败：应答的模型不对，按规则放行'] })
})

test('下次评估：其余几种情形', () => {
  expect(of('up', { midrunEveryScripts: 0 }).next).toEqual({ main: '只在有新输入时', sub: '按脚本结果的评估关着', ahead: 0 })
  expect(of('ordinary', { midrunEverySteps: 0 }).next).toEqual({ main: '失败成簇时', sub: '按步数的评估关着', ahead: 0 })
  expect(of('up', { midrunShift: false }).next).toEqual({ main: '本轮不再评估', sub: '中途换挡关着', ahead: 0 })
  expect(boardModel(readConfig({}), scenes.up).next).toEqual({ main: '本轮不再评估', sub: '没有可用的后端', ahead: 0 })
  expect(of('up', { midrunMaxNotes: 1 }).next).toEqual({ main: '本轮不再换挡', sub: '说明条数已用完；有新输入时仍会评估', ahead: 0 })
  // Steps since the last check count down; never below one.
  const s = scenes.ordinary
  const later = (stepsSinceCheck: number) => boardModel(readConfig({ drexApiKey: 'k' }), { ...s, turn: { ...s.turn!, midrun: { ...s.turn!.midrun, stepsSinceCheck } } }).next
  expect([later(3).main, later(3).ahead, later(7).main, later(12).main]).toEqual(['再 5 步', 5, '再 1 步', '再 1 步'])
  const u = scenes.up
  const scripts = boardModel(readConfig({ drexApiKey: 'k', midrunEveryScripts: 3 }), { ...u, turn: { ...u.turn!, midrun: { ...u.turn!.midrun, scriptsSinceCheck: 2 } } }).next
  expect(scripts).toEqual({ main: '下一份脚本结果到达时', sub: '每 3 份脚本结果评估一次 · 本轮还可换挡 3 次', ahead: 1 })
  // Idle with no level from the last turn: no "continue" hint.
  const i = scenes.idle
  expect(boardModel(readConfig({ drexApiKey: 'k' }), { ...i, session: { ...i.session, previous: { ...i.session.previous!, level: null } } }).next.sub).toBe('')
})

test('markOf：失败、不变、升、降；没执行的是不变', () => {
  const d = { ...scenes.up.recent.at(-1)!, applied: true }
  expect([
    markOf({ ...d, failure: 'timeout' }),
    markOf(d),
    markOf({ ...d, from: 'medium', to: 'xhigh' }),
    markOf({ ...d, from: 'max', to: 'low' }),
    markOf({ ...d, from: null, to: null }),
    markOf({ ...d, from: 'medium', to: 'xhigh', applied: false }),
    markOf({ ...d, applied: false, failure: 'timeout' }),
  ]).toEqual(['fail', 'hold', 'up', 'down', 'hold', 'hold', 'fail'])
})

// Controller rulings after the first review round.

test('shadow 模式里想升档的决策：记号是不变，不算换挡，写「想升到 X，未执行」', () => {
  const s = scenes.start
  const wished = s.recent.map((d) => (d.kind === 'submit' ? { ...d, applied: false, sent: null } : d))
  const m = boardModel(readConfig({ drexApiKey: 'k', mode: 'shadow' }), { ...s, recent: wished })
  expect(m.shifts).toEqual([])
  // The evaluation itself is shown as any other: its distribution, answers and rules.
  expect(m.last).toMatchObject({ at: '发消息时', mark: 'hold', text: '想升到 high，未执行', probs: [0.02, 0.08, 0.25, 0.55, 0.1], by: 'Drex · 412 ms' })
  expect(m.last?.rules).toEqual(['再升一档要上方合计 ≥ 0.70，现在 0.90', '降一档要下方合计 ≥ 0.70，现在 0.02'])
  expect(m.last?.nouls.map((n) => n.reading)).toEqual(['no', 'yes', 'no'])
})

test('写入时被拒的换挡：不算换挡，写「想升到 / 想降到 X，未执行」', () => {
  const s = scenes.notsent
  const refused = s.recent.map((d) => (d.id === 't5-m7' ? { ...d, applied: false } : d))
  const m = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, recent: refused })
  expect(m.shifts).toEqual([{ at: '第 3 步后', from: 'medium', to: 'high', why: '同一失败在修改后又出现', isSent: true }])
  expect(m.last).toMatchObject({ at: '第 7 步后', mark: 'hold', text: '想升到 xhigh，未执行', rules: ['再升一档要上方合计 ≥ 0.80，现在 0.80', '降一档要下方合计 ≥ 0.70，现在 0.05'] })
  const down = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, recent: [{ ...s.recent.at(-1)!, to: 'medium', applied: false }] })
  expect([down.last?.mark, down.last?.text, down.shifts]).toEqual(['hold', '想降到 medium，未执行', []])
})

test('模型不收 effort：不评估', () => {
  const s = SCENES.start
  const m = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, turn: { ...s.turn, wanted: null, base: null, track: [] } })
  expect(m.next).toEqual({ main: '不评估', sub: '这个模型不收 effort', ahead: 0 })
})

test('mod 关着：不评估，六行都是关', () => {
  const m = of('up', { enabled: false })
  expect(m.next).toEqual({ main: '不评估', sub: 'dispatch-pilot 已关闭', ahead: 0 })
  expect(m.features.map((f) => f.state)).toEqual(['off', 'off', 'off', 'off', 'off', 'off'])
  // Idle stays idle: the next message is still when anything could happen.
  expect(of('idle', { enabled: false }).next.main).toBe('发出下一条消息时')
})

test('空闲且锁定：档位是锁定的档，状态是已锁定', () => {
  const s = scenes.idle
  const m = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, session: { ...s.session, lock: 'xhigh' } })
  expect([m.isIdle, m.level, m.wanted, m.status]).toEqual([true, 'xhigh', 'xhigh', { kind: 'locked', text: '已锁定' }])
  // Without a lock: the session's own level, nothing wanted.
  expect([of('idle').level, of('idle').wanted]).toEqual(['medium', null])
})
