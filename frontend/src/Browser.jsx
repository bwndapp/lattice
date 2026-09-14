import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, timeAgo } from './api'

const VIEWS = [['explore', 'Explore'], ['mine', 'Mine'], ['liked', 'Liked']]
const SORTS = [['new', 'New'], ['top', 'Top'], ['played', 'Most played']]

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

  return (
    <aside className="browser">
      <div className="tabs">
        {VIEWS.map(([key, label]) => (
          <button key={key} className={`tab ${view === key ? 'on' : ''}`} onClick={() => setView(key)}>{label}</button>
        ))}
      </div>
      <div className="filters">
        <input className="search" placeholder="Search tracks or people" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          {SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <Link to="/" className="new-track" onClick={onPick}>+ New track</Link>
      <ul className="list">
        {needsUser ? (
          <li className="empty">
            <button className="linkish" onClick={() => login()}>Sign in</button> to see {view === 'mine' ? 'your tracks' : 'tracks you liked'}.
          </li>
        ) : error ? (
          <li className="empty">Couldn’t load tracks: {error}</li>
        ) : tracks === null ? (
          <li className="empty">Loading…</li>
        ) : tracks.length === 0 ? (
          <li className="empty">{q ? 'Nothing matches that search.' : view === 'explore' ? 'No shared tracks yet. Be the first.' : view === 'mine' ? 'You haven’t saved anything yet.' : 'No likes yet.'}</li>
        ) : tracks.map((t) => (
          <li key={t.id} className={`item ${t.id === activeId ? 'active' : ''}`}>
            <button className="item-play" title="Play" onClick={() => onPlay(t.id)}>▶︎</button>
            <Link to={`/t/${t.id}`} className="item-body" onClick={onPick}>
              <span className="item-title">{t.title}</span>
              <span className="item-meta">
                {t.author} · {timeAgo(t.updated_at)}
                {view === 'mine' && t.visibility !== 'public' && <span className="pill">{t.visibility}</span>}
              </span>
            </Link>
            <span className="item-stats">
              <span className={t.liked ? 'liked' : ''}>♥ {t.likes}</span>
              <span>▶︎ {t.plays}</span>
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
