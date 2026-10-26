// Briefs and the large-read guard (TOKEN_SAVINGS_PLAN.md items 4 and 7): the
// file I/O around the pure helpers in ../brief.ts.

import type { EngineInterface } from 'claude-code'

import type { OrchProject as Project } from '../../types'
import { briefLine, extractSection, inlineBrief, largeReadRefusal, renderBrief, renderShared } from '../brief'
import type { BriefPart, ReadRef } from '../brief'
import { memoryRoot as memMemoryRoot } from '../memory/harness'
import { uid } from './util'

type E = EngineInterface

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function briefsDir(): string | undefined {
  const root = memMemoryRoot()
  return root ? `${root}/briefs` : undefined
}

async function readText($: E, path: string): Promise<string | undefined> {
  try {
    const r: unknown = await $.fs.read(path)
    return typeof r === 'string' ? r : undefined
  } catch {
    return undefined
  }
}

/** The batch's shared context, written once: its file path, or its text when there is no memory folder. */
export async function writeShared($: E, shared: string): Promise<{ path?: string; text: string }> {
  const text = renderShared(uid(), shared)
  const dir = briefsDir()
  if (!dir) return { text }
  const path = `${dir}/batch-${uid()}${uid()}.md`
  await $.fs.write(path, text)
  return { path, text }
}

/**
 * The prompt a task runs with when it has a reading list or shared context:
 * a brief file (memory folder) named in one line before the task's own
 * prompt, or, without a memory folder, the brief's text before it.
 */
export async function withBriefFile(
  $: E,
  project: Project,
  task: { title: string; prompt: string; reads: readonly ReadRef[] },
  shared?: { path?: string; text: string },
): Promise<string> {
  if (!task.reads.length && !shared) return task.prompt
  const parts: BriefPart[] = []
  for (const ref of task.reads) {
    if (!ref.heading) {
      parts.push({ kind: 'file', path: ref.path })
      continue
    }
    const md = await readText($, `${project.path}/${ref.path}`)
    if (md === undefined) {
      parts.push({ kind: 'missing', path: ref.path, heading: ref.heading, reason: 'file not found' })
      continue
    }
    const text = extractSection(md, ref.heading)
    parts.push(
      text === undefined
        ? { kind: 'missing', path: ref.path, heading: ref.heading, reason: 'no such heading' }
        : { kind: 'section', path: ref.path, heading: ref.heading, text },
    )
  }
  const dir = briefsDir()
  if (!dir) {
    const md = renderBrief({ title: task.title, parts })
    return inlineBrief(shared ? `${shared.text}\n\n${md}` : md, task.prompt)
  }
  const md = renderBrief({ title: task.title, ...(shared?.path ? { sharedPath: shared.path } : {}), parts })
  const path = `${dir}/${uid()}${uid()}.md`
  await $.fs.write(path, md)
  return `${briefLine(path)}\n\n${task.prompt}`
}

/**
 * The large-read guard for agents the orchestrator launched: a refusal for a
 * whole-file Read over the limit, or undefined. Briefs are always readable.
 */
export async function readGuard($: E, input: { file_path?: unknown; offset?: unknown; limit?: unknown }, limitKB: number): Promise<string | undefined> {
  if (!limitKB || limitKB <= 0 || typeof input.file_path !== 'string') return undefined
  const dir = briefsDir()
  if (dir && norm(input.file_path).startsWith(`${norm(dir)}/`)) return undefined
  try {
    const st = await $.fs.stat(input.file_path)
    if (st.kind !== 'file') return undefined
    return largeReadRefusal(input, st.size, limitKB)
  } catch {
    return undefined
  }
}
