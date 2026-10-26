// Every atom of the orchestrator, its defaults, and the accessors the other
// core modules use. The engine wants update/read to name an atom defined in
// the same file, so no other module touches an atom directly.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  OrchDraft as Draft,
  OrchHud as HudState,
  OrchLimit as LimitState,
  OrchProject as Project,
  OrchSettings as Settings,
  OrchTask as Task,
  OrchView as View,
} from '../../types'
import { NO_LIMIT } from '../limits'
import { DEFAULT_MEMORY_SETTINGS } from '../memory/contract'
import { onTaskStatus as memOnTaskStatus } from '../memory/harness'

type E = EngineInterface

export const DEFAULT_SETTINGS: Settings = {
  maxParallel: 3,
  claudeBin: 'claude',
  processArgs: '--permission-mode acceptEdits',
  isStandbyOnLimit: true,
  isDiffViewOn: true,
  isPingOn: true,
  agentLaunch: 'session',
  isHudPermissionsOn: true,
  hudPermissionWaitSec: 60,
  reportWords: 150,
  defaultTaskModel: 'sonnet',
  defaultTaskEffort: 'medium',
  throttleAtPercent: 80,
  throttledParallel: 2,
  largeReadKB: 40,
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
  { shape: 'orch-tasks-6' },
)
const settings = atom(
  { plugin: 'orchestrator', key: 'settings' } as const,
  DEFAULT_SETTINGS,
  { shape: 'orch-settings-9' },
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

// ---- Accessors ------------------------------------------------------

export function getProjects($: E) {
  return read($, projects)
}
export function updateProjects($: E, fn: (list: Project[]) => Project[]) {
  return update($, projects, fn)
}

export function getTasks($: E) {
  return read($, tasks)
}
export function updateTasks($: E, fn: (list: Task[]) => Task[]) {
  return update($, tasks, fn)
}

export function getSettings($: E) {
  return read($, settings)
}
export function updateSettings($: E, fn: (cfg: Settings) => Settings) {
  return update($, settings, fn)
}

export function getView($: E) {
  return read($, view)
}
export function updateView($: E, fn: (v: View) => View) {
  return update($, view, fn)
}

export function getDraft($: E) {
  return read($, draft)
}
export function updateDraft($: E, fn: (d: Draft) => Draft) {
  return update($, draft, fn)
}

export async function getHudOn($: E) {
  return (await read($, hudState)).isOn
}
export function setHudOn($: E, isOn: boolean) {
  return update($, hudState, () => ({ isOn }))
}

export function getLimit($: E) {
  return read($, limitState)
}
export function updateLimit($: E, fn: (lim: LimitState) => LimitState) {
  return update($, limitState, fn)
}

export async function setTask($: E, id: string, patch: Partial<Task>) {
  await update($, tasks, list =>
    list.map(t => (t.id === id ? { ...t, ...patch } : t)),
  )
  if (patch.status) await memOnTaskStatus($, id, patch.status).catch(() => undefined)
}

export function isLimitedNow($: E) {
  return async () => (await read($, limitState)).isLimited
}

export async function saveProjects($: E) {
  await $.store.set('projects', await read($, projects))
}
export async function saveSettings($: E) {
  await $.store.set('settings', await read($, settings))
}

/** Projects and settings outlive the session: load them at session.start. */
export async function loadStored($: E) {
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
}
