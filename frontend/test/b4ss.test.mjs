/**
 * B4SS: every preset makes a sound that's finite and not clipping, a note is in tune, an
 * 808's drop falls to the note, a slid note glides there without starting over, a wobble
 * moves in time, and a note let go stops. The processor runs here in node, its source
 * evaluated with just enough of an AudioWorklet around it.
 */
import { DSP_BASE } from '../src/instruments/dsp.js'
import kick from '../src/instruments/kick.js'
import physical from '../src/instruments/physical.js'
import spec from '../src/instruments/b4ss.js'

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}
const procs = {}
const sr = 48000
const env = { sampleRate: sr, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = {} } }, registerProcessor: (n, c) => { procs[n] = c } }
// beside the other engines, as the audio thread loads them: names mustn't clash
new Function(...Object.keys(env), DSP_BASE + kick.dsp + physical.dsp + spec.dsp)(...Object.values(env))
const Proc = procs['lattice-b4ss']
ok('registers', !!Proc)

/** notes: [{ at, note, len }] in seconds, all on voice 0 (as mono plays them). */
function run(knobs, { notes = [{ at: 0, note: 36, len: 0.5 }], secs = 1.2, song = null } = {}) {
  const p = new Proc({})
  if (song) p.song = song
  const B = 128
  const params = {}
  for (const k of Proc.knobs) params['p_' + k.key] = [knobs[k.key] ?? k.def]
  for (let v = 0; v < 6; v++) Object.assign(params, { [`v${v}_trig`]: [0], [`v${v}_note`]: [-1], [`v${v}_vel`]: [1], [`v${v}_gain`]: [1], [`v${v}_pan`]: [0.5], [`v${v}_gate`]: [0] })
  const L = []
  const Rr = []
  for (let b = 0; b < (secs * sr) / B; b++) {
    const t = (b * B) / sr
    let trig = 0, note = -1, gate = 0
    notes.forEach((n, i) => { if (t >= n.at) { trig = i + 1; note = n.note } if (t >= n.at && t < n.at + n.len) gate = 1 })
    params.v0_trig = [trig]; params.v0_note = [note]; params.v0_gate = [gate]
    const outs = Array.from({ length: 6 }, () => [new Float32Array(B), new Float32Array(B)])
    p.process([], outs, params)
    L.push(...outs[0][0]); Rr.push(...outs[0][1])
  }
  return { L, R: Rr }
}
const peak = (o) => o.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
const rms = (o) => Math.sqrt(o.reduce((s, x) => s + x * x, 0) / Math.max(1, o.length))
const hzOf = (o) => { let z = 0; for (let i = 1; i < o.length; i++) if (o[i - 1] < 0 && o[i] >= 0) z++; return z / (o.length / sr) }

// every preset: heard, finite, under clipping, and every value it sets is a real knob in range
for (const pr of spec.presets) {
  const bad = Object.entries(pr.data).filter(([k, v]) => { const d = spec.params.find((p) => p.key === k); return !d || v < d.min || v > d.max })
  ok(`preset ${pr.name}: knobs are real and in range`, !bad.length, JSON.stringify(bad))
  const { L, R } = run(pr.data, { notes: [{ at: 0, note: 36, len: 0.6 }], secs: 1 })
  const p = Math.max(peak(L), peak(R))
  ok(`preset ${pr.name}: sounds, finite, under clipping`, L.every(Number.isFinite) && R.every(Number.isFinite) && p > 0.05 && p < 0.99, p.toFixed(3))
}

// in tune: A2 = 110 Hz on a plain sine
{
  const { L } = run({ wave: 0, sustain: 1 }, { notes: [{ at: 0, note: 45, len: 1 }], secs: 1 })
  const hz = hzOf(L.slice(sr * 0.2, sr * 0.9))
  ok('A2 is 110 Hz', Math.abs(hz - 110) < 1, hz.toFixed(2))
}
// an 808's drop: starts high, lands on the note
{
  const { L } = run({ wave: 0, drop: 24, droptime: 0.2, sustain: 1 }, { notes: [{ at: 0, note: 45, len: 1 }], secs: 1 })
  const early = hzOf(L.slice(0, sr * 0.05))
  const late = hzOf(L.slice(sr * 0.5, sr * 0.95))
  ok('the drop starts above the note', early > 200, early.toFixed(1))
  ok('and lands on it', Math.abs(late - 110) < 1.5, late.toFixed(1))
}
// mono glide: a note slid into (still held) glides and keeps its level
{
  const notes = [{ at: 0, note: 45, len: 0.55 }, { at: 0.5, note: 57, len: 0.5 }]
  const { L } = run({ wave: 0, sustain: 1, glide: 0.2 }, { notes, secs: 1.1 })
  const mid = hzOf(L.slice(sr * 0.52, sr * 0.6))
  const end = hzOf(L.slice(sr * 0.85, sr * 1.0))
  ok('a slid note is on its way between the two', mid > 112 && mid < 215, mid.toFixed(1))
  ok('and gets there', Math.abs(end - 220) < 3, end.toFixed(1))
  const dip = rms(L.slice(sr * 0.49, sr * 0.52)) / rms(L.slice(sr * 0.4, sr * 0.45))
  ok('without the level starting over', dip > 0.8, dip.toFixed(2))
}
// a wobble (timed from the note here: the harness's clock stands still, so the song's would)
{
  const { L } = run({ wave: 2, cutoff: 3000, rate: 3, depth: 1, sustain: 1 }, { notes: [{ at: 0, note: 36, len: 2 }], secs: 2 })
  const win = 1200
  const levels = []
  for (let i = sr * 0.2; i + win < sr * 1.8; i += win) levels.push(rms(L.slice(i, i + win)))
  const lo = Math.min(...levels), hi = Math.max(...levels)
  ok('the wobble moves the sound', hi > lo * 2, `${lo.toFixed(3)}…${hi.toFixed(3)}`)
}
// let go: it stops
{
  const { L } = run({ wave: 2, sustain: 1, release: 0.1 }, { notes: [{ at: 0, note: 36, len: 0.3 }], secs: 1 })
  ok('a note let go stops', peak(L.slice(sr * 0.7)) < 1e-3, peak(L.slice(sr * 0.7)))
}

if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('b4ss ok')
