/**
 * Syrup's wavetables, written once as source: the audio thread builds them from this to
 * play them, and the window builds them from the same text to draw them.
 *
 * Every table is kept as harmonics (a sine and a cosine amount per harmonic, per frame),
 * and played from copies with fewer harmonics as notes get higher, so no harmonic ever
 * lands above what the sample rate can hold (that's what makes a wavetable fizz).
 *
 *   syTable(index) → { frames, levels: [{ harmonics, length, data: Float32Array[] }] }
 *
 * Levels run from all 40 harmonics down to 1; `data[f]` is frame f, `length` samples long.
 */
export const TABLES_SOURCE = `
const SY_FRAMES = 32
const SY_H = 40
const SY_LEVELS = [[40, 1024], [20, 512], [10, 256], [5, 128], [2, 64], [1, 32]]
const syTableCache = []

function syHarmonics(index) {
  const H = SY_H
  const frames = []
  const add = (fn) => { for (let f = 0; f < SY_FRAMES; f++) frames.push(fn(f / (SY_FRAMES - 1))) }
  const shapes = {
    sine: (h) => (h === 1 ? 1 : 0),
    tri: (h) => (h % 2 ? ((((h - 1) / 2) % 2 ? -1 : 1) * 8) / (Math.PI * Math.PI * h * h) : 0),
    saw: (h) => (2 / Math.PI) * ((h % 2 ? 1 : -1) / h),
    square: (h) => (h % 2 ? 4 / (Math.PI * h) : 0),
  }
  // a shape drawn in time, turned into harmonics
  const fromTime = (fn) => (t) => {
    const N = 1024
    const s = new Float32Array(H + 1)
    const c = new Float32Array(H + 1)
    for (let i = 0; i < N; i++) {
      const y = fn(t, i / N)
      for (let h = 1; h <= H; h++) {
        const a = (2 * Math.PI * h * i) / N
        s[h] += (2 / N) * y * Math.sin(a)
        c[h] += (2 / N) * y * Math.cos(a)
      }
    }
    return { s, c }
  }
  const sines = (fn) => (t) => {
    const s = new Float32Array(H + 1)
    for (let h = 1; h <= H; h++) s[h] = fn(h, t)
    return { s, c: null }
  }
  if (index === 0) { // basic: sine → triangle → saw → square
    const morph = ['sine', 'tri', 'saw', 'square']
    add(sines((h, t) => {
      const x = t * (morph.length - 1)
      const i = Math.min(morph.length - 2, Math.floor(x))
      const k = x - i
      return shapes[morph[i]](h) * (1 - k) + shapes[morph[i + 1]](h) * k
    }))
  } else if (index === 1) { // bright: one harmonic → all of them
    add(sines((h, t) => Math.min(1, Math.max(0, 1 + t * (H - 1) - h + 1)) / h))
  } else if (index === 2) { // pulse: wide → thin
    add((t) => {
      const w = 0.5 - t * 0.46
      const c = new Float32Array(H + 1)
      for (let h = 1; h <= H; h++) c[h] = (2 / (h * Math.PI)) * Math.sin(Math.PI * h * w)
      return { s: new Float32Array(H + 1), c }
    })
  } else if (index === 3) { // vowel: a e i o u
    const vowels = [[800, 1150], [400, 1600], [270, 2300], [450, 800], [325, 700]]
    add(sines((h, t) => {
      const x = t * (vowels.length - 1)
      const i = Math.min(vowels.length - 2, Math.floor(x))
      const k = x - i
      const F1 = vowels[i][0] * (1 - k) + vowels[i + 1][0] * k
      const F2 = vowels[i][1] * (1 - k) + vowels[i + 1][1] * k
      const f = h * 110
      return Math.exp(-(((f - F1) / 140) ** 2)) + 0.6 * Math.exp(-(((f - F2) / 220) ** 2)) + 0.08 / h
    }))
  } else if (index === 4) { // sync, climbing
    add(fromTime((t, p) => (2 * ((p * (1 + t * 5)) % 1) - 1) * (0.35 + 0.65 * Math.sin(Math.PI * p))))
  } else { // fold
    add(fromTime((t, p) => Math.sin((1 + t * 5) * (Math.PI / 2) * Math.sin(2 * Math.PI * p))))
  }
  return frames
}

function syTable(index) {
  if (syTableCache[index]) return syTableCache[index]
  const harmonics = syHarmonics(index)
  const levels = SY_LEVELS.map(([count, length]) => {
    const data = harmonics.map(({ s, c }) => {
      const out = new Float32Array(length + 1) // one more, so reading between samples never wraps
      for (let h = 1; h <= count; h++) {
        const a = s[h] || 0
        const b = c ? c[h] || 0 : 0
        if (!a && !b) continue
        for (let i = 0; i < length; i++) {
          const x = (2 * Math.PI * h * i) / length
          out[i] += a * Math.sin(x) + b * Math.cos(x)
        }
      }
      out[length] = out[0]
      return out
    })
    return { harmonics: count, length, data }
  })
  // every frame peaks just under full scale; its thinner copies keep the same scale
  for (let f = 0; f < SY_FRAMES; f++) {
    let peak = 0
    for (const v of levels[0].data[f]) peak = Math.max(peak, Math.abs(v))
    if (peak > 0) for (const level of levels) { const d = level.data[f]; for (let i = 0; i < d.length; i++) d[i] *= 0.95 / peak }
  }
  syTableCache[index] = { frames: SY_FRAMES, levels }
  return syTableCache[index]
}
`

let built = null
/** The tables on this side, for drawing: one frame of a table at a position 0 … 1. */
export function tableFrame(index, pos) {
  // eslint-disable-next-line no-new-func
  if (!built) built = new Function(`${TABLES_SOURCE}; return syTable`)()
  const table = built(index)
  const f = Math.round(Math.min(1, Math.max(0, pos)) * (table.frames - 1))
  const level = table.levels[0]
  return level.data[f].subarray(0, level.length)
}
