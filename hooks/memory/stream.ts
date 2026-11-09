// Reads the output of `claude -p --output-format stream-json --verbose` as it
// arrives, so a process task gives the memory harness what an agent task does:
// a transcript (assistant text and tool names) and the files it edited.
// Anything that is not a JSON line (such as a usage-limit notice printed as
// plain text) is kept in the visible text so limit detection still sees it.

import type { ApiMessageLike } from './contract'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const FILE_CAP = 200

export type StreamParser = {
  push: (chunk: string) => void
  /** Call when the stream ends, to read a last line with no newline. */
  end: () => void
  /** The task's output: the final result when there is one, else the assistant text so far. */
  text: () => string
  transcript: () => ApiMessageLike[]
  files: () => string[]
}

/** Whether the person's flags already choose an output format. */
export function hasOutputFormat(args: readonly string[]): boolean {
  return args.some(a => a === '--output-format' || a.startsWith('--output-format='))
}

export function createStreamParser(): StreamParser {
  let partial = ''
  const assistantText: string[] = []
  const plain: string[] = []
  const transcript: ApiMessageLike[] = []
  const files = new Set<string>()
  let result: string | undefined

  const line = (raw: string) => {
    const s = raw.trim()
    if (!s) return
    let ev: unknown
    try {
      ev = JSON.parse(s)
    } catch {
      plain.push(s)
      return
    }
    if (!ev || typeof ev !== 'object') return
    const e = ev as { type?: unknown; message?: { role?: unknown; content?: unknown }; result?: unknown }
    if (e.type === 'result' && typeof e.result === 'string') {
      result = e.result
      return
    }
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) return
    const kept: unknown[] = []
    for (const b of e.message.content as { type?: string; text?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown } }[]) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        assistantText.push(b.text)
        kept.push({ type: 'text', text: b.text })
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        kept.push({ type: 'tool_use', name: b.name })
        if (EDIT_TOOLS.has(b.name) && files.size < FILE_CAP) {
          const p = b.input?.file_path ?? b.input?.notebook_path
          if (typeof p === 'string' && p) files.add(p)
        }
      }
    }
    if (kept.length) transcript.push({ role: 'assistant', content: kept })
  }

  return {
    push(chunk) {
      partial += chunk
      const parts = partial.split('\n')
      partial = parts.pop() ?? ''
      for (const p of parts) line(p)
    },
    end() {
      if (partial) line(partial)
      partial = ''
    },
    text: () => [result ?? assistantText.join('\n\n'), ...plain].filter(Boolean).join('\n\n'),
    transcript: () => transcript,
    files: () => [...files],
  }
}
