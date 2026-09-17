/**
 * Phyllo's patch: what the window edits and the track saves. A patch is up to four stacked
 * layers (none at all is fine: a new patch starts blank, as Phase Plant's does) (analog, supersaw, wavetable, noise), one filter, an amp envelope, a mod envelope,
 * two LFOs and the routes from those modulators to knobs.
 *
 * The processor (dsp.js) hears a patch as a flat list of numbers (`encode`), one
 * AudioParam each, so a knob moves the notes already ringing and automation lands on the
 * sample.
 */

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
  cutoff: { key: 'cutoff', label: 'cutoff', min: 30, max: 20000, def: 2400, log: true, unit: 'hz' },
  reso: { key: 'reso', label: 'reso', min: 0, max: 1, def: 0.2 },
  drive: { key: 'drive', label: 'drive', min: 0, max: 1, def: 0 },
  attack: { key: 'attack', label: 'attack', min: 0.001, max: 4, def: 0.005, log: true, unit: 's' },
  decay: { key: 'decay', label: 'decay', min: 0.01, max: 4, def: 0.3, log: true, unit: 's' },
  sustain: { key: 'sustain', label: 'sustain', min: 0, max: 1, def: 0.8 },
  release: { key: 'release', label: 'release', min: 0.01, max: 8, def: 0.2, log: true, unit: 's' },
  hz: { key: 'hz', label: 'rate', min: 0.05, max: 30, def: 2, log: true, unit: 'hz' },
  volume: { key: 'volume', label: 'volume', min: 0, max: 1.5, def: 0.8 },
  glide: { key: 'glide', label: 'glide', min: 0, max: 1, def: 0, unit: 's' },
}

export const LAYER_TYPES = ['analog', 'supersaw', 'wavetable', 'noise']
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square', 'pulse']
export const NOISES = ['white', 'pink', 'brown']
export const FM_WAVES = ['sine', 'triangle', 'sawtooth', 'square']
export const WARP_MODES = ['none', 'bend+', 'bend-', 'sync', 'mirror', 'pwm', 'asym', 'quantize', 'fold']
export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass']
export const FILTER_SLOPES = ['12db', '24db', 'ladder']
export const LFO_SHAPES = ['sine', 'tri', 'saw', 'ramp', 'square']
/** How an LFO runs: on its own clock, from the start of each note, or once per note. */
export const LFO_MODES = ['free', 'retrig', 'env']
export const MAX_LFO_POINTS = 24

/**
 * An LFO is a shape you draw: points { x 0…1 across one cycle, y 0…1 bottom to top, c the
 * bend of the line to the next point, -1…1 } — the same curve as automation (automation.js).
 * The first point sits at x 0 and the last at x 1; two points at the same x make a jump.
 * These are the shapes the buttons start you from.
 */
export const LFO_PRESETS = {
  sine: [{ x: 0, y: 0.5, c: -0.25 }, { x: 0.25, y: 1, c: 0.33 }, { x: 0.5, y: 0.5, c: -0.25 }, { x: 0.75, y: 0, c: 0.33 }, { x: 1, y: 0.5 }],
  tri: [{ x: 0, y: 0.5 }, { x: 0.25, y: 1 }, { x: 0.75, y: 0 }, { x: 1, y: 0.5 }],
  saw: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
  ramp: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  square: [{ x: 0, y: 1 }, { x: 0.5, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }],
  pluck: [{ x: 0, y: 1, c: -0.6 }, { x: 1, y: 0 }],
  swell: [{ x: 0, y: 0, c: 0.6 }, { x: 1, y: 1 }],
  stairs: [{ x: 0, y: 0 }, { x: 0.25, y: 0 }, { x: 0.25, y: 0.33 }, { x: 0.5, y: 0.33 }, { x: 0.5, y: 0.67 }, { x: 0.75, y: 0.67 }, { x: 0.75, y: 1 }, { x: 1, y: 1 }],
}
const presetPoints = (name) => (LFO_PRESETS[name] ?? LFO_PRESETS.sine).map((p) => ({ ...p }))

/** Where a drawn shape is at x (0 … 1): 0 … 1. */
export function curveValue(points, x) {
  if (!points.length) return 0.5
  if (x <= points[0].x) return points[0].y
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (x < b.x) {
      const u = b.x > a.x ? (x - a.x) / (b.x - a.x) : 1
      return a.y + (b.y - a.y) * (a.c ? u ** (2 ** (a.c * 3)) : u)
    }
  }
  return points[points.length - 1].y
}

/** A drawn shape, cleaned: in order, inside the box, pinned to both ends. */
export function normalizePoints(raw, fallback = 'sine') {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => {
      const point = { x: Math.round(num(p.x, 0, 0, 1) * 10000) / 10000, y: Math.round(num(p.y, 0.5, 0, 1) * 10000) / 10000 }
      const c = Math.round(num(p.c, 0, -1, 1) * 100) / 100
      if (c) point.c = c
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
export const MAX_LAYERS = 4
export const MAX_ROUTES = 4 // per modulator
export const SOURCES = ['env', 'lfo1', 'lfo2']
export const SOURCE_LABELS = { env: 'mod env', lfo1: 'lfo 1', lfo2: 'lfo 2' }
/*
 * A route is { id, src, target, amt -1…1, bi }. Bipolar (bi) swings the knob both ways
 * around where it's set, half of amt each way; unipolar moves it one way only, all of
 * amt: up for a positive amount, down for a negative one. LFOs start bipolar, the
 * envelope unipolar.
 */
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
export const LAYER_KNOBS = ['level', 'pan', 'fine', 'pw', 'pos', 'warp', 'detune', 'spread', 'fm']
/** Patch-wide destinations, numbered from 1 (0 is "nowhere"). */
export const GLOBAL_DESTS = ['filter.cutoff', 'filter.reso', 'filter.drive', 'pitch', 'amp.level']

// ── patches ──────────────────────────────────────────────────────────────────

export function makeLayer(type = 'analog', over = {}) {
  return {
    id: newPartId(), type, on: true, level: 0.8, pan: 0.5, oct: 0, semi: 0, fine: 0,
    wave: 'sawtooth', pw: 0.5, table: 'basic', pos: 0, warp: 0, warpmode: 'none',
    unison: type === 'supersaw' ? 7 : 1, detune: type === 'supersaw' ? 0.18 : 0.1, spread: 0.6,
    fm: 0, ratio: 1, fmwave: 'sine', color: 'pink',
    ...over,
  }
}

export function initPatch() {
  return {
    v: 2,
    name: 'init',
    layers: [], // blank: you add the sounds you want
    filter: { on: false, type: 'lowpass', slope: '24db', cutoff: 2400, reso: 0.2, drive: 0 },
    amp: { attack: 0.005, decay: 0.3, sustain: 0.8, release: 0.2 },
    env: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.3 },
    lfos: [
      { points: presetPoints('sine'), mode: 'free', sync: true, bars: 1 / 4, hz: 2, grid: 8 },
      { points: presetPoints('tri'), mode: 'free', sync: true, bars: 1, hz: 0.5, grid: 8 },
    ],
    mods: [],
    mono: false,
    glide: 0,
    volume: 0.8,
  }
}

/** Anything → a valid patch (saved tracks, presets, hand-edited JSON). */
export function normalizePatch(raw) {
  const base = initPatch()
  if (!raw || typeof raw !== 'object') return base
  const layers = (Array.isArray(raw.layers) ? raw.layers : [])
    .filter((l) => l && LAYER_TYPES.includes(l.type))
    .slice(0, MAX_LAYERS)
    .map((l) => {
      const d = makeLayer(l.type)
      return {
        id: typeof l.id === 'string' && /^\w{1,12}$/.test(l.id) ? l.id : d.id,
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
      }
    })
  const seen = new Set()
  for (const l of layers) { while (seen.has(l.id)) l.id = newPartId(); seen.add(l.id) }
  const f = raw.filter ?? {}
  const env = (e, d) => ({
    attack: num(e?.attack, d.attack, K.attack.min, K.attack.max),
    decay: num(e?.decay, d.decay, K.decay.min, K.decay.max),
    sustain: num(e?.sustain, d.sustain, 0, 1),
    release: num(e?.release, d.release, K.release.min, K.release.max),
  })
  const patch = {
    v: 2,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 40) : base.name,
    layers,
    filter: {
      on: f.on === true,
      type: pick(f.type, FILTER_TYPES, 'lowpass'),
      slope: pick(f.slope, FILTER_SLOPES, '24db'),
      cutoff: num(f.cutoff, K.cutoff.def, K.cutoff.min, K.cutoff.max),
      reso: num(f.reso, K.reso.def, K.reso.min, K.reso.max),
      drive: num(f.drive, 0, 0, 1),
    },
    amp: env(raw.amp, base.amp),
    env: env(raw.env, base.env),
    lfos: [0, 1].map((i) => {
      const l = raw.lfos?.[i] ?? {}
      const d = base.lfos[i]
      return {
        // older patches name a shape instead of drawing one
        points: normalizePoints(l.points ?? (LFO_SHAPES.includes(l.shape) ? presetPoints(l.shape) : d.points), i ? 'tri' : 'sine'),
        mode: pick(l.mode, LFO_MODES, 'free'),
        grid: [0, 4, 8, 16, 32].includes(l.grid) ? l.grid : 8,
        sync: l.sync !== false,
        bars: LFO_BARS.includes(l.bars) ? l.bars : d.bars,
        hz: num(l.hz, d.hz, K.hz.min, K.hz.max),
      }
    }),
    mods: [],
    mono: raw.mono === true,
    glide: num(raw.glide, 0, K.glide.min, K.glide.max),
    volume: num(raw.volume, K.volume.def, K.volume.min, K.volume.max),
  }
  const routes = new Set()
  for (const m of Array.isArray(raw.mods) ? raw.mods : []) {
    if (!m || !SOURCES.includes(m.src) || !targetSpec(patch, m.target)) continue
    const key = `${m.src}>${m.target}`
    if (routes.has(key) || patch.mods.filter((x) => x.src === m.src).length >= MAX_ROUTES) continue
    routes.add(key)
    patch.mods.push({ id: typeof m.id === 'string' && /^\w{1,12}$/.test(m.id) ? m.id : newPartId(), src: m.src, target: m.target, amt: num(m.amt, 0.5, -1, 1), bi: typeof m.bi === 'boolean' ? m.bi : m.src !== 'env' })
  }
  return patch
}

// ── modulation targets ───────────────────────────────────────────────────────

/**
 * Targets are strings: "filter.cutoff", "filter.reso", "filter.drive", "pitch",
 * "amp.level", or "layer:<id>.<knob>". The knob spec and a name, or null.
 */
export function targetSpec(patch, target) {
  if (typeof target !== 'string') return null
  if (target === 'pitch') return { label: 'pitch', spec: { min: -24, max: 24 } }
  if (target === 'amp.level') return { label: 'volume', spec: { min: 0, max: 1 } }
  const f = /^filter\.(cutoff|reso|drive)$/.exec(target)
  if (f) return { label: `filter ${f[1]}`, spec: K[f[1]], get: (p) => p.filter[f[1]] }
  const l = /^layer:(\w+)\.(\w+)$/.exec(target)
  if (l && LAYER_KNOBS.includes(l[2])) {
    const index = patch.layers.findIndex((x) => x.id === l[1])
    if (index < 0) return null
    return { label: `${String.fromCharCode(65 + index)} ${K[l[2]].label}`, spec: K[l[2]], layerId: l[1], knob: l[2], index, get: (p) => p.layers.find((x) => x.id === l[1])?.[l[2]] }
  }
  return null
}

/** Where a route goes, as the processor numbers it (0: nowhere). */
function destIndex(patch, target) {
  const g = GLOBAL_DESTS.indexOf(target)
  if (g >= 0) return g + 1
  const t = targetSpec(patch, target)
  if (!t?.layerId) return 0
  return 10 + t.index * 10 + LAYER_KNOBS.indexOf(t.knob)
}

// ── the processor's view ─────────────────────────────────────────────────────

const LAYER_FIELDS = [
  // [name, min, max, def]
  ['on', 0, 1, 0], ['type', 0, 3, 0], ['wave', 0, 4, 2], ['table', 0, 5, 0], ['noise', 0, 2, 1],
  ['warpmode', 0, 8, 0], ['fmwave', 0, 3, 0], ['level', 0, 1, 0.8], ['pan', 0, 1, 0.5],
  ['pitch', -48, 48, 0], ['fine', -100, 100, 0], ['pw', 0.02, 0.98, 0.5], ['pos', 0, 1, 0],
  ['warp', 0, 1, 0], ['unison', 1, 16, 1], ['detune', 0, 1, 0.1], ['spread', 0, 1, 0.6],
  ['fm', 0, 8, 0], ['ratio', 0.25, 8, 1],
]

/** Every number the processor reads, with its range: one AudioParam each. */
export const AUDIO_PARAMS = [
  ...[0, 1, 2, 3].flatMap((i) => LAYER_FIELDS.map(([name, min, max, def]) => ({ key: `l${i}_${name}`, min, max, def }))),
  { key: 'f_on', min: 0, max: 1, def: 0 },
  { key: 'f_type', min: 0, max: 2, def: 0 },
  { key: 'f_slope', min: 0, max: 2, def: 1 },
  { key: 'f_cutoff', min: K.cutoff.min, max: K.cutoff.max, def: K.cutoff.def },
  { key: 'f_reso', min: 0, max: 1, def: K.reso.def },
  { key: 'f_drive', min: 0, max: 1, def: 0 },
  ...['a', 'e'].flatMap((p) => [
    { key: `${p}_attack`, min: K.attack.min, max: K.attack.max, def: K.attack.def },
    { key: `${p}_decay`, min: K.decay.min, max: K.decay.max, def: K.decay.def },
    { key: `${p}_sustain`, min: 0, max: 1, def: 0.8 },
    { key: `${p}_release`, min: K.release.min, max: K.release.max, def: K.release.def },
  ]),
  ...[0, 1].flatMap((i) => [
    { key: `o${i}_mode`, min: 0, max: 2, def: 0 },
    { key: `o${i}_sync`, min: 0, max: 1, def: 1 },
    { key: `o${i}_bars`, min: 1 / 64, max: 64, def: 1 },
    { key: `o${i}_hz`, min: K.hz.min, max: K.hz.max, def: K.hz.def },
  ]),
  // routes: four per modulator (env, lfo 1, lfo 2), each a destination and an amount
  ...Array.from({ length: SOURCES.length * MAX_ROUTES }, (_, i) => [
    { key: `m${i}_dest`, min: 0, max: 60, def: 0 },
    { key: `m${i}_amt`, min: -1, max: 1, def: 0 },
    { key: `m${i}_bi`, min: 0, max: 1, def: 1 },
  ]).flat(),
  { key: 'mono', min: 0, max: 1, def: 0 },
  { key: 'glide', min: 0, max: 1, def: 0 },
  { key: 'volume', min: 0, max: 1.5, def: 0.8 },
  { key: 'cps', min: 0.01, max: 10, def: 0.5 },
]

/** What the processor gets as a message: the LFOs' drawn shapes, as [x, y, c] rows. */
export const patchMessage = (patch) => ({ lfos: patch.lfos.map((o) => o.points.map((p) => [p.x, p.y, p.c ?? 0])) })

/** The patch as the processor's numbers. `cps`: the track's tempo, for synced LFOs. */
export function encodePatch(patch, { cps = 0.5 } = {}) {
  const out = {}
  for (let i = 0; i < MAX_LAYERS; i++) {
    const l = patch.layers[i]
    const set = (name, v) => { out[`l${i}_${name}`] = v }
    if (!l) { set('on', 0); continue }
    set('on', l.on ? 1 : 0)
    set('type', LAYER_TYPES.indexOf(l.type))
    set('wave', WAVES.indexOf(l.wave))
    set('table', TABLE_NAMES.indexOf(l.table))
    set('noise', NOISES.indexOf(l.color))
    set('warpmode', WARP_MODES.indexOf(l.warpmode))
    set('fmwave', FM_WAVES.indexOf(l.fmwave))
    for (const k of ['level', 'pan', 'fine', 'pw', 'pos', 'warp', 'detune', 'spread', 'fm', 'ratio']) set(k, l[k])
    set('pitch', l.oct * 12 + l.semi)
    // analog layers are one voice; the others stack
    set('unison', l.type === 'analog' || l.type === 'noise' ? 1 : l.unison)
  }
  const f = patch.filter
  Object.assign(out, {
    f_on: f.on ? 1 : 0,
    f_type: FILTER_TYPES.indexOf(f.type),
    f_slope: FILTER_SLOPES.indexOf(f.slope),
    f_cutoff: f.cutoff,
    f_reso: f.reso,
    f_drive: f.drive,
  })
  for (const [p, e] of [['a', patch.amp], ['e', patch.env]]) {
    out[`${p}_attack`] = e.attack
    out[`${p}_decay`] = e.decay
    out[`${p}_sustain`] = e.sustain
    out[`${p}_release`] = e.release
  }
  patch.lfos.forEach((o, i) => {
    out[`o${i}_mode`] = LFO_MODES.indexOf(o.mode)
    out[`o${i}_sync`] = o.sync ? 1 : 0
    out[`o${i}_bars`] = o.bars
    out[`o${i}_hz`] = o.hz
  })
  SOURCES.forEach((src, s) => {
    const routes = patch.mods.filter((m) => m.src === src)
    for (let r = 0; r < MAX_ROUTES; r++) {
      const m = routes[r]
      out[`m${s * MAX_ROUTES + r}_dest`] = m ? destIndex(patch, m.target) : 0
      out[`m${s * MAX_ROUTES + r}_amt`] = m ? m.amt : 0
      out[`m${s * MAX_ROUTES + r}_bi`] = m?.bi ? 1 : 0
    }
  })
  out.mono = patch.mono ? 1 : 0
  out.glide = patch.glide
  out.volume = patch.volume
  out.cps = clamp(cps, 0.01, 10)
  return out
}

// ── knobs by name (automation) ───────────────────────────────────────────────

/**
 * Automation names a knob by a key made of word characters: "volume", "glide",
 * "filter_cutoff", "amp_attack", "env_decay", "lfo1_hz", "L<layer id>_<knob>".
 */
export function knobAt(patch, key) {
  const m = /^(?:(volume|glide)|filter_(cutoff|reso|drive)|(amp|env)_(attack|decay|sustain|release)|lfo([12])_hz|L(\w+?)_(level|pan|fine|pw|pos|warp|detune|spread|fm|ratio))$/.exec(String(key))
  if (!m) return null
  if (m[1]) return { def: K[m[1]], value: patch[m[1]], label: m[1], set: (p, v) => { p[m[1]] = v } }
  if (m[2]) return { def: K[m[2]], value: patch.filter[m[2]], label: `filter ${m[2]}`, set: (p, v) => { p.filter[m[2]] = v } }
  if (m[3]) return { def: K[m[4]], value: patch[m[3]][m[4]], label: `${m[3] === 'amp' ? 'amp' : 'mod env'} ${m[4]}`, set: (p, v) => { p[m[3]][m[4]] = v } }
  if (m[5]) return { def: K.hz, value: patch.lfos[m[5] - 1].hz, label: `lfo ${m[5]} rate`, set: (p, v) => { p.lfos[m[5] - 1].hz = v } }
  const index = patch.layers.findIndex((l) => l.id === m[6])
  if (index < 0) return null
  return {
    def: K[m[7]],
    value: patch.layers[index][m[7]],
    label: `${String.fromCharCode(65 + index)} ${K[m[7]].label}`,
    set: (p, v) => { const l = p.layers.find((x) => x.id === m[6]); if (l) l[m[7]] = v },
  }
}
export const layerKnobKey = (layerId, knob) => `L${layerId}_${knob}`

// ── presets ──────────────────────────────────────────────────────────────────

const preset = (name, build) => {
  const p = initPatch()
  p.name = name
  build(p)
  return normalizePatch(p)
}

export const PRESETS = [
  preset('init', () => {}),
  preset('sub bass', (p) => {
    p.layers = [makeLayer('analog', { wave: 'sine', oct: -1 }), makeLayer('analog', { wave: 'triangle', level: 0.35 })]
    p.filter = { ...p.filter, on: true, cutoff: 900, reso: 0.1 }
    p.amp = { attack: 0.003, decay: 0.2, sustain: 0.9, release: 0.08 }
    p.mono = true
    p.glide = 0.04
  }),
  preset('reese', (p) => {
    p.layers = [makeLayer('supersaw', { unison: 7, detune: 0.32, spread: 0.3, level: 0.7 }), makeLayer('analog', { wave: 'sine', oct: -1, level: 0.6 })]
    p.filter = { ...p.filter, on: true, slope: 'ladder', cutoff: 520, reso: 0.35, drive: 0.35 }
    p.amp = { attack: 0.01, decay: 0.3, sustain: 1, release: 0.15 }
    p.lfos[0] = { ...p.lfos[0], points: presetPoints('sine'), sync: true, bars: 1 / 2 }
    p.mods = [{ src: 'lfo1', target: 'filter.cutoff', amt: 0.4 }]
  }),
  preset('pluck', (p) => {
    p.layers = [makeLayer('analog', { wave: 'sawtooth' }), makeLayer('analog', { wave: 'square', oct: 1, level: 0.3 })]
    p.filter = { ...p.filter, on: true, cutoff: 300, reso: 0.4 }
    p.amp = { attack: 0.002, decay: 0.35, sustain: 0, release: 0.2 }
    p.env = { attack: 0.001, decay: 0.25, sustain: 0, release: 0.2 }
    p.mods = [{ src: 'env', target: 'filter.cutoff', amt: 0.75 }]
  }),
  preset('hoover lead', (p) => {
    p.layers = [makeLayer('supersaw', { unison: 9, detune: 0.45, spread: 0.8 }), makeLayer('analog', { wave: 'pulse', pw: 0.25, oct: -1, level: 0.5 })]
    p.filter = { ...p.filter, on: true, cutoff: 3200, reso: 0.25 }
    p.env = { attack: 0.08, decay: 0.3, sustain: 0, release: 0.1 }
    p.mods = [{ src: 'env', target: 'pitch', amt: -0.1 }, { src: 'lfo1', target: 'pitch', amt: 0.02 }]
    p.lfos[0] = { ...p.lfos[0], points: presetPoints('sine'), sync: false, hz: 5.5 }
    p.mono = true
    p.glide = 0.12
  }),
  preset('glass pad', (p) => {
    p.layers = [makeLayer('wavetable', { table: 'bright', pos: 0.3, unison: 4, detune: 0.12 }), makeLayer('wavetable', { table: 'vowel', pos: 0.2, oct: 1, level: 0.4 })]
    p.filter = { ...p.filter, on: true, cutoff: 4200, reso: 0.15 }
    p.amp = { attack: 0.6, decay: 1, sustain: 0.8, release: 1.8 }
    p.lfos[0] = { ...p.lfos[0], points: presetPoints('tri'), sync: true, bars: 4 }
    p.lfos[1] = { ...p.lfos[1], points: presetPoints('sine'), sync: true, bars: 2 }
    p.volume = 0.6
  }),
  preset('fm bell', (p) => {
    p.layers = [makeLayer('analog', { wave: 'sine', fm: 3, ratio: 3.5 })]
    p.amp = { attack: 0.002, decay: 1.4, sustain: 0, release: 1.2 }
    p.env = { attack: 0.001, decay: 0.9, sustain: 0, release: 0.6 }
  }),
  preset('talking wobble', (p) => {
    p.layers = [makeLayer('wavetable', { table: 'vowel', pos: 0.5 }), makeLayer('analog', { wave: 'sine', oct: -1, level: 0.5 })]
    p.filter = { ...p.filter, on: true, slope: '24db', cutoff: 1400, reso: 0.5 }
    p.lfos[0] = { ...p.lfos[0], points: presetPoints('sine'), sync: true, bars: 1 / 8 }
  }),
]

// routes that point at a layer need that layer's id, so they're added once the layers exist
const LAYER_ROUTES = {
  'glass pad': [['lfo1', 0, 'pos', 0.5], ['lfo2', 1, 'pan', 0.6]],
  'fm bell': [['env', 0, 'fm', 1]],
  'talking wobble': [['lfo1', 0, 'pos', 0.9]],
}
for (const p of PRESETS) {
  for (const [src, index, knob, amt] of LAYER_ROUTES[p.name] ?? []) p.mods.push({ id: newPartId(), src, target: `layer:${p.layers[index].id}.${knob}`, amt })
}
