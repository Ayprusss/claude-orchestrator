// Upkeep (MEMORY_HARNESS_PLAN.md §9.4): old ledgers and transcripts are deleted.
// Pure selection only; the harness does the listing and the deleting.

export const LEDGER_KEEP_MS = 30 * 86_400_000
export const TRANSCRIPT_KEEP_MS = 30 * 86_400_000
export const TRANSCRIPTS_PER_PROJECT = 200

export type DirEntry = { name: string; kind: string; mtimeMs: number }

/**
 * Names of the files to delete: those older than `maxAgeMs`, and any beyond
 * the newest `keepNewest`. Only files ending in `suffix` are considered, and
 * names in `skip` are never chosen.
 */
export function pickPrunable(
  entries: readonly DirEntry[],
  now: number,
  opts: { suffix: string; maxAgeMs: number; keepNewest?: number; skip?: readonly string[] },
): string[] {
  const skip = new Set(opts.skip ?? [])
  const files = entries
    .filter(e => e.kind === 'file' && e.name.endsWith(opts.suffix) && !skip.has(e.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const keep = opts.keepNewest ?? Number.POSITIVE_INFINITY
  return files.filter((e, i) => i >= keep || now - e.mtimeMs > opts.maxAgeMs).map(e => e.name)
}

/** True for a path directly under `root` with no `..` segment, so a bad list can't reach elsewhere. */
export function isUnder(root: string, path: string): boolean {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const p = path.replace(/\\/g, '/')
  return p.toLowerCase().startsWith(`${r}/`) && !p.split('/').includes('..')
}
