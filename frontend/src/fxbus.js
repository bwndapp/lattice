/**
 * Reverb and delay, done properly. Strudel gives every audio bus ("orbit") one reverb and
 * one delay whose settings are whatever the latest note said, so two parts with different
 * settings fight, the delay time isn't tied to the tempo, and a longer reverb is louder.
 *
 * Here every reverb or delay in the patch (and one shared pair for the instruments' own
 * reverb and delay knobs) is an effect of its own, built from Web Audio nodes:
 *
 *   reverb  pre-delay → low cut → convolution with a generated room (size, tone, width),
 *           level-matched so size changes the space, not the loudness; a new room fades in
 *           over the old one instead of cutting the tail
 *   delay   tempo-synced echoes with feedback through a tone filter and a soft limiter
 *           (so high feedback swells without blowing up), stereo or ping-pong
 *
 * A note reaches them as a send: the generated code adds `fxsends: [[key, amount], …]` to
 * the note, and `routeVoice` turns that into Strudel's one bus send, pointed at a small
 * router that fans out to each effect. The effect plays back into the note's own bus, so
 * sidechain ducking, mixer buses and stereo inserts after it treat the tail like the note.
 * Settings are declared while the code is generated (like stereo.js) and apply at once,
 * also to tails already ringing.
 *
 * Code pasted somewhere without this app plays dry.
 */
import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio'

/** Reverb and delay settings the knobs start from. */
export const REVERB_DEFAULTS = { size: 2.2, predelay: 0.015, tone: 0.55, lowcut: 160, width: 1 }
export const DELAY_DEFAULTS = { feedback: 0.4, tone: 0.6, mode: 'stereo' }
/** Delay times as fractions of a beat (a quarter note). */
export const DELAY_DIVISIONS = {
  '1/32': 0.125, '1/16': 0.25, '1/16 dotted': 0.375, '1/8 triplet': 1 / 3, '1/8': 0.5, '1/8 dotted': 0.75,
  '1/4 triplet': 2 / 3, '1/4': 1, '1/4 dotted': 1.5, '1/2': 2, '1 bar': 4,
}
/** The shared pair the instruments' reverb and delay knobs send to. */
export const GLOBAL_REVERB = 'g_rv'
export const GLOBAL_DELAY = 'g_dl'

const ROUTER_BASE = 20_000_000 // bus ids for routers (live.js uses 1M–9M)
let declared = new Map() // key → { kind, params } from the latest generated code
const instances = new Map() // `${key}@${orbit}` → effect
const routers = new Map() // bus id → { orbit, sends, node, at }
let controller = null
let armed = false

// ── declaring (while generating code) ────────────────────────────────────────
export function beginFx() {
  return new Map()
}
export function declareFx(list, key, kind, params) {
  list.set(key, { kind, params })
}
/** The effects the code now has. `partial` (auditioning) only adds and updates. */
export function commitFx(list, { partial = false } = {}) {
  declared = partial ? new Map([...declared, ...list]) : list
  try {
    for (const inst of instances.values()) {
      const d = declared.get(inst.key)
      if (d && d.kind === inst.kind) inst.set(d.params)
    }
  } catch (err) { console.warn('[fx] could not update effects', err) }
}

// ── routing notes ─────────────────────────────────────────────────────────────
const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * A note's value, ready for Strudel: its `fxsends` become one bus send to a router that
 * feeds each effect. Notes without sends (or before audio can start) pass through.
 */
export function routeVoice(value) {
  if (!value || !Array.isArray(value.fxsends)) return value
  const { fxsends, ...rest } = value
  try {
    if (rest.bus != null || !install()) return rest // hand-written code chose a bus of its own
    const orbit = rest.orbit ?? 1
    const sends = []
    for (const s of fxsends) {
      if (!Array.isArray(s) || !declared.has(s[0])) continue
      const amount = Math.round(Math.min(2, Math.max(0, Number(s[1]) || 0)) * 64) / 64 // steps, so routers are shared
      if (amount > 0) sends.push([s[0], amount])
    }
    if (!sends.length) return rest
    const sig = `${orbit}|${sends.map(([k, a]) => `${k}*${a}`).join('|')}`
    const id = ROUTER_BASE + (hash(sig) % 1_000_000)
    const have = routers.get(id)
    if (!have || have.sig !== sig) routers.set(id, { sig, orbit, sends, node: null, at: Date.now() })
    else have.at = Date.now()
    collect()
    return { ...rest, bus: id, busgain: 1 }
  } catch (err) {
    console.warn('[fx] could not route a note to its effects', err)
    return rest
  }
}

/** Hook into the audio controller once the page may make sound. */
function install() {
  const ctl = safeController()
  if (controller && controller === ctl) return true
  if (!navigator.userActivation?.hasBeenActive) {
    if (!armed) {
      armed = true
      const go = () => { window.removeEventListener('pointerdown', go, true); window.removeEventListener('keydown', go, true); install() }
      window.addEventListener('pointerdown', go, true)
      window.addEventListener('keydown', go, true)
    }
    return false
  }
  if (!ctl) return false
  controller = ctl
  const getBus = ctl.getBus.bind(ctl)
  ctl.getBus = (id) => (routers.has(id) ? routerNode(id) : getBus(id))
  return true
}

function safeController() {
  try { return getSuperdoughAudioController() } catch { return null }
}

function routerNode(id) {
  const r = routers.get(id)
  if (r.node && controller.buses[id] === r.node) return r.node
  const ac = getAudioContext()
  const node = new GainNode(ac, { gain: 1, channelCount: 2, channelCountMode: 'explicit' })
  for (const [key, amount] of r.sends) {
    const fx = effectFor(key, r.orbit)
    if (!fx) continue
    const send = new GainNode(ac, { gain: amount })
    node.connect(send)
    send.connect(fx.input)
  }
  r.node = node
  controller.buses[id] = node // so resetting the audio (stop) disconnects it too
  return node
}

/** The effect for `key` playing into orbit `orbit`, made on first use. */
function effectFor(key, orbit) {
  const d = declared.get(key)
  if (!d) return null
  const bus = controller.getOrbit(orbit)
  const k = `${key}@${orbit}`
  let fx = instances.get(k)
  // after a reset (stop) the orbit is new: start clean, with no old tail waiting in a delay line
  if (fx && (fx.bus !== bus || fx.kind !== d.kind)) { fx.destroy(); fx = null }
  if (!fx) {
    const ac = getAudioContext()
    fx = d.kind === 'delay' ? makeDelay(ac, d.params) : makeReverb(ac, d.params)
    Object.assign(fx, { key, kind: d.kind, bus })
    fx.output.connect(bus.summingNode)
    instances.set(k, fx)
  }
  fx.at = Date.now()
  return fx
}

/** Stop: every tail goes at once (Strudel's own reset has already muted the buses). */
export function silenceFx() {
  for (const fx of instances.values()) { try { fx.destroy() } catch { /* already gone */ } }
  instances.clear()
  for (const r of routers.values()) r.node = null
}

let lastCollect = 0
function collect() {
  const now = Date.now()
  if (now - lastCollect < 5000) return
  lastCollect = now
  for (const [id, r] of routers) {
    if (now - r.at < 30_000) continue
    try { r.node?.disconnect() } catch { /* already gone */ }
    if (controller?.buses[id] === r.node) delete controller.buses[id]
    routers.delete(id)
  }
  // effects taken out of the patch, once their tails have long finished
  for (const [k, fx] of instances) {
    if (declared.has(fx.key) || now - fx.at < 20_000) continue
    fx.destroy()
    instances.delete(k)
  }
}

// ── the effects ───────────────────────────────────────────────────────────────
const stereo = (ac, gain = 1) => new GainNode(ac, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
const glide = (param, value, ac, tc = 0.02) => { param.cancelScheduledValues(ac.currentTime); param.setTargetAtTime(value, ac.currentTime, tc) }
const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)

/**
 * A room's impulse response: decorrelated noise decaying to −60 dB over `size` seconds,
 * darkening as it decays (air and walls eat the highs first), a few early reflections,
 * and scaled to the same energy whatever the size.
 */
export function roomImpulse(ac, { size, tone, width }) {
  const rate = ac.sampleRate
  const rt60 = num(size, 2.2, 0.1, 20)
  const length = Math.min(Math.ceil(rate * (rt60 * 1.25 + 0.05)), rate * 20)
  const buffer = ac.createBuffer(2, length, rate)
  const L = buffer.getChannelData(0)
  const R = buffer.getChannelData(1)
  const w = num(width, 1, 0, 1)
  const t = num(tone, 0.55, 0, 1)
  const fStart = 2500 + t * t * 16000 // bright at first …
  const fEnd = 250 + t * 4500 // … darker as it fades
  const decay = Math.log(1000) / rt60 // amplitude e^(-decay·s) reaches −60 dB at rt60
  const darken = 1 / Math.max(0.05, rt60 * 0.3)
  let lpL = 0
  let lpR = 0
  let lpL2 = 0
  let lpR2 = 0
  for (let i = 0; i < length; i++) {
    const s = i / rate
    const env = Math.exp(-decay * s)
    const fade = Math.min(1, s / 0.004) // no click at the very start
    const a = Math.random() * 2 - 1
    const b = Math.random() * 2 - 1
    // width: how different the two ears are (1 fully decorrelated, 0 mono)
    const nl = a
    const nr = w * b + (1 - w) * a
    const fc = fEnd + (fStart - fEnd) * Math.exp(-darken * s)
    const k = 1 - Math.exp((-2 * Math.PI * fc) / rate) // two one-pole lowpasses: a gentle 12 dB slope
    lpL += k * (nl - lpL); lpL2 += k * (lpL - lpL2)
    lpR += k * (nr - lpR); lpR2 += k * (lpR - lpR2)
    L[i] = lpL2 * env * fade
    R[i] = lpR2 * env * fade
  }
  // early reflections: a handful of quick bounces off near walls, scaled with the room
  const spread = Math.min(0.09, 0.008 + rt60 * 0.012)
  for (let j = 0; j < 7; j++) {
    const at = Math.floor(rate * (0.003 + spread * ((j + Math.random() * 0.6) / 7)))
    if (at >= length - 32) break
    const g = 0.55 * (1 - j / 8)
    const side = j % 2 ? R : L
    const other = j % 2 ? L : R
    for (let n = 0; n < 24; n++) { // a short soft burst rather than a click
      const shape = Math.sin((Math.PI * n) / 24)
      side[at + n] += g * shape * (Math.random() * 2 - 1)
      other[at + n] += g * shape * (1 - w) * (Math.random() * 2 - 1)
    }
  }
  // same energy for every room: size changes the space, not how loud the wet sound is
  let energy = 0
  for (let i = 0; i < length; i++) energy += L[i] * L[i] + R[i] * R[i]
  const scale = Math.sqrt(1.2 / Math.max(1e-9, energy))
  for (let i = 0; i < length; i++) { L[i] *= scale; R[i] *= scale }
  return buffer
}

function makeReverb(ac, initial) {
  const input = stereo(ac, 0)
  const pre = new DelayNode(ac, { maxDelayTime: 0.5, delayTime: 0.015 })
  const lowcut = new BiquadFilterNode(ac, { type: 'highpass', frequency: 160, Q: 0.6 })
  const output = stereo(ac, 1)
  // two convolvers, so a new room can fade in over the old one
  const slots = [0, 1].map(() => {
    const conv = new ConvolverNode(ac, { disableNormalization: true, channelCount: 2, channelCountMode: 'explicit' })
    const gain = stereo(ac, 0)
    lowcut.connect(conv)
    conv.connect(gain)
    gain.connect(output)
    return { conv, gain }
  })
  input.connect(pre)
  pre.connect(lowcut)
  let active = -1
  let room = null // the settings the current room was made with
  let timer = null
  let current = {}

  const build = () => {
    timer = null
    const next = { size: current.size, tone: current.tone, width: current.width }
    const buffer = roomImpulse(ac, next)
    const into = active === 0 ? 1 : 0
    const now = ac.currentTime
    slots[into].conv.buffer = buffer
    slots[into].gain.gain.cancelScheduledValues(now)
    slots[into].gain.gain.setValueAtTime(0, now)
    slots[into].gain.gain.linearRampToValueAtTime(1, now + 0.12)
    if (active >= 0) {
      slots[active].gain.gain.cancelScheduledValues(now)
      slots[active].gain.gain.setValueAtTime(slots[active].gain.gain.value, now)
      slots[active].gain.gain.linearRampToValueAtTime(0, now + 0.12)
    }
    active = into
    room = next
  }

  const fx = {
    input,
    output,
    set(params) {
      current = { ...REVERB_DEFAULTS, ...params }
      glide(input.gain, params.automatedMix ? 1 : num(current.mix, 0.35, 0, 1), ac)
      glide(pre.delayTime, num(current.predelay, 0.015, 0, 0.5), ac, 0.05)
      glide(lowcut.frequency, num(current.lowcut, 160, 20, 2000), ac, 0.03)
      const changed = !room || room.size !== current.size || room.tone !== current.tone || room.width !== current.width
      if (!changed) return
      clearTimeout(timer)
      if (!room) build()
      else timer = setTimeout(build, 90) // while a knob is turning, make the room once it settles
    },
    destroy() {
      clearTimeout(timer)
      const now = ac.currentTime
      output.gain.cancelScheduledValues(now)
      output.gain.setTargetAtTime(0, now, 0.004)
      setTimeout(() => { for (const n of [input, pre, lowcut, output, ...slots.flatMap((s) => [s.conv, s.gain])]) { try { n.disconnect() } catch { /* gone */ } } }, 60)
    },
  }
  fx.set(initial)
  return fx
}

/** tanh curve (no gain for quiet echoes): echoes that feed back hard saturate instead of running away. */
let softCurve = null
function softClip() {
  if (softCurve) return softCurve
  softCurve = new Float32Array(2048)
  for (let i = 0; i < 2048; i++) softCurve[i] = Math.tanh((i / 2047) * 2 - 1)
  return softCurve
}

function makeDelay(ac, initial) {
  const input = stereo(ac, 0)
  const output = stereo(ac, 1)
  const split = new ChannelSplitterNode(ac, { numberOfOutputs: 2 })
  const merge = new ChannelMergerNode(ac, { numberOfInputs: 2 })
  const mono = new GainNode(ac, { gain: 0.5 })
  const lines = [0, 1].map(() => {
    const delay = new DelayNode(ac, { maxDelayTime: 5, delayTime: 0.375 })
    const tone = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 6000, Q: 0.5 })
    const low = new BiquadFilterNode(ac, { type: 'highpass', frequency: 90, Q: 0.5 })
    const clip = new WaveShaperNode(ac, { curve: softClip(), oversample: '2x' })
    const feedback = new GainNode(ac, { gain: 0.4 })
    delay.connect(tone)
    tone.connect(low)
    low.connect(clip)
    return { delay, tone, low, clip, feedback }
  })
  input.connect(split)
  merge.connect(output)
  let mode = null
  const wire = (next) => {
    for (const l of lines) { try { l.clip.disconnect() } catch { /* not wired */ } try { l.feedback.disconnect() } catch { /* not wired */ } }
    try { split.disconnect() } catch { /* not wired */ }
    try { mono.disconnect() } catch { /* not wired */ }
    const [left, right] = lines
    if (next === 'ping-pong') {
      // both ears in, first echo left, then right, then left …
      split.connect(mono, 0)
      split.connect(mono, 1)
      mono.connect(left.delay)
      left.clip.connect(merge, 0, 0)
      left.clip.connect(left.feedback)
      left.feedback.connect(right.delay)
      right.clip.connect(merge, 0, 1)
      right.clip.connect(right.feedback)
      right.feedback.connect(left.delay)
    } else {
      lines.forEach((l, ch) => {
        split.connect(l.delay, ch)
        l.clip.connect(merge, 0, ch)
        l.clip.connect(l.feedback)
        l.feedback.connect(l.delay)
      })
    }
    mode = next
  }
  const fx = {
    input,
    output,
    set(params) {
      const p = { ...DELAY_DEFAULTS, ...params }
      glide(input.gain, params.automatedMix ? 1 : num(p.mix, 0.3, 0, 1), ac)
      const seconds = num(p.seconds, 0.375, 0.01, 4.5)
      // a new time glides like tape rather than jumping with a click
      for (const l of lines) {
        glide(l.delay.delayTime, seconds, ac, 0.04)
        glide(l.feedback.gain, num(p.feedback, 0.4, 0, 0.95), ac)
        glide(l.tone.frequency, 700 + num(p.tone, 0.6, 0, 1) ** 2 * 15000, ac, 0.03)
      }
      const next = p.mode === 'ping-pong' ? 'ping-pong' : 'stereo'
      if (next !== mode) wire(next)
    },
    destroy() {
      const now = ac.currentTime
      output.gain.cancelScheduledValues(now)
      output.gain.setTargetAtTime(0, now, 0.004)
      setTimeout(() => {
        for (const n of [input, output, split, merge, mono, ...lines.flatMap((l) => [l.delay, l.tone, l.low, l.clip, l.feedback])]) { try { n.disconnect() } catch { /* gone */ } }
      }, 60)
    },
  }
  fx.set(initial)
  return fx
}
