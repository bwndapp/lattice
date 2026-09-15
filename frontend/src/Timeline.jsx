import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makePattern, newId } from './project'
import { MAX_BARS, songLength, songParts } from './song'
import PatternEditor from './PatternEditor.jsx'
import Phyllo from './phyllo/Phyllo.jsx'
import { normalizePatch } from './phyllo/engine'
import { KitSelect } from './Graph.jsx'
import { NODE_TYPES } from './graph'
import './Timeline.css'

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
const EDGE = 7 // px at each end of a clip that stretch it
const MIN_PPB = 10
const MAX_PPB = 260
const COLORS = ['#e4ff1a', '#f2f0e6', '#b9c96a', '#ffb347', '#86d8cc', '#c8a2ff', '#ff8fa3', '#9fb4ff']
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function colorFor(src) {
  let h = 0
  for (const ch of src) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
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
  const length = songLength(song)
  const inPatch = parts.filter((p) => p.inPatch)
  const unused = parts.filter((p) => !p.inPatch)

  const [ppb, setPpb] = useState(readZoom) // pixels per bar
  const [laneH, setLaneH] = useState(readRows) // row height
  const LANE_H = laneH
  const [selected, setSelected] = useState(() => new Set())
  const [activePart, setActivePart] = useState(null) // src: empty-row drags draw this part
  const [drag, setDrag] = useState(null) // live preview while moving / stretching / drawing
  const [marquee, setMarquee] = useState(null)
  const [ghost, setGhost] = useState(null) // where a part dragged from the sidebar would land
  const [editing, setEditing] = useState(null) // { patternId, x, y }
  const [tool, setTool] = useState('pointer') // or 'slice'
  const [synth, setSynth] = useState(null) // a phyllo part's synth window: { nodeId, x, y }
  const [panel, setPanel] = useState(null) // a rhythm / melody / code part's settings: { nodeId, x, y }
  const lastPress = useRef(null) // for double-clicks (pointer capture keeps dblclick off the clips)
  const [sliceLine, setSliceLine] = useState(null) // { bar, l0, l1 } where the slice tool would cut
  const scrollRef = useRef(null)
  const lanesRef = useRef(null)
  const playheadRef = useRef(null)
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
    if (drag.erased) return song.clips.filter((c) => !drag.erased.has(c.id))
    const moved = song.clips.map((c) => (drag.changes[c.id] ? { ...c, ...drag.changes[c.id] } : c))
    return drag.copy ? [...song.clips, ...drag.added] : [...moved, ...(drag.added ?? [])]
  }, [song.clips, drag])

  const bars = Math.max(16, Math.ceil(length) + 8, Math.ceil((scrollRef.current?.clientWidth ?? 0) / ppb) + 1)
  const lanes = Math.max(8, Math.ceil((viewH - RULER_H) / LANE_H) + 4, ...clips.map((c) => c.lane + 3)) // a few spare rows below the view, so zooming rows can keep its spot
  const step = song.snap === 'beat' ? 1 / beats : 1

  // ── geometry ──
  const barAt = (clientX) => (clientX - lanesRef.current.getBoundingClientRect().left) / ppb
  const laneAt = (clientY) => clamp(Math.floor((clientY - lanesRef.current.getBoundingClientRect().top) / LANE_H), 0, 63)
  const snap = (v, fine) => { const s = fine ? 1 / beats : step; return Math.round(v / s) * s }
  const snapDown = (v, fine) => { const s = fine ? 1 / beats : step; return Math.floor(v / s) * s }

  // ── playhead ──
  useEffect(() => {
    const show = () => {
      const el = playheadRef.current
      if (!el) return
      let pos = transport.position()
      if (length > 0 && song.on) pos %= Math.max(1, Math.ceil(length - 1e-9))
      el.style.transform = `translateX(${pos * ppb}px)`
      if (started) {
        const box = scrollRef.current
        const x = pos * ppb
        if (box && !dragRef.current && (x < box.scrollLeft || x > box.scrollLeft + box.clientWidth - 40)) box.scrollLeft = Math.max(0, x - 80)
      }
    }
    show()
    if (!started) return transport.subscribe(show)
    let frame
    const tick = () => { show(); frame = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [started, transport, ppb, length, song.on])

  // ── zoom: ctrl/cmd + wheel around the pointer; buttons; fit ──
  const zoomTo = useCallback((next, anchorClientX) => {
    const box = scrollRef.current
    if (!box) return setPpb(next)
    const rect = box.getBoundingClientRect()
    const anchor = anchorClientX ?? rect.left + box.clientWidth / 2
    const barUnder = (box.scrollLeft + anchor - rect.left) / ppb
    const clamped = clamp(next, MIN_PPB, MAX_PPB)
    setPpb(clamped)
    requestAnimationFrame(() => { box.scrollLeft = Math.max(0, barUnder * clamped - (anchor - rect.left)) })
  }, [ppb])
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
      zoomTo(ppb * Math.exp(-e.deltaY * 0.0022), e.clientX)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [ppb, laneH, zoomTo])
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
    const patternId = src.slice(8)
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
    setEditing({ patternId: pattern.id, x: e.clientX + 40, y: e.clientY })
  }

  /** Double-click a part (a clip, or in the sidebar): edit it right here, without the patch. */
  const openPart = (src, e) => {
    const x = e.clientX
    const y = e.clientY
    const node = project.nodes.find((n) => `node:${n.id}` === src)
    // after this press is over: a window opened during it would take the press for a click outside
    setTimeout(() => {
      if (src.startsWith('pattern:')) setEditing({ patternId: src.slice(8), x, y })
      else if (node?.type === 'phyllo') setSynth({ nodeId: node.id, x, y })
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
        bar: (box.scrollLeft + x) / ppb, lane: (box.scrollTop + y - RULER_H) / laneH,
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
      const group = mode === 'move' ? song.clips.filter((c) => sel.has(c.id)) : [clip]
      dragRef.current = { mode, bar, lane, group, copy: mode === 'move' && e.shiftKey, toggle: e.shiftKey ? id : null, moved: false }
      return
    }

    if (!e.shiftKey) setSelected(new Set())
    if (activePart && partBySrc.has(activePart) && !e.shiftKey) {
      // draw a clip of the active part
      const start = snapDown(bar)
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
        box.scrollLeft = Math.max(0, pan.bar * nextPpb - pan.ax)
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
        el.style.cursor = e.clientX - r.left < EDGE || r.right - e.clientX < EDGE ? 'ew-resize' : 'grab'
      }
      return
    }
    const fine = e.altKey // alt: snap to beats (finer than the setting)
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
      const db = Math.max(-minStart, snap(bar - d.bar, fine))
      const dl = Math.max(-minLane, lane - d.lane)
      if (!db && !dl && !d.moved) return
      d.moved = true
      const place = (c) => ({ start: c.start + db, lane: c.lane + dl })
      if (d.copy) setDrag({ copy: true, changes: {}, added: d.group.map((c) => ({ ...c, ...place(c), id: `__copy${c.id}` })) })
      else setDrag({ changes: Object.fromEntries(d.group.map((c) => [c.id, place(c)])) })
    } else if (d.mode === 'start' || d.mode === 'end') {
      const c = d.group[0]
      const end = c.start + c.len
      const min = 1 / beats
      const change = d.mode === 'start'
        ? (() => { const start = clamp(snap(bar, fine), 0, end - min); return { start, len: end - start, offset: (c.offset ?? 0) + (start - c.start) } })()
        : { len: clamp(snap(bar, fine) - c.start, min, MAX_BARS - c.start) }
      d.moved = true
      setDrag({ changes: { [c.id]: change } })
    } else if (d.mode === 'draw') {
      const end = Math.max(d.start + (fine ? 1 / beats : step), snap(bar, fine))
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
      if (d.gone.size) {
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
    if (editing || synth || panel) return // an open window's keys (Esc closes it) come first
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const chosen = song.clips.filter((c) => selected.has(c.id))
    const done = () => { e.preventDefault(); e.stopPropagation() }
    if (mod && k === 'a') { done(); return setSelected(new Set(song.clips.map((c) => c.id))) }
    if (!mod && k === 'c') { done(); setTool((t) => (t === 'slice' ? 'pointer' : 'slice')); setSliceLine(null); return }
    if (!mod && k === 'v') { done(); setTool('pointer'); setSliceLine(null); return }
    if (k === 'escape') { done(); if (tool !== 'pointer') { setTool('pointer'); setSliceLine(null); return } setSelected(new Set()); setActivePart(null); return }
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

  // ── ruler: click to move the playhead, drag to set a loop ──
  const rulerRef = useRef(null)
  const onRulerDown = (e) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const bar = snapDown(barAt(e.clientX), e.altKey)
    rulerRef.current = { from: bar, to: bar, moved: false }
  }
  const onRulerMove = (e) => {
    const r = rulerRef.current
    if (!r) return
    const bar = snap(barAt(e.clientX), e.altKey)
    if (Math.abs(bar - r.from) >= (e.altKey ? 1 / beats : 1)) r.moved = true
    r.to = bar
    if (r.moved) transport.setLoop({ on: true, from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) })
  }
  const onRulerUp = () => {
    const r = rulerRef.current
    rulerRef.current = null
    if (r && !r.moved) transport.seek(r.from)
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

  const partRow = (part) => {
    const count = song.clips.filter((c) => c.src === part.src).length
    return (
      <li key={part.src}>
        <button
          className={`song-part ${activePart === part.src ? 'active' : ''} ${part.inPatch ? '' : 'unused'}`}
          style={{ '--clip': colorFor(part.src) }}
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
          title={part.kind === 'pattern' ? 'Double-click to edit its instruments, sounds, steps and notes' : part.kind === 'phyllo' ? 'Double-click to open the synth' : 'Double-click to change its settings'}
        >
          <span className="song-swatch" aria-hidden />
          <span className="song-part-name">{part.name}</span>
          <span className="song-part-meta">
            {part.trigger ? 'trigger · always on' : part.kind === 'pattern' ? `${part.bars} bar${part.bars === 1 ? '' : 's'}${part.inPatch ? '' : ' · drop to add to the patch'}` : part.kind === 'sound' ? 'rhythm' : part.kind === 'notes' ? 'melody' : part.kind}
            {count > 0 ? ` · ${count} clip${count === 1 ? '' : 's'}` : part.inPatch && song.on && song.clips.length && !part.trigger ? ' · silent in the song' : ''}
          </span>
        </button>
      </li>
    )
  }

  const loop = transport.loop
  const songBars = Math.max(1, Math.ceil(length - 1e-9))
  const editingPattern = editing && project.patterns.find((p) => p.id === editing.patternId)
  const synthNode = synth && project.nodes.find((n) => n.id === synth.nodeId && n.type === 'phyllo')
  const panelNode = panel && project.nodes.find((n) => n.id === panel.nodeId)

  return (
    <section className="song" aria-label="Song timeline">
      <aside className="song-parts" aria-label="Parts">
        <div className="song-parts-head">
          <span className="song-title">parts</span>
          <button className="btn" onClick={newPattern} title="A new pattern, added to the patch and opened for editing">+ pattern</button>
        </div>
        <p className="song-parts-hint">Drag onto the timeline. Selected, you can also draw it on empty rows.</p>
        <ul className="song-part-list">
          {inPatch.map(partRow)}
        </ul>
        {unused.length > 0 && (
          <details className="song-unused">
            <summary>
              not in the patch <span className="song-unused-count">{unused.length}</span>
            </summary>
            <p className="song-parts-hint">Patterns no node plays (left over after deleting or pasting nodes). Dropping one on the timeline adds a pattern node for it to the patch.</p>
            <ul className="song-part-list">
              {unused.map(partRow)}
            </ul>
          </details>
        )}
      </aside>

      <div className="song-main">
        <div className="song-bar">
          <button
            className={`btn ${song.on ? 'on' : ''}`}
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
          <span className="song-tools" role="group" aria-label="Tool">
            <button className={`btn ${tool === 'pointer' ? 'on' : ''}`} aria-pressed={tool === 'pointer'} onClick={() => { setTool('pointer'); setSliceLine(null) }} title="Move, stretch and draw clips (V)">move</button>
            <button className={`btn ${tool === 'slice' ? 'on' : ''}`} aria-pressed={tool === 'slice'} onClick={() => setTool('slice')} title="Cut clips in two: click a clip, or drag up or down to cut every clip on those rows (C)">slice</button>
          </span>
          <span className="spacer" />
          <span className="song-hint">{tool === 'slice' ? 'click a clip to cut it · drag up or down to cut several · alt snaps finer · V or Esc to go back' : 'shift-drag copies · right-click deletes · alt snaps finer · ctrl/cmd + D duplicates · C slices'}</span>
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
          <div className="song-canvas" style={{ width: bars * ppb, '--ppb': `${ppb}px`, '--ppbeat': `${ppb / beats}px`, '--lane': `${LANE_H}px` }}>
            <div
              className="song-ruler"
              style={{ height: RULER_H }}
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              title="Click to move the playhead · drag to loop a section"
            >
              {Array.from({ length: bars }, (_, i) => (
                (ppb >= 22 || i % Math.ceil(22 / ppb) === 0) && <span key={i} className={`song-tick ${i % 4 === 0 ? 'major' : ''}`} style={{ left: i * ppb }}>{i + 1}</span>
              ))}
              {loop.on && loop.to > loop.from && (
                <span className="song-loop" style={{ left: loop.from * ppb, width: (loop.to - loop.from) * ppb }} aria-label={`Loop bars ${loop.from + 1} to ${loop.to}`} />
              )}
              {length > 0 && <span className="song-end" style={{ left: songBars * ppb }} title="The song loops here" />}
            </div>

            <div
              className={`song-lanes ${drag ? 'dragging' : ''} ${tool === 'slice' ? 'slicing' : ''}`}
              ref={lanesRef}
              style={{ height: lanes * LANE_H }}
              onPointerDown={onLanesDown}
              onPointerMove={onLanesMove}
              onPointerUp={onLanesUp}
              onPointerCancel={() => { dragRef.current = null; panRef.current = null; setDrag(null); setMarquee(null) }}
              onPointerLeave={() => { if (!dragRef.current) setSliceLine(null) }}
              onContextMenu={(e) => e.preventDefault()}
              onDragOver={onDragOver}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setGhost((g) => (g ? { ...g, lane: -1 } : g)) }}
              onDrop={onDrop}
            >
              {length > 0 && song.on && <div className="song-after" style={{ left: songBars * ppb }} />}
              {clips.map((c) => {
                const part = partBySrc.get(c.src)
                if (!part) return null
                // where the pattern starts over inside the clip (it may begin part-way in, after a cut)
                const into = part.kind === 'pattern' && part.bars > 0 ? (((c.offset ?? 0) % part.bars) + part.bars) % part.bars : 0
                const firstRepeat = part.bars - into
                const repeats = part.kind === 'pattern' && part.bars > 0 ? Math.max(0, Math.ceil((c.len - firstRepeat - 1e-9) / part.bars)) : 0
                return (
                  <div
                    key={c.id}
                    data-id={c.id}
                    className={`clip ${selected.has(c.id) ? 'selected' : ''} ${c.id.startsWith('__') ? 'preview' : ''} ${!song.on ? 'off' : ''}`}
                    style={{ left: c.start * ppb, top: c.lane * LANE_H + 3, width: Math.max(4, c.len * ppb - 1), height: LANE_H - 6, '--clip': colorFor(c.src) }}
                    title={`${part.name} · bar ${Math.floor(c.start) + 1}${c.start % 1 ? `.${Math.round((c.start % 1) * beats) + 1}` : ''} · ${Math.round(c.len * beats) / beats} bar${c.len === 1 ? '' : 's'}`}
                  >
                    <span className="clip-name">{part.name}</span>
                    {Array.from({ length: repeats }, (_, i) => (
                      <span key={i} className="clip-repeat" style={{ left: (firstRepeat + i * part.bars) * ppb }} aria-hidden />
                    ))}
                  </div>
                )
              })}
              {ghost && ghost.lane >= 0 && (
                <div className="clip preview ghost" style={{ left: ghost.start * ppb, top: ghost.lane * LANE_H + 3, width: ghost.len * ppb - 1, height: LANE_H - 6, '--clip': colorFor(ghost.src ?? '') }}>
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

      {synthNode && (
        <Phyllo
          key={synthNode.id}
          node={synthNode}
          cps={(project.bpm || 120) / (project.beats || 4) / 60}
          anchor={synth}
          onEdit={(fn) => onUpdateProject((p) => {
            const n = p.nodes.find((x) => x.id === synthNode.id)
            if (n) { n.data.patch = normalizePatch(n.data.patch); fn(n.data.patch) }
          })}
          onClose={() => setSynth(null)}
        />
      )}
      {panelNode && <PartPanel node={panelNode} anchor={panel} onUpdateProject={onUpdateProject} onClose={() => setPanel(null)} />}
      {editingPattern && (
        <PatternEditor
          project={project}
          patternId={editingPattern.id}
          anchor={editing}
          transport={transport}
          started={started}
          onUpdateProject={onUpdateProject}
          onClose={() => setEditing(null)}
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
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('input, textarea, select')) onClose() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', onKey) }
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
