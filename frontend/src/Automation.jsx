import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AUTO_PREFIX, CYCLING, SEGMENT_MODES, addPoint, ripplePoints, autoName, curveAt, fromPos, movePoints, removePoints, resolveTarget, toPos } from './automation.js'
import { KnobMenu } from './KnobMenu.jsx'
import { autoTimeAt } from './song.js'
import { formatValue } from './Knob.jsx'
import { NameInput } from './NameInput.jsx'
import './Automation.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// a little picture of each segment shape, for its button
const MODE_ICON = {
  curve: 'M1 9 Q 12 9 19 1',
  bezier: 'M1 9 C 8 9 12 1 19 1',
  hold: 'M1 7 H 13 V 3 H 19',
  stairs: 'M1 9 H 6 V 6 H 11 V 3 H 16 V 1 H 19',
  sine: 'M1 5 C 3 0 5 0 5.5 5 S 8 10 10 5 S 12.5 0 14.5 5 S 17 10 19 5',
  triangle: 'M1 9 L 5.5 1 L 10 9 L 14.5 1 L 19 9',
  saw: 'M1 9 L 10 1 V 9 L 19 1 V 9',
  square: 'M1 9 V 1 H 5.5 V 9 H 10 V 1 H 14.5 V 9 H 19',
}

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
 * drag on bare grid draws a selection box, and ctrl/cmd + drag moves copies. Shift + drag
 * on a point locks it to one way, as FL Studio does: whichever way it first moves —
 * sideways keeps its value, up and down keeps its time. Shift held part-way through a drag
 * locks it from there.
 * Delete removes the selection, arrows nudge it, ctrl/cmd + A selects all. The diamond
 * between two points bends the line (right-click it: straight again). Points snap to
 * 16ths of a bar; hold alt to place them freely. Each gesture is one undo step.
 */
export function AutomationEditor({ project, autoId, anchor, beats = 4, transport, onUpdateProject, onRemove, onShowTimeline, onClose }) {
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
  const [lock, setLock] = useState(null) // a shift-drag's lock: 'time' (keeps its value) or 'value' (keeps its time)
  const [marquee, setMarquee] = useState(null) // { x0, y0, x1, y1 } in graph px while box-selecting
  const [view, setView] = useState(null) // { from, len } in bars when zoomed in; null: the whole curve
  const viewNow = useRef(null)
  // the song's playhead, where it falls on this curve: drawn every frame, no re-render
  const headRef = useRef(null)
  const headDot = useRef(null)
  const projectRef = useRef(project)
  projectRef.current = project
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const line = headRef.current
      const dot = headDot.current
      const v = viewNow.current
      const p = projectRef.current
      const a = p?.song?.autos?.find((x) => x.id === autoId)
      if (!line || !dot || !v || !a || !transport) return
      const x = autoTimeAt(p, autoId, transport.position())
      const shown = x !== null && x >= v.vFrom - 1e-9 && x <= v.vFrom + v.vLen + 1e-9
      line.style.display = shown ? '' : 'none'
      dot.style.display = shown ? '' : 'none'
      if (!shown) return
      const px = GUTTER + ((x - v.vFrom) / v.vLen) * v.plotW
      const y = curveAt(a, x)
      line.setAttribute('x1', px); line.setAttribute('x2', px)
      dot.setAttribute('cx', px); dot.setAttribute('cy', PAD_Y + (1 - y) * (GRAPH_H - 2 * PAD_Y))
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [autoId, transport])
  // ctrl + scroll (or a pinch) zooms around the pointer; scroll moves along when zoomed in
  useEffect(() => {
    const el = graphRef.current
    if (!el) return
    const onWheel = (e) => {
      const v = viewNow.current
      if (!v) return
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const pinch = e.deltaMode === 0 && Math.abs(dy) < 40
        const len = clamp(v.vLen * Math.exp(dy * (pinch ? 0.012 : 0.0024)), 1 / 16, v.bars)
        const r = el.getBoundingClientRect()
        const at = v.vFrom + clamp((e.clientX - r.left - GUTTER) / v.plotW, 0, 1) * v.vLen // the bar under the pointer stays put
        const share = (at - v.vFrom) / v.vLen
        const from = clamp(at - share * len, 0, Math.max(0, v.bars - len))
        setView(len >= v.bars - 1e-9 ? null : { from, len })
        return
      }
      if (v.vLen >= v.bars - 1e-9) return // the whole curve's in view: let the page scroll
      e.preventDefault()
      const d = Math.abs(e.deltaX) > Math.abs(dy) ? e.deltaX : dy
      setView({ len: v.vLen, from: clamp(v.vFrom + (d / v.plotW) * v.vLen, 0, v.bars - v.vLen) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [autoId])
  const [segMenu, setSegMenu] = useState(null) // { i, x, y }: a segment's shape menu
  const [shapeOpen, setShapeOpen] = useState(false) // the wave filler
  // ripple: dragging a point sideways takes the points after it along (kept for next time)
  const [ripple, setRipple] = useState(() => { try { return localStorage.getItem('lattice:auto-ripple') !== 'off' } catch { return true } })
  useEffect(() => { try { localStorage.setItem('lattice:auto-ripple', ripple ? 'on' : 'off') } catch { /* storage unavailable */ } }, [ripple])
  const [shapeForm, setShapeForm] = useState({ wave: 'sine', rate: 1, lo: 0, hi: 1 })
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
  // the stretch of the curve in view: all of it, until you zoom in (ctrl + scroll, a pinch)
  const vLen = clamp(view?.len ?? bars, 1 / 16, bars)
  const vFrom = clamp(view?.from ?? 0, 0, Math.max(0, bars - vLen))
  const zoomed = vLen < bars - 1e-9
  const sx = (x) => GUTTER + ((x - vFrom) / vLen) * plotW
  const sy = (y) => PAD_Y + (1 - y) * (GRAPH_H - 2 * PAD_Y)
  viewNow.current = { vFrom, vLen, bars, plotW }
  const toX = (px) => clamp(vFrom + ((px - GUTTER) / plotW) * vLen, 0, bars)
  const toY = (py) => clamp(1 - (py - PAD_Y) / (GRAPH_H - 2 * PAD_Y), 0, 1)
  // unclamped, for handles that may reach past the top or bottom
  const toXFree = (px) => vFrom + ((px - GUTTER) / plotW) * vLen
  const toYFree = (py) => 1 - (py - PAD_Y) / (GRAPH_H - 2 * PAD_Y)

  // the curve as a path, sampled every few pixels (straight lines are exact at the points anyway)
  const shown = auto && draft ? { ...auto, points: draft } : auto
  const path = useMemo(() => {
    const auto = shown
    if (!auto) return { line: '', area: '' }
    const xs = new Set()
    const end = vFrom + vLen
    for (let px = 0; px <= plotW; px += 2) xs.add(vFrom + (px / plotW) * vLen)
    for (const p of auto.points) { xs.add(p.x); xs.add(Math.max(0, p.x - 1e-6)) }
    xs.add(end)
    const ordered = [...xs].filter((x) => x >= vFrom - 1e-9 && x <= end + 1e-9).sort((a, b) => a - b)
    const pts = ordered.map((x) => `${sx(x).toFixed(1)},${sy(curveAt(auto, x)).toFixed(1)}`)
    return { line: `M${pts.join('L')}`, area: `M${sx(vFrom)},${sy(0)}L${pts.join('L')}L${sx(end)},${sy(0)}Z` }
  }, [shown, plotW, bars, vFrom, vLen]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // (a bezier segment has its two handles instead; any other segment has its diamond, which
  // bends a curve, sets how many times a wave or stairs repeat, and opens the shape menu)
  const bends = points.slice(0, -1).flatMap((p, i) => {
    const q = points[i + 1]
    if (q.x - p.x < 1e-6 || p.m === 'bezier') return []
    // a flat stretch has one too: it's where a wave most often goes
    const mx = (p.x + q.x) / 2
    return [{ i, px: sx(mx), py: p.m ? sy((p.y + q.y) / 2) : sy(curveAt(shown, mx)), bent: !!p.c || !!p.m, label: CYCLING.has(p.m) ? `${p.n ?? 1}×` : p.m === 'hold' ? 'hold' : null }]
  })
  // a bezier segment's handles, in graph px: one hangs off each end
  const handles = points.slice(0, -1).flatMap((p, i) => {
    const q = points[i + 1]
    if (p.m !== 'bezier' || q.x - p.x < 1e-6) return []
    const h = p.h ?? [0.4, 0, 0.6, 0]
    const w = q.x - p.x
    return [
      { i, which: 0, px: sx(p.x + h[0] * w), py: sy(clamp(p.y + h[1], -0.2, 1.2)), ax: sx(p.x), ay: sy(p.y) },
      { i, which: 1, px: sx(p.x + h[2] * w), py: sy(clamp(q.y + h[3], -0.2, 1.2)), ax: sx(q.x), ay: sy(q.y) },
    ]
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
    const hd = list === points && handles.find((h) => Math.hypot(h.px - px, h.py - py) <= HIT - 2)
    if (hd) return { handle: hd.i, which: hd.which }
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
      // right-click a segment's diamond (or a bezier's handle): its shape menu;
      // right-click or right-drag across points: gone
      if (h.bend !== undefined || h.handle !== undefined) {
        setSegMenu({ i: h.bend ?? h.handle, x: e.clientX, y: e.clientY })
        return
      }
      const gone = new Set(h.point !== undefined ? [h.point] : [])
      dragRef.current = { mode: 'erase', gone }
      setDraft(removePoints(points, [...gone]))
      return
    }
    if (h.handle !== undefined) {
      dragRef.current = { mode: 'handle', i: h.handle, which: h.which }
      return
    }
    if (h.bend !== undefined) {
      const [p0, p1] = [points[h.bend], points[h.bend + 1]]
      // a wave or stairs: up and down set how many times it goes round; a curve: how it bends
      if (CYCLING.has(p0.m)) { dragRef.current = { mode: 'cycles', i: h.bend, y: e.clientY, n: p0.n ?? 1 }; return }
      if (p0.m === 'hold') return
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
      // ctrl/cmd: drag out a copy. Shift: drag locked to one way (see above); a shift-click
      // without moving adds the point to the selection or takes it out (as in the piano roll)
      if (e.shiftKey && !sel.has(i)) sel = new Set([i])
      if (!e.shiftKey && !sel.has(i)) { sel = new Set([i]); setSelection(sel) }
      const group = [...sel].filter((j) => j < points.length)
      dragRef.current = { mode: 'move', base: points, group, grab: i, copy: mod, toggle: e.shiftKey ? i : null, px, py }
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
    } else if (d.mode === 'cycles') {
      const n = Math.round(clamp(d.n + (d.y - e.clientY) / 10, 1, 64))
      setDraft(auto.points.map((p, i) => (i === d.i ? { ...p, n } : p)))
    } else if (d.mode === 'handle') {
      // a handle's place: across as a share of its segment, up and down from the point it hangs off
      const p = auto.points[d.i]
      const q = auto.points[d.i + 1]
      const w = Math.max(1e-6, q.x - p.x)
      const ux = clamp((toXFree(px) - p.x) / w, 0, 1)
      const y = toYFree(py)
      const h = [...(p.h ?? [0.4, 0, 0.6, 0])]
      if (d.which === 0) { h[0] = ux; h[1] = clamp(y - p.y, -1, 1) } else { h[2] = ux; h[3] = clamp(y - q.y, -1, 1) }
      // shift: level with its point (a smooth start or landing)
      if (e.shiftKey) { if (d.which === 0) h[1] = 0; else h[3] = 0 }
      setDraft(auto.points.map((pt, i) => (i === d.i ? { ...pt, h: h.map((v) => Math.round(v * 1000) / 1000) } : pt)))
    } else if (d.mode === 'move') {
      if (!d.moved && Math.hypot(px - d.px, py - d.py) < NUDGE) return
      d.moved = true
      // shift locks it one way, decided by which way it's gone furthest when shift is held
      if (e.shiftKey && !d.lock) d.lock = Math.abs(px - d.px) >= Math.abs(py - d.py) ? 'time' : 'value'
      if (!e.shiftKey) d.lock = null
      setLock(d.lock ?? null)
      // the grabbed point lands on the grid (alt: anywhere); the rest keep their distance
      const from = d.base[d.grab]
      const dx = d.lock === 'value' ? 0 : snapX(clamp(from.x + ((px - d.px) / plotW) * vLen, 0, bars), e.altKey) - from.x
      const dy = d.lock === 'time' ? 0 : -(py - d.py) / travel
      // ripple (on unless you've turned it off): what follows slides along with it, as in FL
      d.current = ripple && !d.copy ? ripplePoints(d.base, d.group, dx, dy, bars) : movePoints(d.base, d.group, dx, dy, bars, d.copy)
      setDraft(d.current.points)
      setSelection(new Set(d.current.indices))
    }
  }
  const onGraphUp = () => {
    const d = dragRef.current
    dragRef.current = null
    setLock(null)
    if (!d) return
    if (d.mode === 'marquee') { setMarquee(null); return }
    if (d.mode === 'erase') {
      // a right-press that rubbed nothing out is a press on bare grid: let the selection go
      setSelection(new Set())
      if (!d.gone.size) { setDraft(null); return }
      return commit(removePoints(auto.points, [...d.gone]))
    }
    if (d.mode === 'bend' || d.mode === 'cycles' || d.mode === 'handle') return draft ? commit(draft) : undefined
    if (d.current) return commit(d.current.points)
    if (d.created) return commit(d.base)
    // a shift-click that didn't move adds the point to the selection, or takes it out
    if (d.toggle !== null && d.toggle !== undefined) {
      setSelection((sel) => { const next = new Set(sel); next.has(d.toggle) ? next.delete(d.toggle) : next.add(d.toggle); return next })
    }
    setDraft(null)
  }

  /** A segment's shape: what the menu on its diamond sets (see automation.js SEGMENT_MODES). */
  const setMode = (i, mode) => commit(points.map((p, j) => {
    if (j !== i) return p
    const { m, n, h, c, ...rest } = p // eslint-disable-line no-unused-vars
    if (mode === 'straight') return rest
    if (mode === 'curve') return c ? { ...rest, c } : rest
    if (mode === 'bezier') return { ...rest, m: 'bezier', h: h ?? [0.4, 0, 0.6, 0] }
    if (CYCLING.has(mode)) return { ...rest, m: mode, n: n ?? (mode === 'stairs' ? 4 : 1) }
    return { ...rest, m: mode }
  }))
  // the segments the shape bar works on: those after the selected points, or every one
  const barTargets = () => {
    const sel = [...selection].filter((i) => i < points.length - 1)
    return sel.length ? sel : points.slice(0, -1).map((_, i) => i)
  }
  const barMode = () => {
    const modes = new Set(barTargets().map((i) => points[i]?.m ?? 'curve'))
    return modes.size === 1 ? [...modes][0] : null
  }
  const barCycles = () => {
    const ns = barTargets().filter((i) => CYCLING.has(points[i]?.m)).map((i) => points[i].n ?? 1)
    return ns.length ? ns[0] : null
  }
  /** Give the segments the bar works on a shape (and keep their cycles where they have them). */
  const shapeSegments = (mode) => {
    const targets = new Set(barTargets())
    if (points.length < 2) {
      // one point is a flat line: give it a partner at the end, so there's a segment to shape
      const only = points[0] ?? { x: 0, y: 0.5 }
      return commit([{ ...only, x: 0 }, { x: bars, y: only.y }].map((p, i) => (i === 0 ? withMode(p, mode) : p)))
    }
    commit(points.map((p, i) => (targets.has(i) ? withMode(p, mode) : p)))
  }
  const withMode = (p, mode) => {
    const { m, n, h, c, ...rest } = p // eslint-disable-line no-unused-vars
    if (mode === 'curve') return c ? { ...rest, c } : rest
    if (mode === 'bezier') return { ...rest, m: 'bezier', h: h ?? [0.4, 0, 0.6, 0] }
    if (CYCLING.has(mode)) return { ...rest, m: mode, n: n ?? (mode === 'stairs' ? 4 : 4) }
    return { ...rest, m: mode }
  }
  const setCycles = (n) => {
    const targets = new Set(barTargets())
    commit(points.map((p, i) => (targets.has(i) && CYCLING.has(p.m) ? { ...p, n: Math.max(1, Math.min(64, n)) } : p)))
  }

  /** Fill the selection (two or more points), or the whole curve, with a shape at a rate. */
  const fillShape = () => {
    const f = shapeForm
    const sel = [...selection].filter((i) => i < points.length).sort((a, b) => points[a].x - points[b].x)
    const x0 = sel.length >= 2 ? points[sel[0]].x : 0
    const x1 = sel.length >= 2 ? points[sel[sel.length - 1]].x : bars
    if (x1 - x0 < 1e-6) return
    const lo = clamp(f.lo, 0, 1)
    const hi = clamp(f.hi, 0, 1)
    const cycles = Math.max(1, Math.round((x1 - x0) * f.rate))
    const down = f.wave === 'ramp down'
    const first = { x: x0, y: down ? hi : lo }
    if (CYCLING.has(f.wave)) Object.assign(first, { m: f.wave, n: f.wave === 'stairs' ? Math.max(2, cycles) : cycles })
    const last = { x: x1, y: down ? lo : hi }
    const kept = points.filter((p) => p.x < x0 - 1e-9 || p.x > x1 + 1e-9)
    const next = [...kept, first, last].sort((a, b) => a.x - b.x)
    setSelection(new Set())
    commit(next)
    setShapeOpen(false)
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
  // grid lines in view: beats, and sixteenths too once there's room for them
  const pxPerBeat = (plotW / vLen) / beats
  const per = pxPerBeat > 48 ? 4 : 1 // lines per beat
  const beatLines = []
  for (let b = Math.floor(vFrom * beats * per); b <= Math.ceil((vFrom + vLen) * beats * per); b++) beatLines.push(b)
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
        style={{ cursor: d?.mode === 'move' || d?.mode === 'handle' ? 'grabbing' : d?.mode === 'bend' || d?.mode === 'cycles' || hot?.bend !== undefined ? 'ns-resize' : hot?.point !== undefined || hot?.handle !== undefined ? 'grab' : undefined }}
        onKeyDown={onGraphKey}
        onPointerDown={onGraphDown}
        onPointerMove={onGraphMove}
        onPointerUp={onGraphUp}
        onPointerCancel={onGraphUp}
        onPointerLeave={() => { if (!dragRef.current) { setHover(null); setHot(null) } }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg ref={svgRef} width={width} height={GRAPH_H} aria-hidden>
          <defs><clipPath id={`auto-plot-${autoId}`}><rect x={GUTTER - 8} y={0} width={plotW + 16} height={GRAPH_H} /></clipPath></defs>
          {[0, 0.25, 0.5, 0.75, 1].map((y) => (
            <g key={y}>
              <line x1={GUTTER} x2={GUTTER + plotW} y1={sy(y)} y2={sy(y)} className={`auto-grid ${y === 0 || y === 1 ? 'edge' : ''}`} />
              {(y === 0 || y === 0.5 || y === 1) && <text x={GUTTER - 8} y={sy(y) + 3} className="auto-axis" textAnchor="end">{show(y)}</text>}
            </g>
          ))}
          <g clipPath={`url(#auto-plot-${autoId})`}>
          {beatLines.map((b) => (
            <line key={b} x1={sx(b / (beats * per))} x2={sx(b / (beats * per))} y1={PAD_Y} y2={GRAPH_H - PAD_Y} className={`auto-grid ${b % (beats * per) === 0 ? 'bar' : b % per === 0 ? '' : 'sub'}`} />
          ))}
          {Array.from({ length: bars }, (_, b) => b).filter((b) => b >= Math.floor(vFrom) && b <= vFrom + vLen && (plotW / vLen > 26 || b % Math.ceil(26 / (plotW / vLen)) === 0)).map((b) => (
            <text key={b} x={sx(b) + 4} y={GRAPH_H - 2} className="auto-axis">{b + 1}</text>
          ))}
          {/* zoomed in: beat numbers too */}
          {pxPerBeat > 34 && Array.from({ length: Math.ceil(vLen * beats) + 2 }, (_, k) => Math.floor(vFrom * beats) + k).filter((k) => k % beats && k / beats <= bars).map((k) => (
            <text key={`b${k}`} x={sx(k / beats) + 3} y={GRAPH_H - 2} className="auto-axis sub">{Math.floor(k / beats) + 1}.{(k % beats) + 1}</text>
          ))}
          {now !== null && <line x1={GUTTER} x2={GUTTER + plotW} y1={sy(now)} y2={sy(now)} className="auto-now" />}
          <path d={path.area} className="auto-area" />
          <path d={path.line} className="auto-line" />
          {handles.map((h) => (
            <g key={`h${h.i}:${h.which}`} className="auto-handle-g">
              <line x1={h.ax} y1={h.ay} x2={h.px} y2={h.py} className="auto-handle-line" />
              <rect x={h.px - 4} y={h.py - 4} width="8" height="8" className={`auto-handle-box ${hot?.handle === h.i && hot?.which === h.which ? 'hot' : ''}`} />
            </g>
          ))}
          {bends.filter((b) => b.label).map((b) => (
            <text key={`l${b.i}`} x={b.px + 9} y={b.py - 7} className="auto-axis auto-seg-label">{b.label}</text>
          ))}
          {bends.map((b) => (
            <rect key={`b${b.i}`} x={b.px - 5} y={b.py - 5} width="10" height="10" className={`auto-bend ${b.bent ? 'bent' : ''} ${hot?.bend === b.i || d?.mode === 'bend' && d.i === b.i ? 'hot' : ''}`} transform={`rotate(45 ${b.px} ${b.py})`} />
          ))}
          {/* a locked drag shows the line it's held to */}
          {lock && moving !== null && (lock === 'time'
            ? <line x1={GUTTER} x2={GUTTER + plotW} y1={sy(points[moving].y)} y2={sy(points[moving].y)} className="auto-lock" />
            : <line x1={sx(points[moving].x)} x2={sx(points[moving].x)} y1={PAD_Y} y2={GRAPH_H - PAD_Y} className="auto-lock" />)}
          {points.map((p, i) => (
            <circle key={`p${i}`} cx={sx(p.x)} cy={sy(p.y)} r={hot?.point === i || moving === i ? 7 : 5.5} className={`auto-point ${selection.has(i) ? 'selected' : ''}`} />
          ))}
          {/* the playhead, as the timeline has it, on this curve */}
          <line ref={headRef} y1={PAD_Y - 4} y2={GRAPH_H - PAD_Y + 4} className="auto-head-line" style={{ display: 'none' }} />
          <circle ref={headDot} r="3.5" className="auto-head-dot" style={{ display: 'none' }} />
          </g>
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

      <div className="auto-modes" role="group" aria-label="Segment shape">
        <span className="auto-modes-label">{[...selection].some((i) => i < points.length - 1) ? 'selected segments' : 'every segment'}</span>
        {SEGMENT_MODES.map((mode) => (
          <button key={mode} type="button" className={`auto-mode ${barMode() === mode ? 'on' : ''}`} onClick={() => shapeSegments(mode)} title={{ curve: 'A line you bend with its diamond', bezier: 'Two handles to shape it exactly', hold: 'Stays put until the next point', stairs: 'Steps up to the next point', sine: 'Smooth waves between the two points', triangle: 'Straight up and down', saw: 'Ramps up, drops', square: 'On, off' }[mode]}>
            <svg viewBox="0 0 20 10" width="20" height="10" aria-hidden><path d={MODE_ICON[mode]} fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
            <span>{mode}</span>
          </button>
        ))}
        {barCycles() !== null && (
          <span className="auto-cycles">
            <button type="button" className="btn" onClick={() => setCycles(barCycles() - 1)} aria-label="Fewer cycles">−</button>
            <span>{barCycles()}×</span>
            <button type="button" className="btn" onClick={() => setCycles(barCycles() + 1)} aria-label="More cycles">+</button>
          </span>
        )}
      </div>
      {shapeOpen && (
        <div className="auto-shape">
          <label>
            <span>shape</span>
            <select className="select" value={shapeForm.wave} onChange={(e) => setShapeForm((f) => ({ ...f, wave: e.target.value }))}>
              {['sine', 'triangle', 'saw', 'square', 'stairs', 'ramp up', 'ramp down'].map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <label>
            <span>{shapeForm.wave === 'stairs' ? 'steps' : 'rate'}</span>
            <select className="select" value={shapeForm.rate} onChange={(e) => setShapeForm((f) => ({ ...f, rate: Number(e.target.value) }))} disabled={shapeForm.wave.startsWith('ramp')}>
              {[[0.25, '4 bars'], [0.5, '2 bars'], [1, '1 bar'], [2, '1/2'], [4, '1/4'], [8, '1/8'], [16, '1/16'], [3, '1/2 t'], [6, '1/4 t'], [12, '1/8 t']].map(([v, l]) => <option key={l} value={v}>{shapeForm.wave === 'stairs' ? `${v} a bar` : l}</option>)}
            </select>
          </label>
          <label>
            <span>from</span>
            <input type="range" min="0" max="1" step="0.01" value={shapeForm.lo} onChange={(e) => setShapeForm((f) => ({ ...f, lo: Number(e.target.value) }))} />
            <em>{show(shapeForm.lo)}</em>
          </label>
          <label>
            <span>to</span>
            <input type="range" min="0" max="1" step="0.01" value={shapeForm.hi} onChange={(e) => setShapeForm((f) => ({ ...f, hi: Number(e.target.value) }))} />
            <em>{show(shapeForm.hi)}</em>
          </label>
          <button type="button" className="btn primary" onClick={fillShape}>{selected.length >= 2 ? 'fill selection' : 'fill curve'}</button>
        </div>
      )}
      {segMenu && points[segMenu.i] && (
        <KnobMenu
          x={segMenu.x}
          y={segMenu.y}
          title="This segment"
          items={[
            ...SEGMENT_MODES.map((mode) => [`${(points[segMenu.i].m ?? 'curve') === mode ? '• ' : ''}${mode}`, () => setMode(segMenu.i, mode)]),
            null,
            ['straight line', () => setMode(segMenu.i, 'straight')],
          ]}
          onClose={() => setSegMenu(null)}
        />
      )}
      <div className="auto-foot">
        {zoomed && <button type="button" className="btn" onClick={() => setView(null)} title="Show the whole curve again (ctrl + scroll or a pinch zooms in)">fit</button>}
        <button type="button" className={`btn auto-ripple ${ripple ? 'on' : ''}`} aria-pressed={ripple} onClick={() => setRipple((r) => !r)} title={ripple ? 'Ripple: dragging a point sideways takes the points after it along (click to drag points on their own)' : 'Points move on their own (click to ripple: the points after one move with it)'}>ripple</button>
        <button type="button" className={`btn auto-shape-btn ${shapeOpen ? 'on' : ''}`} onClick={() => setShapeOpen((o) => !o)} title="Fill the curve (or the points you've selected) with a wave, a ramp or stairs, in time">shape…</button>
        <span className="auto-hint">click adds · drag moves · shift-drag: one way only · ctrl-drag copies · right-drag deletes · right-click a diamond: its shape (bezier, waves, stairs…) · drag a diamond: bend, or how many cycles · alt: off grid</span>
        <span className="spacer" />
        <span className="auto-meta">{clips ? `${clips} clip${clips === 1 ? '' : 's'} on the timeline` : 'not on the timeline yet'}</span>
        {onShowTimeline && <button type="button" className="btn" onClick={onShowTimeline}>show timeline</button>}
        <button type="button" className="btn ghost danger" onClick={onRemove} title="Delete the automation and its clips (ctrl/cmd + Z brings it back)">remove</button>
      </div>
    </div>
  )
}
