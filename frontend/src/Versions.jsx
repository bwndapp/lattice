import { useEffect, useRef, useState } from 'react'
import { api, timeAgo } from './api'
import './Versions.css'

const when = (seconds) => {
  const d = new Date(seconds * 1000)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `today, ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** What a version holds, in words you'd recognise it by. */
function summary(v) {
  if (v.kind !== 'patch') return plural(v.lines, 'line') + ' of code'
  if (!v.nodes && !v.patterns) return 'empty patch'
  return [plural(v.nodes, 'node'), v.effects ? plural(v.effects, 'effect') : null, plural(v.patterns, 'pattern'), v.clips ? plural(v.clips, 'clip') : null, v.automations ? plural(v.automations, 'automation') : null].filter(Boolean).join(' · ')
}

/**
 * The track as it was at each earlier save (the last 60 are kept). Opening one puts it in
 * the editor: listen, then save to keep it, or undo to go back.
 */
export default function Versions({ trackId, savedCode, onOpen, onClose }) {
  const ref = useRef(null)
  const [versions, setVersions] = useState(null)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])
  useEffect(() => {
    api(`/tracks/${trackId}/versions`).then((d) => setVersions(d.versions)).catch((e) => setError(e.message))
  }, [trackId])

  const open = async (v) => {
    setOpening(v.id)
    try {
      const full = await api(`/tracks/${trackId}/versions/${v.id}`)
      onOpen(full)
    } catch (e) {
      setError(e.message)
      setOpening(null)
    }
  }

  return (
    <dialog
      ref={ref}
      className="versions-dialog"
      aria-labelledby="versions-title"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      <div className="vs-body">
        <div className="vs-head">
          <h2 id="versions-title" className="vs-title">Earlier saves</h2>
          <button type="button" className="btn ghost" onClick={onClose}>close</button>
        </div>
        <p className="vs-note">Each time you save, the version before it is kept here. Open one to hear it — nothing is overwritten until you save again, and ctrl/cmd + Z puts things back.</p>
        {error && <p className="vs-error">Couldn’t load the versions: {error}</p>}
        {!versions && !error && <p className="vs-note">Loading…</p>}
        {versions && (
          <ol className="vs-list">
            {versions.map((v, i) => (
              <li key={v.id} className={`vs-row ${v.kind === 'patch' && !v.nodes && !v.patterns ? 'empty' : ''}`}>
                <div className="vs-when">
                  <span className="vs-time">{when(v.saved_at)}</span>
                  <span className="vs-ago">{timeAgo(v.saved_at)}{i === 0 ? ' · latest save' : ''}</span>
                </div>
                <div className="vs-what">
                  <span className="vs-name">{v.title}</span>
                  <span className="vs-summary">{summary(v)}</span>
                </div>
                <button type="button" className="btn vs-open" disabled={opening != null} onClick={() => open(v)}>
                  {opening === v.id ? 'opening…' : 'open'}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </dialog>
  )
}
