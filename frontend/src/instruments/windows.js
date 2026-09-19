/**
 * The windows that are open, as a DAW keeps its plugin windows: each floats on its own,
 * several can be open, and the last one touched sits on top. Opened from an instrument in
 * a pattern or from a node's code (Rack.jsx, Graph.jsx); they stay open wherever you go.
 *
 * An engine's window and a code window are the same kind of thing — a panel belonging to
 * one piece of the track — so they share this list and take their turn in front of each
 * other rather than each having a stack of its own.
 *
 * Windows keep their place in the list (moving one in the page would drop a drag in
 * progress); `z` says which is in front.
 */
let open = [] // [{ id, kind: 'engine' | 'code', …what it's for, z }]
let top = 0
const listeners = new Set()
const changed = (next) => { open = next; for (const fn of listeners) fn() }

/** Open a window, or bring it to the front and update it if it's open already. */
function show(what) {
  top++
  if (open.some((w) => w.id === what.id)) changed(open.map((w) => (w.id === what.id ? { ...w, ...what, z: top } : w)))
  else changed([...open, { ...what, z: top }])
}

/** An instrument engine's window. */
export function openSynth(patternId, channelId) {
  show({ id: channelId, kind: 'engine', patternId, channelId })
}

/**
 * A code window: an instrument written as code, or a code node's text. Both are one piece
 * of the track you write into, which is what an instrument window is.
 */
export function openCode(what) {
  show({ id: what.channelId ? `code:${what.channelId}` : `code:${what.nodeId}:${what.key}`, kind: 'code', ...what })
}

export function closeSynth(id) {
  if (open.some((w) => w.id === id)) changed(open.filter((w) => w.id !== id))
}
export function raiseSynth(id) {
  const w = open.find((x) => x.id === id)
  if (!w || w.z === top) return
  top++
  changed(open.map((x) => (x === w ? { ...x, z: top } : x)))
}

export function subscribeSynths(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export const openSynths = () => open
