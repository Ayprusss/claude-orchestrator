// Usage-limit standby: enter and leave it, recheck at the reset, and send a
// cut-off task back to the queue. Owns the standby timer and flags.

import type { EngineInterface } from 'claude-code'

import type { OrchLimit as LimitState, OrchStatus as TaskStatus } from '../../types'
import * as hud from '../hud'
import {
  NO_LIMIT,
  RECHECK_MS,
  RESUME_GRACE_MS,
  blockingWindow,
  isLimitError,
  looksLikeLimit,
  resetFromText,
  windowName,
} from '../limits'
import { onTaskStatus as memOnTaskStatus, resumePending as memResumePending } from '../memory/harness'
import { finish, pump, refreshStatus, releaseTask } from './queue'
import { getLimit, getSettings, getTasks, isLimitedNow, updateLimit, updateTasks } from './state'
import { OUTPUT_CAP, clip, fmtDuration } from './util'

type E = EngineInterface

// Agents that StopFailure reported out of tokens, claimed at their turn.complete.
const limitedAgents = new Set<string>()
let recheckTimer: { cancel: () => void } | undefined
// After a hand-made resume, a stale 100% reading must not undo it at once.
let windowsIgnoredUntil = 0

export async function usageWindows($: E) {
  try {
    return (await $.session.usage()).rateLimits
  } catch {
    return []
  }
}


/** Enters standby if a usage window is used up; true when it is. */
export async function checkWindows($: E): Promise<boolean> {
  const now = await $.clock.now()
  if (now < windowsIgnoredUntil) return false
  const w = blockingWindow(await usageWindows($), now)
  if (!w) return false
  await enterLimit($, w.kind, w.until, `${windowName(w.kind)} limit used up`)
  return true
}
export function scheduleRecheck($: E, delayMs: number) {
  recheckTimer?.cancel()
  // Long waits are taken in steps, so a sleeping laptop catches up on wake.
  const ms = Math.min(Math.max(5000, delayMs), 30 * 60_000)
  recheckTimer = $.clock.after(ms, () => void recheck($).catch(() => scheduleRecheck($, RECHECK_MS)))
}

export async function enterLimit($: E, kind: string, until: number, reason: string) {
  const now = await $.clock.now()
  const cur = await getLimit($)
  const next: LimitState = {
    isLimited: true,
    since: cur.isLimited ? cur.since : now,
    until: until || (cur.isLimited ? cur.until : 0),
    kind: until || !cur.isLimited ? kind : cur.kind,
    reason,
  }
  await updateLimit($, () => next)
  scheduleRecheck($, next.until ? next.until - now + RESUME_GRACE_MS : RECHECK_MS)
  if (!cur.isLimited) {
    const cfg = await getSettings($)
    const when = next.until ? ` It resets in ${fmtDuration(next.until - now)}.` : ''
    const text =
      cfg.isStandbyOnLimit !== false
        ? `Usage limit reached. Operations on standby.${when}`
        : `Usage limit reached.${when} Standby is off, so new tasks will fail.`
    hud.event({ type: 'msg', role: 'system', text, status: 'limit', at: now })
    void $.ui.toast(text)
  }
  await refreshStatus($)
}
export async function exitLimit($: E, text = 'Usage limit lifted. Resuming operations.') {
  const cur = await getLimit($)
  recheckTimer?.cancel()
  recheckTimer = undefined
  if (!cur.isLimited) return
  await updateLimit($, () => NO_LIMIT)
  hud.event({ type: 'msg', role: 'system', text, status: 'resume', at: await $.clock.now() })
  void $.ui.toast(text)
  await pump($)
  void memResumePending($, await getSettings($), isLimitedNow($)).catch(() => undefined)
}

/** At the reset time (or periodically when it is unknown), see if tokens are back. */
export async function recheck($: E) {
  const cur = await getLimit($)
  if (!cur.isLimited) return
  const now = await $.clock.now()
  if (cur.until && now < cur.until + RESUME_GRACE_MS - 2000) {
    scheduleRecheck($, cur.until + RESUME_GRACE_MS - now)
    return
  }
  // Ask the API directly with the smallest request there is.
  const r = await $.model.complete({ model: 'haiku', prompt: 'ping', maxTokens: 1, timeoutMs: 30_000 })
  const isStillLimited = !r.isAnswered && r.reason === 'api-error' && isLimitError(r.error)
  if (!isStillLimited) {
    await exitLimit($)
    return
  }
  const w = blockingWindow(await usageWindows($), now)
  await updateLimit($, x => ({ ...x, until: w?.until ?? 0, kind: w?.kind ?? x.kind }))
  scheduleRecheck($, w ? w.until - now + RESUME_GRACE_MS : RECHECK_MS)
}

/** Sends a cut-off task back to the queue to run again after the reset. */
export async function requeue($: E, id: string, output: string) {
  const task = (await getTasks($)).find(t => t.id === id)
  if (!task || task.status === 'killed') return
  releaseTask(id, task.agentId)
  const note = '[standby] Cut off by a usage limit; it runs again when the limit resets.'
  await updateTasks($, list =>
    list.map(t => {
      if (t.id !== id) return t
      const { agentId: _a, startedAt: _s, endedAt: _e, launchAskedAt: _l, launchAsks: _n, ...rest } = t
      return {
        ...rest,
        status: 'queued' as const,
        interruptions: (t.interruptions ?? 0) + 1,
        output: clip(`${output || t.output}\n\n${note}`, OUTPUT_CAP),
      }
    }),
  )
  await memOnTaskStatus($, id, 'queued').catch(() => undefined)
  hud.event({
    type: 'msg',
    role: 'system',
    text: `Task "${task.title}" is on standby until the usage limit resets.`,
    taskId: id,
    status: 'standby',
    at: await $.clock.now(),
  })
  await refreshStatus($)
}

/** A task ran out of tokens: standby (requeue) or fail, by the setting. */
export async function onLimitFailure($: E, id: string, output: string, kind: string, until: number) {
  const w = blockingWindow(await usageWindows($), await $.clock.now())
  await enterLimit($, w?.kind ?? kind, w?.until ?? until, 'a task ran out of tokens')
  if ((await getSettings($)).isStandbyOnLimit !== false) await requeue($, id, output)
  else await finish($, id, 'failed', output)
}

/**
 * An agent task ended on an error. StopFailure, which says whether it was a
 * usage limit, may come just after turn.complete, so this runs a beat later.
 */
export async function settleAgentError($: E, id: string, agentId: string, answer: string, status: TaskStatus) {
  const now = await $.clock.now()
  const w = blockingWindow(await usageWindows($), now)
  const isLimit = limitedAgents.delete(agentId) || !!w || looksLikeLimit(answer)
  if (isLimit) await onLimitFailure($, id, answer, 'rate_limit', resetFromText(answer, now))
  else await finish($, id, status, answer)
}

// The person's call: if tokens are still out, the next failure re-enters standby.
export async function resumeByHand($: E) {
  windowsIgnoredUntil = (await $.clock.now()) + 2 * 60_000
  await exitLimit($, 'Standby lifted by hand. Resuming operations.')
}

// ---- Hooks ----------------------------------------------------------

/** Standby outlives a reload; its timer does not. */
export async function resumeStandbyTimer($: E) {
  const lim = await getLimit($)
  if (lim.isLimited) {
    const now = await $.clock.now()
    scheduleRecheck($, lim.until ? lim.until + RESUME_GRACE_MS - now : 60_000)
  }
}

/** A model call died on an API error; rate_limit and billing_error mean no tokens. */
export async function onStopFailure(
  $: E,
  e: { error: string; agent_id?: string; error_details?: string },
) {
  try {
    if (isLimitError(e.error)) {
      if (e.agent_id) limitedAgents.add(e.agent_id)
      const now = await $.clock.now()
      const w = blockingWindow(await usageWindows($), now)
      await enterLimit(
        $,
        w?.kind ?? e.error,
        w?.until ?? resetFromText(e.error_details ?? '', now),
        e.error_details || e.error,
      )
    }
  } catch {
    // Best effort: the task's own end still settles it.
  }
}

/**
 * The account's windows moved: enter standby at 100%, leave it once a
 * window that put us there has room again.
 */
export async function onMeasure(
  $: E,
  e: { changed: readonly string[]; rateLimits: Parameters<typeof blockingWindow>[0] },
) {
  try {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const now = await $.clock.now()
      const w = blockingWindow(e.rateLimits, now)
      const cur = await getLimit($)
      if (w && now >= windowsIgnoredUntil) {
        await enterLimit($, w.kind, w.until, `${windowName(w.kind)} limit used up`)
      } else if (!w && cur.isLimited && e.rateLimits.some(x => x.kind === cur.kind)) {
        await exitLimit($)
      }
    }
  } catch {
    // Best effort.
  }
}
