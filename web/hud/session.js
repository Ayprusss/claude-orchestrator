// HUD module S: the orchestrator's own MODEL and EFFORT selects, in the header.
// Talks to the HUD only through window.HUD. Reads snapshot.session
// ({ model, effort, canSetEffort }) and snapshot.choices ({ models, efforts }).
(function () {
  'use strict'
  var HUD = window.HUD
  if (!HUD) return

  var FALLBACK_MODELS = [
    { id: '', label: 'Default' }, { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' }, { id: 'fable', label: 'Fable' },
  ]
  var FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
  var NO_EFFORT_WHY = 'This build of Claude Code has no /effort command a plugin can run, so effort cannot be set from the HUD.'

  var css = document.createElement('style')
  css.textContent = [
    '.sess-ctl { display: flex; align-items: center; gap: 10px; flex: none; }',
    '.sess-ctl label { display: flex; align-items: center; gap: 5px; font: 10px var(--mono); letter-spacing: .16em; color: var(--muted); }',
    '.sess-ctl select { width: 108px; max-width: 108px; font: 11px var(--mono); letter-spacing: .04em; color: var(--text);',
    '  background: rgba(3,14,22,.85); border: 1px solid var(--line); padding: 4px 6px; border-radius: 0; cursor: pointer; }',
    '.sess-ctl select:hover:not(:disabled), .sess-ctl select:focus { border-color: var(--cyan-2); outline: none; }',
    '.sess-ctl select:disabled { opacity: .45; cursor: not-allowed; }',
    '.sess-ctl label.busy select { border-color: var(--amber); }',
    '.sess-ctl .cur { font: 10px var(--mono); color: var(--cyan); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 90px; }',
  ].join('\n')
  document.head.appendChild(css)

  var wrap = document.createElement('div')
  wrap.className = 'sess-ctl'
  wrap.innerHTML =
    '<label title="The orchestrator session\'s model">MODEL <select id="sessModel" aria-label="Orchestrator model"></select></label>' +
    '<label id="sessEffortLbl">EFFORT <select id="sessEffort" aria-label="Orchestrator effort"></select></label>'
  var slot = HUD.slot('header')
  if (slot) slot.insertBefore(wrap, slot.firstChild)

  var selModel = wrap.querySelector('#sessModel')
  var selEffort = wrap.querySelector('#sessEffort')
  var lblEffort = wrap.querySelector('#sessEffortLbl')
  var lastKey = ''

  function opt(value, label) {
    return '<option value="' + HUD.esc(value) + '">' + HUD.esc(label) + '</option>'
  }

  // The reported model id (e.g. claude-opus-4-1) -> the alias it belongs to, or ''.
  function aliasOf(models, id) {
    var low = String(id || '').toLowerCase()
    for (var i = 0; i < models.length; i++) {
      if (models[i].id && low.indexOf(models[i].id) !== -1) return models[i].id
    }
    return ''
  }

  function draw(snap) {
    if (!snap) return
    var sess = snap.session || {}
    var choices = snap.choices || {}
    var models = choices.models && choices.models.length ? choices.models : FALLBACK_MODELS
    var efforts = choices.efforts && choices.efforts.length ? choices.efforts : FALLBACK_EFFORTS
    var canSet = !!sess.canSetEffort
    var alias = aliasOf(models, sess.model)
    var key = JSON.stringify([models, efforts, alias, sess.model, sess.effort, canSet])
    if (key === lastKey) return
    lastKey = key

    // Do not pull a select out from under the person's hand.
    if (document.activeElement !== selModel) {
      var list = models.slice()
      if (!alias && sess.model) list.push({ id: '__cur', label: sess.model })
      selModel.innerHTML = list.map(function (m) { return opt(m.id, m.label) }).join('')
      selModel.value = alias || (sess.model ? '__cur' : '')
      selModel.title = sess.model ? 'Current: ' + sess.model : 'Orchestrator model'
    }
    if (document.activeElement !== selEffort) {
      selEffort.innerHTML = opt('', 'Default') + efforts.map(function (e) { return opt(e, e) }).join('')
      selEffort.value = sess.effort && efforts.indexOf(sess.effort) !== -1 ? sess.effort : ''
    }
    selEffort.disabled = !canSet
    var why = canSet ? 'The orchestrator session\'s effort' : NO_EFFORT_WHY
    selEffort.title = why
    lblEffort.title = why
  }

  function busy(lbl, on) { lbl.classList.toggle('busy', on) }

  selModel.addEventListener('change', function () {
    var v = selModel.value
    if (v === '__cur') return
    var label = selModel.options[selModel.selectedIndex].text
    busy(selModel.parentNode, true)
    Promise.resolve(HUD.command({ type: 'session-model', model: v })).then(function (ok) {
      busy(selModel.parentNode, false)
      if (ok) HUD.toast('Orchestrator model: ' + label)
      else HUD.toast('Could not change the model', 'error')
      lastKey = ''; draw(HUD.state())
    }, function () { busy(selModel.parentNode, false); HUD.toast('Could not change the model', 'error') })
  })

  selEffort.addEventListener('change', function () {
    var v = selEffort.value
    busy(lblEffort, true)
    Promise.resolve(HUD.command({ type: 'session-effort', effort: v })).then(function (ok) {
      busy(lblEffort, false)
      if (ok) HUD.toast('Orchestrator effort: ' + (v || 'default'))
      else HUD.toast('Could not change the effort', 'error')
      lastKey = ''; draw(HUD.state())
    }, function () { busy(lblEffort, false); HUD.toast('Could not change the effort', 'error') })
  })

  HUD.on('hello', function (m) { draw((m && m.snapshot) || HUD.state()) })
  HUD.on('snapshot', function (s) { draw(s && s.session ? s : HUD.state()) })
  draw(HUD.state())
})()
