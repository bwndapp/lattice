/**
 * The effects catalogue, tidied (docs/plans/fx-plugin-plan.md, Phase 0): the add menu files
 * every effect under one category, older duplicates are hidden from the menus but still load
 * and play in saved tracks, and the lists that must agree (FX_UNITS, LANE_FX) still do.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-fxcatalog-'))
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
  `export * from ${src('graph.js')}`,
  `export { LANE_FX_CATALOG } from ${src('instruments/laneFx.js')}`,
].join('\n'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=error',
  `--alias:@strudel/webaudio=${shim}`, '--main-fields=module,main', '--resolve-extensions=.js,.mjs,.jsx', `--outfile=${out}`,
])
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: {} }
const m = await import(pathToFileURL(out))
const { NODE_TYPES } = m

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

// ---- menu grouping
const groupKeys = m.GROUPS.map(([k]) => k)
const catKeys = m.FX_CATS.map(([k]) => k)
ok('the add menu has at most 7 top groups (with instruments and recent)', groupKeys.length + 2 <= 7, groupKeys)
ok('every node type is filed under a menu group', Object.keys(NODE_TYPES).every((t) => groupKeys.includes(m.menuGroup(t))),
  Object.keys(NODE_TYPES).filter((t) => !groupKeys.includes(m.menuGroup(t))))
const effects = Object.keys(NODE_TYPES).filter((t) => m.menuGroup(t) === 'effect')
ok('every effect has a known category', effects.every((t) => catKeys.includes(NODE_TYPES[t].cat)), effects.filter((t) => !catKeys.includes(NODE_TYPES[t].cat)))
ok('only effects have a category', Object.keys(NODE_TYPES).filter((t) => NODE_TYPES[t].cat).every((t) => effects.includes(t)))
ok('the sidechain sits with routing', m.menuGroup('sidechain') === 'combine')
ok('mixing tools are effects in the menu', m.menuGroup('compressor') === 'effect' && m.menuGroup('eq3') === 'effect')
ok('a node keeps its own group (colours and wiring use it)', NODE_TYPES.compressor.group === 'mixing' && NODE_TYPES.sidechain.group === 'effect')
const listed = m.effectsByCat()
ok('effects are listed category by category', listed.every((t, i) => i === 0 || catKeys.indexOf(NODE_TYPES[t].cat) >= catKeys.indexOf(NODE_TYPES[listed[i - 1]].cat)))
ok('the clippers sit next to each other', Math.abs(listed.indexOf('clipper') - listed.indexOf('softclip')) === 1)
ok('every label is lower case', Object.values(NODE_TYPES).every((s) => s.label === s.label.toLowerCase()))
ok('every blurb is one line', Object.values(NODE_TYPES).every((s) => s.blurb && !s.blurb.includes('\n')))

// ---- hidden, older duplicates
const hidden = Object.keys(NODE_TYPES).filter((t) => NODE_TYPES[t].hidden)
ok('space, drive and level are the hidden ones', hidden.sort().join() === 'drive,level,space', hidden)
ok('hidden ones are out of the menu list', hidden.every((t) => !listed.includes(t)))
ok('hidden ones are still found when asked for', hidden.every((t) => m.effectsByCat({ hidden: true }).includes(t)))
ok('hidden ones still go in a rack a saved track has', hidden.every((t) => m.FX_UNITS.includes(t)))
ok('the rack picker leaves hidden ones out', m.effectsByCat({ only: m.FX_UNITS }).every((t) => !NODE_TYPES[t].hidden))
ok('saved lanes can still hold drive and level', ['drive', 'level'].every((t) => m.LANE_FX_CATALOG.types.includes(t)))
const laneMenu = m.LANE_FX_CATALOG.menu.flatMap(([, ts]) => ts)
ok('the lane picker is grouped and leaves hidden ones out', laneMenu.length > 0 && laneMenu.every((t) => m.LANE_FX.includes(t) && !NODE_TYPES[t].hidden))
ok('the lane picker offers every lane effect that is not hidden', m.LANE_FX.filter((t) => !NODE_TYPES[t].hidden).every((t) => laneMenu.includes(t)))

// a saved track with every hidden node still plays through them
const project = {
  bpm: 120,
  beats: 4,
  patterns: [{ id: 'p1', name: 'drums', bars: 1, channels: [{ id: 'c1', kind: 'drum', sound: 'bd', steps: '1 0 0 0', mute: false }] }],
  nodes: [
    { id: 'a', type: 'pattern', x: 0, y: 0, data: { patternId: 'p1' } },
    { id: 'sp', type: 'space', x: 0, y: 0, data: m.defaultData('space') },
    { id: 'dr', type: 'drive', x: 0, y: 0, data: m.defaultData('drive') },
    { id: 'lv', type: 'level', x: 0, y: 0, data: m.defaultData('level') },
    { id: 'out', type: 'output', x: 400, y: 100, data: { muted: {} } },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'sp', targetHandle: 'in' },
    { id: 'e2', source: 'sp', target: 'dr', targetHandle: 'in' },
    { id: 'e3', source: 'dr', target: 'lv', targetHandle: 'in' },
    { id: 'e4', source: 'lv', target: 'out', targetHandle: 'in-0' },
  ],
  song: { on: false, clips: [] },
}
const normal = m.normalizeGraph(project, project.patterns)
ok('a track with hidden nodes keeps them when it loads', ['space', 'drive', 'level'].every((t) => normal.nodes.some((n) => n.type === t)))
const code = m.graphCode(project, {})
const text = code.lines.join('\n')
ok('it still plays through all three', ['// space', '// drive', '// level'].every((c) => text.includes(c)) && code.lanes.length === 1 && /const n_lv = n_dr/.test(text), text)

// ---- the lists that have to agree
ok('every lane effect can sit in a rack', m.LANE_FX.every((t) => m.FX_UNITS.includes(t)))
ok('every rack effect is a node type', m.FX_UNITS.every((t) => NODE_TYPES[t]))
ok('every stereo insert says what it is on the bus (or is the mixer bus)',
  [...m.BUS_NODES].filter((t) => t !== 'reverb' && t !== 'delay').every((t) => t === 'bus' || NODE_TYPES[t].code.insert),
  [...m.BUS_NODES].filter((t) => t !== 'reverb' && t !== 'delay' && t !== 'bus' && !NODE_TYPES[t].code.insert))

// ---- labels and units
const knobs = Object.entries(NODE_TYPES).flatMap(([t, s]) => s.params.filter((p) => p.type === 'knob').map((p) => ({ t, ...p })))
const UNITS = [undefined, 'hz', 'ct', 'st', 'x', 'bar', 's', 'c', 'db', 'ratio', 'bi']
ok('every knob has a unit the knob can show', knobs.every((p) => UNITS.includes(p.unit)), knobs.filter((p) => !UNITS.includes(p.unit)).map((p) => `${p.t}.${p.key}`))
ok('every knob sits in its range, default inside', knobs.every((p) => p.min < p.max && p.def >= p.min && p.def <= p.max))
ok('a wet/dry knob is called mix everywhere', knobs.filter((p) => p.key === 'mix').every((p) => p.label === 'mix'), knobs.filter((p) => p.key === 'mix' && p.label !== 'mix').map((p) => p.t))
ok('nothing is called amount any more where it means mix', !knobs.some((p) => p.label === 'amount'))
ok('every output that stores a gain reads in dB', knobs.filter((p) => p.label === 'output').every((p) => p.fmt === 'gain' || p.unit === 'db'))
ok('semitones, cents and hertz say so', NODE_TYPES.pitch.params[0].unit === 'st' && NODE_TYPES.pitch.params[1].unit === 'ct' && NODE_TYPES.freqshift.params[0].unit === 'hz')
ok('a level fader reads in dB', [m.CHANNEL_FADER, NODE_TYPES.bus.params.find((p) => p.key === 'vol'), NODE_TYPES.level.params.find((p) => p.key === 'gain')].every((p) => p.fmt === 'gain'))

// ---- renamed labels keep the code the same
ok('transient shaper still writes "transient" in the code', NODE_TYPES.punch.label === 'transient shaper' && NODE_TYPES.punch.codeLabel === 'transient')
ok('note echo still writes "echo" in the code', NODE_TYPES.echo.label === 'note echo' && NODE_TYPES.echo.codeLabel === 'echo')

fs.rmSync(dir, { recursive: true, force: true })
console.log(fails ? `\n${fails} failing` : '\nall good')
process.exit(fails ? 1 : 0)
