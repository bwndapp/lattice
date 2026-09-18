import { usePeers, peersOn } from './collab.js'
import './PeerCursors.css'

/**
 * The other people's pointers on one surface — the same dot this app uses for its own
 * cursor (index.css: --dot), in the colour the room gave them.
 *
 *   where  which surface this is ('graph', 'timeline', 'roll:<pattern>')
 *   to     ({ x, y }) => ({ left, top }) in pixels inside the positioned parent, or null
 *          to leave that cursor undrawn (off-screen, or a lane that isn't there)
 *   scale  divides the cursor's size, for a surface that zooms its own contents
 *
 * The parent has to be `position: relative` (or be a react flow viewport portal): each
 * cursor is placed absolutely inside it.
 */
export default function PeerCursors({ where, to, scale = 1 }) {
  const peers = usePeers()
  const here = peersOn(peers, where)
  if (!here.length) return null
  return (
    <>
      {here.map((p) => {
        const at = to(p.at)
        return at ? <PeerDot key={p.id} peer={p} left={at.left} top={at.top} scale={scale} /> : null
      })}
    </>
  )
}

/**
 * One person's pointer, at a place already worked out in pixels. Every surface draws the
 * same dot: the one this app uses for its own cursor, in the colour the room gave them.
 */
export function PeerDot({ peer, left, top, scale = 1 }) {
  return (
    <div
      className="peer-cursor"
      style={{ transform: `translate(${left}px, ${top}px) scale(${1 / scale})`, '--peer': peer.color }}
      aria-hidden
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="6" r="4" fill={peer.color} stroke="black" strokeWidth="1" />
      </svg>
      <span className="peer-name">{peer.name}</span>
    </div>
  )
}
