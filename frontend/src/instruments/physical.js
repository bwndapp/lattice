import { knobsSource } from './dsp.js'

/**
 * Physical: a sound made the way a real one is. Something sets it going — a pluck, a
 * mallet, a bow, a burst of noise — and something rings: a string, or a body with modes of
 * its own (a bar, a drum skin, a plate, a bell). It isn't a waveform played back, so no two
 * notes are quite alike, and playing harder changes the tone, not only the level.
 *
 *   string    a waveguide (Karplus-Strong grown up): a delay line one period long, a loop
 *             filter that eats the highs as it rings (material), allpasses that make the
 *             upper partials run sharp the way a stiff piano string does (stiffness), and a
 *             comb on the exciter for where it's struck (position)
 *   modal     up to 32 resonators, one per mode of the body, tuned to its ratios; material
 *             sets how much faster the high modes die (wood) or not (metal), stiffness
 *             stretches the ratios apart, position weights the modes the way a strike there
 *             would
 *
 * Played from steps (no note) it sits at C3. Velocity brightens the hit.
 */
export const MODELS = ['string', 'harmonic', 'bar', 'membrane', 'plate', 'bell']
export const EXCITERS = ['pluck', 'mallet', 'bow', 'noise']

const PARAMS = [
  // what sets it going
  { key: 'exciter', group: 'exciter', label: 'exciter', min: 0, max: EXCITERS.length - 1, def: 0, choices: EXCITERS },
  { key: 'hardness', group: 'exciter', label: 'hardness', min: 0, max: 1, def: 0.55 },
  { key: 'length', group: 'exciter', label: 'length', min: 0.001, max: 2, def: 0.02, log: true, unit: 's' },
  { key: 'position', group: 'exciter', label: 'position', min: 0.02, max: 0.5, def: 0.18 },
  // what rings
  { key: 'model', group: 'body', label: 'model', min: 0, max: MODELS.length - 1, def: 0, choices: MODELS },
  { key: 'decay', group: 'body', label: 'decay', min: 0.05, max: 20, def: 2.5, log: true, unit: 's' },
  { key: 'material', group: 'body', label: 'material', min: 0, max: 1, def: 0.45 },
  { key: 'stiffness', group: 'body', label: 'stiffness', min: 0, max: 1, def: 0.1 },
  { key: 'random', group: 'body', label: 'random', min: 0, max: 1, def: 0.15 },
  // out
  { key: 'release', group: 'out', label: 'release', min: 0.01, max: 20, def: 3, log: true, unit: 's' },
  { key: 'level', group: 'out', label: 'level', min: -24, max: 6, def: 0, unit: 'db', origin: 0 },
]

// ── the bodies' modes, as ratios to the fundamental ─────────────────────────

const MAX_MODES = 32
const PHI = (1 + Math.sqrt(5)) / 2
const harmonic = Array.from({ length: MAX_MODES }, (_, k) => k + 1)
// a free bar (a marimba or glockenspiel key): β of each mode, squared
const bar = (() => {
  const b = [4.73004, 7.8532, 10.9956, 14.1372]
  while (b.length < MAX_MODES) b.push(((2 * b.length + 3) * Math.PI) / 2)
  return b.map((x) => (x / b[0]) ** 2)
})()
// a round drum skin: the zeros of the Bessel functions, over the first
const membrane = [2.4048, 3.8317, 5.1356, 5.5201, 6.3802, 7.0156, 7.5883, 8.4172, 8.6537, 8.7715, 9.761, 9.9361,
  10.1735, 11.0647, 11.0864, 11.6199, 11.7915, 12.2251, 13.0152, 13.3237, 13.3543, 13.5893, 14.3725, 14.4755,
  14.796, 14.9309, 15.5898, 15.7002, 16.0378, 16.2235, 16.4706, 16.6983].map((z) => z / 2.4048)
// a rectangular plate, sides in the golden ratio, held at its edges
const plate = (() => {
  const f = []
  for (let m = 1; m <= 10; m++) for (let n = 1; n <= 10; n++) f.push(m * m + (n / PHI) ** 2)
  f.sort((a, b) => a - b)
  return f.slice(0, MAX_MODES).map((x) => x / f[0])
})()
// a church bell: hum, prime, tierce, quint, nominal and the partials above
const bell = [0.5, 1, 1.183, 1.506, 2, 2.514, 2.662, 3.011, 4.166, 5.433, 6.796, 8.215, 9.71, 11.3, 13.02, 14.8]
export const MODES = { harmonic, bar, membrane, plate, bell }

// ── the processor ───────────────────────────────────────────────────────────

const DSP = `
const PH_MODES = ${JSON.stringify(MODES)}
const PH_MODEL_NAMES = ${JSON.stringify(MODELS)}
const PH_LINE = 4096 // the string's delay line: room for a period of 12 Hz at 48 kHz

/** A first-order allpass's delay, in samples, at w (radians a sample): (c + z⁻¹)/(1 + c z⁻¹). */
function phAllpassDelay(c, w) {
  const nr = c + Math.cos(w), ni = -Math.sin(w)
  const dr = 1 + c * Math.cos(w), di = -c * Math.sin(w)
  let ph = Math.atan2(ni, nr) - Math.atan2(di, dr)
  while (ph > 0) ph -= 2 * Math.PI
  return -ph / w
}

class PhysicalProcessor extends LatticeInstrument {
  static voiceCount = 8
  static knobs = ${knobsSource(PARAMS)}
  newVoice() {
    return {
      active: false, gateOpen: false, released: false, t: 0, f0: 130.81, vel: 1, seed: 1,
      model: -1, sig: '',
      // the string
      buf: new Float32Array(PH_LINE), w: 0, M: 100, ap: 0, apx: 0, apy: 0, lb: 0, ly: 0, g: 0.99,
      dc: new Float64Array(4), dx: new Float64Array(4), dy: new Float64Array(4),
      // the modes
      n: 0, cr: new Float64Array(${MAX_MODES}), ci: new Float64Array(${MAX_MODES}), amp: new Float64Array(${MAX_MODES}),
      re: new Float64Array(${MAX_MODES}), im: new Float64Array(${MAX_MODES}), ratio: new Float64Array(${MAX_MODES}),
      jitter: new Float64Array(${MAX_MODES}), r0: 0.999,
      // the exciter
      ex: new Float32Array(PH_LINE), exw: 0, noiseScale: 1, lpA: 0.5, lpY: 0, len: 1, bowEnv: 0, phase: 0,
      // tidy output
      dcx: 0, dcy: 0, level: 0,
    }
  }
  rand(v) { v.seed = (v.seed * 1664525 + 1013904223) >>> 0; return v.seed / 4294967296 }
  noteOn(v, note, vel) {
    const k = this.k
    v.f0 = 440 * 2 ** (((note >= 0 ? note : 48) - 69) / 12)
    v.vel = vel
    v.t = 0
    v.gateOpen = true
    v.released = false
    v.active = true
    v.seed = (Math.random() * 4294967296) >>> 0
    for (let i = 0; i < ${MAX_MODES}; i++) v.jitter[i] = (this.rand(v) * 2 - 1)
    v.sig = '' // set up afresh
    this.setup(v)
    // the exciter: how bright (harder and louder is brighter) and how long
    const ex = Math.round(k.exciter)
    const fc = Math.min(0.45 * sampleRate, 250 * 2 ** (k.hardness * 6 + vel * 1.5))
    v.lpA = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate)
    v.lpY = 0
    const period = sampleRate / v.f0
    if (ex === 0) v.len = v.model === 0 ? Math.max(2, Math.round(period)) : Math.round(0.002 * sampleRate)
    else if (ex === 1) v.len = Math.max(2, Math.round((0.0004 + (1 - k.hardness) ** 2 * 0.008) * sampleRate))
    else v.len = Math.max(2, Math.round(k.length * sampleRate))
    v.bowEnv = 0
    v.noiseScale = 1.2 / Math.sqrt(Math.min(v.len, 0.05 * sampleRate))
  }
  noteOff(v) {
    v.gateOpen = false
    v.released = true
    v.sig = ''
  }
  /** The ringing part's coefficients, from the knobs, the note and whether it's been let go. */
  setup(v) {
    const k = this.k
    const sig = k.model + '|' + k.decay + '|' + k.material + '|' + k.stiffness + '|' + k.random + '|' + k.position + '|' + k.release + '|' + v.released
    if (sig === v.sig) return
    v.sig = sig
    const model = Math.round(k.model)
    if (model !== v.model) {
      // a different body: start it quiet rather than ringing the old one's state through it
      v.model = model
      v.buf.fill(0); v.re.fill(0); v.im.fill(0)
      v.lpY = 0; v.ly = 0; v.apx = 0; v.apy = 0; v.dx.fill(0); v.dy.fill(0)
    }
    const T = v.released ? Math.min(k.decay, k.release) : k.decay
    const sr = sampleRate
    const detune = 1 + k.random * 0.004 * v.jitter[0]
    const f0 = v.f0 * detune
    if (model === 0) {
      // the string: loop delay = period less what the filters in the loop delay it by
      const w0 = (2 * Math.PI * f0) / sr
      v.lb = (1 - k.material) * 0.8 // the loop's lowpass: wood eats highs, metal keeps them
      const lpDelay = Math.atan2(v.lb * Math.sin(w0), 1 - v.lb * Math.cos(w0)) / w0
      const c = -0.7 * k.stiffness
      for (let i = 0; i < 4; i++) v.dc[i] = c
      const dispDelay = k.stiffness > 0 ? 4 * phAllpassDelay(c, w0) : 0
      const D = Math.max(2.5, Math.min(PH_LINE - 4, sr / f0 - lpDelay - dispDelay))
      v.M = Math.floor(D - 0.5)
      const d = D - v.M
      v.ap = (1 - d) / (1 + d) // a Thiran allpass for the fraction of a sample
      v.g = 10 ** (-3 / (f0 * T))
      v.r0 = v.g
    } else {
      const ratios = PH_MODES[PH_MODEL_NAMES[model]]
      const expo = 0.15 + 1.9 * (1 - k.material) // how much faster high modes die
      let n = 0
      let norm = 0
      for (let i = 0; i < ratios.length && n < ${MAX_MODES}; i++) {
        const ratio = ratios[i] ** (1 + 0.35 * k.stiffness) * (1 + k.random * 0.01 * v.jitter[i])
        const f = f0 * ratio
        if (f > 0.45 * sr) break
        const Tk = T * Math.max(0.02, ratio) ** -expo
        const r = Math.exp(-6.9078 / (Tk * sr))
        const w = (2 * Math.PI * f) / sr
        v.cr[n] = r * Math.cos(w)
        v.ci[n] = r * Math.sin(w)
        // where it's struck: a node of a mode doesn't move it
        const at = 0.12 + 0.88 * Math.abs(Math.sin((i + 1) * Math.PI * k.position))
        const a = at / Math.sqrt(i + 1)
        v.amp[n] = a
        norm += a * a
        if (ratio === 1 || (n === 0)) v.r0 = r
        n++
      }
      if (n < v.n) for (let i = n; i < v.n; i++) { v.re[i] = 0; v.im[i] = 0 }
      v.n = n
      const s = 1 / Math.sqrt(Math.max(1e-6, norm))
      for (let i = 0; i < n; i++) v.amp[i] *= s
    }
  }
  /** One sample of what sets it going. */
  excite(v) {
    const k = this.k
    const ex = Math.round(k.exciter)
    const t = v.t
    let x = 0
    if (ex === 0) {
      if (t < v.len) x = Math.random() * 2 - 1
    } else if (ex === 1) {
      if (t < v.len) {
        x = Math.sin((Math.PI * t) / v.len)
        if (v.model !== 0) x *= 1.6 / v.len // a mode rings with the area of the hit
        v.lpY = x // a mallet's shape is its own tone: no extra lowpass
        return x
      }
    } else if (ex === 2) {
      // a bow: rises over its length, holds while the note does, lets go quickly
      const target = v.gateOpen ? 1 : 0
      const rate = v.gateOpen ? 1 / v.len : 1 / (0.04 * sampleRate)
      v.bowEnv += (target - v.bowEnv) * Math.min(1, rate * 4)
      if (v.bowEnv > 1e-4) {
        v.phase += v.f0 / sampleRate
        if (v.phase >= 1) v.phase -= 1
        const lose = Math.sqrt(2 * Math.max(1e-5, 1 - v.r0)) // what keeps a loop from piling up
        const saw = v.model === 0 ? (2 * v.phase - 1) * (1 - v.r0) * 2 : 0
        x = v.bowEnv * ((Math.random() * 2 - 1) * lose * 0.9 + saw) * (v.model === 0 ? 0.5 : 1)
      }
    } else if (t < v.len) {
      const e = 1 - t / v.len
      x = (Math.random() * 2 - 1) * e * e
    }
    v.lpY += (x - v.lpY) * v.lpA
    // noise into the modes piles up with its length: as loud as a mallet's hit, however long
    if (v.model !== 0 && (ex === 0 || ex === 3)) return v.lpY * v.noiseScale
    return v.lpY
  }
  busy(v) { return v.active }
  render(v, L, R, from, to) {
    const k = this.k
    this.setup(v)
    const gain = 10 ** (k.level / 20)
    const bow = Math.round(k.exciter) === 2
    const string = v.model === 0
    const posLag = Math.max(1, Math.min(PH_LINE - 1, Math.round((sampleRate / v.f0) * k.position)))
    for (let i = from; i < to; i++) {
      let e = this.excite(v)
      let y = 0
      if (string) {
        // where it's struck: the wave sent the other way comes back off the near end
        v.ex[v.exw] = e
        e -= v.ex[(v.exw - posLag + PH_LINE) % PH_LINE]
        v.exw = (v.exw + 1) % PH_LINE
        const s = v.buf[(v.w - v.M + PH_LINE) % PH_LINE]
        // the fraction of a sample
        const a = v.ap * s + v.apx - v.ap * v.apy
        v.apx = s; v.apy = a
        // the loop's lowpass, then the stiffness
        v.ly = (1 - v.lb) * a + v.lb * v.ly
        let z = v.ly
        if (k.stiffness > 0) {
          for (let j = 0; j < 4; j++) {
            const c = v.dc[j]
            const o = c * z + v.dx[j] - c * v.dy[j]
            v.dx[j] = z; v.dy[j] = o; z = o
          }
        }
        y = z * v.g + e
        v.buf[v.w] = y
        v.w = (v.w + 1) % PH_LINE
        y *= 0.5
      } else {
        const n = v.n
        const re = v.re, im = v.im, cr = v.cr, ci = v.ci, amp = v.amp
        for (let j = 0; j < n; j++) {
          const r0 = re[j], i0 = im[j]
          re[j] = cr[j] * r0 - ci[j] * i0 + e
          im[j] = ci[j] * r0 + cr[j] * i0
          y += im[j] * amp[j]
        }
        y *= 0.7
      }
      // no DC, and nothing that runs away gets past a soft limit
      const d = y - v.dcx + 0.9995 * v.dcy
      v.dcx = y; v.dcy = d
      const out = Math.tanh(d * gain)
      L[i] += out
      if (R !== L) R[i] += out
      v.t++
      v.level = Math.max(Math.abs(out), v.level * 0.9995)
    }
    // done once the hit is over and what rings has died away
    if (v.t > v.len && !(bow && (v.gateOpen || v.bowEnv > 1e-4)) && v.level < 1e-5) v.active = false
  }
}
registerProcessor('lattice-physical', PhysicalProcessor)
`

export default {
  type: 'physical',
  label: 'physical',
  blurb: 'A physical model: pluck, strike, bow or blow on a string, a bar, a drum skin, a plate or a bell, and it rings the way the real thing would',
  kinds: ['synth', 'drum'],
  processor: 'lattice-physical',
  voices: 8,
  oneShot: false, // let go and it rings on for its release
  params: PARAMS,
  groups: [['exciter', 'exciter'], ['body', 'body'], ['out', 'out']],
  /** How long it rings once the note ends. */
  tail: (d) => Math.min(d.decay, d.release) * 1.1 + 0.05,
  dsp: DSP,
}
