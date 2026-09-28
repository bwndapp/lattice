import { NODE_TYPES, defaultData, inputKey, makesCycle } from './graph'
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
 * The knife: shift + right-drag a line across wires, then pick something to sit inline on all
 * of them. One wire takes it as an insert. Several wires take a bus (anything that takes many)
 * as one node gathering them, but only when they all end on the same input side of one node.
 * A one-input effect on several such wires gets a mixer bus gathering them first, with the
 * effect after it (the bus puts them on one audio bus, so the effect treats them as one
 * sound); on wires that end in different places it goes on each as its own copy, since
 * merging them would send every sound to every place.
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

/** The point on segment cd nearest p, and how far it is. */
function nearest(p, c, d) {
  const sx = d.x - c.x, sy = d.y - c.y
  const len = sx * sx + sy * sy
  const u = len ? Math.max(0, Math.min(1, ((p.x - c.x) * sx + (p.y - c.y) * sy) / len)) : 0
  const x = c.x + u * sx, y = c.y + u * sy
  return { x, y, d: Math.hypot(p.x - x, p.y - y) }
}

/**
 * The wires a line from a to b crosses, given each wire as the polyline of its drawn curve
 * ([{ id, points }], sampled finely, all in screen pixels). A wire counts when the line truly
 * crosses it, or when an end of the line rests on it (within `tol` px, about a wire's
 * thickness); passing close by is not a cut. One cut per wire, where the line first meets it,
 * nearest a first.
 */
export function knifeCuts(a, b, paths, tol = 6) {
  const cuts = []
  for (const { id, points } of paths) {
    let hit = null
    for (let i = 1; i < points.length; i++) {
      const c = crossing(a, b, points[i - 1], points[i])
      if (c && (!hit || c.t < hit.t)) hit = c
    }
    if (!hit) {
      // no crossing: the line may stop on the wire (its start or its end within tol of it)
      for (const [end, t] of [[a, 0], [b, 1]]) {
        let best = null
        for (let i = 1; i < points.length; i++) {
          const n = nearest(end, points[i - 1], points[i])
          if (!best || n.d < best.d) best = n
        }
        if (best && best.d <= tol && (!hit || t < hit.t)) hit = { x: best.x, y: best.y, t }
      }
    }
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

/** Do the wires all end on the same input side of one node (never a sidechain's sound and trigger at once)? */
function oneTarget(p, wires) {
  const to = p.nodes.find((n) => n.id === wires[0].target)
  if (!to || wires.some((e) => e.target !== to.id)) return false
  return NODE_TYPES[to.type]?.inputs === 'many' || wires.every((e) => e.targetHandle === wires[0].targetHandle)
}

/**
 * How a node of this type goes in on the cut wires: 'splice' (one wire), 'gather' (several,
 * into one node that takes many), 'bus' (several into one place: a mixer bus gathers them
 * and this effect goes after it), 'each' (a copy per wire), or null when it can't.
 */
export function knifeMode(p, cuts, type) {
  const wires = cutWires(p, cuts)
  if (!wires.length || !splicable(type)) return null
  if (wires.length === 1) return 'splice'
  const spec = NODE_TYPES[type]
  const same = oneTarget(p, wires)
  if (spec.inputs === 'many') return same ? 'gather' : null
  if (same && spec.inputs === 1 && (spec.group === 'effect' || spec.group === 'mixing')) return 'bus'
  return 'each'
}

/** The add menu's line for the cut wires: what picking an effect (or a bus) will do. */
export function knifeHint(p, cuts) {
  const n = cutWires(p, cuts).length
  if (n <= 1) return '→ on this wire'
  return oneTarget(p, cutWires(p, cuts))
    ? `→ one bus on ${n} wires · an effect goes after the bus`
    : `→ on each of ${n} wires · they end in different places`
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
 * copies (one per wire) sit on their own cut. `makeId(i, type)` names the copies and the bus.
 * Keeps every other wire and lane as it is, never makes a loop. Mutates the draft; returns
 * the ids to select (the effect, not the bus it made), or null when it wired nothing.
 */
export function knifeInsert(p, cuts, nodeId, makeId = (i, type) => `${nodeId}-${type === 'bus' ? 'bus' : i}`) {
  const node = p.nodes.find((n) => n.id === nodeId)
  const mode = node && knifeMode(p, cuts, node.type)
  if (!mode) return null
  const wires = cutWires(p, cuts)
  if (wires.some((e) => e.source === nodeId || e.target === nodeId)) return null

  if (mode === 'gather' || mode === 'bus') {
    const lanes = [...wires].sort((a, b) => slotOf(a.targetHandle) - slotOf(b.targetHandle))
    const { target, targetHandle: lane } = lanes[0]
    let gather = node
    if (mode === 'bus') {
      // a mixer bus where the knife was let go, named for the effect, the effect just right of it
      const data = { ...defaultData('bus'), name: `${NODE_TYPES[node.type].label} bus` }
      // cut out of a mixer bus: each channel keeps the fader it had there
      const from = p.nodes.find((n) => n.id === target)
      if (from?.type === 'bus' && from.data?.chan) {
        const chan = Object.fromEntries(lanes.map(inputKey).filter((k) => k in from.data.chan).map((k) => [k, from.data.chan[k]]))
        if (Object.keys(chan).length) data.chan = chan
      }
      gather = { id: makeId(0, 'bus'), type: 'bus', x: node.x, y: node.y, data }
      p.nodes.push(gather)
    }
    p.edges = p.edges.filter((e) => !wires.includes(e))
    lanes.forEach((e, i) => p.edges.push({ source: e.source, sourceHandle: e.sourceHandle, target: gather.id, targetHandle: `in-${i}` }))
    if (mode === 'bus') {
      p.edges.push({ source: gather.id, target: nodeId, targetHandle: firstInput(node.type) })
      p.edges.push({ source: nodeId, target, targetHandle: lane })
      clearSpot(p, gather)
      node.x = gather.x + NODE_W + 50
      node.y = gather.y
    } else p.edges.push({ source: nodeId, target, targetHandle: lane })
    clearSpot(p, node)
    return [nodeId]
  }

  // a copy per wire (or the one node on its one wire), each on its own cut
  const ids = []
  wires.forEach((wire, i) => {
    const n = i ? { ...JSON.parse(JSON.stringify(node)), id: makeId(i, node.type) } : node
    const cut = cuts.find((c) => (c.id ?? c) === wire.id)
    if (mode === 'each' && cut?.x != null) { n.x = Math.round(cut.x - NODE_W / 2); n.y = Math.round(cut.y - NODE_H / 2) }
    if (i) p.nodes.push(n)
    if (!spliceInto(p, wire, n.id)) { p.nodes = p.nodes.filter((x) => x !== n || !i); return }
    clearSpot(p, n)
    ids.push(n.id)
  })
  return ids.length ? ids : null
}

/*
 * Taking nodes out heals the line around them (like Blender's dissolve): whatever fed a
 * removed pass-through node now feeds what it fed. Sources and the output have nothing to
 * pass on, so they just go.
 */

/** The inputs of a node that pass its sound on: all of them, or a sidechain's sound side only. */
const passes = (type, handle) => !Array.isArray(NODE_TYPES[type]?.inputs) || slotOf(handle) <= 0

/**
 * Remove the nodes `ids` and their wires, healing around them: each wire out of a removed
 * node to one that stays gets whatever fed the removed node (through any other removed nodes
 * in a row), in lane order. Into a node that takes many, the first feed takes the wire's lane
 * and the others the next free lanes after it, so a bus the knife gathered gives the lanes
 * back as they were. An input that takes one wire takes the first; the rest go back to lanes
 * of the first node further down that takes many (deleting only a knife's bus: the first
 * sound goes through the effect, the others back to their own lanes). Never a loop, a
 * duplicate, or a wire over one that's there. Mutates the draft.
 */
export function healOnRemove(p, ids) {
  const gone = new Set(ids)
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const feeds = (id, seen = new Set()) => {
    if (seen.has(id)) return []
    seen.add(id)
    const type = byId.get(id)?.type
    return p.edges.filter((e) => e.target === id && passes(type, e.targetHandle))
      .sort((a, b) => slotOf(a.targetHandle) - slotOf(b.targetHandle))
      .flatMap((e) => (gone.has(e.source) ? feeds(e.source, seen) : [{ source: e.source, sourceHandle: e.sourceHandle }]))
  }
  const outs = p.edges.filter((e) => gone.has(e.source) && !gone.has(e.target))
    .map((e) => ({ target: e.target, targetHandle: e.targetHandle, from: feeds(e.source) }))
  p.nodes = p.nodes.filter((n) => !gone.has(n.id))
  p.edges = p.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target))

  const taken = (t, h) => p.edges.some((e) => e.target === t && e.targetHandle === h)
  const put = (f, target, targetHandle) => {
    if (f.source === target || makesCycle(p.edges, f.source, target)) return false
    if (p.edges.some((e) => e.source === f.source && (e.sourceHandle ?? 'out') === (f.sourceHandle ?? 'out') && e.target === target)) return true
    p.edges.push({ source: f.source, sourceHandle: f.sourceHandle, target, targetHandle })
    return true
  }
  // lay feeds into a node from lane `h` on: the lane itself, then the free ones after it
  const intoLanes = (fs, target, h) => {
    let slot = slotOf(h)
    fs.forEach((f, i) => {
      let lane = h
      if (i || taken(target, h)) { while (taken(target, `in-${slot}`)) slot++; lane = `in-${slot}` }
      put(f, target, lane)
    })
  }
  // the first node down the line from `id` that takes many, and the lane it comes in on
  const downMany = (id, seen = new Set()) => {
    if (seen.has(id)) return null
    seen.add(id)
    const out = p.edges.filter((e) => e.source === id)
    if (out.length !== 1) return null
    const to = byId.get(out[0].target)
    return NODE_TYPES[to?.type]?.inputs === 'many' ? out[0] : downMany(out[0].target, seen)
  }
  for (const { target, targetHandle, from } of outs) {
    if (!from.length) continue
    const spec = NODE_TYPES[byId.get(target)?.type]
    if (spec?.inputs === 'many') { intoLanes(from, target, targetHandle); continue }
    if (spec?.many?.includes(targetHandle)) { from.forEach((f) => put(f, target, targetHandle)); continue }
    const [first, ...rest] = from
    if (!taken(target, targetHandle)) put(first, target, targetHandle)
    const down = rest.length && downMany(target)
    if (down) intoLanes(rest, down.target, `in-${slotOf(down.targetHandle) + 1}`)
  }
}
