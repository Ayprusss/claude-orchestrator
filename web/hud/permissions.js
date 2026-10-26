// HUD module: permission mode and permission prompts (HUD_CONTROLS_PLAN.md, unit P).
// Talks to the HUD only through window.HUD, plus one fetch to the answer route.
;(() => {
  'use strict'
  const HUD = window.HUD
  if (!HUD) return

  const MODE_CYCLE = ['auto', 'plan', 'default', 'acceptEdits']
  const MODE_LABEL = {
    auto: 'Auto Mode',
    plan: 'Planning Mode',
    default: 'Manual Mode',
    acceptEdits: 'Accept Edits On',
    bypassPermissions: 'Bypass Permissions',
    dontAsk: "Don't Ask",
  }
  const label = m => MODE_LABEL[m] || m || '...'
  const KEY_NEXT = 'orchhud.permNext'

  const load = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY_NEXT))
      return MODE_CYCLE.includes(v) ? v : ''
    } catch {
      return ''
    }
  }
  const save = v => {
    try {
      localStorage.setItem(KEY_NEXT, JSON.stringify(v))
    } catch {}
  }

  let mode = ''
  let next = load()
  let isOn = true
  let waitSec = 60
  const cards = new Map() // id -> { el, until, countEl }

  // ---- styles -----------------------------------------------------------
  const style = document.createElement('style')
  style.textContent = `
.pm-wrap { display: inline-flex; align-items: center; gap: 6px; margin-right: 8px; }
.pm-badge, .pm-chip { font: 11px var(--mono); letter-spacing: .06em; padding: 4px 9px; border: 1px solid var(--line); white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.pm-badge { color: var(--cyan); }
.pm-badge[data-mode="auto"] { color: var(--green); }
.pm-badge[data-mode="plan"] { color: var(--violet, #8ea6ff); }
.pm-badge[data-mode="acceptEdits"], .pm-badge[data-mode="bypassPermissions"] { color: var(--amber); }
.pm-chip { color: var(--amber); border-color: var(--amber); background: transparent; cursor: pointer; }
.pm-chip[hidden] { display: none; }
#pmOverlay { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 10px; width: min(560px, calc(100vw - 24px)); pointer-events: none; }
.pm-card { pointer-events: auto; background: rgba(4, 16, 26, .96); border: 1px solid var(--amber); box-shadow: 0 0 24px rgba(255, 181, 71, .25); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; font-family: var(--mono); }
.pm-top { display: flex; align-items: baseline; gap: 10px; }
.pm-title { color: var(--amber); font-size: 11px; letter-spacing: .14em; }
.pm-tool { color: var(--text); font-size: 14px; font-weight: 500; }
.pm-count { margin-left: auto; color: var(--muted); font-size: 11px; }
.pm-sum { color: var(--text); font-size: 12px; word-break: break-word; background: rgba(92, 225, 255, .06); border: 1px solid var(--line); padding: 6px 8px; max-height: 5.2em; overflow: hidden; }
.pm-btns { display: flex; flex-wrap: wrap; gap: 8px; }
.pm-btns button { font: 12px var(--mono); padding: 6px 12px; border: 1px solid var(--line-2); background: transparent; color: var(--text); cursor: pointer; }
.pm-btns button:hover { background: rgba(92, 225, 255, .12); }
.pm-btns .pm-allow { border-color: var(--green); color: var(--green); }
.pm-btns .pm-switch { border-color: var(--amber); color: var(--amber); }
.pm-btns .pm-deny { border-color: var(--red); color: var(--red); }
.pm-btns kbd { font: inherit; opacity: .6; margin-right: 5px; }
.pm-note { color: var(--muted); font-size: 11px; }
.pm-set .pm-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.pm-set .pm-num { font: 14px var(--mono); min-width: 52px; text-align: center; color: var(--cyan); }
`
  document.head.appendChild(style)

  // ---- header: mode badge and next chip ----------------------------------
  const wrap = document.createElement('span')
  wrap.className = 'pm-wrap'
  const badge = document.createElement('span')
  badge.className = 'pm-badge'
  badge.title = 'The current permission mode. Shift+Tab picks the next one.'
  const chip = document.createElement('button')
  chip.className = 'pm-chip'
  chip.type = 'button'
  chip.title = 'Applied with the next permission prompt you answer here. Click or press Esc to clear.'
  chip.onclick = () => setNext('')
  wrap.append(badge, chip)
  const header = HUD.slot('header')
  if (header) header.appendChild(wrap)

  function renderMode() {
    badge.textContent = label(mode)
    badge.dataset.mode = mode
    chip.hidden = !next
    chip.textContent = next ? 'next: ' + label(next) : ''
    for (const c of cards.values()) renderButtons(c)
  }

  function setNext(v) {
    next = v
    save(v)
    renderMode()
  }

  function cycleNext() {
    const from = MODE_CYCLE.indexOf(next || mode)
    let i = from
    for (let n = 0; n < MODE_CYCLE.length; n++) {
      i = (i + 1) % MODE_CYCLE.length
      if (MODE_CYCLE[i] !== mode) break
    }
    setNext(MODE_CYCLE[i])
    HUD.toast('Next mode: ' + label(next) + ' (applies at the next permission prompt you answer here)')
  }

  document.addEventListener(
    'keydown',
    e => {
      if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        cycleNext()
      } else if (e.key === 'Escape' && next) {
        setNext('')
      } else if (cards.size && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const t = e.target
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
        const id = cards.keys().next().value
        if (e.key === '1') answer(id, 'allow')
        else if (e.key === '2' && next) answer(id, 'allow', next)
        else if (e.key === '3') answer(id, 'deny')
        else return
        e.preventDefault()
      }
    },
    true,
  )

  // ---- prompt cards --------------------------------------------------------
  const overlay = document.createElement('div')
  overlay.id = 'pmOverlay'
  const overlaySlot = HUD.slot('overlay')
  if (overlaySlot) overlaySlot.appendChild(overlay)

  function renderButtons(c) {
    const e = HUD.esc
    c.btns.innerHTML =
      '<button class="pm-allow" data-a="allow"><kbd>1</kbd>Allow</button>' +
      (next
        ? '<button class="pm-switch" data-a="switch"><kbd>2</kbd>Allow and switch to ' + e(label(next)) + '</button>'
        : '') +
      '<button class="pm-deny" data-a="deny"><kbd>3</kbd>Deny</button>'
  }

  function addCard(p) {
    if (!p || !p.id || cards.has(p.id)) return
    const e = HUD.esc
    const el = document.createElement('div')
    el.className = 'pm-card'
    el.setAttribute('role', 'alertdialog')
    el.innerHTML =
      '<div class="pm-top"><span class="pm-title">PERMISSION</span><span class="pm-tool">' +
      e(p.tool || '') +
      '</span><span class="pm-count"></span></div>' +
      '<div class="pm-sum">' + e(p.summary || '(no details)') + '</div>' +
      '<div class="pm-btns"></div>' +
      '<div class="pm-note">Unanswered prompts fall back to the terminal. In auto mode, prompts are rare, so a mode switch may wait.</div>'
    const c = { el, until: Number(p.until) || Date.now() + 60000, count: el.querySelector('.pm-count'), btns: el.querySelector('.pm-btns') }
    renderButtons(c)
    c.btns.addEventListener('click', ev => {
      const a = ev.target && ev.target.closest && ev.target.closest('button')
      if (!a) return
      const kind = a.dataset.a
      if (kind === 'switch') answer(p.id, 'allow', next)
      else answer(p.id, kind)
    })
    cards.set(p.id, c)
    overlay.appendChild(el)
    tick()
  }

  function removeCard(id) {
    const c = cards.get(id)
    if (!c) return
    c.el.remove()
    cards.delete(id)
  }

  function tick() {
    const t = Date.now()
    for (const [id, c] of cards) {
      const left = Math.ceil((c.until - t) / 1000)
      if (left <= -3) removeCard(id)
      else c.count.textContent = left > 0 ? left + ' s' : 'terminal'
    }
  }
  setInterval(tick, 500)

  async function answer(id, behavior, chosenMode) {
    if (!cards.has(id)) return
    const body = { id, behavior }
    if (behavior === 'allow' && chosenMode) body.mode = chosenMode
    removeCard(id)
    try {
      const r = await fetch('/api/permission/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orch-token': HUD.token },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        HUD.toast('That prompt already closed; use the terminal.', 'error')
      } else if (body.mode) {
        setNext('')
        HUD.toast('Allowed. Switching to ' + label(body.mode) + '.')
      }
    } catch {
      HUD.toast('Could not reach the HUD server.', 'error')
    }
  }

  // ---- settings section ----------------------------------------------------
  const sec = document.createElement('section')
  sec.className = 'set-row pm-set'
  sec.innerHTML =
    '<div class="set-head"><h3>PERMISSION PROMPTS</h3></div>' +
    '<button class="switch" id="pmSwitch" role="switch" aria-checked="true"><span class="track"></span><span class="lbl">Answer permission prompts here</span></button>' +
    '<div class="set-desc"><b>On:</b> prompts show in the HUD with Allow, Allow and switch mode, and Deny. If no HUD tab is open, or time runs out, the terminal prompt shows as usual.</div>' +
    '<div class="pm-row"><button class="icon-btn" id="pmMinus" aria-label="Wait less">&minus;</button><span class="pm-num" id="pmNum"></span><button class="icon-btn" id="pmPlus" aria-label="Wait more">+</button><span class="set-desc">seconds to wait for an answer</span></div>'
  const settingsSlot = HUD.slot('settings')
  if (settingsSlot) settingsSlot.appendChild(sec)
  const $ = id => sec.querySelector('#' + id)

  function renderSettings() {
    const sw = $('pmSwitch')
    sw.setAttribute('aria-checked', String(isOn))
    $('pmNum').textContent = waitSec + ' s'
  }
  $('pmSwitch').onclick = () => {
    isOn = !isOn
    renderSettings()
    HUD.command({ type: 'settings', isHudPermissionsOn: isOn })
  }
  let waitTimer
  const stepWait = d => {
    waitSec = Math.max(15, Math.min(300, waitSec + d))
    renderSettings()
    clearTimeout(waitTimer)
    waitTimer = setTimeout(() => HUD.command({ type: 'settings', hudPermissionWaitSec: waitSec }), 300)
  }
  $('pmMinus').onclick = () => stepWait(-15)
  $('pmPlus').onclick = () => stepWait(15)

  // ---- events ----------------------------------------------------------------
  function readSnapshot(s) {
    if (!s) return
    const m = s.session && s.session.mode
    if (typeof m === 'string' && m !== mode) {
      mode = m
      if (next && next === mode) setNext('')
    }
    if (typeof s.isHudPermissionsOn === 'boolean') isOn = s.isHudPermissionsOn
    if (Number.isFinite(s.hudPermissionWaitSec)) waitSec = s.hudPermissionWaitSec
    renderMode()
    renderSettings()
  }
  HUD.on('snapshot', readSnapshot)
  HUD.on('hello', m => {
    readSnapshot(m.snapshot)
    for (const id of [...cards.keys()]) removeCard(id)
    for (const p of m.permissions || []) addCard(p)
  })
  HUD.on('permission', addCard)
  HUD.on('permission-closed', m => removeCard(m.id))

  readSnapshot(HUD.state())
  renderMode()
  renderSettings()
})()
