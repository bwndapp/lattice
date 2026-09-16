/**
 * The colour a part is drawn in, the same everywhere it shows up: its clips on the
 * timeline, and its node on the patch. Picked by hand per part (kept in song.colors) or
 * taken from its id, so a part has a colour before anyone chooses one.
 */

export const COLORS = ['#e4ff1a', '#f2f0e6', '#b9c96a', '#ffb347', '#86d8cc', '#c8a2ff', '#ff8fa3', '#9fb4ff']
export const PICKS = [...COLORS, '#ff6b3d', '#ffd23f', '#7dff9a', '#5ad1ff', '#4d7cff', '#b06bff', '#ff4fd8', '#8a8a80']

/** A part's colour: the one picked for it, or one from its id. */
export function colorFor(src, colors) {
  if (colors?.[src]) return colors[src]
  let h = 0
  for (const ch of src) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

/** Dark text on light clip colours, light text on dark ones. */
export function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16)
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  return lum > 0.55 ? '#0a0a09' : '#f2f0e6'
}

/** What a node is called on the timeline: its pattern, or the node itself. */
export function nodeSrc(node, project) {
  if (node?.type !== 'pattern') return `node:${node?.id}`
  // a variation plays through its original's node, so they share the original's colour
  const pattern = project.patterns.find((p) => p.id === node.data.patternId)
  return `pattern:${pattern?.parent ?? node.data.patternId}`
}
