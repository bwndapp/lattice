import { asPattern, code, normalize, parts } from './model.js'

/** The Fibonacci machine: four loops of Fibonacci lengths (see model.js; FibPanel.jsx is its window). */
export default {
  type: 'fib',
  label: 'fibonacci',
  blurb: 'Four drum loops 5, 8, 13 and 21 steps long, with Fibonacci hits — they drift against each other, so the groove keeps turning',
  layers: ['one', 'two', 'three', 'four'],
  normalize,
  code,
  parts,
  asPattern,
  width: 800,
}
