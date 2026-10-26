// Shared contract for the memory harness (see MEMORY_HARNESS_PLAN.md).
// Every memory module codes against these types and signatures. Do not edit
// this file inside a work unit: ask for a change in your coordination notes.
//
// Modules take small "ports" instead of the whole engine interface, so tests
// can pass in-memory fakes (tests run with no fs, network or process).

import type { OrchStatus } from '../../types'

// ---- Ports -------------------------------------------------------------

/** The subset of `$.fs` the memory code uses. `write` replaces the whole file. */
export type MemFs = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<{ name: string; kind: string; size: number; mtimeMs: number }[]>
  exists: (path: string) => Promise<boolean>
}

/** The subset of `$.model.complete` the memory code uses. */
export type MemModel = {
  complete: (req: {
    model: string
    prompt: string
    system?: string
    maxTokens?: number
    effort?: 'low' | 'medium' | 'high'
  }) => Promise<{ text?: string; reason?: string }>
}

// ---- Settings ------------------------------------------------------------

export type SummaryDetail = 'off' | 'short' | 'detailed'

/** Fields added to OrchSettings (types/index.d.ts) by the harness. */
export type MemorySettings = {
  isMemoryOn: boolean
  memoryDir: string // '' = default <home>/.claude/orchestrator-memory
  summaryDetail: SummaryDetail
  summaryModel: string // default 'haiku'
  isTranscriptKept: boolean
  recallBudgetChars: number // default 3000
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  isMemoryOn: true,
  memoryDir: '',
  summaryDetail: 'short',
  summaryModel: 'haiku',
  isTranscriptKept: false,
  recallBudgetChars: 3000,
}

// ---- Records (plan §6.3) -----------------------------------------------

export type LedgerGoal = { id: string; text: string; status: 'open' | 'done' | 'dropped'; at: number }
export type LedgerDecision = { id: string; text: string; at: number }

export type LedgerTask = {
  id: string
  project: string
  projectKey: string
  title: string
  why?: string
  status: OrchStatus
  summary?: string
  prompt?: string // clipped to 200 chars, for carry-over
  createdAt: number
  endedAt?: number
}

export type Ledger = {
  version: 1
  sessionId: string
  startedAt: number
  updatedAt: number
  carriedFrom?: string
  goals: LedgerGoal[]
  decisions: LedgerDecision[]
  tasks: LedgerTask[]
}

export type Outcome = 'succeeded' | 'partial' | 'failed' | 'unknown'

export type Episode = {
  taskId: string
  sessionId: string
  title: string
  prompt: string
  backend: 'agent' | 'process'
  status: OrchStatus
  outcome: Outcome
  summary: string
  isRawOutput: boolean
  files: string[]
  followups: string[]
  interruptions: number
  startedAt?: number
  endedAt: number
}

export type FactKind = 'convention' | 'gotcha' | 'command' | 'architecture' | 'preference'
export const FACT_KINDS: readonly FactKind[] = ['convention', 'gotcha', 'command', 'architecture', 'preference']

export type Fact = {
  id: string // 'f_' + 6 chars
  text: string
  kind: FactKind
  origin: 'summary' | 'person' | 'model'
  sourceTaskId?: string
  sessionId: string
  at: number
  paths?: string[]
  isStale?: boolean
}

export type JournalLine =
  | { kind: 'episode'; v: 1; episode: Episode }
  | { kind: 'fact'; v: 1; fact: Fact }
  | { kind: 'forget'; v: 1; factId: string; at: number }

/** knowledge.md, parsed. Sections follow FACT_KINDS order. */
export type KnowledgeDoc = {
  project: string
  consolidatedAt: number
  facts: Fact[]
}

export type ProjectMeta = {
  path: string
  name: string
  createdAt: number
  consolidatedFactIds: string[]
}

// ---- paths.ts (unit A) ---------------------------------------------------

export type MemoryPaths = {
  root: string
  versionFile: string
  ledgersDir: string
  ledgerFile: (sessionId: string) => string
  projectDir: (key: string) => string
  metaFile: (key: string) => string
  knowledgeFile: (key: string) => string
  lockFile: (key: string) => string
  journalDir: (key: string) => string
  journalFile: (key: string, sessionId: string, part?: number) => string
  transcriptFile: (key: string, taskId: string) => string
}

export type PathsModule = {
  /** Forward slashes, no trailing slash, lower-cased when it looks like a Windows path. */
  normalizePath: (path: string) => string
  /** `<slug>-<hash8>`; stable for the same normalized path. Synchronous (no crypto.subtle). */
  projectKey: (path: string) => string
  /** The memory root: the setting if set, else `<homeDir>/.claude/orchestrator-memory`, else undefined. */
  resolveMemoryRoot: (opts: { setting: string; homeDir?: string }) => string | undefined
  memoryPaths: (root: string) => MemoryPaths
}

// ---- files.ts (unit A) ---------------------------------------------------

export const JOURNAL_ROTATE_BYTES = 1024 * 1024

export type FileQueue = {
  /** Serialized per path: writes to one path land in call order. */
  write: (path: string, text: string) => Promise<void>
  /** Resolves when every queued write has landed. */
  flush: () => Promise<void>
}

export type FilesModule = {
  createFileQueue: (fs: MemFs) => FileQueue
  /** Append lines to this session's journal (rotating at JOURNAL_ROTATE_BYTES). */
  appendJournal: (fs: MemFs, q: FileQueue, paths: MemoryPaths, key: string, sessionId: string, lines: JournalLine[]) => Promise<void>
  /** Every line from every session's journal files of a project, skipping bad lines. */
  readJournal: (fs: MemFs, paths: MemoryPaths, key: string) => Promise<JournalLine[]>
  readJson: <T>(fs: MemFs, path: string) => Promise<T | undefined>
  /** Take the lock if free, expired, or ours. Write, read back, compare. */
  acquireLock: (fs: MemFs, path: string, sessionId: string, now: number, ttlMs: number) => Promise<boolean>
  releaseLock: (fs: MemFs, path: string, sessionId: string) => Promise<void>
}

// ---- ledger.ts (unit B) --------------------------------------------------

export type LedgerTaskEvent =
  | { type: 'added'; task: Omit<LedgerTask, 'status'> }
  | { type: 'status'; id: string; status: OrchStatus; at: number }
  | { type: 'summary'; id: string; summary: string }

export type NoteInput = { action: 'goal' | 'done' | 'drop' | 'decision'; text?: string; id?: string }

export const LEDGER_SNAPSHOT_CAP = 6000

export type LedgerModule = {
  emptyLedger: (sessionId: string, now: number) => Ledger
  applyTaskEvent: (ledger: Ledger, ev: LedgerTaskEvent, now: number) => Ledger
  /** Returns the new ledger and the tool's reply text (with the id). Invalid input leaves the ledger as is. */
  applyNote: (ledger: Ledger, input: NoteInput, now: number, newId: () => string) => { ledger: Ledger; reply: string }
  /** Newest other ledger with open goals or unfinished tasks, under 7 days old. */
  pickCarryOver: (ledgers: Ledger[], currentSessionId: string, now: number) => Ledger | undefined
  /** The system-prompt section text (plan §7.2), at most `cap` characters; '' when there is nothing to show. */
  renderSnapshot: (ledger: Ledger, carried: Ledger | undefined, now: number, cap?: number) => string
  /** The instructions added on a main-conversation compaction (plan §7.3). */
  compactionInstructions: (existing: string | undefined) => string
}

// ---- scrub.ts + summarize.ts (unit C) -------------------------------------

export type ScrubModule = {
  scrub: (text: string) => string
}

export type ApiMessageLike = { role: string; content: unknown }

export type SummaryInput = {
  taskId: string
  sessionId: string
  title: string
  prompt: string
  backend: 'agent' | 'process'
  status: OrchStatus
  interruptions: number
  files: string[]
  startedAt?: number
  endedAt: number
  /** From $.session.messages({ agentId, as: 'api' }) when readable. */
  transcript?: ApiMessageLike[]
  /** task.output, the fallback. */
  output: string
}

export type SummaryResult = {
  episode: Episode
  facts: Fact[]
  /** True when the model was called. */
  isModelCalled: boolean
}

export type SummarizeModule = {
  /** Assistant text and tool names only, clipped from the end to 24,000 chars; falls back to output. */
  extractMaterial: (transcript: ApiMessageLike[] | undefined, output: string) => string
  /** False for killed tasks, detail 'off', or material under 1,500 chars. */
  shouldCallModel: (material: string, detail: SummaryDetail, status: OrchStatus) => boolean
  /** Builds the episode and facts; scrubs everything; never throws (falls back to raw). */
  summarizeTask: (deps: { model: MemModel; newId: () => string }, input: SummaryInput, opts: { detail: SummaryDetail; modelName: string }) => Promise<SummaryResult>
}

// ---- search.ts + recall.ts (unit D) ----------------------------------------

export type SearchHit =
  | { type: 'fact'; score: number; fact: Fact }
  | { type: 'episode'; score: number; episode: Episode }

export type MemoryIndex = { readonly size: number }

export type SearchModule = {
  /** Applies `forget` lines; knowledge facts win over inbox facts with the same id. */
  buildIndex: (lines: JournalLine[], knowledge: KnowledgeDoc | undefined, now: number) => MemoryIndex
  search: (index: MemoryIndex, query: string, opts?: { limit?: number; types?: ('fact' | 'episode')[] }) => SearchHit[]
}

export type RecallModule = {
  /** The brief (plan §8.2), within budget; '' when there is nothing to recall. */
  buildBrief: (index: MemoryIndex, task: { title: string; prompt: string }, budgetChars: number) => string
  /** Prepends the brief (if any) to the prompt. */
  withBrief: (prompt: string, brief: string) => string
}

// ---- consolidate.ts (unit E) ---------------------------------------------

export type ConsolidateResult =
  | { status: 'done'; kept: number; dropped: number; stale: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

export type KnowledgeModule = {
  parseKnowledge: (markdown: string) => KnowledgeDoc
  renderKnowledge: (doc: KnowledgeDoc) => string
  /** Inbox = facts in the journal not in knowledge and not forgotten. */
  inboxFacts: (lines: JournalLine[], knowledge: KnowledgeDoc | undefined) => Fact[]
  consolidate: (
    deps: { fs: MemFs; model: MemModel; files: FilesModule; paths: MemoryPaths },
    opts: { key: string; projectPath: string; sessionId: string; now: number; modelName: string },
  ) => Promise<ConsolidateResult>
}

// ---- pane.tsx (unit F) -----------------------------------------------------

export type MemoryPart = 'knowledge' | 'inbox' | 'episodes' | 'ledger'

export type MemoryView = { projectKey: string; part: MemoryPart; selected: string }

export type MemoryTabData = {
  projects: { key: string; name: string; path: string }[]
  view: MemoryView
  knowledge: Fact[]
  inbox: Fact[]
  episodes: Episode[]
  ledger: Ledger | undefined
  memoryRoot: string | undefined
}

export type MemoryTabActions = {
  setView: (patch: Partial<MemoryView>) => void
  deleteFact: (key: string, factId: string) => void
  keepFact: (key: string, factId: string) => void
  consolidate: (key: string) => void
  clearProject: (key: string) => void
}
