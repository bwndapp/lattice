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
 *   { where: 'fx' | 'insert', key, param, scale }   value → param, times `scale` if given
 */
const APP_PARAMS = {
  reverb: { prefix: 'rv_', where: 'fx', keys: { size: 'size', predelay: 'predelay', tone: 'tone', lowcut: 'lowcut', width: 'width' } },
  delay: { prefix: 'dl_', where: 'fx', keys: { feedback: 'feedback', tone: 'tone' } },
  space: { prefix: 'dl_', where: 'fx', keys: { delaytime: 'seconds' } }, // bars → seconds below
  bus: { prefix: '', where: 'insert', keys: { vol: 'gain', pan: 'pan' } },
  eq3: { prefix: '', where: 'insert', keys: { low: 'low', mid: 'mid', high: 'high', lowf: 'lowf', highf: 'highf' } },
  haas: { prefix: '', where: 'insert', keys: { time: 'time', mix: 'mix' } },
  widener: { prefix: '', where: 'insert', keys: { width: 'width', spread: 'spread', mono: 'mono' } },
  saturator: { prefix: '', where: 'insert', keys: { drive: 'drive', out: 'out' } },
  clipper: { prefix: '', where: 'insert', keys: { push: 'drive', ceiling: 'out' } },
  softclip: { prefix: '', where: 'insert', keys: { push: 'drive', ceiling: 'out' } },
  compressor: { prefix: '', where: 'insert', keys: { threshold: 'threshold', ratio: 'ratio', knee: 'knee', attack: 'attack', release: 'release', makeup: 'makeup' } },
}

export function appParam(project, target) {
  const parts = String(target ?? '').split(':')
  const node = project.nodes.find((n) => n.id === parts[1])
  const type = parts[0] === 'u' ? node?.data.chain?.find((u) => u.id === parts[2])?.type : node?.type
  const key = parts[0] === 'u' ? parts[3] : parts[2]
  const spec = APP_PARAMS[type]
  const param = spec?.keys[key]
  if (!param) return null
  const id = parts[0] === 'u' ? `${parts[1]}_${parts[2]}` : parts[1]
  const cps = (Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60
  // the space node's delay time is in bars
  const scale = type === 'space' && key === 'delaytime' ? 1 / cps : 1
  return { where: spec.where, key: `${spec.prefix}${id}`, param, scale }
}

export const nodeTarget = (nodeId, key) => `n:${nodeId}:${key}`
export const unitTarget = (nodeId, unitId, key) => `u:${nodeId}:${unitId}:${key}`
export const channelTarget = (patternId, channelId, key) => `c:${patternId}:${channelId}:${key}`

/**
 * What a target points at in this project: the knob's definition, its value now and a
 * name for it. Null when that knob is gone (its node, unit or instrument was deleted).
 */
export function resolveTarget(project, target) {
  const parts = String(target ?? '').split(':')
  if (parts[0] === 'n' && parts.length === 3) {
    const node = project.nodes.find((n) => n.id === parts[1])
    const spec = node && NODE_TYPES[node.type]
    const def = spec?.params.find((p) => p.key === parts[2] && p.type === 'knob')
    if (!def || !canAutomate(node.type, def.key)) return null
    return { def, value: node.data[def.key] ?? def.def, owner: node.data.name || spec.label, label: def.label }
  }
  if (parts[0] === 'u' && parts.length === 4) {
    const node = project.nodes.find((n) => n.id === parts[1] && n.type === 'fxrack')
    const unit = node?.data.chain?.find((u) => u.id === parts[2])
    const spec = unit && NODE_TYPES[unit.type]
    const def = spec?.params.find((p) => p.key === parts[3] && p.type === 'knob')
    if (!def || !canAutomate(unit.type, def.key)) return null
    return { def, value: unit.data[def.key] ?? def.def, owner: `${node.data.name || 'fx rack'} ${spec.label}`, label: def.label }
  }
  if (parts[0] === 'c' && parts.length === 4) {
    const pattern = project.patterns.find((p) => p.id === parts[1])
    const ch = pattern?.channels.find((c) => c.id === parts[2])
    const def = PARAMS.find((p) => p.key === parts[3])
    if (!ch || !def || ch.kind === 'code' || (def.kinds && !def.kinds.includes(ch.kind))) return null
    return { def, value: paramValue(ch, def.key), owner: `${pattern.name} ${ch.name}`, label: def.label }
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
 * (origin: where the automation's own bar 1 falls), `pts` are [x, y, c].
 */
export const CURVE_JS = `(total, len, clips, pts) => {
  const mod = (a, n) => ((a % n) + n) % n
  const at = (x) => {
    if (x <= pts[0][0]) return pts[0][1]
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0, c] = pts[i], [x1, y1] = pts[i + 1]
      if (x < x1) {
        const u = x1 > x0 ? (x - x0) / (x1 - x0) : 1
        return y0 + (y1 - y0) * (c ? u ** (2 ** (c * 3)) : u)
      }
    }
    return pts[pts.length - 1][1]
  }
  const local = (t, origin) => mod(t - origin, len)
  const curve = (time) => {
    const t = total > 0 ? mod(Number(time), total) : Number(time)
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
  const pts = auto.points.map((p) => [p.x, p.y, p.c ?? 0])
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
  return makeCurve(0, auto.bars, [], auto.points.map((p) => [p.x, p.y, p.c ?? 0])).at(x)
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
