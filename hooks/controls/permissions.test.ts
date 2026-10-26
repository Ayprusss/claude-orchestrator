import { expect, test } from 'claude-code/testing'

import { askInHud, currentMode, noteMode, summarizeCall, toDecision } from './permissions'

const fake = (fetch: (url: string, init?: unknown) => Promise<unknown>) => ({ http: { fetch } }) as never

const opts = {
  baseUrl: 'http://127.0.0.1:1',
  token: 'T'.repeat(20),
  waitMs: 5000,
  request: { id: 'a1', tool: 'Bash', summary: 'ls', mode: 'default' },
}

test('noteMode reports a change once', async () => {
  expect(currentMode()).toBe('')
  expect(noteMode({})).toBe(false)
  expect(noteMode({ permission_mode: 'plan' })).toBe(true)
  expect(noteMode({ permission_mode: 'plan' })).toBe(false)
  expect(currentMode()).toBe('plan')
})

test('summaries clip commands and hide env values', async () => {
  const s = summarizeCall('Bash', {
    command: `API_KEY=abc123 curl -H "Authorization: Bearer xyz" ${'a'.repeat(400)}`,
  })
  expect(s.includes('abc123')).toBe(false)
  expect(s.includes('xyz')).toBe(false)
  expect(s.length <= 200).toBe(true)
  expect(summarizeCall('Edit', { file_path: 'D:/x/y.ts', new_string: 'secret' })).toBe('D:/x/y.ts')
  expect(summarizeCall('WebFetch', { url: 'https://a.com/p?key=1' })).toBe('https://a.com/p')
})

test('a HUD answer becomes a decision', async () => {
  expect(toDecision({ behavior: 'allow' })).toEqual({ behavior: 'allow' })
  expect(toDecision({ behavior: 'allow', mode: 'plan' })).toEqual({
    behavior: 'allow',
    updatedPermissions: [{ type: 'setMode', mode: 'plan', destination: 'session' }],
  })
  expect(toDecision({ behavior: 'deny' })).toEqual({
    behavior: 'deny',
    message: 'Denied in the orchestrator HUD.',
  })
})

test('askInHud returns the answer, and undefined on every failure', async () => {
  const ok = fake(async () => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ answer: { behavior: 'allow', mode: 'acceptEdits' } }),
  }))
  expect(await askInHud(ok, opts)).toEqual({ behavior: 'allow', mode: 'acceptEdits' })
  const none = fake(async () => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ answer: null, reason: 'timeout' }),
  }))
  expect(await askInHud(none, opts)).toBe(undefined)
  const bad = fake(async () => ({ ok: true, status: 200, text: 'not json' }))
  expect(await askInHud(bad, opts)).toBe(undefined)
  const boom = fake(async () => {
    throw new Error('down')
  })
  expect(await askInHud(boom, opts)).toBe(undefined)
  const odd = fake(async () => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ answer: { behavior: 'maybe' } }),
  }))
  expect(await askInHud(odd, opts)).toBe(undefined)
})
