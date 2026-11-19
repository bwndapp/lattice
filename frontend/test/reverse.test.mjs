/**
 * Reverse, its worklet in node: a chunk later, each chunk plays backwards (a rising ramp in
 * comes out falling); the chunk is as long as it says at the tempo; fade rounds its ends so
 * joins don't click; mix 0 is the dry sound.
 */
import { readFileSync } from 'node:fs'

let fails = 0
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`)); if (!cond) fails++ }
const src = readFileSync(new URL('../src/stereo.js', import.meta.url), 'utf8')
const from = src.indexOf('const RV_RATE')
const to = src.indexOf("registerProcessor('lattice-reverse', ReverseProcessor)") + "registerProcessor('lattice-reverse', ReverseProcessor)".length
const sr = 48000
const procs = {}
const env = { sampleRate: sr, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = {} } }, registerProcessor: (n, c) => { procs[n] = c } }
new Function(...Object.keys(env), src.slice(from, to))(...Object.values(env))
const Rev = procs['lattice-reverse']
ok('registers', !!Rev)
const run = (knobs, sig, secs) => {
  const w = new Rev(); const P = {}
  for (const d of Rev.parameterDescriptors) P[d.name] = [knobs[d.name] ?? d.defaultValue]
  const L = []
  for (let b = 0; b < (secs * sr) / 128; b++) { const x = new Float32Array(128); for (let i = 0; i < 128; i++) x[i] = sig(b * 128 + i); const o = [new Float32Array(128), new Float32Array(128)]; w.process([[x, x]], [o], P); L.push(...o[0]) }
  return L
}
// 1/4 at cps 0.5 (120 bpm): a chunk is half a second; feed a ramp that rises through each chunk
const chunk = sr / 2
const ramp = (i) => ((i % chunk) / chunk) * 0.8
const L = run({ length: 2, fade: 0, cps: 0.5 }, ramp, 2)
ok('the first chunk is silent (it\'s being recorded)', Math.max(...L.slice(0, chunk - 10).map(Math.abs)) < 1e-6)
const second = L.slice(chunk + 100, 2 * chunk - 100)
ok('then it plays the last one backwards: a rising ramp comes out falling', second[0] > second[second.length - 1] + 0.5, `${second[0].toFixed(3)} → ${second[second.length - 1].toFixed(3)}`)
ok('the right length at the tempo: it starts at the top of the ramp', Math.abs(Math.max(...L.slice(chunk, chunk + 8)) - 0.8) < 0.01, Math.max(...L.slice(chunk, chunk + 8)).toFixed(4))
// fade: the joins come in from silence
const F = run({ length: 2, fade: 0.2, cps: 0.5 }, ramp, 2)
ok('fade: a chunk starts from nothing', Math.abs(F[chunk + 1]) < 0.02, F[chunk + 1].toFixed(4))
ok('fade: and is all there in its middle', Math.abs(F[chunk + chunk / 2] - L[chunk + chunk / 2]) < 1e-3)
const D = run({ mix: 0 }, ramp, 0.3)
ok('mix 0 is the dry sound', D.every((x, i) => Math.abs(x - ramp(i)) < 1e-6))
if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('reverse ok')
