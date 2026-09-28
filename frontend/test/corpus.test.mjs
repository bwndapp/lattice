/**
 * Every saved track still loads as it did: each public track (test/fixtures/tracks, from
 * tools/golden/export-tracks.mjs) is parsed and normalised, makes byte-for-byte the code it
 * made when it was snapshotted, and survives being written back out and read in again.
 *
 * A change that alters the code a saved track makes fails here. If it's meant to (and the
 * goldens say it still sounds the same), re-snapshot with `npm run corpus:update`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bundle, FRONTEND } from './lib/bundle.mjs'

const m = await bundle({
  'project.js': ['parseProject', 'generateCode', 'normalizeProject', 'PROJECT_MARK'],
  'docsync.js': ['docHash'],
}, 'corpus')

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** Where two texts first part ways, for the failure message. */
const firstDiff = (a, b) => {
  const x = String(a).split('\n'); const y = String(b).split('\n')
  const i = x.findIndex((l, n) => l !== y[n])
  return i < 0 ? `lengths ${x.length} / ${y.length}` : `line ${i + 1}: ${JSON.stringify(x[i]?.slice(0, 160))} vs ${JSON.stringify(y[i]?.slice(0, 160))}`
}

const DIR = path.join(FRONTEND, 'test', 'fixtures', 'tracks')
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
ok('there are tracks to check', files.length > 0)
for (const f of files) {
  const t = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  const name = `${t.title} (${f})`
  const project = m.parseProject(t.code)
  ok(`${name}: loads`, !!project)
  if (!project) continue
  // normalising is idempotent: what loads is already clean
  const again = m.normalizeProject(JSON.parse(JSON.stringify(project)))
  ok(`${name}: normalises to itself`, same(again, project))
  // the code it plays is the code it played
  const code = m.generateCode(project)
  ok(`${name}: makes the same code`, code === t.generated, firstDiff(code, t.generated))
  // written back out (as saving does) and read in again, nothing moves
  const reread = m.parseProject(code)
  ok(`${name}: round-trips through its own code`, same(reread, project))
  ok(`${name}: same fingerprint after the round trip`, m.docHash(reread) === m.docHash(project))
  ok(`${name}: and makes the same code again`, m.generateCode(reread) === code)
}

console.log(`\n${fails ? `${fails} failing` : 'all good'}`)
process.exit(fails ? 1 : 0)
