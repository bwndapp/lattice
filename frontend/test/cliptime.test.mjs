/**
 * Clips on the timeline play the part from where the clip says: a clip's start is where the
 * part's bar 1 lands, a clip trimmed from the left (or the right half of a slice) picks the
 * part up part-way in, and a pattern a machine fires is no different — its rhythm starts at
 * its clip too, as the timeline draws it. Checked against what Strudel actually plays.
 */
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'

const m = await bundle({ 'project.js': ['normalizeProject', 'generateCode'], 'song.js': ['songParts', 'patternTimeAt', 'songTimeFor', 'autoTimeAt'] }, 'cliptime')
const sm = await bundle({ '../node_modules/@strudel/core': ['s', 'note', 'stack', 'silence'], '../node_modules/@strudel/mini': ['miniAllStrings', 'mini'] }, 'cliptimestr')
sm.miniAllStrings()

const steps = (hits, n) => Array.from({ length: n }, (_, i) => (hits.includes(i) ? 1 : 0))
// a 2-bar drum pattern that says which bar it's on: bar 1 hits its downbeat, bar 2 its second beat
const project = ({ clips, fired = false }) => m.normalizeProject({
  bpm: 120, beats: 4,
  patterns: [{ id: 'D', name: 'drums', bars: 2, stepsPerBar: 16, channels: [{ id: 'k', kind: 'drum', name: 'kick', sound: 'bd', steps: steps([0, 20], 32) }] }],
  nodes: [
    { id: 'pd', type: 'pattern', x: 0, y: 0, data: { patternId: 'D' } },
    { id: 'o', type: 'output', x: 0, y: 0, data: {} },
    ...(fired ? [{ id: 'f', type: 'fib', x: 0, y: 0, data: { state: { layers: [{ mode: 'even', steps: 4, hits: 1, sound: '' }] } } }] : []),
  ],
  edges: [{ source: 'pd', target: 'o', targetHandle: 'in-0' }, ...(fired ? [{ source: 'f', sourceHandle: 'trig-l0', target: 'pd', targetHandle: 'trig-k' }] : [])],
  song: { on: true, fired: true, clips },
})
/** Onsets of the drums pattern over the first `bars` bars of the song. */
function onsets(p, bars) {
  const lines = m.generateCode(p).split('\n')
  const a = lines.findIndex((l) => /^const p_D/.test(l))
  const b = lines.findIndex((l) => l.startsWith('const p_D = '))
  let e = b + 1
  while (e < lines.length && lines[e] && !lines[e].startsWith('const ') && !lines[e].startsWith('//')) e++
  const defs = lines.slice(a, e).join('\n').replace(/"([^"]*)"/g, 'mini("$1")')
  const pat = new Function('s', 'note', 'stack', 'silence', 'mini', `${defs}\nreturn p_D`)(sm.s, sm.note, sm.stack, sm.silence, sm.mini)
  return pat.queryArc(0, bars).filter((h) => h.hasOnset()).map((h) => +(+h.whole.begin).toFixed(4)).sort((x, y) => x - y)
}
const clip = (start, len, offset = 0) => ({ id: `c${start}`, src: 'pattern:D', lane: 0, start, len, ...(offset ? { offset } : {}) })

assert.deepEqual(onsets(project({ clips: [clip(2, 2)] }), 4), [2, 3.25], 'a clip at bar 3 starts the pattern there: its bar 1, then its bar 2')
assert.deepEqual(onsets(project({ clips: [clip(3, 1, 1)] }), 4), [3.25], 'trimmed from the left, it picks the pattern up at its bar 2')
assert.deepEqual(onsets(project({ clips: [clip(0, 2), clip(2.5, 1.5, 0.5)] }), 4), [0, 1.25, 3.25], 'a slice\'s right half carries on where the cut was')
assert.deepEqual(onsets(project({ clips: [clip(1.5, 1)] }), 4), [1.5], 'a clip off the bar line starts the pattern where it starts')
// fired: a fib rhythm of one hit a bar, at its start
{
  const at0 = onsets(project({ fired: true, clips: [clip(0, 1)] }), 1)
  const at = onsets(project({ fired: true, clips: [clip(1.25, 1)] }), 4)
  assert.deepEqual(at, at0.map((t) => +(t + 1.25).toFixed(4)), 'a fired pattern\'s rhythm starts at its clip, as drawn: the same hits, moved with it')
  const two = onsets(project({ fired: true, clips: [clip(0, 1), clip(2.5, 1)] }), 4)
  assert.deepEqual(two, [...at0, ...at0.map((t) => +(t + 2.5).toFixed(4))], 'and a second clip starts it again from the top')
}
// its loop length on the timeline: as long as the machine's rhythm and its own notes take to come round
const parts = m.songParts(project({ fired: true, clips: [clip(0, 1)] }))
assert.equal(parts.find((x) => x.src === 'pattern:D').bars, 2, 'a fired pattern comes round with its own length when the machine\'s is a bar')
// the pattern's own playhead (the rack, the piano roll) reads the clip as the sound does
{
  const p = project({ clips: [clip(2.25, 4)] })
  assert.equal(m.patternTimeAt(p, 'D', 2.25), 0, 'at a clip\'s start the pattern is at its bar 1, wherever the clip sits')
  assert.equal(m.patternTimeAt(p, 'D', 3.25) % 2, 1, 'a bar later, its bar 2: where the timeline plays it')
  const q = project({ clips: [clip(3, 1, 1)] })
  assert.equal(m.patternTimeAt(q, 'D', 3.5), 1.5, 'a trimmed clip reads from its cut')
  // clicking its bar 2, beat 1 in the pattern's editor goes there in the clip that's playing
  assert.equal(m.songTimeFor(p, 'D', 1, 2.5, 2), 3.25, 'clicking a spot in the pattern lands on it in the playing clip')
  assert.equal(m.songTimeFor(p, 'D', 0, 5, 2), 4.25, 'on the repeat that\'s playing')
  const none = project({ clips: [{ id: 'z', src: 'pattern:Z', lane: 0, start: 0, len: 1 }] })
  assert.equal(m.patternTimeAt(none, 'D', 5.5), 5.5, 'a pattern with no clips reads the song position as before')
}
// where the playhead falls on an automation's own curve, as the timeline plays it
{
  const p = m.normalizeProject({
    bpm: 120, beats: 4, patterns: [], nodes: [{ id: 'f', type: 'filter', x: 0, y: 0, data: {} }, { id: 'o', type: 'output', x: 0, y: 0, data: {} }], edges: [],
    song: { on: true, clips: [{ id: 'k', src: 'auto:a', lane: 0, start: 2, len: 4 }, { id: 'l', src: 'auto:a', lane: 0, start: 8, len: 1, offset: 1 }], autos: [{ id: 'a', target: 'n:f:lpf', bars: 2, points: [{ x: 0, y: 0 }, { x: 2, y: 1 }] }] },
  })
  assert.equal(m.autoTimeAt(p, 'a', 3), 1, 'a bar into its clip is a bar into its curve')
  assert.equal(m.autoTimeAt(p, 'a', 4.5), 0.5, 'and round again as the clip repeats it')
  assert.equal(m.autoTimeAt(p, 'a', 8.25), 1.25, 'a trimmed clip reads from its cut')
  assert.equal(m.autoTimeAt(p, 'a', -0.001), m.autoTimeAt(p, 'a', 0), 'play\'s pre-roll reads bar 1')
}
console.log('clip timing ok')
