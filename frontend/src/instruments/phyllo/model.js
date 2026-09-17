/**
 * Phyllo's patch: what the window edits and the track saves, laid out the way Phase Plant
 * is. A patch is
 *
 *   layers      generators stacked top to bottom (analog, supersaw, wavetable, noise), up to 8,
 *               each playing into one of the three lanes
 *   amp         the envelope every voice goes out through
 *   lanes       three effect lanes, as Phase Plant has: { out, gain, mute, effects } — out is
 *               'master' or another lane's number (0 … 2), never round in a loop; effects are
 *               the app's bus effects, top to bottom: { id, type, on, data } (as an fx rack's)
 *   modulators  as many LFOs and envelopes as you add (up to 16), each with its own id
 *   routes      { id, src: a modulator's id, target, amt -1…1 }
 *
 * and a new patch is blank: no layers, no modulators.
 *
 * The processor (dsp.js) hears it two ways. Knobs (anything automation or a route can move)
 * are AudioParams, in fixed slots, so they move ringing notes and land on the sample
 * (`encode`). The rest — what each slot is, drawn shapes, where routes go — is a message
 * (`patchMessage`), sent when it changes.
 */

import { curveAt } from '../curve.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, def, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : def)
const pick = (v, options, def) => (options.includes(v) ? v : def)
export const newPartId = () => Math.random().toString(36).slice(2, 8)

// ── controls ─────────────────────────────────────────────────────────────────

/** Knob specs, shared by the window, the processor's ranges and automation. */
export const K = {
  level: { key: 'level', label: 'level', min: 0, max: 1, def: 0.8 },
  pan: { key: 'pan', label: 'pan', min: 0, max: 1, def: 0.5 },
  fine: { key: 'fine', label: 'fine', min: -100, max: 100, def: 0, unit: 'ct', origin: 0 },
  pw: { key: 'pw', label: 'width', min: 0.02, max: 0.98, def: 0.5 },
  pos: { key: 'pos', label: 'position', min: 0, max: 1, def: 0 },
  warp: { key: 'warp', label: 'warp', min: 0, max: 1, def: 0 },
  detune: { key: 'detune', label: 'detune', min: 0, max: 1, def: 0.18 },
  spread: { key: 'spread', label: 'spread', min: 0, max: 1, def: 0.6 },
  fm: { key: 'fm', label: 'fm', min: 0, max: 8, def: 0 },
  ratio: { key: 'ratio', label: 'ratio', min: 0.25, max: 8, def: 1, log: true, unit: 'x' },
  attack: { key: 'attack', label: 'attack', min: 0.001, max: 4, def: 0.005, log: true, unit: 's' },
  decay: { key: 'decay', label: 'decay', min: 0.01, max: 4, def: 0.3, log: true, unit: 's' },
  sustain: { key: 'sustain', label: 'sustain', min: 0, max: 1, def: 0.8 },
  release: { key: 'release', label: 'release', min: 0.01, max: 8, def: 0.2, log: true, unit: 's' },
  hz: { key: 'hz', label: 'rate', min: 0.05, max: 30, def: 2, log: true, unit: 'hz' },
  volume: { key: 'volume', label: 'volume', min: 0, max: 1.5, def: 0.8 },
  glide: { key: 'glide', label: 'glide', min: 0, max: 1, def: 0, unit: 's' },
  gain: { key: 'gain', label: 'level', min: 0, max: 1.5, def: 1 },
}

export const LANES = 3
export const MAX_LANE_FX = 8
export const laneName = (i) => `${i + 1}`
const makeLanes = () => Array.from({ length: LANES }, () => ({ out: 'master', gain: 1, mute: false, effects: [] }))

/**
 * The effects a lane can hold, told to us by the app (instruments/laneFx.js), which knows
 * the effect nodes: { types, spec(type), clean(type, data), defaults(type) }. Without it
 * (a test, say) effects are kept as they are.
 */
let fxCatalog = null
export function registerLaneFx(catalog) { fxCatalog = catalog }
export const laneFxCatalog = () => fxCatalog

export function makeLaneFx(type) {
  return { id: newPartId(), type, on: true, data: fxCatalog ? fxCatalog.defaults(type) : {} }
}

/**
 * Lanes whose sound is mixed across all the voices before it plays on: those with effects,
 * and whatever they feed. The rest mix inside each voice.
 */
export function lanesSummed(lanes) {
  const summed = lanes.map((l) => l.effects.length > 0)
  for (let pass = 0; pass < LANES; pass++) {
    lanes.forEach((l, i) => { if (summed[i] && l.out !== 'master') summed[l.out] = true })
  }
  return summed
}

/** Would lane `from` sending to `to` make a loop (to reaches back to from)? */
export function laneLoops(lanes, from, to) {
  let at = to
  for (let hops = 0; at !== 'master' && hops <= LANES; hops++) {
    if (at === from) return true
    at = lanes[at]?.out ?? 'master'
  }
  return false
}
/** The lanes in the order sound flows through them: every lane before the lanes it feeds. */
export function laneOrder(lanes) {
  const order = []
  const visit = (i, seen) => {
    if (order.includes(i) || seen.has(i)) return
    seen.add(i)
    // whatever feeds this lane goes first
    lanes.forEach((l, j) => { if (l.out === i) visit(j, seen) })
    order.push(i)
  }
  for (let i = 0; i < lanes.length; i++) visit(i, new Set())
  return order
}

export const LAYER_TYPES = ['analog', 'supersaw', 'wavetable', 'noise']
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square', 'pulse']
export const NOISES = ['white', 'pink', 'brown']
export const FM_WAVES = ['sine', 'triangle', 'sawtooth', 'square']
export const WARP_MODES = ['none', 'bend+', 'bend-', 'sync', 'mirror', 'pwm', 'asym', 'quantize', 'fold']
export const LFO_SHAPES = ['sine', 'tri', 'saw', 'ramp', 'square']
/**
 * Which way an LFO pushes: 'up' from zero at its bottom, 'bi' both ways around zero in its
 * middle, 'down' from zero at its top.
 */
export const LFO_POLARITIES = ['up', 'bi', 'down']
/** How an LFO runs: on its own clock, from the start of each note, or once per note. */
export const LFO_MODES = ['free', 'retrig', 'env']
export const MAX_LFO_POINTS = 24

/**
 * An LFO is a shape you draw: points { x 0…1 across one cycle, y 0…1 bottom to top, c the
 * bend of the line to the next point, -1…1, s 1 when that line is sine-shaped } (curve.js).
 * The first point sits at x 0 and the last at x 1; two points at the same x make a jump.
 * These are the shapes the buttons start you from.
 */
export const LFO_PRESETS = {
  // a true sine: a quarter out to the top, a half-cosine down to the bottom, a quarter back
  sine: [{ x: 0, y: 0.5, c: -1, s: 1 }, { x: 0.25, y: 1, s: 1 }, { x: 0.75, y: 0, c: 1, s: 1 }, { x: 1, y: 0.5 }],
  tri: [{ x: 0, y: 0.5 }, { x: 0.25, y: 1 }, { x: 0.75, y: 0 }, { x: 1, y: 0.5 }],
  saw: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
  ramp: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  square: [{ x: 0, y: 1 }, { x: 0.5, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }],
  pluck: [{ x: 0, y: 1, c: -0.6 }, { x: 1, y: 0 }],
  swell: [{ x: 0, y: 0, c: 0.6 }, { x: 1, y: 1 }],
  stairs: [{ x: 0, y: 0 }, { x: 0.25, y: 0 }, { x: 0.25, y: 0.33 }, { x: 0.5, y: 0.33 }, { x: 0.5, y: 0.67 }, { x: 0.75, y: 0.67 }, { x: 0.75, y: 1 }, { x: 1, y: 1 }],
}
const presetPoints = (name) => (LFO_PRESETS[name] ?? LFO_PRESETS.sine).map((p) => ({ ...p }))

export { curveAt as curveValue }

/** A drawn shape, cleaned: in order, inside the box, pinned to both ends. */
export function normalizePoints(raw, fallback = 'sine') {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => {
      const point = { x: Math.round(num(p.x, 0, 0, 1) * 10000) / 10000, y: Math.round(num(p.y, 0.5, 0, 1) * 10000) / 10000 }
      const c = Math.round(num(p.c, 0, -1, 1) * 100) / 100
      if (c) point.c = c
      if (p.s) point.s = 1 // a sine-shaped stretch to the next point
      return point
    })
    .sort((a, b) => a.x - b.x)
    .slice(0, MAX_LFO_POINTS)
  if (list.length < 2) return presetPoints(fallback)
  list[0].x = 0
  list[list.length - 1].x = 1
  return list
}
/** LFO lengths when synced, in bars. */
export const LFO_BARS = [8, 4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32]
export const barsLabel = (b) => (b >= 1 ? `${b} bar${b === 1 ? '' : 's'}` : `1/${Math.round(1 / b)}`)
export const MAX_LAYERS = 8
export const MAX_MODULATORS = 16
export const MAX_ROUTES = 64 // in all
export const MAX_ROUTES_EACH = 8 // from one modulator
/*
 * What a route does depends on its source: a bipolar LFO swings the knob both ways around
 * where it's set, half of amt each way; an up or down LFO, or an envelope (always up),
 * moves it one way only, all of amt. A negative amount turns any of them over.
 */
/** Each modulator's colour, by its place in the bar. */
export const MOD_COLORS = ['#6ff3ff', '#c38bff', '#ff9f43', '#ff6fae', '#7dff8a', '#6f9bff', '#ffd24a', '#ff7a6f']
export const modColor = (patch, id) => MOD_COLORS[Math.max(0, patch.modulators.findIndex((m) => m.id === id)) % MOD_COLORS.length]
/** A modulator's name: its own, or its kind and its number among that kind. */
export function modName(patch, id) {
  const m = patch.modulators.find((x) => x.id === id)
  if (!m) return 'gone'
  if (m.name) return m.name
  const n = patch.modulators.filter((x) => x.kind === m.kind).indexOf(m) + 1
  return `${m.kind === 'lfo' ? 'lfo' : 'env'} ${n}`
}
export const TABLES = {
  basic: 'sine → triangle → saw → square',
  bright: 'one harmonic → all of them',
  pulse: 'pulse width, wide → thin',
  vowel: 'a talking sweep: a e i o u',
  sync: 'hard sync, climbing',
  fold: 'a sine, folded harder',
}
export const TABLE_NAMES = Object.keys(TABLES)

/** Layer knobs a modulator can move, in the order the processor numbers them. */
export const LAYER_KNOBS = ['level', 'pan', 'fine', 'pw', 'pos', 'warp', 'detune', 'spread', 'fm', 'ratio']
/** Patch-wide destinations, numbered from 1 (0 is "nowhere"). */
export const GLOBAL_DESTS = ['pitch', 'amp.level', 'lane:0.gain', 'lane:1.gain', 'lane:2.gain']

// ── patches ──────────────────────────────────────────────────────────────────

export function makeLayer(type = 'analog', over = {}) {
  return {
    id: newPartId(), type, on: true, level: 0.8, pan: 0.5, oct: 0, semi: 0, fine: 0,
    wave: 'sawtooth', pw: 0.5, table: 'basic', pos: 0, warp: 0, warpmode: 'none',
    unison: type === 'supersaw' ? 7 : 1, detune: type === 'supersaw' ? 0.18 : 0.1, spread: 0.6,
    fm: 0, ratio: 1, fmwave: 'sine', color: 'pink', lane: 0,
    ...over,
  }
}

export function makeLfo(over = {}) {
  return { id: newPartId(), kind: 'lfo', points: presetPoints('sine'), mode: 'free', polarity: 'bi', sync: true, bars: 1 / 4, hz: 2, grid: 8, ...over }
}
export function makeEnv(over = {}) {
  return { id: newPartId(), kind: 'env', attack: 0.005, decay: 0.4, sustain: 0, release: 0.3, ...over }
}

export function initPatch() {
  return {
    v: 3,
    name: 'init',
    layers: [], // blank: you add the sounds you want
    amp: { attack: 0.005, decay: 0.3, sustain: 0.8, release: 0.2 },
    lanes: makeLanes(),
    modulators: [], // and the modulators
    routes: [],
    mono: false,
    glide: 0,
    volume: 0.8,
  }
}

const cleanId = (v) => (typeof v === 'string' && /^\w{1,12}$/.test(v) ? v : newPartId())
const cleanEnv = (e, d) => ({
  attack: num(e?.attack, d.attack, K.attack.min, K.attack.max),
  decay: num(e?.decay, d.decay, K.decay.min, K.decay.max),
  sustain: num(e?.sustain, d.sustain, 0, 1),
  release: num(e?.release, d.release, K.release.min, K.release.max),
})

function cleanModulator(m) {
  if (m?.kind === 'env') {
    const d = makeEnv()
    const out = { id: cleanId(m.id), kind: 'env', ...cleanEnv(m, d) }
    if (typeof m.name === 'string' && m.name.trim()) out.name = m.name.trim().slice(0, 24)
    return out
  }
  if (m?.kind !== 'lfo') return null
  const d = makeLfo()
  const out = {
    id: cleanId(m.id),
    kind: 'lfo',
    // older patches name a shape instead of drawing one
    points: normalizePoints(m.points ?? (LFO_SHAPES.includes(m.shape) ? presetPoints(m.shape) : null)),
    mode: pick(m.mode, LFO_MODES, 'free'),
    polarity: pick(m.polarity, LFO_POLARITIES, m.bi === false ? 'up' : 'bi'),
    grid: [0, 4, 8, 16, 32].includes(m.grid) ? m.grid : 8,
    sync: m.sync !== false,
    bars: LFO_BARS.includes(m.bars) ? m.bars : d.bars,
    hz: num(m.hz, d.hz, K.hz.min, K.hz.max),
  }
  if (typeof m.name === 'string' && m.name.trim()) out.name = m.name.trim().slice(0, 24)
  return out
}

/** Anything → a valid patch (saved tracks, presets, hand-edited JSON, older versions). */
export function normalizePatch(raw) {
  const base = initPatch()
  if (!raw || typeof raw !== 'object') return base
  const layers = (Array.isArray(raw.layers) ? raw.layers : [])
    .filter((l) => l && LAYER_TYPES.includes(l.type))
    .slice(0, MAX_LAYERS)
    .map((l) => {
      const d = makeLayer(l.type)
      const out = {
        id: cleanId(l.id),
        type: l.type,
        on: l.on !== false,
        level: num(l.level, d.level, 0, 1),
        pan: num(l.pan, d.pan, 0, 1),
        oct: Math.round(num(l.oct, 0, -3, 3)),
        semi: Math.round(num(l.semi, 0, -12, 12)),
        fine: num(l.fine, 0, -100, 100),
        wave: pick(l.wave, WAVES, d.wave),
        pw: num(l.pw, d.pw, K.pw.min, K.pw.max),
        table: pick(l.table, TABLE_NAMES, d.table),
        pos: num(l.pos, 0, 0, 1),
        warp: num(l.warp, 0, 0, 1),
        warpmode: pick(l.warpmode, WARP_MODES, 'none'),
        unison: Math.round(num(l.unison, d.unison, 1, 16)),
        detune: num(l.detune, d.detune, 0, 1),
        spread: num(l.spread, d.spread, 0, 1),
        fm: num(l.fm, 0, K.fm.min, K.fm.max),
        ratio: num(l.ratio, 1, K.ratio.min, K.ratio.max),
        fmwave: pick(l.fmwave, FM_WAVES, 'sine'),
        color: pick(l.color, NOISES, 'pink'),
        lane: [0, 1, 2].includes(l.lane) ? l.lane : 0,
      }
      if (l.collapsed) out.collapsed = true
      return out
    })

  // modulators: a version 2 patch had one mod envelope and two lfos, under fixed names;
  // they become modulators with those names as ids, so their routes and automation hold
  let rawMods = raw.modulators
  if (!Array.isArray(rawMods) && (raw.env || raw.lfos)) {
    rawMods = [
      { ...(raw.env ?? {}), id: 'env', kind: 'env' },
      ...[0, 1].map((i) => ({ sync: true, bars: i ? 1 : 1 / 4, hz: i ? 0.5 : 2, ...(raw.lfos?.[i] ?? {}), shape: raw.lfos?.[i]?.shape ?? (i ? 'tri' : 'sine'), id: `lfo${i + 1}`, kind: 'lfo' })),
    ]
  }
  const modulators = []
  const ids = new Set(layers.map((l) => l.id))
  for (const m of Array.isArray(rawMods) ? rawMods : []) {
    const clean = cleanModulator(m)
    if (!clean || modulators.length >= MAX_MODULATORS) continue
    while (ids.has(clean.id)) clean.id = newPartId()
    ids.add(clean.id)
    modulators.push(clean)
  }

  const patch = {
    v: 3,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 40) : base.name,
    layers,
    amp: cleanEnv(raw.amp, base.amp),
    lanes: makeLanes(),
    modulators,
    routes: [],
    mono: raw.mono === true,
    glide: num(raw.glide, 0, K.glide.min, K.glide.max),
    volume: num(raw.volume, K.volume.def, K.volume.min, K.volume.max),
  }
  // lanes: each out to master or another lane, and a loop falls back to master
  for (let i = 0; i < LANES; i++) {
    const l = Array.isArray(raw.lanes) ? raw.lanes[i] : null
    const lane = patch.lanes[i]
    lane.gain = num(l?.gain, 1, K.gain.min, K.gain.max)
    lane.mute = l?.mute === true
    for (const fx of Array.isArray(l?.effects) ? l.effects : []) {
      if (!fx || typeof fx.type !== 'string' || lane.effects.length >= MAX_LANE_FX) continue
      if (fxCatalog && !fxCatalog.types.includes(fx.type)) continue
      let id = cleanId(fx.id)
      while (ids.has(id)) id = newPartId()
      ids.add(id)
      const clean = { id, type: fx.type, on: fx.on !== false, data: fxCatalog ? fxCatalog.clean(fx.type, fx.data) : { ...(fx.data ?? {}) } }
      if (fx.collapsed) clean.collapsed = true
      lane.effects.push(clean)
    }
    if ([0, 1, 2].includes(l?.out) && l.out !== i && !laneLoops(patch.lanes, i, l.out)) lane.out = l.out
  }
  const seen = new Set()
  for (const r of Array.isArray(raw.routes) ? raw.routes : Array.isArray(raw.mods) ? raw.mods : []) {
    if (!r || !modulators.some((m) => m.id === r.src) || !targetSpec(patch, r.target)) continue
    const key = `${r.src}>${r.target}`
    if (seen.has(key) || patch.routes.length >= MAX_ROUTES || patch.routes.filter((x) => x.src === r.src).length >= MAX_ROUTES_EACH) continue
    seen.add(key)
    patch.routes.push({ id: cleanId(r.id), src: r.src, target: r.target, amt: num(r.amt, 0.5, -1, 1) })
  }
  return patch
}

// ── modulation targets ───────────────────────────────────────────────────────

/** A generator's letter, by its place in the stack. */
export const layerLetter = (i) => String.fromCharCode(65 + i)

/**
 * Targets are strings: "pitch", "amp.level", "lane:<n>.gain", "layer:<id>.<knob>", or
 * "fx:<effect id>.<knob>" (a lane effect's knob). The knob spec and a name, or null.
 */
export function targetSpec(patch, target) {
  if (typeof target !== 'string') return null
  if (target === 'pitch') return { label: 'pitch', spec: { min: -24, max: 24 } }
  if (target === 'amp.level') return { label: 'volume', spec: { min: 0, max: 1 } }
  const n = /^lane:([012])\.gain$/.exec(target)
  if (n) return { label: `lane ${laneName(Number(n[1]))} level`, spec: K.gain, get: (p) => p.lanes[n[1]].gain }
  const f = /^fx:(\w+)\.(\w+)$/.exec(target)
  if (f) {
    for (const [li, lane] of patch.lanes.entries()) {
      const fx = lane.effects.find((e) => e.id === f[1])
      if (!fx) continue
      const spec = fxCatalog?.spec(fx.type)
      const def = spec?.params.find((p) => p.key === f[2] && p.type === 'knob')
      if (!def) return null
      return { label: `${laneName(li)} ${spec.label} ${def.label}`, spec: def, fxId: fx.id, knob: def.key, lane: li, get: (p) => p.lanes[li].effects.find((e) => e.id === f[1])?.data[f[2]] ?? def.def }
    }
    return null
  }
  const l = /^layer:(\w+)\.(\w+)$/.exec(target)
  if (l && LAYER_KNOBS.includes(l[2])) {
    const index = patch.layers.findIndex((x) => x.id === l[1])
    if (index < 0) return null
    return { label: `${layerLetter(index)} ${K[l[2]].label}`, spec: K[l[2]], layerId: l[1], knob: l[2], index, get: (p) => p.layers.find((x) => x.id === l[1])?.[l[2]] }
  }
  return null
}

/**
 * Destinations outside the voices: lane effects' knobs, and the levels of lanes mixed
 * across voices. The processor moves these from the newest note's modulators (free LFOs
 * from their own clock) and reports them; the rig (rig.js) turns the knobs. Their order
 * here is the order of the numbers in those reports.
 */
export function globalTargets(patch) {
  const summed = lanesSummed(patch.lanes)
  const list = []
  for (const r of patch.routes) {
    const shared = r.target.startsWith('fx:') || (/^lane:(\d)\.gain$/.test(r.target) && summed[Number(r.target[5])])
    if (shared && !list.includes(r.target)) list.push(r.target)
  }
  return list
}

/** Where a route goes, as the processor numbers it: 1 pitch, 2 volume, 3 … 5 lane levels, 10 + layer × 10 + knob. */
function destIndex(patch, target) {
  const g = GLOBAL_DESTS.indexOf(target)
  if (g >= 0) return g + 1
  const t = targetSpec(patch, target)
  if (!t?.layerId) return 0
  return 10 + t.index * 10 + LAYER_KNOBS.indexOf(t.knob)
}

// ── the processor's view ─────────────────────────────────────────────────────

const ENV_STAGES = ['attack', 'decay', 'sustain', 'release']
const envParams = (prefix) => ENV_STAGES.map((k) => ({ key: `${prefix}_${k}`, min: K[k].min, max: K[k].max, def: K[k].def }))

/** The knobs the processor reads, in fixed slots: one AudioParam each. */
export const AUDIO_PARAMS = [
  ...Array.from({ length: MAX_LAYERS }, (_, i) => LAYER_KNOBS.map((k) => ({ key: `l${i}_${k}`, min: K[k].min, max: K[k].max, def: K[k].def }))).flat(),
  ...Array.from({ length: MAX_MODULATORS }, (_, j) => [{ key: `d${j}_hz`, min: K.hz.min, max: K.hz.max, def: K.hz.def }, ...envParams(`d${j}`)]).flat(),
  ...envParams('a'),
  ...Array.from({ length: LANES }, (_, i) => ({ key: `n${i}_gain`, min: K.gain.min, max: K.gain.max, def: 1 })),
  { key: 'glide', min: 0, max: 1, def: 0 },
  { key: 'volume', min: 0, max: 1.5, def: 0.8 },
  { key: 'cps', min: 0.01, max: 10, def: 0.5 },
]

/**
 * What the processor gets as a message: what each slot is, and where routes go.
 *   layers      [on, type, wave, table, noise, warp mode, fm wave, semitones, unison, lane]
 *   lanes       [out (-1 master, or a lane), muted, summed (mixed across voices, then played
 *               through its effects outside)], and `laneOrder`, the order to mix them in
 *   modulators  { lfo: 1, mode, polarity, sync, bars, points: [[x, y, c, s]] } or { lfo: 0 }
 *   routes      [modulator slot, destination, amount]
 *   shared      [modulator slot, place in globalTargets, amount]
 */
export function patchMessage(patch) {
  return {
    layers: patch.layers.map((l) => [
      l.on ? 1 : 0, LAYER_TYPES.indexOf(l.type), WAVES.indexOf(l.wave), TABLE_NAMES.indexOf(l.table), NOISES.indexOf(l.color),
      WARP_MODES.indexOf(l.warpmode), FM_WAVES.indexOf(l.fmwave), l.oct * 12 + l.semi,
      l.type === 'analog' || l.type === 'noise' ? 1 : l.unison, // analog layers are one voice; the others stack
      l.lane,
    ]),
    lanes: (() => { const summed = lanesSummed(patch.lanes); return patch.lanes.map((n, i) => [n.out === 'master' ? -1 : n.out, n.mute ? 1 : 0, summed[i] ? 1 : 0]) })(),
    laneOrder: laneOrder(patch.lanes),
    modulators: patch.modulators.map((m) => (m.kind === 'lfo'
      ? { lfo: 1, mode: LFO_MODES.indexOf(m.mode), polarity: LFO_POLARITIES.indexOf(m.polarity), sync: m.sync ? 1 : 0, bars: m.bars, points: m.points.map((p) => [p.x, p.y, p.c ?? 0, p.s ?? 0]) }
      : { lfo: 0 })),
    routes: patch.routes
      .map((r) => [patch.modulators.findIndex((m) => m.id === r.src), destIndex(patch, r.target), r.amt])
      .filter(([src, dest]) => src >= 0 && dest > 0),
    // routes to destinations outside the voices: [modulator slot, place in globalTargets, amount]
    shared: (() => {
      const targets = globalTargets(patch)
      return patch.routes
        .map((r) => [patch.modulators.findIndex((m) => m.id === r.src), targets.indexOf(r.target), r.amt])
        .filter(([src, at]) => src >= 0 && at >= 0)
    })(),
    mono: patch.mono ? 1 : 0,
  }
}

/** The patch's knobs as the processor's numbers. `cps`: the track's tempo, for synced LFOs. */
export function encodePatch(patch, { cps = 0.5 } = {}) {
  const out = {}
  patch.layers.forEach((l, i) => { for (const k of LAYER_KNOBS) out[`l${i}_${k}`] = l[k] })
  patch.modulators.forEach((m, j) => {
    if (m.kind === 'lfo') out[`d${j}_hz`] = m.hz
    else for (const k of ENV_STAGES) out[`d${j}_${k}`] = m[k]
  })
  for (const k of ENV_STAGES) out[`a_${k}`] = patch.amp[k]
  patch.lanes.forEach((n, i) => { out[`n${i}_gain`] = n.gain })
  out.glide = patch.glide
  out.volume = patch.volume
  out.cps = clamp(cps, 0.01, 10)
  return out
}

// ── knobs by name (automation) ───────────────────────────────────────────────

/**
 * Automation names a knob by a key made of word characters: "volume", "glide",
 * "amp_attack", "lane1_gain" (lanes count from 1), "M<modulator id>_hz" or "_attack" (and so
 * on), "L<layer id>_<knob>".
 * Version 2's "env_decay" and "lfo1_hz" still work: those modulators kept their names.
 */
export function knobAt(patch, key) {
  let k = String(key)
  const legacy = /^(env)_(attack|decay|sustain|release)$|^(lfo[12])_hz$/.exec(k)
  if (legacy) k = legacy[1] ? `Menv_${legacy[2]}` : `M${legacy[3]}_hz`
  const fx = /^F(\w+?)_(\w+)$/.exec(k)
  if (fx) {
    for (const [li, l] of patch.lanes.entries()) {
      const unit = l.effects.find((e) => e.id === fx[1])
      if (!unit) continue
      const def = fxCatalog?.spec(unit.type)?.params.find((p) => p.key === fx[2] && p.type === 'knob')
      if (!def) return null
      return {
        def,
        value: unit.data[def.key] ?? def.def,
        label: `lane ${laneName(li)} ${fxCatalog.spec(unit.type).label} ${def.label}`,
        set: (p, v) => { for (const x of p.lanes) { const e = x.effects.find((y) => y.id === fx[1]); if (e) e.data[def.key] = v } },
      }
    }
    return null
  }
  const lane = /^lane([123])_gain$/.exec(k)
  if (lane) {
    const i = Number(lane[1]) - 1
    return { def: K.gain, value: patch.lanes[i].gain, label: `lane ${lane[1]} level`, set: (p, v) => { p.lanes[i].gain = v } }
  }
  const m = /^(?:(volume|glide)|amp_(attack|decay|sustain|release)|M(\w+?)_(hz|attack|decay|sustain|release)|L(\w+?)_(level|pan|fine|pw|pos|warp|detune|spread|fm|ratio))$/.exec(k)
  if (!m) return null
  if (m[1]) return { def: K[m[1]], value: patch[m[1]], label: m[1], set: (p, v) => { p[m[1]] = v } }
  if (m[2]) return { def: K[m[2]], value: patch.amp[m[2]], label: `amp ${m[2]}`, set: (p, v) => { p.amp[m[2]] = v } }
  if (m[3]) {
    const mod = patch.modulators.find((x) => x.id === m[3])
    if (!mod || (mod.kind === 'lfo') !== (m[4] === 'hz')) return null
    return {
      def: K[m[4]],
      value: mod[m[4]],
      label: `${modName(patch, mod.id)} ${m[4] === 'hz' ? 'rate' : m[4]}`,
      set: (p, v) => { const x = p.modulators.find((y) => y.id === m[3]); if (x) x[m[4]] = v },
    }
  }
  const index = patch.layers.findIndex((l) => l.id === m[5])
  if (index < 0) return null
  return {
    def: K[m[6]],
    value: patch.layers[index][m[6]],
    label: `${layerLetter(index)} ${K[m[6]].label}`,
    set: (p, v) => { const l = p.layers.find((x) => x.id === m[5]); if (l) l[m[6]] = v },
  }
}
export const layerKnobKey = (layerId, knob) => `L${layerId}_${knob}`
export const modKnobKey = (modId, knob) => `M${modId}_${knob}`
export const fxKnobKey = (fxId, key) => `F${fxId}_${key}`

// ── presets ──────────────────────────────────────────────────────────────────

/**
 * A preset: `build(p, route)` sets it up; `route(modulator, layer index or null, knob or
 * target, amount)` adds a route once the layers exist.
 */
const preset = (name, build) => {
  const p = initPatch()
  p.name = name
  const pending = []
  build(p, (mod, layer, knob, amt) => pending.push([mod, layer, knob, amt]))
  for (const [mod, layer, knob, amt] of pending) {
    p.routes.push({ id: newPartId(), src: mod.id, target: layer == null ? knob : `layer:${p.layers[layer].id}.${knob}`, amt })
  }
  return normalizePatch(p)
}

export const PRESETS = [
  preset('init', () => {}),
  preset('sub bass', (p) => {
    p.layers = [makeLayer('analog', { wave: 'sine', oct: -1 }), makeLayer('analog', { wave: 'triangle', level: 0.35 })]
    p.amp = { attack: 0.003, decay: 0.2, sustain: 0.9, release: 0.08 }
    p.mono = true
    p.glide = 0.04
  }),
  preset('reese', (p, route) => {
    p.layers = [makeLayer('supersaw', { unison: 7, detune: 0.32, spread: 0.3, level: 0.7 }), makeLayer('analog', { wave: 'sine', oct: -1, level: 0.6 })]
    p.amp = { attack: 0.01, decay: 0.3, sustain: 1, release: 0.15 }
    const lfo = makeLfo({ bars: 1 / 2 })
    p.modulators = [lfo]
    route(lfo, 0, 'detune', 0.3)
  }),
  preset('pluck', (p, route) => {
    p.layers = [makeLayer('analog', { wave: 'sawtooth' }), makeLayer('analog', { wave: 'square', oct: 1, level: 0.3 })]
    p.amp = { attack: 0.002, decay: 0.35, sustain: 0, release: 0.2 }
    const env = makeEnv({ attack: 0.001, decay: 0.25, sustain: 0, release: 0.2 })
    p.modulators = [env]
    route(env, 1, 'level', 0.6)
  }),
  preset('hoover lead', (p, route) => {
    p.layers = [makeLayer('supersaw', { unison: 9, detune: 0.45, spread: 0.8 }), makeLayer('analog', { wave: 'pulse', pw: 0.25, oct: -1, level: 0.5 })]
    const env = makeEnv({ attack: 0.08, decay: 0.3, sustain: 0, release: 0.1 })
    const vib = makeLfo({ sync: false, hz: 5.5 })
    p.modulators = [env, vib]
    route(env, null, 'pitch', -0.1)
    route(vib, null, 'pitch', 0.02)
    p.mono = true
    p.glide = 0.12
  }),
  preset('glass pad', (p, route) => {
    p.layers = [makeLayer('wavetable', { table: 'bright', pos: 0.3, unison: 4, detune: 0.12 }), makeLayer('wavetable', { table: 'vowel', pos: 0.2, oct: 1, level: 0.4 })]
    p.amp = { attack: 0.6, decay: 1, sustain: 0.8, release: 1.8 }
    const sweep = makeLfo({ points: presetPoints('tri'), bars: 4 })
    const drift = makeLfo({ bars: 2 })
    p.modulators = [sweep, drift]
    route(sweep, 0, 'pos', 0.5)
    route(drift, 1, 'pan', 0.6)
    p.volume = 0.6
  }),
  preset('fm bell', (p, route) => {
    p.layers = [makeLayer('analog', { wave: 'sine', fm: 3, ratio: 3.5 })]
    p.amp = { attack: 0.002, decay: 1.4, sustain: 0, release: 1.2 }
    const env = makeEnv({ attack: 0.001, decay: 0.9, sustain: 0, release: 0.6 })
    p.modulators = [env]
    route(env, 0, 'fm', 1)
  }),
  preset('talking wobble', (p, route) => {
    p.layers = [makeLayer('wavetable', { table: 'vowel', pos: 0.5 }), makeLayer('analog', { wave: 'sine', oct: -1, level: 0.5 })]
    const wob = makeLfo({ bars: 1 / 8 })
    p.modulators = [wob]
    route(wob, 0, 'pos', 0.9)
  }),
]
