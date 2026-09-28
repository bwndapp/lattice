// node frontend/test/keyboard.test.mjs — which note a typing key plays, the one the roll lights
import assert from 'node:assert/strict'
import test from 'node:test'
import { keyNote } from '../src/keyboard.js'

test('a typing key plays the note at the octave it was pressed in', () => {
  assert.deepEqual(keyNote('z', 4), { note: 60 }) // C4
  assert.deepEqual(keyNote('q', 4), { note: 72 }) // an octave up the top row
  assert.deepEqual(keyNote('Z', 3), { note: 48 }) // after - it's C3, whatever the case
  assert.deepEqual(keyNote('s', 5), { note: 73 }) // after = C#5
})

test('- and = step the octave instead of playing', () => {
  assert.deepEqual(keyNote('-', 4), { octave: -1 })
  assert.deepEqual(keyNote('=', 4), { octave: 1 })
  assert.equal(keyNote('p', 4), null)
})
