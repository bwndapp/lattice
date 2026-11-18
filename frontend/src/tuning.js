/**
 * Global tuning: where A4 sits (440 Hz unless the track says otherwise) and the tuning system:
 * equal temperament, Pythagorean or just intonation, built on a root note. Applied once, on
 * the way to the speakers (routeVoice in fxbus.js), to every note that has a pitch — Strudel's
 * synths, sampled instruments and the app's own engines alike, live and in export — so the
 * whole track is in one tuning and its code stays the same whatever it's tuned to. A drum hit
 * with no note keeps its own pitch, as a master tune on a desk would leave it.
 *
 * Pythagorean and just intonation keep the root where equal temperament has it (at the
 * track's A4) and tune every other note to a pure ratio from it, in every octave:
 *   Pythagorean  stacked pure fifths (3:2): pure fifths and fourths, bright thirds
 *   just         5-limit ratios: pure fifths and sweet major/minor thirds, in the root's key
 */
export const A4 = 440
export const TUNING_MIN = 400
export const TUNING_MAX = 480

export const SYSTEMS = ['equal', 'pythagorean', 'just']
export const SYSTEM_LABEL = { equal: 'equal', pythagorean: 'pythagorean', just: 'just' }
export const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
// each semitone above the root, as a ratio to it
const RATIOS = {
  pythagorean: [1, 256 / 243, 9 / 8, 32 / 27, 81 / 64, 4 / 3, 729 / 512, 3 / 2, 128 / 81, 27 / 16, 16 / 9, 243 / 128],
  just: [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8],
}

let ratio = 1
let system = 'equal'
let root = 0

/** A4 right now, in Hz. */
export const currentA4 = () => A4 * ratio

/** The track's tuning: A4 in Hz, and its system and root (0 = C … 11 = B). */
export function setTuning(hz, sys = 'equal', rootNote = 0) {
  const a4 = Number(hz)
  ratio = Number.isFinite(a4) && a4 > 0 ? Math.min(TUNING_MAX, Math.max(TUNING_MIN, a4)) / A4 : 1
  system = RATIOS[sys] ? sys : 'equal'
  root = ((Math.round(Number(rootNote) || 0) % 12) + 12) % 12
}

/** A MIDI note's frequency in the track's tuning (fractional notes too, e.g. a pitch bend). */
export function freqOf(midi) {
  const et = 440 * 2 ** ((midi - 69) / 12) * ratio
  const table = RATIOS[system]
  if (!table) return et
  const whole = Math.round(midi)
  // a note bent off its semitone keeps its bend, from the tuned semitone it's nearest
  const bend = 2 ** ((midi - whole) / 12)
  const d = (((whole - root) % 12) + 12) % 12
  return 440 * 2 ** ((whole - d - 69) / 12) * ratio * table[d] * bend
}

const NOTE = /^([a-gA-G])([#bsf]*)(-?\d+)?$/
const CHROMA = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
export function midiOf(note) {
  if (typeof note === 'number') return Number.isFinite(note) ? note : null
  const m = NOTE.exec(String(note ?? '').trim())
  if (!m) return null
  const acc = [...m[2]].reduce((a, c) => a + (c === '#' || c === 's' ? 1 : -1), 0)
  return (Number(m[3] ?? 3) + 1) * 12 + CHROMA[m[1].toLowerCase()] + acc
}

/** A note's value, tuned: its pitch as a frequency, moved to the track's A4. */
export function tuned(value) {
  if ((ratio === 1 && system === 'equal') || !value || typeof value !== 'object') return value
  if (typeof value.freq === 'number' && Number.isFinite(value.freq)) {
    if (system === 'equal') return { ...value, freq: value.freq * ratio }
    // a frequency written as one: tuned as the note it is (bent notes keep their bend)
    return { ...value, freq: freqOf(69 + 12 * Math.log2(value.freq / 440)) }
  }
  if (value.note == null) return value
  const midi = midiOf(value.note)
  if (midi == null) return value
  // the note goes: everything downstream reads freq first, and the engines read note first
  const { note, ...rest } = value // eslint-disable-line no-unused-vars
  return { ...rest, freq: freqOf(midi) }
}
