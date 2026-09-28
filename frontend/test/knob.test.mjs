// node frontend/test/knob.test.mjs — the arithmetic knobs turn by (knobMath.js)
import assert from 'node:assert/strict'
import { NOTCH_PX, wheelPixels, wheelTravel } from '../src/knobMath.js'

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

console.log('knob ok')
