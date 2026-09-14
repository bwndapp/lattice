import { useCallback, useEffect, useRef, useState } from 'react'
import { isBlackKey, midiToNote, noteToMidi, stepCount } from './project'

const KEY_W = 46
const ROW_H = 12
const LOW = 24 // c1
const HIGH = 96 // c7
const ROWS = HIGH - LOW + 1

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const same = (a, b) => a && b && a.s === b.s && a.n === b.n

/**
 * Piano roll for a synth channel. Click to add a note (drag right to set its length),
 * drag a note to move it, drag its right edge to resize, right-click to delete. Notes
 * can overlap for chords. Arrow keys nudge the selected note, Delete removes it.
 */
export default function PianoRoll({ channel, pattern, beats, onChangeNotes, onPreview, cursorRef }) {
  const scrollRef = useRef(null)
  const gridRef = useRef(null)
  const keysRef = useRef(null)
  const lineRef = useRef(null)
  const [width, setWidth] = useState(600)
  const [draft, setDraft] = useState(null) // notes while dragging
  const [selected, setSelected] = useState(null)
  const dragRef = useRef(null)
  const lastLen = useRef(2)

  const total = stepCount(pattern)
  const stepsPerBeat = Math.max(1, Math.round(pattern.stepsPerBar / beats))
  const colW = Math.max(16, Math.floor((width - KEY_W) / total))
  const notes = draft ?? channel.notes

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    // start scrolled to where the notes are (or the channel's note)
    const pitches = channel.notes.map((x) => x.n)
    const centre = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : noteToMidi(channel.note)
    el.scrollTop = clamp((HIGH - centre) * ROW_H - el.clientHeight / 2, 0, ROWS * ROW_H)
    return () => observer.disconnect()
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const draw = useCallback(() => {
    const css = getComputedStyle(document.documentElement)
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback
    const acid = color('--acid', '#e4ff1a')
    const paper = color('--paper', '#f2f0e6')
    const line = color('--line', '#2e2e2a')
    const muted = color('--muted', '#a3a39a')
    const dpr = window.devicePixelRatio || 1

    const fit = (canvas, w, h) => {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return ctx
    }

    const keys = keysRef.current
    if (keys) {
      const ctx = fit(keys, KEY_W, ROWS * ROW_H)
      for (let r = 0; r < ROWS; r++) {
        const midi = HIGH - r
        const black = isBlackKey(midi)
        ctx.fillStyle = black ? '#111' : '#d9d6ca'
        ctx.fillRect(0, r * ROW_H, black ? KEY_W * 0.62 : KEY_W, ROW_H - 1)
        if (black) { ctx.fillStyle = '#d9d6ca'; ctx.fillRect(KEY_W * 0.62, r * ROW_H, KEY_W * 0.38, ROW_H - 1) }
        if (midi % 12 === 0) {
          ctx.fillStyle = '#000'
          ctx.font = '9px "Martian Mono", ui-monospace, monospace'
          ctx.textBaseline = 'middle'
          ctx.fillText(midiToNote(midi), KEY_W - 22, r * ROW_H + ROW_H / 2)
        }
      }
    }

    const grid = gridRef.current
    if (!grid) return
    const w = total * colW
    const h = ROWS * ROW_H
    const ctx = fit(grid, w, h)
    for (let r = 0; r < ROWS; r++) {
      const midi = HIGH - r
      ctx.fillStyle = isBlackKey(midi) ? '#070707' : '#111110'
      ctx.fillRect(0, r * ROW_H, w, ROW_H)
      if (midi % 12 === 0) { ctx.fillStyle = line; ctx.fillRect(0, (r + 1) * ROW_H - 1, w, 1) }
    }
    for (let i = 0; i <= total; i++) {
      const bar = i % pattern.stepsPerBar === 0
      const beat = i % stepsPerBeat === 0
      ctx.fillStyle = bar ? muted : line
      ctx.globalAlpha = bar ? 0.8 : beat ? 0.9 : 0.35
      ctx.fillRect(i * colW, 0, bar ? 2 : 1, h)
    }
    ctx.globalAlpha = 1
    for (const note of notes) {
      const x = note.s * colW + 1
      const y = (HIGH - note.n) * ROW_H + 1
      const nw = note.l * colW - 2
      const sel = same(note, selected)
      ctx.fillStyle = sel ? paper : acid
      ctx.fillRect(x, y, nw, ROW_H - 2)
      ctx.fillStyle = '#000'
      ctx.globalAlpha = 0.45
      ctx.fillRect(x + nw - 3, y + 2, 2, ROW_H - 6) // resize grip
      ctx.globalAlpha = 1
      if (nw > 30) {
        ctx.font = '8px "Martian Mono", ui-monospace, monospace'
        ctx.textBaseline = 'middle'
        ctx.fillText(midiToNote(note.n), x + 3, y + (ROW_H - 2) / 2)
      }
    }
  }, [notes, selected, total, colW, pattern.stepsPerBar, stepsPerBeat])

  useEffect(() => { draw() }, [draw])

  // playback cursor
  useEffect(() => {
    let frame
    const tick = () => {
      const step = cursorRef?.current?.() ?? -1
      if (lineRef.current) {
        lineRef.current.hidden = step < 0
        lineRef.current.style.transform = `translateX(${step * colW}px)`
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [cursorRef, colW])

  const hit = (e) => {
    const rect = gridRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const step = clamp(Math.floor(x / colW), 0, total - 1)
    const midi = clamp(HIGH - Math.floor(y / ROW_H), LOW, HIGH)
    const note = notes.find((nt) => nt.n === midi && step >= nt.s && step < nt.s + nt.l)
    const edge = note && x >= (note.s + note.l) * colW - 7
    return { x, step, midi, note, edge }
  }

  const commit = (next) => {
    setDraft(null)
    onChangeNotes(next)
  }

  const onDown = (e) => {
    const h = hit(e)
    e.currentTarget.setPointerCapture(e.pointerId)
    scrollRef.current?.focus({ preventScroll: true })
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
    const base = d.base ?? channel.notes
    if (d.mode === 'erase') {
      if (h.note) { d.notes = d.notes.filter((nt) => nt !== h.note); setDraft(d.notes) }
    } else if (d.mode === 'create' || d.mode === 'resize') {
      const l = clamp(h.step - d.orig.s + 1, 1, total - d.orig.s)
      const updated = { ...d.orig, l }
      const next = (d.mode === 'create' ? base : channel.notes).map((nt) => (nt === d.orig ? updated : nt))
      if (d.mode === 'create') next[next.length - 1] = updated
      d.current = updated
      setSelected(updated)
      setDraft(d.mode === 'create' ? [...base, updated] : next)
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
    else if (e.key === 'ArrowRight') updated = { ...note, s: clamp(note.s + 1, 0, total - note.l) }
    else if (e.key === 'ArrowLeft') updated = { ...note, s: clamp(note.s - 1, 0, total - note.l) }
    else return
    e.preventDefault()
    if (updated.n !== note.n) onPreview(updated.n)
    setSelected(updated)
    onChangeNotes(channel.notes.map((nt, i) => (i === idx ? updated : nt)))
  }

  return (
    <div className="piano-roll" ref={scrollRef} tabIndex={0} onKeyDown={onKey} aria-label={`${channel.name} piano roll: click to add notes, drag to move, right-click to delete`}>
      <div className="pr-inner" style={{ width: KEY_W + total * colW }}>
        <canvas
          className="pr-keys"
          ref={keysRef}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            onPreview(clamp(HIGH - Math.floor((e.clientY - rect.top) / ROW_H), LOW, HIGH))
          }}
        />
        <div className="pr-grid-wrap">
          <canvas
            className="pr-grid"
            ref={gridRef}
            onPointerDown={onDown}
            onPointerMove={(e) => {
              onMove(e)
              if (!dragRef.current) {
                const h = hit(e)
                e.currentTarget.style.cursor = h.note ? (h.edge ? 'ew-resize' : 'grab') : 'crosshair'
              }
            }}
            onPointerUp={onUp}
            onPointerCancel={() => { dragRef.current = null; setDraft(null) }}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div className="pr-cursor" ref={lineRef} hidden style={{ width: colW }} />
        </div>
      </div>
    </div>
  )
}
