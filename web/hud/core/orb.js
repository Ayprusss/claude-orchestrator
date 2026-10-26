// HUD core: orb. Plain script; shares the namespace window.HUDCORE with the other core scripts.
(() => {
'use strict'
const N = window.HUDCORE || (window.HUDCORE = {})
const { $, store, S, now, elapsed, select, allClear, input, Voice } = N
const Diffs = new Proxy({}, { get: (_, k) => N.Diffs[k] })

// ======================================================================
// The orb
// ======================================================================
const Orb = (() => {
  const cv = $('orb')
  const ctx = cv.getContext('2d')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, R = 150, stL = 0, stR = 0
  let pts = [], stars = []
  let t = 0, last = performance.now()
  let rotY = 0
  let energy = .15, energyTarget = .15
  let voiceLevel = 0
  let mode = 'idle'
  const col = [92, 225, 255]
  let flash = null // { rgb, until }
  const ripples = []
  const beams = []   // { id, born }
  const bursts = []  // particles
  let moons = []     // drawn positions, for hit tests
  let hover = null

  const PHASE = {
    idle:      { rgb: [92, 225, 255],  energy: .16 },
    thinking:  { rgb: [125, 150, 255], energy: .5 },
    speaking:  { rgb: [150, 238, 255], energy: .45 },
    tool:      { rgb: [255, 181, 71],  energy: .65 },
    listening: { rgb: [110, 255, 205], energy: .4 },
    offline:   { rgb: [110, 125, 140], energy: .05 },
    depleted:  { rgb: [255, 52, 72],   energy: .02 },
  }
  // 1 = full power; dims toward 0.3 while the usage limit is reached.
  let dim = 1, dimTarget = 1, isDepleted = false, flicker = 1
  const STATUS_RGB = { running: [255, 181, 71], queued: [113, 133, 155], done: [61, 245, 160], failed: [255, 77, 109], killed: [80, 92, 105] }

  function build() {
    const n = W < 700 ? 750 : 1500
    const g = Math.PI * (3 - Math.sqrt(5))
    pts = []
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2
      const r = Math.sqrt(1 - y * y)
      const th = g * i
      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, s: Math.random() * 6.28 })
    }
    stars = []
    for (let i = 0; i < (W < 700 ? 70 : 170); i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.2 + .2, p: Math.random() * 6.28, v: Math.random() * .08 + .02 })
    }
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2)
    const rect = cv.getBoundingClientRect()
    W = rect.width; H = rect.height
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    place()
    build()
  }

  function place() {
    const st = $('stage').getBoundingClientRect()
    const cr = cv.getBoundingClientRect()
    cx = st.left - cr.left + st.width / 2
    cy = st.top - cr.top + st.height * .44
    stL = st.left - cr.left; stR = stL + st.width
    // The outer orbit (1.9R) and its labels stay inside the stage column.
    R = Math.max(60, Math.min(250, st.height * .24, (st.width / 2 - 70) / 1.95))
  }

  // Camera: tilt around X after the object's own rotation.
  function camera(x, y, z, tilt) {
    const ct = Math.cos(tilt), st = Math.sin(tilt)
    const y2 = y * ct - z * st
    const z2 = y * st + z * ct
    const f = 3.4 / (3.4 - z2)
    return { x: cx + x * R * f, y: cy + y2 * R * f, z: z2, f }
  }

  function mix(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] }
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`

  // A point on a tilted orbit of radius r (sphere units).
  function orbitPoint(theta, r, incl, node) {
    let x = Math.cos(theta) * r, y = 0, z = Math.sin(theta) * r
    // incline around X
    const ci = Math.cos(incl), si = Math.sin(incl)
    ;[y, z] = [y * ci - z * si, y * si + z * ci]
    // turn around Y
    const cn = Math.cos(node), sn = Math.sin(node)
    ;[x, z] = [x * cn + z * sn, -x * sn + z * cn]
    return [x, y, z]
  }

  function frame(nowMs) {
    const dt = Math.min(.05, (nowMs - last) / 1000)
    last = nowMs
    t += dt * (reduce ? .35 : 1)

    const ph = !S.linked ? PHASE.offline : isDepleted ? PHASE.depleted : PHASE[mode] || PHASE.idle
    dim += (dimTarget - dim) * Math.min(1, dt * .9)
    // A failing power core: brief random sputters while depleted.
    flicker = isDepleted ? (Math.random() < .035 ? .25 + Math.random() * .4 : flicker + (1 - flicker) * .2) : 1
    const running = S.tasks.filter(x => x.status === 'running').length
    energyTarget = ph.energy + Math.min(.25, running * .05) + (Voice.isSpeaking() ? .2 : 0)
    energy += (energyTarget - energy) * Math.min(1, dt * 2.5)
    if (Voice.isSpeaking()) voiceLevel = Math.max(voiceLevel, .35 + .25 * Math.sin(t * 17) * Math.sin(t * 7.3))
    voiceLevel *= Math.exp(-dt * 4.5)
    let target = ph.rgb
    if (flash && nowMs < flash.until) target = mix(target, flash.rgb, .75)
    const c = mix(col, target, Math.min(1, dt * 3))
    col[0] = c[0]; col[1] = c[1]; col[2] = c[2]
    rotY += dt * (.1 + energy * .45) * (.25 + .75 * dim)
    const tilt = .38 + Math.sin(t * .13) * .07

    ctx.clearRect(0, 0, W, H)

    // stars
    ctx.globalCompositeOperation = 'source-over'
    for (const s of stars) {
      s.x -= s.v; if (s.x < 0) s.x += W
      const a = .25 + .25 * Math.sin(t * 1.3 + s.p)
      ctx.fillStyle = `rgba(160,210,235,${a})`
      ctx.fillRect(s.x, s.y, s.r, s.r)
    }

    ctx.globalCompositeOperation = 'lighter'

    // outer halo
    const halo = ctx.createRadialGradient(cx, cy, R * .2, cx, cy, R * 2.1)
    halo.addColorStop(0, rgba(col, (.16 + energy * .12 + voiceLevel * .1) * (.5 + .5 * dim)))
    halo.addColorStop(.45, rgba(col, .05))
    halo.addColorStop(1, rgba(col, 0))
    ctx.fillStyle = halo
    ctx.fillRect(cx - R * 2.2, cy - R * 2.2, R * 4.4, R * 4.4)

    // ---- task orbits and moons (computed first, drawn around the sphere) ----
    const runningTasks = S.tasks.filter(x => x.status === 'running')
    const queuedTasks = S.tasks.filter(x => x.status === 'queued')
    const ORBITS = [
      { list: runningTasks, r: 1.5, incl: 1.18, node: .5, speed: .32, alpha: .5 },
      { list: queuedTasks, r: 1.88, incl: 1.36, node: -.7, speed: .11, alpha: .28 },
    ]
    const newMoons = []
    for (const o of ORBITS) {
      // the orbit ring
      ctx.lineWidth = 1
      for (let i = 0; i < 120; i++) {
        const a0 = (i / 120) * 6.283, a1 = ((i + 1) / 120) * 6.283
        const p0 = orbitPoint(a0, o.r, o.incl, o.node), p1 = orbitPoint(a1, o.r, o.incl, o.node)
        const s0 = camera(...p0, tilt), s1 = camera(...p1, tilt)
        const dep = (s0.z + 1.9) / 3.8
        ctx.strokeStyle = rgba(col, (o.list.length ? o.alpha : o.alpha * .35) * (.15 + .85 * dep) * .55)
        ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke()
      }
      o.list.forEach((task, i) => {
        const theta = (i / o.list.length) * 6.283 + t * o.speed
        const p = orbitPoint(theta, o.r, o.incl, o.node)
        const s = camera(...p, tilt)
        const behind = s.z < 0 && Math.hypot(s.x - cx, s.y - cy) < R * 1.05
        newMoons.push({ id: task.id, task, x: s.x, y: s.y, z: s.z, behind })
      })
    }
    moons = newMoons

    const drawMoon = m => {
      const rgb = STATUS_RGB[m.task.status] || STATUS_RGB.queued
      const a = m.behind ? .3 : 1
      const pulse = m.task.status === 'running' ? 1 + .25 * Math.sin(t * 4 + m.x * .01) : 1
      const rad = (m.id === hover ? 16 : 11) * pulse
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, rad * 1.8)
      g.addColorStop(0, rgba(rgb, .95 * a))
      g.addColorStop(.25, rgba(rgb, .45 * a))
      g.addColorStop(1, rgba(rgb, 0))
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(m.x, m.y, rad * 1.8, 0, 6.283); ctx.fill()
      ctx.fillStyle = rgba([255, 255, 255], .9 * a)
      ctx.beginPath(); ctx.arc(m.x, m.y, 2.2, 0, 6.283); ctx.fill()
    }
    const labelMoon = m => {
      if (m.behind) return
      const title = m.task.title.length > 26 ? m.task.title.slice(0, 25) + '…' : m.task.title
      ctx.font = '600 13px Rajdhani, Bahnschrift, sans-serif'
      const w = Math.max(ctx.measureText(title.toUpperCase()).width, 90) + 36
      // Label on the outer side, unless that would leave the stage column.
      let right = m.x >= cx
      if (right && m.x + w > stR) right = false
      else if (!right && m.x - w < stL) right = true
      const lx = m.x + (right ? 22 : -22), ly = m.y - 14
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = rgba(col, .45)
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(m.x + (right ? 5 : -5), m.y - 4); ctx.lineTo(lx, ly); ctx.lineTo(lx + (right ? 8 : -8), ly); ctx.stroke()
      ctx.textAlign = right ? 'left' : 'right'
      ctx.font = '600 13px Rajdhani, Bahnschrift, sans-serif'
      ctx.fillStyle = 'rgba(225,245,255,.92)'
      ctx.fillText(title.toUpperCase(), lx + (right ? 11 : -11), ly + 4)
      ctx.font = '10px "JetBrains Mono", Consolas, monospace'
      ctx.fillStyle = rgba(STATUS_RGB[m.task.status] || col, .9)
      ctx.fillText(`${m.task.project} · ${elapsed(m.task)}`, lx + (right ? 11 : -11), ly + 17)
      ctx.globalCompositeOperation = 'lighter'
    }

    for (const m of moons) if (m.behind) drawMoon(m)

    // ---- the sphere ----
    const cy0 = Math.cos(rotY), sy0 = Math.sin(rotY)
    const amp = reduce ? .01 : .012 + energy * .03 + voiceLevel * .13
    const band = Math.sin(t * 1.3) * 1.05
    for (const p of pts) {
      // spin
      let x = p.x * cy0 + p.z * sy0
      let z = -p.x * sy0 + p.z * cy0
      let y = p.y
      // surface ripple
      const n = Math.sin(p.x * 4.2 + t * 2.1 + p.s * .3) * Math.cos(p.y * 5.1 - t * 1.7) + Math.sin(p.z * 6 + t * 3.1) * .5
      const d = 1 + amp * n
      x *= d; y *= d; z *= d
      const s = camera(x, y, z, tilt)
      const dep = (s.z + 1) / 2
      let a = .1 + .8 * dep * dep
      if (mode === 'thinking' || mode === 'tool') a += Math.exp(-((p.y - band) ** 2) * 30) * .7
      a *= .75 + .25 * Math.sin(t * 2 + p.s)
      const size = (.7 + dep * 1.5) * (1 + voiceLevel * .5)
      ctx.fillStyle = rgba(col, Math.min(1, a) * dim * flicker)
      ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size)
    }

    // wire rings on the sphere: equator and two meridians
    ctx.lineWidth = 1
    const rings = [
      i => [Math.cos(i), 0, Math.sin(i)],
      i => [Math.cos(i) * cy0, Math.sin(i), -Math.cos(i) * sy0],
      i => [Math.cos(i) * Math.cos(rotY + 1.57), Math.sin(i), -Math.cos(i) * Math.sin(rotY + 1.57)],
    ]
    for (const ring of rings) {
      let prev = null
      for (let i = 0; i <= 96; i++) {
        const [x, y, z] = ring((i / 96) * 6.283)
        const s = camera(x * 1.003, y * 1.003, z * 1.003, tilt)
        if (prev) {
          ctx.strokeStyle = rgba(col, .03 + .16 * ((s.z + 1) / 2) ** 2)
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(s.x, s.y); ctx.stroke()
        }
        prev = s
      }
    }

    // core
    const pulse = 1 + Math.sin(t * (1.5 + energy * 4)) * .06 + voiceLevel * .25
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * .62 * pulse)
    const cdim = dim * dim * flicker
    core.addColorStop(0, rgba(isDepleted ? [255, 120, 130] : [255, 255, 255], (.55 + voiceLevel * .3) * cdim))
    core.addColorStop(.12, rgba(col, (.5 + energy * .3) * cdim))
    core.addColorStop(.45, rgba(col, .12))
    core.addColorStop(1, rgba(col, 0))
    ctx.fillStyle = core
    ctx.beginPath(); ctx.arc(cx, cy, R * .62 * pulse, 0, 6.283); ctx.fill()

    // ripples (sent messages, new tasks, tool calls)
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i]
      const k = (nowMs - r.born) / 1600
      if (k >= 1) { ripples.splice(i, 1); continue }
      if (k < 0) continue
      ctx.strokeStyle = rgba(r.rgb || col, (1 - k) * .6)
      ctx.lineWidth = 2 * (1 - k) + .5
      ctx.beginPath(); ctx.arc(cx, cy, R * (1 + k * 1.3), 0, 6.283); ctx.stroke()
    }

    // beams from the core to newly launched tasks
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i]
      const k = (nowMs - b.born) / 1300
      const m = moons.find(x => x.id === b.id)
      if (k >= 1 || !m) { if (k >= 1) beams.splice(i, 1); continue }
      const g = ctx.createLinearGradient(cx, cy, m.x, m.y)
      g.addColorStop(0, rgba([255, 255, 255], 0))
      g.addColorStop(.6, rgba(STATUS_RGB.running, (1 - k) * .8))
      g.addColorStop(1, rgba([255, 255, 255], (1 - k)))
      ctx.strokeStyle = g
      ctx.lineWidth = 2.5 * (1 - k) + .5
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(m.x, m.y); ctx.stroke()
    }

    for (const m of moons) if (!m.behind) drawMoon(m)

    // Lines from each change window to the agent that made it.
    const cr = cv.getBoundingClientRect()
    for (const a of Diffs.anchors()) {
      const moon = a.taskId ? moons.find(m => m.id === a.taskId) : null
      if (a.taskId && !moon) continue // the task has left its orbit
      const tx = moon ? moon.x : cx, ty = moon ? moon.y : cy
      const ax = a.x - cr.left, ay = a.y - cr.top
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = a.color
      ctx.globalAlpha = .55
      ctx.lineWidth = 1.2
      ctx.setLineDash([5, 5])
      ctx.lineDashOffset = -t * 30
      const mx = (ax + tx) / 2
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.bezierCurveTo(mx, ay, mx, ty, tx, ty); ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      ctx.fillStyle = a.color
      ctx.beginPath(); ctx.arc(ax, ay, 2.5, 0, 6.283); ctx.fill()
      ctx.strokeStyle = a.color
      ctx.beginPath(); ctx.arc(tx, ty, moon ? 9 + Math.sin(t * 5) * 1.5 : R * .2, 0, 6.283); ctx.stroke()
      ctx.globalCompositeOperation = 'lighter'
    }

    // bursts from finished tasks
    for (let i = bursts.length - 1; i >= 0; i--) {
      const p = bursts[i]
      p.life -= dt
      if (p.life <= 0) { bursts.splice(i, 1); continue }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .97; p.vy *= .97
      ctx.fillStyle = rgba(p.rgb, p.life / p.max)
      ctx.fillRect(p.x - 1.2, p.y - 1.2, 2.4, 2.4)
    }

    ctx.globalAlpha = .4 + .6 * dim
    drawHud(nowMs, running)
    ctx.globalAlpha = 1
    for (const m of moons) labelMoon(m)

    ctx.globalCompositeOperation = 'source-over'
    requestAnimationFrame(frame)
  }

  // The flat instrument rings around the sphere.
  function drawHud(nowMs, running) {
    const a0 = t * .25
    ctx.lineWidth = 1
    // thin ring
    ctx.strokeStyle = rgba(col, .22)
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.3, 0, 6.283); ctx.stroke()
    // segmented arcs
    ctx.lineWidth = 2.5
    ctx.strokeStyle = rgba(col, .55)
    for (let i = 0; i < 3; i++) {
      const s = a0 + i * 2.094
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.38, s, s + .9 + .3 * Math.sin(t * .7 + i)); ctx.stroke()
    }
    // ticks
    ctx.lineWidth = 1
    const tr = R * 1.5, rot = -t * .05
    for (let i = 0; i < 90; i++) {
      const a = rot + (i / 90) * 6.283
      const long = i % 6 === 0
      const lit = (i / 90) < Math.min(1, S.maxParallel ? running / S.maxParallel : 0)
      ctx.strokeStyle = lit ? rgba([255, 181, 71], .75) : rgba(col, long ? .45 : .18)
      const r1 = tr, r2 = tr + (long ? 9 : 4)
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      ctx.stroke()
    }
    // outer dashed ring with brackets
    const orr = R * 1.68, b = -t * .12
    ctx.setLineDash([2, 7])
    ctx.strokeStyle = rgba(col, .3)
    ctx.beginPath(); ctx.arc(cx, cy, orr, 0, 6.283); ctx.stroke()
    ctx.setLineDash([])
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(col, .7)
    for (const s of [b, b + 3.1416]) {
      ctx.beginPath(); ctx.arc(cx, cy, orr, s - .18, s + .18); ctx.stroke()
    }
    // scanner sweep
    const sw = t * (.6 + energy * 1.2)
    for (let i = 0; i < 14; i++) {
      ctx.strokeStyle = rgba(col, .4 * (1 - i / 14))
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.22, sw - i * .04 - .04, sw - i * .04); ctx.stroke()
    }
    // readouts
    ctx.globalCompositeOperation = 'source-over'
    ctx.font = '10px "JetBrains Mono", Consolas, monospace'
    ctx.fillStyle = rgba(col, .75)
    const txt = (s, ang, r, align) => {
      ctx.textAlign = align
      ctx.fillText(s, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r)
    }
    const queued = S.tasks.filter(x => x.status === 'queued').length
    txt(`AGENTS ${String(running).padStart(2, '0')}/${String(S.maxParallel || 0).padStart(2, '0')}`, -.62, R * 1.82, 'left')
    txt(`QUEUE ${String(queued).padStart(2, '0')}`, -.5, R * 1.86, 'left')
    txt('SYS.ORCH // CORE', -2.52, R * 1.82, 'right')
    txt(isDepleted ? 'RESERVES 000%' : `E ${(energy * 100).toFixed(0).padStart(3, '0')}%`, -2.64, R * 1.86, 'right')
    const w5 = S.usage.find(w => w.kind === 'five_hour'), w7 = S.usage.find(w => w.kind === 'seven_day')
    if (w5) txt(`USE 5H ${String(Math.round(w5.percent)).padStart(3, '0')}%`, 2.62, R * 1.84, 'right')
    if (w7) txt(`USE 7D ${String(Math.round(w7.percent)).padStart(3, '0')}%`, 2.5, R * 1.88, 'right')
    ctx.globalCompositeOperation = 'lighter'
  }

  // input
  const stage = $('stage')
  const hit = (ex, ey) => {
    const r = cv.getBoundingClientRect()
    const x = ex - r.left, y = ey - r.top
    let best = null, bd = 18
    for (const m of moons) {
      const d = Math.hypot(m.x - x, m.y - y)
      if (d < bd) { bd = d; best = m }
    }
    return best
  }
  stage.addEventListener('mousemove', e => {
    const m = hit(e.clientX, e.clientY)
    hover = m ? m.id : null
    stage.style.cursor = m ? 'pointer' : ''
  })
  stage.addEventListener('click', e => {
    const m = hit(e.clientX, e.clientY)
    if (m) select(m.id)
  })
  addEventListener('resize', resize)
  new ResizeObserver(place).observe(stage)

  resize()
  window.addEventListener("load", () => requestAnimationFrame(frame)) // after every core script has run (frame reads Diffs)

  return {
    phase(p) { mode = p; if (p === 'tool') ripples.push({ born: performance.now(), rgb: [255, 181, 71] }) },
    voice(v) { voiceLevel = Math.max(voiceLevel, v) },
    depleted(on) { isDepleted = on; dimTarget = on ? .3 : 1 },
    allClear() {
      flash = { rgb: [61, 245, 160], until: performance.now() + 1400 }
      for (let i = 0; i < 4; i++) ripples.push({ born: performance.now() + i * 260, rgb: [61, 245, 160] })
      voiceLevel = 1
    },
    // Where a task's moon is now, in page coordinates; the core when it has none.
    anchorFor(taskId) {
      const r = cv.getBoundingClientRect()
      const m = taskId ? moons.find(x => x.id === taskId) : null
      return m ? { x: m.x + r.left, y: m.y + r.top, isMoon: true } : { x: cx + r.left, y: cy + r.top, isMoon: false }
    },
    restore() {
      isDepleted = false; dimTarget = 1
      flash = { rgb: [200, 250, 255], until: performance.now() + 1200 }
      for (let i = 0; i < 3; i++) ripples.push({ born: performance.now() + i * 220, rgb: [150, 240, 255] })
    },
    ripple() { ripples.push({ born: performance.now() }) },
    launch(id) { beams.push({ id, born: performance.now() }); ripples.push({ born: performance.now(), rgb: [255, 181, 71] }) },
    finish(id, status) {
      const m = moons.find(x => x.id === id)
      const rgb = STATUS_RGB[status]
      flash = { rgb, until: performance.now() + 900 }
      const ox = m ? m.x : cx, oy = m ? m.y : cy
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * 6.283, v = 40 + Math.random() * 140
        bursts.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.2, max: 1.2, rgb })
      }
      ripples.push({ born: performance.now(), rgb })
    },
  }
})()

Object.assign(N, { Orb })
})()
