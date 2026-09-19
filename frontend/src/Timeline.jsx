import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makePattern, makeVariation, newId } from './project'
import { MAX_BARS, laneInfo, songLength, songParts } from './song'
import Popover from './Popover.jsx'
import { Glass } from './Glass.jsx'
import { useAutomation } from './autoLive.js'
import { pointerAt, pointerGone, selectionIs, useHolders } from './collab.js'
import PeerCursors from './PeerCursors.jsx'
import { useRollDock } from './rollDock.js'
import { KnobMenu } from './KnobMenu.jsx'
import { AUTO_PREFIX, curveAt, resolveTarget } from './automation.js'
import ConfirmDialog from './ConfirmDialog.jsx'
import { KitSelect } from './Graph.jsx'
import { NODE_TYPES } from './graph'
import './Timeline.css'
import { PICKS, colorFor, inkFor } from './clipColors.js'

/**
 * The song view: parts on the left, a timeline on the right. Drag a part onto a row to
 * place a clip; drag a clip to move it (shift: a copy), its edges to stretch or trim it; right-click
 * (or right-drag across several) deletes; the slice tool (C) cuts clips in two; ctrl/cmd-click
 * or drag across empty rows to select several. Clicking the ruler moves the playhead,
 * dragging along it sets a loop. Ctrl/cmd + scroll zooms, middle-drag pans, ctrl/cmd +
 * middle-drag zooms both ways (sideways: wider bars, up and down: taller rows), alt + scroll
 * sizes the rows.
 */
const PART_MIME = 'application/x-lattice-part'
const LANE_DEFAULT = 40
const MIN_LANE = 22
const MAX_LANE = 120
const RULER_H = 26
const HEAD_W = 136 // the row headers down the left of the timeline
const EDGE = 7 // px at each end of a clip that stretch it
const MIN_PPB = 10
const MAX_PPB = 260
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const wrap = (a, n) => (n > 0 ? ((a % n) + n) % n : a)

/**
 * What's in a pattern, drawn as FL draws it on a clip: drum hits in a row per instrument,
 * notes at their pitch. One pattern length as an SVG data URL, tiled along the clip.
 */
function patternSketch(pattern, ink) {
  if (!pattern) return null
  const total = pattern.bars * pattern.stepsPerBar
  const live = pattern.channels.filter((c) => !c.mute)
  const drums = live.filter((c) => c.kind === 'drum' && c.steps?.some(Boolean))
  const notes = live.filter((c) => c.kind === 'synth').flatMap((c) => c.notes ?? [])
  if (!total || (!drums.length && !notes.length)) return null
  const H = 100
  const noteH = notes.length ? (drums.length ? 62 : H) : 0
  const rects = []
  if (notes.length) {
    const lo = Math.min(...notes.map((n) => n.n)), hi = Math.max(...notes.map((n) => n.n))
    const rows = Math.max(8, hi - lo + 1)
    const row = noteH / rows
    const base = lo - Math.floor((rows - (hi - lo + 1)) / 2)
    for (const n of notes) {
      const y = noteH - (n.n - base + 1) * row
      rects.push(`<rect x="${n.s + 0.06}" y="${y.toFixed(2)}" width="${Math.max(0.3, n.l - 0.12)}" height="${Math.max(2.5, row * 0.8).toFixed(2)}"/>`)
    }
  }
  if (drums.length) {
    const top = noteH ? noteH + 4 : 0
    const row = (H - top) / drums.length
    drums.forEach((c, r) => {
      c.steps.forEach((on, i) => {
        if (on) rects.push(`<rect x="${i + 0.12}" y="${(top + r * row + row * 0.12).toFixed(2)}" width="0.62" height="${(row * 0.76).toFixed(2)}"/>`)
      })
    })
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${H}" preserveAspectRatio="none"><g fill="${ink}" fill-opacity="0.72">${rects.join('')}</g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** An automation's curve as FL draws it on a clip: a line with a light fill under it. */
function autoSketch(auto, ink) {
  if (!auto) return null
  const W = Math.max(64, Math.round(auto.bars * 64))
  const pts = []
  for (let i = 0; i <= W; i++) pts.push(`${i},${(100 - curveAt(auto, (i / W) * auto.bars) * 92 - 4).toFixed(1)}`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 100" preserveAspectRatio="none"><path d="M0,100L${pts.join('L')}L${W},100Z" fill="${ink}" fill-opacity="0.16"/><path d="M${pts.join('L')}" fill="none" stroke="${ink}" stroke-opacity="0.85" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

function readRows() {
  try { return clamp(Number(localStorage.getItem('lattice:song:rows')) || LANE_DEFAULT, MIN_LANE, MAX_LANE) } catch { return LANE_DEFAULT }
}

function readZoom() {
  try { return clamp(Number(localStorage.getItem('lattice:song:zoom')) || 48, MIN_PPB, MAX_PPB) } catch { return 48 }
}

export default function Timeline({ project, onUpdateProject, transport, started }) {
  const song = project.song ?? { on: true, snap: 'bar', clips: [] }
  const beats = Math.max(1, project.beats || 4)
  const parts = useMemo(() => songParts(project), [project])
  const partBySrc = useMemo(() => new Map(parts.map((p) => [p.src, p])), [parts])
  // each pattern's sketch for its clips (redrawn only when the pattern or its colour changes)
  const sketchCache = useRef(new Map())
  const automation = useAutomation()
  const sketchFor = (src) => {
    const isAuto = src?.startsWith(AUTO_PREFIX)
    if (!src?.startsWith('pattern:') && !isAuto) return null
    const pattern = isAuto ? song.autos?.find((a) => a.id === src.slice(AUTO_PREFIX.length)) : project.patterns.find((p) => p.id === src.slice(8))
    const ink = inkFor(colorFor(src, song.colors))
    const hit = sketchCache.current.get(src)
    if (hit && hit.ink === ink) {
      // The project is read back from the track's code, so anything that rewrites a line
      // hands us new pattern objects holding the same music. Same notes, same sketch:
      // asking what the pattern says beats redrawing every clip on the timeline for nothing.
      if (hit.pattern === pattern) return hit.url
      const said = JSON.stringify(pattern)
      if (said === hit.said) { hit.pattern = pattern; return hit.url }
    }
    const url = isAuto ? autoSketch(pattern, ink) : patternSketch(pattern, ink)
    sketchCache.current.set(src, { pattern, said: JSON.stringify(pattern), ink, url })
    return url
  }
  const length = songLength(song)
  const inPatch = parts.filter((p) => p.inPatch && p.kind !== 'auto')
  const unused = parts.filter((p) => !p.inPatch)
  const autoParts = parts.filter((p) => p.kind === 'auto')
  const soundClips = song.clips.filter((c) => !c.src.startsWith(AUTO_PREFIX)).length

  const [ppb, setPpb] = useState(readZoom) // pixels per bar
  const ppbRef = useRef(ppb)
  ppbRef.current = ppb
  const [laneH, setLaneH] = useState(readRows) // row height
  const LANE_H = laneH
  const [selected, setSelected] = useState(() => new Set())
  const [activePart, setActivePart] = useState(null) // src: empty-row drags draw this part
  const [drag, setDrag] = useState(null) // live preview while moving / stretching / drawing
  const [marquee, setMarquee] = useState(null)
  const [erasing, setErasing] = useState(false) // right button held: the pointer shows it deletes
  // Letting go used to leave the clip raised for a moment so it could drop the last of the
  // way. It read as a hop: you've already put it where it goes, and the white outline has
  // been showing you that spot the whole time. It lands where you dropped it.
  /**
   * Only clips that have just turned up play the arriving animation. Hanging it on every
   * clip meant the whole timeline popped each time you came back to it from the patch,
   * since coming back builds the list again from nothing.
   */
  const [arriving, setArriving] = useState(null)
  const seen = useRef(null)
  const arrived = useRef(0)
  useEffect(() => {
    const ids = new Set(song.clips.map((c) => c.id))
    const before = seen.current
    seen.current = ids
    if (!before) return // the first look: everything here was already here
    const fresh = [...ids].filter((id) => !before.has(id))
    if (!fresh.length) return
    setArriving(new Set(fresh))
    clearTimeout(arrived.current)
    arrived.current = setTimeout(() => setArriving(null), 340)
  }, [song.clips])
  useEffect(() => () => clearTimeout(arrived.current), [])

  const [vanishing, setVanishing] = useState(null) // erased, and still shrinking away
  const vanished = useRef(0)
  const vanish = (ids) => {
    setVanishing(new Set(ids))
    clearTimeout(vanished.current)
    vanished.current = setTimeout(() => setVanishing(null), 260)
  }
  useEffect(() => () => clearTimeout(vanished.current), [])

  /**
   * A carried clip leans the way you're throwing it and comes back level when you stop.
   * Four numbers, read from how fast the pointer is going and stepped every frame, written
   * straight to the lanes as custom properties — no state, no re-render, no library, and
   * the transform they feed stays on the compositor.
   */
  const lean = useRef({ swing: 0, sv: 0, tx: 0, ty: 0, speed: 0, vx: 0, vy: 0, x: 0, y: 0, t: 0, frame: 0, held: false })
  const leanOn = () => {
    const s = lean.current
    if (s.frame) return
    const step = () => {
      const n = lean.current
      // A pendulum, not a fading number: how fast you're pulling pushes it, and it's
      // pulled back toward level the further it gets — so it overshoots and settles the
      // way something hanging does, instead of easing straight back.
      n.sv = (n.sv + n.vx * 0.3 - n.swing * 0.12) * 0.86
      n.swing = clamp(n.swing + n.sv, -3, 3)
      // the face turns a little toward where it's going, and pitches a little when you pull up or down
      n.tx = n.tx * 0.82 + clamp(-n.vy * 1.6, -3.5, 3.5) * 0.18
      n.ty = n.ty * 0.82 + clamp(n.vx * 1.6, -4.5, 4.5) * 0.18
      // held a touch higher the faster it moves, which is where the deeper shadow comes from
      n.speed = n.speed * 0.85 + clamp(Math.hypot(n.vx, n.vy) / 2.2, 0, 1) * 0.15
      n.vx *= 0.6
      n.vy *= 0.6
      const el = lanesRef.current
      el?.style.setProperty('--swing', `${n.swing.toFixed(2)}deg`)
      el?.style.setProperty('--tilt-x', `${n.tx.toFixed(2)}deg`)
      el?.style.setProperty('--tilt-y', `${n.ty.toFixed(2)}deg`)
      el?.style.setProperty('--speed', n.speed.toFixed(3))
      const still = Math.abs(n.swing) < 0.05 && Math.abs(n.sv) < 0.05 && n.speed < 0.02
        && Math.abs(n.tx) < 0.05 && Math.abs(n.ty) < 0.05
      if (!n.held && still) {
        n.frame = 0
        for (const k of ['--swing', '--tilt-x', '--tilt-y']) el?.style.setProperty(k, '0deg')
        el?.style.setProperty('--speed', '0')
        return
      }
      n.frame = requestAnimationFrame(step)
    }
    s.frame = requestAnimationFrame(step)
  }
  const leanStart = (e) => {
    lean.current = { ...lean.current, swing: 0, sv: 0, tx: 0, ty: 0, speed: 0, vx: 0, vy: 0, x: e.clientX, y: e.clientY, t: performance.now(), held: true }
    leanOn()
  }
  const leanTo = (e) => {
    const s = lean.current
    const now = performance.now()
    const dt = Math.max(8, now - s.t)
    s.vx = (e.clientX - s.x) / dt
    s.vy = (e.clientY - s.y) / dt
    s.x = e.clientX
    s.y = e.clientY
    s.t = now
  }
  const leanStop = () => { lean.current.held = false }
  useEffect(() => () => cancelAnimationFrame(lean.current.frame), [])
  const [ghost, setGhost] = useState(null) // where a part dragged from the sidebar would land
  const dock = useRollDock() // a pattern's rack and notes live along the bottom
  const [tool, setTool] = useState('pointer') // or 'slice'
  const [panel, setPanel] = useState(null) // a rhythm / melody / code part's settings: { nodeId, x, y }
  const [deleting, setDeleting] = useState(null) // an original pattern waiting on 'are you sure'
  const lastPress = useRef(null) // for double-clicks (pointer capture keeps dblclick off the clips)
  const [sliceLine, setSliceLine] = useState(null) // { bar, l0, l1 } where the slice tool would cut
  const scrollRef = useRef(null)
  const lanesRef = useRef(null)
  const playheadRef = useRef(null)
  const headRef = useRef(null) // the playhead's handle on the ruler
  const scrubbing = useRef(false)
  const dragRef = useRef(null)
  const panRef = useRef(null)
  const [viewH, setViewH] = useState(0) // rows fill the visible height
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const ro = new ResizeObserver(() => setViewH(box.clientHeight))
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  useEffect(() => { try { localStorage.setItem('lattice:song:zoom', String(ppb)); localStorage.setItem('lattice:song:rows', String(laneH)) } catch { /* storage unavailable */ } }, [ppb, laneH])

  const updateSong = useCallback((fn) => onUpdateProject((p) => {
    p.song = p.song ?? { on: true, snap: 'bar', clips: [] }
    fn(p.song, p)
  }), [onUpdateProject])

  // clips as shown: the project's, with a drag's changes laid over them
  const clips = useMemo(() => {
    if (!drag) return song.clips
    // kept in the list a moment longer, marked, so they can shrink away rather than vanish
    if (drag.erased) return song.clips.map((c) => (drag.erased.has(c.id) ? { ...c, gone: true } : c))
    const moved = song.clips.map((c) => (drag.changes[c.id] ? { ...c, ...drag.changes[c.id] } : c))
    return drag.copy ? [...song.clips, ...drag.added] : [...moved, ...(drag.added ?? [])]
  }, [song.clips, drag])

  const bars = Math.max(16, Math.ceil(length) + 8, Math.ceil((scrollRef.current?.clientWidth ?? 0) / ppb) + 1)
  const lanes = Math.max(8, Math.ceil((viewH - RULER_H) / LANE_H) + 4, ...clips.map((c) => c.lane + 3)) // a few spare rows below the view, so zooming rows can keep its spot
  const step = song.snap === 'beat' ? 1 / beats : 1
  // zoomed out, only every few bars is numbered: no sense building spans nobody can read
  const tickEvery = ppb >= 22 ? 1 : Math.ceil(22 / ppb)

  // ── geometry ──
  const peerClips = useHolders('timeline')
  // the clips we have hold of, so they're ringed in our colour on everyone else's timeline
  useEffect(() => { selectionIs('timeline', [...selected]) }, [selected])
  const barAt = (clientX) => (clientX - lanesRef.current.getBoundingClientRect().left) / ppb
  const laneAt = (clientY) => clamp(Math.floor((clientY - lanesRef.current.getBoundingClientRect().top) / LANE_H), 0, 63)
  // hold alt and the grid lets go entirely, as it does in FL: put it exactly where you want
  const FREE = 1 / (beats * 16) // still rounded, but far finer than anyone can see
  const snap = (v, free) => { const s = free ? FREE : step; return Math.round(v / s) * s }
  const snapDown = (v, free) => { const s = free ? FREE : step; return Math.floor(v / s) * s }
  const leastLen = (free) => (free ? FREE : Math.min(step, 1 / beats))

  // ── playhead ──
  // While the song plays it runs along the song and wraps at its end. With the song off the
  // patch just loops, and the count would run away into bar 900, so the playhead waits at
  // the cue (or runs around the loop, when one is marked) instead of wandering off.
  const driven = song.on && song.clips.some((c) => !c.src.startsWith(AUTO_PREFIX))
  useEffect(() => {
    const show = () => {
      const el = playheadRef.current
      if (!el) return
      let pos = transport.position()
      let live = true
      if (driven && length > 0) pos = wrap(pos, Math.max(1, Math.ceil(length - 1e-9)))
      else if (transport.looping()) pos = transport.loop.from + wrap(pos - transport.loop.from, transport.loopLength())
      else if (started) { pos = transport.start; live = false }
      el.classList.toggle('waiting', !live)
      el.style.transform = `translateX(${pos * ppb}px)`
      if (headRef.current) headRef.current.style.transform = `translateX(${pos * ppb}px)`
      if (started && live) {
        const box = scrollRef.current
        const x = pos * ppb
        // the row headers sit over the left of the view, so the bars start past them
        if (box && !dragRef.current && !scrubbing.current && (x < box.scrollLeft || x + HEAD_W > box.scrollLeft + box.clientWidth - 40)) box.scrollLeft = Math.max(0, x - 80)
      }
    }
    show()
    if (!started) return transport.subscribe(show)
    let frame
    const tick = () => { show(); frame = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [started, transport, ppb, length, driven])

  // ── zoom: ctrl/cmd + wheel around the pointer; buttons; fit ──
  // A wheel can fire several times a frame, and each zoom moves every clip, tick and
  // sketch, so they're gathered into one change a frame.
  const zoomRaf = useRef(0)
  const zoomWant = useRef(null)
  useEffect(() => () => cancelAnimationFrame(zoomRaf.current), [])
  const zoomTo = useCallback((next, anchorClientX) => {
    const box = scrollRef.current
    if (!box) return setPpb(next)
    const rect = box.getBoundingClientRect()
    const anchor = anchorClientX ?? rect.left + box.clientWidth / 2
    const barUnder = (box.scrollLeft + anchor - rect.left - HEAD_W) / ppbRef.current
    const clamped = clamp(next, MIN_PPB, MAX_PPB)
    ppbRef.current = clamped // so another wheel tick this frame carries on from here
    zoomWant.current = { clamped, barUnder, at: anchor - rect.left }
    if (zoomRaf.current) return
    zoomRaf.current = requestAnimationFrame(() => {
      zoomRaf.current = 0
      const want = zoomWant.current
      setPpb(want.clamped)
      requestAnimationFrame(() => { box.scrollLeft = Math.max(0, want.barUnder * want.clamped - want.at + HEAD_W) })
    })
  }, [])
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const onWheel = (e) => {
      if (e.altKey && !(e.ctrlKey || e.metaKey)) {
        // alt + scroll: taller or shorter rows, keeping the row under the pointer there
        e.preventDefault()
        const rect = box.getBoundingClientRect()
        const y = e.clientY - rect.top
        const laneUnder = (box.scrollTop + y - RULER_H) / laneH
        const next = clamp(laneH * Math.exp(-(e.deltaY || e.deltaX) * 0.0022), MIN_LANE, MAX_LANE)
        setLaneH(next)
        requestAnimationFrame(() => { box.scrollTop = Math.max(0, laneUnder * next + RULER_H - y) })
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      zoomTo(ppbRef.current * Math.exp(-e.deltaY * 0.0022), e.clientX)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [laneH, zoomTo])
  const fit = () => {
    const box = scrollRef.current
    if (!box) return
    setPpb(clamp((box.clientWidth - 40) / Math.max(8, Math.ceil(length) + 1), MIN_PPB, MAX_PPB))
    box.scrollLeft = 0
  }

  // ── adding parts ──
  /** Make sure a pattern is heard: if no pattern node plays it, add one wired to the output. */
  const ensureInPatch = (p, src) => {
    if (!src.startsWith('pattern:')) return
    // a variation plays through its original's node: that's the one that has to be there
    const patternId = p.patterns.find((x) => x.id === src.slice(8))?.parent ?? src.slice(8)
    if (p.nodes.some((n) => n.type === 'pattern' && n.data.patternId === patternId)) return
    const out = p.nodes.find((n) => n.type === 'output')
    const id = `pattern${newId().slice(-5)}`
    const lowest = Math.max(0, ...p.nodes.filter((n) => n.type !== 'output').map((n) => n.y + 200))
    p.nodes.push({ id, type: 'pattern', x: 40, y: lowest, data: { patternId } })
    if (out) {
      const used = p.edges.filter((e) => e.target === out.id).map((e) => Number(e.targetHandle.slice(3)))
      p.edges.push({ source: id, target: out.id, targetHandle: `in-${Math.max(-1, ...used) + 1}` })
    }
  }

  const addClip = (src, start, lane, len) => {
    const id = `c${newId()}`
    updateSong((s, p) => {
      ensureInPatch(p, src)
      s.clips.push({ id, src, lane, start: clamp(start, 0, MAX_BARS - 1), len })
      if (s.clips.length === 1) s.on = true
    })
    setSelected(new Set([id]))
  }

  const newPattern = (e) => {
    const pattern = makePattern(`pattern ${project.patterns.length + 1}`)
    onUpdateProject((p) => {
      p.patterns.push(pattern)
      ensureInPatch(p, `pattern:${pattern.id}`)
    })
    setActivePart(`pattern:${pattern.id}`)
    dock?.open(pattern.id, null, 'rack')
  }

  /** Double-click a part (a clip, or in the sidebar): edit it right here, without the patch. */
  const openPart = (src, e) => {
    const x = e.clientX
    const y = e.clientY
    const node = project.nodes.find((n) => `node:${n.id}` === src)
    // after this press is over: a window opened during it would take the press for a click outside
    setTimeout(() => {
      if (src.startsWith(AUTO_PREFIX)) automation?.open(src.slice(AUTO_PREFIX.length), { x, y })
      else if (src.startsWith('pattern:')) dock?.open(src.slice(8), null, 'rack')
      else if (node) setPanel({ nodeId: node.id, x, y })
    }, 0)
  }

  // ── pointer: clips, empty rows, panning ──
  const onLanesDown = (e) => {
    if (e.button === 1 && (e.ctrlKey || e.metaKey)) {
      // ctrl + middle-drag (as in FL): sideways stretches the bars, up and down the rows,
      // around the spot where the drag started
      e.preventDefault()
      const box = scrollRef.current
      const rect = box.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      panRef.current = {
        zoom: true, x: e.clientX, y: e.clientY, ppb, laneH, ax: x, ay: y,
        bar: (box.scrollLeft + x - HEAD_W) / ppb, lane: (box.scrollTop + y - RULER_H) / laneH,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.currentTarget.classList.add('zooming')
      return
    }
    if (e.button === 1) {
      e.preventDefault()
      panRef.current = { x: e.clientX, y: e.clientY, left: scrollRef.current.scrollLeft, top: scrollRef.current.scrollTop }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (e.button === 2) {
      // right-click deletes a clip; keep holding and sweep to delete every clip you pass over
      e.currentTarget.setPointerCapture(e.pointerId)
      const hit = e.target.closest('.clip:not(.preview)')?.dataset.id
      setErasing(true) // the pointer says so while the button is down
      dragRef.current = { mode: 'erase', gone: new Set(hit ? [hit] : []) }
      setDrag({ changes: {}, erased: new Set(dragRef.current.gone) })
      return
    }
    if (e.button !== 0) return
    scrollRef.current?.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    const el = e.target.closest('.clip')
    const bar = barAt(e.clientX)
    const lane = laneAt(e.clientY)

    if (tool === 'slice') {
      // click a clip to cut it there; drag up or down to cut every clip the line crosses
      const at = snap(bar, e.altKey)
      dragRef.current = { mode: 'slice', bar: at, l0: lane }
      setSliceLine({ bar: at, l0: lane, l1: lane })
      return
    }

    if (el) {
      const id = el.dataset.id
      const clip = song.clips.find((c) => c.id === id)
      if (!clip) return
      const now = performance.now()
      const last = lastPress.current
      lastPress.current = { id, t: now }
      if (last?.id === id && now - last.t < 350 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        lastPress.current = null
        openPart(clip.src, e)
        return
      }
      // the dock is already open on some pattern: one press moves it to this one, since
      // opening it was the thing that took two presses
      if (dock?.at && clip.src.startsWith('pattern:') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const to = clip.src.slice(8)
        if (to !== dock.at.patternId) dock.open(to, null, 'rack')
      }
      let sel = selected
      const wasSelected = selected.has(id)
      if (e.ctrlKey || e.metaKey) {
        sel = new Set(selected)
        sel.has(id) ? sel.delete(id) : sel.add(id)
        setSelected(sel)
        if (!sel.has(id)) return
      } else if (e.shiftKey) {
        // shift: drag out a copy of this clip (of the whole selection when the clip is in it);
        // a shift-click without moving adds the clip to the selection or takes it out
        if (!wasSelected) sel = new Set([id])
      } else if (!sel.has(id)) {
        sel = new Set([id])
        setSelected(sel)
      }
      setActivePart(clip.src)
      const rect = el.getBoundingClientRect()
      const mode = e.clientX - rect.left < EDGE ? 'start' : rect.right - e.clientX < EDGE ? 'end' : 'move'
      // moving and stretching both act on the whole selection; the clip you grabbed leads
      const group = sel.has(id) ? song.clips.filter((c) => sel.has(c.id)) : [clip]
      dragRef.current = { mode, bar, lane, group, anchor: clip, copy: mode === 'move' && e.shiftKey, toggle: e.shiftKey ? id : null, moved: false }
      if (mode === 'move') leanStart(e)
      return
    }

    if (!e.shiftKey) setSelected(new Set())
    if (activePart && partBySrc.has(activePart) && !e.shiftKey) {
      // draw a clip of the active part
      const start = snapDown(bar, e.altKey)
      dragRef.current = { mode: 'draw', start, lane, src: activePart }
      setDrag({ changes: {}, added: [{ id: '__draw', src: activePart, lane, start, len: step }] })
      return
    }
    dragRef.current = { mode: 'marquee', bar, lane, base: e.shiftKey ? new Set(selected) : new Set() }
    setMarquee({ b0: bar, l0: lane, b1: bar, l1: lane })
  }

  const onLanesMove = (e) => {
    const pan = panRef.current
    if (pan?.zoom) {
      const box = scrollRef.current
      const nextPpb = clamp(pan.ppb * Math.exp((e.clientX - pan.x) * 0.006), MIN_PPB, MAX_PPB)
      const nextLane = clamp(pan.laneH * Math.exp((e.clientY - pan.y) * 0.006), MIN_LANE, MAX_LANE)
      setPpb(nextPpb)
      setLaneH(nextLane)
      requestAnimationFrame(() => {
        box.scrollLeft = Math.max(0, pan.bar * nextPpb - pan.ax + HEAD_W)
        box.scrollTop = Math.max(0, pan.lane * nextLane + RULER_H - pan.ay)
      })
      return
    }
    if (pan) {
      scrollRef.current.scrollLeft = pan.left - (e.clientX - pan.x)
      scrollRef.current.scrollTop = pan.top - (e.clientY - pan.y)
      return
    }
    const d = dragRef.current
    if (!d && tool === 'slice') {
      const lane = laneAt(e.clientY)
      const bar = snap(barAt(e.clientX), e.altKey)
      setSliceLine((l) => (l && l.bar === bar && l.l0 === lane && l.l1 === lane ? l : { bar, l0: lane, l1: lane }))
      return
    }
    if (!d) {
      const el = e.target.closest?.('.clip')
      if (el) {
        const r = el.getBoundingClientRect()
        el.style.cursor = e.clientX - r.left < EDGE || r.right - e.clientX < EDGE ? 'ew-resize' : 'var(--ring)'
      }
      return
    }
    const free = e.altKey // alt: off the grid
    const bar = barAt(e.clientX)
    const lane = laneAt(e.clientY)
    if (d.mode === 'slice') {
      setSliceLine({ bar: d.bar, l0: d.l0, l1: lane })
      return
    }
    if (d.mode === 'erase') {
      // pointer capture keeps events on the rows, so find the clip under the pointer by position
      const hit = song.clips.find((c) => c.lane === lane && bar >= c.start && bar < c.start + c.len)
      if (hit && !d.gone.has(hit.id)) { d.gone.add(hit.id); setDrag({ changes: {}, erased: new Set(d.gone) }) }
      return
    }
    if (d.mode === 'move') {
      const minStart = Math.min(...d.group.map((c) => c.start))
      const minLane = Math.min(...d.group.map((c) => c.lane))
      const db = Math.max(-minStart, snap(bar - d.bar, free))
      const dl = Math.max(-minLane, lane - d.lane)
      if (!db && !dl && !d.moved) return
      d.moved = true
      const place = (c) => ({ start: c.start + db, lane: c.lane + dl })
      leanTo(e)
      // `lift` is what the clips being carried are drawn by: off the canvas, above the rest
      if (d.copy) setDrag({ copy: true, lift: true, changes: {}, added: d.group.map((c) => ({ ...c, ...place(c), id: `__copy${c.id}` })) })
      else setDrag({ lift: true, changes: Object.fromEntries(d.group.map((c) => [c.id, place(c)])) })
    } else if (d.mode === 'start' || d.mode === 'end') {
      // every selected clip stretches by as much as the one under the pointer
      const c = d.anchor
      const min = leastLen(free)
      const changes = {}
      if (d.mode === 'end') {
        const run = partBySrc.get(c.src)?.bars
        const want = clamp(snap(bar, free) - c.start, min, MAX_BARS - c.start)
        // stretching it out repeats the part, so it stops on whole ones
        const delta = (run && !free ? Math.max(1, Math.round(want / run)) * run : want) - c.len
        for (const x of d.group) changes[x.id] = { len: clamp(x.len + delta, min, MAX_BARS - x.start) }
      } else {
        const delta = clamp(snap(bar, free), 0, c.start + c.len - min) - c.start
        for (const x of d.group) {
          const start = clamp(x.start + delta, 0, x.start + x.len - min)
          changes[x.id] = { start, len: x.start + x.len - start, offset: (x.offset ?? 0) + (start - x.start) }
        }
      }
      d.moved = true
      setDrag({ changes })
    } else if (d.mode === 'draw') {
      // drawing a part out lays it down whole: a four-bar pattern goes four, eight, twelve,
      // rather than being cut off halfway through itself
      const run = partBySrc.get(d.src)?.bars
      const end = run && !free
        ? d.start + Math.max(1, Math.round((snap(bar, false) - d.start) / run)) * run
        : Math.max(d.start + leastLen(free), snap(bar, free))
      setDrag({ changes: {}, added: [{ id: '__draw', src: d.src, lane: d.lane, start: d.start, len: end - d.start }] })
    } else if (d.mode === 'marquee') {
      const box = { b0: d.bar, l0: d.lane, b1: bar, l1: lane }
      setMarquee(box)
      const [b0, b1] = [Math.min(box.b0, box.b1), Math.max(box.b0, box.b1)]
      const [l0, l1] = [Math.min(box.l0, box.l1), Math.max(box.l0, box.l1)]
      const inside = song.clips.filter((c) => c.lane >= l0 && c.lane <= l1 && c.start < b1 && c.start + c.len > b0).map((c) => c.id)
      setSelected(new Set([...d.base, ...inside]))
    }
  }

  const onLanesUp = (e) => {
    setErasing(false)
    leanStop()
    if (panRef.current) { panRef.current = null; e?.currentTarget?.classList.remove('zooming'); return }
    const d = dragRef.current
    dragRef.current = null
    const preview = drag
    setDrag(null)
    setMarquee(null)
    if (!d) return
    if (d.mode === 'slice') {
      const line = sliceLine ?? { bar: d.bar, l0: d.l0, l1: d.l0 }
      const [l0, l1] = [Math.min(line.l0, line.l1), Math.max(line.l0, line.l1)]
      const cut = line.bar
      const hit = song.clips.filter((c) => c.lane >= l0 && c.lane <= l1 && cut > c.start + 1e-6 && cut < c.start + c.len - 1e-6)
      if (hit.length) {
        const halves = []
        updateSong((s) => {
          for (const c of s.clips) {
            if (!hit.some((h) => h.id === c.id)) continue
            const right = { ...c, id: `c${newId()}`, start: cut, len: c.start + c.len - cut, offset: (c.offset ?? 0) + (cut - c.start) }
            c.len = cut - c.start
            halves.push(right)
          }
          s.clips.push(...halves)
        })
        setSelected(new Set(halves.map((c) => c.id)))
      }
      setSliceLine(e ? { bar: cut, l0: laneAt(e.clientY), l1: laneAt(e.clientY) } : null)
      return
    }
    if (d.mode === 'erase') {
      // a right-click that swept nothing away is a click on bare canvas: let the selection go
      if (!d.gone.size) setSelected(new Set())
      if (d.gone.size) {
        // still marked while the song is being rewritten, or they blink back for a frame
        vanish([...d.gone])
        updateSong((s) => { s.clips = s.clips.filter((c) => !d.gone.has(c.id)) })
        setSelected((sel) => new Set([...sel].filter((id) => !d.gone.has(id))))
      }
      return
    }
    if (d.mode === 'draw') {
      const c = preview?.added?.[0]
      if (c) addClip(c.src, c.start, c.lane, c.len)
      return
    }
    if (!d.moved || !preview) {
      // a shift-click (no drag) adds the clip to the selection, or takes it out
      if (d.toggle) setSelected((sel) => { const next = new Set(sel); next.has(d.toggle) ? next.delete(d.toggle) : next.add(d.toggle); return next })
      return
    }
    if (preview.copy) {
      const added = preview.added.map((c) => ({ ...c, id: `c${newId()}` }))
      updateSong((s) => { s.clips.push(...added) })
      setSelected(new Set(added.map((c) => c.id)))
    } else {
      updateSong((s) => {
        for (const c of s.clips) if (preview.changes[c.id]) Object.assign(c, preview.changes[c.id])
      })
    }
    if (e) e.preventDefault()
  }

  // ── keys ──
  const onKeyDown = (e) => {
    if (e.target.closest('input, select, textarea')) return
    if (panel || deleting) return // an open window's keys (Esc closes it) come first
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const chosen = song.clips.filter((c) => selected.has(c.id))
    const done = () => { e.preventDefault(); e.stopPropagation() }
    if (mod && k === 'a') { done(); return setSelected(new Set(song.clips.map((c) => c.id))) }
    if (!mod && k === 'c') { done(); setTool((t) => (t === 'slice' ? 'pointer' : 'slice')); setSliceLine(null); return }
    if (!mod && k === 'u') {
      // make unique (as in FL): each selected pattern clip gets its own variation to change
      const picked = song.clips.filter((c) => selected.has(c.id) && c.src.startsWith('pattern:'))
      if (!picked.length) return
      done()
      let last = null
      onUpdateProject((p) => {
        const made = new Map() // one variation per pattern, shared by the clips picked from it
        for (const c of p.song?.clips ?? []) {
          if (!picked.some((x) => x.id === c.id)) continue
          const from = c.src.slice(8)
          if (!made.has(from)) made.set(from, makeVariation(p, from))
          if (made.get(from)) { c.src = `pattern:${made.get(from)}`; last = made.get(from) }
        }
      })
      if (last) { setActivePart(`pattern:${last}`); dock?.open(last, null, 'rack') }
      return
    }
    if (!mod && k === 'v') { done(); setTool('pointer'); setSliceLine(null); return }
    if (k === 'escape') {
      if (tool !== 'pointer') { done(); setTool('pointer'); setSliceLine(null); return }
      // letting go of the selection doesn't use up the key: the same Esc closes the dock
      setSelected(new Set()); setActivePart(null); return
    }
    if (!chosen.length) return
    if (k === 'delete' || k === 'backspace') {
      done()
      updateSong((s) => { s.clips = s.clips.filter((c) => !selected.has(c.id)) })
      setSelected(new Set())
      return
    }
    if (mod && k === 'd') {
      // duplicate right after the selection
      done()
      const from = Math.min(...chosen.map((c) => c.start))
      const span = Math.max(...chosen.map((c) => c.start + c.len)) - from
      const added = chosen.map((c) => ({ ...c, id: `c${newId()}`, start: c.start + span }))
      updateSong((s) => { s.clips.push(...added) })
      setSelected(new Set(added.map((c) => c.id)))
      return
    }
    const nudge = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k]
    if (nudge) {
      done()
      const db = nudge[0] * (e.shiftKey ? 1 / beats : step)
      if (chosen.some((c) => c.start + db < 0 || c.lane + nudge[1] < 0)) return
      updateSong((s) => { for (const c of s.clips) if (selected.has(c.id)) { c.start += db; c.lane += nudge[1] } })
    }
  }

  // ── ruler: click or drag to move the playhead (snapped, alt: free);
  //    shift-drag to set a loop ──
  const rulerRef = useRef(null)
  const scrubTo = (clientX, free) => {
    const raw = Math.max(0, barAt(clientX))
    const bar = free ? raw : Math.round(raw * beats) / beats
    const r = rulerRef.current
    if (r && r.last === bar) return
    if (r) r.last = bar
    // seeking re-sets the playing pattern: at most once a frame
    cancelAnimationFrame(r?.frame)
    const go = () => transport.seek(bar)
    if (r) r.frame = requestAnimationFrame(go)
    else go()
  }
  /** What the ruler has under the pointer: a loop edge, the loop band itself, or nothing. */
  const loopPartAt = (e) => {
    const lp = transport.loop
    if (!lp.on || lp.to <= lp.from) return null
    const x = e.clientX - lanesRef.current.getBoundingClientRect().left
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top
    if (Math.abs(x - lp.from * ppb) <= 6) return 'from'
    if (Math.abs(x - lp.to * ppb) <= 6) return 'to'
    if (y <= 9 && x > lp.from * ppb && x < lp.to * ppb) return 'band'
    return null
  }

  const onRulerDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const part = !e.shiftKey && loopPartAt(e)
    if (part) {
      // drag a loop edge to resize the loop, or the band to move it
      const lp = transport.loop
      rulerRef.current = { mode: `loop-${part}`, grab: barAt(e.clientX), from: lp.from, to: lp.to }
      e.currentTarget.classList.add('scrubbing')
      return
    }
    if (e.shiftKey) {
      const bar = snapDown(barAt(e.clientX), e.altKey)
      rulerRef.current = { mode: 'loop', from: bar, to: bar }
      return
    }
    rulerRef.current = { mode: 'scrub', last: null, frame: 0 }
    scrubbing.current = true
    e.currentTarget.classList.add('scrubbing')
    scrubTo(e.clientX, e.altKey)
  }
  const onRulerMove = (e) => {
    const r = rulerRef.current
    if (!r) {
      const part = loopPartAt(e)
      e.currentTarget.style.cursor = part === 'band' ? 'var(--ring)' : part ? 'col-resize' : ''
      return
    }
    if (r.mode.startsWith('loop-')) {
      const min = 1 / beats
      const at = snap(barAt(e.clientX), e.altKey)
      if (r.mode === 'loop-from') transport.setLoop({ from: clamp(at, 0, r.to - min) })
      else if (r.mode === 'loop-to') transport.setLoop({ to: Math.max(at, r.from + min) })
      else {
        const shift = Math.max(-r.from, snap(barAt(e.clientX) - r.grab, e.altKey))
        transport.setLoop({ from: r.from + shift, to: r.to + shift })
      }
      return
    }
    if (r.mode === 'scrub') {
      scrubTo(e.clientX, e.altKey)
      // keep the handle in view while dragging past an edge
      const box = scrollRef.current
      const rect = box.getBoundingClientRect()
      if (e.clientX > rect.right - 24) box.scrollLeft += 12
      else if (e.clientX < rect.left + 24) box.scrollLeft -= 12
      return
    }
    const bar = snap(barAt(e.clientX), e.altKey)
    r.to = bar
    if (Math.abs(r.to - r.from) >= 1 / beats) transport.setLoop({ on: true, from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) })
  }
  const onRulerUp = (e) => {
    const r = rulerRef.current
    rulerRef.current = null
    scrubbing.current = false
    e.currentTarget.classList.remove('scrubbing')
    if (r?.mode === 'loop' && Math.abs(r.to - r.from) < 1 / beats) transport.setLoop({ on: false })
  }

  // ── dropping parts from the sidebar ──
  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes(PART_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const src = ghost?.src ?? activePart
    const part = partBySrc.get(src)
    setGhost({ src, start: Math.max(0, snapDown(barAt(e.clientX))), lane: laneAt(e.clientY), len: part?.bars ?? 4 })
  }
  const onDrop = (e) => {
    const src = e.dataTransfer.getData(PART_MIME)
    setGhost(null)
    if (!partBySrc.has(src)) return
    e.preventDefault()
    const part = partBySrc.get(src)
    addClip(src, Math.max(0, snapDown(barAt(e.clientX))), laneAt(e.clientY), part.bars ?? 4)
    setActivePart(src)
  }

  /** Duplicate a pattern as a variation of its original, and open it to change. */
  const duplicatePart = (part, e) => {
    let made = null
    onUpdateProject((p) => { made = makeVariation(p, part.id) })
    if (!made) return
    setActivePart(`pattern:${made}`)
    dock?.open(made, null, 'rack')
  }

  /**
   * Delete a pattern part: a variation goes at once (undo brings it back); an original takes
   * its variations, its clips and its pattern nodes with it, so it asks first.
   */
  const deletePart = (part) => {
    const doomed = new Set([part.id, ...(part.parent ? [] : project.patterns.filter((v) => v.parent === part.id).map((v) => v.id))])
    onUpdateProject((p) => {
      p.patterns = p.patterns.filter((x) => !doomed.has(x.id))
      if (!part.parent) {
        const gone = new Set(p.nodes.filter((n) => n.type === 'pattern' && doomed.has(n.data.patternId)).map((n) => n.id))
        p.nodes = p.nodes.filter((n) => !gone.has(n.id))
        p.edges = p.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target))
      }
      if (p.song) {
        p.song.clips = p.song.clips.filter((c) => !(c.src.startsWith('pattern:') && doomed.has(c.src.slice(8))))
        if (p.song.colors) for (const id of doomed) delete p.song.colors[`pattern:${id}`]
      }
    })
    if (activePart && doomed.has(activePart.slice(8))) setActivePart(null)
    setSelected((sel) => new Set([...sel].filter((id) => song.clips.some((c) => c.id === id && !doomed.has(c.src.slice(8))))))
  }

  const partRow = (part) => {
    const count = song.clips.filter((c) => c.src === part.src).length
    return (
      <li key={part.src} className={part.parent ? 'variant' : ''}>
        <button
          className={`song-part ${activePart === part.src ? 'active' : ''} ${part.inPatch ? '' : 'unused'}`}
          style={{ '--clip': colorFor(part.src, song.colors) }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(PART_MIME, part.src)
            e.dataTransfer.effectAllowed = 'copy'
            setActivePart(part.src)
            setGhost({ src: part.src, start: 0, lane: -1, len: part.bars })
          }}
          onDragEnd={() => setGhost(null)}
          onClick={() => setActivePart((a) => (a === part.src ? null : part.src))}
          onDoubleClick={(e) => openPart(part.src, { clientX: e.clientX + 60, clientY: e.clientY })}
          data-tip={`Drag onto the timeline, or select it and draw on an empty row. Double-click to ${part.kind === 'pattern' ? 'edit its instruments, steps and notes' : part.kind === 'auto' ? 'draw its curve' : 'change its settings'}.`}
        >
          <span className="song-swatch" aria-hidden />
          <span className="song-part-name">{part.name}</span>
          <span className="song-part-meta">
            {part.trigger ? 'trigger · always on' : part.kind === 'pattern' ? `${part.bars} bar${part.bars === 1 ? '' : 's'}${part.parent ? ` · plays through ${part.parentName}` : ''}${part.inPatch ? '' : ' · drop to add to the patch'}` : part.kind === 'auto' ? (resolveTarget(project, part.target) ? `curve · ${part.bars} bar${part.bars === 1 ? '' : 's'}` : 'its knob was deleted') : part.kind === 'sound' ? 'rhythm' : part.kind === 'notes' ? 'melody' : part.kind}
            {count > 0 ? ` · ${count} clip${count === 1 ? '' : 's'}` : part.kind === 'auto' ? ' · not on the timeline' : part.inPatch && song.on && soundClips && !part.trigger ? ' · silent in the song' : ''}
          </span>
        </button>
        <Popover
          label={<><span className="song-color-dot" style={{ background: colorFor(part.src, song.colors) }} />colour</>}
          title={`Colour of ${part.name} and its clips`}
          className={`song-color-btn ${part.kind === 'pattern' ? '' : part.kind === 'auto' ? 'one' : 'solo'}`}
          panelClassName="song-colors"
          align="left"
        >
          {(close) => (
            <>
              <div className="song-color-grid" role="group" aria-label="Colours">
                {PICKS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`song-color-pick ${colorFor(part.src, song.colors) === c ? 'on' : ''}`}
                    style={{ background: c }}
                    aria-label={c}
                    onClick={() => { updateSong((s) => { s.colors = { ...(s.colors ?? {}), [part.src]: c } }); close() }}
                  />
                ))}
              </div>
              <label className="song-color-custom">
                <span>any colour</span>
                <input type="color" value={colorFor(part.src, song.colors)} onChange={(e) => updateSong((s) => { s.colors = { ...(s.colors ?? {}), [part.src]: e.target.value } })} />
              </label>
              {song.colors?.[part.src] && (
                <button type="button" className="linkish song-color-reset" onClick={() => { updateSong((s) => { const next = { ...(s.colors ?? {}) }; delete next[part.src]; s.colors = next }); close() }}>back to its own colour</button>
              )}
            </>
          )}
        </Popover>
        {part.kind === 'pattern' && (
          <button
            type="button"
            className="song-part-dup"
            onClick={(e) => duplicatePart(part, e)}
            data-tip={`Make a variation: change it freely and it still plays through ${part.parentName ?? part.name}'s spot in the patch`}
            aria-label={`Duplicate ${part.name} as a variation`}
          >dup</button>
        )}
        {part.kind === 'auto' && (
          <button
            type="button"
            className="song-part-del"
            onClick={() => automation?.remove(part.id)}
            title="Delete this automation and its clips (ctrl/cmd + Z brings it back)"
            aria-label={`Delete ${part.name}`}
          >×</button>
        )}
        {part.kind === 'pattern' && (
          <button
            type="button"
            className="song-part-del"
            onClick={() => (part.parent ? deletePart(part) : setDeleting(part))}
            title={part.parent ? `Delete this variation and its clips (ctrl/cmd + Z brings it back)` : `Delete ${part.name}, its variations, clips and pattern node`}
            aria-label={`Delete ${part.name}`}
          >×</button>
        )}
      </li>
    )
  }

  // ── rows: each has a header, and its own menu ──
  const [rowMenu, setRowMenu] = useState(null) // { lane, x, y }
  const [renaming, setRenaming] = useState(null) // the row being named
  const laneAtRow = (i) => laneInfo(song, i)
  const rowsOf = (s) => (s.lanes = s.lanes ?? [])
  const insertRow = (at) => updateSong((s) => {
    for (const c of s.clips) if (c.lane >= at) c.lane = Math.min(63, c.lane + 1)
    rowsOf(s).splice(at, 0, {})
  })
  const deleteRow = (at) => updateSong((s) => {
    s.clips = s.clips.filter((c) => c.lane !== at)
    for (const c of s.clips) if (c.lane > at) c.lane -= 1
    rowsOf(s).splice(at, 1)
  })
  const clearRow = (at) => updateSong((s) => { s.clips = s.clips.filter((c) => c.lane !== at) })
  const duplicateRow = (at) => updateSong((s) => {
    const copies = s.clips.filter((c) => c.lane === at).map((c) => ({ ...c, id: `c${newId()}`, lane: at + 1 }))
    for (const c of s.clips) if (c.lane > at) c.lane = Math.min(63, c.lane + 1)
    rowsOf(s).splice(at + 1, 0, { ...(s.lanes[at] ?? {}) })
    s.clips.push(...copies)
  })
  const swapRows = (a, b) => updateSong((s) => {
    if (b < 0 || b > 63) return
    for (const c of s.clips) c.lane = c.lane === a ? b : c.lane === b ? a : c.lane
    const rows = rowsOf(s)
    while (rows.length <= Math.max(a, b)) rows.push({})
    ;[rows[a], rows[b]] = [rows[b], rows[a]]
  })
  const setRow = (at, patch) => updateSong((s) => {
    const rows = rowsOf(s)
    while (rows.length <= at) rows.push({})
    Object.assign(rows[at], patch)
  })

  const loop = transport.loop
  const songBars = Math.max(1, Math.ceil(length - 1e-9))
  const panelNode = panel && project.nodes.find((n) => n.id === panel.nodeId)

  return (
    <section className="song" aria-label="Song timeline" data-surface="song">
      <aside className="song-parts" aria-label="Parts">
        <div className="song-parts-head">
          <span className="song-title">parts</span>
          <button className="btn" onClick={newPattern} title="A new pattern, added to the patch and opened for editing">+ pattern</button>
        </div>
        <ul className="song-part-list">
          {inPatch.map(partRow)}
        </ul>
        <div className="song-parts-sub">
          <span data-tip="Right-click any knob in the patch or on an instrument and pick automate: its curve lands here and on the timeline">automation</span>
          {autoParts.length > 0 && <span className="song-unused-count">{autoParts.length}</span>}
        </div>
        {autoParts.length ? (
          <ul className="song-part-list">
            {autoParts.map(partRow)}
          </ul>
        ) : (
          <p className="song-parts-hint auto-empty">none yet</p>
        )}
        {unused.length > 0 && (
          <details className="song-unused">
            <summary data-tip="Patterns no node plays, left over after deleting or pasting nodes. Drop one on the timeline and it gets a pattern node in the patch.">
              not in the patch <span className="song-unused-count">{unused.length}</span>
            </summary>
            <ul className="song-part-list">
              {unused.map(partRow)}
            </ul>
          </details>
        )}
      </aside>

      <div className="song-main">
        <div className="song-bar">
          <button
            className={`btn song-power ${song.on ? 'on' : ''}`}
            aria-pressed={song.on}
            onClick={() => updateSong((s) => { s.on = !s.on })}
            disabled={!song.clips.length}
            title={song.on ? 'Playing the song: only what is on the timeline plays' : 'Song off: the patch plays everything, looping'}
          >{song.on ? 'song on' : 'song off'}</button>
          <label className="song-field">
            <span>snap</span>
            <select className="select" value={song.snap} onChange={(e) => updateSong((s) => { s.snap = e.target.value })} aria-label="Snap clips to">
              <option value="bar">bar</option>
              <option value="beat">beat</option>
            </select>
          </label>
          <span className="song-length" title="The song loops after its last clip">{length ? `${songBars} bar${songBars === 1 ? '' : 's'}` : 'empty'}</span>
          <span className={`song-tools ${tool === 'slice' ? 'at-second' : ''}`} role="group" aria-label="Tool">
            <Glass className="song-tools-thumb" aria-hidden />
            <button className={`song-tool ${tool === 'pointer' ? 'on' : ''}`} aria-pressed={tool === 'pointer'} onClick={() => { setTool('pointer'); setSliceLine(null) }} title="Move, stretch and draw clips (V)">move</button>
            <button className={`song-tool ${tool === 'slice' ? 'on' : ''}`} aria-pressed={tool === 'slice'} onClick={() => setTool('slice')} title="Cut clips in two: click a clip, or drag up or down to cut every clip on those rows (C)">slice</button>
          </span>
          <span className="spacer" />
          <span className="song-hint">{!song.on && song.clips.length ? 'song off · the patch is looping, so the playhead waits at the cue · turn the song on to play the timeline' : tool === 'slice' ? 'click a clip to cut it · drag up or down to cut several · hold alt to cut off the grid · V or Esc to go back' : 'hold alt to leave the grid · shift-drag copies · U makes selected clips unique · C slices · right-click deletes · drag the ruler to move the playhead'}</span>
          <span className="song-zoom" role="group" aria-label="Zoom">
            <button className="btn" onClick={() => zoomTo(ppb / 1.5)} aria-label="Zoom out">−</button>
            <button className="btn" onClick={fit} title="Fit the song">fit</button>
            <button className="btn" onClick={() => zoomTo(ppb * 1.5)} aria-label="Zoom in">+</button>
          </span>
        </div>

        <div
          className="song-scroll"
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onAuxClick={(e) => { if (e.button === 1) e.preventDefault() }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
        >
          <div className="song-canvas" style={{ width: bars * ppb + HEAD_W, '--ppb': `${ppb}px`, '--ppbeat': `${ppb / beats}px`, '--lane': `${LANE_H}px`, '--headw': `${HEAD_W}px` }}>
            <div className="song-corner" style={{ height: RULER_H }} aria-hidden />
            <div
              className="song-ruler"
              style={{ height: RULER_H, width: bars * ppb }}
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              onPointerCancel={onRulerUp}
              title="Click or drag to move the playhead (alt: off the beat grid) · shift-drag to loop a section, shift-click to clear it · drag the loop's edges to resize it, its band to move it"
            >
              {Array.from({ length: Math.ceil(bars / tickEvery) }, (_, k) => {
                const i = k * tickEvery
                return <span key={i} className={`song-tick ${i % 4 === 0 ? 'major' : ''}`} style={{ left: i * ppb }}>{i + 1}</span>
              })}
              {loop.to > loop.from && (
                <span className={`song-loop ${loop.on ? '' : 'off'}`} style={{ left: loop.from * ppb, width: (loop.to - loop.from) * ppb }} aria-label={`Loop bars ${loop.from + 1} to ${loop.to}${loop.on ? '' : ' (off)'}`}>
                  <span className="song-loop-edge from" aria-hidden />
                  <span className="song-loop-edge to" aria-hidden />
                </span>
              )}
              {length > 0 && <span className="song-end" style={{ left: songBars * ppb }} title="The song loops here" />}
              {transport.mark > 0 && Math.abs(transport.mark - transport.position()) > 1e-6 && (
                <span className="song-cue" style={{ left: transport.mark * ppb }} title="Stop comes back here" aria-hidden />
              )}
              <span ref={headRef} className="song-head" aria-hidden />
            </div>

            <div className="song-heads" style={{ height: lanes * LANE_H }}>
              {Array.from({ length: lanes }, (_, i) => {
                const row = laneAtRow(i)
                const count = clips.filter((c) => c.lane === i).length
                return (
                  <div
                    key={i}
                    className={`song-row ${row.mute ? 'muted' : ''} ${count ? '' : 'empty'}`}
                    style={{ height: LANE_H }}
                    onContextMenu={(e) => { e.preventDefault(); setRowMenu({ lane: i, x: e.clientX, y: e.clientY }) }}
                    onDoubleClick={() => setRenaming(i)}
                    title="Right-click for row actions · double-click to rename"
                  >
                    <button
                      type="button"
                      className={`song-row-mute ${row.mute ? 'on' : ''}`}
                      aria-pressed={row.mute}
                      onClick={() => setRow(i, { mute: !row.mute })}
                      title={row.mute ? 'This row is silent: click to hear it' : 'Silence this row'}
                    >{row.mute ? 'off' : 'on'}</button>
                    {renaming === i ? (
                      <input
                        className="song-row-input"
                        autoFocus
                        defaultValue={row.named ? row.name : ''}
                        placeholder={`row ${i + 1}`}
                        maxLength={24}
                        onBlur={(e) => { setRow(i, { name: e.target.value.trim() }); setRenaming(null) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') { setRenaming(null); e.stopPropagation() }
                        }}
                      />
                    ) : (
                      <span className="song-row-name">{row.name}</span>
                    )}
                    {count > 0 && <span className="song-row-count">{count}</span>}
                  </div>
                )
              })}
            </div>
            <div
              data-surface-own="timeline"
              className={`song-lanes ${drag ? 'dragging' : ''} ${tool === 'slice' ? 'slicing' : ''} ${erasing ? 'erasing' : ''}`}
              ref={lanesRef}
              style={{ height: lanes * LANE_H, width: bars * ppb }}
              onPointerDown={onLanesDown}
              onPointerMove={(e) => {
                const r = lanesRef.current.getBoundingClientRect()
                pointerAt('timeline', (e.clientX - r.left) / ppb, (e.clientY - r.top) / LANE_H)
                onLanesMove(e)
              }}
              onPointerUp={onLanesUp}
              onPointerCancel={() => { dragRef.current = null; panRef.current = null; setDrag(null); setMarquee(null); setErasing(false); leanStop() }}
              onPointerLeave={() => { pointerGone(); if (!dragRef.current) setSliceLine(null) }}
              onContextMenu={(e) => e.preventDefault()}
              onDragOver={onDragOver}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setGhost((g) => (g ? { ...g, lane: -1 } : g)) }}
              onDrop={onDrop}
            >
              {length > 0 && song.on && <div className="song-after" style={{ left: songBars * ppb }} />}
              <PeerCursors where="timeline" to={(at) => ({ left: at.x * ppb, top: at.y * LANE_H })} />
              {clips.map((c) => {
                const part = partBySrc.get(c.src)
                if (!part) return null
                // where the pattern starts over inside the clip (it may begin part-way in, after a cut)
                const loops = (part.kind === 'pattern' || part.kind === 'auto') && part.bars > 0
                const into = loops ? (((c.offset ?? 0) % part.bars) + part.bars) % part.bars : 0
                const firstRepeat = part.bars - into
                const repeats = loops ? Math.max(0, Math.ceil((c.len - firstRepeat - 1e-9) / part.bars)) : 0
                // nothing on the patch plays this any more: it sits here and makes no sound
                const loose = part.kind === 'pattern' ? !part.inPatch : part.kind === 'auto' && !resolveTarget(project, part.target)
                return (
                  <div
                    key={c.id}
                    data-id={c.id}
                    className={`clip ${LANE_H >= 30 && part.kind !== 'auto' ? 'roomy' : ''} ${part.kind === 'auto' ? 'automation' : ''} ${selected.has(c.id) ? 'selected' : ''} ${c.id.startsWith('__') ? 'preview' : ''} ${c.gone || vanishing?.has(c.id) ? 'gone' : ''} ${drag?.lift && (drag.changes?.[c.id] || c.id.startsWith('__copy')) ? 'lifted' : ''} ${arriving?.has(c.id) ? 'arriving' : ''} ${!song.on ? 'off' : ''} ${loose ? 'loose' : ''} ${peerClips.has(c.id) ? 'peer-held' : ''}`}
                    style={{ left: c.start * ppb, top: c.lane * LANE_H + 3, width: Math.max(4, c.len * ppb - 1), height: LANE_H - 6, '--clip': colorFor(c.src, song.colors), '--clip-ink': inkFor(colorFor(c.src, song.colors)), ...(peerClips.get(c.id) ? { '--peer': peerClips.get(c.id).color } : {}) }}
                    title={`${part.name} · bar ${Math.floor(c.start) + 1}${c.start % 1 ? `.${Math.round((c.start % 1) * beats) + 1}` : ''} · ${Math.round(c.len * beats) / beats} bar${c.len === 1 ? '' : 's'}${loose ? (part.kind === 'auto' ? ' · its knob is gone, so this plays nothing' : ' · not in the patch, so this plays nothing · drag the part onto the patch to hook it up') : ''}`}
                  >
                    <ClipSketch url={sketchFor(c.src)} bars={part.bars} ppb={ppb} into={into} laneH={LANE_H} full={part.kind === 'auto'} />
                    <span className="clip-name">{part.name}</span>
                    {loose && <span className="clip-loose" aria-label="not in the patch">?</span>}
                    {Array.from({ length: repeats }, (_, i) => (
                      <span key={i} className="clip-repeat" style={{ left: (firstRepeat + i * part.bars) * ppb }} aria-hidden />
                    ))}
                  </div>
                )
              })}
              {/* where it lands, drawn the instant it changes: the clip itself springs
                  after the pointer, which is nice to watch and no help at all in telling
                  you what you're about to drop it on */}
              {drag?.lift && clips.filter((c) => drag.changes?.[c.id] || c.id.startsWith('__copy')).map((c) => (
                <div
                  key={`landing-${c.id}`}
                  className="clip-landing"
                  aria-hidden
                  style={{
                    left: c.start * ppb,
                    top: c.lane * LANE_H + 3,
                    width: Math.max(4, c.len * ppb - 1),
                    height: LANE_H - 6,
                  }}
                />
              ))}
              {ghost && ghost.lane >= 0 && (
                <div className={`clip preview ghost ${LANE_H >= 30 ? 'roomy' : ''}`} style={{ left: ghost.start * ppb, top: ghost.lane * LANE_H + 3, width: ghost.len * ppb - 1, height: LANE_H - 6, '--clip': colorFor(ghost.src ?? '', song.colors), '--clip-ink': inkFor(colorFor(ghost.src ?? '', song.colors)) }}>
                  <ClipSketch url={sketchFor(ghost.src)} bars={partBySrc.get(ghost.src)?.bars} ppb={ppb} into={0} laneH={LANE_H} />
                  <span className="clip-name">{partBySrc.get(ghost.src)?.name}</span>
                </div>
              )}
              {tool === 'slice' && sliceLine && (
                <div
                  className="song-slice"
                  style={{ left: sliceLine.bar * ppb, top: Math.min(sliceLine.l0, sliceLine.l1) * LANE_H, height: (Math.abs(sliceLine.l1 - sliceLine.l0) + 1) * LANE_H }}
                  aria-hidden
                />
              )}
              {marquee && (
                <div
                  className="song-marquee"
                  style={{
                    left: Math.min(marquee.b0, marquee.b1) * ppb,
                    width: Math.abs(marquee.b1 - marquee.b0) * ppb,
                    top: Math.min(marquee.l0, marquee.l1) * LANE_H,
                    height: (Math.abs(marquee.l1 - marquee.l0) + 1) * LANE_H,
                  }}
                />
              )}
              {!song.clips.length && !drag && (
                <div className="song-empty">
                  <strong>arrange the song</strong>
                  <p>Drag parts from the left onto these rows. Once there are clips, only what's on the timeline plays, each part starting from its top at the start of its clip.</p>
                </div>
              )}
            </div>
            <div ref={playheadRef} className="song-playhead" aria-hidden />
          </div>
        </div>
      </div>

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="delete pattern"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => { deletePart(deleting); setDeleting(null) }}
        >
          {(() => {
            const variations = project.patterns.filter((v) => v.parent === deleting.id)
            const ids = new Set([deleting.id, ...variations.map((v) => v.id)])
            const clips = song.clips.filter((c) => c.src.startsWith('pattern:') && ids.has(c.src.slice(8))).length
            const nodes = project.nodes.filter((n) => n.type === 'pattern' && n.data.patternId === deleting.id).length
            return (
              <>
                <p>This removes the pattern{variations.length ? <> and its <strong>{variations.length} variation{variations.length === 1 ? '' : 's'}</strong></> : null}, <strong>{clips} clip{clips === 1 ? '' : 's'}</strong> on the timeline{nodes ? <> and <strong>{nodes} pattern node{nodes === 1 ? '' : 's'}</strong> in the patch</> : null}.</p>
                <p>ctrl/cmd + Z brings it all back.</p>
              </>
            )
          })()}
        </ConfirmDialog>
      )}
      {panelNode && <PartPanel node={panelNode} anchor={panel} onUpdateProject={onUpdateProject} onClose={() => setPanel(null)} />}
      {rowMenu && (
        <KnobMenu
          x={rowMenu.x}
          y={rowMenu.y}
          title={laneAtRow(rowMenu.lane).name}
          onClose={() => setRowMenu(null)}
          items={[
            ['Insert row above', () => insertRow(rowMenu.lane)],
            ['Insert row below', () => insertRow(rowMenu.lane + 1)],
            ['Duplicate row', () => duplicateRow(rowMenu.lane)],
            null,
            ['Move row up', () => swapRows(rowMenu.lane, rowMenu.lane - 1)],
            ['Move row down', () => swapRows(rowMenu.lane, rowMenu.lane + 1)],
            [laneAtRow(rowMenu.lane).mute ? 'Hear this row' : 'Silence this row', () => setRow(rowMenu.lane, { mute: !laneAtRow(rowMenu.lane).mute })],
            ['Rename row', () => setRenaming(rowMenu.lane)],
            null,
            ['Clear the clips on it', () => clearRow(rowMenu.lane), { danger: true }],
            ['Delete row', () => deleteRow(rowMenu.lane), { danger: true }],
          ]}
        />
      )}
    </section>
  )
}

/** A text setting that applies on Enter (ctrl/cmd + Enter for code) or when you leave it. */
function PanelInput({ value, multiline, onCommit, ...props }) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const commit = () => { if (text !== value) onCommit(text) }
  const Tag = multiline ? 'textarea' : 'input'
  return (
    <Tag
      {...props}
      className="node-input"
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); commit() }
        if (e.key === 'Escape') { setText(value ?? ''); e.currentTarget.blur() }
      }}
    />
  )
}

/**
 * The settings of a rhythm, melody or code part, over the song: what it plays and on what.
 * What it goes through (effects) stays in the patch.
 */
function PartPanel({ node, anchor, onUpdateProject, onClose }) {
  const ref = useRef(null)
  const spec = NODE_TYPES[node.type]
  const set = (key, v) => onUpdateProject((p) => { const n = p.nodes.find((x) => x.id === node.id); if (n) n.data[key] = v })
  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('input, textarea, select')) { e.preventDefault(); onClose() } } // the Esc is ours, not the dock's
    window.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const left = clamp(anchor.x - 40, 12, window.innerWidth - 372)
  const top = clamp(anchor.y + 14, 12, window.innerHeight - 320)
  return (
    <div className="part-panel" ref={ref} role="dialog" aria-label={`${spec?.label ?? node.type} settings`} style={{ left, top }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="part-panel-head">
        <span className="part-panel-title">{spec?.label ?? node.type}</span>
        <span className="part-panel-sub">{spec?.blurb}</span>
        <button className="btn ghost" onClick={onClose} aria-label="Close">close</button>
      </div>
      <div className="part-panel-body">
        {(spec?.params ?? []).map((param) => {
          const value = node.data[param.key] ?? param.def
          if (param.type === 'kit') return <KitSelect key={param.key} node={node} param={param} value={value} onChange={(v) => set(param.key, v)} />
          return (
            <label key={param.key} className="node-field wide">
              <span>{param.label}{param.type === 'mini' ? ' · mini-notation' : ''}</span>
              <PanelInput value={String(value)} multiline={param.type === 'code'} rows={param.type === 'code' ? 5 : undefined} onCommit={(v) => set(param.key, v)} aria-label={param.label} />
            </label>
          )
        })}
        <p className="part-panel-hint">Enter applies{spec?.params?.some((p) => p.type === 'code') ? ' (ctrl/cmd + Enter in code)' : ''}. Effects on this part are in the patch.</p>
      </div>
    </div>
  )
}

/** The pattern drawn inside a clip, starting where the clip starts in the pattern. */
function ClipSketch({ url, bars, ppb, into, laneH, full = false }) {
  if (!url || !bars) return null
  const roomy = laneH >= 30 && !full // tall rows keep a strip for the name; short ones (and curves) draw under it
  return (
    <span
      className={`clip-sketch ${roomy ? 'roomy' : ''} ${full ? 'full' : ''}`}
      aria-hidden
      style={{ backgroundImage: url, backgroundSize: `${bars * ppb}px 100%`, backgroundPositionX: `${-into * ppb}px` }}
    />
  )
}
