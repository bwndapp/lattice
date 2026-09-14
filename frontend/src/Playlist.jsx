import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hapValue, newLaneCode, parseLanes, pitchOf, queryWindow, soundOf, toggledMute, toggledSolo } from './lanes'

const MAIN = '__main__'
const MIN_BARS = 0.25 // most zoomed in: one beat of 4/4 across the view
const MAX_BARS = 512 // most zoomed out
const PRESETS = [1, 4, 16, 64]
const LABEL_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

/**
 * The playlist: one lane per labeled pattern, one clip per bar (cycle) where it plays.
 * The view is a free window onto an open-ended timeline, FL-style: ctrl/cmd + wheel or
 * pinch zooms around the pointer, horizontal wheel / shift + wheel / dragging the lanes
 * pans, and the overview strip shows the whole song with a draggable, resizable window.
 * Detail follows zoom: notes when there's room, solid clips when there isn't.
 *
 * The code stays the source of truth: lanes come from its labels, clips are the
 * evaluated patterns queried ahead of time, and mute/solo/+ lane edit the code.
 */
export default function Playlist({ transport, editorRef, code, pattern, lanePatterns, started, stale, emptyMessage, onEditCode, onRevealCode }) {
  const lastGood = useRef([])
  const parsed = useMemo(() => parseLanes(code), [code])
  if (parsed) lastGood.current = parsed
  const sourceLanes = parsed ?? lastGood.current

  // the view: first bar on screen and how many bars fit across
  const viewRef = useRef({ start: 0, bars: clamp(readLocal('strudel:playlist:bars', 8), MIN_BARS, MAX_BARS) })
  const [viewLabel, setViewLabel] = useState(viewRef.current.bars)
  const [follow, setFollow] = useState(() => readLocal('strudel:playlist:follow', true))
  const followRef = useRef(follow)
  followRef.current = follow

  const gridRef = useRef(null)
  const canvases = useRef(new Map())
  const rulerRef = useRef(null)
  const overviewRef = useRef(null)
  const playheadRef = useRef(null)
  const loopRef = useRef(null)
  const rulerDrag = useRef(null)
  const panDrag = useRef(null)
  const overviewDrag = useRef(null)
  const cacheRef = useRef(new WeakMap()) // pattern → Map(bar → haps)
  const extentRef = useRef(32)

  const anySolo = sourceLanes.some((l) => l.soloed)
  const rows = useMemo(() => {
    if (!sourceLanes.length) return [{ id: MAIN, slot: MAIN, label: 'main', source: '', lane: null, index: 1 }]
    let anon = 0
    return sourceLanes.map((l, i) => ({
      id: l.slot,
      slot: l.slot,
      label: l.title ?? `$${++anon}`,
      source: l.source,
      lane: l,
      index: i + 1,
      silent: l.muted || (anySolo && !l.soloed),
    }))
  }, [sourceLanes, anySolo])

  useEffect(() => writeLocal('strudel:playlist:follow', follow), [follow])

  const patternFor = useCallback(
    (row) => (!pattern ? null : row.slot === MAIN ? pattern : lanePatterns?.get(row.slot)),
    [pattern, lanePatterns],
  )

  /** Haps in one bar, queried once per pattern. */
  const barHaps = useCallback((pat, bar) => {
    if (!pat || bar < 0) return []
    let bars = cacheRef.current.get(pat)
    if (!bars) { bars = new Map(); cacheRef.current.set(pat, bars) }
    let haps = bars.get(bar)
    if (!haps) {
      const cps = editorRef.current?.repl.scheduler.cps ?? 0.5
      haps = queryWindow(pat, bar, bar + 1, cps).map((hap) => ({
        v: hapValue(hap), b: Number(hap.whole.begin), e: Number(hap.whole.end),
      }))
      bars.set(bar, haps)
    }
    return haps
  }, [editorRef])

  const timelineWidth = () => rulerRef.current?.clientWidth || 1

  const draw = useCallback(() => {
    const view = viewRef.current
    const now = transport.position()
    const beats = transport.beats
    const W = timelineWidth()

    // follow the playhead page by page, like FL's auto-scroll
    if (started && followRef.current && !panDrag.current && !overviewDrag.current) {
      if (now < view.start || now > view.start + view.bars * 0.95) {
        view.start = Math.max(0, now - view.bars * 0.05)
      }
    }

    const start = view.start
    const end = start + view.bars
    const ppb = W / view.bars // pixels per bar
    const ppBeat = ppb / beats
    const xOf = (t) => ((t - start) / view.bars) * W
    const firstBar = Math.max(0, Math.floor(start))
    const lastBar = Math.ceil(end)

    const css = getComputedStyle(document.documentElement)
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback
    const acid = color('--acid', '#e4ff1a')
    const paper = color('--paper', '#f2f0e6')
    const line = color('--line', '#2e2e2a')
    const muted = color('--muted', '#a3a39a')
    const mono = (px) => `${px}px "Martian Mono", ui-monospace, monospace`

    const fit = (canvas) => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { ctx, w: canvas.clientWidth, h: canvas.clientHeight }
    }

    const drag = rulerDrag.current
    const loop = drag?.moved
      ? { on: true, from: Math.min(drag.t0, drag.t1), to: Math.max(drag.t0, drag.t1) }
      : transport.loop

    const labelStep = LABEL_STEPS.find((s) => s * ppb >= 44) ?? 512
    const barLineStep = ppb >= 5 ? 1 : labelStep

    // ── ruler ──
    if (rulerRef.current) {
      const { ctx, w, h } = fit(rulerRef.current)
      ctx.clearRect(0, 0, w, h)
      if (loop.to > start && loop.from < end) {
        const x0 = xOf(Math.max(loop.from, start))
        ctx.fillStyle = loop.on ? acid : muted
        ctx.globalAlpha = loop.on ? 0.3 : 0.15
        ctx.fillRect(x0, 0, xOf(Math.min(loop.to, end)) - x0, h)
        ctx.globalAlpha = 1
      }
      ctx.textBaseline = 'top'
      for (let bar = Math.floor(firstBar / barLineStep) * barLineStep; bar < lastBar; bar += barLineStep) {
        const x = xOf(bar)
        const labelled = bar % labelStep === 0
        ctx.fillStyle = labelled ? paper : line
        ctx.fillRect(Math.floor(x), labelled ? 0 : h - 10, 1, labelled ? h : 10)
        if (labelled) {
          ctx.font = mono(11)
          ctx.fillText(String(bar + 1), x + 5, 4)
        }
        if (ppBeat >= 8) {
          for (let b = 1; b < beats; b++) {
            const bx = xOf(bar + b / beats)
            ctx.fillStyle = muted
            ctx.fillRect(Math.floor(bx), h - 6, 1, 6)
            if (ppBeat >= 48) {
              ctx.font = mono(9)
              ctx.fillText(`${bar + 1}.${b + 1}`, bx + 4, 6)
            }
          }
        }
      }
    }

    // ── lanes ──
    const drawNotes = ppb >= 28
    for (const row of rows) {
      const canvas = canvases.current.get(row.id)
      if (!canvas) continue
      const { ctx, w, h } = fit(canvas)
      ctx.clearRect(0, 0, w, h)

      // grid
      for (let bar = Math.floor(firstBar / barLineStep) * barLineStep; bar < lastBar; bar += barLineStep) {
        ctx.fillStyle = line
        ctx.fillRect(Math.floor(xOf(bar)), 0, 1, h)
        if (ppBeat >= 8) {
          ctx.globalAlpha = 0.4
          for (let b = 1; b < beats; b++) ctx.fillRect(Math.floor(xOf(bar + b / beats)), 0, 1, h)
          if (ppBeat >= 64) {
            ctx.globalAlpha = 0.18
            for (let s = 1; s < beats * 4; s++) if (s % 4) ctx.fillRect(Math.floor(xOf(bar + s / (beats * 4))), 0, 1, h)
          }
          ctx.globalAlpha = 1
        }
      }

      const pat = patternFor(row)
      if (!pat) continue
      const tone = row.silent ? muted : acid

      // pitch or sound rows, from what's on screen (capped so wide views stay cheap)
      let rowOf = null, rowCount = 1, labels = null, pitched = false
      if (drawNotes) {
        const visible = []
        for (let bar = firstBar; bar < Math.min(lastBar, firstBar + 32); bar++) visible.push(...barHaps(pat, bar))
        const pitches = visible.map((ev) => pitchOf(ev.v)).filter((p) => p !== null)
        pitched = visible.length > 0 && pitches.length >= visible.length / 2
        if (pitched) {
          const lo = Math.floor(Math.min(...pitches)) - 1
          const hi = Math.ceil(Math.max(...pitches)) + 1
          rowCount = Math.max(hi - lo + 1, 8)
          rowOf = (v) => { const p = pitchOf(v); return p === null ? rowCount / 2 : hi - p }
        } else {
          labels = [...new Set(visible.map((ev) => soundOf(ev.v)))].sort()
          rowCount = Math.max(labels.length, 1)
          rowOf = (v) => Math.max(0, labels.indexOf(soundOf(v)))
        }
      }

      const strip = ppb >= 40 ? 14 : 0
      const gap = ppb >= 10 ? 2 : 0
      let runStart = null // zoomed far out, neighbouring clips merge into runs
      const flushRun = (bar) => {
        if (runStart === null) return
        const x0 = Math.floor(xOf(runStart))
        ctx.fillStyle = tone
        ctx.globalAlpha = row.silent ? 0.3 : 0.75
        ctx.fillRect(x0, 3, Math.max(1, Math.floor(xOf(bar)) - x0), h - 6)
        // keep a sense of scale inside long runs: a divider at every labelled bar
        ctx.fillStyle = '#000'
        ctx.globalAlpha = 0.45
        for (let b = Math.ceil(runStart / labelStep) * labelStep; b < bar; b += labelStep) {
          if (b > runStart) ctx.fillRect(Math.floor(xOf(b)), 3, 1, h - 6)
        }
        ctx.globalAlpha = 1
        runStart = null
      }

      for (let bar = firstBar; bar < lastBar; bar++) {
        const inBar = barHaps(pat, bar)
        if (!inBar.length) { flushRun(bar); continue }
        if (!gap) { if (runStart === null) runStart = bar; continue }

        const x0 = Math.floor(xOf(bar)) + gap
        const cw = Math.floor(xOf(bar + 1)) - 1 - x0
        const current = started && now >= bar && now < bar + 1
        ctx.fillStyle = tone
        ctx.globalAlpha = row.silent ? 0.06 : drawNotes ? (current ? 0.16 : 0.09) : 0.45
        ctx.fillRect(x0, 2, cw, h - 4)
        ctx.globalAlpha = row.silent ? 0.35 : 0.55
        ctx.strokeStyle = tone
        ctx.lineWidth = 1
        ctx.strokeRect(x0 + 0.5, 2.5, cw - 1, h - 5)
        if (strip) {
          ctx.globalAlpha = row.silent ? 0.35 : 1
          ctx.fillRect(x0, 2, cw, strip)
          ctx.globalAlpha = 1
          if (cw > 40) {
            ctx.save()
            ctx.beginPath()
            ctx.rect(x0, 2, cw - 3, strip)
            ctx.clip()
            ctx.fillStyle = '#000'
            ctx.font = mono(9)
            ctx.textBaseline = 'middle'
            ctx.fillText(ppb >= 90 ? `${row.label} · ${bar + 1}` : row.label, x0 + 4, 2 + strip / 2)
            ctx.restore()
          }
        }
        ctx.globalAlpha = 1
        if (!drawNotes) continue

        const top = 2 + strip + 3
        const rowH = (h - top - 5) / rowCount
        for (const ev of inBar) {
          const b = Math.max(ev.b, bar)
          const e = Math.min(ev.e, bar + 1)
          const x = xOf(b)
          const span = xOf(e) - x
          const width = pitched ? Math.max(2, span - 1) : Math.max(2, Math.min(span * 0.6, span - 2))
          const on = started && ev.b <= now && now < ev.e
          ctx.globalAlpha = row.silent ? 0.6 : started && ev.e <= now && bar <= now ? 0.5 : 1
          ctx.fillStyle = row.silent ? muted : on ? paper : acid
          ctx.fillRect(x, top + rowOf(ev.v) * rowH, width, Math.max(2, rowH - 1))
        }
        ctx.globalAlpha = 1
        if (labels && rowH >= 10 && bar === firstBar) {
          ctx.font = mono(8)
          ctx.textBaseline = 'middle'
          labels.forEach((label, i) => {
            const y = top + i * rowH + rowH / 2
            ctx.fillStyle = 'rgba(0,0,0,0.8)'
            ctx.fillRect(Math.max(0, x0) + 1, y - 5, ctx.measureText(label).width + 6, 10)
            ctx.fillStyle = paper
            ctx.fillText(label, Math.max(0, x0) + 4, y)
          })
        }
      }
      flushRun(lastBar)
    }

    // ── overlays ──
    if (playheadRef.current) {
      const ph = (now - start) / view.bars
      playheadRef.current.hidden = ph < 0 || ph > 1
      playheadRef.current.style.setProperty('--ph', ph)
      playheadRef.current.classList.toggle('cued', !started)
    }
    if (loopRef.current) {
      const a = clamp((loop.from - start) / view.bars, 0, 1)
      const b = clamp((loop.to - start) / view.bars, 0, 1)
      loopRef.current.hidden = !(loop.on && b > a)
      loopRef.current.style.setProperty('--la', a)
      loopRef.current.style.setProperty('--lb', b)
    }

    // ── overview: the whole song, the view as a box ──
    const extent = Math.max(32, Math.ceil((Math.max(end, now, loop.on ? loop.to : 0) * 1.25) / 16) * 16)
    extentRef.current = extent
    if (overviewRef.current) {
      const { ctx, w, h } = fit(overviewRef.current)
      ctx.clearRect(0, 0, w, h)
      const ox = (t) => (t / extent) * w
      const rowH = Math.max(2, (h - 6) / Math.max(rows.length, 1))
      let budget = 48 // bars to query per frame, so zooming out never stalls
      rows.forEach((row, i) => {
        const pat = patternFor(row)
        if (!pat) return
        const cached = cacheRef.current.get(pat)
        for (let bar = 0; bar < extent; bar++) {
          let has = cached?.get(bar)
          if (!has && budget > 0) { has = barHaps(pat, bar); budget-- }
          if (!has?.length) continue
          ctx.fillStyle = row.silent ? muted : acid
          ctx.globalAlpha = row.silent ? 0.35 : 0.7
          ctx.fillRect(ox(bar), 3 + i * rowH, Math.max(1, ox(1) - 0.5), Math.max(1, rowH - 1))
        }
      })
      ctx.globalAlpha = 1
      if (loop.on) {
        ctx.fillStyle = acid
        ctx.globalAlpha = 0.2
        ctx.fillRect(ox(loop.from), 0, ox(loop.to) - ox(loop.from), h)
        ctx.globalAlpha = 1
      }
      // view box
      ctx.strokeStyle = paper
      ctx.lineWidth = 2
      ctx.strokeRect(ox(start) + 1, 1, Math.max(4, ox(end) - ox(start) - 2), h - 2)
      // playhead
      ctx.fillStyle = started ? acid : paper
      ctx.fillRect(ox(now), 0, 2, h)
      if (budget <= 0 && !started) requestAnimationFrame(() => drawRef.current())
    }
  }, [transport, started, rows, patternFor, barHaps])

  const drawRef = useRef(draw)
  drawRef.current = draw

  // Redraw every frame while playing; on demand while stopped.
  useEffect(() => {
    if (!started) { draw(); return }
    let frame
    const loop = () => { draw(); frame = requestAnimationFrame(loop) }
    loop()
    return () => cancelAnimationFrame(frame)
  }, [draw, started])

  useEffect(() => transport.subscribe(() => { if (!started) drawRef.current() }), [transport, started])

  useEffect(() => {
    const observer = new ResizeObserver(() => drawRef.current())
    canvases.current.forEach((c) => observer.observe(c))
    if (rulerRef.current) observer.observe(rulerRef.current)
    if (overviewRef.current) observer.observe(overviewRef.current)
    return () => observer.disconnect()
  }, [rows])

  // ── view changes ──
  const settle = useCallback((manual = true) => {
    const view = viewRef.current
    view.bars = clamp(view.bars, MIN_BARS, MAX_BARS)
    view.start = Math.max(0, view.start)
    writeLocal('strudel:playlist:bars', view.bars)
    setViewLabel(view.bars)
    if (manual && started && followRef.current) {
      // a manual move while playing hands the view to you until follow is turned back on
      const now = transport.position()
      if (now < view.start || now > view.start + view.bars) setFollow(false)
    }
    if (!started) drawRef.current()
  }, [started, transport])

  /** Zoom by `factor` keeping the time under `anchor` (0..1 across the view) still. */
  const zoomBy = useCallback((factor, anchor = 0.5) => {
    const view = viewRef.current
    const pivot = view.start + anchor * view.bars
    const next = clamp(view.bars * factor, MIN_BARS, MAX_BARS)
    view.start = pivot - anchor * next
    view.bars = next
    settle()
  }, [settle])

  const zoomTo = (bars) => {
    const view = viewRef.current
    const now = transport.position()
    const inView = now >= view.start && now <= view.start + view.bars
    const anchor = inView ? (now - view.start) / view.bars : 0.5
    zoomBy(bars / view.bars, anchor)
  }

  const fitLoopOrSong = () => {
    const view = viewRef.current
    if (transport.looping()) {
      const pad = transport.loopLength() * 0.1
      view.start = transport.loop.from - pad
      view.bars = transport.loopLength() + pad * 2
    } else {
      view.start = 0
      view.bars = Math.max(16, Math.ceil((transport.position() + 1) / 16) * 16)
    }
    settle()
  }

  // wheel / trackpad: needs a non-passive listener to keep the page from zooming or scrolling
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const onWheel = (e) => {
      const rect = rulerRef.current?.getBoundingClientRect()
      if (!rect || e.clientX < rect.left) return // over the lane headers: normal scrolling
      const anchor = clamp((e.clientX - rect.left) / rect.width, 0, 1)
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomBy(Math.exp(e.deltaY * scale * 0.0022), anchor)
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale
        viewRef.current.start += (dx / rect.width) * viewRef.current.bars
        settle()
      }
    }
    grid.addEventListener('wheel', onWheel, { passive: false })
    return () => grid.removeEventListener('wheel', onWheel)
  }, [zoomBy, settle])

  // keyboard zoom outside text fields: + / - around the playhead, 0 fits
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === '+' || e.key === '=') zoomTo(viewRef.current.bars / 1.5)
      else if (e.key === '-' || e.key === '_') zoomTo(viewRef.current.bars * 1.5)
      else if (e.key === '0') fitLoopOrSong()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── ruler: click to jump, drag to mark a loop; middle-drag pans ──
  const timeAt = (e) => {
    const rect = rulerRef.current.getBoundingClientRect()
    const x = clamp(e.clientX - rect.left, 0, rect.width)
    return viewRef.current.start + (x / rect.width) * viewRef.current.bars
  }
  const snap = (t, fn = Math.round) => fn(t * transport.beats) / transport.beats
  const onRulerDown = (e) => {
    if (e.button === 1) return startPan(e)
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = timeAt(e)
    rulerDrag.current = { x0: e.clientX, t0: snap(t), t1: snap(t), raw: t, moved: false }
  }
  const onRulerMove = (e) => {
    if (panDrag.current) return onPanMove(e)
    const drag = rulerDrag.current
    if (!drag) return
    if (Math.abs(e.clientX - drag.x0) > 4) drag.moved = true
    drag.t1 = snap(timeAt(e))
    if (drag.moved && !started) draw()
  }
  const onRulerUp = (e) => {
    if (panDrag.current) return endPan()
    const drag = rulerDrag.current
    rulerDrag.current = null
    if (!drag) return
    if (drag.moved && drag.t1 !== drag.t0) {
      transport.setLoop({ on: true, from: Math.min(drag.t0, drag.t1), to: Math.max(drag.t0, drag.t1) })
    } else {
      transport.seek(snap(drag.raw, Math.floor))
    }
    if (!started) draw()
  }
  const onRulerKey = (e) => {
    const step = e.shiftKey ? 1 : 1 / transport.beats
    const pos = snap(transport.position())
    if (e.key === 'ArrowRight') transport.seek(pos + step)
    else if (e.key === 'ArrowLeft') transport.seek(pos - step)
    else return
    e.preventDefault()
  }

  // ── lanes: drag to pan (grab the canvas) ──
  const startPan = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    panDrag.current = { x0: e.clientX, start0: viewRef.current.start }
    gridRef.current?.classList.add('panning')
  }
  const onPanMove = (e) => {
    const drag = panDrag.current
    if (!drag) return
    const width = timelineWidth()
    viewRef.current.start = drag.start0 - ((e.clientX - drag.x0) / width) * viewRef.current.bars
    settle()
  }
  const endPan = () => {
    panDrag.current = null
    gridRef.current?.classList.remove('panning')
  }

  // ── overview: drag the box to move, its edges to zoom, elsewhere to jump the view there ──
  const onOverviewDown = (e) => {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const extent = extentRef.current
    const t = ((e.clientX - rect.left) / rect.width) * extent
    const view = viewRef.current
    const edge = (6 / rect.width) * extent
    let mode = 'move'
    if (Math.abs(t - view.start) <= edge) mode = 'left'
    else if (Math.abs(t - (view.start + view.bars)) <= edge) mode = 'right'
    else if (t < view.start || t > view.start + view.bars) view.start = t - view.bars / 2
    e.currentTarget.setPointerCapture(e.pointerId)
    overviewDrag.current = { mode, x0: e.clientX, start0: view.start, bars0: view.bars, extent, width: rect.width }
    settle()
  }
  const onOverviewMove = (e) => {
    const drag = overviewDrag.current
    const rect = e.currentTarget.getBoundingClientRect()
    if (!drag) {
      // hint the edges with a resize cursor
      const extent = extentRef.current
      const t = ((e.clientX - rect.left) / rect.width) * extent
      const view = viewRef.current
      const near = Math.min(Math.abs(t - view.start), Math.abs(t - view.start - view.bars)) <= (6 / rect.width) * extent
      e.currentTarget.style.cursor = near ? 'ew-resize' : 'grab'
      return
    }
    const dt = ((e.clientX - drag.x0) / drag.width) * drag.extent
    const view = viewRef.current
    if (drag.mode === 'move') view.start = drag.start0 + dt
    else if (drag.mode === 'left') {
      const endT = drag.start0 + drag.bars0
      view.start = Math.min(drag.start0 + dt, endT - MIN_BARS)
      view.bars = endT - view.start
    } else view.bars = Math.max(MIN_BARS, drag.bars0 + dt)
    settle()
  }

  const relabel = (lane, next) => onEditCode({ from: lane.labelFrom, to: lane.labelTo, insert: next })
  const addLane = () => {
    const change = newLaneCode(code, parsed ?? [])
    onEditCode(change)
    onRevealCode(change.from + change.insert.indexOf(change.label))
  }

  const zoomText = viewLabel >= 10 ? Math.round(viewLabel) : Math.round(viewLabel * 100) / 100

  return (
    <section className="playlist" aria-label="Playlist">
      <div className="playlist-head">
        <span className="playlist-title">playlist</span>
        <span className="zoom" role="group" aria-label="Zoom">
          <button className="btn zoom-btn" onClick={() => zoomTo(viewRef.current.bars * 1.5)} aria-label="Zoom out" title="Zoom out (−)">−</button>
          <span className="zoom-readout" aria-live="polite">{zoomText} bars</span>
          <button className="btn zoom-btn" onClick={() => zoomTo(viewRef.current.bars / 1.5)} aria-label="Zoom in" title="Zoom in (+)">+</button>
          {PRESETS.map((n) => (
            <button key={n} className="view" onClick={() => zoomTo(n)} title={`Show ${n} bars`}>{n}</button>
          ))}
          <button className="view" onClick={fitLoopOrSong} title="Fit the loop, or the song so far (0)">fit</button>
        </span>
        <button className={`btn follow ${follow ? 'on' : ''}`} aria-pressed={follow} onClick={() => setFollow((f) => !f)} title="Keep the playhead in view">follow</button>
        <button className="btn add-lane" onClick={addLane}>+ lane</button>
        <span className="lanes-note" role="status">
          {stale ? 'code changed · press update to hear it' : parsed === null ? 'code doesn’t parse · showing the last lanes' : ''}
        </span>
      </div>

      <div className="playlist-grid" ref={gridRef}>
        <div className="channel ruler-head" aria-hidden>
          <span className="lanes-tip">
            {rows[0]?.slot === MAIN ? <>name patterns to split lanes, e.g. <code>bass: note(…)</code></> : 'ctrl/cmd + wheel zooms · drag lanes to pan'}
          </span>
        </div>
        <canvas
          className="ruler"
          ref={rulerRef}
          tabIndex={0}
          role="slider"
          aria-label="Song position: click to jump, drag to mark a loop, arrow keys nudge"
          aria-valuemin={0}
          aria-valuenow={Math.round(transport.position() * transport.beats) / transport.beats}
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          onPointerCancel={() => { rulerDrag.current = null; endPan() }}
          onKeyDown={onRulerKey}
        />
        {rows.map((row) => (
          <div key={row.id} className={`lane ${row.silent ? 'silent' : ''}`}>
            <div className="channel">
              <span className="channel-num" aria-hidden>{String(row.index).padStart(2, '0')}</span>
              <button
                className="channel-name"
                title={`${row.source}\n\nOpen in code`}
                onClick={() => onRevealCode(row.lane ? row.lane.labelFrom : 0)}
              >{row.label}</button>
              {row.lane && (
                <span className="channel-controls">
                  <button
                    className={`led mute ${row.lane.muted ? 'on' : ''}`}
                    aria-pressed={row.lane.muted}
                    aria-label={`${row.lane.muted ? 'Unmute' : 'Mute'} ${row.label}`}
                    title="mute"
                    onClick={() => relabel(row.lane, toggledMute(row.lane))}
                  >m</button>
                  <button
                    className={`led solo ${row.lane.soloed ? 'on' : ''}`}
                    aria-pressed={row.lane.soloed}
                    aria-label={`${row.lane.soloed ? 'Unsolo' : 'Solo'} ${row.label}`}
                    title="solo"
                    onClick={() => relabel(row.lane, toggledSolo(row.lane))}
                  >s</button>
                </span>
              )}
              <span className="channel-source">{row.source}</span>
            </div>
            <canvas
              className="lane-canvas"
              ref={(el) => { if (el) canvases.current.set(row.id, el); else canvases.current.delete(row.id) }}
              role="img"
              aria-label={`${row.label} timeline${row.silent ? ', silent' : ''}`}
              onPointerDown={(e) => { if (e.button === 0 || e.button === 1) startPan(e) }}
              onPointerMove={onPanMove}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              onDoubleClick={() => onRevealCode(row.lane ? row.lane.labelFrom : 0)}
            />
          </div>
        ))}
        <div className="loop-region" ref={loopRef} hidden aria-hidden />
        <div className="playhead" ref={playheadRef} aria-hidden />
        {emptyMessage && <div className="playlist-empty">{emptyMessage}</div>}
      </div>

      <div className="overview-row">
        <div className="overview-head" aria-hidden>overview</div>
        <canvas
          className="overview"
          ref={overviewRef}
          role="img"
          aria-label="Song overview: drag the box to move the view, drag its edges to zoom"
          onPointerDown={onOverviewDown}
          onPointerMove={onOverviewMove}
          onPointerUp={() => { overviewDrag.current = null }}
          onPointerCancel={() => { overviewDrag.current = null }}
        />
      </div>
    </section>
  )
}
