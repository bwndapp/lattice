// node frontend/test/tags.test.mjs — tags clean up the way the server cleans them
import assert from 'node:assert/strict'
import { cleanTag, addTags } from '../src/tags.js'

assert.equal(cleanTag('  #DnB '), 'dnb')
assert.equal(cleanTag('Liquid   Funk'), 'liquid funk')
assert.equal(cleanTag('a_b!c'), 'abc')
assert.equal(cleanTag('-lo-fi-'), 'lo-fi')
assert.equal(cleanTag('x'.repeat(40)), 'x'.repeat(24))
assert.equal(cleanTag('###'), '')
assert.deepEqual(addTags(['dnb'], ['DNB', '#house', '']), ['dnb', 'house'])
assert.equal(addTags([], Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 8)
console.log('tags ok')
