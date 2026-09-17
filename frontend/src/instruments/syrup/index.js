import { SYRUP_DSP } from './dsp.js'
import { AUDIO_PARAMS, encodePatch, globalTargets, knobAt, normalizePatch, patchMessage, registerLaneFx, LANES } from './model.js'
import { makeRig } from './rig.js'
import { LANE_FX_CATALOG } from '../laneFx.js'

// a lane's effects are the app's own bus effects
registerLaneFx(LANE_FX_CATALOG)

/**
 * Syrup: a layered polysynth (see model.js for the patch, dsp.js for the sound,
 * SyrupPanel.jsx for its window).
 */
export default {
  type: 'syrup',
  label: 'syrup',
  blurb: 'A layered synth: analog, supersaw, wavetable and noise, with envelopes and LFOs to move it',
  kinds: ['synth'],
  processor: 'lattice-syrup',
  voices: 8,
  extraOutputs: LANES, // the summed lanes, for their effects (rig.js)
  rig: makeRig,
  // its rig follows modulators, so an export pauses often enough to keep up
  needsTicks: (patch) => globalTargets(patch).length > 0,
  voicesFor: (patch) => (patch.mono ? 1 : 8),
  oneShot: false,
  keyOctave: 3,
  width: 1320,
  params: [],
  groups: [],
  audioParams: AUDIO_PARAMS,
  normalize: normalizePatch,
  encode: encodePatch,
  message: patchMessage,
  knobAt,
  // the release falls to silence in a little under twice its time
  tail: (patch) => patch.amp.release * 2 + 0.05,
  dsp: SYRUP_DSP,
}
