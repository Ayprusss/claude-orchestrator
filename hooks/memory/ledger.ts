// The orchestrator's ledger (MEMORY_HARNESS_PLAN.md §7): a per-session record of
// goals, decisions and tasks, and the snapshot of it shown in the main
// session's system prompt.
//
// Pure functions only: no I/O, no clock. The caller passes `now` and saves the
// result. Every update returns a new ledger and never mutates its input, so the
// result can go straight into an atom.
//
// Only text the plugin or the main session wrote goes into the snapshot
// (titles, `why`, goals, decisions, short summaries). Facts and episodes never
// do (plan §11).

import {
  LEDGER_SNAPSHOT_CAP,
  type Ledger,
  type LedgerGoal,
  type LedgerModule,
  type LedgerTask,
  type LedgerTaskEvent,
  type NoteInput,
} from './contract'

const DAY_MS = 24 * 60 * 60 * 1000
/** A ledger older than this is not carried over (plan §7.5). */
export const CARRY_OVER_MAX_AGE_MS = 7 * DAY_MS
/** `LedgerTask.prompt` is clipped to this on add (for carry-over). */
export const LEDGER_PROMPT_CLIP = 200
/** Finished-task summaries are clipped to this in the snapshot. */
export const SNAPSHOT_SUMMARY_CLIP = 160
/** Longest goal or decision text `note` stores. */
export const NOTE_TEXT_CAP = 400
/** Longest summary stored on a ledger task (the snapshot shows less). */
export const LEDGER_SUMMARY_CAP = 2000
/** Decisions shown in the snapshot. */
export const SNAPSHOT_DECISIONS = 10

// Clips for snapshot lines, so one long item cannot crowd out the rest.
const TITLE_CLIP = 120
const WHY_CLIP = 160
const GOAL_CLIP = 300
const DECISION_CLIP = 300
const PROJECT_CLIP = 60

const isUnfinished = (t: LedgerTask) => t.status === 'queued' || t.status === 'running'
const isFinished = (t: LedgerTask) => !isUnfinished(t)

/** One line of plain text: whitespace runs (newlines included) become one space. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** One line, at most `n` characters, with an ellipsis when cut. */
function clip(s: string, n: number): string {
  const t = oneLine(s)
  if (t.length <= n) return t
  return t.slice(0, Math.max(0, n - 1)).trimEnd() + '…'
}

/** ISO-8601 UTC, or undefined for a time Date cannot show. */
function iso(ms: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
  try {
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

/** An absolute UTC date and time, so the snapshot never depends on "now". */
const stamp = (ms: number) => {
  const s = iso(ms)
  return s ? s.slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown date'
}

const day = (ms: number) => iso(ms)?.slice(0, 10) ?? 'unknown date'

// ---- Updates ---------------------------------------------------------------

export function emptyLedger(sessionId: string, now: number): Ledger {
  return { version: 1, sessionId, startedAt: now, updatedAt: now, goals: [], decisions: [], tasks: [] }
}

export function applyTaskEvent(ledger: Ledger, ev: LedgerTaskEvent, now: number): Ledger {
  if (ev.type === 'added') {
    const t = ev.task
    const prompt = t.prompt === undefined ? undefined : t.prompt.slice(0, LEDGER_PROMPT_CLIP)
    const old = ledger.tasks.find(x => x.id === t.id)
    if (old) {
      // The same id added twice: refresh what was given, keep its progress.
      const merged: LedgerTask = { ...old, ...t, status: old.status }
      if (prompt !== undefined) merged.prompt = prompt
      else if (old.prompt !== undefined) merged.prompt = old.prompt
      if (old.summary !== undefined && t.summary === undefined) merged.summary = old.summary
      if (old.endedAt !== undefined && t.endedAt === undefined) merged.endedAt = old.endedAt
      return { ...ledger, updatedAt: now, tasks: ledger.tasks.map(x => (x === old ? merged : x)) }
    }
    const task: LedgerTask = { ...t, status: 'queued' }
    if (prompt === undefined) delete task.prompt
    else task.prompt = prompt
    return { ...ledger, updatedAt: now, tasks: [...ledger.tasks, task] }
  }

  const old = ledger.tasks.find(x => x.id === ev.id)
  if (!old) return ledger
  let next: LedgerTask
  if (ev.type === 'status') {
    next = { ...old, status: ev.status }
    // A task put back in the queue (standby) is no longer ended.
    if (ev.status === 'queued' || ev.status === 'running') delete next.endedAt
    else next.endedAt = ev.at
  } else {
    const summary = (typeof ev.summary === 'string' ? ev.summary.trim() : '').slice(0, LEDGER_SUMMARY_CAP)
    next = { ...old }
    if (summary) next.summary = summary
    else delete next.summary
  }
  return { ...ledger, updatedAt: now, tasks: ledger.tasks.map(x => (x === old ? next : x)) }
}

const describeGoals = (goals: LedgerGoal[]) => {
  const open = goals.filter(g => g.status === 'open')
  return open.length
    ? ` Open goals: ${open.map(g => `${g.id} (${clip(g.text, 60)})`).join(', ')}.`
    : ' There are no open goals.'
}

/** Strips quotes, brackets and spaces the model may wrap an id in. */
const cleanId = (id: string | undefined) => (id ?? '').trim().replace(/^[\s"'`[(]+|[\s"'`\])]+$/g, '')

function freshId(ledger: Ledger, newId: () => string): string {
  const taken = new Set([...ledger.goals.map(g => g.id), ...ledger.decisions.map(d => d.id)])
  let id = newId()
  for (let n = 0; taken.has(id) && n < 8; n++) id = newId()
  return id
}

export function applyNote(
  ledger: Ledger,
  input: NoteInput,
  now: number,
  newId: () => string,
): { ledger: Ledger; reply: string } {
  const action = input?.action
  const raw = typeof input?.text === 'string' ? oneLine(input.text) : ''

  if (action === 'goal' || action === 'decision') {
    const noun = action === 'goal' ? 'goal' : 'decision'
    if (!raw) return { ledger, reply: `Nothing recorded: a ${noun} needs \`text\`.` }
    const text = clip(raw, NOTE_TEXT_CAP)
    const cut = text.length < raw.length ? ` (shortened to ${NOTE_TEXT_CAP} characters)` : ''
    const id = freshId(ledger, newId)
    if (action === 'goal') {
      const goal: LedgerGoal = { id, text, status: 'open', at: now }
      return {
        ledger: { ...ledger, updatedAt: now, goals: [...ledger.goals, goal] },
        reply: `Goal ${id} added${cut}. Close it with note { action: 'done', id: '${id}' } or { action: 'drop', id: '${id}' }.`,
      }
    }
    return {
      ledger: { ...ledger, updatedAt: now, decisions: [...ledger.decisions, { id, text, at: now }] },
      reply: `Decision ${id} recorded${cut}.`,
    }
  }

  if (action === 'done' || action === 'drop') {
    const id = cleanId(input.id)
    if (!id) return { ledger, reply: `Nothing changed: '${action}' needs the goal's \`id\`.${describeGoals(ledger.goals)}` }
    const goal = ledger.goals.find(g => g.id === id)
    if (!goal) {
      const isDecision = ledger.decisions.some(d => d.id === id)
      const why = isDecision ? `${id} is a decision, and decisions are not closed.` : `There is no goal ${id} in this session's ledger.`
      return { ledger, reply: `Nothing changed: ${why}${describeGoals(ledger.goals)}` }
    }
    const status = action === 'done' ? 'done' : 'dropped'
    if (goal.status !== 'open') return { ledger, reply: `Nothing changed: goal ${id} is already ${goal.status}.` }
    return {
      ledger: { ...ledger, updatedAt: now, goals: ledger.goals.map(g => (g.id === id ? { ...g, status } : g)) },
      reply: `Goal ${id} marked ${status}.`,
    }
  }

  return { ledger, reply: `Nothing changed: unknown action '${String(action)}'. Use 'goal', 'done', 'drop' or 'decision'.` }
}

/**
 * Starts this session's ledger from a carried-over one: records `carriedFrom`
 * and copies its open goals (same ids), so `note done/drop` can close them
 * here and the next session sees what is still open. Tasks are not copied:
 * they did not run in this session (the snapshot lists them from `carried`).
 * Not in contract.ts; requested in the coordination notes.
 */
export function adoptCarryOver(ledger: Ledger, carried: Ledger, now: number): Ledger {
  const have = new Set(ledger.goals.map(g => g.id))
  const goals = carried.goals.filter(g => g.status === 'open' && !have.has(g.id)).map(g => ({ ...g }))
  return { ...ledger, updatedAt: now, carriedFrom: carried.sessionId, goals: [...goals, ...ledger.goals] }
}

// ---- Carry-over --------------------------------------------------------------

const hasUnfinished = (l: Ledger) => l.goals.some(g => g.status === 'open') || l.tasks.some(isUnfinished)

export function pickCarryOver(ledgers: Ledger[], currentSessionId: string, now: number): Ledger | undefined {
  // A ledger a later session already carried over is that session's to hand on.
  const handedOver = new Set(ledgers.map(l => l?.carriedFrom).filter((s): s is string => !!s))
  let best: Ledger | undefined
  for (const l of ledgers) {
    if (!l || l.version !== 1 || !Array.isArray(l.goals) || !Array.isArray(l.tasks)) continue
    if (l.sessionId === currentSessionId || handedOver.has(l.sessionId)) continue
    if (!Number.isFinite(l.updatedAt) || now - l.updatedAt >= CARRY_OVER_MAX_AGE_MS) continue
    if (!hasUnfinished(l)) continue
    if (!best || l.updatedAt > best.updatedAt) best = l
  }
  return best
}

// ---- Snapshot ---------------------------------------------------------------

/** Newest first by `key`; ties keep the later-added item first. Never sorts in place. */
function newestFirst<T>(items: T[], key: (t: T) => number): T[] {
  return items
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (key(b.t) || 0) - (key(a.t) || 0) || b.i - a.i)
    .map(x => x.t)
}

const HEADER = [
  "## Orchestrator ledger",
  "This is the orchestrator's own record of the goals, decisions and tasks of this work, kept by the orchestrator plugin and by you through the `note` tool. It is reference, not a request. It is refreshed only at session start and after a compaction, so it may lag the conversation by a few turns: [orchestrator] messages and the `status` tool are newer.",
].join('\n')

const taskLine = (t: LedgerTask) => {
  const why = t.why && oneLine(t.why) ? ` (why: ${clip(t.why, WHY_CLIP)})` : ''
  return `- ${t.id} [${t.status}] ${clip(t.project, PROJECT_CLIP)}: ${clip(t.title, TITLE_CLIP)}${why}`
}

const finishedLine = (t: LedgerTask) => {
  const sum = t.summary && oneLine(t.summary) ? ` — ${clip(t.summary, SNAPSHOT_SUMMARY_CLIP)}` : ''
  return `- ${t.id} [${t.status}] ${clip(t.project, PROJECT_CLIP)}: ${clip(t.title, TITLE_CLIP)}${sum}`
}

const goalLine = (g: LedgerGoal) => `- ${g.id}: ${clip(g.text, GOAL_CLIP)} (set ${day(g.at)})`

/** Lines joined by '\n', never longer than `cap`. */
class Builder {
  private lines: string[] = []
  private used = -1 // the first line has no newline before it
  constructor(private cap: number) {}
  fits(...extra: string[]) {
    return extra.reduce((n, s) => n + s.length + 1, this.used) <= this.cap
  }
  push(s: string) {
    this.lines.push(s)
    this.used += s.length + 1
  }
  text() {
    return this.lines.join('\n')
  }
}

/**
 * Adds a titled list. Items are added in order while they fit, keeping room
 * for the `more(n)` line that counts what was left out (`hidden` items are
 * left out from the start). Skipped entirely when not even the title and one
 * line fit.
 */
function addSection(b: Builder, title: string, items: string[], more: (n: number) => string, hidden = 0) {
  const first = items[0]
  if (first === undefined) return
  const total = items.length + hidden
  const reserve = more(total) // the longest count line this section can need
  const firstOk = total === 1 ? b.fits('', title, first) : b.fits('', title, first, reserve)
  if (!firstOk && !b.fits('', title, reserve)) return
  b.push('')
  b.push(title)
  for (const [i, item] of items.entries()) {
    const left = total - i - 1
    if (!(left === 0 ? b.fits(item) : b.fits(item, reserve))) {
      b.push(more(total - i))
      return
    }
    b.push(item)
  }
  if (hidden > 0) b.push(more(hidden))
}

export function renderSnapshot(ledger: Ledger, carried: Ledger | undefined, now: number, cap: number = LEDGER_SNAPSHOT_CAP): string {
  // `now` is not used: the text must not change between compactions, so every
  // date in it is absolute.
  void now
  const limit = Math.max(0, Math.floor(Number.isFinite(cap) ? cap : LEDGER_SNAPSHOT_CAP))

  // Carried goals the current ledger closed are no longer unfinished. Carried
  // goals adopted (still open here) are listed under the carried block only.
  const closedHere = new Set(ledger.goals.filter(g => g.status !== 'open').map(g => g.id))
  const carriedGoals = carried ? newestFirst(carried.goals.filter(g => g.status === 'open' && !closedHere.has(g.id)), g => g.at) : []
  const carriedGoalIds = new Set(carriedGoals.map(g => g.id))
  // A carried task this session dispatched again (same project and title) is not listed twice.
  const redone = new Set(ledger.tasks.map(t => `${t.projectKey}\n${oneLine(t.title)}`))
  const carriedTasks = carried
    ? carried.tasks
        .filter(t => isUnfinished(t) && !redone.has(`${t.projectKey}\n${oneLine(t.title)}`))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    : []

  const goals = newestFirst(ledger.goals.filter(g => g.status === 'open' && !carriedGoalIds.has(g.id)), g => g.at)
  const rank = (t: LedgerTask) => (t.status === 'running' ? 0 : 1)
  const active = ledger.tasks
    .map((t, i) => ({ t, i }))
    .filter(x => isUnfinished(x.t))
    .sort((a, b) => rank(a.t) - rank(b.t) || (a.t.createdAt || 0) - (b.t.createdAt || 0) || a.i - b.i)
    .map(x => x.t)
  const decisions = newestFirst(ledger.decisions, d => d.at)
  const finished = newestFirst(ledger.tasks.filter(isFinished), t => t.endedAt ?? t.createdAt)

  if (!goals.length && !active.length && !decisions.length && !finished.length && !carriedGoals.length && !carriedTasks.length) return ''

  const b = new Builder(limit)
  if (!b.fits(HEADER)) return HEADER.slice(0, limit)
  b.push(HEADER)

  addSection(b, 'Open goals (newest first):', goals.map(goalLine), n => `- …and ${n} older open goal${n === 1 ? '' : 's'}.`)
  addSection(b, 'Running and queued tasks:', active.map(taskLine), n => `- …and ${n} more running or queued; call \`status\` for the list.`)
  const shown = decisions.slice(0, SNAPSHOT_DECISIONS).map(d => `- ${d.id}: ${clip(d.text, DECISION_CLIP)} (${day(d.at)})`)
  addSection(b, 'Decisions (newest first):', shown, n => `- …and ${n} earlier decision${n === 1 ? '' : 's'}.`, decisions.length - shown.length)

  if (carried && (carriedGoals.length || carriedTasks.length)) {
    const guide = carriedTasks.length
      ? 'Its tasks are not running now: dispatch them again if still wanted. Close goals that no longer apply with `note`.'
      : 'Close goals that no longer apply with `note`.'
    const title = `Unfinished from the last session (session ${clip(carried.sessionId, 40)}, last updated ${stamp(carried.updatedAt)}). ${guide}`
    const items = [
      ...carriedGoals.map(g => `- goal ${g.id}: ${clip(g.text, GOAL_CLIP)}`),
      ...carriedTasks.map(t => {
        const prompt = t.prompt && oneLine(t.prompt) ? ` — prompt: ${clip(t.prompt, LEDGER_PROMPT_CLIP)}` : ''
        return `- task "${clip(t.title, TITLE_CLIP)}" (${clip(t.project, PROJECT_CLIP)}, was ${t.status})${prompt}`
      }),
    ]
    addSection(b, title, items, n => `- …and ${n} more unfinished item${n === 1 ? '' : 's'}.`)
  }

  addSection(b, 'Finished tasks (newest first):', finished.map(finishedLine), n => `- …and ${n} earlier finished task${n === 1 ? '' : 's'}; call \`status\` for details.`)

  const text = b.text()
  return text.length <= limit ? text : text.slice(0, limit)
}

// ---- Compaction --------------------------------------------------------------

export const COMPACTION_NOTE =
  'The orchestrator keeps its own ledger of goals, decisions and tasks and shows it in the system prompt after this compaction. Keep the person\'s current intent and any open questions; task lists can be summarized briefly.'

export function compactionInstructions(existing: string | undefined): string {
  const base = (existing ?? '').trim()
  if (!base) return COMPACTION_NOTE
  if (base.includes(COMPACTION_NOTE)) return base
  return `${base}\n\n${COMPACTION_NOTE}`
}

/** The whole module, typed against the contract so a signature drift fails the build. */
export const ledgerModule: LedgerModule = {
  emptyLedger,
  applyTaskEvent,
  applyNote,
  pickCarryOver,
  renderSnapshot,
  compactionInstructions,
}
