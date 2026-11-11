// node frontend/test/fib.test.mjs — the Fibonacci machine: its rhythms, its drift, and a sound played on a loop
import assert from 'node:assert/strict'
import { MAX_LAYERS, addLayer, evenRhythm, goldenRhythm, layerSteps, normalize, parts, removeLayer, roll } from '../src/abstract/fib/model.js'

assert.equal(evenRhythm(3, 8).join(''), '10010010', '3 in 8 is the tresillo')
assert.equal(goldenRhythm(13).join(''), '1011010110110', 'the Fibonacci word')
assert.ok(parts(normalize(null)).every((p) => p.expr === null), 'a new machine has no sounds of its own')
assert.ok(parts(normalize(null))[0].drive('x'), 'but its rhythm still drives what\'s wired in')
const s = normalize({ layers: [{ sound: 'bd' }, { sound: 'sd' }, { sound: 'hh' }, { sound: 'rim' }] })
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
for (const l of roll(s).layers) { assert.ok([3, 5, 8, 13, 21, 34, 55].includes(l.steps)); assert.ok(l.hits < l.steps) }
// as many layers as you like (to sixteen), each new one further along the Fibonacci numbers
let many = normalize(null)
assert.equal(many.layers.length, 4)
many = addLayer(many)
assert.deepEqual([many.layers[4].hits, many.layers[4].steps], [21, 34], 'after 5 in 21 comes 21 in 34')
for (let i = 0; i < 40; i++) many = addLayer(many)
assert.equal(many.layers.length, MAX_LAYERS)
assert.equal(normalize(JSON.parse(JSON.stringify(many))).layers.length, MAX_LAYERS, 'they save')
assert.equal(parts(many).length, MAX_LAYERS)
assert.equal(removeLayer(many, 3).layers[3].steps, many.layers[4].steps, 'removing one moves the rest up')
assert.equal(removeLayer(normalize({ layers: [{}] }), 0).layers.length, 1, 'never fewer than one')
console.log('fib ok')

// ── an instrument wired straight into a layer is fired by every hit, notes or not ──
const { bundle } = await import('./lib/bundle.mjs')
const pm = await bundle({ 'project.js': ['normalizeProject', 'generateCode'] }, 'fibheld')
const track = (notes, steps, song) => pm.generateCode(pm.normalizeProject({
  bpm: 120, beats: 4, song,
  patterns: [
    { id: 'syn', name: 'syn', bars: 1, stepsPerBar: 16, channels: [{ id: 'c1', kind: 'synth', name: 'syn', sound: 'sawtooth', note: 'e3', notes }] },
    { id: 'drm', name: 'drm', bars: 1, stepsPerBar: 16, channels: [{ id: 'd1', kind: 'drum', name: 'drm', sound: 'cp', steps }] },
  ],
  nodes: [
    { id: 'ps', type: 'pattern', x: 0, y: 0, data: { patternId: 'syn' } },
    { id: 'pd', type: 'pattern', x: 0, y: 0, data: { patternId: 'drm' } },
    { id: 'f', type: 'fib', x: 0, y: 0, data: {} },
    { id: 'o', type: 'output', x: 0, y: 0, data: {} },
  ],
  edges: [
    { source: 'ps', sourceHandle: 'out', target: 'f', targetHandle: 'in-0' },
    { source: 'pd', sourceHandle: 'out', target: 'f', targetHandle: 'in-1' },
    { source: 'f', sourceHandle: 'out', target: 'o', targetHandle: 'in-0' },
  ],
}))
let made = track([], [])
assert.match(made, /const p_syn_held = .*note\("e3"\)\.s\("sawtooth"\)/, 'an empty synth holds its own note')
assert.match(made, /const p_drm_held = .*s\("cp"\)/, 'a drum holds its sound, whatever its steps')
assert.match(made, /p_syn_held\.fmap\(.*\)\.struct\("\{t ~ ~ t/, 'and the loop fires it')
made = track([{ s: 0, l: 16, n: 48 }], [1])
assert.match(made, /const p_syn_held = .*note\("c3@16"\)/, 'notes you drew are kept')
// on the song, only the machine needs a clip: the instruments wired into it play with it
made = track([], [], { on: true, clips: [{ id: 'k', src: 'node:f', lane: 0, start: 0, len: 2 }] })
const fibLine = made.split('\n').find((l) => l.startsWith('const n_f = '))
assert.match(fibLine, /\(p_syn_held\.fmap\(.*?\)\)\.mask\("<1 1>"\)/, 'the synth plays where the fibonacci clip is')
assert.doesNotMatch(fibLine, /silence/, 'with no clip of its own')
assert.match(made, /const p_syn_held = \/\* syn \*\/ note\(/, 'its held version is no longer gated by its own clips')
console.log('fib held ok')

// the timeline's sketch: in drift, every bar until the loops meet again (capped); in bar, one
{
  const { asPattern, normalize, roll, SKETCH_BARS } = await import('../src/abstract/fib/model.js')
  const two = normalize({ layers: [{ mode: 'even', hits: 3, steps: 8 }, { mode: 'even', hits: 2, steps: 5 }] })
  const p = asPattern(two)
  assert.equal(p.bars, 5, '8 and 5 in sixteenths line up again after 5 bars')
  assert.equal(p.channels[1].steps.length, 80)
  assert.deepEqual(p.channels[1].steps.slice(16, 21), p.channels[1].steps.slice(1, 6), 'the 5-loop keeps sliding into bar two')
  assert.equal(asPattern(normalize(null)).bars, SKETCH_BARS, 'loops that take ages to meet are capped')
  assert.equal(asPattern({ ...two, timing: 'bar' }).bars, 1)
  // roll reaches the long loops too
  let r = 7
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647)
  const seen = new Set()
  for (let i = 0; i < 60; i++) for (const l of roll(two, rand).layers) seen.add(l.steps)
  assert.ok(seen.has(34) && seen.has(55), 'roll picks 34 and 55')
  console.log('fib sketch + roll ok')
}

// ── anything wired into a machine is part of it: the machine is the clip ──
{
  const { bundle } = await import('./lib/bundle.mjs')
  const m = await bundle({ 'project.js': ['normalizeProject', 'generateCode'], 'song.js': ['songParts'] }, 'fibclip')
  const proj = (wireOut) => m.normalizeProject({
    bpm: 120, beats: 4,
    patterns: [{ id: 'syn', name: 'syn', bars: 1, stepsPerBar: 16, channels: [{ id: 'c1', kind: 'synth', name: 'syn', sound: 'sawtooth', note: 'e3', notes: [{ s: 0, l: 4, n: 48 }] }] }],
    nodes: [
      { id: 'ps', type: 'pattern', x: 0, y: 0, data: { patternId: 'syn' } },
      { id: 'lp', type: 'filter', x: 0, y: 0, data: {} },
      { id: 'f', type: 'fib', x: 0, y: 0, data: {} },
      { id: 'o', type: 'output', x: 0, y: 0, data: {} },
    ],
    edges: [
      { source: 'ps', target: 'lp', targetHandle: 'in' },
      { source: 'lp', target: 'f', targetHandle: 'in-0' },
      { source: 'f', target: 'o', targetHandle: 'in-0' },
      ...(wireOut ? [{ source: 'ps', target: 'o', targetHandle: 'in-1' }] : []),
    ],
    song: { on: true, clips: [{ id: 'k', src: 'node:f', lane: 0, start: 0, len: 2 }, { id: 'old', src: 'pattern:syn', lane: 1, start: 4, len: 1 }] },
  })
  const inside = proj(false)
  const srcs = m.songParts(inside).map((p) => p.src)
  assert.ok(srcs.includes('node:f') && !srcs.includes('pattern:syn'), 'a pattern inside the fib is not a part of the song')
  const code = m.generateCode(inside)
  const synDef = code.slice(code.indexOf('const p_syn = '), code.indexOf('const n_ps'))
  assert.match(synDef, /note\(/, 'it plays all the time')
  assert.doesNotMatch(synDef, /mask/, 'its own old clip no longer gates it')
  assert.match(code.split('\n').find((l) => l.startsWith('const n_f = ')), /\(n_lp[^\n]*\)\.mask\("<1 1>"\)/, 'through its filter, the fib\'s clip gates it')
  // also wired to the output on its own: then it's a part of the song as well
  assert.ok(m.songParts(proj(true)).some((p) => p.src === 'pattern:syn'))
  console.log('fib is the clip ok')
}
