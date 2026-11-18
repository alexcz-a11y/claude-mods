import { expect, test } from 'claude-code/testing'
import { readConfig } from '../hooks/config.ts'
import { tierOfModelId } from '../hooks/levels.ts'

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
