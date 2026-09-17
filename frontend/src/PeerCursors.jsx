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
        if (!at) return null
        return (
          <div
            key={p.id}
            className="peer-cursor"
            style={{ transform: `translate(${at.left}px, ${at.top}px) scale(${1 / scale})`, '--peer': p.color }}
            aria-hidden
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4" fill={p.color} stroke="black" strokeWidth="1" />
            </svg>
            <span className="peer-name">{p.name}</span>
          </div>
        )
      })}
    </>
  )
}
