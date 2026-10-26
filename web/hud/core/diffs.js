// HUD core: diffs. Plain script; shares the namespace window.HUDCORE with the other core scripts.
(() => {
'use strict'
const N = window.HUDCORE || (window.HUDCORE = {})
const { $, store, S, connect, esc, renderTasks, select, renderDrawer, renderComms, toast, Orb } = N

// ======================================================================
// Code change windows
// ======================================================================
function shortPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts.slice(-3).join('/')
}
function diffCount(taskId) { return S.diffs.filter(d => d.taskId === taskId).length }

const Diffs = (() => {
  const layer = $('diffLayer')
  const cards = new Map() // owner key -> card
  const muted = new Set()
  // The size the person last gave a window; new windows open at it.
  let saved = store.get('diffSize', null)
  const MIN_W = 260, MIN_H = 150
  const STATUS_HEX = { running: '#ffb547', queued: '#71859b', done: '#3df5a0', failed: '#ff4d6d', killed: '#71859b' }

  const ownerKey = d => d.taskId ? 't:' + d.taskId : d.agentId ? 'a:' + d.agentId : 'main'
  function owner(key) {
    if (key === 'main') return { name: 'Orchestrator', color: getComputedStyle(document.body).getPropertyValue('--cyan').trim() || '#5ce1ff' }
    if (key.startsWith('t:')) {
      const t = S.tasks.find(x => x.id === key.slice(2))
      return { name: t ? t.title : 'Task ' + key.slice(2), color: STATUS_HEX[t?.status] || '#ffb547', taskId: key.slice(2), task: t }
    }
    return { name: 'Subagent ' + key.slice(2, 8), color: '#8ea6ff' }
  }
  const listFor = key => S.diffs.filter(d => ownerKey(d) === key)

  function add(d) {
    S.diffs.push(d)
    if (S.diffs.length > 150) S.diffs.shift()
    const key = ownerKey(d)
    const card = cards.get(key)
    if (card) { card.idx = listFor(key).length - 1; card.closeAt = 0; render(card, true) }
    else if (S.isDiffViewOn && !muted.has(key)) open(key)
    renderComms(); renderTasks(); if (S.selected) renderDrawer()
  }

  function openDiff(id) {
    const d = S.diffs.find(x => x.id === id)
    if (!d) return
    const key = ownerKey(d)
    open(key)
    const card = cards.get(key)
    card.idx = listFor(key).findIndex(x => x.id === id)
    render(card, true)
  }

  function open(key) {
    let card = cards.get(key)
    if (!card) {
      const el = document.createElement('div')
      el.className = 'diff-card'
      el.setAttribute('role', 'dialog')
      layer.appendChild(el)
      card = { key, el, idx: listFor(key).length - 1, side: 'left', closeAt: 0 }
      cards.set(key, card)
      el.addEventListener('pointerdown', e => startDrag(card, e))
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-act]')
        if (!b) return
        const act = b.dataset.act
        if (act === 'close') close(key)
        else if (act === 'mute') { muted.add(key); close(key); toast('Changes from this agent stay in Comms only.') }
        else if (act === 'prev') { card.idx = Math.max(0, card.idx - 1); render(card) }
        else if (act === 'next') { card.idx = Math.min(listFor(key).length - 1, card.idx + 1); render(card) }
        else if (act === 'task' && owner(key).taskId) select(owner(key).taskId)
      })
      render(card)
      place(card)
    } else render(card, true)
  }

  function close(key) {
    const card = cards.get(key)
    if (!card) return
    card.el.remove()
    cards.delete(key)
  }
  const closeAll = () => [...cards.keys()].forEach(close)

  function hunksHtml(d) {
    let html = ''
    for (const h of d.hunks) {
      let o = h.oldStart, n = h.newStart
      if (o || n) html += `<div class="dl h">@@ -${o} +${n} @@</div>`
      for (const line of h.lines) {
        const c = line[0], text = esc(line.slice(1))
        if (c === '+') { html += `<div class="dl a"><span class="n"></span><span class="n">${n || ''}</span><span class="t">+${text}</span></div>`; if (n) n++ }
        else if (c === '-') { html += `<div class="dl d"><span class="n">${o || ''}</span><span class="n"></span><span class="t">-${text}</span></div>`; if (o) o++ }
        else if (c === '\\') html += `<div class="dl h">${esc(line)}</div>`
        else { html += `<div class="dl"><span class="n">${o || ''}</span><span class="n">${n || ''}</span><span class="t"> ${text}</span></div>`; if (o) o++; if (n) n++ }
      }
    }
    if (d.isTruncated) html += '<div class="dl h">… more lines not shown</div>'
    return html
  }

  function render(card, isFresh) {
    const list = listFor(card.key)
    if (!list.length) return close(card.key)
    card.idx = Math.max(0, Math.min(list.length - 1, card.idx))
    const d = list[card.idx]
    const o = owner(card.key)
    card.el.style.setProperty('--agent', o.color)
    card.el.setAttribute('aria-label', 'Code changes by ' + o.name)
    const status = o.task ? ` · ${o.task.status}` : ''
    card.el.innerHTML = `
      <div class="dc-head">
        <span class="dot"></span>
        <span class="dc-who grip" title="${esc(o.name)} (drag to move)">${esc(o.name)}<span style="opacity:.55;letter-spacing:.08em">${esc(status)}</span></span>
        ${o.taskId ? '<button class="dc-btn" data-act="task" title="Open this task">TASK</button>' : ''}
        <button class="dc-btn x" data-act="close" title="Close these changes" aria-label="Close these changes">&#10005;</button>
      </div>
      <div class="dc-file"><span class="op">${esc(d.op)}</span><span class="path" title="${esc(d.file)}">${esc(shortPath(d.file))}</span><span class="add">+${d.added}</span><span class="del">&minus;${d.removed}</span></div>
      <div class="dc-body">${hunksHtml(d)}</div>
      <div class="dc-foot">
        <button class="dc-btn" data-act="prev" ${card.idx === 0 ? 'disabled' : ''} aria-label="Older change">&lsaquo;</button>
        <span>${card.idx + 1} / ${list.length}</span>
        <button class="dc-btn" data-act="next" ${card.idx === list.length - 1 ? 'disabled' : ''} aria-label="Newer change">&rsaquo;</button>
        <span class="grow"></span>
        <button class="dc-btn" data-act="mute" title="Stop popping up changes from this agent">MUTE</button>
      </div>
      <div class="dc-edge l" data-rs="l"></div><div class="dc-edge r" data-rs="r"></div><div class="dc-edge-b" data-rs="b"></div>
      <div class="dc-resize ${card.side === 'right' ? 'bl' : 'br'}" data-rs="${card.side === 'right' ? 'bl' : 'br'}" title="Drag to resize (double-click: default size)"></div>`
    if (isFresh) {
      card.el.classList.remove('flash'); void card.el.offsetWidth; card.el.classList.add('flash')
    }
  }

  // Beside its agent: on the agent's side of the stage, level with it, clear of the others.
  function place(card) {
    const st = $('stage').getBoundingClientRect()
    const narrow = innerWidth < 760
    const w = narrow ? Math.min(innerWidth - 32, 420)
      : saved ? Math.min(saved.w, innerWidth - 32) : Math.min(360, Math.max(260, st.width * .42))
    card.el.style.width = w + 'px'
    if (saved && !narrow) {
      card.el.style.height = Math.min(saved.h, innerHeight - 32) + 'px'
      card.el.classList.add('sized')
    }
    const h = card.el.offsetHeight || 300
    const a = Orb.anchorFor(owner(card.key).taskId)
    card.side = a.x < st.left + st.width / 2 ? 'left' : 'right'
    let left = narrow ? 16 : card.side === 'left' ? st.left + 6 : st.right - w - 6
    let top = Math.max(st.top + 6, Math.min(a.y - 40, st.bottom - h - 6))
    const others = [...cards.values()].filter(c => c !== card && (narrow || c.side === card.side))
      .map(c => c.el.getBoundingClientRect()).sort((x, y) => x.top - y.top)
    for (const r of others) {
      if (top < r.bottom + 8 && top + h > r.top - 8) top = r.bottom + 8
    }
    if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8)
    card.el.style.left = left + 'px'
    card.el.style.top = top + 'px'
    render(card) // the resize corner sits on the side away from the agent
  }

  // Move by the title, resize by an edge or the corner.
  function startDrag(card, e) {
    const rs = e.target.closest('[data-rs]')?.dataset.rs
    const isMove = !rs && e.target.closest('.grip')
    if (!rs && !isMove) return
    if (e.button !== 0) return
    e.preventDefault()
    const el = card.el
    const r0 = el.getBoundingClientRect()
    const x0 = e.clientX, y0 = e.clientY
    el.classList.add('dragging')
    try { el.setPointerCapture(e.pointerId) } catch {} // keeps the drag through fast moves
    const move = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0
      if (isMove) {
        const left = Math.max(0, Math.min(innerWidth - 60, r0.left + dx))
        const top = Math.max(0, Math.min(innerHeight - 40, r0.top + dy))
        el.style.left = left + 'px'
        el.style.top = top + 'px'
        const st = $('stage').getBoundingClientRect()
        card.side = left + r0.width / 2 < st.left + st.width / 2 ? 'left' : 'right'
        return
      }
      let { left, width, height } = { left: r0.left, width: r0.width, height: r0.height }
      if (rs === 'r' || rs === 'br') width = r0.width + dx
      if (rs === 'l' || rs === 'bl') { width = r0.width - dx; left = r0.left + dx }
      if (rs === 'b' || rs === 'br' || rs === 'bl') height = r0.height + dy
      width = Math.max(MIN_W, Math.min(innerWidth - 16, width))
      height = Math.max(MIN_H, Math.min(innerHeight - r0.top - 8, height))
      if (rs === 'l' || rs === 'bl') left = r0.right - width
      el.style.left = Math.max(0, left) + 'px'
      el.style.width = width + 'px'
      el.style.height = height + 'px'
      el.classList.add('sized')
    }
    const up = () => {
      el.classList.remove('dragging')
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      card.closeAt = 0 // touched: keep it
      if (rs) {
        const r = el.getBoundingClientRect()
        saved = { w: Math.round(r.width), h: Math.round(r.height) }
        store.set('diffSize', saved)
      }
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  function resetSize() {
    saved = null
    store.set('diffSize', null)
    for (const c of cards.values()) {
      c.el.style.height = ''
      c.el.classList.remove('sized')
      place(c)
    }
  }

  // For the orb's connector lines: where each card's line starts.
  function anchors() {
    const out = []
    for (const c of cards.values()) {
      const r = c.el.getBoundingClientRect()
      const o = owner(c.key)
      out.push({ x: c.side === 'left' ? r.right : r.left, y: r.top + 16, color: o.color, taskId: o.taskId })
    }
    return out
  }

  // On each snapshot: recolor, and let windows of finished tasks go after a while.
  function refresh() {
    for (const c of cards.values()) {
      const o = owner(c.key)
      const live = !o.task || o.task.status === 'running' || o.task.status === 'queued'
      if (!live && !c.closeAt) c.closeAt = Date.now() + 20000
      c.el.style.setProperty('--agent', o.color)
    }
  }
  setInterval(() => {
    for (const c of [...cards.values()]) {
      if (c.closeAt && Date.now() > c.closeAt && !c.el.matches(':hover')) close(c.key)
    }
  }, 1000)
  addEventListener('resize', () => cards.forEach(place))

  layer.addEventListener('dblclick', e => {
    if (!e.target.closest('.dc-resize')) return
    resetSize()
  })

  return { add, open, openDiff, close, closeAll, anchors, refresh, owner, ownerKey, resetSize }
})()

Object.assign(N, { shortPath, diffCount, Diffs })
})()
