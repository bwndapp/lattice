/**
 * Global tuning: where A4 sits, 440 Hz unless the track says otherwise. Applied once, on the
 * way to the speakers (routeVoice in fxbus.js), to every note that has a pitch — Strudel's
 * synths, sampled instruments and the app's own engines alike — so a track's code stays the
 * same whatever it's tuned to. A drum hit with no note keeps its own pitch, as a master tune
 * on a desk would leave it.
 */
export const A4 = 440
export const TUNING_MIN = 400
export const TUNING_MAX = 480

let ratio = 1

/** A4 right now, in Hz. */
export const currentA4 = () => A4 * ratio

/** The track's tuning, A4 in Hz. */
export function setTuning(hz) {
  const a4 = Number(hz)
  ratio = Number.isFinite(a4) && a4 > 0 ? Math.min(TUNING_MAX, Math.max(TUNING_MIN, a4)) / A4 : 1
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
  if (ratio === 1 || !value || typeof value !== 'object') return value
  if (typeof value.freq === 'number' && Number.isFinite(value.freq)) return { ...value, freq: value.freq * ratio }
  if (value.note == null) return value
  const midi = midiOf(value.note)
  if (midi == null) return value
  // the note goes: everything downstream reads freq first, and the engines read note first
  const { note, ...rest } = value // eslint-disable-line no-unused-vars
  return { ...rest, freq: 440 * 2 ** ((midi - 69) / 12) * ratio }
}
