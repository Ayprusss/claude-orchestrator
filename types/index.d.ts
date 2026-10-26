export type OrchProject = { id: string; name: string; path: string }

export type OrchBackend = 'agent' | 'process'

// Who starts an agent task: the main session through its own Agent tool
// (works in auto mode), or the plugin directly with $.agent.spawn.
export type OrchAgentLaunch = 'session' | 'plugin'

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
  // An agent task the main session was asked to launch and has not yet: when
  // it was last asked, and how many times.
  launchAskedAt?: number
  launchAsks?: number
  // One line on why the task exists (dispatch's optional `why`), kept in the ledger.
  why?: string
  // Set at finish from the task's summary (memory phase 2): the one-paragraph
  // summary, its outcome ('succeeded' | 'partial' | 'failed' | 'unknown'), and
  // the files an agent task edited.
  summary?: string
  outcome?: string
  files?: string[]
  createdAt: number
  startedAt?: number
  endedAt?: number
}

// The memory fields (isMemoryOn, memoryDir, summaryDetail, summaryModel,
// isTranscriptKept, recallBudgetChars) come from OrchMemorySettings; stored
// settings merge over the defaults, so older ones keep working.
export type OrchSettings = OrchMemorySettings & {
  maxParallel: number
  claudeBin: string
  processArgs: string
  // On a usage limit, hold queued work and requeue cut-off tasks until it resets.
  isStandbyOnLimit: boolean
  // Pop up each code change in the HUD, beside the agent that made it.
  isDiffViewOn: boolean
  // Play a ping once the main session and every task are done.
  isPingOn: boolean
  agentLaunch: OrchAgentLaunch
}

export type OrchTab = 'sessions' | 'new' | 'projects' | 'memory' | 'settings' | 'docs'

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

// ---- Memory harness (MEMORY_HARNESS_PLAN.md) --------------------------------
// Mirrors of hooks/memory/contract.ts, which is their source: this file must
// be self-contained (no imports), so keep the two in step.

export type OrchSummaryDetail = 'off' | 'short' | 'detailed'

// The fields the harness adds to OrchSettings (contract: MemorySettings).
export type OrchMemorySettings = {
  isMemoryOn: boolean
  // '' = the default folder, <home>/.claude/orchestrator-memory
  memoryDir: string
  summaryDetail: OrchSummaryDetail
  summaryModel: string
  isTranscriptKept: boolean
  recallBudgetChars: number
}

export type OrchLedgerGoal = { id: string; text: string; status: 'open' | 'done' | 'dropped'; at: number }
export type OrchLedgerDecision = { id: string; text: string; at: number }

export type OrchLedgerTask = {
  id: string
  project: string
  projectKey: string
  title: string
  why?: string
  status: OrchStatus
  summary?: string
  // Clipped to 200 characters, for carry-over.
  prompt?: string
  createdAt: number
  endedAt?: number
}

// One session's ledger (contract: Ledger), saved as ledgers/<sessionId>.json.
export type OrchLedger = {
  version: 1
  sessionId: string
  startedAt: number
  updatedAt: number
  carriedFrom?: string
  goals: OrchLedgerGoal[]
  decisions: OrchLedgerDecision[]
  tasks: OrchLedgerTask[]
}

export type OrchMemoryPart = 'knowledge' | 'inbox' | 'episodes' | 'ledger'

// The Memory tab's view (contract: MemoryView). `selected` is a fact id, an
// episode's task id, or 'clear:<projectKey>' while Clear waits for its second press.
export type OrchMemoryView = { projectKey: string; part: OrchMemoryPart; selected: string }

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
      // This session's ledger of goals, decisions and tasks (memory phase 1).
      ledger: Shaped<OrchLedger>
      // The Memory tab's project, part and selection.
      memoryView: Shaped<OrchMemoryView>
    }
  }
}
