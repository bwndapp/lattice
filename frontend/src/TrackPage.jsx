import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, timeAgo } from './api'
import { parseProject } from './project'
import { changesBetween, summarise } from './history.js'
import './TrackPage.css'

const when = (s) => new Date(s * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** What a track is made of, in a line. */
function shape(project) {
  if (!project) return null
  const parts = project.patterns?.length ?? 0
  const nodes = (project.nodes ?? []).filter((n) => n.type !== 'output').length
  const clips = project.song?.clips?.length ?? 0
  return [
    `${project.bpm} bpm`,
    `${parts} part${parts === 1 ? '' : 's'}`,
    `${nodes} node${nodes === 1 ? '' : 's'}`,
    clips ? `${clips} clip${clips === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ')
}

/**
 * A track's own page: what it is, where it came from, what came out of it, and — if it's
 * yours — every save with what changed at it. The place you decide whether to open it,
 * take a copy and go your own way, or just see what someone did.
 */
export default function TrackPage({ id, user, onOpen, onClose, onAuthor, onPick }) {
  const [track, setTrack] = useState(null)
  const [error, setError] = useState('')
  const [copies, setCopies] = useState([])
  const [saves, setSaves] = useState(null)
  const [changes, setChanges] = useState({})
  const [shown, setShown] = useState(() => new Set())
  const [copying, setCopying] = useState(false)
  const projects = useRef(new Map())

  useEffect(() => {
    let alive = true
    setTrack(null); setError(''); setSaves(null); setCopies([]); setChanges({}); setShown(new Set())
    projects.current = new Map()
    api(`/tracks/${id}`)
      .then((t) => { if (alive) setTrack(t) })
      .catch((e) => { if (alive) setError(e.message) })
    api(`/tracks?remixes_of=${encodeURIComponent(id)}&limit=50`)
      .then((d) => { if (alive) setCopies(d.tracks ?? []) })
      .catch(() => {})
    return () => { alive = false }
  }, [id])

  // the saves are the owner's business, so only ask when they'd be allowed
  useEffect(() => {
    if (!track?.is_owner) return undefined
    let alive = true
    api(`/tracks/${id}/versions`)
      .then((d) => { if (alive) setSaves(d.versions) })
      .catch(() => { if (alive) setSaves([]) })
    return () => { alive = false }
  }, [id, track?.is_owner])

  const projectOf = async (versionId) => {
    if (projects.current.has(versionId)) return projects.current.get(versionId)
    const full = await api(`/tracks/${id}/versions/${versionId}`)
    const p = parseProject(full.code)
    projects.current.set(versionId, p)
    return p
  }

  const reveal = async (v, before) => {
    setShown((was) => { const next = new Set(was); next.has(v.id) ? next.delete(v.id) : next.add(v.id); return next })
    if (changes[v.id]) return
    setChanges((c) => ({ ...c, [v.id]: 'loading' }))
    try {
      const [now, then] = await Promise.all([projectOf(v.id), before ? projectOf(before.id) : null])
      setChanges((c) => ({ ...c, [v.id]: before ? changesBetween(then, now) : 'first' }))
    } catch {
      setChanges((c) => ({ ...c, [v.id]: 'none' }))
    }
  }

  /** Take it and go your own way: a copy of your own, still crediting this one. */
  const branch = async () => {
    setCopying(true)
    try {
      const full = await api(`/tracks/${id}`)
      const made = await api('/tracks', {
        method: 'POST',
        body: {
          title: `${full.title} (copy)`.slice(0, 80),
          code: full.code,
          visibility: 'public',
          forked_from: id,
        },
      })
      onOpen(made.id)
    } catch (e) {
      setError(e.message)
      setCopying(false)
    }
  }

  if (error) return <section className="tp"><p className="tp-error">Couldn’t open that track: {error}</p><button type="button" className="b-button" onClick={onClose}>back</button></section>
  if (!track) return <section className="tp"><p className="tp-quiet">Loading…</p></section>

  const project = parseProject(track.code || '')

  return (
    <section className="tp" aria-label={`About ${track.title}`}>
      <div className="tp-head">
        <button type="button" className="tp-back" onClick={onClose}>← browse</button>
        <div className="tp-title-row">
          <h2 className="tp-title">{track.title}</h2>
          {track.visibility !== 'public' && <span className="b-tag">{track.visibility}</span>}
        </div>
        <p className="tp-by">
          by <button type="button" className="tp-author" onClick={() => onAuthor(track.author_id, track.author)}>{track.author}</button>
          {' · '}saved {timeAgo(track.updated_at)}
        </p>
        <p className="tp-shape">{shape(project) ?? 'hand-written code'}</p>
        <div className="tp-actions">
          <Link to={`/t/${track.id}`} className="b-button primary" onClick={onPick}>open</Link>
          <button type="button" className="b-button" onClick={branch} disabled={copying || !user}>
            {copying ? 'copying…' : 'save a copy'}
          </button>
          <button
            type="button"
            className="b-button"
            onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/t/${track.id}`)}
          >copy link</button>
        </div>
        {!user && <p className="tp-quiet">Sign in to take a copy of this.</p>}
      </div>

      <div className="tp-stats">
        <span><b>{track.likes}</b> like{track.likes === 1 ? '' : 's'}</span>
        <span><b>{track.plays}</b> play{track.plays === 1 ? '' : 's'}</span>
        {track.parent && (
          <span>copy of <button type="button" className="tp-link" onClick={() => onOpen(track.parent.id, true)}>{track.parent.title}</button></span>
        )}
      </div>

      {copies.length > 0 && (
        <div className="tp-block">
          <h3 className="tp-h">Copies people made <span className="tp-count">{copies.length}</span></h3>
          <ul className="tp-copies">
            {copies.map((c) => (
              <li key={c.id}>
                <button type="button" className="tp-link" onClick={() => onOpen(c.id, true)}>{c.title}</button>
                <span className="tp-quiet"> by {c.author} · {timeAgo(c.updated_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {track.is_owner && (
        <div className="tp-block">
          <h3 className="tp-h">History {saves?.length ? <span className="tp-count">{saves.length}</span> : null}</h3>
          {!saves && <p className="tp-quiet">Reading the saves…</p>}
          {saves?.length === 0 && <p className="tp-quiet">No saves kept yet.</p>}
          {/* oldest at the top: the line reads down the way the track was made */}
          <ol className="tp-saves">
            {[...(saves ?? [])].reverse().map((v, i, all) => (
              <li key={v.id} className="tp-save">
                <span className="tp-dot" aria-hidden />
                <div className="tp-save-what">
                  <span className="tp-save-when">
                    {when(v.saved_at)}
                    {i === all.length - 1 ? ' · latest' : ''}
                    {i === 0 && all.length > 1 ? ' · where the history starts' : ''}
                  </span>
                  <button type="button" className="tp-link tp-save-more" onClick={() => reveal(v, all[i - 1])}>
                    {shown.has(v.id)
                      ? 'hide'
                      : Array.isArray(changes[v.id]) ? summarise(changes[v.id]) : 'what changed'}
                  </button>
                  {shown.has(v.id) && (
                    <div className="tp-diff">
                      {changes[v.id] === 'loading' && <span className="tp-quiet">reading…</span>}
                      {changes[v.id] === 'first' && <span className="tp-quiet">the oldest save kept — nothing before it to compare</span>}
                      {changes[v.id] === 'none' && <span className="tp-quiet">couldn’t compare these</span>}
                      {Array.isArray(changes[v.id]) && (changes[v.id].length
                        ? <ul className="tp-diff-list">{changes[v.id].map((c, k) => <li key={k}>{c}</li>)}</ul>
                        : <span className="tp-quiet">nothing changed in the music</span>)}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
