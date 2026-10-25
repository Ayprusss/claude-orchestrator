import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  OrchBackend as Backend,
  OrchDraft as Draft,
  OrchHud as HudState,
  OrchProject as Project,
  OrchSettings as Settings,
  OrchTab as Tab,
  OrchTask as Task,
  OrchStatus as TaskStatus,
  OrchView as View,
} from '../types'
import { DOCS } from './docs'
import * as hud from './hud'
import type { HudCommand } from './hud'

type E = EngineInterface

const PANE = 'orchestrator'
const OUTPUT_CAP = 8000
const TOOL = 'mcp__orchestrator__'

const DEFAULT_SETTINGS: Settings = {
  maxParallel: 3,
  claudeBin: 'claude',
  processArgs: '--permission-mode acceptEdits',
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
  { shape: 'orch-tasks-1' },
)
const settings = atom(
  { plugin: 'orchestrator', key: 'settings' } as const,
  DEFAULT_SETTINGS,
  { shape: 'orch-settings-1' },
)
const view = atom(
  { plugin: 'orchestrator', key: 'view' } as const,
  DEFAULT_VIEW,
  { shape: 'orch-view-1' },
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
}

async function refreshStatus($: E) {
  const list = await read($, tasks)
  const run = list.filter(t => t.status === 'running').length
  const wait = list.filter(t => t.status === 'queued').length
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
  if (task.isNotify && final !== 'killed') {
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

  if (task.backend === 'agent') {
    try {
      const res = await $.agent.spawn({
        prompt: task.prompt,
        description: task.title.slice(0, 60),
        subagentType: task.agentType || 'general-purpose',
        cwd: project.path,
        ...(task.model ? { model: task.model } : {}),
      })
      if (res.deny !== undefined || res.agentId === undefined) {
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

  const argv = [cfg.claudeBin, '-p', task.prompt, ...splitArgs(cfg.processArgs)]
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
    else await finish($, task.id, code === 0 ? 'done' : 'failed', buf)
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
  try {
    for (;;) {
      const [list, cfg] = await Promise.all([read($, tasks), read($, settings)])
      const running = list.filter(t => t.status === 'running').length
      const next = list.find(t => t.status === 'queued')
      if (!next || running >= cfg.maxParallel) break
      await setTask($, next.id, {
        status: 'running',
        startedAt: await $.clock.now(),
      })
      void launch($, { ...next, status: 'running' })
    }
  } finally {
    isPumping = false
  }
  await refreshStatus($)
}

type NewTask = {
  projectId: string
  title: string
  prompt: string
  backend: Backend
  model: string
  agentType: string
  isNotify: boolean
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
  const head = `${t.id} [${t.status}] ${t.title} (${t.backend}, ${ran})`
  if (!withOutput) return head
  return `${head}\n${t.output ? clip(t.output, 2000) : '(no output yet)'}`
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
    },
  ])
}

// ---- HUD --------------------------------------------------------------

async function hudSnapshot($: E) {
  const [list, projs, cfg] = await Promise.all([
    read($, tasks),
    read($, projects),
    read($, settings),
  ])
  const projectName = (id: string) => projs.find(p => p.id === id)?.name ?? 'missing'
  return {
    now: await $.clock.now(),
    maxParallel: cfg.maxParallel,
    projects: projs.map(p => ({ id: p.id, name: p.name, path: p.path })),
    tasks: list.slice(-60).map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      backend: t.backend,
      model: t.model,
      projectId: t.projectId,
      project: projectName(t.projectId),
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
      }
    }

    await $.tool.register({
      name: 'dispatch',
      isDeferred: false,
      description:
        'Queue a task on the orchestrator dashboard. It runs as its own Claude session in the given project, in parallel with other tasks (up to the dashboard limit). Returns the task id. You are woken when it finishes; then call status to read the result.',
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
    if (!e.agentId) hud.setPhase('thinking')
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
    if (e.agentId) {
      try {
        const status: TaskStatus =
          e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'killed' : 'failed'
        const id = agentToTask.get(e.agentId)
        if (id) {
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
      },
    ])
    return { result: `Queued task ${id} in ${project.name}.` }
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
    const room = Math.max(4, (e.viewport?.rows ?? 24) - 8)

    const setTab = (tab: Tab) => update($, view, x => ({ ...x, tab }))
    const setDraft = (patch: Partial<Draft>) =>
      update($, draft, x => ({ ...x, ...patch }))
    const toast = (text: string) => void $.ui.toast(text)

    const tabs: Array<[Tab, string]> = [
      ['sessions', 'Sessions'],
      ['new', 'New'],
      ['projects', 'Projects'],
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
    const setSettings = async (patch: Partial<Settings>) => {
      await update($, settings, x => ({ ...x, ...patch }))
      await saveSettings($)
      void pump($)
    }
    const settingsTab = () =>
      hasForms ? (
        <Box flexDirection="column">
          <Select
            key="max-parallel"
            label="Max parallel sessions"
            value={String(cfg.maxParallel)}
            options={[1, 2, 3, 4, 5, 6, 8].map(n => ({ value: String(n), label: String(n) }))}
            onSelect={(value: string) => void setSettings({ maxParallel: Number(value) })}
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
        {v.tab === 'settings' && settingsTab()}
        {v.tab === 'docs' && docsTab()}
      </Box>
    )
  })
}
