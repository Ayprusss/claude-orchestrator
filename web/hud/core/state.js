// HUD core: state. Plain script; shares the namespace window.HUDCORE with the other core scripts.
(() => {
'use strict'
const N = window.HUDCORE || (window.HUDCORE = {})
const onMessage = (...a) => N.onMessage(...a)
const md = (...a) => N.md(...a)
const renderComms = (...a) => N.renderComms(...a)
const renderStreaming = (...a) => N.renderStreaming(...a)
const renderSubtitle = (...a) => N.renderSubtitle(...a)
const allClear = (...a) => N.allClear(...a)
const setPhase = (...a) => N.setPhase(...a)
const renderPhase = (...a) => N.renderPhase(...a)
const toast = (...a) => N.toast(...a)
const shortPath = (...a) => N.shortPath(...a)
const diffCount = (...a) => N.diffCount(...a)
const resume = (...a) => N.resume(...a)
const Voice = new Proxy({}, { get: (_, k) => N.Voice[k] })
const Orb = new Proxy({}, { get: (_, k) => N.Orb[k] })
const Diffs = new Proxy({}, { get: (_, k) => N.Diffs[k] })

// ======================================================================
// State and transport
// ======================================================================
const TOKEN = new URLSearchParams(location.search).get('t') || ''
const $ = id => document.getElementById(id)
const store = {
  get(k, d) { try { const v = localStorage.getItem('orchhud.' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('orchhud.' + k, JSON.stringify(v)) } catch {} },
}

const S = {
  tasks: [], projects: [], maxParallel: 0, skew: 0,
  phase: 'idle', tool: '', partial: '', partialAt: 0,
  messages: [], pending: [],
  selected: null, mode: store.get('mode', 'talk'),
  voiceOn: store.get('voice', false), linked: false, listening: false,
  limit: { isLimited: false, until: 0, since: 0, kind: '', reason: '' },
  usage: [], isStandbyOnLimit: true, maxCap: 16, settingsOpen: false,
  diffs: [], isDiffViewOn: true, isPingOn: true,
}

const now = () => Date.now() + S.skew

// Extension points for web/hud/*.js modules (see window.HUD below).
const listeners = new Map()
const drawerHooks = []
// Fields a module adds to every dispatch command (model, effort).
N.dispatchExtras = {}
const HUD_MODULES = ['session', 'tasks', 'permissions']

async function command(cmd) {
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orch-token': TOKEN },
      body: JSON.stringify(cmd),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return true
  } catch (e) {
    toast('Link error: ' + e.message, 'error')
    return false
  }
}

function connect() {
  const es = new EventSource('/api/events?t=' + encodeURIComponent(TOKEN))
  es.onopen = () => setLinked(true)
  es.onerror = () => setLinked(false)
  es.onmessage = ev => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    handle(m)
  }
}

function setLinked(on) {
  S.linked = on
  $('link').classList.toggle('on', on)
  $('linkText').textContent = on ? 'LINKED' : 'LINK LOST'
  renderPhase()
}

function handle(m) {
  switch (m.type) {
    case 'hello':
      if (m.snapshot) applySnapshot(m.snapshot, true)
      S.messages = m.messages || []
      S.diffs = m.diffs || []
      S.partial = m.partial || ''
      setPhase(m.phase?.phase || 'idle', m.phase?.tool)
      renderComms(); renderSubtitle()
      break
    case 'snapshot': applySnapshot(m, false); break
    case 'phase':
      setPhase(m.phase, m.tool)
      if (m.phase === 'thinking') { S.partial = ''; renderComms(); renderSubtitle() }
      break
    case 'delta':
      S.partial += m.text
      S.partialAt = performance.now()
      Orb.voice(Math.min(1, .35 + m.text.length / 60))
      renderStreaming(); renderSubtitle()
      break
    case 'msg': onMessage(m); break
    case 'diff': Diffs.add(m); break
    case 'ping': allClear(m.isTest); break
    case 'toast': toast(m.text, m.level); break
    // A resumed conversation's history, replacing what Comms shows.
    case 'history':
      S.messages = Array.isArray(m.messages) ? m.messages.slice(-150) : []
      renderComms()
      break
  }
  for (const fn of [...(listeners.get(m.type) || []), ...(listeners.get('*') || [])]) {
    try { fn(m) } catch (err) { console.error('HUD module:', err) }
  }
}

// ======================================================================
// Snapshot: tasks and projects
// ======================================================================
function applySnapshot(snap, isFirst) {
  S.skew = (snap.now || Date.now()) - Date.now()
  const before = new Map(S.tasks.map(t => [t.id, t.status]))
  S.tasks = snap.tasks || []
  S.projects = snap.projects || []
  S.maxParallel = snap.maxParallel || 0
  S.maxCap = snap.maxParallelCap || 16
  S.isStandbyOnLimit = snap.isStandbyOnLimit !== false
  S.isDiffViewOn = snap.isDiffViewOn !== false
  S.isPingOn = snap.isPingOn !== false
  S.usage = snap.usage || []
  setLimit(snap.limit || { isLimited: false }, isFirst)
  if (!isFirst) {
    for (const t of S.tasks) {
      const was = before.get(t.id)
      if (was === t.status) continue
      if (t.status === 'running') Orb.launch(t.id)
      else if (t.status === 'done' || t.status === 'failed') Orb.finish(t.id, t.status)
      else if (!was && t.status === 'queued') Orb.ripple()
    }
  }
  renderTasks(); renderStats(); renderProjects(); renderDrawer(); renderUsage(); renderSettings()
  Diffs.refresh()
}

// ---- usage limit --------------------------------------------------------
function setLimit(limit, isFirst) {
  const was = !!S.limit.isLimited
  S.limit = limit
  document.body.classList.toggle('limited', !!limit.isLimited)
  Orb.depleted(!!limit.isLimited)
  if (!isFirst && limit.isLimited && !was) {
    Voice.say('Warning. Token reserves depleted. ' + (S.isStandbyOnLimit ? 'All operations on standby.' : 'Standby is off.'), true)
  }
  if (!isFirst && !limit.isLimited && was) {
    Orb.restore()
    Voice.say('Reserves restored. Resuming operations.', true)
  }
  $('lbText').textContent = S.isStandbyOnLimit
    ? 'Operations on standby. Everything resumes when the usage limit resets.'
    : 'Standby is off: tasks keep launching and will fail until the limit resets.'
  tickLimit()
}

const fmtLong = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60
  return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + String(m).padStart(2, '0') + 'm ' + String(sec).padStart(2, '0') + 's'
}
const clockAt = ms => new Date(ms - S.skew).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })

function tickLimit() {
  if (!S.limit.isLimited) return
  const u = S.limit.until
  $('lbCount').textContent = u ? 'RESUMES IN ' + fmtLong(u - now()) : 'CHECKING FOR RESET...'
  $('lbCount').title = u ? 'Resets ' + clockAt(u) : 'The reset time is unknown; checking every few minutes'
}

const meterClass = p => p >= 100 ? 'full' : p >= 80 ? 'warn' : ''
const SHORT = { five_hour: '5H', seven_day: '7D', seven_day_opus: '7D OPUS', spend_limit: 'SPEND' }

function renderUsage() {
  $('usage').innerHTML = S.usage.map(w => `
    <span class="u ${meterClass(w.percent)}" title="${esc(w.name)} limit: ${w.percent}% used${w.resetsAt ? ', resets ' + esc(clockAt(w.resetsAt)) : ''}">
      ${esc(SHORT[w.kind] || w.name.toUpperCase())}<span class="bar-o"><i style="width:${Math.min(100, w.percent)}%"></i></span><b>${Math.round(w.percent)}%</b>
    </span>`).join('')
}

// ---- settings drawer ----------------------------------------------------
let parTimer = 0
let parHoldUntil = 0 // ignore snapshots briefly while a change is in flight
function setParallel(n, isNow) {
  n = Math.max(1, Math.min(S.maxCap, Math.round(n)))
  S.maxParallel = n
  parHoldUntil = Date.now() + 1500
  $('parNum').textContent = n
  $('parRange').value = n
  renderStats()
  clearTimeout(parTimer)
  parTimer = setTimeout(() => command({ type: 'settings', maxParallel: n }), isNow ? 0 : 300)
}

function renderSettings() {
  if (Date.now() > parHoldUntil) {
    $('parRange').max = S.maxCap
    $('parMax').textContent = S.maxCap
    $('parRange').value = S.maxParallel || 1
    $('parNum').textContent = S.maxParallel || '-'
  }
  const psw = $('pingSwitch')
  psw.classList.toggle('on', S.isPingOn)
  psw.setAttribute('aria-checked', String(S.isPingOn))
  const dsw = $('diffSwitch')
  dsw.classList.toggle('on', S.isDiffViewOn)
  dsw.setAttribute('aria-checked', String(S.isDiffViewOn))
  const sw = $('standbySwitch')
  sw.classList.toggle('on', S.isStandbyOnLimit)
  sw.setAttribute('aria-checked', String(S.isStandbyOnLimit))
  $('standbyBox').innerHTML = S.limit.isLimited
    ? `<div class="standby-box"><b>${S.isStandbyOnLimit ? 'STANDBY ACTIVE' : 'LIMIT REACHED'}</b><span>${S.limit.until ? 'Resets ' + esc(clockAt(S.limit.until)) : 'Reset time unknown; checking every few minutes.'}</span><span>${esc(S.limit.reason || '')}</span><button class="ghost" data-resume>Resume now</button></div>`
    : ''
  $('meters').innerHTML = S.usage.length
    ? S.usage.map(w => `<div class="meter ${meterClass(w.percent)}"><span>${esc(w.name.toUpperCase())}</span><span class="bar-o"><i style="width:${Math.min(100, w.percent)}%"></i></span><span>${w.percent}%</span>${w.resetsAt ? `<small>resets ${esc(clockAt(w.resetsAt))}</small>` : ''}</div>`).join('')
    : '<div class="set-desc">No reading yet. Usage shows after the session makes a request (subscription plans only).</div>'
}

function openSettings(open) {
  S.settingsOpen = open
  $('settings').classList.toggle('open', open)
  $('settings').setAttribute('aria-hidden', String(!open))
  $('gear').classList.toggle('on', open)
  if (open) { select(null); renderSettings() }
}

const ORDER = { running: 0, queued: 1, failed: 2, done: 3, killed: 4 }
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  return m < 60 ? m + 'm' + String(s % 60).padStart(2, '0') + 's' : Math.floor(m / 60) + 'h' + (m % 60) + 'm'
}
const standby = t => t.status === 'queued' && ((S.limit.isLimited && S.isStandbyOnLimit) || t.interruptions > 0)
const elapsed = t => t.startedAt ? fmtDur((t.endedAt || now()) - t.startedAt) : standby(t) ? 'standby' : 'waiting'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function sortedTasks() {
  return [...S.tasks].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || ((b.startedAt || b.createdAt) - (a.startedAt || a.createdAt)))
}

function renderTasks() {
  const list = sortedTasks()
  $('opCount').textContent = list.length ? list.length + ' TOTAL' : ''
  if (!list.length) {
    $('tasks').innerHTML = '<div class="empty">No operations yet.<br><br>Talk to the orchestrator and ask it to run something, or switch to DISPATCH to queue a task directly.</div>'
    return
  }
  $('tasks').innerHTML = list.map(t => `
    <button class="task ${t.id === S.selected ? 'sel' : ''}" data-id="${esc(t.id)}">
      <span class="dot ${standby(t) ? 'standby' : t.status}"></span>
      <span class="t">${esc(t.title)}${diffCount(t.id) ? `<span class="badge">&#9998;${diffCount(t.id)}</span>` : ''}</span>
      <span class="el" data-el="${esc(t.id)}">${elapsed(t)}</span>
      <span class="m">${esc(t.project)} · ${esc(t.backend)}${t.model ? ' · ' + esc(t.model) : ''} · ${standby(t) ? 'standby' : t.status}</span>
    </button>`).join('')
}

function tickElapsed() {
  for (const el of document.querySelectorAll('[data-el]')) {
    const t = S.tasks.find(x => x.id === el.dataset.el)
    if (t && t.status === 'running') el.textContent = elapsed(t)
  }
  const d = new Date()
  $('clock').textContent = d.toTimeString().slice(0, 8)
  tickLimit()
}

function renderStats() {
  const c = s => S.tasks.filter(t => t.status === s).length
  $('sRun').textContent = c('running')
  $('sQueue').textContent = c('queued')
  $('sDone').textContent = c('done')
  $('sFail').textContent = c('failed')
  $('sLimit').textContent = S.maxParallel || '-'
  renderPhase()
}

function renderProjects() {
  const sel = $('dProject')
  const want = sel.value || store.get('project', '')
  const opts = S.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
  const key = S.projects.map(p => p.id + p.name).join('|')
  if (sel.dataset.key !== key) {
    sel.innerHTML = opts || '<option value="">no projects</option>'
    sel.dataset.key = key
    if (S.projects.some(p => p.id === want)) sel.value = want
  }
}

// ---- drawer ------------------------------------------------------------
function select(id) {
  if (id && S.settingsOpen) openSettings(false)
  S.selected = id
  renderTasks(); renderDrawer()
}

const STATUS_COLOR = { running: 'var(--amber)', queued: 'var(--slate)', done: 'var(--green)', failed: 'var(--red)', killed: 'var(--muted)' }

function renderDrawer() {
  const t = S.tasks.find(x => x.id === S.selected)
  const d = $('drawer')
  d.classList.toggle('open', !!t)
  d.setAttribute('aria-hidden', t ? 'false' : 'true')
  if (!t) return
  $('dTitle').textContent = t.title.toUpperCase()
  $('dKv').innerHTML = `
    <span>STATUS</span><span><span class="status-tag" style="color:${STATUS_COLOR[t.status]}">${t.status}</span></span>
    <span>ID</span><span>${esc(t.id)}</span>
    <span>PROJECT</span><span>${esc(t.project)}</span>
    <span>BACKEND</span><span>${esc(t.backend)}${t.model ? ' · ' + esc(t.model) : ''}</span>
    <span>ELAPSED</span><span>${elapsed(t)}</span>`
  $('dPrompt').textContent = t.prompt
  const mine = S.diffs.filter(d => d.taskId === t.id)
  $('dChanges').innerHTML = mine.length
    ? `<div class="block-label">CHANGES (${mine.length})</div><div class="changes">${mine.slice().reverse().map(d =>
        `<button class="dm" data-diff="${esc(d.id)}" title="${esc(d.file)}"><span class="path">${esc(shortPath(d.file))}</span><span class="add">+${d.added}</span><span class="del">&minus;${d.removed}</span><span class="view">VIEW</span></button>`).join('')}</div>`
    : ''
  const out = $('dOutput')
  const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 30
  out.textContent = t.output || '(no output yet)'
  if (atEnd) out.scrollTop = out.scrollHeight
  const live = t.status === 'running' || t.status === 'queued'
  $('dActions').innerHTML =
    (live ? '<button class="ghost warn" data-act="kill">Kill</button>' : '<button class="ghost" data-act="retry">Retry</button>') +
    (t.status !== 'running' ? '<button class="ghost warn" data-act="remove">Remove</button>' : '')
  $('slotDrawer').innerHTML = ''
  for (const fn of drawerHooks) {
    try { fn(t, $('slotDrawer')) } catch (err) { console.error('HUD module:', err) }
  }
}

Object.assign(N, { TOKEN, $, store, S, now, listeners, drawerHooks, HUD_MODULES, command, connect, setLinked, handle, applySnapshot, setLimit, fmtLong, clockAt, tickLimit, meterClass, SHORT, renderUsage, parTimer, parHoldUntil, setParallel, renderSettings, openSettings, ORDER, fmtDur, standby, elapsed, esc, sortedTasks, renderTasks, tickElapsed, renderStats, renderProjects, select, STATUS_COLOR, renderDrawer })
})()
