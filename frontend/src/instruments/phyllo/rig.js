/**
 * Phyllo's lanes outside the processor: for each summed lane (see dsp.js), its effects in
 * order, its level, and where it goes — another lane, or out. Out is the same place a note
 * of this instrument goes: its bus (orbit), at the instrument's level and pan, and into the
 * sends it has, so the patch around it (inserts, sidechains, reverb and delay knobs) still
 * applies.
 *
 * One rig per instrument per audio context (host.js makes it with the processor).
 */
import { applyGainCurve, getSuperdoughAudioController } from '@strudel/webaudio'
import { LANES, lanesSummed } from './model.js'
import { makeLaneEffect } from '../laneFx.js'

const stereo = (ac, gain = 1) => new GainNode(ac, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
const glide = (param, value, ac) => { if (Number.isFinite(value)) param.setTargetAtTime(value, ac.currentTime, 0.01) }
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

export function makeRig(ac, node, voices) {
  const lanes = Array.from({ length: LANES }, (_, q) => {
    const input = stereo(ac)
    const level = stereo(ac, 0)
    node.connect(input, voices + q)
    return { input, level, units: new Map(), chain: null, to: undefined }
  })
  // out: as a note would leave
  const out = stereo(ac)
  const pan = new StereoPannerNode(ac)
  const gain = stereo(ac)
  const send = stereo(ac)
  out.connect(pan).connect(gain)
  gain.connect(send)
  let orbit = null
  let bus = null

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
      const tempo = { beatSeconds: 1 / (Math.max(0.01, cps) * Math.max(1, beats)) }
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
            l.units.set(e.id, unit)
            l.chain = null
          }
          try { unit.set(e.data, tempo) } catch (err) { console.warn('[phyllo] could not set an effect', err) }
        }
        glide(l.level.gain, summed[q] && !lane.mute ? lane.gain : 0, ac)
        wire(q, lane, summed[q])
      })
    },
    /** A note is starting: out goes where it goes, at its level and pan. */
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
      glide(gain.gain, applyGainCurve(num(value.gain, 0.8)) * applyGainCurve(num(value.postgain, 1)), ac)
      glide(pan.pan, value.pan == null ? 0 : Math.max(-1, Math.min(1, num(value.pan, 0.5) * 2 - 1)), ac)
    },
    dispose() {
      for (const l of lanes) {
        for (const unit of l.units.values()) unit.dispose()
        for (const n of [l.input, l.level]) { try { n.disconnect() } catch { /* gone */ } }
      }
      for (const n of [out, pan, gain, send]) { try { n.disconnect() } catch { /* gone */ } }
    },
  }
}
