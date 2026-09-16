/**
 * What every instrument engine runs on the audio thread, as source: one module the audio
 * thread loads (see host.js), with a base class each engine's processor builds on.
 *
 * An instrument is one processor that stays alive for as long as its instrument does,
 * with one stereo output per voice. It hears about notes through AudioParams, which are
 * timed to the sample and work the same in an offline render as they do live:
 *
 *   v<n>_trig   a counter the host bumps at a note's start: a new value is a new note
 *   v<n>_note   the note's pitch (MIDI), or -1 when the note has none (a drum step)
 *   v<n>_vel    how hard, 0 … 1 (Strudel already turns the note's level by it: use it
 *               for anything else velocity should move)
 *   v<n>_gate   1 while the note is held, 0 once it's let go
 *   p_<key>     the engine's knobs (k-rate: they move once per block)
 *
 * A subclass says how many voices it has and which knobs, and implements
 *   newVoice()                       fresh state for one voice
 *   noteOn(voice, note, vel)         a note starts on this voice
 *   noteOff(voice)                   the gate closed (optional)
 *   render(voice, L, R, from, to)    add this voice's sound for samples [from, to)
 *   busy(voice)                      whether it's making sound (default: voice.active)
 * reading its knobs from `this.k`.
 */
export const DSP_BASE = `
class LatticeInstrument extends AudioWorkletProcessor {
  static voiceCount = 1
  static knobs = [] // [{ key, def, min, max }]
  static get parameterDescriptors() {
    const out = this.knobs.map((k) => ({ name: 'p_' + k.key, defaultValue: k.def, minValue: k.min, maxValue: k.max, automationRate: 'k-rate' }))
    for (let v = 0; v < this.voiceCount; v++) {
      out.push(
        { name: 'v' + v + '_trig', defaultValue: 0, automationRate: 'a-rate' },
        { name: 'v' + v + '_note', defaultValue: -1, minValue: -1, maxValue: 127, automationRate: 'a-rate' },
        { name: 'v' + v + '_vel', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
        { name: 'v' + v + '_gate', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      )
    }
    return out
  }
  constructor() {
    super()
    const cls = this.constructor
    this.k = {}
    this.voices = Array.from({ length: cls.voiceCount }, () => ({ trig: 0, gate: 0, ...this.newVoice() }))
    this.alive = true
    this.port.onmessage = (e) => { if (e.data === 'dispose') this.alive = false }
  }
  newVoice() { return {} }
  noteOn() {}
  noteOff() {}
  render() {}
  busy(voice) { return voice.active }
  process(inputs, outputs, params) {
    if (!this.alive) return false
    for (const k of this.constructor.knobs) this.k[k.key] = params['p_' + k.key][0]
    for (let v = 0; v < this.voices.length; v++) {
      const out = outputs[v]
      if (!out || !out.length) continue
      const L = out[0]
      const R = out[1] || out[0]
      L.fill(0)
      if (R !== L) R.fill(0)
      const voice = this.voices[v]
      const trig = params['v' + v + '_trig']
      const gate = params['v' + v + '_gate']
      const note = params['v' + v + '_note']
      const vel = params['v' + v + '_vel']
      const at = (arr, i) => (arr.length > 1 ? arr[i] : arr[0])
      // nothing changes this block: one go
      if (trig.length === 1 && gate.length === 1 && trig[0] === voice.trig && gate[0] === voice.gate) {
        if (this.busy(voice)) this.render(voice, L, R, 0, L.length)
        continue
      }
      // split the block wherever a note starts or the gate moves
      let from = 0
      for (let i = 0; i < L.length; i++) {
        const t = at(trig, i)
        const g = at(gate, i)
        if (t === voice.trig && g === voice.gate) continue
        if (i > from && this.busy(voice)) this.render(voice, L, R, from, i)
        from = i
        if (t !== voice.trig) {
          voice.trig = t
          this.noteOn(voice, at(note, i), at(vel, i))
        }
        if (g !== voice.gate) {
          voice.gate = g
          if (!g) this.noteOff(voice)
        }
      }
      if (from < L.length && this.busy(voice)) this.render(voice, L, R, from, L.length)
    }
    return true
  }
}
`

/** Source for a processor's knob list, from an engine's knob definitions. */
export const knobsSource = (params) => JSON.stringify(params.map((p) => ({ key: p.key, def: p.def, min: p.min, max: p.max })))
