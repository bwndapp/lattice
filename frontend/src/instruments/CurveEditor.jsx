import { useEffect, useMemo, useRef, useState } from 'react'
import './CurveEditor.css'

/**
 * A shape you draw with points, the way automation's editor works (Automation.jsx), for any
 * instrument that needs one (an LFO, an envelope, a wavetable's curve).
 *
 *   points   [{ x 0…1, y 0…1, c? -1…1 }] in order; c bends the line to the next point
 *   onChange(points) with the new list
 *   grid     columns to snap to (0: none); alt places a point off the grid
 *   bipolar  draw the middle line as zero
 *   pinEnds  the first and last points stay at x 0 and x 1
 *   dot      optional ref: the editor puts a dot at `dot.current()` → x (0…1), every frame
 *
 * Click adds a point, drag moves it, right-click or double-click removes it, and the
 * diamond between two points bends the line: drag it up or down.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const MAX_POINTS = 24

/** Where the curve is at x. */
export function curveAt(points, x) {
  if (!points.length) return 0.5
  if (x <= points[0].x) return points[0].y
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (x < b.x) {
      const u = b.x > a.x ? (x - a.x) / (b.x - a.x) : 1
      return a.y + (b.y - a.y) * (a.c ? u ** (2 ** (a.c * 3)) : u)
    }
  }
  return points[points.length - 1].y
}

export default function CurveEditor({ points, onChange, grid = 8, bipolar = true, pinEnds = true, height = 120, dot = null, className = '' }) {
  const box = useRef(null)
  const drag = useRef(null)
  const dotEl = useRef(null)
  const [width, setWidth] = useState(240)
  const [active, setActive] = useState(null)
  const [hover, setHover] = useState(null) // what's under the pointer: 'p3', 'b2' or null

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(40, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const PAD = 7
  const sx = (x) => PAD + x * (width - 2 * PAD)
  const sy = (y) => PAD + (1 - y) * (height - 2 * PAD)
  const toX = (px) => clamp((px - PAD) / (width - 2 * PAD), 0, 1)
  const toY = (py) => clamp(1 - (py - PAD) / (height - 2 * PAD), 0, 1)

  // the dot riding the curve
  useEffect(() => {
    if (!dot) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = dotEl.current
      const x = dot.current?.()
      if (!el) return
      if (x == null) { el.style.opacity = '0'; return }
      el.style.opacity = '1'
      el.style.transform = `translate(${sx(x)}px, ${sy(curveAt(points, x))}px)`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [dot, points, width, height]) // eslint-disable-line react-hooks/exhaustive-deps

  const path = useMemo(() => {
    const xs = new Set()
    for (let px = 0; px <= width; px += 2) xs.add(toX(px))
    for (const p of points) { xs.add(p.x); xs.add(Math.max(0, p.x - 1e-6)) }
    const ordered = [...xs].sort((a, b) => a - b)
    const line = ordered.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(curveAt(points, x)).toFixed(1)}`).join('')
    const base = sy(bipolar ? 0.5 : 0)
    return { line, area: `${line}L${sx(1)},${base}L${sx(0)},${base}Z` }
  }, [points, width, height, bipolar]) // eslint-disable-line react-hooks/exhaustive-deps

  const snap = (x, free) => (free || !grid ? Math.round(x * 1000) / 1000 : Math.round(x * grid) / grid)
  const local = (e) => {
    const r = box.current.getBoundingClientRect()
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }
  const edit = (fn) => {
    const next = points.map((p) => ({ ...p }))
    fn(next)
    onChange(next)
  }
  const removable = (i) => points.length > 2 && !(pinEnds && (i === 0 || i === points.length - 1))
  const remove = (i) => { if (removable(i)) edit((list) => { list.splice(i, 1) }) }

  const down = (e) => {
    const hit = e.target.closest?.('[data-point], [data-bend]')
    if (e.button === 2) {
      e.preventDefault()
      if (hit?.dataset.point !== undefined) remove(Number(hit.dataset.point))
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    box.current.setPointerCapture(e.pointerId)
    if (hit?.dataset.bend !== undefined) {
      const i = Number(hit.dataset.bend)
      drag.current = { bend: i, y: e.clientY, c: points[i].c ?? 0, falling: points[i + 1].y < points[i].y }
      return
    }
    if (hit?.dataset.point !== undefined) {
      drag.current = { point: Number(hit.dataset.point) }
      setActive(Number(hit.dataset.point))
      return
    }
    if (points.length >= MAX_POINTS) return
    // a new point where you clicked, which you're now dragging
    const { px, py } = local(e)
    const x = snap(toX(px), e.altKey)
    const y = Math.round(toY(py) * 1000) / 1000
    let at = points.findIndex((p) => p.x > x)
    if (at < 0) at = points.length
    if (pinEnds) at = clamp(at, 1, points.length - 1) // never outside the pinned ends
    edit((list) => { list.splice(at, 0, { x: clamp(x, list[at - 1]?.x ?? 0, list[at]?.x ?? 1), y }) })
    drag.current = { point: at }
    setActive(at)
  }
  const move = (e) => {
    const d = drag.current
    if (!d) {
      const hit = e.target.closest?.('[data-point], [data-bend]')
      setHover(hit ? (hit.dataset.point !== undefined ? `p${hit.dataset.point}` : `b${hit.dataset.bend}`) : null)
      return
    }
    if (d.bend !== undefined) {
      // dragging up bends the line up, whichever way it runs
      const delta = ((d.y - e.clientY) / 70) * (d.falling ? 1 : -1)
      const c = Math.round(clamp(d.c + delta, -1, 1) * 100) / 100
      edit((list) => { if (list[d.bend]) { if (Math.abs(c) < 0.03) delete list[d.bend].c; else list[d.bend].c = c } })
      return
    }
    const { px, py } = local(e)
    edit((list) => {
      const i = d.point
      const p = list[i]
      if (!p) return
      const pinned = pinEnds && (i === 0 || i === list.length - 1)
      if (!pinned) {
        const lo = i > 0 ? list[i - 1].x : 0
        const hi = i < list.length - 1 ? list[i + 1].x : 1
        p.x = clamp(snap(toX(px), e.altKey), lo, hi)
      }
      p.y = Math.round(toY(py) * 1000) / 1000
    })
  }
  const up = () => { drag.current = null; setActive(null) }

  const cols = grid || 4
  return (
    <div
      className={`curve-editor ${className}`}
      ref={box}
      style={{ height }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => { if (!drag.current) setHover(null) }}
      onDoubleClick={(e) => { const hit = e.target.closest?.('[data-point]'); if (hit) remove(Number(hit.dataset.point)) }}
      onContextMenu={(e) => e.preventDefault()}
      title="Click to add a point · drag to move · right-click or double-click to remove · drag a diamond to bend · alt: off the grid"
    >
      <svg width={width} height={height} aria-hidden>
        {Array.from({ length: cols + 1 }, (_, i) => (
          <line key={`v${i}`} x1={sx(i / cols)} x2={sx(i / cols)} y1={PAD} y2={height - PAD} className={`ce-grid ${i === 0 || i === cols ? 'edge' : i % 2 === 0 ? 'major' : ''}`} />
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((y) => (
          <line key={`h${y}`} x1={PAD} x2={width - PAD} y1={sy(y)} y2={sy(y)} className={`ce-grid ${y === 0 || y === 1 ? 'edge' : bipolar && y === 0.5 ? 'zero' : ''}`} />
        ))}
        <path d={path.area} className="ce-area" />
        <path d={path.line} className="ce-line" />
        {points.slice(0, -1).map((p, i) => {
          const q = points[i + 1]
          if (q.x - p.x < 1e-6 || Math.abs(q.y - p.y) < 1e-4) return null
          const mx = (p.x + q.x) / 2
          const my = curveAt(points, mx)
          return (
            <g key={`b${i}`} data-bend={i} className={`ce-bend ${p.c ? 'bent' : ''} ${hover === `b${i}` || drag.current?.bend === i ? 'hot' : ''}`}>
              <circle cx={sx(mx)} cy={sy(my)} r="9" className="ce-hit" />
              <rect x={sx(mx) - 3.5} y={sy(my) - 3.5} width="7" height="7" transform={`rotate(45 ${sx(mx)} ${sy(my)})`} />
            </g>
          )
        })}
        {points.map((p, i) => (
          <g key={`p${i}`} data-point={i} className={`ce-point ${active === i ? 'active' : ''} ${hover === `p${i}` ? 'hot' : ''}`}>
            <circle cx={sx(p.x)} cy={sy(p.y)} r="10" className="ce-hit" />
            <circle cx={sx(p.x)} cy={sy(p.y)} r={active === i ? 5.5 : 4.5} className="ce-knob" />
          </g>
        ))}
      </svg>
      {dot && <span className="ce-dot" ref={dotEl} aria-hidden />}
      {active !== null && points[active] && (
        <span className="ce-readout">{Math.round(points[active].x * 100)}% · {bipolar ? `${points[active].y >= 0.5 ? '+' : ''}${Math.round((points[active].y * 2 - 1) * 100)}` : Math.round(points[active].y * 100)}</span>
      )}
    </div>
  )
}
