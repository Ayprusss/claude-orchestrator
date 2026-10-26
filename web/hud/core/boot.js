// HUD core: boot. Plain script; shares the namespace window.HUDCORE with the other core scripts.
(() => {
'use strict'
const N = window.HUDCORE || (window.HUDCORE = {})
const { TOKEN, $, store, S, listeners, drawerHooks, HUD_MODULES, command, connect, setLinked, setParallel, renderSettings, openSettings, standby, esc, renderTasks, tickElapsed, renderStats, select, renderComms, plain, renderPhase, input, setMode, send, autosize, toast, Voice, Diffs } = N

// ======================================================================
// Wiring
// ======================================================================
$('tasks').addEventListener('click', e => {
  const b = e.target.closest('.task')
  if (b) select(b.dataset.id === S.selected ? null : b.dataset.id)
})
$('dClose').onclick = () => select(null)
$('dActions').addEventListener('click', e => {
  const b = e.target.closest('[data-act]')
  if (!b || !S.selected) return
  const act = b.dataset.act
  command({ type: act, id: S.selected })
  if (act === 'remove') select(null)
})
$('clearBtn').onclick = () => command({ type: 'clear' })
$('gear').onclick = () => openSettings(!S.settingsOpen)
$('sClose').onclick = () => openSettings(false)
$('parMinus').onclick = () => setParallel((S.maxParallel || 1) - 1, true)
$('parPlus').onclick = () => setParallel((S.maxParallel || 0) + 1, true)
$('parRange').addEventListener('input', e => setParallel(Number(e.target.value), false))
$('standbySwitch').onclick = () => {
  S.isStandbyOnLimit = !S.isStandbyOnLimit
  renderSettings(); renderTasks(); renderPhase()
  command({ type: 'settings', isStandbyOnLimit: S.isStandbyOnLimit })
}
$('pingSwitch').onclick = () => {
  S.isPingOn = !S.isPingOn
  renderSettings()
  command({ type: 'settings', isPingOn: S.isPingOn })
}
$('pingTest').onclick = () => command({ type: 'ping' })
$('diffSizeReset').onclick = () => { Diffs.resetSize(); toast('Diff windows back to the default size.') }
$('diffSwitch').onclick = () => {
  S.isDiffViewOn = !S.isDiffViewOn
  renderSettings()
  command({ type: 'settings', isDiffViewOn: S.isDiffViewOn })
}
// Any "VIEW" link: Comms, the task drawer.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-diff]')
  if (b) Diffs.openDiff(b.dataset.diff)
})
const resume = () => command({ type: 'resume' })
$('lbResume').onclick = resume
$('standbyBox').addEventListener('click', e => { if (e.target.closest('[data-resume]')) resume() })
$('modeTalk').onclick = () => setMode('talk')
$('modeDispatch').onclick = () => setMode('dispatch')
$('send').onclick = send
$('mic').onclick = () => Voice.listen()
$('voice').onclick = () => {
  S.voiceOn = !S.voiceOn
  store.set('voice', S.voiceOn)
  $('voice').classList.toggle('on', S.voiceOn)
  if (!S.voiceOn) Voice.stop()
  else toast('Replies will be read aloud.')
}
$('voice').classList.toggle('on', S.voiceOn)
input.addEventListener('input', autosize)
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
})
addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (S.selected) select(null)
    else if (S.settingsOpen) openSettings(false)
    else Diffs.closeAll()
    Voice.stop()
  }
  if (e.key === '/' && document.activeElement !== input && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault(); input.focus()
  }
})

// ======================================================================
// Modules: web/hud/*.js extend the HUD through window.HUD
// ======================================================================
// Each module is a plain script that runs after this one. It reads state,
// listens to events, sends commands and draws into its slots; it never
// edits this file's internals.
window.HUD = Object.freeze({
  /** Sends a command to the plugin (POST /api/command); resolves true when accepted. */
  command,
  /** The live state object (read only by convention): tasks, projects, snapshot fields. */
  state: () => S,
  /** Calls fn(event) for every SSE event of `type` ('*' for all), after the HUD's own handling. */
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(fn)
  },
  /** Calls fn(task, slotEl) each time the task drawer draws; the slot is cleared first. */
  onDrawer(fn) { drawerHooks.push(fn) },
  /** Fields merged into every dispatch command this HUD sends, e.g. { model, effort }. */
  setDispatchExtras(extras) { N.dispatchExtras = { ...(extras || {}) } },
  /** A mount point: 'header', 'dispatch', 'drawer', 'settings' or 'overlay'. */
  slot: name => $('slot' + name[0].toUpperCase() + name.slice(1)),
  toast: (text, level) => toast(text, level),
  esc,
  token: TOKEN,
})
for (const name of HUD_MODULES) {
  const el = document.createElement('script')
  el.src = 'hud/' + name + '.js?t=' + encodeURIComponent(TOKEN)
  el.defer = true
  document.body.appendChild(el)
}

setMode(S.mode)
setLinked(false)
renderTasks(); renderComms(); renderStats()
setInterval(tickElapsed, 1000)
tickElapsed()
connect()
Object.assign(N, { resume })
})()
