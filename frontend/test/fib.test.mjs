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

// ── triggers: a layer fires instruments on pattern nodes, whose sound goes on from there ──
{
  const { bundle } = await import('./lib/bundle.mjs')
  const m = await bundle({ 'project.js': ['normalizeProject', 'generateCode'], 'song.js': ['songParts'] }, 'fibtrig')
  const proj = ({ notes = [], steps = [], song, edges, extraChan = false }) => m.normalizeProject({
    bpm: 120, beats: 4, song,
    patterns: [
      { id: 'syn', name: 'syn', bars: 1, stepsPerBar: 16, channels: [{ id: 'c1', kind: 'synth', name: 'syn', sound: 'sawtooth', note: 'e3', notes }, ...(extraChan ? [{ id: 'c2', kind: 'drum', name: 'own', sound: 'hh', steps: [1, 0, 1, 0] }] : [])] },
      { id: 'drm', name: 'drm', bars: 1, stepsPerBar: 16, channels: [{ id: 'd1', kind: 'drum', name: 'drm', sound: 'cp', steps }] },
    ],
    nodes: [
      { id: 'ps', type: 'pattern', x: 0, y: 0, data: { patternId: 'syn' } },
      { id: 'pd', type: 'pattern', x: 0, y: 0, data: { patternId: 'drm' } },
      { id: 'f', type: 'fib', x: 0, y: 0, data: {} },
      { id: 'o', type: 'output', x: 0, y: 0, data: {} },
    ],
    edges: edges ?? [
      { source: 'f', sourceHandle: 'trig-l0', target: 'ps', targetHandle: 'trig-c1' },
      { source: 'f', sourceHandle: 'trig-l1', target: 'pd', targetHandle: 'trig-d1' },
      { source: 'ps', target: 'o', targetHandle: 'in-0' },
      { source: 'pd', target: 'o', targetHandle: 'in-1' },
    ],
  })
  const line = (code, name) => code.split('\n').find((l) => l.startsWith(`const ${name} = `)) ?? ''
  let code = m.generateCode(proj({}))
  assert.match(line(code, 'p_syn_c1'), /note\("e3"\)\.s\("sawtooth"\).*_r: 'f\.l0'.*\.struct\("\{t ~ ~ t/, 'an empty synth holds its own note, fired on the layer\'s rhythm')
  assert.match(line(code, 'p_drm_d1'), /s\("cp"\).*\.struct\(/, 'a drum holds its sound, whatever its steps')
  assert.match(code, /const n_ps = p_syn\.fmap/, 'and the sound goes on from the pattern node')
  assert.doesNotMatch(line(code, 'n_f'), /cp|sawtooth/, 'not through the machine')
  code = m.generateCode(proj({ notes: [{ s: 0, l: 16, n: 48 }] }))
  assert.match(line(code, 'p_syn_c1'), /note\("c3@16"\)/, 'notes you drew are kept: each hit takes the one held then')
  // one layer, two instruments
  code = m.generateCode(proj({ edges: [
    { source: 'f', sourceHandle: 'trig-l0', target: 'ps', targetHandle: 'trig-c1' },
    { source: 'f', sourceHandle: 'trig-l0', target: 'pd', targetHandle: 'trig-d1' },
    { source: 'ps', target: 'o', targetHandle: 'in-0' },
    { source: 'pd', target: 'o', targetHandle: 'in-1' },
  ] }))
  assert.match(line(code, 'p_drm_d1'), /_r: 'f\.l0'.*\.struct\("\{t ~ ~ t/, 'a layer fires as many instruments as it\'s wired to')
  // on the song, only the machine needs a clip
  const song = { on: true, clips: [{ id: 'k', src: 'node:f', lane: 0, start: 0, len: 2 }] }
  const all = proj({ song })
  assert.ok(!m.songParts(all).some((p) => p.src === 'pattern:syn'), 'a pattern every instrument of which is triggered is not a part')
  assert.match(line(m.generateCode(all), 'p_syn_c1'), /\.mask\("<1 1>"\)/, 'it plays where the fib\'s clip is')
  const some = proj({ song, extraChan: true })
  assert.ok(m.songParts(some).some((p) => p.src === 'pattern:syn'), 'one with an instrument left on its own steps stays a part')
  // an old track: sounds wired into the layers, the fib on to the output
  const old = proj({ edges: [
    { source: 'ps', target: 'f', targetHandle: 'in-0' },
    { source: 'pd', target: 'f', targetHandle: 'in-1' },
    { source: 'f', target: 'o', targetHandle: 'in-0' },
  ] })
  const has = (s, sh, t, th) => old.edges.some((e) => e.source === s && e.sourceHandle === sh && e.target === t && (!th || e.targetHandle === th))
  assert.ok(has('f', 'trig-l0', 'ps', 'trig-c1') && has('f', 'trig-l1', 'pd', 'trig-d1'), 'turned round: each layer triggers what was wired into it')
  assert.ok(has('ps', 'out', 'o') && has('pd', 'out', 'o'), 'and the patterns take the fib\'s place on the output')
  assert.ok(!old.edges.some((e) => e.target === 'f'), 'nothing goes into the fib any more')
  assert.match(line(m.generateCode(old), 'p_syn_c1'), /_r: 'f\.l0'.*\.struct\(/, 'and it plays as it did')
  console.log('fib triggers ok')
}
