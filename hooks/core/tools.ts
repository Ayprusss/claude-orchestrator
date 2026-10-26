// The tools the orchestrator gives the main session: their schemas, and the
// handlers behind dispatch, status, projects and the memory tools.

import type { EngineInterface } from 'claude-code'

import type { OrchProject as Project } from '../../types'
import { normalizeEffort, normalizeModel } from '../controls/tasks'
import {
  forget as memForget,
  memoryProjects as memMemoryProjects,
  memoryRead as memMemoryRead,
  memorySearch as memMemorySearch,
  note as memNote,
  remember as memRemember,
} from '../memory/harness'
import { addTasks, describeTask, memReady } from './queue'
import { getProjects, getSettings, getTasks, saveProjects, updateProjects } from './state'
import { TOOL, isAbsPath, nameOf, uid } from './util'

type E = EngineInterface
type Input = Record<string, unknown>

/** Registers the tools at session.start. */
export async function registerTools($: E) {
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
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: "Optional effort level for the task's agent or process. Leave it out for its default.",
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
}

async function resolveProject(
  $: E,
  ref: string,
): Promise<Project | undefined> {
  const list = await getProjects($)
  const key = ref.trim().toLowerCase()
  const hit = list.find(
    p => p.id === ref || p.name.toLowerCase() === key || p.path === ref.trim(),
  )
  if (hit) return hit
  if (isAbsPath(ref.trim())) {
    const made: Project = { id: uid(), name: nameOf(ref), path: ref.trim() }
    await updateProjects($, l => [...l, made])
    await saveProjects($)
    return made
  }
  return undefined
}

export async function dispatchTool($: E, input: Input) {
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
      model: normalizeModel(input.model),
      agentType: 'general-purpose',
      isNotify: true,
      ...(normalizeEffort(input.effort) ? { effort: normalizeEffort(input.effort) } : {}),
      ...(typeof input.why === 'string' && input.why.trim() ? { why: input.why.trim().slice(0, 200) } : {}),
    },
  ])
  const isAsked = input.backend !== 'process' && (await getSettings($)).agentLaunch !== 'plugin'
  return {
    result: isAsked
      ? `Queued task ${id} in ${project.name}. When it can start, an [orchestrator] message will ask you to launch it with the Agent tool.`
      : `Queued task ${id} in ${project.name}.`,
  }
}

export async function statusTool($: E, input: Input) {
  const list = await getTasks($)
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
}

export async function projectsTool($: E) {
  const list = await getProjects($)
  return {
    result: list.length
      ? list.map(p => `${p.name}: ${p.path}`).join('\n')
      : 'No projects registered.',
  }
}

export async function noteTool($: E, input: Input) {
  await memReady($)
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
}

export async function memorySearchTool($: E, input: Input) {
  await memReady($)
  const list = await memMemoryProjects($, await getProjects($))
  return { result: await memMemorySearch($, list, input) }
}

export async function memoryReadTool($: E, input: Input) {
  await memReady($)
  const list = await memMemoryProjects($, await getProjects($))
  return { result: await memMemoryRead($, list, input) }
}

export async function rememberTool($: E, input: Input) {
  await memReady($)
  const list = await memMemoryProjects($, await getProjects($))
  return { result: await memRemember($, list, input) }
}

export async function forgetTool($: E, input: Input) {
  await memReady($)
  const list = await memMemoryProjects($, await getProjects($))
  return { result: await memForget($, list, input) }
}
