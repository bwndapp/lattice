import { MAX_LAYERS, asPattern, code, normalize, parts } from './model.js'

/** The Fibonacci machine: four loops of Fibonacci lengths (see model.js; FibPanel.jsx is its window). */
export default {
  type: 'fib',
  label: 'fibonacci',
  blurb: 'Four drum loops 5, 8, 13 and 21 steps long, with Fibonacci hits — they drift against each other, so the groove keeps turning',
  // an input per layer, as many as it can have; the node shows the ones it has
  layers: Array.from({ length: MAX_LAYERS }, (_, i) => String(i + 1)),
  normalize,
  code,
  parts,
  asPattern,
  width: 880,
}
