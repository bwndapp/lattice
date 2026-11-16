/**
 * The harmony engine: chords, a bass line, a melody and an arpeggio, all in one key, made
 * the way the groove engine makes drums — a few choices, a roll of the dice, and it plays.
 *
 *   key, scale     every note it plays is in them
 *   progression    a chord a bar, as scale degrees (1 = the key's own chord); roll for a new
 *                  one or step any chord through the degrees
 *   chords         the progression voiced close and led smoothly from chord to chord, on a
 *                  rhythm you pick (held, pulses, offbeat stabs…)
 *   bass           the chord roots, low, on a rhythm of their own
 *   melody         a line over the chords: chord tones on the strong beats, steps and leaps
 *                  between; its rhythm comes back every other bar, so it sounds like a tune
 *   arp            the chord's notes one at a time, up, down or wandering
 *
 * Knobs: density (how many notes the melody and arp play), motion (steps or leaps), colour
 * (plain triads up to sevenths and ninths) and swing.
 *
 * Like the rhythm machines, a layer's trigger fires an instrument (Syrup, say) — and here
 * the trigger carries the notes too, so whatever it fires plays the harmony. A lane's seed
 * rolls its dice; `lock` keeps a lane when you roll the rest.
 *
 * Pure functions, no UI: HarmonyPanel.jsx draws this, the patch plays it.
 */

export const STEPS = 16
export const LENGTHS = [2, 4, 8]
export const LANES = ['chords', 'bass', 'melody', 'arp']
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

export const SCALES = {
  major: { label: 'major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { label: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  phrygian: { label: 'phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  harmonic: { label: 'harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
}
export const SCALE_KEYS = Object.keys(SCALES)

/** Progressions people come back to, as degrees: bright ones for major keys, dark for minor. */
const BRIGHT = [[1, 5, 6, 4], [1, 6, 4, 5], [6, 4, 1, 5], [1, 4, 6, 5], [2, 5, 1, 6], [1, 3, 4, 4], [4, 1, 5, 6], [1, 5, 4, 4], [4, 5, 3, 6]]
const DARK = [[1, 6, 3, 7], [1, 7, 6, 7], [1, 4, 7, 3], [6, 7, 1, 1], [1, 6, 7, 5], [1, 4, 6, 5], [1, 3, 7, 4], [1, 4, 1, 5], [4, 6, 7, 1]]

/**
 * Rhythms, a bar of sixteenths each:  x a note   - held on   . rest   o a note an octave up
 */
export const CHORD_RHYTHMS = {
  hold: { label: 'held', bar: 'x---------------' },
  pulse: { label: 'pulses', bar: 'x---x---x---x---' },
  eighths: { label: 'eighths', bar: 'x-x-x-x-x-x-x-x-' },
  offbeat: { label: 'offbeat', bar: '..x-..x-..x-..x-' },
  stabs: { label: 'stabs', bar: 'x--x--x---x--x--' },
  charleston: { label: 'charleston', bar: 'x-----x---------' },
}
export const BASS_RHYTHMS = {
  hold: { label: 'held', bar: 'x---------------' },
  pulse: { label: 'eighths', bar: 'x-x-x-x-x-x-x-x-' },
  offbeat: { label: 'offbeat', bar: '..x-..x-..x-..x-' },
  octave: { label: 'octaves', bar: 'x-o-x-o-x-o-x-o-' },
  synco: { label: 'syncopated', bar: 'x--x--x---x-x---' },
  sub: { label: 'sub', bar: 'x-------x--x----' },
}
export const ARP_MODES = { up: 'up', down: 'down', updown: 'up & down', random: 'wander' }
export const ARP_RATES = [8, 16]

// ── dice (as the groove engine's) ────────────────────────────────────────────

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

// ── harmony ─────────────────────────────────────────────────────────────────

const isMinor = (scale) => SCALES[scale].steps[2] === 3

/** A scale degree (0-based, any whole number, 7 = the octave) → a MIDI note above `base`. */
export const degreeNote = (state, d, base) => {
  const st = SCALES[state.scale].steps
  return base + state.key + 12 * Math.floor(d / 7) + st[((d % 7) + 7) % 7]
}

/** How many notes each bar's chord has (3, 4 or 5): colour and the chords lane's dice decide. */
function chordSizes(state) {
  const r = rng(mix(state.lanes[0].seed, 5))
  return state.progression.map(() => {
    const [u, v] = [r(), r()]
    const seventh = u < state.color * 1.4
    const ninth = seventh && v < (state.color - 0.5) * 2
    return 3 + (seventh ? 1 : 0) + (ninth ? 1 : 0)
  })
}

/** Each bar's chord as scale degrees (0-based): its root, third, fifth… */
export function chordDegrees(state) {
  const sizes = chordSizes(state)
  return state.progression.map((deg, i) => Array.from({ length: sizes[i] }, (_, k) => deg - 1 + 2 * k))
}

/**
 * The chords voiced: each one the inversion nearest the chord before (voice leading), so
 * the notes move as little as they can. Around C3–C4, moved by the lane's octave.
 */
export function voicings(state) {
  const base = 48 + 12 * state.lanes[0].octave
  let prev = null
  return chordDegrees(state).map((degs) => {
    const pcs = degs.map((d) => degreeNote(state, d, 0))
    const cands = []
    for (let inv = 0; inv < pcs.length; inv++) {
      const notes = pcs.map((n, k) => n + (k < inv ? 12 : 0))
      const lo = Math.min(...notes)
      for (const o of [-12, 0]) {
        const shift = base + o + ((((lo - base) % 12) + 12) % 12) - lo // its bottom note in the octave from base + o
        cands.push(notes.map((n) => n + shift).sort((a, b) => a - b))
      }
    }
    const cost = (v) => (prev ? v.reduce((s, n, k) => s + Math.abs(n - (prev[Math.min(k, prev.length - 1)])), 0) : Math.abs(v[0] - (base + 4)))
    const inRange = cands.filter((v) => v[0] >= base - 5 && v[v.length - 1] <= base + 22)
    const best = (inRange.length ? inRange : cands).reduce((a, b) => (cost(b) < cost(a) ? b : a))
    prev = best
    return best
  })
}

/** A chord's name, as a musician writes it: Am7, Fmaj7, G, B°. */
export function chordName(state, i) {
  const degs = chordDegrees(state)[i]
  const n = degs.map((d) => degreeNote(state, d, 0))
  const root = ((n[0] % 12) + 12) % 12
  const third = n[1] - n[0]
  const fifth = n[2] - n[0]
  let q = third === 3 ? (fifth === 6 ? 'dim' : 'm') : fifth === 8 ? 'aug' : ''
  if (n.length >= 4) {
    const sev = n[3] - n[0]
    if (q === '') q = sev === 11 ? 'maj7' : '7'
    else if (q === 'm') q = sev === 11 ? 'm(maj7)' : 'm7'
    else if (q === 'dim') q = sev === 9 ? '°7' : 'ø7'
    else q = sev === 11 ? 'aug(maj7)' : 'aug7'
    if (n.length >= 5) q = q.replace('7', '9')
  } else if (q === 'dim') q = '°'
  return NOTE_NAMES[root] + q
}

/** A chord's numeral: upper case for major, lower for minor, ° for diminished. */
export function numeral(state, i) {
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
  const deg = state.progression[i]
  const n = [0, 2, 4].map((k) => degreeNote(state, deg - 1 + k, 0))
  const minor = n[1] - n[0] === 3
  const dim = n[2] - n[0] === 6
  const r = ROMAN[deg - 1]
  return (minor ? r.toLowerCase() : r) + (dim ? '°' : '')
}

/** A new progression for this scale: a favourite, or a walk the way chords like to go. */
export function newProgression(scale, bars, rand = Math.random) {
  const pool = isMinor(scale) ? DARK : BRIGHT
  let four
  if (rand() < 0.6) four = pool[Math.floor(rand() * pool.length)]
  else {
    // where each degree likes to go next
    const NEXT = { 1: [4, 5, 6, 2, 3], 2: [5, 7, 4], 3: [6, 4], 4: [5, 1, 2, 6], 5: [1, 6, 4], 6: [4, 2, 5, 3], 7: [1, 3, 6] }
    four = [1]
    while (four.length < 4) { const opts = NEXT[four[four.length - 1]]; four.push(opts[Math.floor(rand() * opts.length)]) }
  }
  if (bars === 2) return four.slice(0, 2)
  if (bars === 8) return [...four, ...four.slice(0, 3), four[3] === 5 ? 4 : 5]
  return [...four]
}

// ── the lanes ───────────────────────────────────────────────────────────────

// a step: null rest, 'hold' the note before goes on, or { notes: [midi…], vel }
const hold = 'hold'

/** A rhythm bar → steps, each hit made by `hit(step, octaveUp)`. */
const fromBar = (bar, hit) => [...bar].map((c, s) => (c === 'x' || c === 'o' ? hit(s, c === 'o') : c === '-' ? hold : null))

function chordLane(state) {
  const v = voicings(state)
  const bar = CHORD_RHYTHMS[state.lanes[0].rhythm].bar
  return v.map((notes) => fromBar(bar, (s) => ({ notes, vel: s === 0 ? 0.85 : 0.7 })))
}

function bassLane(state) {
  const base = 36 + 12 * state.lanes[1].octave
  const bar = BASS_RHYTHMS[state.lanes[1].rhythm].bar
  return state.progression.map((deg) => {
    const pc = degreeNote(state, deg - 1, 0)
    const root = base + (((pc - base) % 12) + 12) % 12
    return fromBar(bar, (s, up) => ({ notes: [root + (up ? 12 : 0)], vel: s % 4 === 0 ? 0.9 : 0.75 }))
  })
}

// how likely the melody plays on each sixteenth: the beat, then the eighths, then the rest
const MELODY_W = [9, 1, 4, 2, 7, 1, 4, 3, 8, 1, 4, 2, 7, 2, 5, 3].map((w) => w / 9)

function melodyLane(state) {
  const l = state.lanes[2]
  const bars = state.progression.length
  const degs = chordDegrees(state)
  const base = 48 + 12 * l.octave // the line runs from about C4 to G5
  // two rhythms, A and B, that take turns (bar 1 A, bar 2 B, bar 3 A…): it repeats like a tune
  const rhythm = (which) => {
    const r = rng(mix(l.seed, 11, which))
    const p = state.density <= 0.5 ? state.density * 2 : 1
    const extra = state.density > 0.5 ? (state.density - 0.5) * 1.2 : 0
    const hits = MELODY_W.map((w) => { const u = r(); return u < w * p + (1 - w) * extra })
    hits[0] = hits[0] || which === 0 // the tune starts on the one
    return hits
  }
  const A = rhythm(0)
  const B = rhythm(1)
  const ending = rhythm(2).map((h, s) => (s < 8 ? h : s === 8)) // the last bar lands and stays
  const r = rng(mix(l.seed, 23))
  let d = 7 // where the line is, as a degree above the base (7: the octave)
  let dir = r() < 0.5 ? 1 : -1
  const out = []
  for (let b = 0; b < bars; b++) {
    const hits = b === bars - 1 && bars > 2 ? ending : b % 2 ? B : A
    const tones = degs[b].map((x) => ((x % 7) + 7) % 7)
    const nearestTone = (from) => {
      let best = from
      for (let k = 0; k <= 7; k++) {
        if (tones.includes((((from + k) % 7) + 7) % 7)) { best = from + k; break }
        if (tones.includes((((from - k) % 7) + 7) % 7)) { best = from - k; break }
      }
      return best
    }
    const steps = []
    let last = -1
    for (let s = 0; s < STEPS; s++) {
      const landed = b === bars - 1 && bars > 2 && s > 8 // the last note rings out
      if (!hits[s]) { steps.push(last >= 0 && (s - last < 4 || landed) && steps[s - 1] !== null ? hold : null); continue }
      const u = r()
      const strong = s % 4 === 0
      if (strong) {
        // a chord tone: sometimes the one it's on, mostly the next one along, with motion
        // sometimes the one after that
        const isTone = (x) => tones.includes(((x % 7) + 7) % 7)
        const along = (from) => { let t = from + dir; while (!isTone(t)) t += dir; return t }
        if (u < 0.25 && isTone(d)) { /* stay */ } else if (u < 0.25 + state.motion * 0.4) d = along(along(d))
        else d = isTone(d) || r() < 0.5 ? along(d) : nearestTone(d)
      } else {
        const leap = u < state.motion * 0.35 ? 2 + Math.floor(r() * 3) : u < 0.25 + state.motion * 0.4 ? 2 : 1
        d += dir * leap
      }
      // keep it in two octaves, turning round at the edges, and sometimes anyway
      if (d > 13) { d = 13; dir = -1 } else if (d < 2) { d = 2; dir = 1 } else if (r() < 0.25) dir = -dir
      if (b === bars - 1 && s === 8 && bars > 2) d = nearestTone(7) // the end comes home
      steps.push({ notes: [degreeNote(state, d, base)], vel: strong ? 0.9 : 0.72 })
      last = s
    }
    out.push(steps)
  }
  return out
}

function arpLane(state) {
  const l = state.lanes[3]
  const v = voicings(state)
  const every = 16 / l.rate
  const r = rng(mix(l.seed, 31))
  const gate = Array.from({ length: STEPS }, () => r()) // dice for which steps sound, the same every bar
  return v.map((chord) => {
    // the chord over two octaves
    const tones = [...chord, ...chord.map((n) => n + 12)].map((n) => n + 12 * l.octave)
    const updown = [...tones, ...tones.slice(1, -1).reverse()]
    let k = 0
    return Array.from({ length: STEPS }, (_, s) => {
      if (s % every) return null
      const p = state.density <= 0.5 ? 0.4 + state.density * 1.2 : 1
      const on = gate[s] < p || s === 0
      const i = k++
      if (!on) return null
      const n = l.mode === 'down' ? tones[tones.length - 1 - (i % tones.length)]
        : l.mode === 'updown' ? updown[i % updown.length]
          : l.mode === 'random' ? tones[Math.floor(rng(mix(l.seed, i, s))() * tones.length)]
            : tones[i % tones.length]
      return { notes: [n], vel: s % 4 === 0 ? 0.85 : 0.65 }
    })
  })
}

/** Every lane's bars: [lane][bar][step]. */
export function lanes(state) {
  return [chordLane(state), bassLane(state), melodyLane(state), arpLane(state)]
}

// ── settings ────────────────────────────────────────────────────────────────

const soundToken = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '').slice(0, 40)
const unit = (v, d) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : d)
const seedOf = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d)
const octOf = (v) => (Number.isInteger(v) ? Math.min(2, Math.max(-2, v)) : 0)
const DEFAULT_SEEDS = [7, 19, 29, 47]

/** Anything → complete settings. A new one is in A minor, i–VI–III–VII. */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const scale = SCALES[r.scale] ? r.scale : 'minor'
  const given = Array.isArray(r.progression) ? r.progression.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : []
  const progression = LENGTHS.includes(given.length) ? given : [1, 6, 3, 7]
  const L = r.lanes ?? []
  const lane = (i, extra) => ({
    sound: soundToken(L[i]?.sound ?? ''),
    mute: L[i]?.mute === true,
    lock: L[i]?.lock === true,
    seed: seedOf(L[i]?.seed, DEFAULT_SEEDS[i]),
    octave: octOf(L[i]?.octave),
    ...extra,
  })
  return {
    key: Number.isInteger(r.key) && r.key >= 0 && r.key < 12 ? r.key : 9,
    scale,
    progression,
    density: unit(r.density, 0.5),
    motion: unit(r.motion, 0.4),
    color: unit(r.color, 0.3),
    swing: unit(r.swing, 0),
    lanes: [
      lane(0, { rhythm: CHORD_RHYTHMS[L[0]?.rhythm] ? L[0].rhythm : 'pulse' }),
      lane(1, { rhythm: BASS_RHYTHMS[L[1]?.rhythm] ? L[1].rhythm : 'octave' }),
      lane(2, {}),
      lane(3, { mode: ARP_MODES[L[3]?.mode] ? L[3].mode : 'up', rate: ARP_RATES.includes(L[3]?.rate) ? L[3].rate : 16 }),
    ],
  }
}

/** Roll: a new progression (unless the chords are locked) and fresh dice for every unlocked lane. */
export function roll(state, rand = Math.random) {
  const chords = state.lanes[0].lock ? state.progression : newProgression(state.scale, state.progression.length, rand)
  return { ...state, progression: chords, lanes: state.lanes.map((l) => (l.lock ? l : { ...l, seed: newSeed(rand) })) }
}

/** One lane's dice; for the chords, a new progression too. */
export function rollLane(state, i, rand = Math.random) {
  const next = { ...state, lanes: state.lanes.map((l, k) => (k === i ? { ...l, seed: newSeed(rand) } : l)) }
  return i === 0 ? { ...next, progression: newProgression(state.scale, state.progression.length, rand) } : next
}

/** A different length: the progression grows or shrinks to fit, keeping what's there. */
export function setLength(state, bars) {
  const p = state.progression
  const progression = bars <= p.length ? p.slice(0, bars) : [...p, ...p, ...p, ...p].slice(0, bars)
  if (bars === 8 && p.length < 8) progression[7] = progression[7] === 5 ? 4 : 5 // a turnaround
  return { ...state, progression }
}

// ── what it plays ───────────────────────────────────────────────────────────

/** Bars of steps → mini-notation, a bar a cycle. `tok` turns a hit into its token. */
function mini(bars, tok) {
  const bar = (steps) => steps.map((st) => (st === hold ? '_' : st ? tok(st) : '~')).join(' ')
  return bars.length === 1 ? bar(bars[0]) : `<${bars.map((b) => `[${bar(b)}]`).join(' ')}>`
}
const noteTok = (st) => (st.notes.length > 1 ? `[${st.notes.join(',')}]` : String(st.notes[0]))
const velTok = (st) => st.vel.toFixed(2)
const swingOf = (state) => (state.swing > 0.001 ? `.swingBy(${(state.swing * 0.5).toFixed(3)}, 8)` : '')

/**
 * Its layers: [{ id, name, expr, drive }] (see abstract/index.js). A layer's drive puts its
 * notes on whatever it fires, not only its rhythm: an instrument triggered by the melody
 * plays the melody.
 */
export function parts(state) {
  const all = lanes(state)
  return state.lanes.map((l, i) => {
    const bars = all[i]
    const live = !l.mute && bars.some((b) => b.some((st) => st && st !== hold))
    const snd = soundToken(l.sound)
    const sw = swingOf(state)
    const notes = mini(bars, noteTok)
    const vel = mini(bars, velTok)
    const struct = mini(bars, () => 't')
    let expr = null
    if (live && snd) expr = `note("${notes}").s("${snd}").velocity("${vel}")${sw}`
    return {
      id: `h${i}`,
      name: snd || LANES[i],
      expr,
      drive: (x) => (live ? `${x}.struct("${struct}").note("${notes}").velocity("${vel}")${sw}` : null),
    }
  })
}

export function code(state) {
  const lines = parts(state).map((p) => p.expr).filter(Boolean)
  if (!lines.length) return 'silence'
  return lines.length === 1 ? lines[0] : `stack(${lines.join(', ')})`
}

/** What it plays, as steps for the timeline to sketch on its clips (where notes start). */
export function asPattern(state) {
  const all = lanes(state)
  return {
    bars: state.progression.length,
    stepsPerBar: STEPS,
    channels: state.lanes.map((l, i) => ({ id: `h${i}`, kind: 'drum', mute: l.mute, steps: all[i].flat().map((st) => (st && st !== hold ? 1 : 0)) })),
  }
}
