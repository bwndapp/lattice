/**
 * Frames are only looks: they're kept with the track, copied with the nodes they hold,
 * and never change what the patch plays. A track from before frames loads as it was.
 *
 * Bundled with esbuild first, as solo.test.mjs does, since graph.js reaches for the
 * browser's audio on its way in.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-frames-'))
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
const src = (f) => JSON.stringify(path.join(here, '..', 'src', f))
fs.writeFileSync(entry, [
  `export { normalizeProject, generateCode, parseProject } from ${src('project.js')}`,
  `export { copyNodes, pasteNodes } from ${src('nodeClipboard.js')}`,
  `export { graphCode } from ${src('graph.js')}`,
  `export { changesBetween } from ${src('history.js')}`,
].join('\n'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
  `--alias:@strudel/webaudio=${shim}`, '--main-fields=module,main', '--resolve-extensions=.js,.mjs,.jsx', `--outfile=${out}`,
])
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: {} }
const m = await import(pathToFileURL(out))

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const base = {
  v: 3, bpm: 120, beats: 4,
  patterns: [{ id: 'p1', name: 'drums', bars: 1, channels: [{ id: 'c1', kind: 'drum', sound: 'bd', steps: '1 0 0 0' }] }],
  nodes: [
    { id: 'a', type: 'pattern', x: 0, y: 0, data: { patternId: 'p1' } },
    { id: 'out', type: 'output', x: 400, y: 0, data: { muted: {}, solo: null } },
  ],
  edges: [{ source: 'a', target: 'out', targetHandle: 'in-0' }],
}
const old = m.normalizeProject(base)
ok('an older track has no frames added', !('frames' in old))

const framed = m.normalizeProject({ ...base, frames: [{ id: 'frame1', x: -30, y: -60, w: 320, h: 200, title: 'drums', color: 'moss' }] })
ok('a frame is kept', framed.frames?.length === 1 && framed.frames[0].title === 'drums' && framed.frames[0].color === 'moss')
ok('and survives saving and loading', JSON.stringify(m.parseProject(m.generateCode(framed, {}))?.frames) === JSON.stringify(framed.frames))
ok('the patch plays the same with or without it', JSON.stringify(m.graphCode(framed, {})) === JSON.stringify(m.graphCode(old, {})))

const junk = m.normalizeProject({ ...base, frames: [{ id: 'f', x: 'nope', color: 'NOT A COLOUR' }, null, { x: 1 }] })
ok('a broken frame is tidied, not trusted', junk.frames.length === 1 && junk.frames[0].x === 0 && junk.frames[0].color === 'stone')

const clip = m.copyNodes(framed, ['a'], framed.frames)
ok('copying carries the frame', clip.frames?.length === 1 && clip.frames[0].x === -30)
const p = JSON.parse(JSON.stringify(framed))
m.pasteNodes(p, clip, { x: 1000, y: 1000 })
const pasted = p.frames.find((f) => f.id !== 'frame1')
ok('pasting brings a new frame, offset with its nodes', pasted && pasted.x === 970 && pasted.y === 1000 - 60 && pasted.title === 'drums')
ok('an old clipboard without frames still pastes', (() => { const q = JSON.parse(JSON.stringify(old)); m.pasteNodes(q, { ...clip, frames: undefined }, { x: 0, y: 0 }); return !q.frames })())

ok('history names it', m.changesBetween(old, framed).some((s) => s.includes('framed drums')))

console.log(fails ? `\n${fails} failed` : '\nall good')
process.exit(fails ? 1 : 0)
