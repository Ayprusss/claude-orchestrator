import { expect, test } from 'claude-code/testing'

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

test('the docs tab draws the quick start page', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 0 }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-docs' })

  expect(await ui.find({ type: 'Markdown', key: 'doc-body' })).toBeDefined()
  await ui.unmount()
})
