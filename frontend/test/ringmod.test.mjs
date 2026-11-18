/**
 * Ring mod, its worklet run in node: in ring mode a tone times a sine carrier becomes the
 * sum and difference (its own pitch gone); in am mode its pitch stays, beating; depth 0 and
 * mix 0 leave it alone; in time, a square carrier chops it at its rate.
 */
import { readFileSync } from 'node:fs'

let fails = 0
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`)); if (!cond) fails++ }
const src = readFileSync(new URL('../src/stereo.js', import.meta.url), 'utf8')
const from = src.indexOf('const RM_RATE')
const to = src.indexOf("registerProcessor('lattice-ringmod', RingModProcessor)") + "registerProcessor('lattice-ringmod', RingModProcessor)".length
const sr = 48000
const procs = {}
const env = { sampleRate: sr, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = {} } }, registerProcessor: (n, c) => { procs[n] = c } }
new Function(...Object.keys(env), src.slice(from, to))(...Object.values(env))
const Ring = procs['lattice-ringmod']
ok('registers', !!Ring)
const run = (knobs, sig, secs = 1) => {
  const w = new Ring(); const P = {}
  for (const d of Ring.parameterDescriptors) P[d.name] = [knobs[d.name] ?? d.defaultValue]
  const L = []
  for (let b = 0; b < (secs * sr) / 128; b++) { const x = new Float32Array(128); for (let i = 0; i < 128; i++) x[i] = sig(b * 128 + i); const o = [new Float32Array(128), new Float32Array(128)]; w.process([[x, x]], [o], P); L.push(...o[0]) }
  return L
}
// how much of a frequency is in a signal (a single-bin DFT)
const at = (L, hz) => { let re = 0, im = 0; const a = sr * 0.2, b = sr * 0.9; for (let i = a; i < b; i++) { re += L[i] * Math.cos(2 * Math.PI * hz * i / sr); im += L[i] * Math.sin(2 * Math.PI * hz * i / sr) } return Math.hypot(re, im) / ((b - a) / 2) }
const tone = (i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / sr)

{
  const L = run({ freq: 200 }, tone)
  ok('ring: its own pitch is gone', at(L, 1000) < 0.02, at(L, 1000).toFixed(3))
  ok('ring: the sum and the difference take its place', at(L, 1200) > 0.2 && at(L, 800) > 0.2, `${at(L, 1200).toFixed(3)} / ${at(L, 800).toFixed(3)}`)
}
{
  const L = run({ freq: 200, mode: 1 }, tone)
  ok('am: its pitch stays', at(L, 1000) > 0.2, at(L, 1000).toFixed(3))
  ok('am: with sidebands either side', at(L, 1200) > 0.05, at(L, 1200).toFixed(3))
}
{
  const L = run({ amount: 0 }, tone, 0.3)
  ok('depth 0 leaves it alone', Math.max(...L.map((x, i) => Math.abs(x - tone(i)))) < 1e-6)
  const M = run({ mix: 0 }, tone, 0.3)
  ok('mix 0 leaves it alone', Math.max(...M.map((x, i) => Math.abs(x - tone(i)))) < 1e-6)
}
{
  // in time: 1/16 square at 120 bpm (cps 0.5) shuts it 8 times a second
  const L = run({ source: 1, rate: 2, shape: 2, mode: 1, cps: 0.5 }, tone, 1.2)
  const e = []; for (let i = sr * 0.2; i + 240 <= sr * 1.2; i += 240) e.push(Math.sqrt(L.slice(i, i + 240).reduce((s, x) => s + x * x, 0) / 240))
  let gaps = 0; for (let i = 1; i < e.length; i++) if (e[i - 1] > 0.1 && e[i] < 0.02) gaps++
  ok('in time: a 1/16 square chops 8 times a second', gaps >= 7 && gaps <= 9, gaps)
}
{
  const L = run({ freq: 200, drift: 1 }, tone, 3)
  ok('drift: finite, and never louder than it came in', L.every(Number.isFinite) && L.reduce((m, x) => Math.max(m, Math.abs(x)), 0) <= 0.51)
}
if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('ring mod ok')
