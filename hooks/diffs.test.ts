import { expect, test } from 'claude-code/testing'

import { buildDiff } from './diffs'

test('an Edit result patch becomes the diff, with counts', async () => {
  const d = buildDiff(
    'Edit',
    { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' },
    {
      filePath: '/repo/a.ts',
      structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }],
    },
  )
  expect(d?.file).toBe('/repo/a.ts')
  expect(d?.op).toBe('edit')
  expect(d?.added).toBe(2)
  expect(d?.removed).toBe(1)
  expect(d?.hunks[0]?.oldStart).toBe(3)
})

test('a new file written with no patch shows as all additions', async () => {
  const d = buildDiff('Write', { file_path: '/repo/new.ts', content: 'a\nb\n' }, { type: 'create', filePath: '/repo/new.ts', structuredPatch: [] })
  expect(d?.op).toBe('create')
  expect(d?.hunks[0]?.lines).toEqual(['+a', '+b'])
  expect(d?.added).toBe(2)
})

test('an Edit with no result patch falls back to its strings', async () => {
  const d = buildDiff('Edit', { file_path: '/repo/a.ts', old_string: 'one', new_string: 'two' }, undefined)
  expect(d?.hunks[0]?.lines).toEqual(['-one', '+two'])
})

test('long diffs are cut and flagged; counts stay whole', async () => {
  const lines = Array.from({ length: 500 }, (_, i) => `+line ${i}`)
  const d = buildDiff('Write', { file_path: '/repo/big.ts' }, { type: 'create', structuredPatch: [{ oldStart: 0, newStart: 1, lines }] })
  expect(d?.isTruncated).toBe(true)
  expect(d?.hunks[0]?.lines.length).toBe(300)
  expect(d?.added).toBe(500)
})

test('nothing to show gives undefined', async () => {
  expect(buildDiff('Edit', {}, {})).toBeUndefined()
})
