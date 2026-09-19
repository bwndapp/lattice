import { useSyncExternalStore } from 'react'

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

/** The octave the keyboard starts from, as it was left last time. */
export function readOctave(key = OCTAVE_KEY, fallback = 4) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Number.isFinite(v) ? v : fallback } catch { return fallback }
}
export function writeOctave(v, key = OCTAVE_KEY) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* storage unavailable */ }
}

/*
 * There is one octave, and everywhere that plays notes from the keyboard shares it: the
 * roll's dock, a lone instrument on the patch, an instrument's own window. They each used
 * to keep their own, so moving down two octaves in the roll and then typing on the canvas
 * played somewhere else entirely — and the − and = keys appeared to do nothing, because
 * they were moving a different number than the one you were looking at.
 */
let octaveNow = null
const watching = new Set()
const octaveIs = () => (octaveNow == null ? (octaveNow = readOctave()) : octaveNow)

/** Move the shared octave. Everything showing it follows in the same frame. */
export function setOctave(next) {
  const want = Math.min(8, Math.max(0, Math.round(Number(next))))
  if (!Number.isFinite(want) || want === octaveIs()) return
  octaveNow = want
  writeOctave(want)
  for (const tell of watching) tell()
}

/** `const [octave, setOctave] = useOctave()` — the one the whole app plays from. */
export function useOctave() {
  const octave = useSyncExternalStore(
    (tell) => { watching.add(tell); return () => watching.delete(tell) },
    octaveIs,
    octaveIs,
  )
  return [octave, setOctave]
}
