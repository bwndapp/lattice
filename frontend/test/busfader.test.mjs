/**
 * A mixer bus's knobs: its level and pan on the summed sound, and the level knob beside
 * each input. Turning any of them has to survive the trip through the project (every edit
 * is normalized) and come out as gain on the sound, for one input and for several.
 *
 * The audio side runs against a small stand-in for Web Audio that only keeps track of
 * what is connected to what and at which gain, so the loudness from a bus to the speakers
 * can be read off it.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-busfader-'))
const entry = path.join(dir, 'entry.js')
const out = path.join(dir, 'bundle.mjs')
const shim = path.join(dir, 'shim.js')
fs.writeFileSync(shim, `
class Param { constructor(v) { this.value = v } setTargetAtTime(v) { this.value = v } setValueAtTime(v) { this.value = v } linearRampToValueAtTime(v) { this.value = v } cancelScheduledValues() {} }
class Node {
  constructor() { this.outs = new Set() }
  connect(n) { this.outs.add(n); return n }
  disconnect(n) { if (n) this.outs.delete(n); else this.outs.clear() }
}
export class GainNode extends Node { constructor(ac, o = {}) { super(); this.gain = new Param(o.gain ?? 1) } }
class StereoPannerNode extends Node { constructor(ac, o = {}) { super(); this.pan = new Param(o.pan ?? 0) } }
class Other extends Node { constructor() { super(); return new Proxy(this, { get: (t, k) => (k in t || typeof k !== 'string' || k === 'then' ? t[k] : (t[k] = new Param(0))) }) } }
globalThis.GainNode = GainNode
globalThis.StereoPannerNode = StereoPannerNode
for (const name of ['BiquadFilterNode', 'ChannelMergerNode', 'ChannelSplitterNode', 'DelayNode', 'WaveShaperNode']) globalThis[name] = class extends Other {}
export const destination = new Node()
const ac = { currentTime: 0, destination }
class Orbit { constructor() { this.output = new GainNode(ac); this.summingNode = new GainNode(ac); this.summingNode.connect(this.output) } }
const controller = {
  nodes: {},
  output: { connectToDestination(input) { input.connect(destination) } },
  getOrbit(n) { if (this.nodes[n] == null) { this.nodes[n] = new Orbit(); this.output.connectToDestination(this.nodes[n].output) } return this.nodes[n] },
}
export const getAudioContext = () => ac
export const getSuperdoughAudioController = () => controller
export const registerSound = () => {}
export const superdough = () => {}
export const samples = () => {}
export const applyGainCurve = (v) => v
`)
const src = (f) => JSON.stringify(path.join(here, '..', 'src', f))
fs.writeFileSync(entry, [
  `export { normalizeProject, generateCode, auditionCode } from ${src('project.js')}`,
  `export { appParam } from ${src('automation.js')}`,
  `export { autoDriver, autoTargets } from ${src('autoDrive.js')}`,
  `export { setInsertParams } from ${src('stereo.js')}`,
  `export { graphCode, defaultData } from ${src('graph.js')}`,
  `export { GainNode, destination, getSuperdoughAudioController } from ${JSON.stringify(shim)}`,
].join('\n'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
  `--alias:@strudel/webaudio=${shim}`, '--main-fields=module,main', '--resolve-extensions=.js,.mjs,.jsx', `--outfile=${out}`,
])
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: {} }
// the page has had its click, so the app may make sound
Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { hasBeenActive: true } }, configurable: true })
const m = await import(pathToFileURL(out))
fs.rmSync(dir, { recursive: true, force: true })

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const patterns = [1, 2, 3].map((i) => ({ id: `p${i}`, name: `p${i}`, bars: 1, channels: [{ id: `c${i}`, kind: 'drum', sound: 'bd', steps: '1 0 0 0', mute: false }] }))
/** `n` patterns into a mixer bus (the first through an eq, when `eq`), into the output. */
const patch = (n, bus, { eq = false } = {}) => m.normalizeProject({
  bpm: 120, beats: 4, patterns, song: { on: false, clips: [] },
  nodes: [
    ...patterns.slice(0, n).map((p, i) => ({ id: `a${i}`, type: 'pattern', x: 0, y: 0, data: { patternId: p.id } })),
    ...(eq ? [{ id: 'eq', type: 'eq3', x: 0, y: 0, data: m.defaultData('eq3') }] : []),
    { id: 'bus', type: 'bus', x: 0, y: 0, data: { ...m.defaultData('bus'), ...bus } },
    { id: 'out', type: 'output', x: 0, y: 0, data: { muted: {} } },
  ],
  edges: [
    ...patterns.slice(0, n).map((p, i) => (eq && i === 0
      ? { id: `e${i}`, source: `a${i}`, target: 'eq', targetHandle: 'in-0' }
      : { id: `e${i}`, source: `a${i}`, target: 'bus', targetHandle: `in-${i}` })),
    ...(eq ? [{ id: 'eeq', source: 'eq', target: 'bus', targetHandle: 'in-0' }] : []),
    { id: 'eo', source: 'bus', target: 'out', targetHandle: 'in-0' },
  ],
})
const busOf = (p) => p.nodes.find((n) => n.type === 'bus')
const all = (n, v) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}:out`, v]))

// the level beside each input is kept through an edit (the project is normalized each time)
for (const n of [1, 3]) {
  const p = patch(n, { chan: all(n, 0.2) })
  ok(`${n} input(s): each input's level is kept`, JSON.stringify(busOf(p).data.chan) === JSON.stringify(all(n, 0.2)), JSON.stringify(busOf(p).data))
  const again = m.normalizeProject(JSON.parse(JSON.stringify(p)))
  ok(`${n} input(s): and kept again after a reload`, JSON.stringify(busOf(again).data.chan) === JSON.stringify(all(n, 0.2)))
  const code = m.generateCode(p)
  const turned = code.match(/\.mul\(gain\(0\.2\)\)\.orbit\(\d+\)/g) ?? []
  ok(`${n} input(s): the code turns every input down to 0.2`, turned.length === n, code.split('\n').filter((l) => l.includes('orbit')).join(' | '))
}
ok('an untouched bus keeps no levels', !('chan' in busOf(patch(2, {})).data))
ok('a level out of range is held to the knob', busOf(patch(1, { chan: { 'a0:out': 9 } })).data.chan?.['a0:out'] === 1.5)

// what reaches the speakers from each bus a sound lands on
const ctl = m.getSuperdoughAudioController()
const reach = (node, seen = new Set()) => {
  if (node === m.destination) return 1
  if (seen.has(node)) return 0
  let g = 0
  for (const o of node.outs) g += reach(o, new Set([...seen, node]))
  return g * (node instanceof m.GainNode ? node.gain.value : 1)
}
const heard = (p) => {
  const { lines } = m.graphCode(p, {})
  const orbits = [...new Set([...lines.join('\n').matchAll(/\.orbit\((\d+)\)/g)].map((x) => Number(x[1])))]
  for (const o of orbits) ctl.getOrbit(o) // a note lands on each
  return orbits.map((o) => reach(ctl.nodes[o].summingNode))
}
const near = (a, b) => Math.abs(a - b) < 1e-9

for (const n of [1, 3]) {
  ok(`${n} input(s): full level before the knob moves`, heard(patch(n, { vol: 1 })).every((g) => near(g, 1)))
  ok(`${n} input(s): the bus level at 0.2 turns the sum down to 0.2, live`, heard(patch(n, { vol: 0.2 })).every((g) => near(g, 0.2)))
}
// a channel with its own bus (through an eq) plays into the mixer bus at its level
const routed = heard(patch(3, { vol: 0.5, chan: { 'eq:out': 0.2 } }, { eq: true }))
ok('a channel on its own bus is turned down by its level and the bus level', routed.length === 2 && routed.some((g) => near(g, 0.1)) && routed.some((g) => near(g, 0.5)), JSON.stringify(routed))

// automation turns the bus level down while the song plays; hearing a note in the piano
// roll (an audition through the patch) must leave it there, not put the knob's own level back
{
  const p = patch(1, { vol: 1 })
  const orbits = [...new Set([...m.graphCode(p, {}).lines.join('\n').matchAll(/\.orbit\((\d+)\)/g)].map((x) => Number(x[1])))]
  for (const o of orbits) ctl.getOrbit(o)
  const level = () => orbits.map((o) => reach(ctl.nodes[o].summingNode))
  const app = m.appParam(p, 'n:bus:vol')
  m.setInsertParams(app.key, { [app.param]: 0.3 })
  ok('automation moves the bus level', level().every((g) => near(g, 0.3)), JSON.stringify(level()))
  ok('the audition goes through the patch', /orbit/.test(m.auditionCode(p, 'p1', 'c1') ?? ''))
  ok('a note heard in the piano roll leaves the automated bus level where it was', level().every((g) => near(g, 0.3)), JSON.stringify(level()))
}

// picking a note in the piano roll (or a drag that ends where it began) regenerates the code
// without changing the project: the bus level has to stay on its curve, not go back to the
// knob, and keep following the curve after that
{
  const base = patch(1, { vol: 1 })
  const p = m.normalizeProject({ ...base, song: { on: true, clips: [{ id: 'k', src: 'auto:v', start: 0, len: 4 }], autos: [{ id: 'v', target: 'n:bus:vol', bars: 4, points: [{ x: 0, y: 0.2 }, { x: 4, y: 0.2 }] }] } })
  const orbits = [...new Set([...m.generateCode(p).matchAll(/\.orbit\((\d+)\)/g)].map((x) => Number(x[1])))]
  for (const o of orbits) ctl.getOrbit(o)
  const level = () => orbits.map((o) => reach(ctl.nodes[o].summingNode))
  const driver = m.autoDriver(m.autoTargets(p), () => 1)
  driver.tick()
  ok('the curve turns the bus level to 0.3', level().every((g) => near(g, 0.3)), JSON.stringify(level()))
  m.generateCode(p) // the note picked: same notes, same code
  ok('a no-change edit leaves the automated bus level on its curve', level().every((g) => near(g, 0.3)), JSON.stringify(level()))
  driver.tick()
  ok('and the song keeps it there', level().every((g) => near(g, 0.3)), JSON.stringify(level()))
  driver.stop()
  ok('stopping puts the knob back where it is set', level().every((g) => near(g, 1)), JSON.stringify(level()))
  m.generateCode(p)
  ok('a stopped driver no longer moves it', level().every((g) => near(g, 1)), JSON.stringify(level()))
}

console.log(fails ? `\n${fails} failing` : '\nall good')
process.exit(fails ? 1 : 0)
