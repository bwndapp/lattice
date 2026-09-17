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
const dbs = new Map() // wire id → the reading we last wrote above it
const meters = new Map() // wire id → where its needle is now, in dB
const FALL = 26 // dB a second the reading drops: it jumps to a peak and eases back down
const FLOOR_DB = -60 // quieter than this and it may as well say nothing
const HOT_DB = -6 // getting close to the ceiling
const OVER_DB = 0 // at it, or past it
let painted = 0 // when the last frame was, for the fall
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
    if (id.startsWith('db:')) { el.textContent = '-∞'; el.classList.add('quiet'); el.classList.remove('hot', 'over') } else write(el, id, 0)
  }
  els.clear()
  lit.clear()
  dbs.clear()
  meters.clear()
  painted = 0
}

const elementFor = (id, kind) => {
  const held = els.get(id)
  if (held?.isConnected) return held
  const where = kind === 'flow' ? `[data-flow="${CSS.escape(id)}"]`
    : kind === 'db' ? `[data-db="${CSS.escape(id.slice(3))}"]`
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

let gap = 0.016 // seconds since the last frame, for anything that eases over time
function tick() {
  frame = requestAnimationFrame(tick)
  const beat = performance.now()
  gap = Math.min(0.1, painted ? (beat - painted) / 1000 : 0.016)
  painted = beat
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
        fresh.push({
          at: Number(hap.whole.begin),
          end: Number(hap.whole.end),
          key: key(n, hap.value._c),
          loud: Number.isFinite(loud) ? Math.min(1, Math.max(0, loud)) : 1,
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
    if (v > (level.get(hit.key)?.v ?? 0)) level.set(hit.key, { v, loud: hit.loud })
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
    let carried = 0 // everything sounding in it at once, which is what the readout shows
    for (const k of keys) {
      const on = level.get(k)
      if (!on) continue
      carried += on.v * on.loud
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
    return carried
  }

  /**
   * What the wire is carrying, in decibels. It goes straight to a peak and falls back at a
   * steady rate, the way a meter's needle does, rather than following the sound exactly —
   * which would be a number flickering too fast to read.
   */
  const meter = (id, carried) => {
    const el = elementFor(`db:${id}`, 'db')
    if (!el) return
    const to = carried > 1e-4 ? 20 * Math.log10(Math.min(4, carried)) : -Infinity
    const was = meters.get(id) ?? -Infinity
    const now = to > was ? to : Math.max(to, was - FALL * gap)
    meters.set(id, now)
    const text = now > FLOOR_DB ? now.toFixed(1) : '-∞'
    if (dbs.get(id) === text) return
    dbs.set(id, text)
    el.textContent = text
    // green, amber, red, as a mixer's meter reads
    el.classList.toggle('quiet', text === '-∞')
    el.classList.toggle('hot', now >= HOT_DB && now < OVER_DB)
    el.classList.toggle('over', now >= OVER_DB)
  }
  for (const [id, keys] of paths.nodes) {
    const el = keys.length && elementFor(id, 'node')
    if (el) paint(el, id, keys)
  }
  for (const [id, keys] of paths.edges) {
    const el = keys.length && elementFor(id, 'edge')
    if (el) meter(id, paint(el, id, keys))
  }
  for (const [id, keys] of paths.chans) {
    const el = elementFor(id, 'flow')
    if (el) paint(el, id, keys)
  }
}
