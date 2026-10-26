// Secret scrubbing for everything the memory harness writes (plan §11).
// Pure string work: no Node, no DOM. Replaces matches with `[redacted]`.
//
// Three passes, in order:
//   1. Known token shapes (private key blocks, sk-/ghp_/AKIA/xox?-/AIza/JWT, bearer
//      tokens, passwords in URLs).
//   2. `key=value`, `key: value` and `"key": "value"` pairs whose key names a secret.
//   3. Long high-entropy strings (32+ characters of base64-ish text with mixed
//      character classes).
// Left alone on purpose: pure hex runs (git SHAs, sha256/md5 digests, hashes in
// file names), UUIDs, paths, prose and code identifiers.

export const REDACTED = '[redacted]'

// ---- 1. Known token shapes ---------------------------------------------------

/** No letter, digit or `_` just before (so `task-sk-...` style words are not cut in half). */
const START = '(?<![A-Za-z0-9_])'
/** No token character just after. */
const END = '(?![A-Za-z0-9_-])'

const TOKEN_SHAPES: RegExp[] = [
  // PEM private keys; an unterminated block (clipped output) runs to the end.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // Anthropic and OpenAI style keys: sk-ant-..., sk-proj-..., sk-...
  new RegExp(`${START}sk-(?:ant-)?[A-Za-z0-9_-]{20,}${END}`, 'g'),
  // GitHub tokens.
  new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{30,}${END}`, 'g'),
  new RegExp(`${START}github_pat_[A-Za-z0-9_]{22,}${END}`, 'g'),
  // AWS access key ids.
  new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}${END}`, 'g'),
  // Slack tokens.
  new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}${END}`, 'g'),
  // Google API keys.
  new RegExp(`${START}AIza[0-9A-Za-z_-]{35}${END}`, 'g'),
  // JWTs: three base64url parts, the first a JSON header.
  new RegExp(`${START}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}${END}`, 'g'),
]

/** `Authorization: Bearer <token>` / `Basic <token>`: keep the scheme, drop the token. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/-]{12,}=*)/g

/** `scheme://user:password@host`: keep the user, drop the password. */
const URL_PASSWORD = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/g

function looksLikeOpaqueToken(token: string): boolean {
  return /\d/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token))
}

// ---- 2. Secret-named pairs ---------------------------------------------------

/**
 * A key that names a secret: token, secret, password, api key, auth, and kin.
 * `auth` must end the word (or be `authorization`), so `author` is not one.
 */
const SECRET_KEY =
  '[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|auth(?:orization)?(?![a-z])|credential|private[_-]?key|access[_-]?key|client[_-]?key)[A-Za-z0-9_.-]*'

/** "key": "value" / 'key': 'value' / key: "value" / key = 'value' — a quoted value. */
const QUOTED_PAIR = new RegExp(
  `(?<![A-Za-z0-9_.-])(["']?)(${SECRET_KEY})\\1(\\s*[:=]\\s*)(["'\`])([^"'\`\\n]+)\\4`,
  'gi',
)

/** KEY=value / key: value — an unquoted value. */
const BARE_PAIR = new RegExp(`(?<![A-Za-z0-9_.-])(${SECRET_KEY})(\\s*[:=]\\s*)([^\\s"'\`,;]+)`, 'gi')

/** Values that are a type, a placeholder or a reference, not a secret. */
const NOT_SECRET_VALUES = new Set([
  'string',
  'number',
  'boolean',
  'undefined',
  'null',
  'true',
  'false',
  'none',
  'required',
  'optional',
  'missing',
  'empty',
  'unset',
  'redacted',
  'placeholder',
  'example',
  'changeme',
])

function isPlausibleSecretValue(value: string): boolean {
  const v = value.trim()
  if (v.length < 6) return false
  if (v.includes(REDACTED)) return false
  if (/^[0-9:.,]+$/.test(v)) return false // counts, sizes, ports, versions, line:col
  if (/^[\[{(<$%]/.test(v)) return false // literals, templates, ${VAR}, %VAR%
  if (/^(?:process\.env|import\.meta\.env|os\.environ|env\.)/i.test(v)) return false
  if (/[()]/.test(v)) return false // a call: getToken(), env('X')
  if (NOT_SECRET_VALUES.has(v.toLowerCase())) return false
  if (/^\*+$/.test(v) || /^x+$/i.test(v) || /^\.{3,}$/.test(v) || v === '…') return false // already masked
  return true
}

/**
 * A bare value after `:` is often prose ("Auth: added the middleware"), so it
 * must also carry a digit or symbol. After `=` (env files, CLI flags) any
 * plausible value counts.
 */
function isBareSecretValue(value: string, sep: string): boolean {
  if (!isPlausibleSecretValue(value)) return false
  if (sep.includes('=')) return true
  return /[0-9!@#$%^&*+/~=_-]/.test(value)
}

// ---- 3. High-entropy strings ---------------------------------------------------

const ENTROPY_CANDIDATE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / s.length
    bits -= p * Math.log2(p)
  }
  return bits
}

function charClass(c: string): number {
  if (c >= 'a' && c <= 'z') return 0
  if (c >= 'A' && c <= 'Z') return 1
  if (c >= '0' && c <= '9') return 2
  return 3
}

/** How often the character class changes from one character to the next. */
function classSwitchRate(s: string): number {
  let switches = 0
  for (let i = 1; i < s.length; i++) if (charClass(s[i]!) !== charClass(s[i - 1]!)) switches++
  return switches / (s.length - 1)
}

/** A path segment that reads like a name: letters (and `-_.`), no digits, at most two camel humps. */
function isWordySegment(p: string): boolean {
  if (!/^[A-Za-z][A-Za-z_.-]{2,}$/.test(p)) return false
  const humps = p.match(/[a-z][A-Z]/g)?.length ?? 0
  return humps <= 2
}

/**
 * A file path, not a base64 blob: two or more slashes, and at least half of the
 * segments read like names. Random base64 almost never has both.
 */
function looksLikePath(s: string): boolean {
  const parts = s.split('/')
  const segments = parts.filter((p) => p !== '')
  if (parts.length < 3 || segments.length < 2) return false
  return segments.filter(isWordySegment).length * 2 >= segments.length
}

/**
 * Random-looking base64/base64url: mixed case and digits, high variety, and
 * frequent switches between character classes. CamelCase identifiers, paths,
 * SCREAMING_CASE and kebab-case names fail at least one of these.
 * Pure hex (with or without dashes: SHAs, digests, UUIDs) is never redacted.
 */
export function isHighEntropy(s: string): boolean {
  if (s.length < 32) return false
  if (/^[0-9a-fA-F-]+$/.test(s)) return false
  if (looksLikePath(s)) return false
  const core = s.replace(/=+$/, '')
  if (!/[a-z]/.test(core) || !/[A-Z]/.test(core) || !/[0-9]/.test(core)) return false
  if (shannonBitsPerChar(core) < 4) return false
  return classSwitchRate(core) >= 0.4
}

// ---- scrub -------------------------------------------------------------------

export function scrub(text: string): string {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : ''
  let out = text
  for (const re of TOKEN_SHAPES) out = out.replace(re, REDACTED)
  out = out.replace(AUTH_SCHEME, (m, scheme: string, gap: string, token: string) =>
    looksLikeOpaqueToken(token) ? `${scheme}${gap}${REDACTED}` : m,
  )
  out = out.replace(URL_PASSWORD, (_m, head: string) => `${head}${REDACTED}@`)
  out = out.replace(QUOTED_PAIR, (m, q1: string, key: string, sep: string, q2: string, value: string) =>
    isPlausibleSecretValue(value) ? `${q1}${key}${q1}${sep}${q2}${REDACTED}${q2}` : m,
  )
  out = out.replace(BARE_PAIR, (m, key: string, sep: string, value: string) =>
    isBareSecretValue(value, sep) ? `${key}${sep}${REDACTED}` : m,
  )
  out = out.replace(ENTROPY_CANDIDATE, (m) => (isHighEntropy(m) ? REDACTED : m))
  return out
}
