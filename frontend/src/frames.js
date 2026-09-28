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

/** React Flow-like nodes for a project at default sizes (for tests, and anything off the canvas). */
export function frameItems(project) {
  const hosts = collapsedHosts(project.frames)
  return [
    ...(project.frames ?? []).map((f) => ({ id: f.id, type: 'frame', position: { x: f.x, y: f.y }, width: f.w, height: f.collapsed ? FRAME_BAR_H : f.h, hidden: hosts.has(f.id) })),
    ...project.nodes.map((n) => ({ id: n.id, type: 'studio', position: { x: n.x, y: n.y }, hidden: hosts.has(n.id) })),
  ]
}
