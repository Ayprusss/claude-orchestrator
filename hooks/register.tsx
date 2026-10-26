// The orchestrator's wiring: each hook calls a named function in core/.
// The logic lives in core/ (state, queue, standby, hud-bridge, pane, tools,
// ping); the memory harness in memory/.

import type { Register } from 'claude-code'

import * as hud from './hud'
import {
  afterCompact as memAfterCompact,
  beforeCompact as memBeforeCompact,
  composeSection as memComposeSection,
  ensureStarted as memEnsureStarted,
  onClear as memOnClear,
  saveNow as memSaveNow,
} from './memory/harness'
import { isResumed } from './controls/history'
import { noteMode } from './controls/permissions'
import { noteEffort } from './controls/session'
import {
  HUD_CONTEXT,
  askPermissionInHud,
  mirrorAnswer,
  mirrorPrompt,
  pushHistory,
  recordTaskEdit,
  reportDiff,
  resumeHud,
  runHudCommand,
} from './core/hud-bridge'
import { renderPane } from './core/pane'
import { checkIdle, markBusy, setMainBusy } from './core/ping'
import {
  gateLaunch,
  newContextEpoch,
  onAgentCallDone,
  onAgentComplete,
  onLaunched,
  pump,
  recoverTasks,
} from './core/queue'
import { onMeasure, onStopFailure, resumeStandbyTimer } from './core/standby'
import { getHudOn, getSettings, loadStored } from './core/state'
import {
  dispatchTool,
  forgetTool,
  memoryReadTool,
  memorySearchTool,
  noteTool,
  projectsTool,
  registerTools,
  rememberTool,
  statusTool,
} from './core/tools'
import { PANE, TOOL } from './core/util'

type Input = Record<string, unknown>
const asInput = (e: unknown) => e as Input

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

    await loadStored($)
    await recoverTasks($)
    await registerTools($)
    try {
      await memEnsureStarted($, await getSettings($))
    } catch (err) {
      $.ui.log(`memory: ${String(err)}`, { to: 'debug' })
    }

    await resumeStandbyTimer($)
    void pump($)
    // A resumed conversation: once the HUD is up, its history fills Comms.
    void isResumed($)
      .then(isRes => (isRes ? $.clock.after(1500, () => void pushHistory($).catch(() => undefined)) : undefined))
      .catch(() => undefined)
    await resumeHud($, await getHudOn($))
    return next(e)
  })

  on('command.run', { command: 'orchestrator' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Orchestrator', focus: true, rows: 22 })
    return { text: 'Orchestrator opened.' }
  })

  on('command.run', { command: 'orchestrator-hud' }, async ($, e) => ({
    text: await runHudCommand($, e.args),
  }))

  // ---- Mirror the main conversation into the HUD ----------------------

  on('prompt.submit', async ($, e, next) => {
    const isHud = await mirrorPrompt($, e)
    if (isHud) return next({ ...e, context: [...(e.context ?? []), HUD_CONTEXT] })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      hud.setPhase('thinking')
      setMainBusy(true)
      try {
        await markBusy($)
        // A surface may attach only after session.start (the desktop app).
        await memEnsureStarted($, await getSettings($))
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
    if (res.messages) {
      newContextEpoch()
      await memAfterCompact($).catch(() => undefined)
    }
    return res
  })

  on('session.end', async ($, e, next) => {
    try {
      await memSaveNow($)
      // /clear goes on under a new session id, and no session.start fires for it.
      if (e.reason === 'clear') newContextEpoch()
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
    if (!e.agentId) {
      await mirrorAnswer($, e)
      setMainBusy(false)
      try {
        await checkIdle($)
      } catch {
        // Best effort.
      }
    } else {
      await onAgentComplete($, e.agentId, e.reason, e.answer)
    }
    return next(e)
  })

  // ---- Agent tasks the main session launches -------------------------

  // The session's Agent call described `orch-<id> ...` starts that task: run it in
  // the project's folder, in the background, and track it. The prompt is the
  // one the call carries (the one auto mode judged), never swapped.
  on('agent.spawn', async ($, e, next) => {
    const gate = await gateLaunch($, e)
    if (gate.kind === 'pass') return next(e)
    if (gate.kind === 'deny') return { deny: gate.deny }
    const { task, project } = gate
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
    await onAgentCallDone($, asInput(e).description, res)
    return res
  }).catch(($, e, next) => next(e))

  // ---- Code changes ---------------------------------------------------

  // Every edit, the main session's and each agent's, goes to the HUD's diff view.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const res = await next(e)
    recordTaskEdit(asInput(e), res)
    if (hud.isUp()) void reportDiff($, 'Edit', asInput(e), res)
    return res
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const res = await next(e)
    recordTaskEdit(asInput(e), res)
    if (hud.isUp()) void reportDiff($, 'Write', asInput(e), res)
    return res
  })

  // ---- Usage limits ---------------------------------------------------

  // A model call died on an API error; rate_limit and billing_error mean no tokens.
  on('classic.StopFailure', async ($, e, next) => {
    await onStopFailure($, e)
    return next(e)
  })

  // ---- HUD controls: mode, effort and permission prompts --------------

  // Every classic hook input says the session's permission mode and effort.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    noteMode(e)
    noteEffort(e as { effort?: { level?: unknown } })
    return next(e)
  })

  // A turn's end: a mode changed in the terminal shows by then.
  on('classic.Stop', async ($, e, next) => {
    noteMode(e)
    noteEffort(e as { effort?: { level?: unknown } })
    return next(e)
  })

  // A permission prompt: answered in the HUD when a HUD tab is open and the
  // setting is on; otherwise, or when the HUD gives no answer in time, the
  // terminal prompt shows as usual. The wait is inside $.http.fetch, so it
  // does not run this hook's budget.
  on('classic.PermissionRequest', async ($, e, next) => {
    noteMode(e)
    const decision = await askPermissionInHud($, e, await getSettings($))
    if (!decision) return next(e)
    return { decision } as Awaited<ReturnType<typeof next>>
  }).catch(($, e, next) => next(e))

  // The account's windows moved: enter standby at 100%, leave it once a
  // window that put us there has room again.
  on('session.measure', async ($, e, next) => {
    await onMeasure($, e)
    return next(e)
  })

  // ---- Tools ----------------------------------------------------------

  on('tool.call', { tool: `${TOOL}dispatch` }, async ($, e) => dispatchTool($, asInput(e)))
  on('tool.call', { tool: `${TOOL}status` }, async ($, e) => statusTool($, asInput(e)))
  on('tool.call', { tool: `${TOOL}projects` }, async $ => projectsTool($))

  // Memory tools.
  on('tool.call', { tool: /^mcp__orchestrator__note$/ }, async ($, e) => noteTool($, asInput(e)))
  on('tool.call', { tool: /^mcp__orchestrator__memory_search$/ }, async ($, e) => memorySearchTool($, asInput(e)))
  on('tool.call', { tool: /^mcp__orchestrator__memory_read$/ }, async ($, e) => memoryReadTool($, asInput(e)))
  on('tool.call', { tool: /^mcp__orchestrator__remember$/ }, async ($, e) => rememberTool($, asInput(e)))
  on('tool.call', { tool: /^mcp__orchestrator__forget$/ }, async ($, e) => forgetTool($, asInput(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, e))
}
