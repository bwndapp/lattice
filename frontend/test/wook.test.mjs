/**
 * W00K: every preset sounds, finite and under clipping; a note is in tune; the womp's bend
 * starts off the note and lands on it; the flutter chops the volume at its rate; a slid note
 * glides; and a note let go stops. Run in node, as the audio thread would run it.
 */
import { DSP_BASE } from '../src/instruments/dsp.js'
import kick from '../src/instruments/kick.js'
import physical from '../src/instruments/physical.js'
import b4ss from '../src/instruments/b4ss.js'
import spec from '../src/instruments/wook.js'

let fails = 0
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`)); if (!cond) fails++ }
const procs = {}
const sr = 48000
const env = { sampleRate: sr, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = {} } }, registerProcessor: (n, c) => { procs[n] = c } }
// beside every other engine, as the audio thread loads them: names mustn't clash
new Function(...Object.keys(env), DSP_BASE + kick.dsp + physical.dsp + b4ss.dsp + spec.dsp)(...Object.values(env))
const Proc = procs['lattice-wook']
ok('registers', !!Proc)

function run(knobs, { notes = [{ at: 0, note: 36, len: 0.6 }], secs = 1 } = {}) {
  const p = new Proc({})
  const B = 128
  const params = {}
  for (const k of Proc.knobs) params['p_' + k.key] = [knobs[k.key] ?? k.def]
  for (let v = 0; v < 6; v++) Object.assign(params, { [`v${v}_trig`]: [0], [`v${v}_note`]: [-1], [`v${v}_vel`]: [1], [`v${v}_gain`]: [1], [`v${v}_pan`]: [0.5], [`v${v}_gate`]: [0] })
  const L = []; const R = []
  for (let b = 0; b < (secs * sr) / B; b++) {
    const t = (b * B) / sr
    let trig = 0, note = -1, gate = 0
    notes.forEach((n, i) => { if (t >= n.at) { trig = i + 1; note = n.note } if (t >= n.at && t < n.at + n.len) gate = 1 })
    params.v0_trig = [trig]; params.v0_note = [note]; params.v0_gate = [gate]
    const outs = Array.from({ length: 6 }, () => [new Float32Array(B), new Float32Array(B)])
    p.process([], outs, params)
    L.push(...outs[0][0]); R.push(...outs[0][1])
  }
  return { L, R }
}
const peak = (o) => o.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
const rms = (o) => Math.sqrt(o.reduce((s, x) => s + x * x, 0) / Math.max(1, o.length))
const hzOf = (o) => { let z = 0; for (let i = 1; i < o.length; i++) if (o[i - 1] < 0 && o[i] >= 0) z++; return z / (o.length / sr) }

for (const pr of spec.presets) {
  const bad = Object.entries(pr.data).filter(([k, v]) => { const d = spec.params.find((p) => p.key === k); return !d || v < d.min || v > d.max })
  ok(`preset ${pr.name}: knobs are real and in range`, !bad.length, JSON.stringify(bad))
  const { L, R } = run(pr.data)
  const p = Math.max(peak(L), peak(R))
  ok(`preset ${pr.name}: sounds, finite, under clipping`, L.every(Number.isFinite) && R.every(Number.isFinite) && p > 0.05 && p < 0.99, p.toFixed(3))
}
{
  const { L } = run({ tone: 0, open: 0, sub: 0, octave: 0, sustain: 1 }, { notes: [{ at: 0, note: 45, len: 1 }] })
  const hz = hzOf(L.slice(sr * 0.2, sr * 0.9))
  ok('A2 is 110 Hz', Math.abs(hz - 110) < 2, hz.toFixed(2)) // counting crossings: ±1 in the window
  const { L: d } = run({ tone: 0, open: 0, sub: 0, sustain: 1 }, { notes: [{ at: 0, note: 36, len: 1 }] })
  ok('by default it sits in the sub: C2 plays C1', Math.abs(hzOf(d.slice(sr * 0.2, sr * 0.9)) - 32.7) < 1)
}
{
  const { L } = run({ tone: 0, open: 0, sub: 0, octave: 0, sustain: 1, bend: 12, bendtime: 0.3 }, { notes: [{ at: 0, note: 45, len: 1 }] })
  ok('the womp bends in from above', hzOf(L.slice(0, sr * 0.04)) > 160, hzOf(L.slice(0, sr * 0.04)).toFixed(1))
  ok('and lands on the note', Math.abs(hzOf(L.slice(sr * 0.6, sr * 0.95)) - 110) < 1.5)
}
{
  // free flutter at 8 Hz: the level dips eight times a second
  const { L } = run({ tone: 0, open: 0, sustain: 1, frate: 6, fhz: 8, fvol: 1, fshape: 2 }, { notes: [{ at: 0, note: 48, len: 1 }] })
  const win = 1200 // 25 ms: a few cycles of a low note
  const levels = []
  for (let i = sr * 0.25; i + win < sr * 0.75; i += win) levels.push(rms(L.slice(i, i + win)))
  let dips = 0
  for (let i = 1; i < levels.length; i++) if (levels[i - 1] > 0.2 && levels[i] < 0.06) dips++
  ok('the flutter chops the volume at its rate', dips >= 3 && dips <= 5, `${dips} · ${levels.map((x) => x.toFixed(2)).join(' ')}`)
  const { L: l2, R: r2 } = run({ tone: 0, open: 0, sustain: 1, frate: 6, fhz: 8, fvol: 1, fshape: 2, fspread: 1 }, { notes: [{ at: 0, note: 48, len: 1 }] })
  const diff = rms(l2.slice(sr * 0.3, sr * 0.7).map((x, i) => x - r2[sr * 0.3 + i]))
  ok('spread: the sides flutter apart', diff > 0.05, diff.toFixed(3))
}
{
  const notes = [{ at: 0, note: 45, len: 0.55 }, { at: 0.5, note: 57, len: 0.5 }]
  const { L } = run({ tone: 0, open: 0, sub: 0, octave: 0, sustain: 1, glide: 0.2 }, { notes, secs: 1.1 })
  const mid = hzOf(L.slice(sr * 0.52, sr * 0.6))
  ok('a slid note glides between', mid > 112 && mid < 215, mid.toFixed(1))
}
{
  const { L } = run({ sustain: 1, release: 0.1 }, { notes: [{ at: 0, note: 36, len: 0.3 }] })
  ok('a note let go stops', peak(L.slice(sr * 0.7)) < 1e-3)
}
if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('wook ok')
