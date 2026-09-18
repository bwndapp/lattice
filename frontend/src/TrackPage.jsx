import { useEffect, useRef, useState } from 'react'
import { api, timeAgo } from './api'
import { parseProject } from './project'
import { changesBetween, summarise } from './history.js'
import { previewTrack, stopPreview } from './audio'
import './TrackPage.css'

const when = (s) => new Date(s * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const day = (s) => new Date(s * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })

/** What a track is made of, as a few things you can read at a glance. */
function facts(project) {
  if (!project) return null
  const parts = project.patterns?.length ?? 0
  const nodes = (project.nodes ?? []).filter((n) => n.type !== 'output').length
  const clips = project.song?.clips?.length ?? 0
  return [
    [`${project.bpm}`, 'bpm'],
    [`${parts}`, parts === 1 ? 'part' : 'parts'],
    [`${nodes}`, nodes === 1 ? 'node' : 'nodes'],
    clips ? [`${clips}`, clips === 1 ? 'clip' : 'clips'] : null,
  ].filter(Boolean)
}

/**
 * A track's own page: what it is, where it came from, and everything that's happened to it.
 *
 * The history is the point. A save is a fixed thing — you can hear exactly what the track
 * sounded like then, and you can branch off it, which makes a track of your own hanging
 * from that save. Nothing up the line ever changes: you don't rewind a track, you take it
 * somewhere else from where it was. Copies other people made hang off the same line at the
 * save they left from, so the whole page reads as one tree growing downward.
 */
export default function TrackPage({ id, user, login, onOpen, onClose, onAuthor }) {
  const [track, setTrack] = useState(null)
  const [error, setError] = useState('')
  const [copies, setCopies] = useState([])
  const [saves, setSaves] = useState(null)
  const [changes, setChanges] = useState({})
  const [shown, setShown] = useState(() => new Set())
  const [hearing, setHearing] = useState(null) // which save is playing: a version id, or 'now'
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const kept = useRef(new Map())

  useEffect(() => {
    let alive = true
    setTrack(null); setError(''); setSaves(null); setCopies([]); setChanges({}); setShown(new Set()); setNote('')
    kept.current = new Map()
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

  /** A save's code and its project, fetched once and kept for the rest of the visit. */
  const savedAs = async (versionId) => {
    if (versionId === 'now') return { code: track.code, project: parseProject(track.code || '') }
    if (kept.current.has(versionId)) return kept.current.get(versionId)
    const full = await api(`/tracks/${id}/versions/${versionId}`)
    const got = { code: full.code, project: parseProject(full.code) }
    kept.current.set(versionId, got)
    return got
  }

  const reveal = async (v, before) => {
    setShown((was) => { const next = new Set(was); next.has(v.id) ? next.delete(v.id) : next.add(v.id); return next })
    if (changes[v.id]) return
    setChanges((c) => ({ ...c, [v.id]: 'loading' }))
    try {
      const [now, then] = await Promise.all([savedAs(v.id), before ? savedAs(before.id) : null])
      setChanges((c) => ({ ...c, [v.id]: before ? changesBetween(then.project, now.project) : 'first' }))
    } catch {
      setChanges((c) => ({ ...c, [v.id]: 'none' }))
    }
  }

  // hearing it costs nothing: no loading, and whatever you have open stays where it is
  useEffect(() => () => stopPreview(), [id])
  const hear = async (key) => {
    if (hearing === key) { stopPreview(); return setHearing(null) }
    setHearing(key)
    try {
      const { project } = await savedAs(key)
      await previewTrack(project, { cycles: 16 })
    } catch {
      setHearing(null)
      setNote('Couldn’t play that save.')
    }
  }

  /**
   * A track of your own, from this save. It hangs off this one at the point it was taken,
   * so it shows up on this page's line exactly where you left.
   */
  const branch = async (v) => {
    if (!user) return login?.()
    setBusy(true)
    setNote('')
    try {
      const { code } = await savedAs(v.id)
      const from = v.id === 'now' ? 'copy' : `from ${day(v.saved_at)}`
      const made = await api('/tracks', {
        method: 'POST',
        body: {
          title: `${track.title} (${from})`.slice(0, 80),
          code,
          visibility: 'public',
          forked_from: track.id,
          forked_at: v.saved_at,
        },
      })
      stopPreview()
      onOpen(made.id, false, made.title)
    } catch (e) {
      setNote(`Couldn’t branch that save: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  if (error) return <section className="tp"><p className="tp-error">Couldn’t open that track: {error}</p><button type="button" className="b-button" onClick={onClose}>back</button></section>
  if (!track) return <section className="tp"><p className="tp-quiet">Loading…</p></section>

  const project = parseProject(track.code || '')
  const shape = facts(project)

  /**
   * The track as a line you can read down: its saves oldest first, and each copy hanging
   * off the save it was taken from. Someone else's track has no saves to show, so the
   * copies hang off the one point there is — the track itself.
   */
  const points = track.is_owner && saves?.length
    ? [...saves].reverse().map((v) => ({ ...v, forks: [] }))
    : [{ id: 'now', saved_at: track.updated_at, only: true, forks: [] }]
  for (const c of copies) {
    const at = c.forked_at ?? c.created_at
    // the last save it could have been taken from
    let spot = points[0]
    for (const p of points) if (p.saved_at <= at) spot = p
    spot.forks.push(c)
  }
  const line = track.is_owner || copies.length ? points : []

  return (
    <section className="tp" aria-label={`About ${track.title}`}>
      <header className="tp-head">
        <button type="button" className="tp-back" onClick={onClose}>← browse</button>
        <div className="tp-title-row">
          <h2 className="tp-title">{track.title}</h2>
          {track.visibility !== 'public' && <span className="b-tag">{track.visibility}</span>}
        </div>
        <p className="tp-by">
          by <button type="button" className="tp-author" onClick={() => onAuthor(track.author_id, track.author)}>{track.author}</button>
          {' · '}last saved {timeAgo(track.updated_at)}
          {track.parent && (
            <> · from <button type="button" className="tp-link" onClick={() => onOpen(track.parent.id, true)}>{track.parent.title}</button></>
          )}
        </p>

        {shape && (
          <ul className="tp-facts">
            {shape.map(([n, label]) => <li key={label}><b>{n}</b> {label}</li>)}
            <li><b>{track.likes}</b> {track.likes === 1 ? 'like' : 'likes'}</li>
            <li><b>{track.plays}</b> {track.plays === 1 ? 'open' : 'opens'}</li>
            {copies.length > 0 && <li><b>{copies.length}</b> {copies.length === 1 ? 'branch' : 'branches'}</li>}
          </ul>
        )}

        <div className="tp-actions">
          <button type="button" className="b-button primary" onClick={() => { stopPreview(); onOpen(track.id, false, track.title) }}>open in the studio</button>
          <button type="button" className={`b-button ${hearing === 'now' ? 'on' : ''}`} onClick={() => hear('now')}>
            {hearing === 'now' ? 'stop' : 'preview'}
          </button>
          <button
            type="button"
            className="b-button"
            onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/t/${track.id}`); setNote('Link copied.') }}
          >copy link</button>
        </div>
        {note && <p className="tp-note">{note}</p>}
        {!user && <p className="tp-quiet">Sign in to branch this into a track of your own.</p>}
      </header>

      <section className="tp-block">
        <h3 className="tp-h">
          {track.is_owner ? 'How it got here' : 'What came out of it'}
          {line.length ? <span className="tp-count">{line.length}</span> : null}
        </h3>
        <p className="tp-lede">
          {track.is_owner
            ? 'Every save is still here. Hear one as it was, or branch off it — the branch is yours and this track carries on untouched.'
            : 'Tracks people took from this one, and where they left.'}
        </p>
        {track.is_owner && !saves && <p className="tp-quiet">Reading the saves…</p>}
        {!line.length && <p className="tp-quiet">{track.is_owner ? 'No saves kept yet.' : 'Nobody has branched this yet.'}</p>}

        {/* oldest at the top: the line reads down the way the track was made, with the
            copies people took branching off it where they left */}
        <ol className="tp-saves">
          {line.map((v, i, all) => {
            const latest = i === all.length - 1
            return (
              <li key={v.id} className={`tp-save ${v.forks.length ? 'branching' : ''} ${hearing === v.id ? 'playing' : ''} ${latest ? 'latest' : ''}`}>
                <span className="tp-dot" aria-hidden />
                <div className="tp-save-what">
                  <div className="tp-save-top">
                    <span className="tp-save-when">{when(v.saved_at)}</span>
                    {latest && <span className="tp-here">where it is now</span>}
                    {i === 0 && all.length > 1 && track.is_owner && <span className="tp-here quiet">the oldest save kept</span>}
                    <span className="tp-save-acts">
                      <button
                        type="button"
                        className={`tp-act ${hearing === v.id ? 'on' : ''}`}
                        onClick={() => hear(v.id)}
                      >{hearing === v.id ? 'stop' : 'hear this'}</button>
                      <button type="button" className="tp-act" disabled={busy} onClick={() => branch(v)}>
                        branch from here
                      </button>
                    </span>
                  </div>
                  {!v.only && (
                    <button type="button" className="tp-save-more" onClick={() => reveal(v, all[i - 1])}>
                      <span className="tp-chev" aria-hidden>{shown.has(v.id) ? '▾' : '▸'}</span>
                      {Array.isArray(changes[v.id]) ? summarise(changes[v.id]) : 'what changed'}
                    </button>
                  )}
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
                  {v.forks.map((f) => (
                    <div key={f.id} className="tp-fork">
                      <span className="tp-fork-arm" aria-hidden />
                      <button type="button" className="tp-link" onClick={() => onOpen(f.id, true)}>{f.title}</button>
                      <span className="tp-fork-by"> — {f.author}, {timeAgo(f.forked_at ?? f.created_at)}</span>
                    </div>
                  ))}
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </section>
  )
}
