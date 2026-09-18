import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { COLLAB_ROOT } from './base'
import { createFace } from './vendor/bbot.js'
import { applyFx } from './vendor/bbot-fx.js'
import { botLook, botStyle } from './bot.js'
import './LiveOnTrack.css'

/**
 * Who is working on a track right now, as faces in the corner of its card.
 *
 * A browse list is normally a shelf of finished things. Some of these aren't finished —
 * somebody is inside one of them at this moment — and that's worth seeing from outside,
 * because it's the difference between a catalogue and a room you can walk into.
 *
 * One poll serves the whole list (`/live` on the relay reads rooms it already has in
 * memory, so this costs no sockets and no database), and a card asks the shared answer
 * rather than asking for itself. Only sessions that take drop-ins are listed: an
 * invite-only room is one nobody is being pointed at, so saying it was busy would point
 * at it.
 */

const EVERY = 8000 // how often we ask; a session lasts minutes, so this is often enough
let live = new Map() // track id → [{ name, color }]
let timer = 0
let watchers = 0
const listeners = new Set()
const NOBODY = []

const changed = (next) => {
  live = next
  for (const fn of listeners) fn()
}

async function poll() {
  try {
    const r = await fetch(`${COLLAB_ROOT}/live`, { headers: { accept: 'application/json' } })
    if (!r.ok) return
    const body = await r.json()
    const next = new Map(Object.entries(body?.tracks ?? {}))
    // a stable identity while nothing changes, so a card that isn't live never re-renders
    if (JSON.stringify([...next]) !== JSON.stringify([...live])) changed(next)
  } catch { /* the list is decoration: a poll that fails simply shows nobody */ }
}

/** The polling is shared: one timer for the whole page, running only while somebody looks. */
function watch(fn) {
  listeners.add(fn)
  if (++watchers === 1) {
    poll()
    timer = setInterval(poll, EVERY)
  }
  return () => {
    listeners.delete(fn)
    if (--watchers === 0) { clearInterval(timer); timer = 0 }
  }
}

const onTrack = (id) => live.get(id) ?? NOBODY

/** The people on one track right now, or an empty list. */
export function useLiveOn(trackId) {
  const get = () => onTrack(trackId)
  return useSyncExternalStore(watch, get, () => NOBODY)
}

function Bot({ person, i }) {
  const box = useRef(null)
  const look = useMemo(() => botLook(person.bot, person.color), [person.bot, person.color])
  useEffect(() => {
    const f = createFace(box.current, { expression: 'excited', track: false, idle: true, pupils: look.pupils, mouth: look.mouth })
    const svg = box.current.querySelector('svg')
    if (svg) try { applyFx(svg, look.fx) } catch { /* a finish is never worth a blank face */ }
    return () => f.destroy()
  }, [look])
  return (
    <span
      className="live-bot"
      // they overlap a little, most recent in front, so four people read as a huddle
      style={{ ...botStyle(look), zIndex: 8 - i }}
      ref={box}
    />
  )
}

/** The corner of a card: nothing at all unless somebody is in there. */
export default function LiveOnTrack({ trackId }) {
  const people = useLiveOn(trackId)
  if (!people.length) return null
  const names = people.map((p) => p.name).join(', ')
  return (
    <span
      className="live-on"
      title={`${names} ${people.length === 1 ? 'is' : 'are'} working on this right now`}
      aria-label={`${people.length} here now`}
    >
      {people.slice(0, 4).map((p, i) => <Bot key={`${p.name}-${i}`} person={p} i={i} />)}
      {people.length > 4 && <span className="live-more">+{people.length - 4}</span>}
    </span>
  )
}
