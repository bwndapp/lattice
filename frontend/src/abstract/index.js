import cube from './cube/index.js'
import fib from './fib/index.js'

/**
 * Abstract instruments: sources that make music by some stranger means than steps and
 * notes — a puzzle you twist, a thing you throw, a shape you grow. Each is a node in the
 * patch that makes sound on its own, so it wires into effects like any source and lands on
 * the timeline as a part, with nothing else in the app knowing what it is.
 *
 * A definition:
 *   type, label, blurb   its node type and how menus describe it
 *   normalize(raw)       saved settings (anything) → complete state
 *   pack(state)          (optional) state → how it's saved in the track (compact)
 *   code(state)          state → a Strudel expression: what it plays, one cycle a bar
 *   layers               names of its layers, one input each: wire a sound into one and that
 *                        layer plays it on its rhythm instead of its own sound (Syrup's notes
 *                        chopped by the cube, say)
 *   parts(state)         its layers: [{ id, name, expr | null, drive(x) }] — expr its own
 *                        sound, drive(x) any pattern x played on its rhythm. Each layer gets
 *                        a port of its own on the node, as a pattern's instruments do: wiring
 *                        one is a copy, and "main" takes it off the main out
 *   asPattern(state)     (optional) state → a drum/synth pattern ({ bars, stepsPerBar,
 *                        channels }) for the timeline to sketch on its clips
 *   width                (optional) how wide its window opens, in CSS pixels
 *
 * Its window is listed in panels.js (kept apart so the patch's code never pulls in UI): a
 * component given { state, change, cps, position, playing } — draw it however you like,
 * three.js included; it loads the first time someone opens one.
 *
 * Its state lives on the node as `data.state`. To add one: a folder here, a line below and
 * a line in panels.js.
 */
export const ABSTRACTS = Object.fromEntries([cube, fib].map((d) => [d.type, d]))

/** A node's abstract definition, or null. */
export const abstractOf = (type) => ABSTRACTS[type] ?? null

/** A node's state, complete. */
export const abstractState = (node) => abstractOf(node?.type)?.normalize(node?.data?.state) ?? null

/** State → what's saved on the node. */
export const packState = (type, state) => {
  const def = abstractOf(type)
  return def?.pack ? def.pack(state) : state
}

/** Node types for the patch (graph.js folds these into NODE_TYPES). */
export function abstractNodeTypes() {
  return Object.fromEntries(Object.values(ABSTRACTS).map((d) => [d.type, {
    group: 'source',
    label: d.label,
    blurb: d.blurb,
    inputs: d.layers ?? 0,
    params: [],
    abstract: true,
    code: (data) => mainCode(d, data),
  }]))
}

/** What a node's main out plays: everything, less the parts taken off it. */
function mainCode(def, data) {
  const state = def.normalize(data?.state)
  const off = Object.entries(data?.offMain ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  if (!def.parts || !off.length) return def.code(state)
  const exprs = def.parts(state).filter((p) => p.expr && !off.includes(p.id)).map((p) => p.expr)
  if (!exprs.length) return 'silence'
  return exprs.length === 1 ? exprs[0] : `stack(${exprs.join(', ')})`
}

/** A node's separate sounds, or [] (see `parts` above). */
export const abstractParts = (node) => {
  const def = abstractOf(node?.type)
  return def?.parts ? def.parts(def.normalize(node.data?.state)) : []
}

/**
 * A node's layers as code: [{ id, expr, own }] — `own` when it plays its own sound (the song
 * gates those), otherwise it's the input wired into that layer (`inputs`, in `slots`) on the
 * layer's rhythm, which arrives already gated by wherever it came from.
 */
export function abstractBuild(node, inputs = [], slots = []) {
  return abstractParts(node).map((p, i) => {
    const k = slots.indexOf(`in-${i}`)
    // each layer plays an engine (Syrup…) on an instance of its own, so two layers fed the
    // same instrument can go down different paths (instruments/host.js)
    const fed = inputs[k] && `${inputs[k]}.fmap((v) => ({ ...v, _r: '${node.id}.${p.id}' }))`
    if (k >= 0 && fed && p.drive) return { id: p.id, expr: p.drive(fed), own: false }
    return { id: p.id, expr: p.expr, own: true }
  })
}
