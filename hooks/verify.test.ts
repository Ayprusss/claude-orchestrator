import { expect, test } from 'claude-code/testing'

import { verifyNote } from './verify'

test('the loop is off at zero rounds', () => {
  expect(verifyNote({ rounds: 0 })).toBe('')
  expect(verifyNote({ rounds: -2 })).toBe('')
})

test('the directive names the rounds, the criteria and the report line', () => {
  const t = verifyNote({ rounds: 3, criteria: 'tests pass; no new lint errors' })
  expect(t).toContain('up to 3 rounds')
  expect(t).toContain('Done means all of: tests pass; no new lint errors')
  expect(t).toContain('Never weaken, skip or delete a test')
  expect(t).toContain('Verified: yes')
  expect(t).not.toContain('skill')
})

test('without criteria it falls back to the task itself; one round is singular', () => {
  const t = verifyNote({ rounds: 1 })
  expect(t).toContain('1 round of')
  expect(t).toContain('everything the task above asks for')
})

test('a skill is mentioned when set, and cleaned to a plain name', () => {
  expect(verifyNote({ rounds: 2, skill: '/my-plugin:verify' })).toContain('`my-plugin:verify` skill is available')
  expect(verifyNote({ rounds: 2, skill: 'x`; rm -rf' })).toContain('`xrm-rf` skill')
})

test('rounds are capped', () => {
  expect(verifyNote({ rounds: 99 })).toContain('up to 10 rounds')
})
