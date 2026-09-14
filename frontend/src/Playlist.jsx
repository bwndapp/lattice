import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hapValue, newLaneCode, parseLanes, pitchOf, queryWindow, soundOf, toggledMute, toggledSolo } from './lanes'

const WINDOWS = [1, 2, 4, 8, 16]
const MAIN = '__main__'
const BEATS = 4 // beats drawn per cycle (bar)

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

/**
 * The playlist: one lane per labeled pattern, one clip per bar (cycle) where that lane
 * plays, notes drawn inside. The code stays the source of truth: lanes come from its
 * labels, clips are the evaluated patterns queried ahead of time, and every control here
 * (mute, solo, + lane) is an edit to the code.
 */
export default function Playlist({ editorRef, code, pattern, lanePatterns, started, stale, emptyMessage, onEditCode, onRevealCode }) {
  const [bars, setBars] = useState(() => readLocal('strudel:playlist:bars', 4))
  const lastGood = useRef([])
  const parsed = useMemo(() => parseLanes(code), [code])
  if (parsed) lastGood.current = parsed
  const sourceLanes = parsed ?? lastGood.current

  const canvases = useRef(new Map())
  const rulerRef = useRef(null)
  const playheadRef = useRef(null)
  const cacheRef = useRef(new WeakMap()) // pattern → { begin, bars, haps }

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

  useEffect(() => writeLocal('strudel:playlist:bars', bars), [bars])

  const draw = useCallback(() => {
    const scheduler = editorRef.current?.repl.scheduler
    const now = started && scheduler ? scheduler.now() : 0
    const begin = started ? Math.floor(now / bars) * bars : 0
    const end = begin + bars

    // Query each lane's pattern once per page of bars, not every frame.
    const hapsFor = (pat) => {
      if (!pat) return []
      let hit = cacheRef.current.get(pat)
      if (!hit || hit.begin !== begin || hit.bars !== bars) {
        hit = { begin, bars, haps: queryWindow(pat, begin, end, scheduler?.cps ?? 0.5) }
        cacheRef.current.set(pat, hit)
      }
      return hit.haps
    }

    const css = getComputedStyle(document.documentElement)
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback
    const acid = color('--acid', '#e4ff1a')
    const paper = color('--paper', '#f2f0e6')
    const line = color('--line', '#2e2e2a')
    const muted = color('--muted', '#a3a39a')

    const fit = (canvas) => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { ctx, w: canvas.clientWidth, h: canvas.clientHeight }
    }
    const xOf = (t, w) => ((t - begin) / bars) * w
    const mono = (px) => `${px}px "Martian Mono", ui-monospace, monospace`

    // ruler: bar numbers (1-based, like a DAW) and beat ticks
    if (rulerRef.current) {
      const { ctx, w, h } = fit(rulerRef.current)
      ctx.clearRect(0, 0, w, h)
      ctx.textBaseline = 'top'
      for (let c = begin; c < end; c++) {
        const x = xOf(c, w)
        ctx.fillStyle = paper
        ctx.fillRect(x, 0, 1, h)
        ctx.font = mono(11)
        ctx.fillText(String(c + 1), x + 5, 4)
        for (let b = 1; b < BEATS; b++) {
          const bx = xOf(c + b / BEATS, w)
          if (bx - x < 14 * b) continue
          ctx.fillStyle = muted
          ctx.fillRect(bx, h - 6, 1, 6)
        }
      }
    }

    for (const row of rows) {
      const canvas = canvases.current.get(row.id)
      if (!canvas) continue
      const { ctx, w, h } = fit(canvas)
      ctx.clearRect(0, 0, w, h)
      for (let c = begin; c < end; c++) {
        for (let b = 0; b < BEATS; b++) {
          ctx.fillStyle = line
          ctx.globalAlpha = b === 0 ? 1 : 0.4
          ctx.fillRect(Math.floor(xOf(c + b / BEATS, w)), 0, 1, h)
        }
      }
      ctx.globalAlpha = 1

      const lanePattern = !pattern ? null : row.slot === MAIN ? pattern : lanePatterns?.get(row.slot)
      const events = hapsFor(lanePattern).map((hap) => ({ hap, v: hapValue(hap), b: Number(hap.whole.begin), e: Number(hap.whole.end) }))
      if (!events.length) continue

      const pitches = events.map((ev) => pitchOf(ev.v)).filter((p) => p !== null)
      const pitched = pitches.length >= events.length / 2
      let rowOf, rowCount, labels = null
      if (pitched) {
        const lo = Math.floor(Math.min(...pitches)) - 1
        const hi = Math.ceil(Math.max(...pitches)) + 1
        rowCount = Math.max(hi - lo + 1, 8)
        rowOf = (v) => { const p = pitchOf(v); return p === null ? rowCount / 2 : hi - p }
      } else {
        labels = [...new Set(events.map((ev) => soundOf(ev.v)))].sort()
        rowCount = Math.max(labels.length, 1)
        rowOf = (v) => labels.indexOf(soundOf(v))
      }

      const tone = row.silent ? muted : acid
      const strip = 14
      for (let c = begin; c < end; c++) {
        const inBar = events.filter((ev) => ev.b < c + 1 && ev.e > c)
        if (!inBar.length) continue
        // the clip
        const x0 = Math.floor(xOf(c, w)) + 2
        const x1 = Math.floor(xOf(c + 1, w)) - 1
        const cw = x1 - x0
        const current = started && now >= c && now < c + 1
        ctx.fillStyle = tone
        ctx.globalAlpha = row.silent ? 0.06 : current ? 0.16 : 0.09
        ctx.fillRect(x0, 2, cw, h - 4)
        ctx.globalAlpha = row.silent ? 0.35 : 0.55
        ctx.strokeStyle = tone
        ctx.lineWidth = 1
        ctx.strokeRect(x0 + 0.5, 2.5, cw - 1, h - 5)
        // clip label strip
        ctx.globalAlpha = row.silent ? 0.35 : 1
        ctx.fillRect(x0, 2, cw, strip)
        ctx.globalAlpha = 1
        if (cw > 36) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(x0, 2, cw - 3, strip)
          ctx.clip()
          ctx.fillStyle = '#000'
          ctx.font = mono(9)
          ctx.textBaseline = 'middle'
          ctx.fillText(row.label, x0 + 4, 2 + strip / 2)
          ctx.restore()
        }
        // the notes inside it
        const top = 2 + strip + 3
        const rowH = (h - top - 5) / rowCount
        for (const ev of inBar) {
          const b = Math.max(ev.b, c)
          const e = Math.min(ev.e, c + 1)
          const x = xOf(b, w)
          const span = xOf(e, w) - x
          const width = pitched ? Math.max(2, span - 1) : Math.max(2, Math.min(span * 0.6, span - 2))
          const on = started && ev.b <= now && now < ev.e
          ctx.globalAlpha = row.silent ? 0.6 : started && ev.e <= now ? 0.5 : 1
          ctx.fillStyle = row.silent ? muted : on ? paper : acid
          ctx.fillRect(x, top + rowOf(ev.v) * rowH, width, Math.max(2, rowH - 1))
        }
        ctx.globalAlpha = 1
        if (labels && rowH >= 10 && c === begin) {
          ctx.font = mono(8)
          ctx.textBaseline = 'middle'
          labels.forEach((label, i) => {
            const y = top + i * rowH + rowH / 2
            ctx.fillStyle = 'rgba(0,0,0,0.8)'
            ctx.fillRect(x0 + 1, y - 5, ctx.measureText(label).width + 6, 10)
            ctx.fillStyle = paper
            ctx.fillText(label, x0 + 4, y)
          })
        }
      }
    }

    if (playheadRef.current) {
      playheadRef.current.style.setProperty('--ph', started ? (now - begin) / bars : 0)
      playheadRef.current.hidden = !started
    }
  }, [editorRef, pattern, lanePatterns, started, bars, rows])

  // Redraw every frame while playing; once per change while stopped.
  useEffect(() => {
    if (!started) { draw(); return }
    let frame
    const loop = () => { draw(); frame = requestAnimationFrame(loop) }
    loop()
    return () => cancelAnimationFrame(frame)
  }, [draw, started])

  useEffect(() => {
    const observer = new ResizeObserver(() => draw())
    canvases.current.forEach((c) => observer.observe(c))
    if (rulerRef.current) observer.observe(rulerRef.current)
    return () => observer.disconnect()
  }, [draw, rows])

  const relabel = (lane, next) => onEditCode({ from: lane.labelFrom, to: lane.labelTo, insert: next })
  const addLane = () => {
    const change = newLaneCode(code, parsed ?? [])
    onEditCode(change)
    onRevealCode(change.from + change.insert.indexOf(change.label))
  }

  return (
    <section className="playlist" aria-label="Playlist">
      <div className="playlist-head">
        <span className="playlist-title">playlist</span>
        <span className="lanes-window" role="group" aria-label="Bars shown">
          <span className="syn" aria-hidden>bars &lt;</span>
          {WINDOWS.map((n) => (
            <button key={n} className={`view ${bars === n ? 'on' : ''}`} aria-pressed={bars === n} onClick={() => setBars(n)}>{n}</button>
          ))}
          <span className="syn" aria-hidden>&gt;</span>
        </span>
        <button className="btn add-lane" onClick={addLane}>+ lane</button>
        <span className="lanes-note" role="status">
          {stale ? 'code changed · press update to hear it' : parsed === null ? 'code doesn’t parse · showing the last lanes' : ''}
        </span>
      </div>

      <div className="playlist-grid">
        <div className="channel ruler-head" aria-hidden>
          {rows[0]?.slot === MAIN ? <span className="lanes-tip">name patterns to split lanes, e.g. <code>bass: note(…)</code></span> : <span className="lanes-tip">{rows.length} lanes</span>}
        </div>
        <canvas className="ruler" ref={rulerRef} aria-hidden />
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
              onDoubleClick={() => onRevealCode(row.lane ? row.lane.labelFrom : 0)}
            />
          </div>
        ))}
        <div className="playhead" ref={playheadRef} hidden aria-hidden />
        {emptyMessage && <div className="playlist-empty">{emptyMessage}</div>}
      </div>
    </section>
  )
}
