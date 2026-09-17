import { knobsSource } from '../dsp.js'
import { AUDIO_PARAMS, K, LAYER_KNOBS, LFO_PRESETS } from './model.js'
import { TABLES_SOURCE } from './tables.js'
import { SHAPE_SOURCE } from '../curve.js'

/**
 * Phyllo on the audio thread: eight voices, each up to four layers into an amp envelope, with a mod envelope per voice and two LFOs. An LFO is a drawn shape, read
 * from a table rebuilt whenever its points move; in free mode every voice shares one
 * clock, in retrig and env mode each voice starts its own at the note.
 *
 * Modulation works on a knob's travel (0 … 1 of it, log knobs in octaves), so a route's
 * amount means the same on every knob: 1 on an envelope sweeps the whole knob; 1 on an
 * LFO swings half of it either way. It's worked out every 32 samples; envelopes, glide
 * and the sound itself every sample.
 */
const CONTROL = 32
const spec = (k) => ({ min: K[k].min, max: K[k].max, log: !!K[k].log })

export const PHYLLO_DSP = `
${TABLES_SOURCE}
const PH_LKNOBS = ${JSON.stringify(LAYER_KNOBS.map(spec))}
const PH_CONTROL = ${CONTROL}
const PH_LN = [0, 1, 2, 3].map((i) => {
  const n = {}
  for (const f of ['on', 'type', 'wave', 'table', 'noise', 'warpmode', 'fmwave', 'level', 'pan', 'pitch', 'fine', 'pw', 'pos', 'warp', 'unison', 'detune', 'spread', 'fm', 'ratio']) n[f] = 'l' + i + '_' + f
  return n
})
const PH_LFO_TABLE = 1024
const PH_LFO_START = ${JSON.stringify(['sine', 'tri'].map((n) => LFO_PRESETS[n].map((p) => [p.x, p.y, p.c ?? 0, p.s ?? 0])))}
const phShape = ${SHAPE_SOURCE}
const PH_ON = [0, 1].map((i) => ({ mode: 'o' + i + '_mode', pol: 'o' + i + '_pol', sync: 'o' + i + '_sync', bars: 'o' + i + '_bars', hz: 'o' + i + '_hz' }))
const PH_MN = Array.from({ length: 12 }, (_, s) => ['m' + s + '_dest', 'm' + s + '_amt'])
const phPos = (v, s) => (s.log ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min))
const phVal = (t, s) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return s.log ? s.min * (s.max / s.min) ** t : s.min + t * (s.max - s.min) }
// a layer knob moved by its routes, on the knob's travel
const phMod = (m, at, j, base) => { const mod = m[at + j]; return mod ? phVal(phPos(base, PH_LKNOBS[j]) + mod, PH_LKNOBS[j]) : base }
const phMtof = (m) => 440 * 2 ** ((m - 69) / 12)
const phBlep = (t, dt) => {
  if (t < dt) { t /= dt; return t + t - t * t - 1 }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1 }
  return 0
}
const phWrap = (p) => p - Math.floor(p)
const PH_FMWAVE = [
  (p) => Math.sin(2 * Math.PI * p),
  (p) => 1 - 4 * Math.abs(p - 0.5),
  (p) => 2 * p - 1,
  (p) => (p < 0.5 ? 1 : -1),
]

// the phase a wavetable is read at, bent by its warp mode
function phWarp(mode, p, w) {
  switch (mode) {
    case 1: return p ** (1 + w * 4) // bend+
    case 2: return 1 - (1 - p) ** (1 + w * 4) // bend-
    case 3: return phWrap(p * (1 + w * 7)) // sync
    case 4: { const m = (p < 0.5 ? p * 2 : 2 - p * 2) * 0.5; return p + (m - p) * w } // mirror: the first half, there and back
    case 5: { const k = 0.5 - w * 0.45; return p < k ? (p * 0.5) / k : 0.5 + ((p - k) * 0.5) / (1 - k) } // pwm
    case 6: { const k = 0.5 + w * 0.45; return p < k ? (p * 0.5) / k : 0.5 + ((p - k) * 0.5) / (1 - k) } // asym
    case 7: { const steps = 2 ** (9 - w * 8); return Math.floor(p * steps) / steps } // quantize
    default: return p
  }
}

class PhylloProcessor extends LatticeInstrument {
  static voiceCount = 8
  static knobs = ${knobsSource(AUDIO_PARAMS)}
  constructor(options) {
    super(options)
    this.lfoPhase = [0, 0]
    this.lfoStart = [0, 0] // where the shared clock was at the start of this block
    this.lfoRate = [0, 0]
    this.lfoMode = [0, 0]
    this.lfoTable = [new Float32Array(PH_LFO_TABLE + 1), new Float32Array(PH_LFO_TABLE + 1)]
    this.buildLfo(0, PH_LFO_START[0])
    this.buildLfo(1, PH_LFO_START[1])
    this.mods = new Float32Array(64)
    this.bufL = new Float32Array(PH_CONTROL)
    this.bufR = new Float32Array(PH_CONTROL)
    this.fmBuf = new Float32Array(PH_CONTROL)
  }
  newVoice() {
    return {
      active: false, pitch: 60, target: 60, vel: 1, fresh: true,
      amp: { stage: 0, v: 0 }, env: { stage: 0, v: 0 },
      layers: [0, 1, 2, 3].map(() => ({ ph: new Float64Array(16), fm: 0, pink: new Float32Array(7), brown: 0, gl: new Float32Array(16), gr: new Float32Array(16), warm: false })),
      counter: 0, ctl: null,
      lfoPh: new Float64Array(2), // each voice's own place in the LFOs (retrig and env modes)
    }
  }
  // for the window: where the shared LFO clock is, and each sounding voice's own place
  report() {
    const voices = []
    for (const v of this.voices) if (v.active) voices.push([v.lfoPh[0], v.lfoPh[1]])
    return { lfo: [this.lfoPhase[0], this.lfoPhase[1]], voices }
  }
  // the drawn shapes, when they change
  onData(data) {
    if (data.lfos) data.lfos.forEach((points, i) => { if (i < 2 && Array.isArray(points) && points.length >= 2) this.buildLfo(i, points) })
  }
  // the two LFOs, once a block: their rates and the shared clock
  beginBlock(frames) {
    const k = this.k
    for (let i = 0; i < 2; i++) {
      const N = PH_ON[i]
      const rate = k[N.sync] > 0.5 ? k.cps / Math.max(1 / 64, k[N.bars]) : k[N.hz]
      this.lfoRate[i] = rate
      this.lfoMode[i] = Math.round(k[N.mode])
      this.lfoStart[i] = this.lfoPhase[i]
      this.lfoPhase[i] = phWrap(this.lfoPhase[i] + (rate * frames) / sampleRate)
    }
  }
  // the drawn shape as a table: the same curve as automation, point to point
  buildLfo(i, pts) {
    const t = this.lfoTable[i]
    const n = pts.length
    let seg = 0
    for (let j = 0; j <= PH_LFO_TABLE; j++) {
      const x = j / PH_LFO_TABLE
      while (seg < n - 2 && x >= pts[seg + 1][0]) seg++
      const [x0, y0, c, sh] = pts[seg]
      const [x1, y1] = pts[seg + 1]
      const u = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 1
      t[j] = (y0 + (y1 - y0) * phShape(u, c || 0, sh || 0)) * 2 - 1
    }
  }
  lfoAt(i, p) {
    const x = p * PH_LFO_TABLE
    const j = x | 0
    const t = this.lfoTable[i]
    return j >= PH_LFO_TABLE ? t[PH_LFO_TABLE] : t[j] + (t[j + 1] - t[j]) * (x - j)
  }
  noteOn(voice, note, vel) {
    const k = this.k
    const n = note >= 0 ? note : 60
    const legato = k.mono > 0.5 && voice.active && voice.gate && voice.amp.stage > 0 && voice.amp.stage < 4
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
    voice.lfoPh[0] = 0 // retrig and env LFOs start over with the note
    voice.lfoPh[1] = 0
    voice.amp.stage = 1 // envelopes restart from wherever they are, so a stolen voice doesn't click
    voice.env.stage = 1
    voice.counter = 0
  }
  noteOff(voice) {
    if (voice.amp.stage) voice.amp.stage = 4
    if (voice.env.stage) voice.env.stage = 4
  }
  // one envelope sample
  step(e, a, d, s, r) {
    switch (e.stage) {
      case 1: e.v += 1 / (a * sampleRate); if (e.v >= 1) { e.v = 1; e.stage = 2 } break
      case 2: e.v = s + (e.v - s) * d; if (Math.abs(e.v - s) < 1e-4) { e.v = s; e.stage = 3 } break
      case 3: e.v = s; break
      case 4: e.v *= r; if (e.v < 1e-4) { e.v = 0; e.stage = 0 } break
    }
    return e.v
  }
  // what the knobs and routes add up to for this voice, for the next few samples
  control(voice, offset) {
    const k = this.k
    const m = this.mods
    m.fill(0)
    // this voice's view of the LFOs: the shared clock, or its own from the note
    const lv = this.lfoVoice || (this.lfoVoice = [0, 0])
    for (let i = 0; i < 2; i++) {
      const mode = this.lfoMode[i]
      let p
      // free: the shared clock at this very sample, not where the block began (that stepped)
      if (mode === 0) p = phWrap(this.lfoStart[i] + (this.lfoRate[i] * offset) / sampleRate)
      else {
        p = voice.lfoPh[i]
        const next = p + (this.lfoRate[i] * PH_CONTROL) / sampleRate
        voice.lfoPh[i] = mode === 1 ? phWrap(next) : Math.min(1, next) // env: once, then hold
      }
      lv[i] = this.lfoAt(i, p)
    }
    for (let s = 0; s < 12; s++) {
      const dest = Math.round(k[PH_MN[s][0]])
      const amt = k[PH_MN[s][1]]
      if (!dest || !amt) continue
      // the envelope moves a knob up; an lfo moves it up from zero at its bottom (0 … 1),
      // both ways around its middle (half each way), or down from zero at its top (-1 … 0)
      let src = voice.env.v
      if (s >= 4) {
        const o = s < 8 ? 0 : 1
        const pol = Math.round(k[PH_ON[o].pol])
        src = pol === 1 ? lv[o] * 0.5 : pol === 0 ? (lv[o] + 1) * 0.5 : (lv[o] - 1) * 0.5
      }
      m[dest] += amt * src
    }
    const c = voice.ctl || (voice.ctl = { layers: [0, 1, 2, 3].map(() => ({})) })
    const coef = (t) => Math.exp(-1 / (Math.max(0.001, t) / 5 * sampleRate))
    if (c.adT !== k.a_decay) { c.adT = k.a_decay; c.ad = coef(k.a_decay) }
    if (c.arT !== k.a_release) { c.arT = k.a_release; c.ar = coef(k.a_release) }
    if (c.edT !== k.e_decay) { c.edT = k.e_decay; c.ed = coef(k.e_decay) }
    if (c.erT !== k.e_release) { c.erT = k.e_release; c.er = coef(k.e_release) }
    c.glide = k.glide > 0.0005 ? Math.exp(-PH_CONTROL / (k.glide / 3 * sampleRate)) : 0
    const semis = m[1] * 24
    c.ampFrom = c.amp === undefined ? null : c.amp
    c.amp = Math.min(1.5, Math.max(0, 1 + m[2])) * k.volume * 0.35
    for (let i = 0; i < 4; i++) {
      const L = c.layers[i]
      const N = PH_LN[i]
      L.on = k[N.on] > 0.5
      if (!L.on) continue
      const lm = 10 + i * 10
      L.type = Math.round(k[N.type])
      L.wave = Math.round(k[N.wave])
      L.table = Math.round(k[N.table])
      L.noise = Math.round(k[N.noise])
      L.warpmode = Math.round(k[N.warpmode])
      L.fmwave = Math.round(k[N.fmwave])
      L.level = phMod(m, lm, 0, k[N.level])
      L.pan = phMod(m, lm, 1, k[N.pan]) * 2 - 1
      L.pw = phMod(m, lm, 3, k[N.pw])
      L.pos = phMod(m, lm, 4, k[N.pos])
      L.warp = phMod(m, lm, 5, k[N.warp])
      L.detune = phMod(m, lm, 6, k[N.detune])
      L.spread = phMod(m, lm, 7, k[N.spread])
      L.fm = phMod(m, lm, 8, k[N.fm])
      L.ratio = k[N.ratio]
      L.unison = Math.max(1, Math.min(16, Math.round(k[N.unison])))
      L.freq = phMtof(voice.pitch + k[N.pitch] + phMod(m, lm, 2, k[N.fine]) / 100 + semis)
      L.norm = 1 / Math.sqrt(L.unison)
      if (L.type === 2) {
        // the richest copy of the table whose harmonics all fit under the top of the band
        const room = (0.45 * sampleRate) / Math.max(1, L.freq)
        const table = phTable(L.table)
        const levels = table.levels
        let lv = levels[levels.length - 1]
        for (let x = 0; x < levels.length; x++) if (levels[x].harmonics <= room) { lv = levels[x]; break }
        L.tab = table
        L.lvl = lv
      }
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
        voice.counter = PH_CONTROL
      }
      const n = Math.min(to - i, voice.counter)
      const c = voice.ctl
      bufL.fill(0, 0, n)
      bufR.fill(0, 0, n)
      for (let li = 0; li < 4; li++) {
        const L = c.layers[li]
        if (!L.on || L.level <= 0) continue
        this.layer(voice.layers[li], L, bufL, bufR, n)
      }
      // the level glides from where the last few samples left it
      const a0 = c.ampFrom === null ? c.amp : c.ampFrom
      const aStep = (c.amp - a0) / PH_CONTROL
      const aStart = a0 + aStep * (PH_CONTROL - voice.counter)
      for (let j = 0; j < n; j++) {
        const amp = this.step(voice.amp, k.a_attack, c.ad, k.a_sustain, c.ar)
        this.step(voice.env, k.e_attack, c.ed, k.e_sustain, c.er)
        const g = amp * (aStart + aStep * j)
        OL[i + j] += bufL[j] * g
        if (OR !== OL) OR[i + j] += bufR[j] * g
        if (voice.amp.stage === 0) { voice.active = false; voice.ctl = null; return }
      }
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
    const fmw = PH_FMWAVE[L.fmwave] || PH_FMWAVE[0]
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
        if (fmOn) p = phWrap(ph + fmDepth * this.fmBuf[j])
        let y
        if (wt) {
          const x = (warpmode ? phWarp(warpmode, p, warp) : p) * len
          const i0 = x | 0
          const fr = x - i0
          const ya = fa[i0] + (fa[i0 + 1] - fa[i0]) * fr
          y = ff ? ya + (fb[i0] + (fb[i0 + 1] - fb[i0]) * fr - ya) * ff : ya
          if (fold) y = Math.sin(y * fold)
        } else if (wave === 0) y = Math.sin(2 * Math.PI * p)
        else if (wave === 1) y = 1 - 4 * Math.abs(p - 0.5)
        else if (wave === 2) y = 2 * p - 1 - phBlep(p, dt)
        else y = (p < pw ? 1 : -1) + phBlep(p, dt) - phBlep(phWrap(p - pw + 1), dt)
        bufL[j] += y * gl
        bufR[j] += y * gr
      }
      st.ph[u] = ph
    }
    st.warm = true
  }
}
registerProcessor('lattice-phyllo', PhylloProcessor)
`
