import { usePeers, usePresence } from './collab.js'

/** Who else has this track open, as a row of initials. Nothing when you're alone. */
export default function PeerList() {
  const peers = usePeers()
  const me = usePresence()
  if (!peers.length) return null
  return (
    <span className="peer-list" title={`${peers.map((p) => p.name).join(', ')} ${peers.length === 1 ? 'is' : 'are'} here too`}>
      {me && <span className="peer-dot me" style={{ '--peer': me.color }}>{me.name.slice(0, 1).toUpperCase()}</span>}
      {peers.map((p) => (
        <span key={p.id} className="peer-dot" style={{ '--peer': p.color }}>{p.name.slice(0, 1).toUpperCase()}</span>
      ))}
    </span>
  )
}
