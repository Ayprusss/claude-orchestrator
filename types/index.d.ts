export type OrchProject = { id: string; name: string; path: string }

export type OrchBackend = 'agent' | 'process'

export type OrchStatus = 'queued' | 'running' | 'done' | 'failed' | 'killed'

export type OrchTask = {
  id: string
  projectId: string
  title: string
  prompt: string
  backend: OrchBackend
  model: string
  agentType: string
  status: OrchStatus
  output: string
  agentId?: string
  // True when the main session dispatched it: its finish wakes that session.
  isNotify: boolean
  // How many times a usage limit cut this task off and sent it back to the queue.
  interruptions?: number
  createdAt: number
  startedAt?: number
  endedAt?: number
}

export type OrchSettings = {
  maxParallel: number
  claudeBin: string
  processArgs: string
  // On a usage limit, hold queued work and requeue cut-off tasks until it resets.
  isStandbyOnLimit: boolean
  // Pop up each code change in the HUD, beside the agent that made it.
  isDiffViewOn: boolean
  // Play a ping once the main session and every task are done.
  isPingOn: boolean
}

export type OrchTab = 'sessions' | 'new' | 'projects' | 'settings' | 'docs'

export type OrchView = {
  tab: OrchTab
  selected: string
  docPage: string
}

export type OrchDraft = {
  title: string
  prompt: string
  projectId: string
  backend: OrchBackend
  model: string
  agentType: string
  isBatch: boolean
  projName: string
  projPath: string
}

// Whether the HUD's local server should run in this session (it restarts
// after a reload while this is on).
export type OrchHud = { isOn: boolean }

// The standby state while the account's usage limit is reached.
export type OrchLimit = {
  isLimited: boolean
  since: number
  // When it is expected to lift, in ms; 0 when unknown.
  until: number
  kind: string
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      projects: Shaped<OrchProject[]>
      tasks: Shaped<OrchTask[]>
      settings: Shaped<OrchSettings>
      view: Shaped<OrchView>
      draft: Shaped<OrchDraft>
      hud: Shaped<OrchHud>
      limit: Shaped<OrchLimit>
    }
  }
}
