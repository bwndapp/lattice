import { knobsSource } from './dsp.js'

/**
 * Kick: a sine that starts high and falls to its note, with a click on top, a shape and a
 * drive, the way Kick 2 builds one. One voice: a new hit takes over from the last one, with
 * a few milliseconds' fade so the tail it cuts doesn't click.
 *
 * Played from steps it sits at its tune knob. A note moves the whole kick from there: C2 is
 * the kick as tuned, C#2 a semitone up, and so on (the start moves with it).
 */
const PARAMS = [
  // pitch
  { key: 'start', group: 'pitch', label: 'start', min: 40, max: 4000, def: 320, log: true, unit: 'hz' },
  { key: 'tune', group: 'pitch', label: 'tune', min: 25, max: 200, def: 48, log: true, unit: 'hz' },
  { key: 'sweep', group: 'pitch', label: 'sweep', min: 0.005, max: 1, def: 0.045, log: true, unit: 's' },
  { key: 'bend', group: 'pitch', label: 'bend', min: 0.25, max: 8, def: 2, log: true, unit: 'x' },
  // body
  { key: 'attack', group: 'body', label: 'attack', min: 0, max: 0.03, def: 0.001, unit: 's' },
  { key: 'hold', group: 'body', label: 'hold', min: 0, max: 1, def: 0.06, unit: 's' },
  { key: 'decay', group: 'body', label: 'decay', min: 0.02, max: 3, def: 0.4, log: true, unit: 's' },
  { key: 'curve', group: 'body', label: 'curve', min: 0.3, max: 6, def: 2, log: true, unit: 'x' },
  { key: 'shape', group: 'body', label: 'shape', min: 0, max: 1, def: 0 },
  // click
  { key: 'click', group: 'click', label: 'level', min: 0, max: 1, def: 0.35 },
  { key: 'clicktone', group: 'click', label: 'tone', min: 500, max: 16000, def: 4000, log: true, unit: 'hz' },
  { key: 'clicklen', group: 'click', label: 'length', min: 0.001, max: 0.05, def: 0.008, log: true, unit: 's' },
  // out
  { key: 'drive', group: 'out', label: 'drive', min: 0, max: 1, def: 0.15 },
  { key: 'level', group: 'out', label: 'level', min: -24, max: 6, def: 0, unit: 'db', origin: 0 },
]

const DSP = `
class KickProcessor extends LatticeInstrument {
  static voiceCount = 4
  static knobs = ${knobsSource(PARAMS)}
  busy(voice) { return voice.active || !!voice.fade }
  newVoice() { return { active: false, t: 0, phase: 0, vel: 1, ratio: 1, noise: 0, fade: null } }
  noteOn(voice, note, vel) {
    // the hit it cuts off fades out underneath the new one
    if (voice.active) voice.fade = { t: voice.t, phase: voice.phase, ratio: voice.ratio, left: Math.round(0.004 * sampleRate), len: Math.round(0.004 * sampleRate) }
    voice.active = true
    voice.t = 0
    voice.phase = 0
    voice.noise = 0
    voice.vel = vel
    voice.ratio = note >= 0 ? 2 ** ((note - 36) / 12) : 1 // C2 plays it as tuned
  }
  // the kick at time t of a hit (no click), or null once it's over
  body(state, t) {
    const k = this.k
    const end = k.tune * state.ratio
    const start = Math.max(end, k.start * state.ratio)
    const u = t / k.sweep
    const e = u < 1 ? (1 - u) ** k.bend : 0
    const f = end * (start / end) ** e
    let amp
    if (t < k.attack) amp = t / k.attack
    else if (t < k.attack + k.hold) amp = 1
    else {
      const d = (t - k.attack - k.hold) / k.decay
      if (d >= 1) return null
      amp = (1 - d) ** k.curve
    }
    state.phase += f / sampleRate
    if (state.phase > 1) state.phase -= 1
    let y = Math.sin(2 * Math.PI * state.phase)
    if (k.shape > 0.001) { const g = 1 + k.shape * 6; y = Math.tanh(y * g) / Math.tanh(g) }
    return y * amp
  }
  render(voice, L, R, from, to) {
    const k = this.k
    const dt = 1 / sampleRate
    const gain = 10 ** (k.level / 20)
    const drive = k.drive > 0.001 ? 1 + k.drive * 8 : 0
    const norm = drive ? 1 / Math.tanh(drive) : 1
    const lp = 1 - Math.exp((-2 * Math.PI * k.clicktone) / sampleRate)
    for (let i = from; i < to; i++) {
      let y = 0
      if (voice.active) {
        const b = this.body(voice, voice.t)
        if (b === null) voice.active = false
        else {
          y = b
          if (voice.t < k.clicklen && k.click > 0) {
            voice.noise += (Math.random() * 2 - 1 - voice.noise) * lp
            const env = (1 - voice.t / k.clicklen) ** 2
            y += voice.noise * env * k.click * 1.5
          }
          voice.t += dt
        }
      }
      const f = voice.fade
      if (f) {
        const b = this.body(f, f.t)
        if (b !== null) y += b * (f.left / f.len)
        f.t += dt
        if (--f.left <= 0 || b === null) voice.fade = null
      }
      if (drive) y = Math.tanh(y * drive) * norm
      y *= gain
      L[i] += y
      if (R !== L) R[i] += y
      if (!voice.active && !voice.fade) break
    }
  }
}
registerProcessor('lattice-kick', KickProcessor)
`

export default {
  type: 'kick',
  label: 'kick synth',
  blurb: 'A kick built from scratch: a falling sine, a click, shape and drive',
  kinds: ['drum', 'synth'],
  processor: 'lattice-kick',
  // A kick is one sound at a time musically, but it gets played more than once at the same
  // moment often enough: a roll whose tails overlap, or the same part sent down two paths
  // at once (dry to the mixer, and again into a reverb for rumble). With one voice the
  // second play cut the first off, and whichever landed last was the only one you heard.
  voices: 4,
  oneShot: true, // it plays its whole shape whatever the note's length
  params: PARAMS,
  groups: [['pitch', 'pitch'], ['body', 'body'], ['click', 'click'], ['out', 'output']],
  /** How long a hit rings, in seconds, with these settings. */
  tail: (d) => d.attack + d.hold + d.decay + 0.02,
  dsp: DSP,
}
