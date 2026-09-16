/**
 * The engine windows that are open, as a DAW keeps its plugin windows: each floats on its
 * own, several can be open, and the last one touched sits on top. Opened from an
 * instrument in a pattern (Rack.jsx); they stay open wherever you go in the app.
 *
 * Windows keep their place in the list (moving one in the page would drop a drag in
 * progress); `z` says which is in front.
 */
let open = [] // [{ patternId, channelId, z }]
let top = 0
const listeners = new Set()
const changed = (next) => { open = next; for (const fn of listeners) fn() }

/** Open an instrument's window, or bring it to the front if it's open already. */
export function openSynth(patternId, channelId) {
  top++
  if (open.some((w) => w.channelId === channelId)) changed(open.map((w) => (w.channelId === channelId ? { ...w, patternId, z: top } : w)))
  else changed([...open, { patternId, channelId, z: top }])
}
export function closeSynth(channelId) {
  if (open.some((w) => w.channelId === channelId)) changed(open.filter((w) => w.channelId !== channelId))
}
export function raiseSynth(channelId) {
  const w = open.find((x) => x.channelId === channelId)
  if (!w || w.z === top) return
  top++
  changed(open.map((x) => (x === w ? { ...x, z: top } : x)))
}

export function subscribeSynths(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export const openSynths = () => open
