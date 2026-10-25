// node frontend/test/roll.test.mjs — a drum row's random roll: the right length, never empty, leaning the right way
import assert from 'node:assert/strict'
import { drumRole, rollSteps } from '../src/roll.js'

assert.equal(drumRole({ sound: 'bd' }), 'kick')
assert.equal(drumRole({ sound: 'cp' }), 'snare')
assert.equal(drumRole({ sound: 'hh' }), 'hat')
assert.equal(drumRole({ sound: 'oh' }), 'open')
assert.equal(drumRole({ sound: 'lt', name: 'low tom' }), 'perc')

// spans every bar, in steps of 0 and 1
const s = rollSteps({ sound: 'hh' }, { bars: 3, stepsPerBar: 12, beats: 4 })
assert.equal(s.length, 36)
assert.ok(s.every((v) => v === 0 || v === 1))

// never empty, even when every chance misses
assert.deepEqual(rollSteps({ sound: 'bd' }, { bars: 1, stepsPerBar: 4 }, () => 0.999), [1, 0, 0, 0])

// over many rolls a kick lands on beats more than off them, a snare on two and four
const tally = (sound, at) => {
  let n = 0
  for (let r = 0; r < 400; r++) n += rollSteps({ sound }, { bars: 1, stepsPerBar: 16, beats: 4 })[at]
  return n
}
assert.ok(tally('bd', 0) > tally('bd', 3) * 3)
assert.ok(tally('sd', 4) > tally('sd', 2) * 3)
console.log('roll ok')
