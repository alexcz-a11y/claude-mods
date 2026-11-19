import { expect, test } from 'claude-code/testing'

import { readConfig } from '../hooks/config.ts'
import type { Decision } from '../hooks/log.ts'
import { SHIFTS_KEEP, boardModel, keepJudged, markOf } from '../hooks/board/model.ts'
import { judgedWithSent } from '../hooks/readout.ts'
import { footerLabel, paneSections, rowText, timelineRows } from '../hooks/board/view.ts'
import type { BoardState, TrackCell } from '../hooks/board/model.ts'
import { SCENES } from './support/scenes.ts'

// Compile-time: every scene is a complete BoardState as the state is now (scenes.ts imports nothing, so tsc checks it here).
const scenes: Record<keyof typeof SCENES, BoardState> = SCENES

const of = (name: keyof typeof SCENES, options: Record<string, unknown> = {}) => boardModel(readConfig({ drexApiKey: 'k', ...options }), scenes[name])

/**
 * The state with these Decisions recorded, as record() leaves them: in recent, and the turn's own submit and mid-run
 * ones kept on the turn (its last, its shifts); between turns the last one on the session.
 */
function judging(s: BoardState, list: readonly Decision[]): BoardState {
  const turn = s.turn
  const judged = list.filter((d) => (d.kind === 'submit' || d.kind === 'midrun') && (turn === null || d.turnId === turn.turnId))
  const lastJudged = judged.at(-1) ?? null
  if (turn === null) return { ...s, recent: list, session: { ...s.session, lastJudged } }
  const shifts = judged.filter((d) => markOf(d) === 'up' || markOf(d) === 'down')
  return { ...s, recent: list, turn: { ...turn, lastJudged, shifts } }
}

// The brief's nine.

test('中途升过一次档', () => {
  const m = of('up')
  expect(m.where).toBe('第 7 轮 · 第 10 步')
  expect([m.level, m.status.kind, m.status.text]).toEqual(['high', 'sent', '已发出'])
  expect(m.track).toHaveLength(10)
  expect(m.track[6]).toEqual({ level: 'high', sent: 'high', mark: 'up' })
  expect(m.shifts).toEqual([{ at: '第 6 步后', from: 'medium', to: 'high', why: '同一失败在修改后又出现', reading: 'sent' }])
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
  // Its note is still queued: not placed yet, so the requests could not carry it.
  expect(m.shifts.at(-1)).toMatchObject({ to: 'xhigh', reading: 'queued' })
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
    { type: 'Explore', text: 'haiku · low', reading: 'sent' },
    { type: 'general-purpose', text: 'sonnet · medium', reading: 'sent' },
  ])
  expect(up.skill).toBe(null)

  const start = of('start')
  expect(start.where).toBe('第 7 轮 · 第 1 步')
  expect(start.shifts).toEqual([{ at: '发消息时', from: 'medium', to: 'high', why: '问题比原先估计的更开放', reading: 'sent' }])
  expect(start.last?.nouls).toEqual([
    { label: '机械重复', value: 0.04, reading: 'no' },
    { label: '原因未知', value: 0.81, reading: 'yes' },
    { label: '只是续做', value: 0.06, reading: 'no' },
  ])
  // A shift made: one more level from the new one, then the bar the hop passed (the prototype's SC texts).
  expect(start.last?.rules).toEqual(['再升一档要上方合计 ≥ 0.80，现在 0.65', '升到这一档：上方合计 0.90，过了 0.70'])
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
    { at: '第 3 步后', from: 'medium', to: 'high', why: '同一失败在修改后又出现', reading: 'sent' },
    { at: '第 7 步后', from: 'high', to: 'xhigh', why: '最新结果和原计划矛盾', reading: 'queued' },
  ])
  // Mid-run the cap is xhigh, so no level further up; the shift came from a flag, so its reason says why.
  expect(notsent.last).toMatchObject({ at: '第 7 步后', mark: 'up', text: '升到 xhigh', rules: ['升到这一档：最新结果和原计划矛盾'] })
  // Just shifted (step 7): the next results within the gap are not asked, so the count waits for it (final review G6).
  expect(notsent.next).toMatchObject({ main: '再 3 份脚本结果', sub: '换挡后隔 3 份脚本结果才再评估 · 本轮还可换挡 2 次' })

  const idle = of('idle')
  expect([idle.where, idle.wanted, idle.sent, idle.shifts, idle.agents, idle.skill]).toEqual(['空闲', null, 'high', [], [], null])
  expect(idle.status).toEqual({ kind: 'idle', text: '空闲' })
  // Between turns the last check is the last turn's last.
  expect(idle.last).toMatchObject({ at: '此前 · 第 13 步后', mark: 'hold', by: 'Drex · 301 ms' })
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
  const empty = boardModel(cfg, judging(s, []))
  expect([empty.last, empty.shifts, empty.agents, empty.skill]).toEqual([null, [], [], null])
  expect(empty.backend).toEqual({ isOk: true, text: 'Drex drex-max-v1.1 · 可用' })
  expect(empty.features[2]).toEqual({ label: 'agent 定档', state: 'active', note: '' })

  const base = s.recent.at(-1)!
  const odd: Decision = { ...base, raw: { odd_question: { type: 'noul', noul: 0.5 }, choice: { type: 'choice', choice: 'a', probabilities: { a: 1 } } }, bars: null, reason: null }
  const m = boardModel(cfg, judging(s, [odd]))
  // No open answer: no distribution and no rules; an unknown question is shown by its key, read with the starting bars.
  expect(m.last).toMatchObject({ mark: 'hold', text: '不变', probs: null, rules: [], nouls: [{ label: 'odd_question', value: 0.5, reading: 'unsure' }] })

  const noRaw = boardModel(cfg, judging(s, [{ ...base, raw: null }]))
  expect(noRaw.last).toMatchObject({ probs: null, nouls: [], rules: [] })

  // A shift with no reason has an empty why.
  const shift: Decision = { ...base, from: 'medium', to: 'high', reason: null, applied: true, sent: 'not-sent' }
  expect(boardModel(cfg, judging(s, [shift])).shifts).toEqual([{ at: '第 9 步后', from: 'medium', to: 'high', why: '', reading: 'not-sent' }])

  // A turn with no cells yet: no step taken (starting: the level last seen), the readout not yet due.
  const fresh = boardModel(cfg, { ...s, session: { ...s.session, lastSent: null }, turn: { ...s.turn!, track: [], stepNo: 0 } })
  expect([fresh.track, fresh.where, fresh.status.kind, fresh.level]).toEqual([[], '第 7 轮 · 刚开始', 'starting', 'medium'])
  expect(fresh.status.text).toBe('这一轮刚开始')
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
  // Only the chosen backend's key counts; the row says which setting would use the other's (final review G3).
  expect(boardModel(readConfig({ backend: 'jev', drexApiKey: 'k' }), s).backend).toEqual({ isOk: false, text: 'Jev 没有密钥 · 要用 Drex 就把「决策模型的后端」改成 drex' })
  expect(boardModel(readConfig({ backend: 'jev', jevApiKey: 'k' }), scenes.up).backend).toEqual({ isOk: true, text: 'Jev jev-latest（未校准）· 可用' })
  const progress: Decision = { ...s.recent.at(-1)!, id: 'p1', kind: 'progress', backend: null, model: 'haiku', failure: 'http', detail: 'HTTP 500' }
  const ok = scenes.up.recent.at(-1)!
  expect(boardModel(readConfig({ drexApiKey: 'k' }), { ...s, recent: [ok, progress] }).backend).toEqual({ isOk: true, text: 'Drex drex-max-v1.1 · 可用' })
  const http: Decision = { ...s.recent.at(-1)!, failure: 'model-mismatch' }
  expect(boardModel(readConfig({ drexApiKey: 'k' }), judging(s, [http])).backend).toEqual({ isOk: false, text: 'Drex drex-max-v1.1 · 最近一次应答的模型不对' })
  expect(boardModel(readConfig({ drexApiKey: 'k' }), judging(s, [http])).last).toMatchObject({ by: 'Drex 应答的模型不对', rules: ['评估失败：应答的模型不对，按规则放行'] })
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
  // In shadow the turn still holds the level it would have set (wanted high); the steps go at the engine's own.
  // The step carried the engine's own medium, and its request was read so.
  const m = boardModel(readConfig({ drexApiKey: 'k', mode: 'shadow' }), judging({ ...s, session: { ...s.session, lastSent: 'medium' }, turn: { ...s.turn!, track: [{ level: 'medium', sent: 'medium', mark: 'hold' }] } }, wished))
  expect([m.wanted, m.level, m.status]).toEqual(['medium', 'medium', { kind: 'sent', text: '已发出' }])
  expect(m.shifts).toEqual([])
  // The evaluation itself is shown as any other: its distribution, answers and rules.
  expect(m.last).toMatchObject({ at: '发消息时', mark: 'hold', text: '想升到 high，未执行', probs: [0.02, 0.08, 0.25, 0.55, 0.1], by: 'Drex · 412 ms' })
  expect(m.last?.rules).toEqual(['再升一档要上方合计 ≥ 0.70，现在 0.90', '降一档要下方合计 ≥ 0.70，现在 0.02'])
  expect(m.last?.nouls.map((n) => n.reading)).toEqual(['no', 'yes', 'no'])
})

test('写入时被拒的换挡：不算换挡，写「想升到 / 想降到 X，未执行」', () => {
  const s = scenes.notsent
  const refused = s.recent.map((d) => (d.id === 't5-m7' ? { ...d, applied: false } : d))
  const m = boardModel(readConfig({ drexApiKey: 'k' }), judging(s, refused))
  expect(m.shifts).toEqual([{ at: '第 3 步后', from: 'medium', to: 'high', why: '同一失败在修改后又出现', reading: 'sent' }])
  expect(m.last).toMatchObject({ at: '第 7 步后', mark: 'hold', text: '想升到 xhigh，未执行', rules: ['再升一档要上方合计 ≥ 0.80，现在 0.80', '降一档要下方合计 ≥ 0.70，现在 0.05'] })
  const down = boardModel(readConfig({ drexApiKey: 'k' }), judging(s, [{ ...s.recent.at(-1)!, to: 'medium', applied: false }]))
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
  // Between turns too: the next message meets nothing either.
  expect(of('idle', { enabled: false }).next).toEqual({ main: '不评估', sub: 'dispatch-pilot 已关闭', ahead: 0 })
})

test('空闲且锁定：档位是锁定的档，状态是已锁定', () => {
  const s = scenes.idle
  const m = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, session: { ...s.session, lock: 'xhigh' } })
  expect([m.isIdle, m.level, m.wanted, m.status]).toEqual([true, 'xhigh', 'xhigh', { kind: 'locked', text: '已锁定' }])
  // Without a lock: the session's own level, nothing wanted.
  expect([of('idle').level, of('idle').wanted]).toEqual(['medium', null])
  // Locked but only watching: the lock is not written, so the session's own level.
  const watching = boardModel(readConfig({ drexApiKey: 'k', mode: 'shadow' }), { ...s, session: { ...s.session, lock: 'xhigh' } })
  expect([watching.level, watching.wanted, watching.status.kind]).toEqual(['medium', null, 'locked'])
})

// Second round of rulings.

test('mod 没有定档的轮：看板的档位是引擎自己的（这一步照原样带出去的）', () => {
  const s = scenes.up
  // A failed submit evaluation, or submitShift off: base set at step 0, nothing decided; the session's level moved since.
  const m = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, session: { ...s.session, sessionLevel: 'high', lastSent: 'high' }, turn: { ...s.turn!, base: 'medium', wanted: null } })
  expect([m.wanted, m.level, m.status]).toEqual(['high', 'high', { kind: 'sent', text: '已发出' }])
})

test('下次评估：关着和锁定先于空闲；空闲时按下一条消息真会遇到的写', () => {
  const s = scenes.idle
  const at = (options: Record<string, unknown>, session: Partial<BoardState['session']> = {}) => boardModel(readConfig(options), { ...s, session: { ...s.session, ...session } }).next
  expect(at({ drexApiKey: 'k' }, { lock: 'high' })).toEqual({ main: '不评估', sub: '/dp unlock 解锁后恢复', ahead: 0 })
  expect(at({ drexApiKey: 'k', enabled: false }, { lock: 'high' })).toEqual({ main: '不评估', sub: 'dispatch-pilot 已关闭', ahead: 0 })
  expect(at({})).toEqual({ main: '不评估', sub: '没有可用的后端', ahead: 0 })
  expect(at({ drexApiKey: 'k', submitShift: false })).toEqual({ main: '下一轮中途', sub: '发消息定档关着', ahead: 0 })
  expect(at({ drexApiKey: 'k', submitShift: false, midrunShift: false })).toEqual({ main: '不评估', sub: '发消息定档和中途换挡都关着', ahead: 0 })
  expect(at({ drexApiKey: 'k', midrunShift: false })).toEqual({ main: '发出下一条消息时', sub: '说「继续」这类话会从上一轮的 high 起算', ahead: 0 })
  // Inside a turn the mod off comes first as well, and a lock before a model without effort.
  const u = scenes.up
  const noEffort = { ...u, session: { ...u.session, lock: 'high' as const }, turn: { ...u.turn!, wanted: null, base: null } }
  expect(boardModel(readConfig({ drexApiKey: 'k' }), noEffort).next.sub).toBe('/dp unlock 解锁后恢复')
  expect(boardModel(readConfig({ drexApiKey: 'k', enabled: false }), noEffort).next.sub).toBe('dispatch-pilot 已关闭')
})

test('上次评估：这一轮还没有评估时是 null；空闲时是此前的最后一次', () => {
  const s = scenes.up
  const earlier = scenes.idle.recent
  // Only the last turn's (t4) evaluations recorded: none is this turn's (t7).
  expect(boardModel(readConfig({ drexApiKey: 'k' }), judging(s, earlier)).last).toBe(null)
  expect(boardModel(readConfig({ drexApiKey: 'k' }), judging({ ...s, turn: null }, earlier)).last).toMatchObject({ at: '此前 · 第 13 步后', mark: 'hold' })
  expect(boardModel(readConfig({ drexApiKey: 'k' }), judging({ ...s, turn: null }, [earlier[0]!])).last).toMatchObject({ at: '此前 · 发消息时' })
})

test('换挡之后的规则：从新档再走一档要多少，再写为什么到了这一档', () => {
  const s = scenes.up
  const cfg = readConfig({ drexApiKey: 'k' })
  const base = { ...s.recent.at(-1)!, applied: true }
  const rules = (d: Decision) => boardModel(cfg, judging(s, [d])).last?.rules
  // Down by a flag: one more level down from the new one, then the reason.
  const found: Decision = { ...base, from: 'high', to: 'medium', reason: 'cause-found', raw: { open: { type: 'score', score: 0.95, probabilities: [0.1, 0.8, 0.05, 0.05, 0] } } }
  expect(rules(found)).toEqual(['再降一档要下方合计 ≥ 0.70，现在 0.10', '降到这一档：原因已查明，剩下的是常规工作'])
  // Down by the open question: the bar the hop from high passed.
  const lessOpen: Decision = { ...base, kind: 'submit', from: 'high', to: 'medium', reason: 'less-open', raw: { open: { type: 'score', score: 1.25, probabilities: [0.1, 0.65, 0.15, 0.1, 0] } } }
  expect(rules(lessOpen)).toEqual(['再降一档要下方合计 ≥ 0.70，现在 0.10', '降到这一档：下方合计 0.75，过了 0.70'])
  // Down to low by the open question: no level further down; low alone carries 0.75, past the bar.
  const toLow: Decision = { ...lessOpen, from: 'medium', to: 'low', raw: { open: { type: 'score', score: 0.35, probabilities: [0.75, 0.15, 0.05, 0.05, 0] } } }
  expect(rules(toLow)).toEqual(['降到这一档：下方合计 0.75，过了 0.70'])
  // Up mid-run by the open question, from medium to high.
  const moreOpen: Decision = { ...base, from: 'medium', to: 'high', reason: 'more-open', raw: { open: { type: 'score', score: 2.4, probabilities: [0.02, 0.08, 0.4, 0.4, 0.1] } } }
  expect(rules(moreOpen)).toEqual(['再升一档要上方合计 ≥ 0.80，现在 0.50', '升到这一档：上方合计 0.90，过了 0.70'])
  // A hold keeps the margins either way from its level.
  expect(rules({ ...moreOpen, from: 'high', to: 'high', reason: 'hold' })).toEqual(['再升一档要上方合计 ≥ 0.80，现在 0.50', '降一档要下方合计 ≥ 0.70，现在 0.10'])
})

test('只说接着做（裁定 C38）：换挡记录和上次评估都写出沿用上一轮的档位，不列 open 的余量', () => {
  const s = scenes.up
  const cfg = readConfig({ drexApiKey: 'k' })
  const open = { type: 'score' as const, score: 0.4, probabilities: [0.8, 0.14, 0.03, 0.02, 0.01] }
  const up: Decision = { ...s.recent.at(-1)!, kind: 'submit', step: 0, applied: true, from: 'medium', to: 'xhigh', reason: 'continues', raw: { open } }
  const why = '消息只是让接着做，沿用上一轮的档位'
  const m = boardModel(cfg, judging(s, [up]))
  expect(m.last).toMatchObject({ at: '发消息时', mark: 'up', text: '升到 xhigh', rules: [`升到这一档：${why}`] })
  expect(m.shifts).toEqual([{ at: '发消息时', from: 'medium', to: 'xhigh', why, reading: 'unverified' }])
  // The session already at the previous turn's level: no shift, and still why the level stays.
  const kept = boardModel(cfg, judging(s, [{ ...up, from: 'xhigh' }]))
  expect(kept.last).toMatchObject({ mark: 'hold', text: '不变', rules: [`档位不变：${why}`] })
  expect(kept.shifts).toEqual([])
})

test('会话种类：照 session.codeMode 写 Code Mode 会话或普通会话，空闲时也有；六个场景和原型一致', () => {
  const kinds = Object.fromEntries((Object.keys(scenes) as (keyof typeof SCENES)[]).map((k) => [k, of(k).sessionKind]))
  // The prototype's session field of each scene (docs/research/board-prototype/timeline-and-pane.html).
  expect(kinds).toEqual({ up: 'Code Mode 会话', start: 'Code Mode 会话', ordinary: '普通会话', notsent: 'Code Mode 会话', idle: 'Code Mode 会话', locked: '普通会话' })
  const plainIdle: BoardState = { ...scenes.idle, session: { ...scenes.idle.session, codeMode: false } }
  expect(boardModel(readConfig({ drexApiKey: 'k' }), plainIdle).sessionKind).toBe('普通会话')
  const codeTurn: BoardState = { ...scenes.ordinary, session: { ...scenes.ordinary.session, codeMode: true } }
  expect(boardModel(readConfig({ drexApiKey: 'k' }), codeTurn).sessionKind).toBe('Code Mode 会话')
})

test('Jev 标「未校准」：后端行（可用和失败时）、上次评估的 by；Drex 答的不变，经 fallback 也一样', () => {
  const jev = readConfig({ backend: 'jev', jevApiKey: 'k' })
  const asJev = (s: BoardState): BoardState => judging(s, s.recent.map((d) => (d.backend === null ? d : { ...d, backend: 'jev' as const })))
  expect(boardModel(jev, scenes.up).backend).toEqual({ isOk: true, text: 'Jev jev-latest（未校准）· 可用' })
  expect(boardModel(jev, asJev(scenes.ordinary)).backend).toEqual({ isOk: false, text: 'Jev jev-latest（未校准）· 最近一次超时' })
  expect(boardModel(jev, asJev(scenes.ordinary)).last).toMatchObject({ by: 'Jev（未校准） 超时' })
  expect(boardModel(jev, asJev(scenes.up)).last).toMatchObject({ by: 'Jev（未校准） · 312 ms' })
  // Backend jev chosen, but this decision was answered by Drex (the fallback): Drex's wording, unchanged.
  expect(boardModel(jev, scenes.up).last).toMatchObject({ by: 'Drex · 312 ms' })
  expect(boardModel(readConfig({ drexApiKey: 'k' }), scenes.up).backend).toEqual({ isOk: true, text: 'Drex drex-max-v1.1 · 可用' })
})

test('agent 行只写类型：派出时因为不知道而没动模型的说明不进类型这一栏', () => {
  const s = scenes.up
  const left = s.recent.map((d) => (d.id === 't7-a1' ? { ...d, detail: 'Explore · 模型没动：还不知道这个类型是否沿用主 agent 的模型', to: 'inherit · low' } : d))
  expect(boardModel(readConfig({ drexApiKey: 'k' }), { ...s, recent: left }).agents.map((a) => [a.type, a.text])).toEqual([
    ['Explore', 'inherit · low'],
    ['general-purpose', 'sonnet · medium'],
  ])
})

// Final review I1: what the board shows of a turn's evaluations is kept on the turn, not taken from recent (30 kept).

/** n mid-run holds at high, after steps from+1 on, as the decision log keeps them. */
function holdsAfter(turnId: string, from: number, n: number): Decision[] {
  const base = scenes.up.recent.at(-1)!
  return Array.from({ length: n }, (_, i) => ({ ...base, id: `${turnId}-h${from + i + 1}`, turnId, step: from + i + 1, from: 'high', to: 'high', reason: 'hold' as const, applied: false }))
}

test('长的一轮：第 1 步后升档、之后 30 次不变，再派出 40 个 agent：换挡记录、最近一次换挡和上次评估都还在', () => {
  const s = scenes.up
  const cfg = readConfig({ drexApiKey: 'k' })
  const shift: Decision = { ...s.recent.find((d) => d.id === 't7-m6')!, id: 't7-up1', step: 1, sent: 'high' }
  const holds = holdsAfter('t7', 1, 30)
  const turn = { ...s.turn!, shifts: [shift], lastJudged: holds.at(-1)! }
  const agent = s.recent.find((d) => d.id === 't7-a1')!
  const agents = Array.from({ length: 40 }, (_, i) => ({ ...agent, id: `t7-x${i}` }))
  // recent holds the last 30 only: the 30 holds, then nothing but the agents.
  for (const recent of [[shift, ...holds].slice(-30), [...holds, ...agents].slice(-30)]) {
    const m = boardModel(cfg, { ...s, turn, recent })
    expect(m.shifts.map((x) => [x.at, x.from, x.to])).toEqual([['第 1 步后', 'medium', 'high']])
    expect(m.last).toMatchObject({ at: '第 31 步后', mark: 'hold', text: '不变' })
    // The timeline's marks row tells the last shift; the pane lists it and the last evaluation.
    const rows = timelineRows(m, { columns: 160, isPaneOpen: false }).map(rowText)
    expect(rows.find((r) => r.startsWith('评 '))).toContain('第 1 步后 medium → high')
    expect(rows.find((r) => r.startsWith('上次评估'))).toContain('不变')
    const shifts = paneSections(m).find((x) => x.id === 'shifts')!.rows.map(rowText)
    expect(shifts[0]).toContain('medium → high')
  }
})

test('keepJudged：每条评估都成为这一轮的上次评估，换了档的进换挡记录，最多 SHIFTS_KEEP 条；judgedWithSent 改两处的副本', () => {
  const t = { ...scenes.up.turn!, lastJudged: null, shifts: [] }
  const hold = scenes.up.recent.find((d) => d.id === 't7-m9')!
  const shift = scenes.up.recent.find((d) => d.id === 't7-m6')!
  let kept = keepJudged(t, hold)
  expect([kept.lastJudged?.id, kept.shifts, kept.pendingMark]).toEqual(['t7-m9', [], 'hold'])
  for (let i = 0; i < SHIFTS_KEEP + 3; i++) kept = keepJudged(kept, { ...shift, id: 's' + i, sent: null })
  expect(kept.shifts).toHaveLength(SHIFTS_KEEP)
  expect([kept.shifts[0]!.id, kept.lastJudged?.id, kept.pendingMark]).toEqual(['s3', 's' + (SHIFTS_KEEP + 2), 'up'])
  // A reading amends the copies the turn keeps; one that changes nothing gives null.
  const last = 's' + (SHIFTS_KEEP + 2)
  const amended = judgedWithSent(kept, last, 'high')!
  expect([amended.lastJudged?.sent, amended.shifts.at(-1)?.sent]).toEqual(['high', 'high'])
  expect(judgedWithSent(amended, last, 'high')).toBe(null)
  expect(judgedWithSent(amended, 'nope', 'high')).toBe(null)
})

test('两轮之间的「此前」取上一轮结束时留在会话里的那次评估，不看 recent', () => {
  const s = scenes.idle
  const cfg = readConfig({ drexApiKey: 'k' })
  const kept = s.session.lastJudged!
  // recent has moved on (agents only, as after many spawns), the session still holds the last turn's last.
  const agent = scenes.up.recent.find((d) => d.id === 't7-a1')!
  const m = boardModel(cfg, { ...s, recent: Array.from({ length: 30 }, (_, i) => ({ ...agent, id: `x${i}` })) })
  expect(m.last).toMatchObject({ at: '此前 · 第 13 步后', mark: 'hold', by: 'Drex · 301 ms' })
  expect(kept.id).toBe('t4-m13')
  // Nothing judged in any turn so far: none.
  expect(boardModel(cfg, { ...s, session: { ...s.session, lastJudged: null } }).last).toBe(null)
})

// Final review I2: three readings, each with its own words; the status takes the current step's own reading.

test('换挡的读数：读到且一样是已发出，读到但不一样是没发出，没读到是未核对；说明还排着的是还没发出', () => {
  const s = scenes.up
  const cfg = readConfig({ drexApiKey: 'k' })
  const shift = s.recent.find((d) => d.id === 't7-m6')!
  const reading = (sent: Decision['sent'], turn = s.turn!) => boardModel(cfg, judging({ ...s, turn }, [{ ...shift, sent }])).shifts[0]!.reading
  expect([reading('high'), reading('not-sent'), reading('medium'), reading('unverified'), reading(null)]).toEqual(['sent', 'not-sent', 'not-sent', 'unverified', 'unverified'])
  // Its note queued and not on a row yet; once placed (the pending note gone) it is a reading like any other.
  const queued = { ...s.turn!, pendingNote: 'n', queuedCheck: { id: 't7-m6', level: 'high' as const, note: 'n' } }
  expect(reading(null, queued)).toBe('queued')
  expect(reading(null, { ...queued, pendingNote: null })).toBe('unverified')
})

test('状态取这一步自己格子的读数：这一步还没读到是未核对（档位是步上的），不拿更早一步的读数', () => {
  const s = scenes.up
  const cfg = readConfig({ drexApiKey: 'k' })
  const withLast = (sent: TrackCell['sent'], lastSent: BoardState['session']['lastSent']): BoardState => {
    const track = [...s.turn!.track.slice(0, -1), { ...s.turn!.track.at(-1)!, sent }]
    return { ...s, session: { ...s.session, lastSent }, turn: { ...s.turn!, track } }
  }
  // The earlier step read high (lastSent); this step's own request was not read.
  const unread = boardModel(cfg, withLast(null, 'high'))
  expect([unread.level, unread.sent, unread.status]).toEqual(['high', null, { kind: 'unverified', text: '未核对' }])
  expect(footerLabel(unread)).toBe('dp high –')
  // An older reading of medium is not this step's either.
  expect(boardModel(cfg, withLast(null, 'medium')).status).toEqual({ kind: 'unverified', text: '未核对' })
  // This step's own: equal is sent, another level is a mismatch.
  expect(boardModel(cfg, withLast('high', 'medium')).status).toEqual({ kind: 'sent', text: '已发出' })
  expect(boardModel(cfg, withLast('medium', 'high')).status).toEqual({ kind: 'mismatch', text: '要 high，实际发出 medium' })
  // Between turns the last known reading stays: the turn ended there.
  expect(of('idle').sent).toBe('high')
})

test('agent 的读数：mod 定了模型或 effort 的才有；读到且一样、读到但不一样、没读到；没动的没有记号', () => {
  const s = scenes.up
  const cfg = readConfig({ drexApiKey: 'k' })
  const a = s.recent.find((d) => d.id === 't7-a1')!
  const reading = (d: Partial<Decision>) => boardModel(cfg, { ...s, recent: [{ ...a, ...d }] }).agents[0]!.reading
  expect([reading({ sent: 'low' }), reading({ sent: 'not-sent' }), reading({ sent: 'unverified' }), reading({ sent: null })]).toEqual(['sent', 'not-sent', 'unverified', 'unverified'])
  // The mod set nothing (shadow, a failed ask that changed nothing): no readout at all.
  expect([reading({ applied: false, sent: null }), reading({ applied: false, sent: 'unverified' })]).toEqual([null, null])
})

// A turn whose first step has not arrived (controller ruling): its level is not known yet, which is not "no effort".
const starting = (session: Partial<BoardState['session']> = {}): BoardState => {
  const s = scenes.start
  return { ...s, session: { ...s.session, sessionLevel: 'medium', ...session }, turn: { ...s.turn!, base: null, wanted: null, track: [], stepNo: 0, lastJudged: null, shifts: [] }, recent: [] }
}

test('一轮刚开始、第一步还没来：这一轮刚开始，档位是上次见到的，不说不收 effort', () => {
  // The message was judged inside prompt.submit, before turn.start: nothing is being judged now, whatever the config.
  const m = boardModel(readConfig({ drexApiKey: 'k' }), starting())
  expect([m.level, m.status, m.where]).toEqual(['medium', { kind: 'starting', text: '这一轮刚开始' }, '第 7 轮 · 刚开始'])
  expect(m.track).toEqual([])
  expect(m.last).toBe(null)
  // Computed as for any turn: Code Mode checks at the next script result.
  expect(m.next).toEqual({ main: '下一份脚本结果到达时', sub: '每 1 份脚本结果评估一次 · 本轮还可换挡 4 次', ahead: 1 })
  // The same with submitShift off, or no usable backend.
  const notJudged = boardModel(readConfig({ drexApiKey: 'k', submitShift: false }), starting())
  expect([notJudged.level, notJudged.status]).toEqual(['medium', { kind: 'starting', text: '这一轮刚开始' }])
  const noKey = boardModel(readConfig({}), starting())
  expect([noKey.status, noKey.next]).toEqual([{ kind: 'starting', text: '这一轮刚开始' }, { main: '本轮不再评估', sub: '没有可用的后端', ahead: 0 }])
  // The session has sent no step yet: no level to show.
  expect(boardModel(readConfig({ drexApiKey: 'k' }), starting({ sessionLevel: null })).level).toBe(null)
})

test('一轮刚开始：锁定时是已锁定和锁定的档；mod 关着时照旧写已关闭', () => {
  const locked = boardModel(readConfig({ drexApiKey: 'k' }), starting({ lock: 'xhigh' }))
  expect([locked.level, locked.status, locked.where]).toEqual(['xhigh', { kind: 'locked', text: '已锁定' }, '第 7 轮 · 刚开始'])
  expect(locked.next).toEqual({ main: '不评估', sub: '/dp unlock 解锁后恢复', ahead: 0 })
  const off = boardModel(readConfig({ drexApiKey: 'k', enabled: false }), starting())
  expect([off.level, off.status]).toEqual(['medium', { kind: 'starting', text: '这一轮刚开始' }])
  expect(off.next).toEqual({ main: '不评估', sub: 'dispatch-pilot 已关闭', ahead: 0 })
  expect(off.features.map((f) => f.state)).toEqual(['off', 'off', 'off', 'off', 'off', 'off'])
})

test('不收 effort 只从第 1 步起才这样说', () => {
  const s = starting()
  const at = (stepNo: number) => boardModel(readConfig({ drexApiKey: 'k' }), { ...s, turn: { ...s.turn!, stepNo } })
  expect([at(1).status, at(1).next]).toEqual([{ kind: 'none', text: '这个模型不收 effort' }, { main: '不评估', sub: '这个模型不收 effort', ahead: 0 }])
  expect(at(1).where).toBe('第 7 轮 · 第 1 步')
  expect(at(0).status.kind).toBe('starting')
  expect(at(0).next.sub).not.toBe('这个模型不收 effort')
})

// Final review I4c: in shadow a message's skill is judged and recorded, and the board says nothing was changed.
test('shadow：功能里 skill 那一行写「只记录，不改」，这条消息记下的 skill 也这样标', () => {
  const s = scenes.start
  const recent = s.recent.map((d) => (d.kind === 'skill' ? { ...d, applied: false } : d))
  const m = boardModel(readConfig({ drexApiKey: 'k', mode: 'shadow' }), { ...s, recent })
  expect(m.features[3]).toEqual({ label: 'skill 推荐', state: 'inactive', note: '只记录，不改' })
  expect(m.skill).toBe('superpowers:systematic-debugging（只记录，不改）')
})

test('选中的后端没有密钥、另一家有：后端那一行写要改哪一项（G3）', () => {
  const s = scenes.up
  expect(boardModel(readConfig({ jevApiKey: 'k' }), s).backend).toEqual({ isOk: false, text: 'Drex 没有密钥 · 要用 Jev 就把「决策模型的后端」改成 jev' })
  expect(boardModel(readConfig({ backend: 'jev', drexApiKey: 'k' }), s).backend).toEqual({ isOk: false, text: 'Jev 没有密钥 · 要用 Drex 就把「决策模型的后端」改成 drex' })
  expect(boardModel(readConfig({}), s).backend).toEqual({ isOk: false, text: '没有密钥' })
})

test('数字 effort 的会话：状态和下次评估写「数字 effort，不判断」，不收 effort 的模型照旧（G5）', () => {
  const s = scenes.up
  const turn = { ...s.turn!, base: null, wanted: null }
  const numeric = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, turn, session: { ...s.session, effortIsNumber: true } })
  expect([numeric.status.text, numeric.next.sub]).toEqual(['数字 effort，不判断', '数字 effort，不判断'])
  const none = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, turn, session: { ...s.session, effortIsNumber: false } })
  expect([none.status.text, none.next.sub]).toEqual(['这个模型不收 effort', '这个模型不收 effort'])
})

test('同一格之前两次评估：留下更要紧的记号，失败重于换档，换档重于不变（G12）', () => {
  const t = { ...scenes.up.turn!, lastJudged: null, shifts: [], pendingMark: null }
  const hold = scenes.up.recent.find((d) => d.id === 't7-m9')!
  const up = scenes.up.recent.find((d) => d.id === 't7-m6')!
  const fail = { ...hold, id: 'f', failure: 'timeout' as const }
  expect(keepJudged(keepJudged(t, up), hold).pendingMark).toBe('up')
  expect(keepJudged(keepJudged(t, hold), up).pendingMark).toBe('up')
  expect(keepJudged(keepJudged(t, fail), up).pendingMark).toBe('fail')
  expect(keepJudged(keepJudged(t, up), fail).pendingMark).toBe('fail')
  expect(keepJudged(keepJudged(t, hold), hold).pendingMark).toBe('hold')
  // The last evaluation is still the later one.
  expect(keepJudged(keepJudged(t, up), hold).lastJudged?.id).toBe('t7-m9')
})

test('换挡间隔之内：下次评估数到间隔过了的那一份结果（G6）', () => {
  const s = scenes.up
  const t = s.turn!
  const done = t.journal.workSteps
  const within = { ...t, midrun: { ...t.midrun, lastShiftAt: done - 1, scriptsSinceCheck: 0 } }
  const m = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, turn: within })
  expect([m.next.main, m.next.sub, m.next.ahead]).toEqual(['再 2 份脚本结果', '换挡后隔 3 份脚本结果才再评估 · 本轮还可换挡 3 次', 2])
  const ordinary = boardModel(readConfig({ drexApiKey: 'k' }), { ...s, session: { ...s.session, codeMode: false }, turn: { ...within, midrun: { ...within.midrun, stepsSinceCheck: 7 } } })
  expect([ordinary.next.main, ordinary.next.sub]).toEqual(['再 2 步', '换挡后隔 3 步才再评估 · 有新输入时照常评估'])
})
