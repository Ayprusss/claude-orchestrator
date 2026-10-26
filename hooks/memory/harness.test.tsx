import type { On } from 'claude-code'
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
  // A bad effort is dropped, and the task gets the Settings defaults instead.
  const st2 = text(await call($, { tool: 'mcp__orchestrator__status', id: id2 }))
  expect(st2).toContain('Model: sonnet · effort medium')
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
