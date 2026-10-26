// Memory files (plan §6.2, §9.3, §9.4): serialized writes, the per-session
// project journal (JSONL, rotating), JSON reads, and the knowledge lock.
// Only web APIs: no Node, no DOM. Every fs access goes through MemFs.

import { JOURNAL_ROTATE_BYTES } from './contract'
import type { FileQueue, FilesModule, JournalLine, MemFs, MemoryPaths } from './contract'

const encoder = new TextEncoder()
const byteLength = (text: string) => encoder.encode(text).length

/** Read-modify-write journal appends, chained per journal file, per queue (one queue per session). */
const appendChains = new WeakMap<FileQueue, Map<string, Promise<void>>>()

// ---- Serialized writes ------------------------------------------------------

/** Writes are chained per path, so two writes in a row land in call order. */
export function createFileQueue(fs: MemFs): FileQueue {
  const chains = new Map<string, Promise<void>>()
  const write = (path: string, text: string): Promise<void> => {
    const prev = chains.get(path) ?? Promise.resolve()
    const next = prev.then(() => fs.write(path, text))
    // The chain itself never rejects, so a failed write does not block later ones.
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    chains.set(path, settled)
    void settled.then(() => {
      if (chains.get(path) === settled) chains.delete(path)
    })
    return next
  }
  const flush = async (): Promise<void> => {
    // Journal appends still reading count too, and writes queued while
    // waiting are waited for as well.
    for (;;) {
      const pending = [...chains.values(), ...(appendChains.get(queue)?.values() ?? [])]
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }
  const queue: FileQueue = { write, flush }
  return queue
}

// ---- Journal ------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

async function listNames(fs: MemFs, dir: string): Promise<string[]> {
  try {
    if (!(await fs.exists(dir))) return []
    const entries = await fs.list(dir)
    return entries.filter((e) => e.kind !== 'dir').map((e) => e.name)
  } catch {
    return []
  }
}

async function readText(fs: MemFs, path: string): Promise<string | undefined> {
  try {
    if (!(await fs.exists(path))) return undefined
    return await fs.read(path)
  } catch {
    return undefined
  }
}

/** The highest existing part number of this session's journal (0 when none). */
async function currentPart(fs: MemFs, paths: MemoryPaths, key: string, sessionId: string): Promise<number> {
  const prefix = baseName(paths.journalFile(key, sessionId)).replace(/\.jsonl$/, '')
  const re = new RegExp(`^${escapeRe(prefix)}(?:\\.(\\d+))?\\.jsonl$`)
  let part = 0
  for (const name of await listNames(fs, paths.journalDir(key))) {
    const m = re.exec(name)
    if (m) part = Math.max(part, m[1] ? Number(m[1]) : 0)
  }
  return part
}

async function appendNow(
  fs: MemFs,
  q: FileQueue,
  paths: MemoryPaths,
  key: string,
  sessionId: string,
  lines: JournalLine[],
): Promise<void> {
  const add = lines.map((line) => JSON.stringify(line) + '\n').join('')
  let part = await currentPart(fs, paths, key, sessionId)
  let existing = (await readText(fs, paths.journalFile(key, sessionId, part))) ?? ''
  if (existing && !existing.endsWith('\n')) existing += '\n' // a torn last line stays its own (bad) line
  if (existing && byteLength(existing) + byteLength(add) > JOURNAL_ROTATE_BYTES) {
    part += 1
    existing = ''
  }
  await q.write(paths.journalFile(key, sessionId, part), existing + add)
}

/** Append lines to this session's journal (rotating at JOURNAL_ROTATE_BYTES). */
export function appendJournal(
  fs: MemFs,
  q: FileQueue,
  paths: MemoryPaths,
  key: string,
  sessionId: string,
  lines: JournalLine[],
): Promise<void> {
  if (lines.length === 0) return Promise.resolve()
  let chains = appendChains.get(q)
  if (!chains) appendChains.set(q, (chains = new Map()))
  const id = paths.journalFile(key, sessionId)
  const prev = chains.get(id) ?? Promise.resolve()
  const next = prev.then(() => appendNow(fs, q, paths, key, sessionId, lines))
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  chains.set(id, settled)
  void settled.then(() => {
    if (chains.get(id) === settled) chains.delete(id)
  })
  return next
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A known, well-formed v1 journal line, or undefined. */
function toJournalLine(value: unknown): JournalLine | undefined {
  if (!isObject(value) || value.v !== 1) return undefined
  switch (value.kind) {
    case 'episode':
      return isObject(value.episode) && typeof value.episode.taskId === 'string' ? (value as JournalLine) : undefined
    case 'fact':
      return isObject(value.fact) && typeof value.fact.id === 'string' && typeof value.fact.text === 'string'
        ? (value as JournalLine)
        : undefined
    case 'forget':
      return typeof value.factId === 'string' ? (value as JournalLine) : undefined
    default:
      return undefined
  }
}

/** Orders journal files by session name, then part number. */
function journalOrder(a: string, b: string): number {
  const split = (name: string): [string, number] => {
    const m = /^(.*?)(?:\.(\d+))?\.jsonl$/.exec(name)
    return m ? [m[1] ?? name, m[2] ? Number(m[2]) : 0] : [name, 0]
  }
  const [sa, pa] = split(a)
  const [sb, pb] = split(b)
  return sa < sb ? -1 : sa > sb ? 1 : pa - pb
}

/** Every line from every session's journal files of a project, skipping bad lines. */
export async function readJournal(fs: MemFs, paths: MemoryPaths, key: string): Promise<JournalLine[]> {
  const dir = paths.journalDir(key)
  const names = (await listNames(fs, dir)).filter((n) => n.endsWith('.jsonl')).sort(journalOrder)
  const out: JournalLine[] = []
  for (const name of names) {
    const text = await readText(fs, `${dir}/${name}`)
    if (!text) continue
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = toJournalLine(value)
      if (parsed) out.push(parsed)
    }
  }
  return out
}

// ---- JSON -----------------------------------------------------------------------

/** The parsed file, or undefined when it is missing, unreadable or not JSON. */
export async function readJson<T>(fs: MemFs, path: string): Promise<T | undefined> {
  const text = await readText(fs, path)
  if (text === undefined || !text.trim()) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

// ---- Lock -----------------------------------------------------------------------

type LockFile = { sessionId: string; until: number }

async function readLock(fs: MemFs, path: string): Promise<LockFile | undefined> {
  const value = await readJson<unknown>(fs, path)
  if (!isObject(value) || typeof value.sessionId !== 'string' || typeof value.until !== 'number') return undefined
  return { sessionId: value.sessionId, until: value.until }
}

/** Take the lock if free, expired, or ours. Write, read back, compare. Never throws. */
export async function acquireLock(fs: MemFs, path: string, sessionId: string, now: number, ttlMs: number): Promise<boolean> {
  try {
    const held = await readLock(fs, path)
    if (held && held.sessionId !== sessionId && held.until > now) return false
    const until = now + ttlMs
    await fs.write(path, JSON.stringify({ sessionId, until } satisfies LockFile))
    const back = await readLock(fs, path)
    return back !== undefined && back.sessionId === sessionId && back.until === until
  } catch {
    return false
  }
}

/** Frees the lock if it is ours (MemFs cannot delete, so it writes an expired lock). Never throws. */
export async function releaseLock(fs: MemFs, path: string, sessionId: string): Promise<void> {
  try {
    const held = await readLock(fs, path)
    if (!held || held.sessionId !== sessionId) return
    await fs.write(path, JSON.stringify({ sessionId, until: 0 } satisfies LockFile))
  } catch {
    // Left as is: it expires on its own.
  }
}

export const filesModule: FilesModule = {
  createFileQueue,
  appendJournal,
  readJournal,
  readJson,
  acquireLock,
  releaseLock,
}
