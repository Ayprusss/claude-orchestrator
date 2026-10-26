// Permission prompts and the permission mode in the HUD (HUD_CONTROLS_PLAN.md,
// unit P). A classic.PermissionRequest hook puts the prompt to the HUD server
// and waits there for the person's answer; any failure leaves the terminal
// prompt to show (askInHud returns undefined).

import type { EngineInterface } from 'claude-code'

type E = EngineInterface

export const MODE_CYCLE = ['auto', 'plan', 'default', 'acceptEdits'] as const

export const MODE_LABEL: Record<string, string> = {
  auto: 'Auto Mode',
  plan: 'Planning Mode',
  default: 'Manual Mode',
  acceptEdits: 'Accept Edits On',
  bypassPermissions: 'Bypass Permissions',
  dontAsk: "Don't Ask",
}

/** The modes a prompt answer may switch to. */
const SETTABLE = new Set<string>(['auto', 'plan', 'default', 'acceptEdits', 'dontAsk'])

let mode = ''

/** Remembers the mode a classic hook input reports; true when it changed. */
export function noteMode(input: { permission_mode?: unknown }): boolean {
  const m = input?.permission_mode
  if (typeof m !== 'string' || !m || m === mode) return false
  mode = m
  return true
}

export function currentMode(): string {
  return mode
}

export type HudAnswer = { behavior: 'allow' | 'deny'; mode?: string; message?: string }

const MAX_SUMMARY = 200

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Hides values that look like secrets in a command line. */
function redact(text: string): string {
  return text
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=…')
    .replace(/(authorization|bearer|token|password|passwd|secret|api[-_]?key)(["':=\s]+)(?:(?:bearer|basic)\s+)?\S+/gi, '$1$2…')
    .replace(/\b(sk|ghp|gho|xox[a-z]|AKIA)[-_A-Za-z0-9]{12,}/g, '$1…')
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** A one-line, secret-free summary of a tool call for the prompt card. */
export function summarizeCall(tool: string, input: unknown): string {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const name = String(tool ?? '')
  let text = ''
  if (name === 'Bash' || name === 'PowerShell') {
    text = redact(str(o.command))
  } else if (str(o.file_path) || str(o.notebook_path)) {
    text = str(o.file_path) || str(o.notebook_path)
  } else if (str(o.url)) {
    try {
      const u = new URL(str(o.url))
      text = `${u.protocol}//${u.host}${u.pathname}`
    } catch {
      text = clip(str(o.url), 80).replace(/[?#].*$/, '')
    }
  } else if (str(o.pattern)) {
    text = `${redact(str(o.pattern))}${str(o.path) ? ` in ${str(o.path)}` : ''}`
  } else if (str(o.description) || str(o.query)) {
    text = redact(str(o.description) || str(o.query))
  } else {
    const keys = Object.keys(o).slice(0, 6)
    text = keys.length ? `args: ${keys.join(', ')}` : ''
  }
  return clip(text, MAX_SUMMARY)
}

/**
 * Puts a permission prompt to the HUD and waits (inside $.http.fetch, so the
 * hook's 10 s budget does not run) for the person's answer. undefined when no
 * HUD tab is open, on timeout, or on any error: the terminal prompt then shows.
 */
export async function askInHud(
  $: E,
  opts: {
    baseUrl: string
    token: string
    waitMs: number
    request: { id: string; tool: string; summary: string; mode: string }
  },
): Promise<HudAnswer | undefined> {
  try {
    const waitMs = Math.max(1000, Math.min(Math.floor(opts.waitMs) || 0, 300_000))
    const r = opts.request
    const res = await $.http.fetch(`${opts.baseUrl}/api/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orch-token': opts.token },
      body: JSON.stringify({
        id: r.id,
        tool: r.tool,
        summary: clip(r.summary, MAX_SUMMARY),
        mode: r.mode,
        waitMs,
      }),
    })
    if (!res.ok) return undefined
    const data = JSON.parse(res.text) as { answer?: unknown }
    const a = data?.answer as { behavior?: unknown; mode?: unknown; message?: unknown } | null | undefined
    if (!a || (a.behavior !== 'allow' && a.behavior !== 'deny')) return undefined
    const out: HudAnswer = { behavior: a.behavior }
    if (a.behavior === 'allow' && typeof a.mode === 'string' && SETTABLE.has(a.mode)) out.mode = a.mode
    if (typeof a.message === 'string' && a.message) out.message = clip(a.message, 300)
    return out
  } catch {
    return undefined
  }
}

/** The classic.PermissionRequest answer for a HUD answer (setMode on 'session' when a mode is chosen). */
export function toDecision(a: HudAnswer): unknown {
  if (a.behavior === 'deny') {
    return { behavior: 'deny', message: a.message || 'Denied in the orchestrator HUD.' }
  }
  if (a.mode && SETTABLE.has(a.mode)) {
    return {
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: a.mode, destination: 'session' }],
    }
  }
  return { behavior: 'allow' }
}
