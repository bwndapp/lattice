/**
 * Moving an instrument between patterns: it leaves its pattern (and every variation of it),
 * lands in the other, and its wire, triggers, "off the main" and bus level go with it. Into a
 * new pattern it plays where it played before: wired where the old pattern went, and on the
 * timeline where the old pattern's clips were.
 */
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'

const m = await bundle({ 'project.js': ['normalizeProject', 'moveChannel', 'generateCode'] }, 'move')
const base = () => m.normalizeProject({
  bpm: 120, beats: 4,
  patterns: [
    { id: 'A', name: 'drums', bars: 1, stepsPerBar: 16, channels: [
      { id: 'k', kind: 'drum', name: 'kick', sound: 'bd', steps: [1, 0, 0, 0] },
      { id: 'h', kind: 'drum', name: 'hat', sound: 'hh', steps: [0, 0, 1, 0] },
    ] },
    { id: 'A2', name: 'drums 2', parent: 'A', bars: 1, stepsPerBar: 16, channels: [
      { id: 'k2', kind: 'drum', name: 'kick', sound: 'bd', steps: [1, 1, 0, 0] },
      { id: 'h2', kind: 'drum', name: 'hat', sound: 'hh', steps: [1, 0, 1, 0] },
    ] },
    { id: 'B', name: 'bass', bars: 1, stepsPerBar: 16, channels: [{ id: 'b', kind: 'synth', name: 'bass', sound: 'sawtooth', note: 'c2' }] },
  ],
  nodes: [
    { id: 'pa', type: 'pattern', x: 0, y: 0, data: { patternId: 'A', offMain: { h: true } } },
    { id: 'pb', type: 'pattern', x: 0, y: 300, data: { patternId: 'B' } },
    { id: 'g', type: 'groove', x: -300, y: 0, data: {} },
    { id: 'fx', type: 'reverb', x: 300, y: 0, data: {} },
    { id: 'mix', type: 'bus', x: 500, y: 0, data: { name: 'mix', chan: { 'pa:out-h': 0.5 } } },
    { id: 'o', type: 'output', x: 700, y: 0, data: {} },
  ],
  edges: [
    { source: 'pa', target: 'mix', targetHandle: 'in-0' },
    { source: 'pa', sourceHandle: 'out-h', target: 'mix', targetHandle: 'in-1' },
    { source: 'pb', target: 'o', targetHandle: 'in-1' },
    { source: 'g', sourceHandle: 'trig-g2', target: 'pa', targetHandle: 'trig-h' },
    { source: 'mix', target: 'o', targetHandle: 'in-0' },
  ],
  song: { on: true, fired: true, clips: [{ id: 'c1', src: 'pattern:A', lane: 0, start: 0, len: 4 }, { id: 'c2', src: 'pattern:A2', lane: 0, start: 4, len: 4 }, { id: 'c3', src: 'pattern:B', lane: 1, start: 0, len: 8 }] },
})

// into a new pattern of its own
{
  const p = base()
  const to = m.moveChannel(p, 'A', 'h', null)
  const tgt = p.patterns.find((x) => x.id === to)
  assert.deepEqual(tgt.channels.map((c) => c.id), ['h'], 'the hat is in a new pattern, keeping its id')
  assert.deepEqual(p.patterns.find((x) => x.id === 'A').channels.map((c) => c.id), ['k'], 'and gone from the old one')
  assert.deepEqual(p.patterns.find((x) => x.id === 'A2').channels.map((c) => c.id), ['k2'], 'and from its variation, so they stay matched')
  const node = p.nodes.find((n) => n.type === 'pattern' && n.data.patternId === to)
  assert.ok(node, 'the new pattern has a node in the patch')
  assert.ok(p.edges.some((e) => e.source === node.id && e.sourceHandle === 'out-h' && e.target === 'mix'), 'its own wire goes with it')
  assert.ok(p.edges.some((e) => e.source === 'g' && e.target === node.id && e.targetHandle === 'trig-h'), 'and so does the groove box firing it')
  assert.equal(node.data.offMain?.h, true, 'it stays off the main')
  assert.ok(!p.nodes.find((n) => n.id === 'pa').data.offMain, 'which the old node forgets')
  assert.equal(p.nodes.find((n) => n.id === 'mix').data.chan[`${node.id}:out-h`], 0.5, 'the bus keeps its level for that wire')
  assert.ok(!p.edges.some((e) => e.source === node.id && e.sourceHandle === 'out'), 'it only left by its own wire, so its main isn\'t wired')
  const clips = p.song.clips.filter((c) => c.src === `pattern:${to}`)
  assert.deepEqual(clips.map((c) => [c.start, c.len]), [[0, 4], [4, 4]], 'it plays where the old pattern\'s clips (and its variation\'s) were')
  assert.doesNotThrow(() => m.generateCode(p), 'and the track still makes code')
}
// into a new pattern, an instrument that played out the main: the new node goes where the old one went
{
  const p = base()
  const to = m.moveChannel(p, 'A', 'k', null)
  const node = p.nodes.find((n) => n.type === 'pattern' && n.data.patternId === to)
  const wire = p.edges.find((e) => e.source === node.id && (e.sourceHandle ?? 'out') === 'out')
  assert.equal(wire?.target, 'mix', 'its main out goes to the mixer, as the old pattern\'s did')
  assert.equal(wire.targetHandle, 'in-2', 'on a slot of its own')
}
// into a pattern that's already there
{
  const p = base()
  m.moveChannel(p, 'A', 'h', 'B')
  assert.deepEqual(p.patterns.find((x) => x.id === 'B').channels.map((c) => c.id), ['b', 'h'], 'the hat joins the bass pattern')
  assert.ok(p.edges.some((e) => e.source === 'pb' && e.sourceHandle === 'out-h' && e.target === 'mix'), 'its wire now leaves the bass pattern\'s node')
  assert.ok(p.edges.some((e) => e.source === 'g' && e.target === 'pb' && e.targetHandle === 'trig-h'), 'and the groove box fires it there')
  assert.equal(p.patterns.length, 3, 'no new pattern')
  assert.ok(!p.song.clips.some((c) => c.lane > 1), 'and no new clips: it plays in the bass pattern\'s')
}
// from a variation's rack: the whole instrument moves, by its original's id
{
  const p = base()
  m.moveChannel(p, 'A2', 'h2', 'B')
  assert.deepEqual(p.patterns.find((x) => x.id === 'A').channels.map((c) => c.id), ['k'], 'moved from a variation, it leaves the original too')
  const h = p.patterns.find((x) => x.id === 'B').channels.find((c) => c.id === 'h')
  assert.deepEqual(h?.steps?.slice(0, 4), [1, 0, 1, 0], 'with the steps you were looking at')
}
console.log('move ok')
