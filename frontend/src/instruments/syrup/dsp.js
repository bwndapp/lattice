import { knobsSource } from '../dsp.js'
import { AUDIO_PARAMS, K, LANES, LAYER_KNOBS, MAX_LAYERS, MAX_MODULATORS } from './model.js'
import { TABLES_SOURCE } from './tables.js'
import { SHAPE_SOURCE } from '../curve.js'

/**
 * Syrup on the audio thread: eight voices, each a stack of up to eight layers through the
 * amp envelope into three lanes, which mix into one another or out; moved by up to sixteen
 * modulators (LFOs and envelopes) through routes.
 *
 * A lane with effects is summed: every voice adds into it, and it leaves by one of the
 * three outputs after the voices' (8, 9, 10), for the effects outside (syrup/rig.js), which
 * also give it its level. Other lanes mix inside each voice and leave by the voice's output.
 * What a voice adds to a summed lane carries its note's own level and pan.
 *
 * Destinations outside the voices (lane effects' knobs, summed lanes' levels) follow the
 * newest note's modulators, and are reported to the rig about ninety times a second.
 *
 * What each layer and modulator is, and where routes go, arrives as a message (onData);
 * their knobs are AudioParams in fixed slots: l<layer>_<knob>, d<modulator>_<knob>.
 *
 * An LFO is a drawn shape, read from a table rebuilt when its points move; in free mode
 * every voice shares its clock, in retrig and env mode each voice starts its own at the
 * note. An envelope modulator runs per voice.
 *
 * Modulation works on a knob's travel (0 … 1 of it, log knobs in octaves), so a route's
 * amount means the same on every knob. It's worked out every 32 samples; the amp envelope,
 * glide and the sound itself every sample.
 */
const CONTROL = 32
const spec = (k) => ({ min: K[k].min, max: K[k].max, log: !!K[k].log })

export const SYRUP_DSP = `
${TABLES_SOURCE}
const SY_LKNOBS = ${JSON.stringify(LAYER_KNOBS.map(spec))}
const SY_CONTROL = ${CONTROL}
const SY_LAYERS = ${MAX_LAYERS}
const SY_MODS = ${MAX_MODULATORS}
const SY_LANES = ${LANES}
const SY_NN = Array.from({ length: SY_LANES }, (_, i) => 'n' + i + '_gain')
const SY_LANE_SPEC = ${JSON.stringify(spec('gain'))}
const SY_LN = Array.from({ length: SY_LAYERS }, (_, i) => ${JSON.stringify(LAYER_KNOBS)}.map((k) => 'l' + i + '_' + k))
const SY_DN = Array.from({ length: SY_MODS }, (_, j) => ({ hz: 'd' + j + '_hz', a: 'd' + j + '_attack', d: 'd' + j + '_decay', s: 'd' + j + '_sustain', r: 'd' + j + '_release' }))
const SY_LFO_TABLE = 1024
const syShape = ${SHAPE_SOURCE}
const syPos = (v, s) => (s.log ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min))
const syVal = (t, s) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return s.log ? s.min * (s.max / s.min) ** t : s.min + t * (s.max - s.min) }
// a layer knob moved by its routes, on the knob's travel
const syMod = (m, at, j, base) => { const mod = m[at + j]; return mod ? syVal(syPos(base, SY_LKNOBS[j]) + mod, SY_LKNOBS[j]) : base }
const syMtof = (m) => 440 * 2 ** ((m - 69) / 12)
const syBlep = (t, dt) => {
  if (t < dt) { t /= dt; return t + t - t * t - 1 }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1 }
  return 0
}
const syWrap = (p) => p - Math.floor(p)
const syDecay = (t, samples) => Math.exp(-samples / ((Math.max(0.001, t) / 5) * sampleRate))
const SY_FMWAVE = [
  (p) => Math.sin(2 * Math.PI * p),
  (p) => 1 - 4 * Math.abs(p - 0.5),
  (p) => 2 * p - 1,
  (p) => (p < 0.5 ? 1 : -1),
]

// the phase a wavetable is read at, bent by its warp mode
function syWarp(mode, p, w) {
  switch (mode) {
    case 1: return p ** (1 + w * 4) // bend+
    case 2: return 1 - (1 - p) ** (1 + w * 4) // bend-
    case 3: return syWrap(p * (1 + w * 7)) // sync
    case 4: { const m = (p < 0.5 ? p * 2 : 2 - p * 2) * 0.5; return p + (m - p) * w } // mirror: the first half, there and back
    case 5: { const k = 0.5 - w * 0.45; return p < k ? (p * 0.5) / k : 0.5 + ((p - k) * 0.5) / (1 - k) } // pwm
    case 6: { const k = 0.5 + w * 0.45; return p < k ? (p * 0.5) / k : 0.5 + ((p - k) * 0.5) / (1 - k) } // asym
    case 7: { const steps = 2 ** (9 - w * 8); return Math.floor(p * steps) / steps } // quantize
    default: return p
  }
}

class SyrupProcessor extends LatticeInstrument {
  static voiceCount = 8
  static knobs = ${knobsSource(AUDIO_PARAMS)}
  constructor(options) {
    super(options)
    // what the patch is: set by onData
    this.cfg = { layers: [], modulators: [], routes: [], shared: [], mono: 0, lanes: [[-1, 0], [-1, 0], [-1, 0]], laneOrder: [0, 1, 2] }
    this.lfoPhase = new Float64Array(SY_MODS) // the shared clocks (free lfos)
    this.lfoStart = new Float64Array(SY_MODS) // where they were at the start of this block
    this.lfoRate = new Float64Array(SY_MODS)
    this.lfoTable = [] // slot → table, made when that slot first becomes an lfo
    this.modVal = new Float32Array(SY_MODS)
    this.notes = 0 // counts notes, to know the newest voice
    this.sharedTicks = 0
    this.mods = new Float32Array(100)
    this.bufL = new Float32Array(SY_CONTROL) // the voice's mix, out of the lanes
    this.bufR = new Float32Array(SY_CONTROL)
    // the summed lanes, this block, across every voice
    this.busL = Array.from({ length: SY_LANES }, () => new Float32Array(128))
    this.busR = Array.from({ length: SY_LANES }, () => new Float32Array(128))
    this.ampBuf = new Float32Array(SY_CONTROL)
    this.laneL = Array.from({ length: SY_LANES }, () => new Float32Array(SY_CONTROL))
    this.laneR = Array.from({ length: SY_LANES }, () => new Float32Array(SY_CONTROL))
    this.fmBuf = new Float32Array(SY_CONTROL)
  }
  newVoice() {
    return {
      active: false, pitch: 60, target: 60, vel: 1,
      amp: { stage: 0, v: 0 },
      envs: Array.from({ length: SY_MODS }, () => ({ stage: 0, v: 0 })), // envelope modulators
      modPh: new Float64Array(SY_MODS), // each voice's own place in retrig and env lfos
      mv: new Float32Array(SY_MODS), // its modulators' values, last worked out
      order: 0, gain: 1, panL: [1, 0], panR: [0, 1], // when it started, and its note's level and pan
      layers: Array.from({ length: SY_LAYERS }, () => ({ ph: new Float64Array(16), fm: 0, pink: new Float32Array(7), brown: 0, gl: new Float32Array(16), gr: new Float32Array(16), warm: false })),
      counter: 0, ctl: null,
    }
  }
  // for the window: each lfo's shared clock, and each sounding voice's own places
  report() {
    const n = this.cfg.modulators.length
    const voices = []
    for (const v of this.voices) if (v.active) voices.push(Array.from(v.modPh.subarray(0, n)))
    return { lfo: Array.from(this.lfoPhase.subarray(0, n)), voices }
  }
  // what the patch is, when it changes
  onData(data) {
    const cfg = this.cfg
    if (Array.isArray(data.layers)) cfg.layers = data.layers.slice(0, SY_LAYERS)
    if (Array.isArray(data.routes)) cfg.routes = data.routes
    if (Array.isArray(data.shared)) cfg.shared = data.shared
    if (data.mono !== undefined) cfg.mono = data.mono
    if (Array.isArray(data.lanes)) cfg.lanes = data.lanes
    if (Array.isArray(data.laneOrder)) cfg.laneOrder = data.laneOrder
    if (Array.isArray(data.modulators)) {
      cfg.modulators = data.modulators.slice(0, SY_MODS)
      cfg.modulators.forEach((m, j) => {
        if (!m.lfo || !Array.isArray(m.points) || m.points.length < 2) return
        this.buildLfo(j, m.points)
      })
    }
  }
  // the lfos' clocks, once a block
  beginBlock(frames) {
    const k = this.k
    if (this.busL[0].length !== frames) {
      this.busL = this.busL.map(() => new Float32Array(frames))
      this.busR = this.busR.map(() => new Float32Array(frames))
    }
    for (let q = 0; q < SY_LANES; q++) { this.busL[q].fill(0); this.busR[q].fill(0) }
    const mods = this.cfg.modulators
    // where the song is at the start of this block, for the lfos that follow it
    const cycle = this.songCycle()
    for (let j = 0; j < mods.length; j++) {
      const m = mods[j]
      if (!m.lfo) continue
      const rate = m.sync ? k.cps / Math.max(1 / 64, m.bars) : k[SY_DN[j].hz]
      this.lfoRate[j] = rate
      if (m.sync && cycle != null) {
        // a synced lfo is *at* a place in the song rather than however far it has counted:
        // seek, loop or come back tomorrow and a one-bar sweep is still where the bar says
        const bars = Math.max(1 / 64, m.bars)
        this.lfoStart[j] = syWrap(cycle / bars)
        this.lfoPhase[j] = syWrap((cycle + (k.cps * frames) / sampleRate) / bars)
      } else {
        this.lfoStart[j] = this.lfoPhase[j]
        this.lfoPhase[j] = syWrap(this.lfoPhase[j] + (rate * frames) / sampleRate)
      }
    }
  }
  // a drawn shape as a table: the same curve as the editor, point to point
  buildLfo(j, pts) {
    const t = this.lfoTable[j] || (this.lfoTable[j] = new Float32Array(SY_LFO_TABLE + 1))
    const n = pts.length
    let seg = 0
    for (let i = 0; i <= SY_LFO_TABLE; i++) {
      const x = i / SY_LFO_TABLE
      while (seg < n - 2 && x >= pts[seg + 1][0]) seg++
      const [x0, y0, c, sh] = pts[seg]
      const [x1, y1] = pts[seg + 1]
      const u = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 1
      t[i] = (y0 + (y1 - y0) * syShape(u, c || 0, sh || 0)) * 2 - 1
    }
  }
  lfoAt(j, p) {
    const t = this.lfoTable[j]
    if (!t) return 0
    const x = p * SY_LFO_TABLE
    const i = x | 0
    return i >= SY_LFO_TABLE ? t[SY_LFO_TABLE] : t[i] + (t[i + 1] - t[i]) * (x - i)
  }
  noteOn(voice, note, vel, gain = 1, pan = 0.5) {
    const k = this.k
    voice.order = ++this.notes
    // the note's level and pan, as a stereo panner does it, for what this voice sums
    voice.gain = gain
    const x = pan * 2 - 1
    const t = ((x <= 0 ? x + 1 : x) * Math.PI) / 2
    const cl = Math.cos(t)
    const sn = Math.sin(t)
    // [from left, from right] into each side
    if (x <= 0) { voice.panL = [1, cl]; voice.panR = [0, sn] } else { voice.panL = [cl, 0]; voice.panR = [sn, 1] }
    const n = note >= 0 ? note : 60
    const legato = this.cfg.mono && voice.active && voice.gate && voice.amp.stage > 0 && voice.amp.stage < 4
    voice.target = n
    voice.vel = vel
    if (!(k.glide > 0.0005 && voice.active)) voice.pitch = n
    if (legato) return
    if (!voice.active) {
      // a fresh voice: unison voices start at scattered phases
      for (const l of voice.layers) { for (let u = 0; u < 16; u++) l.ph[u] = u ? Math.random() : 0; l.fm = 0; l.warm = false }
      voice.ctl = null
    }
    voice.active = true
    voice.modPh.fill(0) // retrig and env lfos start over with the note
    // envelopes restart from wherever they are, so a stolen voice doesn't click
    voice.amp.stage = 1
    for (const e of voice.envs) e.stage = 1
    voice.counter = 0
  }
  noteOff(voice) {
    if (voice.amp.stage) voice.amp.stage = 4
    for (const e of voice.envs) if (e.stage) e.stage = 4
  }
  // an envelope, \`samples\` on: attack in a line, decay and release settling (d and r are
  // how much is left after those samples)
  step(e, samples, a, d, s, r) {
    switch (e.stage) {
      case 1: e.v += samples / (a * sampleRate); if (e.v >= 1) { e.v = 1; e.stage = 2 } break
      case 2: e.v = s + (e.v - s) * d; if (Math.abs(e.v - s) < 1e-4) { e.v = s; e.stage = 3 } break
      case 3: e.v = s; break
      case 4: e.v *= r; if (e.v < 1e-4) { e.v = 0; e.stage = 0 } break
    }
    return e.v
  }
  // what the knobs and routes add up to for this voice, for the next few samples
  control(voice, offset) {
    const k = this.k
    const cfg = this.cfg
    const m = this.mods
    m.fill(0)
    // every modulator's value for this voice, -1 … 1 or 0 … 1 as its polarity has it:
    // an envelope is 0 … 1; an lfo pushes up from its bottom (0 … 1), both ways around its
    // middle (half each way), or down from its top (-1 … 0)
    const mv = this.modVal
    for (let j = 0; j < cfg.modulators.length; j++) {
      const mod = cfg.modulators[j]
      if (!mod.lfo) {
        const N = SY_DN[j]
        mv[j] = this.step(voice.envs[j], SY_CONTROL, k[N.a], syDecay(k[N.d], SY_CONTROL), k[N.s], syDecay(k[N.r], SY_CONTROL))
        continue
      }
      let p
      // free: the shared clock at this very sample, not where the block began (that stepped)
      if (!mod.mode) p = syWrap(this.lfoStart[j] + (this.lfoRate[j] * offset) / sampleRate)
      else {
        p = voice.modPh[j]
        const next = p + (this.lfoRate[j] * SY_CONTROL) / sampleRate
        voice.modPh[j] = mod.mode === 1 ? syWrap(next) : Math.min(1, next) // env: once, then hold
      }
      const v = this.lfoAt(j, p)
      mv[j] = mod.polarity === 1 ? v * 0.5 : mod.polarity === 0 ? (v + 1) * 0.5 : (v - 1) * 0.5
    }
    for (const [src, dest, amt] of cfg.routes) m[dest] += amt * mv[src]
    voice.mv.set(mv.subarray(0, cfg.modulators.length))

    const c = voice.ctl || (voice.ctl = { layers: Array.from({ length: SY_LAYERS }, () => ({})) })
    if (c.adT !== k.a_decay) { c.adT = k.a_decay; c.ad = syDecay(k.a_decay, 1) }
    if (c.arT !== k.a_release) { c.arT = k.a_release; c.ar = syDecay(k.a_release, 1) }
    c.glide = k.glide > 0.0005 ? Math.exp(-SY_CONTROL / (k.glide / 3 * sampleRate)) : 0
    const semis = m[1] * 24
    c.ampFrom = c.amp === undefined ? null : c.amp
    c.amp = Math.min(1.5, Math.max(0, 1 + m[2])) * k.volume * 0.35
    // each lane's level, where routes move it too, gliding from where it was
    c.laneFrom = c.lane || null
    c.lane = [0, 1, 2].map((i) => (cfg.lanes[i] && cfg.lanes[i][1] ? 0 : syVal(syPos(k[SY_NN[i]], SY_LANE_SPEC) + m[3 + i], SY_LANE_SPEC)))
    c.count = cfg.layers.length
    for (let i = 0; i < c.count; i++) {
      const L = c.layers[i]
      const conf = cfg.layers[i]
      L.on = conf[0] > 0
      if (!L.on) continue
      const N = SY_LN[i]
      const lm = 10 + i * 10
      L.lane = conf[9] > 0 && conf[9] < SY_LANES ? conf[9] : 0
      L.type = conf[1]
      L.wave = conf[2]
      L.table = conf[3]
      L.noise = conf[4]
      L.warpmode = conf[5]
      L.fmwave = conf[6]
      L.level = syMod(m, lm, 0, k[N[0]])
      L.pan = syMod(m, lm, 1, k[N[1]]) * 2 - 1
      L.pw = syMod(m, lm, 3, k[N[3]])
      L.pos = syMod(m, lm, 4, k[N[4]])
      L.warp = syMod(m, lm, 5, k[N[5]])
      L.detune = syMod(m, lm, 6, k[N[6]])
      L.spread = syMod(m, lm, 7, k[N[7]])
      L.fm = syMod(m, lm, 8, k[N[8]])
      L.ratio = syMod(m, lm, 9, k[N[9]])
      L.unison = Math.max(1, Math.min(16, conf[8] | 0))
      L.freq = syMtof(voice.pitch + conf[7] + syMod(m, lm, 2, k[N[2]]) / 100 + semis)
      L.norm = 1 / Math.sqrt(L.unison)
      if (L.type === 2) {
        // the richest copy of the table whose harmonics all fit under the top of the band
        const room = (0.45 * sampleRate) / Math.max(1, L.freq)
        const table = syTable(L.table)
        const levels = table.levels
        let lv = levels[levels.length - 1]
        for (let x = 0; x < levels.length; x++) if (levels[x].harmonics <= room) { lv = levels[x]; break }
        L.tab = table
        L.lvl = lv
      }
    }
  }
  // the summed lanes out, after the voices' outputs; and, now and then, where the shared
  // destinations are: the newest note's modulators (free lfos from their own clock)
  endBlock(outputs) {
    const shared = this.cfg.shared
    if (shared.length && ++this.sharedTicks >= 4) {
      this.sharedTicks = 0
      let newest = null
      for (const v of this.voices) if (v.order && (!newest || v.order > newest.order)) newest = v
      const mods = this.cfg.modulators
      const vals = new Float32Array(mods.length)
      for (let j = 0; j < mods.length; j++) {
        const m = mods[j]
        if (m.lfo && !m.mode) {
          const v = this.lfoAt(j, this.lfoPhase[j])
          vals[j] = m.polarity === 1 ? v * 0.5 : m.polarity === 0 ? (v + 1) * 0.5 : (v - 1) * 0.5
        } else vals[j] = newest ? newest.mv[j] : 0
      }
      const out = []
      for (const [src, at, amt] of shared) out[at] = (out[at] || 0) + amt * (vals[src] || 0)
      this.port.postMessage({ mods: out })
    }
    const base = this.voices.length
    for (let q = 0; q < SY_LANES; q++) {
      const out = outputs[base + q]
      if (!out || !out.length) continue
      out[0].set(this.busL[q])
      if (out[1]) out[1].set(this.busR[q])
    }
  }
  busy(voice) { return voice.active }
  render(voice, OL, OR, from, to) {
    const k = this.k
    const bufL = this.bufL
    const bufR = this.bufR
    let i = from
    while (i < to) {
      if (voice.counter <= 0) {
        if (voice.ctl && voice.ctl.glide) voice.pitch = voice.target + (voice.pitch - voice.target) * voice.ctl.glide
        else voice.pitch = voice.target
        this.control(voice, i)
        voice.counter = SY_CONTROL
      }
      const n = Math.min(to - i, voice.counter)
      const c = voice.ctl
      bufL.fill(0, 0, n)
      bufR.fill(0, 0, n)
      const laneL = this.laneL
      const laneR = this.laneR
      for (let q = 0; q < SY_LANES; q++) { laneL[q].fill(0, 0, n); laneR[q].fill(0, 0, n) }
      // every layer into its lane
      for (let li = 0; li < c.count; li++) {
        const L = c.layers[li]
        if (!L.on || L.level <= 0) continue
        this.layer(voice.layers[li], L, laneL[L.lane], laneR[L.lane], n)
      }
      // the amp envelope and the voice's level, on everything, before the lanes
      const a0 = c.ampFrom === null ? c.amp : c.ampFrom
      const aStep = (c.amp - a0) / SY_CONTROL
      const aStart = a0 + aStep * (SY_CONTROL - voice.counter)
      const amp = this.ampBuf
      let ended = n
      for (let j = 0; j < n; j++) {
        amp[j] = this.step(voice.amp, 1, k.a_attack, c.ad, k.a_sustain, c.ar) * (aStart + aStep * j)
        if (voice.amp.stage === 0) { ended = j + 1; break }
      }
      for (let q = 0; q < SY_LANES; q++) {
        const inL = laneL[q]
        const inR = laneR[q]
        for (let j = 0; j < ended; j++) { inL[j] *= amp[j]; inR[j] *= amp[j] }
      }
      // the lanes, in order: a summed one adds this voice into the shared mix (its level is
      // applied outside); the others go at their level into the lane they feed, or out
      const done = SY_CONTROL - voice.counter
      const lanes = this.cfg.lanes
      for (const q of this.cfg.laneOrder) {
        const conf = lanes[q] || [-1, 0, 0]
        const inL = laneL[q]
        const inR = laneR[q]
        if (conf[2]) {
          const bL = this.busL[q]
          const bR = this.busR[q]
          const g = voice.vel * voice.gain
          const [aL, bLr] = voice.panL
          const [aR, bRr] = voice.panR
          for (let j = 0; j < ended; j++) {
            const l = inL[j] * g
            const r = inR[j] * g
            bL[i + j] += l * aL + r * bLr
            bR[i + j] += l * aR + r * bRr
          }
          continue
        }
        const to = conf[0] >= 0 && conf[0] !== q ? conf[0] : -1
        const summedTo = to >= 0 && lanes[to] && lanes[to][2]
        const outL = to < 0 ? bufL : summedTo ? this.busL[to] : laneL[to]
        const outR = to < 0 ? bufR : summedTo ? this.busR[to] : laneR[to]
        const at = summedTo ? i : 0 // the shared mix is laid out by the block, a voice's by the step
        const vel = summedTo ? voice.vel * voice.gain : 1
        const g1 = c.lane[q]
        const g0 = c.laneFrom ? c.laneFrom[q] : g1
        if (g0 === 0 && g1 === 0) continue
        const gs = (g1 - g0) / SY_CONTROL
        for (let j = 0; j < ended; j++) {
          const g = (g0 + gs * (done + j)) * vel
          outL[at + j] += inL[j] * g
          outR[at + j] += inR[j] * g
        }
      }
      for (let j = 0; j < ended; j++) {
        OL[i + j] += bufL[j]
        if (OR !== OL) OR[i + j] += bufR[j]
      }
      if (voice.amp.stage === 0) { voice.active = false; voice.ctl = null; return }
      voice.counter -= n
      i += n
    }
  }
  // one layer's sound for n samples, added into the buffers
  layer(st, L, bufL, bufR, n) {
    const N = L.type === 1 || L.type === 2 ? L.unison : 1
    const dt0 = L.freq / sampleRate
    // noise: one source, panned
    if (L.type === 3) {
      const gl1 = Math.cos(((L.pan + 1) * Math.PI) / 4) * L.level
      const gr1 = Math.sin(((L.pan + 1) * Math.PI) / 4) * L.level
      let gl = st.warm ? st.gl[0] : gl1
      let gr = st.warm ? st.gr[0] : gr1
      const sl = (gl1 - gl) / n
      const sr = (gr1 - gr) / n
      st.gl[0] = gl1
      st.gr[0] = gr1
      st.warm = true
      const p = st.pink
      for (let j = 0; j < n; j++) {
        gl += sl
        gr += sr
        const w = Math.random() * 2 - 1
        let y = w
        if (L.noise === 1) {
          p[0] = 0.99886 * p[0] + w * 0.0555179; p[1] = 0.99332 * p[1] + w * 0.0750759
          p[2] = 0.969 * p[2] + w * 0.153852; p[3] = 0.8665 * p[3] + w * 0.3104856
          p[4] = 0.55 * p[4] + w * 0.5329522; p[5] = -0.7616 * p[5] - w * 0.016898
          y = (p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + w * 0.5362) * 0.11
          p[6] = w * 0.115926
        } else if (L.noise === 2) {
          st.brown = (st.brown + w * 0.02) * 0.998
          y = st.brown * 3.5
        }
        bufL[j] += y * gl
        bufR[j] += y * gr
      }
      return
    }
    const fmOn = L.fm > 0.001
    const fmw = SY_FMWAVE[L.fmwave] || SY_FMWAVE[0]
    const fmDepth = L.fm / (2 * Math.PI)
    // the FM modulator, once for the layer: every unison voice hears the same one
    if (fmOn) {
      let fm = st.fm
      const step = dt0 * L.ratio
      for (let j = 0; j < n; j++) { fm += step; if (fm >= 1) fm -= Math.floor(fm); this.fmBuf[j] = fmw(fm) }
      st.fm = fm
    }
    // a wavetable's frames and copy don't change within these few samples
    const wt = L.type === 2
    const lv = wt ? L.lvl : null
    const len = wt ? lv.length : 0
    const fpos = wt ? L.pos * (L.tab.frames - 1) : 0
    const f0 = Math.floor(fpos)
    const ff = fpos - f0
    const fa = wt ? lv.data[f0] : null
    const fb = wt ? lv.data[Math.min(L.tab.frames - 1, f0 + 1)] : null
    const warpmode = L.warpmode
    const warp = L.warp
    const fold = wt && warpmode === 8 && warp > 0 ? (1 + warp * 5) * Math.PI / 2 : 0
    const wave = L.type === 1 ? 2 : L.wave
    const pw = wave === 3 ? 0.5 : L.pw
    for (let u = 0; u < N; u++) {
      const at = N === 1 ? 0 : (u / (N - 1)) * 2 - 1
      const dt = dt0 * 2 ** ((at * L.detune * 100) / 1200)
      const pan = Math.max(-1, Math.min(1, L.pan + at * L.spread * (u % 2 ? -1 : 1) * (N > 1 ? 1 : 0)))
      const gl1 = Math.cos(((pan + 1) * Math.PI) / 4) * L.level * L.norm
      const gr1 = Math.sin(((pan + 1) * Math.PI) / 4) * L.level * L.norm
      let gl = st.warm ? st.gl[u] : gl1
      let gr = st.warm ? st.gr[u] : gr1
      const sl = (gl1 - gl) / n
      const sr = (gr1 - gr) / n
      st.gl[u] = gl1
      st.gr[u] = gr1
      let ph = st.ph[u]
      for (let j = 0; j < n; j++) {
        gl += sl
        gr += sr
        ph += dt
        if (ph >= 1) ph -= 1
        let p = ph
        if (fmOn) p = syWrap(ph + fmDepth * this.fmBuf[j])
        let y
        if (wt) {
          const x = (warpmode ? syWarp(warpmode, p, warp) : p) * len
          const i0 = x | 0
          const fr = x - i0
          const ya = fa[i0] + (fa[i0 + 1] - fa[i0]) * fr
          y = ff ? ya + (fb[i0] + (fb[i0 + 1] - fb[i0]) * fr - ya) * ff : ya
          if (fold) y = Math.sin(y * fold)
        } else if (wave === 0) y = Math.sin(2 * Math.PI * p)
        else if (wave === 1) y = 1 - 4 * Math.abs(p - 0.5)
        else if (wave === 2) y = 2 * p - 1 - syBlep(p, dt)
        else y = (p < pw ? 1 : -1) + syBlep(p, dt) - syBlep(syWrap(p - pw + 1), dt)
        bufL[j] += y * gl
        bufR[j] += y * gr
      }
      st.ph[u] = ph
    }
    st.warm = true
  }
}
registerProcessor('lattice-syrup', SyrupProcessor)
`
