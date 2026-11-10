// node frontend/test/fib.test.mjs — the Fibonacci machine: its rhythms, its drift, and a sound played on a loop
import assert from 'node:assert/strict'
import { evenRhythm, goldenRhythm, layerSteps, normalize, parts, roll } from '../src/abstract/fib/model.js'

assert.equal(evenRhythm(3, 8).join(''), '10010010', '3 in 8 is the tresillo')
assert.equal(goldenRhythm(13).join(''), '1011010110110', 'the Fibonacci word')
const s = normalize(null)
assert.deepEqual(normalize(JSON.parse(JSON.stringify(s))), s)
assert.equal(layerSteps(s.layers[0]).filter(Boolean).length, 3)
assert.equal(layerSteps(s.layers[0])[0], 2, 'the loop\'s first hit is accented')
// drift: each loop in sixteenths, its own length
assert.match(parts(s)[0].expr, /^s\("\{bd ~ ~ bd ~ ~ bd ~\}%16"\)/)
// bar: squeezed into one bar
assert.match(parts({ ...s, timing: 'bar' })[1].expr, /^s\("~ sd ~ sd ~"\)/)
// a sound on a loop's rhythm, and nothing from a muted loop
assert.equal(parts(s)[0].drive('n_m'), 'n_m.struct("{t ~ ~ t ~ ~ t ~}%16").velocity("{1 0 0 0.7 0 0 0.7 0}%16")')
assert.equal(parts({ ...s, layers: s.layers.map((l) => ({ ...l, mute: true })) })[0].drive('n_m'), null)
// junk in, a working machine out; a roll stays Fibonacci
const junk = normalize({ layers: [{ steps: 7, hits: 99, mode: 'weird', sound: 'bd"); x(' }], timing: 'sideways' })
assert.equal(junk.layers[0].steps, 8); assert.ok(junk.layers[0].hits <= 8); assert.equal(junk.timing, 'drift')
assert.ok(!junk.layers[0].sound.includes('"'))
for (const l of roll(s).layers) { assert.ok([3, 5, 8, 13, 21].includes(l.steps)); assert.ok(l.hits < l.steps) }
console.log('fib ok')
