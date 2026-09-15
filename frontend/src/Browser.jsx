import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, timeAgo } from './api'
import './Browser.css'

const VIEWS = [['explore', 'explore'], ['mine', 'mine'], ['liked', 'liked']]
const SORTS = [['new', 'new'], ['top', 'top'], ['played', 'played']]

/** A soft sliding switch between a few options (same family as the canvas switch). */
function Switch({ options, value, onChange, label, small = false }) {
  const at = Math.max(0, options.findIndex(([key]) => key === value))
  return (
    <div className={`b-switch ${small ? 'small' : ''}`} role="group" aria-label={label} style={{ '--n': options.length, '--at': at }}>
      <span className="b-switch-thumb" aria-hidden />
      {options.map(([key, text]) => (
        <button key={key} type="button" className={`b-switch-opt ${value === key ? 'on' : ''}`} aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>
      ))}
    </div>
  )
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
    setTracks(null)
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ view, sort, q })
      api(`/tracks?${params}`)
        .then((d) => { if (alive) { setTracks(d.tracks); setError('') } })
        .catch((e) => { if (alive) setError(e.message) })
    }, q ? 250 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [view, sort, q, needsUser, refreshKey, user?.id])

  const heading = view === 'mine' ? 'Your tracks' : view === 'liked' ? 'Tracks you liked' : 'Shared tracks'

  return (
    <section className="browser" aria-label="Browse tracks">
      <aside className="b-side">
        <h2 className="b-title">Browse</h2>

        <Switch label="Which tracks" options={VIEWS} value={view} onChange={setView} />

        <label className="b-search">
          <svg viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4 14 14" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tracks or people" aria-label="Search tracks or people" spellCheck={false} />
          {q && <button type="button" className="b-search-clear" onClick={() => setQ('')} aria-label="Clear the search">×</button>}
        </label>

        <div className="b-field">
          <span className="b-label">Sort</span>
          <Switch small label="Sort" options={SORTS} value={sort} onChange={setSort} />
        </div>

        <div className="b-new">
          <Link to="/" state={{ fresh: Date.now(), template: 'blank' }} className="b-button primary new-track" onClick={onPick}>New track</Link>
          <Link to="/" state={{ fresh: Date.now(), template: 'demo' }} className="b-button new-demo" onClick={onPick}>Demo patch</Link>
        </div>
      </aside>

      <div className="b-main">
        <div className="b-main-head">
          <h3>{heading}</h3>
          {tracks?.length > 0 && <span className="b-count">{tracks.length}{tracks.length === 50 ? '+' : ''}</span>}
        </div>

        {needsUser ? (
          <div className="b-empty">
            <p>Sign in to see {view === 'mine' ? 'your tracks' : 'the tracks you liked'}.</p>
            <button type="button" className="b-button primary" onClick={() => login()}>Sign in</button>
          </div>
        ) : error ? (
          <div className="b-empty"><p>Couldn’t load tracks: {error}</p></div>
        ) : tracks === null ? (
          <ul className="b-grid" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => <li key={i} className="b-card skeleton" aria-hidden />)}
          </ul>
        ) : tracks.length === 0 ? (
          <div className="b-empty">
            <p>{q ? 'Nothing matches that.' : view === 'explore' ? 'Nothing shared yet. Make the first track.' : view === 'mine' ? 'You haven’t saved anything yet.' : 'No likes yet.'}</p>
            {!q && view !== 'liked' && <Link to="/" state={{ fresh: Date.now(), template: 'blank' }} className="b-button primary" onClick={onPick}>New track</Link>}
          </div>
        ) : (
          <ul className="b-grid">
            {tracks.map((t) => (
              <li key={t.id} className={`b-card ${t.id === activeId ? 'active' : ''}`}>
                <button type="button" className="b-play" aria-label={`Play ${t.title}`} title="Play" onClick={() => onPlay(t.id)}>
                  <svg viewBox="0 0 16 16" aria-hidden><path d="M5 3.5v9l8-4.5z" /></svg>
                </button>
                <div className="b-card-body">
                  <Link to={`/t/${t.id}`} className="b-card-title" onClick={onPick} title={t.title}>{t.title}</Link>
                  <span className="b-card-author">{t.author}</span>
                </div>
                <div className="b-card-meta">
                  <span className={t.liked ? 'liked' : ''}>♥ {t.likes}</span>
                  <span>{t.plays} play{t.plays === 1 ? '' : 's'}</span>
                  <span className="b-card-time">{timeAgo(t.updated_at)}</span>
                  {view === 'mine' && t.visibility !== 'public' && <span className="b-tag">{t.visibility}</span>}
                  {t.id === activeId && <span className="b-tag on">open</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
