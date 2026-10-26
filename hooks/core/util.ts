// Small pure helpers shared by the core modules. No state, no `$`.

export const uid = () => Math.random().toString(36).slice(2, 8)
export const clip = (text: string, cap: number) =>
  text.length > cap ? text.slice(text.length - cap) : text
export const splitArgs = (text: string) => text.split(/\s+/).filter(Boolean)
export const nameOf = (path: string) =>
  path.replace(/[\/]+$/, '').split(/[\/]/).pop() || path
// POSIX (/home/me), Windows drive (C:\code or C:/code) or UNC (\host\share).
export const isAbsPath = (path: string) =>
  path.startsWith('/') || /^[A-Za-z]:[\/]/.test(path) || path.startsWith('\\')

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

export const PANE = 'orchestrator'
export const OUTPUT_CAP = 8000
export const MAX_PARALLEL = 16
export const TOOL = 'mcp__orchestrator__'

// A handle on a running child: its `return` ends it.
export type Handle = { return: (value?: never) => Promise<unknown> }
