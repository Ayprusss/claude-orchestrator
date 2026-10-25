// Usage-limit helpers with no engine calls: reading the account's rate-limit
// windows, and recognizing a limit in an error's text.

/** One rate-limit window, as `$.session.usage()` and `session.measure` give it. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/** The standby state while a usage limit holds work back. */
export type LimitState = {
  isLimited: boolean
  // When the limit was first seen, in ms.
  since: number
  // When it is expected to lift, in ms; 0 when unknown (checked periodically).
  until: number
  // `five_hour`, `seven_day`, `spend_limit`, or the API error kind.
  kind: string
  reason: string
}

export const NO_LIMIT: LimitState = { isLimited: false, since: 0, until: 0, kind: '', reason: '' }

// Recheck this often when the reset time is unknown.
export const RECHECK_MS = 5 * 60_000
// Wait a little past a reset before resuming, so the account has rolled over.
export const RESUME_GRACE_MS = 45_000

const NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  spend_limit: 'spend',
}
export const windowName = (kind: string) => NAMES[kind] ?? kind.replace(/_/g, ' ')

const resetMs = (w: Window) => {
  const ms = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(ms) ? ms : 0
}

/**
 * The window that blocks work now: used up and not yet reset. When several
 * are, the one that resets last, since work waits for all of them.
 */
export function blockingWindow(
  windows: readonly Window[],
  now: number,
): { kind: string; until: number } | undefined {
  let best: { kind: string; until: number } | undefined
  for (const w of windows) {
    if (w.percentUsed < 100) continue
    const until = resetMs(w)
    if (until && until <= now) continue // reset already; the reading is stale
    if (!best || until > best.until) best = { kind: w.kind, until }
  }
  return best
}

/** The windows as plain data for the HUD. */
export function windowsForHud(windows: readonly Window[]) {
  return windows.map(w => ({
    kind: w.kind,
    name: windowName(w.kind),
    percent: w.percentUsed,
    resetsAt: resetMs(w) || undefined,
  }))
}

// How Claude Code and the API word an exhausted plan or rate limit. Kept to
// error phrasing: a task about rate limiting must not read as hitting one.
const LIMIT_TEXT =
  /usage limit reached|hit your (?:usage )?limit|out of (?:extra )?usage|credit balance is too low|rate_limit_error|API Error: 429/i

/** Whether the end of a failed run's output is a limit message. */
export const looksLikeLimit = (text: string | undefined) =>
  !!text && LIMIT_TEXT.test(text.slice(-800))

// API errors that mean "no tokens right now", as StopFailure classifies them.
export const isLimitError = (kind: string | undefined) =>
  kind === 'rate_limit' || kind === 'billing_error'

/**
 * A reset time named in a limit message, in ms, or 0. Claude Code has printed
 * `Claude AI usage limit reached|<unix seconds>`.
 */
export function resetFromText(text: string, now: number): number {
  const m = text.match(/limit reached\|(\d{10})\b/i)
  if (!m) return 0
  const ms = Number(m[1]) * 1000
  return ms > now ? ms : 0
}

const LIMIT_NOTE =
  '\n\n(Note: an earlier run of this task was cut off by a usage limit. Check the working tree for partial progress before redoing any work.)'

/** The prompt a resumed task runs with. */
export const resumedPrompt = (prompt: string, interruptions: number | undefined) =>
  interruptions ? prompt + LIMIT_NOTE : prompt
