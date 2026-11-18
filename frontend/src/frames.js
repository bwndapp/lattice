/**
 * Frames on the patch, the parts that don't need React: what a frame holds, collapsing and
 * opening it, and where the wires of a collapsed frame's hidden nodes are drawn.
 *
 * An open frame holds whatever sits inside it (a node's middle within its box). A collapsed
 * frame is only its title bar, so what it held when it closed is kept on it as `members`
 * (node and frame ids) and moves with it; opening it goes back to going by position.
 * Collapsing is only looks: project.nodes and project.edges never change, so the patch
 * plays exactly the same.
 *
 * `rfNodes` are React Flow's nodes ({ id, type, position, measured/width/height, hidden }).
 */

export const FRAME_BAR_H = 28 // a collapsed frame's height: its title bar and border

export const rfSize = (n) => ({ w: n.measured?.width ?? n.width ?? 250, h: n.measured?.height ?? n.height ?? 120 })

/** The nodes (and smaller frames) inside a frame, from React Flow's nodes. Hidden ones aren't. */
export function insideFrame(frame, rfNodes) {
  const inBox = (x, y) => x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h
  return rfNodes.filter((n) => {
    if (n.id === frame.id || n.hidden) return false
    const { w, h } = rfSize(n)
    if (n.type === 'frame') return inBox(n.position.x, n.position.y) && inBox(n.position.x + w, n.position.y + h)
    return inBox(n.position.x + w / 2, n.position.y + h / 2)
  })
}

/**
 * Every id a frame holds, frames within it and what they hold included: its members when
 * collapsed, what sits in it when open.
 */
export function heldBy(frame, rfNodes, frames = []) {
  const byId = new Map(frames.map((f) => [f.id, f]))
  const out = new Set()
  const walk = (f) => {
    const direct = f.collapsed ? (f.members ?? []) : insideFrame(f, rfNodes).map((n) => n.id)
    for (const id of direct) {
      if (id === frame.id || out.has(id)) continue
      out.add(id)
      if (byId.has(id)) walk(byId.get(id))
    }
  }
  walk(frame)
  return out
}

/** Close a frame to its title bar, keeping what it holds now. */
export function collapseFrame(p, id, rfNodes) {
  const f = p.frames?.find((x) => x.id === id)
  if (!f || f.collapsed) return
  const members = [...heldBy(f, rfNodes, p.frames)]
  f.collapsed = true // (in the order a loaded track has them, so the two compare equal)
  f.members = members
}

/** Open a frame again: full size, and back to holding whatever sits inside it. */
export function expandFrame(p, id) {
  const f = p.frames?.find((x) => x.id === id)
  if (!f) return
  delete f.collapsed
  delete f.members
}

/** Take a frame away. A collapsed one opens first, so its nodes come back into view, never go. */
export function removeFrame(p, id) {
  expandFrame(p, id)
  p.frames = (p.frames ?? []).filter((f) => f.id !== id)
}

/**
 * The collapsed frame each hidden node (or frame) shows as: the outermost one still in
 * view. A Map of hidden id → frame id; anything not in it is in view.
 */
export function collapsedHosts(frames = []) {
  const owner = new Map() // hidden id → a collapsed frame that holds it
  for (const f of frames) {
    if (!f.collapsed) continue
    for (const m of f.members ?? []) if (m !== f.id && !owner.has(m)) owner.set(m, f.id)
  }
  const hosts = new Map()
  for (const m of owner.keys()) {
    let host = owner.get(m)
    const seen = new Set([m])
    while (owner.has(host) && !seen.has(host)) { seen.add(host); host = owner.get(host) }
    if (!owner.has(host)) hosts.set(m, host) // (a loop of frames holding each other shows nothing hidden)
  }
  return hosts
}

/**
 * Where a wire is drawn with some nodes hidden: from a hidden node it leaves the right of its
 * collapsed frame, into one it arrives on the left; a wire within one collapsed frame isn't
 * drawn at all. Null when the wire is drawn as it is.
 */
export function routeEdge(e, hosts) {
  const s = hosts.get(e.source)
  const t = hosts.get(e.target)
  if (!s && !t) return null
  if (s && s === t) return { hidden: true }
  return {
    source: s ?? e.source,
    sourceHandle: s ? 'frame-out' : (e.sourceHandle ?? 'out'),
    target: t ?? e.target,
    targetHandle: t ? 'frame-in' : e.targetHandle,
  }
}

/**
 * An open frame's ports: a wire coming into the frame meets an input on its left edge, and
 * one going out leaves by an output on its right edge, as a module would have them. Wires
 * into the same port inside (one node's one input) share one input on the edge; likewise
 * out. Only the innermost frame a wire crosses into (or out of) gets the port.
 *
 *   pins:  Map frame id → { ins: [{ key, y }], outs: [{ key, y }] } (y from the frame's top)
 *   route: Map edge id → { inFrame, inKey, outFrame, outKey } for each wire that crosses one
 *
 * A key is "node|port". `hosts` (collapsedHosts) are left to routeEdge: a wire to a hidden
 * node is drawn to its collapsed frame, not through ports.
 */
export function framePins(frames = [], rfNodes = [], edges = [], hosts = new Map()) {
  const open = frames.filter((f) => !f.collapsed && !hosts.has(f.id))
  const pins = new Map()
  const route = new Map()
  if (!open.length) return { pins, route }
  const byId = new Map(rfNodes.map((n) => [n.id, n]))
  const area = (f) => f.w * f.h
  const holding = new Map() // node id → the open frames it's in, innermost first
  const framesOf = (id) => {
    if (holding.has(id)) return holding.get(id)
    const n = byId.get(id)
    if (!n || n.hidden) { holding.set(id, []); return [] }
    const { w, h } = rfSize(n)
    const cx = n.position.x + w / 2, cy = n.position.y + h / 2
    const list = open.filter((f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h).sort((a, b) => area(a) - area(b))
    holding.set(id, list)
    return list
  }
  const portY = (id, f) => {
    const n = byId.get(id)
    return n ? n.position.y + 30 - f.y : f.h / 2
  }
  const add = (f, side, key, y) => {
    if (!pins.has(f.id)) pins.set(f.id, { ins: new Map(), outs: new Map() })
    const at = pins.get(f.id)[side]
    if (!at.has(key)) at.set(key, y)
  }
  for (const e of edges) {
    if (hosts.has(e.source) || hosts.has(e.target)) continue
    const fs = framesOf(e.source)
    const ft = framesOf(e.target)
    const outFrame = fs.find((f) => !ft.includes(f)) ?? null
    const inFrame = ft.find((f) => !fs.includes(f)) ?? null
    if (!outFrame && !inFrame) continue
    const r = {}
    if (inFrame) { r.inFrame = inFrame.id; r.inKey = `${e.target}|${e.targetHandle ?? 'in'}`; add(inFrame, 'ins', r.inKey, portY(e.target, inFrame)) }
    if (outFrame) { r.outFrame = outFrame.id; r.outKey = `${e.source}|${e.sourceHandle ?? 'out'}`; add(outFrame, 'outs', r.outKey, portY(e.source, outFrame)) }
    route.set(e.id, r)
  }
  // in order down the edge, kept clear of the title bar, the bottom and each other
  const spaced = (map, f) => {
    const list = [...map].map(([key, y]) => ({ key, y })).sort((a, b) => a.y - b.y)
    let last = FRAME_BAR_H + 4
    for (const p of list) { p.y = Math.max(last + 14, Math.min(f.h - 10, p.y)); last = p.y }
    return list
  }
  const out = new Map()
  for (const f of open) {
    const at = pins.get(f.id)
    if (at) out.set(f.id, { ins: spaced(at.ins, f), outs: spaced(at.outs, f) })
  }
  return { pins: out, route }
}

/** A wire dropped on a frame's port, as the wire it means: into (or out of) the node inside. */
export function throughPin(c) {
  const out = { ...c }
  if (String(c.targetHandle ?? '').startsWith('pi-t:')) {
    const [node, port] = c.targetHandle.slice(5).split('|')
    out.target = node
    out.targetHandle = port
  }
  if (String(c.sourceHandle ?? '').startsWith('po-s:')) {
    const [node, port] = c.sourceHandle.slice(5).split('|')
    out.source = node
    out.sourceHandle = port
  }
  return out
}

/** React Flow-like nodes for a project at default sizes (for tests, and anything off the canvas). */
export function frameItems(project) {
  const hosts = collapsedHosts(project.frames)
  return [
    ...(project.frames ?? []).map((f) => ({ id: f.id, type: 'frame', position: { x: f.x, y: f.y }, width: f.w, height: f.collapsed ? FRAME_BAR_H : f.h, hidden: hosts.has(f.id) })),
    ...project.nodes.map((n) => ({ id: n.id, type: 'studio', position: { x: n.x, y: n.y }, hidden: hosts.has(n.id) })),
  ]
}
