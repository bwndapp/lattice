import { usePeers, usePresence } from './collab.js'

/**
 * Who else has this track open, as a row of initials, and the switch that puts your
 * playhead in step with theirs. Nothing shows when you're alone.
 *
 *   together / onTogether   the "play together" switch, when this track is yours to edit
 */
export default function PeerList({ together = false, onTogether = null }) {
  const peers = usePeers()
  const me = usePresence()
  if (!peers.length) return null
  // someone who isn't signed in is here to watch: their dot is hollow
  const names = peers.map((p) => (p.edit ? p.name : `${p.name} (watching)`)).join(', ')
  return (
    <span className="peer-list">
      <span className="peer-dots" title={`${names} ${peers.length === 1 ? 'is' : 'are'} here too`}>
        {me && <span className="peer-dot me" style={{ '--peer': me.color }}>{me.name.slice(0, 1).toUpperCase()}</span>}
        {peers.map((p) => (
          <span key={p.id} className={`peer-dot ${p.edit ? '' : 'watching'}`} style={{ '--peer': p.color }}>{p.name.slice(0, 1).toUpperCase()}</span>
        ))}
      </span>
      {onTogether && me?.edit && (
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
