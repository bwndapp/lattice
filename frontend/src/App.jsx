import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { StrudelMirror } from '@strudel/codemirror'
import { Compartment, EditorState, StateEffect } from '@codemirror/state'
import { Pattern, silence } from '@strudel/core'
import { getDrawContext } from '@strudel/draw'
import { transpiler } from '@strudel/transpiler'
import { getAudioContext, webaudioOutput } from '@strudel/webaudio'
import { ensureAudio, preloadPattern, silenceNow } from './audio'
import { prebake } from '@strudel/repl/prebake.mjs'
import { useUser } from './bwnd'
import { api, clearDraft, readDraft, timeAgo, trackUrl, writeDraft } from './api'
import Browser from './Browser.jsx'
import Graph from './Graph.jsx'
import Timeline from './Timeline.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import Popover from './Popover.jsx'
import { capturePatterns, parseLanes, tempoChange } from './lanes'
import { PROJECT_MARK, blankProject, demoProject, generateCode, normalizeProject, parseProject, projectFromCode } from './project'
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

/**
 * What the scratch pad at / opens with: your unsaved patch, or a fresh starter patch.
 * Hand-written code left in the scratch pad (from before patches) is kept aside rather
 * than opened, so a new track always starts as a patch.
 */
function scratchCode() {
  const draft = readDraft(null)
  if (draft && parseProject(draft)) return draft
  try {
    const old = draft ?? localStorage.getItem('strudel:code')
    if (old && !localStorage.getItem('strudel:scratch-code')) localStorage.setItem('strudel:scratch-code', old)
    localStorage.removeItem('strudel:code')
  } catch { /* storage unavailable */ }
  return generateCode(demoProject())
}

/** What was open last in this browser: a track id, or 'scratch'. Opening the site goes back to it. */
const LAST_OPEN = 'lattice:last-open'
const rememberOpen = (id) => { try { localStorage.setItem(LAST_OPEN, id || 'scratch') } catch { /* storage unavailable */ } }
const lastOpen = () => { try { return localStorage.getItem(LAST_OPEN) } catch { return null } }

// start the audio engine on the first click or key, so a keyboard play gets effects too
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => ensureAudio(), { once: true, capture: true })

export default function App() {
  const trackId = useMatch('/t/:id')?.params.id || null
  const location = useLocation()
  const fresh = location.state?.fresh ?? null // "+ new track": start over, blank or from the demo patch
  const freshTemplate = location.state?.template === 'demo' ? 'demo' : 'blank'
  const freshHandledRef = useRef(null)
  const navigate = useNavigate()
  // Opening the site at / (typed or bookmarked, not a click inside the app) goes back to the
  // track that was open last time; the scratch pad only if that's what was open.
  const reopened = useRef(false)
  useEffect(() => {
    if (reopened.current) return
    reopened.current = true
    if (trackId || location.state?.fresh || location.key !== 'default') return
    const last = lastOpen()
    if (last && last !== 'scratch') navigate(`/t/${last}`, { replace: true })
  }, [trackId, location, navigate])
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
  const [view, setView] = useState(() => (['browse', 'graph', 'song', 'code'].includes(readPref('strudel:view', 'graph')) ? readPref('strudel:view', 'graph') : 'graph'))
  const codeViewRef = useRef(null)
  const lastViewRef = useRef('graph') // where ctrl/cmd+J returns to from the code
  const toggleView = useCallback(() => setView((v) => (v === 'code' ? lastViewRef.current : 'code')), [])
  useEffect(() => { if (view !== 'code') lastViewRef.current = view }, [view])

  // Project mode: the code's header line holds the patterns/tracks the UI edits.
  const project = useMemo(() => parseProject(code), [code])
  useEffect(() => { if (view === 'song' && code && !project) setView('graph') }, [view, code, project]) // hand-written code has no song
  // auditioning: a node id; null plays the output
  const [solo, setSolo] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const genRef = useRef({ solo: null })
  genRef.current = { solo }
  const readOnlyRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

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

  const [preparing, setPreparing] = useState(false) // loading sounds before the first beat
  const preparingRef = useRef(false)
  const preloadRunRef = useRef(0)
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
      // Before the clock starts: audio engine up and every sound of the first bars loaded,
      // so everything comes in together on the first beat instead of hits going missing.
      beforeStart: async () => {
        setPreparing(true)
        preparingRef.current = true
        try {
          await ensureAudio()
          await preloadPattern(editorRef.current?.repl.scheduler.pattern, { cycles: 4 })
        } finally {
          preparingRef.current = false
          setPreparing(false)
        }
      },
      editPattern: (pattern) => transport.edit(pattern),
      afterEval: () => {
        // load what the new code plays in the background: the rest of the song, or a sound just added
        const { scheduler } = editorRef.current.repl
        const run = ++preloadRunRef.current
        // (after the sample maps have arrived, or there's nothing to look sounds up in)
        Promise.all([editorRef.current.prebaked, new Promise((r) => setTimeout(r, 300))]).then(() => preloadPattern(scheduler.pattern, {
          from: scheduler.started ? Math.ceil(scheduler.now()) : 0,
          cycles: 32,
          stillWanted: () => preloadRunRef.current === run, // newer code: that run takes over
        }))
        setEvaluated({
          pattern: transport.raw, // song time; the scheduler plays the transport-shaped copy
          lanes: capturedRef.current,
          forId: loadedIdRef.current,
          cps: scheduler.cps,
        })
      },
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

  // While playing, project edits are heard as they happen: a turning knob re-evaluates
  // at a steady rate instead of waiting for you to let go. One evaluation runs at a time;
  // changes made meanwhile are folded into the next one, so it always plays the latest.
  const LIVE_INTERVAL = 50 // ms between evaluations while something keeps changing
  const live = useRef({ timer: null, running: false, dirty: false, last: 0 })
  const liveUpdate = useCallback(() => {
    const st = live.current
    st.dirty = true
    if (st.running || st.timer) return
    const run = async () => {
      st.timer = null
      const editor = editorRef.current
      if (!st.dirty || !editor?.repl.scheduler.started) { st.dirty = false; return }
      st.dirty = false
      st.running = true
      st.last = performance.now()
      try {
        await editor.repl.evaluate(editor.code, true)
      } finally {
        st.running = false
        if (st.dirty) st.timer = setTimeout(run, Math.max(0, LIVE_INTERVAL - (performance.now() - st.last)))
      }
    }
    st.timer = setTimeout(run, Math.max(0, LIVE_INTERVAL - (performance.now() - st.last)))
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
    rememberOpen(loadedIdRef.current) // working on it makes it the one to come back to
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

  /** Clear nodes: everything but the output (and the tempo) goes; one undo brings it back. */
  const clearPatch = useCallback(() => {
    updateProject((p) => {
      const out = p.nodes.find((n) => n.type === 'output')
      p.nodes = out ? [{ ...out, data: { ...out.data, muted: {}, solo: null } }] : []
      p.edges = []
      p.patterns = []
      if (p.song) p.song = { ...p.song, clips: [] }
    })
    setSolo(null)
    flash('Patch cleared · ctrl/cmd + Z brings it back')
  }, [updateProject, flash])

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
    const bpm = Math.round((editor.repl.scheduler.cps ?? 0.5) * 60 * transport.beats * 10) / 10
    const { project: converted, parts, error } = projectFromCode(editor.code, { bpm, beats: transport.beats })
    if (error) { setView('code'); return flash(error) }
    replaceCode(generateCode(converted, genRef.current))
    setView('graph')
    liveUpdate()
    flash(parts > 1 ? `Turned into a patch: ${parts} parts, each a node` : 'Turned into a patch')
  }, [replaceCode, liveUpdate, flash, transport])

  const detachProject = useCallback(() => {
    if (!window.confirm('Detach the project? The patch stops editing this track, and the code becomes yours to edit by hand.')) return
    const editor = editorRef.current
    const lines = editor.code.split('\n')
    const body = lines.filter((l, i) => !(i < 2 && (l.startsWith(PROJECT_MARK) || l.startsWith('// generated from the playlist'))))
    replaceCode(body.join('\n'))
  }, [replaceCode])

  const play = useCallback(() => {
    const editor = editorRef.current
    if (!editor || preparingRef.current) return // already starting: sounds are loading
    if (!editor.repl.scheduler.started) transport.cue() // start from the cue, not bar 1
    editor.evaluate()
    const id = loadedIdRef.current
    if (id && !countedRef.current.has(id)) {
      countedRef.current.add(id)
      api(`/tracks/${id}/play`, { method: 'POST' }).catch(() => {})
    }
  }, [transport])

  /** Stop: back to where playback started (the cue). */
  // Stop cuts everything at once: notes still ringing or queued, reverb and delay tails
  const stop = useCallback(() => {
    editorRef.current?.stop()
    silenceNow()
  }, [])
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
      // once per click (not again on sign-in), and only just after it: a reload of that page later is not a click
      const startOver = fresh && freshHandledRef.current !== fresh && Date.now() - fresh < 10000
      freshHandledRef.current = fresh
      if (startOver) rememberOpen(null)
      const previous = readDraft(null)
      putCode(null, startOver ? generateCode(freshTemplate === 'demo' ? demoProject() : blankProject()) : scratchCode())
      // The "start over" note rides along in the history entry, and a reload keeps it: drop it
      // from the entry (quietly, without a navigation) so refreshing keeps your work.
      if (startOver) {
        try {
          const entry = window.history.state
          if (entry?.usr?.fresh) window.history.replaceState({ ...entry, usr: null }, '')
        } catch { /* history unavailable */ }
      }
      // starting over is one undo away from the patch that was there
      const before = startOver && previous && parseProject(previous)
      if (before) { historyRef.current.past.push(JSON.stringify(before)); setHistoryTick((n) => n + 1) }
      return
    }
    setTrack((t) => (t?.id === trackId ? t : null))
    api(`/tracks/${trackId}`)
      .then((t) => {
        if (!alive) return
        setTrack(t)
        setTitle(t.title)
        setVisibility(t.visibility)
        rememberOpen(trackId)
        putCode(trackId, readDraft(trackId, t.updated_at) ?? t.code)
        if (pendingPlayRef.current === trackId) {
          pendingPlayRef.current = null
          play()
        }
      })
      .catch((e) => {
        if (!alive) return
        if (lastOpen() === trackId) rememberOpen(null) // don't keep reopening a track that's gone
        setLoadError(e.status === 404 ? 'This track doesn’t exist, or it’s private.' : e.message)
      })
    return () => { alive = false }
  }, [trackId, fresh, freshTemplate, user?.id, putCode, play])

  // Keep unsaved edits per track in this browser, so nothing is lost on navigation or sign-in.
  useEffect(() => {
    const id = trackId || null
    if (loadedIdRef.current !== id) return
    if (id && track?.id === id && savedCode === track.code) clearDraft(id)
    else if (code) writeDraft(id, code, id ? track?.updated_at ?? null : null)
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

  // ctrl/cmd + scroll (and trackpad pinch, which browsers send the same way) zooms things
  // inside the app: the patch, the piano roll. Never let it zoom the page as well. Handlers
  // on those elements run first, so this only cancels the browser's own zoom. Keyboard zoom
  // (ctrl/cmd + plus/minus) is left alone for anyone who needs a bigger page.
  useEffect(() => {
    const noPageZoom = (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }
    const noPinch = (e) => e.preventDefault() // Safari's own pinch gesture events
    window.addEventListener('wheel', noPageZoom, { passive: false })
    document.addEventListener('gesturestart', noPinch)
    document.addEventListener('gesturechange', noPinch)
    return () => {
      window.removeEventListener('wheel', noPageZoom)
      document.removeEventListener('gesturestart', noPinch)
      document.removeEventListener('gesturechange', noPinch)
    }
  }, [])

  return (
    <div className="studio">
      <header className="bar">
        <div className="bar-side left">
        <Link to="/" className="logo" aria-label="lattice, home">
          {/* the woven mark from the app icon: two strips over two, gaps cut in the header's black */}
          <svg className="logo-mark" viewBox="14 14 36 36" aria-hidden="true">
            <g strokeLinecap="square" fill="none">
              <path d="M14 26 38 50M26 14 50 38" stroke="currentColor" strokeWidth="7" />
              <path d="M14 38 38 14M26 50 50 26" stroke="var(--ink)" strokeWidth="13" />
              <path d="M14 38 38 14M26 50 50 26" stroke="currentColor" strokeWidth="7" />
            </g>
          </svg>
          <span>lattice</span>
        </Link>
        <span className="transport" role="group" aria-label="Transport">
          <button className="btn tport to-start" onClick={toStart} title="Back to the start (Home)" aria-label="Back to the start">|&lt;</button>
          <button className={`btn play ${started ? 'on' : ''} ${preparing ? 'preparing' : ''}`} onClick={play} aria-busy={preparing} title="Play (space) · update while playing (ctrl/cmd + enter)">{started ? 'update' : preparing ? 'loading' : 'play'}</button>
          <button className="btn tport" onClick={pause} disabled={!started} title="Pause (space)">pause</button>
          <button className="btn stop" onClick={stop} title="Stop, cut every sound still ringing, and return to the cue (ctrl/cmd + .)">stop</button>
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
        {project && solo && (
          <button className="btn solo-chip" onClick={() => setSolo(null)} title="You're hearing one part only. Click to hear the whole output again">soloing ×</button>
        )}
        </div>
        {/* what the canvas shows: the patch or the song */}
        <span className="canvas-switch" role="group" aria-label="Canvas">
          <button className={`btn ${view === 'graph' ? 'on' : ''}`} aria-pressed={view === 'graph'} onClick={() => setView('graph')} title="The patch: what each part goes through">patch</button>
          <button className={`btn ${view === 'song' ? 'on' : ''}`} aria-pressed={view === 'song'} onClick={() => setView('song')} title="The song: when each part plays" disabled={!project}>song</button>
        </span>
        <div className="bar-side right">
        {project && (
          <span className="seg history" role="group" aria-label="History">
            <button className="btn" onClick={undo} disabled={!historyRef.current.past.length} title="Undo (ctrl/cmd + Z)" aria-label="Undo">undo</button>
            <button className="btn" onClick={redo} disabled={!historyRef.current.future.length} title="Redo (ctrl/cmd + shift + Z)" aria-label="Redo">redo</button>
          </span>
        )}
        <span className="track" role="group" aria-label="Track">
          {loadError ? (
            <span className="meta track-status" title={loadError}>{loadError} <Link className="linkish" to="/">new track</Link></span>
          ) : trackId && !track ? (
            <span className="meta track-status">Loading…</span>
          ) : canEdit ? (
            <>
              <input
                className="title-input"
                size={6}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="untitled"
                maxLength={80}
                aria-label="Track title"
                title={isNew ? 'Scratch pad · not saved yet' : `saved ${timeAgo(track.updated_at)}`}
              />
              <button className={`btn save ${dirty || !user ? 'primary' : ''} ${user ? '' : 'signed-out'}`} onClick={save} disabled={busy || (!!user && !dirty)} title={!user ? 'Sign in to save this track' : dirty ? 'Save (ctrl/cmd + S)' : 'Everything is saved'}>
                {busy ? 'saving…' : !user || dirty ? 'save' : 'saved'}
              </button>
              <Popover label="···" title="Track: title, who can see it, share, clear, delete" className="track-more" panelClassName="track-menu">
                {(close) => (
                  <>
                    <label className="track-menu-field">
                      <span>title</span>
                      <input className="node-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="untitled" maxLength={80} />
                    </label>
                    <label className="track-menu-field">
                      <span>who can see it</span>
                      <select className="select" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                        <option value="public">Public</option>
                        <option value="unlisted">Unlisted (link only)</option>
                        <option value="private">Private</option>
                      </select>
                    </label>
                    {project && (
                      <label className="track-menu-field">
                        <span>beats per bar</span>
                        <select
                          className="select"
                          value={transport.beats}
                          onChange={(e) => { const beats = Number(e.target.value); transport.setBeats(beats); updateProject((p) => { p.beats = beats }) }}
                        >
                          {[2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}/4</option>)}
                        </select>
                      </label>
                    )}
                    <p className="meta track-menu-meta">
                      {isNew ? 'Scratch pad · not saved yet' : <>♥{track.likes} · {track.plays} plays · saved {timeAgo(track.updated_at)}</>}
                      {track?.parent && <> · remix of <Link className="linkish" to={`/t/${track.parent.id}`} onClick={close}>{track.parent.title}</Link></>}
                    </p>
                    {isOwner && (
                      <div className="track-menu-actions">
                        <button className="btn" onClick={() => { close(); share() }}>copy link</button>
                      </div>
                    )}
                    {project && (
                      <div className="track-menu-action">
                        <button
                          className="btn"
                          onClick={() => { close(); setConfirmClear(true) }}
                          disabled={!project.nodes.some((n) => n.type !== 'output')}
                        >clear the patch</button>
                        <p className="track-menu-note">Empties what you're editing: nodes, wires, patterns and the song.{isNew ? '' : ' The track itself stays, and the saved copy doesn\'t change until you save.'} Ctrl/cmd + Z undoes it.</p>
                      </div>
                    )}
                    {isOwner && (
                      <div className="track-menu-action danger-zone">
                        <button className="btn ghost danger" onClick={() => { close(); setConfirmDelete(true) }}>delete track</button>
                        <p className="track-menu-note">Removes the saved track for good, for everyone, along with its likes and plays. Can't be undone.</p>
                      </div>
                    )}
                  </>
                )}
              </Popover>
            </>
          ) : track ? (
            <>
              <span className="track-heading" title={`by ${track.author}`}>
                <span className="track-title">{track.title}</span>
                <span className="meta">by {track.author}</span>
              </span>
              <button className={`btn ${track.liked ? 'on' : ''}`} onClick={like} title="Like">♥{track.likes}</button>
              <button className="btn" onClick={remix} disabled={busy} title="Make your own copy to change">remix</button>
              <Popover label="···" title="Track: share, details" className="track-more" panelClassName="track-menu">
                {(close) => (
                  <>
                    <p className="meta track-menu-meta">
                      by {track.author} · {track.plays} plays · {timeAgo(track.updated_at)}
                      {track.parent && <> · remix of <Link className="linkish" to={`/t/${track.parent.id}`} onClick={close}>{track.parent.title}</Link></>}
                    </p>
                    {codeChanged && <p className="meta track-menu-meta">edited locally · <button className="linkish" onClick={() => { close(); revert() }}>revert</button></p>}
                    <div className="track-menu-actions">
                      <button className="btn" onClick={() => { close(); share() }}>share</button>
                    </div>
                  </>
                )}
              </Popover>
            </>
          ) : null}
        </span>
        <span className="seg side-views" role="group" aria-label="More views">
          <button className={`btn ${view === 'browse' ? 'on' : ''}`} aria-pressed={view === 'browse'} onClick={() => setView('browse')} title="Tracks people have shared, and yours">browse</button>
          <button
            className={`btn code-toggle ${view === 'code' ? 'on' : ''} ${evalError && view !== 'code' ? 'has-error' : ''}`}
            aria-pressed={view === 'code'}
            title="Show the code (ctrl/cmd + J)"
            onClick={toggleView}
          >{'{ }'}<span className="code-word"> code</span>{evalError && view !== 'code' ? ' !' : ''}</button>
        </span>
        {userLoading ? null : user ? (
          <span className="user">
            <span className="avatar" aria-hidden>{(user.name || user.email || '?').trim()[0].toUpperCase()}</span>
            <span className="user-name">{user.name || user.email}</span>
            <button className="linkish" onClick={() => logout(window.location.pathname)}>Sign out</button>
          </span>
        ) : (
          <button className="btn primary" onClick={() => login()}>Sign in</button>
        )}
        </div>
        {/* phones: every view in a tab bar along the bottom */}
        <span className="seg views phone-tabs" role="group" aria-label="View">
          <button className={`btn ${view === 'browse' ? 'on' : ''}`} aria-pressed={view === 'browse'} onClick={() => setView('browse')} title="Tracks people have shared, and yours">browse</button>
          <button className={`btn ${view === 'graph' ? 'on' : ''}`} aria-pressed={view === 'graph'} onClick={() => setView('graph')} title="The patch: what each part goes through">patch</button>
          {project && <button className={`btn ${view === 'song' ? 'on' : ''}`} aria-pressed={view === 'song'} onClick={() => setView('song')} title="The song: when each part plays">song</button>}
          <button
            className={`btn code-toggle ${view === 'code' ? 'on' : ''} ${evalError && view !== 'code' ? 'has-error' : ''}`}
            aria-pressed={view === 'code'}
            title="Show the code (ctrl/cmd + J)"
            onClick={toggleView}
          >{'{ }'}<span className="code-word"> code</span>{evalError && view !== 'code' ? ' !' : ''}</button>
        </span>
      </header>

      <div className="body">
        <main className="main">
          {view === 'browse' && (
            <Browser
              user={user}
              login={login}
              activeId={trackId}
              refreshKey={refreshKey}
              onPlay={playFromList}
              onPick={() => setView('graph')}
            />
          )}
          {confirmClear && project && (
            <ConfirmDialog
              title="Clear the patch?"
              confirmLabel="clear the patch"
              danger
              onCancel={() => setConfirmClear(false)}
              onConfirm={() => {
                setConfirmClear(false)
                clearPatch()
              }}
            >
              <p>This removes <strong>{project.nodes.filter((n) => n.type !== 'output').length} nodes</strong>, their wires, <strong>{project.patterns.length} pattern{project.patterns.length === 1 ? '' : 's'}</strong> with all their steps and notes, and the song's clips. The output and tempo stay.</p>
              <p>{isNew ? 'Ctrl/cmd + Z brings it back.' : 'Ctrl/cmd + Z brings it back, and the saved track doesn\'t change unless you save.'}</p>
            </ConfirmDialog>
          )}
          {confirmDelete && track && (
            <ConfirmDialog
              title={`Delete “${track.title}”?`}
              confirmLabel="delete track"
              danger
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => { setConfirmDelete(false); remove() }}
            >
              <p>This removes the saved track from lattice for good: its link stops working for everyone, and its <strong>♥{track.likes}</strong> and <strong>{track.plays} plays</strong> go with it.</p>
              <p><strong>It can't be undone.</strong> To only empty the patch and keep the track, use <em>clear the patch</em> instead.</p>
            </ConfirmDialog>
          )}
          {view === 'song' && project && (
            <Timeline project={project} onUpdateProject={updateProject} transport={transport} started={started} />
          )}
          {view === 'graph' && project && (
            <Graph
              project={project}
              onUpdateProject={updateProject}
              started={started}
              solo={solo}
              onSolo={setSolo}
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
          <section ref={codeViewRef} className="code-view" hidden={view !== 'code'} aria-label="Code">
            <div className="code-head">
              <span className="code-title">code</span>
              {project ? (
                <>
                  <span className="hint">generated from the patch · read-only</span>
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

/**
 * BPM readout that works like a knob: drag up or down (shift for tenths), scroll, arrow keys
 * (page up/down for 10), double-click for 120. A click without dragging types a tempo.
 * Changing it rewrites setcpm/setcps in the code.
 */
function Tempo({ bpm, onChange }) {
  const MIN = 10
  const MAX = 400
  const tidy = (v) => Math.round(Math.min(MAX, Math.max(MIN, v)) * 10) / 10
  const shown = String(tidy(bpm))
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const boxRef = useRef(null)
  const drag = useRef(null)
  const bpmRef = useRef(bpm)
  bpmRef.current = bpm
  useEffect(() => { if (!editing) setText(shown) }, [shown, editing])

  const set = useCallback((v) => {
    const next = tidy(v)
    if (String(next) !== String(tidy(bpmRef.current))) { bpmRef.current = next; onChange(next) }
  }, [onChange])

  // scroll to nudge (a non-passive listener, so the page doesn't scroll too)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e) => {
      if (editing) return
      e.preventDefault()
      set(bpmRef.current - Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [editing, set])

  const commit = () => {
    const next = Number(text)
    if (Number.isFinite(next) && next >= MIN && next <= MAX) set(next)
    setEditing(false)
    setText(shown)
  }
  const startTyping = () => {
    setEditing(true)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
  }

  return (
    <label
      ref={boxRef}
      className={`lcd tempo ${editing ? 'editing' : ''} ${dragging ? 'dragging' : ''}`}
      title="Tempo · drag up/down or scroll (shift: fine) · click to type · double-click for 120"
      onPointerDown={(e) => {
        if (editing || e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { y: e.clientY, from: bpmRef.current, moved: false }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dy = d.y - e.clientY
        if (!d.moved && Math.abs(dy) < 3) return
        if (!d.moved) { d.moved = true; setDragging(true) }
        // 1 bpm per 3 px (a tenth with shift); re-anchor when shift changes so it doesn't jump
        if (d.fine !== e.shiftKey) { d.fine = e.shiftKey; d.y = e.clientY; d.from = bpmRef.current; return }
        set(d.from + Math.round(dy / 3) * (e.shiftKey ? 0.1 : 1))
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        setDragging(false)
        if (d && !d.moved) startTyping()
      }}
      onPointerCancel={() => { drag.current = null; setDragging(false) }}
      onDoubleClick={() => { setEditing(false); set(120) }}
    >
      <input
        ref={inputRef}
        className="lcd-value"
        inputMode="decimal"
        role="spinbutton"
        aria-label="Tempo in BPM"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={tidy(bpm)}
        readOnly={!editing}
        tabIndex={0}
        value={editing ? text : shown}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (editing) commit() }}
        onKeyDown={(e) => {
          if (editing) {
            if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur() }
            if (e.key === 'Escape') { setEditing(false); setText(shown); e.currentTarget.blur() }
            return
          }
          const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key]
          if (step) { e.preventDefault(); e.stopPropagation(); set(bpmRef.current + step * (e.shiftKey && Math.abs(step) === 1 ? 0.1 : 1)); return }
          if (e.key === 'Enter') { e.preventDefault(); startTyping() }
          else if (e.key === 'Home') { e.preventDefault(); set(120) }
          else if (/^[0-9.]$/.test(e.key)) { setEditing(true); setText(e.key); e.preventDefault(); requestAnimationFrame(() => inputRef.current?.focus()) }
        }}
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
