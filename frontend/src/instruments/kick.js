import { knobsSource } from './dsp.js'

/**
 * Kick: a sine that starts high and falls to its note, with a click on top, a shape and a
 * drive, the way Kick 2 builds one. One voice: a new hit takes over from the last one, with
 * a few milliseconds' fade so the tail it cuts doesn't click.
 *
 * The drive is a stage of its own (KickDrive, below): a curve (soft, hard, tube, fold or
 * crush) run at 2x or 4x the sample rate so a bright start driven hard doesn't alias, with
 * a crossover that can keep the sub clean, a tilt into it and a lowpass after it, an
 * envelope that moves how hard it drives over the hit, optional make-up gain and a dry/wet
 * mix. The click goes through it or around it. At its defaults it is the plain tanh the
 * kick always had.
 *
 * Played from steps it sits at its tune knob. A note moves the whole kick from there: C2 is
 * the kick as tuned, C#2 a semitone up, and so on (the start moves with it).
 */
const PARAMS = [
  // pitch
  { key: 'start', group: 'pitch', label: 'start', min: 40, max: 4000, def: 320, log: true, unit: 'hz' },
  { key: 'tune', group: 'pitch', label: 'tune', min: 25, max: 200, def: 48, log: true, unit: 'hz' },
  { key: 'sweep', group: 'pitch', label: 'sweep', min: 0.005, max: 1, def: 0.045, log: true, unit: 's' },
  { key: 'bend', group: 'pitch', label: 'bend', min: 0.25, max: 8, def: 2, log: true, unit: 'x' },
  // body
  { key: 'attack', group: 'body', label: 'attack', min: 0, max: 0.03, def: 0.001, unit: 's' },
  { key: 'hold', group: 'body', label: 'hold', min: 0, max: 1, def: 0.06, unit: 's' },
  { key: 'decay', group: 'body', label: 'decay', min: 0.02, max: 3, def: 0.4, log: true, unit: 's' },
  { key: 'curve', group: 'body', label: 'curve', min: 0.3, max: 6, def: 2, log: true, unit: 'x' },
  { key: 'shape', group: 'body', label: 'shape', min: 0, max: 1, def: 0 },
  // click
  { key: 'click', group: 'click', label: 'level', min: 0, max: 1, def: 0.35 },
  { key: 'clicktone', group: 'click', label: 'tone', min: 500, max: 16000, def: 4000, log: true, unit: 'hz' },
  { key: 'clicklen', group: 'click', label: 'length', min: 0.001, max: 0.05, def: 0.008, log: true, unit: 's' },
  // drive: a choice param holds an index into its `choices`
  { key: 'dtype', group: 'drive', label: 'curve', min: 0, max: 4, def: 0, choices: ['soft', 'hard', 'tube', 'fold', 'crush'] },
  { key: 'dos', group: 'drive', label: 'oversample', min: 0, max: 2, def: 1, choices: ['1x', '2x', '4x'] },
  { key: 'dauto', group: 'drive', label: 'make-up gain', min: 0, max: 1, def: 0, choices: ['off', 'auto'] },
  { key: 'droute', group: 'drive', label: 'click', min: 0, max: 1, def: 0, choices: ['through', 'around'] },
  { key: 'drive', group: 'drive', label: 'drive', min: 0, max: 1, def: 0.15 },
  { key: 'dmix', group: 'drive', label: 'mix', min: 0, max: 1, def: 1 },
  { key: 'dsub', group: 'drive', label: 'clean sub', min: 0, max: 1, def: 0 },
  { key: 'dsplit', group: 'drive', label: 'split', min: 40, max: 300, def: 100, log: true, unit: 'hz' },
  { key: 'denv', group: 'drive', label: 'env', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 },
  { key: 'dtime', group: 'drive', label: 'env time', min: 0.01, max: 1, def: 0.12, log: true, unit: 's' },
  { key: 'dtilt', group: 'drive', label: 'tilt', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 },
  { key: 'dtone', group: 'drive', label: 'tone', min: 500, max: 20000, def: 20000, log: true, unit: 'hz' },
  // out
  { key: 'level', group: 'out', label: 'level', min: -24, max: 6, def: 0, unit: 'db', origin: 0 },
]

/**
 * One voice's drive, a sample at a time. Plain JavaScript that touches nothing outside
 * itself: the processor gets it as source (see DSP) and the panel runs the same thing to
 * draw the wave.
 *
 * The signal splits at `dsplit`: `dsub` of the band below it goes around the curve. What's
 * left is tilted, driven and lowpassed; the curve runs oversampled through halfband
 * filters (windowed sinc, linear phase), so everything that goes around it is delayed to
 * match. `denv` moves the drive over the hit: up to +1 it starts dirty and cleans up, down
 * to -1 it starts clean and gets dirty, over `dtime`.
 */
export class KickDrive {
  constructor(rate) {
    this.rate = rate
    this.a = this.taps(12) // base <-> 2x: 47 taps
    this.b = this.taps(6) // 2x <-> 4x: 23 taps, the images there are far away
    this.upA = this.line(24)
    this.dnA = this.line(47)
    this.upB = this.line(12)
    this.dnB = this.line(23)
    this.half = 0 // one 2x sample of delay after the 4x stage, so its delay is whole samples
    this.dry = this.line(32)
    this.s1 = 0; this.s2 = 0 // crossover
    this.t1 = 0; this.t2 = 0 // tone
    this.tl = 0 // tilt
    this.dcx = 0; this.dcy = 0 // tube's DC blocker
    this.ph = 1e9; this.held = 0 // crush's sample and hold
    this.logComp = this.compTable()
    this.set({ drive: 0, dtype: 0, dos: 1, dauto: 0, dmix: 1, dsub: 0, dsplit: 100, denv: 0, dtime: 0.1, dtilt: 0, dtone: 20000 })
  }
  // the off-centre taps of a halfband lowpass, 4K - 1 long; the centre is 0.5
  taps(K) {
    const N = 4 * K - 1
    const c = (N - 1) / 2
    const a = new Float64Array(K)
    let sum = 0
    for (let i = 0; i < K; i++) {
      const m = 2 * i + 1
      const j = c + m
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * j) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * j) / (N - 1))
      a[i] = ((i % 2 ? -1 : 1) / (Math.PI * m)) * w
      sum += a[i]
    }
    for (let i = 0; i < K; i++) a[i] *= 0.25 / sum // DC passes exactly
    return a
  }
  line(L) { return { b: new Float64Array(2 * L), p: 0, L, odd: 0 } }
  push(l, v) { const p = l.p + 1 === l.L ? 0 : l.p + 1; l.p = p; l.b[p] = l.b[p + l.L] = v }
  // one sample in, two out: returns the first, leaves the second in l.odd
  up(l, a, x) {
    this.push(l, x)
    const K = a.length
    const b = l.b
    const at = l.p + l.L
    let e = 0
    for (let i = 0; i < K; i++) e += a[i] * (b[at - K + 1 + i] + b[at - K - i])
    l.odd = b[at - K + 1]
    return 2 * e
  }
  // the first of two samples in, one out (push the second after)
  down(l, a, v) {
    this.push(l, v)
    const K = a.length
    const b = l.b
    const at = l.p + l.L
    let z = 0.5 * b[at - 2 * K + 1]
    for (let i = 0; i < K; i++) z += a[i] * (b[at - 2 * K + 2 + 2 * i] + b[at - 2 * K - 2 * i])
    return z
  }
  // the curve's settings at drive d (0 … 1)
  shape(d) {
    const g = 1 + d * 8
    this.g = g
    if (this.type === 0 || this.type === 2) this.n = 1 / Math.tanh(g)
    if (this.type === 2) this.tb = 0.2 + 0.3 * d // how lopsided: a square term, so even harmonics
    else if (this.type === 3) this.g = (Math.PI / 2) * (1 + d * 5)
    else if (this.type === 4) this.q = 2 ** (10 - d * 10)
  }
  curve(x) {
    switch (this.type) {
      case 1: { const v = x * this.g; return v > 1 ? 1 : v < -1 ? -1 : v }
      case 2: { const v = Math.tanh(x * this.g) * this.n; return (v + this.tb * v * v) / (1 + this.tb) }
      case 3: return Math.sin(x * this.g)
      case 4: return Math.round(x * this.q) / this.q
      default: return Math.tanh(x * this.g) * this.n
    }
  }
  bend(x) { const c = this.curve(x); return this.e === 1 ? c : x + this.e * (c - x) }
  // how much quieter each curve leaves a falling sine, by drive: its make-up gain (log)
  compTable() {
    const out = []
    const keep = this.type
    for (let type = 0; type < 5; type++) {
      this.type = type
      const row = new Float64Array(33)
      for (let s = 0; s <= 32; s++) {
        this.shape(s / 32)
        let sx = 0
        let sy = 0
        for (let n = 0; n < 1024; n++) {
          const x = Math.sin((2 * Math.PI * n) / 64) * (1 - n / 1024)
          const y = this.curve(x)
          sx += x * x
          sy += y * y
        }
        row[s] = 0.5 * Math.log(sx / Math.max(1e-12, sy))
      }
      out.push(row)
    }
    this.type = keep
    return out
  }
  svf(fc, Q) {
    const g = Math.tan((Math.PI * Math.min(fc, this.rate * 0.45)) / this.rate)
    const a1 = 1 / (1 + g * (g + 1 / Q))
    return [a1, g * a1, g * g * a1]
  }
  // the knobs, once a block
  set(k) {
    this.drive = k.drive
    this.type = Math.max(0, Math.min(4, Math.round(k.dtype)))
    this.os = [1, 2, 4][Math.max(0, Math.min(2, Math.round(k.dos)))]
    this.delay = this.os === 1 ? 0 : this.os === 2 ? 23 : 29
    this.auto = k.dauto >= 0.5
    this.mix = k.dmix
    this.sub = k.dsub
    if (this.sub > 0) this.xo = this.svf(k.dsplit, Math.SQRT1_2)
    this.env = k.denv
    this.time = k.dtime
    this.tilt = k.dtilt
    if (this.tilt) {
      this.ta = 1 - Math.exp((-2 * Math.PI * 600) / this.rate)
      this.gl = 10 ** (-this.tilt * 0.3)
      this.gh = 10 ** (this.tilt * 0.3) // ±6 dB either side of 600 Hz
    }
    this.lp = k.dtone < 19999 ? this.svf(k.dtone, Math.SQRT1_2) : null
    this.hold = 1 + 20 * k.drive * k.drive
    this.dcr = Math.exp((-2 * Math.PI * 12) / this.rate)
    this.e = 1
    this.shape(k.drive)
    this.comp = this.auto ? Math.exp(this.lookup(k.drive)) : 1
  }
  lookup(d) {
    const row = this.logComp[this.type]
    const i = Math.min(31, Math.floor(d * 32))
    const f = d * 32 - i
    return row[i] + (row[i + 1] - row[i]) * f
  }
  // one sample: `x` goes through the drive, `around` joins after it; t is the hit's time
  run(x, around, t) {
    if (this.env) {
      const r = Math.exp(-t / this.time)
      this.e = this.env > 0 ? 1 - this.env * (1 - r) : 1 + this.env * r
      const d = this.drive * this.e
      this.shape(d)
      if (this.auto) this.comp = Math.exp(this.e * this.lookup(d))
    }
    let low = 0
    let v = x
    if (this.sub > 0) {
      const [a1, a2, a3] = this.xo
      const v3 = x - this.s2
      const v1 = a1 * this.s1 + a2 * v3
      low = this.s2 + a2 * this.s1 + a3 * v3
      this.s1 = 2 * v1 - this.s1
      this.s2 = 2 * low - this.s2
      v = x - this.sub * low
    }
    if (this.tilt) {
      this.tl += (v - this.tl) * this.ta
      v = this.tl * this.gl + (v - this.tl) * this.gh
    }
    if (this.type === 4) {
      if (++this.ph >= this.hold) { this.ph -= this.hold; if (this.ph >= this.hold) this.ph = 0; this.held = v }
      v = this.held
    }
    let w
    if (this.os === 1) w = this.bend(v)
    else {
      const u0 = this.up(this.upA, this.a, v)
      const u1 = this.upA.odd
      if (this.os === 2) {
        w = this.down(this.dnA, this.a, this.bend(u0))
        this.push(this.dnA, this.bend(u1))
      } else {
        w = this.down(this.dnA, this.a, this.quad(u0))
        this.push(this.dnA, this.quad(u1))
      }
    }
    if (this.type === 2) { const y = w - this.dcx + this.dcr * this.dcy; this.dcx = w; this.dcy = y; w = y }
    if (this.auto) w *= this.comp
    if (this.lp) {
      const [a1, a2, a3] = this.lp
      const v3 = w - this.t2
      const v1 = a1 * this.t1 + a2 * v3
      const v2 = this.t2 + a2 * this.t1 + a3 * v3
      this.t1 = 2 * v1 - this.t1
      this.t2 = 2 * v2 - this.t2
      w = v2
    }
    // what goes around the curve, delayed to meet it
    let dry = around
    if (this.sub > 0) dry += this.mix * this.sub * low
    if (this.mix < 1) dry += (1 - this.mix) * x
    if (this.delay) {
      this.push(this.dry, dry)
      dry = this.dry.b[this.dry.p + this.dry.L - this.delay]
    }
    return this.mix * w + dry
  }
  // a 2x sample through the 4x stage
  quad(s) {
    const q0 = this.up(this.upB, this.b, s)
    const q1 = this.upB.odd
    const r = this.down(this.dnB, this.b, this.bend(q0))
    this.push(this.dnB, this.bend(q1))
    const out = this.half
    this.half = r
    return out
  }
}

const DSP = `
const KickDrive = ${KickDrive.toString()}

class KickProcessor extends LatticeInstrument {
  static voiceCount = 4
  static knobs = ${knobsSource(PARAMS)}
  // after a hit ends the drive still holds its last few samples (its oversampling delay)
  busy(voice) { return voice.active || !!voice.fade || voice.flush > 0 }
  newVoice() { return { active: false, t: 0, phase: 0, vel: 1, ratio: 1, noise: 0, fade: null, flush: 0, drive: new KickDrive(sampleRate) } }
  noteOn(voice, note, vel) {
    // the hit it cuts off fades out underneath the new one
    if (voice.active) voice.fade = { t: voice.t, phase: voice.phase, ratio: voice.ratio, left: Math.round(0.004 * sampleRate), len: Math.round(0.004 * sampleRate) }
    voice.active = true
    voice.flush = 64
    voice.t = 0
    voice.phase = 0
    voice.noise = 0
    voice.vel = vel
    voice.ratio = note >= 0 ? 2 ** ((note - 36) / 12) : 1 // C2 plays it as tuned
  }
  // the kick at time t of a hit (no click), or null once it's over
  body(state, t) {
    const k = this.k
    const end = k.tune * state.ratio
    const start = Math.max(end, k.start * state.ratio)
    const u = t / k.sweep
    const e = u < 1 ? (1 - u) ** k.bend : 0
    const f = end * (start / end) ** e
    let amp
    if (t < k.attack) amp = t / k.attack
    else if (t < k.attack + k.hold) amp = 1
    else {
      const d = (t - k.attack - k.hold) / k.decay
      if (d >= 1) return null
      amp = (1 - d) ** k.curve
    }
    state.phase += f / sampleRate
    if (state.phase > 1) state.phase -= 1
    let y = Math.sin(2 * Math.PI * state.phase)
    if (k.shape > 0.001) { const g = 1 + k.shape * 6; y = Math.tanh(y * g) / Math.tanh(g) }
    return y * amp
  }
  render(voice, L, R, from, to) {
    const k = this.k
    const dt = 1 / sampleRate
    const gain = 10 ** (k.level / 20)
    const drive = k.drive > 0.001 ? voice.drive : null
    if (drive) drive.set(k)
    else voice.flush = 0
    const around = !!drive && k.droute >= 0.5 // the click skips the drive
    const lp = 1 - Math.exp((-2 * Math.PI * k.clicktone) / sampleRate)
    for (let i = from; i < to; i++) {
      let y = 0
      let c = 0
      if (voice.active) {
        const b = this.body(voice, voice.t)
        if (b === null) voice.active = false
        else {
          y = b
          if (voice.t < k.clicklen && k.click > 0) {
            voice.noise += (Math.random() * 2 - 1 - voice.noise) * lp
            const env = (1 - voice.t / k.clicklen) ** 2
            if (around) c = voice.noise * env * k.click * 1.5
            else y += voice.noise * env * k.click * 1.5
          }
          voice.t += dt
        }
      }
      const f = voice.fade
      if (f) {
        const b = this.body(f, f.t)
        if (b !== null) y += b * (f.left / f.len)
        f.t += dt
        if (--f.left <= 0 || b === null) voice.fade = null
      }
      if (drive) y = drive.run(y, c, voice.t)
      y *= gain
      L[i] += y
      if (R !== L) R[i] += y
      if (!voice.active && !voice.fade && --voice.flush <= 0) break
    }
  }
}
registerProcessor('lattice-kick', KickProcessor)
`

export default {
  type: 'kick',
  label: 'kick synth',
  blurb: 'A kick built from scratch: a falling sine, a click, a shape, and a drive with five curves, a clean sub and an envelope',
  kinds: ['drum', 'synth'],
  processor: 'lattice-kick',
  // A kick is one sound at a time musically, but it gets played more than once at the same
  // moment often enough: a roll whose tails overlap, or the same part sent down two paths
  // at once (dry to the mixer, and again into a reverb for rumble). With one voice the
  // second play cut the first off, and whichever landed last was the only one you heard.
  voices: 4,
  oneShot: true, // it plays its whole shape whatever the note's length
  params: PARAMS,
  groups: [['pitch', 'pitch'], ['body', 'body'], ['click', 'click'], ['out', 'output'], ['drive', 'drive']],
  /** How long a hit rings, in seconds, with these settings. */
  tail: (d) => d.attack + d.hold + d.decay + 0.02, // the drive's delay is well inside the 20 ms
  dsp: DSP,
}
