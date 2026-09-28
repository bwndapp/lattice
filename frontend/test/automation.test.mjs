/**
 * Automation reaches every effect on the bus: a lane drawn on any knob of a bus effect has a
 * way to move it while the song plays (automation.js `APP_PARAMS`, or the code for the few
 * that ride on each note), and the parameter it moves is one the effect really reads.
 *
 * Distortion, pitch and freq shift had no way (docs/plans/fx-plugin-plan.md, mess item 5):
 * their lanes drew but the sound stood still. Each of their knobs is checked end to end
 * here, against a small stand-in for Web Audio: the patch is played, the automation turns
 * the knob, and something on the audio graph has to move.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-automation-'))
const entry = path.join(dir, 'entry.js')
const out = path.join(dir, 'bundle.mjs')
const shim = path.join(dir, 'shim.js')
fs.writeFileSync(shim, `
export class Param { constructor(v) { this.value = v } setTargetAtTime(v) { this.value = v } setValueAtTime(v) { this.value = v } linearRampToValueAtTime(v) { this.value = v } cancelScheduledValues() {} }
export const made = [] // every node made, sources included (a bias is a source feeding in)
class Node {
  constructor() { this.outs = new Set(); made.push(this) }
  connect(n) { this.outs.add(n); return n }
  disconnect(n) { if (n) this.outs.delete(n); else this.outs.clear() }
}
// any other node: its AudioParams appear as they're asked for
class Other extends Node {
  constructor() { super(); return new Proxy(this, { get: (t, k) => (k in t || typeof k !== 'string' || k === 'then' ? t[k] : (t[k] = new Param(0))) }) }
  start() {}
  stop() {}
}
export class GainNode extends Node { constructor(ac, o = {}) { super(); this.gain = new Param(o.gain ?? 1) } }
export class AudioWorkletNode extends Node {
  constructor(ac, name) { super(); this.name = name; const ps = new Map(); this.parameters = { get: (k) => (ps.has(k) ? ps.get(k) : (ps.set(k, new Param(0)), ps.get(k))), all: ps } }
}
globalThis.GainNode = GainNode
globalThis.AudioWorkletNode = AudioWorkletNode
for (const name of ['StereoPannerNode', 'BiquadFilterNode', 'ChannelMergerNode', 'ChannelSplitterNode', 'DelayNode', 'WaveShaperNode', 'ConstantSourceNode', 'DynamicsCompressorNode', 'OscillatorNode', 'ConvolverNode']) globalThis[name] = class extends Other {}
export const destination = new Node()
const ac = { currentTime: 0, sampleRate: 48000, destination, audioWorklet: { addModule: async () => {} } }
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
  `export { normalizeProject } from ${src('project.js')}`,
  `export { graphCode, defaultData, NODE_TYPES, BUS_NODES, FX_UNITS } from ${src('graph.js')}`,
  `export { appParam, resolveTarget, nodeTarget, unitTarget } from ${src('automation.js')}`,
  `export { setInsertParams, prepareInserts } from ${src('stereo.js')}`,
  `export { Param, made, getSuperdoughAudioController } from ${JSON.stringify(shim)}`,
].join('\n'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
  `--alias:@strudel/webaudio=${shim}`, '--main-fields=module,main', '--resolve-extensions=.js,.mjs,.jsx', `--outfile=${out}`,
])
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: {} }
Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { hasBeenActive: true } }, configurable: true })
const m = await import(pathToFileURL(out))
fs.rmSync(dir, { recursive: true, force: true })

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const patterns = [{ id: 'p1', name: 'p1', bars: 1, channels: [{ id: 'c1', kind: 'drum', sound: 'bd', steps: '1 0 0 0', mute: false }] }]
/** One pattern through a node of `type` (or an fx rack holding one) into the output. */
const patch = (type, { rack = false } = {}) => m.normalizeProject({
  bpm: 120, beats: 4, patterns, song: { on: false, clips: [] },
  nodes: [
    { id: 'a', type: 'pattern', x: 0, y: 0, data: { patternId: 'p1' } },
    rack
      ? { id: 'fx', type: 'fxrack', x: 0, y: 0, data: { chain: [{ id: 'u1', type, on: true, data: m.defaultData(type) }] } }
      : { id: 'fx', type, x: 0, y: 0, data: m.defaultData(type) },
    { id: 'out', type: 'output', x: 0, y: 0, data: { muted: {} } },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'fx', targetHandle: 'in-0' },
    { id: 'e2', source: 'fx', target: 'out', targetHandle: 'in-0' },
  ],
})

// knobs whose automation rides on each note in the code instead (reverb and delay amounts)
const IN_CODE = new Set(['reverb:mix', 'delay:mix', 'space:room', 'space:delay'])

// every knob of every bus effect has a way to move while the song plays
for (const type of [...m.BUS_NODES].filter((t) => t !== 'bus').sort()) {
  const p = patch(type)
  const knobs = m.NODE_TYPES[type].params.filter((q) => q.type === 'knob')
  const missing = knobs.filter((q) => !IN_CODE.has(`${type}:${q.key}`) && !m.appParam(p, m.nodeTarget('fx', q.key)))
  ok(`${type}: every knob can be automated live`, !missing.length, missing.map((q) => q.key).join(', '))
  // …and moves something the unit actually reads
  const insert = m.NODE_TYPES[type].code.insert
  if (insert) {
    const reads = Object.keys(insert.params(m.defaultData(type)))
    const wrong = knobs.map((q) => m.appParam(p, m.nodeTarget('fx', q.key))).filter((a) => a && a.where === 'insert' && !reads.includes(a.param))
    ok(`${type}: automation moves a parameter the unit reads`, !wrong.length, wrong.map((a) => a.param).join(', '))
  }
}

/** Every AudioParam value on the audio graph, in a fixed order. */
function allParams() {
  const values = []
  for (const node of m.made) {
    for (const k of Object.keys(node).sort()) if (node[k] instanceof m.Param) values.push(node[k].value)
    if (node.parameters?.all) for (const k of [...node.parameters.all.keys()].sort()) values.push(node.parameters.all.get(k).value)
  }
  return values
}
const ctl = m.getSuperdoughAudioController()
/** Play the patch, turn one knob the way automation does, and see if the sound moved. */
async function moves(type, key, { rack = false } = {}) {
  const p = patch(type, { rack })
  const target = rack ? m.unitTarget('fx', 'u1', key) : m.nodeTarget('fx', key)
  const app = m.appParam(p, target)
  if (!app) return { moved: false, why: 'no app param' }
  const { lines } = m.graphCode(p, {})
  const orbit = Number(/\.orbit\((\d+)\)/.exec(lines.join('\n'))?.[1])
  ctl.getOrbit(orbit) // a note lands on it: the insert is mounted
  m.setInsertParams(app.key, {}) // mounts what was declared
  await m.prepareInserts()
  await new Promise((r) => setTimeout(r, 0)) // the worklet arrives
  const def = m.resolveTarget(p, target).def
  const at = (v) => { m.setInsertParams(app.key, { [app.param]: v * (app.scale ?? 1) }); return allParams() }
  const low = at(def.min)
  const high = at(def.max)
  return { moved: JSON.stringify(low) !== JSON.stringify(high), why: `${app.key}.${app.param}` }
}

for (const type of ['distortion', 'pitch', 'freqshift']) {
  for (const q of m.NODE_TYPES[type].params.filter((x) => x.type === 'knob')) {
    const r = await moves(type, q.key)
    ok(`${type} ${q.label}: a lane moves the sound`, r.moved, r.why)
  }
  const r = await moves(type, m.NODE_TYPES[type].params.find((x) => x.type === 'knob').key, { rack: true })
  ok(`${type} in an fx rack: a lane moves the sound`, r.moved, r.why)
}
// the check itself can tell: a knob that was always automated live moves, and nothing moves
// for a key the effect doesn't have
ok('control: a filter cutoff lane moves the sound', (await moves('filter', 'lpf')).moved)
ok('control: an unknown knob has nothing to move', !(await moves('distortion', 'nope')).moved)

console.log(fails ? `\n${fails} failing` : '\nall good')
process.exit(fails ? 1 : 0)
