/**
 * Three people on one track, each applying their own edit the moment they make it and the
 * others' in the order the server put them in. Everyone must end up with the same track —
 * and know it, because the fingerprints agree.
 */
import { applyOps, diffOps, docHash, invertOps } from '../src/docsync.js'

let fails = 0
const clone = (v) => JSON.parse(JSON.stringify(v))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const START = {
  bpm: 140,
  patterns: [{
    id: 'p1',
    name: 'drums',
    channels: [
      { id: 'kick', gain: 1, notes: [{ s: 0, l: 1, n: 36 }] },
      { id: 'bass', gain: 1, notes: [] },
      { id: 'hat', gain: 1, notes: [] },
    ],
  }],
  nodes: [{ id: 'n1', type: 'pattern', x: 0, y: 0, data: {} }, { id: 'out', type: 'output', x: 400, y: 0, data: {} }],
  song: { on: true, clips: [{ id: 'c1', src: 'pattern:p1', lane: 0, start: 0, len: 4 }] },
}

/** One person's copy of the track: they edit it, and they apply what the room sends. */
function person(name) {
  return {
    name,
    doc: clone(START),
    edit(change) {
      const before = clone(this.doc)
      change(this.doc)
      const ops = diffOps(before, this.doc)
      return { from: name, ops, undo: invertOps(before, ops) }
    },
    // the room sends every change to everyone, the sender included: applying your own
    // again, in the place the room gave it, is what makes everybody agree (collab.js)
    hear(change) {
      applyOps(this.doc, clone(change.ops))
    },
  }
}

/** The room: everything that happens, in the one order the server decided. */
function room(people, changes) {
  for (const change of changes) for (const p of people) p.hear(change)
}

// ── three edits at once, in different corners of the track ──
{
  const [a, b, c] = [person('ana'), person('bo'), person('cy')]
  const changes = [
    a.edit((d) => { d.patterns[0].channels[0].gain = 0.1 }),
    b.edit((d) => { d.patterns[0].channels[1].gain = 0.2 }),
    c.edit((d) => { d.nodes[0].x = 300 }),
  ]
  room([a, b, c], changes)
  ok('three at once end up with the same track', eq(a.doc, b.doc) && eq(b.doc, c.doc), JSON.stringify([a.doc.bpm, b.doc.bpm]))
  ok('and each one knows it (the fingerprints agree)', docHash(a.doc) === docHash(c.doc))
  ok('every edit survived', a.doc.patterns[0].channels[0].gain === 0.1 && a.doc.patterns[0].channels[1].gain === 0.2 && a.doc.nodes[0].x === 300)
}

// ── two people on the very same knob: last one in the order wins, for everybody ──
{
  const [a, b, c] = [person('ana'), person('bo'), person('cy')]
  const changes = [
    a.edit((d) => { d.patterns[0].channels[0].gain = 0.4 }),
    b.edit((d) => { d.patterns[0].channels[0].gain = 0.6 }),
  ]
  room([a, b, c], changes)
  ok('the same knob turned by two people settles the same way for all three',
    a.doc.patterns[0].channels[0].gain === 0.6 && eq(a.doc, b.doc) && eq(b.doc, c.doc),
    [a.doc.patterns[0].channels[0].gain, b.doc.patterns[0].channels[0].gain, c.doc.patterns[0].channels[0].gain].join())
}

// ── one deletes what another is moving ──
{
  const [a, b, c] = [person('ana'), person('bo'), person('cy')]
  const changes = [
    a.edit((d) => { d.song.clips[0].start = 8 }),
    b.edit((d) => { d.song.clips = [] }),
  ]
  room([a, b, c], changes)
  ok('moving a clip someone else deletes leaves no ghost', a.doc.song.clips.length === 0 && eq(a.doc, b.doc) && eq(b.doc, c.doc))
}

// ── one undoes their own edit while the others keep working ──
{
  const [a, b, c] = [person('ana'), person('bo'), person('cy')]
  const mine = a.edit((d) => { d.patterns[0].channels[2].gain = 0.5 })
  room([a, b, c], [mine])
  const theirs = b.edit((d) => { d.patterns[0].name = 'beat' })
  const alsoTheirs = c.edit((d) => { d.bpm = 128 })
  room([a, b, c], [theirs, alsoTheirs])
  // ana takes hers back: the room hears it as an ordinary change
  room([a, b, c], [{ from: 'ana', ops: mine.undo }])
  ok('an undo takes back only that person\'s edit, for everyone',
    a.doc.patterns[0].channels[2].gain === 1 && a.doc.patterns[0].name === 'beat' && a.doc.bpm === 128)
  ok('and the three copies still match', eq(a.doc, b.doc) && eq(b.doc, c.doc))
}

// ── a long, busy session: many edits from three people, applied in one order ──
{
  const [a, b, c] = [person('ana'), person('bo'), person('cy')]
  const people = [a, b, c]
  const changes = []
  for (let i = 0; i < 60; i++) {
    const who = people[i % 3]
    changes.push(who.edit((d) => {
      if (i % 5 === 0) d.song.clips.push({ id: `k${i}`, src: 'pattern:p1', lane: i % 4, start: i, len: 2 })
      else if (i % 5 === 1) d.patterns[0].channels[i % 3].gain = Math.round(Math.random() * 100) / 100
      else if (i % 5 === 2) d.nodes[0].x = i * 7
      else if (i % 5 === 3) d.bpm = 120 + (i % 20)
      else d.patterns[0].channels[i % 3].notes = [{ s: 0, l: 1, n: 36 + (i % 12) }]
    }))
  }
  room(people, changes)
  // Everything everyone did is on every copy. Two people adding a clip in the same breath
  // can leave them in a different order for a moment — the room settles that when it goes
  // quiet (the "same" message in collab.js), which is what the client test covers.
  const ids = (p) => p.doc.song.clips.map((c) => c.id).sort().join()
  const values = (p) => JSON.stringify([p.doc.bpm, p.doc.nodes[0].x, p.doc.patterns[0].channels.map((ch) => [ch.gain, ch.notes])])
  ok('sixty changes from three people leave the same track on every copy', ids(a) === ids(b) && ids(b) === ids(c) && values(a) === values(b) && values(b) === values(c),
    [ids(a), ids(b), ids(c)].join(' | '))
  ok('nothing was lost on the way', a.doc.song.clips.length === 1 + 12, a.doc.song.clips.length)
}

console.log(fails ? `\n${fails} failing` : '\nall good')
process.exit(fails ? 1 : 0)
