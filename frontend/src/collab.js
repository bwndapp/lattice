/**
 * Everyone else on this track: their cursor, their selection, their name.
 *
 *   join(trackId)                       open the room (leave() when the track changes)
 *   usePeers()                          the others, for drawing them
 *   pointerAt(where, x, y) / pointerGone(where)
 *   selectionIs(where, ids)
 *
 * One websocket per open track (src/api/collab.py). Presence only: nothing here touches
 * the project, so a dropped connection costs nothing but the other cursors. Positions are
 * each surface's own coordinates — flow x/y on the patch canvas, bars and rows on the
 * timeline, bars and notes in the piano roll — so they land in the right place whatever
 * the viewer has zoomed or scrolled to.
 */
import { useSyncExternalStore } from 'react'
import { BASE } from './base'
import { currentUser, getToken } from './bwnd'

const RETRY = [700, 1500, 3000, 6000, 12000] // how long to wait before trying again
const PING = 25000 // keeps the connection alive through anything that times idle ones out

let sock = null
let room = null // the track id we're in, or null
let me = null
let peers = new Map()
let tries = 0
let timer = 0
let pinger = 0
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
  // the websocket path has to say draft or live itself: the server only rewrites http
  return `${proto}//${window.location.host}${BASE}/api/collab/${encodeURIComponent(trackId)}`
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
  }
  ws.onmessage = (e) => {
    if (sock !== ws) return
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (msg.t === 'me') { tries = 0; me = { id: msg.id, color: msg.color, name: msg.name }; changed(); return }
    if (msg.t === 'here') { peers = new Map(msg.peers.map((p) => [p.id, p])); changed(); selChanged(); return }
    if (msg.t === 'join') { peers.set(msg.peer.id, msg.peer); changed(); selChanged(); return }
    if (msg.t === 'gone') { peers.delete(msg.id); changed(); selChanged(); return }
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
  if (ws) { ws.onclose = null; try { ws.close() } catch { /* already gone */ } }
  lastSel = ''
  if (peers.size) { peers = new Map(); changed(); selChanged() }
}

// Cursors move far more often than a frame, so the last position wins each frame.
let pending = null
let frame = 0
const flush = () => {
  frame = 0
  const msg = pending
  pending = null
  if (msg && sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg))
}
const queue = (msg) => {
  pending = msg
  if (!frame && sock?.readyState === WebSocket.OPEN) frame = requestAnimationFrame(flush)
}

/** Where our pointer is on a surface, in that surface's own coordinates. */
export function pointerAt(where, x, y) {
  if (!room || !Number.isFinite(x) || !Number.isFinite(y)) return
  queue({ t: 'at', where, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 })
}

/** Our pointer left a surface (so nobody draws a stale cursor there). */
export function pointerGone() {
  if (!room) return
  queue({ t: 'at', where: null })
}

let lastSel = ''
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
