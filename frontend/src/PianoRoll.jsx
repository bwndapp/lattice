import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TICK, isBlackKey, midiToNote, noteToMidi, stepCount } from './project'

const KEY_W = 46
const RULER_H = 20
const LOW = 24 // c1
const HIGH = 96 // c7
const ROWS = HIGH - LOW + 1
const ROW_SIZES = { s: 8, m: 12, l: 18 }
const MIN_ROW = 6
const MAX_ROW = 36
const MAX_CANVAS = 12000 // px; beyond this browsers start dropping canvas pixels

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const keyOf = (note) => `${note.s}:${note.n}`
// copied notes, relative to their earliest step; shared by every piano roll on the page
let clipboard = null

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
 * Piano roll for a synth channel. Notes land on the step grid; hold alt and they go
 * wherever the pointer is instead, down to a sixty-fourth of a step.
 * Click to add a note (drag right to set its length),
 * drag a note to move it, drag its right edge to resize, right-click to delete. Notes
 * can overlap for chords. ctrl/cmd + A selects all, shift + click adds a note to the
 * selection, ctrl/cmd + drag draws a selection box, and dragging any selected note moves
 * them all (ctrl/cmd + drag a note to copy). Arrows nudge the selection, Delete removes
 * it, ctrl/cmd + C / X / V / D copy, cut, paste and duplicate.
 *
 * Getting around long patterns: ctrl/cmd + scroll zooms around the pointer (or −, +,
 * fit), the bar ruler stays on top and jumps to a bar when clicked, the overview strip
 * shows every bar with a draggable view box, middle-drag pans, follow keeps the playhead
 * in view, and the roll can be dragged taller or opened full screen.
 */
export default function PianoRoll({ channel, pattern, beats, onChangeNotes, onPreview, cursorRef, onSeek, fill = false }) {
  const scrollRef = useRef(null)
  const gridRef = useRef(null)
  const keysRef = useRef(null)
  const rulerRef = useRef(null)
  const seekRef = useRef(null) // dragging the playhead along the ruler
  const overviewRef = useRef(null)
  const lineRef = useRef(null)
  const [viewW, setViewW] = useState(600)
  const [zoom, setZoom] = useState(null) // px per step; null = fit the whole pattern
  const [rowSize, setRowSize] = useState(() => readPref('strudel:roll:rows', 'm'))
  const [follow, setFollow] = useState(() => readPref('strudel:roll:follow', true))
  const [full, setFull] = useState(false)
  const [draft, setDraft] = useState(null) // notes while dragging
  const [selection, setSelection] = useState(() => new Set()) // keys of selected notes
  const [marquee, setMarquee] = useState(null) // { x0, y0, x1, y1 } in grid px while box-selecting
  const pasteAt = useRef(null) // where the next paste lands, so repeated pastes line up
  const dragRef = useRef(null)
  const panRef = useRef(null)
  const lastLen = useRef(2)
  const anchorRef = useRef(null) // keep a step under the pointer while zooming
  const rowAnchorRef = useRef(null) // … and a pitch, while zooming the rows

  const total = stepCount(pattern)
  const stepsPerBeat = Math.max(1, Math.round(pattern.stepsPerBar / beats))
  // a named size (s / m / l) or any height in px, from zooming the rows
  const rowH = typeof rowSize === 'number' ? clamp(Math.round(rowSize), MIN_ROW, MAX_ROW) : ROW_SIZES[rowSize] ?? 12
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
  useLayoutEffect(() => {
    const a = rowAnchorRef.current
    const el = scrollRef.current
    if (!a || !el) return
    el.scrollTop = a.row * rowH - a.offset
    rowAnchorRef.current = null
  }, [rowH])

  /** Set the row height, keeping the pitch `offset` px below the ruler where it is. */
  const zoomRows = useCallback((next, offset = null) => {
    const el = scrollRef.current
    if (!el) return
    const at = offset ?? (el.clientHeight - RULER_H) / 2
    rowAnchorRef.current = { row: (el.scrollTop + at) / rowH, offset: at }
    setRowSize(clamp(Math.round(next), MIN_ROW, MAX_ROW))
  }, [rowH])

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
      const sel = selection.has(keyOf(note))
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
    if (marquee) {
      const x = Math.min(marquee.x0, marquee.x1)
      const y = Math.min(marquee.y0, marquee.y1)
      ctx.fillStyle = acid
      ctx.globalAlpha = 0.08
      ctx.fillRect(x, y, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0))
      ctx.globalAlpha = 1
      ctx.setLineDash([5, 4])
      ctx.strokeStyle = acid
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0))
      ctx.setLineDash([])
    }
    drawOverview()
  }, [notes, selection, marquee, total, colW, rowH, pattern.stepsPerBar, stepsPerBeat, drawOverview])

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
      if (e.altKey && !(e.ctrlKey || e.metaKey)) {
        // alt + wheel: taller or shorter rows around the pointer
        e.preventDefault()
        const pointerY = e.clientY - el.getBoundingClientRect().top - RULER_H
        zoomRows(rowH * Math.exp(-(e.deltaY || e.deltaX) * 0.004), Math.max(0, pointerY))
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const pointerX = e.clientX - el.getBoundingClientRect().left - KEY_W
      zoomTo(colW * Math.exp(-e.deltaY * 0.004), Math.max(0, pointerX))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [colW, rowH, zoomTo, zoomRows])

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
    const at = clamp(x / colW, 0, total) // where the pointer really is, between steps
    const step = clamp(Math.floor(at), 0, total - 1)
    const midi = clamp(HIGH - Math.floor(y / rowH), LOW, HIGH)
    const note = notes.find((nt) => nt.n === midi && at >= nt.s && at < nt.s + nt.l)
    const edge = note && x >= (note.s + note.l) * colW - Math.min(7, colW / 2)
    return { x, at, step, midi, note, edge }
  }

  const commit = (next) => {
    setDraft(null)
    onChangeNotes(next)
  }

  // Panning: middle-drag anywhere in the roll (grid, ruler or keys). Alt is the grid
  // release while editing notes, so it can't pan as well.
  // It's handled on the scroll box in the capture phase so it wins over note editing, and
  // the middle button's mousedown is cancelled so the browser doesn't start its own
  // auto-scroll instead.
  const isPan = (e) => e.button === 1
  const startPan = (e) => {
    const el = scrollRef.current
    e.preventDefault()
    e.stopPropagation()
    el.setPointerCapture(e.pointerId)
    el.focus({ preventScroll: true })
    const rect = el.getBoundingClientRect()
    // ctrl/cmd + middle-drag zooms instead (as in the song view): sideways the steps, up and
    // down the rows, around where the drag started
    const zoom = e.button === 1 && (e.ctrlKey || e.metaKey)
      ? (() => {
          const dx = Math.max(0, e.clientX - rect.left - KEY_W)
          const dy = Math.max(0, e.clientY - rect.top - RULER_H)
          return { col: colW, row: rowH, dx, dy, step: (el.scrollLeft + dx) / colW, pitchRow: (el.scrollTop + dy) / rowH }
        })()
      : null
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, zoom }
    el.classList.add(zoom ? 'zooming' : 'panning')
  }
  const movePan = (e) => {
    const pan = panRef.current
    if (!pan || e.pointerId !== pan.id) return
    if (pan.zoom) {
      // anchored to the spot under the drag's start, not recomputed per move (that drifts)
      const z = pan.zoom
      anchorRef.current = { step: z.step, offset: z.dx }
      rowAnchorRef.current = { row: z.pitchRow, offset: z.dy }
      setZoom(clamp(Math.round(z.col * Math.exp((e.clientX - pan.x) * 0.006) * 10) / 10, 4, maxCol))
      setRowSize(clamp(Math.round(z.row * Math.exp((e.clientY - pan.y) * 0.006)), MIN_ROW, MAX_ROW))
      return
    }
    const el = scrollRef.current
    el.scrollLeft = pan.left - (e.clientX - pan.x)
    el.scrollTop = pan.top - (e.clientY - pan.y)
  }
  const endPan = () => {
    if (!panRef.current) return
    panRef.current = null
    scrollRef.current?.classList.remove('panning', 'zooming')
  }

  const selectedNotes = (list = channel.notes) => list.filter((nt) => selection.has(keyOf(nt)))
  const selectKeys = (list) => setSelection(new Set(list.map(keyOf)))

  // Hold alt and notes go wherever the pointer is instead of onto the step grid.
  const tick = (v) => Math.round(v / TICK) * TICK
  const leastLen = (free) => (free ? TICK : 1)
  /** Where a note being drawn or stretched should end: on the next step, or exactly here. */
  const endAt = (h, free) => (free ? tick(h.at) : Math.floor(h.at) + 1)

  /** Move a group of notes by (ds steps, dn semitones), clamped so none leaves the grid. */
  const shifted = (group, ds, dn) => {
    const minS = Math.min(...group.map((x) => x.s))
    const maxEnd = Math.max(...group.map((x) => x.s + x.l))
    const minN = Math.min(...group.map((x) => x.n))
    const maxN = Math.max(...group.map((x) => x.n))
    const s = clamp(ds, -minS, total - maxEnd)
    const n = clamp(dn, LOW - minN, HIGH - maxN)
    return { notes: group.map((x) => ({ ...x, s: x.s + s, n: x.n + n })), ds: s, dn: n }
  }

  /** Replace `removed` notes with `added` ones, keeping one note per step and pitch. */
  const merge = (base, removed, added) => {
    const gone = new Set(removed.map(keyOf))
    const kept = base.filter((x) => !gone.has(keyOf(x)))
    const incoming = new Set(added.map(keyOf))
    return [...kept.filter((x) => !incoming.has(keyOf(x))), ...added]
  }

  const onDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrollRef.current?.focus({ preventScroll: true })
    const h = hit(e)
    const mod = e.ctrlKey || e.metaKey
    if (e.button === 2) {
      const next = h.note ? notes.filter((nt) => nt !== h.note) : notes
      dragRef.current = { mode: 'erase', notes: next }
      setDraft(next)
      return
    }
    if (e.button !== 0) return

    if (!h.note && (mod || e.shiftKey)) {
      // box select (shift keeps what's already selected)
      dragRef.current = { mode: 'marquee', base: e.shiftKey ? new Set(selection) : new Set(), x0: h.x, y0: e.clientY - gridRef.current.getBoundingClientRect().top }
      setMarquee({ x0: h.x, y0: dragRef.current.y0, x1: h.x, y1: dragRef.current.y0 })
      if (!e.shiftKey) setSelection(new Set())
      return
    }

    if (h.note) {
      const key = keyOf(h.note)
      let sel = selection
      // shift: drag out a copy (as on the timeline); a shift-click without moving
      // adds the note to the selection or takes it out
      if (e.shiftKey && !sel.has(key)) sel = new Set([key])
      if (!e.shiftKey && !sel.has(key)) { sel = new Set([key]); setSelection(sel) }
      onPreview(h.note.n)
      const group = channel.notes.filter((nt) => sel.has(keyOf(nt)))
      if (h.edge) {
        dragRef.current = { mode: 'resize', group, anchor: h.note }
      } else {
        // shift or ctrl/cmd + drag moves copies and leaves the originals where they were
        dragRef.current = { mode: 'move', group, copy: mod || e.shiftKey, toggle: e.shiftKey ? key : null, grabAt: h.at, grabMidi: h.midi, moved: false }
      }
      return
    }

    const start = e.altKey ? tick(h.at) : h.step
    const created = { s: start, l: clamp(lastLen.current, leastLen(e.altKey), total - start), n: h.midi }
    onPreview(h.midi)
    setSelection(new Set([keyOf(created)]))
    dragRef.current = { mode: 'create', orig: created, base: notes }
    setDraft([...notes, created])
  }

  const onMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const h = hit(e)
    const free = e.altKey // alt: off the grid, down to a sixty-fourth of a step
    if (d.mode === 'erase') {
      if (h.note) { d.notes = d.notes.filter((nt) => nt !== h.note); setDraft(d.notes) }
    } else if (d.mode === 'marquee') {
      const y = e.clientY - gridRef.current.getBoundingClientRect().top
      const box = { x0: d.x0, y0: d.y0, x1: h.x, y1: y }
      setMarquee(box)
      const left = Math.min(box.x0, box.x1) / colW
      const right = Math.max(box.x0, box.x1) / colW
      const top = HIGH - Math.min(box.y0, box.y1) / rowH
      const bottom = HIGH - Math.max(box.y0, box.y1) / rowH
      const inside = channel.notes.filter((nt) => nt.s < right && nt.s + nt.l > left && nt.n + 1 > bottom && nt.n < top)
      setSelection(new Set([...d.base, ...inside.map(keyOf)]))
    } else if (d.mode === 'create') {
      const l = clamp(endAt(h, free) - d.orig.s, leastLen(free), total - d.orig.s)
      d.current = { ...d.orig, l }
      setDraft([...d.base, d.current])
    } else if (d.mode === 'resize') {
      const dl = endAt(h, free) - (d.anchor.s + d.anchor.l)
      d.current = d.group.map((x) => ({ ...x, l: clamp(x.l + dl, leastLen(free), total - x.s) }))
      setDraft(merge(channel.notes, d.group, d.current))
    } else if (d.mode === 'move') {
      const moveBy = h.at - d.grabAt
      const { notes: moved, ds, dn } = shifted(d.group, free ? tick(moveBy) : Math.round(moveBy), h.midi - d.grabMidi)
      if (!ds && !dn && !d.moved) return
      if (dn !== d.dn && moved[0]) onPreview(moved[0].n)
      d.moved = true
      d.dn = dn
      d.current = moved
      setDraft(merge(channel.notes, d.copy ? [] : d.group, moved))
      selectKeys(moved)
    }
  }

  const onUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.mode === 'marquee') { setMarquee(null); return }
    if (d.mode === 'erase') return commit(d.notes)
    if (d.mode === 'create') {
      const note = d.current ?? d.orig
      lastLen.current = note.l
      selectKeys([note])
      return commit([...d.base, note])
    }
    if (d.mode === 'resize' && d.current) {
      lastLen.current = Math.max(...d.current.map((x) => x.l))
      selectKeys(d.current)
      return commit(merge(channel.notes, d.group, d.current))
    }
    if (d.mode === 'move' && d.current && d.moved) {
      selectKeys(d.current)
      return commit(merge(channel.notes, d.copy ? [] : d.group, d.current))
    }
    // a shift-click that didn't move adds the note to the selection, or takes it out
    if (d.mode === 'move' && d.toggle && !d.moved) {
      setSelection((sel) => { const next = new Set(sel); next.has(d.toggle) ? next.delete(d.toggle) : next.add(d.toggle); return next })
    }
    setDraft(null)
  }

  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const done = () => { e.preventDefault(); e.stopPropagation() } // keep keys away from the patch canvas behind
    if (k === 'f' && !mod) { done(); return setFull((v) => !v) }
    if (mod && k === 'a') { done(); return selectKeys(channel.notes) }
    if (k === 'escape' && selection.size) { done(); return setSelection(new Set()) }

    const group = selectedNotes()
    if (mod && (k === 'c' || k === 'x')) {
      if (!group.length) return
      done()
      const start = Math.min(...group.map((x) => x.s))
      const span = Math.max(...group.map((x) => x.s + x.l)) - start
      clipboard = { notes: group.map((x) => ({ ...x, s: x.s - start })), span }
      pasteAt.current = start + span
      if (k === 'x') { setSelection(new Set()); onChangeNotes(merge(channel.notes, group, [])) }
      return
    }
    if (mod && (k === 'v' || k === 'd')) {
      let source = clipboard
      let at = pasteAt.current ?? 0
      if (k === 'd') {
        if (!group.length) return
        const start = Math.min(...group.map((x) => x.s))
        const span = Math.max(...group.map((x) => x.s + x.l)) - start
        source = { notes: group.map((x) => ({ ...x, s: x.s - start })), span }
        at = start + span
      }
      if (!source) return
      done()
      const placed = source.notes
        .map((x) => ({ ...x, s: x.s + at }))
        .filter((x) => x.s < total)
        .map((x) => ({ ...x, l: Math.min(x.l, total - x.s) }))
      if (!placed.length) return
      pasteAt.current = at + source.span
      selectKeys(placed)
      reveal(placed[0])
      return onChangeNotes(merge(channel.notes, [], placed))
    }

    if (!group.length) return
    if (k === 'delete' || k === 'backspace') {
      done()
      setSelection(new Set())
      return onChangeNotes(merge(channel.notes, group, []))
    }
    let ds = 0
    let dn = 0
    if (k === 'arrowup') dn = e.shiftKey ? 12 : 1
    else if (k === 'arrowdown') dn = e.shiftKey ? -12 : -1
    else if (k === 'arrowright') ds = e.shiftKey ? pattern.stepsPerBar : 1
    else if (k === 'arrowleft') ds = e.shiftKey ? -pattern.stepsPerBar : -1
    else return
    done()
    const { notes: moved } = shifted(group, ds, dn)
    if (dn && moved[0]) onPreview(moved[0].n)
    selectKeys(moved)
    reveal(moved[0])
    onChangeNotes(merge(channel.notes, group, moved))
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
    <div className={`pr ${full ? 'full' : ''} ${fill ? 'fill' : ''}`}>
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
          {selection.size > 0 && <span className="pr-selected">{selection.size} selected</span>}
          <span className="pr-hint" title="hold alt to leave the grid · ctrl/cmd + A selects all · shift + click adds, shift + drag copies · drag the ruler moves the playhead · ctrl/cmd + drag draws a box · drag moves the selection · ctrl/cmd + drag a note copies · ctrl/cmd + C / X / V / D · arrows move · delete removes · ctrl/cmd + scroll zooms · alt + scroll sizes rows · ctrl/cmd + middle-drag zooms steps and rows · middle-drag pans">{barCount} bar{barCount === 1 ? '' : 's'} · alt leaves the grid · shift+drag copies · ctrl/cmd+A all · middle-drag pans</span>
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
              title={onSeek ? 'Drag to move the playhead · alt: off the step grid · shift-click to scroll here' : 'Click a bar to jump there'}
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const at = (x) => (x - rect.left) / colW / pattern.stepsPerBar // bars into the pattern
                if (!onSeek || e.shiftKey || e.button !== 0) {
                  scrollRef.current.scrollTo({ left: Math.floor(at(e.clientX)) * pattern.stepsPerBar * colW, behavior: 'smooth' })
                  return
                }
                e.currentTarget.setPointerCapture(e.pointerId)
                seekRef.current = true
                onSeek(at(e.clientX), { fine: e.altKey })
              }}
              onPointerMove={(e) => {
                if (!seekRef.current) return
                const rect = e.currentTarget.getBoundingClientRect()
                onSeek((e.clientX - rect.left) / colW / pattern.stepsPerBar, { fine: e.altKey })
              }}
              onPointerUp={() => { seekRef.current = null }}
              onPointerCancel={() => { seekRef.current = null }}
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
                    e.currentTarget.style.cursor = h.note ? (h.edge ? 'ew-resize' : 'var(--ring)') : 'crosshair'
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
