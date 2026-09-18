/**
 * Everyone else on this track: their cursor, their selection, their name — and the track
 * itself, which everyone in the room receives. Being signed in is what decides whether you
 * can send anything back; watching gets the same edits and the same playhead, read-only.
 *
 *   join(trackId)                       open the room (leave() when the track changes)
 *   usePeers() / usePresence()          the others, and us, for drawing them
 *   pointerAt(where, x, y) / pointerGone()
 *   selectionIs(where, ids)
 *   viewIs(name)                        which view we're on, for the others
 *   onPeerEdit(fn)                      when somebody else's change lands
 *   onDoc({ seed, doc, ops, reset })    the shared project: see below
 *   sendOps(ops, hash)                  what we just changed
 *   onPlay(fn) / sendPlay(on, pos, cps) playing in time together (the room holds the last
 *                                       of these, so walking in mid-song sounds like it)
 *   openToOthers(on)                    the owner deciding whether anyone else may join in
 *   serverNow()                         the room's clock, in ms, or null while we're alone
 *
 * One websocket per open track (src/api/collab.py). Positions are each surface's own
 * coordinates — flow x/y on the patch canvas, bars and rows on the timeline, bars and
 * notes in the piano roll — so they land in the right place whatever the viewer has
 * zoomed or scrolled to.
 *
 * The document half is a conversation with the room:
 *
 *   seed()          we're the first one in; hand over what we have
 *   doc(project)    what the room already has — adopt it
 *   ops(ops, hash)  what someone else changed; answer false to say we've lost the plot
 *   nope()          a change of ours the room couldn't place; we stop waiting for it
 *   hash()          a fingerprint of the track as we have it, for comparing notes
 *   reset()         the room is gone (a reconnection); we know nothing until it seeds again
 *
 * `v` counts changes on the server. A gap means we missed one, which is not worth being
 * clever about: ask for the whole track again. So does a fingerprint that doesn't match
 * after applying someone's ops, when nothing of ours is still in flight.
 *
 * Our own changes come back to us too, in the place the room gave them. Applying them
 * again is what makes two people turning the same knob agree about who turned it last:
 * everybody ends up applying the same changes in the same order.
 *
 * Two people adding something at the very same moment can still end up with the same
 * things in a different order, because each had already put their own in before hearing
 * about the other's. So when it goes quiet, everyone says what they think they have, and
 * anyone whose copy doesn't match at the same change count asks for the whole track. It
 * costs one small message a few seconds after the last edit, and it means a session can
 * never sit there quietly disagreeing with itself.
 */
import { useSyncExternalStore } from 'react'
import { COLLAB_ROOT } from './base'
import { currentUser, getToken } from './bwnd'

const RETRY = [700, 1500, 3000, 6000, 12000] // how long to wait before trying again
const PING = 25000 // keeps the connection alive through anything that times idle ones out
const CLOCK_EVERY = 20000 // how often we check our clock against the server's
const SETTLED = 4000 // quiet for this long and we compare notes with the others

let sock = null
let room = null // the track id we're in, or null
let me = null
let peers = new Map()
let tries = 0
let timer = 0
let pinger = 0
let mayEdit = false // whether the server lets us change this track
let skew = null // what to add to our clock to get the server's
let bestTrip = Infinity // the quickest round trip we've measured, which is the honest one
let onPlayFn = null
let onRoleFn = null
let onEditFn = null
let heldPlay = null // heard before we had the room's clock; handed on as soon as we do
let myView = null // which view we're on, kept so a reconnection can say so again
let pending = 0 // our own changes the room hasn't put in order yet
let settleTimer = 0
let clockTimer = 0
let version = 0 // the room's change count, as far as we've seen
let doc = null // what the document half of the app has hooked up, if anything
let snapshot = [] // a stable array for useSyncExternalStore: only rebuilt on a real change
let holders = new Map() // surface → (id of the thing → the peer holding it)
const listeners = new Set()
const selListeners = new Set()
const NOBODY = new Map()

const changed = () => {
  snapshot = [...peers.values()]
  for (const fn of listeners) { try { fn() } catch { /* a bad listener isn't our problem */ } }
}
// Selections change far less often than cursors, and they touch every node on screen, so
// they get their own store: a cursor sweeping past must not re-render the whole canvas.
const selChanged = () => {
  holders = new Map()
  for (const p of peers.values()) {
    if (!p.sel?.where || !p.sel.ids?.length) continue
    let map = holders.get(p.sel.where)
    if (!map) holders.set(p.sel.where, (map = new Map()))
    for (const id of p.sel.ids) if (!map.has(id)) map.set(id, p)
  }
  for (const fn of selListeners) { try { fn() } catch { /* ignore */ } }
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
const subscribeSel = (fn) => { selListeners.add(fn); return () => selListeners.delete(fn) }
const getSnapshot = () => snapshot
const getServerSnapshot = () => snapshot

/** Who is holding what on one surface: a Map of the thing's id → the peer. */
export function useHolders(where) {
  const get = () => holders.get(where) ?? NOBODY
  return useSyncExternalStore(subscribeSel, get, get)
}

/**
 * Hook the project up to the room. The handlers are called from the socket; returns a
 * function that unhooks them.
 */
export function onDoc(handlers) {
  doc = handlers
  return () => { if (doc === handlers) doc = null }
}

/** Whether the server will take our changes to this track (the owner's, for now). */
export const canEdit = () => mayEdit && !!sock && sock.readyState === WebSocket.OPEN

/** What we just changed, and our fingerprint of the project afterwards. */
export function sendOps(ops, hash) {
  if (!canEdit() || !ops?.length) return
  pending++
  sock.send(JSON.stringify({ t: 'ops', ops, h: hash }))
  compareNotes()
}

// Asking for the track again is not a change to it, so watching is enough: a watcher
// holds a copy like everyone else, and a copy you can't recover is worse than none.
const askForTrack = () => { if (sock?.readyState === WebSocket.OPEN) sock.send('{"t":"sync"}') }

/** After a quiet spell, tell the others what we have, so a disagreement can't go unnoticed. */
function compareNotes() {
  clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    const hash = doc?.hash?.()
    if (!hash || pending || !canEdit()) return
    sock.send(JSON.stringify({ t: 'same', v: version, h: hash }))
  }, SETTLED)
}

/**
 * Playing in time together. Two browsers have two audio clocks that agree about nothing,
 * so positions travel with the server's clock on them: whoever hits play says where the
 * song is, the server stamps when, and everyone else works out where that is by now.
 *
 * The offset is measured the way clocks have always been measured over a network: ask,
 * see how long the answer took, and believe the quickest round trip most — a slow one
 * spent its time somewhere we can't account for.
 */
export const serverNow = () => (skew == null ? null : Date.now() + skew)

function measureClock() {
  if (sock?.readyState !== WebSocket.OPEN) return
  sock.send(JSON.stringify({ t: 'time', c: Date.now() }))
}

function tookClock(msg) {
  const trip = Date.now() - (msg.c ?? 0)
  if (!(trip >= 0) || typeof msg.s !== 'number') return
  if (skew != null && trip > bestTrip * 2) return // a slow answer tells us nothing new
  bestTrip = Math.min(bestTrip, trip)
  skew = msg.s + trip / 2 - Date.now() // the answer was made about halfway through the trip
  // the room tells us what it's playing the moment we walk in, which is before this
  if (heldPlay) { const held = heldPlay; heldPlay = null; deliverPlay(held) }
}

/** What we heard about the transport, with its time put on our clock. */
const deliverPlay = (msg) => onPlayFn?.({ on: !!msg.on, pos: msg.pos, cps: msg.cps, at: msg.at - skew })

/** Hear where everyone else's playhead is: fn({ on, pos, cps, at }) with `at` on our clock. */
export function onPlay(fn) {
  onPlayFn = fn
  return () => { if (onPlayFn === fn) onPlayFn = null }
}

/**
 * The owner letting others in, or working alone. Everyone finds out at once: someone who
 * has just lost the right stops being sent changes there and then, and someone who has
 * just been given it is handed the track as it stands.
 */
export function openToOthers(on) {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'lock', on: !!on }))
}

/** Told when somebody else's change lands: fn(peerId). For showing that they're working. */
export function onPeerEdit(fn) {
  onEditFn = fn
  return () => { if (onEditFn === fn) onEditFn = null }
}

/** Told when what we may do changes: fn({ edit, open }). */
export function onRole(fn) {
  onRoleFn = fn
  return () => { if (onRoleFn === fn) onRoleFn = null }
}

/** Say where ours is. `pos` is in cycles (bars), `cps` cycles a second. */
export function sendPlay(on, pos, cps) {
  if (!canEdit()) return
  sock.send(JSON.stringify({ t: 'play', on: !!on, pos, cps }))
}

const forgetClock = () => {
  skew = null
  heldPlay = null
  bestTrip = Infinity
  clearInterval(clockTimer)
}

/** The other people on this track, each `{ id, name, color, at, sel }`. */
export function usePeers() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Who the server says we are here (colour and name), or null when we're alone/offline. */
export function usePresence() {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return me
}

function url(trackId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // the websocket path has to say which app it belongs to: the server only rewrites http
  return `${proto}//${window.location.host}${COLLAB_ROOT}/${encodeURIComponent(trackId)}`
}

async function open(trackId) {
  if (room !== trackId) return
  let ws
  try {
    ws = new WebSocket(url(trackId))
  } catch {
    return retry(trackId)
  }
  sock = ws
  ws.onopen = async () => {
    if (sock !== ws) return ws.close()
    const token = await getToken().catch(() => null)
    if (sock !== ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ t: 'hello', token: token || '', name: currentUser()?.givenName || currentUser()?.name || '' }))
    pinger = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}') }, PING)
    // a burst to settle on an offset, then now and then, because clocks drift
    for (const wait of [0, 250, 600, 1200]) setTimeout(measureClock, wait)
    clearInterval(clockTimer)
    clockTimer = setInterval(measureClock, CLOCK_EVERY)
  }
  ws.onmessage = (e) => {
    if (sock !== ws) return
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (msg.t === 'me') {
      tries = 0
      mayEdit = !!msg.edit
      version = 0
      me = { id: msg.id, color: msg.color, name: msg.name, edit: mayEdit, owner: !!msg.owner, open: msg.open !== false }
      if (myView) ws.send(JSON.stringify({ t: 'view', v: myView })) // the room forgot us when the socket went
      doc?.reset?.()
      changed()
      onRoleFn?.({ edit: mayEdit, open: me.open })
      return
    }
    if (msg.t === 'role') {
      // what we may do changes; what we can see doesn't, because the room's copy keeps
      // arriving either way. Being put back to watching stops us sending, nothing more.
      mayEdit = !!msg.edit
      if (me) me = { ...me, edit: mayEdit, open: msg.open !== false }
      changed()
      onRoleFn?.({ edit: mayEdit, open: msg.open !== false })
      return
    }
    if (msg.t === 'open') {
      if (me) me = { ...me, open: !!msg.on }
      changed()
      onRoleFn?.({ edit: mayEdit, open: !!msg.on })
      return
    }
    if (msg.t === 'seed') {
      const project = doc?.seed?.()
      if (project && canEdit()) sock.send(JSON.stringify({ t: 'doc', doc: project }))
      return
    }
    if (msg.t === 'time') { tookClock(msg); return }
    if (msg.t === 'play') {
      if (typeof msg.at !== 'number') return
      // `at` is on the server's clock and has to come onto ours, which we haven't measured
      // yet on the way in — and on the way in is exactly when the room hands over what it
      // is already playing. So hold it rather than drop the one message that says there's
      // music on; it goes through the moment the clock lands, a beat later.
      if (skew == null) { heldPlay = msg; return }
      deliverPlay(msg)
      return
    }
    if (msg.t === 'doc') { version = msg.v ?? 0; pending = 0; doc?.doc?.(msg.doc); return }
    // the room took our whole track: nothing of ours is in flight any more
    if (msg.t === 'ack') { version = msg.v ?? version; pending = 0; return }
    if (msg.t === 'nope') {
      // a change of ours the room couldn't place — it was aimed at something already gone.
      // Stop waiting for it: a change counted as in flight forever is what would keep us
      // from ever comparing notes again, and comparing notes is how we'd find out we had
      // drifted. Settling up afterwards is exactly the job the quiet check already does.
      pending = Math.max(0, pending - 1)
      version = msg.v ?? version
      compareNotes()
      return
    }
    if (msg.t === 'behind') { askForTrack(); return } // the room dropped something of ours
    if (msg.t === 'same') {
      // someone else's copy at our own change count: if it isn't ours, one of us is wrong
      if (pending || msg.v !== version) return
      const ours = doc?.hash?.()
      if (ours && msg.h && ours !== msg.h) askForTrack()
      return
    }
    if (msg.t === 'ops') {
      // a gap means we missed a change: the whole track is cheaper than working out which
      if (msg.v != null && msg.v !== version + 1) { version = msg.v; askForTrack(); return }
      version = msg.v ?? version
      compareNotes()
      if (msg.id !== me?.id) onEditFn?.(msg.id)
      if (msg.id === me?.id) {
        // our own change, come back in the place the room gave it. Applying it again is
        // how we end up agreeing with everyone else about who turned the knob last — but
        // only once it's the last one we're waiting on, or a fast drag would judder as
        // each older value landed on top of a newer one.
        pending = Math.max(0, pending - 1)
        if (pending === 0) doc?.ops?.(msg.ops, null)
        return
      }
      if (doc?.ops?.(msg.ops, pending ? null : msg.h) === false) askForTrack()
      return
    }
    if (msg.t === 'here') { peers = new Map(msg.peers.map((p) => [p.id, p])); changed(); selChanged(); return }
    if (msg.t === 'join') { peers.set(msg.peer.id, msg.peer); changed(); selChanged(); return }
    if (msg.t === 'gone') { peers.delete(msg.id); changed(); selChanged(); return }
    if (msg.t === 'view') {
      const p = peers.get(msg.id)
      if (!p) return
      peers.set(msg.id, { ...p, view: msg.v || null })
      changed()
      return
    }
    if (msg.t === 'at') {
      const p = peers.get(msg.id)
      if (!p) return
      peers.set(msg.id, { ...p, at: msg.where ? { where: msg.where, x: msg.x, y: msg.y } : null })
      changed()
      return
    }
    if (msg.t === 'sel') {
      const p = peers.get(msg.id)
      if (!p) return
      peers.set(msg.id, { ...p, sel: msg.ids?.length ? { where: msg.where, ids: msg.ids } : null })
      changed()
      selChanged()
    }
  }
  ws.onclose = () => {
    if (sock !== ws) return
    clearInterval(pinger)
    sock = null
    me = null
    mayEdit = false
    pending = 0
    clearTimeout(settleTimer)
    forgetClock()
    doc?.reset?.()
    if (peers.size) { peers = new Map(); changed(); selChanged() }
    retry(trackId)
  }
  ws.onerror = () => { try { ws.close() } catch { /* already gone */ } }
}

function retry(trackId) {
  if (room !== trackId) return
  const wait = RETRY[Math.min(tries++, RETRY.length - 1)]
  clearTimeout(timer)
  timer = setTimeout(() => open(trackId), wait)
}

/** Join a track's room. Calling it again with the same id does nothing. */
export function join(trackId) {
  if (!trackId || room === trackId) return
  leave()
  room = trackId
  tries = 0
  open(trackId)
}

export function leave() {
  room = null
  clearTimeout(timer)
  clearInterval(pinger)
  const ws = sock
  sock = null
  me = null
  mayEdit = false
  pending = 0
  clearTimeout(settleTimer)
  forgetClock()
  doc?.reset?.()
  if (ws) { ws.onclose = null; try { ws.close() } catch { /* already gone */ } }
  lastSel = ''
  if (peers.size) { peers = new Map(); changed(); selChanged() }
}

// A pointer moves far more often than anyone can see, so the last position wins each
// frame, and no more than thirty go out a second: smooth to watch, and well under what
// the room will take (collab.py), so a cursor can never crowd out an edit.
const CURSOR_EVERY = 33
let queued = null
let frame = 0
let sentAt = 0
const flush = () => {
  frame = 0
  const msg = queued
  const wait = CURSOR_EVERY - (Date.now() - sentAt)
  if (wait > 0) { frame = setTimeout(flush, wait); return } // still holding the latest
  queued = null
  if (msg && sock?.readyState === WebSocket.OPEN) { sentAt = Date.now(); sock.send(JSON.stringify(msg)) }
}
const queue = (msg) => {
  queued = msg
  if (!frame && sock?.readyState === WebSocket.OPEN) frame = requestAnimationFrame(flush)
}

// Four decimals, because a surface's own coordinates can be bars (where a hundredth is
// finer than anyone can point) or a fraction of a region's width (where a hundredth is a
// visible step of about 14 pixels across a wide header).
const round = (v) => Math.round(v * 10000) / 10000

/** Where our pointer is on a surface, in that surface's own coordinates. */
export function pointerAt(where, x, y) {
  if (!room || !Number.isFinite(x) || !Number.isFinite(y)) return
  queue({ t: 'at', where, x: round(x), y: round(y) })
}

/** Our pointer left a surface (so nobody draws a stale cursor there). */
export function pointerGone() {
  if (!room) return
  queue({ t: 'at', where: null })
}

let lastSel = ''
/**
 * Which view we're on. Someone working on another one has no cursor you can see — it's on
 * a surface that isn't on your screen — and without this they read as having left.
 */
export function viewIs(name) {
  const next = name || null
  if (next === myView) return
  myView = next
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'view', v: myView }))
}

/** What we have selected on a surface, so the others can see it outlined. */
export function selectionIs(where, ids) {
  if (!room) return
  const list = [...(ids ?? [])].slice(0, 60)
  const key = `${where}:${list.join(',')}`
  if (key === lastSel) return
  lastSel = key
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'sel', where, ids: list }))
}

/** Peers whose cursor is on one surface. */
export const peersOn = (list, where) => list.filter((p) => p.at?.where === where)
