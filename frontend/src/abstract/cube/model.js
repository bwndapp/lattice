/**
 * The cube: a 4×4×4 twisty puzzle that is a drum machine. The stickers around each of its
 * four horizontal layers are a ring of 4 faces × 4 = 16, which is one bar of sixteenth
 * steps; each layer is one drum. A sticker is a rest, a hit or an accent.
 *
 *   twist a layer sideways   that drum's bar turns: its hits shift by a beat
 *   twist a layer up / down  hits trade places between drums, and some go up onto the
 *                            top and bottom caps, which aren't played — and others come down
 *   scramble                 a run of random twists: the same hits, somewhere else
 *   solve                    every twist undone: back to what you painted
 *
 * The cube is saved as what you painted on the solved cube plus the twists since, so it can
 * always be solved. Pure functions, no UI: the panel draws this, the patch plays it.
 */

export const N = 4
export const STEPS = 16
export const ROWS = 4

// the six faces, as the axis they face along and which way
const FACES = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]

/** Every sticker on the solved cube: { pos: [x, y, z] (0…3), n: [nx, ny, nz] }. Its index is its id. */
export const STICKERS = []
for (const [axis, sign] of FACES) {
  const [i, j] = [0, 1, 2].filter((a) => a !== axis)
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      const pos = [0, 0, 0]
      pos[axis] = sign > 0 ? N - 1 : 0
      pos[i] = u
      pos[j] = v
      const n = [0, 0, 0]
      n[axis] = sign
      STICKERS.push({ pos, n })
    }
  }
}
const keyOf = (pos, n) => `${pos.join(',')}|${n.join(',')}`
const SLOT = new Map(STICKERS.map((s, i) => [keyOf(s.pos, s.n), i]))
export const slotAt = (pos, n) => SLOT.get(keyOf(pos, n)) ?? -1

/** The other two axes, in the order a quarter turn about `axis` carries one into the next. */
const PLANE = [[1, 2], [2, 0], [0, 1]]

/**
 * A quarter turn of one layer: `axis` 0/1/2 (x/y/z), `layer` 0…3 along it, `dir` +1 turns
 * counter-clockwise looking down the axis from its positive end.
 */
export function turnPoint(pos, n, axis, dir) {
  const [i, j] = PLANE[axis]
  const p = [...pos]
  const m = [...n]
  if (dir > 0) {
    p[i] = N - 1 - pos[j]; p[j] = pos[i]
    m[i] = -n[j]; m[j] = n[i]
  } else {
    p[i] = pos[j]; p[j] = N - 1 - pos[i]
    m[i] = n[j]; m[j] = -n[i]
  }
  return { pos: p, n: m }
}

/** Moves by name: `y2+` is the third layer up, turned counter-clockwise from above. */
export const MOVES = {}
for (let axis = 0; axis < 3; axis++) {
  for (let layer = 0; layer < N; layer++) {
    for (const dir of [1, -1]) {
      const name = `${'xyz'[axis]}${layer}${dir > 0 ? '+' : '-'}`
      // slot → the slot its sticker lands in
      const table = STICKERS.map((s, slot) => {
        if (s.pos[axis] !== layer) return slot
        const t = turnPoint(s.pos, s.n, axis, dir)
        return slotAt(t.pos, t.n)
      })
      MOVES[name] = { name, axis, layer, dir, table }
    }
  }
}
export const MOVE_RE = /^[xyz][0-3][+-]$/
export const inverse = (name) => `${name.slice(0, 2)}${name[2] === '+' ? '-' : '+'}`

/** Where each sticker (by id) sits after `moves`. */
export function locate(moves) {
  const loc = STICKERS.map((_, i) => i)
  for (const name of moves) {
    const t = MOVES[name]?.table
    if (t) for (let id = 0; id < loc.length; id++) loc[id] = t[loc[id]]
  }
  return loc
}

/** What each slot shows now: the painted value of whichever sticker is there. */
export function faces(state) {
  const loc = locate(state.moves)
  const out = new Array(STICKERS.length).fill(0)
  for (let id = 0; id < loc.length; id++) out[loc[id]] = state.painted[id]
  return out
}

/** The slots that make up one layer's ring, step by step: front, right, back, left, as you walk round. */
export function ringSlots(row) {
  const y = N - 1 - row
  const out = []
  for (let x = 0; x < N; x++) out.push(slotAt([x, y, N - 1], [0, 0, 1]))
  for (let z = N - 1; z >= 0; z--) out.push(slotAt([N - 1, y, z], [1, 0, 0]))
  for (let x = N - 1; x >= 0; x--) out.push(slotAt([x, y, 0], [0, 0, -1]))
  for (let z = 0; z < N; z++) out.push(slotAt([0, y, z], [-1, 0, 0]))
  return out
}
export const RINGS = Array.from({ length: ROWS }, (_, r) => ringSlots(r))
/** slot → [row, step] for the slots that are played. */
export const STEP_OF = new Map(RINGS.flatMap((ring, r) => ring.map((slot, s) => [slot, [r, s]])))

/** The four bars the cube plays now: rows × 16 values (0 rest, 1 hit, 2 accent). */
export function rings(state) {
  const f = faces(state)
  return RINGS.map((ring) => ring.map((slot) => f[slot]))
}

// ── settings ────────────────────────────────────────────────────────────────

export const MAX_MOVES = 240
const DEFAULT_ROWS = [
  { sound: 'bd', mute: false },
  { sound: 'sd', mute: false },
  { sound: 'hh', mute: false },
  { sound: 'rim', mute: false },
]

/** A groove to start from, with a few spare hits on the caps for twists to bring down. */
function defaultPainted() {
  const p = new Array(STICKERS.length).fill(0)
  const paint = (row, steps, v = 1) => { for (const s of steps) p[RINGS[row][s]] = v }
  paint(0, [0, 4, 8, 12]); p[RINGS[0][0]] = 2
  paint(1, [4, 12], 2)
  paint(2, [0, 2, 4, 6, 8, 10, 12, 14]); paint(2, [2, 10], 2)
  paint(3, [3, 7, 11])
  STICKERS.forEach((s, i) => {
    if (s.n[1] !== 0 && (s.pos[0] === s.pos[2] || s.pos[0] + s.pos[2] === N - 1)) p[i] = 1
  })
  return p
}

const soundToken = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '').slice(0, 40) || 'bd'

/** Anything → complete cube settings. */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const painted = typeof r.painted === 'string' && r.painted.length === STICKERS.length && /^[012]+$/.test(r.painted)
    ? [...r.painted].map(Number)
    : Array.isArray(r.painted) && r.painted.length === STICKERS.length
      ? r.painted.map((v) => (v === 1 || v === 2 ? v : 0))
      : defaultPainted()
  const movesIn = typeof r.moves === 'string' ? r.moves.match(/[xyz][0-3][+-]/g) ?? [] : Array.isArray(r.moves) ? r.moves : []
  const moves = movesIn.filter((m) => MOVE_RE.test(m)).slice(-MAX_MOVES)
  const rows = DEFAULT_ROWS.map((d, i) => ({
    sound: soundToken(r.rows?.[i]?.sound ?? d.sound),
    mute: r.rows?.[i]?.mute === true,
  }))
  const bank = typeof r.bank === 'string' ? r.bank.replace(/\W/g, '').slice(0, 40) : 'RolandTR909'
  return { painted, moves, rows, bank }
}

/** Settings → how they're saved: compact, so a track's header stays small. */
export function pack(state) {
  return { painted: state.painted.join(''), moves: state.moves.join(''), rows: state.rows, bank: state.bank }
}

/** One more twist. Past the limit the oldest are folded into the paint (that far back can't be solved). */
export function twist(state, name) {
  if (!MOVES[name]) return state
  const moves = [...state.moves, name]
  if (moves.length <= MAX_MOVES) return { ...state, moves }
  const keep = moves.slice(-MAX_MOVES)
  const baked = faces({ ...state, moves: moves.slice(0, moves.length - MAX_MOVES) })
  return { ...state, painted: baked, moves: keep }
}

/** Random twists, never undoing the one before. `rand` is there for tests. */
export function scrambleMoves(count = 24, rand = Math.random) {
  const names = Object.keys(MOVES)
  const out = []
  while (out.length < count) {
    const m = names[Math.floor(rand() * names.length)]
    if (out.length && m === inverse(out[out.length - 1])) continue
    out.push(m)
  }
  return out
}

/** Paint the sticker showing at `slot` now: rest → hit → accent → rest. */
export function paint(state, slot) {
  const loc = locate(state.moves)
  const id = loc.indexOf(slot)
  if (id < 0) return state
  const painted = [...state.painted]
  painted[id] = (painted[id] + 1) % 3
  return { ...state, painted }
}

export const isSolved = (state) => !state.moves.length

// ── what it plays ───────────────────────────────────────────────────────────

const GAIN = ['0', '0.7', '1']

/** The cube as Strudel: a stack of one sixteen-step bar per layer. */
export function code(state) {
  const bars = rings(state)
  const lines = []
  bars.forEach((vals, r) => {
    const row = state.rows[r]
    if (row.mute || !vals.some(Boolean)) return
    const snd = soundToken(row.sound)
    const steps = vals.map((v) => (v ? snd : '~')).join(' ')
    let line = `s("${steps}")`
    if (state.bank) line += `.bank("${state.bank}")`
    line += `.gain("${vals.map((v) => GAIN[v]).join(' ')}")`
    lines.push(line)
  })
  if (!lines.length) return 'silence'
  return lines.length === 1 ? lines[0] : `stack(${lines.join(', ')})`
}

/** The cube as a one-bar drum pattern, for the timeline to draw on its clips. */
export function asPattern(state) {
  const bars = rings(state)
  return {
    bars: 1,
    stepsPerBar: STEPS,
    channels: bars.map((vals, r) => ({ id: `r${r}`, kind: 'drum', mute: state.rows[r].mute, steps: vals.map((v) => (v ? 1 : 0)) })),
  }
}
