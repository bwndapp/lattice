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
 * Evolve (off unless asked): the loops change as the song goes, through GENERATIONS
 * generations of `every` bars each, then round again — and the changes are Fibonacci too:
 *
 *   when    layer one changes every generation, layer two every 2, then every 3, 5, 8 …:
 *           the loops mutate on nested time scales, fast inside slow, like the rhythm itself
 *   what    the Fibonacci word decides, a letter per change (offset per layer, so they don't
 *           move together): a 1 turns the loop by the golden angle (0.382 of it), a 0 moves
 *           its hits on to the next Fibonacci number that fits
 *
 * It's worked out from the generation alone, never from what played before, so any point in
 * the song always sounds the same: seeking, looping and exporting all agree.
 *
 * Pure functions, no UI: FibPanel.jsx draws this, the patch plays it.
 */

export const FIB = [1, 2, 3, 5, 8, 13, 21, 34, 55]
export const MAX_LAYERS = 16
export const MODES = ['even', 'golden']
export const TIMINGS = ['drift', 'bar']
/** Evolve: bars per generation, and how many generations before it comes round again. */
export const EVOLVE_EVERY = [1, 2, 3, 5, 8, 13]
export const GENERATIONS = 13
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
    evolve: r.evolve === true,
    every: pick(Number(r.every), EVOLVE_EVERY, 2),
    bank: typeof r.bank === 'string' ? r.bank.replace(/\W/g, '').slice(0, 40) : 'RolandTR909',
  }
}

/** A fresh roll of every layer: Fibonacci pairs and rotations, to go looking for a groove. */
export function roll(state, rand = Math.random) {
  const any = (list) => list[Math.floor(rand() * list.length)]
  return {
    ...state,
    layers: state.layers.map((l) => {
      // the long loops come up less often: they take a while to come round
      const steps = any([3, 5, 8, 13, 21, 3, 5, 8, 13, 21, 34, 55])
      const hits = any(FIB.filter((n) => n < steps))
      return { ...l, mode: rand() < 0.25 ? 'golden' : 'even', steps, hits, rotate: Math.floor(rand() * (steps + 8)) }
    }),
  }
}

// ── evolving ────────────────────────────────────────────────────────────────

/** How many generations apart layer `i`'s changes come: 1, 2, 3, 5, 8, then round again. */
const PERIODS = [1, 2, 3, 5, 8]
/** Layer `i` as it is at generation `g` (generation 0 is the layer as set). */
export function layerAt(layer, i, g) {
  if (!(g > 0)) return layer
  const period = PERIODS[i % PERIODS.length]
  const word = goldenRhythm(GENERATIONS + 1, i * 3) // its own stretch of the Fibonacci word
  const fits = FIB.filter((n) => n <= layer.steps)
  let { hits, rotate } = layer
  let e = 0
  for (let k = period; k <= g; k += period) {
    if (word[e % word.length]) rotate += Math.max(1, Math.round(layer.steps * (2 - PHI))) // the golden angle
    else if (layer.mode === 'golden') rotate += FIB[e % FIB.length] // the window slides on
    else hits = fits[(Math.max(0, fits.indexOf(hits)) + 1) % fits.length] // the next Fibonacci number that fits
    e++
  }
  return { ...layer, hits: Math.min(hits, layer.steps), rotate: rotate % 999 }
}

/** Which generation a song position (in bars) is in. */
export const generationAt = (state, bar) => (state.evolve ? Math.floor(Math.max(0, bar) / state.every) % GENERATIONS : 0)

// ── what it plays ───────────────────────────────────────────────────────────

const GAIN = ['0', '0.7', '1']
const VELOCITY = ['0', '0.7', '1']

/** A layer's tokens as mini-notation: sixteenths that drift, or the whole loop in one bar. */
const seq = (tokens, timing) => (timing === 'drift' ? `{${tokens.join(' ')}}%16` : tokens.join(' '))

/**
 * One layer's tokens as a pattern, turned into mini-notation by `tok`. Still: the loop.
 * Evolving: an arrange of its generations, one section a run of generations that don't
 * change it. In drift each section starts where the sixteenths have got to by then, so the
 * loop runs on through a change instead of jumping back to its start.
 */
function layerPattern(state, l, i, tok) {
  if (!state.evolve) return `"${seq(layerSteps(l).map(tok), state.timing)}"`
  const sections = []
  for (let g = 0; g < GENERATIONS; g++) {
    const at = layerAt(l, i, g)
    const last = sections[sections.length - 1]
    if (last && last.hits === at.hits && last.rotate === at.rotate) { last.bars += state.every; continue }
    let vals = layerSteps(at)
    if (state.timing === 'drift') {
      const phase = (16 * state.every * g) % vals.length
      vals = [...vals.slice(phase), ...vals.slice(0, phase)]
    }
    sections.push({ hits: at.hits, rotate: at.rotate, bars: state.every, text: seq(vals.map(tok), state.timing) })
  }
  return sections.length === 1 ? `"${sections[0].text}"` : `arrange(${sections.map((x) => `[${x.bars}, "${x.text}"]`).join(', ')})`
}

/** Its layers: [{ id, name, expr, drive }] (see abstract/index.js). */
export function parts(state) {
  return state.layers.map((l, i) => {
    const gens = state.evolve ? Array.from({ length: GENERATIONS }, (_, g) => layerSteps(layerAt(l, i, g))) : [layerSteps(l)]
    const live = !l.mute && gens.some((vals) => vals.some(Boolean))
    const snd = soundToken(l.sound)
    let expr = null
    if (live && snd) {
      expr = `s(${layerPattern(state, l, i, (v) => (v ? snd : '~'))})`
      if (state.bank) expr += `.bank("${state.bank}")`
      expr += `.gain(${layerPattern(state, l, i, (v) => GAIN[v])})`
    }
    const struct = layerPattern(state, l, i, (v) => (v ? 't' : '~'))
    const vel = layerPattern(state, l, i, (v) => VELOCITY[v])
    return {
      id: `l${i}`,
      name: snd || 'no sound',
      expr,
      drive: (x) => (live ? `${x}.struct(${struct}).velocity(${vel})` : null),
    }
  })
}

export function code(state) {
  const lines = parts(state).map((p) => p.expr).filter(Boolean)
  if (!lines.length) return 'silence'
  return lines.length === 1 ? lines[0] : `stack(${lines.join(', ')})`
}

// the longest sketch a drift makes: past it, the timeline repeats it (loops of 5, 13 and
// 21 only meet again after 1365 bars)
export const SKETCH_BARS = 32
const gcd = (a, b) => (b ? gcd(b, a % b) : a)

/**
 * What it plays, as a drum pattern for the timeline to sketch. In drift that's sixteenths,
 * every bar until the loops line up again (up to SKETCH_BARS), so a clip shows them sliding.
 * In bar each loop fills one bar, so the grid is fine enough for the longest loop (a 21 gets
 * 32 slots a bar, a 55 gets 64) and every hit lands in a slot of its own.
 */
export function asPattern(state) {
  const live = state.layers.filter((l) => !l.mute)
  const drift = state.timing === 'drift'
  const period = drift ? live.reduce((a, l) => (a * l.steps) / gcd(a, l.steps), 16) : 16
  // evolving, it comes round once every generation has played
  const bars = Math.min(SKETCH_BARS, state.evolve ? GENERATIONS * state.every : period / 16)
  const grid = drift ? 16 : 16 * Math.ceil(Math.max(16, ...state.layers.map((l) => l.steps)) / 16)
  const valsAt = (l, i, bar) => layerSteps(layerAt(l, i, generationAt(state, bar)))
  return {
    bars,
    stepsPerBar: grid,
    channels: state.layers.map((l, i) => {
      let steps
      if (drift) steps = Array.from({ length: bars * 16 }, (_, s) => { const vals = valsAt(l, i, Math.floor(s / 16)); return vals[s % vals.length] ? 1 : 0 })
      else {
        steps = Array(grid * bars).fill(0)
        for (let b = 0; b < bars; b++) {
          const vals = valsAt(l, i, b)
          vals.forEach((v, k) => { if (v) steps[b * grid + Math.round((k * grid) / vals.length)] = 1 })
        }
      }
      return { id: `l${i}`, kind: 'drum', mute: l.mute, steps }
    }),
  }
}
