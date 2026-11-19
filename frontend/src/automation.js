/**
 * Automation: any knob can follow a curve along the song, as in FL Studio.
 *
 * An automation is a part of the song, like a pattern: it lives in `project.song.autos`,
 * clips put it on the timeline (`src: "auto:<id>"`) and repeat, trim and slice like a
 * pattern's, and its curve is the same in every clip.
 *
 *   { id, name, target, bars, points: [{ x, y, c }] }
 *
 *   target  which knob: "n:<node>:<param>"            a node's knob
 *                       "u:<node>:<unit>:<param>"     a knob on an effect inside an fx rack
 *                       "c:<pattern>:<channel>:<param>" an instrument's sound knob
 *                       "e:<pattern>:<channel>:<param>" a knob on an instrument's engine
 *   x       bars from the start of the automation (0 … bars)
 *   y       where the knob points, 0 … 1 of its travel (so a log knob moves like the knob)
 *   c       the curve from this point to the next: 0 straight, up to ±1 bent
 *
 * Inside a clip the knob follows the curve. Outside its clips it stays where the
 * automation last left it; before the first clip it starts where the first clip starts.
 * The code reads the curve at each note's start, so it plays anywhere Strudel runs.
 */
import { NODE_TYPES } from './graph.js'
import { PARAMS, paramValue } from './project.js'
import { ENGINES, engineData, engineKnob } from './instruments/index.js'

const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
const snapTo = (v, step) => Math.round(v / step) * step
export const MAX_AUTOS = 64
export const MAX_POINTS = 256
export const AUTO_PREFIX = 'auto:'

/** Every knob can follow a curve. */
export function canAutomate() {
  return true
}

/**
 * Knobs whose sound is made by the app rather than by each note: reverb and delay settings
 * (fxbus.js) and the stereo inserts (stereo.js). They don't go in the code; while the song
 * plays the app moves them, which is what `appParam` describes:
 *   { where: 'fx' | 'insert' | 'engine', key, param, scale }   value → param, times `scale` if given
 * (an engine's key is its instrument's id, see instruments/host.js)
 */
const APP_PARAMS = {
  reverb: { prefix: 'rv_', where: 'fx', keys: { size: 'size', predelay: 'predelay', tone: 'tone', lowcut: 'lowcut', width: 'width' } },
  delay: { prefix: 'dl_', where: 'fx', keys: { feedback: 'feedback', tone: 'tone' } },
  space: { prefix: 'dl_', where: 'fx', keys: { delaytime: 'seconds' } }, // bars → seconds below
  bus: { prefix: '', where: 'insert', keys: { vol: 'gain', pan: 'pan' } },
  sidechain: { prefix: 'sc_', where: 'insert', keys: { depth: 'depth', attack: 'attack', release: 'release', drive: 'drive' } },
  eq3: { prefix: '', where: 'insert', keys: { low: 'low', mid: 'mid', high: 'high', lowf: 'lowf', highf: 'highf' } },
  haas: { prefix: '', where: 'insert', keys: { time: 'time', mix: 'mix' } },
  widener: { prefix: '', where: 'insert', keys: { width: 'width', spread: 'spread', mono: 'mono' } },
  utility: { prefix: '', where: 'insert', keys: { gain: 'gain', width: 'width', pan: 'pan' } },
  saturator: { prefix: '', where: 'insert', keys: { drive: 'drive', out: 'out', mix: 'mix' } },
  clipper: { prefix: '', where: 'insert', keys: { push: 'drive', ceiling: 'out', mix: 'mix' } },
  softclip: { prefix: '', where: 'insert', keys: { push: 'drive', ceiling: 'out', mix: 'mix' } },
  compressor: { prefix: '', where: 'insert', keys: { threshold: 'threshold', ratio: 'ratio', knee: 'knee', attack: 'attack', release: 'release', makeup: 'makeup', mix: 'mix' } },
  limiter: { prefix: '', where: 'insert', keys: { gain: 'gain', ceiling: 'ceiling', release: 'release' } },
  filter: { prefix: '', where: 'insert', keys: { lpf: 'lpf', lpq: 'lpq', hpf: 'hpf', mix: 'mix' } },
  djfilter: { prefix: '', where: 'insert', keys: { djf: 'djf', mix: 'mix' } },
  level: { prefix: '', where: 'insert', keys: { gain: 'gain', pan: 'pan' } },
  drive: { prefix: '', where: 'insert', keys: { shape: 'shape', crush: 'crush', mix: 'mix' } },
  phaser: { prefix: '', where: 'insert', keys: { rate: 'rate', depth: 'depth', mix: 'mix' } },
  chorus: { prefix: '', where: 'insert', keys: { rate: 'rate', depth: 'depth', mix: 'mix' } },
  flanger: { prefix: '', where: 'insert', keys: { rate: 'rate', depth: 'depth', feedback: 'feedback', mix: 'mix' } },
  tremolo: { prefix: '', where: 'insert', keys: { rate: 'rate', depth: 'depth' } },
  lofi: { prefix: '', where: 'insert', keys: { coarse: 'coarse', mix: 'mix' } },
  granulizer: { prefix: '', where: 'insert', keys: { size: 'size', density: 'density', position: 'position', spray: 'spray', pitch: 'pitch', pitchRand: 'pitchRand', glide: 'glide', chaos: 'chaos', shape: 'shape', reverse: 'reverse', spread: 'spread', freeze: 'freeze', feedback: 'feedback', mix: 'mix' } },
  ringmod: { prefix: '', where: 'insert', keys: { freq: 'freq', amount: 'amount', spread: 'spread', drift: 'drift', mix: 'mix', out: 'out' } },
  wook: { prefix: '', where: 'insert', keys: { hz: 'hz', width: 'width', smooth: 'smooth', chop: 'chop', warble: 'warble', filter: 'filter', spread: 'spread', swing: 'swing', rise: 'rise', mix: 'mix', out: 'out' } },
  bitcrush: { prefix: '', where: 'insert', keys: { bits: 'bits', rate: 'rate', mix: 'mix' } },
  distortion: { prefix: '', where: 'insert', keys: { drive: 'drive', tighten: 'tighten', tone: 'tone', bias: 'bias', mix: 'mix', out: 'out' } },
  pitch: { prefix: '', where: 'insert', keys: { semitones: 'semitones', fine: 'fine', grain: 'grain', mix: 'mix' } },
  freqshift: { prefix: '', where: 'insert', keys: { hz: 'hz', spread: 'spread', mix: 'mix' } },
}

export function appParam(project, target) {
  const parts = String(target ?? '').split(':')
  if (parts[0] === 'e') return resolveTarget(project, target) ? { where: 'engine', key: parts[2], param: parts[3] } : null
  const node = project.nodes.find((n) => n.id === parts[1])
  const type = parts[0] === 'u' ? node?.data.chain?.find((u) => u.id === parts[2])?.type : node?.type
  const key = parts[0] === 'u' ? parts[3] : parts[2]
  const spec = APP_PARAMS[type]
  const param = spec?.keys[key]
  if (!param) return null
  const id = parts[0] === 'u' ? `${parts[1]}_${parts[2]}` : parts[1]
  const cps = (Number(project.bpm) || 140) / (Number(project.beats) || 4) / 60
  // the space node's delay time is in bars
  const scale = type === 'space' && key === 'delaytime' ? 1 / cps : 1
  return { where: spec.where, key: `${spec.prefix}${id}`, param, scale }
}

export const nodeTarget = (nodeId, key) => `n:${nodeId}:${key}`
export const unitTarget = (nodeId, unitId, key) => `u:${nodeId}:${unitId}:${key}`
export const channelTarget = (patternId, channelId, key) => `c:${patternId}:${channelId}:${key}`
export const engineTarget = (patternId, channelId, key) => `e:${patternId}:${channelId}:${key}`

/**
 * What a target points at in this project: the knob's definition, its value now and a
 * name for it. Null when that knob is gone (its node, unit or instrument was deleted).
 */
/**
 * What feeds a node, by name, for telling automations apart: the pattern (or sound) its
 * signal comes from, walking back up the wires. Several: the first, and "+n".
 */
function feedOf(project, nodeId) {
  const names = []
  const seen = new Set([nodeId])
  let frontier = [nodeId]
  for (let depth = 0; depth < 8 && frontier.length && !names.length; depth++) {
    const next = []
    for (const id of frontier) {
      for (const e of project.edges) {
        if (e.target !== id || seen.has(e.source) || isTriggerEdge(e)) continue
        seen.add(e.source)
        const n = project.nodes.find((x) => x.id === e.source)
        if (!n) continue
        if (n.type === 'pattern') {
          const pat = project.patterns.find((x) => x.id === n.data?.patternId)
          const ch = String(e.sourceHandle ?? '').startsWith('out-') && pat?.channels.find((c) => `out-${c.id}` === e.sourceHandle)
          if (pat) names.push(ch ? tidyOwner(pat.name, ch.name) : pat.name)
        } else if (NODE_TYPES[n.type]?.group === 'source') names.push(n.data?.name || NODE_TYPES[n.type].label)
        else next.push(n.id)
      }
    }
    frontier = next
  }
  const unique = [...new Set(names)]
  return unique.length ? `${unique[0]}${unique.length > 1 ? ` +${unique.length - 1}` : ''}` : null
}
const isTriggerEdge = (e) => String(e.sourceHandle ?? '').startsWith('trig-')
/** "kicksynth kick synth" → "kicksynth": a pattern and its instrument, without saying it twice. */
function tidyOwner(pattern, channel) {
  const a = String(pattern ?? '').trim(), b = String(channel ?? '').trim()
  const squash = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!b || squash(a) === squash(b) || squash(a).includes(squash(b))) return a
  if (squash(b).includes(squash(a))) return b
  return `${a} ${b}`
}

export function resolveTarget(project, target) {
  const parts = String(target ?? '').split(':')
  if (parts[0] === 'n' && parts.length === 3) {
    const node = project.nodes.find((n) => n.id === parts[1])
    const spec = node && NODE_TYPES[node.type]
    const def = spec?.params.find((p) => p.key === parts[2] && p.type === 'knob')
    if (!def || !canAutomate(node.type, def.key)) return null
    const feed = feedOf(project, node.id)
    return { def, value: node.data[def.key] ?? def.def, owner: `${feed ? `${feed} › ` : ''}${node.data.name || spec.label}`, label: def.label }
  }
  if (parts[0] === 'u' && parts.length === 4) {
    const node = project.nodes.find((n) => n.id === parts[1] && n.type === 'fxrack')
    const unit = node?.data.chain?.find((u) => u.id === parts[2])
    const spec = unit && NODE_TYPES[unit.type]
    const def = spec?.params.find((p) => p.key === parts[3] && p.type === 'knob')
    if (!def || !canAutomate(unit.type, def.key)) return null
    const feed = feedOf(project, node.id)
    // the rack's own name when it has one; otherwise where its sound comes from
    const rack = node.data.name ? `${node.data.name} ` : ''
    return { def, value: unit.data[def.key] ?? def.def, owner: `${feed ? `${feed} › ` : ''}${rack}${spec.label}`, label: def.label }
  }
  if (parts[0] === 'c' && parts.length === 4) {
    const pattern = project.patterns.find((p) => p.id === parts[1])
    const ch = pattern?.channels.find((c) => c.id === parts[2])
    const def = PARAMS.find((p) => p.key === parts[3])
    if (!ch || !def || ch.kind === 'code' || (def.kinds && !def.kinds.includes(ch.kind))) return null
    return { def, value: paramValue(ch, def.key), owner: tidyOwner(pattern.name, ch.name), label: def.label }
  }
  if (parts[0] === 'e' && parts.length === 4) {
    const pattern = project.patterns.find((p) => p.id === parts[1])
    const ch = pattern?.channels.find((c) => c.id === parts[2])
    const found = ch?.engine && engineKnob(ENGINES[ch.engine.type], engineData(ch.engine), parts[3])
    if (!found) return null
    return { def: found.def, value: found.value, owner: tidyOwner(pattern.name, ch.name), label: found.label }
  }
  return null
}

/** 0 … 1 knob travel for a value, and back (log knobs move evenly in octaves). */
export const toPos = (v, { min, max, log }) => Math.min(1, Math.max(0, log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min)))
export const fromPos = (y, { min, max, log }) => (log ? min * (max / min) ** y : min + y * (max - min))

/** Clean automations against the project (a hand-edited header can't crash anything). */
export function normalizeAutos(raw, project) {
  const out = []
  const seen = new Set()
  const targets = new Set()
  for (const a of Array.isArray(raw) ? raw : []) {
    if (!a || typeof a.id !== 'string' || typeof a.target !== 'string') continue
    const id = a.id.replace(/\W/g, '').slice(0, 24)
    const target = a.target.replace(/[^\w:]/g, '').slice(0, 120)
    // one automation per knob; a knob that's gone keeps its curve until the automation is deleted
    if (!id || seen.has(id) || targets.has(target)) continue
    seen.add(id)
    targets.add(target)
    const bars = snapTo(num(a.bars, 4, 1 / 4, 256), 1 / 64)
    const points = (Array.isArray(a.points) ? a.points : [])
      .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .slice(0, MAX_POINTS)
      .map((p) => {
        const point = { x: snapTo(num(p.x, 0, 0, bars), 1 / 256), y: Math.round(num(p.y, 0.5, 0, 1) * 10000) / 10000 }
        const c = Math.round(num(p.c, 0, -1, 1) * 100) / 100
        if (c) point.c = c
        // the segment's shape (see CURVE_JS): its mode, how many times it repeats, its handles
        if (SEGMENT_MODES.includes(p.m) && p.m !== 'curve') {
          point.m = p.m
          if (CYCLING.has(p.m)) point.n = Math.round(num(p.n, 1, 1, 64))
          if (p.m === 'bezier') {
            const h = Array.isArray(p.h) ? p.h : []
            point.h = [num(h[0], 0.4, 0, 1), num(h[1], 0, -1, 1), num(h[2], 0.6, 0, 1), num(h[3], 0, -1, 1)].map((v) => Math.round(v * 1000) / 1000)
          }
        }
        return point
      })
      .sort((p, q) => p.x - q.x)
    const found = resolveTarget(project, target)
    if (!points.length) points.push({ x: 0, y: found ? toPos(found.value, found.def) : 0.5 })
    const auto = { id, target, bars, points }
    if (typeof a.name === 'string' && a.name.trim()) auto.name = a.name.trim().slice(0, 40)
    out.push(auto)
    if (out.length >= MAX_AUTOS) break
  }
  return out
}

/** The name an automation goes by: its own, or the knob's. */
export function autoName(project, auto) {
  if (auto.name) return auto.name
  const found = resolveTarget(project, auto.target)
  return found ? `${found.owner} · ${found.label}` : 'automation (knob gone)'
}

/**
 * The curve maths, as source, so the app and the generated code share one copy.
 * `(total, len, clips, pts) => (time) => y`: `clips` are [start, end, origin] in song bars
 * (origin: where the automation's own bar 1 falls), `pts` are rows (see `pointRow`):
 * [x, y, c, mode, n, a, b, cc, d] — the shape of the segment from each point to the next.
 */
export const CURVE_JS = `(total, len, clips, pts) => {
  const mod = (a, n) => ((a % n) + n) % n
  const at = (x) => {
    if (x <= pts[0][0]) return pts[0][1]
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0, c, m, n, ha, hb, hc, hd] = pts[i], [x1, y1] = pts[i + 1]
      if (x < x1) {
        const u = x1 > x0 ? (x - x0) / (x1 - x0) : 1
        const k = Math.max(1, n || 1)
        let f
        if (!m) f = c ? u ** (2 ** (c * 3)) : u
        else if (m === 1) {
          // a cubic bezier: handle one hangs off this point, handle two off the next, in value
          let lo = 0, hi = 1, t = u
          for (let j = 0; j < 22; j++) {
            t = (lo + hi) / 2
            const bx = 3 * (1 - t) * (1 - t) * t * ha + 3 * (1 - t) * t * t * hc + t * t * t
            if (bx < u) lo = t; else hi = t
          }
          const v = (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * (y0 + hb) + 3 * (1 - t) * t * t * (y1 + hd) + t ** 3 * y1
          return Math.min(1, Math.max(0, v))
        }
        else if (m === 2) f = 0 // hold
        else if (m === 3) f = k < 2 ? 0 : Math.min(k - 1, Math.floor(u * k)) / (k - 1) // stairs
        else if (m === 4) f = 0.5 - 0.5 * Math.cos(2 * Math.PI * k * u) // sine
        else if (m === 5) f = 1 - Math.abs(1 - 2 * mod(k * u, 1)) // triangle
        else if (m === 6) f = mod(k * u, 1) // saw
        else f = mod(k * u, 1) < 0.5 ? 0 : 1 // square
        return y0 + (y1 - y0) * f
      }
    }
    return pts[pts.length - 1][1]
  }
  const local = (t, origin) => mod(t - origin, len)
  const curve = (time) => {
    // a moment before bar 1 (play's pre-roll) is bar 1, not the end of the song come round:
    // wrapped, it read the curve's last value — a filter wide open for the first beat
    const t0 = Math.max(0, Number(time))
    const t = total > 0 ? mod(t0, total) : t0
    let last = null
    for (const [start, end, origin] of clips) {
      if (t >= start && t < end) return at(local(t, origin))
      if (end <= t && (!last || end >= last[1])) last = [start, end, origin]
    }
    if (last) {
      const x = last[1] - last[2]
      return at(x > 0 && mod(x, len) < 1e-9 ? len : mod(x, len))
    }
    return clips.length ? at(local(clips[0][0], clips[0][2])) : pts[0][1]
  }
  curve.at = at
  return curve
}`
/** The ways a segment can go from its point to the next. */
export const SEGMENT_MODES = ['curve', 'bezier', 'hold', 'stairs', 'sine', 'triangle', 'saw', 'square']
/** Modes that repeat across a segment, `n` times. */
export const CYCLING = new Set(['stairs', 'sine', 'triangle', 'saw', 'square'])
/** A point as the curve maths reads it. */
export function pointRow(p) {
  const m = Math.max(0, SEGMENT_MODES.indexOf(p.m ?? 'curve'))
  const h = p.h ?? [0.4, 0, 0.6, 0]
  return [p.x, p.y, p.c ?? 0, m, p.n ?? 1, h[0], h[1], h[2], h[3]]
}

// eslint-disable-next-line no-new-func
const makeCurve = new Function(`return ${CURVE_JS}`)()

const SONG_ORDER = (a, b) => a.start - b.start

/** The arguments of the curve for one automation in the song. */
function curveArgs(song, auto) {
  const total = Math.max(0, ...song.clips.map((c) => c.start + c.len))
  const clips = song.clips
    .filter((c) => c.src === `${AUTO_PREFIX}${auto.id}`)
    .sort(SONG_ORDER)
    .map((c) => [c.start, c.start + c.len, c.start - (c.offset ?? 0)])
  const pts = auto.points.map(pointRow)
  return { total, len: auto.bars, clips, pts }
}

/** Automations that move a knob while the song plays: song on, a knob to move, clips down. */
export function activeAutos(project) {
  const song = project.song
  if (!song?.on || !song.autos?.length) return []
  return song.autos.filter((a) => song.clips.some((c) => c.src === `${AUTO_PREFIX}${a.id}`) && resolveTarget(project, a.target))
}

/** A function of song time (bars) → the knob's value, for showing knobs move. */
export function autoValueFn(project, auto) {
  const found = resolveTarget(project, auto.target)
  if (!found) return null
  const { total, len, clips, pts } = curveArgs(project.song, auto)
  const y = makeCurve(total, len, clips, pts)
  return (t) => fromPos(y(t), found.def)
}

/** The curve's height at x bars into the automation (for drawing it). */
export function curveAt(auto, x) {
  return makeCurve(0, auto.bars, [], auto.points.map(pointRow)).at(x)
}

/**
 * Editing points (the editor's gestures, kept here so they're tested). Each returns new
 * points, sorted by x as the curve reads them; a point keeps its bend as it moves.
 */
const byX = (list) => list.map((p, i) => ({ p, i })).sort((a, b) => a.p.x - b.p.x || a.i - b.i)

/** A new point at (x, y), after any others at the same x. Returns { points, index }. */
export function addPoint(points, x, y) {
  let index = points.findIndex((p) => p.x > x)
  if (index < 0) index = points.length
  const next = [...points]
  next.splice(index, 0, { x, y: Math.round(y * 10000) / 10000 })
  return { points: next, index }
}

/** Points without those at `indices`; the first one stays if they'd all go. */
export function removePoints(points, indices) {
  const gone = new Set(indices)
  const next = points.filter((_, i) => !gone.has(i))
  return next.length ? next : points.slice(0, 1)
}

/**
 * A ripple drag: the points at `indices` move by dx and dy, and every point after them moves
 * sideways by the same dx (keeping its value), so what follows keeps its spacing. A point at
 * the curve's very end stays put: dragging right squeezes up to it rather than off the end.
 * Returns { points, indices } as movePoints, indices being the dragged ones.
 */
export function ripplePoints(points, indices, dx, dy, bars) {
  const group = [...new Set(indices)].filter((i) => points[i])
  if (!group.length) return { points, indices: [] }
  // the points after it by order (a point stacked on it at the same time comes along too)
  const lastIdx = Math.max(...group)
  const inGroup = new Set(group)
  const after = points.flatMap((p, i) => (!inGroup.has(i) && i > lastIdx && p.x < bars - 1e-9 ? [i] : []))
  // sideways, all of them (points don't cross, so they keep their order and their places)
  const across = movePoints(points, [...group, ...after], dx, 0, bars)
  // up and down, only the ones being dragged
  return movePoints(across.points, group, 0, dy, bars)
}

/**
 * The points at `indices` moved together by dx bars and dy of travel, held inside
 * 0 … bars and 0 … 1 as a group (copy: the originals stay). Returns { points, indices }:
 * where the moved points are now.
 */
export function movePoints(points, indices, dx, dy, bars, copy = false) {
  const group = [...new Set(indices)].filter((i) => points[i])
  if (!group.length) return { points, indices: [] }
  const xs = group.map((i) => points[i].x)
  const ys = group.map((i) => points[i].y)
  dx = Math.min(bars - Math.max(...xs), Math.max(-Math.min(...xs), dx))
  if (!copy) {
    // moved points don't pass the points either side of them: each segment's shape belongs to
    // the point it starts from, and points swapping places scrambled them. Either side by
    // order, not by time: of two points at one time (a step), the first may go left and the
    // second right, and they never trade places
    const inGroup = new Set(group)
    const lo = Math.min(...xs), hi = Math.max(...xs)
    const first = Math.min(...group), last = Math.max(...group)
    let before = first - 1
    while (before >= 0 && inGroup.has(before)) before--
    let after = last + 1
    while (after < points.length && inGroup.has(after)) after++
    if (before >= 0) dx = Math.max(dx, points[before].x - lo)
    if (after < points.length) dx = Math.min(dx, points[after].x - hi)
  }
  dy = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), dy))
  const moving = new Set(group)
  const list = copy ? points.map((p) => ({ ...p, moved: false })) : points.map((p, i) => ({ ...p, moved: moving.has(i) }))
  for (const i of group) {
    const p = points[i]
    const q = { ...p, x: Math.round((p.x + dx) * 256) / 256, y: Math.round((p.y + dy) * 10000) / 10000, moved: true }
    if (copy) { delete q.c; list.push(q) } else list[i] = q
  }
  const sorted = byX(list).map(({ p }) => p)
  return {
    points: sorted.map(({ moved, ...p }) => p), // eslint-disable-line no-unused-vars
    indices: sorted.flatMap((p, i) => (p.moved ? [i] : [])),
  }
}

const tidy = (v) => String(Math.round(v * 10000) / 10000)
export const autoVar = (id) => `a_${id}`

/**
 * Code for the automations the song plays: a helper, then one continuous pattern per knob.
 * Returns { lines, lookup } where lookup(target) is the pattern's name for an automated knob.
 */
export function automationCode(project) {
  // knobs the app moves itself (reverb size, a bus fader, …) aren't read from the code
  const autos = activeAutos(project).filter((a) => !appParam(project, a.target))
  if (!autos.length) return { lines: [], lookup: () => null }
  const lines = [
    '// automation: knobs that follow a curve along the song (read at each note)',
    `const automate = (total, len, clips, pts, lo, hi, log) => { const y = (${CURVE_JS})(total, len, clips, pts); return signal((t) => { const v = y(t); return log ? lo * (hi / lo) ** v : lo + v * (hi - lo) }) }`,
  ]
  const names = new Map()
  for (const auto of autos) {
    const { def } = resolveTarget(project, auto.target)
    const { total, len, clips, pts } = curveArgs(project.song, auto)
    const list = (rows) => `[${rows.map((r) => `[${r.map(tidy).join(', ')}]`).join(', ')}]`
    lines.push(`const ${autoVar(auto.id)} = automate(${tidy(total)}, ${tidy(len)}, ${list(clips)}, ${list(pts)}, ${def.min}, ${def.max}, ${def.log ? 'true' : 'false'})`)
    names.set(auto.target, autoVar(auto.id))
  }
  lines.push('')
  return { lines, lookup: (target) => names.get(target) ?? null }
}
