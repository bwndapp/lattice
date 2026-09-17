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
 * While an instrument's window is open the processor reports what it's doing, about 38
 * times a second: `report()` returns something to post (or null).
 *
 * Settings that aren't knobs (a drawn shape, say) come as a message, `onData(data)`: once
 * with the processor (processorOptions.data, so an offline render has them from the
 * start) and again whenever they change.
 *
 * A subclass says how many voices it has and which knobs, and implements
 *   newVoice()                       fresh state for one voice
 *   noteOn(voice, note, vel)         a note starts on this voice
 *   noteOff(voice)                   the gate closed (optional)
 *   render(voice, L, R, from, to)    add this voice's sound for samples [from, to)
 *   busy(voice)                      whether it's making sound (default: voice.active)
 *   beginBlock(frames)               once per block, before the voices (optional)
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
  constructor(options) {
    super()
    const cls = this.constructor
    // the knobs as an object with every key from the start: filled in one at a time, a
    // hundred-odd keys would make a slow dictionary of it, and it's read every sample
    try {
      // eslint-disable-next-line no-new-func
      this.k = new Function('return {' + cls.knobs.map((k) => JSON.stringify(k.key) + ': 0').join(', ') + '}')()
    } catch (err) {
      this.k = {}
    }
    this.voices = Array.from({ length: cls.voiceCount }, () => ({ trig: 0, gate: 0, ...this.newVoice() }))
    // param names, worked out once rather than every block
    this.knobNames = cls.knobs.map((k) => [k.key, 'p_' + k.key])
    this.voiceNames = this.voices.map((_, v) => ['v' + v + '_trig', 'v' + v + '_gate', 'v' + v + '_note', 'v' + v + '_vel'])
    this.alive = true
    this.watching = false
    this.ticks = 0
    this.port.onmessage = (e) => {
      if (e.data === 'dispose') this.alive = false
      else if (e.data && e.data.watch !== undefined) this.watching = !!e.data.watch
      else if (e.data && e.data.data) this.onData(e.data.data)
    }
    this.initial = options && options.processorOptions && options.processorOptions.data
  }
  onData() {}
  report() { return null }
  newVoice() { return {} }
  noteOn() {}
  noteOff() {}
  render() {}
  busy(voice) { return voice.active }
  beginBlock() {}
  process(inputs, outputs, params) {
    if (!this.alive) return false
    if (this.initial) { this.onData(this.initial); this.initial = null }
    const knobNames = this.knobNames
    for (let i = 0; i < knobNames.length; i++) this.k[knobNames[i][0]] = params[knobNames[i][1]][0]
    this.beginBlock(outputs[0] && outputs[0][0] ? outputs[0][0].length : 128)
    for (let v = 0; v < this.voices.length; v++) {
      const out = outputs[v]
      if (!out || !out.length) continue
      const L = out[0]
      const R = out[1] || out[0]
      L.fill(0)
      if (R !== L) R.fill(0)
      const voice = this.voices[v]
      const names = this.voiceNames[v]
      const trig = params[names[0]]
      const gate = params[names[1]]
      const note = params[names[2]]
      const vel = params[names[3]]
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
    if (this.watching && ++this.ticks >= 10) {
      this.ticks = 0
      const report = this.report()
      if (report) this.port.postMessage({ report })
    }
    return true
  }
}
`

/** Source for a processor's knob list, from an engine's knob definitions. */
export const knobsSource = (params) => JSON.stringify(params.map((p) => ({ key: p.key, def: p.def, min: p.min, max: p.max })))
