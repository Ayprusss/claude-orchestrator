import { expect, test } from 'claude-code/testing'

import { LAUNCH_TAG, launchRequest, launchTag, promptMatches, reportNote, splitKnown } from './launch'

test('a known prompt is named, not repeated; additions go in markers', async () => {
  const original = 'Refactor the parser.\nKeep the API.'
  const full = `BRIEF\n\n${original}${reportNote(150, '/m/reports/abc123.md')}`
  const known = splitKnown(full, original)
  expect(known?.before).toBe('BRIEF\n\n')
  const text = launchRequest([
    { id: 'abc123', title: 'Refactor', agentType: '', model: 'sonnet', effort: 'medium', folder: '/w', prompt: full, ...(known ? { known } : {}) },
  ])
  expect(text).toContain('the exact prompt you passed to dispatch for this task ("Refactor")')
  expect(text).not.toContain('Keep the API.')
  expect(text).toContain('<<<ORCH-BEFORE abc123\nBRIEF')
  expect(text).toContain('at most 150 words')
  expect(text).toContain('/m/reports/abc123.md')
})

test('a prompt not found verbatim is sent in full', async () => {
  expect(splitKnown('something else', 'Refactor the parser.')).toBeUndefined()
  expect(splitKnown('anything', '   ')).toBeUndefined()
})

test('a launched prompt matches when it carries the dispatch prompt, whitespace aside', async () => {
  expect(promptMatches('BRIEF\n\nRefactor   the parser.\nKeep the API.\n\nWhen you finish…', 'Refactor the parser.\nKeep the API.')).toBe(true)
  expect(promptMatches('Refactor the parser.', 'Refactor the parser.\nKeep the API.')).toBe(false)
})

test('the report note names the word cap and the file; 0 turns it off', async () => {
  expect(reportNote(0)).toBe('')
  expect(reportNote(150)).toContain('at most 150 words')
  expect(reportNote(150)).not.toContain('Put longer detail')
})

const SPEC = {
  id: 'abc123',
  title: 'Write tests',
  agentType: '',
  model: 'sonnet',
  effort: '',
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

test('an effort line appears only when the task has one', async () => {
  const text = launchRequest([{ ...SPEC, effort: 'high' }, { ...SPEC, id: 'def456' }])
  expect(text).toContain('- effort: high')
  expect(text).toContain("pass effort as the `effort` parameter of the Agent tool")
  expect(text.split('Task def456')[1]).not.toContain('- effort:')
})
