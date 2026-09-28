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
  `export * from ${src('frames.js')}`,
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

// ── collapsing ──
// a frame round a, b and d (a feeds b inside it), with c outside feeding d, and b and d feeding out
const wired = m.normalizeProject({
  ...base,
  nodes: [
    { id: 'a', type: 'pattern', x: 0, y: 0, data: { patternId: 'p1' } },
    { id: 'b', type: 'filter', x: 300, y: 0, data: {} },
    { id: 'c', type: 'pattern', x: 0, y: 600, data: { patternId: 'p1' } },
    { id: 'd', type: 'filter', x: 300, y: 100, data: {} },
    { id: 'out', type: 'output', x: 900, y: 0, data: { muted: {}, solo: null } },
  ],
  edges: [
    { source: 'a', target: 'b', targetHandle: 'in' },
    { source: 'c', target: 'd', targetHandle: 'in' },
    { source: 'b', target: 'out', targetHandle: 'in-0' },
    { source: 'd', target: 'out', targetHandle: 'in-1' },
  ],
  frames: [{ id: 'fr', x: -30, y: -60, w: 620, h: 260, title: 'lead', color: 'plum' }],
})
const heard = JSON.stringify(m.graphCode(wired, {}))
const nodesBefore = JSON.stringify(wired.nodes)
const edgesBefore = JSON.stringify(wired.edges)
const shut = JSON.parse(JSON.stringify(wired))
m.collapseFrame(shut, 'fr', m.frameItems(shut))
const fr = shut.frames[0]
ok('collapsing keeps what it holds', fr.collapsed === true && JSON.stringify([...fr.members].sort()) === '["a","b","d"]', JSON.stringify(fr))
ok('and keeps its full size for opening again', fr.w === 620 && fr.h === 260)
ok('collapsing changes no nodes or wires', JSON.stringify(shut.nodes) === nodesBefore && JSON.stringify(shut.edges) === edgesBefore)
ok('and the patch plays exactly the same', JSON.stringify(m.graphCode(shut, {})) === heard)

const hosts = m.collapsedHosts(shut.frames)
ok('its nodes are hidden, the rest are not', hosts.get('a') === 'fr' && hosts.get('b') === 'fr' && hosts.get('d') === 'fr' && !hosts.has('c') && !hosts.has('out'))
ok('nothing hidden in a view with no frames collapsed', m.collapsedHosts(wired.frames).size === 0)
ok('hidden nodes are hidden on the canvas', m.frameItems(shut).filter((n) => n.hidden).map((n) => n.id).sort().join() === 'a,b,d')
const route = (s, t) => m.routeEdge(shut.edges.find((e) => e.source === s && e.target === t), hosts)
ok('a wire inside the frame is hidden', route('a', 'b')?.hidden === true)
ok('a wire in arrives at its left edge', route('c', 'd')?.target === 'fr' && route('c', 'd').targetHandle === 'frame-in' && route('c', 'd').source === 'c')
ok('a wire out leaves from its right edge', route('b', 'out')?.source === 'fr' && route('b', 'out').sourceHandle === 'frame-out' && route('b', 'out').targetHandle === 'in-0')
ok('wires with nothing hidden are left alone', m.routeEdge({ source: 'c', target: 'out' }, hosts) === null)

// membership is frozen: the collapsed frame (just its bar) no longer covers b, yet holds it;
// a node dropped where the frame's box was isn't taken in
const moved = JSON.parse(JSON.stringify(shut))
moved.nodes.find((n) => n.id === 'c').y = 0
moved.nodes.find((n) => n.id === 'c').x = 150
const held = m.heldBy(moved.frames[0], m.frameItems(moved), moved.frames)
ok('a collapsed frame holds what it held, not what lies under its box', held.has('a') && held.has('b') && !held.has('c'))
ok('an open frame goes by position', m.heldBy(wired.frames[0], m.frameItems(wired), wired.frames).size === 3)

const open = JSON.parse(JSON.stringify(shut))
m.expandFrame(open, 'fr')
ok('opening forgets the members and shows everything', !open.frames[0].collapsed && !('members' in open.frames[0]) && m.collapsedHosts(open.frames).size === 0)
ok('opening is back where it started', JSON.stringify(open) === JSON.stringify(wired))

// deleting a collapsed frame never takes its nodes
const gone = JSON.parse(JSON.stringify(shut))
m.removeFrame(gone, 'fr')
ok('removing a collapsed frame keeps every node and wire', gone.frames.length === 0 && JSON.stringify(gone.nodes) === nodesBefore && JSON.stringify(gone.edges) === edgesBefore)
ok('and nothing stays hidden', m.collapsedHosts(gone.frames).size === 0)

// saving, loading, history
const back = m.parseProject(m.generateCode(shut, {}))
ok('collapsed survives saving and loading', JSON.stringify(back?.frames) === JSON.stringify(shut.frames), JSON.stringify(back?.frames))
ok('an open frame loads without the flag', !('collapsed' in m.parseProject(m.generateCode(wired, {})).frames[0]))
const stale = m.normalizeProject({ ...shut, frames: [{ ...fr, members: ['a', 'nope', 7, 'fr'] }, { id: 'f2', x: 0, y: 0, collapsed: 'yes', members: ['a'] }] })
ok('members are tidied to what exists', JSON.stringify(stale.frames[0].members) === '["a"]')
ok('only a real true collapses', !('collapsed' in stale.frames[1]) && !('members' in stale.frames[1]))
ok('history names collapsing and opening', m.changesBetween(wired, shut).includes('collapsed the lead frame') && m.changesBetween(shut, wired).includes('opened the lead frame'))

// copy and paste a collapsed frame: its members come along, and it stays collapsed
const clip2 = m.copyNodes(shut, [...m.heldBy(fr, m.frameItems(shut), shut.frames)], [fr])
ok('copying a collapsed frame copies its members', clip2.nodes.map((n) => n.id).sort().join() === 'a,b,d' && clip2.frames[0].collapsed)
const q = JSON.parse(JSON.stringify(shut))
const newIds = m.pasteNodes(q, clip2, { x: 2000, y: 2000 })
const copy = q.frames.find((f) => f.id !== 'fr')
ok('the pasted frame stays collapsed, holding the pasted nodes', copy.collapsed && JSON.stringify([...copy.members].sort()) === JSON.stringify([...newIds].sort()))
ok('and those are hidden too', newIds.every((id) => m.collapsedHosts(q.frames).get(id) === copy.id))
ok('the pasted copy survives saving', JSON.stringify(m.parseProject(m.generateCode(q, {})).frames) === JSON.stringify(q.frames))

// a collapsed frame inside another collapsed frame shows as the outer one
const nest = JSON.parse(JSON.stringify(wired))
nest.frames.push({ id: 'big', x: -100, y: -200, w: 1200, h: 1200, title: 'all', color: 'stone' })
m.collapseFrame(nest, 'fr', m.frameItems(nest))
m.collapseFrame(nest, 'big', m.frameItems(nest))
const nh = m.collapsedHosts(nest.frames)
ok('nested: everything shows as the outer frame', nh.get('a') === 'big' && nh.get('fr') === 'big' && nh.get('c') === 'big')
m.expandFrame(nest, 'big')
ok('nested: opening the outer leaves the inner collapsed', m.collapsedHosts(nest.frames).get('a') === 'fr' && !m.collapsedHosts(nest.frames).has('c'))

console.log(fails ? `\n${fails} failed` : '\nall good')
process.exit(fails ? 1 : 0)
