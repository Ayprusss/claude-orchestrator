// HUD core: voice. Plain script; shares the namespace window.HUDCORE with the other core scripts.
(() => {
'use strict'
const N = window.HUDCORE || (window.HUDCORE = {})
const { $, S, esc, plain, renderPhase, input, send, autosize, toast } = N
const Orb = new Proxy({}, { get: (_, k) => N.Orb[k] })

// ======================================================================
// Voice: speech out (replies) and speech in (the mic)
// ======================================================================
const Voice = (() => {
  const synth = window.speechSynthesis
  let voice = null
  let speaking = false
  const pick = () => {
    if (!synth) return
    const vs = synth.getVoices()
    voice =
      vs.find(v => /(Ryan|George|Daniel|Thomas|Google UK English Male)/i.test(v.name) && /^en/i.test(v.lang)) ||
      vs.find(v => /^en-GB/i.test(v.lang)) ||
      vs.find(v => /^en/i.test(v.lang)) || null
  }
  if (synth) { pick(); synth.onvoiceschanged = pick }

  function say(text, isShort) {
    if (!S.voiceOn || !synth) return
    let t = plain(text)
    if (!t) return
    if (!isShort) {
      const sentences = t.match(/[^.!?]+[.!?]+/g) || [t]
      t = sentences.slice(0, 4).join(' ')
      if (t.length > 600) t = t.slice(0, 600)
    }
    const u = new SpeechSynthesisUtterance(t)
    if (voice) u.voice = voice
    u.rate = 1.04; u.pitch = .92
    u.onstart = () => { speaking = true }
    u.onend = u.onerror = () => { speaking = false }
    u.onboundary = () => Orb.voice(1)
    synth.speak(u)
  }
  const isSpeaking = () => speaking
  const stop = () => { if (synth) synth.cancel(); speaking = false }

  // Speech in.
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition
  let rec = null
  function listen() {
    if (!Rec) return toast('Voice input needs Chrome or Edge.', 'error')
    if (rec) { rec.stop(); return }
    stop()
    rec = new Rec()
    rec.lang = navigator.language || 'en-US'
    rec.interimResults = true
    rec.continuous = false
    let finalText = ''
    rec.onstart = () => { S.listening = true; $('mic').classList.add('live'); Orb.phase('listening'); renderPhase() }
    rec.onresult = e => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
        Orb.voice(.6)
      }
      input.value = (finalText + interim).trim()
      autosize()
    }
    rec.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Mic: ' + e.error, 'error') }
    rec.onend = () => {
      rec = null
      S.listening = false
      $('mic').classList.remove('live')
      Orb.phase(S.phase)
      renderPhase()
      if (finalText.trim()) send()
    }
    rec.start()
  }
  if (!Rec) $('mic').style.display = 'none'
  return { say, stop, listen, isSpeaking }
})()

Object.assign(N, { Voice })
})()
