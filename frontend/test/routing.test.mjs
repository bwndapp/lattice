/**
 * Routing is what the wires say. A mixer bus split two ways (one branch dry, one through a
 * reverb) and joined again plays each note once, and the reverb lives on its own branch,
 * so the dry branch never hears its tail. A reverb straight after a sound (no bus yet) is
 * still a send on each note.
 */
import { bundle } from './lib/bundle.mjs'

const m = await bundle({
  'project.js': ['generateCode', 'normalizeProject'],
  'stereo.js': ['declaredRouting'],
}, 'routing')

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const drums = { id: 'pd', name: 'drums', bars: 1, stepsPerBar: 16, channels: [{ id: 'k', kind: 'drum', name: 'kick', sound: 'bd', bank: 'RolandTR909', steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], params: {} }] }
const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data })
const edge = (source, target, targetHandle = 'in') => ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle: 'out', target, targetHandle })

// drums → bus A, which splits: → saturator (dry) and → reverb → filter (wet), both → bus B → out
const split = m.normalizeProject({
  v: 3, bpm: 120, beats: 4, patterns: [drums],
  nodes: [
    node('out', 'output', { muted: {} }), node('pat', 'pattern', { patternId: 'pd' }),
    node('busA', 'bus', { name: 'a' }), node('dry', 'saturator'), node('verb', 'reverb', { mix: 0.5 }), node('flt', 'filter'),
    node('busB', 'bus', { name: 'b' }),
  ],
  edges: [edge('pat', 'busA', 'in-0'), edge('busA', 'dry'), edge('busA', 'verb'), edge('verb', 'flt'), edge('dry', 'busB', 'in-0'), edge('flt', 'busB', 'in-1'), edge('busB', 'out', 'in-0')],
  song: { on: false, clips: [] },
})
const code = m.generateCode(split)
const lane = code.split('\n').find((l) => l.startsWith('const n_busB'))
ok('a split bus joined again plays its notes once', lane && !/stack\(/.test(lane.split('=')[1]), lane)
ok('a reverb after a bus is not a send on the notes', !code.includes("['rv_verb'"))
const { inserts, routes } = m.declaredRouting()
const orbitOf = (key) => [...inserts].find(([, list]) => list.some((i) => i.key === key))?.[0]
const verbOrbit = orbitOf('rv_verb')
ok('the reverb is an insert on a bus', verbOrbit != null && inserts.get(verbOrbit).find((i) => i.key === 'rv_verb').kind === 'sendfx')
ok('the reverb and its filter share the wet branch', verbOrbit != null && verbOrbit === orbitOf('flt'))
ok('the dry branch is a different bus from the wet one', orbitOf('dry') != null && orbitOf('dry') !== verbOrbit)
ok('the reverb is not on the split bus itself', verbOrbit !== orbitOf('busA'))
ok('both branches are fed from the split bus', [orbitOf('dry'), verbOrbit].every((o) => routes.get(orbitOf('busA'))?.has(o)))

// a reverb straight on a pattern: a send on each note, as before
const plain = m.normalizeProject({
  v: 3, bpm: 120, beats: 4, patterns: [drums],
  nodes: [node('out', 'output', { muted: {} }), node('pat', 'pattern', { patternId: 'pd' }), node('verb', 'reverb', { mix: 0.5 })],
  edges: [edge('pat', 'verb'), edge('verb', 'out', 'in-0')],
  song: { on: false, clips: [] },
})
ok('a reverb before any bus is still a send', m.generateCode(plain).includes("['rv_verb'"))

if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('\nrouting ok')
