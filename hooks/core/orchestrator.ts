// The orchestrator's own model and effort: set once, when a session that has a
// screen starts (a headless `claude -p` run keeps the model it was given).

import type { EngineInterface } from 'claude-code'

import { setSessionEffort, setSessionModel } from '../controls/session'
import { getSettings } from './state'

type E = EngineInterface

let isApplied = false

/** Sets the main session's model and effort from Settings, once per process. Safe to call again. */
export async function applyOrchestratorModel($: E): Promise<void> {
  if (isApplied) return
  try {
    if ((await $.session.surfaces()).length === 0) return
    isApplied = true
    const cfg = await getSettings($)
    if (cfg.orchestratorModel) await setSessionModel($, cfg.orchestratorModel)
    if (cfg.orchestratorEffort) await setSessionEffort($, cfg.orchestratorEffort)
  } catch {
    // The session keeps the model it has.
  }
}
