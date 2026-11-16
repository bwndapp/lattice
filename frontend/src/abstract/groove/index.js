import { asPattern, code, normalize, parts } from './model.js'

/** The groove engine: a drummer that knows styles (see model.js; GroovePanel.jsx is its window). */
export default {
  type: 'groove',
  label: 'groove',
  blurb: 'A drummer that knows styles: pick house, breaks, funk, trap… turn density, swing, ghosts and fills, and roll for a new groove',
  layers: ['kick', 'snare', 'hats', 'perc'],
  normalize,
  code,
  parts,
  asPattern,
  width: 820,
}
