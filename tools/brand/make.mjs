/*
 * The share card and the icons, drawn from the app's own palette.
 *
 *   node tools/brand/make.mjs
 *
 * Run it after the theme changes: everything here reads the same values index.css does, so
 * the card can't drift away from the app it's advertising. Needs @resvg/resvg-js and the
 * two typefaces (see FONTS below); both are dev-only and neither ships in the bundle.
 */
import { createRequire } from 'node:module'
const require_ = createRequire('/incubators/incu-strudel/frontend/package.json')
const { Resvg } = require_('@resvg/resvg-js')
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const FONTS = process.env.BRAND_FONTS ?? '/tmp/claude-0/-incubators-incu-strudel/efca21d8-03e8-409b-9e34-e6a9c7af1158/scratchpad/fonts'

// the palette, as index.css has it
const C = {
  shell: '#232327', panel: '#2b2b30', raised: '#35353b', sunk: '#1c1c20',
  canvas: '#141417', well: '#0f0f12', line: '#3a3a41',
  paper: '#e9e9e7', muted: '#9b9ba1', dim: '#6d6d74',
  acid: '#e0a33c', ink: '#141410',
}

/** The mark: two struts crossing, the top one passing over. */
const mark = (x, y, s, colour = C.acid) => `
  <g transform="translate(${x} ${y}) scale(${s / 64})" stroke-linecap="square">
    <path d="M14 26 38 50M26 14 50 38" stroke="${colour}" stroke-width="7"/>
    <path d="M14 38 38 14M26 50 50 26" stroke="${C.canvas}" stroke-width="13"/>
    <path d="M14 38 38 14M26 50 50 26" stroke="${colour}" stroke-width="7"/>
  </g>`

/** A node card, as one looks on the patch. */
const node = (x, y, w, label, { lit = false, h = 54 } = {}) => `
  <g transform="translate(${x} ${y})">
    <rect width="${w}" height="${h}" rx="6" fill="${C.panel}" stroke="${lit ? C.acid : C.line}" stroke-width="${lit ? 2 : 1.5}"/>
    <rect x="1" y="1" width="${w - 2}" height="17" rx="5" fill="${C.raised}"/>
    <text x="9" y="14" font-family="Martian Mono" font-size="10" fill="${lit ? C.acid : C.muted}">${label}</text>
    <rect x="9" y="27" width="${w - 42}" height="5" rx="2.5" fill="${C.sunk}"/>
    <rect x="9" y="27" width="${Math.round((w - 42) * (lit ? 0.72 : 0.38))}" height="5" rx="2.5" fill="${lit ? C.acid : C.dim}"/>
    <circle cx="${w - 16}" cy="38" r="7" fill="${C.sunk}" stroke="${C.line}"/>
    <path d="M${w - 16} 33 v5" stroke="${lit ? C.acid : C.muted}" stroke-width="2" stroke-linecap="round"/>
  </g>`

const wire = (x1, y1, x2, y2, lit = false) => {
  const mid = (x1 + x2) / 2
  return `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" fill="none"
    stroke="${lit ? C.acid : C.line}" stroke-width="${lit ? 2.5 : 2}" opacity="${lit ? 0.95 : 0.8}"/>`
}

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24 0H0v24" fill="none" stroke="${C.shell}" stroke-width="1"/>
    </pattern>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.canvas}" stop-opacity="0"/>
      <stop offset="1" stop-color="${C.canvas}" stop-opacity="0.85"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="${C.canvas}"/>
  <rect width="1200" height="630" fill="url(#grid)" opacity="0.55"/>

  <!-- the patch: three sounds through their effects into the output, one of them playing -->
  <g transform="translate(70 250)">
    ${wire(196, 27, 300, 27)}
    ${wire(196, 117, 300, 117, true)}
    ${wire(196, 207, 300, 207)}
    ${wire(496, 27, 620, 105)}
    ${wire(496, 117, 620, 117, true)}
    ${wire(496, 207, 620, 129)}
    ${node(0, 0, 196, 'pattern · drums')}
    ${node(0, 90, 196, 'pattern · bass', { lit: true })}
    ${node(0, 180, 196, 'pattern · keys')}
    ${node(300, 0, 196, 'filter')}
    ${node(300, 90, 196, 'distortion', { lit: true })}
    ${node(300, 180, 196, 'reverb')}
    ${node(620, 90, 150, 'output', { lit: true })}
  </g>

  <rect width="1200" height="630" fill="url(#fade)"/>

  <!-- the name, top left, the way the bar wears it -->
  ${mark(70, 64, 52)}
  <text x="136" y="112" font-family="Archivo Black" font-size="82" letter-spacing="-3" fill="${C.paper}">lattice</text>
  <text x="74" y="168" font-family="Martian Mono" font-size="23" fill="${C.muted}">patch music together, in the browser</text>
  <text x="74" y="206" font-family="Martian Mono" font-size="15" fill="${C.dim}">nodes · timeline · piano roll · your own effects — built on Strudel</text>

  <text x="1130" y="586" text-anchor="end" font-family="Martian Mono" font-size="16" fill="${C.muted}">lattice.bwnd.app</text>
</svg>`

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="${C.canvas}"/>
  ${mark(0, 0, 64)}
</svg>`

const render = (svg, width) => new Resvg(svg, {
  fitTo: { mode: 'width', value: width },
  font: { fontDirs: [FONTS], loadSystemFonts: false, defaultFontFamily: 'Martian Mono' },
}).render().asPng()

writeFileSync(resolve(root, 'frontend/static/og.png'), render(og, 1200))
writeFileSync(resolve(root, 'frontend/static/icon.svg'), icon)
writeFileSync(resolve(root, 'frontend/static/apple-touch-icon.png'), render(icon, 180))
console.log('og.png, icon.svg, apple-touch-icon.png written to frontend/static')
