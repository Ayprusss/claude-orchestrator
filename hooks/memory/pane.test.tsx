import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { OrchLedger, OrchMemorySettings, OrchMemoryView } from '../../types'
import type { Episode, Fact, Ledger, MemorySettings, MemoryTabActions, MemoryTabData, MemoryView } from './contract'
import { DEFAULT_MEMORY_SETTINGS } from './contract'
import {
  clipText,
  factSource,
  fmtDate,
  groupFacts,
  isClearArmed,
  memorySettingsRows,
  memoryTab,
  pickProjectKey,
  projectFolder,
  sortEpisodes,
  sortLedgerTasks,
} from './pane'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 20) // 2026-10-20

const fact = (id: string, kind: Fact['kind'], text: string, extra: Partial<Fact> = {}): Fact => ({
  id,
  kind,
  text,
  origin: 'summary',
  sourceTaskId: 'k3x9p1',
  sessionId: 's1',
  at: T0,
  ...extra,
})

const episode = (taskId: string, extra: Partial<Episode> = {}): Episode => ({
  taskId,
  sessionId: 's1',
  title: `Task ${taskId}`,
  prompt: 'Do the thing.',
  backend: 'agent',
  status: 'done',
  outcome: 'succeeded',
  summary: `Summary of ${taskId}.`,
  isRawOutput: false,
  files: [],
  followups: [],
  interruptions: 0,
  endedAt: T0,
  ...extra,
})

const LEDGER: Ledger = {
  version: 1,
  sessionId: 'sess-1',
  startedAt: T0,
  updatedAt: T0,
  goals: [
    { id: 'g1', text: 'Ship the memory harness', status: 'open', at: T0 },
    { id: 'g0', text: 'Old goal', status: 'done', at: T0 - DAY },
  ],
  decisions: [{ id: 'd1', text: 'One worktree per unit', at: T0 }],
  tasks: [
    { id: 't1', project: 'orch', projectKey: 'orch-1234abcd', title: 'Build pane', why: 'The person asked', status: 'running', createdAt: T0 },
    { id: 't0', project: 'orch', projectKey: 'orch-1234abcd', title: 'Build ledger', status: 'done', summary: 'Ledger built.', createdAt: T0 - DAY, endedAt: T0 },
  ],
}

const DATA: MemoryTabData = {
  projects: [
    { key: 'orch-1234abcd', name: 'orch', path: 'D:/code/orch' },
    { key: 'web-5678efgh', name: 'web', path: 'D:/code/web' },
  ],
  view: { projectKey: 'orch-1234abcd', part: 'knowledge', selected: '' },
  knowledge: [
    fact('f_conv01', 'convention', 'Tests run with `claude plugin test .` from the repo root.'),
    fact('f_gotc01', 'gotcha', '`$.fs.write` replaces whole files.', { origin: 'person', sourceTaskId: undefined, at: T0 + DAY }),
    fact('f_stal01', 'architecture', 'The pane lives in hooks/pane.tsx.', { isStale: true, paths: ['hooks/pane.tsx'] }),
  ],
  inbox: [fact('f_inbx01', 'command', 'Build with `npm run build`.')],
  episodes: [episode('e1', { endedAt: T0 }), episode('e2', { endedAt: T0 + DAY, outcome: 'failed', summary: 'It broke.' })],
  ledger: LEDGER,
  memoryRoot: 'C:/Users/me/.claude/orchestrator-memory/',
}

const PROPS = {
  title: 'Memory test',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

type Call = [string, ...unknown[]]

// Draws the Memory tab from a test hook, with the view kept here so presses
// that change it show on the next draw.
function harness(on: On, start: Partial<MemoryTabData> = {}, opts = {}) {
  const calls: Call[] = []
  const state: { data: MemoryTabData } = { data: { ...DATA, ...start } }
  const actions: MemoryTabActions = {
    setView: (patch: Partial<MemoryView>) => {
      calls.push(['setView', patch])
      state.data = { ...state.data, view: { ...state.data.view, ...patch } }
    },
    deleteFact: (key, id) => void calls.push(['deleteFact', key, id]),
    keepFact: (key, id) => void calls.push(['keepFact', key, id]),
    consolidate: key => void calls.push(['consolidate', key]),
    clearProject: key => void calls.push(['clearProject', key]),
  }
  on('ui.render', { component: 'Pane', requestId: 'mem-test' }, ($, e) => memoryTab($.ui.resolve(e), state.data, actions, opts))
  return { calls, state }
}

const mountMem = ($: Engine, surface: 'terminal' | 'desktop' | 'mobile') =>
  $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'mem-test', props: PROPS })

// ---- pure helpers ----------------------------------------------------------

// types/index.d.ts mirrors the contract (it must not import): a type checker
// flags this line when the two drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const MIRRORS: [Same<OrchLedger, Ledger>, Same<OrchMemoryView, MemoryView>, Same<OrchMemorySettings, MemorySettings>] = [true, true, true]

test('the types file mirrors the contract', () => {
  expect(MIRRORS).toEqual([true, true, true])
})

test('dates, sources and clipping read as knowledge.md writes them', () => {
  expect(fmtDate(T0)).toBe('2026-10-20')
  expect(fmtDate(0)).toBe('-')
  expect(fmtDate(undefined)).toBe('-')
  expect(factSource(fact('f_a', 'convention', 'x'))).toBe('task k3x9p1')
  expect(factSource(fact('f_a', 'convention', 'x', { origin: 'person' }))).toBe('person, task k3x9p1')
  expect(factSource(fact('f_a', 'convention', 'x', { origin: 'person', sourceTaskId: undefined }))).toBe('person')
  expect(factSource(fact('f_a', 'convention', 'x', { origin: 'model', sourceTaskId: undefined }))).toBe('model')
  expect(clipText('a  b\nc', 10)).toBe('a b c')
  expect(clipText('abcdefghij', 5)).toBe('abcd…')
})

test('facts group by kind in section order, newest first, duplicates dropped', () => {
  const groups = groupFacts([
    fact('f_1', 'gotcha', 'old', { at: T0 }),
    fact('f_2', 'convention', 'c'),
    fact('f_3', 'gotcha', 'new', { at: T0 + DAY }),
    fact('f_3', 'gotcha', 'dup', { at: T0 + DAY }),
  ])
  expect(groups.map(g => g.title)).toEqual(['Conventions', 'Gotchas'])
  expect(groups[1]!.facts.map(f => f.text)).toEqual(['new', 'old'])
})

test('the project falls back to the first listed; the folder and clear arm read right', () => {
  expect(pickProjectKey({ projectKey: 'web-5678efgh' }, DATA.projects)).toBe('web-5678efgh')
  expect(pickProjectKey({ projectKey: 'gone' }, DATA.projects)).toBe('orch-1234abcd')
  expect(pickProjectKey({ projectKey: 'gone' }, [])).toBe('')
  expect(projectFolder('C:/m/', 'orch-1')).toBe('C:/m/projects/orch-1')
  expect(isClearArmed({ selected: 'clear:orch-1' }, 'orch-1')).toBe(true)
  expect(isClearArmed({ selected: 'clear:orch-1' }, 'web-2')).toBe(false)
  expect(isClearArmed({ selected: 'clear:' }, '')).toBe(false)
})

test('episodes sort newest first; ledger tasks put running work first', () => {
  expect(sortEpisodes([episode('a', { endedAt: 1 }), episode('b', { endedAt: 3 }), episode('a', { endedAt: 2 })]).map(e => e.taskId)).toEqual(['b', 'a'])
  expect(sortLedgerTasks(LEDGER.tasks).map(t => t.id)).toEqual(['t1', 't0'])
})

// ---- the drawn tab ---------------------------------------------------------

test('knowledge shows facts by kind with source and date; delete names the fact', async ($, on) => {
  const { calls } = harness(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountMem($, surface)
    expect(await ui.find({ type: 'Text', text: 'Conventions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Gotchas' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'mem-fact-f_conv01' }))?.text).toContain('(task k3x9p1, 2026-10-20)')
    expect((await ui.find({ type: 'Button', key: 'mem-fact-f_gotc01' }))?.text).toContain('(person, 2026-10-21)')
    expect((await ui.find({ type: 'Button', key: 'mem-fact-f_stal01' }))?.text).toContain('possibly stale')
    expect(await ui.find({ type: 'Select', key: 'mem-project' })).toBeDefined()
    expect(await ui.find({ text: 'C:/Users/me/.claude/orchestrator-memory/projects/orch-1234abcd' })).toBeDefined()
    await ui.press({ key: 'mem-del-f_conv01' })
    await ui.unmount()
  }
  expect(calls.filter(c => c[0] === 'deleteFact')).toEqual([
    ['deleteFact', 'orch-1234abcd', 'f_conv01'],
    ['deleteFact', 'orch-1234abcd', 'f_conv01'],
  ])
})

test('the part buttons switch parts; inbox keeps and deletes; episodes show outcome and summary', async ($, on) => {
  const { calls } = harness(on)
  const ui = await mountMem($, 'terminal')
  await ui.press({ key: 'mem-part-inbox' })
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'mem-part-inbox', text: '[Inbox 1]' })).toBeDefined()
  await ui.press({ key: 'mem-keep-f_inbx01' })
  await ui.press({ key: 'mem-del-f_inbx01' })
  expect(calls).toContainEqual(['keepFact', 'orch-1234abcd', 'f_inbx01'])
  expect(calls).toContainEqual(['deleteFact', 'orch-1234abcd', 'f_inbx01'])

  await ui.press({ key: 'mem-part-episodes' })
  await ui.redraw()
  const rows = await ui.findAll({ type: 'Button', text: /Task e\d/ })
  expect(rows.map(r => r.key)).toEqual(['mem-ep-e2', 'mem-ep-e1'])
  expect(rows[0]!.text).toContain('failed')
  expect(await ui.find({ type: 'Text', text: 'It broke.' })).toBeDefined()

  await ui.press({ key: 'mem-ep-e2' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /\[done, failed\] e2/ })).toBeDefined()
  await ui.unmount()
})

test('the ledger shows goals, decisions and tasks', async ($, on) => {
  harness(on, { view: { projectKey: '', part: 'ledger', selected: '' } })
  const ui = await mountMem($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /Ship the memory harness/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /One worktree per unit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Build pane/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /why: The person asked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ledger built\./ })).toBeDefined()
  await ui.unmount()
})

test('clear project memory needs a second press; consolidate runs at once', async ($, on) => {
  const { calls } = harness(on)
  const ui = await mountMem($, 'terminal')
  await ui.press({ key: 'mem-consolidate' })
  expect(calls).toContainEqual(['consolidate', 'orch-1234abcd'])

  await ui.press({ key: 'mem-clear' })
  expect(calls.some(c => c[0] === 'clearProject')).toBe(false)
  await ui.redraw()
  expect((await ui.find({ type: 'Button', key: 'mem-clear' }))?.text).toContain('Press again')
  await ui.press({ key: 'mem-clear-cancel' })
  await ui.redraw()
  expect((await ui.find({ type: 'Button', key: 'mem-clear' }))?.text).toContain('Clear project memory')

  await ui.press({ key: 'mem-clear' })
  await ui.redraw()
  await ui.press({ key: 'mem-clear' })
  expect(calls.filter(c => c[0] === 'clearProject')).toEqual([['clearProject', 'orch-1234abcd']])
  await ui.unmount()
})

test('empty states: no memory folder, no projects, nothing stored yet', async ($, on) => {
  const st = harness(on, { memoryRoot: undefined })
  const ui = await mountMem($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /No memory folder yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'mem-clear' })).toBeUndefined()

  st.state.data = { ...DATA, projects: [] }
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /No projects yet/ })).toBeDefined()

  st.state.data = { ...DATA, knowledge: [], inbox: [], episodes: [] }
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /No memory for this project yet/ })).toBeDefined()

  st.state.data = { ...DATA, knowledge: [] }
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /1 fact wait in the Inbox/ })).toBeDefined()
  await ui.unmount()
})

test('memory off shows a notice; mobile picks projects with buttons', async ($, on) => {
  const { calls } = harness(on, {}, { isMemoryOn: false, hasForms: false })
  const ui = await mountMem($, 'mobile')
  expect(await ui.find({ type: 'Text', text: /Memory is off/ })).toBeDefined()
  expect(await ui.find({ type: 'Select' })).toBeUndefined()
  await ui.press({ key: 'mem-proj-web-5678efgh' })
  expect(calls).toContainEqual(['setView', { projectKey: 'web-5678efgh', selected: '' }])
  await ui.unmount()
})

test('the settings rows edit the six memory settings', async ($, on) => {
  const changes: Partial<MemorySettings>[] = []
  let cfg: MemorySettings = { ...DEFAULT_MEMORY_SETTINGS }
  on('ui.render', { component: 'Pane', requestId: 'mem-settings' }, ($, e) => {
    const els = $.ui.resolve(e)
    const { Box } = els
    return (
      <Box flexDirection="column">
        {memorySettingsRows(els, cfg, patch => {
          changes.push(patch)
          cfg = { ...cfg, ...patch }
        })}
      </Box>
    )
  })
  const ui = await $.ui.mount({ plugin: 'test', surface: 'desktop', component: 'Pane', requestId: 'mem-settings', props: PROPS })
  for (const key of ['mem-on', 'mem-summary-detail', 'mem-transcripts', 'mem-recall-budget']) {
    expect(await ui.find({ type: 'Select', key })).toBeDefined()
  }
  expect(await ui.find({ type: 'Input', key: 'mem-dir' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'mem-summary-model' })).toBeDefined()

  await ui.select({ key: 'mem-on', value: 'off' })
  await ui.select({ key: 'mem-summary-detail', value: 'detailed' })
  await ui.select({ key: 'mem-transcripts', value: 'on' })
  await ui.select({ key: 'mem-recall-budget', value: '6000' })
  await ui.input({ key: 'mem-dir', text: '  D:/mem  ' })
  await ui.input({ key: 'mem-summary-model', text: '   ' })
  expect(changes).toEqual([
    { isMemoryOn: false },
    { summaryDetail: 'detailed' },
    { isTranscriptKept: true },
    { recallBudgetChars: 6000 },
    { memoryDir: 'D:/mem' },
    { summaryModel: 'haiku' },
  ])
  await ui.unmount()
})

test('the docs tab has a Memory page', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 0 }))
  const ui = await $.ui.mount({ plugin: 'orchestrator', surface: 'desktop', component: 'Pane', requestId: 'orchestrator', props: { ...PROPS, title: 'Orchestrator' } })
  await ui.press({ key: 'tab-docs' })
  await ui.press({ key: 'doc-memory' })
  const body = await ui.find({ type: 'Markdown', key: 'doc-body' })
  expect(body?.text).toContain('# Memory')
  expect(body?.text).toContain('Clear project memory')
  await ui.unmount()
})
