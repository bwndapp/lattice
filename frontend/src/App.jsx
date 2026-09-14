import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useMatch, useNavigate } from 'react-router-dom'
import { StrudelMirror } from '@strudel/codemirror'
import { Pattern, silence } from '@strudel/core'
import { getDrawContext } from '@strudel/draw'
import { transpiler } from '@strudel/transpiler'
import { getAudioContext, webaudioOutput, initAudioOnFirstClick } from '@strudel/webaudio'
import { prebake } from '@strudel/repl/prebake.mjs'
import { useUser } from './bwnd'
import { api, clearDraft, readDraft, timeAgo, trackUrl, writeDraft } from './api'
import Browser from './Browser.jsx'
import Playlist from './Playlist.jsx'
import { capturePatterns, tempoChange } from './lanes'

const DEFAULT_CODE = `// Strudel — Ctrl/Cmd+Enter to play, Ctrl/Cmd+. to stop
setcpm(120/4)

drums: s("bd*4, [~ sd]*2, hh*8").bank("RolandTR909").gain(.9)

bass: note("<c2 eb2 f2 g2>*2").s("sawtooth").lpf(sine.range(300, 1800).slow(8)).decay(.2).sustain(0)

lead: n("<0 2 4 [6 4]>*2").scale("C4:minor").s("triangle").room(.4).delay(.25)`

function readPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

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
  const [activeCode, setActiveCode] = useState('')
  // the evaluated pattern, each labeled pattern in it, and which track (null = scratch) it belongs to
  const [evaluated, setEvaluated] = useState({ pattern: null, lanes: new Map(), forId: undefined })
  const capturedRef = useRef(new Map())
  const [codeOpen, setCodeOpen] = useState(() => readPref('strudel:code:open', false))
  const [drawerHeight, setDrawerHeight] = useState(() => readPref('strudel:code:height', 320))
  const drawerRef = useRef(null)
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
        setActiveCode(state.activeCode)
      },
      beforeEval: () => { capturedRef.current = capturePatterns(Pattern) },
      afterEval: ({ pattern }) => setEvaluated({
        pattern,
        lanes: capturedRef.current,
        forId: loadedIdRef.current,
        cps: editorRef.current.repl.scheduler.cps,
      }),
    })
    editorRef.current.setFontFamily('"Martian Mono", ui-monospace, monospace')
  }, [])

  // The code drawer: closed means out of the tab order too.
  useEffect(() => {
    writePref('strudel:code:open', codeOpen)
    if (drawerRef.current) drawerRef.current.inert = !codeOpen
  }, [codeOpen])
  useEffect(() => writePref('strudel:code:height', drawerHeight), [drawerHeight])

  /** Open the drawer with the cursor at `pos` (e.g. a lane's label). */
  const revealCode = useCallback((pos) => {
    setCodeOpen(true)
    const view = editorRef.current?.editor
    if (!view) return
    const anchor = Math.min(pos, view.state.doc.length)
    view.dispatch({ selection: { anchor }, scrollIntoView: true })
    requestAnimationFrame(() => view.focus())
  }, [])

  const putCode = useCallback((id, text) => {
    editorRef.current.setCode(text)
    loadedIdRef.current = id
  }, [])

  // Lane buttons edit the code (it stays the source of truth); a playing pattern updates at once.
  const editCode = useCallback((change) => {
    const editor = editorRef.current
    editor.editor.dispatch({ changes: change })
    if (editor.repl.scheduler.started) editor.evaluate()
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

  // While stopped, evaluate silently so the timeline follows your edits. Only for code you
  // wrote or already chose to play: opening someone's link must not run their code.
  const shownId = trackId || null
  const previewAllowed = isNew || isOwner || countedRef.current.has(shownId)
  useEffect(() => {
    const editor = editorRef.current
    if (started || !editor || !previewAllowed || loadedIdRef.current !== shownId) return
    if (code === activeCode && evaluated.forId === shownId) return
    const timer = setTimeout(() => editor.repl.evaluate(editor.code, false), 500)
    return () => clearTimeout(timer)
  }, [code, activeCode, started, shownId, previewAllowed, evaluated.forId])

  const startResize = (e) => {
    const startY = e.clientY
    const startH = drawerHeight
    const max = window.innerHeight - 160
    const move = (ev) => setDrawerHeight(Math.round(Math.min(max, Math.max(140, startH + startY - ev.clientY))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

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
      else if (mod && e.key.toLowerCase() === 'j') setCodeOpen((o) => !o)
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
        <Tempo
          bpm={evaluated.cps ? evaluated.cps * 240 : 120}
          onChange={(bpm) => {
            const change = tempoChange(editorRef.current.code, bpm)
            if (change) editCode(change)
            else flash('Fix the code error first, then set the tempo')
          }}
        />
        <Position editorRef={editorRef} started={started} />
        <button
          className={`btn code-toggle ${codeOpen ? 'on' : ''} ${evalError && !codeOpen ? 'has-error' : ''}`}
          aria-expanded={codeOpen}
          aria-controls="code-drawer"
          title="Show or hide the code (ctrl/cmd + J)"
          onClick={() => setCodeOpen((o) => !o)}
        >{'{ }'}<span className="code-word"> code</span>{evalError && !codeOpen ? ' !' : ''}</button>
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
          <Playlist
            editorRef={editorRef}
            code={code}
            pattern={evaluated.forId === shownId ? evaluated.pattern : null}
            lanePatterns={evaluated.lanes}
            started={started}
            stale={started && code !== activeCode}
            emptyMessage={evaluated.forId === shownId && evaluated.pattern ? null
              : !previewAllowed ? 'press play to load this track'
              : evalError ? 'the code has an error · open the code drawer to fix it'
              : 'loading sounds…'}
            onEditCode={editCode}
            onRevealCode={revealCode}
          />
          <section
            id="code-drawer"
            ref={drawerRef}
            className={`drawer ${codeOpen ? 'open' : ''}`}
            style={{ '--drawer-h': `${drawerHeight}px` }}
            aria-label="Code"
          >
            <div
              className="resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize code drawer"
              aria-valuenow={drawerHeight}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') setDrawerHeight((h) => Math.min(window.innerHeight - 160, h + 24))
                if (e.key === 'ArrowDown') setDrawerHeight((h) => Math.max(140, h - 24))
              }}
            />
            <div className="drawer-head">
              <span className="drawer-title">code</span>
              <span className="hint">ctrl/cmd + enter play · + . stop · + s save · + J close</span>
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setCodeOpen(false)}>close</button>
            </div>
            <div className="editor" ref={rootRef} />
            {evalError && <pre className="error">{evalError}</pre>}
          </section>
        </main>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

/** BPM field (4 beats per cycle). Editing it rewrites setcpm/setcps in the code. */
function Tempo({ bpm, onChange }) {
  const shown = String(Math.round(bpm * 10) / 10)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    const next = Math.round(Number(text) * 10) / 10
    if (Number.isFinite(next) && next >= 10 && next <= 400 && String(next) !== shown) onChange(next)
    else setText(shown)
  }
  return (
    <label className="lcd tempo">
      <input
        className="lcd-value"
        inputMode="decimal"
        value={text}
        aria-label="Tempo in BPM"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setText(shown); e.currentTarget.blur() } }}
      />
      <span className="lcd-unit" aria-hidden>bpm</span>
    </label>
  )
}

/** Song position as bar.beat (bars are cycles). Moves only while playing; Stop pauses it. */
function Position({ editorRef, started }) {
  const valueRef = useRef(null)
  const barRef = useRef(null)
  useEffect(() => {
    const show = (cycle) => {
      const bar = Math.floor(cycle)
      const beat = Math.floor((cycle - bar) * 4)
      if (valueRef.current) valueRef.current.textContent = `${String(bar + 1).padStart(3, '0')}.${beat + 1}`
      barRef.current?.style.setProperty('--phase', cycle - bar)
    }
    if (!started) { show(0); return }
    let frame
    const tick = () => { show(editorRef.current?.repl.scheduler.now() || 0); frame = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [started, editorRef])
  return (
    <span className={`lcd position ${started ? 'running' : ''}`} aria-hidden>
      <span className="lcd-value" ref={valueRef}>001.1</span>
      <span className="lcd-unit">bar.beat</span>
      <span className="cycle-bar" ref={barRef} />
    </span>
  )
}
