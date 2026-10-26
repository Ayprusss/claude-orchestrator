// The bridge to the HUD (the browser dashboard): its snapshot, its commands,
// the server child and its tick, the diff feed, and the mirror of the main
// conversation. Owns the server handles and the set of HUD-sent prompts.

import type { EngineInterface } from 'claude-code'

import type { OrchSettings as Settings } from '../../types'
import { buildDiff } from '../diffs'
import * as hud from '../hud'
import type { HudCommand } from '../hud'
import { windowsForHud } from '../limits'
import { recordEdit as memRecordEdit } from '../memory/harness'
import { historyMessages } from '../controls/history'
import { askInHud, currentMode, summarizeCall, toDecision } from '../controls/permissions'
import { EFFORT_LEVELS, MODEL_CHOICES, sessionInfo, setSessionEffort, setSessionModel } from '../controls/session'
import { canConfigure, normalizeEffort, normalizeModel } from '../controls/tasks'
import { playPing } from './ping'
import { addTasks, applySettings, killTask, retryTask, taskOfAgent } from './queue'
import { resumeByHand, usageWindows } from './standby'
import {
  getLimit,
  getProjects,
  getSettings,
  getTasks,
  setHudOn,
  setTask,
  updateTasks,
} from './state'
import { MAX_PARALLEL, clip, uid } from './util'
import type { Handle } from './util'

type E = EngineInterface

// Text the HUD submitted, so its prompt.submit can be told apart from a typed one.
const hudPrompts = new Set<string>()
export const HUD_CONTEXT =
  'This message was sent from the Orchestrator HUD, a visual and voice dashboard. ' +
  'Your reply is shown there and may be read aloud: keep it short and conversational, ' +
  'lead with the answer, and avoid tables and long code blocks. To start work that ' +
  `runs in parallel, use the ${'mcp__orchestrator__'}dispatch tool.`

// ---- Code changes for the HUD --------------------------------------

/** An agent task's edit, for its project memory's list of files. */
export function recordTaskEdit(input: Record<string, unknown>, res: unknown) {
  const r = res as { deny?: string; isError?: boolean }
  if (r.deny !== undefined || r.isError) return
  const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
  if (agentId) memRecordEdit(taskOfAgent(agentId), input.file_path)
}

/** Sends the diff of a finished Edit or Write call to the HUD, tagged with its agent. */
export async function reportDiff(
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
    let taskId = agentId ? taskOfAgent(agentId) : undefined
    if (agentId && !taskId) taskId = (await getTasks($)).find(t => t.agentId === agentId)?.id
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

export async function hudSnapshot($: E) {
  const [list, projs, cfg, lim, windows] = await Promise.all([
    getTasks($),
    getProjects($),
    getSettings($),
    getLimit($),
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
    isHudPermissionsOn: cfg.isHudPermissionsOn !== false,
    hudPermissionWaitSec: cfg.hudPermissionWaitSec ?? 60,
    session: { ...(await sessionInfo($)), mode: currentMode() },
    choices: { models: MODEL_CHOICES, efforts: EFFORT_LEVELS },
    limit: lim,
    usage: windowsForHud(windows),
    projects: projs.map(p => ({ id: p.id, name: p.name, path: p.path })),
    tasks: list.slice(-60).map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      backend: t.backend,
      model: t.model,
      effort: t.effort ?? '',
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


/** Fills the HUD's Comms with the conversation so far (a resumed one, or after a reload). */
export async function pushHistory($: E) {
  if (!hud.isUp()) return
  const messages = await historyMessages($, 150)
  if (messages.length) hud.event({ type: 'history', messages })
}

export async function onHudCommand($: E, cmd: HudCommand) {
  const toast = (text: string, level = 'info') => hud.event({ type: 'toast', text, level })
  const list = await getTasks($)
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
      const projs = await getProjects($)
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
          model: normalizeModel(cmd.model),
          agentType: 'general-purpose',
          isNotify: false,
          ...(normalizeEffort(cmd.effort) ? { effort: normalizeEffort(cmd.effort) } : {}),
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
      await updateTasks($, l => l.filter(t => t.id !== cmd.id || t.status === 'running'))
      return
    case 'clear':
      await updateTasks($, l =>
        l.filter(t => t.status === 'running' || t.status === 'queued'),
      )
      return
    case 'settings': {
      const patch: Partial<Settings> = {}
      if (typeof cmd.maxParallel === 'number') patch.maxParallel = cmd.maxParallel
      if (typeof cmd.isStandbyOnLimit === 'boolean') patch.isStandbyOnLimit = cmd.isStandbyOnLimit
      if (typeof cmd.isDiffViewOn === 'boolean') patch.isDiffViewOn = cmd.isDiffViewOn
      if (typeof cmd.isPingOn === 'boolean') patch.isPingOn = cmd.isPingOn
      if (typeof cmd.isHudPermissionsOn === 'boolean') patch.isHudPermissionsOn = cmd.isHudPermissionsOn
      if (typeof cmd.hudPermissionWaitSec === 'number') {
        patch.hudPermissionWaitSec = Math.min(300, Math.max(15, Math.round(cmd.hudPermissionWaitSec)))
      }
      await applySettings($, patch)
      return toast('Settings saved.')
    }
    case 'resume':
      return resumeByHand($)
    case 'session-model': {
      const r = await setSessionModel($, String(cmd.model ?? ''))
      return toast(r.text, r.ok ? 'info' : 'error')
    }
    case 'session-effort': {
      const r = await setSessionEffort($, String(cmd.effort ?? ''))
      return toast(r.text, r.ok ? 'info' : 'error')
    }
    case 'task-config': {
      const t = list.find(x => x.id === cmd.id)
      if (!t) return toast('That task is gone.', 'error')
      if (!canConfigure(t)) return toast('Only a queued task can change its model or effort.', 'error')
      const model = normalizeModel(cmd.model)
      const effort = normalizeEffort(cmd.effort)
      await setTask($, t.id, { model, effort })
      return toast(`Task ${t.id} will run on ${model || 'the default model'}${effort ? `, ${effort} effort` : ''}.`)
    }
    case 'history-load':
      return pushHistory($)
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

export async function stopHud() {
  const child = hudChild
  hudChild = undefined
  if (!child) return
  try {
    await child.return()
  } catch {
    // Already gone.
  }
}

export async function startHud($: E, isOpening: boolean): Promise<string> {
  await setHudOn($, true)
  await startHudServer($)
  void pushHistory($).catch(() => undefined)
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

/** The /orchestrator-hud command: "stop" shuts the server down, anything else starts it. */
export async function runHudCommand($: E, args: string): Promise<string> {
  if (args.trim() === 'stop') {
    await setHudOn($, false)
    await stopHud()
    return 'HUD stopped.'
  }
  try {
    return await startHud($, true)
  } catch (err) {
    await setHudOn($, false)
    return `Could not start the HUD: ${String(err)}`
  }
}

// ---- Mirror the main conversation into the HUD ----------------------

/** Shows a submitted prompt in the HUD; true when the HUD itself sent it. */
export async function mirrorPrompt(
  $: E,
  e: { text: string; command?: unknown; isMeta?: boolean; origin?: { kind?: string } },
): Promise<boolean> {
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
  return isHud
}

/** The main session's turn ended: show its answer in the HUD. */
export async function mirrorAnswer($: E, e: { reason: string; answer: string }) {
  if (!hud.isUp()) return
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

/** A reload kills the HUD's server; bring it back for any open browser tab. */
export async function resumeHud($: E, isOn: boolean) {
  if (isOn) {
    void startHud($, false).catch(err => $.ui.log(`HUD: ${String(err)}`, { to: 'debug' }))
  }
}

/**
 * A permission prompt: answered in the HUD when a HUD tab is open and the
 * setting is on; undefined when the terminal prompt should show as usual.
 */
export async function askPermissionInHud(
  $: E,
  e: { tool_name: string; tool_input: unknown; permission_mode?: unknown },
  cfg: Settings,
) {
  if (cfg.isHudPermissionsOn === false || !hud.isUp()) return undefined
  const answer = await askInHud($, {
    baseUrl: `http://127.0.0.1:${hud.link.port}`,
    token: hud.link.token,
    waitMs: (cfg.hudPermissionWaitSec ?? 60) * 1000,
    request: {
      id: `${uid()}${uid()}`,
      tool: e.tool_name,
      summary: summarizeCall(e.tool_name, e.tool_input as never),
      mode: typeof e.permission_mode === 'string' ? e.permission_mode : currentMode(),
    },
  })
  return answer ? toDecision(answer) : undefined
}
