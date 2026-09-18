/**
 * Signal flow: which parts of the patch are making sound right now, lit on the canvas.
 *
 * The generated code tags every source with the node it came from (`_n`) and the
 * instrument inside it (`_c`, see project.js). We ask the playing pattern for a cycle of
 * hits at a time, then each frame work out how recently each source fired and light its
 * node, its instrument and every wire that carries it onward. It's drawn straight onto
 * the DOM as a `--lit` number, so sixty frames a second never go through React.
 */

const GLOW = 0.3 // seconds a sound stays lit for after it stops
const BLOOM = 0.07 // seconds of extra brightness as it starts
const HOLD = 0.72 // how lit a note stays while it's still sounding
const FLOOR = 0.34 // how much glow a sound turned all the way down still gets
const STEP = 0.04 // only write a style when the light has moved this much

let paths = { nodes: new Map(), edges: new Map(), chans: new Map() } // element id → the sources feeding it
let source = null // { pattern, now, cps } getters
let hits = [] // { at, end (cycles), key } — what's sounding, kept while it rings
let cycle = null
let frame = 0
const els = new Map() // element id → the element, while it's on screen
const lit = new Map() // element id → the light we last wrote there
const meters = new Map() // meter id → the last reading written there
let colors = new Map() // source key → its colour as [r, g, b]

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

export function setFlowPaths(next, byKey) {
  paths = next
  colors = byKey ?? new Map()
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
  // nothing playing reads as nothing, not as a number that vanished
  for (const [id, el] of els) {
    if (id.startsWith('m:')) { el.style.removeProperty('--l'); el.style.removeProperty('--r'); el.classList.remove('over') }
    else write(el, id, 0)
  }
  els.clear()
  lit.clear()
  meters.clear()
}

const elementFor = (id, kind) => {
  const held = els.get(id)
  if (held?.isConnected) return held
  const where = kind === 'flow' ? `[data-flow="${CSS.escape(id)}"]`
    : kind === 'meter' ? `[data-meter="${CSS.escape(id.slice(2))}"]`
      : `.react-flow__${kind}[data-id="${CSS.escape(id)}"]`
  const found = document.querySelector(`.graph-canvas ${where}`)
  if (found) els.set(id, found)
  else els.delete(id)
  return found
}

function write(el, id, value, glow = '') {
  const was = lit.get(id)
  if (was && was.v === value && was.c === glow) return
  lit.set(id, { v: value, c: glow })
  if (value <= 0) {
    el.style.removeProperty('--lit')
    el.style.removeProperty('--glow')
    return
  }
  el.style.setProperty('--lit', String(value))
  if (glow) el.style.setProperty('--glow', glow)
}

function tick() {
  frame = requestAnimationFrame(tick)
  if (!source) return
  const now = source.now()
  const cps = source.cps() || 0.5
  if (!Number.isFinite(now)) return

  // a cycle of hits at a time: querying the pattern every frame would be wasteful
  const fade = GLOW * cps // the glow and the bloom, in cycles
  const bloom = BLOOM * cps
  const at = Math.floor(now)
  if (at !== cycle) {
    cycle = at
    // notes longer than a cycle are still sounding, so they carry over
    const ringing = hits.filter((h) => h.end > now - fade)
    const pattern = source.pattern()
    try {
      const fresh = []
      for (const hap of pattern?.queryArc(at, at + 1) ?? []) {
        if (!hap.hasOnset?.()) continue
        const n = hap.value?._n
        if (typeof n !== 'string') continue
        // how loud it lands in the mix: its own volume, times anything turning it down on the way
        const loud = Number(hap.value.gain ?? 1) * Number(hap.value.velocity ?? 1)
        const pan = Number(hap.value.pan ?? 0.5)
        fresh.push({
          at: Number(hap.whole.begin),
          end: Number(hap.whole.end),
          key: key(n, hap.value._c),
          loud: Number.isFinite(loud) ? Math.min(1, Math.max(0, loud)) : 1,
          pan: Number.isFinite(pan) ? Math.min(1, Math.max(0, pan)) : 0.5,
        })
      }
      hits = [...ringing, ...fresh]
    } catch { hits = ringing } // a pattern mid-change: the next cycle picks it up
  }

  const level = new Map()
  for (const hit of hits) {
    if (now < hit.at) continue
    let v
    if (hit.end - hit.at <= fade) {
      // a short one: flash and fade, the way a drum sounds
      const age = now - hit.at
      if (age > fade) continue
      v = 1 - age / fade
    } else {
      // a long one: bright as it starts, held while it rings, fading once it stops
      v = now < hit.end
        ? HOLD + (1 - HOLD) * Math.max(0, 1 - (now - hit.at) / bloom)
        : HOLD * (1 - (now - hit.end) / fade)
    }
    if (v <= 0) continue
    if (v > (level.get(hit.key)?.v ?? 0)) level.set(hit.key, { v, loud: hit.loud, pan: hit.pan })
  }

  /**
   * How lit something is, and what colour: the brightest of the sources running through
   * it sets how hard it glows, and they blend by how loud each one is, so two parts
   * sharing a wire mix on their way to the output.
   */
  const paint = (el, id, keys) => {
    let best = 0
    let r = 0
    let g = 0
    let b = 0
    let weight = 0
    for (const k of keys) {
      const on = level.get(k)
      if (!on) continue
      // how loud it is sets how much of the glow it gets and how much colour is left in it
      const v = on.v * (FLOOR + (1 - FLOOR) * on.loud)
      if (v > best) best = v
      const c = colors.get(k)
      if (!c) continue
      const sat = on.loud ** 0.55
      const grey = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
      r += (grey + (c[0] - grey) * sat) * v
      g += (grey + (c[1] - grey) * sat) * v
      b += (grey + (c[2] - grey) * sat) * v
      weight += v
    }
    // a slow curve: bright on the hit, then a long tail rather than a linear ramp down
    const value = Math.round(Math.sqrt(best) / STEP) * STEP
    const tone = (x) => Math.round(x / weight / 8) * 8 // in steps, so small shifts don't churn
    write(el, id, value, weight ? `rgb(${tone(r)} ${tone(g)} ${tone(b)})` : '')
  }

  /**
   * The left and right of what a wire carries, for the meters on a mixer's rows. Panning
   * decides how much goes each way, at equal power, so a sound in the middle isn't quietly
   * louder than one hard left.
   */
  const stereo = (id, keys) => {
    const el = elementFor(`m:${id}`, 'meter')
    if (!el) return
    let l = 0
    let r = 0
    for (const k of keys) {
      const on = level.get(k)
      if (!on) continue
      const amount = on.v * on.loud
      const angle = (on.pan ?? 0.5) * (Math.PI / 2)
      l += amount * Math.cos(angle)
      r += amount * Math.sin(angle)
    }
    const step = (x) => Math.round(Math.min(1.4, x) / 0.03) * 0.03
    const now = `${step(l)}|${step(r)}`
    if (meters.get(id) === now) return
    meters.set(id, now)
    el.style.setProperty('--l', String(step(l)))
    el.style.setProperty('--r', String(step(r)))
    el.classList.toggle('over', l > 0.999 || r > 0.999)
  }

  for (const [id, keys] of paths.nodes) {
    const el = keys.length && elementFor(id, 'node')
    if (el) paint(el, id, keys)
  }
  for (const [id, keys] of paths.edges) {
    const el = keys.length && elementFor(id, 'edge')
    if (el) paint(el, id, keys)
    if (keys.length) stereo(id, keys)
  }
  for (const [id, keys] of paths.chans) {
    const el = elementFor(id, 'flow')
    if (el) paint(el, id, keys)
  }
}
