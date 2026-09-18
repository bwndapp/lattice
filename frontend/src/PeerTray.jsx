import { useEffect, useRef } from 'react'
import { usePeers, usePresence, onPeerEdit } from './collab.js'
import { whereOnScreen } from './surfaces.jsx'
import { createFace } from './vendor/bbot.js'
import './PeerTray.css'

/**
 * Who's in the room, as faces, in the bottom-right corner of every view.
 *
 * A coloured initial says someone is present. A face says what they're doing — which is
 * what you actually want to know about a person you're working with, and what a bubble
 * can never tell you:
 *
 *   · their eyes follow their own pointer, so you can see where they're working even
 *     while they're on a view you don't have open
 *   · someone here to watch looks curious; someone off on another view dozes; someone
 *     working looks about the room
 *   · a change of theirs landing makes them nod, so the track moving under your hands has
 *     a face attached to it rather than being weather
 *   · somebody on another view says which one, unasked — the one thing you can't work out
 *     by looking, because their cursor is somewhere this screen isn't showing
 *
 * It lives at the app's root rather than in the header, so it's in the same corner
 * wherever you are — the patch, the timeline, the browser, the code — and it isn't there
 * at all until somebody else is.
 *
 * The face is bbot (src/vendor/bbot.js, MIT): a circle with two eyes on the surface of a
 * sphere, so a gaze travels a curved path rather than sliding across a disc.
 */

const WHERE = { song: 'on the timeline', graph: 'on the patch', browse: 'browsing', code: 'in the code' }
const TAB = { song: 'timeline', graph: 'patch', browse: 'browsing', code: 'code' }

/**
 * Where someone is, in words: one for the bubble over their head, a longer one for the
 * tooltip. A view is its own name; the dock says which pattern it's open on, because "in a
 * rack" is only half an answer when a track has six of them.
 */
function place(view) {
  if (!view) return null
  const cut = view.indexOf(':')
  if (cut < 0) return TAB[view] ? { tab: TAB[view], said: WHERE[view] } : null
  const kind = view.slice(0, cut)
  const name = view.slice(cut + 1)
  if (kind === 'rack') return { tab: name ? `${name} rack` : 'a rack', said: name ? `in the ${name} rack` : 'in a rack' }
  if (kind === 'notes') return { tab: name ? `${name} notes` : 'notes', said: name ? `writing ${name} notes` : 'in the piano roll' }
  return null
}

const clamp = (v) => Math.max(-1, Math.min(1, v))

/**
 * What a face is doing when nothing in particular is happening. Reactions layer over this
 * and decay; this is the resting state underneath.
 */
function mood(peer, away) {
  if (!peer.edit) return 'curious' // here to watch
  // Heads-down on a view this screen isn't showing. Not dozing: they're working, and the
  // bubble over their head already says where — the face only has to say they're busy.
  if (away) return 'focus'
  return 'idle'
}

function PeerFace({ peer, mine = false, away = false, faces = null }) {
  const box = useRef(null)
  const face = useRef(null)

  useEffect(() => {
    // our own face follows our own pointer; everyone else's is aimed by hand, below
    const f = createFace(box.current, { expression: mine ? 'content' : 'idle', track: mine, pupils: true })
    face.current = f
    if (faces && !mine) faces.current.set(peer.id, f)
    if (!mine) f.react('pop') // a little hello on the way in
    return () => {
      if (faces && !mine) faces.current.delete(peer.id)
      face.current = null
      f.destroy() // or it keeps its slot in the shared animation loop
    }
  }, [mine, peer.id, faces])

  // where they're looking: their pointer, turned into a direction from this face
  const pointer = peer.at
  useEffect(() => {
    if (mine || !face.current || !box.current) return
    const spot = whereOnScreen(pointer)
    if (!spot) return
    const r = box.current.getBoundingClientRect()
    const reach = Math.max(window.innerWidth, window.innerHeight) / 2
    face.current.look(
      clamp((spot.left - (r.left + r.width / 2)) / reach),
      clamp((spot.top - (r.top + r.height / 2)) / reach),
      600, // longer than the gap between cursor messages, so the gaze glides rather than ticks
    )
  }, [pointer, mine])

  const resting = mine ? 'content' : mood(peer, away)
  useEffect(() => {
    if (!mine) face.current?.setExpression(resting)
  }, [resting, mine])

  const at = place(peer.view)
  const said = [peer.name, mine ? '(you)' : at?.said, peer.edit ? null : '(watching)'].filter(Boolean).join(' ')
  // Somebody somewhere else says so without being asked: that's the one case where you
  // can't see for yourself, because their cursor is on a surface you don't have open.
  const tab = away ? at?.tab : null
  return (
    <span
      className={`peer-face ${mine ? 'me' : ''} ${away ? 'away' : ''}`}
      title={said}
      style={{ '--face-skin': '#0b0b0f', '--face-ink': peer.color, '--face-ring': peer.color }}
    >
      <span className="peer-face-box" ref={box} />
      <span className="peer-face-says">
        {tab && <span className="says-tab">{tab}</span>}
        <span className="says-name">{peer.name}</span>
      </span>
    </span>
  )
}

/**
 *   view   where WE are, in the same words the others report — so two people in the same
 *          rack read as together, and the comparison is like with like
 */
export default function PeerTray({ view = null }) {
  const peers = usePeers()
  const me = usePresence()
  const faces = useRef(new Map())

  // somebody's change landing: the face that made it nods
  useEffect(() => onPeerEdit((id) => faces.current.get(id)?.react('nod')), [])

  if (!me || !peers.length) return null // on your own, there's nobody to show
  return (
    <div className="peer-tray" role="group" aria-label="Who's here">
      <div className="peer-faces">
        {peers.map((p) => (
          <PeerFace key={p.id} peer={p} away={!!p.view && p.view !== view} faces={faces} />
        ))}
        <PeerFace peer={me} mine />
      </div>
    </div>
  )
}
