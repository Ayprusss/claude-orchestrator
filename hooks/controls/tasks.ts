// Per-task model and effort: validation and the flags a process task gets.

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** '' or one of the effort levels; anything else is ''. */
export function normalizeEffort(x: unknown): string {
  if (typeof x !== 'string') return ''
  const e = x.trim().toLowerCase()
  return EFFORTS.includes(e) ? e : ''
}

/** Trimmed alias or model id; '' when empty, too long, or not a plain id. */
export function normalizeModel(x: unknown): string {
  if (typeof x !== 'string') return ''
  const m = x.trim()
  if (m.length > 80) return ''
  return /^[A-Za-z0-9._:\-[\]]+$/.test(m) ? m : ''
}

/** Flags for a process task: ['--model', m] and/or ['--effort', e]; none for ''. */
export function processModelArgs(model: string, effort: string): string[] {
  const m = normalizeModel(model)
  const e = normalizeEffort(effort)
  return [...(m ? ['--model', m] : []), ...(e ? ['--effort', e] : [])]
}

/** Only queued tasks can change model or effort. */
export function canConfigure(task: { status: string }): boolean {
  return task.status === 'queued'
}
