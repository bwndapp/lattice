import { NODE_TYPES, makesCycle } from './graph'
import { collapsedHosts, routeEdge } from './frames'

/** Can this kind of node be dropped into the middle of a wire? It needs an input and an output. */
export const splicable = (type) => !!NODE_TYPES[type]?.inputs && type !== 'output'
export const firstInput = (type) => (NODE_TYPES[type]?.inputs === 1 ? 'in' : 'in-0')
const slotOf = (h) => Number(/^in-(\d+)$/.exec(h ?? '')?.[1] ?? -1)

/** Rewire A → B into A → node → B, given the wire's id (or the wire). Mutates the project draft. */
export function spliceInto(p, edgeId, nodeId) {
  const wire = p.edges.find((e) => e === edgeId || e.id === edgeId)
  const node = p.nodes.find((n) => n.id === nodeId)
  if (!wire || !node || !splicable(node.type) || wire.source === nodeId || wire.target === nodeId) return false
  p.edges = p.edges.filter((e) => e !== wire && e.source !== nodeId && e.target !== nodeId)
  p.edges.push({ source: wire.source, sourceHandle: wire.sourceHandle, target: nodeId, targetHandle: firstInput(node.type) })
  p.edges.push({ source: nodeId, target: wire.target, targetHandle: wire.targetHandle })
  return true
}

/**
 * Shift + A with one node selected: which side of it the new node goes. Anything with an
 * output takes the new node after it; the output (inputs only) takes it before.
 */
export function quickSide(node) {
  if (!node || !NODE_TYPES[node.type]) return null
  if (node.type !== 'output') return 'after'
  return NODE_TYPES[node.type].inputs ? 'before' : null
}

/** Can a node of this type (an instrument comes as a 'pattern') be wired in on that side? */
export function canQuickWire(type, side) {
  if (!NODE_TYPES[type]) return false
  if (side === 'after') return !!NODE_TYPES[type].inputs
  if (side === 'before') return type !== 'output'
  return false
}

/** The next free lane of a many-input node. */
const nextSlot = (edges, id) => `in-${Math.max(-1, ...edges.filter((e) => e.target === id).map((e) => slotOf(e.targetHandle))) + 1}`

/**
 * Place the just-added node `newId` beside `selId` and wire it in. Mutates the draft.
 * After a node: selected → new, and when the new node passes sound on, it takes over what
 * the selected node fed (an insert); otherwise it's a parallel wire. Before the output:
 * new → output, and an effect takes over its last lane (a bus or stack takes every lane);
 * otherwise it's one more lane. Never makes a loop. Returns true when it wired something.
 */
export function quickWire(p, selId, newId) {
  const sel = p.nodes.find((n) => n.id === selId)
  const node = p.nodes.find((n) => n.id === newId)
  const side = quickSide(sel)
  if (!node || !canQuickWire(node.type, side)) return false
  const safe = (s, t) => s !== t && !makesCycle(p.edges, s, t)
  // shove the nodes in the selected node's row one column over, to make room
  const shove = (dx, when) => { for (const n of p.nodes) if (n.id !== newId && n.id !== selId && Math.abs(n.y - sel.y) < 160 && when(n)) n.x += dx }

  if (side === 'after') {
    const down = p.edges.filter((e) => e.source === selId && (e.sourceHandle ?? 'out') === 'out')
    if (splicable(node.type) && down.length) {
      shove(300, (n) => n.x > sel.x)
      node.x = sel.x + 300
      node.y = sel.y
      const [first, ...rest] = down
      spliceInto(p, first, newId)
      for (const e of rest) e.source = newId
      return true
    }
    if (!safe(selId, newId)) return false
    node.x = sel.x + 300
    node.y = p.edges.some((e) => e.source === selId) ? sel.y + 200 : sel.y
    const handle = NODE_TYPES[node.type].inputs === 'many' ? nextSlot(p.edges, newId) : firstInput(node.type)
    p.edges.push({ source: selId, target: newId, targetHandle: handle })
    return true
  }

  // before the output (or whatever else only takes wires in)
  const ins = p.edges.filter((e) => e.target === selId).sort((a, b) => slotOf(a.targetHandle) - slotOf(b.targetHandle))
  if (splicable(node.type) && ins.length) {
    shove(-300, (n) => n.x < sel.x)
    node.x = sel.x - 300
    node.y = sel.y
    if (NODE_TYPES[node.type].inputs === 'many') {
      const lane = ins[0].targetHandle
      p.edges = p.edges.filter((e) => !ins.includes(e))
      ins.forEach((e, i) => p.edges.push({ source: e.source, sourceHandle: e.sourceHandle, target: newId, targetHandle: `in-${i}` }))
      p.edges.push({ source: newId, target: selId, targetHandle: lane })
    } else spliceInto(p, ins.at(-1), newId)
    return true
  }
  const one = NODE_TYPES[sel.type].inputs === 1
  if ((one && ins.length) || !safe(newId, selId)) return false // its one input is taken: leave it
  const feeding = ins.map((e) => p.nodes.find((n) => n.id === e.source)).filter(Boolean)
  node.x = sel.x - 360
  node.y = feeding.length ? Math.max(...feeding.map((n) => n.y)) + 230 : sel.y
  p.edges.push({ source: newId, target: selId, targetHandle: one ? 'in' : nextSlot(p.edges, selId) })
  return true
}

/*
 * The knife: shift + drag a line across wires, then pick something to sit inline on all of
 * them. One wire takes it as an insert. Several wires take a bus (anything that takes many)
 * as one node gathering them, but only when they all end on the same input side of one node;
 * a one-input effect goes on each wire as its own copy.
 */

/** Where segments ab and cd cross, or null. */
function crossing(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y
  const den = rx * sy - ry * sx
  if (!den) return null
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * rx, y: a.y + t * ry, t } : null
}

/**
 * The wires a line from a to b crosses, given each wire drawn as a polyline ([{ id, points }]).
 * One cut per wire, where the line first meets it, nearest a first.
 */
export function knifeCuts(a, b, paths) {
  const cuts = []
  for (const { id, points } of paths) {
    let hit = null
    for (let i = 1; i < points.length && !hit; i++) hit = crossing(a, b, points[i - 1], points[i])
    if (hit) cuts.push({ id, x: hit.x, y: hit.y, t: hit.t })
  }
  return cuts.sort((m, n) => m.t - n.t).map(({ t, ...c }) => c)
}

/** The crossed wires that are really there (none hidden inside a collapsed frame). */
function cutWires(p, cuts) {
  const hosts = collapsedHosts(p.frames)
  const seen = new Set()
  return cuts.map((c) => p.edges.find((e) => e.id === (c.id ?? c)))
    .filter((e) => e && !seen.has(e) && seen.add(e) && !routeEdge(e, hosts)?.hidden)
}

/**
 * How a node of this type goes in on the cut wires: 'splice' (one wire), 'gather' (several,
 * into one node that takes many), 'each' (a copy per wire), or null when it can't.
 */
export function knifeMode(p, cuts, type) {
  const wires = cutWires(p, cuts)
  if (!wires.length || !splicable(type)) return null
  if (wires.length === 1) return 'splice'
  if (NODE_TYPES[type].inputs !== 'many') return 'each'
  // gathering needs one target; on a node with named inputs (a sidechain), one of them
  const to = p.nodes.find((n) => n.id === wires[0].target)
  if (!to || wires.some((e) => e.target !== to.id)) return null
  if (NODE_TYPES[to.type]?.inputs !== 'many' && wires.some((e) => e.targetHandle !== wires[0].targetHandle)) return null
  return 'gather'
}

const NODE_W = 250
const NODE_H = 120
/** Move a node up or down, a little at a time, until it sits clear of the others. */
function clearSpot(p, node) {
  const hits = (y) => p.nodes.some((n) => n !== node && Math.abs(n.x - node.x) < NODE_W && Math.abs(n.y - y) < NODE_H)
  const y0 = node.y
  for (let i = 0; i < 40 && hits(node.y); i++) node.y = y0 + (i % 2 ? -1 : 1) * Math.ceil((i + 1) / 2) * 60
  if (hits(node.y)) node.y = y0
}

/**
 * Put the just-added node `nodeId` inline on the cut wires (knifeMode says how). Cuts are
 * [{ id, x, y }] in patch coordinates; the node already sits where the knife was let go, and
 * copies (one per wire) sit on their own cut. `makeId` names the copies. Keeps every other
 * wire and lane as it is, never makes a loop. Mutates the draft; returns the new nodes' ids,
 * or null when it wired nothing.
 */
export function knifeInsert(p, cuts, nodeId, makeId = (i) => `${nodeId}-${i}`) {
  const node = p.nodes.find((n) => n.id === nodeId)
  const mode = node && knifeMode(p, cuts, node.type)
  if (!mode) return null
  const wires = cutWires(p, cuts)
  if (wires.some((e) => e.source === nodeId || e.target === nodeId)) return null

  if (mode === 'gather') {
    const lanes = [...wires].sort((a, b) => slotOf(a.targetHandle) - slotOf(b.targetHandle))
    const lane = lanes[0].targetHandle
    p.edges = p.edges.filter((e) => !wires.includes(e))
    lanes.forEach((e, i) => p.edges.push({ source: e.source, sourceHandle: e.sourceHandle, target: nodeId, targetHandle: `in-${i}` }))
    p.edges.push({ source: nodeId, target: lanes[0].target, targetHandle: lane })
    clearSpot(p, node)
    return [nodeId]
  }

  // a copy per wire (or the one node on its one wire), each on its own cut
  const ids = []
  wires.forEach((wire, i) => {
    const n = i ? { ...JSON.parse(JSON.stringify(node)), id: makeId(i) } : node
    const cut = cuts.find((c) => (c.id ?? c) === wire.id)
    if (mode === 'each' && cut?.x != null) { n.x = Math.round(cut.x - NODE_W / 2); n.y = Math.round(cut.y - NODE_H / 2) }
    if (i) p.nodes.push(n)
    if (!spliceInto(p, wire, n.id)) { p.nodes = p.nodes.filter((x) => x !== n || !i); return }
    clearSpot(p, n)
    ids.push(n.id)
  })
  return ids.length ? ids : null
}
