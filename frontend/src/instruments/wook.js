import { knobsSource } from './dsp.js'

/**
 * W00K: the sine-wave womp and the flutter bass, built for exactly those two.
 *
 *   core     a sine that turns hollow and vocal as its tone goes up (it phase-modulates
 *            itself, so it stays one smooth voice rather than buzzing), a drive after it, a
 *            clean sub under it and a lowpass over the top to keep it round
 *   womp     each note's shape: its pitch bends in from above or below and settles, and its
 *            tone opens and falls back — the "wom-p" of a womp
 *   flutter  a fast wobble on the volume and the pitch, in time with the song (1/16 down to
 *            1/64, triplets too) or free in Hz; it can fade in over the note, and the right
 *            side can flutter a step behind the left for a wide shimmer
 *   wobble   a slower one on the tone, in time: womp womp
 *   pitch    octave and fine, mono or poly, and a glide: in mono a note that comes in while
 *            the last is still held slides to it
 *   amp      a trigger (auto plays a hit's whole decay, as B4SS does), attack, decay,
 *            sustain and release
 */
const RATES_FLUTTER = ['off', '1/16', '1/16 t', '1/32', '1/32 t', '1/64', 'free']
const FLUTTER_PER_BAR = [0, 16, 24, 32, 48, 64, -1] // -1: free, in Hz
const RATES_WOBBLE = ['off', '1 bar', '1/2', '1/4', '1/8', '1/16', '1/4 t', '1/8 t', '1/16 t']
const WOBBLE_PER_BAR = [0, 1, 2, 4, 8, 16, 6, 12, 24]
const SHAPES = ['sine', 'triangle', 'square', 'saw']
const SYNC = ['song', 'note']
const MODES = ['mono', 'poly']
const TRIGGERS = ['auto', 'note length', 'one shot']

const PARAMS = [
  // core
  { key: 'tone', group: 'core', label: 'tone', min: 0, max: 1, def: 0.15 },
  { key: 'drive', group: 'core', label: 'drive', min: 0, max: 1, def: 0.2 },
  { key: 'sub', group: 'core', label: 'sub', min: 0, max: 1, def: 0.4 },
  { key: 'cutoff', group: 'core', label: 'lowpass', min: 60, max: 18000, def: 6000, log: true, unit: 'hz' },
  // womp
  { key: 'bend', group: 'womp', label: 'bend', min: -24, max: 24, def: 0, unit: 'st', origin: 0 },
  { key: 'bendtime', group: 'womp', label: 'bend time', min: 0.005, max: 1, def: 0.08, log: true, unit: 's' },
  { key: 'open', group: 'womp', label: 'open', min: 0, max: 1, def: 0.4 },
  { key: 'opentime', group: 'womp', label: 'open time', min: 0.01, max: 2, def: 0.25, log: true, unit: 's' },
  // flutter
  { key: 'frate', group: 'flutter', label: 'rate', min: 0, max: RATES_FLUTTER.length - 1, def: 0, choices: RATES_FLUTTER },
  { key: 'fhz', group: 'flutter', label: 'free hz', min: 1, max: 40, def: 12, log: true, unit: 'hz' },
  { key: 'fshape', group: 'flutter', label: 'shape', min: 0, max: SHAPES.length - 1, def: 0, choices: SHAPES },
  { key: 'fvol', group: 'flutter', label: 'volume', min: 0, max: 1, def: 0.8 },
  { key: 'fpitch', group: 'flutter', label: 'pitch', min: 0, max: 100, def: 0, unit: 'ct' },
  { key: 'framp', group: 'flutter', label: 'fade in', min: 0, max: 2, def: 0, unit: 's' },
  { key: 'fspread', group: 'flutter', label: 'spread', min: 0, max: 1, def: 0 },
  // wobble
  { key: 'wrate', group: 'wobble', label: 'rate', min: 0, max: RATES_WOBBLE.length - 1, def: 0, choices: RATES_WOBBLE },
  { key: 'wshape', group: 'wobble', label: 'shape', min: 0, max: SHAPES.length - 1, def: 0, choices: SHAPES },
  { key: 'wsync', group: 'wobble', label: 'from', min: 0, max: 1, def: 0, choices: SYNC },
  { key: 'wdepth', group: 'wobble', label: 'depth', min: 0, max: 1, def: 0.7 },
  // pitch
  { key: 'octave', group: 'pitch', label: 'octave', min: -3, max: 2, def: -1, unit: 'oct', origin: 0, step: 1 },
  { key: 'fine', group: 'pitch', label: 'fine', min: -100, max: 100, def: 0, unit: 'ct', origin: 0 },
  { key: 'mode', group: 'pitch', label: 'voices', min: 0, max: 1, def: 0, choices: MODES },
  { key: 'glide', group: 'pitch', label: 'glide', min: 0, max: 1, def: 0, unit: 's' },
  // amp
  { key: 'trigger', group: 'amp', label: 'trigger', min: 0, max: TRIGGERS.length - 1, def: 0, choices: TRIGGERS },
  { key: 'attack', group: 'amp', label: 'attack', min: 0, max: 1, def: 0.003, unit: 's' },
  { key: 'decay', group: 'amp', label: 'decay', min: 0.01, max: 8, def: 1.5, log: true, unit: 's' },
  { key: 'sustain', group: 'amp', label: 'sustain', min: 0, max: 1, def: 0.85 },
  { key: 'release', group: 'amp', label: 'release', min: 0.005, max: 4, def: 0.12, log: true, unit: 's' },
  // out
  { key: 'level', group: 'out', label: 'level', min: -24, max: 6, def: 0, unit: 'db', origin: 0 },
]

const DSP = `
const WK_FLUTTER = ${JSON.stringify(FLUTTER_PER_BAR)}
const WK_WOBBLE = ${JSON.stringify(WOBBLE_PER_BAR)}
const WK_TAU = Math.PI * 2

/** One LFO shape at phase ph (any number): 1 at the top, 0 at the bottom. */
function wkShape(shape, ph) {
  const p = ph - Math.floor(ph)
  if (shape === 0) return 0.5 + 0.5 * Math.cos(WK_TAU * p) // starts at the top: a note opens on a full beat
  if (shape === 1) return 1 - 2 * Math.abs(p - 0.5) * 1 // triangle, from the bottom
  if (shape === 2) return p < 0.5 ? 1 : 0
  return 1 - p // saw down
}

class WookProcessor extends LatticeInstrument {
  static voiceCount = 6
  static knobs = ${knobsSource(PARAMS)}
  newVoice() {
    return { active: false, gateOpen: false, shot: false, t: 0, env: 0, stage: 0, pitch: 36, target: 36, ph: 0, sub: 0, lp1: 0, lp2: 0, lr1: 0, lr2: 0, dcx: 0, dcy: 0, dcx2: 0, dcy2: 0 }
  }
  noteOn(v, note, vel) {
    const k = this.k
    const n = note >= 0 ? note : 36
    const mono = Math.round(k.mode) === 0
    const sliding = mono && v.active && v.gateOpen && k.glide > 0.0005
    v.target = n
    const trig = Math.round(k.trigger)
    v.shot = trig === 2 || (trig === 0 && (note < 0 || k.sustain < 0.05))
    if (!sliding) {
      v.pitch = n
      v.t = 0
      v.stage = 0
      if (!v.active) { v.env = 0; v.ph = 0; v.sub = 0 }
    }
    v.gateOpen = true
    v.active = true
  }
  noteOff(v) { v.gateOpen = false }
  busy(v) { return v.active }
  render(v, L, R, from, to) {
    const k = this.k
    const sr = sampleRate
    const dt = 1 / sr
    const cps = (this.song && this.song.cps) || 0.5625
    const cycle = this.songCycle()
    const fPer = WK_FLUTTER[Math.round(k.frate)] || 0
    const fHz = fPer < 0 ? k.fhz : fPer * cps
    const fShape = Math.round(k.fshape)
    const wPer = WK_WOBBLE[Math.round(k.wrate)] || 0
    const wShape = Math.round(k.wshape)
    const wFromNote = Math.round(k.wsync) === 1
    const gain = 10 ** (k.level / 20) * 0.55
    const g = 1 + k.drive * k.drive * 20
    const norm = 1 / Math.tanh(Math.min(g, 3))
    const glideA = k.glide > 0.0005 ? 1 - Math.exp(-1 / (k.glide * 0.35 * sr)) : 1
    const bendA = 5 / k.bendtime
    const openA = 5 / k.opentime
    const attackStep = k.attack > 0.0005 ? dt / k.attack : 1
    const decayA = Math.exp(-5 / (k.decay * sr))
    const releaseA = Math.exp(-5 / (k.release * sr))
    // the lowpass: two one-poles, a gentle 12 dB that keeps the top round
    const lpA = 1 - Math.exp((-WK_TAU * k.cutoff) / sr)
    for (let i = from; i < to; i++) {
      // ── amp ──
      const held = v.shot ? v.t < k.attack + k.decay : v.gateOpen
      if (held) {
        if (v.stage === 0) { v.env += attackStep; if (v.env >= 1) { v.env = 1; v.stage = 1 } }
        else v.env = k.sustain + (v.env - k.sustain) * decayA
      } else {
        v.env *= releaseA
        if (v.env < 1e-4 && v.t > 0.002) { v.active = false; v.env = 0; break }
      }
      // ── pitch: glide, the womp's bend ──
      v.pitch += (v.target - v.pitch) * glideA
      const bend = k.bend ? k.bend * Math.exp(-v.t * bendA) : 0
      // ── flutter: fast, on the volume and the pitch; the right side a step behind when spread ──
      let fl = 1, fr = 1, fpitch = 0
      if (fHz > 0) {
        const fadeIn = k.framp > 0.001 ? Math.min(1, v.t / k.framp) : 1
        const base = fPer > 0 && cycle !== null ? (cycle + (i - from) * dt * cps) * fPer : v.t * fHz
        const sl = wkShape(fShape, base)
        const srr = wkShape(fShape, base + k.fspread * 0.5)
        const depth = k.fvol * fadeIn
        fl = 1 - depth * (1 - sl)
        fr = 1 - depth * (1 - srr)
        fpitch = (k.fpitch / 100) * fadeIn * (sl * 2 - 1)
      }
      const midi = v.pitch + k.octave * 12 + k.fine / 100 + bend + fpitch
      const f = 440 * 2 ** ((midi - 69) / 12)
      // ── wobble, slower, on the tone ──
      let wob = 1
      if (wPer) {
        const ph = wFromNote || cycle === null ? v.t * cps * wPer : (cycle + (i - from) * dt * cps) * wPer
        wob = 1 - k.wdepth * (1 - wkShape(wShape, ph))
      }
      // ── core: a sine that modulates itself as the tone opens ──
      const open = k.open * Math.exp(-v.t * openA)
      const index = Math.min(3.5, (k.tone * wob + open) * 3.2)
      v.ph += f * dt
      if (v.ph >= 1) v.ph -= 1
      let s = Math.sin(WK_TAU * v.ph + index * Math.sin(WK_TAU * v.ph))
      if (k.drive > 0.001) s = Math.tanh(s * g) * norm
      // the lowpass, per side (the flutter makes the sides differ)
      let l = s * fl
      let r = s * fr
      v.lp1 += (l - v.lp1) * lpA; v.lp2 += (v.lp1 - v.lp2) * lpA
      v.lr1 += (r - v.lr1) * lpA; v.lr2 += (v.lr1 - v.lr2) * lpA
      l = v.lp2; r = v.lr2
      // ── sub: clean, at the note, fluttering with the rest so the chop is whole ──
      v.sub += f * dt
      if (v.sub >= 1) v.sub -= 1
      const sub = k.sub * Math.sin(WK_TAU * v.sub)
      l = (l + sub * fl) * v.env
      r = (r + sub * fr) * v.env
      const dl = l - v.dcx + 0.9995 * v.dcy; v.dcx = l; v.dcy = dl
      const dr = r - v.dcx2 + 0.9995 * v.dcy2; v.dcx2 = r; v.dcy2 = dr
      L[i] += Math.tanh(dl * gain * 1.5) / 1.15
      if (R !== L) R[i] += Math.tanh(dr * gain * 1.5) / 1.15
      v.t += dt
    }
  }
}
registerProcessor('lattice-wook', WookProcessor)
`

const ix = (list, name) => list.indexOf(name)
const PRESETS = [
  // womps
  { name: 'sine womp', group: 'womp', data: { tone: 0.05, open: 0.55, opentime: 0.3, bend: 5, bendtime: 0.07, sub: 0.3, drive: 0.15 } },
  { name: 'deep womp', group: 'womp', data: { tone: 0.02, open: 0.4, opentime: 0.45, bend: -7, bendtime: 0.12, sub: 0.6, cutoff: 1800, octave: -1 } },
  { name: 'yawn', group: 'womp', data: { tone: 0.1, open: 0.8, opentime: 0.8, bend: 3, bendtime: 0.3, sub: 0.4, drive: 0.25, wrate: ix(RATES_WOBBLE, '1/4'), wdepth: 0.5 } },
  { name: 'womp womp', group: 'womp', data: { tone: 0.35, open: 0.2, sub: 0.5, drive: 0.3, wrate: ix(RATES_WOBBLE, '1/8'), wshape: ix(SHAPES, 'sine'), wdepth: 0.9 } },
  { name: 'triplet womp', group: 'womp', data: { tone: 0.3, open: 0.3, sub: 0.5, drive: 0.35, wrate: ix(RATES_WOBBLE, '1/8 t'), wshape: ix(SHAPES, 'saw'), wdepth: 0.85, wsync: 1 } },
  // flutters
  { name: 'flutter', group: 'flutter', data: { tone: 0.1, open: 0.2, sub: 0.4, frate: ix(RATES_FLUTTER, '1/32'), fvol: 0.85, fshape: ix(SHAPES, 'sine') } },
  { name: 'triplet flutter', group: 'flutter', data: { tone: 0.15, open: 0.25, sub: 0.4, frate: ix(RATES_FLUTTER, '1/32 t'), fvol: 0.9, fshape: ix(SHAPES, 'triangle'), fpitch: 15 } },
  { name: 'wide flutter', group: 'flutter', data: { tone: 0.12, sub: 0.35, frate: ix(RATES_FLUTTER, '1/32'), fvol: 0.8, fspread: 1, fpitch: 10 } },
  { name: 'flutter swell', group: 'flutter', data: { tone: 0.2, open: 0.1, sub: 0.4, frate: ix(RATES_FLUTTER, '1/16 t'), fvol: 0.9, framp: 0.6, fpitch: 25, decay: 3, sustain: 0.9 } },
  { name: 'hummingbird', group: 'flutter', data: { tone: 0.25, drive: 0.4, sub: 0.3, frate: ix(RATES_FLUTTER, 'free'), fhz: 28, fvol: 0.7, fpitch: 40, fspread: 0.6 } },
  { name: 'stutter sub', group: 'flutter', data: { tone: 0, open: 0, sub: 0.7, frate: ix(RATES_FLUTTER, '1/16'), fvol: 1, fshape: ix(SHAPES, 'square'), cutoff: 900 } },
  // wook
  { name: 'wook wobble', group: 'wook', data: { tone: 0.4, open: 0.4, bend: 4, bendtime: 0.05, sub: 0.5, drive: 0.5, wrate: ix(RATES_WOBBLE, '1/4 t'), wshape: ix(SHAPES, 'triangle'), wdepth: 0.8, frate: ix(RATES_FLUTTER, '1/32'), fvol: 0.35 } },
  { name: 'liquid flutter', group: 'wook', data: { tone: 0.2, open: 0.35, opentime: 0.5, sub: 0.45, glide: 0.08, frate: ix(RATES_FLUTTER, '1/32 t'), fvol: 0.6, fpitch: 20, framp: 0.25, fspread: 0.5 } },
]

export default {
  type: 'wook',
  label: 'W00K',
  blurb: 'The sine-wave womp and the flutter bass: a sine that opens up and bends on every note, fluttered in time with the song, wobbled, with a clean sub under it',
  kinds: ['synth', 'drum'],
  processor: 'lattice-wook',
  voices: 6,
  // auto: a hit (a drum step, or no sustain) plays through; a sustained note lasts as long as it's held
  oneShot: (d, midi) => { const t = Math.round(d?.trigger ?? 0); return t === 2 || (t === 0 && (midi == null || (d?.sustain ?? 0.85) < 0.05)) },
  params: PARAMS,
  presets: PRESETS,
  width: 1100,
  groups: [['core', 'core'], ['womp', 'womp'], ['flutter', 'flutter'], ['wobble', 'wobble'], ['pitch', 'pitch'], ['amp', 'amp'], ['out', 'out']],
  voicesFor: (d) => (Math.round(d.mode ?? 0) === 0 ? 1 : 6),
  tail: (d, shot) => (shot ? (d.attack ?? 0) + (d.decay ?? 1.5) : 0) + (d.release ?? 0.12) * 2 + 0.05,
  dsp: DSP,
}
