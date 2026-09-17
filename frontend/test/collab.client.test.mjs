/**
 * The client half of the room, with a stubbed socket: seeding, adopting, applying
 * someone's ops, noticing a gap, and going quiet when the connection drops.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = new URL('../src/collab.js', import.meta.url).pathname
const tmp = path.join(process.env.TMPDIR || '/tmp', 'collab.under-test.mjs')

// stand-ins for the two browser-only imports, so this runs in node
let source = fs.readFileSync(SRC, 'utf8')
source = source.replace("import { useSyncExternalStore } from 'react'", 'const useSyncExternalStore = () => {}')
source = source.replace("import { COLLAB_ROOT } from './base'", "const COLLAB_ROOT = '/api/collab'")
source = source.replace("import { currentUser, getToken } from './bwnd'", 'const currentUser = () => ({ givenName: "ana" }); const getToken = async () => "tok"')
fs.writeFileSync(tmp, source)

// a socket we drive by hand
const sent = []
class FakeSocket {
  static OPEN = 1
  static instances = []
  constructor() { this.readyState = 1; FakeSocket.instances.push(this) }
  send(text) { sent.push(JSON.parse(text)) }
  close() { this.readyState = 3; this.onclose?.() }
  arrive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
globalThis.WebSocket = FakeSocket
globalThis.window = { location: { protocol: 'https:', host: 'lattice.test' } }
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

const collab = await import(pathToFileURL(tmp))

let fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${JSON.stringify(extra)}`))
  if (!cond) fails.push(name)
}
const last = (t) => [...sent].reverse().find((m) => m.t === t)

const seen = { doc: null, ops: [], resets: 0, hash: 'mine' }
collab.onDoc({
  seed: () => ({ bpm: 120, patterns: [] }),
  doc: (d) => { seen.doc = d },
  ops: (ops, hash) => { seen.ops.push([ops, hash]); return hash !== 'bad' },
  hash: () => seen.hash,
  reset: () => { seen.resets++ },
})

collab.join('trk') // joining a room forgets whatever the last one had
const atJoin = seen.resets
const ws = FakeSocket.instances[0]
ws.onopen()
await new Promise((r) => setTimeout(r, 5))
ok('says hello with a token', last('hello')?.token === 'tok', last('hello'))

ws.arrive({ t: 'me', id: 1, color: '#fff', name: 'ana', edit: true })
ok('a new room resets what we think it has', seen.resets === atJoin + 1, seen.resets)
ok('we know we may edit', collab.canEdit() === true)

ws.arrive({ t: 'seed' })
ok('being first in hands over our track', last('doc')?.doc?.bpm === 120, last('doc'))

ws.arrive({ t: 'ack', v: 1 })
ws.arrive({ t: 'ops', id: 2, v: 2, ops: [{ op: 'set', path: ['bpm'], value: 90 }], h: 'good' })
ok("someone else's edit is handed over", seen.ops.length === 1 && seen.ops[0][0][0].value === 90)
ok('no resync was asked for', !last('sync'))

// a change we never saw: ask for the whole track rather than guess
ws.arrive({ t: 'ops', id: 2, v: 9, ops: [{ op: 'set', path: ['bpm'], value: 100 }], h: 'good' })
ok('a gap asks for the whole track', !!last('sync'))
ok('the skipped ops are not applied', seen.ops.length === 1)

ws.arrive({ t: 'doc', doc: { bpm: 100, patterns: [] }, v: 9 })
ok('the whole track is adopted', seen.doc?.bpm === 100)

// drifted: our fingerprint doesn't match the sender's
sent.length = 0
ws.arrive({ t: 'ops', id: 2, v: 10, ops: [{ op: 'set', path: ['bpm'], value: 111 }], h: 'bad' })
ok('a fingerprint that disagrees asks for the whole track', !!last('sync'))

// our own edits
sent.length = 0
collab.sendOps([{ op: 'set', path: ['bpm'], value: 123 }], 'hash1')
ok('our edit goes out with its fingerprint', last('ops')?.h === 'hash1', last('ops'))
collab.sendOps([], 'hash2')
ok('an edit with nothing in it is not sent', sent.filter((m) => m.t === 'ops').length === 1)

// our own change comes back to us, in the place the room gave it
seen.ops.length = 0
ws.arrive({ t: 'ops', id: 1, v: 11, ops: [{ op: 'set', path: ['bpm'], value: 123 }], h: 'hash1' })
ok('our own change, once nothing else is in flight, is applied in its place', seen.ops.length === 1, seen.ops)

// while we still have one in flight, an older copy of our own change is not put back
seen.ops.length = 0
collab.sendOps([{ op: 'set', path: ['bpm'], value: 141 }], 'h141')
collab.sendOps([{ op: 'set', path: ['bpm'], value: 142 }], 'h142')
ws.arrive({ t: 'ops', id: 1, v: 12, ops: [{ op: 'set', path: ['bpm'], value: 141 }], h: 'h141' })
ok('an older change of ours is not dropped back on top of a newer one', seen.ops.length === 0, seen.ops)
ws.arrive({ t: 'ops', id: 1, v: 13, ops: [{ op: 'set', path: ['bpm'], value: 142 }], h: 'h142' })
ok('the last one of ours does land', seen.ops.length === 1, seen.ops)

// the room says it dropped something of ours
sent.length = 0
ws.arrive({ t: 'behind' })
ok('being told we are behind asks for the whole track', !!last('sync'))

// comparing notes once it has gone quiet
sent.length = 0
ws.arrive({ t: 'same', id: 2, v: 13, h: 'mine' })
ok('a copy that matches ours is left alone', !last('sync'))
ws.arrive({ t: 'same', id: 2, v: 13, h: 'theirs-differs' })
ok('a copy that disagrees at the same count asks for the whole track', !!last('sync'))
sent.length = 0
ws.arrive({ t: 'same', id: 2, v: 99, h: 'theirs-differs' })
ok('a copy from another moment is not compared', !last('sync'))

// and we say what we have, once it stays quiet
sent.length = 0
await new Promise((r) => setTimeout(r, 4400))
ok('we say what we have after a quiet spell', last('same')?.h === 'mine', last('same'))

// a dropped connection
ws.close()
ok('a drop clears what we thought the room had', seen.resets === atJoin + 2, seen.resets)
ok('nothing is sent while disconnected', collab.canEdit() === false)
sent.length = 0
collab.sendOps([{ op: 'set', path: ['bpm'], value: 5 }], 'h')
ok('an edit while disconnected is dropped, not queued', sent.length === 0)

collab.leave()
fs.unlinkSync(tmp)
console.log('\n' + (fails.length ? `${fails.length} failing: ${fails}` : 'all good'))
process.exit(fails.length ? 1 : 0)
