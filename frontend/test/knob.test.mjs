// node frontend/test/knob.test.mjs — the arithmetic knobs turn by (knobMath.js)
import assert from 'node:assert/strict'
import { NOTCH_PX, detent, dragTo, lockAxis, parseKnobValue, pastThreshold, undetent, snapValue, startDrag, stepOf, wheelPixels, wheelTravel } from '../src/knobMath.js'

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

// either way: whichever way the pointer set off, right or up adds
const side = startDrag(0, 0, 0.5)
lockAxis(side, 6, 1)
near(dragTo(side, 30, 50, false, 0.5), 0.7) // 30px right; the drift down doesn't count
const upward = startDrag(0, 0, 0.5)
lockAxis(upward, 1, -6)
near(dragTo(upward, 40, -30, false, 0.5), 0.7)
// pushing past the end and coming back turns it straight away
const end = startDrag(0, 0, 0.9)
assert.equal(dragTo(end, 0, -60, false, 0.9), 1)
near(dragTo(end, 0, -45, false, 1), 0.9)

// a knob that goes either way catches gently at its centre, and still reaches both ends
assert.equal(detent(0.52, 0.5), 0.5)
assert.equal(detent(0.47, 0.5), 0.5)
assert.equal(detent(1, 0.5), 1)
assert.equal(detent(0, 0.5), 0)
near(detent(0.6, 0.5), 0.5 + 0.06 * 0.5 / 0.46)
near(detent(0.9, 2 / 3), detent(0.9, 2 / 3)) // off-centre origins too (a cut or boost)
for (const c of [0.5, 2 / 3, 0.25]) for (const q of [0, 0.1, 0.3, c, 0.7, 0.95, 1]) near(detent(undetent(q, c), c), q)

// typing a value: units are optional and read the way the knob shows them
const hz = { key: 'cutoff', label: 'cutoff', min: 20, max: 20000, log: true, unit: 'hz' }
assert.equal(parseKnobValue('2k', hz), 2000)
assert.equal(parseKnobValue('2 kHz', hz), 2000)
assert.equal(parseKnobValue('2khz', hz), 2000)
assert.equal(parseKnobValue('440', hz), 440)
assert.equal(parseKnobValue('440ms', hz), null)
const db = { key: 'gain', label: 'gain', min: -36, max: 24, unit: 'db' }
assert.equal(parseKnobValue('-6db', db), -6)
assert.equal(parseKnobValue('-6 dB', db), -6)
const level = { key: 'gain', label: 'level', min: 0, max: 1.5 } // stored as a gain
near(parseKnobValue('-6 dB', level), 10 ** (-6 / 20))
near(parseKnobValue('0db', level), 1)
assert.equal(parseKnobValue('-6db', { key: 'cutoff', label: 'tone', min: 0, max: 1 }), null) // not a level
const time = { key: 'release', label: 'release', min: 0.001, max: 2, unit: 's' }
assert.equal(parseKnobValue('250ms', time), 0.25)
assert.equal(parseKnobValue('1.5s', time), 1.5)
assert.equal(parseKnobValue('1,5 s', time), 1.5)
assert.equal(parseKnobValue('250', time), 0.25) // more than it goes to: ms
const unit = { key: 'mix', label: 'mix', min: 0, max: 1 }
assert.equal(parseKnobValue('40%', unit), 0.4)
assert.equal(parseKnobValue('40', unit), 0.4) // a 0…1 knob shows 40 for 0.4
assert.equal(parseKnobValue('-25%', { key: 'amt', label: 'amount', min: -1, max: 1, unit: 'bi' }), -0.25)
const pan = { key: 'pan', label: 'pan', min: 0, max: 1 }
assert.equal(parseKnobValue('C', pan), 0.5)
assert.equal(parseKnobValue('L50', pan), 0.25)
assert.equal(parseKnobValue('r100', pan), 1)
assert.equal(parseKnobValue('-50', pan), 0.25)
assert.equal(parseKnobValue('tube', { key: 'dtype', label: 'type', min: 0, max: 4, choices: ['soft', 'hard', 'tube'] }), 2)
assert.equal(parseKnobValue('4/16', { key: 'time', label: 'time', min: 0, max: 1, unit: 'bar' }), 0.25)
assert.equal(parseKnobValue('4:1', { key: 'ratio', label: 'ratio', min: 1, max: 20, unit: 'ratio' }), 4)
assert.equal(parseKnobValue('', unit), null)
assert.equal(parseKnobValue('loud', unit), null)

console.log('knob ok')
