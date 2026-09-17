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
import { Glass } from './Glass.jsx'
import { AutomationEditor } from './Automation.jsx'
import { routeVoice } from './fxbus.js'
import Versions from './Versions.jsx'
import ExportDialog from './ExportDialog.jsx'
import Tooltip from './Tooltip.jsx'
import ProgramMenu from './ProgramMenu.jsx'
import DetailDock, { readDockHeight } from './DetailDock.jsx'
import SynthWindows from './instruments/SynthWindows.jsx'
import { RollContext } from './rollDock.js'
import { AutomationContext, autoLive } from './autoLive.js'
import { AUTO_PREFIX, activeAutos, appParam, autoValueFn, resolveTarget, toPos } from './automation.js'
import { setFxParams } from './fxbus.js'
import { setInsertParams } from './stereo.js'
import { setEngineParams } from './instruments/host.js'
import { capturePatterns, parseLanes, tempoChange } from './lanes'
import { PROJECT_MARK, blankProject, demoProject, generateCode, newId, normalizeProject, parseProject, projectFromCode } from './project'
import { createTransport, formatBarBeat, parseBarBeat } from './transport'
import { songLength } from './song'

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
/*
 * What to reopen when the site is opened at /. Three notes in this browser:
 *   lattice:last-track   the last saved track that was open (a scratch pad never overwrites it)
 *   lattice:last-open    'track' or 'scratch': which of the two was worked on last
 *   lattice:scratch-work 'yes' once you've changed something on the scratch pad
 * The scratch pad only wins when you actually changed it; loading, re-saving or starting a
 * new track doesn't count, so the default template never takes over from your track.
 */
const LAST_TRACK = 'lattice:last-track'
const LAST_OPEN = 'lattice:last-open'
const SCRATCH_WORK = 'lattice:scratch-work'
const store = {
  get: (key) => { try { return localStorage.getItem(key) } catch { return null } },
  set: (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value) } catch { /* storage unavailable */ } },
}
const rememberTrack = (id) => { store.set(LAST_TRACK, id); store.set(LAST_OPEN, 'track') }
const rememberScratchWork = () => { store.set(SCRATCH_WORK, 'yes'); store.set(LAST_OPEN, 'scratch') }
const forgetScratchWork = () => store.set(SCRATCH_WORK, null)
/** "3 nodes · 2 patterns · 5 clips" */
const countText = (c) => (c ? [`${c.nodes} node${c.nodes === 1 ? '' : 's'}`, `${c.patterns} pattern${c.patterns === 1 ? '' : 's'}`, c.clips ? `${c.clips} clip${c.clips === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') : 'nothing')
const lastTrack = () => {
  const id = store.get(LAST_TRACK)
  if (id) return id
  const old = store.get(LAST_OPEN) // before these notes: the id itself, or 'scratch'
  return old && old !== 'scratch' && old !== 'track' ? old : null
}

// start the audio engine on the first click or key, so a keyboard play gets effects too
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => ensureAudio(), { once: true, capture: true })

export default function App() {
  const trackId = useMatch('/t/:id')?.params.id || null
  const location = useLocation()
  const fresh = location.state?.fresh ?? null // "+ new track": start over, blank or from the demo patch
  const freshTemplate = location.state?.template === 'demo' ? 'demo' : 'blank'
  const freshHandledRef = useRef(null)
  const navigate = useNavigate()
  const { user, loading: userLoading, login, logout } = useUser()
  // Opening the site at / (typed, bookmarked or refreshed) goes
  // back to the track that was open last time, or the scratch pad if that's what was open
  // and it still holds your work. When this browser has nothing of yours to go back to (its
  // storage was cleared, another device, a first visit), a signed-in person gets their most
  // recently saved track rather than an empty template.
  const reopened = useRef(false)
  // what the scratch pad held before this page load wrote anything into it
  const hadScratch = useRef(null)
  if (hadScratch.current === null) hadScratch.current = !!parseProject(readDraft(null) ?? '')
  const trackIdRef = useRef(trackId)
  trackIdRef.current = trackId
  useEffect(() => {
    if (reopened.current) return
    // only as the page loads (this effect runs once): a refresh counts, clicks inside the app don't
    if (trackId || location.state?.fresh) { reopened.current = true; return }
    const scratchWins = store.get(LAST_OPEN) === 'scratch' && store.get(SCRATCH_WORK) === 'yes' && hadScratch.current
    if (scratchWins) { reopened.current = true; return } // you were last working on the scratch pad
    const last = lastTrack()
    if (last) { reopened.current = true; navigate(`/t/${last}`, { replace: true }); return }
    if (userLoading) return // wait to know who's here
    reopened.current = true
    if (!user) return
    api('/tracks?view=mine&sort=new&limit=1')
      .then((d) => {
        const latest = d?.tracks?.[0]
        // only if they're still on the scratch pad and haven't started changing it
        if (latest && !trackIdRef.current && historyRef.current.past.length === 0) navigate(`/t/${latest.id}`, { replace: true })
      })
      .catch(() => { /* offline or signed out: the scratch pad it is */ })
  }, [trackId, location, navigate, user, userLoading])

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
  const [view, setView] = useState(() => {
    // a link into the browser wins over whichever view you left open
    const q = new URLSearchParams(window.location.hash.split('?')[1] || window.location.search)
    if (q.get('browse') || q.get('by') || q.get('copies')) return 'browse'
    const kept = readPref('strudel:view', 'graph')
    return ['browse', 'graph', 'song', 'code'].includes(kept) ? kept : 'graph'
  })
  const codeViewRef = useRef(null)
  const lastViewRef = useRef('graph') // where ctrl/cmd+J returns to from the code
  const lastCanvasRef = useRef('graph') // where browse goes back to
  const toggleView = useCallback(() => setView((v) => (v === 'code' ? lastViewRef.current : 'code')), [])
  useEffect(() => { if (view !== 'code') lastViewRef.current = view }, [view])
  useEffect(() => { if (view === 'song' || view === 'graph') lastCanvasRef.current = view }, [view])

  // Project mode: the code's header line holds the patterns/tracks the UI edits.
  const project = useMemo(() => parseProject(code), [code])
  useEffect(() => { if (view === 'song' && code && !project) setView('graph') }, [view, code, project]) // hand-written code has no song
  // auditioning: a node id; null plays the output
  const [solo, setSolo] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // the canvas switch slides first, then the (heavier) canvas changes, so the slide starts at once
  const [switching, setSwitching] = useState(null)
  const switchCanvas = (to) => {
    if (to === view) return
    setSwitching(to)
    requestAnimationFrame(() => requestAnimationFrame(() => { setView(to); setSwitching(null) }))
  }
  const genRef = useRef({ solo: null })
  genRef.current = { solo }
  const readOnlyRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null) // { msg, action: { label, run } }
  const [refreshKey, setRefreshKey] = useState(0)

  const isNew = !trackId
  const isOwner = !!track?.is_owner
  const canEdit = isNew || isOwner
  // what gets saved: projects always in song mode, whatever you're looping right now
  const savedCode = useMemo(() => {
    const p = parseProject(code)
    return p ? generateCode(p) : code
  }, [code])
  // edited = the project differs from the saved one (not just written out by a newer app)
  const codeChanged = useMemo(() => {
    if (!track || savedCode === track.code) return false
    const mine = parseProject(code)
    const saved = parseProject(track.code)
    return !(mine && saved && JSON.stringify(mine) === JSON.stringify(saved))
  }, [track, savedCode, code])
  const metaChanged = isOwner && (title !== track.title || visibility !== track.visibility)
  const dirty = isNew || codeChanged || metaChanged

  const [preparing, setPreparing] = useState(false) // loading sounds before the first beat
  const preparingRef = useRef(false)
  const preloadRunRef = useRef(0)
  const toastTimer = useRef(null)
  const flash = useCallback((msg, action = null) => {
    setToast({ msg, action })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), action ? 9000 : 2200) // time to reach an undo
  }, [])

  // One editor for the life of the page; tracks are swapped into it.
  useEffect(() => {
    if (editorRef.current) return // StrictMode mounts twice in dev
    editorRef.current = new StrudelMirror({
      defaultOutput: (hap, ...rest) => webaudioOutput(hap.value?.fxsends ? hap.withValue(routeVoice) : hap, ...rest), // reverb & delay sends (fxbus.js)
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

  /** Swap in another version of the project (saved, or from history) as one undoable change. */
  const openVersion = useCallback((text) => {
    const editor = editorRef.current
    const next = parseProject(text)
    if (!editor || !next) { editorRef.current && replaceCode(text); return }
    const current = parseProject(editor.code)
    if (current) {
      const h = historyRef.current
      h.past.push(JSON.stringify(current))
      if (h.past.length > 200) h.past.shift()
      h.future = []
      h.lastAt = 0
      setHistoryTick((n) => n + 1)
    }
    replaceCode(generateCode(next, genRef.current))
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
    // a real change on the scratch pad makes it the thing to come back to (regenerating doesn't)
    if (loadedIdRef.current == null && JSON.stringify(next) !== before) rememberScratchWork()
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
      if (p.song) p.song = { ...p.song, clips: [], autos: [] }
    })
    setSolo(null)
    flash(loadedIdRef.current ? 'Patch cleared · your saved version is untouched' : 'Patch cleared', { label: 'undo', run: () => undoRef.current?.() })
  }, [updateProject, flash])

  // ── automation: right-click a knob → a curve on the timeline (see automation.js) ──
  const [autoEditing, setAutoEditing] = useState(null) // { id, x, y }
  const [showVersions, setShowVersions] = useState(false)
  const [showExport, setShowExport] = useState(false)
  // the piano roll, docked along the bottom: { patternId, channelId }
  // a shared link into the browser (?browse=explore&by=…) opens there
  const [browseView, setBrowseView] = useState(() => {
    const from = new URLSearchParams(window.location.hash.split('?')[1] || window.location.search).get('browse')
    return ['explore', 'mine', 'liked'].includes(from) ? from : 'explore'
  })
  const userRef = useRef(null)
  userRef.current = user
  /** Open the track list, on your own tracks when that's what was asked for. */
  const [browseNarrow, setBrowseNarrow] = useState(null) // one person's tracks, or one track's remixes
  const openBrowse = useCallback((which, narrow = null) => {
    if (which) setBrowseView(which === 'mine' && !userRef.current ? 'explore' : which)
    setBrowseNarrow(narrow)
    setView('browse')
  }, [])
  const [roll, setRoll] = useState(null) // { patternId, channelId, tab }
  const [rollHeight, setRollHeight] = useState(readDockHeight)
  const rollDock = useMemo(() => ({
    at: roll,
    height: roll ? rollHeight : 0,
    open: (patternId, channelId = null, tab = 'rack') => setRoll({ patternId, channelId, tab }),
    close: () => setRoll(null),
  }), [roll, rollHeight])
  const [askSave, setAskSave] = useState(null) // why a save should ask first
  const [askNew, setAskNew] = useState(null) // the template a new track would start from
  const closeAutoEditor = useCallback(() => setAutoEditing(null), [])
  const closeRoll = useCallback(() => setRoll(null), [])
  const automation = useMemo(() => {
    const autos = project?.song?.autos ?? []
    const byTarget = new Map(autos.map((a) => [a.target, a]))
    return {
      automated: new Set(byTarget.keys()),
      /** A new automation for this knob, with a clip on the timeline, opened to draw. */
      automate(target, at) {
        if (!project) return
        if (byTarget.has(target)) return setAutoEditing({ id: byTarget.get(target).id, ...at })
        const found = resolveTarget(project, target)
        if (!found) return
        // over the loop when there is one, else four bars from the bar the playhead is in
        const looping = transport.looping()
        const start = looping ? transport.loop.from : Math.max(0, Math.floor(transport.position() + 1e-9))
        const bars = looping ? Math.max(1, Math.round(transport.loopLength() * 4) / 4) : 4
        const id = newId().replace(/\W/g, '')
        const y = Math.round(toPos(found.value, found.def) * 10000) / 10000
        const hadSound = !!project.song?.clips.some((c) => !c.src.startsWith(AUTO_PREFIX))
        updateProject((p) => {
          p.song = p.song ?? { on: true, snap: 'bar', clips: [] }
          p.song.autos = [...(p.song.autos ?? []), { id, target, bars, points: [{ x: 0, y }, { x: bars, y }] }]
          const lane = Math.max(-1, ...p.song.clips.map((c) => c.lane)) + 1 // a row of its own, under the rest
          p.song.clips.push({ id: `c${newId()}`, src: `${AUTO_PREFIX}${id}`, lane: Math.min(63, lane), start, len: bars })
          if (!hadSound) p.song.on = true // automation alone doesn't switch the patch into song mode
        })
        setAutoEditing({ id, ...at })
        flash(project.song && !project.song.on && hadSound
          ? `Automation added at bar ${start + 1}, but the song is off: turn it on to hear it`
          : `Automation for ${found.owner} · ${found.label} added to the timeline at bar ${start + 1}`)
      },
      open(target, at) {
        const auto = byTarget.get(target) ?? autos.find((a) => a.id === target)
        if (auto) setAutoEditing({ id: auto.id, ...at })
      },
      remove(target) {
        const auto = byTarget.get(target) ?? autos.find((a) => a.id === target)
        if (!auto) return
        updateProject((p) => {
          if (!p.song) return
          p.song.autos = (p.song.autos ?? []).filter((a) => a.id !== auto.id)
          p.song.clips = p.song.clips.filter((c) => c.src !== `${AUTO_PREFIX}${auto.id}`)
          if (p.song.colors) delete p.song.colors[`${AUTO_PREFIX}${auto.id}`]
        })
        setAutoEditing((e) => (e?.id === auto.id ? null : e))
        flash(`Automation removed · ctrl/cmd + Z brings it back`)
      },
      showTimeline() {
        setAutoEditing(null)
        switchCanvas('song')
      },
    }
  }, [project, updateProject, transport, flash]) // eslint-disable-line react-hooks/exhaustive-deps

  // automated knobs turn with their curves while the song plays
  const autoFns = useMemo(() => (project ? activeAutos(project).map((a) => {
    const fn = autoValueFn(project, a)
    // reverb, delay and stereo knobs are the app's own: it moves them as the curve goes
    return fn && { target: a.target, fn, app: appParam(project, a.target), base: resolveTarget(project, a.target)?.value }
  }).filter(Boolean) : []), [project])
  useEffect(() => {
    if (!started || !autoFns.length) { autoLive.clear(); return }
    const apply = (a, value) => {
      const v = value * (a.app.scale ?? 1)
      // a reverb's room is rebuilt when its size changes, so only move in steps
      const stepped = ['size', 'tone', 'width'].includes(a.app.param) ? Math.round(v * 40) / 40 : v
      if (a.last === stepped) return
      a.last = stepped
      const patch = { [a.app.param]: stepped }
      if (a.app.where === 'fx') setFxParams(a.app.key, patch)
      else if (a.app.where === 'engine') setEngineParams(a.app.key, patch)
      else setInsertParams(a.app.key, patch)
    }
    let raf = 0
    let last = 0
    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 40) return // 25 times a second is plenty for a knob
      last = now
      const at = transport.position()
      const values = new Map()
      for (const a of autoFns) {
        const value = a.fn(at)
        values.set(a.target, value)
        if (a.app) apply(a, value)
      }
      autoLive.set(values)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      autoLive.clear()
      // stopped: the app's own knobs go back to where they're set
      for (const a of autoFns) {
        if (!a.app || a.base === undefined) continue
        a.last = undefined
        const patch = { [a.app.param]: a.base * (a.app.scale ?? 1) }
        if (a.app.where === 'fx') setFxParams(a.app.key, patch)
        else if (a.app.where === 'engine') setEngineParams(a.app.key, patch)
        else setInsertParams(a.app.key, patch)
      }
    }
  }, [started, autoFns, transport])

  const undoRef = useRef(null)
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
  undoRef.current = undo
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
    transport.toMark() // back to wherever the playhead was put
  }, [transport])
  /** Pause: stop, and resume from here next time. */
  const pause = useCallback(() => {
    const at = transport.position()
    editorRef.current?.stop()
    silenceNow() // a note already ringing would otherwise play itself out after the pause
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
      if (startOver) forgetScratchWork() // a fresh pad isn't work yet
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
        rememberTrack(trackId)
        const draft = readDraft(trackId, t.updated_at)
        putCode(trackId, draft ?? t.code)
        if (pendingPlayRef.current === trackId) {
          pendingPlayRef.current = null
          play()
        }
      })
      .catch((e) => {
        if (!alive) return
        if (lastTrack() === trackId) store.set(LAST_TRACK, null) // don't keep reopening a track that's gone
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

  const save = useCallback(async ({ replace = false } = {}) => {
    if (!canEdit || busy) return
    if (!user) return login()
    // replacing the saved track with what looks like a different or emptied one: ask first
    if (!isNew && !replace && track) {
      const reason = replaceRisk()
      if (reason) return setAskSave(reason)
    }
    setBusy(true)
    try {
      const body = { title: title.trim() || 'untitled', code: songCodeOf(editorRef.current.code), visibility }
      if (isNew) {
        const t = await api('/tracks', { method: 'POST', body })
        clearDraft(null)
        forgetScratchWork() // it's a saved track now
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
  }, [canEdit, busy, user, login, title, visibility, isNew, trackId, navigate, flash, track, codeChanged]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Why saving over the open track might wipe work, or null: a new name on a changed patch
   * (a new track, most likely), or a patch that keeps well under half of what was saved.
   */
  const replaceRisk = () => {
    if (!track || !codeChanged) return null
    const saved = parseProject(track.code)
    const mine = parseProject(editorRef.current?.code ?? '')
    const size = (p) => ({ nodes: p.nodes.filter((n) => n.type !== 'output').length, patterns: p.patterns.length, clips: p.song?.clips.length ?? 0 })
    const before = saved && size(saved)
    const after = mine && size(mine)
    const total = (x) => x.nodes + x.patterns + x.clips
    if ((title.trim() || 'untitled') !== track.title) return { kind: 'renamed', before, after }
    if (before && after && total(before) >= 4 && total(after) <= total(before) * 0.5) return { kind: 'shrunk', before, after }
    return null
  }

  /**
   * Start a new track (blank, or the demo patch). The open track is never touched; unsaved
   * changes to it stay in this browser. Only the scratch pad's own unsaved work would be
   * replaced, so that asks first.
   */
  const newTrack = (template = 'blank', { force = false } = {}) => {
    if (!force && ((isNew && store.get(SCRATCH_WORK) === 'yes') || (!isNew && codeChanged))) return setAskNew(template)
    if (view === 'browse' || view === 'code') setView('graph')
    navigate('/', { state: { fresh: Date.now(), template } })
    flash(template === 'demo' ? 'New track from the demo patch' : 'New track · nothing else changed')
  }

  /** Save what's open as a track of its own; the track it came from keeps its saved version. */
  const saveAsNew = async () => {
    if (!user) return login()
    setBusy(true)
    try {
      const from = track
      const name = (title.trim() || from?.title || 'untitled').slice(0, 80)
      const t = await api('/tracks', { method: 'POST', body: { title: name, code: songCodeOf(editorRef.current.code), visibility } })
      if (from) clearDraft(from.id) // its unsaved changes live on in the new track
      navigate(`/t/${t.id}`)
      setRefreshKey((k) => k + 1)
      flash(from ? `Saved as a new track · “${from.title}” is unchanged` : 'Saved')
    } catch (e) {
      flash(`Couldn’t save: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const remix = async () => {
    if (!user) return login()
    setBusy(true)
    try {
      const t = await api('/tracks', {
        method: 'POST',
        body: { title: `${track.title} (copy)`.slice(0, 80), code: songCodeOf(editorRef.current.code), visibility: 'public', forked_from: track.id },
      })
      clearDraft(track.id)
      navigate(`/t/${t.id}`)
      setRefreshKey((k) => k + 1)
      flash('Remixed into your tracks')
    } catch (e) {
      flash(`Couldn’t save a copy: ${e.message}`)
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
    openVersion(track.code)
    clearDraft(track.id)
    flash('Back to your saved version', { label: 'undo', run: () => undoRef.current?.() })
  }

  const playFromList = (id) => {
    if (id === trackId && loadedIdRef.current === id) return play()
    pendingPlayRef.current = id
    navigate(`/t/${id}`)
  }

  // Page-wide shortcuts (Strudel's own only fire while the editor has focus). Capture
  // phase + stopPropagation so a focused editor doesn't run them a second time.
  const keysRef = useRef({})
  keysRef.current = {
    play, save, stop, pause, toStart, undo, redo, isProject: !!project,
    saveAsNew: () => (isNew || !isOwner ? save() : saveAsNew()),
    swapCanvas: () => switchCanvas(view === 'song' ? 'graph' : 'song'),
  }
  useEffect(() => {
    // only places you type text keep space and Home for themselves. A focused button, slider,
    // checkbox or dropdown doesn't: clicking one leaves focus on it, and space must still play.
    const TEXT_INPUT = 'input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=color]):not([type=file]), textarea'
    const typing = (el) => {
      if (el?.closest?.(TEXT_INPUT)) return true
      const editable = el?.closest?.('[contenteditable="true"]')
      if (!editable || !editable.getClientRects().length) return false
      // the code editor keeps space only while you can type in it: a patch's code is read-only
      return !(keysRef.current.isProject && editable.closest('.cm-editor'))
    }
    let spaceDown = false
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod && !e.altKey && !typing(e.target)) {
        // DAW keys outside text fields: space plays/pauses, Home goes to the start
        const space = e.key === ' ' || e.code === 'Space'
        if (space) {
          // held down, the key repeats: one press is one toggle
          if (!e.repeat && !spaceDown) editorRef.current?.repl.scheduler.started ? keysRef.current.pause() : keysRef.current.play()
          spaceDown = true
        } else if (e.key === 'Tab') {
          // tab does one thing here: swap the canvas between the timeline and the patch
          // (inside a dialog or menu it still steps through what's in there)
          if (e.target.closest?.('dialog, .popover, .knob-menu, .auto-pop')) return
          if (keysRef.current.isProject) keysRef.current.swapCanvas()
        } else if (e.key === 'Home') keysRef.current.toStart()
        else return
        e.preventDefault() // no page scroll, and no click on the focused button
        e.stopPropagation() // nor a second use of the key by the canvas, piano roll or a dropdown
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
      // ctrl/cmd + A never selects the page's text: it means "select everything here" to
      // whatever you're working in (the piano roll, the timeline), and nothing elsewhere.
      // The event carries on to them; only the browser's own select-all is called off.
      if (mod && !e.altKey && e.key.toLowerCase() === 'a' && !textEntry) { e.preventDefault(); return }
      if (e.key === 'Enter') keysRef.current.play()
      else if (e.key === '.' || e.code === 'Period') keysRef.current.stop()
      else if (mod && e.shiftKey && e.key.toLowerCase() === 's') keysRef.current.saveAsNew()
      else if (mod && e.key.toLowerCase() === 's') keysRef.current.save()
      else if (mod && e.key.toLowerCase() === 'j') setView((v) => (v === 'code' ? lastViewRef.current : 'code'))
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    // a focused button clicks itself when space comes back up: that's the press we already used
    const onKeyUp = (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return
      const handled = spaceDown
      spaceDown = false
      if (handled && !typing(e.target)) { e.preventDefault(); e.stopPropagation() }
    }
    const reset = () => { spaceDown = false }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', reset)
    }
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

  // ── the program menu ──
  const hasPatch = !!project?.nodes.some((n) => n.type !== 'output')
  // who's signed in (the track itself is edited from the track menu)
  const menuHeader = (
    <div className="pm-head">
      {user ? (
        <>
          <span className="pm-head-face" aria-hidden>{(user.name || user.email || '?').trim()[0].toUpperCase()}</span>
          <span className="pm-head-title">{user.name || user.email}</span>
          {user.name && user.email && <span className="pm-head-status">{user.email}</span>}
        </>
      ) : (
        <>
          <span className="pm-head-title">{userLoading ? 'checking…' : 'not signed in'}</span>
          <span className="pm-head-status">sign in to save, like and copy tracks</span>
        </>
      )}
    </div>
  )
  const programMenus = [
    {
      label: 'file',
      items: [
        { label: 'new track', onSelect: () => newTrack('blank'), hint: 'The open track stays as it is' },
        { label: 'open…', onSelect: () => openBrowse('mine'), hint: 'Your tracks, and what people have shared' },
        'line',
        canEdit && { label: isNew ? 'save as a track' : 'save', shortcut: 'ctrl/cmd S', onSelect: () => save(), disabled: busy || (!!user && !dirty) },
        isOwner && { label: 'save as a new track', shortcut: 'ctrl/cmd shift S', onSelect: () => saveAsNew(), disabled: busy, hint: 'This track stays as it was saved' },
        !canEdit && track && { label: 'save a copy', onSelect: () => remix(), disabled: busy, hint: 'Yours to change · it still credits the original' },
        isOwner && { label: 'earlier saves…', onSelect: () => setShowVersions(true), hint: 'Each time you save, the one before is kept here' },
        project && { label: 'export…', onSelect: () => { stop(); setShowExport(true) }, hint: 'Bounce it to a WAV or MP3' },
        codeChanged && track && !isOwner && { label: 'undo my changes', onSelect: () => revert() },
        track && 'line',
        track && { label: 'copy link', onSelect: () => share() },
      ],
    },
    {
      label: 'edit',
      items: [
        { label: 'undo', shortcut: 'ctrl/cmd Z', onSelect: () => undo(), disabled: !historyRef.current.past.length },
        { label: 'redo', shortcut: 'ctrl/cmd shift Z', onSelect: () => redo(), disabled: !historyRef.current.future.length },
        project && canEdit && 'line',
        project && canEdit && { label: 'clear the patch…', onSelect: () => setConfirmClear(true), disabled: !hasPatch, hint: 'Empty the patch: nodes, wires, patterns and the song' },
      ],
    },
    {
      label: 'view',
      items: [
        project && { label: 'timeline', checked: view === 'song', onSelect: () => switchCanvas('song') },
        project && { label: 'patch', checked: view === 'graph', onSelect: () => switchCanvas('graph') },
        { label: evalError ? 'code (has an error)' : 'code', shortcut: 'ctrl/cmd J', checked: view === 'code', onSelect: () => setView('code') },
        { label: 'browse tracks', checked: view === 'browse', onSelect: () => setView('browse') },
      ],
    },
    canEdit && {
      label: 'track',
      items: [
        { heading: 'name' },
        { custom: <input className="tm-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="untitled" maxLength={80} aria-label="Track title" /> },
        { heading: 'visible to' },
        ...[['public', 'anyone', 'Listed in explore'], ['unlisted', 'anyone with the link', 'Not listed'], ['private', 'only me', 'Only you']].map(([v, label, hint]) => ({ label, hint, checked: visibility === v, onSelect: () => setVisibility(v) })),
        isOwner && 'line',
        isOwner && { label: 'delete track…', danger: true, onSelect: () => setConfirmDelete(true), hint: 'Remove the saved track for everyone' },
      ],
    },
    {
      label: 'account',
      items: user ? [
        { label: 'your tracks', onSelect: () => openBrowse('mine') },
        { label: 'sign out', onSelect: () => logout(window.location.pathname) },
      ] : [
        { label: userLoading ? 'checking…' : 'sign in', disabled: userLoading, onSelect: () => login(), hint: 'Save, like and copy tracks with your blue wind account' },
      ],
    },
  ].filter(Boolean)

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
          <button
            className={`btn play ${started ? 'on' : ''} ${preparing ? 'preparing' : ''}`}
            onClick={started ? pause : play}
            aria-busy={preparing}
            title={started ? 'Pause (space) · re-evaluate with ctrl/cmd + enter' : 'Play (space)'}
          >{started ? 'pause' : preparing ? 'loading' : 'play'}</button>
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
        <Position transport={transport} started={started} bpm={project ? project.bpm : (evaluated.cps ?? 0.5) * 60 * transport.beats} songBars={project?.song ? songLength(project.song) : 0} />
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
        {/* the track catalogue is one click away, wherever you are */}
        <button
          className={`btn browse-btn ${view === 'browse' ? 'on' : ''}`}
          aria-pressed={view === 'browse'}
          onClick={() => setView(view === 'browse' ? lastCanvasRef.current : 'browse')}
          title={view === 'browse' ? 'Back to your track' : 'Browse tracks: yours, and what people have shared'}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden><path d="M1.5 1.5h3.6v3.6H1.5zM6.9 1.5h3.6v3.6H6.9zM1.5 6.9h3.6v3.6H1.5zM6.9 6.9h3.6v3.6H6.9z" fill="currentColor" /></svg>
          <span className="browse-word">browse</span>
        </button>
        {/* what the canvas shows: the patch or the song */}
        <span className={`canvas-switch ${(switching ?? view) === 'song' ? 'at-first' : (switching ?? view) === 'graph' ? 'at-second' : 'at-neither'}`} role="group" aria-label="Canvas">
          <Glass className="cs-thumb" aria-hidden />
          <button className={`cs-opt ${(switching ?? view) === 'song' ? 'on' : ''}`} aria-pressed={view === 'song'} onClick={() => switchCanvas('song')} title="The timeline: when each part plays" disabled={!project}>timeline</button>
          <button className={`cs-opt ${(switching ?? view) === 'graph' ? 'on' : ''}`} aria-pressed={view === 'graph'} onClick={() => switchCanvas('graph')} title="The patch: what each part goes through">patch</button>
        </span>
        <button
          className="btn bar-export"
          onClick={() => setShowExport(true)}
          disabled={!project}
          title="Bounce the track to a file: wav, mp3 or m4a"
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 1.4v5.4M3.7 4.6 6 6.9l2.3-2.3M2.1 8.4v1.3a.9.9 0 0 0 .9.9h6a.9.9 0 0 0 .9-.9V8.4" />
          </svg>
          <span className="export-word">export</span>
        </button>
        <div className="bar-side right">
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
              <button className={`btn save ${dirty || !user ? 'primary' : ''} ${user ? '' : 'signed-out'}`} onClick={() => save()} disabled={busy || (!!user && !dirty)} title={!user ? 'Sign in to save this track' : dirty ? (isNew ? 'Save as a track (ctrl/cmd + S)' : `Save “${track?.title}” (ctrl/cmd + S)`) : 'Everything is saved'}>
                {busy ? 'saving…' : !user || dirty ? 'save' : 'saved'}
              </button>
            </>
          ) : track ? (
            <>
              <span className="track-heading" title={`by ${track.author}`}>
                <span className="track-title">{track.title}</span>
                <span className="meta">by {track.author}</span>
              </span>
              <button className={`btn ${track.liked ? 'on' : ''}`} onClick={like} title="Like">♥{track.likes}</button>
            </>
          ) : null}
          {track && (track.parent || track.remixes > 0) && (
            <span className="track-line">
              {track.parent && (
                <Link className="track-line-from" to={`/t/${track.parent.id}`} data-tip={`Opens ${track.parent.title} by ${track.parent.author}`}>
                  copy of {track.parent.title}
                </Link>
              )}
              {track.remixes > 0 && (
                <button
                  type="button"
                  className="track-line-out"
                  onClick={() => openBrowse('explore', { remixesOf: track.id, name: `copies of ${track.title}` })}
                  data-tip="Tracks people saved a copy of and made their own"
                >{track.remixes} cop{track.remixes === 1 ? 'y' : 'ies'}</button>
              )}
            </span>
          )}
        </span>
        {/* everything else lives in one menu, like a desktop program's */}
        <Popover
          label={<><svg viewBox="0 0 14 12" width="14" height="12" aria-hidden><path d="M1 2h12M1 6h12M1 10h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span className="menu-word">menu</span></>}
          title="File, edit, view, track, account"
          className={`menu-btn ${evalError && view !== 'code' ? 'has-error' : ''}`}
          panelClassName="program-menu"
        >
          {(close) => <ProgramMenu close={close} header={menuHeader} menus={programMenus} />}
        </Popover>
        </div>
        {/* phones: every view in a tab bar along the bottom */}
        <span className="seg views phone-tabs" role="group" aria-label="View">
          <button className={`btn ${view === 'browse' ? 'on' : ''}`} aria-pressed={view === 'browse'} onClick={() => setView('browse')} title="Tracks people have shared, and yours">browse</button>
          {project && <button className={`btn ${view === 'song' ? 'on' : ''}`} aria-pressed={view === 'song'} onClick={() => setView('song')} title="The timeline: when each part plays">timeline</button>}
          <button className={`btn ${view === 'graph' ? 'on' : ''}`} aria-pressed={view === 'graph'} onClick={() => setView('graph')} title="The patch: what each part goes through">patch</button>
          <button
            className={`btn code-toggle ${view === 'code' ? 'on' : ''} ${evalError && view !== 'code' ? 'has-error' : ''}`}
            aria-pressed={view === 'code'}
            title="Show the code (ctrl/cmd + J)"
            onClick={toggleView}
          >{'{ }'}<span className="code-word"> code</span>{evalError && view !== 'code' ? ' !' : ''}</button>
        </span>
      </header>

      {showExport && project && (
        <ExportDialog
          project={project}
          title={title || track?.title || 'track'}
          transport={transport}
          onFlash={flash}
          onClose={() => setShowExport(false)}
        />
      )}
      {showVersions && track?.is_owner && (
        <Versions
          trackId={track.id}
          savedCode={track.code}
          onClose={() => setShowVersions(false)}
          onOpen={(v) => {
            setShowVersions(false)
            openVersion(v.code)
            if (v.title) setTitle(v.title)
            flash(`Opened the version from ${timeAgo(v.saved_at)} · save to keep it`, { label: 'undo', run: () => undoRef.current?.() })
          }}
        />
      )}
      <AutomationContext.Provider value={project ? automation : null}>
      <RollContext.Provider value={rollDock}>
      <div className="body">
        <main className="main">
          {view === 'browse' && (
            <Browser
              user={user}
              login={login}
              activeId={trackId}
              refreshKey={refreshKey}
              view={browseView}
              narrowTo={browseNarrow}
              onView={setBrowseView}
              onPlay={playFromList}
              onPick={() => setView('graph')}
              onNew={(template) => newTrack(template)}
            />
          )}
          {confirmClear && project && (
            <ConfirmDialog
              title="Clear the patch?"
              confirmLabel="clear the patch"
              danger
              altLabel={isNew ? null : 'start a new track instead'}
              onAlt={() => { setConfirmClear(false); newTrack('blank') }}
              onCancel={() => setConfirmClear(false)}
              onConfirm={() => {
                setConfirmClear(false)
                clearPatch()
              }}
            >
              <p>This removes <strong>{project.nodes.filter((n) => n.type !== 'output').length} nodes</strong>, their wires, <strong>{project.patterns.length} pattern{project.patterns.length === 1 ? '' : 's'}</strong> with all their steps and notes, and the song's clips. The output and tempo stay.</p>
              <p>{isNew ? 'Ctrl/cmd + Z brings it back.' : <>Making something new? <strong>Start a new track instead</strong>: “{track?.title}” stays as it is. Clearing empties this track, and saving would replace it.</>}</p>
            </ConfirmDialog>
          )}
          {askSave && track && (
            <ConfirmDialog
              title="Save as a new track, or replace this one?"
              confirmLabel="save as a new track"
              altLabel={`replace “${track.title}”`}
              onCancel={() => setAskSave(null)}
              onAlt={() => { setAskSave(null); save({ replace: true }) }}
              onConfirm={() => { setAskSave(null); saveAsNew() }}
            >
              {askSave.kind === 'renamed'
                ? <p>You renamed it to <strong>“{title.trim() || 'untitled'}”</strong> and changed the patch, so this looks like a new track.</p>
                : <p>This would replace “{track.title}” with a much smaller patch: <strong>{countText(askSave.after)}</strong> instead of <strong>{countText(askSave.before)}</strong>.</p>}
              <p><strong>Save as a new track</strong> keeps “{track.title}” exactly as it was saved. <strong>Replace</strong> saves over it (what's there now stays in <em>earlier saves</em>).</p>
            </ConfirmDialog>
          )}
          {askNew && (
            <ConfirmDialog
              title="Start a new track?"
              confirmLabel="start a new track"
              altLabel={isNew ? 'save this first' : null}
              onCancel={() => setAskNew(null)}
              onAlt={() => { setAskNew(null); save() }}
              onConfirm={() => { const template = askNew; setAskNew(null); newTrack(template, { force: true }) }}
            >
              {isNew
                ? <p>The scratch pad has work that isn't saved as a track. A new track replaces it (ctrl/cmd + Z brings it back until you leave the page). Save it first to keep it.</p>
                : <p>“{track?.title}” has unsaved changes. They stay in this browser and come back when you open it again, but they aren't saved. The saved track doesn't change.</p>}
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
      {roll && project && (
        <DetailDock
          project={project}
          at={roll}
          transport={transport}
          started={started}
          height={rollHeight}
          onUpdateProject={updateProject}
          onHeight={setRollHeight}
          onTab={(tab) => setRoll((r) => ({ ...r, tab }))}
          onPick={(channelId) => setRoll((r) => ({ ...r, channelId, tab: 'notes' }))}
          onClose={closeRoll}
        />
      )}
      {/* plugin windows for the app's own instruments, floating over everything */}
      <SynthWindows project={project} onUpdateProject={updateProject} />

      {autoEditing && project && (
        <AutomationEditor
          key={autoEditing.id}
          project={project}
          autoId={autoEditing.id}
          anchor={autoEditing}
          beats={transport.beats}
          onUpdateProject={updateProject}
          onRemove={() => automation.remove(autoEditing.id)}
          onShowTimeline={view === 'song' ? null : () => automation.showTimeline()}
          onClose={closeAutoEditor}
        />
      )}
      </RollContext.Provider>
      </AutomationContext.Provider>
      <Tooltip />

      {toast && (
        <div className={`toast ${toast.action ? 'with-action' : ''}`} role="status">
          <span>{toast.msg}</span>
          {toast.action && <button type="button" className="toast-action" onClick={() => { setToast(null); toast.action.run() }}>{toast.action.label}</button>}
        </div>
      )}
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
/** Seconds as 1:04.2 (or 1:04 when it's a length, not a position). */
function clockText(seconds, tenths = true) {
  const s = Math.max(0, seconds)
  const mins = Math.floor(s / 60)
  const rest = s - mins * 60
  return `${mins}:${String(Math.floor(rest)).padStart(2, '0')}${tenths ? `.${Math.floor((rest % 1) * 10)}` : ''}`
}

const POSITION_MODES = ['bars', 'time', 'length']

function Position({ transport, started, bpm, songBars }) {
  const inputRef = useRef(null)
  const barRef = useRef(null)
  const [mode, setMode] = useState(() => (POSITION_MODES.includes(readPref('strudel:position-mode', 'bars')) ? readPref('strudel:position-mode', 'bars') : 'bars'))
  useEffect(() => writePref('strudel:position-mode', mode), [mode])
  // a bar takes this many seconds, so bars turn into minutes and seconds
  const barSeconds = (60 / Math.max(1, Number(bpm) || 120)) * Math.max(1, transport.beats)
  const cycle = () => setMode((m) => POSITION_MODES[(POSITION_MODES.indexOf(m) + 1) % POSITION_MODES.length])
  const modeRef = useRef(mode)
  modeRef.current = mode
  const secondsRef = useRef(barSeconds)
  secondsRef.current = barSeconds
  const barsRef = useRef(songBars)
  barsRef.current = songBars
  useEffect(() => {
    const show = () => {
      const pos = transport.position()
      const input = inputRef.current
      const text = modeRef.current === 'bars'
        ? formatBarBeat(pos, transport.beats)
        : modeRef.current === 'time'
          ? clockText(pos * secondsRef.current)
          : clockText(barsRef.current * secondsRef.current, false)
      if (input && document.activeElement !== input) input.value = text
      barRef.current?.style.setProperty('--phase', pos - Math.floor(pos))
    }
    show()
    if (!started) return transport.subscribe(show)
    let frame
    const tick = () => { show(); frame = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [started, transport, mode, songBars, barSeconds])

  const onKeyDown = (e) => {
    const step = e.shiftKey || e.key.startsWith('Page') ? 1 : 1 / transport.beats
    const pos = transport.position()
    const snapped = Math.round(pos * transport.beats) / transport.beats
    if (mode !== 'bars') { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycle() }; return }
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
    <label
      className={`lcd position ${started ? 'running' : ''} ${mode === 'bars' ? '' : 'clock'}`}
      title={mode === 'bars' ? 'Type bar.beat and press Enter to jump · arrows nudge · click the label for the clock' : mode === 'time' ? 'How far in, in minutes and seconds · click for the song\'s length' : `How long the song is${songBars ? ` (${Math.ceil(songBars)} bars)` : ''} · click for bar.beat`}
    >
      <input
        ref={inputRef}
        className="lcd-value"
        defaultValue="001.1"
        readOnly={mode !== 'bars'}
        aria-label={mode === 'bars' ? 'Song position, bar.beat' : mode === 'time' ? 'How far into the song, in minutes and seconds' : 'How long the song is'}
        spellCheck={false}
        onKeyDown={onKeyDown}
        onFocus={(e) => { if (mode === 'bars') e.currentTarget.select() }}
        onClick={() => { if (mode !== 'bars') cycle() }}
        onBlur={(e) => { e.currentTarget.classList.remove('invalid'); if (mode === 'bars') e.currentTarget.value = formatBarBeat(transport.position(), transport.beats) }}
      />
      <button type="button" className="lcd-unit" onClick={cycle} title="Show bar.beat, the time so far, or how long the song is">
        {mode === 'bars' ? 'bar.beat' : mode === 'time' ? 'time' : 'length'}
      </button>
      <span className="cycle-bar" ref={barRef} />
    </label>
  )
}
