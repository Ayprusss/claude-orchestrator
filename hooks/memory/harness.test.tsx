import type { On } from 'claude-code'
import { mergeMemory } from './harness'
import { expect, mock, test } from 'claude-code/testing'

// The wiring, through the plugin's own tools: the ledger, `why`, and memory off.
// Tests have no file system, so one lives in memory here.

type Files = Map<string, string>

// The engine hands hooks resolved paths (D:\home\t\... on Windows): key by one spelling.
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

function memFs(on: On): Files {
  const files: Files = new Map()
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({
    value: files.has(norm(e.path)) || [...files.keys()].some(k => k.startsWith(`${norm(e.path)}/`)),
  }))
  on('fs.list', (_, e) => {
    const prefix = `${norm(e.path)}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of files.keys()) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      const [head] = rest.split('/')
      if (head) names.set(head, rest.includes('/') ? 'dir' : 'file')
    }
    if (!names.size) throw new Error(`ENOENT: ${e.path}`)
    return {
      value: [...names].map(([name, kind]) => ({
        name,
        kind,
        size: files.get(`${prefix}${name}`)?.length ?? 0,
        mtimeMs: 1000,
        isLink: false,
      })),
    }
  })
  return files
}

function session(on: On, opts: { isHeadless?: boolean } = {}) {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.parse('2026-10-26T12:00:00Z') })
  mock.env(on, { HOME: '/home/t' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: opts.isHeadless ? [] : ['terminal'] }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.status', () => ({ value: undefined }))
  const files = memFs(on)
  return { clock, files }
}

// The memory tools join the generated tool types at the next reload; call them untyped.
type Call = (input: Record<string, unknown>) => Promise<unknown>
const call = ($: unknown, input: Record<string, unknown>) => ($ as { tool: { call: Call } }).tool.call(input)

const LEDGER = '/home/t/.claude/orchestrator-memory/ledgers/s1.json'
const text = (r: unknown) => JSON.stringify(r)

test('note records a goal in the ledger, and the ledger is saved to its file', async ($, on) => {
  const { clock, files } = session(on)
  const r = await call($, { tool: 'mcp__orchestrator__note', action: 'goal', text: 'Ship the memory harness' })
  expect(text(r)).toMatch(/g_|goal/i)
  await clock.advance(1000)
  const saved = files.get(LEDGER)
  expect(saved).toBeDefined()
  const ledger = JSON.parse(saved ?? '{}') as { goals: { text: string; status: string }[] }
  expect(ledger.goals.map(g => [g.text, g.status])).toEqual([['Ship the memory harness', 'open']])
})

test('dispatch keeps why on the task and in the ledger', async ($, on) => {
  const { clock, files } = session(on)
  const q = await call($, {
    tool: 'mcp__orchestrator__dispatch',
    project: '/work/demo',
    title: 'Write tests',
    prompt: 'Add tests.',
    why: 'the parser has none',
  })
  const id = /Queued task ([a-z0-9]{6})/.exec(text(q))?.[1]
  expect(id).toBeDefined()
  const st = await call($, { tool: 'mcp__orchestrator__status', id })
  expect(text(st)).toContain('Why: the parser has none')
  await clock.advance(1000)
  const ledger = JSON.parse(files.get(LEDGER) ?? '{}') as { tasks: { id: string; why?: string; projectKey: string }[] }
  expect(ledger.tasks[0]?.id).toBe(id)
  expect(ledger.tasks[0]?.why).toBe('the parser has none')
  expect(ledger.tasks[0]?.projectKey).toMatch(/^demo-[0-9a-f]{8}$/)
})

test('dispatch keeps a task model and effort; a bad effort falls back to the defaults', async ($, on) => {
  session(on)
  const q = await call($, {
    tool: 'mcp__orchestrator__dispatch',
    project: '/work/demo',
    title: 'Refactor',
    prompt: 'Tidy up.',
    model: 'sonnet',
    effort: 'high',
  })
  const id = /Queued task ([a-z0-9]{6})/.exec(text(q))?.[1]
  expect(text(await call($, { tool: 'mcp__orchestrator__status', id }))).toContain('Model: sonnet · effort high')
  const q2 = await call($, {
    tool: 'mcp__orchestrator__dispatch',
    project: '/work/demo',
    title: 'Other',
    prompt: 'p',
    effort: 'ultra; rm -rf /',
  })
  const id2 = /Queued task ([a-z0-9]{6})/.exec(text(q2))?.[1]
  // A bad effort is dropped, and the task gets the Settings defaults instead (Haiku).
  const st2 = text(await call($, { tool: 'mcp__orchestrator__status', id: id2 }))
  expect(st2).toContain('Model: haiku')
  expect(st2).not.toContain('ultra')
})

const BRIEFS = '/home/t/.claude/orchestrator-memory/briefs/'

test('dispatch with reads writes a brief with just that section; status shows the brief line', async ($, on) => {
  const { files } = session(on)
  files.set('/work/demo/PLAN.md', '# Plan\n## Unit S\nS only\n## Unit T\nT only\n')
  const q = await call($, {
    tool: 'mcp__orchestrator__dispatch',
    project: '/work/demo',
    title: 'Unit S',
    prompt: 'Build unit S.',
    reads: ['PLAN.md#Unit S', 'hooks/a.ts'],
  })
  const id = /Queued task ([a-z0-9]{6})/.exec(text(q))?.[1]
  const brief = [...files.entries()].find(([k]) => k.startsWith(BRIEFS))
  expect(brief).toBeDefined()
  expect(brief?.[1]).toContain('## Unit S\nS only')
  expect(brief?.[1]).not.toContain('T only')
  expect(brief?.[1]).toContain('- hooks/a.ts')
  const st = text(await call($, { tool: 'mcp__orchestrator__status', id }))
  expect(st).toContain('Unit S')
})

test('dispatch_batch writes the shared context once; each task brief points to it', async ($, on) => {
  const { files } = session(on)
  const r = await call($, {
    tool: 'mcp__orchestrator__dispatch_batch',
    shared: 'Rules: work in your worktree; run the tests.',
    project: '/work/demo',
    tasks: [
      { title: 'A', prompt: 'Do A.' },
      { title: 'B', prompt: 'Do B.' },
    ],
  })
  expect(text(r)).toContain('Queued 2 tasks')
  const written = [...files.entries()].filter(([k]) => k.startsWith(BRIEFS))
  const shared = written.filter(([k]) => k.includes('/batch-'))
  expect(shared.length).toBe(1)
  expect(shared[0]?.[1]).toContain('Rules: work in your worktree')
  const briefs = written.filter(([k]) => !k.includes('/batch-'))
  expect(briefs.length).toBe(2)
  for (const [, md] of briefs) expect(md).toContain(shared[0]?.[0] ?? 'missing')
})

test('remember and memory_search find a fact; forget hides it', async ($, on) => {
  session(on)
  await call($, { tool: 'mcp__orchestrator__dispatch', project: '/work/demo', title: 't', prompt: 'p' })
  const r = await call($, {
    tool: 'mcp__orchestrator__remember',
    project: 'demo',
    text: 'Run the tests with claude plugin test .',
    kind: 'command',
    isFromPerson: true,
  })
  const id = /Remembered (f_[a-z0-9]+)/.exec(text(r))?.[1]
  expect(id).toBeDefined()
  const found = await call($, { tool: 'mcp__orchestrator__memory_search', query: 'run tests' })
  expect(text(found)).toContain(id ?? 'missing')
  expect(text(found)).toContain('from the person')
  await call($, { tool: 'mcp__orchestrator__forget', project: 'demo', id })
  const gone = await call($, { tool: 'mcp__orchestrator__memory_search', query: 'run tests' })
  expect(text(gone)).not.toContain(id ?? 'missing')
})

test('a headless run (a process task) keeps no memory: nothing is written', async ($, on) => {
  const { clock, files } = session(on, { isHeadless: true })
  const r = await call($, { tool: 'mcp__orchestrator__note', action: 'goal', text: 'x' })
  expect(text(r)).toContain('Memory is off')
  await call($, { tool: 'mcp__orchestrator__dispatch', project: '/work/demo', title: 't', prompt: 'p' })
  await clock.advance(1000)
  expect([...files.keys()]).toEqual([])
})

test('the shared memory is searchable by its alias', async ($, on) => {
  session(on)
  const r = await call($, {
    tool: 'mcp__orchestrator__remember',
    project: 'shared',
    text: 'Always use a git worktree for parallel edits.',
    kind: 'preference',
    isFromPerson: true,
  })
  expect(text(r)).toContain('Shared (all projects)')
  const found = await call($, { tool: 'mcp__orchestrator__memory_search', query: 'worktree', project: 'all' })
  expect(text(found)).toContain('Always use a git worktree')
  const unscoped = await call($, { tool: 'mcp__orchestrator__memory_search', query: 'worktree' })
  expect(text(unscoped)).toContain('Always use a git worktree')
})

test('a project’s memory takes in the shared facts but not its episodes', () => {
  const fact = (id: string) => ({ id, text: id, kind: 'preference' as const, origin: 'person' as const, sessionId: 's', at: 1 })
  const episode = { taskId: 't', sessionId: 's', title: 't', prompt: '', backend: 'agent' as const, status: 'done' as const, outcome: 'succeeded' as const, summary: '', isRawOutput: false, files: [], followups: [], interruptions: 0, endedAt: 1 }
  const own = {
    lines: [{ kind: 'fact' as const, v: 1 as const, fact: fact('f_own') }],
    knowledge: undefined,
    meta: { path: '/p', name: 'p', createdAt: 0, consolidatedFactIds: ['f_a'] },
  }
  const shared = {
    lines: [{ kind: 'fact' as const, v: 1 as const, fact: fact('f_sh') }, { kind: 'episode' as const, v: 1 as const, episode }],
    knowledge: { project: 'shared', consolidatedAt: 1, facts: [fact('f_shk')] },
    meta: { path: '', name: 's', createdAt: 0, consolidatedFactIds: ['f_b'] },
  }
  const m = mergeMemory(own, shared)
  expect(m.lines.map(l => l.kind)).toEqual(['fact', 'fact'])
  expect(m.knowledge?.facts.map(f => f.id)).toEqual(['f_shk'])
  expect(m.consolidatedIds).toEqual(['f_a', 'f_b'])
  expect(mergeMemory({ lines: [], knowledge: undefined, meta: undefined }, { lines: [], knowledge: undefined, meta: undefined }).knowledge).toBeUndefined()
})

const PANE = {
  plugin: 'orchestrator',
  component: 'Pane',
  requestId: 'orchestrator',
  props: { title: 'Orchestrator', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('editing an inbox fact in the Memory tab replaces it with the person’s own text', async ($, on) => {
  session(on)
  await call($, { tool: 'mcp__orchestrator__dispatch', project: '/work/demo', title: 't', prompt: 'p' })
  const r = await call($, { tool: 'mcp__orchestrator__remember', project: 'demo', text: 'Run tests with npm test.', kind: 'command' })
  const id = /Remembered (f_[a-z0-9]+)/.exec(text(r))?.[1] ?? ''
  expect(id).not.toBe('')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-memory' })
  await ui.press({ key: 'mem-part-inbox' })
  await ui.press({ key: `mem-fact-${id}` })
  await ui.input({ key: `mem-edit-${id}`, text: 'Run tests with claude plugin test .' })
  await ui.unmount()
  const read = text(await call($, { tool: 'mcp__orchestrator__memory_read', project: 'demo', part: 'inbox' }))
  expect(read).toContain('claude plugin test .')
  expect(read).toContain('from the person')
  expect(read).not.toContain('npm test')
})

test('at start, old ledgers are deleted through Node, never this session’s', async ($, on) => {
  const { clock, files } = session(on)
  const argvs: string[][] = []
  on('process.run', (_, e) => {
    argvs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const dir = '/home/t/.claude/orchestrator-memory/ledgers'
  files.set(`${dir}/old.json`, '{}')
  await call($, { tool: 'mcp__orchestrator__note', action: 'goal', text: 'keep me' })
  await clock.advance(1000)
  const all = argvs.flat().join(' ').replaceAll(String.fromCharCode(92), '/')
  expect(all).toContain('ledgers/old.json')
  expect(all).not.toContain('ledgers/s1.json')
})

test('a process task’s stream gives its episode a transcript and the files it edited', async ($, on) => {
  const { clock, files } = session(on)
  const argvs: string[][] = []
  const line = (o: unknown) => `${JSON.stringify(o)}\n`
  on('process.spawn', async function* (_, e) {
    argvs.push([...e.argv])
    yield { stream: 'stdout' as const, text: line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/work/demo/b.txt' } }] } }) }
    yield { stream: 'stdout' as const, text: line({ type: 'result', result: 'Wrote b.txt.' }) }
    return { value: { code: 0, signal: null } }
  })
  await call($, { tool: 'mcp__orchestrator__dispatch', project: '/work/demo', title: 'write b', prompt: 'Write b.txt.', backend: 'process' })
  await clock.advance(2000)
  expect(argvs[0]).toContain('stream-json')
  const journal = [...files.entries()].filter(([k]) => k.includes('/journal/'))
  const episode = journal.flatMap(([, v]) => v.split('\n')).find(l => l.includes('"kind":"episode"'))
  expect(episode).toBeDefined()
  expect(episode).toContain('/work/demo/b.txt')
})

test('an agent is told to verify its work against the conditions the orchestrator set', async ($, on) => {
  const { clock } = session(on)
  const prompts: string[] = []
  on('process.spawn', async function* (_, e) {
    prompts.push(String(e.argv[2]))
    return { value: { code: 0, signal: null } }
  })
  await call($, {
    tool: 'mcp__orchestrator__dispatch',
    project: '/work/demo',
    title: 'v',
    prompt: 'Add the flag.',
    backend: 'process',
    verify: 'claude plugin test . passes; the flag is documented',
  })
  await call($, { tool: 'mcp__orchestrator__dispatch', project: '/work/demo', title: 'w', prompt: 'Other.', backend: 'process' })
  await clock.advance(2000)
  expect(prompts[0]).toContain('Add the flag.')
  expect(prompts[0]).toContain('Done means all of: claude plugin test . passes; the flag is documented')
  expect(prompts[0]).toContain('Verified: yes')
  expect(prompts[1]).toContain('everything the task above asks for')
})
