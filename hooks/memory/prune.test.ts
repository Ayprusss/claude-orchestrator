import { expect, test } from 'claude-code/testing'

import { isUnder, pickPrunable } from './prune'

const DAY = 86_400_000
const now = 100 * DAY
const f = (name: string, ageDays: number, kind = 'file') => ({ name, kind, mtimeMs: now - ageDays * DAY })

test('files older than the limit are chosen, newer ones kept', () => {
  const out = pickPrunable([f('a.json', 40), f('b.json', 5), f('c.json', 31)], now, { suffix: '.json', maxAgeMs: 30 * DAY })
  expect(out.sort()).toEqual(['a.json', 'c.json'])
})

test('beyond the newest N, even young files go', () => {
  const entries = [f('1.md', 1), f('2.md', 2), f('3.md', 3), f('4.md', 4)]
  expect(pickPrunable(entries, now, { suffix: '.md', maxAgeMs: 30 * DAY, keepNewest: 2 }).sort()).toEqual(['3.md', '4.md'])
})

test('other suffixes, folders and skipped names are never chosen', () => {
  const entries = [f('x.txt', 90), f('d.json', 90, 'dir'), f('keep.json', 90), f('old.json', 90)]
  expect(pickPrunable(entries, now, { suffix: '.json', maxAgeMs: 30 * DAY, skip: ['keep.json'] })).toEqual(['old.json'])
})

test('isUnder accepts paths inside the root and refuses the rest', () => {
  expect(isUnder('c:/mem', 'c:/mem/ledgers/a.json')).toBe(true)
  expect(isUnder('C:\\mem\\', 'c:/mem/x')).toBe(true)
  expect(isUnder('c:/mem', 'c:/other/a.json')).toBe(false)
  expect(isUnder('c:/mem', 'c:/mem/../x')).toBe(false)
  expect(isUnder('c:/mem', 'c:/memory/x')).toBe(false)
})
