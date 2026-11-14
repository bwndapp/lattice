import { knobsSource } from './dsp.js'

/**
 * Physical: a sound made the way a real one is. Something sets it going — a pluck, a
 * mallet, a bow, breath, a scrape, a strum, a ball bouncing — and something rings: a string,
 * a tube, or a body with modes of its own (a bar, a drum skin, a plate, a bell, a glass, a
 * singing bowl, a gong, a spring). It isn't a waveform played back, so no two notes are quite
 * alike, and playing harder changes the tone, not only the level.
 *
 * What rings can ring something else: a second body, coupled after the first, the way a
 * guitar string rings its wooden box or a marimba bar the tube under it. It has its own model,
 * tuning and decay, and a mix between the two.
 *
 *   waveguides  string, tube, spring: a delay line one period long (a tube's reflection is
 *               inverted, so it's hollow: odd harmonics only), a loop filter that eats the
 *               highs as it rings (material), allpasses that make the upper partials run sharp
 *               (stiffness; a spring has a lot of them, which is its chirp), and a comb on the
 *               exciter for where it's struck (position)
 *   modal       up to 32 resonators, one per mode of the body, tuned to its ratios; material
 *               sets how much faster the high modes die (wood) or not (metal), stiffness
 *               stretches the ratios apart, position weights the modes the way a strike there
 *               would
 *
 * Played from steps (no note) it sits at C3. Velocity brightens the hit. The lists only ever
 * grow at the end: a saved sound holds an index into them.
 */
export const MODELS = ['string', 'harmonic', 'bar', 'membrane', 'plate', 'bell', 'tube', 'glass', 'bowl', 'gong', 'spring']
export const EXCITERS = ['pluck', 'mallet', 'bow', 'noise', 'breath', 'scrape', 'strum', 'bounce']
export const BODIES = ['none', ...MODELS]

const PARAMS = [
  // what sets it going
  { key: 'exciter', group: 'exciter', label: 'exciter', min: 0, max: EXCITERS.length - 1, def: 0, choices: EXCITERS },
  { key: 'hardness', group: 'exciter', label: 'hardness', min: 0, max: 1, def: 0.55 },
  { key: 'length', group: 'exciter', label: 'length', min: 0.001, max: 2, def: 0.02, log: true, unit: 's' },
  { key: 'position', group: 'exciter', label: 'position', min: 0.02, max: 0.5, def: 0.18 },
  // what rings
  { key: 'model', group: 'resonator', label: 'model', min: 0, max: MODELS.length - 1, def: 0, choices: MODELS },
  { key: 'decay', group: 'resonator', label: 'decay', min: 0.05, max: 20, def: 2.5, log: true, unit: 's' },
  { key: 'material', group: 'resonator', label: 'material', min: 0, max: 1, def: 0.45 },
  { key: 'stiffness', group: 'resonator', label: 'stiffness', min: 0, max: 1, def: 0.1 },
  { key: 'random', group: 'resonator', label: 'random', min: 0, max: 1, def: 0.15 },
  // what that rings in turn
  { key: 'body', group: 'body', label: 'body', min: 0, max: BODIES.length - 1, def: 0, choices: BODIES },
  { key: 'bodytune', group: 'body', label: 'tune', min: -24, max: 24, def: 0, unit: 'st', origin: 0 },
  { key: 'bodydecay', group: 'body', label: 'decay', min: 0.02, max: 8, def: 0.4, log: true, unit: 's' },
  { key: 'bodymix', group: 'body', label: 'mix', min: 0, max: 1, def: 0.5 },
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
// a wine glass: its rim bends into 2, 3, 4… lobes, each a little further up than the last
const glass = (() => {
  const g = Array.from({ length: 12 }, (_, k) => ((k + 2) / 2) ** 2 * (1 + 0.015 * k) ** 1.5)
  return g.map((x) => x / g[0])
})()
// a singing bowl: every mode in a pair a hair apart, so it beats as it rings
const bowl = [1, 2.71, 5.15, 8.3, 12.1, 16.5, 21.4].flatMap((r, k) => [r, r * (1.0025 + 0.0012 * k)])
// a gong: modes packed closer and closer as they climb, never in a row
const gong = Array.from({ length: MAX_MODES }, (_, k) => 1 + 11 * (k / (MAX_MODES - 1)) ** 1.35 + (k ? 0.08 * Math.sin(k * 12.9898) : 0))
export const MODES = { harmonic, bar, membrane, plate, bell, glass, bowl, gong }

// ── the processor ───────────────────────────────────────────────────────────

const DSP = `
const PH_MODES = ${JSON.stringify(MODES)}
const PH_MODEL_NAMES = ${JSON.stringify(MODELS)}
const PH_LINE = 4096 // a waveguide's delay line: room for a period of 12 Hz at 48 kHz
const PH_MAX_MODES = ${MAX_MODES}
const PH_STAGES = 8

/** A first-order allpass's delay, in samples, at w (radians a sample): (c + z⁻¹)/(1 + c z⁻¹). */
function phAllpassDelay(c, w) {
  const nr = c + Math.cos(w), ni = -Math.sin(w)
  const dr = 1 + c * Math.cos(w), di = -c * Math.sin(w)
  let ph = Math.atan2(ni, nr) - Math.atan2(di, dr)
  while (ph > 0) ph -= 2 * Math.PI
  return -ph / w
}

/**
 * One thing that rings: a waveguide (string, tube, spring) or a set of modes (the rest).
 * setup() whenever the note or the knobs move; tick() a sample at a time.
 */
class PhResonator {
  constructor() {
    this.model = -1
    this.wave = true
    this.buf = new Float32Array(PH_LINE); this.w = 0; this.M = 100
    this.ap = 0; this.apx = 0; this.apy = 0; this.lb = 0; this.ly = 0; this.g = 0.99; this.sign = 1
    this.stages = 0; this.dc = 0; this.dx = new Float64Array(PH_STAGES); this.dy = new Float64Array(PH_STAGES)
    this.n = 0
    this.cr = new Float64Array(PH_MAX_MODES); this.ci = new Float64Array(PH_MAX_MODES); this.amp = new Float64Array(PH_MAX_MODES)
    this.re = new Float64Array(PH_MAX_MODES); this.im = new Float64Array(PH_MAX_MODES)
    this.r0 = 0.999
    this.period = 100
  }
  clear() {
    this.buf.fill(0); this.re.fill(0); this.im.fill(0)
    this.ly = 0; this.apx = 0; this.apy = 0; this.dx.fill(0); this.dy.fill(0)
  }
  /** jitter: per-note randoms, -1 … 1, one per mode. */
  setup(model, f0, T, material, stiffness, random, jitter, position) {
    if (model !== this.model) { this.model = model; this.clear() } // a new body starts quiet
    const name = PH_MODEL_NAMES[model]
    const sr = sampleRate
    f0 *= 1 + random * 0.004 * jitter[0]
    this.period = sr / f0
    // per sample, at the fundamental: what the exciters scale a steady push by
    this.r0 = Math.exp(-6.9078 / (T * sr))
    this.wave = name === 'string' || name === 'tube' || name === 'spring'
    if (this.wave) {
      const w0 = (2 * Math.PI * f0) / sr
      const tube = name === 'tube'
      this.sign = tube ? -1 : 1
      // a tube's inverted reflection takes two trips round to come back the same way up
      const trip = tube ? sr / (2 * f0) : sr / f0
      this.lb = (1 - material) * 0.8 // the loop's lowpass: wood eats highs, metal keeps them
      const lpDelay = Math.atan2(this.lb * Math.sin(w0), 1 - this.lb * Math.cos(w0)) / w0
      const spring = name === 'spring'
      this.stages = spring ? PH_STAGES : stiffness > 0 ? 4 : 0
      this.dc = spring ? -(0.6 + 0.35 * stiffness) : -0.7 * stiffness
      const dispDelay = this.stages ? this.stages * phAllpassDelay(this.dc, w0) : 0
      const D = Math.max(2.5, Math.min(PH_LINE - 4, trip - lpDelay - dispDelay))
      this.M = Math.floor(D - 0.5)
      const d = D - this.M
      this.ap = (1 - d) / (1 + d) // a Thiran allpass for the fraction of a sample
      this.g = 10 ** (-3 / ((tube ? 2 : 1) * f0 * T))
      this.r0 = this.g // a waveguide loses once a trip round, not once a sample
      return
    }
    const ratios = PH_MODES[name]
    const expo = 0.15 + 1.9 * (1 - material) // how much faster high modes die
    let n = 0
    let norm = 0
    for (let i = 0; i < ratios.length && n < PH_MAX_MODES; i++) {
      const ratio = ratios[i] ** (1 + 0.35 * stiffness) * (1 + random * 0.01 * jitter[i])
      const f = f0 * ratio
      if (f > 0.45 * sr) break
      const Tk = T * Math.max(0.02, ratio) ** -expo
      const r = Math.exp(-6.9078 / (Tk * sr))
      const w = (2 * Math.PI * f) / sr
      this.cr[n] = r * Math.cos(w)
      this.ci[n] = r * Math.sin(w)
      // where it's struck: a node of a mode doesn't move it
      const at = 0.12 + 0.88 * Math.abs(Math.sin((i + 1) * Math.PI * position))
      const a = at / Math.sqrt(i + 1)
      this.amp[n] = a
      norm += a * a
      n++
    }
    for (let i = n; i < this.n; i++) { this.re[i] = 0; this.im[i] = 0 }
    this.n = n
    const s = 1 / Math.sqrt(Math.max(1e-6, norm))
    for (let i = 0; i < n; i++) this.amp[i] *= s
  }
  tick(e) {
    if (this.wave) {
      const s = this.buf[(this.w - this.M + PH_LINE) % PH_LINE]
      const a = this.ap * s + this.apx - this.ap * this.apy // the fraction of a sample
      this.apx = s; this.apy = a
      this.ly = (1 - this.lb) * a + this.lb * this.ly // the loop's lowpass
      let z = this.ly
      for (let j = 0; j < this.stages; j++) { // stiffness
        const c = this.dc
        const o = c * z + this.dx[j] - c * this.dy[j]
        this.dx[j] = z; this.dy[j] = o; z = o
      }
      const y = this.sign * z * this.g + e
      this.buf[this.w] = y
      this.w = (this.w + 1) % PH_LINE
      return y * 0.5
    }
    let y = 0
    const n = this.n, re = this.re, im = this.im, cr = this.cr, ci = this.ci, amp = this.amp
    for (let j = 0; j < n; j++) {
      const r0 = re[j], i0 = im[j]
      re[j] = cr[j] * r0 - ci[j] * i0 + e
      im[j] = ci[j] * r0 + cr[j] * i0
      y += im[j] * amp[j]
    }
    return y * 0.7
  }
}

const PH_SUSTAINED = [2, 4, 5] // bow, breath, scrape: they go on while the note's held

class PhysicalProcessor extends LatticeInstrument {
  static voiceCount = 8
  static knobs = ${knobsSource(PARAMS)}
  newVoice() {
    return {
      active: false, gateOpen: false, released: false, t: 0, f0: 130.81, vel: 1, seed: 1, sig: '',
      a: new PhResonator(), b: new PhResonator(), bodyOn: false, bodyIn: 0, envIn: 0, envB: 0, peakIn: 0, bodyG: 1, bodyGT: 1,
      jitter: new Float64Array(PH_MAX_MODES), jitterB: new Float64Array(PH_MAX_MODES),
      // the exciter
      ex: new Float32Array(PH_LINE), exw: 0, lpA: 0.5, lpY: 0, len: 1, env: 0, phase: 0,
      pT: -1, pLen: 1, pAmp: 0, pNoise: false, pScale: 1, nextAt: 0, hits: 0, maxHits: 0, gap: 0,
      dcx: 0, dcy: 0, level: 0,
    }
  }
  rand(v) { v.seed = (v.seed * 1664525 + 1013904223) >>> 0; return v.seed / 4294967296 }
  // a short hit: a burst of noise a period long (a pluck) or a mallet's half-sine
  pulse(v, noisy, amp) {
    const k = this.k
    const sr = sampleRate
    v.pNoise = noisy
    v.pLen = noisy
      ? (v.a.wave ? Math.max(2, Math.round(v.a.period)) : Math.round(0.002 * sr))
      : Math.max(2, Math.round((0.0004 + (1 - k.hardness) ** 2 * 0.008) * sr))
    // into modes, a hit rings with its area: as loud whatever its length
    v.pScale = v.a.wave ? 1 : noisy ? 1.2 / Math.sqrt(v.pLen) : 1.6 / v.pLen
    v.pAmp = amp
    v.pT = 0
  }
  noteOn(v, note, vel) {
    const k = this.k
    v.f0 = 440 * 2 ** (((note >= 0 ? note : 48) - 69) / 12)
    v.vel = vel
    v.t = 0
    v.gateOpen = true
    v.released = false
    v.active = true
    v.seed = (Math.random() * 4294967296) >>> 0
    for (let i = 0; i < PH_MAX_MODES; i++) { v.jitter[i] = this.rand(v) * 2 - 1; v.jitterB[i] = this.rand(v) * 2 - 1 }
    v.sig = ''
    v.peakIn = 0
    this.setup(v)
    const ex = Math.round(k.exciter)
    const fc = Math.min(0.45 * sampleRate, 250 * 2 ** (k.hardness * 6 + vel * 1.5)) // harder and louder is brighter
    v.lpA = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate)
    v.lpY = 0
    v.env = 0
    v.pT = -1
    v.hits = 0
    v.maxHits = 0
    v.len = Math.max(2, Math.round(k.length * sampleRate))
    if (ex === 0) this.pulse(v, true, 1)
    else if (ex === 1) this.pulse(v, false, 1)
    else if (ex === 6) { v.maxHits = 5; v.gap = Math.max(0.008, k.length / 4); v.nextAt = 0 } // a strum: five plucks
    else if (ex === 7) { v.maxHits = 40; v.gap = 0.05 + k.length * 0.5; v.nextAt = 0 } // a ball let go above it
  }
  noteOff(v) {
    v.gateOpen = false
    v.released = true
    v.sig = ''
  }
  setup(v) {
    const k = this.k
    const sig = k.model + '|' + k.decay + '|' + k.material + '|' + k.stiffness + '|' + k.random + '|' + k.position + '|' + k.release + '|' +
      k.body + '|' + k.bodytune + '|' + k.bodydecay + '|' + v.released
    if (sig === v.sig) return
    v.sig = sig
    const T = v.released ? Math.min(k.decay, k.release) : k.decay
    v.a.setup(Math.round(k.model), v.f0, T, k.material, k.stiffness, k.random, v.jitter, k.position)
    const body = Math.round(k.body)
    v.bodyOn = body > 0
    if (v.bodyOn) {
      const TB = v.released ? Math.min(k.bodydecay, k.release) : k.bodydecay
      v.b.setup(body - 1, v.f0 * 2 ** (k.bodytune / 12), TB, k.material, k.stiffness, k.random, v.jitterB, 0.31)
      // what comes in keeps on coming, mostly at the first's pitch: scale it to what the body
      // loses, or a body tuned to it piles up
      v.bodyIn = 3 * (1 - v.b.r0)
    }
  }
  /** One sample of what sets it going. */
  excite(v, ex) {
    const k = this.k
    const sr = sampleRate
    let noisy = 0 // through the exciter's lowpass
    let direct = 0 // its own shape is its tone
    // a strum's plucks, a ball's bounces
    if (v.hits < v.maxHits && v.t >= v.nextAt) {
      if (ex === 6) this.pulse(v, true, 0.8 ** v.hits)
      else {
        this.pulse(v, false, 0.75 ** v.hits)
        v.gap *= 0.72
        if (v.gap < 0.004) v.maxHits = v.hits + 1
      }
      v.hits++
      v.nextAt = v.t + Math.round(v.gap * sr)
    }
    if (v.pT >= 0) {
      if (v.pNoise) noisy += (Math.random() * 2 - 1) * v.pAmp * v.pScale
      else direct += Math.sin((Math.PI * v.pT) / v.pLen) * v.pAmp * v.pScale
      if (++v.pT >= v.pLen) v.pT = -1
    }
    if (ex === 3 && v.t < v.len) {
      const e = 1 - v.t / v.len
      noisy += (Math.random() * 2 - 1) * e * e * (v.a.wave ? 1 : 1.2 / Math.sqrt(Math.min(v.len, 0.05 * sr)))
    }
    if (PH_SUSTAINED.includes(ex)) {
      // rises over its length, holds while the note does, lets go quickly
      const target = v.gateOpen ? 1 : 0
      const rate = v.gateOpen ? 1 / v.len : 1 / (0.04 * sr)
      v.env += (target - v.env) * Math.min(1, rate * 4)
      if (v.env > 1e-4) {
        const lose = Math.sqrt(2 * Math.max(1e-5, 1 - v.a.r0)) // what keeps a loop from piling up
        if (ex === 2) {
          v.phase += v.f0 / sr
          if (v.phase >= 1) v.phase -= 1
          const saw = v.a.wave ? (2 * v.phase - 1) * (1 - v.a.r0) * 2 : 0
          noisy += v.env * ((Math.random() * 2 - 1) * lose * 0.9 + saw) * (v.a.wave ? 0.5 : 1)
        } else if (ex === 4) {
          // breath: windy noise with a flutter in it
          const flutter = 1 + 0.18 * Math.sin((2 * Math.PI * 5.2 * v.t) / sr)
          noisy += v.env * (Math.random() * 2 - 1) * lose * flutter * (v.a.wave ? 0.6 : 1.1)
        } else if (Math.random() < (20 * 2 ** (k.hardness * 5.5)) / sr) {
          // scrape: catches at random, more often the harder it's pressed
          direct += v.env * (0.3 + 0.5 * Math.random()) * (Math.random() < 0.5 ? -1 : 1) * (v.a.wave ? 0.5 : 0.25)
        }
      }
    }
    v.lpY += (noisy - v.lpY) * v.lpA
    return v.lpY + direct
  }
  busy(v) { return v.active }
  render(v, L, R, from, to) {
    const k = this.k
    this.setup(v)
    const ex = Math.round(k.exciter)
    const gain = 10 ** (k.level / 20)
    const a = v.a, b = v.b
    const posLag = Math.max(1, Math.min(PH_LINE - 1, Math.round(a.period * k.position)))
    const mixB = v.bodyOn ? k.bodymix : 0
    const envFall = Math.exp(-1 / (0.15 * sampleRate))
    const glide = 1 - Math.exp(-1 / (0.02 * sampleRate))
    for (let i = from; i < to; i++) {
      let e = this.excite(v, ex)
      if (a.wave) {
        // where it's struck: the wave sent the other way comes back off the near end
        v.ex[v.exw] = e
        e -= v.ex[(v.exw - posLag + PH_LINE) % PH_LINE]
        v.exw = (v.exw + 1) % PH_LINE
      }
      const ya = a.tick(e)
      let y = ya
      if (v.bodyOn) {
        // the body's level follows what feeds it, however well it's tuned to it: measured
        // while the first is still sounding, then held, so the body rings on as it would
        const yb = b.tick(ya * v.bodyIn)
        const ai = Math.abs(ya), ab = Math.abs(yb)
        v.envIn = ai > v.envIn ? ai : v.envIn * envFall
        v.envB = ab > v.envB ? ab : v.envB * envFall
        if (v.envIn > v.peakIn) v.peakIn = v.envIn
        if (v.envIn > 0.25 * v.peakIn && v.envB > 1e-7) v.bodyGT = Math.min(400, v.envIn / v.envB)
        v.bodyG += (v.bodyGT - v.bodyG) * glide
        y = ya * (1 - mixB) + yb * v.bodyG * mixB
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
    // done once the hits are over and what rings has died away
    const hitting = v.pT >= 0 || v.hits < v.maxHits || (ex === 3 && v.t < v.len)
    const held = PH_SUSTAINED.includes(ex) && (v.gateOpen || v.env > 1e-4)
    if (!hitting && !held && v.t > 64 && v.level < 1e-5) v.active = false
  }
}
registerProcessor('lattice-physical', PhysicalProcessor)
`

// ── presets: places to start from, by name (lists by index: see MODELS, EXCITERS, BODIES) ──

const ex = (n) => EXCITERS.indexOf(n)
const mo = (n) => MODELS.indexOf(n)
const bo = (n) => BODIES.indexOf(n)
export const PRESETS = [
  // strings
  { name: 'nylon guitar', group: 'strings', data: { exciter: ex('pluck'), hardness: 0.45, position: 0.2, model: mo('string'), decay: 3, material: 0.35, stiffness: 0.05, body: bo('plate'), bodydecay: 0.15, bodymix: 0.35 } },
  { name: 'steel guitar', group: 'strings', data: { exciter: ex('pluck'), hardness: 0.7, position: 0.12, model: mo('string'), decay: 5, material: 0.7, stiffness: 0.15, body: bo('plate'), bodydecay: 0.2, bodymix: 0.3 } },
  { name: 'strummed', group: 'strings', data: { exciter: ex('strum'), length: 0.08, hardness: 0.55, position: 0.2, model: mo('string'), decay: 4, material: 0.5, body: bo('plate'), bodydecay: 0.2, bodymix: 0.3 } },
  { name: 'harp', group: 'strings', data: { exciter: ex('pluck'), hardness: 0.35, position: 0.35, model: mo('string'), decay: 6, material: 0.55, stiffness: 0.02, random: 0.1 } },
  { name: 'koto', group: 'strings', data: { exciter: ex('pluck'), hardness: 0.85, position: 0.08, model: mo('string'), decay: 2.5, material: 0.5, stiffness: 0.25, body: bo('tube'), bodydecay: 0.12, bodymix: 0.25 } },
  { name: 'banjo', group: 'strings', data: { exciter: ex('pluck'), hardness: 0.9, position: 0.06, model: mo('string'), decay: 1.5, material: 0.65, body: bo('membrane'), bodydecay: 0.08, bodymix: 0.55 } },
  { name: 'plucked bass', group: 'strings', data: { exciter: ex('pluck'), hardness: 0.3, position: 0.25, model: mo('string'), decay: 3, material: 0.3, stiffness: 0.02 } },
  { name: 'hammered piano', group: 'strings', data: { exciter: ex('mallet'), hardness: 0.6, position: 0.12, model: mo('string'), decay: 8, material: 0.7, stiffness: 0.35, body: bo('plate'), bodydecay: 0.6, bodymix: 0.3 } },
  { name: 'bowed cello', group: 'strings', data: { exciter: ex('bow'), length: 0.15, hardness: 0.4, model: mo('string'), decay: 4, material: 0.4, stiffness: 0.05, body: bo('plate'), bodydecay: 0.25, bodymix: 0.4, release: 0.4 } },
  // mallets
  { name: 'marimba', group: 'mallets', data: { exciter: ex('mallet'), hardness: 0.35, position: 0.2, model: mo('bar'), decay: 1.2, material: 0.2, stiffness: 0, body: bo('tube'), bodydecay: 0.5, bodymix: 0.45 } },
  { name: 'vibraphone', group: 'mallets', data: { exciter: ex('mallet'), hardness: 0.55, model: mo('bar'), decay: 4, material: 0.85, stiffness: 0, body: bo('tube'), bodydecay: 1.2, bodymix: 0.4 } },
  { name: 'glockenspiel', group: 'mallets', data: { exciter: ex('mallet'), hardness: 0.9, position: 0.1, model: mo('bar'), decay: 3, material: 0.95, stiffness: 0 } },
  { name: 'kalimba', group: 'mallets', data: { exciter: ex('pluck'), hardness: 0.7, position: 0.15, model: mo('bar'), decay: 1.5, material: 0.5, stiffness: 0, body: bo('plate'), bodydecay: 0.1, bodymix: 0.3 } },
  { name: 'steel pan', group: 'mallets', data: { exciter: ex('mallet'), hardness: 0.55, position: 0.25, model: mo('harmonic'), decay: 2, material: 0.8, stiffness: 0.12, body: bo('bowl'), bodydecay: 0.3, bodymix: 0.3 } },
  // drums
  { name: 'tom', group: 'drums', data: { exciter: ex('mallet'), hardness: 0.4, position: 0.2, model: mo('membrane'), decay: 0.5, material: 0.3, stiffness: 0 } },
  { name: 'tabla', group: 'drums', data: { exciter: ex('mallet'), hardness: 0.7, position: 0.3, model: mo('membrane'), decay: 0.9, material: 0.55, stiffness: 0.3, random: 0.3 } },
  { name: 'frame drum', group: 'drums', data: { exciter: ex('mallet'), hardness: 0.25, position: 0.45, model: mo('membrane'), decay: 0.7, material: 0.2, body: bo('tube'), bodytune: -12, bodydecay: 0.15, bodymix: 0.4 } },
  // metal & glass
  { name: 'church bell', group: 'metal & glass', data: { exciter: ex('mallet'), hardness: 0.6, model: mo('bell'), decay: 9, material: 0.95, random: 0.2 } },
  { name: 'gong', group: 'metal & glass', data: { exciter: ex('mallet'), hardness: 0.3, model: mo('gong'), decay: 8, material: 0.9, random: 0.3 } },
  { name: 'singing bowl', group: 'metal & glass', data: { exciter: ex('mallet'), hardness: 0.3, model: mo('bowl'), decay: 12, material: 0.95 } },
  { name: 'sung bowl', group: 'metal & glass', data: { exciter: ex('bow'), length: 0.8, hardness: 0.35, model: mo('bowl'), decay: 10, material: 0.95, release: 4 } },
  { name: 'wine glass', group: 'metal & glass', data: { exciter: ex('bow'), length: 0.5, hardness: 0.5, model: mo('glass'), decay: 6, material: 0.95, release: 1.5 } },
  { name: 'spring hit', group: 'metal & glass', data: { exciter: ex('mallet'), hardness: 0.8, model: mo('spring'), decay: 2.5, material: 0.8, stiffness: 0.6 } },
  { name: 'scraped plate', group: 'metal & glass', data: { exciter: ex('scrape'), hardness: 0.6, length: 0.1, model: mo('plate'), decay: 2, material: 0.9, release: 0.6 } },
  // wind
  { name: 'flute', group: 'wind', data: { exciter: ex('breath'), length: 0.08, hardness: 0.5, model: mo('tube'), decay: 3, material: 0.6, stiffness: 0, release: 0.3 } },
  { name: 'reed', group: 'wind', data: { exciter: ex('bow'), length: 0.05, hardness: 0.6, model: mo('tube'), decay: 4, material: 0.5, stiffness: 0, release: 0.2 } },
  // odd
  { name: 'dropped marble', group: 'odd', data: { exciter: ex('bounce'), length: 0.4, hardness: 0.9, model: mo('glass'), decay: 1.5, material: 0.9 } },
  { name: 'rain on tin', group: 'odd', data: { exciter: ex('bounce'), length: 0.1, hardness: 0.8, model: mo('plate'), decay: 0.8, material: 0.9 } },
  { name: 'breathing gong', group: 'odd', data: { exciter: ex('breath'), length: 0.6, hardness: 0.4, model: mo('gong'), decay: 6, material: 0.85, release: 3 } },
]

export default {
  type: 'physical',
  label: 'physical',
  blurb: 'A physical model: pluck, strike, bow, blow, scrape or strum a string, tube, bar, drum skin, plate, bell, glass, bowl, gong or spring, and couple a second body to it',
  kinds: ['synth', 'drum'],
  processor: 'lattice-physical',
  voices: 8,
  oneShot: false, // let go and it rings on for its release
  params: PARAMS,
  presets: PRESETS,
  groups: [['exciter', 'exciter'], ['resonator', 'resonator'], ['body', 'body'], ['out', 'out']],
  /** How long it rings once the note ends. */
  tail: (d) => Math.max(Math.min(d.decay, d.release), d.body ? Math.min(d.bodydecay, d.release) : 0) * 1.1 + 0.05,
  dsp: DSP,
}
