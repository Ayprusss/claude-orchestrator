// HUD helpers with no engine calls: the outgoing event queue, the phase of
// the main session, and the line reader for the server's stdout. The engine
// plumbing (spawning web/server.mjs, posting to it) lives in register.tsx,
// since every `$` call is spelled where the hook runs.

import type { OrchBackend } from '../types'

export type HudCommand =
  | { type: 'chat'; text: string }
  | {
      type: 'dispatch'
      projectId: string
      title: string
      prompt: string
      backend: OrchBackend
      model: string
      // '' or 'low' | 'medium' | 'high' | 'xhigh' | 'max' (HUD_CONTROLS_PLAN.md)
      effort?: string
    }
  | { type: 'kill' | 'retry' | 'remove'; id: string }
  | { type: 'clear' }
  | {
      type: 'settings'
      maxParallel?: number
      isStandbyOnLimit?: boolean
      isDiffViewOn?: boolean
      isPingOn?: boolean
      isHudPermissionsOn?: boolean
      hudPermissionWaitSec?: number
    }
  | { type: 'ping' }
  | { type: 'resume' }
  // hud-controls (HUD_CONTROLS_PLAN.md)
  // The main session's model ('' = default) and effort level.
  | { type: 'session-model'; model: string }
  | { type: 'session-effort'; effort: string }
  // A queued task's model and effort, before it starts.
  | { type: 'task-config'; id: string; model: string; effort: string }
  // Push the conversation's history to the HUD again.
  | { type: 'history-load' }

export type HudEvent = { type: string; [key: string]: unknown }
export type HudPhase = 'idle' | 'thinking' | 'speaking' | 'tool'

export const PREFERRED_PORT = 4747
export const TICK_MS = 150
export const SNAPSHOT_EVERY = 4 // ticks
export const HEARTBEAT_MS = 5000
export const READY_TIMEOUT_MS = 10_000

// The running server; port 0 while it is down. A reload starts this over.
export const link = { port: 0, token: '' }
export const isUp = () => link.port > 0
export const hudUrl = () => (link.port ? `http://127.0.0.1:${link.port}/?t=${link.token}` : '')

let queue: HudEvent[] = []
let deltaBuf = ''
let phase: HudPhase = 'idle'
let lastSnapshotKey = ''
let lastPushAt = 0

export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9]{16,}$/.test(value)

export function makeToken(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = new Uint8Array(32)
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, b => abc[b % abc.length]).join('')
}

/** Marks the server up on `port`, with a fresh queue. */
export function connected(port: number) {
  link.port = port
  queue = []
  deltaBuf = ''
  phase = 'idle'
  lastSnapshotKey = ''
}

export function disconnected() {
  link.port = 0
  queue = []
  deltaBuf = ''
}

/** Queues an event for the browser; dropped while the HUD is down. */
export function event(ev: HudEvent) {
  if (!isUp()) return
  // Keep order: text streamed so far goes out before what follows it.
  if (deltaBuf) {
    queue.push({ type: 'delta', text: deltaBuf })
    deltaBuf = ''
  }
  queue.push(ev)
  if (queue.length > 400) queue = queue.slice(-400)
}

export function setPhase(next: HudPhase, tool?: string) {
  if (!isUp()) return
  if (next === phase && next !== 'tool') return
  phase = next
  event({ type: 'phase', phase: next, ...(tool ? { tool } : {}) })
}

/** A piece of the main session's reply, as it is written. */
export function delta(text: string) {
  if (!isUp() || !text) return
  if (phase !== 'speaking') setPhase('speaking')
  deltaBuf += text
}

/**
 * Queues `snapshot` if it changed, or as a heartbeat when nothing went out
 * for a while. `now` is left out of the comparison: it always changes.
 */
export function offerSnapshot(snapshot: Record<string, unknown>, now: number) {
  const key = JSON.stringify({ ...snapshot, now: 0 })
  if (key !== lastSnapshotKey || now - lastPushAt > HEARTBEAT_MS) {
    lastSnapshotKey = key
    event({ type: 'snapshot', ...snapshot })
  }
}

/** Everything waiting to go out, in order; empties the queue. */
export function drain(): HudEvent[] {
  if (deltaBuf) {
    queue.push({ type: 'delta', text: deltaBuf })
    deltaBuf = ''
  }
  const batch = queue
  queue = []
  return batch
}

export function pushed(now: number) {
  lastPushAt = now
}

/** Splits a child's output pieces into whole lines. */
export function lineReader() {
  let buf = ''
  return (text: string): string[] => {
    buf += text
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    return lines.map(l => l.trim()).filter(Boolean)
  }
}

/** Parses one server line: `READY <port>` or `CMD {json}`. */
export function parseLine(
  line: string,
): { ready: number } | { command: HudCommand } | undefined {
  if (line.startsWith('READY ')) {
    const port = Number(line.slice(6))
    return port > 0 ? { ready: port } : undefined
  }
  if (line.startsWith('CMD ')) {
    try {
      const command = JSON.parse(line.slice(4)) as HudCommand
      return command && typeof command.type === 'string' ? { command } : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
