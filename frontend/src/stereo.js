/**
 * Bus inserts: Haas, the stereo widener and a mixer bus's fader, plus routing one bus into
 * another. Strudel only processes sound per note, and
 * a note can't delay one ear or trade mid for side, so these run on the audio bus (the
 * "orbit") a sound plays on, between the orbit and the speakers. The generated code only
 * moves the sound onto its own orbit; the processing lives here, so knobs act at once.
 *
 * Code pasted somewhere without this app plays normally, just not widened.
 */
import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio'
import { hasGesture } from './activation.js'

/**
 * The inserts that need to see the sound sample by sample, which only a worklet can do, so
 * they're built here as one module the audio thread loads.
 *
 * Sample-and-hold, for the lo-fi insert: hold every nth sample and throw the rest away, so
 * the bus sounds like it's running at a lower rate.
 */
const WORKLETS = `
class CoarseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'coarse', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' }]
  }
  constructor() { super(); this.phase = 0; this.held = [] }
  process(inputs, outputs, params) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || !output.length) return true
    if (!input || !input.length) { for (const ch of output) ch.fill(0); return true }
    const every = Math.max(1, Math.round(params.coarse[0]))
    for (let i = 0; i < output[0].length; i++) {
      if (this.phase <= 0) {
        // every channel is held together, or the stereo image tears
        for (let c = 0; c < output.length; c++) this.held[c] = (input[Math.min(c, input.length - 1)] || [])[i] || 0
        this.phase = every
      }
      this.phase--
      for (let c = 0; c < output.length; c++) output[c][i] = this.held[c] || 0
    }
    return true
  }
}
registerProcessor('lattice-coarse', CoarseProcessor)

/*
 * A brickwall limiter that looks ahead: the sound is heard a few milliseconds late, so the
 * gain can already be down by the time a peak arrives, and nothing gets past the ceiling.
 *
 * For each sample, the gain that would keep it under the ceiling; the lowest of those over
 * the lookahead window (held with a running minimum); a release that only ever lets the
 * gain rise slowly; then an average over the window, so the gain comes down smoothly and
 * is all the way down by the peak. Both sides share one gain, so the image stays put.
 */
const LOOKAHEAD = 0.003
class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 64, automationRate: 'k-rate' },
      { name: 'ceiling', defaultValue: 1, minValue: 0.01, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
    ]
  }
  constructor() {
    super()
    const n = this.n = Math.max(1, Math.round(LOOKAHEAD * sampleRate))
    this.size = n + 1
    this.delay = [new Float32Array(n), new Float32Array(n)]
    this.at = 0
    // running minimum over the last n + 1 wanted gains: a queue of (time, gain), rising
    this.qTime = new Float64Array(this.size)
    this.qGain = new Float32Array(this.size)
    this.qHead = 0
    this.qLen = 0
    this.time = 0
    // average over the last n held gains
    this.box = new Float32Array(n).fill(1)
    this.boxAt = 0
    this.sum = n
    this.env = 1
  }
  process(inputs, outputs, params) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || !output.length) return true
    const inL = input?.[0]
    const inR = input?.[1] ?? inL
    const gain = params.gain[0]
    const ceiling = params.ceiling[0]
    const rise = 1 - Math.exp(-1 / (Math.max(0.001, params.release[0]) * sampleRate))
    const { n, size, delay, qTime, qGain, box } = this
    const outL = output[0]
    const outR = output[1] ?? output[0]
    for (let i = 0; i < outL.length; i++) {
      const l = inL ? inL[i] * gain : 0
      const r = inR ? inR[i] * gain : 0
      const peak = Math.max(Math.abs(l), Math.abs(r))
      const want = peak > ceiling ? ceiling / peak : 1
      // the running minimum: drop what's too old, and anything the new gain undercuts
      const t = this.time++
      while (this.qLen && qTime[this.qHead] <= t - size) { this.qHead = (this.qHead + 1) % size; this.qLen-- }
      while (this.qLen && qGain[(this.qHead + this.qLen - 1) % size] >= want) this.qLen--
      const tail = (this.qHead + this.qLen) % size
      qTime[tail] = t
      qGain[tail] = want
      this.qLen++
      const held = qGain[this.qHead]
      // down at once, up at the release's pace
      this.env = held < this.env ? held : this.env + (held - this.env) * rise
      this.sum += this.env - box[this.boxAt]
      box[this.boxAt] = this.env
      this.boxAt = (this.boxAt + 1) % n
      if (this.boxAt === 0) { let s = 0; for (let k = 0; k < n; k++) s += box[k]; this.sum = s } // no drift
      const g = this.sum / n
      // the sound from n samples ago, with the gain that was made ready for it
      const yl = delay[0][this.at] * g
      const yr = delay[1][this.at] * g
      delay[0][this.at] = l
      delay[1][this.at] = r
      this.at = (this.at + 1) % n
      // a last guard against rounding: never past the ceiling
      outL[i] = yl > ceiling ? ceiling : yl < -ceiling ? -ceiling : yl
      if (output[1]) outR[i] = yr > ceiling ? ceiling : yr < -ceiling ? -ceiling : yr
    }
    return true
  }
}
registerProcessor('lattice-limiter', LimiterProcessor)
`
let workletUrl = null
const loaded = new WeakMap() // audio context → the promise that adds the module to it

/**
 * Make sure the audio thread has what the inserts need. Playback loads it as it goes;
 * an offline render has to wait for it, or it renders before the module arrives.
 */
export function prepareInserts() {
  const ac = getAudioContext()
  if (!ac?.audioWorklet) return Promise.resolve()
  if (!loaded.has(ac)) {
    if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLETS], { type: 'text/javascript' }))
    loaded.set(ac, ac.audioWorklet.addModule(workletUrl).catch((err) => {
      console.warn('[stereo] could not load the lo-fi and limiter worklets', err)
    }))
  }
  return loaded.get(ac)
}

/** First orbit handed to stereo inserts (sidechains use 2 and up; Strudel's default is 1). */
export const STEREO_ORBIT_BASE = 40

let declared = new Map() // orbit → [{ key, kind, params }] from the latest generated code
let routed = new Map() // orbit → { to, gain }: the orbit it plays into (a mixer bus) and at what level
const racks = new Map() // orbit → { orbit (Orbit object), input, output, units: Map(key → unit) }
let controller = null
let armed = false

/** Start collecting the inserts a code generation declares. */
export function beginInserts() {
  return { inserts: new Map(), routes: new Map() }
}

/** A stereo insert on an orbit, in signal order. */
export function declareInsert(list, orbit, key, kind, params) {
  if (!list.inserts.has(orbit)) list.inserts.set(orbit, [])
  list.inserts.get(orbit).push({ key, kind, params })
}

/** Send everything on one orbit into another (a mixer bus) instead of the speakers, at `gain`. */
export function declareRoute(list, from, to, gain = 1) {
  if (!list.inserts.has(from)) list.inserts.set(from, [])
  list.routes.set(from, { to, gain })
}

/**
 * The inserts the code now has. `partial` (auditioning one node) only adds and updates,
 * so the rest of the patch keeps its processing for when playback comes back to it.
 */
export function commitInserts(list, { partial = false } = {}) {
  declared = partial ? new Map([...declared, ...list.inserts]) : list.inserts
  routed = partial ? new Map([...routed, ...list.routes]) : list.routes
  // the audio side must never break generating the code (and so the whole app)
  try { apply() } catch (err) { console.warn('[stereo] could not update the stereo inserts', err) }
}

function apply() {
  if (!install()) return
  for (const [n, rack] of racks) {
    if (controller.nodes[n] !== rack.orbit) { teardown(n); continue } // the controller was reset
    wire(n, rack, declared.get(n) ?? [])
    aim(n, rack)
  }
  // a bus that was already playing before it got an insert (a sidechain's, say)
  for (const n of declared.keys()) if (!racks.has(n) && controller.nodes[n]) mount(n, controller.nodes[n])
}

/** Hook into the audio controller once the page may make sound. */
function install() {
  if (controller && controller === safeController()) return true
  if (!hasGesture()) {
    if (!armed) {
      armed = true
      const go = () => {
        window.removeEventListener('pointerdown', go, true)
        window.removeEventListener('keydown', go, true)
        try { apply() } catch (err) { console.warn('[stereo] could not update the stereo inserts', err) }
      }
      window.addEventListener('pointerdown', go, true)
      window.addEventListener('keydown', go, true)
    }
    return false
  }
  const ctl = safeController()
  if (!ctl) return false
  controller = ctl
  racks.clear()
  const getOrbit = ctl.getOrbit.bind(ctl)
  ctl.getOrbit = (n, channels) => {
    const fresh = ctl.nodes[n] == null
    const orbit = getOrbit(n, channels)
    if ((n >= STEREO_ORBIT_BASE || declared.has(n)) && (fresh || racks.get(n)?.orbit !== orbit)) {
      try { mount(n, orbit, channels) } catch (err) { console.warn('[stereo] could not insert on bus', n, err) }
    }
    return orbit
  }
  return true
}

function safeController() {
  try { return getSuperdoughAudioController() } catch { return null }
}

/** Put a rack between a stereo orbit and the speakers. */
function mount(n, orbit, channels) {
  const ac = getAudioContext()
  const stereo = () => new GainNode(ac, { gain: 1, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
  const input = stereo()
  const output = stereo()
  orbit.output.disconnect() // it went straight to the speakers
  orbit.output.connect(input)
  // order starts unset so the first wiring always connects input → output, even with no
  // units (a bus that only plays into a mixer bus has none)
  // what it plays into, at the level the bus it feeds gives it (a mixer's channel fader)
  const send = stereo()
  output.connect(send)
  const rack = { orbit, input, output, send, units: new Map(), order: null, channels, to: undefined }
  racks.set(n, rack)
  wire(n, rack, declared.get(n) ?? [])
  aim(n, rack)
}

/** Point a rack at the speakers, or into the mixer bus its orbit is routed to, at its level. */
function aim(n, rack) {
  const route = routed.get(n) ?? null
  const to = route?.to ?? null
  smooth(rack.send.gain, route ? route.gain ?? 1 : 1)
  if (rack.to === to) return
  rack.output.disconnect()
  rack.output.connect(rack.send)
  rack.send.disconnect()
  if (to != null && to !== n) rack.send.connect(controller.getOrbit(to).summingNode)
  else controller.output.connectToDestination(rack.send, rack.channels)
  rack.to = to
}

function teardown(n) {
  const rack = racks.get(n)
  if (!rack) return
  for (const unit of rack.units.values()) unit.dispose()
  try { rack.input.disconnect(); rack.output.disconnect(); rack.send.disconnect() } catch { /* already gone */ }
  racks.delete(n)
}

/** Connect input → units in order → output, building or updating units as needed. */
function wire(n, rack, inserts) {
  const order = inserts.map((i) => `${i.kind}:${i.key}`).join('|')
  for (const i of inserts) {
    let unit = rack.units.get(i.key)
    if (unit && unit.kind !== i.kind) { unit.dispose(); rack.units.delete(i.key); unit = null }
    if (!unit) { unit = UNITS[i.kind](getAudioContext()); unit.kind = i.kind; rack.units.set(i.key, unit) }
    unit.params = i.params
    unit.set(i.params)
  }
  if (order === rack.order) return
  rack.order = order
  const keep = new Set(inserts.map((i) => i.key))
  for (const [key, unit] of rack.units) if (!keep.has(key)) { unit.dispose(); rack.units.delete(key) }
  rack.input.disconnect()
  for (const unit of rack.units.values()) unit.output.disconnect()
  let from = rack.input
  for (const i of inserts) {
    const unit = rack.units.get(i.key)
    from.connect(unit.input)
    from = unit.output
  }
  from.connect(rack.output)
}

/**
 * Move one insert's knobs while it plays (automation, see automation.js): what the code
 * declared is patched too, so the value sticks if the insert is rebuilt.
 */
export function setInsertParams(key, patch) {
  // an insert declared while the sound was already playing isn't mounted yet: mount it now
  try { apply() } catch (err) { console.warn('[stereo] could not update the stereo inserts', err) }
  for (const list of declared.values()) {
    const found = list.find((i) => i.key === key)
    if (found) found.params = { ...found.params, ...patch }
  }
  for (const rack of racks.values()) {
    const unit = rack.units.get(key)
    if (!unit) continue
    unit.params = { ...unit.params, ...patch }
    try { unit.set(unit.params) } catch (err) { console.warn('[stereo] could not move a knob', err) }
  }
}

const smooth = (param, value) => {
  if (Number.isFinite(value)) param.setTargetAtTime(value, getAudioContext().currentTime, 0.02)
}

const dbGain = (db) => (Number.isFinite(db) ? db : 0)

/**
 * The waveshaping curves, the same ones Strudel uses per note, so a saturator or a clipper
 * on a bus sounds like the one on a single sound — only now it's shaping everything that
 * landed on the bus together, and doing it at four times the sample rate.
 */
const CURVES = {
  scurve: (x, k) => ((1 + k) * x) / (1 + k * Math.abs(x)),
  soft: (x, k) => Math.tanh(x * (1 + k)),
  hard: (x, k) => Math.min(1, Math.max(-1, (1 + k) * x)),
  cubic(x, k) {
    const t = Math.log1p(k) / (1 + Math.log1p(k))
    return CURVES.soft((x - (t / 3) * x * x * x) / (1 - t / 3), k)
  },
  diode(x, k, asym = false) {
    const g = 1 + 2 * k
    const t = Math.log1p(k) / (1 + Math.log1p(k))
    const bias = 0.07 * t
    const y = CURVES.soft(x + bias, 2 * k) - CURVES.soft(asym ? bias : -x + bias, 2 * k)
    const sech = 1 / Math.cosh(g * bias)
    // divided by the slope at zero, so quiet signal comes through undistorted
    return CURVES.soft(y / Math.max(1e-8, (asym ? 1 : 2) * g * sech * sech), k)
  },
  asym: (x, k) => CURVES.diode(x, k, true),
  fold(x, k) {
    const y = (1 + 0.5 * k) * x
    const window = ((y + 1) % 4 + 4) % 4
    return 1 - Math.abs(window - 2)
  },
  /* a fuzz: gain so high the wave is nearly square, its corners still rounded */
  fuzz: (x, k) => Math.tanh(x * (3 + 24 * k)),
  /* both halves of the wave folded the same way up: the fundamental cancels and you hear
     the octave above it. The DC the fold leaves behind is taken out after the shaper. */
  rect: (x, k) => CURVES.soft(2 * Math.abs(x) - 0.55, 0.4 + k),
  chebyshev(x, k) {
    const kl = 10 * Math.log1p(k)
    let tnm1 = 1
    let tnm2 = x
    let y = x
    for (let i = 2; i < 64; i++) {
      const tn = 2 * x * tnm1 - tnm2
      tnm2 = tnm1
      tnm1 = tn
      if (i % 2 === 0) y += Math.min((1.3 * kl) / i, 2) * tn
    }
    return CURVES.soft(y, kl / 20)
  },
}

/*
 * The five pedals the distortion node offers. Each is a clipping curve, how much gain runs
 * into it, how lopsided it can be made, and the mid lift it's known for: a rat is nasal
 * because of that lift as much as its diodes, and a fuzz is rude because it's driven
 * twenty times harder than an overdrive.
 */
const DIST_MODES = {
  overdrive: { curve: 'cubic', k: 1.2, gain: 9, bias: 0.12, voice: 2 },
  crunch: { curve: 'scurve', k: 2, gain: 15, bias: 0.18, voice: 3 },
  rat: { curve: 'diode', k: 2.6, gain: 26, bias: 0.22, voice: 7 },
  fuzz: { curve: 'fuzz', k: 1, gain: 40, bias: 0.35, voice: 4 },
  octave: { curve: 'rect', k: 1.4, gain: 20, bias: 0.1, voice: 5 },
}

const HEADROOM = 4 // a bus can run hotter than one note, so the curve covers +12 dB
const CURVE_POINTS = 8192

/** A lookup table for one curve at one drive, over the range the bus can reach. */
function curveTable(shape, k, bits = 0) {
  const steps = bits ? 2 ** (bits - 1) : 0
  const table = new Float32Array(CURVE_POINTS)
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (-1 + (2 * i) / (CURVE_POINTS - 1)) * HEADROOM
    let y = shape(x, k)
    if (!Number.isFinite(y)) y = 0
    // fewer bits to hold the level in: the curve climbs in steps instead of smoothly
    if (steps) y = Math.round(y * steps) / steps
    table[i] = Math.min(1, Math.max(-1, y))
  }
  return table
}

/**
 * The chorus and the flanger: on each side, delayed copies whose delay times follow one
 * slow oscillator, mixed in with the dry sound. `voices` are the delays they swing around,
 * by up to `sweep` seconds either way (less than the shortest, so none reaches zero); `spread` swings the right side against the left; `feedback` sends the copy back in.
 */
function modDelay(ac, { voices, sweep, spread, feedback }) {
  const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
  const split = new ChannelSplitterNode(ac, { numberOfOutputs: 2 })
  const merge = new ChannelMergerNode(ac, { numberOfInputs: 2 })
  const output = new GainNode(ac, { gain: 1 })
  const dry = new GainNode(ac, { gain: 1 })
  const lfo = new OscillatorNode(ac, { type: 'sine', frequency: 0.5 })
  const all = [input, split, merge, output, dry, lfo]
  input.connect(dry).connect(output)
  input.connect(split)
  merge.connect(output)
  const swings = []
  const fbs = []
  const wets = []
  for (const side of [0, 1]) {
    const wet = new GainNode(ac, { gain: 0.5 / voices.length })
    wet.connect(merge, 0, side)
    wets.push(wet)
    voices.forEach((base, v) => {
      const delay = new DelayNode(ac, { maxDelayTime: 0.05, delayTime: base })
      // each voice, and the right side, swings the other way to the one before
      const swing = new GainNode(ac, { gain: 0 })
      swing.sign = (spread && side ? -1 : 1) * (v % 2 ? -1 : 1)
      split.connect(delay, side)
      lfo.connect(swing).connect(delay.delayTime)
      delay.connect(wet)
      swings.push(swing)
      all.push(delay, swing)
      if (feedback) {
        const fb = new GainNode(ac, { gain: 0 })
        delay.connect(fb).connect(delay)
        fbs.push(fb)
        all.push(fb)
      }
    })
    all.push(wet)
  }
  lfo.start()
  return {
    input,
    output,
    set({ rate, depth, mix, feedback: amount }) {
      const d = Math.min(1, Math.max(0, Number(depth) || 0))
      const m = Math.min(1, Math.max(0, Number.isFinite(Number(mix)) ? Number(mix) : 0.5))
      smooth(lfo.frequency, Math.min(20, Math.max(0.02, Number(rate) || 0.5)))
      for (const s of swings) smooth(s.gain, s.sign * d * sweep)
      const f = Math.min(0.95, Math.max(-0.95, Number(amount) || 0))
      for (const fb of fbs) smooth(fb.gain, f)
      // feedback piles up level, so the copy comes down to match
      for (const wet of wets) smooth(wet.gain, (m * (1 - Math.abs(f) * 0.5)) / voices.length)
      smooth(dry.gain, 1 - m * 0.5)
    },
    dispose() { try { lfo.stop() } catch { /* already stopped */ } for (const node of all) node.disconnect() },
  }
}

const UNITS = {
  /**
   * Three-band EQ on the summed sound: a shelf at each end and a bell in the middle, the
   * way a mixer's EQ works. (It used to split each note into three filtered copies and add
   * them back, which never summed flat and made any filter after it far too steep.)
   */
  eq(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const low = new BiquadFilterNode(ac, { type: 'lowshelf', frequency: 200 })
    const mid = new BiquadFilterNode(ac, { type: 'peaking', frequency: 800, Q: 0.9 })
    const high = new BiquadFilterNode(ac, { type: 'highshelf', frequency: 3000 })
    input.connect(low).connect(mid).connect(high)
    return {
      input,
      output: high,
      set(params) {
        const lowf = Number.isFinite(params.lowf) ? params.lowf : 200
        const highf = Number.isFinite(params.highf) ? params.highf : 3000
        smooth(low.frequency, lowf)
        smooth(high.frequency, highf)
        // the bell sits between the two crossovers, wide enough to cover the middle
        smooth(mid.frequency, Math.sqrt(Math.max(20, lowf) * Math.max(40, highf)))
        // as wide as the gap between the crossovers, so the middle moves as one
        const octaves = Math.min(6, Math.max(0.5, Math.log2(Math.max(2, highf / Math.max(20, lowf)))))
        mid.Q.value = Math.max(0.3, 1 / (2 * Math.sinh((Math.LN2 / 2) * octaves)))
        smooth(low.gain, dbGain(params.low))
        smooth(mid.gain, dbGain(params.mid))
        smooth(high.gain, dbGain(params.high))
      },
      dispose() { for (const node of [input, low, mid, high]) node.disconnect() },
    }
  },
  /** A mixer bus's level and pan, on the summed sound. */
  fader(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const panner = new StereoPannerNode(ac)
    input.connect(panner)
    return {
      input,
      output: panner,
      set({ gain, pan }) {
        smooth(input.gain, gain)
        smooth(panner.pan, pan * 2 - 1)
      },
      dispose() { input.disconnect(); panner.disconnect() },
    }
  },

  /**
   * Lo-fi: the whole bus sampled at a lower rate. Crushing each note on its own and adding
   * them up isn't the same sound — done together, the parts grind against each other.
   */
  lofi(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const output = new GainNode(ac, { gain: 1 })
    input.connect(output) // straight through until the worklet is on the audio thread
    let node = null
    let coarse = 1
    let gone = false
    prepareInserts().then(() => {
      if (gone) return // taken out of the rack while we waited
      try {
        node = new AudioWorkletNode(ac, 'lattice-coarse', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
        node.parameters.get('coarse').value = coarse
        input.disconnect()
        input.connect(node).connect(output)
      } catch (err) { console.warn('[stereo] could not start the lo-fi insert', err) }
    })
    return {
      input,
      output,
      set(params) {
        coarse = Math.min(64, Math.max(1, Math.round(Number(params.coarse) || 1)))
        if (node) node.parameters.get('coarse').value = coarse
      },
      dispose() {
        gone = true
        for (const audio of [input, output, node]) audio?.disconnect()
        node = null
      },
    }
  },

  /** Cut highs or lows across the bus, so a filter node works like a mixer's filter. */
  filter(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const high = new BiquadFilterNode(ac, { type: 'highpass', frequency: 20, Q: 0.707 })
    const low = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 20000, Q: 0.707 })
    input.connect(high).connect(low)
    return {
      input,
      output: low,
      set({ lpf, lpq, hpf }) {
        smooth(low.frequency, Math.min(20000, Math.max(20, Number(lpf) || 20000)))
        smooth(high.frequency, Math.min(18000, Math.max(20, Number(hpf) || 20)))
        low.Q.value = Math.min(30, Math.max(0.0001, Number(lpq) || 0.0001))
      },
      dispose() { for (const node of [input, high, low]) node.disconnect() },
    }
  },

  /** One knob across the bus: left closes a low pass, right opens a high pass. */
  djfilter(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const high = new BiquadFilterNode(ac, { type: 'highpass', frequency: 20, Q: 0.9 })
    const low = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 20000, Q: 0.9 })
    input.connect(high).connect(low)
    const sweep = (from, to, t) => from * (to / from) ** t
    return {
      input,
      output: low,
      set({ djf }) {
        const v = Math.min(1, Math.max(0, Number.isFinite(djf) ? djf : 0.5))
        // the middle is wide open; either side sweeps one filter in
        smooth(low.frequency, v < 0.48 ? sweep(20000, 120, (0.48 - v) / 0.48) : 20000)
        smooth(high.frequency, v > 0.52 ? sweep(20, 9000, (v - 0.52) / 0.48) : 20)
      },
      dispose() { for (const node of [input, high, low]) node.disconnect() },
    }
  },

  /** Volume that pulses: one oscillator moving the bus's gain. */
  tremolo(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const output = new GainNode(ac, { gain: 1 })
    const lfo = new OscillatorNode(ac, { type: 'sine', frequency: 4 })
    const swing = new GainNode(ac, { gain: 0.35 })
    input.connect(output)
    lfo.connect(swing).connect(output.gain)
    lfo.start()
    return {
      input,
      output,
      set({ rate, depth }) {
        const d = Math.min(1, Math.max(0, Number(depth) || 0))
        smooth(lfo.frequency, Math.min(64, Math.max(0.05, Number(rate) || 4)))
        smooth(swing.gain, d / 2)
        smooth(output.gain, 1 - d / 2) // so full depth swings between silence and full
      },
      dispose() { try { lfo.stop() } catch { /* already stopped */ } for (const node of [input, output, lfo, swing]) node.disconnect() },
    }
  },

  /** Four all-pass stages swept by an oscillator, mixed back in: the swirl. */
  phaser(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const output = new GainNode(ac, { gain: 1 })
    const wet = new GainNode(ac, { gain: 0.5 })
    const lfo = new OscillatorNode(ac, { type: 'sine', frequency: 2 })
    const sweep = new GainNode(ac, { gain: 700 })
    const stages = [400, 700, 1200, 2000].map((f) => new BiquadFilterNode(ac, { type: 'allpass', frequency: f, Q: 0.8 }))
    input.connect(output) // dry
    let from = input
    for (const stage of stages) { from.connect(stage); from = stage; lfo.connect(sweep).connect(stage.frequency) }
    from.connect(wet).connect(output)
    lfo.start()
    return {
      input,
      output,
      set({ rate, depth }) {
        const d = Math.min(1, Math.max(0, Number(depth) || 0))
        smooth(lfo.frequency, Math.min(32, Math.max(0.05, Number(rate) || 2)))
        smooth(sweep.gain, 200 + d * 900)
        smooth(wet.gain, d * 0.9)
      },
      dispose() { try { lfo.stop() } catch { /* already stopped */ } for (const node of [input, output, wet, lfo, sweep, ...stages]) node.disconnect() },
    }
  },

  /**
   * Copies of the sound a few milliseconds late, their delay wobbling slowly: slightly out
   * of tune with the dry sound, like several players at once. The two sides wobble in
   * opposite directions, so it spreads wide.
   */
  chorus(ac) {
    return modDelay(ac, { voices: [0.012, 0.019], sweep: 0.004, spread: true, feedback: false })
  },

  /**
   * One very short delay swept up and down and fed back into itself: the comb it makes
   * glides through the sound, the jet-plane whoosh.
   */
  flanger(ac) {
    return modDelay(ac, { voices: [0.0035], sweep: 0.003, spread: false, feedback: true })
  },

  /** Three formant peaks, so the bus sounds like it says a vowel. */
  vowel(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const output = new GainNode(ac, { gain: 1 })
    const bands = [[1, 8], [0.55, 10], [0.3, 12]].map(([gain, q]) => {
      const band = new BiquadFilterNode(ac, { type: 'bandpass', frequency: 800, Q: q })
      const level = new GainNode(ac, { gain })
      input.connect(band).connect(level).connect(output)
      return band
    })
    const FORMANTS = { a: [800, 1150, 2900], e: [400, 1600, 2700], i: [350, 1700, 2700], o: [450, 800, 2830], u: [325, 700, 2530] }
    return {
      input,
      output,
      set({ vowel }) {
        const f = FORMANTS[vowel] ?? FORMANTS.a
        bands.forEach((band, i) => smooth(band.frequency, f[i]))
      },
      dispose() { for (const node of [input, output, ...bands]) node.disconnect() },
    }
  },

  /**
   * Saturation and clipping on the summed sound, the way a mixer insert works: everything
   * on the bus hits one curve together, so parts glue and peaks that only happen when they
   * land at once are the ones that get caught.
   */
  shaper(ac) {
    const input = new GainNode(ac, { gain: 1 / HEADROOM, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const shape = new WaveShaperNode(ac, { oversample: '4x' })
    const output = new GainNode(ac, { gain: 1 })
    input.connect(shape).connect(output)
    let made = ''
    return {
      input,
      output,
      set(params) {
        const curve = CURVES[params.curve] ? params.curve : 'soft'
        // the drive node gives its knob straight through; the classic shape curve wants
        // it as a steepness, and it can also throw away bits on the way out
        const s = Math.min(0.95, Math.max(0, Number(params.shape) || 0))
        const drive = Number.isFinite(params.shape) ? (2 * s) / (1 - s) : Math.min(24, Math.max(0, Number(params.drive) || 0))
        const crush = Math.min(1, Math.max(0, Number(params.crush) || 0))
        const bits = crush > 0.001 ? Math.max(1, Math.round(16 - crush * 14)) : 0
        // the table only changes when the shape, the drive or the bit depth does
        const want = `${curve}:${Math.round(drive * 200)}:${bits}`
        if (want !== made) {
          made = want
          shape.curve = curveTable(CURVES[curve], drive, bits)
        }
        smooth(output.gain, Number.isFinite(params.out) ? params.out : 1)
      },
      dispose() { for (const node of [input, shape, output]) node.disconnect() },
    }
  },

  /**
   * Distortion, as a pedal rather than a curve.
   *
   * Saturation is a curve you push a little signal into. Distortion is a whole circuit, and
   * the circuit is most of the sound: what you take out *before* the clipping (bass, which
   * otherwise turns everything to mush), what the clipper is shaped like, how lopsided it
   * is (a bias makes even harmonics — the difference between 'warm' and 'rude'), what you
   * take out *after* it (fizz), and how much of the clean sound is still there underneath.
   *
   *   in → tighten (high-pass) → voice (a mid lift, per mode) → drive ↘
   *                                                          bias → clip → DC block → tone → mix
   *   in ──────────────────────────────────────────────────────────── dry ↗
   *
   * The curve is fixed per mode and `drive` is a plain gain into it, exactly as a pedal
   * works — which also means driving it harder is one smooth parameter change rather than
   * rebuilding a lookup table, so you can automate it.
   */
  dist(ac) {
    const input = new GainNode(ac, { gain: 1 / HEADROOM, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const tight = new BiquadFilterNode(ac, { type: 'highpass', frequency: 20, Q: 0.707 })
    const voice = new BiquadFilterNode(ac, { type: 'peaking', frequency: 1000, Q: 0.7, gain: 0 })
    const pre = new GainNode(ac, { gain: 1 })
    const bias = new ConstantSourceNode(ac, { offset: 0 })
    const clip = new WaveShaperNode(ac, { oversample: '4x' })
    // a fold or a bias leaves the signal sitting off-centre; without this it thumps
    const dc = new BiquadFilterNode(ac, { type: 'highpass', frequency: 16, Q: 0.707 })
    const tone = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 14000, Q: 0.707 })
    const wet = new GainNode(ac, { gain: 1 })
    const dry = new GainNode(ac, { gain: 0 })
    const output = new GainNode(ac, { gain: 1 })
    input.connect(tight).connect(voice).connect(pre).connect(clip)
    bias.connect(clip)
    clip.connect(dc).connect(tone).connect(wet).connect(output)
    input.connect(dry).connect(output)
    bias.start()
    let made = ''
    return {
      input,
      output,
      set(params) {
        const spec = DIST_MODES[params.mode] ?? DIST_MODES.overdrive
        const at = (v, lo, hi, def) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : def))
        const drive = at(params.drive, 0, 1, 0.45)
        if (spec.curve !== made) {
          made = spec.curve
          clip.curve = curveTable(CURVES[spec.curve], spec.k)
        }
        const gain = 1 + drive * spec.gain
        smooth(pre.gain, gain)
        smooth(voice.gain, spec.voice * (0.3 + 0.7 * drive))
        smooth(bias.offset, at(params.bias, 0, 1, 0) * spec.bias)
        // both ends of the tone stack are where the ear hears them, not linear in hertz
        smooth(tight.frequency, 20 * (400 / 20) ** at(params.tighten, 0, 1, 0))
        smooth(tone.frequency, 700 * (16000 / 700) ** at(params.tone, 0, 1, 0.55))
        const mix = at(params.mix, 0, 1, 1)
        // driving it harder shouldn't mean turning it up: the knob stays about where it was
        smooth(wet.gain, mix / (1 + Math.log1p(gain) * 0.32))
        smooth(dry.gain, 1 - mix)
        smooth(output.gain, at(params.out, 0.05, 1, 0.8))
      },
      dispose() {
        try { bias.stop() } catch { /* already stopped */ }
        for (const node of [input, tight, voice, pre, bias, clip, dc, tone, wet, dry, output]) node.disconnect()
      },
    }
  },

  /**
   * A compressor across the whole bus: it hears the parts together, so it ducks on what the
   * mix does rather than on one note at a time. That's what makes a drum bus breathe.
   */
  comp(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const comp = new DynamicsCompressorNode(ac)
    const makeup = new GainNode(ac, { gain: 1 })
    input.connect(comp).connect(makeup)
    return {
      input,
      output: makeup,
      set(params) {
        const at = (name, value, lo, hi) => smooth(comp[name], Math.min(hi, Math.max(lo, Number(value))))
        at('threshold', params.threshold, -100, 0)
        at('ratio', params.ratio, 1, 20)
        at('knee', params.knee, 0, 40)
        at('attack', params.attack, 0, 1)
        at('release', params.release, 0, 1)
        smooth(makeup.gain, 10 ** (dbGain(params.makeup) / 20))
      },
      dispose() { for (const node of [input, comp, makeup]) node.disconnect() },
    }
  },

  /**
   * A limiter across the whole bus: push the level up into a ceiling nothing gets past.
   * The last thing on a master, so a track comes out loud without clipping.
   */
  limiter(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const output = new GainNode(ac, { gain: 1 })
    // until the worklet is on the audio thread, a compressor stands in (never unlimited)
    const standIn = new DynamicsCompressorNode(ac, { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.1 })
    input.connect(standIn).connect(output)
    let node = null
    let gone = false
    let now = { gain: 1, ceiling: 1, release: 0.1 }
    const push = () => {
      if (!node) return
      for (const [name, value] of Object.entries(now)) node.parameters.get(name).setTargetAtTime(value, ac.currentTime, 0.02)
    }
    prepareInserts().then(() => {
      if (gone) return // taken out of the rack while we waited
      try {
        node = new AudioWorkletNode(ac, 'lattice-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
        for (const [name, value] of Object.entries(now)) node.parameters.get(name).value = value
        input.disconnect()
        standIn.disconnect()
        input.connect(node).connect(output)
      } catch (err) { console.warn('[stereo] could not start the limiter', err) }
    })
    return {
      input,
      output,
      set(params) {
        const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
        now = {
          gain: 10 ** (num(params.gain, 0, -24, 36) / 20),
          ceiling: 10 ** (num(params.ceiling, 0, -40, 0) / 20),
          release: num(params.release, 0.1, 0.001, 2),
        }
        standIn.threshold.value = 20 * Math.log10(now.ceiling)
        push()
      },
      dispose() {
        gone = true
        for (const audio of [input, output, standIn, node]) audio?.disconnect()
        node = null
      },
    }
  },

  /** Delay one ear by a few milliseconds: the ear hears the other side first, and the sound spreads. */
  haas(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const split = new ChannelSplitterNode(ac, { numberOfOutputs: 2 })
    const merge = new ChannelMergerNode(ac, { numberOfInputs: 2 })
    const output = new GainNode(ac)
    const delay = new DelayNode(ac, { maxDelayTime: 0.05, delayTime: 0.015 })
    const dry = new GainNode(ac, { gain: 0 })
    const wet = new GainNode(ac, { gain: 1 })
    let side = null
    input.connect(split)
    merge.connect(output)
    const route = (delayed) => {
      split.disconnect()
      delay.disconnect(); dry.disconnect(); wet.disconnect()
      const straight = delayed === 1 ? 0 : 1
      split.connect(merge, straight, straight)
      split.connect(dry, delayed)
      split.connect(delay, delayed)
      delay.connect(wet)
      dry.connect(merge, 0, delayed)
      wet.connect(merge, 0, delayed)
    }
    return {
      input,
      output,
      set({ time, side: which, mix }) {
        const delayed = which === 'left' ? 0 : 1
        if (delayed !== side) { side = delayed; route(delayed) }
        smooth(delay.delayTime, time)
        smooth(wet.gain, mix)
        smooth(dry.gain, 1 - mix)
      },
      dispose() { for (const node of [input, split, merge, output, delay, dry, wet]) node.disconnect() },
    }
  },

  /**
   * The plain jobs a mixer channel does, as one 2 × 2 mix of left and right: pick or swap
   * the sides (or fold them to mono), set the width, flip a side's phase, then balance and
   * gain. Every step is a matrix, so together they're four gains.
   */
  utility(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const split = new ChannelSplitterNode(ac, { numberOfOutputs: 2 })
    const merge = new ChannelMergerNode(ac, { numberOfInputs: 2 })
    const cells = [[new GainNode(ac, { gain: 1 }), new GainNode(ac, { gain: 0 })], [new GainNode(ac, { gain: 0 }), new GainNode(ac, { gain: 1 })]]
    input.connect(split)
    for (let out = 0; out < 2; out++) {
      for (let from = 0; from < 2; from++) {
        split.connect(cells[out][from], from)
        cells[out][from].connect(merge, 0, out)
      }
    }
    const SOURCES = {
      stereo: [[1, 0], [0, 1]],
      mono: [[0.5, 0.5], [0.5, 0.5]],
      'left only': [[1, 0], [1, 0]],
      'right only': [[0, 1], [0, 1]],
      swap: [[0, 1], [1, 0]],
    }
    const times = (a, b) => [0, 1].map((r) => [0, 1].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c]))
    return {
      input,
      output: merge,
      set({ gain, width, pan, channels, phase }) {
        const w = Math.min(2, Math.max(0, Number.isFinite(width) ? width : 1))
        const widthM = [[(1 + w) / 2, (1 - w) / 2], [(1 - w) / 2, (1 + w) / 2]]
        const flipL = phase === 'flip left' || phase === 'flip both' ? -1 : 1
        const flipR = phase === 'flip right' || phase === 'flip both' ? -1 : 1
        const b = Math.min(1, Math.max(0, Number.isFinite(pan) ? pan : 0.5))
        const g = 10 ** (dbGain(gain) / 20)
        // balance turns the far side down; the near side stays where it is
        const out = [flipL * g * Math.min(1, 2 - 2 * b), flipR * g * Math.min(1, 2 * b)]
        const m = times(widthM, SOURCES[channels] ?? SOURCES.stereo)
        for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) smooth(cells[r][c].gain, out[r] * m[r][c])
      },
      dispose() { for (const node of [input, split, merge, ...cells.flat()]) node.disconnect() },
    }
  },

  /**
   * Mid/side width, plus a little decorrelated side made from a delayed copy of the mid so
   * mono sounds widen too (it cancels when summed to mono). Below "mono below" the side is
   * cut, which keeps the low end centred.
   */
  widener(ac) {
    const input = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const split = new ChannelSplitterNode(ac, { numberOfOutputs: 2 })
    const merge = new ChannelMergerNode(ac, { numberOfInputs: 2 })
    const output = new GainNode(ac)
    const g = (gain = 1) => new GainNode(ac, { gain })
    const mid = g(1)
    const side = g(1)
    const midL = g(0.5); const midR = g(0.5)
    const sideL = g(0.5); const sideR = g(-0.5)
    const width = g(1)
    const decorrelate = new DelayNode(ac, { maxDelayTime: 0.05, delayTime: 0.013 })
    const spread = g(0.3)
    const sideSum = g(1)
    const lowCut1 = new BiquadFilterNode(ac, { type: 'highpass', frequency: 120, Q: 0.707 })
    const lowCut2 = new BiquadFilterNode(ac, { type: 'highpass', frequency: 120, Q: 0.707 })
    const invert = g(-1)
    const left = g(1); const right = g(1)
    input.connect(split)
    split.connect(midL, 0); split.connect(midR, 1)
    split.connect(sideL, 0); split.connect(sideR, 1)
    midL.connect(mid); midR.connect(mid)
    sideL.connect(side); sideR.connect(side)
    side.connect(width).connect(sideSum)
    mid.connect(decorrelate).connect(spread).connect(sideSum)
    sideSum.connect(lowCut1).connect(lowCut2)
    mid.connect(left); mid.connect(right)
    lowCut2.connect(left)
    lowCut2.connect(invert).connect(right)
    left.connect(merge, 0, 0)
    right.connect(merge, 0, 1)
    merge.connect(output)
    const all = [input, split, merge, output, mid, side, midL, midR, sideL, sideR, width, decorrelate, spread, sideSum, lowCut1, lowCut2, invert, left, right]
    return {
      input,
      output,
      set({ width: w, spread: s, mono }) {
        smooth(width.gain, w)
        smooth(spread.gain, s * 0.6)
        smooth(lowCut1.frequency, mono)
        smooth(lowCut2.frequency, mono)
      },
      dispose() { for (const node of all) node.disconnect() },
    }
  },
}

/**
 * One insert of `kind`, on its own, for something other than an orbit's rack to use (an
 * instrument's lanes): { input, output, set(params), dispose() }, or null for an unknown kind.
 */
export function makeInsert(kind, ac = getAudioContext()) {
  const make = UNITS[kind]
  if (!make) return null
  const unit = make(ac)
  unit.kind = kind
  return unit
}
