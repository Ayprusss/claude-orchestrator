// Code changes for the HUD's diff view, built from what an Edit or Write call
// returned. No engine calls.

export type Hunk = { oldStart: number; newStart: number; lines: string[] }

export type CodeDiff = {
  file: string
  op: 'edit' | 'create' | 'update'
  hunks: Hunk[]
  added: number
  removed: number
  isTruncated: boolean
}

// A diff is shown, not archived: past this many lines the rest is cut.
const MAX_LINES = 300
const MAX_LINE_CHARS = 400

type PatchRecord = {
  filePath?: unknown
  type?: unknown
  content?: unknown
  structuredPatch?: unknown
}

const asLines = (text: string, sign: '+' | '-') =>
  text.replace(/\n$/, '').split('\n').map(l => sign + l)

/**
 * The diff of one Edit or Write call, from the tool's input and its result
 * record; undefined when there is nothing to show.
 */
export function buildDiff(
  tool: 'Edit' | 'Write',
  input: Record<string, unknown>,
  result: unknown,
): CodeDiff | undefined {
  const r = (result && typeof result === 'object' ? result : {}) as PatchRecord
  const file = String(r.filePath ?? input.file_path ?? '')
  if (!file) return undefined

  let hunks: Hunk[] = Array.isArray(r.structuredPatch)
    ? (r.structuredPatch as Array<Record<string, unknown>>)
        .filter(h => Array.isArray(h.lines))
        .map(h => ({
          oldStart: Number(h.oldStart) || 0,
          newStart: Number(h.newStart) || 0,
          lines: (h.lines as unknown[]).map(String),
        }))
    : []

  // No patch (a new file, or a diff the tool skipped): build one from the input.
  if (hunks.length === 0) {
    if (tool === 'Write') {
      const content = typeof r.content === 'string' ? r.content : String(input.content ?? '')
      if (content) hunks = [{ oldStart: 0, newStart: 1, lines: asLines(content, '+') }]
    } else if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      hunks = [
        {
          oldStart: 0,
          newStart: 0,
          lines: [...asLines(input.old_string, '-'), ...asLines(input.new_string, '+')],
        },
      ]
    }
  }
  if (hunks.length === 0) return undefined

  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  }

  // Keep the first MAX_LINES lines, whole hunks first.
  let left = MAX_LINES
  let isTruncated = false
  const kept: Hunk[] = []
  for (const h of hunks) {
    if (left <= 0) {
      isTruncated = true
      break
    }
    const lines = h.lines.slice(0, left).map(l => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…' : l))
    if (lines.length < h.lines.length) isTruncated = true
    kept.push({ ...h, lines })
    left -= lines.length
  }

  const op = tool === 'Edit' ? 'edit' : r.type === 'create' ? 'create' : 'update'
  return { file, op, hunks: kept, added, removed, isTruncated }
}
