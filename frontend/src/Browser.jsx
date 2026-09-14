import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, timeAgo } from './api'

const VIEWS = ['explore', 'mine', 'liked']
const SORTS = [['new', 'new'], ['top', 'top'], ['played', 'played']]

/** 0..1 — how loud a track is in this list. Sets the size of its title. */
function weights(tracks) {
  const score = (t) => Math.log1p(t.plays + 3 * t.likes)
  const max = Math.max(1, ...tracks.map(score))
  return new Map(tracks.map((t) => [t.id, score(t) / max]))
}

export default function Browser({ user, login, activeId, refreshKey, onPlay, onPick }) {
  const [view, setView] = useState('explore')
  const [sort, setSort] = useState('new')
  const [q, setQ] = useState('')
  const [tracks, setTracks] = useState(null)
  const [error, setError] = useState('')

  const needsUser = view !== 'explore' && !user

  useEffect(() => {
    if (needsUser) { setTracks([]); setError(''); return }
    let alive = true
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ view, sort, q })
      api(`/tracks?${params}`)
        .then((d) => { if (alive) { setTracks(d.tracks); setError('') } })
        .catch((e) => { if (alive) setError(e.message) })
    }, q ? 250 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [view, sort, q, needsUser, refreshKey, user?.id])

  const weight = tracks ? weights(tracks) : new Map()

  return (
    <section className="browser" aria-label="Browse tracks">
      <div className="browser-controls">
      <h2 className="browser-title">browse</h2>
      {/* The controls are written as a Strudel pattern: <a b c> alternates, .method("x") chains. */}
      <div className="views" role="group" aria-label="Which tracks">
        <span className="syn" aria-hidden>&lt;</span>
        {VIEWS.map((key) => (
          <button key={key} className={`view ${view === key ? 'on' : ''}`} aria-pressed={view === key} onClick={() => setView(key)}>{key}</button>
        ))}
        <span className="syn" aria-hidden>&gt;</span>
      </div>
      <label className="chain">
        <span className="syn" aria-hidden>.filter("</span>
        <input className="chain-input" aria-label="Search tracks or people" placeholder="anything" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="syn" aria-hidden>")</span>
      </label>
      <label className="chain">
        <span className="syn" aria-hidden>.sort("</span>
        <select className="chain-input" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span className="syn" aria-hidden>")</span>
      </label>

      <Link to="/" className="new-track" onClick={onPick}>+ new track</Link>
      <p className="legend">bigger = played &amp; liked more</p>
      </div>

      <ol className="setlist">
        {needsUser ? (
          <li className="empty">
            <button className="linkish" onClick={() => login()}>Sign in</button> to see {view === 'mine' ? 'your tracks' : 'tracks you liked'}.
          </li>
        ) : error ? (
          <li className="empty">Couldn’t load tracks: {error}</li>
        ) : tracks === null ? (
          <li className="empty">loading…</li>
        ) : tracks.length === 0 ? (
          <li className="empty">{q ? 'Nothing matches that.' : view === 'explore' ? 'silence. share the first track.' : view === 'mine' ? 'You haven’t saved anything yet.' : 'No likes yet.'}</li>
        ) : tracks.map((t) => (
          <li key={t.id} className={`item ${t.id === activeId ? 'active' : ''}`} style={{ '--w': weight.get(t.id) }}>
            <Link to={`/t/${t.id}`} className="item-title" onClick={onPick}>{t.title}</Link>
            <span className="item-meta">
              <button className="item-play" aria-label={`Play ${t.title}`} onClick={() => onPlay(t.id)}>play</button>
              {' '}{t.author} · {timeAgo(t.updated_at)} · <span className={t.liked ? 'liked' : ''}>♥{t.likes}</span> · {t.plays} plays
              {view === 'mine' && t.visibility !== 'public' && <span className="pill">{t.visibility}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
