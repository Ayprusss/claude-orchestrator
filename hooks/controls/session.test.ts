import { expect, test } from 'claude-code/testing'

import {
  EFFORT_LEVELS,
  MODEL_CHOICES,
  noteEffort,
  resetSessionControls,
  sessionInfo,
  setSessionEffort,
  setSessionModel,
} from './session'

type Calls = { command: unknown[]; config: unknown[] }
function fake(opts: { commands?: string[]; rows?: unknown[]; text?: string; model?: string; setting?: unknown }) {
  const calls: Calls = { command: [], config: [] }
  const $ = {
    command: {
      list: async () => (opts.commands ?? []).map(name => ({ name })),
      run: async (a: unknown) => {
        calls.command.push(a)
        return { text: opts.text ?? '' }
      },
    },
    config: {
      list: async () => opts.rows ?? [],
      set: async (a: unknown) => {
        calls.config.push(a)
        return { value: (a as { value: unknown }).value }
      },
    },
    session: { model: async () => opts.model ?? 'claude-opus' },
    settings: { read: async () => opts.setting },
  }
  return { $: $ as never, calls }
}

test('lists are fixed', async () => {
  expect(MODEL_CHOICES[0]).toEqual({ id: '', label: 'Default' })
  expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

test('model: default maps to /model default, free text is refused', async () => {
  resetSessionControls()
  const { $, calls } = fake({ text: 'Set model to Sonnet' })
  expect((await setSessionModel($, 'sonnet')).ok).toBe(true)
  expect((await setSessionModel($, '')).ok).toBe(true)
  expect(calls.command).toEqual([
    { command: 'model', args: 'sonnet' },
    { command: 'model', args: 'default' },
  ])
  expect((await setSessionModel($, 'x; rm -rf')).ok).toBe(false)
  expect(calls.command.length).toBe(2)
})

test('model: an error text is a failure', async () => {
  resetSessionControls()
  const { $ } = fake({ text: 'Unknown model: fable' })
  expect((await setSessionModel($, 'fable')).ok).toBe(false)
})

test('effort: no command and no row means not settable', async () => {
  resetSessionControls()
  const { $ } = fake({ commands: ['model'] })
  const r = await setSessionEffort($, 'high')
  expect(r.ok).toBe(false)
  expect((await sessionInfo($)).canSetEffort).toBe(false)
})

test('effort: uses /effort when present and validates the level', async () => {
  resetSessionControls()
  const { $, calls } = fake({ commands: ['effort'] })
  expect((await setSessionEffort($, 'high')).ok).toBe(true)
  expect((await setSessionEffort($, 'ultra')).ok).toBe(false)
  expect(calls.command).toEqual([{ command: 'effort', args: 'high' }])
  const info = await sessionInfo($)
  expect(info.canSetEffort).toBe(true)
  expect(info.effort).toBe('high')
})

test('effort: falls back to a config row and reads it', async () => {
  resetSessionControls()
  const rows = [{ key: 'effortLevel', kind: 'choice', value: 'medium', options: ['auto', 'low'] }]
  const { $, calls } = fake({ rows })
  const info = await sessionInfo($)
  expect(info).toEqual({ model: 'claude-opus', effort: 'medium', canSetEffort: true })
  expect((await setSessionEffort($, 'low')).ok).toBe(true)
  expect(calls.config).toEqual([{ key: 'effortLevel', value: 'low' }])
})

test('effort: noted level and settings key are read', async () => {
  resetSessionControls()
  const a = fake({ setting: 'xhigh' })
  expect((await sessionInfo(a.$)).effort).toBe('xhigh')
  noteEffort({ effort: { level: 'max' } })
  expect((await sessionInfo(a.$)).effort).toBe('max')
  resetSessionControls()
})
