/**
 * Signal flow: which parts of the patch are making sound right now, lit on the canvas.
 *
 * The generated code tags every source with the node it came from (`_n`) and the
 * instrument inside it (`_c`, see project.js). We ask the playing pattern for a cycle of
 * hits at a time, then each frame work out how recently each source fired and light its
 * node, its instrument and every wire that carries it onward. It's drawn straight onto
 * the DOM as a `--lit` number, so sixty frames a second never go through React.
 */

const GLOW = 0.3 // seconds a hit stays lit for
const STEP = 0.04 // only write a style when the light has moved this much

let paths = { nodes: new Map(), edges: new Map(), chans: new Map() } // element id → the sources feeding it
let source = null // { pattern, now, cps } getters
let hits = [] // { at: cycle, key } for the cycle we've looked at
let cycle = null
let frame = 0
const els = new Map() // element id → the element, while it's on screen
const lit = new Map() // element id → what we last wrote

const key = (nodeId, chanId) => (chanId ? `${nodeId}|${chanId}` : nodeId)

/**
 * The sources feeding every node and wire: walk back from each one until we reach the
 * nodes that actually make sound. A wire out of one instrument's port carries only that
 * instrument; the main out carries the rest of them.
 */
export function flowPaths(project, { sourceTypes, splitOf }) {
  const byId = new Map(project.nodes.map((n) => [n.id, n]))
  const nodes = new Map()
  const edges = new Map()
  const keysOfNode = (id, trail = new Set()) => {
    if (nodes.has(id)) return nodes.get(id)
    if (trail.has(id)) return []
    trail.add(id)
    const node = byId.get(id)
    let keys = []
    if (!node) keys = []
    else if (sourceTypes.has(node.type)) {
      const chans = node.type === 'pattern' ? (project.patterns.find((p) => p.id === node.data.patternId)?.channels ?? []) : []
      keys = chans.length ? chans.map((c) => key(id, c.id)) : [id]
    } else {
      keys = [...new Set(project.edges.filter((e) => e.target === id).flatMap((e) => keysOfEdge(e, trail)))]
    }
    nodes.set(id, keys)
    return keys
  }
  const keysOfEdge = (e, trail = new Set()) => {
    if (e.id && edges.has(e.id)) return edges.get(e.id)
    const src = byId.get(e.source)
    const chan = /^out-(.+)$/.exec(String(e.sourceHandle ?? ''))?.[1]
    let keys
    if (chan && src?.type === 'pattern') keys = [key(e.source, chan)]
    else {
      keys = keysOfNode(e.source, trail)
      // the main out doesn't carry what left by an instrument's own port
      const split = src?.type === 'pattern' ? splitOf(e.source) : null
      if (split?.size) keys = keys.filter((k) => !split.has(k.slice(k.indexOf('|') + 1)))
    }
    if (e.id) edges.set(e.id, keys)
    return keys
  }
  for (const n of project.nodes) keysOfNode(n.id)
  for (const e of project.edges) keysOfEdge(e)
  // the instrument rows on a pattern node light one at a time
  const chans = new Map()
  for (const n of project.nodes) {
    if (!sourceTypes.has(n.type) || n.type !== 'pattern') continue
    for (const k of nodes.get(n.id) ?? []) if (k.includes('|')) chans.set(k, [k])
  }
  return { nodes, edges, chans }
}

export function setFlowPaths(next) {
  paths = next
  for (const [id, el] of els) {
    if (next.nodes.has(id) || next.edges.has(id) || next.chans.has(id)) continue
    write(el, id, 0)
    els.delete(id)
  }
}

/** `pattern()` is what's playing, `now()` where it is in cycles, `cps()` how fast. */
export function startFlow(getters) {
  source = getters
  cycle = null
  if (!frame) frame = requestAnimationFrame(tick)
}

export function stopFlow() {
  cancelAnimationFrame(frame)
  frame = 0
  source = null
  hits = []
  cycle = null
  for (const [id, el] of els) write(el, id, 0)
  els.clear()
  lit.clear()
}

const elementFor = (id, kind) => {
  const held = els.get(id)
  if (held?.isConnected) return held
  const where = kind === 'flow' ? `[data-flow="${CSS.escape(id)}"]` : `.react-flow__${kind}[data-id="${CSS.escape(id)}"]`
  const found = document.querySelector(`.graph-canvas ${where}`)
  if (found) els.set(id, found)
  else els.delete(id)
  return found
}

function write(el, id, value) {
  if (lit.get(id) === value) return
  lit.set(id, value)
  if (value > 0) el.style.setProperty('--lit', String(value))
  else el.style.removeProperty('--lit')
}

function tick() {
  frame = requestAnimationFrame(tick)
  if (!source) return
  const now = source.now()
  const cps = source.cps() || 0.5
  if (!Number.isFinite(now)) return

  // a cycle of hits at a time: querying the pattern every frame would be wasteful
  const at = Math.floor(now)
  if (at !== cycle) {
    cycle = at
    hits = []
    const pattern = source.pattern()
    try {
      for (const hap of pattern?.queryArc(at, at + 1) ?? []) {
        if (!hap.hasOnset?.()) continue
        const n = hap.value?._n
        if (typeof n !== 'string') continue
        hits.push({ at: Number(hap.whole.begin), key: key(n, hap.value._c) })
      }
    } catch { hits = [] } // a pattern mid-change: the next cycle picks it up
  }

  const fade = GLOW * cps // how long the glow lasts, in cycles
  const level = new Map()
  for (const hit of hits) {
    const age = now - hit.at
    if (age < 0 || age > fade) continue
    const v = 1 - age / fade
    if (v > (level.get(hit.key) ?? 0)) level.set(hit.key, v)
  }

  const shine = (keys) => {
    let best = 0
    for (const k of keys) {
      const v = level.get(k) ?? 0
      if (v > best) best = v
    }
    // a slow curve: bright on the hit, then a long tail rather than a linear ramp down
    return Math.round(Math.sqrt(best) / STEP) * STEP
  }
  for (const [id, keys] of paths.nodes) {
    const el = keys.length && elementFor(id, 'node')
    if (el) write(el, id, shine(keys))
  }
  for (const [id, keys] of paths.edges) {
    const el = keys.length && elementFor(id, 'edge')
    if (el) write(el, id, shine(keys))
  }
  for (const [id, keys] of paths.chans) {
    const el = elementFor(id, 'flow')
    if (el) write(el, id, shine(keys))
  }
}
