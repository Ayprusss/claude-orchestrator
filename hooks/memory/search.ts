// Keyword search over a project's memory (plan §9.2): a tokenizer, a small
// in-memory BM25 index over facts and episodes, and ranking boosts.
// Pure and deterministic: no fs, no clock (the caller passes `now`).

import type { Episode, Fact, JournalLine, KnowledgeDoc, MemoryIndex, SearchHit, SearchModule } from './contract'

// ---- Tokenizer -------------------------------------------------------------

/** Common English words that carry no meaning for search. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing done down during each either else etc even ever every few for from further get gets got had has ' +
    'have having he her here hers herself him himself his how however i if in into is it its itself just let like may me might ' +
    'more most must my myself no nor not now of off on once one only or other our ours ourselves out over own per please same ' +
    'shall she should so some such than that the their theirs them themselves then there these they this those through thus to ' +
    'too under until up upon us use used uses using very via was we were what when where whether which while who whom whose why ' +
    'will with within without would yet you your yours yourself yourselves'
  ).split(' '),
)

// A path-like run: word characters joined by `/`, `\` or `.` (e.g. `hooks/register.tsx`,
// `register.tsx`, `.env`), or else a plain run of word characters.
const TOKEN_RE = /[\p{L}\p{N}_-]*(?:[\/\\.][\p{L}\p{N}_-]+)+|[\p{L}\p{N}_]+/gu
const PART_RE = /[\p{L}\p{N}_]+/gu

/** A light plural fold so `tests` matches `test` and `files` matches `file`. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

function isKept(word: string): boolean {
  return word.length >= 2 && !STOP_WORDS.has(word)
}

/**
 * Lower case, split on non-word characters, drop stop words. A path-like token
 * (`hooks/register.tsx`) is kept whole (backslashes turned into `/`) and also
 * split into its parts (`hook`, `register`, `tsx`). Repeats are kept, in order,
 * so callers can count term frequency.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().matchAll(TOKEN_RE)) {
    const token = raw[0]
    if (/[\/\\.]/.test(token)) {
      const whole = token.replace(/\\/g, '/').replace(/^\.\//, '')
      if (whole.length >= 2) out.push(whole)
      for (const part of whole.matchAll(PART_RE)) {
        if (isKept(part[0])) out.push(stem(part[0]))
      }
    } else if (isKept(token)) {
      out.push(stem(token))
    }
  }
  return out
}

// ---- Index -----------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
export const RECENCY_HALF_LIFE_DAYS = 30
export const PERSON_BOOST = 1.5
export const KNOWLEDGE_BOOST = 1.3
export const STALE_FACTOR = 0.5
const K1 = 1.2
const B = 0.75

type DocBase = { terms: Map<string, number>; length: number; boost: number; at: number; id: string }
type FactDoc = DocBase & { type: 'fact'; fact: Fact; isKnowledge: boolean }
type EpisodeDoc = DocBase & { type: 'episode'; episode: Episode }
type Doc = FactDoc | EpisodeDoc

/** The concrete index behind the contract's opaque `MemoryIndex`. */
export type SearchIndex = MemoryIndex & {
  readonly docs: readonly Doc[]
  /** Document frequency of each term, over all docs. */
  readonly df: ReadonlyMap<string, number>
  /** Average document length per type (facts are short, episodes long). */
  readonly avgLength: { readonly fact: number; readonly episode: number }
  readonly now: number
}

function isSearchIndex(index: MemoryIndex): index is SearchIndex {
  const i = index as Partial<SearchIndex>
  return Array.isArray(i.docs) && i.df instanceof Map && typeof i.avgLength === 'object'
}

function termCounts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

/** 1 for something written now, falling toward 0.5 with a 30-day half-life. */
function recency(at: number, now: number): number {
  const ageDays = Math.max(0, now - (Number.isFinite(at) ? at : now)) / DAY_MS
  return 0.5 + 0.5 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

function factDoc(fact: Fact, isKnowledge: boolean, now: number): FactDoc {
  const tokens = tokenize([fact.text, ...(fact.paths ?? [])].join(' '))
  let boost = recency(fact.at, now)
  if (fact.origin === 'person') boost *= PERSON_BOOST
  if (isKnowledge) boost *= KNOWLEDGE_BOOST
  if (fact.isStale) boost *= STALE_FACTOR
  return { type: 'fact', fact, isKnowledge, terms: termCounts(tokens), length: tokens.length, boost, at: fact.at, id: fact.id }
}

function episodeDoc(episode: Episode, now: number): EpisodeDoc {
  const tokens = tokenize([episode.title, episode.summary, ...(episode.files ?? [])].join(' '))
  return {
    type: 'episode',
    episode,
    terms: termCounts(tokens),
    length: tokens.length,
    boost: recency(episode.endedAt, now),
    at: episode.endedAt,
    id: episode.taskId,
  }
}

/**
 * Builds the index. `forget` lines remove a fact (from knowledge and inbox alike);
 * a knowledge fact replaces any journal fact with the same id (and takes that
 * fact's `paths` when it has none, since knowledge.md does not store them).
 * `consolidatedIds` (meta.json `consolidatedFactIds`, optional) hides journal
 * facts that an earlier consolidation merged away or dropped. A task with several
 * episode lines (a raw one, then its summary after standby) keeps the summarized
 * one, else the last line.
 */
export function buildIndex(
  lines: JournalLine[],
  knowledge: KnowledgeDoc | undefined,
  now: number,
  consolidatedIds?: Iterable<string>,
): SearchIndex {
  const forgotten = new Set<string>()
  for (const line of lines) if (line.kind === 'forget') forgotten.add(line.factId)
  const consolidated = new Set(consolidatedIds ?? [])

  const facts = new Map<string, { fact: Fact; isKnowledge: boolean }>()
  for (const fact of knowledge?.facts ?? []) {
    if (!forgotten.has(fact.id)) facts.set(fact.id, { fact, isKnowledge: true })
  }
  const episodes = new Map<string, Episode>()
  for (const line of lines) {
    if (line.kind === 'fact') {
      const f = line.fact
      if (forgotten.has(f.id)) continue
      const known = facts.get(f.id)
      if (known?.isKnowledge) {
        if (!known.fact.paths?.length && f.paths?.length) known.fact = { ...known.fact, paths: f.paths }
        continue
      }
      if (consolidated.has(f.id)) continue
      facts.set(f.id, { fact: f, isKnowledge: false })
    } else if (line.kind === 'episode') {
      const e = line.episode
      const prev = episodes.get(e.taskId)
      if (!prev || prev.isRawOutput || !e.isRawOutput) episodes.set(e.taskId, e)
    }
  }

  const docs: Doc[] = []
  for (const { fact, isKnowledge } of facts.values()) {
    if (typeof fact.text === 'string' && fact.text.trim()) docs.push(factDoc(fact, isKnowledge, now))
  }
  for (const e of episodes.values()) docs.push(episodeDoc(e, now))

  const df = new Map<string, number>()
  const total = { fact: 0, episode: 0 }
  const count = { fact: 0, episode: 0 }
  for (const d of docs) {
    for (const t of d.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    total[d.type] += d.length
    count[d.type] += 1
  }
  return {
    size: docs.length,
    docs,
    df,
    avgLength: { fact: count.fact ? total.fact / count.fact : 0, episode: count.episode ? total.episode / count.episode : 0 },
    now,
  }
}

// ---- Search ----------------------------------------------------------------

export const DEFAULT_SEARCH_LIMIT = 10

function bm25(index: SearchIndex, doc: Doc, queryTerms: string[]): number {
  const n = index.docs.length
  const avg = index.avgLength[doc.type] || 1
  let score = 0
  for (const term of queryTerms) {
    const tf = doc.terms.get(term)
    if (!tf) continue
    const df = index.df.get(term) ?? 0
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * doc.length) / avg))
  }
  return score
}

/**
 * Ranked facts and episodes that share at least one term with the query
 * (BM25 times the boosts). Ties go to the newer item, then the smaller id.
 */
export function search(
  index: MemoryIndex,
  query: string,
  opts?: { limit?: number; types?: ('fact' | 'episode')[] },
): SearchHit[] {
  if (!isSearchIndex(index) || index.docs.length === 0) return []
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return []
  const types = opts?.types && opts.types.length ? new Set(opts.types) : undefined
  const limit = Math.max(0, Math.floor(opts?.limit ?? DEFAULT_SEARCH_LIMIT))

  const scored: { doc: Doc; score: number }[] = []
  for (const doc of index.docs) {
    if (types && !types.has(doc.type)) continue
    const base = bm25(index, doc, queryTerms)
    if (base > 0) scored.push({ doc, score: base * doc.boost })
  }
  scored.sort((x, y) => y.score - x.score || y.doc.at - x.doc.at || (x.doc.id < y.doc.id ? -1 : x.doc.id > y.doc.id ? 1 : 0))
  return scored.slice(0, limit).map(({ doc, score }) =>
    doc.type === 'fact' ? { type: 'fact', score, fact: doc.fact } : { type: 'episode', score, episode: doc.episode },
  )
}

export const searchModule: SearchModule = { buildIndex, search }
