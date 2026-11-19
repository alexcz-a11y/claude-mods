import { expect, test } from 'claude-code/testing'
import { OPTION_BARS, optionKey, readConfig } from '../hooks/config.ts'
import { tierOfModelId } from '../hooks/levels.ts'
import { START, START_SKILL_BARS } from '../hooks/questions.ts'

test('空的 options 得到设计里的默认值', () => {
  const c = readConfig({})
  expect(c.backend).toBe('drex')
  expect(c.drexModel).toBe('drex-max-v1.1')
  expect(c.fallback).toBe(false)
  expect(c.board).toBe(true)
  expect(c.midrunEveryScripts).toBe(1)
  expect(c.agentModels).toEqual(['haiku', 'sonnet', 'opus'])
  expect([c.submitTimeoutMs, c.midrunTimeoutMs, c.agentTimeoutMs]).toEqual([4000, 2000, 3000])
})
test('模型名留空或只有空白时用默认值，前后的空白去掉', () => {
  for (const blank of ['', '   ', '\t']) {
    const c = readConfig({ drexModel: blank, jevModel: blank })
    expect([c.drexModel, c.jevModel]).toEqual(['drex-max-v1.1', 'jev-latest'])
  }
  const c = readConfig({ drexModel: ' drex-v2.0 ', jevModel: 'jev-1.14.0' })
  expect([c.drexModel, c.jevModel]).toEqual(['drex-v2.0', 'jev-1.14.0'])
})
test('越界和认不出的值回到范围内', () => {
  const c = readConfig({ midrunEverySteps: 999, mode: 'nonsense', agentModels: 'opus, gpt, haiku' })
  expect(c.midrunEverySteps).toBe(60)
  expect(c.mode).toBe('apply')
  expect(c.agentModels).toEqual(['haiku', 'opus'])
})
test('从模型 id 认层级', () => {
  expect(tierOfModelId('claude-fable-5-2')).toBe('fable')
  expect(tierOfModelId('claude-haiku-5-5')).toBe('haiku')
  expect(tierOfModelId('some-other-model')).toBe(null)
})

test('门槛的默认值是 drex-max-v1.1 上校准的值：只有 agent 的降档门槛是 0.95；不管哪个后端回答都用它们', () => {
  const c = readConfig({})
  expect(c.bars).toEqual({ submit: START, midrun: START, agent: { ...START, down: 0.95 }, skill: START_SKILL_BARS })
  expect(readConfig({ backend: 'jev', jevApiKey: 'k' }).bars).toEqual(c.bars)
})

test('用户定下的默认值：进展记录开、中途换档开，两次换档至少隔 3 个工作步', () => {
  const c = readConfig({})
  expect([c.progressNote, c.midrunShift, c.midrunShiftGap]).toEqual([true, true, 3])
})

test('会改变决定的门槛才是选项：no 只用来显示读法，发消息和中途不读 modelDown', () => {
  expect(OPTION_BARS).toEqual({
    submit: ['up', 'upHigh', 'down', 'yes'],
    midrun: ['up', 'upHigh', 'down', 'yes'],
    agent: ['up', 'upHigh', 'down', 'yes', 'modelDown'],
    skill: ['action', 'named', 'fits'],
  })
  expect(Object.entries(OPTION_BARS).flatMap(([group, fields]) => fields.map((f) => optionKey(group, f)))).toEqual([
    'submitUp', 'submitUpHigh', 'submitDown', 'submitYes',
    'midrunUp', 'midrunUpHigh', 'midrunDown', 'midrunYes',
    'agentUp', 'agentUpHigh', 'agentDown', 'agentYes', 'agentModelDown',
    'skillAction', 'skillNamed', 'skillFits',
  ])
  // Keys that are no option change nothing.
  expect(readConfig({ submitNo: 0.1, agentNo: 0.1, submitModelDown: 0.6, midrunModelDown: 0.6 }).bars).toEqual(readConfig({}).bars)
})

test('门槛选项盖过默认值，只改它自己那一个', () => {
  const c = readConfig({ submitUp: 0.9, midrunDown: 0.85, agentDown: 0.7, agentModelDown: 0.6, skillFits: 0.5 })
  expect(c.bars.submit).toEqual({ ...START, up: 0.9 })
  expect(c.bars.midrun).toEqual({ ...START, down: 0.85 })
  expect(c.bars.agent).toEqual({ ...START, down: 0.7, modelDown: 0.6 })
  expect(c.bars.skill).toEqual({ ...START_SKILL_BARS, fits: 0.5 })
})

test('门槛选项越界时按边界：档位和是非题 0.5 到 0.99，skill 0.05 到 0.95', () => {
  const c = readConfig({ submitUp: 2, midrunUpHigh: 0.1, agentDown: 0, agentModelDown: 1.5, skillAction: 0, skillNamed: 1, skillFits: -1 })
  expect([c.bars.submit.up, c.bars.midrun.upHigh, c.bars.agent.down, c.bars.agent.modelDown]).toEqual([0.99, 0.5, 0.5, 0.99])
  expect(c.bars.skill).toEqual({ action: 0.05, named: 0.95, fits: 0.05 })
})

test('数字选项读列表里的字（"0.70"、"8"），也读数字（测试、校准工具、旧设置）', () => {
  const c = readConfig({ submitUp: '0.90', agentDown: '0.70', skillNamed: 0.8, midrunEverySteps: '12', submitTimeoutMs: '1500', midrunMaxNotes: 2 })
  expect([c.bars.submit.up, c.bars.agent.down, c.bars.skill.named]).toEqual([0.9, 0.7, 0.8])
  expect([c.midrunEverySteps, c.submitTimeoutMs, c.midrunMaxNotes]).toEqual([12, 1500, 2])
})

test('门槛选项不是数字时用默认值', () => {
  const c = readConfig({ submitUp: 'high', submitDown: '', midrunYes: null, agentDown: Number.NaN, agentModelDown: Number.POSITIVE_INFINITY, skillFits: true })
  expect(c.bars).toEqual(readConfig({}).bars)
})

test('是非题读作「是」的门槛怎么调，和读作「否」的 0.3 之间都至少隔 0.2', () => {
  for (const yes of [0, 0.5, 0.6, 0.99, 5]) {
    const c = readConfig({ submitYes: yes, midrunYes: yes, agentYes: yes })
    for (const t of [c.bars.submit, c.bars.midrun, c.bars.agent]) expect(t.yes - t.no).toBeGreaterThanOrEqual(0.2 - 1e-9)
  }
})

test('midrunShiftGap：0 到 20，不是数字时用 3', () => {
  expect([0, 5, 20, 99, -2, '4', 'x', null].map((v) => readConfig({ midrunShiftGap: v }).midrunShiftGap)).toEqual([0, 5, 20, 20, 0, 4, 3, 3])
})
