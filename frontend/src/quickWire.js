import { NODE_TYPES, makesCycle } from './graph'

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
