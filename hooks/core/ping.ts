// The all-done ping: when the main session is idle and no task is running or
// queued, wait a beat and play the sound if work was done. Owns the idle state.

import type { EngineInterface } from 'claude-code'

import * as hud from '../hud'
import { getSettings, getTasks } from './state'

type E = EngineInterface

// "All work done": the main session idle and no task running or queued.
let isMainBusy = false
let busySince = 0 // when the current stretch of work began; 0 while idle
let hadTask = false // a task ran in this stretch
let idleTimer: { cancel: () => void } | undefined
let platform: 'windows' | 'mac' | 'linux' | undefined
// A task's end wakes the main session a moment later: wait that out before calling it done.
const PING_SETTLE_MS = 3000
// A quick reply with no tasks is not "work" worth a ping.
const QUICK_TURN_MS = 15_000

export const isMainBusyNow = () => isMainBusy
export const setMainBusy = (isBusy: boolean) => {
  isMainBusy = isBusy
}
/** A task started in this stretch of work. */
export const noteTaskRan = () => {
  hadTask = true
}

export async function markBusy($: E) {
  idleTimer?.cancel()
  idleTimer = undefined
  if (!busySince) busySince = await $.clock.now()
}

/** Once nothing is left to do, wait a beat, then ping if work was done. */
export async function checkIdle($: E) {
  if (isMainBusy || !busySince) return
  const list = await getTasks($)
  if (list.some(t => t.status === 'running' || t.status === 'queued')) return
  idleTimer?.cancel()
  idleTimer = $.clock.after(PING_SETTLE_MS, () => void settleIdle($))
}

async function settleIdle($: E) {
  idleTimer = undefined
  const list = await getTasks($)
  if (isMainBusy || !busySince || list.some(t => t.status === 'running' || t.status === 'queued')) return
  const now = await $.clock.now()
  const isWork = hadTask || now - busySince >= QUICK_TURN_MS
  busySince = 0
  hadTask = false
  if (!isWork || (await getSettings($)).isPingOn === false) return
  hud.event({ type: 'msg', role: 'system', text: 'All work complete.', status: 'allclear', at: now })
  hud.event({ type: 'ping' })
  await playPing($)
}

/** Plays assets/ping.wav with the platform's own player. */
export async function playPing($: E) {
  try {
    if (!platform) {
      if ((await $.env.get('OS')) === 'Windows_NT') platform = 'windows'
      else {
        const r = await $.process.run(['uname'], { timeoutMs: 5000 })
        platform = r.stdout.trim() === 'Darwin' ? 'mac' : 'linux'
      }
    }
    const wav = `${$.plugin.root}/assets/ping.wav`
    if (platform === 'windows') {
      // $.audio.play has no player on Windows terminals; .NET's SoundPlayer does.
      const path = wav.replace(/\//g, '\\').replace(/'/g, "''")
      await $.process.run(
        ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${path}').PlaySync()`],
        { timeoutMs: 15_000 },
      )
    } else if (platform === 'mac') {
      await $.audio.play({ asset: 'assets/ping.wav' })
    } else {
      const r = await $.process.run(['paplay', wav], { timeoutMs: 15_000 }).catch(() => undefined)
      if (!r || r.exitCode !== 0) await $.process.run(['aplay', '-q', wav], { timeoutMs: 15_000 })
    }
  } catch {
    // No player on this machine: the HUD still shows it.
  }
}

