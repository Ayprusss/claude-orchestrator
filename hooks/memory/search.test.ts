import { expect, test } from 'claude-code/testing'

import type { Episode, Fact, JournalLine, KnowledgeDoc } from './contract'
import { buildIndex, search, tokenize } from './search'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-26T12:00:00Z')

function fact(id: string, text: string, extra: Partial<Fact> = {}): Fact {
  return { id, text, kind: 'convention', origin: 'summary', sessionId: 's1', at: NOW - DAY, ...extra }
}

function episode(taskId: string, title: string, summary: string, extra: Partial<Episode> = {}): Episode {
  return {
    taskId,
    sessionId: 's1',
    title,
    prompt: title,
    backend: 'agent',
    status: 'done',
    outcome: 'succeeded',
    summary,
    isRawOutput: false,
    files: [],
    followups: [],
    interruptions: 0,
    endedAt: NOW - DAY,
    ...extra,
  }
}

const F = (f: Fact): JournalLine => ({ kind: 'fact', v: 1, fact: f })
const E = (e: Episode): JournalLine => ({ kind: 'episode', v: 1, episode: e })
const forget = (factId: string): JournalLine => ({ kind: 'forget', v: 1, factId, at: NOW })
const knowledge = (facts: Fact[]): KnowledgeDoc => ({ project: 'demo', consolidatedAt: NOW, facts })

const ids = (hits: ReturnType<typeof search>) => hits.map((h) => (h.type === 'fact' ? h.fact.id : h.episode.taskId))

test('the tokenizer lower-cases, splits on non-word characters and drops stop words', async () => {
  expect(tokenize('Run THE parser, then check: it works!')).toEqual(['run', 'parser', 'check', 'work'])
  expect(tokenize('the and of')).toEqual([])
  expect(tokenize('snake_case kebab-case')).toEqual(['snake_case', 'kebab', 'case'])
})

test('path-like tokens are kept whole and also split into parts', async () => {
  const tokens = tokenize('Edit `hooks/register.tsx` and hooks\\memory\\search.ts.')
  expect(tokens).toContain('hooks/register.tsx')
  expect(tokens).toContain('register')
  expect(tokens).toContain('tsx')
  expect(tokens).toContain('hook')
  expect(tokens).toContain('hooks/memory/search.ts')
  expect(tokens).toContain('search')
  // The sentence's closing dot is not part of the path.
  expect(tokens).not.toContain('hooks/memory/search.ts.')
  expect(tokenize('Load .env first')).toContain('.env')
})

test('BM25 ranks the closest match first and skips items with no shared word', async () => {
  const index = buildIndex(
    [
      F(fact('f_a', 'Tests run with claude plugin test from the repo root.')),
      F(fact('f_b', 'The HUD server listens on a random port.')),
      F(fact('f_c', 'Plugin settings merge over the defaults.')),
    ],
    undefined,
    NOW,
  )
  expect(index.size).toBe(3)
  const hits = search(index, 'how do I run the plugin tests?')
  expect(ids(hits)).toEqual(['f_a', 'f_c'])
  expect(hits[0]?.score ?? 0).toBeGreaterThan(hits[1]?.score ?? 0)
  expect(search(index, 'kubernetes deployment')).toEqual([])
  expect(search(index, 'the of and')).toEqual([])
})

test('a fact is found by a word from its text and by a file path it mentions', async () => {
  const index = buildIndex(
    [
      F(fact('f_path', 'Tool registration happens in one big file.', { paths: ['hooks/register.tsx'] })),
      F(fact('f_other', 'Docs live in a separate module.', { paths: ['hooks/docs.ts'] })),
      E(episode('t1', 'Wire the note tool', 'Added the note tool.', { files: ['hooks/register.tsx'] })),
    ],
    undefined,
    NOW,
  )
  expect(ids(search(index, 'registration'))).toEqual(['f_path'])
  const byPath = search(index, 'hooks/register.tsx')
  expect(ids(byPath)).toContain('f_path')
  expect(ids(byPath)).toContain('t1')
  expect(ids(byPath)[ids(byPath).length - 1]).toBe('f_other') // shares only the `hooks` part
})

test('facts the person stated rank above the same fact from a summary', async () => {
  const text = 'Always use worktrees for parallel tasks.'
  const index = buildIndex([F(fact('f_sum', text)), F(fact('f_per', text, { origin: 'person' }))], undefined, NOW)
  expect(ids(search(index, 'worktrees'))).toEqual(['f_per', 'f_sum'])
})

test('knowledge facts rank above inbox facts and replace inbox facts with the same id', async () => {
  const text = 'Journal files rotate at one mebibyte.'
  const index = buildIndex(
    [F(fact('f_inbox', text)), F(fact('f_same', 'Old wording about journal rotation.'))],
    knowledge([fact('f_kn', text), fact('f_same', 'Journals rotate per session file.')]),
    NOW,
  )
  expect(index.size).toBe(3)
  const hits = search(index, 'journal rotate')
  expect(ids(hits).indexOf('f_kn')).toBeLessThan(ids(hits).indexOf('f_inbox'))
  const same = hits.find((h) => h.type === 'fact' && h.fact.id === 'f_same')
  expect(same?.type === 'fact' ? same.fact.text : '').toBe('Journals rotate per session file.')
})

test('forget lines remove facts from the inbox and from knowledge', async () => {
  const index = buildIndex(
    [F(fact('f_a', 'Use pnpm to install.')), F(fact('f_b', 'Use pnpm workspaces.')), forget('f_a'), forget('f_k')],
    knowledge([fact('f_k', 'pnpm is pinned to version nine.')]),
    NOW,
  )
  expect(index.size).toBe(1)
  expect(ids(search(index, 'pnpm'))).toEqual(['f_b'])
})

test('newer items rank above older ones, and stale facts are down-weighted', async () => {
  const text = 'The build script lives in scripts.'
  const recent = buildIndex(
    [F(fact('f_old', text, { at: NOW - 120 * DAY })), F(fact('f_new', text, { at: NOW - DAY }))],
    undefined,
    NOW,
  )
  expect(ids(search(recent, 'build script'))).toEqual(['f_new', 'f_old'])

  const stale = buildIndex([F(fact('f_stale', text, { isStale: true })), F(fact('f_ok', text, { at: NOW - 60 * DAY }))], undefined, NOW)
  expect(ids(search(stale, 'build script'))).toEqual(['f_ok', 'f_stale'])
})

test('episodes are searched by title, summary and files; types and limit filter', async () => {
  const index = buildIndex(
    [
      E(episode('t1', 'Add parser tests', 'Covered the tokenizer edge cases.')),
      E(episode('t2', 'Fix HUD crash', 'The parser threw on empty input.')),
      F(fact('f_a', 'The parser is in hooks/diffs.ts.')),
    ],
    undefined,
    NOW,
  )
  expect(search(index, 'parser').length).toBe(3)
  expect(ids(search(index, 'parser', { types: ['episode'] })).sort()).toEqual(['t1', 't2'])
  expect(ids(search(index, 'parser', { types: ['fact'] }))).toEqual(['f_a'])
  expect(search(index, 'parser', { limit: 1 }).length).toBe(1)
  expect(ids(search(index, 'tokenizer'))).toEqual(['t1'])
})

test('a summarized episode replaces the raw one stored for the same task', async () => {
  const raw = episode('t1', 'Port the HUD', 'raw tail of output', { isRawOutput: true })
  const done = episode('t1', 'Port the HUD', 'Moved the HUD server to node streams.')
  for (const lines of [
    [E(raw), E(done)],
    [E(done), E(raw)],
  ]) {
    const index = buildIndex(lines, undefined, NOW)
    expect(index.size).toBe(1)
    const hit = search(index, 'hud')[0]
    expect(hit?.type === 'episode' ? hit.episode.summary : '').toBe('Moved the HUD server to node streams.')
  }
})

test('results are deterministic', async () => {
  const lines = [
    F(fact('f_b', 'Same words here.')),
    F(fact('f_a', 'Same words here.')),
    E(episode('t1', 'Same words', 'here')),
  ]
  const a = search(buildIndex(lines, undefined, NOW), 'same words')
  const b = search(buildIndex(lines, undefined, NOW), 'same words')
  expect(a).toEqual(b)
  // Equal facts tie-break on id.
  expect(ids(a.filter((h) => h.type === 'fact'))).toEqual(['f_a', 'f_b'])
})

test('an empty index finds nothing', async () => {
  const index = buildIndex([], undefined, NOW)
  expect(index.size).toBe(0)
  expect(search(index, 'anything')).toEqual([])
  expect(search({ size: 3 }, 'anything')).toEqual([])
})

test('knowledge facts take their paths from the journal copy, and merged-away journal facts stay hidden', async () => {
  const index = buildIndex(
    [
      F(fact('f_k', 'Tool wiring lives in one file.', { paths: ['hooks/register.tsx'] })),
      F(fact('f_dup', 'Tool wiring is all in one file.')),
      F(fact('f_new', 'New tools need a docs entry.')),
    ],
    knowledge([fact('f_k', 'Tool wiring lives in one file.')]),
    NOW,
    ['f_k', 'f_dup'],
  )
  expect(index.size).toBe(2)
  expect(ids(search(index, 'hooks/register.tsx'))).toEqual(['f_k'])
  expect(ids(search(index, 'tool'))).toEqual(['f_k', 'f_new'])
})
