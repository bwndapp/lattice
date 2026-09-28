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
ok('an old patch normalises to itself', same(old, OLD), JSON.stringify(old))
ok('and again', same(m.normalizePatch(old), OLD))
ok('its knobs are the same slots', same(Object.keys(m.encodePatch(old)).sort(), [
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

if (fails) { console.log(`${fails} failed`); process.exit(1) }
console.log('all passed')
