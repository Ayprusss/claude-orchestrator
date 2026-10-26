import { expect, test } from 'claude-code/testing'

import { canConfigure, normalizeEffort, normalizeModel, processModelArgs } from './tasks'

test('effort is empty or a known level', async () => {
  expect(normalizeEffort('high')).toBe('high')
  expect(normalizeEffort(' XHigh ')).toBe('xhigh')
  expect(normalizeEffort('')).toBe('')
  expect(normalizeEffort('turbo')).toBe('')
  expect(normalizeEffort(3)).toBe('')
  expect(normalizeEffort(undefined)).toBe('')
})

test('model accepts aliases and ids, nothing else', async () => {
  expect(normalizeModel(' sonnet ')).toBe('sonnet')
  expect(normalizeModel('claude-opus-4-1')).toBe('claude-opus-4-1')
  expect(normalizeModel('opus[1m]')).toBe('opus[1m]')
  expect(normalizeModel('')).toBe('')
  expect(normalizeModel('a b')).toBe('')
  expect(normalizeModel('x; rm -rf')).toBe('')
  expect(normalizeModel('a'.repeat(81))).toBe('')
  expect(normalizeModel(null)).toBe('')
})

test('process flags only for what is set', async () => {
  expect(processModelArgs('', '')).toEqual([])
  expect(processModelArgs('sonnet', '')).toEqual(['--model', 'sonnet'])
  expect(processModelArgs('', 'high')).toEqual(['--effort', 'high'])
  expect(processModelArgs('opus', 'max')).toEqual(['--model', 'opus', '--effort', 'max'])
  expect(processModelArgs('bad model', 'nope')).toEqual([])
})

test('only queued tasks can be configured', async () => {
  expect(canConfigure({ status: 'queued' })).toBe(true)
  for (const s of ['running', 'done', 'failed', 'killed']) expect(canConfigure({ status: s })).toBe(false)
})
