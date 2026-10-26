// The orchestrator's own model and effort, set from the HUD. Model goes through
// the /model command; effort through an /effort command or a /config row when
// this build has one (looked up once and cached), else it is reported as not
// settable. Input is checked against the lists; free text never reaches a command.

import type { EngineInterface } from 'claude-code'

type E = EngineInterface

export type Choice = { id: string; label: string }

export const MODEL_CHOICES: readonly Choice[] = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
]

export const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type SessionInfo = { model: string; effort: string; canSetEffort: boolean }
type Result = { ok: boolean; text: string }

// Where this build keeps effort: a slash command, a /config row, or nowhere.
type EffortHome = { command: boolean; rowKey: string }
let home: EffortHome | undefined
// The last level a hook input reported (`effort.level`), see noteEffort.
let noted = ''

/** Remembers the effort a hook input reports; wiring may call it. */
export function noteEffort(input: { effort?: { level?: unknown } } | undefined): void {
  const level = input?.effort?.level
  if (typeof level === 'string' && EFFORT_LEVELS.includes(level)) noted = level
}

/** Forgets the cached lookup and the noted level (tests). */
export function resetSessionControls(): void {
  home = undefined
  noted = ''
}

const looksFailed = (text: string) =>
  /\b(error|unknown|invalid|unrecognized|not (available|found|supported|recognized)|cannot|failed|denied)\b/i.test(text)

async function findHome($: E): Promise<EffortHome> {
  if (home) return home
  let command = false
  let rowKey = ''
  try {
    command = (await $.command.list()).some(c => c.name === 'effort')
  } catch {
    return { command: false, rowKey: '' }
  }
  if (!command) {
    try {
      const row = (await $.config.list()).find(r => /^effort/i.test(r.key) && r.kind === 'choice')
      rowKey = row ? row.key : ''
    } catch {
      return { command: false, rowKey: '' }
    }
  }
  home = { command, rowKey }
  return home
}

export async function sessionInfo($: E): Promise<SessionInfo> {
  let model = ''
  try {
    model = await $.session.model()
  } catch {
    // unknown
  }
  const h = await findHome($)
  let effort = noted
  if (!effort && h.rowKey) {
    try {
      const row = (await $.config.list()).find(r => r.key === h.rowKey)
      if (row && typeof row.value === 'string' && EFFORT_LEVELS.includes(row.value)) effort = row.value
    } catch {
      // unknown
    }
  }
  if (!effort) {
    try {
      const v = await $.settings.read({ key: 'effortLevel' })
      if (typeof v === 'string' && EFFORT_LEVELS.includes(v)) effort = v
    } catch {
      // unknown
    }
  }
  return { model: typeof model === 'string' ? model : '', effort, canSetEffort: h.command || !!h.rowKey }
}

/** '' = back to the default model. Runs /model through $.command.run. */
export async function setSessionModel($: E, model: string): Promise<Result> {
  if (typeof model !== 'string' || !MODEL_CHOICES.some(c => c.id === model)) {
    return { ok: false, text: 'Unknown model choice.' }
  }
  try {
    const r = await $.command.run({ command: 'model', args: model === '' ? 'default' : model })
    const text = (r.text ?? '').trim()
    if (text && looksFailed(text)) return { ok: false, text }
    return { ok: true, text: text || `Model set to ${model || 'default'}.` }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}

/** Runs the effort command when this build has one; otherwise { ok: false, text: why }. */
export async function setSessionEffort($: E, effort: string): Promise<Result> {
  if (typeof effort !== 'string' || (effort !== '' && !EFFORT_LEVELS.includes(effort))) {
    return { ok: false, text: 'Unknown effort level.' }
  }
  const h = await findHome($)
  if (!h.command && !h.rowKey) {
    return { ok: false, text: 'This build of Claude Code has no /effort command or effort setting a plugin can change.' }
  }
  try {
    if (h.command) {
      const r = await $.command.run({ command: 'effort', args: effort === '' ? 'auto' : effort })
      const text = (r.text ?? '').trim()
      if (text && looksFailed(text)) return { ok: false, text }
      noted = effort
      return { ok: true, text: text || `Effort set to ${effort || 'default'}.` }
    }
    const r = await $.config.set({ key: h.rowKey, value: effort === '' ? 'auto' : effort })
    if ('deny' in r && r.deny) return { ok: false, text: String(r.deny) }
    noted = effort
    return { ok: true, text: `Effort set to ${effort || 'default'}.` }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}
