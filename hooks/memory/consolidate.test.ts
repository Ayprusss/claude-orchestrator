import { expect, test } from 'claude-code/testing'

import {
  consolidate,
  inboxFacts,
  parseKnowledge,
  pruneEpisodes,
  renderKnowledge,
} from './consolidate'
import type { Episode, Fact, FilesModule, JournalLine, KnowledgeDoc, MemFs, MemModel, MemoryPaths, ProjectMeta } from './contract'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const KEY = 'demo-12345678'
const PROJECT = 'D:/work/demo'
const ROOT = 'C:/home/.claude/orchestrator-memory'

// ---- Fakes -------------------------------------------------------------------

function memFs(initial: Record<string, string> = {}): MemFs & { files: Map<string, string>; writes: string[] } {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  return {
    files,
    writes,
    read: async (p) => {
      const t = files.get(p)
      if (t === undefined) throw new Error(`ENOENT ${p}`)
      return t
    },
    write: async (p, t) => {
      writes.push(p)
      files.set(p, t)
    },
    list: async () => [],
    exists: async (p) => files.has(p),
  }
}

function memModel(reply: string | (() => never) | { text?: string; reason?: string }) {
  const calls: Parameters<MemModel['complete']>[0][] = []
  const model: MemModel = {
    complete: async (req) => {
      calls.push(req)
      if (typeof reply === 'function') reply()
      return typeof reply === 'string' ? { text: reply } : (reply as { text?: string })
    },
  }
  return { model, calls }
}

const paths: MemoryPaths = {
  root: ROOT,
  versionFile: `${ROOT}/VERSION`,
  ledgersDir: `${ROOT}/ledgers`,
  ledgerFile: (s) => `${ROOT}/ledgers/${s}.json`,
  projectDir: (k) => `${ROOT}/projects/${k}`,
  metaFile: (k) => `${ROOT}/projects/${k}/meta.json`,
  knowledgeFile: (k) => `${ROOT}/projects/${k}/knowledge.md`,
  lockFile: (k) => `${ROOT}/projects/${k}/knowledge.lock`,
  journalDir: (k) => `${ROOT}/projects/${k}/journal`,
  journalFile: (k, s) => `${ROOT}/projects/${k}/journal/${s}.jsonl`,
  transcriptFile: (k, t) => `${ROOT}/projects/${k}/transcripts/${t}.md`,
}

/** Lock semantics as unit A documents them; the journal is a fixed list of lines. */
function memFiles(lines: JournalLine[]): FilesModule & { released: string[] } {
  const released: string[] = []
  return {
    released,
    createFileQueue: (fs) => ({ write: (p, t) => fs.write(p, t), flush: async () => {} }),
    appendJournal: async () => {},
    readJournal: async () => lines,
    readJson: async <T,>(fs: MemFs, p: string) => {
      try {
        return JSON.parse(await fs.read(p)) as T
      } catch {
        return undefined
      }
    },
    acquireLock: async (fs, p, sessionId, now, ttlMs) => {
      let cur: { sessionId?: string; until?: number } = {}
      try {
        cur = JSON.parse(await fs.read(p))
      } catch {}
      if (cur.sessionId && cur.sessionId !== sessionId && (cur.until ?? 0) > now) return false
      await fs.write(p, JSON.stringify({ sessionId, until: now + ttlMs }))
      return true
    },
    releaseLock: async (fs, p, sessionId) => {
      released.push(sessionId)
      await fs.write(p, JSON.stringify({ sessionId, until: 0 }))
    },
  }
}

function fact(id: string, text: string, extra: Partial<Fact> = {}): Fact {
  return { id, text, kind: 'convention', origin: 'summary', sourceTaskId: 't1', sessionId: 's1', at: NOW - DAY, ...extra }
}

const factLine = (f: Fact): JournalLine => ({ kind: 'fact', v: 1, fact: f })

const OPTS = { key: KEY, projectPath: PROJECT, sessionId: 'me', now: NOW, modelName: 'haiku' }

function sections(s: Partial<Record<string, { id: string; text: string }[]>>): string {
  return JSON.stringify({ sections: s })
}

// ---- knowledge.md ----------------------------------------------------------------

const SAMPLE: KnowledgeDoc = {
  project: 'claude-orchestrator',
  consolidatedAt: Date.parse('2026-10-26T00:00:00Z'),
  facts: [
    fact('f_a1b2c3', 'Tests run with `claude plugin test .` from the repo root.', { sourceTaskId: 'k3x9p1', at: Date.parse('2026-10-20T00:00:00Z') }),
    fact('f_c3d4e5', '`$.fs.write` replaces whole files (never from two sessions).', { kind: 'gotcha', origin: 'person', sourceTaskId: undefined, at: Date.parse('2026-10-26T00:00:00Z') }),
    fact('f_x9y8z7', 'The HUD server lives in web/server.mjs.', { kind: 'architecture', isStale: true, sourceTaskId: 'q1w2e3', at: Date.parse('2026-09-01T00:00:00Z') }),
    fact('f_m0d3l1', 'Prefer worktrees for parallel work.', { kind: 'preference', origin: 'model', sourceTaskId: 'zz9', at: Date.parse('2026-10-01T00:00:00Z') }),
    fact('f_s0m3x1', 'Run `npm run lint` before committing.', { kind: 'command', sourceTaskId: undefined, at: Date.parse('2026-10-02T00:00:00Z') }),
  ],
}

test('knowledge.md renders the plan format, one section per kind', async () => {
  const md = renderKnowledge(SAMPLE)
  expect(md.startsWith('<!-- orchestrator-memory v1 · project: claude-orchestrator · consolidated 2026-10-26 -->\n## Conventions\n')).toBe(true)
  expect(md).toContain('- [f_a1b2c3] Tests run with `claude plugin test .` from the repo root. (task k3x9p1, 2026-10-20)')
  expect(md).toContain('- [f_c3d4e5] `$.fs.write` replaces whole files (never from two sessions). (person, 2026-10-26)')
  expect(md).toContain('- [f_x9y8z7] The HUD server lives in web/server.mjs. (possibly stale) (task q1w2e3, 2026-09-01)')
  expect(md).toContain('(model, task zz9, 2026-10-01)')
  expect(md).toContain('(summary, 2026-10-02)')
  const headings = md.split('\n').filter((l) => l.startsWith('## '))
  expect(headings).toEqual(['## Conventions', '## Gotchas', '## Commands', '## Architecture', '## Preferences'])
})

test('knowledge.md round-trips id, text, kind, origin, source, date and stale', async () => {
  const doc = parseKnowledge(renderKnowledge(SAMPLE))
  expect(doc.project).toBe('claude-orchestrator')
  expect(doc.consolidatedAt).toBe(SAMPLE.consolidatedAt)
  const pick = (f: Fact) => [f.id, f.text, f.kind, f.origin, f.sourceTaskId, f.at, !!f.isStale]
  const byKind = (fs: Fact[]) => [...fs].sort((a, b) => a.id.localeCompare(b.id)).map(pick)
  expect(byKind(doc.facts)).toEqual(byKind(SAMPLE.facts))
  expect(renderKnowledge(doc)).toBe(renderKnowledge(SAMPLE))
})

test('hand edits are tolerated', async () => {
  const md = [
    '## conventions',
    '* A bullet with no id or source.',
    '- [f_dup111] First. (person, 2026-01-02)',
    '- [f_dup111] Same id again. (task t9, 2026-01-03)',
    'Some prose the person wrote, ignored.',
    '## Notes',
    '- Under an unknown heading. (task t2, 2026-01-04)',
    '## Gotcha',
    '- [link](http://x) is not an id (and this is not a source)',
    '-   ',
  ].join('\r\n')
  const doc = parseKnowledge(md)
  expect(doc.project).toBe('')
  expect(doc.facts.map((f) => f.text)).toEqual([
    'A bullet with no id or source.',
    'First.',
    'Same id again.',
    'Under an unknown heading.',
    '[link](http://x) is not an id (and this is not a source)',
  ])
  const [noId, first, dup, unknown, link] = doc.facts as [Fact, Fact, Fact, Fact, Fact]
  expect(/^f_[0-9a-z]{6}$/.test(noId.id)).toBe(true)
  expect(noId.origin).toBe('person')
  expect(noId.kind).toBe('convention')
  expect(first.id).toBe('f_dup111')
  expect(dup.id).not.toBe('f_dup111')
  expect(dup.sourceTaskId).toBe('t9')
  expect(unknown.kind).toBe('convention')
  expect(unknown.origin).toBe('summary')
  expect(link.kind).toBe('gotcha')
  expect(new Set(doc.facts.map((f) => f.id)).size).toBe(5)
  // Ids for hand-written bullets are stable across parses.
  expect(parseKnowledge(md).facts.map((f) => f.id)).toEqual(doc.facts.map((f) => f.id))
})

// ---- Inbox -----------------------------------------------------------------------

test('the inbox is journal facts not in knowledge and not forgotten', async () => {
  const lines: JournalLine[] = [
    factLine(fact('f_known1', 'In knowledge.')),
    factLine(fact('f_new001', 'New one.')),
    factLine(fact('f_new001', 'New one.')),
    factLine(fact('f_gone01', 'Forgotten.')),
    { kind: 'forget', v: 1, factId: 'f_gone01', at: NOW },
    factLine(fact('f_merged', 'Merged away earlier.')),
    { kind: 'episode', v: 1, episode: episode(NOW) },
  ]
  const knowledge: KnowledgeDoc = { project: 'p', consolidatedAt: 0, facts: [fact('f_known1', 'In knowledge.')] }
  expect(inboxFacts(lines, knowledge).map((f) => f.id)).toEqual(['f_new001', 'f_merged'])
  expect(inboxFacts(lines, undefined).map((f) => f.id)).toEqual(['f_known1', 'f_new001', 'f_merged'])
  expect(inboxFacts(lines, knowledge, ['f_merged']).map((f) => f.id)).toEqual(['f_new001'])
})

function episode(endedAt: number): Episode {
  return {
    taskId: 't',
    sessionId: 's',
    title: 'x',
    prompt: '',
    backend: 'agent',
    status: 'done',
    outcome: 'succeeded',
    summary: '',
    isRawOutput: true,
    files: [],
    followups: [],
    interruptions: 0,
    endedAt,
  }
}

test('episodes older than 90 days are pruned on read', async () => {
  const lines: JournalLine[] = [
    { kind: 'episode', v: 1, episode: episode(NOW - 91 * DAY) },
    { kind: 'episode', v: 1, episode: episode(NOW - 10 * DAY) },
    factLine(fact('f_old000', 'Old fact.', { at: NOW - 400 * DAY })),
  ]
  expect(pruneEpisodes(lines, NOW).length).toBe(2)
})

// ---- Consolidate -----------------------------------------------------------------

test('a lock held by another session skips, with no model call and no write', async () => {
  const fs = memFs({ [paths.lockFile(KEY)]: JSON.stringify({ sessionId: 'other', until: NOW + 60_000 }) })
  const { model, calls } = memModel(sections({}))
  const files = memFiles([factLine(fact('f_new001', 'A fact.'))])
  const r = await consolidate({ fs, model, files, paths }, OPTS)
  expect(r.status).toBe('skipped')
  expect(calls.length).toBe(0)
  expect(fs.files.has(paths.knowledgeFile(KEY))).toBe(false)
  expect(files.released.length).toBe(0)
})

test('an expired lock is taken over', async () => {
  const fs = memFs({ [paths.lockFile(KEY)]: JSON.stringify({ sessionId: 'other', until: NOW - 1 }) })
  const { model } = memModel(sections({ convention: [{ id: 'f_new001', text: 'A fact.' }] }))
  const r = await consolidate({ fs, model, files: memFiles([factLine(fact('f_new001', 'A fact.'))]), paths }, OPTS)
  expect(r.status).toBe('done')
})

test('a merge writes knowledge.md and meta.json, drops forgotten facts, and releases the lock', async () => {
  const existing: KnowledgeDoc = {
    project: 'demo',
    consolidatedAt: NOW - 10 * DAY,
    facts: [
      fact('f_person', 'Always use worktrees for parallel tasks.', { kind: 'preference', origin: 'person', sourceTaskId: undefined, at: Date.parse('2026-10-01T00:00:00Z') }),
      fact('f_forget', 'An old fact the person forgot.', { at: Date.parse('2026-10-01T00:00:00Z') }),
    ],
  }
  const fs = memFs({
    [paths.knowledgeFile(KEY)]: renderKnowledge(existing),
    [paths.metaFile(KEY)]: JSON.stringify({ path: PROJECT, name: 'demo', createdAt: 1, consolidatedFactIds: ['f_earlier'] }),
  })
  const lines: JournalLine[] = [
    factLine(fact('f_dup001', 'Tests run with `npm test`.')),
    factLine(fact('f_dup002', 'Run tests with `npm test` from the root.')),
    factLine(fact('f_secret', 'Deploy key handling.', { kind: 'gotcha' })),
    { kind: 'forget', v: 1, factId: 'f_forget', at: NOW },
  ]
  const { model, calls } = memModel(
    '```json\n' +
      sections({
        command: [{ id: 'f_dup002', text: 'Run tests with `npm test` from the repo root.' }],
        gotcha: [{ id: 'f_secret', text: 'Never commit ghp_abcdefghijklmnopqrstuvwxyz0123456789 to the repo.' }],
        preference: [{ id: 'f_person', text: 'Always use worktrees for parallel tasks.' }],
      }) +
      '\n```',
  )
  const files = memFiles(lines)
  const r = await consolidate({ fs, model, files, paths }, OPTS)
  expect(r).toEqual({ status: 'done', kept: 3, dropped: 2, stale: 0 })

  expect(calls.length).toBe(1)
  expect(calls[0]!.model).toBe('haiku')
  expect(calls[0]!.effort).toBe('medium')
  expect(calls[0]!.maxTokens).toBe(4000)
  expect(calls[0]!.prompt).not.toContain('f_forget')
  expect(calls[0]!.prompt).toContain('f_dup001')

  const doc = parseKnowledge(fs.files.get(paths.knowledgeFile(KEY))!)
  expect(doc.consolidatedAt).toBe(Date.parse('2026-10-26T00:00:00Z'))
  expect(doc.project).toBe('demo')
  expect(doc.facts.map((f) => f.id).sort()).toEqual(['f_dup002', 'f_person', 'f_secret'])
  const dup = doc.facts.find((f) => f.id === 'f_dup002')!
  expect(dup.kind).toBe('command')
  expect(dup.sourceTaskId).toBe('t1')
  const secret = doc.facts.find((f) => f.id === 'f_secret')!
  expect(secret.text).not.toContain('ghp_')
  expect(secret.text).toContain('[redacted]')

  const meta = JSON.parse(fs.files.get(paths.metaFile(KEY))!) as ProjectMeta
  expect(meta.createdAt).toBe(1)
  expect([...meta.consolidatedFactIds].sort()).toEqual(['f_dup001', 'f_dup002', 'f_earlier', 'f_forget', 'f_person', 'f_secret'])
  expect(inboxFacts(lines, doc, meta.consolidatedFactIds).length).toBe(0)

  expect(files.released).toEqual(['me'])
  // Journals are never rewritten.
  expect(fs.writes.some((p) => p.includes('/journal/'))).toBe(false)
})

test('the staleness pass marks facts whose paths are all gone', async () => {
  const fs = memFs({ [`${PROJECT}/src/kept.ts`]: '', 'D:/abs/here.ts': '' })
  const lines = [
    factLine(fact('f_gone01', 'Gone file.', { paths: ['src/gone.ts', './src/also-gone.ts'] })),
    factLine(fact('f_some01', 'One file left.', { paths: ['src/gone.ts', 'src\\kept.ts'] })),
    factLine(fact('f_abs001', 'Absolute path.', { paths: ['D:/abs/here.ts'] })),
    factLine(fact('f_none01', 'No paths.')),
  ]
  const { model, calls } = memModel(
    sections({ convention: ['f_gone01', 'f_some01', 'f_abs001', 'f_none01'].map((id) => ({ id, text: `Fact ${id}.` })) }),
  )
  const r = await consolidate({ fs, model, files: memFiles(lines), paths }, OPTS)
  expect(r).toEqual({ status: 'done', kept: 4, dropped: 0, stale: 1 })
  expect(calls[0]!.prompt).toContain('"possiblyStale": true')
  const md = fs.files.get(paths.knowledgeFile(KEY))!
  expect(md).toContain('- [f_gone01] Fact f_gone01. (possibly stale) (task t1,')
  expect(md).not.toContain('[f_some01] Fact f_some01. (possibly stale)')
})

test('a stale mark is cleared when a fact\'s file comes back', async () => {
  const stale: KnowledgeDoc = {
    project: 'demo',
    consolidatedAt: NOW - DAY,
    facts: [fact('f_back01', 'File is back.', { isStale: true })],
  }
  const fs = memFs({ [paths.knowledgeFile(KEY)]: renderKnowledge(stale), [`${PROJECT}/a.ts`]: '' })
  const lines = [factLine(fact('f_back01', 'File is back.', { paths: ['a.ts'] })), { kind: 'forget', v: 1, factId: 'x', at: NOW } as JournalLine]
  const { model, calls } = memModel(sections({}))
  const r = await consolidate({ fs, model, files: memFiles(lines), paths }, OPTS)
  // Nothing new in the inbox: no model call, the file is still rewritten.
  expect(calls.length).toBe(0)
  expect(r).toEqual({ status: 'done', kept: 1, dropped: 0, stale: 0 })
  expect(fs.files.get(paths.knowledgeFile(KEY))).not.toContain('possibly stale')
})

async function expectFailedUnchanged(reply: Parameters<typeof memModel>[0], reason: RegExp, extra: JournalLine[] = []) {
  const existing: KnowledgeDoc = {
    project: 'demo',
    consolidatedAt: NOW - DAY,
    facts: [fact('f_person', 'Keep me exactly.', { origin: 'person', sourceTaskId: undefined })],
  }
  const before = renderKnowledge(existing)
  const fs = memFs({ [paths.knowledgeFile(KEY)]: before })
  const files = memFiles([factLine(fact('f_new001', 'A new fact.')), ...extra])
  const { model } = memModel(reply)
  const r = await consolidate({ fs, model, files, paths }, OPTS)
  expect(r.status).toBe('failed')
  if (r.status === 'failed') expect(reason.test(r.reason)).toBe(true)
  expect(fs.files.get(paths.knowledgeFile(KEY))).toBe(before)
  expect(fs.files.has(paths.metaFile(KEY))).toBe(false)
  expect(files.released).toEqual(['me'])
}

test('invalid model output leaves knowledge.md unchanged', async () => {
  await expectFailedUnchanged('Sure! Here are the merged facts.', /JSON/)
  await expectFailedUnchanged('{"sections": [1, 2', /JSON/)
  await expectFailedUnchanged('{"facts": []}', /sections/)
  await expectFailedUnchanged(sections({ misc: [{ id: 'f_new001', text: 'x' }] }), /unknown section/)
  await expectFailedUnchanged({ reason: 'usage limit' }, /usage limit/)
  await expectFailedUnchanged(() => {
    throw new Error('network down')
  }, /network down/)
})

test('person facts must survive word for word', async () => {
  const keep = { id: 'f_person', text: 'Keep me exactly.' }
  const fresh = { id: 'f_new001', text: 'A new fact.' }
  await expectFailedUnchanged(sections({ convention: [fresh] }), /dropped the person fact f_person/)
  await expectFailedUnchanged(sections({ convention: [fresh, { id: 'f_person', text: 'Keep me, roughly.' }] }), /changed the person fact/)
  // Kept exactly (even in another section): fine, and it stays in its own kind.
  const fs = memFs({
    [paths.knowledgeFile(KEY)]: renderKnowledge({
      project: 'demo',
      consolidatedAt: 0,
      facts: [fact('f_person', 'Keep me exactly.', { kind: 'gotcha', origin: 'person', sourceTaskId: undefined })],
    }),
  })
  const { model } = memModel(sections({ convention: [fresh, keep] }))
  const r = await consolidate({ fs, model, files: memFiles([factLine(fact('f_new001', 'A new fact.'))]), paths }, OPTS)
  expect(r.status).toBe('done')
  const person = parseKnowledge(fs.files.get(paths.knowledgeFile(KEY))!).facts.find((f) => f.id === 'f_person')!
  expect(person.kind).toBe('gotcha')
  expect(person.origin).toBe('person')
  expect(person.text).toBe('Keep me exactly.')
})

test('invented ids, forgotten ids and oversize results are refused', async () => {
  const keep = { id: 'f_person', text: 'Keep me exactly.' }
  await expectFailedUnchanged(sections({ convention: [keep, { id: 'f_made_up', text: 'Invented.' }] }), /invented the id f_made_up/)
  await expectFailedUnchanged(
    sections({ convention: [keep, { id: 'f_forgot', text: 'Forgotten.' }] }),
    /invented the id f_forgot/,
    [factLine(fact('f_forgot', 'Forgotten.')), { kind: 'forget', v: 1, factId: 'f_forgot', at: NOW }],
  )
  const many = Array.from({ length: 50 }, (_, i) => factLine(fact(`f_big${String(i).padStart(3, '0')}`, `Fact ${i}.`)))
  await expectFailedUnchanged(
    sections({ convention: [keep, ...many.map((l) => ({ id: (l as { fact: Fact }).fact.id, text: 'x'.repeat(290) }))] }),
    /over the 12000 cap/,
    many,
  )
})

test('nothing to consolidate is a skip, and the lock is still released', async () => {
  const fs = memFs()
  const { model, calls } = memModel(sections({}))
  const files = memFiles([])
  const r = await consolidate({ fs, model, files, paths }, OPTS)
  expect(r.status).toBe('skipped')
  expect(calls.length).toBe(0)
  expect(files.released).toEqual(['me'])
})

test('an unreadable knowledge.md is not overwritten', async () => {
  const fs = memFs({ [paths.knowledgeFile(KEY)]: 'x' })
  fs.read = async () => {
    throw new Error('EACCES')
  }
  const { model, calls } = memModel(sections({}))
  const files = memFiles([factLine(fact('f_new001', 'A fact.'))])
  const r = await consolidate({ fs, model, files, paths }, OPTS)
  expect(r).toEqual({ status: 'failed', reason: 'EACCES' })
  expect(calls.length).toBe(0)
  expect(fs.files.get(paths.knowledgeFile(KEY))).toBe('x')
  expect(files.released).toEqual(['me'])
})
