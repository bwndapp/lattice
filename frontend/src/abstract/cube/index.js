import { asPattern, code, normalize, pack, parts } from './model.js'

/** The cube: a twisty-puzzle drum machine (see model.js; CubePanel.jsx is its window). */
export default {
  type: 'cube',
  label: 'cube',
  blurb: 'A drum machine you twist: four drums ringed round a 4×4×4 cube — scramble it for a new groove',
  normalize,
  pack,
  code,
  parts,
  asPattern,
  width: 760,
}
