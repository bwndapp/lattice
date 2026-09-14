import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useMatch, useNavigate } from 'react-router-dom'
import { StrudelMirror } from '@strudel/codemirror'
import { Compartment, EditorState, StateEffect } from '@codemirror/state'
import { Pattern, silence } from '@strudel/core'
import { getDrawContext } from '@strudel/draw'
import { transpiler } from '@strudel/transpiler'
import { getAudioContext, webaudioOutput, initAudioOnFirstClick } from '@strudel/webaudio'
import { prebake } from '@strudel/repl/prebake.mjs'
import { useUser } from './bwnd'
import { api, clearDraft, readDraft, timeAgo, trackUrl, writeDraft } from './api'
import Browser from './Browser.jsx'
import Graph from './Graph.jsx'
import Rack from './Rack.jsx'
import { capturePatterns, parseLanes, tempoChange } from './lanes'
import { PROJECT_MARK, demoProject, generateCode, normalizeProject, parseProject, projectFromLanes } from './project'
import { createTransport, formatBarBeat, parseBarBeat } from './transport'

function readPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

function songCodeOf(text) {
  const p = parseProject(text)
  return p ? generateCode(p) : text
}

function scratchCode() {
  let legacy = null
  try { legacy = localStorage.getItem('strudel:code') } catch { /* storage unavailable */ }
  return readDraft(null) ?? legacy ?? generateCode(demoProject())
}

initAudioOnFirstClick()

export default function App() {
  const trackId = useMatch('/t/:id')?.params.id || null
  const navigate = useNavigate()
  const { user, loading: userLoading, login, logout } = useUser()

  const rootRef = useRef(null)
  const editorRef = useRef(null)
  const transportRef = useRef(null)
  if (!transportRef.current) transportRef.current = createTransport()
  const transport = transportRef.current
  const [, setTransportTick] = useState(0)
  useEffect(() => transport.subscribe(() => setTransportTick((n) => n + 1)), [transport])
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
  const [view, setView] = useState(() => (['graph', 'rack', 'code'].includes(readPref('strudel:view', 'graph')) ? readPref('strudel:view', 'graph') : 'graph'))
  const codeViewRef = useRef(null)
  const lastViewRef = useRef('graph') // where ctrl/cmd+J returns to from the code
  const toggleView = useCallback(() => setView((v) => (v === 'code' ? lastViewRef.current : 'code')), [])
  useEffect(() => { if (view !== 'code') lastViewRef.current = view }, [view])

  // Project mode: the code's header line holds the patterns/tracks the UI edits.
  const project = useMemo(() => parseProject(code), [code])
  const [currentPatternId, setCurrentPatternId] = useState(null)
  // auditioning: a node id, or "pattern:<id>" from the rack; null plays the output
  const [solo, setSolo] = useState(null)
  const genRef = useRef({ solo: null })
  genRef.current = { solo }
  useEffect(() => {
    if (project && !project.patterns.some((p) => p.id === currentPatternId)) setCurrentPatternId(project.patterns[0]?.id ?? null)
  }, [project, currentPatternId])
  useEffect(() => { if (code && !project && view === 'rack') setView('graph') }, [code, project, view])
  const readOnlyRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [browserOpen, setBrowserOpen] = useState(false)

  const isNew = !trackId
  const isOwner = !!track?.is_owner
  const canEdit = isNew || isOwner
  // what gets saved: projects always in song mode, whatever you're looping right now
  const savedCode = useMemo(() => {
    const p = parseProject(code)
    return p ? generateCode(p) : code
  }, [code])
  const codeChanged = !!track && savedCode !== track.code
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
      editPattern: (pattern) => transport.edit(pattern),
      afterEval: () => setEvaluated({
        pattern: transport.raw, // song time; the scheduler plays the transport-shaped copy
        lanes: capturedRef.current,
        forId: loadedIdRef.current,
        cps: editorRef.current.repl.scheduler.cps,
      }),
    })
    editorRef.current.setFontFamily('"Martian Mono", ui-monospace, monospace')
    transport.scheduler = editorRef.current.repl.scheduler
    readOnlyRef.current = new Compartment()
    editorRef.current.editor.dispatch({ effects: StateEffect.appendConfig.of(readOnlyRef.current.of(EditorState.readOnly.of(false))) })
  }, [transport])

  // generated code is read-only; detach the project to edit it by hand
  const isProject = !!project
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !readOnlyRef.current) return
    editor.editor.dispatch({ effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(isProject)) })
  }, [isProject])

  // follow the project's meter
  useEffect(() => { if (project && project.beats !== transport.beats) transport.setBeats(project.beats) }, [project, transport])

  // The main area shows the playlist or the code. The editor stays mounted (it owns the
  // audio); when hidden it is also out of the tab order.
  useEffect(() => {
    writePref('strudel:view', view)
    if (codeViewRef.current) codeViewRef.current.inert = view !== 'code'
    if (view === 'code') requestAnimationFrame(() => editorRef.current?.editor.requestMeasure())
  }, [view])

  /** Switch to the code view with the cursor at `pos` (e.g. a lane's label). */
  const revealCode = useCallback((pos) => {
    setView('code')
    const view = editorRef.current?.editor
    if (!view) return
    const anchor = Math.min(pos, view.state.doc.length)
    view.dispatch({ selection: { anchor }, scrollIntoView: true })
    requestAnimationFrame(() => view.focus())
  }, [])

  const putCode = useCallback((id, text) => {
    historyRef.current = { past: [], future: [], lastAt: 0 } // a different track: its own history
    setHistoryTick((n) => n + 1)
    const p = parseProject(text)
    editorRef.current.setCode(p ? generateCode(p, genRef.current) : text)
    loadedIdRef.current = id
  }, [])

  // Lane buttons edit the code (it stays the source of truth); a playing pattern updates at once.
  const editCode = useCallback((change) => {
    const editor = editorRef.current
    editor.editor.dispatch({ changes: change })
    if (editor.repl.scheduler.started) editor.evaluate()
  }, [])

  /** Replace the whole editor text (programmatic changes pass the read-only guard). */
  const replaceCode = useCallback((text) => {
    const view = editorRef.current.editor
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }, [])

  // While playing, project edits are heard right away (debounced so a paint stroke is one update).
  const liveTimer = useRef(null)
  const liveUpdate = useCallback(() => {
    clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => {
      const editor = editorRef.current
      if (editor?.repl.scheduler.started) editor.repl.evaluate(editor.code, true)
    }, 120)
  }, [])

  // Undo history of project snapshots. Edits within half a second (a knob turn, a paint
  // stroke) count as one step.
  const historyRef = useRef({ past: [], future: [], lastAt: 0 })
  const [historyTick, setHistoryTick] = useState(0)
  const applySnapshot = useCallback((json) => {
    replaceCode(generateCode(normalizeProject(JSON.parse(json)), genRef.current))
    liveUpdate()
  }, [replaceCode, liveUpdate])

  /** Change the project: `mutate` edits a copy; the code is regenerated from it. */
  const updateProject = useCallback((mutate) => {
    const editor = editorRef.current
    const base = editor && parseProject(editor.code)
    if (!base) return
    const before = JSON.stringify(base)
    const draft = JSON.parse(before)
    const result = mutate(draft)
    // mutators edit the draft in place; only a returned value that is itself a project replaces it
    const next = normalizeProject(result && Array.isArray(result.patterns) && Array.isArray(result.tracks) ? result : draft)
    const text = generateCode(next, genRef.current)
    if (text === editor.code) return
    const h = historyRef.current
    const now = Date.now()
    if (JSON.stringify(next) !== before && now - h.lastAt > 500) {
      h.past.push(before)
      if (h.past.length > 200) h.past.shift()
      h.future = []
      setHistoryTick((n) => n + 1)
    }
    h.lastAt = now
    replaceCode(text)
    liveUpdate()
  }, [replaceCode, liveUpdate])

  const undo = useCallback(() => {
    const editor = editorRef.current
    const h = historyRef.current
    const current = editor && parseProject(editor.code)
    if (!current || !h.past.length) return
    h.future.push(JSON.stringify(current))
    applySnapshot(h.past.pop())
    h.lastAt = 0
    setHistoryTick((n) => n + 1)
  }, [applySnapshot])
  const redo = useCallback(() => {
    const editor = editorRef.current
    const h = historyRef.current
    const current = editor && parseProject(editor.code)
    if (!current || !h.future.length) return
    h.past.push(JSON.stringify(current))
    applySnapshot(h.future.pop())
    h.lastAt = 0
    setHistoryTick((n) => n + 1)
  }, [applySnapshot])

  // pattern/song mode and the selected pattern change what the code plays
  useEffect(() => { updateProject((p) => p) }, [solo, updateProject])

  const convertToProject = useCallback(() => {
    const editor = editorRef.current
    const lanes = parseLanes(editor.code)
    if (!lanes?.length) return flash('Name your patterns first (e.g. drums: s("bd*4")), then convert')
    const bpm = Math.round((editor.repl.scheduler.cps ?? 0.5) * 60 * transport.beats * 10) / 10
    replaceCode(generateCode(projectFromLanes(lanes, { bpm, beats: transport.beats }), genRef.current))
    liveUpdate()
    flash('Converted: each lane is now a pattern on its own track')
  }, [replaceCode, liveUpdate, flash, transport])

  const detachProject = useCallback(() => {
    if (!window.confirm('Detach the project? The playlist and rack stop editing this track, and the code becomes yours to edit by hand.')) return
    const editor = editorRef.current
    const lines = editor.code.split('\n')
    const body = lines.filter((l, i) => !(i < 2 && (l.startsWith(PROJECT_MARK) || l.startsWith('// generated from the playlist'))))
    replaceCode(body.join('\n'))
  }, [replaceCode])

  const openPattern = useCallback((id) => {
    setCurrentPatternId(id)
    setView('rack')
  }, [])

  const play = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    if (!editor.repl.scheduler.started) transport.cue() // start from the cue, not bar 1
    editor.evaluate()
    const id = loadedIdRef.current
    if (id && !countedRef.current.has(id)) {
      countedRef.current.add(id)
      api(`/tracks/${id}/play`, { method: 'POST' }).catch(() => {})
    }
  }, [transport])

  /** Stop: back to where playback started (the cue). */
  const stop = useCallback(() => editorRef.current?.stop(), [])
  /** Pause: stop, and resume from here next time. */
  const pause = useCallback(() => {
    const at = transport.position()
    editorRef.current?.stop()
    transport.pausedAt(at)
  }, [transport])
  const toStart = useCallback(() => transport.seek(transport.looping() ? transport.loop.from : 0), [transport])

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
    if (id && track?.id === id && savedCode === track.code) clearDraft(id)
    else if (code) writeDraft(id, code)
  }, [code, savedCode, trackId, track])

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

  const save = useCallback(async () => {
    if (!canEdit || busy) return
    if (!user) return login()
    setBusy(true)
    try {
      const body = { title: title.trim() || 'untitled', code: songCodeOf(editorRef.current.code), visibility }
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
        body: { title: `${track.title} (remix)`.slice(0, 80), code: songCodeOf(editorRef.current.code), visibility: 'public', forked_from: track.id },
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
  keysRef.current = { play, save, stop, pause, toStart, undo, redo, isProject: !!project }
  useEffect(() => {
    const typing = (el) => el?.closest?.('input, textarea, select, button, [contenteditable="true"]')
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod && !e.altKey && !typing(e.target)) {
        // DAW keys outside text fields: space plays/pauses, Home goes to the start
        if (e.key === ' ') editorRef.current?.repl.scheduler.started ? keysRef.current.pause() : keysRef.current.play()
        else if (e.key === 'Home') keysRef.current.toStart()
        else return
        e.preventDefault()
        return
      }
      if (!(mod || e.altKey)) return
      // undo/redo belongs to text fields while you type in them; everywhere else it's the project's
      const textEntry = e.target.closest?.('input:not([type=range]), textarea, select') || (e.target.closest?.('[contenteditable="true"]') && !keysRef.current.isProject)
      if (mod && !e.altKey && e.key.toLowerCase() === 'z' && !textEntry) {
        e.preventDefault()
        return e.shiftKey ? keysRef.current.redo() : keysRef.current.undo()
      }
      if (mod && e.key.toLowerCase() === 'y' && !textEntry) { e.preventDefault(); return keysRef.current.redo() }
      if (e.key === 'Enter') keysRef.current.play()
      else if (e.key === '.' || e.code === 'Period') keysRef.current.stop()
      else if (mod && e.key.toLowerCase() === 's') keysRef.current.save()
      else if (mod && e.key.toLowerCase() === 'j') setView((v) => (v === 'code' ? lastViewRef.current : 'code'))
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
        <span className="transport" role="group" aria-label="Transport">
          <button className="btn tport" onClick={toStart} title="Back to the start (Home)" aria-label="Back to the start">|&lt;</button>
          <button className={`btn play ${started ? 'on' : ''}`} onClick={play} title="Play (space) · update while playing (ctrl/cmd + enter)">{started ? 'update' : 'play'}</button>
          <button className="btn tport" onClick={pause} disabled={!started} title="Pause (space)">pause</button>
          <button className="btn stop" onClick={stop} disabled={!started} title="Stop and return to the cue (ctrl/cmd + .)">stop</button>
        </span>
        <Tempo
          bpm={project ? project.bpm : (evaluated.cps ?? 0.5) * 60 * transport.beats}
          onChange={(bpm) => {
            if (project) return updateProject((p) => { p.bpm = bpm })
            const change = tempoChange(editorRef.current.code, bpm, transport.beats)
            if (change) editCode(change)
            else flash('Fix the code error first, then set the tempo')
          }}
        />
        <Position transport={transport} started={started} />
        <label className="lcd meter" title="Beats per bar">
          <select
            className="lcd-value"
            aria-label="Beats per bar"
            value={transport.beats}
            onChange={(e) => {
              const beats = Number(e.target.value)
              transport.setBeats(beats)
              if (project) updateProject((p) => { p.beats = beats })
            }}
          >
            {[2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}/4</option>)}
          </select>
        </label>
        <button
          className={`btn loop ${transport.loop.on ? 'on' : ''}`}
          aria-pressed={transport.loop.on}
          title="Loop the marked bars · drag across the ruler to mark them"
          onClick={() => transport.setLoop({ on: !transport.loop.on })}
        >loop <span className="loop-range">{formatBarBeat(transport.loop.from, transport.beats).replace(/^0+/, '')}–{formatBarBeat(transport.loop.to, transport.beats).replace(/^0+/, '')}</span></button>
        {project && (
          <span className="seg history" role="group" aria-label="History">
            <button className="btn" onClick={undo} disabled={!historyRef.current.past.length} title="Undo (ctrl/cmd + Z)" aria-label="Undo">undo</button>
            <button className="btn" onClick={redo} disabled={!historyRef.current.future.length} title="Redo (ctrl/cmd + shift + Z)" aria-label="Redo">redo</button>
          </span>
        )}
        {project && (
          <span className="seg" role="group" aria-label="What plays">
            <button className={`btn ${solo ? '' : 'on'}`} aria-pressed={!solo} onClick={() => setSolo(null)} title="Play the output">output</button>
            {solo && <button className="btn on solo-chip" onClick={() => setSolo(null)} title="Stop auditioning">solo ×</button>}
          </span>
        )}
        <span className="seg views" role="group" aria-label="View">
          <button className={`btn ${view === 'graph' ? 'on' : ''}`} aria-pressed={view === 'graph'} onClick={() => setView('graph')}>patch</button>
          {project && <button className={`btn ${view === 'rack' ? 'on' : ''}`} aria-pressed={view === 'rack'} onClick={() => setView('rack')}>rack</button>}
          <button
            className={`btn code-toggle ${view === 'code' ? 'on' : ''} ${evalError && view !== 'code' ? 'has-error' : ''}`}
            aria-pressed={view === 'code'}
            title="Show the code (ctrl/cmd + J)"
            onClick={toggleView}
          >{'{ }'}<span className="code-word"> code</span>{evalError && view !== 'code' ? ' !' : ''}</button>
        </span>
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
          {view === 'graph' && project && (
            <Graph
              project={project}
              onUpdateProject={updateProject}
              started={started}
              solo={solo}
              onSolo={setSolo}
              onOpenRack={openPattern}
              transport={transport}
            />
          )}
          {view === 'graph' && !project && code && (
            <section className="graph-convert">
              <h2 className="playlist-title">this track is code</h2>
              <p>It was written by hand, so there's no patch to show. Turn each named part (like <code>drums:</code>) into a node you can wire and tweak, or keep editing the code.</p>
              <span className="rack-actions">
                <button className="btn primary" onClick={convertToProject}>turn it into a patch</button>
                <button className="btn" onClick={() => setView('code')}>open the code</button>
              </span>
            </section>
          )}
          {view === 'rack' && project && (
            <Rack
              project={project}
              currentPatternId={currentPatternId}
              onSelectPattern={setCurrentPatternId}
              onUpdateProject={updateProject}
              transport={transport}
              started={started}
              playMode={solo === `pattern:${currentPatternId}` ? 'pattern' : 'song'}
              onPlayMode={(mode) => setSolo(mode === 'pattern' ? `pattern:${currentPatternId}` : null)}
            />
          )}
          <section ref={codeViewRef} className="code-view" hidden={view !== 'code'} aria-label="Code">
            <div className="code-head">
              <span className="code-title">code</span>
              {project ? (
                <>
                  <span className="hint">generated from the playlist and rack · read-only</span>
                  <button className="btn add-lane" onClick={detachProject}>detach and edit as code</button>
                </>
              ) : (
                <span className="hint">ctrl/cmd + enter play · + . stop · + s save · + J back</span>
              )}
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

/** BPM field (beats per bar × cycles per minute). Editing it rewrites setcpm/setcps in the code. */
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

/**
 * Song position as bar.beat. Type a position ("5.3") and press Enter to jump there;
 * arrow keys nudge a beat, shift + arrows (or page up/down) a bar.
 */
function Position({ transport, started }) {
  const inputRef = useRef(null)
  const barRef = useRef(null)
  useEffect(() => {
    const show = () => {
      const pos = transport.position()
      const input = inputRef.current
      if (input && document.activeElement !== input) input.value = formatBarBeat(pos, transport.beats)
      barRef.current?.style.setProperty('--phase', pos - Math.floor(pos))
    }
    show()
    if (!started) return transport.subscribe(show)
    let frame
    const tick = () => { show(); frame = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [started, transport])

  const onKeyDown = (e) => {
    const step = e.shiftKey || e.key.startsWith('Page') ? 1 : 1 / transport.beats
    const pos = transport.position()
    const snapped = Math.round(pos * transport.beats) / transport.beats
    if (e.key === 'Enter') {
      const target = parseBarBeat(e.currentTarget.value, transport.beats)
      if (target === null) e.currentTarget.classList.add('invalid')
      else { e.currentTarget.classList.remove('invalid'); transport.seek(target); e.currentTarget.blur() }
    } else if (e.key === 'Escape') e.currentTarget.blur()
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') transport.seek(snapped + step)
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') transport.seek(snapped - step)
    else return
    e.preventDefault()
    e.currentTarget.value = formatBarBeat(transport.position(), transport.beats)
  }

  return (
    <label className={`lcd position ${started ? 'running' : ''}`} title="Type bar.beat and press Enter to jump · arrows nudge">
      <input
        ref={inputRef}
        className="lcd-value"
        defaultValue="001.1"
        aria-label="Song position, bar.beat"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => { e.currentTarget.classList.remove('invalid'); e.currentTarget.value = formatBarBeat(transport.position(), transport.beats) }}
      />
      <span className="lcd-unit" aria-hidden>bar.beat</span>
      <span className="cycle-bar" ref={barRef} />
    </label>
  )
}
