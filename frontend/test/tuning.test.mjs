// node frontend/test/tuning.test.mjs — global tuning: every pitched note moves to the track's A4
import assert from 'node:assert/strict'
import { setTuning, tuned } from '../src/tuning.js'

setTuning(440)
const v = { note: 'a4', s: 'piano' }
assert.equal(tuned(v), v, 'at 440 nothing changes')
setTuning(432)
assert.ok(Math.abs(tuned({ note: 'a4' }).freq - 432) < 1e-9, 'a4 sits at the tuning')
assert.equal(tuned({ note: 'a4' }).note, undefined, 'the note becomes a frequency')
assert.ok(Math.abs(tuned({ note: 57 }).freq - 216) < 1e-9, 'numbers too: a3 an octave down')
assert.ok(Math.abs(tuned({ note: 'c#3' }).freq - 432 * 2 ** ((49 - 69) / 12)) < 1e-9, 'sharps')
assert.ok(Math.abs(tuned({ note: 'eb3' }).freq - 432 * 2 ** ((51 - 69) / 12)) < 1e-9, 'flats')
assert.ok(Math.abs(tuned({ freq: 220 }).freq - 216) < 1e-9, 'a frequency moves by the same ratio')
const drum = { s: 'bd', n: 2 }
assert.equal(tuned(drum), drum, 'a drum hit with no note keeps its pitch')
assert.equal(tuned({ s: 'sd', n: 3, note: 'a4' }).n, 3, 'a sample number stays')
setTuning(9999)
assert.ok(Math.abs(tuned({ note: 'a4' }).freq - 480) < 1e-9, 'clamped to the range')
setTuning(440)
console.log('tuning ok')
