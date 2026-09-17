import { usePeers, peersOn } from './collab.js'
import './PeerCursors.css'

/**
 * The other people's pointers on one surface.
 *
 *   where  which surface this is ('graph', 'timeline', 'roll')
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
            <svg width="14" height="18" viewBox="0 0 14 18">
              <path d="M1 1l11 8-5 1.2 2.4 5.1-2.3 1.1-2.4-5.2L1 14z" fill={p.color} stroke="rgba(0,0,0,.55)" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <span className="peer-name">{p.name}</span>
          </div>
        )
      })}
    </>
  )
}
