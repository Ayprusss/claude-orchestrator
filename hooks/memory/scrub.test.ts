import { expect, test } from 'claude-code/testing'

import { REDACTED, isHighEntropy, scrub } from './scrub'

// Fixed fake secrets (never real): the right shape and length for each rule.
const B62 = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2dE3fG4hJ5'
const GHP = 'ghp_' + B62.slice(0, 36)
const SK_ANT = 'sk-ant-api03-' + 'x7Yq_2Lm-9Pz' + B62.slice(0, 28)
const SK = 'sk-proj-' + B62.slice(0, 32)
const AWS = 'AKIAIOSFODNN7EXAMPLE'
const SLACK = 'xox' + 'b-1234567890-0987654321-' + B62.slice(0, 24)
const GOOGLE = 'AIza' + 'SyA-' + B62.slice(0, 31)
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

test('each known token shape is redacted', async () => {
  for (const secret of [GHP, SK_ANT, SK, AWS, SLACK, GOOGLE, JWT, 'github_pat_11ABCDEFG0' + B62.slice(0, 30)]) {
    const out = scrub(`before ${secret} after`)
    expect(out).toBe(`before ${REDACTED} after`)
  }
})

test('gho_ and ghs_ tokens are redacted too', async () => {
  expect(scrub('gho_' + B62.slice(0, 36))).toBe(REDACTED)
  expect(scrub('token in env: ghs_' + B62.slice(0, 36))).not.toContain('ghs_')
})

test('a private key block is redacted whole, even when clipped', async () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nq83kd\n-----END RSA PRIVATE KEY-----'
  expect(scrub(`key:\n${pem}\nnext line`)).toBe(`key:\n${REDACTED}\nnext line`)
  expect(scrub('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk')).toBe(REDACTED)
})

test('secret-named pairs keep the key and lose the value', async () => {
  expect(scrub('DB_PASSWORD=hunter2bunny')).toBe(`DB_PASSWORD=${REDACTED}`)
  expect(scrub('export AUTH_TOKEN=abcdefghij')).toBe(`export AUTH_TOKEN=${REDACTED}`)
  expect(scrub('{"api_key": "abcd1234efgh", "name": "demo"}')).toBe(`{"api_key": "${REDACTED}", "name": "demo"}`)
  expect(scrub("client_secret: 'sup3rs3cret'")).toBe(`client_secret: '${REDACTED}'`)
  expect(scrub('password: hunter2')).toBe(`password: ${REDACTED}`)
  expect(scrub('--password=letmein99 --verbose')).toBe(`--password=${REDACTED} --verbose`)
  expect(scrub('Authorization: Bearer abc123def456ghi789')).toBe(`Authorization: Bearer ${REDACTED}`)
  expect(scrub('postgres://admin:s3cretpw@db.local:5432/app')).toBe(`postgres://admin:${REDACTED}@db.local:5432/app`)
})

test('long high-entropy strings are redacted', async () => {
  expect(scrub(`blob ${B62} end`)).toBe(`blob ${REDACTED} end`)
  expect(isHighEntropy('Zk9+Qm2/Lp7xVw4Rt8sNb3Hc6Yd1Jf5Ga0Ue==')).toBe(true)
})

test('git SHAs, hashes in file names and UUIDs are left alone', async () => {
  const keep = [
    'commit 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a merged into main',
    'wrote dist/bundle.3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e.js',
    'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'task 65a5d97f-a041-4efe-8dd5-adb5d0c82d18 finished',
    'C:/Users/AnthonyPC/AppData/Local/Temp/claude/65a5d97f/scratchpad/notes.txt',
  ]
  for (const text of keep) expect(scrub(text)).toBe(text)
})

test('ordinary prose and code are left alone', async () => {
  const keep = [
    'Added a rate limiter to the login route and updated the tests.',
    'Auth: added the middleware to routes.',
    'author: Anthony Le',
    'max_tokens=4000, maxTokens: 1200, tokens: 5',
    'hooks/auth/token.ts:120:5 failed with TypeError',
    'type Creds = { password: string; token?: string }',
    'const token = process.env.GITHUB_TOKEN',
    'const apiKey = getApiKey()',
    'Basic authentication is used for the admin panel.',
    'handleOAuth2CallbackForProvider123 calls getUserByIdWithPermissions2',
    'const MAX_SUMMARY_LENGTH_FOR_DETAILED_MODE_V2 = 3000',
    'Run `claude plugin test .` from the repo root; the tokenizer drops stop words.',
    'branch mem/c-summarize-2026-10-26-feature-branch-name',
  ]
  for (const text of keep) expect(scrub(text)).toBe(text)
})

test('scrubbing is idempotent and safe on empty input', async () => {
  const text = `DB_PASSWORD=hunter2bunny ${GHP} ${JWT} "secret": "abcdef12"`
  const once = scrub(text)
  expect(scrub(once)).toBe(once)
  expect(once).not.toContain('hunter2')
  expect(scrub('')).toBe('')
})
