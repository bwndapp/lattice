import cube from './cube/index.js'

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
export const ABSTRACTS = Object.fromEntries([cube].map((d) => [d.type, d]))

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
    inputs: 0,
    params: [],
    abstract: true,
    code: (data) => d.code(d.normalize(data?.state)),
  }]))
}
