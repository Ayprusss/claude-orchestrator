// Briefs (TOKEN_SAVINGS_PLAN.md items 4 and 7): instead of an agent reading a
// whole plan, the orchestrator writes it a short brief file with only the
// sections it needs, and, for a batch, the shared context written once.
// Pure functions; register.tsx does the file I/O.

/** One entry of a task's reading list: a file, or one section of a Markdown file. */
export type ReadRef = { path: string; heading?: string }

const MAX_READS = 20
const SECTION_CAP = 40_000

/** `path` or `path#Heading`, relative to the project folder; bad entries are dropped. */
export function parseReads(list: unknown): ReadRef[] {
  if (!Array.isArray(list)) return []
  const out: ReadRef[] = []
  for (const raw of list.slice(0, MAX_READS)) {
    if (typeof raw !== 'string') continue
    const i = raw.indexOf('#')
    const path = (i === -1 ? raw : raw.slice(0, i)).trim()
    const heading = i === -1 ? '' : raw.slice(i + 1).trim()
    // Relative paths inside the project only.
    if (!path || /^([a-z]:)?[\\/]/i.test(path) || path.split(/[\\/]/).includes('..')) continue
    out.push(heading ? { path, heading } : { path })
  }
  return out
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

const norm = (text: string) => text.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()

/**
 * The section of `markdown` under the first heading that starts with
 * `heading` (case, spacing and emphasis aside), up to the next heading of the
 * same or a higher level. Headings inside fenced code are not headings.
 * undefined when no heading matches.
 */
export function extractSection(markdown: string, heading: string): string | undefined {
  const want = norm(heading.replace(/^#+\s*/, ''))
  if (!want) return undefined
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let start = -1
  let level = 0
  let isFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(```|~~~)/.test(line)) isFence = !isFence
    if (isFence) continue
    const m = HEADING.exec(line)
    if (!m) continue
    const lvl = (m[1] ?? '').length
    if (start === -1) {
      if (norm(m[2] ?? '').startsWith(want)) {
        start = i
        level = lvl
      }
    } else if (lvl <= level) {
      return clipSection(lines.slice(start, i).join('\n'))
    }
  }
  return start === -1 ? undefined : clipSection(lines.slice(start).join('\n'))
}

const clipSection = (text: string) =>
  text.length > SECTION_CAP ? `${text.slice(0, SECTION_CAP)}\n\n[… section cut at ${SECTION_CAP} characters]` : text.trimEnd()

export type BriefPart =
  | { kind: 'section'; path: string; heading: string; text: string }
  | { kind: 'missing'; path: string; heading?: string; reason: string }
  | { kind: 'file'; path: string }

/** The brief file's Markdown. */
export function renderBrief(opts: { title: string; sharedPath?: string; parts: readonly BriefPart[] }): string {
  const out: string[] = [`# Brief: ${opts.title}`, '']
  if (opts.sharedPath) {
    out.push(`Read the shared context for this group of tasks first: ${opts.sharedPath}`, '')
  }
  const sections = opts.parts.filter(p => p.kind === 'section')
  const files = opts.parts.filter(p => p.kind === 'file')
  const missing = opts.parts.filter(p => p.kind === 'missing')
  if (files.length) {
    out.push('## Files to read', '', ...files.map(f => `- ${f.path}`), '')
  }
  for (const s of sections) {
    out.push(`## From ${s.path}`, '', s.text, '')
  }
  if (missing.length) {
    out.push('## Not found', '', ...missing.map(m => `- ${m.path}${m.heading ? `#${m.heading}` : ''}: ${m.reason}`), '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** The shared context file of a batch. */
export function renderShared(batchId: string, shared: string): string {
  return `# Shared context (batch ${batchId})\n\n${shared.trim()}\n`
}

/** The line a task's prompt starts with when it has a brief. */
export function briefLine(briefPath: string): string {
  return `Read the brief at ${briefPath} first: it has the context and the sections of the plan you need. Read other files only as your work needs them.`
}

/** Without a brief file (memory off): the brief's text goes into the prompt itself. */
export function inlineBrief(markdown: string, prompt: string): string {
  return `${markdown.trim()}\n\n---\n\n${prompt}`
}

/**
 * The large-read guard: a Read with no offset or limit of a file over
 * `limitKB` gets this refusal; undefined when the read may go ahead.
 */
export function largeReadRefusal(input: { offset?: unknown; limit?: unknown }, sizeBytes: number, limitKB: number): string | undefined {
  if (!limitKB || limitKB <= 0) return undefined
  if (input.offset !== undefined || input.limit !== undefined) return undefined
  if (sizeBytes <= limitKB * 1024) return undefined
  const kb = Math.round(sizeBytes / 1024)
  return `This file is ${kb} KB, over the orchestrator's ${limitKB} KB limit for whole-file reads. Search it first (Grep), then Read the part you need with offset and limit.`
}
