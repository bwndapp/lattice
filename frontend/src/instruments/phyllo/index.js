import { PHYLLO_DSP } from './dsp.js'
import { AUDIO_PARAMS, encodePatch, knobAt, normalizePatch, patchMessage } from './model.js'

/**
 * Phyllo: a layered polysynth (see model.js for the patch, dsp.js for the sound,
 * PhylloPanel.jsx for its window).
 */
export default {
  type: 'phyllo',
  label: 'phyllo',
  blurb: 'A layered synth: analog, supersaw, wavetable and noise, with envelopes and LFOs to move it',
  kinds: ['synth'],
  processor: 'lattice-phyllo',
  voices: 8,
  voicesFor: (patch) => (patch.mono ? 1 : 8),
  oneShot: false,
  keyOctave: 3,
  width: 1180,
  params: [],
  groups: [],
  audioParams: AUDIO_PARAMS,
  normalize: normalizePatch,
  encode: encodePatch,
  message: patchMessage,
  knobAt,
  // the release falls to silence in a little under twice its time
  tail: (patch) => patch.amp.release * 2 + 0.05,
  dsp: PHYLLO_DSP,
}
