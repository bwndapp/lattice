/**
 * Each abstract instrument's window, loaded the first time one opens (so three.js and the
 * like only arrive for someone who uses them). Kept out of index.js: the patch's code
 * imports that, and must never pull in UI.
 */
export const PANELS = {
  cube: () => import('./cube/CubePanel.jsx'),
}
