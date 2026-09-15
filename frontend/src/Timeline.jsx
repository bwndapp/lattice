import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makePattern, newId } from './project'
import { MAX_BARS, songLength, songParts } from './song'
import PatternEditor from './PatternEditor.jsx'
import './Timeline.css'

/**
 * The song view: parts on the left, a timeline on the right. Drag a part onto a row to
 * place a clip; drag a clip to move it (alt: a copy), its edges to stretch it; shift-click
 * or drag across empty rows to select several. Clicking the ruler moves the playhead,
 * dragging along it sets a loop. Ctrl/cmd + scroll zooms, middle-drag pans.
 */
const PART_MIME = 'application/x-lattice-part'
const LANE_H = 40
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

function readZoom() {
  try { return clamp(Number(localStorage.getItem('lattice:song:zoom')) || 48, MIN_PPB, MAX_PPB) } catch { return 48 }
}

export default function Timeline({ project, onUpdateProject, transport, started }) {
  const song = project.song ?? { on: true, snap: 'bar', clips: [] }
  const beats = Math.max(1, project.beats || 4)
  const parts = useMemo(() => songParts(project), [project])
  const partBySrc = useMemo(() => new Map(parts.map((p) => [p.src, p])), [parts])
  const length = songLength(song)

  const [ppb, setPpb] = useState(readZoom) // pixels per bar
  const [selected, setSelected] = useState(() => new Set())
  const [activePart, setActivePart] = useState(null) // src: empty-row drags draw this part
  const [drag, setDrag] = useState(null) // live preview while moving / stretching / drawing
  const [marquee, setMarquee] = useState(null)
  const [ghost, setGhost] = useState(null) // where a part dragged from the sidebar would land
  const [editing, setEditing] = useState(null) // { patternId, x, y }
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

  useEffect(() => { try { localStorage.setItem('lattice:song:zoom', String(ppb)) } catch { /* storage unavailable */ } }, [ppb])

  const updateSong = useCallback((fn) => onUpdateProject((p) => {
    p.song = p.song ?? { on: true, snap: 'bar', clips: [] }
    fn(p.song, p)
  }), [onUpdateProject])

  // clips as shown: the project's, with a drag's changes laid over them
  const clips = useMemo(() => {
    if (!drag) return song.clips
    const moved = song.clips.map((c) => (drag.changes[c.id] ? { ...c, ...drag.changes[c.id] } : c))
    return drag.copy ? [...song.clips, ...drag.added] : [...moved, ...(drag.added ?? [])]
  }, [song.clips, drag])

  const bars = Math.max(16, Math.ceil(length) + 8, Math.ceil((scrollRef.current?.clientWidth ?? 0) / ppb) + 1)
  const lanes = Math.max(8, Math.ceil((viewH - RULER_H) / LANE_H), ...clips.map((c) => c.lane + 3))
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
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      zoomTo(ppb * Math.exp(-e.deltaY * 0.0022), e.clientX)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [ppb, zoomTo])
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

  // ── pointer: clips, empty rows, panning ──
  const onLanesDown = (e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey && !e.target.closest('.clip'))) {
      e.preventDefault()
      panRef.current = { x: e.clientX, y: e.clientY, left: scrollRef.current.scrollLeft, top: scrollRef.current.scrollTop }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    scrollRef.current?.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    const el = e.target.closest('.clip')
    const bar = barAt(e.clientX)
    const lane = laneAt(e.clientY)

    if (el) {
      const id = el.dataset.id
      const clip = song.clips.find((c) => c.id === id)
      if (!clip) return
      let sel = selected
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        sel = new Set(selected)
        sel.has(id) ? sel.delete(id) : sel.add(id)
        setSelected(sel)
        if (!sel.has(id)) return
      } else if (!sel.has(id)) {
        sel = new Set([id])
        setSelected(sel)
      }
      setActivePart(clip.src)
      const rect = el.getBoundingClientRect()
      const mode = e.clientX - rect.left < EDGE ? 'start' : rect.right - e.clientX < EDGE ? 'end' : 'move'
      const group = mode === 'move' ? song.clips.filter((c) => sel.has(c.id)) : [clip]
      dragRef.current = { mode, bar, lane, group, copy: mode === 'move' && e.altKey, moved: false }
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
    if (pan) {
      scrollRef.current.scrollLeft = pan.left - (e.clientX - pan.x)
      scrollRef.current.scrollTop = pan.top - (e.clientY - pan.y)
      return
    }
    const d = dragRef.current
    if (!d) {
      const el = e.target.closest?.('.clip')
      if (el) {
        const r = el.getBoundingClientRect()
        el.style.cursor = e.clientX - r.left < EDGE || r.right - e.clientX < EDGE ? 'ew-resize' : 'grab'
      }
      return
    }
    const fine = e.shiftKey
    const bar = barAt(e.clientX)
    const lane = laneAt(e.clientY)
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
        ? (() => { const start = clamp(snap(bar, fine), 0, end - min); return { start, len: end - start } })()
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
    if (panRef.current) { panRef.current = null; return }
    const d = dragRef.current
    dragRef.current = null
    const preview = drag
    setDrag(null)
    setMarquee(null)
    if (!d) return
    if (d.mode === 'draw') {
      const c = preview?.added?.[0]
      if (c) addClip(c.src, c.start, c.lane, c.len)
      return
    }
    if (!d.moved || !preview) {
      // a plain click on a pattern clip, with nothing moved: nothing else to do
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

  const onClipDoubleClick = (e) => {
    const el = e.target.closest('.clip')
    const clip = el && song.clips.find((c) => c.id === el.dataset.id)
    if (clip?.src.startsWith('pattern:')) setEditing({ patternId: clip.src.slice(8), x: e.clientX, y: e.clientY })
  }

  // ── keys ──
  const onKeyDown = (e) => {
    if (e.target.closest('input, select, textarea')) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const chosen = song.clips.filter((c) => selected.has(c.id))
    const done = () => { e.preventDefault(); e.stopPropagation() }
    if (mod && k === 'a') { done(); return setSelected(new Set(song.clips.map((c) => c.id))) }
    if (k === 'escape') { done(); setSelected(new Set()); setActivePart(null); return }
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
    const bar = snapDown(barAt(e.clientX), e.shiftKey)
    rulerRef.current = { from: bar, to: bar, moved: false }
  }
  const onRulerMove = (e) => {
    const r = rulerRef.current
    if (!r) return
    const bar = snap(barAt(e.clientX), e.shiftKey)
    if (Math.abs(bar - r.from) >= (e.shiftKey ? 1 / beats : 1)) r.moved = true
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

  const loop = transport.loop
  const songBars = Math.max(1, Math.ceil(length - 1e-9))
  const editingPattern = editing && project.patterns.find((p) => p.id === editing.patternId)

  return (
    <section className="song" aria-label="Song timeline">
      <aside className="song-parts" aria-label="Parts">
        <div className="song-parts-head">
          <span className="song-title">parts</span>
          <button className="btn" onClick={newPattern} title="A new pattern, added to the patch and opened for editing">+ pattern</button>
        </div>
        <p className="song-parts-hint">Drag onto the timeline. Selected, you can also draw it on empty rows.</p>
        <ul className="song-part-list">
          {parts.map((part) => {
            const count = song.clips.filter((c) => c.src === part.src).length
            return (
              <li key={part.src}>
                <button
                  className={`song-part ${activePart === part.src ? 'active' : ''}`}
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
                  onDoubleClick={(e) => part.kind === 'pattern' && setEditing({ patternId: part.id, x: e.clientX + 60, y: e.clientY })}
                  title={part.kind === 'pattern' ? 'Double-click to edit its steps and notes' : 'A sound source from the patch'}
                >
                  <span className="song-swatch" aria-hidden />
                  <span className="song-part-name">{part.name}</span>
                  <span className="song-part-meta">
                    {part.trigger ? 'trigger · always on' : part.kind === 'pattern' ? `${part.bars} bar${part.bars === 1 ? '' : 's'}${part.inPatch ? '' : ' · not in patch'}` : part.kind === 'sound' ? 'rhythm' : part.kind === 'notes' ? 'melody' : part.kind}
                    {count > 0 ? ` · ${count} clip${count === 1 ? '' : 's'}` : song.on && song.clips.length && !part.trigger ? ' · silent in the song' : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
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
          <span className="spacer" />
          <span className="song-hint">alt-drag copies · shift snaps finer · ctrl/cmd + D duplicates · drag the ruler to loop</span>
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
              className={`song-lanes ${drag ? 'dragging' : ''}`}
              ref={lanesRef}
              style={{ height: lanes * LANE_H }}
              onPointerDown={onLanesDown}
              onPointerMove={onLanesMove}
              onPointerUp={onLanesUp}
              onPointerCancel={() => { dragRef.current = null; panRef.current = null; setDrag(null); setMarquee(null) }}
              onDoubleClick={onClipDoubleClick}
              onDragOver={onDragOver}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setGhost((g) => (g ? { ...g, lane: -1 } : g)) }}
              onDrop={onDrop}
            >
              {length > 0 && song.on && <div className="song-after" style={{ left: songBars * ppb }} />}
              {clips.map((c) => {
                const part = partBySrc.get(c.src)
                if (!part) return null
                const repeats = part.kind === 'pattern' && part.bars > 0 ? Math.floor((c.len - 1e-9) / part.bars) : 0
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
                      <span key={i} className="clip-repeat" style={{ left: (i + 1) * part.bars * ppb }} aria-hidden />
                    ))}
                  </div>
                )
              })}
              {ghost && ghost.lane >= 0 && (
                <div className="clip preview ghost" style={{ left: ghost.start * ppb, top: ghost.lane * LANE_H + 3, width: ghost.len * ppb - 1, height: LANE_H - 6, '--clip': colorFor(ghost.src ?? '') }}>
                  <span className="clip-name">{partBySrc.get(ghost.src)?.name}</span>
                </div>
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
