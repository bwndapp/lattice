/**
 * The knife (shift + right-drag across wires): which wires a line crosses, what can go inline on
 * them, and the rewiring. One wire takes an insert; several into one node take a bus that
 * gathers them; a one-input effect goes on each wire. No loops, other lanes untouched.
 *
 * Bundled with esbuild first, as quickwire.test.mjs does.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-knife-'))
const entry = path.join(dir, 'entry.js')
const out = path.join(dir, 'bundle.mjs')
const shim = path.join(dir, 'shim.js')
fs.writeFileSync(shim, [
  'export const getAudioContext = () => null',
  'export const getSuperdoughAudioController = () => null',
  'export const registerSound = () => {}',
  'export const superdough = () => {}',
  'export const samples = () => {}',
  'export const applyGainCurve = (v) => v',
].join('\n'))
const src = (f) => JSON.stringify(path.join(here, '..', 'src', f))
fs.writeFileSync(entry, [
  `export * from ${src('quickWire.js')}`,
  `export { makesCycle } from ${src('graph.js')}`,
].join('\n'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
  `--alias:@strudel/webaudio=${shim}`, '--main-fields=module,main', '--resolve-extensions=.js,.mjs,.jsx', `--outfile=${out}`,
])
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: {} }
const m = await import(pathToFileURL(out))

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const patch = (nodes, edges = []) => ({
  nodes: nodes.map(([id, type, x = 0, y = 0]) => ({ id, type, x, y, data: {} })),
  edges: edges.map(([source, target, targetHandle]) => ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle: 'out', target, targetHandle })),
})
// add a node the way Graph.jsx does, then knife it in
const add = (p, cuts, id, type, x = 0, y = 500) => { p.nodes.push({ id, type, x, y, data: {} }); return m.knifeInsert(p, cuts, id) }
const has = (p, s, t, h) => p.edges.some((e) => e.source === s && e.target === t && (h == null || e.targetHandle === h))
const wires = (p) => p.edges.map((e) => `${e.source}>${e.target}`).sort().join(' ')
const acyclic = (p) => p.edges.every((e) => !m.makesCycle(p.edges.filter((x) => x !== e), e.source, e.target))

// which wires a line crosses
const paths = [
  { id: 'w1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
  { id: 'w2', points: [{ x: 0, y: 50 }, { x: 50, y: 60 }, { x: 100, y: 50 }] },
  { id: 'w3', points: [{ x: 0, y: 200 }, { x: 100, y: 200 }] },
]
const cuts = m.knifeCuts({ x: 50, y: -20 }, { x: 50, y: 100 }, paths)
ok('a line crosses the wires it passes over, nearest first', cuts.map((c) => c.id).join() === 'w1,w2', JSON.stringify(cuts))
ok('where it crosses them', cuts[0].x === 50 && cuts[0].y === 0 && Math.abs(cuts[1].y - 60) < 1e-9)
ok('a line alongside a wire crosses nothing', m.knifeCuts({ x: 0, y: 100 }, { x: 100, y: 100 }, paths).length === 0)

// real wires are curves: sample one the way WireEdge draws it (two cubics through a low middle)
const cubic = (p0, p1, p2, p3, n = 200) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, u = 1 - t
  return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y }
})
const wire = (id, s, e, sag = 40) => {
  const mid = { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 + sag }
  const reach = Math.max(34, Math.abs(e.x - s.x) * 0.28)
  return { id, points: [...cubic(s, { x: s.x + reach, y: s.y }, { x: mid.x - reach, y: mid.y }, mid),
    ...cubic(mid, { x: mid.x + reach, y: mid.y }, { x: e.x - reach, y: e.y }, e).slice(1)] }
}
const curved = [wire('c1', { x: 0, y: 0 }, { x: 400, y: 0 }), wire('c2', { x: 0, y: 100 }, { x: 400, y: 100 })]
// c1 hangs to y = 40 at x = 200; its straight chord (y = 0) is not where it is drawn
ok('a curved wire is cut where it is drawn, not along its chord', m.knifeCuts({ x: 200, y: 20 }, { x: 200, y: 60 }, curved).map((c) => c.id).join() === 'c1')
ok('and the cut sits on the curve', Math.abs(m.knifeCuts({ x: 200, y: 20 }, { x: 200, y: 60 }, curved)[0].y - 40) < 0.5)
ok('a line across the chord but short of the sag misses it', m.knifeCuts({ x: 200, y: -10 }, { x: 200, y: 25 }, curved).length === 0)
ok('a line 10px beside a wire misses it', m.knifeCuts({ x: 190, y: 50 }, { x: 210, y: 50 }, curved).length === 0)
ok('a line stopping 3px short of a wire still cuts it', m.knifeCuts({ x: 200, y: 80 }, { x: 200, y: 43 }, curved).map((c) => c.id).join() === 'c1')
ok('a line stopping 10px short does not', m.knifeCuts({ x: 200, y: 80 }, { x: 200, y: 50 }, curved).length === 0)
ok('one line down through both curves cuts both, nearest first', m.knifeCuts({ x: 200, y: -20 }, { x: 200, y: 200 }, curved).map((c) => c.id).join() === 'c1,c2')
ok('the tolerance can be tightened', m.knifeCuts({ x: 200, y: 80 }, { x: 200, y: 43 }, curved, 2).length === 0)

// one wire: an insert
let p = patch([['s', 'sound'], ['o', 'output', 600]], [['s', 'o', 'in-0']])
ok('an effect on one wire splices', m.knifeMode(p, ['s-o-in-0'], 'filter') === 'splice')
ok('and so does a bus', m.knifeMode(p, ['s-o-in-0'], 'bus') === 'splice')
add(p, ['s-o-in-0'], 'f', 'filter')
ok('one wire: A → new → B, the lane kept', wires(p) === 'f>o s>f' && has(p, 'f', 'o', 'in-0') && has(p, 's', 'f', 'in'), wires(p))

// several into one target: a bus gathers them, other lanes stay
p = patch([['a', 'sound'], ['b', 'sound', 0, 200], ['c', 'sound', 0, 400], ['d', 'sound', 0, 600], ['o', 'output', 900]],
  [['a', 'o', 'in-0'], ['b', 'o', 'in-1'], ['c', 'o', 'in-2'], ['d', 'o', 'in-3']])
const three = ['c-o-in-2', 'b-o-in-1', 'a-o-in-0']
ok('several wires into one node: a bus gathers', m.knifeMode(p, three, 'bus') === 'gather' && m.knifeMode(p, three, 'stack') === 'gather')
ok('an effect goes on each', m.knifeMode(p, three, 'filter') === 'each')
const made = add(p, three, 'bus1', 'bus', 400, 100)
ok('the bus takes each source in, in lane order', has(p, 'a', 'bus1', 'in-0') && has(p, 'b', 'bus1', 'in-1') && has(p, 'c', 'bus1', 'in-2'), wires(p))
ok('and plays into their first lane, one lane for three', has(p, 'bus1', 'o', 'in-0') && p.edges.filter((e) => e.target === 'o').length === 2, wires(p))
ok('the lane it didn\'t cut is untouched', has(p, 'd', 'o', 'in-3'))
ok('the bus is the new selection', made?.join() === 'bus1')
ok('no loop', acyclic(p))

// a one-input effect on several wires: a copy on each
p = patch([['a', 'sound', -300], ['b', 'sound', -300, 400], ['x', 'filter', 700], ['y', 'delay', 700, 400]], [['a', 'x', 'in'], ['b', 'y', 'in']])
const each = add(p, [{ id: 'a-x-in', x: 300, y: 60 }, { id: 'b-y-in', x: 300, y: 460 }], 'r', 'reverb')
ok('an effect on two wires makes two', each?.length === 2 && p.nodes.filter((n) => n.type === 'reverb').length === 2, JSON.stringify(each))
ok('each spliced into its own wire', has(p, 'a', 'r', 'in') && has(p, 'r', 'x', 'in') && has(p, 'b', each[1], 'in') && has(p, each[1], 'y', 'in'), wires(p))
ok('each sitting on its cut', p.nodes.find((n) => n.id === each[1]).y === 400 && p.nodes.find((n) => n.id === 'r').x === 175)
ok('no loop there either', acyclic(p))

// rejections
ok('a bus can\'t gather wires going to different places', m.knifeMode(p, ['a-x-in', 'b-y-in'], 'bus') === null)
ok('a source can\'t sit inline', m.knifeMode(p, ['a-x-in'], 'sound') === null && m.knifeMode(p, ['a-x-in'], 'pattern') === null)
ok('nor can the output', m.knifeMode(p, ['a-x-in'], 'output') === null)
ok('no wires, nothing', m.knifeMode(p, [], 'filter') === null && m.knifeMode(p, ['nope'], 'filter') === null)
p = patch([['s', 'sound'], ['k', 'sound'], ['sc', 'sidechain', 600]], [['s', 'sc', 'in-0'], ['k', 'sc', 'in-1']])
ok('a bus won\'t merge a sidechain\'s sound and trigger', m.knifeMode(p, ['s-sc-in-0', 'k-sc-in-1'], 'bus') === null)
const before = JSON.stringify(p)
p.nodes.push({ id: 'b', type: 'bus', x: 0, y: 0, data: {} })
ok('a refused insert changes no wires', m.knifeInsert(p, ['s-sc-in-0', 'k-sc-in-1'], 'b') === null && JSON.stringify(p.edges) === JSON.stringify(JSON.parse(before).edges))

// wires inside a collapsed frame are left alone
p = patch([['s', 'sound'], ['f', 'filter', 300], ['o', 'output', 900]], [['s', 'f', 'in'], ['f', 'o', 'in-0']])
p.frames = [{ id: 'fr', x: -10, y: -10, w: 600, h: 200, collapsed: true, members: ['s', 'f'] }]
ok('a wire hidden in a collapsed frame can\'t be cut', m.knifeMode(p, ['s-f-in'], 'delay') === null)
ok('one drawn to its edge cuts the real wire', add(p, ['f-o-in-0'], 'd', 'delay') && has(p, 'f', 'd', 'in') && has(p, 'd', 'o', 'in-0'), wires(p))

// placed clear of what's there
p = patch([['s', 'sound', 0, 0], ['o', 'output', 600, 0], ['z', 'filter', 300, 0]], [['s', 'o', 'in-0']])
add(p, ['s-o-in-0'], 'n', 'delay', 300, 0)
ok('the new node is nudged off the one it landed on', Math.abs(p.nodes.find((n) => n.id === 'n').y) >= 120)

if (fails) { console.log(`\n${fails} failed`); process.exit(1) }
console.log('\nall passed')
