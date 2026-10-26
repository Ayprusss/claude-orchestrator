// HUD core: ui. Plain script; shares the namespace window.HUDCORE with the other core scripts.
(() => {
'use strict'
const N = window.HUDCORE || (window.HUDCORE = {})
const { $, store, S, command, esc, select } = N
const shortPath = (...a) => N.shortPath(...a)
const Voice = new Proxy({}, { get: (_, k) => N.Voice[k] })
const Orb = new Proxy({}, { get: (_, k) => N.Orb[k] })
const Diffs = new Proxy({}, { get: (_, k) => N.Diffs[k] })

// ======================================================================
// Conversation
// ======================================================================
function onMessage(m) {
  S.messages.push(m)
  if (S.messages.length > 150) S.messages.shift()
  if (m.role === 'user' && m.source === 'hud') {
    const i = S.pending.indexOf(m.text)
    if (i !== -1) S.pending.splice(i, 1)
  }
  if (m.role === 'assistant') {
    S.partial = ''
    Voice.say(m.text)
  }
  if (m.role === 'system' && m.status) {
    if (m.status === 'done' || m.status === 'failed') Voice.say(m.text, true)
  }
  renderComms(); renderSubtitle()
}

function md(text) {
  const parts = String(text).split(/```[\w-]*\n?/)
  return parts.map((part, i) => {
    if (i % 2) return '<pre><code>' + esc(part.replace(/\n$/, '')) + '</code></pre>'
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6} (.*)$/gm, '<strong>$1</strong>')
      .replace(/^\s*[-*] /gm, '• ')
      .replace(/\n/g, '<br>')
  }).join('')
}
const hhmm = at => at ? new Date(at - S.skew).toTimeString().slice(0, 5) : ''

function msgHtml(m, extra = '') {
  if (m.role === 'diff') {
    const o = Diffs.owner(Diffs.ownerKey(m))
    return `<div class="msg diffmsg ${extra}"><button class="dm" data-diff="${esc(m.id)}" title="${esc(m.file)}">
      <span class="dot" style="background:${o.color}"></span><span class="who">${esc(o.name)}</span>
      <span class="path">${esc(shortPath(m.file))}</span><span class="add">+${m.added}</span><span class="del">&minus;${m.removed}</span><span class="view">VIEW</span></button></div>`
  }
  const who = m.role === 'assistant' ? 'ORCHESTRATOR' : m.role === 'user' ? (m.source === 'hud' ? 'YOU · HUD' : m.source === 'history' ? 'YOU · EARLIER' : 'YOU · TERMINAL') : 'SYSTEM'
  if (m.role === 'system') {
    return `<div class="msg system ${esc(m.status || '')} ${extra}"><div class="body">◆ ${esc(m.text)}</div></div>`
  }
  return `<div class="msg ${m.role} ${extra}"><div class="who"><span>${who}</span><time>${hhmm(m.at)}</time></div><div class="body">${md(m.text)}</div></div>`
}

const seenMsgs = new Set()
function renderComms() {
  const el = $('comms')
  const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  const items = [...S.messages, ...S.diffs.map(d => ({ ...d, role: 'diff' }))]
    .sort((a, b) => (a.at || 0) - (b.at || 0))
  // Only entries not drawn before fade in; the rest stay put.
  let html = items.map(m => {
    const key = (m.id || '') + '|' + (m.at || 0) + '|' + (m.role || '') + '|' + String(m.text || '').length
    const isFresh = !seenMsgs.has(key)
    seenMsgs.add(key)
    return msgHtml(m, isFresh ? 'fresh' : '')
  }).join('')
  html += S.pending.map(text => msgHtml({ role: 'user', source: 'hud', text }, 'pending')).join('')
  if (S.partial) html += `<div class="msg assistant" id="streaming"><div class="who"><span>ORCHESTRATOR</span></div><div class="body caret">${md(S.partial)}</div></div>`
  if (!html) html = '<div class="empty">Say hello.<br><br>Messages here go to your Claude Code session, which can dispatch work across your projects. Replies stream back here.</div>'
  el.innerHTML = html
  $('msgCount').textContent = S.messages.length ? S.messages.length + ' MSG' : ''
  if (atEnd) el.scrollTop = el.scrollHeight
}

function renderStreaming() {
  const el = $('streaming')
  if (!el) return renderComms()
  const box = $('comms')
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60
  el.querySelector('.body').innerHTML = md(S.partial)
  if (atEnd) box.scrollTop = box.scrollHeight
}

const plain = s => String(s)
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/[`*_#>]/g, '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\s+/g, ' ').trim()

function renderSubtitle() {
  const el = $('subtitle')
  const text = plain(S.partial)
  el.textContent = text.length > 260 ? '…' + text.slice(-260) : text
  el.style.opacity = text ? 1 : 0
}

// ---- all work done ------------------------------------------------------
let allClearTimer = 0
function allClear(isTest) {
  Orb.allClear()
  const el = $('phaseLabel')
  el.parentElement.classList.add('allclear')
  el.textContent = isTest ? 'PING TEST' : 'ALL OPERATIONS COMPLETE'
  clearTimeout(allClearTimer)
  allClearTimer = setTimeout(() => { el.parentElement.classList.remove('allclear'); renderPhase() }, 4500)
}

// ---- phase ------------------------------------------------------------
function setPhase(p, tool) {
  S.phase = p
  S.tool = tool || ''
  Orb.phase(p)
  renderPhase()
}

function prettyTool(name) {
  if (!name) return ''
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  return (m ? m[2] : name).replace(/_/g, ' ').toUpperCase()
}

function renderPhase() {
  if ($('phaseLabel').parentElement.classList.contains('allclear')) return
  const running = S.tasks.filter(t => t.status === 'running').length
  let label
  if (!S.linked) label = 'OFFLINE'
  else if (S.limit.isLimited) label = S.isStandbyOnLimit ? 'RESERVES DEPLETED · STANDBY' : 'RESERVES DEPLETED'
  else if (S.listening) label = 'LISTENING'
  else if (S.phase === 'thinking') label = 'PROCESSING'
  else if (S.phase === 'speaking') label = 'TRANSMITTING'
  else if (S.phase === 'tool') label = 'EXECUTING'
  else label = running ? `MONITORING ${running} OPERATION${running === 1 ? '' : 'S'}` : 'STANDING BY'
  $('phaseLabel').textContent = label
  $('phaseTool').textContent = S.phase === 'tool' && !S.listening ? prettyTool(S.tool) : ''
}

// ======================================================================
// Input console
// ======================================================================
const input = $('input')

function setMode(mode) {
  S.mode = mode
  store.set('mode', mode)
  $('modeTalk').classList.toggle('on', mode === 'talk')
  $('modeDispatch').classList.toggle('on', mode === 'dispatch')
  $('console').classList.toggle('dispatch', mode === 'dispatch')
  input.placeholder = mode === 'talk'
    ? 'Speak or type to the orchestrator…'
    : 'Describe the task to run in the selected project…'
}

async function send() {
  const text = input.value.trim()
  if (!text) return
  if (S.mode === 'talk') {
    if (await command({ type: 'chat', text })) {
      S.pending.push(text)
      renderComms()
      Orb.ripple()
      input.value = ''
    }
  } else {
    const projectId = $('dProject').value
    if (!projectId) return toast('Register a project first (Projects tab in /orchestrator).', 'error')
    store.set('project', projectId)
    if (await command({ type: 'dispatch', projectId, title: '', prompt: text, backend: $('dBackend').value, model: $('dModel').value.trim(), ...N.dispatchExtras })) {
      input.value = ''
      Orb.ripple()
    }
  }
  autosize()
}

function autosize() {
  input.style.height = 'auto'
  input.style.height = Math.min(140, input.scrollHeight) + 'px'
}

function toast(text, level) {
  const el = document.createElement('div')
  el.className = 'toast' + (level === 'error' ? ' error' : '')
  el.textContent = text
  $('toasts').appendChild(el)
  setTimeout(() => el.remove(), 3600)
}

Object.assign(N, { onMessage, md, hhmm, msgHtml, seenMsgs, renderComms, renderStreaming, plain, renderSubtitle, allClearTimer, allClear, setPhase, prettyTool, renderPhase, input, setMode, send, autosize, toast })
})()
