/**
 * Soloing a lane is listening, not editing: it changes what this browser plays and leaves
 * the track everyone shares exactly as it was.
 *
 * graph.js reaches for the browser's audio on its way in, so this bundles it first with
 * esbuild (already here for the app's own build) against small stand-ins.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const out = path.join(os.tmpdir(), 'lattice-graph.test.mjs')
const shim = path.join(os.tmpdir(), 'lattice-webaudio-shim.js')
// the browser's audio, which none of this needs to make the code it makes
fs.writeFileSync(shim, [
  'export const getAudioContext = () => null',
  'export const getSuperdoughAudioController = () => null',
  'export const registerSound = () => {}',
  'export const superdough = () => {}',
].join('\n'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'esbuild'), [
  path.join(here, '..', 'src', 'graph.js'),
  '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
  `--alias:@strudel/webaudio=${shim}`,
  `--outfile=${out}`,
])
// enough of a page for the modules that tidy up after themselves when one goes away
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
const { graphCode } = await import(pathToFileURL(out))

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const project = {
  bpm: 120,
  beats: 4,
  patterns: [
    { id: 'p1', name: 'drums', bars: 1, channels: [{ id: 'c1', kind: 'drum', sound: 'bd', steps: '1 0 0 0', mute: false }] },
    { id: 'p2', name: 'bass', bars: 1, channels: [{ id: 'c2', kind: 'drum', sound: 'sd', steps: '0 0 1 0', mute: false }] },
  ],
  nodes: [
    { id: 'a', type: 'pattern', x: 0, y: 0, data: { patternId: 'p1' } },
    { id: 'b', type: 'pattern', x: 0, y: 200, data: { patternId: 'p2' } },
    { id: 'out', type: 'output', x: 400, y: 100, data: { muted: {}, solo: null } },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'out', targetHandle: 'in-0' },
    { id: 'e2', source: 'b', target: 'out', targetHandle: 'in-1' },
  ],
  song: { on: false, clips: [] },
}

const lanesOf = (opts) => graphCode(project, opts).lanes
const plain = lanesOf({})
const soloed = lanesOf({ laneSolo: { out: 'in-0' } })

ok('both lanes play when nothing is soloed', plain.every((l) => !l.startsWith('_')), plain)
ok('soloing one lane silences the other here', soloed.filter((l) => l.startsWith('_')).length === 1, soloed)
ok('the soloed lane is the one still heard', soloed.find((l) => !l.startsWith('_'))?.includes('in0'), soloed)
ok('soloing the other lane silences the first', lanesOf({ laneSolo: { out: 'in-1' } }).find((l) => !l.startsWith('_'))?.includes('in1'))
ok('a solo saved in the track no longer silences anything', lanesOf({}).every((l) => !l.startsWith('_')), 'data.solo is ignored now')

// muting stays the track's own: everyone hears it
const muted = { ...project, nodes: project.nodes.map((n) => (n.id === 'out' ? { ...n, data: { ...n.data, muted: { 'in-1': true } } } : n)) }
ok('a mute in the track silences that lane for everyone', graphCode(muted, {}).lanes.filter((l) => l.startsWith('_')).length === 1)

fs.rmSync(out, { force: true })
console.log(fails ? `\n${fails} failing` : '\nall good')
process.exit(fails ? 1 : 0)
