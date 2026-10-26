import { expect, test } from 'claude-code/testing'

import { memoryPaths, normalizePath, projectKey, resolveMemoryRoot } from './paths'

test('Windows paths get forward slashes, no trailing slash, and lower case', async () => {
  expect(normalizePath('D:\\Coding_Files\\Claude-Orchestrator\\')).toBe('d:/coding_files/claude-orchestrator')
  expect(normalizePath('D:/Coding_Files/Repo/')).toBe('d:/coding_files/repo')
  expect(normalizePath('C:\\Users\\Me\\\\Repo')).toBe('c:/users/me/repo')
  expect(normalizePath('  C:\\Repo  ')).toBe('c:/repo')
})

test('POSIX paths keep their case and lose only the trailing slash', async () => {
  expect(normalizePath('/home/Me/Repo/')).toBe('/home/Me/Repo')
  expect(normalizePath('/home/Me//Repo')).toBe('/home/Me/Repo')
  expect(normalizePath('/home/Me/Repo')).toBe('/home/Me/Repo')
})

test('roots stay roots', async () => {
  expect(normalizePath('/')).toBe('/')
  expect(normalizePath('C:\\')).toBe('c:/')
  expect(normalizePath('c:/')).toBe('c:/')
})

test('a project key is a slug of the folder name and 8 hex digits', async () => {
  const key = projectKey('D:\\coding_files\\Claude Orchestrator')
  expect(/^claude-orchestrator-[0-9a-f]{8}$/.test(key)).toBe(true)
  expect(/^repo-[0-9a-f]{8}$/.test(projectKey('/home/me/repo/'))).toBe(true)
  // FNV-1a of "a" is e40c292c.
  expect(projectKey('a')).toBe('a-e40c292c')
})

test('the hash is stable for the same project, with or without a trailing slash', async () => {
  const key = projectKey('D:\\coding_files\\repo')
  expect(projectKey('D:\\coding_files\\repo\\')).toBe(key)
  expect(projectKey('d:/coding_files/repo/')).toBe(key)
  expect(projectKey('D:/Coding_Files/Repo')).toBe(key)
  expect(projectKey('/home/me/repo/')).toBe(projectKey('/home/me/repo'))
})

test('different folders with the same name get different keys', async () => {
  const a = projectKey('/home/me/a/repo')
  const b = projectKey('/home/me/b/repo')
  expect(a.startsWith('repo-')).toBe(true)
  expect(b.startsWith('repo-')).toBe(true)
  expect(a === b).toBe(false)
  // POSIX paths are case-sensitive.
  expect(projectKey('/home/me/Repo') === projectKey('/home/me/repo')).toBe(false)
})

test('slugs are cleaned and clipped to 40 characters', async () => {
  expect(projectKey('/x/My Project (v2)!').startsWith('my-project-v2-')).toBe(true)
  const long = projectKey(`/x/${'abcdefghij'.repeat(6)}`)
  expect(long.length).toBe(40 + 1 + 8)
  expect(/^[a-z0-9-]+$/.test(long)).toBe(true)
  // A clip that ends on a separator does not leave a dangling dash.
  expect(/^a{39}-[0-9a-f]{8}$/.test(projectKey(`/x/${'a'.repeat(39)} b`))).toBe(true)
  expect(/^project-[0-9a-f]{8}$/.test(projectKey('/x/日本語'))).toBe(true)
  expect(/^project-[0-9a-f]{8}$/.test(projectKey('/'))).toBe(true)
})

test('the memory root comes from the setting, else the home folder, else nothing', async () => {
  expect(resolveMemoryRoot({ setting: 'E:\\Memory\\', homeDir: 'C:\\Users\\Me' })).toBe('e:/memory')
  expect(resolveMemoryRoot({ setting: '', homeDir: 'C:\\Users\\Me' })).toBe('c:/users/me/.claude/orchestrator-memory')
  expect(resolveMemoryRoot({ setting: '  ', homeDir: '/home/me/' })).toBe('/home/me/.claude/orchestrator-memory')
  expect(resolveMemoryRoot({ setting: '' })).toBeUndefined()
  expect(resolveMemoryRoot({ setting: '', homeDir: '' })).toBeUndefined()
})

test('the layout follows the plan', async () => {
  const p = memoryPaths('/home/me/.claude/orchestrator-memory/')
  const r = '/home/me/.claude/orchestrator-memory'
  expect(p.root).toBe(r)
  expect(p.versionFile).toBe(`${r}/VERSION`)
  expect(p.ledgersDir).toBe(`${r}/ledgers`)
  expect(p.ledgerFile('s1')).toBe(`${r}/ledgers/s1.json`)
  expect(p.projectDir('repo-0a1b2c3d')).toBe(`${r}/projects/repo-0a1b2c3d`)
  expect(p.metaFile('k')).toBe(`${r}/projects/k/meta.json`)
  expect(p.knowledgeFile('k')).toBe(`${r}/projects/k/knowledge.md`)
  expect(p.lockFile('k')).toBe(`${r}/projects/k/knowledge.lock`)
  expect(p.journalDir('k')).toBe(`${r}/projects/k/journal`)
  expect(p.journalFile('k', 's1')).toBe(`${r}/projects/k/journal/s1.jsonl`)
  expect(p.journalFile('k', 's1', 0)).toBe(`${r}/projects/k/journal/s1.jsonl`)
  expect(p.journalFile('k', 's1', 2)).toBe(`${r}/projects/k/journal/s1.2.jsonl`)
  expect(p.transcriptFile('k', 't9')).toBe(`${r}/projects/k/transcripts/t9.md`)
})

test('ids cannot escape their folder', async () => {
  const p = memoryPaths('c:/mem')
  expect(p.ledgerFile('../x')).toBe('c:/mem/ledgers/___x.json')
  expect(p.journalFile('k', 'a/b.c')).toBe('c:/mem/projects/k/journal/a_b_c.jsonl')
  const uuid = '3f2a9c1e-0b7d-4e5f-9a1b-2c3d4e5f6a7b'
  expect(p.ledgerFile(uuid)).toBe(`c:/mem/ledgers/${uuid}.json`)
  expect(memoryPaths('/').versionFile).toBe('/VERSION')
  expect(memoryPaths('c:/').versionFile).toBe('c:/VERSION')
})
