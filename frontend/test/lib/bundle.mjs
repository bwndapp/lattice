/**
 * The app's modules reach for the browser's audio on their way in. Tests that only need
 * the code they make bundle them first with esbuild (already here for the app's build)
 * against small stand-ins, as solo.test.mjs and knife.test.mjs do.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
export const FRONTEND = path.join(here, '..', '..')

/** Import `exports` ({ module under src/: [names] }) from one bundle. */
export async function bundle(exports, name = 'bundle') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lattice-${name}-`))
  const entry = path.join(dir, 'entry.js')
  const out = path.join(dir, 'bundle.mjs')
  const shim = path.join(dir, 'shim.js')
  fs.writeFileSync(shim, [
    'export const getAudioContext = () => null',
    'export const getSuperdoughAudioController = () => null',
    'export const registerSound = () => {}',
    'export const superdough = () => {}',
    'export const samples = () => {}',
    'export const applyGainCurve = (v) => v',
  ].join('\n'))
  const src = (f) => JSON.stringify(path.join(FRONTEND, 'src', f))
  fs.writeFileSync(entry, Object.entries(exports).map(([f, names]) => `export { ${names.join(', ')} } from ${src(f)}`).join('\n'))
  execFileSync(path.join(FRONTEND, 'node_modules', '.bin', 'esbuild'), [
    entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
    `--alias:@strudel/webaudio=${shim}`, '--main-fields=module,main', '--resolve-extensions=.js,.mjs,.jsx', `--outfile=${out}`,
  ])
  globalThis.window ??= { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: {} }
  const m = await import(pathToFileURL(out))
  fs.rmSync(dir, { recursive: true, force: true })
  return m
}
