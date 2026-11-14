/**
 * Pacing for fast machines. Loaded before anything else (main.jsx).
 *
 * The screen: on a 144 or 240 Hz monitor the browser asks for a new frame up to four times
 * as often as on a laptop's 60 Hz one, and every animated thing (the patch lighting, the
 * playheads, the code highlighting) runs that often, on the same thread Strudel schedules
 * notes from. Notes then go out late and the sound cuts in and out, on the faster machine.
 * Animation frames are held to about 60 a second, whatever the screen does.
 *
 * The audio: an interface running at 96 or 192 kHz makes every synth do two to four times
 * the work for no audible gain, and a desktop's default buffer can be very short. The audio
 * runs at 48 kHz at most, with a buffer a little longer than the shortest a desktop offers.
 */
import { getAudioContext, setAudioContext } from '@strudel/webaudio'

// ── frames ────────────────────────────────────────────────────────────────────
const FRAME_MS = 1000 / 60 - 1 // a hair under, so a 60 Hz screen never skips one
if (typeof window !== 'undefined' && window.requestAnimationFrame && !window.__paced) {
  window.__paced = true
  const native = window.requestAnimationFrame.bind(window)
  let queue = new Map()
  let next = 1
  let last = 0
  let pending = false
  const pump = (ts) => {
    if (ts - last < FRAME_MS) { native(pump); return }
    last = ts
    pending = false
    const run = queue
    queue = new Map()
    for (const cb of run.values()) {
      try { cb(ts) } catch (err) { setTimeout(() => { throw err }) }
    }
  }
  window.requestAnimationFrame = (cb) => {
    const id = next++
    queue.set(id, cb)
    if (!pending) { pending = true; native(pump) }
    return id
  }
  window.cancelAnimationFrame = (id) => { queue.delete(id) }
}

// ── audio ─────────────────────────────────────────────────────────────────────
const MAX_RATE = 48000
try {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (Ctx) {
    let ac = new Ctx({ latencyHint: 'balanced' })
    if (ac.sampleRate > MAX_RATE) {
      ac.close?.()
      ac = new Ctx({ latencyHint: 'balanced', sampleRate: MAX_RATE })
    }
    setAudioContext(ac)
  }
} catch (err) {
  console.warn('[pace] using the default audio setup', err)
  getAudioContext()
}
