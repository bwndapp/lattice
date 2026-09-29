import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AUTO_PREFIX, addPoint, autoName, curveAt, fromPos, movePoints, removePoints, resolveTarget, toPos } from './automation.js'
import { formatValue } from './Knob.jsx'
import { NameInput } from './NameInput.jsx'
import './Automation.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ── the automation editor ─────────────────────────────────────────────────────
const GRAPH_H = 220
const GUTTER = 52 // room for the value labels on the left
const PAD_Y = 12
const LENGTHS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64]
const HIT = 10 // px around a point or a bend handle that still grabs it
const NUDGE = 3 // px a press has to travel before it moves anything

/**
 * A floating window for one automation: its curve over its length, points to drag.
 * The mouse works as in the piano roll: click adds a point and drag places it, drag a
 * point to move it (and every selected point with it), right-click or right-drag across
 * points deletes them, shift + click adds a point to the selection, ctrl/cmd or shift +
 * drag on bare grid draws a selection box, and shift or ctrl/cmd + drag moves copies.
 * Delete removes the selection, arrows nudge it, ctrl/cmd + A selects all. The diamond
 * between two points bends the line (right-click it: straight again). Points snap to
 * 16ths of a bar; hold alt to place them freely. Each gesture is one undo step.
 */
export function AutomationEditor({ project, autoId, anchor, beats = 4, onUpdateProject, onRemove, onShowTimeline, onClose }) {
  const ref = useRef(null)
  const graphRef = useRef(null)
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const moveRef = useRef(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState(null) // { x, y } in automation space, for the readout
  const [draft, setDraft] = useState(null) // the points while a gesture is under way; saved when it ends
  const [selection, setSelection] = useState(() => new Set()) // indices of selected points
  const [hot, setHot] = useState(null) // what's under the pointer: { point } or { bend }
  const [marquee, setMarquee] = useState(null) // { x0, y0, x1, y1 } in graph px while box-selecting
  const selRef = useRef(selection)
  selRef.current = selection
  const auto = project.song?.autos?.find((a) => a.id === autoId)
  const found = auto && resolveTarget(project, auto.target)
  const [pos, setPos] = useState(() => ({
    left: clamp((anchor?.x ?? window.innerWidth / 2) - 80, 12, Math.max(12, window.innerWidth - 720)),
    top: clamp((anchor?.y ?? 160) + 18, 12, Math.max(12, window.innerHeight - 380)),
  }))

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.target.closest?.('input, select, textarea')) return
      e.preventDefault() // the Esc is ours, not the dock's: it lets the selection go, then closes
      if (selRef.current.size) setSelection(new Set())
      else onClose()
    }
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('.knob-menu')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown) }
  }, [onClose])

  // the whole window on screen: when it opens, and when the browser window shrinks
  useLayoutEffect(() => {
    const fit = () => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      setPos((p) => {
        const left = clamp(p.left, 8, Math.max(8, window.innerWidth - r.width - 8))
        const top = clamp(p.top, 8, Math.max(8, window.innerHeight - r.height - 8))
        return left === p.left && top === p.top ? p : { left, top }
      })
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [!!auto]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = graphRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!auto])

  const clips = project.song?.clips.filter((c) => c.src === `${AUTO_PREFIX}${autoId}`).length ?? 0
  const bars = auto?.bars ?? 4
  const plotW = width - GUTTER - 10
  const sx = (x) => GUTTER + (x / bars) * plotW
  const sy = (y) => PAD_Y + (1 - y) * (GRAPH_H - 2 * PAD_Y)
  const toX = (px) => clamp(((px - GUTTER) / plotW) * bars, 0, bars)
  const toY = (py) => clamp(1 - (py - PAD_Y) / (GRAPH_H - 2 * PAD_Y), 0, 1)

  // the curve as a path, sampled every few pixels (straight lines are exact at the points anyway)
  const shown = auto && draft ? { ...auto, points: draft } : auto
  const path = useMemo(() => {
    const auto = shown
    if (!auto) return { line: '', area: '' }
    const xs = new Set()
    for (let px = 0; px <= plotW; px += 3) xs.add((px / plotW) * bars)
    for (const p of auto.points) { xs.add(p.x); xs.add(Math.max(0, p.x - 1e-6)) }
    xs.add(bars)
    const ordered = [...xs].filter((x) => x >= 0 && x <= bars).sort((a, b) => a - b)
    const pts = ordered.map((x) => `${sx(x).toFixed(1)},${sy(curveAt(auto, x)).toFixed(1)}`)
    return { line: `M${pts.join('L')}`, area: `M${sx(0)},${sy(0)}L${pts.join('L')}L${sx(bars)},${sy(0)}Z` }
  }, [shown, plotW, bars]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!auto) return null

  const update = (fn) => onUpdateProject((p) => {
    const a = p.song?.autos?.find((x) => x.id === autoId)
    if (a) fn(a)
  })
  const snapX = (x, free) => (free ? Math.round(x * 256) / 256 : Math.round(x * beats * 4) / (beats * 4))
  const local = (e) => {
    const r = svgRef.current.getBoundingClientRect() // the svg, not the padded box around it
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }

  const points = shown.points
  const selected = [...selection].filter((i) => i < points.length)
  const travel = GRAPH_H - 2 * PAD_Y
  const commit = (next) => { setDraft(null); update((a) => { a.points = next }) }
  // the bend handles: halfway along each segment that has somewhere to bend
  const bends = points.slice(0, -1).flatMap((p, i) => {
    const q = points[i + 1]
    if (q.x - p.x < 1e-6 || Math.abs(q.y - p.y) < 1e-4) return []
    const mx = (p.x + q.x) / 2
    return [{ i, px: sx(mx), py: sy(curveAt(shown, mx)), bent: !!p.c }]
  })
  /** The point (nearest, within HIT px) or bend handle at a spot in the graph. */
  const hitAt = (px, py, list = points, skip) => {
    let best = null
    let dist = HIT
    list.forEach((p, i) => {
      if (skip?.has(i)) return
      const d = Math.hypot(sx(p.x) - px, sy(p.y) - py)
      if (d <= dist) { best = i; dist = d }
    })
    if (best !== null) return { point: best }
    const b = list === points && bends.find((h) => Math.hypot(h.px - px, h.py - py) <= HIT - 2)
    return b ? { bend: b.i } : {}
  }

  const onGraphDown = (e) => {
    if (e.button !== 0 && e.button !== 2) return
    e.preventDefault()
    graphRef.current.setPointerCapture(e.pointerId)
    graphRef.current.focus({ preventScroll: true })
    const { px, py } = local(e)
    const h = hitAt(px, py)
    const mod = e.ctrlKey || e.metaKey
    if (e.button === 2) {
      // right-click a bend: straight again; right-click or right-drag across points: gone
      if (h.bend !== undefined) {
        if (points[h.bend].c) commit(points.map((p, i) => { if (i !== h.bend) return p; const { c, ...rest } = p; return rest })) // eslint-disable-line no-unused-vars
        return
      }
      const gone = new Set(h.point !== undefined ? [h.point] : [])
      dragRef.current = { mode: 'erase', gone }
      setDraft(removePoints(points, [...gone]))
      return
    }
    if (h.bend !== undefined) {
      const [p0, p1] = [points[h.bend], points[h.bend + 1]]
      dragRef.current = { mode: 'bend', i: h.bend, y: e.clientY, c: p0.c ?? 0, down: p1.y < p0.y }
      return
    }
    if (h.point === undefined && (mod || e.shiftKey)) {
      // box select (shift keeps what's already selected)
      dragRef.current = { mode: 'marquee', base: e.shiftKey ? new Set(selected) : new Set(), x0: px, y0: py }
      setMarquee({ x0: px, y0: py, x1: px, y1: py })
      if (!e.shiftKey) setSelection(new Set())
      return
    }
    if (h.point !== undefined) {
      const i = h.point
      let sel = selection
      // shift: drag out a copy; a shift-click without moving adds the point to the
      // selection or takes it out (as in the piano roll)
      if (e.shiftKey && !sel.has(i)) sel = new Set([i])
      if (!e.shiftKey && !sel.has(i)) { sel = new Set([i]); setSelection(sel) }
      const group = [...sel].filter((j) => j < points.length)
      dragRef.current = { mode: 'move', base: points, group, grab: i, copy: mod || e.shiftKey, toggle: e.shiftKey ? i : null, px, py }
      return
    }
    // a new point where you clicked, which you're now dragging
    const { points: next, index } = addPoint(points, snapX(toX(px), e.altKey), toY(py))
    setSelection(new Set([index]))
    setDraft(next)
    dragRef.current = { mode: 'move', base: next, group: [index], grab: index, created: true, px, py }
  }
  const onGraphMove = (e) => {
    const { px, py } = local(e)
    setHover({ x: toX(px), y: toY(py) })
    const d = dragRef.current
    if (!d) {
      const h = hitAt(px, py)
      setHot(h.point !== undefined || h.bend !== undefined ? h : null)
      return
    }
    if (d.mode === 'erase') {
      const h = hitAt(px, py, auto.points, d.gone)
      if (h.point !== undefined) { d.gone.add(h.point); setDraft(removePoints(auto.points, [...d.gone])) }
    } else if (d.mode === 'marquee') {
      const box = { x0: d.x0, y0: d.y0, x1: px, y1: py }
      setMarquee(box)
      const [l, r] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)]
      const [t, b] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)]
      const inside = points.flatMap((p, i) => (sx(p.x) >= l && sx(p.x) <= r && sy(p.y) >= t && sy(p.y) <= b ? [i] : []))
      setSelection(new Set([...d.base, ...inside]))
    } else if (d.mode === 'bend') {
      // drag up bends the line up, whichever way it goes
      const delta = ((d.y - e.clientY) / 90) * (d.down ? 1 : -1)
      const c = Math.round(clamp(d.c + delta, -1, 1) * 100) / 100
      setDraft(auto.points.map((p, i) => {
        if (i !== d.i) return p
        const { c: _, ...rest } = p // eslint-disable-line no-unused-vars
        return Math.abs(c) < 0.03 ? rest : { ...rest, c }
      }))
    } else if (d.mode === 'move') {
      if (!d.moved && Math.hypot(px - d.px, py - d.py) < NUDGE) return
      d.moved = true
      // the grabbed point lands on the grid (alt: anywhere); the rest keep their distance
      const from = d.base[d.grab]
      const dx = snapX(clamp(from.x + ((px - d.px) / plotW) * bars, 0, bars), e.altKey) - from.x
      const dy = -(py - d.py) / travel
      d.current = movePoints(d.base, d.group, dx, dy, bars, d.copy)
      setDraft(d.current.points)
      setSelection(new Set(d.current.indices))
    }
  }
  const onGraphUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.mode === 'marquee') { setMarquee(null); return }
    if (d.mode === 'erase') {
      // a right-press that rubbed nothing out is a press on bare grid: let the selection go
      setSelection(new Set())
      if (!d.gone.size) { setDraft(null); return }
      return commit(removePoints(auto.points, [...d.gone]))
    }
    if (d.mode === 'bend') return draft ? commit(draft) : undefined
    if (d.current) return commit(d.current.points)
    if (d.created) return commit(d.base)
    // a shift-click that didn't move adds the point to the selection, or takes it out
    if (d.toggle !== null && d.toggle !== undefined) {
      setSelection((sel) => { const next = new Set(sel); next.has(d.toggle) ? next.delete(d.toggle) : next.add(d.toggle); return next })
    }
    setDraft(null)
  }

  const onGraphKey = (e) => {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const done = () => { e.preventDefault(); e.stopPropagation() } // keep keys away from the canvas behind
    if (dragRef.current) return
    if (mod && k === 'a') { done(); return setSelection(new Set(points.map((_, i) => i))) }
    if (!selected.length) return
    if (k === 'delete' || k === 'backspace') {
      done()
      setSelection(new Set())
      return commit(removePoints(points, selected))
    }
    const step = 1 / (beats * 4)
    let dx = 0
    let dy = 0
    if (k === 'arrowright') dx = e.shiftKey ? 1 : step
    else if (k === 'arrowleft') dx = e.shiftKey ? -1 : -step
    else if (k === 'arrowup') dy = e.shiftKey ? 0.1 : 0.01
    else if (k === 'arrowdown') dy = e.shiftKey ? -0.1 : -0.01
    else return
    done()
    const moved = movePoints(points, selected, dx, dy, bars)
    setSelection(new Set(moved.indices))
    commit(moved.points)
  }

  const startMove = (e) => {
    if (e.button !== 0 || e.target.closest('input, select, button, textarea')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    moveRef.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top }
  }
  const onMove = (e) => {
    const m = moveRef.current
    if (!m) return
    setPos({ left: clamp(m.left + e.clientX - m.x, -400, window.innerWidth - 120), top: clamp(m.top + e.clientY - m.y, 0, window.innerHeight - 60) })
  }

  const def = found?.def
  const show = (y) => (def ? formatValue(fromPos(y, def), def) : `${Math.round(y * 100)}%`)
  // while dragging, the moved point nearest the pointer is the one read out, beside it
  const d = dragRef.current
  const moving = d?.mode === 'move' && d.current?.indices.length && hover
    ? d.current.indices.reduce((a, b) => (Math.abs(points[b].x - hover.x) < Math.abs(points[a].x - hover.x) ? b : a))
    : null
  const readout = moving !== null ? points[moving] : hot?.point !== undefined && points[hot.point] ? points[hot.point] : hover
  const barLabel = (x) => {
    const bar = Math.floor(x + 1e-9)
    const beat = Math.floor((x - bar) * beats + 1e-9)
    return `${bar + 1}.${beat + 1}`
  }
  const beatLines = []
  for (let b = 0; b <= bars * beats; b++) beatLines.push(b)
  const now = def ? toPos(found.value, def) : null

  return (
    <div className="auto-pop" ref={ref} role="dialog" aria-label={`Automation: ${autoName(project, auto)}`} style={{ left: pos.left, top: pos.top }}>
      <div className="auto-head" onPointerDown={startMove} onPointerMove={onMove} onPointerUp={() => { moveRef.current = null }} onPointerCancel={() => { moveRef.current = null }}>
        <span className="auto-kind">automation</span>
        <NameInput className="pop-name auto-name" value={autoName(project, auto)} maxLength={40} aria-label="Automation name" onCommit={(v) => update((a) => { a.name = v })} />
        <span className="auto-target" title="The knob this curve moves">
          {found ? <>moves <b>{found.owner}</b> · {found.label}</> : <span className="auto-gone">its knob was deleted</span>}
        </span>
        <span className="spacer" />
        <label className="auto-field">
          <span>length</span>
          <select className="select" value={LENGTHS.includes(bars) ? bars : ''} onChange={(e) => {
            const next = Number(e.target.value)
            // points past the new end are dropped, keeping at least the first
            update((a) => { a.bars = next; a.points = a.points.filter((p, i) => i === 0 || p.x <= next) })
          }} aria-label="Length in bars">
            {!LENGTHS.includes(bars) && <option value="">{bars}</option>}
            {LENGTHS.map((b) => <option key={b} value={b}>{b} bar{b === 1 ? '' : 's'}</option>)}
          </select>
        </label>
        <button type="button" className="btn ghost" onClick={onClose} aria-label="Close">close</button>
      </div>

      <div
        className="auto-graph"
        ref={graphRef}
        tabIndex={0}
        style={{ cursor: d?.mode === 'move' ? 'grabbing' : d?.mode === 'bend' || hot?.bend !== undefined ? 'ns-resize' : hot?.point !== undefined ? 'grab' : undefined }}
        onKeyDown={onGraphKey}
        onPointerDown={onGraphDown}
        onPointerMove={onGraphMove}
        onPointerUp={onGraphUp}
        onPointerCancel={onGraphUp}
        onPointerLeave={() => { if (!dragRef.current) { setHover(null); setHot(null) } }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg ref={svgRef} width={width} height={GRAPH_H} aria-hidden>
          {[0, 0.25, 0.5, 0.75, 1].map((y) => (
            <g key={y}>
              <line x1={GUTTER} x2={GUTTER + plotW} y1={sy(y)} y2={sy(y)} className={`auto-grid ${y === 0 || y === 1 ? 'edge' : ''}`} />
              {(y === 0 || y === 0.5 || y === 1) && <text x={GUTTER - 8} y={sy(y) + 3} className="auto-axis" textAnchor="end">{show(y)}</text>}
            </g>
          ))}
          {beatLines.map((b) => (
            <line key={b} x1={sx(b / beats)} x2={sx(b / beats)} y1={PAD_Y} y2={GRAPH_H - PAD_Y} className={`auto-grid ${b % beats === 0 ? 'bar' : ''}`} />
          ))}
          {Array.from({ length: bars }, (_, b) => (plotW / bars > 26 || b % Math.ceil(26 / (plotW / bars)) === 0) && (
            <text key={b} x={sx(b) + 4} y={GRAPH_H - 2} className="auto-axis">{b + 1}</text>
          ))}
          {now !== null && <line x1={GUTTER} x2={GUTTER + plotW} y1={sy(now)} y2={sy(now)} className="auto-now" />}
          <path d={path.area} className="auto-area" />
          <path d={path.line} className="auto-line" />
          {bends.map((b) => (
            <rect key={`b${b.i}`} x={b.px - 5} y={b.py - 5} width="10" height="10" className={`auto-bend ${b.bent ? 'bent' : ''} ${hot?.bend === b.i || d?.mode === 'bend' && d.i === b.i ? 'hot' : ''}`} transform={`rotate(45 ${b.px} ${b.py})`} />
          ))}
          {points.map((p, i) => (
            <circle key={`p${i}`} cx={sx(p.x)} cy={sy(p.y)} r={hot?.point === i || moving === i ? 7 : 5.5} className={`auto-point ${selection.has(i) ? 'selected' : ''}`} />
          ))}
          {marquee && (
            <rect className="auto-marquee" x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)} width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)} />
          )}
        </svg>
        {readout && (
          <span className="auto-readout">bar {barLabel(readout.x)} · {show(readout.y)}</span>
        )}
        {moving !== null && (
          <span className="auto-tip" style={{ left: sx(points[moving].x), top: sy(points[moving].y) }}>{show(points[moving].y)}</span>
        )}
      </div>

      <div className="auto-foot">
        <span className="auto-hint">click adds · drag moves · right-drag deletes · shift-click or ctrl-drag selects · drag a diamond to bend · alt: off grid</span>
        <span className="spacer" />
        <span className="auto-meta">{clips ? `${clips} clip${clips === 1 ? '' : 's'} on the timeline` : 'not on the timeline yet'}</span>
        {onShowTimeline && <button type="button" className="btn" onClick={onShowTimeline}>show timeline</button>}
        <button type="button" className="btn ghost danger" onClick={onRemove} title="Delete the automation and its clips (ctrl/cmd + Z brings it back)">remove</button>
      </div>
    </div>
  )
}
