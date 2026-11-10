// node frontend/test/cube.test.mjs — the cube: twists are real puzzle moves, scrambles keep the hits, it saves and plays
import assert from 'node:assert/strict'
import { MOVES, RINGS, STICKERS, code, faces, inverse, normalize, pack, paint, rings, scrambleMoves, twist } from '../src/abstract/cube/model.js'

// a new cube has no sounds of its own: silent until you pick one or wire something in
assert.equal(code(normalize(null)), 'silence')
const KIT = [{ sound: 'bd' }, { sound: 'sd' }, { sound: 'hh' }, { sound: 'rim' }]
const start = normalize({ rows: KIT })
assert.equal(STICKERS.length, 96)
assert.equal(new Set(RINGS.flat()).size, 64, 'four rings of sixteen, none shared')

for (const [name, mv] of Object.entries(MOVES)) {
  assert.equal(new Set(mv.table).size, 96, `${name} moves every sticker somewhere different`)
  assert.deepEqual(faces({ ...start, moves: [name, name, name, name] }), faces(start), `${name} four times is no change`)
  assert.deepEqual(faces({ ...start, moves: [name, inverse(name)] }), faces(start), `${name} then its inverse is no change`)
}

// turning the top layer shifts the top drum by a beat (four steps)
const top = rings(start)[0]
const turned = rings(twist(start, 'y3+'))[0]
assert.deepEqual(turned, top.map((_, i) => top[(i + 12) % 16]))

// a scramble keeps every hit, just somewhere else; solve brings the groove back
let r = 1
const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647)
const scrambled = scrambleMoves(30, rand).reduce(twist, start)
const sum = (a) => a.reduce((x, y) => x + y, 0)
assert.equal(sum(faces(scrambled)), sum(faces(start)))
assert.deepEqual(rings({ ...scrambled, moves: [] }), rings(start))

// painting while scrambled paints the sticker you see, and it stays painted once solved
const slot = RINGS[1][0]
const painted = paint(scrambled, slot)
assert.equal(faces(painted)[slot], (faces(scrambled)[slot] + 1) % 3)

// it saves small and comes back the same
assert.deepEqual(normalize(pack(scrambled)), scrambled)
assert.equal(typeof pack(scrambled).painted, 'string')
// junk in, a working cube out
assert.deepEqual(normalize({ painted: 'nope', moves: 'x9+ y1- zz', rows: [{ sound: 'bd"); evil(' }] }).moves, ['y1-'])
assert.ok(!normalize({ rows: [{ sound: 'bd"); evil(' }] }).rows[0].sound.includes('"'))

// it plays: a stack of sixteen-step bars, nothing when every layer is muted
assert.match(code(start), /^stack\(s\("bd ~ ~ ~ bd/)
assert.equal(code({ ...start, rows: start.rows.map((x) => ({ ...x, mute: true })) }), 'silence')
console.log('cube ok')

// ── on the patch: each layer has a port of its own, and "main" takes it off the main out ──
const { bundle } = await import('./lib/bundle.mjs')
const { graphCode, normalizeGraph } = await bundle({ 'graph.js': ['graphCode', 'normalizeGraph'] }, 'cube')
const raw = {
  nodes: [
    { id: 'c', type: 'cube', data: { state: { rows: KIT } } },
    { id: 'f', type: 'filter', data: {} },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { source: 'c', sourceHandle: 'out', target: 'o', targetHandle: 'in-0' },
    { source: 'c', sourceHandle: 'out-r1', target: 'f', targetHandle: 'in' },
    { source: 'f', target: 'o', targetHandle: 'in-1' },
    { source: 'c', sourceHandle: 'out-r9', target: 'o', targetHandle: 'in-2' }, // no such layer
  ],
}
const g = normalizeGraph(raw, [])
assert.equal(g.edges.length, 3, 'a port that isn\'t a layer is dropped')
assert.ok(g.edges.some((e) => e.sourceHandle === 'out-r1'))
let made = graphCode({ ...g, patterns: [], bpm: 120, beats: 4 }).lines?.join('\n') ?? String(graphCode({ ...g, patterns: [], bpm: 120, beats: 4 }))
assert.match(made, /const n_c_r1 = s\("~ ~ ~ ~ sd/, 'the snare layer gets a line of its own')
assert.match(made, /n_c_r1\.lpf|n_c_r1\)?\./, 'and that line is what the filter gets')
// a copy until it's taken off the main
const mainLine = (code) => code.split('\n').find((l) => l.startsWith('const n_c = '))
assert.match(mainLine(made), /sd/)
const held = normalizeGraph({ ...raw, nodes: raw.nodes.map((n) => (n.id === 'c' ? { ...n, data: { ...n.data, offMain: { r1: true, r7: true } } } : n)) }, [])
assert.deepEqual(held.nodes[0].data.offMain, { r1: true })
made = graphCode({ ...held, patterns: [], bpm: 120, beats: 4 }).lines?.join('\n') ?? String(graphCode({ ...held, patterns: [], bpm: 120, beats: 4 }))
assert.doesNotMatch(mainLine(made), /sd/)
console.log('cube ports ok')

// ── a sound wired into a layer plays on that layer's rhythm; the other layers keep their drums ──
const fedRaw = {
  nodes: [
    { id: 'm', type: 'notes', data: { mini: 'c3 e3', sound: 'sawtooth' } },
    { id: 'c', type: 'cube', data: { state: { rows: KIT } } },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { source: 'm', target: 'c', targetHandle: 'in-0' },
    { source: 'c', target: 'o', targetHandle: 'in-0' },
  ],
}
const fed = normalizeGraph(fedRaw, [])
assert.equal(fed.edges.length, 2, 'a layer takes a wire')
const fedCode = String(graphCode({ ...fed, patterns: [], bpm: 120, beats: 4 }).lines?.join('\n') ?? graphCode({ ...fed, patterns: [], bpm: 120, beats: 4 }))
const cubeLine = fedCode.split('\n').find((l) => l.startsWith('const n_c = '))
assert.match(cubeLine, /n_m\.fmap\(\(v\) => \(\{ \.\.\.v, _r: 'c\.r0' \}\)\)\.struct\("t ~ ~ ~ t/, 'the top layer chops the melody on the kick\'s rhythm, on an instance of its own')
assert.doesNotMatch(cubeLine, /s\("bd/, 'and no longer plays its kick')
assert.match(cubeLine, /s\("~ ~ ~ ~ sd/, 'the other layers keep their own sounds')
console.log('cube inputs ok')

// held back from main only while wired out: unwire the layer and it's back in the mix
const unwired = normalizeGraph({ ...raw, edges: raw.edges.filter((e) => e.sourceHandle !== 'out-r1'), nodes: raw.nodes.map((n) => (n.id === 'c' ? { ...n, data: { ...n.data, offMain: { r1: true } } } : n)) }, [])
const unwiredCode = String(graphCode({ ...unwired, patterns: [], bpm: 120, beats: 4 }).lines?.join('\n') ?? graphCode({ ...unwired, patterns: [], bpm: 120, beats: 4 }))
assert.match(mainLine(unwiredCode), /sd/, 'an unwired layer plays through main again')
console.log('cube main ok')
