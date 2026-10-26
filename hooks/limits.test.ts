import { expect, test } from 'claude-code/testing'

import { blockingWindow, looksLikeLimit, resetFromText, resumedPrompt, throttledMax } from './limits'

test('near a usage limit, fewer tasks run at once', async () => {
  const hot = [{ kind: 'five_hour', percentUsed: 85 }]
  const cool = [{ kind: 'five_hour', percentUsed: 40 }]
  expect(throttledMax(6, hot, 80, 2)).toEqual({ max: 2, isSlowed: true })
  expect(throttledMax(6, cool, 80, 2)).toEqual({ max: 6, isSlowed: false })
  // Off, or already at or below the slowed count.
  expect(throttledMax(6, hot, 0, 2)).toEqual({ max: 6, isSlowed: false })
  expect(throttledMax(1, hot, 80, 2)).toEqual({ max: 1, isSlowed: false })
  // 100% is standby's job, not this one.
  expect(throttledMax(6, [{ kind: 'five_hour', percentUsed: 100 }], 80, 2).isSlowed).toBe(false)
})

const NOW = Date.parse('2026-10-25T12:00:00Z')

test('a used-up window blocks until it resets', async () => {
  const w = blockingWindow(
    [
      { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-25T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-29T00:00:00Z' },
    ],
    NOW,
  )
  expect(w).toEqual({ kind: 'five_hour', until: Date.parse('2026-10-25T14:00:00Z') })
})

test('the window that resets last wins', async () => {
  const w = blockingWindow(
    [
      { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-25T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 100, resetsAt: '2026-10-29T00:00:00Z' },
    ],
    NOW,
  )
  expect(w?.kind).toBe('seven_day')
})

test('a stale reading past its reset does not block, nor does room left', async () => {
  expect(
    blockingWindow([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-25T11:00:00Z' }], NOW),
  ).toBeUndefined()
  expect(blockingWindow([{ kind: 'five_hour', percentUsed: 99.5 }], NOW)).toBeUndefined()
})

test('limit messages are recognized, ordinary failures are not', async () => {
  expect(looksLikeLimit('Claude AI usage limit reached|1761404400')).toBe(true)
  expect(looksLikeLimit("You've hit your limit · resets 3pm")).toBe(true)
  expect(looksLikeLimit('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).toBe(true)
  expect(looksLikeLimit('Error: Cannot find module ./auth')).toBe(false)
  expect(looksLikeLimit('Added a rate limiter to the login route.')).toBe(false)
})

test('a reset time is read from the old limit message', async () => {
  expect(resetFromText('Claude AI usage limit reached|1793000000', NOW)).toBe(1793000000 * 1000)
  expect(resetFromText('usage limit reached', NOW)).toBe(0)
})

test('a resumed task is told to check for partial work', async () => {
  expect(resumedPrompt('Fix it', 0)).toBe('Fix it')
  expect(resumedPrompt('Fix it', 1)).toContain('cut off by a usage limit')
})
