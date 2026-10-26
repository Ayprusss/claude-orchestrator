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
  /**
   * Set when the main session already has the task's prompt in context (it
   * dispatched it since the last compaction): the request then names the
   * text to put before and after that prompt instead of repeating it.
   */
  known?: { before: string; after: string }
}

/**
 * How `full` is built around the dispatch prompt `original`, or undefined
 * when `original` is not in it verbatim (then the full prompt is sent).
 */
export function splitKnown(full: string, original: string): { before: string; after: string } | undefined {
  if (!original.trim()) return undefined
  const i = full.indexOf(original)
  if (i === -1) return undefined
  return { before: full.slice(0, i), after: full.slice(i + original.length) }
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Whether a launched prompt carries the dispatch prompt (whitespace aside). */
export function promptMatches(launched: string, original: string): boolean {
  return squash(launched).includes(squash(original))
}

/** The note asking a task for a short final reply; '' when the cap is off. */
export function reportNote(words: number, reportPath?: string): string {
  if (!words || words <= 0) return ''
  return (
    `\n\nWhen you finish, reply in at most ${Math.round(words)} words: the outcome, the files you changed, and anything left undone or blocking.` +
    (reportPath ? ` Put longer detail in ${reportPath} and give that path.` : '')
  )
}

function promptLines(s: LaunchSpec): string[] {
  if (!s.known) {
    return [
      '- prompt: everything between the two marker lines, verbatim',
      `<<<ORCH-PROMPT ${s.id}`,
      s.prompt,
      `ORCH-PROMPT ${s.id}>>>`,
    ]
  }
  const before = s.known.before.trim() ? s.known.before : ''
  const after = s.known.after.trim() ? s.known.after : ''
  return [
    `- prompt: the exact prompt you passed to dispatch for this task ("${s.title}"; from dispatch_batch, that task's own prompt), verbatim` +
      (before || after ? ', with the text between the marker lines below added' : ''),
    ...(before ? ['  before it:', `<<<ORCH-BEFORE ${s.id}`, before, `ORCH-BEFORE ${s.id}>>>`] : []),
    ...(after ? ['  after it:', `<<<ORCH-AFTER ${s.id}`, after, `ORCH-AFTER ${s.id}>>>`] : []),
  ]
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
      ...promptLines(s),
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
