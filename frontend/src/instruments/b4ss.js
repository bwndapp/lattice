import { knobsSource } from './dsp.js'

/**
 * B4SS: every bass from an 808 to a riddim growl, in one engine.
 *
 *   osc     a wave that morphs sine → triangle → saw → square, phase-modulated by a sine at
 *           a ratio of the note (FM: the growl), stacked up to 7 times and detuned (unison:
 *           reese and space basses), spread across the stereo field
 *   sub     a clean sine under it all, at the note or an octave down: it skips the dirt and
 *           the filter, so the low end stays solid however filthy the top gets
 *   pitch   an 808's drop (the note starts above itself and falls), octave and fine, and a
 *           glide: in mono, a note that comes in while the last is still held slides to it
 *           without starting over, as an 808 slide does
 *   amp     attack, decay, sustain, release
 *   dirt    tape, hard, fold, rectify or bite, before the filter, so the filter shapes the
 *           harmonics it makes
 *   filter  low, band, high or vowel (two formants that move a → e → i → o → u as it
 *           opens: the "yoi"), with resonance and an envelope
 *   wobble  an LFO in time with the song (a bar down to 1/32, triplets too) on the filter
 *           and the FM, or restarted with every note: the dubstep wobble, the riddim chop
 *   crush   bits and sample rate, after the filter
 */
const WAVES = ['sine', 'triangle', 'saw', 'square']
const RATIOS = ['½', '1', '2', '3', '4']
const RATIO_VALUES = [0.5, 1, 2, 3, 4]
const DIRT = ['tape', 'hard', 'fold', 'rectify', 'bite']
const FILTERS = ['low', 'band', 'high', 'vowel']
const RATES = ['off', '1 bar', '1/2', '1/4', '1/8', '1/16', '1/32', '1/4 t', '1/8 t', '1/16 t']
const RATE_PER_BAR = [0, 1, 2, 4, 8, 16, 32, 6, 12, 24]
const LFO_SHAPES = ['sine', 'triangle', 'saw', 'square', 'random']
const SYNC = ['song', 'note']
const MODES = ['mono', 'poly']
const SLIDES = ['legato', 'always']
const SUB_OCT = ['note', '−1 oct']
const TRIGGERS = ['auto', 'note length', 'one shot']

const PARAMS = [
  // osc
  { key: 'wave', group: 'osc', label: 'wave', min: 0, max: 3, def: 0 },
  { key: 'fm', group: 'osc', label: 'fm', min: 0, max: 1, def: 0 },
  { key: 'ratio', group: 'osc', label: 'fm ratio', min: 0, max: RATIOS.length - 1, def: 1, choices: RATIOS },
  { key: 'unison', group: 'osc', label: 'unison', min: 1, max: 7, def: 1, step: 1 },
  { key: 'detune', group: 'osc', label: 'detune', min: 0, max: 1, def: 0.25 },
  { key: 'width', group: 'osc', label: 'width', min: 0, max: 1, def: 0.6 },
  // sub
  { key: 'sub', group: 'sub', label: 'sub', min: 0, max: 1, def: 0 },
  { key: 'suboct', group: 'sub', label: 'octave', min: 0, max: 1, def: 0, choices: SUB_OCT },
  // pitch
  { key: 'octave', group: 'pitch', label: 'octave', min: -3, max: 2, def: 0, unit: 'oct', origin: 0, step: 1 },
  { key: 'fine', group: 'pitch', label: 'fine', min: -100, max: 100, def: 0, unit: 'ct', origin: 0 },
  { key: 'drop', group: 'pitch', label: 'drop', min: 0, max: 48, def: 0, unit: 'st' },
  { key: 'droptime', group: 'pitch', label: 'drop time', min: 0.005, max: 1, def: 0.06, log: true, unit: 's' },
  { key: 'mode', group: 'pitch', label: 'voices', min: 0, max: 1, def: 0, choices: MODES },
  { key: 'slide', group: 'pitch', label: 'slide', min: 0, max: 1, def: 0, choices: SLIDES },
  { key: 'glide', group: 'pitch', label: 'glide', min: 0, max: 1, def: 0, unit: 's' },
  // amp: how long a note lasts — auto plays a hit's whole decay (a drum step, or a sound with
  // no sustain, like an 808, however short its step), and a sustained sound as long as it's held
  { key: 'trigger', group: 'amp', label: 'trigger', min: 0, max: TRIGGERS.length - 1, def: 0, choices: TRIGGERS },
  { key: 'attack', group: 'amp', label: 'attack', min: 0, max: 1, def: 0.002, unit: 's' },
  { key: 'decay', group: 'amp', label: 'decay', min: 0.01, max: 8, def: 1.2, log: true, unit: 's' },
  { key: 'sustain', group: 'amp', label: 'sustain', min: 0, max: 1, def: 0.6 },
  { key: 'release', group: 'amp', label: 'release', min: 0.005, max: 4, def: 0.15, log: true, unit: 's' },
  // dirt
  { key: 'dtype', group: 'dirt', label: 'type', min: 0, max: DIRT.length - 1, def: 0, choices: DIRT },
  { key: 'drive', group: 'dirt', label: 'drive', min: 0, max: 1, def: 0 },
  { key: 'crush', group: 'dirt', label: 'crush', min: 0, max: 1, def: 0 },
  // filter
  { key: 'ftype', group: 'filter', label: 'type', min: 0, max: FILTERS.length - 1, def: 0, choices: FILTERS },
  { key: 'cutoff', group: 'filter', label: 'cutoff', min: 30, max: 18000, def: 18000, log: true, unit: 'hz' },
  { key: 'reso', group: 'filter', label: 'reso', min: 0, max: 1, def: 0.1 },
  { key: 'fenv', group: 'filter', label: 'env', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 },
  { key: 'fdecay', group: 'filter', label: 'env decay', min: 0.01, max: 4, def: 0.3, log: true, unit: 's' },
  // wobble
  { key: 'rate', group: 'wobble', label: 'rate', min: 0, max: RATES.length - 1, def: 0, choices: RATES },
  { key: 'lshape', group: 'wobble', label: 'shape', min: 0, max: LFO_SHAPES.length - 1, def: 0, choices: LFO_SHAPES },
  { key: 'sync', group: 'wobble', label: 'from', min: 0, max: 1, def: 0, choices: SYNC },
  { key: 'depth', group: 'wobble', label: 'filter', min: 0, max: 1, def: 0.7 },
  { key: 'lfm', group: 'wobble', label: 'fm', min: 0, max: 1, def: 0 },
  // out
  { key: 'level', group: 'out', label: 'level', min: -24, max: 6, def: 0, unit: 'db', origin: 0 },
]

const DSP = `
const B4_RATIOS = ${JSON.stringify(RATIO_VALUES)}
const B4_RATE = ${JSON.stringify(RATE_PER_BAR)}
const B4_MAX_UNI = 7
// formants (F1, F2) for a e i o u: a vowel filter walks these as it opens
const B4_VOWELS = [[800, 1150], [400, 1600], [300, 2300], [450, 800], [325, 700]]
const B4_TAU = Math.PI * 2

/** A state-variable filter (Cytomic's, trapezoidal): lowpass, bandpass and highpass at once. */
class B4Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 2 }
  set(fc, res) {
    const g = Math.tan(Math.PI * Math.min(fc, sampleRate * 0.45) / sampleRate)
    this.k = 2 - 1.94 * res
    this.a1 = 1 / (1 + g * (g + this.k))
    this.a2 = g * this.a1
    this.a3 = g * this.a2
  }
  tick(x) {
    const v3 = x - this.ic2
    const v1 = this.a1 * this.ic1 + this.a2 * v3
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2
    return v2
  }
}

/** PolyBLEP: takes the step out of a saw or square's jump, so they don't alias as badly. */
function b4Blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1 }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1 }
  return 0
}

/** One wave at phase p (0 … 1), dt its step a sample: 0 sine, 1 triangle, 2 saw, 3 square. */
function b4Wave(w, p, dt) {
  if (w === 0) return Math.sin(B4_TAU * p)
  if (w === 1) return 1 - 4 * Math.abs(p - 0.5)
  if (w === 2) return 2 * p - 1 - b4Blep(p, dt)
  let q = p + 0.5; if (q >= 1) q -= 1
  return (p < 0.5 ? 1 : -1) + b4Blep(p, dt) - b4Blep(q, dt)
}

class B4ssProcessor extends LatticeInstrument {
  static voiceCount = 6
  static knobs = ${knobsSource(PARAMS)}
  newVoice() {
    return {
      active: false, gate: 0, gateOpen: false, t: 0, env: 0, stage: 0, fenv: 0,
      pitch: 36, target: 36, phases: new Float64Array(B4_MAX_UNI), mod: 0, sub: 0,
      f1: new B4Svf(), f2: new B4Svf(), held: 0, holdN: 0, hold: 0, lfoHeld: 0, lfoStep: -1, seed: 1,
      dcx: 0, dcy: 0, dcx2: 0, dcy2: 0, coefN: 0, level: 0,
    }
  }
  noteOn(v, note, vel) {
    const k = this.k
    const n = note >= 0 ? note : 36 // a drum step plays C1-ish: an 808 on the grid
    const mono = Math.round(k.mode) === 0
    const sliding = mono && v.active && k.glide > 0.0005 && (Math.round(k.slide) === 1 || v.gateOpen)
    v.target = n
    const trig = Math.round(k.trigger)
    // one shot: it plays attack and decay through, then lets go, whatever the note's length
    // auto: a drum step, or a sound with no sustain (a hit that dies away, like an 808)
    v.shot = trig === 2 || (trig === 0 && (note < 0 || k.sustain < 0.05))
    if (!sliding) {
      v.pitch = n
      // the amp starts over; a note slid into keeps it going, as an 808 slide does
      v.t = 0
      v.stage = 0
      v.fenv = 1
      if (!v.active) {
        v.env = 0
        for (let i = 0; i < B4_MAX_UNI; i++) v.phases[i] = i === 0 ? 0 : Math.random()
        v.mod = 0
        v.sub = 0
      }
    }
    v.gateOpen = true
    v.active = true
    v.vel = vel
  }
  noteOff(v) { v.gateOpen = false }
  busy(v) { return v.active }
  lfo(v, shape, ph) {
    const p = ph - Math.floor(ph)
    if (shape === 0) return 0.5 + 0.5 * Math.sin(B4_TAU * p)
    if (shape === 1) return 1 - 2 * Math.abs(p - 0.5)
    if (shape === 2) return 1 - p // a falling saw: the wobble that opens and shuts
    if (shape === 3) return p < 0.5 ? 1 : 0
    const step = Math.floor(ph)
    if (step !== v.lfoStep) { v.lfoStep = step; v.seed = (v.seed * 1664525 + 1013904223 + step) >>> 0; v.lfoHeld = v.seed / 4294967296 }
    return v.lfoHeld
  }
  render(v, L, R, from, to) {
    const k = this.k
    const sr = sampleRate
    const dt = 1 / sr
    const wave = Math.max(0, Math.min(3, k.wave))
    const w0 = Math.min(2, Math.floor(wave))
    const wf = wave - w0
    const uni = Math.max(1, Math.min(B4_MAX_UNI, Math.round(k.unison)))
    const ratio = B4_RATIOS[Math.round(k.ratio)] ?? 1
    const dtype = Math.round(k.dtype)
    const ftype = Math.round(k.ftype)
    const perBar = B4_RATE[Math.round(k.rate)] || 0
    const shape = Math.round(k.lshape)
    const fromNote = Math.round(k.sync) === 1
    const cps = (this.song && this.song.cps) || 0.5625
    const cycle = this.songCycle()
    const subMul = Math.round(k.suboct) === 1 ? 0.5 : 1
    const gain = 10 ** (k.level / 20) * 0.5
    const drive = k.drive
    const g = 1 + drive * drive * 40 // how hard into the curve
    const crush = k.crush
    const bits = crush > 0.001 ? 2 ** (14 - crush * 11) : 0
    const holdLen = crush > 0.001 ? 1 + Math.round(crush * crush * 30) : 1
    const glideA = k.glide > 0.0005 ? 1 - Math.exp(-1 / (k.glide * 0.35 * sr)) : 1
    const dropA = k.drop > 0 ? 5 / k.droptime : 0
    const attackStep = k.attack > 0.0005 ? dt / k.attack : 1
    const decayA = Math.exp(-5 / (k.decay * sr))
    const releaseA = Math.exp(-5 / (k.release * sr))
    const fdecayA = Math.exp(-5 / (k.fdecay * sr))
    // unison: spread in pitch (up to ±0.6 semitones) and across the field
    const spread = k.detune * 0.6
    for (let i = from; i < to; i++) {
      // ── envelopes ──
      const held = v.shot ? v.t < k.attack + k.decay : v.gateOpen
      if (held) {
        if (v.stage === 0) { v.env += attackStep; if (v.env >= 1) { v.env = 1; v.stage = 1 } }
        else v.env = k.sustain + (v.env - k.sustain) * decayA
      } else {
        v.env *= releaseA
        if (v.env < 1e-4 && v.t > 0.002) { v.active = false; v.env = 0; break }
      }
      v.fenv *= fdecayA
      // ── pitch ──
      v.pitch += (v.target - v.pitch) * glideA
      const drop = dropA ? k.drop * Math.exp(-v.t * dropA) : 0
      const midi = v.pitch + k.octave * 12 + k.fine / 100 + drop
      const f = 440 * 2 ** ((midi - 69) / 12)
      // ── wobble ──
      let lfo = 1
      if (perBar) {
        const ph = fromNote || cycle === null ? v.t * cps * perBar : (cycle + (i - from) * dt * cps) * perBar
        lfo = this.lfo(v, shape, ph)
      }
      // ── osc: unison stack, phase-modulated ──
      const fmAmt = Math.min(1.5, k.fm + k.lfm * lfo) * 6
      v.mod += f * ratio * dt
      if (v.mod >= 1) v.mod -= Math.floor(v.mod)
      const pm = fmAmt > 0 ? fmAmt * Math.sin(B4_TAU * v.mod) / B4_TAU : 0
      let l = 0, r = 0
      for (let u = 0; u < uni; u++) {
        const off = uni === 1 ? 0 : (u / (uni - 1)) * 2 - 1
        const fu = f * 2 ** ((off * spread) / 12)
        const step = fu * dt
        let p = v.phases[u] + step
        if (p >= 1) p -= 1
        v.phases[u] = p
        let q = p + pm
        q -= Math.floor(q)
        let s = b4Wave(w0, q, step)
        if (wf > 0.001) s += (b4Wave(w0 + 1, q, step) - s) * wf
        const pan = 0.5 + off * 0.5 * k.width
        l += s * Math.cos(pan * Math.PI * 0.5)
        r += s * Math.sin(pan * Math.PI * 0.5)
      }
      const norm = 1.4 / Math.sqrt(uni)
      l *= norm; r *= norm
      // ── dirt ──
      if (drive > 0.001) { l = this.dirt(dtype, l, g); r = this.dirt(dtype, r, g) }
      // ── filter ──
      if (v.coefN-- <= 0) {
        v.coefN = 3
        const wob = perBar ? -k.depth * 7 * (1 - lfo) : 0
        const fc = Math.max(25, Math.min(19000, k.cutoff * 2 ** (wob + k.fenv * 7 * v.fenv)))
        if (ftype === 3) {
          // where the cutoff is, as a place along a e i o u
          const at = Math.max(0, Math.min(0.9999, Math.log(fc / 30) / Math.log(19000 / 30))) * 4
          const a = Math.floor(at), b = Math.min(4, a + 1), x = at - a
          const F1 = B4_VOWELS[a][0] + (B4_VOWELS[b][0] - B4_VOWELS[a][0]) * x
          const F2 = B4_VOWELS[a][1] + (B4_VOWELS[b][1] - B4_VOWELS[a][1]) * x
          v.f1.set(F1, 0.55 + k.reso * 0.42)
          v.f2.set(F2, 0.55 + k.reso * 0.42)
        } else {
          v.f1.set(fc, k.reso)
          v.f2.set(fc, k.reso)
        }
      }
      if (ftype === 3) {
        v.f1.tick(l); const a = v.f1.bp
        v.f2.tick(r); const b = v.f2.bp
        // both formants on both sides: the vowel, kept in stereo by running each side through one and mixing
        l = a * 2.2 + b * 1.2
        r = b * 2.2 + a * 1.2
      } else {
        v.f1.tick(l); v.f2.tick(r)
        if (ftype === 0) { l = v.f1.lp; r = v.f2.lp }
        else if (ftype === 1) { l = v.f1.bp * 1.6; r = v.f2.bp * 1.6 }
        else { l = v.f1.hp; r = v.f2.hp }
      }
      // ── crush ──
      if (crush > 0.001) {
        if (v.holdN-- <= 0) { v.holdN = holdLen - 1; v.held = l; v.hold = r }
        l = Math.round(v.held * bits) / bits
        r = Math.round(v.hold * bits) / bits
      }
      // ── sub, clean, under it all ──
      v.sub += f * subMul * dt
      if (v.sub >= 1) v.sub -= 1
      const sub = k.sub * Math.sin(B4_TAU * v.sub) * 1.2
      l = (l + sub) * v.env
      r = (r + sub) * v.env
      // no DC (rectify and bite make some), and a soft ceiling
      const dl = l - v.dcx + 0.9995 * v.dcy; v.dcx = l; v.dcy = dl
      const dr = r - v.dcx2 + 0.9995 * v.dcy2; v.dcx2 = r; v.dcy2 = dr
      const ol = Math.tanh(dl * gain * 1.6) / 1.2
      const or = Math.tanh(dr * gain * 1.6) / 1.2
      L[i] += ol
      if (R !== L) R[i] += or
      v.t += dt
    }
  }
  dirt(type, x, g) {
    const y = x * g
    if (type === 0) return Math.tanh(y) / Math.tanh(Math.min(g, 3))
    if (type === 1) return Math.max(-1, Math.min(1, y))
    if (type === 2) return Math.sin(y * 0.5 * Math.PI) // folds back on itself the harder it's pushed
    if (type === 3) return Math.tanh(Math.abs(y) * 1.5 - 0.5 + x * 0.3) // rectified: an octave up, hollow and nasty
    return Math.tanh(y + 0.35 * y * y) / (1 + 0.2 * g * 0.05) // bite: lopsided, like a tube pushed too far
  }
}
registerProcessor('lattice-b4ss', B4ssProcessor)
`

const ix = (list, name) => list.indexOf(name)
const PRESETS = [
  // 808s
  { name: 'clean 808', group: '808', data: { trigger: 2, wave: 0, drop: 12, droptime: 0.05, decay: 1.6, sustain: 0, release: 0.2, octave: 0 } },
  { name: 'distorted 808', group: '808', data: { trigger: 2, wave: 0, drop: 14, droptime: 0.04, decay: 1.8, sustain: 0, release: 0.2, dtype: ix(DIRT, 'tape'), drive: 0.55, sub: 0.5 } },
  { name: 'slide 808', group: '808', data: { wave: 0, drop: 10, droptime: 0.05, decay: 3, sustain: 0.35, release: 0.25, glide: 0.12, dtype: ix(DIRT, 'tape'), drive: 0.35, sub: 0.4 } },
  { name: 'drill 808', group: '808', data: { wave: 0.4, drop: 20, droptime: 0.03, decay: 2.2, sustain: 0.2, release: 0.15, glide: 0.08, slide: ix(SLIDES, 'always'), dtype: ix(DIRT, 'bite'), drive: 0.5, sub: 0.6, cutoff: 3000 } },
  { name: 'knocking 808', group: '808', data: { trigger: 2, wave: 0.2, drop: 24, droptime: 0.025, decay: 0.9, sustain: 0, release: 0.1, dtype: ix(DIRT, 'hard'), drive: 0.7, sub: 0.6, cutoff: 2500 } },
  // dubstep
  { name: 'wobble', group: 'dubstep', data: { wave: 2, unison: 3, detune: 0.2, sub: 0.6, suboct: 1, ftype: ix(FILTERS, 'low'), cutoff: 2800, reso: 0.55, rate: ix(RATES, '1/8'), lshape: ix(LFO_SHAPES, 'sine'), depth: 0.8, dtype: ix(DIRT, 'tape'), drive: 0.4, decay: 2, sustain: 0.9, release: 0.1 } },
  { name: 'growl', group: 'dubstep', data: { wave: 2.4, fm: 0.35, ratio: ix(RATIOS, '1'), sub: 0.6, suboct: 1, ftype: ix(FILTERS, 'band'), cutoff: 1200, reso: 0.6, rate: ix(RATES, '1/16'), lshape: ix(LFO_SHAPES, 'triangle'), depth: 0.6, lfm: 0.4, dtype: ix(DIRT, 'fold'), drive: 0.55, decay: 2, sustain: 0.9, release: 0.08 } },
  { name: 'yoi', group: 'dubstep', data: { wave: 2, fm: 0.2, ratio: ix(RATIOS, '2'), sub: 0.6, suboct: 1, ftype: ix(FILTERS, 'vowel'), cutoff: 400, reso: 0.7, fenv: 0.6, fdecay: 0.35, dtype: ix(DIRT, 'tape'), drive: 0.6, decay: 2, sustain: 0.9, release: 0.1 } },
  { name: 'talking', group: 'dubstep', data: { wave: 2.6, ftype: ix(FILTERS, 'vowel'), cutoff: 600, reso: 0.75, rate: ix(RATES, '1/4 t'), lshape: ix(LFO_SHAPES, 'triangle'), depth: 0.55, sub: 0.5, suboct: 1, dtype: ix(DIRT, 'bite'), drive: 0.45, decay: 2, sustain: 0.9, release: 0.1 } },
  // riddim
  { name: 'riddim', group: 'riddim', data: { wave: 3, fm: 0.25, ratio: ix(RATIOS, '½'), sub: 0.7, suboct: 1, ftype: ix(FILTERS, 'low'), cutoff: 1800, reso: 0.4, rate: ix(RATES, '1/16'), lshape: ix(LFO_SHAPES, 'square'), sync: 1, depth: 0.7, dtype: ix(DIRT, 'rectify'), drive: 0.6, crush: 0.35, decay: 2, sustain: 0.95, release: 0.05 } },
  { name: 'riddim saw chop', group: 'riddim', data: { wave: 2, unison: 2, detune: 0.1, sub: 0.7, suboct: 1, cutoff: 2400, reso: 0.3, rate: ix(RATES, '1/8 t'), lshape: ix(LFO_SHAPES, 'saw'), depth: 0.9, dtype: ix(DIRT, 'hard'), drive: 0.7, crush: 0.5, decay: 2, sustain: 0.95, release: 0.04 } },
  { name: 'random riddim', group: 'riddim', data: { wave: 3, fm: 0.4, ratio: ix(RATIOS, '3'), sub: 0.7, suboct: 1, ftype: ix(FILTERS, 'band'), cutoff: 1500, reso: 0.5, rate: ix(RATES, '1/16'), lshape: ix(LFO_SHAPES, 'random'), depth: 0.6, lfm: 0.5, dtype: ix(DIRT, 'fold'), drive: 0.5, crush: 0.25, decay: 2, sustain: 0.95, release: 0.05 } },
  // space & reese
  { name: 'space bass', group: 'space', data: { wave: 2, unison: 7, detune: 0.55, width: 1, sub: 0.6, cutoff: 900, reso: 0.25, fenv: 0.35, fdecay: 1.2, attack: 0.04, decay: 3, sustain: 0.8, release: 0.6, dtype: ix(DIRT, 'tape'), drive: 0.2 } },
  { name: 'reese', group: 'space', data: { wave: 2, unison: 2, detune: 0.35, width: 0.7, sub: 0.6, cutoff: 1400, reso: 0.2, dtype: ix(DIRT, 'tape'), drive: 0.3, decay: 3, sustain: 0.9, release: 0.2 } },
  { name: 'neuro reese', group: 'space', data: { wave: 2.5, unison: 4, detune: 0.4, width: 0.8, fm: 0.2, sub: 0.6, suboct: 1, ftype: ix(FILTERS, 'band'), cutoff: 1100, reso: 0.5, rate: ix(RATES, '1 bar'), lshape: ix(LFO_SHAPES, 'triangle'), depth: 0.5, dtype: ix(DIRT, 'fold'), drive: 0.45, decay: 3, sustain: 0.9, release: 0.2 } },
  // grime & trap
  { name: 'grime square', group: 'grime', data: { wave: 3, sub: 0.3, cutoff: 2200, reso: 0.2, fenv: 0.4, fdecay: 0.15, decay: 0.25, sustain: 0.2, release: 0.06, dtype: ix(DIRT, 'hard'), drive: 0.3 } },
  { name: 'eskibeat', group: 'grime', data: { wave: 1, fm: 0.5, ratio: ix(RATIOS, '2'), sub: 0.4, decay: 0.3, sustain: 0.1, release: 0.05, drop: 5, droptime: 0.02, dtype: ix(DIRT, 'bite'), drive: 0.4 } },
  { name: 'pure sub', group: 'grime', data: { wave: 0, decay: 2, sustain: 1, release: 0.1 } },
  { name: 'trap distorted', group: 'grime', data: { wave: 0.6, drop: 16, droptime: 0.04, decay: 2.5, sustain: 0.3, release: 0.2, glide: 0.06, dtype: ix(DIRT, 'fold'), drive: 0.45, sub: 0.6, cutoff: 4000 } },
]

export default {
  type: 'b4ss',
  label: 'B4SS',
  blurb: 'Every bass in one: 808s that drop and slide, wobbles in time with the song, growls, yois and riddim chops, reese and space basses, grime squares — with a clean sub under it all',
  kinds: ['synth', 'drum'],
  processor: 'lattice-b4ss',
  voices: 6,
  // auto: a hit (a drum step, or no sustain) plays through; a sustained note lasts as long as it's held
  oneShot: (d, midi) => { const t = Math.round(d?.trigger ?? 0); return t === 2 || (t === 0 && (midi == null || (d?.sustain ?? 0.6) < 0.05)) },
  params: PARAMS,
  presets: PRESETS,
  width: 1100,
  groups: [['osc', 'osc'], ['sub', 'sub'], ['pitch', 'pitch'], ['amp', 'amp'], ['dirt', 'dirt'], ['filter', 'filter'], ['wobble', 'wobble'], ['out', 'out']],
  voicesFor: (d) => (Math.round(d.mode ?? 0) === 0 ? 1 : 6),
  // the release falls 5 time-constants in its time; to near silence takes about twice that
  tail: (d, shot) => (shot ? (d.attack ?? 0) + (d.decay ?? 1.2) : 0) + (d.release ?? 0.15) * 2 + 0.05,
  dsp: DSP,
}
