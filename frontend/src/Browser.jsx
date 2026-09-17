import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, timeAgo } from './api'
import TrackPage from './TrackPage.jsx'
import { Glass } from './Glass.jsx'
import './Browser.css'

const VIEWS = [['explore', 'explore'], ['mine', 'mine'], ['liked', 'liked']]
const SORTS = [['new', 'new'], ['top', 'top'], ['opened', 'opened']]

/** A soft sliding switch between a few options (same family as the canvas switch). */
function Switch({ options, value, onChange, label, small = false }) {
  const at = Math.max(0, options.findIndex(([key]) => key === value))
  return (
    <div className={`b-switch ${small ? 'small' : ''}`} role="group" aria-label={label} style={{ '--n': options.length, '--at': at }}>
      <Glass className="b-switch-thumb" aria-hidden />
      {options.map(([key, text]) => (
        <button key={key} type="button" className={`b-switch-opt ${value === key ? 'on' : ''}`} aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>
      ))}
    </div>
  )
}

export default function Browser({ user, login, activeId, refreshKey, onPlay, onPick, onNew, view = 'explore', onView, narrowTo = null, onOpenTrack }) {
  const setView = onView
  // Where you are in the browser lives in the address, so reloading keeps it, the back
  // button walks out of it, and "everything by this person" is a link you can send.
  const [params, setParams] = useSearchParams()
  const [sort, setSort] = useState(() => params.get('sort') || 'new')
  const [page, setPage] = useState(() => params.get('track') || null) // one track's own page
  const [q, setQ] = useState(() => params.get('q') || '')
  const [tracks, setTracks] = useState(null)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  const [filling, setFilling] = useState(false)
  const next = useRef(0)
  // narrowing the list to one person, or to what came out of one track
  const [only, setOnly] = useState(() => (params.get('by')
    ? { author: params.get('by'), name: params.get('who') || 'this person' }
    : params.get('copies')
      ? { remixesOf: params.get('copies'), name: params.get('who') || 'copies' }
      : null))

  const needsUser = view !== 'explore' && !user
  const PAGE = 24

  const query = useCallback((offset) => {
    const params = new URLSearchParams({ view, sort, q, limit: String(PAGE), offset: String(offset) })
    if (only?.author) params.set('author', only.author)
    if (only?.remixesOf) params.set('remixes_of', only.remixesOf)
    return api(`/tracks?${params}`)
  }, [view, sort, q, only])

  useEffect(() => {
    if (needsUser) { setTracks([]); setError(''); setMore(false); return undefined }
    let alive = true
    setTracks(null)
    const timer = setTimeout(() => {
      query(0)
        .then((d) => {
          if (!alive) return
          setTracks(d.tracks)
          setMore(!!d.more)
          next.current = d.offset ?? d.tracks.length
          setError('')
        })
        .catch((e) => { if (alive) setError(e.message) })
    }, q ? 250 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, needsUser, refreshKey, user?.id])

  /** The next page, once you've scrolled to the end of this one. */
  const fill = useCallback(() => {
    if (filling || !more) return
    setFilling(true)
    query(next.current)
      .then((d) => {
        setTracks((was) => {
          const seen = new Set((was ?? []).map((t) => t.id))
          return [...(was ?? []), ...d.tracks.filter((t) => !seen.has(t.id))]
        })
        setMore(!!d.more)
        next.current = d.offset ?? next.current + d.tracks.length
      })
      .catch((e) => setError(e.message))
      .finally(() => setFilling(false))
  }, [filling, more, query])

  const endRef = useRef(null)
  useEffect(() => {
    const el = endRef.current
    if (!el || !more) return undefined
    const eye = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) fill() }, { rootMargin: '400px' })
    eye.observe(el)
    return () => eye.disconnect()
  }, [more, fill])

  /**
   * The cards lean toward the pointer: where it is over the card sets two angles, and the
   * card is drawn in perspective from them. While the pointer is on it the lean follows
   * closely; when it leaves, it eases back level on its own.
   */
  const lean = (e) => {
    const card = e.currentTarget
    const r = card.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    card.style.setProperty('--ry', `${(x * 7).toFixed(2)}deg`)
    card.style.setProperty('--rx', `${(-y * 7).toFixed(2)}deg`)
    card.dataset.live = '1'
  }
  const level = (e) => {
    const card = e.currentTarget
    delete card.dataset.live
    card.style.setProperty('--rx', '0deg')
    card.style.setProperty('--ry', '0deg')
  }

  // going back to the whole list, or into one person's, resets where paging is
  const narrow = (to) => { next.current = 0; setOnly(to) }
  // opened already narrowed (a track's copies, say)
  useEffect(() => { if (narrowTo) narrow(narrowTo) }, [narrowTo])

  useEffect(() => {
    const now = new URLSearchParams(window.location.search || params.toString())
    const set = (k, v) => (v ? now.set(k, v) : now.delete(k))
    set('browse', view)
    set('sort', sort === 'new' ? '' : sort)
    set('q', q)
    set('by', only?.author || '')
    set('copies', only?.remixesOf || '')
    set('who', only?.name || '')
    set('track', page || '')
    // typing or sorting rewrites where you are; going into someone's tracks is a place you
    // can come back out of
    setParams(now, { replace: !only })
  }, [view, sort, q, only, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const heading = only?.name ? only.name
    : view === 'mine' ? 'Your tracks' : view === 'liked' ? 'Tracks you liked' : 'Shared tracks'

  if (page) {
    return (
      <section className="browser one" aria-label="Track">
        <TrackPage
          id={page}
          user={user}
          onClose={() => setPage(null)}
          onOpen={(id, asPage, title) => (asPage ? setPage(id) : onOpenTrack?.(id, title))}
          onAuthor={(author, name) => { setPage(null); narrow({ author, name }) }}
        />
      </section>
    )
  }

  return (
    <section className="browser" aria-label="Browse tracks">
      <aside className="b-side">
        <h2 className="b-title">Browse</h2>

        <Switch label="Which tracks" options={VIEWS} value={view} onChange={(v) => { narrow(null); setView(v) }} />

        {only && (
          <button type="button" className="b-narrowed" onClick={() => narrow(null)}>
            <span className="b-narrowed-what">{only.name}</span>
            <span className="b-narrowed-out">show everything</span>
          </button>
        )}

        <label className="b-search">
          <svg viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4 14 14" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tracks or people" aria-label="Search tracks or people" spellCheck={false} />
          {q && <button type="button" className="b-search-clear" onClick={() => setQ('')} aria-label="Clear the search">×</button>}
        </label>

        <div className="b-field">
          <span className="b-label">Sort</span>
          <Switch small label="Sort" options={SORTS} value={sort} onChange={setSort} />
        </div>

      </aside>

      <div className="b-main">
        <div className="b-main-head">
          <h3>{heading}</h3>
          {tracks?.length > 0 && <span className="b-count">{tracks.length}{tracks.length === 50 ? '+' : ''}</span>}
          <div className="b-new" role="group" aria-label="Start a track">
            <button type="button" className="b-button small new-demo" onClick={() => onNew('demo')} title="Open the demo patch to pull apart">Demo patch</button>
            <button type="button" className="b-button small primary new-track" onClick={() => onNew('blank')}><span aria-hidden>+</span> New track</button>
          </div>
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
            {!q && view !== 'liked' && <button type="button" className="b-button primary" onClick={() => onNew('blank')}>New track</button>}
          </div>
        ) : (
          <ul className="b-grid">
            {tracks.map((t) => (
              <li
                key={t.id}
                className={`b-card ${t.id === activeId ? 'active' : ''}`}
                onPointerMove={lean}
                onPointerLeave={level}
              >
                <button type="button" className="b-play" aria-label={`Play ${t.title}`} title="Play" onClick={() => onPlay(t.id)}>
                  <svg viewBox="0 0 16 16" aria-hidden><path d="M5 3.5v9l8-4.5z" /></svg>
                </button>
                <div className="b-card-body">
                  <button type="button" className="b-card-title" onClick={() => setPage(t.id)} title={t.title}>{t.title}</button>
                  <button
                    type="button"
                    className="b-card-author"
                    onClick={() => narrow({ author: t.author_id, name: t.author })}
                    data-tip={`Everything ${t.author} has shared`}
                  >{t.author}</button>
                </div>
                <div className="b-card-meta">
                  <span className={t.liked ? 'liked' : ''}>♥ {t.likes}</span>
                  <span>{t.plays} open{t.plays === 1 ? '' : 's'}</span>
                  <span className="b-card-time">{timeAgo(t.updated_at)}</span>
                  {view === 'mine' && t.visibility !== 'public' && <span className="b-tag">{t.visibility}</span>}
                  {t.id === activeId && <span className="b-tag on">open</span>}
                  {t.forked_from && <span className="b-tag quiet" data-tip="Started as a copy of another track">copy</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {tracks?.length > 0 && (
          <div className="b-end" ref={endRef}>
            {more
              ? <button type="button" className="b-button" onClick={fill} disabled={filling}>{filling ? 'loading…' : 'load more'}</button>
              : <span className="b-end-note">that’s everything</span>}
          </div>
        )}
      </div>
    </section>
  )
}
