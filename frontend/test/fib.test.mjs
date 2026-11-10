// node frontend/test/fib.test.mjs — the Fibonacci machine: its rhythms, its drift, and a sound played on a loop
import assert from 'node:assert/strict'
import { evenRhythm, goldenRhythm, layerSteps, normalize, parts, roll } from '../src/abstract/fib/model.js'

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
for (const l of roll(s).layers) { assert.ok([3, 5, 8, 13, 21].includes(l.steps)); assert.ok(l.hits < l.steps) }
console.log('fib ok')

// ── an instrument wired straight into a layer is fired by every hit, notes or not ──
const { bundle } = await import('./lib/bundle.mjs')
const pm = await bundle({ 'project.js': ['normalizeProject', 'generateCode'] }, 'fibheld')
const track = (notes, steps) => pm.generateCode(pm.normalizeProject({
  bpm: 120, beats: 4,
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
console.log('fib held ok')
