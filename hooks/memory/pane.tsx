// The Memory tab of the orchestrator pane, and the memory rows of its
// Settings tab (MEMORY_HARNESS_PLAN.md §9.5). Drawing only: register.tsx
// reads the data, passes the element table from `$.ui.resolve(e)`, and does
// the work behind each action.

import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  InputProps,
  SelectProps,
  TextProps,
} from 'claude-code'

import { FACT_KINDS } from './contract'
import type {
  Episode,
  Fact,
  FactKind,
  Ledger,
  LedgerTask,
  MemoryPart,
  MemorySettings,
  MemoryTabActions,
  MemoryTabData,
  MemoryView,
  Outcome,
  SummaryDetail,
} from './contract'

/** The elements the tab draws with: any surface's table from `$.ui.resolve(e)`. */
export type MemoryElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  // Mobile has neither: `$.ui.resolve` fills them in with elements that draw
  // nothing, so pass `hasForms: false` there (MemoryTabOptions).
  Select?: ElementConstructor<SelectProps>
  Input?: ElementConstructor<InputProps>
}

/** Extras the contract's data does not carry. */
export type MemoryTabOptions = {
  /** Settings: memory on or off. Off shows a notice; what is stored stays visible. */
  isMemoryOn?: boolean
  /** False on a surface with no Select (mobile): the project picker draws buttons. */
  hasForms?: boolean
  /** Rows the pane has for a list; longer lists are cut with a count. */
  rows?: number
}

export const PARTS: readonly { id: MemoryPart; label: string }[] = [
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'episodes', label: 'Episodes' },
  { id: 'ledger', label: 'Ledger' },
]

export const KIND_TITLE: Record<FactKind, string> = {
  convention: 'Conventions',
  gotcha: 'Gotchas',
  command: 'Commands',
  architecture: 'Architecture',
  preference: 'Preferences',
}

const OUTCOME_COLOR: Record<Outcome, string> = {
  succeeded: 'green',
  partial: 'yellow',
  failed: 'red',
  unknown: 'gray',
}

// The same glyphs and colors the Sessions tab uses.
const GLYPH: Record<string, string> = { queued: '.', running: '>', done: '+', failed: 'x', killed: '-' }
const COLOR: Record<string, string> = { queued: 'gray', running: 'yellow', done: 'green', failed: 'red', killed: 'gray' }
const GOAL_GLYPH: Record<string, string> = { open: 'o', done: '+', dropped: '-' }

const CLEAR_ARM = 'clear:'

// ---- Pure helpers (exported for tests and for register.tsx) ---------------

/** A day as YYYY-MM-DD (UTC), or '-' when unknown. */
export function fmtDate(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '-'
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '-' : d.toISOString().slice(0, 10)
}

/** Shortens text to `cap` characters, from the start, with an ellipsis. */
export function clipText(text: string, cap: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > cap ? `${one.slice(0, Math.max(0, cap - 1))}…` : one
}

/**
 * Where a fact came from, as knowledge.md writes it: `task k3x9p1` (a task's
 * summary), `person`, `model`, or `person, task k3x9p1` when it names a task.
 */
export function factSource(f: Fact): string {
  if (f.origin === 'summary') return f.sourceTaskId ? `task ${f.sourceTaskId}` : 'summary'
  const origin = f.origin === 'person' ? 'person' : 'model'
  return f.sourceTaskId ? `${origin}, task ${f.sourceTaskId}` : origin
}

/**
 * Facts grouped by kind in knowledge.md's section order, newest first in each,
 * empty groups left out. A fact of an unknown kind goes in an 'other' group.
 */
export function groupFacts(facts: readonly Fact[]): { kind: FactKind | 'other'; title: string; facts: Fact[] }[] {
  const seen = new Set<string>()
  const unique = facts.filter(f => (seen.has(f.id) ? false : (seen.add(f.id), true)))
  const byNewest = (a: Fact, b: Fact) => (b.at || 0) - (a.at || 0)
  const known = new Set<string>(FACT_KINDS)
  const groups: { kind: FactKind | 'other'; title: string; facts: Fact[] }[] = FACT_KINDS.map(kind => ({
    kind,
    title: KIND_TITLE[kind],
    facts: unique.filter(f => f.kind === kind).sort(byNewest),
  }))
  groups.push({ kind: 'other', title: 'Other', facts: unique.filter(f => !known.has(f.kind)).sort(byNewest) })
  return groups.filter(g => g.facts.length > 0)
}

/** The project the tab shows: the view's when it is still listed, else the first. */
export function pickProjectKey(view: Pick<MemoryView, 'projectKey'>, projects: readonly { key: string }[]): string {
  if (projects.some(p => p.key === view.projectKey)) return view.projectKey
  return projects[0]?.key ?? ''
}

/** A project's memory folder under the root (plan §6.2), for display. */
export function projectFolder(root: string, key: string): string {
  return `${root.replace(/[\\/]+$/, '')}/projects/${key}`
}

/** True once Clear project memory was pressed once for this project. */
export function isClearArmed(view: Pick<MemoryView, 'selected'>, key: string): boolean {
  return !!key && view.selected === CLEAR_ARM + key
}

/** Episodes newest first, one per task id. */
export function sortEpisodes(episodes: readonly Episode[]): Episode[] {
  const seen = new Set<string>()
  return [...episodes]
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    .filter(e => (seen.has(e.taskId) ? false : (seen.add(e.taskId), true)))
}

/** Goals open first, then the rest; newest first within each. */
export function sortGoals(goals: Ledger['goals']): Ledger['goals'] {
  const rank = (s: string) => (s === 'open' ? 0 : 1)
  return [...goals].sort((a, b) => rank(a.status) - rank(b.status) || b.at - a.at)
}

/** Ledger tasks: running and queued first, then the rest newest first. */
export function sortLedgerTasks(list: readonly LedgerTask[]): LedgerTask[] {
  const rank = (s: string) => (s === 'running' ? 0 : s === 'queued' ? 1 : 2)
  return [...list].sort((a, b) => rank(a.status) - rank(b.status) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
}

// ---- The Memory tab --------------------------------------------------------

/**
 * The Memory tab's tree: project picker, the four parts (Knowledge, Inbox,
 * Episodes, Ledger), Consolidate, Clear project memory (a second press
 * confirms), and the memory folder.
 *
 * `data.view.projectKey` is honored when the project is listed, else the
 * first project shows (see `pickProjectKey`); register.tsx should load the
 * data for that same key.
 */
export function memoryTab(els: MemoryElements, data: MemoryTabData, actions: MemoryTabActions, opts: MemoryTabOptions = {}) {
  const { Box, Text, Button, Select } = els
  const view = data.view
  const key = pickProjectKey(view, data.projects)
  const project = data.projects.find(p => p.key === key)
  const room = Math.max(4, opts.rows ?? 20)
  const root = data.memoryRoot

  const select = (id: string) => actions.setView({ selected: view.selected === id ? '' : id })

  // ---- header ----
  const notices = [
    opts.isMemoryOn === false && (
      <Text color="yellow">
        Memory is off (Settings: Memory). Nothing new is stored or recalled; what is stored stays until cleared.
      </Text>
    ),
    !root && (
      <Text color="yellow">
        No memory folder yet. Set Memory folder in Settings (the default needs your home folder to be found).
      </Text>
    ),
  ].filter(Boolean)

  const picker = () => {
    if (data.projects.length === 0) {
      return <Text dimColor>No projects yet. Add one in Projects; its memory starts when a task in it finishes.</Text>
    }
    if (Select && opts.hasForms !== false) {
      return (
        <Select
          key="mem-project"
          label="Project"
          value={key}
          options={data.projects.map(p => ({ value: p.key, label: `${p.name}  ${p.path}` }))}
          onSelect={(value: string) => actions.setView({ projectKey: value, selected: '' })}
        />
      )
    }
    return (
      <Box>
        <Text dimColor>Project: </Text>
        {data.projects.map(p => (
          <Button key={`mem-proj-${p.key}`} plain onPress={() => actions.setView({ projectKey: p.key, selected: '' })}>
            {p.key === key ? `[${p.name}]` : p.name}{' '}
          </Button>
        ))}
      </Box>
    )
  }

  const counts: Record<MemoryPart, number | undefined> = {
    knowledge: data.knowledge.length,
    inbox: data.inbox.length,
    episodes: data.episodes.length,
    ledger: data.ledger?.tasks.length,
  }
  const partRow = (
    <Box>
      {PARTS.map(({ id, label }) => {
        const text = counts[id] === undefined ? label : `${label} ${counts[id]}`
        return (
          <Button key={`mem-part-${id}`} plain onPress={() => actions.setView({ part: id, selected: '' })}>
            {view.part === id ? `[${text}]` : text}{' '}
          </Button>
        )
      })}
    </Box>
  )

  // ---- facts ----
  const factRow = (f: Fact, withKeep: boolean) => (
    <Box key={`mem-row-${f.id}`}>
      <Button key={`mem-fact-${f.id}`} plain onPress={() => select(f.id)}>
        {view.selected === f.id ? '> ' : '  '}
        {f.isStale ? <Text color="yellow">(possibly stale) </Text> : ''}
        {f.origin === 'person' ? <Text color="cyan">* </Text> : ''}
        {clipText(f.text, 140)}{' '}
        <Text dimColor>
          ({factSource(f)}, {fmtDate(f.at)})
        </Text>
      </Button>
      {withKeep && (
        <Button key={`mem-keep-${f.id}`} plain onPress={() => actions.keepFact(key, f.id)}>
          {' '}keep
        </Button>
      )}
      <Button key={`mem-del-${f.id}`} plain dimColor onPress={() => actions.deleteFact(key, f.id)}>
        {' '}delete
      </Button>
    </Box>
  )

  const factDetail = (facts: readonly Fact[]) => {
    const f = facts.find(x => x.id === view.selected)
    if (!f) return null
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>
          {f.id} <Text dimColor>{f.kind}</Text>
        </Text>
        <Text>{f.text}</Text>
        <Text dimColor>
          Source: {factSource(f)} · origin {f.origin} · session {f.sessionId || '-'} · {fmtDate(f.at)}
        </Text>
        {f.paths && f.paths.length > 0 && <Text dimColor>Files: {f.paths.join(', ')}</Text>}
        {f.isStale && <Text color="yellow">The files it names are gone from the project folder.</Text>}
      </Box>
    )
  }

  const noProject = () => <Text dimColor>Pick a project to see its memory.</Text>

  const knowledgePart = () => {
    if (!project) return noProject()
    if (data.knowledge.length === 0) {
      return (
        <Text dimColor>
          {data.inbox.length > 0
            ? `No curated knowledge yet. ${data.inbox.length} fact${data.inbox.length === 1 ? '' : 's'} wait in the Inbox: Consolidate merges them into knowledge.md.`
            : 'No memory for this project yet. Each finished task adds a summary and the facts it learned.'}
        </Text>
      )
    }
    let left = room
    const groups = groupFacts(data.knowledge)
    const shown = groups.map(g => {
      const rows = g.facts.slice(0, Math.max(1, left))
      left -= rows.length
      return (
        <Box key={`mem-kind-${g.kind}`} flexDirection="column">
          <Text bold>
            {g.title} <Text dimColor>{g.facts.length}</Text>
          </Text>
          {rows.map(f => factRow(f, false))}
          {rows.length < g.facts.length && <Text dimColor>  and {g.facts.length - rows.length} more</Text>}
        </Box>
      )
    })
    return (
      <Box flexDirection="column">
        <Text dimColor>Curated facts (knowledge.md). * = said by you, kept word for word.</Text>
        {shown}
        {factDetail(data.knowledge)}
      </Box>
    )
  }

  const inboxPart = () => {
    if (!project) return noProject()
    if (data.inbox.length === 0) {
      return <Text dimColor>The inbox is empty: every fact is in Knowledge, or no task has finished here yet.</Text>
    }
    const facts = [...data.inbox].sort((a, b) => (b.at || 0) - (a.at || 0))
    const seen = new Set<string>()
    const unique = facts.filter(f => (seen.has(f.id) ? false : (seen.add(f.id), true)))
    const rows = unique.slice(0, room)
    return (
      <Box flexDirection="column">
        <Text dimColor>Facts from finished tasks, not yet in knowledge.md. Keep writes one there now; Consolidate merges them all.</Text>
        {rows.map(f => factRow(f, true))}
        {rows.length < unique.length && <Text dimColor>  and {unique.length - rows.length} more</Text>}
        {factDetail(unique)}
      </Box>
    )
  }

  const episodesPart = () => {
    if (!project) return noProject()
    const list = sortEpisodes(data.episodes)
    if (list.length === 0) {
      return <Text dimColor>No finished tasks recorded for this project yet.</Text>
    }
    const rows = list.slice(0, Math.max(2, Math.floor(room / 2)))
    const selected = list.find(e => e.taskId === view.selected)
    return (
      <Box flexDirection="column">
        {rows.map(ep => (
          <Box key={`mem-eprow-${ep.taskId}`} flexDirection="column">
            <Button key={`mem-ep-${ep.taskId}`} plain onPress={() => select(ep.taskId)}>
              {view.selected === ep.taskId ? '> ' : '  '}
              <Text color={OUTCOME_COLOR[ep.outcome] ?? 'gray'}>{ep.outcome}</Text> {ep.title}{' '}
              <Text dimColor>
                {ep.taskId} {fmtDate(ep.endedAt)}
              </Text>
            </Button>
            <Text dimColor>    {clipText(ep.summary, 160) || '(no summary)'}</Text>
          </Box>
        ))}
        {rows.length < list.length && <Text dimColor>  and {list.length - rows.length} earlier</Text>}
        {selected && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              {selected.title}{' '}
              <Text dimColor>
                [{selected.status}, {selected.outcome}] {selected.taskId} · {selected.backend} · {fmtDate(selected.endedAt)}
              </Text>
            </Text>
            <Text>{selected.summary || '(no summary)'}</Text>
            {selected.isRawOutput && <Text dimColor>Stored as the task's raw output (no summary call).</Text>}
            {selected.files.length > 0 && <Text dimColor>Files: {selected.files.join(', ')}</Text>}
            {selected.followups.length > 0 && <Text dimColor>Follow-ups: {selected.followups.join('; ')}</Text>}
            {selected.interruptions > 0 && <Text dimColor>Cut off by a usage limit {selected.interruptions} time(s).</Text>}
            <Text dimColor>Prompt: {clipText(selected.prompt, 300)}</Text>
          </Box>
        )}
      </Box>
    )
  }

  const ledgerPart = () => {
    const l = data.ledger
    if (!l) return <Text dimColor>No ledger for this session yet. It starts with the first task or note.</Text>
    const goals = sortGoals(l.goals)
    const decisions = [...l.decisions].sort((a, b) => b.at - a.at).slice(0, 10)
    const list = sortLedgerTasks(l.tasks)
    const taskRows = list.slice(0, room)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          This session's record (shown to the main session after a compaction or /clear). Session {l.sessionId}, since {fmtDate(l.startedAt)}.
        </Text>
        {l.carriedFrom && <Text dimColor>Carries unfinished work from session {l.carriedFrom}.</Text>}
        <Text bold>Goals</Text>
        {goals.length === 0 && <Text dimColor>  none</Text>}
        {goals.map(g => (
          <Text>
            {'  '}
            <Text color={g.status === 'open' ? 'yellow' : 'gray'}>{GOAL_GLYPH[g.status] ?? '?'}</Text> {g.text}{' '}
            <Text dimColor>
              {g.id} {g.status}
              {l.carriedFrom && g.at < l.startedAt ? ' (from the last session)' : ''}
            </Text>
          </Text>
        ))}
        <Text bold>Decisions</Text>
        {decisions.length === 0 && <Text dimColor>  none</Text>}
        {decisions.map(d => (
          <Text>
            {'  '}- {d.text} <Text dimColor>{fmtDate(d.at)}</Text>
          </Text>
        ))}
        <Text bold>Tasks</Text>
        {list.length === 0 && <Text dimColor>  none</Text>}
        {taskRows.map(t => (
          <Box key={`mem-lt-${t.id}`} flexDirection="column">
            <Text>
              {'  '}
              <Text color={COLOR[t.status] ?? 'gray'}>{GLYPH[t.status] ?? '?'}</Text> {t.title}{' '}
              <Text dimColor>
                {t.id} {t.project}
              </Text>
            </Text>
            {t.why && <Text dimColor>    why: {clipText(t.why, 160)}</Text>}
            {t.summary && <Text dimColor>    {clipText(t.summary, 160)}</Text>}
          </Box>
        ))}
        {taskRows.length < list.length && <Text dimColor>  and {list.length - taskRows.length} more</Text>}
      </Box>
    )
  }

  const part = () => {
    if (view.part === 'ledger') return ledgerPart()
    if (!root) return <Text dimColor>Project memory needs a memory folder.</Text>
    if (view.part === 'inbox') return inboxPart()
    if (view.part === 'episodes') return episodesPart()
    return knowledgePart()
  }

  // ---- footer: actions and folder ----
  const isArmed = isClearArmed(view, key)
  const footer = () => {
    if (!root) return null
    if (!project) return <Text dimColor>Memory folder: {root}</Text>
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Button key="mem-consolidate" onPress={() => actions.consolidate(key)}>
            Consolidate
          </Button>
          {isArmed ? (
            <Box>
              <Button
                key="mem-clear"
                onPress={() => {
                  actions.setView({ selected: '' })
                  actions.clearProject(key)
                }}
              >
                <Text color="red">Press again to clear {project.name}'s memory</Text>
              </Button>
              <Button key="mem-clear-cancel" plain onPress={() => actions.setView({ selected: '' })}>
                {' '}cancel
              </Button>
            </Box>
          ) : (
            <Button key="mem-clear" onPress={() => actions.setView({ selected: CLEAR_ARM + key })}>
              Clear project memory
            </Button>
          )}
        </Box>
        {isArmed && (
          <Text color="red">
            This deletes {project.name}'s knowledge, inbox, episodes and transcripts from disk. The ledger is kept.
          </Text>
        )}
        <Text dimColor>Memory folder: {projectFolder(root, key)}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {notices}
      {view.part !== 'ledger' && picker()}
      {partRow}
      {part()}
      {view.part !== 'ledger' && footer()}
    </Box>
  )
}

// ---- Settings rows ---------------------------------------------------------

const RECALL_BUDGETS = [1000, 2000, 3000, 4000, 6000, 8000]

/**
 * The memory rows for the Settings tab (plan §7.6, §8.4), in order: Memory,
 * Memory folder, Task summaries, Summary model, Transcripts, Recall budget.
 * Draw them only where the surface has forms (not mobile), as the rest of
 * the Settings tab does.
 */
export function memorySettingsRows(els: MemoryElements, settings: MemorySettings, onChange: (patch: Partial<MemorySettings>) => void) {
  const { Select, Input } = els
  if (!Select || !Input) return []
  const budgets = RECALL_BUDGETS.includes(settings.recallBudgetChars)
    ? RECALL_BUDGETS
    : [...RECALL_BUDGETS, settings.recallBudgetChars].filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  const detail: SummaryDetail = settings.summaryDetail === 'off' || settings.summaryDetail === 'detailed' ? settings.summaryDetail : 'short'
  return [
    <Select
      key="mem-on"
      label="Memory"
      value={settings.isMemoryOn === false ? 'off' : 'on'}
      options={[
        { value: 'on', label: 'on: keep a ledger, summarize tasks, brief new ones' },
        { value: 'off', label: 'off: store and recall nothing' },
      ]}
      onSelect={(value: string) => onChange({ isMemoryOn: value !== 'off' })}
    />,
    <Input
      key="mem-dir"
      label="Memory folder (empty = ~/.claude/orchestrator-memory)"
      value={settings.memoryDir}
      onInput={(value: string) => onChange({ memoryDir: value })}
      onSubmit={(value: string) => onChange({ memoryDir: value.trim() })}
    />,
    <Select
      key="mem-summary-detail"
      label="Task summaries"
      value={detail}
      options={[
        { value: 'short', label: 'short: one paragraph, up to 3 facts' },
        { value: 'detailed', label: 'detailed: up to 6 paragraphs, up to 8 facts' },
        { value: 'off', label: 'off: keep the raw output tail, no model call' },
      ]}
      onSelect={(value: string) =>
        onChange({ summaryDetail: value === 'off' || value === 'detailed' ? value : 'short' })
      }
    />,
    <Input
      key="mem-summary-model"
      label="Summary model (e.g. haiku)"
      value={settings.summaryModel}
      onInput={(value: string) => onChange({ summaryModel: value })}
      onSubmit={(value: string) => onChange({ summaryModel: value.trim() || 'haiku' })}
    />,
    <Select
      key="mem-transcripts"
      label="Task transcripts"
      value={settings.isTranscriptKept ? 'on' : 'off'}
      options={[
        { value: 'off', label: 'not kept (summaries only)' },
        { value: 'on', label: 'kept in the memory folder (30 days)' },
      ]}
      onSelect={(value: string) => onChange({ isTranscriptKept: value === 'on' })}
    />,
    <Select
      key="mem-recall-budget"
      label="Brief for new tasks"
      value={String(settings.recallBudgetChars)}
      options={budgets.map(n => ({ value: String(n), label: `up to ${n} characters (~${Math.round(n / 4)} tokens)` }))}
      onSelect={(value: string) => onChange({ recallBudgetChars: Number(value) })}
    />,
  ]
}
