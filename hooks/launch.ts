// Agent tasks the main session launches with its own Agent tool, so auto mode
// can judge each launch against the person's request (a spawn from plugin
// code has no request to judge it by, and auto mode refuses it).

/**
 * The Agent call's `description` starts with `orch-<task id>`; the agent.spawn
 * hook knows the task by it. Not `name`: a named agent can become a teammate,
 * which runs in the session's folder whatever the hook sets.
 */
export const LAUNCH_TAG = /^orch-([a-z0-9]{6})(?![a-z0-9])/

export const launchTag = (taskId: string) => `orch-${taskId}`

export type LaunchSpec = {
  id: string
  title: string
  agentType: string
  model: string
  /** Effort level ('' = the session's default). */
  effort: string
  folder: string
  /** The prompt the agent runs with, final (after any resume note). */
  prompt: string
}

/** The [orchestrator] message asking the main session to launch these tasks. */
export function launchRequest(specs: LaunchSpec[]): string {
  const n = specs.length
  const blocks = specs.map(s =>
    [
      `Task ${s.id} "${s.title}"`,
      `- description: ${launchTag(s.id)} ${s.title.slice(0, 40)}`,
      `- subagent_type: ${s.agentType || 'general-purpose'}`,
      ...(s.model ? [`- model: ${s.model}`] : []),
      ...(s.effort ? [`- effort: ${s.effort}`] : []),
      `- folder (set by the orchestrator): ${s.folder}`,
      '- prompt: everything between the two marker lines, verbatim',
      `<<<ORCH-PROMPT ${s.id}`,
      s.prompt,
      `ORCH-PROMPT ${s.id}>>>`,
    ].join('\n'),
  )
  return (
    `[orchestrator] ${n} agent task${n === 1 ? ' is' : 's are'} ready to start. ` +
    `Launch ${n === 1 ? 'it' : 'each one'} now with the Agent tool${n === 1 ? '' : ', all in one turn'}, ` +
    'using exactly the description, subagent_type, model and effort given (pass effort as the `effort` parameter of the Agent tool; leave it out when a task has none), and the prompt verbatim; ' +
    'do not set a name. ' +
    'The orchestrator runs each in its folder, in the background, and wakes you when it finishes.\n\n' +
    blocks.join('\n\n')
  )
}
