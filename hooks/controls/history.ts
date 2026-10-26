// Resumed history: turns the conversation's rows ($.session.messages()) into
// HUD messages, so a resumed session shows its past in Comms.
import type { EngineInterface } from 'claude-code'

type E = EngineInterface

export type HudMsg = {
  type: 'msg'
  role: 'user' | 'assistant' | 'system'
  text: string
  at: number
  source: 'history'
}

export const DEFAULT_CAP = 200
export const TEXT_CAP = 4000
const ORCH_PREFIX = '[orchestrator]'

// Blocks the harness injects into a user row's text.
const INJECTED = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|user-prompt-submit-hook|task-notification)\b[^>]*>[\s\S]*?<\/\1>/gi
// Whole rows that are not the person talking.
const META_START = /^(caveat: the messages below|\[request interrupted|<bash-input>|<bash-stdout>|<bash-stderr>)/i

const clip = (s: string) => (s.length > TEXT_CAP ? s.slice(0, TEXT_CAP - 1) + '…' : s)

// SessionMessage carries no time today; accept one if a build adds it.
function rowTime(row: Record<string, unknown>): number {
  for (const k of ['at', 'timestamp', 'time', 'createdAt']) {
    const v = row[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v
    if (typeof v === 'string') {
      const ms = Date.parse(v)
      if (Number.isFinite(ms)) return ms
    }
  }
  return 0
}

/** Pure: the conversation's rows as HUD messages, oldest first, at most `cap` (the newest). */
export function rowsToMessages(rows: readonly unknown[], cap: number = DEFAULT_CAP): HudMsg[] {
  const out: HudMsg[] = []
  if (!Array.isArray(rows)) return out
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (row.role !== 'user' && row.role !== 'assistant') continue
    if (row.isMeta === true || row.isSidechain === true) continue
    if (typeof row.text !== 'string') continue
    let text = row.text
    if (row.role === 'user') {
      // A user row that only carries tool results has no prompt of its own.
      text = text.replace(INJECTED, '').trim()
      if (!text || META_START.test(text)) continue
    } else {
      text = text.trim()
    }
    if (!text) continue
    const isOrch = row.role === 'user' && text.startsWith(ORCH_PREFIX)
    out.push({
      type: 'msg',
      role: isOrch ? 'system' : (row.role as 'user' | 'assistant'),
      text: clip(text),
      at: rowTime(row),
      source: 'history',
    })
  }
  const n = Math.max(0, Math.floor(cap))
  return n >= out.length ? out : out.slice(out.length - n)
}

async function rows($: E): Promise<unknown[]> {
  const got: unknown = await $.session.messages()
  return Array.isArray(got) ? got : []
}

/** Reads $.session.messages() and converts; [] on any error. */
export async function historyMessages($: E, cap: number = DEFAULT_CAP): Promise<HudMsg[]> {
  try {
    return rowsToMessages(await rows($), cap)
  } catch {
    return []
  }
}

/** Whether the session looks resumed: it already has user or assistant rows. */
export async function isResumed($: E): Promise<boolean> {
  try {
    return (await rows($)).some(r => {
      const role = (r as { role?: unknown } | null)?.role
      return role === 'user' || role === 'assistant'
    })
  } catch {
    return false
  }
}
