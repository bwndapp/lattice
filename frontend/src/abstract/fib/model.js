/**
 * The Fibonacci machine: four layers, each a loop whose length and number of hits are
 * Fibonacci numbers. Two ways to spread the hits:
 *
 *   even     the hits as evenly as they'll go (a Euclidean rhythm): 3 in 8 is the tresillo,
 *            3 in 5 and 5 in 8 are grooves from all over Latin and African music
 *   golden   a window onto the Fibonacci word (1 0 1 1 0 1 0 1 1 …), which never repeats
 *            but never wanders either; `rotate` slides the window along it to find one
 *
 * Timing: `drift` plays every layer in sixteenths, so loops of 5, 8, 13 and 21 steps slide
 * against each other and the bar only lines up again much later; `bar` squeezes each loop
 * into one bar, so 5 steps become quintuplets.
 *
 * Pure functions, no UI: FibPanel.jsx draws this, the patch plays it.
 */

export const FIB = [1, 2, 3, 5, 8, 13, 21, 34, 55]
export const MAX_LAYERS = 16
export const MODES = ['even', 'golden']
export const TIMINGS = ['drift', 'bar']
const PHI = (1 + Math.sqrt(5)) / 2

/** Hits spread evenly: `hits` in `steps`, the first on step 0. */
export function evenRhythm(hits, steps) {
  return Array.from({ length: steps }, (_, i) => (((i * hits) % steps) < hits ? 1 : 0))
}

/** The Fibonacci word from `offset`, `steps` long: 1 0 1 1 0 1 0 1 1 0 1 1 0 … */
export function goldenRhythm(steps, offset = 0) {
  return Array.from({ length: steps }, (_, i) => {
    const n = i + offset + 1
    return Math.floor((n + 1) / PHI) - Math.floor(n / PHI)
  })
}

/** One layer's loop: 0 rest, 1 hit, 2 accent (the loop's first hit, so its downbeat is felt). */
export function layerSteps(layer) {
  const base = layer.mode === 'golden'
    ? goldenRhythm(layer.steps, layer.rotate)
    : evenRhythm(Math.min(layer.hits, layer.steps), layer.steps)
  // even rhythms rotate round their loop; the golden one already moved its window
  const r = layer.mode === 'golden' ? 0 : ((layer.rotate % layer.steps) + layer.steps) % layer.steps
  const out = base.map((_, i) => base[(i + r) % base.length])
  const first = out.indexOf(1)
  if (first >= 0) out[first] = 2
  return out
}

// ── settings ────────────────────────────────────────────────────────────────

const DEFAULT_LAYERS = [
  { mode: 'even', hits: 3, steps: 8, rotate: 0, sound: '', mute: false },
  { mode: 'even', hits: 2, steps: 5, rotate: 2, sound: '', mute: false },
  { mode: 'golden', hits: 8, steps: 13, rotate: 0, sound: '', mute: false },
  { mode: 'even', hits: 5, steps: 21, rotate: 3, sound: '', mute: false },
]
// '' is no sound of its own: the layer only plays what's wired into it
const soundToken = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '').slice(0, 40)
const pick = (v, list, d) => (list.includes(v) ? v : d)
const int = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d)

function cleanLayer(l = {}, d) {
  const steps = pick(Number(l.steps), FIB.filter((n) => n >= 2), d.steps)
  return {
    mode: pick(l.mode, MODES, d.mode),
    steps,
    hits: Math.min(steps, pick(Number(l.hits), FIB, d.hits)),
    rotate: int(l.rotate, d.rotate, 0, 999),
    sound: soundToken(l.sound ?? d.sound),
    mute: l.mute === true,
  }
}

/**
 * The layer that comes after `layers`: one step further along the Fibonacci numbers than
 * the last, with the number before it as its hits — 13 → 8 in 21, 21 → 13 in 34 — and
 * wrapping back down to short loops past 55, so a stack keeps finding new lengths.
 */
export function nextLayer(layers) {
  const last = layers[layers.length - 1]
  const long = FIB.filter((n) => n >= 3)
  const at = last ? long.indexOf(last.steps) : -1
  const steps = at >= 0 && at < long.length - 1 ? long[at + 1] : long[0]
  const hits = FIB[Math.max(0, FIB.indexOf(steps) - 1)]
  return { mode: 'even', hits, steps, rotate: layers.length % 4, sound: '', mute: false }
}

export const addLayer = (state) => (state.layers.length >= MAX_LAYERS ? state : { ...state, layers: [...state.layers, nextLayer(state.layers)] })
export const removeLayer = (state, i) => (state.layers.length <= 1 ? state : { ...state, layers: state.layers.filter((_, k) => k !== i) })

/** Anything → complete settings. A new machine has four layers; you can add up to sixteen. */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const given = Array.isArray(r.layers) && r.layers.length ? r.layers.slice(0, MAX_LAYERS) : DEFAULT_LAYERS
  const layers = given.map((l, i) => cleanLayer(l, DEFAULT_LAYERS[i] ?? nextLayer(given.slice(0, i))))
  return {
    layers,
    timing: pick(r.timing, TIMINGS, 'drift'),
    bank: typeof r.bank === 'string' ? r.bank.replace(/\W/g, '').slice(0, 40) : 'RolandTR909',
  }
}

/** A fresh roll of every layer: Fibonacci pairs and rotations, to go looking for a groove. */
export function roll(state, rand = Math.random) {
  const any = (list) => list[Math.floor(rand() * list.length)]
  return {
    ...state,
    layers: state.layers.map((l) => {
      const steps = any([3, 5, 8, 13, 21])
      const hits = any(FIB.filter((n) => n < steps))
      return { ...l, mode: rand() < 0.25 ? 'golden' : 'even', steps, hits, rotate: Math.floor(rand() * (steps + 8)) }
    }),
  }
}

// ── what it plays ───────────────────────────────────────────────────────────

const GAIN = ['0', '0.7', '1']
const VELOCITY = ['0', '0.7', '1']

/** A layer's tokens as mini-notation: sixteenths that drift, or the whole loop in one bar. */
const seq = (tokens, timing) => (timing === 'drift' ? `{${tokens.join(' ')}}%16` : tokens.join(' '))

/** Its layers: [{ id, name, expr, drive }] (see abstract/index.js). */
export function parts(state) {
  return state.layers.map((l, i) => {
    const vals = layerSteps(l)
    const live = !l.mute && vals.some(Boolean)
    const snd = soundToken(l.sound)
    let expr = null
    if (live && snd) {
      expr = `s("${seq(vals.map((v) => (v ? snd : '~')), state.timing)}")`
      if (state.bank) expr += `.bank("${state.bank}")`
      expr += `.gain("${seq(vals.map((v) => GAIN[v]), state.timing)}")`
    }
    const struct = seq(vals.map((v) => (v ? 't' : '~')), state.timing)
    const vel = seq(vals.map((v) => VELOCITY[v]), state.timing)
    return {
      id: `l${i}`,
      name: snd || 'no sound',
      expr,
      drive: (x) => (live ? `${x}.struct("${struct}").velocity("${vel}")` : null),
    }
  })
}

export function code(state) {
  const lines = parts(state).map((p) => p.expr).filter(Boolean)
  if (!lines.length) return 'silence'
  return lines.length === 1 ? lines[0] : `stack(${lines.join(', ')})`
}

/** The first bar, as a drum pattern of sixteenths, for the timeline to sketch. */
export function asPattern(state) {
  return {
    bars: 1,
    stepsPerBar: 16,
    channels: state.layers.map((l, i) => {
      const vals = layerSteps(l)
      const at = (s) => (state.timing === 'drift' ? vals[s % vals.length] : vals[Math.floor((s * vals.length) / 16)])
      return { id: `l${i}`, kind: 'drum', mute: l.mute, steps: Array.from({ length: 16 }, (_, s) => (at(s) ? 1 : 0)) }
    }),
  }
}
