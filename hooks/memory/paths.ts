// Memory paths (plan §6.2): normalizing project folders, project keys, and
// the on-disk layout under the memory root. Pure: no fs, no Node.

import type { MemoryPaths, PathsModule } from './contract'

const DRIVE = /^[a-zA-Z]:/
const SLUG_MAX = 40

/** Forward slashes, no trailing slash, lower-cased when it looks like a Windows path. */
export function normalizePath(path: string): string {
  const raw = path.trim()
  const isWindows = DRIVE.test(raw) || raw.includes('\\')
  let p = raw.replace(/\\/g, '/')
  // Collapse repeated slashes, keeping a leading '//' (a UNC share).
  const lead = p.startsWith('//') ? '//' : ''
  p = lead + p.slice(lead.length).replace(/\/{2,}/g, '/')
  // Drop trailing slashes, but keep a bare root ('/' or 'c:/').
  while (p.endsWith('/') && p.length > 1 && !/^[a-zA-Z]:\/$/.test(p) && p !== lead) p = p.slice(0, -1)
  return isWindows ? p.toLowerCase() : p
}

/** FNV-1a, 32-bit, over the UTF-8 bytes of the text. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function slugOf(normalized: string): string {
  const name = normalized.split('/').filter(Boolean).pop() ?? ''
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  return slug || 'project'
}

/** `<slug>-<hash8>`; stable for the same normalized path. */
export function projectKey(path: string): string {
  const normalized = normalizePath(path)
  return `${slugOf(normalized)}-${fnv1a(normalized).toString(16).padStart(8, '0')}`
}

/** The memory root: the setting if set, else `<homeDir>/.claude/orchestrator-memory`, else undefined. */
export function resolveMemoryRoot(opts: { setting: string; homeDir?: string }): string | undefined {
  const setting = (opts.setting ?? '').trim()
  if (setting) return normalizePath(setting)
  const home = (opts.homeDir ?? '').trim()
  if (home) return `${normalizePath(home).replace(/\/$/, '')}/.claude/orchestrator-memory`
  return undefined
}

/** Keeps ids safe as one file-name segment (UUIDs and keys pass unchanged). */
function seg(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_') || '_'
}

export function memoryPaths(root: string): MemoryPaths {
  const trimmed = root.trim()
  const base = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') || '/' : trimmed
  // A root such as '/' or 'c:/' already ends in a slash.
  const at = (rest: string) => (base.endsWith('/') ? base + rest : `${base}/${rest}`)
  const projectDir = (key: string) => at(`projects/${seg(key)}`)
  const journalDir = (key: string) => `${projectDir(key)}/journal`
  return {
    root: base,
    versionFile: at('VERSION'),
    ledgersDir: at('ledgers'),
    ledgerFile: (sessionId) => at(`ledgers/${seg(sessionId)}.json`),
    projectDir,
    metaFile: (key) => `${projectDir(key)}/meta.json`,
    knowledgeFile: (key) => `${projectDir(key)}/knowledge.md`,
    lockFile: (key) => `${projectDir(key)}/knowledge.lock`,
    journalDir,
    journalFile: (key, sessionId, part) =>
      `${journalDir(key)}/${seg(sessionId)}${part && part > 0 ? `.${Math.floor(part)}` : ''}.jsonl`,
    transcriptFile: (key, taskId) => `${projectDir(key)}/transcripts/${seg(taskId)}.md`,
  }
}

export const pathsModule: PathsModule = { normalizePath, projectKey, resolveMemoryRoot, memoryPaths }
