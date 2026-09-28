/**
 * Shift + A with one node selected wires the new node in: after a source or effect (and
 * into what it fed, when the new node passes sound on), or before the output (as an insert
 * on the master when it's an effect). It never makes a loop or a wire that can't be.
 *
 * Bundled with esbuild first, as solo.test.mjs does, since graph.js reaches for the
 * browser's audio on its way in.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-quickwire-'))
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

const patch = (nodes, edges = []) => ({ nodes: nodes.map(([id, type, x = 0, y = 0]) => ({ id, type, x, y, data: {} })), edges })
// add a node the way Graph.jsx does, then quick-wire it
const add = (p, sel, id, type) => { p.nodes.push({ id, type, x: 0, y: 0, data: {} }); return m.quickWire(p, sel, id) }
const has = (p, s, t, h) => p.edges.some((e) => e.source === s && e.target === t && (h == null || e.targetHandle === h))
const wires = (p) => p.edges.map((e) => `${e.source}>${e.target}`).sort().join(' ')

ok('a source takes the new node after it', m.quickSide({ type: 'sound' }) === 'after')
ok('the output takes it before', m.quickSide({ type: 'output' }) === 'before')
ok('nothing without an input goes after', !m.canQuickWire('sound', 'after') && !m.canQuickWire('pattern', 'after'))
ok('an effect, a bus or the output can go after', m.canQuickWire('filter', 'after') && m.canQuickWire('bus', 'after') && m.canQuickWire('output', 'after'))
ok('a second output never goes before one', !m.canQuickWire('output', 'before') && m.canQuickWire('pattern', 'before'))

// after a lone source
let p = patch([['s', 'sound', 0, 0]])
ok('after a source: wired and placed to its right', add(p, 's', 'f', 'filter') && has(p, 's', 'f', 'in') && p.nodes[1].x === 300 && p.nodes[1].y === 0)

// after an effect that already feeds the output: an insert
p = patch([['s', 'sound', 0, 0], ['f', 'filter', 300, 0], ['o', 'output', 600, 0]],
  [{ source: 's', target: 'f', targetHandle: 'in' }, { source: 'f', target: 'o', targetHandle: 'in-0' }])
add(p, 'f', 'd', 'delay')
ok('after an effect with a target: slotted in between', wires(p) === 'd>o f>d s>f' && has(p, 'd', 'o', 'in-0'), wires(p))
ok('and what sat to its right moves over', p.nodes.find((n) => n.id === 'o').x === 900 && p.nodes.find((n) => n.id === 'd').x === 600)

// a bus fed downstream, new node that can't pass sound on: a parallel wire
p = patch([['s', 'sound'], ['b', 'bus', 300], ['o', 'output', 600]], [{ source: 's', target: 'b', targetHandle: 'in-0' }, { source: 'b', target: 'o', targetHandle: 'in-0' }])
add(p, 'b', 'o2', 'output')
ok('after a bus, a node that can\'t pass on gets a parallel wire', has(p, 'b', 'o') && has(p, 'b', 'o2', 'in-0'), wires(p))

// before the output with an input already: an insert on the master
p = patch([['s', 'sound', 0, 0], ['t', 'sound', 0, 200], ['o', 'output', 600, 0]],
  [{ source: 's', target: 'o', targetHandle: 'in-0' }, { source: 't', target: 'o', targetHandle: 'in-1' }])
add(p, 'o', 'c', 'compressor')
ok('before the output: the effect goes into its last lane', has(p, 't', 'c', 'in') && has(p, 'c', 'o', 'in-1') && has(p, 's', 'o', 'in-0') && !has(p, 't', 'o'), wires(p))
ok('and sits to its left', p.nodes.find((n) => n.id === 'c').x === 300)

p = patch([['s', 'sound'], ['t', 'sound'], ['o', 'output', 600]],
  [{ source: 's', target: 'o', targetHandle: 'in-0' }, { source: 't', target: 'o', targetHandle: 'in-1' }])
add(p, 'o', 'b', 'bus')
ok('a bus before the output gathers every lane', wires(p) === 'b>o s>b t>b' && has(p, 'b', 'o', 'in-0'), wires(p))

p = patch([['s', 'sound'], ['o', 'output', 600]], [{ source: 's', target: 'o', targetHandle: 'in-0' }])
add(p, 'o', 'n', 'notes')
ok('a source before the output is one more lane', has(p, 's', 'o', 'in-0') && has(p, 'n', 'o', 'in-1'), wires(p))

p = patch([['o', 'output', 600, 40]])
add(p, 'o', 'n', 'notes')
ok('an empty output gets its first lane', has(p, 'n', 'o', 'in-0') && p.nodes[1].x === 240 && p.nodes[1].y === 40)

// no loops: chain a few, then each wire still flows one way
p = patch([['s', 'sound'], ['o', 'output', 900]], [{ source: 's', target: 'o', targetHandle: 'in-0' }])
let sel = 's'
for (const [id, type] of [['a', 'filter'], ['b', 'delay'], ['c', 'reverb']]) { add(p, sel, id, type); sel = id }
ok('chaining builds a straight line', wires(p) === 'a>b b>c c>o s>a', wires(p))
ok('with no loop in it', p.edges.every((e) => !m.makesCycle(p.edges.filter((x) => x !== e), e.source, e.target)))
ok('a wire that would loop is refused', (() => {
  const q = patch([['a', 'filter'], ['b', 'filter']], [{ source: 'a', target: 'b', targetHandle: 'in' }])
  // pretend 'b' is new and 'b' feeds 'a' already: selected a → b would close a loop
  q.edges = [{ source: 'b', target: 'a', targetHandle: 'in' }]
  return !m.quickWire(q, 'a', 'b') && q.edges.length === 1
})())

if (fails) { console.log(`\n${fails} failed`); process.exit(1) }
console.log('\nall passed')
