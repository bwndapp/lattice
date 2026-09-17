import { applyOps, diffOps, docHash, keyed } from '../src/docsync.js'

let fails = 0
const clone = (v) => JSON.parse(JSON.stringify(v))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function check(name, before, edit) {
  const after = clone(before)
  edit(after)
  const ops = diffOps(before, after)
  const copy = clone(before)
  applyOps(copy, clone(ops))
  const ok = eq(copy, after) && docHash(copy) === docHash(after)
  if (!ok) {
    fails++
    console.log(`FAIL ${name}\n  ops   ${JSON.stringify(ops)}\n  want  ${JSON.stringify(after)}\n  got   ${JSON.stringify(copy)}`)
  } else {
    console.log(`ok   ${name} (${ops.length} op${ops.length === 1 ? '' : 's'})`)
  }
  return ops
}

const project = {
  bpm: 140,
  beats: 4,
  patterns: [
    { id: 'p1', name: 'drums', bars: 1, channels: [{ id: 'c1', name: 'kick', gain: 0.8, notes: [{ s: 0, l: 1, n: 36 }] }] },
    { id: 'p2', name: 'bass', bars: 2, channels: [] },
  ],
  nodes: [
    { id: 'n1', type: 'pattern', x: 40, y: 40, data: { patternId: 'p1' } },
    { id: 'out', type: 'output', x: 520, y: 40, data: { muted: {} } },
  ],
  edges: [{ id: 'e_n1_out_in0', source: 'n1', target: 'out', targetHandle: 'in-0' }],
  song: { on: true, clips: [{ id: 'k1', src: 'pattern:p1', lane: 0, start: 0, len: 4 }], lanes: [] },
}

check('a knob turn is one op', project, (p) => { p.patterns[0].channels[0].gain = 0.5 })
check('a node moves', project, (p) => { p.nodes[0].x = 120; p.nodes[0].y = 90 })
check('a clip is added', project, (p) => { p.song.clips.push({ id: 'k2', src: 'pattern:p2', lane: 1, start: 4, len: 4 }) })
check('a clip is deleted', project, (p) => { p.song.clips = [] })
check('notes are replaced whole', project, (p) => { p.patterns[0].channels[0].notes = [{ s: 0, l: 0.5, n: 38 }] })
check('a pattern is renamed', project, (p) => { p.patterns[1].name = 'sub' })
check('a node is deleted with its wire', project, (p) => { p.nodes.splice(0, 1); p.edges = [] })
check('a rack is reordered', project, (p) => { p.nodes.reverse() })
check('a key disappears', project, (p) => { delete p.song.lanes })
check('everything at once', project, (p) => {
  p.bpm = 128
  p.patterns[0].channels.push({ id: 'c2', name: 'snare', gain: 1, notes: [] })
  p.song.clips[0].len = 8
  p.nodes[1].data.muted = { 'in-0': true }
})

// the op for one knob must not mention anything else
const knob = diffOps(project, (() => { const p = clone(project); p.patterns[0].channels[0].gain = 0.5; return p })())
if (!(knob.length === 1 && knob[0].op === 'set' && eq(knob[0].path, ['patterns', { id: 'p1' }, 'channels', { id: 'c1' }, 'gain']))) {
  fails++
  console.log('FAIL knob op is not addressed by id:', JSON.stringify(knob))
} else console.log('ok   a knob op is addressed by id, not by index')

// two people, two edits, either order: both end up with both changes
const a = clone(project); a.patterns[0].channels[0].gain = 0.3
const b = clone(project); b.nodes[0].x = 400
const opsA = diffOps(project, a)
const opsB = diffOps(project, b)
const ab = clone(project); applyOps(ab, clone(opsA)); applyOps(ab, clone(opsB))
const ba = clone(project); applyOps(ba, clone(opsB)); applyOps(ba, clone(opsA))
if (!eq(ab, ba) || ab.patterns[0].channels[0].gain !== 0.3 || ab.nodes[0].x !== 400) {
  fails++
  console.log('FAIL concurrent edits do not converge', JSON.stringify(ab), JSON.stringify(ba))
} else console.log('ok   two people editing different things converge, either order')

// an op for something already deleted is skipped, not thrown
const gone = clone(project)
gone.song.clips = []
const late = [{ op: 'set', path: ['song', 'clips', { id: 'k1' }, 'len'], value: 2 }, { op: 'set', path: ['bpm'], value: 90 }]
const landed = applyOps(gone, late)
if (landed !== 1 || gone.bpm !== 90) { fails++; console.log('FAIL late op handling', landed, gone.bpm) }
else console.log('ok   an op for something deleted is skipped, the rest still lands')

// inserting the same clip twice (a resend) changes nothing
const twice = clone(project)
const ins = [{ op: 'ins', path: ['song', 'clips'], at: 1, value: { id: 'k9', src: 'pattern:p2', lane: 2, start: 0, len: 1 } }]
applyOps(twice, clone(ins))
applyOps(twice, clone(ins))
if (twice.song.clips.length !== 2) { fails++; console.log('FAIL a repeated insert duplicated', twice.song.clips.length) }
else console.log('ok   a repeated insert lands once')

// the whole document is never replaced by an op
const guard = clone(project)
applyOps(guard, [{ op: 'set', path: [], value: {} }])
if (!eq(guard, project)) { fails++; console.log('FAIL an op replaced the whole document') }
else console.log('ok   an op can never replace the whole document')

if (!keyed([{ id: 'a' }, { id: 'a' }]) && !keyed([{ s: 0 }]) && keyed([{ id: 'a' }, { id: 'b' }])) console.log('ok   keyed() knows which arrays have ids')
else { fails++; console.log('FAIL keyed()') }

console.log(fails ? `\n${fails} failing` : '\nall good')
process.exit(fails ? 1 : 0)
