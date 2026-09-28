// node frontend/test/knob.test.mjs — the arithmetic knobs turn by (knobMath.js)
import assert from 'node:assert/strict'
import { NOTCH_PX, dragTo, pastThreshold, snapValue, startDrag, stepOf, wheelPixels, wheelTravel } from '../src/knobMath.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

// the wheel: pixels, lines (Firefox, three a click) and pages all come out as pixels
assert.equal(wheelPixels({ deltaY: 100 }), 100)
near(wheelPixels({ deltaY: 3, deltaMode: 1 }), NOTCH_PX)
assert.equal(wheelPixels({ deltaY: 1, deltaMode: 2 }), 3 * NOTCH_PX) // capped at three clicks
assert.equal(wheelPixels({ deltaY: -5000 }), -3 * NOTCH_PX)
assert.equal(wheelPixels({ deltaX: 40, deltaY: 2 }), 40) // sideways (shift + wheel) counts
// a click turns about 1.5% (down is less), fine a fifth of that, a stepped knob a step
near(wheelTravel(NOTCH_PX), -0.015)
near(wheelTravel(-NOTCH_PX, { fine: true }), 0.003)
near(wheelTravel(-NOTCH_PX, { step: 0.25 }), 0.25)
// a trackpad's small deltas add up to the same as one click
let pos = 0.5
for (let i = 0; i < 50; i++) pos += wheelTravel(-2)
near(pos, 0.515)

// a knob in steps: a choice is a whole index, whatever was stored; stepped knobs land on a step
const choice = { min: 0, max: 4, def: 0, choices: ['a', 'b', 'c', 'd', 'e'] }
assert.equal(snapValue(1.37, choice), 1)
assert.equal(snapValue(3.6, choice), 4)
assert.equal(snapValue(9, choice), 4)
near(stepOf(choice), 0.25)
assert.equal(snapValue(0.37, { min: 0, max: 1, step: 0.25 }), 0.25)
assert.equal(stepOf({ min: 20, max: 20000, log: true }), 0)
assert.equal(snapValue(0.123456, { min: 0, max: 1 }), 0.123)
assert.equal(snapValue(1234.567, { min: 20, max: 20000, log: true }), 1234.57)

// dragging: 150px is the whole travel, 600 with shift; a few pixels is still a click
const d = startDrag(100, 100, 0.5)
assert.equal(pastThreshold(d, 101, 98), false)
assert.equal(pastThreshold(d, 100, 97), true)
near(dragTo(d, 100, 70, false, 0.5), 0.7) // 30px up
// shift pressed mid-drag: carries on from where it is, then moves a quarter as fast
near(dragTo(d, 100, 70, true, 0.7), 0.7)
near(dragTo(d, 100, 10, true, 0.7), 0.8)
// and let go of shift again: no jump back to the coarse line
near(dragTo(d, 100, 10, false, 0.8), 0.8)
near(dragTo(d, 100, -5, false, 0.8), 0.9)

console.log('knob ok')
