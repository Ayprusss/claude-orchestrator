import { expect, test } from 'claude-code/testing'

import { LAUNCH_TAG, launchRequest, launchTag } from './launch'

const SPEC = {
  id: 'abc123',
  title: 'Write tests',
  agentType: '',
  model: 'sonnet',
  folder: 'D:/work/demo',
  prompt: 'Add tests for the parser.\nKeep them small.',
}

test('the request names each task, its folder, and its prompt verbatim', async () => {
  const text = launchRequest([SPEC])
  expect(text.startsWith('[orchestrator] 1 agent task is ready to start.')).toBe(true)
  expect(text).toContain('- description: orch-abc123 Write tests')
  expect(text).toContain('do not set a name')
  expect(text).toContain('- subagent_type: general-purpose')
  expect(text).toContain('- model: sonnet')
  expect(text).toContain('- folder (set by the orchestrator): D:/work/demo')
  expect(text).toContain('<<<ORCH-PROMPT abc123\nAdd tests for the parser.\nKeep them small.\nORCH-PROMPT abc123>>>')
})

test('several tasks go in one request, launched in one turn', async () => {
  const text = launchRequest([SPEC, { ...SPEC, id: 'def456', model: '' }])
  expect(text).toContain('2 agent tasks are ready to start')
  expect(text).toContain('all in one turn')
  expect(text).toContain('- description: orch-def456 Write tests')
  // No model line when the task has none.
  expect(text.split('Task def456')[1]).not.toContain('- model:')
})

test('launch tags round-trip, and other descriptions do not match', async () => {
  expect(LAUNCH_TAG.exec(`${launchTag('abc123')} Write tests`)?.[1]).toBe('abc123')
  expect(LAUNCH_TAG.exec('Write tests')).toBeNull()
  expect(LAUNCH_TAG.exec('orch-abc1234 x')).toBeNull()
})
