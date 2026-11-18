/**
 * W00K, the effect: its worklet run in node on a test signal. It passes sound, stays finite
 * and sane in level; its flutter chops in time; its wobble moves the tone in time; a hit
 * coming in opens the vowel (the womp); and mix at 0 is the dry sound untouched.
 */
import { readFileSync } from 'node:fs'

let fails = 0
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`)); if (!cond) fails++ }
const src = readFileSync(new URL('../src/stereo.js', import.meta.url), 'utf8')
const from = src.indexOf('const WK_VOWELS')
const to = src.indexOf("registerProcessor('lattice-wook', WookProcessor)") + "registerProcessor('lattice-wook', WookProcessor)".length
const sr = 48000
const procs = {}
const env = { sampleRate: sr, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = {} } }, registerProcessor: (n, c) => { procs[n] = c } }
new Function(...Object.keys(env), src.slice(from, to))(...Object.values(env))
const Wook = procs['lattice-wook']
ok('registers', !!Wook)

function run(knobs, signal, secs = 1) {
  const w = new Wook()
  const P = {}
  for (const d of Wook.parameterDescriptors) P[d.name] = [knobs[d.name] ?? d.defaultValue]
  const L = []
  const R = []
  for (let b = 0; b < (secs * sr) / 128; b++) {
    const xl = new Float32Array(128)
    for (let i = 0; i < 128; i++) xl[i] = signal(b * 128 + i)
    const out = [new Float32Array(128), new Float32Array(128)]
    w.process([[xl, xl]], [out], P)
    L.push(...out[0]); R.push(...out[1])
  }
  return { L, R }
}
const saw = (f, a = 0.5) => (i) => a * (2 * ((i * f / sr) % 1) - 1)
const rms = (o) => Math.sqrt(o.reduce((s, x) => s + x * x, 0) / Math.max(1, o.length))
const peak = (o) => o.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
const levels = (o, win, a, b) => { const out = []; for (let i = a; i + win <= b; i += win) out.push(rms(o.slice(i, i + win))); return out }

{
  const { L, R } = run({}, saw(55))
  ok('passes sound, finite, sane level', L.every(Number.isFinite) && R.every(Number.isFinite) && rms(L) > 0.02 && peak(L) < 2, `${rms(L).toFixed(3)} / ${peak(L).toFixed(3)}`)
}
{
  // free flutter at 8 Hz, square, full chop, at cps 0.5: the level dips eight times a second
  const { L } = run({ frate: 6, fhz: 8, fshape: 2, fvol: 1, fpitch: 0, womp: 0 }, saw(110))
  const lv = levels(L, 1200, sr * 0.25, sr * 0.75)
  let dips = 0
  for (let i = 1; i < lv.length; i++) if (lv[i - 1] > 0.05 && lv[i] < lv[i - 1] * 0.25) dips++
  ok('the flutter chops at its rate', dips >= 3 && dips <= 5, `${dips} · ${lv.map((x) => x.toFixed(2)).join(' ')}`)
  // synced: 1/16 at cps 0.5 is 8 a second too
  const { L: s16 } = run({ frate: 1, fshape: 2, fvol: 1, fpitch: 0, womp: 0, cps: 0.5 }, saw(110))
  const lv2 = levels(s16, 1200, sr * 0.25, sr * 0.75)
  let d2 = 0
  for (let i = 1; i < lv2.length; i++) if (lv2[i - 1] > 0.05 && lv2[i] < lv2[i - 1] * 0.25) d2++
  ok('and in time: 1/16 at 120 bpm is 8 a second', d2 >= 3 && d2 <= 5, d2)
}
{
  // the wobble sweeps the vowel: the tone brightens and darkens each beat
  const { L } = run({ frate: 0, wrate: 3, wdepth: 1, womp: 0, vowel: 0.4, cps: 0.5 }, saw(110), 2)
  // brightness: how much the sound moves sample to sample, window by window
  const diff = L.map((x, i) => (i ? x - L[i - 1] : 0))
  const lv = levels(diff, 2400, sr * 0.2, sr * 1.8)
  ok('the wobble moves the tone', Math.max(...lv) > Math.min(...lv) * 1.3, `${Math.min(...lv).toFixed(4)}…${Math.max(...lv).toFixed(4)}`)
}
{
  // hits every half second: just after a hit is brighter (the vowel opened) than later on
  const hits = (i) => { const t = (i % (sr / 2)) / sr; return t < 0.2 ? saw(110, 0.6)(i) : 0 }
  const on = run({ frate: 0, womp: 1, wompdecay: 0.1, vowel: 0 }, hits)
  const off = run({ frate: 0, womp: 0, vowel: 0 }, hits)
  // the difference the womp makes is greatest right after each hit
  const d = (a, b) => rms(on.L.slice(a, b).map((x, i) => x - off.L[a + i]))
  ok('a hit opens the vowel: the womp', d(sr * 0.5 + 200, sr * 0.5 + 2600) > d(sr * 0.5 + 7000, sr * 0.5 + 9400) * 1.5, `${d(sr * 0.5 + 200, sr * 0.5 + 2600).toFixed(3)} vs ${d(sr * 0.5 + 7000, sr * 0.5 + 9400).toFixed(3)}`)
}
{
  const sig = saw(110)
  const { L } = run({ mix: 0 }, sig, 0.2)
  let worst = 0
  for (let i = 0; i < L.length; i++) worst = Math.max(worst, Math.abs(L[i] - sig(i)))
  ok('mix 0 is the dry sound, untouched', worst < 1e-6, worst)
}
{
  const { L } = run({ out: 0 }, saw(110), 0.2)
  ok('out 0 is silence', peak(L) === 0)
}
if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('wook ok')
