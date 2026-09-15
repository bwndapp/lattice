/**
 * Copy and paste for patch nodes. A copy holds the nodes (positions relative to their
 * top-left), the wires between them, and the patterns their pattern nodes play, so it
 * pastes the same way into this track or another one. Pasted patterns are copies too, so
 * editing the pasted steps doesn't change the originals, except when the original pattern
 * is no longer played by any node (after a cut): then the paste plays it again.
 */
import { newId } from './project'

const KEY = 'lattice:clipboard:nodes'
const clone = (v) => JSON.parse(JSON.stringify(v))
let memory = null // fallback when storage is unavailable

/** Build a copy of the given nodes (the output never copies). Null when there's nothing to copy. */
export function copyNodes(project, ids) {
  const wanted = new Set(ids)
  const nodes = project.nodes.filter((n) => wanted.has(n.id) && n.type !== 'output')
  if (!nodes.length) return null
  const kept = new Set(nodes.map((n) => n.id))
  const minX = Math.min(...nodes.map((n) => n.x))
  const minY = Math.min(...nodes.map((n) => n.y))
  const patternIds = new Set(nodes.filter((n) => n.type === 'pattern').map((n) => n.data.patternId))
  return clone({
    v: 1,
    origin: { x: minX, y: minY },
    nodes: nodes.map((n) => ({ ...n, x: n.x - minX, y: n.y - minY })),
    edges: project.edges.filter((e) => kept.has(e.source) && kept.has(e.target)).map(({ source, target, targetHandle }) => ({ source, target, targetHandle })),
    patterns: project.patterns.filter((p) => patternIds.has(p.id)),
  })
}

export function writeClipboard(clip) {
  memory = clip
  try { localStorage.setItem(KEY, JSON.stringify(clip)) } catch { /* storage unavailable: memory only */ }
}

export function readClipboard() {
  try {
    const clip = JSON.parse(localStorage.getItem(KEY))
    if (clip?.v === 1 && Array.isArray(clip.nodes) && clip.nodes.length) return clip
  } catch { /* fall back to memory */ }
  return memory
}

function copyName(project, name) {
  const taken = new Set(project.patterns.map((p) => p.name))
  const base = `${String(name).replace(/ copy( \d+)?$/, '')} copy`
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} ${i}`)) i++
  return `${base} ${i}`
}

/** Paste `clip` into project draft `p` with its top-left at `at`. Returns the new node ids. */
export function pasteNodes(p, clip, at) {
  const patternIds = new Map()
  for (const pattern of clip.patterns ?? []) {
    // the pattern is still here and nothing plays it (the nodes were cut, or deleted): paste
    // plays that same pattern again instead of leaving it behind and making a copy
    const idle = p.patterns.some((x) => x.id === pattern.id) && !p.nodes.some((node) => node.type === 'pattern' && node.data?.patternId === pattern.id)
    if (idle) { patternIds.set(pattern.id, pattern.id); continue }
    const id = newId()
    patternIds.set(pattern.id, id)
    p.patterns.push({ ...clone(pattern), id, name: copyName(p, pattern.name), channels: (pattern.channels ?? []).map((c) => ({ ...clone(c), id: newId() })) })
  }
  const nodeIds = new Map()
  for (const node of clip.nodes) {
    const id = `${node.type}${newId().slice(-5)}`
    nodeIds.set(node.id, id)
    const data = clone(node.data ?? {})
    if (node.type === 'pattern' && patternIds.has(data.patternId)) data.patternId = patternIds.get(data.patternId)
    p.nodes.push({ id, type: node.type, x: Math.round(at.x + node.x), y: Math.round(at.y + node.y), data })
  }
  for (const e of clip.edges ?? []) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) p.edges.push({ source: nodeIds.get(e.source), target: nodeIds.get(e.target), targetHandle: e.targetHandle })
  }
  return [...nodeIds.values()]
}
