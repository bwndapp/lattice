import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, timeAgo } from './api'
import { parseProject } from './project'
import { previewTrack, stopPreview } from './audio'
import TrackPage from './TrackPage.jsx'
import TrackMap from './TrackMap.jsx'
import BranchMark from './BranchMark.jsx'
import { Glass } from './Glass.jsx'
import LiveOnTrack from './LiveOnTrack.jsx'
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

export default function Browser({ user, login, activeId, refreshKey, onPick, onNew, started = false, view = 'explore', onView, narrowTo = null, onOpenTrack }) {
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

  // hearing one from the list: the same lightweight preview the track's page uses, so it
  // costs a click and nothing you have open changes
  const [playing, setPlaying] = useState(null)
  const codes = useRef(new Map())
  const playingRef = useRef(false)
  playingRef.current = started // the studio's own playback: don't cut that out from under it
  useEffect(() => () => stopPreview({ cut: !playingRef.current }), [])
  const hear = async (t) => {
    if (playing === t.id) { stopPreview({ cut: !started }); return setPlaying(null) }
    setPlaying(t.id)
    try {
      if (!codes.current.has(t.id)) codes.current.set(t.id, (await api(`/tracks/${t.id}`)).code)
      await previewTrack(parseProject(codes.current.get(t.id) || ''), {
        cycles: 16,
        cut: !started,
        onEnd: () => setPlaying((was) => (was === t.id ? null : was)),
      })
    } catch {
      setPlaying((was) => (was === t.id ? null : was))
    }
  }

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
          login={login}
          started={started}
          onClose={() => setPage(null)}
          onOpen={(id, asPage, title) => (asPage ? setPage(id) : onOpenTrack?.(id, title))}
          onAuthor={(author, name) => { setPage(null); narrow({ author, name }) }}
        />
      </section>
    )
  }

  return (
    <section className="browser" aria-label="Browse tracks" data-surface="browse">
      {/* what you're looking at, and how you're looking at it — over the results, not beside
          them, because it's about all of them rather than any one of them */}
      <header className="b-top">
        <Switch label="Which tracks" options={VIEWS} value={view} onChange={(v) => { narrow(null); setView(v) }} />

        <div className="b-find">
          <label className="b-search">
            <svg viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4 14 14" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tracks or people" aria-label="Search tracks or people" spellCheck={false} />
            {q && <button type="button" className="b-search-clear" onClick={() => setQ('')} aria-label="Clear the search">×</button>}
          </label>
          <Switch small label="Sort" options={SORTS} value={sort} onChange={setSort} />
        </div>

        {only && (
          <button type="button" className="b-narrowed" onClick={() => narrow(null)}>
            <span className="b-narrowed-what">{only.name}</span>
            <span className="b-narrowed-out">show everything ×</span>
          </button>
        )}

        <button type="button" className="b-button small primary b-new" onClick={() => onNew('blank')}>
          <span aria-hidden>+</span> new track
        </button>
      </header>

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
            {!q && view !== 'liked' && <button type="button" className="b-button primary" onClick={() => onNew('blank')}>New track</button>}
          </div>
        ) : (
          <ul className="b-grid">
            {tracks.map((t) => (
              <li key={t.id} className={`b-card ${t.id === activeId ? 'active' : ''}`}>
                <LiveOnTrack trackId={t.id} />
                <div className="b-art">
                  <TrackMap shape={t.shape} />
                  <button
                    type="button"
                    className={`b-play ${playing === t.id ? 'on' : ''}`}
                    aria-label={`${playing === t.id ? 'Stop' : 'Play'} ${t.title}`}
                    title={playing === t.id ? 'Stop' : 'Play'}
                    onClick={() => hear(t)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden>
                      {playing === t.id
                        ? <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
                        : <path d="M5 3.5v9l8-4.5z" />}
                    </svg>
                  </button>
                  {t.shape?.bpm ? <span className="b-art-tag">{t.shape.bpm}<i>bpm</i></span> : null}
                </div>
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
                  {t.parent && (
                    <button
                      type="button"
                      className="b-card-from"
                      onClick={() => setPage(t.parent.id)}
                      data-tip={`Opens ${t.parent.title} by ${t.parent.author}, the track this branched off`}
                    ><BranchMark />branch of <b>{t.parent.title}</b></button>
                  )}
                  {t.forked_from && !t.parent && (
                    <span className="b-tag quiet" data-tip="Branched off a track that isn't shared"><BranchMark />branch</span>
                  )}
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
