/**
 * The app's own bus effects (stereo.js, fxbus.js), made for an instrument's lane: every
 * effect is { input, output, set(data, tempo), dispose() }, set from the same data an fx
 * rack unit keeps (graph.js). Reverb and delay are sends in the app, so here they get a dry
 * path beside them and their amount is the wet level.
 */
import { LANE_FX, NODE_TYPES, cleanData, defaultData, laneFxParams } from '../graph.js'
import { makeInsert } from '../stereo.js'
import { makeSendEffect } from '../fxbus.js'

const stereo = (ac, gain = 1) => new GainNode(ac, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })

export { LANE_FX }

/** What a lane's patch model needs to know about these effects (see syrup/model.js). */
export const LANE_FX_CATALOG = {
  types: LANE_FX,
  spec: (type) => NODE_TYPES[type],
  clean: (type, data) => cleanData(type, data),
  defaults: (type) => defaultData(type),
}

export function makeLaneEffect(type, ac) {
  if (!LANE_FX.includes(type)) return null
  if (type === 'reverb' || type === 'delay') {
    const input = stereo(ac)
    const output = stereo(ac)
    input.connect(output) // the dry sound
    let wet = null
    return {
      input,
      output,
      set(data, tempo) {
        const params = laneFxParams(type, data, tempo)
        if (!wet) {
          wet = makeSendEffect(type, ac, params)
          input.connect(wet.input)
          wet.output.connect(output)
        } else wet.set(params)
      },
      dispose() {
        try { input.disconnect(); output.disconnect() } catch { /* gone */ }
        wet?.destroy()
      },
    }
  }
  const unit = makeInsert(NODE_TYPES[type].code.insert.kind, ac)
  if (!unit) return null
  return {
    input: unit.input,
    output: unit.output,
    set(data, tempo) { unit.set(laneFxParams(type, data, tempo)) },
    dispose() { unit.dispose() },
  }
}
