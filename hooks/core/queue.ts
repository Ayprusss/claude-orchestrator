// The task queue: adding, pumping, launching, finishing, killing, retrying,
// and the agent tasks the main session launches. Owns the live handles of
// running tasks; other modules reach them through the functions here.

import type { EngineInterface } from 'claude-code'

import type {
  OrchBackend as Backend,
  OrchProject as Project,
  OrchSettings as Settings,
  OrchTask as Task,
  OrchStatus as TaskStatus,
} from '../../types'
import * as hud from '../hud'
import { promptMatches, launchRequest, splitKnown } from '../launch'
import type { LaunchSpec } from '../launch'
import { LAUNCH_TAG, reportNote } from '../launch'
import {
  captureTask as memCaptureTask,
  ensureStarted as memEnsureStarted,
  memoryRoot as memMemoryRoot,
  onSettings as memOnSettings,
  onTaskAdded as memOnTaskAdded,
  withMemory as memWithMemory,
} from '../memory/harness'
import { normalizeEffort, processModelArgs } from '../controls/tasks'
import { looksLikeLimit, resetFromText, resumedPrompt, throttledMax } from '../limits'
import { checkIdle, isMainBusyNow, markBusy, noteTaskRan } from './ping'
import { checkWindows, onLimitFailure, settleAgentError, usageWindows } from './standby'
import {
  getLimit,
  getProjects,
  getSettings,
  getTasks,
  isLimitedNow,
  saveSettings,
  setTask,
  updateSettings,
  updateTasks,
} from './state'
import { MAX_PARALLEL, OUTPUT_CAP, TOOL, clip, fmtDuration, splitArgs, uid } from './util'
import type { Handle } from './util'

type E = EngineInterface

// Live handles. A reload starts these over; the task records stay.
const streams = new Map<string, Handle>()
const killed = new Set<string>()
const agentToTask = new Map<string, string>()
const unclaimed = new Map<string, { answer: string; status: TaskStatus }>()
let isPumping = false
// The main session's context: a new value at load, at each compaction and at
// /clear. A task dispatched under the current value has its prompt in context.
let contextEpoch = Math.random().toString(36).slice(2, 10)
export const newContextEpoch = () => {
  contextEpoch = Math.random().toString(36).slice(2, 10)
}
// Fewer tasks at once while a usage window is past the threshold.
let isSlowed = false
// Tasks re-asked with the full prompt after a launch that did not carry it.
const reasked = new Set<string>()

// Agent tasks the main session launches (agentLaunch 'session'): see launch.ts.
// Ask again when a launch has not come this long after asking, while the
// main session is idle; give up after this many asks.
const LAUNCH_RETRY_MS = 3 * 60_000
const LAUNCH_MAX_ASKS = 3
let launchTimer: { cancel: () => void } | undefined

// ---- Accessors for the live handles ---------------------------------

/** The task an agent runs, if the plugin knows it. */
export const taskOfAgent = (agentId: string) => agentToTask.get(agentId)
/** A task is cut off or settled: forget its stream and agent. */
export function releaseTask(id: string, agentId?: string) {
  streams.delete(id)
  if (agentId) agentToTask.delete(agentId)
}

/** The note asking a task for a short final reply, with its report file. */
function taskReportNote(cfg: Settings, taskId: string): string {
  const root = memMemoryRoot()
  return reportNote(cfg.reportWords ?? 150, root ? `${root}/reports/${taskId}.md` : undefined)
}

/** Memory starts at session.start, or at first use when no surface was there yet. */
export async function memReady($: E) {
  try {
    await memEnsureStarted($, await getSettings($))
  } catch {
    // Memory stays off; the orchestrator works without it.
  }
}

export async function refreshStatus($: E) {
  const list = await getTasks($)
  const run = list.filter(t => t.status === 'running').length
  const wait = list.filter(t => t.status === 'queued').length
  const lim = await getLimit($)
  if (lim.isLimited) {
    $.ui.status(`orch: usage limit, standby (${run} running, ${wait} queued)`)
    return
  }
  $.ui.status(run + wait === 0 ? undefined : `orch: ${run} running, ${wait} queued${isSlowed && wait ? ', slowed' : ''}`)
}

export async function finish(
  $: E,
  id: string,
  status: TaskStatus,
  output?: string,
) {
  const list = await getTasks($)
  const task = list.find(t => t.id === id)
  if (!task) return
  streams.delete(id)
  const final: TaskStatus = task.status === 'killed' ? 'killed' : status
  await setTask($, id, {
    status: final,
    endedAt: await $.clock.now(),
    ...(output === undefined ? {} : { output: clip(output, OUTPUT_CAP) }),
  })
  hud.event({
    type: 'msg',
    role: 'system',
    text: `Task "${task.title}" ${final === 'done' ? 'complete' : final}.`,
    taskId: id,
    status: final,
    at: await $.clock.now(),
  })
  try {
    const settled = (await getTasks($)).find(t => t.id === id)
    const project = (await getProjects($)).find(p => p.id === task.projectId)
    if (settled) {
      memCaptureTask($, settled, project, await getSettings($), {
        setTask: patch => setTask($, id, patch),
        isLimited: isLimitedNow($),
      })
    }
  } catch {
    // Memory is best effort; the task record is already settled.
  }
  // An agent the main session launched reports back to it by itself: a second
  // wake-up would only repeat it.
  const isSelfReported = task.backend === 'agent' && !!task.launchAsks && !!task.agentId
  if (task.isNotify && final !== 'killed' && !isSelfReported) {
    try {
      await $.prompt.submit({
        text: `[orchestrator] Task ${id} "${task.title}" finished: ${final}. Call ${TOOL}status with id ${id} to read the result.`,
      })
    } catch {
      // The session may be ending; the task record is already settled.
    }
  }
  await pump($)
}
export async function launch($: E, task: Task) {
  const [projs, cfg] = await Promise.all([getProjects($), getSettings($)])
  const project = projs.find(p => p.id === task.projectId)
  if (!project) {
    await finish($, task.id, 'failed', 'The project of this task no longer exists.')
    return
  }

  const prompt = resumedPrompt(await memWithMemory($, project, task, cfg), task.interruptions) + taskReportNote(cfg, task.id)
  if (task.backend === 'agent') {
    try {
      const res = await $.agent.spawn({
        prompt,
        description: task.title.slice(0, 60),
        subagentType: task.agentType || 'general-purpose',
        cwd: project.path,
        ...(task.model ? { model: task.model } : {}),
      })
      if (res.deny !== undefined || res.agentId === undefined) {
        if (looksLikeLimit(res.deny)) {
          await onLimitFailure($, task.id, res.deny ?? '', 'rate_limit', 0)
          return
        }
        await finish($, task.id, 'failed', res.deny ?? 'The agent did not start.')
        return
      }
      agentToTask.set(res.agentId, task.id)
      await setTask($, task.id, { agentId: res.agentId })
      const early = unclaimed.get(res.agentId)
      if (early) {
        unclaimed.delete(res.agentId)
        await finish($, task.id, early.status, early.answer)
      }
    } catch (err) {
      await finish($, task.id, 'failed', `Could not start the agent: ${String(err)}`)
    }
    return
  }

  const argv = [
    cfg.claudeBin,
    '-p',
    prompt,
    ...splitArgs(cfg.processArgs),
  ]
  argv.push(...processModelArgs(task.model, normalizeEffort(task.effort)))
  let buf = ''
  let flushedAt = 0
  try {
    const stream = $.process.spawn({ argv, cwd: project.path })
    streams.set(task.id, stream as unknown as Handle)
    let code: number | null = null
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        code = step.value.code
        break
      }
      buf = clip(buf + step.value.text, OUTPUT_CAP)
      if (killed.has(task.id)) break
      const now = await $.clock.now()
      if (now - flushedAt > 400) {
        flushedAt = now
        await setTask($, task.id, { output: buf })
      }
    }
    if (killed.has(task.id)) await finish($, task.id, 'killed', buf)
    else if (code !== 0 && looksLikeLimit(buf)) {
      await onLimitFailure($, task.id, buf, 'rate_limit', resetFromText(buf, await $.clock.now()))
    } else await finish($, task.id, code === 0 ? 'done' : 'failed', buf)
  } catch (err) {
    await finish(
      $,
      task.id,
      'failed',
      `${buf}\n\nCould not run "${cfg.claudeBin}": ${String(err)}`,
    )
  }
}
export async function pump($: E) {
  if (isPumping) return
  isPumping = true
  // Agent tasks for the main session to launch, asked for in one message.
  const toAsk: Task[] = []
  try {
    for (;;) {
      const [list, cfg, lim] = await Promise.all([
        getTasks($),
        getSettings($),
        getLimit($),
      ])
      const running = list.filter(t => t.status === 'running').length
      const next = list.find(t => t.status === 'queued')
      if (!next) break
      // Near a usage limit, run fewer at once (standby still takes over at 100%).
      const slow = throttledMax(cfg.maxParallel, cfg.throttleAtPercent ? await usageWindows($) : [], cfg.throttleAtPercent ?? 0, cfg.throttledParallel ?? 2)
      isSlowed = slow.isSlowed
      if (running >= slow.max) break
      if (cfg.isStandbyOnLimit !== false) {
        if (lim.isLimited) break
        // Don't start work the account cannot pay for.
        if (await checkWindows($)) break
      }
      // A task the main session launches starts its clock when its agent
      // starts (onLaunched), not while it waits for the launch.
      const isAsked = next.backend === 'agent' && cfg.agentLaunch !== 'plugin'
      await setTask($, next.id, {
        status: 'running',
        ...(isAsked ? {} : { startedAt: await $.clock.now() }),
      })
      noteTaskRan()
      await markBusy($)
      if (isAsked) toAsk.push({ ...next, status: 'running' })
      else void launch($, { ...next, status: 'running' })
    }
  } finally {
    isPumping = false
  }
  if (toAsk.length) await askLaunches($, toAsk)
  await refreshStatus($)
  await checkIdle($)
}
// ---- Agent tasks launched by the main session -----------------------

/** Asks the main session, in one message, to launch these agent tasks with its Agent tool. */
export async function askLaunches($: E, list: Task[]) {
  const [projs, cfg] = await Promise.all([getProjects($), getSettings($)])
  const now = await $.clock.now()
  const specs: LaunchSpec[] = []
  for (const task of list) {
    const project = projs.find(p => p.id === task.projectId)
    if (!project) {
      await finish($, task.id, 'failed', 'The project of this task no longer exists.')
      continue
    }
    await setTask($, task.id, { launchAskedAt: now, launchAsks: (task.launchAsks ?? 0) + 1 })
    const full = resumedPrompt(await memWithMemory($, project, task, cfg), task.interruptions) + taskReportNote(cfg, task.id)
    // The session dispatched it and has not compacted since: name its prompt, do not repeat it.
    const isKnown = task.isNotify && !task.isFullLaunch && task.contextEpoch === contextEpoch
    const known = isKnown ? splitKnown(full, task.prompt) : undefined
    specs.push({
      id: task.id,
      title: task.title,
      agentType: task.agentType,
      model: task.model,
      effort: normalizeEffort(task.effort),
      folder: project.path,
      prompt: full,
      ...(known ? { known } : {}),
    })
  }
  if (!specs.length) return
  try {
    await $.prompt.submit({ text: launchRequest(specs) })
  } catch {
    // The session may be ending; the check below asks again or gives up.
  }
  scheduleLaunchCheck($)
}

function scheduleLaunchCheck($: E) {
  launchTimer?.cancel()
  launchTimer = $.clock.after(LAUNCH_RETRY_MS, () => void checkLaunches($).catch(() => undefined))
}

/** Asks again for launches that never came, once the main session is idle; fails them after the last ask. */
export async function checkLaunches($: E) {
  launchTimer = undefined
  const list = await getTasks($)
  const waiting = list.filter(t => t.status === 'running' && t.backend === 'agent' && !t.agentId && t.launchAskedAt)
  if (!waiting.length) return
  // A busy session has not read its queued messages yet.
  if (isMainBusyNow()) {
    scheduleLaunchCheck($)
    return
  }
  const now = await $.clock.now()
  const stale = waiting.filter(t => now - (t.launchAskedAt ?? 0) >= LAUNCH_RETRY_MS)
  const again: Task[] = []
  for (const t of stale) {
    if ((t.launchAsks ?? 0) >= LAUNCH_MAX_ASKS) {
      await finish($, t.id, 'failed', `The main session did not launch this task after ${LAUNCH_MAX_ASKS} requests. Retry it, or set Settings: Start agent tasks to "from the plugin".`)
    } else again.push(t)
  }
  if (again.length) await askLaunches($, again)
  else if (waiting.length > stale.length) scheduleLaunchCheck($)
}

/** The agent of a task the main session launched started (or did not). */
export async function onLaunched($: E, task: Task, res: { agentId?: string; deny?: string }) {
  if (res.deny !== undefined || res.agentId === undefined) {
    if (looksLikeLimit(res.deny)) await onLimitFailure($, task.id, res.deny ?? '', 'rate_limit', 0)
    else await finish($, task.id, 'failed', res.deny ?? 'The agent did not start.')
    return
  }
  agentToTask.set(res.agentId, task.id)
  await setTask($, task.id, { agentId: res.agentId, launchAskedAt: undefined, startedAt: await $.clock.now() })
  const early = unclaimed.get(res.agentId)
  if (early) {
    unclaimed.delete(res.agentId)
    await finish($, task.id, early.status, early.answer)
  }
}

export type NewTask = {
  projectId: string
  title: string
  prompt: string
  backend: Backend
  model: string
  agentType: string
  isNotify: boolean
  why?: string
  effort?: string
}

export async function addTasks($: E, specs: NewTask[]): Promise<string[]> {
  const now = await $.clock.now()
  const cfg = await getSettings($)
  const made: Task[] = specs.map(s => {
    // Tasks with no model or effort of their own get the defaults from Settings.
    const model = s.model || cfg.defaultTaskModel || ''
    const effort = s.effort || cfg.defaultTaskEffort || ''
    return {
      ...s,
      model,
      ...(effort ? { effort } : {}),
      ...(s.isNotify ? { contextEpoch } : {}),
      id: uid(),
      status: 'queued' as const,
      output: '',
      createdAt: now,
    }
  })
  await updateTasks($, list => [...list, ...made].slice(-200))
  const projs = await getProjects($)
  await memReady($)
  for (const t of made) {
    await memOnTaskAdded($, t, projs.find(p => p.id === t.projectId)).catch(() => undefined)
  }
  await pump($)
  return made.map(t => t.id)
}
export async function killTask($: E, id: string) {
  const list = await getTasks($)
  const task = list.find(t => t.id === id)
  if (!task || (task.status !== 'queued' && task.status !== 'running')) return
  killed.add(id)
  await setTask($, id, { status: 'killed', endedAt: await $.clock.now() })
  const handle = streams.get(id)
  if (handle) {
    try {
      await handle.return()
    } catch {
      // The child is already gone.
    }
    streams.delete(id)
  }
  if (task.backend === 'agent' && task.agentId) {
    try {
      await $.tool.call({ tool: 'TaskStop', task_id: task.agentId })
    } catch {
      // Already finished, or the stop was refused: the task stays killed.
    }
  }
  await pump($)
}
export async function applySettings($: E, patch: Partial<Settings>) {
  const clean: Partial<Settings> = { ...patch }
  if (clean.maxParallel !== undefined) {
    clean.maxParallel = Math.min(MAX_PARALLEL, Math.max(1, Math.round(Number(clean.maxParallel) || 1)))
  }
  const before = await getSettings($)
  await updateSettings($, x => ({ ...x, ...clean }))
  await saveSettings($)
  await memOnSettings($, before, await getSettings($)).catch(() => undefined)
  await refreshStatus($)
  void pump($)
}
export function describeTask(t: Task, now: number, withOutput: boolean): string {
  const ran = t.startedAt ? fmtDuration((t.endedAt ?? now) - t.startedAt) : '-'
  const isStarting = t.status === 'running' && t.backend === 'agent' && !t.agentId && !!t.launchAskedAt
  const head = `${t.id} [${isStarting ? 'running: waiting for the main session to launch it' : t.status}] ${t.title} (${t.backend}, ${ran})`
  if (!withOutput) return head
  const notes = [
    ...(t.model || t.effort ? [`Model: ${t.model || 'default'}${t.effort ? ` · effort ${t.effort}` : ''}`] : []),
    ...(t.why ? [`Why: ${t.why}`] : []),
    ...(t.outcome ? [`Outcome: ${t.outcome}`] : []),
    ...(t.summary ? [`Summary: ${t.summary}`] : []),
    ...(t.files?.length ? [`Files edited: ${t.files.join(', ')}`] : []),
  ]
  const out = t.output ? clip(t.output, 2000) : '(no output yet)'
  return notes.length ? `${head}\n${notes.join('\n')}\nOutput (tail):\n${out}` : `${head}\n${out}`
}

export async function retryTask($: E, t: Task) {
  return addTasks($, [
    {
      projectId: t.projectId,
      title: t.title,
      prompt: t.prompt,
      backend: t.backend,
      model: t.model,
      agentType: t.agentType,
      isNotify: t.isNotify,
      ...(t.why ? { why: t.why } : {}),
      ...(t.effort ? { effort: t.effort } : {}),
    },
  ])
}

// ---- Session start and the main session's launches ------------------

/** A reload ends a process task's stream, and loses unlaunched asks: sort the tasks out. */
export async function recoverTasks($: E) {
  const list = await getTasks($)
  for (const t of list) {
    if (t.status === 'running' && t.backend === 'process') {
      await setTask($, t.id, {
        status: 'failed',
        endedAt: await $.clock.now(),
        output: `${t.output}\n\n(interrupted by a reload; retry it)`,
      })
    } else if (t.status === 'running' && t.agentId) {
      agentToTask.set(t.agentId, t.id)
    } else if (t.status === 'running' && t.backend === 'agent') {
      // Asked for but not launched before the reload: queue it to be asked again.
      await updateTasks($, l =>
        l.map(x => {
          if (x.id !== t.id) return x
          const { launchAskedAt: _l, launchAsks: _n, startedAt: _s, ...rest } = x
          return { ...rest, status: 'queued' as const }
        }),
      )
    }
  }
}

/** A subagent's turn ended: settle the task it ran, or note the answer for a task not yet claimed. */
export async function onAgentComplete($: E, agentId: string, reason: string, answer: string) {
  try {
    const status: TaskStatus =
      reason === 'answer' ? 'done' : reason === 'aborted' ? 'killed' : 'failed'
    const id = agentToTask.get(agentId)
    // An error, or a short answer that is a limit message: maybe out of tokens.
    const isMaybeLimit =
      reason === 'error' ||
      (reason === 'answer' && answer.length < 600 && looksLikeLimit(answer))
    if (id && isMaybeLimit) {
      agentToTask.delete(agentId)
      $.clock.after(1500, () => void settleAgentError($, id, agentId, answer, 'failed'))
    } else if (id) {
      agentToTask.delete(agentId)
      await finish($, id, status, answer)
    } else {
      const list = await getTasks($)
      const hit = list.find(
        t => t.agentId === agentId && t.status === 'running',
      )
      if (hit) await finish($, hit.id, status, answer)
      else unclaimed.set(agentId, { answer, status })
    }
  } catch {
    // Never let the dashboard disturb a subagent's own completion.
  }
}

export type LaunchGate =
  | { kind: 'pass' }
  | { kind: 'deny'; deny: string }
  | { kind: 'go'; task: Task; project: Project }

/**
 * The session's Agent call described `orch-<id> ...` starts that task: say
 * whether to let it through untouched, refuse it, or run it in the project's folder.
 */
export async function gateLaunch(
  $: E,
  e: {
    description?: string
    prompt: string
    parentAgentId?: unknown
    resume?: unknown
    workflow?: unknown
    isTeammate?: unknown
  },
): Promise<LaunchGate> {
  const m = LAUNCH_TAG.exec(e.description ?? '')
  if (!m || e.parentAgentId || e.resume || e.workflow || e.isTeammate) return { kind: 'pass' }
  const task = (await getTasks($)).find(t => t.id === m[1])
  if (!task || task.backend !== 'agent') return { kind: 'pass' }
  if (task.status !== 'running' || task.agentId) {
    return { kind: 'deny', deny: `Orchestrator task ${task.id} is not waiting to start (it is ${task.agentId ? 'already running' : task.status}). Do not launch it again.` }
  }
  const project = (await getProjects($)).find(p => p.id === task.projectId)
  if (!project) {
    await finish($, task.id, 'failed', 'The project of this task no longer exists.')
    return { kind: 'deny', deny: `The project of orchestrator task ${task.id} no longer exists.` }
  }
  // A request that named the dispatch prompt: the launch must carry it. If
  // it does not, refuse it and ask again with the prompt in full.
  const wasKnown = task.isNotify && !task.isFullLaunch && task.contextEpoch === contextEpoch
  if (wasKnown && !promptMatches(e.prompt, task.prompt)) {
    reasked.add(task.id)
    await setTask($, task.id, { isFullLaunch: true })
    $.clock.after(500, () => {
      void getTasks($).then(l => {
        const t = l.find(x => x.id === task.id)
        if (t && t.status === 'running' && !t.agentId) void askLaunches($, [t])
      })
    })
    return { kind: 'deny', deny: `The prompt for orchestrator task ${task.id} did not match its dispatch prompt. A new launch request with the full prompt follows; launch from that.` }
  }
  return { kind: 'go', task, project }
}

/** The launch never reached agent.spawn: the person or auto mode refused the Agent call. */
export async function onAgentCallDone($: E, description: unknown, res: unknown) {
  try {
    const r = res as { deny?: string; isError?: boolean; result?: unknown }
    const m = LAUNCH_TAG.exec(String(description ?? ''))
    if (m && (r.deny !== undefined || r.isError)) {
      const task = (await getTasks($)).find(t => t.id === m[1])
      if (task && reasked.delete(task.id)) {
        // Refused on purpose: a full-prompt request is on its way.
      } else if (task && task.status === 'running' && task.backend === 'agent' && !task.agentId) {
        const why = r.deny ?? (typeof r.result === 'string' ? r.result : 'The Agent call failed.')
        await finish($, task.id, 'failed', `The launch was refused: ${why}`)
      }
    }
  } catch {
    // Best effort: the launch check still settles a task that never started.
  }
}
