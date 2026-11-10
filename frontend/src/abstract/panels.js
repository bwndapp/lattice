import { createElement } from 'react'
import CubePanel from './cube/CubePanel.jsx'
import FibPanel from './fib/FibPanel.jsx'

/**
 * Each abstract instrument's window. Kept out of index.js: the patch's code imports that,
 * and must never pull in UI.
 *
 * The panels are in the main bundle; three.js isn't. The build ships it beside the app as
 * files of its own (vite.config.js) and the cube loads it the first time one is opened, so
 * nobody else downloads it. (In dev, Vite serves it as usual.)
 */
const loadThree = () => (import.meta.env.DEV
  ? import('three')
  : import(/* @vite-ignore */ new URL(`three-${import.meta.env.VITE_THREE_VERSION}/three.module.min.js`, document.baseURI).href))

export const PANELS = {
  cube: () => loadThree().then((THREE) => ({ default: (props) => createElement(CubePanel, { ...props, THREE }) })),
  fib: async () => ({ default: FibPanel }),
}
