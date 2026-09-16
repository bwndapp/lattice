/**
 * The computer keyboard as two octaves of piano, as trackers and DAWs lay them out:
 * z s x d c v g b h n j m , is one octave from C, q 2 w 3 e r 5 t 6 y 7 u is the next.
 * Used by the piano roll's dock and by instrument windows.
 */
export const KEYBOARD = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12, l: 13, '.': 14,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24,
}
export const KEY_LOW = 24
export const KEY_HIGH = 96
export const OCTAVE_KEY = 'strudel:roll:octave'

/** What a key press means: a MIDI note, an octave step (-1 / +1), or null. */
export function keyNote(key, octave) {
  const k = String(key).toLowerCase()
  if (k === '-' || k === '_' || k === '[') return { octave: -1 }
  if (k === '=' || k === '+' || k === ']') return { octave: 1 }
  const semitone = KEYBOARD[k]
  if (semitone === undefined) return null
  return { note: Math.min(KEY_HIGH, Math.max(KEY_LOW, (octave + 1) * 12 + semitone)) }
}

/** The octave the keyboard starts from, kept per place it's used (`key`). */
export function readOctave(key = OCTAVE_KEY, fallback = 4) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Number.isFinite(v) ? v : fallback } catch { return fallback }
}
export function writeOctave(v, key = OCTAVE_KEY) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* storage unavailable */ }
}
