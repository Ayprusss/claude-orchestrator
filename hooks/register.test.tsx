import type { AgentSpawnInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The fields a test's spawn needs; the engine fills the rest in a session.
const spawnInput = (prompt: string, description: string) =>
  ({ prompt, description }) as unknown as AgentSpawnInput

const PANE = {
  plugin: 'orchestrator',
  component: 'Pane',
  requestId: 'orchestrator',
  props: {
    title: 'Orchestrator',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the pane draws the sessions tab and its tab row', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 0 }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const empty = await ui.find({ type: 'Text', text: /No sessions yet/ })
    expect(empty).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tab-docs' })).toBeDefined()
    await ui.unmount()
  }
})

test('the main session launches an agent task, in its project folder', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 1000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  const spawned: { cwd?: string; background: boolean; prompt: string }[] = []
  on('agent.spawn', (_, e) => {
    spawned.push({ cwd: e.cwd, background: e.background, prompt: e.prompt })
    return { model: 'test-model', agentId: 'agent-1' }
  })

  const queued = await $.tool.call({
    tool: 'mcp__orchestrator__dispatch',
    project: 'D:/work/demo',
    title: 'Write tests',
    prompt: 'Add tests for the parser.',
  })
  const id = /Queued task ([a-z0-9]{6})/.exec(JSON.stringify(queued))?.[1]
  expect(JSON.stringify(queued)).toContain('Queued task')
  expect(id).toBeDefined()

  // The task holds a slot, waiting for the main session to launch it.
  const waiting = await $.tool.call({ tool: 'mcp__orchestrator__status', id })
  expect(JSON.stringify(waiting)).toContain('waiting for the main session to launch it')
  // Its clock has not started: the wait before the launch is not run time.
  expect(JSON.stringify(waiting)).toContain('(agent, -)')
  await clock.advance(120_000)

  // The session's Agent call: the plugin sets the folder and the background.
  const res = await $.agent.spawn(spawnInput('Add tests for the parser.', `orch-${id} Write tests`))
  expect(res.agentId).toBe('agent-1')
  expect(spawned[0]).toEqual({ cwd: 'D:/work/demo', background: true, prompt: 'Add tests for the parser.' })
  const running = await $.tool.call({ tool: 'mcp__orchestrator__status', id })
  expect(JSON.stringify(running)).toContain(`${id} [running] Write tests`)
  expect(JSON.stringify(running)).toContain('(agent, 0s)')

  // A second launch of the same task is refused.
  const again = await $.agent.spawn(spawnInput('x', `orch-${id} Write tests`))
  expect(again.deny).toBeDefined()
  expect(spawned.length).toBe(1)
})

test('an agent spawn not tagged for a task passes through untouched', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1000 }))
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.cwd)
    return { model: 'test-model', agentId: 'agent-2' }
  })
  const res = await $.agent.spawn(spawnInput('hello', 'look around'))
  expect(res.agentId).toBe('agent-2')
  // A tag for a task that does not exist is not this plugin's to handle either.
  const res2 = await $.agent.spawn(spawnInput('hello', 'orch-zzzzzz look'))
  expect(res2.agentId).toBe('agent-2')
  expect(seen).toEqual([undefined, undefined])
})

test('the docs tab draws the quick start page', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 0 }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-docs' })

  expect(await ui.find({ type: 'Markdown', key: 'doc-body' })).toBeDefined()
  await ui.unmount()
})
