// node frontend/test/start.test.mjs — what the studio opens on load, and when a track won't load
import assert from 'node:assert/strict'
import { whatToOpen, whenLoadFails } from '../src/start.js'

const base = { trackId: null, fresh: false, scratchWins: false, lastTrack: null, userLoading: false, signedIn: false }
// nothing to go back to: the scratch pad (a draft, or a blank project)
assert.equal(whatToOpen(base), 'stay')
// a link to a track, or "new": open that
assert.equal(whatToOpen({ ...base, trackId: 'abc', lastTrack: 'old' }), 'stay')
assert.equal(whatToOpen({ ...base, fresh: true, lastTrack: 'old' }), 'stay')
// work on the scratch pad beats the last track
assert.equal(whatToOpen({ ...base, scratchWins: true, lastTrack: 'old' }), 'stay')
assert.deepEqual(whatToOpen({ ...base, lastTrack: 'old' }), { track: 'old' })
// signed in with nothing here: your newest track; still signing in: wait
assert.equal(whatToOpen({ ...base, userLoading: true }), 'wait')
assert.equal(whatToOpen({ ...base, signedIn: true }), 'latest')

// gone, private or not yours: stop reopening it; offline: keep it for next time
for (const s of [404, 401, 403]) assert.equal(whenLoadFails(s).forget, true)
assert.equal(whenLoadFails(undefined).forget, false)
assert.equal(whenLoadFails(500).forget, false)
assert.ok(whenLoadFails(404).message)
console.log('start ok')
