/**
 * The groove engine: a drummer that knows styles. Pick one (house, breaks, funk…), turn
 * four knobs, roll for a new groove. Four lanes — kick, snare, hats, perc — over 1, 2 or 4
 * bars of sixteenths.
 *
 * Each style is a map of habits: for every lane and step, how likely a hit is there, which
 * hits are never left out (the kick on one, the backbeat) and where ghost notes and hat
 * rolls go. A lane's own seed rolls the dice, so a groove is a style plus four seeds:
 *
 *   density   how many of the likely hits get played (only adds hits as it goes up)
 *   swing     the off sixteenths pushed late, from straight to a heavy MPC shuffle
 *   ghosts    quiet snare notes in the gaps
 *   fills     how likely the last bar ends in a fill (and how long it runs)
 *
 * Every step draws its numbers whatever the knobs say, so turning a knob only moves the
 * line between hit and rest — the groove stays itself. Bars after the first are the first
 * with a few steps re-rolled, so it breathes without wandering. `lock` keeps a lane when
 * you roll the rest.
 *
 * Pure functions, no UI: GroovePanel.jsx draws this, the patch plays it.
 */

export const STEPS = 16
export const LENGTHS = [1, 2, 4]
export const LANES = ['kick', 'snare', 'hats', 'perc']

/**
 * The styles. A lane is 16 characters, one a step:
 *   .      never         1…9   a hit n times in 9
 *   x      always         X     always, accented
 *   g      a ghost note, if the ghosts knob lets it (snare lanes)
 *   r      a roll — a quick triplet of hits — if density lets it (hat lanes)
 */
export const STYLES = {
  house: {
    label: 'house',
    kick: 'X..1x...X..1x.2.',
    snare: '..g.X..1.g..X.g2',
    hats: '2.X22.X22.X22.Xr',
    perc: '..3..4.2.3..4..3',
  },
  breaks: {
    label: 'breaks',
    kick: 'X.x...3...x4..2.',
    snare: '..g.X.g5g5..X.g5',
    hats: 'X3x3X3x3X3x3X3x3',
    perc: '......3.....2..4',
  },
  funk: {
    label: 'funk',
    kick: 'X..4..x.4.x..3..',
    snare: 'g.g.X.gg.gg.X.g5',
    hats: 'X7x7X7x7X7x7X7x7',
    perc: '..3...4...3...4.',
  },
  afro: {
    label: 'afro',
    kick: 'X..5..x...x..4..',
    snare: '..g...5.g4..X..3',
    hats: 'x4X5x4X5x4X5x4X5',
    perc: 'x..x..x...x.x...',
  },
  hiphop: {
    label: 'boom bap',
    kick: 'X.....4x.x....3.',
    snare: '..g.X..g.g..X..g',
    hats: 'X2x2X2x2X2x2X2x2',
    perc: '......3.....2...',
  },
  dnb: {
    label: 'd&b',
    kick: 'X.3.......x.3...',
    snare: '..g.X.g3.g..X.g4',
    hats: 'X3x4X3x4X3x4X3x4',
    perc: '..3....4..3....4',
  },
  trap: {
    label: 'trap',
    kick: 'X.....3.x.3...4.',
    snare: '......g.X.....g.',
    hats: 'x7r7x7x7x7r7x7r7',
    perc: '...3......3..4..',
  },
  dembow: {
    label: 'dembow',
    kick: 'X...x...X...x...',
    snare: '...X..x....X..x.',
    hats: 'x3x3x3x3x3x3x3x3',
    perc: '..3...3...3...3.',
  },
}
export const STYLE_KEYS = Object.keys(STYLES)

// ── dice ────────────────────────────────────────────────────────────────────

/** A small seeded random source (mulberry32): the same seed, the same numbers. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mix = (...n) => n.reduce((h, v) => Math.imul(h ^ (v >>> 0), 0x9e3779b1) >>> 0, 0x811c9dc5)
export const newSeed = (rand = Math.random) => Math.floor(rand() * 2 ** 31)

// ── making a groove ─────────────────────────────────────────────────────────

// step values: 0 rest, 1 ghost, 2 hit, 3 accent, 4 roll
const VARY = 0.12 // the share of steps a later bar re-rolls

/** A step's chance of a hit at this density: none stays none, always stays always. */
function chance(ch, density) {
  if (ch === 'x' || ch === 'X') return 1
  const w = ch >= '1' && ch <= '9' ? Number(ch) / 9 : ch === 'r' ? 0.25 : 0
  if (!w) return 0
  return density <= 0.5 ? w * density * 2 : w + (1 - w) * (density - 0.5) * 1.2
}

/** One step, from its character and its dice (u: hit or not, v: ghost/roll or not). */
function stepValue(ch, u, v, k) {
  if (ch === 'X') return 3
  if (ch === 'x') return 2
  if (ch === 'g') return v < k.ghosts * 0.75 ? 1 : 0
  if (ch === 'r') return u < chance(ch, k.density) ? 4 : v < chance('5', k.density) ? 2 : 0
  return u < chance(ch, k.density) ? 2 : 0
}

/** A fill over the end of the bar: kick thins out, the snare runs up to the downbeat. */
function fillBar(vals, lane, from, r) {
  const out = [...vals]
  for (let s = from; s < STEPS; s++) {
    const u = r()
    const rise = (s - from + 1) / (STEPS - from) // quiet to loud as it nears the end
    if (lane === 'kick') out[s] = s === from || u < 0.2 ? 2 : 0
    else if (lane === 'snare') out[s] = u < 0.55 + 0.4 * rise ? (rise > 0.7 ? 3 : rise > 0.35 ? 2 : 1) : 0
    else if (lane === 'perc') out[s] = u < 0.35 ? 2 : 0
    else if (lane === 'hats') out[s] = s === STEPS - 1 ? 0 : out[s]
  }
  return out
}

/** One lane, every bar: bars × 16 values. */
export function laneBars(state, i) {
  const lane = LANES[i]
  const pat = STYLES[state.style][lane]
  const seed = state.lanes[i].seed
  const k = state
  // bar one: its dice drawn step by step, whatever the knobs say
  const r = rng(mix(seed, i, 1))
  const dice = Array.from({ length: STEPS }, () => [r(), r()])
  const first = dice.map(([u, v], s) => stepValue(pat[s], u, v, k))
  const bars = [first]
  for (let b = 1; b < state.bars; b++) {
    const rb = rng(mix(seed, i, 100 + b))
    bars.push(first.map((val, s) => {
      const [w, u, v] = [rb(), rb(), rb()]
      const ch = pat[s]
      return w < VARY && ch !== 'x' && ch !== 'X' ? stepValue(ch, u, v, k) : val
    }))
  }
  // the last bar's fill: one die says whether, the knob says how likely and how long
  if (state.bars > 1 && state.fills > 0) {
    const rf = rng(mix(state.lanes[1].seed, 7)) // every lane agrees on the fill (it's the snare's call)
    const go = rf() < state.fills
    const from = state.fills > 0.66 ? 8 : 12
    if (go) bars[bars.length - 1] = fillBar(bars[bars.length - 1], lane, from, rng(mix(seed, i, 900)))
  }
  return bars
}

// ── settings ────────────────────────────────────────────────────────────────

// '' is no sound of its own: the lane only plays what's wired into it
const soundToken = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '').slice(0, 40)
const unit = (v, d) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : d)
const seedOf = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d)
const DEFAULT_SEEDS = [11, 43, 37, 41]

/** Anything → complete settings. */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    style: STYLES[r.style] ? r.style : 'house',
    bars: LENGTHS.includes(Number(r.bars)) ? Number(r.bars) : 4,
    density: unit(r.density, 0.5),
    swing: unit(r.swing, 0),
    ghosts: unit(r.ghosts, 0.4),
    fills: unit(r.fills, 0.5),
    lanes: LANES.map((_, i) => {
      const l = r.lanes?.[i] ?? {}
      return { sound: soundToken(l.sound ?? ''), mute: l.mute === true, lock: l.lock === true, seed: seedOf(l.seed, DEFAULT_SEEDS[i]) }
    }),
    bank: typeof r.bank === 'string' ? r.bank.replace(/\W/g, '').slice(0, 40) : 'RolandTR909',
  }
}

/** A new groove: fresh dice for every lane that isn't locked. */
export function roll(state, rand = Math.random) {
  return { ...state, lanes: state.lanes.map((l) => (l.lock ? l : { ...l, seed: newSeed(rand) })) }
}

/** Fresh dice for one lane. */
export const rollLane = (state, i, rand = Math.random) => ({ ...state, lanes: state.lanes.map((l, k) => (k === i ? { ...l, seed: newSeed(rand) } : l)) })

// ── what it plays ───────────────────────────────────────────────────────────

const GAIN = ['0', '0.35', '0.75', '1', '0.6']
const VELOCITY = GAIN

/** Bars of values as mini-notation, a bar a cycle: a roll is three hits in its sixteenth. */
function mini(bars, tok) {
  const bar = (vals) => vals.map((v) => (v === 4 ? `[${tok(v)} ${tok(v)} ${tok(v)}]` : tok(v))).join(' ')
  return bars.length === 1 ? bar(bars[0]) : `<${bars.map((b) => `[${bar(b)}]`).join(' ')}>`
}

/** The swing, as Strudel: the second sixteenth of each eighth late by up to half a step. */
const swingOf = (state) => (state.swing > 0.001 ? `.swingBy(${(state.swing * 0.5).toFixed(3)}, 8)` : '')

/** Its layers: [{ id, name, expr, drive }] (see abstract/index.js). */
export function parts(state) {
  return state.lanes.map((l, i) => {
    const bars = laneBars(state, i)
    const live = !l.mute && bars.some((b) => b.some(Boolean))
    const snd = soundToken(l.sound)
    const sw = swingOf(state)
    let expr = null
    if (live && snd) {
      expr = `s("${mini(bars, (v) => (v ? snd : '~'))}")`
      if (state.bank) expr += `.bank("${state.bank}")`
      expr += `.gain("${mini(bars, (v) => GAIN[v])}")${sw}`
    }
    const struct = mini(bars, (v) => (v ? 't' : '~'))
    const vel = mini(bars, (v) => VELOCITY[v])
    return {
      id: `g${i}`,
      name: snd || LANES[i],
      expr,
      drive: (x) => (live ? `${x}.struct("${struct}").velocity("${vel}")${sw}` : null),
    }
  })
}

export function code(state) {
  const lines = parts(state).map((p) => p.expr).filter(Boolean)
  if (!lines.length) return 'silence'
  return lines.length === 1 ? lines[0] : `stack(${lines.join(', ')})`
}

/** What it plays, as a drum pattern for the timeline to sketch on its clips. */
export function asPattern(state) {
  return {
    bars: state.bars,
    stepsPerBar: STEPS,
    channels: state.lanes.map((l, i) => ({ id: `g${i}`, kind: 'drum', mute: l.mute, steps: laneBars(state, i).flat().map((v) => (v ? 1 : 0)) })),
  }
}
