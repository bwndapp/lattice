/**
 * The song: when each part plays. A part is a pattern, or a source node in the patch that
 * makes sound on its own (a rhythm, a melody, a code node, a synth playing its own notes).
 * Clips put a part on the timeline: { id, src, lane, start, len, offset }, in bars (cycles).
 * `offset` is how far into the part the clip begins (after a cut or a trimmed left edge).
 *
 *   src   "pattern:<id>" or "node:<id>"
 *   lane  the row it sits on (rows are free, like a calendar)
 *
 * While the song is on and has clips, only what's on the timeline plays: each part plays
 * from its own start inside its clips and is silent elsewhere, and the whole song loops
 * at its end. The patch still decides what the parts go through. Sources that only drive
 * a sidechain's trigger keep running, so ducking doesn't vanish.
 */
import { NODE_TYPES } from './graph'

const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
const snapTo = (v, step) => Math.round(v / step) * step
export const MAX_BARS = 512
export const MAX_CLIPS = 400

/** Source nodes that make sound by themselves (nothing wired into them). */
export function sourceNodes(project) {
  return project.nodes.filter((n) => NODE_TYPES[n.type]?.group === 'source' && n.type !== 'pattern' && !project.edges.some((e) => e.target === n.id))
}

/** Nodes that only feed sidechain triggers: they keep running whatever the timeline says. */
export function triggerOnly(project, nodeId) {
  const out = project.edges.filter((e) => e.source === nodeId)
  return out.length > 0 && out.every((e) => project.nodes.find((n) => n.id === e.target)?.type === 'sidechain' && e.targetHandle === 'in-1')
}

/** Everything that can go on the timeline, in sidebar order. */
export function songParts(project) {
  const patterns = project.patterns.map((p) => ({
    src: `pattern:${p.id}`,
    kind: 'pattern',
    id: p.id,
    name: p.name,
    bars: p.bars,
    inPatch: project.nodes.some((n) => n.type === 'pattern' && n.data.patternId === p.id),
  }))
  const nodes = sourceNodes(project).map((n) => ({
    src: `node:${n.id}`,
    kind: n.type,
    id: n.id,
    name: n.data?.name || partLabel(n),
    bars: n.type === 'sound' ? 1 : 4,
    inPatch: true,
    trigger: triggerOnly(project, n.id),
  }))
  return [...patterns, ...nodes]
}

function partLabel(node) {
  if (node.type === 'sound') return `${NODE_TYPES.sound.label} ${node.data.mini ?? ''}`.trim()
  if (node.type === 'notes') return `${NODE_TYPES.notes.label} ${node.data.sound ?? ''}`.trim()
  return NODE_TYPES[node.type]?.label ?? node.type
}

/** Clean a song against the project: clips must point at a part that still exists. */
export function normalizeSong(raw, project) {
  const valid = new Set(songParts(project).map((p) => p.src))
  const seen = new Set()
  const clips = []
  for (const c of Array.isArray(raw?.clips) ? raw.clips : []) {
    if (!c || typeof c.src !== 'string' || !valid.has(c.src)) continue
    const id = String(c.id ?? '').replace(/\W/g, '').slice(0, 24)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const start = snapTo(num(c.start, 0, 0, MAX_BARS - 0.25), 1 / 64)
    const clip = { id, src: c.src, lane: Math.round(num(c.lane, 0, 0, 63)), start, len: snapTo(num(c.len, 1, 1 / 16, MAX_BARS - start), 1 / 64) }
    const offset = snapTo(num(c.offset, 0, -MAX_BARS, MAX_BARS), 1 / 64)
    if (offset) clip.offset = offset
    clips.push(clip)
    if (clips.length >= MAX_CLIPS) break
  }
  return { on: raw?.on !== false, snap: raw?.snap === 'beat' ? 'beat' : 'bar', clips }
}

/** Bars the song lasts: to the end of its last clip. */
export function songLength(song) {
  return Math.max(0, ...(song?.clips ?? []).map((c) => c.start + c.len))
}

export function songActive(project) {
  return !!project.song?.on && project.song.clips.length > 0
}

/**
 * Mini-notation for "on during these spans, off elsewhere", one step per bar over the
 * whole song (so it repeats with the song); a bar that's partly on splits into beats.
 */
function maskMini(spans, total, beats) {
  const steps = []
  for (let bar = 0; bar < total; bar++) {
    const cells = Array.from({ length: beats }, (_, b) => {
      const t0 = bar + b / beats
      const t1 = bar + (b + 1) / beats
      return spans.some(([s, e]) => s < t1 - 1e-9 && e > t0 + 1e-9) ? 1 : 0
    })
    steps.push(cells.every((c) => c === 1) ? '1' : cells.every((c) => c === 0) ? '0' : `[${cells.join(' ')}]`)
  }
  return `<${steps.join(' ')}>`
}

const tidy = (v) => String(Math.round(v * 10000) / 10000)

/**
 * The expression for part `src` playing along the song, given its looping expression
 * `expr`. A clip plays the part from `offset` bars in, starting at its start; clips that
 * line up the same way share one copy of the part.
 */
export function songExpr(project, src, expr) {
  const song = project.song
  if (src.startsWith('node:') && triggerOnly(project, src.slice(5))) return expr
  const clips = song.clips.filter((c) => c.src === src)
  if (!clips.length) return 'silence'
  const total = Math.max(1, Math.ceil(songLength(song) - 1e-9))
  const beats = Math.max(1, Math.round(project.beats || 4))
  const byStart = new Map()
  for (const c of clips) {
    const key = tidy(c.start - (c.offset ?? 0)) // where the part's own bar 1 falls
    if (!byStart.has(key)) byStart.set(key, [])
    byStart.get(key).push([c.start, c.start + c.len])
  }
  const layers = [...byStart.entries()].map(([shift, spans]) => `p => p${Number(shift) ? `.late(${shift})` : ''}.mask("${maskMini(spans, total, beats)}")`)
  if (layers.length === 1) return `(${expr})${layers[0].slice(6)}`
  return `(${expr}).layer(${layers.join(', ')})`
}
