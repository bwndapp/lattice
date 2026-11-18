/**
 * Tuning systems: equal temperament at any A4, Pythagorean and just intonation on a root.
 * The root stays where equal temperament has it; every other note is a pure ratio from it,
 * in every octave; and notes written as frequencies are tuned the same way.
 */
import assert from 'node:assert/strict'
import { setTuning, tuned, freqOf } from '../src/tuning.js'

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, b), `${msg}: ${a} vs ${b}`)
const hz = (note) => tuned({ note }).freq

setTuning(440)
assert.deepEqual(tuned({ note: 'a4' }), { note: 'a4' }, 'equal at 440 leaves notes alone')
setTuning(432)
close(hz('a4'), 432, 'A4 follows the track')

// Pythagorean on C, at 440
setTuning(440, 'pythagorean', 0)
const c4 = 440 * 2 ** (-9 / 12)
close(hz('c4'), c4, 'the root stays where equal temperament has it')
close(hz('g4') / hz('c4'), 3 / 2, 'a pure fifth')
close(hz('f4') / hz('c4'), 4 / 3, 'a pure fourth')
close(hz('e4') / hz('c4'), 81 / 64, 'a Pythagorean third')
close(hz('d5') / hz('c4'), 2 * 9 / 8, 'and the same an octave up')
close(hz('g2') / hz('c2'), 3 / 2, 'and down')

// just intonation on A
setTuning(440, 'just', 9)
close(hz('a4'), 440, 'its root, A, at 440')
close(hz('c#5') / hz('a4'), 5 / 4, 'a pure major third')
close(hz('c5') / hz('a4'), 6 / 5, 'a pure minor third')
close(hz('e5') / hz('a4'), 3 / 2, 'a pure fifth')
close(hz('a3'), 220, 'octaves of the root stay put')

// a note written as a frequency is tuned as the note it is; a bend keeps its bend
close(tuned({ freq: 440 * 2 ** (4 / 12) }).freq / 440, 5 / 4, 'a frequency on C# is tuned as C#')
close(freqOf(73.3) / freqOf(73), 2 ** (0.3 / 12), 'a bent note keeps its bend from the tuned note')

// A4 moves the whole tuning with it
setTuning(432, 'just', 9)
close(hz('e5') / 432, 3 / 2, 'the ratios hold at another A4')

// drums with no note are left alone, in any tuning
assert.deepEqual(tuned({ s: 'bd' }), { s: 'bd' }, 'a drum hit keeps its pitch')
setTuning(440)
console.log('tuning ok')
