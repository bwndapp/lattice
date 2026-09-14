import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isBlackKey, midiToNote, noteToMidi, stepCount } from './project'

const KEY_W = 46
const RULER_H = 20
const LOW = 24 // c1
const HIGH = 96 // c7
const ROWS = HIGH - LOW + 1
const ROW_SIZES = { s: 8, m: 12, l: 18 }
const MAX_CANVAS = 12000 // px; beyond this browsers start dropping canvas pixels

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const same = (a, b) => a && b && a.s === b.s && a.n === b.n

function readPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

const colors = () => {
  const css = getComputedStyle(document.documentElement)
  const c = (name, fallback) => css.getPropertyValue(name).trim() || fallback
  return { acid: c('--acid', '#e4ff1a'), paper: c('--paper', '#f2f0e6'), line: c('--line', '#2e2e2a'), muted: c('--muted', '#a3a39a') }
}

function fitCanvas(canvas, w, h, { keepCss = false } = {}) {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  if (!keepCss) {
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/**
 * Piano roll for a synth channel. Click to add a note (drag right to set its length),
 * drag a note to move it, drag its right edge to resize, right-click to delete. Notes
 * can overlap for chords. Arrow keys nudge the selected note, Delete removes it.
 *
 * Getting around long patterns: ctrl/cmd + scroll zooms around the pointer (or −, +,
 * fit), the bar ruler stays on top and jumps to a bar when clicked, the overview strip
 * shows every bar with a draggable view box, middle-drag or alt + drag pans, follow keeps the playhead
 * in view, and the roll can be dragged taller or opened full screen.
 */
export default function PianoRoll({ channel, pattern, beats, onChangeNotes, onPreview, cursorRef }) {
  const scrollRef = useRef(null)
  const gridRef = useRef(null)
  const keysRef = useRef(null)
  const rulerRef = useRef(null)
  const overviewRef = useRef(null)
  const lineRef = useRef(null)
  const [viewW, setViewW] = useState(600)
  const [zoom, setZoom] = useState(null) // px per step; null = fit the whole pattern
  const [rowSize, setRowSize] = useState(() => readPref('strudel:roll:rows', 'm'))
  const [follow, setFollow] = useState(() => readPref('strudel:roll:follow', true))
  const [full, setFull] = useState(false)
  const [draft, setDraft] = useState(null) // notes while dragging
  const [selected, setSelected] = useState(null)
  const dragRef = useRef(null)
  const panRef = useRef(null)
  const lastLen = useRef(2)
  const anchorRef = useRef(null) // keep a step under the pointer while zooming

  const total = stepCount(pattern)
  const stepsPerBeat = Math.max(1, Math.round(pattern.stepsPerBar / beats))
  const rowH = ROW_SIZES[rowSize] ?? 12
  const maxCol = Math.max(8, Math.floor(MAX_CANVAS / total))
  const fitCol = clamp(Math.floor((viewW - KEY_W) / total), 4, maxCol)
  const colW = zoom === null ? fitCol : clamp(zoom, 4, maxCol)
  const notes = draft ?? channel.notes

  useEffect(() => writePref('strudel:roll:rows', rowSize), [rowSize])
  useEffect(() => writePref('strudel:roll:follow', follow), [follow])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewW(el.clientWidth))
    observer.observe(el)
    // start scrolled to where the notes are (or the channel's note)
    const pitches = channel.notes.map((x) => x.n)
    const centre = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : noteToMidi(channel.note)
    el.scrollTop = clamp((HIGH - centre) * rowH - el.clientHeight / 2, 0, ROWS * rowH)
    return () => observer.disconnect()
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // after a zoom, put the anchored step back under the pointer
  useLayoutEffect(() => {
    const a = anchorRef.current
    const el = scrollRef.current
    if (!a || !el) return
    el.scrollLeft = a.step * colW - a.offset
    anchorRef.current = null
  }, [colW])

  const zoomTo = useCallback((next, pointerX = null) => {
    const el = scrollRef.current
    if (!el) return
    const offset = pointerX ?? (el.clientWidth - KEY_W) / 2 // px from the grid's left edge on screen
    anchorRef.current = { step: (el.scrollLeft + offset) / colW, offset }
    setZoom(clamp(Math.round(next * 10) / 10, 4, maxCol))
  }, [colW, maxCol])

  // ── drawing ──
  const drawOverview = useCallback(() => {
    const canvas = overviewRef.current
    const el = scrollRef.current
    if (!canvas || !el) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    const ctx = fitCanvas(canvas, w, h, { keepCss: true }) // its CSS size comes from the stylesheet
    const { acid, paper, line, muted } = colors()
    ctx.fillStyle = '#0c0c0b'
    ctx.fillRect(0, 0, w, h)
    const sx = w / total
    for (let bar = 0; bar <= pattern.bars; bar++) {
      ctx.fillStyle = line
      ctx.fillRect(Math.round(bar * pattern.stepsPerBar * sx), 0, 1, h)
    }
    const pitches = notes.map((x) => x.n)
    const lo = pitches.length ? Math.min(...pitches) - 1 : 40
    const hi = pitches.length ? Math.max(...pitches) + 1 : 60
    const rh = Math.max(1.5, (h - 4) / Math.max(hi - lo + 1, 8))
    ctx.fillStyle = acid
    for (const x of notes) ctx.fillRect(x.s * sx, 2 + (hi - x.n) * rh, Math.max(1.5, x.l * sx - 1), Math.max(1.5, rh - 0.5))
    // the part of the pattern on screen
    const left = (el.scrollLeft / (total * colW)) * w
    const width = Math.min(w, ((el.clientWidth - KEY_W) / (total * colW)) * w)
    ctx.fillStyle = paper
    ctx.globalAlpha = 0.1
    ctx.fillRect(left, 0, width, h)
    ctx.globalAlpha = 1
    ctx.strokeStyle = width >= w - 1 ? muted : paper
    ctx.lineWidth = 2
    ctx.strokeRect(left + 1, 1, Math.max(4, width - 2), h - 2)
  }, [notes, total, colW, pattern.bars, pattern.stepsPerBar])

  const draw = useCallback(() => {
    const { acid, paper, line, muted } = colors()
    const gridW = total * colW
    const gridH = ROWS * rowH

    const keys = keysRef.current
    if (keys) {
      const ctx = fitCanvas(keys, KEY_W, gridH)
      for (let r = 0; r < ROWS; r++) {
        const midi = HIGH - r
        const black = isBlackKey(midi)
        ctx.fillStyle = black ? '#111' : '#d9d6ca'
        ctx.fillRect(0, r * rowH, black ? KEY_W * 0.62 : KEY_W, rowH - 1)
        if (black) { ctx.fillStyle = '#d9d6ca'; ctx.fillRect(KEY_W * 0.62, r * rowH, KEY_W * 0.38, rowH - 1) }
        if (midi % 12 === 0 && rowH >= 8) {
          ctx.fillStyle = '#000'
          ctx.font = `${Math.min(9, rowH - 2)}px "Martian Mono", ui-monospace, monospace`
          ctx.textBaseline = 'middle'
          ctx.fillText(midiToNote(midi), KEY_W - 22, r * rowH + rowH / 2)
        }
      }
    }

    const ruler = rulerRef.current
    if (ruler) {
      const ctx = fitCanvas(ruler, gridW, RULER_H)
      ctx.fillStyle = '#0c0c0b'
      ctx.fillRect(0, 0, gridW, RULER_H)
      ctx.textBaseline = 'middle'
      for (let i = 0; i < total; i++) {
        const x = i * colW
        if (i % pattern.stepsPerBar === 0) {
          ctx.fillStyle = paper
          ctx.fillRect(x, 0, 2, RULER_H)
          ctx.font = '11px "Martian Mono", ui-monospace, monospace'
          ctx.fillText(`bar ${i / pattern.stepsPerBar + 1}`, x + 5, RULER_H / 2)
        } else if (i % stepsPerBeat === 0 && colW * stepsPerBeat >= 14) {
          ctx.fillStyle = muted
          ctx.fillRect(x, RULER_H - 6, 1, 6)
        }
      }
      ctx.fillStyle = line
      ctx.fillRect(0, RULER_H - 1, gridW, 1)
    }

    const grid = gridRef.current
    if (!grid) return
    const ctx = fitCanvas(grid, gridW, gridH)
    for (let r = 0; r < ROWS; r++) {
      const midi = HIGH - r
      ctx.fillStyle = isBlackKey(midi) ? '#070707' : '#111110'
      ctx.fillRect(0, r * rowH, gridW, rowH)
      if (midi % 12 === 0) { ctx.fillStyle = line; ctx.fillRect(0, (r + 1) * rowH - 1, gridW, 1) }
    }
    for (let i = 0; i <= total; i++) {
      const bar = i % pattern.stepsPerBar === 0
      const beat = i % stepsPerBeat === 0
      if (!bar && !beat && colW < 8) continue // too dense to be useful
      ctx.fillStyle = bar ? paper : line
      ctx.globalAlpha = bar ? 0.55 : beat ? 0.9 : 0.35
      ctx.fillRect(i * colW, 0, bar ? 2 : 1, gridH)
    }
    ctx.globalAlpha = 1
    for (const note of notes) {
      const x = note.s * colW + 1
      const y = (HIGH - note.n) * rowH + 1
      const nw = Math.max(2, note.l * colW - 2)
      const sel = same(note, selected)
      ctx.fillStyle = sel ? paper : acid
      ctx.fillRect(x, y, nw, rowH - 2)
      if (nw > 8) {
        ctx.fillStyle = '#000'
        ctx.globalAlpha = 0.45
        ctx.fillRect(x + nw - 3, y + 2, 2, Math.max(2, rowH - 6)) // resize grip
        ctx.globalAlpha = 1
      }
      if (nw > 30 && rowH >= 10) {
        ctx.font = '8px "Martian Mono", ui-monospace, monospace'
        ctx.textBaseline = 'middle'
        ctx.fillText(midiToNote(note.n), x + 3, y + (rowH - 2) / 2)
      }
    }
    drawOverview()
  }, [notes, selected, total, colW, rowH, pattern.stepsPerBar, stepsPerBeat, drawOverview])

  useEffect(() => { draw() }, [draw])

  // playback cursor, and follow
  useEffect(() => {
    let frame
    const tick = () => {
      const step = cursorRef?.current?.() ?? -1
      const el = scrollRef.current
      if (lineRef.current) {
        lineRef.current.hidden = step < 0
        lineRef.current.style.transform = `translateX(${step * colW}px)`
      }
      if (el && step >= 0 && follow && !dragRef.current && !panRef.current) {
        const x = step * colW
        const visible = el.clientWidth - KEY_W
        if (x < el.scrollLeft || x > el.scrollLeft + visible - colW) {
          el.scrollLeft = Math.max(0, x - colW)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [cursorRef, colW, follow])

  // ctrl/cmd + wheel zooms the steps around the pointer (non-passive so the page doesn't zoom)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const pointerX = e.clientX - el.getBoundingClientRect().left - KEY_W
      zoomTo(colW * Math.exp(-e.deltaY * 0.004), Math.max(0, pointerX))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [colW, zoomTo])

  useEffect(() => {
    if (!full) return
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setFull(false) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [full])

  /** Scroll so a note (or step range) is on screen. */
  const reveal = (note) => {
    const el = scrollRef.current
    if (!el || !note) return
    const x0 = note.s * colW
    const x1 = (note.s + note.l) * colW
    const visible = el.clientWidth - KEY_W
    if (x0 < el.scrollLeft) el.scrollLeft = x0 - colW
    else if (x1 > el.scrollLeft + visible) el.scrollLeft = x1 - visible + colW
    const y = (HIGH - note.n) * rowH
    const visibleH = el.clientHeight - RULER_H
    if (y < el.scrollTop) el.scrollTop = y - rowH * 2
    else if (y + rowH > el.scrollTop + visibleH) el.scrollTop = y - visibleH + rowH * 3
  }

  // ── editing ──
  const hit = (e) => {
    const rect = gridRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const step = clamp(Math.floor(x / colW), 0, total - 1)
    const midi = clamp(HIGH - Math.floor(y / rowH), LOW, HIGH)
    const note = notes.find((nt) => nt.n === midi && step >= nt.s && step < nt.s + nt.l)
    const edge = note && x >= (note.s + note.l) * colW - Math.min(7, colW / 2)
    return { x, step, midi, note, edge }
  }

  const commit = (next) => {
    setDraft(null)
    onChangeNotes(next)
  }

  // Panning: middle-drag, or alt/option + drag, anywhere in the roll (grid, ruler or keys).
  // It's handled on the scroll box in the capture phase so it wins over note editing, and
  // the middle button's mousedown is cancelled so the browser doesn't start its own
  // auto-scroll instead.
  const isPan = (e) => e.button === 1 || (e.button === 0 && e.altKey)
  const startPan = (e) => {
    const el = scrollRef.current
    e.preventDefault()
    e.stopPropagation()
    el.setPointerCapture(e.pointerId)
    el.focus({ preventScroll: true })
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    el.classList.add('panning')
  }
  const movePan = (e) => {
    const pan = panRef.current
    if (!pan || e.pointerId !== pan.id) return
    const el = scrollRef.current
    el.scrollLeft = pan.left - (e.clientX - pan.x)
    el.scrollTop = pan.top - (e.clientY - pan.y)
  }
  const endPan = () => {
    if (!panRef.current) return
    panRef.current = null
    scrollRef.current?.classList.remove('panning')
  }

  const onDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrollRef.current?.focus({ preventScroll: true })
    const h = hit(e)
    if (e.button === 2) {
      const next = h.note ? notes.filter((nt) => nt !== h.note) : notes
      dragRef.current = { mode: 'erase', notes: next }
      setDraft(next)
      return
    }
    if (e.button !== 0) return
    if (h.note) {
      setSelected(h.note)
      onPreview(h.note.n)
      dragRef.current = { mode: h.edge ? 'resize' : 'move', orig: h.note, grab: h.step - h.note.s, grabMidi: h.midi, moved: false }
    } else {
      const created = { s: h.step, l: clamp(lastLen.current, 1, total - h.step), n: h.midi }
      onPreview(h.midi)
      setSelected(created)
      dragRef.current = { mode: 'create', orig: created, base: notes }
      setDraft([...notes, created])
    }
  }

  const onMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const h = hit(e)
    if (d.mode === 'erase') {
      if (h.note) { d.notes = d.notes.filter((nt) => nt !== h.note); setDraft(d.notes) }
    } else if (d.mode === 'create' || d.mode === 'resize') {
      const l = clamp(h.step - d.orig.s + 1, 1, total - d.orig.s)
      const updated = { ...d.orig, l }
      d.current = updated
      setSelected(updated)
      setDraft(d.mode === 'create' ? [...d.base, updated] : channel.notes.map((nt) => (nt === d.orig ? updated : nt)))
    } else if (d.mode === 'move') {
      const s = clamp(h.step - d.grab, 0, total - d.orig.l)
      const n = clamp(d.orig.n + (h.midi - d.grabMidi), LOW, HIGH)
      if (s === d.orig.s && n === d.orig.n && !d.moved) return
      if (n !== (d.current?.n ?? d.orig.n)) onPreview(n)
      d.moved = true
      const updated = { ...d.orig, s, n }
      d.current = updated
      setSelected(updated)
      setDraft(channel.notes.map((nt) => (nt === d.orig ? updated : nt)))
    }
  }

  const onUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.mode === 'erase') return commit(d.notes)
    if (d.mode === 'create') {
      const note = d.current ?? d.orig
      lastLen.current = note.l
      return commit([...d.base, note])
    }
    if (d.current) {
      if (d.mode === 'resize') lastLen.current = d.current.l
      return commit(channel.notes.map((nt) => (nt === d.orig ? d.current : nt)))
    }
    setDraft(null)
  }

  const onKey = (e) => {
    if (e.key === 'f' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); return setFull((v) => !v) }
    if (!selected) return
    const idx = channel.notes.findIndex((nt) => same(nt, selected))
    if (idx < 0) return
    const note = channel.notes[idx]
    let updated = null
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      setSelected(null)
      return onChangeNotes(channel.notes.filter((_, i) => i !== idx))
    }
    if (e.key === 'ArrowUp') updated = { ...note, n: clamp(note.n + (e.shiftKey ? 12 : 1), LOW, HIGH) }
    else if (e.key === 'ArrowDown') updated = { ...note, n: clamp(note.n - (e.shiftKey ? 12 : 1), LOW, HIGH) }
    else if (e.key === 'ArrowRight') updated = { ...note, s: clamp(note.s + (e.shiftKey ? pattern.stepsPerBar : 1), 0, total - note.l) }
    else if (e.key === 'ArrowLeft') updated = { ...note, s: clamp(note.s - (e.shiftKey ? pattern.stepsPerBar : 1), 0, total - note.l) }
    else return
    e.preventDefault()
    if (updated.n !== note.n) onPreview(updated.n)
    setSelected(updated)
    reveal(updated)
    onChangeNotes(channel.notes.map((nt, i) => (i === idx ? updated : nt)))
  }

  // overview: click or drag to move the view
  const overviewDrag = useRef(false)
  const scrubOverview = (e) => {
    const el = scrollRef.current
    const rect = overviewRef.current.getBoundingClientRect()
    const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    el.scrollLeft = frac * total * colW - (el.clientWidth - KEY_W) / 2
  }

  const barCount = pattern.bars
  const zoomLabel = zoom === null ? 'fit' : `${Math.round((colW / fitCol) * 100)}%`

  return (
    <div className={`pr ${full ? 'full' : ''}`}>
      {full && <div className="pr-backdrop" onClick={() => setFull(false)} aria-hidden />}
      <div className="pr-panel">
        <div className="pr-toolbar">
          <span className="pr-title">{channel.name}</span>
          <span className="pr-group" role="group" aria-label="Zoom">
            <button type="button" className="node-btn" onClick={() => zoomTo(colW / 1.5)} aria-label="Zoom out" title="Zoom out (ctrl/cmd + scroll)">−</button>
            <span className="pr-zoom" aria-live="polite">{zoomLabel}</span>
            <button type="button" className="node-btn" onClick={() => zoomTo(colW * 1.5)} aria-label="Zoom in" title="Zoom in (ctrl/cmd + scroll)">+</button>
            <button type="button" className={`node-btn ${zoom === null ? 'on' : ''}`} onClick={() => setZoom(null)} title="Fit every bar in view">fit</button>
          </span>
          <span className="pr-group" role="group" aria-label="Row height">
            {Object.keys(ROW_SIZES).map((k) => (
              <button key={k} type="button" className={`node-btn ${rowSize === k ? 'on' : ''}`} aria-pressed={rowSize === k} onClick={() => setRowSize(k)} title="Row height">{k}</button>
            ))}
          </span>
          <button type="button" className={`node-btn ${follow ? 'on' : ''}`} aria-pressed={follow} onClick={() => setFollow((v) => !v)} title="Keep the playhead in view while playing">follow</button>
          <span className="pr-spacer" />
          <span className="pr-hint">{barCount} bar{barCount === 1 ? '' : 's'} · ctrl/cmd+scroll zooms · middle-drag or alt+drag pans</span>
          <button type="button" className={`node-btn ${full ? 'on' : ''}`} onClick={() => setFull((v) => !v)} title="Full screen (F, Esc to close)">{full ? 'close' : 'full screen'}</button>
        </div>
        <canvas
          className="pr-overview"
          ref={overviewRef}
          role="slider"
          aria-label="Pattern overview: click or drag to move the view"
          aria-valuemin={0}
          aria-valuemax={barCount}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); overviewDrag.current = true; scrubOverview(e) }}
          onPointerMove={(e) => { if (overviewDrag.current) scrubOverview(e) }}
          onPointerUp={() => { overviewDrag.current = false }}
        />
        <div
          className="piano-roll"
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKey}
          onScroll={drawOverview}
          onPointerDownCapture={(e) => { if (isPan(e)) startPan(e) }}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onLostPointerCapture={endPan}
          onMouseDownCapture={(e) => { if (e.button === 1) e.preventDefault() }}
          onAuxClick={(e) => { if (e.button === 1) e.preventDefault() }}
          aria-label={`${channel.name} piano roll: click to add notes, drag to move, right-click to delete`}
        >
          <div className="pr-inner" style={{ gridTemplateColumns: `${KEY_W}px ${total * colW}px`, gridTemplateRows: `${RULER_H}px ${ROWS * rowH}px` }}>
            <div className="pr-corner" aria-hidden />
            <canvas
              className="pr-ruler"
              ref={rulerRef}
              title="Click a bar to jump there"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const bar = Math.floor((e.clientX - rect.left) / colW / pattern.stepsPerBar)
                scrollRef.current.scrollTo({ left: bar * pattern.stepsPerBar * colW, behavior: 'smooth' })
              }}
            />
            <canvas
              className="pr-keys"
              ref={keysRef}
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                onPreview(clamp(HIGH - Math.floor((e.clientY - rect.top) / rowH), LOW, HIGH))
              }}
            />
            <div className="pr-grid-wrap">
              <canvas
                className="pr-grid"
                ref={gridRef}
                onPointerDown={onDown}
                onPointerMove={(e) => {
                  onMove(e)
                  if (!dragRef.current && !panRef.current) {
                    const h = hit(e)
                    e.currentTarget.style.cursor = h.note ? (h.edge ? 'ew-resize' : 'grab') : 'crosshair'
                  }
                }}
                onPointerUp={onUp}
                onPointerCancel={() => { dragRef.current = null; setDraft(null) }}
                onContextMenu={(e) => e.preventDefault()}
                onAuxClick={(e) => e.preventDefault()}
              />
              <div className="pr-cursor" ref={lineRef} hidden style={{ width: colW }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
