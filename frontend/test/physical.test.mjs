/**
 * The physical model: every body and exciter makes a sound that's tuned, finite and not
 * clipping, and a bowed note stops once it's let go. The processor runs here in node, its
 * source evaluated with just enough of an AudioWorklet around it.
 */
import { DSP_BASE } from '../src/instruments/dsp.js'
import { KickDrive } from '../src/instruments/kick.js'
import kick from '../src/instruments/kick.js'
import spec, { MODELS, EXCITERS } from '../src/instruments/physical.js'

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const procs = {}
const sr = 48000
const env = { sampleRate: sr, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = {} } }, registerProcessor: (n, c) => { procs[n] = c } }
// with another engine's source beside it, as the audio thread loads them: names mustn't clash
new Function(...Object.keys(env), DSP_BASE + kick.dsp + spec.dsp)(...Object.values(env))
void KickDrive
const Proc = procs['lattice-physical']

function run(knobs, { note = 48, secs = 1.5, hold = 0.5 } = {}) {
  const p = new Proc({})
  const B = 128
  const params = {}
  for (const k of Proc.knobs) params['p_' + k.key] = [knobs[k.key] ?? k.def]
  for (let v = 0; v < 8; v++) Object.assign(params, { [`v${v}_trig`]: [0], [`v${v}_note`]: [note], [`v${v}_vel`]: [1], [`v${v}_gain`]: [1], [`v${v}_pan`]: [0.5], [`v${v}_gate`]: [0] })
  const out = []
  for (let b = 0; b < (secs * sr) / B; b++) {
    params.v0_trig = [1]
    params.v0_gate = [(b * B) / sr < hold ? 1 : 0]
    const outs = Array.from({ length: 8 }, () => [new Float32Array(B), new Float32Array(B)])
    p.process([], outs, params)
    out.push(...outs[0][0])
  }
  return out
}
const peak = (o) => Math.max(...o.map(Math.abs))

for (let m = 0; m < MODELS.length; m++) {
  for (let e = 0; e < EXCITERS.length; e++) {
    const o = run({ model: m, exciter: e })
    const p = peak(o)
    ok(`${MODELS[m]} ${EXCITERS[e]}: sounds, finite, under clipping`, o.every(Number.isFinite) && p > 0.05 && p < 0.98, p.toFixed(3))
  }
}
for (const m of [0, 1]) {
  const o = run({ model: m, exciter: 1, stiffness: 0, random: 0 }, { note: 57, secs: 1 }).slice(sr / 5)
  let z = 0
  for (let i = 1; i < o.length; i++) if (o[i - 1] < 0 && o[i] >= 0) z++
  const hz = z / (o.length / sr)
  ok(`${MODELS[m]} A3 is 220 Hz`, Math.abs(hz - 220) < 1.5, hz.toFixed(2))
}
{
  const o = run({ model: 0, exciter: 2, length: 0.1, release: 0.1 }, { secs: 2, hold: 1 })
  ok('a bowed string sings while held', peak(o.slice(sr / 2, sr)) > 0.1)
  ok('and stops once let go', peak(o.slice(1.5 * sr)) < 1e-3)
}

if (fails) { console.log(`\n${fails} failed`); process.exit(1) }
console.log('\nall passed')
