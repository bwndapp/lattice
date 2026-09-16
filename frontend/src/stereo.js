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

/** First orbit handed to stereo inserts (sidechains use 2 and up; Strudel's default is 1). */
export const STEREO_ORBIT_BASE = 40

let declared = new Map() // orbit → [{ key, kind, params }] from the latest generated code
let routed = new Map() // orbit → the orbit it plays into (a mixer bus), instead of the speakers
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

/** Send everything on one orbit into another (a mixer bus) instead of the speakers. */
export function declareRoute(list, from, to) {
  if (!list.inserts.has(from)) list.inserts.set(from, [])
  list.routes.set(from, to)
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
  if (!navigator.userActivation?.hasBeenActive) {
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
  const rack = { orbit, input, output, units: new Map(), order: null, channels, to: undefined }
  racks.set(n, rack)
  wire(n, rack, declared.get(n) ?? [])
  aim(n, rack)
}

/** Point a rack at the speakers, or into the mixer bus its orbit is routed to. */
function aim(n, rack) {
  const to = routed.get(n) ?? null
  if (rack.to === to) return
  rack.output.disconnect()
  if (to != null && to !== n) rack.output.connect(controller.getOrbit(to).summingNode)
  else controller.output.connectToDestination(rack.output, rack.channels)
  rack.to = to
}

function teardown(n) {
  const rack = racks.get(n)
  if (!rack) return
  for (const unit of rack.units.values()) unit.dispose()
  try { rack.input.disconnect(); rack.output.disconnect() } catch { /* already gone */ }
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

const HEADROOM = 4 // a bus can run hotter than one note, so the curve covers +12 dB
const CURVE_POINTS = 8192

/** A lookup table for one curve at one drive, over the range the bus can reach. */
function curveTable(shape, k) {
  const table = new Float32Array(CURVE_POINTS)
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (-1 + (2 * i) / (CURVE_POINTS - 1)) * HEADROOM
    const y = shape(x, k)
    table[i] = Number.isFinite(y) ? Math.min(1, Math.max(-1, y)) : 0
  }
  return table
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
        const drive = Math.min(8, Math.max(0, Number(params.drive) || 0))
        // the table only changes when the shape or the drive does, not on every frame
        const want = `${curve}:${Math.round(drive * 200)}`
        if (want !== made) {
          made = want
          shape.curve = curveTable(CURVES[curve], drive)
        }
        smooth(output.gain, Number.isFinite(params.out) ? params.out : 1)
      },
      dispose() { for (const node of [input, shape, output]) node.disconnect() },
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
