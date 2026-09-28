/**
 * The vowel effect: a vowel node, on its own or in an fx rack, puts its sound on a bus of
 * its own and asks that bus for a formant filter set to the vowel picked (stereo.js), so
 * switching vowels changes what it says. Anything that isn't a vowel falls back to 'a'.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-vowel-'))
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
  `export { normalizeProject, generateCode } from ${src('project.js')}`,
  `export { NODE_TYPES, defaultData, laneFxParams } from ${src('graph.js')}`,
].join('\n'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
  `--alias:@strudel/webaudio=${shim}`, '--main-fields=module,main', '--resolve-extensions=.js,.mjs,.jsx', `--outfile=${out}`,
])
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: {} }
const m = await import(pathToFileURL(out))
fs.rmSync(dir, { recursive: true, force: true })

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

/** Run a node's code the way graph.js does, keeping what it declares for the bus. */
const run = (type, data, key = 'v') => {
  const declared = []
  const ctx = { route: { orbit: null }, nodeId: key, stereoOrbit: () => 40, declare: (orbit, k, kind, params) => declared.push({ orbit, key: k, kind, params }) }
  const code = m.NODE_TYPES[type].code(data, ['x'], ctx)
  return { code, declared }
}

for (const v of ['a', 'e', 'i', 'o', 'u']) {
  const { code, declared } = run('vowel', { vowel: v })
  ok(`vowel ${v}: the sound goes onto its own bus`, code === 'x.orbit(40)', code)
  ok(`vowel ${v}: that bus gets a formant filter saying ${v}`,
    declared.length === 1 && declared[0].orbit === 40 && declared[0].kind === 'vowel' && declared[0].params.vowel === v, JSON.stringify(declared))
}
ok('a new vowel node says a', run('vowel', m.defaultData('vowel')).declared[0]?.params.vowel === 'a')
ok('a number is not a vowel: it falls back to a', run('vowel', { vowel: 0.5 }).declared[0]?.params.vowel === 'a')
ok('a lane effect gets the vowel too', m.laneFxParams('vowel', { vowel: 'o' }).vowel === 'o')

// in an fx rack, after a filter: both on the same bus, in order
const rack = run('fxrack', { chain: [
  { id: 'f', type: 'filter', on: true, data: m.defaultData('filter') },
  { id: 'w', type: 'vowel', on: true, data: { vowel: 'u' } },
] }, 'r')
ok('in a rack the vowel follows the filter on one bus', rack.declared.map((d) => `${d.orbit}:${d.kind}`).join(' ') === '40:filter 40:vowel', JSON.stringify(rack.declared))
ok('in a rack the vowel keeps its setting', rack.declared[1]?.params.vowel === 'u' && rack.declared[1]?.key === 'r_w')

// the whole patch: pattern → vowel → output plays on the vowel's bus, and switching the vowel changes the track
const patch = (vowel) => m.normalizeProject({
  bpm: 120, beats: 4, song: { on: false, clips: [] },
  patterns: [{ id: 'p1', name: 'p1', bars: 1, channels: [{ id: 'c1', kind: 'drum', sound: 'bd', steps: '1 0 0 0', mute: false }] }],
  nodes: [
    { id: 'a', type: 'pattern', x: 0, y: 0, data: { patternId: 'p1' } },
    { id: 'v', type: 'vowel', x: 0, y: 0, data: { vowel } },
    { id: 'out', type: 'output', x: 0, y: 0, data: { muted: {} } },
  ],
  edges: [{ id: 'e1', source: 'a', target: 'v', targetHandle: 'in' }, { id: 'e2', source: 'v', target: 'out', targetHandle: 'in-0' }],
})
const code = m.generateCode(patch('o'))
ok('the patch keeps the vowel picked', patch('o').nodes.find((n) => n.id === 'v').data.vowel === 'o')
ok('the vowel node is in the signal path, on a bus of its own', /const n_v = n_a\.orbit\(\d+\)/.test(code) && /out_in0: n_v/.test(code), code.split('\n').slice(-6).join(' | '))
ok('switching the vowel changes the track', m.generateCode(patch('a')) !== code)

console.log(fails ? `\n${fails} failing` : '\nall good')
process.exit(fails ? 1 : 0)
