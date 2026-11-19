/**
 * The a/b mix: two inputs, one knob, equal power. At 0 it's all A, at 1 all B, in the middle
 * both at about -3 dB each (so the crossfade doesn't dip); and both land on one bus.
 */
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'

const m = await bundle({ 'project.js': ['normalizeProject', 'generateCode'] }, 'blendtest')
const project = (mix) => m.normalizeProject({
  bpm: 120, beats: 4,
  patterns: [
    { id: 'A', name: 'a', bars: 1, stepsPerBar: 16, channels: [{ id: 'x', kind: 'drum', name: 'kick', sound: 'bd', steps: [1, 0, 0, 0] }] },
    { id: 'B', name: 'b', bars: 1, stepsPerBar: 16, channels: [{ id: 'y', kind: 'drum', name: 'hat', sound: 'hh', steps: [0, 0, 1, 0] }] },
  ],
  nodes: [
    { id: 'pa', type: 'pattern', x: 0, y: 0, data: { patternId: 'A' } },
    { id: 'pb', type: 'pattern', x: 0, y: 0, data: { patternId: 'B' } },
    { id: 'bl', type: 'blend', x: 0, y: 0, data: { mix } },
    { id: 'o', type: 'output', x: 0, y: 0, data: {} },
  ],
  edges: [{ source: 'pa', target: 'bl', targetHandle: 'in-0' }, { source: 'pb', target: 'bl', targetHandle: 'in-1' }, { source: 'bl', target: 'o', targetHandle: 'in-0' }],
})
// the gain each side's notes get, read out of the code as the app writes it
const gains = (mix) => {
  const line = m.generateCode(project(mix)).split('\n').find((l) => l.startsWith('const n_bl = '))
  const fns = [...line.matchAll(/\.fmap\(\(v\) => \(\{ \.\.\.v, gain: \(v\.gain \?\? 1\) \* (Math\.(?:cos|sin)\([^)]*\)\) \* Math\.PI \/ 2\)) \}\)\)/g)].map((x) => x[1])
  return fns.map((f) => new Function(`return ${f}`)())
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`)
let [a, b] = gains(0)
near(a, 1, 'at 0: all A'); near(b, 0, 'and no B')
;[a, b] = gains(1)
near(a, 0, 'at 1: no A'); near(b, 1, 'all B')
;[a, b] = gains(0.5)
near(a * a + b * b, 1, 'in the middle: equal power (no dip)')
near(a, Math.SQRT1_2, 'each at -3 dB')
assert.match(m.generateCode(project(0.5)).split('\n').find((l) => l.startsWith('const n_bl = ')), /\.orbit\(\d+\).*\.orbit\(\d+\)/, 'both on one bus')
console.log('a/b mix ok')
