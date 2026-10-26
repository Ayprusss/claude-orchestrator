import { expect, test } from 'claude-code/testing'

import { JOURNAL_ROTATE_BYTES } from './contract'
import type { Episode, Fact, JournalLine, MemFs } from './contract'
import { acquireLock, appendJournal, createFileQueue, readJournal, readJson, releaseLock } from './files'
import { memoryPaths } from './paths'

// ---- An in-memory MemFs ---------------------------------------------------------

type FakeFs = MemFs & {
  files: Map<string, string>
  writes: string[]
  /** Optional per-write delay (in yields) and failure, by path. */
  delay: (path: string, text: string) => number
  fail: (path: string, text: string) => boolean
  /** Runs after each write lands (to simulate another session). */
  afterWrite?: (path: string, text: string) => void
}

/** Yields to other promise work `n` times (no timers in this environment's types). */
const tick = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function fakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(seed))
  const fs: FakeFs = {
    files,
    writes: [],
    delay: () => 0,
    fail: () => false,
    read: async (path) => {
      await tick(1)
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    write: async (path, text) => {
      const ms = fs.delay(path, text)
      await tick(ms)
      if (fs.fail(path, text)) throw new Error(`EIO ${path}`)
      files.set(path, text)
      fs.writes.push(path)
      fs.afterWrite?.(path, text)
    },
    list: async (dir) => {
      const prefix = `${dir}/`
      const seen = new Map<string, { name: string; kind: string; size: number; mtimeMs: number }>()
      for (const [path, text] of files) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) seen.set(rest, { name: rest, kind: 'file', size: text.length, mtimeMs: 1 })
        else seen.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'dir', size: 0, mtimeMs: 0 })
      }
      if (seen.size === 0) throw new Error(`ENOENT ${dir}`)
      return [...seen.values()]
    },
    exists: async (path) => files.has(path) || [...files.keys()].some((p) => p.startsWith(`${path}/`)),
  }
  return fs
}

const ROOT = '/mem'
const P = memoryPaths(ROOT)
const KEY = 'repo-0a1b2c3d'
const DIR = P.journalDir(KEY)

function fact(id: string, sessionId = 's1', text = `fact ${id}`): Fact {
  return { id, text, kind: 'convention', origin: 'summary', sessionId, at: 1 }
}
const factLine = (id: string, sessionId = 's1'): JournalLine => ({ kind: 'fact', v: 1, fact: fact(id, sessionId) })

function episode(taskId: string): Episode {
  return {
    taskId,
    sessionId: 's1',
    title: 'Fix it',
    prompt: 'Fix the bug',
    backend: 'agent',
    status: 'done',
    outcome: 'succeeded',
    summary: 'Fixed.',
    isRawOutput: true,
    files: [],
    followups: [],
    interruptions: 0,
    endedAt: 2,
  }
}

const ids = (lines: JournalLine[]) =>
  lines.map((l) => (l.kind === 'fact' ? l.fact.id : l.kind === 'episode' ? l.episode.taskId : `forget:${l.factId}`))

// ---- Serialized writes ------------------------------------------------------------

test('two writes in a row to one path both land, in call order', async () => {
  const fs = fakeFs()
  // The first write is slower than the second; it must still land first.
  fs.delay = (_path, text) => (text === 'one' ? 20 : 0)
  const q = createFileQueue(fs)
  const a = q.write('/x/a.json', 'one')
  const b = q.write('/x/a.json', 'two')
  await Promise.all([a, b])
  expect(fs.writes).toEqual(['/x/a.json', '/x/a.json'])
  expect(fs.files.get('/x/a.json')).toBe('two')
})

test('flush waits for every queued write', async () => {
  const fs = fakeFs()
  fs.delay = () => 5
  const q = createFileQueue(fs)
  void q.write('/x/a', '1')
  void q.write('/x/a', '2')
  void q.write('/x/b', '3')
  await q.flush()
  expect(fs.files.get('/x/a')).toBe('2')
  expect(fs.files.get('/x/b')).toBe('3')
  await q.flush() // an empty queue resolves at once
})

test('a failed write rejects its caller but does not block the next one', async () => {
  const fs = fakeFs()
  fs.fail = (_path, text) => text === 'bad'
  const q = createFileQueue(fs)
  const bad = q.write('/x/a', 'bad')
  const good = q.write('/x/a', 'good')
  let isRejected = false
  await bad.catch(() => {
    isRejected = true
  })
  await good
  expect(isRejected).toBe(true)
  expect(fs.files.get('/x/a')).toBe('good')
  await q.flush()
})

// ---- Journal ------------------------------------------------------------------------

test('appends add JSON lines to this session\'s journal', async () => {
  const fs = fakeFs()
  const q = createFileQueue(fs)
  await appendJournal(fs, q, P, KEY, 's1', [factLine('f_aaaaaa'), { kind: 'episode', v: 1, episode: episode('t1') }])
  await appendJournal(fs, q, P, KEY, 's1', [{ kind: 'forget', v: 1, factId: 'f_aaaaaa', at: 3 }])
  const text = fs.files.get(`${DIR}/s1.jsonl`) ?? ''
  expect(text.split('\n')).toHaveLength(4) // three lines and the final newline
  expect(text.endsWith('\n')).toBe(true)
  expect(ids(await readJournal(fs, P, KEY))).toEqual(['f_aaaaaa', 't1', 'forget:f_aaaaaa'])
})

test('appends that overlap do not lose lines', async () => {
  const fs = fakeFs()
  fs.delay = () => 3
  const q = createFileQueue(fs)
  await Promise.all([
    appendJournal(fs, q, P, KEY, 's1', [factLine('f_one111')]),
    appendJournal(fs, q, P, KEY, 's1', [factLine('f_two222')]),
    appendJournal(fs, q, P, KEY, 's1', [factLine('f_three3')]),
  ])
  expect(ids(await readJournal(fs, P, KEY))).toEqual(['f_one111', 'f_two222', 'f_three3'])
})

test('flush also waits for an append that is still reading', async () => {
  const fs = fakeFs()
  const q = createFileQueue(fs)
  void appendJournal(fs, q, P, KEY, 's1', [factLine('f_late00')])
  await q.flush()
  expect(fs.files.has(`${DIR}/s1.jsonl`)).toBe(true)
})

test('journals of every session merge on read, and only this session\'s file is written', async () => {
  const fs = fakeFs({
    [`${DIR}/s2.jsonl`]: JSON.stringify(factLine('f_bbbbbb', 's2')) + '\n',
  })
  const q = createFileQueue(fs)
  await appendJournal(fs, q, P, KEY, 's1', [factLine('f_aaaaaa')])
  await appendJournal(fs, q, P, KEY, 's3', [factLine('f_cccccc', 's3')])
  expect(fs.writes).toEqual([`${DIR}/s1.jsonl`, `${DIR}/s3.jsonl`])
  expect(ids(await readJournal(fs, P, KEY))).toEqual(['f_aaaaaa', 'f_bbbbbb', 'f_cccccc'])
})

test('bad lines, unknown versions and unknown kinds are skipped', async () => {
  const lines = [
    JSON.stringify(factLine('f_good01')),
    '{not json',
    '',
    JSON.stringify({ kind: 'fact', v: 2, fact: fact('f_future') }),
    JSON.stringify({ kind: 'mystery', v: 1 }),
    JSON.stringify({ kind: 'fact', v: 1 }),
    JSON.stringify({ kind: 'forget', v: 1, at: 1 }),
    '[1,2,3]',
    JSON.stringify({ kind: 'forget', v: 1, factId: 'f_good01', at: 4 }),
    '{"kind":"fact","v":1,"fact":{"id":"f_torn',
  ]
  const fs = fakeFs({
    [`${DIR}/s1.jsonl`]: lines.join('\n'),
    [`${DIR}/notes.txt`]: 'ignored',
  })
  expect(ids(await readJournal(fs, P, KEY))).toEqual(['f_good01', 'forget:f_good01'])
})

test('a torn last line does not swallow the next append', async () => {
  const fs = fakeFs({ [`${DIR}/s1.jsonl`]: JSON.stringify(factLine('f_first0')) + '\n{"kind":"fa' })
  const q = createFileQueue(fs)
  await appendJournal(fs, q, P, KEY, 's1', [factLine('f_second')])
  expect(ids(await readJournal(fs, P, KEY))).toEqual(['f_first0', 'f_second'])
})

test('a project with no journal reads as empty', async () => {
  expect(await readJournal(fakeFs(), P, KEY)).toEqual([])
})

test('a journal rotates to the next part past the size limit, and keeps appending there', async () => {
  const filler = JSON.stringify(factLine('f_filler')) + '\n'
  // Just under the limit (ASCII, so characters are bytes); one more line goes over.
  const big = filler.repeat(Math.floor(JOURNAL_ROTATE_BYTES / filler.length))
  const fs = fakeFs({ [`${DIR}/s1.jsonl`]: big })
  const q = createFileQueue(fs)
  await appendJournal(fs, q, P, KEY, 's1', [factLine('f_next01')])
  expect(fs.files.get(`${DIR}/s1.jsonl`) === big).toBe(true) // the full part is left alone
  expect(fs.files.get(`${DIR}/s1.1.jsonl`)).toBe(JSON.stringify(factLine('f_next01')) + '\n')
  await appendJournal(fs, q, P, KEY, 's1', [factLine('f_next02')])
  expect(ids(await readJournal(fs, P, KEY)).slice(-2)).toEqual(['f_next01', 'f_next02'])
  expect(fs.files.has(`${DIR}/s1.2.jsonl`)).toBe(false)
})

test('an append that fits under the limit stays in the current part', async () => {
  const filler = JSON.stringify(factLine('f_filler')) + '\n'
  const small = filler.repeat(10)
  const fs = fakeFs({ [`${DIR}/s1.jsonl`]: small })
  const q = createFileQueue(fs)
  await appendJournal(fs, q, P, KEY, 's1', [factLine('f_next01')])
  expect(fs.files.has(`${DIR}/s1.1.jsonl`)).toBe(false)
  expect((fs.files.get(`${DIR}/s1.jsonl`) ?? '').startsWith(small)).toBe(true)
})

test('parts are read in order: session, then part number', async () => {
  const fs = fakeFs({
    [`${DIR}/s1.10.jsonl`]: JSON.stringify(factLine('f_p10000')) + '\n',
    [`${DIR}/s1.2.jsonl`]: JSON.stringify(factLine('f_p20000')) + '\n',
    [`${DIR}/s1.jsonl`]: JSON.stringify(factLine('f_p00000')) + '\n',
    [`${DIR}/s0.jsonl`]: JSON.stringify(factLine('f_s00000', 's0')) + '\n',
  })
  expect(ids(await readJournal(fs, P, KEY))).toEqual(['f_s00000', 'f_p00000', 'f_p20000', 'f_p10000'])
  // The next append goes to the highest part.
  const q = createFileQueue(fs)
  await appendJournal(fs, q, P, KEY, 's1', [factLine('f_newest')])
  expect((fs.files.get(`${DIR}/s1.10.jsonl`) ?? '').includes('f_newest')).toBe(true)
})

// ---- JSON ---------------------------------------------------------------------------

test('readJson gives the value, or undefined when missing or invalid', async () => {
  const fs = fakeFs({ '/m/a.json': '{"path":"/repo","n":2}', '/m/bad.json': '{oops', '/m/empty.json': '' })
  expect(await readJson<{ path: string; n: number }>(fs, '/m/a.json')).toEqual({ path: '/repo', n: 2 })
  expect(await readJson(fs, '/m/bad.json')).toBeUndefined()
  expect(await readJson(fs, '/m/empty.json')).toBeUndefined()
  expect(await readJson(fs, '/m/missing.json')).toBeUndefined()
})

// ---- Lock ---------------------------------------------------------------------------

const LOCK = P.lockFile(KEY)
const TTL = 5 * 60_000

test('a free lock is taken, and written with its owner and expiry', async () => {
  const fs = fakeFs()
  expect(await acquireLock(fs, LOCK, 's1', 1000, TTL)).toBe(true)
  expect(JSON.parse(fs.files.get(LOCK) ?? '')).toEqual({ sessionId: 's1', until: 1000 + TTL })
})

test('a lock another session holds is refused and left alone', async () => {
  const held = JSON.stringify({ sessionId: 's2', until: 5000 })
  const fs = fakeFs({ [LOCK]: held })
  expect(await acquireLock(fs, LOCK, 's1', 4999, TTL)).toBe(false)
  expect(fs.files.get(LOCK)).toBe(held)
  expect(fs.writes).toEqual([])
})

test('an expired lock can be taken over', async () => {
  const fs = fakeFs({ [LOCK]: JSON.stringify({ sessionId: 's2', until: 5000 }) })
  expect(await acquireLock(fs, LOCK, 's1', 5000, TTL)).toBe(true)
  expect(JSON.parse(fs.files.get(LOCK) ?? '').sessionId).toBe('s1')
})

test('our own lock is taken again and extended', async () => {
  const fs = fakeFs({ [LOCK]: JSON.stringify({ sessionId: 's1', until: 5000 }) })
  expect(await acquireLock(fs, LOCK, 's1', 4000, TTL)).toBe(true)
  expect(JSON.parse(fs.files.get(LOCK) ?? '').until).toBe(4000 + TTL)
})

test('a corrupt lock file counts as free', async () => {
  const fs = fakeFs({ [LOCK]: 'garbage' })
  expect(await acquireLock(fs, LOCK, 's1', 1000, TTL)).toBe(true)
})

test('losing the race on read-back means the lock is not ours', async () => {
  const fs = fakeFs()
  // Another session writes right after us.
  fs.afterWrite = (path) => {
    if (path === LOCK) fs.files.set(LOCK, JSON.stringify({ sessionId: 's2', until: 9_999_999 }))
  }
  expect(await acquireLock(fs, LOCK, 's1', 1000, TTL)).toBe(false)
})

test('a failing fs never throws from the lock calls', async () => {
  const fs = fakeFs()
  fs.fail = () => true
  expect(await acquireLock(fs, LOCK, 's1', 1000, TTL)).toBe(false)
  await releaseLock(fs, LOCK, 's1')
})

test('release frees only our own lock', async () => {
  const fs = fakeFs()
  expect(await acquireLock(fs, LOCK, 's1', 1000, TTL)).toBe(true)
  await releaseLock(fs, LOCK, 's2') // not theirs: unchanged
  expect(JSON.parse(fs.files.get(LOCK) ?? '').sessionId).toBe('s1')
  expect(await acquireLock(fs, LOCK, 's2', 2000, TTL)).toBe(false)
  await releaseLock(fs, LOCK, 's1')
  expect(await acquireLock(fs, LOCK, 's2', 2000, TTL)).toBe(true)
  // Releasing a missing lock writes nothing.
  const empty = fakeFs()
  await releaseLock(empty, LOCK, 's1')
  expect(empty.writes).toEqual([])
})
