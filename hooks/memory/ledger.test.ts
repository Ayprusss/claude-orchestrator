import { expect, test } from 'claude-code/testing'

import { LEDGER_SNAPSHOT_CAP, type Ledger, type LedgerTask } from './contract'
import {
  adoptCarryOver,
  applyNote,
  applyTaskEvent,
  compactionInstructions,
  COMPACTION_NOTE,
  emptyLedger,
  ledgerModule,
  pickCarryOver,
  renderSnapshot,
} from './ledger'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

const ids = (prefix = 'n') => {
  let n = 0
  return () => `${prefix}${++n}`
}

const base = (over: Partial<Omit<LedgerTask, 'status'>> = {}): Omit<LedgerTask, 'status'> => ({
  id: 'abc123',
  project: 'orch',
  projectKey: 'orch-1234abcd',
  title: 'Fix the login bug',
  createdAt: NOW,
  ...over,
})

/** A ledger with `n` finished tasks, each with a long summary. */
function withFinished(n: number, start = NOW): Ledger {
  let l = emptyLedger('s1', start)
  for (let i = 0; i < n; i++) {
    const id = `t${String(i).padStart(5, '0')}`
    l = applyTaskEvent(l, { type: 'added', task: base({ id, title: `Task number ${i}`, createdAt: start + i }) }, start + i)
    l = applyTaskEvent(l, { type: 'status', id, status: 'done', at: start + i + 1 }, start + i + 1)
    l = applyTaskEvent(l, { type: 'summary', id, summary: `Summary ${i} `.padEnd(400, 'x') }, start + i + 1)
  }
  return l
}

// ---- Updates ----------------------------------------------------------------

test('an empty ledger has no goals, decisions or tasks', async () => {
  expect(emptyLedger('s1', NOW)).toEqual({
    version: 1,
    sessionId: 's1',
    startedAt: NOW,
    updatedAt: NOW,
    goals: [],
    decisions: [],
    tasks: [],
  })
})

test('the module object matches the contract names', async () => {
  expect(Object.keys(ledgerModule).sort()).toEqual(
    ['applyNote', 'applyTaskEvent', 'compactionInstructions', 'emptyLedger', 'pickCarryOver', 'renderSnapshot'],
  )
})

test('task events add, update and finish a task without mutating the input', async () => {
  const l0 = emptyLedger('s1', NOW)
  const l1 = applyTaskEvent(l0, { type: 'added', task: base({ why: 'the person asked', prompt: 'p'.repeat(500) }) }, NOW + 1)
  expect(l0.tasks.length).toBe(0)
  expect(l1.updatedAt).toBe(NOW + 1)
  expect(l1.tasks[0]!.status).toBe('queued')
  expect(l1.tasks[0]!.why).toBe('the person asked')
  expect(l1.tasks[0]!.prompt?.length).toBe(200)

  const l2 = applyTaskEvent(l1, { type: 'status', id: 'abc123', status: 'running', at: NOW + 2 }, NOW + 2)
  expect(l2.tasks[0]!.status).toBe('running')
  expect(l2.tasks[0]!.endedAt).toBeUndefined()
  expect(l1.tasks[0]!.status).toBe('queued')

  const l3 = applyTaskEvent(l2, { type: 'status', id: 'abc123', status: 'done', at: NOW + 3 }, NOW + 4)
  expect(l3.tasks[0]!.status).toBe('done')
  expect(l3.tasks[0]!.endedAt).toBe(NOW + 3)
  expect(l3.updatedAt).toBe(NOW + 4)

  const l4 = applyTaskEvent(l3, { type: 'summary', id: 'abc123', summary: '  Fixed it.\nTests pass.  ' }, NOW + 5)
  expect(l4.tasks[0]!.summary).toBe('Fixed it.\nTests pass.')
})

test('a requeued task (standby) is no longer ended', async () => {
  let l = applyTaskEvent(emptyLedger('s1', NOW), { type: 'added', task: base() }, NOW)
  l = applyTaskEvent(l, { type: 'status', id: 'abc123', status: 'failed', at: NOW + 1 }, NOW + 1)
  l = applyTaskEvent(l, { type: 'status', id: 'abc123', status: 'queued', at: NOW + 2 }, NOW + 2)
  expect(l.tasks[0]!.status).toBe('queued')
  expect(l.tasks[0]!.endedAt).toBeUndefined()
})

test('events for unknown ids leave the ledger as it was', async () => {
  const l = applyTaskEvent(emptyLedger('s1', NOW), { type: 'added', task: base() }, NOW)
  expect(applyTaskEvent(l, { type: 'status', id: 'nope00', status: 'done', at: NOW + 9 }, NOW + 9)).toBe(l)
  expect(applyTaskEvent(l, { type: 'summary', id: 'nope00', summary: 'x' }, NOW + 9)).toBe(l)
})

test('adding the same id twice keeps one entry and its progress', async () => {
  let l = applyTaskEvent(emptyLedger('s1', NOW), { type: 'added', task: base() }, NOW)
  l = applyTaskEvent(l, { type: 'status', id: 'abc123', status: 'running', at: NOW + 1 }, NOW + 1)
  l = applyTaskEvent(l, { type: 'added', task: base({ title: 'Renamed' }) }, NOW + 2)
  expect(l.tasks.length).toBe(1)
  expect(l.tasks[0]!.title).toBe('Renamed')
  expect(l.tasks[0]!.status).toBe('running')
})

// ---- note -------------------------------------------------------------------

test('note adds goals and decisions and names the id', async () => {
  const newId = ids('g')
  const a = applyNote(emptyLedger('s1', NOW), { action: 'goal', text: 'Ship the ledger' }, NOW + 1, newId)
  expect(a.ledger.goals).toEqual([{ id: 'g1', text: 'Ship the ledger', status: 'open', at: NOW + 1 }])
  expect(a.ledger.updatedAt).toBe(NOW + 1)
  expect(a.reply).toContain('g1')

  const b = applyNote(a.ledger, { action: 'decision', text: 'One worktree per unit' }, NOW + 2, newId)
  expect(b.ledger.decisions).toEqual([{ id: 'g2', text: 'One worktree per unit', at: NOW + 2 }])
  expect(b.reply).toContain('g2')
})

test('note closes a goal by id with done or drop', async () => {
  const newId = ids('g')
  let l = applyNote(emptyLedger('s1', NOW), { action: 'goal', text: 'A' }, NOW, newId).ledger
  l = applyNote(l, { action: 'goal', text: 'B' }, NOW, newId).ledger
  const done = applyNote(l, { action: 'done', id: 'g1' }, NOW + 5, newId)
  expect(done.ledger.goals[0]!.status).toBe('done')
  expect(done.ledger.goals[0]!.at).toBe(NOW) // `at` stays the time it was set
  expect(done.reply).toContain('g1')
  const dropped = applyNote(done.ledger, { action: 'drop', id: ' [g2] ' }, NOW + 6, newId)
  expect(dropped.ledger.goals[1]!.status).toBe('dropped')
})

test('invalid notes leave the ledger unchanged and explain why', async () => {
  const newId = ids('g')
  const l = applyNote(emptyLedger('s1', NOW), { action: 'goal', text: 'A' }, NOW, newId).ledger
  const decided = applyNote(l, { action: 'decision', text: 'D' }, NOW, newId).ledger

  const cases: [Parameters<typeof applyNote>[1], string][] = [
    [{ action: 'goal' }, 'text'],
    [{ action: 'goal', text: '   ' }, 'text'],
    [{ action: 'decision', text: '' }, 'text'],
    [{ action: 'done' }, 'id'],
    [{ action: 'done', id: 'zz9' }, 'no goal zz9'],
    [{ action: 'drop', id: 'g2' }, 'decision'],
    [{ action: 'bogus' } as never, 'unknown action'],
  ]
  for (const [input, why] of cases) {
    const r = applyNote(decided, input, NOW + 1, newId)
    expect(r.ledger).toBe(decided)
    expect(r.reply).toContain(why)
    expect(r.reply.startsWith('Nothing')).toBe(true)
  }
  const unknown = applyNote(decided, { action: 'done', id: 'zz9' }, NOW + 1, newId)
  expect(unknown.reply).toContain('g1') // lists the open goals

  const closed = applyNote(decided, { action: 'done', id: 'g1' }, NOW + 1, newId).ledger
  const again = applyNote(closed, { action: 'drop', id: 'g1' }, NOW + 2, newId)
  expect(again.ledger).toBe(closed)
  expect(again.reply).toContain('already done')
})

test('note clips long text and avoids reusing an id', async () => {
  const seq = ['g1', 'g1', 'g2']
  const newId = () => seq.shift() ?? 'gx'
  const a = applyNote(emptyLedger('s1', NOW), { action: 'goal', text: 'first' }, NOW, newId)
  const b = applyNote(a.ledger, { action: 'goal', text: 'y'.repeat(1000) }, NOW, newId)
  expect(b.ledger.goals[1]!.id).toBe('g2')
  expect(b.ledger.goals[1]!.text.length).toBe(400)
  expect(b.reply).toContain('shortened')
})

// ---- Carry-over -------------------------------------------------------------

function ledgerOf(sessionId: string, updatedAt: number, opts: { goal?: boolean; task?: LedgerTask['status']; from?: string } = {}): Ledger {
  let l = emptyLedger(sessionId, updatedAt - MIN)
  if (opts.goal) l = applyNote(l, { action: 'goal', text: `goal of ${sessionId}` }, updatedAt, () => `g-${sessionId}`).ledger
  if (opts.task) {
    l = applyTaskEvent(l, { type: 'added', task: base({ id: `t-${sessionId}`, prompt: 'Do the thing' }) }, updatedAt)
    if (opts.task !== 'queued') l = applyTaskEvent(l, { type: 'status', id: `t-${sessionId}`, status: opts.task, at: updatedAt }, updatedAt)
  }
  return { ...l, updatedAt, ...(opts.from ? { carriedFrom: opts.from } : {}) }
}

test('carry-over picks the newest other ledger with unfinished work', async () => {
  const older = ledgerOf('old', NOW - 3 * DAY, { goal: true })
  const newer = ledgerOf('new', NOW - 1 * DAY, { task: 'running' })
  const current = ledgerOf('cur', NOW, { goal: true })
  expect(pickCarryOver([older, current, newer], 'cur', NOW)?.sessionId).toBe('new')
  expect(pickCarryOver([older, current], 'cur', NOW)?.sessionId).toBe('old')
})

test('carry-over skips finished, too-old, current and handed-over ledgers', async () => {
  const finished = ledgerOf('fin', NOW - MIN, { task: 'done' })
  const stale = ledgerOf('stale', NOW - 7 * DAY, { goal: true })
  const current = ledgerOf('cur', NOW, { goal: true })
  expect(pickCarryOver([finished, stale, current], 'cur', NOW)).toBeUndefined()

  const queued = ledgerOf('q', NOW - 6 * DAY, { task: 'queued' })
  expect(pickCarryOver([queued], 'cur', NOW)?.sessionId).toBe('q')
  // A later session already carried it over: that one is responsible now.
  const later = ledgerOf('later', NOW - DAY, { from: 'q' })
  expect(pickCarryOver([queued, later], 'cur', NOW)).toBeUndefined()
  expect(pickCarryOver([], 'cur', NOW)).toBeUndefined()
})

test('adopting a carry-over copies open goals so note can close them', async () => {
  const prev = ledgerOf('prev', NOW - DAY, { goal: true, task: 'running' })
  let l = adoptCarryOver(emptyLedger('cur', NOW), prev, NOW)
  expect(l.carriedFrom).toBe('prev')
  expect(l.goals.map(g => g.id)).toEqual(['g-prev'])
  expect(l.tasks.length).toBe(0)

  const shown = renderSnapshot(l, prev, NOW)
  expect(shown).toContain('Unfinished from the last session')
  expect(shown).toContain('goal g-prev')
  expect(shown).not.toContain('Open goals') // listed once, under the carried block

  l = applyNote(l, { action: 'done', id: 'g-prev' }, NOW + 1, ids()).ledger
  const after = renderSnapshot(l, prev, NOW + 1)
  expect(after).not.toContain('g-prev')
  expect(after).toContain('Fix the login bug') // the unfinished task is still offered

  // Dispatched again in this session: no longer listed as unfinished from the last one.
  l = applyTaskEvent(l, { type: 'added', task: base({ id: 'new001' }) }, NOW + 2)
  const redone = renderSnapshot(l, prev, NOW + 2)
  expect(redone).not.toContain('Unfinished from the last session')
  expect(redone).toContain('new001 [queued]')
})

// ---- Snapshot ---------------------------------------------------------------

test('an empty ledger renders nothing', async () => {
  expect(renderSnapshot(emptyLedger('s1', NOW), undefined, NOW)).toBe('')
  const doneGoals = applyNote(
    applyNote(emptyLedger('s1', NOW), { action: 'goal', text: 'A' }, NOW, () => 'g1').ledger,
    { action: 'done', id: 'g1' },
    NOW,
    () => 'x',
  ).ledger
  expect(renderSnapshot(doneGoals, undefined, NOW)).toBe('')
  // A carried ledger with nothing unfinished adds nothing either.
  expect(renderSnapshot(emptyLedger('s1', NOW), ledgerOf('p', NOW, { task: 'done' }), NOW)).toBe('')
})

test('the snapshot shows the header, sections in order, and the carried block', async () => {
  const newId = ids('g')
  let l = emptyLedger('s1', NOW)
  l = applyNote(l, { action: 'goal', text: 'Older goal' }, NOW, newId).ledger
  l = applyNote(l, { action: 'goal', text: 'Newer goal' }, NOW + MIN, newId).ledger
  l = applyNote(l, { action: 'decision', text: 'Use worktrees' }, NOW, newId).ledger
  l = applyTaskEvent(l, { type: 'added', task: base({ id: 'run001', title: 'Running one', why: 'needed for X' }) }, NOW)
  l = applyTaskEvent(l, { type: 'status', id: 'run001', status: 'running', at: NOW }, NOW)
  l = applyTaskEvent(l, { type: 'added', task: base({ id: 'que001', title: 'Queued\none' }) }, NOW)
  l = applyTaskEvent(l, { type: 'added', task: base({ id: 'fin001', title: 'Finished one' }) }, NOW)
  l = applyTaskEvent(l, { type: 'status', id: 'fin001', status: 'done', at: NOW }, NOW)
  l = applyTaskEvent(l, { type: 'summary', id: 'fin001', summary: 's'.repeat(300) }, NOW)
  const prev = ledgerOf('prev', NOW - DAY, { task: 'queued' })

  const text = renderSnapshot(l, prev, NOW)
  expect(text.startsWith('## Orchestrator ledger')).toBe(true)
  expect(text).toContain("orchestrator's own record")
  expect(text).toContain('may lag the conversation by a few turns')
  const order = ['Open goals', 'Newer goal', 'Older goal', 'Running and queued', 'run001 [running]', 'que001 [queued]', 'Decisions', 'Unfinished from the last session', 'Finished tasks', 'fin001 [done]']
  const at = order.map(s => text.indexOf(s))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  expect(text).toContain('why: needed for X')
  expect(text).toContain('Queued one') // newlines in titles collapse
  expect(text).toContain('2026-10-25 12:00 UTC') // absolute date of the carried ledger
  expect(text).toContain('prompt: Do the thing')
  expect(text).toContain('s'.repeat(159) + '…')
  expect(text).not.toContain('s'.repeat(160))
})

test('decisions show the newest 10 and count the rest', async () => {
  let l = emptyLedger('s1', NOW)
  for (let i = 0; i < 13; i++) l = applyNote(l, { action: 'decision', text: `decision ${i}` }, NOW + i, () => `d${i}`).ledger
  const text = renderSnapshot(l, undefined, NOW)
  expect(text).toContain('decision 12')
  expect(text).toContain('decision 3')
  expect(text).not.toContain('decision 2 ')
  expect(text).toContain('and 3 earlier decisions')
})

test('the snapshot stays under the cap and collapses older finished tasks', async () => {
  const l = withFinished(200)
  const text = renderSnapshot(l, undefined, NOW)
  expect(text.length).toBeLessThanOrEqual(LEDGER_SNAPSHOT_CAP)
  expect(text.length).toBeGreaterThan(LEDGER_SNAPSHOT_CAP - 400) // it uses the room it has
  expect(text).toContain('t00199 [done]') // the newest is shown
  expect(text).not.toContain('t00000 [done]')
  const m = text.match(/and (\d+) earlier finished tasks; call `status` for details/)
  expect(m).toBeTruthy()
  const shown = (text.match(/^- t\d{5} \[done\]/gm) ?? []).length
  expect(shown + Number(m?.[1])).toBe(200)
})

test('a small cap is honored for every size of ledger', async () => {
  for (const cap of [0, 50, 400, 700, 1000, 2500]) {
    for (const n of [1, 3, 30]) {
      const l = withFinished(n)
      const withGoals = applyNote(l, { action: 'goal', text: 'g'.repeat(350) }, NOW, () => 'gg').ledger
      const text = renderSnapshot(withGoals, ledgerOf('p', NOW, { goal: true, task: 'running' }), NOW, cap)
      expect(text.length).toBeLessThanOrEqual(cap)
    }
  }
  // With room for only the header and a count, the finished tasks still get counted.
  const header = renderSnapshot(withFinished(1), undefined, NOW).split('\n\n')[0] ?? ''
  const tight = renderSnapshot(withFinished(30), undefined, NOW, header.length + 120)
  expect(tight).toContain('and 30 earlier finished tasks')
})

test('many running tasks collapse into a count, and lower sections still get a line', async () => {
  let l = emptyLedger('s1', NOW)
  for (let i = 0; i < 150; i++) {
    const id = `r${String(i).padStart(5, '0')}`
    l = applyTaskEvent(l, { type: 'added', task: base({ id, title: 'A running task with a fairly long title '.repeat(2), createdAt: NOW + i }) }, NOW)
    l = applyTaskEvent(l, { type: 'status', id, status: 'running', at: NOW }, NOW)
  }
  const text = renderSnapshot(l, undefined, NOW)
  expect(text.length).toBeLessThanOrEqual(LEDGER_SNAPSHOT_CAP)
  expect(text).toContain('r00000 [running]') // oldest running first
  expect(text).toMatch(/and \d+ more running or queued/)
})

test('the snapshot is the same for the same ledger, whatever the time', async () => {
  const l = withFinished(40)
  const prev = ledgerOf('p', NOW - DAY, { goal: true, task: 'running' })
  const a = renderSnapshot(l, prev, NOW)
  const b = renderSnapshot(l, prev, NOW + 3 * DAY + 17 * MIN)
  const c = renderSnapshot(JSON.parse(JSON.stringify(l)), JSON.parse(JSON.stringify(prev)), NOW + 1)
  expect(b).toBe(a)
  expect(c).toBe(a)
  expect(a).not.toMatch(/\bago\b|\bminutes?\b|\bhours?\b/)
})

test('only plugin and session text appear: summaries clipped, prompts only for carried tasks', async () => {
  let l = applyTaskEvent(emptyLedger('s1', NOW), { type: 'added', task: base({ prompt: 'SECRET PROMPT BODY' }) }, NOW)
  l = applyTaskEvent(l, { type: 'status', id: 'abc123', status: 'running', at: NOW }, NOW)
  const text = renderSnapshot(l, undefined, NOW)
  expect(text).toContain('Fix the login bug')
  expect(text).not.toContain('SECRET PROMPT BODY')
})

// ---- Compaction ---------------------------------------------------------------

test('compaction instructions add the ledger note to what is there', async () => {
  expect(compactionInstructions(undefined)).toBe(COMPACTION_NOTE)
  expect(compactionInstructions('  ')).toBe(COMPACTION_NOTE)
  const out = compactionInstructions('Focus on the API work.')
  expect(out.startsWith('Focus on the API work.')).toBe(true)
  expect(out).toContain("Keep the person's current intent and any open questions")
  expect(compactionInstructions(out)).toBe(out) // not added twice
})
