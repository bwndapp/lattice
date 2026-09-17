/**
 * Phyllo's lanes outside the processor: for each summed lane (see dsp.js), its effects in
 * order, its level, and where it goes — another lane, or out. Out is the same place a note
 * of this instrument goes: its bus (orbit), after its post-gain, and into the sends it has
 * (each note's own level and pan are already on it, from the processor, before the lane's
 * effects), so the patch around it (inserts, sidechains, reverb and delay knobs) still
 * applies.
 *
 * Modulators reach in here too: the processor reports where each outside destination is
 * (lane effects' knobs, summed lanes' levels — see model.js globalTargets), and the rig
 * turns them, on the knob's travel the way routes work inside the voices.
 *
 * One rig per instrument per audio context (host.js makes it with the processor).
 */
import { applyGainCurve, getSuperdoughAudioController } from '@strudel/webaudio'
import { K, LANES, globalTargets, laneFxCatalog, lanesSummed, targetSpec } from './model.js'
import { makeLaneEffect } from '../laneFx.js'

const stereo = (ac, gain = 1) => new GainNode(ac, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
const glide = (param, value, ac) => { if (Number.isFinite(value)) param.setTargetAtTime(value, ac.currentTime, 0.01) }
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const toPos = (v, { min, max, log }) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min))
const fromPos = (t, { min, max, log }) => (log ? min * (max / min) ** t : min + t * (max - min))
/** A knob moved `by` along its travel. */
const moved = (value, def, by) => fromPos(clamp01(toPos(value, def) + by), def)

export function makeRig(ac, node, voices) {
  const lanes = Array.from({ length: LANES }, (_, q) => {
    const input = stereo(ac)
    const level = stereo(ac, 0)
    node.connect(input, voices + q)
    return { input, level, units: new Map(), chain: null, to: undefined }
  })
  // out: as a note would leave
  const out = stereo(ac)
  const gain = stereo(ac)
  const send = stereo(ac)
  out.connect(gain)
  gain.connect(send)
  let orbit = null
  let bus = null
  // the patch as last set, and what the modulators said last
  let patch = null
  let tempo = { beatSeconds: 0.5 }
  let targets = []
  let summedNow = [false, false, false]
  let offsets = []
  let wasMoved = new Set() // effects the modulators moved last time

  /**
   * Effects and summed lanes at their knobs plus what the modulators add. `movedOnly`: just
   * the effects the modulators move (or just stopped moving), as reports come in.
   */
  const apply = (movedOnly = false) => {
    if (!patch) return
    const byFx = new Map() // effect id → { knob: offset }
    const byLane = new Map() // lane → offset
    targets.forEach((target, i) => {
      const by = offsets[i]
      if (!by) return
      const t = targetSpec(patch, target)
      if (t?.fxId) {
        if (!byFx.has(t.fxId)) byFx.set(t.fxId, {})
        byFx.get(t.fxId)[t.knob] = (byFx.get(t.fxId)[t.knob] || 0) + by
      } else {
        const m = /^lane:(\d)\.gain$/.exec(target)
        if (m) byLane.set(Number(m[1]), (byLane.get(Number(m[1])) || 0) + by)
      }
    })
    patch.lanes.forEach((lane, q) => {
      const l = lanes[q]
      for (const e of lane.effects) {
        const unit = l.units.get(e.id)
        if (!unit) continue
        const mods = byFx.get(e.id)
        if (movedOnly && !mods && !wasMoved.has(e.id)) continue
        let data = e.data
        if (mods) {
          data = { ...e.data }
          const spec = unit.spec
          for (const [knob, by] of Object.entries(mods)) {
            const def = spec?.params.find((p) => p.key === knob)
            if (def) data[knob] = moved(data[knob] ?? def.def, def, by)
          }
        }
        try { unit.set(data, tempo) } catch (err) { console.warn('[phyllo] could not set an effect', err) }
      }
      const level = summedNow[q] && !lane.mute ? moved(lane.gain, K.gain, byLane.get(q) || 0) : 0
      glide(l.level.gain, level, ac)
    })
    wasMoved = new Set(byFx.keys())
  }

  /** Wire a lane: input → its effects that are on → level → where it goes. */
  const wire = (q, lane, summed) => {
    const l = lanes[q]
    const on = summed ? lane.effects.filter((e) => e.on) : []
    const chain = on.map((e) => `${e.id}:${e.type}`).join('|')
    if (chain !== l.chain) {
      l.chain = chain
      l.input.disconnect()
      for (const unit of l.units.values()) { try { unit.output.disconnect() } catch { /* gone */ } }
      let from = l.input
      for (const e of on) {
        const unit = l.units.get(e.id)
        if (!unit) continue
        from.connect(unit.input)
        from = unit.output
      }
      from.connect(l.level)
    }
    const to = lane.out === 'master' ? 'master' : lane.out
    if (to !== l.to) {
      l.to = to
      l.level.disconnect()
      l.level.connect(to === 'master' ? out : lanes[to].input)
    }
  }

  return {
    /** The patch's lanes changed (or a knob on one of their effects). */
    update({ data, cps = 0.5, beats = 4 }) {
      const summed = lanesSummed(data.lanes)
      tempo = { beatSeconds: 1 / (Math.max(0.01, cps) * Math.max(1, beats)) }
      patch = data
      summedNow = summed
      const nextTargets = globalTargets(data)
      if (nextTargets.join('|') !== targets.join('|')) { targets = nextTargets; offsets = [] }
      data.lanes.forEach((lane, q) => {
        const l = lanes[q]
        // effects made, kept or dropped by id; bypassed ones stay made, just not wired
        const keep = new Set(lane.effects.map((e) => e.id))
        for (const [id, unit] of l.units) {
          if (!keep.has(id) || unit.type !== lane.effects.find((e) => e.id === id)?.type) { unit.dispose(); l.units.delete(id); l.chain = null }
        }
        for (const e of lane.effects) {
          let unit = l.units.get(e.id)
          if (!unit) {
            unit = makeLaneEffect(e.type, ac)
            if (!unit) continue
            unit.type = e.type
            unit.spec = laneFxCatalog()?.spec(e.type)
            l.units.set(e.id, unit)
            l.chain = null
          }
        }
        wire(q, lane, summed[q])
      })
      apply()
    },
    /** Where the modulators have the outside destinations now (the processor's report). */
    modulate(values) {
      if (!Array.isArray(values)) return
      offsets = values
      apply(true)
    },
    /** A note is starting: out goes where it goes. */
    target(value) {
      let controller
      try { controller = getSuperdoughAudioController() } catch { return }
      const next = controller.getOrbit(num(value.orbit, 1))
      if (next !== orbit) {
        gain.disconnect()
        gain.connect(send)
        if (next?.summingNode) gain.connect(next.summingNode)
        orbit = next
      }
      const busId = value.bus ?? null
      if (busId !== bus) {
        send.disconnect()
        if (busId != null) { const node = controller.getBus(busId); if (node) send.connect(node) }
        bus = busId
      }
      glide(send.gain, applyGainCurve(num(value.busgain, 1)), ac)
      // each note's own level and pan are applied in the processor, voice by voice; what's
      // left here is what Strudel applies after them
      glide(gain.gain, applyGainCurve(num(value.postgain, 1)), ac)
    },
    dispose() {
      for (const l of lanes) {
        for (const unit of l.units.values()) unit.dispose()
        for (const n of [l.input, l.level]) { try { n.disconnect() } catch { /* gone */ } }
      }
      for (const n of [out, gain, send]) { try { n.disconnect() } catch { /* gone */ } }
    },
  }
}
