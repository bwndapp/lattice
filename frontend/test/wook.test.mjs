/**
 * W00K, the flutter: its worklet run in node on a test signal. It passes sound sanely;
 * chops at its rate, in time (synced and free, triplets too); chop sets how deep; width how
 * long it's open; smooth takes the click off the edges; spread offsets the sides (0.5: they
 * take turns); swing makes every second pulse late; following hits restarts it on each hit,
 * and rise lets the hit through before the chop comes in; mix 0 is the dry sound.
 */
import { readFileSync } from 'node:fs'

let fails = 0
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`)); if (!cond) fails++ }
const src = readFileSync(new URL('../src/stereo.js', import.meta.url), 'utf8')
const from = src.indexOf('const WK_RATE')
const to = src.indexOf("registerProcessor('lattice-wook', WookProcessor)") + "registerProcessor('lattice-wook', WookProcessor)".length
const sr = 48000
const procs = {}
const env = { sampleRate: sr, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = {} } }, registerProcessor: (n, c) => { procs[n] = c } }
new Function(...Object.keys(env), src.slice(from, to))(...Object.values(env))
const Wook = procs['lattice-wook']
ok('registers', !!Wook)
const RATES = ['1/8', '1/8 t', '1/16', '1/16 t', '1/32', '1/32 t', '1/64', '1/8 .', '1/4 .', 'free']
const SHAPES = ['sine', 'triangle', 'square', 'saw down', 'saw up']

function run(knobs, signal, secs = 1) {
  const w = new Wook()
  const P = {}
  for (const d of Wook.parameterDescriptors) P[d.name] = [knobs[d.name] ?? d.defaultValue]
  const L = []; const R = []
  for (let b = 0; b < (secs * sr) / 128; b++) {
    const x = new Float32Array(128)
    for (let i = 0; i < 128; i++) x[i] = signal(b * 128 + i)
    const out = [new Float32Array(128), new Float32Array(128)]
    w.process([[x, x]], [out], P)
    L.push(...out[0]); R.push(...out[1])
  }
  return { L, R }
}
const tone = (i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr) // steady, so any change is the flutter
const env1 = (o, win = 96) => { const e = []; for (let i = 0; i + win <= o.length; i += win) e.push(Math.sqrt(o.slice(i, i + win).reduce((s, x) => s + x * x, 0) / win)); return e }
// how many times the level falls through the middle, a second's worth
const dips = (o, a = sr * 0.2, b = sr * 0.7) => { const e = env1(o.slice(a, b)); const mid = (Math.max(...e) + Math.min(...e)) / 2; let n = 0; for (let i = 1; i < e.length; i++) if (e[i - 1] >= mid && e[i] < mid) n++; return n * (sr / (b - a)) }
const depthOf = (o) => { const e = env1(o.slice(sr * 0.2, sr * 0.8)); return 1 - Math.min(...e) / Math.max(...e) }
const sq = { shape: SHAPES.indexOf('square'), smooth: 0 }

{
  const { L, R } = run({}, tone)
  const peak = Math.max(...L.map(Math.abs))
  ok('passes sound, finite, never louder than it came in', L.every(Number.isFinite) && R.every(Number.isFinite) && peak > 0.2 && peak <= 0.51, peak.toFixed(3))
}
// in time: at 120 bpm (cps 0.5) a 1/16 is 8 a second, a 1/32 16, a 1/16 triplet 12
for (const [rate, want] of [['1/16', 8], ['1/32', 16], ['1/16 t', 12], ['1/8 .', 0.5 * 16 / 3]]) {
  const got = dips(run({ ...sq, rate: RATES.indexOf(rate), cps: 0.5, warble: 0 }, tone).L)
  ok(`${rate} at 120 bpm chops ${want.toFixed(1)} times a second`, Math.abs(got - want) <= 1.01, got)
}
ok('free: at its Hz', Math.abs(dips(run({ ...sq, rate: RATES.indexOf('free'), hz: 10, warble: 0 }, tone).L) - 10) <= 1)
// how deep
ok('chop 1 shuts it', depthOf(run({ ...sq, chop: 1, warble: 0 }, tone).L) > 0.95)
ok('chop 0.5 halves it', Math.abs(depthOf(run({ ...sq, chop: 0.5, warble: 0 }, tone).L) - 0.5) < 0.08)
// width: a narrow pulse is open less of the time
{
  const openShare = (width) => { const e = env1(run({ ...sq, width, chop: 1, warble: 0, rate: RATES.indexOf('1/8') }, tone).L.slice(sr * 0.2, sr * 0.8)); const top = Math.max(...e); return e.filter((x) => x > top * 0.5).length / e.length }
  ok('width sets how long each pulse is open', openShare(0.2) < 0.3 && openShare(0.8) > 0.7, `${openShare(0.2).toFixed(2)} / ${openShare(0.8).toFixed(2)}`)
}
// smooth: a hard square clicks (big sample-to-sample jumps); smoothed, it doesn't
{
  const jump = (o) => Math.max(...o.slice(sr * 0.2, sr * 0.8).map((x, i, a) => (i ? Math.abs(x - a[i - 1]) : 0)))
  const hard = jump(run({ ...sq, smooth: 0, warble: 0 }, tone).L)
  const soft = jump(run({ ...sq, smooth: 0.6, warble: 0 }, tone).L)
  ok('smooth takes the click off the edges', soft < hard * 0.6, `${hard.toFixed(3)} → ${soft.toFixed(3)}`)
}
// spread 0.5: one side open while the other is shut
{
  const { L, R } = run({ ...sq, chop: 1, spread: 0.5, warble: 0, rate: RATES.indexOf('1/8') }, tone)
  const el = env1(L.slice(sr * 0.2, sr * 0.8)), er = env1(R.slice(sr * 0.2, sr * 0.8))
  const top = Math.max(...el)
  const turns = el.filter((x, i) => (x > top * 0.5) !== (er[i] > top * 0.5)).length / el.length
  ok('spread 0.5: the sides take turns', turns > 0.85, turns.toFixed(2))
}
// swing: open stretches alternate long and short
{
  // the gaps between pulses: even when straight, long-short-long-short when swung
  const gaps = (o) => { const e = env1(o.slice(sr * 0.2, sr * 1.9)); const top = Math.max(...e); const out = []; let n = 0; for (const x of e) { if (x <= top * 0.5) n++; else if (n) { out.push(n); n = 0 } } return out.slice(1) }
  const straight = gaps(run({ ...sq, chop: 1, warble: 0, rate: RATES.indexOf('1/16'), cps: 0.5 }, tone, 2).L)
  const swung = gaps(run({ ...sq, chop: 1, warble: 0, rate: RATES.indexOf('1/16'), cps: 0.5, swing: 0.3 }, tone, 2).L)
  const spreadOf = (r) => Math.max(...r) - Math.min(...r)
  ok('swing: every second pulse is late', spreadOf(swung) > spreadOf(straight) + 4, `${straight.join(',')} → ${swung.join(',')}`)
}
// following hits: a hit restarts it; with rise, the hit's front comes through before the chop
{
  const hits = (i) => ((i % (sr / 2)) < sr * 0.3 ? tone(i) : 0)
  const noRise = run({ ...sq, chop: 1, warble: 0, follow: 1, rate: RATES.indexOf('1/16'), shape: SHAPES.indexOf('saw up') }, hits).L
  const withRise = run({ ...sq, chop: 1, warble: 0, follow: 1, rise: 0.4, rate: RATES.indexOf('1/16'), shape: SHAPES.indexOf('saw up') }, hits).L
  const front = (o) => Math.sqrt(o.slice(sr * 0.5 + 400, sr * 0.5 + 1600).reduce((s, x) => s + x * x, 0) / 1200)
  ok('rise lets the front of each hit through', front(withRise) > front(noRise) * 1.5, `${front(noRise).toFixed(3)} → ${front(withRise).toFixed(3)}`)
}
// filter: the shut part is darker, not just quieter
{
  const bright = (i) => 0.4 * (2 * ((i * 220 / sr) % 1) - 1) // a saw: plenty of top
  const hf = (o) => Math.sqrt(o.slice(sr * 0.2, sr * 0.8).map((x, i, a) => (i ? x - a[i - 1] : 0)).reduce((s, x) => s + x * x, 0))
  ok('filter darkens it', hf(run({ chop: 0.6, filter: 1, warble: 0 }, bright).L) < hf(run({ chop: 0.6, filter: 0, warble: 0 }, bright).L) * 0.8)
}
{
  const { L } = run({ mix: 0, warble: 0 }, tone, 0.3)
  ok('mix 0 is the dry sound (only delayed a few ms)', Math.abs(Math.max(...L.slice(sr * 0.1).map(Math.abs)) - 0.5) < 0.01)
}
if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('wook ok')
