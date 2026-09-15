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

const smooth = (param, value) => {
  if (Number.isFinite(value)) param.setTargetAtTime(value, getAudioContext().currentTime, 0.02)
}

const UNITS = {
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
