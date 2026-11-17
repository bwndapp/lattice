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
  assert.ok(m.songParts(all).some((p) => p.src === 'pattern:syn'), 'a pattern a machine fires is a part of its own')
  // a song from before: it played where the fib's clip was, and still does (its clip copied, once)
  assert.ok(all.song.clips.some((c) => c.src === 'pattern:syn' && c.start === 0 && c.len === 2), 'an old song gives it the fib\'s clips')
  assert.match(line(m.generateCode(all), 'p_syn_c1'), /\.mask\("<1 1>"\)/, 'so it plays where the fib\'s clip is')
  // a song since: it plays inside its own clips, whatever the machine's
  const own = proj({ song: { ...song, fired: true, clips: [...song.clips, { id: 'q', src: 'pattern:syn', lane: 1, start: 1, len: 1 }] } })
  assert.equal(own.song.clips.filter((c) => c.src === 'pattern:syn').length, 1, 'and only once: a song since keeps its own clips')
  const ownLine = line(m.generateCode(own), 'p_syn_c1')
  assert.match(ownLine, /\.mask\("<0 1>"\)/, 'a fired pattern plays inside its own clips')
  assert.doesNotMatch(ownLine, /\.early\(/, 'the machine\'s rhythm starts where its clip does, as any part')
  // (something else on the timeline, so the song is on)
  const none = proj({ song: { ...song, fired: true, clips: [{ id: 'z', src: 'pattern:drm', lane: 0, start: 0, len: 2 }] } })
  assert.ok(!m.songParts(none).some((p) => p.src === 'node:f'), 'a machine with no sounds of its own isn\'t a part')
  // a layer with a sound picked that fires an instrument plays through it, not on its own
  const firingSound = proj({ song: { ...song, fired: true } })
  firingSound.nodes.find((n) => n.id === 'f').data.state.layers.forEach((l) => { l.sound = 'bd' })
  const firingIds = new Set(firingSound.edges.filter((e) => e.source === 'f' && e.sourceHandle?.startsWith('trig-')).map((e) => e.sourceHandle.slice(5)))
  if (firingIds.size === firingSound.nodes.find((n) => n.id === 'f').data.state.layers.length) {
    assert.ok(!m.songParts(firingSound).some((p) => p.src === 'node:f'), 'a machine whose every layer fires isn\'t a part, whatever sounds they have picked')
  }
  assert.match(line(m.generateCode(none), 'p_syn_c1'), /silence/, 'with no clips of its own it is quiet')
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

// ── evolve: the loops change through 13 generations, when and how by Fibonacci ──
{
  const { GENERATIONS, asPattern, layerAt, layerSteps, normalize, parts } = await import('../src/abstract/fib/model.js')
  // Strudel from the app's own bundle, its strings mini-notation as in the app
  const { bundle } = await import('./lib/bundle.mjs')
  const sm = await bundle({ '../node_modules/@strudel/core': ['s', 'arrange'], '../node_modules/@strudel/mini': ['miniAllStrings', 'mini'] }, 'fibevolve')
  sm.miniAllStrings()
  // the app's transpiler turns every "…" into mini-notation before it runs; so does this
  const evaluate = async (expr) => ({ pattern: new Function('s', 'arrange', 'mini', `return ${expr.replace(/"([^"]*)"/g, 'mini("$1")')}`)(sm.s, sm.arrange, sm.mini) })
  const base = normalize({ layers: [{ mode: 'even', hits: 3, steps: 8, sound: 'bd' }, { mode: 'even', hits: 2, steps: 5, sound: 'sd' }, { mode: 'golden', steps: 13, sound: 'hh' }], every: 2 })
  assert.equal(base.evolve, false, 'evolve is off unless asked')
  const evo = normalize({ ...base, evolve: true })
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(evo))), evo, 'it saves')
  assert.equal(normalize({ ...evo, every: 7 }).every, 2, 'every is a Fibonacci number of bars')
  const loop = (l, i, g) => layerSteps(layerAt(l, i, g)).join('')
  // when: layer one changes every generation, layer two only every second one
  assert.notEqual(loop(evo.layers[0], 0, 1), loop(evo.layers[0], 0, 0), 'layer one changes at generation 1')
  assert.equal(loop(evo.layers[1], 1, 1), loop(evo.layers[1], 1, 0), 'layer two holds through generation 1')
  assert.notEqual(loop(evo.layers[1], 1, 2), loop(evo.layers[1], 1, 0), 'and changes at generation 2')
  // what: hits stay Fibonacci, loop lengths never change
  for (let g = 0; g < GENERATIONS; g++) for (const [i, l] of evo.layers.entries()) {
    const at = layerAt(l, i, g)
    assert.equal(at.steps, l.steps)
    assert.ok([1, 2, 3, 5, 8, 13, 21, 34, 55].includes(at.hits))
  }
  // it plays: generation by generation, and round again after 13
  const onsets = async (expr, from, to) => (await evaluate(expr)).pattern.queryArc(from, to).filter((h) => h.hasOnset()).map((h) => +(h.whole.begin.valueOf() - from).toFixed(4)).sort((a, b) => a - b).join(' ')
  const drum = parts(evo)[0].expr
  assert.match(drum, /arrange\(/, 'an evolving loop is an arrange of its generations')
  assert.notEqual(await onsets(drum, 0, 1), await onsets(drum, 2, 3), 'generation 1 (bars 3-4) plays differently from generation 0')
  const round = GENERATIONS * evo.every
  assert.equal(await onsets(drum, 0, 4), await onsets(drum, round, round + 4), 'after 13 generations it comes round again')
  assert.equal(await onsets(parts(base)[0].expr, 0, 1), await onsets(drum, 0, 1), 'generation 0 is the loop as set')
  // the rhythm drives what's wired in the same way
  assert.match(parts(evo)[0].drive('x'), /^x\.struct\(arrange\(/)
  // the sketch covers every generation
  assert.equal(asPattern(evo).bars, Math.min(32, round))
  console.log('fib evolve ok')
}
