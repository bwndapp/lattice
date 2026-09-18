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
 *
 * It lives at the app's root rather than in the header, so it's in the same corner
 * wherever you are — the patch, the timeline, the browser, the code — and it isn't there
 * at all until somebody else is.
 *
 * The face is bbot (src/vendor/bbot.js, MIT): a circle with two eyes on the surface of a
 * sphere, so a gaze travels a curved path rather than sliding across a disc.
 */

/** Where each of them is, in the words the buttons use. */
const WHERE = { song: 'on the timeline', graph: 'on the patch', browse: 'browsing', code: 'in the code' }

const clamp = (v) => Math.max(-1, Math.min(1, v))

/**
 * What a face is doing when nothing in particular is happening. Reactions layer over this
 * and decay; this is the resting state underneath.
 */
function mood(peer, away) {
  if (!peer.edit) return 'curious' // here to watch
  if (away) return 'sleepy' // working on a view this screen isn't showing
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
  const at = peer.at
  useEffect(() => {
    if (mine || !face.current || !box.current) return
    const spot = whereOnScreen(at)
    if (!spot) return
    const r = box.current.getBoundingClientRect()
    const reach = Math.max(window.innerWidth, window.innerHeight) / 2
    face.current.look(
      clamp((spot.left - (r.left + r.width / 2)) / reach),
      clamp((spot.top - (r.top + r.height / 2)) / reach),
      600, // longer than the gap between cursor messages, so the gaze glides rather than ticks
    )
  }, [at, mine])

  const resting = mine ? 'content' : mood(peer, away)
  useEffect(() => {
    if (!mine) face.current?.setExpression(resting)
  }, [resting, mine])

  const said = [peer.name, mine ? '(you)' : WHERE[peer.view], peer.edit ? null : '(watching)'].filter(Boolean).join(' ')
  return (
    <span
      className={`peer-face ${mine ? 'me' : ''} ${away ? 'away' : ''}`}
      title={said}
      style={{ '--face-skin': '#0b0b0f', '--face-ink': peer.color, '--face-ring': peer.color }}
    >
      <span className="peer-face-box" ref={box} />
      <span className="peer-face-name">{peer.name}</span>
    </span>
  )
}

/**
 *   view                    the view WE are on, so a face can tell who's somewhere else
 *   together / onTogether   the switch that puts your playhead in step with theirs
 */
export default function PeerTray({ together = false, onTogether = null, view = null }) {
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
      {onTogether && (
        <button
          className={`btn tiny peer-together ${together ? 'on' : ''}`}
          onClick={() => onTogether(!together)}
          aria-pressed={together}
          title={together ? 'Your playhead follows whoever hits play' : 'Play in time with the others: whoever hits play, everyone hears it from the same place'}
        >together</button>
      )}
    </div>
  )
}
