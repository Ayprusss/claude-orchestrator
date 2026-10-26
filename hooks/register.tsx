import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  OrchBackend as Backend,
  OrchDraft as Draft,
  OrchHud as HudState,
  OrchLimit as LimitState,
  OrchProject as Project,
  OrchSettings as Settings,
  OrchTab as Tab,
  OrchTask as Task,
  OrchStatus as TaskStatus,
  OrchView as View,
} from '../types'
import { buildDiff } from './diffs'
import { DOCS } from './docs'
import * as hud from './hud'
import type { HudCommand } from './hud'
import { LAUNCH_TAG, launchRequest } from './launch'
import type { LaunchSpec } from './launch'
import { DEFAULT_MEMORY_SETTINGS } from './memory/contract'
import {
  afterCompact as memAfterCompact,
  beforeCompact as memBeforeCompact,
  captureTask as memCaptureTask,
  clearProject as memClearProject,
  composeSection as memComposeSection,
  consolidateNow as memConsolidateNow,
  deleteFact as memDeleteFact,
  ensureStarted as memEnsureStarted,
  forget as memForget,
  keepFact as memKeepFact,
  memoryProjects as memMemoryProjects,
  memoryRead as memMemoryRead,
  memorySearch as memMemorySearch,
  note as memNote,
  onClear as memOnClear,
  onSettings as memOnSettings,
  onTaskAdded as memOnTaskAdded,
  onTaskStatus as memOnTaskStatus,
  recordEdit as memRecordEdit,
  remember as memRemember,
  resumePending as memResumePending,
  saveNow as memSaveNow,
  setMemoryView as memSetMemoryView,
  tabData as memTabData,
  withMemory as memWithMemory,
} from './memory/harness'
import { memorySettingsRows, memoryTab } from './memory/pane'
import {
  NO_LIMIT,
  RECHECK_MS,
  RESUME_GRACE_MS,
  blockingWindow,
  isLimitError,
  looksLikeLimit,
  resetFromText,
  resumedPrompt,
  windowName,
  windowsForHud,
} from './limits'

type E = EngineInterface

const PANE = 'orchestrator'
const OUTPUT_CAP = 8000
const MAX_PARALLEL = 16
const TOOL = 'mcp__orchestrator__'

const DEFAULT_SETTINGS: Settings = {
  maxParallel: 3,
  claudeBin: 'claude',
  processArgs: '--permission-mode acceptEdits',
  isStandbyOnLimit: true,
  isDiffViewOn: true,
  isPingOn: true,
  agentLaunch: 'session',
  isHudPermissionsOn: true,
  hudPermissionWaitSec: 60,
  ...DEFAULT_MEMORY_SETTINGS,
}
const DEFAULT_VIEW: View = { tab: 'sessions', selected: '', docPage: 'start' }
const DEFAULT_DRAFT: Draft = {
  title: '',
  prompt: '',
  projectId: '',
  backend: 'agent',
  model: '',
  agentType: 'general-purpose',
  isBatch: false,
  projName: '',
  projPath: '',
}

// Change a tag when the fields of its value change: an older value then reads
// as the initial one instead of meeting code that does not know it.
const projects = atom(
  { plugin: 'orchestrator', key: 'projects' } as const,
  [] as Project[],
  { shape: 'orch-projects-1' },
)
const tasks = atom(
  { plugin: 'orchestrator', key: 'tasks' } as const,
  [] as Task[],
  { shape: 'orch-tasks-4' },
)
const settings = atom(
  { plugin: 'orchestrator', key: 'settings' } as const,
  DEFAULT_SETTINGS,
  { shape: 'orch-settings-7' },
)
const view = atom(
  { plugin: 'orchestrator', key: 'view' } as const,
  DEFAULT_VIEW,
  { shape: 'orch-view-2' },
)
const draft = atom(
  { plugin: 'orchestrator', key: 'draft' } as const,
  DEFAULT_DRAFT,
  { shape: 'orch-draft-1' },
)
const hudState = atom(
  { plugin: 'orchestrator', key: 'hud' } as const,
  { isOn: false } as HudState,
  { shape: 'orch-hud-1' },
)
const limitState = atom(
  { plugin: 'orchestrator', key: 'limit' } as const,
  NO_LIMIT as LimitState,
  { shape: 'orch-limit-1' },
)

// Text the HUD submitted, so its prompt.submit can be told apart from a typed one.
const hudPrompts = new Set<string>()
const HUD_CONTEXT =
  'This message was sent from the Orchestrator HUD, a visual and voice dashboard. ' +
  'Your reply is shown there and may be read aloud: keep it short and conversational, ' +
  'lead with the answer, and avoid tables and long code blocks. To start work that ' +
  `runs in parallel, use the ${'mcp__orchestrator__'}dispatch tool.`
// Live handles. A reload starts these over; the task records stay.
type Handle = { return: (value?: never) => Promise<unknown> }
const streams = new Map<string, Handle>()
const killed = new Set<string>()
const agentToTask = new Map<string, string>()
const unclaimed = new Map<string, { answer: string; status: TaskStatus }>()
let isPumping = false
// Agents that StopFailure reported out of tokens, claimed at their turn.complete.
const limitedAgents = new Set<string>()
let recheckTimer: { cancel: () => void } | undefined
// After a hand-made resume, a stale 100% reading must not undo it at once.
let windowsIgnoredUntil = 0

// "All work done": the main session idle and no task running or queued.
let isMainBusy = false
let busySince = 0 // when the current stretch of work began; 0 while idle
let hadTask = false // a task ran in this stretch
let idleTimer: { cancel: () => void } | undefined
let platform: 'windows' | 'mac' | 'linux' | undefined
// A task's end wakes the main session a moment later: wait that out before calling it done.
const PING_SETTLE_MS = 3000
// A quick reply with no tasks is not "work" worth a ping.
const QUICK_TURN_MS = 15_000

// Agent tasks the main session launches (agentLaunch 'session'): see launch.ts.
// Ask again when a launch has not come this long after asking, while the
// main session is idle; give up after this many asks.
const LAUNCH_RETRY_MS = 3 * 60_000
const LAUNCH_MAX_ASKS = 3
let launchTimer: { cancel: () => void } | undefined

const uid = () => Math.random().toString(36).slice(2, 8)
const clip = (text: string, cap: number) =>
  text.length > cap ? text.slice(text.length - cap) : text
const splitArgs = (text: string) => text.split(/\s+/).filter(Boolean)
const nameOf = (path: string) =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
// POSIX (/home/me), Windows drive (C:\code or C:/code) or UNC (\\host\share).
const isAbsPath = (path: string) =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

const GLYPH: Record<TaskStatus, string> = {
  queued: '.',
  running: '>',
  done: '+',
  failed: 'x',
  killed: '-',
}
const COLOR: Record<TaskStatus, string> = {
  queued: 'gray',
  running: 'yellow',
  done: 'green',
  failed: 'red',
  killed: 'gray',
}

async function setTask($: E, id: string, patch: Partial<Task>) {
  await update($, tasks, list =>
    list.map(t => (t.id === id ? { ...t, ...patch } : t)),
  )
  if (patch.status) await memOnTaskStatus($, id, patch.status).catch(() => undefined)
}

const isLimitedNow = ($: E) => async () => (await read($, limitState)).isLimited

/** Memory starts at session.start, or at first use when no surface was there yet. */
async function memReady($: E) {
  try {
    await memEnsureStarted($, await read($, settings))
  } catch {
    // Memory stays off; the orchestrator works without it.
  }
}

async function refreshStatus($: E) {
  const list = await read($, tasks)
  const run = list.filter(t => t.status === 'running').length
  const wait = list.filter(t => t.status === 'queued').length
  const lim = await read($, limitState)
  if (lim.isLimited) {
    $.ui.status(`orch: usage limit, standby (${run} running, ${wait} queued)`)
    return
  }
  $.ui.status(run + wait === 0 ? undefined : `orch: ${run} running, ${wait} queued`)
}

async function saveProjects($: E) {
  await $.store.set('projects', await read($, projects))
}
async function saveSettings($: E) {
  await $.store.set('settings', await read($, settings))
}

async function finish(
  $: E,
  id: string,
  status: TaskStatus,
  output?: string,
) {
  const list = await read($, tasks)
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
    const settled = (await read($, tasks)).find(t => t.id === id)
    const project = (await read($, projects)).find(p => p.id === task.projectId)
    if (settled) {
      memCaptureTask($, settled, project, await read($, settings), {
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

async function launch($: E, task: Task) {
  const [projs, cfg] = await Promise.all([read($, projects), read($, settings)])
  const project = projs.find(p => p.id === task.projectId)
  if (!project) {
    await finish($, task.id, 'failed', 'The project of this task no longer exists.')
    return
  }

  const prompt = resumedPrompt(await memWithMemory($, project, task, cfg), task.interruptions)
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
  if (task.model) argv.push('--model', task.model)
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

async function pump($: E) {
  if (isPumping) return
  isPumping = true
  // Agent tasks for the main session to launch, asked for in one message.
  const toAsk: Task[] = []
  try {
    for (;;) {
      const [list, cfg, lim] = await Promise.all([
        read($, tasks),
        read($, settings),
        read($, limitState),
      ])
      const running = list.filter(t => t.status === 'running').length
      const next = list.find(t => t.status === 'queued')
      if (!next || running >= cfg.maxParallel) break
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
      hadTask = true
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
async function askLaunches($: E, list: Task[]) {
  const [projs, cfg] = await Promise.all([read($, projects), read($, settings)])
  const now = await $.clock.now()
  const specs: LaunchSpec[] = []
  for (const task of list) {
    const project = projs.find(p => p.id === task.projectId)
    if (!project) {
      await finish($, task.id, 'failed', 'The project of this task no longer exists.')
      continue
    }
    await setTask($, task.id, { launchAskedAt: now, launchAsks: (task.launchAsks ?? 0) + 1 })
    specs.push({
      id: task.id,
      title: task.title,
      agentType: task.agentType,
      model: task.model,
      folder: project.path,
      prompt: resumedPrompt(await memWithMemory($, project, task, cfg), task.interruptions),
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
async function checkLaunches($: E) {
  launchTimer = undefined
  const list = await read($, tasks)
  const waiting = list.filter(t => t.status === 'running' && t.backend === 'agent' && !t.agentId && t.launchAskedAt)
  if (!waiting.length) return
  // A busy session has not read its queued messages yet.
  if (isMainBusy) {
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
async function onLaunched($: E, task: Task, res: { agentId?: string; deny?: string }) {
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

// ---- The all-done ping ----------------------------------------------

async function markBusy($: E) {
  idleTimer?.cancel()
  idleTimer = undefined
  if (!busySince) busySince = await $.clock.now()
}

/** Once nothing is left to do, wait a beat, then ping if work was done. */
async function checkIdle($: E) {
  if (isMainBusy || !busySince) return
  const list = await read($, tasks)
  if (list.some(t => t.status === 'running' || t.status === 'queued')) return
  idleTimer?.cancel()
  idleTimer = $.clock.after(PING_SETTLE_MS, () => void settleIdle($))
}

async function settleIdle($: E) {
  idleTimer = undefined
  const list = await read($, tasks)
  if (isMainBusy || !busySince || list.some(t => t.status === 'running' || t.status === 'queued')) return
  const now = await $.clock.now()
  const isWork = hadTask || now - busySince >= QUICK_TURN_MS
  busySince = 0
  hadTask = false
  if (!isWork || (await read($, settings)).isPingOn === false) return
  hud.event({ type: 'msg', role: 'system', text: 'All work complete.', status: 'allclear', at: now })
  hud.event({ type: 'ping' })
  await playPing($)
}

/** Plays assets/ping.wav with the platform's own player. */
async function playPing($: E) {
  try {
    if (!platform) {
      if ((await $.env.get('OS')) === 'Windows_NT') platform = 'windows'
      else {
        const r = await $.process.run(['uname'], { timeoutMs: 5000 })
        platform = r.stdout.trim() === 'Darwin' ? 'mac' : 'linux'
      }
    }
    const wav = `${$.plugin.root}/assets/ping.wav`
    if (platform === 'windows') {
      // $.audio.play has no player on Windows terminals; .NET's SoundPlayer does.
      const path = wav.replace(/\//g, '\\').replace(/'/g, "''")
      await $.process.run(
        ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${path}').PlaySync()`],
        { timeoutMs: 15_000 },
      )
    } else if (platform === 'mac') {
      await $.audio.play({ asset: 'assets/ping.wav' })
    } else {
      const r = await $.process.run(['paplay', wav], { timeoutMs: 15_000 }).catch(() => undefined)
      if (!r || r.exitCode !== 0) await $.process.run(['aplay', '-q', wav], { timeoutMs: 15_000 })
    }
  } catch {
    // No player on this machine: the HUD still shows it.
  }
}


type NewTask = {
  projectId: string
  title: string
  prompt: string
  backend: Backend
  model: string
  agentType: string
  isNotify: boolean
  why?: string
}

async function addTasks($: E, specs: NewTask[]): Promise<string[]> {
  const now = await $.clock.now()
  const made: Task[] = specs.map(s => ({
    ...s,
    id: uid(),
    status: 'queued',
    output: '',
    createdAt: now,
  }))
  await update($, tasks, list => [...list, ...made].slice(-200))
  const projs = await read($, projects)
  await memReady($)
  for (const t of made) {
    await memOnTaskAdded($, t, projs.find(p => p.id === t.projectId)).catch(() => undefined)
  }
  await pump($)
  return made.map(t => t.id)
}

async function killTask($: E, id: string) {
  const list = await read($, tasks)
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

// ---- Usage limit: standby -------------------------------------------

async function usageWindows($: E) {
  try {
    return (await $.session.usage()).rateLimits
  } catch {
    return []
  }
}

/** Enters standby if a usage window is used up; true when it is. */
async function checkWindows($: E): Promise<boolean> {
  const now = await $.clock.now()
  if (now < windowsIgnoredUntil) return false
  const w = blockingWindow(await usageWindows($), now)
  if (!w) return false
  await enterLimit($, w.kind, w.until, `${windowName(w.kind)} limit used up`)
  return true
}

function scheduleRecheck($: E, delayMs: number) {
  recheckTimer?.cancel()
  // Long waits are taken in steps, so a sleeping laptop catches up on wake.
  const ms = Math.min(Math.max(5000, delayMs), 30 * 60_000)
  recheckTimer = $.clock.after(ms, () => void recheck($).catch(() => scheduleRecheck($, RECHECK_MS)))
}

async function enterLimit($: E, kind: string, until: number, reason: string) {
  const now = await $.clock.now()
  const cur = await read($, limitState)
  const next: LimitState = {
    isLimited: true,
    since: cur.isLimited ? cur.since : now,
    until: until || (cur.isLimited ? cur.until : 0),
    kind: until || !cur.isLimited ? kind : cur.kind,
    reason,
  }
  await update($, limitState, () => next)
  scheduleRecheck($, next.until ? next.until - now + RESUME_GRACE_MS : RECHECK_MS)
  if (!cur.isLimited) {
    const cfg = await read($, settings)
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

async function exitLimit($: E, text = 'Usage limit lifted. Resuming operations.') {
  const cur = await read($, limitState)
  recheckTimer?.cancel()
  recheckTimer = undefined
  if (!cur.isLimited) return
  await update($, limitState, () => NO_LIMIT)
  hud.event({ type: 'msg', role: 'system', text, status: 'resume', at: await $.clock.now() })
  void $.ui.toast(text)
  await pump($)
  void memResumePending($, await read($, settings), isLimitedNow($)).catch(() => undefined)
}

/** At the reset time (or periodically when it is unknown), see if tokens are back. */
async function recheck($: E) {
  const cur = await read($, limitState)
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
  await update($, limitState, x => ({ ...x, until: w?.until ?? 0, kind: w?.kind ?? x.kind }))
  scheduleRecheck($, w ? w.until - now + RESUME_GRACE_MS : RECHECK_MS)
}

/** Sends a cut-off task back to the queue to run again after the reset. */
async function requeue($: E, id: string, output: string) {
  const task = (await read($, tasks)).find(t => t.id === id)
  if (!task || task.status === 'killed') return
  streams.delete(id)
  if (task.agentId) agentToTask.delete(task.agentId)
  const note = '[standby] Cut off by a usage limit; it runs again when the limit resets.'
  await update($, tasks, list =>
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
async function onLimitFailure($: E, id: string, output: string, kind: string, until: number) {
  const w = blockingWindow(await usageWindows($), await $.clock.now())
  await enterLimit($, w?.kind ?? kind, w?.until ?? until, 'a task ran out of tokens')
  if ((await read($, settings)).isStandbyOnLimit !== false) await requeue($, id, output)
  else await finish($, id, 'failed', output)
}

/**
 * An agent task ended on an error. StopFailure, which says whether it was a
 * usage limit, may come just after turn.complete, so this runs a beat later.
 */
async function settleAgentError($: E, id: string, agentId: string, answer: string, status: TaskStatus) {
  const now = await $.clock.now()
  const w = blockingWindow(await usageWindows($), now)
  const isLimit = limitedAgents.delete(agentId) || !!w || looksLikeLimit(answer)
  if (isLimit) await onLimitFailure($, id, answer, 'rate_limit', resetFromText(answer, now))
  else await finish($, id, status, answer)
}

// The person's call: if tokens are still out, the next failure re-enters standby.
async function resumeByHand($: E) {
  windowsIgnoredUntil = (await $.clock.now()) + 2 * 60_000
  await exitLimit($, 'Standby lifted by hand. Resuming operations.')
}

async function applySettings($: E, patch: Partial<Settings>) {
  const clean: Partial<Settings> = { ...patch }
  if (clean.maxParallel !== undefined) {
    clean.maxParallel = Math.min(MAX_PARALLEL, Math.max(1, Math.round(Number(clean.maxParallel) || 1)))
  }
  const before = await read($, settings)
  await update($, settings, x => ({ ...x, ...clean }))
  await saveSettings($)
  await memOnSettings($, before, await read($, settings)).catch(() => undefined)
  await refreshStatus($)
  void pump($)
}

// ---- Code changes for the HUD --------------------------------------

/** An agent task's edit, for its project memory's list of files. */
function recordTaskEdit(input: Record<string, unknown>, res: unknown) {
  const r = res as { deny?: string; isError?: boolean }
  if (r.deny !== undefined || r.isError) return
  const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
  if (agentId) memRecordEdit(agentToTask.get(agentId), input.file_path)
}

/** Sends the diff of a finished Edit or Write call to the HUD, tagged with its agent. */
async function reportDiff(
  $: E,
  tool: 'Edit' | 'Write',
  input: Record<string, unknown>,
  res: unknown,
) {
  try {
    const r = res as { deny?: string; isError?: boolean; result?: unknown }
    if (r.deny !== undefined || r.isError) return
    const diff = buildDiff(tool, input, r.result)
    if (!diff) return
    const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
    let taskId = agentId ? agentToTask.get(agentId) : undefined
    if (agentId && !taskId) taskId = (await read($, tasks)).find(t => t.agentId === agentId)?.id
    hud.event({
      type: 'diff',
      id: uid(),
      agentId: agentId ?? null,
      taskId: taskId ?? null,
      ...diff,
      at: await $.clock.now(),
    })
  } catch {
    // The view is best effort; the edit itself already happened.
  }
}

async function resolveProject(
  $: E,
  ref: string,
): Promise<Project | undefined> {
  const list = await read($, projects)
  const key = ref.trim().toLowerCase()
  const hit = list.find(
    p => p.id === ref || p.name.toLowerCase() === key || p.path === ref.trim(),
  )
  if (hit) return hit
  if (isAbsPath(ref.trim())) {
    const made: Project = { id: uid(), name: nameOf(ref), path: ref.trim() }
    await update($, projects, l => [...l, made])
    await saveProjects($)
    return made
  }
  return undefined
}

function describeTask(t: Task, now: number, withOutput: boolean): string {
  const ran = t.startedAt ? fmtDuration((t.endedAt ?? now) - t.startedAt) : '-'
  const isStarting = t.status === 'running' && t.backend === 'agent' && !t.agentId && !!t.launchAskedAt
  const head = `${t.id} [${isStarting ? 'running: waiting for the main session to launch it' : t.status}] ${t.title} (${t.backend}, ${ran})`
  if (!withOutput) return head
  const notes = [
    ...(t.why ? [`Why: ${t.why}`] : []),
    ...(t.outcome ? [`Outcome: ${t.outcome}`] : []),
    ...(t.summary ? [`Summary: ${t.summary}`] : []),
    ...(t.files?.length ? [`Files edited: ${t.files.join(', ')}`] : []),
  ]
  const out = t.output ? clip(t.output, 2000) : '(no output yet)'
  return notes.length ? `${head}\n${notes.join('\n')}\nOutput (tail):\n${out}` : `${head}\n${out}`
}

async function retryTask($: E, t: Task) {
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
    },
  ])
}

// ---- HUD --------------------------------------------------------------

async function hudSnapshot($: E) {
  const [list, projs, cfg, lim, windows] = await Promise.all([
    read($, tasks),
    read($, projects),
    read($, settings),
    read($, limitState),
    usageWindows($),
  ])
  const projectName = (id: string) => projs.find(p => p.id === id)?.name ?? 'missing'
  return {
    now: await $.clock.now(),
    maxParallel: cfg.maxParallel,
    maxParallelCap: MAX_PARALLEL,
    isStandbyOnLimit: cfg.isStandbyOnLimit !== false,
    isDiffViewOn: cfg.isDiffViewOn !== false,
    isPingOn: cfg.isPingOn !== false,
    limit: lim,
    usage: windowsForHud(windows),
    projects: projs.map(p => ({ id: p.id, name: p.name, path: p.path })),
    tasks: list.slice(-60).map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      backend: t.backend,
      model: t.model,
      projectId: t.projectId,
      project: projectName(t.projectId),
      interruptions: t.interruptions ?? 0,
      prompt: clip(t.prompt, 600),
      output: clip(t.output, 1500),
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
    })),
  }
}

async function onHudCommand($: E, cmd: HudCommand) {
  const toast = (text: string, level = 'info') => hud.event({ type: 'toast', text, level })
  const list = await read($, tasks)
  switch (cmd.type) {
    case 'chat': {
      const text = String(cmd.text ?? '').trim().slice(0, 8000)
      if (!text) return
      hudPrompts.add(text)
      // Resolves when the turn starts, which waits for an idle session.
      void $.prompt.submit({ text }).catch(err => {
        hudPrompts.delete(text)
        toast(`Could not send: ${String(err)}`, 'error')
      })
      return
    }
    case 'dispatch': {
      const projs = await read($, projects)
      const project = projs.find(p => p.id === cmd.projectId)
      const prompt = String(cmd.prompt ?? '').trim()
      if (!project) return toast('Pick a project first.', 'error')
      if (!prompt) return toast('Write a prompt first.', 'error')
      await addTasks($, [
        {
          projectId: project.id,
          title: String(cmd.title ?? '').trim() || prompt.slice(0, 40),
          prompt,
          backend: cmd.backend === 'process' ? 'process' : 'agent',
          model: String(cmd.model ?? '').trim(),
          agentType: 'general-purpose',
          isNotify: false,
        },
      ])
      return toast(`Queued in ${project.name}.`)
    }
    case 'kill':
      return killTask($, cmd.id)
    case 'retry': {
      const t = list.find(x => x.id === cmd.id)
      if (t && t.status !== 'running' && t.status !== 'queued') await retryTask($, t)
      return
    }
    case 'remove':
      await update($, tasks, l => l.filter(t => t.id !== cmd.id || t.status === 'running'))
      return
    case 'clear':
      await update($, tasks, l =>
        l.filter(t => t.status === 'running' || t.status === 'queued'),
      )
      return
    case 'settings': {
      const patch: Partial<Settings> = {}
      if (typeof cmd.maxParallel === 'number') patch.maxParallel = cmd.maxParallel
      if (typeof cmd.isStandbyOnLimit === 'boolean') patch.isStandbyOnLimit = cmd.isStandbyOnLimit
      if (typeof cmd.isDiffViewOn === 'boolean') patch.isDiffViewOn = cmd.isDiffViewOn
      if (typeof cmd.isPingOn === 'boolean') patch.isPingOn = cmd.isPingOn
      await applySettings($, patch)
      return toast('Settings saved.')
    }
    case 'resume':
      return resumeByHand($)
    case 'ping':
      // The settings page's "test" button.
      hud.event({ type: 'ping', isTest: true })
      return playPing($)
  }
}

// The server is a child for the session's life: the loop that reads its
// output is its life, and a reload kills it (the hud atom restarts it).
let hudChild: Handle | undefined
let hudStarting: Promise<number> | undefined
let hudTicker: { cancel: () => void } | undefined
let hudTicks = 0
let isHudFlushing = false

async function hudPost($: E, path: string, body?: unknown) {
  return $.http.fetch(`http://127.0.0.1:${hud.link.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-token': hud.link.token },
    body: body === undefined ? '' : JSON.stringify(body),
  })
}

async function hudTick($: E) {
  if (isHudFlushing || !hud.isUp()) return
  isHudFlushing = true
  try {
    hudTicks++
    if (hudTicks % hud.SNAPSHOT_EVERY === 0) {
      hud.offerSnapshot(await hudSnapshot($), await $.clock.now())
    }
    const batch = hud.drain()
    if (batch.length === 0) return
    await hudPost($, '/api/push', batch)
    hud.pushed(await $.clock.now())
  } catch {
    // The server is restarting or gone; its read loop notices the exit.
  } finally {
    isHudFlushing = false
  }
}

async function hudToken($: E): Promise<string> {
  // Kept across sessions, so an open tab reconnects after a reload.
  const stored = await $.store.get('hudToken')
  if (hud.isToken(stored)) return stored
  const made = hud.makeToken()
  await $.store.set('hudToken', made)
  return made
}

function startHudServer($: E): Promise<number> {
  if (hud.isUp()) return Promise.resolve(hud.link.port)
  if (hudStarting) return hudStarting

  const starting = (async () => {
    hud.link.token = await hudToken($)
    const stream = $.process.spawn({
      argv: [
        'node',
        `${$.plugin.root}/web/server.mjs`,
        '--port',
        String(hud.PREFERRED_PORT),
        '--token',
        hud.link.token,
      ],
    })
    hudChild = stream as unknown as Handle

    return new Promise<number>((resolve, reject) => {
      let err = ''
      let isSettled = false
      const settle = (fn: () => void) => {
        if (!isSettled) {
          isSettled = true
          fn()
        }
      }
      const timer = $.clock.after(hud.READY_TIMEOUT_MS, () =>
        settle(() => reject(new Error(`The HUD server did not start. ${err.trim()}`))),
      )
      const lines = hud.lineReader()

      void (async () => {
        try {
          for await (const piece of stream) {
            if (piece.stream === 'stderr') {
              err = (err + piece.text).slice(-2000)
              continue
            }
            for (const line of lines(piece.text)) {
              const msg = hud.parseLine(line)
              if (!msg) continue
              if ('ready' in msg) {
                hud.connected(msg.ready)
                hudTicker?.cancel()
                hudTicker = $.clock.every(hud.TICK_MS, () => void hudTick($))
                timer.cancel()
                settle(() => resolve(msg.ready))
              } else {
                try {
                  await onHudCommand($, msg.command)
                } catch (e) {
                  hud.event({ type: 'toast', text: `Command failed: ${String(e)}`, level: 'error' })
                }
              }
            }
          }
        } catch (e) {
          err += String(e)
        } finally {
          hud.disconnected()
          hudChild = undefined
          hudStarting = undefined
          hudTicker?.cancel()
          hudTicker = undefined
          timer.cancel()
          settle(() =>
            reject(
              new Error(
                `The HUD server exited. ${err.trim() || 'Is Node.js installed and on PATH?'}`,
              ),
            ),
          )
        }
      })()
    })
  })()

  hudStarting = starting
  // A failed start must not stick: the next call tries again.
  starting.catch(() => {
    if (hudStarting === starting) hudStarting = undefined
  })
  return starting
}

async function stopHud() {
  const child = hudChild
  hudChild = undefined
  if (!child) return
  try {
    await child.return()
  } catch {
    // Already gone.
  }
}

async function startHud($: E, isOpening: boolean): Promise<string> {
  await update($, hudState, () => ({ isOn: true }))
  await startHudServer($)
  if (isOpening) {
    let isOpened = false
    try {
      const res = await hudPost($, '/api/open')
      isOpened = res.ok && (JSON.parse(res.text) as { ok?: boolean }).ok === true
    } catch {
      // Fall through to the link.
    }
    if (!isOpened) return `HUD running. Open ${hud.hudUrl()} in your browser.`
  }
  return `HUD running at ${hud.hudUrl()}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orchestrator',
      description: 'Open the orchestrator dashboard pane',
    })
    await $.command.register({
      name: 'orchestrator-hud',
      description: 'Open the orchestrator HUD in your browser (add "stop" to shut it down)',
    })

    // Projects and settings outlive the session.
    const storedProjects = await $.store.get('projects')
    if (Array.isArray(storedProjects) && (await read($, projects)).length === 0) {
      await update($, projects, () => storedProjects as Project[])
    }
    const storedSettings = await $.store.get('settings')
    if (storedSettings && typeof storedSettings === 'object') {
      await update($, settings, () => ({
        ...DEFAULT_SETTINGS,
        ...(storedSettings as Partial<Settings>),
      }))
    }

    // A reload ends a process task's stream: it cannot be resumed.
    const list = await read($, tasks)
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
        await update($, tasks, l =>
          l.map(x => {
            if (x.id !== t.id) return x
            const { launchAskedAt: _l, launchAsks: _n, startedAt: _s, ...rest } = x
            return { ...rest, status: 'queued' as const }
          }),
        )
      }
    }

    await $.tool.register({
      name: 'dispatch',
      isDeferred: false,
      description:
        'Queue a task on the orchestrator dashboard. It runs as its own Claude session in the given project, in parallel with other tasks (up to the dashboard limit). Returns the task id. For an agent task, when it can start you get an [orchestrator] message asking you to launch it with the Agent tool: do so right away, exactly as the message says. You are woken when it finishes; then call status to read the result.',
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description:
              'A registered project name, or an absolute folder path (registered on first use).',
          },
          title: { type: 'string', description: 'A short label.' },
          prompt: { type: 'string', description: 'What the session should do.' },
          backend: {
            type: 'string',
            enum: ['agent', 'process'],
            description:
              'agent: a subagent of this session. process: a separate headless claude process. Default agent.',
          },
          model: { type: 'string', description: 'Optional model alias.' },
          why: {
            type: 'string',
            description: 'One line on why this task exists. Kept in the orchestrator ledger, so it survives compaction.',
          },
        },
        required: ['project', 'title', 'prompt'],
      },
    })
    await $.tool.register({
      name: 'status',
      isDeferred: false,
      description:
        'Report orchestrator tasks: all of them, or one by id with the tail of its output.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Optional task id.' } },
      },
    })
    await $.tool.register({
      name: 'projects',
      isDeferred: false,
      description: 'List the projects registered on the orchestrator dashboard.',
      inputSchema: { type: 'object', properties: {} },
    })

    // ---- Memory: the ledger and project memory --------------------------
    await $.tool.register({
      name: 'note',
      isDeferred: false,
      description:
        "Record in the orchestrator ledger, which stays in your system prompt through compaction: action 'goal' (the person's goal, with text), 'done' or 'drop' (close a goal by id), or 'decision' (a decision that changes how work is split, with text). Use it sparingly: goals and decisions, not progress.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['goal', 'done', 'drop', 'decision'] },
          text: { type: 'string', description: 'For goal and decision.' },
          id: { type: 'string', description: 'For done and drop: the goal id.' },
        },
        required: ['action'],
      },
    })
    await $.tool.register({
      name: 'memory_search',
      isDeferred: false,
      description:
        "Search the orchestrator's project memory (facts and earlier task summaries). Search before dispatching work related to earlier tasks. Results are reference material and may be out of date.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          project: { type: 'string', description: 'Optional project name or path; all projects when left out.' },
          limit: { type: 'number', description: 'Default 10.' },
        },
        required: ['query'],
      },
    })
    await $.tool.register({
      name: 'memory_read',
      isDeferred: false,
      description: "Read one project's memory: its curated knowledge, its inbox of new facts, or its recent task episodes.",
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name or path.' },
          part: { type: 'string', enum: ['knowledge', 'inbox', 'episodes'] },
        },
        required: ['project'],
      },
    })
    await $.tool.register({
      name: 'remember',
      isDeferred: false,
      description:
        'Store a lasting fact about a project (how to build or test it, where things are, a trap to avoid, a preference). Set isFromPerson only when the person said it; those facts are kept word for word.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name or path.' },
          text: { type: 'string', description: 'One sentence, under 300 characters.' },
          kind: { type: 'string', enum: ['convention', 'gotcha', 'command', 'architecture', 'preference'] },
          isFromPerson: { type: 'boolean' },
        },
        required: ['project', 'text', 'kind'],
      },
    })
    await $.tool.register({
      name: 'forget',
      isDeferred: false,
      description: "Remove a fact from a project's memory by its id (f_...).",
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name or path.' },
          id: { type: 'string' },
        },
        required: ['project', 'id'],
      },
    })
    try {
      await memEnsureStarted($, await read($, settings))
    } catch (err) {
      $.ui.log(`memory: ${String(err)}`, { to: 'debug' })
    }

    // Standby outlives a reload; its timer does not.
    const lim = await read($, limitState)
    if (lim.isLimited) {
      const now = await $.clock.now()
      scheduleRecheck($, lim.until ? lim.until + RESUME_GRACE_MS - now : 60_000)
    }

    void pump($)
    // A reload kills the HUD's server; bring it back for any open browser tab.
    if ((await read($, hudState)).isOn) {
      void startHud($, false).catch(err => $.ui.log(`HUD: ${String(err)}`, { to: 'debug' }))
    }
    return next(e)
  })

  on('command.run', { command: 'orchestrator' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Orchestrator', focus: true, rows: 22 })
    return { text: 'Orchestrator opened.' }
  })

  on('command.run', { command: 'orchestrator-hud' }, async ($, e) => {
    if (e.args.trim() === 'stop') {
      await update($, hudState, () => ({ isOn: false }))
      await stopHud()
      return { text: 'HUD stopped.' }
    }
    try {
      return { text: await startHud($, true) }
    } catch (err) {
      await update($, hudState, () => ({ isOn: false }))
      return { text: `Could not start the HUD: ${String(err)}` }
    }
  })

  // ---- Mirror the main conversation into the HUD ----------------------

  on('prompt.submit', async ($, e, next) => {
    // Never let the HUD stand between the person and their prompt.
    let isHud = false
    try {
      if (hud.isUp() && !e.command && !e.isMeta) {
        isHud = hudPrompts.delete(e.text)
        const isOrch = e.origin?.kind === 'plugin' && e.text.startsWith('[orchestrator]')
        hud.event({
          type: 'msg',
          role: isOrch ? 'system' : 'user',
          source: isHud ? 'hud' : 'terminal',
          text: e.text,
          at: await $.clock.now(),
        })
      }
    } catch {
      // The mirror is best effort.
    }
    if (isHud) return next({ ...e, context: [...(e.context ?? []), HUD_CONTEXT] })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      hud.setPhase('thinking')
      isMainBusy = true
      try {
        await markBusy($)
        // A surface may attach only after session.start (the desktop app).
        await memEnsureStarted($, await read($, settings))
      } catch {
        // Best effort.
      }
    }
    return next(e)
  })

  // ---- Memory: the ledger in the system prompt ------------------------

  // The ledger snapshot, added last on the session side of the cache
  // boundary. It changes only at start, compaction and /clear.
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e)
    const section = memComposeSection(e.tools)
    return section ? { ...res, sections: [...res.sections, section] } : res
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    let instructions = e.instructions
    try {
      instructions = await memBeforeCompact($, e.instructions)
    } catch {
      // Compact as asked.
    }
    const res = await next({ ...e, ...(instructions === undefined ? {} : { instructions }) })
    if (res.messages) await memAfterCompact($).catch(() => undefined)
    return res
  })

  on('session.end', async ($, e, next) => {
    try {
      await memSaveNow($)
      // /clear goes on under a new session id, and no session.start fires for it.
      if (e.reason === 'clear') $.clock.after(300, () => void memOnClear($).catch(() => undefined))
    } catch {
      // Exits stay fast; the ledger was saved on its last change.
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (!hud.isUp() || e.agentId) return yield* stream
    for await (const chunk of stream) {
      if (chunk.kind === 'text') hud.delta(chunk.text)
      else if (chunk.kind === 'tool') hud.setPhase('tool', chunk.name)
      yield chunk
    }
    return await stream.result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && hud.isUp()) {
      hud.event({
        type: 'msg',
        role: e.reason === 'answer' ? 'assistant' : 'system',
        text:
          e.reason === 'answer'
            ? e.answer
            : e.reason === 'aborted'
              ? 'Interrupted.'
              : `The turn ended: ${e.reason}.`,
        at: await $.clock.now(),
      })
      hud.setPhase('idle')
    }
    if (!e.agentId) {
      isMainBusy = false
      try {
        await checkIdle($)
      } catch {
        // Best effort.
      }
    }
    if (e.agentId) {
      try {
        const status: TaskStatus =
          e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'killed' : 'failed'
        const id = agentToTask.get(e.agentId)
        // An error, or a short answer that is a limit message: maybe out of tokens.
        const isMaybeLimit =
          e.reason === 'error' ||
          (e.reason === 'answer' && e.answer.length < 600 && looksLikeLimit(e.answer))
        if (id && isMaybeLimit) {
          agentToTask.delete(e.agentId)
          const agentId = e.agentId
          const answer = e.answer
          $.clock.after(1500, () => void settleAgentError($, id, agentId, answer, 'failed'))
        } else if (id) {
          agentToTask.delete(e.agentId)
          await finish($, id, status, e.answer)
        } else {
          const list = await read($, tasks)
          const hit = list.find(
            t => t.agentId === e.agentId && t.status === 'running',
          )
          if (hit) await finish($, hit.id, status, e.answer)
          else unclaimed.set(e.agentId, { answer: e.answer, status })
        }
      } catch {
        // Never let the dashboard disturb a subagent's own completion.
      }
    }
    return next(e)
  })

  // ---- Agent tasks the main session launches -------------------------

  // The session's Agent call described `orch-<id> ...` starts that task: run it in
  // the project's folder, in the background, and track it. The prompt is the
  // one the call carries (the one auto mode judged), never swapped.
  on('agent.spawn', async ($, e, next) => {
    const m = LAUNCH_TAG.exec(e.description ?? '')
    if (!m || e.parentAgentId || e.resume || e.workflow || e.isTeammate) return next(e)
    const task = (await read($, tasks)).find(t => t.id === m[1])
    if (!task || task.backend !== 'agent') return next(e)
    if (task.status !== 'running' || task.agentId) {
      return { deny: `Orchestrator task ${task.id} is not waiting to start (it is ${task.agentId ? 'already running' : task.status}). Do not launch it again.` }
    }
    const project = (await read($, projects)).find(p => p.id === task.projectId)
    if (!project) {
      await finish($, task.id, 'failed', 'The project of this task no longer exists.')
      return { deny: `The project of orchestrator task ${task.id} no longer exists.` }
    }
    // The Agent tool takes only model aliases: a task's full model id is set here.
    const res = await next({ ...e, cwd: project.path, background: true, ...(task.model ? { model: task.model } : {}) })
    try {
      await onLaunched($, task, res)
    } catch {
      // The agent runs either way; turn.complete still settles it by agentId.
    }
    return res
  }).catch(($, e, next) =>
    // Skipped, the agent would start in the wrong folder: refuse it instead.
    next.called ? next(e) : { deny: 'The orchestrator could not prepare this launch. Retry the task from the dashboard.' },
  )

  // The launch never reached agent.spawn: the person or auto mode refused the call.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const res = await next(e)
    try {
      const r = res as { deny?: string; isError?: boolean; result?: unknown }
      const m = LAUNCH_TAG.exec(String((e as unknown as Record<string, unknown>).description ?? ''))
      if (m && (r.deny !== undefined || r.isError)) {
        const task = (await read($, tasks)).find(t => t.id === m[1])
        if (task && task.status === 'running' && task.backend === 'agent' && !task.agentId) {
          const why = r.deny ?? (typeof r.result === 'string' ? r.result : 'The Agent call failed.')
          await finish($, task.id, 'failed', `The launch was refused: ${why}`)
        }
      }
    } catch {
      // Best effort: the launch check still settles a task that never started.
    }
    return res
  }).catch(($, e, next) => next(e))

  // ---- Code changes ---------------------------------------------------

  // Every edit, the main session's and each agent's, goes to the HUD's diff view.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const res = await next(e)
    recordTaskEdit(e as unknown as Record<string, unknown>, res)
    if (hud.isUp()) void reportDiff($, 'Edit', e as unknown as Record<string, unknown>, res)
    return res
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const res = await next(e)
    recordTaskEdit(e as unknown as Record<string, unknown>, res)
    if (hud.isUp()) void reportDiff($, 'Write', e as unknown as Record<string, unknown>, res)
    return res
  })

  // ---- Usage limits ---------------------------------------------------

  // A model call died on an API error; rate_limit and billing_error mean no tokens.
  on('classic.StopFailure', async ($, e, next) => {
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
    return next(e)
  })

  // The account's windows moved: enter standby at 100%, leave it once a
  // window that put us there has room again.
  on('session.measure', async ($, e, next) => {
    try {
      if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
        const now = await $.clock.now()
        const w = blockingWindow(e.rateLimits, now)
        const cur = await read($, limitState)
        if (w && now >= windowsIgnoredUntil) {
          await enterLimit($, w.kind, w.until, `${windowName(w.kind)} limit used up`)
        } else if (!w && cur.isLimited && e.rateLimits.some(x => x.kind === cur.kind)) {
          await exitLimit($)
        }
      }
    } catch {
      // Best effort.
    }
    return next(e)
  })

  on('tool.call', { tool: `${TOOL}dispatch` }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const project = await resolveProject($, String(input.project ?? ''))
    if (!project) {
      return {
        result: `Unknown project "${String(input.project)}". Call ${TOOL}projects, or pass an absolute path.`,
      }
    }
    const [id] = await addTasks($, [
      {
        projectId: project.id,
        title: String(input.title ?? 'task'),
        prompt: String(input.prompt ?? ''),
        backend: input.backend === 'process' ? 'process' : 'agent',
        model: typeof input.model === 'string' ? input.model : '',
        agentType: 'general-purpose',
        isNotify: true,
        ...(typeof input.why === 'string' && input.why.trim() ? { why: input.why.trim().slice(0, 200) } : {}),
      },
    ])
    const isAsked = input.backend !== 'process' && (await read($, settings)).agentLaunch !== 'plugin'
    return {
      result: isAsked
        ? `Queued task ${id} in ${project.name}. When it can start, an [orchestrator] message will ask you to launch it with the Agent tool.`
        : `Queued task ${id} in ${project.name}.`,
    }
  })

  on('tool.call', { tool: `${TOOL}status` }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const list = await read($, tasks)
    const now = await $.clock.now()
    if (typeof input.id === 'string' && input.id) {
      const t = list.find(x => x.id === input.id)
      return { result: t ? describeTask(t, now, true) : `No task ${input.id}.` }
    }
    return {
      result: list.length
        ? list.map(t => describeTask(t, now, false)).join('\n')
        : 'No tasks.',
    }
  })

  // ---- Memory tools -----------------------------------------------------

  on('tool.call', { tool: /^mcp__orchestrator__note$/ }, async ($, e) => {
    await memReady($)
    const input = e as unknown as Record<string, unknown>
    const action = input.action
    if (action !== 'goal' && action !== 'done' && action !== 'drop' && action !== 'decision') {
      return { result: "Give action 'goal', 'done', 'drop' or 'decision'." }
    }
    return {
      result: await memNote($, {
        action,
        ...(typeof input.text === 'string' ? { text: input.text } : {}),
        ...(typeof input.id === 'string' ? { id: input.id } : {}),
      }),
    }
  })

  on('tool.call', { tool: /^mcp__orchestrator__memory_search$/ }, async ($, e) => {
    await memReady($)
    const list = await memMemoryProjects($, await read($, projects))
    return { result: await memMemorySearch($, list, e as unknown as Record<string, unknown>) }
  })

  on('tool.call', { tool: /^mcp__orchestrator__memory_read$/ }, async ($, e) => {
    await memReady($)
    const list = await memMemoryProjects($, await read($, projects))
    return { result: await memMemoryRead($, list, e as unknown as Record<string, unknown>) }
  })

  on('tool.call', { tool: /^mcp__orchestrator__remember$/ }, async ($, e) => {
    await memReady($)
    const list = await memMemoryProjects($, await read($, projects))
    return { result: await memRemember($, list, e as unknown as Record<string, unknown>) }
  })

  on('tool.call', { tool: /^mcp__orchestrator__forget$/ }, async ($, e) => {
    await memReady($)
    const list = await memMemoryProjects($, await read($, projects))
    return { result: await memForget($, list, e as unknown as Record<string, unknown>) }
  })

  on('tool.call', { tool: `${TOOL}projects` }, async $ => {
    const list = await read($, projects)
    return {
      result: list.length
        ? list.map(p => `${p.name}: ${p.path}`).join('\n')
        : 'No projects registered.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    // Mobile has neither; `hasForms` keeps them out of its tree.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Input, Select } = $.ui.resolve(e) as unknown as { Input: any; Select: any }
    const hasForms = e.surface !== 'mobile'

    const [v, list, projs, cfg, d] = await Promise.all([
      read($, view),
      read($, tasks),
      read($, projects),
      read($, settings),
      read($, draft),
    ])
    const now = await $.clock.now()
    const isHudOn = (await read($, hudState)).isOn
    const lim = await read($, limitState)
    const room = Math.max(4, (e.viewport?.rows ?? 24) - 8)

    const setTab = (tab: Tab) => update($, view, x => ({ ...x, tab }))
    const setDraft = (patch: Partial<Draft>) =>
      update($, draft, x => ({ ...x, ...patch }))
    const toast = (text: string) => void $.ui.toast(text)

    const tabs: Array<[Tab, string]> = [
      ['sessions', 'Sessions'],
      ['new', 'New'],
      ['projects', 'Projects'],
      ['memory', 'Memory'],
      ['settings', 'Settings'],
      ['docs', 'Docs'],
    ]

    const projectName = (id: string) =>
      projs.find(p => p.id === id)?.name ?? 'missing'

    // ---- Sessions -------------------------------------------------------
    const sessions = () => {
      const count = (s: TaskStatus) => list.filter(t => t.status === s).length
      const selected = list.find(t => t.id === v.selected)
      const rows = [...list].reverse().slice(0, Math.max(3, Math.floor(room / 2)))
      return (
        <Box flexDirection="column">
          {lim.isLimited && (
            <Box>
              <Text color="red" bold>
                USAGE LIMIT{' '}
              </Text>
              <Text color="red">
                {cfg.isStandbyOnLimit === false ? 'reached, standby off' : 'standby'}
                {lim.until ? `, resets in ${fmtDuration(lim.until - now)}` : ', checking every few minutes'}{' '}
              </Text>
              <Button key="resume" plain onPress={() => void resumeByHand($)}>
                [resume now]
              </Button>
            </Box>
          )}
          <Text>
            <Text color="yellow">{count('running')} running</Text>
            {'  '}
            <Text dimColor>{count('queued')} queued</Text>
            {'  '}
            <Text color="green">{count('done')} done</Text>
            {'  '}
            <Text color="red">{count('failed')} failed</Text>
            {'  '}
            <Text dimColor>limit {cfg.maxParallel}</Text>
          </Text>
          {list.length === 0 && (
            <Text dimColor>
              No sessions yet. Open New to queue a task, or ask Claude to dispatch some.
            </Text>
          )}
          {rows.map(t => (
            <Button
              key={`row-${t.id}`}
              plain
              onPress={() => update($, view, x => ({ ...x, selected: t.id }))}
            >
              {t.id === v.selected ? '> ' : '  '}
              <Text color={COLOR[t.status]}>{GLYPH[t.status]}</Text> {t.title}{' '}
              <Text dimColor>
                {projectName(t.projectId)} {t.backend}{' '}
                {t.startedAt ? fmtDuration((t.endedAt ?? now) - t.startedAt) : ''}
              </Text>
            </Button>
          ))}
          {selected && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>
                {selected.title} <Text dimColor>[{selected.status}] {selected.id}</Text>
              </Text>
              <Text dimColor>{clip(selected.prompt, 240)}</Text>
              <Text>
                {selected.output
                  ? selected.output.split('\n').slice(-room).join('\n')
                  : '(no output yet)'}
              </Text>
              <Box>
                {(selected.status === 'running' || selected.status === 'queued') && (
                  <Button key="kill" onPress={() => void killTask($, selected.id)}>
                    Kill
                  </Button>
                )}
                {selected.backend === 'agent' && selected.agentId && (
                  <Button
                    key="open"
                    onPress={() => void $.ui.view({ agentId: selected.agentId })}
                  >
                    Open
                  </Button>
                )}
                {selected.status !== 'running' && selected.status !== 'queued' && (
                  <Button
                    key="retry"
                    onPress={async () => {
                      await retryTask($, selected)
                    }}
                  >
                    Retry
                  </Button>
                )}
                {selected.status !== 'running' && (
                  <Button
                    key="remove"
                    onPress={async () => {
                      await update($, tasks, l => l.filter(t => t.id !== selected.id))
                      await update($, view, x => ({ ...x, selected: '' }))
                    }}
                  >
                    Remove
                  </Button>
                )}
              </Box>
            </Box>
          )}
          {list.some(t => t.status !== 'running' && t.status !== 'queued') && (
            <Button
              key="clear"
              plain
              onPress={() =>
                update($, tasks, l =>
                  l.filter(t => t.status === 'running' || t.status === 'queued'),
                )
              }
            >
              Clear finished
            </Button>
          )}
        </Box>
      )
    }

    // ---- New ------------------------------------------------------------
    const create = () => {
      if (!hasForms) return <Text dimColor>Forms need the terminal or desktop surface.</Text>
      if (projs.length === 0) {
        return (
          <Box flexDirection="column">
            <Text>Add a project first.</Text>
            <Button key="to-projects" onPress={() => setTab('projects')}>
              Go to Projects
            </Button>
          </Box>
        )
      }
      const projectId = d.projectId || projs[0]?.id || ''
      return (
        <Box flexDirection="column">
          <Select
            key="project"
            label="Project"
            value={projectId}
            options={projs.map(p => ({ value: p.id, label: `${p.name}  ${p.path}` }))}
            onSelect={(value: string) => setDraft({ projectId: value })}
          />
          <Select
            key="backend"
            label="Backend"
            value={d.backend}
            options={[
              { value: 'agent', label: 'agent (subagent of this session)' },
              { value: 'process', label: 'process (separate claude -p)' },
            ]}
            onSelect={(value: string) =>
              setDraft({ backend: value === 'process' ? 'process' : 'agent' })
            }
          />
          <Select
            key="mode"
            label="Mode"
            value={d.isBatch ? 'batch' : 'single'}
            options={[
              { value: 'single', label: 'single task' },
              { value: 'batch', label: 'batch (one task per line)' },
            ]}
            onSelect={(value: string) => setDraft({ isBatch: value === 'batch' })}
          />
          {!d.isBatch && (
            <Input
              key="title"
              label="Title"
              placeholder="short label"
              value={d.title}
              onInput={(value: string) => setDraft({ title: value })}
              onSubmit={(value: string) => setDraft({ title: value })}
            />
          )}
          <Input
            key="prompt"
            label={d.isBatch ? 'Prompts (one per line)' : 'Prompt'}
            placeholder="what should the session do?"
            rows={4}
            value={d.prompt}
            onInput={(value: string) => setDraft({ prompt: value })}
            onSubmit={(value: string) => setDraft({ prompt: value })}
          />
          <Input
            key="model"
            label="Model (optional, e.g. haiku, sonnet)"
            value={d.model}
            onInput={(value: string) => setDraft({ model: value })}
            onSubmit={(value: string) => setDraft({ model: value })}
          />
          {d.backend === 'agent' && (
            <Select
              key="agent-type"
              label="Agent type"
              value={d.agentType}
              options={[
                { value: 'general-purpose', label: 'general-purpose' },
                { value: 'Explore', label: 'Explore (read-only search)' },
                { value: 'Plan', label: 'Plan (design only)' },
              ]}
              onSelect={(value: string) => setDraft({ agentType: value })}
            />
          )}
          <Button
            key="queue"
            variant="primary"
            onPress={async () => {
              const lines = d.isBatch
                ? d.prompt.split('\n').map(s => s.trim()).filter(Boolean)
                : [d.prompt.trim()].filter(Boolean)
              if (lines.length === 0) return toast('Write a prompt first.')
              const ids = await addTasks(
                $,
                lines.map(prompt => ({
                  projectId,
                  title: d.isBatch ? prompt.slice(0, 40) : d.title.trim() || prompt.slice(0, 40),
                  prompt,
                  backend: d.backend,
                  model: d.model.trim(),
                  agentType: d.agentType,
                  isNotify: false,
                })),
              )
              await update($, draft, x => ({ ...x, title: '', prompt: '' }))
              await update($, view, x => ({ ...x, tab: 'sessions' as const, selected: ids[0] ?? '' }))
              toast(`Queued ${ids.length} task${ids.length === 1 ? '' : 's'}.`)
            }}
          >
            Queue
          </Button>
        </Box>
      )
    }

    // ---- Projects -------------------------------------------------------
    const projectsTab = () => (
      <Box flexDirection="column">
        {projs.length === 0 && <Text dimColor>No projects yet.</Text>}
        {projs.map(p => (
          <Box key={`proj-${p.id}`}>
            <Text>
              {p.name} <Text dimColor>{p.path}</Text>
            </Text>
            <Button
              key={`rm-${p.id}`}
              plain
              onPress={async () => {
                await update($, projects, l => l.filter(x => x.id !== p.id))
                await saveProjects($)
              }}
            >
              {' '}
              remove
            </Button>
          </Box>
        ))}
        {hasForms ? (
          <Box flexDirection="column" marginTop={1}>
            <Input
              key="proj-name"
              label="Name"
              placeholder="api"
              value={d.projName}
              onInput={(value: string) => setDraft({ projName: value })}
              onSubmit={(value: string) => setDraft({ projName: value })}
            />
            <Input
              key="proj-path"
              label="Absolute folder path"
              placeholder="/home/me/code/api"
              value={d.projPath}
              onInput={(value: string) => setDraft({ projPath: value })}
              onSubmit={(value: string) => setDraft({ projPath: value })}
            />
            <Button
              key="proj-add"
              variant="primary"
              onPress={async () => {
                const path = d.projPath.trim()
                if (!isAbsPath(path)) return toast('Use an absolute path, like /home/me/api or C:\\code\\api.')
                try {
                  await $.fs.stat(path)
                } catch {
                  return toast(`Folder not found: ${path}`)
                }
                const made: Project = {
                  id: uid(),
                  name: d.projName.trim() || nameOf(path),
                  path,
                }
                await update($, projects, l => [...l, made])
                await saveProjects($)
                await setDraft({ projName: '', projPath: '' })
              }}
            >
              Add project
            </Button>
          </Box>
        ) : (
          <Text dimColor>Adding projects needs the terminal or desktop surface.</Text>
        )}
      </Box>
    )

    // ---- Settings -------------------------------------------------------
    const setSettings = (patch: Partial<Settings>) => applySettings($, patch)
    const settingsTab = () =>
      hasForms ? (
        <Box flexDirection="column">
          <Select
            key="max-parallel"
            label="Max parallel sessions"
            value={String(cfg.maxParallel)}
            options={[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16].map(n => ({ value: String(n), label: String(n) }))}
            onSelect={(value: string) => void setSettings({ maxParallel: Number(value) })}
          />
          <Select
            key="agent-launch"
            label="Start agent tasks"
            value={cfg.agentLaunch === 'plugin' ? 'plugin' : 'session'}
            options={[
              { value: 'session', label: 'from the main session (works in auto mode)' },
              { value: 'plugin', label: 'from the plugin (not in auto mode)' },
            ]}
            onSelect={(value: string) => void setSettings({ agentLaunch: value === 'plugin' ? 'plugin' : 'session' })}
          />
          <Select
            key="standby"
            label="When the usage limit is reached"
            value={cfg.isStandbyOnLimit === false ? 'off' : 'on'}
            options={[
              { value: 'on', label: 'standby: hold tasks until the limit resets' },
              { value: 'off', label: 'keep going: tasks fail' },
            ]}
            onSelect={(value: string) => void setSettings({ isStandbyOnLimit: value !== 'off' })}
          />
          <Select
            key="diff-view"
            label="HUD code changes"
            value={cfg.isDiffViewOn === false ? 'off' : 'on'}
            options={[
              { value: 'on', label: 'pop up each change beside its agent' },
              { value: 'off', label: 'list only (open from Comms)' },
            ]}
            onSelect={(value: string) => void setSettings({ isDiffViewOn: value !== 'off' })}
          />
          <Select
            key="ping"
            label="When all work is done"
            value={cfg.isPingOn === false ? 'off' : 'on'}
            options={[
              { value: 'on', label: 'ping' },
              { value: 'off', label: 'stay quiet' },
            ]}
            onSelect={(value: string) => void setSettings({ isPingOn: value !== 'off' })}
          />
          <Input
            key="claude-bin"
            label="Claude binary (process backend)"
            value={cfg.claudeBin}
            onInput={(value: string) => void setSettings({ claudeBin: value })}
            onSubmit={(value: string) => void setSettings({ claudeBin: value })}
          />
          <Input
            key="process-args"
            label="Process args (process backend)"
            value={cfg.processArgs}
            onInput={(value: string) => void setSettings({ processArgs: value })}
            onSubmit={(value: string) => void setSettings({ processArgs: value })}
          />
          {memorySettingsRows({ Box, Text, Button, Select, Input }, cfg, patch => void setSettings(patch))}
          <Button
            key="reset"
            plain
            onPress={() => void setSettings({ ...DEFAULT_SETTINGS })}
          >
            Reset defaults
          </Button>
        </Box>
      ) : (
        <Text dimColor>Settings need the terminal or desktop surface.</Text>
      )

    // ---- Docs -----------------------------------------------------------
    const page = DOCS.find(p => p.id === v.docPage) ?? DOCS[0]!
    // ---- Memory ---------------------------------------------------------
    const memData = v.tab === 'memory' ? await memTabData($, projs) : undefined
    const redraw = () => $.ui.invalidate('ui.render')
    const memoryTabView = () => {
      if (!memData) return null
      const projectOf = (key: string): Project | undefined => {
        const p = memData.projects.find(x => x.key === key)
        return p && p.path ? { id: '', name: p.name, path: p.path } : undefined
      }
      return memoryTab(
        { Box, Text, Button, Select, Input },
        memData,
        {
          setView: patch => void memSetMemoryView($, patch),
          deleteFact: (key, id) => void memDeleteFact($, key, id).then(redraw),
          keepFact: (key, id) => void memKeepFact($, key, id).then(text => (toast(text), redraw())),
          consolidate: key => {
            const project = projectOf(key)
            if (!project) return toast('This project has no folder on record to check facts against.')
            toast('Consolidating…')
            void memConsolidateNow($, key, project, cfg, isLimitedNow($)).then(r => {
              toast(r.status === 'done' ? `Consolidated: ${r.kept} kept, ${r.dropped} dropped, ${r.stale} possibly stale.` : `Not consolidated: ${r.reason}`)
              redraw()
            })
          },
          clearProject: key =>
            void memClearProject($, key).then(text => {
              toast(text)
              void memSetMemoryView($, { selected: '' })
              redraw()
            }),
        },
        { isMemoryOn: cfg.isMemoryOn !== false, hasForms, rows: room },
      )
    }

    const docsTab = () => (
      <Box flexDirection="column">
        <Box>
          {DOCS.map(p => (
            <Button
              key={`doc-${p.id}`}
              plain
              onPress={() => update($, view, x => ({ ...x, docPage: p.id }))}
            >
              {p.id === page.id ? `[${p.title}]` : p.title}{' '}
            </Button>
          ))}
        </Box>
        <Markdown key="doc-body" text={page.body} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          {tabs.map(([id, label]) => (
            <Button key={`tab-${id}`} plain onPress={() => setTab(id)}>
              {v.tab === id ? `[${label}]` : label}{' '}
            </Button>
          ))}
          <Button
            key="tab-hud"
            plain
            onPress={async () => {
              try {
                toast(await startHud($, true))
              } catch (err) {
                toast(`Could not start the HUD: ${String(err)}`)
              }
            }}
          >
            <Text color="cyan">{isHudOn ? 'HUD*' : 'HUD'}</Text>
          </Button>
        </Box>
        {v.tab === 'sessions' && sessions()}
        {v.tab === 'new' && create()}
        {v.tab === 'projects' && projectsTab()}
        {v.tab === 'memory' && memoryTabView()}
        {v.tab === 'settings' && settingsTab()}
        {v.tab === 'docs' && docsTab()}
      </Box>
    )
  })
}
