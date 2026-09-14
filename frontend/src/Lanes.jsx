import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hapValue, parseLanes, pitchOf, queryWindow, soundOf, toggledMute, toggledSolo } from './lanes'

const WINDOWS = [1, 2, 4, 8]
const MAIN = '__main__'

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

/**
 * Lanes + timeline under the editor. The code stays the source of truth: lanes come
 * from its labels, the timeline is the evaluated pattern queried ahead of time, and
 * mute/solo rewrite the label in the code.
 */
export default function Lanes({ editorRef, code, pattern, lanePatterns, started, stale, onEditCode }) {
  const [cycles, setCycles] = useState(() => readLocal('strudel:lanes:cycles', 4))
  const lastGood = useRef([])
  const parsed = useMemo(() => parseLanes(code), [code])
  if (parsed) lastGood.current = parsed
  const sourceLanes = parsed ?? lastGood.current

  const canvases = useRef(new Map())
  const rulerRef = useRef(null)
  const playheadRef = useRef(null)
  const cacheRef = useRef(new WeakMap()) // pattern → { begin, cycles, haps }

  const anySolo = sourceLanes.some((l) => l.soloed)
  const rows = useMemo(() => {
    if (!sourceLanes.length) return [{ id: MAIN, slot: MAIN, label: 'main', source: '', controls: false }]
    let anon = 0
    return sourceLanes.map((l) => ({
      id: l.slot,
      slot: l.slot,
      label: l.title ?? `$${++anon}`,
      source: l.source,
      lane: l,
      controls: true,
      silent: l.muted || (anySolo && !l.soloed),
    }))
  }, [sourceLanes, anySolo])

  useEffect(() => writeLocal('strudel:lanes:cycles', cycles), [cycles])

  const draw = useCallback(() => {
    const editor = editorRef.current
    const scheduler = editor?.repl.scheduler
    const now = started && scheduler ? scheduler.now() : 0
    const begin = started ? Math.floor(now / cycles) * cycles : 0
    const end = begin + cycles

    // Query each lane's own pattern once per page of cycles, not every frame.
    const hapsFor = (pat) => {
      if (!pat) return []
      let hit = cacheRef.current.get(pat)
      if (!hit || hit.begin !== begin || hit.cycles !== cycles) {
        hit = { begin, cycles, haps: queryWindow(pat, begin, end, scheduler?.cps ?? 0.5) }
        cacheRef.current.set(pat, hit)
      }
      return hit.haps
    }

    const style = getComputedStyle(document.documentElement)
    const acid = style.getPropertyValue('--acid').trim() || '#e4ff1a'
    const paper = style.getPropertyValue('--paper').trim() || '#f2f0e6'
    const line = style.getPropertyValue('--line').trim() || '#2e2e2a'
    const muted = style.getPropertyValue('--muted').trim() || '#a3a39a'

    const fit = (canvas) => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { ctx, w: canvas.clientWidth, h: canvas.clientHeight }
    }
    const xOf = (t, w) => ((t - begin) / cycles) * w

    // ruler: cycle numbers and beat ticks
    if (rulerRef.current) {
      const { ctx, w, h } = fit(rulerRef.current)
      ctx.clearRect(0, 0, w, h)
      ctx.font = '10px "Martian Mono", ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      for (let c = begin; c < end; c++) {
        const x = xOf(c, w)
        ctx.fillStyle = muted
        ctx.fillText(String(c), x + 4, h / 2)
        ctx.fillStyle = line
        ctx.fillRect(x, 0, 1, h)
      }
    }

    for (const row of rows) {
      const canvas = canvases.current.get(row.id)
      if (!canvas) continue
      const { ctx, w, h } = fit(canvas)
      ctx.clearRect(0, 0, w, h)
      // grid: cycle lines strong, quarter lines faint
      for (let c = begin; c < end; c++) {
        for (let q = 0; q < 4; q++) {
          ctx.fillStyle = line
          ctx.globalAlpha = q === 0 ? 1 : 0.35
          ctx.fillRect(Math.floor(xOf(c + q / 4, w)), 0, 1, h)
        }
      }
      ctx.globalAlpha = 1
      const lanePattern = !pattern ? null : row.slot === MAIN ? pattern : lanePatterns?.get(row.slot)
      const events = hapsFor(lanePattern).map((hap) => ({ hap, v: hapValue(hap) }))
      if (!events.length) continue

      const pitches = events.map((e) => pitchOf(e.v)).filter((p) => p !== null)
      const pitched = pitches.length >= events.length / 2
      let rowOf, rowCount, labels = null
      if (pitched) {
        const lo = Math.floor(Math.min(...pitches)) - 1
        const hi = Math.ceil(Math.max(...pitches)) + 1
        rowCount = Math.max(hi - lo + 1, 6)
        rowOf = (v) => { const p = pitchOf(v); return p === null ? rowCount / 2 : hi - p }
      } else {
        labels = [...new Set(events.map((e) => soundOf(e.v)))].sort()
        rowCount = Math.max(labels.length, 1)
        rowOf = (v) => labels.indexOf(soundOf(v))
      }
      const pad = 4
      const rowH = (h - pad * 2) / rowCount
      for (const { hap, v } of events) {
        const b = Number(hap.whole.begin)
        const e = Number(hap.whole.end)
        const x = xOf(b, w)
        const span = xOf(e, w) - x
        // notes hold for their length; drum hits are short marks so fast hats stay legible
        const width = pitched ? Math.max(2, span - 1) : Math.max(3, Math.min(span * 0.6, span - 2))
        const y = pad + rowOf(v) * rowH
        const on = started && b <= now && now < e
        ctx.globalAlpha = started && e <= now ? 0.45 : (typeof v.gain === 'number' ? 0.55 + 0.45 * Math.min(v.gain, 1) : 1)
        ctx.fillStyle = row.silent ? muted : on ? paper : acid
        ctx.fillRect(x, y, width, Math.max(3, rowH - 1))
      }
      ctx.globalAlpha = 1
      if (labels && rowH >= 11) {
        ctx.font = '9px "Martian Mono", ui-monospace, monospace'
        ctx.textBaseline = 'middle'
        labels.forEach((label, i) => {
          const y = pad + i * rowH + rowH / 2
          ctx.fillStyle = 'rgba(0,0,0,0.75)'
          ctx.fillRect(0, y - 6, ctx.measureText(label).width + 8, 12)
          ctx.fillStyle = muted
          ctx.fillText(label, 4, y)
        })
      }
    }

    if (playheadRef.current) {
      playheadRef.current.style.setProperty('--ph', started ? (now - begin) / cycles : 0)
      playheadRef.current.hidden = !started
    }
  }, [editorRef, pattern, lanePatterns, started, cycles, rows])

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

  return (
    <section className="lanes" aria-label="Lanes">
      <div className="lanes-head">
        <span className="lanes-title">lanes</span>
        <span className="lanes-window" role="group" aria-label="Cycles shown">
          <span className="syn" aria-hidden>.window(&quot;&lt;</span>
          {WINDOWS.map((n) => (
            <button key={n} className={`view ${cycles === n ? 'on' : ''}`} aria-pressed={cycles === n} onClick={() => setCycles(n)}>{n}</button>
          ))}
          <span className="syn" aria-hidden>&gt;&quot;)</span>
        </span>
        <span className="lanes-note">
          {!pattern ? 'press play to see the timeline' : stale ? 'code changed · update to hear it' : parsed === null ? 'code doesn’t parse · showing last lanes' : ''}
        </span>
      </div>

      <div className="lanes-grid">
        <div className="lane-head ruler-head" aria-hidden>
          {rows[0]?.slot === MAIN && <span className="lanes-tip">label patterns to split lanes: <code>bass: note(…)</code></span>}
        </div>
        <canvas className="ruler" ref={rulerRef} aria-hidden />
        {rows.map((row) => (
          <div key={row.id} className={`lane ${row.silent ? 'silent' : ''}`}>
            <div className="lane-head">
              <span className="lane-name" title={row.source}>{row.label}</span>
              {row.controls && (
                <span className="lane-controls">
                  <button
                    className={`lane-btn ${row.lane.muted ? 'on' : ''}`}
                    aria-pressed={row.lane.muted}
                    aria-label={`${row.lane.muted ? 'Unmute' : 'Mute'} ${row.label}`}
                    onClick={() => relabel(row.lane, toggledMute(row.lane))}
                  >m</button>
                  <button
                    className={`lane-btn ${row.lane.soloed ? 'on' : ''}`}
                    aria-pressed={row.lane.soloed}
                    aria-label={`${row.lane.soloed ? 'Unsolo' : 'Solo'} ${row.label}`}
                    onClick={() => relabel(row.lane, toggledSolo(row.lane))}
                  >s</button>
                </span>
              )}
              <span className="lane-source">{row.source}</span>
            </div>
            <canvas
              className="lane-canvas"
              ref={(el) => { if (el) canvases.current.set(row.id, el); else canvases.current.delete(row.id) }}
              role="img"
              aria-label={`${row.label} timeline${row.silent ? ', silent' : ''}`}
            />
          </div>
        ))}
        <div className="playhead" ref={playheadRef} hidden aria-hidden />
      </div>
    </section>
  )
}
