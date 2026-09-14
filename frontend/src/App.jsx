import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useMatch, useNavigate } from 'react-router-dom'
import { StrudelMirror } from '@strudel/codemirror'
import { silence } from '@strudel/core'
import { getDrawContext } from '@strudel/draw'
import { transpiler } from '@strudel/transpiler'
import { getAudioContext, webaudioOutput, initAudioOnFirstClick } from '@strudel/webaudio'
import { prebake } from '@strudel/repl/prebake.mjs'
import { useUser } from './bwnd'
import { api, clearDraft, readDraft, timeAgo, trackUrl, writeDraft } from './api'
import Browser from './Browser.jsx'

const DEFAULT_CODE = `// Strudel — Ctrl/Cmd+Enter to play, Ctrl/Cmd+. to stop
setcpm(120/4)

stack(
  s("bd*4, [~ sd]*2, hh*8").bank("RolandTR909").gain(.9),
  note("<c2 eb2 f2 g2>").s("sawtooth").lpf(sine.range(300, 1800).slow(8)).decay(.2).sustain(0),
  n("<0 2 4 [6 4]>*2").scale("C4:minor").s("triangle").room(.4).delay(.25)
)`

function scratchCode() {
  let legacy = null
  try { legacy = localStorage.getItem('strudel:code') } catch { /* storage unavailable */ }
  return readDraft(null) ?? legacy ?? DEFAULT_CODE
}

initAudioOnFirstClick()

export default function App() {
  const trackId = useMatch('/t/:id')?.params.id || null
  const navigate = useNavigate()
  const { user, loading: userLoading, login, logout } = useUser()

  const rootRef = useRef(null)
  const editorRef = useRef(null)
  const loadedIdRef = useRef(undefined) // which track's code is in the editor right now
  const pendingPlayRef = useRef(null)
  const countedRef = useRef(new Set())

  const [code, setCode] = useState('')
  const [track, setTrack] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState('public')
  const [started, setStarted] = useState(false)
  const [evalError, setEvalError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [browserOpen, setBrowserOpen] = useState(false)

  const isNew = !trackId
  const isOwner = !!track?.is_owner
  const canEdit = isNew || isOwner
  const codeChanged = !!track && code !== track.code
  const metaChanged = isOwner && (title !== track.title || visibility !== track.visibility)
  const dirty = isNew || codeChanged || metaChanged

  const toastTimer = useRef(null)
  const flash = useCallback((msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2200)
  }, [])

  // One editor for the life of the page; tracks are swapped into it.
  useEffect(() => {
    if (editorRef.current) return // StrictMode mounts twice in dev
    editorRef.current = new StrudelMirror({
      defaultOutput: webaudioOutput,
      getTime: () => getAudioContext().currentTime,
      transpiler,
      root: rootRef.current,
      initialCode: '',
      pattern: silence,
      drawTime: [-2, 2],
      drawContext: getDrawContext(),
      prebake,
      onUpdateState: (state) => {
        setStarted(state.started)
        setEvalError(state.evalError ? String(state.evalError.message || state.evalError) : null)
        setCode(state.code)
      },
    })
    editorRef.current.setFontFamily('"Martian Mono", ui-monospace, monospace')
    editorRef.current.editor.focus()
  }, [])

  const putCode = useCallback((id, text) => {
    editorRef.current.setCode(text)
    loadedIdRef.current = id
  }, [])

  const play = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.evaluate()
    const id = loadedIdRef.current
    if (id && !countedRef.current.has(id)) {
      countedRef.current.add(id)
      api(`/tracks/${id}/play`, { method: 'POST' }).catch(() => {})
    }
  }, [])

  // Load whatever the URL points at: the scratch pad at /, or a saved track.
  useEffect(() => {
    let alive = true
    loadedIdRef.current = undefined
    setLoadError('')
    if (!trackId) {
      setTrack(null)
      setTitle('')
      setVisibility('public')
      putCode(null, scratchCode())
      return
    }
    setTrack((t) => (t?.id === trackId ? t : null))
    api(`/tracks/${trackId}`)
      .then((t) => {
        if (!alive) return
        setTrack(t)
        setTitle(t.title)
        setVisibility(t.visibility)
        putCode(trackId, readDraft(trackId) ?? t.code)
        if (pendingPlayRef.current === trackId) {
          pendingPlayRef.current = null
          play()
        }
      })
      .catch((e) => { if (alive) setLoadError(e.status === 404 ? 'This track doesn’t exist, or it’s private.' : e.message) })
    return () => { alive = false }
  }, [trackId, user?.id, putCode, play])

  // Keep unsaved edits per track in this browser, so nothing is lost on navigation or sign-in.
  useEffect(() => {
    const id = trackId || null
    if (loadedIdRef.current !== id) return
    if (id && track?.id === id && code === track.code) clearDraft(id)
    else if (code) writeDraft(id, code)
  }, [code, trackId, track])

  const save = useCallback(async () => {
    if (!canEdit || busy) return
    if (!user) return login()
    setBusy(true)
    try {
      const body = { title: title.trim() || 'untitled', code: editorRef.current.code, visibility }
      if (isNew) {
        const t = await api('/tracks', { method: 'POST', body })
        clearDraft(null)
        navigate(`/t/${t.id}`)
      } else {
        const t = await api(`/tracks/${trackId}`, { method: 'PUT', body })
        setTrack(t)
        setTitle(t.title)
        clearDraft(trackId)
      }
      setRefreshKey((k) => k + 1)
      flash('Saved')
    } catch (e) {
      flash(`Couldn’t save: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [canEdit, busy, user, login, title, visibility, isNew, trackId, navigate, flash])

  const remix = async () => {
    if (!user) return login()
    setBusy(true)
    try {
      const t = await api('/tracks', {
        method: 'POST',
        body: { title: `${track.title} (remix)`.slice(0, 80), code: editorRef.current.code, visibility: 'public', forked_from: track.id },
      })
      clearDraft(track.id)
      navigate(`/t/${t.id}`)
      setRefreshKey((k) => k + 1)
      flash('Remixed into your tracks')
    } catch (e) {
      flash(`Couldn’t remix: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const like = async () => {
    if (!user) return login()
    try {
      const r = await api(`/tracks/${track.id}/like`, { method: 'POST' })
      setTrack((t) => ({ ...t, ...r }))
      setRefreshKey((k) => k + 1)
    } catch (e) {
      flash(e.message)
    }
  }

  const share = async () => {
    const url = trackUrl(track.id)
    try {
      await navigator.clipboard.writeText(url)
      flash(track.visibility === 'private' ? 'Link copied — but this track is private, only you can open it' : 'Link copied')
    } catch {
      window.prompt('Copy this link', url)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete “${track.title}”? This can’t be undone.`)) return
    try {
      await api(`/tracks/${track.id}`, { method: 'DELETE' })
      clearDraft(track.id)
      setRefreshKey((k) => k + 1)
      navigate('/')
      flash('Deleted')
    } catch (e) {
      flash(`Couldn’t delete: ${e.message}`)
    }
  }

  const revert = () => {
    putCode(track.id, track.code)
    clearDraft(track.id)
  }

  const playFromList = (id) => {
    setBrowserOpen(false)
    if (id === trackId && loadedIdRef.current === id) return play()
    pendingPlayRef.current = id
    navigate(`/t/${id}`)
  }

  // Page-wide shortcuts (Strudel's own only fire while the editor has focus). Capture
  // phase + stopPropagation so a focused editor doesn't run them a second time.
  const keysRef = useRef({})
  keysRef.current = { play, save }
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey
      if (!(mod || e.altKey)) return
      if (e.key === 'Enter') keysRef.current.play()
      else if (e.key === '.' || e.code === 'Period') editorRef.current?.stop()
      else if (mod && e.key.toLowerCase() === 's') keysRef.current.save()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div className={`studio ${browserOpen ? 'browser-open' : ''}`}>
      <header className="bar">
        <button className="btn ghost browse-toggle" onClick={() => setBrowserOpen((o) => !o)} aria-label="Browse tracks">tracks</button>
        <Link to="/" className="logo" aria-label="strudel, home">strudel</Link>
        <button className={`btn play ${started ? 'on' : ''}`} onClick={play}>{started ? 'update' : 'play'}</button>
        <button className="btn stop" onClick={() => editorRef.current?.stop()} disabled={!started}>stop</button>
        <CycleMeter editorRef={editorRef} started={started} />
        <span className="hint">ctrl/cmd + enter play · + . stop · + s save</span>
        <span className="spacer" />
        {userLoading ? null : user ? (
          <span className="user">
            <span className="avatar" aria-hidden>{(user.name || user.email || '?').trim()[0].toUpperCase()}</span>
            <span className="user-name">{user.name || user.email}</span>
            <button className="linkish" onClick={() => logout(window.location.pathname)}>Sign out</button>
          </span>
        ) : (
          <button className="btn primary" onClick={() => login()}>Sign in</button>
        )}
      </header>

      <div className="body">
        <Browser
          user={user}
          login={login}
          activeId={trackId}
          refreshKey={refreshKey}
          onPlay={playFromList}
          onPick={() => setBrowserOpen(false)}
        />
        <div className="scrim" onClick={() => setBrowserOpen(false)} />

        <main className="main">
          <div className="trackbar">
            {loadError ? (
              <span className="meta">{loadError} <Link className="linkish" to="/">Start a new track</Link></span>
            ) : trackId && !track ? (
              <span className="meta">Loading…</span>
            ) : canEdit ? (
              <>
                <input
                  className="title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="untitled"
                  maxLength={80}
                  aria-label="Track title"
                />
                <select className="select" value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="Who can see it">
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted (link only)</option>
                  <option value="private">Private</option>
                </select>
                <button className="btn primary" onClick={save} disabled={busy || (!!user && !dirty)}>
                  {!user ? 'Sign in to save' : busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                </button>
                {isOwner && <button className="btn" onClick={share}>Share</button>}
                {isOwner && <button className="btn ghost danger" onClick={remove}>Delete</button>}
                <span className="meta">
                  {isNew ? 'Scratch pad · not saved yet' : <>♥{track.likes} · {track.plays} plays · saved {timeAgo(track.updated_at)}</>}
                  {track?.parent && <> · remix of <Link className="linkish" to={`/t/${track.parent.id}`}>{track.parent.title}</Link></>}
                </span>
              </>
            ) : (
              <>
                <div className="track-heading">
                  <span className="track-title">{track.title}</span>
                  <span className="meta">
                    by {track.author} · {track.plays} plays · {timeAgo(track.updated_at)}
                    {track.parent && <> · remix of <Link className="linkish" to={`/t/${track.parent.id}`}>{track.parent.title}</Link></>}
                  </span>
                </div>
                <button className={`btn ${track.liked ? 'on' : ''}`} onClick={like}>♥{track.likes}</button>
                <button className="btn" onClick={remix} disabled={busy}>Remix</button>
                <button className="btn" onClick={share}>Share</button>
                {codeChanged && <span className="meta">edited locally · <button className="linkish" onClick={revert}>revert</button></span>}
              </>
            )}
          </div>
          <div className="editor" ref={rootRef} />
          {evalError && <pre className="error">{evalError}</pre>}
        </main>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

/** Where we are in the current cycle, Tidal's unit of time. Moves only while a pattern
 *  plays, so Stop is its pause control; hidden under prefers-reduced-motion (CSS). */
function CycleMeter({ editorRef, started }) {
  const barRef = useRef(null)
  const numRef = useRef(null)
  useEffect(() => {
    if (!started) {
      barRef.current?.style.setProperty('--phase', 0)
      if (numRef.current) numRef.current.textContent = '0'
      return
    }
    let frame
    const tick = () => {
      const cycle = editorRef.current?.repl.scheduler.now() || 0
      barRef.current?.style.setProperty('--phase', cycle - Math.floor(cycle))
      if (numRef.current) numRef.current.textContent = String(Math.floor(cycle))
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [started, editorRef])
  return (
    <span className={`cycle ${started ? 'running' : ''}`} aria-hidden>
      <span className="cycle-label">cycle <span ref={numRef}>0</span></span>
      <span className="cycle-bar" ref={barRef} />
    </span>
  )
}
