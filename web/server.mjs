// The orchestrator HUD's local bridge. No dependencies: Node 18+.
//
// The mod starts this with `node server.mjs --port N --token T` and keeps it
// alive for the session. It talks to the mod in two directions:
//   mod -> browser: the mod POSTs /api/push; browsers get it over SSE.
//   browser -> mod: the browser POSTs /api/command; each command is written to
//                   stdout as one `CMD {json}` line, which the mod reads.
// Everything is bound to 127.0.0.1 and needs the session's token.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const TOKEN = arg('token') ?? ''
const WANT_PORT = Number(arg('port') ?? 4747)
const IDLE_EXIT_MS = 90_000 // no word from the mod for this long: exit
const MAX_PUSH = 2_000_000
const MAX_COMMAND = 64_000
const HISTORY = 150

if (!/^[A-Za-z0-9]{16,}$/.test(TOKEN)) {
  console.error('A --token of 16+ letters and digits is required.')
  process.exit(2)
}

// What a newly connected browser is sent first.
const state = { snapshot: null, phase: { type: 'phase', phase: 'idle' }, messages: [], diffs: [], partial: '' }
const clients = new Set()
let port = WANT_PORT
let lastHeard = Date.now()

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) res.write(line)
}

function remember(event) {
  switch (event.type) {
    case 'snapshot':
      state.snapshot = event
      break
    case 'phase':
      state.phase = event
      if (event.phase === 'thinking') state.partial = ''
      break
    case 'delta':
      state.partial = (state.partial + event.text).slice(-4000)
      break
    case 'diff':
      state.diffs.push(event)
      if (state.diffs.length > 60) state.diffs.shift()
      break
    case 'msg':
      state.messages.push(event)
      if (state.messages.length > HISTORY) state.messages.shift()
      if (event.role === 'assistant') state.partial = ''
      break
  }
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > cap) {
        reject(new Error('too large'))
        req.destroy()
      } else parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

const COMMANDS = new Set(['chat', 'dispatch', 'kill', 'retry', 'remove', 'clear', 'settings', 'resume', 'ping'])

const server = http.createServer(async (req, res) => {
  // Only this machine, by name: a page on another origin that resolves its
  // own hostname to 127.0.0.1 (DNS rebinding) is turned away here.
  const host = req.headers.host ?? ''
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return send(res, 403, { error: 'bad host' })
  }
  const url = new URL(req.url ?? '/', `http://${host}`)
  const headerOk = req.headers['x-orch-token'] === TOKEN
  const queryOk = url.searchParams.get('t') === TOKEN

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!queryOk) {
        return send(
          res,
          403,
          '<!doctype html><meta charset="utf-8"><title>Orchestrator HUD</title><body style="background:#03070d;color:#8fb3c9;font:15px system-ui;padding:40px">Open the HUD from Claude Code with <code>/orchestrator-hud</code>.',
          'text/html; charset=utf-8',
        )
      }
      // Read on each request so edits show on refresh.
      const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!queryOk) return send(res, 403, { error: 'bad token' })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('retry: 1500\n\n')
      res.write(`data: ${JSON.stringify({ type: 'hello', ...state })}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/push') {
      if (!headerOk) return send(res, 403, { error: 'bad token' })
      lastHeard = Date.now()
      const events = JSON.parse(await readBody(req, MAX_PUSH))
      for (const event of Array.isArray(events) ? events : [events]) {
        if (!event || typeof event.type !== 'string') continue
        remember(event)
        broadcast(event)
      }
      return send(res, 200, { ok: true, clients: clients.size })
    }

    if (req.method === 'POST' && url.pathname === '/api/command') {
      if (!headerOk) return send(res, 403, { error: 'bad token' })
      const cmd = JSON.parse(await readBody(req, MAX_COMMAND))
      if (!cmd || !COMMANDS.has(cmd.type)) return send(res, 400, { error: 'unknown command' })
      process.stdout.write(`CMD ${JSON.stringify(cmd)}\n`)
      return send(res, 202, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/open') {
      if (!headerOk) return send(res, 403, { error: 'bad token' })
      lastHeard = Date.now()
      const ok = openBrowser(`http://127.0.0.1:${port}/?t=${TOKEN}`)
      return send(res, 200, { ok })
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      if (!headerOk) return send(res, 403, { error: 'bad token' })
      lastHeard = Date.now()
      return send(res, 200, { ok: true, port, clients: clients.size })
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    send(res, 400, { error: String(err?.message ?? err) })
  }
})

// Keep SSE connections open through proxies and sleeping laptops.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 15_000).unref()

// The mod pushes a heartbeat every few seconds. If it stops (Claude Code
// exited without killing us), go away instead of lingering on the port.
setInterval(() => {
  if (Date.now() - lastHeard > IDLE_EXIT_MS) process.exit(0)
}, 5_000).unref()

// A previous server may still hold the port for a moment after a reload:
// retry it a few times, then move to the next port.
function listen(tryPort, attempt) {
  port = tryPort
  server.once('error', err => {
    if (err.code !== 'EADDRINUSE') throw err
    if (attempt < 4) setTimeout(() => listen(tryPort, attempt + 1), 400)
    else if (tryPort < WANT_PORT + 20) listen(tryPort + 1, 0)
    else listen(0, 0)
  })
  server.listen(tryPort, '127.0.0.1', () => {
    port = server.address().port
    process.stdout.write(`READY ${port}\n`)
  })
}
listen(WANT_PORT, 0)
