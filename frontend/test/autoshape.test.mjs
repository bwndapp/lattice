/**
 * Automation segment shapes: a segment can be a tensioned curve (as before), a bezier with
 * two handles, a hold, stairs, or n cycles of sine, triangle, saw or square between its two
 * points' values. They're saved with the track, and old curves read as they did.
 */
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'

const m = await bundle({ 'automation.js': ['curveAt', 'normalizeAutos', 'pointRow'] }, 'autoshape')
const at = (points, x) => m.curveAt({ bars: 1, points }, x)
const near = (a, b, msg, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`)

// a plain curve, as before
near(at([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.5), 0.5, 'straight is straight')
near(at([{ x: 0, y: 0, c: 1 }, { x: 1, y: 1 }], 0.5), 0.5 ** 8, 'tension bends it, as it did')

// waves between the two points' values, n times
const sine = [{ x: 0, y: 0.2, m: 'sine', n: 2 }, { x: 1, y: 0.8 }]
near(at(sine, 0), 0.2, 'a sine starts at its first point')
near(at(sine, 0.125), 0.5, 'halfway up a quarter-cycle in')
near(at(sine, 0.25), 0.8, 'at the top half a cycle in')
near(at(sine, 0.5), 0.2, 'and back down: two cycles in the segment')
near(at([{ x: 0, y: 0, m: 'triangle', n: 1 }, { x: 1, y: 1 }], 0.25), 0.5, 'a triangle climbs straight')
near(at([{ x: 0, y: 0, m: 'saw', n: 4 }, { x: 1, y: 1 }], 0.375), 0.5, 'a saw ramps each cycle')
near(at([{ x: 0, y: 0, m: 'square', n: 2 }, { x: 1, y: 1 }], 0.3), 1, 'a square is up for its second half')
near(at([{ x: 0, y: 0, m: 'square', n: 2 }, { x: 1, y: 1 }], 0.1), 0, 'and down for its first')
assert.deepEqual([0, 0.3, 0.6, 0.9].map((x) => +at([{ x: 0, y: 0, m: 'stairs', n: 4 }, { x: 1, y: 1 }], x).toFixed(3)), [0, 0.333, 0.667, 1], 'stairs: four steps, first point to last')
near(at([{ x: 0, y: 0.3, m: 'hold' }, { x: 1, y: 0.9 }], 0.99), 0.3, 'hold stays put until the next point')

// bezier: handles hang off the points, in value, so a flat segment can still bow
const ease = [{ x: 0, y: 0, m: 'bezier', h: [0.4, 0, 0.6, 0] }, { x: 1, y: 1 }]
near(at(ease, 0.5), 0.5, 'an ease in-out passes the middle')
assert.ok(at(ease, 0.15) < 0.15 && at(ease, 0.85) > 0.85, 'easing in and out')
const bump = [{ x: 0, y: 0.5, m: 'bezier', h: [0.33, 0.4, 0.67, 0.4] }, { x: 1, y: 0.5 }]
assert.ok(at(bump, 0.5) > 0.75, 'a flat segment bows up with its handles raised')
near(at(bump, 0), 0.5, 'and still starts on its point')
// moving the points keeps the shape: the handles go with them
const moved = [{ x: 0, y: 0.1, m: 'bezier', h: [0.33, 0.4, 0.67, 0.4] }, { x: 1, y: 0.1 }]
near(at(moved, 0.5) - 0.1, at(bump, 0.5) - 0.5, 'move both points and the bow moves with them')
assert.ok(at([{ x: 0, y: 0.9, m: 'bezier', h: [0.3, 1, 0.7, 1] }, { x: 1, y: 0.9 }], 0.5) <= 1, 'never past the top')

// saved and read back
const [a] = m.normalizeAutos([{ id: 'a', target: 'x:y', bars: 2, points: [{ x: 0, y: 0, m: 'sine', n: 3 }, { x: 1, y: 1, m: 'bezier', h: [0.5, 0.2, 0.5, -0.2] }, { x: 2, y: 0, m: 'warp' }] }], { nodes: [], patterns: [] })
assert.deepEqual(a.points[0], { x: 0, y: 0, m: 'sine', n: 3 }, 'a sine keeps its cycles')
assert.deepEqual(a.points[1].h, [0.5, 0.2, 0.5, -0.2], 'a bezier keeps its handles')
assert.equal(a.points[2].m, undefined, 'a mode it doesn\'t know is a plain curve')
console.log('automation shapes ok')
