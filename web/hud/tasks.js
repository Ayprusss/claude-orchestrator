// Task model and effort: a picker beside dispatch, and the drawer's config.
(function () {
  'use strict'
  const HUD = window.HUD
  if (!HUD) return
  const KEY = 'orch.taskConfig'
  const FALLBACK_MODELS = [
    { id: '', label: 'Default' }, { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' }, { id: 'fable', label: 'Fable' },
  ]
  const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

  const pick = { model: '', effort: '' }
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (v && typeof v.model === 'string') pick.model = v.model
    if (v && typeof v.effort === 'string') pick.effort = v.effort
  } catch (e) { /* storage unavailable */ }

  const drafts = {} // task id -> { model, effort } edits not yet saved

  const style = document.createElement('style')
  style.textContent = `
#dModel { display: none; }
.tk-wrap { position: relative; display: inline-flex; align-items: center; gap: 8px; }
.tk-btn { background: rgba(2,10,16,.75); border: 1px solid var(--line); padding: 5px 8px; font: 12px var(--mono); color: var(--text); cursor: pointer; }
.tk-btn:hover { border-color: #5ce1ff; color: #5ce1ff; }
.tk-label { font: 11px var(--mono); letter-spacing: .08em; color: var(--muted); text-transform: uppercase; }
.tk-label.set { color: #5ce1ff; }
.tk-pop {
  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 30; min-width: 220px; display: none; flex-direction: column; gap: 8px; padding: 10px;
  background: #04121c; border: 1px solid #5ce1ff; box-shadow: 0 0 24px rgba(92,225,255,.18);
}
.tk-pop.open { display: flex; }
.tk-pop label, .tk-cfg label { display: flex; flex-direction: column; gap: 3px; font: 10px var(--mono); letter-spacing: .14em; color: var(--muted); }
.tk-pop select, .tk-cfg select {
  background: rgba(2,10,16,.9); border: 1px solid var(--line); padding: 5px 8px; font: 12px var(--mono); color: var(--text);
}
.tk-pop select option, .tk-cfg select option { background: #04121c; }
.tk-note { font: 10px var(--mono); color: var(--muted); }
.tk-cfg { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.tk-cfg .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.tk-cfg .row label { flex: 1; min-width: 110px; }
.tk-cfg .kv { font: 12px var(--mono); color: var(--text); }
.tk-cfg button { background: transparent; border: 1px solid #5ce1ff; color: #5ce1ff; padding: 5px 14px; font: 700 11px var(--mono); letter-spacing: .2em; cursor: pointer; }
.tk-cfg button:disabled { opacity: .4; cursor: default; }
`
  document.head.appendChild(style)

  function choices() {
    const c = (HUD.state() || {}).choices || {}
    return {
      models: Array.isArray(c.models) && c.models.length ? c.models : FALLBACK_MODELS,
      efforts: Array.isArray(c.efforts) && c.efforts.length ? c.efforts : FALLBACK_EFFORTS,
    }
  }

  function modelOptions(sel) {
    const ms = choices().models.slice()
    if (sel && !ms.some(m => m.id === sel)) ms.push({ id: sel, label: sel })
    return ms.map(m => `<option value="${HUD.esc(m.id)}"${m.id === sel ? ' selected' : ''}>${HUD.esc(m.label)}</option>`).join('')
  }
  function effortOptions(sel) {
    const es = choices().efforts.slice()
    if (sel && !es.includes(sel)) es.push(sel)
    return ['', ...es].map(e => `<option value="${HUD.esc(e)}"${e === sel ? ' selected' : ''}>${e ? HUD.esc(e.toUpperCase()) : 'Default'}</option>`).join('')
  }

  function labelText(p) {
    const m = choices().models.find(x => x.id === p.model)
    const parts = []
    if (p.model) parts.push((m ? m.label : p.model).toUpperCase())
    if (p.effort) parts.push(p.effort.toUpperCase())
    return parts.length ? parts.join(' · ') : 'DEFAULT'
  }

  function apply() {
    HUD.setDispatchExtras({ model: pick.model, effort: pick.effort })
    try { localStorage.setItem(KEY, JSON.stringify(pick)) } catch (e) { /* ignore */ }
  }

  // ---- dispatch picker ---------------------------------------------------
  const slot = HUD.slot('dispatch')
  const wrap = document.createElement('span')
  wrap.className = 'tk-wrap'
  wrap.innerHTML = `
    <button type="button" class="tk-btn" aria-haspopup="true" aria-expanded="false" title="Model and effort for new tasks">⚙ MODEL/EFFORT</button>
    <span class="tk-label"></span>
    <div class="tk-pop" role="dialog" aria-label="Task model and effort">
      <label>MODEL<select data-f="model"></select></label>
      <label>EFFORT<select data-f="effort"></select></label>
      <span class="tk-note">Applies to tasks you dispatch next. Default leaves the choice to Claude Code.</span>
    </div>`
  if (slot) slot.appendChild(wrap)
  const btn = wrap.querySelector('.tk-btn')
  const lab = wrap.querySelector('.tk-label')
  const pop = wrap.querySelector('.tk-pop')
  const selModel = wrap.querySelector('[data-f=model]')
  const selEffort = wrap.querySelector('[data-f=effort]')

  function fill() {
    selModel.innerHTML = modelOptions(pick.model)
    selEffort.innerHTML = effortOptions(pick.effort)
    lab.textContent = labelText(pick)
    lab.classList.toggle('set', !!(pick.model || pick.effort))
  }
  function setOpen(open) {
    pop.classList.toggle('open', open)
    btn.setAttribute('aria-expanded', String(open))
  }
  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(!pop.classList.contains('open')) })
  pop.addEventListener('click', e => e.stopPropagation())
  document.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop.classList.contains('open')) setOpen(false) })
  selModel.addEventListener('change', () => { pick.model = selModel.value; apply(); fill() })
  selEffort.addEventListener('change', () => { pick.effort = selEffort.value; apply(); fill() })

  let lastKey = ''
  function refresh() {
    const key = JSON.stringify(choices())
    if (key === lastKey) return
    lastKey = key
    fill()
  }
  apply()
  fill()
  HUD.on('hello', refresh)
  HUD.on('snapshot', refresh)

  // ---- drawer ------------------------------------------------------------
  HUD.onDrawer((task, el) => {
    if (!el || !task) return
    const cur = { model: task.model || '', effort: task.effort || '' }
    const box = document.createElement('div')
    box.className = 'tk-cfg'
    if (task.status !== 'queued') {
      delete drafts[task.id]
      box.innerHTML = `<div class="tk-label">MODEL / EFFORT</div><div class="kv">${HUD.esc(labelText(cur))}</div>`
      el.appendChild(box)
      return
    }
    const d = drafts[task.id] || (drafts[task.id] = { model: cur.model, effort: cur.effort })
    box.innerHTML = `
      <div class="tk-label">MODEL / EFFORT (queued: editable)</div>
      <div class="row">
        <label>MODEL<select data-f="model">${modelOptions(d.model)}</select></label>
        <label>EFFORT<select data-f="effort">${effortOptions(d.effort)}</select></label>
        <button type="button">SAVE</button>
      </div>`
    const sm = box.querySelector('[data-f=model]')
    const se = box.querySelector('[data-f=effort]')
    const save = box.querySelector('button')
    const dirty = () => { save.disabled = d.model === cur.model && d.effort === cur.effort }
    sm.addEventListener('change', () => { d.model = sm.value; dirty() })
    se.addEventListener('change', () => { d.effort = se.value; dirty() })
    save.addEventListener('click', async () => {
      save.disabled = true
      const ok = await HUD.command({ type: 'task-config', id: task.id, model: d.model, effort: d.effort })
      if (ok) { delete drafts[task.id]; HUD.toast('Task updated') } else { HUD.toast('Could not update the task', 'error'); dirty() }
    })
    dirty()
    el.appendChild(box)
  })
})()
