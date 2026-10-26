import { expect, test } from 'claude-code/testing'

import { briefLine, extractSection, largeReadRefusal, parseReads, renderBrief, renderShared } from './brief'

const PLAN = [
  '# Plan',
  'intro',
  '## 4. Units',
  'units intro',
  '### Unit S: session',
  'S text',
  '```md',
  '## not a heading (in a fence)',
  '```',
  'more S',
  '### Unit T: tasks',
  'T text',
  '## 5. Wiring',
  'wiring text',
].join('\n')

test('reads: paths and path#Heading; absolute and .. paths are dropped', async () => {
  expect(parseReads(['PLAN.md#Unit S', 'hooks/a.ts', '/etc/passwd', 'C:\\x.md', '../up.md', 42, ''])).toEqual([
    { path: 'PLAN.md', heading: 'Unit S' },
    { path: 'hooks/a.ts' },
  ])
  expect(parseReads('PLAN.md')).toEqual([])
})

test('a section runs to the next heading of the same or a higher level', async () => {
  const s = extractSection(PLAN, 'unit s')
  expect(s?.startsWith('### Unit S: session')).toBe(true)
  expect(s).toContain('## not a heading (in a fence)')
  expect(s).toContain('more S')
  expect(s).not.toContain('T text')
  const units = extractSection(PLAN, '4. Units')
  expect(units).toContain('T text')
  expect(units).not.toContain('wiring text')
  expect(extractSection(PLAN, '5. Wiring')).toBe('## 5. Wiring\nwiring text')
  expect(extractSection(PLAN, 'Unit Z')).toBeUndefined()
})

test('the brief lists files, inlines sections, and names what was not found', async () => {
  const md = renderBrief({
    title: 'Unit S',
    sharedPath: '/m/briefs/batch-x.md',
    parts: [
      { kind: 'file', path: 'hooks/a.ts' },
      { kind: 'section', path: 'PLAN.md', heading: 'Unit S', text: '### Unit S\nS text' },
      { kind: 'missing', path: 'PLAN.md', heading: 'Unit Q', reason: 'no such heading' },
    ],
  })
  expect(md).toContain('Read the shared context for this group of tasks first: /m/briefs/batch-x.md')
  expect(md).toContain('## Files to read\n\n- hooks/a.ts')
  expect(md).toContain('## From PLAN.md\n\n### Unit S\nS text')
  expect(md).toContain('- PLAN.md#Unit Q: no such heading')
  expect(renderShared('x', '  rules  ')).toBe('# Shared context (batch x)\n\nrules\n')
  expect(briefLine('/m/briefs/t1.md')).toContain('/m/briefs/t1.md')
})

test('the large-read guard refuses whole reads of big files only', async () => {
  expect(largeReadRefusal({}, 90 * 1024, 40)).toContain('90 KB')
  expect(largeReadRefusal({ offset: 1 }, 90 * 1024, 40)).toBeUndefined()
  expect(largeReadRefusal({ limit: 200 }, 90 * 1024, 40)).toBeUndefined()
  expect(largeReadRefusal({}, 10 * 1024, 40)).toBeUndefined()
  expect(largeReadRefusal({}, 90 * 1024, 0)).toBeUndefined()
})
