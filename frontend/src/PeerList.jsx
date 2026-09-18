import { usePeers, usePresence } from './collab.js'

/**
 * Who else has this track open, as a row of initials, and the switch that puts your
 * playhead in step with theirs. Nothing shows when you're alone.
 *
 *   view                    the view WE are on, so a dot can say who's somewhere else
 *
 *   together / onTogether   the "play together" switch, for anyone in the room — someone
 *                           watching hears it play like everyone else, so they need the
 *                           same way out of it as everyone else
 */
// Where each of them is, in the words the buttons use. Someone on another view still has a
// cursor and a selection; they're just on a surface this screen isn't showing.
const WHERE = { song: 'on the timeline', graph: 'on the patch', browse: 'browsing', code: 'in the code' }

export default function PeerList({ together = false, onTogether = null, view = null }) {
  const peers = usePeers()
  const me = usePresence()
  if (!peers.length) return null
  // someone who isn't signed in is here to watch: their dot is hollow
  const names = peers.map((p) => [p.name, WHERE[p.view], p.edit ? null : '(watching)'].filter(Boolean).join(' ')).join(', ')
  return (
    <span className="peer-list">
      <span className="peer-dots" title={`${names} ${peers.length === 1 ? 'is' : 'are'} here too`}>
        {me && <span className="peer-dot me" style={{ '--peer': me.color }}>{me.name.slice(0, 1).toUpperCase()}</span>}
        {peers.map((p) => (
          <span
            key={p.id}
            className={`peer-dot ${p.edit ? '' : 'watching'} ${p.view && p.view !== view ? 'away' : ''}`}
            style={{ '--peer': p.color }}
            title={[p.name, WHERE[p.view], p.edit ? null : '(watching)'].filter(Boolean).join(' ')}
          >{p.name.slice(0, 1).toUpperCase()}</span>
        ))}
      </span>
      {onTogether && me && (
        <button
          className={`btn tiny ${together ? 'on' : ''}`}
          onClick={() => onTogether(!together)}
          aria-pressed={together}
          title={together ? 'Your playhead follows whoever hits play' : 'Play in time with the others: whoever hits play, everyone hears it from the same place'}
        >together</button>
      )}
    </span>
  )
}
