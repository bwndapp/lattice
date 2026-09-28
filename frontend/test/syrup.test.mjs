/**
 * Syrup's modulation targets: a layer's own pitch, old patches loading as they were, and
 * the processor moving one layer without the others. The processor runs here in node: its
 * source is evaluated with just enough of an AudioWorklet around it.
 */
import * as m from '../src/instruments/syrup/model.js'
import { SYRUP_DSP } from '../src/instruments/syrup/dsp.js'
import { DSP_BASE } from '../src/instruments/dsp.js'

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── an old patch, as a track saved it before these targets ──
const OLD = {
  v: 3,
  name: 'old one',
  layers: [
    { id: 'la', type: 'analog', on: true, level: 0.8, pan: 0.5, oct: -1, semi: 0, fine: 0, wave: 'sawtooth', pw: 0.5, table: 'basic', pos: 0, warp: 0, warpmode: 'none', unison: 1, detune: 0.1, spread: 0.6, fm: 0, ratio: 1, fmwave: 'sine', color: 'pink', lane: 0 },
    { id: 'lb', type: 'wavetable', on: true, level: 0.5, pan: 0.3, oct: 1, semi: 7, fine: 5, wave: 'sawtooth', pw: 0.5, table: 'vowel', pos: 0.4, warp: 0.2, warpmode: 'bend+', unison: 3, detune: 0.2, spread: 0.6, fm: 1, ratio: 2, fmwave: 'sine', color: 'pink', lane: 1 },
  ],
  amp: { attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.2 },
  lanes: [{ out: 'master', gain: 1, mute: false, effects: [] }, { out: 0, gain: 0.7, mute: false, effects: [] }, { out: 'master', gain: 1, mute: false, effects: [] }],
  modulators: [
    { id: 'm1', kind: 'lfo', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], mode: 'free', polarity: 'bi', grid: 8, sync: true, bars: 0.25, hz: 2 },
    { id: 'm2', kind: 'env', attack: 0.005, decay: 0.4, sustain: 0, release: 0.3 },
  ],
  routes: [
    { id: 'r1', src: 'm1', target: 'pitch', amt: 0.1 },
    { id: 'r2', src: 'm1', target: 'layer:lb.pos', amt: 0.5 },
    { id: 'r3', src: 'm2', target: 'amp.level', amt: -0.3 },
    { id: 'r4', src: 'm2', target: 'lane:1.gain', amt: 0.2 },
  ],
  mono: false,
  glide: 0,
  volume: 0.8,
}
const old = m.normalizePatch(JSON.parse(JSON.stringify(OLD)))
// what's new on it: the version, and each layer's unison blend at "all alike"
const OLD_NOW = { ...OLD, v: 4, layers: OLD.layers.map((l) => Object.fromEntries(Object.entries(l).flatMap(([k, v]) => (k === 'spread' ? [[k, v], ['blend', 0.5]] : [[k, v]])))) }
ok('an old patch normalises to itself, plus the new defaults', same(old, OLD_NOW), JSON.stringify(old))
ok('and again', same(m.normalizePatch(old), OLD_NOW))
const enc = m.encodePatch(old)
ok('new knobs it sends are only depths and blends, at their neutral values', Object.keys(enc).filter((k) => /_(depth|blend)$/.test(k)).every((k) => enc[k] === (/depth/.test(k) ? 1 : 0.5)))
ok('its knobs are the same slots', same(Object.keys(enc).filter((k) => !/_(depth|blend)$/.test(k)).sort(), [
  ...['la', 'lb'].flatMap((_, i) => ['level', 'pan', 'fine', 'pw', 'pos', 'warp', 'detune', 'spread', 'fm', 'ratio'].map((k) => `l${i}_${k}`)),
  'd0_hz', 'd1_attack', 'd1_decay', 'd1_sustain', 'd1_release',
  'a_attack', 'a_decay', 'a_sustain', 'a_release', 'n0_gain', 'n1_gain', 'n2_gain', 'glide', 'volume', 'cps',
].sort()))
ok('every old slot is still an AudioParam', ['l7_ratio', 'l0_level', 'd15_hz', 'd15_release', 'a_release', 'n2_gain', 'glide', 'volume', 'cps'].every((k) => m.AUDIO_PARAMS.some((p) => p.key === k)))
{
  const at = (key) => m.AUDIO_PARAMS.findIndex((p) => p.key === key)
  ok('the old slots keep their order', at('l0_level') === 0 && at('l7_ratio') === 79 && at('d0_hz') === 80 && at('cps') === 80 + 16 * 5 + 4 + 3 + 2)
}

// ── a layer's pitch ──
const withPitch = m.normalizePatch({ ...OLD, routes: [...OLD.routes, { id: 'r5', src: 'm1', target: 'layer:la.pitch', amt: 0.25 }] })
ok('a layer pitch route is kept', withPitch.routes.some((r) => r.target === 'layer:la.pitch' && r.amt === 0.25))
const spec = m.targetSpec(withPitch, 'layer:la.pitch')
ok('it is named for its layer', spec?.label === 'A pitch', spec?.label)
ok('about ±48 semitones', spec?.spec.min === -48 && spec?.spec.max === 48)
ok('its base is the octave and semitones', spec?.get(withPitch) === -12 && m.targetSpec(withPitch, 'layer:lb.pitch').get(withPitch) === 19)
ok('fine is still its own target', m.targetSpec(withPitch, 'layer:la.fine')?.label === 'A fine')
const junk = m.normalizePatch({ ...OLD, routes: [...OLD.routes, { src: 'm1', target: 'layer:nope.pitch' }, { src: 'm1', target: 'layer:la.octave' }, { src: 'm1', target: 42 }] })
ok('bad targets are dropped', same(junk.routes, OLD.routes))
ok('pitch is not an AudioParam slot', !m.AUDIO_PARAMS.some((p) => p.key.endsWith('_pitch')) && !('l0_pitch' in m.encodePatch(withPitch)))
{
  const msg = m.patchMessage(withPitch)
  const dests = msg.routes.map((r) => r[1])
  ok('every route has its own destination', new Set(dests).size === dests.length && dests.every((d) => d > 0 && d < m.DEST_COUNT))
}

// ── the processor ──
globalThis.sampleRate = 48000
globalThis.currentTime = 0
let Processor = null
globalThis.registerProcessor = (name, cls) => { if (name === 'lattice-syrup') Processor = cls }
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} } } }
new Function(DSP_BASE + SYRUP_DSP)() // eslint-disable-line no-new-func

const makeProc = (patch) => {
  const proc = new Processor({})
  const knobs = m.encodePatch(patch)
  for (const kn of Processor.knobs) proc.k[kn.key] = kn.key in knobs ? knobs[kn.key] : kn.def
  proc.onData(m.patchMessage(patch))
  proc.beginBlock(128)
  return proc
}
const freqs = (patch) => {
  const proc = makeProc(patch)
  const v = proc.voices[0]
  proc.noteOn(v, 60, 1)
  proc.control(v, 0)
  return v.ctl.layers.slice(0, patch.layers.length).map((L) => L.freq)
}
// an up lfo stuck at its top (a flat line at 1), so it pushes by all of amt
const flat = { id: 'mf', kind: 'lfo', points: [{ x: 0, y: 1 }, { x: 1, y: 1 }], mode: 'retrig', polarity: 'up', sync: false, hz: 1 }
const two = { ...OLD, layers: OLD.layers.map((l) => ({ ...l, oct: 0, semi: 0, fine: 0 })), modulators: [flat], routes: [] }
const still = freqs(m.normalizePatch(two))
ok('unmoved, both layers play the note', Math.abs(still[0] - 261.63) < 0.01 && Math.abs(still[1] - 261.63) < 0.01, still)
const moved = freqs(m.normalizePatch({ ...two, routes: [{ id: 'x', src: 'mf', target: 'layer:la.pitch', amt: 12 / 96 }] }))
ok("moving A's pitch moves A an octave", Math.abs(moved[0] / still[0] - 2) < 1e-3, moved)
ok('and leaves B where it was', Math.abs(moved[1] - still[1]) < 1e-9, moved)
const base = freqs(m.normalizePatch({ ...two, layers: two.layers.map((l, i) => (i ? l : { ...l, semi: 7 })) }))
ok("A's semitones are the base it moves from", Math.abs(base[0] / still[0] - 2 ** (7 / 12)) < 1e-3)

// ── the amp envelope and glide ──
{
  const p = m.normalizePatch({ ...two, routes: [{ id: 'a', src: 'mf', target: 'amp.attack', amt: 0.5 }, { id: 'g', src: 'mf', target: 'glide', amt: 0.5 }, { id: 's', src: 'mf', target: 'amp.sustain', amt: -0.5 }] })
  ok('amp times and glide are targets', p.routes.length === 3 && m.targetSpec(p, 'amp.release')?.label === 'amp release' && m.targetSpec(p, 'glide')?.get(p) === 0)
  const proc = makeProc(p)
  const v = proc.voices[0]
  proc.noteOn(v, 60, 1)
  proc.control(v, 0)
  const aSpec = m.K.attack
  const want = aSpec.min * (aSpec.max / aSpec.min) ** (Math.log(p.amp.attack / aSpec.min) / Math.log(aSpec.max / aSpec.min) + 0.5)
  ok('a route stretches this voice\'s attack', Math.abs(v.ctl.aA - want) < 1e-6, v.ctl.aA)
  ok('and moves its sustain and glide', Math.abs(v.ctl.aS - 0.3) < 1e-6 && v.ctl.glide > 0)
  const plain = makeProc(m.normalizePatch(two))
  plain.noteOn(plain.voices[0], 60, 1)
  plain.control(plain.voices[0], 0)
  const c = plain.voices[0].ctl
  ok('unrouted, the amp is its knobs', c.aA === plain.k.a_attack && c.aS === plain.k.a_sustain && c.glide === 0)
}

// ── modulators moving modulators ──
{
  const lfo = (id, over = {}) => ({ id, kind: 'lfo', points: [{ x: 0, y: 1 }, { x: 1, y: 1 }], mode: 'retrig', polarity: 'up', sync: false, hz: 1, ...over })
  const env = (id) => ({ id, kind: 'env', attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.2 })
  const p0 = { ...two, modulators: [lfo('a'), lfo('b'), env('c')], routes: [{ id: 'ab', src: 'a', target: 'mod:b.rate', amt: 0.5 }, { id: 'bp', src: 'b', target: 'layer:la.pitch', amt: 0.1 }] }
  const p = m.normalizePatch(p0)
  ok('an lfo can move another\'s rate', p.routes.length === 2 && m.targetSpec(p, 'mod:b.rate')?.label === 'lfo 2 rate', m.targetSpec(p, 'mod:b.rate')?.label)
  ok('and depth, and an envelope\'s stages', ['mod:b.depth', 'mod:c.depth', 'mod:c.attack', 'mod:c.release'].every((t) => m.targetSpec(p, t)) && !m.targetSpec(p, 'mod:c.rate') && !m.targetSpec(p, 'mod:b.attack'))
  ok('a modulator can\'t move itself', !m.normalizePatch({ ...p0, routes: [{ id: 'x', src: 'a', target: 'mod:a.rate', amt: 0.5 }] }).routes.length)
  ok('nor round a loop', m.normalizePatch({ ...p0, routes: [...p0.routes, { id: 'ba', src: 'b', target: 'mod:a.depth', amt: 0.5 }] }).routes.length === 2)
  ok('nor a longer one', m.routeLoops(m.normalizePatch({ ...p0, routes: [...p0.routes, { id: 'bc', src: 'b', target: 'mod:c.depth', amt: 0.5 }] }), 'c', 'mod:a.rate'))
  ok('a chain without a loop is fine', !m.routeLoops(p, 'c', 'mod:a.rate') && !m.routeLoops(p, 'a', 'mod:c.decay'))
  const amt = m.normalizePatch({ ...p0, routes: [...p0.routes, { id: 'ca', src: 'c', target: 'route:bp.amt', amt: 0.5 }] })
  ok('a route\'s amount is a target', amt.routes.length === 3 && m.targetSpec(amt, 'route:bp.amt')?.label === 'lfo 2 → A pitch amount', m.targetSpec(amt, 'route:bp.amt')?.label)
  ok('but not from its own source', m.routeLoops(amt, 'b', 'route:bp.amt'))
  ok('nor from what the route moves', m.routeLoops(p, 'b', 'route:ab.amt'))
  ok('nor another route-amount route', m.routeLoops(amt, 'a', 'route:ca.amt'))
  ok('routes to routes load even when listed first', m.normalizePatch({ ...amt, routes: [...amt.routes].reverse() }).routes.length === 3)
  ok('a route to a gone route is dropped', m.normalizePatch({ ...p0, routes: [...p0.routes, { id: 'z', src: 'c', target: 'route:nope.amt', amt: 1 }] }).routes.length === 2)
  const pruned = m.pruneRoutes({ ...JSON.parse(JSON.stringify(amt)), modulators: amt.modulators.filter((x) => x.id !== 'b') })
  ok('removing a modulator takes the routes to it and to its routes', pruned.routes.length === 0, JSON.stringify(pruned.routes))
  ok('the order works movers out first', (() => { const o = m.modOrder(amt); return o.indexOf(0) < o.indexOf(1) })())
  ok('including what moves the amounts of routes into it', (() => { const o = m.modOrder(m.normalizePatch({ ...p0, modulators: [lfo('b'), env('c'), lfo('a')], routes: [...p0.routes, { id: 'ca', src: 'c', target: 'route:ab.amt', amt: 0.5 }] })); return o.indexOf(1) < o.indexOf(0) && o.indexOf(2) < o.indexOf(0) })())
  ok('depth is kept, and only when it isn\'t 1', m.normalizePatch({ ...p0, modulators: [lfo('a', { depth: 0.25 }), lfo('b', { depth: 1 })] }).modulators.map((x) => x.depth).join() === '0.25,')
  ok('depth is automatable', m.knobAt(m.normalizePatch(p0), 'Mc_depth')?.value === 1 && m.AUDIO_PARAMS.some((x) => x.key === 'd15_depth'))

  // in the processor: lfo b pushes A's pitch; a doubles b's rate, c's env scales the amount
  const runA = (patch, blocks = 20) => {
    const proc = makeProc(m.normalizePatch(patch))
    const v = proc.voices[0]
    proc.noteOn(v, 60, 1)
    for (let i = 0; i < blocks; i++) proc.control(v, 0)
    return { proc, v }
  }
  const tri = [{ x: 0, y: 0 }, { x: 1, y: 1 }] // a ramp: its value says how far it has come
  const slow = runA({ ...p0, modulators: [lfo('a'), lfo('b', { points: tri, hz: 1 })], routes: [] }).v.modPh[1]
  const fast = runA({ ...p0, modulators: [lfo('a'), lfo('b', { points: tri, hz: 1 })], routes: [{ id: 'ab', src: 'a', target: 'mod:b.rate', amt: Math.log(2) / Math.log(m.K.hz.max / m.K.hz.min) }] }).v.modPh[1]
  ok('moving an lfo\'s rate speeds it up', Math.abs(fast / slow - 2) < 0.02, `${slow} ${fast}`)
  const deep = runA({ ...p0, modulators: [lfo('a'), lfo('b', { depth: 0 })], routes: [{ id: 'bp', src: 'b', target: 'layer:la.pitch', amt: 12 / 96 }, { id: 'ab', src: 'a', target: 'mod:b.depth', amt: 1 }] })
  ok('depth at 0, raised by a route, lets it through', Math.abs(deep.v.ctl.layers[0].freq / still[0] - 2) < 1e-3, deep.v.ctl.layers[0].freq)
  const none = runA({ ...p0, modulators: [lfo('a'), lfo('b', { depth: 0 })], routes: [{ id: 'bp', src: 'b', target: 'layer:la.pitch', amt: 12 / 96 }] })
  ok('and without it nothing moves', Math.abs(none.v.ctl.layers[0].freq - still[0]) < 1e-9)
  const scaled = runA({ ...p0, modulators: [lfo('a'), lfo('b')], routes: [{ id: 'bp', src: 'b', target: 'layer:la.pitch', amt: 0 }, { id: 'ab', src: 'a', target: 'route:bp.amt', amt: 12 / 96 / 2 }] })
  ok('a route to an amount turns it up', Math.abs(scaled.v.ctl.layers[0].freq / still[0] - 2) < 1e-3, scaled.v.ctl.layers[0].freq)
  const envMoved = runA({ ...p0, modulators: [lfo('a'), env('c')], routes: [{ id: 'ac', src: 'a', target: 'mod:c.sustain', amt: -0.5 }, { id: 'cp', src: 'c', target: 'layer:la.level', amt: 0.1 }] }, 1500)
  ok('an envelope\'s sustain moves', Math.abs(envMoved.v.envs[1].v - 0) < 1e-3, envMoved.v.envs[1].v)
}

// ── supersaws become analog saws with unison ──
{
  const saw = { id: 'ss', type: 'supersaw', on: true, level: 0.7, pan: 0.5, oct: 0, semi: 0, fine: 0, wave: 'sine', pw: 0.5, table: 'basic', pos: 0, warp: 0, warpmode: 'none', unison: 9, detune: 0.45, spread: 0.8, fm: 0, ratio: 1, fmwave: 'sine', color: 'pink', lane: 0 }
  const oldSaw = { ...OLD, layers: [saw, { ...OLD.layers[0], unison: 5 }], routes: [{ id: 'r1', src: 'm1', target: 'layer:ss.detune', amt: 0.3 }, { id: 'r2', src: 'm1', target: 'layer:ss.spread', amt: 0.2 }] }
  const p = m.normalizePatch(JSON.parse(JSON.stringify(oldSaw)))
  const L = p.layers[0]
  ok('an old supersaw loads as an analog saw', L.type === 'analog' && L.wave === 'sawtooth' && L.id === 'ss')
  ok('with its voices, detune and spread', L.unison === 9 && L.detune === 0.45 && L.spread === 0.8 && L.blend === 0.5 && L.level === 0.7)
  ok('its routes still reach it', p.routes.length === 2 && p.routes.every((r) => m.targetSpec(p, r.target)))
  ok('an old analog layer stays one voice', p.layers[1].unison === 1)
  ok('a new one keeps its voices', m.normalizePatch(p).layers[0].unison === 9 && m.normalizePatch({ ...p, layers: [{ ...p.layers[1], unison: 5 }] }).layers[0].unison === 5)
  const bare = m.normalizePatch({ layers: [{ type: 'supersaw' }] }).layers[0]
  ok('a bare supersaw gets a supersaw\'s defaults', bare.unison === 7 && bare.detune === 0.18 && bare.type === 'analog')
  ok('supersaw is no longer a type to add', !m.LAYER_TYPES.includes('supersaw'))
  ok('the presets have none', m.PRESETS.every((x) => x.layers.every((l) => l.type !== 'supersaw')))
  ok('blend is a target', m.targetSpec(p, 'layer:ss.blend')?.label === 'A blend')

  // and it sounds the same: the old supersaw's message against the new analog one
  const render = (msg) => {
    const patch = m.normalizePatch({ ...oldSaw, routes: [] })
    const proc = makeProc(patch)
    proc.onData(msg)
    let seed = 1
    const rnd = Math.random
    Math.random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const v = proc.voices[0]
    proc.noteOn(v, 48, 1)
    Math.random = rnd
    const outL = new Float32Array(512)
    const outR = new Float32Array(512)
    proc.render(v, outL, outR, 0, 512)
    return [...outL, ...outR]
  }
  const patch = m.normalizePatch({ ...oldSaw, routes: [] })
  const now = m.patchMessage(patch)
  const was = JSON.parse(JSON.stringify(now))
  was.layers[0][1] = 1 // the processor's old supersaw
  was.layers[1][8] = 1
  const a = render(now)
  const b = render(was)
  ok('an old supersaw sounds exactly as it did', a.every((x, i) => x === b[i]) && a.some((x) => x !== 0))
}

if (fails) { console.log(`${fails} failed`); process.exit(1) }
console.log('all passed')
