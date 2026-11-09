import { expect, test } from 'claude-code/testing'

import { createStreamParser, hasOutputFormat } from './stream'

const ev = (o: unknown) => `${JSON.stringify(o)}\n`
const assistant = (content: unknown[]) => ev({ type: 'assistant', message: { role: 'assistant', content } })

test('a stream gives a transcript, edited files and the final result', () => {
  const p = createStreamParser()
  p.push(ev({ type: 'system', subtype: 'init' }))
  p.push(assistant([{ type: 'thinking', thinking: '' }]))
  p.push(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }]))
  p.push(assistant([{ type: 'tool_use', name: 'Write', input: { file_path: 'b.txt', content: 'x' } }]))
  p.push(assistant([{ type: 'text', text: 'Done.' }]))
  p.push(ev({ type: 'result', subtype: 'success', is_error: false, result: 'All done.' }))
  expect(p.files()).toEqual(['b.txt'])
  expect(p.text()).toBe('All done.')
  const names = p.transcript().flatMap(m => (m.content as { name?: string; text?: string }[]).map(b => b.name ?? b.text))
  expect(names).toEqual(['Read', 'Write', 'Done.'])
})

test('lines split across chunks are joined, and a last line with no newline is read on end', () => {
  const p = createStreamParser()
  const text = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
  p.push(text.slice(0, 20))
  p.push(text.slice(20))
  expect(p.text()).toBe('')
  p.end()
  expect(p.text()).toBe('hi')
})

test('plain text lines stay visible, so a usage-limit notice is still seen', () => {
  const p = createStreamParser()
  p.push('Claude AI usage limit reached|1794258600\n')
  expect(p.text()).toContain('usage limit reached')
})

test('without a result the assistant text so far is the output', () => {
  const p = createStreamParser()
  p.push(assistant([{ type: 'text', text: 'one' }]))
  p.push(assistant([{ type: 'text', text: 'two' }]))
  expect(p.text()).toBe('one\n\ntwo')
})

test('hasOutputFormat sees both spellings', () => {
  expect(hasOutputFormat(['--output-format', 'json'])).toBe(true)
  expect(hasOutputFormat(['--output-format=json'])).toBe(true)
  expect(hasOutputFormat(['--verbose'])).toBe(false)
})
