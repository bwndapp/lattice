/**
 * The automation editor's point editing (automation.js): adding, removing and moving
 * points keeps them sorted and inside the automation, and the curve reads them as before.
 */
import { bundle } from './lib/bundle.mjs'

const m = await bundle({ 'automation.js': ['curveAt', 'addPoint', 'removePoints', 'movePoints', 'normalizeAutos', 'ripplePoints'] }, 'autoedit')

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const near = (a, b) => Math.abs(a - b) < 1e-9

// the curve: flat before the first point and after the last, straight or bent between
const auto = { bars: 4, points: [{ x: 1, y: 0.2 }, { x: 3, y: 0.8, c: 0.5 }, { x: 4, y: 0 }] }
ok('curve: flat before the first point', near(m.curveAt(auto, 0), 0.2) && near(m.curveAt(auto, 1), 0.2))
ok('curve: straight halfway', near(m.curveAt(auto, 2), 0.5), m.curveAt(auto, 2))
const bent = 0.8 - 0.8 * 0.5 ** (2 ** 1.5)
ok('curve: bent segment', near(m.curveAt(auto, 3.5), bent), m.curveAt(auto, 3.5))
ok('curve: holds the last point', near(m.curveAt(auto, 4), 0))
ok('curve: one point is flat', near(m.curveAt({ bars: 2, points: [{ x: 0, y: 0.3 }] }, 1.5), 0.3))
ok('curve: two points at one x step', near(m.curveAt({ bars: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, 1), 1))

// add
const pts = [{ x: 0, y: 0 }, { x: 2, y: 1, c: 0.3 }]
const a1 = m.addPoint(pts, 1, 0.123456)
ok('add: goes in order', same(a1.points.map((p) => p.x), [0, 1, 2]) && a1.index === 1)
ok('add: rounds y as stored', a1.points[1].y === 0.1235)
ok('add: leaves the input alone', pts.length === 2)
ok('add: after points at the same x', m.addPoint(pts, 2, 0).index === 2)
ok('add: past the end', m.addPoint(pts, 3, 0).index === 2)

// remove
ok('remove: drops the ones asked', same(m.removePoints(a1.points, [1]), pts))
ok('remove: keeps one point', same(m.removePoints(pts, [0, 1]), [{ x: 0, y: 0 }]))

// move
const four = [{ x: 0, y: 0.5 }, { x: 1, y: 0.2, c: -0.4 }, { x: 2, y: 0.9 }, { x: 3, y: 0.1 }]
const mv = m.movePoints(four, [1], 0.5, 0.1, 4)
ok('move: one point', same(mv.points[1], { x: 1.5, y: 0.3, c: -0.4 }) && same(mv.indices, [1]))
const past = m.movePoints(four, [1], 1.5, 0, 4)
// ripple: what follows slides along, spacing kept; the end point stays put; only the dragged one moves up and down
{
  const pts = [{ x: 0, y: 0.5 }, { x: 1, y: 0.2 }, { x: 2, y: 0.9 }, { x: 3, y: 0.1 }, { x: 4, y: 0.5 }]
  const r = m.ripplePoints(pts, [1], 0.5, 0.1, 4)
  ok('ripple: the dragged point moves both ways', same(r.points[1], { x: 1.5, y: 0.3 }), JSON.stringify(r.points[1]))
  ok('ripple: the ones after slide along, values kept', same(r.points.slice(2, 4), [{ x: 2.5, y: 0.9 }, { x: 3.5, y: 0.1 }]), JSON.stringify(r.points.slice(2, 4)))
  ok('ripple: the end point stays where it is', same(r.points[4], { x: 4, y: 0.5 }))
  const far = m.ripplePoints(pts, [1], 3, 0, 4)
  ok('ripple: right, it squeezes up to the end', Math.abs(far.points[3].x - 4) < 1e-9 && far.points[1].x === 2, JSON.stringify(far.points.map((p) => p.x)))
  const left = m.ripplePoints(pts, [2], -1.5, 0, 4)
  ok('ripple: left, the points after follow; it stops at the one before', same(left.points.map((p) => p.x), [0, 1, 1, 2, 4]), JSON.stringify(left.points.map((p) => p.x)))
}
// points don't pass each other (each segment's shape belongs to the point it starts from)
ok('move: stops at its neighbour', same(past.points.map((p) => p.x), [0, 2, 2, 3]) && same(past.indices, [1]), JSON.stringify(past.points.map((p) => p.x)))
ok('move: and keeps its bend', past.points[1].c === -0.4)
const back = m.movePoints(four, [2], -1.5, 0, 4)
ok('move: nor the one behind it', same(back.points.map((p) => p.x), [0, 1, 1, 3]), JSON.stringify(back.points.map((p) => p.x)))
const pair = m.movePoints(four, [1, 2], 2, 0, 4)
ok('move: a group stops at the next point outside it', same(pair.points.map((p) => p.x), [0, 2, 3, 3]), JSON.stringify(pair.points.map((p) => p.x)))
const copy = m.movePoints(four, [1], 1.5, 0, 4, true)
ok('move: a copy goes wherever it\'s put', copy.points.some((p) => Math.abs(p.x - 2.5) < 1e-9))
const grp = m.movePoints(four, [2, 3], 5, 0.5, 4)
ok('move: a group stops at the end together', same(grp.points.map((p) => p.x), [0, 1, 3, 4]) && same(grp.indices, [2, 3]))
ok('move: … and at the top together', near(grp.points[2].y, 1) && near(grp.points[3].y, 0.2))
const down = m.movePoints(four, [0, 1], -1, -1, 4)
ok('move: and at the start and bottom', down.points[0].x === 0 && down.points[1].y === 0 && near(down.points[0].y, 0.3))
const cp = m.movePoints(four, [1], 0.25, 0, 4, true)
ok('move: a copy leaves the original', cp.points.length === 5 && same(cp.points[1], four[1]) && same(cp.points[2], { x: 1.25, y: 0.2 }) && same(cp.indices, [2]))
ok('move: nothing asked, nothing moves', m.movePoints(four, [], 1, 1, 4).points === four)
ok('move: leaves the input alone', four[1].x === 1)

// what the editor makes loads back unchanged (the stored format is the same)
const project = { nodes: [], patterns: [], song: { clips: [] } }
const saved = [{ id: 'a1', target: 'n:x:gain', bars: 4, points: mv.points }]
ok('stored: edited points load as they are', same(m.normalizeAutos(saved, project)[0].points, mv.points))

console.log(`\n${fails ? `${fails} failing` : 'all good'}`)
process.exit(fails ? 1 : 0)
