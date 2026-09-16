import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AUTO_PREFIX, autoName, curveAt, fromPos, resolveTarget, toPos } from './automation.js'
import { formatValue } from './Knob.jsx'
import { NameInput } from './NameInput.jsx'
import './Automation.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ── the automation editor ─────────────────────────────────────────────────────
const GRAPH_H = 220
const GUTTER = 52 // room for the value labels on the left
const PAD_Y = 12
const LENGTHS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64]

/**
 * A floating window for one automation: its curve over its length, points to drag.
 * Click adds a point, drag moves it, right-click removes it, the small handle between two
 * points bends the line. Points snap to 16ths of a bar; hold alt to place them freely.
 */
export function AutomationEditor({ project, autoId, anchor, beats = 4, onUpdateProject, onRemove, onShowTimeline, onClose }) {
  const ref = useRef(null)
  const graphRef = useRef(null)
  const dragRef = useRef(null)
  const moveRef = useRef(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState(null) // { x, y } in automation space, for the readout
  const [active, setActive] = useState(null) // index of the point being dragged / hovered
  const auto = project.song?.autos?.find((a) => a.id === autoId)
  const found = auto && resolveTarget(project, auto.target)
  const [pos, setPos] = useState(() => ({
    left: clamp((anchor?.x ?? window.innerWidth / 2) - 80, 12, Math.max(12, window.innerWidth - 720)),
    top: clamp((anchor?.y ?? 160) + 18, 12, Math.max(12, window.innerHeight - 380)),
  }))

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('input, select, textarea')) { e.preventDefault(); onClose() } } // the Esc is ours, not the dock's
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('.knob-menu')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown) }
  }, [onClose])

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
  const path = useMemo(() => {
    if (!auto) return { line: '', area: '' }
    const xs = new Set()
    for (let px = 0; px <= plotW; px += 3) xs.add((px / plotW) * bars)
    for (const p of auto.points) { xs.add(p.x); xs.add(Math.max(0, p.x - 1e-6)) }
    xs.add(bars)
    const ordered = [...xs].filter((x) => x >= 0 && x <= bars).sort((a, b) => a - b)
    const pts = ordered.map((x) => `${sx(x).toFixed(1)},${sy(curveAt(auto, x)).toFixed(1)}`)
    return { line: `M${pts.join('L')}`, area: `M${sx(0)},${sy(0)}L${pts.join('L')}L${sx(bars)},${sy(0)}Z` }
  }, [auto, plotW, bars]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!auto) return null

  const update = (fn) => onUpdateProject((p) => {
    const a = p.song?.autos?.find((x) => x.id === autoId)
    if (a) fn(a)
  })
  const snapX = (x, free) => (free ? Math.round(x * 256) / 256 : Math.round(x * beats * 4) / (beats * 4))
  const local = (e) => {
    const r = graphRef.current.getBoundingClientRect()
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }

  const onGraphDown = (e) => {
    const { px, py } = local(e)
    const hit = e.target.closest?.('[data-point], [data-bend]')
    if (e.button === 2) {
      e.preventDefault()
      const i = hit?.dataset.point
      if (i !== undefined && auto.points.length > 1) update((a) => { a.points.splice(Number(i), 1) })
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    graphRef.current.setPointerCapture(e.pointerId)
    if (hit?.dataset.bend !== undefined) {
      const i = Number(hit.dataset.bend)
      const [p0, p1] = [auto.points[i], auto.points[i + 1]]
      dragRef.current = { bend: i, y: e.clientY, c: p0.c ?? 0, down: p1.y < p0.y }
      setActive(null)
      return
    }
    if (hit?.dataset.point !== undefined) {
      dragRef.current = { point: Number(hit.dataset.point) }
      setActive(Number(hit.dataset.point))
      return
    }
    // a new point where you clicked, which you're now dragging
    const x = snapX(toX(px), e.altKey)
    const y = toY(py)
    let at = auto.points.findIndex((p) => p.x > x)
    if (at < 0) at = auto.points.length
    update((a) => { a.points.splice(at, 0, { x, y }) })
    dragRef.current = { point: at }
    setActive(at)
  }
  const onGraphMove = (e) => {
    const { px, py } = local(e)
    setHover({ x: toX(px), y: toY(py) })
    const d = dragRef.current
    if (!d) return
    if (d.bend !== undefined) {
      // drag up bends the line up, whichever way it goes
      const delta = ((d.y - e.clientY) / 90) * (d.down ? 1 : -1)
      const c = Math.round(clamp(d.c + delta, -1, 1) * 100) / 100
      update((a) => { if (a.points[d.bend]) { if (Math.abs(c) < 0.03) delete a.points[d.bend].c; else a.points[d.bend].c = c } })
      return
    }
    const i = d.point
    update((a) => {
      const p = a.points[i]
      if (!p) return
      const lo = i > 0 ? a.points[i - 1].x : 0
      const hi = i < a.points.length - 1 ? a.points[i + 1].x : bars
      p.x = clamp(snapX(toX(px), e.altKey), lo, hi)
      p.y = Math.round(toY(py) * 10000) / 10000
    })
  }
  const onGraphUp = () => { dragRef.current = null; setActive(null) }

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
  const readout = active !== null && auto.points[active]
    ? auto.points[active]
    : hover
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
        onPointerDown={onGraphDown}
        onPointerMove={onGraphMove}
        onPointerUp={onGraphUp}
        onPointerCancel={onGraphUp}
        onPointerLeave={() => { if (!dragRef.current) setHover(null) }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg width={width} height={GRAPH_H} aria-hidden>
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
          {auto.points.slice(0, -1).map((p, i) => {
            const q = auto.points[i + 1]
            if (q.x - p.x < 1e-6 || Math.abs(q.y - p.y) < 1e-4) return null
            const mx = (p.x + q.x) / 2
            return <rect key={`b${i}`} data-bend={i} x={sx(mx) - 4} y={sy(curveAt(auto, mx)) - 4} width="8" height="8" className={`auto-bend ${p.c ? 'bent' : ''}`} transform={`rotate(45 ${sx(mx)} ${sy(curveAt(auto, mx))})`} />
          })}
          {auto.points.map((p, i) => (
            <circle key={`p${i}`} data-point={i} cx={sx(p.x)} cy={sy(p.y)} r={active === i ? 6.5 : 5} className={`auto-point ${active === i ? 'active' : ''}`} />
          ))}
        </svg>
        {readout && (
          <span className="auto-readout">bar {barLabel(readout.x)} · {show(readout.y)}</span>
        )}
      </div>

      <div className="auto-foot">
        <span className="auto-hint">click adds a point · drag moves it · right-click removes it · drag a diamond to bend · alt: off the grid</span>
        <span className="spacer" />
        <span className="auto-meta">{clips ? `${clips} clip${clips === 1 ? '' : 's'} on the timeline` : 'not on the timeline yet'}</span>
        {onShowTimeline && <button type="button" className="btn" onClick={onShowTimeline}>show timeline</button>}
        <button type="button" className="btn ghost danger" onClick={onRemove} title="Delete the automation and its clips (ctrl/cmd + Z brings it back)">remove</button>
      </div>
    </div>
  )
}
